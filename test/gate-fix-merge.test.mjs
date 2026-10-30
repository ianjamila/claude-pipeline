// Gate hardening for final-gate / merge: a state change between the gate and the merge command, a PR behind its base,
// the merge commit that GitHub cannot name, and what counts as docs-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, named, assertOnlyFails, ghEntries } from './helpers/gate-env.mjs';
import { isDocsOnly, preMergeProblems } from '../pipeline/lib/finalgate.mjs';

const f = (path, extra = {}) => ({ path, oldPath: extra.status === 'A' ? null : path, newPath: path, status: 'M', binary: false, added: [{ line: 1, text: 'x' }], removed: [], ...extra });

// ---- 8. docs-only is markdown, docs/ text, LICENSE and CHANGELOG ----------------------------------------------------

test('8 isDocsOnly: .txt outside docs/ and every .mdx are code (requirements.txt, CMakeLists.txt, prompts, pages)', () => {
  for (const p of ['requirements.txt', 'CMakeLists.txt', 'src/prompts/system.txt', 'app/page.mdx', 'docs/a/b.mdx', 'robots.txt', 'packages/x/NOTES.txt']) {
    assert.equal(isDocsOnly([f(p)]), false, p);
    assert.equal(isDocsOnly([f('README.md'), f(p)]), false, `README + ${p}`);
  }
});

test('8 isDocsOnly: markdown anywhere, docs/ text of any kind, LICENSE and CHANGELOG are docs', () => {
  for (const p of ['README.md', 'packages/x/NOTES.md', 'docs/notes.txt', 'docs/guide.rst', 'docs/a/b.adoc', 'LICENSE', 'LICENSE.txt', 'CHANGELOG', 'CHANGELOG.md', 'sub/CHANGELOG.md']) {
    assert.equal(isDocsOnly([f(p)]), true, p);
  }
  assert.equal(isDocsOnly([f('docs/deploy.sh')]), false);
  assert.equal(isDocsOnly([f('docs/pipeline/x.txt')]), false, 'instruction/pipeline directories are still never docs');
  assert.equal(isDocsOnly([{ path: 'docs/app.txt', oldPath: 'src/app.js', newPath: 'docs/app.txt', status: 'R', binary: false, added: [], removed: [] }]), false);
});

test('8 ci: a requirements.txt change with a `skipping` required check does not pass', () => {
  const s = scenario({
    change: (r) => r.write('requirements.txt', 'flask==3.0.0\n'),
    gh: { ci: [{ name: 'ci', state: 'SKIPPED', bucket: 'skipping' }] },
  });
  const r = s.gate();
  assert.equal(r.code, 1, r.stdout);
  assert.match(named(r.json, 'ci').detail, /not passing/);
  assert.equal(named(r.json, 'ci').ok, false);
});

// ---- 13. behind the base ----------------------------------------------------------------------------------------------

test('13 final-gate: mergeStateStatus BEHIND is refused as behind-base (pr-open)', () => {
  const s = scenario({ gh: { mergeStateStatus: 'BEHIND' } });
  const r = s.gate();
  assertOnlyFails(r, 'pr-open', /behind-base/);
  assert.match(named(r.json, 'pr-open').detail, /update the branch/);
});

test('13 final-gate: any other mergeStateStatus does not trip behind-base', () => {
  for (const mergeStateStatus of ['CLEAN', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS', 'UNKNOWN', undefined]) {
    const s = scenario({ gh: { mergeStateStatus } });
    const r = s.gate();
    assert.equal(r.code, 0, `${mergeStateStatus}: ${r.stdout}`);
  }
});

test('13 final-gate: a base that moved past the branch (base tip is not an ancestor of head) is behind-base even if GitHub says CLEAN', () => {
  const s = scenario({ gh: { mergeStateStatus: 'CLEAN' } });
  // main moves on after the branch forked.
  s.repo.git(['checkout', '-q', 'main']);
  s.repo.write('other.txt', 'later\n');
  s.repo.commit('main moves on');
  s.repo.git(['checkout', '-q', 'agent/feature']);
  const r = s.gate();
  assert.equal(r.code, 1, r.stdout);
  assert.match(named(r.json, 'pr-open').detail, /behind-base/);
});

test('13 merge: the live re-gate refuses a PR that went BEHIND after final-gate passed, and never runs the merge command', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  s.fake.setScript(JSON.parse(JSON.stringify(
    // The same world, but GitHub now says BEHIND.
    [{ match: '^pr view 12 --json state,headRefOid', stdoutJson: { state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' } }, ...rawEntries(s)],
  )));
  const r = s.merge();
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.error, 'live-check');
  assert.match(r.json.reasons.join(), /behind-base/);
  assert.deepEqual(s.mergeCalls(), []);
});

// The scenario's own entries, for tests that re-script GitHub mid-flight.
const rawEntries = (s) => ghEntries({ prHead: s.head });

// ---- 7. nothing may change between the live gate and the merge command ----------------------------------------------

test('7 preMergeProblems: flags a moved head, a non-open or draft PR, a blocking label and an open pause/rollback issue', async () => {
  const ghFor = (view, issues = {}) => ({ prView: () => view, listIssues: ({ label }) => issues[label] ?? [] });
  const clean = { state: 'OPEN', headRefOid: 'a'.repeat(40), isDraft: false, labels: [] };
  assert.deepEqual(await preMergeProblems({ gh: ghFor(clean), pr: 12, head: 'a'.repeat(40) }), []);
  assert.match((await preMergeProblems({ gh: ghFor({ ...clean, headRefOid: 'b'.repeat(40) }), pr: 12, head: 'a'.repeat(40) })).join(), /head/);
  assert.match((await preMergeProblems({ gh: ghFor({ ...clean, state: 'CLOSED' }), pr: 12, head: 'a'.repeat(40) })).join(), /CLOSED/);
  assert.match((await preMergeProblems({ gh: ghFor({ ...clean, isDraft: true }), pr: 12, head: 'a'.repeat(40) })).join(), /draft/);
  assert.match((await preMergeProblems({ gh: ghFor({ ...clean, labels: [{ name: 'needs-human' }] }), pr: 12, head: 'a'.repeat(40) })).join(), /needs-human/);
  assert.match((await preMergeProblems({ gh: ghFor(clean, { 'pipeline-pause': [{ number: 3 }] }), pr: 12, head: 'a'.repeat(40) })).join(), /pipeline-pause/);
  assert.match((await preMergeProblems({ gh: { prView: () => { throw new Error('boom'); }, listIssues: () => [] }, pr: 12, head: 'a'.repeat(40) })).join(), /boom/);
});

// The gate evaluates with the labels clean; the label flips to needs-human only for the read taken right before the merge.
function flipAtMerge(s, patch) {
  const entries = rawEntries(s);
  const lateView = { state: 'OPEN', headRefOid: s.head, isDraft: false, labels: [], ...patch };
  s.fake.setScript([{ match: '^pr view 12 --json state,headRefOid,labels,isDraft$', stdoutJson: lateView }, ...entries]);
}

test('7 merge: a label flipped to needs-human after the live gate (before the merge command) refuses, exit 1, no merge', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  flipAtMerge(s, { labels: [{ name: 'needs-human' }] });
  const r = s.merge();
  assert.equal(r.code, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.merged, false);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons.join(), /needs-human/);
  assert.deepEqual(s.mergeCalls(), [], 'the merge command must not run');
});

test('7 merge: the PR head moving after the live gate also refuses before merging', () => {
  const moved = scenario();
  assert.equal(moved.gate().code, 0);
  flipAtMerge(moved, { headRefOid: 'd'.repeat(40) });
  const r1 = moved.merge();
  assert.equal(r1.code, 1, r1.stdout);
  assert.equal(r1.json.error, 'pre-merge');
  assert.match(r1.json.reasons.join(), /head/);
  assert.deepEqual(moved.mergeCalls(), []);

});

test('7 merge: with nothing changed the extra read does not get in the way', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  const r = s.merge();
  assert.equal(r.code, 0, r.stdout);
  assert.ok(s.fake.lines().some((l) => l === 'pr view 12 --json state,headRefOid,labels,isDraft'), 'the pre-merge read happened');
  assert.equal(s.mergeCalls().length, 1);
});

// ---- 11. MERGED but no merge SHA --------------------------------------------------------------------------------------

test('11 merge: a MERGED PR with no readable merge commit is exit 0, merged:true, mergeSha:null and a warning', () => {
  const s = scenario({ gh: { mergeView: { state: 'MERGED', mergeCommit: null } } });
  assert.equal(s.gate().code, 0);
  const r = s.merge({ PIPELINE_MERGE_POLL_MS: '10' });
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mergeSha, null);
  assert.match(r.json.warning, /merge commit/);
});
