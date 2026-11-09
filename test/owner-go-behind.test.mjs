// `P merge --owner-go` on a PR that lacks commits of its base (plan 2026-11-05-small-fixes item 2). With merge.behind_base: disjoint in the BASE
// commit's config, a PR whose base moved is accepted when main's new commits touch none of the PR's files and none of the toolchain / CI inputs;
// everything else keeps the old refusal (behind-base). Also: no landing on a base nobody checked (the wait pins GitHub's baseRefOid).
// Real CLI against the scripted fake gh and real git repos (main moves with real commits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, ghEntries, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { ymlWith } from './helpers/ci-proof-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { behindFreshEnough, evaluateOwnerGo, READABLE_MERGE_STATES, waitBlockers, waitForMerge } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';

const goYml = (yml = ymlFor()) => yml.replace('{pr} {sha}', '{pr} --match-head-commit {sha}');
// The base's config: opted in (or not) and optionally more merge keys. The merge section is the last one, right after wait_minutes.
const withMerge = (yml, lines) => yml.replace('  wait_minutes: 1\n', `  wait_minutes: 1\n${lines}`);
const disjointYml = (more = '', yml = ymlFor()) => goYml(withMerge(yml, `  behind_base: disjoint\n${more}`));
const unique = (change = bump) => (repo) => { change(repo); repo.write('.salt', randomUUID()); };
const fresh = (opts = {}) => scenario({ yml: disjointYml(), report: null, state: null, ...opts, change: unique(opts.change) });
const goMerge = (s, env = {}) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
const withRecord = (t, s) => ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
const script = (s, o = {}) => ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, ...o });

// One commit on main, then back on the PR branch. -> the new main tip (what GitHub's baseRefOid becomes).
function mainMoves(s, edit) {
  s.repo.git(['checkout', '-q', 'main']);
  edit(s.repo);
  const tip = s.repo.commit('main moves');
  s.repo.git(['checkout', '-q', 'agent/feature']);
  return tip;
}
// The PR is behind: main moved to `tip`, GitHub says so and calls the PR CLEAN (or `mergeStateStatus`).
const behindScript = (s, tip, o = {}) => s.fake.setScript(script(s, { baseOid: tip, mergeStateStatus: 'CLEAN', ...o }));
const reasons = (r) => (r.json.reasons ?? []).join('\n');
const refusedBehind = (r, s, pattern) => {
  assertExit(r, 1);
  assert.match(reasons(r), /behind-base/);
  if (pattern) assert.match(reasons(r), pattern);
  assert.deepEqual(s.mergeCalls(), [], 'no merge command may run');
};

// ---- accepted ----------------------------------------------------------------------------------------------------------------------

test('behind_base disjoint: main changed only files the PR does not touch -> owner-go merges, output carries `behind`', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => { repo.write('other.txt', 'x\n'); repo.write('more/other2.txt', 'y\n'); });
  behindScript(s, tip);
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.deepEqual(r.json.behind, { behindBy: 1, mergeBase: s.baseTip, baseRefOid: tip, mainFiles: 2, rule: 'disjoint' });
  assert.equal(s.mergeCalls().length, 1);
});

test('behind_base disjoint: an up-to-date PR reports behind: null', (t) => {
  const s = fresh();
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.behind, null);
});

// ---- the opt-in comes from the BASE ----------------------------------------------------------------------------------------------

test('behind_base default (update): a behind PR is refused, and the detail says why disjoint was not applied', (t) => {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique() });
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /merge\.behind_base is "update"/);
});

test('behind_base: the PR\'s OWN pipeline.yml saying disjoint does not count when the base\'s does not', (t) => {
  const s = scenario({
    yml: goYml(), report: null, state: null,
    change: unique((repo) => { bump(repo); repo.write('.claude/pipeline.yml', disjointYml()); }),
  });
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /merge\.behind_base is "update"/);
});

test('behind_base: a base commit with no .claude/pipeline.yml, or an invalid one, is strict (the reason says which)', (t) => {
  const missing = fresh();
  const gone = mainMoves(missing, (repo) => repo.rm('.claude/pipeline.yml'));
  behindScript(missing, gone);
  withRecord(t, missing);
  refusedBehind(goMerge(missing), missing, /has no \.claude\/pipeline\.yml/);

  const invalid = fresh();
  const bad = mainMoves(invalid, (repo) => repo.write('.claude/pipeline.yml', 'version: 1\nbehind_base: [\n'));
  behindScript(invalid, bad);
  withRecord(t, invalid);
  refusedBehind(goMerge(invalid), invalid, /\.claude\/pipeline\.yml/);
  assert.doesNotMatch(reasons(goMerge(invalid)), /fresh enough: undefined/);

  const typo = fresh();
  const wrong = mainMoves(typo, (repo) => repo.write('.claude/pipeline.yml', withMerge(ymlFor(), '  behind_base: dis-joint\n')));
  behindScript(typo, wrong);
  withRecord(t, typo);
  refusedBehind(goMerge(typo), typo, /not a valid config/);
});

// ---- rule 3: disjoint ----------------------------------------------------------------------------------------------------------------

test('behind_base disjoint: main changed files the PR also touches -> behind-base naming the first 3 and the count', (t) => {
  const many = (repo) => { bump(repo); for (const n of [1, 2, 3, 4]) repo.write(`gen/a${n}.js`, 'pr\n'); };
  const s = fresh({ change: many, baseFiles: Object.fromEntries([1, 2, 3, 4].map((n) => [`gen/a${n}.js`, 'base\n'])) });
  const tip = mainMoves(s, (repo) => { for (const n of [1, 2, 3, 4]) repo.write(`gen/a${n}.js`, 'main\n'); });
  behindScript(s, tip);
  withRecord(t, s);
  const r = goMerge(s);
  refusedBehind(r, s, /changed 4 file\(s\) this PR also touches \(gen\/a1\.js, gen\/a2\.js, gen\/a3\.js, \.\.\.\)/);
  assert.doesNotMatch(reasons(r), /a4\.js/);
});

test('behind_base disjoint: main renamed a PR file away (the old name is one of main\'s paths) -> behind-base', (t) => {
  const s = fresh({ change: (repo) => { bump(repo); repo.write('docs/guide.md', '# Guide\n\nPR edit\n'); } });
  const tip = mainMoves(s, (repo) => repo.git(['mv', 'docs/guide.md', 'docs/manual.md']));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /docs\/guide\.md/);
});

test('behind_base disjoint: a case-only difference (Src2/A.md vs src2/a.md) is the same file -> behind-base', (t) => {
  const s = fresh({ change: (repo) => { bump(repo); repo.write('Src2/A.md', 'pr\n'); } });
  const tip = mainMoves(s, (repo) => repo.write('src2/a.md', 'main\n'));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /src2\/a\.md/);
});

test('behind_base disjoint: a non-ASCII path and a path with a space changed on BOTH sides -> behind-base (read the same way on both sides)', (t) => {
  for (const name of ['docs/résumé.md', 'docs/my file.md']) {
    const s = fresh({ change: (repo) => { bump(repo); repo.write(name, 'pr\n'); } });
    const tip = mainMoves(s, (repo) => repo.write(name, 'main\n'));
    // GitHub lists raw UTF-8 names; the fixture's own list may hold git's quoted form
    const raw = [...s.prFiles.filter((f) => !f.filename.startsWith('"')), { filename: name, status: 'added' }];
    behindScript(s, tip, { prFiles: raw });
    withRecord(t, s);
    refusedBehind(goMerge(s), s, new RegExp(`this PR also touches \\(${name}\\)`));
  }
});

test('behind_base disjoint: main removed src/foo/, which the PR adds a file into -> behind-base naming the directory (rule 4b)', (t) => {
  const s = fresh({ baseFiles: { 'src/foo/a.js': 'a\n' }, change: (repo) => { bump(repo); repo.write('src/foo/new.js', 'n\n'); } });
  const tip = mainMoves(s, (repo) => repo.git(['mv', 'src/foo', 'src/bar']));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /removed src\/foo\/, which this PR adds into \(src\/foo\/new\.js\)/);
});

// Codex code review R1: the directory is compared folded. Called directly with the PR's side as a diff entry: a case-insensitive checkout
// (macOS, Windows) cannot even write src/foo/new.js next to src/Foo/, and main's side (real commits) is what must be read folded.
test('behind_base disjoint: main removed src/Foo/ and the PR adds src/foo/new.js -> the same directory, folded (rule 4b)', () => {
  const s = fresh({ baseFiles: { 'src/Foo/a.js': 'a\n' } });
  const tip = mainMoves(s, (repo) => repo.git(['rm', '-q', '-r', 'src/Foo']));
  const r = behindFreshEnough({
    root: s.repo.dir, config: { default_branch: 'main' }, baseSha: tip, info: { mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' },
    diff: () => ({ ok: true, mb: s.baseTip, files: [{ status: 'A', oldPath: null, newPath: 'src/foo/new.js' }] }),
  });
  assert.deepEqual(r, { ok: false, reason: 'main removed src/foo/, which this PR adds into (src/foo/new.js)' });
});

// ---- rule 4: nothing on main's side changes how the checks run ------------------------------------------------------------------------

const hits = [
  ['.github/workflows/x.yml', (repo) => repo.write('.github/workflows/x.yml', 'on: push\n')],
  ['.claude/pipeline.yml', (repo) => repo.write('.claude/pipeline.yml', `${disjointYml()}# main edit\n`)],
  ['scripts/verify.mjs', (repo) => repo.write('scripts/verify.mjs', 'x\n')],
  ['scripts/verify/run.mjs', (repo) => repo.write('scripts/verify/run.mjs', 'x\n')],
  ['.gitattributes', (repo) => repo.write('.gitattributes', '* text=auto\n')],
  ['sub/.gitattributes', (repo) => repo.write('sub/.gitattributes', '*.js -diff\n')],
  ['.nvmrc', (repo) => repo.write('.nvmrc', '20\n')],
  ['.node-version', (repo) => repo.write('.node-version', '20\n')],
  ['.tool-versions', (repo) => repo.write('.tool-versions', 'nodejs 20\n')],
  ['.gitmodules', (repo) => repo.write('.gitmodules', '# none\n')],
  ['.GITHUB/workflows/y.yml', (repo) => repo.write('.GITHUB/workflows/y.yml', 'on: push\n')],
];
for (const [name, edit] of hits) {
  test(`behind_base disjoint: ${name} changed on main always forces the update`, (t) => {
    const s = fresh();
    const tip = mainMoves(s, edit);
    behindScript(s, tip);
    withRecord(t, s);
    refusedBehind(goMerge(s), s, /changes how the checks run/);
  });
}

test('behind_base disjoint: the base\'s merge.behind_base_stale_paths and verify.ci_proof_inputs globs force the update', (t) => {
  const stale = scenario({ yml: disjointYml("  behind_base_stale_paths: ['package.json', 'supabase/**']\n"), report: null, state: null, change: unique() });
  const a = mainMoves(stale, (repo) => repo.write('supabase/migrations/0001.sql', 'select 1;\n'));
  behindScript(stale, a);
  withRecord(t, stale);
  refusedBehind(goMerge(stale), stale, /supabase\/migrations\/0001\.sql.*matches supabase\/\*\*/);

  const inputs = scenario({ yml: disjointYml('', ymlWith({ inputs: ["'data/**'"] })), report: null, state: null, change: unique() });
  const b = mainMoves(inputs, (repo) => repo.write('data/spec.json', '{}\n'));
  behindScript(inputs, b);
  withRecord(t, inputs);
  refusedBehind(goMerge(inputs), inputs, /data\/spec\.json.*matches data\/\*\*/);

  // and a main change outside every list is still fine for the same configs
  const ok = scenario({ yml: disjointYml("  behind_base_stale_paths: ['package.json']\n", ymlWith({ inputs: ["'data/**'"] })), report: null, state: null, change: unique() });
  const c = mainMoves(ok, (repo) => repo.write('notes/readme.txt', 'x\n'));
  behindScript(ok, c);
  withRecord(t, ok);
  assertExit(goMerge(ok), 0);
});

// ---- rule 2: GitHub agrees --------------------------------------------------------------------------------------------------------------

test('behind_base disjoint: mergeStateStatus BEHIND / DIRTY / UNKNOWN / HAS_HOOKS-less odd values are never accepted; the readable ones are', (t) => {
  for (const state of ['BEHIND', 'DIRTY', 'UNKNOWN', 'DRAFT', undefined]) {
    const s = fresh();
    const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
    behindScript(s, tip, { mergeStateStatus: state });
    withRecord(t, s);
    refusedBehind(goMerge(s), s, /mergeStateStatus/);
  }
  for (const state of READABLE_MERGE_STATES) {
    const s = fresh();
    const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
    behindScript(s, tip, { mergeStateStatus: state });
    withRecord(t, s);
    assertExit(goMerge(s), 0);
  }
});

test('behind_base disjoint: GitHub mergeable CONFLICTING / UNKNOWN is never accepted', (t) => {
  for (const mergeable of ['CONFLICTING', 'UNKNOWN']) {
    const s = fresh();
    const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
    behindScript(s, tip, { mergeable });
    withRecord(t, s);
    const r = goMerge(s, { PIPELINE_MERGEABLE_PAUSE_MS: '1' });
    assertExit(r, 1);
    assert.deepEqual(s.mergeCalls(), []);
  }
});

// ---- rule 6: no landing on a base nobody checked --------------------------------------------------------------------------------------

const QUICK = { PIPELINE_MERGE_WAIT_MS: '1500', PIPELINE_MERGE_POLL_MS: '50' };
// The poll (state,mergeCommit,labels,baseRefOid) says OPEN on base `baseRefOid`; so does the look after the abandon (state,mergeCommit).
const pollOpen = (s, baseRefOid) => [
  { match: '^pr view 12 --json state,mergeCommit,labels,baseRefOid', stdoutJson: { state: 'OPEN', mergeCommit: null, labels: [], baseRefOid } },
  { match: '^pr view 12 --json state,mergeCommit$', stdoutJson: { state: 'OPEN', mergeCommit: null } },
];

test('--owner-go (behind, accepted): GitHub\'s baseRefOid changing while the queued merge waits -> auto-merge disabled, exit 1, not merged', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, tip, { extra: pollOpen(s, 'e'.repeat(40)) });
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.match(r.json.reason, /a blocker appeared while waiting: PR base is now eeeeeeee, the merge was evaluated on/);
  assert.match(r.json.reason, /auto-merge disabled/);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.behind.baseRefOid, tip);
  assert.equal(s.mergeCalls().length, 1, 'the (queued) merge command ran');
  assert.ok(s.fake.lines().some((l) => /^pr merge 12 --disable-auto/.test(l)), s.fake.lines().join('\n'));
});

test('--owner-go (UP TO DATE): main moving while the queued merge waits is abandoned too, not merged', (t) => {
  const s = fresh();
  s.fake.setScript(script(s, { extra: pollOpen(s, 'd'.repeat(40)) }));
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.match(r.json.reason, /a blocker appeared while waiting: PR base is now dddddddd/);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.behind, null);
});

test('--owner-go: the wait keeps going while GitHub\'s baseRefOid is still the evaluated one (timeout, not blocked)', (t) => {
  const s = fresh();
  s.fake.setScript(script(s, { extra: pollOpen(s, s.baseTip) }));
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.match(r.json.reason, /not merged in time/);
});

// ---- the pieces in-process ---------------------------------------------------------------------------------------------------------------

test('waitBlockers: with a base it asks for baseRefOid and blocks on any other (or missing) one; without it nothing changes', async () => {
  const gh = { listIssues: () => [] };
  const view = { labels: [], baseRefOid: 'a'.repeat(40) };
  assert.deepEqual(waitBlockers(gh).fields, []);
  assert.deepEqual(await waitBlockers(gh)({ labels: [] }), []);
  const guarded = waitBlockers(gh, { base: 'a'.repeat(40) });
  assert.deepEqual(guarded.fields, ['baseRefOid']);
  assert.deepEqual(await guarded(view), []);
  assert.match((await guarded({ ...view, baseRefOid: 'b'.repeat(40) })).join(), /PR base is now bbbbbbbb/);
  assert.match((await guarded({ labels: [] })).join(), /PR base is now/);
  const seen = [];
  const out = await waitForMerge({
    gh: { prView: (_pr, fields) => { seen.push(fields); return { state: 'OPEN', labels: [], baseRefOid: 'c'.repeat(40) }; } },
    pr: 1, waitMs: 1000, pollMs: 10, blockers: guarded,
  });
  assert.equal(out.state, 'blocked');
  assert.deepEqual(seen[0], ['state', 'mergeCommit', 'labels', 'baseRefOid']);
});

test('behindFreshEnough never throws and never returns null: a missing base sha is { ok: false }', () => {
  const diff = () => ({ ok: false, error: 'boom' });
  for (const baseSha of [undefined, null, 'main', '', 'a'.repeat(39)]) {
    const r = behindFreshEnough({ root: '.', config: { default_branch: 'main' }, diff, baseSha, info: {} });
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
});

// Codex code review R1: the case above returns before the diff is ever taken. Here the base is a real opted-in commit and GitHub's state is
// readable, so the diff IS read: a failed PR diff, and a failed read of main's side, are each a refusal with its reason (never a throw or null).
test('behindFreshEnough: with an opted-in base and a readable state, a failed PR diff or an unreadable main side is { ok: false }', () => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const args = { root: s.repo.dir, config: { default_branch: 'main' }, baseSha: tip, info: { mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' } };
  let calls = 0;
  const failed = behindFreshEnough({ ...args, diff: () => { calls += 1; return { ok: false, error: 'boom' }; } });
  assert.equal(calls, 1, 'the PR diff was read');
  assert.deepEqual(failed, { ok: false, reason: "the PR's diff could not be taken (boom)" });

  const missing = 'f'.repeat(40); // a well-formed merge base that is not in the repository: main's side cannot be diffed
  const mainSide = behindFreshEnough({ ...args, diff: () => ({ ok: true, mb: missing, files: [] }) });
  assert.equal(mainSide.ok, false);
  assert.match(mainSide.reason, /could not (compare|count)/);
});

// ---- merge queue: the queue merges on a fresh base, so a behind PR is no problem there -------------------------------------------------

test('owner-go evaluator on a behind PR: queue on => no behind-base problem; queue off => behind-base; unreadable => queue-state (fail closed)', async () => {
  const s = fresh({ yml: goYml() }); // the base does not opt in to `disjoint`: only the queue can lift the behind refusal
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const { config } = await loadConfig(s.repo.dir);
  const evaluate = (o) => {
    behindScript(s, tip, o);
    const gh = createGitHub({ cwd: s.repo.dir, env: s.fake.env });
    return evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh, env: {} });
  };
  const detail = (live, name) => live.checks.find((c) => c.name === name)?.detail ?? '';

  const off = await evaluate({ queue: false });
  assert.match(detail(off, 'pr-open'), /behind-base/);
  assert.equal(off.behind, null);
  assert.ok(!off.failed.includes('queue-state'));

  const on = await evaluate({ queue: true });
  assert.doesNotMatch(detail(on, 'pr-open'), /behind-base/);
  assert.ok(!on.failed.includes('pr-open'), JSON.stringify(on.checks.filter((c) => !c.ok)));
  assert.equal(on.behind, null, 'the disjoint report is for the direct path only');

  const unreadable = await evaluate({ queue: 'error' });
  assert.equal(unreadable.ok, false);
  assert.ok(unreadable.failed.includes('queue-state'), unreadable.failed.join());
  assert.match(detail(unreadable, 'pr-open'), /behind-base/, 'an unreadable queue never lifts the behind refusal');

  // A PR that is not behind never needs the queue read (no extra GraphQL call, no new failure mode).
  const calls = s.fake.calls().length;
  s.fake.setScript(script(s, { baseOid: s.baseTip, queue: 'error' }));
  const current = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: createGitHub({ cwd: s.repo.dir, env: s.fake.env }), env: {} });
  assert.ok(!current.failed.includes('queue-state'));
  assert.ok(!s.fake.calls().slice(calls).some((c) => c.argv[0] === 'api' && c.argv[1] === 'graphql'));
});
