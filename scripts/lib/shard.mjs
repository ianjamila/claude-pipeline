// Splits the test files into N bins for the sharded Windows CI jobs. Pure: the same files give the same bins on every
// runner, because each shard computes its own bin independently and the bins must partition the suite.
export const MAX_SHARDS = 8;

// "I/N" -> { i, n }, or null when it is not two plain integers with 1 <= I <= N <= MAX_SHARDS.
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec ?? ''));
  if (!m) return null;
  const i = Number(m[1]);
  const n = Number(m[2]);
  return i >= 1 && n >= 1 && i <= n && n <= MAX_SHARDS ? { i, n } : null;
}

// Longest-first greedy on file size in bytes: biggest file first (ties by name), each into the currently lightest bin
// (ties to the lowest bin). Returns bin i (1-based) as sorted file names; a bin can be empty when files < n.
export function shardFiles(files, i, n) {
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const order = [...files].sort((a, b) => b.size - a.size || byName(a.name, b.name));
  const bins = Array.from({ length: n }, () => ({ size: 0, names: [] }));
  for (const f of order) {
    let lightest = bins[0];
    for (const b of bins) if (b.size < lightest.size) lightest = b;
    lightest.size += f.size;
    lightest.names.push(f.name);
  }
  return bins[i - 1].names.sort(byName);
}
