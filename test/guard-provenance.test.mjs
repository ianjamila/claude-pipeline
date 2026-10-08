// Unit tests for lib/guard-provenance.mjs: the verdict artifact's name format, and the run / artifact checks with a scripted
// `read` (the orchestrator and final-gate tests cover the same code through the CLIs and the fake gh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  APPROVAL_LABELS, checkGuardVerdict, checkRunProvenance, checkVerdictArtifact, parseVerdictArtifactName, verdictArtifactName, withinRunWindow,
} from '../pipeline/lib/guard-provenance.mjs';

const REPO = 'acme/app';
const HEAD = 'a'.repeat(40);
const URL1 = 'https://github.com/acme/app/actions/runs/1';
const T = (hhmmss) => `2026-10-01T${hhmmss}Z`;

// ---- the artifact name ------------------------------------------------------------------------------------------------------

test('verdictArtifactName: the exact format, with and without a receipt', () => {
  assert.equal(verdictArtifactName({ head: HEAD, integrity: 'success', hardstops: 'failure' }), `pipeline-verdict_v1_${HEAD}_success_failure`);
  assert.equal(
    verdictArtifactName({ head: HEAD, integrity: 'error', hardstops: 'success', receipt: { label: 'human-approved', login: 'Ian-J' } }),
    `pipeline-verdict_v1_${HEAD}_error_success_human-approved_Ian-J`,
  );
  assert.equal(
    verdictArtifactName({ head: HEAD.toUpperCase(), integrity: 'success', hardstops: 'success', receipt: { label: 'test-change-approved', login: 'dependabot[bot]' } }),
    `pipeline-verdict_v1_${HEAD}_success_success_test-change-approved_dependabot[bot]`,
    'the head is lower-cased; a bot login keeps its [bot] suffix',
  );
});

test('verdictArtifactName: refuses anything outside the format instead of producing an ambiguous name', () => {
  const ok = { head: HEAD, integrity: 'success', hardstops: 'success' };
  for (const bad of [
    { ...ok, head: 'abc' }, { ...ok, head: `${HEAD}0` }, { ...ok, head: undefined },
    { ...ok, integrity: 'passed' }, { ...ok, hardstops: '' }, { ...ok, integrity: undefined },
    { ...ok, receipt: { label: 'needs-review', login: 'acme' } },
    { ...ok, receipt: { label: 'human-approved', login: 'a_b' } },
    { ...ok, receipt: { label: 'human-approved', login: 'a/b' } },
    { ...ok, receipt: { label: 'human-approved', login: 'a b' } },
    { ...ok, receipt: { label: 'human-approved', login: '-ab' } },
    { ...ok, receipt: { label: 'human-approved', login: 'a'.repeat(41) } },
    { ...ok, receipt: { label: 'human-approved', login: 'a\nb' } },
    { ...ok, receipt: { label: 'human-approved', login: '' } },
  ]) assert.throws(() => verdictArtifactName(bad), /verdict artifact/, JSON.stringify(bad));
});

test('parseVerdictArtifactName: round-trips every valid name and is strict about everything else', () => {
  for (const integrity of ['success', 'failure', 'error']) {
    for (const hardstops of ['success', 'failure', 'error']) {
      for (const receipt of [null, ...APPROVAL_LABELS.map((label) => ({ label, login: 'acme' }))]) {
        const name = verdictArtifactName({ head: HEAD, integrity, hardstops, receipt });
        assert.deepEqual(parseVerdictArtifactName(name), { head: HEAD, integrity, hardstops, receipt }, name);
        // GitHub rejects these characters in an artifact name: the format must never need them
        assert.doesNotMatch(name, /[":<>|*?\\/\r\n]/);
      }
    }
  }
  const good = `pipeline-verdict_v1_${HEAD}_success_success_human-approved_acme`;
  assert.notEqual(parseVerdictArtifactName(good), null);
  for (const bad of [
    '', null, undefined, 42, 'verify-report',
    ` ${good}`, `${good} `, `${good}\n`, `\n${good}`, `${good}\nx`, `${good}_`, `${good}_x`, `${good}/..`,
    good.replace('v1', 'v2'), good.replace('pipeline-verdict', 'Pipeline-verdict'),
    good.replace(HEAD, 'a'.repeat(39)), good.replace(HEAD, 'A'.repeat(40)), good.replace(HEAD, 'g'.repeat(40)),
    good.replace('_success_success_', '_ok_success_'), good.replace('_success_success_', '_success_pending_'),
    good.replace('human-approved', 'human_approved'), good.replace('human-approved', 'needs-review'), good.replace('human-approved', 'Human-Approved'),
    good.replace('_acme', '_a_cme'), good.replace('_acme', '_'), good.replace('_acme', '_-acme'), good.replace('_acme', `_${'a'.repeat(41)}`),
    `pipeline-verdict_v1_${HEAD}_success_success_human-approved`,
    `pipeline-verdict_v1_${HEAD}_success`,
  ]) assert.equal(parseVerdictArtifactName(bad), null, JSON.stringify(bad));
});

// ---- run-level provenance: run_attempt and the created_at window -----------------------------------------------------------

const GOOD = {
  path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', head_sha: 'b'.repeat(40), run_attempt: 1,
  created_at: T('10:00:00'), updated_at: T('10:12:00'), pull_requests: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main' } }],
};
const reader = ({ run = {}, artifacts = [], compare = 'ahead', calls = [] } = {}) => (apiPath, jq) => {
  calls.push(apiPath);
  if (apiPath === `repos/${REPO}/actions/runs/1`) return JSON.stringify({ ...GOOD, ...run });
  if (apiPath === `repos/${REPO}/actions/runs/1/artifacts?per_page=100`) {
    if (artifacts instanceof Error) throw artifacts;
    return artifacts.map((n) => `${n}\n`).join('');
  }
  if (apiPath === `repos/${REPO}`) return 'main\n';
  if (apiPath.startsWith(`repos/${REPO}/compare/`)) return `${compare}\n`;
  throw new Error(`unexpected read ${apiPath} ${jq}`);
};
const bind = (extra = {}) => ({ prNumber: 7, headSha: HEAD, createdAt: T('10:05:00'), ...extra });
const prov = (opts = {}, b = bind()) => checkRunProvenance({ read: reader(opts), repo: REPO, url: URL1, bind: b });

test('checkRunProvenance: only attempt 1 counts, and says how to run the guards again', () => {
  assert.equal(prov().ok, true);
  for (const run_attempt of [2, 10, 0, '1', null, undefined]) {
    const r = prov({ run: { run_attempt } });
    assert.equal(r.ok, false, String(run_attempt));
    assert.match(r.reason, /re-runs never count/);
    assert.match(r.reason, /push a commit or close and reopen the PR/);
  }
});

test('checkRunProvenance: the window opens at the run\'s created_at (the event time), not when the run started; the upper bound stays updated_at', () => {
  const queued = { run: { created_at: T('10:00:00'), run_started_at: T('10:00:40'), updated_at: T('10:05:00') } };
  assert.equal(prov(queued, bind({ createdAt: T('10:00:05') })).ok, true, 'before run_started_at, after created_at');
  assert.equal(prov(queued, bind({ createdAt: T('09:59:50') })).ok, true, 'exactly the 10 s slack');
  assert.equal(prov(queued, bind({ createdAt: T('09:59:49') })).ok, false);
  assert.equal(prov(queued, bind({ createdAt: T('10:05:10') })).ok, true);
  assert.equal(prov(queued, bind({ createdAt: T('10:05:11') })).ok, false);
  assert.equal(prov({ run: { created_at: undefined } }).ok, false, 'a run without created_at cannot bound anything');
  assert.deepEqual(prov(queued, bind({ createdAt: T('10:01:00') })).window, { createdAt: T('10:00:00'), updatedAt: T('10:05:00') });
  assert.equal(withinRunWindow({ createdAt: T('10:00:00'), updatedAt: T('10:05:00') }, T('10:00:00')), true);
  assert.equal(withinRunWindow({ startedAt: T('10:00:00'), updatedAt: T('10:05:00') }, T('10:00:00')), false, 'the old field name is gone');
});

// ---- the artifact check ----------------------------------------------------------------------------------------------------

const name = (integrity, hardstops, receipt = null, head = HEAD) => verdictArtifactName({ head, integrity, hardstops, receipt });
const art = (artifacts, expect, extra = {}) => checkVerdictArtifact({ read: reader({ artifacts }), repo: REPO, runId: '1', headSha: HEAD, expect, ...extra });

test('checkVerdictArtifact: a guard check needs the run\'s own state for THAT check to be success', () => {
  assert.equal(art([name('success', 'success')], { check: 'hardstops' }).ok, true);
  assert.equal(art([name('failure', 'success')], { check: 'hardstops' }).ok, true, 'integrity failed, hardstops did not');
  assert.equal(art([name('failure', 'success')], { check: 'integrity' }).ok, false);
  assert.match(art([name('failure', 'success')], { check: 'integrity' }).reason, /verdict for integrity is failure/);
  assert.equal(art([name('success', 'error')], { check: 'hardstops' }).ok, false);
  // every verdict artifact of the head must agree (a genuine run uploads one)
  assert.equal(art([name('success', 'success'), name('success', 'failure')], { check: 'hardstops' }).ok, false);
});

test('checkVerdictArtifact: no artifact for this head, an unreadable list, or no valid expectation fails closed', () => {
  for (const artifacts of [[], ['verify-report'], [name('success', 'success', null, 'c'.repeat(40))], [`${name('success', 'success')}x`]]) {
    const r = art(artifacts, { check: 'hardstops' });
    assert.equal(r.ok, false, JSON.stringify(artifacts));
    assert.match(r.reason, /carries no verdict artifact/);
  }
  const unreadable = art(new Error('HTTP 403'), { check: 'hardstops' });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /could not be read \(HTTP 403\)/);
  for (const expect of [undefined, {}, { check: 'review' }, { receipt: { label: 'needs-review', login: 'acme' } }, { receipt: { label: 'human-approved' } }]) {
    assert.equal(art([name('success', 'success')], expect).ok, false, JSON.stringify(expect));
  }
  assert.equal(checkVerdictArtifact({ read: reader(), repo: REPO, runId: '1', headSha: 'nope', expect: { check: 'hardstops' } }).ok, false);
  assert.equal(checkVerdictArtifact({ read: reader(), repo: REPO, runId: 'x', headSha: HEAD, expect: { check: 'hardstops' } }).ok, false);
});

test('checkVerdictArtifact: a receipt needs an artifact naming that label and approver (login case-insensitive)', () => {
  const withReceipt = [name('success', 'success', { label: 'human-approved', login: 'Acme' })];
  assert.equal(art(withReceipt, { receipt: { label: 'human-approved', login: 'acme' } }).ok, true);
  assert.equal(art(withReceipt, { receipt: { label: 'human-approved', login: 'ACME' } }).ok, true);
  assert.equal(art(withReceipt, { receipt: { label: 'human-approved', login: 'mallory' } }).ok, false);
  assert.equal(art(withReceipt, { receipt: { label: 'test-change-approved', login: 'acme' } }).ok, false);
  assert.equal(art([name('success', 'success')], { receipt: { label: 'human-approved', login: 'acme' } }).ok, false, 'a verdict without a receipt');
  assert.equal(art([name('failure', 'failure', { label: 'human-approved', login: 'acme' })], { receipt: { label: 'human-approved', login: 'acme' } }).ok, true, 'the receipt does not depend on the verdict states');
});

test('checkVerdictArtifact / checkGuardVerdict: the artifact list is read once per run (cache) and from the right path', () => {
  const calls = [];
  const read = reader({ artifacts: [name('success', 'success')], calls });
  const cache = new Map();
  for (let i = 0; i < 3; i++) assert.equal(checkGuardVerdict({ read, repo: REPO, url: URL1, bind: bind(), expect: { check: 'hardstops' }, cache }).ok, true);
  assert.equal(calls.filter((c) => c.includes('/artifacts')).length, 1);
  assert.equal(calls.filter((c) => c === `repos/${REPO}/actions/runs/1`).length, 1);
});

test('checkGuardVerdict: the run checks come first, and the expectation is mandatory', () => {
  const read = reader({ artifacts: [name('success', 'success')], run: { run_attempt: 2 } });
  assert.match(checkGuardVerdict({ read, repo: REPO, url: URL1, bind: bind(), expect: { check: 'hardstops' } }).reason, /re-runs never count/);
  const noExpect = checkGuardVerdict({ read: reader({ artifacts: [name('success', 'success')] }), repo: REPO, url: URL1, bind: bind() });
  assert.equal(noExpect.ok, false);
  assert.match(noExpect.reason, /no valid expectation/);
});

// ---- the jq filters, against GitHub-shaped payloads --------------------------------------------------------------------------

const hasJq = spawnSync('jq', ['--version']).status === 0;
test('the run and artifact jq filters work on GitHub-shaped payloads', { skip: !hasJq && 'jq not installed' }, () => {
  const filters = {};
  const read = (apiPath, jq) => {
    filters[apiPath.includes('/artifacts') ? 'artifacts' : apiPath.endsWith('/runs/1') ? 'run' : 'other'] = jq;
    return reader({ artifacts: [name('success', 'success')] })(apiPath, jq);
  };
  checkGuardVerdict({ read, repo: REPO, url: URL1, bind: bind(), expect: { check: 'hardstops' } });
  const jq = (expr, payload) => spawnSync('jq', ['-rc', expr], { input: JSON.stringify(payload), encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n');
  const payload = {
    id: 1, name: 'Pipeline guards', path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', head_sha: 'b'.repeat(40),
    run_attempt: 2, run_number: 9, created_at: T('10:00:00'), run_started_at: T('10:00:40'), updated_at: T('10:12:00'), status: 'in_progress',
    pull_requests: [{ number: 7, id: 99, url: 'x', head: { sha: HEAD, ref: 'f', repo: { id: 1 } }, base: { ref: 'main', sha: 'c'.repeat(40), repo: { id: 1 } } }],
  };
  assert.deepEqual(JSON.parse(jq(filters.run, payload)), {
    path: payload.path, event: 'pull_request_target', head_sha: 'b'.repeat(40), run_attempt: 2, created_at: T('10:00:00'), updated_at: T('10:12:00'),
    pull_requests: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main' } }],
  });
  const listing = { total_count: 2, artifacts: [{ id: 1, name: name('success', 'failure'), expired: false }, { id: 2, name: 'verify-report', expired: false }] };
  assert.equal(jq(filters.artifacts, listing), `${name('success', 'failure')}\nverify-report\n`);
  assert.equal(jq(filters.artifacts, { total_count: 0, artifacts: [] }), '');
});
