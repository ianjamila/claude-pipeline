// The CLI the gate tests spawn must not act for the session that launched the suite (test/helpers/gate-env.mjs cliEnv): inside a Claude Code session, or a `P job` started from
// one, the process carries that session's lease variables, and a run without process isolation lacks the NODE_TEST_CONTEXT mark that keeps a checkout's CLI from taking leases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliEnv } from './helpers/gate-env.mjs';

const KEYS = ['PIPELINE_LEASE_HOLDER', 'PIPELINE_REVIEW_LEASE_DIR', 'PIPELINE_ADMISSION_WAIT_MS', 'NODE_TEST_CONTEXT'];
function ambient(t, values) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  for (const k of KEYS) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
}

test('cliEnv: the launching session\'s lease variables never reach the child CLI', (t) => {
  ambient(t, { PIPELINE_LEASE_HOLDER: 'session-of-the-launcher', PIPELINE_REVIEW_LEASE_DIR: '/somewhere/real', PIPELINE_ADMISSION_WAIT_MS: '600000', NODE_TEST_CONTEXT: 'child-v8' });
  const env = cliEnv(undefined, {});
  assert.equal(env.PIPELINE_LEASE_HOLDER, undefined);
  assert.equal(env.PIPELINE_REVIEW_LEASE_DIR, undefined);
  assert.equal(env.PIPELINE_ADMISSION_WAIT_MS, undefined);
});

test('cliEnv: a run without process isolation (no NODE_TEST_CONTEXT) still marks the child as a test run, so it takes no lease', (t) => {
  ambient(t, {});
  assert.equal(cliEnv(undefined, {}).NODE_TEST_CONTEXT, 'child-v8');
});

test('cliEnv: the runner\'s own NODE_TEST_CONTEXT mark is kept', (t) => {
  ambient(t, { NODE_TEST_CONTEXT: 'child-v8-from-the-runner' });
  assert.equal(cliEnv(undefined, {}).NODE_TEST_CONTEXT, 'child-v8-from-the-runner');
});

test('cliEnv: a test that asks for the lease variables gets exactly those', (t) => {
  ambient(t, { PIPELINE_LEASE_HOLDER: 'ambient', PIPELINE_REVIEW_LEASE_DIR: '/ambient' });
  const env = cliEnv(undefined, { PIPELINE_REVIEW_LEASE_DIR: '/mine', PIPELINE_LEASE_HOLDER: 'mine' });
  assert.equal(env.PIPELINE_REVIEW_LEASE_DIR, '/mine');
  assert.equal(env.PIPELINE_LEASE_HOLDER, 'mine');
});
