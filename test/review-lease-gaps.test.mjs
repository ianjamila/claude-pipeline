// Plan 2026-11-10 B6, the review-lease checklist items the other lease tests do not reach (test/review-lease.test.mjs, test/review-lease-wiring.test.mjs and
// test/install-admission.test.mjs hold the rest):
//   - the EXISTING frozen file guard denies an agent's write/rm/mv of a lease file or the admission lock (behaviour pinned; the guard is not edited);
//   - crash recovery with a real process: a session killed mid-review leaves a lease that is void at the next scan (the real `ps`, not an injected table);
//   - a manual `pipeline update` (the installer without --require-no-live-reviews) is not blocked by lease renewals or by admission being held, and a
//     review command's lease renewal is not blocked by a manual install in progress (it takes no admission).
// Fake HOME + USERPROFILE for every child, process.execPath to spawn, POSIX-only parts skip on win32.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBashForFiles, evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';
import { scanLiveWork } from '../pipeline/lib/live-work-scan.mjs';
import { ADMISSION_LOCK, LEASES_REL, acquireAdmission, blocking, leasesDir, openOrRenewLease, releaseAdmission, scanLeases, sweepDeadLeases } from '../pipeline/lib/review-lease.mjs';
import { psStarts } from '../pipeline/lib/worktree-prune/live-sessions.mjs';

const POSIX = process.platform !== 'win32';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(REPO, 'install.mjs');
const FIXTURE = join(REPO, 'test', 'fixtures', 'src-tree');
const MACHINE = 'test-machine-id';
process.env.PIPELINE_MACHINE_ID ||= MACHINE;

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = (label = 'cp-lgap') => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}

// ---- the frozen guard protects the lease folder (pinned, not changed) ---------------------------------------------------------------------

const LINUX = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const fileVerdict = (tool_name, tool_input) => evaluateFileTool({ tool_name, tool_input, cwd: '/repo' }, LINUX).decision;
const bashVerdict = (command) => evaluateBashForFiles(command, { ...LINUX, cwd: '/repo' }).decision;

test('guard: the lease folder is inside the protected owner-go namespace, so an agent cannot Write, Edit, rm, mv, redirect into or link over a lease file or the admission lock; reading stays open', () => {
  const L = `/home/u/.claude/pipeline-state/owner-go/review-leases`;
  assert.equal(L, `/home/u/.claude/pipeline-state/${LEASES_REL.replace(/^.*owner-go/, 'owner-go')}`, 'the folder the guard test names is the one the library uses');
  assert.equal(leasesDir({ home: '/home/u', env: {} }).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''), L);
  for (const [tool, input] of [
    ['Write', { file_path: `${L}/sess-1.json`, content: '{}' }],
    ['Write', { file_path: `~/.claude/pipeline-state/owner-go/review-leases/sess-1.json`, content: '{}' }],
    ['Edit', { file_path: `${L}/sess-1.json`, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: `${L}/sess-1.json`, edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['Write', { file_path: `${L}/${ADMISSION_LOCK}.lock/owner.json`, content: '{}' }],
  ]) assert.equal(fileVerdict(tool, input), 'deny', `${tool} ${input.file_path}`);
  for (const cmd of [
    `rm ${L}/sess-1.json`,
    `rm -f ${L}/sess-1.json`,
    `rm -rf ${L}`,
    `rm -rf ${L}/${ADMISSION_LOCK}.lock`,
    'rm -rf ~/.claude/pipeline-state/owner-go/review-leases/sess-1.json',
    `mv ${L}/sess-1.json /tmp/x.json`,
    `echo '{}' > ${L}/sess-1.json`,
    `echo '{}' >> ${L}/sess-1.json`,
    `cp /tmp/forged.json ${L}/sess-1.json`,
    `tee ${L}/sess-1.json < /tmp/forged.json`,
    `ln -sf /tmp/forged.json ${L}/sess-1.json`,
    `ln -s /tmp/mine ${L}`,
    'rm -rf ~/.claude/pipeline-state',
  ]) assert.equal(bashVerdict(cmd), 'deny', cmd);
  for (const cmd of [`ls -la ${L}`, `cat ${L}/sess-1.json`, `grep -r pr ${L}`]) assert.equal(bashVerdict(cmd), 'allow', cmd);
});

// ---- crash recovery, with a real process and the real `ps` --------------------------------------------------------------------------------

test('crash recovery: a session killed mid-review leaves a lease that is void at the next scan (real process, real ps), and the installer scan then reports nothing', { skip: !POSIX }, async (t) => {
  const root = scratch();
  const dir = join(root, 'review-leases');
  const home = join(root, 'home');
  const wt = join(root, 'wt');
  const locks = join(root, 'locks');
  for (const d of [home, wt, locks]) mkdirSync(d, { recursive: true });
  const session = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  t.after(() => { try { session.kill('SIGKILL'); } catch { /* gone */ } });
  const closed = new Promise((resolve) => session.on('close', resolve));
  const started = psStarts([session.pid]);
  assert.ok(started?.get(session.pid), 'ps answers for the running process');
  const opts = { dir, home, env: { CLAUDECODE: '1' }, ancestorPid: session.pid, sessionRecord: () => ({ sessionId: 'sess-crash', procStart: started.get(session.pid) }), jobLive: () => false };
  await openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...opts });

  assert.equal(blocking(scanLeases(opts)).length, 1, 'while the session lives its lease is live');
  const during = scanLiveWork({ env: { PIPELINE_LOCK_DIR: locks }, home, repos: [], leaseOpts: opts });
  assert.deepEqual(during.map((e) => e.kind), ['lease']);

  session.kill('SIGKILL'); // no handler runs: nothing closes the lease
  await closed;
  const scan = scanLeases(opts);
  assert.deepEqual(blocking(scan), [], 'the lease is void at the next scan');
  assert.match(scan.dead[0].why, /gone/);
  assert.deepEqual(scanLiveWork({ env: { PIPELINE_LOCK_DIR: locks }, home, repos: [], leaseOpts: opts }), [], 'nothing defers the update any more');
  const swept = await sweepDeadLeases(opts);
  assert.deepEqual(swept.removed.map((e) => e.sessionId), ['sess-crash']);
  assert.equal(existsSync(join(dir, 'sess-crash.json')), false);
});

// ---- a manual `pipeline update` and review commands do not block each other --------------------------------------------------------------

// A `ps` that knows no Claude Code ancestor, first on the child's PATH (the suite may itself run inside Claude Code).
const FAKE_PS_DIR = (() => {
  if (!POSIX) return null;
  const d = scratch('cp-lgap-ps');
  writeFileSync(join(d, 'ps'), ['#!/usr/bin/env node', 'const a = process.argv.slice(2);', "console.log(a.includes('args=') ? 'zsh' : '1 zsh');"].join('\n'));
  chmodSync(join(d, 'ps'), 0o755);
  return d;
})();

function world() {
  const root = scratch();
  const w = { root, account: join(root, 'account'), src: join(root, 'src'), leases: join(root, 'leases'), locks: join(root, 'locks'), userHome: join(root, 'uh'), gate: join(root, 'gate') };
  w.home = join(w.account, '.claude');
  for (const d of [w.account, w.locks, w.userHome, w.gate]) mkdirSync(d, { recursive: true });
  cpSync(FIXTURE, w.src, { recursive: true });
  w.lease = { dir: w.leases, home: w.account, env: { CLAUDECODE: '1' }, ancestorPid: null, waitMs: 150 };
  return w;
}
function childEnv(w, extra = {}) {
  const env = {
    ...process.env, HOME: w.userHome, USERPROFILE: w.userHome, PIPELINE_INSTALL_NO_PROBES: '1', PIPELINE_TEST_MODE: '1', PIPELINE_MACHINE_ID: MACHINE,
    PIPELINE_INSTALL_ACCOUNT_HOME: w.account, PIPELINE_REVIEW_LEASE_DIR: w.leases, PIPELINE_LOCK_DIR: w.locks,
  };
  for (const k of ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'FAKE_PS_TABLE']) delete env[k];
  if (FAKE_PS_DIR) env.PATH = `${FAKE_PS_DIR}${delimiter}${env.PATH}`;
  return Object.assign(env, extra);
}
const installArgs = (w, extra = []) => [INSTALL, '--claude-home', w.home, '--source', w.src, '--json', ...extra];
const installed = (w) => existsSync(join(w.home, 'pipeline', 'INSTALLED.json'));
const open = (w, extra = {}) => openOrRenewLease({ worktree: join(w.root, 'wt'), repoId: 'acme/app', pr: 7, ...w.lease, ...extra });

test('a manual install (no --require-no-live-reviews) is not blocked by a live lease or by admission being held for a lease renewal, and never touches the lease', async (t) => {
  const w = world();
  await open(w); // a live review: it would DEFER the unattended install
  const held = await acquireAdmission({ dir: w.leases, home: w.account, waitMs: 0 }); // a review command's brief renewal, in the middle of it
  t.after(() => releaseAdmission(held));
  const r = spawnSync(process.execPath, installArgs(w), { encoding: 'utf8', env: childEnv(w), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).ok, true);
  assert.equal(installed(w), true);
  assert.equal(blocking(scanLeases({ ...w.lease, ancestorPid: null })).length, 1, 'the lease is still there: a manual install does not sweep or judge leases');
});

test('while a manual install is mid-swap (it holds the install lock, not admission) a review command can still open and renew its lease', async (t) => {
  const w = world();
  const child = spawn(process.execPath, installArgs(w), { env: childEnv(w, { PIPELINE_INSTALL_SWAP_GATE: w.gate }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('close', (status) => resolve(status)));
  await until(() => existsSync(join(w.gate, 'reached')), 'the swap gate');
  const started = Date.now();
  const first = await open(w, { waitMs: 5_000 });
  const again = await open(w, { waitMs: 5_000 });
  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  assert.equal(again.generation, first.generation, 'the second call renewed the same lease');
  assert.ok(Date.now() - started < 4_000, 'neither call waited on the installer');
  writeFileSync(join(w.gate, 'go'), '');
  assert.equal(await exited, 0, out);
  assert.equal(JSON.parse(out).ok, true);
  assert.equal(JSON.parse(readFileSync(join(w.home, 'pipeline', 'INSTALLED.json'), 'utf8')).complete, true);
  assert.equal(blocking(scanLeases({ ...w.lease, ancestorPid: null })).length, 1, 'the lease survived the install');
});
