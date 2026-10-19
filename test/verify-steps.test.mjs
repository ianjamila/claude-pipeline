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

test('skipOf: a legacy row falls back to command only when it is a "(skipped ..." note, never a plain command', () => {
  assert.deepEqual(skipOf({ name: 'a', status: 'pass', skipped: true, command: 'npm test' }), { name: 'a', reason: '' });
  assert.deepEqual(skipOf({ name: 'a', status: 'pass', skipped: true, command: '(skipped — deps unchanged)' }), { name: 'a', reason: '(skipped — deps unchanged)' });
  assert.deepEqual(skipOf({ name: 'a', status: 'pass', skipped: true, skipCheck: 'why', command: 'npm test' }), { name: 'a', reason: 'why' });
});

test('skipOf: a string skipKind comes back as `kind` (ci, local or any other string); no skipKind means no `kind` key at all', () => {
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipReason: 'deferred to CI (.github/workflows/ci.yml#SQL arms)', skipKind: 'ci' }), { name: 'a', reason: 'deferred to CI (.github/workflows/ci.yml#SQL arms)', kind: 'ci' });
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipReason: 'no inputs changed', skipKind: 'local' }), { name: 'a', reason: 'no inputs changed', kind: 'local' });
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipReason: 'x', skipKind: 'weird' }), { name: 'a', reason: 'x', kind: 'weird' });
  assert.deepEqual(skipOf({ name: 'a', status: 'skipped', skipReason: 'x', skipKind: '' }), { name: 'a', reason: 'x', kind: '' });
  for (const skipKind of [undefined, null, 5, true, {}, ['ci']]) {
    const k = skipOf({ name: 'a', status: 'skipped', skipReason: 'x', skipKind });
    assert.deepEqual(k, { name: 'a', reason: 'x' }, JSON.stringify(skipKind));
    assert.equal(Object.hasOwn(k, 'kind'), false, JSON.stringify(skipKind));
  }
  assert.equal(skipOf({ name: 'a', status: 'pass', skipKind: 'ci' }), null, 'a kind alone does not make a skip');
  assert.equal(skipOf({ name: 'a', status: 'fail', skipKind: 'ci' }), null);
});
