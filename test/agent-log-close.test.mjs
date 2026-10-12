// `pipeline agent-log close`: the pure part (markers, authors, shas, newest-by-observed, PHT dating, dedupe, the repo-wide scan
// and which PRs are read on their own) against an injected gh, and the CLI (dry run, --queue + stage, --pr/--all, unreadable PR,
// GitHub unavailable) against the scripted fake gh. Every age-sensitive pure test passes an explicit `now`: no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, AGENT_LOG, REPO, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { DEFAULT_OUTCOME } from '../pipeline/lib/agentlog.mjs';
import {
  BOT_AUTHOR, RESOLVED_SKIP_DAYS, closeLines, formatPht, parseLog, parsePht, parseResultMarkers, prFromIssueUrl, resolutionLine, scanSince,
  readScanState, writeScanState, scanStatePath, unionLogText,
} from '../pipeline/lib/agentlog-close.mjs';

const MERGE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const HOST = 'ewiapp-abc-team.vercel.app';
const pendingLine = (n, date = '2026-10-09') => `- ${date} · #${n} · fix(x): something · risk low · rounds 1 · arbiter 0 · ${DEFAULT_OUTCOME}`;
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
      // like GitHub: a comment carrying `updated_at` is returned only when it is not older than `since`
      return Object.entries(scan).flatMap(([n, list]) => list.map((c) => ({ ...c, issue_url: issueUrl(n) })))
        .filter((c) => c.updated_at === undefined || Date.parse(c.updated_at) >= Date.parse(since));
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
  // the other way round, a logged failure at 14:00 is newer than the passed result at 12:05: an older result is never emitted (monotonic)
  const failedLater = resolved(1420, { outcome: 'failed', obs: '2026-10-12 14:00', run: '6' });
  assert.deepEqual((await closeLines({ logText: [pendingLine(1420), failedLater, resolved(1420)].join('\n'), gh })).lines, []);
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
  const r = await closeLines({ logText: text, gh, now: NOW, lastScanAt: NOW - DAY });
  assert.deepEqual(r.skipped, ['1420']);
  assert.deepEqual(gh.calls.sha, ['1411', '1500'], '1420 made no gh call; 1411 has no resolution line and 1500 is the newest pending PR');
  assert.deepEqual(gh.calls.comments, ['1411', '1500']);
  assert.equal(gh.calls.repo.length, 1, 'one repo-wide read');
  assert.equal(gh.calls.repo[0], '2026-11-16T00:00:00Z', 'its window is RESOLVED_SKIP_DAYS back from now');
  assert.deepEqual(r.lines.map((l) => /#(\d+)/.exec(l)[1]), ['1500']);
});

test('closeLines: a NEW result on an old, long-resolved PR is found through the repo-wide scan (one merge-sha call, one per-PR history read)', async () => {
  const fresh = marker({ outcome: 'failed', observed: '2026-11-29T00:00:00Z', run: '777' });
  const gh = fakeGh({ 1420: [comment(fresh)] }, {}, { scan: { 1420: [comment(fresh)], 999: [comment(marker({ outcome: 'failed' }))] } });
  const text = [pendingLine(1420), resolved(1420, { obs: OLD_OBS }), pendingLine(1500)].join('\n');
  const r = await closeLines({ logText: text, gh, now: NOW });
  assert.deepEqual(r.lines, [resolved(1420, { outcome: 'failed', date: '2026-11-29', obs: '2026-11-29 08:00', run: '777' })]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(gh.calls.sha, ['1420', '1500']);
  assert.deepEqual(gh.calls.comments, ['1420', '1500'], '1420 is read in full because the scan named it; 1500 is the newest pending PR');
});

test('closeLines: a scan hit still obeys the sha filter and the bot-only rule, and an already-logged result emits nothing', async () => {
  const wrongSha = comment(marker({ sha: OTHER_SHA, observed: '2026-11-29T00:00:00Z' }));
  const forged = comment(marker({ observed: '2026-11-29T00:00:00Z' }), 'mallory');
  const same = comment(marker({ observed: '2026-10-12T04:05:00Z' }));
  const text = [pendingLine(1420), resolved(1420), pendingLine(1430), resolved(1430), pendingLine(1440), resolved(1440), pendingLine(1500)].join('\n');
  const gh = fakeGh({ 1420: [wrongSha], 1430: [forged], 1440: [same] }, {}, { scan: { 1420: [wrongSha], 1430: [forged], 1440: [same] } });
  const r = await closeLines({ logText: text, gh, now: Date.parse('2026-10-13T00:00:00Z') });
  assert.deepEqual(r.lines, []);
  assert.deepEqual(gh.calls.comments, ['1420', '1440', '1500'], 'a forged comment does not even trigger a read; the other hits are read in full and filtered');
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

// ---- scan window: the whole gap since the last successful scan ----

const D0 = Date.parse('2026-09-01T00:00:00Z');
const GAP_TEXT = () => [pendingLine(1420, '2026-08-30'), resolved(1420, { date: '2026-08-30', obs: '2026-08-30 10:00' }), pendingLine(1500, '2026-08-31')].join('\n');
const failedOnDay1 = () => ({ ...comment(marker({ outcome: 'failed', observed: '2026-09-02T00:00:00Z', run: '4242' })), updated_at: '2026-09-02T00:00:00Z' });

test('scan window (a): a result seen the day after the last scan on a resolved, non-newest PR is found 16 days later', async () => {
  const gh = fakeGh({ 1420: [failedOnDay1()] }, {}, { scan: { 1420: [failedOnDay1()] } });
  const r = await closeLines({ logText: GAP_TEXT(), gh, now: D0 + 16 * DAY, lastScanAt: D0 });
  assert.equal(gh.calls.repo[0], '2026-08-30T00:00:00Z', 'min(now - 14d, lastScanAt - 2d)');
  assert.deepEqual(r.lines, [resolved(1420, { outcome: 'failed', date: '2026-09-02', obs: '2026-09-02 08:00', run: '4242' })]);
  assert.equal(r.scanned, true);
  // without the state a plain 14-day window (starting 2026-09-03) would have missed it
  const plain = fakeGh({ 1420: [failedOnDay1()] }, {}, { scan: { 1420: [failedOnDay1()] } });
  const missed = await closeLines({ logText: [pendingLine(1420, '2026-09-10'), resolved(1420, { obs: '2026-09-10 10:00' }), pendingLine(1500, '2026-09-10')].join('\n'), gh: plain, now: D0 + 16 * DAY });
  assert.equal(plain.calls.repo[0], '2026-09-03T00:00:00Z');
  assert.deepEqual(missed.lines, []);
});

test('scan window (b): a recent last scan leaves the plain 14-day window', () => {
  const now = D0 + 16 * DAY;
  assert.equal(scanSince(now, { lastScanAt: D0 + 15 * DAY }), '2026-09-03T00:00:00Z');
  assert.equal(scanSince(now, { lastScanAt: D0 + 15 * DAY, oldestPendingAt: D0 - 100 * DAY }), '2026-09-03T00:00:00Z', 'the oldest pending line only matters without state');
  assert.equal(scanSince(now, { lastScanAt: D0 }), '2026-08-30T00:00:00Z');
});

test('scan window (c): no state reaches the day before the oldest pending line (a one-off full catch-up)', async () => {
  assert.equal(scanSince(D0 + 16 * DAY, {}), '2026-09-03T00:00:00Z');
  const gh = fakeGh({}, {}, { scan: {} });
  await closeLines({ logText: GAP_TEXT(), gh, now: D0 + 16 * DAY });
  assert.equal(gh.calls.repo[0], '2026-08-29T00:00:00Z', 'oldest pending line is 2026-08-30');
  assert.equal(parseLog(GAP_TEXT()).oldestPendingAt, Date.parse('2026-08-30T00:00:00Z'));
  assert.equal(parseLog('# nothing').oldestPendingAt, null);
});

test('scan window: state read/write round trip, corrupt or future state reads as missing', () => {
  const t = createTmpRepo();
  assert.equal(readScanState(t.dir), null, 'no file');
  assert.equal(writeScanState(t.dir, D0), true);
  assert.deepEqual(JSON.parse(readFileSync(scanStatePath(t.dir), 'utf8')), { lastScanAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(readScanState(t.dir, D0 + 1), D0);
  assert.equal(readScanState(t.dir, D0 - 1), null, 'a clock that went backwards must not shrink the window');
  writeFileSync(scanStatePath(t.dir), '{not json');
  assert.equal(readScanState(t.dir), null);
  writeFileSync(scanStatePath(t.dir), JSON.stringify({ lastScanAt: 'yesterday' }));
  assert.equal(readScanState(t.dir), null);
});

// ---- CLI -----------------------------------------------------------------------------------------

const commentsEntry = (n, list) => ({ match: `^api repos/acme/widgets/issues/${n}/comments --paginate`, stdoutJson: list });
const shaEntry = (n, oid = MERGE_SHA) => ({ match: `^pr view ${n} --json mergeCommit`, stdoutJson: { mergeCommit: oid ? { oid } : null } });
const AUTH = { match: '^auth status', stdout: 'Logged in' };
const scanEntry = (list) => ({ match: '^api repos/acme/widgets/issues/comments\\?since=\\d{4}-\\d{2}-\\d{2}T\\d{2}%3A\\d{2}%3A\\d{2}Z&per_page=100 --paginate', stdoutJson: list.map(([n, c]) => ({ ...c, issue_url: issueUrl(n) })) });

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// A real origin by default (the closer reads origin/<default>'s copy of the log); `origin: false` has none. `originLog` is what
// origin holds when it differs from the worktree's (a worktree on an older branch): it is pushed first, the worktree's copy is
// committed on top and not pushed.
function closeRepo(logText, entries, { origin = true, originLog = null } = {}) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write(AGENT_LOG, `# Agent log\n\n${originLog ?? logText}\n`);
  repo.commit('init');
  if (origin) {
    const bare = mkdtempSync(join(tmpdir(), 'cp-close-origin-'));
    made.push(bare);
    repo.git(['init', '--bare', '-q', bare]);
    repo.git(['remote', 'add', 'origin', bare]);
    repo.git(['push', '-q', 'origin', 'main']);
  }
  if (originLog !== null) {
    repo.write(AGENT_LOG, `# Agent log\n\n${logText}\n`);
    repo.commit('older branch');
  }
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
  assert.deepEqual(r.json, { ok: true, lines: [resolved(1420)], pending: [1420], skipped: [], unreadable: [], originReadable: true });
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
  assert.deepEqual(r.json, { ok: true, lines: [], pending: [], skipped: [], unreadable: [], originReadable: true });
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

test('agent-log close: a new result on an old resolved PR is found by the repo-wide read, then that PR\'s whole history is read once', () => {
  const t = closeRepo(OLD_AND_NEW(), [
    scanEntry([[1411, comment(marker({ outcome: 'failed', observed: '2026-10-12T04:05:00Z', run: '321' }))], [77, comment(marker())]]),
    shaEntry(1411), shaEntry(1500), commentsEntry(1500, []), commentsEntry(1411, [comment(marker({ outcome: 'failed', observed: '2026-10-12T04:05:00Z', run: '321' }))]),
  ]);
  const r = t.close('--queue');
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [resolved(1411, { outcome: 'failed', run: '321' })]);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(r.json.queued, 1);
  assert.deepEqual(readQueueLines(t), [resolved(1411, { outcome: 'failed', run: '321' })]);
  assert.equal(apiCalls(t).filter((l) => l.includes('/issues/1411/comments')).length, 1, 'the scan hit is only a trigger: its full history is read');
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

// ---- scan window state, through the CLI (real clock: only compared with before/after) ----

const ANCIENT = '2026-01-05'; // far enough back that the catch-up window is deterministic whatever today is
const ANCIENT_AND_NEW = () => [pendingLine(1411, ANCIENT), resolved(1411, { date: ANCIENT, obs: `${ANCIENT} 10:00`, run: '5' }), pendingLine(1500, ANCIENT)].join('\n');
const stateOf = (t) => {
  try {
    return JSON.parse(readFileSync(join(t.repo.dir, '.git', 'claude-pipeline', 'agent-log-close.json'), 'utf8'));
  } catch {
    return null;
  }
};

test('scan window (e): a successful --queue scan records its own start time; a dry run, and no scan at all, record nothing', () => {
  const dry = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), commentsEntry(1500, [])]);
  assertExit(dry.close(), 0);
  assert.equal(stateOf(dry), null, 'a dry run discards its lines, so it must not move the window');

  const t = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), commentsEntry(1500, [])]);
  const before = Date.now();
  assertExit(t.close('--queue'), 0);
  const after = Date.now();
  const at = Date.parse(stateOf(t).lastScanAt);
  assert.ok(at >= before - 1000 && at <= after, `lastScanAt ${stateOf(t).lastScanAt}`);

  const none = closeRepo(pendingLine(1420, ANCIENT), [shaEntry(1420), commentsEntry(1420, [])]);
  assertExit(none.close('--queue'), 0);
  assert.equal(stateOf(none), null, 'only unresolved PRs: no repo-wide scan ran');
});

test('scan window (d): a failed scan, or an unreadable PR, leaves the state untouched; no state starts at the oldest pending line', () => {
  const failing = closeRepo(ANCIENT_AND_NEW(), [{ match: 'issues/comments\\?since=', stderr: 'HTTP 502', code: 1 }, shaEntry(1500), commentsEntry(1500, [])]);
  assert.equal(stateOf(failing), null);
  const stateFile = join(failing.repo.dir, '.git', 'claude-pipeline', 'agent-log-close.json');
  mkdirSync(join(failing.repo.dir, '.git', 'claude-pipeline'), { recursive: true });
  const seeded = `${JSON.stringify({ lastScanAt: '2026-01-06T00:00:00.000Z' })}\n`;
  writeFileSync(stateFile, seeded);
  assertExit(failing.close('--queue'), 1);
  assert.equal(readFileSync(stateFile, 'utf8'), seeded);
  assert.ok(failing.fake.lines().some((l) => l.includes('since=2026-01-04T00%3A00%3A00Z')), 'min(now - 14d, lastScanAt - 2d)');

  // an unresolved PR outside the scan results (re-read every run anyway) does not hold the window back ...
  const outside = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), { match: '^api repos/acme/widgets/issues/1500/comments', stderr: 'HTTP 500', code: 1 }]);
  assertExit(outside.close('--queue'), 1);
  assert.ok(stateOf(outside), 'state advanced');
  assert.deepEqual(readdirSync(join(outside.repo.dir, '.git', 'claude-pipeline')).filter((f) => f.endsWith('.tmp')), [], 'no tmp file left behind');
  // ... but a PR the scan itself surfaced and that cannot be read does
  const surfaced = closeRepo(ANCIENT_AND_NEW(), [scanEntry([[1411, comment(marker())]]), { match: '^pr view 1411 --json mergeCommit', stderr: 'HTTP 500', code: 1 }, shaEntry(1500), commentsEntry(1500, [])]);
  assertExit(surfaced.close('--queue'), 1);
  assert.equal(stateOf(surfaced), null);

  // a failed queue append (here: the queue path is a directory) leaves it alone too
  const append = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), commentsEntry(1500, [comment(marker())])]);
  mkdirSync(append.queueFile, { recursive: true });
  const failedAppend = append.close('--queue');
  assert.ok(failedAppend.code !== 0, `queue append failure must not exit 0: ${failedAppend.stderr}`);
  assert.equal(stateOf(append), null);

  const fresh = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), commentsEntry(1500, [])]);
  assertExit(fresh.close(), 0);
  assert.ok(fresh.fake.lines().some((l) => l.includes('since=2026-01-04T00%3A00%3A00Z')), 'a day before the oldest pending line (2026-01-05)');
});

test('a queued line staged in another open PR stays that PR\'s: close --queue does not re-add it and stage in a second worktree does not carry it', () => {
  const t = closeRepo(pendingLine(1420), [shaEntry(1420), commentsEntry(1420, [comment(marker())])]);
  const L = resolved(1420);
  assertExit(cli(['agent-log', 'queue', '--line', L], { dir: t.repo.dir, fake: t.fake }), 0);
  const OTHER_PR = 4321;
  writeFileSync(t.queueFile, `${JSON.stringify({ line: L, at: '2026-10-12T00:00:00.000Z', staged: { pr: OTHER_PR, at: '2026-10-12T01:00:00.000Z' } })}\n`);

  const r = t.close('--queue');
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [L], 'still not in the log, so it is emitted again');
  assert.equal(r.json.queued, 0);
  const entries = readFileSync(t.queueFile, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].line, L);
  assert.equal(entries[0].staged.pr, OTHER_PR);

  // PR B's worktree: stage must leave L to PR A (still open)
  const head = t.repo.git(['rev-parse', 'HEAD']).trim();
  t.repo.branch('agent/feature');
  t.fake.setScript([
    AUTH, REPO,
    { match: `^pr view ${PR} --json headRefName,headRefOid`, stdoutJson: { headRefName: 'agent/feature', headRefOid: head } },
    { match: `^pr view ${OTHER_PR} --json state`, stdoutJson: { state: 'OPEN' } },
  ]);
  const staged = cli(['agent-log', 'stage', '--pr', String(PR), '--line', '- this PR'], { dir: t.repo.dir, fake: t.fake });
  assertExit(staged, 0);
  assert.deepEqual(staged.json.lines, ['- this PR']);
  assert.equal(staged.json.staged, 0);
  assert.ok(!readFileSync(join(t.repo.dir, AGENT_LOG), 'utf8').includes(L));
  const after = readFileSync(t.queueFile, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(after.length, 1);
  assert.equal(after[0].staged.pr, OTHER_PR);
});

// ---- Addendum B: scan hits are triggers, emission is monotonic, the log is the union with origin's copy ----

test('scan hit is a trigger only: the newest result comes from the PR\'s full history, so an older in-window comment cannot resurface a superseded outcome', async () => {
  const failed = comment(marker({ outcome: 'failed', observed: '2026-10-12T04:05:00Z', run: '10' }));
  const passedOlder = { ...comment(marker({ outcome: 'passed', observed: '2026-10-11T04:05:00Z', run: '9' })), updated_at: '2026-10-12T20:00:00Z' };
  const text = [pendingLine(1500), resolved(1500, { outcome: 'failed', obs: '2026-10-12 12:05', run: '10' }), pendingLine(1600)].join('\n');
  const gh = fakeGh({ 1500: [passedOlder, failed] }, {}, { scan: { 1500: [passedOlder] } });
  const r = await closeLines({ logText: text, gh, now: Date.parse('2026-10-13T00:00:00Z'), lastScanAt: Date.parse('2026-10-12T00:00:00Z') });
  assert.deepEqual(r.lines, [], 'the older passed result is not emitted');
  assert.ok(gh.calls.comments.includes('1500'), 'the full history was read');
  assert.deepEqual(gh.calls.sha.filter((n) => n === '1500'), ['1500']);
});

test('scan hit is a trigger only: a comment that is not a bot result does not cost a read', async () => {
  const text = [pendingLine(1420), resolved(1420), pendingLine(1500)].join('\n');
  const noise = [comment('looks good'), comment(marker(), 'mallory'), comment(`<!-- prod-smoke-result v=1 sha=${MERGE_SHA} -->`)];
  const gh = fakeGh({}, {}, { scan: { 1420: noise } });
  const r = await closeLines({ logText: text, gh, now: Date.parse('2026-10-13T00:00:00Z') });
  assert.deepEqual(r.skipped, ['1420']);
  assert.deepEqual(gh.calls.comments, ['1500']);
});

test('monotonic emission: an equal or older result (to the minute) is never emitted, a strictly later one is', async () => {
  const text = [pendingLine(1420), resolved(1420, { obs: '2026-10-12 12:05' })].join('\n'); // 04:05Z
  const at = (observed, extra = {}) => closeLines({ logText: text, gh: fakeGh({ 1420: [comment(marker({ observed, ...extra }))] }) });
  assert.deepEqual((await at('2026-10-12T04:05:59Z')).lines, [], 'same minute, later seconds: equal after truncation');
  assert.deepEqual((await at('2026-10-12T04:05:00Z', { outcome: 'failed', run: '5' })).lines, [], 'same minute, different outcome: still not emitted');
  assert.deepEqual((await at('2026-10-12T04:04:59Z')).lines, []);
  assert.deepEqual((await at('2026-10-12T04:06:00Z')).lines, [resolved(1420, { obs: '2026-10-12 12:06' })]);
});

test('unionLogText: lines deduped verbatim, first copy first, CRLF normalised', () => {
  assert.equal(unionLogText('a\nb\n', 'b\r\nc\n'), 'a\nb\n\nc');
  assert.equal(unionLogText(undefined, 'x'), 'x');
  const union = parseLog(unionLogText(pendingLine(1600), [pendingLine(1500), resolved(1500), pendingLine(1600)].join('\n')));
  assert.deepEqual(union.pending, ['1600', '1500']);
  assert.equal(union.resolutions.get('1500').length, 1);
});

test('agent-log close --queue: a stale worktree log is completed from origin/<default>\'s copy, so a result in the gap is queued in run 1', () => {
  const lastScanAt = Date.now() - 30 * DAY;
  const originLog = [pendingLine(1500, '2026-01-05'), resolved(1500, { date: '2026-01-05', obs: '2026-01-05 10:00', run: '5' }), pendingLine(1600, '2026-01-06')].join('\n');
  const stale = pendingLine(1600, '2026-01-06'); // this worktree's branch predates 1500
  const result = comment(marker({ outcome: 'failed', observed: new Date(lastScanAt + 10 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'), run: '808' }));
  const entries = () => [scanEntry([[1500, result]]), shaEntry(1500), shaEntry(1600), commentsEntry(1500, [result]), commentsEntry(1600, [])];
  const seed = (t) => {
    mkdirSync(join(t.repo.dir, '.git', 'claude-pipeline'), { recursive: true });
    writeFileSync(join(t.repo.dir, '.git', 'claude-pipeline', 'agent-log-close.json'), `${JSON.stringify({ lastScanAt: new Date(lastScanAt).toISOString() })}\n`);
  };
  const seen = formatPht(Math.floor((lastScanAt + 10 * DAY) / 1000) * 1000);
  const expected = resolved(1500, { outcome: 'failed', date: seen.date, obs: `${seen.date} ${seen.time}`, run: '808' });

  // control: without origin's copy the worktree never heard of 1500, so nothing is found
  const alone = closeRepo(stale, entries());
  seed(alone);
  const none = alone.close('--queue');
  assertExit(none, 0);
  assert.deepEqual(none.json.lines, []);

  const t = closeRepo(stale, entries(), { originLog });
  assert.ok(!readFileSync(join(t.repo.dir, AGENT_LOG), 'utf8').includes('#1500'), 'the worktree log really is stale');
  seed(t);
  const r = t.close('--queue');
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [expected]);
  assert.deepEqual(readQueueLines(t), [expected]);
  assert.deepEqual(r.json.pending.sort(), [1500, 1600]);
  assert.ok(Date.parse(stateOf(t).lastScanAt) > lastScanAt, 'origin was readable, so the checkpoint advanced');
});

test('agent-log close --queue: origin\'s copy unreadable still closes what it can but leaves the last-scan checkpoint where it was', () => {
  const lastScanAt = '2026-01-06T00:00:00.000Z';
  const t = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), commentsEntry(1500, [comment(marker())])], { origin: false });
  mkdirSync(join(t.repo.dir, '.git', 'claude-pipeline'), { recursive: true });
  const stateFile = join(t.repo.dir, '.git', 'claude-pipeline', 'agent-log-close.json');
  writeFileSync(stateFile, `${JSON.stringify({ lastScanAt })}\n`);
  const r = t.close('--queue');
  assertExit(r, 0);
  assert.deepEqual(r.json.lines, [resolved(1500)]);
  assert.deepEqual(readQueueLines(t), [resolved(1500)]);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lastScanAt, lastScanAt);
  assert.equal(r.json.originReadable, false);
  assert.ok(r.stderr.includes('origin/main agent log unreadable — closing from the worktree log; scan checkpoint not advanced'), r.stderr);

  const ok = closeRepo(ANCIENT_AND_NEW(), [scanEntry([]), shaEntry(1500), commentsEntry(1500, [])]);
  const good = ok.close('--queue');
  assert.equal(good.json.originReadable, true);
  assert.ok(!good.stderr.includes('unreadable'), good.stderr);
});
