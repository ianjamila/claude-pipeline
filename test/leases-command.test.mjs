// `pipeline leases`: the read-only view of the review-lease folder (plan 2026-11-12 "Terminal leases + lease hardening", step 4). What it prints is scanLeases'
// own answer in a stable shape; it takes no lease itself, writes nothing and sweeps nothing. The machine (ps, the pid probe, the session record) is injected
// through ctx.leaseOpts; the scan-error and --repo cases run the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../pipeline/bin/pipeline.mjs';
import { LEASED_COMMANDS } from '../pipeline/lib/review-lease-wiring.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { noClaudeSession } from './helpers/no-claude-session.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const START = 'Thu Nov 12 07:00:00 2026';
const NOW = new Date().toISOString();
const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-leases-'))); made.push(d); return d; };

const LEASE = { repoId: 'acme/app', pr: 7, generation: 'g1', openedAt: NOW, renewedAt: NOW, command: 'codex-review' };
const put = (dir, id, body) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body)); };
const procBody = (pid, wt, extra = {}) => ({ version: 2, holder: 'process', sessionId: `proc-${pid}-0a0b0c0d`, pid, pidStart: START, host: 'thishost', machineId: 'm1', leases: { [wt]: { ...LEASE } }, ...extra });

// A folder with: a running session (live), a gone terminal process (dead), a terminal process of another machine (uncertain = live + unchecked) and two unreadable files.
function world() {
  const root = scratch();
  const dir = join(root, 'review-leases');
  put(dir, 'sess-1', { version: 1, sessionId: 'sess-1', pid: 111, pidStart: START, leases: { '/work/live': { ...LEASE, branch: undefined, pr: 7 } } });
  put(dir, 'proc-4242-0a0b0c0d', procBody(4242, '/work/dead'));
  put(dir, 'proc-4243-0a0b0c0d', procBody(4243, '/work/uncertain', { host: 'elsewhere', machineId: 'm2' }));
  put(dir, 'proc-4244-0a0b0c0d', '{ not json');
  put(dir, 'sess-bad', '[1, 2');
  const leaseOpts = {
    dir, host: 'thishost', machineId: 'm1', ancestorPid: null,
    starts: (pids) => new Map(pids.filter((p) => p === 111).map((p) => [p, START])),
    sessionRecord: (pid) => (pid === 111 ? { sessionId: 'sess-1', procStart: START } : null),
    kill: () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); },
    jobLive: () => false,
  };
  return { root, dir, leaseOpts };
}
async function leases(w, argv = [], extra = {}) {
  const out = [];
  const code = await main(['leases', ...argv], { stdout: { write: (s) => { out.push(s); } }, cwd: w.root, env: { ...process.env }, leaseOpts: w.leaseOpts, ...extra });
  return { code, json: JSON.parse(out.join('')) };
}
const before = (dir) => readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]);

test('leases is read only and takes no lease of its own', () => {
  assert.equal(LEASED_COMMANDS.has('leases'), false);
});

test('leases prints the live work and the unreadable files, in a stable shape, and changes nothing', async () => {
  const w = world();
  const files = before(w.dir);
  const { code, json } = await leases(w);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.ok, true);
  assert.equal('dead' in json, false, 'dead leases only with --all');
  assert.deepEqual(json.live.map((e) => e.worktree).sort(), ['/work/live', '/work/uncertain']);
  const live = json.live.find((e) => e.worktree === '/work/live');
  assert.deepEqual({ ...live, why: undefined }, {
    holder: 'session', sessionId: 'sess-1', worktree: '/work/live', repoId: 'acme/app', pr: 7, command: 'codex-review', openedAt: NOW, renewedAt: NOW, why: undefined,
  });
  assert.match(live.why, /session sess-1 running/);
  const uncertain = json.live.find((e) => e.worktree === '/work/uncertain');
  assert.equal(uncertain.holder, 'process');
  assert.equal(uncertain.pid, 4243);
  assert.equal(uncertain.unchecked, true);
  assert.match(uncertain.hint, /delete .*proc-4243-0a0b0c0d\.json/);
  assert.match(uncertain.why, /cannot confirm/);
  assert.deepEqual(json.unreadable.map((u) => u.sessionId).sort(), ['proc-4244-0a0b0c0d', 'sess-bad']);
  const proc = json.unreadable.find((u) => u.sessionId === 'proc-4244-0a0b0c0d');
  assert.equal(proc.unchecked, true);
  assert.match(proc.hint, /delete /);
  assert.equal(json.unreadable.find((u) => u.sessionId === 'sess-bad').unchecked, undefined, 'only a terminal file is known not to be a session\'s');
  assert.deepEqual(before(w.dir), files, 'no write, no sweep');
});

test('leases --all adds the dead leases (still not removed)', async () => {
  const w = world();
  const files = before(w.dir);
  const { code, json } = await leases(w, ['--all']);
  assert.equal(code, 0);
  assert.equal(json.dead.length, 1);
  assert.equal(json.dead[0].worktree, '/work/dead');
  assert.equal(json.dead[0].holder, 'process');
  assert.equal(json.dead[0].pid, 4242);
  assert.match(json.dead[0].why, /gone/);
  assert.equal(json.live.length, 2);
  assert.deepEqual(before(w.dir), files);
});

test('leases with nothing in the folder is empty, not an error', async () => {
  const w = world();
  const { code, json } = await leases(w, [], { leaseOpts: { ...w.leaseOpts, dir: join(w.root, 'nothing-here') } });
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, live: [], unreadable: [] });
});

test('a scan that throws is exit 1 scan-failed, through the real CLI', () => {
  const w = world();
  const notAFolder = join(w.root, 'a-file');
  writeFileSync(notAFolder, 'x');
  const r = spawnSync(process.execPath, [BIN, 'leases'], { cwd: w.root, encoding: 'utf8', env: { ...process.env, ...noClaudeSession(), PIPELINE_REVIEW_LEASE_DIR: notAFolder } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'scan-failed');
  assert.equal(typeof json.message, 'string');
  assert.equal(existsSync(notAFolder), true);
});

test('leases --repo keeps the leases inside that repository\'s worktrees (unreadable files always stay: they cannot be attributed)', async () => {
  const w = world();
  const repo = createTmpRepo();
  repo.write('a.txt', 'a\n');
  repo.commit('init');
  const other = createTmpRepo();
  other.write('a.txt', 'a\n');
  other.commit('init');
  put(w.dir, 'proc-5001-0a0b0c0d', procBody(5001, join(repo.dir, 'sub'), { host: 'elsewhere', machineId: 'm2' }));
  put(w.dir, 'proc-5002-0a0b0c0d', procBody(5002, other.dir, { host: 'elsewhere', machineId: 'm2' }));
  const { code, json } = await leases(w, ['--repo', repo.dir]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.live.map((e) => e.pid), [5001]);
  assert.equal(json.unreadable.length, 2);
  const none = await leases(w, ['--repo', join(w.root, 'not-a-repo')]);
  assert.equal(none.code, 2);
  assert.equal(none.json.error, 'repo');
});

test('leases rejects unknown flags and positionals (exit 2)', async () => {
  const w = world();
  assert.equal((await leases(w, ['--bogus'])).code, 2);
  assert.equal((await leases(w, ['extra'])).code, 2);
});
