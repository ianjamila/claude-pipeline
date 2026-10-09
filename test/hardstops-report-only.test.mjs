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
// R4-pipeline (the guard core) and the fail-closed R0 stay blocking whatever the config says. Owner decision 2026-10-09: app
// code that deletes rows (R1-data-write) and agent-instruction / local build config (R4-config) are routine and may be advisory.

const ro = (rules, { paths = [], reportPaths = [], disable = [], ...rest } = {}) => {
  const c = cfg({ paths, ...rest });
  c.hard_stops = { ...c.hard_stops, disable_rules: disable, report_only_rules: rules, report_only_paths: reportPaths };
  return c;
};
const minimal = () => ({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' } });
const ALLOWED = ['R1-data-write', 'R2-auth', 'R2-auth-removed', 'R3-secrets', 'R4-config', 'R5-major-dep', 'R6-sensitive', 'P-pattern'];
const NEVER = ['R0-unscannable', 'R1-destructive', 'R1-migration-edited', 'R2-sql-removed', 'R2-sql-statement', 'R4-pipeline', 'P-path'];

// ---- config -------------------------------------------------------------------------------------------------------

test('the downgradable list is exactly the eight non-database, non-guard-core rules, frozen', () => {
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
  ['R1-data-write', { files: [file('lib/x.ts', { added: ["await sb.from('t').delete().eq('id', 1);"] })] }, {}],
  ['R2-auth', { files: [file('src/auth/session.ts')] }, {}],
  ['R2-auth-removed', { files: [file('lib/x.ts', { removed: ['  await requireSAScope(ctx);'] })] }, { auth_calls: ['requireSAScope'] }],
  ['R3-secrets', { files: [file('.env')] }, {}],
  ['R4-config', { files: [file('CLAUDE.md', { added: ['be nice'] })] }, {}],
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

// ---- owner decision 2026-10-09: R1-data-write and the R4 split ---------------------------------------------------------

// Every example of every glob the single R4 list had before the split. The split must not lose any of them.
const OLD_R4_EXAMPLES = [
  '.github/workflows/ci.yml', '.claude/settings.json', '.githooks/pre-push', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/CODEOWNERS',
  'CLAUDE.md', 'sub/dir/CLAUDE.md', 'AGENTS.md', 'pkg/AGENTS.md', '.cursorrules', 'a/.cursorrules', '.github/copilot-instructions.md',
  '.gitmodules', 'vendor/.gitmodules', 'scripts/verify', 'scripts/verify.mjs', 'scripts/verify-quick.mjs', 'scripts/verify/index.mjs',
  'scripts/verify-all', 'scripts/pipeline/ci-guard.mjs', 'pipeline.yml', 'x/pipeline.yml', '.claude/pipeline.yml', 'vitest.config.ts',
  'apps/web/vitest.config.ts', 'vitest.workspace.ts', 'jest.config.js', 'playwright.config.ts', 'playwright.ci.config.ts', '.nycrc',
  '.nycrc.json', 'codecov.yml', 'codecov.yaml', '.husky/pre-commit', 'vitest.setup.ts', 'jest.setup.js', 'cypress.config.ts', '.mocharc.json',
  'eslint.config.mjs', '.eslintrc.json', 'lefthook.yml', 'lefthook-local.yaml', '.pre-commit-config.yaml', '.pre-commit-config.yml',
  '.gitattributes', 'apps/web/.gitattributes', 'next.config.ts', 'next.config.mjs', 'apps/web/vite.config.ts', 'tsconfig.json',
  'tsconfig.build.json', 'packages/x/tsconfig.base.json', 'NEXT.CONFIG.TS',
];
// The guard core: files that decide whether a label is needed or which checks CI runs.
const CORE_EXAMPLES = [
  '.github/workflows/ci.yml', '.github/dependabot.yml', '.github/CODEOWNERS', '.claude/settings.json', '.claude/pipeline.yml', 'CODEOWNERS',
  'docs/CODEOWNERS', '.gitmodules', 'vendor/.gitmodules', 'scripts/pipeline/ci-guard.mjs', 'pipeline.yml', 'x/pipeline.yml',
  'vitest.config.ts', 'apps/web/vitest.config.ts', 'vitest.workspace.ts', 'vitest.setup.ts', 'jest.config.js', 'jest.setup.js',
  'playwright.config.ts', 'playwright.ci.config.ts', 'cypress.config.ts', '.mocharc.json', '.nycrc', '.nycrc.json', 'codecov.yml', 'codecov.yaml',
  // read by the CI check commands (test:run, typecheck, lint, build, verify:sql-arms)
  'scripts/verify', 'scripts/verify.mjs', 'scripts/verify-quick.mjs', 'scripts/verify/index.mjs', 'scripts/verify-all', 'scripts/verify-sql-arms.mjs',
  'eslint.config.mjs', '.eslintrc.json', 'tsconfig.json', 'tsconfig.build.json', 'packages/x/tsconfig.base.json', 'next.config.ts', 'next.config.mjs',
  'NEXT.CONFIG.TS', 'apps/web/vite.config.ts', '.gitattributes', 'apps/web/.gitattributes',
];
const CONFIG_EXAMPLES = [
  'CLAUDE.md', 'sub/dir/CLAUDE.md', 'AGENTS.md', 'pkg/AGENTS.md', '.cursorrules', 'a/.cursorrules', '.github/copilot-instructions.md',
  '.github/workflows/README.md', '.github/PULL_REQUEST_TEMPLATE.md', '.githooks/pre-push', '.husky/pre-commit', 'lefthook.yml', 'lefthook-local.yaml',
  '.pre-commit-config.yaml', '.pre-commit-config.yml',
];
const r4Of = (p) => classify({ files: [file(p)], config: cfg() }).filter((h) => h.rule.startsWith('R4-'));

test('R4 split: every path the old single R4 list matched still hits exactly one R4 rule (no coverage loss)', () => {
  for (const p of OLD_R4_EXAMPLES) {
    const hits = r4Of(p);
    assert.equal(hits.length, 1, `${p}: ${JSON.stringify(hits.map((h) => h.rule))}`);
  }
  for (const p of OLD_R4_EXAMPLES) assert.ok(CORE_EXAMPLES.includes(p) || CONFIG_EXAMPLES.includes(p), `${p} is in neither expected list`);
});

test('R4 split: the guard core is R4-pipeline, everything else steering the build or agents is R4-config', () => {
  for (const p of CORE_EXAMPLES) assert.deepEqual(r4Of(p).map((h) => h.rule), ['R4-pipeline'], p);
  for (const p of CONFIG_EXAMPLES) assert.deepEqual(r4Of(p).map((h) => h.rule), ['R4-config'], p);
  assert.deepEqual(r4Of('src/app.ts'), []);
});

test('R4 split: a rename with one core and one config path is a single R4-pipeline hit (core wins)', () => {
  const hits = classify({ files: [file('.github/workflows/ci.yml', { status: 'R', oldPath: '.github/workflows/README.md' })], config: cfg() });
  assert.deepEqual(hits.filter((h) => h.rule.startsWith('R4-')).map((h) => h.rule), ['R4-pipeline']);
});

test('R4-config report-only: instruction/config files stop blocking; every guard-core file keeps blocking', () => {
  const c = ro(['R4-config']);
  for (const p of CONFIG_EXAMPLES) {
    const hits = classify({ files: [file(p)], config: c });
    assert.ok(hits.length >= 1 && hits.every((h) => h.advisory === true), p);
    assert.deepEqual(blockingHits(hits), [], p);
  }
  for (const p of CORE_EXAMPLES) {
    const blocking = classify({ files: [file(p)], config: c }).filter((h) => !h.advisory);
    assert.deepEqual(rulesOf(blocking), ['R4-pipeline'], p);
  }
});

test('R4-config report-only: a NEW package.json script is advisory; a changed/removed script, lifecycle hook, gate blocks, packageManager and gitlink/symlink/pgTAP stay blocking', () => {
  const c = ro(['R4-config']);
  const base = { scripts: { test: 'vitest run' } };
  const pkgHits = (head, b = base) => classify({ files: [], pkgPairs: [{ file: 'package.json', base: b, head }], config: c });
  const added = pkgHits({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' } });
  assert.deepEqual(added.map((h) => [h.rule, h.advisory]), [['R4-config', true]]);
  assert.deepEqual(blockingHits(added), []);
  assert.deepEqual(pkgHits({ scripts: { test: 'vitest run', 'lint:date-math': 'node x.mjs' } }).map((h) => [h.rule, h.advisory]), [['R4-config', true]]);
  const changed = pkgHits({ scripts: { test: 'true' } });
  assert.deepEqual(changed.map((h) => [h.rule, Boolean(h.advisory)]), [['R4-pipeline', false]]);
  assert.match(changed[0].detail, /changed/);
  const removed = pkgHits({ scripts: {} });
  assert.deepEqual(removed.map((h) => [h.rule, Boolean(h.advisory)]), [['R4-pipeline', false]]);
  assert.match(removed[0].detail, /removed/);
  for (const name of ['pretest', 'pretest:run', 'posttest', 'prebuild', 'postinstall', 'preinstall', 'install', 'prepare', 'preprepare', 'postprepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'dependencies', 'pregenerate']) {
    assert.deepEqual(pkgHits({ scripts: { test: 'vitest run', [name]: 'x' } }).map((h) => [h.rule, Boolean(h.advisory)]), [['R4-pipeline', false]], name);
  }
  for (const head of [{ ...base, husky: { hooks: {} } }, { ...base, packageManager: 'pnpm@9.0.0' }]) {
    const hits = classify({ files: [], pkgPairs: [{ file: 'package.json', base, head }], config: c });
    assert.deepEqual(hits.map((h) => [h.rule, Boolean(h.advisory)]), [['R4-pipeline', false]], JSON.stringify(head));
  }
  const file2 = (p, o) => ({ ...file(p), ...o });
  for (const f of [file2('deps/sub', { gitlink: true }), file2('src/a.js', { symlink: true }), file('supabase/tests/rls.test.sql', { status: 'D' })]) {
    const hits = classify({ files: [f], config: c });
    assert.ok(hits.some((h) => h.rule === 'R4-pipeline' && !h.advisory), f.path);
  }
});

test('R1-data-write report-only: .from(...).delete/upsert is advisory; raw destructive SQL, SQL in code and migrations stay R1-destructive', () => {
  const c = ro(['R1-data-write']);
  for (const text of ["await sb.from('t').delete().neq('id', 0);", "await sb.from('t').upsert(rows);"]) {
    const hits = classify({ files: [file('app/x.ts', { added: [text] })], config: c });
    assert.deepEqual(hits.map((h) => [h.rule, h.advisory]), [['R1-data-write', true]], text);
  }
  const sqlInCode = classify({ files: [file('app/x.ts', { added: ["await db.query('DROP TABLE users');"] })], config: c });
  assert.ok(sqlInCode.some((h) => h.rule === 'R1-destructive' && !h.advisory), JSON.stringify(sqlInCode));
  const mig = 'supabase/migrations/20261009000000_x.sql';
  const sql = classify({ files: [file(mig, { status: 'A', added: ['DROP TABLE t;'] })], sqlStatements: [{ file: mig, text: 'DROP TABLE t;' }], config: ro(ALLOWED) });
  assert.ok(sql.filter((h) => h.rule === 'R1-destructive').length >= 1 && sql.filter((h) => h.rule === 'R1-destructive').every((h) => !h.advisory));
  // default config: the data-write hit blocks and carries the new rule id
  assert.deepEqual(rulesOf(classify({ files: [file('app/x.ts', { added: ["await sb.from('t').delete();"] })], config: cfg() })), ['R1-data-write']);
});

test('the guard core can never be named report-only, in validateConfig or in the scanner', () => {
  const r = validateConfig({ ...minimal(), hard_stops: { report_only_rules: ['R4-pipeline'] } });
  assert.equal(r.ok, false);
  assert.throws(() => classify({ files: [file('lib/a.ts')], config: ro(['R4-pipeline']) }), /cannot be report-only/);
});
