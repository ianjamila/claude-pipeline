// Every workflow template this pipeline ships passes the workflow-context check (lib/workflow-contexts.mjs). A template that
// breaks it would be rejected whole by GitHub in every project that copies it: queue-guards.yml once read `runner.temp` in a
// job-level env, so the Queue guards poster never ran and the merge queue jammed (2026-11-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
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

// The Verify template is the project's required PR check: it runs the vendored context check before the full verify, so a PR that
// breaks a workflow (even a workflow_run-only one, which never runs on the PR) fails its own check instead of jamming a queue.
export const verifyRunsContextCheckFirst = (yml) => {
  const check = yml.indexOf('node scripts/pipeline/workflow-contexts.mjs');
  const verify = yml.indexOf('node scripts/verify.mjs');
  return check !== -1 && verify !== -1 && check < verify;
};

test('verify.yml runs the workflow-context check before node scripts/verify.mjs', () => {
  assert.equal(verifyRunsContextCheckFirst(readFileSync(new URL('verify.yml', DIR), 'utf8')), true);
  // the helper is not vacuous: the order matters, and a template without the step fails it
  assert.equal(verifyRunsContextCheckFirst('- run: node scripts/verify.mjs\n- run: node scripts/pipeline/workflow-contexts.mjs\n'), false);
  assert.equal(verifyRunsContextCheckFirst('- run: node scripts/verify.mjs\n'), false);
});

// The Verify template skips drafts and cancels on conversion back to draft, so a repo built from it can turn on
// ci.draft_while_iterating (`pipeline redraft`): ready_for_review starts the first real run, converted_to_draft joins the PR's
// concurrency group (cancelling a running verify) while its own run skips the draft.
test('verify.yml skips drafts, runs at ready_for_review and cancels on converted_to_draft', () => {
  const wf = parseYaml(readFileSync(new URL('verify.yml', DIR), 'utf8'));
  const types = wf.on.pull_request.types;
  for (const t of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']) assert.ok(types.includes(t), t);
  assert.equal(wf.jobs.verify.if, '${{ !github.event.pull_request.draft }}');
  assert.match(wf.concurrency.group, /github\.event\.pull_request\.number/);
  assert.equal(wf.concurrency['cancel-in-progress'], true);
});

// A third-party action in a template runs in every project that copies it (queue-guards.yml with `statuses: write`): every `uses:` is pinned
// to a full commit SHA, never a movable tag. Local reusable workflows (`./...`) are the only exception.
for (const f of files) {
  test(`workflow template ${f} pins every action to a 40-hex commit SHA`, () => {
    const uses = [...readFileSync(new URL(f, DIR), 'utf8').matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    for (const u of uses) {
      if (u.startsWith('./')) continue;
      assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${u}`);
    }
  });
}

test('the SHA-pin check sees the actions of the templates (it is not vacuous)', () => {
  const all = files.flatMap((f) => [...readFileSync(new URL(f, DIR), 'utf8').matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]));
  assert.ok(all.length >= 8, all.join(', '));
  assert.ok(all.some((u) => u.startsWith('actions/upload-artifact@')));
});
