// The one question the pipeline asks before it may merge anything: "is it safe to?". Gathers config,
// gh auth, real branch protection, pause/rollback issues, Codex and tree state into one report.
// Fail closed everywhere: a lookup that errors is never read as "fine" (an unreadable pause list means
// paused; unreadable protection means no protection). Codex is the one exception, by design: its
// absence defers the review (awaiting-review) but does not stop the pipeline from running.
import { loadConfig, requiredChecks } from './config.mjs';
import { repoRoot } from './repo.mjs';
import { isClean } from './git.mjs';
import { run, codexCommand } from './proc.mjs';
import { createGitHub } from './github.mjs';

const CODEX_TIMEOUT_MS = 15_000;

const message = (err) => String(err?.message ?? err);
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];

// What branch protection must contain (spec 6.6), as short names. Absent settings count as missing.
export function protectionMissing(json, requiredChecks = []) {
  const p = json ?? {};
  const missing = [];
  if (p.enforce_admins?.enabled !== true) missing.push('enforce_admins');
  if (p.required_linear_history?.enabled !== true) missing.push('linear_history');
  if (p.allow_force_pushes?.enabled !== false) missing.push('no_force_push');
  if (p.allow_deletions?.enabled !== false) missing.push('no_deletions');
  if (!p.required_pull_request_reviews) missing.push('pull_request_required');
  const rsc = p.required_status_checks ?? {};
  const have = new Set([...(rsc.checks ?? []).map((c) => c?.context), ...(rsc.contexts ?? [])]);
  for (const name of requiredChecks) if (!have.has(name)) missing.push(`required_check:${name}`);
  return missing;
}

// `codex --version` then `codex login status`: only both exiting 0 means it can really review.
export function probeCodex(env = process.env) {
  const { cmd, prefixArgs } = codexCommand(env);
  const step = (args) => run(cmd, [...prefixArgs, ...args], { env, timeoutMs: CODEX_TIMEOUT_MS });
  const v = step(['--version']);
  if (v.code !== 0) {
    return { available: false, reason: v.timedOut ? 'codex --version timed out' : `codex --version failed: ${firstLine(v.stderr || v.stdout) || `exit ${v.code}`}`, version: null };
  }
  const version = v.stdout.trim() || null;
  const l = step(['login', 'status']);
  if (l.code !== 0) {
    return { available: false, reason: l.timedOut ? 'codex login status timed out' : `codex is not logged in: ${firstLine(l.stderr || l.stdout) || `exit ${l.code}`}`, version };
  }
  return { available: true, reason: null, version };
}

async function probeEnforcement(gh, declared, requiredChecks) {
  const base = { declared, mode: 'gate', protected: false, reason: null, missing: [], branch: null };
  let branch = null;
  try {
    branch = (await gh.repo()).defaultBranch;
    const p = await gh.protection(branch);
    if (p.status !== 200) return { ...base, branch, reason: p.reason ?? 'error', message: p.message };
    const missing = protectionMissing(p.json, requiredChecks);
    return { ...base, branch, protected: true, missing, mode: missing.length === 0 ? 'github' : 'gate', reason: missing.length === 0 ? null : 'incomplete' };
  } catch (err) {
    return { ...base, branch, reason: 'error', message: message(err) };
  }
}

async function openIssues(gh, label) {
  try {
    const list = await gh.listIssues({ label });
    if (!Array.isArray(list)) throw new Error('issue list was not an array');
    const issues = list.map(({ number, title, url }) => ({ number, title, url }));
    return { open: issues.length > 0, issues };
  } catch (err) {
    return { open: true, issues: [], error: message(err) };
  }
}

function protectionReason(e) {
  if (e.missing.length > 0) return `branch protection missing: ${e.missing.join(', ')}`;
  switch (e.reason) {
    case 'plan': return 'branch protection unavailable: GitHub Pro is required for private repos (the config declares enforcement: github)';
    case 'permission': return 'branch protection could not be read: the gh token lacks permission';
    case 'not-protected': return `branch protection missing: ${e.branch} is not protected`;
    case 'not-found': return `branch protection could not be read: ${e.branch ?? 'the default branch'} was not found`;
    default: return `branch protection could not be checked: ${e.message ?? 'unknown error'}`;
  }
}

function issueReasons(label, section) {
  if (section.error) return [`could not check for open ${label} issues (${section.error}); treating as open`];
  return section.issues.map((i) => `${label} issue #${i.number} is open`);
}

export async function runPreflight({ cwd, env = process.env, gh = createGitHub({ cwd, env }), codex = probeCodex }) {
  const off = env.PIPELINE_OFF === '1';

  let root = cwd;
  let loaded;
  try {
    root = repoRoot(cwd);
    loaded = await loadConfig(root);
  } catch (err) {
    loaded = { ok: false, errors: [`not inside a git repository: ${message(err)}`], config: null, path: null };
  }
  const config = { ok: loaded.ok, errors: loaded.errors, path: loaded.path ?? null };
  const cfg = loaded.config;

  let authed = false;
  let login = null;
  let authError = null;
  try {
    const status = await gh.authStatus();
    if (!status.ok) throw new Error(status.message || 'gh auth status failed');
    login = await gh.viewer();
    authed = true;
  } catch (err) {
    authError = message(err);
  }

  const declared = cfg?.enforcement ?? null;
  const enforcement = await probeEnforcement(gh, declared, requiredChecks(cfg?.ci));
  const pause = await openIssues(gh, 'pipeline-pause');
  const rollback = await openIssues(gh, 'pipeline-rollback');

  let codexState;
  try {
    codexState = await codex(env);
  } catch (err) {
    codexState = { available: false, reason: message(err), version: null };
  }

  let clean = false;
  try {
    clean = isClean({ cwd: root });
  } catch { /* not a repo, or git failed: not provably clean */ }

  const enforcementOk = declared === 'gate' || enforcement.mode === 'github';
  const reasons = [];
  if (!config.ok) reasons.push(`pipeline config is not usable: ${config.errors.join('; ')}`);
  if (!authed) reasons.push(`gh is not authenticated (run \`gh auth login\`): ${authError}`);
  if (off) reasons.push('PIPELINE_OFF=1 is set: the pipeline is switched off');
  reasons.push(...issueReasons('pipeline-pause', pause), ...issueReasons('pipeline-rollback', rollback));
  if (config.ok && !enforcementOk) reasons.push(protectionReason(enforcement));

  return {
    ok: config.ok && authed,
    off,
    config,
    gh: { authed, login },
    enforcement,
    pause,
    rollback,
    codex: codexState,
    clean,
    canMerge: config.ok && authed && !off && !pause.open && !rollback.open && enforcementOk,
    reasons,
  };
}
