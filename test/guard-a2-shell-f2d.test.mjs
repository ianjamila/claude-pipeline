// Why (PR A2, batch F2c): a default / alternative word spliced into an OPTION position of a shell or interpreter (`bash ${A:--c ./ev.sh}`), and the leftovers of the F2b reviews.
// Guarded text lives in fake file contents only; the commands only name files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { spliceLines } from '../pipeline/hooks/lib/script-candidates.mjs';

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
const GUARDED = 'gi' + 't pu' + 'sh orig' + 'in ma' + 'in';
const BAD_WRITE = 'echo x > /home/u/.cla' + 'ude/settings.json';
const BAD = `${GUARDED}\n${BAD_WRITE}\n`;
const BASE = { 'ev.sh': BAD, 'ok.sh': 'echo hi', 'h.sh': 'echo hi', 'list.txt': 'ev.sh\n' };
const D = '$';
const files = (extra = {}, c) => {
  const FS = { ...BASE, ...extra };
  const fs = fakeFs(PROJ, FS, ['/home/u']);
  return evaluateBashForFiles(c, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists });
};
const git = (extra = {}, c) => evaluateGitCommand(c, { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, { ...BASE, ...extra }, ['/home/u']) });
const denies = (run, extra, cmds) => { for (const c of cmds) { const d = run(extra, c); assert.equal(d.decision, 'deny', `${c} -> ${d.reason}`); } };
const allows = (run, extra, cmds) => { for (const c of cmds) { const d = run(extra, c); assert.equal(d.decision, 'allow', `${c} -> ${d.reason}`); } };

test('F2c 95: a default word spliced into an option position of a shell is judged as the command line it makes', () => {
  for (const run of [files, git]) {
    denies(run, {}, [
      `bash ${D}{A:--c ./ev.sh}`,
      `bash ${D}{A:--s} < ev.sh`,
      `bash "${D}{A:--s}" < ev.sh`,
      `bash ${D}{A-"-s"} < ev.sh`, // (a quote in the word: the reading cannot be built exactly, so it is refused)
      `bash ${D}{A:--x} ${D}{B:--s} < ev.sh`,
      `bash ${D}{A:-${D}{B:--s}} < ev.sh`,
      `bash ${D}{A:+-c ./ev.sh}`,
      `bash ${D}{A:+-c ./ok.sh} < ev.sh`, // (the alternative word is unused when A is unset: the empty reading)
      `sh ${D}{A:--c ./ev.sh}`,
      `zsh ${D}{A:--c ./ev.sh}`,
      `bash -x ${D}{A:--c ./ev.sh}`,
      `FOO=1 bash ${D}{A:--s} < ev.sh`,
      `echo hi && bash ${D}{A:--c ./ev.sh}`,
      `source ${D}{A:-ev.sh}`,
    ]);
    // readings that run nothing harmful stay allowed
    allows(run, {}, [
      `bash ${D}{A:--x} ok.sh`,
      `bash ok.sh ${D}{V:-default}`,
      `bash -c "${D}{CMD:-echo hi}"`,
      `bash ${D}{A:--c ./ok.sh}`,
      `bash ${D}{A:--s} < ok.sh`,
      `echo ${D}{A:--c ./ev.sh}`,
    ]);
  }
});

test('F2c 95: an interpreter given a defaulted option word is judged on each reading', () => {
  const ev = { 'ev.mjs': `require('child_process').execSync('${GUARDED}')\nrequire('fs').writeFileSync('/home/u/.cla' + 'ude/settings.json', 'x')\n` };
  denies(files, ev, [`node ${D}{A:-ev.mjs}`]);
  denies(git, ev, [`node ${D}{A:-ev.mjs}`]);
  allows(files, { 'ok.mjs': 'console.log(1)' }, [`node ${D}{A:-ok.mjs}`]);
});

test('F2c 95: spliceLines gives the bash reading (split) and the zsh reading (one word), and refuses what it cannot build', () => {
  const r = spliceLines(`bash ${D}{A:--c ./ev.sh}`);
  assert.ok(r.lines.includes('bash -c ./ev.sh'));
  assert.ok(r.lines.includes('bash "-c ./ev.sh"'));
  assert.ok(r.lines.includes('bash '));
  assert.equal(r.over, false);
  // a quoted occurrence is not wrapped again; a single-quoted one is no expansion at all
  assert.ok(spliceLines(`bash "${D}{A:--c x}"`).lines.includes('bash "-c x"'));
  assert.deepEqual(spliceLines(`bash '${D}{A:--c x}'`).lines, []);
  assert.equal(spliceLines(`bash ${D}{A:-'x'}`).over, true);
  assert.equal(spliceLines(`bash ${D}(echo ${D}{A:-x})`).over, true);
  const many = Array.from({ length: 8 }, (_, i) => `${D}{V${i}:-a}`).join(' ');
  assert.equal(spliceLines(`bash ${many}`).over, true);
});

// Why: item 51's first test spelled the protected path inside the declare, so the declare itself was refused and the option-order fix was never exercised (its mutation survived). The path here is only
// ever put together from the parts the declare gives, so the verdict depends on whether -u (after the first name) uppercases them.
test('F2c 51: declare / typeset options end at the first name (the -u after a name changes nothing)', () => {
  denies(files, {}, [
    "declare P=/home/u C=.cla''ude -u; echo x > $P/$C/settings.json",
    "typeset P=/home/u -u; echo x > $P/.cla''ude/settings.json",
    "declare P=.cla''ude -u; cd /home/u/$P; echo x > settings.json",
    "declare P=/home/u -l; echo x > $P/.cla''ude/settings.json",
  ]);
  // an option before the first name does apply (the value is cased: unknown to the path check, not a protected path)
  allows(files, {}, ['declare -u D=/home/u/ok; echo x > $D/out.txt', 'declare P=/home/u -u; echo x > $P/out.txt']);
});

// Why (item 85): `cd -P link/..` / `set -P` / zsh chaselinks go to the PHYSICAL parent of the link's target while the line's own arithmetic is lexical; the cwd list holds both readings.
test('F2c 85: a `..` after a symlinked directory also names the target\'s parent', () => {
  const links = { '/home/u/proj/lnk': '/home/u/.cla' + 'ude/pipeline' };
  const real = (p) => { const q = resolve(p); for (const [l, t] of Object.entries(links)) if (q === l || q.startsWith(`${l}/`)) return t + q.slice(l.length); return q; };
  const fs = fakeFs(PROJ, BASE, ['/home/u/.cla' + 'ude/pipeline', '/home/u/proj/lnk']);
  const run = (c) => evaluateBashForFiles(c, { home: '/home/u', env: {}, platform: 'linux', realpath: real, cwd: PROJ, ...fs, existsSync: fs.pathExists });
  for (const c of ['cd -P lnk/..; echo x > settings.json', 'set -P; cd lnk/..; echo x > settings.json', 'cd -eP -- lnk/..; echo x > settings.json', 'pushd -P lnk/..; echo x > settings.json', 'cd lnk/../.; echo x > settings.json']) assert.equal(run(c).decision, 'deny', c);
  for (const c of ['cd lnk2/..; echo x > settings.json', 'cd sub/..; echo x > out.txt', 'cd ..; echo x > out.txt']) assert.equal(run(c).decision, 'allow', c);
});

test('F2c 85: git-policy does not take the link\'s parent for the directory of `cd -P link/..`', () => {
  const links = { [resolve('/work/repo/lnk')]: resolve('/work/other/sub') };
  const real = (p) => { const q = resolve(p); for (const [l, t] of Object.entries(links)) if (q === l || q.startsWith(`${l}/`)) return t + q.slice(l.length); return q; };
  const fs = fakeFs(GIT_ROOT, BASE, ['/home/u', '/work/other/sub', '/work/repo/lnk']);
  const run = (c) => evaluateGitCommand(c, { cwd: GIT_ROOT, home: '/home/u', realpath: real, currentBranch: (d) => (resolve(d) === GIT_ROOT ? 'agent/x' : 'main'), pushDestination: () => null, issueLabels: () => [], ...fs });
  assert.equal(run('cd -P lnk/..; git push origin HEAD').decision, 'deny');
  assert.equal(run('cd lnk/..; git push origin HEAD').decision, 'deny'); // (also without -P: set -P / chaselinks may be on)
  assert.equal(run('cd sub/..; git push origin HEAD').decision, 'allow');
  assert.equal(run('git push origin HEAD').decision, 'allow');
});

// Why (item 77): `cd "$(dirname "$0")"` with a relative $0 (`scripts/run` -> `cd scripts`) is looked up along CDPATH first.
test('F2c 77: the script\'s own directory (a relative dirname) is unknown while CDPATH may be set', () => {
  const fs = fakeFs(PROJ, { ...BASE, 'scripts/run': 'cd "$(dirname "$0")"\necho x > settings.json\n' }, ['/home/u/.cla' + 'ude/scripts']);
  const run = (c, env = {}) => evaluateBashForFiles(c, { home: '/home/u', env, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists });
  const cp = 'CDPATH=/home/u/.cla' + 'ude';
  for (const c of [`${cp} bash scripts/run`, `export ${cp}; bash scripts/run`, `${cp}; bash scripts/run`]) assert.equal(run(c).decision, 'deny', c);
  assert.equal(run('bash scripts/run', { CDPATH: '/home/u/.cla' + 'ude' }).decision, 'deny');
  assert.equal(run('bash scripts/run').decision, 'allow');
  assert.equal(run(`${cp} bash /home/u/proj/scripts/run`).decision, 'allow'); // (an absolute $0 has an absolute dirname: no CDPATH lookup)
});

// Why (item 78): the repo root `git rev-parse --show-toplevel` prints can move with core.worktree, also from `$GIT_DIR/config.worktree` (extensions.worktreeConfig) and in any spelling of the key.
test('F2c 78: the repo root is unknown when any git config the walk reads mentions a worktree', () => {
  const root = (extra) => fakeFs(PROJ, { ...BASE, '.git/config': '[core]\n\trepositoryformatversion = 1\n', ...extra }, ['.git']);
  const run = (fs, c) => evaluateBashForFiles(c, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists });
  const c = 'cd "$(git rev-parse --show-toplevel)"; echo x > settings.json';
  // the root is the project itself (settings.json there is not protected): known
  assert.equal(run(root({}), c).decision, 'allow');
  // core.worktree in the shared config, in config.worktree, and the key spelled with a space or in a section form: the root is elsewhere
  for (const extra of [{ '.git/config': '[core]\n\tworktree = /home/u/.cla' + 'ude\n' }, { '.git/config.worktree': '[core]\n\tworktree = /home/u/.cla' + 'ude\n' }, { '.git/config': '[core "x"]\n\tWorkTree=/home/u/.cla' + 'ude\n' }, { '.git/config': '[extensions]\n\tworktreeConfig = true\n' }]) {
    assert.equal(run(root(extra), c).decision, 'deny', JSON.stringify(extra));
  }
});

// Why (item 40): a write target that stays a run-time value (`$(echo settings.json)`, `"$V"`) is refused once the cwd is inside the protected tree. The cwd may be BELOW the protected files
// (projects/, skills/other): `../settings.json` climbs back to them.
test('F2d 40: a run-time write target is refused anywhere under the protected directory', () => {
  const T = '~/.cla' + 'ude';
  const bad = [];
  for (const dir of [T, `${T}/projects`, `${T}/projects/foo`, `${T}/skills/other`, `/home/u/.cla` + 'ude/projects']) {
    for (const w of ['echo x > $(echo ../settings.json)', 'echo x > `echo ../settings.json`', 'echo x > "$V"', 'echo x > $(printf settings.json)', 'cp /tmp/x $V', 'mv /tmp/x $(echo ../settings.json)', 'echo x | tee "$V"', 'touch $V', 'rm $V', 'ln -sf /tmp/x $V', 'install /tmp/x $V', 'dd of=$V', 'truncate -s 0 $V', 'sed -i s/a/b/ $V', 'curl -o $V http://x']) bad.push(`cd ${dir} && ${w}`);
  }
  bad.push(`pushd ${T}/projects >/dev/null; echo x > $V`, `(cd ${T}/projects; echo x > $V)`, `cd ${T}/projects\necho x > $V`);
  denies(files, {}, bad);
  // the hook starts inside the tree
  const inTree = (c) => evaluateBashForFiles(c, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: '/home/u/.cla' + 'ude/projects', ...fakeFs(PROJ, BASE, ['/home/u']), existsSync: () => true });
  for (const c of ['echo x > "$V"', 'cp /tmp/x $(echo ../settings.json)', 'tee $V < /tmp/x']) assert.equal(inTree(c).decision, 'deny', c);
  // literal targets, reads, and run-time targets outside the tree stay allowed
  allows(files, {}, [
    `cd ${T}/projects && echo x > notes.txt`, `cd ${T}/projects && echo hi`, `cd ${T}/projects && cat $V`, `cd ${T}/projects && cp a.txt b.txt`,
    'cd /home/u/proj && echo x > $(echo out.txt)', 'cd /home/u/proj && cp /tmp/x "$V"', 'echo x > $V', 'cd /home/u/other && tee $V < /tmp/x',
  ]);
  assert.equal(inTree('echo x > notes.txt').decision, 'allow');
});

// Why (item 99): zsh's lowercase `cdpath` array is tied to CDPATH, so every CDPATH check also sees it.
test('F2d 99: cdpath (zsh) is CDPATH for the directory of a relative cd and of a relative $0', () => {
  const W = 'echo x > settings.json';
  const S = { 'b.sh': 'cdpath=(/x)\ncd sub', 'c.sh': 'cd ./sub', 'scripts/run': 'cd "$(dirname "$0")"\n' + W + '\n' };
  const fs = fakeFs(PROJ, { ...BASE, ...S }, ['/home/u/.cla' + 'ude/scripts']);
  const run = (c, env = {}) => evaluateBashForFiles(c, { home: '/home/u', env, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists });
  for (const c of [
    `cdpath=(/x); cd sub && ${W}`, `cdpath+=(/x); cd sub && ${W}`, `cdpath=(/x) cd sub && ${W}`, `cdpath[1]=/x; cd sub && ${W}`, `cdpath=(/x); pushd sub && ${W}`, `typeset -T CDPATH cdpath; cdpath=(/x); cd sub && ${W}`,
    `cdpath=(/x); export CDPATH; cd sub && ${W}`, `export cdpath=(/x); cd sub && ${W}`, `typeset -T CDPATH cdpath=(/x); cd sub && ${W}`, `typeset -T CDPATH=/x cdpath; cd sub && ${W}`, `declare -x cdpath=(/x); cd sub && ${W}`, `. ./b.sh; ${W}`, `cdpath=(/x); bash scripts/run`, `cdpath+=(/x); bash scripts/run`,
  ]) assert.equal(run(c).decision, 'deny', c);
  for (const c of [`cdpath=(/x); cd ./sub && ${W}`, `cdpath=(/x); cd /tmp/sub && ${W}`, `cd sub && ${W}`, `cdpath=(); cd ./sub && ${W}`, '. ./c.sh; ' + W, 'bash scripts/run', `cdpath=(/x); bash /home/u/proj/scripts/run`]) assert.equal(run(c).decision, 'allow', c);
});

// Why (item 99): git-policy never looked at CDPATH, so `cd sub` was taken as <cwd>/sub while the shell goes to the first CDPATH entry holding `sub`.
test('F2d 99: git-policy takes a relative cd as unknown while CDPATH / cdpath may be set', () => {
  const run = (c, env = {}) => evaluateGitCommand(c, { cwd: GIT_ROOT, home: '/home/u', env, currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, { ...BASE, 'b.sh': 'cdpath=(/x)\ncd sub\n' }, ['/home/u', '/work/repo/sub']) });
  const P = 'git push origin HEAD';
  for (const c of [
    `CDPATH=/o cd sub && ${P}`, `CDPATH=/o; cd sub && ${P}`, `export CDPATH=/o; cd sub && ${P}`, `cdpath=(/o); cd sub && ${P}`, `cdpath+=(/o); cd sub && ${P}`, `cdpath[1]=/o; cd sub && ${P}`, `cdpath=(/o) cd sub && ${P}`,
    `typeset -T CDPATH cdpath; cd sub && ${P}`, `cdpath=(/o); pushd sub && ${P}`, `cdpath=(/o); export CDPATH; cd sub && ${P}`, `CDPATH=$X; cd sub && ${P}`,
  ]) assert.equal(run(c).decision, 'deny', c);
  assert.equal(run(`cd sub && ${P}`, { CDPATH: '/o' }).decision, 'deny');
  for (const c of [`cd sub && ${P}`, `cd ./sub && ${P}`, `cdpath=(/o); cd ./sub && ${P}`, `CDPATH=/o; cd ../repo && ${P}`, `CDPATH=/o; cd /work/repo/sub && ${P}`, `CDPATH=/o; cd ~ ; ${P.replace('git', 'git -C /work/repo')}`, `CDPATH= cd sub && ${P}`, P]) assert.equal(run(c).decision, 'allow', c);
  assert.equal(run(`cd ./sub && ${P}`, { CDPATH: '/o' }).decision, 'allow');
  assert.equal(run(`cd sub && ${P}`, { CDPATH: '' }).decision, 'allow');
});
