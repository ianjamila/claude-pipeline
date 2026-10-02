// final-gate, part 1: the happy path, the gate file's lifecycle, and the pr-open / labels / preflight / verify-report
// (tree binding) checks. See helpers/gate-env.mjs for the scenario scaffolding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { treeFingerprint } from '../pipeline/lib/git.mjs';
import { cli, scenario, ghEntries, assertOnlyFails, PR } from './helpers/gate-env.mjs';

// ---- final-gate: happy path ----------------------------------------------------------------------

test('final-gate: a fully evidenced PR passes every check and writes the gate file', () => {
  const s = scenario();
  const r = s.gate();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.checks.map((c) => c.name), ['pr-open', 'labels', 'preflight', 'verify-report', 'hardstops', 'integrity', 'review', 'ci']);
  assert.ok(r.json.checks.every((c) => c.ok), JSON.stringify(r.json.checks));
  const file = s.gateFile();
  assert.deepEqual(file, r.json);
  assert.equal(file.pr, PR);
  assert.equal(file.repo, 'acme/widgets');
  assert.equal(file.head, s.head);
  assert.equal(file.base, 'main');
  assert.equal(file.contentHash, s.hash);
  assert.equal(file.tree, treeFingerprint({ cwd: s.repo.dir }));
  assert.ok(Math.abs(Date.now() - Date.parse(file.at)) < 60_000);
  assert.ok(s.fake.lines().some((l) => /^pr checks 12 .*--required$/.test(l)), 'asks for the required checks first');
});

test('final-gate: usage errors and a bad config exit 2; a stale gate file is removed before anything else', () => {
  const s = scenario();
  assert.equal(cli(['final-gate'], { dir: s.repo.dir, fake: s.fake }).code, 2);
  assert.equal(cli(['final-gate', '--pr', 'abc'], { dir: s.repo.dir, fake: s.fake }).code, 2);
  const broken = scenario({ yml: 'version: 2\n' });
  assert.equal(broken.gate().code, 2);
});

test('final-gate: a failing run overwrites an earlier passing gate file; an unreachable GitHub (exit 3) deletes it', () => {
  const s = scenario();
  assert.equal(s.gate().code, 0);
  assert.equal(s.gateFile().ok, true);
  s.fake.setScript(ghEntries({ prHead: s.head, labels: ['needs-human'] }));
  assert.equal(s.gate().code, 1);
  assert.equal(s.gateFile().ok, false, 'the old passing evidence is gone');

  assert.equal(s.gate().code, 1);
  s.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 401' }]);
  const down = s.gate();
  assert.equal(down.code, 3);
  assert.equal(existsSync(join(s.repo.dir, '.review', 'final-gate.json')), false, 'no gate file survives a run that could not judge');
});

// ---- final-gate: pr-open --------------------------------------------------------------------------

test('final-gate: PR head that differs from the local HEAD fails pr-open', () => {
  const s = scenario({ gh: { prHead: 'd'.repeat(40) } });
  assertOnlyFails(s.gate(), 'pr-open', /is not the local HEAD/);
});

test('final-gate: a draft, a closed or conflicting PR and a non-default base each fail pr-open', () => {
  assertOnlyFails(scenario({ gh: { isDraft: true } }).gate(), 'pr-open', /draft/);
  assertOnlyFails(scenario({ gh: { state: 'MERGED' } }).gate(), 'pr-open', /MERGED/);
  assertOnlyFails(scenario({ gh: { mergeable: 'CONFLICTING' } }).gate(), 'pr-open', /conflicts/);
  assertOnlyFails(scenario({ gh: { base: 'release' } }).gate(), 'pr-open', /base/);
  const unknown = scenario({ gh: { mergeable: 'UNKNOWN' } }).gate();
  assert.equal(unknown.code, 0, 'UNKNOWN means GitHub is still computing it, which is not a conflict');
});

// ---- final-gate: labels, preflight ----------------------------------------------------------------

test('final-gate: each blocking label fails the labels check', () => {
  for (const label of ['needs-human', 'awaiting-review', 'pipeline-blocked']) {
    assertOnlyFails(scenario({ gh: { labels: ['bug', label] } }).gate(), 'labels', new RegExp(label));
  }
});

test('final-gate: an open pause issue fails the preflight check (and only it)', () => {
  const s = scenario({ gh: { pause: [{ number: 3, title: 'pause', url: 'u' }] } });
  assertOnlyFails(s.gate(), 'preflight', /pipeline-pause issue #3 is open/);
});

test('final-gate: an open pipeline-rollback issue fails the preflight check (and only it)', () => {
  const s = scenario({ gh: { rollback: [{ number: 8, title: 'rollback', url: 'u' }] } });
  assertOnlyFails(s.gate(), 'preflight', /pipeline-rollback issue #8 is open/);
});

test('final-gate: PIPELINE_OFF=1 fails the preflight check', () => {
  assertOnlyFails(scenario({ env: { PIPELINE_OFF: '1' } }).gate(), 'preflight', /PIPELINE_OFF/);
});

// ---- final-gate: verify-report --------------------------------------------------------------------

test('final-gate: no verify report at all fails verify-report', () => {
  assertOnlyFails(scenario({ report: null }).gate(), 'verify-report', /no usable verify report/);
});

test('final-gate: a tree that changed after verify ran fails verify-report', () => {
  const s = scenario({ afterReport: (repo) => repo.write('src/unverified.js', 'export const sneaky = true;\n') });
  assertOnlyFails(s.gate(), 'verify-report', /tree changed since verify/);
});

test('final-gate: the spec spelling git.treeHash is accepted for the tree binding', () => {
  const s = scenario({ report: (r) => { r.git.treeHash = r.git.tree; delete r.git.tree; } });
  assert.equal(s.gate().code, 0);
});

