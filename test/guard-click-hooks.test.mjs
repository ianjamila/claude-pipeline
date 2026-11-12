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

test('R2-B1: a front matter whose whole root mapping is indented cannot hide a hooks block', () => {
  const skill = '/repo/.claude/skills/custom/SKILL.md';
  const hooked = '---\n  name: custom\n  hooks:\n    PreToolUse:\n      - matcher: AskUserQuestion\n---\nbody\n';
  assert.equal(file('Write', { file_path: skill, content: hooked }, reading({})), 'deny');
  assert.equal(file('Write', { file_path: skill, content: '---\n# a comment\n\t name: custom\n---\nbody\n' }, reading({})), 'deny', 'a comment first, then the indented root');
  assert.equal(file('Write', { file_path: skill, content: '---\nname: custom\ndescription: x\n---\nbody\n' }, reading({})), 'allow');
  assert.equal(file('Write', { file_path: skill, content: '---\n# comment\nname: custom\ndescription: |\n  indented text\n---\nbody\n' }, reading({})), 'allow', 'an indented block scalar after a top-level key');
});

test('R2-F4: a lone CR is a line break; odd opening lines, NEL / LS / PS and a `...` line cannot hide a hooks block', () => {
  const skill = '/repo/.claude/skills/new/SKILL.md';
  const w = (content) => file('Write', { file_path: skill, content }, reading({}));
  const hooks = 'hooks:\n  PreToolUse:\n    - matcher: AskUserQuestion\n';
  assert.equal(w('---\nname: x\rhooks:\r  PreToolUse:\r    - matcher: AskUserQuestion\n---\nbody\n'), 'deny', 'a bare CR');
  assert.equal(w('---\rname: x\rhooks:\r  Stop: []\r---\rbody\r'), 'deny', 'all CR');
  for (const tail of ['\f', ' ', '\r', ' \t  ']) assert.equal(w(`---${tail}\nname: x\n${hooks}---\nbody\n`), 'deny', `opening line tail ${JSON.stringify(tail)}`);
  assert.equal(w(`\n\n---\nname: x\n${hooks}---\nbody\n`), 'deny', 'blank lines before the opener');
  for (const ch of ['\u0085', ' ', ' ']) assert.equal(w(`---\nname: x${ch}hooks:${ch}  Stop: []\n---\nbody\n`), 'deny', `U+${ch.codePointAt(0).toString(16)}`);
  assert.equal(w(`---\nname: x\n...\n${hooks}---\nbody\n`), 'deny', 'a document-end line does not end the block');
  assert.equal(w('---\nname: x\n---\nbody\n'), 'allow');
  assert.equal(w('---\r\nname: x\r\n---\r\nbody\r\n'), 'allow', 'CRLF without hooks');
  assert.equal(w('just a body\n---\nhooks:\n'), 'allow', 'no front matter');
});

test('R2-B2: the guard protects what the inventory reads: namespaced commands / agents, any .md below a plugin folder, installed plugin paths and manifest-named locations', () => {
  const hooked = '---\nname: n\nhooks:\n  Stop: []\n---\n';
  const plain = '---\nname: n\n---\n';
  for (const p of ['/repo/.claude/commands/ns/action.md', '/repo/.claude/commands/a/b/c/d.md', '/home/u/.claude/agents/team/x/y.md', '/home/u/.claude/plugins/cache/m/p/1/anything/deep/README.md']) {
    assert.equal(file('Write', { file_path: p, content: hooked }, reading({})), 'deny', p);
    assert.equal(file('Write', { file_path: p, content: plain }, reading({})), 'allow', p);
  }
  // an install path outside any .claude*/plugins folder, and a location its manifest names (read from the real installed_plugins.json of the account)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-click-hooks-'));
  const install = path.join(home, 'elsewhere', 'myplugin');
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(install, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }));
  fs.writeFileSync(path.join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', skills: './extra' }));
  const opts = { home, platform: 'linux', env: {}, realpath: (p) => p, existsSync: (p) => fs.existsSync(p), readText: () => null };
  const write = (p, content) => evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p, content }, cwd: '/repo' }, opts).decision;
  for (const p of [path.join(install, 'skills', 's', 'SKILL.md'), path.join(install, 'extra', 'example', 'SKILL.md'), path.join(install, 'commands', 'x', 'y.md')]) {
    assert.equal(write(p, hooked), 'deny', p);
    assert.equal(write(p, plain), 'allow', p);
  }
  assert.equal(write(path.join(install, 'hooks', 'hooks.json'), '{}'), 'deny', 'a plugin hooks file');
  assert.equal(write(path.join(home, 'elsewhere', 'other', 'SKILL.md'), hooked), 'allow', 'a folder no plugin list names');
});

test('R2-F1: a Bash target built by a substitution, or holding a glob in the file name, is refused when it can resolve to a hook surface', () => {
  for (const cmd of ['cp /tmp/c.json "$(git rev-parse --show-toplevel)/.claude/settings.local.json"', 'cp /tmp/c.json `git rev-parse --show-toplevel`/.claude/settings.local.json', 'cp /tmp/c.json .claude/settings.loca?.json',
    'cp /tmp/c.json .cl*de/settings.local.json', 'cat /tmp/c.json > .claud[e]/settings.json', 'cp /tmp/c.json "$(echo ~/.claude)/settings.json"', 'cp /tmp/c.json .claude/commands/n*/x.md', 'cp /tmp/c.json .claude/agents/*.md', 'cp /tmp/c.json .claude/skills/*/']) {
    assert.equal(bash(cmd), 'deny', cmd);
  }
  for (const cmd of ['cp /tmp/c.json "$DEST"', 'cp /tmp/c.json "$OUT/readme.md"', 'cp /tmp/c.json src/*/config.json', 'cp /tmp/c.json docs/*.md', 'cat .claude/settings.loca?.json', 'rm .claude/agents/other*.md']) {
    assert.equal(bash(cmd), 'allow', cmd);
  }
});

test('R2-F2: no word of the line is skipped: the target is found past the 64th word, after any number of cds', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `/tmp/a${i}`).join(' ');
  assert.equal(bash(`cat /dev/null ${many(70)} /tmp/c.json > /repo/.claude/settings.local.json`, onDisk({ '/tmp/c.json': '{"hooks":{"Stop":[]}}' })), 'deny');
  assert.equal(bash(`cp ${many(70)} /tmp/SKILL.md /repo/.claude/skills/x/`, onDisk({ '/tmp/SKILL.md': '---\nname: x\nhooks:\n  Stop: []\n---\n' })), 'deny');
  assert.equal(bash(`cat /dev/null ${many(70)} > /repo/notes.txt`), 'allow');
});

test('R2-F3: a copy onto a hook surface after a command the guard does not model is refused; a lone copy of a missing file stays allowed', () => {
  for (const cmd of ['python3 /tmp/gen.py && cp /tmp/m.json .claude/settings.local.json', 'tar xf /tmp/a.tar && cp /tmp/m.json .claude/settings.local.json', 'node /tmp/gen.mjs; mv /tmp/m.json .claude/settings.json']) {
    assert.equal(bash(cmd), 'deny', cmd);
  }
  assert.equal(bash('cp template.json .claude/settings.json'), 'allow', 'nothing before it: the missing source copies nothing');
  assert.equal(bash('cp template.json .claude/settings.json && python3 /tmp/after.py'), 'allow', 'a program AFTER the copy changes nothing about it');
});

test('R2-F6: a program the guard does not model, given a hook surface file by name, is an unknown write', () => {
  for (const cmd of ['curl -o .claude/settings.local.json https://example.test/x', 'python3 gen.py .claude/settings.local.json', 'wget -O .claude/settings.json https://example.test/x']) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of ['git add .claude/settings.json', 'git commit -m "update .claude/settings.json"', 'cat .claude/settings.json', 'git diff .claude/settings.json']) assert.equal(bash(cmd), 'allow', cmd);
});

test('R2-F7: an interpreter\'s inline code that names a hook surface file is refused without the word hooks (read or write); a read through a pipe and git add stay allowed', () => {
  assert.equal(bash(`python3 -c "import base64;open('.claude/settings.local.json','w').write(base64.b64decode('e30=').decode())"`), 'deny');
  assert.equal(bash(`node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`), 'deny');
  assert.equal(bash(`python3 -c "print(open('.claude/settings.json').read())"`), 'deny', 'R4-B1: no plain-read exemption: a program that names the file is refused');
  // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
  assert.equal(bash(`cat .claude/settings.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'`), 'deny');
  assert.equal(bash('git add .claude/settings.json'), 'allow');
});

// ---- round 3 (R3-B1, R3-B2, R3-F1, R3-F2) -----------------------------------------------------------------------------------------------

test('R3-B1: inline code that names a hook surface file in its program text is refused whatever it does (link, copy, sendfile); a read through a pipe, or a program that names none, stays allowed', () => {
  for (const cmd of [
    `python3 -c "import os; os.link('/tmp/payload','.claude/settings.local.json')"`,
    `python3 -c "import os; fd=os.open('.claude/settings.local.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,384); os.sendfile(fd,os.open('/tmp/payload',os.O_RDONLY),0,4096)"`,
    `node -e "require('fs').linkSync('/tmp/payload','.claude/settings.json')"`,
    `python3 -c "import shutil; shutil.copy('/tmp/payload', '.claude/settings.local.json')"`,
    `python3 <<'PY'\nimport os\nos.link('/tmp/payload', '.claude/settings.local.json')\nPY`,
    `echo "import os; os.link('/tmp/payload', '.claude/settings.local.json')" | python3`,
    `python3 - <<< "import os; os.link('/tmp/payload', '.claude/skills/s/SKILL.md')"`,
    // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
    `cat .claude/settings.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    `python3 -c "import os; os.link('/tmp/a','/tmp/b')"`,
    `node -e "console.log(1)"`,
    `git add .claude/settings.json`,
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

test('R3-B2: a plugin install or manifest location past the old 500 / 50 / 100 limits is still a hook surface', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-click-hooks-'));
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  const hooked = '---\nname: n\nhooks:\n  Stop: []\n---\n';
  const make = (name) => { const d = path.join(home, 'elsewhere', name); fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true }); return d; };
  const opts = { home, platform: 'linux', env: {}, realpath: (p) => p, existsSync: (p) => fs.existsSync(p), readText: () => null };
  const write = (p) => evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p, content: hooked }, cwd: '/repo' }, opts).decision;
  const list = (plugins) => fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  // the 56th installation of one plugin
  const many = make('many');
  const entries = Array.from({ length: 60 }, (_, i) => ({ installPath: i === 55 ? many : path.join(home, 'elsewhere', `none${i}`) }));
  list({ 'p@m': entries });
  assert.equal(write(path.join(many, 'skills', 's', 'SKILL.md')), 'deny', 'installation 56 of a plugin');
  // the 511th plugin
  const last = make('last');
  list(Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`p${i}@m`, [{ installPath: i === 510 ? last : path.join(home, 'elsewhere', `n${i}`) }]])));
  assert.equal(write(path.join(last, 'skills', 's', 'SKILL.md')), 'deny', 'plugin 511 of the list');
  // the 116th location a manifest names
  const m = make('manifest');
  list({ 'p@m': [{ installPath: m }] });
  fs.writeFileSync(path.join(m, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', skills: Array.from({ length: 120 }, (_, i) => `./loc${i}`) }));
  assert.equal(write(path.join(m, 'loc115', 'x', 'SKILL.md')), 'deny', 'location 116 of a manifest');
  assert.equal(write(path.join(home, 'elsewhere', 'unlisted', 'SKILL.md')), 'allow');
});

test('R3-F1: git log / show / diff --output names a file it writes; a curl / wget option cluster with an attached value names it too', () => {
  for (const cmd of [
    'git log -1 --format=%B --output=.claude/settings.local.json', 'git show HEAD --output .claude/settings.json', 'git diff --output=.claude/skills/s/SKILL.md',
    'curl -so.claude/settings.local.json https://example.test/x', 'wget -qO.claude/settings.json https://example.test/x', 'curl -fsSLo.claude/settings.local.json https://example.test/x',
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of ['git log --oneline', 'git diff --stat', 'git log -1 --output=/tmp/out.txt', 'curl -so /tmp/x https://example.test/x', 'curl -so/tmp/x https://example.test/x', 'cp a.md docs/']) assert.equal(bash(cmd), 'allow', cmd);
});

test('R3-F2: a literal .claude-<name> folder, a substitution that is a whole file name, and a nested ${..${..}} are refused as possible hook surfaces', () => {
  for (const cmd of [
    'cp /tmp/h.md ~/.claude-eaglewatch/agents/revie?er.md', 'cp /tmp/h.md /home/u/.claude-eaglewatch/commands/n*/x.md', 'cp /tmp/c.json .claude-eaglewatch/settings.loca?.json',
    'cp /tmp/c.json .claude/$(cat /tmp/name)', 'cp /tmp/c.json ".claude/$F"', 'cp /tmp/c.json "$(echo .claude/settings.local.json)"', 'cp /tmp/c.json .claude/`cat /tmp/name`',
    'cp /tmp/c.json .claude/${A:-${B}}settings.json', 'cp /tmp/c.json ".claude/${A:-${B:-x}}"',
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of ['cp /tmp/c.json "$DEST"', 'cp /tmp/c.json "$OUT/readme.md"', 'cp /tmp/c.json $(pwd)/settings.json', 'cp /tmp/c.json docs/${A:-${B}}x.md', 'cp a.md docs/', 'cp /tmp/c.json src/$F']) assert.equal(bash(cmd), 'allow', cmd);
});

// ---- round 4 (R4-B1, R4-F1) ------------------------------------------------------------------------------------------------------------

test('R4-B1: no plain-read exemption: an inline program that names a hook surface is refused when it only seems to read (rebound name, flag w, read then write the same path)', () => {
  for (const cmd of [
    `python3 -c "import shutil; shutil.copyfile('/tmp/payload',open('.claude/settings.local.json').name)"`,
    `python3 -c "open=lambda p: shutil.copyfile('/tmp/payload',p); open('.claude/settings.local.json')"`,
    `node -e "require('fs').readFileSync('.claude/settings.json',{flag:'w'})"`,
    `python3 -c "open('.claude/settings.local.json'); open('.claude/settings.local.json','w').write('{}')"`,
    `python3 -c "print(Path('.claude/settings.json').read_text())"`,
    `node -e "console.log(require('fs').readFileSync('.claude/settings.json','utf8'))"`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
  assert.equal(bash(`cat .claude/settings.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'`), 'deny');
});

test('R4-F1: a program fed on stdin is judged whatever option the interpreter holds that carries no program (-E, -R, -rjson, -r fs, -Mstrict)', () => {
  const prog = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  for (const cmd of [
    `echo "${prog}" | python3 -E`,
    `echo "${prog}" | python3 -R`,
    `echo "${prog}" | python3 -Werror`,
    `echo "require 'fileutils'; FileUtils.ln('/tmp/payload','.claude/settings.local.json')" | ruby -rjson`,
    `echo "require('fs').linkSync('/tmp/payload','.claude/settings.local.json')" | node -r fs`,
    `echo "link '/tmp/payload','.claude/settings.local.json';" | perl -Mstrict`,
    `python3 -E <<< "${prog}"`,
    `ruby -rjson <<< "File.link('/tmp/payload','.claude/settings.local.json')"`,
    // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
    `echo ".claude/settings.json" | python3 -E -c 'import sys; print(sys.stdin.read())'`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    `python3 -c "import os; os.link('/tmp/a','/tmp/b')" 2>&1`,
    `node -r fs -e "console.log(1)"`,
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

// ---- round 5 (R5-B1, R5-F1) ------------------------------------------------------------------------------------------------------------

test('R5-B1, R5-F1: a code option does not prove the program is not on stdin: -c after the stdin operand, a value-taking option, -i / PYTHONINSPECT / --interactive, lua with -', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const js = "require('fs').linkSync('/tmp/payload','.claude/settings.local.json')";
  const lua = "os.execute('ln /tmp/payload .claude/settings.local.json')";
  const pl = "link '/tmp/payload','.claude/settings.local.json';";
  for (const cmd of [
    `echo "${py}" | python3 - -c ignored`,
    `echo "${py}" | python3 -X -cx`,
    `echo "${py}" | python3 -W -c -`,
    `echo "${py}" | python3 -- -c x`,
    `echo "${py}" | python3 -m foo -c x`,
    `echo "${pl}" | perl -I -e -`,
    `echo "${py}" | python3 -i -c pass`,
    `echo "${py}" | python3 -ic pass`,
    `echo "${py}" | PYTHONINSPECT=1 python3 -c pass`,
    `export PYTHONINSPECT=1; echo "${py}" | python3 -c pass`,
    `echo "${js}" | node -i -e 0`,
    `echo "${js}" | node --interactive -e 0`,
    `echo "${lua}" | lua -e '' -`,
    `echo "${lua}" | lua -i -e ''`,
    // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
    `echo ".claude/settings.json" | python3 -E -c 'import sys; print(sys.stdin.read())'`,
    `echo ".claude/settings.json" | python3 -Bu -c 'import sys; print(sys.stdin.read())'`,
    `echo ".claude/settings.json" | node --no-warnings -e "console.log(1)"`,
    `echo ".claude/settings.json" | perl -w -e 'print 1'`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
});

// ---- round 6 (R6-B1, R6-F1) ------------------------------------------------------------------------------------------------------------

test('R6-B1, R6-F1: a program on stdin named by a path or a program-file option (awk -E - / -f - / -bf -, python3 /dev/stdin, node -r /dev/stdin, LUA_INIT=@/dev/stdin) is scanned', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const js = "require('fs').linkSync('/tmp/payload','.claude/settings.local.json')";
  const lua = "os.execute('ln /tmp/payload .claude/settings.local.json')";
  const pl = "link '/tmp/payload','.claude/settings.local.json';";
  const awk = 'BEGIN { system("ln /tmp/payload .claude/settings.local.json") }';
  const rb = "File.link('/tmp/payload','.claude/settings.local.json')";
  const failures = [];
  for (const cmd of [
    `echo '${awk}' | awk -E -`,
    `echo '${awk}' | gawk -E -`,
    `echo '${awk}' | awk --exec -`,
    `echo '${awk}' | awk --fi -`,
    `echo '${awk}' | awk --exe -`,
    `echo '${awk}' | awk -bf -`,
    `echo '${awk}' | awk -f -`,
    `echo '${awk}' | awk -f /dev/stdin`,
    `echo '${awk}' | awk -f /dev/fd/0`,
    `echo '${awk}' | awk --file=/dev/stdin`,
    `echo '${awk}' | gawk -i /dev/stdin 'BEGIN{}'`,
    `echo "${py}" | python3 /dev/stdin`,
    `echo "${py}" | python3 /dev/fd/0`,
    `echo "${py}" | python3 /proc/self/fd/0`,
    `echo "${pl}" | perl /dev/stdin`,
    `echo "${rb}" | ruby /dev/stdin`,
    `echo "${js}" | node /dev/stdin`,
    `echo "${lua}" | lua /dev/stdin`,
    `echo "${js}" | node -r /dev/stdin -e 0`,
    `echo "${js}" | node --require=/dev/stdin -e 0`,
    `echo "${js}" | node --import=/dev/stdin -e 0`,
    `echo "${js}" | node --loader /dev/fd/0 -e 0`,
    `echo "${lua}" | LUA_INIT=@/dev/stdin lua -e ''`,
    `echo "${lua}" | LUA_INIT=/dev/stdin lua -e ''`,
  ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  assert.deepEqual(failures, [], 'these lines were not refused');
  // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
  for (const cmd of [
    `echo ".claude/settings.json" | awk '{print}'`,
    `echo ".claude/settings.json" | python3 -E -c 'import sys; print(sys.stdin.read())'`,
    `echo ".claude/settings.json" | python3 /tmp/after.py`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  assert.equal(bash(`node -r fs -e "console.log(1)"`), 'allow');
});

test('R6 security review: non-canonical stdin paths and spaced assignments', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const js = "require('fs').linkSync('/tmp/payload','.claude/settings.local.json')";
  const lua = "os.execute('ln /tmp/payload .claude/settings.local.json')";
  const awk = 'BEGIN { system("ln /tmp/payload .claude/settings.local.json") }';
  const rb = "File.link('/tmp/payload','.claude/settings.local.json')";
  const failures = [];
  for (const cmd of [
    `echo '${awk}' | awk -f //dev/stdin`,
    `echo '${awk}' | awk -f /dev/./stdin`,
    `echo '${awk}' | awk -E /dev//fd/0`,
    `echo '${awk}' | awk -f /proc/1234/fd/0`,
    `echo '${awk}' | awk -f /dev/fd/../fd/0`,
    `echo '${awk}' | gawk -i /dev/fd/../fd/0 'BEGIN{}'`,
    `echo '${awk}' | gawk --include=/dev/fd/../fd/0 'BEGIN{}'`,
    `echo '${awk}' | gawk -l //dev/stdin 'BEGIN{}'`,
    `echo "${js}" | node -r //dev/stdin -e 0`,
    `echo "${js}" | node --require=/dev/./stdin -e 0`,
    `echo "${py}" | python3 /proc/42/fd/0`,
    `echo "${py}" | python3 /proc/self/../self/fd/0`,
    `echo "${py}" | python3 //dev/stdin`,
    `echo "${js}" | NODE_OPTIONS="--require /dev/stdin" node -e 0`,
    `export NODE_OPTIONS='-r /dev/stdin'; echo "${js}" | node -e 0`,
    `echo "${lua}" | LUA_INIT="@ /dev/stdin" lua -e ''`,
    `echo "${rb}" | RUBYOPT=-r/dev/stdin ruby -e 0`,
    `echo "${js}" | NODE_OPTIONS="--require ./x.js" node -e 0`,
    `echo "${lua}" | LUA_INIT_5_4=@/dev/stdin lua -e ''`,
  ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  assert.deepEqual(failures, [], 'these lines were not refused');
  // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
  for (const cmd of [
    `echo ".claude/settings.json" | python3 -E -c 'import sys; print(sys.stdin.read())' 2>/dev/null`,
    `echo ".claude/settings.json" | awk '{print}' > /dev/null`,
    `echo ".claude/settings.json" | python3 -E -c 'import sys; print(sys.stdin.read())' > /dev/null 2>&1`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  assert.equal(bash(`FOO=bar node -r fs -e "console.log(1)"`), 'allow');
});

// ---- round 7 (R7-B1, R7-F1, R7-F2) -----------------------------------------------------------------------------------------------------

test('R7: -W options, non-literal stdin paths, startup variables without NAME=', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const js = "require('fs').linkSync('/tmp/payload','.claude/settings.local.json')";
  const lua = "os.execute('ln /tmp/payload .claude/settings.local.json')";
  const awk = 'BEGIN { system("ln /tmp/payload .claude/settings.local.json") }';
  const failures = [];
  const dollar = '$';
  for (const cmd of [
    `echo '${awk}' | gawk -W exec=-`,
    `echo '${awk}' | gawk -Wexec=-`,
    `echo '${awk}' | gawk -W exec -`,
    `echo '${awk}' | gawk -W file=-`,
    `echo '${awk}' | gawk -W include=/dev/stdin 'BEGIN{}'`,
    `echo '${awk}' | gawk -W exe=-`,
    `echo '${awk}' | mawk -W exec /dev/stdin`,
    `echo "${py}" | python3 ../../../../../../../../../../dev/stdin`,
    `echo '${awk}' | gawk -E ../../../../../../../../dev/stdin`,
    `echo "${js}" | node -r ../../../../../../dev/stdin -e 0`,
    `echo "${js}" | node -r /de?/stdin -e 0`,
    `echo '${awk}' | gawk -E /de?/stdin`,
    `d=/dev; echo "${js}" | node -r ${dollar}d/stdin -e 0`,
    `echo "${js}" | node -r ${dollar}{HOME:0:1}dev/stdin -e 0`,
    `echo "${js}" | node -r ~/../../dev/stdin -e 0`,
    `echo "${py}" | python3 /Volumes/Macintosh\\ HD/dev/stdin`,
    `echo "${py}" | python3 "/Volumes/Macintosh HD/dev/stdin"`,
    `X=/d\\ev/stdin; echo "${js}" | node -r ${dollar}X -e 0`,
    `: "${dollar}{NODE_OPTIONS:=-r /dev/stdin}"; export NODE_OPTIONS; echo "${js}" | node -e 0`,
    `read -r NODE_OPTIONS <<< '-r /dev/stdin'; export NODE_OPTIONS; echo "${js}" | node -e 0`,
    `printf -v NODE_OPTIONS '%s' '-r /dev/stdin'; export NODE_OPTIONS; echo "${js}" | node -e 0`,
    `read -r LUA_INIT <<< '@/dev/stdin'; export LUA_INIT; echo "${lua}" | lua -e ''`,
  ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  assert.deepEqual(failures, [], 'these lines were not refused');
  // owner decision 2026-11-12 (#269 R8): a fed interpreter on a line naming a hook file is refused
  for (const cmd of [
    `echo ".claude/settings.json" | python3 -E -c 'import sys; print(sys.stdin.read())'`,
    `echo ".claude/settings.json" | awk '{print}' > /dev/null`,
    `echo ".claude/settings.json" | node -r ./lib/x.js -e 0`,
    `echo ".claude/settings.json" | awk -f prog.awk`,
    `echo ".claude/settings.json" | python3 script.py`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    `node -r fs -e "require('fs').readFileSync('README.md','utf8')"`,
    `python3 script.py < input.txt`,
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

// ---- round 8 (R8-B1, R8-F1..F5; owner decision 2026-11-12): no guessing whether an interpreter runs its input as code ------------------------

test('R8: any interpreter fed on a line naming a hook file is refused (pipe, redirect, here-string, process substitution, exec); fed but naming none, or not fed, stays allowed', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const js = "require('fs').linkSync('/tmp/payload','.claude/settings.local.json')";
  const lua = "os.execute('ln /tmp/payload .claude/settings.local.json')";
  const awk = 'BEGIN { system("ln /tmp/payload .claude/settings.local.json") }';
  const R = "system('ln /tmp/payload .claude/settings.local.json')";
  const dollar = '$';
  const failures = [];
  for (const cmd of [
    // R8-B1 / R8-F1 / R8-F2: names built by quoting or expansion, startup variables of every interpreter
    `LUA_''INIT=@/dev/stdin lua -e '' <<< "${lua}"`,
    `echo "${lua}" | LUA_''INIT=@/dev/stdin lua -e ''`,
    `read -r LUA_''INIT <<< '@/dev/stdin'; export LUA_''INIT; echo "${lua}" | lua -e ''`,
    `a=LUA_; read -r ${dollar}{a}INIT <<< '@/dev/stdin'; export ${dollar}{a}INIT; echo "${lua}" | lua -e ''`,
    `read -r R_PROFILE_USER <<< /dev/stdin; export R_PROFILE_USER; echo "${R}" | Rscript -e 0`,
    `read -r AWKPATH <<< /dev; export AWKPATH; echo '${awk}' | gawk -i stdin 'BEGIN{}'`,
    `echo "${js}" | bun --preload /dev/stdin -e 0`,
    `echo "${js}" | deno eval --preload /dev/stdin 0`,
    // R8-F3: a working directory under /dev makes a plain name stdin
    `cd /dev && echo "${py}" | python3 stdin`,
    `cd /dev/fd && echo "${py}" | python3 0`,
    `cd /dev && echo "${js}" | node -r ./stdin -e 0`,
    `cd /dev && echo '${awk}' | gawk -f stdin`,
    `pushd /dev; echo "${py}" | python3 stdin`,
    `(cd /dev; echo "${py}" | python3 stdin)`,
    // R8-F4/F5: spellings of the path, interpreter names with versions, shells
    `echo "${js}" | node --import=file:///%64ev/stdin -e 0`,
    `echo "link '/tmp/payload','.claude/settings.local.json';" | perl5.34`,
    `echo "File.link('/tmp/payload','.claude/settings.local.json')" | ruby3.3 -e 0`,
    `echo "ln /tmp/payload .claude/settings.local.json" | sh`,
    `echo "ln /tmp/payload .claude/settings.local.json" | bash -s`,
    `echo "${py}" | /usr/bin/env python3`,
    `echo "${py}" | timeout 5 python3`,
    `echo "${py}" | python3.12 -`,
    `echo "${py}" |& python3`,
    // other ways to feed one
    `python3 <(echo "${py}")`,
    `python3 /dev/stdin < /tmp/prog.py # ${py}`,
    `exec 0</tmp/p; python3 /dev/stdin # .claude/settings.local.json`,
    `exec < /tmp/p; node /dev/stdin; : .claude/settings.local.json`,
    `python3 0< /tmp/p.py; : .claude/settings.local.json`,
    `python3 script.py < .claude/settings.json`,
    `python3 <<< "x"; cat .claude/settings.json`,
    `cat x.py | { python3 -; } # .claude/settings.json`,
    `cat x.py | (python3 -) # .claude/settings.json`,
    `cat x.py | while read l; do python3 -c 0; done # .claude/settings.json`,
    `{ python3 -c 0; } < x.py # .claude/settings.json`,
    `coproc python3 -c 0; cat .claude/settings.json`,
    `cat .claude/settings.json | ${dollar}PY -c 0`,
    `cat .claude/settings.json | php -r 'echo 1;'`,
    `cat .claude/settings.json | osascript -e 'x'`,
    `cat .claude/settings.json | julia -e '1'`,
    `cat .claude/settings.json | tclsh8.6`,
    // the json.tool exemption is narrow: any variable, option, extra operand or `-` operand leaves it refused
    'PYTHONINSPECT=1 python3 -m json.tool < .claude/settings.json',
    'export PYTHONSTARTUP=/dev/stdin; python3 -m json.tool < .claude/settings.json',
    'cat .claude/settings.json | python3 -i -m json.tool',
    'python3 -m json.tool -c x < .claude/settings.json',
    'python3 -m json.tool --json-lines < .claude/settings.json',
    'python3 -X dev -m json.tool < .claude/settings.json',
    'python3 -m json.tool a b c < .claude/settings.json',
    '${PY:-python3} -m json.tool < .claude/settings.json',
    'exec 0<x; python3 -m json.tool .claude/settings.json',
    'python3 -m json.tool <(echo x) < .claude/settings.json',
    `echo "${py}" | python3 -m json.tool -`,
  ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  assert.deepEqual(failures, [], 'these lines were not refused');
  // R8-F4: an ordinary script FILE run is not refused for its path; fed but naming no hook file, jq, and a non-fed awk are fine
  for (const cmd of [
    'node ~/.claude/pipeline/bin/pipeline.mjs status; cat .claude/settings.json',
    // (a script handed a hook file BY NAME -- `python3 ../tools/lint.py .claude/commands/x.md` -- stays refused by the older unknown-write rule (R2-F6), also before round 5; these read it in a separate command)
    'python3 ../tools/lint.py README.md; cat .claude/commands/x.md',
    'node "$ROOT/check.mjs" --all; cat .claude/skills/a/SKILL.md',
    'node scripts/dev/check.mjs; cat .claude/settings.json',
    'node ~/x.mjs; cat .claude/settings.json',
    'node ~/.claude/pipeline/bin/pipeline.mjs job wait x --run-id y | node -e \'let s="";process.stdin.on("data",d=>s+=d)\'',
    'cat .claude/settings.json | jq .hooks',
    "awk '{print}' README.md > /dev/null",
    'cat .claude/settings.json | grep -c python',
    // the one fed interpreter run kept allowed: a bare python -m json.tool pretty-print
    'python -m json.tool < ~/.claude/settings.json',
    'cat .claude/settings.json | python3 -m json.tool',
    'cat .claude/settings.json | python3.12 -m json.tool',
    'cat .claude/settings.json | grep node',
    'python3 -c "print(1)" | cat; ls .claude/settings.json',
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

// ---- round 9 (R9-F1..F4): feeds by >( and =(, own words on a fed interpreter, unmasked hook names, keywords are not interpreters ----------------

test('R9: feeds through >( =( and functions, quote-split names on a fed interpreter, prose flags and a bare interpreter are refused; [[ and keywords are not interpreters', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const split = "import os; os.link('/tmp/payload','.cl\"\"aude/settings.local.json')";
  const failures = [];
  for (const cmd of [
    // R9-F1: feeds the older list did not know
    `echo "${py}" > >(python3)`,
    `exec > >(python3 -); echo "${py}"`,
    `{ echo "${py}"; } > >(node -)`,
    `python3 =(echo "${py}")`,
    `f() python3 -; echo "${py}" | f`,
    `function f { python3 -; }; echo "${py}" | f`,
    `f() { node; }; echo "${py}" | f`,
    // a bare interpreter (no program of its own) on a line naming the file, with no visible feed
    'python3 -; cat .claude/settings.local.json',
    'python3 - ; : .claude/settings.local.json',
    'node; cat .claude/settings.json',
    'python3; cat .claude/settings.json',
    'bash -s; cat .claude/settings.json',
    'command python3 -; cat .claude/settings.json',
    'exec python3; cat .claude/settings.json',
    'env python3; cat .claude/settings.json',
    // R9-F2: a fed interpreter's own words, a here-string and the feeding command's words are read de-quoted
    `python3 -c "${split}" < /dev/null`,
    `python3 <<< "${split}"`,
    `echo "${split}" | python3`,
    `echo "${split}" > >(python3)`,
    // R9-F3: a test-runner prose flag does not hide the name
    `node -e 'require("fs").copyFileSync("/tmp/payload.json", process.argv[2])' -- -t .claude/settings.local.json`,
    `git log --grep=.claude/settings.local.json; echo "${py}" | python3`,
    `node -e 'require("fs").copyFileSync("/tmp/payload.json", process.argv[2])' -- --test-name-pattern=.claude/settings.local.json`,
  ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  assert.deepEqual(failures, [], 'these lines were not refused');
  // R9-F4: [[ ]], loops and builtins that never run their words are not interpreters; wrappers still are
  for (const cmd of [
    'if [[ -f .claude/settings.json ]]; then jq .hooks .claude/settings.json | head; fi',
    'for f in ~/.claude/skills/*/SKILL.md; do [[ -s $f ]] && head -3 "$f" | grep name; done',
    'for t in node python3; do which $t; done | cat',
    'for t in node python3; do command -v $t; done | cat; ls .claude/settings.json',
    'type python3 | cat; cat .claude/settings.json',
    'export P=python3; cat .claude/settings.json | head',
    'case $x in node) cat .claude/settings.json | head;; esac',
    'while read -r l; do echo "$l"; done < .claude/settings.json',
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

// ---- round 9 security review: for / select / case / [[ are harmless only as a bare header ---------------------------------------------------

test('R9 security review: loop keywords are exempt only as bare headers', () => {
  const py = "import os; os.link('/tmp/payload','.claude/settings.local.json')";
  const failures = [];
  // (the targets the bare `cp` / `tee` is itself refused on; a project settings file is judged by what lands in it, see the hook-adding lines below)
  for (const target of ['~/.claude/settings.json', '~/.claude/hooks/notify.mjs', '~/.claude/settings.local.json']) {
    for (const cmd of [
      // zsh short loop form: the body stays in the keyword's segment
      `for f (x) cp /tmp/payload ${target}`,
      `for f (x) tee ${target} < /tmp/p`,
      `select f (x) cp /tmp/p ${target}`,
      `select f (x) tee ${target}`,
      `for f in a b; cp /tmp/p ${target}`,
      `for ((i=0;i<1;i++)) cp /tmp/p ${target}`,
      `case x in x) cp /tmp/p ${target};; esac`,
      `case x in x) tee ${target} < /tmp/p;; esac`,
      `[[ -f a ]] cp /tmp/p ${target}`,
      `if [[ -f a ]] cp /tmp/p ${target}`,
      `[[ -f a ]] && cp /tmp/p ${target}`,
    ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  }
  for (const cmd of [
    'for f (x) cp /tmp/payload .claude/settings.json',
    'for f (x) cp /tmp/payload .claude/settings.local.json',
    'select f (x) cp /tmp/p .claude/settings.json',
    'for ((i=0;i<1;i++)) cp /tmp/p .claude/settings.json',
    `for f (x) python3 -; echo "${py}"`,
    `for f (x) python3 - <<< "${py}"`,
    `select f (x) node -; echo "${py}"`,
    `for f (x) python3 -; cat .claude/settings.local.json`,
    `[[ -f a ]] python3 -; cat .claude/settings.local.json`,
  ]) if (bash(cmd) !== 'deny') failures.push(cmd);
  assert.deepEqual(failures, [], 'these lines were not refused');
  // a bare header (or a header whose body the parser split off) stays harmless
  for (const cmd of [
    'if [[ -f .claude/settings.json ]]; then jq .hooks .claude/settings.json | head; fi',
    'for f in ~/.claude/skills/*/SKILL.md; do [[ -s $f ]] && head -3 "$f" | grep name; done',
    'for t in node python3; do which $t; done | cat',
    'for t in node python3; do command -v $t; done | cat; ls .claude/settings.json',
    'type python3 | cat; cat .claude/settings.json',
    'export P=python3; cat .claude/settings.json | head',
    'case $x in node) cat .claude/settings.json | head;; esac',
    'while read -r l; do echo "$l"; done < .claude/settings.json',
    'for f in .claude/settings.json; do head -3 "$f"; done',
    'for f in a b\ndo head -3 "$f"; done; cat .claude/settings.json',
    '[[ -f a && -s b ]] && head x; ls .claude/settings.json',
  ]) assert.equal(bash(cmd), 'allow', cmd);
});
