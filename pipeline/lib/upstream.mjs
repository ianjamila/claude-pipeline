// Why: `pipeline update` and the session-start version check both need to know what upstream's main is and how a local
// commit relates to it, and `update` has to fetch that commit and install from it. Everything that talks to the
// upstream repository lives here so the rules are in one place:
//  - the repository is a constant, never read from the environment or the caller (only the test seam
//    PIPELINE_UPDATE_REMOTE, which an installed copy ignores, can stand in for the fetch URL);
//  - every git call runs with the caller's configuration, hooks, templates and credentials out of the picture
//    (isolatedGit, on an allowlisted environment): update installs a tree it just downloaded into the owner's ~/.claude,
//    so a hostile ~/.gitconfig, GIT_* variable or hook must not be able to change what gets fetched or run;
//  - nothing here throws or hangs: lookups return an "unresolved" answer with a reason, and every call is bounded by
//    a timeout that the caller can share across steps.
import fs from 'node:fs';
import os from 'node:os';
import { gh, run, seamValue } from './proc.mjs';

export const UPSTREAM_HOST = 'github.com';
export const UPSTREAM_REPO = 'ianjamila/claude-pipeline';
export const UPSTREAM_URL = 'https://github.com/ianjamila/claude-pipeline';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ANY_SHA = /^[0-9a-f]{7,64}$/;
const STATUSES = new Set(['identical', 'ahead', 'behind', 'diverged']);
const DEFAULT_TIMEOUT_MS = 15000;

// ---- isolated git ------------------------------------------------------------------------------------------------

// The environment for a git call that must not be influenced by the caller. It is built from scratch, as an ALLOWLIST:
// git can be made to run other programs through many variables (GIT_EXEC_PATH is where it loads git-remote-https and
// git-upload-pack from; GIT_SSH, GIT_SSH_COMMAND, GIT_PROXY_COMMAND, GIT_ASKPASS, GIT_EXTERNAL_DIFF, GIT_PAGER,
// GIT_CONFIG_*, GIT_DIR, ...) and a denylist misses whichever one it does not know about yet. So only what git needs to
// find itself and the owner's files is passed on: PATH and HOME (and, on Windows, the handful of variables the runtime
// needs to start at all), the locale, and three fixed values: no system config, no global config (GIT_CONFIG_GLOBAL needs
// git >= 2.32; older gits ignore it, the -c flags below still apply) and no prompts. Proxy and CA variables
// (HTTPS_PROXY, SSL_CERT_FILE, ...) are deliberately NOT passed: each can redirect or intercept the fetch, so a user who
// needs a proxy cannot use `pipeline update` yet. `source` and `platform` are injectable for tests.
const GIT_ENV_KEEP = ['PATH', 'HOME', 'LANG', 'LC_ALL'];
const GIT_ENV_KEEP_WINDOWS = ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA'];

// The "no file" path handed to git. os.devNull is `\\.\nul` on Windows, which Git for Windows cannot open as a config
// file (`fatal: unable to access '\\.\nul': Invalid argument`); it maps the literal `/dev/null` to NUL itself, so that
// is what it gets there. Everywhere else os.devNull is already `/dev/null`.
export function gitNullDevice(platform = process.platform) {
  return platform === 'win32' ? '/dev/null' : os.devNull;
}

export function isolatedGitEnv({ source = process.env, platform = process.platform } = {}) {
  const env = {};
  const windows = platform === 'win32';
  for (const name of [...GIT_ENV_KEEP, ...(windows ? GIT_ENV_KEEP_WINDOWS : [])]) {
    // Windows variable names are case-insensitive (`Path`, `ComSpec`): find the real key, pass it under the canonical name.
    const key = windows ? Object.keys(source).find((k) => k.toUpperCase() === name) : (name in source ? name : undefined);
    if (key !== undefined && source[key] !== undefined) env[name] = source[key];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNullDevice(platform), GIT_TERMINAL_PROMPT: '0' };
}

// Leading `-c` options: no hooks, no fsmonitor, no credential helper, and https as the only transport. `allowFile`
// additionally opens the file transport; it is only for the test seam (a local bare repo standing in for GitHub).
export function isolatedGitArgs({ allowFile = false } = {}) {
  return [
    '-c', `core.hooksPath=${gitNullDevice()}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []),
  ];
}

// run('git', ...) with the isolation above. `args` may start with `-C <dir>`; `git init` should pass `--template=`
// (an empty template, so no hook or info/exclude is copied in).
export function isolatedGit(args, { cwd, timeoutMs = 60000, input, allowFile = false } = {}) {
  return run('git', [...isolatedGitArgs({ allowFile }), ...args], { cwd, env: isolatedGitEnv(), replaceEnv: true, timeoutMs, input });
}

// Where `update` fetches from: UPSTREAM_URL, or the PIPELINE_UPDATE_REMOTE test seam (a path or URL) when this is not
// an installed copy. `local` is true for the seam, which is the only case that may use the file transport.
export function fetchRemote(env) {
  const seam = seamValue('PIPELINE_UPDATE_REMOTE', env);
  return seam ? { url: seam, local: true } : { url: UPSTREAM_URL, local: false };
}

// ---- timeouts ----------------------------------------------------------------------------------------------------

// A budget shared by several steps: `left()` is the time remaining (at least 1ms while any is left, so it can be
// handed to spawnSync, where 0 would mean "no timeout"); `expired()` says there is none.
function budget(timeoutMs) {
  const total = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const end = Date.now() + total;
  return { left: () => Math.max(1, end - Date.now()), expired: () => Date.now() >= end };
}

const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0].slice(0, 200);
const failure = (what, r) => `${what} ${r.timedOut ? 'timed out' : `failed (exit ${r.code})`}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ''}`;

// ---- main's sha --------------------------------------------------------------------------------------------------

// The sha upstream's main points to. `timeoutMs` is ONE budget for the whole lookup (the gh attempt and the git
// fallback share it). Tries `gh api` first (authenticated, rate-limit friendly), then `git ls-remote`.
// Returns { ok: true, sha, via: 'gh' | 'git' } or { ok: false, reason } - it never throws.
export function mainSha({ timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  const t = budget(timeoutMs);
  const reasons = [];
  try {
    const r = gh(['api', '--hostname', UPSTREAM_HOST, `repos/${UPSTREAM_REPO}/commits/main`, '--jq', '.sha'], { env, timeoutMs: t.left() });
    const sha = r.stdout.trim();
    if (r.code === 0 && !r.timedOut && FULL_SHA.test(sha)) return { ok: true, sha, via: 'gh' };
    reasons.push(r.code === 0 && !r.timedOut ? 'gh api returned something that is not a commit sha' : failure('gh api', r));
  } catch (err) {
    reasons.push(`gh api failed: ${firstLine(err?.message)}`);
  }
  if (t.expired()) return { ok: false, reason: reasons.join('; ') };
  try {
    const remote = fetchRemote(env);
    const r = isolatedGit(['ls-remote', remote.url, 'refs/heads/main'], { cwd: os.tmpdir(), timeoutMs: t.left(), allowFile: remote.local });
    const sha = r.stdout.split(/\s+/)[0] ?? '';
    if (r.code === 0 && !r.timedOut && FULL_SHA.test(sha)) return { ok: true, sha, via: 'git' };
    reasons.push(r.code === 0 && !r.timedOut ? 'git ls-remote did not list refs/heads/main' : failure('git ls-remote', r));
  } catch (err) {
    reasons.push(`git ls-remote failed: ${firstLine(err?.message)}`);
  }
  return { ok: false, reason: reasons.join('; ') };
}

// ---- how two commits relate --------------------------------------------------------------------------------------

// How `head` relates to `base` per GitHub's compare API (gh api repos/<repo>/compare/<base>...<head>):
//   'identical'  same commit
//   'ahead'      head has commits base lacks (base is an ancestor of head)  - e.g. base = installed, head = main: update available
//   'behind'     head is an ancestor of base (base has commits head lacks)
//   'diverged'   each has commits the other lacks
// Returns { status, baseSha, headSha } with FULL shas taken from the response, or { status: 'unresolved', reason } on
// any error, timeout, malformed answer or unknown status - never throws. `base` and `head` are shas (7-64 hex digits;
// a short one is resolved by GitHub and the full sha comes back). `timeoutMs` bounds the one gh call.
export function compare(base, head, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  const unresolved = (reason) => ({ status: 'unresolved', reason });
  const b = String(base ?? '').toLowerCase();
  const h = String(head ?? '').toLowerCase();
  if (!ANY_SHA.test(b) || !ANY_SHA.test(h)) return unresolved('compare needs two commit shas');
  let r;
  try {
    r = gh(['api', '--hostname', UPSTREAM_HOST, `repos/${UPSTREAM_REPO}/compare/${b}...${h}`], { env, timeoutMs: budget(timeoutMs).left() });
  } catch (err) {
    return unresolved(`gh api failed: ${firstLine(err?.message)}`);
  }
  if (r.code !== 0 || r.timedOut) return unresolved(failure('gh api', r));
  let body;
  try { body = JSON.parse(r.stdout); } catch { return unresolved('gh api returned something that is not JSON'); }
  if (!body || typeof body !== 'object' || !STATUSES.has(body.status)) return unresolved(`unexpected compare status: ${firstLine(String(body?.status))}`);

  const baseSha = String(body.base_commit?.sha ?? '').toLowerCase();
  if (!FULL_SHA.test(baseSha) || !baseSha.startsWith(b)) return unresolved('compare response does not name the base commit');
  // The head: when head is an ancestor of (or equal to) base, the merge base IS head. Otherwise it is the newest commit
  // of the range - but the API lists at most 250 commits, so only trust the last one when the list is complete.
  let headSha = '';
  const mergeBase = String(body.merge_base_commit?.sha ?? '').toLowerCase();
  if (body.status === 'identical' || body.status === 'behind') {
    headSha = mergeBase;
  } else {
    const commits = Array.isArray(body.commits) ? body.commits : [];
    const complete = commits.length > 0 && (body.total_commits === undefined || body.total_commits === commits.length);
    headSha = complete ? String(commits[commits.length - 1]?.sha ?? '').toLowerCase() : (FULL_SHA.test(h) ? h : '');
  }
  if (!FULL_SHA.test(headSha) || !headSha.startsWith(h)) return unresolved('compare response does not name the head commit');
  return { status: body.status, baseSha, headSha };
}

// ---- scratch directory -------------------------------------------------------------------------------------------

// Remove a directory tree, tolerating Windows' brief file locks. Never throws.
export function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}
