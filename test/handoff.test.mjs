// The busy-main hand-off: the eligibility rule, the comment text and the CI-tested-base lookup (pure, no CLI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ciTestedBase, handoffEligibility, renderHandoffComment, HANDOFF_MARKER } from '../pipeline/lib/handoff.mjs';

const gate = (failed, detail = 'behind-base: 2 commits') => ({
  checks: [
    { name: 'pr-open', ok: !failed.includes('pr-open'), detail: failed.includes('pr-open') ? detail : '' },
    { name: 'ci', ok: !failed.includes('ci'), detail: '' },
  ],
});
const ok = { updates: 2, strict: false, gate: gate(['pr-open']), mergeTreeOk: true, quickVerifyOk: true };

test('eligible only with every condition', () => {
  assert.equal(handoffEligibility(ok).eligible, true);
  for (const [k, v] of [['updates', 1], ['strict', true], ['strict', null], ['gate', gate(['pr-open', 'ci'])], ['gate', gate([])], ['mergeTreeOk', false], ['quickVerifyOk', false]]) {
    assert.equal(handoffEligibility({ ...ok, [k]: v }).eligible, false, `${k}=${JSON.stringify(v)}`);
  }
});

test('each miss names its reason; a pr-open failure that is not (only) behind-base is not eligible', () => {
  const why = (o) => handoffEligibility({ ...ok, ...o }).reasons.join(' | ');
  assert.match(why({ updates: 1 }), /fewer than 2 base updates/);
  assert.match(why({ strict: null }), /branch protection requires up-to-date branches \(or could not be read\)/);
  assert.match(why({ gate: gate(['pr-open', 'ci']) }), /fails more than behind-base: pr-open, ci/);
  assert.match(why({ gate: gate([]) }), /not behind base/);
  assert.match(why({ gate: gate(['pr-open'], 'PR is a draft') }), /fails more than behind-base: pr-open/);
  assert.match(why({ gate: gate(['pr-open'], 'behind-base: 1; update it; PR base is "x", not main') }), /fails more than behind-base/);
  assert.match(why({ mergeTreeOk: false }), /merge-tree conflicts with main/);
  assert.match(why({ quickVerifyOk: false }), /quick verify failed on head merged with main/);
  assert.equal(handoffEligibility({ ...ok, quickVerifyOk: null }).eligible, false, 'a skipped quick verify is never eligible');
  assert.equal(handoffEligibility({ ...ok, updates: undefined }).eligible, false);
});

test('the comment says what was and was not verified, shows overlap, items and the production line', () => {
  const body = renderHandoffComment({
    pr: 9, head: 'a'.repeat(40), baseTip: 'b'.repeat(40), ciBase: 'c'.repeat(40),
    commits: [{ sha: 'd'.repeat(40), subject: 'x', files: ['src/a.mjs'] }], prFiles: ['src/a.mjs'], ownerItems: ['hardstop R4-pipeline x'], productionWatch: 'session',
  });
  assert.ok(body.startsWith(HANDOFF_MARKER));
  assert.equal(HANDOFF_MARKER, '<!-- claude-pipeline:handoff -->');
  assert.match(body, /NOT verified: full verify \/ CI on head merged with main@bbbbbbbbbbbb/);
  assert.match(body, /CI on head merged with main@cccccccccccc/);
  assert.match(body, /quick verify on head merged with main@bbbbbbbbbbbb/);
  assert.match(body, /touches this PR's files: src\/a\.mjs/);
  assert.match(body, /hardstop R4-pipeline x/);
  assert.match(body, /nobody watches production .* until you say `ship resume 9`/);
  assert.match(body, /the pipeline will not merge/);
});

test('no overlap, no items, workflow / none production lines, an unknown CI base and changed items', () => {
  const base = { pr: 4, head: 'a'.repeat(40), baseTip: 'b'.repeat(40), ciBase: 'unknown', commits: [{ sha: 'e'.repeat(40), subject: 'y', files: ['docs/z.md'] }], prFiles: ['src/a.mjs'], ownerItems: [] };
  const wf = renderHandoffComment({ ...base, productionWatch: 'workflow', itemsChanged: true });
  assert.match(wf, /Overlap: none of this PR's files/);
  assert.match(wf, /main@unknown \(could not prove which base CI used\)/);
  assert.match(wf, /Owner-merge items: none/);
  assert.match(wf, /workflow posts the production result on this PR/);
  assert.match(wf, /items changed while the check ran/i);
  assert.match(renderHandoffComment({ ...base, productionWatch: 'none' }), /no production environment/);
});

test('commit subjects cannot smuggle markup or mentions into the comment', () => {
  const body = renderHandoffComment({
    pr: 4, head: 'a'.repeat(40), baseTip: 'b'.repeat(40), ciBase: 'c'.repeat(40),
    commits: [{ sha: 'e'.repeat(40), subject: '<!-- x --> @owner\nsecond line', files: [] }], prFiles: [], ownerItems: [], productionWatch: 'none',
  });
  assert.doesNotMatch(body.split('\n').slice(1).join('\n'), /<!--/);
  assert.doesNotMatch(body, /@owner/);
});

// ---- ciTestedBase ------------------------------------------------------------------------------------------------

const H = 'a'.repeat(40);
const T1 = 'b'.repeat(40);
const T2 = 'c'.repeat(40);
const M1 = '1'.repeat(40);
const M2 = '2'.repeat(40);
const run = (id, merge, extra = {}) => ({
  id, head_sha: H, event: 'pull_request', status: 'completed', conclusion: 'success', repository: { full_name: 'acme/widgets' },
  pull_requests: [{ number: 12 }], referenced_workflows: [{ path: 'x', ref: 'refs/pull/12/merge', sha: merge }], ...extra,
});
function fakeGh({ runs, commits = { [M1]: [H, T1], [M2]: [H, T2] }, listing = null }) {
  const calls = [];
  return {
    calls,
    repo: () => ({ slug: 'acme/widgets' }),
    api(method, path) {
      calls.push(path);
      if (path.includes('/actions/runs')) return listing ?? { total_count: runs.length, workflow_runs: runs };
      const m = /git\/commits\/([0-9a-f]{40})/.exec(path);
      if (m && commits[m[1]]) return { parents: commits[m[1]].map((sha) => ({ sha })) };
      throw new Error(`unexpected ${path}`);
    },
  };
}

test('ciTestedBase: the parent of the CI merge commit that is not the head', () => {
  const gh = fakeGh({ runs: [run(1, M1)] });
  assert.equal(ciTestedBase({ gh, pr: 12, head: H }), T1);
  assert.match(gh.calls[0], /actions\/runs\?head_sha=a{40}&event=pull_request/);
});

test('ciTestedBase: runs that agree give the sha; runs that disagree, or none usable, give unknown', () => {
  assert.equal(ciTestedBase({ gh: fakeGh({ runs: [run(1, M1), run(2, M1)] }), pr: 12, head: H }), T1);
  assert.equal(ciTestedBase({ gh: fakeGh({ runs: [run(1, M1), run(2, M2)] }), pr: 12, head: H }), 'unknown');
  assert.equal(ciTestedBase({ gh: fakeGh({ runs: [] }), pr: 12, head: H }), 'unknown');
  for (const bad of [
    run(1, M1, { status: 'in_progress' }), run(1, M1, { pull_requests: [{ number: 99 }] }), run(1, M1, { pull_requests: [] }),
    run(1, M1, { head_sha: 'f'.repeat(40) }), run(1, M1, { referenced_workflows: [{ ref: 'refs/pull/99/merge', sha: M1 }] }),
    run(1, M1, { referenced_workflows: undefined }), run(1, M1, { repository: { full_name: 'evil/fork' } }),
  ]) assert.equal(ciTestedBase({ gh: fakeGh({ runs: [bad] }), pr: 12, head: H }), 'unknown', JSON.stringify(bad));
});

test('ciTestedBase: a merge commit that is not [head, base], an unreadable listing or a throwing API all give unknown', () => {
  assert.equal(ciTestedBase({ gh: fakeGh({ runs: [run(1, M1)], commits: { [M1]: [T1, T2] } }), pr: 12, head: H }), 'unknown');
  assert.equal(ciTestedBase({ gh: fakeGh({ runs: [run(1, M1)], commits: { [M1]: [H] } }), pr: 12, head: H }), 'unknown');
  assert.equal(ciTestedBase({ gh: fakeGh({ runs: [], listing: { nope: true } }), pr: 12, head: H }), 'unknown');
  assert.equal(ciTestedBase({ gh: { repo: () => ({ slug: 'acme/widgets' }), api() { throw new Error('boom'); } }, pr: 12, head: H }), 'unknown');
});

test('ciTestedBase: a short page before total_count is an incomplete listing (unknown); a second page is read', () => {
  const many = Array.from({ length: 100 }, (_, i) => run(i + 1, M1));
  const pages = [{ total_count: 101, workflow_runs: many }, { total_count: 101, workflow_runs: [run(101, M1)] }];
  let n = 0;
  const gh = { ...fakeGh({ runs: [] }), api(method, path) { return path.includes('/actions/runs') ? pages[n++] : { parents: [{ sha: H }, { sha: T1 }] }; } };
  assert.equal(ciTestedBase({ gh, pr: 12, head: H }), T1);
  assert.equal(n, 2);
  const short = { ...fakeGh({ runs: [] }), api: () => ({ total_count: 150, workflow_runs: many.slice(0, 50) }) };
  assert.equal(ciTestedBase({ gh: short, pr: 12, head: H }), 'unknown');
});

test('the comment uses the whole-range overlap it is given and says when commits were left out', () => {
  const base = { pr: 4, head: 'a'.repeat(40), baseTip: 'b'.repeat(40), ciBase: 'unknown', commits: [{ sha: 'e'.repeat(40), subject: 'y', files: ['docs/z.md'] }], prFiles: ['src/a.mjs'], ownerItems: [] };
  const cut = renderHandoffComment({ ...base, totalCommits: 120, overlap: ['src/a.mjs'] });
  assert.match(cut, /touches this PR's files: src\/a\.mjs/);
  assert.match(cut, /119 of main's 120 commits are not listed/);
  assert.doesNotMatch(renderHandoffComment(base), /not listed/);
});
