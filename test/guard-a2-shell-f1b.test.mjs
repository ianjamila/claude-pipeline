// Why (PR A2, batch F1b): "${BASH:-bash}" is read as bash only while nothing can bind BASH. That was decided from the top-level text of one parse; a script, a startup file
// (BASH_ENV / ENV), a file the line wrote, a heredoc body or a nested frame is parsed on its own, so a binding there did not reach the frame that rewrote the word (and the name
// spelled across a line continuation was not seen at all). The observable: with the word rewritten the head is `bash` (the line is judged as plain bash); with a name that may be
// bound it stays a run-time head, so a line that also mentions a guarded operation is refused. Guarded text is built from pieces / lives in fake file contents only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { MAX_SCRIPT_JUDGMENTS, EVAL_DEADLINE_MS } from '../pipeline/hooks/lib/script-candidates.mjs';

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
const git = (command, files, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, files, ['/home/u']), ...o,
});
const GUARDED = 'gi' + 't pu' + 'sh orig' + 'in ma' + 'in';
const MENTION = `echo "${GUARDED}"\n`; // prose only: refused solely when the line also has a head only known at run time
const DYN = '${BASH:-bash}';
const T = `${MENTION}"${DYN}" h.sh\n`;
const OK_FILES = { 'h.sh': 'echo hi' };

test('F1b 1: control: the default word is bash in a plain script (the mention alone is not refused)', () => {
  assert.equal(git('bash t.sh', { ...OK_FILES, 't.sh': T }).decision, 'allow');
});

test('F1b 1: a binding in another frame (startup file, exported name, file the line writes, heredoc body fed to the script) keeps the word a run-time head', () => {
  const cases = [
    ['BASH_ENV=rc bash t.sh', { rc: 'BASH=zsh' }],
    ['ENV=rc sh t.sh', { rc: 'BASH=zsh' }],
    ['export BASH=zsh; bash t.sh', {}],
    ['echo BASH=zsh > rc; BASH_ENV=rc bash t.sh', {}],
    ['bash t.sh <<EOF\nBASH=zsh\nEOF', {}],
    ['bash -c "source rc" ; bash t.sh', { rc: 'BASH=zsh' }],
  ];
  for (const [cmd, extra] of cases) {
    const d = git(cmd, { ...OK_FILES, ...extra, 't.sh': T });
    assert.equal(d.decision, 'deny', `${cmd} -> ${d.reason}`);
  }
});

test('F1b 1: a nested frame that binds the name does not leave the outer frame "plain" (the outer word stays a run-time head)', () => {
  const d = git(`${MENTION}bash b.sh; "${DYN}" h.sh`, { ...OK_FILES, 'b.sh': 'BASH=zsh' });
  assert.equal(d.decision, 'deny', d.reason);
  const calm = git(`${MENTION}bash b.sh; "${DYN}" h.sh`, { ...OK_FILES, 'b.sh': 'echo hi' });
  assert.equal(calm.decision, 'allow', calm.reason);
});

test('F1b 1: a name spelled across a line continuation is still BASH', () => {
  const heads = (t) => simpleCommands(t, { env: {} }).filter((c) => c.argv.includes('h.sh')).map((c) => c.argv[0]);
  assert.deepEqual(heads(`"${DYN}" h.sh`), ['bash']);
  for (const bind of ['BA\\\nSH=zsh', 'B\\\nASH=zsh', 'declare BA\\\nSH=zsh', 'read BA\\\nSH', 'export B\\\r\nASH=x']) {
    const h = heads(`${bind}\n"${DYN}" h.sh`);
    assert.ok(h.includes(DYN), `${JSON.stringify(bind)} -> ${JSON.stringify(h)}`);
  }
  const d = git('bash t.sh', { ...OK_FILES, 't.sh': `BA\\\nSH=zsh\n${T}` });
  assert.equal(d.decision, 'deny', d.reason);
});

// ---- 87 / 88: names a sourced file or a script binds without a command named for it ------------------------------------------------------------------------

const PROJ = '/home/u/proj';
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const BAD_WRITE = 'echo x > /home/u/.claude/settings.json';
const DIRS = ['bin', 'sub', '/home/u', '/tmp'];

// Why: what a sourced file leaves behind was a denylist of binder commands (read, mapfile, ...). zsh has more (print -v, vared, zparseopts, strftime -s, zstyle, sysread, zstat -A, getln), an
// assigning expansion or a named descriptor binds without any command, and a function the file defines may call any of them: a command outside the allowlist makes every name unknown.
test('F1b 87: a sourced file whose command may bind a name (zsh binders, functions, assigning expansions, named descriptors) makes the script a later word picks refused', () => {
  const binders = ['print -v F evil.sh', 'vared F', 'zparseopts -D -E -A F', 'strftime -s F %Y 0', 'zstyle -s :a b F', 'sysread F', 'zstat -A F /tmp', 'getln F', 'myfn', 'set -A F evil.sh',
    ': ${F::=evil.sh}', ': ${(e)F::=evil.sh}', ': ${F=evil.sh}', 'ls {F}>/dev/null', 'exec {F}>/dev/null', 'F[1]=x', '(( F = 1 ))', ': $(( F = 1 ))', 'unknowncmd arg'];
  for (const b of binders) {
    const fs = fakeFs(PROJ, { 'set.sh': `${b}\n`, 'evil.sh': BAD_WRITE, 'ok.sh': 'echo ok' }, DIRS);
    assert.equal(files('F=ok.sh; source set.sh; bash $F', fs).decision, 'deny', b);
  }
  // (data commands, name setters and cds the file does stay modelled)
  for (const calm of ['echo hi', 'set -eu', 'export G=1', 'G=2', 'print -r -- hi', 'printf "%s" x', 'cd sub', 'ls >/dev/null; test -d sub', 'print $F']) {
    const fs = fakeFs(PROJ, { 'set.sh': `${calm}\n`, 'evil.sh': BAD_WRITE, 'ok.sh': 'echo ok' }, DIRS);
    assert.equal(files('F=ok.sh; source set.sh; bash $F', fs).decision, 'allow', calm);
  }
});

// Why: `ls {HERE}>/dev/null` (bash / zsh named descriptors) sets HERE to a descriptor number without a binder command, so a directory name built from it is not the script directory any more.
test('F1b 88: a named descriptor redirection rebinds the script-directory name; a regex looking only at one spelling of it is not enough', () => {
  const CC = '/home/u/cc';
  const ccFs = (pre) => fakeFs(CC, { 'scripts/restart.sh': `#!/bin/zsh\nHERE=/home/u/cc/scripts\n${pre}\ncd "\${HERE:h}"\necho x > settings.json\n` }, [...DIRS, CC, `${CC}/scripts`]);
  for (const pre of ['ls {HERE}>/dev/null', 'ls {HERE}</dev/null', 'ls {HERE}>>/dev/null', 'ls {HERE} >/dev/null', 'ls {HERE}>&2', 'cat <&0 {HERE}</dev/null', 'HERE+=x', 'ls >/dev/null {HERE}>/dev/null']) {
    assert.equal(files(`${CC}/scripts/restart.sh`, ccFs(pre)).decision, 'deny', pre);
  }
  assert.equal(files(`${CC}/scripts/restart.sh`, ccFs('ls {OTHER}>/dev/null; ls >/dev/null')).decision, 'allow');
});

// ---- the second pass of a stale line spends what the first one left ------------------------------------------------------------------------------------------

// main.sh runs n scripts; the first through "${BASH:-bash}" (rewritten), the last one binds BASH (judged after the rewrite, so the verdict is stale and the line is judged again)
const staleTree = (n, lastBinds) => ({
  'main.sh': Array.from({ length: n }, (_, i) => (i === 0 ? `"${DYN}" s0.sh` : `bash s${i}.sh`)).join('\n'),
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}.sh`, i === n - 1 && lastBinds ? 'BASH=zsh' : 'echo hi'])),
});
const PROJ_FILES = '/home/u/proj';
const runners = [
  ['guard-git', (f, o) => evaluateGitCommand('bash main.sh', { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...f, ...o }), (f) => fakeFs(GIT_ROOT, f)],
  ['guard-files', (f, o) => evaluateBashForFiles('bash main.sh', { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ_FILES, ...f, existsSync: f.pathExists, ...o }), (f) => fakeFs(PROJ_FILES, f)],
];
for (const [name, run, mk] of runners) {
  test(`F1b ${name}: a stale line judged again keeps its script budget (a rerun cannot double the number of script reads)`, () => {
    const n = Math.floor(MAX_SCRIPT_JUDGMENTS * 0.6);
    assert.equal(run(mk(staleTree(n, false))).decision, 'allow'); // one pass fits
    const small = run(mk(staleTree(3, true)));
    assert.equal(small.decision, 'allow', small.reason); // a stale line well inside the budget is still allowed
    const r = run(mk(staleTree(n, true)));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too many script files/);
  });

  test(`F1b ${name}: a stale line judged again keeps its deadline (the clock is not restarted for the second pass)`, () => {
    let t = 1_000_000;
    const slow = (f) => { const inner = mk(f); return { ...inner, readText: (p) => { t += Math.floor(EVAL_DEADLINE_MS * 0.15); return inner.readText(p); } }; };
    t = 1_000_000;
    assert.equal(run(slow(staleTree(3, false)), { now: () => t }).decision, 'allow');
    t = 1_000_000;
    const r = run(slow(staleTree(3, true)), { now: () => t });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long/);
  });
}
