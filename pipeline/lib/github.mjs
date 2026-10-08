// Everything the pipeline asks GitHub goes through this one wrapper around the `gh` CLI, so that
// (a) tests swap in a scripted fake with PIPELINE_GH, and (b) every failure has the same shape.
// Fail closed: a method either returns real data or throws GhError; callers decide what an error
// means (preflight reads it as "pause is open", a merge gate reads it as "do not merge"). JSON
// bodies are sent on stdin (`--input -`) so no model- or diff-derived text is ever shell-quoted.
import { gh, GhError } from './proc.mjs';
import { UnavailableError, UsageError } from './cli.mjs';
import { repoRoot, repoSlug } from './repo.mjs';
import { resolve } from 'node:path';

// A hung gh must never hang the pipeline: a call that outlives this is a failure.
const CALL_TIMEOUT_MS = 60_000;
const PER_PAGE = 30;

export const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

function prNumber(n) {
  const v = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (!Number.isInteger(v) || v <= 0) throw new TypeError(`invalid PR number: ${JSON.stringify(n)}`);
  return String(v);
}

// `gh api --paginate` prints each page's array back to back (`[..][..]`); newer gh with --slurp prints
// an array of arrays. Split the stream into top-level JSON values by tracking brackets and strings,
// then flatten, so a comment on page 2 is never missed.
export function parseConcatenatedJson(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      if (depth === 0) throw new Error(`unexpected text in JSON stream at ${i}`);
      inString = true;
    } else if (ch === '[' || ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) throw new Error(`unbalanced JSON stream at ${i}`);
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(ch)) {
      throw new Error(`unexpected text in JSON stream at ${i}`);
    }
  }
  if (depth !== 0 || inString) throw new Error('truncated JSON stream');
  const flat = (xs) => xs.flatMap((x) => (Array.isArray(x) ? x : [x]));
  return flat(flat(values));
}

// Turns a gh failure into what the caller can act on, or null when it is something else (a 5xx, a
// network error), which must stay an error rather than be read as "no protection" or "no permission".
export function classifyApiError({ stdout = '', stderr = '' } = {}) {
  const text = `${stderr}\n${stdout}`;
  let message = String(stderr).trim();
  try {
    const body = JSON.parse(stdout);
    if (body && typeof body.message === 'string') message = body.message;
  } catch { /* stdout was not JSON */ }
  if (!message) message = text.trim();
  if (/Upgrade to GitHub Pro/i.test(text)) return { status: 403, reason: 'plan', message };
  if (/Branch not protected/i.test(text)) return { status: 404, reason: 'not-protected', message };
  if (/HTTP 403|"status"\s*:\s*"?403/.test(text)) return { status: 403, reason: 'permission', message };
  if (/HTTP 404|"status"\s*:\s*"?404/.test(text)) return { status: 404, reason: 'not-found', message };
  return null;
}

export function createGitHub({ cwd, env, ghFn = gh } = {}) {
  let repoCache = null;
  let viewerCache = null;

  const exec = (args, { input } = {}) => ghFn(args, { cwd, env, input, timeoutMs: CALL_TIMEOUT_MS });
  const failure = (r, args) => {
    const err = new GhError({ code: r.code, stderr: r.stderr, args, timedOut: r.timedOut });
    err.stdout = r.stdout;
    return err;
  };
  const ok = (args, opts) => {
    const r = exec(args, opts);
    if (r.code !== 0 || r.timedOut) throw failure(r, args);
    return r;
  };
  const parse = (r, args) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new GhError({ code: r.code, stderr: `could not parse JSON from stdout: ${String(r.stdout).slice(0, 200)}`, args });
    }
  };
  const getJson = (args, opts) => parse(ok(args, opts), args);

  // GET, or a write whose JSON body goes on stdin. An empty reply (204) is null.
  const api = (method, path, body) => {
    const args = method === 'GET' ? ['api', path] : ['api', '-X', method, path];
    if (body !== undefined) args.push('--input', '-');
    const r = ok(args, body === undefined ? {} : { input: JSON.stringify(body) });
    return r.stdout.trim() === '' ? null : parse(r, args);
  };

  const self = {
    api,

    repo() {
      repoCache ??= repoSlug(cwd, { ghJsonFn: (args) => getJson(args) });
      return repoCache;
    },

    viewer() {
      if (viewerCache) return viewerCache;
      const login = ok(['api', 'user', '-q', '.login']).stdout.trim();
      if (!login) throw new GhError({ code: 0, stderr: 'gh api user returned no login', args: ['api', 'user'] });
      viewerCache = login;
      return login;
    },

    // GET with a jq filter: the filtered stdout text (the caller parses it). Throws GhError on any failure.
    apiText: (path, jq) => ok(['api', path, '--jq', jq]).stdout,

    // Not an error path: preflight reports "not authenticated" as data.
    authStatus() {
      const r = exec(['auth', 'status']);
      return { ok: r.code === 0 && !r.timedOut, message: (r.stderr || r.stdout || '').trim() };
    },

    prView: (n, fields) => getJson(['pr', 'view', prNumber(n), '--json', fields.join(',')]),
    prLabels: (n) => (getJson(['pr', 'view', prNumber(n), '--json', 'labels']).labels ?? []).map((l) => l.name),

    // The pipeline's own transitions. The global hook stops agents doing some of these directly; that is intended.
    addLabels(n, labels) {
      if (labels.length) ok(['pr', 'edit', prNumber(n), ...labels.flatMap((l) => ['--add-label', l])]);
    },
    removeLabels(n, labels) {
      if (labels.length) ok(['pr', 'edit', prNumber(n), ...labels.flatMap((l) => ['--remove-label', l])]);
    },

    listIssues: ({ label, state = 'open' }) =>
      getJson(['issue', 'list', '--label', label, '--state', state, '--json', 'number,title,url,labels', '--limit', '100']),
    listPrs: ({ label, state = 'open' }) =>
      getJson(['pr', 'list', '--label', label, '--state', state, '--json', 'number,title,headRefName,url', '--limit', '100']),

    issueCreate({ title, body, labels = [] }) {
      const r = api('POST', `repos/${self.repo().slug}/issues`, { title, body, labels });
      return { number: r.number, url: r.html_url };
    },

    listLabels: () => getJson(['label', 'list', '--json', 'name,color,description', '--limit', '200']),
    createLabel: ({ name, color, description }) => ok(['label', 'create', name, '--color', color, '--description', description]),
    editLabel: ({ name, color, description }) => ok(['label', 'edit', name, '--color', color, '--description', description]),

    listComments(n) {
      const args = ['api', `repos/${self.repo().slug}/issues/${prNumber(n)}/comments`, '--paginate'];
      const r = ok(args);
      let list;
      try {
        list = parseConcatenatedJson(r.stdout);
      } catch (err) {
        throw new GhError({ code: r.code, stderr: `could not parse comments: ${err.message}`, args });
      }
      if (!list.every((c) => c !== null && typeof c === 'object')) {
        throw new GhError({ code: r.code, stderr: 'comments reply was not a list of objects', args });
      }
      return list;
    },

    // Only our own (viewer's) newest comment that STARTS with the marker is edited: a quoted or forged
    // marker, or someone else's comment, must never be rewritten, and the next run must find it again.
    upsertComment(n, marker, body) {
      if (!String(body).startsWith(marker)) throw new Error('comment body must start with its marker, or the next run could not find it');
      const me = self.viewer();
      const mine = self.listComments(n)
        .filter((c) => typeof c.body === 'string' && c.body.startsWith(marker) && c.user?.login === me)
        .sort((a, b) => Number(a.id) - Number(b.id));
      const existing = mine.at(-1);
      const slug = self.repo().slug;
      const r = existing
        ? api('PATCH', `repos/${slug}/issues/comments/${existing.id}`, { body })
        : api('POST', `repos/${slug}/issues/${prNumber(n)}/comments`, { body });
      return { id: r.id, url: r.html_url, action: existing ? 'updated' : 'created' };
    },

    // 200 / 403 (plan | permission) / 404 are answers; anything else (5xx, network) throws.
    protection(branch) {
      const args = ['api', `repos/${self.repo().slug}/branches/${encodePath(branch)}/protection`];
      const r = exec(args);
      if (r.code === 0 && !r.timedOut) return { status: 200, json: parse(r, args) };
      const known = r.timedOut ? null : classifyApiError(r);
      if (known) return known;
      throw failure(r, args);
    },

    // How far `head` (a SHA or branch) is behind `base`, from GitHub itself (the local ref can be stale). behindBy 0 = the
    // base tip is already part of head. `per_page=1` keeps the reply small: only the counts are read.
    compare(base, head) {
      const args = ['api', `repos/${self.repo().slug}/compare/${encodePath(base)}...${encodeURIComponent(head)}?per_page=1`,
        '--jq', '{status: .status, behind_by: .behind_by, ahead_by: .ahead_by, base: .base_commit.sha}'];
      const body = parse(ok(args), args);
      if (!Number.isInteger(body?.behind_by) || !Number.isInteger(body?.ahead_by)) {
        throw new GhError({ code: 0, stderr: `compare reply has no behind_by/ahead_by: ${JSON.stringify(body).slice(0, 200)}`, args });
      }
      if (typeof body.base !== 'string' || !/^[0-9a-f]{40}$/.test(body.base)) {
        throw new GhError({ code: 0, stderr: `compare reply has no base tip: ${JSON.stringify(body).slice(0, 200)}`, args });
      }
      return { status: body.status ?? null, behindBy: body.behind_by, aheadBy: body.ahead_by, baseSha: body.base };
    },

    // The parent SHAs of a commit, in order (for a merge commit: first the branch it was made on, then what was merged in).
    commitParents(commit) {
      const text = self.apiText(`repos/${self.repo().slug}/commits/${encodeURIComponent(commit)}`, '[.parents[].sha]');
      let parents;
      try {
        parents = JSON.parse(text);
      } catch { /* reported below */ }
      if (!Array.isArray(parents) || !parents.every((p) => typeof p === 'string' && /^[0-9a-f]{40}$/.test(p))) {
        throw new GhError({ code: 0, stderr: `commit ${commit} has no readable parents: ${String(text).slice(0, 200)}`, args: ['api', 'commits', commit] });
      }
      return parents;
    },

    // PUT pulls/{n}/update-branch: merge the base into the PR branch on GitHub (a merge commit, never a force push), but only
    // if the head is still `expectedHeadSha`. 202 = accepted (the new head appears a moment later). The two 422s are answers,
    // told apart by their message; anything else (403, 404, 5xx, an unrecognised 422) throws, so it can never read as success.
    updateBranch(n, expectedHeadSha) {
      const args = ['api', '-X', 'PUT', `repos/${self.repo().slug}/pulls/${prNumber(n)}/update-branch`, '--input', '-'];
      const r = exec(args, { input: JSON.stringify({ expected_head_sha: expectedHeadSha }) });
      if (r.code === 0 && !r.timedOut) return { result: 'accepted' };
      let message = '';
      try {
        message = String(JSON.parse(r.stdout)?.message ?? '');
      } catch { /* not JSON: fall back to stderr */ }
      message ||= String(r.stderr ?? '').trim();
      if (!r.timedOut && /HTTP 422|"status"\s*:\s*"?422/.test(`${r.stderr}\n${r.stdout}`)) {
        if (/expected head sha/i.test(message)) return { result: 'head-moved', message };
        if (/merge conflict/i.test(message)) return { result: 'conflict', message };
      }
      throw failure(r, args);
    },

    deployments({ sha, environment } = {}) {
      const q = [];
      if (sha) q.push(`sha=${encodeURIComponent(sha)}`);
      if (environment) q.push(`environment=${encodeURIComponent(environment)}`);
      q.push(`per_page=${PER_PAGE}`);
      return getJson(['api', `repos/${self.repo().slug}/deployments?${q.join('&')}`]);
    },
    deploymentStatuses: (id) => getJson(['api', `repos/${self.repo().slug}/deployments/${Number(id)}/statuses?per_page=${PER_PAGE}`]),

    // gh exits 8 while checks are pending and 1 when some failed, and still prints the JSON; only a
    // reply that is not JSON (auth error, "no checks reported") is a failure.
    checks(n, { required = false } = {}) {
      const args = ['pr', 'checks', prNumber(n), '--json', 'name,state,bucket,link,workflow', ...(required ? ['--required'] : [])];
      const r = exec(args);
      if (r.timedOut) throw failure(r, args);
      let rows;
      try {
        rows = JSON.parse(r.stdout);
      } catch {
        throw failure(r, args);
      }
      if (!Array.isArray(rows)) throw failure(r, args);
      return rows;
    },
  };
  return self;
}

// ---- helpers shared by the gh-backed commands -------------------------------------------------

// A gh failure inside a command means "GitHub is unavailable to us": exit 3, never a pass.
export async function guardGh(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GhError) throw new UnavailableError(err.message);
    throw err;
  }
}

// `--repo DIR` overrides the working directory (relative to where the command was started).
export function commandCwd(values, ctx) {
  return values.repo ? resolve(ctx.cwd, values.repo) : ctx.cwd;
}

export function requireRepoRoot(cwd) {
  try {
    return repoRoot(cwd);
  } catch {
    throw new UsageError(`not inside a git repository: ${cwd}`);
  }
}
