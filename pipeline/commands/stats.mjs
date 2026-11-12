// `pipeline stats rounds`: how many review rounds merged PRs used, how many went past review.max_rounds, what those found and what they cost. Reads each PR's own
// comments (run record, triage state); read-only, display only. Replaces the ad-hoc audit scripts of 2026-11-11.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { decodeRecord } from '../lib/run-record.mjs';
import { decodeFromComment } from '../lib/state.mjs';
import { aggregate, analysePr, renderTable } from '../lib/round-stats.mjs';
import { asciiLine } from '../lib/triage.mjs';

export const meta = {
  summary: 'review rounds of merged PRs: how many went past the limit, what they found and cost',
  usage: [
    'pipeline stats rounds [--repo-slug owner/name]... [--since YYYY-MM-DD] [--pr N]... [--json] [--repo DIR]',
    '  -> {ok, since, repos, totals, prs, warnings}: for the PRs merged since the date (default 7 days ago) in each --repo-slug (default: the repository gh resolves from the current directory), the PR\'s comments are',
    '     read (run record, triage state) and counted: totals {prs, prsPastCap, countedRounds, pastCapRounds, pastCapShare, admission {auto-extra|owner-granted|unknown}, previous (what the round before a past-limit round had',
    '     to re-check: no-accepts | only-low-fixes = non-BLOCKING non-security accepts | blocking-or-security), found (new-blocking | accepts | deferred = its accepts were all deferred past the cap | nothing-accepted), blockingLoopPrs, usd, pastCapUsd}; prs [{repo, pr, id, maxRounds,',
    '     countedRounds, pastCapRounds, usd, blockingLoop, rounds: [{n, k, pastCap, usd (cost.byRound, `cost --round R`), acceptedBlocking, admission?, previous?, found?}]}]. --pr N limits it to those PRs (merged or not listed by date).',
    '     Without --json the same numbers print as a plain-text table. A PR whose comments cannot be read is skipped with a warning; a PR with no review state is counted in `withoutState`. Exit 3 when GitHub cannot be reached for the list.',
    '     Read-only. Severity is judged from the recorded item (BLOCKING, a security category or a security word is not low), since a PR comment does not carry the reviewed diff `itemSeverity` needs.',
  ].join('\n'),
};

const PAGE = 100;
const MAX_PAGES = 30;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DAY_MS = 86_400_000;

function pages(gh, path, stop) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = gh.api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(list)) break;
    out.push(...list);
    if (list.length < PAGE || stop?.(list)) break;
  }
  return out;
}

async function rounds(rest, ctx) {
  const { values } = parseCommandArgs(rest, { 'repo-slug': { type: 'string', multiple: true }, since: { type: 'string' }, pr: { type: 'string', multiple: true }, json: { type: 'boolean' }, repo: { type: 'string' } }, { allowPositionals: false });
  const since = values.since ?? new Date((ctx.now ?? Date.now()) - 7 * DAY_MS).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) throw new UsageError('--since must be a date, YYYY-MM-DD');
  const only = (values.pr ?? []).map((p) => intOption({ pr: p }, 'pr', { min: 1 }));
  for (const s of values['repo-slug'] ?? []) if (!SLUG_RE.test(s)) throw new UsageError(`--repo-slug ${asciiLine(s, 60)}: expected owner/name`);
  const root = resolveRepo(values, ctx);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const repos = (values['repo-slug'] ?? []).length > 0 ? [...new Set(values['repo-slug'])] : [gh.repo().slug];
    const warnings = [];
    const analysed = [];
    let withoutState = 0;
    for (const slug of repos) {
      let numbers;
      if (only.length > 0) numbers = only;
      else {
        // newest-updated first: stop once a whole page is older than the date (a merged PR was updated at its merge, so nothing later in the list merged since)
        const closed = pages(gh, `repos/${slug}/pulls?state=closed&sort=updated&direction=desc`, (l) => l.every((p) => String(p.updated_at ?? '') < since));
        numbers = closed.filter((p) => typeof p.merged_at === 'string' && p.merged_at >= since).map((p) => p.number);
      }
      for (const number of numbers) {
        try {
          const comments = pages(gh, `repos/${slug}/issues/${number}/comments`);
          let record = null;
          let state = null;
          for (const c of comments) {
            const body = typeof c?.body === 'string' ? c.body : '';
            const r = decodeRecord(body);
            if (r.status === 'ok') record = r.record;
            if (body.includes('claude-pipeline:triage')) state = decodeFromComment(body) ?? state;
          }
          const p = analysePr({ repo: slug, pr: number, state, record });
          if (p === null) withoutState += 1;
          else analysed.push(p);
        } catch (err) {
          warnings.push(`${slug}#${number}: comments could not be read (${asciiLine(err?.message, 120)}): skipped`);
        }
      }
    }
    const result = { ok: true, since, repos, totals: aggregate(analysed), prs: analysed, withoutState, warnings };
    if (values.json) return { exitCode: EXIT.OK, output: result };
    (ctx.stdout ?? process.stdout).write(`${renderTable(result)}${warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join('\n')}` : ''}\n`);
    return { exitCode: EXIT.OK, output: {}, silent: true };
  });
}

const SUBCOMMANDS = { rounds };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline stats ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
