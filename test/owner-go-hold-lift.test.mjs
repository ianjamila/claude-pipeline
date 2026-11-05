// `P merge --owner-go` lifts the needs-human hold the owner's "merge" named (plan 2026-11-05-chat-merge-protected, B and rev 4 items 1, 4, 6, 7, 8).
// The CLI tests run the real command against test/fixtures/fake-gh-hold.mjs, a stateful gh: the label, timeline and comment calls change a state file,
// so the order of the calls shows in what they leave. The unit tests at the end drive lib/hold.mjs with an in-memory gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, scenario, ymlFor, MERGE_SHA, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { holdBlock, readyLine } from '../pipeline/hooks/lib/owner-go.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { findOrphanedLift, installRestoreOnSignal, parseTimeline, readEligibleHold, withHoldLifted } from '../pipeline/lib/hold.mjs';

const fakeHold = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh-hold.mjs');
const HOLD = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z' };
const ev = (event, name, node_id, login, created_at) => ({ event, id: 1, node_id, created_at, actor: { login }, label: { name } });
const HOLD_EVENT = ev('labeled', 'needs-human', HOLD.id, HOLD.login, HOLD.at);
const HOLD_BLOCK = holdBlock(HOLD);

const goYml = () => ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}');
const yml = (mode) => `${goYml()}hard_stops:\n  paths: ['src/**']\nowner_approval: ${mode}\n`;
// A unique head per fixture: the owner's records are matched on repo, PR and head (see test/owner-go-scan-range.test.mjs).
const unique = (change = bump) => (repo) => { change(repo); repo.write('.salt', randomUUID()); };
const docsOnly = (repo) => repo.write('docs/guide.md', '# Guide 2\n');
const STILL_OPEN = { state: 'OPEN', mergeCommit: null };

// A PR held by needs-human (timeline: the one labeled event), a stateful fake gh, chat mode by default.
function world({ mode = 'chat', change = bump, state = {}, gh = {}, env = {} } = {}) {
  const s = scenario({
    yml: yml(mode), report: null, state: null, change: unique(change),
    gh: { mergeStateStatus: 'CLEAN', labels: ['needs-human'], ...gh }, env: { PIPELINE_HOLD_RETRY_MS: '1', ...env },
  });
  const file = join(s.fake.dir, 'hold-state.json');
  writeFileSync(file, JSON.stringify({ labels: ['needs-human'], timeline: [HOLD_EVENT], comments: [], clock: 100, seq: 0, hooks: [], overrides: { timeline: {} }, fail: {}, ...state }));
  s.fake.env.PIPELINE_GH = `node "${fakeHold}"`;
  s.fake.env.PIPELINE_FAKE_GH_STATE = file;
  s.st = () => JSON.parse(readFileSync(file, 'utf8'));
  s.patch = (fn) => { const cur = s.st(); fn(cur); writeFileSync(file, JSON.stringify(cur)); };
  s.go = () => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  s.dry = () => cli(['merge', '--pr', String(PR), '--dry-run', '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  s.lines = () => s.fake.lines();
  s.idx = (re) => s.lines().findIndex((l) => re.test(l));
  s.wrote = () => s.lines().filter((l) => /-X (POST|DELETE|PUT|PATCH)|^pr edit|--disable-auto/.test(l));
  return s;
}
const COMMENT = /-X POST repos\/acme\/widgets\/issues\/12\/comments/;
const DELETE = /-X DELETE repos\/acme\/widgets\/issues\/12\/labels\/needs-human$/;
const READD = /^pr edit 12 --add-label needs-human$/;

// The reply the owner answers, exactly as the dry run prints its parts (nothing retyped).
const replyOf = (step) => ['Protected areas and the hold are listed above.', step.areas, step.hold, step.line, step.ready ?? readyLine([PR])].filter(Boolean).join('\n');
const approve = (t, s) => {
  const d = s.dry();
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  ownerSays(t, 'merge', replyOf(d.json.ownerStep));
  s.patch((st) => { st.timelineReads = 0; }); // (the numbered timeline overrides count the real run's reads, not the dry run's)
  return d.json.ownerStep;
};
const refused = (r, error, pattern) => {
  assertExit(r, 1);
  assert.equal(r.json.error, error, r.stdout);
  assert.match(JSON.stringify(r.json), pattern);
};
const untouched = (s) => {
  assert.deepEqual(s.mergeCalls(), [], 'no merge command may run');
  assert.deepEqual(s.wrote(), [], `nothing may be written: ${s.wrote().join(' | ')}`);
  assert.deepEqual(s.st().labels, ['needs-human']);
};
const restored = (s, r) => {
  assert.equal(r.json.holdRestored, true, r.stdout);
  assert.match(JSON.stringify(r.json), /a restore creates a new hold: the owner must say \\"merge\\" again/);
  assert.ok(s.st().labels.includes('needs-human'), 'the label is back');
  assert.ok(s.idx(DELETE) >= 0 && s.lines().slice(s.idx(DELETE)).some((l) => READD.test(l)), 'the re-add comes after the delete');
};

// ---- dry run ------------------------------------------------------------------------------------------------------------

test('dry run, eligible hold, no record: say-merge with the Hold block, the hold on the Head line and the lift 🔀 line; both blocker paths cleared; nothing written', () => {
  const s = world();
  const d = s.dry();
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  assert.deepEqual(d.json.blockers, []);
  assert.equal(d.json.wouldMerge, true);
  const step = d.json.ownerStep;
  assert.equal(step.kind, 'say-merge');
  assert.equal(step.hold, 'Hold LE_hold1 by jamila at 2026-11-05T09:00:00Z');
  assert.deepEqual(step.holdInfo, HOLD);
  assert.match(step.line, new RegExp(`^Head ${s.head.slice(0, 12)} · items [0-9a-f]{12} · hold LE_hold1 · repo acme/widgets$`));
  assert.equal(step.ready, '🔀 Ready to merge #12 and lift its needs-human hold — say "merge"');
  assert.match(step.areas, /^Areas /, 'the Areas line still comes with a protected diff');
  assert.ok(!('parkNote' in step), 'no park comment, no park note');
  assert.deepEqual(s.wrote(), [], 'a dry run writes nothing');
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.deepEqual(s.st().comments, []);
});

test('dry run: the park note is quoted only when its last update is at or after the hold event, and is labelled as agent-written', () => {
  const note = (updated_at) => ({ id: 3, body: `${MARKERS.needsHuman}\n\nThis PR was stopped for a human decision: reason X.`, user: { login: 'me' }, created_at: '2026-11-05T07:00:00Z', updated_at });
  const fresh = world({ state: { comments: [note('2026-11-05T09:00:00Z')] } }).dry();
  assert.equal(fresh.json.ownerStep.parkNote.label, 'pipeline park note (agent-written)');
  assert.match(fresh.json.ownerStep.parkNote.text, /stopped for a human decision: reason X/);
  assert.doesNotMatch(fresh.json.ownerStep.parkNote.text, /claude-pipeline:needs-human/);
  const stale = world({ state: { comments: [note('2026-11-05T08:59:59Z')] } }).dry();
  assert.ok(!('parkNote' in stale.json.ownerStep), 'a note from before the hold says nothing about it');
  assert.equal(stale.json.ownerStep.hold, HOLD_BLOCK);
});

test('dry run: a paginated timeline (the hold on page 2) is read whole; a truncated page, a malformed event or an unavailable timeline makes the hold a plain blocker', () => {
  const page = `[{"event":"commented","id":1}]\n${JSON.stringify([HOLD_EVENT])}`;
  const two = world({ state: { overrides: { timeline: { 1: { raw: page } } } } }).dry();
  assert.equal(two.json.ownerStep.hold, HOLD_BLOCK);
  for (const bad of [{ raw: '[{"event":"labeled"' }, { events: [{ event: 'labeled', node_id: 'x', created_at: HOLD.at, label: { name: 'needs-human' } }] }, { code: 1 },
    { events: [HOLD_EVENT, ev('labeled', 'bug', 'LE_b', 'x', 'yesterday')] }]) {
    const d = world({ state: { overrides: { timeline: { 1: bad } } } }).dry();
    assertExit(d, 1);
    assert.match(JSON.stringify(d.json.blockers), /blocking label\(s\): needs-human/, JSON.stringify(bad));
    assert.ok(!('hold' in (d.json.ownerStep ?? {})), JSON.stringify(bad));
  }
});

test('dry run: an orphaned lift (lift comment, no label, PR open) is a blocker; nothing is written', () => {
  const lift = { id: 9, body: renderEvent('hold-lifted', 'pr12-x', 'hold LE_hold1 lifted', { hold: HOLD.id }), user: { login: 'me' }, created_at: '2026-11-05T09:30:00Z', updated_at: '2026-11-05T09:30:00Z' };
  const s = world({ state: { labels: [], comments: [lift], timeline: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE_1', 'me', '2026-11-05T09:31:00Z')] } });
  const d = s.dry();
  assert.ok(d.json.blockers.some((b) => b.kind === 'hold-lift-orphan'), JSON.stringify(d.json.blockers));
  assert.deepEqual(s.wrote(), []);
});

// ---- the real run: the record decides --------------------------------------------------------------------------------

test('real run, eligible hold + a record naming it: the lift comment comes BEFORE the delete, the label goes, the PR merges', async (t) => {
  const s = world();
  approve(t, s);
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.holdLifted, HOLD.id);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
  assert.ok(s.idx(COMMENT) >= 0 && s.idx(DELETE) > s.idx(COMMENT), `comment before delete: ${s.lines().join(' | ')}`);
  assert.ok(!s.lines().some((l) => READD.test(l)), 'merged: the label is not put back');
  const st = s.st();
  assert.deepEqual(st.labels, []);
  assert.equal(st.comments.length, 1);
  assert.match(st.comments[0].body, /claude-pipeline:event:hold-lifted:/);
  assert.match(st.comments[0].body, new RegExp(`hold LE_hold1 lifted on the owner's merge for head ${s.head.slice(0, 12)} items [0-9a-f]{12}`));
});

test('real run: a record without the hold (an old-style request) lifts nothing; the refusal shows the lines to present', async (t) => {
  const s = world();
  const live = s.dry().json.ownerStep;
  const items = /items ([0-9a-f]{12})/.exec(live.line)[1];
  const areaIds = live.areaIds;
  // 1. an old-style record: Areas + Head + plain 🔀, no hold
  ownerSays(t, 'merge', mergeRequest(PR, s.head, items, 'acme/widgets', areaIds));
  const r1 = s.go();
  refused(r1, 'owner-go', /hold LE_hold1/);
  assert.ok(r1.json.reason.includes(HOLD_BLOCK), r1.json.reason);
  assert.ok(r1.json.reason.includes(live.line), r1.json.reason);
  assert.ok(r1.json.reason.includes(readyLine([PR], { lift: true })), r1.json.reason);
  untouched(s);
});

test('real run: a record for another hold id, or the same id under another login, lifts nothing', async (t) => {
  for (const other of [{ ...HOLD, id: 'LE_other' }, { ...HOLD, login: 'someone' }]) {
    const s = world();
    const live = s.dry().json.ownerStep;
    const line = live.line.replace(`hold ${HOLD.id}`, `hold ${other.id}`);
    ownerSays(t, 'merge', [live.areas, holdBlock(other), line, readyLine([PR], { lift: true })].join('\n'));
    refused(s.go(), 'owner-go', /hold LE_hold1/);
    untouched(s);
  }
});

test('real run: a PR with no hold is not approved by a record that names one', async (t) => {
  const donor = world();
  const live = donor.dry().json.ownerStep;
  const s = world({ state: { labels: [], timeline: [] }, gh: { labels: [] } });
  const items = /items ([0-9a-f]{12})/.exec(live.line)[1];
  ownerSays(t, 'merge', [live.areas, HOLD_BLOCK, `Head ${s.head.slice(0, 12)} · items ${items} · hold ${HOLD.id} · repo acme/widgets`, readyLine([PR], { lift: true })].join('\n'));
  refused(s.go(), 'owner-go', /no owner \\"merge\\" is recorded/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('real run: another blocking label keeps the hold a plain blocker; nothing lifted', async () => {
  const s = world({ state: { labels: ['needs-human', 'awaiting-review'] }, gh: { labels: ['needs-human', 'awaiting-review'] } });
  const r = s.go();
  refused(r, 'live-check', /labels: blocking label\(s\): needs-human, awaiting-review/);
  assert.deepEqual(s.wrote(), []);
  assert.deepEqual(s.mergeCalls(), []);
  assert.ok(s.st().labels.includes('needs-human'));
});

test('real run, Rev-4 8: the exemption is for needs-human only: another blocking label that appears after the hold was read still stops the run (labels check, then the look before the lift)', async (t) => {
  for (const [match, error, pattern] of [['^pr view 12 --json state,headRefOid,baseRefName', 'live-check', /labels: blocking label\(s\): .*awaiting-review/], ['^pr view 12 --json state,headRefOid,labels,isDraft', 'pre-merge', /blocking label\(s\): awaiting-review/]]) {
    const s = world();
    approve(t, s);
    s.patch((st) => { st.hooks = [{ match, phase: 'before', addLabels: ['awaiting-review'] }]; }); // (after the dry run, which reads the same PR views)
    refused(s.go(), error, pattern);
    assert.equal(s.idx(COMMENT), -1, 'no lift comment');
    assert.equal(s.idx(DELETE), -1, 'no delete');
    assert.deepEqual(s.mergeCalls(), []);
    assert.ok(s.st().labels.includes('needs-human'));
  }
});

test('real run: owner_approval label (the hold is not eligible there) keeps needs-human a blocker', async () => {
  const s = world({ mode: 'label', change: docsOnly });
  refused(s.go(), 'live-check', /labels: blocking label\(s\): needs-human/);
  assert.deepEqual(s.wrote(), []);
  assert.deepEqual(s.mergeCalls(), []);
});

test('real run: an unreadable, truncated or malformed timeline makes the hold a plain blocker', async () => {
  for (const bad of [{ code: 1 }, { raw: '[{"event":"labeled"' }, { events: [{ ...HOLD_EVENT, actor: null }] }]) {
    const s = world({ state: { overrides: { timeline: { 1: bad } } } });
    refused(s.go(), 'live-check', /labels: blocking label\(s\): needs-human/);
    assert.deepEqual(s.wrote(), []);
  }
});

// ---- the real run: the checks between the record and the delete --------------------------------------------------------

test('real run, step 2: the timeline re-read shows a newer hold than the bound one => refused, nothing changed', async (t) => {
  const s = world({ state: { overrides: { timeline: { 2: { events: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE_o', 'x', '2026-11-05T09:10:00Z'), ev('labeled', 'needs-human', 'LE_newer', 'x', '2026-11-05T09:11:00Z')] } } } } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold', /no longer the newest one/);
  assert.match(r.json.reasons[0], /LE_newer/);
  untouched(s);
});

test('real run, step 3: the lift comment cannot be posted => refused, the label untouched', async (t) => {
  const s = world({ state: { fail: { comment: true } } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold', /could not post the lift comment/);
  assert.equal(s.idx(DELETE), -1, 'the label is not deleted without the comment');
  assert.deepEqual(s.mergeCalls(), []);
  assert.deepEqual(s.st().labels, ['needs-human']);
});

test('real run: the label re-applied between the check and the delete (a newer hold event) => put back, refused, not merged', async (t) => {
  const hooks = [{ match: 'api -X DELETE', phase: 'before', push: [{ event: 'unlabeled', login: 'x' }, { event: 'labeled', login: 'x', node_id: 'LE_newer' }] }];
  const s = world({ state: { hooks } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold', /a newer hold appeared \(LE_newer\)/);
  restored(s, r);
  assert.deepEqual(s.mergeCalls(), []);
});

test('real run: the post-delete timeline never shows the delete\'s own unlabeled event => 3 retries, then put back and refused', async (t) => {
  const s = world({ state: { noUnlabeled: true } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold', /does not show the removal of the label/);
  restored(s, r);
  assert.equal(s.st().timelineReads, 1 + 1 + 4, 'eligibility, step 2, then the post-delete read and 3 retries');
  assert.deepEqual(s.mergeCalls(), []);
});

test('real run: the post-delete timeline is unreadable => put back and refused', async (t) => {
  const s = world({ state: { fail: { timelineFrom: 3 } } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold', /could not be read/);
  restored(s, r);
  assert.deepEqual(s.mergeCalls(), []);
});

test('real run: a stale post-delete read that catches up within the retries still merges', async (t) => {
  const s = world({ state: { overrides: { timeline: { 3: { events: [HOLD_EVENT] } } } } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(s.st().timelineReads, 4);
  assert.equal(r.json.merged, true);
});

test('real run: the delete itself fails => refused, the label is (still) on the PR', async (t) => {
  const s = world({ state: { fail: { delete: true } } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold', /could not remove needs-human/);
  assert.equal(r.json.holdRestored, true);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.deepEqual(s.mergeCalls(), []);
});

// ---- the real run: after the delete, nothing merged => the hold comes back -------------------------------------------

test('real run: the merge command fails => put back, holdRestored, the owner must say merge again', async (t) => {
  const s = world({ gh: { mergeView: STILL_OPEN }, env: { FAKE_MERGE_EXIT: '1' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1);
  assert.match(r.json.reason, /merge command failed/);
  assert.equal(s.mergeCalls().length, 1);
  restored(s, r);
});

test('real run: not merged in time => put back', async (t) => {
  const s = world({ gh: { mergeView: STILL_OPEN }, env: { PIPELINE_MERGE_WAIT_MS: '1', PIPELINE_MERGE_POLL_MS: '1' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1);
  assert.match(r.json.reason, /not merged in time/);
  restored(s, r);
});

test('real run, Rev-4 8: a needs-human put back during the wait ends it as blocked (the wait has no exemption) and the restore is idempotent', async (t) => {
  const hooks = [{ match: '^pr view 12 --json state,mergeCommit,labels', phase: 'before', addLabels: ['needs-human'], push: [{ event: 'labeled', login: 'x', node_id: 'LE_during' }] }];
  const s = world({ gh: { mergeView: STILL_OPEN }, state: { hooks }, env: { PIPELINE_MERGE_WAIT_MS: '30000', PIPELINE_MERGE_POLL_MS: '1' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 1);
  assert.match(r.json.reason, /a blocker appeared while waiting: blocking label\(s\): needs-human/);
  assert.equal(r.json.holdRestored, true);
  assert.ok(s.st().labels.includes('needs-human'));
});

test('real run, Rev-4 8: the look after the delete has no exemption either (a needs-human back on the PR refuses before the merge command)', async (t) => {
  const hooks = [{ match: 'api -X DELETE', phase: 'after', addLabels: ['needs-human'] }];
  const s = world({ state: { hooks } });
  approve(t, s);
  const r = s.go();
  refused(r, 'pre-merge', /blocking label\(s\): needs-human/);
  assert.deepEqual(s.mergeCalls(), []);
  assert.equal(r.json.holdRestored, true);
});

test('real run: abandonMerge finds the PR MERGED after all => the label is not put back', async (t) => {
  const extra = [
    { match: '^pr view 12 --json state,mergeCommit$', stdoutJson: { state: 'MERGED', mergeCommit: { oid: MERGE_SHA } } },
    { match: '^pr view 12 --json state,mergeCommit,labels$', stdoutJson: { state: 'OPEN', mergeCommit: null, labels: [] } },
  ];
  const s = world({ gh: { extra }, env: { FAKE_MERGE_EXIT: '1' } });
  approve(t, s);
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.match(r.json.note, /merged while auto-merge was being disabled/);
  assert.ok(!s.lines().some((l) => READD.test(l)), 'merged: no re-add');
  assert.deepEqual(s.st().labels, []);
});

test('real run: the label cannot be put back => a loud refusal naming the PR (exit 1), never a merge', async (t) => {
  const s = world({ gh: { mergeView: STILL_OPEN }, env: { FAKE_MERGE_EXIT: '1' }, state: { fail: { add: true } } });
  approve(t, s);
  const r = s.go();
  refused(r, 'hold-restore', /COULD NOT put needs-human back on PR #12/);
  assert.equal(r.json.holdRestoreFailed, true);
  assert.deepEqual(s.st().labels, []);
});

// ---- recovery (Rev-4 4) ---------------------------------------------------------------------------------------------------

const orphaned = (extra = {}) => {
  const lift = { id: 9, body: renderEvent('hold-lifted', 'pr12-x', 'hold LE_hold1 lifted on the owner\'s merge', { hold: HOLD.id }), user: { login: 'me' }, created_at: '2026-11-05T09:30:00Z', updated_at: '2026-11-05T09:30:00Z', ...extra.comment };
  return { labels: [], comments: [lift], timeline: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE_1', 'me', '2026-11-05T09:31:00Z')], ...extra.state };
};

test('recovery: an orphaned lift comment (label gone, PR open, not merged) => the label goes back FIRST and this run is refused', async () => {
  const s = world({ state: orphaned() }); // (no owner record needed: the run does not get that far)
  const r = s.go();
  refused(r, 'hold-recovery', /lifted needs-human hold LE_hold1 and died/);
  assert.equal(r.json.holdRestored, true);
  assert.deepEqual(s.st().labels, ['needs-human']);
  assert.ok(!s.lines().some((l) => /^pr checks|--json state,headRefOid,labels,isDraft/.test(l)), 'refused before any check');
  assert.deepEqual(s.mergeCalls(), []);
});

test('recovery: also in the gated route', async () => {
  const s = world({ state: orphaned() });
  const r = s.merge();
  refused(r, 'hold-recovery', /label is back on the PR/);
  assert.deepEqual(s.st().labels, ['needs-human']);
});

test('recovery: nothing to recover when the PR is merged, the label is on, a newer hold exists, or someone else wrote the comment', async () => {
  const cases = [
    orphaned({ state: { prState: 'MERGED' } }),
    orphaned({ state: { labels: ['needs-human'] } }),
    orphaned({ state: { timeline: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE_1', 'me', '2026-11-05T09:31:00Z'), ev('labeled', 'needs-human', 'LE_new', 'me', '2026-11-05T09:40:00Z')] } }),
    orphaned({ comment: { user: { login: 'stranger' } } }),
    orphaned({ comment: { created_at: '2026-11-05T08:00:00Z' } }),
  ];
  for (const [i, state] of cases.entries()) {
    const s = world({ state });
    const r = s.merge(); // gated route, no gate file: refused for that reason, not by the recovery
    assert.equal(r.json.error, 'gate', `case ${i}: ${r.stdout}`);
    assert.ok(!s.lines().some((l) => READD.test(l)), `case ${i}: no re-add`);
  }
});

// ---- unit: lib/hold.mjs ------------------------------------------------------------------------------------------------

// An in-memory gh: the pieces lib/hold.mjs uses.
function memGh({ labels = ['needs-human'], timeline = [HOLD_EVENT], comments = [], prState = 'OPEN', failAdd = false } = {}) {
  const m = { labels: [...labels], timeline: [...timeline], comments, calls: [], prState };
  return Object.assign(m, {
    timelineOf: () => m.timeline,
    prView: (pr, fields) => { m.calls.push(`prView ${fields.join(',')}`); return { state: m.prState, headRefOid: 'h', labels: m.labels.map((name) => ({ name })) }; },
    addLabels: (pr, names) => { m.calls.push(`add ${names}`); if (failAdd) throw new Error('boom 502'); for (const n of names) if (!m.labels.includes(n)) m.labels.push(n); },
    deleteLabel: (pr, name) => { m.calls.push(`delete ${name}`); m.labels = m.labels.filter((l) => l !== name); m.timeline.push(ev('unlabeled', name, 'UE_own', 'me', '2026-11-05T10:00:00Z')); },
    createComment: (pr, body) => { m.calls.push('comment'); m.comments.push({ body, user: { login: 'me' } }); return { id: 1 }; },
    listComments: () => m.comments,
    viewer: () => 'me',
  });
}
const refuseFn = (error, reasons, extra = {}) => ({ exitCode: 1, output: { ok: false, error, reasons, ...extra } });
const lift = (gh, over = {}) => withHoldLifted({ gh, pr: PR, hold: HOLD, head: 'a'.repeat(40), items: 'none', repo: 'acme/widgets', env: { PIPELINE_HOLD_RETRY_MS: '1' }, proc: new EventEmitter(), refuse: refuseFn, check: async () => [], merge: async () => ({ exitCode: 0, output: { ok: true, merged: true } }), ...over });

test('withHoldLifted: an exception after the delete puts the label back and still throws', async () => {
  const gh = memGh();
  await assert.rejects(lift(gh, { merge: async () => { throw new Error('kaboom'); } }), (err) => /kaboom/.test(err.message) && /needs-human was put back on #12/.test(err.message) && err.holdRestored === true);
  assert.ok(gh.labels.includes('needs-human'));
  assert.ok(gh.calls.indexOf('comment') < gh.calls.indexOf('delete needs-human'));
});

test('withHoldLifted: an exception after the delete AND a failed re-add is a loud refusal naming the PR', async () => {
  const gh = memGh({ failAdd: true });
  const r = await lift(gh, { merge: async () => { throw new Error('kaboom'); } });
  assert.equal(r.output.error, 'hold-restore');
  assert.match(r.output.reasons[0], /COULD NOT put needs-human back on PR #12.*kaboom/);
});

test('withHoldLifted: the signal handlers are installed while the label is off and gone afterwards; merged => no restore', async () => {
  const proc = new EventEmitter();
  const gh = memGh();
  let during = -1;
  const r = await lift(gh, { proc, merge: async () => { during = proc.listenerCount('SIGTERM') + proc.listenerCount('SIGINT') + proc.listenerCount('SIGHUP'); return { exitCode: 0, output: { ok: true, merged: true } }; } });
  assert.equal(during, 3);
  assert.equal(r.output.merged, true);
  assert.equal(proc.listenerCount('SIGTERM') + proc.listenerCount('SIGINT') + proc.listenerCount('SIGHUP'), 0);
  assert.ok(!gh.calls.some((c) => c.startsWith('add')), 'merged: nothing put back');
});

test('installRestoreOnSignal: SIGTERM / SIGINT / SIGHUP restore the label and exit non-zero; the remover takes the handlers away', () => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const proc = new EventEmitter();
    const seen = [];
    const remove = installRestoreOnSignal({ restore: () => seen.push('restore'), proc, exit: (c) => seen.push(`exit ${c}`), write: () => {} });
    proc.emit(signal);
    assert.deepEqual(seen, ['restore', `exit ${code}`]);
    remove();
    assert.equal(proc.listenerCount(signal), 0);
  }
  const proc = new EventEmitter();
  const seen = [];
  installRestoreOnSignal({ restore: () => { throw new Error('gh down'); }, proc, exit: (c) => seen.push(`exit ${c}`), write: (m) => seen.push(m) });
  proc.emit('SIGTERM');
  assert.match(seen[0], /COULD NOT put the needs-human hold back/);
  assert.equal(seen[1], 'exit 143');
});

test('readEligibleHold: case-insensitive label, newest labeled event wins, only chat mode', async () => {
  const older = ev('labeled', 'needs-human', 'LE_old', 'a', '2026-11-05T08:00:00Z');
  const gh = memGh({ labels: ['Needs-Human'], timeline: [older, ev('unlabeled', 'Needs-Human', 'UE_x', 'a', '2026-11-05T08:30:00Z'), HOLD_EVENT, ev('labeled', 'bug', 'LE_bug', 'b', '2026-11-05T09:30:00Z')] });
  assert.deepEqual((await readEligibleHold({ gh, pr: PR, config: { owner_approval: 'chat' } })).hold, HOLD);
  assert.equal((await readEligibleHold({ gh, pr: PR, config: { owner_approval: 'label' } })).hold, null);
  assert.equal(gh.calls.length, 1, 'label mode reads nothing');
});

test('readEligibleHold: nothing liftable for a timeline out of order, a label the timeline does not show applied, a malformed event of ANY label, or a hold with no showable block', async () => {
  const chat = { owner_approval: 'chat' };
  const eligible = async (gh) => (await readEligibleHold({ gh, pr: PR, config: chat })).hold;
  assert.deepEqual(await eligible(memGh()), HOLD);
  assert.equal(await eligible(memGh({ timeline: [HOLD_EVENT, ev('labeled', 'needs-human', 'LE_older', 'a', '2026-11-05T08:00:00Z')] })), null, 'last in order is not the latest in time');
  assert.equal(await eligible(memGh({ timeline: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE', 'a', '2026-11-05T09:30:00Z')] })), null, 'the timeline says the label is off');
  assert.equal(await eligible(memGh({ timeline: [] })), null);
  assert.equal(await eligible(memGh({ labels: [] })), null);
  assert.equal(await eligible(memGh({ labels: ['needs-human', 'pipeline-blocked'] })), null);
  assert.equal(await eligible(memGh({ timeline: [HOLD_EVENT, { ...ev('labeled', 'bug', 'LE_b', 'a', HOLD.at), node_id: '' }] })), null);
  assert.equal(await eligible(memGh({ timeline: [HOLD_EVENT, { ...ev('labeled', 'bug', 'LE_b', 'a', HOLD.at), label: { name: 7 } }] })), null);
  assert.equal(await eligible(memGh({ timeline: [HOLD_EVENT, { ...ev('labeled', 'bug', 'LE_b', 'a', HOLD.at), created_at: '2026-11-05T09:30:00.000Z' }] })), null);
  assert.equal(await eligible(memGh({ timeline: [{ ...HOLD_EVENT, node_id: 'has space' }] })), null);
  assert.equal(await eligible(Object.assign(memGh(), { timelineOf: () => { throw new Error('502'); } })), null);
  assert.equal(parseTimeline({}).ok, false);
  assert.equal(parseTimeline([null]).ok, false);
  assert.equal(parseTimeline([{ event: 'commented', body: 'x' }, HOLD_EVENT]).events.length, 1);
});

test('findOrphanedLift: a comment that is not ours, malformed or without data finds nothing; an unreadable timeline is unverified', () => {
  const lift = (over = {}) => ({ body: renderEvent('hold-lifted', 'pr12-x', 's', { hold: HOLD.id }), user: { login: 'me' }, created_at: '2026-11-05T09:30:00Z', ...over });
  const gone = { labels: [], timeline: [HOLD_EVENT, ev('unlabeled', 'needs-human', 'UE', 'me', '2026-11-05T09:31:00Z')] };
  assert.deepEqual(findOrphanedLift({ gh: memGh({ ...gone, comments: [lift()] }), pr: PR }).orphan, { hold: HOLD.id });
  assert.equal(findOrphanedLift({ gh: memGh({ ...gone, comments: [lift({ body: 'hold lifted' })] }), pr: PR }).orphan, null);
  assert.equal(findOrphanedLift({ gh: memGh({ ...gone, comments: [lift({ body: renderEvent('hold-lifted', 'x', 's', null) })] }), pr: PR }).orphan, null);
  const broken = Object.assign(memGh({ ...gone, comments: [lift()] }), { timelineOf: () => { throw new Error('502'); } });
  assert.match(findOrphanedLift({ gh: broken, pr: PR }).unverified, /timeline could not be read/);
  assert.match(findOrphanedLift({ gh: Object.assign(memGh(), { listComments: () => { throw new Error('502'); } }), pr: PR }).unverified, /comments could not be read/);
});
