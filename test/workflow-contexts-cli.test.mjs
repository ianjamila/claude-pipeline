// Tests for scripts/pipeline/workflow-contexts.mjs. They run the VENDORED copy from a tmp project (what a project's CI really
// runs), never the template, which imports ./lib/* that only exists after `pipeline vendor`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project, runNode } from './helpers/project.mjs';

const CLEAN = 'name: ok\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      SHA: ${{ github.sha }}\n    steps:\n      - run: echo "${{ runner.temp }}"\n';
const BAD_ENV = 'name: bad\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      DIR: ${{ runner.temp }}/x\n    steps:\n      - run: echo hi\n';

const check = (repo, args = [], opts = {}) => runNode(['scripts/pipeline/workflow-contexts.mjs', ...args], { cwd: repo.dir, ...opts });

test('clean workflows: exit 0 and the count of files checked', async () => {
  const repo = await project();
  repo.write('.github/workflows/a.yml', CLEAN);
  repo.write('.github/workflows/b.yaml', CLEAN);
  const r = await check(repo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 workflow file\(s\) checked, no disallowed contexts/);
});

test('a project without .github/workflows: exit 0 with zero files checked', async () => {
  const repo = await project();
  const r = await check(repo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 workflow file\(s\) checked, no disallowed contexts/);
});

test('runner.temp in a job-level env: exit 1 with one line naming the file, the key and the context', async () => {
  const repo = await project();
  repo.write('.github/workflows/ok.yml', CLEAN);
  repo.write('.github/workflows/bad.yml', BAD_ENV);
  const r = await check(repo);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const lines = r.stderr.split('\n').filter((l) => l.includes('bad.yml'));
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /bad\.yml: jobs\.a\.env uses `runner`/);
  assert.ok(!r.stderr.includes('ok.yml'), 'the clean file is not named');
  assert.doesNotMatch(r.stdout, /no disallowed contexts/);
});

test('malformed YAML is a finding: exit 1, the file named', async () => {
  const repo = await project();
  repo.write('.github/workflows/broken.yml', 'jobs: [unclosed');
  const r = await check(repo);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /broken\.yml: not valid YAML/);
});

test('--repo DIR checks another directory than the working directory', async () => {
  const repo = await project();
  repo.write('.github/workflows/bad.yml', BAD_ENV);
  const elsewhere = await project();
  const r = await check(elsewhere, ['--repo', repo.dir]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /bad\.yml/);
  const clean = await check(repo, ['--repo', elsewhere.dir]);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
});

test('usage errors and an unreadable workflows directory exit 2, never 0 or 1', async () => {
  const repo = await project();
  const unknown = await check(repo, ['--bogus']);
  assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr);
  const stray = await check(repo, ['extra']);
  assert.equal(stray.code, 2, stray.stdout + stray.stderr);
  const missing = await check(repo, ['--repo', join(repo.dir, 'no-such-dir')]);
  assert.equal(missing.code, 2, missing.stdout + missing.stderr);
  mkdirSync(join(repo.dir, '.github'), { recursive: true });
  writeFileSync(join(repo.dir, '.github', 'workflows'), 'a file where the directory should be');
  const notDir = await check(repo);
  assert.equal(notDir.code, 2, notDir.stdout + notDir.stderr);
  assert.match(notDir.stderr, /workflow-contexts: /);
});
