// Why (PR A2, batch F1b): "${BASH:-bash}" is read as bash only while nothing can bind BASH. That was decided from the top-level text of one parse; a script, a startup file
// (BASH_ENV / ENV), a file the line wrote, a heredoc body or a nested frame is parsed on its own, so a binding there did not reach the frame that rewrote the word (and the name
// spelled across a line continuation was not seen at all). The observable: with the word rewritten the head is `bash` (the line is judged as plain bash); with a name that may be
// bound it stays a run-time head, so a line that also mentions a guarded operation is refused. Guarded text is built from pieces / lives in fake file contents only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

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
