// `pipeline ci-wait --pr N`: wait until the PR's required CI is really done, so the hand-off after `gh pr ready` is never
// early. Replaces the review skill's "poll until checks exist, then `gh pr checks --watch --required`" loop, which passed on
// the draft-era SKIPPED run of a required check (Phase 6, EW #1631). The decisions live in lib/ci-wait.mjs (a pure state
// machine); this file wires GitHub, the clock and stderr progress into it. Run it through `P job start` (it can outlast a
// tool call).
import { intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { loadConfig, requiredChecks } from '../lib/config.mjs';
import { createGitHub } from '../lib/github.mjs';
import { waitForCi } from '../lib/ci-wait.mjs';
import { readClassicRequired } from '../lib/protection.mjs';

export const meta = {
  summary: 'wait until the required CI of a ready PR is really done (ignores a draft-era skipped run), then report the verdict',
  usage: 'pipeline ci-wait --pr N [--repo DIR] [--appear-timeout SEC=300] [--timeout SEC=3600] [--interval SEC=15] [--wait-all]   -> {ok, verdict, head, readyAt, requiredSource, checks:[{name, appId, state, url}], message?, failures?, statusEvidence?, heldBy?, configChecks?}; verdict passed (exit 0) | failed | timeout | missing | stale-skipped | unverified | no-required-checks | head-moved | base-changed | draft (exit 1; a draft at the start: exit 2) | github (exit 3, 5 GitHub reads in a row failed)',
};

export const DEFAULT_APPEAR_SECONDS = 300;
export const DEFAULT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 15;

const realClock = () => ({ now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, repo: { type: 'string' }, 'appear-timeout': { type: 'string' }, timeout: { type: 'string' },
    interval: { type: 'string' }, 'wait-all': { type: 'boolean' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const appear = intOption(values, 'appear-timeout', { min: 0, max: 86_400 }) ?? DEFAULT_APPEAR_SECONDS;
  const timeout = intOption(values, 'timeout', { min: 1, max: 86_400 }) ?? DEFAULT_TIMEOUT_SECONDS;
  const interval = intOption(values, 'interval', { min: 1, max: 600 }) ?? DEFAULT_INTERVAL_SECONDS;
  const root = resolveRepo(values, ctx);

  // The check names the pipeline itself requires (config + the implicit guard / review contexts): diagnostics only, for a
  // verdict `unverified`. A config that does not load is not an error here.
  const loaded = await loadConfig(root);
  const configChecks = loaded.ok ? requiredChecks(loaded.config.ci) : [];

  // `ctx.ciWait` is the test seam: a scripted gh and a simulated clock.
  const seam = ctx.ciWait ?? {};
  const gh = seam.gh ?? createGitHub({ cwd: root, env: ctx.env });
  const readers = {
    async pr() {
      const v = gh.prView(pr, ['headRefOid', 'isDraft', 'createdAt', 'baseRefName']);
      return { head: v.headRefOid, isDraft: v.isDraft === true, createdAt: v.createdAt, base: v.baseRefName };
    },
    classic: async (base) => readClassicRequired(gh, base),
    rules: async (base) => gh.branchRules(base),
    checkRuns: async (head) => gh.checkRunsOf(head),
    statuses: async (head) => gh.statusesOf(head),
    timeline: async () => gh.timelineOf(pr),
    reviewMarkers: async () => gh.listComments(pr), // the PR's issue comments (paginated); only read to date a `Cross-model review` failure
    workflowRun: async (id) => gh.workflowRunOf(id), // one Actions run (run_started_at); only read to date a `Cross-model review` failure
    suiteRuns: async (suiteId) => gh.workflowRunsOfSuite(suiteId),
    headRuns: async (head) => gh.workflowRunsOfHead(head), // no fallback: a gh without it must fail the read, not silently end the late-aggregate hold
  };
  const result = await waitForCi({
    readers,
    options: { appearTimeoutMs: appear * 1000, timeoutMs: timeout * 1000, intervalMs: interval * 1000, waitAll: values['wait-all'] === true, configChecks },
    clock: seam.clock ?? realClock(),
    onProgress: seam.onProgress ?? ((line) => process.stderr.write(`ci-wait: ${line}\n`)),
  });
  return result;
});
