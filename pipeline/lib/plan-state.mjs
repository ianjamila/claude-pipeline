// Plan evidence on a PR (spec 2026-10-19 §§2-4, trust model): PR event comments are POINTERS only (anything on GitHub is
// writable with the agent's token). Approval is verified only against a local owner-go plan record; scope and tasks are
// always re-parsed from the approved git blob. Pure: callers pass events (listEvents), local records and a blob reader.
import { parsePlan, outsideScope, scopeDigest } from './plan.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const KEY_RE = /^[A-Za-z0-9._-]{1,48}$/;
const usable = (e) => e && !e.tampered && e.dataStatus === 'ok';
export const bindOf = ({ repo, pr, branch }) => ({ repo, pr, branch });
const binds = (e, b) => e.data?.repo === b.repo && e.data?.pr === b.pr && e.data?.branch === b.branch;
const hostWord = (h) => String(h ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';

export function activeProposal(events, bind) {
  const props = (events ?? []).filter((e) => e.kind === 'plan-proposed');
  const last = props.at(-1);
  if (!last) return { status: 'none' };
  if (!usable(last)) return { status: 'lost', reason: `the latest plan proposal (comment ${last.commentId}) is ${last.tampered ? 'edited' : 'unreadable'}` };
  if (!binds(last, bind) || !HEX40.test(String(last.data.blob))) return { status: 'lost', reason: `the latest plan proposal (comment ${last.commentId}) does not belong to this PR` };
  return { status: 'ok', event: last, blob: last.data.blob, path: String(last.data.path ?? ''), scopeDigest: last.data.scopeDigest, n: props.length };
}

export function latestApproval(events, bind) {
  const plan = (events ?? []).filter((e) => e.kind === 'plan-proposed' || e.kind === 'plan-approved');
  const i = plan.findLastIndex((e) => e.kind === 'plan-approved');
  if (i < 0) return { status: 'none' };
  const ap = plan[i];
  const bad = plan.slice(i).find((e) => !usable(e));
  if (bad) return { status: 'lost', reason: `plan evidence comment ${bad.commentId} is ${bad.tampered ? 'edited' : 'unreadable'}` };
  if (!binds(ap, bind) || !HEX40.test(String(ap.data.blob))) return { status: 'lost', reason: `the latest approval (comment ${ap.commentId}) does not belong to this PR` };
  return { status: 'approved', event: ap, blob: ap.data.blob, path: String(ap.data.path ?? ''), recordId: ap.data.recordId, promptSha256: ap.data.promptSha256, host: hostWord(ap.data.host) };
}

export const matchingLocalRecord = (records, w) => (records ?? []).find((r) => r.pr === w.pr && r.blob === w.blob && r.scopeDigest === w.scopeDigest
  && (w.recordId === undefined || r.recordId === w.recordId) && (w.promptSha256 === undefined || r.promptSha256 === w.promptSha256)) ?? null;

function parsedBlob(readBlob, blob) {
  const text = readBlob(blob);
  if (text == null) return { error: `the approved plan blob ${blob.slice(0, 12)} is not in this clone` };
  try { return { plan: parsePlan(text) }; } catch (err) { return { error: `the approved plan no longer parses (${err.message})` }; }
}

export function planScopeVerdict({ events, bind, recordPlan, localRecords, readBlob, files, required, ownerApproval }) {
  const lost = (reason) => ({ status: 'lost', reason });
  let v;
  const ap = latestApproval(events, bind);
  const trace = (events ?? []).some((e) => e.kind === 'plan-proposed') || recordPlan != null || (localRecords ?? []).some((r) => r.pr === bind.pr);
  if (ap.status === 'lost') v = lost(ap.reason);
  else if (ap.status === 'none') v = trace ? lost('a plan was proposed or approved here, but no approval comment is on the PR') : { status: 'none', items: ['plan-scope none'] };
  else {
    const p = parsedBlob(readBlob, ap.blob);
    if (p.error) v = lost(p.error);
    else {
      const digest = scopeDigest(p.plan.scope);
      const verified = matchingLocalRecord(localRecords, { pr: bind.pr, blob: ap.blob, scopeDigest: digest, recordId: ap.recordId, promptSha256: ap.promptSha256 });
      // No exemption from event data (an agent can forge `path`, Codex plan R1-1): the plan file is in its own scope.
      const items = outsideScope({ files, scope: p.plan.scope }).map((f) => `plan-scope outside ${f}`);
      if (!verified) items.push(`plan-scope unverified ${ap.host}`);
      v = { status: 'approved', items, verified: Boolean(verified) };
    }
  }
  if (!required) return { ok: true, detail: `report only (plan.required: false): ${v.status}${v.items?.length ? `, ${v.items.length} item(s)` : ''}`, ownerMerge: 0, ownerItems: [] };
  if (v.status === 'lost') return { ok: false, detail: `lost: ${v.reason}. Recovery: re-show the active plan request; the owner's new "approve" clears it`, ownerMerge: 0, ownerItems: [] };
  if (v.items.length === 0) return { ok: true, detail: 'every changed file is in the approved plan scope', ownerMerge: 0, ownerItems: [] };
  const shown = v.items.slice(0, 5).join('; ') + (v.items.length > 5 ? '; ...' : '');
  if (ownerApproval !== 'chat') return { ok: false, detail: `${v.items.length} plan-scope item(s): ${shown}`, ownerMerge: 0, ownerItems: [] };
  return { ok: true, detail: `${v.items.length} owner-merge plan-scope item(s): ${shown}`, ownerMerge: v.items.length, ownerItems: v.items };
}

export function startsValidity(events, { caps = { codex: 2, fable: 1 } } = {}) {
  const used = { codex: 0, fable: 0 };
  const extras = { codex: 0, fable: 0 };
  const seen = new Set();
  const out = [];
  for (const e of (events ?? []).filter((x) => x.kind === 'plan-review-started')) {
    if (!usable(e) || !Object.hasOwn(caps, e.data?.reviewer) || !KEY_RE.test(String(e.data?.key))) {
      // An edited or unreadable start still spent a slot as far as anyone can tell: count it against every reviewer.
      for (const r of Object.keys(used)) used[r] += 1;
      continue;
    }
    const r = e.data.reviewer;
    const k = `${r}:${e.data.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const extra = typeof e.data.extra === 'string' && e.data.extra.trim() ? e.data.extra.trim() : null;
    if (extra) extras[r] += 1;
    const valid = used[r] < caps[r] + extras[r];
    // A void start launched nothing, so it takes no slot: one owner extra after it buys exactly one more run
    // (clarifies spec §3 "position": the position among slot-taking starts). It is never revived later.
    if (valid) used[r] += 1;
    out.push({ reviewer: r, key: e.data.key, commentId: e.commentId, createdAt: e.createdAt, valid, extra, planBlob: e.data.planBlob ?? null, claim: typeof e.data.claim === 'string' ? e.data.claim : null });
  }
  return out;
}

// Open work is judged against the APPROVED blob's tasks, never against the record alone (Codex plan R1-5): when the
// plan-approved event was posted but the checkpoint that copies tasks failed, the record has no tasks (or stale ones),
// and every approved task that is not done in the record with the same specSha is open.
export function planResumeFacts({ events, bind, recordPlan, localRecords, recordTasks, readBlob }) {
  const active = activeProposal(events, bind);
  const ap = latestApproval(events, bind);
  const evidence = active.status !== 'none' || ap.status !== 'none' || recordPlan != null || (localRecords ?? []).some((r) => r.pr === bind.pr);
  if (active.status === 'lost') return { evidence, active: null, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: active.reason };
  if (ap.status === 'lost') return { evidence, active, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: ap.reason };
  const approvedActive = ap.status === 'approved' && active.status === 'ok' && ap.blob === active.blob;
  if (!approvedActive) return { evidence, active: active.status === 'ok' ? active : null, approval: 'none', openWork: true, needsApproveCheckpoint: false };
  const p = parsedBlob(readBlob, ap.blob);
  if (p.error) return { evidence, active, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: p.error };
  const verified = matchingLocalRecord(localRecords, { pr: bind.pr, blob: ap.blob, scopeDigest: scopeDigest(p.plan.scope), recordId: ap.recordId, promptSha256: ap.promptSha256 });
  const done = new Set((recordTasks ?? []).filter((t) => t.done === true && typeof t.specSha === 'string').map((t) => `${t.id}\n${t.specSha}`));
  const openWork = p.plan.tasks.some((t) => !done.has(`${t.id}\n${t.specSha}`));
  // The approval event exists but the record never got it (checkpoint failed): resume re-runs `P plan approve`, which
  // reuses the event and copies the approved tasks into the record before any build step.
  const needsApproveCheckpoint = recordPlan?.blob !== ap.blob || recordPlan?.state !== 'approved'
    || p.plan.tasks.some((t) => !(recordTasks ?? []).some((r) => r.id === t.id && r.specSha === t.specSha));
  return { evidence, active, approval: verified ? 'verified' : 'unverified', openWork, needsApproveCheckpoint };
}
