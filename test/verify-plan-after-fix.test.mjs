// `pipeline verify plan-after-fix`: spawns the real CLI against throwaway git repos. The contract the ship skill relies on
// is (stdout JSON, exit code), and the diff is real git output (renames!), so nothing here is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { slotRunCommand, withOnly } from '../pipeline/commands/verify.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const ENV = { ...process.env };
delete ENV.PIPELINE_ADMIN;

function cli(cwd, args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: ENV });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json says so */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const yml = ({ full = 'node scripts/verify.mjs', afterFix = 'quick', slots } = {}) => `version: 1
project: demo
verify:
  full: ${full}
  quick: node scripts/verify.mjs --quick
  after_fix: ${afterFix}
${slots === undefined ? '' : `  max_parallel_full: ${slots}\n`}  after_fix_steps_by_path:
    "supabase/**": [db, db-grants]
    "lib/**": [db, unit]
  after_fix_never: [sql-arms]
`;

// main has the config and some files; returns the repo with HEAD at the "reviewed" commit (recorded as round 1's toHead).
function project(opts) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', yml(opts));
  repo.write('app/page.ts', 'export {};\n');
  repo.write('supabase/migrations/001.sql', 'select 1;\n');
  repo.write('lib/util.ts', 'export const u = 1;\n'.repeat(20));
  repo.commit('base');
  repo.branch('feature');
  repo.write('app/page.ts', 'export const a = 1;\n');
  const reviewed = repo.commit('reviewed work');
  return { repo, reviewed };
}

// The review state codex-review leaves behind. Written after the commits: .review/ is not part of any commit here.
function recordRound(repo, toHead, n = 1) {
  const state = addRound(emptyState({ repo: 'demo', pr: 7, branch: 'feature' }), { n, fromHead: 'x', toHead, contentHashAtToHead: 'h', items: [] });
  saveState(repo.dir, state);
}

test('withOnly: plain command gets --only; npm run gets -- inserted once, an existing -- is kept', () => {
  assert.equal(withOnly('node scripts/verify.mjs', ['db', 'db-grants']), 'node scripts/verify.mjs --only db,db-grants');
  assert.equal(withOnly('npm run verify', ['db']), 'npm run verify -- --only db');
  assert.equal(withOnly('npm run verify -- --foo', ['db']), 'npm run verify -- --foo --only db');
  assert.equal(withOnly('npm run verify --', ['db']), 'npm run verify -- --only db');
  assert.equal(withOnly('npm  run  verify', ['db']), 'npm  run  verify -- --only db');
});

test('after_fix full (the default): commands = [verify.full], round state is not needed', (t) => {
  const { repo } = project({ afterFix: 'full' });
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'full');
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs']);
  assert.deepEqual(r.json.matchedSteps, []);
  assert.equal(r.json.head, repo.git(['rev-parse', 'HEAD']).trim());
});

test('after_fix absent behaves as full', (t) => {
  const { repo } = project();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml().replace('  after_fix: quick\n', ''));
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.json.mode, 'full');
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs']);
});

test('quick, fixes touch no mapped path: the quick command only', (t) => {
  const { repo, reviewed } = project();
  t.after(() => repo.cleanup());
  repo.write('app/page.ts', 'export const a = 2;\n');
  repo.commit('fix 1');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.json.mode, 'quick');
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs --quick']);
  assert.deepEqual(r.json.matchedSteps, []);
  assert.equal(r.json.base, reviewed);
  assert.deepEqual(r.json.files, ['app/page.ts']);
});

test('quick, fixes touch mapped paths: quick, then full --only the union of their steps (deduped, stable order)', (t) => {
  const { repo, reviewed } = project();
  t.after(() => repo.cleanup());
  repo.write('supabase/migrations/002.sql', 'select 2;\n');
  repo.write('lib/util.ts', 'export const u = 2;\n');
  repo.commit('fix 1');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.matchedSteps, ['db', 'db-grants', 'unit']);
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs --quick', 'node scripts/verify.mjs --only db,db-grants,unit']);
});

test('only commits after the reviewed head count: work before it matched nothing now', (t) => {
  const { repo } = project();
  t.after(() => repo.cleanup());
  repo.write('supabase/migrations/002.sql', 'select 2;\n');
  const reviewed = repo.commit('migration, already reviewed');
  repo.write('app/page.ts', 'export const a = 3;\n');
  repo.commit('fix 1');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs --quick']);
});

test('a rename INTO a mapped path matches', (t) => {
  const { repo, reviewed } = project();
  t.after(() => repo.cleanup());
  repo.git(['mv', 'app/page.ts', 'supabase/page.ts']);
  repo.commit('move into supabase');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.files.sort(), ['app/page.ts', 'supabase/page.ts']);
  assert.deepEqual(r.json.matchedSteps, ['db', 'db-grants']);
});

test('a rename OUT OF a mapped path matches (the old side counts)', (t) => {
  const { repo, reviewed } = project();
  t.after(() => repo.cleanup());
  repo.git(['mv', 'supabase/migrations/001.sql', 'docs-001.sql']);
  repo.commit('move out of supabase');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.files.sort(), ['docs-001.sql', 'supabase/migrations/001.sql']);
  assert.deepEqual(r.json.matchedSteps, ['db', 'db-grants']);
});

test('npm run verify: the second command forwards --only after --', (t) => {
  const { repo, reviewed } = project({ full: 'npm run verify' });
  t.after(() => repo.cleanup());
  repo.write('supabase/migrations/002.sql', 'select 2;\n');
  repo.commit('fix 1');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs --quick', 'npm run verify -- --only db,db-grants']);
});

test('quick with no review state: exit 1, a clear error, no commands (fail closed)', (t) => {
  const { repo } = project();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'no-round-state');
  assert.match(r.json.message, /round 1/);
  assert.equal(r.json.commands, undefined);
});

test('quick, state exists but not for that round: exit 1', (t) => {
  const { repo, reviewed } = project();
  t.after(() => repo.cleanup());
  recordRound(repo, reviewed, 1);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '2']);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'no-round-state');
});

test('quick, the reviewed head is not an ancestor of HEAD (history rewritten): exit 1', (t) => {
  const { repo } = project();
  t.after(() => repo.cleanup());
  repo.checkout('main');
  repo.branch('other');
  repo.write('app/other.ts', 'export {};\n');
  const unrelated = repo.commit('other branch');
  repo.checkout('feature');
  recordRound(repo, unrelated);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.equal(r.json.error, 'base-not-ancestor');
});

test('usage errors: missing/zero --round, unknown subcommand exit 2', (t) => {
  const { repo } = project();
  t.after(() => repo.cleanup());
  assert.equal(cli(repo.dir, ['verify', 'plan-after-fix']).code, 2);
  assert.equal(cli(repo.dir, ['verify', 'plan-after-fix', '--round', '0']).code, 2);
  assert.equal(cli(repo.dir, ['verify', 'nope']).code, 2);
  assert.equal(cli(repo.dir, ['verify']).code, 2);
});

// verify.max_parallel_full: every full command comes back as `slot --run` (which runs verify.full itself), the quick one never.
const RUN = 'node ~/.claude/pipeline/bin/pipeline.mjs verify slot --run';

test('slotRunCommand: no steps -> plain slot --run; steps -> --only a,b', () => {
  assert.equal(slotRunCommand(), RUN);
  assert.equal(slotRunCommand([]), RUN);
  assert.equal(slotRunCommand(['db', 'db-grants']), RUN + ' --only db,db-grants');
});

test('max_parallel_full set, after_fix full: commands = [slot --run]', (t) => {
  const { repo } = project({ afterFix: 'full', slots: 2 });
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.commands, [RUN]);
});

test('max_parallel_full set, quick: the quick command stays bare, the --only full run is slot --run --only', (t) => {
  const { repo, reviewed } = project({ slots: 1 });
  t.after(() => repo.cleanup());
  repo.write('supabase/migrations/002.sql', 'select 2;\n');
  repo.commit('fix 1');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs --quick', RUN + ' --only db,db-grants']);
});

test('max_parallel_full set, quick, no mapped path: still only the bare quick command', (t) => {
  const { repo, reviewed } = project({ slots: 1 });
  t.after(() => repo.cleanup());
  repo.write('app/page.ts', 'export const a = 2;\n');
  repo.commit('fix 1');
  recordRound(repo, reviewed);
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.deepEqual(r.json.commands, ['node scripts/verify.mjs --quick']);
});

test('max_parallel_full set, no round state: the error names slot --run as the full command', (t) => {
  const { repo } = project({ slots: 1 });
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['verify', 'plan-after-fix', '--round', '1']);
  assert.equal(r.code, 1);
  assert.ok(r.json.message.includes('run the full verify (' + RUN + ')'), r.json.message);
});
