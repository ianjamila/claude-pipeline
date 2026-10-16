// Summarises the guard deny log (<home>/.claude/pipeline-state/guard-log.jsonl, written by the two guard hooks through
// hooks/lib/deny-log.mjs): denies per day and per reason code over the last N days, so a false-block rate can be read
// without scraping transcripts. Read-only; a missing file is an empty summary, unreadable lines are counted, not fatal.
import { readFileSync } from 'node:fs';
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guardLogFile } from '../hooks/lib/deny-log.mjs';

export const meta = {
  summary: 'count guard denies per day and reason code from the deny log',
  usage: 'pipeline guard-log [--days N] [--file PATH]   -> {ok, file, days:{YYYY-MM-DD:{total,byCode}}, total, perDay, skipped}; default 7 days',
};

const round1 = (n) => Math.round(n * 10) / 10;

export function summarize(text, { days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * 86400000;
  const byDay = {};
  let total = 0;
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry;
    try { entry = JSON.parse(line); } catch { skipped += 1; continue; }
    const at = typeof entry?.ts === 'string' ? Date.parse(entry.ts) : NaN;
    if (entry === null || typeof entry !== 'object' || Number.isNaN(at)) { skipped += 1; continue; }
    if (at < cutoff) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const code = typeof entry.reason_code === 'string' && entry.reason_code !== '' ? entry.reason_code : 'other';
    const bucket = (byDay[day] ??= { total: 0, byCode: {} });
    bucket.total += 1;
    bucket.byCode[code] = (bucket.byCode[code] ?? 0) + 1;
    total += 1;
  }
  const dayNames = Object.keys(byDay).sort();
  const sorted = Object.fromEntries(dayNames.map((d) => [d, byDay[d]]));
  return { days: sorted, total, perDay: dayNames.length === 0 ? 0 : round1(total / dayNames.length), skipped };
}

export async function run(argv, ctx = {}) {
  const { values } = parseCommandArgs(argv, { days: { type: 'string' }, file: { type: 'string' } }, { allowPositionals: false });
  const days = intOption(values, 'days', { min: 1, max: 3650 }) ?? 7;
  const file = values.file ?? guardLogFile();
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* no log yet: zero totals */ }
  const now = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  return { exitCode: EXIT.OK, output: { ok: true, file, ...summarize(text, { days, now }) } };
}
