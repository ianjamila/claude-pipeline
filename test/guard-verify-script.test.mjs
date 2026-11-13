// #190.1 / #161 / #175 regression fixtures (T1.4). The guard stays strict, with no comment or literal exemption (PR #162 was refused for that):
//   (a) the INSTALLED pipeline CLI is trusted by path, so its own text (a comment naming the config dir, plus writes) is never judged: allow (#190.1 was not reproducible);
//   (b) a CONSUMER's verify script whose comment spells the config path and which writes is refused, and the reason names the line (#161 / #175: intended);
//   (c) the same script with the line reworded is allowed.
// F10 negatives: trust by path is lexical on the resolved path, never by a prefix or a loader option: a `..` climb out of the installed folder and a `node -r` preload stay denied.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const CFG = ['~', '.claude'].join('/');
const CLI = `${CFG}/pipeline/bin/pipeline.mjs`;
const TR = `${CFG}/projects/-home-u-proj/0b0e0a3c-0000-4000-8000-000000000001.jsonl`;
const RUNS = `${CFG}/pipeline-state/verify-runs.jsonl`;
const WRITER = "require('fs').writeFileSync('out.txt', 'x');";

const CLI_TEXT = ['#!/usr/bin/env node', `// each run appends one line to ${RUNS}`, "import fs from 'node:fs';", "fs.appendFileSync('/tmp/log.txt', 'x');", ''].join('\n');
const BAD_VERIFY = ["import fs from 'node:fs';", 'const a = 1;', `// Each run appends one line to ${RUNS} (moved by VERIFY_RUN_HISTORY)`, "fs.writeFileSync('out.txt', 'x');", ''].join('\n');
const GOOD_VERIFY = ["import fs from 'node:fs';", 'const a = 1;', '// Each run appends one line to the run-history file in the config folder (moved by VERIFY_RUN_HISTORY)', "fs.writeFileSync('out.txt', 'x');", ''].join('\n');

const filesOf = (verify) => ({
  '/home/u/.claude/pipeline/bin/pipeline.mjs': CLI_TEXT,
  '/home/u/proj/scripts/verify.mjs': verify,
  '/home/u/proj/evil.mjs': WRITER,
  '/home/u/proj/x.js': WRITER,
  '/tmp/x.js': WRITER,
});
const runWith = (command, files) => evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null), cwd: '/home/u/proj' });

test('#190.1: the installed pipeline CLI whose comment names the config dir and which writes is allowed (trusted by path)', () => {
  const r = runWith(`node ${CLI} worktrees sessions /tmp/wt`, filesOf(GOOD_VERIFY));
  assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
  assert.equal(runWith(`node /home/u/.claude/pipeline/bin/pipeline.mjs cost --pr 5 --from-transcript ${TR}`, filesOf(GOOD_VERIFY)).decision, 'allow');
});

test('#161 / #175: a consumer verify script whose comment names the config path and which writes is denied, and the reason names the line', () => {
  const r = runWith('node scripts/verify.mjs --quick', filesOf(BAD_VERIFY));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /refers to a protected pipeline file and writes/);
  assert.match(r.reason, /\bline 3\b/);
  assert.match(r.reason, /Each run appends one line/);
  assert.match(r.reason, /reword that line/i);
});

test('#161 / #175: the reworded script is allowed', () => {
  const r = runWith('node scripts/verify.mjs --quick', filesOf(GOOD_VERIFY));
  assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
});

// ---- F10: trust by path must not be stretched ----
test('F10: a `..` climb out of the installed folder to a project script is denied', () => {
  const climb = `${CFG}/pipeline/bin/../../../proj/evil.mjs`;
  const r = runWith(`node ${climb} ${TR}`, filesOf(GOOD_VERIFY));
  assert.equal(r.decision, 'deny', `${r.decision}: ${r.reason}`);
});

test('F10: `node -r /tmp/x.js <CLI> ...` (a preload runs first) is denied', () => {
  const r = runWith(`node -r /tmp/x.js ${CLI} cost --pr 5 --from-transcript ${TR}`, filesOf(GOOD_VERIFY));
  assert.equal(r.decision, 'deny', `${r.decision}: ${r.reason}`);
});

test('F10: `node --require` and `--import` preloads on the CLI are denied too', () => {
  for (const flag of ['--require /tmp/x.js', '--import /tmp/x.js', '--experimental-loader /tmp/x.js']) {
    const r = runWith(`node ${flag} ${CLI} cost --pr 5 --from-transcript ${TR}`, filesOf(GOOD_VERIFY));
    assert.equal(r.decision, 'deny', `${flag}: ${r.decision}: ${r.reason}`);
  }
});
