// The pure classifier of `pipeline ci-usage` and of the `pushedWhileReady` warning of `pipeline summary` (lib/ci-usage.mjs): run classes, pushes while ready, wasted
// redrafts, base churn and the cost quantities. Fixture timelines, commits, runs and jobs; no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RATES, aggregateUsage, analysePrUsage, classifierVersion, classifyRuns, costOfJobs, headPushes, isCatchUpCommit, normalizeCommit,
  prPhaseAt, pushedWhileReady, renderUsageTable, runnerOs, wastedRedrafts,
} from '../pipeline/lib/ci-usage.mjs';
import { REVIEW_COMPLETE_MARKER } from '../pipeline/lib/review-marker.mjs';

// ---- fixtures: a PR opened as a draft at 09:00, ready 10:00, back to draft 11:00 (by "me"), ready again 12:00 ----
const T = (hhmm, sec = 0) => `2026-11-10T${hhmm}:${String(sec).padStart(2, '0')}Z`;
const PR_DRAFT = { createdAt: T('09:00'), draft: false };
const ev = (event, at, login = 'me') => ({ event, created_at: at, actor: { login } });
const TIMELINE = [ev('ready_for_review', T('10:00')), ev('converted_to_draft', T('11:00')), ev('ready_for_review', T('12:00'))];
const sha = (c) => c.repeat(40);
let nextId = 1;
const run = (head, created, over = {}) => ({
  id: nextId++, name: 'ci', path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head, run_attempt: 1, conclusion: 'success',
  created_at: created, run_started_at: created, updated_at: created, ...over,
});
// a run that lasted `min` minutes
const longRun = (head, created, min, over = {}) => {
  const end = new Date(Date.parse(created) + min * 60_000).toISOString();
  return run(head, created, { updated_at: end, ...over });
};
const job = (startedAt, minutes, labels = ['ubuntu-latest'], over = {}) => ({
  run_attempt: 1, conclusion: 'success', labels, started_at: startedAt, completed_at: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), ...over,
});
const commit = (c, over = {}) => ({ sha: sha(c), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work' }, ...over });

test('classifierVersion starts at 1', () => assert.equal(classifierVersion, 1));

test('prPhaseAt: opened as draft, toggled by the timeline; a PR opened ready; a PR with no events follows its flag', () => {
  const draftPr = { createdAt: T('09:00'), draft: false }; // now ready (it was ready at 12:00)
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('09:30')), 'draft', 'the first event is ready_for_review, so it was opened as a draft');
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('10:00')), 'ready');
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('11:30')), 'draft');
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('12:00', 1)), 'ready');
  const openedReady = [ev('converted_to_draft', T('11:00'))];
  assert.equal(prPhaseAt(openedReady, { createdAt: T('09:00'), draft: true }, T('10:00')), 'ready', 'the first event is converted_to_draft, so it was opened ready');
  assert.equal(prPhaseAt([], { createdAt: T('09:00'), draft: true }, T('10:00')), 'draft');
  assert.equal(prPhaseAt([], { createdAt: T('09:00'), draft: false }, T('10:00')), 'ready');
});

test('isCatchUpCommit: a web-flow 2-parent commit, or GitHub\'s update-branch message; not a one-parent or an unrelated merge', () => {
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'web-flow' }, commit: { message: 'anything' } }), true);
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'me' }, commit: { message: "Merge branch 'main' into agent/feat\n\nbody" } }), true);
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}], committer: { login: 'web-flow' }, commit: { message: "Merge branch 'main' into x" } }), false, 'one parent is not a merge');
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'me' }, commit: { message: 'Merge pull request #3 from x/y' } }), false);
  assert.deepEqual(normalizeCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'web-flow' }, commit: { message: 'm' } }), { sha: 'a', parents: 2, committer: 'web-flow', message: 'm' });
  assert.equal(isCatchUpCommit({ sha: 'a', parents: 2, committer: 'web-flow', message: 'm' }), true, 'an already normalised commit works too');
});

test('classifyRuns: every class, one per run, and non-PR runs by event', () => {
  const caught = sha('c');
  const commits = [commit('a'), { ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } }];
  const runs = [
    run(sha('1'), T('09:30')), // pushed while the PR was a draft
    run(sha('2'), T('10:01')), // 60 s after ready_for_review
    run(sha('3'), T('10:30')), // pushed while ready
    longRun(sha('3'), T('11:00', 20), 0.5, { conclusion: 'cancelled' }), // cancelled 50 s after converted_to_draft (updated_at = 11:00:50)
    run(sha('4'), T('10:40'), { run_attempt: 2 }),
    run(caught, T('10:50')),
    run(sha('5'), T('10:20'), { event: 'push' }),
    run(sha('5'), T('10:20'), { event: 'schedule' }),
  ];
  const rows = classifyRuns({ pr: PR_DRAFT, timeline: TIMELINE, commits, runs });
  assert.deepEqual(rows.map((r) => r.class), ['push-while-draft', 'ready-for-review', 'push-while-ready', 'converted-cancel', 'rerun', 'catch-up', 'other', 'other']);
  assert.deepEqual(rows.filter((r) => r.class === 'other').map((r) => r.event), ['push', 'schedule']);
  // a run 3 minutes after ready_for_review is no longer "the ready run"
  assert.equal(classifyRuns({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('9'), T('10:03'))] })[0].class, 'push-while-ready');
  // a PR whose timeline could not be read
  assert.equal(classifyRuns({ pr: null, timeline: null, runs: [run(sha('9'), T('10:03'))] })[0].class, 'unclassified');
});

test('pushedWhileReady: three workflows on one pushed head count once; the opening head, a catch-up head and a re-run are excluded', () => {
  const opening = sha('0');
  const pushed = sha('3');
  const caught = sha('c');
  const draftHead = sha('1');
  const commits = [{ ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } }];
  const runs = [
    run(opening, T('09:00', 20)), // the PR opened with this head (a draft: not ready anyway), within 120 s of creation
    run(draftHead, T('09:30')),
    run(draftHead, T('10:00', 30), { id: 900 }), // the ready_for_review run of a head pushed in draft: not a push
    run(pushed, T('10:30', 10)), run(pushed, T('10:30', 11), { name: 'guards' }), run(pushed, T('10:30', 12), { name: 'e2e' }), // one push, three workflows
    run(caught, T('10:45')), // catch-up while ready
    // a head pushed in draft whose run was re-run (attempt 2) while the PR was ready: created_at is the original, so it is not "new"
    run(sha('r'), T('11:30'), { run_attempt: 2, run_started_at: T('12:10'), updated_at: T('12:20') }),
  ];
  const r = pushedWhileReady({ pr: PR_DRAFT, timeline: TIMELINE, commits, runs });
  assert.equal(r.count, 1);
  assert.deepEqual(r.heads.map((h) => h.sha), [pushed]);
  // a PR opened READY: its opening head is still no push
  const ready = pushedWhileReady({ pr: { createdAt: T('09:00'), draft: false }, timeline: [], commits: [], runs: [run(sha('o'), T('09:00', 30)), run(sha('p'), T('09:30'))] });
  assert.deepEqual(ready.heads.map((h) => h.sha), [sha('p')]);
  assert.equal(pushedWhileReady({ pr: PR_DRAFT, timeline: TIMELINE, runs: [] }).count, 0);
});

test('headPushes: a head whose first run is the ready_for_review one is not a push (workflows that skip drafts leave no earlier run)', () => {
  const rows = headPushes({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('1'), T('10:00', 30))] });
  assert.deepEqual(rows.map((h) => [h.kind, h.phase]), [['ready-run', 'ready']]);
});

test('wastedRedrafts: draft then ready with no new head in between; a push in between or someone else\'s redraft does not count', () => {
  const none = wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('1'), T('09:30')), run(sha('2'), T('10:30'))], viewer: 'me' });
  assert.equal(none, 1, '11:00 draft -> 12:00 ready: no head created in between');
  const pushed = wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('1'), T('09:30')), run(sha('2'), T('11:30'))], viewer: 'me' });
  assert.equal(pushed, 0, 'a head was pushed while the PR was a draft');
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [], viewer: 'someone-else' }), 0, 'the viewer did not convert it');
  const forced = [...TIMELINE, { event: 'head_ref_force_pushed', created_at: T('11:30') }];
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: forced, commits: [], runs: [], viewer: 'me' }), 0, 'a force push is a new head');
  const committed = [...TIMELINE, { event: 'committed', sha: sha('9'), committer: { date: T('11:20') } }];
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: committed, commits: [], runs: [], viewer: 'me' }), 0, 'a commit made in between is a new head');
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE.slice(0, 2), commits: [], runs: [], viewer: 'me' }), 0, 'still a draft: nothing wasted yet');
});

test('base churn: a heavy run on a catch-up head after the last review-complete marker is a final catch-up rerun; the ready-for-review suite is not churn', () => {
  const caught = sha('c');
  const commits = [{ ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } }];
  const marker = `${REVIEW_COMPLETE_MARKER}\nReviewed.\n\`\`\`json\n${JSON.stringify({ contentHash: 'a'.repeat(64), base: 'b'.repeat(40), head: 'd'.repeat(40), rounds: 2, codexModel: 'gpt', modelProofDigest: null })}\n\`\`\``;
  const comments = [{ body: 'hello', created_at: T('08:00') }, { body: marker, created_at: T('13:00') }];
  const runs = [
    longRun(caught, T('12:00', 30), 5), // the ready_for_review suite, on a catch-up head: intended
    longRun(caught, T('13:30'), 6, { id: 777 }), // after the marker: a final catch-up rerun
    longRun(caught, T('12:30'), 3, { id: 778 }), // before the marker: churn only
  ];
  const jobsByRun = new Map(runs.map((r) => [r.id, [job(r.run_started_at, (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60_000)]]));
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits, comments, runs, jobsByRun, viewer: 'me' });
  assert.equal(p.heavyRuns, 3);
  assert.equal(p.churnRuns, 2);
  assert.equal(p.churnMinutes, 9);
  assert.equal(p.finalCatchupReruns, 1);
  assert.equal(p.catchups, 1);
  // without the comments read the final count is unknown, not 0
  assert.equal(analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits, comments: null, runs, jobsByRun }).finalCatchupReruns, null);
  const agg = aggregateUsage({ classified: p.classified, prRows: [p], isPrivate: true });
  assert.deepEqual([agg.totals.churnRuns, agg.totals.churnMinutes, agg.totals.finalCatchupReruns, agg.totals.catchupsPerPr], [2, 9, 1, 1]);
});

test('costOfJobs: three parallel shards plus one job are summed; an attempt-2 job counts on its own; the OS split puts self-hosted at 0 USD; each job rounds up', () => {
  const t0 = T('10:00');
  const jobs = [
    job(t0, 4.2), job(t0, 4.2), job(t0, 4.2), job(t0, 1), // 3 shards + 1 job on ubuntu
    job(t0, 2, ['windows-latest']),
    job(t0, 1.5, ['macos-14']),
    job(t0, 10, ['self-hosted', 'linux']),
    job(t0, 3, ['ubicloud-standard-2']),
    job(t0, 2, ['ubuntu-latest'], { run_attempt: 2 }), // the re-run's job
    job(t0, 0, ['ubuntu-latest'], { conclusion: 'skipped' }),
    { run_attempt: 1, labels: ['ubuntu-latest'], started_at: t0, completed_at: null }, // never finished
  ];
  const c = costOfJobs(jobs, DEFAULT_RATES);
  assert.deepEqual([c.minutes.windows, c.minutes.macos], [2, 1.5]);
  assert.equal(Math.round(c.minutes.linux * 100) / 100, 15.6);
  assert.equal(c.minutes['self-hosted'], 13);
  assert.equal(c.rerunMinutes, 2);
  // 3 x ceil(4.2)=5 + 1 + ceil(2)=2 on linux; 2 on windows; ceil(1.5)=2 on macos
  assert.equal(Math.round(c.usd * 1e6) / 1e6, Math.round((18 * 0.008 + 2 * 0.016 + 2 * 0.08) * 1e6) / 1e6);
  assert.deepEqual(['ubuntu-22.04', 'windows-2022', 'macos-latest', 'self-hosted', 'ubicloud-standard-4', 'custom-box'].map((l) => runnerOs([l])), ['linux', 'windows', 'macos', 'self-hosted', 'self-hosted', 'self-hosted']);
  assert.equal(runnerOs(['self-hosted', 'linux', 'x64']), 'self-hosted');
  assert.equal(costOfJobs(jobs, { ...DEFAULT_RATES, linux: 0.01 }).usd > c.usd, true, 'a rate override is used');
});

test('aggregateUsage: private estimate with coverage and assumptions; public is free; jobs not read lower the coverage; byClass/byEvent; missed redrafts by the flag', () => {
  const runs = [
    longRun(sha('3'), T('10:30'), 10), // read
    longRun(sha('4'), T('10:40'), 8), // jobs NOT read: heavy by elapsed
    run(sha('5'), T('10:20'), { event: 'push', updated_at: T('10:25') }),
    run(sha('6'), T('10:20'), { event: 'schedule' }), // tiny: not heavy
  ];
  const jobsByRun = new Map([[runs[0].id, [job(runs[0].run_started_at, 6), job(runs[0].run_started_at, 3.5, ['macos-latest'])]], [runs[2].id, [job(runs[2].run_started_at, 5)]]]);
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: runs.slice(0, 2), jobsByRun, viewer: 'me' });
  const classified = [...p.classified, ...classifyRuns({ runs: runs.slice(2), jobsByRun })];
  const priv = aggregateUsage({ classified, prRows: [p], isPrivate: true, draftWhileIterating: true });
  assert.equal(priv.billing, 'estimate-private');
  assert.equal(priv.totals.heavyRuns, 3);
  assert.equal(priv.totals.coverage, 67, '2 of the 3 heavy runs had their jobs read');
  assert.equal(priv.totals.estimatedUsd, Math.round((6 * 0.008 + 4 * 0.08 + 5 * 0.008) * 1e4) / 1e4);
  assert.equal(priv.totals.workflowElapsedMin, 10 + 8 + 5, 'measured elapsed is a separate quantity');
  assert.equal(priv.totals.jobMinutes.linux, 11);
  assert.equal(priv.totals.jobMinutes.macos, 3.5);
  assert.deepEqual([priv.totals.byClass.other.runs, priv.totals.byClass.other.heavyRuns], [2, 1]);
  assert.deepEqual([priv.totals.byEvent.push.heavyRuns, priv.totals.byEvent.schedule.heavyRuns], [1, 0]);
  assert.equal(priv.assumptions.rates['self-hosted'], 0);
  assert.equal(priv.assumptions.rates.linux, 0.008);
  assert.equal(priv.totals.pushesWhileReady, 2, 'both PR runs are on heads pushed while ready');
  assert.equal(priv.totals.missedRedrafts, 2, 'the flag is true: a push while ready is a missed redraft');
  assert.equal(aggregateUsage({ classified, prRows: [p], isPrivate: true, draftWhileIterating: false }).totals.missedRedrafts, 0);
  assert.equal(aggregateUsage({ classified, prRows: [p], isPrivate: true, draftWhileIterating: 'unknown' }).totals.missedRedrafts, null);
  const pub = aggregateUsage({ classified, prRows: [p], isPrivate: false });
  assert.deepEqual([pub.billing, pub.totals.estimatedUsd], ['free-public', 0]);
  // self-hosted jobs cost nothing
  const sh = analysePrUsage({ number: 8, pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [runs[0]], jobsByRun: new Map([[runs[0].id, [job(runs[0].run_started_at, 9, ['self-hosted'])]]]) });
  assert.equal(aggregateUsage({ classified: sh.classified, prRows: [sh], isPrivate: true }).totals.estimatedUsd, 0);
  assert.equal(aggregateUsage({ classified: sh.classified, prRows: [sh], isPrivate: true }).totals.jobMinutes['self-hosted'], 9);
});

test('renderUsageTable: prints the PRs, the classes, the cost lines and the unexcludable note', () => {
  const runs = [longRun(sha('3'), T('10:30'), 10)];
  const jobsByRun = new Map([[runs[0].id, [job(runs[0].run_started_at, 6)]]]);
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs, jobsByRun, viewer: 'me' });
  const agg = aggregateUsage({ classified: p.classified, prRows: [p], isPrivate: true, draftWhileIterating: true });
  const { classified, ...row } = p;
  const text = renderUsageTable({ since: '2026-11-06', repos: [{ slug: 'acme/widgets', private: true, classifierVersion, partial: false, draftWhileIterating: true, prs: [row], calls: 5, rateLimit: { remaining: 4000 }, skipped: {}, unexcludable: ['a note'], ...agg }] });
  assert.match(text, /CI usage since 2026-11-06 in acme\/widgets \(private; classifier v1\)/);
  assert.match(text, /#7 +2 +1 +0 +1 +/);
  assert.match(text, /push-while-ready +1 +1 +10\.0 +linux 6\.0/);
  assert.match(text, /Estimated cost \$0\.05 \(an estimate, not a bill/);
  assert.match(text, /Pushed while ready 1 · missed redrafts 1/);
  assert.match(text, /Note: a note/);
  assert.doesNotMatch(text, /[\u001b\r]/);
});
