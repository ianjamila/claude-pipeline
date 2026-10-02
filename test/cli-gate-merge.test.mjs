// merge: the gate file must vouch for this head and patch, the live PR must still be clean, and only an observed MERGED counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, scenario, ghEntries, PR, MERGE_SHA } from './helpers/gate-env.mjs';

// ---- merge ----------------------------------------------------------------------------------------

test('merge: refuses when there is no final-gate.json', () => {
  const s = scenario();
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.message, 'run final-gate again');
  assert.match(r.json.reasons.join(), /no final-gate\.json/);
  assert.deepEqual(s.mergeCalls(), [], 'the merge command never ran');
});

test('merge: refuses a failed gate, another PR\'s gate, a stale gate and a gate for another head or patch', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  const attempt = (label, edit, expected) => {
    s.editGate(edit);
    const r = s.merge();
    assert.equal(r.code, 1, label);
    assert.equal(r.json.merged, false, label);
    assert.equal(r.json.error, 'gate', label);
    assert.match(r.json.reasons.join(), expected, label);
    assert.deepEqual(s.mergeCalls(), [], `${label}: merge command must not run`);
    assert.equal(s.gate().code, 0);
  };
  attempt('not ok', (g) => { g.ok = false; }, /did not pass/);
  attempt('a failing check', (g) => { g.checks[0].ok = false; }, /failing or missing/);
  attempt('other PR', (g) => { g.pr = 13; }, /#13/);
  attempt('stale', (g) => { g.at = new Date(Date.now() - 31 * 60_000).toISOString(); }, /minutes old/);
  attempt('other head', (g) => { g.head = 'a'.repeat(40); }, /worktree is at/);
  attempt('other patch', (g) => { g.contentHash = 'f'.repeat(64); }, /content hash differs/);
  attempt('other repo', (g) => { g.repo = 'someone/else'; }, /someone\/else/);
});

test('merge: a gate that is 29 minutes old is still fresh', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.editGate((g) => { g.at = new Date(Date.now() - 29 * 60_000).toISOString(); });
  const r = s.merge();
  assert.equal(r.code, 0, r.stdout);
});

test('merge: a commit made after the gate (new head, new patch) is refused even if the PR head follows it', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.repo.write('src/app.js', 'export const a = 4;\n');
  const newHead = s.repo.commit('after the gate');
  s.fake.setScript(ghEntries({ prHead: newHead }));
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.match(r.json.reasons.join(), /worktree is at/);
  assert.match(r.json.reasons.join(), /content hash differs/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: the PR head moving after the gate is refused', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.fake.setScript(ghEntries({ prHead: 'd'.repeat(40) }));
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.match(r.json.reasons.join(), /PR head is/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: a blocking label that appeared after the gate is refused by the live re-check', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.fake.setScript(ghEntries({ prHead: s.head, labels: ['needs-human'] }));
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.equal(r.json.error, 'live-check');
  assert.match(r.json.reasons.join(), /blocking label\(s\): needs-human/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: a pause issue opened after the gate is refused by the live preflight', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.fake.setScript(ghEntries({ prHead: s.head, pause: [{ number: 5, title: 'pause', url: 'u' }] }));
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.match(r.json.reasons.join(), /preflight.*pipeline-pause issue #5/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: a rollback issue opened after the gate is refused by the live preflight', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.fake.setScript(ghEntries({ prHead: s.head, rollback: [{ number: 6, title: 'rollback', url: 'u' }] }));
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.match(r.json.reasons.join(), /preflight.*pipeline-rollback issue #6/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: a PR that was closed or turned into a draft after the gate is refused', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.fake.setScript(ghEntries({ prHead: s.head, state: 'CLOSED' }));
  assert.match(s.merge().json.reasons.join(), /PR state is CLOSED/);
  s.fake.setScript(ghEntries({ prHead: s.head, isDraft: true }));
  assert.match(s.merge().json.reasons.join(), /draft/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('merge: runs the configured command with the approved pr and head, then exits 0 once MERGED', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  const r = s.merge();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.deepEqual(r.json, { ok: true, merged: true, mergeSha: MERGE_SHA, prodBefore: null });
  assert.deepEqual(s.mergeCalls(), [`${PR} ${s.head}`]);
  assert.equal(existsSync(join(s.repo.dir, '.review', 'prod-before.json')), false, 'no production configured, nothing to record');
  assert.ok(!s.fake.lines().some((l) => l.includes('--disable-auto')));
});

test('merge: a merge command that exits non-zero (the gate refused) fails with its output, auto-merge left disarmed', () => {
  const s = scenario({ gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assert.equal(s.gate().code, 0);
  const r = s.merge({ FAKE_MERGE_EXIT: '1' });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.commandExitCode, 1);
  assert.match(r.json.commandOutput, /merge gate refused: base moved/);
  assert.match(r.json.reason, /merge command failed \(exit 1\)/);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'));
});

test('merge: a merge command that exits non-zero but left the PR MERGED still counts as merged (post-merge branch-delete errors)', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  const r = s.merge({ FAKE_MERGE_EXIT: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.json.mergeSha, MERGE_SHA);
  assert.equal(r.json.commandExitCode, 1);
});

test('merge: still OPEN after the wait disables auto-merge and fails with the exact reason', () => {
  const s = scenario({ gh: { mergeView: { state: 'OPEN', mergeCommit: null } } });
  assert.equal(s.gate().code, 0);
  const r = s.merge({ PIPELINE_MERGE_WAIT_MS: '300', PIPELINE_MERGE_POLL_MS: '50' });
  assert.equal(r.code, 1);
  assert.deepEqual([r.json.ok, r.json.merged, r.json.reason, r.json.autoMergeDisabled], [false, false, 'not merged in time — auto-merge disabled', true]);
  assert.ok('commandOutput' in r.json);
  assert.ok(s.fake.lines().includes('pr merge 12 --disable-auto'));
  const polls = s.fake.lines().filter((l) => l.startsWith('pr view 12 --json state,mergeCommit'));
  assert.ok(polls.length >= 2, `polled more than once (${polls.length})`);
});

test('merge: if --disable-auto itself fails the output says so instead of claiming it is disabled', () => {
  const s = scenario({ gh: { mergeView: { state: 'OPEN', mergeCommit: null }, disableAutoCode: 1 } });
  assert.equal(s.gate().code, 0);
  const r = s.merge({ PIPELINE_MERGE_WAIT_MS: '100', PIPELINE_MERGE_POLL_MS: '50' });
  assert.equal(r.code, 1);
  assert.equal(r.json.autoMergeDisabled, false);
  assert.match(r.json.reason, /could not confirm auto-merge is disabled/);
});

test('merge: a PR closed without merging while waiting fails', () => {
  const s = scenario({ gh: { mergeView: { state: 'CLOSED', mergeCommit: null } } });
  assert.equal(s.gate().code, 0);
  const r = s.merge();
  assert.equal(r.code, 1);
  assert.match(r.json.reason, /closed without merging/);
});

test('merge: with production configured the known-good deployment is recorded BEFORE the merge command runs', () => {
  const deployments = [
    { match: 'deployments/7/statuses', stdoutJson: [{ state: 'success', environment_url: 'https://prod-7.example.test' }] },
    { match: 'deployments\\?.*environment=Production', stdoutJson: [{ id: 7, sha: 'b'.repeat(40), created_at: '2026-10-01T00:00:00Z' }] },
  ];
  const s = scenario({ production: true, gh: { extra: deployments } });
  assert.equal(s.gate().code, 0);
  const r = s.merge();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const rec = JSON.parse(readFileSync(join(s.repo.dir, '.review', 'prod-before.json'), 'utf8'));
  assert.equal(rec.id, 7);
  assert.equal(rec.sha, 'b'.repeat(40));
  assert.equal(rec.url, 'https://prod-7.example.test');
  assert.equal(rec.environment, 'Production');
  assert.deepEqual(r.json.prodBefore, { id: 7, sha: 'b'.repeat(40), url: 'https://prod-7.example.test' });
  const lines = s.fake.lines();
  const lookedUp = lines.findIndex((l) => /deployments\?/.test(l));
  assert.ok(lookedUp >= 0, 'deployments were queried');
  assert.ok(Date.parse(rec.at) <= Date.now());
});

test('merge: production with no successful deployment yet records nulls; an unreachable deployments API refuses the merge', () => {
  const none = scenario({ production: true, gh: { extra: [{ match: 'deployments\\?', stdoutJson: [] }] } });
  assert.equal(none.gate().code, 0);
  const ok = none.merge();
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(none.repo.dir, '.review', 'prod-before.json'), 'utf8')).id, null);

  const down = scenario({ production: true, gh: { extra: [{ match: 'deployments\\?', code: 1, stderr: 'HTTP 500' }] } });
  assert.equal(down.gate().code, 0);
  const r = down.merge();
  assert.equal(r.code, 3, 'without the rollback target the merge must not proceed');
  assert.deepEqual(down.mergeCalls(), []);
});

