import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditDraftWorkflows, auditWorkflowText, draftSkipKind, draftWorkflowWarnings, jobCheckNames, triggersOn, workflowFacts,
} from '../pipeline/lib/workflow-audit.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQ = ['ci'];

// A workflow that meets every prerequisite; `over` replaces pieces.
const wf = ({ on, concurrency, ifLine = 'if: ${{ !github.event.pull_request.draft }}', jobs } = {}) => `name: CI
on:
${on ?? '  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]'}
${concurrency ?? 'concurrency:\n  group: ci-${{ github.event.pull_request.number }}\n  cancel-in-progress: true'}
jobs:
${jobs ?? `  ci:
    name: ci
    ${ifLine}
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`}`;
const audit = (text, required = REQ) => auditWorkflowText(text, required);

test('a fully compliant workflow audits clean and names the check it produces', () => {
  assert.deepEqual(audit(wf()), { name: 'CI', produces: ['ci'], missing: [] });
});

test('a bare pull_request trigger lacks ready_for_review and converted_to_draft', () => {
  const r = audit(wf({ on: '  pull_request:' }));
  assert.deepEqual(r.missing, ['no-ready_for_review', 'no-converted_to_draft']);
  assert.deepEqual(audit(wf({ on: '  pull_request' })).missing, ['no-ready_for_review', 'no-converted_to_draft']);
  assert.deepEqual(audit(wf({ on: '  [push, pull_request]' })).missing, ['no-ready_for_review', 'no-converted_to_draft']);
  assert.deepEqual(audit(wf({ on: '  pull_request:\n    types: [opened, ready_for_review]' })).missing, ['no-converted_to_draft']);
});

test('no draft skip at all is draft-skip', () => {
  assert.deepEqual(audit(wf({ ifLine: '' })).missing, ['draft-skip']);
  assert.deepEqual(audit(wf({ ifLine: "if: github.event_name == 'push'" })).missing, ['draft-skip']);
});

test('a draft skip on a needs ancestor alone is enough (transitively)', () => {
  const jobs = `  gate:
    if: \${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps: [{ run: x }]
  mid:
    needs: [gate]
    runs-on: ubuntu-latest
    steps: [{ run: x }]
  ci:
    needs: mid
    runs-on: ubuntu-latest
    steps: [{ run: x }]
`;
  assert.deepEqual(audit(wf({ jobs })).missing, []);
  assert.deepEqual(audit(wf({ jobs: jobs.replace('if: ${{ !github.event.pull_request.draft }}', 'if: true') })).missing, ['draft-skip']);
});

test('R6: only the proven draft-skip spellings are recognised', () => {
  const proven = [
    '!github.event.pull_request.draft',
    '${{ !github.event.pull_request.draft }}',
    '${{ ! github.event.pull_request.draft }}',
    'github.event.pull_request.draft == false',
    "!github.event.pull_request.draft && github.actor != 'bot'",
    "github.actor != 'bot' && github.event.pull_request.draft == false",
    "github.event_name != 'pull_request' || !github.event.pull_request.draft",
    '${{ github.event_name != "pull_request" || !github.event.pull_request.draft }}',
    "(github.event_name != 'pull_request' || !github.event.pull_request.draft) && github.ref != 'x'",
    'always() && !github.event.pull_request.draft',
    "always() && (github.event_name != 'pull_request' || !github.event.pull_request.draft)",
    "failure() && (github.event.pull_request.draft == false)",
  ];
  for (const p of proven) assert.equal(draftSkipKind(p), 'proven', p);
  const unverified = [
    'always()',
    'success() || !github.event.pull_request.draft',
    'always() && github.event.pull_request.draft == true',
    "contains(github.event.pull_request.labels.*.name,'x') || !github.event.pull_request.draft",
    'github.event.pull_request.draft',
    'github.event.pull_request.draft == true',
    '!github.event.pull_request.draft || github.actor == x',
    'github.actor == x || !github.event.pull_request.draft',
  ];
  for (const u of unverified) assert.equal(draftSkipKind(u), 'unverified', u);
  assert.equal(draftSkipKind(null), 'none');
  assert.equal(draftSkipKind('github.event_name == push'), 'none');
  // Through the audit: unverified is its own code, never a pass and never plain draft-skip.
  assert.deepEqual(audit(wf({ ifLine: 'if: always() && !github.event.pull_request.draft' })).missing, [], 'always() beside a proven conjunct is proven');
  assert.deepEqual(audit(wf({ ifLine: 'if: github.actor == x || !github.event.pull_request.draft' })).missing, ['draft-skip-unverified']);
  assert.deepEqual(audit(wf({ ifLine: "if: contains(github.event.pull_request.labels.*.name,'x') || !github.event.pull_request.draft" })).missing, ['draft-skip-unverified']);
  assert.deepEqual(audit(wf({ ifLine: "if: github.event_name != 'pull_request' || !github.event.pull_request.draft" })).missing, []);
});

test('a job whose if calls a status function needs its own proven skip; an ancestor does not rescue it', () => {
  const PROVEN = "github.event_name != 'pull_request' || !github.event.pull_request.draft";
  const jobs = (own) => `  shard:
    if: ${PROVEN}
    runs-on: x
  ci:
    needs: shard
${own === null ? '' : `    if: ${own}\n`}    runs-on: x
`;
  // this repo's ci.yml aggregate: proven by its own \`if\`
  assert.deepEqual(audit(wf({ jobs: jobs(`always() && (${PROVEN})`) })).missing, []);
  assert.deepEqual(audit(wf({ jobs: jobs('always() && !github.event.pull_request.draft') })).missing, []);
  // no draft mention: not rescued by the proven ancestor
  assert.deepEqual(audit(wf({ jobs: jobs('always()') })).missing, ['draft-skip']);
  assert.deepEqual(audit(wf({ jobs: jobs("failure() && github.actor == 'x'") })).missing, ['draft-skip']);
  assert.deepEqual(audit(wf({ jobs: jobs('cancelled()') })).missing, ['draft-skip']);
  // mentions the draft in an unproven way: unverified, still not rescued
  assert.deepEqual(audit(wf({ jobs: jobs('always() && github.event.pull_request.draft == true') })).missing, ['draft-skip-unverified']);
  // no if at all, or a plain one: the ancestor's skip still carries over
  assert.deepEqual(audit(wf({ jobs: jobs(null) })).missing, []);
  assert.deepEqual(audit(wf({ jobs: jobs("github.actor != 'bot'") })).missing, []);
  // ancestor without a proven skip: nothing to rescue with
  assert.deepEqual(audit(wf({ jobs: jobs(null).replace(PROVEN, 'true') })).missing, ['draft-skip']);
});

test('the concurrency group needs a per-PR key and cancel-in-progress must be literally true', () => {
  const c = (group, cancel) => `concurrency:\n  group: ${group}${cancel === undefined ? '' : `\n  cancel-in-progress: ${cancel}`}`;
  assert.deepEqual(audit(wf({ concurrency: c('ci', true) })).missing, ['no-pr-concurrency-group']);
  assert.deepEqual(audit(wf({ concurrency: 'concurrency: ci' })).missing, ['no-pr-concurrency-group', 'no-cancel-in-progress']);
  assert.deepEqual(audit(wf({ concurrency: '' })).missing, ['no-pr-concurrency-group', 'no-cancel-in-progress']);
  for (const key of ['${{ github.head_ref }}', '${{ github.ref }}', '${{ github.event.pull_request.number }}']) {
    assert.deepEqual(audit(wf({ concurrency: c(`ci-${key}`, true) })).missing, [], key);
  }
  assert.deepEqual(audit(wf({ concurrency: c('ci-${{ github.ref }}', false) })).missing, ['no-cancel-in-progress']);
  assert.deepEqual(audit(wf({ concurrency: c('ci-${{ github.ref }}') })).missing, ['no-cancel-in-progress']);
  assert.deepEqual(audit(wf({ concurrency: c('ci-${{ github.ref }}', "${{ github.ref != 'refs/heads/main' }}") })).missing, ['no-cancel-in-progress']);
  // The one expression ci.yml uses: true on every pull_request event.
  assert.deepEqual(audit(wf({ concurrency: c('ci-${{ github.ref }}', "${{ github.event_name == 'pull_request' }}") })).missing, []);
});

test('a job-level concurrency counts when the workflow has none', () => {
  const jobs = `  ci:
    if: \${{ !github.event.pull_request.draft }}
    concurrency:
      group: ci-\${{ github.head_ref }}
      cancel-in-progress: true
    runs-on: x
`;
  assert.deepEqual(audit(wf({ concurrency: '', jobs })).missing, []);
});

test('unparsable YAML is reported as unparsable, not skipped', () => {
  assert.throws(() => workflowFacts('a: [unclosed'));
  const dir = mkdtempSync(join(tmpdir(), 'wfaudit-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'broken.yml'), 'a: [unclosed\n');
    writeFileSync(join(dir, '.github', 'workflows', 'good.yaml'), wf());
    writeFileSync(join(dir, '.github', 'workflows', 'notes.txt'), 'not a workflow');
    const out = auditDraftWorkflows(dir, { ci: { required_checks: REQ, guard_checks: false } });
    assert.deepEqual(out, [{ file: '.github/workflows/broken.yml', unparsable: true }, { file: '.github/workflows/good.yaml', name: 'CI', produces: ['ci'], missing: [] }]);
    assert.match(draftWorkflowWarnings(out)[0], /broken\.yml is not valid YAML/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a workflow that produces no required check is not audited; a missing directory audits nothing', () => {
  assert.equal(audit(wf(), ['other']), null);
  assert.equal(audit(wf({ on: '  push:' })), null, 'no pull_request trigger: no draft concern');
  const dir = mkdtempSync(join(tmpdir(), 'wfaudit-'));
  try {
    assert.deepEqual(auditDraftWorkflows(dir, { ci: { required_checks: REQ } }), []);
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'lint.yml'), wf({ on: '  pull_request:' }));
    assert.deepEqual(auditDraftWorkflows(dir, { ci: { required_checks: ['lint'], guard_checks: false } }), [], 'job is named ci, not lint');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard contexts are never audited, even when the guards workflow is listed as required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfaudit-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'g.yml'), wf({ on: '  pull_request:', jobs: '  guards:\n    name: Test integrity\n    runs-on: x\n' }));
    assert.deepEqual(auditDraftWorkflows(dir, { ci: { required_checks: ['Test integrity'] } }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('matrix jobs: `name (value)` forms are what counts as the produced check', () => {
  const jobs = (name) => `  t:
${name ? `    name: ${name}\n` : ''}    if: \${{ !github.event.pull_request.draft }}
    strategy:
      matrix:
        os: [ubuntu, windows]
        node: [20, 24]
    runs-on: x
`;
  const facts = workflowFacts(wf({ jobs: jobs('test') }));
  assert.deepEqual(jobCheckNames(facts.jobs[0]), ['test (ubuntu, 20)', 'test (ubuntu, 24)', 'test (windows, 20)', 'test (windows, 24)']);
  assert.deepEqual(audit(wf({ jobs: jobs('test') }), ['test (windows, 24)']).produces, ['test (windows, 24)']);
  assert.equal(audit(wf({ jobs: jobs('test') }), ['test']), null, 'the bare name is not a check of a matrix job');
  assert.deepEqual(jobCheckNames(workflowFacts(wf({ jobs: jobs(null) })).jobs[0]).slice(0, 1), ['t (ubuntu, 20)'], 'unnamed: the id');
  const named = workflowFacts(wf({ jobs: jobs('test (${{ matrix.os }})') })).jobs[0];
  assert.deepEqual(jobCheckNames(named), ['test (ubuntu)', 'test (windows)']);
});

test('triggersOn: types list, default types, pull_request_target, other forms', () => {
  const on = (s) => `name: x\non:\n${s}\njobs: {}\n`;
  const listed = on('  pull_request:\n    types: [opened, ready_for_review]');
  assert.equal(triggersOn(listed, 'ready_for_review'), true);
  assert.equal(triggersOn(listed, 'converted_to_draft'), false);
  assert.equal(triggersOn(listed, 'synchronize'), false, 'a types list replaces the defaults');
  const bare = on('  pull_request:');
  assert.equal(triggersOn(bare, 'ready_for_review'), false);
  assert.equal(triggersOn(bare, 'synchronize'), true);
  assert.equal(triggersOn(on('  pull_request_target:\n    types: [ready_for_review]'), 'ready_for_review'), true);
  assert.equal(triggersOn(on('  pull_request_target:'), 'opened'), true);
  assert.equal(triggersOn(on('  pull_request:\n    types: ready_for_review'), 'ready_for_review'), true, 'a single string');
  assert.equal(triggersOn('name: x\non: pull_request\njobs: {}\n', 'reopened'), true);
  assert.equal(triggersOn('name: x\non: [push, pull_request]\njobs: {}\n', 'opened'), true);
  assert.equal(triggersOn(on('  push:'), 'opened'), false);
  assert.equal(triggersOn('a: [unclosed', 'opened'), false);
  const both = on('  pull_request:\n    types: [ready_for_review]\n  pull_request_target:');
  assert.equal(triggersOn(both, 'ready_for_review'), true);
  assert.equal(triggersOn(both, 'opened'), true);
});

test('dogfood: this repository\'s own workflows audit clean with its own config', async () => {
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, 'this repo has a valid .claude/pipeline.yml');
  assert.equal(loaded.config.ci.draft_while_iterating, true);
  const out = auditDraftWorkflows(root, loaded.config);
  assert.deepEqual(out.map((a) => a.file), ['.github/workflows/ci.yml']);
  assert.deepEqual(out[0].produces, ['test (ubuntu)', 'test (windows)']);
  assert.deepEqual(out[0].missing, []);
  assert.deepEqual(draftWorkflowWarnings(out), []);
});

test('dogfood: the verify.yml template audits clean; pipeline-guards.yml has the prerequisites the guards workflow documents', () => {
  const tpl = (n) => readFileSync(join(root, 'pipeline', 'templates', 'workflows', n), 'utf8');
  assert.deepEqual(audit(tpl('verify.yml'), ['Verify']), { name: 'Verify', produces: ['Verify'], missing: [] });
  // The guards context is never audited via config, but its template still carries the trigger and concurrency conditions.
  const g = audit(tpl('pipeline-guards.yml'), ['pipeline-guards']);
  assert.deepEqual(g.produces, ['pipeline-guards']);
  assert.ok(!g.missing.some((c) => c.startsWith('no-')), `triggers/concurrency: ${g.missing}`);
  assert.equal(triggersOn(tpl('pipeline-guards.yml'), 'converted_to_draft'), true);
});

test('draftWorkflowWarnings: one line per file with findings, nothing for a clean audit', () => {
  assert.deepEqual(draftWorkflowWarnings([{ file: 'a.yml', name: 'A', produces: ['ci'], missing: [] }]), []);
  assert.deepEqual(draftWorkflowWarnings(null), []);
  const w = draftWorkflowWarnings([{ file: '.github/workflows/ci.yml', name: 'CI', produces: ['ci', 'ci2'], missing: ['no-ready_for_review', 'no-cancel-in-progress'] }]);
  assert.equal(w.length, 1);
  assert.match(w[0], /^draft-workflows: \.github\/workflows\/ci\.yml \(ci, ci2\)/);
  assert.match(w[0], /no-ready_for_review/);
  assert.match(w[0], /no-cancel-in-progress/);
});
