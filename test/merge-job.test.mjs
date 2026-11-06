// merge-carry T3: checkout ownership for a long `P merge --owner-go` job, on real temp git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { advanceCheckout, claimCheckout, releaseCheckout, verifyCheckout, MERGE_JOB_MARKER } from '../pipeline/lib/merge-job.mjs';
import { mergeJobOf } from '../pipeline/hooks/lib/merge-job-lookup.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: join(tmpdir(), 'no-such-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd, file, text, msg = file) => {
  writeFileSync(join(cwd, file), text);
  g(cwd, 'add', file);
  g(cwd, 'commit', '-q', '-m', msg);
  return g(cwd, 'rev-parse', 'HEAD');
};
// a repo on branch agent/x with one commit, plus a descendant commit `ahead` on a side branch
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-job-')));
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'commit.gpgsign', 'false');
  const base = commit(root, 'a.txt', 'a\n');
  g(root, 'checkout', '-q', '-b', 'agent/x');
  g(root, 'branch', 'ahead');
  g(root, 'checkout', '-q', 'ahead');
  const ahead = commit(root, 'b.txt', 'b\n');
  g(root, 'checkout', '-q', 'agent/x');
  return { root, base, ahead };
}
const markerPath = (root) => join(root, MERGE_JOB_MARKER);
const readMarker = (root) => JSON.parse(readFileSync(markerPath(root), 'utf8'));
const NOW = () => new Date('2026-11-06T10:00:00Z');
const claimed = (r) => {
  const c = claimCheckout({ root: r.root, pr: 7, now: NOW });
  assert.equal(c.ok, true, JSON.stringify(c));
  return c.marker;
};
// the pid of a process that has already exited
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('claim: writes the marker for a clean checkout on a branch', () => {
  const r = repo();
  const c = claimCheckout({ root: r.root, pr: 7, pid: process.pid, now: NOW });
  assert.equal(c.ok, true);
  assert.deepEqual(c.marker, { pr: 7, pid: process.pid, branch: 'agent/x', expectedHead: r.base, startedAt: '2026-11-06T10:00:00.000Z' });
  assert.deepEqual(readMarker(r.root), c.marker);
  assert.equal(mergeJobOf(r.root)?.pr, 7); // the guard's lookup sees it (live pid)
});

test('claim: a dirty checkout is refused with the paths; .review and .verify do not count', () => {
  const r = repo();
  mkdirSync(join(r.root, '.review'), { recursive: true });
  mkdirSync(join(r.root, '.verify'), { recursive: true });
  writeFileSync(join(r.root, '.review', 'state.json'), '{}');
  writeFileSync(join(r.root, '.verify', 'log.txt'), 'x');
  assert.equal(claimCheckout({ root: r.root, pr: 7 }).ok, true);
  rmSync(markerPath(r.root));
  writeFileSync(join(r.root, 'a.txt'), 'changed\n');
  writeFileSync(join(r.root, 'new.txt'), 'n\n');
  const c = claimCheckout({ root: r.root, pr: 7 });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'dirty');
  assert.match(c.reason, /a\.txt/);
  assert.match(c.reason, /new\.txt/);
  assert.equal(existsSync(markerPath(r.root)), false);
});

test('claim: lists at most five dirty paths', () => {
  const r = repo();
  for (let i = 0; i < 8; i++) writeFileSync(join(r.root, `f${i}.txt`), 'x');
  const c = claimCheckout({ root: r.root, pr: 7 });
  assert.equal(c.code, 'dirty');
  assert.match(c.reason, /\(\+3 more\)/);
});

test('claim: a detached HEAD is refused', () => {
  const r = repo();
  g(r.root, 'checkout', '-q', '--detach');
  const c = claimCheckout({ root: r.root, pr: 7 });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'detached');
});

test('claim: a live marker of another process means busy, and is left alone', () => {
  const r = repo();
  mkdirSync(join(r.root, '.review'), { recursive: true });
  const other = { pr: 3, pid: process.ppid, branch: 'agent/x', expectedHead: r.base, startedAt: '2026-11-06T09:00:00.000Z' };
  writeFileSync(markerPath(r.root), JSON.stringify(other));
  const c = claimCheckout({ root: r.root, pr: 7 });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'busy');
  assert.match(c.reason, new RegExp(`pid ${process.ppid}`));
  assert.deepEqual(readMarker(r.root), other);
});

test('claim: a stale marker (dead pid) is replaced; a garbled one too', () => {
  const r = repo();
  mkdirSync(join(r.root, '.review'), { recursive: true });
  writeFileSync(markerPath(r.root), JSON.stringify({ pr: 3, pid: deadPid(), branch: 'agent/x', expectedHead: r.base, startedAt: 'x' }));
  assert.equal(mergeJobOf(r.root), null); // a dead pid blocks nothing
  assert.equal(claimCheckout({ root: r.root, pr: 7, now: NOW }).ok, true);
  assert.equal(readMarker(r.root).pr, 7);
  rmSync(markerPath(r.root));
  writeFileSync(markerPath(r.root), '{ not json');
  assert.equal(mergeJobOf(r.root), null);
  assert.equal(claimCheckout({ root: r.root, pr: 8, now: NOW }).ok, true);
  assert.equal(readMarker(r.root).pr, 8);
});

test('advance: fast-forwards to a descendant, rewrites the marker, leaves the tree clean', () => {
  const r = repo();
  const marker = claimed(r);
  const a = advanceCheckout({ root: r.root, marker, to: r.ahead });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.marker.expectedHead, r.ahead);
  assert.equal(readMarker(r.root).expectedHead, r.ahead);
  assert.equal(g(r.root, 'rev-parse', 'refs/heads/agent/x'), r.ahead);
  assert.equal(g(r.root, 'symbolic-ref', '--short', 'HEAD'), 'agent/x');
  assert.equal(existsSync(join(r.root, 'b.txt')), true);
  assert.deepEqual(verifyCheckout({ root: r.root, marker: a.marker }), { ok: true });
  // a second advance is judged against the NEW expected head: a commit made by someone else in between is noticed
  const mine = commit(r.root, 'c.txt', 'c\n');
  const again = advanceCheckout({ root: r.root, marker: a.marker, to: r.ahead });
  assert.equal(again.code, 'checkout-changed');
  assert.ok(again.reason.includes(r.ahead) && again.reason.includes(mine), again.reason);
});

test('advance: a branch switch between the check and the merge is terminal and names the ref', () => {
  const r = repo();
  const marker = claimed(r);
  const out = advanceCheckout({ root: r.root, marker, to: r.ahead, beforeMerge: () => g(r.root, 'checkout', '-q', 'main') });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'checkout-changed');
  assert.match(out.reason, /agent\/x/);
  assert.match(out.reason, /now main/);
  assert.equal(readMarker(r.root).expectedHead, r.base); // marker not advanced
});

test('advance: a branch switch before the advance is caught by the pre-check', () => {
  const r = repo();
  const marker = claimed(r);
  g(r.root, 'checkout', '-q', 'main');
  const out = advanceCheckout({ root: r.root, marker, to: r.ahead });
  assert.equal(out.code, 'checkout-changed');
  assert.match(out.reason, /was on branch agent\/x, now main/);
  assert.equal(g(r.root, 'rev-parse', 'main'), r.base);
});

test('advance: a local commit after the claim is terminal and names both heads', () => {
  const r = repo();
  const marker = claimed(r);
  const mine = commit(r.root, 'local.txt', 'l\n');
  const out = advanceCheckout({ root: r.root, marker, to: r.ahead });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'checkout-changed');
  assert.ok(out.reason.includes(r.base) && out.reason.includes(mine), out.reason);
  assert.equal(g(r.root, 'rev-parse', 'HEAD'), mine); // nothing reset
});

test('advance / verify: a dirty tree after the claim is terminal', () => {
  const r = repo();
  const marker = claimed(r);
  writeFileSync(join(r.root, 'a.txt'), 'edited\n');
  assert.equal(verifyCheckout({ root: r.root, marker }).code, 'checkout-changed');
  const out = advanceCheckout({ root: r.root, marker, to: r.ahead });
  assert.equal(out.code, 'checkout-changed');
  assert.match(out.reason, /a\.txt/);
  assert.equal(g(r.root, 'rev-parse', 'HEAD'), r.base);
});

test('verify: ok on an untouched checkout, changed after a detach', () => {
  const r = repo();
  const marker = claimed(r);
  assert.deepEqual(verifyCheckout({ root: r.root, marker }), { ok: true });
  g(r.root, 'checkout', '-q', '--detach');
  const v = verifyCheckout({ root: r.root, marker });
  assert.equal(v.code, 'checkout-changed');
  assert.match(v.reason, /detached/);
});

test('advance: a non-descendant target is refused and nothing changes', () => {
  const r = repo();
  g(r.root, 'checkout', '-q', 'main');
  g(r.root, 'checkout', '-q', '-b', 'other');
  const other = commit(r.root, 'o.txt', 'o\n');
  g(r.root, 'checkout', '-q', 'agent/x');
  const mine = commit(r.root, 'x.txt', 'x\n'); // agent/x and other now diverge
  const marker = claimed(r);
  const out = advanceCheckout({ root: r.root, marker, to: other });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ff-refused');
  assert.equal(g(r.root, 'rev-parse', 'HEAD'), mine);
  assert.equal(readMarker(r.root).expectedHead, mine);
  assert.equal(existsSync(join(r.root, 'o.txt')), false);
});

test('advance: an unknown or option-shaped target is refused', () => {
  const r = repo();
  const marker = claimed(r);
  assert.equal(advanceCheckout({ root: r.root, marker, to: '0'.repeat(40) }).code, 'bad-target');
  assert.equal(advanceCheckout({ root: r.root, marker, to: '--force' }).code, 'bad-target');
});

test('release: removes only our own marker', () => {
  const r = repo();
  const marker = claimed(r);
  const foreign = { ...marker, pid: process.ppid, startedAt: '2026-11-06T11:00:00.000Z' };
  writeFileSync(markerPath(r.root), JSON.stringify(foreign));
  assert.deepEqual(releaseCheckout({ root: r.root, marker }), { released: false });
  assert.deepEqual(readMarker(r.root), foreign);
  writeFileSync(markerPath(r.root), JSON.stringify(marker));
  assert.deepEqual(releaseCheckout({ root: r.root, marker }), { released: true });
  assert.equal(existsSync(markerPath(r.root)), false);
  assert.deepEqual(releaseCheckout({ root: r.root, marker }), { released: false }); // already gone
});
