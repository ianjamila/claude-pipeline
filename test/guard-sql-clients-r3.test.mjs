// Why (review round 3 of the SQL-client scanner): R3-B1 a quoted sqlite pipe target (`.output "|cmd"`) is a command, not a file; R3-B2 psql interpolation
// marks the WHOLE input unknown once (it was once per line: quadratic output) and the scan honours the evaluation deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { sqlShellEscapes } from '../pipeline/hooks/lib/sql-clients.mjs';
import { newEvalBudget, GuardLimit } from '../pipeline/hooks/lib/script-candidates.mjs';

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

// ---- R4-B1 -----------------------------------------------------------------------------------------------------------------------
// sqlite decodes C escapes in a DOUBLE-quoted dot-command argument (\a \b \t \n \v \f \r \" \' \\, octal \NNN, \xHH) and nothing in a single-quoted one

// (the text as a function of the guarded command, so the git policy and the files policy each judge their own)
const verdictsOf = (command, mk) => ({
  git: git(command, fakeFs(GIT_ROOT, { 'q.sql': mk(BAD) }, ['sub', '/home/u'])).decision,
  files: files(command, fakeFs(PROJ, { 'q.sql': mk(BAD_WRITE) }, ['sub', '/home/u'])).decision,
});
const hexAll = (s) => [...s].map((c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const octAll = (s) => [...s].map((c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')).join('');

test('R4-B1: an escaped double quote inside a double-quoted pipe command is decoded before the command is judged', () => {
  const quoted = (cmd) => cmd.replace('push', String.raw`\"push\"`);
  for (const dot of ['.output', '.once', '.read']) {
    assert.deepEqual(verdictsOf('sqlite3 < q.sql', (c) => `${dot} "|${quoted(c)}"`), { git: 'deny', files: 'deny' }, dot);
    assert.ok(sqlShellEscapes(`${dot} "|${quoted(BAD)}"`, { family: 'sqlite' }).includes('git "push" origin main'), `escapes of ${dot}`);
  }
  // the protected-file write, its path quoted the same way
  assert.deepEqual(verdictsOf('sqlite3 < q.sql', (c) => `.output "|${c.replace('/home/u/.claude/settings.json', String.raw`\"/home/u/.claude/settings.json\"`)}"`).files, 'deny');
});

test('R4-B1: octal and hex escapes in a double-quoted pipe command are decoded', () => {
  for (const dot of ['.output', '.once', '.read']) {
    assert.deepEqual(verdictsOf('sqlite3 < q.sql', (c) => `${dot} "|${c.replace('push', String.raw`\160ush`)}"`), { git: 'deny', files: 'deny' }, `${dot} octal`);
    assert.deepEqual(verdictsOf('sqlite3 < q.sql', (c) => `${dot} "|${c.replace('push', String.raw`\x70ush`)}"`), { git: 'deny', files: 'deny' }, `${dot} hex`);
    assert.deepEqual(verdictsOf('sqlite3 < q.sql', (c) => `${dot} "|${hexAll(c)}"`), { git: 'deny', files: 'deny' }, `${dot} all hex`);
    assert.deepEqual(verdictsOf('sqlite3 < q.sql', (c) => `${dot} "|${octAll(c)}"`), { git: 'deny', files: 'deny' }, `${dot} all octal`);
  }
  assert.ok(sqlShellEscapes(String.raw`.output "|git \160ush origin main"`, { family: 'sqlite' }).includes(BAD));
  // (a short octal escape: one or two digits, the next character is not part of it)
  assert.ok(sqlShellEscapes(String.raw`.output "|echo \1x"`, { family: 'sqlite' }).some((l) => l.includes('\x01x')));
});

test('R4-B1: what cannot be modelled exactly (NUL, a byte past ASCII, an unknown escape) leaves an unknown line, not a guess', () => {
  for (const text of [String.raw`.output "|git \0 push origin main"`, String.raw`.output "|git \x00push"`, String.raw`.once "|git \377push"`, String.raw`.read "|git \xffpush"`, String.raw`.output "|git \qpush"`]) {
    const out = sqlShellEscapes(text, { family: 'sqlite' });
    assert.ok(out.some((l) => l.startsWith('$SQL_UNKNOWN_SHELL_LINE_')), `unknown line for ${text}`);
  }
});

test('R4-B1: a single-quoted dot-command argument is literal, a backslash in it is just a character', () => {
  assert.deepEqual(sqlShellEscapes(String.raw`.output 'a\b.txt'`, { family: 'sqlite' }), [": > 'a\\b.txt'"]);
  // (`\'` does not escape the quote: the argument is `a\`, and `.txt'` after it is not part of the target)
  assert.deepEqual(sqlShellEscapes(String.raw`.once 'a\' ; select 1`, { family: 'sqlite' }), [": > 'a\\'"]);
  // (a double-quoted argument decodes the same text: `\b` is a backspace, so the file name is not the one with a backslash)
  assert.deepEqual(sqlShellEscapes(String.raw`.output "a\\b.txt"`, { family: 'sqlite' }), [": > 'a\\b.txt'"]);
  // an existing harmless case stays allowed
  assert.deepEqual(verdicts('sqlite3 < q.sql', '.output "|git \\"status\\""'), { git: 'allow', files: 'allow' });
  assert.deepEqual(sqlShellEscapes('.output "out.txt"', { family: 'sqlite' }), [': > out.txt']);
});

// ---- R3-B2 -----------------------------------------------------------------------------------------------------------------------

test('R3-B2: an interpolating psql input marks the whole input unknown once, output stays linear in the input', () => {
  const small = sqlShellEscapes('select :x;\nselect 1;', { family: 'psql' });
  assert.equal(small.length, 1, 'one whole-input unknown line');
  const lines = Array.from({ length: 5000 }, (_, i) => `select :x${i};`);
  const text = lines.join('\n');
  const out = sqlShellEscapes(text, { family: 'psql' });
  const size = out.reduce((n, l) => n + l.length, 0);
  assert.ok(size < text.length * 3, `output ${size} chars for ${text.length} input chars`);
  assert.ok(out.length < 10, `${out.length} output lines`);
  // the family-unknown scan (every table) behaves the same
  assert.ok(sqlShellEscapes(text).reduce((n, l) => n + l.length, 0) < text.length * 3);
});

test('R3-B2: the verdict for an interpolating psql file is unchanged (still unknown input, refused next to a guarded word)', () => {
  assert.deepEqual(verdicts('psql < q.sql', 'select :x;\nselect 1;\n\\! @@'), { git: 'deny', files: 'deny' });
  assert.deepEqual(verdicts('psql < q.sql', 'select :x;\nselect 1;'), { git: 'allow', files: 'allow' });
});

test('R3-B2: the scan stops at the evaluation deadline (fail closed with a GuardLimit)', () => {
  let t = 0;
  const budget = newEvalBudget(() => t);
  const text = Array.from({ length: 50 }, (_, i) => `select ${i};`).join('\n');
  assert.doesNotThrow(() => sqlShellEscapes(text, { family: 'psql', budget }));
  t = 10 ** 9; // past the deadline
  assert.throws(() => sqlShellEscapes(text, { family: 'psql', budget }), GuardLimit);
});
