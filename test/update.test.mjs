// Why: `pipeline update` installs code it downloaded into the owner's ~/.claude, so these tests pin what must hold:
// it refuses inside Claude Code, installs exactly the commit main points to (from a local bare repo standing in for
// GitHub, through the PIPELINE_UPDATE_REMOTE seam), proves the result before saying so, keeps the guard-file choice,
// removes its scratch directory even when it fails, and that every git call it makes is cut off from the caller's
// git configuration. The GitHub side is a scripted fake gh, like the other command tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGh } from './helpers/fakegh-env.mjs';
import { run as update, meta } from '../pipeline/commands/update.mjs';
import { compare, fetchRemote, isolatedGit, isolatedGitArgs, isolatedGitEnv, mainSha, UPSTREAM_HOST, UPSTREAM_REPO, UPSTREAM_URL } from '../pipeline/lib/upstream.mjs';
import { seamValue } from '../pipeline/lib/proc.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scratch(label = 'cp-upd') {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
}

const GIT_IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A bare repo holding this checkout's files (tracked and new, minus ignored): a full, installable "upstream".
let remoteCache = null;
function remote() {
  if (remoteCache) return remoteCache;
  const work = scratch('cp-upd-work');
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    const from = join(REPO, rel);
    if (!existsSync(from) || !lstatSync(from).isFile()) continue;
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    copyFileSync(from, join(work, rel));
  }
  git(work, ['init', '--quiet']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['add', '-A']);
  git(work, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'upstream']);
  const bare = join(scratch('cp-upd-bare'), 'upstream.git');
  git(work, ['clone', '--quiet', '--bare', work, bare]);
  remoteCache = { bare, sha: git(work, ['rev-parse', 'HEAD']), version: readFileSync(join(work, 'VERSION'), 'utf8').trim() };
  return remoteCache;
}

// GitHub's compare answer for the given relation (shape of the real API: base_commit, merge_base_commit, commits[]).
function cmp(status, base, head, extra = {}) {
  const mergeBase = status === 'ahead' ? base : status === 'diverged' ? 'c'.repeat(40) : head;
  const commits = status === 'ahead' || status === 'diverged' ? [{ sha: 'd'.repeat(40) }, { sha: head }] : [];
  return { status, base_commit: { sha: base }, merge_base_commit: { sha: mergeBase }, commits, total_commits: commits.length, ...extra };
}
const ghFor = (main, compareBody) => createFakeGh([
  { match: 'commits/main', stdout: `${main}\n` },
  ...(compareBody ? [{ match: 'compare/', stdoutJson: typeof compareBody === 'function' ? compareBody() : compareBody }] : []),
]);

function envFor(fake, extra = {}) {
  const userHome = scratch('cp-upd-user');
  const e = {
    ...process.env, HOME: userHome, USERPROFILE: userHome, PIPELINE_INSTALL_NO_PROBES: '1', PIPELINE_ADMIN: '1',
    PIPELINE_LOCK_DIR: scratch('cp-upd-lock'), PIPELINE_MACHINE_ID: 'test-machine-id', PIPELINE_UPDATE_REMOTE: remote().bare,
    ...(fake?.env ?? {}),
  };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CONFIG_DIR;
  return Object.assign(e, extra);
}
const newHome = () => join(scratch('cp-upd-home'), 'claude');
const readManifest = (home) => JSON.parse(readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8'));

// Runs `fn` with the temp dir pointed at a private folder and lists update's own scratch directories left in it afterwards.
async function withTmp(fn) {
  const dir = scratch('cp-upd-tmp');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: dir, TEMP: dir, TMP: dir });
  try { return { result: await fn(), left: readdirSync(dir).filter((n) => n.startsWith('claude-pipeline-update-')) }; } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// One real update into a throwaway home, reused (copied) by the --check tests.
let updatedCache = null;
async function updatedHome() {
  if (!updatedCache) {
    const { sha } = remote();
    const home = newHome();
    const r = await update(['--claude-home', home], { env: envFor(ghFor(sha, cmp('identical', sha, sha))) });
    assert.equal(r.exitCode, 0, JSON.stringify(r.output));
    updatedCache = home;
  }
  const copy = newHome();
  cpSync(updatedCache, copy, { recursive: true });
  return copy;
}

// ---- meta ---------------------------------------------------------------------------------------------------------

test('meta describes the command and names the default home', () => {
  assert.match(meta.usage, /^pipeline update \[--claude-home DIR\] \[--check\] \[--json\]/);
  assert.match(meta.usage, /~\/\.claude/);
  assert.match(meta.usage, /CLAUDE_CONFIG_DIR/);
});

// ---- refusal ------------------------------------------------------------------------------------------------------

test('update refuses inside Claude Code (CLAUDECODE=1) before touching GitHub, git or the home', async () => {
  const fake = ghFor('a'.repeat(40));
  const home = newHome();
  const env = envFor(fake, { CLAUDECODE: '1' });
  delete env.PIPELINE_ADMIN;
  const r = await update(['--claude-home', home], { env });
  assert.equal(r.exitCode, 2);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.error, 'refused');
  assert.match(r.output.message, /your own terminal/);
  assert.deepEqual(fake.calls(), []);
  assert.equal(existsSync(home), false);
});

test('update refuses when a Claude Code process is an ancestor, even with CLAUDECODE unset', async () => {
  const fake = ghFor('a'.repeat(40));
  const env = envFor(fake);
  delete env.PIPELINE_ADMIN;
  const r = await update(['--claude-home', newHome()], { env, hasClaudeCodeAncestor: () => true });
  assert.equal(r.exitCode, 2);
  assert.match(r.output.message, /ancestor/);
  assert.deepEqual(fake.calls(), []);
});

test('PIPELINE_ADMIN=1 lifts the refusal; --check is allowed inside Claude Code', async () => {
  const sha = 'a'.repeat(40);
  // CLAUDECODE=1 with PIPELINE_ADMIN=1: not refused (nothing installed, so the update itself fails later, not with exit 2).
  const admin = await update(['--claude-home', newHome()], { env: envFor(ghFor(sha), { CLAUDECODE: '1' }) });
  assert.notEqual(admin.output.error, 'refused');
  // --check without PIPELINE_ADMIN, inside Claude Code: read-only, so it runs.
  const env = envFor(ghFor(sha), { CLAUDECODE: '1' });
  delete env.PIPELINE_ADMIN;
  const r = await update(['--check', '--claude-home', newHome()], { env, hasClaudeCodeAncestor: () => true });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.mode, 'check');
  assert.equal(r.output.error, undefined);
});

// ---- the default home ---------------------------------------------------------------------------------------------

test('the default claude-home is ~/.claude under the real home, not CLAUDE_CONFIG_DIR', async () => {
  const sha = 'a'.repeat(40);
  const env = envFor(ghFor(sha));
  env.CLAUDE_CONFIG_DIR = join(scratch('cp-upd-other'), 'other');
  const r = await update(['--check'], { env });
  const { homedir } = await import('node:os');
  assert.equal(r.output.home, join(homedir(), '.claude'));
});

// ---- --check ------------------------------------------------------------------------------------------------------

test('--check with nothing installed: exit 1, installed null, no fetch', async () => {
  const sha = 'a'.repeat(40);
  const fake = ghFor(sha);
  const r = await update(['--check', '--claude-home', newHome()], { env: envFor(fake) });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.installed, null);
  assert.equal(r.output.main.sha, sha);
  assert.equal(r.output.status, 'unresolved');
  assert.equal(r.output.upToDate, false);
  assert.equal(fake.lines().some((l) => /compare\//.test(l)), false, 'nothing installed: there is no commit to compare');
});

test('--check on a complete, unmodified install identical to main: exit 0', async () => {
  const { sha } = remote();
  const home = await updatedHome();
  const fake = ghFor(sha, cmp('identical', sha, sha));
  const r = await update(['--check', '--claude-home', home], { env: envFor(fake) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.ok, true);
  assert.equal(r.output.upToDate, true);
  assert.equal(r.output.status, 'identical');
  assert.equal(r.output.installed.sourceSha, sha);
  assert.deepEqual(fake.lines().filter((l) => /compare\//.test(l)), [`api --hostname ${UPSTREAM_HOST} repos/${UPSTREAM_REPO}/compare/${sha}...${sha}`]);
});

test('--check: main ahead of the install is reported and exits 1', async () => {
  const { sha } = remote();
  const main = 'b'.repeat(40);
  const r = await update(['--check', '--claude-home', await updatedHome()], { env: envFor(ghFor(main, cmp('ahead', sha, main))) });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.status, 'ahead');
  assert.equal(r.output.upToDate, false);
  assert.equal(r.output.compare.headSha, main);
});

test('--check: identical commit but modified files, or an incomplete install, is not up to date', async () => {
  const { sha } = remote();
  const fake = () => ghFor(sha, cmp('identical', sha, sha));

  const edited = await updatedHome();
  writeFileSync(join(edited, 'pipeline', 'bin', 'pipeline.mjs'), '// edited\n', { flag: 'a' });
  const a = await update(['--check', '--claude-home', edited], { env: envFor(fake()) });
  assert.equal(a.exitCode, 1);
  assert.equal(a.output.status, 'identical');
  assert.deepEqual(a.output.installed.modified, ['pipeline/bin/pipeline.mjs']);
  assert.match(a.output.installed.stamp, /\.modified$/);

  const half = await updatedHome();
  const file = join(half, 'pipeline', 'INSTALLED.json');
  writeFileSync(file, `${JSON.stringify({ ...readManifest(half), complete: false })}\n`);
  const b = await update(['--check', '--claude-home', half], { env: envFor(fake()) });
  assert.equal(b.exitCode, 1);
  assert.equal(b.output.installed.complete, false);
});

test('--check: a GitHub error on the compare is reported as unresolved with a reason, never as up to date', async () => {
  const { sha } = remote();
  const fake = createFakeGh([{ match: 'commits/main', stdout: `${sha}\n` }, { match: 'compare/', stderr: 'HTTP 404', code: 1 }]);
  const r = await update(['--check', '--claude-home', await updatedHome()], { env: envFor(fake) });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.status, 'unresolved');
  assert.match(r.output.compare.reason, /HTTP 404/);
  assert.equal(r.output.upToDate, false);
});

test('main cannot be resolved (gh down, remote unreachable): exit 1 with the reasons, nothing fetched or installed', async () => {
  const fake = createFakeGh([{ match: '.*', stderr: 'gh: not logged in', code: 4 }]);
  const home = newHome();
  const env = envFor(fake, { PIPELINE_UPDATE_REMOTE: join(scratch('cp-upd-void'), 'nope.git') });
  const r = await update(['--claude-home', home], { env });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'upstream-unresolved');
  assert.match(r.output.message, /not logged in/);
  assert.match(r.output.message, /git ls-remote/);
  assert.equal(existsSync(home), false);
});

// ---- update -------------------------------------------------------------------------------------------------------

test('update installs exactly the commit main points to, verifies it, and leaves no scratch directory', async () => {
  const { sha, version } = remote();
  const home = newHome();
  const fake = ghFor(sha, cmp('identical', sha, sha));
  const { result: r, left } = await withTmp(() => update(['--claude-home', home], { env: envFor(fake) }));
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.ok, true);
  assert.equal(r.output.before, null);
  assert.equal(r.output.after, `${version}+${sha.slice(0, 7)}`);
  assert.equal(r.output.changed, true);
  assert.equal(r.output.installed.sourceSha, sha);
  assert.equal(r.output.install.ok, true);
  assert.equal(r.output.check.ok, true);
  const manifest = readManifest(home);
  assert.equal(manifest.sourceSha, sha);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.sourceDirty, undefined);
  assert.deepEqual(left, [], 'the scratch directory is removed');
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  assert.equal(JSON.stringify(settings).includes('guard-files.mjs'), true);
});

test('update on an up-to-date install changes nothing and reports before === after', async () => {
  const { sha } = remote();
  const home = await updatedHome();
  const before = readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8');
  const r = await update(['--claude-home', home], { env: envFor(ghFor(sha, cmp('identical', sha, sha))) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.changed, false);
  assert.equal(r.output.before, r.output.after);
  assert.equal(readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8'), before);
});

test('update repairs a modified install', async () => {
  const { sha } = remote();
  const home = await updatedHome();
  writeFileSync(join(home, 'pipeline', 'bin', 'pipeline.mjs'), '// edited\n', { flag: 'a' });
  const r = await update(['--claude-home', home], { env: envFor(ghFor(sha, cmp('identical', sha, sha))) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.match(r.output.before, /\.modified$/);
  assert.doesNotMatch(r.output.after, /\.modified/);
  assert.equal(r.output.installed.modified.length, 0);
});

test('update keeps the guard-files choice: an install made with --skip-file-guard stays without it', async () => {
  const { sha } = remote();
  const home = newHome();
  const first = spawnSync(process.execPath, [join(REPO, 'install.mjs'), '--claude-home', home, '--source', REPO, '--skip-file-guard', '--json'], {
    encoding: 'utf8', env: envFor(null),
  });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(readManifest(home).hooks.guardFiles, false);
  const r = await update(['--claude-home', home], { env: envFor(ghFor(sha, cmp('ahead', 'e'.repeat(40), sha))) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.skipFileGuard, true);
  assert.equal(readManifest(home).hooks.guardFiles, false);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).includes('guard-files.mjs'), false);
});

test('update turns the guard-files hook on for a default install (no flag inferred)', async () => {
  const home = await updatedHome();
  assert.equal(readManifest(home).hooks.guardFiles, true);
});

test('a fetch that fails reports it, installs nothing, and still removes the scratch directory', async () => {
  const sha = 'a'.repeat(40); // main names a commit the remote does not have
  const home = newHome();
  const { result: r, left } = await withTmp(() => update(['--claude-home', home], { env: envFor(ghFor(sha)) }));
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.error, 'fetch-failed');
  assert.match(r.output.message, /git fetch aaaaaaa/);
  assert.deepEqual(left, []);
  assert.equal(existsSync(join(home, 'pipeline')), false);
});

test('an install that fails is reported and the scratch directory is still removed', async () => {
  const { sha } = remote();
  const home = newHome();
  mkdirSync(join(home, 'skills', 'ship'), { recursive: true }); // a skill that is not ours: the installer refuses to overwrite it
  writeFileSync(join(home, 'skills', 'ship', 'SKILL.md'), 'mine\n');
  const { result: r, left } = await withTmp(() => update(['--claude-home', home], { env: envFor(ghFor(sha)) }));
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'install-failed');
  assert.equal(r.output.install.ok, false);
  assert.equal(r.output.check, null);
  assert.deepEqual(left, []);
});

test('update warns when the install is not an ancestor of main', async () => {
  const { sha } = remote();
  const home = await updatedHome();
  const r = await update(['--claude-home', home, '--json'], { env: envFor(ghFor(sha, cmp('behind', sha, sha))) });
  assert.equal(r.output.downgrade, true);
});

// ---- upstream.mjs -------------------------------------------------------------------------------------------------

test('the upstream constants', () => {
  assert.equal(UPSTREAM_HOST, 'github.com');
  assert.equal(UPSTREAM_REPO, 'ianjamila/claude-pipeline');
  assert.equal(UPSTREAM_URL, 'https://github.com/ianjamila/claude-pipeline');
});

test('mainSha: gh first (pinned host + repo), then git ls-remote; both failing names both reasons', () => {
  const { sha, bare } = remote();
  const ok = ghFor(sha);
  assert.deepEqual(mainSha({ env: envFor(ok) }), { ok: true, sha, via: 'gh' });
  assert.deepEqual(ok.lines(), [`api --hostname github.com repos/ianjamila/claude-pipeline/commits/main --jq .sha`]);

  const down = createFakeGh([{ match: '.*', stderr: 'HTTP 502', code: 1 }]);
  assert.deepEqual(mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: bare }) }), { ok: true, sha, via: 'git' });

  const junk = createFakeGh([{ match: '.*', stdout: '<html>captive portal</html>' }]);
  assert.equal(mainSha({ env: envFor(junk, { PIPELINE_UPDATE_REMOTE: bare }) }).via, 'git', 'a gh answer that is not a sha falls through');

  const both = mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: join(scratch('cp-upd-void'), 'nope.git') }) });
  assert.equal(both.ok, false);
  assert.match(both.reason, /HTTP 502/);
  assert.match(both.reason, /git ls-remote/);
});

test('compare: maps the four relations with full shas from the response', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const env = (body) => envFor(createFakeGh([{ match: 'compare/', stdoutJson: body }]));
  assert.deepEqual(compare(base, base, { env: env(cmp('identical', base, base)) }), { status: 'identical', baseSha: base, headSha: base });
  assert.deepEqual(compare(base, head, { env: env(cmp('ahead', base, head)) }), { status: 'ahead', baseSha: base, headSha: head });
  assert.deepEqual(compare(head, base, { env: env(cmp('behind', head, base)) }), { status: 'behind', baseSha: head, headSha: base });
  assert.deepEqual(compare(base, head, { env: env(cmp('diverged', base, head)) }), { status: 'diverged', baseSha: base, headSha: head });
});

test('compare: short shas are accepted and the answer carries the full ones; the call names the pinned repo', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const fake = createFakeGh([{ match: 'compare/', stdoutJson: cmp('ahead', base, head) }]);
  assert.deepEqual(compare('aaaaaaa', 'bbbbbbb', { env: envFor(fake) }), { status: 'ahead', baseSha: base, headSha: head });
  assert.deepEqual(fake.lines(), [`api --hostname github.com repos/ianjamila/claude-pipeline/compare/aaaaaaa...bbbbbbb`]);
});

test('compare: a truncated commit list does not pass for the head; a full-length head still resolves', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const partial = cmp('ahead', base, head, { total_commits: 400 });
  const env = envFor(createFakeGh([{ match: 'compare/', stdoutJson: partial }]));
  assert.deepEqual(compare(base, head, { env }), { status: 'ahead', baseSha: base, headSha: head });
  assert.equal(compare(base, 'bbbbbbb', { env }).status, 'unresolved');
});

test('compare: every failure is unresolved with a reason, never a throw', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const cases = {
    'gh exits non-zero': [{ match: '.*', stderr: 'HTTP 404: Not Found', code: 1 }, /HTTP 404/],
    'not JSON': [{ match: '.*', stdout: 'oops' }, /not JSON/],
    'unknown status': [{ match: '.*', stdoutJson: { status: 'mystery', base_commit: { sha: base } } }, /unexpected compare status/],
    'a response about other commits': [{ match: '.*', stdoutJson: cmp('ahead', 'f'.repeat(40), head) }, /base commit/],
    'gh missing from the response': [{ match: '.*', stdoutJson: {} }, /unexpected compare status/],
  };
  for (const [name, [entry, pattern]] of Object.entries(cases)) {
    const r = compare(base, head, { env: envFor(createFakeGh([entry])) });
    assert.equal(r.status, 'unresolved', name);
    assert.match(r.reason, pattern, name);
  }
  assert.equal(compare('not-a-sha', head, { env: envFor(createFakeGh([])) }).status, 'unresolved');
  assert.equal(compare(undefined, head).status, 'unresolved');
});

test('compare and mainSha give up when gh hangs past the timeout', () => {
  const dir = scratch('cp-upd-slow');
  const slow = join(dir, 'slow-gh.mjs');
  writeFileSync(slow, 'setTimeout(() => process.stdout.write("x"), 20000);\n');
  const env = envFor(null, { PIPELINE_GH: `node "${slow}"`, PIPELINE_UPDATE_REMOTE: join(dir, 'nope.git') });
  const t0 = Date.now();
  const c = compare('a'.repeat(40), 'b'.repeat(40), { env, timeoutMs: 400 });
  assert.equal(c.status, 'unresolved');
  assert.match(c.reason, /timed out/);
  const m = mainSha({ env, timeoutMs: 400 });
  assert.equal(m.ok, false);
  assert.match(m.reason, /timed out/);
  assert.ok(Date.now() - t0 < 8000, 'the timeouts are real');
});

test('the isolated git: fixed flags, no system/global config, no prompts, GIT_* redirection scrubbed', () => {
  const args = isolatedGitArgs();
  for (const pair of [`core.hooksPath=${devNull}`, 'core.fsmonitor=false', 'credential.helper=', 'protocol.allow=never', 'protocol.https.allow=always']) {
    assert.ok(args.includes(pair), pair);
  }
  assert.equal(args.includes('protocol.file.allow=always'), false);
  assert.ok(isolatedGitArgs({ allowFile: true }).includes('protocol.file.allow=always'));
  const env = isolatedGitEnv();
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_TEMPLATE_DIR']) {
    assert.ok(k in env && env[k] === undefined, k);
  }
});

test('the isolated git ignores a hostile environment: GIT_DIR, a template with a hook, an allow-everything protocol list', () => {
  const dir = scratch('cp-upd-iso');
  const template = join(dir, 'template');
  mkdirSync(join(template, 'hooks'), { recursive: true });
  writeFileSync(join(template, 'hooks', 'post-checkout'), '#!/bin/sh\ntouch "$0.ran"\n');
  const saved = { ...process.env };
  Object.assign(process.env, {
    GIT_DIR: join(dir, 'elsewhere'), GIT_TEMPLATE_DIR: template, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(template, 'hooks'),
  });
  try {
    const repo = join(dir, 'repo');
    const init = isolatedGit(['init', '--quiet', '--template=', repo], { cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    assert.equal(existsSync(join(repo, '.git')), true, 'GIT_DIR did not redirect the init');
    assert.equal(existsSync(join(repo, '.git', 'hooks', 'post-checkout')), false, 'the empty template copied nothing in');
    // The file transport is closed unless the test seam opens it, whatever GIT_ALLOW_PROTOCOL says.
    const { bare } = remote();
    assert.notEqual(isolatedGit(['ls-remote', bare], { cwd: dir }).code, 0);
    assert.equal(isolatedGit(['ls-remote', bare], { cwd: dir, allowFile: true }).code, 0);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('PIPELINE_UPDATE_REMOTE is a seam: honoured by a checkout, ignored (with the real URL used) by an installed copy', () => {
  assert.deepEqual(fetchRemote({ PIPELINE_UPDATE_REMOTE: '/some/where.git' }), { url: '/some/where.git', local: true });
  assert.deepEqual(fetchRemote({}), { url: UPSTREAM_URL, local: false });
  const root = scratch('cp-upd-installed');
  writeFileSync(join(root, 'INSTALLED.json'), '{}');
  assert.equal(seamValue('PIPELINE_UPDATE_REMOTE', { PIPELINE_UPDATE_REMOTE: '/x' }, { root, warn: () => {} }), undefined);
});
