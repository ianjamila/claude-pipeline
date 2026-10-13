// Why (PR A2, final security batch F1): variable state, sourced files, psql escapes and the `${BASH:-bash}` rewrite. Each test pins a bypass next to
// its nearest harmless twin. Fake file system like guard-a2-shell-s5d.test.mjs; guarded text only lives in fake file contents or command strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

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
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const BAD_GIT = 'git push origin main';
const BAD_WRITE = 'echo x > /home/u/.claude/settings.json';
const DIRS = ['sub', '/home/u'];
// `spec`: name -> 'bad' | 'ok' | text, written into both fake file systems (git: under /work/repo, files: under /home/u/proj)
function both(command, spec = {}, o = {}) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : typeof v === 'function' ? v(bad, ok) : v]));
  return {
    git: git(command, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), DIRS), o),
    files: files(command, fakeFs(PROJ, mk(BAD_WRITE, 'echo hi'), DIRS), o),
  };
}
const allowBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'allow', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${command} -> ${r.files.reason}`);
};
const denyBoth = (command, spec, o) => {
  const r = both(command, spec, o);
  assert.equal(r.git.decision, 'deny', `git: ${command} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'deny', `files: ${command} -> ${r.files.reason}`);
};
const filesOnly = (cmds, expect, spec = { 'ok.sh': 'echo ok' }) => {
  const fs = fakeFs(PROJ, spec, DIRS);
  for (const c of cmds) assert.equal(files(c, fs).decision, expect, c);
};

// ---- 57: a later plain assignment must not clean an earlier use -------------------------------------------------------------------

test('F1/57: a name a sourced file may have changed stays unknown for the commands before a later plain reassignment (files)', () => {
  filesOnly([
    'D=/tmp; source $X; echo y > $D/settings.json; D=/tmp', 'D=/tmp; source $X; cp ok.sh $D/settings.json; D=/tmp', 'D=/tmp; source $X; echo y > $D/settings.json; D=/tmp; echo done',
    'source $X; echo y > $D/settings.json; D=/tmp', 'D=/tmp; source $X; E=$D; echo y > $E/settings.json; D=/tmp',
    // (a cd target built from the name: the cwd is unknown for the rest of the line)
    'D=/tmp; source $X; cd $D; echo y > settings.json; D=/tmp',
  ], 'deny');
  // twins: the reassignment comes first, or nothing changed the name
  filesOnly([
    'D=/tmp; source $X; D=/tmp; echo y > $D/settings.json', 'D=/tmp; source $X; D=/tmp; cp ok.sh $D/a.txt; D=/tmp', 'D=/tmp; echo y > $D/a.txt; D=/tmp', 'D=/tmp; source $X; echo $D; D=/tmp',
  ], 'allow');
});

// ---- 81: a sourced file the line writes first is what the writes put there ----------------------------------------------------------

test('F1/81: a file the line writes and then sources is modelled from what is written, with the disk text as another case (files)', () => {
  const spec = { 'rc': 'D=/tmp', 'ok.sh': 'echo ok' };
  filesOnly([
    // (the disk file sets a harmless D; what the line writes sets the protected one)
    "echo 'D=/home/u/.claude' > rc; . ./rc; echo x > $D/settings.json", "echo 'D=/home/u/.claude' > rc; source rc; cp ok.sh $D/settings.json", "printf 'D=/home/u/.claude\\n' > rc; . ./rc; echo x > $D/settings.json",
    // (a write the guard cannot read: unknown content)
    'echo "D=$(pick)" > rc; . ./rc; echo x > $D/settings.json',
  ], 'deny', spec);
  // a missing file the line writes is modelled too, instead of poisoning every name
  filesOnly([
    "echo 'D=/home/u/.claude' > new.rc; . ./new.rc; echo x > $D/settings.json",
  ], 'deny', { 'ok.sh': 'echo ok' });
  filesOnly([
    "echo 'D=/tmp/x' > new.rc; . ./new.rc; echo x > $D/a.txt", "echo 'D=/tmp/x' > rc; . ./rc; echo x > $D/a.txt",
  ], 'allow', { 'ok.sh': 'echo ok' });
});
