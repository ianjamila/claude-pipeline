// Why (issue #21 + audit): a guard that runs out of time is a guard that allows (Claude Code treats a hook with no
// decision as allow), so every evaluation has hard budgets and every internal failure is a denial:
//   - one budget of script judgments for EVERY script file read (named or candidate), shared through the recursion;
//   - a wall-clock deadline well under the 15 s hook timeout (the clock is injected here, so no test depends on timing);
//   - a variable chain (`B=$A$A$A...; C=$B$B$B...`) or one huge value repeated many times must not expand without bound;
//   - an exception inside a policy (a readText that throws) is a denial, not a thrown error.
// The file system is faked like test/guard-script-expansion.test.mjs; guarded text never appears (these scripts are harmless).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { runHook } from '../pipeline/hooks/lib/hook-io.mjs';
import { MAX_SCRIPT_JUDGMENTS, EVAL_DEADLINE_MS } from '../pipeline/hooks/lib/script-candidates.mjs';
import { assertCpuUnder, assertLinear, assertLinearSteps, assertSteps, cpuTime, cpuTimed, virtualClock } from './helpers/timing.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}

const GIT_ROOT = resolve('/work/repo');
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const PROJ = '/home/u/proj';
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const gitFs = (f) => fakeFs(GIT_ROOT, f);
const filesFs = (f) => fakeFs(PROJ, f);

// A script tree generated on demand: n<level>_<i>.sh runs n<level+1>_0.sh ... n<level+1>_<lines-1>.sh (distinct names: the same
// word repeated more than 32 times in one text is already refused as ambiguous), the last level is harmless.
// Each file is a different script, so the guard has to read all of them: lines^(levels-1) reads.
const lazyFs = (root, lines, levels) => {
  const gen = (p) => {
    const m = /^n(\d+)_(\d+)\.sh$/.exec(basename(p));
    if (!m || dirname(resolve(p)) !== resolve(root) || +m[1] > levels || +m[2] >= lines) return null;
    return +m[1] === levels ? 'echo hi' : Array.from({ length: lines }, (_, i) => `bash n${+m[1] + 1}_${i}.sh`).join('\n');
  };
  return { readText: gen, pathExists: (p) => gen(p) !== null || resolve(p) === resolve(root), readDir: () => null, root };
};
const tree = (lines, levels) => ({ lazy: { lines, levels } });
const asFs = (mk, root, f) => (f.lazy ? lazyFs(root, f.lazy.lines, f.lazy.levels) : mk(f));
const both = [
  ['guard-git', (c, f, o) => git(c, asFs(gitFs, GIT_ROOT, f), o), gitFs],
  ['guard-files', (c, f, o) => files(c, asFs(filesFs, PROJ, f), o), filesFs],
];
const timed = cpuTimed; // CPU ms, not wall: a loaded machine must not trip a cap

// Step bounds: clock reads (the policy's injected `now`) counted along the completed path, the same on every machine. CEIL = 2x the count
// measured on this branch (2 significant figures), FLOOR = floor(count / 4); the clock's deadline lands at 2 x CEIL reads.
const STEPS = {
  'guard-git': { tree: { floor: 164, ceil: 1400 }, paren: { floor: 11, ceil: 88 }, bomb: { floor: 38, ceil: 310 } }, // measured 657, 44, 152
  'guard-files': { tree: { floor: 100, ceil: 810 }, paren: { floor: 10, ceil: 84 }, bomb: { floor: 37, ceil: 300 } }, // measured 403, 42, 149
};
const clockFor = ({ ceil }) => virtualClock(EVAL_DEADLINE_MS / (2 * ceil));

// ---- one budget for every script file read -----------------------------------------------------------------------

for (const [name, run] of both) {
  test(`${name}: a tree of 500 plain 'bash next.sh' lines, 4 levels deep, is denied quickly (budget on every script read)`, () => {
    const bounds = STEPS[name].tree;
    const c = clockFor(bounds);
    const { r, ms } = timed(() => run('bash n1_0.sh', tree(500, 4), { now: c.now }));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too many script files/);
    assertCpuUnder(ms, 3000, `${name} 500-line tree`);
    assertSteps(c.reads, { ...bounds, label: `${name} 500-line tree` });
  });

  test(`${name}: a smaller tree (20 lines, 3 levels = 421 reads) is denied: the budget counts named scripts, not only candidates`, () => {
    const r = run('bash n1_0.sh', tree(20, 3));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too many script files/);
  });

  test(`${name}: the budget is exactly MAX_SCRIPT_JUDGMENTS script reads`, () => {
    // a chain is limited by nesting depth, so use a flat script that runs N different harmless scripts
    const flat = (n) => ({ 'main.sh': Array.from({ length: n }, (_, i) => `bash s${i}.sh`).join('\n'), ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}.sh`, 'echo hi'])) });
    assert.equal(run('bash main.sh', flat(MAX_SCRIPT_JUDGMENTS - 1)).decision, 'allow'); // main.sh itself is one read
    assert.equal(run('bash main.sh', flat(MAX_SCRIPT_JUDGMENTS)).decision, 'deny');
  });

  test(`${name}: a normal line with a few variables and a couple of scripts is still allowed`, () => {
    const f = { 'build.sh': 'bash lint.sh\nbash test.sh', 'lint.sh': 'echo lint', 'test.sh': 'echo test' };
    assert.equal(run('V=1; W=two; echo $V $W; bash build.sh', f).decision, 'allow');
  });
}

// ---- wall-clock deadline (injected clock) --------------------------------------------------------------------------

for (const [name, run] of both) {
  test(`${name}: an evaluation past its deadline is denied ("took too long"), judged by the injected clock`, () => {
    let t = 1_000_000;
    const f = { 'a.sh': 'bash b.sh', 'b.sh': 'echo hi' };
    const inner = name === 'guard-git' ? gitFs(f) : filesFs(f);
    const slow = { ...inner, readText: (p) => { const text = inner.readText(p); t += 2 * EVAL_DEADLINE_MS; return text; } };
    const o = { now: () => t };
    const r = name === 'guard-git' ? git('bash a.sh', slow, o) : files('bash a.sh', slow, o);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long/);
    // the same chain on a clock that stands still is fine
    const fast = name === 'guard-git' ? git('bash a.sh', inner, { now: () => 5 }) : files('bash a.sh', inner, { now: () => 5 });
    assert.equal(fast.decision, 'allow');
  });
}

// ---- an exception is a denial ----------------------------------------------------------------------------------------

for (const [name, run] of both) {
  test(`${name}: a readText that throws is a denial with the error in the reason`, () => {
    const r = run('bash a.sh', { 'a.sh': 'echo hi' }, { readText: () => { throw new Error('disk gone'); } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /disk gone/);
  });
}

// ---- variable expansion is capped ----------------------------------------------------------------------------------

const chainLine = (levels) => {
  let s = 'A=xxxxxxxxxx';
  let prev = 'A';
  for (let i = 0; i < levels; i++) {
    const n = String.fromCharCode(66 + i);
    s += `; ${n}=${`$${prev}`.repeat(10)}`;
    prev = n;
  }
  return s;
};

test('guard-files: a x10-per-level variable chain is denied quickly instead of growing without bound', () => {
  const { r, ms } = timed(() => files(`${chainLine(7)}; echo ok`, filesFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assertCpuUnder(ms, 3000, 'guard-files x10 variable chain');
});

test('guard-files: a short chain that stays small is still allowed', () => {
  assert.equal(files(`${chainLine(3)}; echo ok`, filesFs({})).decision, 'allow');
});

test('guard-git: a 60k-character value repeated 1000 times in one word is denied quickly', () => {
  const line = `A=${'x'.repeat(60_000)}; git push origin ${'$A'.repeat(1000)}`;
  const { r, ms } = timed(() => git(line, gitFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assertCpuUnder(ms, 3000, 'guard-git 60k value x1000');
});

test('guard-git: a 60k-character value passed as 5000 separate arguments is denied quickly (total across the line)', () => {
  const line = `A=${'x'.repeat(60_000)}; git push origin${' $A'.repeat(5000)}`;
  const { r, ms } = timed(() => git(line, gitFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assertCpuUnder(ms, 3000, 'guard-git 60k value as 5000 arguments');
});

test('guard-files: the same 60k value repeated is denied quickly', () => {
  const line = `A=${'x'.repeat(60_000)}; cat ${'$A'.repeat(1000)}`;
  const { r, ms } = timed(() => files(line, filesFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assertCpuUnder(ms, 3000, 'guard-files 60k value x1000');
});

test('guard-git: a few small variables on a git line are still judged normally', () => {
  assert.equal(git('B=agent/x; git push origin $B', gitFs({})).decision, 'allow');
  assert.equal(git('B=main; git push origin $B', gitFs({})).decision, 'deny');
});

// ---- the hook entry points turn every failure into a denial -----------------------------------------------------------

test('runHook + guard-git policy: a readText that throws ends as a deny JSON, not an allow', async () => {
  const stdout = { out: '', write(s) { this.out += s; } };
  const evaluate = (input) => evaluateGitCommand(input.tool_input.command, {
    cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [],
    pathExists: () => true, readDir: () => null, readText: () => { throw new Error('disk gone'); },
  });
  const result = await runHook(evaluate, { stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bash a.sh' } }), stdout });
  assert.equal(result, 'deny');
  assert.match(JSON.parse(stdout.out).hookSpecificOutput.permissionDecisionReason, /disk gone/);
});

test('runHook: an evaluator that throws on a command with no guarded word is a deny too', async () => {
  const stdout = { out: '', write(s) { this.out += s; } };
  const result = await runHook(() => { throw new Error('boom'); }, { stdin: '{"tool_name":"Bash","tool_input":{"command":"ls"}}', stdout });
  assert.equal(result, 'deny');
});

// ---- exception paths that used to read as "missing" or "no match" ------------------------------------------------------

test('guard-files: an existsSync that throws is a denial, not "the script is missing"', () => {
  const inner = filesFs({ 'a.sh': 'echo hi' });
  const r = files('bash a.sh', { ...inner, pathExists: (p) => { if (p.endsWith('a.sh')) throw new Error('stat exploded'); return inner.pathExists(p); } }); // only the script lookup breaks
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /stat exploded/);
});

// ---- regressions found replaying real commands: no false positives from the two new mechanisms ---------------------------------

// A glob word whose bracket expression does not compile (`[z-a]`, `[\w-.]`) matches NOTHING in a shell and stays literal
// (there is no nullglob), so it is judged as the literal path it is: denied when that literally names a protected path,
// otherwise left alone. It used to compile to null (nothing reachable) and, in the first version of this file, to "anything".
test('guard-files: a glob that does not compile is judged as the literal word', () => {
  const d = (c) => files(c, filesFs({})).decision;
  assert.equal(d('rm ~/.claude/pipeline/[z-a]x'), 'deny'); // literally inside a protected root
  assert.equal(d('rm ~/.cl[z-a]ude/pi*'), 'deny'); // a bracket always matches ONE character, so the word can still line up with a protected root (a superset of what the shell matches)
  assert.equal(d('rm ~/.cl[z-a]ude/zzz*'), 'allow'); // ... but only if the rest lines up
  assert.equal(d('rm src/[z-a]/page.tsx'), 'allow');
  assert.equal(d('mv a.txt out/[z-a].txt'), 'allow');
});

test('guard-files: everyday words with brackets are not "reaching" a protected root', () => {
  for (const c of [
    `node -e "console.log([...new Date(0).toISOString()].join(''))"`,
    `python3 -c "print([print(c[0]) for c in 'ab'])"`,
    `python3 -c "import re; print(re.findall(r'[\\w-.]+', 'a-b'))"`,
    `node -e "console.log('x'.match(/[\\w-.]+/))"`,
    'rm src/app/[id]/page.tsx',
    'git add src/app/[id]/page.tsx',
  ]) assert.equal(files(c, filesFs({})).decision, 'allow', c);
});

// A judged file can be up to 1 MB. The expansion cap counts text ADDED by expansion, not the size of the text it is applied
// to, or `node $S/extract.mjs $S/run/index.html` with a 700 KB report beside it was denied as "variables expand ...".
test('guard-files: a big file judged as program text is not an expansion (PATH=...:$PATH and $S lines stay allowed)', () => {
  const big = `<html>\n${'<p>some report text for the page, a few words more</p>\n'.repeat(12_000)}<p>$S \${X} $PATH</p></html>`;
  assert.ok(big.length > 600_000);
  const f = filesFs({ 's/run2/report/index.html': big, 'ctx/context.md': big, 'wt/plan.md': big, 's/scripts/extract.mjs': "console.log('x')", 'x/review.mjs': "console.log('x')" });
  const lines = [
    'export PATH="/opt/bin:$PATH"; S=/home/u/proj/s; mkdir -p $S/run2 && cd $S/run2 && node $S/scripts/extract.mjs $S/run2/report/index.html $S/run2/x >/dev/null && node -e \'console.log(1)\' $S/run2/x/report.json',
    'export PATH="$HOME/.local/bin:/opt/bin:$PATH"; node "$HOME/x/review.mjs" --worktree "/home/u/proj/wt" --plan-file "/home/u/proj/wt/plan.md" --context-file "/home/u/proj/ctx/context.md" --model m > /home/u/proj/ctx/run.log 2>&1; echo "exit $?" >> /home/u/proj/ctx/run.log',
  ];
  for (const c of lines) {
    const r = files(c, f);
    assert.equal(r.decision, 'allow', `${r.reason} <- ${c.slice(0, 60)}`);
  }
});

// ---- review R1-B1: the parameter-expansion scan is one linear pass and obeys the deadline -------------------------------------------
// `: ${x:-` + 150,000 `(` + `}` used to rescan the rest of the body for every `(` (quadratic: ~21 s, past the hook timeout, which Claude Code
// reads as allow). The text after it is a push to the protected branch, built at run time so this file holds no guarded text.

const parenBomb = (n, tail) => `: \${x:-${'('.repeat(n)}}; ${tail}`;
const MAIN_PUSH = `git push origin ${'ma'}${'in'}`;
const PROTECTED_WRITE = `echo x > ~/.claude/${'sett'}${'ings.json'}`; // what guard-files refuses

for (const [name, run] of both) {
  const decide = (cmd, o) => run(cmd, {}, o);
  const BAD = name === 'guard-git' ? MAIN_PUSH : PROTECTED_WRITE;
  test(`${name}: the parenthesis scan inside \${...} is linear (CPU time at 2n vs n)`, () => {
    const sample = (n) => () => cpuTime(() => decide(parenBomb(n, 'echo hi')));
    assertLinear(sample(20_000), sample(40_000), { label: `${name} paren scan` });
    // the same scan counted in clock reads (one per 1024 characters): the count must follow the input, not the machine
    const bounds = STEPS[name].paren;
    const counted = (n) => { const c = clockFor(bounds); const r = decide(parenBomb(n, 'echo hi'), { now: c.now }); assert.equal(r.decision, 'allow'); return c.reads; };
    const half = counted(20_000);
    const full = counted(40_000);
    assertLinearSteps(half, full, `${name} paren scan`);
    assertSteps(full, { ...bounds, label: `${name} paren scan at 40000` });
  });

  test(`${name}: 150,000 open parentheses in \${...} then a guarded command is denied, and fast`, () => {
    const bounds = STEPS[name].bomb;
    const c = clockFor(bounds);
    const { r, ms } = timed(() => decide(parenBomb(150_000, BAD), { now: c.now }));
    assert.equal(r.decision, 'deny');
    assert.doesNotMatch(r.reason, /took too long|too complex/); // judged to the end: the guarded command after the parentheses is what is refused
    assertCpuUnder(ms, 3000, `${name} 150,000 parentheses`);
    assertSteps(c.reads, { ...bounds, label: `${name} 150,000 parentheses` });
  });

  test(`${name}: the parenthesis scan checks the evaluation's deadline (injected clock): past it is a denial, not an allow`, () => {
    // 400 ms per clock read: the reads before the parse are few (under the 5 s deadline), the scan's periodic reads (one per 1024 characters) push it past
    const ticking = () => { let t = 1_000_000; return { now: () => (t += 400) }; };
    const r = decide(parenBomb(40_000, 'echo hi'), ticking());
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long|too complex/);
    // a clock that stands still allows the same harmless line
    assert.equal(decide(parenBomb(40_000, 'echo hi'), { now: () => 5 }).decision, 'allow');
  });

  test(`${name}: balanced groups inside \${...} are still judged (\${x:-(bash f.sh)} runs nothing, but its body is read)`, () => {
    assert.equal(decide('echo ${x:-(echo hi)}').decision, 'allow');
    assert.equal(decide(`echo \${x:-(${BAD})}`).decision, 'deny');
    assert.equal(decide(`echo \${x:-((${BAD}))}`).decision, 'deny');
  });
}

// ---- the glob-qualifier scan is bounded in time and size ------------------------------------------------------------
// Work in the qualifier scan (`*(e{...})`) used to grow with the square of the group's length and ignore the evaluation deadline, so
// one long line could outlast the hook timeout (which Claude Code reads as allow). The scan is one pass, polls the deadline, stops
// collecting past MAX_QUALIFIER_CODES, and the parse is then `truncated`, which both policies deny when a guarded operation is named.
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

const nestedQualifier = (n) => `echo *(${'e{'.repeat(n)}x${'}'.repeat(n)})`;

for (const [name, run] of both) {
  const BAD = name === 'guard-git' ? MAIN_PUSH : PROTECTED_WRITE;
  test(`${name}: a guarded command followed by a 120,000-character nested qualifier group is denied, and fast`, () => {
    const { r, ms } = timed(() => run(`${BAD}\n${nestedQualifier(40_000)}`, {}));
    assert.equal(r.decision, 'deny');
    assertCpuUnder(ms, 2000, `${name} nested qualifier`);
  });
}

test('qualifier scan: a deeply nested group is parsed fast and the parse is truncated', () => {
  const { r, ms } = timed(() => simpleCommands(nestedQualifier(40_000)));
  assert.equal(r.truncated, true);
  assertCpuUnder(ms, 2000, 'nested qualifier parse');
});

test('qualifier scan: the scan is linear (CPU time: one parse of 16n vs 16 parses of n)', () => {
  // Equal total input, so the baseline is large: a Windows CPU clock ticks every ~15 ms and a baseline under ~30 ms is unreliable
  // (the old 2n-vs-n form read 3.0-3.8x there). A linear scan reads ~1x, a per-byte cost that climbs with input size (cache) ~2x
  // (measured on a Mac: 65 ms for 16 x n = 4,000 against 125 ms for n = 64,000), a quadratic one ~16x: 4x margin on that side.
  // n = 64,000 is a 192,009-character line, just under the 200,000-character MAX_LINE_CHARS the guards parse at all; above ~240k
  // characters the parse cost climbs steeply, which is unreachable because the guards never parse such a line.
  const parse = (n) => simpleCommands(`echo *(${'e{'.repeat(n)}x${'}'.repeat(n)})`, { maxDepth: 1 });
  const small = () => cpuTime(() => { for (let i = 0; i < 16; i++) parse(4_000); });
  const large = () => cpuTime(() => parse(64_000));
  assertLinear(small, large, { label: 'qualifier scan', factor: 1, ratio: 4 });
  // Why CPU only: this shape is cut off by the code cap after 2-15 clock reads at every size (30 at n = 500, 8 at 4,000, 2 at 64,000),
  // so a count would not follow the input and a quadratic scan would pass it.
});

test('qualifier scan: more than MAX_QUALIFIER_CODES distinct codes is truncated, 32 or fewer is not', () => {
  const group = (n) => `ls *(${Array.from({ length: n }, (_, i) => `e{echo c${i}}`).join('')})`;
  assert.equal(simpleCommands(group(40)).truncated, true);
  assert.equal(simpleCommands(group(5)).truncated, false);
});

test('qualifier scan: an expired deadline mid-scan stops it and marks the parse truncated', () => {
  const line = `ls *(${Array.from({ length: 5000 }, () => 'e{echo hi}').join('')})`;
  let polls = 0;
  const r = simpleCommands(line, { expired: () => ++polls > 3 });
  assert.equal(r.truncated, true);
  assert.ok(polls < 100, `${polls} polls`);
  assert.equal(simpleCommands(line, { expired: () => false }).truncated, false);
});
