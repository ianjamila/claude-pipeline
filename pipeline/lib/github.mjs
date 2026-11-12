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
// The follow-up creator scan pages through every issue and PR an account ever opened in the repo (#268): 100 per page,
// and its own, longer limit for that one paginated call. Every other call keeps CALL_TIMEOUT_MS.
const SCAN_PER_PAGE = 100;
const SCAN_TIMEOUT_MS = 180_000;

// ---- GraphQL: paged pull request lists -----------------------------------------------------------
// Page size 20: a bigger page can trip GitHub's node limit on heavy queries.
const GRAPHQL_PAGE = 20;
const MAX_PAGES = 100;

const nodesOf = (conn) => (Array.isArray(conn?.nodes) ? conn.nodes.filter((n) => n !== null && typeof n === 'object') : []);

// A merge-queue reply that does not have the shape we asked for is a failure, not an empty queue.
const queueError = (message) => new GhError({ code: 0, stderr: `merge queue: ${message}`, args: ['api', 'graphql'] });
function queueField(value, type, label) {
  if (typeof value !== type || (type === 'string' && value === '')) throw queueError(`${label} is missing or malformed`);
  return value;
}

export const encodePath =(p) => String(p).split('/').map(encodeURIComponent).join('/');

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
  let repoIdCache; // undefined = not read yet
  let viewerCache = null;

  const exec = (args, { input, timeoutMs = CALL_TIMEOUT_MS } = {}) => ghFn(args, { cwd, env, input, timeoutMs });
  const failure = (r, args) => {
    const err = new GhError({ code: r.code, stderr: r.stderr, args, timedOut: r.timedOut, overBuffer: r.overBuffer === true });
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

  const commentList = (args) => {
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
  };

  // GET a list, every page: [{...}, ...]. A reply that is not a list of objects is a failure, never partial data.
  const pagedList = (path, jq) => {
    const args = ['api', path, '--paginate', ...(jq ? ['--jq', jq] : [])];
    const r = ok(args);
    let list;
    try {
      list = parseConcatenatedJson(r.stdout);
    } catch (err) {
      throw new GhError({ code: r.code, stderr: `could not parse ${path.split('?')[0]}: ${err.message}`, args });
    }
    if (!list.every((x) => x !== null && typeof x === 'object')) {
      throw new GhError({ code: r.code, stderr: `${path.split('?')[0]} reply was not a list of objects`, args });
    }
    return list;
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

    // REST DELETE of one label of a PR (not `pr edit`): `P merge --owner-go` lifts the needs-human hold the owner's "merge" named with it
    // (lib/hold.mjs). A label that is not on the PR answers 404 and throws, like any other failure.
    deleteLabel(n, name) {
      ok(['api', '-X', 'DELETE', `repos/${self.repo().slug}/issues/${prNumber(n)}/labels/${encodeURIComponent(name)}`]);
    },

    // POST a GraphQL query through `gh api graphql`: strings go as -f (never type-coerced, so a repo called "123" stays a
    // string), numbers and booleans as -F. A reply with `errors` (or without `data`) is a failure, never partial data.
    graphql(query, variables = {}) {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [k, v] of Object.entries(variables)) {
        if (v === undefined || v === null) continue;
        args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
      }
      const body = parse(ok(args), args);
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const message = body.errors.map((e) => String(e?.message ?? e)).join('; ').slice(0, 300);
        throw new GhError({ code: 0, stderr: `GraphQL error: ${message}`, args });
      }
      if (body?.data === undefined || body.data === null) {
        throw new GhError({ code: 0, stderr: 'GraphQL reply has no data', args });
      }
      return body.data;
    },

    // Follows pageInfo until the end. `visit(nodes)` returns true to stop early. A cursor that does not advance is an error
    // (an endless loop would hang the pipeline), as is a reply without the pull request connection.
    pagePullRequests(query, visit, extraVars = {}) {
      const { owner, name } = self.repo();
      let after = null;
      const seen = new Set();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const data = self.graphql(query, { ...extraVars, owner, name, first: GRAPHQL_PAGE, after });
        const conn = data?.repository?.pullRequests;
        if (!conn || !Array.isArray(conn.nodes)) {
          throw new GhError({ code: 0, stderr: 'GraphQL reply has no pullRequests connection', args: ['api', 'graphql'] });
        }
        if (visit(nodesOf(conn)) === true) return;
        if (conn.pageInfo?.hasNextPage !== true) return;
        const next = conn.pageInfo.endCursor;
        if (typeof next !== 'string' || next === '' || seen.has(next)) {
          throw new GhError({ code: 0, stderr: 'GraphQL pagination did not advance', args: ['api', 'graphql'] });
        }
        seen.add(next);
        after = next;
      }
      throw new GhError({ code: 0, stderr: `more than ${MAX_PAGES} pages of pull requests`, args: ['api', 'graphql'] });
    },

    listIssues: ({ label, state = 'open' }) =>
      getJson(['issue', 'list', '--label', label, '--state', state, '--json', 'number,title,url,labels', '--limit', '100']),
    listPrs: ({ label, state = 'open' }) =>
      getJson(['pr', 'list', '--label', label, '--state', state, '--json', 'number,title,headRefName,url', '--limit', '100']),

    // Every issue `creator` opened, open AND closed by default, whatever its page and WHATEVER ITS LABELS: the follow-up
    // dedupe must still see an issue the owner promoted (relabelled agent-suggestion -> agent-build) or closed. This is the
    // REST list, not the search API, which lags behind a just-created issue. It returns pull requests too; they are dropped.
    // `since` (a UTC ISO instant) keeps only issues UPDATED at or after it, so a caller that knows when its issues can first
    // exist skips years of history; a promoted or closed issue was updated later still, so it stays in view.
    listIssuesByCreator({ creator, state = 'all', since }) {
      const bound = since === undefined ? '' : `&since=${encodeURIComponent(since)}`;
      const args = ['api', `repos/${self.repo().slug}/issues?creator=${encodeURIComponent(creator)}&state=${encodeURIComponent(state)}&per_page=${SCAN_PER_PAGE}${bound}`, '--paginate'];
      const r = ok(args, { timeoutMs: SCAN_TIMEOUT_MS });
      let list;
      try {
        list = parseConcatenatedJson(r.stdout);
      } catch (err) {
        throw new GhError({ code: r.code, stderr: `could not parse issues: ${err.message}`, args });
      }
      if (!list.every((i) => i !== null && typeof i === 'object')) {
        throw new GhError({ code: r.code, stderr: 'issues reply was not a list of objects', args });
      }
      return list
        .filter((i) => i.pull_request === undefined)
        .map((i) => ({ number: i.number, url: i.html_url, state: i.state, body: typeof i.body === 'string' ? i.body : '', author: i.user?.login ?? null }));
    },

    issueCreate({ title, body, labels = [] }) {
      const r = api('POST', `repos/${self.repo().slug}/issues`, { title, body, labels });
      return { number: r.number, url: r.html_url };
    },

    listLabels: () => getJson(['label', 'list', '--json', 'name,color,description', '--limit', '200']),
    createLabel: ({ name, color, description }) => ok(['label', 'create', name, '--color', color, '--description', description]),
    editLabel: ({ name, color, description }) => ok(['label', 'edit', name, '--color', color, '--description', description]),

    listComments(n) {
      return commentList(['api', `repos/${self.repo().slug}/issues/${prNumber(n)}/comments`, '--paginate']);
    },

    // Every issue/PR comment of the repo updated since `since` (an ISO instant); each carries its `issue_url`.
    listRepoComments(since) {
      return commentList(['api', `repos/${self.repo().slug}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`, '--paginate']);
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

    // Always a NEW comment, never an edit: for append-only evidence (run events) that no later writer may overwrite.
    createComment(n, body) {
      const r = api('POST', `repos/${self.repo().slug}/issues/${prNumber(n)}/comments`, { body });
      return { id: r.id, url: r.html_url };
    },

    // 200 / 403 (plan | permission) / 404 are answers; anything else (5xx, network) throws.
    protection(branch) {
      const args = ['api', `repos/${self.repo().slug}/branches/${encodePath(branch)}/protection`];
      const r = exec(args);
      if (r.code === 0 && !r.timedOut) return { status: 200, json: parse(r, args) };
      const known = r.timedOut || r.overBuffer ? null : classifyApiError(r); // a cut-off body can still hold "HTTP 404"
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

    // The REST reads ci-wait polls. Each is a paginated list read to the end: with --jq the filter runs per page, so every page
    // prints as one array (`[..][..]`) that parseConcatenatedJson reads whole; a bare --paginate of an object reply would
    // print concatenated objects and lose page 2.
    // Check runs of a commit (the Checks API: name, app.id, status, conclusion, check_suite.id).
    checkRunsOf: (head) => pagedList(`repos/${self.repo().slug}/commits/${encodeURIComponent(head)}/check-runs?per_page=100`, '.check_runs'),
    // The status LIST of a commit (every status ever posted, newest first; carries creator.login). NOT the combined /status.
    statusesOf: (head) => pagedList(`repos/${self.repo().slug}/commits/${encodeURIComponent(head)}/statuses?per_page=100`),
    // Rules that apply to a branch from repository rulesets; an empty list means none.
    branchRules: (branch) => pagedList(`repos/${self.repo().slug}/rules/branches/${encodePath(branch)}?per_page=100`),
    // The numeric id of this repository (a rename or transfer keeps it; the queue record binds to it). Read once; null when GitHub does not
    // answer a positive integer: callers then fall back to the repository name (recordIsFor).
    repoId() {
      if (repoIdCache !== undefined) return repoIdCache;
      let id = null;
      try {
        const text = String(self.apiText(`repos/${self.repo().slug}`, '.id')).trim();
        if (/^[1-9][0-9]{0,15}$/.test(text)) id = Number(text);
      } catch { /* unreadable: null */ }
      repoIdCache = id;
      return id;
    },

    // ---- merge queue (GraphQL only: REST has no queue reads). Replies are checked field by field and anything off throws
    // GhError: an unreadable queue is never read as "no queue" (the callers fail closed).
    // The GraphQL node id of a PR (enqueue / dequeue name the PR by it).
    prNodeId(n) {
      const { owner, name } = self.repo();
      const data = self.graphql('query PrNodeId($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}', { owner, name, number: Number(prNumber(n)) });
      return queueField(data?.repository?.pullRequest?.id, 'string', 'the PR node id');
    },

    // One query: is a queue required on the PR's base, is the PR in it (and where), and how did the PR end.
    // -> { enabled, inQueue, state: OPEN|MERGED|CLOSED, head, mergeSha|null, entry: { id, state, position, enqueuedAt, headCommit|null }|null }
    // `entry.headCommit` is null while the entry is only QUEUED: GitHub builds the queue commit later (Phase 0 D2).
    queueState(n) {
      const { owner, name } = self.repo();
      const data = self.graphql(`query QueueState($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state headRefOid isMergeQueueEnabled mergeCommit{oid} mergeQueueEntry{id state position enqueuedAt headCommit{oid}}}}}`, { owner, name, number: Number(prNumber(n)) });
      const pr = data?.repository?.pullRequest;
      if (!pr || typeof pr !== 'object') throw queueError('GraphQL reply has no pullRequest');
      if (!['OPEN', 'MERGED', 'CLOSED'].includes(pr.state)) throw queueError(`unexpected PR state ${JSON.stringify(pr.state)}`);
      const e = pr.mergeQueueEntry ?? null;
      let entry = null;
      if (e !== null) {
        queueField(e.id, 'string', 'the queue entry id');
        queueField(e.state, 'string', 'the queue entry state');
        queueField(e.position, 'number', 'the queue entry position');
        queueField(e.enqueuedAt, 'string', 'the queue entry time');
        entry = { id: e.id, state: e.state, position: e.position, enqueuedAt: e.enqueuedAt, headCommit: e.headCommit?.oid ?? null };
      }
      return {
        enabled: queueField(pr.isMergeQueueEnabled, 'boolean', 'isMergeQueueEnabled'),
        inQueue: entry !== null,
        state: pr.state,
        head: queueField(pr.headRefOid, 'string', 'headRefOid'),
        mergeSha: pr.mergeCommit?.oid ?? null,
        entry,
      };
    },

    // The PR's queue history in timeline order (the order is what matches a removal to its enqueue; timestamps can tie):
    // -> [{ type: 'added'|'removed'|'merged', at, reason|null, actor|null, beforeCommit|null }]. `reason` is GitHub's own string
    // (`failed_checks`, `manual`, `merged`, ...); `beforeCommit` is the queue commit a removal ended (D6: the merge commit on `merged`).
    queueEvents(n) {
      const { owner, name } = self.repo();
      const query = `query QueueEvents($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){timelineItems(first:100,after:$after,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,MERGED_EVENT]){nodes{__typename ... on AddedToMergeQueueEvent{createdAt actor{login}} ... on RemovedFromMergeQueueEvent{createdAt reason actor{login} beforeCommit{oid}} ... on MergedEvent{createdAt actor{login}}} pageInfo{hasNextPage endCursor}}}}}`;
      const TYPES = { AddedToMergeQueueEvent: 'added', RemovedFromMergeQueueEvent: 'removed', MergedEvent: 'merged' };
      const events = [];
      let after = null;
      const seen = new Set();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const conn = self.graphql(query, { owner, name, number: Number(prNumber(n)), after })?.repository?.pullRequest?.timelineItems;
        if (!conn || !Array.isArray(conn.nodes)) throw queueError('GraphQL reply has no timelineItems');
        for (const node of conn.nodes) {
          const type = TYPES[node?.__typename];
          if (type === undefined) throw queueError(`unexpected timeline event ${JSON.stringify(node?.__typename ?? null)}`);
          events.push({
            type,
            at: queueField(node.createdAt, 'string', 'an event time'),
            reason: type === 'removed' ? (node.reason ?? null) : null,
            actor: node.actor?.login ?? null,
            beforeCommit: type === 'removed' ? (node.beforeCommit?.oid ?? null) : null,
          });
        }
        if (conn.pageInfo?.hasNextPage !== true) return events;
        after = conn.pageInfo.endCursor;
        if (typeof after !== 'string' || after === '' || seen.has(after)) throw queueError('GraphQL pagination did not advance');
        seen.add(after);
      }
      throw queueError(`more than ${MAX_PAGES} pages of queue events`);
    },

    // Puts the PR in the queue, pinned to `sha`: GitHub refuses if the head moved ("expected head oid does not match", D1), so the
    // owner's approval of one head can never queue another. -> { id, state, position }. Throws (GhError) on any refusal.
    enqueue(n, sha) {
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new TypeError(`invalid head sha: ${JSON.stringify(sha)}`);
      const id = self.prNodeId(n);
      const data = self.graphql('mutation Enqueue($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){mergeQueueEntry{id state position}}}', { pullRequestId: id, expectedHeadOid: sha });
      const e = data?.enqueuePullRequest?.mergeQueueEntry;
      if (!e || typeof e !== 'object') throw queueError('enqueuePullRequest returned no queue entry');
      return { id: queueField(e.id, 'string', 'the queue entry id'), state: queueField(e.state, 'string', 'the queue entry state'), position: queueField(e.position, 'number', 'the queue entry position') };
    },

    // Turns a ready PR back to draft (`pipeline redraft`): the node id, then one GraphQL mutation whose answer carries the new state AND whether
    // auto-merge is armed on the PR (so there is no read-after-write lag to wait out). -> { isDraft, autoMergeArmed }. Throws GhError on any
    // refusal or an answer without the pull request.
    convertToDraft(n) {
      const id = self.prNodeId(n);
      const args = ['api', 'graphql'];
      const data = self.graphql('mutation ConvertToDraft($pullRequestId:ID!){convertPullRequestToDraft(input:{pullRequestId:$pullRequestId}){pullRequest{isDraft autoMergeRequest{enabledAt}}}}', { pullRequestId: id });
      const p = data?.convertPullRequestToDraft?.pullRequest;
      if (!p || typeof p !== 'object') throw new GhError({ code: 0, stderr: 'convertPullRequestToDraft returned no pull request', args });
      return { isDraft: p.isDraft === true, autoMergeArmed: p.autoMergeRequest !== null && p.autoMergeRequest !== undefined };
    },

    // Takes the PR out of the queue (the owner's stop conditions, the pipeline's confirmed dequeue).
    dequeue(n) {
      const id = self.prNodeId(n);
      const data = self.graphql('mutation Dequeue($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}', { id });
      if (!data?.dequeuePullRequest || typeof data.dequeuePullRequest !== 'object') throw queueError('dequeuePullRequest returned no answer');
    },

    // The timeline events of an issue or PR (ready_for_review, converted_to_draft, ...).
    timelineOf: (n) => pagedList(`repos/${self.repo().slug}/issues/${prNumber(n)}/timeline?per_page=100`),
    // The workflow runs of one check suite (their created_at tells a draft-era run from a ready-era one).
    workflowRunsOfSuite: (suiteId) => pagedList(`repos/${self.repo().slug}/actions/runs?check_suite_id=${encodeURIComponent(suiteId)}&per_page=100`, '.workflow_runs'),

    // One workflow run by id (run_started_at, created_at, status): ci-wait dates a `Cross-model review` failure by when the run that posted it started.
    workflowRunOf: (id) => api('GET', `repos/${self.repo().slug}/actions/runs/${encodeURIComponent(id)}`),

    // The workflow runs of a head commit (status queued / in_progress / completed ..., created_at): ci-wait uses the unfinished ones created
    // after the ready event to keep waiting for a late `needs:`-gated check.
    workflowRunsOfHead: (head) => pagedList(`repos/${self.repo().slug}/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`, '.workflow_runs'),

    // The files of a PR as GitHub lists them (every page): [{ filename, previous_filename?, status, ... }]. GitHub computes this from its own
    // copy of the commits, so it is the cross-check for a local diff (--owner-go: an object graph altered here shows up as a difference).
    pullFiles: (n) => pagedList(`repos/${self.repo().slug}/pulls/${prNumber(n)}/files?per_page=100`),

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
      if (!r.timedOut && !r.overBuffer && /HTTP 422|"status"\s*:\s*"?422/.test(`${r.stderr}\n${r.stdout}`)) {
        if (/expected head sha/i.test(message)) return { result: 'head-moved', message };
        if (/merge conflict/i.test(message)) return { result: 'conflict', message };
      }
      throw failure(r, args);
    },

    // gh exits 8 while checks are pending and 1 when some failed, and still prints the JSON; only a
    // reply that is not JSON (auth error, "no checks reported") is a failure.
    checks(n, { required = false } = {}) {
      const args = ['pr', 'checks', prNumber(n), '--json', 'name,state,bucket,link,workflow', ...(required ? ['--required'] : [])];
      const r = exec(args);
      if (r.timedOut || r.overBuffer) throw failure(r, args);
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
