// Why: route.json is the one evidence record of a Codex attempt, and its final write is a compare-and-swap. A pending record installed BETWEEN that compare and write would be
// overwritten by the older attempt (R1-B2). Installing the pending record takes a dedicated per-PR ROUTE lock (and not the review lock: Codex must start while a round is
// being recorded under the review lock), and every final write holds the route lock inside the review lock (order: review, then route).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertCurrentAttempt, finishAttempt, readRoute, routeFile, startAttempt, writeFinalRoute } from '../pipeline/lib/route-record.mjs';
import { routeLockName, reviewLockName, withReviewLock, withRouteLock } from '../pipeline/lib/review-context.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'cp-route-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { env: { PIPELINE_LOCK_DIR: join(root, 'locks') } };
  const args = { root, pr: 7, ctx, round: 1, base: 'a', head: 'b', patchSha256: 'c', risk: 'low', agent: 'x' };
  return { root, ctx, args };
}

test('the route lock is its own lock, named after the review lock', (t) => {
  const { root } = setup(t);
  assert.notEqual(routeLockName(root, 7), reviewLockName(root, 7));
  assert.ok(routeLockName(root, 7).startsWith(reviewLockName(root, 7)));
  assert.notEqual(routeLockName(root, 8), routeLockName(root, 7));
});

test('startAttempt installs the pending record under the route lock: it waits for a holder and does not replace the record meanwhile', async (t) => {
  const { root, ctx, args } = setup(t);
  let started;
  await withRouteLock(root, 7, ctx, async () => {
    started = startAttempt(args);
    await sleep(300);
    assert.equal(existsSync(routeFile(root, 1)), false, 'blocked while the route lock is held');
  });
  const attempt = await started;
  assert.equal(readRoute(root, 1)?.attemptId, attempt.attemptId, 'installed once the lock is free');
  assert.equal(readRoute(root, 1)?.evidence, 'pending');
});

test('a held REVIEW lock does not block the pending write (Codex starts while a round is being recorded)', async (t) => {
  const { root, ctx, args } = setup(t);
  let attempt;
  await withReviewLock(root, 7, ctx, async () => {
    attempt = await startAttempt(args);
    assert.equal(readRoute(root, 1)?.attemptId, attempt.attemptId);
  });
  assert.equal(readRoute(root, 1)?.evidence, 'pending');
});

test('a pending write cannot land between a compare-and-swap\'s compare and its write', async (t) => {
  const { root, ctx, args } = setup(t);
  const older = await startAttempt(args);
  let newer;
  await withReviewLock(root, 7, ctx, () => withRouteLock(root, 7, ctx, async () => {
    const pending = assertCurrentAttempt(root, 1, older.attemptId); // the compare
    newer = startAttempt(args); // a newer attempt starts now
    await sleep(300);
    assert.equal(readRoute(root, 1)?.attemptId, older.attemptId, 'the newer pending record waits for the swap');
    writeFinalRoute(root, 1, pending, { evidence: 'none', outcome: 'recorded' }); // the write
  }));
  const second = await newer;
  assert.equal(readRoute(root, 1)?.attemptId, second.attemptId, 'the newer attempt supersedes the finished one afterwards');
  assert.equal(readRoute(root, 1)?.evidence, 'pending');
});

test('finishAttempt holds the route lock for its compare-and-swap: a pending write waits for it', async (t) => {
  const { root, ctx, args } = setup(t);
  const older = await startAttempt(args);
  let finished;
  await withRouteLock(root, 7, ctx, async () => {
    finished = finishAttempt({ root, pr: 7, ctx, round: 1, attempt: older, final: { evidence: 'none', outcome: 'failed', reason: 'x' }, files: [] });
    await sleep(300);
    assert.equal(readRoute(root, 1)?.evidence, 'pending', 'the final write waits for the route lock');
  });
  await finished;
  assert.equal(readRoute(root, 1)?.evidence, 'none');
});
