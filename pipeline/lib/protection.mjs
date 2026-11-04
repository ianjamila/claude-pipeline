// The branch-protection reader shared by `pipeline protect` and `pipeline ci-wait`, so the two never disagree about what
// GitHub's classic protection says. Only reads; nothing here writes protection.
import { GhError } from './proc.mjs';

// A positive integer app id names one GitHub App; -1, null or a missing id means "any app" (GitHub's own reading).
export const isAppId = (n) => Number.isSafeInteger(n) && n > 0;
export const appIdOrNull = (n) => (isAppId(n) ? n : null);

// The branch's protection as it stands, or null when there is none to read (not protected yet; no admin rights or plan, which
// the write itself then reports). Any other failure: a dry run prints the commands without kept pins and says so; --apply
// stops, because writing without the current pins would move a deploy provider's check onto GitHub Actions and block every PR.
export function readCurrentProtection(gh, branch, { apply }) {
  try {
    const p = gh.protection(branch);
    return p.status === 200 ? p.json : null;
  } catch (err) {
    if (apply || !(err instanceof GhError)) throw err;
    process.stderr.write(`could not read the current protection (${String(err.message).split('\n')[0]}): no check keeps a non-Actions pin unless --pin names it.\n`);
    return null;
  }
}

// The same read as one of three outcomes, for a caller that must never confuse "nothing is required" with "could not
// tell": `present` (rows: [{context, appId|null}]), `absent` (authoritative: 404 "Branch not protected", or a protection
// without required status checks) or `unreadable` (a 403 / other 404, a 5xx, a network error, a malformed reply).
export function readClassicRequired(gh, branch) {
  let p;
  try {
    p = gh.protection(branch);
  } catch (err) {
    return { kind: 'unreadable', reason: String(err?.message ?? err).split('\n')[0] };
  }
  if (p.status === 404 && p.reason === 'not-protected') return { kind: 'absent' };
  if (p.status !== 200) return { kind: 'unreadable', reason: p.message || `HTTP ${p.status}` };
  const rs = p.json?.required_status_checks;
  if (rs === undefined || rs === null) return { kind: 'absent' };
  if (typeof rs !== 'object') return { kind: 'unreadable', reason: 'required_status_checks is not an object' };
  const rows = [];
  for (const c of Array.isArray(rs.checks) ? rs.checks : []) {
    if (typeof c?.context === 'string' && c.context !== '') rows.push({ context: c.context, appId: appIdOrNull(c.app_id) });
  }
  // `contexts` is the legacy list (no app); a context only there is required from any app.
  for (const context of Array.isArray(rs.contexts) ? rs.contexts : []) {
    if (typeof context === 'string' && context !== '' && !rows.some((r) => r.context === context)) rows.push({ context, appId: null });
  }
  return rows.length > 0 ? { kind: 'present', rows } : { kind: 'absent' };
}

// Repository rulesets that apply to the branch: `required_status_checks` rules, same three outcomes. `rules` is the
// (paginated) `GET repos/O/R/rules/branches/<branch>` array. An endpoint that answers 200 with no such rule is `absent`.
export function requiredFromRules(rules) {
  if (!Array.isArray(rules)) return { kind: 'unreadable', reason: 'rules reply was not a list' };
  const rows = [];
  for (const rule of rules) {
    if (rule?.type !== 'required_status_checks') continue;
    const list = rule.parameters?.required_status_checks;
    if (!Array.isArray(list)) return { kind: 'unreadable', reason: 'a required_status_checks rule has no checks list' };
    for (const c of list) {
      if (typeof c?.context === 'string' && c.context !== '') rows.push({ context: c.context, appId: appIdOrNull(c.integration_id) });
    }
  }
  return rows.length > 0 ? { kind: 'present', rows } : { kind: 'absent' };
}
