// `arbiter needed` and `arbiter apply` take --pr like their siblings (state discard-round, triage claude-ruling): a PR
// that is not the one the local review state belongs to is refused (exit 2, state-pr-mismatch) before anything is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { pipelineYml } from './helpers/fakegh-env.mjs';
import { emptyState } from '../pipeline/lib/state.mjs';
import { floorEnv } from './helpers/floor-env.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');

// A repo whose review state belongs to PR 7 and holds one round with no items (so `needed` has nothing to send).
function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('a.txt', 'a\n');
  repo.commit('init');
  const lockDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-arbiter-pr-')));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  const state = {
    ...emptyState({ repo: 'acme/widgets', pr: 7, branch: 'feat/x' }),
    rounds: [{ n: 1, fromHead: 'a'.repeat(40), toHead: 'b'.repeat(40), contentHashAtToHead: 'h1', items: [] }],
  };
  const reviewDir = join(repo.dir, '.review');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const cli = (args) => {
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_LOCK_DIR: lockDir, ...floorEnv() },
    });
    let json = null;
    try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const snapshot = () => [readFileSync(join(reviewDir, 'state.json'), 'utf8'), readdirSync(reviewDir, { recursive: true }).sort()];
  return { cli, snapshot };
}

for (const sub of ['needed', 'apply']) {
  test(`arbiter ${sub} --pr: the matching PR gives the same result as no --pr`, (t) => {
    const w = world(t);
    const plain = w.cli(['arbiter', sub, '--round', '1']);
    const withPr = w.cli(['arbiter', sub, '--round', '1', '--pr', '7']);
    assert.doesNotMatch(withPr.stderr, /unknown option/i);
    assert.notEqual(withPr.json?.error, 'state-pr-mismatch', withPr.stdout + withPr.stderr);
    assert.equal(withPr.code, plain.code);
    assert.deepEqual(withPr.json, plain.json);
  });

  test(`arbiter ${sub} --pr: another PR is refused with state-pr-mismatch and nothing is written`, (t) => {
    const w = world(t);
    const before = w.snapshot();
    const r = w.cli(['arbiter', sub, '--round', '1', '--pr', '8']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.equal(r.json.error, 'state-pr-mismatch');
    assert.equal(r.json.message, '.review/state.json belongs to PR #7, not #8');
    assert.deepEqual(w.snapshot(), before);
  });

  test(`arbiter ${sub} --pr: zero or a non-number is a usage error`, (t) => {
    const w = world(t);
    for (const bad of ['0', 'x']) {
      const r = w.cli(['arbiter', sub, '--round', '1', '--pr', bad]);
      assert.equal(r.code, 2, bad);
      assert.match(r.json?.message ?? '', /--pr/, `${bad}: ${r.stdout}`);
      assert.doesNotMatch(r.json.message, /Unknown option/);
    }
  });
}
