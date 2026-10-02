// Shared fixtures for tests of the project-side scripts: a throwaway repo that looks like an onboarded project
// (pipeline.yml, vendored scripts/pipeline, one commit on main) and an async node spawner. Async on purpose: some tests
// run an http server in the test process, and a sync spawn would deadlock it.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTmpRepo } from './tmprepo.mjs';
import { run as vendor } from '../../pipeline/commands/vendor.mjs';

export const CONFIG = (quick = 'node -e "process.exit(0)"', extra = '') => `version: 1
project: demo-app
verify:
  full: ${JSON.stringify('node -e "process.exit(0)"')}
  quick: ${JSON.stringify(quick)}
${extra}`;

export const importVendored = (dir, name) => import(pathToFileURL(join(dir, 'scripts', 'pipeline', `${name}.mjs`)).href);

// repo.base = sha of the one commit on main. gitignore:null / config:null leave those files out.
export async function project({ config = CONFIG(), gitignore = '.verify/\n', files = {} } = {}) {
  const repo = createTmpRepo();
  if (config !== null) repo.write('.claude/pipeline.yml', config);
  if (gitignore !== null) repo.write('.gitignore', gitignore);
  repo.write('src/app.js', 'export const a = 1;\n');
  repo.write('test/app.test.js', "import { test } from 'node:test';\ntest('a', () => { assert.equal(1, 1); });\n");
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  await vendor(['--repo', repo.dir], { cwd: repo.dir, env: process.env });
  repo.base = repo.commit('base');
  return repo;
}

// Runs `node args...`; resolves { code, stdout, stderr, json } (json = parsed stdout, or null when it is empty).
export function runNode(args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, PIPELINE_OFF: undefined, GITHUB_STEP_SUMMARY: undefined, PIPELINE_SMOKE_EXPECT_TEXT: undefined, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { /* not JSON */ }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(input ?? '');
  });
}

const scratch = [];
export function scratchDir() {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-tpl-')));
  scratch.push(d);
  return d;
}
process.on('exit', () => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
