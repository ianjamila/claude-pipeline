// CI entry for the two tamper-proof PR guards (test integrity, hard-stop scan). Runs from the repo root of a checkout of
// the BASE branch that has fetched the PR head, so neither this script nor .claude/pipeline.yml can be edited by the
// PR it judges. It reads git only: it never installs or runs anything from the PR.
// Fail closed: a missing/invalid config or any git error exits 2 (never 0), so a broken guard cannot pass a PR.
// Exit codes: 0 ok (or overridden by a human label), 1 violations/hits, 2 error.
// Vendored into projects by `pipeline vendor` (imports ./lib/*, which is the vendored copy of pipeline/lib).
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './lib/config.mjs';
import { diffFiles } from './lib/git.mjs';
import { collectHardStops } from './lib/hardstops.mjs';
import { checkIntegrity } from './lib/integrity.mjs';

export const INTEGRITY_LABEL = 'test-change-approved';
export const HARDSTOP_LABEL = 'human-approved';
const MAX_TABLE_ROWS = 50;
export const MAX_DESCRIPTION = 140; // GitHub commit-status descriptions are capped at 140 characters

class GuardUsageError extends Error {}

function parseLabels(raw) {
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function clip(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

// Markdown table cell: paths and excerpts come from the PR, so neutralise anything that could break the table or
// inject markup/HTML into the step summary.
function cell(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[|<>`]/g, (c) => ({ '|': '\\|', '<': '&lt;', '>': '&gt;', '`': "'" })[c]);
}

const describeItem = (item) => `${item.rule} ${item.file}`;

// One line for the commit status: the count plus the first offender, capped at 140 characters.
function describe(check, result) {
  const items = check === 'integrity' ? result.violations : result.hits;
  const noun = check === 'integrity' ? 'violation' : 'hard-stop';
  const plural = items.length === 1 ? noun : `${noun}s`;
  const overrideLabel = check === 'integrity' ? INTEGRITY_LABEL : HARDSTOP_LABEL;
  const overridden = check === 'integrity' ? result.overridden : result.approved;
  if (items.length === 0) return clip(check === 'integrity' ? 'No test-integrity violations' : 'No hard-stops', MAX_DESCRIPTION);
  if (overridden) return clip(`${items.length} ${plural}, approved by label ${overrideLabel}`, MAX_DESCRIPTION);
  return clip(`${items.length} ${plural}: ${describeItem(items[0])}`, MAX_DESCRIPTION);
}

export function renderSummary(check, result) {
  const integrity = check === 'integrity';
  const items = integrity ? result.violations : result.hits;
  const title = integrity ? 'Test integrity' : 'Hard-stop scan';
  const noun = integrity ? 'violation' : 'hard-stop';
  const overridden = integrity ? result.overridden : result.approved;
  const label = integrity ? INTEGRITY_LABEL : HARDSTOP_LABEL;
  const lines = [`## ${title}`, ''];
  if (items.length === 0) lines.push(`Passed: no ${noun}s found.`);
  else if (overridden) lines.push(`Passed by override: ${items.length} ${noun}(s) found, approved by the owner via label \`${label}\`.`);
  else lines.push(`Failed: ${items.length} ${noun}(s) found.`);
  if (items.length > 0) {
    lines.push('', '| Rule | File | Line | Detail |', '| --- | --- | --- | --- |');
    for (const it of items.slice(0, MAX_TABLE_ROWS)) {
      lines.push(`| ${cell(it.rule)} | ${cell(it.file)} | ${it.line ?? ''} | ${cell(integrity ? it.excerpt : (it.detail ?? it.excerpt))} |`);
    }
    if (items.length > MAX_TABLE_ROWS) lines.push('', `...and ${items.length - MAX_TABLE_ROWS} more not shown.`);
    if (!overridden) lines.push('', `Override: owner adds label \`${label}\`.`);
  }
  return `${lines.join('\n')}\n`;
}

// `labels` are the approval labels that STILL COUNT for `head`: ci-guards-run.mjs passes only labels that carry a valid
// receipt for exactly this head sha (see its header); this function never decides who may approve or when.
// Evaluates one check against a base..head range. Used by the CLI below and by ci-guards-run.mjs (the workflow
// orchestrator). Never throws: any problem becomes exitCode 2 (fail closed).
// Returns { exitCode, output, description, summary }. IO (git, config) is injectable for tests.
export async function runCheck({ check, base, head, labels = [], cwd = process.cwd(), deps = {} }) {
  const ctx = { check };
  try {
    if (check !== 'integrity' && check !== 'hardstops') throw new GuardUsageError('--check must be integrity or hardstops');
    if (!base) throw new GuardUsageError('missing --base');
    if (!head) throw new GuardUsageError('missing --head');

    const loaded = await (deps.loadConfig ?? loadConfig)(cwd);
    if (!loaded.ok) {
      return fail(new Error(`invalid or missing .claude/pipeline.yml: ${loaded.errors.join('; ')}`), ctx, 'config');
    }
    const config = loaded.config;

    let result;
    if (check === 'integrity') {
      const files = (deps.diffFiles ?? diffFiles)(base, head, { cwd });
      const r = checkIntegrity({ files, config, labels });
      result = { check, ok: r.ok, overridden: r.overridden, violations: r.violations, base, head };
    } else {
      const hits = await (deps.collectHardStops ?? collectHardStops)({ base, head, cwd, config });
      const approved = labels.includes(HARDSTOP_LABEL);
      result = { check, ok: hits.length === 0 || approved, approved, hits, base, head };
    }
    return { exitCode: result.ok ? 0 : 1, output: result, description: describe(check, result), summary: renderSummary(check, result) };
  } catch (err) {
    return fail(err, ctx);
  }
}

// CLI: parses argv, then delegates to runCheck.
export async function runGuard(argv, { cwd = process.cwd(), deps = {} } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
        labels: { type: 'string' }, 'description-file': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    return fail(new GuardUsageError(err.message), {});
  }
  const r = await runCheck({ check: values.check, base: values.base, head: values.head, labels: parseLabels(values.labels), cwd, deps });
  return { ...r, descriptionFile: values['description-file'] };
}

function fail(err, ctx, error = err instanceof GuardUsageError ? 'usage' : 'guard-error') {
  const message = String(err?.message ?? err);
  return {
    exitCode: 2,
    output: { ok: false, error, ...(ctx.check ? { check: ctx.check } : {}), message },
    description: clip(`Guard error: ${message}`, MAX_DESCRIPTION),
    summary: `## ${ctx.check === 'hardstops' ? 'Hard-stop scan' : 'Test integrity'}\n\nGuard error (fails closed): ${cell(message)}\n`,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const r = await runGuard(argv);
  process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
  // The verdict is already decided; a failure to write the side outputs must not change it (or hide it).
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${r.summary}\n`); } catch (err) { process.stderr.write(`could not write step summary: ${err.message}\n`); }
  }
  if (r.descriptionFile) {
    try { writeFileSync(r.descriptionFile, `${r.description}\n`); } catch (err) { process.stderr.write(`could not write description file: ${err.message}\n`); }
  }
  return r.exitCode;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; });
}
