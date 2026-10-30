// Why (#81 t8b, two fail-open holes the t8 implementer found, both on main too):
//   H1  the files guard judged a WRITE TARGET built from a name whose value holds a parameter operator or is an array as the text was written: `F=ok; D=${F/ok/.claude}; echo x > ~/$D/settings.json` wrote the protected
//       file and was allowed. The words such a name may hold (assignedValues, script-candidates.mjs) are now read for write targets as they are for script names; a word that cannot be worked out is the
//       "writes through a variable whose value is only known at run time" refusal.
//   H2  a hook that outlasts the host's 15 s limit is ALLOWED, and some 200 kB lines took the parser longer (a pattern started again at every character of a run, a scan that read to the end of the line for each
//       `${`, a word flattened for every character). Every shape below is answered by both guards within a CPU-time bound (CPU time, not the clock: a busy machine must not fail the test).
// Guarded names are spelled in pieces, as test/guard-hidden-assignments.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const CL = '.cl' + 'aude';
const none = { readText: () => null, readHead: () => null, pathExists: () => false, readDir: () => null };
const files = (command, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: '/home/u/proj', ...none, existsSync: () => false, ...o,
});
const git = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...none,
});
const deny = (cmd) => { const r = files(cmd); assert.equal(r.decision, 'deny', `${cmd} -> ${r.reason ?? 'allowed'}`); return r; };
const allow = (cmd) => { const r = files(cmd); assert.equal(r.decision, 'allow', `${cmd} -> ${r.reason}`); };

// ---- H1. write targets read a name's operator / array values ---------------------------------------------------------------------------------------------------
test('H1 a write target built from a name given by an operator is judged for every word the name may hold', () => {
  deny(`F=ok; D=\${F/ok/${CL}}; echo x > ~/$D/settings.json`);
  deny(`F=ok; D=\${F//ok/${CL}}; echo x > $HOME/$D/settings.json`);
  deny(`D=\${U:-${CL}}; echo x > ~/$D/settings.json`);
  deny(`D=\${U:=${CL}}; echo x >> ~/$D/settings.json`);
  deny(`D=\${U:+${CL}}; echo x > ~/$D/settings.json`.replace('U:+', 'U:-'));
  deny(`D=(x ${CL}); echo x > ~/\${D[1]}/settings.json`);
  deny(`D=(x ${CL}); echo x > ~/\${D[@]}/settings.json`);
  deny(`F=x${CL}; D=\${F#x}; echo x > ~/$D/settings.json`);
  deny(`F=${CL}.bak; D=\${F%.bak}; echo x > ~/$D/settings.json`);
  deny(`F=ok; D=\${F/ok/${CL}}; E=$D; echo x > ~/$E/settings.json`);
});
test('H1 the same targets of the writers, not only a redirect', () => {
  const d = `D=\${U:-${CL}};`;
  deny(`${d} cp a ~/$D/settings.json`);
  deny(`${d} mv a ~/$D/settings.json`);
  deny(`${d} tee ~/$D/settings.json`);
  deny(`${d} sed -i s/a/b/ ~/$D/settings.json`);
  deny(`${d} echo x | tee -a "$HOME/$D/settings.json"`);
  deny(`${d} install -m 644 a ~/$D/settings.json`);
});
test('H1 a name whose value cannot be worked out is a run-time variable: a write through it is refused, a read is not', () => {
  const r = deny('D=${U@Q}; echo x > ~/$D/a.txt');
  assert.match(r.reason, /only known at run time/);
  deny('F=ok; D=${F:abc}; echo x > ~/$D/a.txt');
  allow('D=${U@Q}; cat ~/$D/a.txt');
});
test('H1 harmless defaults, trims and arrays stay allowed', () => {
  allow('OUT=${OUT:-out}; echo x > $OUT/log');
  allow('D=${HOME}/x; echo > $D/a.txt');
  allow('B=${F%.ts}.js; cp a $B');
  allow('D=${U:-x}; echo x > ~/$D/a.txt');
  allow('F=ok; D=${F/ok/other}; echo x > ~/$D/a.txt');
  allow('D=(x y); echo x > ~/${D[1]}/a.txt');
  allow('F=a.ts; B=${F%.ts}.js; cp a $B');
});

// ---- H2. adversarial 200 kB lines are answered quickly by both guards ----------------------------------------------------------------------------------------------
const LIMIT = 200_000;
const fill = (unit) => unit.repeat(Math.ceil(LIMIT / unit.length)).slice(0, LIMIT);
const SHAPES = {
  'dollar-brace': '${', 'dollar-paren': '$(', 'double-quotes': '"', 'single-quotes': "'", backticks: '`', 'open-bracket': '[', 'name-bracket': 'a[', 'nested-arith': '$((',
  'heredoc-markers': '<<E ', 'heredoc-lines': 'cat <<E\n', 'open-brace': '{', 'assign-brace': 'a=${', 'tee-operands': 'tee ', ands: '&&', newlines: '\n', 'dollar-quote': '"$', 'for-in': 'for i in ',
  'dollar-brace-subscript': '${a[', 'indirect-subscript': '${!a[', 'quoted-subscript': '"${a["', 'subscript-dollar-brace': 'a[${', 'length-subscript': '${#a[', 'for-subscript': 'for a[', 'blank-slash': ' / ', 'slash-quote': "/'", 'quote-slash': "'/", 'name-paren': 'f(){ ', 'array-open': 'a=(', backslashes: '\\',
};
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
for (const [name, unit] of Object.entries(SHAPES)) {
  test(`H2 a ${LIMIT}-character line of ${name} is answered in under 6 s of CPU time by each guard (allow or deny, never a throw)`, () => {
    const line = fill(unit);
    for (const [who, run] of [['guard-git', () => git(line)], ['guard-files', () => files(line)]]) {
      const t0 = cpu();
      const r = run();
      const ms = cpu() - t0;
      assert.ok(r.decision === 'allow' || r.decision === 'deny', `${who}: ${r.decision}`);
      assert.ok(ms < 6000, `${who}: ${Math.round(ms)} ms of CPU for ${name}`);
    }
  });
}
// ---- a word with a default (`${A:-w}`) after a command that can take options: the word is looked at once, not once per `${a[` ----------------------------------------------------------------------
const OLD_DEFAULTED_WORD = /\$\{!?(?:[A-Za-z_]\w*(?:\[[^\]}]*\])?|\d+|[@*#?$!-]):?[-=+]/; // (what shell-parse.mjs tested before isDefaultedWord: unbounded subscript, ~5 s of CPU on a 200 kB word)
// Why: the Windows CI runner is ~3-4x slower than a Mac (the worst shape: 0.33 s on the Mac, 1.08 s on Windows); 4 s there is still far below
// the old pattern's ~20 s on that runner (5.2 s on the Mac) and below the guard's 5 s deadline.
// (a shared CI runner measured 1184 ms on the worst shape, ~3.5× a Mac, with no code change: CI gets its own cap)
const SUBSCRIPT_CAP_MS = process.platform === 'win32' ? 4000 : process.env.CI ? 2500 : 1000;
test(`H2 a long word of unclosed subscripts after a command that can take options is answered in under ${SUBSCRIPT_CAP_MS} ms of CPU time by each guard (allow or deny, never a throw)`, () => {
  const prefixes = ['bash ', 'source ', 'node ', 'find . '];
  const units = ['${a[', '${a[x', '${a[${b[', '${!a[', '${a[1]:-${a[', '${a[]'];
  for (const prefix of prefixes) {
    for (const unit of units) {
      const line = prefix + unit.repeat(Math.floor((LIMIT - prefix.length) / unit.length));
      assert.ok(line.length <= LIMIT);
      for (const [who, run] of [['guard-git', () => git(line)], ['guard-files', () => files(line)]]) {
        const t0 = cpu();
        const r = run();
        const ms = cpu() - t0;
        assert.ok(r.decision === 'allow' || r.decision === 'deny', `${who}: ${r.decision}`);
        assert.ok(ms < SUBSCRIPT_CAP_MS, `${who}: ${Math.round(ms)} ms of CPU for ${prefix}${unit}...`); // (~0.2-0.33 s on a Mac on the worst shape)
      }
    }
  }
});
test('H2 isDefaultedWord reads a word in linear time (the pattern read to the end of the word from every `${a[`)', async () => {
  const { isDefaultedWord } = await import('../pipeline/hooks/lib/shell-parse.mjs');
  const { assertLinear, cpuTime } = await import('./helpers/timing.mjs');
  for (const unit of ['${a[', '${a[x', '${a[${b[', '${!a[']) {
    const at = (n) => () => { const w = unit.repeat(Math.floor(n / unit.length)); return cpuTime(() => assert.equal(isDefaultedWord(w), false)); };
    assertLinear(at(100_000), at(200_000), { label: `isDefaultedWord on ${unit}`, ratio: 4, slackMs: 25 });
  }
  // a long subscript is still a subscript (no bound: a bound would let the word through)
  assert.equal(isDefaultedWord('${A[' + 'x'.repeat(190_000) + ']:-w}'), true);
  assert.equal(isDefaultedWord('${a[' .repeat(40_000) + 'x]:-w}'), true);
});
test('H2 isDefaultedWord gives exactly the boolean of the pattern it replaced -- 60,000 random words and the known examples', async () => {
  const { isDefaultedWord } = await import('../pipeline/hooks/lib/shell-parse.mjs');
  const alpha = ['${', '${', '${a', '${!', '$', '{', '}', '[', '[', ']', ']', '!', 'a', '1', '@', ':', ':-', '-', '=', '+', 'x', '_', '#', '?', '*', '\n', '${a[x]:-', '${!A[', '${1-', '${@:+', '[x]', ']:-w}'];
  let seed = 987654321; // (mulberry32: the low bits of a plain LCG cycle, which starves some token pairs)
  const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
  let hits = 0;
  for (let k = 0; k < 60000; k++) {
    let t = '';
    for (let i = 1 + rnd(16); i > 0; i--) t += alpha[rnd(alpha.length)];
    const want = OLD_DEFAULTED_WORD.test(t);
    if (want) hits++;
    assert.equal(isDefaultedWord(t), want, JSON.stringify(t));
  }
  assert.ok(hits > 2000, `the fuzz must reach matching words (${hits})`);
  for (const t of ['${A:-w}', '${A-w}', '${A:=w}', '${A=w}', '${A:+w}', '${A+w}', '${A:?w}', '${A?w}', '${1:-w}', '${12-w}', '${@:-w}', '${*-w}', '${#-w}', '${?:-w}', '${$-w}', '${!-w}', '${!!-w}', '${!A:-w}', '${!A[1]:-w}',
    '${A[0]:-w}', '${A[}:-w}', '${A[x}]:-w}', '${A[x]}:-w}', '${A[1]x:-w}', '${A[${B[1]:-w}', '${A[${B}]:=w}', '${A[${B[}]:-w}', 'x${A[ ${B[2]-w}', '${A[1]', '${A[', '${A', '${', '${A:}', '${A:x}', '${A%x}', '${A/x/y}', '--opt=${A:--c}', 'a${A[\n]:-w}', '${a b:-w}', '${:-w}', '${!:-w}', '${!}', '${}']) {
    assert.equal(isDefaultedWord(t), OLD_DEFAULTED_WORD.test(t), t);
  }
  assert.equal(isDefaultedWord('${A:-w}'), true);
  assert.equal(isDefaultedWord('${A%x}'), false);
});
test('H2 a long run of quotes or blanks inside a word that ends in a slash is read once, not from every character', () => {
  const quotes = "a'" + "'".repeat(LIMIT / 2) + '/b';
  const blanks = "x '" + ' '.repeat(LIMIT / 2) + "/'";
  for (const line of [quotes, blanks, `echo ${quotes}`, `echo > ${blanks}`]) {
    const t0 = cpu();
    files(line);
    const ms = cpu() - t0;
    assert.ok(ms < 3000, `${Math.round(ms)} ms of CPU`);
  }
});
test('H2 functions and a tee with many operands are still found (the linear scans read what the patterns read)', () => {
  deny(`f() { echo x > ~/${CL}/settings.json; }; f`.replace('f() {', 'f() {'));
  deny(`tee ${Array.from({ length: 300 }, (_, i) => `o${i}`).join(' ')} ~/${CL}/settings.json < /dev/null`);
});

// ---- more cover for the pieces above ---------------------------------------------------------------------------------------------------------------------------
test('H1 more assignments than the scan follows make every name the line gives a run-time variable', () => {
  const filler = Array.from({ length: 300 }, (_, i) => `A${i}=\${U:-x};`).join(' ');
  deny(`${filler} D=\${U:-${CL}}; echo x > ~/$D/settings.json`);
});
test('H1 an assigned word longer than the scan keeps is the unknown word, not a guess', async () => {
  const { assigningDefaults } = await import('../pipeline/hooks/lib/script-candidates.mjs');
  assert.deepEqual(assigningDefaults(`: \${X:=${'a'.repeat(2000)}}`).get('X'), ['$(?)']);
  assert.deepEqual(assigningDefaults(': ${X:=w}; : ${X=v}').get('X'), ['w', 'v']);
});
test('H2 a line of open braces is read without flattening the word for each one (well under the general bound)', () => {
  const line = fill('{');
  for (const run of [() => git(line), () => files(line)]) {
    const t0 = cpu();
    run();
    const ms = cpu() - t0;
    assert.ok(ms < 1000, `${Math.round(ms)} ms of CPU`);
  }
});

// ---- the candidates are never fewer than the real values, and nothing after a place the scan gives up is left unjudged ------------------------------------------------------
test('H1 twins: a name the line gives only a harmless way stays allowed, one that can hold a protected word is refused (never looser than main)', () => {
  allow('D=${U:-x}; echo y > ~/$D/settings.json');
  allow('D=${U/x/y}; echo y > ~/$D/settings.json');
  allow('D=(a b); echo y > ~/${D[2]}/settings.json');
  allow(`F=x${CL}; D=\${F#y}; echo y > ~/$D/a.txt`);
  deny(`D=\${U:+${CL}}; echo y > ~/$D/settings.json`);
  deny(`F=x; D=\${F#x}${CL}; echo y > ~/$D/settings.json`);
  deny(`D=\${U:-x}; echo y > ~/${CL}/settings.json`);
  deny(`D=\${F:-x}; E=\${D:-${CL}}; echo y > ~/$E/settings.json`);
});
test('H2 a guarded write after the point where the parameter scans give up is still judged (both guards)', () => {
  const filler = '${'.repeat(60000); // (the scans together pass MAX_PARAM_WORK long before the end)
  const rf = files(`${filler}; echo x > ~/${CL}/settings.json`);
  assert.equal(rf.decision, 'deny', `files: ${rf.reason ?? 'allowed'}`);
  const rg = git(`${filler}; git ${'pu' + 'sh'} origin ${'ma' + 'in'}`);
  assert.equal(rg.decision, 'deny', `git: ${rg.reason ?? 'allowed'}`);
  assert.equal(files(`${filler}; echo x > ~/other.txt`).decision, 'allow');
});
test('H1 a target with more defaults than the scan reads is refused as before (the own readings stay over)', () => {
  const r = deny(`echo y > ~/${'${a:-x}'.repeat(14)}/f`);
  assert.ok(r.reason);
});

// ---- the subscript-body scan is bounded, and the bound fails closed (#81: `a[a[a[…` was 100x slower than main) ----------------------------------------------------------
test('H2 overlapping subscripts: past the body budget the arithmetic scan answers dynamic (fail closed); a line under it is read in full as before', async () => {
  const { arithAssignedNames } = await import('../pipeline/hooks/lib/shell-parse.mjs');
  const capped = arithAssignedNames('a['.repeat(100000));
  assert.equal(capped.dynamic, true, 'every name the line gave is unsure when the subscripts cannot all be read');
  assert.equal(arithAssignedNames('a['.repeat(1000)).dynamic, false, 'a line under the budget is read in full');
  const closed = arithAssignedNames('a[n=7] '.repeat(30000));
  assert.deepEqual([...closed.names], ['n'], 'closed subscripts are short: 30,000 of them are under the budget');
  assert.equal(closed.dynamic, false);
  assert.ok(arithAssignedNames('${a[n=7]}').names.has('n'));
});
test('H2 a 200 kB line of nested name-subscripts is answered quickly by both guards, and the git guard still judges what follows', () => {
  const line = fill('a[');
  // (bounds: ~0.2 s / 0.4 s locally, ~4x that on a Windows runner; the uncapped scan took 2.7 s locally, 10 s there)
  for (const [run, bound] of [[() => git(line), 1500], [() => files(line), 3000]]) {
    const t0 = cpu();
    run();
    const ms = cpu() - t0;
    assert.ok(ms < bound, `${Math.round(ms)} ms of CPU`);
  }
  const r = git(`${'a['.repeat(30000)}; git ${'pu' + 'sh'} origin ${'ma' + 'in'}`);
  assert.equal(r.decision, 'deny', `git: ${r.reason ?? 'allowed'}`);
});

test('H2 the parameter-open finder gives exactly the match of its pattern (it only replaced a quadratic scan of the subscript) -- 30,000 random texts', async () => {
  const { PARAM_OPEN, paramOpen } = await import('../pipeline/hooks/lib/script-candidates.mjs');
  const alpha = ['${', '$', '{', '}', '[', ']', 'a', 'B_', '1', '!', '@', '#', ':', '-', '=', '+', '?', ' ', '*', 'x'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 30000; k++) {
    let t = '';
    for (let i = 1 + rnd(14); i > 0; i--) t += alpha[rnd(alpha.length)];
    const a = PARAM_OPEN.exec(t);
    const b = paramOpen(t);
    assert.deepEqual(b === null ? null : [b.index, ...b], a === null ? null : [a.index, ...a], JSON.stringify(t));
  }
  for (const t of ['${a[]:-w}', '${a[}:-w}', '${a[x}]:-w}', '${a[x]}:-w}', '${a[1]-w}', '${!a[1]:+w}', '${a[1]x:-w}', '${a[${b[1]:-w}', '${a[${b}]:=w}', 'x ${a[ ${A[2]:?w}', '${a[1]', '${a[', '${!!:-w}', '${@:-w}', '${10:-w}', '${A:-${B[}]:-w}}']) {
    const a = PARAM_OPEN.exec(t);
    const b = paramOpen(t);
    assert.deepEqual(b === null ? null : [b.index, ...b], a === null ? null : [a.index, ...a], t);
  }
  // (and a long subscript, past anything a bounded pattern would read, is still a subscript)
  const long = '${A[' + 'x'.repeat(5000) + ']:-w}';
  assert.equal(paramOpen(long)?.[3], '-');
});
test('H2 lines of unclosed subscripts after `${` are answered well under the general bound (a pattern read to the end of the line from every `${`: 9 s)', () => {
  for (const unit of ['${a[', '${!a[', '"${a["', 'a[${', '${#a[', '${a[1]:-${a[']) {
    const line = fill(unit);
    for (const [who, run] of [['guard-git', () => git(line)], ['guard-files', () => files(line)]]) {
      const t0 = cpu();
      run();
      const ms = cpu() - t0;
      assert.ok(ms < 2500, `${who}: ${Math.round(ms)} ms of CPU for ${unit}`); // (~0.2 s locally, ~4x on a Windows runner)
    }
  }
});
