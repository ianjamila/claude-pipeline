import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, probeCodex, protectionMissing } from '../pipeline/lib/preflight.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';

function repoWith(enforcement = 'github', checks) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml(enforcement, checks));
  repo.commit('init');
  return repo;
}

// A healthy world; `over` entries are matched first.
function world(over = [], { codex = {}, env = {} } = {}) {
  const fake = createFakeGh([
    ...over,
    { match: '^auth status', code: 0 },
    { match: '^api user', stdout: 'me\n' },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) },
    { match: '^issue list --label pipeline-pause', stdoutJson: [] },
    { match: '^issue list --label pipeline-rollback', stdoutJson: [] },
  ]);
  return { fake, env: { ...fake.env, ...createFakeCodex(codex).env, ...env } };
}

const PLAN_403 = {
  match: 'branches/main/protection',
  code: 1,
  stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
};

test('healthy world: github mode, canMerge true, nothing in reasons', async () => {
  const repo = repoWith('github');
  const { env } = world();
  const r = await runPreflight({ cwd: repo.dir, env });
  assert.equal(r.ok, true);
  assert.equal(r.off, false);
  assert.equal(r.config.ok, true);
  assert.deepEqual(r.gh, { authed: true, login: 'me' });
  assert.equal(r.enforcement.declared, 'github');
  assert.equal(r.enforcement.mode, 'github');
  assert.equal(r.enforcement.protected, true);
  assert.deepEqual(r.enforcement.missing, []);
  assert.deepEqual(r.pause, { open: false, issues: [] });
  assert.deepEqual(r.rollback, { open: false, issues: [] });
  assert.equal(r.codex.available, true);
  assert.equal(r.codex.version, 'codex-cli 9.9.9');
  assert.equal(r.clean, true);
  assert.equal(r.canMerge, true);
  assert.deepEqual(r.reasons, []);
});

test('403 plan: mode gate; canMerge false when the config declares github', async () => {
  const repo = repoWith('github');
  const { env } = world([PLAN_403]);
  const r = await runPreflight({ cwd: repo.dir, env });
  assert.equal(r.enforcement.protected, false);
  assert.equal(r.enforcement.mode, 'gate');
  assert.equal(r.enforcement.reason, 'plan');
  assert.equal(r.canMerge, false);
  assert.ok(r.reasons.some((x) => /GitHub Pro/.test(x)), r.reasons.join('|'));
});

test('403 plan: canMerge true when the config declares gate (and nothing else blocks)', async () => {
  const repo = repoWith('gate');
  const { env } = world([PLAN_403]);
  const r = await runPreflight({ cwd: repo.dir, env });
  assert.equal(r.enforcement.declared, 'gate');
  assert.equal(r.enforcement.mode, 'gate');
  assert.equal(r.canMerge, true);
  assert.deepEqual(r.reasons, []);
});

test('403 permission and 404 not protected both mean gate', async () => {
  const repo = repoWith('github');
  const perm = await runPreflight({ cwd: repo.dir, env: world([{ match: 'protection', code: 1, stderr: 'gh: Resource not accessible (HTTP 403)' }]).env });
  assert.equal(perm.enforcement.reason, 'permission');
  assert.equal(perm.canMerge, false);
  const none = await runPreflight({ cwd: repo.dir, env: world([{ match: 'protection', code: 1, stderr: 'gh: Branch not protected (HTTP 404)' }]).env });
  assert.equal(none.enforcement.reason, 'not-protected');
  assert.equal(none.enforcement.mode, 'gate');
  assert.match(none.reasons.join('|'), /not protected|branch protection/i);
});

test('an unreadable protection (5xx) is gate with reason error, never github', async () => {
  const repo = repoWith('github');
  const r = await runPreflight({ cwd: repo.dir, env: world([{ match: 'protection', code: 1, stderr: 'gh: Server Error (HTTP 502)' }]).env });
  assert.equal(r.enforcement.mode, 'gate');
  assert.equal(r.enforcement.reason, 'error');
  assert.equal(r.canMerge, false);
});

test('missing enforce_admins is listed (and so is everything else §6.6 requires)', async () => {
  const repo = repoWith('github');
  const weak = fullProtection(['ci']);
  weak.enforce_admins = { enabled: false };
  const r = await runPreflight({ cwd: repo.dir, env: world([{ match: 'protection', stdoutJson: weak }]).env });
  assert.deepEqual(r.enforcement.missing, ['enforce_admins']);
  assert.equal(r.enforcement.protected, true);
  assert.equal(r.enforcement.mode, 'gate');
  assert.equal(r.canMerge, false);
  assert.ok(r.reasons.includes('branch protection missing: enforce_admins'), r.reasons.join('|'));
});

test('protectionMissing checks each §6.6 setting', () => {
  assert.deepEqual(protectionMissing(fullProtection(['ci']), ['ci']), []);
  assert.deepEqual(protectionMissing({}, []), [
    'enforce_admins', 'linear_history', 'no_force_push', 'no_deletions', 'pull_request_required',
  ]);
  const p = fullProtection(['ci']);
  p.required_linear_history.enabled = false;
  p.allow_force_pushes.enabled = true;
  p.allow_deletions.enabled = true;
  delete p.required_pull_request_reviews;
  assert.deepEqual(protectionMissing(p, ['ci']), ['linear_history', 'no_force_push', 'no_deletions', 'pull_request_required']);
});

test('required checks must all be present, by checks[].context or legacy contexts[]', () => {
  const p = fullProtection(['ci']);
  p.required_status_checks.contexts = ['legacy'];
  assert.deepEqual(protectionMissing(p, ['ci', 'legacy']), []);
  assert.deepEqual(protectionMissing(p, ['ci', 'e2e', 'legacy']), ['required_check:e2e']);
  delete p.required_status_checks;
  assert.deepEqual(protectionMissing(p, ['ci']), ['required_check:ci']);
});

test('a missing required check shows up in the live preflight', async () => {
  const repo = repoWith('github', ['ci', 'e2e']);
  const r = await runPreflight({ cwd: repo.dir, env: world().env });
  assert.deepEqual(r.enforcement.missing, ['required_check:e2e']);
  assert.equal(r.enforcement.mode, 'gate');
});

test('an open pause issue blocks merging, with a plain-words reason', async () => {
  const repo = repoWith('github');
  const issue = { number: 12, title: 'hold everything', url: 'https://github.com/acme/widgets/issues/12', labels: [{ name: 'pipeline-pause' }] };
  const r = await runPreflight({ cwd: repo.dir, env: world([{ match: '^issue list --label pipeline-pause', stdoutJson: [issue] }]).env });
  assert.equal(r.pause.open, true);
  assert.deepEqual(r.pause.issues, [{ number: 12, title: 'hold everything', url: issue.url }]);
  assert.equal(r.canMerge, false);
  assert.ok(r.reasons.includes('pipeline-pause issue #12 is open'), r.reasons.join('|'));
});

test('an open rollback issue blocks merging', async () => {
  const repo = repoWith('github');
  const issue = { number: 30, title: 'rolled back', url: 'u', labels: [] };
  const r = await runPreflight({ cwd: repo.dir, env: world([{ match: '^issue list --label pipeline-rollback', stdoutJson: [issue] }]).env });
  assert.equal(r.rollback.open, true);
  assert.equal(r.canMerge, false);
  assert.ok(r.reasons.includes('pipeline-rollback issue #30 is open'), r.reasons.join('|'));
});

test('a failed issue lookup is treated as OPEN (fail closed), with the reason', async () => {
  const repo = repoWith('github');
  const r = await runPreflight({ cwd: repo.dir, env: world([{ match: '^issue list --label pipeline-pause', code: 1, stderr: 'HTTP 502' }]).env });
  assert.equal(r.pause.open, true);
  assert.match(r.pause.error, /502/);
  assert.equal(r.canMerge, false);
  assert.match(r.reasons.join('|'), /could not check .*pipeline-pause.*treating as open/);
});

test('PIPELINE_OFF=1 means off and no merging', async () => {
  const repo = repoWith('github');
  const r = await runPreflight({ cwd: repo.dir, env: world([], { env: { PIPELINE_OFF: '1' } }).env });
  assert.equal(r.off, true);
  assert.equal(r.canMerge, false);
  assert.ok(r.reasons.some((x) => /PIPELINE_OFF/.test(x)));
  const notOff = await runPreflight({ cwd: repo.dir, env: world([], { env: { PIPELINE_OFF: '0' } }).env });
  assert.equal(notOff.off, false);
});

test('codex unavailable is reported but does not change canMerge', async () => {
  const repo = repoWith('github');
  for (const codex of [{ versionCode: 1 }, { loginCode: 1 }]) {
    const r = await runPreflight({ cwd: repo.dir, env: world([], { codex }).env });
    assert.equal(r.codex.available, false);
    assert.ok(r.codex.reason);
    assert.equal(r.canMerge, true);
    assert.deepEqual(r.reasons, []);
  }
});

test('probeCodex: a codex that is not installed is unavailable, not a crash', () => {
  const r = probeCodex({ PIPELINE_CODEX: 'definitely-not-a-real-binary-xyz' });
  assert.equal(r.available, false);
  assert.ok(r.reason);
});

test('missing pipeline.yml: config.ok false, canMerge false', async () => {
  const repo = createTmpRepo();
  repo.write('README.md', 'x');
  repo.commit('init');
  const r = await runPreflight({ cwd: repo.dir, env: world().env });
  assert.equal(r.config.ok, false);
  assert.equal(r.ok, false);
  assert.equal(r.canMerge, false);
  assert.match(r.config.errors.join('|'), /pipeline\.yml/);
  assert.match(r.reasons.join('|'), /pipeline\.yml/);
});

test('gh not authenticated: ok false and canMerge false', async () => {
  const repo = repoWith('github');
  const r = await runPreflight({ cwd: repo.dir, env: world([{ match: '^auth status', code: 1, stderr: 'not logged in' }]).env });
  assert.equal(r.gh.authed, false);
  assert.equal(r.ok, false);
  assert.equal(r.canMerge, false);
  assert.match(r.reasons.join('|'), /gh .*auth/i);
});

test('a dirty working tree is reported in clean (and does not by itself block)', async () => {
  const repo = repoWith('github');
  repo.write('scratch.txt', 'wip');
  const r = await runPreflight({ cwd: repo.dir, env: world().env });
  assert.equal(r.clean, false);
  assert.equal(r.canMerge, true);
});

test('injected gh and codex are used instead of the real ones', async () => {
  const repo = repoWith('gate');
  const gh = {
    authStatus: () => ({ ok: true, message: '' }),
    viewer: () => 'stub',
    repo: () => ({ defaultBranch: 'trunk', slug: 'o/r' }),
    protection: (b) => { assert.equal(b, 'trunk'); return { status: 404, reason: 'not-protected', message: 'x' }; },
    listIssues: () => [],
  };
  const r = await runPreflight({ cwd: repo.dir, env: {}, gh, codex: async () => ({ available: true, reason: null, version: 'v' }) });
  assert.equal(r.gh.login, 'stub');
  assert.equal(r.enforcement.branch, 'trunk');
  assert.equal(r.canMerge, true);
});

test('guard contexts are always required: a repo that lists no checks is NOT github mode until protection has them', async () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github', [], { guardChecks: true }));
  repo.commit('init');
  // Protection exists but requires nothing at all (the old false "healthy").
  const bare = await runPreflight({ cwd: repo.dir, env: world([{ match: 'branches/main/protection', stdoutJson: fullProtection([]) }]).env });
  assert.deepEqual(bare.enforcement.missing, ['required_check:Test integrity', 'required_check:Hard-stop scan']);
  assert.equal(bare.enforcement.mode, 'gate');
  assert.equal(bare.canMerge, false);
  assert.ok(bare.reasons.some((x) => /required_check:Test integrity/.test(x)), bare.reasons.join('|'));

  const guarded = await runPreflight({ cwd: repo.dir, env: world([{ match: 'branches/main/protection', stdoutJson: fullProtection(['Test integrity', 'Hard-stop scan']) }]).env });
  assert.equal(guarded.enforcement.mode, 'github');
  assert.equal(guarded.canMerge, true);
});

test('configured checks are required IN ADDITION to the guard contexts; ci.guard_checks: false drops only the guards', async () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github', ['ci'], { guardChecks: true }));
  repo.commit('init');
  const onlyCi = await runPreflight({ cwd: repo.dir, env: world([{ match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) }]).env });
  assert.deepEqual(onlyCi.enforcement.missing, ['required_check:Test integrity', 'required_check:Hard-stop scan']);

  const off = createTmpRepo();
  off.write('.claude/pipeline.yml', pipelineYml('github', ['ci'], { guardChecks: false }));
  off.commit('init');
  const r = await runPreflight({ cwd: off.dir, env: world([{ match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) }]).env });
  assert.equal(r.enforcement.mode, 'github');
  assert.equal(r.canMerge, true);
});
