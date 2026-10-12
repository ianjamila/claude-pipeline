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
import {
  mergeSettings, removeOurSettings, isOurHandler, ourAllowEntries, renameWithRetry, collectDiagnostics,
  shellRcPaths, parseArgs, buildPlan, walkFiles, safeManifestKey, GUARD_FILES_MATCHER, GUARD_GIT_MATCHER, HOOK_LOADER,
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
function run(args, { env = {}, script = INSTALL, command = process.execPath, lead = [], psTable } = {}) {
  const userHome = scratch('cp-userhome');
  const childEnv = { ...process.env, HOME: userHome, USERPROFILE: userHome, PIPELINE_INSTALL_NO_PROBES: '1' };
  for (const k of ['CLAUDECODE', 'PIPELINE_ADMIN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'FAKE_PS_TABLE', 'FAKE_PS_FAIL']) delete childEnv[k];
  if (FAKE_PS_DIR) {
    childEnv.PATH = `${FAKE_PS_DIR}${delimiter}${childEnv.PATH ?? process.env.PATH}`;
    if (psTable) childEnv.FAKE_PS_TABLE = JSON.stringify(psTable);
  }
  Object.assign(childEnv, env);
  const r = spawnSync(command, [...lead, script, ...args], { encoding: 'utf8', env: childEnv, timeout: 60000 });
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
// The SessionStart status hook (A3): plain, not the fail-closed loader, in its own group without a matcher.
const sessionVersion = (home) => ({
  hooks: [{ type: 'command', command: 'node', args: [join(home, 'pipeline', 'hooks', 'session-version.mjs')], timeout: 10 }],
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
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
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
    'agents/implementer.md', 'agents/verifier.md', 'agents/judge.md', 'agents/arbiter.md',
    'pipeline/bin/pipeline.mjs', 'pipeline/hooks/guard-git.mjs', 'pipeline/hooks/guard-files.mjs',
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
  assert.deepEqual(s.hooks.PreToolUse, [guardGit(home), guardFiles(home)]);
  assert.deepEqual(s.hooks.SessionStart, [sessionVersion(home)]);
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
  expected.hooks.PreToolUse.push(guardGit(home), guardFiles(home));
  expected.hooks.SessionStart.push(sessionVersion(home));
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
  assert.equal(s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => isOurHandler(h, home))).length, 2);
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
  assert.deepEqual(s.hooks.PreToolUse.slice(1), [guardGit(home)]);
  assert.deepEqual(readManifest(home).hooks, { guardGit: true, guardFiles: false });

  assert.equal(install(home).status, 0);
  s = readSettings(home);
  assert.deepEqual(s.hooks.PreToolUse, [...before.hooks.PreToolUse, guardGit(home), guardFiles(home)]);
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
  expected.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }, guardGit(home), guardFiles(home));
  expected.hooks.SessionStart.push(sessionVersion(home));
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
  assert.match(j.diagnostics.note, /Pinned agent models \(judge=opus, arbiter=fable\) still win over this env var/);
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
  assert.equal(out.hooks.PreToolUse.length, input.hooks.PreToolUse.length + 2);
});

test('mergeSettings on an empty object builds the minimal structure; skipFileGuard omits guard-files', () => {
  const full = mergeSettings({}, { home: '/h/.claude' });
  assert.equal(full.hooks.PreToolUse.length, 2);
  assert.equal(full.hooks.PreToolUse[1].matcher, GUARD_FILES_MATCHER);
  assert.deepEqual(full.permissions.allow, ['Bash(node /h/.claude/pipeline/bin/pipeline.mjs:*)', 'Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)']);
  const partial = mergeSettings({}, { home: '/h/.claude', skipFileGuard: true });
  assert.equal(partial.hooks.PreToolUse.length, 1);
  assert.equal(partial.hooks.PreToolUse[0].matcher, 'Bash|PowerShell|Monitor|mcp__.*');
});

test('mergeSettings writes native Windows paths in args and a posix path in the allow entry', () => {
  const home = 'C:\\Users\\Jo Smith\\.claude';
  const out = mergeSettings({}, { home });
  assert.deepEqual(out.hooks.PreToolUse[0].hooks[0].args, ['--input-type=module', '-e', HOOK_LOADER, 'C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\guard-git.mjs']);
  assert.deepEqual(out.hooks.PreToolUse[1].hooks[0].args, ['--input-type=module', '-e', HOOK_LOADER, 'C:\\Users\\Jo Smith\\.claude\\pipeline\\hooks\\guard-files.mjs']);
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

test('mergeSettings drops a group left empty but keeps a group with other handlers; non-PreToolUse hooks are never touched', () => {
  const input = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /a/.claude/pipeline/hooks/guard-git.mjs' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: 'node /a/.claude/pipeline/hooks/guard-files.mjs' }] },
        { matcher: 'Read', hooks: [] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'node /a/.claude/pipeline/hooks/guard-git.mjs' }] }],
    },
  };
  const out = mergeSettings(input, { home: '/h/.claude' });
  assert.deepEqual(out.hooks.PreToolUse.slice(0, 2), [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
    { matcher: 'Read', hooks: [] },
  ]);
  assert.deepEqual(out.hooks.PostToolUse, input.hooks.PostToolUse);
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
    'pipeline', 'agents/implementer.md', 'agents/verifier.md', 'agents/judge.md', 'agents/arbiter.md',
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
  assert.match(d.note, /Pinned agent models \(judge=opus, arbiter=fable\) still win over this env var — verified on Claude Code 2\.1\.285; unpinned subagents use it\./);
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
  assert.deepEqual(out.hooks.PreToolUse.map((g) => g.matcher), ['Bash|PowerShell|Monitor|mcp__.*', GUARD_FILES_MATCHER]);
  const skip = mergeSettings({}, { home: '/h/.claude', skipFileGuard: true });
  assert.deepEqual(skip.hooks.PreToolUse.map((g) => g.matcher), ['Bash|PowerShell|Monitor|mcp__.*']);

  // --check treats the old Bash-only matcher as drift (the hook would never fire on PowerShell)
  const home = newHome();
  assert.equal(install(home).status, 0);
  assert.equal(run(['--check', '--claude-home', home, '--source', FIXTURE]).status, 0);
  const s = readSettings(home);
  s.hooks.PreToolUse[0].matcher = 'Bash';
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
  assert.deepEqual(readSettings(home).hooks.PreToolUse, [userGroup, userGroup2, guardGit(home), guardFiles(home)]);
  assert.equal(install(home).status, 0);
  assert.equal(readSettings(home).hooks.PreToolUse.length, 4, 'a second install does not add or drop anything');
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
  assert.deepEqual(ours, [guardGit(home), guardFiles(home)], 'the old entry was replaced, not duplicated');

  // restore the old shape and see --check call it out
  after.hooks.PreToolUse = after.hooks.PreToolUse.map((g) => (g.hooks.some((h) => String(h.args?.at(-1)).endsWith('guard-git.mjs'))
    ? { ...g, hooks: [{ type: 'command', command: 'node', args: [join(home, 'pipeline', 'hooks', 'guard-git.mjs')], timeout: 15 }] } : g));
  writeSettings(home, after);
  const check = install(home, ['--check', '--json']);
  assert.equal(check.status, 1);
  assert.ok(JSON.parse(check.stdout).drift.some((d) => d.kind === 'hook-differs' && d.path === 'guard-git'), check.stdout);
});

// ---- A3: SessionStart status hook -------------------------------------------------------------------------------

test('install appends the session-version group after the owner\'s SessionStart groups, once, and touches none of theirs', () => {
  const home = newHome();
  const before = ownersSettings();
  before.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: 'node ~/memory-sync.js' }] });
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  assert.equal(install(home).status, 0);
  const s = readSettings(home);
  assert.deepEqual(s.hooks.SessionStart, [...before.hooks.SessionStart, sessionVersion(home)]);
  assert.equal(install(home, ['--check']).status, 0, 'a clean install has no drift');
});

test('--check: a later SessionStart entry after ours is fine; a missing, duplicated or edited session-version hook is reported', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const drift = () => { const r = install(home, ['--check', '--json']); return { status: r.status, items: JSON.parse(r.stdout).drift }; };

  const s = readSettings(home);
  s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo plugin added this later' }] });
  writeSettings(home, s);
  assert.equal(drift().status, 0, 'order among SessionStart entries is not drift');

  const dup = structuredClone(s);
  dup.hooks.SessionStart.push(sessionVersion(home));
  writeSettings(home, dup);
  assert.ok(drift().items.some((d) => d.kind === 'hook-duplicated' && d.path === 'session-version'));

  const edited = structuredClone(s);
  edited.hooks.SessionStart[0].hooks[0].timeout = 99;
  writeSettings(home, edited);
  assert.ok(drift().items.some((d) => d.kind === 'hook-differs' && d.path === 'session-version'));

  const gone = structuredClone(s);
  gone.hooks.SessionStart = gone.hooks.SessionStart.filter((g) => !g.hooks.some((h) => isOurHandler(h, home)));
  writeSettings(home, gone);
  const missing = drift();
  assert.equal(missing.status, 1);
  assert.ok(missing.items.some((d) => d.kind === 'hook-missing' && d.path === 'session-version'));
  assert.equal(install(home).status, 0);
  assert.equal(drift().status, 0);
});

test('an install from before the status hook existed reports it missing until the next install', () => {
  const home = newHome();
  assert.equal(install(home).status, 0);
  const s = readSettings(home);
  delete s.hooks.SessionStart;
  writeSettings(home, s);
  const r = install(home, ['--check', '--json']);
  assert.deepEqual(JSON.parse(r.stdout).drift.map((d) => d.kind), ['hook-missing']);
});

test('--uninstall removes the session-version hook only; the owner\'s SessionStart groups stay', () => {
  const home = newHome();
  const before = ownersSettings();
  writeSettings(home, before);
  assert.equal(install(home).status, 0);
  assert.equal(install(home, ['--uninstall']).status, 0);
  assert.deepEqual(readSettings(home).hooks.SessionStart, before.hooks.SessionStart);
  assert.deepEqual(readSettings(home), before);
});

test('mergeSettings/removeOurSettings round-trip with SessionStart; our handler is lifted out of a shared SessionStart group', () => {
  const home = '/h/.claude';
  assert.deepEqual(removeOurSettings(mergeSettings({}, { home }), { home }), {});
  const shared = { hooks: { SessionStart: [{ hooks: [
    { type: 'command', command: 'echo mine' },
    { type: 'command', command: 'node', args: ['/h/.claude/pipeline/hooks/session-version.mjs'], timeout: 10 },
  ] }] } };
  const merged = mergeSettings(shared, { home });
  assert.deepEqual(merged.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo mine' }] }, sessionVersion(home)]);
  assert.throws(() => mergeSettings({ hooks: { SessionStart: {} } }, { home }), /hooks\.SessionStart" is not an array/);
});

test('buildPlan requires pipeline/hooks/session-version.mjs like the two guards', () => {
  const src = copyFixture();
  rmSync(join(src, 'pipeline', 'hooks', 'session-version.mjs'));
  assert.ok(buildPlan(src).problems.includes('pipeline/hooks/session-version.mjs is missing'));
  assert.equal(buildPlan(FIXTURE).problems.length, 0);
});
