// R1-B2: the Codex model is resolved from the trusted fork point AFTER admitRound has fetched the default branch, so a local origin/main that is behind the remote cannot pick
// (and record) an older model than the one the PR's real fork point commits. The real CLI against a throwaway repo with a bare origin, a fake gh and a scripted fake Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roundWorld, findingsOf } from './helpers/round-world.mjs';
import { REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';

// Local origin/main still at A (codex_model gpt-test-1); the remote's main has advanced to B (gpt-test-2) and the PR contains B. -> { merged, forkB, from }
// stacked (R2-F1): the PR targets a parent branch that already holds B instead of main, so admission fetches origin/parent and only the default branch's own refresh can fix the trusted
// fork point; `from` is the round's base (the parent's tip when stacked, else B).
function staleOriginWorld(t, { stacked = false } = {}) {
  const w = roundWorld(t, { max: 3, review: '  codex_model: gpt-test-1\n' });
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-origin-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { repo } = w;
  repo.git(['init', '-q', '--bare', '-b', 'main', dir]);
  repo.git(['remote', 'add', 'origin', dir]);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const a = repo.git(['rev-parse', 'main']).trim();
  repo.git(['checkout', '-q', 'main']);
  const yml = path.join(repo.dir, '.claude', 'pipeline.yml');
  fs.writeFileSync(yml, fs.readFileSync(yml, 'utf8').replace('gpt-test-1', 'gpt-test-2'));
  const forkB = repo.commit('main: new codex model');
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['update-ref', 'refs/remotes/origin/main', a]); // the local copy of the remote's main has not been fetched since
  let from = forkB;
  if (stacked) {
    repo.git(['checkout', '-q', '-b', 'parent', 'main']);
    repo.write('src/parent.js', 'export const parent = 1;\n');
    from = repo.commit('parent: its own work');
    repo.git(['push', '-q', 'origin', 'parent']);
  }
  repo.git(['checkout', '-q', 'feat/x']);
  repo.git(['merge', '--no-edit', stacked ? 'parent' : 'main']);
  const merged = repo.git(['rev-parse', 'HEAD']).trim();
  w.prHead(merged);
  if (stacked) {
    w.fake.setScript([
      { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'parent', headRefOid: merged } },
      { match: '^repo view', stdoutJson: { ...REPO_VIEW, nameWithOwner: w.slug, url: `https://github.com/${w.slug}` } },
      { match: '^pr edit 7 ', code: 0 },
    ]);
  }
  return { w, merged, forkB, from };
}

test('R1-B2: a stale local origin/main does not choose the model: the round runs with, and records, the model of the fork point admitRound fetched', (t) => {
  const { w, merged, forkB } = staleOriginWorld(t);
  const r = w.codex(1, findingsOf(), { from: forkB, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.state().rounds[0].codexModel, 'gpt-test-2');
});

test('R1-B2: --model naming the fetched fork point\'s model is accepted, and the stale one is refused with model-mismatch', (t) => {
  const { w, merged, forkB } = staleOriginWorld(t);
  const stale = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', forkB, '--head', merged, '--effort', 'high', '--model', 'gpt-test-1']);
  assertExit(stale, 2);
  assert.deepEqual([stale.json.error, stale.json.expected], ['model-mismatch', 'gpt-test-2']);
  const fresh = w.codex(1, findingsOf(), { from: forkB, to: merged });
  assertExit(fresh, 0, fresh.stderr + fresh.stdout);
  assert.equal(w.state().rounds[0].codexModel, 'gpt-test-2');
});

test('R2-F1: a stacked PR (base is not the default branch) also gets the default branch refreshed: the round runs with, and records, the model at the real fork point, and the stale one is refused', (t) => {
  const { w, merged, from } = staleOriginWorld(t, { stacked: true });
  const stale = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', from, '--head', merged, '--effort', 'high', '--model', 'gpt-test-1']);
  assertExit(stale, 2);
  assert.deepEqual([stale.json.error, stale.json.expected], ['model-mismatch', 'gpt-test-2']);
  const fresh = w.codex(1, findingsOf(), { from, to: merged });
  assertExit(fresh, 0, fresh.stderr + fresh.stdout);
  assert.equal(w.state().rounds[0].codexModel, 'gpt-test-2');
});

// R2-F2 (changed by #443): a malformed codex_model is now refused where the config is validated, so it can no longer reach the trusted-model check from the working tree. One committed at
// the default branch's fork point makes that base config unreadable: the round and --plan use the built-in default model (and the usual unreadable-base rules: substitute off), they do not
// exit 2. The working-tree value is repaired first, else requireConfig refuses before the base fallback is ever consulted.
test('R2-F2: a malformed codex_model committed at the default branch reads as an unreadable base: --plan and the round run with the built-in default model, and the attempt is closed (no pending route.json)', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_model: gpt 5\n' });
  w.config({ review: '  codex_model: gpt-test-1\n' });
  const reviewDir = path.join(w.repo.dir, '.review');
  const plan = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--plan']);
  assertExit(plan, 0, plan.stderr + plan.stdout);
  assert.equal(plan.json.ok, true);
  const r = w.codex(1, findingsOf());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.state().rounds[0].codexModel, DEFAULTS.review.codex_model);
  const pending = fs.readdirSync(reviewDir, { recursive: true }).filter((p) => /route\.json$/.test(String(p)))
    .filter((p) => JSON.parse(fs.readFileSync(path.join(reviewDir, String(p)), 'utf8')).evidence === 'pending');
  assert.deepEqual(pending, []);
});

test('#443: a malformed codex_model in the working tree fails the config check (exit 2, named) before any attempt or route.json is written; --plan refuses too', (t) => {
  const w = roundWorld(t, { max: 3, review: '  codex_model: gpt 5\n' });
  const reviewDir = path.join(w.repo.dir, '.review');
  const plan = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--plan']);
  assertExit(plan, 2, plan.stderr + plan.stdout);
  assert.match(plan.stderr + plan.stdout, /review\.codex_model must be a model id/);
  const r = w.codex(1, findingsOf());
  assertExit(r, 2, r.stderr + r.stdout);
  assert.match(r.stderr + r.stdout, /review\.codex_model must be a model id/);
  const left = fs.existsSync(reviewDir)
    ? fs.readdirSync(reviewDir, { recursive: true }).filter((p) => /route\.json$|attempt-/.test(String(p)))
    : [];
  assert.deepEqual(left, []);
});
