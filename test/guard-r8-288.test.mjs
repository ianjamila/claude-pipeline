// PR #288 round 8: "fix + simplify". The cd narrowing no longer reads a second, flat quote scanner (withoutQuotes): it takes "did this cd surely run before the next command" from the parser's marks.
//   R8-B1    `"$(printf $'"')"` around a never-run loop hid the loop from the flat reader.
//   R8-F1    the same flip with no `$'`: a quote in single quotes, a heredoc body or a comment inside `"$( )"`.
//   R8-F2    backticks: `\\"` inside backticks is a literal quote for the shell, and a `#` right after a backtick is a comment.
//   R8-F3    (#315) an everyday `cd proj && git add . # stage`, a leading comment, `-F - <<'EOF'` and `-m "$(cat <<'EOF' … )"` narrow again (the flat reader refused them: a `#` or a `<<`).
// Home is /home/u and so is the cwd; the lines are read from there.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });

const denies = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R8 ${label} denies: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'deny', `${JSON.stringify(line)} -> ${r.decision}`);
    });
  }
};
const allows = (label, cases) => {
  for (const [name, line, extra] of cases) {
    test(`#288 R8 ${label} allows: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

// the never-run loop: its cd is not executed, so `find .` runs in home
const LOOP = 'while false; do\ncd /tmp/nonexistent\ndone && find . -delete';
const around = (wrap) => `${wrap}\n${LOOP}\n${wrap}`;

describe('R8-B1 / R8-F1: nested quotes inside a double-quoted substitution', () => {
  denies('B1/F1', [
    ['the Codex 5-line $\' case', around('echo "$(printf $\'"\')"')],
    ['a quote in single quotes inside the substitution', around('echo "$(echo \'"\')"')],
    ['a heredoc body with a quote inside the substitution', around('git commit -m "$(cat <<\'EOF\'\nsay "hi\nEOF\n)"')],
    ['a comment quote inside the substitution', around('echo "$(: # "\n)"')],
  ]);
});

describe('R8-F2: backticks', () => {
  denies('F2', [
    ['a backslash pair in backticks is a literal quote', around('echo `echo \\\\"`')],
    ['a # right after a backtick is a comment', around("echo `#'`")],
  ]);
});

// unquotedGlob (it only adds denials) fails closed on text the flat reader cannot follow: a glob option next to a nested-quote flip is still a glob option
describe('R8-B1 / F2: a glob option after a nested-quote flip is read as unquoted', () => {
  const DIR = ['~', '.claude', 'pipeline'].join('/');
  const FLIP = '"$(echo \'"\')"';
  const BT = 'echo \\\\"';
  denies('glob', [
    ['find -[d]elete between two flips', `find ${DIR} x ${FLIP} -[d]elete ${FLIP}`, { cwd: '/home/u/proj' }],
    ['find -[d]elete between two backtick flips', `find ${DIR} x \`${BT}\` -[d]elete \`${BT}\``, { cwd: '/home/u/proj' }],
  ]);
  allows('glob', [
    ['a quoted glob next to plain quotes', `find ${DIR} -name '*.mjs'`, { cwd: '/home/u/proj' }],
  ]);
});

describe('R8: the narrowing keeps refusing what the shell may not run', () => {
  const AT = { cwd: HOME };
  denies('keep', [
    ['! cd', '! cd /tmp/nonexistent && find . -delete', AT],
    ['a negated command in the chain', 'cd /tmp/nonexistent && ! true && find . -delete', AT],
    ['chdir', 'chdir /tmp/nonexistent && find . -delete', AT],
    ['eval', 'eval "cd /tmp/nonexistent" && find . -delete', AT],
    ['source', 'source ./x && cd /tmp/nonexistent && find . -delete', AT],
    ['a cd in an if condition', 'if cd /tmp/nonexistent; then :; fi && find . -delete', AT],
    ['a cd in a branch', 'if false; then cd /tmp/nonexistent; fi && find . -delete', AT],
    ['a cd in an else branch', 'if true; then :; else cd /tmp/nonexistent; fi && find . -delete', AT],
    ['a cd in a case arm', 'case x in y) cd /tmp/nonexistent;; esac && find . -delete', AT],
    ['a cd in a for loop', 'for i in 1; do cd /tmp/nonexistent; done && find . -delete', AT],
    ['a cd in an until loop', 'until true; do cd /tmp/nonexistent; done && find . -delete', AT],
    ['a cd in a function body then a call', 'f() { cd /tmp/nonexistent; }; f && find . -delete', AT],
    ['a cd in a subshell', '(cd /tmp/nonexistent) && find . -delete', AT],
    ['a cd in a brace group after ||', 'false || { cd /tmp/nonexistent; } && find . -delete', AT],
    ['a cd in a substitution', 'echo $(cd /tmp/nonexistent) && find . -delete', AT],
    ['a find in a loop after a cd (a later pass runs elsewhere)', 'cd /tmp/nonexistent && while true; do find . -delete; cd /home/u; done', AT],
    ['a comment quote hiding a while loop', "# '\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete #'", AT],
    ['a heredoc quote hiding a while loop', "cat <<'EOF'\n'\nEOF\nwhile false; do\ncd /tmp/nonexistent\ndone && find . -delete\n: '", AT],
    ['a comment quote hiding a !', "# '\n! cd /tmp/nonexistent && find . -delete #'", AT],
    ['a heredoc quote hiding a !', "cat <<EOF\n'\nEOF\n! cd /tmp/nonexistent && find . -delete\n: '", AT],
    ['a cd joined by ;', 'cd /tmp/nonexistent; find . -delete', AT],
    ['a cd joined by ||', 'cd /tmp/nonexistent || find . -delete', AT],
    ['a cd in a pipeline', 'echo x | cd /tmp/nonexistent && find . -delete', AT],
  ]);
});

describe('R8-F3 (#315): everyday lines narrow to the project', () => {
  const AT = { cwd: HOME };
  allows('F3', [
    ['a trailing comment', 'cd ~/Claude/proj && git add . # stage', AT],
    ['a leading comment', '# stage the work\ncd proj && git add .', AT],
    ['git commit -F - with a heredoc', "cd proj && git add . && git commit -F - <<'EOF'\nfix: the thing\n\nbody\nEOF", AT],
    ['git commit -m with a heredoc in a substitution', "cd proj && git add . && git commit -m \"$(cat <<'EOF'\nfix: the thing\nEOF\n)\"", AT],
    ['a plain cd narrowing', 'cd proj && git add .', AT],
    ['an if before the cd, none in its way', 'if true; then :; fi\ncd proj && git add .', AT],
    ['a loop that ended before the cd', 'for i in 1 2; do echo $i; done\ncd proj && git add .', AT],
  ]);
});

describe('R8 timing: the narrowing is linear in the line', () => {
  const timed = (label, line, want) => test(`#288 R8 timing: ${label}`, () => {
    const t0 = performance.now();
    const r = run(line);
    const ms = performance.now() - t0;
    assert.equal(r.decision, want, `${r.decision}: ${r.reason}`);
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
  timed('a 100000-pair double-quoted substitution run before rm -rf ~', `cd proj && echo ${'"$(echo x)" '.repeat(20000)} ; rm -rf ~`, 'deny');
  timed('a 20000-backtick run', `cd proj && echo ${'`x` '.repeat(10000)} ; rm -rf ~`, 'deny');
});
