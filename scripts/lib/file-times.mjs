// Pure helpers for the time-weighted Windows shards: folding the per-file lines the preload writes, the marker lines CI prints
// around the result, and the median over several runs (scripts/shard-weights.mjs writes scripts/lib/test-weights.json).
export const MARK_BEGIN = 'CP-FILE-TIMES-BEGIN';
export const MARK_END = 'CP-FILE-TIMES-END';

const baseName = (p) => String(p).split(/[\\/]/).pop();
const validMs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// [{ file, ms }] (the preload's lines) -> { 'x.test.mjs': { spanMs } }, keyed by base name, the longest span per file.
export function collectFileTimes(lines) {
  const out = {};
  for (const l of lines) {
    if (!l || typeof l.file !== 'string' || !validMs(l.ms)) continue;
    const name = baseName(l.file);
    if (!name) continue;
    const spanMs = Math.round(l.ms);
    if (!(out[name]?.spanMs >= spanMs)) out[name] = { spanMs };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// The { file: { spanMs } } JSON that CI printed between the marker lines of a job log, or null when it is not there / not JSON.
// A GitHub log line is `<job>\t<step>\t<timestamp> <text>` with CRLF endings; only the text after the timestamp counts.
export function extractTimes(logText) {
  const text = (line) => line.replace(/\r$/, '').replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trim();
  const lines = String(logText).split('\n').map(text);
  const begin = lines.lastIndexOf(MARK_BEGIN);
  if (begin < 0) return null;
  const end = lines.indexOf(MARK_END, begin + 1);
  if (end < 0) return null;
  try {
    const j = JSON.parse(lines.slice(begin + 1, end).join(''));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// [{ file: { spanMs } }, ...] (one per run) -> { file: median ms } for the files measured, rounded, sorted by name.
export function medianWeights(runs) {
  const per = new Map();
  for (const run of runs) {
    for (const [name, v] of Object.entries(run ?? {})) {
      if (validMs(v?.spanMs)) per.set(name, [...(per.get(name) ?? []), v.spanMs]);
    }
  }
  const out = {};
  for (const name of [...per.keys()].sort()) {
    const xs = per.get(name).sort((a, b) => a - b);
    const mid = xs.length >> 1;
    out[name] = Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
  }
  return out;
}
