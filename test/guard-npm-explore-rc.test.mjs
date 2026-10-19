// Why (#89 t3, closing #85): two ways a package-manager line still ran a program the guards never opened.
//  1. `npm explore PKG -- CMD...` runs CMD through the script shell in node_modules/PKG of the project. `npm explore foo -- bash run.sh` was allowed without opening node_modules/foo/run.sh, and the files
//     guard did not judge the command's own writes. Now CMD is judged like `bash -c CMD` run in that directory; a package name that is not plain (a variable, a glob, `..`, a path) is refused.
//  2. npm reads its global configuration from <globalPrefix>/etc/npmrc, and the global prefix is whatever the user's (or the project's) .npmrc `prefix=` says, --prefix, or the place node itself lives.
//     rcFiles only knew three fixed paths, so `script-shell=` / `node-options=` there ran unseen. Now those files are read too; a prefix the guard cannot work out is refused.
// Guarded names are spelled in pieces (the live guard scans files passed to node tools). `nodePrefix: null` keeps the tests off this machine's own node location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
const BAD_GIT = `git ${PUSH} origin ${MAIN}`;
const BAD_FILES = `cp a ~/${CL}/settings.json`;

function fakeFs(root, files) {
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [resolve(root, k), v]));
  const D = new Set([resolve(root), '/home/u']);
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
  const names = (d) => [...new Set([...Object.keys(F), ...D].filter((p) => p !== d && dirname(p) === d).map((p) => basename(p)))];
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
const git = (command, files, o = {}) => {
  const fs = fakeFs(GIT_ROOT, files);
  return evaluateGitCommand(command, { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, nodePrefix: null, ...fs, ...o });
};
const filesGuard = (command, files, o = {}) => {
  const fs = fakeFs(PROJ, files);
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, nodePrefix: null, ...fs, existsSync: fs.pathExists, ...o });
};
const pj = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { lint: 'echo hi', test: 'echo hi' } });
const denies = (g, why) => assert.equal(g.decision, 'deny', why);
const allows = (g, why) => assert.equal(g.decision, 'allow', `${why}: ${g.reason}`);
// the same tree for both guards: `body` is what the shell script holds
const both = (cmd, tree, o = {}) => ({ git: git(cmd, tree(BAD_GIT), o.git), files: filesGuard(cmd, tree(BAD_FILES), o.files) });
const clean = (cmd, tree, o = {}) => ({ git: git(cmd, tree('echo hi'), o.git), files: filesGuard(cmd, tree('echo hi'), o.files) });

// ---- npm explore ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const exploreTree = (body) => ({ 'package.json': pj, 'node_modules/foo/run.sh': body, 'node_modules/@s/p/run.sh': body, 'node_modules/foo/package.json': '{"name":"foo"}' });

test('t3 npm explore PKG -- CMD opens the script CMD runs in node_modules/PKG (both guards)', () => {
  for (const cmd of ['npm explore foo -- bash run.sh', 'npm explore foo -- sh ./run.sh', 'npm explore foo bash run.sh', 'npm explore @s/p -- bash run.sh', 'npm explore --silent foo -- bash run.sh', 'npm explore foo --silent -- bash run.sh',
    'npm explor foo -- bash run.sh', 'npm explo foo -- bash run.sh', 'npm --silent explore foo -- bash run.sh', 'echo a && npm explore foo -- bash run.sh', 'npm explore -- foo bash run.sh']) {
    const r = both(cmd, exploreTree);
    denies(r.git, `git: ${cmd}`);
    denies(r.files, `files: ${cmd}`);
    const c = clean(cmd, exploreTree);
    allows(c.git, `git clean: ${cmd}`);
    allows(c.files, `files clean: ${cmd}`);
  }
});
test('t3 npm explore PKG -- CMD judges CMD itself like bash -c (a write to a protected path, a direct push)', () => {
  const t = () => ({ 'package.json': pj, 'node_modules/foo/package.json': '{}' });
  denies(filesGuard(`npm explore foo -- ${BAD_FILES}`, t()), 'files: cp to a protected path');
  denies(filesGuard(`npm explore foo -- 'echo x; ${BAD_FILES}'`, t()), 'files: a quoted command list');
  denies(filesGuard(`npm explore foo -- cp a ~/.cl`.concat(`aude/settings.json`), t()), 'files: the path spelled in two parts');
  denies(git(`npm explore foo -- ${BAD_GIT}`, t()), 'git: a direct push');
  allows(filesGuard('npm explore foo -- cp a b', t()), 'files: harmless copy');
  allows(git('npm explore foo -- git status', t()), 'git: harmless command');
  allows(git('npm explore foo', t()), 'git: no command opens an interactive shell');
  allows(filesGuard('npm explore foo', t()), 'files: no command opens an interactive shell');
});
test('t3 npm explore: a package that is not a plain name is unknown, so refused (even with nothing guarded on the line)', () => {
  const t = () => ({ 'package.json': pj });
  for (const cmd of ['npm explore $P -- ls', 'npm explore "$P" -- ls', 'npm explore foo/../../x -- ls', 'npm explore .. -- ls', 'npm explore /abs/path -- ls', 'npm explore ./foo -- ls', 'npm explore f* -- ls', 'npm explore @s/.. -- ls', 
    'npm explore --weird foo -- ls', 'npm explore -g foo -- ls', 'npm -g explore foo -- ls', 'npm explore --global foo -- ls', 'npm explore --location=global foo -- ls']) {
    denies(git(cmd, t()), `git: ${cmd}`);
    denies(filesGuard(cmd, t()), `files: ${cmd}`);
  }
  // a name set earlier on the line is read
  allows(git('P=foo; npm explore $P -- ls', t()), 'git: known name');
  denies(git(`P=foo; npm explore $P -- ${BAD_GIT}`, t()), 'git: known name, guarded command');
  allows(git('npm explore foo -- ls', t()), 'git: plain name');
  allows(git('npm explore @s/p -- ls', t()), 'git: scoped name');
  allows(git('npm explore --silent foo -- ls', t()), 'git: boolean option');
  allows(git('npm explore -- foo ls', t()), 'git: name after --');
});
test('t3 npm explore runs in the project the walk finds (--prefix moves it)', () => {
  const t = (sub, top) => ({ 'package.json': pj, 'sub/package.json': pj, 'sub/node_modules/foo/run.sh': sub, 'node_modules/foo/run.sh': top });
  denies(git('npm explore foo --prefix sub -- bash run.sh', t(BAD_GIT, 'echo top')), 'git: the prefix project holds the bad script');
  allows(git('npm explore foo --prefix sub -- bash run.sh', t('echo sub', BAD_GIT)), 'git: the top project is not the one that runs');
  denies(filesGuard('npm explore foo --prefix sub -- bash run.sh', t(BAD_FILES, 'echo top')), 'files: the prefix project holds the bad script');
  denies(git('cd sub && npm explore foo -- bash run.sh', t(BAD_GIT, 'echo top')), 'git: after a cd');
});

// ---- the global npmrc under the global prefix -------------------------------------------------------------------------------------------------------------------------------------------------
const base = { 'package.json': pj };
const eachGuard = (cmd, tree, o = {}) => ({ git: git(cmd, tree, o), files: filesGuard(cmd, tree, o) });
const rcDenies = (cmd, tree, o, why) => { const r = eachGuard(cmd, { ...base, ...tree }, o); denies(r.git, `git: ${why}`); denies(r.files, `files: ${why}`); return r; };
const rcAllows = (cmd, tree, o, why) => { const r = eachGuard(cmd, { ...base, ...tree }, o); allows(r.git, `git: ${why}`); allows(r.files, `files: ${why}`); };

test('t3 the user .npmrc prefix= names the directory of the global npmrc (script-shell / node-options there make the scripts unknown)', () => {
  for (const bad of ['script-shell=/tmp/s', 'node-options=--require /e/x.js', 'globalconfig=/tmp/c']) {
    const r = rcDenies('npm test', { '/home/u/.npmrc': 'prefix=/x/pfx\n', '/x/pfx/etc/npmrc': `${bad}\n` }, {}, `${bad} under the user prefix`);
    assert.match(r.git.reason, /\/x\/pfx\/etc\/npmrc|\/home\/u\/\.npmrc/);
  }
  rcAllows('npm test', { '/home/u/.npmrc': 'prefix=/x/pfx\n', '/x/pfx/etc/npmrc': 'registry=https://r.example\nsave-exact=true\n' }, {}, 'a harmless key under the user prefix');
  rcAllows('npm test', { '/home/u/.npmrc': 'prefix=/x/pfx\n' }, {}, 'no global npmrc at the prefix');
  // the forms npm reads the value in
  for (const line of ['prefix=/x/pfx', 'prefix = /x/pfx', 'PREFIX=/x/pfx', 'prefix="/x/pfx"', "prefix='/x/pfx'", 'prefix=/x/pfx ; where the globals live', 'prefix=/x/pfx # globals', '# old\nprefix=/y\nprefix=/x/pfx']) {
    rcDenies('npm test', { '/home/u/.npmrc': `${line}\n`, '/x/pfx/etc/npmrc': 'script-shell=/tmp/s\n' }, {}, `prefix written as ${JSON.stringify(line)}`);
  }
  // ~/ is the home directory, ${HOME} too; a relative prefix is relative to the working directory
  rcDenies('npm test', { '/home/u/.npmrc': 'prefix=~/.npm-global\n', '/home/u/.npm-global/etc/npmrc': 'script-shell=/tmp/s\n' }, {}, '~/ prefix');
  rcDenies('npm test', { '/home/u/.npmrc': 'prefix=${HOME}/.npm-global\n', '/home/u/.npm-global/etc/npmrc': 'script-shell=/tmp/s\n' }, {}, '${HOME} prefix');
  rcAllows('npm test', { '/home/u/.npmrc': 'prefix=${HOME}/.npm-global\n', '/home/u/.npm-global/etc/npmrc': 'registry=https://r.example\n' }, {}, '${HOME} prefix, harmless');
  rcDenies('npm test', { '/home/u/.npmrc': 'prefix=glob\n', [`${GIT_ROOT}/glob/etc/npmrc`]: 'script-shell=/tmp/s\n', [`${PROJ}/glob/etc/npmrc`]: 'script-shell=/tmp/s\n' }, {}, 'relative prefix');
  // the project's own .npmrc may set it too (all are tried), and --prefix names the global one as well
  rcDenies('npm test', { '.npmrc': 'prefix=/x/pfx\n', '/x/pfx/etc/npmrc': 'script-shell=/tmp/s\n' }, {}, 'project .npmrc prefix');
  rcDenies('npm test --prefix /x/pfx', { '/x/pfx/package.json': pj, '/x/pfx/etc/npmrc': 'script-shell=/tmp/s\n' }, {}, '--prefix');
  rcDenies('npm test', { '/home/u/.npmrc': 'prefix=/x/pfx\n', '/x/pfx/lib/node_modules/npm/npmrc': 'script-shell=/tmp/s\n' }, {}, 'the npmrc npm ships with, under the prefix');
});
test('t3 a prefix the guard cannot work out is refused (an unknown ${VAR}, an empty value, an unreadable file)', () => {
  for (const line of ['prefix=${UNKNOWN_VAR}/p', 'prefix=${UNKNOWN_VAR}', 'prefix=${A}/${HOME}', 'prefix=', 'prefix=""']) {
    const r = rcDenies('npm test', { '/home/u/.npmrc': `${line}\n` }, {}, `prefix written as ${JSON.stringify(line)}`);
    assert.match(r.git.reason, /prefix/);
  }
  // a value the caller does know is used
  rcDenies('npm test', { '/home/u/.npmrc': 'prefix=${PFX}/p\n', '/x/p/etc/npmrc': 'script-shell=/tmp/s\n' }, {}, 'unknown to the guard: refused, whatever the file at the guessed place holds');
  // an unreadable prefix rc (exists, cannot be read) is refused like any other rc file
  rcDenies('npm test', { '/home/u/.npmrc': 'prefix=/x/pfx\n', '/x/pfx/etc/npmrc': null }, {}, 'unreadable global npmrc');
  rcDenies('npm test', { '/home/u/.npmrc': null }, {}, 'unreadable user npmrc');
  // a commented prefix is no prefix
  rcAllows('npm test', { '/home/u/.npmrc': '# prefix=${UNKNOWN_VAR}\n; prefix=\nregistry=https://r.example\n' }, {}, 'a commented-out prefix');
  // the scripts must run for the rc to matter
  assert.equal(git('npm ls', { ...base, '/home/u/.npmrc': 'prefix=${UNKNOWN_VAR}\n' }).decision, 'allow');
});
test('t3 the global npmrc of the place node lives in (injectable nodePrefix; the default is dirname(dirname(process.execPath)))', () => {
  rcDenies('npm test', { '/n/pfx/etc/npmrc': 'node-options=--require /e/x.js\n' }, { nodePrefix: '/n/pfx' }, 'node-options in <nodePrefix>/etc/npmrc');
  rcDenies('npm test', { '/n/pfx/lib/node_modules/npm/npmrc': 'script-shell=/tmp/s\n' }, { nodePrefix: '/n/pfx' }, 'the npmrc npm ships with');
  rcAllows('npm test', { '/n/pfx/etc/npmrc': 'registry=https://r.example\n' }, { nodePrefix: '/n/pfx' }, 'a harmless key');
  rcAllows('npm test', { '/n/pfx/etc/npmrc': 'node-options=--require /e/x.js\n' }, { nodePrefix: null }, 'nodePrefix null: not looked for');
  rcAllows('npm test', { '/n/pfx/etc/npmrc': 'node-options=--require /e/x.js\n' }, { nodePrefix: '/other' }, 'another place');
  // the fixed paths stay
  for (const where of ['/etc/npmrc', '/usr/local/etc/npmrc', '/opt/homebrew/etc/npmrc']) rcDenies('npm test', { [where]: 'script-shell=/tmp/s\n' }, {}, where);
  // without the option the default comes from this node binary's own place
  const dflt = process.platform === 'win32' ? dirname(process.execPath) : dirname(dirname(process.execPath));
  const r = evaluateGitCommand('npm test', { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fakeFs(GIT_ROOT, { ...base, [`${dflt}/etc/npmrc`]: 'script-shell=/tmp/s\n' }) });
  denies(r, 'the default prefix is node\'s own place');
});
test('t3 globalconfig= and userconfig= in the user or the project .npmrc make the scripts unknown', () => {
  for (const where of ['.npmrc', '/home/u/.npmrc']) for (const line of ['globalconfig=/tmp/g', 'userconfig=/tmp/u', 'GLOBALCONFIG = /tmp/g']) {
    rcDenies('npm test', { [where]: `${line}\n` }, {}, `${where}: ${line}`);
  }
});
