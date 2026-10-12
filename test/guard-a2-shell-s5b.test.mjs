// Why (PR A2, batch S5b): the S5a replay still refused real workflows (Next.js route directories as cd targets, relative SQL files after a `cd X && ...; psql -f q.sql`,
// zsh script-dir sources). Each test pins the workflow that must pass next to its nearest dangerous twin that must stay refused. Fake file system like
// guard-a2-shell-s5a.test.mjs; guarded text only lives in fake file contents or command strings.
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
const DIRS = ['bin', 'sub', '/home/u', '/tmp'];


// ---- 1: a cd into a Next.js route directory ---------------------------------------------------------------------------------------------------------------------

// Why: `cd "src/app/(staff)/[id]"` names a directory whose path has parentheses and brackets; the guard read them as run-time syntax and made the directory unknown, so the next relative write
// was judged in every protected directory. The target is resolved against the real directory listing (each segment read as the literal name and as a shell pattern, with the dot rule): exactly one
// existing directory -> that is the cwd.
const ROUTES = [`${PROJ}/src/app/(staff)/[id]`, `${PROJ}/app/[id]/print`, `${PROJ}/src/app/(staff)/staff/(dashboard)/visits/[id]`, `${PROJ}/src/app/(staff)/x`, `${PROJ}/sibling`, `${PROJ}/link`, `${PROJ}/SIBLING-X`, `${PROJ}/.hidden`];
// (the fake listing only knows the directories it is given: every parent is listed too)
const withParents = (ds) => [...new Set(ds.flatMap((d) => { const out = []; for (let x = d; x !== '/'; x = x.slice(0, x.lastIndexOf('/')) || '/') out.push(x); return out; }))];
const routeFs = (extra = []) => fakeFs(GIT_ROOT, {}, withParents([...DIRS, PROJ, ...ROUTES, ...extra]));
test('S5b: a cd into a route directory with (group) and [id] parts is that directory (it exists)', () => {
  const fs = routeFs();
  const cds = ['cd "src/app/(staff)/[id]"', 'cd /home/u/proj/app/\\[id\\]/print', 'cd "/home/u/proj/src/app/(staff)/staff/(dashboard)/visits/[id]"', 'cd src/app/\\(staff\\)/x', 'cd /home/u/pro[j]/sib[l]ing'];
  for (const cd of cds) {
    for (const rest of ['echo x > notes.txt', 'touch notes.txt', 'node -e \'require("fs").writeFileSync("a.ts", "x")\'', 'git add -A']) assert.equal(files(`${cd} && ${rest}`, fs).decision, 'allow', `${cd} && ${rest}`);
  }
});

test('S5b: a glob cd that is not exactly one existing directory stays unknown (the relative write is judged in every protected directory)', () => {
  const fs = routeFs(['/home/u/pxroj', '/home/u/other', '/home/u/.claude', '/home/u/.claude/plugins', '/home/u/.claude/pipeline', '/home/u/proj/a', '/home/u/proj/b']);
  const cds = [
    'cd /home/u/.c*', // (matches .claude, a protected directory)
    'cd /home/u/*', 'cd /home/u/proj/*', 'cd /home/u/proj/sib*', // (several directories; the case-insensitive reading also matches SIBLING-X)
    'cd "/home/u/(proj|.claude)"', 'cd /home/u/.claud[e]', 'cd "/home/u/[.]claude"', 'cd "/home/u/[!x]laude"', // (a class or group that matches a dot name: .claude is protected / several)
    'cd "/home/u/[[:punct:]]claude"', 'cd "/home/u/[.claude"', 'cd "/home/u/((proj))"', 'cd /home/u/pro*\\(/\\)', 'cd /home/u/@(proj|other)', // (not modelled: POSIX class, unbalanced, nested, a zsh qualifier, an extended pattern)
    'cd "/home/u/p?(r)oj"', 'cd "/home/u/+(proj|other)"', 'cd "/home/u/!(proj)"', // (ksh extended patterns: `?(r)` would otherwise be read as `?` followed by a group)
    'cd /home/u/**', 'cd /home/u/{proj,.claude}', 'cd /home/u/pro[j]x', 'cd /home/u/zz*', // (a brace list, no match at all)
  ];
  for (const cd of cds) assert.equal(files(`${cd} && touch notes.txt`, fs).decision, 'deny', cd);
  // (a unique match inside a protected directory is that directory, and the write there is refused)
  assert.equal(files('cd /home/u/.claude/pipe* && touch notes.txt', fs).decision, 'deny', 'pipe*');
  assert.equal(files('cd /home/u/.claude/plug* && touch notes.txt', fs).decision, 'allow', 'plug* (a directory that is not protected)');
  // (a link into a protected directory is that directory)
  const viaLink = files('cd /home/u/proj/lin[k] && touch notes.txt', fs, { realpath: (q) => q.replace('/home/u/proj/link', '/home/u/.claude/pipeline') });
  assert.equal(viaLink.decision, 'deny', 'link');
  assert.equal(files('cd /home/u/proj/lin[k] && touch notes.txt', fs).decision, 'allow', 'link to nothing protected');
  // (the cwd is the real directory, so `..` after the link is the real parent)
  const mapLink = { realpath: (q) => q.replace('/home/u/proj/link', '/home/u/.claude/plugins') }; // (a link into a directory that is not protected itself, next to one that is)
  assert.equal(files('cd /home/u/proj/lin[k] && echo x > ../pipeline/g.mjs', fs, mapLink).decision, 'deny', 'climb out of a link');
  // (the resolved directory sits at the depth the path says, so a climb out of it lands where the path says)
  assert.equal(files('cd "src/app/(staff)/[id]" && echo x > ../../../../../.claude/settings.json', fs).decision, 'deny', 'cd "src/app/(staff)/[id]" && echo x > ../../../../../.claude/settings.json');
  assert.equal(files('cd "src/app/(staff)/[id]" && echo x > ../../../../notes.txt', fs).decision, 'allow', 'cd "src/app/(staff)/[id]" && echo x > ../../../../notes.txt');
  // (an option command before the cd is a command that is not read-only: unknown)
  for (const pre of ['shopt -s dotglob nocaseglob; ', 'setopt globdots; ', 'set -o noglob; ', 'emulate zsh; ']) assert.equal(files(`${pre}cd "src/app/(staff)/[id]" && touch notes.txt`, fs).decision, 'deny', pre);
  // (only the widest reading (dotglob) finds .hidden; by default nothing matches, and with nullglob that cd goes home: the two readings must agree)
  assert.equal(files('cd /home/u/proj/*idden && touch notes.txt', fs).decision, 'deny', 'dotglob-only match');
  assert.equal(files('cd /home/u/proj/.hid* && touch notes.txt', fs).decision, 'allow', 'a literal dot matches the dot name in both readings');
  // (the listing is the one now: anything before the cd that may change it makes the directory unknown)
  for (const pre of ['mkdir -p src/app/new; ', 'rm -rf src/app/old; ', 'mv a b; ', 'ln -s /home/u/.claude src/app/link; ', 'cp -r a b; ', 'tar xf a.tar; ', 'git checkout x; ', 'echo x > f; ', 'source ./e.sh; ', 'BASH_ENV=e.sh true; ', 'npm install; ']) assert.equal(files(`${pre}cd "src/app/(staff)/[id]" && touch notes.txt`, fs).decision, 'deny', pre);
  for (const pre of ['ls src; ', 'echo hi; ', 'export A=1; ', 'cd src; ', 'git status; ']) assert.equal(files(`${pre}cd "/home/u/proj/src/app/(staff)/[id]" && touch notes.txt`, fs).decision, 'allow', pre);
  // (the directory does not exist: unknown)
  assert.equal(files('cd "src/app/(staff)/[gone]" && touch notes.txt', fs).decision, 'deny', 'cd "src/app/(staff)/[gone]" && touch notes.txt');
});

// Why: the listing is read as it is now; what the calling line wrote before it ran a script (a file or directory it made) may change what a glob matches there.
test('S5b: in a script run by the line, a glob cd is known only when the calling line has written nothing before it', () => {
  const fs = fakeFs(GIT_ROOT, { 'run.sh': 'cd "/home/u/proj/src/app/(staff)/[id]" && touch notes.txt\n' }, withParents([...DIRS, PROJ, ...ROUTES]));
  assert.equal(files('bash /work/repo/run.sh', fs).decision, 'allow', 'baseline');
  for (const pre of ['mkdir -p /home/u/proj/src/app/new; ', 'echo x > /tmp/f; ', 'cp a b; ']) assert.equal(files(`${pre}bash /work/repo/run.sh`, fs).decision, 'deny', pre);
});
