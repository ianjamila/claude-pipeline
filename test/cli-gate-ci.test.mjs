// final-gate, part 3: CI and preview evidence, plus the smoke command that produces the preview evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, scenario, named, assertOnlyFails, ymlFor, MERGE_SHA, PREVIEW_URL } from './helpers/gate-env.mjs';
import { pipelineYml } from './helpers/fakegh-env.mjs';
import { verdictArtifactName } from '../pipeline/lib/guard-provenance.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

// ---- final-gate: ci -------------------------------------------------------------------------------

test('final-gate: a pending or failing required check fails ci and names it', () => {
  const pending = scenario({ gh: { ci: [{ name: 'ci', state: 'IN_PROGRESS', bucket: 'pending' }, { name: 'lint', state: 'SUCCESS', bucket: 'pass' }] } });
  assertOnlyFails(pending.gate(), 'ci', /ci=pending/);
  const failing = scenario({ gh: { ci: [{ name: 'e2e', state: 'FAILURE', bucket: 'fail' }, { name: 'ci', state: 'SUCCESS', bucket: 'pass' }] } });
  assertOnlyFails(failing.gate(), 'ci', /e2e=fail/);
  const cancelled = scenario({ gh: { ci: [{ name: 'ci', state: 'CANCELLED', bucket: 'cancel' }] } });
  assertOnlyFails(cancelled.gate(), 'ci', /ci=cancel/);
});

test('final-gate: with no required checks it falls back to ALL checks; no checks at all fails closed', () => {
  const emptyRequired = scenario({ gh: { requiredCi: [], ci: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }, { name: 'extra', state: 'FAILURE', bucket: 'fail' }] } });
  const r = emptyRequired.gate();
  assertOnlyFails(r, 'ci', /extra=fail/);
  assert.match(named(r.json, 'ci').detail, /all check/);

  const noRequiredReported = scenario({ gh: { requiredCi: 'error' } });
  const ok = noRequiredReported.gate();
  assertExit(ok, 0, JSON.stringify(ok.json?.checks.filter((c) => !c.ok)));
  assert.match(named(ok.json, 'ci').detail, /all check/);

  assertOnlyFails(scenario({ gh: { requiredCi: [], ci: [] } }).gate(), 'ci', /no CI checks reported/);
});

test('final-gate: `skipping` is accepted for a docs-only diff and refused for a code diff', () => {
  const skipped = [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }, { name: 'e2e', state: 'SKIPPED', bucket: 'skipping' }];
  const docs = scenario({ change: (r) => r.write('docs/guide.md', '# Guide v2\n'), gh: { ci: skipped } });
  const r = docs.gate();
  assertExit(r, 0, JSON.stringify(r.json?.checks.filter((c) => !c.ok)));
  assert.match(named(r.json, 'ci').detail, /docs-only/);
  assertOnlyFails(scenario({ gh: { ci: skipped } }).gate(), 'ci', /e2e=skipping/);
});

// ---- final-gate: guard statuses need provenance -------------------------------------------------

const GUARD_LINK = 'https://github.com/acme/widgets/actions/runs/55';
const BOT = 'github-actions[bot]';
// One guard status as GitHub reports it: the latest status of the context on the head, the run it points at, the default branch,
// and the artifacts of that run (default: the verdict a genuine run records, both checks success; `artifacts` is a function of the
// head returning names). The final gate reads the status itself (not the row's link), so a status can be wrong in any of these ways.
// `required`: what GitHub itself requires (default: the same rows as all checks); `named`: extra ci.required_checks of the config.
const genuineVerdict = (head, states = ['success', 'success']) => verdictArtifactName({ head, integrity: states[0], hardstops: states[1] });
const guardScenario = ({ context = 'Hard-stop scan', run = {}, prs, compare = 'ahead', link = GUARD_LINK, by = BOT, state = 'success', at = '2026-10-01T10:05:00Z', runFails = false, noStatus = false, artifacts = (h) => [genuineVerdict(h)], artifactsFail = false, required, named: extraNamed } = {}) => scenario({
  ...(extraNamed ? { yml: ymlFor().replace('required_checks: [ci]', `required_checks: [${extraNamed.join(', ')}]`) } : {}),
  gh: {
    ci: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }, { name: context, state: 'SUCCESS', bucket: 'pass', link: GUARD_LINK }],
    ...(required ? { requiredCi: required } : {}),
    extra: (o) => [
      { match: '^api repos/acme/widgets/commits/[0-9a-f]{40}/statuses', stdout: noStatus ? 'null\n' : `${JSON.stringify({ state, by, at, url: link })}\n` },
      artifactsFail ? { match: '^api repos/acme/widgets/actions/runs/55/artifacts', code: 1, stderr: 'HTTP 403' }
        : { match: '^api repos/acme/widgets/actions/runs/55/artifacts\\?per_page=100 ', stdout: artifacts(o.prHead).map((n) => `${n}\n`).join('') },
      runFails ? { match: '^api repos/acme/widgets/actions/runs/55 ', code: 1, stderr: 'HTTP 404' } : {
        match: '^api repos/acme/widgets/actions/runs/55 ',
        stdout: `${JSON.stringify({
          path: '.github/workflows/pipeline-guards.yml@refs/heads/main', event: 'pull_request_target', head_sha: o.prHead, run_attempt: 1,
          created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:12:00Z',
          pull_requests: prs ? prs(o.prHead) : [{ number: 12, head: { sha: o.prHead }, base: { ref: 'main', sha: 'a'.repeat(40) } }], ...run,
        })}\n`,
      },
      { match: '^api repos/acme/widgets --jq \\.default_branch', stdout: 'main\n' },
      { match: '^api repos/acme/widgets/compare/', stdout: `${compare}\n` },
    ],
  },
});

test('final-gate: a passing guard status posted by the real workflow for THIS PR and head is accepted', () => {
  const r = guardScenario().gate();
  assert.equal(r.code, 0, JSON.stringify(r.json?.checks.filter((c) => !c.ok)));
});

test('final-gate: a guard status from another workflow, event, branch commit, PR, base branch, window, creator, or an unreadable run fails ci', () => {
  const bad = [
    guardScenario({ run: { path: '.github/workflows/evil.yml@refs/heads/x' } }),
    guardScenario({ run: { event: 'pull_request' } }),
    guardScenario({ compare: 'diverged' }),
    // the run judged another head
    guardScenario({ run: { head_sha: 'e'.repeat(40) } }),
    // a PR into a side branch with the same head may have triggered the run with that branch's workflow file
    guardScenario({ prs: (head) => [{ number: 12, head: { sha: head }, base: { ref: 'main', sha: 'a'.repeat(40) } }, { number: 13, head: { sha: head }, base: { ref: 'side', sha: 'b'.repeat(40) } }] }),
    guardScenario({ link: '' }),
    guardScenario({ link: 'https://github.com/evil/widgets/actions/runs/55' }),
    guardScenario({ runFails: true }),
    guardScenario({ by: 'mallory' }),
    guardScenario({ state: 'failure' }),
    guardScenario({ noStatus: true }),
    guardScenario({ at: '2026-10-01T11:00:00Z' }),
    guardScenario({ run: { created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:01:00Z' } }),
    // a re-run can execute an older guard revision: never counts
    guardScenario({ run: { run_attempt: 2 } }),
    guardScenario({ run: { run_attempt: undefined } }),
    guardScenario({ prs: () => [] }),
    guardScenario({ prs: (head) => [{ number: 99, head: { sha: head }, base: { ref: 'main' } }] }),
    guardScenario({ prs: () => [{ number: 12, head: { sha: 'e'.repeat(40) }, base: { ref: 'main' } }] }),
    // downgrade: a side branch cut from an old main commit is an ancestor of main but is not main
    guardScenario({ prs: (head) => [{ number: 12, head: { sha: head }, base: { ref: 'old-main-copy' } }] }),
  ];
  for (const s of bad) assertOnlyFails(s.gate(), 'ci', /guard status not posted by the pipeline-guards workflow: Hard-stop scan/);
});

// ---- final-gate: the run's verdict artifact (the spoof race, issue #3) -----------------------------------------------------

test('final-gate: a status pointing at a genuine run whose own artifact says failure, or that has none, is refused (spoof race)', () => {
  // The spoofing run posted "success" pointing at genuine run 55 of the same PR and head, while run 55 is in progress. The run is
  // genuine in every other way; only its own verdict tells the truth.
  const refused = [
    guardScenario({ artifacts: (h) => [genuineVerdict(h, ['success', 'failure'])] }),
    guardScenario({ artifacts: (h) => [genuineVerdict(h, ['success', 'error'])] }),
    guardScenario({ artifacts: () => [] }),
    guardScenario({ artifacts: () => ['verify-report'] }),
    guardScenario({ artifacts: () => [genuineVerdict('e'.repeat(40))] }),
    guardScenario({ artifacts: (h) => [genuineVerdict(h), genuineVerdict(h, ['success', 'failure'])] }),
    guardScenario({ artifactsFail: true }),
  ];
  for (const s of refused) assertOnlyFails(s.gate(), 'ci', /guard status not posted by the pipeline-guards workflow: Hard-stop scan/);
});

test('final-gate: the artifact is judged per check: a failing OTHER check does not refuse this context, a failing own check does', () => {
  const hardstopsOk = guardScenario({ artifacts: (h) => [genuineVerdict(h, ['failure', 'success'])] }).gate();
  assert.equal(hardstopsOk.code, 0, JSON.stringify(hardstopsOk.json?.checks.filter((c) => !c.ok)));
  const integrityOk = guardScenario({ context: 'Test integrity', artifacts: (h) => [genuineVerdict(h, ['success', 'failure'])] }).gate();
  assert.equal(integrityOk.code, 0, JSON.stringify(integrityOk.json?.checks.filter((c) => !c.ok)));
  assertOnlyFails(guardScenario({ context: 'Test integrity', artifacts: (h) => [genuineVerdict(h, ['failure', 'success'])] }).gate(), 'ci', /Test integrity \(the run's own verdict for integrity is failure/);
});

test('final-gate: a guard row GitHub does not require but the config names is still checked for provenance and the artifact', () => {
  // GitHub requires only `ci`; ci.required_checks also names `Hard-stop scan`. The guard row is satisfied from the full list, so
  // its provenance targets must come from there too (a forged status used to be accepted without a single provenance read).
  const configured = ['ci', '"Hard-stop scan"'];
  const required = [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }];
  const genuine = guardScenario({ named: configured, required }).gate();
  assert.equal(genuine.code, 0, JSON.stringify(genuine.json?.checks.filter((c) => !c.ok)));
  const forged = [
    guardScenario({ named: configured, required, by: 'mallory' }),
    guardScenario({ named: configured, required, link: 'https://github.com/evil/widgets/actions/runs/55' }),
    guardScenario({ named: configured, required, run: { path: '.github/workflows/evil.yml' } }),
    guardScenario({ named: configured, required, artifacts: () => [] }),
  ];
  for (const s of forged) assertOnlyFails(s.gate(), 'ci', /guard status not posted by the pipeline-guards workflow: Hard-stop scan/);
  // a guard row that is only in the full list and needed by nobody is not looked up (no requirement names it)
  const unneeded = guardScenario({ required, by: 'mallory' }).gate();
  assert.equal(unneeded.code, 0, JSON.stringify(unneeded.json?.checks.filter((c) => !c.ok)));
});

test('final-gate: non-guard checks need no provenance (their rows are never looked up)', () => {
  const r = scenario({ gh: { ci: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass', link: 'https://example.test/x' }] } }).gate();
  assert.equal(r.code, 0, JSON.stringify(r.json?.checks.filter((c) => !c.ok)));
});

// ---- final-gate: preview --------------------------------------------------------------------------

test('final-gate: with preview configured, a missing, failed or other-sha preview smoke fails preview', () => {
  assertOnlyFails(scenario({ preview: true }).gate(), 'preview', /no preview smoke evidence/);
  assertOnlyFails(scenario({ preview: true, previewSmoke: (head) => ({ ok: false, sha: head, url: PREVIEW_URL }) }).gate(), 'preview', /did not pass/);
  assertOnlyFails(scenario({ preview: true, previewSmoke: () => ({ ok: true, sha: 'f'.repeat(40), url: PREVIEW_URL }) }).gate(), 'preview', /preview smoke is for/);
  const good = scenario({ preview: true, previewSmoke: (head) => ({ ok: true, sha: head, url: PREVIEW_URL }) }).gate();
  assertExit(good, 0, JSON.stringify(good.json?.checks.filter((c) => !c.ok)));
  assert.equal(good.json.checks.at(-1).name, 'preview');
});

test('final-gate: without preview configured there is no preview check at all', () => {
  assert.equal(scenario().gate().json.checks.some((c) => c.name === 'preview'), false);
});

test('smoke then final-gate: the evidence smoke records is exactly what the preview check accepts', () => {
  const s = scenario({ preview: true });
  const sm = cli(['smoke', '--target', 'preview', '--url', 'https://pr-12.example.test', '--sha', s.head], { dir: s.repo.dir, fake: s.fake });
  assertExit(sm, 0);
  assertExit(s.gate(), 0);
  const wrong = cli(['smoke', '--target', 'preview', '--url', 'https://pr-12.example.test', '--sha', 'a'.repeat(40)], { dir: s.repo.dir, fake: s.fake });
  assertExit(wrong, 0);
  assertOnlyFails(s.gate(), 'preview', /preview smoke is for/);
  const noSha = cli(['smoke', '--target', 'preview', '--url', 'https://pr-12.example.test'], { dir: s.repo.dir, fake: s.fake });
  assert.equal(noSha.json.sha, null);
  assertOnlyFails(s.gate(), 'preview');
});

// ---- smoke ----------------------------------------------------------------------------------------

test('smoke: runs the configured command with {url}, passes the expect text in the env, records the result', () => {
  const s = scenario({ preview: true });
  const r = cli(['smoke', '--target', 'preview', '--url', 'https://pr-12.example.test/', '--expect-text', 'Welcome', '--sha', s.head], { dir: s.repo.dir, fake: s.fake });
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.target, 'preview');
  assert.equal(r.json.url, 'https://pr-12.example.test/');
  assert.equal(r.json.sha, s.head);
  assert.equal(r.json.exitCode, 0);
  assert.match(r.json.tail, /smoke url=https:\/\/pr-12\.example\.test\/ expect=Welcome/);
  assert.ok(Number.isFinite(Date.parse(r.json.at)));
  assert.deepEqual(JSON.parse(readFileSync(join(s.repo.dir, '.review', 'preview-smoke.json'), 'utf8')), r.json);
});

test('smoke: no --expect-text means the variable is not set; the exit code mirrors the command', () => {
  const s = scenario({ preview: true });
  const ok = cli(['smoke', '--target', 'preview', '--url', 'https://ok.example.test'], { dir: s.repo.dir, fake: s.fake, env: { PIPELINE_SMOKE_EXPECT_TEXT: undefined } });
  assert.match(ok.json.tail, /expect=\(none\)/);
  const bad = cli(['smoke', '--target', 'preview', '--url', 'https://bad.example.test', '--sha', s.head], { dir: s.repo.dir, fake: s.fake });
  assertExit(bad, 1);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.exitCode, 1);
  assert.equal(JSON.parse(readFileSync(join(s.repo.dir, '.review', 'preview-smoke.json'), 'utf8')).ok, false, 'a failed run overwrites an earlier pass');
});

test('smoke: the production target uses config.production.smoke and its own file', () => {
  const s = scenario({ production: true });
  const r = cli(['smoke', '--target', 'production', '--url', 'https://example.com', '--sha', MERGE_SHA], { dir: s.repo.dir, fake: s.fake });
  assertExit(r, 0);
  assert.equal(r.json.target, 'production');
  assert.ok(existsSync(join(s.repo.dir, '.review', 'production-smoke.json')));
  assert.ok(!existsSync(join(s.repo.dir, '.review', 'preview-smoke.json')));
});

test('smoke: only the last 30 lines of output are kept', () => {
  const s = scenario({ preview: true });
  const r = cli(['smoke', '--target', 'preview', '--url', 'https://ok.example.test'], { dir: s.repo.dir, fake: s.fake, env: { FAKE_SMOKE_LINES: '50' } });
  const lines = r.json.tail.split('\n');
  assert.equal(lines.length, 30);
  assert.match(lines.at(-1), /^smoke url=/);
  assert.equal(lines[0], 'line 22');
});

test('smoke: a target with no configured smoke command, bad usage, an unsafe URL or an unfilled placeholder exit 2 and run nothing', () => {
  const none = scenario();
  const a = cli(['smoke', '--target', 'preview', '--url', 'https://x.test'], { dir: none.repo.dir, fake: none.fake });
  assertExit(a, 2);
  assert.equal(a.json.error, 'not-configured');
  assert.equal(existsSync(join(none.repo.dir, '.review', 'preview-smoke.json')), false);

  const s = scenario({ preview: true });
  const run = (args) => cli(['smoke', ...args], { dir: s.repo.dir, fake: s.fake });
  assertExit(run(['--target', 'staging', '--url', 'https://x.test']), 2);
  assertExit(run(['--target', 'preview']), 2);
  assertExit(run(['--url', 'https://x.test']), 2);
  for (const url of ['https://x.test/a;touch pwned', 'https://x.test/$(id)', 'https://x.test/`id`', 'ftp://x.test', 'https://x.test/a b', "https://x.test/'", 'https://x.test/?a=1&b=2']) {
    assertExit(run(['--target', 'preview', '--url', url]), 2, url);
  }
  assert.equal(existsSync(join(s.repo.dir, '.review', 'preview-smoke.json')), false);

  const strict = scenario({ yml: ymlFor({ preview: true, smokeCommand: 'node scripts/fake-smoke.mjs {url} {sha}' }) });
  const r = cli(['smoke', '--target', 'preview', '--url', 'https://x.test'], { dir: strict.repo.dir, fake: strict.fake });
  assertExit(r, 2, 'strict fill refuses a placeholder with no value');
  assert.match(r.json.message, /\{sha\}/);
  assert.equal(existsSync(join(strict.repo.dir, '.review', 'preview-smoke.json')), false);
});


// ---- final-gate: ci honours config.ci.required_checks ---------------------------------------------

test('final-gate: a check named in ci.required_checks that GitHub never reported fails ci and names it (reviewer repro C)', () => {
  // config requires "ci"; only "vercel" reported, and branch protection reports no required checks at all
  const r = scenario({ gh: { requiredCi: 'error', ci: [{ name: 'vercel', state: 'SUCCESS', bucket: 'pass' }] } }).gate();
  assertOnlyFails(r, 'ci', /required check\(s\) missing: ci/);
  const some = scenario({ yml: ymlFor().replace('[ci]', '[ci, e2e]'), gh: { ci: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }] } }).gate();
  assertOnlyFails(some, 'ci', /required check\(s\) missing: e2e/);
});

test('final-gate: every named required check must be `pass`; `skipping` only under the docs-only rule', () => {
  const skipped = [{ name: 'ci', state: 'SKIPPED', bucket: 'skipping' }];
  assertOnlyFails(scenario({ gh: { requiredCi: skipped, ci: skipped } }).gate(), 'ci', /ci=skipping/);
  const dup = [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }, { name: 'ci', state: 'FAILURE', bucket: 'fail' }];
  assertOnlyFails(scenario({ gh: { requiredCi: dup, ci: dup } }).gate(), 'ci', /ci=fail/);
  const docs = scenario({ change: (r) => r.write('docs/guide.md', '# v2\n'), gh: { requiredCi: skipped, ci: skipped } }).gate();
  assertExit(docs, 0, JSON.stringify(docs.json?.checks.filter((c) => !c.ok)));
});

test('final-gate: no configured required checks and none reported by branch protection fails closed; an explicit empty list may fall back to all checks', () => {
  // Decision: the default (a config that never mentions ci.required_checks) is "CI is not wired up", which is never merge evidence.
  const unconfigured = 'version: 1\nproject: demo\nenforcement: gate\nverify:\n  full: npm run verify\n  quick: npm run verify:quick\nplan:\n  required: false\n';
  const closed = scenario({ yml: unconfigured, gh: { requiredCi: 'error' } }).gate();
  assertOnlyFails(closed, 'ci', /no required checks are configured/);
  // ... but when protection DOES report required checks, those are judged even though the config names none.
  const reported = scenario({ yml: unconfigured, gh: { requiredCi: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }] } }).gate();
  assertExit(reported, 0, JSON.stringify(reported.json?.checks.filter((c) => !c.ok)));
  // An explicit `required_checks: []` is the owner saying "judge every reported check": the all-checks fallback applies.
  const explicit = scenario({ yml: pipelineYml('gate', []), gh: { requiredCi: 'error' } }).gate();
  assertExit(explicit, 0, JSON.stringify(explicit.json?.checks.filter((c) => !c.ok)));
  assert.match(named(explicit.json, 'ci').detail, /all check/);
  assertOnlyFails(scenario({ yml: pipelineYml('gate', []), gh: { requiredCi: 'error', ci: [] } }).gate(), 'ci', /no CI checks reported/);
});

// ---- final-gate: preview is confirmed through GitHub deployments -----------------------------------

test('final-gate: a self-attested preview smoke is not enough without a successful GitHub deployment for the head (reviewer repro I)', () => {
  const smoke = (head) => ({ ok: true, sha: head, url: 'https://example.com/anything' });
  // the record names an arbitrary URL and the head; GitHub knows no deployment at all
  assertOnlyFails(scenario({ preview: true, previewSmoke: smoke, gh: { previewDeploy: null } }).gate(), 'preview', /no successful Preview deployment/);
  // GitHub has a deployment, but at its own URL
  assertOnlyFails(scenario({ preview: true, previewSmoke: smoke }).gate(), 'preview', /origin/);
  // the deployment is for another commit, failed, or the deployments API is unreachable
  const ok = (head) => ({ ok: true, sha: head, url: PREVIEW_URL });
  assertOnlyFails(scenario({ preview: true, previewSmoke: ok, gh: { previewDeploy: { url: PREVIEW_URL, sha: 'e'.repeat(40) } } }).gate(), 'preview', /deployment/);
  assertOnlyFails(scenario({ preview: true, previewSmoke: ok, gh: { previewDeploy: { url: PREVIEW_URL, state: 'failure' } } }).gate(), 'preview', /no successful Preview deployment/);
  const down = scenario({ preview: true, previewSmoke: ok, gh: { previewDeploy: undefined, extra: [{ match: 'deployments', code: 1, stderr: 'HTTP 500' }] } });
  assertOnlyFails(down.gate(), 'preview', /no successful Preview deployment/); // fails closed: a failed lookup is never read as a deployment
});

test('final-gate: the preview deployment is matched by origin (path and query may differ) in the configured environment', () => {
  const s = scenario({ preview: true, previewSmoke: (head) => ({ ok: true, sha: head, url: `${PREVIEW_URL}/some/page?x=1` }) });
  const r = s.gate();
  assertExit(r, 0, JSON.stringify(r.json?.checks.filter((c) => !c.ok)));
  assert.ok(s.fake.lines().some((l) => /deployments\?sha=[0-9a-f]{40}&environment=Preview/.test(l)), s.fake.lines().join('\n'));
  // a look-alike host is a different origin
  const evil = scenario({ preview: true, previewSmoke: (head) => ({ ok: true, sha: head, url: 'https://pr-12.example.test.evil.example/' }) });
  assertOnlyFails(evil.gate(), 'preview', /origin/);
  const noUrl = scenario({ preview: true, previewSmoke: (head) => ({ ok: true, sha: head }) });
  assertOnlyFails(noUrl.gate(), 'preview', /no usable url/);
});
