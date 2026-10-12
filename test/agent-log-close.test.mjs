// `pipeline agent-log close`: the pure part (markers, authors, shas, newest-by-observed, PHT dating, dedupe, the repo-wide scan
// and which PRs are read on their own) against an injected gh, and the CLI (dry run, --queue + stage, --pr/--all, unreadable PR,
// GitHub unavailable) against the scripted fake gh. Every age-sensitive pure test passes an explicit `now`: no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, AGENT_LOG, REPO, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { DEFAULT_OUTCOME } from '../pipeline/lib/agentlog.mjs';
import {
  BOT_AUTHOR, RESOLVED_SKIP_DAYS, closeLines, formatPht, parseLog, parsePht, parseResultMarkers, prFromIssueUrl, resolutionLine, scanSince,
} from '../pipeline/lib/agentlog-close.mjs';

const MERGE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const HOST = 'ewiapp-abc-team.vercel.app';
const pendingLine = (n) => `- 2026-10-09 · #${n} · fix(x): something · risk low · rounds 1 · arbiter 0 · ${DEFAULT_OUTCOME}`;
const resolved = (n, { date = '2026-10-12', outcome = 'passed', host = HOST, obs = '2026-10-12 12:05', run = '999' } = {}) =>
  `- ${date} · #${n} · prod smoke ${outcome} · deploy ${host} · observed ${obs} · run ${run}`;

function marker(o = {}) {
  const f = {
    sha: MERGE_SHA, deployment: '111', status: '1110', vercel: HOST, outcome: 'passed', observed: '2026-10-12T04:05:00Z', run: '999', ...o,
  };
  return `<!-- prod-smoke-result v=1 ${['sha', 'deployment', 'status', 'vercel', 'outcome', 'observed', 'run'].map((k) => `${k}=${f[k]}`).join(' ')} -->`;
}
const comment = (body, login = BOT_AUTHOR) => ({ user: { login }, body });

const issueUrl = (n) => `https://api.github.com/repos/acme/widgets/issues/${n}`;

// `scan` is what the repo-wide read returns (PR -> comments); by default it is every comment, like a window that covers them all.
function fakeGh(comments, shas = {}, { scan = comments } = {}) {
  const calls = { comments: [], sha: [], repo: [] };
  return {
    calls,
    mergeSha: async (n) => { calls.sha.push(n); return n in shas ? shas[n] : MERGE_SHA; },
    listComments: async (n) => { calls.comments.push(n); return comments[n] ?? []; },
    listRepoComments: async (since) => {
      calls.repo.push(since);
      return Object.entries(scan).flatMap(([n, list]) => list.map((c) => ({ ...c, issue_url: issueUrl(n) })));
    },
  };
}
const DAY = 24 * 3600 * 1000;

// ---- pure ----------------------------------------------------------------------------------------

test('PHT: a late-UTC instant rolls onto the next PHT day (2026-10-12T16:30Z -> 2026-10-13 00:30), hours zero-padded', () => {
  assert.deepEqual(formatPht(Date.parse('2026-10-12T16:30:00Z')), { date: '2026-10-13', time: '00:30' });
  assert.deepEqual(formatPht(Date.parse('2026-10-12T15:59:59Z')), { date: '2026-10-12', time: '23:59' });
  assert.deepEqual(formatPht(Date.parse('2026-10-12T16:00:00Z')), { date: '2026-10-13', time: '00:00' });
  assert.equal(parsePht('2026-10-13', '00:30'), Date.parse('2026-10-12T16:30:00Z'));
});

test('resolution line has the exact shape, dated by the PHT day of observed', () => {
  const line = resolutionLine({ pr: '1436', result: { outcome: 'passed', vercel: HOST, observed: '2026-10-12T16:30:00Z', run: '999' } });
  assert.equal(line, `- 2026-10-13 · #1436 · prod smoke passed · deploy ${HOST} · observed 2026-10-13 00:30 · run 999`);
});

test('parseResultMarkers is strict: unknown key, duplicate key, missing key and bad values are skipped', () => {
  assert.equal(parseResultMarkers(marker()).length, 1);
  assert.equal(parseResultMarkers(marker().replace(' -->', ' extra=1 -->')).length, 0);
  assert.equal(parseResultMarkers(marker().replace(' -->', ' run=1 -->')).length, 0);
  assert.equal(parseResultMarkers(marker().replace(' run=999', '')).length, 0);
  for (const bad of [{ sha: 'abc' }, { outcome: 'great' }, { observed: 'yesterday' }, { vercel: 'Not A Host' }, { run: 'x' }]) {
    assert.equal(parseResultMarkers(marker(bad)).length, 0, JSON.stringify(bad));
  }
  assert.equal(parseResultMarkers(`${marker({ run: '1' })}\ntext\n${marker({ run: '2' })}`).length, 2);
});

test('parseLog: finds pending PRs (unique, file order), ignores other lines, reads resolutions per PR', () => {
  const text = ['# Agent log', '', pendingLine(1420), '- 2026-10-09 · #1411 · feat · risk high · rounds 1 · arbiter 0 · needs-human', pendingLine(1430), pendingLine(1420), resolved(1420), ''].join('\n');
  const p = parseLog(text);
  assert.deepEqual(p.pending, ['1420', '1430']);
  assert.deepEqual(p.resolutions.get('1420'), [{ outcome: 'passed', host: HOST, observed: '2026-10-12 12:05', run: '999', at: parsePht('2026-10-12', '12:05') }]);
  assert.deepEqual(parseLog(pendingLine(7).replace(/\n/g, '\r\n') + '\r\n').pending, ['7'], 'CRLF logs (Windows) are read too');
});

test('closeLines: one line for a pending PR with a bot result on its merge sha', async () => {
  const gh = fakeGh({ 1420: [comment(`Production smoke passed\n${marker()}`)] });
  const r = await closeLines({ logText: pendingLine(1420), gh });
  assert.deepEqual(r.lines, [resolved(1420)]);
  assert.deepEqual(r.pending, ['1420']);
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(gh.calls.sha, ['1420']);
});

test('closeLines: only github-actions[bot] counts (not a user, not a lookalike)', async () => {
  const gh = fakeGh({ 1420: [comment(marker({ outcome: 'failed' }), 'mallory'), comment(marker({ outcome: 'failed' }), 'github-actions')] });
  assert.deepEqual((await closeLines({ logText: pendingLine(1420), gh })).lines, []);
});

test('closeLines: a result for another sha than the PR merge commit is ignored', async () => {
  const gh = fakeGh({ 1420: [comment(marker({ sha: OTHER_SHA }))] });
  assert.deepEqual((await closeLines({ logText: pendingLine(1420), gh })).lines, []);
});

test('closeLines: newest result by observed wins, not comment order', async () => {
  const newer = marker({ outcome: 'passed', observed: '2026-10-12T05:00:00Z', vercel: 'new.vercel.app', run: '2' });
  const older = marker({ outcome: 'failed', observed: '2026-10-12T04:00:00Z', vercel: 'old.vercel.app', run: '1' });
  const { lines } = await closeLines({ logText: pendingLine(1420), gh: fakeGh({ 1420: [comment(newer), comment(older)] }) });
  assert.deepEqual(lines, [resolved(1420, { host: 'new.vercel.app', obs: '2026-10-12 13:00', run: '2' })]);
  const flipped = await closeLines({ logText: pendingLine(1420), gh: fakeGh({ 1420: [comment(older), comment(newer)] }) });
  assert.deepEqual(flipped.lines, lines);
});

test('closeLines: the same line on two different clock dates (the date comes from observed, not the clock)', async () => {
  const gh = fakeGh({ 1420: [comment(marker({ observed: '2026-10-12T16:30:00Z' }))] });
  const a = await closeLines({ logText: pendingLine(1420), gh, now: Date.parse('2026-10-12T17:00:00Z') });
  const b = await closeLines({ logText: pendingLine(1420), gh, now: Date.parse('2026-11-30T10:00:00Z') });
  assert.deepEqual(b.lines, a.lines);
  assert.ok(a.lines[0].startsWith('- 2026-10-13 · #1420 · '), a.lines[0]);
  assert.ok(a.lines[0].includes('observed 2026-10-13 00:30'));
});

test('closeLines: nothing when the newest result is already logged (no duplicate emission)', async () => {
  const gh = fakeGh({ 1420: [comment(marker())] });
  assert.deepEqual((await closeLines({ logText: `${pendingLine(1420)}\n${resolved(1420)}\n`, gh })).lines, []);
});

test('closeLines: judged by the newest logged observed even when an older line was appended AFTER a newer one', async () => {
  const older = resolved(1420, { outcome: 'failed', obs: '2026-10-12 10:00', run: '5' });
  const gh = fakeGh({ 1420: [comment(marker())] });
  assert.deepEqual((await closeLines({ logText: [pendingLine(1420), resolved(1420), older].join('\n'), gh })).lines, []);
  // the other way round, the newest by observed is the failed one and the fresh passed result is NOT yet logged
  const failedLater = resolved(1420, { outcome: 'failed', obs: '2026-10-12 14:00', run: '6' });
  assert.deepEqual((await closeLines({ logText: [pendingLine(1420), failedLater, resolved(1420)].join('\n'), gh })).lines, [resolved(1420)]);
});

test('closeLines: emits again when the newest result differs from the logged one (health changed)', async () => {
  const failed = marker({ outcome: 'failed', observed: '2026-10-12T05:30:00Z', run: '1000' });
  const gh = fakeGh({ 1420: [comment(marker()), comment(failed)] });
  const { lines } = await closeLines({ logText: `${pendingLine(1420)}\n${resolved(1420)}\n`, gh });
  assert.deepEqual(lines, [resolved(1420, { outcome: 'failed', obs: '2026-10-12 13:30', run: '1000' })]);
});

test('closeLines: skips an unmerged PR and a PR with no results; a PR listed twice is read once', async () => {
  const gh = fakeGh({ 1420: [comment(marker())], 1430: [] }, { 1411: null });
  const { lines } = await closeLines({ logText: [pendingLine(1411), pendingLine(1430), pendingLine(1420), pendingLine(1420)].join('\n'), gh });
  assert.equal(lines.length, 1);
  assert.deepEqual(gh.calls.comments, ['1430', '1420'], '1411 has no merge commit, so its comments are never read');
});

test('closeLines: keeps going when one PR cannot be read, and reports it', async () => {
  const gh = fakeGh({ 1420: [comment(marker())] });
  const real = gh.listComments;
  gh.listComments = async (n) => { if (n === '1430') throw new Error('boom\nsecond line'); return real(n); };
  const r = await closeLines({ logText: `${pendingLine(1430)}\n${pendingLine(1420)}`, gh });
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.unreadable, [{ pr: '1430', message: 'boom second line' }]);
});

const OLD_OBS = '2026-10-12 12:05'; // resolved long before NOW
const NOW = Date.parse('2026-11-30T00:00:00Z');

test('closeLines: a resolved PR older than the window with no new comment costs zero per-PR gh calls (skipped); an unresolved one is still read', async () => {
  assert.equal(RESOLVED_SKIP_DAYS, 14);
  const gh = fakeGh({ 1420: [comment(marker({ outcome: 'failed', observed: '2026-11-29T00:00:00Z' }))], 1500: [comment(marker({ observed: '2026-11-29T00:00:00Z' }))] }, {}, { scan: {} });
  const text = [pendingLine(1420), resolved(1420, { obs: OLD_OBS }), pendingLine(1411), pendingLine(1500)].join('\n');
  const r = await closeLines({ logText: text, gh, now: NOW });
  assert.deepEqual(r.skipped, ['1420']);
  assert.deepEqual(gh.calls.sha, ['1411', '1500'], '1420 made no gh call; 1411 has no resolution line and 1500 is the newest pending PR');
  assert.deepEqual(gh.calls.comments, ['1411', '1500']);
  assert.equal(gh.calls.repo.length, 1, 'one repo-wide read');
  assert.equal(gh.calls.repo[0], '2026-11-16T00:00:00Z', 'its window is RESOLVED_SKIP_DAYS back from now');
  assert.deepEqual(r.lines.map((l) => /#(\d+)/.exec(l)[1]), ['1500']);
});

test('closeLines: a NEW result on an old, long-resolved PR is found through the repo-wide scan (one merge-sha call, no per-PR comment read)', async () => {
  const fresh = marker({ outcome: 'failed', observed: '2026-11-29T00:00:00Z', run: '777' });
  const gh = fakeGh({ 1420: [comment(fresh)] }, {}, { scan: { 1420: [comment(fresh)], 999: [comment(marker({ outcome: 'failed' }))] } });
  const text = [pendingLine(1420), resolved(1420, { obs: OLD_OBS }), pendingLine(1500)].join('\n');
  const r = await closeLines({ logText: text, gh, now: NOW });
  assert.deepEqual(r.lines, [resolved(1420, { outcome: 'failed', date: '2026-11-29', obs: '2026-11-29 08:00', run: '777' })]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(gh.calls.sha, ['1420', '1500']);
  assert.deepEqual(gh.calls.comments, ['1500'], 'only the newest pending PR is read on its own; 1420 came from the scan');
});

test('closeLines: a scan hit still obeys the sha filter and the bot-only rule, and an already-logged result emits nothing', async () => {
  const wrongSha = comment(marker({ sha: OTHER_SHA, observed: '2026-11-29T00:00:00Z' }));
  const forged = comment(marker({ observed: '2026-11-29T00:00:00Z' }), 'mallory');
  const same = comment(marker({ observed: '2026-10-12T04:05:00Z' }));
  const text = [pendingLine(1420), resolved(1420), pendingLine(1430), resolved(1430), pendingLine(1440), resolved(1440), pendingLine(1500)].join('\n');
  const gh = fakeGh({}, {}, { scan: { 1420: [wrongSha], 1430: [forged], 1440: [same] } });
  const r = await closeLines({ logText: text, gh, now: Date.parse('2026-10-13T00:00:00Z') });
  assert.deepEqual(r.lines, []);
  assert.deepEqual(gh.calls.comments, ['1500']);
});

test('closeLines: the NEWEST pending PR is always read on its own, even when resolved long ago', async () => {
  const gh = fakeGh({ 1500: [comment(marker({ outcome: 'failed', observed: '2026-11-29T00:00:00Z' }))] }, {}, { scan: {} });
  const text = [pendingLine(1500), resolved(1500, { obs: OLD_OBS }), pendingLine(1420), resolved(1420, { obs: OLD_OBS })].join('\n');
  const r = await closeLines({ logText: text, gh, now: NOW });
  assert.deepEqual(gh.calls.comments, ['1500'], 'highest-numbered pending PR, not the last in file order');
  assert.deepEqual(r.skipped, ['1420']);
  assert.equal(r.lines.length, 1);
});

test('closeLines: prs names pending PRs to read on their own; all reads every pending PR (and then needs no scan)', async () => {
  const comments = { 1420: [comment(marker({ observed: '2026-11-29T00:00:00Z' }))], 1430: [], 1500: [] };
  const text = [pendingLine(1420), resolved(1420, { obs: OLD_OBS }), pendingLine(1430), resolved(1430, { obs: OLD_OBS }), pendingLine(1500)].join('\n');
  const named = fakeGh(comments, {}, { scan: {} });
  const a = await closeLines({ logText: text, gh: named, now: NOW, prs: ['1420'] });
  assert.deepEqual(named.calls.comments, ['1420', '1500']);
  assert.deepEqual(a.skipped, ['1430']);
  assert.equal(a.lines.length, 1);
  const everything = fakeGh(comments, {}, { scan: {} });
  const b = await closeLines({ logText: text, gh: everything, now: NOW, all: true });
  assert.deepEqual(everything.calls.comments, ['1420', '1430', '1500']);
  assert.deepEqual(everything.calls.repo, [], 'every PR is read on its own, so there is nothing for the scan to add');
  assert.deepEqual(b.skipped, []);
});

test('closeLines: no resolved PR left to check means no repo-wide read at all', async () => {
  const gh = fakeGh({ 1420: [] });
  await closeLines({ logText: pendingLine(1420), gh, now: NOW });
  assert.deepEqual(gh.calls.repo, []);
});

test('closeLines: when the repo-wide read fails the unresolved PRs are still processed and scanError says so', async () => {
  const gh = fakeGh({ 1500: [comment(marker())] }, {}, { scan: {} });
  gh.listRepoComments = async () => { throw new Error('HTTP 502\nbad gateway'); };
  const r = await closeLines({ logText: [pendingLine(1420), resolved(1420, { obs: OLD_OBS }), pendingLine(1500)].join('\n'), gh, now: NOW });
  assert.equal(r.scanError, 'HTTP 502 bad gateway');
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.skipped, ['1420']);
});

test('scanSince is exactly RESOLVED_SKIP_DAYS before now (second precision); prFromIssueUrl reads the PR number off issue_url', () => {
  const at = parsePht('2026-10-12', '12:05');
  assert.equal(scanSince(at + 14 * DAY + 123), '2026-10-12T04:05:00Z');
  assert.equal(prFromIssueUrl(issueUrl(1420)), '1420');
  assert.equal(prFromIssueUrl('https://api.github.com/repos/acme/widgets/issues/1420/comments'), null);
  assert.equal(prFromIssueUrl(undefined), null);
});

// ---- CLI -----------------------------------------------------------------------------------------

const commentsEntry = (n, list) => ({ match: `^api repos/acme/widgets/issues/${n}/comments --paginate`, stdoutJson: list });
const shaEntry = (n, oid = MERGE_SHA) => ({ match: `^pr view ${n} --json mergeCommit`, stdoutJson: { mergeCommit: oid ? { oid } : null } });
const AUTH = { match: '^auth status', stdout: 'Logged in' };
const scanEntry = (list) => ({ match: '^api repos/acme/widgets/issues/comments\\?since=\\d{4}-\\d{2}-\\d{2}T\\d{2}%3A\\d{2}%3A\\d{2}Z&per_page=100 --paginate', stdoutJson: list.map(([n, c]) => ({ ...c, issue_url: issueUrl(n) })) });

function closeRepo(logText, entries) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write(AGENT_LOG, `# Agent log\n\n${logText}\n`);
  repo.write('.gitignore', '.review/\n');
  repo.commit('init');
  const fake = createFakeGh([AUTH, REPO, ...entries]);
  const queueFile = join(repo.dir, '.git', 'claude-pipeline', 'agent-log-queue.jsonl');
  return { repo, fake, queueFile, close: (...args) => cli(['agent-log', 'close', ...args], { dir: repo.dir, fake }) };
}
const readQueueLines = (t) => {
  try {
    return readFileSync(t.queueFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).line);
  } catch {
    return [];
  }
};

test('agent-log close: dry run prints {lines, pending, unreadable} and writes nothing', () => {
  const t = closeRepo(pendingLine(1420), [shaEntry(1420), commentsEntry(1420, [comment(marker())])]);
  const r = t.close();
  assertExit(r, 0);
  assert.deepEqual(r.json, { ok: true, lines: [resolved(1420)], pending: [1420], skipped: [], unreadable: [] });
  assert.deepEqual(readQueueLines(t), [], 'a dry run queues nothing');
  assert.equal(t.repo.git(['status', '--porcelain']), '', 'and changes nothing in the worktree');
});

test('agent-log close --queue: queues each line (no commit); stage then commits it and a later close emits nothing', () => {
  const t = closeRepo(pendingLine(1420), [shaEntry(1420), commentsEntry(1420, [comment(marker())])]);
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  const r = t.close('--queue');
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [resolved(1420)]);
  assert.equal(r.json.queued, 1);
  assert.deepEqual(readQueueLines(t), [resolved(1420)]);
  assert.equal(t.repo.git(['rev-parse', 'HEAD']).trim(), head, 'close never commits');

  // the queued line rides along with `stage` into the PR branch's log
  t.repo.branch('agent/feature');
  t.fake.setScript([
    AUTH, REPO,
    { match: `^pr view ${PR} --json headRefName,headRefOid`, stdoutJson: { headRefName: 'agent/feature', headRefOid: head } },
  ]);
  const staged = cli(['agent-log', 'stage', '--pr', String(PR), '--line', '- this PR'], { dir: t.repo.dir, fake: t.fake });
  assertExit(staged, 0);
  assert.deepEqual(staged.json.lines, [resolved(1420), '- this PR']);
  const log = readFileSync(join(t.repo.dir, AGENT_LOG), 'utf8');
  assert.ok(log.includes(resolved(1420)));
  assert.notEqual(t.repo.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(t.repo.git(['status', '--porcelain']), '');

  // now that the log holds the resolution, a fresh close has nothing to emit
  t.fake.setScript([AUTH, REPO, shaEntry(1420), commentsEntry(1420, [comment(marker())])]);
  const again = t.close('--queue');
  assertExit(again, 0);
  assert.deepEqual(again.json.lines, []);
});

test('agent-log close: a PR that cannot be read exits 1, the others are still processed (and queued)', () => {
  const t = closeRepo(`${pendingLine(1430)}\n${pendingLine(1420)}`, [
    shaEntry(1430), { match: '^api repos/acme/widgets/issues/1430/comments', stderr: 'HTTP 500', code: 1 },
    shaEntry(1420), commentsEntry(1420, [comment(marker())]),
  ]);
  const r = t.close('--queue');
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.lines, [resolved(1420)]);
  assert.deepEqual(r.json.pending, [1430, 1420]);
  assert.equal(r.json.unreadable.length, 1);
  assert.equal(r.json.unreadable[0].pr, 1430);
  assert.deepEqual(readQueueLines(t), [resolved(1420)]);
});

test('agent-log close: exit 3 when GitHub is unavailable; no pending lines means no GitHub call at all', () => {
  const down = closeRepo(pendingLine(1420), []);
  down.fake.setScript([{ match: '^auth status', stderr: 'not logged in', code: 1 }]);
  assertExit(down.close(), 3);

  const none = closeRepo('- 2026-10-09 · #1411 · feat · risk high · rounds 1 · arbiter 0 · needs-human', []);
  none.fake.setScript([]);
  const r = none.close();
  assertExit(r, 0);
  assert.deepEqual(r.json, { ok: true, lines: [], pending: [], skipped: [], unreadable: [] });
  assert.deepEqual(none.fake.lines(), []);
});

test('agent-log close: unknown arguments are a usage error', () => {
  const t = closeRepo(pendingLine(1420), []);
  assertExit(t.close('--bogus'), 2);
  assertExit(t.close('extra'), 2);
});

// A long-resolved PR (1411, logged long ago) and the newest pending PR (1500, no resolution line yet).
const OLD_AND_NEW = () => [pendingLine(1411), resolved(1411, { date: '2026-08-01', obs: '2026-08-01 10:00', run: '5' }), pendingLine(1500)].join('\n');
const apiCalls = (t) => t.fake.lines().filter((l) => l.startsWith('api repos/'));

test('agent-log close: a new result on an old resolved PR comes from the repo-wide read; that PR\'s own comments are never listed', () => {
  const t = closeRepo(OLD_AND_NEW(), [
    scanEntry([[1411, comment(marker({ outcome: 'failed', observed: '2026-10-12T04:05:00Z', run: '321' }))], [77, comment(marker())]]),
    shaEntry(1411), shaEntry(1500), commentsEntry(1500, []),
  ]);
  const r = t.close('--queue');
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [resolved(1411, { outcome: 'failed', run: '321' })]);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(r.json.queued, 1);
  assert.deepEqual(readQueueLines(t), [resolved(1411, { outcome: 'failed', run: '321' })]);
  assert.equal(apiCalls(t).filter((l) => l.includes('/issues/1411/comments')).length, 0);
  assert.equal(apiCalls(t).filter((l) => l.includes('/issues/1500/comments')).length, 1, 'the newest pending PR is read on its own');
  assert.equal(apiCalls(t).filter((l) => l.includes('issues/comments?since=')).length, 1, 'one repo-wide read');
});

test('agent-log close: a long-resolved PR with no new comment is skipped; --pr N and --all read it on their own', () => {
  const entries = [scanEntry([]), shaEntry(1411), shaEntry(1500), commentsEntry(1500, []), commentsEntry(1411, [comment(marker({ outcome: 'failed', observed: '2026-10-12T04:05:00Z', run: '88' }))])];
  const quiet = closeRepo(OLD_AND_NEW(), entries);
  const base = quiet.close();
  assertExit(base, 0);
  assert.deepEqual(base.json.skipped, [1411]);
  assert.deepEqual(base.json.lines, []);
  assert.equal(apiCalls(quiet).filter((l) => l.includes('/issues/1411/comments')).length, 0);

  const named = closeRepo(OLD_AND_NEW(), entries);
  const byPr = named.close('--pr', '1411', '--pr=1500');
  assertExit(byPr, 0);
  assert.deepEqual(byPr.json.lines, [resolved(1411, { outcome: 'failed', run: '88' })]);
  assert.deepEqual(byPr.json.skipped, []);

  const everything = closeRepo(OLD_AND_NEW(), entries);
  const all = everything.close('--all');
  assertExit(all, 0);
  assert.deepEqual(all.json.lines, byPr.json.lines);
  assert.equal(apiCalls(everything).filter((l) => l.includes('issues/comments?since=')).length, 0, '--all reads each PR on its own');

  assertExit(quiet.close('--pr', 'abc'), 2);
  assertExit(quiet.close('--pr', '0'), 2);
});

test('agent-log close --queue twice queues the same line once', () => {
  const t = closeRepo(pendingLine(1420), [shaEntry(1420), commentsEntry(1420, [comment(marker())])]);
  assert.equal(t.close('--queue').json.queued, 1);
  const again = t.close('--queue');
  assertExit(again, 0);
  assert.deepEqual(again.json.lines, [resolved(1420)]);
  assert.equal(again.json.queued, 0, 'already queued');
  assert.deepEqual(readQueueLines(t), [resolved(1420)]);
});

test('agent-log close: a failed repo-wide read exits 1 with scanError, and the lines for the PRs that were read are still queued', () => {
  const t = closeRepo(OLD_AND_NEW(), [
    { match: 'issues/comments\\?since=', stderr: 'HTTP 502', code: 1 },
    shaEntry(1500), commentsEntry(1500, [comment(marker())]),
  ]);
  const r = t.close('--queue');
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.scanError);
  assert.deepEqual(r.json.unreadable, []);
  assert.deepEqual(r.json.lines, [resolved(1500)]);
  assert.deepEqual(readQueueLines(t), [resolved(1500)]);
});
