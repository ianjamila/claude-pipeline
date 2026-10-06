// End-to-end tests for the local pipeline commands (config, risk, hardstops, integrity, model-proof, job).
// They spawn the real CLI against real throwaway git repos, because the contract skills depend on is the pair
// (stdout JSON, exit code): a unit test of the command module would not prove either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, realpathSync, readFileSync, utimesSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { quoteCommand } from '../pipeline/commands/job.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fixtures = join(here, 'fixtures');

// PIPELINE_ADMIN would switch the file guard off and make the "refused" cases pass or fail by accident.
const ENV = { ...process.env };
delete ENV.PIPELINE_ADMIN;

function cli(cwd, args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: ENV });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null: the assertion on json will say so */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// A repo with a valid pipeline.yml and a few files on main. Returns the repo and helpers to branch off it.
function project(extra = {}) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', readFileSync(join(fixtures, 'pipeline-valid.yml'), 'utf8'));
  repo.write('src/components/Button.tsx', 'export const Button = () => null;\n');
  repo.write('src/math.test.js', "import assert from 'node:assert';\nassert.equal(1 + 1, 2);\n");
  for (const [rel, content] of Object.entries(extra)) repo.write(rel, content);
  repo.commit('base');
  return repo;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------------------------

test('config: a valid repo prints the filled-in config, exit 0', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['config']);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.config.project, 'demo-app');
  assert.equal(r.json.config.default_branch, 'main'); // a default filled in
  assert.equal(r.json.path, join(repo.dir, '.claude', 'pipeline.yml'));
});

test('config: required_checks that omit the guard contexts print a warning but still exit 0', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['config']);
  assertExit(r, 0);
  assert.match(r.json.warnings.join('\n'), /Test integrity/);
  assert.equal(r.json.config.ci.guard_checks, true);
});

test('config: missing pipeline.yml is exit 2 with error "config"', (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('README.md', 'x\n');
  repo.commit('base');
  const r = cli(repo.dir, ['config']);
  assertExit(r, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'config');
  assert.match(r.json.errors.join('\n'), /missing \.claude\/pipeline\.yml/);
});

test('config: an invalid pipeline.yml is exit 2 and lists the errors', (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', 'version: 1\nbogus_key: 1\n');
  repo.commit('base');
  const r = cli(repo.dir, ['config']);
  assertExit(r, 2);
  assert.equal(r.json.error, 'config');
  assert.ok(r.json.errors.length > 0);
});

test('config: resolves the repo root from a subdirectory and from --repo', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const fromSub = cli(join(repo.dir, 'src'), ['config']);
  assertExit(fromSub, 0);
  assert.equal(fromSub.json.path, join(repo.dir, '.claude', 'pipeline.yml'));
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const viaFlag = cli(elsewhere, ['config', '--repo', repo.dir]);
  assertExit(viaFlag, 0);
  assert.equal(viaFlag.json.config.project, 'demo-app');
});

test('config: a directory that is not a git repository is exit 2, not a stack trace', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-norepo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = cli(dir, ['config']);
  assertExit(r, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'repo');
  const gone = cli(dir, ['config', '--repo', join(dir, 'does-not-exist')]);
  assertExit(gone, 2);
  assert.equal(gone.json.error, 'repo');
});

test('config: unknown flag and stray positional are usage errors', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  assertExit(cli(repo.dir, ['config', '--bogus']), 2);
  assertExit(cli(repo.dir, ['config', 'extra']), 2);
});

// ---------------------------------------------------------------------------------------------------------------
// risk / hardstops / integrity
// ---------------------------------------------------------------------------------------------------------------

test('risk: a migration with DROP TABLE is high risk and reports the R1 hard-stop', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const base = repo.git(['rev-parse', 'HEAD']).trim();
  repo.branch('feat');
  repo.write('supabase/migrations/2_x.sql', 'DROP TABLE t;\n');
  const head = repo.commit('drop it');
  const r = cli(repo.dir, ['risk', '--base', 'main', '--head', 'feat']);
  assertExit(r, 0); // risk is a report: it never fails on a finding
  assert.equal(r.json.ok, true);
  assert.equal(r.json.level, 'high');
  assert.equal(r.json.lightLane, false);
  assert.ok(r.json.hardStops.some((h) => h.rule.startsWith('R1')), JSON.stringify(r.json.hardStops));
  assert.match(r.json.reasons.join(' '), /hard-stop/);
  assert.equal(r.json.base, 'main');
  assert.equal(r.json.head, 'feat');
  assert.equal(r.json.mergeBase, base);
  assert.equal(r.json.fileCount, 1);
  assert.equal(r.json.changedLines, 1);
  assert.notEqual(head, base);
});

test('risk: a small UI change is low risk and qualifies for the light lane', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  repo.branch('feat');
  repo.write('src/components/Button.tsx', 'export const Button = () => "hi";\n');
  repo.commit('tweak');
  const r = cli(repo.dir, ['risk', '--base', 'main', '--head', 'feat']);
  assertExit(r, 0);
  assert.equal(r.json.level, 'low');
  assert.equal(r.json.lightLane, true);
  assert.deepEqual(r.json.hardStops, []);
});

test('risk: needs config, --base and --head; a bad ref is exit 2', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  repo.branch('feat');
  repo.write('src/a.ts', 'x\n');
  repo.commit('a');
  assertExit(cli(repo.dir, ['risk', '--head', 'feat']), 2);
  assertExit(cli(repo.dir, ['risk', '--base', 'main']), 2);
  const bad = cli(repo.dir, ['risk', '--base', 'main', '--head', 'no-such-branch']);
  assertExit(bad, 2);
  assert.equal(bad.json.ok, false);
  const flagLike = cli(repo.dir, ['risk', '--base', 'main', '--head=--output=/tmp/x']);
  assertExit(flagLike, 2);

  const noConfig = createTmpRepo();
  t.after(() => noConfig.cleanup());
  noConfig.write('a.txt', 'a\n');
  noConfig.commit('base');
  noConfig.branch('feat');
  noConfig.write('a.txt', 'b\n');
  noConfig.commit('b');
  const r = cli(noConfig.dir, ['risk', '--base', 'main', '--head', 'feat']);
  assertExit(r, 2);
  assert.equal(r.json.error, 'config');
});

function dropMigrationBranch() {
  const repo = project();
  repo.branch('feat');
  repo.write('supabase/migrations/2_x.sql', 'DROP TABLE t;\n');
  repo.commit('drop it');
  return repo;
}

test('hardstops: a migration DROP is exit 1 with the hits listed', (t) => {
  const repo = dropMigrationBranch();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'feat']);
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.approved, false);
  assert.ok(r.json.hits.some((h) => h.rule.startsWith('R1')));
});

test('hardstops: the human-approved label turns exit 1 into exit 0 but still lists the hits', (t) => {
  const repo = dropMigrationBranch();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'feat', '--labels', 'human-approved']);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.approved, true);
  assert.ok(r.json.hits.length > 0);
  // whitespace around names is tolerated; a different approval label does not count
  assertExit(cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'feat', '--labels', 'needs-human, human-approved']), 0);
  assertExit(cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'feat', '--labels', 'test-change-approved']), 1);
  assertExit(cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'feat', '--labels', '']), 1);
});

test('hardstops: a clean change is exit 0, approved false', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  repo.branch('feat');
  repo.write('src/components/Button.tsx', 'export const Button = () => "hi";\n');
  repo.commit('tweak');
  const r = cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'feat']);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.approved, false);
  assert.deepEqual(r.json.hits, []);
});

test('hardstops: a bad ref fails closed (exit 2), never exit 0', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['hardstops', '--base', 'main', '--head', 'nope']);
  assertExit(r, 2);
  assertExit(cli(repo.dir, ['hardstops', '--base', 'main']), 2);
});

function deleteTestBranch() {
  const repo = project();
  repo.branch('feat');
  repo.rm('src/math.test.js');
  repo.commit('remove the failing test');
  return repo;
}

test('integrity: a deleted test file is exit 1 with the violation', (t) => {
  const repo = deleteTestBranch();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['integrity', '--base', 'main', '--head', 'feat']);
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.overridden, false);
  assert.equal(r.json.violations[0].rule, 'test-deleted');
  assert.equal(r.json.base, 'main');
  assert.equal(r.json.head, 'feat');
});

test('integrity: test-change-approved overrides, human-approved does not', (t) => {
  const repo = deleteTestBranch();
  t.after(() => repo.cleanup());
  const ok = cli(repo.dir, ['integrity', '--base', 'main', '--head', 'feat', '--labels', 'test-change-approved']);
  assertExit(ok, 0);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.overridden, true);
  assertExit(cli(repo.dir, ['integrity', '--base', 'main', '--head', 'feat', '--labels', 'human-approved']), 1);
});

test('integrity: a change that touches no tests is exit 0; no config is exit 2', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  repo.branch('feat');
  repo.write('src/components/Button.tsx', 'export const Button = () => "hi";\n');
  repo.commit('tweak');
  const r = cli(repo.dir, ['integrity', '--base', 'main', '--head', 'feat']);
  assertExit(r, 0);
  assert.deepEqual(r.json.violations, []);

  const bare = createTmpRepo();
  t.after(() => bare.cleanup());
  bare.write('a.txt', 'a\n');
  bare.commit('base');
  bare.branch('feat');
  bare.write('a.txt', 'b\n');
  bare.commit('b');
  const noConfig = cli(bare.dir, ['integrity', '--base', 'main', '--head', 'feat']);
  assertExit(noConfig, 2);
  assert.equal(noConfig.json.error, 'config');
});

// ---------------------------------------------------------------------------------------------------------------
// model-proof
// ---------------------------------------------------------------------------------------------------------------

const TAG = 'pipeline-arbiter R1 abcd1234';

// <tmp>/p/<encoded-cwd>/<session>/subagents/agent-<id>.{jsonl,meta.json}: the layout Claude Code writes.
function projectsDir(t, { jsonl = 'fable-ok.jsonl', meta = {}, agentId = 'a1' } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-proof-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'p', '-tmp-work', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(fixtures, 'transcripts', jsonl), join(dir, `agent-${agentId}.jsonl`));
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({
    agentType: 'arbiter', description: TAG, toolUseId: 'toolu_01', spawnDepth: 1, ...meta,
  }));
  return { projects: join(root, 'p'), dir };
}

test('model-proof: a clean fable transcript found by tag proves ok (exit 0)', (t) => {
  const { projects, dir } = projectsDir(t);
  const r = cli(tmpdir(), ['model-proof', '--tag', TAG, '--expect-agent-type', 'arbiter', '--projects-dir', projects]);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.transcript, join(dir, 'agent-a1.jsonl'));
  assert.equal(r.json.meta.agentType, 'arbiter');
  assert.deepEqual(r.json.models, { 'claude-fable-5-1': 2 });
  assert.deepEqual(r.json.efforts, { high: 2 });
  assert.deepEqual(r.json.errors, []);
  assert.match(r.json.finalAssistantText, /"rulings"/);
});

test('model-proof: found by agent id; model and effort expectations are flags', (t) => {
  const { projects } = projectsDir(t);
  const ok = cli(tmpdir(), ['model-proof', '--agent-id', 'a1', '--projects-dir', projects]);
  assertExit(ok, 0, ok.stdout);
  const wrongModel = cli(tmpdir(), ['model-proof', '--agent-id', 'a1', '--projects-dir', projects, '--expect-model', 'claude-opus-']);
  assertExit(wrongModel, 1);
  assert.match(wrongModel.json.errors.join('\n'), /unexpected model/);
  const wrongEffort = cli(tmpdir(), ['model-proof', '--agent-id', 'a1', '--projects-dir', projects, '--expect-effort', 'low']);
  assertExit(wrongEffort, 1);
  assert.match(wrongEffort.json.errors.join('\n'), /unexpected effort/);
});

test('model-proof: a synthetic-error transcript is a mismatch (exit 1) with the reasons', (t) => {
  const { projects } = projectsDir(t, { jsonl: 'synthetic-error.jsonl' });
  const r = cli(tmpdir(), ['model-proof', '--tag', TAG, '--expect-agent-type', 'arbiter', '--projects-dir', projects]);
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.length > 0);
});

test('model-proof: wrong agent type, a per-call model override, and a missing meta are all exit 1', (t) => {
  const wrongType = projectsDir(t);
  const a = cli(tmpdir(), ['model-proof', '--tag', TAG, '--expect-agent-type', 'judge', '--projects-dir', wrongType.projects]);
  assertExit(a, 1);
  assert.match(a.json.errors.join('\n'), /unexpected agent type/);

  const override = projectsDir(t, { meta: { model: 'claude-nonexistent-0' } });
  const b = cli(tmpdir(), ['model-proof', '--tag', TAG, '--projects-dir', override.projects]);
  assertExit(b, 1);
  assert.match(b.json.errors.join('\n'), /override/);
  // ... unless the caller says that exact override is what it asked for
  const c = cli(tmpdir(), ['model-proof', '--tag', TAG, '--projects-dir', override.projects, '--expect-meta-model', 'claude-nonexistent-0']);
  assertExit(c, 0, c.stdout);

  const noMeta = projectsDir(t);
  rmSync(join(noMeta.dir, 'agent-a1.meta.json'));
  const d = cli(tmpdir(), ['model-proof', '--agent-id', 'a1', '--projects-dir', noMeta.projects]);
  assertExit(d, 1);
  assert.match(d.json.errors.join('\n'), /meta missing/);
});

test('model-proof: an unknown tag or agent id is exit 2 not-found', (t) => {
  const { projects } = projectsDir(t);
  const tag = cli(tmpdir(), ['model-proof', '--tag', 'pipeline-arbiter R9 deadbeef', '--projects-dir', projects]);
  assertExit(tag, 2);
  assert.equal(tag.json.ok, false);
  assert.equal(tag.json.error, 'not-found');
  const id = cli(tmpdir(), ['model-proof', '--agent-id', 'zzz', '--projects-dir', projects]);
  assertExit(id, 2);
  assert.equal(id.json.error, 'not-found');
  const empty = cli(tmpdir(), ['model-proof', '--tag', TAG, '--projects-dir', join(projects, 'nope')]);
  assertExit(empty, 2);
});

test('model-proof: a tag whose transcript is not there yet, or a stale meta, is exit 2', (t) => {
  const { projects, dir } = projectsDir(t);
  rmSync(join(dir, 'agent-a1.jsonl'));
  const missing = cli(tmpdir(), ['model-proof', '--tag', TAG, '--projects-dir', projects]);
  assertExit(missing, 2);
  assert.equal(missing.json.error, 'read');

  const stale = projectsDir(t);
  const old = new Date(Date.now() - 3 * 3600e3);
  utimesSync(join(stale.dir, 'agent-a1.meta.json'), old, old);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--projects-dir', stale.projects, '--max-age-ms', '60000']), 2);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--projects-dir', stale.projects, '--max-age-ms', '86400000']), 0);
});

test('model-proof: usage errors (exactly one locator, no empty expectations, integer max age)', (t) => {
  const { projects } = projectsDir(t);
  const base = ['--projects-dir', projects];
  assertExit(cli(tmpdir(), ['model-proof', ...base]), 2);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--agent-id', 'a1', ...base]), 2);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--expect-model', '', ...base]), 2);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--expect-effort', '', ...base]), 2);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--max-age-ms', 'soon', ...base]), 2);
  assertExit(cli(tmpdir(), ['model-proof', '--tag', TAG, '--bogus', ...base]), 2);
});

// ---------------------------------------------------------------------------------------------------------------
// job
// ---------------------------------------------------------------------------------------------------------------

const jobsDir = (repo) => join(repo.dir, '.review', 'jobs');

test('job: start then wait reports done with exit code 0 and the output tail', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const started = cli(repo.dir, ['job', 'start', 'ok', '--', 'node', '-e', 'console.log(1)']);
  assertExit(started, 0, started.stdout);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.name, 'ok');
  assert.equal(started.json.jobDir, join(jobsDir(repo), 'ok'));
  assert.equal(typeof started.json.pid, 'number');
  const waited = cli(repo.dir, ['job', 'wait', 'ok', '--timeout', '30']);
  assertExit(waited, 0, waited.stdout);
  assert.equal(waited.json.ok, true);
  assert.equal(waited.json.state, 'done');
  assert.equal(waited.json.exitCode, 0);
  assert.equal(waited.json.name, 'ok');
  assert.match(waited.json.tail, /^1$/m);
  const read = cli(repo.dir, ['job', 'read', 'ok']);
  assertExit(read, 0);
  assert.equal(read.json.state, 'done');
});

test('job: start returns runId and a tag (default: the repo HEAD sha, or --tag)', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const a = cli(repo.dir, ['job', 'start', 'tagged', '--', 'node', '-e', '0']);
  assertExit(a, 0, a.stdout);
  assert.equal(a.json.tag, head);
  assert.match(a.json.runId, /^[0-9a-f-]{36}$/);
  const w = cli(repo.dir, ['job', 'wait', 'tagged', '--timeout', '30', '--run-id', a.json.runId]);
  assertExit(w, 0, w.stdout);
  assert.equal(w.json.state, 'done');
  assert.equal(w.json.tag, head);
  assert.equal(w.json.runId, a.json.runId);
  const b = cli(repo.dir, ['job', 'start', 'tagged', '--tag', 'tree-abc', '--', 'node', '-e', '0']);
  assertExit(b, 0, b.stdout);
  assert.equal(b.json.tag, 'tree-abc');
  assert.notEqual(b.json.runId, a.json.runId);
  assert.equal(cli(repo.dir, ['job', 'read', 'tagged', '--run-id', b.json.runId]).json.tag, 'tree-abc');
});

test('job: wait/read with the runId of a replaced run exit 1 with state replaced', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const first = cli(repo.dir, ['job', 'start', 'again', '--', 'node', '-e', '0']);
  assertExit(cli(repo.dir, ['job', 'wait', 'again', '--timeout', '30']), 0);
  const second = cli(repo.dir, ['job', 'start', 'again', '--', 'node', '-e', '0']);
  assert.notEqual(second.json.runId, first.json.runId);
  for (const sub of ['wait', 'read']) {
    const r = cli(repo.dir, ['job', sub, 'again', '--run-id', first.json.runId, ...(sub === 'wait' ? ['--timeout', '5'] : [])]);
    assertExit(r, 1, r.stdout);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.state, 'replaced');
  }
  const mine = cli(repo.dir, ['job', 'wait', 'again', '--run-id', second.json.runId, '--timeout', '30']);
  assertExit(mine, 0);
  assert.equal(mine.json.state, 'done');
});

test('job: a failing command is done with its exit code and CLI exit 1', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  assertExit(cli(repo.dir, ['job', 'start', 'bad', '--', 'node', '-e', 'process.exit(3)']), 0);
  const waited = cli(repo.dir, ['job', 'wait', 'bad', '--timeout', '30']);
  assertExit(waited, 1);
  assert.equal(waited.json.ok, false);
  assert.equal(waited.json.state, 'done');
  assert.equal(waited.json.exitCode, 3);
  assertExit(cli(repo.dir, ['job', 'read', 'bad']), 1);
});

test('job: a job that is still running is exit 0 state running, then done', async (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  assertExit(cli(repo.dir, ['job', 'start', 'slow', '--', 'node', '-e', 'setTimeout(() => {}, 1500)']), 0);
  const early = cli(repo.dir, ['job', 'read', 'slow']);
  assertExit(early, 0);
  assert.equal(early.json.state, 'running');
  const shortWait = cli(repo.dir, ['job', 'wait', 'slow', '--timeout', '0']);
  assertExit(shortWait, 0);
  assert.equal(shortWait.json.state, 'running');
  assert.equal(shortWait.json.ok, true);
  const again = cli(repo.dir, ['job', 'start', 'slow', '--', 'node', '-e', '0']);
  assertExit(again, 1); // same name, still running
  assert.equal(again.json.ok, false);
  assert.equal(again.json.error, 'already-running');
  const done = cli(repo.dir, ['job', 'wait', 'slow', '--timeout', '30']);
  assertExit(done, 0);
  assert.equal(done.json.state, 'done');
  await sleep(0);
});

test('job: arguments with spaces and shell metacharacters reach the command as single arguments', { skip: process.platform === 'win32' }, (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const arg = "a b;echo INJECTED $HOME 'q'";
  assertExit(cli(repo.dir, ['job', 'start', 'q', '--', 'node', '-e', 'console.log(process.argv[1])', arg]), 0);
  const waited = cli(repo.dir, ['job', 'wait', 'q', '--timeout', '30']);
  assert.equal(waited.json.exitCode, 0, waited.stdout);
  assert.equal(waited.json.tail, arg);
});

test('job: -h and --help after "--" belong to the command; before it they ask for usage', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const started = cli(repo.dir, ['job', 'start', 'h', '--', 'node', '-e', "console.log(process.argv.slice(1).join(' '))", '--', '--help', '-h']);
  assertExit(started, 0, started.stdout);
  assert.equal(started.json.ok, true);
  assert.equal(typeof started.json.pid, 'number'); // a job, not a usage reply (which is {ok, usage} with no pid)
  const waited = cli(repo.dir, ['job', 'wait', 'h', '--timeout', '30']);
  assert.equal(waited.json.tail, '--help -h');
  const help = cli(repo.dir, ['job', 'start', '--help']);
  assertExit(help, 0);
  assert.match(help.json.usage, /job start/);
});

test('job: a command the git guard denies is refused and no job directory is created', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  for (const [name, cmd] of [
    ['x', ['git', 'push', 'origin', 'main']],
    ['x2', ['git', 'push', '--force', 'origin', 'feature']],
    ['x3', ['bash', '-c', 'git push origin main']],
    ['x4', ['git push origin main']], // one word a shell would split: judged as the caller meant it
  ]) {
    const r = cli(repo.dir, ['job', 'start', name, '--', ...cmd]);
    assertExit(r, 1, `${cmd.join(' ')}: ${r.stdout}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.refused, true);
    assert.equal(typeof r.json.reason, 'string');
    assert.ok(r.json.reason.length > 0);
    assert.equal(existsSync(join(jobsDir(repo), name)), false, `${name} dir must not exist`);
  }
});

test('job: a command that touches the protected pipeline files is refused', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const r = cli(repo.dir, ['job', 'start', 'y', '--', 'rm', '-rf', '~/.claude/pipeline']);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.refused, true);
  assert.equal(existsSync(join(jobsDir(repo), 'y')), false);
  const abs = cli(repo.dir, ['job', 'start', 'y2', '--', 'rm', '-rf', join(homedir(), '.claude', 'pipeline')]);
  assertExit(abs, 1);
  assert.equal(abs.json.refused, true);
  assert.equal(existsSync(join(jobsDir(repo), 'y2')), false);
});

test('job: wait/read on a job that was never started is exit 2 missing', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const w = cli(repo.dir, ['job', 'wait', 'ghost', '--timeout', '1']);
  assertExit(w, 2);
  assert.equal(w.json.ok, false);
  assert.equal(w.json.state, 'missing');
  const r = cli(repo.dir, ['job', 'read', 'ghost']);
  assertExit(r, 2);
  assert.equal(r.json.state, 'missing');
});

test('job: a job whose runner died is lost, exit 1', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const dir = join(jobsDir(repo), 'dead');
  mkdirSync(dir, { recursive: true });
  // pid 2^31-2 cannot be a live process, and there is no exit.json: the runner vanished
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    name: 'dead', command: 'x', cwd: repo.dir, startedAt: new Date(Date.now() - 3600e3).toISOString(), runnerPid: 2147483646,
  }));
  const r = cli(repo.dir, ['job', 'read', 'dead']);
  assertExit(r, 1);
  assert.equal(r.json.state, 'lost');
  assert.equal(r.json.ok, false);
});

test('job: usage errors are exit 2', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const usage = (...args) => {
    const r = cli(repo.dir, ['job', ...args]);
    assertExit(r, 2, `job ${args.join(' ')}: ${r.stdout}`);
    assert.equal(r.json.ok, false);
    return r;
  };
  usage(); // no subcommand
  usage('bogus', 'x');
  usage('wait', 'x', '--bogus');
  usage('read', 'x', '--bogus');
  usage('start', 'x', '--bogus', '--', 'echo', 'hi');
  usage('start', 'x', 'echo', 'hi'); // no `--`
  usage('start', '--', 'echo', 'hi'); // no name
  usage('start', 'x', '--'); // no command
  usage('start', 'x', '--', ''); // empty command
  usage('start', 'a/b', '--', 'echo', 'hi'); // bad name
  usage('start', '..', '--', 'echo', 'hi');
  usage('wait'); // no name
  usage('wait', 'x', 'y');
  usage('wait', 'x', '--timeout', '571'); // over the cap
  usage('wait', 'x', '--timeout', '-1');
  usage('wait', 'x', '--timeout', 'soon');
  assert.equal(existsSync(jobsDir(repo)), false, 'a usage error must not create anything');
});

test('job: --repo selects the repository whose .review/jobs holds the job', (t) => {
  const repo = project();
  t.after(() => repo.cleanup());
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const started = cli(elsewhere, ['job', 'start', '--repo', repo.dir, 'r', '--', 'node', '-e', '0']);
  assertExit(started, 0, started.stdout);
  assert.equal(started.json.jobDir, join(jobsDir(repo), 'r'));
  assert.equal(cli(elsewhere, ['job', 'wait', '--repo', repo.dir, 'r', '--timeout', '30']).json.state, 'done');
});

test('quoteCommand: plain words stay bare, everything else is quoted for the platform shell', () => {
  assert.equal(quoteCommand(['node', '-e', 'console.log(1)'], 'linux'), "node -e 'console.log(1)'");
  assert.equal(quoteCommand(['git', 'status', '--short', './a/b-c_d.txt'], 'linux'), 'git status --short ./a/b-c_d.txt');
  assert.equal(quoteCommand(['echo', 'it\'s'], 'linux'), "echo 'it'\\''s'");
  assert.equal(quoteCommand(['echo', ''], 'linux'), "echo ''");
  assert.equal(quoteCommand(['rm', '-rf', '~/x', '$HOME', 'a;b', 'a&b', 'a b', '*'], 'darwin'), "rm -rf '~/x' '$HOME' 'a;b' 'a&b' 'a b' '*'");
  const win = quoteCommand(['node', '-e', 'a b', 'plain'], 'win32');
  assert.match(win, /^node -e .*a.*b.* plain$/);
  assert.ok(win.includes('"'), win);
  assert.ok(!win.includes("'"), win);
});
