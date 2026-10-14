// Why (review round 3 of the SQL-client scanner): R3-B1 a quoted sqlite pipe target (`.output "|cmd"`) is a command, not a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { sqlShellEscapes } from '../pipeline/hooks/lib/sql-clients.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const git = (command, fsOpts) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts,
});
const files = (command, fsOpts) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists,
});
const BAD = 'git push origin main';
// (`@@` in the text is the guarded command: a git push for the git policy, a write to a protected file for the files policy)
const BAD_WRITE = 'echo x > /home/u/.claude/settings.json';
const verdicts = (command, text) => ({
  git: git(command, fakeFs(GIT_ROOT, { 'q.sql': text.replaceAll('@@', BAD) }, ['sub', '/home/u'])).decision,
  files: files(command, fakeFs(PROJ, { 'q.sql': text.replaceAll('@@', BAD_WRITE) }, ['sub', '/home/u'])).decision,
});

// ---- R3-B1 -----------------------------------------------------------------------------------------------------------------------

test('R3-B1: a quoted sqlite .output / .once / .read pipe target is a command, like the unquoted one', () => {
  const texts = [
    '.output |@@', '.output "|@@"', ".output '|@@'",
    '.once |@@', '.once "|@@"', ".once '|@@'",
    '.read "|@@"', ".read '|@@'",
  ];
  for (const text of texts) {
    assert.ok(sqlShellEscapes(text.replaceAll('@@', BAD), { family: 'sqlite' }).some((l) => l.includes(BAD) && !l.startsWith(': >')), `escapes of ${text}`);
    assert.deepEqual(verdicts('sqlite3 < q.sql', text), { git: 'deny', files: 'deny' }, text);
  }
});

test('R3-B1 twins: a quoted harmless pipe command is allowed; a quoted plain file target stays a file write', () => {
  for (const text of ['.output "|git status"', ".once '|git status'", '.output |git status']) {
    assert.deepEqual(verdicts('sqlite3 < q.sql', text), { git: 'allow', files: 'allow' }, text);
  }
  assert.deepEqual(sqlShellEscapes('.output "out.txt"', { family: 'sqlite' }), [': > out.txt']);
  assert.deepEqual(sqlShellEscapes(".once 'out.txt'", { family: 'sqlite' }), [': > out.txt']);
  assert.deepEqual(sqlShellEscapes('.output stdout', { family: 'sqlite' }), []);
});
