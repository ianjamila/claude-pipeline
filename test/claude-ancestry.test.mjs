// Why: the installer's process-tree backstop (an agent that removes CLAUDECODE from the environment still has Claude Code
// as an ancestor). The lookup is injected, so these tests never read the real process table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasClaudeCodeAncestor, isClaudeCodeProcess } from '../pipeline/lib/claude-ancestry.mjs';

const table = (rows) => (pid) => rows[pid] ?? null;

test('isClaudeCodeProcess: the claude binary by any path, or a JS runtime running its cli; not the desktop app or look-alikes', () => {
  for (const comm of ['claude', '/Users/u/.local/bin/claude', 'C:\\Users\\u\\bin\\claude.exe', '/opt/homebrew/bin/claude']) assert.equal(isClaudeCodeProcess({ comm }), true, comm);
  assert.equal(isClaudeCodeProcess({ comm: 'node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' }), true);
  assert.equal(isClaudeCodeProcess({ comm: '/usr/local/bin/node', args: '/usr/local/bin/node /home/u/.claude/local/claude' }), true);
  assert.equal(isClaudeCodeProcess({ comm: 'bun', args: 'bun /x/claude-code/cli.js' }), true);
  for (const info of [{ comm: 'Claude' }, { comm: 'claude-helper' }, { comm: 'node', args: 'node scripts/test.mjs' }, { comm: 'zsh' }, { comm: 'node' }, null, {}]) {
    assert.equal(isClaudeCodeProcess(info), false, JSON.stringify(info));
  }
});

test('hasClaudeCodeAncestor walks the parent chain and finds Claude Code at any height', () => {
  const rows = {
    900: { ppid: 800, comm: 'node', args: 'node install.mjs' },
    800: { ppid: 700, comm: '/bin/zsh' },
    700: { ppid: 600, comm: 'sh' },
    600: { ppid: 500, comm: '/Users/u/.local/bin/claude' },
    500: { ppid: 1, comm: 'login' },
  };
  assert.equal(hasClaudeCodeAncestor({ startPid: 900, lookup: table(rows) }), true);
  assert.equal(hasClaudeCodeAncestor({ startPid: 500, lookup: table(rows) }), false, 'login is above claude, not below it');
});

test('hasClaudeCodeAncestor: no Claude Code on the chain, a failed lookup, a cycle and a long chain all end in false', () => {
  const clean = { 30: { ppid: 20, comm: 'zsh' }, 20: { ppid: 10, comm: 'Terminal' }, 10: { ppid: 1, comm: 'launchd' } };
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: table(clean) }), false);
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: () => null }), false, 'lookup failure falls back to the env check');
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: () => { throw new Error('no ps'); } }), false);
  assert.equal(hasClaudeCodeAncestor({ startPid: 30, lookup: table({ 30: { ppid: 20, comm: 'a' }, 20: { ppid: 30, comm: 'b' } }) }), false, 'a cycle terminates');
  const long = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 2, { ppid: i + 3, comm: i === 90 ? 'claude' : 'sh' }]));
  assert.equal(hasClaudeCodeAncestor({ startPid: 2, lookup: table(long) }), false, 'bounded depth (claude is 90 hops up)');
  assert.equal(hasClaudeCodeAncestor({ startPid: 2, lookup: table(long), maxHops: 100 }), true);
  assert.equal(hasClaudeCodeAncestor({ startPid: 1, lookup: table(clean) }), false);
});
