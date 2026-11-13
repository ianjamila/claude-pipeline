// #190 cases 3 and 6 (T1.3): wording only. Both lines were denied before and are denied now; only the reason says what to do instead.
//   case 3: a command that is not read-only and whose ONLY protected reference is a transcript path argument: "copy it first, pass the copy".
//   case 6: an inline program that names the owner-go recorder (any copy): "edit the source with the Edit tool".
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const CFG = ['~', '.claude'].join('/');
const TR = `${CFG}/projects/-home-u-proj/0b0e0a3c-0000-4000-8000-000000000001.jsonl`;
const S = `${CFG}/settings.json`;
const files = { '/home/u/proj/scratch.mjs': "console.log('x');\n" };
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null), cwd: '/home/u/proj' };
const run = (command) => evaluateBashForFiles(command, BASE);

test('T1.3 case 3: a program given only a transcript path says to copy it first and pass the copy', () => {
  const r = run(`node scratch.mjs ${TR}`);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /node refers to a protected pipeline file .* is not a read-only command/);
  assert.match(r.reason, /copy it first/);
  assert.ok(r.reason.includes('cp <transcript> "$TMPDIR/x.jsonl"'), r.reason);
  assert.match(r.reason, /reading a copy is allowed/);
  assert.match(r.reason, /pass the copy/);
});

test('T1.3 case 3: the same program given a copy is allowed (the advice works)', () => {
  assert.equal(run('node scratch.mjs "$TMPDIR/x.jsonl"').decision, 'allow');
  assert.equal(run('node scratch.mjs /tmp/x.jsonl').decision, 'allow');
});

test('T1.3 case 3: a command that also names another protected file gets no copy advice', () => {
  const r = run(`node scratch.mjs ${TR} ${S}`);
  assert.equal(r.decision, 'deny');
  assert.doesNotMatch(r.reason, /copy it first/);
});

test('T1.3 case 3: a protected file that is no transcript gets no copy advice', () => {
  const r = run(`node scratch.mjs ${S}`);
  assert.equal(r.decision, 'deny');
  assert.doesNotMatch(r.reason, /copy it first/);
});

test('T1.3 case 6: the owner-go recorder rule says to edit the source with the Edit tool', () => {
  const r = run(`node -e "require('fs').writeFileSync('pipeline/hooks/lib/owner-go.mjs', 'x')"`);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /owner-go recorder records the owner's chat "merge"/);
  assert.match(r.reason, /edit the source with the Edit tool/);
});
