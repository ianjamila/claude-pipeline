// Why (#84): a command line or script text over 200,000 characters is never parsed (the hook has a 15 s budget). It used
// to be judged only by whether it names a guarded word, so a padded `bash run.sh` (run.sh holds the push) or a 250 kB
// script that runs another script got through. Now every text over the cap is refused, in both guards. Each long twin
// below is also asserted denied at short length, so the test shows the padding is the only difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const CAP = 200_000;
const pad = (s) => `${s}; : ${'x '.repeat(110_000)}`; // over the cap, harmless filler
const PUSH = 'git pu' + 'sh origin main'; // (split here so this source line does not trip the live guard)
const WRITE = 'echo x > ~/.claude/settings.json';

// ---- git guard ---------------------------------------------------------------------------------------

const REPO = '/work/repo';
function git(command, files = {}) {
  const abs = Object.fromEntries(Object.entries(files).map(([k, v]) => [resolve(REPO, k), v]));
  return evaluateGitCommand(command, {
    cwd: REPO,
    home: '/home/u',
    currentBranch: () => 'agent/x',
    readText: (p) => (typeof abs[p] === 'string' ? abs[p] : null),
    pathExists: (p) => p in abs,
  });
}

const RUN = { 'run.sh': `${PUSH}\n` };
const GIT_TWINS = [
  'bash run.sh',
  'source run.sh',
  '. run.sh',
  'G=run.sh; bash $G',
  'G=${U:-run.sh}; bash $G',
];

for (const c of GIT_TWINS) {
  test(`git guard: ${c} is denied short and padded past the cap`, () => {
    assert.equal(git(c, RUN).decision, 'deny', 'short');
    const long = pad(c);
    assert.ok(long.length > CAP);
    const r = git(long, RUN);
    assert.equal(r.decision, 'deny', 'long');
    assert.match(r.reason, /too long/);
  });
}

test('git guard: a script file over the cap that runs another script is denied', () => {
  const big = `# ${'x'.repeat(250_000)}\nbash run.sh\n`;
  assert.equal(git('bash big.sh', { ...RUN, 'big.sh': 'bash run.sh\n' }).decision, 'deny', 'short');
  const r = git('bash big.sh', { ...RUN, 'big.sh': big });
  assert.equal(r.decision, 'deny', 'long');
  assert.match(r.reason, /too long/);
});

test('git guard: a harmless line just under the cap is still judged normally and allowed', () => {
  const line = `ls ${'x'.repeat(CAP - 10)}`;
  assert.ok(line.length <= CAP);
  assert.equal(git(line).decision, 'allow');
  assert.equal(git(`ls ${'x'.repeat(CAP)}`).decision, 'deny', 'one past the cap');
});

test('git guard: the reason tells the agent how to get unstuck', () => {
  const r = git(pad('ls'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Write tool/);
});

// ---- files guard -------------------------------------------------------------------------------------

const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const PROJ = '/home/u/proj';
function files(command, fileMap = {}) {
  const abs = Object.fromEntries(Object.entries(fileMap).map(([k, v]) => [`${PROJ}/${k}`, v]));
  return evaluateBashForFiles(command, {
    ...BASE,
    cwd: PROJ,
    existsSync: (p) => p in abs,
    readText: (p) => (typeof abs[p] === 'string' ? abs[p] : null),
  });
}

const W = { 'w.sh': `${WRITE}\n` };
const FILE_TWINS = [
  'bash w.sh',
  'source w.sh',
  '. w.sh',
  'G=w.sh; bash $G',
  'G=${U:-w.sh}; bash $G',
];

for (const c of FILE_TWINS) {
  test(`files guard: ${c} is denied short and padded past the cap`, () => {
    assert.equal(files(c, W).decision, 'deny', 'short');
    const long = pad(c);
    assert.ok(long.length > CAP);
    const r = files(long, W);
    assert.equal(r.decision, 'deny', 'long');
    assert.match(r.reason, /too long/);
  });
}

test('files guard: a script file over the cap that runs a script writing a protected file is denied', () => {
  const big = `# ${'x'.repeat(250_000)}\nbash w.sh\n`;
  assert.equal(files('bash big.sh', { ...W, 'big.sh': 'bash w.sh\n' }).decision, 'deny', 'short');
  const r = files('bash big.sh', { ...W, 'big.sh': big });
  assert.equal(r.decision, 'deny', 'long');
  assert.match(r.reason, /too long/);
});

test('files guard: a harmless line just under the cap is still judged normally and allowed', () => {
  const line = `ls ${'x'.repeat(CAP - 10)}`;
  assert.ok(line.length <= CAP);
  assert.equal(files(line).decision, 'allow');
  assert.equal(files(`ls ${'x'.repeat(CAP)}`).decision, 'deny', 'one past the cap');
});

test('files guard: the reason tells the agent how to get unstuck', () => {
  const r = files(pad('ls'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Write tool/);
});
