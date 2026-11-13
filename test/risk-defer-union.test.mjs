// Fable F7: the sensitive-path lists that keep a fix from being deferred are the UNION of the working-tree and the trusted base config's lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { itemSeverity } from '../pipeline/lib/triage.mjs';

const cfg = (paths, always = []) => {
  const c = structuredClone(DEFAULTS);
  c.risk.high_risk_paths = paths;
  c.review.arbiter_always_paths = always;
  return c;
};
const file = { oldPath: 'src/big.js', newPath: 'src/big.js', path: 'src/big.js', status: 'M', binary: false, added: [{ line: 1, text: 'x' }], removed: [] };
const item = { id: 'R2-S1', bucket: 'SUGGESTION', category: 'maintainability', file: 'src/big.js', line: 1, final: { decision: 'ACCEPT' } };
const state = { rounds: [{ n: 1, items: [item] }] };

test('itemSeverity: a high_risk_paths entry removed in the working tree only keeps the item high when the base config still lists it', () => {
  const working = cfg([]);
  const trusted = cfg(['src/big.js']);
  assert.equal(itemSeverity(item, { state, config: working, files: [file] }).level, 'low', 'without the base config the removal would lower it');
  const sev = itemSeverity(item, { state, config: working, files: [file], baseConfig: trusted });
  assert.equal(sev.level, 'high');
  assert.match(sev.reasons.join(' '), /sensitive path/);
  // arbiter_always_paths counts the same way, and a base config that lists nothing changes nothing
  assert.equal(itemSeverity(item, { state, config: working, files: [file], baseConfig: cfg([], ['src/**']) }).level, 'high');
  assert.equal(itemSeverity(item, { state, config: working, files: [file], baseConfig: cfg([]) }).level, 'low');
  assert.equal(itemSeverity(item, { state, config: working, files: [file], baseConfig: null }).level, 'low');
});
