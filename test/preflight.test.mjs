import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight, probeCodex, protectionMissing } from '../pipeline/lib/preflight.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { floorEnv, scratchFloorDir } from './helpers/floor-env.mjs';
import { resetFloor } from '../pipeline/lib/model-floor.mjs';

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
  // The model floor registry is a scratch folder (a checkout honours PIPELINE_MODEL_FLOOR_DIR), never the account's own.
  return { fake, env: { ...fake.env, ...createFakeCodex(codex).env, ...floorEnv(), ...env } };
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
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', `${pipelineYml('gate')}default_branch: trunk\n`); // GitHub's default is "trunk": the config must name it too (#430)
  repo.commit('init');
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

// ---- the Claude Code build this terminal runs vs the installed one (plan 2026-11-10, A3) ----
// <root>/claude-code/{package.json,bin/claude.exe}; the env that points at it.
function claudeCodeInstall(t, version) {
  const root = mkdtempSync(join(tmpdir(), 'cp-pre-cc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'claude-code', 'bin'), { recursive: true });
  writeFileSync(join(root, 'claude-code', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  return { CLAUDE_CODE_EXECPATH: join(root, 'claude-code', 'bin', 'claude.exe') };
}

test('a stale terminal adds a warning, reports claudeCode, and leaves canMerge and reasons exactly as they were', async (t) => {
  const repo = repoWith('github');
  const install = claudeCodeInstall(t, '2.1.321');
  const baseline = await runPreflight({ cwd: repo.dir, env: world().env });
  const stale = await runPreflight({ cwd: repo.dir, env: world([], { env: { ...install, AI_AGENT: 'claude-code_2-1-318_agent' } }).env });
  assert.deepEqual(stale.claudeCode, { running: '2.1.318', installed: '2.1.321', stale: true });
  assert.equal(stale.warnings.length, 1);
  assert.match(stale.warnings[0], /this terminal runs Claude Code 2\.1\.318 but 2\.1\.321 is installed: restart it before a review's Fable pass/);
  assert.equal(stale.canMerge, true);
  assert.equal(stale.canMerge, baseline.canMerge);
  assert.equal(stale.ok, baseline.ok);
  assert.deepEqual(stale.reasons, baseline.reasons);
  assert.deepEqual(baseline.warnings, []);
});

test('a stale terminal never turns a blocked world into a mergeable one either', async (t) => {
  const repo = repoWith('github');
  const install = claudeCodeInstall(t, '2.1.321');
  const paused = [{ match: '^issue list --label pipeline-pause', stdoutJson: [{ number: 7, title: 'pause', url: 'u' }] }];
  const blocked = await runPreflight({ cwd: repo.dir, env: world(paused, { env: { ...install, AI_AGENT: 'claude-code_2-1-318_agent' } }).env });
  assert.equal(blocked.claudeCode.stale, true);
  assert.equal(blocked.canMerge, false);
});

test('an up-to-date or newer terminal, and an unknown build, add no warning and leave canMerge true', async (t) => {
  const repo = repoWith('github');
  const install = claudeCodeInstall(t, '2.1.321');
  const cases = [
    [{ ...install, AI_AGENT: 'claude-code_2-1-321_agent' }, { running: '2.1.321', installed: '2.1.321', stale: false }],
    [{ ...install, AI_AGENT: 'claude-code_2-1-400_agent' }, { running: '2.1.400', installed: '2.1.321', stale: false }],
    [{ ...install }, { running: null, installed: '2.1.321', stale: null }],
    [{ AI_AGENT: 'claude-code_2-1-321_agent' }, { running: '2.1.321', installed: null, stale: null }],
    [{}, { running: null, installed: null, stale: null }],
  ];
  for (const [extra, want] of cases) {
    const r = await runPreflight({ cwd: repo.dir, env: world([], { env: extra }).env });
    assert.deepEqual(r.claudeCode, want, JSON.stringify(extra));
    assert.deepEqual(r.warnings, [], JSON.stringify(extra));
    assert.equal(r.canMerge, true, JSON.stringify(extra));
  }
});

// ---- an owner allowance or a hold below MIN_FABLE still in force (review round 2: R2-F2 c) ----
test('an owner allowance or a hold below MIN_FABLE adds a warning; clearing it removes the warning; canMerge and reasons never change', async () => {
  const repo = repoWith('github');
  const dir = scratchFloorDir();
  const check = async () => runPreflight({ cwd: repo.dir, env: world([], { env: floorEnv(dir) }).env });
  const baseline = await check();
  assert.deepEqual(baseline.warnings, []);

  await resetFloor({ dir, allowId: ['claude-fable-6-preview', 'claude-fable-6-b'] });
  const allowed = await check();
  assert.deepEqual(allowed.warnings, ['owner allowance in force: claude-fable-6-preview, claude-fable-6-b; once the parser fix is installed, remove it with `pipeline model-floor reset --remove-allow claude-fable-6-preview --remove-allow claude-fable-6-b`']);
  assert.equal(allowed.canMerge, baseline.canMerge);
  assert.deepEqual(allowed.reasons, baseline.reasons);

  await resetFloor({ dir, hold: 'claude-fable-5-1-20261001' });
  const both = await check();
  assert.equal(both.warnings.length, 2);
  assert.match(both.warnings[1], /^owner hold below claude-fable-5-2 in force: claude-fable-5-1; clear it with `pipeline model-floor reset --clear-hold`/);
  assert.equal(both.canMerge, true);

  await resetFloor({ dir, clearAllow: true });
  assert.equal((await check()).warnings.length, 1, 'only the hold is left');
  await resetFloor({ dir, hold: 'claude-fable-5-4' });
  assert.deepEqual((await check()).warnings, [], 'a hold at or above MIN_FABLE lowers nothing: no warning');
  await resetFloor({ dir, clearHold: true });
  assert.deepEqual((await check()).warnings, []);
});

test('R3-F2: an allowance the parser can read now gets its own "no longer needed" warning, and is not listed as in force; canMerge never changes', async () => {
  const repo = repoWith('github');
  const dir = scratchFloorDir();
  const check = async () => runPreflight({ cwd: repo.dir, env: world([], { env: floorEnv(dir) }).env });
  const baseline = await check();
  await resetFloor({ dir, allowId: ['claude-fable-5-3'] });
  const readable = await check();
  assert.deepEqual(readable.warnings, ['allowance claude-fable-5-3 is readable now and no longer needed: remove it with `pipeline model-floor reset --remove-allow claude-fable-5-3`']);
  assert.equal(readable.canMerge, baseline.canMerge);
  assert.deepEqual(readable.reasons, baseline.reasons);
  await resetFloor({ dir, allowId: ['claude-fable-6-preview'] });
  const mixed = await check();
  assert.deepEqual(mixed.warnings, [
    'owner allowance in force: claude-fable-6-preview; once the parser fix is installed, remove it with `pipeline model-floor reset --remove-allow claude-fable-6-preview`',
    'allowance claude-fable-5-3 is readable now and no longer needed: remove it with `pipeline model-floor reset --remove-allow claude-fable-5-3`',
  ]);
  for (const w of mixed.warnings) assert.doesNotMatch(w, /--clear-allow/, 'a warning never sends the owner to the all-or-nothing flag');
  await resetFloor({ dir, clearAllow: true });
  assert.deepEqual((await check()).warnings, []);
});

test('a bypass warning never turns a blocked world into a mergeable one, and an unreadable registry adds none', async () => {
  const repo = repoWith('github');
  const dir = scratchFloorDir();
  await resetFloor({ dir, allowId: ['claude-fable-6-preview'] });
  const paused = [{ match: '^issue list --label pipeline-pause', stdoutJson: [{ number: 7, title: 'pause', url: 'u' }] }];
  const blocked = await runPreflight({ cwd: repo.dir, env: world(paused, { env: floorEnv(dir) }).env });
  assert.equal(blocked.warnings.length, 1);
  assert.equal(blocked.canMerge, false);
  writeFileSync(join(dir, 'fable.json'), '{ not json');
  assert.deepEqual((await runPreflight({ cwd: repo.dir, env: world([], { env: floorEnv(dir) }).env })).warnings, []);
});

// #430: the pipeline supports only GitHub's default branch as its main; a pipeline.yml naming another one is reported up front.
test("default_branch differing from GitHub's default is reported and blocks canMerge with the fix text", async () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', `${pipelineYml('github')}default_branch: develop\n`);
  repo.commit('init');
  const { env } = world();
  const r = await runPreflight({ cwd: repo.dir, env });
  assert.equal(r.config.ok, true, r.config.errors?.join('|'));
  assert.equal(r.canMerge, false);
  const reason = r.reasons.find((x) => /default_branch/.test(x));
  assert.equal(reason, 'pipeline.yml names default_branch "develop" but GitHub\'s default branch is "main": the pipeline supports only GitHub\'s default branch as its main — set default_branch: main, or make develop the default branch on GitHub');
});

test('default_branch equal to GitHub\'s default adds no reason (the healthy world stays canMerge)', async () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', `${pipelineYml('github')}default_branch: main\n`);
  repo.commit('init');
  const r = await runPreflight({ cwd: repo.dir, env: world().env });
  assert.equal(r.canMerge, true);
  assert.deepEqual(r.reasons, []);
});

test('default_branch check: a config that did not load (null cfg) skips it, with no throw and no default_branch reason', async () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', 'version: 1\nproject: [not a string\n');
  repo.commit('init');
  const r = await runPreflight({ cwd: repo.dir, env: world().env });
  assert.equal(r.config.ok, false);
  assert.equal(r.reasons.some((x) => /default_branch/.test(x)), false, r.reasons.join('|'));
});
