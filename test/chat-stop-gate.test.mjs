// Chat mode without needs-human (docs/plans/2026-10-20-chat-mode-no-needs-human.md, D3 + T4): the `needs-human` label is ignored, and the ONE stop reader
// (ownerStopProblems: events, PR passed explicitly, fail closed) is consulted by the gate's `labels` check, by `P merge` before it touches the branch, by the last
// look before the merge command and on every poll of the auto-merge wait. Label mode keeps today's exact strings and makes no extra gh call.
// Real CLI against the scripted gh fake (test/fixtures/fake-gh.mjs; `afterLog` entries model a world that changes between two reads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, ymlFor, ghEntries, named, assertOnlyFails, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';

const S1 = '5f3a9c2e';
const chatYml = () => `${ymlFor()}owner_approval: chat\n`;
let cid = 900;
const stopComment = (id = S1) => ({
  id: cid++, user: { login: 'me' },
  body: renderEvent('owner-stop', id, `Owner stop ${id}`, { repo: 'acme/widgets', pr: PR, id, cause: 'merge:command-failed', head: null, at: '2026-10-20T08:00:00.000Z', host: 'box', autoMergeDisarmed: true }),
});
const COMMENTS = 'issues/12/comments --paginate';
const LATE_VIEW = '^pr view 12 --json state,headRefOid,labels,isDraft'; // the last look; the live gate's own read starts `state,headRefOid,baseRefName`
const swapTo = (s, entries) => {
  const file = join(s.repo.dir, '.review', 'swap.json');
  writeFileSync(file, JSON.stringify(entries));
  return { FAKE_MERGE_SWAP: file };
};
// The scenario's world, but the comments list changes once the last look has read the PR.
const stopAppearsAtLastLook = (s, comments) => s.fake.setScript([
  { match: COMMENTS, afterLog: LATE_VIEW, ...(comments === 'fail' ? { code: 1, stderr: 'gh: Server Error (HTTP 502)' } : { stdoutJson: comments }) },
  ...ghEntries({ prHead: s.head }),
]);
const WAIT = { PIPELINE_MERGE_WAIT_MS: '5000', PIPELINE_MERGE_POLL_MS: '50' };

// ---- the label ------------------------------------------------------------------------------------------------------------------

test('chat: a leftover needs-human label does not block the gate or the merge; other blocking labels still do', () => {
  const s = scenario({ yml: chatYml(), gh: { labels: ['needs-human'] } });
  const g = s.gate();
  assertExit(g, 0);
  assert.equal(named(g.json, 'labels').detail, 'no blocking labels (needs-human ignored: owner_approval chat)');
  assertExit(s.merge(), 0);
  assert.equal(s.mergeCalls().length, 1);
  for (const label of ['awaiting-review', 'pipeline-blocked']) {
    const x = scenario({ yml: chatYml(), gh: { labels: ['needs-human', label] } });
    assertOnlyFails(x.gate(), 'labels', new RegExp(`blocking label\\(s\\): ${label}$`));
  }
});

test('label mode: needs-human blocks with today\'s exact text, and the field lists and gh calls are exactly today\'s (no autoMergeRequest, no comments read by the labels check)', () => {
  const s = scenario({ gh: { labels: ['needs-human'] } });
  const g = s.gate();
  assertOnlyFails(g, 'labels');
  assert.equal(named(g.json, 'labels').detail, 'blocking label(s): needs-human');
  const clean = scenario();
  assertExit(clean.gate(), 0);
  assert.equal(named(clean.gateFile(), 'labels').detail, 'no blocking labels');
  assertExit(clean.merge(), 0);
  const lines = clean.fake.lines();
  assert.equal(lines.some((l) => l.includes('autoMergeRequest')), false);
  assert.ok(lines.includes('pr view 12 --json state,headRefOid,baseRefName,isDraft,labels,mergeable,mergeStateStatus'), 'the gate read keeps today\'s field list');
  assert.ok(lines.includes('pr view 12 --json state,headRefOid,labels,isDraft'), 'the last look keeps today\'s field list');
  const label = scenario({ gh: { comments: [stopComment()] } });
  assertExit(label.gate(), 0);
  assertExit(label.merge(), 0);
});

test('chat: an unresolved review item still fails `review`, with no label involved', () => {
  const s = scenario({ yml: chatYml(), state: 'pending' });
  const g = s.gate();
  assertOnlyFails(g, 'review');
});

// ---- the gate's labels check ----------------------------------------------------------------------------------------------------

test('chat: an open owner stop fails `labels` with the stop id and cause; a read failure fails it too; an invalid run record does not', () => {
  const open = scenario({ yml: chatYml(), gh: { comments: [stopComment()] } });
  const g = open.gate();
  assertOnlyFails(g, 'labels', new RegExp(`owner stop ${S1} \\(merge:command-failed\\) is open \\(only the owner's reply releases it\\): say "ship resume ${PR}"`));
  const broken = scenario({ yml: chatYml(), gh: { extra: [{ match: COMMENTS, code: 1, stderr: 'gh: Server Error (HTTP 502)' }] } });
  const b = broken.gate();
  assert.equal(named(b.json, 'labels').ok, false);
  assert.match(named(b.json, 'labels').detail, /owner stops could not be read from GitHub/);
  const bad = { id: cid++, user: { login: 'me' }, body: `${MARKERS.summary}\n\n<!-- claude-pipeline:record:!!!! -->` };
  const inv = scenario({ yml: chatYml(), gh: { comments: [bad] } });
  assert.equal(named(inv.gate().json, 'labels').ok, true, 'the record is never consulted for a stop');
});

test('chat: a summary overwrite cannot clear a stop: the gate and P merge still refuse (events are the authority)', () => {
  const ok = scenario({ yml: chatYml() });
  assertExit(ok.gate(), 0); // a valid gate file for the head, from before the stop
  const record = emptyRecord({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main' });
  const summary = { id: cid++, user: { login: 'me' }, body: `${MARKERS.summary}\n\nall good\n\n${encodeRecord({ ...record, outcome: 'ready', step: 'ended' })}` };
  ok.fake.setScript([{ match: COMMENTS, stdoutJson: [stopComment(), summary] }, ...ghEntries({ prHead: ok.head })]);
  const r = ok.merge();
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, new RegExp(`owner stop ${S1}`));
  const g = ok.gate();
  assert.equal(named(g.json, 'labels').ok, false);
  assert.match(named(g.json, 'labels').detail, new RegExp(S1));
  assert.deepEqual(ok.mergeCalls(), []);
});

// ---- the last look (mirror of gate-fix-merge.test.mjs:106) ----------------------------------------------------------------------

test('chat: a stop that appears after the live gate (read at the last look) refuses before the merge command', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  stopAppearsAtLastLook(s, [stopComment()]);
  const r = s.merge();
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons.join(), new RegExp(`owner stop ${S1}`));
  assert.deepEqual(s.mergeCalls(), [], 'the merge command must not run');
  assert.ok(s.fake.lines().some((l) => l.startsWith('pr view 12 --json state,headRefOid,labels,isDraft,autoMergeRequest')), 'chat adds autoMergeRequest to the last-look read');
});

test('chat: an unreadable events list at the last look refuses (fail closed); an armed auto-merge on a stopped PR is named', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  stopAppearsAtLastLook(s, 'fail');
  const r = s.merge();
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons.join(), /owner stops could not be read/);
  assert.deepEqual(s.mergeCalls(), []);
  const armed = scenario({ yml: chatYml() });
  assertExit(armed.gate(), 0);
  armed.fake.setScript([
    { match: COMMENTS, afterLog: LATE_VIEW, stdoutJson: [stopComment()] },
    { match: `${LATE_VIEW}`, stdoutJson: { state: 'OPEN', headRefOid: armed.head, isDraft: false, labels: [], autoMergeRequest: { enabledAt: 'x' } } },
    ...ghEntries({ prHead: armed.head }),
  ]);
  const a = armed.merge();
  assertExit(a, 1);
  assert.match(a.json.reasons.join(), /auto-merge is armed on a stopped PR: gh pr merge 12 --disable-auto/);
});

test('label mode: the same late events change nothing and are never read by the last look', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  stopAppearsAtLastLook(s, [stopComment()]);
  assertExit(s.merge(), 0);
  assert.equal(s.mergeCalls().length, 1);
});

// ---- the wait (mirror of cli-gate-merge.test.mjs:323) -------------------------------------------------------------------------------

test('chat: a stop that appears while auto-merge is queued ends the wait blocked, disables auto-merge and names the stop', () => {
  const s = scenario({ yml: chatYml(), gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assertExit(s.gate(), 0);
  const swap = swapTo(s, ghEntries({ prHead: s.head, mergeView: { state: 'OPEN', mergeCommit: null }, comments: [stopComment()] }));
  const r = s.merge({ ...swap, ...WAIT });
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.match(r.json.reason, new RegExp(`a blocker appeared while waiting: .*owner stop ${S1}`));
  assert.match(r.json.reason, /auto-merge disabled/);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'));
  assert.ok(s.fake.lines().some((l) => l.startsWith('pr view 12 --json state,mergeCommit,labels,autoMergeRequest')), 'chat polls with autoMergeRequest');
});

test('chat: an events read failure in the middle of the wait is a blocker too', () => {
  const s = scenario({ yml: chatYml(), gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assertExit(s.gate(), 0);
  const swap = swapTo(s, ghEntries({ prHead: s.head, mergeView: { state: 'OPEN', mergeCommit: null }, extra: [{ match: COMMENTS, code: 1, stderr: 'gh: Server Error (HTTP 502)' }] }));
  const r = s.merge({ ...swap, ...WAIT });
  assertExit(r, 1);
  assert.match(r.json.reason, /owner stops could not be read/);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'));
});

test('chat: a leftover needs-human label that appears while waiting does not end the wait; label mode still does', () => {
  const chat = scenario({ yml: chatYml(), gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assertExit(chat.gate(), 0);
  const swapChat = swapTo(chat, ghEntries({ prHead: chat.head, mergeView: { state: 'OPEN', mergeCommit: null, labels: [{ name: 'needs-human' }] } }));
  const c = chat.merge({ ...swapChat, PIPELINE_MERGE_WAIT_MS: '300', PIPELINE_MERGE_POLL_MS: '50' });
  assertExit(c, 1);
  assert.match(c.json.reason, /not merged in time/, 'only the timeout ended it, not the label');
  const label = scenario({ gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assertExit(label.gate(), 0);
  const swapLabel = swapTo(label, ghEntries({ prHead: label.head, mergeView: { state: 'OPEN', mergeCommit: null, labels: [{ name: 'needs-human' }] } }));
  const l = label.merge({ ...swapLabel, ...WAIT });
  assertExit(l, 1);
  assert.match(l.json.reason, /blocking label\(s\): needs-human/);
});

// ---- R1-B4: a stop + release pair that lands after the merge request was read (the history, not just open stops, is compared) ----------

const releaseComment = (id) => ({
  id: cid++, user: { login: 'me' },
  body: renderEvent('owner-stop-released', id, `Owner stop ${id} released`, { repo: 'acme/widgets', pr: PR, id, at: '2026-10-20T09:00:00.000Z', host: 'box', releaseRef: { kind: 'resume', session: 'x', ts: 'x', prompt_sha256: 'x' } }),
});
const S2 = '7c1d4e90';

test('chat: a new stop AND its release appearing between the live gate and the merge command refuses (the approval was for the older history)', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  stopAppearsAtLastLook(s, [stopComment(S2), releaseComment(S2)]);
  const r = s.merge();
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons.join(), /owner stop history changed since the merge request was read/);
  assert.deepEqual(s.mergeCalls(), [], 'the merge command must not run');
});

test('chat: a new stop AND its release appearing while auto-merge is queued ends the wait blocked and disables auto-merge', () => {
  const s = scenario({ yml: chatYml(), gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assertExit(s.gate(), 0);
  const swap = swapTo(s, ghEntries({ prHead: s.head, mergeView: { state: 'OPEN', mergeCommit: null }, comments: [stopComment(S2), releaseComment(S2)] }));
  const r = s.merge({ ...swap, ...WAIT });
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.match(r.json.reason, /a blocker appeared while waiting: .*owner stop history changed/);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'));
});
