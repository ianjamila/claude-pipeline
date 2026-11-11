// isPipelineTool is an ALLOW check ("this is the trusted pipeline CLI, run it freely"), so a false match fails open. On macOS / Windows the spelling is
// case-folded, which is wrong on a case-sensitive volume: there a differently-cased pipeline folder is a different, agent-writable one and must not be trusted.
// The disk decides (samePath / insideOnDisk); the protect checks (a false match denies) stay on the spelling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const opts = { home: HOME, env: {}, platform: 'darwin', cwd: '/repo', realpath: (p) => p, existsSync: () => false };
const run = (command) => evaluateBashForFiles(command, opts).decision;

// A fake volume: statSync knows only what `inodeOf` answers for (a bigint inode, or undefined = absent). samePath asks the disk only when `platform` is
// the running one, so the test presents itself as darwin for its duration.
function onFakeVolume(inodeOf, body) {
  const origStat = fs.statSync;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  fs.statSync = (p) => {
    const ino = inodeOf(String(p));
    if (ino === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { dev: 1n, ino };
  };
  Object.defineProperty(process, 'platform', { ...origPlatform, value: 'darwin' });
  try { body(); } finally { fs.statSync = origStat; Object.defineProperty(process, 'platform', origPlatform); }
}
// case-sensitive: every exact spelling in `files` is its own file
const caseSensitive = (files) => { const m = new Map(files.map((f, i) => [f, BigInt(i + 1)])); return (p) => m.get(p); };
// case-insensitive: spellings that fold to the same text are one file
const caseInsensitive = (files) => { const m = new Map(files.map((f, i) => [f.toLowerCase(), BigInt(i + 1)])); return (p) => m.get(p.toLowerCase()); };

const CLAUDE = `${HOME}/.claude`;
const REAL_CLI = `${CLAUDE}/pipeline/bin/pipeline.mjs`;
const FAKE_CLI = `${CLAUDE}/PIPELINE/bin/pipeline.mjs`;
const REAL_HOOK = `${CLAUDE}/pipeline/hooks/guard-files.mjs`;
const FAKE_HOOK = `${CLAUDE}/PIPELINE/hooks/guard-files.mjs`;
const ALL = [CLAUDE, `${CLAUDE}/pipeline`, `${CLAUDE}/pipeline/bin`, REAL_CLI, `${CLAUDE}/pipeline/hooks`, REAL_HOOK];
const ALL_FAKE = [`${CLAUDE}/PIPELINE`, `${CLAUDE}/PIPELINE/bin`, FAKE_CLI, `${CLAUDE}/PIPELINE/hooks`, FAKE_HOOK];

test('a differently-cased pipeline.mjs is not the trusted CLI when the disk says it is another file', () => {
  onFakeVolume(caseSensitive([...ALL, ...ALL_FAKE]), () => {
    assert.equal(run(`node ${REAL_CLI} preflight`), 'allow', 'the real CLI stays trusted');
    assert.equal(run(`node ${FAKE_CLI} preflight`), 'deny', 'the agent-writable look-alike is not');
    assert.equal(run(`${FAKE_CLI} preflight`), 'deny', 'run directly, same');
  });
});

test('a differently-cased pipeline/hooks folder is not the trusted hooks folder when the disk says it is another folder', () => {
  onFakeVolume(caseSensitive([...ALL, ...ALL_FAKE]), () => {
    assert.equal(run(`node ${REAL_HOOK}`), 'allow', 'the real hooks folder stays trusted');
    assert.equal(run(`node ${FAKE_HOOK}`), 'deny');
  });
});

test('on a case-insensitive volume the other spelling is the same file and stays trusted', () => {
  onFakeVolume(caseInsensitive(ALL), () => {
    assert.equal(run(`node ${FAKE_CLI} preflight`), 'allow');
    assert.equal(run(`node ${FAKE_HOOK}`), 'allow');
  });
});
