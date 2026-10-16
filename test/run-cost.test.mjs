// Cost attribution (#57 item 1): the pure ledger in lib/run-cost.mjs, its place in the run record, `P cost` and the
// cost / guard-block lines of `P summary`. The CLI tests run the real CLI against the scripted gh fake (gate-env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, scenario, ghEntries, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import {
  PHASES, ROLES, addCostEntry, listPriceUsd, modelFamily, addRetries, addSessions, costLines, costReport, emptyCost, readGuardLog, setGuardBlocks, usageFromTranscript,
} from '../pipeline/lib/run-cost.mjs';
import {
  STEPS, applyCheckpoint, decodeRecord, emptyRecord, encodeRecord, recordForOutcome, renderStatusBlock,
} from '../pipeline/lib/run-record.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';

const NOW = Date.parse('2026-10-14T10:00:00Z');
const rec = () => emptyRecord({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main' });
const entry = (o = {}) => ({ phase: 'build', role: 'implementer', input: 100, output: 50, cacheRead: 10, cacheWrite: 5, usd: 0.25, ...o });

// ---- the pure ledger -------------------------------------------------------------------------------------------------

test('PHASES is the record steps plus other (the lib cannot import STEPS: run-record imports it)', () => {
  assert.deepEqual([...PHASES], [...STEPS, 'other']);
});

test('addCostEntry: several entries are summed in the total, per phase and per role', () => {
  let c = addCostEntry(null, entry());
  c = addCostEntry(c, entry({ phase: 'review', role: 'judge', input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, usd: 1.5 }));
  c = addCostEntry(c, entry({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, usd: 0.1 }));
  assert.deepEqual(c.total, { input: 1101, output: 251, cacheRead: 11, cacheWrite: 6, usd: 1.85, calls: 3 });
  assert.deepEqual(c.byPhase.build, { input: 101, output: 51, cacheRead: 11, cacheWrite: 6, usd: 0.35, calls: 2 });
  assert.equal(c.byPhase.review.usd, 1.5);
  assert.equal(c.byRole.implementer.calls, 2);
  assert.equal(c.byRole.judge.input, 1000);
});

test('addCostEntry: an unknown role or phase is booked as other, and the input is not mutated', () => {
  const before = emptyCost();
  const c = addCostEntry(before, entry({ role: 'wizard', phase: 'lunch' }));
  assert.ok(c.byRole.other && !c.byRole.wizard);
  assert.ok(c.byPhase.other && !c.byPhase.lunch);
  assert.ok(ROLES.includes('other') && ROLES.includes('controller'));
  assert.deepEqual(before, emptyCost());
});

test('addCostEntry: a negative or non-numeric amount is refused', () => {
  assert.throws(() => addCostEntry(null, entry({ input: -1 })), /input tokens/);
  assert.throws(() => addCostEntry(null, entry({ usd: 'lots' })), /usd/);
  assert.throws(() => addCostEntry(null, entry({ output: 1.5 })), /whole number/);
});

test('retries, sessions and guard blocks: counted, de-duplicated, and null stays null', () => {
  let c = addRetries(null);
  c = addRetries(c, 2);
  assert.equal(c.retries, 3);
  c = addSessions(addSessions(c, ['s1', 's2']), ['s2']);
  assert.deepEqual(c.sessions, ['s1', 's2']);
  assert.throws(() => addSessions(c, ['has space']), /plain id/);
  assert.equal(emptyCost().guardBlocks, null);
  assert.equal(setGuardBlocks(c, 4).guardBlocks, 4);
});

// ---- the run record ---------------------------------------------------------------------------------------------------

test('a record from before cost attribution (no cost section) still decodes, renders and checkpoints', () => {
  const old = rec();
  assert.equal(old.cost, undefined);
  const decoded = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(old)}`);
  assert.equal(decoded.status, 'ok');
  assert.ok(!renderStatusBlock(old).includes('Cost'));
  assert.equal(applyCheckpoint(old, { step: 'verify' }, { host: 'h', now: NOW }).cost, undefined);
});

test('applyCheckpoint: cost patches add up across checkpoints and survive the comment round trip', () => {
  let r = applyCheckpoint(rec(), { cost: { entry: entry(), sessions: ['sess-1'] } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ role: 'verifier', phase: 'verify', usd: 0.05 }), retries: 1 } }, { host: 'h', now: NOW });
  const back = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(r)}`);
  assert.equal(back.status, 'ok');
  assert.equal(back.record.cost.total.usd, 0.3);
  assert.equal(back.record.cost.retries, 1);
  assert.deepEqual(back.record.cost.sessions, ['sess-1']);
  assert.throws(() => applyCheckpoint(rec(), { cost: 'free' }, { host: 'h', now: NOW }), /cost must be an object/);
});

test('a malformed cost section makes the record invalid instead of throwing in a reader', () => {
  const bad = { ...rec(), cost: 'free' };
  assert.equal(decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(bad)}`).status, 'invalid');
});

test('status block: shows totals, retries, guard blocks and the per-phase / per-role breakdown', () => {
  let r = applyCheckpoint(rec(), { cost: { entry: entry({ usd: 1.234 }), retries: 2, guardBlocks: 3 } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ role: 'judge', phase: 'review', input: 900, usd: 2 }) } }, { host: 'h', now: NOW });
  const block = renderStatusBlock(r);
  assert.match(block, /\*\*Cost:\*\* \$3\.23 · in 1,000 · out 100 · cache read 20 · cache write 10 · 2 calls/);
  assert.match(block, /\*\*Retries:\*\* 2 · \*\*Guard blocks:\*\* 3/);
  assert.match(block, /\*\*By phase:\*\* build \$1\.23 \(150 tok\) · review \$2\.00 \(950 tok\)/);
  assert.match(block, /\*\*By role:\*\* implementer \$1\.23 \(150 tok\) · judge \$2\.00 \(950 tok\)/);
});

test('costLines: an unknown guard count shows a dash; a cost section with nothing in it shows nothing', () => {
  assert.deepEqual(costLines(emptyCost()), []);
  assert.match(costLines(addRetries(null)).join('\n'), /Guard blocks:\*\* —/);
  assert.deepEqual(costLines(undefined), []);
});

test('recordForOutcome: sessions join the recorded ones; guardBlocks replaces the count; absent keeps both', () => {
  const start = applyCheckpoint(rec(), { cost: { sessions: ['a'], guardBlocks: 1 } }, { host: 'h', now: NOW });
  const same = recordForOutcome(start, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW });
  assert.deepEqual([same.record.cost.sessions, same.record.cost.guardBlocks], [['a'], 1]);
  const more = recordForOutcome(start, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW, sessions: ['b'], guardBlocks: 5 });
  assert.deepEqual([more.record.cost.sessions, more.record.cost.guardBlocks], [['a', 'b'], 5]);
});

// ---- guard log + transcripts ---------------------------------------------------------------------------------------

const tmp = () => mkdtempSync(join(tmpdir(), 'run-cost-'));
const logLine = (session, extra = {}) => JSON.stringify({ ts: '2026-10-14T01:00:00Z', session, hook: 'guard-git', reason_code: 'x', cmd_hash: 'abc', ...extra });

test('readGuardLog: absent file counts nothing and says so', () => {
  assert.deepEqual(readGuardLog(join(tmp(), 'nope.jsonl'), ['s1']), { present: false, blocks: 0, bySession: {}, skipped: 0 });
});

test('readGuardLog: counts only the named sessions, per session', () => {
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), logLine('s2'), logLine('s1'), logLine('other')].join('\n') + '\n');
  const r = readGuardLog(file, ['s1', 's2']);
  assert.deepEqual([r.present, r.blocks, r.bySession, r.skipped], [true, 3, { s1: 2, s2: 1 }, 0]);
  assert.equal(readGuardLog(file, []).blocks, 0);
});

test('readGuardLog: malformed lines are skipped and counted, never trusted or thrown', () => {
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), '{not json', '', JSON.stringify({ session: 42 }), '[]', 'null', logLine('s1')].join('\n'));
  const r = readGuardLog(file, ['s1']);
  assert.deepEqual([r.blocks, r.skipped], [2, 4]);
});

test('usageFromTranscript: sums message.usage, counting a streamed message id once', () => {
  const line = (id, u) => JSON.stringify({ type: 'assistant', message: { id, usage: u } });
  const text = [
    line('m1', { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }),
    line('m1', { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }),
    line('m2', { input_tokens: 1, output_tokens: 2 }),
    'garbage', JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  ].join('\n');
  assert.deepEqual(usageFromTranscript(text), { input: 4, output: 11, cacheRead: 100, cacheWrite: 10, usd: 0, messages: 2, unpricedMessages: 2 });
});

test('list prices: each transcript message at its own model, unknown models add tokens and no USD', () => {
  const line = (id, model, u) => JSON.stringify({ type: 'assistant', message: { id, model, usage: u } });
  const text = [
    line('a', 'claude-sonnet-5-5', { input_tokens: 1e6 }), // $3
    line('b', 'claude-opus-5-5', { output_tokens: 1e6, cache_read_input_tokens: 1e6 }), // $25 + $0.5
    line('c', 'claude-haiku-5-5', { cache_creation_input_tokens: 1e6 }), // $1.25
    line('d', 'some-other-model', { input_tokens: 1e6 }),
  ].join('\n');
  const u = usageFromTranscript(text);
  assert.equal(u.usd, 29.75);
  assert.equal(u.unpricedMessages, 1);
  assert.equal(u.input, 2e6);
  assert.equal(listPriceUsd('fable', { input: 1e6, output: 1e6 }), 75);
  assert.equal(listPriceUsd('gpt-5', { input: 1 }), null);
  assert.equal(modelFamily('Claude-Sonnet-5-5[1m]'), 'sonnet');
});

// ---- the CLI -------------------------------------------------------------------------------------------------------

const PATCH_77 = { match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' } };
function existing(record, sections = '') {
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (n, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record, sections });
  return { id: 77, user: { login: 'me' }, body, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' };
}
const withComment = (s, comment, extra = []) => s.fake.setScript(ghEntries({ prHead: s.head, comments: comment ? [comment] : [], extra: [PATCH_77, { match: '^pr view 12 --json title', stdoutJson: { title: 'T' } }, ...extra] }));
const written = (s) => {
  const w = s.fake.calls().filter((c) => c.argv[0] === 'api' && c.argv.includes('-X') && /issues\/(?:\d+\/comments|comments\/\d+)$/.test(c.argv.at(-3)));
  return decodeRecord(JSON.parse(w.at(-1).stdin).body).record;
};
const costCli = (s, args, env = {}) => cli(['cost', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });

test('P cost: books an entry into a fresh record, then adds to it', () => {
  const s = scenario();
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--input', '100', '--output', '50', '--cache-read', '7', '--cache-write', '3', '--usd', '0.4', '--session', 'sess-1']);
  assertExit(r, 0);
  assert.equal(r.json.recorded, true);
  assert.equal(r.json.cost.total.usd, 0.4);
  assert.deepEqual(r.json.cost.sessions, ['sess-1']);
  const first = written(s);
  withComment(s, existing(first));
  const r2 = costCli(s, ['--phase', 'review', '--role', 'wizard', '--input', '1', '--usd', '0.1', '--retry']);
  assertExit(r2, 0);
  assert.deepEqual([r2.json.cost.total.input, r2.json.cost.total.usd, r2.json.cost.retries], [101, 0.5, 1]);
  assert.ok(r2.json.cost.byRole.other, 'unknown role -> other');
  assert.equal(written(s).cost.byPhase.review.input, 1);
});

test('P cost: refuses nothing-to-record and bad amounts with exit 2 and writes no comment', () => {
  const s = scenario();
  const before = s.fake.calls().length;
  assertExit(costCli(s, ['--phase', 'build', '--role', 'judge']), 2);
  assertExit(costCli(s, ['--phase', 'build', '--role', 'judge', '--input', '-5']), 2);
  assertExit(costCli(s, ['--phase', 'build', '--role', 'judge', '--usd', 'abc']), 2);
  assert.equal(s.fake.calls().length, before);
});

test('P cost --from-transcript: the transcript usage is booked, explicit amounts add on top', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } } })}\n`);
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--output', '5']);
  assertExit(r, 0);
  assert.deepEqual([r.json.cost.total.input, r.json.cost.total.output, r.json.cost.total.cacheRead, r.json.cost.total.cacheWrite], [10, 25, 30, 40]);
  assertExit(costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/missing.jsonl']), 2);
});

test('P cost: USD from list prices (--model, transcript models); --usd wins; tokens with no price warn', () => {
  const s = scenario();
  const r = costCli(s, ['--phase', 'review', '--role', 'judge', '--input', '1000000', '--model', 'sonnet']);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.usd, 3);
  assert.deepEqual(r.json.warnings, []);
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } })}\n`);
  const t = costCli(scenario(), ['--phase', 'build', '--role', 'implementer', '--input', '10']);
  assertExit(t, 0);
  assert.equal(t.json.cost.total.usd, 0);
  assert.match(t.json.warnings.join('\n'), /without --model or --usd/);
  const s3 = scenario();
  s3.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } })}\n`);
  const w = costCli(s3, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl']);
  assertExit(w, 0);
  assert.equal(w.json.cost.total.usd, 25);
  const x = costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '1000000', '--model', 'sonnet', '--usd', '0.5']);
  assert.equal(x.json.cost.total.usd, 0.5);
  assertExit(costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '1', '--model', 'gpt']), 2);
});

const summary = (s, args, env = {}) => cli(['summary', '--pr', String(PR), '--outcome', 'merged', ...args], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
const withCost = (patch) => applyCheckpoint(rec(), { cost: patch }, { host: 'h', now: NOW });

test('P summary: an old record with no cost section works; the output cost is null and no cost line is written', () => {
  const s = scenario();
  withComment(s, existing(rec()));
  const r = summary(s, []);
  assertExit(r, 0);
  assert.equal(r.json.cost, null);
  assert.ok(!JSON.stringify(s.fake.calls()).includes('Cost:'));
  assert.equal(written(s).cost, undefined);
});

test('P summary: shows the totals and the breakdown in the output and in the comment', () => {
  const s = scenario();
  const record = withCost({ entry: entry({ usd: 2 }), retries: 1 });
  withComment(s, existing(record));
  const r = summary(s, []);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.usd, 2);
  assert.equal(r.json.cost.byPhase.build.calls, 1);
  assert.equal(r.json.cost.byRole.implementer.output, 50);
  const w = s.fake.calls().filter((c) => c.argv.includes('PATCH')).at(-1);
  const body = JSON.parse(w.stdin).body;
  assert.match(body, /\*\*Cost:\*\* \$2\.00/);
  assert.match(body, /\*\*By role:\*\* implementer \$2\.00/);
});

test('P summary: guard log absent -> no failure, the count stays unknown', () => {
  const s = scenario();
  withComment(s, existing(withCost({ entry: entry(), sessions: ['s1'] })));
  const r = summary(s, [], { PIPELINE_GUARD_LOG_FILE: join(tmp(), 'nope.jsonl') });
  assertExit(r, 0);
  assert.equal(r.json.cost.guardBlocks, null);
  assert.deepEqual(r.json.warnings, []);
});

test('P summary: guard log present -> counts the denies of the recorded sessions plus --session; malformed lines only warn', () => {
  const s = scenario();
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), logLine('s1'), logLine('s2'), logLine('stranger'), 'oops{'].join('\n') + '\n');
  withComment(s, existing(withCost({ entry: entry(), sessions: ['s1'] })));
  const r = summary(s, ['--session', 's2'], { PIPELINE_GUARD_LOG_FILE: file });
  assertExit(r, 0);
  assert.equal(r.json.cost.guardBlocks, 3);
  assert.deepEqual(r.json.cost.sessions, ['s1', 's2']);
  assert.ok(r.json.warnings.some((w) => /1 unreadable line/.test(w)));
  assert.equal(written(s).cost.guardBlocks, 3);
});

test('P summary: with no session known the guard log is not read at all', () => {
  const s = scenario();
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, `${logLine('s1')}\n`);
  withComment(s, existing(withCost({ entry: entry() })));
  const r = summary(s, [], { PIPELINE_GUARD_LOG_FILE: file });
  assertExit(r, 0);
  assert.equal(r.json.cost.guardBlocks, null);
});

// Codex review (#57) finding 6: --model is the default for transcript messages that carry no model
test('usageFromTranscript: a message with no model is priced at the default model; its own model still wins', () => {
  const line = (id, model, u) => JSON.stringify({ type: 'assistant', message: { id, ...(model ? { model } : {}), usage: u } });
  const text = [line('a', undefined, { input_tokens: 1e6 }), line('b', 'claude-opus-5-5', { output_tokens: 1e6 }), line('c', 'some-other-model', { input_tokens: 1e6 })].join('\n');
  const none = usageFromTranscript(text);
  assert.deepEqual([none.usd, none.unpricedMessages], [25, 2]);
  const dflt = usageFromTranscript(text, { defaultModel: 'sonnet' });
  assert.deepEqual([dflt.usd, dflt.unpricedMessages], [28, 1], 'a: $3 at sonnet; b: $25 at its own opus; c: an unknown model of its own stays unpriced');
});

test('P cost --from-transcript --model: transcript messages without model metadata are priced at --model; --usd still overrides', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 1000000 } } })}\n${JSON.stringify({ message: { id: 'n', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } })}\n`);
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--model', 'sonnet']);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.usd, 28);
  assert.deepEqual(r.json.warnings, []);
  const u = costCli(scenario(), ['--phase', 'build', '--role', 'implementer', '--input', '10', '--usd', '0.5', '--model', 'sonnet']);
  assert.equal(u.json.cost.total.usd, 0.5);
  const s2 = scenario();
  s2.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 1000000 } } })}\n`);
  assert.equal(costCli(s2, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--usd', '0.5', '--model', 'sonnet']).json.cost.total.usd, 0.5);
  const noModel = costCli(scenario(), ['--phase', 'build', '--role', 'implementer', '--input', '10']);
  assert.match(noModel.json.warnings.join('\n'), /without --model or --usd/);
});

// Codex review (#57) finding 7: the per-session guard counts are kept, not just their total
test('guard blocks by session: stored with the total, replaced on the next count, shown in the lines and the report, null on old records', () => {
  assert.equal(emptyCost().guardBySession ?? null, null);
  const c = setGuardBlocks(addRetries(null), 3, { s1: 2, s2: 1 });
  assert.deepEqual(c.guardBySession, { s1: 2, s2: 1 });
  assert.deepEqual(setGuardBlocks(c, 4, { s1: 4 }).guardBySession, { s1: 4 }, 'the new count replaces the old');
  assert.equal(setGuardBlocks(c, 3).guardBySession.s1, 2, 'a total alone leaves the per-session counts');
  assert.throws(() => setGuardBlocks(c, 1, { 'has space': 1 }), /plain id/);
  assert.throws(() => setGuardBlocks(c, 1, { s1: -1 }), /non-negative/);
  assert.match(costLines(c).join('\n'), /\*\*Guard blocks:\*\* 3 \(s1 2 · s2 1\)/);
  assert.deepEqual(costReport(c).guardBySession, { s1: 2, s2: 1 });
  assert.equal(costReport(addRetries(null)).guardBySession, null);
  const r = applyCheckpoint(rec(), { cost: { sessions: ['s1', 's2'], guardBlocks: 3, guardBySession: { s1: 2, s2: 1 } } }, { host: 'h', now: NOW });
  assert.deepEqual(r.cost.guardBySession, { s1: 2, s2: 1 });
  const kept = recordForOutcome(r, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW });
  assert.deepEqual(kept.record.cost.guardBySession, { s1: 2, s2: 1 });
  const next = recordForOutcome(r, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW, guardBlocks: 1, guardBySession: { s1: 1, s2: 0 } });
  assert.deepEqual(next.record.cost.guardBySession, { s1: 1, s2: 0 });
});

test('P summary: the per-session guard denies are recorded and reported', () => {
  const s = scenario();
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), logLine('s1'), logLine('s2'), logLine('stranger')].join('\n') + '\n');
  withComment(s, existing(withCost({ entry: entry(), sessions: ['s1', 's3'] })));
  const r = summary(s, ['--session', 's2'], { PIPELINE_GUARD_LOG_FILE: file });
  assertExit(r, 0);
  assert.deepEqual(r.json.cost.guardBySession, { s1: 2, s3: 0, s2: 1 });
  assert.deepEqual(written(s).cost.guardBySession, { s1: 2, s3: 0, s2: 1 });
  assert.match(JSON.parse(s.fake.calls().filter((c) => c.argv.includes('PATCH')).at(-1).stdin).body, /Guard blocks:\*\* 3 \(s1 2 · s2 1 · s3 0\)/);
  const absent = scenario();
  withComment(absent, existing(withCost({ entry: entry(), sessions: ['s1'] })));
  assert.equal(summary(absent, [], { PIPELINE_GUARD_LOG_FILE: join(tmp(), 'nope.jsonl') }).json.cost.guardBySession, null);
});
