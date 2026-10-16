// Why (PR A2, batch S6): the parser read the patterns of a `case` statement (`"$r"/*)`, `*)`, `a|b)`) as commands, so a script that sorts a path
// with `case` had a command named by a variable and every write after it was refused (superpowers SDD helpers `sdd-workspace`, `task-brief`,
// `review-package`: ~315 refusals in 21 days). Patterns are not commands, but whatever runs inside them (a substitution) or in an arm still is,
// and a pattern the shells would reject is parsed as before (as commands: strict).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleCommands, MAX_WORK } from '../pipeline/hooks/lib/shell-parse.mjs';

const argvs = (s) => simpleCommands(s).map((c) => c.argv.join(' ')).filter(Boolean); // (assignment-only commands have no argv)

test('case: patterns are not commands (multi-line, one line, alternation, leading paren)', () => {
  const cases = [
    ['case "$x" in\n  "$r"/*) y=1 ;;\n  *) y=2 ;;\nesac', ['case $x in']],
    ['case "$x" in "$r"/*) y=1 ;; esac', ['case $x in']],
    ['case $x in\n  a|b) echo a ;;\n  (c) echo c ;;\nesac', ['case $x in', 'echo a', 'echo c']],
    ['case $x in a | b ) echo a ;; ( c | d ) echo c ;; esac', ['case $x in', 'echo a', 'echo c']],
    ['case $x in\n  # a comment\n  /tmp/*) echo t ;;\nesac', ['case $x in', 'echo t']],
    ['case $x\nin a) echo a ;; esac', ['case $x', 'in', 'echo a']],
    ['if true; then case $x in a) echo a ;; esac; fi', ['true', 'case $x in', 'echo a']],
    ['case $x in a) echo 1 ;& b) echo 2 ;;& c) echo 3 ;| d) echo 4 ;; esac', ['case $x in', 'echo 1', 'echo 2', 'echo 3', 'echo 4']],
    ['case $x in a) echo esac ;; b) echo b ;; esac', ['case $x in', 'echo esac', 'echo b']],
    ['case $x in a) echo a\nesac\necho after', ['case $x in', 'echo a', 'echo after']],
    ['case $x in a) case $y in b) echo b ;; esac ;; c) echo c ;; esac', ['case $x in', 'case $y in', 'echo b', 'echo c']],
    ['case $x in esac\necho after', ['case $x in', 'echo after']],
  ];
  for (const [text, want] of cases) {
    const cs = simpleCommands(text);
    assert.deepEqual(argvs(text), want, JSON.stringify(text));
    assert.equal(!!cs.dynamic, false, `no command named by a variable: ${JSON.stringify(text)}`);
  }
});

test('case: what runs in an arm or a pattern is still a command, and the parse goes on after esac', () => {
  const includes = [
    ['case $x in main) git push origin main ;; esac', 'git push origin main'],
    ['case $x in $(git push -f)) : ;; esac', 'git push -f'],
    ['case $x in "$(git push -f)"|b) : ;; esac', 'git push -f'],
    ['case $x in `git push -f`) : ;; esac', 'git push -f'],
    ['case $x in a) : ;; esac; git push -f', 'git push -f'],
    ['case $x in a) : ;; esac && git push -f', 'git push -f'],
    ['case $x in a) cat <<EOF\n$(git push -f)\nEOF\n;; esac', 'git push -f'],
    ['y=$(case $x in a) echo a ;; esac); git push -f', 'git push -f'],
    ['y=$(case $x in a) git push -f ;; esac)', 'git push -f'],
    ['(case $x in a) : ;; esac); git push -f', 'git push -f'],
  ];
  for (const [text, want] of includes) assert.ok(argvs(text).includes(want), `${JSON.stringify(text)} -> ${JSON.stringify(argvs(text))}`);
  // a group in a pattern (extglob / zsh) is one pattern; its body is also judged like a glob qualifier's code, so `x(e:'...':)` hides nothing
  const g = argvs('case $x in x(a|b)) echo g ;; esac');
  assert.ok(g.includes('echo g') && !g.some((a) => a.startsWith('x')), JSON.stringify(g));
  assert.ok(argvs("case $x in x(e:'git push -f':)) : ;; esac").includes('git push -f'));
  assert.ok(argvs('case $x in =(git push -f)) : ;; esac').some((a) => a.includes('git push -f')));
  // the substitution's text is not glued to anything after it
  assert.deepEqual(argvs('y=$(case $x in a) echo a ;; esac); echo b'), ['case $x in', 'echo a', 'echo b']);
});

test('case: a pattern the shells reject is parsed as commands, as before (nothing it holds is dropped)', () => {
  const strict = [
    ['case $x in a; git push -f) : ;; esac', 'git push -f'],
    ['case $x in a\ngit push -f) : ;; esac', 'git push -f'],
    ['case $x in a git push -f) : ;; esac', 'git push -f'],
    ['case $x in ((a) git push -f ;; esac', 'git push -f'],
    ['case $x in a && git push -f) : ;; esac', 'git push -f'],
    ['case $x in a|#c\ngit push -f) : ;; esac', 'git push -f'],
    ['case $x in ) git push -f ;; esac', 'git push -f'],
    ['case $x in a > f) git push -f ;; esac', 'git push -f'],
    ['case $x in @(a b)) git push -f ;; esac', 'git push -f'],
  ];
  // the same with nothing after the operator but a word glued to it (no blank to fail on): ; & < > and a newline end a pattern attempt themselves
  strict.push(
    ['case $x in a;touch${IFS}f) : ;; esac', 'touch'],
    ['case $x in a&touch${IFS}f) : ;; esac', 'touch'],
    ['case $x in a\ntouch${IFS}f) : ;; esac', 'touch'],
    ['case $x do\na|touch${IFS}f) : ;; esac', 'touch'], // not `in`: no case statement as far as we know
  );
  for (const t of ['case $x in a>f) : ;; esac', 'case $x in a<f) : ;; esac']) {
    assert.ok(simpleCommands(t).some((c) => c.redirects.some((r) => r.target === 'f')), `${JSON.stringify(t)} keeps its redirect`);
  }
  for (const [text, want] of strict) assert.ok(argvs(text).some((a) => a.includes(want)),`${JSON.stringify(text)} -> ${JSON.stringify(argvs(text))}`);
});

test('case: only a `case` in command position opens one', () => {
  // `echo case x in a) ...` is no case statement: the `)` ends the line's group as before and later words stay commands
  assert.ok(argvs('echo case x in a; git push -f').includes('git push -f'));
  assert.ok(argvs("'case' x in a) git push -f ;; esac").some((a) => a.includes('git push -f')));
  assert.ok(argvs('case x do a) git push -f ;; esac').some((a) => a.includes('git push -f')));
  // a `case` word that is an argument opens nothing: in a subshell or substitution the next line is a command the shell runs
  for (const t of ['(echo case x in\ntouch${IFS}f)', 'y=$(echo case x in\ntouch|f)', 'echo case x in\ntouch|f', '(echo then case x in\ntouch|f)']) {
    assert.ok(argvs(t).some((a) => a.startsWith('touch')), `${JSON.stringify(t)} -> ${JSON.stringify(argvs(t))}`);
  }
});

test('case: nested patterns that fail after a substitution cannot multiply the work unseen (each retry is charged; over budget = truncated)', () => {
  const builds = [
    (t) => `case x in $(${t}) ;) : ;; esac`,
    (t) => `case x in "$(${t})" ;) : ;; esac`,
    (t) => `case x in a) case y in $(${t}) b ) :;; esac;; esac`,
  ];
  // (25 levels: uncharged, ~40 s here; deeper ones also trip other limits)
  for (const b of builds) for (const k of [25, 60]) {
    let t = 'true';
    for (let j = 0; j < k; j++) t = b(t);
    const cs = simpleCommands(t);
    // the work counter, not the clock (a loaded machine slows a stopwatch): charged retries run the count up to MAX_WORK, where the parse stops (within one scan of it)
    assert.ok(cs.work >= MAX_WORK && cs.work <= MAX_WORK + t.length, `work ended at the budget (${k} levels): ${cs.work} vs ${MAX_WORK}`);
    assert.equal(cs.truncated, true);
  }
});

test('case: an ordinary script with cases is not cut short', () => {
  const text = 'plan_dir=/p\ncase "$plan_dir/x" in\n  "$root"/*) id=${plan_abs#"$root"/} ;;\n  *) id=$plan_abs ;;\nesac\ny=$(case $id in a) echo a ;; *) echo b ;; esac)\necho "$y"';
  const cs = simpleCommands(text);
  assert.equal(cs.truncated, false);
  assert.equal(!!cs.dynamic, false);
});
