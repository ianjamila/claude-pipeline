// PR #288 round 13: "fix + simplify, fail closed".
//   R13-B1  a command word known only at run time is a cd-meaning switch whatever the argument count (`S="shopt -s cdable_vars"; $S`)
//   R13-F1  zsh's precommand modifier `-` is a wrapper (`- setopt cdablevars`), for the files policy and for the git policy
//   R13-F2  (test) a \r only inside a heredoc body stays decidable (the R12 case that claimed so was undecidable); pinned in guard-r12-288.test.mjs and here
//   R13-F3  (1) `E` (errtrace, zsh PUSHD_SILENT) is a safe `set` flag
//   post-push  the line's own switch reaches the sources it follows; literalWord / literalCommand is a positive shape
// Home is /home/u; the cwd is /home/u/proj unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const PROJ = { cwd: `${HOME}/proj` };
const stub = (files) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R13 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R13 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const gitVerdict = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo', home: HOME, currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], readText: () => null, pathExists: () => false,
});
const PUSH = 'git push --force origin main';
const TAIL = 'export proj=/home/u; %W%; cd proj && find . -delete';
const tail = (word) => TAIL.replace('%W%', word);

describe('R13-B1: a run-time command word is a switch whatever the argument count', () => {
  const S = 'S="shopt -s cdable_vars"; ';
  denies('B1', [
    ['$S', S + tail('$S')],
    ['${=S} (zsh word splitting)', S + tail('${=S}')],
    ['$=S (zsh word splitting)', S + tail('$=S')],
    ['$(echo shopt -s cdable_vars)', tail('$(echo shopt -s cdable_vars)')],
    ['`echo shopt -s cdable_vars`', tail('`echo shopt -s cdable_vars`')],
    ['eval $S', S + tail('eval $S')],
    ['eval "$S"', S + tail('eval "$S"')],
    ['a glob command word (se*)', tail('se*')],
    ['a quoted zsh splitting expansion ("${=S})"', S + tail('"${=S}"')],
    ['a quoted (z)-split expansion', S + tail('"${(z)S}"')],
    ['a quoted command substitution', tail('"$(echo shopt -s cdable_vars)"')],
    ['a lone quoted word behind a wrapper', S + tail('builtin "$S"')],
    ['an unquoted path word', 'X=/a; ' + tail('$X/b.sh')],
  ]);
  allows('B1', [
    ['a literal command word alone', 'ls && cd proj && git add .'],
    ['a lone double-quoted parameter path, run without arguments (cannot set an option)', 'X=/a; export proj=/home/u; "$X/b.sh"; cd ./proj && find . -delete'],
    ['an assignment is no command word', 'A=1; cd proj && git add .'],
  ]);
});

describe('R13-F1: the zsh precommand modifier `-` is a wrapper', () => {
  denies('F1', [
    ['- setopt cdablevars', tail('- setopt cdablevars')],
    ['- set -T', tail('- set -T')],
    ['- emulate zsh -o cdablevars', tail('- emulate zsh -o cdablevars')],
    ['- builtin set -T (a wrapper behind it)', tail('- builtin set -T')],
    ['- $S (a run-time word behind it)', 'S="setopt cdablevars"; ' + tail('- $S')],
  ]);
  allows('F1', [
    ['- before a harmless command', '- echo hi && cd proj && git add .'],
    ['`-` as an argument of echo', 'echo - && cd proj && git add .'],
    ['`-` as an argument of a command', 'git checkout - && cd ./proj && git add .'],
    ['`-` as an argument of cat (stdin)', 'cat - < /dev/null && cd proj && git add .'],
  ]);
  for (const [name, line] of [
    ['- git push --force', `- ${PUSH}`],
    ['- - git push --force', `- - ${PUSH}`],
    ['- noglob git push --force', `- noglob ${PUSH}`],
    ['- command git push --force', `- command ${PUSH}`],
  ]) {
    test(`#288 R13 F1 git policy denies: ${name}`, () => {
      const v = gitVerdict(line);
      assert.equal(v.decision, 'deny', `${JSON.stringify(line)} -> ${v.decision}`);
      assert.doesNotMatch(v.reason, /was given a string/, 'judged as the push it is, not as a string argument');
    });
  }
  test('#288 R13 F1: the parser unwraps `-` to the command it runs', () => {
    const cmds = simpleCommands(`- ${PUSH}`);
    assert.ok(cmds.some((c) => c.argv.join(' ') === PUSH), JSON.stringify(cmds.map((c) => c.argv)));
  });
  test('#288 R13 F1: `-` as an argument is not unwrapped', () => {
    const cmds = simpleCommands('echo - git push');
    assert.ok(cmds.every((c) => c.argv[0] === 'echo'));
  });
});

describe('R13-F2: a \\r only inside a heredoc body stays decidable', () => {
  const LINE = 'cat <<EOF\nx\r\ny\r\nEOF\nls\n';
  test('#288 R13 F2: the parse is decidable, complete, and has cat and ls', () => {
    const cmds = simpleCommands(LINE);
    assert.equal(cmds.undecidable, false);
    assert.equal(cmds.truncated, false);
    assert.deepEqual(cmds.map((c) => c.argv[0]), ['cat', 'ls']);
  });
  allows('F2', [['the files policy allows it', LINE]]);
});

describe('R13-F3 (1): E is a safe set flag', () => {
  allows('F3', [
    ['set -Eeuo pipefail', 'set -Eeuo pipefail && cd proj && git add .'],
    ['a sourced lib.sh holding set -Eeuo pipefail', 'source ./lib.sh && rm -rf dist', stub({ '/home/u/proj/lib.sh': 'set -Eeuo pipefail\n' })],
  ]);
});

describe('R13 post-push (2): the line\'s own switch reaches the sources it follows', () => {
  denies('switch + source', [
    ['set -T, then a source that cds', 'set -T; export proj=/home/u; source ./a.sh && find . -delete', stub({ '/home/u/proj/a.sh': 'cd proj\n' })],
    ['setopt cdablevars after the source in the text', 'export proj=/home/u; source ./a.sh && find . -delete; setopt cdablevars', stub({ '/home/u/proj/a.sh': 'cd proj\n' })],
    ['a nested source that cds', 'set -T; export proj=/home/u; source ./a.sh && find . -delete', stub({ '/home/u/proj/a.sh': 'source /home/u/proj/b.sh\n', '/home/u/proj/b.sh': 'pushd proj\n' })],
  ]);
  allows('switch + source', [
    ['no switch: a source that cds to a literal directory', 'source ./a.sh && find . -delete', stub({ '/home/u/proj/a.sh': 'cd /tmp/safe\n' })],
  ]);
});

describe('R13 post-push (3): a literal word is a positive shape', () => {
  denies('literal shape', [
    ['set ^x (a zsh glob spelling -o cdablevars)', tail('set ^x')],
    ['set ~x', tail('set ~x')],
    ['set -e ^x', tail('set -e ^x')],
    ['set <x', tail('set \\<x')],
    ['s#etopt (a zsh glob command word)', tail('s#etopt cdablevars')],
    ['s#etopt with no argument', tail('s#etopt')],
    ['!set', tail('\\!set -T')],
  ]);
  allows('literal shape', [
    ['set -- a b', 'set -- a b && cd proj && git add .'],
    ['set -euo pipefail', 'set -euo pipefail && cd proj && git add .'],
    ['set a.b c/d e=f', 'set a.b c/d e=f && cd proj && git add .'],
  ]);
});
