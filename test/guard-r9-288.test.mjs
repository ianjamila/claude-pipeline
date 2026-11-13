// PR #288 round 9: "fix + simplify". The cd narrowing is a WHITELIST: a command is read against fewer directories only when the whole line (the parser's view, `cmds.plainSeq`) is a plain
// sequence of simple commands joined by `&&`, `;` or a newline, and nothing else (no group, subshell, `!`, coproc, always, function, compound command, `[[`, `||`, `|`, `&`, no command-less segment).
//   R9-B1    `coproc { :; cd /tmp && :; } && find . -delete` (the coprocess's cd is another shell's)
//   R9-F1    `! {` + newline + `cd /nonexistent` + newline + `} && find . -delete` (the `!` is on a command-less segment)
//   R9-F2    zsh `cd /nonexistent || { } && find . -delete` (an empty group swallows the join before it), also with `&` and `|`
//   R9-F3    zsh `{ : } always {` + newline + `cd /nonexistent` + newline + `} && find . -delete`
//   R9-F4    a cd target taken from a variable (assigned in a branch or a loop, or at all) is not narrowed: only a fully literal word is
//   and the heredoc terminator spellings: the parser and the shell must agree where a body ends (quoted, indented, escaped); any doubt turns the narrowing off.
// Home is /home/u and so is the cwd; the lines are read from there.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const AT = { cwd: HOME };

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R9 ${label} denies: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: option state|R19 owner decision/.test(name) ? 'allow' : 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R9 ${label} allows: ${name}`, () => {
      const r = run(line, extra ?? AT);
      assert.equal(r.decision, /R17 owner decision: a bare cd/.test(name) ? 'deny' : 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('R9-B1: a coprocess', () => {
  denies('B1', [
    ['the Codex line', 'coproc { :; cd /tmp && :; } && find . -delete'],
    ['a one-line coproc', 'coproc cd /tmp && find . -delete'],
    ['a named coproc', 'coproc NAME { cd /tmp; } && find . -delete'],
  ]);
});

describe('R9-F1: a negated group whose body starts on the next line', () => {
  denies('F1', [
    ['! { newline cd newline }', '! {\ncd /nonexistent\n} && find . -delete'],
    ['the one-line form', '! { cd /nonexistent; } && find . -delete'],
  ]);
});

describe('R9-F2: a group that emits no command swallows the join before it', () => {
  denies('F2', [
    ['|| { } (zsh)', 'cd /nonexistent || { } && find . -delete'],
    ['& { } (zsh)', 'cd /tmp/x & { } && find . -delete'],
    ['| { } (zsh)', 'cd /tmp/x | { } && find . -delete'],
  ]);
});

describe('R9-F3: a zsh always block', () => {
  denies('F3', [
    ['{ : } always { newline cd newline }', '{ : } always {\ncd /nonexistent\n} && find . -delete'],
  ]);
});

describe('R9-F4: a cd target from a variable is not narrowed', () => {
  denies('F4', [
    ['assigned in an if branch', 'if false; then D=/tmp/x; fi\ncd $D && find . -delete'],
    ['assigned in a loop that never runs', 'for D in; do D=/tmp/x; done\ncd $D && find . -delete'],
    ['assigned after an &&', 'false && D=/tmp/x; cd $D && find . -delete'],
    ['assigned on the line before (no longer narrowed)', 'D=/tmp/x; cd $D && find . -delete'],
    ['quoted, braced and a glob', 'D=/tmp/x\ncd "${D}" && find . -delete'],
    ['a glob', 'cd /tmp/x* && find . -delete'],
    ['a ~NAME', 'cd ~root && find . -delete'],
    ['a backtick', 'cd `echo /tmp/x` && find . -delete'],
  ]);
});

describe('R9: the whitelist excludes every construct (a cd inside or around them is not trusted)', () => {
  denies('whitelist', [
    ['a brace group', '{ cd /tmp; } && find . -delete'],
    ['a subshell', '(cd /tmp) && find . -delete'],
    ['a function definition', 'f() { :; }\ncd /tmp && find . -delete'],
    ['function NAME', 'function f { :; }\ncd /tmp && find . -delete'],
    ['an if before the cd', 'if true; then :; fi\ncd /tmp && find . -delete'],
    ['a loop before the cd', 'for i in 1 2; do echo $i; done\ncd /tmp && find . -delete'],
    ['a case before the cd', 'case x in y) :;; esac\ncd /tmp && find . -delete'],
    ['[[ before the cd', '[[ -d /tmp ]]\ncd /tmp && find . -delete'],
    ['a ! earlier on the line', '! false\ncd /tmp && find . -delete'],
    ['a || earlier on the line', 'true || false\ncd /tmp && find . -delete'],
    ['a pipe earlier on the line', 'echo x | cat\ncd /tmp && find . -delete'],
    ['a background job earlier on the line', 'sleep 1 &\ncd /tmp && find . -delete'],
    ['a coproc earlier on the line', 'coproc :\ncd /tmp && find . -delete'],
  ]);
  allows('plain', [
    ['cd /tmp && find . -delete (the plain case)', 'cd /tmp && find . -delete'],
  ]);
});

describe('R9: everyday lines still narrow to the project', () => {
  allows('everyday', [
    ['~/ path then git add', 'cd ~/Claude/proj && git add .'],
    ['eslint', 'cd ./proj && npx eslint .'],
    ['mkdir then cd ./then cmake', 'mkdir build && cd ./build && cmake ..', { cwd: '/home/u/proj' }],
    ['a trailing comment', 'cd ./proj && git add . # stage'],
    ['a leading comment line (R19 owner decision: a plain cd name narrows unless CDPATH is set)', '# stage the work\ncd proj && git add .'],
    ['git commit -F - heredoc', "cd ./proj && git add . && git commit -F - <<'EOF'\nfix: the thing\n\nbody\nEOF"],
    ['git commit -m "$(cat <<EOF)"', "cd ./proj && git add . && git commit -m \"$(cat <<'EOF'\nfix: the thing\nEOF\n)\""],
    ['an assignment prefix on the cd', 'A=x cd ./proj && git add .'],
    ['a read-only line after ;', 'cd proj; git status'],
  ]);
});

// the narrowing turns on only for a parse whose plainSeq flag is set
describe('R9: cmds.plainSeq', () => {
  const plain = (line) => simpleCommands(line).plainSeq;
  test('#288 R9 plainSeq: set for && ; newline, comments and heredocs', () => {
    for (const line of ['cd a && b', 'cd a; b', 'cd a\nb', '# c\ncd a && b # d', "cat <<'EOF'\ncd /x\nEOF", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\"", 'A=x cd a && b', 'a && b >/dev/null 2>&1']) {
      assert.equal(plain(line), true, JSON.stringify(line));
    }
  });
  test('#288 R9 plainSeq: unset for every other construct', () => {
    const lines = ['{ a; }', 'a && { b; }', '( a )', '! a', 'a || b', 'a | b', 'a |& b', 'a &', 'if a; then b; fi', 'for i in 1; do a; done', 'while a; do b; done', 'until a; do b; done', 'select i in 1; do a; done', 'case x in y) a;; esac',
      '[[ a ]] && b', 'f() { a; }', 'function f { a; }', 'coproc a', 'coproc { a; }', '{ a } always { b }', 'time a', '{ }', 'a && { }', '> f', "cat <<'E F'\nx\nE F\n", 'a\n} b'];
    for (const line of lines) assert.equal(plain(line), false, JSON.stringify(line));
  });
  test('#288 R9 plainSeq: a parse that is cut short or broken is not plain', () => {
    assert.equal(plain('cd a && b <<EOF\nno terminator'), false);
    assert.equal(plain('fi && cd a'), false);
    assert.equal(plain(`cd a && echo ${'$(x) '.repeat(10)}`, 'x'), true);
  });
});

// The parser and the shell must agree where a heredoc body ends. The body below holds `cd /tmp/safe &&` as text: read as a command, it would narrow the `find` after the terminator.
describe('R9: heredoc terminator spellings', () => {
  const body = (open, term) => `cat ${open}\n\tcd /tmp/safe &&\n${term}\nfind . -delete`;
  denies('heredoc', [
    ['<<EOF', body('<<EOF', 'EOF')],
    ['<<-EOF with a tab-indented terminator', body('<<-EOF', '\tEOF')],
    ['<<"EOF"', body('<<"EOF"', 'EOF')],
    ["<<'EOF'", body("<<'EOF'", 'EOF')],
    ['<<\\EOF', body('<<\\EOF', 'EOF')],
    ['<<-"EOF" with a tab-indented terminator', body('<<-"EOF"', '\t\tEOF')],
    ['<<E""OF', body('<<E""OF', 'EOF')],
    ['<<EOF with a CR-ended terminator line', body('<<EOF', 'EOF\r')],
  ]);
  const narrowed = (open, term) => `cd /tmp/safe && cat ${open} >/dev/null && find . -delete\nbody\n${term}\n`;
  allows('heredoc', [
    ['an unquoted terminator keeps narrowing', narrowed('<<EOF', 'EOF')],
    ['a quoted terminator keeps narrowing', narrowed('<<"EOF"', 'EOF')],
    ['an escaped terminator keeps narrowing', narrowed('<<\\EOF', 'EOF')],
    ['a tab-indented <<- terminator keeps narrowing', narrowed('<<-EOF', '\tEOF')],
  ]);
  denies('heredoc fail-closed', [
    ['a CR-ended terminator line (the shell does not end the body there): narrowing off', narrowed('<<EOF', 'EOF\r')],
    ['a delimiter with a blank: narrowing off', narrowed("<<'E F'", 'E F')],
    ['a delimiter with a backslash inside quotes: narrowing off', narrowed("<<'E\\F'", 'E\\F')],
  ]);
});
