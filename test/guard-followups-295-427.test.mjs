// Follow-ups from PR #288 / #425 for the guards: issues #295, #298, #300, #301, #312 (the bash files guard) and #427 (the git guard's `cd X || exit`).
// Home is /home/u and the cwd is /home/u/proj; the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
  test('a trailing slash on a cp source is a contents merge on macOS (BSD cp) only', () => {
    assert.equal(run('cp -R /tmp/x/ ~/', { platform: 'darwin' }).decision, 'deny');
    assert.equal(run('cp -R /tmp/x/ ~/', { platform: 'linux' }).decision, 'allow');
  });
});

// ---- #427: the git guard's `cd X || exit` ----
// cwd /work/repo is on agent/x, /other on agent/y: a push is allowed where the directory is known, and denied ("cannot tell which directory") where the cd may not have taken effect.
const gitRun = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ '/work/repo': 'agent/x', '/other': 'agent/y' })[dir] ?? null,
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
});
