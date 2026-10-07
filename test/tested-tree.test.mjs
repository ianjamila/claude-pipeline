// Tests for .github/scripts/tested-tree.mjs (the push-to-main "this tree already passed on the PR" decision) and for the
// way ci.yml wires it in. The script runs in a real tmp git repo (its HEAD tree is the "pushed" tree) against the scripted
// fake `gh` (test/fixtures/fake-gh.mjs), which stands in for GitHub; the decision is read from the $GITHUB_OUTPUT file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { runNode, scratchDir } from './helpers/project.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, '.github', 'scripts', 'tested-tree.mjs');
const fakeGh = join(root, 'test', 'fixtures', 'fake-gh.mjs');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const REPO = 'acme/app';
const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const JOB = 'test (ubuntu)';
const NUM = 7;
const RUN_ID = 555;

const pr = (over = {}) => ({ number: NUM, merged_at: '2026-10-07T10:00:00Z', base: { ref: 'main' }, head: { sha: HEAD }, ...over });

// The happy-path GitHub. `over` replaces whole entries by key; a value of 'fail' makes that call exit 1.
function gh(tree, over = {}) {
  const e = {
    pulls: { stdoutJson: [pr()] },
    headCommit: { stdoutJson: { tree: { sha: tree } } },
    pushed: { stdoutJson: { parents: [{ sha: PARENT }] } },
    compare: { stdoutJson: { status: 'ahead' } },
    runs: { stdoutJson: { workflow_runs: [{ id: RUN_ID, status: 'completed', conclusion: 'success', html_url: `https://github.example/runs/${RUN_ID}` }] } },
    jobs: { stdoutJson: { jobs: [{ name: 'test (windows)', conclusion: 'failure' }, { name: JOB, conclusion: 'success' }] } },
    ...over,
  };
  const entry = (match, key) => (e[key] === 'fail' ? { match, code: 1, stderr: 'HTTP 500' } : { match, ...e[key] });
  return [
    entry(`^api repos/${REPO}/commits/${SHA}/pulls$`, 'pulls'),
    entry(`^api repos/${REPO}/git/commits/${HEAD}$`, 'headCommit'),
    entry(`^api repos/${REPO}/commits/${SHA}$`, 'pushed'),
    entry(`^api repos/${REPO}/compare/${PARENT}\\.\\.\\.${HEAD}$`, 'compare'),
    entry(`^api repos/${REPO}/actions/workflows/ci\\.yml/runs\\?head_sha=${HEAD}&event=pull_request`, 'runs'),
    entry(`^api repos/${REPO}/actions/runs/${RUN_ID}/jobs\\?filter=all`, 'jobs'),
  ];
}

async function decide({ over = {}, headTree, env = {} } = {}) {
  const repo = createTmpRepo();
  repo.write('a.txt', 'one\n');
  repo.commit('pushed');
  const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim();
  const dir = scratchDir();
  const scriptFile = join(dir, 'script.json');
  const out = join(dir, 'output');
  const log = join(dir, 'log.jsonl');
  writeFileSync(scriptFile, JSON.stringify(gh(headTree ?? tree, over)));
  writeFileSync(out, '');
  const r = await runNode([script], {
    cwd: repo.dir,
    env: {
      REPO, SHA, JOB_NAME: JOB, GITHUB_OUTPUT: out, GH_TOKEN: 'test-token',
      TESTED_TREE_GH_ARGV: JSON.stringify([process.execPath, fakeGh]),
      PIPELINE_FAKE_GH_SCRIPT: scriptFile, PIPELINE_FAKE_GH_LOG: log,
      ...env,
    },
  });
  return { ...r, tree, output: readFileSync(out, 'utf8').trim() };
}

test('identical tree + the same job green on the PR head -> skip, with the evidence logged', async () => {
  const r = await decide();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.output, 'run=false');
  assert.match(r.stdout, new RegExp(`pushed commit ${SHA} tree ${r.tree}`));
  assert.match(r.stdout, new RegExp(`PR #${NUM} head ${HEAD} tree ${r.tree}`));
  assert.match(r.stdout, new RegExp(`evidence: run ${RUN_ID} .* job "test \\(ubuntu\\)" concluded success on PR head ${HEAD}`));
});

test('a rerun that went green counts: only a later attempt of the job succeeded', async () => {
  const r = await decide({ over: { jobs: { stdoutJson: { jobs: [{ name: JOB, conclusion: 'failure' }, { name: JOB, conclusion: 'success' }] } } } });
  assert.equal(r.output, 'run=false');
});

test('a different tree -> run', async () => {
  const r = await decide({ headTree: 'd'.repeat(40) });
  assert.equal(r.code, 0);
  assert.equal(r.output, 'run=true');
  assert.match(r.stdout, /RUN: tree differs/);
});

test('the same job failed, or only another job is green, or was cancelled/missing -> run', async () => {
  for (const jobs of [
    [{ name: JOB, conclusion: 'failure' }],
    [{ name: JOB, conclusion: 'cancelled' }],
    [{ name: JOB, conclusion: null }],
    [{ name: 'test (windows)', conclusion: 'success' }],
    [],
  ]) {
    const r = await decide({ over: { jobs: { stdoutJson: { jobs } } } });
    assert.equal(r.output, 'run=true', JSON.stringify(jobs));
    assert.match(r.stdout, /RUN: no completed ci\.yml pull_request run/);
  }
});

test('no run, or only an unfinished run, of the workflow on the PR head -> run', async () => {
  assert.equal((await decide({ over: { runs: { stdoutJson: { workflow_runs: [] } } } })).output, 'run=true');
  const pending = { workflow_runs: [{ id: RUN_ID, status: 'in_progress', conclusion: null }] };
  assert.equal((await decide({ over: { runs: { stdoutJson: pending } } })).output, 'run=true');
});

test('any API failure or garbled reply -> run, exit 0', async () => {
  for (const key of ['pulls', 'headCommit', 'pushed', 'compare', 'runs', 'jobs']) {
    const r = await decide({ over: { [key]: 'fail' } });
    assert.equal(r.code, 0, key);
    assert.equal(r.output, 'run=true', key);
    assert.match(r.stdout, /RUN: /, key);
  }
  const garbled = await decide({ over: { pulls: { stdout: 'not json' } } });
  assert.equal(garbled.output, 'run=true');
  const shapeless = await decide({ over: { headCommit: { stdoutJson: {} } } });
  assert.equal(shapeless.output, 'run=true');
});

test('missing gh binary -> run', async () => {
  const r = await decide({ env: { TESTED_TREE_GH_ARGV: JSON.stringify(['no-such-gh-binary-xyz']) } });
  assert.equal(r.code, 0);
  assert.equal(r.output, 'run=true');
});

test('two PRs, no PR, an unmerged PR, or a PR into another base -> run', async () => {
  const cases = [[pr(), pr({ number: 8 })], [], [pr({ merged_at: null })], [pr({ base: { ref: 'dev' } })]];
  for (const pulls of cases) {
    const r = await decide({ over: { pulls: { stdoutJson: pulls } } });
    assert.equal(r.output, 'run=true', JSON.stringify(pulls));
  }
});

test('the PR head does not contain the previous main (the PR run tested a different merge) -> run', async () => {
  for (const status of ['diverged', 'behind']) {
    const r = await decide({ over: { compare: { stdoutJson: { status } } } });
    assert.equal(r.output, 'run=true', status);
    assert.match(r.stdout, /does not contain previous main/);
  }
  assert.equal((await decide({ over: { compare: { stdoutJson: { status: 'identical' } } } })).output, 'run=false');
});

test('missing inputs -> run', async () => {
  const r = await decide({ env: { JOB_NAME: '' } });
  assert.equal(r.output, 'run=true');
});

// ---- how ci.yml wires it in ----
const ci = read('.github/workflows/ci.yml');
const jobBlocks = () => ci.split(/^ {2}(?=test-(?:ubuntu|windows):)/m).slice(1);
const stepsOf = (block) => block.split(/^ {6}(?=- )/m).slice(1);

test('both jobs open with the skip step, push only, naming their own job', () => {
  const blocks = jobBlocks();
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const jobName = block.match(/^ {4}name: (.+)$/m)[1].trim();
    const steps = stepsOf(block);
    const at = steps.findIndex((s) => s.includes('tested-tree.mjs'));
    assert.ok(at >= 0, 'skip step present');
    const step = steps[at];
    assert.match(step, /id: tested\b/);
    assert.match(step, /if: github\.event_name == 'push'\s*$/m);
    assert.match(step, /continue-on-error: true/, 'a crashed skip step must not fail the job; the gate then reads run != false');
    assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(step, /REPO: \$\{\{ github\.repository \}\}/);
    assert.match(step, /SHA: \$\{\{ github\.sha \}\}/);
    assert.ok(step.includes(`JOB_NAME: ${jobName}`), `JOB_NAME is the job's own name (${jobName})`);
    // Only checkout (and the windows autocrlf setting) may come before it; everything after is gated.
    for (const before of steps.slice(0, at)) assert.match(before, /actions\/checkout@|core\.autocrlf/);
    assert.ok(steps.slice(0, at).some((s) => s.includes('actions/checkout@')), 'the script comes from the checkout');
    for (const after of steps.slice(at + 1)) {
      assert.match(after, /if: github\.event_name != 'push' \|\| steps\.tested\.outputs\.run != 'false'\s*$/m, after.split('\n')[0]);
    }
  }
});

test('ci.yml grants only the extra read scopes the skip step needs, with a comment', () => {
  const perms = ci.match(/^permissions:\n((?: {2}.+\n)+)/m)[1];
  assert.deepEqual(perms.match(/^ {2}[\w-]+: \w+$/gm).map((l) => l.trim()).sort(), ['actions: read', 'contents: read', 'pull-requests: read']);
  assert.match(perms, /#.*tested-tree|#.*skip/i);
});

test('the header comment explains the skip', () => {
  const header = ci.split(/^name: CI/m)[0];
  assert.match(header, /skip/i);
  assert.match(header, /identical tree/i);
});
