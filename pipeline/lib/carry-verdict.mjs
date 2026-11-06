// approvalVerdict (hooks/lib/owner-go.mjs) consults its carry callback SYNCHRONOUSLY, but the proof it needs (carriesApproval) is async.
// So the verdict is asked twice: a first time with a collecting callback (it records the prefixes the owner approved with the Carry line and
// refuses them all), then the proofs are made for exactly those prefixes, then it is asked again with a callback that answers from them.
// Nothing is cached across calls (a fresh memo each time): the proof depends on the head and base of THIS call.
import { approvalVerdict } from '../hooks/lib/owner-go.mjs';

/**
 * @param {object} q  the query approvalVerdict takes (repo, pr, head, items, areas, hold, rulings, home?); `carry` / `carryMemo` are set here.
 * @param {(c: {prefix: string, request: object, record: object}) => Promise<{ok: boolean, from?: string, reason?: string}>} prove
 * @returns {Promise<{gap: 'ok'|'none'|'provenance'|'carry', reason?: string, carriedFrom?: string, carriedPrefix?: string, proofs: Map<string, object>}>}
 */
export async function carryVerdict(q, prove) {
  const asked = [];
  const first = approvalVerdict({
    ...q, carryMemo: new Map(), carry: (c) => { asked.push(c); return { ok: false, reason: 'not proven yet' }; },
  });
  const proofs = new Map();
  if (asked.length === 0) return { ...first, proofs }; // an exact-head record, or no carry request at all
  for (const c of asked) {
    let v;
    try {
      v = await prove(c);
    } catch (err) {
      v = { ok: false, reason: String(err?.message ?? err) };
    }
    proofs.set(c.prefix, v);
  }
  const second = approvalVerdict({
    ...q, carryMemo: new Map(), carry: ({ prefix }) => proofs.get(prefix) ?? { ok: false, reason: 'no proof was made for this approval' },
  });
  return { ...second, proofs };
}
