// The weekly Codex-usage ledger (pipeline/lib/codex-usage.mjs): the append, the 7-day figure and the agent-log suffix.
// The ledger is a statistic: it must never throw, and a damaged file reads as "nothing recorded" rather than an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexUsage, codexUsageSuffix, recordCodexRun, usageFile } from '../pipeline/lib/codex-usage.mjs';

// scripts/test.mjs points the whole suite at a scratch ledger through the environment; these tests choose their own.
delete process.env.PIPELINE_CODEX_USAGE_FILE;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-11T12:00:00Z');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const line = (ago, over = {}) => JSON.stringify({ v: 1, ts: new Date(NOW - ago).toISOString(), repo: 'acme/widgets', pr: 7, round: 1, effort: 'high', model: 'gpt-x', ok: true, ...over });

test('recordCodexRun: appends one lower-cased JSON line per run under <home>/.claude/pipeline-state, creating the folders', (t) => {
  const home = scratch(t);
  const first = recordCodexRun({ repo: 'Acme/Widgets', pr: 7, round: 2, effort: 'xhigh', model: 'm', ok: false, resolutionOnly: true }, { home, env: {}, now: () => NOW });
  const second = recordCodexRun({ kind: 'second-review', repo: 'acme/widgets', pr: 7, round: 2, effort: 'high', model: 'm', ok: true }, { home, env: {}, now: () => NOW + 1000 });
  assert.deepEqual([first, second], [{ ok: true }, { ok: true }]);
  const file = join(home, '.claude', 'pipeline-state', 'codex-usage.jsonl');
  assert.equal(usageFile({ home, env: {} }), file);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { v: 1, ts: '2026-11-11T12:00:00.000Z', kind: 'review', repo: 'acme/widgets', pr: 7, round: 2, effort: 'xhigh', model: 'm', ok: false, resolutionOnly: true },
    { v: 1, ts: '2026-11-11T12:00:01.000Z', kind: 'second-review', repo: 'acme/widgets', pr: 7, round: 2, effort: 'high', model: 'm', ok: true },
  ]);
});

test('recordCodexRun: a ledger that cannot be written is a warning, never a throw (file under a regular file; symlinked file)', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'plain'), 'x');
  const blocked = recordCodexRun({ pr: 1, round: 1, effort: 'high', model: 'm', ok: true }, { file: join(dir, 'plain', 'codex-usage.jsonl'), env: {} });
  assert.equal(blocked.ok, false);
  assert.match(blocked.warning, /^codex usage ledger not written: /);

  const elsewhere = join(dir, 'elsewhere.jsonl');
  writeFileSync(elsewhere, '');
  const link = join(dir, 'link.jsonl');
  symlinkSync(elsewhere, link);
  const linked = recordCodexRun({ pr: 1, round: 1, effort: 'high', model: 'm', ok: true }, { file: link, env: {} });
  assert.equal(linked.ok, false, 'a symlinked ledger is refused, not followed');
  assert.equal(readFileSync(elsewhere, 'utf8'), '');

  // a symlinked pipeline-state folder under the home would move the ledger elsewhere
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'moved'));
  symlinkSync(join(dir, 'moved'), join(home, '.claude', 'pipeline-state'));
  assert.equal(recordCodexRun({ pr: 1, round: 1, effort: 'high', model: 'm', ok: true }, { home, env: {} }).ok, false);
  assert.equal(existsSync(join(dir, 'moved', 'codex-usage.jsonl')), false);
});

test('codexUsage: counts the last 7 days over every repo; an 8-day-old line is out, a failed run counts as failed', (t) => {
  const file = join(scratch(t), 'codex-usage.jsonl');
  writeFileSync(file, `${[
    line(8 * DAY),
    line(6 * DAY + 1000, { repo: 'acme/other', effort: 'xhigh' }),
    line(DAY, { ok: false }),
    line(1000, { effort: 'medium', kind: 'second-review' }),
    line(1000, { effort: 'high', resolutionOnly: true }),
  ].join('\n')}\n`);
  assert.deepEqual(codexUsage({ file, now: NOW, env: {} }), { runs: 4, high: 2, xhigh: 1, failed: 1 });
  assert.deepEqual(codexUsage({ file, now: NOW, days: 30, env: {} }), { runs: 5, high: 3, xhigh: 1, failed: 1 });
});

test('codexUsage: bad lines, a missing file and a far-future timestamp are skipped, never thrown', (t) => {
  const dir = scratch(t);
  assert.deepEqual(codexUsage({ file: join(dir, 'none.jsonl'), now: NOW, env: {} }), { runs: 0, high: 0, xhigh: 0, failed: 0 });
  const file = join(dir, 'codex-usage.jsonl');
  writeFileSync(file, [
    'not json', '', '{"v":1', 'null', '42', '[]', '{"ts":5}', '{"ts":"nope"}',
    line(DAY),
    line(-3 * DAY), // three days ahead: clock skew has a limit
    '{"v":1,"ts":"2026-11-10T00:00:00Z"}', // no effort or ok: still one run
  ].join('\n'));
  assert.deepEqual(codexUsage({ file, now: NOW, env: {} }), { runs: 2, high: 1, xhigh: 0, failed: 0 });
});

test('codexUsage: a directory where the file should be reads as nothing', (t) => {
  const dir = scratch(t);
  assert.deepEqual(codexUsage({ file: dir, now: NOW, env: {} }), { runs: 0, high: 0, xhigh: 0, failed: 0 });
});

test('codexUsageSuffix: nothing when no run; "xhigh" only when X > 0', () => {
  assert.equal(codexUsageSuffix({ runs: 0, high: 0, xhigh: 0, failed: 0 }), '');
  assert.equal(codexUsageSuffix(null), '');
  assert.equal(codexUsageSuffix({ runs: 12, high: 9, xhigh: 0, failed: 1 }), ' · Codex 7d: 12 runs (9 high)');
  assert.equal(codexUsageSuffix({ runs: 14, high: 9, xhigh: 3, failed: 0 }), ' · Codex 7d: 14 runs (9 high, 3 xhigh)');
  assert.equal(codexUsageSuffix({ runs: 1, high: 1, xhigh: 0, failed: 0 }), ' · Codex 7d: 1 run (1 high)');
});

test('usageFile: PIPELINE_CODEX_USAGE_FILE moves the ledger in a checkout; an injected file wins', () => {
  assert.equal(usageFile({ env: { PIPELINE_CODEX_USAGE_FILE: '/tmp/x/u.jsonl' } }), '/tmp/x/u.jsonl');
  assert.equal(usageFile({ file: '/tmp/y/u.jsonl', env: { PIPELINE_CODEX_USAGE_FILE: '/tmp/x/u.jsonl' } }), '/tmp/y/u.jsonl');
});
