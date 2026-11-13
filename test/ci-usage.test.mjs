// `pipeline ci-usage` end to end against a scripted fake gh (the same way test/stats-rounds.test.mjs drives `stats rounds`), and the call budget in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { REVIEW_COMPLETE_MARKER } from '../pipeline/lib/review-marker.mjs';
import { makeBudget } from '../pipeline/lib/ci-usage-read.mjs';
import { parseRates, parseSince } from '../pipeline/commands/ci-usage.mjs';
import { pages, MAX_PAGES } from '../pipeline/lib/gh-pages.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const T = (hhmm, sec = 0) => `2026-11-10T${hhmm}:${String(sec).padStart(2, '0')}Z`;
const sha = (c) => c.repeat(40);
const plus = (at, min) => new Date(Date.parse(at) + min * 60_000).toISOString();
const ev = (event, at, login = 'me') => ({ event, created_at: at, actor: { login } });
const b64 = (text) => ({ content: Buffer.from(text).toString('base64'), encoding: 'base64' });
const PIPELINE_YML = (flag) => `version: 1\nproject: demo\nenforcement: github\nverify:\n  full: npm run verify\n  quick: npm run verify:quick\nci:\n  required_checks: [ci]\n  draft_while_iterating: ${flag}\n`;

// one PR (#7): opened as a draft 09:00, ready 10:00, back to draft 11:00 (by me), ready again 12:00
const PR7 = { number: 7, created_at: T('09:00'), draft: false };
const TIMELINE7 = [ev('ready_for_review', T('10:00')), ev('converted_to_draft', T('11:00')), ev('ready_for_review', T('12:00'))];
const COMMITS7 = [
  { sha: sha('1'), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work' } },
  { sha: sha('c'), parents: [{ sha: 'p' }, { sha: 'q' }], committer: { login: 'web-flow' }, commit: { message: "Merge branch 'main' into agent/x" } },
];
const run = (id, over) => ({
  id, name: 'ci', path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: sha('3'), run_attempt: 1, conclusion: 'success', head_branch: 'agent/x',
  pull_requests: [{ number: 7 }], created_at: T('10:30'), run_started_at: T('10:30'), updated_at: plus(T('10:30'), 10), ...over,
});
const job = (startedAt, minutes, labels = ['ubuntu-latest'], over = {}) => ({ run_attempt: 1, conclusion: 'success', labels, started_at: startedAt, completed_at: plus(startedAt, minutes), ...over });
const RUNS = [
  run(1001, { head_sha: sha('1'), created_at: T('09:30'), run_started_at: T('09:30'), updated_at: plus(T('09:30'), 0.5) }), // a draft-era push: light
  run(1002, { head_sha: sha('2'), created_at: T('12:00', 30), run_started_at: T('12:00', 30), updated_at: plus(T('12:00', 30), 12) }), // the ready_for_review suite
  run(1003, {}), // pushed while ready
  run(1004, { name: 'guards', path: '.github/workflows/guards.yml', created_at: T('10:30', 2), run_started_at: T('10:30', 2), updated_at: plus(T('10:30', 2), 2) }), // same push, second workflow
  run(1005, { head_sha: sha('c'), created_at: T('12:30'), run_started_at: T('12:30'), updated_at: plus(T('12:30'), 6) }), // a catch-up head
  run(1006, { event: 'schedule', pull_requests: [], head_sha: sha('m'), created_at: T('08:00'), run_started_at: T('08:00'), updated_at: plus(T('08:00'), 2) }),
];
const JOBS = {
  1002: [job(T('12:00', 30), 4), job(T('12:00', 30), 4), job(T('12:00', 30), 4), job(T('12:00', 30), 1)],
  1003: [job(T('10:30'), 6), job(T('10:30'), 3.5, ['macos-latest'])],
  1004: [job(T('10:30', 2), 2, ['windows-latest'])],
  1005: [job(T('12:30'), 6)],
  1006: [job(T('08:00'), 2, ['self-hosted'])],
};
const rateLimit = (remaining) => ({ match: '^api rate_limit', stdoutJson: { resources: { core: { remaining, limit: 5000, reset: 1 } } } });
const world = ({ priv = true, flag = true, runs = RUNS, remaining = 4000, extra = [] } = {}) => [
  ...extra,
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^api user', stdout: 'me\n' },
  rateLimit(remaining),
  { match: '^api repos/acme/widgets$', stdoutJson: { private: priv } },
  flag === null ? { match: '^api repos/acme/widgets/contents/', code: 1, stderr: 'gh: Not Found (HTTP 404)' } : { match: '^api repos/acme/widgets/contents/', stdoutJson: b64(PIPELINE_YML(flag)) },
  { match: '^api repos/acme/widgets/actions/runs\\?created', stdoutJson: { total_count: runs.length, workflow_runs: runs } },
  ...Object.entries(JOBS).map(([id, jobs]) => ({ match: `^api repos/acme/widgets/actions/runs/${id}/jobs`, stdoutJson: { total_count: jobs.length, jobs } })),
  { match: '^api repos/acme/widgets/pulls/7/commits', stdoutJson: COMMITS7 },
  { match: '^api repos/acme/widgets/pulls/7\\b', stdoutJson: PR7 },
  { match: '^api repos/acme/widgets/issues/7/timeline', stdoutJson: TIMELINE7 },
  { match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: [] },
  { match: '^api repos/acme/widgets/pulls\\?state=all', stdoutJson: [{ number: 7, created_at: T('09:00'), updated_at: T('13:00'), head: { ref: 'agent/x' } }] },
];

function usage(entries, args) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.commit('init');
  const fake = createFakeGh(entries);
  const env = { ...process.env, ...fake.env };
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, 'ci-usage', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text mode */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, fake };
}
const round4 = (v) => Math.round(v * 1e4) / 1e4;

test('ci-usage --json: classes, pushes while ready, wasted redrafts, churn and the cost quantities of a private repository', () => {
  const r = usage(world(), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.classifierVersion, 1);
  assert.equal(r.json.since, '2026-11-05T00:00:00Z');
  const [repo] = r.json.repos;
  assert.deepEqual([repo.slug, repo.private, repo.billing, repo.draftWhileIterating, repo.partial], ['acme/widgets', true, 'estimate-private', true, false]);
  const t = repo.totals;
  // 1001 is light (30 s); 1002..1006 are heavy
  assert.equal(t.heavyRuns, 5);
  assert.equal(t.coverage, 100);
  assert.deepEqual([t.pushesWhileReady, t.missedRedrafts, t.wastedRedrafts], [1, 1, 1]);
  assert.deepEqual(Object.fromEntries(Object.entries(t.byClass).map(([k, v]) => [k, v.runs])), { 'push-while-draft': 1, 'ready-for-review': 1, 'push-while-ready': 2, 'catch-up': 1, other: 1 });
  assert.equal(t.byEvent.schedule.heavyRuns, 1);
  assert.equal(t.workflowElapsedMin, 12 + 10 + 2 + 6 + 2);
  assert.deepEqual(t.jobMinutes, { linux: 13 + 6 + 6, windows: 2, macos: 3.5, 'self-hosted': 2 });
  assert.equal(t.estimatedUsd, round4((13 * 0.008) + (6 * 0.008) + (2 * 0.016) + (4 * 0.08) + (6 * 0.008)), 'ceil per job: 4 min of macOS for the 3.5 min job');
  assert.deepEqual([t.churnRuns, t.churnMinutes, t.finalCatchupReruns, t.catchupsPerPr], [1, 6, 0, 1]);
  const p = repo.prs.find((x) => x.pr === 7);
  assert.deepEqual([p.readyCycles, p.pushesWhileReady, p.pushedHeads, p.pushesWhileDraft, p.wastedRedrafts, p.catchups, p.heavyRuns], [2, 1, [sha('3').slice(0, 12)], 1, 1, 1, 4]);
  assert.match(repo.unexcludable.join('\n'), /convert-failed/);
  assert.equal(r.json.warnings.length, 0, r.json.warnings.join('\n'));
  // the runs list asks for runs created since the date
  assert.ok(r.fake.lines().some((l) => l.includes('actions/runs?created=%3E%3D2026-11-05T00%3A00%3A00Z')), r.fake.lines().join('\n'));
  assert.ok(r.fake.lines().some((l) => l.includes('actions/runs/1002/jobs?filter=all')));
});

test('ci-usage: a public repository is free (usd 0, billing free-public) but the job minutes are still counted', () => {
  const r = usage(world({ priv: false }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  assert.deepEqual([repo.billing, repo.totals.estimatedUsd, repo.totals.jobMinutes.linux], ['free-public', 0, 25]);
});

test('ci-usage: ci.draft_while_iterating false => no missed redrafts; unreadable pipeline.yml => unknown (null), the pushes while ready are still counted', () => {
  const off = usage(world({ flag: false }), ['--json', '--since', '2026-11-05']).json.repos[0];
  assert.deepEqual([off.draftWhileIterating, off.totals.pushesWhileReady, off.totals.missedRedrafts], [false, 1, 0]);
  const r = usage(world({ flag: null }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const unknown = r.json.repos[0];
  assert.deepEqual([unknown.draftWhileIterating, unknown.totals.pushesWhileReady, unknown.totals.missedRedrafts], ['unknown', 1, null]);
  assert.match(r.json.warnings.join('\n'), /acme\/widgets: \.claude\/pipeline\.yml could not be read/);
});

test('ci-usage: --rate overrides the estimate; a bad rate or os is a usage error', () => {
  const base = usage(world(), ['--json', '--since', '2026-11-05']).json.repos[0];
  const doubled = usage(world(), ['--json', '--since', '2026-11-05', '--rate', 'linux=0.016']).json.repos[0];
  assert.equal(doubled.assumptions.rates.linux, 0.016);
  assert.ok(doubled.totals.estimatedUsd > base.totals.estimatedUsd);
  assert.equal(doubled.assumptions.rates['self-hosted'], 0);
  for (const bad of ['linux', 'linux=abc', 'solaris=1', 'linux=-1']) assertExit(usage(world(), ['--json', '--rate', bad]), 2, bad);
  assert.deepEqual(parseRates(['macos=0.1']), { linux: 0.008, windows: 0.016, macos: 0.1 });
});

test('ci-usage --since: YYYY-MM-DD, Nd and invalid values (exit 2)', () => {
  const day = usage(world(), ['--json', '--since', '2026-11-05']);
  assert.equal(day.json.since, '2026-11-05T00:00:00Z');
  const thirty = usage(world(), ['--json', '--since', '30d']);
  assertExit(thirty, 0, thirty.stderr);
  const asked = Date.parse(thirty.json.since);
  assert.ok(Math.abs(Date.now() - 30 * 86_400_000 - asked) < 60_000, thirty.json.since);
  assertExit(usage(world(), ['--json']), 0, 'default 7d');
  for (const bad of ['yesterday', '2026-02-31', '2026-13-01', '0d', '-3d', '7', '7days', '']) assertExit(usage(world(), ['--json', '--since', bad]), 2, `--since ${bad}`);
  assert.equal(parseSince('2d', Date.UTC(2026, 10, 13)), Date.UTC(2026, 10, 11));
});

test('ci-usage: --max-calls reached => partial with skipped counts and a coverage below 100; the jobs of the biggest runs are read first', () => {
  const r = usage(world(), ['--json', '--since', '2026-11-05', '--max-calls', '10']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.equal(repo.partial, true);
  assert.ok(repo.calls <= 10, `calls ${repo.calls}`);
  assert.ok(repo.skipped.jobs > 0, JSON.stringify(repo.skipped));
  assert.ok(repo.totals.coverage < 100 && repo.totals.coverage > 0, `coverage ${repo.totals.coverage}`);
  assert.match(r.json.warnings.join('\n'), /--max-calls 10 reached: the report is partial/);
  assert.match(r.json.warnings.join('\n'), /had their jobs unread/);
  // the biggest run (1002, 12 min) got its jobs; the smallest candidate (1004, 2 min) did not
  const lines = r.fake.lines();
  assert.ok(lines.some((l) => l.includes('runs/1002/jobs')));
  assert.equal(lines.filter((l) => /runs\/\d+\/jobs/.test(l)).length, 4, 'the budget allowed four job reads');
  assert.equal(repo.skipped.jobs, 1);
  // the estimate only prices the jobs that were read
  assert.ok(repo.totals.estimatedUsd > 0);
});

test('ci-usage: a low rate limit (< 1000 left) stops the reading after the first list: partial, skipped counts, exit 0', () => {
  const r = usage(world({ remaining: 500 }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.equal(repo.partial, true);
  assert.equal(repo.rateLimit.remaining, 500);
  assert.equal(repo.calls, 3, 'repository, pipeline.yml and the runs list only');
  assert.deepEqual([repo.skipped.prs, repo.skipped.jobs], [1, 5]);
  assert.equal(repo.totals.coverage, 100 * 0, 'no jobs read');
  assert.match(r.json.warnings.join('\n'), /the rate limit is low \(500 calls left/);
  assert.equal(repo.totals.byClass.unclassified.runs, 5, 'the PR runs of the unread PR');
});

test('ci-usage: the budget re-reads the rate limit every 50 calls and stops below 1000 (in-process)', () => {
  let reads = 0;
  const gh = { api: () => { reads += 1; return { resources: { core: { remaining: reads === 1 ? 5000 : 900 } } }; } };
  const warnings = [];
  const b = makeBudget(gh, { maxCalls: 400, warnings, label: 'x' });
  for (let i = 0; i < 49; i += 1) b.tick();
  assert.equal(reads, 1, 'only the first read so far');
  b.tick(); // the 50th call: the rate limit is read again
  assert.equal(reads, 2);
  assert.throws(() => b.tick(), b.stop);
  assert.equal(b.reason, 'rate-limit');
  assert.equal(b.calls, 50);
});

test('ci-usage: a run list cut by the page limit is a warning (and pages() reports the cut once)', () => {
  const light = Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, name: 'ci', event: 'push', head_sha: sha('a'), run_attempt: 1, created_at: T('10:00'), run_started_at: T('10:00'), updated_at: T('10:00', 5) }));
  const r = usage(world({ runs: light }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(r.json.warnings.join('\n'), new RegExp(`acme/widgets: the list of workflow runs was cut after ${MAX_PAGES} pages`));
  let cuts = 0;
  const out = pages({ api: () => Array.from({ length: 100 }, () => ({})) }, 'repos/x/y/z', undefined, () => { cuts += 1; });
  assert.deepEqual([out.length, cuts], [MAX_PAGES * 100, 1]);
});

test('ci-usage: --workflow keeps only the runs of that workflow (by name, path or file name)', () => {
  for (const name of ['guards', '.github/workflows/guards.yml', 'guards.yml']) {
    const r = usage(world(), ['--json', '--since', '2026-11-05', '--workflow', name]);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.repos[0].runsRead, 1, name);
  }
});

test('ci-usage: a run without a PR link finds its PR through the branch', () => {
  const unlinked = RUNS.map((x) => ({ ...x, pull_requests: [] }));
  const r = usage(world({ runs: unlinked }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.repos[0].totals.pushesWhileReady, 1);
  assert.ok(r.fake.lines().some((l) => l.includes('pulls?state=all')));
});

test('ci-usage: without --json it prints a plain-text table with the warnings; GitHub unreachable for the first list is exit 3', () => {
  const r = usage(world({ flag: null }), ['--since', '2026-11-05']);
  assertExit(r, 0, r.stderr);
  assert.equal(r.json, null);
  assert.match(r.stdout, /CI usage since 2026-11-05T00:00:00Z in acme\/widgets \(private; classifier v1\)/);
  assert.match(r.stdout, /#7 +2 +1 +1 +1 +1 +4 /);
  assert.match(r.stdout, /Pushed while ready 1 · missed redrafts unknown/);
  assert.match(r.stdout, /Warnings:\n- acme\/widgets: \.claude\/pipeline\.yml could not be read/);
  assert.match(r.stdout, /convert-failed/);
  const down = usage(world().map((e) => (e.match.includes('actions/runs\\?created') ? { match: e.match, code: 1, stderr: 'gh: HTTP 502' } : e)), ['--json', '--since', '2026-11-05']);
  assertExit(down, 3, down.stderr + down.stdout);
});

test('ci-usage: a bad --repo-slug or --max-calls is a usage error', () => {
  assertExit(usage(world(), ['--json', '--repo-slug', 'nope']), 2);
  assertExit(usage(world(), ['--json', '--max-calls', '0']), 2);
  assertExit(usage(world(), ['--json', '--bogus']), 2);
});

test('ci-usage: the review-complete marker is read only for a PR with a heavy catch-up run, and a catch-up suite after it is a final catch-up rerun', () => {
  const marker = `${REVIEW_COMPLETE_MARKER}\nReviewed.\n\`\`\`json\n${JSON.stringify({ contentHash: 'a'.repeat(64), base: 'b'.repeat(40), head: 'd'.repeat(40), rounds: 2, codexModel: 'gpt', modelProofDigest: null })}\n\`\`\``;
  const withMarker = [{ match: '^api repos/acme/widgets/issues/7/comments', stdoutJson: [{ id: 1, body: marker, created_at: T('12:10') }] }];
  const r = usage(world({ extra: withMarker }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.repos[0].totals.churnRuns, r.json.repos[0].totals.finalCatchupReruns], [1, 1]);
  assert.ok(r.fake.lines().some((l) => l.includes('issues/7/comments')));
  // no heavy run on a catch-up head: the comments are never read
  const quiet = usage(world({ runs: RUNS.filter((x) => x.id !== 1005) }), ['--json', '--since', '2026-11-05']);
  assert.ok(!quiet.fake.lines().some((l) => l.includes('/comments')));
  assert.equal(quiet.json.repos[0].totals.finalCatchupReruns, 0);
});
