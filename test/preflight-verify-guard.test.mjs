// T1.5 (#161 prevention): `pipeline preflight` runs the guard on the configured verify.quick command from the repo root. If an agent would be refused
// (a script whose comment spells the config path and which writes: the guard stays strict, no comment exemption), the report carries a WARNING with the
// guard's own line-and-reword text, so the reword happens before an agent is refused. A warning only: canMerge and the exit code never change.
// The guard reads HOME from the environment given to preflight, so the fixture's "config folder" is a scratch folder; its path is built from parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight } from '../pipeline/lib/preflight.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { floorEnv } from './helpers/floor-env.mjs';

const YML = ['version: 1', 'project: demo', 'enforcement: github', 'verify:', '  full: node scripts/verify.mjs', '  quick: node scripts/verify.mjs --quick', 'ci:', '  required_checks: [ci]', '  guard_checks: false', ''].join('\n');
const CFG = ['~', '.claude'].join('/');
const BAD = ["import fs from 'node:fs';", `// Each run appends one line to ${CFG}/pipeline-state/verify-runs.jsonl (moved by VERIFY_RUN_HISTORY)`, "fs.writeFileSync('out.txt', 'x');", ''].join('\n');
const GOOD = ["import fs from 'node:fs';", '// Each run appends one line to the run-history file in the config folder (moved by VERIFY_RUN_HISTORY)', "fs.writeFileSync('out.txt', 'x');", ''].join('\n');

async function report(script) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', YML);
  repo.write('scripts/verify.mjs', script);
  repo.commit('init');
  const home = mkdtempSync(join(tmpdir(), 'pf-home-'));
  const fake = createFakeGh([
    { match: '^auth status', code: 0 },
    { match: '^api user', stdout: 'me\n' },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) },
    { match: '^issue list --label pipeline-pause', stdoutJson: [] },
    { match: '^issue list --label pipeline-rollback', stdoutJson: [] },
  ]);
  try {
    const env = { ...fake.env, ...createFakeCodex({}).env, ...floorEnv(), HOME: home, USERPROFILE: home };
    return await runPreflight({ cwd: repo.dir, env });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('T1.5: a verify script whose comment spells the config path and which writes gives a warning that names the line and says to reword it; canMerge is unchanged', async () => {
  const r = await report(BAD);
  assert.equal(r.canMerge, true);
  const w = r.warnings.filter((x) => /verify\.quick/.test(x));
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /node scripts\/verify\.mjs --quick/);
  assert.match(w[0], /refers to a protected pipeline file and writes/);
  assert.match(w[0], /\bline 2\b/);
  assert.match(w[0], /Reword that line/);
});

test('T1.5: the reworded script gives no verify.quick warning', async () => {
  const r = await report(GOOD);
  assert.equal(r.canMerge, true);
  assert.deepEqual(r.warnings.filter((x) => /verify\.quick/.test(x)), []);
});

test('T1.5: a repo whose quick verify the guard cannot read at all (no such script) gives no warning and never fails the report', async () => {
  const r = await report('');
  assert.equal(r.config.ok, true);
  assert.deepEqual(r.warnings.filter((x) => /verify\.quick/.test(x)), []);
});
