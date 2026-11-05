// `P merge --owner-go` scans an explicit, immutable range: merge-base(GitHub's baseRefOid, HEAD)..HEAD, never a local ref the agent could
// move (plan 2026-11-05-chat-merge-protected A.1, A.4, rev 4 item 3). Every case here is a way the scan could be emptied or made stale:
// a misleading origin/main, a base commit that is not here, a replace ref / graft / shallow history hiding a file, a file list that
// disagrees with GitHub's, and a base or head that moved between the scan and the merge command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, ghEntries, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { evaluateOwnerGo, ownerGoBaseProblem, preMergeProblems } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { ownerItemsDigest } from '../pipeline/hooks/lib/owner-go.mjs';

const goYml = () => ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}');
const protectedYml = (mode = 'chat') => `${goYml()}hard_stops:\n  paths: ['src/**']\nowner_approval: ${mode}\n`;
// Every fixture gets its own head: the owner's records are matched on repo, PR and head, and identical fixtures made in the same second would
// share a head with the records other test files write (see test/helpers/owner-go.mjs), so a record here could approve a merge there.
const unique = (change = bump) => (repo) => { change(repo); repo.write('.salt', randomUUID()); };
// A protected PR (src/** is a hard-stop path, owner_approval: chat) without the review evidence --owner-go never needs.
const protectedScenario = (opts = {}) => scenario({ yml: protectedYml(), report: null, state: null, ...opts, change: unique(opts.change) });
const plainScenario = (opts = {}) => scenario({ yml: goYml(), report: null, state: null, ...opts, change: unique(opts.change) });
const goMerge = (s) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
const refusedWith = (r, pattern, s) => {
  assertExit(r, 1);
  assert.match(JSON.stringify(r.json), pattern);
  assert.deepEqual(s.mergeCalls(), [], 'no merge command may run');
};
// The owner's record names `items none` (the only item set --owner-go is bound to in this task): a pass never comes from the record.
const withRecord = (t, s) => ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
// The fake gh script for s with some of GitHub's answers changed (the scenario's own is built before the repo is touched).
const script = (s, o = {}) => ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, ...o });

// ---- A.1: the range comes from GitHub, not from local refs --------------------------------------------------------------------------

test('--owner-go: a local origin/main moved onto the PR head does not empty the scan (items come from baseRefOid)', (t) => {
  const s = protectedScenario();
  s.repo.git(['update-ref', 'refs/remotes/origin/main', s.head]); // the diff against it is empty
  // a record for `items none` (what an emptied scan would have produced) cannot cover it: the refusal names the LIVE digest, found from baseRefOid
  withRecord(t, s);
  const r = goMerge(s);
  refusedWith(r, /items [0-9a-f]{12}/, s);
  assert.doesNotMatch(JSON.stringify(r.json), /items none/);
  assert.equal(r.json.error, 'owner-go');
});

test('--owner-go: GitHub\'s base commit not present locally refuses and says to fetch the base branch', (t) => {
  const s = protectedScenario({ gh: { baseOid: 'd'.repeat(40) } });
  withRecord(t, s);
  const r = goMerge(s);
  refusedWith(r, /git fetch origin main/, s);
  assert.doesNotMatch(JSON.stringify(r.json), /\d+ owner item/, 'it never fell back to a local ref and scanned');
  assert.match(r.json.reasons.join('\n'), /^scan-range: /m, 'scan-range is one of the failed checks');
});

test('--owner-go: GitHub naming no usable base commit refuses (fail closed)', (t) => {
  for (const baseOid of [undefined, 'main', 'nothex']) {
    const s = plainScenario({ gh: { baseOid } });
    withRecord(t, s);
    refusedWith(goMerge(s), /base commit/, s);
  }
});

test('--owner-go: a clean unprotected PR still merges (the scan range is the PR\'s own diff)', (t) => {
  const s = plainScenario();
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
});

test('--owner-go: GitHub\'s base is the authority for "behind", not a stale local origin/main', (t) => {
  const s = plainScenario();
  // main moved on after the branch forked, and the local origin/main was never fetched (it still says the old tip)
  s.repo.git(['checkout', '-q', 'main']);
  s.repo.write('other.txt', 'x\n');
  const newTip = s.repo.commit('main moves');
  s.repo.git(['checkout', '-q', 'agent/feature']);
  s.repo.git(['update-ref', 'refs/remotes/origin/main', s.baseTip]);
  s.fake.setScript(script(s, { baseOid: newTip, mergeStateStatus: 'CLEAN' }));
  withRecord(t, s);
  refusedWith(goMerge(s), /behind-base/, s);
});

// ---- rev 4 item 3: the object graph ---------------------------------------------------------------------------------------------------

test('--owner-go: a replace ref that hides a hard-stop file is refused', (t) => {
  const s = protectedScenario();
  // a commit with the base's tree on top of the base, swapped in for the real head: plain git would show a head that changes nothing
  s.repo.git(['checkout', '-q', '-b', 'decoy', s.baseTip]);
  const decoy = s.repo.commit('decoy', { allowEmpty: true });
  s.repo.git(['checkout', '-q', 'agent/feature']);
  s.repo.git(['replace', s.head, decoy]);
  withRecord(t, s);
  refusedWith(goMerge(s), /replace/, s);
});

test('--owner-go: a graft file is refused', (t) => {
  const s = plainScenario();
  writeFileSync(join(s.repo.dir, '.git', 'info', 'grafts'), `${s.head} ${s.baseTip}\n`);
  withRecord(t, s);
  refusedWith(goMerge(s), /graft/, s);
});

test('--owner-go: a shallow repository is refused', (t) => {
  const s = plainScenario();
  writeFileSync(join(s.repo.dir, '.git', 'shallow'), `${s.baseTip}\n`);
  withRecord(t, s);
  refusedWith(goMerge(s), /shallow/, s);
});

test('--owner-go: files GitHub lists for the PR that the local diff lacks (also a rename\'s old name) are refused, naming at most 3', (t) => {
  const s = plainScenario();
  const files = [
    ...s.prFiles, { filename: 'src/hidden.js', status: 'added' }, { filename: 'new/name.js', previous_filename: 'old/name.js', status: 'renamed' },
    { filename: 'x1.js', status: 'added' }, { filename: 'x2.js', status: 'added' },
  ];
  s.fake.setScript(script(s, { prFiles: files }));
  withRecord(t, s);
  const r = goMerge(s);
  refusedWith(r, /src\/hidden\.js/, s);
  assert.match(JSON.stringify(r.json), /old\/name\.js/);
  assert.doesNotMatch(JSON.stringify(r.json), /x2\.js/, 'only the first 3 are named');
  assert.match(JSON.stringify(r.json), /pulls\/files|GitHub lists/);
});

test('--owner-go: the GitHub files list unreadable (HTTP 502, or not a list) is refused (fail closed)', (t) => {
  for (const entry of [{ match: 'repos/acme/widgets/pulls/12/files', code: 1, stderr: 'gh: Server Error (HTTP 502)' }, { match: 'repos/acme/widgets/pulls/12/files', stdoutJson: [{ nofilename: 1 }] }]) {
    const s = plainScenario();
    s.fake.setScript(script(s, { extra: [entry] }));
    withRecord(t, s);
    refusedWith(goMerge(s), /files/, s);
  }
});

test('--owner-go: an EMPTY GitHub files list for a non-empty local diff is refused (the cross-check runs both ways)', (t) => {
  const s = plainScenario();
  assert.ok(s.prFiles.length > 0);
  s.fake.setScript(script(s, { prFiles: [] }));
  withRecord(t, s);
  const r = goMerge(s);
  refusedWith(r, /local diff has 2 file\(s\) that GitHub does not list/, s);
  assert.match(JSON.stringify(r.json), /\.salt, src\/app\.js/);
});

test('--owner-go: a GitHub files list that lacks one local file is refused, naming it; a lacking rename side counts too', (t) => {
  const s = plainScenario({ change: (repo) => { repo.write('src/extra.js', 'x\n'); repo.git(['mv', 'src/app.js', 'src/renamed.js']); } });
  const names = s.prFiles.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
  assert.ok(names.includes('src/extra.js') && names.includes('src/app.js'), names.join());
  // GitHub forgets the added file
  s.fake.setScript(script(s, { prFiles: s.prFiles.filter((f) => f.filename !== 'src/extra.js') }));
  withRecord(t, s);
  refusedWith(goMerge(s), /does not list[^"]*src\/extra\.js/, s);
  // GitHub lists the rename without its old name
  const t2 = plainScenario({ change: (repo) => { repo.git(['mv', 'src/app.js', 'src/renamed.js']); } });
  t2.fake.setScript(script(t2, { prFiles: t2.prFiles.map(({ previous_filename: _old, ...f }) => f) }));
  withRecord(t, t2);
  refusedWith(goMerge(t2), /does not list[^"]*src\/app\.js/, t2);
});

test('--owner-go: a GitHub files list at its 3000-file cap is refused ("too many files to cross-check"), not compared truncated', (t) => {
  const s = plainScenario();
  const filler = Array.from({ length: 3000 }, (_, i) => ({ filename: `gen/f${i}.js`, status: 'added' }));
  s.fake.setScript(script(s, { prFiles: [...s.prFiles, ...filler] }));
  withRecord(t, s);
  refusedWith(goMerge(s), /too many files to cross-check/, s);
});

test('--owner-go: a non-ASCII file name is accepted (the local diff is decoded from git\'s C-quoting; GitHub lists raw UTF-8)', (t) => {
  const s = plainScenario({ change: (repo) => { repo.write('src/é.js', 'x\n'); } });
  // the fixture's own list may hold git's quoted form ("src/\303\251.js"); GitHub's API gives the raw name
  const raw = [...s.prFiles.filter((f) => !f.filename.startsWith('"')), { filename: 'src/é.js', status: 'added' }];
  s.fake.setScript(script(s, { prFiles: raw }));
  withRecord(t, s);
  assertExit(goMerge(s), 0);
});

test('--owner-go: GitHub\'s files list that equals the local diff (a rename included) is accepted', (t) => {
  const s = plainScenario({ change: (repo) => { repo.git(['mv', 'src/app.js', 'src/renamed.js']); } });
  assert.ok(s.prFiles.some((f) => f.previous_filename === 'src/app.js'), JSON.stringify(s.prFiles));
  withRecord(t, s);
  assertExit(goMerge(s), 0);
});

// ---- A.4: the final look re-reads GitHub's base and head --------------------------------------------------------------------------

const preMergeView = (s, patch) => ({
  match: '^pr view 12 --json state,headRefOid,labels,isDraft', stdoutJson: { state: 'OPEN', headRefOid: s.head, labels: [], isDraft: false, baseRefOid: s.baseTip, ...patch },
});

test('--owner-go: the base moving between the scan and the merge command refuses (pre-merge) and merges nothing', (t) => {
  const s = plainScenario();
  s.fake.setScript(script(s, { extra: [preMergeView(s, { baseRefOid: 'e'.repeat(40) })] }));
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons.join('\n'), /base/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('--owner-go: the head moving between the scan and the merge command refuses (pre-merge) and merges nothing', (t) => {
  const s = plainScenario();
  s.fake.setScript(script(s, { extra: [preMergeView(s, { headRefOid: 'f'.repeat(40) })] }));
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reasons.join('\n'), /head/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('--owner-go: the final look asks GitHub for the base commit, and an unchanged base passes', (t) => {
  const s = plainScenario();
  withRecord(t, s);
  assertExit(goMerge(s), 0);
  assert.ok(s.fake.lines().some((l) => /^pr view 12 --json state,headRefOid,labels,isDraft,baseRefOid/.test(l)), s.fake.lines().join('\n'));
});

test('preMergeProblems: an expected base is compared with GitHub\'s; callers that pass none keep working', async () => {
  const view = { state: 'OPEN', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), labels: [], isDraft: false };
  const gh = { prView: () => view, listIssues: () => [] };
  assert.deepEqual(await preMergeProblems({ gh, pr: 12, head: 'a'.repeat(40) }), []);
  assert.deepEqual(await preMergeProblems({ gh, pr: 12, head: 'a'.repeat(40), base: 'b'.repeat(40) }), []);
  const moved = await preMergeProblems({ gh, pr: 12, head: 'a'.repeat(40), base: 'c'.repeat(40) });
  assert.match(moved.join('\n'), /PR base is now bbbbbbbb, the scan was of cccccccc/);
  const unreadable = await preMergeProblems({ gh: { ...gh, prView: () => ({ ...view, baseRefOid: undefined }) }, pr: 12, head: 'a'.repeat(40), base: 'c'.repeat(40) });
  assert.match(unreadable.join('\n'), /base/);
});

// ---- what evaluateOwnerGo returns -----------------------------------------------------------------------------------------------------

const stubGh = (s) => ({
  prView: () => ({ state: 'OPEN', headRefOid: s.head, baseRefName: 'main', baseRefOid: s.baseTip, isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
  checks: () => [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }],
  pullFiles: () => s.prFiles,
  repo: () => ({ slug: 'acme/widgets', host: 'github.com' }),
});

test('evaluateOwnerGo returns ownerItems, the item lines and areas from ONE list, plus the range it scanned', async () => {
  const s = protectedScenario();
  const { config } = await loadConfig(s.repo.dir);
  const live = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: stubGh(s), env: {} });
  assert.equal(live.baseRefOid, s.baseTip);
  assert.equal(live.headRefOid, s.head);
  assert.equal(live.ownerItemLines.length, 1, JSON.stringify(live.ownerItemLines));
  assert.match(live.ownerItemLines[0], /^hardstop \S+ src\/app\.js$/);
  assert.equal(live.ownerItems, ownerItemsDigest(live.ownerItemLines));
  assert.notEqual(live.ownerItems, 'none');
  assert.deepEqual(live.areas, [live.ownerItemLines[0].split(' ')[1]]);
  // chat mode: an owner item no longer fails the owner-items check (the owner's record is bound to its digest instead)
  assert.equal(live.checks.find((c) => c.name === 'owner-items').ok, true);
  assert.equal(live.ok, true, JSON.stringify(live.checks.filter((c) => !c.ok)));
});

test('evaluateOwnerGo on a diff without items: ownerItems is "none", no lines, no areas', async () => {
  const s = plainScenario();
  const { config } = await loadConfig(s.repo.dir);
  const live = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: stubGh(s), env: {} });
  assert.equal(live.ok, true, JSON.stringify(live.checks.filter((c) => !c.ok)));
  assert.deepEqual([live.ownerItems, live.ownerItemLines, live.areas], ['none', [], []]);
});

// ---- the base re-read cannot hinge on scan-range -------------------------------------------------------------------------------------

test('ownerGoBaseProblem: only a full 40-hex baseRefOid lets the merge go on (P merge --owner-go and its dry run both ask)', async () => {
  const s = plainScenario();
  const { config } = await loadConfig(s.repo.dir);
  const live = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: stubGh(s), env: {} });
  assert.equal(ownerGoBaseProblem(live), null);
  for (const baseRefOid of [null, undefined, '', 'main', 'nothex', 'A'.repeat(40), 'b'.repeat(39), 'b'.repeat(41), 7]) {
    assert.match(ownerGoBaseProblem({ ...live, baseRefOid }) ?? '', /did not name the PR's base commit as a full 40-character sha/, String(baseRefOid));
  }
  // and the real thing: GitHub's view without baseRefOid gives a live result that carries none
  const noBase = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: { ...stubGh(s), prView: () => ({ ...stubGh(s).prView(), baseRefOid: undefined }) }, env: {} });
  assert.equal(noBase.baseRefOid, null);
  assert.match(ownerGoBaseProblem(noBase), /base commit/);
});
