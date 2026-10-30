// The READER of the 60 s inventory cache ({ writtenAt: <epoch ms>, inventory: { dockerDown, stacks } }), apart from inventory.mjs
// (docker probing, config, realpath) so the register hook's cheap pre-check (fastpath.mjs) can read the cache without loading
// all of that. inventory.mjs re-exports cachedInventory, so every existing import keeps working; refreshCache, the writer, stays
// there. Only node:fs is imported.
import fs from 'node:fs';

export const DEFAULT_MAX_AGE_MS = 60000;

const validInventory = (v) => v && typeof v === 'object' && typeof v.dockerDown === 'boolean' && Array.isArray(v.stacks);

// { inv, fresh }: inv is the cached inventory value (or null when there is no usable cache), fresh says it is younger than
// maxAgeMs. A stale cache is still returned; this never refreshes (callers decide, via refreshCache). A cache dated in
// the future (clock moved back) is never fresh.
export function cachedInventory({ file, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { inv: null, fresh: false };
  }
  if (!j || !Number.isFinite(j.writtenAt) || !validInventory(j.inventory)) return { inv: null, fresh: false };
  const age = now - j.writtenAt;
  return { inv: j.inventory, fresh: age >= 0 && age < maxAgeMs };
}
