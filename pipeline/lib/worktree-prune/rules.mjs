// Pure decisions for `pipeline worktrees` (spec docs/specs/2026-10-13-worktree-prune-design.md §3–§4). No I/O here:
// everything is a function of the facts gathered by inspect.mjs / prs.mjs, so every rule arm is unit-testable.
import { createHash } from 'node:crypto';

// spec §3 mode table. dryRun overrides everything to "evaluate only".
const TABLE = {
  evaluate: { off: false, report: true, on: true },
  remove: { off: false, report: false, on: true },
  'restore-leftover': { off: true, report: true, on: true },
  purge: { off: false, report: false, on: true },
  'keep-lock': { off: true, report: true, on: true },
};
export const MODE_ACTIONS = Object.freeze(Object.keys(TABLE));

export function modeAllows(mode, action, { dryRun = false } = {}) {
  const row = TABLE[action];
  if (!row) throw new Error(`unknown action: ${action}`);
  if (dryRun) return action === 'evaluate';
  return row[mode] === true;
}

export const lockNameFor = (commonDir) => `worktrees-prune-${createHash('sha256').update(commonDir).digest('hex').slice(0, 12)}`;

const base = (p) => p.slice(p.lastIndexOf('/') + 1);
export function matchesPattern(rel, pattern) {
  if (pattern.endsWith('/')) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
  if (pattern.startsWith('*.')) return base(rel).endsWith(pattern.slice(1));
  return rel === pattern;
}

export const ALWAYS_BLOCK = Object.freeze([/(^|\/)\.env/, /(^|\/)HANDOFF[^/]*\.md$/i, /\.patch$/]);

// entries: [{ path (posix, relative), kind, isSymlink }]. A `.superpowers` symlink is allowed (removal unlinks it only);
// anything under a real `.superpowers/` directory blocks. An archive pattern wins over a delete pattern: evidence is
// never deleted, so `.verify/logs/tests.log` is archived even though the default `*.log` would delete it.
export function classifyEntries(entries, { delete: del, archive }) {
  const out = { del: [], arch: [], blockers: [] };
  for (const e of entries) {
    const p = e.path;
    if (p === '.superpowers' && e.isSymlink) continue;
    if (e.kind === 'tracked-change' || e.kind === 'untracked') { out.blockers.push(p); continue; }
    if (ALWAYS_BLOCK.some((re) => re.test(p))) { out.blockers.push(p); continue; }
    if (archive.some((pat) => matchesPattern(p, pat))) out.arch.push(p);
    else if (del.some((pat) => matchesPattern(p, pat))) out.del.push(p);
    else out.blockers.push(p);
  }
  return out;
}

// prs: same-branch PRs from prs.mjs. spec §4 rule 3.
export function selectLifecycle(prs, { nowMs, minMergedHours }) {
  if (prs.length === 0) return { ok: false, reason: 'no PR' };
  if (prs.some((p) => p.isCrossRepository)) return { ok: false, reason: 'ambiguous: fork PR with the same branch name' };
  const open = prs.find((p) => p.state === 'OPEN');
  if (open) return { ok: false, reason: `open PR #${open.number} on this branch` };
  const t = (p) => Date.parse(p.createdAt);
  const sorted = [...prs].sort((a, b) => t(b) - t(a));
  const newest = sorted[0];
  if (!Number.isFinite(t(newest))) return { ok: false, reason: `PR #${newest.number} has no valid creation time` };
  const tied = sorted.filter((p) => t(p) === t(newest));
  if (tied.length > 1) return { ok: false, reason: `ambiguous order: PRs ${tied.map((p) => `#${p.number}`).sort().join(', ')} created at the same time` };
  if (newest.state !== 'MERGED') return { ok: false, reason: `newest PR #${newest.number} was closed without merging` };
  const merged = Date.parse(newest.mergedAt);
  if (!Number.isFinite(merged) || merged > nowMs) return { ok: false, reason: `PR #${newest.number} has no valid merge time` };
  if (nowMs - merged < minMergedHours * 3600e3) return { ok: false, reason: `PR #${newest.number} merged less than ${minMergedHours}h ago` };
  return { ok: true, pr: newest };
}

const glob = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
export const isProtectedName = (slug, protect) => protect.some((p) => glob(p).test(slug));

// signals: { locked: string|null, processes: {available, pids, hidden}, transcripts: string[], memoryNotes: string[], recentFiles: string[] }
// `processes.hidden` (other users' processes we may not inspect) is reported, never a keep reason: every non-root user
// sees root daemons that way, so it would keep everything. The quarantine re-inspection catches their writes (spec §2).
export function inUseReasons(s) {
  const r = [];
  if (s.locked !== null && s.locked !== undefined) r.push(`locked (${s.locked || 'no reason given'})`);
  if (!s.processes.available) r.push('cannot check running processes on this platform');
  else if (s.processes.pids.length) r.push(`in use by process ${s.processes.pids.join(', ')}`);
  if (s.transcripts.length) r.push(`a Claude session mentioned it recently (${s.transcripts[0]})`);
  if (s.memoryNotes.length) r.push(`a memory note says it is still needed (${s.memoryNotes[0]})`);
  if (s.recentFiles.length) r.push(`files changed recently (${s.recentFiles.slice(0, 3).join(', ')})`);
  return r;
}
