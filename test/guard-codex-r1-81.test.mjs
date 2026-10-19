// Why (issue #81, Codex round 1 on the script-readings change): two real bypasses, fixed fail-closed.
//   R1-B1. Inside a script the guard opened, the names a line's `${X:=w}` / operator expansions (`${F/ok/run}`) / arrays may hold were looked up only in the OUTER line. So
//          `bash wrapper.sh` with wrapper.sh = `for n in 1 2; do F=ok.sh; G=${F/ok/run}; bash $G; done` was allowed although run.sh pushes to main (the same text typed on the line
//          is refused). The dynamic-script fallback ("the line mentions a guarded operation") also read only the outer line. Both now look at the text of the script being judged
//          (and of every script above it).
//   R1-B2. The files guard dropped the `over` flag of readingsOf (truncated at MAX_READINGS): `A=(x0 … .cl); B=(y0 … aude); echo x > ~/${A[7]}${B[7]}/settings.json` was allowed.
//          Too many readings is a hit.
// The file system is faked; guarded text only lives in fake file contents or is split in this source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u', ...dirs.map(abs)].map((p) => resolve(p)));
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
const PUSH = 'pu' + 'sh';
const BAD_GIT = `git ${PUSH} origin main`;
const BAD_FILES = 'echo x > ~/.cl' + 'aude/settings.json';
const git = (command, files) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, files, ['scripts']),
});
const filesGuard = (command, files = {}) => {
  const fs = fakeFs(PROJ, files, ['scripts']);
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists });
};
const gitFiles = (bad) => ({ 'ok.sh': 'git status', 'ok2.sh': 'git status', 'run.sh': bad });
const allowGit = (command, files) => assert.equal(git(command, files).decision, 'allow', `git: ${command} -> ${git(command, files).reason}`);
const denyGit = (command, files) => assert.equal(git(command, files).decision, 'deny', `git: ${command} -> allowed`);

// ---- R1-B1 ----------------------------------------------------------------------------------------------------------------------

const WRAPPERS = [
  'for n in 1 2; do F=ok.sh; G=${F/ok/NAME}; bash $G; done\n', // Codex's repro
  'F=ok.sh; G=${F/ok/NAME}; bash $G\n', // (no loop)
  'F=ok.sh\nG=${F/ok/NAME}\nbash $G\n',
  'F=NAME.sh; G=${F%.sh}; bash $G.sh\n',
  'A=(ok NAME); bash ${A[1]}.sh\n', // (an array)
  ': ${X:=NAME.sh}; bash $X\n', // (an assigning default)
];

test('R1-B1: names a script assigns are read from the script itself, not only from the line that ran it', () => {
  for (const w of WRAPPERS.slice(0, 3).concat(WRAPPERS[4], WRAPPERS[5])) {
    const bad = w.replaceAll('NAME', 'run');
    denyGit('bash wrapper.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': bad });
    denyGit('./wrapper.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': bad });
    denyGit('for g in 1 2; do bash wrapper.sh; done', { ...gitFiles(BAD_GIT), 'wrapper.sh': bad });
    // two levels down
    denyGit('bash outer.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': bad, 'outer.sh': 'bash wrapper.sh\n' });
    // the same shape written by the line itself
    denyGit(`cat > w.sh <<'EOF'\n${bad}EOF\nbash w.sh`, gitFiles(BAD_GIT));
  }
  // the exact repro, spelled as Codex gave it
  denyGit('bash wrapper.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': 'for n in 1 2; do F=ok.sh; G=${F/ok/run}; bash $G; done\n' });
});

test('R1-B1 siblings: the same shapes over harmless scripts stay allowed', () => {
  for (const w of WRAPPERS) {
    const ok = w.replaceAll('NAME', 'ok2');
    allowGit('bash wrapper.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': ok });
    allowGit('./wrapper.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': ok });
    allowGit('for g in 1 2; do bash wrapper.sh; done', { ...gitFiles(BAD_GIT), 'wrapper.sh': ok });
  }
  allowGit('bash wrapper.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': 'for n in 1 2; do F=ok.sh; G=${F/ok/ok2}; bash $G; done\n' });
  // run.sh exists and is bad, but nothing reaches it
  allowGit('bash outer.sh', { ...gitFiles(BAD_GIT), 'wrapper.sh': 'F=ok.sh; G=${F/ok/ok2}; bash $G\n', 'outer.sh': 'bash wrapper.sh\n' });
});

test('R1-B1: a script that runs a name only known at run time is refused when the script itself mentions a guarded operation', () => {
  // (the same text typed on the line is refused; the line `bash s.sh` does not mention the operation, the script does)
  denyGit(`echo ${PUSH}; bash $G`, gitFiles(BAD_GIT));
  denyGit('bash s.sh', { ...gitFiles(BAD_GIT), 's.sh': `# ${PUSH} nothing\nbash $G\n` });
  denyGit('bash outer.sh', { ...gitFiles(BAD_GIT), 'outer.sh': 'bash s.sh\n', 's.sh': `# ${PUSH} nothing\nbash $G\n` });
  // no guarded word anywhere: the known limit stays as it was
  allowGit('bash s.sh', { ...gitFiles(BAD_GIT), 's.sh': 'bash $G\n' });
  // a guarded word without a run-time name is no reason
  allowGit('bash s.sh', { ...gitFiles(BAD_GIT), 's.sh': `# ${PUSH} nothing\nbash ok.sh\n` });
});

test('R1-B1 files guard: a script opened by the files guard reads its own assignments too', () => {
  const files = (w) => ({ 'ok.sh': 'echo hi', 'ok2.sh': 'echo hi', 'run.sh': BAD_FILES, 'wrapper.sh': w });
  for (const w of WRAPPERS.slice(0, 3).concat(WRAPPERS[4], WRAPPERS[5])) {
    assert.equal(filesGuard('bash wrapper.sh', files(w.replaceAll('NAME', 'run'))).decision, 'deny', `files: ${w}`);
  }
  for (const w of WRAPPERS) assert.equal(filesGuard('bash wrapper.sh', files(w.replaceAll('NAME', 'ok2'))).decision, 'allow', `files sibling: ${w}`);
});

// ---- R1-B2 ----------------------------------------------------------------------------------------------------------------------

test('R1-B2: too many readings of a path word is a hit (the files guard)', () => {
  const A = (last) => `A=(x0 x1 x2 x3 x4 x5 x6 ${last})`;
  const B = (last) => `B=(y0 y1 y2 y3 y4 y5 y6 ${last})`;
  const repro = `${A('.cl')}; ${B('aude')}; echo x > ~/\${A[7]}\${B[7]}/settings.json`;
  assert.equal(filesGuard(repro).decision, 'deny');
  // the target in the middle of the word, and as an argument of a writer
  assert.equal(filesGuard(`${A('.cl')}; ${B('aude')}; cp f ~/\${A[7]}\${B[7]}/settings.json`).decision, 'deny');
  assert.equal(filesGuard(`${A('.cl')}; ${B('aude')}; tee ~/\${A[7]}\${B[7]}/settings.json < f`).decision, 'deny');
  // harmless siblings: a small array that is fully expanded and harmless, and a big one that names nothing protected
  assert.equal(filesGuard('A=(x0 x1); B=(y0 y1); echo x > ~/${A[0]}${B[0]}/notes.txt').decision, 'allow');
  assert.equal(filesGuard('A=(a b); B=(c d); echo x > ./${A[0]}${B[0]}/notes.txt').decision, 'allow');
  // operator expansions written in the word (`${A[7]/zz/}`) multiply the same way
  assert.equal(filesGuard(`${A('.cl')}; ${B('aude')}; echo x > ~/\${A[7]/zz/}\${B[7]/zz/}/settings.json`).decision, 'deny');
  assert.equal(filesGuard('A=(a b); B=(c d); echo x > ~/${A[0]/zz/}${B[0]/zz/}/notes.txt').decision, 'allow');
  // and the small array whose readings do reach a protected path is refused, as before
  assert.equal(filesGuard('A=(x .cl); B=(y aude); echo x > ~/${A[1]}${B[1]}/settings.json').decision, 'deny');
});

test('R1-B2: the same overflow inside a script the files guard opens', () => {
  const A = 'A=(x0 x1 x2 x3 x4 x5 x6 .cl)';
  const B = 'B=(y0 y1 y2 y3 y4 y5 y6 aude)';
  const body = `${A}; ${B}; echo x > ~/\${A[7]}\${B[7]}/settings.json\n`;
  assert.equal(filesGuard('bash s.sh', { 's.sh': body }).decision, 'deny');
  assert.equal(filesGuard('bash s.sh', { 's.sh': 'A=(a b); B=(c d); echo x > ~/${A[0]}${B[0]}/notes.txt\n' }).decision, 'allow');
});
