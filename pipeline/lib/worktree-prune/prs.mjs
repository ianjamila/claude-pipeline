// Per-branch PR discovery for `pipeline worktrees prune` (spec §4 rule 2). Complete or nothing: any GitHub error,
// non-advancing cursor or page cap returns ok:false, which the caller turns into "kept: PR data incomplete" — a
// truncated answer is never read as "no open PR".
import { parseRemote } from '../remote-url.mjs';

export const BRANCH_PRS_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, CLOSED, MERGED], first: $first, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number state createdAt mergedAt headRefName headRefOid isCrossRepository headRepository { nameWithOwner } }
    }
  }
}`;

export function fetchBranchPrs(gh, branch) {
  const prs = [];
  try {
    gh.pagePullRequests(BRANCH_PRS_QUERY, (nodes) => {
      for (const n of nodes) if (n.headRefName === branch) prs.push(n);
    }, { branch });
  } catch (err) {
    return { ok: false, reason: `PR data incomplete: ${String(err?.stderr || err?.message || err).split('\n')[0].slice(0, 160)}` };
  }
  return { ok: true, prs };
}

export function checkRepoIdentity(gh, originUrl) {
  let slug;
  try {
    slug = gh.repo().slug;
  } catch (err) {
    return { ok: false, reason: `cannot read the GitHub repository: ${String(err?.stderr || err?.message).slice(0, 160)}`, unavailable: true };
  }
  const o = parseRemote(originUrl);
  const originSlug = o ? `${o.owner}/${o.name}` : null;
  if (!originSlug || originSlug.toLowerCase() !== slug.toLowerCase()) return { ok: false, reason: `gh repository ${slug} does not match origin (${originUrl})` };
  return { ok: true, slug };
}
