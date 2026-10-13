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
  mkdirSync(join(dirs.scratch, 'proj', 'sess'), { recursive: true });
  writeFileSync(join(dirs.scratch, 'proj', 'sess', 'note.txt'), 'scratch\n');

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
    return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  const setMode = (mode) => repo.write('.claude/pipeline.yml', `${pipelineYml()}worktrees:\n  mode: ${mode}\n`);
  const snapshot = () => ({
    repo: walk(repo.dir, true),
    holding: walk(dirs.holding),
    worktrees: repo.git(['worktree', 'list', '--porcelain']),
    refs: repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
  });
  const keptReason = (json, slug) => json.kept.find((k) => k.slug === slug)?.reason;
  return { repo, dirs, wtPath, cli, setMode, snapshot, fake, script, keptReason, holdingRepo };
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
  assert.ok(outside.includes(join(w.dirs.scratch, 'proj', 'sess')), JSON.stringify(outside));
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
  w.fake.setScript(w.script([{ match: 'branch=feat/open$', code: 1, stderr: 'HTTP 502: bad gateway' }]));
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
