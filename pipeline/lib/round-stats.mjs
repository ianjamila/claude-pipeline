// Round pile-up stats for `P state outcome` (plan 2026-11-11-codex-substitute-reviewer, "also worth considering"): how many items each round raised, by bucket,
// and how often a finding that was already ruled came back in a later round (the same fingerprint). Display only: nothing here decides a review.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function roundStats(state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const seen = new Map(); // fingerprint -> { ruled }
  let reRaised = 0;
  let ruledReRaised = 0;
  const perRound = rounds.map((r) => {
    const byBucket = {};
    const items = (Array.isArray(r?.items) ? r.items : []).filter(isObject);
    for (const item of items) {
      const bucket = typeof item.bucket === 'string' && item.bucket !== '' ? item.bucket : 'UNKNOWN';
      byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;
      const fp = typeof item.fingerprint === 'string' && item.fingerprint !== '' ? item.fingerprint : null;
      if (fp === null) continue;
      const before = seen.get(fp);
      if (before) {
        reRaised += 1;
        if (before.ruled) ruledReRaised += 1;
      }
      seen.set(fp, { ruled: Boolean(before?.ruled) || isObject(item.final) });
    }
    return { n: r?.n ?? null, items: items.length, byBucket };
  });
  return { rounds: perRound, reRaised, ruledReRaised };
}
