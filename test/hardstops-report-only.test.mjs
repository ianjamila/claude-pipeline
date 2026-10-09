import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, REPORT_ONLY_HARD_STOP_RULES, validateConfig } from '../pipeline/lib/config.mjs';
import { blockingHits } from '../pipeline/lib/hardstops.mjs';
import { CONFIG, project, runNode, scratchDir } from './helpers/project.mjs';
import { scenario, ymlFor, named } from './helpers/gate-env.mjs';
import { cfg, file, pkg, rulesOf, classify } from './helpers/hardstops.mjs';

// hard_stops.report_only_rules / report_only_paths: owner decision 2026-10-09, the `human-approved` label is for DATABASE
// changes only. A downgraded hit is still found and listed (advisory: true) but never blocks. Anything database-related,
// R4-pipeline and the fail-closed R0 stay blocking whatever the config says.

const ro = (rules, { paths = [], reportPaths = [], disable = [], ...rest } = {}) => {
  const c = cfg({ paths, ...rest });
  c.hard_stops = { ...c.hard_stops, disable_rules: disable, report_only_rules: rules, report_only_paths: reportPaths };
  return c;
};
const minimal = () => ({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' } });
const ALLOWED = ['R2-auth', 'R2-auth-removed', 'R3-secrets', 'R5-major-dep', 'R6-sensitive', 'P-pattern'];
const NEVER = ['R0-unscannable', 'R1-destructive', 'R1-migration-edited', 'R2-sql-removed', 'R2-sql-statement', 'R4-pipeline', 'P-path'];

// ---- config -------------------------------------------------------------------------------------------------------

test('the downgradable list is exactly the six non-database rules, frozen', () => {
  assert.deepEqual([...REPORT_ONLY_HARD_STOP_RULES], ALLOWED);
  assert.ok(Object.isFrozen(REPORT_ONLY_HARD_STOP_RULES));
});

test('defaults: nothing report-only', () => {
  assert.deepEqual(DEFAULTS.hard_stops.report_only_rules, []);
  assert.deepEqual(DEFAULTS.hard_stops.report_only_paths, []);
  const r = validateConfig(minimal());
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.deepEqual(r.config.hard_stops.report_only_rules, []);
  assert.deepEqual(r.config.hard_stops.report_only_paths, []);
});

test('config validation accepts every downgradable rule and report_only_paths', () => {
  const r = validateConfig({ ...minimal(), hard_stops: { report_only_rules: ALLOWED, report_only_paths: ['docs/**'] } });
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.deepEqual(r.config.hard_stops.report_only_rules, ALLOWED);
});

test('config validation refuses every database/pipeline rule, P-path, typos and non-arrays', () => {
  for (const rule of NEVER) {
    const r = validateConfig({ ...minimal(), hard_stops: { report_only_rules: ['R6-sensitive', rule] } });
    assert.equal(r.ok, false, rule);
    assert.ok(r.errors.some((e) => e.includes('hard_stops.report_only_rules[1]') && e.includes('cannot be report-only')), `${rule}: ${r.errors.join('; ')}`);
  }
  const cases = [
    [{ report_only_rules: ['r6-sensitive'] }, 'cannot be report-only'],
    [{ report_only_rules: [1] }, 'cannot be report-only'],
    [{ report_only_rules: 'R6-sensitive' }, 'hard_stops.report_only_rules must be an array'],
    [{ report_only_paths: 'docs/**' }, 'hard_stops.report_only_paths must be an array of strings'],
    [{ report_only_paths: [1] }, 'hard_stops.report_only_paths must be an array of strings'],
  ];
  for (const [hs, expected] of cases) {
    const r = validateConfig({ ...minimal(), hard_stops: hs });
    assert.equal(r.ok, false, JSON.stringify(hs));
    assert.ok(r.errors.some((e) => e.includes(expected)), `${JSON.stringify(hs)}: ${r.errors.join('; ')}`);
  }
});

test('a rule in both disable_rules and report_only_rules is a config error', () => {
  const r = validateConfig({ ...minimal(), hard_stops: { disable_rules: ['R6-sensitive'], report_only_rules: ['R6-sensitive'] } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('report_only_rules[0]') && e.includes('disable_rules')), r.errors.join('; '));
  const ok = validateConfig({ ...minimal(), hard_stops: { disable_rules: ['R6-sensitive'], report_only_rules: ['R3-secrets'] } });
  assert.equal(ok.ok, true, ok.errors?.join('; '));
});

// ---- classify -----------------------------------------------------------------------------------------------------

// One sample per downgradable rule: [rule, input, extra config].
const SAMPLES = [
  ['R2-auth', { files: [file('src/auth/session.ts')] }, {}],
  ['R2-auth-removed', { files: [file('lib/x.ts', { removed: ['  await requireSAScope(ctx);'] })] }, { auth_calls: ['requireSAScope'] }],
  ['R3-secrets', { files: [file('.env')] }, {}],
  ['R5-major-dep', { files: [], basePkg: pkg({ next: '15.5.15' }), headPkg: pkg({ next: '16.0.0' }) }, {}],
  ['R6-sensitive', { files: [file('lib/payroll/compute.ts')] }, {}],
  ['P-pattern', { files: [file('lib/x.ts', { added: ["import faceapi from 'faceapi';"] })] }, { patterns: [{ name: 'face', regex: 'face(api|[-_]?recog)' }] }],
];

test('default config: every sample hit blocks and carries no advisory field', () => {
  for (const [rule, input, extra] of SAMPLES) {
    const hits = classify({ ...input, config: cfg(extra) });
    assert.deepEqual(rulesOf(hits), [rule], rule);
    assert.ok(hits.every((h) => !('advisory' in h)), rule);
    assert.equal(blockingHits(hits).length, hits.length, rule);
  }
});

test('each downgradable rule becomes advisory when named, and only that rule', () => {
  for (const [rule, input, extra] of SAMPLES) {
    const hits = classify({ ...input, config: ro([rule], extra) });
    assert.deepEqual(rulesOf(hits), [rule], rule);
    assert.ok(hits.every((h) => h.advisory === true), rule);
    assert.deepEqual(blockingHits(hits), [], rule);
    // another rule's switch leaves this one blocking
    const other = ALLOWED.find((r) => r !== rule);
    const still = classify({ ...input, config: ro([other], extra) });
    assert.ok(still.every((h) => !h.advisory), `${rule} with only ${other} report-only`);
  }
});

test('with every downgradable rule report-only, database, pipeline and unscannable rules still block', () => {
  const mig = 'supabase/migrations/20261009000000_x.sql';
  const files = [
    file(mig, { status: 'A', added: ['DROP TABLE t;'] }),
    file('supabase/migrations/20200101000000_old.sql', { status: 'M', added: ['select 1;'] }),
    file('.github/workflows/ci.yml'),
    file('assets/blob.dat', { binary: true }),
    file('src/auth/session.ts'),
    file('lib/payroll/compute.ts'),
  ];
  const hits = classify({ files, sqlStatements: [{ file: mig, text: 'DROP TABLE t;' }, { file: mig, text: 'GRANT ALL ON t TO anon;' }], config: ro(ALLOWED) });
  const blocking = rulesOf(blockingHits(hits));
  for (const r of ['R0-unscannable', 'R1-destructive', 'R1-migration-edited', 'R2-sql-statement', 'R4-pipeline']) assert.ok(blocking.includes(r), `${r} must block: ${blocking}`);
  assert.ok(hits.filter((h) => h.rule === 'R2-auth' || h.rule === 'R6-sensitive').every((h) => h.advisory === true));
  assert.ok(!blocking.includes('R2-auth') && !blocking.includes('R6-sensitive'));
});

test('report_only_paths: a match is one advisory P-path hit; no match, no hit', () => {
  const c = ro([], { reportPaths: ['docs/legacy/**'] });
  const hits = classify({ files: [file('docs/legacy/a.md'), file('src/other.ts')], config: c });
  assert.deepEqual(hits.map((h) => [h.rule, h.file, h.advisory]), [['P-path', 'docs/legacy/a.md', true]]);
  assert.match(hits[0].detail, /report-only path/);
});

test('a file matching both paths and report_only_paths blocks: exactly one, blocking hit', () => {
  const c = ro([], { paths: ['lib/dtr/**'], reportPaths: ['lib/dtr/**', 'lib/**'] });
  const hits = classify({ files: [file('lib/dtr/a.ts'), file('lib/other.ts')], config: c });
  assert.deepEqual(hits.map((h) => [h.rule, h.file, Boolean(h.advisory)]), [['P-path', 'lib/dtr/a.ts', false], ['P-path', 'lib/other.ts', true]]);
});

test('report_only_paths cannot soften another rule on the same file', () => {
  const c = ro([], { reportPaths: ['.github/**'] });
  const hits = classify({ files: [file('.github/workflows/ci.yml')], config: c });
  assert.deepEqual(hits.map((h) => [h.rule, Boolean(h.advisory)]).sort(), [['P-path', true], ['R4-pipeline', false]].sort());
  assert.deepEqual(rulesOf(blockingHits(hits)), ['R4-pipeline']);
});

test('an unparseable package.json stays BLOCKING (R0-unscannable) even when R5-major-dep is report-only', () => {
  const hits = classify({ files: [], pkgPairs: [{ file: 'package.json', error: 'Unexpected token' }], config: ro(['R5-major-dep']) });
  assert.deepEqual(hits.map((h) => [h.rule, Boolean(h.advisory)]), [['R0-unscannable', false]]);
  assert.match(hits[0].detail, /could not be parsed/);
});

test('the scanner refuses a rule outside the downgradable list (fail closed, even without validateConfig)', () => {
  for (const rule of [...NEVER, 'r6-sensitive']) {
    assert.throws(() => classify({ files: [file('lib/a.ts')], config: ro([rule]) }), /cannot be report-only/, rule);
  }
  assert.throws(() => classify({ files: [file('lib/a.ts')], config: ro(['R6-sensitive'], { disable: ['R6-sensitive'] }) }), /also in hard_stops\.disable_rules/);
});

test('a disabled rule is dropped, not advisory, when report-only names a different rule', () => {
  const c = ro(['R3-secrets'], { disable: ['R6-sensitive'] });
  const hits = classify({ files: [file('lib/payroll/a.ts'), file('.env')], config: c });
  assert.deepEqual(hits.map((h) => [h.rule, h.advisory]), [['R3-secrets', true]]);
});

test('blockingHits drops advisory hits and tolerates none', () => {
  assert.deepEqual(blockingHits([]), []);
  const hits = [{ rule: 'A' }, { rule: 'B', advisory: true }, { rule: 'C', advisory: false }];
  assert.deepEqual(blockingHits(hits).map((h) => h.rule), ['A', 'C']);
});

// ---- CLI, CI guard, final gate --------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const REPORT_YML = 'hard_stops:\n  report_only_rules: [R3-secrets]\n  report_only_paths: ["src/legacy/**"]\n';
const addAdvisory = (repo) => { repo.write('src/legacy/a.js', 'export const x = 1;\n'); repo.write('.env.example', 'A=1\n'); };
const addDrop = (repo) => repo.write('supabase/migrations/20260101000000_drop.sql', 'DROP TABLE users;\n');
const addBoth = (repo) => { addAdvisory(repo); addDrop(repo); };

async function prRepo(change) {
  const repo = await project({ config: CONFIG(undefined, REPORT_YML) });
  repo.branch('pr');
  change(repo);
  repo.head = repo.commit('pr change');
  repo.checkout('main');
  return repo;
}

test('pipeline hardstops: advisory-only hits are listed and exit 0; a database hit alongside blocks with exit 1', async () => {
  const only = await prRepo(addAdvisory);
  const r = spawnSync(process.execPath, [bin, 'hardstops', '--base', 'main', '--head', 'pr'], { cwd: only.dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.approved, false);
  assert.deepEqual(j.blocking, []);
  assert.ok(j.advisory.length >= 1 && j.advisory.every((h) => h.advisory === true));
  assert.equal(j.hits.length, j.advisory.length, 'hits stays the full list');

  const mixed = await prRepo(addBoth);
  const m = spawnSync(process.execPath, [bin, 'hardstops', '--base', 'main', '--head', 'pr'], { cwd: mixed.dir, encoding: 'utf8' });
  assert.equal(m.status, 1, m.stdout + m.stderr);
  const mj = JSON.parse(m.stdout);
  assert.equal(mj.ok, false);
  assert.ok(mj.blocking.length > 0 && mj.blocking.every((h) => !h.advisory && h.rule.startsWith('R1')), JSON.stringify(mj.blocking));
  assert.ok(mj.advisory.length >= 1);
  assert.equal(mj.hits.length, mj.blocking.length + mj.advisory.length);
});

test('ci-guard hardstops: advisory-only passes without a label, says so, and lists a Report-only table', async () => {
  const repo = await prRepo(addAdvisory);
  const dir = scratchDir();
  const summary = join(dir, 'summary.md');
  const descFile = join(dir, 'desc.txt');
  const r = await runNode(['scripts/pipeline/ci-guard.mjs', '--check', 'hardstops', '--base', repo.base, '--head', repo.head, '--description-file', descFile],
    { cwd: repo.dir, env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.approved, false);
  assert.deepEqual(r.json.blocking, []);
  const n = r.json.advisory.length;
  assert.ok(n >= 1);
  assert.equal(readFileSync(descFile, 'utf8').trim(), `No blocking hard-stops (${n} report-only)`);
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /Passed: no hard-stops found\./);
  assert.match(md, /### Report-only \(no label needed\): \d+/);
  assert.match(md, /\| P-path \| src\/legacy\/a\.js \|/);
  assert.doesNotMatch(md, /Override: owner adds label/);
});

test('ci-guard hardstops: with a database hit alongside, only blocking hits are counted and the label is still asked for', async () => {
  const repo = await prRepo(addBoth);
  const dir = scratchDir();
  const summary = join(dir, 'summary.md');
  const descFile = join(dir, 'desc.txt');
  const r = await runNode(['scripts/pipeline/ci-guard.mjs', '--check', 'hardstops', '--base', repo.base, '--head', repo.head, '--description-file', descFile],
    { cwd: repo.dir, env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  const nb = r.json.blocking.length;
  assert.match(readFileSync(descFile, 'utf8'), new RegExp(`^${nb} hard-stops?: R1-`));
  const md = readFileSync(summary, 'utf8');
  assert.match(md, new RegExp(`Failed: ${nb} hard-stop\\(s\\) found`));
  assert.match(md, /Override: owner adds label `human-approved`/);
  assert.match(md, /### Report-only/);
  const approved = await runNode(['scripts/pipeline/ci-guard.mjs', '--check', 'hardstops', '--base', repo.base, '--head', repo.head, '--labels', 'human-approved'], { cwd: repo.dir });
  assert.equal(approved.code, 0);
});

test('final-gate: advisory-only hits pass the hardstops check and are counted in its detail', () => {
  const yml = `${ymlFor()}${REPORT_YML}`;
  const s = scenario({ yml, change: (r) => { r.write('src/app.js', 'export const a = 2;\n'); r.write('src/legacy/a.js', 'export const x = 1;\n'); } });
  const r = s.gate();
  const hs = named(r.json, 'hardstops');
  assert.equal(hs.ok, true, JSON.stringify(hs));
  assert.match(hs.detail, /no blocking hard-stops \(\d+ report-only\)/);
});

test('final-gate: a blocking hit still fails hardstops, and the detail mentions the report-only ones', () => {
  const yml = `${ymlFor()}${REPORT_YML}`;
  const s = scenario({ yml, change: (r) => { r.write('src/app.js', 'export const a = 2;\n'); r.write('src/legacy/a.js', 'export const x = 1;\n'); r.write('supabase/migrations/20260101000000_drop.sql', 'DROP TABLE users;\n'); } });
  const hs = named(s.gate().json, 'hardstops');
  assert.equal(hs.ok, false);
  assert.match(hs.detail, /R1-destructive/);
  assert.match(hs.detail, /\+\d+ report-only/);
});
