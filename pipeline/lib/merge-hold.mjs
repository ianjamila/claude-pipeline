// The cooperative merge-hold seam (plan 2026-11-05-merge-hold-queue). A repo may keep a merge lock of its own (EagleWatch: a
// `merge-hold` label with a TTL; while it is active every OTHER PR's merge command refuses, and a stale PR behind an older hold
// is told `hold:queued-behind`: do NOT update this branch). The pipeline knows nothing of that lock except through three
// shell commands the repo names under `merge.*` (see config.mjs): take the hold for PR N, release it, and a READ-ONLY check
// that lists the other PRs' active holds that would block N. This module only runs them and decides what their answers mean.
// Everything fails closed for a repo that opted in: an unreadable check is a refusal, never "no holds". A repo without the
// keys is untouched (`configured: false`).
//
// Enforcement is cooperative. The pipeline checks before it updates a branch or merges; a hold placed between that check and
// the merge command is caught only by a hold-aware merge command (EagleWatch's gate re-checks right before `gh pr merge`). A
// repo that opts in with the default `gh pr merge` command gets the pre-check only. Read-then-PUT of update-branch is not atomic
// either. There is no override here: the owner's way past a hold is the provider's own (EagleWatch `--ignore-hold`).
import { fill } from './config.mjs';
import { envWithGhDir, runShellAsync } from './proc.mjs';

// The stable verdict string of EagleWatch's merge gate (scripts/lib/merge-hold.mjs HOLD_QUEUED_BEHIND). Its full line is
// `hold:queued-behind  queued behind #1400 — do NOT update this branch until #1400 merges (PR #1400 "…" holds …)`.
export const HOLD_QUEUED_BEHIND = 'hold:queued-behind';

// EagleWatch's gh-transient backs off 60/120/240 s on a rate limit, so a check may legitimately run for minutes.
export const HOLD_TIMEOUT_MS = 5 * 60_000;

// Release reasons: a fixed code maps to a fixed sentence, so no free text ever reaches the shell.
export const RELEASE_REASONS = Object.freeze({
  'new-commits': 'New commits were pushed after the merge hand-off, so the hand-off is withdrawn.',
  parked: 'The PR was parked, so its merge hold is released.',
  'owner-declined': 'The owner declined the merge or asked for changes, so the merge hold is released.',
  'handoff-withdrawn': 'The merge hand-off was withdrawn, so the merge hold is released.',
});

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const optString = (v) => v === undefined || v === null || typeof v === 'string';

export const holdsConfigured = (config) => ['hold_command', 'hold_release_command', 'hold_check_command'].every((k) => typeof config?.merge?.[k] === 'string' && config.merge[k].trim() !== '');

// The reason text is built from the fixed sentences above (letters, digits, spaces, commas, full stops), so quoting is belt and
// braces: single quotes for a POSIX shell, double quotes for cmd.exe.
export const quoteReason = (text, platform = process.platform) => (platform === 'win32' ? `"${text}"` : `'${String(text).replace(/'/g, "'\\''")}'`);

const lastLines = (ran, n = 5) => `${ran?.stdout ?? ''}\n${ran?.stderr ?? ''}`.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-n);

async function runHoldCommand(template, vars, { root, env, run }) {
  const command = fill(template, vars, { strict: true });
  return run(command, { cwd: root, env: envWithGhDir(env), timeoutMs: HOLD_TIMEOUT_MS });
}

// The check's answer. -> { configured:false } | { configured:true, ok:true, blockedBy:[{number,title,since,expires}] } |
// { configured:true, ok:false, why }. Readable only if: exit 0; the LAST non-empty stdout line (a banner may come first) is one
// JSON object; `pr` is the requested PR; `blockedBy` is an array of objects with a safe positive integer `number` that is not
// the PR itself. Anything else is unreadable.
export async function checkHolds({ config, pr, root, env, run = runShellAsync }) {
  if (!holdsConfigured(config)) return { configured: false };
  const unreadable = (why) => ({ configured: true, ok: false, why });
  let ran;
  try {
    ran = await runHoldCommand(config.merge.hold_check_command, { pr: String(pr) }, { root, env, run });
  } catch (err) {
    return unreadable(`the hold check could not be started (${String(err?.message ?? err).slice(0, 200)})`);
  }
  if (ran.timedOut) return unreadable(`the hold check timed out after ${Math.round(HOLD_TIMEOUT_MS / 60_000)} min`);
  if (ran.signal) return unreadable(`the hold check was killed by ${ran.signal}`);
  if (ran.code !== 0) return unreadable(`the hold check exited ${ran.code}`);
  const line = String(ran.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  if (line === undefined) return unreadable('the hold check printed nothing');
  let answer;
  try {
    answer = JSON.parse(line);
  } catch {
    return unreadable('the last line of the hold check is not JSON');
  }
  if (!isPlain(answer)) return unreadable('the hold check answer is not a JSON object');
  if (answer.pr !== pr) return unreadable(`the hold check answered for PR ${JSON.stringify(answer.pr ?? null)}, not #${pr}`);
  if (!Array.isArray(answer.blockedBy)) return unreadable('the hold check answer has no blockedBy list');
  const blockedBy = [];
  for (const b of answer.blockedBy) {
    if (!isPlain(b) || !posInt(b.number)) return unreadable('a blockedBy entry has no valid PR number');
    if (b.number === pr) return unreadable(`a blockedBy entry names the PR itself (#${pr})`);
    if (![b.title, b.since, b.expires].every(optString)) return unreadable(`a blockedBy entry for #${b.number} has a title or time that is not text`);
    blockedBy.push({ number: b.number, title: b.title ?? null, since: b.since ?? null, expires: b.expires ?? null });
  }
  return { configured: true, ok: true, blockedBy };
}

// { configured:false } | { configured:true, confirmed: exit 0, code, lines (last 5 of stdout+stderr) }. The commands are not
// retried: a take that is NOT confirmed is reported, never repeated.
async function runWrite(template, vars, ctx) {
  if (!holdsConfigured(ctx.config)) return { configured: false };
  let ran;
  try {
    ran = await runHoldCommand(template(ctx.config), vars, ctx);
  } catch (err) {
    return { configured: true, confirmed: false, code: 1, lines: [String(err?.message ?? err).slice(0, 200)] };
  }
  return { configured: true, confirmed: ran.code === 0 && ran.timedOut !== true, code: ran.code, ...(ran.timedOut ? { timedOut: true } : {}), ...(ran.signal ? { signal: ran.signal } : {}), lines: lastLines(ran) };
}

// Takes (or keeps) PR N's own hold.
export const takeHold = ({ config, pr, root, env, run = runShellAsync }) => runWrite((c) => c.merge.hold_command, { pr: String(pr) }, { config, root, env, run });

// Releases PR N's own hold. `reason` is one of RELEASE_REASONS' codes; the sentence, shell-quoted, is what is filled in.
export async function releaseHold({ config, pr, reason, root, env, run = runShellAsync }) {
  if (!Object.hasOwn(RELEASE_REASONS, reason)) throw new Error(`unknown release reason ${JSON.stringify(reason)}`);
  return runWrite((c) => c.merge.hold_release_command, { pr: String(pr), reason: quoteReason(RELEASE_REASONS[reason]) }, { config, root, env, run });
}

// The PR numbers a merge command's output says this PR is queued behind: { prs:[A,…] } (in order, no repeats) or null when the
// text never says it. Read from the FULL stdout+stderr, not a display tail (the line may sit above 30 others). On a line with the
// verdict the numbers are those after "queued behind" (EagleWatch's wording; a title like "Fix #5" on the same line is no PR
// behind us), else the first #N on it. A verdict line with no number at all still counts: `prs` is then empty.
export function queuedBehindFrom(text) {
  const prs = [];
  let seen = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes(HOLD_QUEUED_BEHIND)) continue;
    seen = true;
    const named = [...line.matchAll(/queued behind\s+#(\d+)/gi)].map((m) => Number(m[1]));
    const found = named.length > 0 ? named : [...line.matchAll(/#(\d+)/g)].slice(0, 1).map((m) => Number(m[1]));
    for (const n of found) if (posInt(n) && !prs.includes(n)) prs.push(n);
  }
  return seen ? { prs } : null;
}

const phtTime = (iso) => {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return null;
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${f.format(new Date(ms))} PHT`;
};

const describe = (b) => `#${b.number}${b.title ? ` "${b.title}"` : ''} (${phtTime(b.expires) ? `hold expires ${phtTime(b.expires)}` : 'hold expiry unknown'})`;

// What a caller does with the check: null (not configured, or readable with nothing ahead) or a refusal. `blockedBy` is the list
// of PR numbers, `holds` the details the check gave (title, since, expires), `doNotUpdate` is the instruction the refusal exists for.
export function holdGateFrom(check) {
  if (!check?.configured) return null;
  if (!check.ok) {
    return { error: 'hold-unreadable', reason: `the merge-hold check could not be read (${check.why}): nothing is updated or merged on a guess; retry in a minute` };
  }
  if (check.blockedBy.length === 0) return null;
  const numbers = check.blockedBy.map((b) => b.number);
  return {
    error: 'queued-behind',
    verdict: HOLD_QUEUED_BEHIND,
    blockedBy: numbers,
    holds: check.blockedBy,
    doNotUpdate: true,
    reason: `${HOLD_QUEUED_BEHIND}: queued behind ${check.blockedBy.map(describe).join(', ')}: do NOT update this branch; merge ${numbers.map((n) => `#${n}`).join(', ')} first, or wait for the hold to expire, then say "merge" again`,
  };
}

export async function holdGate(args) {
  return holdGateFrom(await checkHolds(args));
}

// The refusal for a failed merge command whose output says it is queued behind (see queuedBehindFrom).
export function queuedBehindRefusal(found) {
  const list = found.prs.length > 0 ? found.prs.map((n) => `#${n}`).join(', ') : 'another PR';
  return {
    error: 'queued-behind',
    verdict: HOLD_QUEUED_BEHIND,
    blockedBy: found.prs,
    doNotUpdate: true,
    reason: `${HOLD_QUEUED_BEHIND}: the merge command says this PR is queued behind ${list}: do NOT update this branch until ${found.prs.length === 1 ? 'it merges' : 'they merge'} (or the hold expires), then say "merge" again`,
  };
}
