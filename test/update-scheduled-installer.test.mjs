// Why: the scheduled run's safety rests on a contract with the downloaded installer (install.mjs, built separately): it is started with
// `--require-no-live-reviews` and `--expect-installed <sha>`; exit 3 + {deferred: true, live: [...]} means "a review is live, nothing written";
// exit 1 + {error: 'expect-installed-mismatch'} means "the install changed during the download, nothing written". This test runs the REAL download
// (a local git repo through the PIPELINE_UPDATE_REMOTE seam) and the real installer child, but with a STUB install.mjs in that repo that records
// its arguments and answers per STUB_MODE, so the flag plumbing and the exit-code mapping are pinned without the real installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as update } from '../pipeline/commands/update.mjs';
import { pipelineStateDir, STATUS_FILE } from '../pipeline/lib/auto-update.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-upd-stub-'))); made.push(d); return d; };

const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ID } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// The stub installer. It mentions TMP_ROOT_REL (update checks the installer knows the private download folder) and has a private-tmp.mjs beside it.
const STUB = `import fs from 'node:fs';
// TMP_ROOT_REL
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.STUB_MODE;
if (mode === 'deferred' && process.argv.includes('--require-no-live-reviews') && !process.argv.includes('--check')) {
  console.log(JSON.stringify({ deferred: true, live: [{ kind: 'review-lease', repo: 'acme/app', pr: 12, worktree: '/work/app-12' }] }));
  process.exit(3);
}
if (mode === 'mismatch' && process.argv.includes('--expect-installed') && !process.argv.includes('--check')) {
  console.log(JSON.stringify({ ok: false, error: 'expect-installed-mismatch', message: 'the installed copy is not the one expected' }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true }));
`;

let upstream = null;
function stubUpstream() {
  if (upstream) return upstream;
  const work = scratch();
  mkdirSync(join(work, 'pipeline', 'lib'), { recursive: true });
  writeFileSync(join(work, 'install.mjs'), STUB);
  writeFileSync(join(work, 'pipeline', 'lib', 'private-tmp.mjs'), '// stub\n');
  git(work, ['init', '--quiet']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['add', '-A']);
  git(work, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the thing (#99)']);
  const bare = join(scratch(), 'upstream.git');
  git(work, ['clone', '--quiet', '--bare', work, bare]);
  upstream = { bare, sha: git(work, ['rev-parse', 'HEAD']) };
  return upstream;
}

const OLD = 'c'.repeat(40);
const pristine = (sourceSha) => ({ stamp: `1.0+${sourceSha.slice(0, 7)}`, sourceSha, complete: true, sourceDirty: false, modified: [], missing: [], extra: [], scanError: [] });

// One scheduled run against the stub upstream. `identity` is what the installed copy reads as (before, then after the install).
async function scheduledRun(mode, { identity = [pristine(OLD)] } = {}) {
  const { bare, sha } = stubUpstream();
  const dir = scratch();
  const home = join(dir, 'claude');
  mkdirSync(home, { recursive: true });
  const argvLog = join(dir, 'argv.log');
  const notices = [];
  let reads = 0;
  const auto = {
    mainSha: () => ({ ok: true, sha, via: 'gh' }),
    relate: () => ({ status: 'ahead' }),
    installedIdentity: () => identity[Math.min(reads++, identity.length - 1)],
    notify: async (t) => { notices.push(t); },
    now: () => new Date(Date.UTC(2026, 10, 11)),
    accountHome: join(dir, 'account'),
  };
  const env = { ...process.env, PIPELINE_UPDATE_REMOTE: bare, STUB_MODE: mode, STUB_ARGV_LOG: argvLog };
  delete env.CLAUDECODE;
  const r = await update(['--scheduled', '--json', '--claude-home', home], { env, hasClaudeCodeAncestor: () => false, auto });
  const argv = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const status = JSON.parse(readFileSync(join(pipelineStateDir(auto.accountHome), STATUS_FILE), 'utf8'));
  const tmpRoot = join(home, 'pipeline-state', 'tmp');
  return { r, argv, status, notices, sha, leftovers: existsSync(tmpRoot) ? readdirSync(tmpRoot) : [] };
}

test('the installer child gets --require-no-live-reviews and --expect-installed <the installed sha>; a successful install is verified, titled and announced', async () => {
  const t = await scheduledRun('ok', { identity: [pristine(OLD), pristine(OLD), pristine(stubUpstream().sha)] });
  assert.equal(t.r.exitCode, 0, JSON.stringify(t.r.output));
  assert.equal(t.r.output.action, 'updated');
  const [install, check] = t.argv;
  assert.ok(install.includes('--require-no-live-reviews'), JSON.stringify(install));
  assert.deepEqual(install.slice(install.indexOf('--expect-installed'), install.indexOf('--expect-installed') + 2), ['--expect-installed', OLD]);
  assert.ok(check.includes('--check'), 'the verify step runs the installer --check');
  assert.deepEqual(t.notices, [`pipeline updated to ${t.sha.slice(0, 7)} (Add the thing (#99))`]);
  assert.equal(t.status.state, 'current');
  assert.equal(t.status.mainTitle, 'Add the thing (#99)');
  assert.deepEqual(t.leftovers, [], 'the download is removed');
});

test('installer exit 3 {deferred, live}: nothing installed, exit 0, deferred-by-review naming the holders, no verify step, download removed', async () => {
  const t = await scheduledRun('deferred');
  assert.equal(t.r.exitCode, 0, JSON.stringify(t.r.output));
  assert.equal(t.r.output.action, 'deferred');
  assert.match(t.r.output.message, /acme\/app #12 \(\/work\/app-12\)/);
  assert.equal(t.argv.length, 1, 'only the install call, no --check');
  assert.equal(t.status.state, 'deferred-by-review');
  assert.deepEqual(t.status.deferredBy, [{ repo: 'acme/app', pr: 12, worktree: '/work/app-12', kind: 'review-lease' }]);
  assert.equal(t.notices.length, 0);
  assert.deepEqual(t.leftovers, []);
});

test('installer exit 1 {error: expect-installed-mismatch}: no install and no verify; a still-clean copy is judged again next run, quietly', async () => {
  const t = await scheduledRun('mismatch', { identity: [pristine(OLD), pristine(OLD), pristine('d'.repeat(40))] });
  assert.equal(t.r.exitCode, 0, JSON.stringify(t.r.output));
  assert.equal(t.r.output.action, 'changed');
  assert.equal(t.argv.length, 1);
  assert.equal(t.notices.length, 0);
  assert.equal(t.status.state, 'behind');
});

test('the copy changed BEFORE the installer starts (the pre-install re-check): the installer is never run', async () => {
  const t = await scheduledRun('ok', { identity: [pristine(OLD), { ...pristine(OLD), modified: ['pipeline/lib/x.mjs'] }] });
  assert.equal(t.argv.length, 0, 'the installer child was not started');
  assert.equal(t.r.exitCode, 0);
  assert.deepEqual([t.r.output.action, t.r.output.reason], ['blocked', 'modified']);
  assert.equal(t.notices.length, 1);
});
