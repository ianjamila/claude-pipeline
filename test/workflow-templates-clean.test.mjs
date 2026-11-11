// Every workflow template this pipeline ships passes the workflow-context check (lib/workflow-contexts.mjs). A template that
// breaks it would be rejected whole by GitHub in every project that copies it: queue-guards.yml once read `runner.temp` in a
// job-level env, so the Queue guards poster never ran and the merge queue jammed (2026-11-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { workflowContextFindings } from '../pipeline/lib/workflow-contexts.mjs';

const DIR = new URL('../pipeline/templates/workflows/', import.meta.url);
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

test('the template directory has the workflows this test is meant to cover', () => {
  assert.ok(files.length >= 4, files.join(', '));
  for (const n of ['pipeline-guards.yml', 'queue-guards.yml', 'queue-intake.yml', 'verify.yml']) assert.ok(files.includes(n), n);
});

for (const f of files) {
  test(`workflow template ${f} uses only contexts GitHub allows at each key`, () => {
    const findings = workflowContextFindings(new Map([[f, readFileSync(new URL(f, DIR), 'utf8')]]));
    assert.deepEqual(findings, []);
  });
}
