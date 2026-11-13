// #369 + EW #2056: every default-branch decision of the review loop and the final gate is anchored on what the remote calls its default (refs/remotes/origin/HEAD),
// not on the working-tree config's default_branch (a PR can edit it), and the anchor is resolved FULLY QUALIFIED so a tag or a local branch named origin/<branch>
// cannot shadow it. Every fixture here has origin/HEAD -> develop while pipeline.yml says main (the default), so a site still reading the config shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { pipelineYml } from './helpers/fakegh-env.mjs';
import { scenario, named, ymlFor } from './helpers/gate-env.mjs';
import { setup, judge, ymlWith, ciRow, accepted } from './helpers/ci-proof-env.mjs';
import { loadConfig, validateConfig } from '../pipeline/lib/config.mjs';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { anchorBranch as gitAnchorBranch, contentHash, mergeBase, remoteDefaultBranch, reviewBaseRef as gitReviewBaseRef, treeFingerprint } from '../pipeline/lib/git.mjs';
import { anchorBranch, currentContentHash, prBaseOf, refreshBaseRef, reviewBaseRef } from '../pipeline/lib/review-context.mjs';
import { baseRefFor, localContentHash } from '../pipeline/lib/finalgate.mjs';
import { docsExemptFrom } from '../pipeline/lib/docs-exempt.mjs';
import { laneProblem } from '../pipeline/commands/review-complete.mjs';
import { trustedBase } from '../pipeline/lib/risk.mjs';
import { addRound, emptyState } from '../pipeline/lib/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LEDGER = 'docs/ledger.md';
const config = (extra = '') => validateConfig(parseYaml(pipelineYml() + extra)).config; // default_branch: main
const REMOTE_DEVELOP = 'refs/remotes/origin/develop';

// main: c0; develop: d1 (a commit main lacks); feat/x: f1 on top of develop. origin/main = main, origin/develop = develop, origin/HEAD -> origin/develop.
function world(t, { extraYml = '' } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', pipelineYml() + extraYml);
  repo.write('.gitignore', '.review/\n');
  repo.write('a.txt', 'a\n');
  repo.write(LEDGER, '# Ledger\n');
  repo.write('supabase/migrations/0001_m1.sql', 'select 1;\n'); // the ledger row the docs-exempt test appends names it
  const c0 = repo.commit('c0');
  repo.branch('develop');
  repo.write('d1.txt', 'd\n');
  const d1 = repo.commit('d1');
  repo.branch('feat/x');
  repo.write('f1.txt', 'f\n');
  const f1 = repo.commit('f1');
  repo.git(['update-ref', 'refs/remotes/origin/main', c0]);
  repo.git(['update-ref', REMOTE_DEVELOP, d1]);
  repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', REMOTE_DEVELOP]);
  const cfg = config();
  assert.equal(cfg.default_branch, 'main');
  const hash = (base, head = 'HEAD') => contentHash(base, head, { cwd: repo.dir, exclude: [cfg.agent_log] });
  return { repo, c0, d1, f1, cfg, root: repo.dir, hash };
}

// ---- the helpers ---------------------------------------------------------------------------------------------------

test('anchorBranch / reviewBaseRef / currentContentHash follow origin/HEAD, not config.default_branch, and the ref is fully qualified', (t) => {
  const w = world(t);
  assert.equal(anchorBranch(w.root, w.cfg), 'develop');
  assert.equal(gitAnchorBranch('main', { cwd: w.root }), 'develop');
  assert.equal(reviewBaseRef(w.root, w.cfg), REMOTE_DEVELOP);
  assert.equal(reviewBaseRef(w.root, w.cfg, 'main'), 'refs/remotes/origin/main', 'an explicit (stack) base is still resolved fully qualified');
  assert.equal(currentContentHash(w.root, w.cfg), w.hash(REMOTE_DEVELOP));
  assert.notEqual(currentContentHash(w.root, w.cfg), w.hash('refs/remotes/origin/main'), 'the config branch would have counted develop\'s commit as the PR\'s');
  // no usable origin/HEAD: the config's default_branch is the fallback
  w.repo.git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  assert.equal(anchorBranch(w.root, w.cfg), 'main');
  assert.equal(reviewBaseRef(w.root, w.cfg), 'refs/remotes/origin/main');
});

test('prBaseOf: GitHub\'s baseRefName wins; with none the PR base is the anchor branch', (t) => {
  const w = world(t);
  assert.equal(prBaseOf({ baseRefName: 'release' }, w.root, w.cfg), 'release');
  for (const view of [{ baseRefName: '' }, {}, undefined]) assert.equal(prBaseOf(view, w.root, w.cfg), 'develop', JSON.stringify(view));
});

test('refreshBaseRef fetches the anchor branch (origin/HEAD), not config.default_branch', (t) => {
  const w = world(t);
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-anchor-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const originDir = join(scratch, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
  w.repo.git(['remote', 'add', 'origin', originDir]);
  w.repo.git(['push', '-q', 'origin', 'main:main', 'develop:develop']);
  // the local copy of the anchor branch is stale
  w.repo.git(['update-ref', REMOTE_DEVELOP, w.c0]);
  const r = refreshBaseRef(w.root, w.cfg);
  assert.deepEqual(r, { refreshed: true, usesRemoteRef: true });
  assert.equal(w.repo.git(['rev-parse', REMOTE_DEVELOP]).trim(), w.d1, 'the anchor was fetched');
});

test('laneProblem: the default prBase is the anchor branch (a PR on the remote default is not "stacked")', async (t) => {
  const w = world(t);
  const seen = [];
  const rate = async (args) => { seen.push(args.prBase); return { reviewer: 'judge', level: 'low', laneReasons: [], sizeOnly: false }; };
  const state = emptyState({ repo: 'acme/widgets', pr: 7, branch: 'feat/x', risk: 'low', maxRounds: 2 });
  assert.equal(await laneProblem(state, w.root, w.cfg, w.d1, { rate }), null);
  assert.deepEqual(seen, ['develop']);
  assert.equal(await laneProblem(state, w.root, w.cfg, w.d1, { rate, prBase: 'release' }), null);
  assert.deepEqual(seen, ['develop', 'release'], 'an explicit PR base is untouched');
});

// ---- docs-exempt: the base must be the one the review loop hashed from ---------------------------------------------------------

test('docsExemptFrom: the round\'s hash is checked against the anchor branch (origin/HEAD), like the review loop hashed it', (t) => {
  const extraYml = `review:\n  docs_exempt_paths: ["${LEDGER}"]\n`;
  const w = world(t, { extraYml });
  const cfg = config(extraYml);
  const toHead = w.f1;
  const state = addRound(emptyState({ repo: 'acme/widgets', pr: 7, branch: 'feat/x', risk: 'low', maxRounds: 2 }), {
    n: 1, fromHead: w.d1, toHead, contentHashAtToHead: contentHash(REMOTE_DEVELOP, toHead, { cwd: w.root, exclude: [cfg.agent_log] }), items: [],
  });
  w.repo.write(LEDGER, '# Ledger\n| 0001 | `m1` | 2026-11-05 | #101 | |\n');
  w.repo.commit('ledger row');
  const r = docsExemptFrom(state, { root: w.root, config: cfg, hash: currentContentHash(w.root, cfg) });
  assert.equal(r.exempt, true, r.reason);
  assert.deepEqual(r.files, [LEDGER]);
});

// ---- the final gate ----------------------------------------------------------------------------------------------------------

test('finalgate baseRefFor / localContentHash anchor on origin/HEAD', (t) => {
  const w = world(t);
  assert.equal(baseRefFor(w.root, w.cfg), REMOTE_DEVELOP);
  assert.equal(localContentHash(w.root, w.cfg), w.hash(REMOTE_DEVELOP));
  assert.notEqual(localContentHash(w.root, w.cfg), w.hash('refs/remotes/origin/main'));
});

// A gate scenario whose origin/HEAD names develop while pipeline.yml names main (default).
function gateWorld(t, opts) {
  const s = scenario(opts);
  t.after(() => s.repo.cleanup());
  s.repo.git(['update-ref', REMOTE_DEVELOP, s.baseTip]);
  s.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', REMOTE_DEVELOP]);
  return s;
}

test('final-gate pr-open: the PR base must be the remote default branch, and the behind-base remedy names it', (t) => {
  const onMain = gateWorld(t, {});
  const bad = onMain.gate();
  assert.equal(bad.code, 1, bad.stderr + bad.stdout);
  assert.match(named(bad.json, 'pr-open').detail, /PR base is "main", not develop/);

  const onDevelop = gateWorld(t, { gh: { base: 'develop', mergeStateStatus: 'BEHIND' } });
  const r = onDevelop.gate();
  const detail = named(r.json, 'pr-open').detail;
  assert.match(detail, /behind-base: .*; update the branch from develop and re-verify/);
  assert.doesNotMatch(detail, /PR base is/, 'a PR on the remote default branch has the right base');
  // the refusal says where develop came from and how to repoint a stale origin/HEAD (R1-F1)
  assert.match(detail, /"develop" is the default branch origin\/HEAD names \(pipeline\.yml says default_branch "main"; origin\/HEAD wins\).*git remote set-head origin -a/);
  assert.match(named(bad.json, 'pr-open').detail, /origin\/HEAD names.*git remote set-head origin -a/);
});

test('final-gate pr-open: with no origin/HEAD (or one that agrees with pipeline.yml) the refusal carries no origin/HEAD note', (t) => {
  const s = scenario({ gh: { base: 'release' } }); // no origin/HEAD in the fixture: the anchor is the config's main
  t.after(() => s.repo.cleanup());
  const detail = named(s.gate().json, 'pr-open').detail;
  assert.match(detail, /PR base is "release", not main/);
  assert.doesNotMatch(detail, /origin\/HEAD|set-head/);
});

test('final-gate ci proof: the deferral settings come from the anchor branch\'s config (fetched), not config.default_branch\'s', async () => {
  // main (origin's HEAD branch in the config's eyes) lists no deferral; develop does. The PR changes nothing in the config.
  const s = setup({ yml: ymlFor(), report: ciRow });
  s.repo.git(['checkout', '-q', '-b', 'develop', 'main']);
  s.repo.write('.claude/pipeline.yml', ymlWith());
  const developTip = s.repo.commit('develop grants the deferral');
  s.repo.git(['push', '-q', 'origin', 'develop:develop']);
  s.repo.git(['checkout', '-q', 'agent/feature']);
  s.repo.git(['rebase', '-q', '--onto', 'develop', 'main', 'agent/feature']);
  s.repo.git(['remote', 'set-head', 'origin', 'develop']);
  assert.equal(s.repo.git(['rev-parse', 'refs/remotes/origin/develop']).trim(), developTip);
  // the verify report and head must describe the rebased branch
  const rebased = s.repo.git(['rev-parse', 'HEAD']).trim();
  const { config: cfg } = await loadConfig(s.repo.dir);
  assert.equal(cfg.default_branch, 'main');
  s.head = rebased;
  const now = new Date().toISOString();
  s.setReport((r) => { Object.assign(r, { startedAt: now, finishedAt: now }); r.git.head = rebased; r.git.tree = treeFingerprint({ cwd: s.repo.dir }); ciRow(r); });
  const r = await judge(s);
  accepted(r, 'the anchor branch\'s config grants it');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].base, { ref: 'develop', sha: developTip });
});

// ---- EW #2056: a tag or a local branch named origin/<branch> must not shadow the anchor --------------------------------------------

test('a tag named origin/main pointing at a PR commit does not move the trusted fork point', (t) => {
  const w = world(t);
  w.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  w.repo.git(['tag', 'origin/main', w.f1]); // what a fetch that follows tags would create; short origin/main now resolves to the PR's own commit
  assert.equal(w.repo.git(['rev-parse', 'origin/main']).trim(), w.f1, 'the premise: the short name is shadowed');
  assert.equal(remoteDefaultBranch({ cwd: w.root }), 'main');
  assert.equal(gitReviewBaseRef('main', { cwd: w.root }), 'refs/remotes/origin/main');
  const { trustedFork, defaultBranch } = trustedBase({ root: w.root, head: 'HEAD', config: w.cfg });
  assert.equal(defaultBranch, 'main');
  assert.equal(trustedFork, mergeBase('refs/remotes/origin/main', 'HEAD', { cwd: w.root }));
  assert.equal(trustedFork, w.c0, 'the fork point is main\'s, not the PR commit the tag names');
});

test('a local branch named origin/main does not shadow the anchor either, and a dangling origin/HEAD is not rescued by a tag', (t) => {
  const w = world(t);
  w.repo.git(['branch', 'origin/develop', w.f1]);
  assert.equal(gitReviewBaseRef('develop', { cwd: w.root }), REMOTE_DEVELOP);
  assert.equal(w.repo.git(['merge-base', REMOTE_DEVELOP, 'HEAD']).trim(), w.d1);
  // origin/HEAD -> origin/gone, which does not exist; a tag named origin/gone must not make it resolve
  w.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone']);
  w.repo.git(['tag', 'origin/gone', w.f1]);
  assert.equal(remoteDefaultBranch({ cwd: w.root }), null);
});

// ---- the remaining sites -----------------------------------------------------------------------------------------------------------

// state, triage, codex-review and review-complete take their default branch from the helpers above; this pins that none of them reads the config again.
// The files that may still name config.default_branch, and why.
const CONFIG_BRANCH_OK = new Map([
  ['pipeline/lib/risk.mjs', 'trustedBase: the fallback when origin/HEAD is unusable, and the mismatch comparison'],
  ['pipeline/lib/review-context.mjs', 'anchorBranch: the fallback when origin/HEAD is unusable'],
  ['pipeline/lib/finalgate.mjs', 'anchorOf: the same fallback; behindFreshEnough prints it (the comparison runs on baseSha)'],
  ['pipeline/lib/docs-exempt.mjs', 'anchorBranch input: the same fallback'],
  ['pipeline/lib/queue-route.mjs', 'the merge-queue rules of the repository\'s configured default branch (not a review anchor)'],
  ['pipeline/commands/agent-log.mjs', 'where the agent log is published: the configured default branch (not a review anchor)'],
  ['pipeline/commands/merge.mjs', 'display text of the behind note'],
  ['pipeline/commands/risk.mjs', 'help text'],
]);
test('no review-loop or gate file reads config.default_branch except the documented anchor fallbacks and display sites', () => {
  const root = join(here, '..', 'pipeline');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'templates' && name !== 'node_modules') walk(p); } else if (name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(root);
  const offenders = files
    .map((f) => relative(join(here, '..'), f).split('\\').join('/'))
    .filter((f) => f !== 'pipeline/lib/config.mjs' && /config\??\.default_branch/.test(readFileSync(join(here, '..', f), 'utf8')) && !CONFIG_BRANCH_OK.has(f));
  assert.deepEqual(offenders, [], 'route it through anchorBranch (review-context.mjs / git.mjs), or add the file here with the reason the config value is intended');
});
