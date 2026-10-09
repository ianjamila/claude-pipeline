import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockingHits, ownerMergeHits } from '../pipeline/lib/hardstops.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { checkIntegrity } from '../pipeline/lib/integrity.mjs';
import { CONFIG, project, runNode, scratchDir } from './helpers/project.mjs';
import { scenario, ymlFor, named } from './helpers/gate-env.mjs';
import { cfg, file, run } from './helpers/hardstops.mjs';

// owner_approval: chat (owner decision 2026-10-09): no approval labels. A hit that would block (or a test-integrity
// violation) no longer fails CI; it is listed as an owner-merge item and the ship skill asks the owner in chat before merging.

const chatCfg = (over = {}) => ({ ...cfg(over), owner_approval: 'chat' });
const withReportPaths = (c, reportPaths) => ({ ...c, hard_stops: { ...c.hard_stops, report_only_paths: reportPaths } });
const classes = (hits) => hits.map((h) => `${h.rule} ${h.file} advisory=${h.advisory === true} ownerMerge=${h.ownerMerge === true}`);

// ---- classifier -------------------------------------------------------------------------------------------------------

const FILES = [file('src/pay/a.js', { status: 'A', added: ['x'] }), file('src/legacy/b.js', { status: 'A', added: ['x'] })];

test('chat mode: a would-be-blocking hit becomes advisory + ownerMerge; a report-only hit stays plain advisory', () => {
  const config = withReportPaths(chatCfg({ paths: ['src/pay/**'] }), ['src/legacy/**']);
  const hits = run(FILES, { config });
  assert.deepEqual(classes(hits), [
    'P-path src/pay/a.js advisory=true ownerMerge=true',
    'P-path src/legacy/b.js advisory=true ownerMerge=false',
  ]);
  assert.deepEqual(blockingHits(hits), []);
  assert.deepEqual(ownerMergeHits(hits).map((h) => h.file), ['src/pay/a.js']);
});

test('chat mode: a rule listed in report_only_rules stays plain advisory, never ownerMerge', () => {
  const config = chatCfg({ paths: [] });
  config.hard_stops.report_only_rules = ['R3-secrets'];
  const hits = run([file('.env', { status: 'A', added: ['A=1'] })], { config });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.advisory === true && h.ownerMerge === undefined), JSON.stringify(hits));
  assert.deepEqual(ownerMergeHits(hits), []);
});

test('label mode (default) is unchanged: the same hit blocks and carries no ownerMerge', () => {
  const config = withReportPaths(cfg({ paths: ['src/pay/**'] }), ['src/legacy/**']);
  const hits = run(FILES, { config });
  assert.deepEqual(classes(hits), [
    'P-path src/pay/a.js advisory=false ownerMerge=false',
    'P-path src/legacy/b.js advisory=true ownerMerge=false',
  ]);
  assert.equal(blockingHits(hits).length, 1);
  assert.deepEqual(ownerMergeHits(hits), []);
  assert.deepEqual(classes(run(FILES, { config: { ...config, owner_approval: 'label' } })), classes(hits));
});

// ---- integrity --------------------------------------------------------------------------------------------------------

const icfg = (over = {}) => ({ integrity: { test_globs: DEFAULTS.integrity.test_globs }, ...over });
const deletedTest = [{ oldPath: 'a.test.ts', newPath: null, path: 'a.test.ts', status: 'D', similarity: null, binary: false, added: [], removed: [{ line: 1, text: 'x' }] }];

test('integrity chat mode: violations do not fail but are listed (violations + ownerMerge)', () => {
  const r = checkIntegrity({ files: deletedTest, config: icfg({ owner_approval: 'chat' }) });
  assert.equal(r.ok, true);
  assert.equal(r.overridden, false);
  assert.deepEqual(r.violations.map((v) => v.rule), ['test-deleted']);
  assert.deepEqual(r.ownerMerge, r.violations);
  const clean = checkIntegrity({ files: [], config: icfg({ owner_approval: 'chat' }) });
  assert.deepEqual(clean, { ok: true, overridden: false, violations: [], ownerMerge: [] });
});

test('integrity label mode is unchanged: the violation fails and there is no ownerMerge key', () => {
  for (const config of [icfg(), icfg({ owner_approval: 'label' })]) {
    const r = checkIntegrity({ files: deletedTest, config });
    assert.equal(r.ok, false);
    assert.equal('ownerMerge' in r, false);
  }
});

// ---- CLI, CI guard ----------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const REPORT_PATHS = 'hard_stops:\n  report_only_paths: ["src/legacy/**"]\n';

async function prRepo(owner, change) {
  const extra = `${owner ? `owner_approval: ${owner}\n` : ''}${REPORT_PATHS}`;
  const repo = await project({ config: CONFIG(undefined, extra) });
  repo.branch('pr');
  change(repo);
  repo.head = repo.commit('pr change');
  repo.checkout('main');
  return repo;
}
const dropAndLegacy = (repo) => {
  repo.write('supabase/migrations/20260101000000_drop.sql', 'DROP TABLE users;\n');
  repo.write('src/legacy/a.js', 'export const x = 1;\n');
};
const weakenTest = (repo) => repo.write('test/app.test.js', "import { test } from 'node:test';\ntest.skip('a', () => {});\n");
const pipeline = (repo, args) => spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, encoding: 'utf8' });

test('pipeline hardstops (chat): exit 0, blocking empty, the database hit is advisory + ownerMerge, the report-only hit is not', async () => {
  const repo = await prRepo('chat', dropAndLegacy);
  const r = pipeline(repo, ['hardstops', '--base', 'main', '--head', 'pr']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.deepEqual(j.blocking, []);
  assert.ok(j.ownerMerge.length >= 1 && j.ownerMerge.every((h) => h.advisory && h.ownerMerge && h.rule.startsWith('R1')), JSON.stringify(j.ownerMerge));
  assert.ok(j.advisory.some((h) => h.rule === 'P-path' && !h.ownerMerge));
  assert.equal(j.hits.length, j.advisory.length, 'hits stays the full list');
});

test('pipeline hardstops (label, the default): the same change still exits 1 with ownerMerge empty', async () => {
  const repo = await prRepo(null, dropAndLegacy);
  const r = pipeline(repo, ['hardstops', '--base', 'main', '--head', 'pr']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.blocking.length > 0);
  assert.deepEqual(j.ownerMerge, []);
});

test('pipeline integrity (chat): exit 0 with the violation under ownerMerge; label mode still exits 1', async () => {
  const chat = await prRepo('chat', weakenTest);
  const r = pipeline(chat, ['integrity', '--base', 'main', '--head', 'pr']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.ok(j.violations.length >= 1);
  assert.deepEqual(j.ownerMerge, j.violations);
  const label = await prRepo(null, weakenTest);
  assert.equal(pipeline(label, ['integrity', '--base', 'main', '--head', 'pr']).status, 1);
});

async function guard(repo, check) {
  const dir = scratchDir();
  const summary = join(dir, 'summary.md');
  const descFile = join(dir, 'desc.txt');
  const r = await runNode(['scripts/pipeline/ci-guard.mjs', '--check', check, '--base', repo.base, '--head', repo.head, '--description-file', descFile],
    { cwd: repo.dir, env: { GITHUB_STEP_SUMMARY: summary } });
  return { r, md: readFileSync(summary, 'utf8'), desc: readFileSync(descFile, 'utf8').trim() };
}

test('ci-guard hardstops (chat): passes without a label, counts owner-merge and report-only, lists an Owner merges table', async () => {
  const repo = await prRepo('chat', dropAndLegacy);
  const { r, md, desc } = await guard(repo, 'hardstops');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.blocking, []);
  const nOwner = r.json.ownerMerge.length;
  assert.ok(nOwner >= 1);
  assert.equal(desc, `No blocking hard-stops (${nOwner} owner-merge, 1 report-only)`);
  assert.match(md, new RegExp(`### Owner merges in chat \\(no label\\): ${nOwner}`));
  assert.match(md, /\| R1-[a-z-]+ \| supabase\/migrations\/20260101000000_drop\.sql \|/);
  assert.match(md, /### Report-only \(no label needed\): 1/);
  assert.match(md, /Passed: no label needed/);
  assert.doesNotMatch(md, /Failed|Override: owner adds label/);
});

test('ci-guard hardstops (label, the default): the same change still fails and asks for the label', async () => {
  const repo = await prRepo(null, dropAndLegacy);
  const { r, md } = await guard(repo, 'hardstops');
  assert.equal(r.code, 1);
  assert.match(md, /Override: owner adds label `human-approved`/);
  assert.doesNotMatch(md, /Owner merges in chat/);
});

test('ci-guard integrity (chat): passes, with an Owner merges table instead of a failure', async () => {
  const repo = await prRepo('chat', weakenTest);
  const { r, md, desc } = await guard(repo, 'integrity');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  const n = r.json.ownerMerge.length;
  assert.ok(n >= 1);
  assert.equal(desc, `No blocking test-integrity violations (${n} owner-merge)`);
  assert.match(md, new RegExp(`### Owner merges in chat \\(no label\\): ${n}`));
  assert.match(md, /skip-or-only-added/);
  assert.doesNotMatch(md, /Failed|Override: owner adds label/);
});

test('ci-guard integrity (label, the default): the same change still fails', async () => {
  const repo = await prRepo(null, weakenTest);
  const { r, md } = await guard(repo, 'integrity');
  assert.equal(r.code, 1);
  assert.match(md, /Override: owner adds label `test-change-approved`/);
});

// ---- final gate -------------------------------------------------------------------------------------------------------

const CHAT_YML = `${ymlFor()}owner_approval: chat\n`;
const bumpAndEnv = (r) => { r.write('src/app.js', 'export const a = 2;\n'); r.write('.env', 'SECRET=1\n'); };
const bumpAndDeleteTest = (r) => { r.write('src/app.js', 'export const a = 2;\n'); r.rm('test/app.test.js'); };

test('final-gate (chat): a hard-stop hit passes hardstops and is counted in the gate output', () => {
  const r = scenario({ yml: CHAT_YML, change: bumpAndEnv }).gate();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.ok, true);
  const hs = named(r.json, 'hardstops');
  assert.equal(hs.ok, true);
  assert.match(hs.detail, /no blocking hard-stops \(\d+ owner-merge, 0 report-only\)/);
  assert.ok(hs.ownerMerge >= 1);
  assert.equal(r.json.ownerMerge, hs.ownerMerge);
});

test('final-gate (chat): a test-integrity violation passes integrity and is counted', () => {
  const r = scenario({ yml: CHAT_YML, change: bumpAndDeleteTest }).gate();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const ig = named(r.json, 'integrity');
  assert.equal(ig.ok, true);
  assert.match(ig.detail, /owner-merge test-integrity violation/);
  assert.equal(r.json.ownerMerge, ig.ownerMerge);
  assert.ok(r.json.ownerMerge >= 1);
});

test('final-gate (chat): an ordinary change reports ownerMerge 0 and no per-check counts', () => {
  const r = scenario({ yml: CHAT_YML }).gate();
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.ownerMerge, 0);
  assert.ok(r.json.checks.every((c) => c.ownerMerge === undefined));
});

test('final-gate (label, the default): the same changes still fail and report ownerMerge 0', () => {
  const hs = scenario({ change: bumpAndEnv }).gate();
  assert.equal(hs.code, 1);
  assert.deepEqual(hs.json.failed, ['hardstops']);
  assert.equal(hs.json.ownerMerge, 0);
  const ig = scenario({ change: bumpAndDeleteTest }).gate();
  assert.deepEqual(ig.json.failed, ['integrity']);
});
