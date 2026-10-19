// T2b through the real CLI against a scripted gh: what `P merge` records from its LIVE gate evaluation and when it refuses.
// (Lookup rules: ci-proof.test.mjs. Row/settings rules: ci-proof-gate*.test.mjs. Record/summary rendering: run-record-proofs.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ymlFor } from './helpers/gate-env.mjs';
import { ciRow, setup, ymlWith } from './helpers/ci-proof-env.mjs';
import { JOB, SEQ_GH, SLUG, WORKFLOW, assertExit, ciEntries, events, ghEntries, okGate, records, serve, writes } from './helpers/ci-proof-merge-env.mjs';

test('merge records the proof from its LIVE evaluation: the gate passed on run A, merge sees run B, B is recorded (event + run record + summary line)', () => {
  const s = setup({ report: ciRow });
  serve(s, [{ id: 101, number: 5 }]);
  const g = okGate(s);
  assert.equal(g.json.proofs[0].run.id, 101);
  assert.deepEqual(g.json.proofs[0], { step: 'unit', source: 'ci', run: { id: 101, attempt: 1, jobId: 1010, workflow: WORKFLOW, job: JOB, url: `https://github.com/${SLUG}/actions/runs/101` } });

  serve(s, [{ id: 101, number: 5 }, { id: 202, number: 6, attempt: 2 }]); // a newer run appeared (and passed) between gate and merge
  const r = s.merge();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.equal(s.mergeCalls().length, 1);

  const [used, ...more] = events(s, 'ci-proof-used');
  assert.equal(more.length, 0, 'one event per merge attempt');
  assert.equal(used.dataStatus, 'ok');
  assert.match(used.sentence, /unit proof: GitHub run 202 attempt 2/);
  assert.equal(used.data.head, s.head);
  assert.equal(used.data.pr, 12);
  assert.equal(used.data.proofs[0].run.id, 202);
  assert.equal(used.data.proofs[0].run.attempt, 2);

  const recs = records(s).filter((x) => x.proofs);
  assert.ok(recs.length >= 1, 'the run record carries the proofs');
  for (const rec of recs) assert.equal(rec.proofs[0].run.id, 202, 'every later rewrite keeps B, never A');
  const summary = writes(s).find((b) => b.includes('Pipeline run status') && b.includes('proof:'));
  assert.match(summary, /- unit proof: GitHub run 202 attempt 2/);
});

test('a live re-check that no longer finds a green run stops the merge before anything is recorded', () => {
  const s = setup({ report: ciRow });
  serve(s, [{ id: 101, number: 5 }]);
  okGate(s);
  for (const [label, runs, text] of [
    ['newer run still going', [{ id: 101, number: 5 }, { id: 202, number: 6, status: 'in_progress' }], /ci-proof-pending:unit/],
    ['newer run red', [{ id: 101, number: 5 }, { id: 202, number: 6, job: 'failure' }], /ci-proof-failed:unit/],
    ['newer run cancelled', [{ id: 101, number: 5 }, { id: 202, number: 6, conclusion: 'cancelled' }], /ci-proof-missing:unit/],
  ]) {
    serve(s, runs);
    const r = s.merge();
    assertExit(r, 1, label);
    assert.equal(r.json.error, 'live-check', label);
    assert.match(r.json.reasons.join(';'), text, label);
    assert.deepEqual(s.mergeCalls(), [], `${label}: nothing merged`);
    assert.deepEqual(events(s, 'ci-proof-used'), [], `${label}: nothing recorded`);
  }
});

test('the ci-proof-used event cannot be written -> pre-merge refusal, nothing merged', () => {
  const s = setup({ report: ciRow });
  serve(s, [{ id: 101, number: 5 }]);
  okGate(s);
  // POST #1 = the in-flight run record, #2 = the event: it fails; later writes keep failing
  s.fake.setScript([
    { match: '-X POST repos/acme/widgets/issues/12/comments', sequence: [{ stdoutJson: { id: 501, html_url: 'https://example.invalid/501' } }, { code: 1, stderr: 'gh: Server Error (HTTP 502)' }] },
    ...ciEntries(s, [{ id: 101, number: 5 }]), ...ghEntries({ prHead: s.head }),
  ]);
  const r = s.merge({ PIPELINE_GH: SEQ_GH });
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'pre-merge');
  assert.equal(r.json.merged, false);
  assert.match(r.json.reason, /could not record the verify proof on the PR \(ci-proof-used event\)/);
  assert.deepEqual(s.mergeCalls(), [], 'the merge command never ran');
});

test('the run record cannot be written -> pre-merge refusal, nothing merged', () => {
  const s = setup({ report: ciRow });
  serve(s, [{ id: 101, number: 5 }]);
  okGate(s);
  // POST #1 = in-flight record, #2 = the event (ok), #3 = the proofs in the record: it fails
  s.fake.setScript([
    {
      match: '-X POST repos/acme/widgets/issues/12/comments',
      sequence: [{ stdoutJson: { id: 501, html_url: 'https://example.invalid/501' } }, { stdoutJson: { id: 502, html_url: 'https://example.invalid/502' } }, { code: 1, stderr: 'gh: Server Error (HTTP 502)' }],
    },
    ...ciEntries(s, [{ id: 101, number: 5 }]), ...ghEntries({ prHead: s.head }),
  ]);
  const r = s.merge({ PIPELINE_GH: SEQ_GH });
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /could not record the verify proof on the PR \(run record\)/);
  assert.deepEqual(s.mergeCalls(), []);
});

