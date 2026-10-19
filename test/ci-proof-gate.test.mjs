// T2a: the final gate's rules for verify steps that GitHub's CI run may vouch for (verify.deferrable_steps + verify.ci_proof), with
// the CI lookup itself faked (T2b builds the real one). verifyReportCheck is driven directly for the rule matrix; evaluateGate and
// the CLI cover the wiring (the proofs field, the default stub, the merge re-check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGate, gateRefusals, verifyReportCheck } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { treeFingerprint } from '../pipeline/lib/git.mjs';
import { scenario, ymlFor } from './helpers/gate-env.mjs';
import { createFakeCodex } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { PR, RUN, SPEC, accepted, ciRow, judge, kindRow, legacyRow, made, refused, setup, ymlWith } from './helpers/ci-proof-env.mjs';

// ---- the row rules ---------------------------------------------------------------------------------

test('skippable-only step: the legacy rule is unchanged for every legacy shape; skipKind local is fine, a ci claim is refused', async () => {
  const noKeys = ymlFor().replace('  quick: npm run verify:quick\n', '  quick: npm run verify:quick\n  skippable_steps: [unit]\n');
  const withOtherKeys = ymlWith({ skippable: ['unit'], deferrable: ['lint'] });
  for (const [label, y] of [['no new keys', noKeys], ['other step deferrable', withOtherKeys]]) {
    const s = setup({ yml: y });
    for (const [shape, row] of [['skipped + reason', kindRow(undefined)], ['legacy pass+skipped', legacyRow], ['skipKind local', kindRow('local')], ['unknown skipKind', kindRow('whatever')]]) {
      const r = await judge(s, undefined, row);
      accepted(r, `${label} / ${shape}`);
      assert.match(r.c.detail, /1 skipped: unit/, `${label} / ${shape}`);
      assert.equal(r.calls.length, 0, 'CI proof is never consulted');
    }
    refused(await judge(s, undefined, kindRow(undefined, '')), /unit was skipped without a reason/, `${label} / no reason`);
    refused(await judge(s, undefined, kindRow('ci')), /unit was deferred to CI; list it in verify\.deferrable_steps/, `${label} / ci claim`);
  }
  refused(await judge(setup({ yml: ymlFor() }), undefined, kindRow(undefined)), /unit was skipped; list it in verify\.skippable_steps/, 'unlisted');
});

test('deferrable-only step: accepted as a pass (recorded as local) or as skipped with skipKind ci; anything else is refused', async () => {
  const s = setup({ yml: ymlWith() });
  const plain = await judge(s);
  accepted(plain, 'plain pass');
  assert.deepEqual(plain.proofs, [{ step: 'unit', source: 'local' }]);
  assert.equal(plain.calls.length, 0);

  const ci = await judge(s, undefined, ciRow);
  accepted(ci, 'ci skip');
  assert.deepEqual(ci.proofs, [{ step: 'unit', source: 'ci', run: RUN }]);
  assert.match(ci.c.detail, /CI proof: unit via run 777 attempt 2/);
  assert.match(ci.c.detail, /1 skipped: unit — deferred to CI/);

  for (const [label, row] of [
    ['skipped, skipKind local', kindRow('local')],
    ['skipped, no skipKind', kindRow(undefined)],
    ['skipped, unknown skipKind', kindRow('remote')],
    ['skipped, empty skipKind', kindRow('')],
    ['legacy pass+skipped', legacyRow],
    ['legacy pass+skipped carrying skipKind ci', (r) => { legacyRow(r); r.steps[3].skipKind = 'ci'; }],
  ]) {
    const r = await judge(s, undefined, row);
    refused(r, /unit is deferrable/, label);
    assert.equal(r.calls.length, 0, `${label}: no CI lookup for a refused shape`);
  }
  // other bad statuses are refused as ever
  refused(await judge(s, undefined, (r) => { r.steps[3].status = 'fail'; }), /unit=fail/, 'fail');
  refused(await judge(s, undefined, (r) => { r.steps[3].status = 'not-run'; }), /unit=not-run/, 'not-run');
});

test('a step in BOTH lists must carry skipKind local (today\'s rule, reason required) or ci (needs the proof); missing or unknown is refused', async () => {
  const s = setup({ yml: ymlWith({ skippable: ['unit'] }) });
  const local = await judge(s, undefined, kindRow('local'));
  accepted(local, 'local');
  assert.equal(local.calls.length, 0, 'a local skip needs no CI proof');
  assert.deepEqual(local.proofs, [], 'a skipped step is not a local run, so it is not recorded as one');
  assert.match(local.c.detail, /1 skipped: unit — no unit dependency changed/);
  refused(await judge(s, undefined, kindRow('local', '')), /unit was skipped without a reason/, 'local without reason');

  const ci = await judge(s, undefined, ciRow);
  accepted(ci, 'ci');
  assert.equal(ci.calls.length, 1);
  assert.deepEqual(ci.proofs, [{ step: 'unit', source: 'ci', run: RUN }]);

  for (const [label, row] of [['no skipKind', kindRow(undefined)], ['unknown skipKind', kindRow('remote')], ['legacy skip', legacyRow], ['non-string skipKind', kindRow(7)]]) {
    const r = await judge(s, undefined, row);
    refused(r, /unit is deferrable.*skipKind "local" or "ci"/, label);
    assert.equal(r.calls.length, 0, label);
  }
  const pass = await judge(s, undefined, (r) => r);
  accepted(pass, 'pass');
  assert.deepEqual(pass.proofs, [{ step: 'unit', source: 'local' }], 'a step that ran locally is recorded as local');
});

test('a repo without the new keys: a ci-kind skip is refused, plain reports behave exactly as before, no proofs', async () => {
  const s = setup({ yml: ymlFor() });
  refused(await judge(s, undefined, ciRow), /unit was deferred to CI; list it in verify\.deferrable_steps/, 'ci row');
  const ok = await judge(s, undefined, (r) => r);
  accepted(ok, 'plain');
  assert.deepEqual(ok.proofs, []);
  assert.doesNotMatch(ok.c.detail, /CI proof/);
  assert.match(ok.c.detail, /^full verify passed at [0-9a-f]{8} \(5 steps\)$/);
});

// ---- where the proof settings come from ------------------------------------------------------------

test('the proof settings come from the BASE branch: a PR that grants itself deferrability gets no CI proof', async () => {
  // base: no deferrable keys at all; the PR adds them (and so also changes .claude/pipeline.yml)
  const s = setup({ yml: ymlFor(), report: ciRow, change: (repo) => repo.write('.claude/pipeline.yml', ymlWith()) });
  const r = await judge(s);
  refused(r, /ci-proof-missing:unit \(origin\/main does not list unit in verify\.deferrable_steps\)/, 'PR-granted deferral');
  assert.equal(r.calls.length, 0);

  // base lists the step without a ci_proof entry: not a valid config, refused with the base's own reason
  const noProof = setup({ yml: ymlWith({ proof: false }), report: ciRow, change: (repo) => repo.write('.claude/pipeline.yml', ymlWith()) });
  refused(await judge(noProof), /ci-proof-missing:unit \(origin\/main's \.claude\/pipeline\.yml is not a valid config.*ci_proof/, 'base invalid');
});

test('the spec handed to ciProof is the base branch\'s, with the event defaulted, plus pr/head/tree/base/gh/env and a fresh copy', async () => {
  const s = setup({ yml: ymlWith(), report: ciRow });
  const r = await judge(s, async ({ spec }) => { spec.job = 'tampered'; return { state: 'pass', reason: 'ok', run: RUN }; });
  accepted(r, 'pass');
  assert.equal(r.calls.length, 1);
  const [args] = r.calls;
  assert.deepEqual(Object.keys(args).sort(), ['base', 'env', 'gh', 'head', 'pr', 'root', 'spec', 'step', 'tree']);
  assert.equal(args.root, s.repo.dir);
  assert.equal(args.step, 'unit');
  assert.equal(args.pr, PR);
  assert.equal(args.head, s.head);
  assert.equal(args.tree, treeFingerprint({ cwd: s.repo.dir }));
  assert.deepEqual(args.base, { ref: 'main', sha: s.baseTip });
  assert.equal(args.gh, r.gh);
  assert.equal(args.env, r.env);
  assert.deepEqual(args.spec, { ...SPEC, job: 'tampered' }, 'the lookup got the base spec (here mutated by the fake)');
  // a lookup that mutates its spec cannot change what a later run sees
  const again = await judge(setup({ yml: ymlWith(), report: ciRow }), async ({ spec }) => ({ state: 'pass', reason: spec.job, run: RUN }));
  assert.equal(again.calls[0].spec.job, 'Unit tests');
});

test('the base is fetched first: a base commit that exists only on the remote is what counts', async () => {
  const s = setup({ yml: ymlWith(), report: ciRow });
  // the remote's main moves on (another clone pushes): the gate must fetch it, not trust the stale local origin/main
  const other = mkdtempSync(join(tmpdir(), 'cp-other-'));
  made.push(other);
  execFileSync('git', ['clone', '-q', s.origin, other]);
  execFileSync('git', ['-C', other, 'config', 'user.email', 't@example.invalid']);
  execFileSync('git', ['-C', other, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', other, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'main moves on']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
  const tip = execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(tip, s.baseTip);
  const r = await judge(s);
  accepted(r, 'pass');
  assert.deepEqual(r.calls[0].base, { ref: 'main', sha: tip });
});

test('base unreadable: fetch fails, no .claude/pipeline.yml on base, or an invalid one -> ci-proof-missing, never a pass', async () => {
  const noRemote = setup({ report: ciRow });
  noRemote.repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-no-such-remote-dir')]);
  const a = await judge(noRemote);
  refused(a, /ci-proof-missing:unit \(could not fetch origin\/main/, 'fetch fails');
  assert.equal(a.calls.length, 0);

  const noYml = setup({ report: ciRow });
  noYml.repo.git(['checkout', '-q', '-b', 'tmp-base', 'main']);
  noYml.repo.rm('.claude/pipeline.yml');
  noYml.repo.commit('base without config');
  noYml.repo.git(['push', '-q', '-f', 'origin', 'tmp-base:main']);
  noYml.repo.git(['checkout', '-q', 'agent/feature']);
  refused(await judge(noYml), /ci-proof-missing:unit \(origin\/main has no \.claude\/pipeline\.yml\)/, 'no config on base');

  const bad = setup({ report: ciRow });
  bad.repo.git(['checkout', '-q', '-b', 'tmp-base', 'main']);
  bad.repo.write('.claude/pipeline.yml', 'version: 1\nproject: demo\nverify:\n  full: x\n  quick: y\n  bogus_key: 1\n');
  bad.repo.commit('base with broken config');
  bad.repo.git(['push', '-q', '-f', 'origin', 'tmp-base:main']);
  bad.repo.git(['checkout', '-q', 'agent/feature']);
  refused(await judge(bad), /ci-proof-missing:unit \(origin\/main's \.claude\/pipeline\.yml is not a valid config/, 'broken config on base');
});

test('no deferred step -> no fetch and no lookup: an unreachable remote does not matter for a plain report', async () => {
  const s = setup({ yml: ymlWith() });
  s.repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-no-such-remote-dir')]);
  const r = await judge(s);
  accepted(r, 'plain pass');
  assert.equal(r.calls.length, 0);
});

// ---- the lookup's answers --------------------------------------------------------------------------

test('ciProof answers: pass records the run; pending / failure / missing / junk / throw each keep the gate shut with their own cause', async () => {
  const s = setup({ yml: ymlWith(), report: ciRow });
  const answer = (res) => async () => res;
  const pass = await judge(s, answer({ state: 'pass', reason: 'run 777 attempt 2 green', run: RUN }));
  accepted(pass, 'pass');
  assert.deepEqual(pass.proofs, [{ step: 'unit', source: 'ci', run: RUN }]);

  const cases = [
    ['pending', { state: 'pending', reason: 'attempt 3 is queued' }, /ci-proof-pending:unit \(attempt 3 is queued\)/],
    ['failure', { state: 'failure', reason: 'job Unit tests failed' }, /ci-proof-failed:unit \(job Unit tests failed\)/],
    ['missing', { state: 'missing', reason: 'no run for this head' }, /ci-proof-missing:unit \(no run for this head\)/],
    ['pass without a run', { state: 'pass', reason: 'ok' }, /ci-proof-missing:unit \(the CI proof lookup said pass but named no run\)/],
    ['pass with a non-object run', { state: 'pass', reason: 'ok', run: 'run-1' }, /ci-proof-missing:unit \(the CI proof lookup said pass but named no run\)/],
    ['unknown state', { state: 'success', reason: 'ok', run: RUN }, /ci-proof-missing:unit \(the CI proof lookup returned "success"\)/],
    ['no state', { reason: 'ok', run: RUN }, /ci-proof-missing:unit \(the CI proof lookup returned undefined\)/],
    ['null', null, /ci-proof-missing:unit \(the CI proof lookup returned undefined\)/],
    ['a string', 'pass', /ci-proof-missing:unit \(the CI proof lookup returned undefined\)/],
    ['missing without a reason', { state: 'missing' }, /ci-proof-missing:unit \(no reason given\)/],
  ];
  for (const [label, res, text] of cases) refused(await judge(s, answer(res)), text, label);

  refused(await judge(s, async () => { throw new Error('gh exploded\nstack'); }), /ci-proof-missing:unit \(the CI proof lookup failed: gh exploded\)/, 'throw');
  const rejected = await judge(s, () => Promise.reject(new Error('api 502')));
  refused(rejected, /the CI proof lookup failed: api 502/, 'rejection');
});

test('a CI proof does not excuse the other checks of the report: a failed step or a wrong head still refuses', async () => {
  const s = setup({ report: (r) => { ciRow(r); r.steps[2].status = 'fail'; } });
  refused(await judge(s), /lint=fail/, 'failed step');
  const stale = setup({ report: (r) => { ciRow(r); r.git.head = 'e'.repeat(40); } });
  refused(await judge(stale), /report is for/, 'other head');
});

// ---- wiring: evaluateGate, the CLI, merge ----------------------------------------------------------

async function gateFor(s, extra = {}) {
  const { config } = await loadConfig(s.repo.dir);
  const env = { ...process.env, ...s.fake.env, ...createFakeCodex().env, PIPELINE_NOTIFY: 'off', PIPELINE_MERGEABLE_PAUSE_MS: '1' };
  return evaluateGate({ root: s.repo.dir, config, pr: PR, gh: createGitHub({ cwd: s.repo.dir, env }), env, ...extra });
}

test('evaluateGate: the injected ciProof decides, the check keeps its name, and the gate JSON carries proofs', async () => {
  const s = setup({ report: ciRow });
  let seen = null;
  const gate = await gateFor(s, { ciProof: async (args) => { seen = args; return { state: 'pass', reason: 'ok', run: RUN }; } });
  assert.equal(gate.ok, true, JSON.stringify(gate.checks.filter((c) => !c.ok)));
  assert.deepEqual(gate.checks.map((c) => c.name), ['pr-open', 'labels', 'preflight', 'verify-report', 'hardstops', 'integrity', 'review', 'ci']);
  assert.deepEqual(gate.proofs, [{ step: 'unit', source: 'ci', run: RUN }]);
  assert.equal(seen.pr, PR);
  assert.equal(typeof seen.gh.prView, 'function', 'the real gh client is passed through');
  assert.equal(seen.env.PIPELINE_NOTIFY, 'off');

  // a saved gate with a proofs field still satisfies gateRefusals
  const refusals = gateRefusals({ gate: { ...gate, at: new Date().toISOString() }, pr: PR, head: gate.head, prHead: gate.head, hash: gate.contentHash, repo: gate.repo });
  assert.deepEqual(refusals, []);

  // not passing: no proofs in the gate, the cause is a detail of verify-report
  const pending = await gateFor(s, { ciProof: async () => ({ state: 'pending', reason: 'queued' }) });
  assert.equal(pending.ok, false);
  assert.deepEqual(pending.failed, ['verify-report']);
  assert.match(pending.checks.find((c) => c.name === 'verify-report').detail, /ci-proof-pending:unit/);
  assert.equal(Object.hasOwn(pending, 'proofs'), false);
});

test('evaluateGate: with the default (stub) lookup a CI deferral is ci-proof-missing; a local run records source local; no keys -> no proofs field', async () => {
  const stubbed = await gateFor(setup({ report: ciRow }));
  assert.equal(stubbed.ok, false);
  assert.deepEqual(stubbed.failed, ['verify-report']);
  assert.match(stubbed.checks.find((c) => c.name === 'verify-report').detail, /ci-proof-missing:unit \(not implemented\)/);

  const local = await gateFor(setup());
  assert.equal(local.ok, true, JSON.stringify(local.checks.filter((c) => !c.ok)));
  assert.deepEqual(local.proofs, [{ step: 'unit', source: 'local' }]);

  const legacy = await gateFor(setup({ yml: ymlFor() }));
  assert.equal(legacy.ok, true);
  assert.equal(Object.hasOwn(legacy, 'proofs'), false, 'a repo without the keys gets the gate JSON it always had');
});

test('final-gate CLI + merge: a gate with proofs is accepted by the merge command and its live re-check (same evaluation)', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  s.editGate((g) => { g.proofs = [{ step: 'unit', source: 'local' }]; });
  const r = s.merge();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
});

test('final-gate CLI: a ci deferral with the not-yet-built lookup fails verify-report with ci-proof-missing and exit 1', () => {
  const s = setup({ report: ciRow });
  const r = s.gate();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.deepEqual(r.json.failed, ['verify-report']);
  assert.match(r.json.checks.find((c) => c.name === 'verify-report').detail, /ci-proof-missing:unit/);
  assert.equal(Object.hasOwn(r.json, 'proofs'), false);
});
