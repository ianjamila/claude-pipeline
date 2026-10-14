// skipOf: which verify-report rows count as a skipped step, in either report shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipOf } from '../pipeline/lib/verify-steps.mjs';

test('skipOf: status skipped reads skipReason; the legacy pass+skipped:true row reads skipCheck, then command', () => {
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipReason: ' deps unchanged ' }), { name: 'a', reason: 'deps unchanged' });
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipReason: 5 }), { name: 'a', reason: '' });
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipCheck: 'ignored for the new shape' }), { name: 'a', reason: '' });
  assert.deepEqual(skipOf({ name: 'a', status: 'pass', skipped: true, skipCheck: 'why', command: '(skipped)' }), { name: 'a', reason: 'why' });
  assert.deepEqual(skipOf({ name: 'a', status: 'pass', skipped: true, command: '(skipped - x)' }), { name: 'a', reason: '(skipped - x)' });
  assert.deepEqual(skipOf({ name: 'a', status: 'pass', skipped: true }), { name: 'a', reason: '' });
});

test('skipOf: everything else is not a skip', () => {
  for (const row of [null, undefined, 'skipped', [], { name: 'a', status: 'pass' }, { name: 'a', status: 'pass', skipped: 'true' }, { name: 'a', status: 'fail', skipped: true }, { name: 'a', status: 'not-run', skipped: true }, { name: 'a', status: 'skip' }]) {
    assert.equal(skipOf(row), null, JSON.stringify(row));
  }
});
