// `pipeline stats rounds` (follow-up to #279, plan 2026-11-12-round-cost-park-stats.md T3): the pure aggregator on fixture states, then the command against a scripted fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, analysePr, isReadableState, isSecurityItem, renderTable } from '../pipeline/lib/round-stats.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { encodeForComment } from '../pipeline/lib/state.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const acc = (id, bucket = 'SUGGESTION', over = {}) => ({ id, bucket, category: 'maintainability', title: 'Rename helper', file: 'src/a.js', final: { decision: 'ACCEPT', by: 'judge' }, ...over });
const rej = (id, bucket = 'SUGGESTION') => ({ id, bucket, category: 'maintainability', title: 'Nit', final: { decision: 'REJECT', by: 'judge' } });
const round = (n, items = [], over = {}) => ({ n, items, ...over });
const stateOf = (rounds, maxRounds = 1) => ({ pr: 7, maxRounds, rounds });

test('analysePr: counted rounds, past-limit rounds, their admission, the round before them and what they found', () => {
  const state = stateOf([
    round(1, [acc('R1-S1')]),
    round(2, [acc('R2-S1')], { admission: 'auto-extra' }),
    round(3, [], { baseOnly: true }),
    round(4, [rej('R4-S1')], { admission: 'owner', ownerGrant: { grantId: 'g', k: 3, quote: 'extra round' } }),
    round(5, [acc('R5-B1', 'BLOCKING', { category: 'bug' })], { admission: 'owner', ownerGrant: { grantId: 'h', k: 4, quote: 'extra round' } }),
  ]);
  const record = { cost: { total: { usd: 12.345 }, byRound: { '2': { usd: 4 }, '4': { usd: 2.5 } } } };
  const p = analysePr({ repo: 'acme/widgets', pr: 7, state, record });
  assert.deepEqual([p.countedRounds, p.pastCapRounds, p.usd, p.maxRounds, p.id], [4, 3, 12.35, 1, 'widgets#7']);
  const past = p.rounds.filter((r) => r.pastCap).map((r) => [r.n, r.admission, r.previous, r.found, r.usd]);
  // the base-only round 3 is skipped when looking for the round before round 4
  assert.deepEqual(past, [[2, 'auto-extra', 'only-low-fixes', 'accepts', 4], [4, 'owner-granted', 'only-low-fixes', 'nothing-accepted', 2.5], [5, 'owner-granted', 'no-accepts', 'new-blocking', null]]);
});

test('analysePr: a heavier round before, a missing admission record, a BLOCKING loop, and a PR without state', () => {
  const state = stateOf([
    round(1, [acc('R1-B1', 'BLOCKING', { category: 'bug' })]),
    round(2, [acc('R2-B1', 'BLOCKING', { category: 'bug' })], { admission: 'auto-extra' }),
    round(3, [acc('R3-S1')]),
    round(4, [acc('R4-S1', 'SUGGESTION', { category: 'security' })]),
    round(5, []),
  ], 2);
  const p = analysePr({ repo: 'acme/widgets', pr: 7, state, record: null });
  assert.equal(p.blockingLoop, true, 'BLOCKING accepted in rounds 1 and 2');
  assert.deepEqual(p.rounds.filter((r) => r.pastCap).map((r) => [r.n, r.admission, r.previous]), [[3, 'auto-extra', 'blocking-or-security'], [4, 'unknown', 'only-low-fixes'], [5, 'unknown', 'blocking-or-security']]);
  assert.equal(p.usd, null);
  assert.equal(analysePr({ repo: 'a/b', pr: 1, state: null, record: null }), null);
  assert.equal(analysePr({ repo: 'a/b', pr: 1, state: stateOf([round(1, [acc('R1-B1', 'BLOCKING')]), round(2, [], { baseOnly: true }), round(3, [acc('R3-B1', 'BLOCKING')])], 3), record: null }).blockingLoop, true, 'a base-only round between does not break the loop');
  assert.equal(isSecurityItem({ category: 'maintainability', title: 'Token leak in log' }), true);
  assert.equal(isSecurityItem({ category: 'maintainability', title: 'Rename helper' }), false);
});

test('aggregate and renderTable: totals, shares and the table', () => {
  const a = analysePr({ repo: 'acme/widgets', pr: 1, state: stateOf([round(1, [acc('R1-S1')]), round(2, [acc('R2-S1')], { admission: 'auto-extra' })]), record: { cost: { total: { usd: 10 }, byRound: { '2': { usd: 3 } } } } });
  const b = analysePr({ repo: 'acme/widgets', pr: 2, state: stateOf([round(1, [])]), record: { cost: { total: { usd: 1 } } } });
  const t = aggregate([a, null, b]);
  assert.deepEqual([t.prs, t.prsPastCap, t.countedRounds, t.pastCapRounds, t.pastCapShare, t.usd], [2, 1, 3, 1, 0.333, 11]);
  assert.deepEqual([t.admission, t.previous, t.found, t.pastCapUsd], [{ 'auto-extra': 1 }, { 'only-low-fixes': 1 }, { accepts: 1 }, { usd: 3, rounds: 1 }]);
  assert.equal(aggregate([]).pastCapShare, null);
  const text = renderTable({ since: '2026-11-05', repos: ['acme/widgets'], totals: t, prs: [a, b] });
  assert.match(text, /widgets#1 +1 +2 +1 +\$10\.00 +r2\(auto-extra; only-low-fixes; accepts; \$3\.00\)/);
  assert.match(text, /past the limit 1 \(33\.3%\)/);
});

// ---- the command ---------------------------------------------------------------------------------------------------

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const summaryBody = (cost) => `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 7, branch: 'feat/x', baseRef: 'main' }), cost })}`;
const triageBody = (state) => `${MARKERS.triage}\n\n${encodeForComment(state)}`;
const script = (extra) => [{ match: '^repo view', stdoutJson: REPO_VIEW }, { match: '^api user', stdout: 'me\n' }, ...extra];
const mine = (id, body) => ({ id, user: { login: 'me' }, body });
function statsCli(entries, args) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.commit('init');
  const fake = createFakeGh(script(entries));
  const env = { ...process.env, ...fake.env };
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, 'stats', 'rounds', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text mode */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, fake };
}
const pulls = [
  { number: 7, merged_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z' },
  { number: 8, merged_at: null, updated_at: '2026-11-11T10:00:00Z' },
  { number: 9, merged_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' },
];
const state7 = stateOf([round(1, [acc('R1-S1')]), round(2, [acc('R2-S1')], { admission: 'auto-extra' })]);
const cost7 = { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 9, calls: 3 }, byPhase: {}, byRole: {}, byRound: { '2': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 4, calls: 1 } }, retries: 0, guardBlocks: null, sessions: [] };
const world = [
  { match: '^api repos/acme/widgets/pulls\\?state=closed', stdoutJson: pulls },
  { match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: [mine(1, summaryBody(cost7)), mine(2, triageBody(state7))] },
];

test('stats rounds --json: lists merged PRs since the date, reads their comments, aggregates; the unmerged and the older PR are not read', () => {
  const r = statsCli(world, ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.ok, r.json.since, r.json.repos, r.json.totals.prs, r.json.totals.pastCapRounds, r.json.totals.usd], [true, '2026-11-05', ['acme/widgets'], 1, 1, 9]);
  assert.deepEqual([r.json.prs[0].id, r.json.prs[0].rounds[1].usd, r.json.prs[0].rounds[1].admission], ['widgets#7', 4, 'auto-extra']);
  assert.deepEqual(r.json.warnings, []);
  assert.equal(r.fake.lines().some((l) => /issues\/(8|9)\/comments/.test(l)), false);
  assert.equal(r.fake.lines().some((l) => /-X (POST|PATCH|PUT|DELETE)/.test(l)), false, 'read-only');
});

test('stats rounds: without --json the same numbers print as a plain-text table', () => {
  const r = statsCli(world, ['--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json, null);
  assert.match(r.stdout, /widgets#7 +1 +2 +1 +\$9\.00/);
  assert.match(r.stdout, /past the limit 1 \(50\.0%\)/);
});

test('stats rounds: --pr reads just those PRs; a PR whose comments fail is a warning and is skipped; one without a state is counted apart', () => {
  const r = statsCli([...world, { match: '^api repos/acme/widgets/issues/21/comments', code: 1, stderr: 'HTTP 502' }, { match: '^api repos/acme/widgets/issues/22/comments', stdoutJson: [mine(1, 'hello')] }], ['--json', '--pr', '7', '--pr', '21', '--pr', '22']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.totals.prs, r.json.withoutState, r.json.warnings.length], [1, 1, 1]);
  assert.match(r.json.warnings[0], /widgets#21: comments could not be read/);
  assert.equal(r.fake.lines().some((l) => /pulls\?state=closed/.test(l)), false);
});

test('stats rounds: usage errors exit 2; an unreachable GitHub on the list exits 3', () => {
  assertExit(statsCli(world, ['--since', 'yesterday']), 2);
  assertExit(statsCli(world, ['--repo-slug', 'not a slug']), 2);
  assertExit(statsCli(world, ['--pr', '0']), 2);
  assertExit(statsCli([{ match: '^api repos/acme/widgets/pulls', code: 1, stderr: 'HTTP 502' }], ['--json']), 3);
  const bad = spawnSync(process.execPath, [bin, 'stats'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

// ---- round 1 review fixes ------------------------------------------------------------------------------------------

test('R1-B1 analysePr: a cached accept (an already-fixed suggestion re-raised) is not a new accept, nor an accepted BLOCKING, of the round', () => {
  const cached = (id, bucket = 'SUGGESTION') => acc(id, bucket, { final: { decision: 'ACCEPT', by: 'cache' } });
  const p = analysePr({ repo: 'acme/widgets', pr: 7, state: stateOf([round(1, [acc('R1-S1')]), round(2, [cached('R2-S1'), cached('R2-B1', 'BLOCKING')], { admission: 'auto-extra' })]), record: null });
  assert.deepEqual([p.rounds[1].found, p.rounds[1].acceptedBlocking], ['nothing-accepted', false]);
  const mixed = analysePr({ repo: 'acme/widgets', pr: 7, state: stateOf([round(1, []), round(2, [cached('R2-S1'), acc('R2-S2')], { admission: 'auto-extra' })]), record: null });
  assert.equal(mixed.rounds[1].found, 'accepts');
});

test('R1-B2 analysePr: an item deferred past the cap still counts as accepted for what its round found (as "deferred"), and not as a fix the next round re-checked', () => {
  const overruled = { decision: 'ACCEPT', by: 'judge' };
  const deferred = (id, over = {}) => ({ id, bucket: 'SUGGESTION', category: 'maintainability', title: 'Rename helper', final: { decision: 'FOLLOW-UP', by: 'claude', claude: { cause: 'round-cap', overruled } }, ...over });
  const viaMarker = deferred('R2-S1', { roundCapDeferral: { fixHead: 'a', reviewedHead: 'b', at: 't' } });
  const viaCause = deferred('R2-S2');
  const parked = { id: 'R2-S3', bucket: 'SUGGESTION', category: 'maintainability', final: { decision: 'FOLLOW-UP', by: 'claude', claude: { cause: 'round-cap', overruled: { decision: 'REJECT', by: 'judge' } } } };
  const state = stateOf([round(1, []), round(2, [viaMarker], { admission: 'auto-extra' }), round(3, [viaCause, parked], { admission: 'owner', ownerGrant: { grantId: 'g', k: 3, quote: 'extra round' } }), round(4, [])], 1);
  const p = analysePr({ repo: 'acme/widgets', pr: 7, state, record: null });
  assert.deepEqual(p.rounds.filter((r) => r.pastCap).map((r) => [r.n, r.found, r.previous]), [[2, 'deferred', 'no-accepts'], [3, 'deferred', 'no-accepts'], [4, 'nothing-accepted', 'no-accepts']]);
  assert.deepEqual(aggregate([p]).found, { deferred: 2, 'nothing-accepted': 1 });
  const unrelated = analysePr({ repo: 'acme/widgets', pr: 7, state: stateOf([round(1, []), round(2, [parked], { admission: 'auto-extra' })], 1), record: null });
  assert.equal(unrelated.rounds[1].found, 'nothing-accepted', 'a round-cap park whose original ruling was not an accept is not an accept');
});

test('R1-F2 stats rounds: only the viewer\'s own comments that start with the marker count, bound to the PR and repository; the others are ignored', () => {
  const forged = stateOf([round(1, [acc('F-1')]), round(2, [acc('F-2')]), round(3, [acc('F-3')])], 1);
  const otherPr = { ...state7, pr: 8 };
  const otherRepo = emptyRecord({ repo: 'acme/other', pr: 7, branch: 'feat/x', baseRef: 'main' });
  const cases = {
    'someone else\'s comment': [{ id: 3, user: { login: 'mallory' }, body: triageBody(forged) }, { id: 4, user: { login: 'mallory' }, body: summaryBody({ ...cost7, total: { ...cost7.total, usd: 999 } }) }],
    'a quote that does not start with the marker': [mine(3, `> quoted\n${triageBody(forged)}`)],
    'a state of another PR': [mine(3, triageBody(otherPr))],
    'a record of another repository': [mine(3, `${MARKERS.summary}\n\n${encodeRecord({ ...otherRepo, cost: { ...cost7, total: { ...cost7.total, usd: 999 } } })}`)],
    'a state with a round whose number is not an integer': [mine(3, triageBody(stateOf([round('2\n\u001b[31mFAKE', [acc('F-1')])])))],
  };
  for (const [what, extra] of Object.entries(cases)) {
    const r = statsCli([...world.slice(0, 1), { match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: [mine(1, summaryBody(cost7)), mine(2, triageBody(state7)), ...extra] }], ['--json', '--pr', '7']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.deepEqual([r.json.prs[0]?.countedRounds, r.json.totals.usd, r.json.withoutState], [2, 9, 0], what);
  }
  const onlyForged = statsCli([...world.slice(0, 1), { match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: [{ id: 3, user: { login: 'mallory' }, body: triageBody(forged) }] }], ['--json', '--pr', '7']);
  assert.deepEqual([onlyForged.json.totals.prs, onlyForged.json.withoutState], [0, 1], 'a forged state alone is no state');
  assert.equal(isReadableState(state7, 7), true);
  assert.deepEqual([isReadableState(state7, 8), isReadableState(stateOf([round(1.5)]), 7), isReadableState(stateOf([round('x')]), 7), isReadableState(null, 7)], [false, false, false, false]);
});

test('R1-F2 renderTable: everything printed is one sanitised line', () => {
  const p = analysePr({ repo: 'acme/widgets', pr: 7, state: stateOf([round(1, []), round(2, [acc('R2-S1')], { admission: 'auto-extra' })]), record: null });
  const evil = { ...p, id: 'widgets#7\n\u001b[31mFAKE', rounds: p.rounds.map((r) => ({ ...r, n: r.pastCap ? 'x\ny\u001b[2J' : r.n })) };
  const text = renderTable({ since: '2026-11-05', repos: ['acme/widgets'], totals: aggregate([p]), prs: [evil] });
  assert.equal(/[\u001b\r]/.test(text), false);
  assert.equal(text.split('\n').filter((l) => /FAKE|^y/.test(l)).length, 1, 'the injected text stays on the PR line');
});

test('R1-F3 stats rounds: a list cut by the page limit is a warning, not silence', () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, merged_at: null, updated_at: '2026-11-11T10:00:00Z' }));
  const r = statsCli([{ match: '^api repos/acme/widgets/pulls\\?state=closed', stdoutJson: full }], ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.warnings.length, 1, JSON.stringify(r.json.warnings));
  assert.match(r.json.warnings[0], /acme\/widgets: the list of closed PRs was cut after 30 pages/);
  const text = statsCli([{ match: '^api repos/acme/widgets/pulls\\?state=closed', stdoutJson: full }], ['--since', '2026-11-05']);
  assert.match(text.stdout, /Warnings:\n- acme\/widgets: the list of closed PRs was cut/);
  const comments = Array.from({ length: 100 }, (_, i) => mine(i + 1, 'noise'));
  const c = statsCli([...world.slice(0, 1), { match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: comments }], ['--json', '--pr', '7']);
  assert.match(c.json.warnings.join('\n'), /widgets#7: the comments were cut after 30 pages/);
});

// ---- round 2 review fixes ------------------------------------------------------------------------------------------

test('R2-F1 analysePr: the round before a past-limit round counts its NEW accepts only; a cached accept is not a fix to re-check', () => {
  const cached = (id, bucket = 'SUGGESTION', over = {}) => acc(id, bucket, { final: { decision: 'ACCEPT', by: 'cache' }, ...over });
  const prevOf = (items) => analysePr({ repo: 'acme/widgets', pr: 7, state: stateOf([round(1, items), round(2, [], { admission: 'auto-extra' })]), record: null }).rounds[1].previous;
  assert.equal(prevOf([cached('R1-S1')]), 'no-accepts', 'only a cached accept before: nothing new to re-check');
  assert.equal(prevOf([cached('R1-B1', 'BLOCKING')]), 'no-accepts', 'a cached BLOCKING accept is carried as implemented, not new');
  assert.equal(prevOf([cached('R1-S1'), acc('R1-S2')]), 'only-low-fixes', 'a new low accept next to a cached one');
  assert.equal(prevOf([cached('R1-S1'), acc('R1-B1', 'BLOCKING')]), 'blocking-or-security', 'a new BLOCKING accept next to a cached one');
  assert.equal(prevOf([acc('R1-S1')]), 'only-low-fixes');
});

const noteOf = (r) => r.json.warnings.join('\n');
const onlyComments = (extra) => [world[0], { match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: [mine(1, summaryBody(cost7)), mine(2, triageBody(state7)), ...extra] }];

test('R2-F2 stats rounds: a pipeline comment that is skipped says why in the warnings (other author, other PR or repository, unreadable); an ordinary comment says nothing', () => {
  const otherRepo = emptyRecord({ repo: 'acme/other', pr: 7, branch: 'feat/x', baseRef: 'main' });
  const cases = [
    ['a state by another author', [{ id: 3, user: { login: 'mallory' }, body: triageBody(state7) }], /widgets#7: ignored a review state comment by mallory: only the viewer's own comments count/],
    ['a record by another author', [{ id: 3, user: { login: 'mallory' }, body: summaryBody(cost7) }], /widgets#7: ignored a run record comment by mallory: only the viewer's own comments count/],
    ['a record of another repository', [mine(3, `${MARKERS.summary}\n\n${encodeRecord({ ...otherRepo, cost: cost7 })}`)], /widgets#7: ignored a run record bound to acme\/other#7: not this PR or repository/],
    ['a record of another PR', [mine(3, `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 8, branch: 'feat/x', baseRef: 'main' }), cost: cost7 })}`)], /widgets#7: ignored a run record bound to acme\/widgets#8: not this PR or repository/],
    ['a state of another PR', [mine(3, triageBody({ ...state7, pr: 8 }))], /widgets#7: ignored a review state bound to PR 8: not this PR/],
    ['a state with an unnumbered round', [mine(3, triageBody(stateOf([round('x', [])])))], /widgets#7: ignored a review state: unreadable/],
    ['a state that does not decode', [mine(3, `${MARKERS.triage}\n\nno state here`)], /widgets#7: ignored a review state: unreadable/],
    ['a record that does not decode', [mine(3, `${MARKERS.summary}\n\n<!-- claude-pipeline:record:AAAA -->`)], /widgets#7: ignored a run record: unreadable \(invalid\)/],
  ];
  for (const [what, extra, want] of cases) {
    const r = statsCli(onlyComments(extra), ['--json', '--pr', '7']);
    assertExit(r, 0, r.stderr + r.stdout);
    if (want) assert.match(noteOf(r), want, what);
    assert.equal(r.json.warnings.length, 1, `${what}: ${noteOf(r)}`);
  }
  const quiet = statsCli(onlyComments([mine(3, 'LGTM'), { id: 4, user: { login: 'mallory' }, body: 'a remark' }, mine(5, `> quoted\n${triageBody(state7)}`), mine(6, `${MARKERS.summary}\n\nan old summary without a record`)]), ['--json', '--pr', '7']);
  assert.deepEqual(quiet.json.warnings, [], 'comments that are not the pipeline\'s say nothing');
});

test('R2-F2 stats rounds: a hostile login or round number in a skipped comment stays one printable line in the warning', () => {
  const r = statsCli(onlyComments([{ id: 3, user: { login: 'mal\nlory\u001b[2J' }, body: triageBody(state7) }]), ['--pr', '7', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(/[\u001b\r]/.test(r.stdout), false);
  assert.match(r.stdout, /Warnings:\n- acme\/widgets#7: ignored a review state comment by mal/);
});

test('R2-F2 stats rounds: the plain-text table prints how many PRs had no review state', () => {
  const r = statsCli([...world, { match: '^api repos/acme/widgets/issues/22/comments', stdoutJson: [mine(1, 'hello')] }], ['--pr', '7', '--pr', '22']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PRs without a review state: 1/);
  const none = statsCli(world, ['--pr', '7']);
  assert.match(none.stdout, /PRs without a review state: 0/);
  const text = renderTable({ since: '2026-11-05', repos: ['acme/widgets'], totals: aggregate([]), prs: [], withoutState: 3 });
  assert.match(text, /PRs without a review state: 3/);
});
