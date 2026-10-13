// Why: `pipeline update` installs code it downloaded into the owner's ~/.claude, so these tests pin what must hold:
// it refuses inside Claude Code, installs exactly the commit main points to (from a local bare repo standing in for
// GitHub, through the PIPELINE_UPDATE_REMOTE seam), proves the result before saying so, keeps the guard-file choice,
// removes its scratch directory even when it fails, and that every git call it makes is cut off from the caller's
// git configuration. The GitHub side is a scripted fake gh, like the other command tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, copyFileSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGh } from './helpers/fakegh-env.mjs';
import { run as update, meta, installerEnv, shQuote, psQuote } from '../pipeline/commands/update.mjs';
import { compare, fetchRemote, ISO_DIR_PREFIX, isolatedGit, isolatedGitArgs, isolatedGitEnv, mainSha, makeIsoDir, withIsolatedGit, UPSTREAM_HOST, UPSTREAM_REPO, UPSTREAM_URL } from '../pipeline/lib/upstream.mjs';
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

// A private isolation directory for a test, made in the trusted temp root of a scratch Claude home (removed on exit).
const isoDir = () => makeIsoDir(scratch('cp-upd-isohome'));
const tmpRootOf = (home) => join(home, 'pipeline-state', 'tmp');

// Runs `fn` with the OS temp dir pointed at an empty canary folder, then reports (a) `left`: update's own scratch
// directories (the download and the private git config/hooks directory) still in the trusted root under `home`, and
// asserts (b) that nothing at all was created in the OS temp dir: the scratch space is under the Claude home only.
async function withTmp(home, fn) {
  const canary = scratch('cp-upd-tmp');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: canary, TEMP: canary, TMP: canary });
  try {
    const result = await fn();
    assert.deepEqual(readdirSync(canary).filter((n) => n.startsWith('claude-pipeline-')), [], 'update creates nothing under the OS temp dir');
    const root = tmpRootOf(home);
    return { result, left: existsSync(root) ? readdirSync(root) : [] };
  } finally {
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
  mkdirSync(home); // the git fallback needs an existing Claude home for its private directory
  const env = envFor(fake, { PIPELINE_UPDATE_REMOTE: join(scratch('cp-upd-void'), 'nope.git') });
  const r = await update(['--claude-home', home], { env });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'upstream-unresolved');
  assert.match(r.output.message, /not logged in/);
  assert.match(r.output.message, /git ls-remote/);
  assert.equal(existsSync(join(home, 'pipeline')), false);
  assert.deepEqual(readdirSync(tmpRootOf(home)), [], 'the private git directory is gone');
});

// ---- update -------------------------------------------------------------------------------------------------------

test('update installs exactly the commit main points to, verifies it, and leaves no scratch directory', async () => {
  const { sha, version } = remote();
  const home = newHome();
  const fake = ghFor(sha, cmp('identical', sha, sha));
  const { result: r, left } = await withTmp(home, () => update(['--claude-home', home], { env: envFor(fake) }));
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

// A commit that predates the installer's exception for a source under <home>/pipeline-state/tmp: its install.mjs rejects
// any --source inside the Claude home. Built from the real remote with the exception (and its import) taken out of this
// checkout's install.mjs and private-tmp.mjs removed - no git history needed, since CI checks out shallow.
const EXCEPTION_IMPORT = "import { TMP_ROOT_REL } from './pipeline/lib/private-tmp.mjs';";
const EXCEPTION_CLAUSE = ' && !isInside(source, path.join(home, TMP_ROOT_REL))';
let oldRemoteCache = null;
function oldRemote() {
  if (oldRemoteCache) return oldRemoteCache;
  const work = scratch('cp-upd-oldwork');
  git(work, ['clone', '--quiet', remote().bare, '.']);
  const now = readFileSync(join(REPO, 'install.mjs'), 'utf8');
  assert.ok(now.includes(EXCEPTION_IMPORT) && now.includes(EXCEPTION_CLAUSE), 'install.mjs no longer carries the exception this fixture takes out');
  writeFileSync(join(work, 'install.mjs'), now.replace(EXCEPTION_IMPORT, '').replace(EXCEPTION_CLAUSE, ''));
  rmSync(join(work, 'pipeline', 'lib', 'private-tmp.mjs'));
  git(work, ['add', '-A']);
  git(work, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'old installer']);
  git(work, ['branch', '-M', 'main']);
  const bare = join(scratch('cp-upd-oldbare'), 'upstream.git');
  git(work, ['clone', '--quiet', '--bare', work, bare]);
  oldRemoteCache = { bare, sha: git(work, ['rev-parse', 'HEAD']), tree: work };
  return oldRemoteCache;
}

test('update to a commit whose installer predates the downloads-under-the-home exception stops with a clear error and installs nothing', async () => {
  const old = oldRemote();
  // Control: that installer really does refuse a source inside the Claude home (so the new check guards a real failure).
  const probeHome = newHome();
  const inside = join(probeHome, 'pipeline-state', 'tmp', 'src');
  mkdirSync(dirname(inside), { recursive: true });
  cpSync(old.tree, inside, { recursive: true });
  const direct = spawnSync(process.execPath, [join(inside, 'install.mjs'), '--claude-home', probeHome, '--source', inside, '--json'], { encoding: 'utf8', env: envFor(null) });
  assert.notEqual(direct.status, 0, 'control: the old installer rejects a source inside the home');
  assert.match(direct.stdout + direct.stderr, /inside the claude-home/);

  for (const guardFiles of [true, false]) {
    // A home with a space and a quote: the suggested command must keep it one literal argument in sh and PowerShell.
    const home = join(scratch('cp-upd-home'), "Jane O'Doe claude");
    if (!guardFiles) {
      const first = spawnSync(process.execPath, [join(REPO, 'install.mjs'), '--claude-home', home, '--source', REPO, '--skip-file-guard', '--json'], { encoding: 'utf8', env: envFor(null) });
      assert.equal(first.status, 0, first.stderr);
    }
    const before = existsSync(join(home, 'pipeline', 'INSTALLED.json')) ? readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8') : null;
    const { result: r, left } = await withTmp(home, () => update(['--claude-home', home], { env: envFor(ghFor(old.sha, cmp('ahead', 'a'.repeat(40), old.sha)), { PIPELINE_UPDATE_REMOTE: old.bare }) }));
    assert.equal(r.exitCode, 1, JSON.stringify(r.output));
    assert.equal(r.output.ok, false);
    assert.equal(r.output.error, 'installer-too-old');
    assert.match(r.output.message, /older installer/);
    const flag = guardFiles ? '' : ' --skip-file-guard';
    assert.ok(r.output.message.includes(`./install.sh --claude-home ${shQuote(home)}${flag}`), r.output.message);
    assert.ok(r.output.message.includes(`.\\install.ps1 --claude-home ${psQuote(home)}${flag}`), r.output.message);
    assert.equal(r.output.install, null, 'the downloaded installer was never run');
    assert.equal(existsSync(join(home, 'pipeline', 'INSTALLED.json')) ? readFileSync(join(home, 'pipeline', 'INSTALLED.json'), 'utf8') : null, before, 'the installed copy is untouched');
    assert.deepEqual(left, [], 'the download is removed');
  }
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
  const { result: r, left } = await withTmp(home, () => update(['--claude-home', home], { env: envFor(ghFor(sha)) }));
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
  const { result: r, left } = await withTmp(home, () => update(['--claude-home', home], { env: envFor(ghFor(sha)) }));
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
  assert.deepEqual(mainSha({ env: envFor(ok), home: scratch('cp-upd-mshome') }), { ok: true, sha, via: 'gh' });
  assert.deepEqual(ok.lines(), [`api --hostname github.com repos/ianjamila/claude-pipeline/commits/main --jq .sha`]);

  const down = createFakeGh([{ match: '.*', stderr: 'HTTP 502', code: 1 }]);
  assert.deepEqual(mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: bare }), home: scratch('cp-upd-mshome') }), { ok: true, sha, via: 'git' });

  const junk = createFakeGh([{ match: '.*', stdout: '<html>captive portal</html>' }]);
  assert.equal(mainSha({ env: envFor(junk, { PIPELINE_UPDATE_REMOTE: bare }), home: scratch('cp-upd-mshome') }).via, 'git', 'a gh answer that is not a sha falls through');

  const both = mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: join(scratch('cp-upd-void'), 'nope.git') }), home: scratch('cp-upd-mshome') });
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
  const m = mainSha({ env, timeoutMs: 400, home: scratch('cp-upd-mshome') });
  assert.equal(m.ok, false);
  assert.match(m.reason, /timed out/);
  assert.ok(Date.now() - t0 < 8000, 'the timeouts are real');
});

test('the isolated git: fixed flags, no system/global config, no prompts, all pointing into a private dir', () => {
  const iso = isoDir();
  const args = isolatedGitArgs({ isoDir: iso });
  for (const pair of [`core.hooksPath=${join(iso, 'hooks')}`, 'core.fsmonitor=false', 'credential.helper=', 'protocol.allow=never', 'protocol.https.allow=always']) {
    assert.ok(args.includes(pair), pair);
  }
  assert.equal(args.includes('protocol.file.allow=always'), false);
  assert.ok(isolatedGitArgs({ isoDir: iso, allowFile: true }).includes('protocol.file.allow=always'));
  const env = isolatedGitEnv({ isoDir: iso });
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, join(iso, 'empty.gitconfig'));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CEILING_DIRECTORIES, realpathSync.native(dirname(iso)), 'git may not climb out of the trusted scratch root');
  // The hooks path is an existing EMPTY directory and the global config an existing EMPTY file: never a device name,
  // which Git for Windows resolves differently for a hooks directory (C:\dev\null\post-checkout) than for a file.
  const hooksPath = args.find((a) => a.startsWith('core.hooksPath=')).slice('core.hooksPath='.length);
  assert.equal(statSync(hooksPath).isDirectory(), true);
  assert.deepEqual(readdirSync(hooksPath), []);
  assert.equal(statSync(env.GIT_CONFIG_GLOBAL).isFile(), true);
  assert.equal(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'), '');
  for (const text of [...args, ...Object.values(env)]) {
    assert.equal(text.includes('/dev/null'), false, text);
    assert.equal(text.includes(devNull), false, text);
    assert.equal(/\\\\\.\\nul/i.test(text), false, text);
  }
  assert.equal(hooksPath.startsWith(iso + sep), true);
  assert.equal(isolatedGitEnv({ isoDir: iso, source: {}, platform: 'win32' }).GIT_CONFIG_GLOBAL, join(iso, 'empty.gitconfig'));
});

test('the isolated git cannot be called without a private directory made by makeIsoDir', () => {
  assert.throws(() => isolatedGitArgs(), /isoDir/);
  assert.throws(() => isolatedGitEnv(), /isoDir/);
  assert.throws(() => isolatedGit(['--version']), /isoDir/);
  assert.throws(() => isolatedGit(['--version'], { isoDir: scratch('cp-upd-notiso') }));
});

test('makeIsoDir: a fresh private dir (0700 on POSIX) in the home\'s trusted root, with an empty hooks dir and an empty config file; withIsolatedGit removes it', () => {
  const home = scratch('cp-upd-isomode');
  const canary = scratch('cp-upd-isocanary');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: canary, TEMP: canary, TMP: canary });
  try {
    const a = makeIsoDir(home);
    const b = makeIsoDir(home);
    assert.notEqual(a, b);
    assert.equal(a.startsWith(join(tmpRootOf(home), ISO_DIR_PREFIX)), true, 'inside <home>/pipeline-state/tmp');
    assert.deepEqual(readdirSync(canary), [], 'not under the OS temp dir');
    assert.deepEqual(readdirSync(join(a, 'hooks')), []);
    assert.equal(readFileSync(join(a, 'empty.gitconfig'), 'utf8'), '');
    if (process.platform !== 'win32') {
      assert.equal(statSync(a).mode & 0o777, 0o700);
      assert.equal(statSync(join(a, 'hooks')).mode & 0o777, 0o700);
      assert.equal(statSync(join(a, 'empty.gitconfig')).mode & 0o077, 0, 'the config file is not group/world accessible');
    }
    let seen;
    const out = withIsolatedGit(home, (git, dir) => { seen = dir; assert.equal(existsSync(dir), true); return git(['--version'], { cwd: dir }); });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(existsSync(seen), false, 'removed after success');
    let thrown;
    assert.throws(() => withIsolatedGit(home, (git, dir) => { thrown = dir; throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(thrown), false, 'removed after a throw');
    assert.throws(() => withIsolatedGit(undefined, () => {}), /Claude home/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the isolated git environment is an allowlist: PATH, HOME, locale and four fixed values, nothing else', () => {
  const iso = isoDir();
  const hostile = {
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'x', TEMP: '/t', COMSPEC: 'cmd', SYSTEMROOT: 'C:\\Windows',
    GIT_EXEC_PATH: '/evil', GIT_SSH: '/evil/ssh', GIT_SSH_COMMAND: 'evil', GIT_CONFIG: '/evil/c', GIT_CONFIG_GLOBAL: '/evil/g', GIT_EXTERNAL_DIFF: 'evil',
    GIT_PROXY_COMMAND: 'evil', GIT_ASKPASS: 'evil', GIT_PAGER: 'evil', GIT_FUTURE_VARIABLE: 'evil', GIT_DIR: '/evil', GIT_WORK_TREE: '/evil', GIT_CEILING_DIRECTORIES: '/evil',
    HTTPS_PROXY: 'http://evil', SSL_CERT_FILE: '/evil', CURL_CA_BUNDLE: '/evil', LD_PRELOAD: '/evil.so', NODE_OPTIONS: '--require evil', EDITOR: 'evil',
  };
  const fixed = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(iso, 'empty.gitconfig'), GIT_CEILING_DIRECTORIES: realpathSync.native(dirname(iso)), GIT_TERMINAL_PROMPT: '0' };
  assert.deepEqual(isolatedGitEnv({ isoDir: iso, source: hostile, platform: 'linux' }), { PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', ...fixed });
  // Windows adds the variables the runtime needs to start, and finds them whatever their case.
  const win = isolatedGitEnv({ isoDir: iso, source: { Path: 'C:\\bin', ComSpec: 'C:\\cmd.exe', SystemRoot: 'C:\\Windows', GIT_EXEC_PATH: '/evil', NODE_OPTIONS: 'x' }, platform: 'win32' });
  assert.deepEqual(win, { PATH: 'C:\\bin', COMSPEC: 'C:\\cmd.exe', SYSTEMROOT: 'C:\\Windows', ...fixed });
  // Missing variables are omitted, not passed as undefined or empty.
  assert.deepEqual(isolatedGitEnv({ isoDir: iso, source: {}, platform: 'linux' }), fixed);
});

test('the isolated git ignores a hostile environment: GIT_DIR, a template with a hook, an allow-everything protocol list', () => {
  const dir = scratch('cp-upd-iso');
  const iso = isoDir();
  const template = join(dir, 'template');
  mkdirSync(join(template, 'hooks'), { recursive: true });
  writeFileSync(join(template, 'hooks', 'post-checkout'), '#!/bin/sh\ntouch "$0.ran"\n');
  const saved = { ...process.env };
  Object.assign(process.env, {
    GIT_DIR: join(dir, 'elsewhere'), GIT_TEMPLATE_DIR: template, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(template, 'hooks'),
  });
  try {
    const repo = join(dir, 'repo');
    const init = isolatedGit(['init', '--quiet', '--template=', repo], { isoDir: iso, cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    assert.equal(existsSync(join(repo, '.git')), true, 'GIT_DIR did not redirect the init');
    assert.equal(existsSync(join(repo, '.git', 'hooks', 'post-checkout')), false, 'the empty template copied nothing in');
    // The file transport is closed unless the test seam opens it, whatever GIT_ALLOW_PROTOCOL says.
    const { bare } = remote();
    assert.notEqual(isolatedGit(['ls-remote', bare], { isoDir: iso, cwd: dir }).code, 0);
    assert.equal(isolatedGit(['ls-remote', bare], { isoDir: iso, cwd: dir, allowFile: true }).code, 0);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// A caller whose own git configuration (global config AND ~/.gitconfig) points core.hooksPath at a directory holding a
// post-checkout hook that writes a marker. Control: plain git runs it. Isolated git must not.
// Runs on Windows too: Git for Windows executes a `#!/bin/sh` hook through its bundled sh, so the hook (and the paths
// inside it) are written with forward slashes. The control below fails loudly on any platform where the hook is not a
// real vector, which keeps the assertions that follow it from passing vacuously.
const fwd = (p) => p.replace(/\\/g, '/');
function plantedHookConfig(dir) {
  const hooks = join(dir, 'planted-hooks');
  const marker = join(dir, 'hook-ran');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran >> "${fwd(marker)}"\n`, { mode: 0o755 });
  chmodSync(join(hooks, 'post-checkout'), 0o755);
  const home = join(dir, 'planted-home');
  mkdirSync(home);
  const config = `[core]\n\thooksPath = ${fwd(hooks)}\n`;
  writeFileSync(join(home, '.gitconfig'), config);
  const global = join(dir, 'planted-global.gitconfig');
  writeFileSync(global, config);
  return { marker, home, global };
}
const CHECKOUT = ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'];

test('a post-checkout hook in the CALLER\'s configured hooksPath (global config and ~/.gitconfig) does not run', () => {
  const dir = scratch('cp-upd-hook');
  const { marker, home, global } = plantedHookConfig(dir);
  const { bare, sha } = remote();
  const callerEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  // Control: with the caller's configuration, the same fetch + checkout DOES run the hook, so the assertions below can fail.
  const plain = join(dir, 'plain');
  for (const args of [['init', '--quiet', plain], ['-C', plain, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--depth', '1', bare, sha], ['-C', plain, ...CHECKOUT]]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: callerEnv });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(existsSync(marker), true, 'control: the planted hook is a real vector on this git');
  rmSync(marker);

  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: global });
  try {
    withIsolatedGit(scratch('cp-upd-hookhome'), (git) => {
      const repo = join(dir, 'repo');
      assert.equal(git(['init', '--quiet', '--template=', repo], { cwd: dir }).code, 0);
      const fetch = git(['-C', repo, 'fetch', '--quiet', '--depth', '1', '--no-tags', bare, sha], { cwd: dir, allowFile: true });
      assert.equal(fetch.code, 0, fetch.stderr);
      const checkout = git(['-C', repo, ...CHECKOUT], { cwd: dir });
      assert.equal(checkout.code, 0, checkout.stderr);
      assert.equal(git(['-C', repo, 'rev-parse', 'HEAD']).stdout.trim(), sha);
    });
    assert.equal(existsSync(marker), false, 'the caller\'s hook ran');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('update: a hook planted in the caller\'s git configuration does not run, and the private git directory is removed', async () => {
  const dir = scratch('cp-upd-hookupd');
  const { marker, home: plantedHome, global } = plantedHookConfig(dir);
  const { sha } = remote();
  const home = newHome();
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  Object.assign(process.env, { HOME: plantedHome, GIT_CONFIG_GLOBAL: global });
  try {
    const { result: r, left } = await withTmp(home, () => update(['--claude-home', home], { env: envFor(ghFor(sha, cmp('identical', sha, sha))) }));
    assert.equal(r.exitCode, 0, JSON.stringify(r.output));
    assert.equal(existsSync(marker), false, 'the caller\'s hook ran during update');
    assert.deepEqual(left, [], 'neither the download nor the private git directory is left');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('mainSha: the git fallback uses a private directory per call under the home, removes it, and never touches the OS temp dir', async () => {
  const { sha, bare } = remote();
  const down = createFakeGh([{ match: '.*', stderr: 'HTTP 502', code: 1 }]);
  const home = scratch('cp-upd-mshome');
  const { result, left } = await withTmp(home, () => [mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: bare }), home }), mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: bare }), home })]);
  assert.deepEqual(result, [{ ok: true, sha, via: 'git' }, { ok: true, sha, via: 'git' }]);
  assert.deepEqual(left, []);
  const failing = await withTmp(home, () => mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: join(scratch('cp-upd-void'), 'nope.git') }), home }));
  assert.equal(failing.result.ok, false);
  assert.deepEqual(failing.left, [], 'removed after a failed lookup too');
});

test('mainSha: when the trusted private root cannot be established, the git fallback is unavailable (no home, a symlinked root, a blocked state dir) and nothing falls back to os.tmpdir()', async () => {
  const { bare } = remote();
  const down = createFakeGh([{ match: '.*', stderr: 'HTTP 502', code: 1 }]);
  const env = envFor(down, { PIPELINE_UPDATE_REMOTE: bare });
  const unavailable = (m) => { assert.equal(m.ok, false); assert.match(m.reason, /git unavailable/); };
  const canary = scratch('cp-upd-canary');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: canary, TEMP: canary, TMP: canary });
  try {
    unavailable(mainSha({ env }));
    const linked = scratch('cp-upd-linkhome');
    const elsewhere = scratch('cp-upd-elsewhere');
    mkdirSync(join(linked, 'pipeline-state'));
    symlinkSync(elsewhere, tmpRootOf(linked), process.platform === 'win32' ? 'junction' : 'dir');
    unavailable(mainSha({ env, home: linked }));
    const blocked = scratch('cp-upd-blockhome');
    writeFileSync(join(blocked, 'pipeline-state'), 'a file where the state directory should be');
    unavailable(mainSha({ env, home: blocked }));
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing was made through the symlink');
    assert.deepEqual(readdirSync(canary).filter((n) => n.startsWith('claude-pipeline-')), [], 'nothing fell back to the OS temp dir');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// The hook test above uses core.hooksPath, which the isolated git ALSO sets on its command line - so it would pass even
// if the caller's config were loaded. This one is configuration-sensitive: the caller's config rewrites a URL
// (`url.<real>.insteadOf = <decoy>`), which nothing on the command line overrides. A plain git must follow the rewrite
// (control); the isolated git must not load that config at all, wherever the caller put it: GIT_CONFIG_GLOBAL, ~/.gitconfig,
// $XDG_CONFIG_HOME/git/config, or a file pulled in by include.path.
test('the caller\'s git configuration is not LOADED by the isolated git: a url rewrite in any global location has no effect', () => {
  const dir = scratch('cp-upd-rewrite');
  const { bare: real, sha: realSha } = remote();
  const work = join(dir, 'decoy-work');
  mkdirSync(work);
  git(work, ['init', '--quiet']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'decoy']);
  const decoy = join(dir, 'decoy.git');
  git(work, ['clone', '--quiet', '--bare', work, decoy]);
  const decoySha = git(work, ['rev-parse', 'HEAD']);
  assert.notEqual(decoySha, realSha);
  // One spelling everywhere: url rewrites match the prefix literally, so the config and the URLs handed to git (control
  // and isolated alike) must both use the forward-slash form or, on Windows, the rewrite silently never applies.
  const rewrite = `[url "${fwd(real)}"]\n\tinsteadOf = ${fwd(decoy)}\n`;

  const scenarios = {
    'GIT_CONFIG_GLOBAL': (d) => { const f = join(d, 'g.gitconfig'); writeFileSync(f, rewrite); return { GIT_CONFIG_GLOBAL: f }; },
    '$HOME/.gitconfig': (d) => { writeFileSync(join(d, '.gitconfig'), rewrite); return {}; },
    '$XDG_CONFIG_HOME/git/config': (d) => { mkdirSync(join(d, 'xdg', 'git'), { recursive: true }); writeFileSync(join(d, 'xdg', 'git', 'config'), rewrite); return { XDG_CONFIG_HOME: join(d, 'xdg') }; },
    'include.path from $HOME/.gitconfig': (d) => { writeFileSync(join(d, 'included'), rewrite); writeFileSync(join(d, '.gitconfig'), `[include]\n\tpath = ${fwd(join(d, 'included'))}\n`); return {}; },
  };
  for (const [where, plant] of Object.entries(scenarios)) {
    const d = scratch('cp-upd-rw');
    const planted = plant(d);
    const callerEnv = { HOME: d, USERPROFILE: d, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: undefined, XDG_CONFIG_HOME: undefined, ...planted };
    const names = Object.keys(callerEnv);
    // Control: a plain git with that config follows the rewrite, so the isolated answer below is a real signal.
    const plainEnv = Object.fromEntries(Object.entries({ ...process.env, ...callerEnv }).filter(([, v]) => v !== undefined));
    const control = spawnSync('git', ['ls-remote', fwd(decoy), 'refs/heads/main'], { cwd: dir, encoding: 'utf8', env: plainEnv });
    assert.equal(control.status, 0, `${where}: ${control.stderr}`);
    assert.match(control.stdout, new RegExp(`^${realSha}`), `control (${where}): the rewrite is a real vector on this git`);

    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) { if (callerEnv[n] === undefined) delete process.env[n]; else process.env[n] = callerEnv[n]; }
    try {
      withIsolatedGit(scratch('cp-upd-rwhome'), (g, iso) => {
        const ls = g(['ls-remote', fwd(decoy), 'refs/heads/main'], { cwd: iso, allowFile: true });
        assert.equal(ls.code, 0, `${where}: ${ls.stderr}`);
        assert.match(ls.stdout, new RegExp(`^${decoySha}`), `${where}: the isolated git followed the caller's url rewrite (global config was loaded)`);
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
});

// The Claude home may sit INSIDE a git checkout (a ~/.claude symlinked into a dotfiles repo). Git looks for a repository
// from its working directory upward and loads that repository's LOCAL config, which GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL
// do not suppress - so the isolated calls (whose cwd is under the home) must be stopped from ascending into it
// (GIT_CEILING_DIRECTORIES). The outer repo's config rewrites the REAL upstream URL to a decoy bare repo.
function nestedHome() {
  const dir = scratch('cp-upd-nest');
  const { bare: real, sha: realSha } = remote();
  const work = join(dir, 'decoy-work');
  mkdirSync(work);
  git(work, ['init', '--quiet']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'decoy']);
  const decoy = join(dir, 'decoy.git');
  git(work, ['clone', '--quiet', '--bare', work, decoy]);
  const decoySha = git(work, ['rev-parse', 'HEAD']);
  assert.notEqual(decoySha, realSha);
  const outer = join(dir, 'dotfiles');
  mkdirSync(outer);
  git(outer, ['init', '--quiet']);
  // Written to the repo's own .git/config: the one place neither GIT_CONFIG_GLOBAL nor NOSYSTEM reaches.
  writeFileSync(join(outer, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[url "${fwd(decoy)}"]\n\tinsteadOf = ${fwd(real)}\n`, { flag: 'a' });
  const home = join(outer, 'claude');
  mkdirSync(join(home, 'pipeline-state', 'tmp'), { recursive: true });
  // Control: plain git run from under that home follows the rewrite, so a real answer from the isolated git means something.
  const control = spawnSync('git', ['ls-remote', fwd(real), 'refs/heads/main'], { cwd: join(home, 'pipeline-state', 'tmp'), encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout, new RegExp(`^${decoySha}`), 'control: the outer repository\'s url rewrite is a real vector on this git');
  return { home, real, realSha, decoySha };
}

test('a Claude home nested inside a git checkout: its local config (url rewrite) is not loaded by mainSha or by update', async () => {
  const { home, real, realSha } = nestedHome();
  const down = createFakeGh([{ match: '.*', stderr: 'HTTP 502', code: 1 }]);
  const via = mainSha({ env: envFor(down, { PIPELINE_UPDATE_REMOTE: fwd(real) }), home });
  assert.deepEqual(via, { ok: true, sha: realSha, via: 'git' }, 'mainSha followed the outer repository\'s rewrite');
  // fetchSource (init + fetch + checkout, with -C into the download) under the same nesting.
  const r = await update(['--claude-home', home], { env: envFor(ghFor(realSha, cmp('identical', realSha, realSha)), { PIPELINE_UPDATE_REMOTE: fwd(real) }) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(readManifest(home).sourceSha, realSha);
});

test('PIPELINE_UPDATE_REMOTE is a seam: honoured by a checkout, ignored (with the real URL used) by an installed copy', () => {
  assert.deepEqual(fetchRemote({ PIPELINE_UPDATE_REMOTE: '/some/where.git' }), { url: '/some/where.git', local: true });
  assert.deepEqual(fetchRemote({}), { url: UPSTREAM_URL, local: false });
  const root = scratch('cp-upd-installed');
  writeFileSync(join(root, 'INSTALLED.json'), '{}');
  assert.equal(seamValue('PIPELINE_UPDATE_REMOTE', { PIPELINE_UPDATE_REMOTE: '/x' }, { root, warn: () => {} }), undefined);
});

test('a hostile GIT_EXEC_PATH is not honoured: the program planted there is never run by the isolated fetch', { skip: process.platform === 'win32' }, () => {
  const dir = scratch('cp-upd-exec');
  const iso = isoDir();
  const planted = join(dir, 'exec');
  const marker = join(dir, 'ran');
  mkdirSync(planted);
  // git looks for git-upload-pack / git-remote-* in GIT_EXEC_PATH first; both plant a marker and then do nothing useful.
  for (const name of ['git-upload-pack', 'git-remote-https', 'git-remote-file']) {
    writeFileSync(join(planted, name), `#!/bin/sh\necho "${name}" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  }
  const { bare, sha } = remote();
  const saved = process.env.GIT_EXEC_PATH;
  // Control: an unisolated git with the same variable DOES run the planted program, so the next assertions can fail.
  spawnSync('git', ['ls-remote', bare], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EXEC_PATH: planted } });
  assert.equal(existsSync(marker), true, 'control: the hostile GIT_EXEC_PATH is a real vector on this git');
  rmSync(marker);
  process.env.GIT_EXEC_PATH = planted;
  try {
    const ls = isolatedGit(['ls-remote', bare, 'refs/heads/main'], { isoDir: iso, cwd: dir, allowFile: true });
    assert.equal(ls.code, 0, ls.stderr);
    assert.match(ls.stdout, new RegExp(`^${sha}`));
    const repo = join(dir, 'repo');
    assert.equal(isolatedGit(['init', '--quiet', '--template=', repo], { isoDir: iso, cwd: dir }).code, 0);
    const fetch = isolatedGit(['-C', repo, 'fetch', '--quiet', '--depth', '1', '--no-tags', bare, sha], { isoDir: iso, cwd: dir, allowFile: true });
    assert.equal(fetch.code, 0, fetch.stderr);
    assert.equal(existsSync(marker), false, 'the planted program ran');
  } finally {
    if (saved === undefined) delete process.env.GIT_EXEC_PATH; else process.env.GIT_EXEC_PATH = saved;
  }
});

test('GIT_SSH_COMMAND, GIT_CONFIG, GIT_EXTERNAL_DIFF and proxy variables in the process environment do not reach the isolated git', () => {
  const probe = '/nonexistent/probe';
  const names = ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG', 'GIT_EXTERNAL_DIFF', 'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'HTTPS_PROXY'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) process.env[n] = probe;
  try {
    const env = isolatedGitEnv({ isoDir: isoDir() });
    for (const n of names) assert.equal(n in env, false, n);
  } finally {
    for (const n of names) if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
  }
});

test('the installer child does not inherit NODE_OPTIONS or NODE_PATH, and keeps the rest of the environment', () => {
  const env = installerEnv({ NODE_OPTIONS: '--require x', node_path: '/x', NODE_PATH: '/y', PIPELINE_ADMIN: '1', PIPELINE_LOCK_DIR: '/l', PIPELINE_INSTALL_NO_PROBES: '1', PATH: '/p', GONE: undefined });
  assert.deepEqual(env, { PIPELINE_ADMIN: '1', PIPELINE_LOCK_DIR: '/l', PIPELINE_INSTALL_NO_PROBES: '1', PATH: '/p' });
});

test('update: NODE_OPTIONS=--require in the caller environment does not run inside the installer', async () => {
  const dir = scratch('cp-upd-nodeopt');
  const marker = join(dir, 'loaded');
  const inject = join(dir, 'inject.cjs');
  writeFileSync(inject, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[1] + '\\n');\n`);
  // Control: Node itself honours the variable, so a stripped child is what keeps the marker away.
  const stub = join(dir, 'install.mjs');
  writeFileSync(stub, '');
  spawnSync(process.execPath, [stub], { env: { ...process.env, NODE_OPTIONS: `--require ${inject}` } });
  assert.match(readFileSync(marker, 'utf8'), /install\.mjs/, 'control: NODE_OPTIONS --require runs in a child');
  rmSync(marker);
  const { sha } = remote();
  const home = newHome();
  const r = await update(['--claude-home', home], { env: envFor(ghFor(sha, cmp('identical', sha, sha)), { NODE_OPTIONS: `--require ${inject}` }) });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  // The fake gh (a node script `update` itself runs, with the caller's environment) may load it; the installer must not.
  assert.doesNotMatch(existsSync(marker) ? readFileSync(marker, 'utf8') : '', /install\.mjs/, 'the injected module ran inside the installer');
});

test('the suggested manual command quotes the home so sh (and PowerShell) read it back as one literal argument', { skip: process.platform === 'win32' }, () => {
  for (const s of ["/home/Jane O'Doe/.claude", 'C:\\Users\\Jane Doe\\.claude', '/tmp/$(touch x); `id` "q" * ~ & | ;']) {
    const r = spawnSync('sh', ['-c', `printf '%s' ${shQuote(s)}`], { encoding: 'utf8' });
    assert.equal(r.stdout, s);
  }
  assert.equal(psQuote("C:\\Users\\Jane O'Doe\\.claude"), "'C:\\Users\\Jane O''Doe\\.claude'");
});
