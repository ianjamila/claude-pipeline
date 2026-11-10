// Which pull requests a merge-queue commit is made of, read from GitHub's own queue-entry records (never guessed from the
// commit text). Used by the vendored queue poster (templates/scripts/pipeline/queue-guards-run.mjs), so it imports nothing:
// the caller hands in `read(apiPath, jqFilter) -> text` (throws on failure) and `graphql(query, variables) -> reply`.
//
// The D2 chain rule (measured in the Phase 0 spike): while an entry is waiting its `headCommit` is null; once GitHub builds its
// queue commit, `headCommit` is that commit and `baseCommit` is the previous entry's `headCommit` (or the default branch tip
// for the first entry). So a queue commit Q is explained by walking baseCommit links from the live entry whose headCommit is Q,
// down to the first commit no live entry owns: that is the base, and it must already be on the default branch (the entries below
// it merged). `compare main...Q` alone is timing-dependent (predecessors may have merged meanwhile), so git data only CROSS-CHECKS
// the chain: it must list exactly the chain's commits, single-parent, each titled "(#N)" with its own entry's PR.
// GitHub refuses pushes to a queued PR's branch, so a live entry's PR headRefOid IS the head that was queued.
// Anything unreadable or inconsistent is `ok: false` with a reason: a caller that cannot name the members posts errors.

const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
// compare shows at most 250 commits; a queue is a handful, so a count near that means the page is not the whole story.
export const MAX_COMPARE_COMMITS = 250;
const COMPARE_PAGE = 100;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** { pr, baseSha } from `[refs/heads/]gh-readonly-queue/<default>/pr-<N>-<40 hex>`, or null. */
export function parseQueueRef(ref, defaultBranch) {
  if (typeof ref !== 'string' || typeof defaultBranch !== 'string' || defaultBranch === '') return null;
  const m = new RegExp(`^(?:refs/heads/)?gh-readonly-queue/${escapeRe(defaultBranch)}/pr-([1-9][0-9]{0,9})-([0-9a-f]{40})$`).exec(ref);
  return m ? { pr: Number(m[1]), baseSha: m[2] } : null;
}

const QUEUE_QUERY = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){'
  + 'entries(first:100){pageInfo{hasNextPage} nodes{id state headCommit{oid} baseCommit{oid} pullRequest{number headRefOid baseRefName}}}}}}';
const COMPARE_JQ = '{total: .total_commits, commits: [.commits[] | {sha: .sha, parents: (.parents | length), subject: (.commit.message | split("\\n")[0])}]}';
const PR_JQ = '{state: .state, merged: .merged, mergeCommit: .merge_commit_sha}';

const message = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 100);
const oidOf = (c) => (c && typeof c === 'object' && SHA.test(String(c.oid ?? '')) ? c.oid : null);

/**
 * The queue entries as plain records [{ id, state, headCommit, baseCommit, pr, head, prBase }] (headCommit / baseCommit null while
 * an entry is only waiting), or { ok: false, reason }. One GraphQL read; a second page, a missing queue or a malformed entry fails.
 */
export function readQueueEntries({ graphql, repo, defaultBranch }) {
  const slug = SLUG.exec(String(repo ?? ''));
  if (!slug) return { ok: false, reason: 'the repository is not owner/name' };
  try {
    const reply = graphql(QUEUE_QUERY, { owner: slug[1], name: slug[2], branch: defaultBranch });
    const entries = (reply?.data ?? reply)?.repository?.mergeQueue?.entries;
    if (!entries || !Array.isArray(entries.nodes)) return { ok: false, reason: `the queue for ${defaultBranch} could not be read (no merge queue in the reply)` };
    if (entries.pageInfo?.hasNextPage) return { ok: false, reason: 'the queue has more entries than one page (cannot be walked)' };
    const out = [];
    for (const n of entries.nodes) {
      const pr = n?.pullRequest;
      const head = String(pr?.headRefOid ?? '');
      if (typeof n?.id !== 'string' || !n.id || !Number.isInteger(pr?.number) || !SHA.test(head)) return { ok: false, reason: 'a queue entry is malformed' };
      out.push({ id: n.id, state: String(n.state ?? ''), headCommit: oidOf(n.headCommit), baseCommit: oidOf(n.baseCommit), pr: pr.number, head, prBase: String(pr.baseRefName ?? '') });
    }
    return { ok: true, entries: out };
  } catch (err) {
    return { ok: false, reason: `the queue could not be read (${message(err)})` };
  }
}

// Is `sha` the default branch tip or an ancestor of it? Fails closed (false) on any read problem.
export function onDefaultBranch({ read, repo, defaultBranch, sha }) {
  if (!SHA.test(String(sha ?? ''))) return false;
  try {
    const status = String(read(`repos/${repo}/compare/${sha}...${encodeURIComponent(defaultBranch)}`, '.status')).trim();
    return status === 'identical' || status === 'ahead';
  } catch {
    return false;
  }
}

/**
 * { ok: true, manifest: { queueSha, base, members: [{ pr, head, entryId, commit, baseCommit }] } } (oldest member first) or
 * { ok: false, reason }. `queueRef`, when given, must be the queue ref of the top entry (its PR number and baseCommit).
 */
export function queueManifest({ read, graphql, repo, defaultBranch, queueSha, queueRef = null }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!SHA.test(String(queueSha ?? ''))) return fail('the queue commit is not a full sha');
  const got = readQueueEntries({ graphql, repo, defaultBranch });
  if (!got.ok) return got;
  const byCommit = new Map();
  for (const e of got.entries) {
    if (e.headCommit === null) continue; // still waiting: owns no commit
    if (byCommit.has(e.headCommit)) return fail('two queue entries claim the same queue commit');
    byCommit.set(e.headCommit, e);
  }
  const top = byCommit.get(queueSha);
  if (!top) return fail(`no live queue entry has ${queueSha.slice(0, 7)} as its queue commit (stale, or the PR was re-queued)`);

  // Newest first while walking down; reversed below.
  const chain = [top];
  const seen = new Set([top.id]);
  let base = top.baseCommit;
  while (base !== null && byCommit.has(base)) {
    const next = byCommit.get(base);
    if (seen.has(next.id)) return fail('the queue entries form a loop');
    seen.add(next.id);
    chain.push(next);
    base = next.baseCommit;
  }
  if (base === null) return fail('a queue entry has no base commit');

  if (queueRef !== null) {
    const parsed = parseQueueRef(queueRef, defaultBranch);
    if (!parsed) return fail(`${queueRef} is not a queue ref of ${defaultBranch}`);
    if (parsed.pr !== top.pr || parsed.baseSha !== top.baseCommit) return fail(`the queue ref names #${parsed.pr} on ${parsed.baseSha.slice(0, 7)}, the entry is #${top.pr} on ${String(top.baseCommit).slice(0, 7)}`);
  }
  const prs = chain.map((e) => e.pr);
  if (new Set(prs).size !== prs.length) return fail('the same PR appears twice in the queue chain');
  const foreign = chain.find((e) => e.prBase !== defaultBranch);
  if (foreign) return fail(`#${foreign.pr} is queued into ${foreign.prBase || '(unknown)'}, not ${defaultBranch}`);
  if (!onDefaultBranch({ read, repo, defaultBranch, sha: base })) return fail(`the chain's base ${base.slice(0, 7)} is not on the default branch (${defaultBranch})`);

  // Git cross-check: exactly the chain's commits, oldest first.
  let cmp;
  try {
    cmp = JSON.parse(read(`repos/${repo}/compare/${base}...${queueSha}?per_page=${COMPARE_PAGE}`, COMPARE_JQ));
  } catch (err) {
    return fail(`the commits between ${base.slice(0, 7)} and the queue commit could not be read (${message(err)})`);
  }
  const commits = Array.isArray(cmp?.commits) ? cmp.commits : null;
  if (!commits || !Number.isInteger(cmp.total)) return fail('the compare reply is malformed');
  if (cmp.total >= MAX_COMPARE_COMMITS) return fail(`compare lists ${cmp.total} commits: incomplete (limit ${MAX_COMPARE_COMMITS})`);
  if (commits.length !== cmp.total) return fail(`compare shows ${commits.length} of ${cmp.total} commits: incomplete`);
  const ordered = [...chain].reverse();
  if (commits.length !== ordered.length) return fail(`the queue commit has ${commits.length} commit(s) over its base, the chain has ${ordered.length} entr${ordered.length === 1 ? 'y' : 'ies'}`);
  for (let i = 0; i < ordered.length; i++) {
    const [c, e] = [commits[i], ordered[i]];
    if (String(c?.sha ?? '').toLowerCase() !== e.headCommit) return fail(`commit ${i + 1} of the queue commit is not entry #${e.pr}'s queue commit`);
    if (c.parents !== 1) return fail(`commit ${String(c.sha).slice(0, 7)} has ${c.parents} parents, not 1`);
    const subject = /\(#([0-9]+)\)$/.exec(String(c.subject ?? '').trim());
    if (!subject || Number(subject[1]) !== e.pr) return fail(`the subject of ${String(c.sha).slice(0, 7)} does not end with (#${e.pr})`);
  }
  return {
    ok: true,
    manifest: {
      queueSha,
      base,
      members: ordered.map((e) => ({ pr: e.pr, head: e.head, entryId: e.id, commit: e.headCommit, baseCommit: e.baseCommit })),
    },
  };
}

/**
 * Re-reads the queue and checks the manifest still holds (the poster's --publish step). A predecessor merging is normal queue
 * progress, so the rule is: the TOP entry must be live with the same id, queue commit, base commit and PR head; every other member
 * is either live and unchanged, or gone with its PR merged AT its own queue commit (D6) and that commit on the default branch.
 * Anything else (removed, re-created, merged at another commit, unreadable) is `ok: false` "a member's head or entry moved".
 */
export function recheckManifest({ read, graphql, repo, defaultBranch, manifest }) {
  const moved = (why) => ({ ok: false, reason: `a member's head or entry moved (${why})` });
  const got = readQueueEntries({ graphql, repo, defaultBranch });
  if (!got.ok) return got;
  const live = new Map(got.entries.map((e) => [e.id, e]));
  const members = Array.isArray(manifest?.members) ? manifest.members : [];
  if (members.length === 0) return moved('the manifest has no members');
  for (const m of members) {
    const e = live.get(m.entryId);
    if (e) {
      if (e.headCommit !== m.commit || e.baseCommit !== m.baseCommit || e.pr !== m.pr || e.head !== m.head) return moved(`#${m.pr} changed in the queue`);
      continue;
    }
    if (m.commit === manifest.queueSha) return moved(`#${m.pr} left the queue`);
    const why = unsettledReason({ read, repo, defaultBranch, member: m });
    if (why !== null) return moved(why);
  }
  return { ok: true };
}

// A member that has left the queue is settled when its PR merged AT its own queue commit and that commit is on the default branch (D6). null = settled,
// else why not. Shared by recheckManifest and memberStanding.
function unsettledReason({ read, repo, defaultBranch, member: m }) {
  let pr;
  try {
    pr = JSON.parse(read(`repos/${repo}/pulls/${m.pr}`, PR_JQ));
  } catch (err) {
    return `#${m.pr} could not be read: ${message(err)}`;
  }
  if (pr?.merged !== true || String(pr.mergeCommit ?? '').toLowerCase() !== m.commit) return `#${m.pr} left the queue without merging its queue commit`;
  if (!onDefaultBranch({ read, repo, defaultBranch, sha: m.commit })) return `#${m.pr}'s merge commit is not on the default branch`;
  return null;
}

/**
 * Where one manifest member stands NOW, for the poster's member check (eaglewatch#1769). GitHub empties `pull_requests` on the guard runs of a PR that merged
 * (the branch is deleted), so a predecessor that merged after the manifest was taken can no longer pass the provenance check; it does not need to, since it merged
 * on its own entry's green statuses. The same rule as recheckManifest's:
 *   { kind: 'live' }     the entry is still in the queue (or is the top entry, which owns the queue commit): the full guard check stands;
 *   { kind: 'settled' }  it left the queue, merged at its OWN queue commit, and that commit is on the default branch: its guard re-check is skipped;
 *   { kind: 'gone', reason }  it left the queue any other way (removed, merged at another commit): an error;
 *   { kind: 'unknown', reason }  the queue or the PR could not be read: the caller keeps its own verdict.
 */
export function memberStanding({ read, graphql, repo, defaultBranch, queueSha, member }) {
  const got = readQueueEntries({ graphql, repo, defaultBranch });
  if (!got.ok) return { kind: 'unknown', reason: got.reason };
  if (got.entries.some((e) => e.id === member.entryId) || member.commit === queueSha) return { kind: 'live' };
  const why = unsettledReason({ read, repo, defaultBranch, member });
  if (why === null) return { kind: 'settled' };
  return why.includes('could not be read') ? { kind: 'unknown', reason: why } : { kind: 'gone', reason: why };
}
