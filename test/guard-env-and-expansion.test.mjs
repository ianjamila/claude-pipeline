// T1.7 (cp batch #190, Fable plan pass F2): holes that were already open on main. A "read-only" tool was judged on the UNEXPANDED words
// (`D=-delete; find S $D`), `$_` named nothing, GIT_* / LESS* / PAGER / RIPGREP_* in the environment made git, less and rg write, and
// NODE_OPTIONS / NODE_PATH made the trusted pipeline CLI run foreign code. Every line below is a deny; the controls at the end stay allowed.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const PROJ = '/home/u/proj';
const run = (command) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ });

const CFG = ['~', '.claude'].join('/');
const S = `${CFG}/settings.json`; // a protected file
const TR = `${CFG}/projects/x/s.jsonl`; // a transcript
const CLI = `${CFG}/pipeline/bin/pipeline.mjs`; // the trusted pipeline CLI

const DENY = [
  // (a) an option-position word that still holds a variable is not an option nobody can read
  ['find: -delete in a variable', `D=-delete; find ${S} $D`],
  ['find: -fprint in a variable', `F=-fprint; find /tmp/x $F ${S}`],
  ['sort: -o attached, in a variable', `O=-o${CFG}/settings.json; sort $O /tmp/payload`],
  ['sort: -o with a path split over two names', `A=${CFG.slice(0, -3)}; O=-o\${A}ude/settings.json; sort $O /tmp/p`],
  ['git diff: --output in a variable', `O=--output=${S}; git diff $O`],
  ['sed: a w command in a variable', `W='w ${S}'; echo x | sed -n "$W"`],
  ['awk: the program in a variable', `P='BEGIN{print "x" > "${S}"}'; awk "$P"`],
  ['jq: -i in a variable', `I=-i; jq $I . ${S}`],
  ['tree: -o in a variable', `O=-o${S}; tree $O /tmp`],
  ['xxd: -r in a variable', `R=-r; xxd $R /tmp/x ${S}`],
  ['openssl: -out in a variable', `O=-out; openssl dgst $O ${S} /tmp/x`],
  // (b) `$_` is the last word of the previous command: a name only known at run time
  ['tee $_ after echo S', `echo ${S}; tee $_ < /tmp/payload`],
  ['tee $_ after echo TR (the twin of the `$_x` control)', `echo ${TR}; tee $_ < /tmp/payload`],
  ['node $_ after cat TR', `cat ${TR}; node evil.mjs $_`],
  ['cp to $_ after echo S', `echo ${S}; cp /tmp/payload $_`],
  ['a redirect to $_ after echo S', `echo ${S}; echo x > $_`],
  ['tee \${_} after echo S', `echo ${S}; tee \${_} < /tmp/payload`],
  ['a prefix value of $_', `echo ${S}; FOO=$_ node evil.mjs`],
  // (c) variables git, less, more, bat and rg read: a prefix or an export sets them
  ['GIT_TRACE prefix', `GIT_TRACE=${S} git status`],
  ['GIT_TRACE exported', `export GIT_TRACE=${S}; git status`],
  ['GIT_TRACE2_EVENT prefix', `GIT_TRACE2_EVENT=${S} git status`],
  ['GIT_TRACE2_EVENT exported', `export GIT_TRACE2_EVENT=${S}; git log`],
  ['LESSHISTFILE prefix', `LESSHISTFILE=${S} less ${TR}`],
  ['PAGER exported before git', `export PAGER='tee ${S}'; git log`],
  ['RIPGREP_CONFIG_PATH exported', `export RIPGREP_CONFIG_PATH=/tmp/rc; rg x ${S}`],
  // (f) the trusted pipeline CLI honours NODE_OPTIONS and NODE_PATH
  ['CLI with NODE_OPTIONS prefix', `NODE_OPTIONS='--require /tmp/evil.js' node ${CLI} cost ${TR}`],
  ['CLI with NODE_OPTIONS exported', `export NODE_OPTIONS='--require /tmp/evil.js'; node ${CLI} cost ${TR}`],
  ['CLI with NODE_PATH prefix', `NODE_PATH=/tmp/evil node ${CLI} cost ${TR}`],
  ['CLI with NODE_PATH exported', `export NODE_PATH=/tmp/evil; node ${CLI} cost ${TR}`],
];

for (const [label, line] of DENY) {
  test(`T1.7 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line} -> ${r.decision}`);
  });
}

const ALLOW = [
  ['find by name', `find ${CFG}/projects -name x`],
  ['find in a directory', 'find /tmp -name x -type f'],
  ['sort two files', 'sort a b'],
  ['sort a protected file to stdout', `sort ${TR}`],
  ['git status', 'git status'],
  ['git diff', 'git diff'],
  ['git log on a protected file', `git log -- ${S}`],
  ['wc a transcript', `wc -l ${TR}`],
  ['cat a transcript', `cat ${TR}`],
  ['the installed CLI, read-only call', `node ${CLI} cost ${TR}`],
  ['the installed CLI after an unrelated assignment', `X=1; node ${CLI} cost ${TR}`],
  ['git with an ordinary variable prefix', 'FOO=1 git status'],
  ['a plain command naming $_ with no protected file on the line', 'echo hi; cat $_'],
  ['a read-only command given $_ on a line that names a protected file', `echo ${S}; cat $_`],
  // (a transcript, not the settings file: a line naming a hook-declaring file with input fed into a program is refused by the fed-interpreter rule whatever the variable is called;
  // a transcript is protected for the `$_` rule (see the deny for `cat TR; node evil.mjs $_`) but declares no hook, so only the `$_` vs `$_x` distinction decides)
  ['$_x is another name', `echo ${TR}; tee $_x < /tmp/payload`],
  ['sed with a $1 in a quoted program on a protected file', `sed -n 's/a/b/p' ${TR}`],
  ['awk with $1 in the program on a transcript', `awk '{print $1}' ${TR}`],
];

for (const [label, line] of ALLOW) {
  test(`T1.7 control allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${line} -> ${r.decision}: ${r.reason}`);
  });
}
