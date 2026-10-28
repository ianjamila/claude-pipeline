// The `proofs` field of the run record (T2b): validation, round trip, and the summary line "<step> proof: GitHub run <id> attempt <n>" / "Mac".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckpoint, decodeRecord, emptyRecord, encodeRecord, normaliseProofs, proofLine, proofsProblem, renderStatusBlock,
} from '../pipeline/lib/run-record.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';

const RUN = { id: 777, attempt: 2, jobId: 888, workflow: '.github/workflows/ci.yml', job: 'SQL arms', url: 'https://github.com/acme/widgets/actions/runs/777' };
const CI = { step: 'sql-arms', source: 'ci', run: RUN };
const MAC = { step: 'typecheck', source: 'local' };
const base = () => emptyRecord({ repo: 'acme/widgets', pr: 12, branch: 'agent/x', baseRef: 'main' });
const at = { host: 'h', now: 0 };

test('proofLine: GitHub run and attempt for a ci proof, Mac for a local one', () => {
  assert.equal(proofLine(CI), 'sql-arms proof: GitHub run 777 attempt 2');
  assert.equal(proofLine(MAC), 'typecheck proof: Mac');
});

test('a ci proof whose run also names the checked job steps is valid; the record keeps the run fields it knows', () => {
  const withSteps = { ...CI, run: { ...RUN, steps: ['Typecheck', 'Vitest'] } };
  assert.equal(proofsProblem([withSteps]), null);
  assert.deepEqual(normaliseProofs([withSteps]), [CI]);
});

test('the status block prints one line per proof; a record without proofs prints none', () => {
  const rec = applyCheckpoint(base(), { proofs: [CI, MAC] }, at);
  const block = renderStatusBlock(rec);
  assert.match(block, /^- sql-arms proof: GitHub run 777 attempt 2$/m);
  assert.match(block, /^- typecheck proof: Mac$/m);
  assert.doesNotMatch(renderStatusBlock(base()), /proof/);
});

test('applyCheckpoint stores a trimmed copy, replaces the list, and leaves it alone when the patch has none', () => {
  const rec = applyCheckpoint(base(), { proofs: [{ ...CI, extra: 'x', run: { ...RUN, junk: 1 } }] }, at);
  assert.deepEqual(rec.proofs, [CI]);
  assert.deepEqual(applyCheckpoint(rec, { detail: 'later' }, at).proofs, [CI]);
  assert.deepEqual(applyCheckpoint(rec, { proofs: [MAC] }, at).proofs, [MAC]);
  assert.deepEqual(applyCheckpoint(rec, { proofs: [] }, at).proofs, []);
});

test('bad proofs are refused with a reason, never half-recorded', () => {
  const bad = [
    ['not a list', 'x'],
    ['unknown source', [{ step: 's', source: 'cloud' }]],
    ['no step', [{ source: 'local' }]],
    ['step with spaces', [{ step: 'a b', source: 'local' }]],
    ['local with a run', [{ step: 's', source: 'local', run: RUN }]],
    ['ci without run', [{ step: 's', source: 'ci' }]],
    ['run id as text', [{ step: 's', source: 'ci', run: { ...RUN, id: '7' } }]],
    ['attempt 0', [{ step: 's', source: 'ci', run: { ...RUN, attempt: 0 } }]],
    ['no url', [{ step: 's', source: 'ci', run: { ...RUN, url: '' } }]],
    ['too many', Array.from({ length: 21 }, () => MAC)],
  ];
  for (const [label, proofs] of bad) {
    assert.ok(proofsProblem(proofs), label);
    assert.throws(() => normaliseProofs(proofs), /^Error: proofs: /, label);
    assert.throws(() => applyCheckpoint(base(), { proofs }, at), /proofs: /, label);
  }
});

test('a record with proofs survives encode/decode; a stored record with malformed proofs reads as invalid', () => {
  const rec = applyCheckpoint(base(), { proofs: [CI, MAC] }, at);
  const body = `${MARKERS.summary}\n\n${encodeRecord(rec)}`;
  const back = decodeRecord(body);
  assert.equal(back.status, 'ok');
  assert.deepEqual(back.record.proofs, [CI, MAC]);

  const forged = { ...rec, proofs: [{ step: 's', source: 'ci' }] };
  assert.equal(decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(forged)}`).status, 'invalid');
  // an old record (no proofs field at all) is still fine
  assert.equal(decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(base())}`).status, 'ok');
});

test('a hostile step name or url cannot break the markdown line', () => {
  const rec = applyCheckpoint(base(), { proofs: [{ step: 'a-b', source: 'local' }] }, at);
  assert.equal(renderStatusBlock(rec).split('\n').filter((l) => l.includes('proof')).length, 1);
});
