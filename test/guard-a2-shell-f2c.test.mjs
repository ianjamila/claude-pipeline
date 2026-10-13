// Why (PR A2, batch F2b part 2): files-policy tracks what binders, sourced files and unknown sources do to the names a line uses. Guarded text lives in fake file contents only;
// the commands only name files.
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

test('F2b-2 95: a sourced file that binds a name through an attached option or sets the positionals makes the name unknown', () => {
  for (const rc of ['printf -vF ev.sh', 'printf -v F ev.sh', 'wait -pF', 'read F < list.txt']) {
    denies(files, { 'rc.sh': rc }, [`F=ok.sh; source rc.sh; bash ${D}F`]);
  }
  denies(files, { 'rc.sh': 'set -- ev.sh' }, [`source rc.sh; bash ${D}1`]);
  denies(files, { 'rc.sh': 'set -o allexport; set -- ev.sh' }, [`source rc.sh; bash ${D}1`]);
  allows(files, { 'rc.sh': 'set -e; echo hi' }, [`F=ok.sh; source rc.sh; bash ${D}F`]);
  allows(files, { 'rc.sh': 'F=ok.sh' }, [`F=ok.sh; source rc.sh; bash ${D}F`]);
});

test('F2b-2 96: a binder on the line gives its names a run-time value (REPLY, MAPFILE, OPTARG, the names given, a nameref target, the positionals)', () => {
  denies(files, {}, [
    `F=ok.sh; read F < list.txt; bash ${D}F`,
    `F=ok.sh; printf -vF ev.sh; bash ${D}F`,
    `F=ok.sh; mapfile F < list.txt; bash ${D}F`,
    `read < list.txt; bash ${D}REPLY`,
    `mapfile < list.txt; bash ${D}MAPFILE`,
    `getopts a o; bash ${D}OPTARG`,
    `declare -n r=F; F=ok.sh; r=ev.sh; bash ${D}F`,
    `set -- ev.sh; bash ${D}1`,
  ]);
  // a read whose value is never used as a script or a write target stays allowed
  allows(files, {}, [`while read f; do echo ${D}f; done < list.txt`, 'read -r line < list.txt; echo hi', 'F=ok.sh; bash $F']);
});

test('F2b-2 96: the words an assigning expansion gives a name reach the scripts a child runs', () => {
  const run = { 'run.sh': 'bash "$X"' };
  denies(files, run, [`export X; : ${D}{X:=ev.sh}; bash run.sh`]);
  denies(git, run, [`export X; : ${D}{X:=ev.sh}; bash run.sh`]);
  allows(files, run, ['export X; bash run.sh']);
});

test('F2b-2 59: a name only some of several sourced candidates set is unknown', () => {
  const two = { 's1.sh': 'F=ok.sh', 's2.sh': 'echo hi' };
  denies(files, two, [`F=ev.sh; source s*.sh; bash ${D}F`, `F=ok.sh; source s*.sh; bash ${D}F`]);
  // every candidate sets the same value: still believed
  allows(files, { 's1.sh': 'F=ok.sh', 's2.sh': 'F=ok.sh' }, [`F=ev.sh; source s*.sh; bash ${D}F`]);
  // a file the line writes first and the one on disk are both cases
  denies(files, { 'rc.sh': 'F=ok.sh' }, [`F=ev.sh; echo hi > rc.sh; source rc.sh; bash ${D}F`]);
});

test('F2b-2 79: a sourced file that cannot be followed may cd anywhere, so the rest of the line is judged in the protected directories', () => {
  const protectedTail = { '/home/u/.claude/pipeline/hooks/guard.mjs': 'x' };
  denies(files, protectedTail, [`source ${D}UNSET_X; echo x > settings.json`, `source ${D}UNSET_X; echo x > pipeline/hooks/guard.mjs`]);
  allows(files, protectedTail, [`source ${D}UNSET_X; echo x > /tmp/out.txt`, 'source ok.sh; echo x > settings.json']);
});

test('F2b-2 58: after an unknown cd, relative script operands and relative feeds are judged in the protected directories', () => {
  const inHome = { '/home/u/.claude/x.sh': BAD };
  denies(files, inHome, [
    `cd ${D}D; bash x.sh`, `cd ${D}D; bash < x.sh`, `cd ${D}D; cat x.sh | bash`, `cd ${D}D; source x.sh`, `cd ${D}D; eval "${D}(cat x.sh)"`, `cd ${D}D; bash <(cat x.sh)`,
  ]);
  allows(files, inHome, [`cd ${D}D; bash h.sh`, `cd ${D}D; bash < h.sh`]);
});
