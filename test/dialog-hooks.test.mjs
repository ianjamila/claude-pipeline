// hooks/lib/dialog-hooks.mjs + `pipeline owner-go` (#261, plan Rev 6 B5): which hooks could answer the choice dialog, and the owner's list of approved ones. Temp homes and project folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approveDialogHooks, checkDialogHooks, commandTarget, dialogHandlers, dialogHooksFile, hookCheck, matcherMatchesDialog, resolveCommand, tilde } from '../pipeline/hooks/lib/dialog-hooks.mjs';
import { run } from '../pipeline/commands/owner-go.mjs';

const ADMIN = { ['PIPELINE_' + 'ADMIN']: '1' }; // (the owner's switch, built here so this file does not itself look like a script that sets it)

// A temp account home (with ~/.claude), an empty project folder, and helpers. managedPaths is always injected: the real machine's managed settings are never read.
function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dialog-hooks-')));
  const cwd = join(home, 'project');
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const w = { home, cwd, managedPaths: [] };
  w.script = (rel, body = 'process.exit(0)\n') => { const f = join(home, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, body); return f; };
  w.json = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  w.settings = (value, dir = join(home, '.claude'), name = 'settings.json') => w.json(join(dir, name), value);
  w.check = (over = {}) => checkDialogHooks({ home, cwd, managedPaths: [], ...over });
  w.handlers = () => dialogHandlers({ home, cwd, managedPaths: [] });
  w.approve = (over = {}) => approveDialogHooks({ home, cwd, managedPaths: [], env: {}, ctx: { hasClaudeCodeAncestor: () => false }, ...over });
  return w;
}
const hookEntry = (command, matcher, event = 'PreToolUse') => ({ hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] }] } });

test('matcher: absent, "", "*", a regex that matches the dialog, an invalid regex all match; Bash does not', () => {
  for (const m of [undefined, null, '', '*', 'AskUserQuestion', 'AskUserQuestion|ExitPlanMode', 'Ask.*', '(', '[a-', 'Bash|AskUserQuestion']) assert.equal(matcherMatchesDialog(m), true, String(m));
  for (const m of ['Bash', 'Ask', 'Question', 'Bash|Edit|Write', 'mcp__.*']) assert.equal(matcherMatchesDialog(m), false, m);
});

test('a handler whose matcher cannot match the dialog, or on another event, is not collected', () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  w.settings({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${f}` }] }], PostToolUse: [{ hooks: [{ type: 'command', command: `node ${f}` }] }] } });
  const r = w.handlers();
  assert.equal(r.ok, true);
  assert.deepEqual(r.handlers, []);
  assert.equal(w.check().ok, true);
});

test('an unlisted handler is not ok and the reason names it in plain words', () => {
  const w = world();
  const f = w.script('.claude/hooks/notify.mjs');
  w.settings(hookEntry(`node ${f}`, 'AskUserQuestion|ExitPlanMode'));
  const r = w.check();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unlisted dialog hook ~/.claude/hooks/notify.mjs (PreToolUse AskUserQuestion|ExitPlanMode)');
  assert.equal(r.offenders.length, 1);
  assert.match(r.hookLayersSha256, /^[0-9a-f]{64}$/);
});

test('~ and $HOME / ${HOME} in the command are expanded with the account home', () => {
  const w = world();
  const f = w.script('.claude/hooks/x.mjs');
  for (const cmd of ['node ~/.claude/hooks/x.mjs', 'node $HOME/.claude/hooks/x.mjs', 'node "${HOME}/.claude/hooks/x.mjs" --flag=1', '~/.claude/hooks/x.mjs']) {
    if (cmd.startsWith('~')) chmodSync(f, 0o755);
    assert.equal(resolveCommand(cmd, { home: w.home }), f, cmd);
  }
});

test('listed with the same bytes => ok; the bytes changed => not ok; a different command for the same script => not ok', () => {
  const w = world();
  const f = w.script('.claude/hooks/notify.mjs', 'console.log(1)\n');
  w.settings(hookEntry(`node ${f}`));
  assert.equal(w.check().ok, false);
  const a = w.approve();
  assert.equal(a.ok, true);
  assert.equal(a.hooks.length, 1);
  assert.equal(JSON.parse(readFileSync(dialogHooksFile(w.home), 'utf8')).v, 1);
  const ok = w.check();
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.reason, null);
  const before = ok.hookLayersSha256;
  writeFileSync(f, 'console.log(2)\n');
  const changed = w.check();
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /^changed dialog hook ~\/\.claude\/hooks\/notify\.mjs \(PreToolUse \*\)/);
  assert.notEqual(changed.hookLayersSha256, before, 'the fingerprint follows the script bytes');
  writeFileSync(f, 'console.log(1)\n');
  assert.equal(w.check().ok, true);
  w.settings(hookEntry(`node ${f} --other`));
  assert.equal(w.check().ok, false, 'same script, other command: not the listed one');
});

test('an inline sh -c on the dialog is unresolvable: not ok, and approve refuses and writes nothing', () => {
  const w = world();
  w.settings(hookEntry(`sh -c 'echo "{}"'`, 'AskUserQuestion'));
  const h = w.handlers().handlers;
  assert.equal(h.length, 1);
  assert.equal(h[0].scriptPath, null);
  const r = w.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unresolvable dialog hook sh -c/);
  const a = w.approve();
  assert.equal(a.ok, false);
  assert.match(a.reason, /does not resolve to one script/);
  assert.throws(() => readFileSync(dialogHooksFile(w.home)), /ENOENT/);
});

test('commands that are not one script are unresolvable: npx, inline node, pipes, env prefixes, relative paths, a missing file, an interpreter as the script, a non-command hook', () => {
  const w = world();
  const f = w.script('.claude/hooks/ok.mjs');
  for (const cmd of ['npx some-tool', 'node -e "1"', `node ${f} | cat`, `FOO=1 node ${f}`, 'node ./hooks/x.mjs', `node ${w.home}/missing.mjs`, '/usr/bin/env node /x.mjs', `node ${f}; true`, `node $(echo ${f})`, 'node "unterminated', '']) {
    assert.equal(resolveCommand(cmd, { home: w.home }), null, cmd);
  }
  assert.equal(resolveCommand(`node ${f}`, { home: w.home }), f);
  w.settings({ hooks: { PermissionRequest: [{ hooks: [{ type: 'prompt', prompt: 'allow?' }] }] } });
  const r = w.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unresolvable dialog hook \(prompt hook\)/);
});

test('a handler installed with the pipeline (real path inside ~/.claude/pipeline) is trusted: ok without a list; a link out of it is not', () => {
  const w = world();
  const inside = w.script('.claude/pipeline/hooks/guard.mjs');
  w.settings(hookEntry(`node ~/.claude/pipeline/hooks/guard.mjs`, '*'));
  const r = w.check();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.handlers[0].trusted, true);
  assert.equal(r.handlers[0].scriptPath, inside);
  // a script outside, reached through a link that sits inside the pipeline folder, is judged by its real location
  const outside = w.script('.claude/hooks/evil.mjs');
  symlinkSync(outside, join(w.home, '.claude', 'pipeline', 'hooks', 'link.mjs'));
  w.settings(hookEntry(`node ~/.claude/pipeline/hooks/link.mjs`, '*'));
  const bad = w.check();
  assert.equal(bad.ok, false);
  assert.equal(bad.handlers[0].trusted, false);
});

test('settings.local.json and the project settings are sources too', () => {
  const w = world();
  const a = w.script('.claude/hooks/a.mjs');
  const b = w.script('project/hooks/b.mjs');
  const c = w.script('project/hooks/c.mjs');
  w.settings(hookEntry(`node ${a}`), join(w.home, '.claude'), 'settings.local.json');
  w.settings(hookEntry(`node ${b}`), join(w.cwd, '.claude'), 'settings.json');
  w.settings(hookEntry(`node ${c}`), join(w.cwd, '.claude'), 'settings.local.json');
  const h = w.handlers().handlers;
  assert.deepEqual(h.map((x) => x.scriptPath).sort(), [a, b, c].sort());
  assert.equal(w.check().ok, false);
  assert.equal(w.approve().ok, true);
  assert.equal(w.check().ok, true);
  // another project folder has none of the project handlers (a different cwd is a different set)
  assert.equal(checkDialogHooks({ home: w.home, cwd: null, managedPaths: [] }).handlers.length, 1);
});

test('the second account config dir (~/.claude-eaglewatch) is a source; a link to the shared settings is followed', () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  mkdirSync(join(w.home, '.claude-eaglewatch'), { recursive: true });
  w.settings(hookEntry(`node ${f}`));
  symlinkSync(join(w.home, '.claude', 'settings.json'), join(w.home, '.claude-eaglewatch', 'settings.json'));
  const h = w.handlers().handlers;
  assert.equal(h.length, 2, 'one per config dir');
  assert.deepEqual(new Set(h.map((x) => x.source)).size, 2);
});

test('managed settings are a source (injected path); an absent one is fine', () => {
  const w = world();
  const f = w.script('.claude/hooks/m.mjs');
  const managed = w.json(join(w.home, 'managed', 'managed-settings.json'), hookEntry(`node ${f}`, 'AskUserQuestion'));
  assert.equal(dialogHandlers({ home: w.home, cwd: w.cwd, managedPaths: [join(w.home, 'nope.json')] }).ok, true);
  const r = dialogHandlers({ home: w.home, cwd: w.cwd, managedPaths: [managed] });
  assert.equal(r.handlers.length, 1);
  assert.equal(r.handlers[0].source, managed);
});

test('plugin hooks.json is found through enabledPlugins and installed_plugins.json (and only for enabled plugins)', () => {
  const w = world();
  const root = join(w.home, '.claude', 'plugins', 'cache', 'mk', 'pl', '1.0.0');
  const script = w.script('.claude/plugins/cache/mk/pl/1.0.0/hooks/ask.mjs');
  w.json(join(root, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/ask.mjs' }] }] } });
  w.json(join(w.home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'pl@mk': [{ scope: 'user', installPath: root, version: '1.0.0' }] } });
  assert.deepEqual(w.handlers().handlers, [], 'installed but not enabled');
  w.settings({ enabledPlugins: { 'pl@mk': true, 'other@mk': false } });
  const h = w.handlers().handlers;
  assert.equal(h.length, 1);
  assert.equal(h[0].scriptPath, script);
  assert.equal(w.check().ok, false);
  assert.equal(w.approve().ok, true);
  assert.equal(w.check().ok, true);
  w.json(join(w.home, '.claude', 'plugins', 'installed_plugins.json'), '{ broken');
  const bad = w.check();
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /installed_plugins\.json is not valid JSON/);
  // an enabled plugin with no installed_plugins.json at all is fine (nothing is installed)
  const w2 = world();
  w2.settings({ enabledPlugins: { 'pl@mk': true } });
  assert.equal(w2.check().ok, true);
});

test('hooks: in skill / agent frontmatter (user and project) is a handler we cannot resolve: not ok; other events only are no handler', () => {
  const w = world();
  w.json(join(w.home, '.claude', 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: x\n---\nbody\n');
  w.json(join(w.home, '.claude', 'skills', 'other-event', 'SKILL.md'), '---\nname: o\nhooks:\n  PostToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "x"\n---\n');
  assert.equal(w.check().ok, true);
  w.json(join(w.home, '.claude', 'skills', 'sneaky', 'SKILL.md'), '---\nname: s\nhooks:\n  PreToolUse:\n    - matcher: "AskUserQuestion"\n      hooks:\n        - type: command\n          command: "node /x.mjs"\n---\n');
  const r = w.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unresolvable dialog hook \(frontmatter hooks\)/);
  assert.equal(w.approve().ok, false, 'approve refuses it');
  const w2 = world();
  w2.json(join(w2.cwd, '.claude', 'agents', 'a.md'), '---\nname: a\nhooks: { PermissionRequest: [] }\n---\n');
  assert.equal(w2.check().ok, false);
  const w3 = world();
  w3.json(join(w3.cwd, '.claude', 'skills', 'p', 'SKILL.md'), '---\nname: a\nhooks:\n  PermissionRequest:\n    - hooks: []\n---\n');
  assert.equal(w3.check().ok, false);
});

test('a settings file that exists but cannot be parsed makes the check not ok (and approve refuses)', () => {
  for (const [name, content] of [['not json', '{ nope'], ['a list', '[]'], ['bad hooks shape', '{"hooks":{"PreToolUse":{"x":1}}}'], ['empty', '']]) {
    const w = world();
    w.settings(content);
    const r = w.check();
    assert.equal(r.ok, false, name);
    assert.match(r.reason, /dialog hook source ~\/\.claude\/settings\.json /, name);
    assert.equal(w.approve().ok, false, name);
  }
  const w = world();
  w.json(join(w.cwd, '.claude', 'settings.local.json'), '{ nope');
  assert.equal(w.check().ok, false, 'a broken project file counts too');
});

test('a malformed approved list is not ok', () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  w.settings(hookEntry(`node ${f}`));
  assert.equal(w.approve().ok, true);
  writeFileSync(dialogHooksFile(w.home), '{ nope');
  const r = w.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^the approved dialog-hook list is unusable/);
});

test('the fingerprint changes when a handler is added, and not when nothing changed', () => {
  const w = world();
  const a = w.script('.claude/hooks/a.mjs');
  const b = w.script('.claude/hooks/b.mjs');
  const none = w.check().hookLayersSha256;
  assert.equal(w.check().hookLayersSha256, none);
  w.settings(hookEntry(`node ${a}`));
  const one = w.check().hookLayersSha256;
  assert.notEqual(one, none);
  assert.equal(w.check().hookLayersSha256, one);
  w.settings({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node ${a}` }, { type: 'command', command: `node ${b}` }] }] } });
  assert.notEqual(w.check().hookLayersSha256, one);
});

test('hookCheck (the default for recordClick) reads the hook input cwd', () => {
  const w = world();
  const f = w.script('project/hooks/p.mjs');
  w.settings(hookEntry(`node ${f}`), join(w.cwd, '.claude'));
  const without = hookCheck({ home: w.home, input: {} });
  assert.equal(without.ok, true);
  const withCwd = hookCheck({ home: w.home, input: { cwd: w.cwd } });
  assert.equal(withCwd.ok, false);
  assert.match(withCwd.reason, /^unlisted dialog hook/);
  assert.equal(withCwd.hookLayersSha256, without.hookLayersSha256, 'R1-F2: the project layer is judged (offender above) but is not in the fingerprint');
});

test('R1-F2: the project layer follows CLAUDE_PROJECT_DIR as well as cwd, and the fingerprint is the same whichever folder the issue and the click saw', () => {
  const w = world();
  const launch = join(w.home, 'launch');
  const f = w.script('project/hooks/p.mjs');
  w.json(join(launch, '.claude', 'settings.json'), hookEntry(`node ${f}`));
  assert.equal(w.check().ok, true, 'cwd alone does not see the launch folder');
  const seen = w.check({ projectDirs: [launch] });
  assert.equal(seen.ok, false);
  assert.match(seen.reason, /^unlisted dialog hook/);
  assert.equal(hookCheck({ home: w.home, input: { cwd: w.cwd }, env: { CLAUDE_PROJECT_DIR: launch } }).ok, false, 'the click hook reads its own CLAUDE_PROJECT_DIR');
  // approved once (from either side), every view of the project layers is ok and has one fingerprint
  assert.equal(w.approve({ projectDirs: [launch] }).ok, true);
  const a = w.check({ projectDirs: [launch] });
  const b = w.check({ cwd: launch });
  const c = w.check({ cwd: join(w.home, 'elsewhere'), projectDirs: [launch] });
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, true]);
  assert.equal(a.hookLayersSha256, b.hookLayersSha256);
  assert.equal(a.hookLayersSha256, c.hookLayersSha256);
  // an account-wide handler still changes it
  const g = w.script('.claude/hooks/g.mjs');
  w.settings(hookEntry(`node ${g}`));
  assert.notEqual(w.check({ projectDirs: [launch] }).hookLayersSha256, a.hookLayersSha256);
});

test('R1-F3: handler args are resolved with the command, listed with it, and part of the fingerprint; other args shapes are unresolvable', () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  const withArgs = (command, args) => ({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, ...(args === undefined ? {} : { args }) }] }] } });
  w.settings(withArgs('node', [f, '--quiet']));
  let r = w.handlers();
  assert.equal(r.handlers[0].scriptPath, f);
  assert.deepEqual(r.handlers[0].args, [f, '--quiet']);
  assert.equal(w.check().offenders[0].kind, 'unlisted', 'an interpreter plus one script is resolvable, and not listed yet');
  assert.equal(w.approve().ok, true);
  assert.equal(w.check().ok, true);
  const fp = w.check().hookLayersSha256;
  assert.deepEqual(JSON.parse(readFileSync(dialogHooksFile(w.home), 'utf8')).hooks[0].args, [f, '--quiet']);
  w.settings(withArgs('node', [f, '--other']));
  assert.equal(w.check().ok, false, 'editing only the args is a change: the list entry no longer matches');
  assert.notEqual(w.check().hookLayersSha256, fp);
  const awk = w.script('bin/tool');
  chmodSync(awk, 0o755);
  for (const [command, args] of [[awk, ['--anything']], ['node', ['--eval', 'x']], ['node', [f, 5]], ['node', 'x.mjs'], ['node /abs/x.mjs', ['a']], ['sh', []]]) {
    w.settings(withArgs(command, args));
    const h = w.handlers().handlers;
    if (Array.isArray(args) && args.length === 0) continue; // (empty args = none)
    assert.equal(h[0].scriptPath, null, JSON.stringify([command, args]));
    assert.equal(w.check().offenders[0].kind, 'unresolvable');
  }
});

test('R1-B2/B3: front matter in quoted / flow forms and in commands and plugin skills, agents, commands, manifest locations is inventoried', () => {
  const w = world();
  const hooked = (key) => `---\nname: s\n${key}\n  PostToolUse:\n    - matcher: x\n---\nbody\n`;
  const kinds = () => w.handlers().handlers.filter((h) => h.command === '(frontmatter hooks)').map((h) => h.source.replace(w.home, '~'));
  w.script('.claude/skills/q/SKILL.md', hooked('"hooks":').replace('PostToolUse:', 'PreToolUse:'));
  w.script('.claude/commands/c.md', '﻿--- \n{hooks: {PreToolUse: []}}\n---\n');
  w.script('.claude/commands/ns/d.md', '---\n<<: *x\n---\n');
  w.script('.claude/skills/ok/SKILL.md', hooked('hooks:')); // only a non-dialog event: no handler
  w.script('project/.claude/agents/a.md', hooked("'hooks':").replace('PostToolUse:', 'Stop:'));
  assert.deepEqual(kinds().sort(), ['~/.claude/commands/c.md', '~/.claude/commands/ns/d.md', '~/.claude/skills/q/SKILL.md']);
  // an enabled plugin: its skills, agents, commands and the locations its manifest names
  const install = join(w.home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0');
  w.json(join(w.home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: { 'p@m': [{ installPath: install }] } });
  w.settings({ enabledPlugins: { 'p@m': true } });
  w.json(join(install, '.claude-plugin', 'plugin.json'), { name: 'p', skills: './extra', commands: ['./more/x.md'] });
  w.script('.claude/plugins/cache/m/p/1.0/skills/s/SKILL.md', hooked('hooks:').replace('PostToolUse:', 'PreToolUse:'));
  w.script('.claude/plugins/cache/m/p/1.0/agents/g.md', hooked('"hooks":').replace('PostToolUse:', 'PermissionRequest:'));
  w.script('.claude/plugins/cache/m/p/1.0/commands/k.md', hooked('hooks:').replace('PostToolUse:', 'PreToolUse:'));
  w.script('.claude/plugins/cache/m/p/1.0/extra/e/SKILL.md', hooked('hooks:').replace('PostToolUse:', 'PreToolUse:'));
  w.script('.claude/plugins/cache/m/p/1.0/more/x.md', hooked('hooks:').replace('PostToolUse:', 'PreToolUse:'));
  const plug = kinds().filter((k) => k.includes('/plugins/'));
  assert.equal(plug.length, 5, plug.join(', '));
  assert.equal(w.check().ok, false);
  w.json(join(install, '.claude-plugin', 'plugin.json'), { name: 'p', commands: { x: { source: './x.md' } } });
  assert.ok(w.check().offenders.some((o) => o.kind === 'unreadable' && /commands/.test(o.why)), 'a manifest form that is not followed fails closed');
});

test('R2-F8: in the args form ~ and $HOME in args[0] are not expanded: unresolvable (only a literal absolute path is a script)', () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  const withArgs = (args) => ({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node', args }] }] } });
  for (const a of ['~/.claude/hooks/a.mjs', '$HOME/.claude/hooks/a.mjs', '${HOME}/.claude/hooks/a.mjs']) {
    w.settings(withArgs([a]));
    assert.equal(w.handlers().handlers[0].scriptPath, null, a);
    assert.equal(w.check().offenders[0].kind, 'unresolvable', a);
  }
  w.settings(withArgs([f]));
  assert.equal(w.handlers().handlers[0].scriptPath, f, 'a literal absolute path still resolves');
  w.settings(hookEntry('node ~/.claude/hooks/a.mjs'));
  assert.equal(w.handlers().handlers[0].scriptPath, f, 'the shell-string command form keeps its home expansion');
});

test('R2-F5: a command / agent walk that hits the depth or file cap is an error (not ok), not a silent cut', () => {
  const w = world();
  w.script('.claude/commands/a/b/c/d/x.md', '---\nname: x\n---\n');
  assert.equal(w.check().ok, true, 'four folders deep is read');
  w.script('.claude/commands/a/b/c/d/e/x.md', '---\nname: x\nhooks:\n  PreToolUse:\n    - matcher: AskUserQuestion\n---\n');
  let r = w.check();
  assert.equal(r.ok, false);
  assert.ok(r.offenders.some((o) => o.kind === 'unreadable' && /too deep/.test(o.why)), r.reason);
  const w2 = world();
  for (let i = 0; i < 2001; i++) w2.script(`.claude/agents/f${String(i).padStart(4, '0')}.md`, 'x');
  r = w2.check();
  assert.equal(r.ok, false);
  assert.ok(r.offenders.some((o) => o.kind === 'unreadable' && /too many files/.test(o.why)), r.reason);
});

test('R2-B1 / R2-F4: the inventory reads an indented root mapping, a bare-CR hooks key and a hooks block after a `...` line as hooks', () => {
  const w = world();
  w.script('.claude/skills/ind/SKILL.md', '---\n  name: custom\n  hooks:\n    PreToolUse:\n      - matcher: AskUserQuestion\n---\n');
  w.script('.claude/skills/cr/SKILL.md', '---\nname: x\rhooks:\r  PreToolUse:\r    - matcher: AskUserQuestion\n---\n');
  w.script('.claude/skills/dots/SKILL.md', '---\nname: x\n...\nhooks:\n  PreToolUse:\n    - matcher: AskUserQuestion\n---\n');
  const src = w.handlers().handlers.filter((h) => h.command === '(frontmatter hooks)').map((h) => h.source.replace(w.home, '~')).sort();
  assert.deepEqual(src, ['~/.claude/skills/cr/SKILL.md', '~/.claude/skills/dots/SKILL.md', '~/.claude/skills/ind/SKILL.md']);
});

// ---- the command ------------------------------------------------------------------------------------------------------------------

const go = (argv, w, { env = {}, ancestor = false } = {}) =>
  run(argv, { env, home: w.home, cwd: w.cwd, managedPaths: [], hasClaudeCodeAncestor: () => ancestor });

test('owner-go dialog-hooks: read-only status, allowed anywhere', async () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  w.settings(hookEntry(`node ${f}`));
  const r = await go(['dialog-hooks'], w, { env: { CLAUDECODE: '1' }, ancestor: true });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.handlers.length, 1);
  assert.equal(r.output.offenders.length, 1);
  assert.equal(r.output.approvedAt, null);
  assert.throws(() => readFileSync(dialogHooksFile(w.home)), /ENOENT/, 'nothing written');
  assert.equal((await go(['approve-dialog-hooks'], w, { env: ADMIN })).exitCode, 0);
  const after = await go(['dialog-hooks'], w);
  assert.equal(after.exitCode, 0);
  assert.equal(after.output.ok, true);
  assert.equal(typeof after.output.approvedAt, 'string');
});

test('owner-go approve-dialog-hooks: refused inside Claude Code without the admin bypass, writes with it or outside', async () => {
  const w = world();
  const f = w.script('.claude/hooks/a.mjs');
  w.settings(hookEntry(`node ${f}`));
  for (const [env, ancestor] of [[{ CLAUDECODE: '1' }, false], [{}, true]]) {
    const r = await go(['approve-dialog-hooks'], w, { env, ancestor });
    assert.equal(r.exitCode, 2);
    assert.equal(r.output.error, 'refused');
    assert.throws(() => readFileSync(dialogHooksFile(w.home)), /ENOENT/, 'nothing written');
  }
  const ok = await go(['approve-dialog-hooks'], w, { env: { CLAUDECODE: '1', ...ADMIN }, ancestor: true });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.output.hooks.length, 1);
  assert.equal(ok.output.hooks[0].scriptPath, f);
  assert.equal(JSON.parse(readFileSync(dialogHooksFile(w.home), 'utf8')).hooks[0].sha256, ok.output.hooks[0].sha256);
  // an owner's own terminal (no Claude Code around) needs no switch
  const again = await go(['approve-dialog-hooks'], w);
  assert.equal(again.exitCode, 0);
});

test('owner-go approve-dialog-hooks: an unresolvable hook is refused with the offender named; no subcommand or an unknown one is a usage error', async () => {
  const w = world();
  w.settings(hookEntry(`sh -c 'true'`));
  const r = await go(['approve-dialog-hooks'], w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'not-approved');
  assert.match(r.output.message, /sh -c 'true'/);
  await assert.rejects(go([], w), /subcommand/);
  await assert.rejects(go(['nope'], w), /subcommand/);
  await assert.rejects(go(['dialog-hooks', 'extra'], w), /unexpected argument/);
});

test('approveDialogHooks refuses inside Claude Code in the function itself (#273): CLAUDECODE=1 or an ancestor, nothing written; the owner switch lifts it', () => {
  const w = world();
  w.settings(hookEntry(`node ${w.script('x/hook.mjs')}`));
  const outside = { hasClaudeCodeAncestor: () => false };
  const a = w.approve({ env: { CLAUDECODE: '1' }, ctx: outside });
  assert.equal(a.ok, false);
  assert.equal(a.refused, true);
  assert.match(a.reason, /^refused: .*CLAUDECODE=1.*own terminal/);
  assert.deepEqual(a.offenders, []);
  const b = w.approve({ env: {}, ctx: { hasClaudeCodeAncestor: () => true } });
  assert.equal(b.refused, true);
  assert.match(b.reason, /ancestor/);
  assert.equal(existsSync(dialogHooksFile(w.home)), false, 'nothing written when refused');
  const ownerSwitch = { CLAUDECODE: '1', ['PIPELINE_' + 'ADMIN']: '1' }; // (built, not spelled: the guard refuses a write that spells the assignment)
  const c = w.approve({ env: ownerSwitch, ctx: { hasClaudeCodeAncestor: () => true } });
  assert.notEqual(c.refused, true);
  assert.equal(c.ok, true, c.reason);
  assert.equal(existsSync(dialogHooksFile(w.home)), true);
});

// ---- Windows path forms, proven on any machine through the `platform` option (the Windows CI job runs the temp-folder tests above for real) ----

const WIN_HOME = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\dialog-hooks-x';
const WIN_SCRIPT = `${WIN_HOME}\\.claude\\hooks\\notify.mjs`;
const win = (cmd, over = {}) => commandTarget(cmd, { home: WIN_HOME, platform: 'win32', ...over });

test('windows: a backslash path, a forward-slash path, a quoted path and a ~ / $HOME path all resolve to the same normalised script', () => {
  for (const cmd of [
    `node ${WIN_SCRIPT}`,
    `node "${WIN_SCRIPT}" --flag=1`,
    `node ${WIN_SCRIPT.replaceAll('\\', '/')}`,
    `${WIN_SCRIPT}`,
    'node ~/.claude/hooks/notify.mjs',
    'node $HOME/.claude/hooks/notify.mjs',
    'node "${HOME}/.claude/hooks/notify.mjs"',
    `node 'C:/Users/RUNNER~1/AppData/Local/Temp/dialog-hooks-x/.claude/hooks/notify.mjs'`,
  ]) assert.equal(win(cmd), WIN_SCRIPT, cmd);
  assert.equal(win('node ${CLAUDE_PLUGIN_ROOT}\\hooks\\a.mjs', { pluginRoot: 'D:\\plugins\\p' }), 'D:\\plugins\\p\\hooks\\a.mjs');
});

test('windows: a network (UNC or //server) script path is refused: fingerprinting a share can leak credentials and its bytes can change', () => {
  for (const cmd of ['node \\\\server\\share\\hooks\\a.mjs', 'node //server/share/hooks/a.mjs', '\\\\server\\share\\a.mjs', 'node "\\\\?\\C:\\x\\a.mjs"'])
    assert.equal(win(cmd), null, cmd);
});

test('windows: everything ambiguous stays unresolvable (rooted or drive-relative paths, relative paths, shell syntax, interpreters, escapes in a double quote)', () => {
  for (const cmd of [
    'node \\hooks\\a.mjs', 'node C:hooks\\a.mjs', 'node .\\hooks\\a.mjs', 'node hooks\\a.mjs', 'node ..\\a.mjs',
    `node ${WIN_SCRIPT} | more`, `node ${WIN_SCRIPT} & echo`, `node ${WIN_SCRIPT}; echo`, `node $(echo ${WIN_SCRIPT})`, 'node -e "1"', 'node', 'npx tool',
    'C:\\Windows\\System32\\cmd.exe', '"C:\\Program Files\\nodejs\\node.exe" x.mjs', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    `node "${WIN_HOME}\\$X\\a.mjs"`, `node "${WIN_HOME}\\\`x\\a.mjs"`, 'node "C:\\unterminated',
  ]) assert.equal(win(cmd), null, cmd);
});

test('windows: a backslash is still an escape (refused) away from Windows, and a drive-letter path is not absolute there', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.equal(commandTarget(`node ${WIN_SCRIPT}`, { home: '/h', platform }), null, platform);
    assert.equal(commandTarget('node C:/x/a.mjs', { home: '/h', platform }), null, platform);
    assert.equal(commandTarget('node /x/a.mjs', { home: '/h', platform }), '/x/a.mjs');
  }
});

test('windows: the display shortens the home to ~/ with forward slashes (case and separator alike); a path outside the home is shown as is', () => {
  assert.equal(tilde(WIN_SCRIPT, WIN_HOME, 'win32'), '~/.claude/hooks/notify.mjs');
  assert.equal(tilde(WIN_SCRIPT.toLowerCase(), WIN_HOME, 'win32'), '~/.claude/hooks/notify.mjs');
  assert.equal(tilde(WIN_SCRIPT.replaceAll('\\', '/'), `${WIN_HOME}\\`, 'win32'), '~/.claude/hooks/notify.mjs');
  assert.equal(tilde(WIN_HOME, WIN_HOME, 'win32'), '~');
  assert.equal(tilde(`${WIN_HOME}-other\\a.mjs`, WIN_HOME, 'win32'), `${WIN_HOME}-other\\a.mjs`, 'a sibling folder with the same prefix is not inside the home');
  assert.equal(tilde('D:\\elsewhere\\a.mjs', WIN_HOME, 'win32'), 'D:\\elsewhere\\a.mjs');
  assert.equal(tilde('/home/me/.claude/a.mjs', '/home/me', 'linux'), '~/.claude/a.mjs');
  assert.equal(tilde('/home/me2/a.mjs', '/home/me', 'linux'), '/home/me2/a.mjs');
});
