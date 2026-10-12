// prod-watch: the decision logic is tested with every effect injected (each branch, no waiting), the real git revert with
// throwaway repos, the Vercel wrapper against a stateful fake CLI, and the command end to end with fake gh + fake vercel.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { run as procRun } from '../pipeline/lib/proc.mjs';
import { GitError, git as gitRunReal } from '../pipeline/lib/git.mjs';
import { fill } from '../pipeline/lib/config.mjs';
import {
  runProdWatch, exitCodeFor, hostOf, readKnownGood, knownGoodFromEvents, createGitOps, createSmoke, createRunRecordTracker, issueTitle,
  resolveMergeSha,
} from '../pipeline/lib/prodwatch.mjs';
import { renderEvent, listEvents, parseEvent } from '../pipeline/lib/run-events.mjs';
import { decodeRecord, emptyRecord } from '../pipeline/lib/run-record.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { planResume } from '../pipeline/lib/resume-plan.mjs';
import { inspectAlias, rollback, vercelCommand, linkedProjectDir, VercelError, tail } from '../pipeline/lib/vercel.mjs';
import { prodEvent, buildMessage, LEDGER_NAME } from '../pipeline/lib/notify.mjs';
import { run as prodWatchRun } from '../pipeline/commands/prod-watch.mjs';
import { GhError } from '../pipeline/lib/proc.mjs';
import { UnavailableError } from '../pipeline/lib/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeVercelPath = join(here, 'fixtures', 'fake-vercel.mjs');

const scratch = [];
const tmp = (prefix = 'cp-prodwatch-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));

// ---- the injected-deps harness ---------------------------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const DEPLOYED_AT = '2026-10-01T10:00:00Z';
const T = Date.parse(DEPLOYED_AT);
const OURS = { id: 'dpl_ours', url: 'ours-abc-team.vercel.app', readyState: 'READY', createdAt: T + 2000 };
const NEWER = { id: 'dpl_newer', url: 'newer-def-team.vercel.app', readyState: 'READY', createdAt: T + 600_000 };
const OLDER = { id: 'dpl_old', url: 'old-xyz-team.vercel.app', readyState: 'READY', createdAt: T - 600_000 };
const KNOWN_GOOD = { ok: true, id: 'dpl_old', url: 'https://old-xyz-team.vercel.app', sha: OLD_SHA };

const config = () => ({
  project: 'demo app',
  default_branch: 'main',
  worktree_dir: '.worktrees',
  production: {
    url: 'https://app.example.com',
    environment: 'Production',
    smoke: 'node smoke.mjs --base {url}',
    deploy_timeout_minutes: 20,
    provider: 'vercel',
    rollback: { command: 'vercel rollback {deployment} --yes', notes: 'Promote a deployment to resume.' },
  },
});

// Returns the next scripted answer each call; the last one repeats. A function answer is called, an Error is thrown.
function seq(items) {
  let i = 0;
  const fn = (...args) => {
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    fn.calls.push(args);
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item(...args) : item;
  };
  fn.calls = [];
  return fn;
}

function harness(over = {}) {
  const log = [];
  const held = {};
  let lockHeld = false;
  const mark = (name) => { log.push(name); held[name] = lockHeld; };

  const smoke = seq(over.smoke ?? [{ ok: true, tail: 'all checks passed' }]);
  const inspect = seq(over.inspect ?? [OURS]);
  const rollbackFn = seq(over.rollback ?? [{ ok: true, code: 0, tail: 'Success! old is now serving production' }]);
  const issueCreate = seq(over.issueCreate ?? [{ number: 50, url: 'https://github.com/acme/widgets/issues/50' }]);
  const prCreate = seq(over.prCreate ?? [{ number: 51, url: 'https://github.com/acme/widgets/pull/51' }]);
  const issueComment = seq([null]);
  const revertBranch = seq(over.revertBranch ?? [{ branch: 'agent/revert-12', subject: 'Add widget (#12)' }]);
  const findDeployment = seq(over.findDeployment ?? [{ state: 'success', id: 11, url: 'https://ours-abc-team.vercel.app', createdAt: DEPLOYED_AT }]);
  const sleeps = [];
  const locks = [];
  // Opt-in (`events: true`, `record: true`): the plain harness has no PR to write to, like `prod-watch --sha` alone.
  const posted = [];
  const recordCalls = [];
  const events = !over.events ? undefined : {
    post: async (kind, id, sentence, data) => {
      mark(`event:${kind}`);
      if ((over.postFail ?? []).includes(kind)) throw new Error('gh api: 502 Bad Gateway');
      posted.push({ kind, id, sentence, data });
    },
    list: async () => { if (over.eventListError) throw new Error('gh api: 500'); return over.eventList ?? []; },
  };
  const runRecord = !over.record ? undefined : {
    set: async (inFlight) => { mark('record:set'); recordCalls.push(['set', inFlight]); if (over.recordFail === 'set') throw new Error('summary comment unreadable'); },
    clear: async () => { mark('record:clear'); recordCalls.push(['clear']); if (over.recordFail === 'clear') throw new Error('gh api: 502'); },
    finish: async (outcome, detail) => { mark('record:finish'); recordCalls.push(['finish', outcome, detail]); if (over.recordFail === 'finish') throw new Error('gh api: 503'); },
  };

  const deps = {
    ...(events ? { events } : {}),
    ...(runRecord ? { runRecord } : {}),
    findDeployment: (a) => { mark('find'); return findDeployment(a); },
    smoke: async (a) => { mark('smoke'); return smoke(a); },
    inspectAlias: async (d) => { mark('inspect'); return inspect(d); },
    rollback: async (t) => { mark('rollback'); return rollbackFn(t); },
    github: {
      issueCreate: async (i) => { mark('issue'); return issueCreate(i); },
      issueComment: async (n, b) => { mark('comment'); return issueComment(n, b); },
      prCreate: async (p) => { mark('pr'); return prCreate(p); },
      prView: async () => ({ title: 'Add widget' }),
      deployments: async () => over.ghDeployments ?? [],
      deploymentStatuses: async (id) => (over.ghStatuses ?? {})[id] ?? [],
    },
    git: { revertBranch: async (a) => { mark('revert'); return revertBranch(a); } },
    sleep: async (ms) => { sleeps.push(ms); if (over.sleep) over.sleep(ms, sleeps.length); },
    now: () => T + 5000,
    lock: over.lock ?? (async (name, fn) => {
      locks.push(name);
      lockHeld = true;
      log.push('lock+');
      try {
        return await fn();
      } finally {
        lockHeld = false;
        log.push('lock-');
      }
    }),
    readKnownGood: over.readKnownGood ?? (() => KNOWN_GOOD),
    note: () => {},
  };
  return {
    log, held, sleeps, locks, posted, recordCalls, smoke, inspect, rollbackFn, issueCreate, prCreate, issueComment, revertBranch, findDeployment,
    go: (opts = {}) => runProdWatch({ config: over.config ?? config(), sha: SHA, pr: 12, root: '/repo', ...opts }, deps),
  };
}

const FAIL = { ok: false, code: 1, tail: '{"ok":false,"checks":[{"path":"/","status":500}]}' };
const PASS = { ok: true, code: 0, tail: '{"ok":true}' };

// ---- happy paths ------------------------------------------------------------------------------------------------------

test('merged: our deployment is live and the smoke passes (no issue, no lock, no rollback)', async () => {
  const h = harness({ smoke: [PASS], inspect: [OURS] });
  const r = await h.go();
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'merged');
  assert.equal(r.mergeSha, SHA);
  assert.equal(r.deployment.url, 'https://ours-abc-team.vercel.app');
  assert.equal(r.live.id, 'dpl_ours');
  assert.deepEqual(r.smoke, { ok: true, tail: '{"ok":true}' });
  assert.equal(r.issue, null);
  assert.equal(r.revertPr, null);
  assert.equal(exitCodeFor(r.outcome), 0);
  assert.ok(!h.log.includes('issue') && !h.log.includes('rollback') && !h.log.includes('lock+'));
  assert.deepEqual(h.findDeployment.calls[0][0], { sha: SHA, environment: 'Production', timeoutMs: 20 * 60_000 });
  assert.deepEqual(h.smoke.calls[0][0], { url: 'https://app.example.com', expectText: null });
  assert.equal(h.inspect.calls[0][0], 'app.example.com');
});

test('merged: --expect-text is handed to the smoke', async () => {
  const h = harness({ smoke: [PASS] });
  await h.go({ expectText: 'New heading' });
  assert.equal(h.smoke.calls[0][0].expectText, 'New heading');
});

test('merged: a newer deployment is serving production (ours was replaced by a later deploy)', async () => {
  const h = harness({ smoke: [PASS], inspect: [NEWER] });
  const r = await h.go();
  assert.equal(r.outcome, 'merged');
  assert.equal(r.live.id, 'dpl_newer');
});

test('merged: a redeploy of the same commit counts as ours (mapped to the sha through GitHub deployments)', async () => {
  const h = harness({
    smoke: [PASS],
    inspect: [{ ...OLDER, id: 'dpl_redeploy', url: 'redeploy-777-team.vercel.app' }],
    ghDeployments: [{ id: 90, sha: SHA, created_at: DEPLOYED_AT }],
    ghStatuses: { 90: [{ state: 'inactive' }, { state: 'success', environment_url: 'https://redeploy-777-team.vercel.app' }] },
  });
  assert.equal((await h.go()).outcome, 'merged');
});

test('merged: smoke fails once, passes on the retry after the CDN-propagation pause', async () => {
  const h = harness({ smoke: [FAIL, PASS], inspect: [OURS] });
  const r = await h.go();
  assert.equal(r.outcome, 'merged');
  assert.deepEqual(h.sleeps, [60_000]);
  assert.equal(h.smoke.calls.length, 2);
  assert.ok(!h.log.includes('lock+'));
});

// ---- the deployment itself --------------------------------------------------------------------------------------------

test('deploy-failed: issue needs-human, nothing smoked or rolled back, exit 1', async () => {
  const h = harness({ findDeployment: [{ state: 'failure', id: 11, url: 'https://vercel.com/acme/log' }] });
  const r = await h.go();
  assert.equal(r.outcome, 'deploy-failed');
  assert.equal(r.ok, false);
  assert.equal(exitCodeFor(r.outcome), 1);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['needs-human']);
  assert.equal(h.issueCreate.calls[0][0].title, '[pipeline] production deploy-failed after #12 (aaaaaaa)');
  assert.match(h.issueCreate.calls[0][0].body, /never switched/);
  assert.match(h.issueCreate.calls[0][0].body, /vercel\.com\/acme\/log/);
  assert.equal(h.smoke.calls.length, 0);
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.ok(!h.log.includes('lock+'));
  assert.equal(r.issue.number, 50);
});

test('deploy-not-observed: issue needs-human and exit 3', async () => {
  const h = harness({ findDeployment: [{ state: 'timeout' }] });
  const r = await h.go();
  assert.equal(r.outcome, 'deploy-not-observed');
  assert.equal(exitCodeFor(r.outcome), 3);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['needs-human']);
  assert.match(h.issueCreate.calls[0][0].body, /within 20 minutes/);
  assert.equal(h.smoke.calls.length, 0);
  assert.equal(h.rollbackFn.calls.length, 0);
});

// ---- smoke passes but the merge is not what is live -------------------------------------------------------------------

test('not-live: smoke passes while an older deployment keeps serving; five more looks, then an issue (exit 1)', async () => {
  const h = harness({ smoke: [PASS], inspect: [OLDER] });
  const r = await h.go();
  assert.equal(r.outcome, 'not-live');
  assert.equal(h.inspect.calls.length, 6);
  assert.deepEqual(h.sleeps, [60_000, 60_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['needs-human']);
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.equal(exitCodeFor(r.outcome), 1);
});

test('merged after waiting: the alias switches to ours, and the smoke is re-run against the deployment that is live now', async () => {
  const h = harness({ smoke: [PASS, PASS], inspect: [OLDER, OLDER, OURS] });
  const r = await h.go();
  assert.equal(r.outcome, 'merged');
  assert.equal(h.smoke.calls.length, 2, 'the first pass ran against the old deployment, so it must not count');
  assert.deepEqual(h.sleeps, [60_000, 60_000]);
});

test('the alias switches to ours but the re-smoke fails: that is a failing deployment, so recovery runs', async () => {
  const h = harness({ smoke: [PASS, FAIL, FAIL, PASS], inspect: [OLDER, OURS, OURS, OURS, OLDER] });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.equal(h.rollbackFn.calls.length, 1);
});

test('not-live also covers a live deployment that cannot be read at all', async () => {
  const h = harness({ smoke: [PASS], inspect: [new VercelError({ args: ['inspect'], code: 1, stderr: 'login required' })] });
  const r = await h.go();
  assert.equal(r.outcome, 'not-live');
  assert.match(r.reason, /could not read the live deployment/);
});

// ---- recovery ---------------------------------------------------------------------------------------------------------

test('recovered: failing smoke on our live deployment rolls back to the known-good, re-smokes, opens a revert PR and a pipeline-rollback issue, all under the lock', async () => {
  // smoke: initial, retry, then once more after the rollback.  inspect: before, right-before-rollback, after-rollback.
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER] });
  const r = await h.go();

  assert.equal(r.outcome, 'recovered');
  assert.equal(r.ok, false);
  assert.equal(exitCodeFor(r.outcome), 1);
  assert.deepEqual(h.rollbackFn.calls, [['https://old-xyz-team.vercel.app']]);
  assert.deepEqual(r.recovery.liveBefore.id, 'dpl_ours');
  assert.deepEqual(r.recovery.liveAfter.id, 'dpl_old');
  assert.equal(r.smoke.ok, true);

  // The whole recovery path ran while the machine-wide production lock was held.
  assert.deepEqual(h.locks, ['prod-demo-app']);
  for (const step of ['rollback', 'issue', 'revert', 'pr']) assert.equal(h.held[step], true, `${step} must run under the lock`);
  assert.equal(h.log.at(-1), 'lock-');

  // Issue first (the PR links to it), then the revert PR, then a pointer from the issue to the PR.
  assert.ok(h.log.indexOf('issue') < h.log.indexOf('revert') && h.log.indexOf('revert') < h.log.indexOf('pr') && h.log.indexOf('pr') < h.log.indexOf('comment'));
  const issue = h.issueCreate.calls[0][0];
  assert.equal(issue.title, '[pipeline] production recovered after #12 (aaaaaaa)');
  assert.deepEqual(issue.labels, ['pipeline-rollback']);
  assert.deepEqual(h.revertBranch.calls[0][0], { sha: SHA, branch: 'agent/revert-12', base: 'main', dirName: 'revert-12', worktreeDir: resolve('/repo/.worktrees') });
  const pr = h.prCreate.calls[0][0];
  assert.equal(pr.title, 'Revert #12: Add widget');
  assert.equal(pr.head, 'agent/revert-12');
  assert.equal(pr.base, 'main');
  assert.deepEqual(pr.labels, ['needs-human']);
  assert.match(pr.body, /issues\/50/);
  assert.equal(r.revertPr.number, 51);
  assert.equal(r.issue.number, 50);
});

test('recovered: the issue carries the evidence a human needs', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER] });
  await h.go();
  const { body } = h.issueCreate.calls[0][0];
  assert.match(body, new RegExp(SHA));
  assert.match(body, /ours-abc-team\.vercel\.app/);
  assert.match(body, /First failing run:\n```\n\{"ok":false,"checks":\[\{"path":"\/","status":500\}\]\}/);
  assert.match(body, /Most recent run \(passed\):/, 'the post-rollback pass must not erase the failure that caused the rollback');
  assert.match(body, /Before: ours-abc-team\.vercel\.app \(id dpl_ours\)/);
  assert.match(body, /After rollback: old-xyz-team\.vercel\.app \(id dpl_old\)/);
  assert.match(body, /Known-good target\n- https:\/\/old-xyz-team\.vercel\.app \(commit bbbbbbb\)/);
  assert.match(body, /Success! old is now serving production/);
  assert.match(body, /stops auto-assigning production domains/);
  assert.match(body, /Promote a deployment to resume\./);
  assert.match(body, /Next steps/);
  assert.doesNotMatch(body, /URGENT/);
});

test('smoke fails and a NEWER healthy deployment is live: superseded, nothing rolled back (exit 1)', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [NEWER] });
  const r = await h.go();
  assert.equal(r.outcome, 'superseded');
  assert.equal(r.ok, false);
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.equal(h.revertBranch.calls.length, 0);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['needs-human']);
  assert.equal(h.issueCreate.calls[0][0].title, '[pipeline] production superseded after #12 (aaaaaaa)');
  assert.match(h.issueCreate.calls[0][0].body, /DIFFERENT deployment is now live/);
  assert.equal(exitCodeFor(r.outcome), 1);
});

test('a newer deployment that is ALSO failing does not protect ours: recovery continues and rolls back', async () => {
  const h = harness({ smoke: [FAIL, FAIL, FAIL, PASS], inspect: [NEWER, NEWER, OLDER] });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.deepEqual(h.rollbackFn.calls, [['https://old-xyz-team.vercel.app']]);
  assert.equal(h.smoke.calls.length, 4);
  assert.match(h.issueCreate.calls[0][0].body, /also fails the smoke/);
});

test('post-rollback and superseded smokes do NOT carry the new build\'s --expect-text (the old build cannot contain it)', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER] });
  const r = await h.go({ expectText: 'New heading' });
  assert.equal(r.outcome, 'recovered', 'a healthy old deployment must not read as rollback-failed');
  assert.deepEqual(h.smoke.calls.map((c) => c[0].expectText), ['New heading', 'New heading', null]);
  assert.equal(h.revertBranch.calls.length, 1);

  const s = harness({ smoke: [FAIL, FAIL, PASS], inspect: [NEWER] });
  assert.equal((await s.go({ expectText: 'New heading' })).outcome, 'superseded');
  assert.equal(s.smoke.calls[2][0].expectText, null);
});

test('not-live: the merge\'s deployment succeeded but production still serves the known-good one (no promotion after a manual rollback): nothing is rolled back', async () => {
  // Same host as the recorded known-good.
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OLDER] });
  const r = await h.go({ expectText: 'New heading' });
  assert.equal(r.outcome, 'not-live');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.equal(h.revertBranch.calls.length, 0);
  assert.match(r.reason, /known-good/);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['needs-human']);
  assert.match(h.issueCreate.calls[0][0].title, /not-live/);
  // By id, when only an id was recorded.
  const byId = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OLDER], readKnownGood: () => ({ ok: true, id: 'dpl_old', url: '', sha: null }) });
  assert.equal((await byId.go()).outcome, 'not-live');
  assert.equal(byId.rollbackFn.calls.length, 0);
});

test('changed-during-recovery: the live deployment moved between the check and the rollback, so NOTHING is rolled back', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, NEWER] });
  const r = await h.go();
  assert.equal(r.outcome, 'changed-during-recovery');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.equal(h.revertBranch.calls.length, 0);
  assert.equal(r.live.id, 'dpl_newer');
  const issue = h.issueCreate.calls[0][0];
  assert.deepEqual(issue.labels, ['pipeline-rollback']);
  assert.match(issue.body, /^\*\*URGENT/);
  assert.match(issue.body, /Seen again just before rollback: newer-def-team\.vercel\.app/);
});

test('rollback-skipped: no .review/prod-before.json means no known-good, so no rollback (urgent, pipeline-rollback)', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'no .review/prod-before.json: ...' }) });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['pipeline-rollback']);
  assert.match(h.issueCreate.calls[0][0].body, /URGENT/);
  assert.match(h.issueCreate.calls[0][0].body, /prod-before\.json/);
  assert.equal(h.revertBranch.calls.length, 0);
});

test('rollback-skipped: a known-good that IS the failing deployment is refused (rolling back to it changes nothing)', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: true, id: 'x', url: 'https://ours-abc-team.vercel.app', sha: SHA }) });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(h.rollbackFn.calls.length, 0);
});

test('rollback-skipped: if the live deployment cannot be read, ownership cannot be proven, so no rollback', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [new Error('vercel is down')] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.match(r.reason, /ownership of production cannot be proven/);
});

test('rollback-skipped: the live deployment cannot be re-read right before the rollback', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, new Error('vercel is down')] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(h.rollbackFn.calls.length, 0);
});

test('rollback-failed: the rollback command fails (urgent, pipeline-rollback, no revert PR)', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS], rollback: [{ ok: false, code: 1, tail: 'Error: deployment not found' }] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.equal(exitCodeFor(r.outcome), 1);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['pipeline-rollback']);
  assert.match(h.issueCreate.calls[0][0].body, /URGENT/);
  assert.match(h.issueCreate.calls[0][0].body, /FAILED \(exit 1\)/);
  assert.match(h.issueCreate.calls[0][0].body, /deployment not found/);
  assert.equal(h.revertBranch.calls.length, 0, 'a revert PR is only for a recovered production');
  assert.equal(h.smoke.calls.length, 2, 'no post-rollback smoke when the rollback itself failed');
});

test('rollback-failed: the rollback command throws', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS], rollback: [new Error('spawn vercel ENOENT')] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.match(h.issueCreate.calls[0][0].body, /ENOENT/);
});

test('rollback-failed: the rollback "worked" but production serves something other than the known-good', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS, NEWER] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.match(r.reason, /not the known-good deployment/);
  assert.equal(h.revertBranch.calls.length, 0);
});

test('rollback-failed: the live deployment cannot be read back after the rollback', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS, new Error('boom')] });
  assert.equal((await h.go()).outcome, 'rollback-failed');
});

test('rollback-failed: production still fails the smoke after the rollback (the smoke is retried first)', async () => {
  const h = harness({ smoke: [FAIL], inspect: [OURS, OURS, OLDER] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.equal(h.smoke.calls.length, 4); // initial + retry, then post-rollback + its retry
  assert.deepEqual(h.sleeps, [60_000, 60_000]);
  assert.match(h.issueCreate.calls[0][0].body, /stops auto-assigning/, 'the rollback did run, so the Vercel note applies');
});

test('rollback target falls back to the known-good id when no url was recorded', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER], readKnownGood: () => ({ ok: true, id: 'dpl_old', url: '', sha: null }) });
  const r = await h.go();
  assert.deepEqual(h.rollbackFn.calls, [['dpl_old']]);
  assert.equal(r.outcome, 'recovered');
});

test('the revert PR failing does not change the outcome: the issue is told to revert by hand', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER], revertBranch: [new Error('CONFLICT (content): Merge conflict in app.txt')] });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.revertPr, null);
  assert.match(r.revertPrError, /CONFLICT/);
  assert.equal(h.prCreate.calls.length, 0);
  assert.match(h.issueComment.calls[0][1], /could NOT be created automatically/);
  // the owner's push says to revert by hand and names the issue that exists
  const push = prodEvent(r, { pr: 12 });
  assert.equal(push.event, 'prod-recovered');
  assert.equal(push.action, 'Rolled back, prod healthy. Revert PR could not be opened — revert #12 by hand or fix forward; close issue #50 after.');
});

test('recovered with the rollback issue missing: the push says it could not be confirmed, never that merges are not paused', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER], issueCreate: [new Error('HTTP 502')] });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.issue, null);
  const push = prodEvent(r, { pr: 12 });
  assert.match(push.action, /Rollback issue could not be confirmed — check whether merges are paused\./);
  assert.ok(!/not paused|NOT paused/i.test(push.action));
});

test('recovered with both artifacts: the push names the revert PR and the issue to close', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER] });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.equal(prodEvent(r, { pr: 12 }).action, `Rolled back, prod healthy. Review revert PR #${r.revertPr.number}; close issue #50 to unpause merges.`);
});

test('a failing issue API does not hide the outcome', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }), issueCreate: [new Error('HTTP 502')] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(r.issue, null);
  assert.match(r.issueError, /502/);
  assert.match(prodEvent(r, { pr: 12 }).action, /Rollback issue could not be confirmed — check whether merges are paused\./);
  assert.equal(prodEvent(r, { pr: 12 }).priority, 5);
});

test('an unexpected error during recovery still ends in an urgent issue, never a crash', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => { throw new Error('disk on fire'); } });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.match(h.issueCreate.calls[0][0].body, /disk on fire/);
});

test('the recovery lock: a lock that cannot be taken means no rollback and an urgent issue', async () => {
  const err = Object.assign(new Error('lock "prod-demo-app" is held by pid 1'), { name: 'LockTimeoutError' });
  const h = harness({ smoke: [FAIL, FAIL], lock: async () => { throw err; } });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['pipeline-rollback']);
});

test('the recovery lock: losing it after the work is done is reported as a warning, not a lost outcome', async () => {
  const lost = Object.assign(new Error('lock was taken over'), { name: 'LockLostError' });
  const h = harness({
    smoke: [FAIL, FAIL, PASS],
    inspect: [OURS, OURS, OLDER],
    lock: async (name, fn) => { await fn(); throw lost; },
  });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.deepEqual(r.warnings, ['lock was taken over']);
});

test('the lock is named after the project, sanitised for the lock directory', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }) });
  await h.go();
  assert.deepEqual(h.locks, ['prod-demo-app']);
});

test('provider "other": a passing smoke is merged without asking Vercel; a failing one is never rolled back automatically', async () => {
  const cfg = config();
  cfg.production.provider = 'other';
  const ok = harness({ config: cfg, smoke: [PASS] });
  assert.equal((await ok.go()).outcome, 'merged');
  assert.equal(ok.inspect.calls.length, 0);

  const bad = harness({ config: cfg, smoke: [FAIL, FAIL] });
  const r = await bad.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(bad.rollbackFn.calls.length, 0);
  assert.match(r.reason, /vercel rollback \{deployment\} --yes/);
});

test('a smoke that throws counts as a failed smoke, with the reason in the evidence', async () => {
  const h = harness({ smoke: [new Error('fill: no value for {url}')], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }) });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.match(r.smoke.tail, /smoke could not run/);
});

test('no --pr: titles and branches use the short sha', async () => {
  const h = harness({ smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER] });
  await h.go({ pr: null });
  assert.equal(h.issueCreate.calls[0][0].title, '[pipeline] production recovered after (aaaaaaa)');
  assert.equal(h.revertBranch.calls[0][0].branch, 'agent/revert-aaaaaaa');
  assert.equal(h.prCreate.calls[0][0].title, 'Revert aaaaaaa: Add widget (#12)');
});

test('exit codes: only merged is 0; a deployment never observed is 3; every other outcome is 1', () => {
  assert.equal(exitCodeFor('merged'), 0);
  assert.equal(exitCodeFor('deploy-not-observed'), 3);
  for (const o of ['deploy-failed', 'not-live', 'superseded', 'recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped']) {
    assert.equal(exitCodeFor(o), 1, o);
  }
});

test('issueTitle', () => {
  assert.equal(issueTitle('recovered', { pr: 7, sha: 'abcdef0123' }), '[pipeline] production recovered after #7 (abcdef0)');
});

test('hostOf normalises scheme, case and path', () => {
  assert.equal(hostOf('https://App.Example.com/x?y=1'), 'app.example.com');
  assert.equal(hostOf('ours-abc-team.vercel.app'), 'ours-abc-team.vercel.app');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(null), '');
});

// ---- the known-good record ---------------------------------------------------------------------------------------------

test('readKnownGood: reads {id, sha, url}; a missing, unparseable or unusable record is a clear refusal', () => {
  const root = tmp();
  const write = (v) => {
    mkdirSync(join(root, '.review'), { recursive: true });
    writeFileSync(join(root, '.review', 'prod-before.json'), typeof v === 'string' ? v : JSON.stringify(v));
  };
  assert.match(readKnownGood(root).reason, /prod-before\.json/);
  write({ id: 'dpl_1', sha: OLD_SHA, url: 'https://old.vercel.app' });
  assert.deepEqual(readKnownGood(root), { ok: true, id: 'dpl_1', url: 'https://old.vercel.app', sha: OLD_SHA });
  write({ id: 42 });
  assert.deepEqual(readKnownGood(root), { ok: true, id: '42', url: '', sha: null });
  write({ sha: OLD_SHA });
  assert.match(readKnownGood(root).reason, /neither a url nor an id/);
  write({ url: '--scope=evil' });
  assert.match(readKnownGood(root).reason, /unusable rollback target/);
  write('{not json');
  assert.match(readKnownGood(root).reason, /cannot read/);
});

// ---- the smoke command -----------------------------------------------------------------------------------------------

test('createSmoke fills {url} strictly, passes expect-text through the environment, and reports the output tail', async () => {
  const seen = [];
  const smoke = createSmoke({
    production: { smoke: 'node smoke.mjs --base {url} --production' },
    cwd: '/repo',
    env: { A: '1' },
    runShell: async (command, opts) => { seen.push({ command, opts }); return { code: 1, stdout: 'x'.repeat(10), stderr: 'bad', timedOut: false }; },
  });
  const r = await smoke({ url: 'https://app.example.com', expectText: 'Hello' });
  assert.equal(seen[0].command, 'node smoke.mjs --base https://app.example.com --production');
  assert.equal(seen[0].opts.env.PIPELINE_SMOKE_EXPECT_TEXT, 'Hello');
  assert.equal(seen[0].opts.env.A, '1');
  assert.deepEqual([r.ok, r.code], [false, 1]);
  assert.match(r.tail, /bad/);
  await smoke({ url: 'https://app.example.com', expectText: null });
  assert.equal(seen[1].opts.env.PIPELINE_SMOKE_EXPECT_TEXT, '', 'an expect-text in the caller\'s own env must not leak in');
  const timedOut = createSmoke({ production: { smoke: 'x {url}' }, runShell: async () => ({ code: 0, stdout: '', stderr: '', timedOut: true }) });
  assert.equal((await timedOut({ url: 'https://a.b' })).ok, false, 'a timeout is never a pass');
  await assert.rejects(createSmoke({ production: { smoke: 'x {url} {sha}' }, runShell: async () => ({}) })({ url: 'https://a.b' }), /no value for \{sha\}/);
});

// ---- the real git revert ----------------------------------------------------------------------------------------------

function repoWithOrigin() {
  const repo = createTmpRepo();
  const bare = tmp('cp-origin-');
  const g = (args, cwd) => {
    const r = procRun('git', args, { cwd, env: { GIT_DIR: undefined } });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  g(['init', '--bare', '-q', '-b', 'main', bare], repo.dir);
  repo.write('.gitignore', '.worktrees\n.review\n');
  repo.write('app.txt', 'v1\n');
  repo.commit('init');
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', '-u', 'origin', 'main']);
  return { repo, bare, g };
}

test('createGitOps: reverts a squash merge in a temp worktree, pushes agent/revert-N, and leaves the caller\'s checkout alone', async () => {
  const { repo, bare } = repoWithOrigin();
  repo.write('app.txt', 'v2\n');
  const merge = repo.commit('Add widget (#12)');
  repo.git(['push', '-q', 'origin', 'main']);
  const headBefore = repo.git(['rev-parse', 'HEAD']).trim();

  const ops = createGitOps({ root: repo.dir });
  const r = await ops.revertBranch({ sha: merge, branch: 'agent/revert-12', base: 'main', dirName: 'revert-12', worktreeDir: join(repo.dir, '.worktrees') });
  assert.deepEqual(r, { branch: 'agent/revert-12', subject: 'Add widget (#12)' });

  const onOrigin = repo.git(['--git-dir', bare, 'show', 'agent/revert-12:app.txt']);
  assert.equal(onOrigin, 'v1\n');
  assert.match(repo.git(['--git-dir', bare, 'log', '-1', '--format=%s', 'agent/revert-12']), /^Revert "Add widget \(#12\)"/);
  assert.equal(repo.git(['--git-dir', bare, 'rev-parse', 'main']).trim(), merge, 'main on origin is untouched');
  assert.equal(repo.git(['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(repo.git(['status', '--porcelain']), '');
  assert.equal(repo.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1, 'the temp worktree is gone');
  assert.equal(existsSync(join(repo.dir, '.worktrees', 'revert-12')), false);
  assert.equal(repo.git(['config', '--get', 'branch.agent/revert-12.merge']).trim(), 'refs/heads/agent/revert-12', 'pushed with -u');
});

test('createGitOps: fetch and push (which run inside the production lock) carry a timeout', async () => {
  const { repo } = repoWithOrigin();
  repo.write('app.txt', 'v2\n');
  const merge = repo.commit('Add widget (#12)');
  repo.git(['push', '-q', 'origin', 'main']);
  const seen = [];
  const ops = createGitOps({ root: repo.dir, gitFn: (args, o) => { seen.push({ args, timeoutMs: o.timeoutMs }); return gitRunReal(args, o); } });
  await ops.revertBranch({ sha: merge, branch: 'agent/revert-12', base: 'main', dirName: 'revert-12', worktreeDir: join(repo.dir, '.worktrees') });
  for (const verb of ['fetch', 'push']) {
    const c = seen.find((x) => x.args[0] === verb);
    assert.ok(c?.timeoutMs > 0, `${verb} needs a timeout`);
  }
});

test('createGitOps: a true merge commit is reverted with -m 1 (keeping the first-parent side)', async () => {
  const { repo, bare } = repoWithOrigin();
  repo.branch('feature');
  repo.write('feature.txt', 'f\n');
  repo.commit('feature work');
  repo.checkout('main');
  repo.write('other.txt', 'o\n');
  repo.commit('main moves on');
  repo.git(['merge', '--no-ff', '-q', '-m', 'Merge feature (#9)', 'feature']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();
  repo.git(['push', '-q', 'origin', 'main']);

  const ops = createGitOps({ root: repo.dir });
  await ops.revertBranch({ sha: merge, branch: 'agent/revert-9', base: 'main', dirName: 'revert-9', worktreeDir: join(repo.dir, '.worktrees') });
  const files = repo.git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'agent/revert-9']).split('\n').filter(Boolean);
  assert.ok(!files.includes('feature.txt'));
  assert.ok(files.includes('other.txt'), 'the main-side change survives');
});

test('createGitOps: a revert that conflicts is aborted, nothing is pushed, and the temp worktree is removed', async () => {
  const { repo, bare } = repoWithOrigin();
  repo.write('app.txt', 'v2\n');
  const merge = repo.commit('Add widget (#12)');
  repo.write('app.txt', 'v3\n');
  repo.commit('Later change to the same line');
  repo.git(['push', '-q', 'origin', 'main']);

  const ops = createGitOps({ root: repo.dir });
  await assert.rejects(
    ops.revertBranch({ sha: merge, branch: 'agent/revert-12', base: 'main', dirName: 'revert-12', worktreeDir: join(repo.dir, '.worktrees') }),
    GitError,
  );
  assert.equal(repo.git(['--git-dir', bare, 'branch', '--list', 'agent/revert-12']).trim(), '');
  assert.equal(repo.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
});

test('createGitOps refuses to push anywhere but a fresh agent/revert-* branch', async () => {
  const ops = createGitOps({ root: '/nowhere', gitFn: () => { throw new Error('git must not run'); } });
  for (const branch of ['main', 'agent/other', 'agent/revert-', '--force', 'agent/revert-x y']) {
    await assert.rejects(ops.revertBranch({ sha: SHA, branch, base: 'main', dirName: 'x', worktreeDir: '/w' }), /refusing to push revert/, branch);
  }
});

// ---- the Vercel wrapper --------------------------------------------------------------------------------------------------

function fakeVercel(state) {
  const dir = tmp('cp-fakevercel-');
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'log.jsonl');
  writeFileSync(stateFile, JSON.stringify(state));
  return {
    env: { PIPELINE_VERCEL: `node "${fakeVercelPath}"`, PIPELINE_FAKE_VERCEL_STATE: stateFile, PIPELINE_FAKE_VERCEL_LOG: logFile },
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    calls: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv) : []),
  };
}

test('vercelCommand: PIPELINE_VERCEL overrides, otherwise plain `vercel`', () => {
  assert.deepEqual(vercelCommand({ PIPELINE_VERCEL: '' }), { cmd: 'vercel', prefixArgs: [] });
  assert.deepEqual(vercelCommand({ PIPELINE_VERCEL: 'node "/a b/fake.mjs" --x' }), { cmd: 'node', prefixArgs: ['/a b/fake.mjs', '--x'] });
});

test('inspectAlias: parses the deployment the domain serves (scheme stripped, createdAt as epoch ms)', () => {
  const v = fakeVercel({ alias: { id: 'dpl_1', url: 'https://app-abc-team.vercel.app', target: 'production', readyState: 'READY', createdAt: '2026-10-01T10:00:00Z' } });
  const r = inspectAlias('app.example.com', { cwd: tmpdir(), env: v.env });
  assert.deepEqual(r, { id: 'dpl_1', url: 'app-abc-team.vercel.app', readyState: 'READY', createdAt: T, target: 'production' });
  assert.deepEqual(v.calls(), [['inspect', 'app.example.com', '--format', 'json']]);
});

test('inspectAlias: a numeric createdAt, and a banner around the JSON, are tolerated', () => {
  const alias = { id: 'dpl_2', url: 'x.vercel.app', readyState: 'READY', createdAt: 1790000000000 };
  const v = fakeVercel({ alias, inspectStdout: `Vercel CLI 54.2.0\n${JSON.stringify(alias)}\n` });
  assert.equal(inspectAlias('app.example.com', { env: v.env }).createdAt, 1790000000000);
});

test('inspectAlias throws (never guesses) on a failing CLI, an unusable answer, or an unsafe domain', () => {
  assert.throws(() => inspectAlias('app.example.com', { env: fakeVercel({ inspectCode: 1 }).env }), VercelError);
  assert.throws(() => inspectAlias('app.example.com', { env: fakeVercel({ inspectStdout: 'not json' }).env }), /no deployment id\/url/);
  assert.throws(() => inspectAlias('app.example.com', { env: fakeVercel({ inspectStdout: '{"id":"dpl_1"}' }).env }), /no deployment id\/url/);
  assert.throws(() => inspectAlias('--token=x', { env: fakeVercel({}).env }), /unsafe domain/);
  assert.throws(() => inspectAlias('a b', { env: fakeVercel({}).env }), /unsafe domain/);
});

test('rollback: runs `vercel rollback <target> --yes --timeout 3m` and reports ok/code/tail', () => {
  const old = { id: 'dpl_old', url: 'old-xyz-team.vercel.app' };
  const v = fakeVercel({ alias: { id: 'dpl_new', url: 'new.vercel.app' }, deployments: [old] });
  const r = rollback('https://old-xyz-team.vercel.app', { env: v.env });
  assert.equal(r.ok, true);
  assert.match(r.tail, /old-xyz-team\.vercel\.app is now serving production/);
  assert.deepEqual(v.calls(), [['rollback', 'https://old-xyz-team.vercel.app', '--yes', '--timeout', '3m']]);
  assert.equal(v.state().alias.id, 'dpl_old');
});

test('rollback: a failing CLI is ok:false with its output, never a throw; an unsafe target is refused', () => {
  const v = fakeVercel({ alias: { id: 'dpl_new', url: 'new.vercel.app' }, deployments: [], rollbackCode: 1, rollbackStdout: 'Error: nope' });
  const r = rollback('dpl_old', { env: v.env });
  assert.deepEqual([r.ok, r.code], [false, 1]);
  assert.match(r.tail, /Error: nope/);
  assert.throws(() => rollback('--yes', { env: v.env }), /unsafe rollback target/);
});

test('tail keeps the end of long output', () => {
  assert.equal(tail('a'.repeat(10) + 'END', 3), '...END');
  assert.equal(tail('  short  '), 'short');
  assert.equal(tail(undefined), '');
});

test('linkedProjectDir: the checkout itself when linked; else the main checkout the worktree belongs to', () => {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a');
  repo.commit('init');
  const wt = join(tmp('cp-wt-'), 'agent');
  repo.git(['worktree', 'add', '-q', '--detach', wt]);
  assert.equal(linkedProjectDir(wt), wt, 'nothing is linked anywhere: the CLI gets to explain');
  mkdirSync(join(repo.dir, '.vercel'));
  writeFileSync(join(repo.dir, '.vercel', 'project.json'), '{}');
  assert.equal(linkedProjectDir(wt), repo.dir);
  assert.equal(linkedProjectDir(repo.dir), repo.dir);
  mkdirSync(join(wt, '.vercel'));
  writeFileSync(join(wt, '.vercel', 'project.json'), '{}');
  assert.equal(linkedProjectDir(wt), wt);
});

// ---- run events, the run record and --observe-only ----------------------------------------------------------------------

const RECOVER = { smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OLDER] };
// With a PR the watch re-reads production once more AFTER recording the rollback intent (before, again, after-intent, read-back).
const RECOVER_EV = { smoke: [FAIL, FAIL, PASS], inspect: [OURS, OURS, OURS, OLDER] };

// A one-PR stand-in for the bits of createGitHub() the summary comment and the run-record tracker use.
function fakeSummaryGh(initial) {
  let comment = typeof initial === 'string' ? { id: 1, user: { login: 'bot' }, body: initial } : null;
  let writes = 0;
  return {
    viewer: () => 'bot',
    repo: () => ({ slug: 'acme/widgets' }),
    prView: () => ({ headRefName: 'agent/x', baseRefName: 'main' }),
    listComments: () => (comment ? [comment] : []),
    upsertComment: (n, marker, body) => {
      assert.ok(body.startsWith(marker));
      writes += 1;
      comment = { id: comment?.id ?? 1, user: { login: 'bot' }, body };
      return { id: comment.id, url: 'https://github.com/acme/widgets/pull/12#issuecomment-1', action: 'updated' };
    },
    body: () => comment?.body,
    writes: () => writes,
  };
}

let commentId = 100;
// A viewer-authored event as `listEvents` returns it.
const eventOf = (kind, id, data) => listEvents([{ id: (commentId += 1), user: { login: 'bot' }, html_url: `https://github.com/acme/widgets/pull/12#issuecomment-${commentId}`, body: renderEvent(kind, id, `${kind} sentence`, data) }], 'bot')[0];
const PROD_BEFORE = eventOf('prod-before', '12-1', { environment: 'Production', pr: 12, deployment: { id: 'dpl_old', sha: OLD_SHA, url: 'https://old-xyz-team.vercel.app' } });

test('events: rollback-intent is posted BEFORE the rollback, rollback-result AFTER it and its check, recovery-reported after the issue and revert PR', async () => {
  const h = harness({ ...RECOVER_EV, events: true });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.deepEqual(h.posted.map((e) => e.kind), ['rollback-intent', 'rollback-result', 'recovery-reported']);
  const at = (name) => h.log.indexOf(name);
  assert.ok(at('event:rollback-intent') < at('rollback'), 'intent first');
  assert.ok(at('rollback') < at('event:rollback-result'), 'result after the rollback');
  assert.ok(at('smoke') < at('event:rollback-intent') && at('inspect') < at('event:rollback-intent'), 'intent comes after the last look at production');
  assert.equal(h.log.filter((x) => x === 'smoke').length, 3, 'the post-rollback smoke ran before the result was written');
  assert.ok(h.log.lastIndexOf('smoke') < at('event:rollback-result'));
  assert.ok(at('pr') < at('event:recovery-reported') && at('issue') < at('event:recovery-reported'));
  for (const name of ['event:rollback-intent', 'event:rollback-result', 'event:recovery-reported']) assert.equal(h.held[name], true, `${name} is written under the lock`);

  assert.deepEqual(h.posted.map((e) => e.id), ['aaaaaaa-1', 'aaaaaaa-1', 'aaaaaaa-1']);
  const [intent, result, reported] = h.posted.map((e) => e.data);
  assert.equal(intent.mergeSha, SHA);
  assert.deepEqual(intent.failingDeployment, { id: 11, url: 'https://ours-abc-team.vercel.app' });
  assert.deepEqual(intent.target, { id: 'dpl_old', sha: OLD_SHA, url: 'https://old-xyz-team.vercel.app' });
  assert.deepEqual(result, { mergeSha: SHA, ok: true, liveAfter: { id: 'dpl_old', url: 'old-xyz-team.vercel.app' }, verified: true });
  assert.deepEqual(reported, { mergeSha: SHA, issueUrl: 'https://github.com/acme/widgets/issues/50', revertPrUrl: 'https://github.com/acme/widgets/pull/51' });
  // Each is a valid event: render accepts the id and kind.
  for (const e of h.posted) assert.ok(parseEvent(renderEvent(e.kind, e.id, e.sentence, e.data)));
});

test('events: production changing WHILE the intent is being recorded aborts the rollback and closes the intent with an aborted result', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS, NEWER], events: true });
  const r = await h.go();
  assert.equal(r.outcome, 'changed-during-recovery');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.ok(!h.log.includes('rollback'));
  assert.equal(r.live.id, 'dpl_newer');
  assert.deepEqual(h.posted.map((e) => e.kind), ['rollback-intent', 'rollback-result']);
  assert.deepEqual(h.posted[1].data, { mergeSha: SHA, ok: false, aborted: true, liveAfter: { id: 'dpl_newer', url: 'newer-def-team.vercel.app' }, verified: false });
  assert.equal(h.posted[1].id, h.posted[0].id, 'the result closes the same attempt');
  assert.ok(h.log.lastIndexOf('inspect') > h.log.indexOf('event:rollback-intent'), 'production was read again after the intent was posted');
  for (const e of h.posted) assert.ok(parseEvent(renderEvent(e.kind, e.id, e.sentence, e.data)));
});

test('events: an unreadable live deployment after the intent also aborts (nothing rolled back, intent closed)', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS, new Error('vercel inspect: 500')], events: true });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.match(r.reason, /after recording the rollback intent.*500/);
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.deepEqual(h.posted.map((e) => e.kind), ['rollback-intent', 'rollback-result']);
  assert.equal(h.posted[1].data.aborted, true);
  assert.equal(h.posted[1].data.liveAfter, null);
});

test('events: no events dep (no PR known) rolls back exactly as before', async () => {
  const h = harness(RECOVER);
  assert.equal((await h.go()).outcome, 'recovered');
  assert.equal(h.rollbackFn.calls.length, 1);
});

test('events: the event number counts the rollback-intents already on the PR for this merge', async () => {
  const prior = eventOf('rollback-intent', 'aaaaaaa-1', { mergeSha: SHA });
  const otherMerge = eventOf('rollback-intent', 'ccccccc-1', { mergeSha: 'c'.repeat(40) });
  const h = harness({ ...RECOVER_EV, events: true, eventList: [prior, otherMerge] });
  await h.go();
  assert.deepEqual(h.posted.map((e) => e.id), ['aaaaaaa-2', 'aaaaaaa-2', 'aaaaaaa-2']);
});

test('events: if the rollback-intent cannot be recorded NOTHING is rolled back (rollback-skipped, urgent issue, no later events)', async () => {
  const h = harness({ ...RECOVER_EV, events: true, postFail: ['rollback-intent'] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(r.reason, 'could not record the rollback intent on the PR');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.ok(!h.log.includes('rollback'));
  assert.deepEqual(h.posted, []);
  assert.ok(!h.log.includes('event:rollback-result') && !h.log.includes('event:recovery-reported'));
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['pipeline-rollback']);
  assert.ok(!h.log.includes('revert'));
});

test('events: if the existing rollback attempts cannot be read NOTHING is rolled back (an id could be reused): rollback-skipped, nothing posted', async () => {
  const h = harness({ ...RECOVER_EV, events: true, eventListError: true });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(r.reason, 'could not read existing rollback attempts on the PR');
  assert.equal(h.rollbackFn.calls.length, 0);
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.issueCreate.calls[0][0].labels, ['pipeline-rollback']);
});

test('events: failing to post rollback-result or recovery-reported is a warning, never a different outcome', async () => {
  const h = harness({ ...RECOVER_EV, events: true, postFail: ['rollback-result', 'recovery-reported'] });
  const r = await h.go();
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /rollback-result event.*502/);
  assert.match(r.warnings[1], /recovery-reported event.*502/);
});

test('events: a rollback that fails is recorded as ok:false verified:false (and the incident is still reported)', async () => {
  const h = harness({ ...RECOVER_EV, events: true, rollback: [{ ok: false, code: 1, tail: 'boom' }] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.deepEqual(h.posted.map((e) => e.kind), ['rollback-intent', 'rollback-result', 'recovery-reported']);
  assert.deepEqual(h.posted[1].data, { mergeSha: SHA, ok: false, liveAfter: null, verified: false });
});

test('events: a rollback that ran but production still fails the smoke is ok:true verified:false', async () => {
  const h = harness({ smoke: [FAIL, FAIL, FAIL, FAIL], inspect: [OURS, OURS, OURS, OLDER], events: true });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.deepEqual(h.posted[1].data, { mergeSha: SHA, ok: true, liveAfter: { id: 'dpl_old', url: 'old-xyz-team.vercel.app' }, verified: false });
});

test('events: an unexpected error AFTER the rollback ran still writes a rollback-result (never an intent left open)', async () => {
  // the pause before the post-rollback smoke retry is the 2nd sleep; it blows up
  const h = harness({
    smoke: [FAIL, FAIL, FAIL], inspect: [OURS, OURS, OURS, OLDER], events: true,
    sleep: (ms, n) => { if (n === 2) throw new Error('clock exploded'); },
  });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.match(r.reason, /clock exploded/);
  assert.equal(h.rollbackFn.calls.length, 1);
  assert.deepEqual(h.posted.map((e) => e.kind), ['rollback-intent', 'rollback-result', 'recovery-reported']);
  assert.equal(h.posted[1].data.ok, true);
  assert.equal(h.posted[1].data.verified, false);
});

test('events: a result that cannot even be built is a warning, not a crash', async () => {
  const exploding = { id: 'dpl_old', get url() { throw new Error('inspect reply was not an object'); } };
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS, OURS, OURS, exploding], events: true });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-failed');
  assert.ok(r.warnings.some((w) => /rollback-result event/.test(w)));
});

test('events: nothing is posted when there is nothing to roll back (merged, deploy-failed, superseded, changed-during-recovery, no known-good)', async () => {
  const cases = [
    harness({ smoke: [PASS], inspect: [OURS], events: true }),
    harness({ findDeployment: [{ state: 'failure', id: 9, url: 'https://x.vercel.app' }], events: true }),
    harness({ smoke: [FAIL, FAIL, PASS], inspect: [NEWER], events: true }),
    harness({ smoke: [FAIL, FAIL], inspect: [OURS, NEWER], events: true }),
    harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }), events: true }),
  ];
  for (const h of cases) {
    await h.go();
    assert.deepEqual(h.posted, []);
  }
});

// ---- inFlight in the run record

test('record: inFlight is set before the first look and cleared after the last, on every outcome', async () => {
  const outcomes = [
    [harness({ smoke: [PASS], inspect: [OURS], record: true }), 'merged'],
    [harness({ findDeployment: [{ state: 'failure', id: 9 }], record: true }), 'deploy-failed'],
    [harness({ findDeployment: [{ state: 'timeout' }], record: true }), 'deploy-not-observed'],
    [harness({ ...RECOVER, record: true }), 'recovered'],
    [harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }), record: true }), 'rollback-skipped'],
  ];
  for (const [h, expected] of outcomes) {
    const r = await h.go({ host: 'pc-1' });
    assert.equal(r.outcome, expected);
    assert.equal(h.log[0], 'record:set', expected);
    assert.equal(h.log.at(-1), 'record:clear', expected);
    assert.deepEqual(h.recordCalls[0], ['set', { kind: 'prod-watch', host: 'pc-1', startedAt: new Date(T + 5000).toISOString(), maxMinutes: 50 }]);
    assert.deepEqual(h.recordCalls[1], ['clear']);
    assert.equal(h.recordCalls.length, 2);
  }
});

test('record: observe-only records its own outcome (after clearing inFlight); a normal run never does; deploy-not-observed stays open', async () => {
  const observed = harness({ ...RECOVER, record: true });
  const r = await observed.go({ observeOnly: true, host: 'pc-1' });
  assert.equal(r.outcome, 'needs-owner');
  assert.deepEqual(observed.log.filter((x) => x.startsWith('record:')), ['record:set', 'record:clear', 'record:finish']);
  assert.deepEqual(observed.recordCalls.at(-1), ['finish', 'needs-owner', r.reason]);

  const healthy = harness({ smoke: [PASS], inspect: [OURS], record: true });
  assert.equal((await healthy.go({ observeOnly: true })).outcome, 'merged');
  assert.deepEqual(healthy.recordCalls.at(-1), ['finish', 'merged', '']);

  const normal = harness({ smoke: [PASS], inspect: [OURS], record: true });
  await normal.go();
  assert.ok(!normal.log.includes('record:finish'), 'a normal run is recorded by `P summary`, not by prod-watch');

  const unseen = harness({ findDeployment: [{ state: 'timeout' }], record: true });
  assert.equal((await unseen.go({ observeOnly: true })).outcome, 'deploy-not-observed');
  assert.ok(!unseen.log.includes('record:finish'));

  const failing = harness({ smoke: [PASS], inspect: [OURS], record: true, recordFail: 'finish' });
  const out = await failing.go({ observeOnly: true });
  assert.equal(out.outcome, 'merged');
  assert.match(out.warnings[0], /record the observed outcome.*503/);
});

test('createRunRecordTracker.finish: ends a stranded record with the outcome, keeps the sections, never overwrites an existing outcome, and resume then routes ended', () => {
  const gh = fakeSummaryGh();
  writeSummaryComment(gh, 12, { record: { ...emptyRecord({ repo: 'acme/widgets', pr: 12, branch: 'agent/x', baseRef: 'main' }), step: 'prod-watch' }, sections: '## Summary\nDid the thing.' });
  const tracker = createRunRecordTracker({ gh, pr: 12, host: 'pc-1', now: () => T });
  tracker.set({ kind: 'prod-watch', host: 'pc-1', startedAt: 'now', maxMinutes: 50 });
  tracker.clear();
  assert.equal(tracker.finish('needs-owner', 'smoke fails'), true);
  const rec = decodeRecord(gh.body()).record;
  assert.deepEqual([rec.step, rec.outcome, rec.inFlight, rec.detail], ['ended', 'needs-owner', null, 'smoke fails']);
  assert.match(gh.body(), /Did the thing\./);
  const facts = { state: 'MERGED', isCrossRepository: false, labels: [], liveHead: 'a'.repeat(40), autoMergeArmed: false, host: 'pc-1', recordStatus: 'ok', record: rec, triage: null, contentHash: null, needsHumanReason: null, events: [], local: null };
  assert.equal(planResume(facts, { now: T }).enter, 'ended');
  // a second observation does not rewrite what is already recorded
  const before = gh.body();
  assert.equal(tracker.finish('merged'), false);
  assert.equal(gh.body(), before);
});

test('createRunRecordTracker.finish: a prod-unknown record (the original watch never learned the result) is finished by the observation', () => {
  const gh = fakeSummaryGh();
  writeSummaryComment(gh, 12, { record: { ...emptyRecord({ repo: 'acme/widgets', pr: 12, branch: 'agent/x', baseRef: 'main' }), step: 'prod-watch', outcome: 'prod-unknown' }, sections: '## Summary' });
  const tracker = createRunRecordTracker({ gh, pr: 12, host: 'pc-1', now: () => T });
  assert.equal(tracker.finish('merged'), true);
  const rec = decodeRecord(gh.body()).record;
  assert.deepEqual([rec.step, rec.outcome], ['ended', 'merged']);
});

test('record: inFlight is cleared even when the watch throws', async () => {
  const h = harness({ findDeployment: [new Error('github exploded')], record: true });
  await assert.rejects(h.go(), /github exploded/);
  assert.deepEqual(h.log.filter((x) => x.startsWith('record:')), ['record:set', 'record:clear']);
  const lockLost = Object.assign(new Error('boom'), { name: 'SomethingElse' });
  const h2 = harness({ smoke: [FAIL, FAIL], record: true, lock: async () => { throw lockLost; } });
  await assert.rejects(h2.go(), /boom/);
  assert.equal(h2.log.at(-1), 'record:clear');
});

test('record: a record that cannot be written is a warning in the JSON and never fails the watch', async () => {
  for (const which of ['set', 'clear']) {
    const h = harness({ smoke: [PASS], inspect: [OURS], record: true, recordFail: which });
    const r = await h.go();
    assert.equal(r.outcome, 'merged');
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^run record: could not /);
    assert.equal(h.log.at(-1), 'record:clear', 'clear is attempted even after set failed');
  }
});

// ---- --observe-only

// Every external effect that is not a read must stay at zero in observe-only.
function assertReadOnly(h, r) {
  assert.equal(h.rollbackFn.calls.length, 0, 'rollback');
  assert.equal(h.issueCreate.calls.length, 0, 'issue');
  assert.equal(h.prCreate.calls.length, 0, 'revert PR');
  assert.equal(h.revertBranch.calls.length, 0, 'revert branch');
  assert.equal(h.issueComment.calls.length, 0, 'issue comment');
  assert.deepEqual(h.posted, [], 'events');
  assert.deepEqual(h.locks, [], 'observe-only needs no recovery lock');
  assert.equal(r.issue, null);
  assert.equal(r.revertPr, null);
  assert.equal(r.observeOnly, true);
}

test('observe-only: a failing smoke on our live deployment is needs-owner with the evidence, and NOTHING is changed', async () => {
  const h = harness({ ...RECOVER_EV, events: true });
  const r = await h.go({ observeOnly: true });
  assert.equal(r.outcome, 'needs-owner');
  assert.equal(r.ok, false);
  assert.equal(exitCodeFor(r.outcome), 1);
  assertReadOnly(h, r);
  assert.equal(r.evidence.underlying, null);
  assert.equal(r.evidence.liveDeployment.id, 'dpl_ours');
  assert.equal(r.evidence.failingDeployment.url, 'https://ours-abc-team.vercel.app');
  assert.deepEqual(r.evidence.knownGood, { id: 'dpl_old', sha: OLD_SHA, url: 'https://old-xyz-team.vercel.app' });
  assert.match(r.evidence.smokeFailure.tail, /500/);
  assert.match(r.reason, /would be rolled back to https:\/\/old-xyz-team\.vercel\.app/);
});

test('observe-only: every outcome that wanted a rollback or an urgent issue becomes needs-owner, none of them writes anything', async () => {
  const cfgOther = config();
  cfgOther.production.provider = 'other';
  const cases = {
    'rollback-skipped (no known-good)': harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }), events: true }),
    'rollback-skipped (known-good is the failing deployment)': harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: true, id: 'x', url: 'https://ours-abc-team.vercel.app', sha: null }), events: true }),
    'rollback-skipped (live deployment unreadable)': harness({ smoke: [FAIL, FAIL], inspect: [new Error('vercel down')], events: true }),
    'rollback-skipped (unexpected error)': harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => { throw new Error('disk on fire'); }, events: true }),
    'rollback-skipped (provider other)': harness({ config: cfgOther, smoke: [FAIL, FAIL], events: true }),
    'changed-during-recovery': harness({ smoke: [FAIL, FAIL], inspect: [OURS, NEWER], events: true }),
    'a different failing deployment is live': harness({ smoke: [FAIL, FAIL, FAIL], inspect: [NEWER, NEWER], events: true }),
    'lock unavailable': harness({ smoke: [FAIL, FAIL], inspect: [OURS], events: true, lock: async () => { throw Object.assign(new Error('held'), { name: 'LockTimeoutError' }); } }),
  };
  for (const [name, h] of Object.entries(cases)) {
    const r = await h.go({ observeOnly: true });
    assert.equal(r.outcome, 'needs-owner', name);
    assertReadOnly(h, r);
    assert.ok(r.reason, name);
    // the outcome a normal watch would have ended with is kept for the reader
    if (name === 'changed-during-recovery') assert.equal(r.evidence.underlying, 'changed-during-recovery');
    if (name.startsWith('rollback-skipped')) assert.equal(r.evidence.underlying, 'rollback-skipped', name);
  }
});

test('observe-only: outcomes that never asked for an issue-and-rollback keep their name, and still open nothing', async () => {
  const cases = {
    merged: harness({ smoke: [PASS], inspect: [OURS], events: true }),
    'deploy-failed': harness({ findDeployment: [{ state: 'failure', id: 9, url: 'https://x.vercel.app' }], events: true }),
    'deploy-not-observed': harness({ findDeployment: [{ state: 'timeout' }], events: true }),
    'not-live': harness({ smoke: [PASS], inspect: [OLDER], events: true }),
    superseded: harness({ smoke: [FAIL, FAIL, PASS], inspect: [NEWER], events: true }),
  };
  for (const [name, h] of Object.entries(cases)) {
    const r = await h.go({ observeOnly: true });
    assert.equal(r.outcome, name);
    assertReadOnly(h, r);
  }
});

test('observe-only: the same smokes run as in a normal watch (retry included)', async () => {
  const normal = harness({ ...RECOVER });
  await normal.go();
  const observed = harness({ ...RECOVER });
  await observed.go({ observeOnly: true });
  // normal: initial, retry, post-rollback; observe-only never reaches the post-rollback smoke
  assert.equal(normal.smoke.calls.length, 3);
  assert.equal(observed.smoke.calls.length, 2);
  assert.deepEqual(observed.smoke.calls[0], normal.smoke.calls[0]);
  assert.deepEqual(observed.sleeps, [60_000]);
});

test('observe-only: no issue labels, pause or otherwise, on any path', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }) });
  const r = await h.go({ observeOnly: true });
  assert.equal(r.outcome, 'needs-owner');
  assert.equal(h.issueCreate.calls.length, 0);
});

test('observe-only: reports an interrupted rollback (intent with no result) with the live deployment', async () => {
  const intent = eventOf('rollback-intent', 'aaaaaaa-1', { mergeSha: SHA, target: { id: 'dpl_old', url: 'https://old-xyz-team.vercel.app' } });
  const h = harness({ smoke: [PASS], inspect: [OLDER], events: true, eventList: [PROD_BEFORE, intent] });
  const r = await h.go({ observeOnly: true });
  assertReadOnly(h, r);
  assert.equal(r.rollbackInterrupted.intent.id, 'aaaaaaa-1');
  assert.equal(r.rollbackInterrupted.intent.url, intent.url);
  assert.equal(r.rollbackInterrupted.intent.mergeSha, SHA);
  assert.deepEqual(r.rollbackInterrupted.intent.target, { id: 'dpl_old', url: 'https://old-xyz-team.vercel.app' });
  assert.deepEqual(r.rollbackInterrupted.liveNow, { id: 'dpl_old', url: 'old-xyz-team.vercel.app' });
});

test('observe-only: an intent with a matching result, or an intent for another merge, is not an interruption', async () => {
  const intent = eventOf('rollback-intent', 'aaaaaaa-1', { mergeSha: SHA });
  const result = eventOf('rollback-result', 'aaaaaaa-1', { mergeSha: SHA, ok: true, verified: true });
  const other = eventOf('rollback-intent', 'ccccccc-1', { mergeSha: 'c'.repeat(40) });
  const done = harness({ smoke: [PASS], inspect: [OURS], events: true, eventList: [intent, result, other] });
  assert.equal((await done.go({ observeOnly: true })).rollbackInterrupted, undefined);
  // a second attempt whose result is missing is still found, even though attempt 1 finished
  const second = eventOf('rollback-intent', 'aaaaaaa-2', { mergeSha: SHA });
  const open = harness({ smoke: [PASS], inspect: [OURS], events: true, eventList: [intent, result, second] });
  assert.equal((await open.go({ observeOnly: true })).rollbackInterrupted.intent.id, 'aaaaaaa-2');
});

test('observe-only: an interrupted rollback is reported on every outcome, and an unreadable event list is only a warning', async () => {
  const intent = eventOf('rollback-intent', 'aaaaaaa-1', { mergeSha: SHA });
  const failing = harness({ ...RECOVER_EV, events: true, eventList: [intent] });
  const r = await failing.go({ observeOnly: true });
  assert.equal(r.outcome, 'needs-owner');
  assert.equal(r.rollbackInterrupted.intent.id, 'aaaaaaa-1');

  const unreadable = harness({ smoke: [PASS], inspect: [OURS], events: true, eventListError: true });
  const out = await unreadable.go({ observeOnly: true });
  assert.equal(out.outcome, 'merged');
  assert.match(out.warnings[0], /interrupted rollback: gh api: 500/);
});

// ---- a rollback that already completed (the original watch died before `P summary`)

const doneRollback = (over = {}, recovered = true) => [
  eventOf('rollback-intent', 'aaaaaaa-1', { mergeSha: SHA }),
  eventOf('rollback-result', 'aaaaaaa-1', { mergeSha: SHA, ok: true, verified: true, ...over }),
  ...(recovered ? [eventOf('recovery-reported', 'aaaaaaa-1', { mergeSha: SHA, issueUrl: 'https://github.com/acme/widgets/issues/50', revertPrUrl: 'https://github.com/acme/widgets/pull/51' })] : []),
];

test('observe-only: a COMPLETED rollback is reported as recovered without re-smoking, with the issue and revert PR, and the record closes that way', async () => {
  const h = harness({ smoke: [FAIL], inspect: [OLDER], events: true, record: true, eventList: [PROD_BEFORE, ...doneRollback()] });
  const r = await h.go({ observeOnly: true, host: 'pc-2' });
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.observeOnly, true);
  assert.equal(r.issue.url, 'https://github.com/acme/widgets/issues/50');
  assert.equal(r.revertPr.url, 'https://github.com/acme/widgets/pull/51');
  assert.equal(r.recorded.id, 'aaaaaaa-1');
  assert.equal(h.smoke.calls.length, 0, 'no smoke: the recorded outcome is the truth');
  assert.equal(h.findDeployment.calls.length, 0);
  // read-only (the issue / revert PR in the JSON are the ones the ORIGINAL run recorded, not new ones)
  assert.deepEqual([h.rollbackFn.calls.length, h.issueCreate.calls.length, h.prCreate.calls.length, h.revertBranch.calls.length, h.posted.length, h.locks.length], [0, 0, 0, 0, 0, 0]);
  assert.equal(r.rollbackInterrupted, undefined);
  assert.deepEqual(h.recordCalls.at(-1)?.slice(0, 2), ['finish', 'recovered']);
});

test('observe-only: a completed rollback that failed or was not verified is rollback-failed', async () => {
  for (const over of [{ ok: false, verified: false }, { ok: true, verified: false }]) {
    const h = harness({ smoke: [PASS], inspect: [OURS], events: true, record: true, eventList: doneRollback(over, false) });
    const r = await h.go({ observeOnly: true });
    assert.equal(r.outcome, 'rollback-failed', JSON.stringify(over));
    assert.equal(h.smoke.calls.length, 0);
    assert.equal(r.issue, null, 'no recovery-reported event, so no issue to surface');
    assert.deepEqual(h.recordCalls.at(-1)?.slice(0, 2), ['finish', 'rollback-failed']);
  }
});

test('observe-only: with no completed attempt on the PR (none, an aborted one, another merge\'s, an unreadable list) it re-derives from scratch', async () => {
  const aborted = [eventOf('rollback-intent', 'aaaaaaa-1', { mergeSha: SHA }), eventOf('rollback-result', 'aaaaaaa-1', { mergeSha: SHA, ok: false, aborted: true, verified: false })];
  const foreign = [eventOf('rollback-intent', 'ccccccc-1', { mergeSha: 'c'.repeat(40) }), eventOf('rollback-result', 'ccccccc-1', { mergeSha: 'c'.repeat(40), ok: true, verified: true })];
  for (const eventList of [[], aborted, foreign]) {
    const h = harness({ smoke: [PASS], inspect: [OURS], events: true, eventList });
    assert.equal((await h.go({ observeOnly: true })).outcome, 'merged');
    assert.ok(h.smoke.calls.length >= 1);
  }
  const unreadable = harness({ smoke: [PASS], inspect: [OURS], events: true, eventListError: true });
  assert.equal((await unreadable.go({ observeOnly: true })).outcome, 'merged');
});

test('a normal (not observe-only) watch never short-circuits on old rollback events', async () => {
  const h = harness({ smoke: [PASS], inspect: [OURS], events: true, eventList: doneRollback() });
  assert.equal((await h.go()).outcome, 'merged');
});

test('knownGoodFromEvents: the NEWEST prod-before for the environment; unreadable or foreign ones are skipped', () => {
  const older = eventOf('prod-before', '11-1', { environment: 'Production', deployment: { id: 'dpl_older', url: 'https://older.vercel.app' } });
  const staging = eventOf('prod-before', '13-1', { environment: 'Preview', deployment: { id: 'dpl_stg', url: 'https://stg.vercel.app' } });
  assert.deepEqual(knownGoodFromEvents([older, PROD_BEFORE, staging], 'Production'), { ok: true, id: 'dpl_old', url: 'https://old-xyz-team.vercel.app', sha: OLD_SHA });
  const garbled = { ...PROD_BEFORE, dataStatus: 'invalid', data: null };
  assert.equal(knownGoodFromEvents([older, garbled], 'Production').id, 'dpl_older');
  assert.equal(knownGoodFromEvents([], 'Production').ok, false);
  assert.match(knownGoodFromEvents([], 'Production').reason, /prod-before/);
  const nothing = eventOf('prod-before', '14-1', { environment: 'Production', deployment: {} });
  assert.match(knownGoodFromEvents([nothing], 'Production').reason, /neither a url nor an id/);
  const unsafe = eventOf('prod-before', '15-1', { environment: 'Production', deployment: { url: '--yes' } });
  assert.match(knownGoodFromEvents([unsafe], 'Production').reason, /unusable rollback target/);
});

test('createRunRecordTracker: sets then clears inFlight on the existing record, keeping the summary sections', () => {
  const gh = fakeSummaryGh();
  const first = emptyRecord({ repo: 'acme/widgets', pr: 12, branch: 'agent/x', baseRef: 'main' });
  writeSummaryComment(gh, 12, { record: first, sections: '## Summary\nDid the thing.' });
  const tracker = createRunRecordTracker({ gh, pr: 12, host: 'pc-1', now: () => T });
  tracker.set({ kind: 'prod-watch', host: 'pc-1', startedAt: 'now', maxMinutes: 50 });
  let rec = decodeRecord(gh.body()).record;
  assert.equal(rec.step, 'prod-watch');
  assert.equal(rec.inFlight.kind, 'prod-watch');
  assert.equal(rec.inFlight.maxMinutes, 50);
  assert.match(gh.body(), /Did the thing\./);
  tracker.clear();
  rec = decodeRecord(gh.body()).record;
  assert.equal(rec.inFlight, null);
  assert.equal(rec.step, 'prod-watch');
  assert.equal(gh.writes(), 3);
});

test('createRunRecordTracker: a record for another PR, or an unreadable one, is left alone (it throws; the watch warns)', () => {
  const foreign = fakeSummaryGh();
  writeSummaryComment(foreign, 12, { record: emptyRecord({ repo: 'acme/other', pr: 12, branch: 'b', baseRef: 'main' }) });
  const before = foreign.body();
  assert.throws(() => createRunRecordTracker({ gh: foreign, pr: 12, host: 'h' }).set({ kind: 'prod-watch' }), /does not belong to this PR/);
  assert.equal(foreign.body(), before);

  const broken = fakeSummaryGh('<!-- claude-pipeline:summary -->\n\n<!-- claude-pipeline:record:AAAA -->');
  assert.throws(() => createRunRecordTracker({ gh: broken, pr: 12, host: 'h' }).set({ kind: 'prod-watch' }), /left alone/);
});

test('createRunRecordTracker: with no summary comment yet a new record is made from the PR', () => {
  const gh = fakeSummaryGh();
  createRunRecordTracker({ gh, pr: 12, host: 'pc-1', now: () => T }).set({ kind: 'prod-watch', host: 'pc-1', startedAt: 'now', maxMinutes: 50 });
  const rec = decodeRecord(gh.body()).record;
  assert.equal(rec.branch, 'agent/x');
  assert.equal(rec.baseRef, 'main');
  assert.equal(rec.repo, 'acme/widgets');
  assert.equal(rec.inFlight.kind, 'prod-watch');
});

// ---- the command end to end (fake gh + fake vercel + real git) ------------------------------------------------------

const NEW_HOST = 'app-new-team.vercel.app';
const OLD_HOST = 'app-old-team.vercel.app';

function cliWorld({ healthy, ownedByUs = true, aliasCreatedAt = T + 2000 } = {}) {
  const { repo, bare } = repoWithOrigin();
  repo.write('app.txt', 'v2\n');
  const merge = repo.commit('Add widget (#12)');
  repo.git(['push', '-q', 'origin', 'main']);
  repo.write('.claude/pipeline.yml', [
    'version: 1',
    'project: demo',
    'verify:',
    '  full: npm run verify',
    '  quick: npm run verify:quick',
    'production:',
    '  url: https://app.example.com',
    '  provider: vercel',
    '  environment: Production',
    `  smoke: 'node "${fakeVercelPath}" --smoke {url}'`,
    '  rollback:',
    '    command: vercel rollback {deployment} --yes',
    '',
  ].join('\n'));
  mkdirSync(join(repo.dir, '.review'), { recursive: true });
  writeFileSync(join(repo.dir, '.review', 'prod-before.json'), JSON.stringify({ id: 'dpl_old', sha: OLD_SHA, url: `https://${OLD_HOST}` }));

  const vercel = fakeVercel({
    alias: { id: 'dpl_new', url: ownedByUs ? NEW_HOST : OLD_HOST, target: 'production', readyState: 'READY', createdAt: aliasCreatedAt },
    deployments: [{ id: 'dpl_old', url: OLD_HOST, createdAt: T - 600_000 }],
    healthyHosts: healthy,
  });
  const gh = createFakeGh([
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: `^api repos/acme/widgets/deployments\\?sha=${merge}`, stdoutJson: [{ id: 1, sha: merge, created_at: DEPLOYED_AT }] },
    { match: '^api repos/acme/widgets/deployments\\?environment=Production', stdoutJson: [] },
    { match: '^api repos/acme/widgets/deployments/1/statuses', stdoutJson: [{ state: 'success', environment_url: `https://${NEW_HOST}` }] },
    { match: '^api -X POST repos/acme/widgets/issues/\\d+/comments', stdoutJson: { id: 1 } },
    { match: '^api -X POST repos/acme/widgets/issues', stdoutJson: { number: 77, html_url: 'https://github.com/acme/widgets/issues/77' } },
    { match: '^pr view 12', stdoutJson: { title: 'Add widget' } },
    { match: '^pr create', stdout: 'https://github.com/acme/widgets/pull/78\n' },
  ]);
  const home = tmp('cp-home-');
  const cli = (args) => {
    const env = { ...process.env, ...gh.env, ...vercel.env, HOME: home, USERPROFILE: home, PIPELINE_NOTIFY: 'off' };
    const r = spawnSync(process.execPath, [bin, 'prod-watch', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
    return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  // The same command in this process with fake push transports (and no real production lock), so the pushes can be read.
  const inproc = async (args, { findDeployment } = {}) => {
    const rig = notifyRig();
    const ctx = {
      cwd: repo.dir,
      env: { ...process.env, ...gh.env, ...vercel.env, HOME: home, USERPROFILE: home },
      notifyDeps: rig.deps,
      prodWatchDeps: { lock: (_name, fn) => fn(), ...(findDeployment ? { findDeployment } : {}) },
    };
    const stderr = [];
    const orig = process.stderr.write;
    process.stderr.write = () => true;
    try {
      let res;
      let error;
      try {
        res = await prodWatchRun(args, ctx);
      } catch (err) {
        error = err;
      }
      return { res, error, rig, stderr };
    } finally {
      process.stderr.write = orig;
    }
  };
  return { repo, bare, merge, vercel, gh, cli, inproc };
}

// Fake push transports for the in-process command runs: nothing reaches the network or a real home directory.
function notifyRig() {
  const dir = tmp('cp-prodwatch-notify-');
  const secretsFile = join(dir, 'secrets.sh');
  writeFileSync(secretsFile, 'export NTFY_TOPIC=PRODSENTINELTOPIC\n');
  const fetchCalls = [];
  const deps = {
    env: {},
    secretsFile,
    stateDir: join(dir, 'state'),
    git: (args) => (args[0] === 'remote' ? 'git@github.com:acme/widgets.git' : ''),
    isWsl: () => false,
    lookup: async () => ({ title: 'Add widget', url: 'https://github.com/acme/widgets/pull/12' }),
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  };
  return { deps, fetchCalls, ledger: () => (existsSync(join(dir, 'state', LEDGER_NAME)) ? readFileSync(join(dir, 'state', LEDGER_NAME), 'utf8') : '') };
}

test('CLI merged: fake gh + fake vercel, healthy production serving our deployment (exit 0, no issue)', () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const r = w.cli(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.outcome, 'merged');
  assert.equal(r.json.deployment.url, `https://${NEW_HOST}`);
  assert.equal(r.json.live.id, 'dpl_new');
  assert.deepEqual(w.vercel.calls().filter((c) => c[0] !== '--smoke'), [['inspect', 'app.example.com', '--format', 'json']]);
  assert.ok(!w.gh.lines().some((l) => /issues|pr create/.test(l)));
});

// A rollback with --pr reads the attempts already on the PR first (an unreadable list refuses the rollback): give the fake gh a
// viewer and an empty comment list, in front of the world's own script.
const withEmptyPrComments = (w, front = []) => w.gh.setScript([
  ...front,
  { match: '^api user', stdout: 'bot\n' },
  { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [] },
  ...JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8')),
]);

test('CLI recovered: real rollback via fake vercel, revert pushed to the bare origin, issue + PR created through fake gh', () => {
  const w = cliWorld({ healthy: [OLD_HOST] });
  withEmptyPrComments(w);
  const r = w.cli(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.outcome, 'recovered');
  assert.equal(r.json.issue.number, 77);
  assert.equal(r.json.revertPr.number, 78);

  assert.deepEqual(w.vercel.calls().filter((c) => c[0] === 'rollback'), [['rollback', `https://${OLD_HOST}`, '--yes', '--timeout', '3m']]);
  assert.equal(w.vercel.state().alias.id, 'dpl_old');

  const calls = w.gh.calls();
  const issue = calls.find((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues') && !/comments/.test(c.argv.join(' ')));
  const issueBody = JSON.parse(issue.stdin);
  assert.equal(issueBody.title, `[pipeline] production recovered after #12 (${w.merge.slice(0, 7)})`);
  assert.deepEqual(issueBody.labels, ['pipeline-rollback']);
  const prCall = calls.find((c) => c.argv[0] === 'pr' && c.argv[1] === 'create');
  assert.deepEqual(prCall.argv.slice(2, 8), ['--head', 'agent/revert-12', '--base', 'main', '--title', 'Revert #12: Add widget']);
  assert.ok(prCall.argv.join(' ').includes('--label needs-human'));
  assert.match(prCall.stdin, /issues\/77/);
  assert.ok(calls.some((c) => /issues\/77\/comments/.test(c.argv.join(' '))), 'the issue is pointed at the revert PR');

  assert.equal(w.repo.git(['--git-dir', w.bare, 'show', 'agent/revert-12:app.txt']), 'v1\n');
  assert.equal(w.repo.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  assert.deepEqual(readdirSync(join(w.repo.dir, '.worktrees')), []);
});

test('CLI not-live: smoke passes but production keeps serving an older deployment (exit 1, issue, nothing rolled back)', () => {
  const w = cliWorld({ healthy: [OLD_HOST], ownedByUs: false, aliasCreatedAt: T - 600_000 });
  const r = w.cli(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.outcome, 'not-live');
  assert.equal(r.json.issue.number, 77);
  assert.equal(JSON.parse(w.gh.calls().find((c) => c.stdin.includes('not-live')).stdin).labels[0], 'needs-human');
  assert.equal(w.vercel.calls().filter((c) => c[0] === 'inspect').length, 6);
  assert.ok(!w.vercel.calls().some((c) => c[0] === 'rollback'));
  assert.ok(!w.gh.lines().some((l) => l.startsWith('pr create')));
});

test('CLI rollback-skipped: no known-good record (exit 1), nothing rolled back', () => {
  const w = cliWorld({ healthy: [] });
  rmSync(join(w.repo.dir, '.review', 'prod-before.json'));
  const r = w.cli(['--sha', w.merge, '--retry-wait', '0']);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.outcome, 'rollback-skipped');
  assert.match(r.json.reason, /prod-before\.json/);
  assert.ok(!w.vercel.calls().some((c) => c[0] === 'rollback'));
});

test('CLI: no production configured is exit 0 {outcome: no-production}', () => {
  const w = cliWorld({ healthy: [] });
  w.repo.write('.claude/pipeline.yml', 'version: 1\nproject: demo\nverify:\n  full: a\n  quick: b\n');
  const r = w.cli(['--sha', w.merge]);
  assert.equal(r.code, 0);
  assert.equal(r.json.outcome, 'no-production');
});

// A summary comment on PR 12 whose record stopped at step prod-watch with no outcome, as `merge` leaves it.
function noProductionWorld({ patchFails = false } = {}) {
  const w = cliWorld({ healthy: [] });
  w.repo.write('.claude/pipeline.yml', 'version: 1\nproject: demo\nverify:\n  full: a\n  quick: b\n');
  const seed = fakeSummaryGh();
  writeSummaryComment(seed, 12, { record: { ...emptyRecord({ repo: 'acme/widgets', pr: 12, branch: 'agent/x', baseRef: 'main' }), step: 'prod-watch' }, sections: '## Summary\nDid the thing.' });
  w.gh.setScript([
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^api user', stdout: 'bot\n' },
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [{ id: 1, user: { login: 'bot' }, body: seed.body() }] },
    patchFails
      ? { match: '^api -X PATCH repos/acme/widgets/issues/comments/1', stderr: 'HTTP 500', code: 1 }
      : { match: '^api -X PATCH repos/acme/widgets/issues/comments/1', stdoutJson: { id: 1, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-1' } },
  ]);
  const patched = () => w.gh.calls().filter((c) => c.argv.join(' ').startsWith('api -X PATCH'));
  return { ...w, patched };
}

test('CLI --observe-only --pr with no production configured: closes the stranded run record (step ended, outcome no-production)', () => {
  const w = noProductionWorld();
  const r = w.cli(['--sha', w.merge, '--pr', '12', '--observe-only']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.outcome, 'no-production');
  assert.equal(r.json.warnings, undefined);
  const writes = w.patched();
  assert.equal(writes.length, 1, 'one record write, no in-flight marker');
  const rec = decodeRecord(JSON.parse(writes[0].stdin).body).record;
  assert.equal(rec.step, 'ended');
  assert.equal(rec.outcome, 'no-production');
  assert.equal(rec.inFlight, null);
  assert.match(JSON.parse(writes[0].stdin).body, /Did the thing\./, 'summary sections are kept');
});

test('CLI --observe-only --pr with no production configured: a failed record write is a warning, the exit is unchanged', () => {
  const w = noProductionWorld({ patchFails: true });
  const r = w.cli(['--sha', w.merge, '--pr', '12', '--observe-only']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.outcome, 'no-production');
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /run record: could not record the observed outcome/);
});

test('CLI with no production configured and no --observe-only: the run record is not touched (the caller records the outcome)', () => {
  const w = noProductionWorld();
  const r = w.cli(['--sha', w.merge, '--pr', '12']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.outcome, 'no-production');
  assert.equal(w.patched().length, 0);
});

test('CLI usage errors exit 2: missing/short sha, bad --pr, unknown flag, stray argument', () => {
  const w = cliWorld({ healthy: [] });
  assert.equal(w.cli([]).code, 2); // neither --sha nor --pr
  assert.equal(w.cli(['--sha', 'abc123']).code, 2);
  assert.equal(w.cli(['--sha', w.merge, '--pr', '0']).code, 2);
  assert.equal(w.cli(['--sha', w.merge, '--bogus']).code, 2);
  assert.equal(w.cli(['--sha', w.merge, 'extra']).code, 2);
});

test('fill is strict for the production smoke template', () => {
  assert.equal(fill('smoke --base {url}', { url: 'https://a.b' }, { strict: true }), 'smoke --base https://a.b');
});

// ---- merge printed mergeSha:null: prod-watch resolves the merge commit from the PR itself --------------------------------

test('resolveMergeSha: retries a MERGED PR that has no merge commit yet, then returns it', async () => {
  const views = seq([{ state: 'MERGED', mergeCommit: null }, new Error('gh blew up'), { state: 'MERGED', mergeCommit: { oid: SHA.toUpperCase() } }]);
  const slept = [];
  const out = await resolveMergeSha({ prView: views, pauseMs: 7, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(out, { state: 'merged', sha: SHA });
  assert.deepEqual(slept, [7, 7]);
  assert.deepEqual(views.calls[0], [['state', 'mergeCommit']]);
});

test('resolveMergeSha: an OPEN or CLOSED PR is not-merged at once; a MERGED PR that never names the commit is unresolved', async () => {
  assert.deepEqual(await resolveMergeSha({ prView: seq([{ state: 'OPEN' }]), sleep: async () => {} }), { state: 'not-merged', prState: 'OPEN' });
  assert.deepEqual(await resolveMergeSha({ prView: seq([{ state: 'CLOSED' }]), sleep: async () => {} }), { state: 'not-merged', prState: 'CLOSED' });
  const never = seq([{ state: 'MERGED', mergeCommit: null }]);
  assert.deepEqual(await resolveMergeSha({ prView: never, looks: 4, sleep: async () => {} }), { state: 'unresolved', prState: 'MERGED' });
  assert.equal(never.calls.length, 4);
  const bad = seq([{ state: 'MERGED', mergeCommit: { oid: 'abc123' } }]);
  assert.equal((await resolveMergeSha({ prView: bad, looks: 2, sleep: async () => {} })).state, 'unresolved', 'an abbreviated oid is not a merge sha');
});

test('CLI with only --pr: the merge commit is read from the merged PR and the watch proceeds (merged, exit 0)', () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  w.gh.setScript([
    { match: '^pr view 12 --json state,mergeCommit', stdoutJson: { state: 'MERGED', mergeCommit: { oid: w.merge } } },
    ...JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8')),
  ]);
  const r = w.cli(['--pr', '12', '--retry-wait', '0']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.outcome, 'merged');
  assert.equal(r.json.mergeSha, w.merge);
});

test('CLI with only --pr: a PR that is not MERGED is exit 1 not-merged; a merge commit GitHub never names is exit 3', () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const base = JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
  w.gh.setScript([{ match: '^pr view 12 --json state,mergeCommit', stdoutJson: { state: 'OPEN', mergeCommit: null } }, ...base]);
  const open = w.cli(['--pr', '12', '--retry-wait', '0']);
  assert.equal(open.code, 1, open.stderr);
  assert.equal(open.json.error, 'not-merged');
  w.gh.setScript([{ match: '^pr view 12 --json state,mergeCommit', stdoutJson: { state: 'MERGED', mergeCommit: null } }, ...base]);
  const unnamed = w.cli(['--pr', '12', '--retry-wait', '0']);
  assert.equal(unnamed.code, 3, unnamed.stderr);
  assert.equal(unnamed.json.error, 'merge-sha-unresolved');
  assert.ok(!w.vercel.calls().some((c) => c[0] === 'rollback'));
});

// ---- the command: run events and --observe-only end to end ---------------------------------------------------------------

const postedBodies = (w) => w.gh.calls()
  .filter((c) => /^api -X POST repos\/acme\/widgets\/issues\/12\/comments/.test(c.argv.join(' ')))
  .map((c) => JSON.parse(c.stdin).body);

test('CLI recovered with --pr: rollback-intent, rollback-result and recovery-reported land on the PR as separate new comments, intent first', () => {
  const w = cliWorld({ healthy: [OLD_HOST] });
  withEmptyPrComments(w, [{ match: '^pr view 12 --json headRefName', code: 1, stderr: 'gh: Server Error (HTTP 500)' }]);
  const r = w.cli(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(r.json.outcome, 'recovered', r.stderr);
  const events = postedBodies(w).map((b) => parseEvent(b)).filter(Boolean);
  assert.deepEqual(events.map((e) => e.kind), ['rollback-intent', 'rollback-result', 'recovery-reported']);
  assert.ok(events.every((e) => e.id === `${w.merge.slice(0, 7)}-1` && e.dataStatus === 'ok'));
  assert.equal(events[0].data.target.url, `https://${OLD_HOST}`);
  assert.equal(events[1].data.verified, true);
  assert.equal(events[2].data.issueUrl, 'https://github.com/acme/widgets/issues/77');
  assert.ok(!w.gh.lines().some((l) => /-X PATCH/.test(l)), 'events are never edited');
  // The fake gh cannot answer the PR view the run record needs, so the record could not be written: that is a warning, not a failure.
  assert.ok(r.json.warnings.some((x) => /run record/.test(x)));
});

test('CLI recovered with --sha only (no PR): no events, the rollback still happens', () => {
  const w = cliWorld({ healthy: [OLD_HOST] });
  const r = w.cli(['--sha', w.merge, '--retry-wait', '0']);
  assert.equal(r.json.outcome, 'recovered', r.stderr);
  assert.deepEqual(postedBodies(w).map((b) => parseEvent(b)).filter(Boolean), []);
});

test('CLI --observe-only: failing smoke, no .review/prod-before.json; the target comes from the PR prod-before event, nothing is changed, and an unfinished rollback is reported', () => {
  const w = cliWorld({ healthy: [] });
  rmSync(join(w.repo.dir, '.review', 'prod-before.json'));
  const beforeBody = renderEvent('prod-before', '12-1', 'Production before merge.', {
    environment: 'Production', pr: 12, deployment: { id: 'dpl_old', sha: OLD_SHA, url: `https://${OLD_HOST}` },
  });
  const intentBody = renderEvent('rollback-intent', `${w.merge.slice(0, 7)}-1`, 'Rolling back.', { mergeSha: w.merge, target: { id: 'dpl_old', url: `https://${OLD_HOST}` } });
  const comments = [
    { id: 1, user: { login: 'bot' }, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-1', body: beforeBody },
    { id: 2, user: { login: 'bot' }, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-2', body: intentBody },
  ];
  w.gh.setScript([
    { match: '^api user', stdout: 'bot\n' },
    { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: comments },
    { match: '^pr view 12 --json headRefName', stdoutJson: { headRefName: 'agent/x', baseRefName: 'main' } },
    ...JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8')),
  ]);
  const r = w.cli(['--pr', '12', '--sha', w.merge, '--retry-wait', '0', '--observe-only']);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.outcome, 'needs-owner');
  assert.equal(r.json.observeOnly, true);
  assert.equal(r.json.evidence.knownGood.url, `https://${OLD_HOST}`);
  assert.equal(r.json.rollbackInterrupted.intent.id, `${w.merge.slice(0, 7)}-1`);
  assert.equal(r.json.rollbackInterrupted.liveNow.id, 'dpl_new');

  assert.ok(!w.vercel.calls().some((c) => c[0] === 'rollback'), 'no rollback');
  assert.equal(w.vercel.state().alias.id, 'dpl_new');
  const lines = w.gh.lines();
  assert.ok(!lines.some((l) => /pr create|add-label|remove-label|pr edit/.test(l)), 'no revert PR, no labels');
  assert.ok(!lines.some((l) => /^api -X POST repos\/acme\/widgets\/issues( |$)/.test(l)), 'no incident issue');
  assert.deepEqual(postedBodies(w).map((b) => parseEvent(b)).filter(Boolean), [], 'observe-only writes no events');
  assert.ok(!existsSync(join(w.repo.dir, '.worktrees', 'revert-12')));
});

test('CLI --observe-only: a healthy production is merged (exit 0), the flag is a boolean', () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const r = w.cli(['--sha', w.merge, '--retry-wait', '0', '--observe-only']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.outcome, 'merged');
  assert.equal(r.json.observeOnly, true);
});

// ---- the owner push, end to end through the command (fake gh + fake vercel + fake push transports) --------------------

test('push: merged is a quiet priority-3 "nothing to do" with the PR title', async () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const t = await w.inproc(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(t.error, undefined);
  assert.equal(t.res.exitCode, 0);
  assert.equal(t.res.output.outcome, 'merged');
  assert.equal(t.res.output.notify.sent, true);
  assert.equal(t.rig.fetchCalls.length, 1);
  const b = t.rig.fetchCalls[0].body;
  assert.equal(b.title, '#12 Add widget');
  assert.equal(b.message, 'Production OK: Live and healthy — nothing to do. (widgets)');
  assert.equal(b.priority, 3);
});

test('push: recovered names the revert PR and the issue to close, and clicks through to the rollback issue', async () => {
  const w = cliWorld({ healthy: [OLD_HOST] });
  withEmptyPrComments(w); // with --pr the rollback-intent event must be posted first, or nothing is rolled back
  const t = await w.inproc(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(t.error, undefined);
  assert.equal(t.res.exitCode, 1, 'exit code unchanged');
  assert.equal(t.res.output.outcome, 'recovered');
  assert.equal(t.rig.fetchCalls.length, 1);
  const b = t.rig.fetchCalls[0].body;
  assert.equal(b.message, 'Rolled back: Rolled back, prod healthy. Review revert PR #78; close issue #77 to unpause merges. (widgets)');
  assert.equal(b.priority, 4);
  assert.equal(b.click, 'https://github.com/acme/widgets/issues/77');
});

test('push: not-live and rollback-skipped carry their priority and say what to check', async () => {
  const live = cliWorld({ healthy: [OLD_HOST], ownedByUs: false, aliasCreatedAt: T - 600_000 });
  const a = await live.inproc(['--sha', live.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(a.res.exitCode, 1);
  assert.equal(a.res.output.outcome, 'not-live');
  assert.match(a.rig.fetchCalls[0].body.message, /^Production not live: #12 is not what production serves/);
  assert.equal(a.rig.fetchCalls[0].body.priority, 4);

  const skipped = cliWorld({ healthy: [] });
  rmSync(join(skipped.repo.dir, '.review', 'prod-before.json'));
  const b = await skipped.inproc(['--sha', skipped.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(b.res.exitCode, 1);
  assert.equal(b.res.output.outcome, 'rollback-skipped');
  assert.equal(b.rig.fetchCalls[0].body.priority, 5);
  assert.match(b.rig.fetchCalls[0].body.message, /^ROLLBACK SKIPPED: Rollback was skipped, production may be unhealthy: check it now\. Issue #77\./);
});

test('push: a missing rollback issue reads "could not be confirmed — check whether merges are paused" (through the command)', async () => {
  const w = cliWorld({ healthy: [] });
  rmSync(join(w.repo.dir, '.review', 'prod-before.json'));
  const base = JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
  w.gh.setScript([{ match: '^api -X POST repos/acme/widgets/issues(?!/)', code: 1, stderr: 'HTTP 502' }, ...base]);
  const t = await w.inproc(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(t.res.output.outcome, 'rollback-skipped');
  assert.equal(t.res.output.issue, null);
  assert.match(t.rig.fetchCalls[0].body.message, /Rollback issue could not be confirmed — check whether merges are paused\./);
});

test('push: no production configured sends nothing and exits 0 as before', async () => {
  const w = cliWorld({ healthy: [] });
  w.repo.write('.claude/pipeline.yml', 'version: 1\nproject: demo\nverify:\n  full: a\n  quick: b\n');
  const t = await w.inproc(['--sha', w.merge, '--pr', '12']);
  assert.equal(t.res.exitCode, 0);
  assert.equal(t.res.output.outcome, 'no-production');
  assert.deepEqual(t.res.output.notify, { sent: false, reason: 'no-event' });
  assert.equal(t.rig.fetchCalls.length, 0);
});

test('push: a merge commit GitHub never names is exit 3 as before, plus one prod-unknown push', async () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const base = JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
  w.gh.setScript([{ match: '^pr view 12 --json state,mergeCommit', stdoutJson: { state: 'MERGED', mergeCommit: null } }, ...base]);
  const t = await w.inproc(['--pr', '12', '--retry-wait', '0']);
  assert.equal(t.res.exitCode, 3);
  assert.equal(t.res.output.ok, false);
  assert.equal(t.res.output.error, 'merge-sha-unresolved');
  assert.match(t.res.output.reason, /did not name its merge commit/);
  assert.equal(t.rig.fetchCalls.length, 1);
  const b = t.rig.fetchCalls[0].body;
  assert.equal(b.title, '#12 Add widget');
  assert.match(b.message, /^Production check unfinished: Production check couldn't finish \(PR #12 is MERGED but GitHub did not name its merge commit/);
  assert.match(b.message, /check #12's deployment by hand/);
  assert.equal(b.priority, 4);
  assert.equal(t.res.output.notify.sent, true);
  assert.ok(!w.vercel.calls().some((c) => c[0] === 'rollback'));
});

test('push: a PR that is not MERGED is exit 1 as before, plus one prod-unknown push', async () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const base = JSON.parse(readFileSync(w.gh.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
  w.gh.setScript([{ match: '^pr view 12 --json state,mergeCommit', stdoutJson: { state: 'OPEN', mergeCommit: null } }, ...base]);
  const t = await w.inproc(['--pr', '12', '--retry-wait', '0']);
  assert.equal(t.res.exitCode, 1);
  assert.equal(t.res.output.error, 'not-merged');
  assert.equal(t.rig.fetchCalls.length, 1);
  assert.match(t.rig.fetchCalls[0].body.message, /PR #12 is OPEN, not MERGED/);
});

test('push: the deployments API failing for good rejects exactly as before and sends one prod-unknown push', async () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const findDeployment = async () => { throw new GhError({ code: 1, stderr: 'HTTP 502 Bad Gateway', args: ['api', 'deployments'] }); };
  const t = await w.inproc(['--sha', w.merge, '--pr', '12', '--retry-wait', '0'], { findDeployment });
  assert.ok(t.error instanceof UnavailableError, 'the original UnavailableError (exit 3) is re-thrown');
  assert.equal(t.res, undefined);
  assert.equal(t.rig.fetchCalls.length, 1);
  const b = t.rig.fetchCalls[0].body;
  assert.match(b.message, /^Production check unfinished: Production check couldn't finish \(.*502.*\): check #12's deployment by hand/);
  assert.equal(b.priority, 4);
  assert.ok(!w.vercel.calls().some((c) => c[0] === 'rollback'), 'nothing was rolled back');
  // an unrelated crash is re-thrown unchanged too, and still announced
  const w2 = cliWorld({ healthy: [NEW_HOST] });
  const boom = new TypeError('boom');
  const t2 = await w2.inproc(['--sha', w2.merge, '--pr', '12'], { findDeployment: async () => { throw boom; } });
  assert.equal(t2.error, boom);
  assert.equal(t2.rig.fetchCalls.length, 1);
});

test('push: replaying the same production result sends nothing the second time', async () => {
  const w = cliWorld({ healthy: [NEW_HOST] });
  const t = await w.inproc(['--sha', w.merge, '--pr', '12', '--retry-wait', '0']);
  assert.equal(t.rig.fetchCalls.length, 1);
  // same rig (same ledger), same result
  const ctxRig = t.rig;
  const again = await prodWatchRun(['--sha', w.merge, '--pr', '12', '--retry-wait', '0'], {
    cwd: w.repo.dir, env: { ...process.env, ...w.gh.env, ...w.vercel.env }, notifyDeps: ctxRig.deps, prodWatchDeps: { lock: (_n, fn) => fn() },
  });
  assert.equal(again.exitCode, 0);
  assert.equal(again.output.notify.reason, 'duplicate');
  assert.equal(ctxRig.fetchCalls.length, 1);
});
