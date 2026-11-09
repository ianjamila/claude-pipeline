// Unit tests for lib/guard-provenance.mjs: the verdict artifact's name format, and the run / artifact checks with a scripted
// `read` (the orchestrator and final-gate tests cover the same code through the CLIs and the fake gh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import {
  APPROVAL_LABELS, QUEUE_WORKFLOW_PATH, checkGuardVerdict, checkQueueVerdict, checkRunProvenance, checkVerdictArtifact, parseQueueVerdictArtifactName, parseVerdictArtifactName,
  queueVerdictArtifactName, verdictArtifactName, withinRunWindow, zipEntryText,
} from '../pipeline/lib/guard-provenance.mjs';

const REPO = 'acme/app';
const HEAD = 'a'.repeat(40);
const URL1 = 'https://github.com/acme/app/actions/runs/1';
const T = (hhmmss) => `2026-10-01T${hhmmss}Z`;

// ---- the artifact name ------------------------------------------------------------------------------------------------------

test('verdictArtifactName: the exact v2 format (three states), with and without a receipt', () => {
  assert.equal(verdictArtifactName({ head: HEAD, integrity: 'success', hardstops: 'failure', review: 'off' }), `pipeline-verdict_v2_${HEAD}_success_failure_off`);
  assert.equal(verdictArtifactName({ head: HEAD, integrity: 'success', hardstops: 'success', review: 'success' }), `pipeline-verdict_v2_${HEAD}_success_success_success`);
  assert.equal(
    verdictArtifactName({ head: HEAD, integrity: 'error', hardstops: 'success', review: 'failure', receipt: { label: 'human-approved', login: 'Ian-J' } }),
    `pipeline-verdict_v2_${HEAD}_error_success_failure_human-approved_Ian-J`,
  );
  assert.equal(
    verdictArtifactName({ head: HEAD.toUpperCase(), integrity: 'success', hardstops: 'success', review: 'error', receipt: { label: 'test-change-approved', login: 'dependabot[bot]' } }),
    `pipeline-verdict_v2_${HEAD}_success_success_error_test-change-approved_dependabot[bot]`,
    'the head is lower-cased; a bot login keeps its [bot] suffix',
  );
});

test('verdictArtifactName: refuses anything outside the format instead of producing an ambiguous name', () => {
  const ok = { head: HEAD, integrity: 'success', hardstops: 'success', review: 'off' };
  for (const bad of [
    { ...ok, head: 'abc' }, { ...ok, head: `${HEAD}0` }, { ...ok, head: undefined },
    { ...ok, integrity: 'passed' }, { ...ok, hardstops: '' }, { ...ok, integrity: undefined },
    { ...ok, review: undefined }, { ...ok, review: 'skipped' }, { ...ok, integrity: 'off' }, { ...ok, hardstops: 'off' },
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
      for (const review of ['success', 'failure', 'error', 'off']) {
        for (const receipt of [null, ...APPROVAL_LABELS.map((label) => ({ label, login: 'acme' }))]) {
          const name = verdictArtifactName({ head: HEAD, integrity, hardstops, review, receipt });
          assert.deepEqual(parseVerdictArtifactName(name), { version: 2, head: HEAD, integrity, hardstops, review, receipt }, name);
          // GitHub rejects these characters in an artifact name: the format must never need them
          assert.doesNotMatch(name, /[":<>|*?\\/\r\n]/);
        }
      }
    }
  }
  // v1 (guards from before the review status) still parses, with review null
  assert.deepEqual(parseVerdictArtifactName(`pipeline-verdict_v1_${HEAD}_success_failure`), { version: 1, head: HEAD, integrity: 'success', hardstops: 'failure', review: null, receipt: null });
  assert.deepEqual(parseVerdictArtifactName(`pipeline-verdict_v1_${HEAD}_success_success_human-approved_acme`).receipt, { label: 'human-approved', login: 'acme' });
  assert.equal(parseVerdictArtifactName(`pipeline-verdict_v1_${HEAD}_success_success_success`), null, 'a v1 name has no review state');
  assert.equal(parseVerdictArtifactName(`pipeline-verdict_v2_${HEAD}_success_success`), null, 'a v2 name must have one');
  assert.equal(parseVerdictArtifactName(`pipeline-verdict_v3_${HEAD}_success_success_success`), null);
  const good = `pipeline-verdict_v2_${HEAD}_success_success_off_human-approved_acme`;
  assert.notEqual(parseVerdictArtifactName(good), null);
  for (const bad of [
    '', null, undefined, 42, 'verify-report',
    ` ${good}`, `${good} `, `${good}\n`, `\n${good}`, `${good}\nx`, `${good}_`, `${good}_x`, `${good}/..`,
    good.replace('v2', 'v1'), good.replace('_off_', '_pending_'), good.replace('_off_', '_'), good.replace('pipeline-verdict', 'Pipeline-verdict'),
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
  path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', status: 'completed', head_sha: HEAD, run_attempt: 1,
  created_at: T('10:00:00'), updated_at: T('10:12:00'), pull_requests: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main', sha: 'b'.repeat(40) } }],
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

// ---- run-level provenance: which commit the workflow file came from ---------------------------------------------------------

// GitHub's real shape for pull_request_target (EagleWatch run 37906872583): head_sha is the PR HEAD, which is not on main;
// the bound PR entry's base.sha is the main commit. compare answers per sha, so checking the wrong one fails.
const MAIN = 'b'.repeat(40);
const shaReader = ({ prs, onMain = [MAIN], calls = [] }) => (apiPath) => {
  calls.push(apiPath);
  if (apiPath === `repos/${REPO}/actions/runs/1`) return JSON.stringify({ ...GOOD, head_sha: HEAD, pull_requests: prs });
  if (apiPath === `repos/${REPO}`) return 'main\n';
  const m = /^repos\/acme\/app\/compare\/([0-9a-f]{40})\.\.\.main$/.exec(apiPath);
  if (m) return onMain.includes(m[1]) ? 'ahead\n' : 'behind\n';
  throw new Error(`unexpected read ${apiPath}`);
};
const provSha = (opts) => checkRunProvenance({ read: shaReader(opts), repo: REPO, url: URL1, bind: bind() });

test('checkRunProvenance: the source commit is the bound PR\'s base.sha, never the run\'s head_sha (= the PR head)', () => {
  const calls = [];
  const r = provSha({ prs: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main', sha: MAIN } }], calls });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(calls.filter((c) => c.includes('/compare/')), [`repos/${REPO}/compare/${MAIN}...main`]);
});

test('checkRunProvenance: a base.sha that is not on the default branch fails, naming that sha', () => {
  const off = 'd'.repeat(40);
  const r = provSha({ prs: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main', sha: off } }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the workflow ran from ddddddd, which is not on the default branch \(behind\)/);
});

test('checkRunProvenance: a bound PR entry without a full base sha fails closed', () => {
  for (const base of [{ ref: 'main' }, { ref: 'main', sha: '' }, { ref: 'main', sha: 'b'.repeat(39) }, { ref: 'main', sha: 'g'.repeat(40) }, { ref: 'main', sha: null }]) {
    const r = provSha({ prs: [{ number: 7, head: { sha: HEAD }, base }] });
    assert.equal(r.ok, false, JSON.stringify(base));
    assert.match(r.reason, /PR #7 entry has no base sha/);
  }
});

test('checkRunProvenance: the run must have judged THIS head (pull_request_target records the PR head as head_sha)', () => {
  for (const head_sha of ['e'.repeat(40), '', null, 'E'.repeat(39)]) {
    const r = prov({ run: { head_sha } });
    assert.equal(r.ok, false, String(head_sha));
  }
  assert.match(prov({ run: { head_sha: 'e'.repeat(40) } }).reason, /the run judged eeeeeee, not /);
  assert.match(prov({ run: { head_sha: '' } }).reason, /the run has no head_sha/);
  assert.equal(prov({ run: { head_sha: HEAD.toUpperCase() } }).ok, true);
});

test('checkRunProvenance: a run that also lists a PR into another branch (same head) is refused: that PR may have triggered it', () => {
  const pull_requests = [
    { number: 7, head: { sha: HEAD }, base: { ref: 'main', sha: 'b'.repeat(40) } },
    { number: 8, head: { sha: HEAD }, base: { ref: 'side', sha: 'c'.repeat(40) } },
  ];
  for (const order of [pull_requests, [...pull_requests].reverse()]) {
    const r = prov({ run: { pull_requests: order } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /also about PR #8 into side/);
  }
  const noRef = prov({ run: { pull_requests: [pull_requests[0], { number: 9, head: { sha: HEAD }, base: {} }] } });
  assert.equal(noRef.ok, false);
  assert.match(noRef.reason, /also about PR #9 into \(unknown\)/);
});

test('checkRunProvenance: the base.sha comes from the BOUND entry, not another PR the run lists', () => {
  const off = 'd'.repeat(40);
  const r = provSha({ prs: [
    { number: 8, head: { sha: HEAD }, base: { ref: 'main', sha: MAIN } },
    { number: 7, head: { sha: HEAD }, base: { ref: 'main', sha: off } },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ddddddd, which is not on the default branch/);
});

// ---- the artifact check ----------------------------------------------------------------------------------------------------

const name = (integrity, hardstops, receipt = null, head = HEAD, review = 'off') => verdictArtifactName({ head, integrity, hardstops, review, receipt });

test('checkVerdictArtifact: a review status needs a v2 artifact whose review state is success; v1 still backs the older checks', () => {
  const reviewed = (state) => name('success', 'success', null, HEAD, state);
  assert.equal(art([reviewed('success')], { check: 'review' }).ok, true);
  for (const state of ['failure', 'error', 'off']) {
    const r = art([reviewed(state)], { check: 'review' });
    assert.equal(r.ok, false, state);
    assert.match(r.reason, new RegExp(`verdict for review is ${state}`));
  }
  const v1 = `pipeline-verdict_v1_${HEAD}_success_success`;
  assert.match(art([v1], { check: 'review' }).reason, /no v2 verdict artifact/, 'a v1 artifact says nothing about a review');
  assert.equal(art([v1], { check: 'hardstops' }).ok, true);
  assert.equal(art([`pipeline-verdict_v1_${HEAD}_success_success_human-approved_acme`], { receipt: { label: 'human-approved', login: 'acme' } }).ok, true);
  // the v2 artifact next to a v1 one must still agree on the older checks
  assert.equal(art([v1, name('success', 'failure')], { check: 'hardstops' }).ok, false);
});
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

test('a run read while still in progress is not cached: its own later status and artifact are accepted once it completes', () => {
  // Measured on EagleWatch #1426: the gate read run 37929234322 at 12:19:11Z (in progress), the job posted its status at
  // 12:19:29Z and completed at 12:19:33Z; the cached early read discarded that status for the rest of the gate.
  const live = { run: { status: 'in_progress', updated_at: T('10:01:00') }, artifacts: [] };
  const calls = [];
  const read = (apiPath, jq) => reader({ ...live, calls })(apiPath, jq);
  const cache = new Map();
  const b = bind({ createdAt: T('10:05:00') });
  const early = checkGuardVerdict({ read, repo: REPO, url: URL1, bind: b, expect: { check: 'hardstops' }, cache });
  assert.equal(early.ok, false);
  assert.match(early.reason, /outside the run's window/);
  live.run = { status: 'completed', updated_at: T('10:06:00') };
  live.artifacts = [name('success', 'success')];
  const later = checkGuardVerdict({ read, repo: REPO, url: URL1, bind: b, expect: { check: 'hardstops' }, cache });
  assert.equal(later.ok, true, later.reason);
  assert.equal(later.completed, true);
  // completed now: read once more, then cached
  checkGuardVerdict({ read, repo: REPO, url: URL1, bind: b, expect: { check: 'hardstops' }, cache });
  assert.equal(calls.filter((c) => c === `repos/${REPO}/actions/runs/1`).length, 2);
  assert.equal(calls.filter((c) => c.includes('/artifacts')).length, 1);
});

test('an in-progress run with no verdict artifact yet does not cache the empty artifact list', () => {
  const live = { run: { status: 'in_progress' }, artifacts: [] };
  const read = (apiPath, jq) => reader(live)(apiPath, jq);
  const cache = new Map();
  assert.match(checkGuardVerdict({ read, repo: REPO, url: URL1, bind: bind(), expect: { check: 'integrity' }, cache }).reason, /no verdict artifact/);
  live.run = { status: 'completed' };
  live.artifacts = [name('success', 'success')];
  assert.equal(checkGuardVerdict({ read, repo: REPO, url: URL1, bind: bind(), expect: { check: 'integrity' }, cache }).ok, true);
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
    id: 1, name: 'Pipeline guards', path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', head_sha: HEAD,
    run_attempt: 2, run_number: 9, created_at: T('10:00:00'), run_started_at: T('10:00:40'), updated_at: T('10:12:00'), status: 'in_progress',
    pull_requests: [{ number: 7, id: 99, url: 'x', head: { sha: HEAD, ref: 'f', repo: { id: 1 } }, base: { ref: 'main', sha: 'c'.repeat(40), repo: { id: 1 } } }],
  };
  assert.deepEqual(JSON.parse(jq(filters.run, payload)), {
    path: payload.path, event: 'pull_request_target', status: 'in_progress', head_sha: HEAD, run_attempt: 2, created_at: T('10:00:00'), updated_at: T('10:12:00'),
    pull_requests: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) } }],
  });
  const listing = { total_count: 2, artifacts: [{ id: 1, name: name('success', 'failure'), expired: false }, { id: 2, name: 'verify-report', expired: false }] };
  assert.equal(jq(filters.artifacts, listing), `${name('success', 'failure')}\nverify-report\n`);
  assert.equal(jq(filters.artifacts, { total_count: 0, artifacts: [] }), '');
});

// ---- a run URL under a former repository name (the repo was renamed or transferred; GitHub redirects the old name) -------------

const OLD_URL = 'https://github.com/acme/old-app/actions/runs/1';
// ids: { [name]: text | Error }; the run itself is read from the CURRENT name, as before.
const movedProv = (ids, { cache = new Map(), calls = [], url = OLD_URL } = {}) => {
  const base = reader({ calls });
  const read = (apiPath, jq) => {
    if (jq === '.id') {
      calls.push(`id:${apiPath}`);
      const v = ids[apiPath.replace(/^repos\//, '')];
      if (v === undefined) throw new Error(`no such repository ${apiPath}`);
      if (v instanceof Error) throw v;
      return v;
    }
    return base(apiPath, jq);
  };
  return checkRunProvenance({ read, repo: REPO, url, bind: bind(), cache });
};

test('checkRunProvenance: a run URL that names the former repository name counts when both names resolve to one repository id', () => {
  const calls = [];
  const cache = new Map();
  const r = movedProv({ 'acme/old-app': '4242\n', 'acme/app': '4242\n' }, { calls, cache });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(calls.includes('repos/acme/app/actions/runs/1'), 'the run is still read from the current name');
  assert.equal(cache.get('repo-id:acme/old-app'), 4242);
  assert.equal(cache.get('repo-id:acme/app'), 4242);
  // the ids are cached: a second status of the same process reads each once
  const again = [];
  assert.equal(movedProv({ 'acme/old-app': '4242', 'acme/app': '4242' }, { calls: again, cache }).ok, true);
  assert.equal(again.filter((c) => c.startsWith('id:')).length, 0);
});

test('checkRunProvenance: a run URL with a . or .. segment (or a name with no letter or digit) is refused and no repos/ path is built from it', () => {
  for (const url of ['https://github.com/../user/actions/runs/1', 'https://github.com/./x/actions/runs/1', 'https://github.com/acme/../actions/runs/1', 'https://github.com/_/-/actions/runs/1', 'https://github.com/.../x/actions/runs/1']) {
    const calls = [];
    const r = movedProv({ 'acme/app': '4242' }, { calls, url });
    assert.equal(r.ok, false, url);
    assert.equal(r.reason, 'the run belongs to a different repository', url);
    assert.deepEqual(calls.filter((c) => /\.\.?(\/|$)/.test(c) || c.includes('/_/') || c.includes('/-')), [], `${url}: nothing read from a path built from it`);
    assert.equal(calls.length, 0, `${url}: nothing read at all`);
  }
});

test('checkRunProvenance: a former-name run URL is refused when the ids differ, a read throws, or an id is missing or not a positive integer', () => {
  const refused = (why, ids) => {
    const r = movedProv(ids);
    assert.equal(r.ok, false, why);
    assert.equal(r.reason, 'the run belongs to a different repository', why);
  };
  refused('different ids (another repository at that name)', { 'acme/old-app': '4243', 'acme/app': '4242' });
  refused('the former name cannot be read', { 'acme/app': '4242' });
  refused('the current name cannot be read', { 'acme/old-app': '4242' });
  refused('a read throws', { 'acme/old-app': new Error('HTTP 404'), 'acme/app': '4242' });
  for (const bad of ['', 'null', '0', '-5', '4.2', 'abc', '12 34']) {
    refused(`non-integer id ${JSON.stringify(bad)}`, { 'acme/old-app': bad, 'acme/app': bad });
  }
  refused('one id missing', { 'acme/old-app': '', 'acme/app': '4242' });
});

test('checkRunProvenance: a run URL of the same name never reads repository ids (case-insensitive)', () => {
  const calls = [];
  const r = movedProv({}, { calls, url: 'https://github.com/ACME/App/actions/runs/1' });
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c.startsWith('id:')).length, 0);
});

// ---- the queue verdict (the poster's run-owned artifact on a merge-queue commit) --------------------------------------------

const QSHA = 'b'.repeat(40);
const Q_URL = 'https://github.com/acme/app/actions/runs/50';
const QHEAD = '5'.repeat(40);
const qname = (i = 'success', h = 'success', r = 'success', sha = QSHA) => queueVerdictArtifactName({ queueSha: sha, integrity: i, hardstops: h, review: r });
const qverdict = (over = {}) => ({
  version: 1, queueSha: QSHA, base: 'c'.repeat(40),
  members: [{ pr: 3, head: '3'.repeat(40), entryId: 'E3', commit: 'a'.repeat(40) }, { pr: 5, head: QHEAD, entryId: 'E5', commit: QSHA }],
  checks: { integrity: { state: 'success' }, hardstops: { state: 'success' }, review: { state: 'success' } },
  ...over,
});
// A scripted queue-guards run on main: `run` overrides its fields, `artifacts` is [{ id, name }], `files` maps artifact id to verdict.json text.
function qreader({ run = {}, artifacts = [{ id: 7001, name: qname() }], files = { 7001: JSON.stringify(qverdict()) }, ancestor = 'ahead', calls = [] } = {}) {
  const read = (apiPath, jq) => {
    calls.push(apiPath);
    if (apiPath === 'repos/acme/app/actions/runs/50') {
      return JSON.stringify({
        path: '.github/workflows/queue-guards.yml@refs/heads/main', event: 'workflow_run', status: 'completed', head_sha: 'd'.repeat(40), head_branch: 'main',
        run_attempt: 1, created_at: T('10:00:00'), updated_at: T('10:05:00'), ...run,
      });
    }
    if (apiPath === 'repos/acme/app/actions/runs/50/artifacts?per_page=100') return artifacts.map((a) => `${a.id} ${a.name}`).join('\n');
    if (apiPath === 'repos/acme/app') return 'main\n';
    if (/^repos\/acme\/app\/compare\/[0-9a-f]{40}\.\.\.main$/.test(apiPath)) return `${ancestor}\n`;
    throw new Error(`unscripted read ${apiPath} ${jq}`);
  };
  const readArtifact = ({ id }) => {
    if (files[id] === undefined) throw new Error('no such artifact');
    return files[id];
  };
  return { read, readArtifact, calls };
}
const qcheck = (r, over = {}) => checkQueueVerdict({ read: r.read, readArtifact: r.readArtifact, repo: REPO, url: Q_URL, queueSha: QSHA, pr: 5, head: QHEAD, expect: { check: 'hardstops' }, ...over });

test('queueVerdictArtifactName: the exact format; parse is its inverse; anything else is refused', () => {
  assert.equal(qname('success', 'failure', 'off'), `queue-verdict_v1_${QSHA}_success_failure_off`);
  assert.equal(QUEUE_WORKFLOW_PATH, '.github/workflows/queue-guards.yml');
  for (const i of ['success', 'failure', 'error']) {
    for (const r of ['success', 'failure', 'error', 'off']) {
      const n = qname(i, 'error', r);
      assert.deepEqual(parseQueueVerdictArtifactName(n), { queueSha: QSHA, integrity: i, hardstops: 'error', review: r }, n);
      assert.doesNotMatch(n, /[":<>|*?\\/\r\n]/);
    }
  }
  const ok = { queueSha: QSHA, integrity: 'success', hardstops: 'success', review: 'off' };
  for (const bad of [{ ...ok, queueSha: 'abc' }, { ...ok, integrity: 'off' }, { ...ok, hardstops: 'passed' }, { ...ok, review: 'skipped' }, { ...ok, review: undefined }]) {
    assert.throws(() => queueVerdictArtifactName(bad), /queue verdict artifact/, JSON.stringify(bad));
  }
  const good = qname();
  for (const bad of ['', null, `${good}_x`, ` ${good}`, good.replace('queue-verdict', 'pipeline-verdict'), good.replace('_v1_', '_v2_'), good.replace(QSHA, 'b'.repeat(39)), `pipeline-verdict_v2_${QSHA}_success_success_success`]) {
    assert.equal(parseQueueVerdictArtifactName(bad), null, String(bad));
  }
});

test('checkQueueVerdict: the right run + artifact for this PR and head => ok', () => {
  const r = qreader();
  const v = qcheck(r);
  assert.equal(v.ok, true, v.reason);
  for (const check of ['integrity', 'review']) assert.equal(qcheck(r, { expect: { check } }).ok, true, check);
});

test('checkQueueVerdict: a copied URL of a run whose manifest lacks the PR (or lists it at another head) => not ok', () => {
  const lacks = qreader({ files: { 7001: JSON.stringify(qverdict({ members: [{ pr: 3, head: '3'.repeat(40), entryId: 'E3', commit: 'a'.repeat(40) }] })) } });
  assert.match(qcheck(lacks).reason, /manifest/);
  const other = qreader({ files: { 7001: JSON.stringify(qverdict({ members: [{ pr: 5, head: '9'.repeat(40), entryId: 'E5', commit: QSHA }] })) } });
  assert.match(qcheck(other).reason, /manifest/);
  assert.equal(qcheck(qreader(), { pr: 6 }).ok, false);
  assert.equal(qcheck(qreader(), { head: '9'.repeat(40) }).ok, false);
});

test('checkQueueVerdict: other workflow, event, attempt, branch, or a head_sha off the default branch => not ok', () => {
  assert.match(qcheck(qreader({ run: { path: '.github/workflows/pipeline-guards.yml@refs/heads/main' } })).reason, /queue-guards\.yml/);
  assert.match(qcheck(qreader({ run: { event: 'merge_group' } })).reason, /workflow_run/);
  assert.match(qcheck(qreader({ run: { run_attempt: 2 } })).reason, /attempt 2/);
  assert.match(qcheck(qreader({ run: { head_branch: 'gh-readonly-queue/main/pr-5-x' } })).reason, /head_branch/);
  assert.match(qcheck(qreader({ ancestor: 'diverged' })).reason, /not on the default branch/);
  assert.equal(qcheck(qreader({ ancestor: 'identical' })).ok, true, 'head_sha may equal the default tip');
  assert.equal(qcheck(qreader({ run: { head_sha: '' } })).ok, false);
  assert.equal(qcheck(qreader(), { url: 'https://github.com/other/app/actions/runs/50' }).ok, false, 'a run of another repository');
});

test('checkQueueVerdict: the artifact must name this queue commit and say success for the context', () => {
  assert.match(qcheck(qreader({ artifacts: [{ id: 7001, name: qname('success', 'success', 'success', 'e'.repeat(40)) }] })).reason, /no queue verdict artifact/);
  assert.match(qcheck(qreader({ artifacts: [] })).reason, /no queue verdict artifact/);
  assert.match(qcheck(qreader({ artifacts: [{ id: 7001, name: qname('success', 'failure', 'success') }] })).reason, /hardstops is failure/);
  assert.equal(qcheck(qreader({ artifacts: [{ id: 7001, name: qname('success', 'failure', 'success') }] }), { expect: { check: 'integrity' } }).ok, true);
  // the file says failure although the name says success (name and content must agree)
  const liar = qreader({ files: { 7001: JSON.stringify(qverdict({ checks: { hardstops: { state: 'failure' } } })) } });
  assert.equal(qcheck(liar).ok, false);
  const otherQ = qreader({ files: { 7001: JSON.stringify(qverdict({ queueSha: 'e'.repeat(40) })) } });
  assert.equal(qcheck(otherQ).ok, false);
  assert.equal(qcheck(qreader(), { expect: {} }).ok, false);
  assert.equal(qcheck(qreader(), { expect: { check: 'nonsense' } }).ok, false);
});

test('checkQueueVerdict: fails closed when the artifact cannot be read, has no reader, or is not the poster\'s JSON', () => {
  assert.equal(qcheck(qreader({ files: {} })).ok, false);
  assert.equal(qcheck(qreader({ files: { 7001: 'not json' } })).ok, false);
  assert.equal(qcheck(qreader({ files: { 7001: JSON.stringify(qverdict({ version: 2 })) } })).ok, false);
  const r = qreader();
  assert.match(checkQueueVerdict({ read: r.read, repo: REPO, url: Q_URL, queueSha: QSHA, pr: 5, head: QHEAD, expect: { check: 'hardstops' } }).reason, /cannot read the artifact/);
  assert.equal(checkQueueVerdict({ read: () => { throw new Error('HTTP 500'); }, readArtifact: r.readArtifact, repo: REPO, url: Q_URL, queueSha: QSHA, pr: 5, head: QHEAD, expect: { check: 'hardstops' } }).ok, false);
  assert.equal(qcheck(r, { url: 'not a url' }).ok, false);
  assert.equal(qcheck(r, { queueSha: 'abc' }).ok, false);
});

test('checkQueueVerdict: a run that has not completed is never cached (its artifact list still moves)', () => {
  const cache = new Map();
  const running = qreader({ run: { status: 'in_progress' }, artifacts: [] });
  assert.equal(qcheck(running, { cache }).ok, false);
  const done = qreader();
  assert.equal(qcheck(done, { cache }).ok, true, 'the second read sees the finished run, not a cached early one');
  assert.equal(qcheck(done, { cache }).ok, true);
  assert.equal(done.calls.filter((c) => c.endsWith('/actions/runs/50')).length, 1, 'a completed run is read once');
});

test('zipEntryText: reads a stored or deflated entry from a zip; refuses a missing entry, garbage and an oversized entry', () => {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const zip = (entries) => {
    let offset = 0;
    const locals = [];
    const centrals = [];
    for (const { name: n, data, method } of entries) {
      const body = method === 8 ? deflateRawSync(Buffer.from(data)) : Buffer.from(data);
      const nameBuf = Buffer.from(n);
      const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(body.length), u32(Buffer.byteLength(data)), u16(nameBuf.length), u16(0), nameBuf, body]);
      centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(body.length), u32(Buffer.byteLength(data)), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
      locals.push(local);
      offset += local.length;
    }
    const cd = Buffer.concat(centrals);
    return Buffer.concat([...locals, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  };
  const json = JSON.stringify(qverdict());
  const z = zip([{ name: 'other.txt', data: 'x', method: 0 }, { name: 'verdict.json', data: json, method: 8 }]);
  assert.equal(zipEntryText(z, 'verdict.json'), json);
  assert.equal(zipEntryText(zip([{ name: 'verdict.json', data: json, method: 0 }]), 'verdict.json'), json);
  assert.throws(() => zipEntryText(z, 'missing.json'), /not in the zip/);
  assert.throws(() => zipEntryText(Buffer.from('not a zip at all'), 'verdict.json'), /zip/);
  assert.throws(() => zipEntryText(zip([{ name: 'verdict.json', data: 'x'.repeat(2_000_000), method: 8 }]), 'verdict.json'), /too large|zip/);
});

test('the queue run jq filter works on a GitHub-shaped payload', { skip: !hasJq && 'jq not installed' }, () => {
  const filters = [];
  const r = qreader();
  checkQueueVerdict({ read: (p, jq) => { filters.push([p, jq]); return r.read(p, jq); }, readArtifact: r.readArtifact, repo: REPO, url: Q_URL, queueSha: QSHA, pr: 5, head: QHEAD, expect: { check: 'hardstops' } });
  const jq = (expr, payload) => spawnSync('jq', ['-rc', expr], { input: JSON.stringify(payload), encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n');
  const run = filters.find(([p]) => p.endsWith('/runs/50'))[1];
  const list = filters.find(([p]) => p.includes('/artifacts'))[1];
  const payload = { id: 50, path: '.github/workflows/queue-guards.yml@refs/heads/main', event: 'workflow_run', status: 'completed', head_sha: 'd'.repeat(40), head_branch: 'main', run_attempt: 1, created_at: T('10:00:00'), updated_at: T('10:05:00'), pull_requests: [] };
  assert.deepEqual(JSON.parse(jq(run, payload)), { path: payload.path, event: 'workflow_run', status: 'completed', head_sha: 'd'.repeat(40), head_branch: 'main', run_attempt: 1, created_at: T('10:00:00'), updated_at: T('10:05:00') });
  assert.equal(jq(list, { artifacts: [{ id: 7001, name: qname(), expired: false }, { id: 7002, name: qname(), expired: true }] }), `7001 ${qname()}\n`, 'an expired artifact is never listed');
});
