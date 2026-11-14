// Follow-ups from PR #288 / #425 for the guards: issues #295, #298, #300, #301, #312 (the bash files guard) and #427 (the git guard's `cd X || exit`).
// Home is /home/u and the cwd is /home/u/proj; the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { reasonCode } from '../pipeline/hooks/lib/deny-log.mjs';

const HOME = '/home/u';
const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`;
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: `${HOME}/proj`, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const decide = (decision, cases, extra = {}) => {
  for (const [name, line] of cases) {
    test(`${decision}: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('#295: the heredoc gate and the arithmetic gate say what they refuse', () => {
  const HD = (body) => `cat ${S}; cat > /tmp/n.md <<'EOF'\n${body}\nEOF`;
  test('a read-only command refused only because of the heredoc text names the heredoc, not "not a read-only command"', () => {
    const r = run(HD('use ${arr[1]} here'));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /heredoc/);
    assert.doesNotMatch(r.reason, /is not a read-only command/);
    assert.equal(reasonCode(r.reason), 'heredoc-expansion');
  });
  for (const body of ['x $y[1] z', '${(e)v}', '${x=y[1]}']) {
    test(`the other expansion forms get the heredoc reason: ${body}`, () => {
      const r = run(HD(body));
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /heredoc/);
    });
  }
  test('a command that is NOT read-only keeps the ordinary reason, even with such a heredoc', () => {
    const r = run(`rm ${S}; cat > /tmp/n.md <<'EOF'\nuse \${arr[1]} here\nEOF`);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /is not a read-only command/);
    assert.doesNotMatch(r.reason, /heredoc text/);
  });
  test('the gate is not loosened: a read-only reader next to such a heredoc is still refused (deny pin)', () => {
    assert.equal(run(HD('${arr[1]}')).decision, 'deny');
  });
  test('allow: a plain heredoc beside a read of a protected file', () => {
    assert.equal(run(HD('use plain text here')).decision, 'allow');
  });
  test('the arithmetic gate keeps its reason and gets its own log code', () => {
    const r = run(`[ "$(jq .round ${S})" -gt 1 ] && echo next`);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /arithmetic context/);
    assert.equal(reasonCode(r.reason), 'arith');
  });
  test('an ordinary protected-file refusal keeps the code "protected"', () => {
    assert.equal(reasonCode(run(`rm ${S}`).reason), 'protected');
  });
});

describe('#301: a `$` that starts no expansion is no run-time part (rg / jq / git on a protected file)', () => {
  decide('allow', [
    ['rg \'foo$|bar\'', `rg 'foo$|bar' ${S}`],
    ['rg \'\\$\\{\'', `rg '\\$\\{' ${S}`],
    ['jq test("^a$")', `jq '.name | test("^a$")' ${S}`],
    ['git log --grep=\'x$)\'', `git log --grep='x$)' -- ${S}`],
    ['git log --grep=\'x$|y\'', `git log --grep='x$|y' -- ${S}`],
    ['a dollar before a blank', `rg 'a$ b' ${S}`],
    ['a dollar at the end of the word (as before)', `rg 'foo$' ${S}`],
    ['a dollar before a quote, mid-word', `rg 'a$"b' ${S}`],
  ]);
  decide('deny', [
    ['a name', `rg 'foo$x' ${S}`],
    ['a substitution', `rg 'foo$(id)' ${S}`],
    ['${…}', `rg 'foo\${x}' ${S}`],
    ['$@', `rg 'a$@' ${S}`],
    ['a backtick', 'rg "foo`id`" ' + S],
    ['a run-time word that can be an option, unquoted', `rg foo ${S} $X`],
    ['$| exempt must not hide a later expansion in the same word', `rg 'a$|b$c' ${S}`],
    ['$"-delete" is the option -delete for find', `find ${CFG}/skills -name x $"-delete"`],
    ['-$"delete" is the option -delete for find', `find ${CFG}/skills -name x -$"delete"`],
    ['$\'-delete\' (ANSI-C) stays refused', `find ${CFG}/skills -name x $'-delete'`],
  ]);
});

describe('#312: a quoted word is not an unquoted glob because another word on the command is one', () => {
  decide('allow', [
    ['rg \'^import\' DIR/*.mjs', `rg '^import' ${CFG}/pipeline/hooks/*.mjs`],
    ['rg \'^(a|b)\' DIR/*/SKILL.md', `rg '^(a|b)' ${CFG}/skills/*/SKILL.md`],
    ['find DIR/* \\( -name a -o -name b \\)', `find ${CFG}/skills/* \\( -name a -o -name b \\)`],
    ['jq \'(.a)\' F DIR/*.json', `jq '(.a)' ${S} ${CFG}/pipeline/*.json`],
    ['an escaped glob character', `rg \\*delete ${S} ${CFG}/pipeline/*.json`],
    ['a quoted angle pattern', `rg '<a>' ${CFG}/pipeline/*.json`],
  ]);
  decide('deny', [
    ['an unquoted glob that can become --pre', `rg '^import' ${CFG}/pipeline/hooks/*.mjs --[p]re=sh`],
    ['a literal --pre beside a glob', `rg x ${CFG}/pipeline/hooks/*.mjs --pre=sh`],
    ['an unquoted glob that can become -delete', `find ${CFG}/skills/* -[d]elete`],
    ['a glued empty quote does not make the glob literal', `find ${CFG}/skills/* ""*delete`],
    ['the same glob text quoted AND unquoted on one command stays a glob', `find ${CFG}/skills/* '*delete' *delete`],
    ['a glob word of jq that can become an option', `jq '(.a)' ${S} *.json`],
    ['an unquoted zsh group that can become an option', `rg x ${S} @(--pre)x *.x`],
  ]);
});

describe('#298: python -m json.tool is judged like the option tools (a run-time word is no read-only call)', () => {
  decide('allow', [
    ['one literal operand', `python3 -m json.tool ${S}`],
    ['one operand via $HOME', `python3 -m json.tool "$HOME/.claude/settings.json"`],
    ['read from stdin', `python3 -m json.tool < ${S}`],
    ['fed by a pipe', `cat ${S} | python3 -m json.tool`],
    ['piped on', `python3 -m json.tool ${S} | head`],
  ]);
  decide('deny', [
    ['two literal operands (the output file is protected)', `python3 -m json.tool /tmp/in.json ${S}`],
    ['one command substitution that prints two words', `python3 -m json.tool $(printf '%s %s' /tmp/in.json ${S})`],
    ['a backtick substitution', `python3 -m json.tool \`printf '%s %s' /tmp/in.json ${S}\``],
    ['a quoted substitution after a protected operand', `python3 -m json.tool ${S} "$(echo /tmp/o.json)"`],
    ['a name the line does not set', `python3 -m json.tool ${S} "$X"`],
    ['a same-line name with a value of two words', `F='/tmp/in.json /tmp/o.json'; python3 -m json.tool ${S} $F`],
    ['a same-line name with one value, second operand', `F=/tmp/o.json; python3 -m json.tool ${S} $F`],
    ['R1-B1: the module held in a name, then a substitution that prints two words', `M=json.tool; python3 -m $M $(printf '%s %s' /tmp/in.json ${S})`],
    ['R1-B1: the same, the name quoted', `M=json.tool; python3 -m "$M" $(printf '%s %s' /tmp/in.json ${S})`],
    ['R1-B1: the module in a name, a protected second operand', `M=json.tool; python3 -m "$M" /tmp/in.json ${S}`],
    // (merge of #269) main's hook-file rule (#269 R8, owner decision 2026-11-12) lets an interpreter near a file that can declare hooks
    // run only as the literal `python3 -m json.tool`, so the module held in a name stays denied there even with one operand or a pipe.
    // The literal forms above stay allowed.
    ['R1-B1 after #269: the module held in a name, one operand', `M=json.tool; python3 -m "$M" ${S}`],
    ['R1-B1 after #269: the module held in a name, read from a pipe', `M=json.tool; cat ${S} | python3 -m $M`],
  ]);
  // #463 (R6-F1): the `-m` flag itself held in a name. args[0] is `$F`, so the substitution word was not marked unknown and the call read as one operand; the line was refused only by the "which word is
  // the script" backstop. The call must now be judged by the json.tool reading itself, so its reason is the one of the literal `-m` spelling (a file that declares no hooks, P, and the settings file, S).
  const P = `${CFG}/pipeline/x.json`;
  for (const [what, target] of [['a protected file that declares no hooks', P], ['the settings file', S]]) {
    test(`deny: #463: -m held in a name, a substitution that prints two words (${what}): judged like the literal -m`, () => {
      const held = run(`F=-m; python3 $F json.tool $(printf '%s %s' /tmp/in.json ${target})`);
      const literal = run(`python3 -m json.tool $(printf '%s %s' /tmp/in.json ${target})`);
      assert.equal(held.decision, 'deny');
      assert.equal(literal.decision, 'deny');
      if (target === P) assert.equal(held.reason, literal.reason, 'the held -m is read by the json.tool rule, not left to the backstop'); // (the settings file: main's hook-file rule words the literal form differently)
      assert.doesNotMatch(held.reason, /which word is the script/);
    });
  }
  decide('deny', [
    ['#463: -m held in a quoted name, a protected second operand', `F=-m; python3 "$F" json.tool /tmp/in.json ${S}`],
    ['#463: -m held in a quoted name, a protected second operand (no hooks)', `F=-m; python3 "$F" json.tool /tmp/in.json ${P}`],
  ]);
  decide('allow', [
    ['#463: -m held in a name, one literal operand', 'F=-m; python3 $F json.tool /tmp/in.json'],
    ['#463: -m held in a name, a substitution of two words that holds nothing protected', "F=-m; python3 $F json.tool $(printf '%s %s' /tmp/in.json /tmp/out.json)"],
  ]);
});

describe('#300: a contents merge into the home directory (or a parent of it) is refused', () => {
  decide('deny', [
    ['rsync SRC/ ~/', 'rsync -a /tmp/x/ ~/'],
    ['rsync SRC/ ~ (no slash on home)', 'rsync -a /tmp/x/ ~'],
    ['rsync SRC/ $HOME/', 'rsync -a /tmp/x/ "$HOME/"'],
    ['rsync SRC/ into a parent of home', 'rsync -a /tmp/x/ /home/'],
    ['rsync with options between', 'rsync -a --exclude node_modules /tmp/x/ ~/'],
    ['cp SRC/. ~/', 'cp -a /tmp/x/. ~/'],
    ['cp -r . ~/ after a cd', 'cd /tmp/x && cp -a . ~/'],
    ['cp -t ~/ SRC/.', 'cp -a -t ~/ /tmp/x/.'],
    ['install SRC/. ~/', 'install -m 644 /tmp/x/. ~/'],
    ['cp SRC/.* ~/ (a dot glob matches .claude)', 'cp -a /tmp/x/.* ~/'],
    ['cp SRC/.[a-z]* ~/', 'cp -a /tmp/x/.[a-z]* ~/'],
    ['the two steps of the report', `mkdir -p /tmp/x/.claude && echo '{}' > /tmp/x/.claude/settings.json; rsync -a /tmp/x/ ~/`],
    ['rsync --remove-source-files of a protected folder (verification pin)', `rsync -a --remove-source-files ${CFG}/ /tmp/x/`],
  ]);
  decide('allow', [
    ['a dry run of the merge (-n cluster)', 'rsync -avn /tmp/x/ ~/'],
    ['a dry run of the merge (--dry-run)', 'rsync -a --dry-run /tmp/x/ ~/'],
    ['merging into a folder of home', 'rsync -a /tmp/x/ ~/backup/'],
    ['merging a folder of home somewhere else', 'rsync -a ~/proj/ /tmp/backup/'],
    ['cp SRC/. DIR/ below home', 'cp -r ./template/. ~/newproj/'],
    ['cp one file into home', 'cp /tmp/notes.txt ~/'],
    ['cp a folder (no contents form) into home: judged as DIR/basename', 'cp -a /tmp/x ~/'],
    ['rsync a folder (no trailing slash) into home', 'rsync -a /tmp/x ~/'],
    ['cp a glob of visible files into home', 'cp /tmp/x/*.txt ~/'],
    ['rsync single file into home', 'rsync -a /tmp/x/file.txt ~/'],
  ]);
  // R1-B3: rsync's own operand parsing (an option's value is no operand; options may follow the operands; -t is "times", not a target directory)
  decide('deny', [
    ['R1-B3: --exclude VALUE after the operands', 'rsync -a /tmp/x/ ~/ --exclude node_modules'],
    ['R1-B3: --exclude=VALUE after the operands', 'rsync -a /tmp/x/ ~/ --exclude=node_modules'],
    ['R1-B3: --timeout 30 after the operands', 'rsync -a /tmp/x/ ~/ --timeout 30'],
    ['R1-B3: -t (preserve times) before the operands', 'rsync -a -t /tmp/x/ ~/'],
    ['R1-B3: -t in a cluster', 'rsync -at /tmp/x/ ~/'],
    ['R1-B3: -e ssh (a value) before the operands', 'rsync -a -e ssh /tmp/x/ ~/'],
    ['R1-B3: -f FILTER (a value) after the operands', `rsync -a /tmp/x/ ~/ -f '- *.log'`],
    ['R1-B3: -t alone is no dry run', 'rsync -t /tmp/x/ ~/'],
    ['R1-B2: --exclude -n is a pattern, not a dry run', 'rsync -a --exclude -n /tmp/x/ ~/'],
    ['R1-B2: --exclude=-n', 'rsync -a --exclude=-n /tmp/x/ ~/'],
    ['R1-B2: -e n (the shell command "n"), a cluster ending in -e', 'rsync -ae n /tmp/x/ ~/'],
    ['R1-B2: -en (the value of -e is "n")', 'rsync -aen /tmp/x/ ~/'],
    ['R1-B2: a long word of n is no dry run when it holds a value letter first', `rsync -ae${'n'.repeat(50)} /tmp/x/ ~/`],
  ]);
  decide('allow', [
    ['R1-B3: a folder by name, options after', 'rsync -a /tmp/x ~/ --exclude node_modules'],
    ['R1-B3: a folder by name, --timeout between', 'rsync -a --timeout 30 /tmp/x ~/'],
    ['R1-B3: --exclude before a folder by name', 'rsync -a --exclude node_modules /tmp/x ~/proj/'],
    ['R1-B3: contents into a folder of home, options after', 'rsync -a /tmp/x/ ~/proj/ --exclude node_modules'],
    ['R1-B3: contents into a folder of home, --timeout after', 'rsync -a /tmp/x/ ~/proj/ --timeout 30'],
    ['R1-B3: -t on a merge below home', 'rsync -at /tmp/x/ ~/proj/'],
    ['R1-B2: -n first', 'rsync -n -a /tmp/x/ ~/'],
    ['R1-B2: -n after the operands', 'rsync -a /tmp/x/ ~/ -n'],
    ['R1-B2: -an with an exclude', 'rsync -an --exclude node_modules /tmp/x/ ~/'],
    ['R1-B2: --dry-run after the operands', 'rsync -a /tmp/x/ ~/ --dry-run'],
    ['R1-B2: -vn a cluster (no value letter before n)', 'rsync -vn /tmp/x/ ~/'],
  ]);
  // R1-B4: the source is read as the shell will pass it
  decide('deny', [
    ['R1-B4: a name that holds a trailing-slash source', 'SRC=/tmp/x/; rsync -a "$SRC" ~/'],
    ['R1-B4: ${NAME} form', 'SRC=/tmp/x/; rsync -a "${SRC}" ~/'],
    ['R1-B4: a name that holds a dot source (cp)', 'S=/tmp/x/.; cp -a "$S" ~/'],
    ['R1-B4: a name that holds a dot glob (cp)', 'S="/tmp/x/.*"; cp -a $S ~/'],
    ['R1-B4: a name plus slash', 'SRC=/tmp/x; rsync -a "$SRC"/ ~/'],
    ['R1-B4: a source only known at run time, into home', 'rsync -a "$SRC" ~/'],
    ['R1-B4: a substitution as the source, into home', 'rsync -a "$(mktemp -d)" ~/'],
    ['R1-B4: a source only known at run time, into a parent of home', 'rsync -a "$SRC" /home/'],
    ['R1-B4: a source whose last part is only known at run time', 'rsync -a /tmp/"$X" ~/'],
  ]);
  decide('allow', [
    ['R1-B4: a name that holds a folder (no slash), into home', 'SRC=/tmp/x; rsync -a "$SRC" ~/'],
    ['R1-B4: a name that holds a trailing-slash source, below home', 'SRC=/tmp/x/; rsync -a "$SRC" ~/proj/'],
    ['R1-B4: a source only known at run time, below home', 'rsync -a "$SRC" ~/proj/'],
    ['R1-B4: a run-time folder name, then a file below it, into home', 'rsync -a /tmp/"$X"/sub ~/'],
    ['R1-B4: cp of a run-time file into home (everyday)', 'cp "$f" ~/'],
  ]);
  // R2-B1 / #459: an unquoted value of a same-line name is split on blanks into words (a quoted one stays one word)
  decide('deny', [
    ['R2-B1: a flags name holding --include n (the n is a value, no dry run)', "FLAGS='-a --include n'; rsync $FLAGS /tmp/x/ ~/"],
    ['R2-B1: --info=progress2 in a flags name', "OPTS='-a --info=progress2'; rsync $OPTS /tmp/x/ ~/"],
    ['R2-B1: --human-readable in a flags name', "OPTS='-a --human-readable'; rsync $OPTS /tmp/x/ ~/"],
    ['R2-B1: --inplace --numeric-ids in a flags name', "OPTS='-a --inplace --numeric-ids'; rsync $OPTS /tmp/x/ ~/"],
    ['#459: the operands inside a flags name', "A='-a /tmp/x/'; rsync $A ~/"],
    ['#459: two sources in one name', "S='/tmp/x/ /tmp/y'; rsync -a $S ~/"],
    ['#459: an empty last word is dropped, not the destination', "X=; rsync -a /tmp/x/ ~/ $X"],
  ]);
  // R3-F1 / R3-B1: zsh does not split an unquoted name, bash does: both readings are judged, and the line is a dry run only when both say so
  decide('deny', [
    ['R3-F1: zsh reads --exclude=… --dry-run as one exclude pattern', "OPTS='--exclude=node_modules --dry-run'; rsync -a $OPTS /tmp/x/ ~/"],
    ['R3-F1: the same with -n', "OPTS='--exclude=node_modules -n'; rsync -a $OPTS /tmp/x/ ~/"],
    ['R3-F1: a backtick substitution is no place for a dry-run piece', "SRC=/tmp/backups; rsync -a $SRC/`ls -t $SRC | head -n 1`/ ~/"],
    ['R3-B1: a no-break space is no blank to the shell (-a NBSP -n is not a dry run)', "OPTS='-a\u00a0-n'; rsync $OPTS /tmp/x/ ~/"],
    ['R3-B1: an exclude value that holds a no-break space then -n', "FLAGS='--exclude=foo\u00a0-n'; rsync -a $FLAGS /tmp/x/ ~/"],
  ]);
  decide('allow', [
    ['R2-B1: a flags name, a folder by name', "OPTS='-a --info=progress2'; rsync $OPTS /tmp/x ~/"],
    ['R2-B1: a flags name that is a real dry run', "OPTS='-an'; rsync $OPTS /tmp/x/ ~/"],
    ['R2-B1: a flags name with a dry run among its words', "OPTS='-a -n'; rsync $OPTS /tmp/x/ ~/"],
    ['#459: a quoted name stays one word (its value is the one source)', "S='/tmp/x y'; rsync -a \"$S\" ~/proj/"],
  ]);
  decide('deny', [
    ['R1-B3: `--` ends the options', 'rsync -a -- /tmp/x/ ~/'],
    ['R1-B3: --rsh=VALUE then the operands', 'rsync -a --rsh=ssh /tmp/x/ ~/'],
  ]);
  test('#458: a long -nnn…n1 word is read in linear time', () => {
    const t0 = Date.now();
    const r = run(`rsync -${'n'.repeat(150000)}1 /tmp/x/ ~/`);
    assert.equal(r.decision, 'allow'); // (it holds an n: a dry run, as before)
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });
  test('a trailing slash on a cp source is a contents merge on macOS (BSD cp) only', () => {
    assert.equal(run('cp -R /tmp/x/ ~/', { platform: 'darwin' }).decision, 'deny');
    assert.equal(run('cp -R /tmp/x/ ~/', { platform: 'linux' }).decision, 'allow');
  });
});

describe('R6-B1: rsync --files-from into home is a contents merge', () => {
  // --files-from copies each listed name, relative to the source directory, directly beneath the destination (slash or no slash on the source): a listed `.claude/…` file staged under the source lands in the protected tree.
  decide('deny', [
    ['--files-from=F SRC ~/', 'rsync -a --files-from=/tmp/restore.list /tmp/stage ~/'],
    ['--files-from F SRC ~/', 'rsync -a --files-from /tmp/restore.list /tmp/stage ~/'],
    ['--files-from=F SRC into a parent of home', 'rsync -a --files-from=/tmp/l /tmp/stage /home/'],
    ['--files-from=F SRC "$HOME/"', 'rsync -a --files-from=/tmp/l /tmp/stage "$HOME/"'],
    ['the option after the operands', 'rsync -a /tmp/stage ~/ --files-from=/tmp/l'],
    ['the option and its value after the operands', 'rsync -a /tmp/stage ~/ --files-from /tmp/l'],
    ['no -a (--files-from implies --relative)', 'rsync --files-from=/tmp/l /tmp/stage ~/'],
    ['an unambiguous abbreviation of the option', 'rsync -a --files=/tmp/l /tmp/stage ~/'],
    ['an abbreviation with its value as the next word', 'rsync -a --files /tmp/l /tmp/stage ~/'],
    ['the value held in a same-line name', 'L=/tmp/l; rsync -a --files-from="$L" /tmp/stage ~/'],
    ['the whole option held in a same-line name', 'O=--files-from=/tmp/l; rsync -a $O /tmp/stage ~/'],
    ['--files-from with --exclude among the words', 'rsync -a --exclude node_modules --files-from=/tmp/l /tmp/stage ~/'],
  ]);
  decide('allow', [
    ['--files-from into a folder of home that is not protected', 'rsync -a --files-from=/tmp/l /tmp/stage ~/proj/out/'],
    ['a named-folder copy into home (no --files-from)', 'rsync -a /tmp/stage ~/'],
    ['--files-from into /tmp', 'rsync -a --files-from=/tmp/l /tmp/stage /tmp/dest/'],
    ['--files-from as a dry run', 'rsync -an --files-from=/tmp/l /tmp/stage ~/'],
    ['--files-from as the value of --exclude (a pattern, not the option)', 'rsync -a --exclude --files-from /tmp/stage ~/'],
  ]);
});

// ---- #427: the git guard's `cd X || exit` ----
// cwd /work/repo is on agent/x, /other on agent/y: a push is allowed where the directory is known, and denied ("cannot tell which directory") where the cd may not have taken effect.
const gitRun = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  // (keys resolved like guard-git's helper: on Windows the guard asks for `D:\other`, not `/other`)
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y' })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: () => null,
  pathExists: () => false,
});
describe('#427: only a plain `exit` (alone or with one number) makes the code after `cd X || exit` follow a successful cd', () => {
  const NOT = (name, line) => test(`not narrowed: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /cannot tell which directory/);
  });
  const NARROWED = (name, line) => test(`narrowed: ${name}`, () => assert.equal(gitRun(line).decision, 'allow', line));
  NARROWED('cd X || exit 1', 'cd /other || exit 1; git push');
  NARROWED('cd X || exit', 'cd /other || exit; git push');
  NARROWED('cd X || exit 0', 'cd /other || exit 0; git push');
  NARROWED('cd X || exit 1 on its own line', 'cd /other || exit 1\ngit push');
  NARROWED('cd X || exit 1 && push', 'cd /other || exit 1 && git push');
  NARROWED('cd X || { exit 1; }', 'cd /other || { exit 1; }; git push');
  NOT('cd X || return 1', 'set +e; cd /other || return 1; git push');
  NOT('cd X || return', 'cd /other || return; git push');
  NOT('cd X || exit 1 < /missing', 'set +e; cd /other || exit 1 < /missing; git push');
  NOT('cd X || exit 1 2>/dev/null', 'cd /other || exit 1 2>/dev/null; git push');
  NOT('cd X || { exit 1; } < /missing', 'cd /other || { exit 1; } < /missing; git push');
  NOT('cd X || { exit 1; } 2>/dev/null', 'cd /other || { exit 1; } 2>/dev/null; git push');
  NOT('cd X || exit 1 2 (too many arguments)', 'cd /other || exit 1 2; git push');
  NOT('cd X || exit 1 2 on the next line', 'cd /other || exit 1 2\ngit push');
  NOT('cd X || exit $X (may split)', 'cd /other || exit $X; git push');
  NOT('cd X || exit abc (not a number)', 'cd /other || exit abc; git push');
  NOT('cd X || { return 1; }', 'cd /other || { return 1; }; git push');
  NOT('cd X || exit 1 | cat (a pipeline stage)', 'cd /other || exit 1 | cat; git push');
  NOT('cd X || exit 1 & (a background job)', 'cd /other || exit 1 &\ngit push');
  // (#352 merge of main: the git guard tracks levels, so the exit one level down is accepted only where the `||` surely reaches it in this shell)
  NARROWED('cd X || { { exit 1; }; } (nested groups)', 'cd /other || { { exit 1; }; }; git push');
  NOT('cd X || { echo; exit 1; } (not the first command)', 'cd /other || { echo x; exit 1; }; git push');
  NOT('cd X || ( exit 1 ) (a subshell exit)', 'cd /other || ( exit 1 ); git push');
  NOT('cd X || { exit 1; } | cat (a pipeline stage)', 'cd /other || { exit 1; } | cat; git push');
  NOT('cd X || { exit 1; } & (a background job)', 'cd /other || { exit 1; } &\ngit push');
  NOT('cd X || { { exit 1; }; } < /missing (a redirection on the outer closer)', 'cd /other || { { exit 1; }; } < /missing; git push');
  NOT('cd X || { { exit 1; } < /missing; } (a redirection on the inner closer)', 'cd /other || { { exit 1; } < /missing; }; git push');
  NOT('cd X || function g { exit 1; } (only defines g)', 'cd /other || function g { exit 1; }; git push');
  NOT('cd X || g() { exit 1; } (only defines g)', 'cd /other || g() { exit 1; }; git push');
  NOT('cd X || if true; then exit 1; fi (not the first command)', 'cd /other || if true; then exit 1; fi; git push');
  NOT('cd X || for x in $L; do exit 1; done (the body may not run)', 'cd /other || for x in $L; do exit 1; done; git push');
});
