// Why: the installer edits the owner's real ~/.claude/settings.json and the files the safety hooks run from, so
// these tests pin the properties that matter: nothing else in settings changes, a second run changes nothing,
// foreign files are never clobbered, the agent gate holds, and --check reports real drift. Everything runs against
// temp claude-homes (one with a space in its path) and the miniature repo in test/fixtures/src-tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync,
  realpathSync, symlinkSync, lstatSync, chmodSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryAcquire, release, inspect } from '../pipeline/lib/locks.mjs';
import {
  mergeSettings, removeOurSettings, isOurHandler, ourAllowEntries, renameWithRetry, collectDiagnostics,
  installLockName, shellRcPaths, parseArgs, buildPlan, walkFiles, safeManifestKey, GUARD_FILES_MATCHER, GUARD_GIT_MATCHER, HOOK_LOADER, joinNative,
  STACK_REGISTER_MATCHERS, STACK_REGISTER_TIMEOUT_S, STACK_HOOK_TIMEOUT_S, ourStackGroups, inspectHooks,
  RETIRED_HOOKS, RETIRED_SKILLS, SKILLS, retiredSkillUnits,
} from '../pipeline/lib/installer.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(REPO, 'install.mjs');
const FIXTURE = join(REPO, 'test', 'fixtures', 'src-tree');
const posix = (p) => String(p).replace(/\\/g, '/');

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scratch(label = 'cp-install') {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
}
// A claude-home path that does not exist yet; `space` puts a space in it (R10).
function newHome({ space = false } = {}) {
  return join(scratch(space ? 'cp install' : 'cp-install'), space ? 'claude home' : 'claude');
}
function copyFixture() {
  const dir = join(scratch('cp-src'), 'src');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

// The installer also walks its ancestor processes with `ps`. The tests may themselves run inside Claude Code, so every
// child gets a fake `ps` first on PATH that answers from FAKE_PS_TABLE (pid -> {ppid, comm, args}); a pid it does not
// know is a plain shell whose parent is init, i.e. no Claude Code ancestor. (Windows asks PowerShell instead: not faked.)
const FAKE_PS_DIR = (() => {
  if (process.platform === 'win32') return null;
  const dir = scratch('cp-fakeps');
  const file = join(dir, 'ps');
  writeFileSync(file, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (process.env.FAKE_PS_FAIL) process.exit(1);",
    "const table = JSON.parse(process.env.FAKE_PS_TABLE || '{}');",
    "const pid = args[args.length - 1];",
    "const row = table[pid] ?? { ppid: 1, comm: 'zsh', args: 'zsh' };",
    "console.log(args.includes('args=') ? row.args ?? row.comm : `${row.ppid} ${row.comm}`);",
  ].join('\n'));
  chmodSync(file, 0o755);
  return dir;
})();

// The child must not inherit CLAUDECODE (the tests may themselves run inside Claude Code), nor the real HOME.
function run(args, { env = {}, script = INSTALL, command = process.execPath, lead = [], psTable, cwd } = {}) {
  const userHome = scratch('cp-userhome');
  const childEnv = { ...process.env, HOME: userHome, USERPROFILE: userHome, PIPELINE_INSTALL_NO_PROBES: '1' };
  for (const k of ['CLAUDECODE', 'PIPELINE_ADMIN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'FAKE_PS_TABLE', 'FAKE_PS_FAIL']) delete childEnv[k];
  if (FAKE_PS_DIR) {
    childEnv.PATH = `${FAKE_PS_DIR}${delimiter}${childEnv.PATH ?? process.env.PATH}`;
    if (psTable) childEnv.FAKE_PS_TABLE = JSON.stringify(psTable);
  }
  Object.assign(childEnv, env);
  const r = spawnSync(command, [...lead, script, ...args], { encoding: 'utf8', env: childEnv, timeout: 60000, ...(cwd ? { cwd } : {}) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, userHome };
}
function install(home, extra = [], { source = FIXTURE, env, psTable } = {}) {
  return run(['--claude-home', home, '--source', source, ...extra], { env, psTable });
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const settingsPath = (home) => join(home, 'settings.json');
const readSettings = (home) => readJson(settingsPath(home));
const readManifest = (home) => readJson(join(home, 'pipeline', 'INSTALLED.json'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function writeSettings(home, obj) {
  mkdirSync(home, { recursive: true });
  writeFileSync(settingsPath(home), `${JSON.stringify(obj, null, 2)}\n`);
}

// The guards start through the fail-closed loader (A2): `node --input-type=module -e <loader> <hook file>`.
const loaded = (home, name) => ({
  type: 'command', command: 'node', args: ['--input-type=module', '-e', HOOK_LOADER, join(home, 'pipeline', 'hooks', `${name}.mjs`)], timeout: 15,
});
const guardGit = (home) => ({ matcher: 'Bash|PowerShell|Monitor|mcp__.*', hooks: [loaded(home, 'guard-git')] });
const guardFiles = (home) => ({
  matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*',
  hooks: [loaded(home, 'guard-files')],
});
// The SessionStart status hook the previous release wrote (retired since): plain, in its own group without a matcher.
const sessionVersion = (home) => ({
  hooks: [{ type: 'command', command: 'node', args: [joinNative(home, 'pipeline', 'hooks', 'session-version.mjs')], timeout: 10 }],
});
// #58: the owner-go recorder, on UserPromptSubmit, started without the fail-closed loader (it must never block a prompt)
const ownerGo = (home) => ({
  hooks: [{ type: 'command', command: 'node', args: [joinNative(home, 'pipeline', 'hooks', 'owner-go.mjs')], timeout: 10 }],
});
// The stack-stop hooks: stack-register through the fail-closed loader (30 s) once per matcher, dev-bind and session-end plain (10 s).
// The installer keeps the style of the claude-home it is given (joinNative), so a POSIX-style '/h/.claude' stays POSIX on Windows too.
const stackRegisterHandler = (home) => ({ ...loaded(home, 'stack-register'), args: ['--input-type=module', '-e', HOOK_LOADER, joinNative(home, 'pipeline', 'hooks', 'stack-register.mjs')], timeout: 30 });
const stackRegisters = (home) => [
  { matcher: 'Bash', hooks: [stackRegisterHandler(home)] },
  { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [stackRegisterHandler(home)] },
];
const stackDevBind = (home) => ({
  matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: [joinNative(home, 'pipeline', 'hooks', 'stack-dev-bind.mjs')], timeout: 10 }],
});
const stackSessionEnd = (home) => ({
  hooks: [{ type: 'command', command: 'node', args: [joinNative(home, 'pipeline', 'hooks', 'stack-session-end.mjs')], timeout: 10 }],
});
const allowEntries = (home) => [
  `Bash(node ${posix(home)}/pipeline/bin/pipeline.mjs:*)`,
  ...(/\s/.test(home) ? [`Bash(node "${posix(home)}/pipeline/bin/pipeline.mjs":*)`] : []),
  'Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)',
];

// A settings file shaped like the owner's: other hooks on several events, env, permissions, plugins.
function ownersSettings() {
  return {
    model: 'opus',
    env: { FOO: 'bar', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
    permissions: { allow: ['Bash(ls:*)', 'Read(~/notes/**)'], deny: ['Bash(rm -rf /:*)'], defaultMode: 'acceptEdits' },
    enabledPlugins: { 'superpowers@marketplace': true },
    hooks: {
      PreToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node /opt/memory-guard.js' }] },
      ],
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node /opt/memory-index.js', timeout: 5 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/tab-event.sh', timeout: 5 }] },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/heartbeat.mjs', timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
    },
    statusLine: { type: 'command', command: 'echo status' },
  };
}

function listTree(dir) {
  const out = [];
  const visit = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(join(d, e.name), r); else out.push(r);
    }
  };
  visit(dir, '');
  return out.sort();
}

// 1
test('fresh install into an empty home (path with a space): files, manifest, hooks, allow entries', () => {
  const home = newHome({ space: true });
  const r = install(home);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  for (const rel of [
    'skills/ship/SKILL.md', 'skills/ship/reference/notes.md', 'skills/verify/SKILL.md', 'skills/pipeline-setup/SKILL.md',
    'agents/implementer.md', 'agents/verifier.md', 'agents/judge.md', 'agents/arbiter.md', 'agents/Explore.md',
    'pipeline/bin/pipeline.mjs', 'pipeline/hooks/guard-git.mjs', 'pipeline/hooks/guard-files.mjs',
    'pipeline/hooks/stack-register.mjs', 'pipeline/hooks/stack-dev-bind.mjs', 'pipeline/hooks/stack-session-end.mjs',
    'pipeline/lib/answer.mjs', 'pipeline/templates/example.md', 'pipeline/VERSION', 'pipeline/INSTALLED.json',
  ]) assert.ok(existsSync(join(home, ...rel.split('/'))), `${rel} should be installed`);
  assert.equal(readFileSync(join(home, 'pipeline', 'VERSION'), 'utf8'), readFileSync(join(FIXTURE, 'VERSION'), 'utf8'));

  const m = readManifest(home);
  assert.equal(m.version, '9.9.9');
  assert.ok(m.sourceSha === null || /^[0-9a-f]{40}$/.test(m.sourceSha), `sourceSha: ${m.sourceSha}`);
  assert.match(m.installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  assert.deepEqual(m.hooks, { guardGit: true, guardFiles: true });
  const expectedFiles = {};
  for (const rel of listTree(FIXTURE)) {
    if (rel === 'VERSION') expectedFiles['pipeline/VERSION'] = sha(join(FIXTURE, 'VERSION'));
    else expectedFiles[rel] = sha(join(FIXTURE, ...rel.split('/')));
  }
  assert.deepEqual(m.files, expectedFiles);
  for (const [rel, h] of Object.entries(m.files)) assert.equal(sha(join(home, ...rel.split('/'))), h, rel);

  const s = readSettings(home);
  assert.deepEqual(s.hooks.PreToolUse, [...stackRegisters(home), guardGit(home), guardFiles(home)]);
  assert.deepEqual(s.hooks.PostToolUse, [stackDevBind(home)]);
  assert.equal('SessionStart' in s.hooks, false, 'nothing is written to SessionStart');
  assert.equal(existsSync(join(home, 'pipeline', 'hooks', 'session-version.mjs')), false);
  assert.deepEqual(s.hooks.SessionEnd, [stackSessionEnd(home)]);
  assert.deepEqual(s.permissions.allow, allowEntries(home));
  assert.deepEqual(Object.keys(s).sort(), ['hooks', 'permissions']);
  assert.equal(existsSync(join(home, 'backups')), false, 'no settings existed, so nothing to back up');
  assert.ok(listTree(home).every((f) => !/\.(new|old)-/.test(f)), 'no staging leftovers');
  assert.ok(readdirSync(join(home, 'skills')).every((n) => !/\.(new|old)-/.test(n)));
});

test('excluded names (node_modules, .DS_Store, test) are never copied or listed', () => {
  const home = newHome();
  const src = copyFixture();
  mkdirSync(join(src, 'pipeline', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(src, 'pipeline', 'node_modules', 'x', 'index.js'), 'x');
  mkdirSync(join(src, 'pipeline', 'test'), { recursive: true });
  writeFileSync(join(src, 'pipeline', 'test', 't.mjs'), 'x');
  writeFileSync(join(src, 'pipeline', '.DS_Store'), 'x');
  writeFileSync(join(src, 'skills', 'ship', '.DS_Store'), 'x');
  const r = install(home, [], { source: src });
  assert.equal(r.status, 0, r.stderr);
  const files = listTree(home);
  assert.ok(!files.some((f) => /node_modules|\.DS_Store|\/test\//.test(f)), files.join('\n'));
  assert.ok(!Object.keys(readManifest(home).files).some((f) => /node_modules|\.DS_Store|\/test\//.test(f)));
});

// 2
test('existing settings: every other key survives unchanged, ours is appended once', () => {
  const home = newHome();
  const before = ownersSettings();
  writeSettings(home, before);
  const r = install(home);
  assert.equal(r.status, 0, r.stderr);
  const after = readSettings(home);

  const expected = structuredClone(before);
  expected.hooks.PreToolUse.push(...stackRegisters(home), guardGit(home), guardFiles(home));
  expected.hooks.PostToolUse.push(stackDevBind(home)); // (after the owner's tab-event.sh and memory-index.js)
  expected.hooks.SessionEnd.push(stackSessionEnd(home)); // (after the owner's heartbeat.mjs)
  expected.hooks.UserPromptSubmit.push(ownerGo(home)); // (after the owner's own)
  expected.permissions.allow.push(...allowEntries(home));
  assert.deepEqual(after, expected);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'top-level key order is preserved');
  assert.deepEqual(Object.keys(after.hooks), Object.keys(before.hooks));
  assert.ok(readFileSync(settingsPath(home), 'utf8').endsWith('}\n'), 'trailing newline');
  assert.match(readFileSync(settingsPath(home), 'utf8'), /^\{\n {2}"model"/, '2-space indent');
});

// 3
test('a second install changes nothing: settings, manifest files and hooks are identical', () => {
  const home = newHome();
  writeSettings(home, ownersSettings());
  assert.equal(install(home).status, 0);
  const s1 = readFileSync(settingsPath(home), 'utf8');
  const m1 = readManifest(home);
  const r2 = install(home, ['--json']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(settingsPath(home), 'utf8'), s1);
  assert.deepEqual(readSettings(home), JSON.parse(s1));
  assert.deepEqual(readManifest(home).files, m1.files);
  const s = readSettings(home);
  assert.equal(s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => isOurHandler(h, home))).length, 4, 'two stack-register groups and the two guards');
  assert.equal(s.hooks.PostToolUse.filter((g) => g.hooks.some((h) => isOurHandler(h, home))).length, 1);
  assert.equal(s.hooks.SessionEnd.filter((g) => g.hooks.some((h) => isOurHandler(h, home))).length, 1);
  for (const e of allowEntries(home)) assert.equal(s.permissions.allow.filter((x) => x === e).length, 1);
  const report = JSON.parse(r2.stdout);
  assert.equal(report.files.copied, 0, 'identical units are not rewritten');
  assert.equal(report.settings.changed, false);
  assert.equal(readdirSync(join(home, 'backups')).length, 1, 'only the first run, which changed settings, backed up');
});

test('reinstall repairs an installed file that was edited', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  writeFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'tampered\n');
  writeFileSync(join(home, 'skills', 'ship', 'stray.md'), 'stray\n');
  assert.equal(install(home).status, 0);
  assert.equal(readFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'utf8'), readFileSync(join(FIXTURE, 'skills', 'ship', 'SKILL.md'), 'utf8'));
  assert.equal(existsSync(join(home, 'skills', 'ship', 'stray.md')), false);
});

// 4
test('--skip-file-guard installs only guard-git; a later full install adds guard-files last', () => {
  const home = newHome();
  const before = ownersSettings();
  writeSettings(home, before);
  assert.equal(install(home, ['--skip-file-guard']).status, 0);
  let s = readSettings(home);
  assert.deepEqual(s.hooks.PreToolUse.slice(1), [...stackRegisters(home), guardGit(home)]);
  assert.deepEqual(readManifest(home).hooks, { guardGit: true, guardFiles: false });

  assert.equal(install(home).status, 0);
  s = readSettings(home);
  assert.deepEqual(s.hooks.PreToolUse, [...before.hooks.PreToolUse, ...stackRegisters(home), guardGit(home), guardFiles(home)]);
  assert.deepEqual(readManifest(home).hooks, { guardGit: true, guardFiles: true });
  assert.equal(readdirSync(join(home, 'backups')).length, 2, 'two settings changes, two distinct backups (none overwritten)');
});

// 5
test('an older install in the string command form is replaced, not duplicated', () => {
  const home = newHome();
  const before = ownersSettings();
  before.hooks.PreToolUse.push(
    { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${join(home, 'pipeline', 'hooks', 'guard-git.mjs')}`, timeout: 10 }] },
    // A user handler sharing a group with an old handler of ours (Windows-style path) must survive.
    { matcher: 'Bash', hooks: [
      { type: 'command', command: 'echo mine' },
      { type: 'command', command: 'node', args: ['C:\\Users\\u\\.claude\\pipeline\\hooks\\guard-files.mjs'] },
    ] },
  );
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  const after = readSettings(home);
  const expected = structuredClone(ownersSettings());
  expected.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }, ...stackRegisters(home), guardGit(home), guardFiles(home));
  expected.hooks.PostToolUse.push(stackDevBind(home));
  expected.hooks.SessionEnd.push(stackSessionEnd(home));
  expected.hooks.UserPromptSubmit.push(ownerGo(home)); // (after the owner's own)
  expected.permissions.allow.push(...allowEntries(home));
  assert.deepEqual(after, expected);
});

// 6
test('a foreign skill dir not in the manifest is refused (exit 1, nothing written); --force replaces it', () => {
  const home = newHome();
  mkdirSync(join(home, 'skills', 'verify'), { recursive: true });
  writeFileSync(join(home, 'skills', 'verify', 'SKILL.md'), 'my own verify skill\n');
  writeSettings(home, ownersSettings());
  const settingsBefore = readFileSync(settingsPath(home), 'utf8');

  const r = install(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skills\/verify/);
  assert.equal(readFileSync(join(home, 'skills', 'verify', 'SKILL.md'), 'utf8'), 'my own verify skill\n');
  assert.equal(existsSync(join(home, 'pipeline')), false, 'nothing was installed');
  assert.equal(existsSync(join(home, 'skills', 'ship')), false);
  assert.equal(readFileSync(settingsPath(home), 'utf8'), settingsBefore);

  const f = install(home, ['--force']);
  assert.equal(f.status, 0, f.stderr);
  assert.equal(readFileSync(join(home, 'skills', 'verify', 'SKILL.md'), 'utf8'), readFileSync(join(FIXTURE, 'skills', 'verify', 'SKILL.md'), 'utf8'));
  const saved = readdirSync(join(home, 'backups')).filter((n) => n.startsWith('verify.'));
  assert.equal(saved.length, 1, 'the replaced foreign skill is kept in backups');
  assert.equal(readFileSync(join(home, 'backups', saved[0], 'SKILL.md'), 'utf8'), 'my own verify skill\n');
});

test('a foreign agent file is refused; a foreign pipeline dir is refused', () => {
  const home = newHome();
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'judge.md'), 'mine\n');
  let r = install(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agents\/judge\.md/);
  rmSync(join(home, 'agents'), { recursive: true });

  mkdirSync(join(home, 'pipeline'), { recursive: true });
  writeFileSync(join(home, 'pipeline', 'something.txt'), 'mine\n');
  r = install(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pipeline/);
  assert.equal(readFileSync(join(home, 'pipeline', 'something.txt'), 'utf8'), 'mine\n');
});

// 7
test('inside Claude Code (CLAUDECODE=1) the installer refuses unless PIPELINE_ADMIN=1; --check always works', () => {
  const home = newHome();
  const blocked = install(home, [], { env: { CLAUDECODE: '1' } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /own terminal/);
  assert.match(blocked.stderr, /PIPELINE_ADMIN=1/);
  assert.equal(existsSync(home), false, 'nothing written');

  assert.equal(install(home, ['--uninstall'], { env: { CLAUDECODE: '1' } }).status, 2);
  assert.equal(install(home, [], { env: { CLAUDECODE: '1', PIPELINE_ADMIN: '0' } }).status, 2);

  const ok = install(home, [], { env: { CLAUDECODE: '1', PIPELINE_ADMIN: '1' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(home, 'pipeline', 'INSTALLED.json')));

  const check = install(home, ['--check'], { env: { CLAUDECODE: '1' } });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('inside Claude Code means CLAUDECODE or a Claude Code ancestor process: stripping the variable does not help', { skip: process.platform === 'win32' }, () => {
  const home = newHome();
  // the child's parent is this test process; put Claude Code three hops above it
  const withClaude = { [process.pid]: { ppid: 7001, comm: 'node' }, 7001: { ppid: 7002, comm: '/bin/zsh' }, 7002: { ppid: 7003, comm: '/Users/u/.local/bin/claude' }, 7003: { ppid: 1, comm: 'login' } };
  const blocked = install(home, [], { psTable: withClaude });
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /ancestor/);
  assert.match(blocked.stderr, /PIPELINE_ADMIN=1/);
  assert.equal(existsSync(home), false, 'nothing written');
  assert.equal(install(home, ['--uninstall'], { psTable: withClaude }).status, 2);

  // Claude Code as a node script
  const viaNode = { [process.pid]: { ppid: 7001, comm: '/usr/bin/node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' }, 7001: { ppid: 1, comm: 'sh' } };
  assert.equal(install(home, [], { psTable: { [process.pid]: { ppid: 7001, comm: 'zsh' }, 7001: viaNode[process.pid] } }).status, 2);

  // the owner's switch and --check still work
  assert.equal(install(home, ['--check'], { psTable: withClaude }).status, 1, '--check is allowed (nothing installed is drift)');
  const ok = install(home, [], { psTable: withClaude, env: { PIPELINE_ADMIN: '1' } });
  assert.equal(ok.status, 0, ok.stderr);
});

test('the ancestor check falls back to the environment check when the process lookup fails, and ignores a plain terminal', { skip: process.platform === 'win32' }, () => {
  const lookupFails = install(newHome(), [], { env: { FAKE_PS_FAIL: '1' } });
  assert.equal(lookupFails.status, 0, lookupFails.stderr);
  const stillEnvBlocked = install(newHome(), [], { env: { FAKE_PS_FAIL: '1', CLAUDECODE: '1' } });
  assert.equal(stillEnvBlocked.status, 2);
  const terminal = { [process.pid]: { ppid: 7001, comm: 'zsh' }, 7001: { ppid: 7002, comm: 'Terminal' }, 7002: { ppid: 1, comm: 'launchd' } };
  assert.equal(install(newHome(), [], { psTable: terminal }).status, 0);
});

// 8
test('--check: clean after install, names an edited file, notices a deleted hook, never writes', () => {
  const home = newHome();
  const pre = install(home, ['--check']);
  assert.equal(pre.status, 1, 'nothing installed is drift');
  assert.equal(existsSync(home), false, '--check must not create the home');

  assert.equal(install(home).status, 0);
  const before = listTree(home);
  const clean = install(home, ['--check']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.deepEqual(listTree(home), before);

  writeFileSync(join(home, 'pipeline', 'hooks', 'guard-git.mjs'), '// edited\n');
  const edited = install(home, ['--check']);
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /pipeline\/hooks\/guard-git\.mjs/);
  assert.equal(readFileSync(join(home, 'pipeline', 'hooks', 'guard-git.mjs'), 'utf8'), '// edited\n', 'check does not repair');
  assert.equal(install(home).status, 0);
  assert.equal(install(home, ['--check']).status, 0);

  const s = readSettings(home);
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !g.hooks.some((h) => (h.args ?? []).some((a) => a.endsWith('guard-git.mjs'))));
  writeSettings(home, s);
  const noHook = install(home, ['--check']);
  assert.equal(noHook.status, 1);
  assert.match(noHook.stdout, /guard-git/);

  // #58: a missing owner-go recorder is drift too (without it no owner "merge" is ever recorded, so P merge refuses every owner item)
  assert.equal(install(home).status, 0);
  const s2 = readSettings(home);
  s2.hooks.UserPromptSubmit = s2.hooks.UserPromptSubmit.filter((g) => !g.hooks.some((h) => (h.args ?? []).some((a) => a.endsWith('owner-go.mjs'))));
  writeSettings(home, s2);
  const noRecorder = install(home, ['--check']);
  assert.equal(noRecorder.status, 1);
  assert.match(noRecorder.stdout, /hook missing: owner-go is not in hooks\.UserPromptSubmit/);
});

test('--check also reports a missing file, a duplicated hook, a missing allow entry and a removed-from-source file', () => {
  const home = newHome();
  const src = copyFixture();
  assert.equal(install(home, [], { source: src }).status, 0);

  rmSync(join(home, 'agents', 'judge.md'));
  let c = install(home, ['--check'], { source: src });
  assert.equal(c.status, 1);
  assert.match(c.stdout, /agents\/judge\.md/);
  assert.equal(install(home, [], { source: src }).status, 0);

  const s = readSettings(home);
  s.hooks.PreToolUse.push(guardGit(home));
  s.permissions.allow = s.permissions.allow.filter((e) => !e.startsWith('Bash(node ~'));
  writeSettings(home, s);
  c = install(home, ['--check'], { source: src });
  assert.equal(c.status, 1);
  assert.match(c.stdout, /duplicat/i);
  assert.match(c.stdout, /allow/i);
  assert.equal(install(home, [], { source: src }).status, 0);
  assert.equal(install(home, ['--check'], { source: src }).status, 0);

  writeFileSync(join(src, 'skills', 'ship', 'SKILL.md'), 'new source\n');
  c = install(home, ['--check'], { source: src });
  assert.equal(c.status, 1, 'source changed since install');
  assert.match(c.stdout, /skills\/ship\/SKILL\.md/);
  assert.equal(install(home, [], { source: src }).status, 0);

  rmSync(join(src, 'agents', 'arbiter.md'));
  c = install(home, ['--check'], { source: src });
  assert.equal(c.status, 1);
  assert.match(c.stdout, /agents\/arbiter\.md/);
});

test('--check after --skip-file-guard install is clean without repeating the flag; guard-files appearing is drift', () => {
  const home = newHome();
  assert.equal(install(home, ['--skip-file-guard']).status, 0);
  assert.equal(install(home, ['--check']).status, 0);
  assert.equal(install(home, ['--check', '--skip-file-guard']).status, 0);
  assert.equal(install(home).status, 0);
  assert.equal(install(home, ['--check']).status, 0);
  const c = install(home, ['--check', '--skip-file-guard']);
  assert.equal(c.status, 1);
  assert.match(c.stdout, /guard-files/);
});

test('--check notices guard-files no longer last', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const s = readSettings(home);
  s.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo later' }] });
  writeSettings(home, s);
  const c = install(home, ['--check']);
  assert.equal(c.status, 1);
  assert.match(c.stdout, /last|order/i);
  assert.equal(install(home).status, 0);
  const after = readSettings(home);
  assert.deepEqual(after.hooks.PreToolUse.slice(-2), [guardGit(home), guardFiles(home)]);
  assert.equal(install(home, ['--check']).status, 0);
});

// 9
test('--uninstall removes our files, hooks and allow entries, keeps everything else, and backs up settings', () => {
  const home = newHome();
  const before = ownersSettings();
  writeSettings(home, before);
  mkdirSync(join(home, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(home, 'skills', 'mine', 'SKILL.md'), 'keep me\n');
  assert.equal(install(home).status, 0);
  const backupsAfterInstall = readdirSync(join(home, 'backups')).length;

  const r = install(home, ['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  for (const rel of ['skills/ship', 'skills/verify', 'skills/pipeline-setup', 'agents/judge.md', 'agents/implementer.md', 'pipeline']) {
    assert.equal(existsSync(join(home, ...rel.split('/'))), false, `${rel} should be gone`);
  }
  assert.equal(readFileSync(join(home, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'keep me\n');
  assert.deepEqual(readSettings(home), before, 'settings are back to exactly the owner\'s original');
  assert.equal(readdirSync(join(home, 'backups')).length, backupsAfterInstall + 1, 'uninstall backed up settings first');
  const last = readdirSync(join(home, 'backups')).sort().at(-1);
  assert.ok(readJson(join(home, 'backups', last)).hooks.PreToolUse.some((g) => g.hooks.some((h) => isOurHandler(h, home))), 'the backup holds the pre-uninstall settings');

  assert.equal(install(home, ['--check']).status, 1, 'no longer installed');
  assert.equal(install(home, ['--uninstall']).status, 0, 'uninstalling twice is harmless');
});

test('--uninstall keeps files in our directories that we did not install', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  writeFileSync(join(home, 'pipeline', 'my-notes.txt'), 'mine\n');
  assert.equal(install(home, ['--uninstall']).status, 0);
  assert.equal(readFileSync(join(home, 'pipeline', 'my-notes.txt'), 'utf8'), 'mine\n');
  assert.equal(existsSync(join(home, 'pipeline', 'INSTALLED.json')), false);
  assert.equal(existsSync(join(home, 'pipeline', 'hooks')), false);
});

// 10
test('invalid JSON in settings.json: exit 1, file and tree untouched', () => {
  const home = newHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(settingsPath(home), '{ "hooks": { oops ');
  for (const args of [[], ['--uninstall'], ['--check']]) {
    const r = install(home, args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr + r.stdout, /valid JSON/);
  }
  assert.equal(readFileSync(settingsPath(home), 'utf8'), '{ "hooks": { oops ');
  assert.deepEqual(readdirSync(home), ['settings.json']);
});

test('settings.json with a wrongly shaped hooks/permissions value: exit 1, nothing written', () => {
  const home = newHome();
  writeSettings(home, { hooks: { PreToolUse: 'nope' } });
  const r = install(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PreToolUse/);
  assert.deepEqual(readdirSync(home), ['settings.json']);
});

// 11
test('a file removed from the source between installs is removed from home on reinstall', () => {
  const home = newHome();
  const src = copyFixture();
  assert.equal(install(home, [], { source: src }).status, 0);
  assert.ok(existsSync(join(home, 'agents', 'arbiter.md')));
  assert.ok(existsSync(join(home, 'skills', 'ship', 'reference', 'notes.md')));
  assert.ok(existsSync(join(home, 'pipeline', 'templates', 'example.md')));
  rmSync(join(src, 'agents', 'arbiter.md'));
  rmSync(join(src, 'skills', 'ship', 'reference'), { recursive: true });
  rmSync(join(src, 'pipeline', 'templates'), { recursive: true });
  const r = install(home, ['--json'], { source: src });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, 'agents', 'arbiter.md')), false);
  assert.equal(existsSync(join(home, 'skills', 'ship', 'reference')), false);
  assert.equal(existsSync(join(home, 'pipeline', 'templates')), false);
  assert.ok(existsSync(join(home, 'agents', 'judge.md')));
  const m = readManifest(home);
  assert.ok(!('agents/arbiter.md' in m.files));
  assert.deepEqual(JSON.parse(r.stdout).files.removed.sort(), [
    'agents/arbiter.md', 'pipeline/templates/example.md', 'skills/ship/reference/notes.md',
  ]);
});

// 12
test('backup filename is settings.json.YYYYMMDDTHHMMSSZ with no colons', () => {
  const home = newHome();
  writeSettings(home, ownersSettings());
  const r = install(home, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const names = readdirSync(join(home, 'backups'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^settings\.json\.\d{8}T\d{6}Z$/);
  assert.deepEqual(readJson(join(home, 'backups', names[0])), ownersSettings(), 'the backup is the file as it was');
  assert.equal(JSON.parse(r.stdout).settings.backup, join(home, 'backups', names[0]));
});

// 13
test('install.sh runs the Node installer (sh wrapper)', { skip: process.platform === 'win32' }, () => {
  const home = newHome({ space: true });
  const r = run(['--claude-home', home, '--source', FIXTURE], { script: join(REPO, 'install.sh'), command: 'sh' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(home, 'pipeline', 'INSTALLED.json')));
  const text = readFileSync(join(REPO, 'install.sh'), 'utf8');
  assert.match(text, /^#!\/usr\/bin\/env sh\n/);
  assert.match(text, /set -eu/);
  assert.match(text, /exec node "\$\(dirname "\$0"\)\/install\.mjs" "\$@"/);
  assert.ok(statSync(join(REPO, 'install.sh')).mode & 0o100, 'install.sh is executable');
  const ps1 = readFileSync(join(REPO, 'install.ps1'), 'utf8');
  assert.match(ps1, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(ps1, /node "\$PSScriptRoot\/install\.mjs" @args/);
  assert.match(ps1, /exit \$LASTEXITCODE/);
});

// ---- more end-to-end behaviour ------------------------------------------------------------------------------

test('a missing settings.json is created minimal; --claude-home beats CLAUDE_CONFIG_DIR, which beats ~/.claude', () => {
  const viaFlag = newHome();
  const viaEnv = newHome();
  const r = install(viaFlag, [], { env: { CLAUDE_CONFIG_DIR: viaEnv } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(settingsPath(viaFlag)));
  assert.equal(existsSync(viaEnv), false);

  const r2 = run(['--source', FIXTURE], { env: { CLAUDE_CONFIG_DIR: viaEnv } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(join(viaEnv, 'pipeline', 'INSTALLED.json')), 'CLAUDE_CONFIG_DIR is honoured');

  const r3 = run(['--source', FIXTURE]);
  assert.equal(r3.status, 0, r3.stderr);
  assert.ok(existsSync(join(r3.userHome, '.claude', 'pipeline', 'INSTALLED.json')), 'defaults to ~/.claude');
});

test('a settings.json that is a symlink stays a symlink and its target is updated', { skip: process.platform === 'win32' }, () => {
  const home = newHome();
  mkdirSync(home, { recursive: true });
  const real = join(scratch('cp-dotfiles'), 'settings.real.json');
  writeFileSync(real, `${JSON.stringify(ownersSettings(), null, 2)}\n`);
  symlinkSync(real, settingsPath(home));
  assert.equal(install(home).status, 0);
  assert.ok(lstatSync(settingsPath(home)).isSymbolicLink());
  assert.ok(readJson(real).hooks.PreToolUse.some((g) => g.hooks.some((h) => isOurHandler(h, home))));
});

test('an existing settings.json keeps its file mode', { skip: process.platform === 'win32' }, () => {
  const home = newHome();
  writeSettings(home, ownersSettings());
  chmodSync(settingsPath(home), 0o600);
  assert.equal(install(home).status, 0);
  assert.equal(statSync(settingsPath(home)).mode & 0o777, 0o600);
});

test('--json prints one machine-readable report with the diagnostics block', () => {
  const home = newHome();
  writeSettings(home, ownersSettings());
  const r = install(home, ['--json'], { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.version, '9.9.9');
  assert.equal(j.hooks.guardGit, true);
  assert.equal(j.hooks.guardFiles, true);
  assert.equal(j.files.total, Object.keys(readManifest(home).files).length);
  assert.equal(j.diagnostics.subagentModel.settingsEnv, 'sonnet');
  assert.equal(j.diagnostics.subagentModel.processEnv, 'haiku');
  assert.match(j.diagnostics.note, /Pinned agent models \(judge=sonnet, arbiter=fable, verifier=haiku, Explore=haiku\) still win over this env var/);
});

test('the human report lists version, files, hooks, backup and the model diagnostics', () => {
  const home = newHome();
  writeSettings(home, ownersSettings());
  const r = install(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /9\.9\.9/);
  assert.match(r.stdout, /guard-files/i);
  assert.match(r.stdout, /backups/);
  assert.match(r.stdout, /CLAUDE_CODE_SUBAGENT_MODEL/);
  assert.match(r.stdout, /Pinned agent models/);
});

test('tool versions are probed with a timeout and reported; a missing tool never fails the install', { skip: process.platform === 'win32' }, () => {
  const bin = scratch('cp-fakebin');
  for (const [name, text] of [['claude', '2.1.285 (Claude Code)'], ['codex', 'codex-cli 0.9.9']]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${text}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 127\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const home = newHome();
  const r = install(home, ['--json'], { env: { PIPELINE_INSTALL_NO_PROBES: '', PATH: `${bin}${delimiter}${FAKE_PS_DIR}${delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout).diagnostics.versions;
  assert.match(v.claude, /2\.1\.285/);
  assert.match(v.codex, /0\.9\.9/);
  assert.equal(typeof v.gh, 'string');
  assert.notEqual(v.gh, '');
});

test('usage errors exit 2: unknown flag, missing value, --check with --uninstall', () => {
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--claude-home']).status, 2);
  assert.equal(run(['--check', '--uninstall']).status, 2);
  assert.match(run(['--help']).stdout, /--claude-home/);
});

test('an incomplete source tree is rejected before anything is written; a missing skill or agent is only a warning', () => {
  const home = newHome();
  const src = copyFixture();
  rmSync(join(src, 'VERSION'));
  rmSync(join(src, 'pipeline', 'hooks', 'guard-files.mjs'));
  const r = install(home, [], { source: src });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VERSION/);
  assert.match(r.stderr, /guard-files\.mjs/);
  assert.equal(existsSync(home), false);

  const partial = copyFixture();
  rmSync(join(partial, 'skills', 'verify'), { recursive: true });
  const ok = install(home, ['--json'], { source: partial });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(JSON.parse(ok.stdout).warnings.join('\n'), /skills\/verify/);
  assert.equal(existsSync(join(home, 'skills', 'verify')), false);
  assert.ok(existsSync(join(home, 'skills', 'ship')));
});

test('a manifest key that escapes the home is ignored, never deleted', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const victim = join(dirname(home), 'precious.txt');
  writeFileSync(victim, 'precious\n');
  const m = readManifest(home);
  m.files['../precious.txt'] = 'x';
  m.files['skills/../../precious.txt'] = 'x';
  m.files['pipeline/../../precious.txt'] = 'x';
  writeFileSync(join(home, 'pipeline', 'INSTALLED.json'), JSON.stringify(m));
  const r = install(home, ['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n');
  assert.match(r.stdout, /ignoring unsafe manifest entry/);
});

// ---- pure logic ---------------------------------------------------------------------------------------------

test('mergeSettings never mutates its input and returns a new object', () => {
  const input = ownersSettings();
  const snapshot = structuredClone(input);
  const out = mergeSettings(input, { home: '/h/.claude' });
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
  assert.notEqual(out.hooks, input.hooks);
  assert.equal(out.hooks.PreToolUse.length, input.hooks.PreToolUse.length + 4);
});

test('mergeSettings on an empty object builds the minimal structure; skipFileGuard omits guard-files', () => {
  const full = mergeSettings({}, { home: '/h/.claude' });
  assert.equal(full.hooks.PreToolUse.length, 4);
  assert.equal(full.hooks.PreToolUse.at(-1).matcher, GUARD_FILES_MATCHER);
  assert.deepEqual(full.permissions.allow, ['Bash(node /h/.claude/pipeline/bin/pipeline.mjs:*)', 'Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)']);
  const partial = mergeSettings({}, { home: '/h/.claude', skipFileGuard: true });
  assert.equal(partial.hooks.PreToolUse.length, 3, 'the stack-register groups are installed with or without the file guard');
  assert.equal(partial.hooks.PreToolUse.at(-1).matcher, 'Bash|PowerShell|Monitor|mcp__.*');
});

test('mergeSettings writes native Windows paths in args and a posix path in the allow entry', () => {
  const home = 'C:\\Users\\Jo Smith\\.claude';
  const out = mergeSettings({}, { home });
  assert.deepEqual(out.hooks.PreToolUse[2].hooks[0].args, ['--input-type=module', '-e', HOOK_LOADER, 'C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\guard-git.mjs']);
  assert.deepEqual(out.hooks.PreToolUse[3].hooks[0].args, ['--input-type=module', '-e', HOOK_LOADER, 'C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\guard-files.mjs']);
  assert.deepEqual(out.hooks.PreToolUse[0].hooks[0].args, ['--input-type=module', '-e', HOOK_LOADER, 'C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\stack-register.mjs']);
  assert.deepEqual(out.hooks.PostToolUse[0].hooks[0].args, ['C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\stack-dev-bind.mjs']);
  assert.deepEqual(out.hooks.SessionEnd[0].hooks[0].args, ['C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\stack-session-end.mjs']);
  assert.equal(out.permissions.allow[0], 'Bash(node C:/Users/Jo Smith/.claude/pipeline/bin/pipeline.mjs:*)');
  // and an earlier Windows-style entry is recognised as ours and replaced
  const again = mergeSettings(out, { home });
  assert.deepEqual(again, out);
});

test('isOurHandler matches the pipeline hooks dir in command or args, either slash direction', () => {
  assert.equal(isOurHandler({ command: 'node /a/.claude/pipeline/hooks/guard-git.mjs' }), true);
  assert.equal(isOurHandler({ command: 'node "C:\\Users\\u\\.claude\\pipeline\\hooks\\guard-files.mjs"' }), true);
  assert.equal(isOurHandler({ command: 'node', args: ['/custom home/pipeline/hooks/guard-git.mjs'] }, '/custom home'), true);
  assert.equal(isOurHandler({ command: 'node', args: ['D:\\x y\\pipeline\\hooks\\guard-files.mjs'] }, 'D:\\x y'), true);
  assert.equal(isOurHandler({ command: 'node "/custom home/pipeline/hooks/guard-git.mjs"' }, '/custom home/'), true);
  assert.equal(isOurHandler({ command: 'node /opt/memory-guard.js' }), false);
  assert.equal(isOurHandler({ command: 'echo pipeline hooks' }), false);
  assert.equal(isOurHandler(null), false);
  assert.equal(isOurHandler({ type: 'prompt', prompt: 'x' }), false);
});

test('mergeSettings drops a group left empty but keeps a group with other handlers; hooks of an event we do not manage are never touched', () => {
  const input = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /a/.claude/pipeline/hooks/guard-git.mjs' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: 'node /a/.claude/pipeline/hooks/guard-files.mjs' }] },
        { matcher: 'Read', hooks: [] },
      ],
      // (PostToolUse is managed since the stack hooks; Stop is not)
      Stop: [{ hooks: [{ type: 'command', command: 'node /a/.claude/pipeline/hooks/guard-git.mjs' }] }],
    },
  };
  const out = mergeSettings(input, { home: '/h/.claude' });
  assert.deepEqual(out.hooks.PreToolUse.slice(0, 2), [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
    { matcher: 'Read', hooks: [] },
  ]);
  assert.deepEqual(out.hooks.Stop, input.hooks.Stop);
});

test('mergeSettings rejects wrongly shaped settings instead of guessing', () => {
  assert.throws(() => mergeSettings([], { home: '/h' }), /object/);
  assert.throws(() => mergeSettings({ hooks: [] }, { home: '/h' }), /hooks/);
  assert.throws(() => mergeSettings({ hooks: { PreToolUse: {} } }, { home: '/h' }), /PreToolUse/);
  assert.throws(() => mergeSettings({ permissions: { allow: 'x' } }, { home: '/h' }), /allow/);
  assert.throws(() => mergeSettings({ permissions: [] }, { home: '/h' }), /permissions/);
});

test('removeOurSettings is the inverse of mergeSettings on settings that had neither hooks nor allow entries', () => {
  const home = '/h/.claude';
  for (const base of [{}, { env: { A: '1' } }, ownersSettings(), { permissions: { deny: ['x'] }, hooks: { Stop: [] } }]) {
    const merged = mergeSettings(base, { home });
    assert.deepEqual(removeOurSettings(merged, { home }), base);
  }
  assert.deepEqual(ourAllowEntries(home), ['Bash(node /h/.claude/pipeline/bin/pipeline.mjs:*)', 'Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)']);
});

test('renameWithRetry retries EPERM/EBUSY on Windows only, gives up after the attempt limit, and rethrows other errors', () => {
  const failing = (n, code) => {
    let calls = 0;
    return { calls: () => calls, rename: () => { calls++; if (calls <= n) throw Object.assign(new Error(code), { code }); } };
  };
  const sleeps = [];
  const sleep = (ms) => sleeps.push(ms);

  let f = failing(3, 'EPERM');
  renameWithRetry('a', 'b', { rename: f.rename, platform: 'win32', sleep });
  assert.equal(f.calls(), 4);
  assert.deepEqual(sleeps, [50, 50, 50]);

  f = failing(2, 'EBUSY');
  renameWithRetry('a', 'b', { rename: f.rename, platform: 'win32', sleep });
  assert.equal(f.calls(), 3);

  f = failing(100, 'EPERM');
  assert.throws(() => renameWithRetry('a', 'b', { rename: f.rename, platform: 'win32', sleep }), /EPERM/);
  assert.equal(f.calls(), 20);

  f = failing(1, 'EPERM');
  assert.throws(() => renameWithRetry('a', 'b', { rename: f.rename, platform: 'linux', sleep }), /EPERM/);
  assert.equal(f.calls(), 1);

  f = failing(1, 'ENOENT');
  assert.throws(() => renameWithRetry('a', 'b', { rename: f.rename, platform: 'win32', sleep }), /ENOENT/);
  assert.equal(f.calls(), 1);
});

test('parseArgs reads every flag, both --flag value and --flag=value', () => {
  const a = parseArgs(['--claude-home', '/h', '--source=/s', '--check', '--skip-file-guard', '--force', '--json']);
  assert.deepEqual(a.opts, { claudeHome: '/h', source: '/s', check: true, uninstall: false, skipFileGuard: true, force: true, json: true });
  assert.equal(parseArgs(['--uninstall']).opts.uninstall, true);
  assert.ok(parseArgs(['--nope']).error);
  assert.ok(parseArgs(['--source']).error);
  assert.ok(parseArgs(['--claude-home', '--check']).error);
  assert.ok(parseArgs(['--check', '--uninstall']).error);
  assert.ok(parseArgs(['stray']).error);
  assert.equal(parseArgs(['-h']).help, true);
});

test('safeManifestKey accepts only relative posix keys under skills/, agents/ or pipeline/', () => {
  for (const ok of ['skills/ship/SKILL.md', 'agents/judge.md', 'pipeline/VERSION', 'pipeline/a/b.mjs']) assert.equal(safeManifestKey(ok), true, ok);
  for (const bad of ['', '/etc/passwd', 'C:/x', '../x', 'skills/../../x', 'skills//x', 'skills/./x', 'skills\\ship', 'settings.json', 'projects/x', 'pipeline', 'skills', 42, null]) {
    assert.equal(safeManifestKey(bad), false, String(bad));
  }
});

test('buildPlan and walkFiles read the fixture: sorted, excluded names skipped, VERSION lands in pipeline/', () => {
  const plan = buildPlan(FIXTURE);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.version, '9.9.9');
  assert.ok(plan.files.has('pipeline/VERSION'));
  assert.ok(plan.files.has('skills/ship/reference/notes.md'));
  assert.ok(plan.files.has('agents/arbiter.md'));
  assert.deepEqual(plan.units.map((u) => u.rel), [
    'pipeline', 'agents/implementer.md', 'agents/verifier.md', 'agents/judge.md', 'agents/arbiter.md', 'agents/Explore.md',
    'skills/ship', 'skills/verify', 'skills/pipeline-setup',
  ]);
  const walked = walkFiles(join(FIXTURE, 'skills'));
  assert.deepEqual(walked, [...walked].sort());
  assert.equal(buildPlan(join(FIXTURE, 'nope')).problems.length > 0, true);
});

test('collectDiagnostics: model var from settings env, process env and shell files; versions with timeouts; never throws', () => {
  const home = scratch('cp-diag-home');
  writeFileSync(join(home, '.zshrc'), '# export CLAUDE_CODE_SUBAGENT_MODEL=commented\nexport PATH=x\nexport CLAUDE_CODE_SUBAGENT_MODEL=opus\n');
  writeFileSync(join(home, '.bashrc'), 'echo hi\n');
  const calls = [];
  const runFn = (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
    if (cmd === 'claude') return { code: 0, stdout: '2.1.285 (Claude Code)\n', stderr: '', timedOut: false };
    if (cmd === 'codex') return { code: 1, stdout: '', stderr: 'spawnSync codex ENOENT', timedOut: false };
    throw new Error('boom');
  };
  const d = collectDiagnostics({
    settings: { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } },
    env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' },
    home, platform: 'linux', runFn,
  });
  assert.equal(d.subagentModel.settingsEnv, 'sonnet');
  assert.equal(d.subagentModel.processEnv, 'haiku');
  assert.deepEqual(d.subagentModel.shellFiles, [{ file: join(home, '.zshrc'), line: 3, text: 'export CLAUDE_CODE_SUBAGENT_MODEL=opus' }]);
  assert.match(d.note, /Pinned agent models \(judge=sonnet, arbiter=fable, verifier=haiku, Explore=haiku\) still win over this env var — verified on Claude Code 2\.1\.285; unpinned subagents use it\./);
  assert.equal(d.versions.claude, '2.1.285 (Claude Code)');
  assert.equal(d.versions.codex, 'not found');
  assert.equal(d.versions.gh, 'not found');
  assert.deepEqual(calls.map((c) => [c.cmd, c.args, c.timeoutMs]), [
    ['claude', ['--version'], 10000], ['codex', ['--version'], 10000], ['gh', ['--version'], 10000],
  ]);

  const none = collectDiagnostics({ settings: {}, env: {}, home, platform: 'linux', runFn: null });
  assert.equal(none.subagentModel.settingsEnv, null);
  assert.equal(none.subagentModel.processEnv, null);
  assert.equal(none.versions, null);
});

test('shellRcPaths: POSIX rc files everywhere, PowerShell profiles on win32', () => {
  const h = '/home/u';
  assert.deepEqual(shellRcPaths(h, 'linux').map((p) => posix(p).replace(h, '~')), ['~/.zshrc', '~/.bashrc', '~/.zprofile', '~/.profile', '~/.bash_profile']);
  const win = shellRcPaths('C:\\Users\\u', 'win32').map(posix);
  assert.ok(win.some((p) => /Documents\/PowerShell\/Microsoft\.PowerShell_profile\.ps1$/.test(p)));
  assert.ok(win.some((p) => /Documents\/WindowsPowerShell\/Microsoft\.PowerShell_profile\.ps1$/.test(p)));
  assert.ok(win.some((p) => /\.zshrc$/.test(p)));

  const home = scratch('cp-win-home');
  mkdirSync(join(home, 'Documents', 'PowerShell'), { recursive: true });
  writeFileSync(join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'), '$env:CLAUDE_CODE_SUBAGENT_MODEL = "opus"\n');
  const d = collectDiagnostics({ settings: {}, env: {}, home, platform: 'win32', runFn: null });
  assert.equal(d.subagentModel.shellFiles.length, 1);
  assert.equal(d.subagentModel.shellFiles[0].line, 1);
});

// ---- review findings (task 4.1 fixes) ------------------------------------------------------------------------

test('guard-git matches Bash, PowerShell, Monitor and MCP tools, guard-files stays last with its wider matcher; both come from constants', () => {
  assert.equal(GUARD_GIT_MATCHER, 'Bash|PowerShell|Monitor|mcp__.*');
  const out = mergeSettings({}, { home: '/h/.claude' });
  assert.deepEqual(out.hooks.PreToolUse.map((g) => g.matcher), [...STACK_REGISTER_MATCHERS, 'Bash|PowerShell|Monitor|mcp__.*', GUARD_FILES_MATCHER]);
  const skip = mergeSettings({}, { home: '/h/.claude', skipFileGuard: true });
  assert.deepEqual(skip.hooks.PreToolUse.map((g) => g.matcher), [...STACK_REGISTER_MATCHERS, 'Bash|PowerShell|Monitor|mcp__.*']);

  // --check treats the old Bash-only matcher as drift (the hook would never fire on PowerShell)
  const home = newHome();
  assert.equal(install(home).status, 0);
  assert.equal(run(['--check', '--claude-home', home, '--source', FIXTURE]).status, 0);
  const s = readSettings(home);
  s.hooks.PreToolUse.find((g) => g.matcher === GUARD_GIT_MATCHER).matcher = 'Bash';
  writeSettings(home, s);
  const r = run(['--check', '--claude-home', home, '--source', FIXTURE]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /guard-git entry is not what install writes/);
});

test('a user hook under some other /pipeline/hooks/guard-*.mjs survives install and uninstall', () => {
  const home = newHome();
  const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /proj/pipeline/hooks/guard-secrets.mjs' }] };
  const userGroup2 = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['/work/app/pipeline/hooks/guard-git.mjs'] }] };
  const before = { hooks: { PreToolUse: [userGroup, userGroup2] } };
  assert.equal(isOurHandler(userGroup.hooks[0], home), false);
  assert.equal(isOurHandler(userGroup2.hooks[0], home), false);
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  assert.deepEqual(readSettings(home).hooks.PreToolUse, [userGroup, userGroup2, ...stackRegisters(home), guardGit(home), guardFiles(home)]);
  assert.equal(install(home).status, 0);
  assert.equal(readSettings(home).hooks.PreToolUse.length, 6, 'a second install does not add or drop anything');
  assert.equal(run(['--uninstall', '--claude-home', home]).status, 0);
  assert.deepEqual(readSettings(home), before);
});

test('reinstall keeps a user-edited skill (modified file plus an extra one) in backups/<name>.<timestamp>', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  writeFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'my tuned skill\n');
  writeFileSync(join(home, 'skills', 'ship', 'extra.md'), 'my notes\n');
  writeFileSync(join(home, 'agents', 'judge.md'), 'my judge\n');
  const r = install(home, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.editBackups.length, 2);
  const backups = readdirSync(join(home, 'backups'));
  const shipBackup = backups.find((n) => /^ship\.\d{8}T\d{6}Z/.test(n));
  const judgeBackup = backups.find((n) => /^judge\.md\.\d{8}T\d{6}Z/.test(n));
  assert.ok(shipBackup && judgeBackup, backups.join(', '));
  assert.equal(readFileSync(join(home, 'backups', shipBackup, 'SKILL.md'), 'utf8'), 'my tuned skill\n');
  assert.equal(readFileSync(join(home, 'backups', shipBackup, 'extra.md'), 'utf8'), 'my notes\n');
  assert.equal(readFileSync(join(home, 'backups', judgeBackup), 'utf8'), 'my judge\n');
  assert.ok(report.editBackups.every((b) => b.backup.startsWith(join(home, 'backups'))));
  // the install itself is repaired, and the human report names the backup
  assert.equal(readFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'utf8'), readFileSync(join(FIXTURE, 'skills', 'ship', 'SKILL.md'), 'utf8'));
  assert.equal(existsSync(join(home, 'skills', 'ship', 'extra.md')), false);
  writeFileSync(join(home, 'skills', 'verify', 'SKILL.md'), 'again\n');
  assert.match(install(home).stdout, /your edits in skills\/verify were replaced; the old copy is at .*verify\./);
});

test('a plain source update (installed files untouched by the user) is not backed up', () => {
  const home = newHome();
  const src = copyFixture();
  assert.equal(install(home, [], { source: src }).status, 0);
  writeFileSync(join(src, 'skills', 'ship', 'SKILL.md'), 'new upstream text\n');
  const r = install(home, [], { source: src });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, 'backups')), false);
  assert.equal(readFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'utf8'), 'new upstream text\n');
});

test('a home path with whitespace gets the plain and a quoted allow entry; uninstall removes both; idempotent', () => {
  const home = newHome({ space: true });
  const p = `${posix(home)}/pipeline/bin/pipeline.mjs`;
  assert.deepEqual(ourAllowEntries(home), [`Bash(node ${p}:*)`, `Bash(node "${p}":*)`, 'Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)']);
  assert.equal(ourAllowEntries('/h/.claude').length, 2, 'no quoted variant without whitespace');
  writeSettings(home, { permissions: { allow: ['Bash(ls:*)'] } });
  assert.equal(install(home).status, 0);
  const allow = readSettings(home).permissions.allow;
  assert.deepEqual(allow, ['Bash(ls:*)', ...ourAllowEntries(home)]);
  assert.equal(install(home).status, 0);
  assert.deepEqual(readSettings(home).permissions.allow, allow);
  assert.equal(run(['--check', '--claude-home', home, '--source', FIXTURE]).status, 0);
  assert.equal(run(['--uninstall', '--claude-home', home]).status, 0);
  assert.deepEqual(readSettings(home), { permissions: { allow: ['Bash(ls:*)'] } });
});

test('a second no-op install leaves settings.json and INSTALLED.json byte-identical', async () => {
  const home = newHome();
  writeSettings(home, ownersSettings());
  assert.equal(install(home).status, 0);
  const files = [settingsPath(home), join(home, 'pipeline', 'INSTALLED.json')];
  const before = files.map((f) => readFileSync(f, 'utf8'));
  const mtimes = files.map((f) => statSync(f).mtimeMs);
  await new Promise((r) => setTimeout(r, 1100)); // a rewrite would carry a new installedAt
  assert.equal(install(home).status, 0);
  assert.deepEqual(files.map((f) => readFileSync(f, 'utf8')), before);
  assert.deepEqual(files.map((f) => statSync(f).mtimeMs), mtimes, 'not even rewritten');
  // a real change (new source version) still refreshes the manifest
  const src = copyFixture();
  writeFileSync(join(src, 'VERSION'), '9.9.10\n');
  assert.equal(install(home, [], { source: src }).status, 0);
  assert.equal(readManifest(home).version, '9.9.10');
});

test('the top-level test/ exclusion does not hide a nested reference/test/ directory', () => {
  const src = copyFixture();
  mkdirSync(join(src, 'skills', 'ship', 'test'), { recursive: true });
  writeFileSync(join(src, 'skills', 'ship', 'test', 'top.md'), 'x');
  mkdirSync(join(src, 'skills', 'ship', 'reference', 'test'), { recursive: true });
  writeFileSync(join(src, 'skills', 'ship', 'reference', 'test', 'keep.md'), 'keep');
  mkdirSync(join(src, 'pipeline', 'lib', 'test'), { recursive: true });
  writeFileSync(join(src, 'pipeline', 'lib', 'test', 'keep.mjs'), 'keep');
  const plan = buildPlan(src);
  assert.ok(plan.files.has('skills/ship/reference/test/keep.md'));
  assert.ok(plan.files.has('pipeline/lib/test/keep.mjs'));
  assert.ok(!plan.files.has('skills/ship/test/top.md'));
  const home = newHome();
  assert.equal(install(home, [], { source: src }).status, 0);
  assert.equal(readFileSync(join(home, 'skills', 'ship', 'reference', 'test', 'keep.md'), 'utf8'), 'keep');
  assert.equal(existsSync(join(home, 'skills', 'ship', 'test')), false);
});

test('stage and rollback copies live under backups/.staging, never inside skills/ or agents/', () => {
  const home = newHome();
  // If staging were beside the targets, this blocker would not matter; under backups/.staging it stops the install.
  mkdirSync(join(home, 'backups'), { recursive: true });
  writeFileSync(join(home, 'backups', '.staging'), 'in the way');
  const r = install(home);
  assert.notEqual(r.status, 0, 'the install had to stage under backups/.staging');
  assert.equal(existsSync(join(home, 'skills')), false);
  assert.equal(existsSync(join(home, 'agents')), false);
  rmSync(join(home, 'backups', '.staging'));
  assert.equal(install(home).status, 0);
  assert.ok(readdirSync(join(home, 'skills')).every((n) => !/\.(new|old)-/.test(n)));
  assert.ok(readdirSync(join(home, 'agents')).every((n) => !/\.(new|old)-/.test(n)));
  assert.equal(existsSync(join(home, 'backups', '.staging')), false, 'the staging dir is removed when empty');
});

// ---- A1: complete-install marker --------------------------------------------------------------------------------

test('a finished install says complete: true; a legacy manifest without the field counts as complete', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  assert.equal(readManifest(home).complete, true);

  const m = readManifest(home);
  delete m.complete;
  writeFileSync(join(home, 'pipeline', 'INSTALLED.json'), `${JSON.stringify(m, null, 2)}\n`);
  const check = install(home, ['--check', '--json']);
  assert.equal(check.status, 0, check.stdout);
  assert.deepEqual(JSON.parse(check.stdout).drift, []);
  const before = readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8');
  assert.equal(install(home).status, 0);
  assert.equal(readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8'), before, 'a legacy-but-current manifest is left byte-identical');
});

test('an install that dies after the pipeline unit leaves complete: false, --check says incomplete, a re-run repairs it', () => {
  const home = newHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'agents'), 'a file where the agents/ dir has to go\n'); // the agents unit cannot be staged
  const failed = install(home);
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(readManifest(home).complete, false, 'the pipeline unit landed, the install did not finish');

  const check = install(home, ['--check', '--json']);
  assert.equal(check.status, 1);
  const incomplete = JSON.parse(check.stdout).drift.filter((d) => d.kind === 'incomplete');
  assert.deepEqual(incomplete, [{
    kind: 'incomplete',
    path: 'pipeline/INSTALLED.json',
    message: 'incomplete: a previous install did not finish; re-run the installer',
  }]);
  assert.match(install(home, ['--check']).stdout, /incomplete: a previous install did not finish/);

  rmSync(join(home, 'agents'));
  const repaired = install(home);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(readManifest(home).complete, true);
  assert.equal(install(home, ['--check']).status, 0);
});

test('a later unit failing while the pipeline unit is unchanged still marks the install incomplete', () => {
  const home = newHome();
  const src = copyFixture();
  assert.equal(install(home, [], { source: src }).status, 0);
  writeFileSync(join(src, 'skills', 'ship', 'SKILL.md'), 'newer ship skill\n');
  rmSync(join(home, 'agents', 'judge.md'));
  mkdirSync(join(home, 'agents', 'judge.md')); // a directory where the agent file goes: its swap fails
  writeFileSync(join(home, 'agents', 'judge.md', 'x'), 'x');
  const failed = install(home, ['--force'], { source: src });
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(readManifest(home).complete, false);
  rmSync(join(home, 'agents', 'judge.md'), { recursive: true });
  assert.equal(install(home, [], { source: src }).status, 0);
  assert.equal(readManifest(home).complete, true);
});

// ---- A2: fail-closed hook loading -------------------------------------------------------------------------------

function runLoader(hookPath, input) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', HOOK_LOADER, hookPath], { encoding: 'utf8', input, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function runDirect(hookPath, input) {
  const r = spawnSync(process.execPath, [hookPath], { encoding: 'utf8', input, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('the hook loader blocks (exit 2, one stderr line) when the hook file is missing', () => {
  const dir = scratch('cp-loader');
  const r = runLoader(join(dir, 'pipeline', 'hooks', 'guard-git.mjs'), '{}');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^claude-pipeline: hook could not be loaded \(ERR_MODULE_NOT_FOUND\); blocking this call\n$/);
});

test('the hook loader blocks when the hook file exists but its module graph does not load', () => {
  const dir = scratch('cp-loader');
  writeFileSync(join(dir, 'broken.mjs'), "import './not-there.mjs';\n");
  const syntax = join(dir, 'syntax.mjs');
  writeFileSync(syntax, 'this is ( not javascript\n');
  assert.equal(runLoader(join(dir, 'broken.mjs'), '{}').status, 2);
  assert.equal(runLoader(syntax, '{}').status, 2);
});

test('the hook loader changes nothing for a hook that loads: same stdout and exit code as running it directly', () => {
  const guard = join(REPO, 'pipeline', 'hooks', 'guard-git.mjs');
  const cwd = scratch('cp-loader-cwd');
  for (const command of ['ls -la', 'git push --force origin main']) {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
    const direct = runDirect(guard, input);
    const viaLoader = runLoader(guard, input);
    assert.equal(viaLoader.status, direct.status, command);
    assert.equal(viaLoader.stdout, direct.stdout, command);
    assert.equal(viaLoader.stderr, direct.stderr, command);
  }
  const allowed = runLoader(guard, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd }));
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('the installer writes the loader handler; an old plain-args handler is hook-differs under --check and replaced by a reinstall', () => {
  const home = newHome();
  const s = ownersSettings();
  s.hooks.PreToolUse.push({
    matcher: 'Bash|PowerShell|Monitor|mcp__.*',
    hooks: [{ type: 'command', command: 'node', args: [join(home, 'pipeline', 'hooks', 'guard-git.mjs')], timeout: 15 }],
  });
  writeSettings(home, s);
  assert.equal(install(home).status, 0);
  const after = readSettings(home);
  const ours = after.hooks.PreToolUse.filter((g) => g.hooks.some((h) => isOurHandler(h, home)));
  assert.deepEqual(ours, [...stackRegisters(home), guardGit(home), guardFiles(home)], 'the old entry was replaced, not duplicated');

  // restore the old shape and see --check call it out
  after.hooks.PreToolUse = after.hooks.PreToolUse.map((g) => (g.hooks.some((h) => String(h.args?.at(-1)).endsWith('guard-git.mjs'))
    ? { ...g, hooks: [{ type: 'command', command: 'node', args: [join(home, 'pipeline', 'hooks', 'guard-git.mjs')], timeout: 15 }] } : g));
  writeSettings(home, after);
  const check = install(home, ['--check', '--json']);
  assert.equal(check.status, 1);
  assert.ok(JSON.parse(check.stdout).drift.some((d) => d.kind === 'hook-differs' && d.path === 'guard-git'), check.stdout);
});

// ---- Phase 4: the SessionStart status hook (session-version) is retired; stack-register narrows; the retired-unit mechanism --------

const OLD_STACK_MATCHER = 'Read|Edit|Write|Grep|Glob|NotebookEdit';
const SESSION_VERSION_FILE = 'pipeline/hooks/session-version.mjs';

// An install in the shape the previous release wrote: the SessionStart status group, pipeline/hooks/session-version.mjs listed in
// the manifest, and stack-register on its old second matcher. Built from a current install by adding those back; `before` is
// the owner's settings.json at the start (the owner's own hooks sit next to ours).
function makeOldShape(home, before = {}) {
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  const file = join(home, ...SESSION_VERSION_FILE.split('/'));
  writeFileSync(file, '// fixture stub: session-version\n');
  const manifest = readManifest(home);
  manifest.files[SESSION_VERSION_FILE] = sha(file);
  writeFileSync(join(home, 'pipeline', 'INSTALLED.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const s = readSettings(home);
  s.hooks.SessionStart ??= [];
  s.hooks.SessionStart.push(sessionVersion(home));
  s.hooks.PreToolUse = s.hooks.PreToolUse.map((g) => (g.matcher === STACK_REGISTER_MATCHERS[1] ? { ...g, matcher: OLD_STACK_MATCHER } : g));
  writeSettings(home, s);
  return s;
}

test('update from the previous release: session-version is gone, stack-register sits on the two new matchers, the owner\'s hooks are untouched, no drift, a second update is a no-op', () => {
  const home = newHome();
  const owner = ownersSettings();
  makeOldShape(home, owner);

  // the old shape is recognised as ours and reported before the update
  const found = inspectHooks(readSettings(home), home);
  assert.deepEqual(found.retired.map((r) => [r.script, r.matcher]), [['stack-register', OLD_STACK_MATCHER], ['session-version', undefined]]);
  assert.deepEqual(found.unknown, []);
  const old = driftOf(home);
  assert.equal(old.status, 1);
  assert.ok(old.items.some((d) => d.kind === 'hook-retired' && d.path === 'session-version'), JSON.stringify(old.items));
  assert.ok(old.items.some((d) => d.kind === 'hook-retired' && d.path === `stack-register (${OLD_STACK_MATCHER})`), JSON.stringify(old.items));
  assert.ok(old.items.some((d) => d.kind === 'stale' && d.path === SESSION_VERSION_FILE));

  const r = install(home, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).files.removed.includes(SESSION_VERSION_FILE));
  assert.equal(existsSync(join(home, ...SESSION_VERSION_FILE.split('/'))), false, 'the hook file is gone');
  assert.equal(readdirSync(join(home, 'pipeline', 'hooks')).includes('session-version.mjs'), false);
  assert.equal(Object.hasOwn(readManifest(home).files, SESSION_VERSION_FILE), false);
  const s = readSettings(home);
  assert.equal(JSON.stringify(s).includes('session-version'), false, 'no settings entry runs it');
  assert.deepEqual(s.hooks.PreToolUse, [...owner.hooks.PreToolUse, ...stackRegisters(home), guardGit(home), guardFiles(home)]);
  assert.deepEqual(s.hooks.SessionStart, owner.hooks.SessionStart, 'the owner\'s SessionStart hook is byte-identical');
  for (const event of ['PostToolUse', 'SessionEnd', 'UserPromptSubmit', 'Stop']) {
    assert.deepEqual(s.hooks[event].slice(0, owner.hooks[event].length), owner.hooks[event], `${event}: the owner's groups come first, untouched`);
  }
  assert.deepEqual({ ...s, hooks: undefined, permissions: undefined }, { ...owner, hooks: undefined, permissions: undefined }, 'every other key is untouched');
  assert.deepEqual(s.permissions.allow.slice(0, owner.permissions.allow.length), owner.permissions.allow);
  assert.deepEqual(driftOf(home), { status: 0, items: [] });

  const text = readFileSync(settingsPath(home), 'utf8');
  const files = readManifest(home).files;
  const again = install(home, ['--json']);
  assert.equal(again.status, 0, again.stderr);
  const report = JSON.parse(again.stdout);
  assert.equal(report.files.copied, 0);
  assert.equal(report.settings.changed, false);
  assert.deepEqual(report.retired, []);
  assert.equal(readFileSync(settingsPath(home), 'utf8'), text, 'a second update changes nothing');
  assert.deepEqual(readManifest(home).files, files);
});

test('update from the previous release into a settings.json whose only SessionStart hook was ours: the emptied SessionStart key is dropped', () => {
  const home = newHome();
  makeOldShape(home, {});
  assert.deepEqual(readSettings(home).hooks.SessionStart, [sessionVersion(home)]);
  assert.equal(install(home).status, 0);
  assert.equal('SessionStart' in readSettings(home).hooks, false);
  assert.deepEqual(driftOf(home), { status: 0, items: [] });
});

test('--uninstall from the previous release\'s shape leaves no pipeline files and puts the owner\'s settings back', () => {
  const home = newHome();
  const owner = ownersSettings();
  makeOldShape(home, owner);
  const r = install(home, ['--uninstall', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hooks.removed, 8, 'stack-register x2 (one on the old matcher), dev-bind, session-end, guard-git, guard-files, session-version, owner-go');
  assert.deepEqual(readSettings(home), owner);
  assert.deepEqual(listTree(home).filter((f) => !f.startsWith('backups/')), ['settings.json']);
});

test('an owner-edited session-version.mjs is kept: the old pipeline copy goes to backups/, the live file is gone', () => {
  const home = newHome();
  makeOldShape(home, ownersSettings());
  writeFileSync(join(home, ...SESSION_VERSION_FILE.split('/')), '// my tuned status hook\n');
  const r = install(home, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.editBackups.map((b) => b.rel), ['pipeline']);
  assert.equal(readFileSync(join(report.editBackups[0].backup, 'hooks', 'session-version.mjs'), 'utf8'), '// my tuned status hook\n');
  assert.equal(existsSync(join(home, ...SESSION_VERSION_FILE.split('/'))), false);
  assert.deepEqual(driftOf(home), { status: 0, items: [] });
});

test('mergeSettings drops a session-version handler of ours from a shared SessionStart group and does not write one back', () => {
  const home = '/h/.claude';
  const shared = { hooks: { SessionStart: [{ hooks: [
    { type: 'command', command: 'echo mine' },
    { type: 'command', command: 'node', args: ['/h/.claude/pipeline/hooks/session-version.mjs'], timeout: 10 },
  ] }] } };
  const merged = mergeSettings(shared, { home });
  assert.deepEqual(merged.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  assert.equal('SessionStart' in mergeSettings({}, { home }).hooks, false, 'a fresh install writes nothing to SessionStart');
  assert.deepEqual(removeOurSettings(mergeSettings({}, { home }), { home }), {});
  assert.throws(() => mergeSettings({ hooks: { SessionStart: {} } }, { home }), /hooks\.SessionStart" is not an array/);
  const own = { hooks: { SessionStart: [] } };
  assert.deepEqual(mergeSettings(own, { home }).hooks.SessionStart, [], 'an empty SessionStart the owner had stays');
});

test('buildPlan no longer asks for pipeline/hooks/session-version.mjs; the three stack hooks and the guards are still required', () => {
  assert.equal(buildPlan(FIXTURE).problems.length, 0);
  assert.equal(buildPlan(FIXTURE).files.has(SESSION_VERSION_FILE), false);
  const src = copyFixture();
  rmSync(join(src, 'pipeline', 'hooks', 'guard-git.mjs'));
  assert.ok(buildPlan(src).problems.includes('pipeline/hooks/guard-git.mjs is missing'));
});

test('RETIRED_HOOKS names session-version; no retired skill is a current skill; retiredSkillUnits never retires a current skill', () => {
  assert.ok(RETIRED_HOOKS.includes('session-version'));
  assert.ok(RETIRED_SKILLS.every((n) => !SKILLS.includes(n)));
  assert.deepEqual(retiredSkillUnits(['oldskill', 'verify', 'oldskill']).map((u) => u.rel), ['skills/oldskill']);
});

// The retired-unit mechanism, on a test-only retired skill (PIPELINE_INSTALL_RETIRED_SKILLS adds it to RETIRED_SKILLS for one run).
const RETIRED_ENV = { PIPELINE_INSTALL_RETIRED_SKILLS: 'oldskill' };
const OLD_SKILL = { 'SKILL.md': 'the old skill\n', 'ref/a.md': 'reference a\n' };
const oldSkillFile = (home, rel) => join(home, 'skills', 'oldskill', ...rel.split('/'));
// A current install plus skills/oldskill/, with its files listed in the manifest (what an install of the previous release left).
function makeOldSkill(home, files = OLD_SKILL) {
  assert.equal(install(home).status, 0);
  const manifest = readManifest(home);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(oldSkillFile(home, rel)), { recursive: true });
    writeFileSync(oldSkillFile(home, rel), text);
    manifest.files[`skills/oldskill/${rel}`] = sha(oldSkillFile(home, rel));
  }
  writeFileSync(join(home, 'pipeline', 'INSTALLED.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const retiredDrift = (home) => {
  const r = install(home, ['--check', '--json'], { env: RETIRED_ENV });
  return { status: r.status, items: JSON.parse(r.stdout).drift };
};

test('a retired skill: its listed files are removed and --check says so before; afterwards no drift, other skills untouched, a second update is a no-op', () => {
  const home = newHome();
  makeOldSkill(home);
  const before = retiredDrift(home);
  assert.equal(before.status, 1);
  assert.deepEqual(before.items.map((d) => [d.kind, d.path]), [['retired', 'skills/oldskill/SKILL.md'], ['retired', 'skills/oldskill/ref/a.md']]);

  const r = install(home, ['--json'], { env: RETIRED_ENV });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.retired, [{ rel: 'skills/oldskill', removed: ['skills/oldskill/SKILL.md', 'skills/oldskill/ref/a.md'], backedUp: [], backup: null, kept: [] }]);
  assert.equal(existsSync(join(home, 'skills', 'oldskill')), false, 'the emptied directory is gone too');
  assert.equal(existsSync(join(home, 'skills', 'verify', 'SKILL.md')), true);
  assert.equal(existsSync(join(home, 'backups')), false, 'nothing was edited, so nothing is backed up');
  assert.deepEqual(Object.keys(readManifest(home).files).filter((k) => k.startsWith('skills/oldskill/')), []);
  assert.deepEqual(retiredDrift(home), { status: 0, items: [] });

  const again = JSON.parse(install(home, ['--json'], { env: RETIRED_ENV }).stdout);
  assert.deepEqual(again.retired, []);
  assert.equal(again.files.copied, 0);
});

test('a retired skill with a file the owner modified: that file is saved under backups/<name>.<timestamp>/ (as an edited unit is) before it is removed, and reported', () => {
  const home = newHome();
  makeOldSkill(home);
  writeFileSync(oldSkillFile(home, 'SKILL.md'), 'my tuned old skill\n');
  assert.match(retiredDrift(home).items[0].message, /edited|saving your edits/);
  const r = install(home, [], { env: RETIRED_ENV });
  assert.equal(r.status, 0, r.stderr);
  const backups = readdirSync(join(home, 'backups'));
  const backup = backups.find((n) => /^oldskill\.\d{8}T\d{6}Z/.test(n));
  assert.ok(backup, backups.join(', '));
  assert.equal(readFileSync(join(home, 'backups', backup, 'SKILL.md'), 'utf8'), 'my tuned old skill\n');
  assert.equal(existsSync(join(home, 'backups', backup, 'ref', 'a.md')), false, 'an unmodified file is not backed up');
  assert.equal(existsSync(join(home, 'skills', 'oldskill')), false);
  assert.match(r.stdout, /retired skills\/oldskill\/: 2 files removed/);
  assert.match(r.stdout, /your edits in skills\/oldskill\/SKILL\.md were saved; the old copy is at .*oldskill\./);
  assert.deepEqual(retiredDrift(home), { status: 0, items: [] });
});

test('a file in a retired skill dir that the manifest does not list is kept and reported, never deleted; the update still ends with no drift and stays quiet afterwards', () => {
  const home = newHome();
  makeOldSkill(home);
  writeFileSync(oldSkillFile(home, 'mine.md'), 'my own notes\n');
  const r = install(home, ['--json'], { env: RETIRED_ENV });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.retired[0].kept, ['skills/oldskill/mine.md']);
  assert.deepEqual(report.retired[0].removed, ['skills/oldskill/SKILL.md', 'skills/oldskill/ref/a.md']);
  assert.equal(readFileSync(oldSkillFile(home, 'mine.md'), 'utf8'), 'my own notes\n');
  assert.equal(existsSync(oldSkillFile(home, 'SKILL.md')), false);
  assert.equal(existsSync(join(home, 'backups')), false, 'a kept file is not copied anywhere');
  assert.match(install(home, [], { env: RETIRED_ENV }).stdout, /files:\s+0 copied/);
  assert.deepEqual(retiredDrift(home), { status: 0, items: [] }, 'what the owner kept is not drift');
  assert.deepEqual(JSON.parse(install(home, ['--json'], { env: RETIRED_ENV }).stdout).retired, []);
  assert.equal(readFileSync(oldSkillFile(home, 'mine.md'), 'utf8'), 'my own notes\n');
});

test('the human report names what a retired skill kept', () => {
  const home = newHome();
  makeOldSkill(home);
  writeFileSync(oldSkillFile(home, 'mine.md'), 'my own notes\n');
  assert.match(install(home, [], { env: RETIRED_ENV }).stdout, /kept skills\/oldskill\/mine\.md: claude-pipeline did not install it/);
});

test('an update that dies in the middle of retiring a skill is completed by the next run', { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) }, () => {
  const home = newHome();
  makeOldSkill(home);
  writeFileSync(oldSkillFile(home, 'SKILL.md'), 'my tuned old skill\n');
  const refDir = dirname(oldSkillFile(home, 'ref/a.md'));
  chmodSync(refDir, 0o555); // SKILL.md goes first (code-unit order), then removing ref/a.md fails
  try {
    const failed = install(home, [], { env: RETIRED_ENV });
    assert.equal(failed.status, 1, failed.stdout);
    assert.equal(existsSync(oldSkillFile(home, 'SKILL.md')), false, 'the first file was already retired');
    assert.equal(existsSync(oldSkillFile(home, 'ref/a.md')), true);
    assert.equal(readManifest(home).complete, true, 'the pipeline unit was not touched: the manifest still lists everything');
    assert.ok(Object.hasOwn(readManifest(home).files, 'skills/oldskill/ref/a.md'));
  } finally { chmodSync(refDir, 0o755); }
  const r = install(home, ['--json'], { env: RETIRED_ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, 'skills', 'oldskill')), false);
  const backups = readdirSync(join(home, 'backups')).filter((n) => n.startsWith('oldskill.'));
  assert.equal(backups.length, 1, 'the edit was saved once, by the first run');
  assert.equal(readFileSync(join(home, 'backups', backups[0], 'SKILL.md'), 'utf8'), 'my tuned old skill\n');
  assert.deepEqual(retiredDrift(home), { status: 0, items: [] });
});

test('a retired skill dir that is a symlink, or that the manifest never listed, is not touched', { skip: process.platform === 'win32' }, () => {
  const home = newHome();
  makeOldSkill(home);
  const elsewhere = scratch('cp-elsewhere');
  writeFileSync(join(elsewhere, 'SKILL.md'), 'mine, elsewhere\n');
  rmSync(join(home, 'skills', 'oldskill'), { recursive: true });
  symlinkSync(elsewhere, join(home, 'skills', 'oldskill'), 'dir');
  const r = install(home, ['--json'], { env: RETIRED_ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).retired, [{ rel: 'skills/oldskill', removed: [], backedUp: [], backup: null, kept: ['skills/oldskill'] }]);
  assert.equal(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8'), 'mine, elsewhere\n');
  assert.equal(lstatSync(join(home, 'skills', 'oldskill')).isSymbolicLink(), true);

  const home2 = newHome();
  assert.equal(install(home2).status, 0);
  mkdirSync(join(home2, 'skills', 'oldskill'), { recursive: true });
  writeFileSync(join(home2, 'skills', 'oldskill', 'SKILL.md'), 'not ours\n');
  const r2 = install(home2, ['--json'], { env: RETIRED_ENV });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).retired, []);
  assert.equal(readFileSync(join(home2, 'skills', 'oldskill', 'SKILL.md'), 'utf8'), 'not ours\n');
});

test('the retired-skill seam only takes plain directory names', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const r = install(home, ['--json'], { env: { PIPELINE_INSTALL_RETIRED_SKILLS: '../pipeline,a/b,..' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).retired, []);
  assert.equal(existsSync(join(home, 'pipeline', 'bin', 'pipeline.mjs')), true);
});

test('buildPlan requires the three stack hook files', () => {
  for (const name of ['stack-register', 'stack-dev-bind', 'stack-session-end']) {
    const src = copyFixture();
    rmSync(join(src, 'pipeline', 'hooks', `${name}.mjs`));
    assert.ok(buildPlan(src).problems.includes(`pipeline/hooks/${name}.mjs is missing`), name);
  }
});

// ---- A4: honest sourceSha ---------------------------------------------------------------------------------------

function git(cwd, ...args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(k)) delete env[k];
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// A committed copy of the fixture; returns { dir, head }.
function committedSource({ attributes } = {}) {
  const dir = copyFixture();
  if (attributes) writeFileSync(join(dir, '.gitattributes'), attributes);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}
const installReport = (home, source) => JSON.parse(install(home, ['--json'], { source }).stdout);

test('a clean checkout records its HEAD sha and no sourceDirty flag', () => {
  const { dir, head } = committedSource();
  const home = newHome();
  const report = installReport(home, dir);
  assert.equal(report.sourceSha, head);
  assert.deepEqual(report.warnings, []);
  const m = readManifest(home);
  assert.equal(m.sourceSha, head);
  assert.equal('sourceDirty' in m, false);
});

test('an edited tracked file, an untracked file and an ignored extra each make sourceSha null with sourceDirty and a warning', () => {
  const edited = committedSource();
  writeFileSync(join(edited.dir, 'skills', 'ship', 'SKILL.md'), 'edited after the commit\n');
  const home1 = newHome();
  const r1 = installReport(home1, edited.dir);
  assert.equal(r1.sourceSha, null);
  assert.deepEqual(r1.warnings, [`source is not a clean checkout of ${edited.head.slice(0, 7)}: skills/ship/SKILL.md; recording no source sha`]);
  assert.equal(readManifest(home1).sourceSha, null);
  assert.equal(readManifest(home1).sourceDirty, true);

  const untracked = committedSource();
  writeFileSync(join(untracked.dir, 'pipeline', 'lib', 'extra.mjs'), '// not committed\n');
  const r2 = installReport(newHome(), untracked.dir);
  assert.equal(r2.sourceSha, null);
  assert.match(r2.warnings[0], /not a clean checkout of [0-9a-f]{7}: pipeline\/lib\/extra\.mjs; recording no source sha/);

  const ignored = committedSource();
  writeFileSync(join(ignored.dir, '.gitignore'), 'pipeline/lib/local-only.mjs\n');
  git(ignored.dir, 'add', '.gitignore');
  git(ignored.dir, 'commit', '-q', '-m', 'ignore');
  writeFileSync(join(ignored.dir, 'pipeline', 'lib', 'local-only.mjs'), '// ignored, but copied\n');
  const home3 = newHome();
  const r3 = installReport(home3, ignored.dir);
  assert.equal(r3.sourceSha, null, 'an ignored extra is copied into the install, so HEAD does not describe it');
  assert.equal(readManifest(home3).sourceDirty, true);
});

test('an installable file deleted from the working tree (but still in HEAD) leaves no source sha; excluded files do not count', () => {
  for (const gone of ['pipeline/lib/answer.mjs', 'skills/ship/reference/notes.md', 'agents/arbiter.md']) {
    const { dir, head } = committedSource();
    rmSync(join(dir, ...gone.split('/')));
    const home = newHome();
    const r = installReport(home, dir);
    assert.equal(r.sourceSha, null, gone);
    assert.deepEqual(r.warnings.filter((w) => w.includes('not a clean checkout')), [`source is not a clean checkout of ${head.slice(0, 7)}: ${gone}; recording no source sha`], gone);
    assert.equal(readManifest(home).sourceDirty, true, gone);
  }

  // HEAD holds files the installer never copies (pipeline/test/**, node_modules, a stray INSTALLED.json): deleting them is not a deletion of source.
  const dir = copyFixture();
  for (const f of ['pipeline/test/t.mjs', 'pipeline/node_modules/m/i.js', 'pipeline/INSTALLED.json', 'skills/ship/test/t.md']) {
    mkdirSync(dirname(join(dir, ...f.split('/'))), { recursive: true });
    writeFileSync(join(dir, ...f.split('/')), 'x\n');
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const f of ['pipeline/test', 'pipeline/node_modules', 'pipeline/INSTALLED.json', 'skills/ship/test']) rmSync(join(dir, ...f.split('/')), { recursive: true });
  assert.equal(installReport(newHome(), dir).sourceSha, head);
});

test('only the first three differing paths are named', () => {
  const { dir } = committedSource();
  for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(dir, 'pipeline', 'lib', `${n}.mjs`), '//\n');
  const r = installReport(newHome(), dir);
  assert.match(r.warnings[0], /: pipeline\/lib\/a\.mjs, pipeline\/lib\/b\.mjs, pipeline\/lib\/c\.mjs; recording/);
});

test('a source that is not a git checkout records sourceSha null without a dirty flag or warning', () => {
  const dir = join(scratch('cp-nogit'), 'src');
  cpSync(FIXTURE, dir, { recursive: true });
  const home = newHome();
  const report = installReport(home, dir);
  // scratch dirs live under the OS temp dir, outside any repo
  assert.equal(report.sourceSha, null);
  assert.deepEqual(report.warnings, []);
  assert.equal('sourceDirty' in readManifest(home), false);
});

test('line-ending filters do not make a clean checkout look edited (hash-object applies .gitattributes)', () => {
  const { dir, head } = committedSource({ attributes: '*.md text\n' });
  const file = join(dir, 'agents', 'judge.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n')); // what a Windows checkout with eol=crlf holds
  const report = installReport(newHome(), dir);
  assert.equal(report.sourceSha, head);
  assert.deepEqual(report.warnings, []);
});

test('a source that is a subdirectory of a repo is compared by its own paths', () => {
  const outer = scratch('cp-outer');
  const dir = join(outer, 'vendor', 'src');
  cpSync(FIXTURE, dir, { recursive: true });
  git(outer, 'init', '-q');
  git(outer, 'add', '-A');
  git(outer, 'commit', '-q', '-m', 'x');
  const head = git(outer, 'rev-parse', 'HEAD');
  assert.equal(installReport(newHome(), dir).sourceSha, head);
  writeFileSync(join(dir, 'VERSION'), '9.9.8\n');
  assert.equal(installReport(newHome(), dir).sourceSha, null);
});

// ---- A5: one write lock -----------------------------------------------------------------------------------------

const MACHINE = 'test-machine-id';
function lockEnv() {
  const dir = scratch('cp-locks');
  return { dir, env: { PIPELINE_LOCK_DIR: dir, PIPELINE_MACHINE_ID: MACHINE } };
}
const holdLock = (home, dir, extra = {}) => {
  const got = tryAcquire(installLockName(home), { dir, machineId: MACHINE, ...extra });
  assert.equal(got.acquired, true);
  return got.lock;
};

test('the lock name is scoped to the resolved claude-home: same home same name, another home another name, always a safe file name', () => {
  const a = newHome();
  const b = newHome();
  assert.equal(installLockName(a), installLockName(join(a, '..', 'claude')));
  assert.notEqual(installLockName(a), installLockName(b));
  assert.match(installLockName(newHome({ space: true })), /^installer-[0-9a-f]{16}$/);
});

test('the lock is scoped to the canonical destination: a symlinked alias names the same lock and a busy install through it is refused', { skip: process.platform === 'win32' }, () => {
  const real = newHome();
  mkdirSync(real, { recursive: true });
  const alias = join(scratch('cp-alias'), 'link');
  symlinkSync(real, alias, 'dir');
  assert.equal(installLockName(alias), installLockName(real));
  // not created yet, reached through an alias of its parent
  const parentLink = join(scratch('cp-alias2'), 'plink');
  symlinkSync(dirname(real), parentLink, 'dir');
  assert.equal(installLockName(join(parentLink, 'claude')), installLockName(real));

  // No PIPELINE_LOCK_DIR: the default lock directory is inside the destination, not in the caller's ~/.claude.
  const env = { PIPELINE_MACHINE_ID: MACHINE };
  const locks = join(real, 'backups', '.locks');
  const lock = holdLock(real, locks);
  try {
    const busy = install(alias, [], { env });
    assert.equal(busy.status, 1, busy.stderr);
    assert.match(busy.stderr, /another install is running in /);
    assert.equal(existsSync(join(real, 'pipeline')), false, 'nothing was written');
    assert.equal(existsSync(join(busy.userHome, '.claude')), false, 'the caller\'s ~/.claude was not used for the lock');
  } finally {
    release(lock);
  }
  assert.equal(install(alias, [], { env }).status, 0);
});

test('install and uninstall refuse while another install holds the lock for that home (exit 1, nothing written); --check ignores it', () => {
  const home = newHome();
  const { dir, env } = lockEnv();
  assert.equal(install(home, [], { env }).status, 0);
  const manifestBefore = readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8');
  const lock = holdLock(home, dir);
  try {
    writeFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'edited while locked\n');
    const busy = install(home, [], { env });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /another install is running in /);
    assert.ok(busy.stderr.includes(home), busy.stderr);
    assert.equal(readFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'utf8'), 'edited while locked\n', 'nothing was repaired');
    assert.equal(readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8'), manifestBefore);

    const busyUninstall = install(home, ['--uninstall'], { env });
    assert.equal(busyUninstall.status, 1);
    assert.match(busyUninstall.stderr, /another install is running in /);
    assert.ok(existsSync(join(home, 'pipeline')), 'nothing was removed');

    const json = install(home, ['--json'], { env });
    assert.equal(json.status, 1);
    assert.match(JSON.parse(json.stdout).error, /another install is running in /);

    const check = install(home, ['--check'], { env });
    assert.equal(check.status, 1, 'drift (the edit), not a lock error');
    assert.match(check.stdout, /modified: skills\/ship\/SKILL\.md/);

    const other = newHome();
    assert.equal(install(other, [], { env }).status, 0, 'a different claude-home has its own lock');
  } finally {
    release(lock);
  }
  assert.equal(install(home, [], { env }).status, 0);
  assert.equal(readFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'utf8'), readFileSync(join(FIXTURE, 'skills', 'ship', 'SKILL.md'), 'utf8'));
});

test('a lock left by a dead process is reclaimed; the lock is released after install, uninstall and a failed install', () => {
  const home = newHome();
  const { dir, env } = lockEnv();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  holdLock(home, dir, { pid: dead });
  assert.equal(install(home, [], { env }).status, 0, 'owner pid is gone: reclaimed');
  assert.equal(inspect(installLockName(home), { dir }), null, 'released after install');

  assert.equal(install(home, ['--uninstall'], { env }).status, 0);
  assert.equal(inspect(installLockName(home), { dir }), null, 'released after uninstall');

  const broken = newHome();
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'agents'), 'a file where the agents/ dir has to go\n');
  assert.equal(install(broken, [], { env }).status, 1);
  assert.equal(inspect(installLockName(broken), { dir }), null, 'released after a failed install');
});

// ---- a source inside the claude-home ------------------------------------------------------------------------------

test('a source inside the claude-home is refused, except under pipeline-state/tmp (where `pipeline update` downloads)', () => {
  const home = newHome();
  const inside = join(home, 'skills-copy');
  cpSync(FIXTURE, inside, { recursive: true });
  const refused = install(home, [], { source: inside });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /is inside the claude-home/);
  assert.equal(existsSync(join(home, 'pipeline')), false, 'nothing was installed');

  const tmpSrc = join(home, 'pipeline-state', 'tmp', 'claude-pipeline-update-abc123', 'src');
  cpSync(FIXTURE, tmpSrc, { recursive: true });
  const ok = install(home, [], { source: tmpSrc });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(existsSync(join(home, 'pipeline', 'INSTALLED.json')), true);
  assert.equal(existsSync(tmpSrc), true, 'the installer did not touch the source');
});

// ---- the stack-stop hooks (Task 13) -------------------------------------------------------------------------------

const ourEntries = (groups, home) => (groups ?? []).filter((g) => g.hooks?.some((h) => isOurHandler(h, home)));
const driftOf = (home, source = FIXTURE) => {
  const r = install(home, ['--check', '--json'], { source });
  return { status: r.status, items: JSON.parse(r.stdout).drift ?? [] };
};

test('constants and ourStackGroups: stack-register per matcher through the fail-closed loader (30 s), dev-bind and session-end plain (10 s)', () => {
  assert.deepEqual([...STACK_REGISTER_MATCHERS], ['Bash', 'Edit|Write|MultiEdit|NotebookEdit']);
  assert.equal(STACK_REGISTER_TIMEOUT_S, 30);
  assert.equal(STACK_HOOK_TIMEOUT_S, 10);
  const g = ourStackGroups('/h/.claude');
  assert.deepEqual(g.PreToolUse, stackRegisters('/h/.claude'));
  assert.deepEqual(g.PostToolUse, [stackDevBind('/h/.claude')]);
  assert.deepEqual(g.SessionEnd, [stackSessionEnd('/h/.claude')]);
  assert.equal(g.PreToolUse[0].hooks[0].args[2], HOOK_LOADER);
  assert.equal(g.PostToolUse[0].hooks[0].args.length, 1, 'plain handler: no loader');
});

test('fresh install adds exactly one stack-register group per matcher, one PostToolUse and one SessionEnd group, guard-files stays last', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const s = readSettings(home);
  assert.deepEqual(ourEntries(s.hooks.PreToolUse, home), [...stackRegisters(home), guardGit(home), guardFiles(home)]);
  assert.equal(s.hooks.PreToolUse.at(-1).matcher, GUARD_FILES_MATCHER, 'guard-files is the last PreToolUse entry');
  assert.deepEqual(s.hooks.PostToolUse, [stackDevBind(home)]);
  assert.deepEqual(s.hooks.SessionEnd, [stackSessionEnd(home)]);
  const found = inspectHooks(s, home);
  assert.equal(found['stack-register'].length, 2);
  assert.ok(found['stack-register'].every((e) => e.exact));
  assert.deepEqual(found['stack-register'].map((e) => e.matcher), [...STACK_REGISTER_MATCHERS]);
  assert.ok(found['stack-dev-bind'].length === 1 && found['stack-dev-bind'][0].exact);
  assert.ok(found['stack-session-end'].length === 1 && found['stack-session-end'][0].exact);
  assert.deepEqual(found.unknown, []);
});

test('the owner\'s foreign PostToolUse and SessionEnd entries (tab-event.sh, heartbeat.mjs) survive install, a no-op reinstall and uninstall', () => {
  const home = newHome();
  const before = ownersSettings();
  const tab = before.hooks.PostToolUse[1];
  const heartbeat = before.hooks.SessionEnd[0];
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  const afterInstall = readFileSync(settingsPath(home), 'utf8');
  const s = JSON.parse(afterInstall);
  assert.deepEqual(s.hooks.PostToolUse, [...before.hooks.PostToolUse, stackDevBind(home)]);
  assert.deepEqual(s.hooks.SessionEnd, [heartbeat, stackSessionEnd(home)]);
  assert.deepEqual(s.hooks.PostToolUse[1], tab);

  const again = install(home, ['--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).settings.changed, false, 'reinstall changes nothing');
  assert.equal(readFileSync(settingsPath(home), 'utf8'), afterInstall, 'byte-identical settings after a reinstall');

  assert.equal(install(home, ['--uninstall']).status, 0);
  assert.deepEqual(readSettings(home), before, 'the owner\'s settings are back exactly, foreign entries in place');
});

test('a foreign hook sharing a group with ours on PostToolUse / SessionEnd survives; only ours is lifted out', () => {
  const home = newHome();
  const before = { hooks: {
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: 'node', args: [join(home, 'pipeline', 'hooks', 'stack-dev-bind.mjs')], timeout: 3 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }, { type: 'command', command: 'node', args: [join(home, 'pipeline', 'hooks', 'stack-session-end.mjs')] }] }],
  } };
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  const s = readSettings(home);
  assert.deepEqual(s.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }, stackDevBind(home)]);
  assert.deepEqual(s.hooks.SessionEnd, [{ hooks: [{ type: 'command', command: 'echo bye' }] }, stackSessionEnd(home)]);
  assert.equal(driftOf(home).status, 0);
  assert.equal(install(home, ['--uninstall']).status, 0);
  assert.deepEqual(readSettings(home), { hooks: {
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
  } });
});

test('--check: no drift after install; removing the SessionEnd entry by hand is drift (hook-missing, named), reinstall repairs it', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const clean = driftOf(home);
  assert.equal(clean.status, 0, JSON.stringify(clean.items));
  assert.deepEqual(clean.items, []);

  const s = readSettings(home);
  delete s.hooks.SessionEnd;
  writeSettings(home, s);
  const d = driftOf(home);
  assert.equal(d.status, 1);
  assert.deepEqual(d.items.map((i) => [i.kind, i.path]), [['hook-missing', 'stack-session-end']]);
  assert.match(d.items[0].message, /stack-session-end is not in hooks\.SessionEnd/);
  const text = install(home, ['--check']).stdout;
  assert.match(text, /hook missing: stack-session-end/);
  assert.equal(install(home).status, 0);
  assert.equal(driftOf(home).status, 0);
});

test('--check: a missing, duplicated or edited stack-dev-bind is reported; so is one under the wrong event', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const base = readSettings(home);

  const gone = structuredClone(base);
  delete gone.hooks.PostToolUse;
  writeSettings(home, gone);
  assert.deepEqual(driftOf(home).items.map((i) => [i.kind, i.path]), [['hook-missing', 'stack-dev-bind']]);

  const dup = structuredClone(base);
  dup.hooks.PostToolUse.push(stackDevBind(home));
  writeSettings(home, dup);
  assert.deepEqual(driftOf(home).items.map((i) => [i.kind, i.path]), [['hook-duplicated', 'stack-dev-bind']]);

  const edited = structuredClone(base);
  edited.hooks.PostToolUse[0].hooks[0].timeout = 99;
  writeSettings(home, edited);
  assert.deepEqual(driftOf(home).items.map((i) => [i.kind, i.path]), [['hook-differs', 'stack-dev-bind']]);

  const wrongMatcher = structuredClone(base);
  wrongMatcher.hooks.PostToolUse[0].matcher = 'Edit';
  writeSettings(home, wrongMatcher);
  assert.deepEqual(driftOf(home).items.map((i) => [i.kind, i.path]), [['hook-differs', 'stack-dev-bind']]);

  const wrongEvent = structuredClone(base);
  wrongEvent.hooks.Stop = wrongEvent.hooks.PostToolUse;
  delete wrongEvent.hooks.PostToolUse;
  writeSettings(home, wrongEvent);
  assert.equal(driftOf(home).status, 1);
});

test('--check checks stack-register once PER MATCHER: removing one matcher\'s entry by hand is hook-missing naming that matcher', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const base = readSettings(home);
  for (const matcher of STACK_REGISTER_MATCHERS) {
    const s = structuredClone(base);
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !(g.matcher === matcher && g.hooks.some((h) => String(h.args?.at(-1)).endsWith('stack-register.mjs'))));
    writeSettings(home, s);
    const d = driftOf(home);
    assert.equal(d.status, 1);
    const missing = d.items.filter((i) => i.kind === 'hook-missing');
    assert.equal(missing.length, 1, JSON.stringify(d.items));
    assert.ok(missing[0].message.includes(matcher), missing[0].message);
    assert.match(missing[0].message, /stack-register/);
    assert.equal(d.items.length, 1, 'only the removed matcher is reported');
    assert.equal(install(home).status, 0, 'reinstall repairs it');
    assert.equal(driftOf(home).status, 0);
  }
});

test('--check: a duplicated, edited or wrongly matched stack-register entry is reported; a late stack-register after guard-files is an order drift', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const base = readSettings(home);

  const dup = structuredClone(base);
  dup.hooks.PreToolUse.splice(2, 0, stackRegisters(home)[0]);
  writeSettings(home, dup);
  assert.ok(driftOf(home).items.some((i) => i.kind === 'hook-duplicated' && /stack-register \(Bash\)/.test(i.path)));

  const edited = structuredClone(base);
  edited.hooks.PreToolUse[1].hooks[0].timeout = 5;
  writeSettings(home, edited);
  assert.ok(driftOf(home).items.some((i) => i.kind === 'hook-differs' && /stack-register \(Edit/.test(i.path)));

  const plainArgs = structuredClone(base);
  plainArgs.hooks.PreToolUse[0].hooks[0].args = [joinNative(home, 'pipeline', 'hooks', 'stack-register.mjs')];
  writeSettings(home, plainArgs);
  assert.ok(driftOf(home).items.some((i) => i.kind === 'hook-differs' && /stack-register \(Bash\)/.test(i.path)), 'not the fail-closed loader');

  const odd = structuredClone(base);
  odd.hooks.PreToolUse[0].matcher = 'Bash|Edit';
  writeSettings(home, odd);
  const items = driftOf(home).items;
  assert.ok(items.some((i) => i.kind === 'hook-missing' && /stack-register \(Bash\)/.test(i.path)));
  assert.ok(items.some((i) => i.kind === 'hook-differs' && i.path === 'stack-register'), JSON.stringify(items));

  const late = structuredClone(base);
  late.hooks.PreToolUse.push(late.hooks.PreToolUse.shift());
  writeSettings(home, late);
  assert.ok(driftOf(home).items.some((i) => i.kind === 'hook-order'), 'guard-files must stay last, our order is fixed');
  assert.equal(install(home).status, 0);
  assert.equal(readSettings(home).hooks.PreToolUse.at(-1).matcher, GUARD_FILES_MATCHER);
  assert.equal(driftOf(home).status, 0);
});

test('an install from before the stack hooks existed reports the stack hooks missing (two stack-register matchers, dev-bind, session-end), then a reinstall adds them and keeps the rest', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const s = readSettings(home);
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !g.hooks.some((h) => /stack-/.test(String(h.args?.at(-1)))));
  delete s.hooks.PostToolUse;
  delete s.hooks.SessionEnd;
  writeSettings(home, s);
  const d = driftOf(home);
  assert.equal(d.status, 1);
  assert.deepEqual(d.items.map((i) => i.kind), ['hook-missing', 'hook-missing', 'hook-missing', 'hook-missing']);
  assert.equal(install(home).status, 0);
  assert.equal(driftOf(home).status, 0);
});

test('--uninstall removes our three stack hooks, drops the PostToolUse / SessionEnd keys it emptied, keeps foreign SessionEnd entries, and counts the hooks', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const r = install(home, ['--uninstall', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hooks.removed, 7, 'stack-register x2, dev-bind, session-end, guard-git, guard-files, owner-go');
  assert.equal(existsSync(settingsPath(home)) ? JSON.stringify(readSettings(home)) : '{}', '{}');

  const home2 = newHome();
  const before = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node ~/hb.mjs' }] }] } };
  writeSettings(home2, before);
  assert.equal(install(home2).status, 0);
  assert.equal(install(home2, ['--uninstall']).status, 0);
  assert.deepEqual(readSettings(home2), before, 'the foreign SessionEnd entry stays; ours is gone');
});

test('removeOurSettings drops an event key only when it emptied it; an empty array the owner already had stays', () => {
  const home = '/h/.claude';
  const merged = mergeSettings({ hooks: { Stop: [], PostToolUse: [] } }, { home });
  const out = removeOurSettings(merged, { home });
  assert.deepEqual(out, { hooks: { Stop: [] } }, 'PostToolUse is dropped (we emptied it), the owner\'s empty Stop stays');
  const untouched = { hooks: { PostToolUse: [], PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo x' }] }] } };
  assert.deepEqual(removeOurSettings(untouched, { home }), untouched, 'nothing of ours: nothing changes');
  const withOurs = mergeSettings({ hooks: { PostToolUse: [] } }, { home });
  assert.equal('PostToolUse' in removeOurSettings(withOurs, { home }), false);
});

test('mergeSettings rejects a wrongly shaped PostToolUse / SessionEnd instead of guessing', () => {
  assert.throws(() => mergeSettings({ hooks: { PostToolUse: {} } }, { home: '/h' }), /hooks\.PostToolUse" is not an array/);
  assert.throws(() => mergeSettings({ hooks: { SessionEnd: 'x' } }, { home: '/h' }), /hooks\.SessionEnd" is not an array/);
});

test('the human report names the stack hooks on install and the stack-stop pause on uninstall', () => {
  const home = newHome();
  const r = install(home);
  assert.match(r.stdout, /stack-stop yes \(stack-register PreToolUse, stack-dev-bind PostToolUse, stack-session-end SessionEnd\)/);
  const u = install(home, ['--uninstall']);
  assert.equal(u.status, 0);
  assert.doesNotMatch(u.stdout, /stacks:/, 'no stacks state in a scratch home: nothing paused, nothing reported');
});

// ---- uninstall extras: pause, wait for workers (isolated stacks root; the real ~/.claude is never touched) ---------------------

function isolatedStacks() {
  const root = join(scratch('cp-stacks'), 'root');
  mkdirSync(join(root, 'workers'), { recursive: true });
  return { root, env: { PIPELINE_STACKS_HOME: root, PIPELINE_STACKS_ONLY: 'install-test' } };
}

test('uninstall pauses an existing stacks root, leaves everything in it alone and creates nothing when the root is absent', () => {
  const home = newHome();
  const { root, env } = isolatedStacks();
  for (const f of ['config.json', 'mode.json', 'ledger.jsonl', 'actions.jsonl']) writeFileSync(join(root, f), `${f}\n`);
  const before = listTree(root);
  assert.equal(install(home).status, 0);
  const r = install(home, ['--uninstall', '--json'], { env });
  assert.equal(r.status, 0, r.stderr);
  const windows = process.platform === 'win32'; // stack-stop is not supported on Windows: uninstall must leave the stacks root exactly as it was
  assert.equal(existsSync(join(root, 'pause')), !windows, windows ? 'win32: no pause file, the root is untouched' : 'pause file touched');
  assert.deepEqual(listTree(root), windows ? before : [...before, 'pause'].sort(), 'nothing else in the stacks root changed');
  for (const f of ['config.json', 'mode.json', 'ledger.jsonl', 'actions.jsonl']) assert.equal(readFileSync(join(root, f), 'utf8'), `${f}\n`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.stacks.paused, !windows);
  assert.deepEqual(j.stacks.workersSurvived, []);

  const home2 = newHome();
  const absent = join(scratch('cp-stacks'), 'never-made');
  assert.equal(install(home2).status, 0);
  assert.equal(install(home2, ['--uninstall'], { env: { PIPELINE_STACKS_HOME: absent, PIPELINE_STACKS_ONLY: 'install-test' } }).status, 0);
  assert.equal(existsSync(absent), false, 'a missing stacks root is not created');
});

test('without PIPELINE_STACKS_HOME the stacks root is the one of the home being uninstalled, never the real ~/.claude', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const root = join(home, 'pipeline-state', 'stacks');
  mkdirSync(root, { recursive: true });
  const r = install(home, ['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  if (process.platform === 'win32') { // stack-stop is not supported on Windows: nothing is paused, nothing is written
    assert.equal(existsSync(join(root, 'pause')), false);
    assert.doesNotMatch(r.stdout, /stacks:\s+paused/);
    return;
  }
  assert.equal(existsSync(join(root, 'pause')), true);
  assert.match(r.stdout, /stacks:\s+paused/);
});

test('uninstall with a live worker waits, then reports the survivor by pid and still finishes (exit 0, pause in place)', { skip: process.platform === 'win32' }, async () => {
  const home = newHome();
  const { root, env } = isolatedStacks();
  assert.equal(install(home).status, 0);
  const { spawn } = await import('node:child_process');
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    writeFileSync(join(root, 'workers', `${worker.pid}.json`), JSON.stringify({ pid: worker.pid, phase: 'waiting' }));
    const started = Date.now();
    const r = install(home, ['--uninstall', '--json'], { env: { ...env, PIPELINE_INSTALL_WORKER_WAIT_MS: '1500' } });
    const took = Date.now() - started;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(took >= 1400, `waited for the worker (${took} ms)`);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.stacks.workersSurvived, [worker.pid]);
    assert.ok(j.warnings.some((w) => w.includes(`pid ${worker.pid}`) && /still running/.test(w)), JSON.stringify(j.warnings));
    assert.equal(existsSync(join(root, 'pause')), true);
    assert.equal(existsSync(join(home, 'pipeline')), false, 'files are still removed');
    assert.equal(existsSync(join(root, 'workers', `${worker.pid}.json`)), true, 'the worker file is not ours to delete');
  } finally {
    worker.kill('SIGKILL');
  }
});

// ---- the CI round-trip script (it is CI-only because install.mjs refuses a Claude Code session; here it runs with the tests' scrubbed env) ----

test('.github/scripts/installer-round-trip.sh passes on a scratch home and asserts the three stack hooks appear and vanish', { skip: process.platform === 'win32' || spawnSync('bash', ['-c', 'true']).status !== 0 }, () => {
  const home = newHome({ space: true });
  const r = run([home], { script: join(REPO, '.github', 'scripts', 'installer-round-trip.sh'), command: 'bash', cwd: REPO });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/stack hooks present: /g) ?? []).length, 2, 'asserted after install and after the idempotent reinstall');
  assert.match(r.stdout, /stack hooks absent: /);
  assert.match(r.stdout, /clean: no pipeline files or settings entries remain/);
  assert.equal(existsSync(home) ? readdirSync(home).includes('pipeline') : false, false);
});

test('the round-trip script fails when a stack hook stays registered after uninstall (the assertion bites)', { skip: process.platform === 'win32' || spawnSync('bash', ['-c', 'true']).status !== 0 }, () => {
  // Runs the script's own stack_hooks function (cut out of the file) against a real install, in both modes.
  const home = newHome();
  assert.equal(install(home).status, 0);
  const script = readFileSync(join(REPO, '.github', 'scripts', 'installer-round-trip.sh'), 'utf8');
  const fnEnd = script.indexOf('\nstep "install"');
  const wrapper = join(scratch('cp-rt'), 'check.sh');
  writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail\nhome_dir="$1"\n${script.slice(script.indexOf('stack_hooks() {'), fnEnd)}\nstack_hooks "$2"\n`);
  const present = run([home, 'present'], { script: wrapper, command: 'bash', cwd: REPO });
  assert.equal(present.status, 0, present.stdout + present.stderr);
  const absent = run([home, 'absent'], { script: wrapper, command: 'bash', cwd: REPO });
  assert.equal(absent.status, 1, 'hooks are still installed, so "absent" must fail');
  assert.match(absent.stderr, /stack-register is still in settings\.json hooks\.PreToolUse/);
  assert.match(absent.stderr, /stack-session-end is still in settings\.json hooks\.SessionEnd/);
  assert.equal(install(home, ['--uninstall']).status, 0);
  assert.equal(run([home, 'absent'], { script: wrapper, command: 'bash', cwd: REPO }).status, 0);
  const missing = run([home, 'present'], { script: wrapper, command: 'bash', cwd: REPO });
  assert.equal(missing.status, 1, 'and "present" fails once they are gone');
  assert.match(missing.stderr, /stack-dev-bind \(PostToolUse, matcher Bash\): 0 entries, expected 1/);
});
