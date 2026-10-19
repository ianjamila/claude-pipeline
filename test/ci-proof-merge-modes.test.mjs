// T2b through the real CLI: a Mac proof, a repo without the keys, and the deferred-report -> missing -> fresh full report -> pass flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ymlFor } from './helpers/gate-env.mjs';
import { ciRow, setup, ymlWith } from './helpers/ci-proof-env.mjs';
import { JOB, SEQ_GH, SLUG, WORKFLOW, assertExit, ciEntries, events, ghEntries, okGate, records, serve, writes } from './helpers/ci-proof-merge-env.mjs';

test('a step the Mac ran is recorded as "Mac" (a repo with deferrable steps, report with a plain pass); no GitHub run is consulted', () => {
  const s = setup();
  okGate(s);
  const r = s.merge();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  const [used] = events(s, 'ci-proof-used');
  assert.deepEqual(used.data.proofs, [{ step: 'unit', source: 'local' }]);
  assert.match(used.sentence, /unit proof: Mac/);
  assert.match(writes(s).find((b) => b.includes('Pipeline run status') && b.includes('proof:')), /- unit proof: Mac/);
  assert.ok(!s.fake.lines().some((l) => l.includes('actions/')), 'no workflow API call');
});

test('a repo without the keys: merge is unchanged - no proofs in the gate, no event, no proofs in the record, no workflow API calls', () => {
  const s = setup({ yml: ymlFor() });
  const g = okGate(s);
  assert.equal(Object.hasOwn(g.json, 'proofs'), false);
  const r = s.merge();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.deepEqual(events(s, 'ci-proof-used'), []);
  assert.ok(records(s).length > 0, 'the run record is still written');
  for (const rec of records(s)) assert.equal(Object.hasOwn(rec, 'proofs'), false);
  assert.ok(!writes(s).some((b) => /ci-proof-used| proof: /.test(b)));
  assert.ok(!s.fake.lines().some((l) => /actions\/|git\/commits/.test(l)), 'no CI lookup');
});

test('end to end: a deferred full report with no run on GitHub fails the gate (ci-proof-missing); a fresh full report without --defer passes it; so does the deferred one once a run exists', () => {
  const s = setup({ report: ciRow, yml: ymlWith() });
  const red = s.gate();
  assertExit(red, 1, `${red.stderr}${red.stdout}`);
  assert.deepEqual(red.json.failed, ['verify-report']);
  assert.match(red.json.checks.find((c) => c.name === 'verify-report').detail, /ci-proof-missing:unit \(the GitHub lookup failed/);

  serve(s, []); // GitHub answers, with no run: same verdict, from a readable listing
  const none = s.gate();
  assertExit(none, 1);
  assert.match(none.json.checks.find((c) => c.name === 'verify-report').detail, /ci-proof-missing:unit \(no pull_request run/);

  s.setReport((r) => { r.steps[3] = { name: 'unit', status: 'pass', durationMs: 5, command: 'unit', exitCode: 0, errorExcerpt: '' }; }); // the fresh FULL verify without --defer: every step ran locally
  const green = s.gate();
  assertExit(green, 0, `${green.stderr}${green.stdout}`);
  assert.deepEqual(green.json.proofs, [{ step: 'unit', source: 'local' }]);

  s.setReport(ciRow);
  serve(s, [{ id: 101, number: 5 }]);
  const viaCi = s.gate();
  assertExit(viaCi, 0, `${viaCi.stderr}${viaCi.stdout}`);
  assert.equal(viaCi.json.proofs[0].source, 'ci');
});

