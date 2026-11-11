// Direct unit tests for scanLiveWork (lib/live-work-scan.mjs, plan 2026-11-10 B1/B6): the read-only "is any review work in flight?" look the unattended
// installer takes while it holds admission. test/install-admission.test.mjs already proves, through the installer, that each defer signal alone defers;
// these pin what that cannot see: the entry shapes, the dead / stale / finished cases that must NOT defer, the fail-closed cases, non-root worktrees,
// the deadline. Everything runs against scratch dirs (explicit `repos`, PIPELINE_LOCK_DIR in `env`, a scratch lease folder); nothing reads the real
// machine. Signals and process groups are the only POSIX-leaning parts: the live/dead processes are plain node children, which work everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanDeadline, scanLiveWork } from '../pipeline/lib/live-work-scan.mjs';
import { release, tryAcquire } from '../pipeline/lib/locks.mjs';
import { openRecord } from '../pipeline/lib/merge-queue.mjs';
import { knownRepos, registerRepo } from '../pipeline/lib/queue-sweep.mjs';
import { openOrRenewLease } from '../pipeline/lib/review-lease.mjs';

const MACHINE = 'test-machine-id';
process.env.PIPELINE_MACHINE_ID ||= MACHINE;

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// One scratch machine: a lock folder, a lease folder, a fake home, and a place for repos.
function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-lws-')));
  made.push(root);
  const w = { root, locks: join(root, 'locks'), leases: join(root, 'leases'), home: join(root, 'home') };
  for (const d of [w.locks, w.home]) mkdirSync(d, { recursive: true });
  w.env = { PIPELINE_LOCK_DIR: w.locks, PIPELINE_MACHINE_ID: MACHINE };
  // The lease options point the scan at the scratch folder and keep the real process table out of it.
  w.leaseOpts = { dir: w.leases, home: w.home, env: { CLAUDECODE: '1' } };
  w.scan = (extra = {}) => scanLiveWork({ env: w.env, home: w.home, leaseOpts: w.leaseOpts, repos: [], ...extra });
  return w;
}

function git(cwd, ...args) {
  const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: nul, GIT_CONFIG_SYSTEM: nul } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function repoIn(w, name = 'repo') {
  const dir = join(w.root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

const sleeper = (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  return child;
};
// The pid of a process that has run and exited (nothing alive answers to it).
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid;
}

// `.review/jobs/<name>/` in `worktree`, shaped as jobs.mjs writes it. `runnerPid` null/undefined leaves it out; `exit` adds exit.json.
function jobIn(worktree, name, { runnerPid, exit = false, startedAt = new Date().toISOString() } = {}) {
  const dir = join(worktree, '.review', 'jobs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name, command: 'x', cwd: worktree, tag: null, runId: `run-${name}`, startedAt, ...(runnerPid ? { runnerPid } : {}) }));
  if (exit) writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, finishedAt: new Date().toISOString() }));
  return dir;
}
const kinds = (live) => live.map((e) => e.kind);
const mergeChild = (w, name, body) => writeFileSync(join(w.locks, `${name}.child.json`), typeof body === 'string' ? body : JSON.stringify(body));
const hold = (w, t, name, opts = {}) => {
  const got = tryAcquire(name, { dir: w.locks, machineId: MACHINE, ...opts });
  assert.ok(got.acquired, name);
  t.after(() => { try { release(got.lock); } catch { /* gone */ } });
  return got;
};

// ---- an empty machine ----------------------------------------------------------------------------------------------------------------------

test('an empty machine (no leases, no locks, no repos) has no live work', () => {
  assert.deepEqual(world().scan(), []);
});

test('a lock folder that does not exist yet is not an error, and a clean repository with a worktree adds nothing', () => {
  const w = world();
  const repo = repoIn(w);
  git(repo, 'worktree', 'add', '-q', join(w.root, 'wt-clean'), '-b', 'feature');
  assert.deepEqual(w.scan({ env: { ...w.env, PIPELINE_LOCK_DIR: join(w.root, 'no-such-locks') }, repos: [repo] }), []);
});

// ---- merge child records -------------------------------------------------------------------------------------------------------------------

test('a merge-*.child.json whose process group is alive is a merge-lock entry naming the file and the group', (t) => {
  const w = world();
  mergeChild(w, 'merge-acme__app-pr7', { pid: sleeper(t).pid, startedAt: new Date().toISOString() });
  const live = w.scan();
  assert.deepEqual(kinds(live), ['merge-lock']);
  assert.match(live[0].detail, /merge-acme__app-pr7\.child\.json/);
  assert.match(live[0].detail, /still running/);
});

test('an unreadable merge child record (not JSON, or no pid) is a merge-lock entry "treated as running"', () => {
  const w = world();
  mergeChild(w, 'merge-a-pr1', '{ not json');
  mergeChild(w, 'merge-b-pr2', { startedAt: 'x' });
  const live = w.scan();
  assert.deepEqual(kinds(live), ['merge-lock', 'merge-lock']);
  for (const e of live) assert.match(e.detail, /unreadable .* treated as running/);
});

test('a merge child record whose process group is gone is nothing (dead), and a child file without the merge- prefix is ignored', async () => {
  const w = world();
  mergeChild(w, 'merge-acme__app-pr7', { pid: await deadPid(), startedAt: new Date().toISOString() });
  mergeChild(w, 'other-pr7', '{ not json'); // not a merge child: never read
  assert.deepEqual(w.scan(), []);
});

// ---- jobs ----------------------------------------------------------------------------------------------------------------------------------

test('a fresh <job>.starting means a job is being started; one older than 60 s (a starter that crashed) is nothing', () => {
  const w = world();
  const repo = repoIn(w);
  const jobs = join(repo, '.review', 'jobs');
  mkdirSync(jobs, { recursive: true });
  const marker = join(jobs, 'verify.starting');
  writeFileSync(marker, '');
  let live = w.scan({ repos: [repo] });
  assert.deepEqual(kinds(live), ['job']);
  assert.equal(live[0].repo, repo);
  assert.match(live[0].detail, /job verify is being started/);
  const old = new Date(Date.now() - 61_000);
  utimesSync(marker, old, old);
  assert.deepEqual(w.scan({ repos: [repo] }), [], 'a stale start lock does not defer');
});

test('a running job defers; a finished job, a job whose runner died, and a folder that is not a job do not', async (t) => {
  const w = world();
  const repo = repoIn(w);
  jobIn(repo, 'running', { runnerPid: sleeper(t).pid });
  let live = w.scan({ repos: [repo] });
  assert.deepEqual(kinds(live), ['job']);
  assert.equal(live[0].worktree, repo);
  assert.match(live[0].detail, /job running is running/);

  rmSync(join(repo, '.review'), { recursive: true, force: true });
  jobIn(repo, 'done', { runnerPid: await deadPid(), exit: true });
  jobIn(repo, 'finished-while-runner-lives', { runnerPid: sleeper(t).pid, exit: true });
  jobIn(repo, 'lost', { runnerPid: await deadPid() });
  mkdirSync(join(repo, '.review', 'jobs', 'not-a-job'), { recursive: true });
  writeFileSync(join(repo, '.review', 'jobs', 'stray-file.txt'), 'x');
  assert.deepEqual(w.scan({ repos: [repo] }), [], 'finished, lost and non-job entries never defer');
});

// R2-B1: jobs.mjs reads an unreadable or corrupt meta.json as "missing"; a job folder with such a record must still count as live (fail closed),
// unless a readable exit.json says it finished. A folder with NO meta.json at all (an empty leftover) is not a job.
test('R2-B1: a job folder whose meta.json is corrupt defers; with a readable exit.json, or with no meta.json at all, it does not', () => {
  const w = world();
  const repo = repoIn(w);
  const dir = jobIn(repo, 'broken', { runnerPid: process.pid });
  writeFileSync(join(dir, 'meta.json'), '{ this is not json');
  let live = w.scan({ repos: [repo] });
  assert.deepEqual(kinds(live), ['job']);
  assert.match(live[0].detail, /job broken/);
  writeFileSync(join(dir, 'meta.json'), 'null');
  assert.deepEqual(kinds(w.scan({ repos: [repo] })), ['job'], 'valid JSON that is not a record is corrupt too');
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, finishedAt: new Date().toISOString() }));
  assert.deepEqual(w.scan({ repos: [repo] }), [], 'corrupt meta but a readable exit.json: it finished');
  rmSync(join(repo, '.review'), { recursive: true, force: true });
  mkdirSync(join(repo, '.review', 'jobs', 'empty'), { recursive: true });
  assert.deepEqual(w.scan({ repos: [repo] }), [], 'an empty job folder is not a job');
});

test('R2-B1: a meta.json that cannot be read (chmod 000) defers', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const w = world();
  const repo = repoIn(w);
  const dir = jobIn(repo, 'locked', { runnerPid: process.pid });
  chmodSync(join(dir, 'meta.json'), 0o000);
  try {
    const live = w.scan({ repos: [repo] });
    assert.deepEqual(kinds(live), ['job']);
    assert.match(live[0].detail, /job locked/);
  } finally { chmodSync(join(dir, 'meta.json'), 0o600); }
});

test('R2-B1: a job entry that cannot be statted (not "gone") defers instead of being skipped', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const w = world();
  const repo = repoIn(w);
  jobIn(repo, 'j', { runnerPid: process.pid });
  const jobs = join(repo, '.review', 'jobs');
  chmodSync(jobs, 0o400); // listable, but its entries cannot be statted
  try {
    const live = w.scan({ repos: [repo] });
    assert.deepEqual(kinds(live), ['job']);
    assert.match(live[0].detail, /job j cannot be inspected/);
  } finally { chmodSync(jobs, 0o700); }
});

test('a running job in a NON-root worktree is found, with that worktree named; the same repo listed twice is scanned once', (t) => {
  const w = world();
  const repo = repoIn(w);
  const wt = join(w.root, 'wt-review');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'review-branch');
  jobIn(wt, 'codex', { runnerPid: sleeper(t).pid });
  const live = w.scan({ repos: [repo, repo] });
  assert.equal(live.length, 2, 'one entry per scan of the repo; the root and the worktree are never counted twice within one scan');
  for (const e of live) {
    assert.equal(e.kind, 'job');
    assert.equal(e.repo, repo);
    assert.equal(realpathSync.native(e.worktree), realpathSync.native(wt));
  }
});

test('a root that is not a git repository still has its own jobs scanned, and its unreadable queue folder is a scan-error (fail closed)', (t) => {
  const w = world();
  const plain = join(w.root, 'plain');
  mkdirSync(plain, { recursive: true });
  jobIn(plain, 'j', { runnerPid: sleeper(t).pid });
  const live = w.scan({ repos: [plain] });
  // (R1-F4: git cannot list the worktrees of a non-repository either, which is now said instead of silently falling back to the root)
  assert.deepEqual(kinds(live), ['scan-error', 'job', 'scan-error']);
  assert.match(live[0].detail, /git worktree list/);
  assert.match(live[2].detail, /cannot read the merge-queue records/);
});

// ---- held locks ----------------------------------------------------------------------------------------------------------------------------

test('a held review-, merge- and queue- lock is a state-lock, merge-lock and queue-lock entry naming its holder; a lock matching no prefix is ignored', (t) => {
  const w = world();
  hold(w, t, 'review-0123456789ab-pr7');
  hold(w, t, 'merge-acme__app-pr7');
  hold(w, t, 'queue-sweep-acme');
  hold(w, t, 'model-floor');
  hold(w, t, 'admission');
  const live = w.scan();
  assert.deepEqual(live.map((e) => e.kind).sort(), ['merge-lock', 'queue-lock', 'state-lock']);
  for (const e of live) assert.match(e.detail, new RegExp(`held by pid ${process.pid} `));
});

test('a lock whose owner is dead is stale, not held: nothing to defer for', async (t) => {
  const w = world();
  hold(w, t, 'review-0123456789ab-pr8', { pid: await deadPid() });
  assert.deepEqual(w.scan(), []);
});

test('a lock the scan cannot read (its owner record is a directory) is a scan-error: fail closed, naming the file', (t) => {
  const w = world();
  hold(w, t, 'other-lock'); // (a healthy bystander)
  const broken = join(w.locks, 'review-broken-pr1.lock');
  mkdirSync(join(broken, 'owner.json'), { recursive: true });
  const live = w.scan();
  assert.deepEqual(kinds(live), ['scan-error']);
  assert.match(live[0].detail, /cannot read the lock review-broken-pr1\.lock/);
});

test('a lock directory that cannot be listed (it is a file) is a scan-error', () => {
  const w = world();
  const file = join(w.root, 'locks-is-a-file');
  writeFileSync(file, 'x');
  const live = w.scan({ env: { ...w.env, PIPELINE_LOCK_DIR: file } });
  assert.deepEqual(kinds(live), ['scan-error']);
  assert.match(live[0].detail, /cannot list the lock directory/);
});

// ---- merge-queue records -------------------------------------------------------------------------------------------------------------------

function queueFile(repo, pr) {
  const dir = git(repo, 'rev-parse', '--git-common-dir').trim();
  const abs = join(repo, dir, 'pipeline', 'merge-queue');
  mkdirSync(abs, { recursive: true });
  return join(abs, `pr-${pr}.json`);
}

test('a live merge-queue record is a queue-record entry (repo name, PR, root); a finished one is nothing', () => {
  const w = world();
  const repo = repoIn(w);
  openRecord(repo, 12, 'c'.repeat(40), {}, { repo: 'acme/app', repoId: 1 });
  const file = queueFile(repo, 13);
  writeFileSync(file, JSON.stringify({ pr: 13, repo: 'acme/app', repoId: 1, root: repo, head: 'd'.repeat(40), approval: {}, route: null, createdAt: new Date().toISOString(), attempts: 0, pending: null, entryIds: [], removals: [], hold: null, terminal: 'merged', terminalAt: new Date().toISOString() }));
  const live = w.scan({ repos: [repo] });
  assert.equal(live.length, 1);
  assert.deepEqual({ kind: live[0].kind, repo: live[0].repo, pr: live[0].pr, worktree: live[0].worktree }, { kind: 'queue-record', repo: 'acme/app', pr: 12, worktree: repo });
});

test('an unreadable merge-queue record is a queue-record entry "treated as live"; the readable ones beside it are still reported', () => {
  const w = world();
  const repo = repoIn(w);
  openRecord(repo, 12, 'c'.repeat(40), {}, { repo: 'acme/app', repoId: 1 });
  writeFileSync(queueFile(repo, 14), '{ not json');
  const live = w.scan({ repos: [repo] });
  assert.deepEqual(kinds(live), ['queue-record', 'queue-record']);
  assert.ok(live.some((e) => e.pr === 12));
  const bad = live.find((e) => e.pr === undefined);
  assert.equal(bad.repo, repo);
  assert.match(bad.detail, /unreadable .*treated as live/);
});

// ---- leases and the default repository list ------------------------------------------------------------------------------------------------

test('a live lease is reported with its repo, PR, worktree and holder; an unreadable lease file still counts', async () => {
  const w = world();
  const wt = join(w.root, 'wt');
  mkdirSync(wt, { recursive: true });
  const t0 = Date.now();
  const lease = {
    ...w.leaseOpts, ancestorPid: 4242, starts: () => new Map([[4242, 'Wed Nov 11 02:23:52 2026']]), sessionRecord: () => ({ sessionId: 'sess-a', procStart: 'Wed Nov 11 02:23:52 2026' }), jobLive: () => false, now: t0,
  };
  await openOrRenewLease({ worktree: wt, repoId: 'acme/app', pr: 7, ...lease });
  writeFileSync(join(w.leases, 'broken.json'), '{ not json');
  const live = w.scan({ leaseOpts: { ...lease, ancestorPid: null } });
  assert.deepEqual(kinds(live), ['lease', 'lease']);
  const ok = live.find((e) => e.sessionId === 'sess-a');
  assert.deepEqual({ repo: ok.repo, pr: ok.pr, worktree: ok.worktree }, { repo: 'acme/app', pr: 7, worktree: wt });
  assert.equal(live.find((e) => e.sessionId === 'broken').kind, 'lease');
});

test('without an explicit `repos` list the scan asks the machine (the registry of repos a merge named): its jobs are found', (t) => {
  const w = world();
  const repo = repoIn(w);
  registerRepo({ root: repo, env: w.env });
  jobIn(repo, 'j', { runnerPid: sleeper(t).pid });
  const live = scanLiveWork({ env: w.env, home: w.home, leaseOpts: w.leaseOpts });
  assert.deepEqual(kinds(live), ['job']);
  assert.equal(realpathSync.native(live[0].repo), realpathSync.native(repo));
});

test('the `lockDir` option points the lock scan (and the repo registry) at that folder instead of the default one', (t) => {
  const w = world();
  const elsewhere = join(w.root, 'elsewhere');
  mkdirSync(elsewhere);
  const got = tryAcquire('review-0123456789ab-pr9', { dir: elsewhere, machineId: MACHINE });
  assert.ok(got.acquired);
  t.after(() => release(got.lock));
  // PIPELINE_LOCK_DIR names an empty folder; the option wins and finds the held lock
  assert.deepEqual(kinds(w.scan({ lockDir: elsewhere })), ['state-lock']);
  assert.deepEqual(w.scan(), [], 'without the option the env folder (empty) is the one scanned');
});

// ---- the deadline --------------------------------------------------------------------------------------------------------------------------

test('a deadline already in the past throws ScanDeadline before anything is read', (t) => {
  const w = world();
  hold(w, t, 'review-0123456789ab-pr7'); // would be reported if the scan got that far
  assert.throws(() => w.scan({ deadlineAt: Date.now() - 1 }), (err) => err instanceof ScanDeadline && err.name === 'ScanDeadline' && /deadline/.test(err.message));
});

test('a deadline that is still ahead lets the scan finish', () => {
  assert.deepEqual(world().scan({ deadlineAt: Date.now() + 60_000 }), []);
});

// ---- R1-F4: "could not look" is never "nothing live" ----------------------------------------------------------------------------------------
test('a repository whose `git worktree list` fails is a scan-error entry, not just the root alone', () => {
  const w = world();
  const notGit = join(w.root, 'not-a-repo');
  mkdirSync(notGit, { recursive: true });
  const live = w.scan({ repos: [notGit] });
  const e = live.find((x) => x.kind === 'scan-error' && x.repo === notGit);
  assert.ok(e, JSON.stringify(live));
  assert.match(e.detail, /git worktree list/);
});

test('a jobs folder that cannot be listed (not ENOENT) is a scan-error; a missing one is simply no jobs', () => {
  const w = world();
  const a = repoIn(w, 'a');
  const b = repoIn(w, 'b');
  mkdirSync(join(a, '.review'), { recursive: true });
  writeFileSync(join(a, '.review', 'jobs'), 'a file where the jobs folder should be');
  const live = w.scan({ repos: [a, b] });
  assert.equal(live.filter((x) => x.kind === 'scan-error' && x.worktree === a).length, 1, JSON.stringify(live));
  assert.equal(live.some((x) => x.worktree === b), false, 'no jobs folder at all is not an error');
});

test('a job folder whose record cannot be read counts as live; a stray file in the jobs folder does not', () => {
  const w = world();
  const r = repoIn(w);
  mkdirSync(join(r, '.review', 'jobs', 'bad name!'), { recursive: true });
  writeFileSync(join(r, '.review', 'jobs', 'notes.txt'), 'x');
  const live = w.scan({ repos: [r] });
  const jobs = live.filter((x) => x.kind === 'job');
  assert.equal(jobs.length, 1, JSON.stringify(live));
  assert.match(jobs[0].detail, /bad name!.*cannot be read/);
});

test('a registry or stacks config that exists but cannot be parsed is a scan-error; absent ones are not; knownRepos itself still returns what it can', () => {
  const w = world();
  const env = { ...w.env };
  writeFileSync(join(w.locks, 'queue-sweep-repos.json'), '{ not json');
  const live = scanLiveWork({ env, home: w.home, leaseOpts: w.leaseOpts });
  const e = live.find((x) => x.kind === 'scan-error' && /registry/.test(x.detail));
  assert.ok(e, JSON.stringify(live));
  assert.deepEqual(knownRepos({ home: w.home, env }), [], 'other callers keep the old behaviour');
  // an absent registry is fine
  rmSync(join(w.locks, 'queue-sweep-repos.json'));
  assert.deepEqual(scanLiveWork({ env, home: w.home, leaseOpts: w.leaseOpts }).filter((x) => x.kind === 'scan-error'), []);
});

// R3-B1: valid JSON that is not a proper record is as unusable as a corrupt file; R3-F2: the entry says which record and which folder to remove.
test('R3-B1 / R3-F2: a meta.json of {} / [] / 1, or an exit.json of {} next to a dead runner, defers and names the unreadable record and the folder', async () => {
  const w = world();
  const repo = repoIn(w);
  const dir = jobIn(repo, 'odd', { runnerPid: process.pid });
  for (const body of ['{}', '[]', '1']) {
    writeFileSync(join(dir, 'meta.json'), body);
    const live = w.scan({ repos: [repo] });
    assert.deepEqual(kinds(live), ['job'], `meta.json ${body}`);
    assert.match(live[0].detail, /^job odd has an unreadable record \(meta\.json\), treated as running: remove .*odd.* if it is stale$/, body);
  }
  jobIn(repo, 'odd', { runnerPid: await deadPid() });
  assert.deepEqual(w.scan({ repos: [repo] }), [], 'well-formed meta, dead runner: not running');
  writeFileSync(join(dir, 'exit.json'), '{}');
  const live = w.scan({ repos: [repo] });
  assert.deepEqual(kinds(live), ['job'], 'exit.json {} proves nothing');
  assert.match(live[0].detail, /^job odd has an unreadable record \(exit\.json\), treated as running: remove /);
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, finishedAt: new Date().toISOString() }));
  assert.deepEqual(w.scan({ repos: [repo] }), [], 'a well-formed exit.json: done');
});
