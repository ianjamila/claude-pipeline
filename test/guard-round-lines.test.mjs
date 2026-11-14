// The `round codex` / `round publish` lines of the review skill pass guard-files and guard-git (plan C, Guard). Same harness as test/guard-codex-job-subst.test.mjs:
// the real pipeline.mjs text stands in for the installed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) D.add(d);
  const names = (d) => [...new Set([...Object.keys(F), ...D].filter((p) => p !== d && dirname(p) === d).map((p) => basename(p)))];
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const PROJ = '/home/u/proj';
const CLI = '/home/u/.claude/pipeline/bin/pipeline.mjs';
const REAL_CLI = readFileSync(new URL('../pipeline/bin/pipeline.mjs', import.meta.url), 'utf8');
const BIN = '~/.claude/pipeline/bin/pipeline.mjs';
const LINES = [
  `node ${BIN} round codex --pr 12 --round 1`,
  `node ${BIN} round codex --pr 12 --round 3 --base abc1234 --head def5678 --max-minutes 90`,
  `node ${BIN} round codex --pr 12 --round 2 --head $(git rev-parse HEAD)`,
  `node ${BIN} round publish --pr 12 --round 2`,
  `node ${BIN} job wait codex-r2 --run-id 5b0f2c1e --until-done --max-minutes 90`,
  `node ${BIN} job read codex-r2 --full`,
];

test('guard-files allows the round codex / round publish lines and the new job flags', () => {
  const fs = fakeFs(PROJ, { [CLI]: REAL_CLI }, ['sub', '/home/u', '/home/u/.claude']);
  for (const c of LINES) {
    const decision = evaluateBashForFiles(c, { home: '/home/u', env: { HOME: '/home/u', ZDOTDIR: '/home/u' }, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists }).decision;
    assert.equal(decision, 'allow', c);
  }
});

test('guard-git allows the same lines', () => {
  for (const c of LINES) {
    const r = evaluateGitCommand(c, { cwd: '/work/repo', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs('/work/repo', {}, ['/home/u']) });
    assert.equal(r.decision, 'allow', c);
  }
});
