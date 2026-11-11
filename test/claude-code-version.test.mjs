// Running vs installed Claude Code build (plan 2026-11-10, A3): parse AI_AGENT, read the installed package.json, compare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeStatus, compareSemver, installedVersion, runningVersion } from '../pipeline/lib/claude-code-version.mjs';

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-ccv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// <root>/claude-code/{package.json,bin/claude.exe}; returns the env that points at it.
function install(root, version, pkg = { name: '@anthropic-ai/claude-code', version }) {
  mkdirSync(join(root, 'claude-code', 'bin'), { recursive: true });
  writeFileSync(join(root, 'claude-code', 'package.json'), JSON.stringify(pkg));
  return { CLAUDE_CODE_EXECPATH: join(root, 'claude-code', 'bin', 'claude.exe') };
}

test('runningVersion reads AI_AGENT and nothing else', () => {
  assert.equal(runningVersion({ AI_AGENT: 'claude-code_2-1-321_agent' }), '2.1.321');
  assert.equal(runningVersion({ AI_AGENT: 'claude-code_10-0-5_agent' }), '10.0.5');
  for (const bad of [undefined, '', 'claude-code', 'claude-code_2-1_agent', 'claude-code_2-1-321', 'codex_2-1-321_agent', 'claude-code_2-1-321_agent_x', 'claude-code_a-b-c_agent']) {
    assert.equal(runningVersion({ AI_AGENT: bad }), null, String(bad));
  }
  assert.equal(runningVersion({}), null);
});

test('installedVersion reads package.json two directories above CLAUDE_CODE_EXECPATH', (t) => {
  const root = tmp(t);
  const env = install(root, '2.1.322');
  assert.equal(installedVersion(env), '2.1.322');
  // an injected reader sees exactly that file
  const seen = [];
  assert.equal(installedVersion(env, { readFile: (f) => { seen.push(f); return '{"version":"3.0.0"}'; } }), '3.0.0');
  assert.deepEqual(seen, [join(root, 'claude-code', 'package.json')]);
});

test('installedVersion is null for an unset, relative, missing, unreadable or malformed source', (t) => {
  const root = tmp(t);
  assert.equal(installedVersion({}), null);
  assert.equal(installedVersion({ CLAUDE_CODE_EXECPATH: '' }), null);
  assert.equal(installedVersion({ CLAUDE_CODE_EXECPATH: 'claude-code/bin/claude.exe' }), null);
  assert.equal(installedVersion({ CLAUDE_CODE_EXECPATH: join(root, 'nope', 'bin', 'claude.exe') }), null);
  assert.equal(installedVersion(install(root, 'x', { version: 'latest' })), null);
  assert.equal(installedVersion(install(root, 'x', { name: 'no version' })), null);
  assert.equal(installedVersion(install(root, 'x', { version: 7 })), null);
  writeFileSync(join(root, 'claude-code', 'package.json'), '{not json');
  assert.equal(installedVersion({ CLAUDE_CODE_EXECPATH: join(root, 'claude-code', 'bin', 'claude.exe') }), null);
  assert.equal(installedVersion({ CLAUDE_CODE_EXECPATH: '/a/b/c' }, { readFile: () => { throw new Error('EACCES'); } }), null);
});

test('compareSemver orders numerically, not as strings', () => {
  assert.equal(compareSemver('2.1.9', '2.1.10'), -1);
  assert.equal(compareSemver('2.1.321', '2.1.321'), 0);
  assert.equal(compareSemver('2.10.0', '2.9.99'), 1);
  assert.equal(compareSemver('3.0.0', '2.99.99'), 1);
  assert.equal(compareSemver('2.1.321-beta.1', '2.1.321'), 0);
  assert.equal(compareSemver('2.1', '2.1.0'), null);
  assert.equal(compareSemver(null, '2.1.0'), null);
});

test('claudeCodeStatus: stale true / false / unknown', (t) => {
  const root = tmp(t);
  const exec = install(root, '2.1.321');
  assert.deepEqual(claudeCodeStatus({ ...exec, AI_AGENT: 'claude-code_2-1-318_agent' }), { running: '2.1.318', installed: '2.1.321', stale: true });
  assert.deepEqual(claudeCodeStatus({ ...exec, AI_AGENT: 'claude-code_2-1-321_agent' }), { running: '2.1.321', installed: '2.1.321', stale: false });
  assert.deepEqual(claudeCodeStatus({ ...exec, AI_AGENT: 'claude-code_2-1-400_agent' }), { running: '2.1.400', installed: '2.1.321', stale: false });
  // either side unknown => null, never a guess
  assert.deepEqual(claudeCodeStatus({ ...exec }), { running: null, installed: '2.1.321', stale: null });
  assert.deepEqual(claudeCodeStatus({ AI_AGENT: 'claude-code_2-1-321_agent' }), { running: '2.1.321', installed: null, stale: null });
  assert.deepEqual(claudeCodeStatus({}), { running: null, installed: null, stale: null });
  // deps reach installedVersion
  assert.equal(claudeCodeStatus({ AI_AGENT: 'claude-code_2-1-1_agent', CLAUDE_CODE_EXECPATH: '/x/y/z' }, { readFile: () => '{"version":"2.1.2"}' }).stale, true);
});
