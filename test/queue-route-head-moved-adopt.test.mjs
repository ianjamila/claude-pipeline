// The merge job's own head-moved endings (precheck, the watch loop, confirm) adopt a live queue entry at the new head exactly as settleRecord does (#237): the
// record of the approved head is replaced by an orphan record for the entry's head (no approval, no hold, `adopted`), so the sweep keeps tracking an entry nobody
// approved instead of finding no record at all (cp #242 R1-F3). Direct createQueueRoute tests with a stub gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { beginAttempt, confirmAttempt, openRecord, readQueueRecord, setHold } from '../pipeline/lib/merge-queue.mjs';
import { createQueueRoute, restoreHoldOnTerminal } from '../pipeline/lib/queue-route.mjs';

const H = 'a'.repeat(40);
const J = 'd'.repeat(40);
const PR = 7;
const APPROVAL = { items: 'abc123', areas: null, rulings: null };
const IDENT = { repo: 'acme/widgets', repoId: 42 };
const HOLD = { id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z', holdBlock: 'digest', liftedAt: '2026-11-09T07:59:00Z' };
const ENTRY = { id: 'MQE_9', state: 'AWAITING_CHECKS', position: 1, enqueuedAt: '2026-11-09T08:00:00Z', headCommit: null };
const ENV = { PIPELINE_QUEUE_POLL_MS: '1', PIPELINE_QUEUE_WAIT_MS: '5000', PIPELINE_QUEUE_CONFIRM_MS: '50', PIPELINE_QUEUE_CONFIRM_POLL_MS: '1' };

const at = (head, over = {}) => ({ enabled: true, inQueue: false, state: 'OPEN', head, mergeSha: null, entry: null, ...over });
const queuedAtJ = () => at(J, { inQueue: true, entry: ENTRY });

// `states`: what each queueState read answers, in order (the last one repeats); an Error is thrown.
function stub(states) {
  let n = 0;
  const m = {
    calls: [], labels: [],
    queueState: () => {
      const x = states[Math.min(n++, states.length - 1)];
      if (x instanceof Error) throw x;
      return x;
    },
    queueEvents: () => [],
    prView: () => ({ state: 'OPEN', labels: m.labels.map((name) => ({ name })), mergeCommit: null }),
    addLabels: (_n, names) => { m.calls.push(`add ${names}`); for (const x of names) if (!m.labels.includes(x)) m.labels.push(x); },
    listIssues: () => [],
    dequeue: () => { m.calls.push('dequeue'); },
    enqueue: () => { m.calls.push('enqueue'); },
    checkRunsOf: () => [],
    statusesOf: () => [],
    repo: () => ({ slug: 'acme/widgets' }),
    repoId: () => 42,
  };
  return m;
}

// A live record for H with a confirmed entry and the lifted hold, as after a merge job's enqueue.
function liveRecord() {
  const root = mkdtempSync(join(tmpdir(), 'cp-adopt-'));
  execFileSync('git', ['init', '-q', root]);
  openRecord(root, PR, H, APPROVAL, { ...IDENT, route: 'owner-go' });
  setHold(root, PR, HOLD);
  beginAttempt(root, PR, H, APPROVAL, IDENT);
  confirmAttempt(root, PR, 'MQE_1');
  return root;
}
const refuse = (error, reasons, extra = {}) => ({ exitCode: 1, output: { ok: false, merged: false, error, reasons, message: reasons.join('; '), ...extra } });
const routeFor = (root, gh) => createQueueRoute({
  gh, root, config: { merge: { ...DEFAULTS.merge }, default_branch: 'main' }, pr: PR, head: H, route: 'owner-go', env: ENV, refuse, approval: APPROVAL,
  recheck: async () => ({ ok: true }), onTerminal: restoreHoldOnTerminal({ gh, pr: PR }), sleep: async () => {},
});

const adoptedFor = (root) => {
  const rec = readQueueRecord(root, PR);
  assert.equal(rec.terminal, null, 'the orphan record is live');
  assert.equal(rec.head, J);
  assert.deepEqual(rec.entryIds, ['MQE_9']);
  assert.equal(rec.hold, null);
  assert.equal(rec.adopted.from, H);
  assert.deepEqual(rec.approval, { items: null, areas: null, rulings: null }, 'no approval carries over to J');
};

test('precheck: the head moved off a live record while an entry sits at the new head: the hold goes back, the record is REPLACED by an orphan record for that entry (never ended, never dequeued)', async () => {
  const root = liveRecord();
  const gh = stub([queuedAtJ(), queuedAtJ()]);
  const pre = await routeFor(root, gh).precheck();
  assert.equal(pre.done.output.error, 'head-moved');
  assert.match(pre.done.output.reasons[0], /in the merge queue at dddddddddddd/);
  assert.equal(pre.done.output.holdRestored, true);
  assert.deepEqual(gh.labels, ['needs-human']);
  adoptedFor(root);
  assert.deepEqual(gh.calls, ['add needs-human'], 'nothing dequeued, nothing enqueued');
});

test('the watch loop: a head move first seen while a merge job watches adopts the entry at the new head the same way', async () => {
  const root = liveRecord();
  const gh = stub([queuedAtJ()]);
  const res = await routeFor(root, gh).enqueueAndWatch({ watchOnly: true });
  assert.equal(res.output.error, 'head-moved');
  adoptedFor(root);
  assert.deepEqual(gh.labels, ['needs-human']);
  assert.ok(!gh.calls.includes('dequeue') && !gh.calls.includes('enqueue'));
});

test('a head move with NO entry at the new head still ends the record head-moved (hold back), as before', async () => {
  const root = liveRecord();
  const gh = stub([at(J)]);
  const res = await routeFor(root, gh).enqueueAndWatch({ watchOnly: true });
  assert.equal(res.output.error, 'head-moved');
  assert.equal(readQueueRecord(root, PR).terminal, 'head-moved');
  assert.deepEqual(gh.labels, ['needs-human']);
});

test('a head move whose adoption read THROWS leaves the record live and the hold alone (queue-unreadable): ending it could lose the entry', async () => {
  const root = liveRecord();
  const gh = stub([at(J), new Error('HTTP 502')]);
  const res = await routeFor(root, gh).enqueueAndWatch({ watchOnly: true });
  assert.equal(res.output.error, 'queue-unreadable');
  const rec = readQueueRecord(root, PR);
  assert.equal(rec.terminal, null);
  assert.equal(rec.head, H, 'the record is untouched');
  assert.deepEqual(gh.labels, [], 'the hold was not put back');
});
