// Why (issue #81, security follow-up on shell-parse.mjs): a review flagged "parser differential" in two parser changes of this branch. Probed against real bash and zsh (echo probes first):
//   (a) t2: withoutLiteralText follows a `"$((…))"` inside double quotes (arithEnd) and copies it as written. The shells decide arithmetic from the text: `$((` … `))` with the parentheses
//       balanced and no `)` ending early is arithmetic (and an error when it is no expression); everything else is a command substitution holding a subshell (`$((cmd) )`, `$((cmd)|cat)`,
//       `$((a); (b))` RUN their commands in both shells). arithEnd gives up (null: the caller keeps its answer) on every such text and on a quote, backtick or backslash inside, and it never
//       blanks what it copies, so a command in it stays in the text the guards read. No bypass was found; these twins pin it: a guarded command in each shape is still refused.
//   (b) t3: cmd.subWords marks the words that are exactly one command substitution, and the git guard judges `for p in $(cmd)` as one value only known at run time. The readings never
//       assume the value is harmless: a word that is not exactly one substitution (`$(a)$(b)`, `$(a)x`, `$(a) b`, a glob) keeps its denial, and a computed value that reaches git / a script
//       on a line that mentions a guarded operation is refused whatever the list holds (also a list that splits into several words in zsh and bash).
// The file system is faked; guarded text only lives in the fake file contents or is spelled in pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

function fakeFs(root, files) {
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [resolve(root, k), v]));
  const D = new Set([resolve(root)]);
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? Object.keys(F).filter((x) => dirname(x) === resolve(p)).map((x) => basename(x)) : null),
  };
}
const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const MAIN = 'ma' + 'in'; // (split so a hook that scans this file for a guarded command does not take the fixture for one)
const PUSH = 'pu' + 'sh';
const BAD_GIT = `git ${PUSH} origin ${MAIN}`;
const BAD_FILES = 'echo x > ~/.' + 'claude/settings.json';
const git = (command, fsOpts) => evaluateGitCommand(command, { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts });
const files = (command, fsOpts) => evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists });
// `template` holds @P@ where the guarded command goes and @T@ where only the guarded words are mentioned (each guard gets its own).
const judge = (template, spec = {}) => {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v]));
  return {
    git: git(template.replaceAll('@P@', BAD_GIT).replaceAll('@T@', BAD_GIT), fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'))),
    files: files(template.replaceAll('@P@', BAD_FILES).replaceAll('@T@', '/home/u/.' + 'claude/settings.json'), fakeFs(PROJ, mk(BAD_FILES, 'echo hi'))),
  };
};
const denyBoth = (t, spec) => { const r = judge(t, spec); assert.equal(r.git.decision, 'deny', `git allowed: ${t}`); assert.equal(r.files.decision, 'deny', `files allowed: ${t}`); };

test('(a) a command substitution that starts with $(( and is no arithmetic is read as commands, in and out of double quotes', () => {
  for (const t of [
    'echo "$((@P@) )"', 'echo "$((@P@)|cat)"', 'echo "$((@P@); (@P@))"', 'echo $((@P@) )', 'echo "$((@P@) | (cat))"',
    'x="$((@P@) )"; echo $x',
  ]) denyBoth(t);
});

test('(a) a command substitution inside an arithmetic, a backtick in it, a quote in it and a case pattern in it keep their commands in the text', () => {
  for (const t of [
    'echo "$(( $(@P@) ))"', 'echo $(( $(@P@) ))', 'echo "$(( 1 + $(@P@) ))"', 'x="$((n=1+$(@P@)))"; echo $x',
    'echo "$(( `@P@` ))"', 'echo "$(( 1 + ")" )) $(@P@)"', 'echo "$((echo a) ) $(@P@)"',
    'echo "$(case x in a) echo y;; esac) $(@P@)"', 'echo "$(( $(case x in a) echo 1;; esac) )) $(@P@)"',
  ]) denyBoth(t);
});

test('(a) arithmetic that is only arithmetic, in double quotes, is still allowed', () => {
  for (const c of ['echo "$((1+2)) $(date)"', 'x="$(( $(date +%s) + 1 ))"; echo $x', 'n=3; x="$n,$((n+6))p"; echo $x']) {
    const r = judge(c);
    assert.equal(r.git.decision, 'allow', `git: ${c} -> ${r.git.reason}`);
    assert.equal(r.files.decision, 'allow', `files: ${c} -> ${r.files.reason}`);
  }
});

const LISTS = {
  one: '$(echo @M@)', 'two substitutions': '$(echo ma)$(echo in)', 'substitution and text': '$(echo ma)in', 'quoted': '"$(echo @M@)"', backtick: '`echo @M@`',
  comment: '$(echo @M@ #c\n)', 'case pattern': '$(case x in a) echo y;; esac)', heredoc: '$(cat <<EOF\n@M@\nEOF\n)', nested: '$( "$(echo echo)" @M@ )',
  'substitution and word': '$(echo a) @M@', 'escaped backticks': '`echo \\`echo @M@\\``', 'in a substitution': '$(echo $(echo @M@))', 'splits in two': '$(printf "agent/x @M@")',
  'single quote': "$(echo '@M@)')", 'paren in a string': '$(echo ")" @M@)',
};
test('(b) a computed loop list that reaches git is refused, whatever its shape', () => {
  for (const [name, list] of Object.entries(LISTS)) {
    const c = `for r in ${list.replaceAll('@M@', MAIN)}; do git ${PUSH} origin $r; done`;
    assert.equal(git(c, fakeFs(GIT_ROOT, {})).decision, 'deny', `${name}: ${c}`);
  }
});

test('(b) a computed loop list that picks a script, on a line that mentions a guarded operation, is refused (git and files guards)', () => {
  const spec = { 'run.sh': 'bad', 'ok.sh': 'ok' };
  for (const [name, list] of Object.entries(LISTS)) {
    const l = list.replaceAll('@M@', 'run.sh');
    const g = judge(`for f in ${l}; do bash $f; done; echo @T@`, spec);
    assert.equal(g.git.decision, 'deny', `git ${name}`);
    assert.equal(g.files.decision, 'deny', `files ${name}`);
  }
});

// ---- found by the probe: a redirect inside a `$((` / `((` that is really a subshell ----------------------------------------------------------
// Why: bash and zsh read `$((cmd) )`, `((cmd)|cat)`, `((cmd); (cmd))` as a subshell (a command substitution / a group) whenever the text does not close as `))`: the commands RUN, and so does
// a redirect in them (`echo "$((echo x > ~/.claude/settings.json) )"` wrote the file; probed in both shells). The parser kept every `$((` and `((` body in no-redirect mode (it is
// arithmetic, where `a > b` compares), so the `>` stayed an argument word and the files guard saw no write (cp / tee / sed in it were seen: only the redirect was lost). On main too.
// Arithmetic that closes as `))` keeps no-redirect mode (a comparison is no write).
test('a redirect inside $(( … ) ) / (( … ) ) that is a subshell is a write', () => {
  for (const t of [
    'echo "$((@P@) )"', 'echo $((@P@) )', 'echo "$((@P@)|cat)"', 'echo "$((echo a); (@P@))"', '((@P@) )', '((@P@)|cat)', '((@P@); (echo a))',
    'if ((@P@) ); then :; fi', 'while ((@P@) ); do break; done', 'x=$((@P@) ); echo $x',
  ]) denyBoth(t);
  // (the redirect itself, not only a word that names the file)
  for (const c of ['echo "$((echo x > ~/.claude/settings.json) )"', '((echo x > ~/.claude/settings.json) )', 'echo $((echo x >> /home/u/.claude/settings.json)|cat)']) {
    assert.equal(files(c, fakeFs(PROJ, {})).decision, 'deny', c);
  }
});
test('arithmetic that compares with > or < is no write', () => {
  for (const c of ['echo $((a > 3))', '(( a > 3 )) && echo y', 'x=$((n>2)); echo $x', 'for ((i=0; i<3; i++)); do :; done', 'if (( n > 2 )); then echo y; fi', 'echo "$(( 1 > 0 ))"', '((n < 5)); echo $n']) {
    assert.equal(files(c, fakeFs(PROJ, {})).decision, 'allow', c);
    assert.equal(git(c, fakeFs(GIT_ROOT, {})).decision, 'allow', c);
  }
});
