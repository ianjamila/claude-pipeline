// The review leases wired into the real CLI (lib/review-lease-wiring.mjs, bin/pipeline.mjs; plan 2026-11-10, PR B1 "Lifecycle"). Everything runs the real
// pipeline binary against throwaway git repos and a scratch lease folder (PIPELINE_REVIEW_LEASE_DIR, honoured by a checkout only), as a Claude Code session
// the CLI cannot place (a session marker in the environment and a `ps` that finds no Claude ancestor: a TTL-only holder, the same on every machine). The
// lease library itself is covered in-process by review-lease.test.mjs; here the question is who takes, renews, closes and waits for a lease, and in which order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { LOCK_DIR, PR, ME, REPO, cli, scenario } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { repoLockKey, reviewLockName } from '../pipeline/lib/review-context.mjs';
import { HOLDER_ENV, acquireAdmission, blocking, releaseAdmission, scanLeases } from '../pipeline/lib/review-lease.mjs';
import { tryAcquire, release } from '../pipeline/lib/locks.mjs';
import { LEASED_COMMANDS, leaseArgs, leasesOffForTests } from '../pipeline/lib/review-lease-wiring.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { noClaudeSession } from './helpers/no-claude-session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const INSTALL = join(here, '..', 'install.mjs');
const FIXTURE = join(here, 'fixtures', 'src-tree');
const MACHINE = 'gate-env-test-machine'; // what gate-env's cli() gives every child, so a lock taken here and in a child agree on the machine
const SESSION_VAR = ['CLAUDE', 'CODE'].join('');

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scratch(label = 'cp-lw') {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(d);
  return d;
}

const withFakePs = () => noClaudeSession();

// One machine: a lease folder and a home, and the environment of a child CLI. `session: false` is a plain terminal (no session marker): its commands take a process lease for the length of the command.
function world({ session = true, extra = {} } = {}) {
  const root = scratch();
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const dir = join(root, 'review-leases');
  const env = {
    ...withFakePs(), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined, PIPELINE_MACHINE_ID: MACHINE,
    PIPELINE_REVIEW_LEASE_DIR: dir, [SESSION_VAR]: session ? '1' : undefined, ...extra,
    // Hermetic: a suite run inside a `P job` carries the launching session's PIPELINE_LEASE_HOLDER; handed to the child CLI it would make the lease a job-scoped one of that session (live only while a job runs).
    [HOLDER_ENV]: undefined,
  };
  return { root, home, dir, env };
}

const leaseFiles = (w) => (existsSync(w.dir) ? readdirSync(w.dir).filter((n) => n.endsWith('.json')).sort() : []);
// Every lease of every holder in the folder: [{ file, worktree, ...lease }].
function leasesOf(w) {
  return leaseFiles(w).flatMap((f) => Object.entries(JSON.parse(readFileSync(join(w.dir, f), 'utf8')).leases).map(([worktree, l]) => ({ file: f, worktree, ...l })));
}
const leaseOn = (w, repo) => leasesOf(w).find((l) => l.worktree === realpathSync.native(repo.dir));

// A repo with a review state for PR 12 and a valid config; the state names its PR, so state-only commands get a PR lease.
function reviewRepo({ state = true } = {}) {
  const repo = createTmpRepo({ highEffort: true });
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n.verify/\n');
  repo.write('src/app.js', 'export const a = 1;\n');
  repo.commit('init');
  repo.branch('agent/feature');
  if (state) writeState(repo);
  return repo;
}
function writeState(repo) {
  saveState(repo.dir, addRound(emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'low', maxRounds: 2 }), {
    n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h1', items: [],
  }));
}
const stateBytes = (repo) => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8');
const P = (w, repo, args, fake) => cli(args, { dir: repo.dir, fake, env: w.env });

const summaryGh = () => createFakeGh([
  { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget' } },
  ME, REPO,
  { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/12/comments', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-5' } },
]);

// ---- which commands, which lease --------------------------------------------------------------------------------------------------------

test('wiring: the leased commands are exactly the ones that read or write a worktree\'s review state (read-only commands take none)', () => {
  assert.deepEqual([...LEASED_COMMANDS].sort(), [
    'agent-log', 'arbiter', 'checkpoint', 'ci-wait', 'codex-review', 'comment', 'cost', 'final-gate', 'followups', 'job', 'merge', 'merge-hold',
    'redraft', 'review-complete', 'smoke', 'state', 'substitute', 'summary', 'triage', 'update-branch', 'verify',
  ]);
  for (const name of ['preflight', 'config', 'labels', 'update', 'version', 'model-floor', 'risk', 'hardstops', 'integrity', 'queue-sweep', 'protect', 'vendor']) {
    assert.equal(LEASED_COMMANDS.has(name), false, name);
  }
});

test('wiring: --repo and --pr are read in both spellings and never from after `--`', () => {
  assert.deepEqual(leaseArgs(['show', '--pr', '7', '--repo', '/r']), { pr: '7', repo: '/r' });
  assert.deepEqual(leaseArgs(['--pr=7', '--repo=/r']), { pr: '7', repo: '/r' });
  assert.deepEqual(leaseArgs(['start', 'x', '--', 'cmd', '--pr', '9', '--repo', '/other']), {});
});

test('wiring: a checkout run under node --test without a lease folder takes no lease (so the suite never writes the account\'s real folder); an installed copy never skips', () => {
  assert.equal(leasesOffForTests({ NODE_TEST_CONTEXT: 'child-v8' }, false), true);
  assert.equal(leasesOffForTests({ NODE_TEST_CONTEXT: 'child-v8', PIPELINE_REVIEW_LEASE_DIR: '/x' }, false), false, 'the seam turns leases on');
  assert.equal(leasesOffForTests({}, false), false, 'not a test run');
  assert.equal(leasesOffForTests({ NODE_TEST_CONTEXT: 'child-v8' }, true), false, 'an installed copy ignores the variable');
});

// ---- open, renew, migrate ------------------------------------------------------------------------------------------------------------------

test('a state-writing command opens a PR lease (the PR the state names, the repo identity of the state lock); the next command renews the same generation', () => {
  const w = world();
  const repo = reviewRepo();
  assert.equal(existsSync(w.dir), false, 'nothing yet: a review that began on an older install has no lease');
  const before = stateBytes(repo);

  const first = P(w, repo, ['state', 'set-outcome', '--outcome', 'needs-human']);
  assertExit(first, 0, first.stderr);
  const lease = leaseOn(w, repo);
  assert.ok(lease, `a lease for ${repo.dir} in ${JSON.stringify(leasesOf(w))}`);
  assert.equal(lease.pr, PR);
  assert.equal('branch' in lease, false);
  assert.equal(lease.repoId, repoLockKey(repo.dir));
  assert.match(lease.generation, /^[0-9a-f-]{36}$/);
  assert.notEqual(stateBytes(repo), before, 'the command itself still did its work');

  const second = P(w, repo, ['state', 'show']);
  assertExit(second, 0, second.stderr);
  const again = leaseOn(w, repo);
  assert.equal(again.generation, lease.generation, 'renewed, not reopened');
  assert.equal(again.openedAt, lease.openedAt);
  assert.ok(Date.parse(again.renewedAt) >= Date.parse(lease.renewedAt));
  assert.equal(leasesOf(w).length, 1);
});

test('a lease deleted mid-review (or never written by an older install) is opened again by the next command', () => {
  const w = world();
  const repo = reviewRepo();
  assertExit(P(w, repo, ['state', 'show']), 0);
  const gen = leaseOn(w, repo).generation;
  rmSync(w.dir, { recursive: true, force: true });
  assertExit(P(w, repo, ['state', 'show']), 0);
  const lease = leaseOn(w, repo);
  assert.ok(lease);
  assert.notEqual(lease.generation, gen, 'a new open has a new generation');
});

test('branch lease -> PR lease through real commands: a command that knows no PR leaves a branch lease, the first one that does migrates it (same generation)', () => {
  const w = world();
  const repo = reviewRepo({ state: false });
  assertExit(P(w, repo, ['verify', 'plan-after-fix', '--round', '1']), 0);
  const branch = leaseOn(w, repo);
  assert.ok(branch, 'no review state, so no PR is known: a branch lease');
  assert.equal(branch.branch, 'agent/feature');
  assert.equal('pr' in branch, false);

  writeState(repo);
  assertExit(P(w, repo, ['state', 'show']), 0);
  const pr = leaseOn(w, repo);
  assert.equal(pr.pr, PR);
  assert.equal('branch' in pr, false);
  assert.equal(pr.generation, branch.generation, 'migrated, not reopened');
  assert.equal(pr.openedAt, branch.openedAt);
  assert.equal(leasesOf(w).length, 1);
});

// ---- close ---------------------------------------------------------------------------------------------------------------------------------

test('the stop ritual closes the lease: `summary --outcome` succeeding removes it; a refused summary leaves it', () => {
  const w = world();
  const repo = reviewRepo({ state: false });
  assertExit(P(w, repo, ['verify', 'plan-after-fix', '--round', '1']), 0);
  assert.ok(leaseOn(w, repo));

  const refused = P(w, repo, ['summary', '--pr', String(PR), '--outcome', 'merged'], summaryGh());
  assertExit(refused, 2, 'no state: only blocked|awaiting-review|... can be summarised');
  assert.ok(leaseOn(w, repo), 'a failed stop ritual keeps the lease');
  assert.equal(leasesOf(w).length, 1);

  const stopped = P(w, repo, ['summary', '--pr', String(PR), '--outcome', 'blocked'], summaryGh());
  assertExit(stopped, 0, stopped.stderr);
  assert.equal(leaseOn(w, repo), undefined);
  assert.deepEqual(leaseFiles(w), [], 'the holder file goes with its last lease');
});

test('an ended run closes the lease; a checkpoint of a run that goes on only renews it', () => {
  const w = world();
  const s = scenario();
  const run = (args) => cli(['checkpoint', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: w.env });
  assertExit(run(['--step', 'review']), 0);
  const lease = leaseOn(w, s.repo);
  assert.ok(lease);
  assert.equal(lease.pr, PR);

  assertExit(run(['--step', 'gate']), 0);
  assert.equal(leaseOn(w, s.repo).generation, lease.generation);

  assertExit(run(['--step', 'ended']), 0);
  assert.equal(leaseOn(w, s.repo), undefined, 'step ended: the run is over');
});

// ---- no session, read-only commands, errors ------------------------------------------------------------------------------------------

test('a plain terminal (no Claude Code session) takes a process lease only while its command runs (test/review-lease-terminal.test.mjs holds one open); read-only commands take none', () => {
  const plain = world({ session: false });
  const repo = reviewRepo();
  assertExit(P(plain, repo, ['state', 'show']), 0);
  assert.deepEqual(leaseFiles(plain), [], 'the process lease was closed when the command ended');
  assert.equal(existsSync(plain.dir), true, 'the folder was used (admission and the lease file)');

  const w = world();
  assertExit(P(w, repo, ['config']), 0);
  assertExit(P(w, repo, ['risk', '--help']), 0);
  assertExit(P(w, repo, ['version']), 0);
  assert.equal(existsSync(w.dir), false, 'config, risk and version never touch the lease folder');
});

test('an update holding admission stops a review command before it runs: coded error update-in-progress, exit 2, review state and lease folder untouched', async () => {
  const w = world({ extra: { PIPELINE_ADMISSION_WAIT_MS: '300' } });
  const repo = reviewRepo();
  const before = stateBytes(repo);
  process.env.PIPELINE_MACHINE_ID = MACHINE;
  const held = await acquireAdmission({ dir: w.dir, waitMs: 1000 });
  try {
    const r = P(w, repo, ['state', 'set-outcome', '--outcome', 'needs-human']);
    assertExit(r, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'update-in-progress');
    assert.match(r.json.message, /retry in a minute/);
    assert.match(r.json.message, /nothing was changed/);
    assert.equal(stateBytes(repo), before, 'the command did not run');
    assert.deepEqual(leaseFiles(w), []);
  } finally {
    releaseAdmission(held);
  }
  assertExit(P(w, repo, ['state', 'set-outcome', '--outcome', 'needs-human']), 0, 'once the update is over the same command runs');
});

test('a lease folder that cannot be written fails the command closed with a coded error (review-lease-unwritable), nothing changed', () => {
  const w = world();
  const blocker = join(w.root, 'a-file');
  writeFileSync(blocker, 'x');
  w.env.PIPELINE_REVIEW_LEASE_DIR = join(blocker, 'review-leases'); // its parent is a regular file
  const repo = reviewRepo();
  const before = stateBytes(repo);
  const r = P(w, repo, ['state', 'set-outcome', '--outcome', 'needs-human']);
  assertExit(r, 2);
  assert.equal(r.json.error, 'review-lease-unwritable');
  assert.match(r.json.message, /nothing was changed/);
  assert.equal(stateBytes(repo), before);
});

// ---- order: admission before the state lock; a review that starts after the final scan ------------------------------------------------

// Starts the real CLI without waiting; `done` resolves { code, stdout, stderr } when it exits.
function startCli(tc, w, repo, args) {
  const env = { ...process.env, PIPELINE_LOCK_DIR: LOCK_DIR, PIPELINE_MACHINE_ID: MACHINE, ...w.env };
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repo.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  tc.after(() => { // an assertion that fails first must not leave this child (and its open pipes) hanging the file
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done, exited: () => child.exitCode !== null || child.signalCode !== null };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a review that starts after the installer\'s final scan waits for admission, then gets its lease AFTER the swap; it never holds the PR state lock while it waits', async (tc) => {
  const w = world();
  const repo = reviewRepo();
  process.env.PIPELINE_MACHINE_ID = MACHINE;

  // The installer: take admission, scan (nothing live yet: no review has started), and keep admission through "the swap".
  const installer = await acquireAdmission({ dir: w.dir, waitMs: 1000 });
  assert.deepEqual(blocking(scanLeases({ dir: w.dir, env: { [SESSION_VAR]: '1' } })), [], 'the final scan finds no review');

  // A review command starts now, after that scan.
  const review = startCli(tc, w, repo, ['state', 'show']);
  await pause(1500);
  assert.equal(review.exited(), false, 'it is waiting for admission, not running');
  assert.deepEqual(leaseFiles(w), [], 'and has no lease');

  // While it waits it holds nothing the installer (or anyone) could need: the per-PR state lock is free.
  const lock = tryAcquire(reviewLockName(repo.dir, PR), { dir: LOCK_DIR, machineId: MACHINE });
  assert.equal(lock.acquired, true, 'the PR state lock is not held by a command that waits for admission');
  release(lock.lock);

  // The swap finishes, the installer lets go.
  const swappedAt = Date.now();
  releaseAdmission(installer);
  const out = await review.done;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).ok, true);

  const lease = leaseOn(w, repo);
  assert.ok(lease, 'the lease is granted once admission is free');
  assert.ok(Date.parse(lease.openedAt) >= swappedAt, `granted after the swap (${lease.openedAt} vs ${new Date(swappedAt).toISOString()})`);
  assert.ok(blocking(scanLeases({ dir: w.dir, env: { [SESSION_VAR]: '1' } })).length >= 1, 'the next scan sees it');
});

// ---- the installer's own run never opens a lease -----------------------------------------------------------------------------------------

test('install.mjs --check (what the installer runs while it holds admission) never opens a lease: it succeeds although admission is held, and the folder stays empty', async () => {
  const w = world();
  const claudeHome = join(scratch('cp-lw-home'), 'cp-home');
  const base = { ...process.env, HOME: w.home, USERPROFILE: w.home, PIPELINE_INSTALL_NO_PROBES: '1', PIPELINE_MACHINE_ID: MACHINE, ...withFakePs() };
  // A plain install into a scratch claude-home, from a terminal's point of view (no session marker), then the check from a session's.
  const terminal = { ...base };
  delete terminal[SESSION_VAR];
  const installed = spawnSync(process.execPath, [INSTALL, '--claude-home', claudeHome, '--source', FIXTURE], { encoding: 'utf8', timeout: 60000, env: terminal });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);

  process.env.PIPELINE_MACHINE_ID = MACHINE;
  const held = await acquireAdmission({ dir: w.dir, waitMs: 1000 });
  try {
    const started = Date.now();
    const checked = spawnSync(process.execPath, [INSTALL, '--claude-home', claudeHome, '--source', FIXTURE, '--check'], {
      encoding: 'utf8', timeout: 60000, env: { ...base, [SESSION_VAR]: '1', PIPELINE_REVIEW_LEASE_DIR: w.dir },
    });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(Date.now() - started < 15000, 'it did not wait on admission (that wait is 20 s)');
    assert.deepEqual(leaseFiles(w), [], 'no lease: the installer\'s code paths never call openOrRenewLease');
  } finally {
    releaseAdmission(held);
  }
});
