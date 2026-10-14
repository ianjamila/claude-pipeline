// Why (PR A2, batch F2b): a run-time command head whose variable value is known on the line (`BASH=./ev.sh; "${BASH:-bash}" h.sh`, `G=bash; $G ev.sh`) or whose default / alternative word
// names the program (`"${X:-./ev.sh}" h.sh`) is judged on every reading (the value, the default word, empty) like a command name or script operand. Guarded text lives in fake file
// contents only; the commands only name files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { paramReadings } from '../pipeline/hooks/lib/script-candidates.mjs';

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
const FILES = { 'ev.sh': `${GUARDED}\n${BAD_WRITE}\n`, 'ok.sh': 'echo hi', 'h.sh': 'echo hi' };
const runners = [
  ['guard-git', (c) => evaluateGitCommand(c, { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs(GIT_ROOT, FILES, ['/home/u']) })],
  ['guard-files', (c) => evaluateBashForFiles(c, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fakeFs(PROJ, FILES, ['/home/u']), existsSync: fakeFs(PROJ, FILES, ['/home/u']).pathExists })],
];
const D = '$';

test('F2b 92: paramReadings lists every reading of a default / alternative expansion (value, word, empty) and flags a blow-up', () => {
  assert.deepEqual(paramReadings('plain.sh'), ['plain.sh']);
  assert.deepEqual([...paramReadings(`${D}{X:-a.sh}`)].sort(), ['', `${D}{X}`, 'a.sh']);
  assert.deepEqual([...paramReadings(`${D}{X:+a.sh}`)].sort(), ['', 'a.sh']);
  assert.deepEqual([...paramReadings(`d/${D}{X-${D}{Y:-b}}.sh`)].sort(), [`d/${D}{X}.sh`, `d/${D}{Y}.sh`, 'd/.sh', 'd/b.sh']);
  let big = '';
  for (let i = 0; i < 8; i++) big += `${D}{A${i}:-x}`;
  assert.equal(paramReadings(big).over, true);
});

for (const [name, run] of runners) {
  test(`F2b 92 ${name}: a head whose known value or default word names a bad program is judged`, () => {
    const bad = [
      `BASH=./ev.sh; "${D}{BASH:-bash}" h.sh`,
      `BASH=./ev.sh; "${D}{BASH-bash}" h.sh`,
      `X=./ev.sh; "${D}{X:-bash}" h.sh`,
      `"${D}{X:-./ev.sh}" h.sh`,
      `"${D}{X-./ev.sh}" h.sh`,
      `"${D}{X:=./ev.sh}" h.sh`,
      `X=bash; "${D}{X:+./ev.sh}" h.sh`,
      `X=bash; "${D}{X:-./ev.sh}" h.sh`,
      `G=bash; ${D}G ev.sh`,
      `G=bash; ${D}{G:-x} ev.sh`,
      `${D}{G:-bash} ev.sh`,
      `bash ${D}{G:-ev.sh}`,
      `G=ev.sh; bash ${D}{G:-ok.sh}`,
    ];
    for (const c of bad) {
      const d = run(c);
      assert.equal(d.decision, 'deny', `${c} -> ${d.reason}`);
    }
  });

  test(`F2b 92 ${name}: the same shapes naming only harmless programs stay allowed`, () => {
    const ok = [
      `BASH=./ok.sh; "${D}{BASH:-bash}" h.sh`,
      `"${D}{X:-bash}" h.sh`,
      `G=bash; ${D}G h.sh`,
      `${D}{G:-bash} h.sh`,
      `bash ${D}{G:-h.sh}`,
      `X=./ok.sh; "${D}{X:-./h.sh}" a`,
    ];
    for (const c of ok) {
      const d = run(c);
      assert.equal(d.decision, 'allow', `${c} -> ${d.reason}`);
    }
  });
}

// ---- 91: default / alternative words and command substitutions that spell a protected path (guard-files) ------------------------------------------------------------------------
const filesRun = runners[1][1];
test('F2b 91: a target whose default / alternative word, or command substitution, spells a protected path is refused (cp, redirect, tee)', () => {
  const targets = [
    `${D}{V:-~/.claude}/settings.json`,
    `${D}{V:-${D}HOME/.claude}/settings.json`,
    `"${D}{V:-${D}HOME/.claude}"/settings.json`,
    `${D}{V-~/.claude}/settings.json`,
    `${D}{V:=~/.claude}/settings.json`,
    `${D}{V:+~/.claude}/settings.json`,
    `${D}{V:-${D}{W:-~/.claude}}/settings.json`,
    `"${D}(echo ~/.claude)"/settings.json`,
    `${D}(echo ~/.claude)/settings.json`,
    `\`echo ~/.claude\`/settings.json`,
  ];
  for (const t of targets) {
    for (const c of [`cp x ${t}`, `echo x > ${t}`, `echo x | tee ${t}`]) {
      const d = filesRun(c);
      assert.equal(d.decision, 'deny', `${c} -> ${d.reason}`);
    }
  }
});

test('F2b 91: default words that do not spell a protected path stay allowed', () => {
  for (const c of [`cp x ${D}{V:-/tmp}/a.json`, `echo x > ${D}{V:-out}/a.json`, `cp x ${D}V/a.json`, `echo x > "${D}(pwd)"/a.json`, `cp x ${D}{V:-${D}HOME/proj}/a.json`]) {
    const d = filesRun(c);
    assert.equal(d.decision, 'allow', `${c} -> ${d.reason}`);
  }
});

// ---- 93: what a sourced file's allowlisted commands still bind ------------------------------------------------------------------------------------------
const filesIn = (command, fsOpts, o = {}) => evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o });
const DIRS93 = ['bin', 'sub', '/home/u', '/tmp'];
const rcTree = (body) => fakeFs(PROJ, { 'set.sh': `${body}\n`, 'evil.sh': BAD_WRITE, 'ok.sh': 'echo ok' }, DIRS93);

// Why: read / select / mapfile / getopts / cd bind names they are not given (REPLY, MAPFILE, OPTARG, OPTIND, PWD, OLDPWD); a nameref (`declare -n r=F; r=x`) binds F through another name; a function or
// alias the LINE defines can be called by an allowlisted-looking command of the sourced file.
test('F2b 93: implicit binders, namerefs and line-defined functions / aliases make the name a later word picks unknown', () => {
  const cases = [
    ['REPLY', 'read <<< evil.sh'],
    ['REPLY', 'select x in a; do break; done'],
    ['MAPFILE', 'mapfile < evil.list'],
    ['MAPFILE', 'readarray -t < evil.list'],
    ['OPTARG', 'getopts "a:" x -a evil.sh'],
    ['OPTIND', 'getopts "a:" x -a evil.sh'],
    ['PWD', 'cd sub'],
    ['OLDPWD', 'cd sub'],
    ['F', 'declare -n r=F; r=evil.sh'],
    ['F', 'typeset -n r=F; r=evil.sh'],
    ['F', 'local -n r=F; r=evil.sh'],
    ['F', 'export -n r=x; declare -n q=F; q=evil.sh'],
  ];
  for (const [n, body] of cases) {
    const d = filesIn(`${n}=ok.sh; source set.sh; bash ${D}${n}`, rcTree(body));
    assert.equal(d.decision, 'deny', `${n}: ${body} -> ${d.reason}`);
  }
  const defined = [
    ['ls() { read F; }', 'ls <<< evil.sh'],
    ['function ls { read F; }', 'ls <<< evil.sh'],
    ["alias ls='read F'", 'ls <<< evil.sh'],
    ['cat() { F=evil.sh; }', 'cat'],
  ];
  for (const [pre, body] of defined) {
    const d = filesIn(`${pre}; F=ok.sh; source set.sh; bash ${D}F`, rcTree(body));
    assert.equal(d.decision, 'deny', `${pre} / ${body} -> ${d.reason}`);
  }
  // (what stays modelled)
  for (const calm of ['echo hi', 'set -eu', 'set -o allexport', 'set -- a b', 'export -n G', 'ls >/dev/null; test -d sub', 'cat set.sh']) {
    const d = filesIn(`F=ok.sh; source set.sh; bash ${D}F`, rcTree(calm));
    assert.equal(d.decision, 'allow', `${calm} -> ${d.reason}`);
  }
});

// ---- 94: exactness of the readings (nested words, word splitting, globs, assigning expansions, forms that stay unresolved) ------------------------------------------------------------------------
for (const [name, run] of runners) {
  test(`F2b 94 ${name}: nested defaults, an unquoted default that is a command plus arguments, a glob and an assigning expansion are all judged`, () => {
    for (const c of [
      `${D}{X:-${D}{Y:-./ev.sh}} h.sh`,
      `${D}{X:-bash ev.sh} h.sh`,
      `${D}{X:-./e*.sh} h.sh`,
      `: ${D}{X:=./ev.sh}; bash ${D}X`,
      `: ${D}{X=./ev.sh}; "${D}X" h.sh`,
      `: ${D}{X:=ev.sh}; bash "${D}{X}"`,
      `: ${D}{X:=ev.sh}; G=bash; ${D}G ${D}X`,
    ]) {
      const d = run(c);
      assert.equal(d.decision, 'deny', `${c} -> ${d.reason}`);
    }
  });

  test(`F2b 94 ${name}: an expansion whose extent cannot be told (a brace inside quotes or a half-open substitution, unbalanced) is refused, never read as a literal word`, () => {
    for (const c of [`"${D}{X:-"a b"}" c`, `${D}{X:-${D}(echo })} c`, `${D}{X:-"}"} c`, `bash ${D}{X:-"}"}`, `${D}{X:-a`]) {
      const d = run(c);
      assert.equal(d.decision, 'deny', `${c} -> ${d.reason}`);
    }
  });
}

test('F2b 94 guard-git: forms that stay unresolved (length, substring, indirection, substitution, case) are not read as a literal word', () => {
  const MENTION = `echo "${GUARDED}"\n`;
  for (const form of [`${D}{#X}`, `${D}{X:1:3}`, `${D}{!X}`, `${D}{X/a/b}`, `${D}{X^^}`, `${D}{=X}`]) {
    const d = runners[0][1](`${MENTION}X=ok.sh; ${form} h.sh`);
    assert.equal(d.decision, 'deny', `${form} -> ${d.reason}`);
  }
});

// ---- 60 (closed by the 87 allowlist: return / exit / break / continue are not on it, so the file makes every name unknown; pinned here): return / exit / break / continue in a sourced file end it: later assignments and cds may never run ------------------------------------------------------------------------
test('F2b 60: a name or directory a sourced file sets after a return / exit / break / continue is unknown', () => {
  for (const body of ['return\nF=evil.sh', 'return 0\nF=evil.sh', '[ -z "x" ] && return\nF=evil.sh', 'exit\nF=evil.sh', 'for i in 1; do break; F=evil.sh; done']) {
    const d = filesIn(`F=ok.sh; source set.sh; bash ${D}F`, rcTree(body));
    assert.equal(d.decision, 'deny', `${body} -> ${d.reason}`);
  }
  const d = filesIn(`source set.sh; echo x > settings.json`, fakeFs(PROJ, { 'set.sh': 'return\ncd /home/u/.cla' + 'ude\n' }, DIRS93));
  assert.equal(d.decision, 'deny', d.reason);
});
