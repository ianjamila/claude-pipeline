// Why: route.json is the one evidence record of a Codex attempt, and its final write is a compare-and-swap under the review lock. A pending record that is
// installed WITHOUT the lock can land between that compare and write, so the older attempt overwrites the newer one (R1-B2). Installing the pending record takes
// the same lock, but only for that write: Codex itself never runs under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readRoute, routeFile, startAttempt } from '../pipeline/lib/route-record.mjs';
import { withReviewLock } from '../pipeline/lib/review-context.mjs';

test('startAttempt installs the pending record under the review lock: it waits for a holder and does not replace the record meanwhile', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-route-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { env: { PIPELINE_LOCK_DIR: join(root, 'locks') } };
  const args = { root, pr: 7, ctx, round: 1, base: 'a', head: 'b', patchSha256: 'c', risk: 'low', agent: 'x' };
  let started;
  await withReviewLock(root, 7, ctx, async () => {
    started = startAttempt(args);
    await sleep(300);
    assert.equal(existsSync(routeFile(root, 1)), false, 'blocked while the lock is held');
  });
  const attempt = await started;
  assert.equal(readRoute(root, 1)?.attemptId, attempt.attemptId, 'installed once the lock is free');
  assert.equal(readRoute(root, 1)?.evidence, 'pending');
});
