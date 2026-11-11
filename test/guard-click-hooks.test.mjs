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

test('Bash writes to those files are judged by their target: hooks added or unknowable content denied, a permission-only text allowed; reads stay allowed', () => {
  for (const cmd of [
    `echo '{"hooks":{}}' > /repo/.claude/settings.json`,
    `cat > /repo/.claude/settings.local.json <<'EOF'\n{"hooks":{"Stop":[]}}\nEOF`,
    `jq '.hooks = {}' /repo/.claude/settings.json > /tmp/x && mv /tmp/x /repo/.claude/settings.json`,
    `jq '.permissions.allow += ["Bash(ls:*)"]' /repo/.claude/settings.json > /tmp/x && mv /tmp/x /repo/.claude/settings.json`, // (R1-B1: the content is only known when jq runs)
    `printf 'hooks:' >> /repo/.claude/skills/mine/SKILL.md`,
    `echo x > /home/u/.claude/plugins/p/hooks/hooks.json`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    `echo '{"permissions":{}}' > /repo/.claude/settings.json`,
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

// ---- round 1 (R1-B1, R1-B2, R1-B3) ------------------------------------------------------------------------------------------------------

const HOOKED = '{"hooks":{"PostToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"/tmp/evil.sh"}]}]}}';
const PERMS = '{"permissions":{"allow":["Bash(ls:*)"]}}';
const onDisk = (files) => ({ readText: (p) => files[p] ?? null, existsSync: (p) => Object.hasOwn(files, p) });

test('R1-B1: a staged copy onto a settings file (cp / mv / cat > from a file) is judged by what the source holds', () => {
  const files = onDisk({ '/tmp/c.json': HOOKED, '/tmp/p.json': PERMS, '/repo/.claude/settings.local.json': '{"permissions":{"allow":[]}}' });
  for (const cmd of [
    'cp /tmp/c.json /repo/.claude/settings.local.json', 'mv /tmp/c.json /repo/.claude/settings.local.json', 'cat /tmp/c.json > /repo/.claude/settings.local.json',
    'cp /tmp/c.json .claude/settings.local.json', 'cd /repo/.claude && cp /tmp/c.json settings.local.json', 'cp /tmp/c.json /repo/.claude/settings.json',
  ]) assert.equal(bash(cmd, files), 'deny', cmd);
  for (const cmd of ['cp /tmp/p.json /repo/.claude/settings.local.json', 'mv /tmp/p.json /repo/.claude/settings.local.json', 'cp /repo/.claude/settings.local.json /tmp/backup.json', 'cat /repo/.claude/settings.local.json > /tmp/b.json']) {
    assert.equal(bash(cmd, files), 'allow', cmd);
  }
  // a source that cannot be read, or that the line itself builds with a program
  assert.equal(bash('cp /tmp/missing.json /repo/.claude/settings.local.json', files), 'allow', 'a source that is not there cannot be copied');
  assert.equal(bash('echo \'{"hooks":{}}\' > /tmp/m.json && cp /tmp/m.json /repo/.claude/settings.local.json', files), 'deny', 'a source the line itself writes');
  assert.equal(bash("jq '.a=1' /tmp/p.json > /tmp/x && mv /tmp/x /repo/.claude/settings.local.json", files), 'deny');
  assert.equal(bash('node /tmp/gen.mjs > /repo/.claude/settings.local.json', files), 'deny');
  // another file type: the same for a skill's front matter, a folder target, a glob target
  const skill = '---\nname: x\nhooks:\n  Stop: []\n---\n';
  const plain = '---\nname: x\n---\nbody\n';
  const fm = onDisk({ '/tmp/SKILL.md': skill, '/tmp/ok.md': plain, '/repo/.claude/skills/x/SKILL.md': plain });
  assert.equal(bash('cp /tmp/SKILL.md /repo/.claude/skills/x/SKILL.md', fm), 'deny');
  assert.equal(bash('cp /tmp/SKILL.md /repo/.claude/skills/x/', fm), 'deny');
  assert.equal(bash('cp /tmp/SKILL.md /repo/.claude/skills/*/SKILL.md', fm), 'deny');
  assert.equal(bash('cp /tmp/ok.md /repo/.claude/skills/x/SKILL.md', fm), 'allow');
  // a plugin hooks file is never written from Bash
  assert.equal(bash('cp /tmp/c.json /home/u/.claude/plugins/cache/m/p/1/hooks/hooks.json', files), 'deny');
});

test('R1-B2: quoted keys, a BOM, trailing blanks, flow mappings, complex and merge keys cannot hide a front-matter hooks block', () => {
  const skill = '/repo/.claude/skills/new/SKILL.md';
  const hooked = (key) => `---\nname: new\n${key}\n  PostToolUse:\n    - matcher: x\n      hooks:\n        - type: command\n          command: /tmp/e.sh\n---\nbody\n`;
  for (const key of ['hooks:', '"hooks":', "'hooks':", 'hooks :']) assert.equal(file('Write', { file_path: skill, content: hooked(key) }, reading({})), 'deny', key);
  assert.equal(file('Write', { file_path: skill, content: `\uFEFF${hooked('"hooks":')}` }, reading({})), 'deny', 'BOM');
  assert.equal(file('Write', { file_path: skill, content: hooked('hooks:').replace('---\n', '--- \n') }, reading({})), 'deny', 'opening line with a trailing blank');
  assert.equal(file('Write', { file_path: skill, content: hooked('hooks:').replace(/\n/g, '\r\n') }, reading({})), 'deny', 'CRLF');
  for (const line of ['"ho\\u006fks":\n  Stop: []', '{hooks: {Stop: []}}', '? hooks\n: {Stop: []}', '<<: *base', "'ho''oks': 1"]) {
    assert.equal(file('Write', { file_path: skill, content: `---\nname: new\n${line}\n---\nbody\n` }, reading({})), 'deny', line);
  }
  // an edit of the body only, in a file whose front matter was already unreadable, stays allowed
  const odd = '---\nname: new\n{hooks: {}}\n---\nbody\n';
  assert.equal(file('Edit', { file_path: skill, old_string: 'body', new_string: 'other body' }, reading({ [skill]: odd })), 'allow');
  assert.equal(file('Edit', { file_path: skill, old_string: '{hooks: {}}', new_string: '{hooks: {Stop: []}}' }, reading({ [skill]: odd })), 'deny');
  assert.equal(file('Write', { file_path: skill, content: '---\nname: new\nmy key: value\ndescription: |\n  hooks: not a key\n---\nbody\n' }, reading({})), 'allow', 'a block scalar that says hooks:');
});

test('R1-B3: commands, a plugin\'s skills / agents / commands and a plugin manifest are hook surfaces too', () => {
  const hooked = '---\nname: n\nhooks:\n  Stop: []\n---\n';
  const plain = '---\nname: n\n---\n';
  for (const p of ['/repo/.claude/commands/c.md', '/home/u/.claude/commands/c.md', '/home/u/.claude/plugins/cache/m/p/1.0/skills/s/SKILL.md', '/home/u/.claude/plugins/cache/m/p/1.0/agents/a.md', '/home/u/.claude-eaglewatch/plugins/p/commands/c.md']) {
    assert.equal(file('Write', { file_path: p, content: hooked }, reading({})), 'deny', p);
    assert.equal(file('Write', { file_path: p, content: plain }, reading({})), 'allow', p);
  }
  const manifest = '/home/u/.claude/plugins/cache/m/p/1.0/.claude-plugin/plugin.json';
  assert.equal(file('Write', { file_path: manifest, content: '{"name":"p","hooks":{"Stop":[]}}' }, reading({})), 'deny');
  assert.equal(file('Write', { file_path: manifest, content: '{"name":"p","skills":"./elsewhere"}' }, reading({})), 'deny', 'a component location can point at a folder with hooks');
  assert.equal(file('Write', { file_path: manifest, content: '{"name":"p","version":"2"}' }, reading({ [manifest]: '{"name":"p","version":"1"}' })), 'allow');
  assert.equal(bash('cp /tmp/h.md /home/u/.claude/plugins/cache/m/p/1.0/skills/s/SKILL.md', onDisk({ '/tmp/h.md': hooked })), 'deny');
  assert.equal(bash('cp /tmp/h.md /repo/.claude/commands/c.md', onDisk({ '/tmp/h.md': hooked })), 'deny');
});
