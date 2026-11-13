// S1: an UNTRUSTED anchor (an origin remote that answers neither origin/HEAD nor ls-remote, so the default branch is the working tree's, which the PR can edit) must never be what
// narrows a reviewed range: merged-in commits of the branch it names are not left out of a round, and a base branch GitHub did not name is not read from it. The real CLI
// against a throwaway repo, a fake gh and a scripted fake Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundWorld, findingsOf, low, aFile } from './helpers/round-world.mjs';
import { REPO_VIEW } from './helpers/fakegh-env.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import * as risk from '../pipeline/lib/risk.mjs';

const prBaseBranch = (...a) => risk.prBaseBranch(...a);

const NO_ORIGIN = '/nonexistent/cp-no-such-origin-s1';

// Round 1 recorded, then main moves and is merged into the PR branch: the next round's range is the merge alone.
function afterBaseMerge(t, { origin }) {
  const w = roundWorld(t, { max: 3 });
  if (origin) w.repo.git(['remote', 'add', 'origin', origin]); // before round 1, so the PR is on Fable from the start (a judge-to-Fable escalation would review the whole PR anyway)
  const one = w.codex(1, findingsOf([], [low()]));
  assertExit(one, 0, one.stderr + one.stdout);
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('src/a.js', aFile(false).replace('export const v10 = 10;', 'export const v10 = 1000;'));
  w.repo.commit('main moves');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', 'main']);
  const merged = w.repo.git(['rev-parse', 'HEAD']).trim();
  w.prHead(merged);
  return { w, merged };
}

test('S1: with a trusted anchor (no origin remote) the merged-in main commits are left out: a base-only round (control)', (t) => {
  const { w, merged } = afterBaseMerge(t, { origin: undefined });
  const p = w.cli(['codex-review', '--pr', '7', '--round', '2', '--base', w.head, '--head', merged, '--plan']);
  assertExit(p, 0, p.stderr + p.stdout);
  assert.equal(p.json.plan.baseOnly, true);
});

test('S1: with an untrusted anchor the merged-in commits are NOT left out: the round reviews w.head..merged as it is (kind previous), never base-only', (t) => {
  const { w, merged } = afterBaseMerge(t, { origin: NO_ORIGIN });
  const p = w.cli(['codex-review', '--pr', '7', '--round', '2', '--base', w.head, '--head', merged, '--plan']);
  assertExit(p, 0, p.stderr + p.stdout);
  assert.equal(p.json.plan.baseOnly, undefined, 'a merge of the branch the PR chose is not nothing to review');
  const run = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(run, 0, run.stderr + run.stdout);
  const round = w.state().rounds.at(-1);
  assert.deepEqual([round.reviewBaseKind, round.reviewBase, round.baseOnly], ['previous', w.head, undefined]);
});

// GitHub names no base branch (a view without baseRefName).
const noBaseView = (w) => w.fake.setScript([
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', headRefOid: w.head } },
  { match: '^repo view', stdoutJson: { ...REPO_VIEW, nameWithOwner: w.slug, url: `https://github.com/${w.slug}` } },
]);

test('S1: no baseRefName from GitHub and an untrusted anchor: the working tree\'s default_branch is not read as the PR\'s base (exit 3 unanchored-base)', (t) => {
  const w = roundWorld(t, { max: 3 });
  w.repo.git(['remote', 'add', 'origin', NO_ORIGIN]);
  noBaseView(w);
  const r = w.codex(1, findingsOf());
  assertExit(r, 3);
  assert.deepEqual([r.json.reason, r.json.error], ['github', 'unanchored-base']);
  assert.match(r.json.message, /git remote set-head origin -a/);
});

test('S1: no baseRefName but a trusted anchor (no origin remote): the config default branch is the base as before (control)', (t) => {
  const w = roundWorld(t, { max: 3 });
  noBaseView(w);
  const r = w.codex(1, findingsOf());
  assertExit(r, 0, r.stderr + r.stdout);
});

test('prBaseBranch: GitHub\'s answer wins; the fallback is flagged untrusted only when its anchor is the working tree\'s with an origin remote that did not answer', (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('README.md', 'x\n');
  repo.commit('init');
  const config = { default_branch: 'main' };
  assert.deepEqual(prBaseBranch({ baseRefName: 'dev' }, repo.dir, config), { branch: 'dev', untrusted: null });
  assert.deepEqual(prBaseBranch({}, repo.dir, config), { branch: 'main', untrusted: null }, 'no origin remote: local-only use, trusted');
  repo.git(['remote', 'add', 'origin', NO_ORIGIN]);
  assert.deepEqual(prBaseBranch({ baseRefName: 'dev' }, repo.dir, config), { branch: 'dev', untrusted: null });
  const r = prBaseBranch({ baseRefName: '' }, repo.dir, config);
  assert.equal(r.branch, 'main');
  assert.match(r.untrusted, /could not be anchored on the remote/);
});

test('S1: review-complete with no baseRefName and an untrusted anchor refuses (exit 1) rather than read the working tree\'s default branch as the PR\'s base', (t) => {
  const w = roundWorld(t, { max: 3 });
  const one = w.codex(1, findingsOf());
  assertExit(one, 0, one.stderr + one.stdout);
  w.repo.git(['remote', 'add', 'origin', NO_ORIGIN]);
  noBaseView(w);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stdout + r.stderr);
  assert.match(r.json.reason, /GitHub did not name the PR's base branch, and the default branch could not be anchored on the remote/);
});
