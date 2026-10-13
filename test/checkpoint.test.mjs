// `P checkpoint`, and the run-record side effects of `P merge` / `P update-branch` (inFlight, the prod-before event).
// Everything runs the real CLI against the scripted gh fake of test/helpers/gate-env.mjs; what the fake "GitHub" received
// is read back from its call log (comment writes carry the body on stdin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { cli, scenario, ghEntries, PR } from './helpers/gate-env.mjs';
import { createFakeCodex } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { decodeRecord } from '../pipeline/lib/run-record.mjs';
import { parseEvent } from '../pipeline/lib/run-events.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { run as mergeRun } from '../pipeline/commands/merge.mjs';

// ---- what the fake GitHub saw ----------------------------------------------------------------------------------------

const isCommentWrite = (c) => c.argv[0] === 'api' && c.argv.includes('-X') && /issues\/(?:\d+\/comments|comments\/\d+)$/.test(c.argv.at(-3));
// Every comment write, oldest first: { method: POST|PATCH, path, body }.
const commentWrites = (fake) => fake.calls()
  .filter(isCommentWrite)
  .map((c) => ({ method: c.argv[c.argv.indexOf('-X') + 1], path: c.argv.at(-3), body: JSON.parse(c.stdin).body }));
const recordWrites = (fake) => commentWrites(fake).filter((w) => w.body.startsWith(MARKERS.summary)).map((w) => ({ ...w, record: decodeRecord(w.body).record }));
const eventWrites = (fake) => commentWrites(fake).filter((w) => w.body.startsWith('<!-- claude-pipeline:event:')).map((w) => ({ ...w, event: parseEvent(w.body) }));

// A summary comment already on the PR, written by the viewer (`me`, see ME in gate-env), through the real writer.
function existingSummary({ record, sections = '' }) {
  let body = '';
  const gh = {
    viewer: () => 'me',
    listComments: () => [],
    upsertComment: (n, marker, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; },
  };
  writeSummaryComment(gh, PR, { record, sections });
  return { id: 77, user: { login: 'me' }, body, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' };
}
const PATCH_77 = { match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' } };
const withComment = (s, comment, extra = []) => s.fake.setScript(ghEntries({ prHead: s.head, comments: [comment], extra: [PATCH_77, ...extra] }));

const checkpoint = (s, args) => cli(['checkpoint', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });
// Files the command reads live in .review/ (gitignored): an untracked file elsewhere would change the tree fingerprint.
const reviewFile = (s, name, content) => {
  s.repo.write(`.review/${name}`, content);
  return `.review/${name}`;
};
const baseRecord = (over = {}) => ({
  v: 1, repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', step: 'review', outcome: null, next: '', detail: '', head: null,
  request: '', tasks: [], verify: null, round: 0, mergeSha: null, inFlight: null, heartbeat: null, agentLogLine: null, cliVersion: null, history: [], ...over,
});

// ---- P checkpoint ----------------------------------------------------------------------------------------------------

test('checkpoint: records step, next, detail, round and a heartbeat for this host, in the summary comment', () => {
  const s = scenario();
  const r = checkpoint(s, ['--step', 'review', '--next', 'run round 2', '--detail', 'round 1 done', '--round', '1']);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.url, 'https://github.com/acme/widgets/pull/12#issuecomment-501');
  assert.deepEqual(r.json.warnings, []);
  const rec = r.json.record;
  assert.equal(rec.step, 'review');
  assert.equal(rec.next, 'run round 2');
  assert.equal(rec.detail, 'round 1 done');
  assert.equal(rec.round, 1);
  assert.equal(rec.head, s.head);
  assert.equal(rec.heartbeat.host, hostname());
  assert.equal(rec.repo, 'acme/widgets');
  assert.equal(rec.branch, 'agent/feature');
  assert.equal(rec.baseRef, 'main');
  const writes = recordWrites(s.fake);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].record, rec, 'the comment carries exactly the record the command printed');
});

test('checkpoint: an unknown step and a missing --step are usage errors; nothing is written', () => {
  const s = scenario();
  assertExit(checkpoint(s, ['--step', 'nope']), 2);
  assertExit(checkpoint(s, []), 2);
  assert.deepEqual(commentWrites(s.fake), []);
});

test('checkpoint: unpushed work (local HEAD ahead of the PR head) is refused and nothing is written', () => {
  const s = scenario();
  s.repo.write('src/app.js', 'export const a = 3;\n');
  const local = s.repo.commit('not pushed yet');
  const r = checkpoint(s, ['--step', 'review']);
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'unpushed');
  assert.equal(r.json.localHead, local);
  assert.equal(r.json.remoteHead, s.head);
  assert.deepEqual(commentWrites(s.fake), []);
});

test('checkpoint: a PR head ahead of the local HEAD is "behind"', () => {
  const s = scenario();
  s.repo.write('src/app.js', 'export const a = 3;\n');
  const newer = s.repo.commit('pushed from elsewhere');
  s.repo.git(['checkout', '-q', '--detach', s.head]);
  s.fake.setScript(ghEntries({ prHead: newer }));
  const r = checkpoint(s, ['--step', 'review']);
  assertExit(r, 1);
  assert.equal(r.json.error, 'behind');
  assert.deepEqual(commentWrites(s.fake), []);
});

test('checkpoint: histories that split are "diverged"; so is a PR head this clone has never fetched', () => {
  const s = scenario();
  s.repo.git(['checkout', '-q', '-b', 'other', 'main']);
  s.repo.write('src/other.js', 'export const b = 1;\n');
  s.repo.commit('someone else');
  const r = checkpoint(s, ['--step', 'review']);
  assertExit(r, 1);
  assert.equal(r.json.error, 'diverged');

  s.fake.setScript(ghEntries({ prHead: 'd'.repeat(40) }));
  const unknown = checkpoint(s, ['--step', 'review']);
  assertExit(unknown, 1);
  assert.equal(unknown.json.error, 'diverged');
  assert.deepEqual(commentWrites(s.fake), []);
});

test('checkpoint: GitHub unavailable is exit 3', () => {
  const s = scenario();
  s.fake.setScript([{ match: '.', code: 1, stderr: 'gh: Server Error (HTTP 502)' }]);
  assertExit(checkpoint(s, ['--step', 'review']), 3);
});

test('checkpoint: --tasks-file stores the tasks, --task-done flips one and keeps the rest (state read back from the comment)', () => {
  const s = scenario();
  const tasks = reviewFile(s, 'tasks.json', JSON.stringify([{ id: 'T1', title: 'schema', spec: 'add the table' }, { id: 'T2', title: 'ui', spec: 'add the form' }]));
  const first = checkpoint(s, ['--step', 'build', '--tasks-file', tasks]);
  assertExit(first, 0);
  assert.deepEqual(first.json.record.tasks.map((t) => [t.id, t.done]), [['T1', false], ['T2', false]]);

  withComment(s, { id: 77, user: { login: 'me' }, body: recordWrites(s.fake)[0].body, html_url: 'u' });
  const second = checkpoint(s, ['--step', 'build', '--task-done', 'T1']);
  assertExit(second, 0);
  assert.deepEqual(second.json.record.tasks.map((t) => [t.id, t.title, t.spec, t.done]), [['T1', 'schema', 'add the table', true], ['T2', 'ui', 'add the form', false]]);
  const last = recordWrites(s.fake).at(-1);
  assert.equal(last.method, 'PATCH', 'the one summary comment is edited, not duplicated');
  assert.equal(last.path.endsWith('/comments/77'), true);

  const unknown = checkpoint(s, ['--step', 'build', '--task-done', 'T9']);
  assertExit(unknown, 2);
  assert.match(unknown.json.message, /unknown task id/);
});

test('checkpoint: a malformed --tasks-file is a usage error', () => {
  const s = scenario();
  for (const content of ['{"id":1}', '[{"title":"no id"}]', 'not json']) {
    assertExit(checkpoint(s, ['--step', 'build', '--tasks-file', reviewFile(s, 'bad-tasks.json', content)]), 2, content);
  }
  assertExit(checkpoint(s, ['--step', 'build', '--tasks-file', '.review/missing.json']), 2);
  assert.deepEqual(commentWrites(s.fake), []);
});

test('checkpoint: --request-file takes up to 2 KB of text; more, or a binary file, is refused', () => {
  const s = scenario();
  const ok = checkpoint(s, ['--step', 'build', '--request-file', reviewFile(s, 'req-ok.txt', 'x'.repeat(2048))]);
  assertExit(ok, 0);
  assert.equal(ok.json.record.request.length, 2048);
  const big = checkpoint(s, ['--step', 'build', '--request-file', reviewFile(s, 'req-big.txt', 'x'.repeat(2049))]);
  assertExit(big, 2);
  assert.match(big.json.message, /2049 bytes, at most 2048/);
  assertExit(checkpoint(s, ['--step', 'build', '--request-file', reviewFile(s, 'req-bin.txt', 'abc\0def')]), 2);
  assert.equal(recordWrites(s.fake).length, 1, 'only the accepted request was written');
});

test('checkpoint --verify-report: a report for this head and tree is copied (head, tree, mode, ok, failedStep)', () => {
  const s = scenario();
  const r = checkpoint(s, ['--step', 'verify', '--verify-report']);
  assertExit(r, 0);
  assert.deepEqual(r.json.warnings, []);
  assert.equal(r.json.record.verify.head, s.head);
  assert.equal(typeof r.json.record.verify.tree, 'string');
  assert.deepEqual({ ...r.json.record.verify, head: 0, tree: 0 }, { head: 0, tree: 0, mode: 'full', ok: true, failedStep: null });
});

test('checkpoint --verify-report: a red report names the failed step', () => {
  const s = scenario({ report: (rep) => { rep.ok = false; rep.steps[3].status = 'fail'; } });
  const r = checkpoint(s, ['--step', 'verify', '--verify-report']);
  assertExit(r, 0);
  assert.equal(r.json.record.verify.ok, false);
  assert.equal(r.json.record.verify.failedStep, 'unit');
});

test('checkpoint --verify-report: a report for another head, or another tree, is ignored with a warning', () => {
  const otherHead = scenario({ report: (rep) => { rep.git.head = 'f'.repeat(40); } });
  const a = checkpoint(otherHead, ['--step', 'verify', '--verify-report']);
  assertExit(a, 0);
  assert.equal(a.json.record.verify, null);
  assert.match(a.json.warnings.join(), /--verify-report ignored.*report is for fffffff/);

  const otherTree = scenario({ report: (rep) => { rep.git.tree = '0'.repeat(64); } });
  const b = checkpoint(otherTree, ['--step', 'verify', '--verify-report']);
  assertExit(b, 0);
  assert.equal(b.json.record.verify, null);
  assert.match(b.json.warnings.join(), /different tree/);

  const dirty = scenario();
  dirty.repo.write('src/scratch.js', 'export const scratch = 1;\n'); // an untracked file moves the tree fingerprint
  const c = checkpoint(dirty, ['--step', 'verify', '--verify-report']);
  assertExit(c, 0);
  assert.equal(c.json.record.verify, null);
  assert.match(c.json.warnings.join(), /different tree/);

  const none = scenario({ report: null });
  const d = checkpoint(none, ['--step', 'verify', '--verify-report']);
  assertExit(d, 0);
  assert.match(d.json.warnings.join(), /no usable verify report/);
});

test('checkpoint: the summary sections already in the comment are kept, and the old record is updated in place', () => {
  const s = scenario();
  const sections = '## Summary\n\nBuilt the thing.\n\n## Review\n\nTwo rounds.';
  withComment(s, existingSummary({ record: baseRecord({ step: 'gate', outcome: 'blocked', round: 2, mergeSha: null, request: 'make it so' }), sections }));
  const r = checkpoint(s, ['--step', 'verify', '--next', 'rerun verify']);
  assertExit(r, 0);
  assert.equal(r.json.action, 'updated');
  const w = recordWrites(s.fake).at(-1);
  assert.equal(w.method, 'PATCH');
  assert.ok(w.body.includes('## Summary\n\nBuilt the thing.\n\n## Review\n\nTwo rounds.'), w.body);
  assert.equal(w.record.step, 'verify');
  assert.equal(w.record.outcome, null, 'a run that is going again is no longer blocked');
  assert.equal(w.record.request, 'make it so', 'fields the checkpoint does not name are kept');
  assert.equal(w.record.round, 2);
  assert.equal(w.record.history.at(-1).step, 'verify');
});

test('checkpoint: the resting steps keep the outcome', () => {
  const s = scenario();
  withComment(s, existingSummary({ record: baseRecord({ step: 'awaiting-owner-merge', outcome: 'awaiting-owner-merge' }) }));
  const r = checkpoint(s, ['--step', 'awaiting-owner-merge']);
  assertExit(r, 0);
  assert.equal(r.json.record.outcome, 'awaiting-owner-merge');
});

test('checkpoint: a run record that belongs to another PR is replaced, with a warning', () => {
  const s = scenario();
  withComment(s, existingSummary({ record: baseRecord({ pr: 99, branch: 'agent/other', request: 'someone else' }) }));
  const r = checkpoint(s, ['--step', 'review']);
  assertExit(r, 0);
  assert.match(r.json.warnings.join(), /does not belong to this PR/);
  assert.equal(r.json.record.pr, PR);
  assert.equal(r.json.record.request, '');
});

test('checkpoint: a record from a newer pipeline version is never overwritten', () => {
  const s = scenario();
  withComment(s, existingSummary({ record: baseRecord({ v: 2 }) }));
  const r = checkpoint(s, ['--step', 'review']);
  assertExit(r, 2);
  assert.match(r.json.message, /newer pipeline version/);
  assert.deepEqual(commentWrites(s.fake), []);
});

// ---- P merge: inFlight + the prod-before event -----------------------------------------------------------------------

const DEPLOYMENTS = [
  { match: 'deployments/7/statuses', stdoutJson: [{ state: 'success', environment_url: 'https://prod-7.example.test' }] },
  { match: 'deployments\\?.*environment=Production', stdoutJson: [{ id: 7, sha: 'b'.repeat(40), created_at: '2026-10-01T00:00:00Z' }] },
];
// A merge command that marks the moment it ran in the gh call log, so the order of writes can be asserted.
const MERGE_MARKER = [
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync(process.env.PIPELINE_FAKE_GH_LOG, `${JSON.stringify({ argv: ['MERGE-COMMAND'], cwd: process.cwd(), stdin: '' })}\\n`);",
  "if (process.env.FAKE_MERGE_EXIT) process.exit(Number(process.env.FAKE_MERGE_EXIT));",
  '',
].join('\n');
const mergeScenario = (o = {}) => scenario({ production: true, baseFiles: { 'scripts/fake-merge.mjs': MERGE_MARKER }, ...o, gh: { extra: DEPLOYMENTS, ...o.gh } });
const marker = (s) => s.fake.calls().findIndex((c) => c.argv[0] === 'MERGE-COMMAND');
const recordIndexes = (s, pred) => s.fake.calls()
  .map((c, i) => ({ c, i }))
  .filter(({ c }) => isCommentWrite(c) && pred(JSON.parse(c.stdin).body))
  .map(({ i }) => i);
const decoded = (body) => (body.startsWith(MARKERS.summary) ? decodeRecord(body).record : null);

test('merge: inFlight is written BEFORE the merge command and cleared after it (merged: step prod-watch + mergeSha)', () => {
  const s = mergeScenario();
  assertExit(s.gate(), 0);
  const r = s.merge();
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.warnings, undefined);
  const ran = marker(s);
  assert.ok(ran > 0, 'the merge command ran');
  const setAt = recordIndexes(s, (b) => decoded(b)?.inFlight?.kind === 'merge');
  assert.equal(setAt.length, 1);
  assert.ok(setAt[0] < ran, `inFlight written at call ${setAt[0]}, merge command at ${ran}`);
  const clearAt = recordIndexes(s, (b) => decoded(b) && decoded(b).inFlight === null);
  assert.equal(clearAt.length, 1);
  assert.ok(clearAt[0] > ran, 'cleared after the merge command');

  const writes = recordWrites(s.fake);
  const set = writes[0].record;
  assert.equal(set.step, 'merge');
  assert.equal(set.outcome, null);
  assert.equal(set.inFlight.host, hostname());
  assert.equal(set.inFlight.maxMinutes, 2 * 1 + 15, 'merge.wait_minutes is 1 in the scenario config');
  assert.equal(Number.isFinite(Date.parse(set.inFlight.startedAt)), true);
  assert.equal(set.head, s.head);
  const cleared = writes.at(-1).record;
  assert.equal(cleared.inFlight, null);
  assert.equal(cleared.step, 'prod-watch');
  assert.equal(cleared.mergeSha, 'c'.repeat(40));
});

test('merge: the prod-before event is a NEW comment, posted after inFlight and before the merge command', () => {
  const s = mergeScenario();
  withComment(s, existingSummary({ record: baseRecord({ step: 'gate', request: 'keep me' }), sections: '## Summary\n\nkept' }), DEPLOYMENTS);
  assertExit(s.gate(), 0);
  const r = s.merge();
  assertExit(r, 0);
  const events = eventWrites(s.fake);
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'POST', 'an event is never an edit');
  assert.equal(events[0].path, 'repos/acme/widgets/issues/12/comments');
  const { event } = events[0];
  assert.equal(event.kind, 'prod-before');
  assert.equal(event.dataStatus, 'ok');
  assert.deepEqual(event.data, {
    repo: 'acme/widgets', environment: 'Production', pr: PR, headBeforeMerge: s.head,
    deployment: { id: 7, sha: 'b'.repeat(40), url: 'https://prod-7.example.test' },
  });
  const at = s.fake.calls().findIndex((c) => c.stdin && c.stdin.includes('claude-pipeline:event:prod-before'));
  assert.ok(at < marker(s), 'before the merge command');
  const patches = commentWrites(s.fake).filter((w) => w.method === 'PATCH');
  assert.ok(patches.length >= 2, 'the summary comment is edited (set + clear) while the event stays its own comment');
  assert.ok(patches.every((w) => w.body.startsWith(MARKERS.summary)));
});

test('merge: no production configured => inFlight is still recorded, but there is no prod-before event', () => {
  const s = scenario({ baseFiles: { 'scripts/fake-merge.mjs': MERGE_MARKER } });
  assertExit(s.gate(), 0);
  assertExit(s.merge(), 0);
  assert.deepEqual(eventWrites(s.fake), []);
  assert.equal(recordWrites(s.fake).length, 2);
});

test('merge: a merge that does not happen clears inFlight and puts the step back to gate', () => {
  const s = mergeScenario({ gh: { mergeView: { state: 'OPEN' } } });
  assertExit(s.gate(), 0);
  const r = s.merge({ FAKE_MERGE_EXIT: '1' });
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  const writes = recordWrites(s.fake);
  assert.equal(writes[0].record.inFlight.kind, 'merge');
  const last = writes.at(-1).record;
  assert.equal(last.inFlight, null);
  assert.equal(last.step, 'gate');
  assert.equal(last.mergeSha, null);
  assert.ok(recordIndexes(s, (b) => decoded(b)?.inFlight === null)[0] > marker(s));
});

test('merge: a refusal by the last look at GitHub (after inFlight was set) clears it too, and the merge command never ran', () => {
  // The live gate reads the PR with a longer field list; only the pre-merge look asks for exactly these fields.
  const lastLook = { match: '^pr view 12 --json state,headRefOid,labels,isDraft$', stdoutJson: { state: 'OPEN', headRefOid: 'x', labels: [], isDraft: true } };
  const s = mergeScenario();
  assertExit(s.gate(), 0);
  s.fake.setScript(ghEntries({ prHead: s.head, extra: [lastLook, ...DEPLOYMENTS] }));
  const r = s.merge();
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.equal(marker(s), -1, 'the merge command never ran');
  const writes = recordWrites(s.fake);
  assert.equal(writes[0].record.inFlight.kind, 'merge');
  assert.equal(writes.at(-1).record.inFlight, null);
  assert.equal(writes.at(-1).record.step, 'gate');
});

test('merge: an exception after inFlight was set still clears it (finally), then propagates', async () => {
  const s = mergeScenario();
  assertExit(s.gate(), 0);
  // mergeTiming() reads these env keys inside the guarded section; reading the wait key throws.
  const target = { ...process.env, PIPELINE_MERGEABLE_PAUSE_MS: '1', ...s.fake.env, ...createFakeCodex().env };
  delete target.PIPELINE_MERGE_WAIT_MS;
  const env = new Proxy(target, {
    get(target, key) {
      if (key === 'PIPELINE_MERGE_WAIT_MS') throw new Error('boom while merging');
      return target[key];
    },
  });
  await assert.rejects(() => mergeRun(['--pr', String(PR)], { cwd: s.repo.dir, env }), /boom while merging/);
  const writes = recordWrites(s.fake);
  assert.equal(writes[0].record.inFlight.kind, 'merge');
  const last = writes.at(-1).record;
  assert.equal(last.inFlight, null, 'cleared although the merge attempt threw');
  assert.equal(last.step, 'gate');
  assert.equal(marker(s), -1, 'the merge command never ran');
});

test('merge: a record write that fails only warns; the merge still happens', () => {
  // Only the summary comment write fails: it is a PATCH/POST of the record, the event is a POST too, so fail by body.
  // (The comment list read fails too, so the resumed-run guard cannot be checked: the owner approves this exact head.)
  const s = mergeScenario({ gh: { extra: [{ match: 'repos/acme/widgets/issues/12/comments --paginate', code: 1, stderr: 'gh: Server Error (HTTP 502)' }, ...DEPLOYMENTS] } });
  assertExit(s.gate(), 0);
  const r = mergeWith(s, ['--owner-approved-head', s.head]);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.ok(r.json.warnings.some((w) => w.startsWith('run record not updated:')), r.json.warnings.join());
  assert.equal(eventWrites(s.fake).length, 1, 'the prod-before event was still posted');
  assert.ok(marker(s) > 0, 'the merge command ran');
});

test('merge: fails CLOSED when the prod-before event cannot be posted: pre-merge refusal, merge command never ran, inFlight cleared', () => {
  const s = mergeScenario({ gh: { extra: [{ match: '-X POST repos/acme/widgets/issues/12/comments', code: 1, stderr: 'gh: Server Error (HTTP 500)' }, ...DEPLOYMENTS] } });
  assertExit(s.gate(), 0);
  const r = s.merge();
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.error, 'pre-merge');
  assert.equal(r.json.reason, 'could not record the rollback target on the PR (prod-before event)');
  assert.deepEqual(r.json.reasons, [r.json.reason]);
  assert.equal(marker(s), -1, 'the merge command never ran');
  assert.ok(!s.fake.lines().some((l) => l.startsWith('pr merge')));
  // the record writes (also POSTs here) failed too, so they only warn; with a readable comment list the clear is attempted
  assert.ok(r.json.warnings.some((w) => w.startsWith('run record not updated:')));
});

test('merge: the prod-before failure refusal clears inFlight when the record can be written (PATCH works, the event POST fails)', () => {
  const s = mergeScenario();
  withComment(s, existingSummary({ record: baseRecord({ step: 'gate' }) }), [{ match: '-X POST repos/acme/widgets/issues/12/comments', code: 1, stderr: 'gh: Server Error (HTTP 500)' }, ...DEPLOYMENTS]);
  assertExit(s.gate(), 0);
  const r = s.merge();
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.equal(marker(s), -1);
  const writes = recordWrites(s.fake);
  assert.equal(writes[0].record.inFlight.kind, 'merge');
  assert.equal(writes.at(-1).record.inFlight, null);
  assert.equal(writes.at(-1).record.step, 'gate');
});

// ---- P update-branch: inFlight ---------------------------------------------------------------------------------------

const updateCli = (s, extra = []) => cli(['update-branch', '--pr', String(PR), ...extra], {
  dir: s.repo.dir, fake: s.fake, env: { PIPELINE_UPDATE_WAIT_MS: '0', PIPELINE_UPDATE_POLL_MS: '1' },
});

test('update-branch: inFlight (kind update-branch, 30 min) is set before the update and cleared after', () => {
  const s = scenario();
  const r = updateCli(s);
  assertExit(r, 0);
  assert.equal(r.json.warnings, undefined);
  const writes = recordWrites(s.fake);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].record.inFlight.kind, 'update-branch');
  assert.equal(writes[0].record.inFlight.maxMinutes, 30);
  assert.equal(writes[0].record.inFlight.host, hostname());
  assert.equal(writes[0].record.step, 'gate', 'a brand-new record starts at the gate');
  assert.equal(writes[1].record.inFlight, null);
});

test('update-branch: inFlight keeps an existing record\'s step and is cleared when the update fails or GitHub is unavailable', () => {
  const conflict = scenario({ gh: { behindBy: 2, update: 'conflict' } });
  conflict.fake.setScript(ghEntries({ prHead: conflict.head, behindBy: 2, update: 'conflict', comments: [existingSummary({ record: baseRecord({ step: 'review', request: 'keep me' }) })], extra: [PATCH_77] }));
  assertExit(updateCli(conflict), 1);
  const w = recordWrites(conflict.fake);
  assert.equal(w[0].record.step, 'review');
  assert.equal(w[0].record.request, 'keep me');
  assert.equal(w.at(-1).record.inFlight, null);

  const down = scenario({ gh: { behindBy: 2, update: 'forbidden' } });
  assertExit(updateCli(down), 3);
  const d = recordWrites(down.fake);
  assert.equal(d[0].record.inFlight.kind, 'update-branch');
  assert.equal(d.at(-1).record.inFlight, null, 'cleared on the exit-3 path');
});

test('update-branch: a record write that fails only warns', () => {
  const s = scenario({ gh: { extra: [{ match: '-X POST repos/acme/widgets/issues/12/comments', code: 1, stderr: 'gh: Server Error (HTTP 500)' }] } });
  const r = updateCli(s);
  assertExit(r, 0);
  assert.equal(r.json.outcome, 'up-to-date');
  assert.ok(r.json.warnings.some((w) => w.startsWith('run record not updated:')));
});

// ---- resumed runs: the record flag, and P merge's hard guard --------------------------------------------------------------

const RESUMED = { at: '2026-10-12T08:00:00.000Z', host: 'pc-2', head: 'a'.repeat(40) };
const mergeWith = (s, args = []) => cli(['merge', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });
const withRecord = (o, record, extra = {}) => {
  const s = mergeScenario(o);
  s.fake.setScript(ghEntries({ prHead: s.head, comments: [existingSummary({ record })], extra: [PATCH_77, ...DEPLOYMENTS], ...extra }));
  return s;
};

test('checkpoint --resumed: stamps record.resumed {at, host, head}; a later checkpoint without the flag keeps it', () => {
  const s = scenario();
  const r = checkpoint(s, ['--step', 'review', '--resumed']);
  assertExit(r, 0);
  assert.equal(r.json.record.resumed.host, hostname());
  assert.equal(r.json.record.resumed.head, s.head);
  assert.ok(Date.parse(r.json.record.resumed.at) <= Date.now());

  const later = scenario();
  withComment(later, existingSummary({ record: baseRecord({ resumed: RESUMED }) }));
  const l = checkpoint(later, ['--step', 'gate']);
  assertExit(l, 0);
  assert.deepEqual(l.json.record.resumed, RESUMED, 'a resumed record stays resumed');
  const plain = scenario();
  assert.equal(checkpoint(plain, ['--step', 'review']).json.record.resumed, undefined, 'a normal run never carries it');
});

test('merge: a RESUMED run record refuses to merge without --owner-approved-head (pre-merge, exit 1; nothing posted, nothing merged)', () => {
  const s = withRecord({}, baseRecord({ step: 'gate', resumed: RESUMED }));
  assertExit(s.gate(), 0);
  const r = mergeWith(s);
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.error, 'pre-merge');
  assert.equal(r.json.reason, 'resumed run: the owner must approve this exact head (pass --owner-approved-head <sha>)');
  assert.equal(marker(s), -1, 'the merge command never ran');
  assert.deepEqual(eventWrites(s.fake), [], 'no prod-before event');
  assert.deepEqual(recordWrites(s.fake), [], 'no inFlight');
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: --owner-approved-head must be the full gate head; another sha, or an abbreviation, still refuses', () => {
  const s = withRecord({}, baseRecord({ step: 'gate', resumed: RESUMED }));
  assertExit(s.gate(), 0);
  for (const sha of ['b'.repeat(40), s.head.slice(0, 7), s.head.toUpperCase()]) {
    const r = mergeWith(s, ['--owner-approved-head', sha]);
    assertExit(r, 1, sha);
    assert.equal(r.json.error, 'pre-merge');
    assert.match(r.json.reason, /^resumed run:/);
  }
  assert.equal(marker(s), -1);
});

test('merge: a resumed run merges once the owner\'s approval names exactly the gate head', () => {
  const s = withRecord({}, baseRecord({ step: 'gate', resumed: RESUMED }));
  assertExit(s.gate(), 0);
  const r = mergeWith(s, ['--owner-approved-head', s.head]);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.merged, true);
  assert.ok(marker(s) >= 0, 'the merge command ran');
});

test('merge: a record that is NOT resumed merges as before, with or without the flag', () => {
  const plain = withRecord({}, baseRecord({ step: 'gate' }));
  assertExit(plain.gate(), 0);
  assertExit(mergeWith(plain), 0);
  const flagged = withRecord({}, baseRecord({ step: 'gate' }));
  assertExit(flagged.gate(), 0);
  assertExit(mergeWith(flagged, ['--owner-approved-head', 'b'.repeat(40)]), 0);
});

test('merge: a run record that cannot be checked fails CLOSED (it may be a resumed one): pre-merge unless the owner approved this exact head', () => {
  const unreadable = () => mergeScenario({ gh: { extra: [{ match: 'repos/acme/widgets/issues/12/comments --paginate', code: 1, stderr: 'gh: Server Error (HTTP 500)' }, ...DEPLOYMENTS] } });
  const cases = [
    ['unreadable comments', unreadable, /^the run record could not be read \(.*\), so the resumed-run guard cannot be checked/],
    ['a newer record version', () => withRecord({}, baseRecord({ step: 'gate', v: 99, resumed: RESUMED })), /^the run record is unsupported, so the resumed-run guard cannot be checked/],
  ];
  for (const [name, make, reason] of cases) {
    const s = make();
    assertExit(s.gate(), 0, name);
    const r = mergeWith(s);
    assertExit(r, 1, name);
    assert.equal(r.json.error, 'pre-merge', name);
    assert.match(r.json.reason, reason, name);
    assert.match(r.json.reason, /pass --owner-approved-head <sha>\)$/, name);
    assert.equal(marker(s), -1, `${name}: the merge command never ran`);
    assert.deepEqual(eventWrites(s.fake), [], `${name}: no prod-before event`);
    assert.deepEqual(s.mergeCalls(), [], name);
    // another head still refuses
    assertExit(mergeWith(s, ['--owner-approved-head', 'b'.repeat(40)]), 1, name);
    assert.equal(marker(s), -1, name);
  }
  // the owner's approval of the exact gate head lets it through
  const s = unreadable();
  assertExit(s.gate(), 0);
  const ok = mergeWith(s, ['--owner-approved-head', s.head]);
  assertExit(ok, 0, ok.stdout);
  assert.equal(ok.json.merged, true);
});

test('merge: no run record at all (absent) is an ordinary run and merges without the flag', () => {
  const s = mergeScenario({});
  assertExit(s.gate(), 0);
  assertExit(mergeWith(s), 0);
});
