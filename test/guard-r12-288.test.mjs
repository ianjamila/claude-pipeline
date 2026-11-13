// PR #288 round 12: "fix + simplify, fail closed".
//   R12-B1/F1  heredoc readings (raw, bash, zsh) that end the body at different places: the parse is UNDECIDABLE and both the git and the files policy refuse it
//              (cmds.undecidable; it also sets cmds.truncated, so every caller that fails closed on a cut-short parse does)
//   R12-F2     a terminator candidate (or a delimiter word) touching a `\r` is undecidable too, quoted heredocs included
//   R12-B2     the positional exit of the `set` whitelist needs a provably literal word; a run-time or glob word is a switch
//   R12-F3     `builtin --` / `command -p --` are unwrapped; a wrapper whose next word is not a plain name, and a command word known only at run time, are cd-meaning switches
//   R12-F4     a source that switches cdablevars on anywhere makes every cd of the file (and the line's own writes) unknown, whatever the text order
// Home is /home/u and so is the cwd unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
import { cpuTimed } from './helpers/timing.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const AT = { cwd: HOME };
const PROJ = { cwd: `${HOME}/proj` };

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R12 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: option state/.test(name) ? 'allow' : 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R12 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: a bare cd/.test(name) ? 'deny' : 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const gitVerdict = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo', home: HOME, currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], readText: () => null, pathExists: () => false,
});
const PUSH = 'git push --force origin main';
const gitDenies = (cases) => {
  for (const [name, line] of cases) {
    test(`#288 R12 git policy denies: ${name}`, () => {
      const v = gitVerdict(line);
      assert.equal(v.decision, 'deny', `${JSON.stringify(line)} -> ${v.decision}`);
      assert.ok(typeof v.reason === 'string' && v.reason.length > 10);
    });
  }
};
const gitAllows = (cases) => {
  for (const [name, line] of cases) {
    test(`#288 R12 git policy allows: ${name}`, () => {
      const v = gitVerdict(line);
      assert.equal(v.decision, 'allow', `${JSON.stringify(line)} -> ${v.decision}: ${v.reason}`);
    });
  }
};

describe('R12-B1 / R12-F1: readings that end the body at different places are undecidable', () => {
  const CASES = [
    ['B1: a quote opened in the lines the readings part over', `cat <<-EOF\n\\\n\tEOF\necho '\nEOF\n'; ${PUSH}; echo '\n'\n`],
    ['F1: a second heredoc after a body the readings part over', `cat <<-A <<B\n\\\n\tA\nB\nA\n${PUSH}\nB\n`],
    ['R11-F1 input A', `cat <<-EOF\n\\\n\tEOF\n# $(${PUSH})\nEOF`],
    ['R11-F1 input B', `cat <<-EOF\n\\\n\tEOF\n${PUSH}\nEOF`],
    ['a terminator in one reading and none in the other (bash ends, zsh runs to the end)', `cat <<-EOF\n\\\n\tEOF\n`],
  ];
  gitDenies([...CASES, ['R11-B1 input: a join in the middle of a line (every reading agrees: the body is scanned)', `cat <<-EOF\nEO\\\n\tF\n# $(${PUSH})\nEOF`]]);
  for (const [name, line] of CASES) {
    test(`#288 R12 B1/F1: the parser signals undecidable (and truncated): ${name}`, () => {
      const cmds = simpleCommands(line);
      assert.equal(cmds.undecidable, true);
      assert.equal(cmds.truncated, true);
    });
  }
  test('#288 R12 B1/F1: the git policy names the cause', () => {
    const v = gitVerdict(CASES[0][1]);
    assert.match(v.reason, /heredoc/);
  });
  denies('B1/F1 (files policy)', [
    ['B1 shape', `cat <<-EOF\n\\\n\tEOF\necho '\nEOF\n'; find . -delete; echo '\n'\n`],
    ['F1 shape', `cat <<-A <<B\n\\\n\tA\nB\nA\nfind . -delete\nB\n`],
    ['R11-F1 input B shape', `cat <<-EOF\n\\\n\tEOF\nfind . -delete\nEOF`],
  ]);
  test('#288 R12 B1/F1: the files policy names the cause', () => {
    const r = run(`cat <<-EOF\n\\\n\tEOF\nfind . -delete\nEOF`);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /heredoc/);
  });
  gitAllows([
    ['an ordinary heredoc commit message (R8-F3)', "git commit -m \"$(cat <<'EOF'\nfix: a thing\n\nbody text\nEOF\n)\""],
    ['git commit -F - with a quoted heredoc', "git commit -F - <<'EOF'\nfix: a thing\nEOF\n"],
    ['<<- with tab-indented body and terminator', 'cat <<-EOF\n\tbody\n\tEOF\ngit status\n'],
    ['a backslash line every reading ends at the same place', 'cat <<EOF\ncurl -X POST \\\n  url\nEOF\ngit status\n'],
    ['a <<- body whose join line the readings agree on', 'cat <<-EOF\n\tx\\\n\ty\n\tEOF\ngit status\n'],
  ]);
  allows('heredoc', [
    ['<<- with tab-indented terminators', 'cd proj && cat <<-EOF >/dev/null\n\tbody\n\tEOF\n'],
    ['a plain heredoc whose backslash continuation agrees in every reading', 'cat <<EOF >/dev/null\ncurl -X POST \\\n  url\nEOF\n'],
  ]);
  test('#288 R12: an agreeing heredoc is neither undecidable nor truncated', () => {
    const cmds = simpleCommands('cat <<-EOF\n\tx\\\n\ty\n\tEOF\nls\n');
    assert.equal(cmds.undecidable, false);
    assert.equal(cmds.truncated, false);
    assert.deepEqual(cmds.map((c) => c.argv[0]), ['cat', 'ls']);
  });
  test('#288 R12: no terminator at all is still parsed as written (R11-F4) and is not undecidable', () => {
    const cmds = simpleCommands(`cat <<EOF\n${PUSH}`);
    assert.equal(cmds.undecidable, false);
    assert.ok(cmds.some((c) => c.argv.join(' ') === PUSH));
  });
});

describe('R12-F2: a `\\r` on a terminator candidate or on the delimiter word', () => {
  const CASES = [
    ['EOF\\r is no terminator for the shell, so the body runs on', `cat <<EOF\nEOF\r\n# $(${PUSH})\nEOF\n`],
    ['the delimiter word ends in \\r (the shell compares with `EOF\\r`)', `cat <<EOF\r\nEOF\n# $(${PUSH})\n`],
    ['a quoted heredoc: EOF\\r', `cat <<'EOF'\nEOF\r\n${PUSH}\nEOF\n`],
    ['a quoted delimiter word followed by \\r', `cat <<'EOF'\r\nEOF\n${PUSH}\n`],
    ['a <<- terminator with a \\r', `cat <<-EOF\n\tEOF\r\n# $(${PUSH})\nEOF\n`],
  ];
  gitDenies(CASES);
  for (const [name, line] of CASES) {
    test(`#288 R12 F2: undecidable: ${name}`, () => {
      const cmds = simpleCommands(line);
      assert.equal(cmds.undecidable, true);
    });
  }
  denies('F2 (files policy)', [
    ['EOF\\r', `cat <<EOF\nEOF\r\nfind . -delete\nEOF\n`],
    ['quoted, EOF\\r', `cat <<'EOF'\nEOF\r\nfind . -delete\nEOF\n`],
  ]);
  // (R13-F2: the case that stood here, a \r after the delimiter word and on the terminator line, is undecidable, not fine; the decidable boundary, a \r only inside the body, is in guard-r13-288.test.mjs)
  test('#288 R12 F2: a \\r after the delimiter word and on the terminator line is undecidable', () => {
    const cmds = simpleCommands('cat <<EOF\r\nx\r\nEOF\r\nls\n');
    assert.equal(cmds.undecidable, true);
  });
});

describe('R12: heredoc readings are linear', () => {
  test('#288 R12: a 200 kB <<- body of backslash lines (three readings) answers well under a second', () => {
    for (const line of [`cat <<-EOF\n${'\\\n'.repeat(100000)}EOF\n`, `cat <<-EOF\n${'\t\\\n'.repeat(66000)}\tEOF\n${PUSH}\nEOF\n`]) {
      const r = cpuTimed(() => simpleCommands(line));
      assert.ok(r.ms < 1000, `took ${r.ms} ms`);
    }
  });
});

describe('R12-B2: the positional exit of the set whitelist needs a literal word', () => {
  denies('B2', [
    ['set "$F"', 'F=-T; set "$F"; export proj=/home/u; cd proj && find . -delete', PROJ],
    ['set -e $F', 'F=-T; set -e $F; export proj=/home/u; cd proj && find . -delete', PROJ],
    ['set $(echo -T)', 'set $(echo -T); export proj=/home/u; cd proj && find . -delete', PROJ],
    ['set `echo -T`', 'set `echo -T`; export proj=/home/u; cd proj && find . -delete', PROJ],
    ['set * (a file named -T)', 'set *; export proj=/home/u; cd proj && find . -delete', PROJ],
    ['set -o $N (a run-time option name)', 'N=cdablevars; set -o $N; export proj=/home/u; cd proj && find . -delete', PROJ],
    ['set -e ? (a glob word)', 'set -e ?; export proj=/home/u; cd proj && find . -delete', PROJ],
  ]);
  allows('B2', [
    ['set -- a b', 'set -- a b && cd ./proj && git add .'],
    ['set -euo pipefail', 'set -euo pipefail && cd ./proj && git add .'],
    ['set -- "$@" (after a literal --)', 'set -- "$@" && cd ./proj && git add .'],
    ['set a b (literal positionals)', 'set a b && cd ./proj && git add .'],
  ]);
});

describe('R12-F3: builtin / command with --, and a command word known only at run time', () => {
  denies('F3', [
    ['builtin -- shopt -s cdable_vars', 'export proj=/home/u; builtin -- shopt -s cdable_vars; cd proj && find . -delete', PROJ],
    ['command -- set -T', 'export proj=/home/u; command -- set -T; cd proj && find . -delete', PROJ],
    ['command -p -- shopt -s cdable_vars', 'export proj=/home/u; command -p -- shopt -s cdable_vars; cd proj && find . -delete', PROJ],
    ['a run-time command word ($S -s cdable_vars)', 'S=shopt; export proj=/home/u; $S -s cdable_vars; cd proj && find . -delete', PROJ],
    ['a wrapper in front of a run-time word', 'S=set; export proj=/home/u; builtin $S -T; cd proj && find . -delete', PROJ],
    ['a wrapper in front of a glob word', 'export proj=/home/u; command se* -T; cd proj && find . -delete', PROJ],
  ]);
  allows('F3', [
    ['builtin -- echo is not a switch', 'builtin -- echo hi && cd ./proj && git add .'],
    ['command -p ls', 'command -p ls && cd ./proj && git add .'],
  ]);
});

describe('R12-F4: a source that switches cdablevars on makes every cd of the file unknown', () => {
  const stub = (files) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) });
  denies('F4', [
    ['a function that cds, defined before the nested source that switches (run after it)', 'source ./o.sh && find . -delete',
      stub({ '/home/u/proj/o.sh': 'f() { cd proj; }\nsource /home/u/proj/p.sh\nf\n', '/home/u/proj/p.sh': 'set -o cdablevars\nproj=/home/u\n' })],
    ['a loop that cds, then sources the switch (second pass)', 'source ./o.sh && find . -delete',
      stub({ '/home/u/proj/o.sh': 'for i in 1 2; do cd proj; source /home/u/proj/p.sh; done\n', '/home/u/proj/p.sh': 'set -o cdablevars\nproj=/home/u\n' })],
    ['the switch in the file itself, a cd earlier in the text, no cd on the line', 'source ./o.sh && find . -delete',
      stub({ '/home/u/proj/o.sh': 'f() { cd proj; }\nset -o cdablevars\nproj=/home/u\nf\n' })],
    ['a switched source and a later relative write (no cd ./anywhere) (R17 owner decision: option state no longer matters for a literal cd)', 'source ./o.sh && find . -delete',
      stub({ '/home/u/proj/o.sh': 'set -o cdablevars\n' })],
  ]);
  allows('F4', [
    ['a nested source with a harmless set keeps the file known', 'source ./o.sh && cd /tmp/safe && find . -delete',
      stub({ '/home/u/proj/o.sh': 'f() { cd /tmp/safe; }\nsource /home/u/proj/p.sh\nf\n', '/home/u/proj/p.sh': 'set -e\n' })],
  ]);
});
