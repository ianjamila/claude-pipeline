// Why (2026-11-11): the review skill's line `node ~/.claude/pipeline/bin/pipeline.mjs job start codex-r1 -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review ... --head $(git rev-parse HEAD)`
// was refused ("the program pipeline.mjs refers to a protected pipeline file and writes ... line 64") while the same line with a literal sha passed. The outer CLI is a program with unknown
// writes and a word with a command substitution may be its write target, so the installed CLI "may have been overwritten" and the text it holds NOW was judged as a program's content
// (judgeWrittenScript). The installed CLI is never judged on its content (judgeFoundScript): the unchanged disk text is left out; every other text it may hold and the line's own words are
// still judged. The REAL pipeline.mjs is the fake CLI here (a stub that names nothing protected passed before the fix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const PROJ = '/home/u/proj';
const CLI = '/home/u/.claude/pipeline/bin/pipeline.mjs';
const REAL_CLI = readFileSync(new URL('../pipeline/bin/pipeline.mjs', import.meta.url), 'utf8');
const DIRS = ['sub', '/home/u', '/home/u/.claude'];
const run = (command, extra = {}) => {
  const fs = fakeFs(PROJ, { [CLI]: REAL_CLI, ...extra }, DIRS);
  return evaluateBashForFiles(command, { home: '/home/u', env: { HOME: '/home/u', ZDOTDIR: '/home/u' }, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists }).decision;
};
const BIN = '~/.claude/pipeline/bin/pipeline.mjs';
const J = (tail, pre = '') => `${pre}node ${BIN} job start codex-r1 -- node ${BIN} codex-review --pr 254 --round 1 --base 7713205 --head ${tail}`;
const SUB = '$(git rev-parse HEAD)';
const SETTINGS = '~/.claude/settings.json';

test('the codex-review job line is allowed with a literal sha and with a read-only git query in the head', () => {
  for (const c of [J('abc1234'), J(SUB), J('`git rev-parse HEAD`'), J('$(git rev-parse --short HEAD)'), J('$(git merge-base origin/main HEAD)'),
    J('"$H"', 'H=$(git rev-parse HEAD); '), `node ${BIN} codex-review --pr 254 --round 1 --base 7713205 --head ${SUB}`]) {
    assert.equal(run(c), 'allow', c);
  }
});

test('the same shapes stay refused when something else on the line is guarded', () => {
  for (const c of [
    J('$(git rev-parse HEAD > ~/.claude/pipeline/x)'),
    `${J(SUB)} > ${BIN}`,
    `${J(SUB)} # ${SETTINGS}`,
    J(`$(cat ${SETTINGS})`),
    // content only known at run time (an unmodelled writer): the line is judged by its own words
    `curl -o ${SUB} u; node ${BIN} status # ${SETTINGS}`,
    `curl -o ${SUB} u; ${J(SUB)} # ${SETTINGS}`,
    // text written into a target that may be the CLI is judged as content
    `echo 'require("fs").writeFileSync("/home/u/.claude/settings.json","")' > ${SUB}; node ${BIN} status`,
    `echo 'require("fs").writeFileSync("/home/u/.claude/settings.json","")' > ${SUB}; ${J(SUB)}`,
  ]) assert.equal(run(c), 'deny', c);
  // an untrusted program (outside the installed pipeline folder) that names a protected file and writes is still refused, with or without the substitution
  const prog = { 'tool.mjs': "require('fs').writeFileSync('/home/u/.claude/settings.json', 'x')\n" };
  assert.equal(run(`node tool.mjs job start c -- node tool.mjs codex-review --head ${SUB}`, prog), 'deny');
  assert.equal(run(`node tool.mjs --head ${SUB}`, prog), 'deny');
  assert.equal(run(`sh -c "${SUB}"; node ${BIN} status # ${SETTINGS}`), 'deny');
});

test('git policy: the job line is allowed too', () => {
  for (const c of [J(SUB), J('abc1234')]) {
    const r = evaluateGitCommand(c, { cwd: '/work/repo', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fakeFs('/work/repo', {}, ['/home/u']) });
    assert.equal(r.decision, 'allow', c);
  }
});
