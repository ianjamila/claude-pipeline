// Tests for lib/workflow-contexts.mjs: the expression contexts GitHub allows at each workflow key. Ported from the EagleWatch
// copy (four review rounds). Every rule has a failing case AND a passing case, so no assertion is vacuous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextsIn, scanWorkflowDir, workflowContextFindings } from '../pipeline/lib/workflow-contexts.mjs';

const run = (yaml) => workflowContextFindings(new Map([['w.yml', yaml]]));

const job = (lines) => `
on: push
jobs:
  j:
    runs-on: ubuntu-latest
${lines}
    steps:
      - run: echo hi
`;

const steps = (lines) => `
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
${lines}
`;

const call = (lines) => `
on: push
jobs:
  c:
    uses: ./.github/workflows/x.yml
${lines}
`;

const wfCall = (value) => `
on:
  workflow_call:
    outputs:
      o:
        value: ${value}
jobs: {}
`;

test('contextsIn finds contexts, ignores functions, literals and nested property names', () => {
  assert.deepEqual(contextsIn(' runner.temp '), ['runner']);
  assert.deepEqual(contextsIn(" contains(github.ref, 'x') && needs.a.outputs.steps "), ['github', 'needs']);
  assert.deepEqual(contextsIn(" format('runner.{0}', github.run_id) "), ['github']);
  assert.deepEqual(contextsIn(" secrets['TOKEN'] "), ['secrets']);
});

test('flags runner.* in a job-level env (the queue-guards.yml jam of 2026-11-10)', () => {
  const f = run(job('    env:\n      DIR: ${{ runner.temp }}/queue-verdict'));
  assert.equal(f.length, 1);
  assert.match(f[0], /jobs\.j\.env uses `runner`/);
});

test('passes a job-level env that uses only allowed contexts', () => {
  assert.deepEqual(run(job('    env:\n      A: ${{ github.token }}\n      B: ${{ github.event.workflow_run.head_sha }}\n      C: ${{ secrets.X }}')), []);
});

test('allows runner.* inside steps', () => {
  assert.deepEqual(run(`
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ runner.temp }}"
        env: { DIR: "\${{ runner.temp }}/x" }
      - uses: actions/upload-artifact@v4
        with: { path: "\${{ runner.temp }}/x" }
`), []);
});

test('checks a bare job if: expression, and allows github/needs there', () => {
  assert.equal(run(job("    if: steps.a.outputs.ok == 'true'")).length, 1);
  assert.deepEqual(run(job("    if: github.event.workflow_run.event == 'merge_group' && needs.a.result == 'success'")), []);
});

test('flags runner.* in a workflow-level env and env.* in a job concurrency', () => {
  assert.equal(run('on: push\nenv:\n  T: ${{ runner.temp }}\njobs: {}\n').length, 1);
  assert.equal(run(job('    concurrency: ${{ env.GROUP }}')).length, 1);
  assert.deepEqual(run(job('    concurrency: ${{ github.workflow }}-${{ github.ref }}')), []);
});

test('reports unparseable YAML as a finding instead of skipping it', () => {
  const f = run('jobs: [unclosed');
  assert.equal(f.length, 1);
  assert.match(f[0], /^w\.yml: not valid YAML/);
});

test('the planted fixture reports exactly 4', () => {
  const planted = readFileSync(new URL('./fixtures/workflow-contexts/planted.yml', import.meta.url), 'utf8');
  const f = workflowContextFindings(new Map([['planted.yml', planted]]));
  assert.equal(f.length, 4, f.join('\n'));
  assert.deepEqual(f.map((x) => /uses `(\w+)`/.exec(x)[1]).sort(), ['env', 'runner', 'runner', 'steps']);
});

test('review round 1: environment.url has its own wider list; the environment name does not', () => {
  assert.deepEqual(run(job('    environment:\n      name: production\n      url: ${{ steps.deploy.outputs.url }}')), []);
  assert.equal(run(job('    environment:\n      name: ${{ steps.pick.outputs.env }}\n      url: https://x')).length, 1);
  assert.equal(run(job('    environment: ${{ runner.os }}')).length, 1);
});

test('review round 1: a bare context name counts (toJSON(runner)); a function name and a property name do not', () => {
  assert.equal(run(job('    env:\n      R: ${{ toJSON(runner) }}')).length, 1);
  assert.deepEqual(run(job('    env:\n      N: ${{ toJSON(needs) }}\n      J: ${{ fromJSON(github.event.inputs.x).steps }}')), []);
  assert.deepEqual(contextsIn(' toJSON(runner) '), ['runner']);
  assert.deepEqual(contextsIn(' github.event.steps '), ['github']);
});

test('review round 1: job-level with:/secrets: of a reusable call, defaults.run, container, services and workflow_call outputs', () => {
  assert.equal(run(call('    with:\n      sha: ${{ env.HEAD }}')).length, 1);
  assert.equal(run(call('    with:\n      dir: ${{ runner.temp }}')).length, 1);
  assert.deepEqual(run(call('    with:\n      sha: ${{ github.event.workflow_run.head_sha || needs.a.outputs.sha }}')), []);
  assert.equal(run(call('    secrets:\n      T: ${{ steps.a.outputs.t }}')).length, 1);
  assert.deepEqual(run(call('    secrets:\n      T: ${{ secrets.T }}')), []);
  assert.deepEqual(run(call('    secrets: inherit')), []);
  assert.equal(run(job('    defaults:\n      run:\n        working-directory: ${{ runner.temp }}')).length, 1);
  assert.deepEqual(run(job('    defaults:\n      run:\n        working-directory: ${{ env.DIR }}')), []);
  assert.equal(run(job('    container:\n      image: ${{ env.IMG }}\n      env:\n        T: ${{ runner.temp }}\n      credentials:\n        password: ${{ secrets.P }}')).length, 1);
  assert.equal(run(job('    services:\n      db:\n        image: ${{ secrets.IMG }}\n        env:\n          T: ${{ runner.temp }}')).length, 1);
  assert.deepEqual(run(job('    services:\n      db:\n        image: postgres\n        env:\n          T: ${{ runner.temp }}\n        credentials:\n          password: ${{ secrets.P }}')), []);
  assert.deepEqual(run(wfCall('${{ jobs.a.outputs.o }}')), []);
  assert.equal(run(wfCall('${{ steps.a.outputs.o }}')).length, 1);
});

test('review round 1: context names match case-insensitively, as GitHub resolves them', () => {
  assert.equal(run(job('    env:\n      D: ${{ Runner.temp }}')).length, 1);
  assert.equal(run(job('    env:\n      D: ${{ RUNNER.temp }}')).length, 1);
  assert.deepEqual(run(job('    env:\n      D: ${{ GitHub.sha }}')), []);
});

test('review round 2: a step if: may not read secrets; no step key or job output may read jobs', () => {
  assert.equal(run(steps("      - if: secrets.NTFY_TOKEN != ''\n        run: echo")).length, 1);
  assert.deepEqual(run(steps("      - if: ${{ env.T != '' && steps.a.outputs.ok == 'true' && runner.os == 'Linux' }}\n        run: echo")), []);
  assert.equal(run(steps('      - run: echo "${{ jobs.x.result }}"')).length, 1);
  assert.deepEqual(run(steps('      - run: echo "${{ secrets.T }} ${{ runner.temp }} ${{ steps.a.outputs.b }}"\n        env: { T: "${{ secrets.T }}" }')), []);
  assert.equal(run(job('    outputs:\n      o: ${{ jobs.x.outputs.y }}')).length, 1);
  assert.deepEqual(run(job('    outputs:\n      o: ${{ steps.a.outputs.y }}')), []);
});

test('review round 2: a }} inside a string literal does not end the expression (no miss, no false red)', () => {
  assert.equal(run(job("    env:\n      X: ${{ format('{{0}}', runner.temp) }}")).length, 1);
  assert.equal(run(job("    env:\n      X: ${{ fromJSON('{\"a\":{\"b\":1}}')[runner.os] }}")).length, 1);
  assert.deepEqual(run(job("    strategy:\n      matrix: ${{ fromJSON('{\"include\":[{\"cfg\":{\"runner\":\"a\"}}]}') }}")), []);
});

test('review round 2: services written as one whole expression is checked', () => {
  assert.equal(run(job('    services: ${{ fromJSON(env.SERVICES) }}')).length, 1);
  assert.deepEqual(run(job('    services: ${{ fromJSON(vars.SERVICES) }}')), []);
});

test('review round 3: an unclosed ${{ followed by many quoted strings returns promptly (no catastrophic backtracking)', () => {
  const quotes = Array.from({ length: 60 }, (_, i) => `'q${i}'`).join(' ');
  const yaml = `
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "\${{ github.sha }"
          echo ${quotes}
`;
  const t0 = Date.now();
  assert.deepEqual(run(yaml), []);
  assert.ok(Date.now() - t0 < 1000, 'must not backtrack');
  // a doubled-quote escape still ends where GitHub ends
  assert.equal(run(job("    env:\n      X: ${{ format('it''s {0}', runner.temp) }}")).length, 1);
});

// ---- scanWorkflowDir: the pipeline's own addition (EagleWatch's CLI read the directory itself) ----------------------------------

const withRoot = (fn) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-wfc-')));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('scanWorkflowDir reads .yml and .yaml files under .github/workflows, sorted, and nothing else', () => {
  withRoot((dir) => {
    const wf = join(dir, '.github', 'workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'b.yml'), 'on: push\njobs: {}\n');
    writeFileSync(join(wf, 'a.yaml'), 'on: push\njobs: {}\n');
    writeFileSync(join(wf, 'notes.md'), 'on: push\nenv:\n  T: ${{ runner.temp }}\n');
    mkdirSync(join(wf, 'sub.yml'));
    const r = scanWorkflowDir(dir);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.findings, []);
    writeFileSync(join(wf, 'c.yml'), 'on: push\nenv:\n  T: ${{ runner.temp }}\njobs: {}\n');
    const bad = scanWorkflowDir(dir);
    assert.equal(bad.checked, 3);
    assert.equal(bad.findings.length, 1);
    assert.match(bad.findings[0], /^c\.yml: env uses `runner`/);
  });
});

test('scanWorkflowDir: a missing workflows directory is zero files, not an error', () => {
  withRoot((dir) => {
    assert.deepEqual(scanWorkflowDir(dir), { checked: 0, findings: [] });
  });
});

test('scanWorkflowDir: a workflows path that is not a directory throws (the CLI turns that into exit 2)', () => {
  withRoot((dir) => {
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github', 'workflows'), 'not a directory');
    assert.throws(() => scanWorkflowDir(dir));
  });
});

test('scanWorkflowDir reports a malformed file as a finding and keeps scanning the others', () => {
  withRoot((dir) => {
    const wf = join(dir, '.github', 'workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'bad.yml'), 'jobs: [unclosed');
    writeFileSync(join(wf, 'ok.yml'), 'on: push\njobs: {}\n');
    const r = scanWorkflowDir(dir);
    assert.equal(r.checked, 2);
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0], /^bad\.yml: not valid YAML/);
  });
});
