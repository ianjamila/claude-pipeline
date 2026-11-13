// PR #288 round 11: "fix + simplify, fail closed".
//   R11-B1   `<<-` strips the tabs of the LOGICAL line (after backslash-newline is removed), not of every physical line: `EO\` + `<TAB>F` is not a terminator
//   R11-F1   bash and zsh part over the strip order when a logical line BEGINS with a continuation: both readings are taken (union), the lines between the earliest and the
//            latest terminator are body AND commands, so the git / files policies see a command whichever reading the shell takes
//            (probe note: bash make_here_document strips after read_secondary_line joined the line; zsh gethere strips the first physical line once, before the join. No shell is run here)
//   R11-F4   a heredoc with no terminator: the body is parsed as written (raw lines) and, when unquoted, scanned for substitutions
//   R11-B2   cdablevars applies to pushd (and chdir) as well as cd
//   R11-F2   `set` is safe by a whitelist of flag letters; setopt / unsetopt / emulate / shopt with any word are cd-meaning switches
//   R11-F3   a sourced file that switches cdablevars on reaches the line's own cd
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
    test(`#288 R11 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: option state|R19 owner decision/.test(name) ? 'allow' : 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R11 ${label} allows: ${name}`, () => {
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
    test(`#288 R11 git policy denies: ${name}`, () => {
      const v = gitVerdict(line);
      assert.equal(v.decision, 'deny', `${JSON.stringify(line)} -> ${v.decision}`);
      assert.ok(typeof v.reason === 'string' && v.reason.length > 10);
    });
  }
};

describe('R11-B1 / R11-F1: <<- tab strip and backslash-newline', () => {
  gitDenies([
    ['B1: a tab after a join in the middle of a line is not stripped (`EO\\` + TAB + `F`)', `cat <<-EOF\nEO\\\n\tF\n# $(${PUSH})\nEOF`],
    ['F1 input A: the logical line begins with a continuation (zsh keeps the tab)', `cat <<-EOF\n\\\n\tEOF\n# $(${PUSH})\nEOF`],
    ['F1 input B: ... and bash ends the body there, so the push is a command', `cat <<-EOF\n\\\n\tEOF\n${PUSH}\nEOF`],
    ['F1 first-line-tab variant A', `cat <<-EOF\n\t\\\n\tEOF\n# $(${PUSH})\nEOF`],
    ['F1 first-line-tab variant B', `cat <<-EOF\n\t\\\n\tEOF\n${PUSH}\nEOF`],
    ['plain << (raw vs joined): the push after a raw terminator', `cat <<EOF\nx\\\nEOF\n${PUSH}\nEOF`],
  ]);
  test('#288 R11 B1/F1: the parser emits the push (as a command) for input B and the first-line-tab variant', () => {
    for (const line of [`cat <<-EOF\n\\\n\tEOF\n${PUSH}\nEOF`, `cat <<-EOF\n\t\\\n\tEOF\n${PUSH}\nEOF`]) {
      const cmds = simpleCommands(line);
      assert.ok(cmds.some((c) => c.argv.join(' ') === PUSH), JSON.stringify(cmds.map((c) => c.argv)));
      assert.equal(cmds.plainSeq, false);
    }
  });
  test('#288 R11 B1: a tab at the start of a logical line is still stripped (a plain `<<-` terminator)', () => {
    const cmds = simpleCommands(`cat <<-EOF\n\tbody\n\tEOF\nls`);
    assert.deepEqual(cmds.map((c) => c.argv[0]), ['cat', 'ls']);
    assert.equal(cmds.plainSeq, true);
  });
  allows('heredoc', [
    ['<<- with tab-indented body and terminator, narrowing kept', 'cd proj && cat <<-EOF >/dev/null\n\tbody\n\tEOF\n'],
    ['a plain heredoc whose backslash continuation agrees in every reading', 'cat <<EOF >/dev/null\ncurl -X POST \\\n  url\nEOF\n'],
    ['a quoted <<- heredoc ending at the raw terminator', "cat <<-'EOF' >/dev/null\n\tx\\\n\tEOF\n"],
  ]);
  test('#288 R11 F1: agreeing readings still locate the body (heredocSpans)', () => {
    const cmds = simpleCommands('cat <<EOF >/dev/null\ncurl \\\n  url\nEOF\n');
    assert.ok(Array.isArray(cmds.heredocSpans) && cmds.heredocSpans.length === 1, JSON.stringify(cmds.heredocSpans));
  });
  test('#288 R11 F1: readings that part leave the body unlocated', () => {
    assert.equal(simpleCommands(`cat <<-EOF\n\\\n\tEOF\n${PUSH}\nEOF`).heredocSpans, null);
  });
});

describe('R11-F4: a heredoc with no terminator', () => {
  gitDenies([
    ['a `#` line holding a substitution', `cat <<EOF\n# $(${PUSH})`],
    ['a single-quoted substitution', `cat <<EOF\necho '$(${PUSH})'`],
    ['a comment line ending in a backslash does not swallow the next line', `cat <<EOF\n# x\\\n${PUSH}`],
  ]);
  test('#288 R11 F4: a quoted delimiter with no terminator is still parsed as written', () => {
    const cmds = simpleCommands(`cat <<'EOF'\n${PUSH}`);
    assert.ok(cmds.some((c) => c.argv.join(' ') === PUSH));
  });
});

describe('R11: heredoc readings are linear', () => {
  test('#288 R11: a 200 kB <<- body of backslash lines answers well under a second', () => {
    const body = '\\\n'.repeat(100000);
    for (const line of [`cat <<-EOF\n${body}EOF\n`, `cat <<-EOF\n${body}`, `cat <<-EOF\n${'\t\\\n'.repeat(66000)}\tEOF\n${PUSH}\nEOF\n`]) {
      const r = cpuTimed(() => simpleCommands(line));
      assert.ok(r.ms < 1000, `took ${r.ms} ms`);
    }
  });
  test('#288 R11: the files policy on a 200 kB <<- body of backslash lines', () => {
    const r = cpuTimed(() => run(`cat <<-EOF\n${'aaaaaaaa\\\n'.repeat(20000)}EOF\nfind . -delete`));
    assert.equal(r.r.decision, 'deny');
    assert.ok(r.ms < 1000, `took ${r.ms} ms`);
  });
});

describe('R11-B2: cdablevars applies to pushd and chdir', () => {
  denies('B2', [
    ['set -o cdablevars then pushd (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && set -o cdablevars && pushd proj && find . -delete', PROJ],
    ['setopt cdablevars then pushd (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && setopt cdablevars && pushd proj && find . -delete', PROJ],
  ]);
});

describe('R11-F2: what turns cdablevars on (whitelist for set; any option word otherwise)', () => {
  denies('F2', [
    ['set -T (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && set -T && cd proj && find . -delete', PROJ],
    ['set -eT (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && set -eT && cd proj && find . -delete', PROJ],
    ['set +T (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'set +T && cd proj && find . -delete', PROJ],
    ['unsetopt nocdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && unsetopt nocdablevars && cd proj && find . -delete', PROJ],
    ['unsetopt with any word (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'unsetopt autocd && cd proj && find . -delete', PROJ],
    ['setopt -T (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && setopt -T && cd proj && find . -delete', PROJ],
    ['emulate zsh -o cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && emulate zsh -o cdablevars && cd proj && find . -delete', PROJ],
    ['emulate -R zsh (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'emulate -R zsh && cd proj && find . -delete', PROJ],
    ['a run-time flag word (set -$F) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'F=T; set -$F && export proj=/home/u && cd proj && find . -delete', PROJ],
    ['an unknown -o name (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'set -o posix && cd proj && find . -delete', PROJ],
    ['chdir after setopt (R18-F2: chdir is a cd again, a bare target is unknown) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && setopt cdablevars && chdir proj && find . -delete', PROJ],
    ['shopt with any word (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'shopt -s extglob && cd proj && find . -delete', PROJ],
    ['builtin set -T (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && builtin set -T && cd proj && find . -delete', PROJ],
    ['command setopt cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'export proj=/home/u && command setopt cdablevars && cd proj && find . -delete', PROJ],
  ]);
  allows('F2', [
    ['set -euo pipefail stays narrowed from home', 'set -euo pipefail && cd ./proj && git add .'],
    ['set -e', 'set -e && cd ./proj && git add .'],
    ['set -x', 'set -x && cd ./proj && git add .'],
    ['set -- -T x (the words after -- are positional)', 'set -- -T x && cd ./proj && git add .'],
    ['set -o nounset', 'set -o nounset && cd ./proj && git add .'],
    ['set -efuvxCa letters', 'set -efuvxCa && cd ./proj && git add .'],
    ['a positional word ends the flags', 'set a -T && cd ./proj && git add .'],
  ]);
});

describe('R11-F3: a sourced file that switches cdablevars on', () => {
  const stub = (files) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) });
  denies('F3', [
    ['source ./o.sh holding setopt cdablevars', 'source ./o.sh && export proj=/home/u && cd proj && find . -delete', stub({ '/home/u/proj/o.sh': 'setopt cdablevars\n' })],
    ['source ./o.sh holding set -o cdablevars (a file nothing else poisons) (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'source ./o.sh && export proj=/home/u && cd proj && find . -delete', stub({ '/home/u/proj/o.sh': 'set -o cdablevars\n' })],
    ['source ./o.sh holding set -T (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'source ./o.sh && export proj=/home/u && cd proj && find . -delete', stub({ '/home/u/proj/o.sh': 'set -T\n' })],
    ['a nested source of set -o cdablevars (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'source ./o.sh && export proj=/home/u && cd proj && find . -delete',
      stub({ '/home/u/proj/o.sh': 'source /home/u/proj/p.sh\n', '/home/u/proj/p.sh': 'set -o cdablevars\n' })],
    ['a nested source (R19 owner decision: a plain cd name narrows unless CDPATH is set)', 'source ./o.sh && export proj=/home/u && cd proj && find . -delete',
      stub({ '/home/u/proj/o.sh': 'source /home/u/proj/p.sh\n', '/home/u/proj/p.sh': 'set -T\n' })],
    ['the variable set in the file too, pushd on the line', 'source ./o.sh && pushd proj && find . -delete', stub({ '/home/u/proj/o.sh': 'setopt cdablevars\nproj=/home/u\n' })],
  ]);
  allows('F3', [
    ['a sourced file with a harmless set keeps narrowing', 'source ./o.sh && cd /tmp/safe && find . -delete', stub({ '/home/u/proj/o.sh': 'set -euo pipefail\n' })],
  ]);
});
