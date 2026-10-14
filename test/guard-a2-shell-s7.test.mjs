// Why (PR A2, batch S7 — the git guard and superpowers' SDD helpers): after the cd shortcuts were dropped (owner, 2026-10-14) the git guard still refused 509 of 514
// real SDD runs. Three causes have a fix that trusts no command name: an unsure variable that only names where a command's OUTPUT goes (task-brief's
// `awk ... > "$out"` with `out` set in an if / else), a cd into an unsure directory (sdd-workspace ends with `cd -- "$dir" && pwd`: the directory is unknown from there
// on, exactly as for `cd "$(cmd)"`), and a cd inside a subshell (task-brief's `$(cd "$(dirname "$0")" && pwd)`: lost when the subshell ends). Each test pins the
// workflow that must pass next to the nearest dangerous twin that must stay refused. Fake file systems like guard-a2-shell-s6b.test.mjs.
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
const OTHER = resolve('/work/other'); // a checkout of main
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: (d) => (resolve(d) === OTHER ? 'main' : 'agent/x'), pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const DIRS = ['sub', '/home/u', '/work/other'];
const G = (command, spec = {}, o) => git(command, fakeFs(GIT_ROOT, spec, DIRS), o).decision;
const Gr = (command, spec = {}, o) => git(command, fakeFs(GIT_ROOT, spec, DIRS), o);

// ---- an unsure variable that only names where output goes ---------------------------------------------------------------------------------------------------

const IFOUT = 'out=a; if [ -n "$X" ]; then out=b; fi; ';
test('S7 git: an unsure variable that only names the file a command writes its output to is no refusal (the write itself is tracked as "any file")', () => {
  for (const c of [
    `${IFOUT}awk 1 p.md > "$out"`,
    `${IFOUT}awk 1 p.md >> "$out"`,
    `${IFOUT}sort p.md 2> "$out"`,
    `${IFOUT}sort p.md &> "$out"`,
    `${IFOUT}{ git log --oneline; git diff --stat; } > "$out"`,
    `${IFOUT}git log --oneline > "$out"`,
  ]) assert.equal(G(c), 'allow', c);
  // superpowers' task-brief: OUTFILE from the third argument, else a default
  const tb = 'set -euo pipefail\nplan=$1\nif [ $# -eq 3 ]; then\n  out=$3\nelse\n  out="sub/task-1-brief.md"\nfi\nawk \'\n  /^```/ { infence = !infence }\n\' "$plan" > "$out"\necho "wrote ${out}: $(wc -l < "$out" | tr -d \' \') lines"\n';
  assert.equal(G('bash tb plan.md 1', { tb, 'plan.md': '# Task 1' }), 'allow');
});

test('S7 git: ... but one the command reads (its input, its words, a here-string, a read-write descriptor), or a script the write may have made, is still refused', () => {
  for (const c of [
    `${IFOUT}bash < "$out"`,
    `${IFOUT}bash <<< "$out"`,
    `${IFOUT}bash <> "$out"`,
    `${IFOUT}awk 1 "$out" > x.txt`,
    `${IFOUT}echo "$out" | bash`,
    `${IFOUT}"$out" > x.txt`,
    `${IFOUT}git push origin "$out" > x.txt`,
  ]) assert.equal(G(c), 'deny', c);
  // the output may land in the script run next, and the line mentions a guarded operation
  assert.equal(G(`${IFOUT}awk 'BEGIN { print "git push origin main" }' > "$out"; bash run.sh`, { 'run.sh': 'echo hi' }), 'deny');
});

// ---- a cd into an unsure directory ---------------------------------------------------------------------------------------------------------------------------

const IFD = 'D=a; if [ -n "$X" ]; then D=b; fi; ';
test('S7 git: a cd into an unsure directory leaves the directory unknown (as `cd "$(cmd)"` does): nothing that needs it, no refusal', () => {
  for (const c of [
    `${IFD}cd "$D" && pwd`,
    `${IFD}cd -- "$D" && ls`,
    `${IFD}CDPATH= cd -- "$D" && pwd`,
    `${IFD}cd "$D"; git status`,
  ]) assert.equal(G(c), 'allow', c);
  // superpowers' sdd-workspace ends this way
  const ws = 'set -euo pipefail\nbase=sub\ndir="$base/x"\nif [ -e "$dir/plan-path" ]; then\n  dir="$base/x-y"\nfi\nprintf \'*\\n\' > "$base/.gitignore"\nCDPATH= cd -- "$dir" && pwd\n';
  assert.equal(G('bash ws plan.md', { ws }), 'allow');
});

test('S7 git: ... and whatever needs that directory is refused: a bare push, a push of HEAD, a relative script, in a script or on the line', () => {
  for (const c of [
    `${IFD}cd "$D" && git push`,
    `${IFD}cd "$D" && git push origin HEAD`,
    `${IFD}cd "$D"; bash run.sh`,
    `${IFD}pushd "$D" && git push`,
    `${IFD}cd "$D/.." && git push`,
    `${IFD}"$D"`,
  ]) assert.equal(G(c, { 'run.sh': 'echo hi' }), 'deny', c);
  assert.equal(G('bash s.sh', { 's.sh': `${IFD.replace(/; /g, '\n')}cd "$D" && git push\n` }), 'deny');
  assert.equal(G('bash s.sh', { 's.sh': 'source ./lib.sh\ngit push\n', 'lib.sh': `${IFD.replace(/; /g, '\n')}cd "$D"\n` }), 'deny');
  // (an unsure value handed to a function the text defines stays refused: that the name runs that function, and not an alias or a command found
  // elsewhere, is a name trusted -- the owner chose not to (2026-10-14). superpowers' sdd-workspace does this: `owns "$dir"`; documented in #50 / #51)
  assert.equal(G(`owns() { [ -e "$1/x" ]; }; ${IFD}owns "$D"`), 'deny');
});

test('S7 git: a cd whose target is not its one operand (zsh `cd OLD NEW`, a directory-stack entry `cd -1` / `cd +1` / `pushd +1`) leaves the directory unknown', () => {
  assert.equal(G('cd /work/repo && git push'), 'allow', '(baseline: the agent branch)');
  assert.equal(G('cd /work/other && git push'), 'deny', '(baseline: main)');
  for (const c of [
    'cd /work/repo x && git push',
    'cd -1 && git push',
    'cd +1 && git push',
    'pushd +1 && git push',
    'pushd -0 && git push',
  ]) assert.equal(G(c), 'deny', c);
});

test('S7 git: a cd inside a subshell (`$( )`, `( )`, backticks, `<( )`) is lost when it ends: the commands after it run where the line was', () => {
  for (const c of [
    'x=$(cd /work/other && pwd); git push',
    'x=$(cd /work/other; pwd); git push',
    '(cd /work/other; ls); git push',
    'x=`cd /work/other && pwd`; git push',
    'cat <(cd /work/other && ls); git push',
    'x=$(cd "$(dirname "$0")" && pwd); bash run.sh',
  ]) assert.equal(G(c, { 'run.sh': 'echo hi' }), 'allow', c);
  // superpowers' task-brief: the helper is found next to the script; the script then goes on where it started
  const tb = 'plan=$1\ndir=$(bash "$(cd "$(dirname "$0")" && pwd)/helper" "$plan")\nbash run.sh\n';
  assert.equal(G('bash tb plan.md', { tb, helper: 'echo hi', 'run.sh': 'echo hi' }), 'allow');
  assert.equal(G('bash tb plan.md', { tb, helper: 'echo hi', 'run.sh': 'git push origin main' }), 'deny', '(run.sh is judged where it runs)');
});

test('S7 git: ... inside the subshell it counts, a cd outside one (a brace group, a pipeline stage zsh may run here) still moves the line, and a branch the subshell may have switched is unknown after it', () => {
  for (const c of [
    '(cd /work/other && git push)',
    'x=$(cd /work/other && git push)',
    '(cd /work/other; x=$(pwd); git push)',
    '{ cd /work/other; }; git push',
    'cat f | cd /work/other; git push',
    'x=$(false && git checkout agent/x); git push',
    '(git checkout main); git push',
  ]) assert.equal(G(c, {}, { currentBranch: (d) => (resolve(d) === GIT_ROOT ? 'agent/x' : 'main') }), 'deny', c);
  // (the real branch is main: a switch that may not have run does not make the push safe)
  assert.equal(G('x=$(false && git checkout agent/x); git push', {}, { currentBranch: () => 'main' }), 'deny');
});

// ---- Codex round 3 (review of 34bacb5) ---------------------------------------------------------------------------------------------------------------------

const PAYLOAD = { 'payload.sh': 'git push origin main\n' };
test('S7 codex r3: a descriptor duplication (`0>&"$fd"`) can hand a readable file to stdin: an unsure word in it still counts', () => {
  assert.equal(G('fd=3; fd=4; bash 4< payload.sh 0>&"$fd"', PAYLOAD), 'deny');
  assert.equal(G('fd=3; fd=4; bash 4< payload.sh >&"$fd"', PAYLOAD), 'deny');
  assert.equal(G(`${IFOUT}sort p.md > "$out"`), 'allow', '(a plain output file still is no refusal)');
});

// run.sh is only in /work/other (a checkout of main), not in the agent repo nor the home
const OTHER_RUN = { '/work/other/run.sh': 'git push\n' };
test('S7 codex r3: a cd whose operand is a directory-stack entry built at run time (`cd -"$N"`) leaves the directory unknown, not home', () => {
  for (const c of [
    'N=1; N=0; cd -"$N" && bash run.sh',
    'N=1; N=0; cd +"$N" && bash run.sh',
    'N=1; N=0; pushd "+$N" && bash run.sh',
    'N=1; N=0; cd -"$N" && git push',
  ]) assert.equal(G(c, OTHER_RUN), 'deny', c);
});

test('S7 codex r3: a bare `cd` / `cd ~` goes to the HOME the command sees (its prefix, the line\'s assignment), or to an unknown directory when that is unsure', () => {
  for (const c of [
    'D=/work/repo; D=/work/other; HOME="$D" cd && bash run.sh',
    'HOME=/work/other cd && git push',
    'HOME=/work/other; cd && git push',
    'export HOME=/work/other; cd ~ && git push',
    'HOME=/work/other; cd ~/ && bash run.sh',
    'D=/work/repo; D=/work/other; HOME=$D; cd && git push',
  ]) assert.equal(G(c, OTHER_RUN), 'deny', c);
  assert.equal(G('HOME=/work/repo; cd && git push', OTHER_RUN), 'allow', '(a HOME the line sets, known: the agent repo)');
  assert.equal(G('cd && git push', OTHER_RUN, { home: '/work/repo' }), 'allow', '(the real home)');
});

const PROJ = '/home/u/proj';
const files = (command, spec) => {
  const fs = fakeFs(PROJ, spec, ['sub', '/home/u', '/home/u/.claude']);
  return evaluateBashForFiles(command, { home: '/home/u', env: { HOME: '/home/u', ZDOTDIR: '/home/u' }, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists }).decision;
};
// a guarded line split over three files: the middle one comments the rest out, so only a run that skips it does the guarded thing
const SPLIT_GIT = { 'a.sh': 'git pu', 'b.sh': '\n#', 'c.sh': 'sh origin main\n' };
const SPLIT_FILES = { 'a.sh': 'echo x > /home/u/.cl', 'b.sh': '\n#', 'c.sh': 'aude/settings.json\n' };
test('S7 codex r3: producers feeding one shell that may not all run (after && / ||, in an if, a loop) cannot be joined: refused', () => {
  for (const c of [
    '{ cat a.sh; false && cat b.sh; cat c.sh; } | bash',
    '{ cat a.sh; true || cat b.sh; cat c.sh; } | bash',
    '{ cat a.sh; if [ -n "$X" ]; then cat b.sh; fi; cat c.sh; } | bash',
    '{ cat a.sh; for i in 1; do cat b.sh; done; cat c.sh; } | bash',
  ]) {
    assert.equal(G(c, SPLIT_GIT), 'deny', `git: ${c}`);
    assert.equal(files(c, SPLIT_FILES), 'deny', `files: ${c}`);
  }
  assert.equal(G('{ cat a.sh; cat b.sh; } | bash', { 'a.sh': 'echo a\n', 'b.sh': 'echo b\n' }), 'allow', '(producers that all run, one after the other: joined as before)');
});

test('S7 codex r3: a file the line may have written before it is fed joined is not read from disk: refused', () => {
  const ok = { 'a.sh': 'echo a\n', 'b.sh': 'echo b\n' };
  for (const feed of ['{ cat a.sh; cat b.sh; } | bash', 'cat a.sh b.sh | bash']) {
    assert.equal(G(`printf %s 'git pu' > a.sh; printf %s 'sh origin main' > b.sh; ${feed}`, ok), 'deny', `git: ${feed}`);
    assert.equal(files(`printf %s 'echo x > /home/u/.cl' > a.sh; printf %s 'aude/settings.json' > b.sh; ${feed}`, ok), 'deny', `files: ${feed}`);
  }
  assert.equal(G('{ cat a.sh; cat b.sh; } | bash', ok), 'allow', '(nothing written on the line: read from disk)');
});
