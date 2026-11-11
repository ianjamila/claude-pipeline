// CI entry for the workflow-context check: every expression in the project's .github/workflows files uses only the contexts GitHub
// allows at that key (e.g. no `runner.*` in a job-level `env:`). GitHub rejects a file that breaks this as a whole, and a
// workflow_run-only workflow then never runs at all: the only trace is an instant `push` failure with 0 jobs. That jammed a merge
// queue on 2026-11-10 (the queue-guards poster never posted its statuses). Rules and why: lib/workflow-contexts.mjs.
// Reads the workflow files as DATA (never runs anything from them), so a PR that breaks one fails its own required check.
// Run from the repo root (or pass --repo DIR); wire it into the project's required PR check: `node scripts/pipeline/workflow-contexts.mjs`.
// Exit codes: 0 clean (also a project with no workflow files), 1 findings (one line each: file, key, context; a file that is not
// valid YAML counts), 2 usage error or an unreadable directory.
// Vendored into projects by `pipeline vendor` (imports ./lib/*, which is the vendored copy of pipeline/lib).
import { statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scanWorkflowDir } from './lib/workflow-contexts.mjs';

// Returns the exit code; `io` is a seam for tests that import this module instead of spawning it.
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const cwd = io.cwd ?? process.cwd();
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { repo: { type: 'string' } }, allowPositionals: false }));
  } catch (e) {
    err(`workflow-contexts: ${e.message}\nusage: node scripts/pipeline/workflow-contexts.mjs [--repo DIR]`);
    return 2;
  }
  const root = resolve(cwd, values.repo ?? '.');
  let result;
  try {
    if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
    result = scanWorkflowDir(root);
  } catch (e) {
    err(`workflow-contexts: cannot read the workflows of ${root}: ${e.message}`);
    return 2;
  }
  if (result.findings.length > 0) {
    for (const f of result.findings) err(`  ${f}`);
    err(`\nworkflow-contexts: ${result.findings.length} finding(s) in ${result.checked} workflow file(s). Move the value into the step that needs it (a step allows every context but "jobs"; a step "if:" not "secrets"), and fix YAML that does not parse.`);
    return 1;
  }
  out(`workflow-contexts: ${result.checked} workflow file(s) checked, no disallowed contexts`);
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
