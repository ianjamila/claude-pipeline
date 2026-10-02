// prod-watch: the decision logic is tested with every effect injected (each branch, no waiting), the real git revert with
// throwaway repos, the Vercel wrapper against a stateful fake CLI, and the command end to end with fake gh + fake vercel.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { run as procRun } from '../pipeline/lib/proc.mjs';
import { GitError } from '../pipeline/lib/git.mjs';
import { fill } from '../pipeline/lib/config.mjs';
import {
  runProdWatch, exitCodeFor, hostOf, readKnownGood, createGitOps, createSmoke, issueTitle,
} from '../pipeline/lib/prodwatch.mjs';
import { inspectAlias, rollback, vercelCommand, linkedProjectDir, VercelError, tail } from '../pipeline/lib/vercel.mjs';

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

  const deps = {
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
    sleep: async (ms) => { sleeps.push(ms); },
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
    log, held, sleeps, locks, smoke, inspect, rollbackFn, issueCreate, prCreate, issueComment, revertBranch, findDeployment,
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
  assert.deepEqual(h.revertBranch.calls[0][0], { sha: SHA, branch: 'agent/revert-12', base: 'main', dirName: 'revert-12', worktreeDir: '/repo/.worktrees' });
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
});

test('a failing issue API does not hide the outcome', async () => {
  const h = harness({ smoke: [FAIL, FAIL], inspect: [OURS], readKnownGood: () => ({ ok: false, reason: 'none' }), issueCreate: [new Error('HTTP 502')] });
  const r = await h.go();
  assert.equal(r.outcome, 'rollback-skipped');
  assert.equal(r.issue, null);
  assert.match(r.issueError, /502/);
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
    const env = { ...process.env, ...gh.env, ...vercel.env, HOME: home, USERPROFILE: home };
    const r = spawnSync(process.execPath, [bin, 'prod-watch', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
    return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  return { repo, bare, merge, vercel, gh, cli };
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

test('CLI recovered: real rollback via fake vercel, revert pushed to the bare origin, issue + PR created through fake gh', () => {
  const w = cliWorld({ healthy: [OLD_HOST] });
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

test('CLI usage errors exit 2: missing/short sha, bad --pr, unknown flag, stray argument', () => {
  const w = cliWorld({ healthy: [] });
  assert.equal(w.cli([]).code, 2);
  assert.equal(w.cli(['--sha', 'abc123']).code, 2);
  assert.equal(w.cli(['--sha', w.merge, '--pr', '0']).code, 2);
  assert.equal(w.cli(['--sha', w.merge, '--bogus']).code, 2);
  assert.equal(w.cli(['--sha', w.merge, 'extra']).code, 2);
});

test('fill is strict for the production smoke template', () => {
  assert.equal(fill('smoke --base {url}', { url: 'https://a.b' }, { strict: true }), 'smoke --base https://a.b');
});
