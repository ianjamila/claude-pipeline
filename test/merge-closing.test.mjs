// `ownerStep.closing`: the exact closing lines of a merge request, ready to paste as the reply's last lines. The pure helper is covered here
// (order, absent parts, notes excluded, the plain vs lift 🔀 line); the dry run's own output is covered in merge-dry-run.test.mjs and
// owner-go-hold-lift.test.mjs, and what the owner-go hook binds from it in owner-go-rulings.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdBlock, presentedRequests, readyLine } from '../pipeline/hooks/lib/owner-go.mjs';
import { closingBlock } from '../pipeline/commands/merge.mjs';

const LINE = 'Head 0123456789ab · items abcdef012345 · repo acme/app';
const HOLD = holdBlock({ id: 'LE_hold1', login: 'jamila', at: '2026-11-05T09:00:00Z' });
const HOLD_LINE = 'Head 0123456789ab · items abcdef012345 · hold LE_hold1 · repo acme/app';
const RULINGS = 'Rulings 0123456789ab\nR1-B1 · REJECT · BLOCKING · security · by claude · content 0123456789ab · "Missing check" · why: a false positive';

test('closingBlock: a plain request is the Head line then the plain 🔀 line', () => {
  assert.equal(closingBlock({ kind: 'say-merge', line: LINE }, 58), `${LINE}\n${readyLine([58])}`);
});

test('closingBlock: Rulings, Areas, Hold, Head, then the lift 🔀 line, in that order, each exactly as printed', () => {
  const step = { kind: 'say-merge', line: HOLD_LINE, rulings: RULINGS, rulingCount: 1, areas: 'Areas a b', areaIds: ['a', 'b'], hold: HOLD, holdInfo: {}, ready: readyLine([58], { lift: true }) };
  assert.equal(closingBlock(step, 58), [RULINGS, 'Areas a b', HOLD, HOLD_LINE, readyLine([58], { lift: true })].join('\n'));
});

test('closingBlock: parts that are absent leave no blank line', () => {
  assert.equal(closingBlock({ kind: 'say-merge', line: LINE, areas: 'Areas a' }, 7), `Areas a\n${LINE}\n${readyLine([7])}`);
  assert.equal(closingBlock({ kind: 'say-merge', line: LINE, rulings: RULINGS }, 7), `${RULINGS}\n${LINE}\n${readyLine([7])}`);
});

test('closingBlock: the notes are prose above the block, never part of it', () => {
  const step = { kind: 'say-merge', line: LINE, queueNote: 'queue note', behindNote: 'behind note', parkNote: { label: 'x', text: 'park note' } };
  const closing = closingBlock(step, 58);
  assert.doesNotMatch(closing, /queue note|behind note|park note/);
  assert.equal(closing, `${LINE}\n${readyLine([58])}`);
});

test('closingBlock: what the owner-go hook reads from it is one request for this PR, head, items and repo', () => {
  const { requests } = presentedRequests(`Here is the request.\n${closingBlock({ kind: 'say-merge', line: LINE }, 58)}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pr, 58);
  assert.equal(requests[0].head, '0123456789ab');
  assert.equal(requests[0].items, 'abcdef012345');
  assert.equal(requests[0].repo, 'acme/app');
});
