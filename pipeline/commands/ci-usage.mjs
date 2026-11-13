// `pipeline ci-usage`: what CI cost per PR and per class of run, and how often an agent pushed to a READY PR without `pipeline redraft` first. Reads the workflow runs, their jobs and the
// PRs' timelines and commits; read-only, display only. The classifier is lib/ci-usage.mjs (shared with the `pushedWhileReady` warning of `pipeline summary`), the reading and its budget
// lib/ci-usage-read.mjs.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { readRepoUsage } from '../lib/ci-usage-read.mjs';
import { DEFAULT_RATES, classifierVersion, renderUsageTable } from '../lib/ci-usage.mjs';
import { asciiLine } from '../lib/triage.mjs';

export const meta = {
  summary: 'CI cost per PR and class of run, and pushes to a ready PR that skipped `pipeline redraft`',
  usage: [
    'pipeline ci-usage [--repo-slug owner/name]... [--since YYYY-MM-DD|Nd] [--workflow NAME]... [--max-calls 400] [--rate os=usd]... [--json] [--repo DIR]',
    '  -> {ok, classifierVersion, since, repos: [{slug, private, billing (free-public | estimate-private), draftWhileIterating (true | false | "unknown"), since, partial, calls, rateLimit, skipped {prs, jobs}, totals, assumptions, prs, unexcludable}], warnings}:',
    '     the workflow runs created since the date (default 7d: `Nd` = now minus N x 24 h, or a UTC midnight YYYY-MM-DD; anything else exits 2) in each --repo-slug (default: the repository gh resolves from the current directory),',
    '     optionally only the --workflow NAME(s) (a name, a path or a file name). Every PR with a run of a minute or more has its timeline and commits read, and every such run its jobs (`actions/runs/{id}/jobs?filter=all`, every attempt).',
    '     totals {prs, heavyRuns (jobs add up to >= 1 min; with the jobs unread, the run lasted >= 1 min), workflowElapsedMin (measured: run updated_at - run_started_at), jobMinutes {linux, windows, macos, self-hosted} (the sum of the job durations),',
    '     estimatedUsd (ESTIMATE: each job rounded up to a whole minute x the rate of its OS, self-hosted 0; a public repository is free-public and 0), coverage (% of the heavy runs whose jobs were read), byClass, byEvent, pushesWhileReady,',
    '     missedRedrafts (= pushesWhileReady when the repository\'s .claude/pipeline.yml has ci.draft_while_iterating: true, 0 when false, null when it could not be read), wastedRedrafts, catchupsPerPr, churnRuns, churnMinutes, finalCatchupReruns};',
    '     class of a run: ready-for-review | push-while-ready | push-while-draft | converted-cancel | catch-up | rerun | other (not a pull_request run, by event in byEvent) | unclassified (its PR was not read);',
    '     prs [{pr, readyCycles, pushesWhileReady, pushedHeads, pushesWhileDraft, wastedRedrafts, catchups, heavyRuns, workflowElapsedMin, jobMinutes, estimatedUsd, churnRuns, churnMinutes, finalCatchupReruns}];',
    '     unexcludable: what the numbers cannot tell apart. Rates (USD per minute, default linux 0.008, windows 0.016, macos 0.08) are overridden with --rate os=usd (os: linux | windows | macos).',
    '     Budget: --max-calls GitHub calls (one per page; the PRs\' reads stop at 60% of it so the biggest runs get their jobs read) and a stop when fewer than 1000 rate-limit calls are left (checked at the start and every 50 calls): `partial: true`',
    '     with `skipped` counts and a warning; coverage then says how much of the cost is measured. Without --json the same numbers print as a plain-text table. Read-only; no billing endpoint, nothing is cached.',
  ].join('\n'),
};

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DAY_MS = 86_400_000;
const RATE_OS = ['linux', 'windows', 'macos'];

// `YYYY-MM-DD` (UTC midnight) | `Nd` (now - N x 24 h) -> ms. Anything else is a usage error.
export function parseSince(raw, now) {
  const text = raw ?? '7d';
  let m = /^(\d+)d$/.exec(text);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 3650) return now - Number(m[1]) * DAY_MS;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) {
    const t = Date.parse(`${text}T00:00:00Z`);
    if (Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === text) return t;
  }
  throw new UsageError(`--since must be YYYY-MM-DD or Nd (N days back, e.g. 7d), not ${asciiLine(text, 40)}`);
}

export function parseRates(list) {
  const rates = {};
  for (const item of list ?? []) {
    const m = /^([a-z]+)=(\d+(?:\.\d+)?)$/.exec(item);
    if (!m || !RATE_OS.includes(m[1])) throw new UsageError(`--rate ${asciiLine(item, 40)}: expected os=usd with os one of ${RATE_OS.join(', ')} (e.g. linux=0.008)`);
    rates[m[1]] = Number(m[2]);
  }
  return { ...DEFAULT_RATES, ...rates };
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    'repo-slug': { type: 'string', multiple: true }, since: { type: 'string' }, workflow: { type: 'string', multiple: true }, 'max-calls': { type: 'string' },
    rate: { type: 'string', multiple: true }, json: { type: 'boolean' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const now = ctx.now ?? Date.now();
  const sinceMs = parseSince(values.since, now);
  const maxCalls = intOption(values, 'max-calls', { min: 1, max: 100_000 }) ?? 400;
  const rates = parseRates(values.rate);
  for (const s of values['repo-slug'] ?? []) if (!SLUG_RE.test(s)) throw new UsageError(`--repo-slug ${asciiLine(s, 60)}: expected owner/name`);
  const root = resolveRepo(values, ctx);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const warnings = [];
    let viewer = null;
    try {
      viewer = gh.viewer(); // the converted_to_draft events of the pipeline are the viewer's: wasted redrafts count only those
    } catch (err) {
      warnings.push(`the viewer login could not be read (${asciiLine(err?.message, 100)}): wasted redrafts count a redraft by anyone`);
    }
    const slugs = (values['repo-slug'] ?? []).length > 0 ? [...new Set(values['repo-slug'])] : [gh.repo().slug];
    const repos = slugs.map((slug) => readRepoUsage({ gh, slug, sinceMs, workflows: values.workflow ?? [], maxCalls, rates, viewer, warnings }));
    const since = `${new Date(sinceMs).toISOString().slice(0, 19)}Z`;
    const result = { ok: true, classifierVersion, since, repos, warnings };
    if (values.json) return { exitCode: EXIT.OK, output: result };
    (ctx.stdout ?? process.stdout).write(`${renderUsageTable(result)}${warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${asciiLine(w, 300)}`).join('\n')}` : ''}\n`);
    return { exitCode: EXIT.OK, output: {}, silent: true };
  });
});
