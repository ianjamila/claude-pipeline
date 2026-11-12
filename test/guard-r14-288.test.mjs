// PR #288 round 14: "fail closed, remove a class of risk".
//   R14-B1  loneQuotedRef was a regex that backtracks exponentially (`"` + `$aa` x40 + `\x"`): a linear scanner, judged in well under a second
//   R14-F1  a double-quoted word that zsh splits (`"$argv[@]"`, `"$X[*]"`, any `[` right after a reference) is no exemption
//   R14-F2  the line's own cd-meaning switch reaches the frame that judges a sourced file's OWN commands (`set -T; source ./a.sh`, a.sh holds `cd proj && find . -delete`)
//   R14-F3  a `~/...` command word and a dequoted path with a space are literal command words (no false switch)
// Home is /home/u; the cwd is /home/u/proj unless a case says otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const PROJ = { cwd: `${HOME}/proj` };
const stub = (files) => ({ cwd: `${HOME}/proj`, readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R14 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R14 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? PROJ);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};
const TAIL = 'export proj=/home/u; %W%; cd proj && find . -delete';
const tail = (word) => TAIL.replace('%W%', word);

describe('R14-B1: the lone-quoted-reference test is linear', () => {
  const PROTECTED = '; rm -f /home/u/.claude/settings.json';
  for (const n of [40, 5000]) {
    test(`#288 R14 B1: ${n} repetitions of a reference then a backslash is judged fast, and the protected write is denied`, () => {
      const line = '"' + '$aa'.repeat(n) + '\\x"' + PROTECTED;
      const t0 = Date.now();
      const r = run(line, PROJ);
      const ms = Date.now() - t0;
      assert.equal(r.decision, 'deny', `${r.decision}: ${r.reason}`);
      assert.ok(ms < 1000, `took ${ms} ms`);
    });
  }
  test('#288 R14 B1: a long accepted word (5000 references) is judged fast too', () => {
    const line = 'export proj=/home/u; "' + '$aa'.repeat(5000) + '"; cd proj && git add .';
    const t0 = Date.now();
    run(line, PROJ);
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe('R14-F1: a double-quoted word that zsh splits is no exemption', () => {
  denies('F1', [
    ['"$argv[@]" after set -- setopt cdablevars', 'set -- setopt cdablevars; ' + tail('"$argv[@]"')],
    ['"$X[@]" after X=(setopt cdablevars)', 'X=(setopt cdablevars); ' + tail('"$X[@]"')],
    ['"$X[*]"', 'X=(setopt cdablevars); ' + tail('"$X[*]"')],
    ['"$X[1]" (any subscript)', 'X=(setopt cdablevars); ' + tail('"$X[1]"')],
    ['"${X}[@]"', 'X=(setopt cdablevars); ' + tail('"${X}[@]"')],
    ['"$HERE/build.sh$X[@]"', 'X=(setopt cdablevars); ' + tail('"$X/build.sh$X[@]"')],
  ]);
  allows('F1', [
    ['"$HERE/build.sh" stays a no-switch word', 'X=/a; export proj=/home/u; "$X/b.sh"; cd proj && find . -delete'],
    ['a literal [ in the text of the word, no reference before it', 'export proj=/home/u; "a[@]"; cd proj && find . -delete'],
  ]);
});

describe('R14-F2: the line\'s own switch reaches the frame that judges a sourced file\'s own commands', () => {
  const body = 'cd proj && find . -delete\n';
  denies('F2', [
    ['set -T; source ./a.sh (relative)', 'set -T; export proj=/home/u; source ./a.sh', stub({ '/home/u/proj/a.sh': body })],
    ['setopt cdablevars; . /home/u/proj/a.sh (absolute)', 'setopt cdablevars; export proj=/home/u; . /home/u/proj/a.sh', stub({ '/home/u/proj/a.sh': body })],
    ['a nested source (a.sh sources b.sh, which holds the cd and the find)', 'set -T; export proj=/home/u; source ./a.sh', stub({ '/home/u/proj/a.sh': 'source /home/u/proj/b.sh\n', '/home/u/proj/b.sh': body })],
    ['the switch after the source in the text', 'export proj=/home/u; source ./a.sh; setopt cdablevars', stub({ '/home/u/proj/a.sh': body })],
    ['eval of a file text is not needed: source with a leading wrapper', 'set -T; export proj=/home/u; builtin source ./a.sh', stub({ '/home/u/proj/a.sh': body })],
  ]);
  allows('F2', [
    ['no switch: the same file is judged against the literal cd', 'export proj=/home/u; source ./a.sh', stub({ '/home/u/proj/a.sh': body })],
    ['a switch, but the file only holds a harmless command', 'set -T; source ./a.sh', stub({ '/home/u/proj/a.sh': 'echo hi\n' })],
  ]);
});

describe('R14-F3: a ~/ command word and a dequoted path with a space are literal', () => {
  allows('F3', [
    ['cd /tmp/x && ~/bin/tool > out.txt', 'cd /tmp/x && ~/bin/tool > out.txt'],
    ['a quoted path with a space', 'cd proj && "/Applications/Some App.app/Contents/MacOS/tool" build > log.txt'],
    ['~/ with a quoted space path', 'cd proj && ~/"My Tools/tool" build > log.txt'],
  ]);
  denies('F3', [
    ['~x as a command word', tail('~x')],
    ['~+ as a command word', tail('~+')],
    ['~- as a command word', tail('~-')],
    ['set ~x', tail('set ~x')],
    ['~/ followed by a reference', 'S=shopt; ' + tail('~/$S')],
  ]);
});
