// Structure of .github/workflows/ci.yml, parsed with the vendored YAML reader. What it pins: the required check names in
// .claude/pipeline.yml are real job names, and the Windows suite is split into shards behind an aggregate "test (windows)"
// job that is red (never green or skipped) unless every shard succeeded. Only a real CI run proves the matrix expands
// and the runners schedule; this guards the wiring that would silently weaken the required check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => parseYaml(readFileSync(join(root, rel), 'utf8'));
const ci = load('.github/workflows/ci.yml');
const config = load('.claude/pipeline.yml');
const jobs = ci.jobs;
const shardJob = jobs['test-windows-shard'];
const aggregate = jobs['test-windows'];

// The check names GitHub shows: a matrix job's name has its ${{ matrix.* }} expressions expanded, one per combination.
const expandedNames = (job) => {
  const keys = Object.keys(job.strategy?.matrix ?? {});
  if (keys.length === 0) return [job.name];
  assert.deepEqual(keys, ['shard'], 'the only matrix dimension is the shard');
  return job.strategy.matrix.shard.map((v) => job.name.replace('${{ matrix.shard }}', String(v)));
};

test('every ci.required_checks name in .claude/pipeline.yml is the name of a job in ci.yml', () => {
  const names = Object.values(jobs).flatMap(expandedNames);
  assert.deepEqual(config.ci.required_checks, ['test (ubuntu)', 'test (windows)'], 'branch protection uses these exact names');
  for (const required of config.ci.required_checks) assert.ok(names.includes(required), `no job is named ${JSON.stringify(required)}`);
});

test('job names are unique and no shard is named like a required check', () => {
  const live = Object.entries(jobs).filter(([, j]) => j.if !== '${{ false }}'); // proof-anchor never runs and has no name
  const names = live.flatMap(([, j]) => expandedNames(j));
  assert.equal(new Set(names).size, names.length, names.join(' | '));
  assert.deepEqual(expandedNames(shardJob), ['test (windows 1/3)', 'test (windows 2/3)', 'test (windows 3/3)']);
});

test('the shard job runs shards 1..3 of 3 on Windows with Node 24 and does not cancel its siblings', () => {
  assert.equal(shardJob['runs-on'], 'windows-latest');
  assert.equal(shardJob.strategy['fail-fast'], false);
  assert.deepEqual(shardJob.strategy.matrix.shard, [1, 2, 3]);
  const runs = shardJob.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('node scripts/test.mjs --shard ${{ matrix.shard }}/3'), runs.join('\n'));
  const node = shardJob.steps.filter((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.equal(node.length, 1);
  assert.equal(node[0].with['node-version'], 24);
});

test('the installer round trip runs on Windows in shard 3 only', () => {
  const installer = shardJob.steps.filter((s) => String(s.run).includes('installer-round-trip.sh'));
  assert.equal(installer.length, 1);
  assert.match(installer[0].if, /^matrix\.shard == 3 && \(/);
});

test('test (windows) aggregates the shard job: needs it, runs always, on ubuntu', () => {
  assert.equal(aggregate.name, 'test (windows)');
  assert.equal(aggregate.needs, 'test-windows-shard');
  assert.equal(aggregate.if, 'always()', 'without always() a failed shard would skip the aggregate, and a skipped required check can pass');
  assert.equal(aggregate['runs-on'], 'ubuntu-latest');
  assert.equal(aggregate.steps.length, 1, 'one step: nothing can succeed independently of the shard result');
  assert.ok(!aggregate.steps[0].if, 'the step has no condition of its own that could skip it');
  assert.equal(aggregate.steps[0].env.SHARDS_RESULT, '${{ needs.test-windows-shard.result }}');
  assert.match(aggregate.steps[0].run, /"\$SHARDS_RESULT" = "success"/);
});

test('the aggregate step exits 0 only for a result of exactly "success"', () => {
  const script = aggregate.steps[0].run;
  for (const [result, want] of [['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1], ['', 1]]) {
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, SHARDS_RESULT: result }, encoding: 'utf8' });
    assert.equal(r.status, want, `result ${JSON.stringify(result)}: exit ${r.status} ${r.stderr}`);
  }
});

test('the ubuntu job is unchanged: Node 20 and 24, both with the installer round trip', () => {
  const ubuntu = jobs['test-ubuntu'];
  assert.equal(ubuntu.name, 'test (ubuntu)');
  assert.equal(ubuntu['runs-on'], 'ubuntu-latest');
  assert.deepEqual(ubuntu.steps.filter((s) => String(s.uses).startsWith('actions/setup-node@')).map((s) => s.with['node-version']), [20, 24]);
  assert.equal(ubuntu.steps.filter((s) => String(s.run).includes('installer-round-trip.sh')).length, 2);
  assert.equal(ubuntu.steps.filter((s) => s.run === 'node scripts/test.mjs').length, 2, 'the full suite, no shard');
});

test('the CI proof for `tests` still points at the ubuntu job', () => {
  assert.equal(config.verify.ci_proof.tests.job, 'test (ubuntu)');
  assert.ok(jobs['test-ubuntu']);
});
