// Splits the test files into N bins for the sharded Windows CI jobs. Pure: the same files give the same bins on every
// runner, because each shard computes its own bin independently and the bins must partition the suite.
export const MAX_SHARDS = 8;

// 'I/N' -> { i, n }, or null when it is not two plain integers with 1 <= I <= N <= MAX_SHARDS.
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec ?? ''));
  if (!m) return null;
  const i = Number(m[1]);
  const n = Number(m[2]);
  return i >= 1 && n >= 1 && i <= n && n <= MAX_SHARDS ? { i, n } : null;
}

const usable = (w) => typeof w === 'number' && Number.isFinite(w) && w > 0;

// What one file weighs in a bin: its measured ms (scripts/lib/test-weights.json) when known, else its bytes times the median
// ms/byte of the measured files, so a new file lands near where its size says. With nothing measured the weight is the size.
export function weigh(files, weights) {
  const known = weights && typeof weights === 'object' ? weights : {};
  const rates = files.filter((f) => usable(known[f.name]) && f.size > 0).map((f) => known[f.name] / f.size).sort((a, b) => a - b);
  const mid = rates.length >> 1;
  const rate = rates.length === 0 ? 1 : rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  return new Map(files.map((f) => [f.name, usable(known[f.name]) ? known[f.name] : f.size * rate]));
}

// Longest-first greedy on weight: heaviest file first (ties by name), each into the currently lightest bin (ties to the lowest
// bin). Weight is measured time when `weights` ({ name: ms }) knows the file, else bytes (see weigh). Returns bin i (1-based) as
// sorted file names; a bin can be empty when files < n. Deterministic: depends only on the names, sizes and weights.
export function shardFiles(files, i, n, weights = {}) {
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const weight = weigh(files, weights);
  const order = [...files].sort((a, b) => weight.get(b.name) - weight.get(a.name) || byName(a.name, b.name));
  const bins = Array.from({ length: n }, () => ({ size: 0, names: [] }));
  for (const f of order) {
    let lightest = bins[0];
    for (const b of bins) if (b.size < lightest.size) lightest = b;
    lightest.size += weight.get(f.name);
    lightest.names.push(f.name);
  }
  return bins[i - 1].names.sort(byName);
}
