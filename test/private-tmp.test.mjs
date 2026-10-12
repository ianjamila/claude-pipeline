// Why: the scratch directories `pipeline update` makes (the git config/hooks one and the download the installer is then
// run from) are code-execution vectors if another account can write into them, so they live in a trusted root under
// the Claude home (<home>/pipeline-state/tmp) that is validated with lstat and fails closed. These tests pin that: the
// root is where it should be and nowhere near os.tmpdir(), a symlink or a foreign owner is refused, a loose mode on our
// own directory is tightened, a swapped-in iso directory is refused, stale leftovers of ours are swept (and only ours),
// and `pipeline update` stops cleanly when the root cannot be established.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, chownSync, renameSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as update } from '../pipeline/commands/update.mjs';
import { assertPrivateDir, makePrivateTmpDir, privateTmpRoot, STALE_MS, sweepStale, TMP_ROOT_REL } from '../pipeline/lib/private-tmp.mjs';
import { isolatedGitArgs, isolatedGitEnv, makeIsoDir } from '../pipeline/lib/upstream.mjs';
import { createFakeGh } from './helpers/fakegh-env.mjs';

const posix = process.platform !== 'win32';
const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scratch(label = 'cp-ptmp') {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
}
const LINK = process.platform === 'win32' ? 'junction' : 'dir';

test('the root is <home>/pipeline-state/tmp: made once, 0700, with scratch dirs inside it and nothing in os.tmpdir()', () => {
  const home = scratch();
  const canary = scratch('cp-ptmp-canary');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: canary, TEMP: canary, TMP: canary });
  try {
    const root = privateTmpRoot(home);
    assert.equal(root, join(home, TMP_ROOT_REL));
    assert.equal(privateTmpRoot(home), root, 'idempotent');
    const a = makePrivateTmpDir(home, 'claude-pipeline-update-');
    const b = makePrivateTmpDir(home, 'claude-pipeline-update-');
    assert.notEqual(a, b);
    assert.equal(a.startsWith(join(root, 'claude-pipeline-update-')), true);
    if (posix) for (const d of [root, a, b]) assert.equal(lstatSync(d).mode & 0o777, 0o700, d);
    assert.deepEqual(readdirSync(canary), [], 'os.tmpdir() is never used');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the root fails closed: no home, a missing home, a home that is a file', () => {
  assert.throws(() => privateTmpRoot(undefined), /Claude home/);
  assert.throws(() => privateTmpRoot(''), /Claude home/);
  assert.throws(() => makePrivateTmpDir(undefined, 'x-'), /Claude home/);
  const home = scratch();
  assert.throws(() => privateTmpRoot(join(home, 'nope')), /ENOENT/);
  assert.equal(existsSync(join(home, 'nope')), false, 'a missing home is not created');
  writeFileSync(join(home, 'file'), 'x');
  assert.throws(() => privateTmpRoot(join(home, 'file')), /not a directory/);
});

test('a symlinked home is allowed (dotfiles), but a symlinked state dir or root is refused and never followed', () => {
  const real = scratch();
  const viaLink = join(scratch(), 'claude');
  symlinkSync(real, viaLink, LINK);
  assert.equal(privateTmpRoot(viaLink), join(viaLink, TMP_ROOT_REL), 'a symlinked home is trusted as given');
  assert.equal(lstatSync(join(real, TMP_ROOT_REL)).isDirectory(), true);

  const elsewhere = scratch('cp-ptmp-target');
  const rootLink = scratch();
  mkdirSync(join(rootLink, 'pipeline-state'));
  symlinkSync(elsewhere, join(rootLink, TMP_ROOT_REL), LINK);
  assert.throws(() => privateTmpRoot(rootLink), /symbolic link/);
  assert.throws(() => makePrivateTmpDir(rootLink, 'claude-pipeline-git-'), /symbolic link/);
  assert.throws(() => makeIsoDir(rootLink), /symbolic link/);

  const stateLink = scratch();
  symlinkSync(elsewhere, join(stateLink, 'pipeline-state'), LINK);
  assert.throws(() => privateTmpRoot(stateLink), /symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was created through either symlink');
});

test('a root that is a plain file is refused', () => {
  const home = scratch();
  mkdirSync(join(home, 'pipeline-state'));
  writeFileSync(join(home, TMP_ROOT_REL), 'x');
  assert.throws(() => privateTmpRoot(home), /not a directory/);
});

test('a loose mode on a root we own is tightened to 0700; a group/other-writable state dir loses that write', { skip: !posix }, () => {
  const home = scratch();
  const root = privateTmpRoot(home);
  chmodSync(root, 0o755);
  chmodSync(join(home, 'pipeline-state'), 0o777);
  assert.equal(privateTmpRoot(home), root);
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(home, 'pipeline-state')).mode & 0o022, 0);
});

test('a root owned by another user is refused, not repaired', { skip: !posix || typeof process.getuid !== 'function' || process.getuid() !== 0 }, () => {
  // Only testable as root (chown to a foreign uid); everywhere else the owner comparison is exercised by the unit above.
  const home = scratch();
  const root = privateTmpRoot(home);
  chownSync(root, 65534, 65534);
  assert.throws(() => privateTmpRoot(home), /owned by another user/);
});

test('assertPrivateDir: a real directory passes; a symlink to one is refused; on POSIX a group-readable one is refused', () => {
  const dir = scratch();
  assert.doesNotThrow(() => assertPrivateDir(dir, 'x'));
  const link = join(scratch(), 'link');
  symlinkSync(dir, link, LINK);
  assert.throws(() => assertPrivateDir(link, 'x'), /symbolic link/);
  if (posix) {
    chmodSync(dir, 0o750);
    assert.throws(() => assertPrivateDir(dir, 'x'), /accessible to other users/);
  }
});

test('isolated git refuses an iso dir that was swapped for a symlink, or whose hooks/config were swapped for symlinks', () => {
  const home = scratch();
  const iso = makeIsoDir(home);
  assert.doesNotThrow(() => isolatedGitArgs({ isoDir: iso }));
  const target = scratch('cp-ptmp-swap');
  mkdirSync(join(target, 'hooks'));
  writeFileSync(join(target, 'empty.gitconfig'), '');

  // the whole directory replaced by a symlink to a look-alike
  const parked = `${iso}.parked`;
  renameSync(iso, parked);
  symlinkSync(target, iso, LINK);
  assert.throws(() => isolatedGitArgs({ isoDir: iso }), /symbolic link|not a private directory/);
  assert.throws(() => isolatedGitEnv({ isoDir: iso }), /symbolic link|not a private directory/);
  rmSync(iso);
  renameSync(parked, iso);

  // hooks/ replaced by a symlink to a directory
  rmSync(join(iso, 'hooks'), { recursive: true });
  symlinkSync(join(target, 'hooks'), join(iso, 'hooks'), LINK);
  assert.throws(() => isolatedGitArgs({ isoDir: iso }), /not a private directory/);
  rmSync(join(iso, 'hooks'));
  mkdirSync(join(iso, 'hooks'));

  // empty.gitconfig replaced by a symlink to a file (file symlinks need no privilege on POSIX; skip on Windows)
  if (posix) {
    rmSync(join(iso, 'empty.gitconfig'));
    symlinkSync(join(target, 'empty.gitconfig'), join(iso, 'empty.gitconfig'));
    assert.throws(() => isolatedGitEnv({ isoDir: iso }), /not a private directory/);
  }
});

test('sweepStale removes only our own old directories: prefix, age, real directory, our uid; never follows a symlink', () => {
  const home = scratch();
  const root = privateTmpRoot(home);
  const now = Date.now();
  const old = new Date(now - STALE_MS - 60_000);
  const make = (name, { age = old } = {}) => {
    const d = join(root, name);
    mkdirSync(d);
    writeFileSync(join(d, 'f'), 'x');
    utimesSync(d, age, age);
    return d;
  };
  const staleGit = make('claude-pipeline-git-OLD111');
  const staleUpd = make('claude-pipeline-update-OLD222');
  const young = make('claude-pipeline-git-NEW333', { age: new Date(now - 60_000) });
  const stranger = make('somebody-elses-OLD444');
  const target = scratch('cp-ptmp-keep');
  writeFileSync(join(target, 'precious'), 'x');
  const link = join(root, 'claude-pipeline-update-LINK555');
  symlinkSync(target, link, LINK);
  sweepStale(root, { now });
  assert.equal(existsSync(staleGit), false);
  assert.equal(existsSync(staleUpd), false);
  assert.equal(existsSync(young), true, 'younger than 24h: possibly a live run');
  assert.equal(existsSync(stranger), true, 'not our prefix');
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'a symlink is left alone');
  assert.equal(existsSync(join(target, 'precious')), true, 'and never followed');
  // opening the root sweeps too
  const again = make('claude-pipeline-git-OLD666');
  assert.equal(privateTmpRoot(home), root);
  assert.equal(existsSync(again), false);
  assert.doesNotThrow(() => sweepStale(join(home, 'no-such-root')), 'an unreadable root is not an error');
});

test('update: when the trusted root cannot be established it stops before any fetch or install, and writes through nothing', async () => {
  const REPO_SHA = 'a'.repeat(40);
  const userHome = scratch('cp-ptmp-user');
  const home = join(scratch(), 'claude');
  mkdirSync(join(home, 'pipeline-state'), { recursive: true });
  const elsewhere = scratch('cp-ptmp-target');
  symlinkSync(elsewhere, join(home, TMP_ROOT_REL), LINK);
  const fake = createFakeGh([{ match: 'commits/main', stdout: `${REPO_SHA}\n` }]);
  const env = {
    ...process.env, ...(fake.env ?? {}), HOME: userHome, USERPROFILE: userHome, PIPELINE_ADMIN: '1', PIPELINE_INSTALL_NO_PROBES: '1',
    PIPELINE_LOCK_DIR: scratch('cp-ptmp-lock'), PIPELINE_MACHINE_ID: 'test-machine-id', PIPELINE_UPDATE_REMOTE: join(scratch(), 'never.git'),
  };
  delete env.CLAUDECODE;
  const r = await update(['--claude-home', home], { env });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error, 'fetch-failed');
  assert.match(r.output.message, /private scratch directory/);
  assert.match(r.output.message, /symbolic link/);
  assert.equal(r.output.install, null);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(existsSync(join(home, 'pipeline')), false);
});

