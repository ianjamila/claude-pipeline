// #261 (click-to-approve, T3): the guard holds every place a hook that runs on AskUserQuestion could be declared. A hook there could answer the owner's dialog in the owner's name or hide a refusal.
// Protected for writes: the hooks folder and the local settings file of every account config dir, the scripts of the approved dialog-hook list. Refused when a change adds or alters hooks: a project's
// settings files, a plugin's hooks.json, the front matter of a skill or an agent. Permission edits and reads stay open. The owner's admin switch is honoured as everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateFileTool, evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const LINUX = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const file = (tool_name, tool_input, opts = {}) => evaluateFileTool({ tool_name, tool_input, cwd: '/repo' }, { ...LINUX, ...opts }).decision;
const bash = (command, opts = {}, cwd = '/repo') => evaluateBashForFiles(command, { ...LINUX, cwd, ...opts }).decision;
// a fake file system for the files the tests read: { path: text }
const reading = (files) => ({ readText: (p) => files[p] ?? null });

test('the user-level hooks folder and local settings are protected for every file tool and Bash', () => {
  for (const p of ['/home/u/.claude/hooks/notify.mjs', '/home/u/.claude/hooks/sub/x.sh', '/home/u/.claude/settings.local.json']) {
    assert.equal(file('Write', { file_path: p, content: 'x' }), 'deny', p);
    assert.equal(file('Edit', { file_path: p, old_string: 'a', new_string: 'b' }), 'deny', p);
  }
  for (const cmd of ['echo x > ~/.claude/hooks/notify.mjs', 'cp /tmp/x ~/.claude/hooks/tab.sh', 'rm ~/.claude/hooks/tab.sh', 'echo {} > ~/.claude/settings.local.json', 'sed -i s/a/b/ ~/.claude/hooks/x.mjs']) {
    assert.equal(bash(cmd), 'deny', cmd);
  }
  assert.equal(file('mcp__fs__write_file', { path: '/home/u/.claude/hooks/notify.mjs', content: 'x' }), 'deny');
  for (const cmd of ['cat ~/.claude/hooks/notify.mjs', 'ls ~/.claude/hooks', 'grep -n x ~/.claude/settings.local.json', 'echo x > ~/.claude/hooklike/x', 'echo x > /repo/hooks/x.sh']) {
    assert.equal(bash(cmd), 'allow', cmd);
  }
});

test('another account config dir (~/.claude-eaglewatch) is held the same: hooks/, settings.json and settings.local.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-click-hooks-'));
  fs.mkdirSync(path.join(home, '.claude-eaglewatch'), { recursive: true });
  const opts = { home, platform: 'linux', env: {}, realpath: (p) => p, existsSync: (p) => fs.existsSync(p) };
  const ew = path.join(home, '.claude-eaglewatch');
  const write = (p, o = opts) => evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, cwd: '/repo' }, o).decision;
  for (const rel of ['hooks/tab.mjs', 'settings.local.json', 'settings.json']) {
    assert.equal(write(path.join(ew, rel)), 'deny', rel);
    assert.equal(evaluateBashForFiles(`echo x > ${path.join(ew, rel)}`, { ...opts, cwd: '/repo' }).decision, 'deny', rel);
  }
  assert.equal(write(path.join(ew, 'CLAUDE.md')), 'allow', 'the rest of the config dir stays writable');
  assert.equal(evaluateBashForFiles(`cat ${path.join(ew, 'settings.local.json')}`, { ...opts, cwd: '/repo' }).decision, 'allow');
  // $CLAUDE_CONFIG_DIR too
  const cfg = { ...opts, env: { CLAUDE_CONFIG_DIR: '/data/claude-cfg' } };
  assert.equal(write('/data/claude-cfg/hooks/x.mjs', cfg), 'deny');
  assert.equal(write('/data/claude-cfg/notes.md', cfg), 'allow');
});

test('every scriptPath of the approved dialog-hook list is protected; a missing, unreadable or malformed list adds nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-click-hooks-'));
  const state = path.join(home, '.claude', 'pipeline-state', 'owner-go');
  fs.mkdirSync(state, { recursive: true });
  const opts = { home, platform: 'linux', env: {}, realpath: (p) => p, existsSync: (p) => fs.existsSync(p) };
  const script = '/work/command-centre/heartbeat.mjs';
  const other = '/work/command-centre/other.mjs';
  const write = (p) => evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, cwd: '/repo' }, opts).decision;
  assert.equal(write(script), 'allow', 'no list yet');
  fs.writeFileSync(path.join(state, 'dialog-hooks.json'), JSON.stringify({ v: 1, hooks: [{ command: `node ${script}`, scriptPath: script, sha256: 'a'.repeat(64) }] }));
  assert.equal(write(script), 'deny');
  assert.equal(evaluateBashForFiles(`echo x >> ${script}`, { ...opts, cwd: '/repo' }).decision, 'deny');
  assert.equal(write(other), 'allow', 'only the listed scripts');
  assert.equal(evaluateBashForFiles(`cat ${script}`, { ...opts, cwd: '/repo' }).decision, 'allow', 'reading stays open');
  for (const bad of ['{not json', '{"hooks": 5}', '{"hooks":[{"scriptPath":7},null,{"scriptPath":"relative/x.mjs"}]}']) {
    fs.writeFileSync(path.join(state, 'dialog-hooks.json'), bad);
    assert.equal(write(script), 'allow', bad);
  }
});

test('a project settings file: a permissions edit is allowed, adding or altering hooks is denied (Write, Edit, MultiEdit)', () => {
  const settings = '/repo/.claude/settings.json';
  const stop = { Stop: [{ hooks: [{ type: 'command', command: 'echo a' }] }] };
  const before = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: stop });
  const files = reading({ [settings]: before, '/repo/.claude/settings.local.json': '{"permissions":{"allow":[]}}' });
  const w = (content, p = settings) => file('Write', { file_path: p, content }, files);
  assert.equal(w(JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(git status:*)'] }, hooks: stop })), 'allow', 'permissions edit');
  assert.equal(w(JSON.stringify({ hooks: { ...stop, PostToolUse: [] }, permissions: { allow: ['Bash(ls:*)'] } })), 'deny', 'a new event');
  assert.equal(w(JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } })), 'deny', 'hooks removed is a change too');
  assert.equal(w(JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo EVIL' }] }] } })), 'deny', 'a changed command');
  assert.equal(w(JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo a', type: 'command' }] }] }, permissions: { allow: ['Bash(ls:*)'] } })), 'allow', 'same hooks, other key order');
  assert.equal(w('{"hooks":{"PreToolUse":[]}}', '/repo/.claude/settings.local.json'), 'deny', 'the local file too');
  assert.equal(w('{"permissions":{"allow":["Bash(ls:*)"]}}', '/repo/.claude/settings.local.json'), 'allow');
  assert.equal(file('Edit', { file_path: settings, old_string: 'Bash(ls:*)', new_string: 'Bash(ls:*)","Bash(pwd:*)' }, files), 'allow', 'an Edit inside the permissions list');
  assert.equal(file('Edit', { file_path: settings, old_string: 'echo a', new_string: 'echo EVIL' }, files), 'deny', 'an Edit inside a hook command');
  assert.equal(file('MultiEdit', { file_path: settings, edits: [{ old_string: 'Bash(ls:*)', new_string: 'Bash(pwd:*)' }, { old_string: 'echo a', new_string: 'echo b' }] }, files), 'deny');
  assert.equal(file('MultiEdit', { file_path: settings, edits: [{ old_string: 'Bash(ls:*)', new_string: 'Bash(pwd:*)' }] }, files), 'allow');
  // a new file that declares hooks, and one that is not JSON but says hooks
  assert.equal(file('Write', { file_path: settings, content: '{"hooks":{}}' }, reading({})), 'deny');
  assert.equal(file('Write', { file_path: settings, content: '{"hooks": [' }, reading({})), 'deny');
  assert.equal(file('Write', { file_path: settings, content: '{"env":{"A":"1"}}' }, reading({})), 'allow');
  // a settings file elsewhere is no settings file of Claude Code
  assert.equal(file('Write', { file_path: '/repo/config/settings.json', content: '{"hooks":{}}' }, reading({})), 'allow');
});

test('a plugin hooks.json under a config dir is never writable; a skill or agent front matter changes hooks only through the owner', () => {
  assert.equal(file('Write', { file_path: '/home/u/.claude/plugins/cache/p/1.0/hooks/hooks.json', content: '{}' }), 'deny');
  assert.equal(file('Edit', { file_path: '/home/u/.claude-eaglewatch/plugins/p/hooks/hooks.json', old_string: 'a', new_string: 'b' }), 'deny');
  assert.equal(file('Write', { file_path: '/repo/hooks/hooks.json', content: '{}' }), 'allow', 'not under a config dir');
  assert.equal(file('Write', { file_path: '/home/u/.claude/plugins/p/README.md', content: 'x' }), 'allow');

  const skill = '/repo/.claude/skills/mine/SKILL.md';
  const text = '---\nname: mine\ndescription: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo a\n---\nBody about hooks.\n';
  const files = reading({ [skill]: text });
  assert.equal(file('Edit', { file_path: skill, old_string: 'Body about hooks.', new_string: 'New body about hooks.' }, files), 'allow', 'prose that says hooks');
  assert.equal(file('Edit', { file_path: skill, old_string: 'echo a', new_string: 'echo b' }, files), 'deny');
  assert.equal(file('Write', { file_path: skill, content: text.replace('Body about hooks.', 'Other body.') }, files), 'allow');
  assert.equal(file('Write', { file_path: skill, content: text.replace(/hooks:\n[\s\S]*?\n---/, '---') }, files), 'deny', 'hooks removed');
  assert.equal(file('Write', { file_path: '/repo/.claude/skills/new/SKILL.md', content: '---\nname: new\nhooks:\n  Stop: []\n---\n' }, reading({})), 'deny', 'a new skill that declares hooks');
  assert.equal(file('Write', { file_path: '/repo/.claude/skills/new/SKILL.md', content: '---\nname: new\n---\nbody\n' }, reading({})), 'allow');
  assert.equal(file('Write', { file_path: '/repo/.claude/agents/a.md', content: '---\nname: a\nhooks:\n  Stop: []\n---\n' }, reading({})), 'deny');
  assert.equal(file('Write', { file_path: '/repo/.claude/agents/a.md', content: '---\nname: a\ntools: Read\n---\n' }, reading({})), 'allow');
});

test('Bash writes to those files cannot be evaluated: denied when the line says hooks, allowed otherwise; reads stay allowed', () => {
  for (const cmd of [
    `echo '{"hooks":{}}' > /repo/.claude/settings.json`,
    `cat > /repo/.claude/settings.local.json <<'EOF'\n{"hooks":{"Stop":[]}}\nEOF`,
    `jq '.hooks = {}' /repo/.claude/settings.json > /tmp/x && mv /tmp/x /repo/.claude/settings.json`,
    `printf 'hooks:' >> /repo/.claude/skills/mine/SKILL.md`,
    `echo x > /home/u/.claude/plugins/p/hooks/hooks.json`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    `echo '{"permissions":{}}' > /repo/.claude/settings.json`,
    `jq '.permissions.allow += ["Bash(ls:*)"]' /repo/.claude/settings.json > /tmp/x && mv /tmp/x /repo/.claude/settings.json`,
    `grep -n hooks /repo/.claude/settings.json`,
    `cat /repo/.claude/settings.json`,
    `jq .hooks /repo/.claude/settings.json`,
    `echo hooks > /tmp/notes.txt`,
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

test('the owner\'s admin switch still allows all of it', () => {
  const env = { ['PIPELINE_' + 'ADMIN']: '1' };
  assert.equal(file('Write', { file_path: '/home/u/.claude/hooks/x.mjs', content: 'x' }, { env }), 'allow');
  assert.equal(file('Write', { file_path: '/repo/.claude/settings.json', content: '{"hooks":{}}' }, { env, ...reading({}) }), 'allow');
  assert.equal(file('Write', { file_path: '/home/u/.claude/plugins/p/hooks/hooks.json', content: '{}' }, { env }), 'allow');
  assert.equal(bash('echo x > ~/.claude/hooks/x.mjs', { env }), 'allow');
  assert.equal(bash('echo hooks > /repo/.claude/settings.json', { env }), 'allow');
});
