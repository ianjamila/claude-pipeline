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
