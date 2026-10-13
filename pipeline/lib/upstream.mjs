// Why: `pipeline update` and the session-start version check both need to know what upstream's main is and how a local
// commit relates to it, and `update` has to fetch that commit and install from it. Everything that talks to the
// upstream repository lives here so the rules are in one place:
//  - the repository is a constant, never read from the environment or the caller (only the test seam
//    PIPELINE_UPDATE_REMOTE, which an installed copy ignores, can stand in for the fetch URL);
//  - every git call runs with the caller's configuration, hooks, templates and credentials out of the picture
//    (isolatedGit, on an allowlisted environment and a private config/hooks directory): update installs a tree it just downloaded into the owner's ~/.claude,
//    so a hostile ~/.gitconfig, GIT_* variable or hook must not be able to change what gets fetched or run;
//  - nothing here throws or hangs: lookups return an "unresolved" answer with a reason, and every call is bounded by
//    a timeout that the caller can share across steps.
import fs from 'node:fs';
import path from 'node:path';
import { assertPrivateDir, makePrivateTmpDir, removeTree } from './private-tmp.mjs';
import { gh, run, seamValue } from './proc.mjs';

export { removeTree };

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
// needs to start at all), the locale, and four fixed values: no system config, no global config (GIT_CONFIG_GLOBAL needs
// git >= 2.32; older gits ignore it, the -c flags below still apply) and no prompts. Proxy and CA variables
// (HTTPS_PROXY, SSL_CERT_FILE, ...) are deliberately NOT passed: each can redirect or intercept the fetch, so a user who
// needs a proxy cannot use `pipeline update` yet. `source` and `platform` are injectable for tests.
const GIT_ENV_KEEP = ['PATH', 'HOME', 'LANG', 'LC_ALL'];
const GIT_ENV_KEEP_WINDOWS = ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA'];

// Isolation never names a device ("/dev/null", `\\.\nul`, os.devNull): Git for Windows special-cases the literal
// "/dev/null" only where it opens a file, while core.hooksPath is joined with a hook name ("/dev/null/post-checkout")
// and stat()ed, which resolves to C:\dev\null\post-checkout on Windows - a directory any local user may create, so a
// device-name hooksPath is a hook-hijack. Instead every isolated git call is given a PRIVATE directory made by
// makeIsoDir(home): `hooks/` (empty; core.hooksPath) and `empty.gitconfig` (empty; GIT_CONFIG_GLOBAL). Nothing the
// caller configured, and nothing another local user can plant at a well-known path, can be found there. The directory
// is made inside the trusted root under the Claude home (private-tmp.mjs), never under os.tmpdir(): a shared or
// attacker-writable TEMP would let another account plant hooks/post-checkout or edit the config.
export const ISO_DIR_PREFIX = 'claude-pipeline-git-';

// A fresh private directory (mode 0700 on POSIX) holding an empty hooks directory and an empty global config file.
// Throws when it cannot be made or the trusted root fails validation (the caller treats git as unavailable and never
// falls back to the caller's config or to os.tmpdir()). The caller removes it (removeTree) - or uses withIsolatedGit.
export function makeIsoDir(home) {
  const dir = makePrivateTmpDir(home, ISO_DIR_PREFIX);
  try {
    fs.mkdirSync(path.join(dir, 'hooks'), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'empty.gitconfig'), '', { mode: 0o600 });
  } catch (err) {
    removeTree(dir);
    throw err;
  }
  return dir;
}

// The two paths inside an iso directory. Throws unless the directory is a real private one (not a symlink; ours and
// closed to others on POSIX) holding a real `hooks` directory and a real `empty.gitconfig` file as made by makeIsoDir
// (lstat: neither may be a symlink), so a caller that forgot the directory - or a swapped-in look-alike - fails loudly
// instead of running git against another configuration.
function isoPaths(isoDir) {
  if (typeof isoDir !== 'string' || isoDir === '') throw new TypeError('isolated git needs a private isoDir (see makeIsoDir / withIsolatedGit)');
  const hooks = path.join(isoDir, 'hooks');
  const config = path.join(isoDir, 'empty.gitconfig');
  try {
    assertPrivateDir(isoDir, 'isoDir');
    if (!fs.lstatSync(hooks).isDirectory() || !fs.lstatSync(config).isFile()) throw new Error('hooks or empty.gitconfig is missing');
  } catch (err) {
    throw new TypeError(`isoDir ${isoDir} is not a private directory made by makeIsoDir: ${String(err?.message ?? err).slice(0, 160)}`);
  }
  return { hooks, config };
}

// git finds a repository by walking UP from its working directory and then loads THAT repository's local config
// (url.<x>.insteadOf, include.path, http.*, core.*), which GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL do not touch. The
// Claude home may well sit inside a checkout (~/.claude symlinked into a dotfiles repo), and every isolated call runs
// with a cwd under it, so discovery is capped: GIT_CEILING_DIRECTORIES names the iso directory's parent (the trusted
// root all our scratch lives in), and git will not climb into it. The cwd itself is still searched, so the repository a
// call deliberately works on (`git init <dir>` / `-C <dir>` inside the download) is found. Symlinks are resolved first:
// git compares the ceiling with its real working directory. Nothing else can set GIT_DIR / GIT_WORK_TREE /
// GIT_CEILING_DIRECTORIES: the environment is an allowlist.
function ceilingFor(isoDir) {
  return fs.realpathSync.native(path.dirname(path.resolve(isoDir)));
}

export function isolatedGitEnv({ isoDir, source = process.env, platform = process.platform } = {}) {
  const { config } = isoPaths(isoDir);
  const env = {};
  const windows = platform === 'win32';
  for (const name of [...GIT_ENV_KEEP, ...(windows ? GIT_ENV_KEEP_WINDOWS : [])]) {
    // Windows variable names are case-insensitive (`Path`, `ComSpec`): find the real key, pass it under the canonical name.
    const key = windows ? Object.keys(source).find((k) => k.toUpperCase() === name) : (name in source ? name : undefined);
    if (key !== undefined && source[key] !== undefined) env[name] = source[key];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_CEILING_DIRECTORIES: ceilingFor(isoDir), GIT_TERMINAL_PROMPT: '0' };
}

// Leading `-c` options: no hooks, no fsmonitor, no credential helper, and https as the only transport. `allowFile`
// additionally opens the file transport; it is only for the test seam (a local bare repo standing in for GitHub).
export function isolatedGitArgs({ isoDir, allowFile = false } = {}) {
  const { hooks } = isoPaths(isoDir);
  return [
    '-c', `core.hooksPath=${hooks}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []),
  ];
}

// run('git', ...) with the isolation above. `isoDir` (from makeIsoDir) is required. `args` may start with `-C <dir>`;
// `git init` should pass `--template=` (an empty template, so no hook or info/exclude is copied in).
// A call with no `cwd` runs in the iso directory (never the caller's own directory, which may be inside a repository).
export function isolatedGit(args, { isoDir, cwd = isoDir, timeoutMs = 60000, input, allowFile = false } = {}) {
  return run('git', [...isolatedGitArgs({ isoDir, allowFile }), ...args], { cwd, env: isolatedGitEnv({ isoDir }), replaceEnv: true, timeoutMs, input });
}

// Runs fn(git, isoDir) with a private iso directory (under `home`'s trusted temp root) that is removed afterwards,
// whether fn returns or throws. `git` is isolatedGit with that directory already bound: git(args, { cwd, timeoutMs,
// input, allowFile }).
export function withIsolatedGit(home, fn) {
  const isoDir = makeIsoDir(home);
  try {
    return fn((args, opts = {}) => isolatedGit(args, { ...opts, isoDir }), isoDir);
  } finally {
    removeTree(isoDir);
  }
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
// fallback share it). Tries `gh api` first (authenticated, rate-limit friendly), then `git ls-remote`, which needs
// `home` (the Claude home) for its private config/hooks directory; without a usable one git is "unavailable" and nothing
// falls back to os.tmpdir() or the caller's configuration.
// Returns { ok: true, sha, via: 'gh' | 'git' } or { ok: false, reason } - it never throws.
export function mainSha({ timeoutMs = DEFAULT_TIMEOUT_MS, env, home } = {}) {
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
    // A private config/hooks directory per call (also its cwd: git must not discover some other repository); if it
    // cannot be made git is unavailable here, never run on the caller's config.
    const r = withIsolatedGit(home, (git, isoDir) => git(['ls-remote', remote.url, 'refs/heads/main'], { cwd: isoDir, timeoutMs: t.left(), allowFile: remote.local }));
    const sha = r.stdout.split(/\s+/)[0] ?? '';
    if (r.code === 0 && !r.timedOut && FULL_SHA.test(sha)) return { ok: true, sha, via: 'git' };
    reasons.push(r.code === 0 && !r.timedOut ? 'git ls-remote did not list refs/heads/main' : failure('git ls-remote', r));
  } catch (err) {
    reasons.push(`git unavailable: ${firstLine(err?.message)}`);
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
