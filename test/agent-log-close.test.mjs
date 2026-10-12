// `pipeline agent-log close`: the pure part (markers, authors, shas, newest-by-observed, PHT dating, dedupe) against an
// injected gh, and the CLI (dry run, --queue + stage, unreadable PR, GitHub unavailable) against the scripted fake gh.
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
  BOT_AUTHOR, RESOLVED_SKIP_DAYS, closeLines, formatPht, parseLog, parsePht, parseResultMarkers, resolutionLine,
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

function fakeGh(comments, shas = {}) {
  const calls = { comments: [], sha: [] };
  return {
    calls,
    mergeSha: async (n) => { calls.sha.push(n); return n in shas ? shas[n] : MERGE_SHA; },
    listComments: async (n) => { calls.comments.push(n); return comments[n] ?? []; },
  };
}

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

test('closeLines: the same line on two different clock dates (the date comes from observed, not the clock)', async (t) => {
  const gh = fakeGh({ 1420: [comment(marker({ observed: '2026-10-12T16:30:00Z' }))] });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T17:00:00Z') });
  const a = await closeLines({ logText: pendingLine(1420), gh });
  t.mock.timers.setTime(Date.parse('2026-11-30T10:00:00Z'));
  const b = await closeLines({ logText: pendingLine(1420), gh });
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

test('closeLines: a PR whose newest resolution is older than the window is skipped with zero gh calls; an unresolved old PR is still read', async () => {
  assert.equal(RESOLVED_SKIP_DAYS, 14);
  const now = Date.parse('2026-11-30T00:00:00Z');
  const gh = fakeGh({ 1420: [comment(marker({ outcome: 'failed', observed: '2026-11-29T00:00:00Z' }))], 1411: [comment(marker({ observed: '2026-11-29T00:00:00Z' }))] });
  const text = [pendingLine(1420), resolved(1420, { obs: '2026-10-12 12:05' }), pendingLine(1411)].join('\n');
  const r = await closeLines({ logText: text, gh, now });
  assert.deepEqual(r.skipped, ['1420']);
  assert.deepEqual(gh.calls.sha, ['1411'], '1420 made no gh call; 1411 has no resolution so it is read whatever its age');
  assert.deepEqual(gh.calls.comments, ['1411']);
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].includes('#1411'));
});

test('closeLines: the window is judged by the NEWEST logged resolution, and 14 days exactly is still read', async () => {
  const obs = '2026-10-12 12:05';
  const at = parsePht('2026-10-12', '12:05');
  const day = 24 * 3600 * 1000;
  const edge = fakeGh({ 1420: [] });
  assert.deepEqual((await closeLines({ logText: `${pendingLine(1420)}\n${resolved(1420, { obs })}`, gh: edge, now: at + 14 * day })).skipped, []);
  assert.deepEqual(edge.calls.sha, ['1420']);
  const stale = fakeGh({ 1420: [] });
  const old = resolved(1420, { outcome: 'failed', obs: '2026-09-01 10:00', run: '1' });
  assert.deepEqual((await closeLines({ logText: [pendingLine(1420), resolved(1420, { obs }), old].join('\n'), gh: stale, now: at + 14 * day + 1 })).skipped, ['1420']);
  assert.deepEqual(stale.calls.sha, []);
});

// ---- CLI -----------------------------------------------------------------------------------------

const commentsEntry = (n, list) => ({ match: `^api repos/acme/widgets/issues/${n}/comments --paginate`, stdoutJson: list });
const shaEntry = (n, oid = MERGE_SHA) => ({ match: `^pr view ${n} --json mergeCommit`, stdoutJson: { mergeCommit: oid ? { oid } : null } });
const AUTH = { match: '^auth status', stdout: 'Logged in' };

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
