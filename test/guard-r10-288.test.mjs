// PR #288 round 10: "fix + simplify, fail closed".
//   R10-B1   `:` followed by 90,000 `!` words: the plainSeq keyword check copied the word prefix per word (quadratic, no deadline poll); one running flag now
//   R10-F1   an UNQUOTED heredoc: bash and zsh remove backslash-newline before comparing a line with the delimiter (and before the `<<-` tab strip); the parser did not, so it ended the body earlier
//            and read body text (`cd /tmp/safe &&`) as a command that narrowed a later one
//   R10-F2   the same rule the other way: a terminator split by backslash-newline (`EO\` + `F`) hid the commands after it from every policy
//   R10-F3   zsh directory-stack words `cd +N`, `cd -N`, `cd -` are not directory names: not narrowed
//   R10-F4   `set -o NAME` / `set +o NAME` (cdablevars...) and `options[...]=...` change what `cd` means, like `setopt`
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
    test(`#288 R10 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: option state|R19 owner decision/.test(name) ? 'allow' : 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R10 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: a bare cd/.test(name) ? 'deny' : 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
// the git policy, the way test/guard-git.test.mjs asks it
const gitVerdict = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo', home: HOME, currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], readText: () => null, pathExists: () => false,
});

describe('R10-B1: keyword words are checked with a running flag', () => {
  test('#288 R10 B1: `:` + 90,000 ` !` answers well under a second (parser and files policy)', () => {
    const line = ':' + ' !'.repeat(90000);
    const p = cpuTimed(() => simpleCommands(line));
    assert.ok(p.ms < 1000, `simpleCommands took ${p.ms} ms`);
    const f = cpuTimed(() => run(line));
    assert.ok(f.ms < 1000, `evaluateBashForFiles took ${f.ms} ms`);
  });
  test('#288 R10 B1: keyword prefix reading is unchanged (plainSeq)', () => {
    const plain = (line) => simpleCommands(line).plainSeq;
    assert.equal(plain(': !'), true);
    assert.equal(plain('echo ! if'), true);
    assert.equal(plain('"!" a'), true);
    assert.equal(plain('! a'), false);
    assert.equal(plain('time ! a'), false);
    assert.equal(plain('if a; then b; fi'), false);
    assert.equal(plain('a { b'), false);
  });
});

describe('R10-F1: a backslash-newline before an unquoted terminator joins the lines', () => {
  const f1 = 'cat <<EOF\nx\\\nEOF\ncd /tmp/safe && cat <<true &&\nEOF\ntrue\nfind . -delete';
  denies('F1', [
    ['the reported line', f1],
    ['<<- with a tab-indented continuation', 'cat <<-EOF\n\tx\\\n\tEOF\ncd /tmp/safe && cat <<true &&\nEOF\ntrue\nfind . -delete'],
    ['three backslashes (odd run) join', 'cat <<EOF\nx\\\\\\\nEOF\ncd /tmp/safe && cat <<true &&\nEOF\ntrue\nfind . -delete'],
    ['a trailing-backslash body line with no join target', 'cat <<EOF\nx\\\nEOF\n\ncd /tmp/safe && find . -delete'],
  ]);
  test('#288 R10 F1: the parser reads `find . -delete` after the second EOF as its own command, run in the starting directory', () => {
    const cmds = simpleCommands(f1);
    assert.equal(cmds.plainSeq, false);
    assert.ok(cmds.some((c) => c.argv[0] === 'find'));
  });
});

describe('R10-F2: a terminator split by backslash-newline', () => {
  const f2 = 'cat <<EOF\nEO\\\nF\ngit push --force origin main\nEOF';
  denies('F2', [
    ['the reported line (a protected write after the split terminator)', 'cat <<EOF\nEO\\\nF\nfind . -delete\nEOF'],
  ]);
  test('#288 R10 F2: the parser emits `git push --force origin main` as a command', () => {
    const cmds = simpleCommands(f2);
    assert.ok(cmds.some((c) => c.argv.join(' ') === 'git push --force origin main'), JSON.stringify(cmds.map((c) => c.argv)));
  });
  test('#288 R10 F2: the git policy denies it', () => {
    const v = gitVerdict(f2);
    assert.equal(v.decision, 'deny', `got ${v.decision}`);
    assert.ok(typeof v.reason === 'string' && v.reason.length > 10);
  });
  test('#288 R10 F2: with a quoted delimiter the lines are compared raw (no join): the push stays heredoc text', () => {
    const cmds = simpleCommands("cat <<'EOF'\nEO\\\nF\ngit push --force origin main\nEOF");
    assert.ok(!cmds.some((c) => c.argv[0] === 'git'));
  });
  test('#288 R10 F2: a joined body line is delivered joined (a `$(` split by backslash-newline is seen)', () => {
    const cmds = simpleCommands('cat <<EOF\n$\\\n(git push --force origin main)\nEOF');
    assert.ok(cmds.some((c) => c.argv.join(' ') === 'git push --force origin main'), JSON.stringify(cmds.map((c) => c.argv)));
  });
});

describe('R10-F1/F2: quoted heredocs and plain lines are unchanged', () => {
  allows('quoted', [
    ['a quoted body with a trailing backslash ends at a raw EOF, then narrowing as before (R19 owner decision: a plain cd name narrows unless CDPATH is set)',
      "cat <<'EOF'\nx\\\nEOF\ncd proj && git add .", AT],
    ['a quoted terminator after a body line ending in a backslash', "cd proj && cat <<'EOF' >/dev/null\nx\\\nEOF\n", AT],
    ['a plain heredoc keeps narrowing', 'cd /tmp/safe && cat <<EOF >/dev/null && find . -delete\nbody\nEOF\n', AT],
  ]);
  test('#288 R10 F1: a quoted body ends at the raw terminator (the next line is a command)', () => {
    const cmds = simpleCommands("cat <<'EOF'\nx\\\nEOF\ncd proj && git add .");
    assert.deepEqual(cmds.map((c) => c.argv[0]), ['cat', 'cd', 'git']);
  });
  test('#288 R10 F1: an unquoted body with a trailing backslash line fails closed (plainSeq off)', () => {
    assert.equal(simpleCommands('cat <<EOF\nx\\\ny\nEOF\ncd proj && git add .').plainSeq, false);
    assert.equal(simpleCommands("cat <<'EOF'\nx\\\nEOF\ncd proj && git add .").plainSeq, true);
  });
});

describe('R10: heredoc joining is linear', () => {
  test('#288 R10: a 200 kB body of backslash-ended lines (unquoted)', () => {
    const line = 'cat <<EOF\n' + 'aaaaaaaa\\\n'.repeat(20000) + 'EOF\nfind . -delete';
    const r = cpuTimed(() => run(line));
    assert.equal(r.r.decision, 'deny');
    assert.ok(r.ms < 1000, `took ${r.ms} ms`);
  });
  test('#288 R10: a 200 kB body of lone-backslash lines and a <<- with tab runs', () => {
    const a = cpuTimed(() => simpleCommands('cat <<EOF\n' + '\\\n'.repeat(100000) + 'EOF\n'));
    assert.ok(a.ms < 1000, `took ${a.ms} ms`);
    const b = cpuTimed(() => simpleCommands('cat <<-EOF\n' + '\t'.repeat(50000) + '\\\n' + '\t'.repeat(50000) + '\\\nEOF\n'));
    assert.ok(b.ms < 1000, `took ${b.ms} ms`);
  });
  test('#288 R10: 100,000 heredoc-looking lines with no terminator', () => {
    const r = cpuTimed(() => simpleCommands('cat <<EOF\n' + 'EO\\\n'.repeat(50000)));
    assert.ok(r.ms < 1500, `took ${r.ms} ms`);
  });
});

describe('R10-F3: zsh directory-stack words are not narrowed', () => {
  denies('F3', [
    ['cd +0', 'cd +0 && find . -delete'],
    ['cd /tmp/safe && cd +1', 'cd /tmp/safe && cd +1 && find . -delete'],
    ['cd -', 'cd - && find . -delete'],
    ['cd -2', 'cd -2 && find . -delete'],
    ['cd -- +0', 'cd -- +0 && find . -delete'],
  ]);
  allows('F3', [
    ['an ordinary cd keeps narrowing', 'cd /tmp/safe && find . -delete'],
    ['a plus inside a name is a name (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'cd c++ && git add .'],
  ]);
});

describe('R10-F4: options that change what cd means', () => {
  denies('F4', [
    ['set -o cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && set -o cdablevars && cd proj && find . -delete', PROJ],
    ['set -ocdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && set -ocdablevars && cd proj && find . -delete', PROJ],
    ['set -eo cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && set -eo cdablevars && cd proj && find . -delete', PROJ],
    ['set +o cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'set +o cdablevars && cd proj && find . -delete', PROJ],
    ['set -o CD_ABLE_VARS (zsh spelling) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'set -o CD_ABLE_VARS && cd proj && find . -delete', PROJ],
    ['setopt cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'setopt cdablevars && cd proj && find . -delete', PROJ],
    ['shopt -s cdable_vars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'shopt -s cdable_vars && cd proj && find . -delete', PROJ],
    ['a set -o outside the safe list turns narrowing off (from home) (R17 owner decision: option state no longer matters for a literal cd)', 'set -o posix && cd /tmp/safe && find . -delete'],
    ['an options[...] assignment turns narrowing off (from home)', 'options[autocd]=on && cd /tmp/safe && find . -delete'],
    ['set -o with a run-time name (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'set -o $OPT && cd proj && find . -delete', PROJ],
    ['options[cdablevars]=on (zsh)', 'export proj=/home/u && options[cdablevars]=on && cd proj && find . -delete', PROJ],
    ['options[...] with typeset (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'typeset options[cdablevars]=on && cd proj && find . -delete', PROJ],
    ['a bare set -o (lists / unknown) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'set -o && cd proj && find . -delete', PROJ],
  ]);
  allows('F4', [
    ['set -o pipefail then a project cd ./stays narrowed', 'set -o pipefail && cd ./proj && git add .'],
    ['set -euo pipefail', 'set -euo pipefail && cd ./proj && git add .'],
    ['set -e -o errexit', 'set -e -o errexit && cd ./proj && git add .'],
    ['set +o xtrace', 'set +o xtrace && cd ./proj && git add .'],
    ['set -o nounset, noclobber, verbose', 'set -o nounset && set -o noclobber && set -o verbose && cd ./proj && git add .'],
    ['set -e (no -o)', 'set -e && cd ./proj && git add .'],
    ['set -- positional words', 'set -- -o x && cd ./proj && git add .'],
    ['narrowed from home after a safe set', 'set -o pipefail && cd /tmp/safe && find . -delete'],
  ]);
});
