// `pipeline worktrees` end to end: the real CLI against a real repo with a bare origin, real linked worktrees and a
// scripted `gh`. Proves the mode table on disk (report / off / --dry-run change nothing, holding batches included), the
// `mode: on` removal, the canonical root from a linked worktree, per-branch GitHub failures, the run lock, the keep
// locks, and that a dead run's quarantine is restored even when the feature is off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, REPO_VIEW, pipelineYml } from './helpers/fakegh-env.mjs';
import { lockNameFor } from '../pipeline/lib/worktree-prune/rules.mjs';
import { summaryLine, outsideReport } from '../pipeline/lib/worktree-prune/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const holdLock = join(here, 'fixtures', 'hold-lock.mjs');
// /proc is how a process inside a worktree is seen; elsewhere the answer is "cannot check" and the worktree is kept.
const LINUX = process.platform === 'linux';

const scratch = [];
const tmp = (prefix) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
};
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

const DAY = 86400e3;
const OLD = (Date.now() - 3 * DAY) / 1000;
const iso = (ms) => new Date(ms).toISOString();

// Every file and directory under `dir` with its mtime; a top-level `.git` directory (git's own bookkeeping: FETCH_HEAD,
// worktree indexes) is skipped, the worktree list and branch refs are compared separately.
function walk(dir, skipTopGit = false) {
  const out = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      if (skipTopGit && rel === '' && name === '.git') continue;
      const p = join(abs, name);
      const st = lstatSync(p);
      out.push(`${rel}${name} ${st.isDirectory() ? 'd' : st.size} ${st.mtimeMs}`);
      if (st.isDirectory() && !st.isSymbolicLink()) visit(p, `${rel}${name}/`);
    }
  };
  if (existsSync(dir)) visit(dir, '');
  return out;
}

function ageTree(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) ageTree(p);
    if (!st.isSymbolicLink()) utimesSync(p, OLD, OLD);
  }
}

function world() {
  const base = tmp('cp-wtcli-');
  const dirs = Object.fromEntries(['home', 'holding', 'logs', 'locks', 'scratch', 'origin'].map((n) => [n, join(base, n)]));
  for (const d of Object.values(dirs)) mkdirSync(d);
  const repo = createTmpRepo();
  repo.git(['init', '--bare', '-q', '-b', 'main', dirs.origin]);
  repo.write('a.txt', 'a\n');
  repo.write('.gitignore', 'node_modules/\n.review/\n.verify/\n*.log\n.env*\nscreenshots from mac/\n');
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.commit('init');
  // The origin is named like GitHub (so the repo-identity check passes) while fetches go to the bare repo.
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  repo.git(['config', `url.${dirs.origin}.insteadOf`, 'https://github.com/acme/widgets.git']);
  repo.git(['push', '-q', 'origin', 'main']);
  mkdirSync(join(repo.dir, '.worktrees'));

  const wtPath = (slug) => join(repo.dir, '.worktrees', slug);
  const wtGit = (slug, args) => {
    const r = spawnSync('git', ['-C', wtPath(slug), ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const add = (slug, branch, file) => {
    repo.git(['worktree', 'add', '-q', '-b', branch, join('.worktrees', slug), 'main']);
    writeFileSync(join(wtPath(slug), file), `${slug}\n`);
    wtGit(slug, ['add', file]);
    wtGit(slug, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', slug]);
    return wtGit(slug, ['rev-parse', 'HEAD']);
  };
  const pullRef = (n, sha) => repo.git(['push', '-q', 'origin', `${sha}:refs/pull/${n}/head`]);
  const pr = (n, branch, state, headRefOid) => ({
    number: n, state, headRefName: branch, headRefOid, isCrossRepository: false, headRepository: { nameWithOwner: 'acme/widgets' },
    createdAt: iso(Date.now() - 5 * DAY), mergedAt: state === 'MERGED' ? iso(Date.now() - 2 * DAY) : null,
  });

  // done: merged, nothing local => eligible (evidence + a cache inside). open: open PR. nopr: no PR at all.
  // local: a commit after the merged head. dirty: an untracked file.
  const done = add('done', 'feat/done', 'done.txt');
  mkdirSync(join(wtPath('done'), '.review'));
  writeFileSync(join(wtPath('done'), '.review', 'state.json'), '{"pr":1}\n');
  mkdirSync(join(wtPath('done'), 'node_modules'));
  writeFileSync(join(wtPath('done'), 'node_modules', 'x.js'), 'x\n');
  const open = add('open', 'feat/open', 'open.txt');
  add('nopr', 'feat/nopr', 'nopr.txt');
  const localPrHead = add('local', 'feat/local', 'local.txt');
  writeFileSync(join(wtPath('local'), 'more.txt'), 'more\n');
  wtGit('local', ['add', 'more.txt']);
  wtGit('local', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'more']);
  const dirty = add('dirty', 'feat/dirty', 'dirty.txt');
  writeFileSync(join(wtPath('dirty'), 'scratch.txt'), 'mine\n');
  pullRef(1, done); pullRef(2, open); pullRef(3, localPrHead); pullRef(4, dirty);
  const prs = [pr(1, 'feat/done', 'MERGED', done), pr(2, 'feat/open', 'OPEN', open), pr(3, 'feat/local', 'MERGED', localPrHead), pr(4, 'feat/dirty', 'MERGED', dirty)];
  for (const slug of ['done', 'open', 'nopr', 'local', 'dirty']) ageTree(wtPath(slug));

  // An expired holding batch (40 days) and things the outside-worktree report should list.
  const holdingRepo = join(dirs.holding, 'acme_widgets');
  mkdirSync(join(holdingRepo, '2026-01-01', 'old'), { recursive: true });
  writeFileSync(join(holdingRepo, '2026-01-01', 'old', 'f.txt'), 'old\n');
  writeFileSync(join(holdingRepo, '2026-01-01', 'MANIFEST.json'), JSON.stringify({
    version: 1, items: [{ original: '/x/f.txt', stored: join(holdingRepo, '2026-01-01', 'old', 'f.txt'), size: 4, sha256: '', archivedAt: iso(Date.now() - 40 * DAY), slug: 'old', pr: 9 }],
  }));
  mkdirSync(join(repo.dir, 'screenshots from mac'));
  mkdirSync(join(dirs.scratch, '-proj', 'sess'), { recursive: true });
  writeFileSync(join(dirs.scratch, '-proj', 'sess', 'note.txt'), 'scratch\n');

  const graphqlPage = (nodes) => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
  const script = (extra = []) => [...extra, { match: '^repo view', stdoutJson: REPO_VIEW }, { match: '^api graphql', stdoutJson: graphqlPage(prs) }];
  const fake = createFakeGh(script());

  const env = { ...process.env, ...fake.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  Object.assign(env, {
    HOME: dirs.home, USERPROFILE: dirs.home, PIPELINE_HOLDING_DIR: dirs.holding, PIPELINE_PRUNE_LOG_DIR: dirs.logs,
    PIPELINE_LOCK_DIR: dirs.locks, PIPELINE_SCRATCH_DIR: dirs.scratch, PIPELINE_PRUNE_SETTLE_MS: '0', PIPELINE_NOTIFY: 'off',
  });
  const cli = (args, { cwd = repo.dir, extraEnv = {} } = {}) => {
    const r = spawnSync(process.execPath, [bin, 'worktrees', ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
  };
  const setMode = (mode) => repo.write('.claude/pipeline.yml', `${pipelineYml()}worktrees:\n  mode: ${mode}\n`);
  const snapshot = () => ({
    repo: walk(repo.dir, true),
    holding: walk(dirs.holding),
    worktrees: repo.git(['worktree', 'list', '--porcelain']),
    refs: repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
  });
  const keptReason = (json, slug) => json.kept.find((k) => k.slug === slug)?.reason;
  return { repo, dirs, env, wtPath, cli, setMode, snapshot, fake, script, keptReason, holdingRepo };
}

const slugs = (list) => list.map((x) => x.slug).sort();
const assertDoneEvaluated = (w, json, key) => {
  if (LINUX) assert.deepEqual(slugs(json[key]), ['done'], JSON.stringify(json.kept));
  else assert.match(w.keptReason(json, 'done'), /cannot check running processes/);
};

test('report mode (default): the eligible worktree is reported, nothing on disk changes (expired holding batch included)', () => {
  const w = world();
  writeFileSync(join(w.dirs.logs, 'prune-acme_widgets.log'), Array.from({ length: 35 }, (_, i) => `old ${i}`).join('\n') + '\n');
  const before = w.snapshot();
  const r = w.cli(['prune', '--notify']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'report');
  assert.equal(r.json.notify, undefined, 'nothing removed or restored: no push');
  assertDoneEvaluated(w, r.json, 'wouldRemove');
  if (LINUX) assert.ok(r.json.wouldRemove[0].bytes > 0);
  assert.deepEqual(r.json.removed, []);
  assert.match(w.keptReason(r.json, 'open'), /open PR #2/);
  assert.equal(w.keptReason(r.json, 'nopr'), 'no PR');
  assert.match(w.keptReason(r.json, 'local'), /commits that are not in PR #3/);
  assert.match(w.keptReason(r.json, 'dirty'), /scratch\.txt/);
  assert.deepEqual(r.json.holding.purged, []);
  assert.equal(r.json.holding.batches.length, 1);
  const outside = r.json.outside.map((o) => o.path);
  assert.ok(outside.includes(join(w.repo.dir, 'screenshots from mac')), JSON.stringify(outside));
  assert.ok(outside.includes(join(w.dirs.scratch, '-proj', 'sess')), JSON.stringify(outside));
  assert.match(r.json.summary, /^worktrees prune \(demo, report mode\): /);
  assert.deepEqual(w.snapshot(), before, 'report mode changes nothing');
  const log = readFileSync(join(w.dirs.logs, 'prune-acme_widgets.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 30, 'the log keeps the last 30 runs');
  assert.match(log.at(-1), /report mode/);
});

test('off mode: disabled, nothing on disk changes, the expired holding batch stays', () => {
  const w = world();
  w.setMode('off');
  const before = w.snapshot();
  const r = w.cli(['prune']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.disabled, true);
  assert.equal(r.json.mode, 'off');
  assert.deepEqual(r.json.restored, []);
  assert.deepEqual(w.snapshot(), before);
  assert.ok(existsSync(join(w.holdingRepo, '2026-01-01')));
  assert.equal(w.fake.calls().length, 0, 'off never asks GitHub');
});

test('--dry-run with mode: on evaluates but changes nothing', () => {
  const w = world();
  w.setMode('on');
  const before = w.snapshot();
  const r = w.cli(['prune', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.dryRun, true);
  assertDoneEvaluated(w, r.json, 'wouldRemove');
  assert.deepEqual(r.json.removed, []);
  assert.deepEqual(r.json.holding.purged, []);
  assert.deepEqual(w.snapshot(), before);
});

test('mode: on removes only the eligible worktree, archives its evidence, keeps every branch, purges the expired batch', { skip: !LINUX && 'process inspection needs /proc' }, () => {
  const w = world();
  w.setMode('on');
  const refsBefore = w.repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
  const r = w.cli(['prune', '--notify']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(slugs(r.json.removed), ['done'], JSON.stringify(r.json.kept));
  assert.equal(r.json.notify?.reason, 'disabled', 'a removal with --notify asks for a push (the test runner turns pushes off)');
  assert.equal(existsSync(w.wtPath('done')), false);
  assert.deepEqual(slugs(r.json.kept), ['dirty', 'local', 'nopr', 'open']);
  assert.match(w.keptReason(r.json, 'open'), /^open PR #2/);
  assert.equal(w.keptReason(r.json, 'nopr'), 'no PR');
  assert.match(w.keptReason(r.json, 'local'), /commits that are not in PR #3/);
  assert.match(w.keptReason(r.json, 'dirty'), /scratch\.txt/);
  for (const slug of ['open', 'nopr', 'local', 'dirty']) assert.ok(existsSync(w.wtPath(slug)), slug);
  assert.equal(w.repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']), refsBefore, 'no branch is deleted or moved');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(readFileSync(join(w.holdingRepo, today, 'done', '.review', 'state.json'), 'utf8'), '{"pr":1}\n');
  assert.deepEqual(r.json.holding.purged, ['2026-01-01']);
  assert.equal(existsSync(join(w.holdingRepo, '2026-01-01')), false);
  assert.match(r.json.summary, /removed 1 .*done #1/);
  assert.deepEqual(readdirSync(join(w.repo.dir, '.worktrees', '.prune-quarantine')), [], 'nothing left in quarantine');
});

test('--repo pointing at a linked worktree sees the same candidates, config and decisions as the main checkout', () => {
  const w = world();
  const fromMain = w.cli(['prune']);
  const fromLinked = w.cli(['prune', '--repo', w.wtPath('open')]);
  const fromInside = w.cli(['prune'], { cwd: join(w.wtPath('nopr')) });
  for (const r of [fromMain, fromLinked, fromInside]) assert.equal(r.code, 0, r.stderr);
  for (const r of [fromLinked, fromInside]) {
    assert.deepEqual(r.json.kept, fromMain.json.kept);
    assert.deepEqual(r.json.wouldRemove, fromMain.json.wouldRemove);
    assert.equal(r.json.mode, 'report');
  }
  assertDoneEvaluated(w, fromLinked.json, 'wouldRemove');
});

test('a GraphQL failure for one branch keeps that worktree and still evaluates the others', () => {
  const w = world();
  w.fake.setScript(w.script([{ match: 'branch=feat/open( |$)', code: 1, stderr: 'HTTP 502: bad gateway' }]));
  const r = w.cli(['prune']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(w.keptReason(r.json, 'open'), /^PR data incomplete/);
  assert.equal(w.keptReason(r.json, 'nopr'), 'no PR');
  assertDoneEvaluated(w, r.json, 'wouldRemove');
});

test('repo view failing exits 3 and changes nothing', () => {
  const w = world();
  w.setMode('on');
  w.fake.setScript([{ match: '^repo view', code: 1, stderr: 'API rate limit exceeded' }]);
  const before = w.snapshot();
  const r = w.cli(['prune']);
  assert.equal(r.code, 3, JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  assert.deepEqual(w.snapshot(), before);
});

test('a second concurrent run is skipped: "already running"', async () => {
  const w = world();
  const name = lockNameFor(realpathSync(join(w.repo.dir, '.git')));
  const releaseFile = join(w.dirs.home, 'release');
  const child = spawn(process.execPath, [holdLock, w.dirs.locks, name, '60000', '--release', releaseFile], { env: { ...process.env, PIPELINE_MACHINE_ID: 'test-machine-id' } });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => (String(d).includes('held') ? resolve() : reject(new Error(String(d)))));
      child.on('exit', (code) => reject(new Error(`holder exited ${code}`)));
    });
    const r = w.cli(['prune']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.skipped, 'already running');
    assert.equal(w.fake.calls().length, 0);
    assert.equal(r.json.summary, 'worktrees prune (demo, report mode): skipped — already running');
    assert.match(readFileSync(r.json.log, 'utf8'), / worktrees prune \(demo, report mode\): skipped — already running\n$/, 'a skip is logged too');
  } finally {
    writeFileSync(releaseFile, '');
    await new Promise((resolve) => (child.exitCode === null ? child.on('exit', resolve) : resolve()));
  }
});

test('keep / unkeep: a pipeline-keep lock keeps the worktree; unkeep releases only its own run, never an owner lock', () => {
  const w = world();
  w.setMode('on');
  const kept = w.cli(['keep', 'done', '--reason', 'ship run 7']);
  assert.equal(kept.code, 0, kept.stderr);
  assert.deepEqual([kept.json.slug, kept.json.locked], ['done', true]);
  const refreshed = w.cli(['keep', 'done', '--reason', 'ship run 7']);
  assert.equal(refreshed.json.locked, true, 'a pipeline-keep lock is refreshed');

  const r = w.cli(['prune']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.keptReason(r.json, 'done'), 'locked (pipeline-keep: ship run 7)');
  assert.ok(existsSync(w.wtPath('done')));

  const wrongRun = w.cli(['unkeep', 'done', '--run', '5']);
  assert.equal(wrongRun.code, 0, wrongRun.stderr);
  assert.equal(wrongRun.json.unlocked, false);
  assert.match(w.repo.git(['worktree', 'list', '--porcelain']), /locked pipeline-keep: ship run 7/);
  const ownRun = w.cli(['unkeep', 'done', '--run', '7']);
  assert.equal(ownRun.json.unlocked, true);
  assert.doesNotMatch(w.repo.git(['worktree', 'list', '--porcelain']), /pipeline-keep/);

  w.repo.git(['worktree', 'lock', '--reason', 'owner', w.wtPath('open')]);
  const owner = w.cli(['unkeep', 'open']);
  assert.equal(owner.json.unlocked, false);
  assert.match(w.repo.git(['worktree', 'list', '--porcelain']), /locked owner/);
  const noSteal = w.cli(['keep', 'open']);
  assert.equal(noSteal.json.locked, false);
  assert.equal(noSteal.json.reason, 'already locked by someone else');
  assert.match(w.repo.git(['worktree', 'list', '--porcelain']), /locked owner/);

  const missing = w.cli(['keep', 'nope']);
  assert.equal(missing.code, 2);
});

test('keep never takes over a ship run\'s keep lock: not by hand, not for another run; the owning run still releases it', () => {
  const w = world();
  const porcelain = () => w.repo.git(['worktree', 'list', '--porcelain']);
  assert.equal(w.cli(['keep', 'done', '--reason', 'ship run 7']).json.locked, true);
  for (const args of [[], ['--reason', 'ship run 8'], ['--reason', 'ship run 70']]) {
    const r = w.cli(['keep', 'done', ...args]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.locked, r.json.reason], [false, 'kept by another run (ship run 7)'], args.join(' '));
    assert.match(porcelain(), /locked pipeline-keep: ship run 7\n/);
  }
  assert.equal(w.cli(['keep', 'done', '--reason', 'ship run 7 resumed']).json.locked, true, 'the same run may refresh its own lock');
  const released = w.cli(['unkeep', 'done', '--run', '7']);
  assert.equal(released.json.unlocked, true);
  assert.doesNotMatch(porcelain(), /pipeline-keep/);
  assert.equal(w.cli(['keep', 'done']).json.locked, true, 'a hand keep lock (no run) may be refreshed by hand');
  assert.equal(w.cli(['keep', 'done', '--reason', 'ship run 9']).json.locked, true, 'and taken over by a run');
  assert.match(porcelain(), /locked pipeline-keep: ship run 9\n/);
});

test('git busy (index.lock) skips the run before anything moves, off mode and its leftover restore included', () => {
  const w = world();
  w.setMode('off');
  const qDir = join(w.repo.dir, '.worktrees', '.prune-quarantine');
  mkdirSync(qDir);
  w.repo.git(['worktree', 'move', w.wtPath('open'), join(qDir, 'open.deadrun')]);
  writeFileSync(join(w.repo.dir, '.git', 'index.lock'), '');
  const before = w.snapshot();
  const r = w.cli(['prune']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.skipped, 'git operation in progress');
  assert.deepEqual(w.snapshot(), before);
  assert.ok(existsSync(join(qDir, 'open.deadrun')), 'the leftover stays put while git is busy');
});

test('summaryLine groups a stale keep apart from an ordinary lock', () => {
  const line = summaryLine({
    name: 'demo', mode: 'report', dryRun: false, removed: [], wouldRemove: [], restored: [], outside: [], holding: { batches: [], purged: [] },
    kept: [
      { slug: 'a', reason: 'stale keep (8d: ship run a) — still needed?' },
      { slug: 'b', reason: 'locked (pipeline-keep: ship run b)' },
      { slug: 'c', reason: 'locked (owner)' },
    ],
  });
  assert.match(line, / · kept 3: 2 locked, 1 stale keep · /);
});

// Every completed invocation leaves one log line, so the nightly log shows the runs that did nothing as well.
test('off mode and a git-busy skip are logged like any other run: one line each, with a summary', () => {
  const w = world();
  const logFile = join(w.dirs.logs, 'prune-acme_widgets.log');
  w.setMode('off');
  const off = w.cli(['prune']);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(off.json.summary, 'worktrees prune (demo, off mode): disabled');
  assert.equal(off.json.log, logFile);
  w.setMode('report');
  writeFileSync(join(w.repo.dir, '.git', 'index.lock'), '');
  const busy = w.cli(['prune', '--dry-run']);
  assert.equal(busy.code, 0, busy.stderr);
  assert.equal(busy.json.summary, 'worktrees prune (demo, report mode, dry run): skipped — git operation in progress');
  const log = readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(log.length, 2, log.join('\n'));
  assert.match(log[0], /^\S+ worktrees prune \(demo, off mode\): disabled$/);
  assert.match(log[1], /^\S+ worktrees prune \(demo, report mode, dry run\): skipped — git operation in progress$/);
});

// The cron line appends stdout to an unrotated file: --summary-only keeps that to one line per night.
test('--summary-only prints one compact line: ok + summary, errors only when a step failed; a failure is one line too', () => {
  const w = world();
  const plain = w.cli(['prune', '--summary-only']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout.split('\n').length, 2, plain.stdout);
  assert.deepEqual(Object.keys(plain.json), ['ok', 'summary']);
  assert.match(plain.json.summary, /^worktrees prune \(demo, report mode\): /);
  writeFileSync(join(w.dirs.home, 'not-a-dir'), '');
  const failedLog = w.cli(['prune', '--summary-only'], { extraEnv: { PIPELINE_PRUNE_LOG_DIR: join(w.dirs.home, 'not-a-dir') } });
  assert.equal(failedLog.code, 0, failedLog.stderr);
  assert.equal(failedLog.stdout.split('\n').length, 2, failedLog.stdout);
  assert.deepEqual(Object.keys(failedLog.json), ['ok', 'summary', 'errors']);
  assert.deepEqual(failedLog.json.errors.map((e) => e.step), ['log']);
  w.fake.setScript([{ match: '^repo view', code: 1, stderr: 'API rate limit exceeded' }]);
  const down = w.cli(['prune', '--summary-only']);
  assert.equal(down.code, 3, down.stdout);
  assert.equal(down.stdout.split('\n').length, 2, down.stdout);
  assert.equal(down.json.ok, false);
  assert.equal(down.json.error, 'unavailable');
});

test('a failing step after removal (purge, log) is reported in errors; the removal record, log attempt and exit 0 survive', {
  skip: (!LINUX && 'process inspection needs /proc') || (process.getuid?.() === 0 && 'root ignores directory permissions'),
}, () => {
  const w = world();
  w.setMode('on');
  const locked = join(w.holdingRepo, '2026-01-01', 'old');
  chmodSync(locked, 0o555); // the expired batch cannot be deleted
  writeFileSync(join(w.dirs.home, 'release-not-a-dir'), 'a file where the log directory should be');
  try {
    const r = w.cli(['prune'], { extraEnv: { PIPELINE_PRUNE_LOG_DIR: join(w.dirs.home, 'release-not-a-dir') } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(slugs(r.json.removed), ['done'], JSON.stringify(r.json));
    assert.deepEqual(r.json.errors.map((e) => e.step).sort(), ['log', 'purge'], JSON.stringify(r.json.errors));
    assert.ok(r.json.holding.batches.length >= 1, 'holding is still listed');
    assert.match(r.json.summary, /removed 1 .* · errors: purge$/, "the summary is the log line, so it names what failed before the log");
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('the pre-removal re-read throwing keeps that worktree ("changed during the run") and the run still reports and logs', {
  skip: !LINUX && 'process inspection needs /proc',
}, async () => {
  const w = world();
  w.setMode('on');
  const { run: runCli } = await import('../pipeline/commands/worktrees.mjs');
  const homeBefore = process.env.HOME;
  process.env.HOME = w.dirs.home; // in-process: transcript and memory lookups must not read the real home
  let r;
  try {
    r = await runCli(['prune'], {
      cwd: w.repo.dir, env: w.env,
      pruneDeps: { listWorktrees: () => { throw new Error('worktree list exploded'); } },
    });
  } finally {
    process.env.HOME = homeBefore;
  }
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual(r.output.removed, []);
  assert.equal(w.keptReason(r.output, 'done'), 'changed during the run (could not re-read: worktree list exploded)');
  assert.deepEqual(slugs(r.output.kept), ['dirty', 'done', 'local', 'nopr', 'open'], 'every candidate is still reported');
  assert.ok(existsSync(w.wtPath('done')));
  assert.ok(r.output.log && readFileSync(r.output.log, 'utf8').includes(r.output.summary), 'the run is logged');
});

test('processes that cannot be inspected are reported once per run (output + summary), never a keep reason', async () => {
  const w = world();
  const { run: runCli } = await import('../pipeline/commands/worktrees.mjs');
  const homeBefore = process.env.HOME;
  process.env.HOME = w.dirs.home; // in-process: transcript and memory lookups must not read the real home
  let r;
  try {
    r = await runCli(['prune'], { cwd: w.repo.dir, env: w.env, pruneDeps: { processesInside: () => ({ available: true, pids: [], hidden: 3 }) } });
  } finally {
    process.env.HOME = homeBefore;
  }
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual(slugs(r.output.wouldRemove), ['done'], JSON.stringify(r.output.kept));
  assert.equal(r.output.hiddenProcesses, 3);
  assert.match(r.output.summary, / · 3 processes could not be inspected \(other users\) · /);
});

test('a quarantine left by a killed run is moved back, even in off mode', () => {
  const w = world();
  w.setMode('off');
  const qDir = join(w.repo.dir, '.worktrees', '.prune-quarantine');
  mkdirSync(qDir);
  w.repo.git(['worktree', 'move', w.wtPath('open'), join(qDir, 'open.deadrun')]);
  const r = w.cli(['prune']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.disabled, true);
  assert.deepEqual(r.json.restored.map((x) => [x.to, x.restored]), [[w.wtPath('open'), true]]);
  assert.ok(existsSync(join(w.wtPath('open'), 'open.txt')));
  assert.equal(existsSync(join(qDir, 'open.deadrun')), false);
});

test('holding: lists batches; --purge needs mode: on', () => {
  const w = world();
  const listed = w.cli(['holding']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.json.batches.map((b) => b.batch), ['2026-01-01']);
  const refused = w.cli(['holding', '--purge']);
  assert.deepEqual(refused.json.purged, []);
  assert.equal(refused.json.note, 'purge needs mode: on');
  assert.ok(existsSync(join(w.holdingRepo, '2026-01-01')));
  w.setMode('on');
  const purged = w.cli(['holding', '--purge']);
  assert.deepEqual(purged.json.purged, ['2026-01-01']);
  assert.equal(existsSync(join(w.holdingRepo, '2026-01-01')), false);
});

test('usage errors exit 2', () => {
  const w = world();
  assert.equal(w.cli(['bogus']).code, 2);
  assert.equal(w.cli(['keep']).code, 2);
  assert.equal(w.cli(['keep', '../x']).code, 2);
});

// ---- schedule: the nightly cron line (crontab and the time zone are injected; the real crontab is never touched) -----

const { scheduleLine, applySchedule, detectTimezone, findOnPath, run: runWorktrees } = await import('../pipeline/commands/worktrees.mjs');

const MARKER = '# claude-pipeline worktrees-prune worktrees-prune-0123456789ab';
const LINE_ARGS = {
  nodePath: '/usr/bin/node', binPath: '/opt/p/pipeline/bin/pipeline.mjs', root: '/home/u/proj', at: '02:30', lockName: 'worktrees-prune-0123456789ab',
  pathDirs: ['/home/u/.nvm/bin', '/usr/bin'], logFile: '/home/u/.local/state/pipeline/cron-worktrees-prune-0123456789ab.log',
};
const OTHER_LINES = '# claude-memory-health\n17 3 * * * /home/u/bin/memory-health.sh\n# claude-notes-gitleaks\n*/30 * * * * /home/u/bin/notes-gitleaks.sh\n';

// An in-memory crontab: read() answers the current text, write() records every replacement.
function fakeCrontab(initial = '') {
  const box = { text: initial, writes: [] };
  const fn = (op, text) => {
    if (op === 'read') return box.text;
    box.text = text;
    box.writes.push(text);
    return undefined;
  };
  return { box, fn };
}

test('scheduleLine: minute hour, cd into the root, node + bin, notify, marker last', () => {
  assert.equal(
    scheduleLine(LINE_ARGS),
    `30 02 * * * cd '/home/u/proj' && PATH='/home/u/.nvm/bin:/usr/bin:/bin' /usr/bin/node /opt/p/pipeline/bin/pipeline.mjs worktrees prune --notify --summary-only >>'/home/u/.local/state/pipeline/cron-worktrees-prune-0123456789ab.log' 2>&1 ${MARKER}`,
  );
  assert.match(scheduleLine({ ...LINE_ARGS, at: '23:05' }), /^05 23 \* \* \* /);
});

test('scheduleLine: a root with spaces or a quote is single-quoted for the shell; node and bin paths with spaces too', () => {
  const line = scheduleLine({ ...LINE_ARGS, root: "/home/u/my proj/it's", nodePath: '/opt/my node/node', binPath: '/opt/p q/pipeline.mjs' });
  assert.ok(line.includes(`cd '/home/u/my proj/it'\\''s' && PATH='/home/u/.nvm/bin:/usr/bin:/bin' '/opt/my node/node' '/opt/p q/pipeline.mjs' worktrees prune`), line);
});

test('scheduleLine: PATH lists the given dirs once, then /usr/bin:/bin; a log file with spaces or a quote is quoted', () => {
  const line = scheduleLine({ ...LINE_ARGS, pathDirs: ['/a/bin', '/bin', '/a/bin'], logFile: "/l o/it's.log" });
  assert.ok(line.includes("PATH='/a/bin:/bin:/usr/bin' "), line);
  assert.ok(line.includes(`>>'/l o/it'\\''s.log' 2>&1`), line);
  assert.ok(!line.includes('/dev/null'));
});

test('scheduleLine: % is escaped (cron turns a bare % into a newline); a newline in a path is refused', () => {
  assert.ok(scheduleLine({ ...LINE_ARGS, root: '/home/u/100%' }).includes("cd '/home/u/100\\%'"));
  assert.throws(() => scheduleLine({ ...LINE_ARGS, root: '/home/u/a\nb' }), /newline/);
});

test('scheduleLine: --at must be HH:MM, 00-23 and 00-59', () => {
  for (const at of ['24:00', '12:60', '2:30', '02:3', 'noon', '', '02:30:00', '-1:00']) {
    assert.throws(() => scheduleLine({ ...LINE_ARGS, at }), /HH:MM/, at);
  }
  assert.match(scheduleLine({ ...LINE_ARGS, at: '00:00' }), /^00 00 /);
  assert.match(scheduleLine({ ...LINE_ARGS, at: '23:59' }), /^59 23 /);
});

test('applySchedule install: appends one line after the existing ones, which stay byte-for-byte', () => {
  const line = scheduleLine(LINE_ARGS);
  const ct = fakeCrontab(OTHER_LINES);
  const r = applySchedule({ action: 'install', line, marker: MARKER, crontabFn: ct.fn, tzFn: () => 'Asia/Manila' });
  assert.deepEqual(r, { installed: true, line, timezone: 'Asia/Manila' });
  assert.equal(ct.box.text, `${OTHER_LINES}${line}\n`);
});

test('applySchedule install: no crontab yet gives just the line; a final line without a newline gets one before ours', () => {
  const line = scheduleLine(LINE_ARGS);
  const empty = fakeCrontab('');
  applySchedule({ action: 'install', line, marker: MARKER, crontabFn: empty.fn, tzFn: () => 'Asia/Manila' });
  assert.equal(empty.box.text, `${line}\n`);
  const bare = fakeCrontab('# only line');
  applySchedule({ action: 'install', line, marker: MARKER, crontabFn: bare.fn, tzFn: () => 'Asia/Manila' });
  assert.equal(bare.box.text, `# only line\n${line}\n`);
});

test('applySchedule install: a second install is idempotent (one line, no rewrite); a new time replaces the line in place', () => {
  const line = scheduleLine(LINE_ARGS);
  const ct = fakeCrontab(`${OTHER_LINES}${line}\n# tail\n`);
  applySchedule({ action: 'install', line, marker: MARKER, crontabFn: ct.fn, tzFn: () => 'Asia/Manila' });
  assert.equal(ct.box.writes.length, 0);
  const later = scheduleLine({ ...LINE_ARGS, at: '04:15' });
  applySchedule({ action: 'install', line: later, marker: MARKER, crontabFn: ct.fn, tzFn: () => 'Asia/Manila' });
  assert.equal(ct.box.text, `${OTHER_LINES}${later}\n# tail\n`);
  assert.equal(ct.box.text.split(MARKER).length - 1, 1);
});

test('applySchedule install: duplicate marker lines collapse to one; a line with a different lock name is left alone', () => {
  const line = scheduleLine(LINE_ARGS);
  const other = scheduleLine({ ...LINE_ARGS, root: '/home/u/other', lockName: 'worktrees-prune-ffffffffffff' });
  const ct = fakeCrontab(`${line}\n${other}\n${line}\n`);
  applySchedule({ action: 'install', line, marker: MARKER, crontabFn: ct.fn, tzFn: () => 'Asia/Manila' });
  assert.equal(ct.box.text, `${line}\n${other}\n`);
});

test('applySchedule install: another time zone adds a warning; an unknown one says so', () => {
  const line = scheduleLine(LINE_ARGS);
  const utc = applySchedule({ action: 'install', line, marker: MARKER, crontabFn: fakeCrontab().fn, tzFn: () => 'UTC' });
  assert.equal(utc.timezone, 'UTC');
  assert.equal(utc.warning, 'cron runs in UTC, not Asia/Manila — 02:30 is local to that zone');
  const unknown = applySchedule({ action: 'install', line, marker: MARKER, crontabFn: fakeCrontab().fn, tzFn: () => null });
  assert.equal(unknown.timezone, null);
  assert.match(unknown.warning, /could not tell/);
  const at = applySchedule({ action: 'install', line: scheduleLine({ ...LINE_ARGS, at: '04:15' }), marker: MARKER, crontabFn: fakeCrontab().fn, tzFn: () => 'UTC' });
  assert.match(at.warning, /04:15 is local/);
});

test('applySchedule remove: drops only the marker line, keeps the rest byte-for-byte; absent is a no-op', () => {
  const line = scheduleLine(LINE_ARGS);
  const ct = fakeCrontab(`${OTHER_LINES}${line}\n`);
  assert.deepEqual(applySchedule({ action: 'remove', marker: MARKER, crontabFn: ct.fn }), { removed: true });
  assert.equal(ct.box.text, OTHER_LINES);
  assert.deepEqual(applySchedule({ action: 'remove', marker: MARKER, crontabFn: ct.fn }), { removed: false });
  assert.equal(ct.box.writes.length, 1);
});

test('applySchedule status: reports presence and the line, never writes', () => {
  const line = scheduleLine(LINE_ARGS);
  const on = fakeCrontab(`${OTHER_LINES}${line}\n`);
  assert.deepEqual(applySchedule({ action: 'status', marker: MARKER, crontabFn: on.fn }), { installed: true, line });
  const off = fakeCrontab(OTHER_LINES);
  assert.deepEqual(applySchedule({ action: 'status', marker: MARKER, crontabFn: off.fn }), { installed: false, line: null });
  assert.equal(on.box.writes.length + off.box.writes.length, 0);
});

// The sub-verb itself, with the crontab, time zone, platform and install paths injected through the context.
function scheduleWorld() {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('a.txt', 'a\n');
  repo.commit('init');
  const ct = fakeCrontab(OTHER_LINES);
  const logDir = tmp('cp-wtlog-');
  const tools = { git: '/opt/git/bin/git', gh: '/opt/gh/bin/gh' };
  const ctx = (cwd = repo.dir, extra = {}) => ({
    cwd, env: { ...process.env, PIPELINE_PRUNE_LOG_DIR: logDir }, platform: 'linux', whichFn: (cmd) => tools[cmd] ?? null, crontabFn: ct.fn, tzFn: () => 'Asia/Manila', nodePath: '/usr/bin/node', binPath: '/opt/p/pipeline/bin/pipeline.mjs', ...extra,
  });
  return { repo, ct, ctx, logDir, tools, run: (args, c = ctx()) => runWorktrees(['schedule', ...args], c) };
}

test('schedule --install: writes the repo-keyed line (default 02:30); --status and --remove follow', async () => {
  const w = scheduleWorld();
  const lockName = lockNameFor(realpathSync.native(join(w.repo.dir, '.git')));
  const r = await w.run(['--install']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  assert.equal(r.output.installed, true);
  assert.equal(r.output.line, `30 02 * * * cd '${w.repo.dir}' && PATH='/usr/bin:/opt/git/bin:/opt/gh/bin:/bin' /usr/bin/node /opt/p/pipeline/bin/pipeline.mjs worktrees prune --notify --summary-only >>'${join(w.logDir, `cron-${lockName}.log`)}' 2>&1 # claude-pipeline worktrees-prune ${lockName}`);
  assert.equal(w.ct.box.text, `${OTHER_LINES}${r.output.line}\n`);
  const st = await w.run(['--status']);
  assert.deepEqual([st.exitCode, st.output.installed, st.output.line], [0, true, r.output.line]);
  const rm = await w.run(['--remove']);
  assert.deepEqual([rm.exitCode, rm.output.removed], [0, true]);
  assert.equal(w.ct.box.text, OTHER_LINES);
  assert.equal((await w.run(['--status'])).output.installed, false);
});

test('schedule --install: git or gh not found on PATH refuses with exit 2 and writes nothing; remove/status do not need them', async () => {
  const w = scheduleWorld();
  for (const missing of ['git', 'gh']) {
    const r = await w.run(['--install'], w.ctx(w.repo.dir, { whichFn: (cmd) => (cmd === missing ? null : `/opt/${cmd}/bin/${cmd}`) }));
    assert.equal(r.exitCode, 2, missing);
    assert.equal(r.output.error, 'tool-missing');
    assert.match(r.output.message, new RegExp(`${missing} was not found on PATH`));
  }
  assert.equal(w.ct.box.writes.length, 0);
  const none = () => null;
  assert.equal((await w.run(['--status'], w.ctx(w.repo.dir, { whichFn: none }))).exitCode, 0);
  assert.equal((await w.run(['--remove'], w.ctx(w.repo.dir, { whichFn: none }))).exitCode, 0);
});

test('schedule --install creates the log directory so cron can open the redirect', async () => {
  const w = scheduleWorld();
  const nested = join(w.logDir, 'not', 'yet');
  await w.run(['--install'], w.ctx(w.repo.dir, { env: { ...process.env, PIPELINE_PRUNE_LOG_DIR: nested } }));
  assert.equal(existsSync(nested), true);
});

test('detectTimezone: timedatectl first, then the /etc/localtime link, then /etc/timezone last; a failing source is skipped', () => {
  const val = (v) => () => v;
  const boom = () => { throw new Error('no such file'); };
  assert.equal(detectTimezone([val('Asia/Manila\n'), val('UTC'), val('Europe/Paris')]), 'Asia/Manila');
  assert.equal(detectTimezone([val(null), val('America/New_York'), val('Stale/Zone')]), 'America/New_York');
  assert.equal(detectTimezone([boom, val(''), val('Asia/Manila\n')]), 'Asia/Manila');
  assert.equal(detectTimezone([boom, boom, boom]), null);
  assert.equal(detectTimezone([val(null), val('  '), val(undefined)]), null);
});

test('findOnPath: the first executable match in PATH order, null when absent', { skip: process.platform === 'win32' }, () => {
  const a = tmp('cp-wtpath-');
  const b = tmp('cp-wtpath-');
  writeFileSync(join(b, 'tool'), '#!/bin/sh\n');
  chmodSync(join(b, 'tool'), 0o755);
  writeFileSync(join(a, 'plain'), 'x');
  chmodSync(join(a, 'plain'), 0o644);
  assert.equal(findOnPath('tool', `${a}:${b}`), join(b, 'tool'));
  assert.equal(findOnPath('plain', `${a}:${b}`), null);
  assert.equal(findOnPath('missing', `${a}:${b}`), null);
});

test('schedule --install --at 04:15 uses that time; a bad --at is a usage error and writes nothing', async () => {
  const w = scheduleWorld();
  assert.match((await w.run(['--install', '--at', '04:15'])).output.line, /^15 04 /);
  const writes = w.ct.box.writes.length;
  await assert.rejects(() => w.run(['--install', '--at', '25:00']), /HH:MM/);
  assert.equal(w.ct.box.writes.length, writes);
});

test('schedule from the main checkout and from a linked worktree replaces the same line', async () => {
  const w = scheduleWorld();
  w.repo.git(['worktree', 'add', '-q', '-b', 'feat/x', join(w.repo.dir, '.worktrees', 'x'), 'main']);
  const first = await w.run(['--install']);
  const second = await w.run(['--install', '--at', '05:00'], w.ctx(join(w.repo.dir, '.worktrees', 'x')));
  assert.equal(second.output.line.includes(`cd '${w.repo.dir}'`), true, 'the canonical root, not the worktree');
  assert.equal(w.ct.box.text.split('# claude-pipeline worktrees-prune').length - 1, 1);
  assert.equal(w.ct.box.text, `${OTHER_LINES}${second.output.line}\n`);
  assert.notEqual(first.output.line, second.output.line);
});

test('schedule outside Linux is refused with exit 2 and the crontab is untouched', async () => {
  const w = scheduleWorld();
  for (const verb of ['--install', '--remove', '--status']) {
    const r = await w.run([verb], w.ctx(w.repo.dir, { platform: 'win32' }));
    assert.equal(r.exitCode, 2, verb);
    assert.equal(r.output.message, 'schedule is only supported on Linux (cron) in this version');
  }
  assert.equal(w.ct.box.writes.length, 0);
});

test('schedule: exactly one of --install / --remove / --status; --at only with --install; no NAME', async () => {
  const w = scheduleWorld();
  for (const args of [[], ['--install', '--remove'], ['--status', '--at', '03:00'], ['--remove', '--at', '03:00'], ['--install', 'extra']]) {
    await assert.rejects(() => w.run(args), /schedule/, args.join(' '));
  }
  assert.equal(w.ct.box.writes.length, 0);
});

// The real CLI path with a stub `crontab` first on PATH (a shell script, so Linux only): "no crontab for user" reads as an
// empty crontab, and the new text arrives on stdin of `crontab -`.
test('schedule through the CLI uses the system crontab: no crontab yet, then install, status, remove', { skip: !LINUX }, () => {
  const w = scheduleWorld();
  const bin2 = tmp('cp-wtcron-');
  const store = join(bin2, 'store');
  writeFileSync(join(bin2, 'crontab'), [
    '#!/bin/sh',
    `if [ "$1" = "-l" ]; then if [ -f '${store}' ]; then cat '${store}'; exit 0; fi; echo "no crontab for tester" >&2; exit 1; fi`,
    `if [ "$1" = "-" ]; then cat > '${store}'; exit 0; fi`,
    'exit 2',
    '',
  ].join('\n'));
  chmodSync(join(bin2, 'crontab'), 0o755);
  writeFileSync(join(bin2, 'gh'), '#!/bin/sh\nexit 0\n'); // only has to exist: the install looks for it on PATH
  chmodSync(join(bin2, 'gh'), 0o755);
  const logs = tmp('cp-wtcronlog-');
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [bin, 'worktrees', 'schedule', ...args], {
      cwd: w.repo.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin2}:${process.env.PATH}`, PIPELINE_PRUNE_LOG_DIR: logs },
    });
    return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
  };
  assert.equal(cli('--status').json.installed, false);
  const inst = cli('--install', '--at', '03:10');
  assert.equal(inst.code, 0, inst.stderr);
  assert.equal(inst.json.installed, true);
  assert.equal(readFileSync(store, 'utf8'), `${inst.json.line}\n`);
  assert.ok(inst.json.line.includes(`cd '${w.repo.dir}' && PATH=`) && inst.json.line.includes(`' ${process.execPath} `), inst.json.line);
  assert.ok(inst.json.line.includes(`${bin} worktrees prune --notify --summary-only >>'${logs}/cron-`), inst.json.line);
  assert.ok(inst.json.line.match(/PATH='([^']*)'/)[1].split(':').includes(bin2), inst.json.line); // the stub dir is where gh (and crontab) were found
  assert.equal(cli('--status').json.installed, true);
  assert.equal(cli('--remove').json.removed, true);
  assert.equal(readFileSync(store, 'utf8'), '');
});

test('outsideReport lists only Claude project dirs (name starts with "-") as session scratch', () => {
  const root = tmp('outside-root-');
  const scr = tmp('outside-scratch-');
  mkdirSync(join(scr, '-home-x-proj', 'sess1'), { recursive: true });
  mkdirSync(join(scr, '-home-x-proj', 'sess2'), { recursive: true });
  mkdirSync(join(scr, 'bash-edit-diff', 'abc123'), { recursive: true }); // Claude Code's own edit-diff temp, not a project
  const got = outsideReport(root, { PIPELINE_SCRATCH_DIR: scr }).map((o) => o.path).sort();
  assert.deepEqual(got, [join(scr, '-home-x-proj', 'sess1'), join(scr, '-home-x-proj', 'sess2')]);
});
