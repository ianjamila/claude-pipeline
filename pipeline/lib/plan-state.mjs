// Plan evidence on a PR (spec 2026-10-19 §§2-4, trust model): PR event comments are POINTERS only (anything on GitHub is
// writable with the agent's token). Approval is verified only against a local owner-go plan record; scope and tasks are
// always re-parsed from the approved git blob. Pure: callers pass events (listEvents), local records and a blob reader.
import { parsePlan, outsideScope, scopeDigest } from './plan.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
// The formats the owner-go recorder writes (record_id = 8 random bytes, prompt_sha256 = sha256 hex): an approval event without
// both is no evidence of anything and never matches a local record.
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
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

// Records of THIS repo: a record that names another repo is no evidence here (same PR number + byte-identical plan blob in a
// different repo must not replay an approval). A record without `repo` (older, or recorded outside a repo) is kept: it matches on
// pr + blob + scope digest alone (the documented residual). GitHub's case differences do not matter.
export const recordsForRepo = (records, repo) => (records ?? []).filter((r) => r.repo == null || String(r.repo).toLowerCase() === String(repo).toLowerCase());

const tsOf = (r) => { const n = Date.parse(r?.ts); return Number.isFinite(n) ? n : -Infinity; };
// The owner's newest approval record for this PR (any blob): the only one an approval is verified against (a replayed
// event for an older approved blob must not out-vote a newer "approve", F4).
export const newestLocalRecord = (records, pr) => (records ?? []).filter((r) => r.pr === pr).reduce((best, r) => (best === null || tsOf(r) > tsOf(best) ? r : best), null);

// With `localRecords`, the approval is the event that points at the owner's newest record when there is one; otherwise the
// newest event by comment id (it will not verify against the newest record, so the caller reports it unverified).
export function latestApproval(events, bind, localRecords) {
  const plan = (events ?? []).filter((e) => e.kind === 'plan-proposed' || e.kind === 'plan-approved');
  let i = plan.findLastIndex((e) => e.kind === 'plan-approved');
  if (i < 0) return { status: 'none' };
  const newest = Array.isArray(localRecords) ? newestLocalRecord(localRecords, bind.pr) : null;
  if (newest) {
    const hit = plan.findLastIndex((e) => e.kind === 'plan-approved' && usable(e) && binds(e, bind) && e.data.recordId === newest.recordId && e.data.promptSha256 === newest.promptSha256 && e.data.blob === newest.blob);
    if (hit >= 0 && hit < i) i = hit;
  }
  const ap = plan[i];
  const bad = plan.slice(i).find((e) => !usable(e));
  if (bad) return { status: 'lost', reason: `plan evidence comment ${bad.commentId} is ${bad.tampered ? 'edited' : 'unreadable'}` };
  if (!binds(ap, bind) || !HEX40.test(String(ap.data.blob))) return { status: 'lost', reason: `the latest approval (comment ${ap.commentId}) does not belong to this PR` };
  return { status: 'approved', event: ap, blob: ap.data.blob, path: String(ap.data.path ?? ''), recordId: HEX16.test(String(ap.data.recordId)) ? ap.data.recordId : null, promptSha256: HEX64.test(String(ap.data.promptSha256)) ? ap.data.promptSha256 : null, host: hostWord(ap.data.host) };
}

// A missing or malformed recordId / promptSha256 on the wanted side matches NOTHING (it is never a wildcard, F3).
export const matchingLocalRecord = (records, w) => (!HEX16.test(String(w.recordId)) || !HEX64.test(String(w.promptSha256)) ? null
  : (records ?? []).find((r) => r.pr === w.pr && r.blob === w.blob && r.scopeDigest === w.scopeDigest && r.recordId === w.recordId && r.promptSha256 === w.promptSha256) ?? null);

// The approval is verified only when its local record exists AND is the owner's newest for this PR (F4).
export function verifiedApproval(ap, localRecords, { pr, digest }) {
  const m = matchingLocalRecord(localRecords, { pr, blob: ap.blob, scopeDigest: digest, recordId: ap.recordId, promptSha256: ap.promptSha256 });
  const newest = newestLocalRecord(localRecords, pr);
  return m && newest && m.recordId === newest.recordId ? m : null;
}

function parsedBlob(readBlob, blob) {
  const text = readBlob(blob);
  if (text == null) return { error: `the approved plan blob ${blob.slice(0, 12)} is not in this clone` };
  try { return { plan: parsePlan(text) }; } catch (err) { return { error: `the approved plan no longer parses (${err.message})` }; }
}

export function planScopeVerdict({ events, bind, recordPlan, localRecords: allRecords, readBlob, files, required, ownerApproval }) {
  const localRecords = recordsForRepo(allRecords, bind.repo);
  const lost = (reason) => ({ status: 'lost', reason });
  let v;
  const ap = latestApproval(events, bind, localRecords);
  const trace = (events ?? []).some((e) => e.kind === 'plan-proposed') || recordPlan != null || (localRecords ?? []).some((r) => r.pr === bind.pr);
  if (!Array.isArray(files)) v = lost('the changed-file list is unavailable, so the plan scope cannot be checked');
  else if (ap.status === 'lost') v = lost(ap.reason);
  else if (ap.status === 'none') v = trace ? lost('a plan was proposed or approved here, but no approval comment is on the PR') : { status: 'none', items: ['plan-scope none'] };
  else {
    const p = parsedBlob(readBlob, ap.blob);
    if (p.error) v = lost(p.error);
    else {
      const digest = scopeDigest(p.plan.scope);
      const verified = verifiedApproval(ap, localRecords, { pr: bind.pr, digest });
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
export function planResumeFacts({ events, bind, recordPlan, localRecords: allRecords, recordTasks, readBlob }) {
  const localRecords = recordsForRepo(allRecords, bind.repo);
  const active = activeProposal(events, bind);
  const ap = latestApproval(events, bind, localRecords);
  const evidence = active.status !== 'none' || ap.status !== 'none' || recordPlan != null || (localRecords ?? []).some((r) => r.pr === bind.pr);
  if (active.status === 'lost') return { evidence, active: null, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: active.reason };
  if (ap.status === 'lost') return { evidence, active, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: ap.reason };
  const approvedActive = ap.status === 'approved' && active.status === 'ok' && ap.blob === active.blob;
  if (!approvedActive) return { evidence, active: active.status === 'ok' ? active : null, approval: 'none', openWork: true, needsApproveCheckpoint: false };
  const p = parsedBlob(readBlob, ap.blob);
  if (p.error) return { evidence, active, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: p.error };
  const verified = verifiedApproval(ap, localRecords, { pr: bind.pr, digest: scopeDigest(p.plan.scope) });
  const done = new Set((recordTasks ?? []).filter((t) => t.done === true && typeof t.specSha === 'string').map((t) => `${t.id}\n${t.specSha}`));
  const openWork = p.plan.tasks.some((t) => !done.has(`${t.id}\n${t.specSha}`));
  // The approval event exists but the record never got it (checkpoint failed): resume re-runs `P plan approve`, which
  // reuses the event and copies the approved tasks into the record before any build step.
  const needsApproveCheckpoint = recordPlan?.blob !== ap.blob || recordPlan?.state !== 'approved'
    || p.plan.tasks.some((t) => !(recordTasks ?? []).some((r) => r.id === t.id && r.specSha === t.specSha));
  return { evidence, active, approval: verified ? 'verified' : 'unverified', openWork, needsApproveCheckpoint };
}
