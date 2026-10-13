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
