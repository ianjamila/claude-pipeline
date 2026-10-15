// `loadRepo` (and so `worktrees keep|unkeep|prune`) when the main checkout sits on a scratch branch without
// .claude/pipeline.yml: the config committed on the remote default branch is used instead, read through git. An invalid
// config in the main checkout still fails, and a feature worktree's own copy is never a source.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { pipelineYml } from './helpers/fakegh-env.mjs';
import { loadRepo } from '../pipeline/lib/worktree-prune/run.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

// A main checkout with a bare origin. `originConfig`: the yml pushed to origin/main (null = none). The main checkout is
// then moved to local/root-scratch whose own tree holds `rootConfig` (null = file removed). One linked worktree `feat`.
function setup({ originConfig, rootConfig, originHead = false }) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-wtcfg-')));
  scratch.push(base);
  const origin = join(base, 'origin.git');
  const repo = createTmpRepo();
  repo.git(['init', '--bare', '-q', '-b', 'main', origin]);
  repo.write('a.txt', 'a\n');
  if (originConfig !== null) repo.write('.claude/pipeline.yml', originConfig);
  repo.commit('init');
  repo.git(['remote', 'add', 'origin', origin]);
  repo.git(['push', '-q', 'origin', 'main']);
  if (originHead) repo.git(['remote', 'set-head', 'origin', 'main']);
  repo.git(['checkout', '-q', '-b', 'local/root-scratch']);
  if (rootConfig === null) repo.rm('.claude/pipeline.yml');
  else repo.write('.claude/pipeline.yml', rootConfig);
  repo.commit('scratch', { allowEmpty: true });
  const feat = join(repo.dir, '.worktrees', 'feat');
  repo.git(['worktree', 'add', '-q', '-b', 'feat/x', feat, 'main']);
  return { repo, feat };
}

test('main checkout without the file: the config committed on origin/main is used, and the source is named', async () => {
  const { repo, feat } = setup({ originConfig: pipelineYml(), rootConfig: null });
  const r = await loadRepo({}, { cwd: feat });
  assert.equal(r.root, repo.dir);
  assert.equal(r.config.project, 'demo');
  assert.equal(r.configSource, 'origin/main');
});

test('origin/HEAD names the default branch when it is set', async () => {
  const { repo } = setup({ originConfig: pipelineYml(), rootConfig: null, originHead: true });
  const r = await loadRepo({}, { cwd: repo.dir });
  assert.equal(r.configSource, 'origin/main');
});

test('falls back to origin/master when there is no origin/HEAD and no origin/main', async () => {
  const { repo } = setup({ originConfig: pipelineYml(), rootConfig: null });
  repo.git(['update-ref', 'refs/remotes/origin/master', 'refs/remotes/origin/main']);
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  const r = await loadRepo({}, { cwd: repo.dir });
  assert.equal(r.configSource, 'origin/master');
});

test('an INVALID config in the main checkout still fails: no fallback to origin', async () => {
  const { repo } = setup({ originConfig: pipelineYml(), rootConfig: 'version: 1\nproject: [oops\n' });
  await assert.rejects(loadRepo({}, { cwd: repo.dir }), (e) => e.output?.error === 'config' && !/missing/.test(e.output.errors.join()));
});

test('an invalid config committed on origin is rejected too', async () => {
  const { repo } = setup({ originConfig: 'version: 99\n', rootConfig: null });
  await assert.rejects(loadRepo({}, { cwd: repo.dir }), (e) => e.output?.error === 'config');
});

test('missing everywhere: the same error as before, and a feature worktree copy is never used', async () => {
  const { repo, feat } = setup({ originConfig: null, rootConfig: null });
  mkdirSync(join(feat, '.claude'), { recursive: true });
  writeFileSync(join(feat, '.claude', 'pipeline.yml'), pipelineYml()); // the feature worktree's own copy must be ignored
  await assert.rejects(loadRepo({}, { cwd: feat }), (e) => {
    assert.equal(e.output.error, 'config');
    assert.deepEqual(e.output.errors, ['missing .claude/pipeline.yml']);
    assert.equal(e.output.path, join(repo.dir, '.claude', 'pipeline.yml'));
    return true;
  });
});

test('happy path unchanged: the main checkout config wins over origin', async () => {
  const { repo, feat } = setup({ originConfig: pipelineYml().replace('project: demo', 'project: fromorigin'), rootConfig: pipelineYml() });
  const r = await loadRepo({}, { cwd: feat });
  assert.equal(r.config.project, 'demo');
  assert.equal(r.configSource, 'worktree');
  assert.equal(r.root, repo.dir);
});

test('CLI: worktrees keep works from a linked worktree when the main checkout has no config', () => {
  const { feat } = setup({ originConfig: pipelineYml(), rootConfig: null });
  const r = spawnSync(process.execPath, [bin, 'worktrees', 'keep', 'feat', '--reason', 'testing'], {
    cwd: feat, encoding: 'utf8', env: { ...process.env, PIPELINE_NOTIFY: 'off' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('CLI: prune warns that the committed default-branch config was used', () => {
  const { feat } = setup({ originConfig: pipelineYml() + 'worktrees:\n  mode: off\n', rootConfig: null });
  const dirs = ['logs', 'holding', 'locks'].map((n) => join(dirname(feat), '..', n));
  const [logs, holding, locks] = dirs;
  mkdirSync(logs); mkdirSync(holding); mkdirSync(locks);
  const r = spawnSync(process.execPath, [bin, 'worktrees', 'prune'], {
    cwd: feat, encoding: 'utf8',
    env: { ...process.env, PIPELINE_NOTIFY: 'off', PIPELINE_PRUNE_LOG_DIR: logs, PIPELINE_HOLDING_DIR: holding, PIPELINE_LOCK_DIR: locks },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.disabled, true);
  assert.match(out.warnings[0], /main checkout has no \.claude\/pipeline\.yml.*origin\/main/);
});
