// The "pushed while ready" check of ONE PR, for `pipeline summary`: the same classifier `pipeline ci-usage` uses (lib/ci-usage.mjs#pushedWhileReady) over this PR's timeline,
// commits and pull_request runs. Only for a repository that iterates in draft (ci.draft_while_iterating: true), where a push to a ready PR means `pipeline redraft` was skipped and
// the full CI suite ran on it. Report only: it never redrafts and never fails the caller; any read error becomes one warning. Bounded like `stats` (MAX_PAGES per list).
import { loadConfig } from './config.mjs';
import { MAX_PAGES, PAGE, pages } from './gh-pages.mjs';
import { pushedWhileReady } from './ci-usage.mjs';
import { asciiLine } from './triage.mjs';

// -> { warnings: [], field?: { count, heads: [sha12, ...] }, note?: string }. Nothing is read from GitHub unless the config says true.
export async function pushedWhileReadyOf({ root, gh, pr }) {
  const none = { warnings: [] };
  try {
    const loaded = await loadConfig(root);
    if (!loaded.ok || loaded.config.ci?.draft_while_iterating !== true) return none;
  } catch {
    return none;
  }
  const warnings = [];
  try {
    const slug = gh.repo().slug;
    const cut = (what) => () => warnings.push(`pushed-while-ready check: the ${what} were cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE}): the count may be short`);
    const pull = gh.api('GET', `repos/${slug}/pulls/${pr}`);
    const timeline = pages(gh, `repos/${slug}/issues/${pr}/timeline`, undefined, cut('timeline events'));
    const commits = pages(gh, `repos/${slug}/pulls/${pr}/commits`, undefined, cut('commits'));
    const branch = pull?.head?.ref;
    if (typeof branch !== 'string' || branch === '' || typeof pull?.created_at !== 'string') throw new Error('the PR has no branch or creation time');
    const created = Date.parse(pull.created_at);
    const runs = pages(gh, `repos/${slug}/actions/runs?event=pull_request&branch=${encodeURIComponent(branch)}`, undefined, cut('workflow runs'), { key: 'workflow_runs' })
      // a branch name can have been used by an earlier PR: only the runs since this one was created, and not those linked to another PR
      .filter((r) => Date.parse(r.created_at) >= created && ((r.pull_requests ?? []).length === 0 || r.pull_requests.some((p) => p?.number === pr)));
    const found = pushedWhileReady({ pr: { createdAt: pull.created_at, draft: pull.draft === true }, timeline, commits, runs });
    if (found.count === 0) return { warnings };
    const heads = found.heads.map((h) => h.sha.slice(0, 12));
    const times = found.count === 1 ? 'once' : `${found.count} times`;
    warnings.push(`pushed to the ready PR without \`P redraft\` first ${found.count} time(s): ${heads.join(', ')}; CI ran the full suite each time`);
    return { warnings, field: { count: found.count, heads }, note: `Pushed to the ready PR without \`pipeline redraft\` first ${times}: ${heads.join(', ')} (CI ran the full suite each time).` };
  } catch (err) {
    warnings.push(`pushed-while-ready check skipped: GitHub could not be read (${asciiLine(err?.message, 120)})`);
    return { warnings };
  }
}
