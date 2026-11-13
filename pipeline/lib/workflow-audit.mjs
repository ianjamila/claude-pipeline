// Draft-while-iterating prerequisite audit (warn-only). `ci.draft_while_iterating: true` is safe only when every heavy REQUIRED
// workflow (a) skips drafts, (b) lists `ready_for_review` and `converted_to_draft` in its pull_request / pull_request_target
// `types` (a bare `pull_request:` gets neither: the default types are opened, synchronize, reopened) and (c) puts one PR's runs
// in one concurrency group with cancel-in-progress, so the converted_to_draft run cancels a running suite.
// Pure over workflow text; reads .github/workflows only in auditDraftWorkflows. No expression evaluator: only the proven
// draft-skip spellings below count, any other mention of `draft` is reported as unverified, never as passing.
// Not vendored: preflight and `vendor --check` both run from the pipeline install.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { PROVENANCE_CHECKS, requiredChecks } from './config.mjs';

const PR_EVENTS = ['pull_request', 'pull_request_target'];
// GitHub's defaults when a pull_request trigger lists no `types`.
export const DEFAULT_PR_TYPES = Object.freeze(['opened', 'synchronize', 'reopened']);

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);

// `on:` in its string / array / map forms -> { pullRequest: { types: string[] | null } | null }. `types: null` = the defaults. When both
// pull_request and pull_request_target are present the lists are merged (the defaults stand in for a missing list).
function triggersOf(on) {
  const found = new Map();
  if (typeof on === 'string') { if (PR_EVENTS.includes(on)) found.set(on, null); }
  else if (Array.isArray(on)) { for (const e of on) if (PR_EVENTS.includes(e)) found.set(e, null); }
  else if (isMap(on)) {
    for (const e of PR_EVENTS) {
      if (!Object.hasOwn(on, e)) continue;
      const cfg = on[e];
      found.set(e, isMap(cfg) && cfg.types != null ? asList(cfg.types) : null);
    }
  }
  if (found.size === 0) return { pullRequest: null };
  const lists = [...found.values()];
  if (lists.every((l) => l === null)) return { pullRequest: { types: null } };
  const merged = new Set();
  for (const l of lists) for (const t of l ?? DEFAULT_PR_TYPES) merged.add(t);
  return { pullRequest: { types: [...merged] } };
}

function concurrencyOf(c) {
  if (typeof c === 'string') return { group: c, cancelInProgress: undefined };
  if (isMap(c)) return { group: c.group == null ? '' : String(c.group), cancelInProgress: c['cancel-in-progress'] };
  return null;
}

// Parsed facts of one workflow file; throws on invalid YAML.
export function workflowFacts(text) {
  const doc = parseYaml(text);
  const root = isMap(doc) ? doc : {};
  const jobs = isMap(root.jobs) ? Object.entries(root.jobs).filter(([, j]) => isMap(j)).map(([id, j]) => ({
    id,
    name: typeof j.name === 'string' ? j.name : null,
    needs: asList(j.needs),
    ifText: j.if === undefined ? null : String(j.if),
    matrix: isMap(j.strategy) && isMap(j.strategy.matrix) ? j.strategy.matrix : null,
    concurrency: concurrencyOf(j.concurrency),
  })) : [];
  return {
    name: typeof root.name === 'string' ? root.name : null,
    triggers: triggersOf(root.on),
    concurrency: concurrencyOf(root.concurrency),
    jobs,
  };
}

// Does the workflow run for this pull_request activity type (`ready_for_review`, `synchronize` ...)? A workflow with no
// pull_request / pull_request_target trigger, or that is not valid YAML, does not.
export function triggersOn(text, event) {
  let facts;
  try { facts = workflowFacts(text); } catch { return false; }
  const pr = facts.triggers.pullRequest;
  return pr !== null && (pr.types ?? DEFAULT_PR_TYPES).includes(event);
}

// ---- check names a workflow produces ----------------------------------------------------------------------------------------
const MATRIX_REF = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g;
const matrixDims = (m) => Object.entries(m).filter(([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v));

// What GitHub calls the check a job reports: its `name` (id when unnamed); a matrix job with `${{ matrix.k }}` in its name
// has them substituted per combination, a matrix job without one gets `name (v1, v2)` appended.
export function jobCheckNames(job) {
  const base = job.name ?? job.id;
  if (!job.matrix) return [base];
  const dims = matrixDims(job.matrix);
  if (dims.length === 0) return [base];
  const refs = [...base.matchAll(MATRIX_REF)].map((m) => m[1]);
  if (refs.length === 0) {
    // Cartesian product, first key varying slowest.
    let combos = [[]];
    for (const [, values] of dims) combos = combos.flatMap((c) => values.map((v) => [...c, v]));
    return combos.map((c) => `${base} (${c.join(', ')})`);
  }
  const keys = [...new Set(refs)];
  const lists = keys.map((k) => dims.find(([d]) => d === k)?.[1]);
  if (lists.some((l) => !l)) return [base];
  let combos = [{}];
  for (let i = 0; i < keys.length; i++) combos = combos.flatMap((c) => lists[i].map((v) => ({ ...c, [keys[i]]: v })));
  return combos.map((c) => base.replace(MATRIX_REF, (_, k) => String(c[k])));
}

// ---- draft-skip recognition (R6) ---------------------------------------------------------------------------------------------
const norm = (s) => s.replace(/\$\{\{|\}\}/g, ' ').replace(/!\s+/g, '!').replace(/\s+/g, ' ').trim();
const NOT_DRAFT = '!github.event.pull_request.draft';
const PROVEN = [
  NOT_DRAFT,
  'github.event.pull_request.draft == false',
  `github.event_name != 'pull_request' || ${NOT_DRAFT}`, // push, or a PR that is not a draft
];

// Split at depth-0 occurrences of `op` (outside quotes). Returns null when a paren or quote is unbalanced.
function splitTop(s, op) {
  const parts = [];
  let depth = 0; let quote = null; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return null; }
    else if (depth === 0 && s.startsWith(op, i)) { parts.push(s.slice(start, i)); i += op.length - 1; start = i + 1; }
  }
  if (depth !== 0 || quote) return null;
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
}
function unwrap(s) {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    const inner = t.slice(1, -1);
    if (splitTop(inner, '&&') === null) break; // the outer parens did not pair up with each other
    t = inner.trim();
  }
  return t;
}
const unquote = (s) => s.replace(/"/g, "'");

// 'proven' | 'unverified' | 'none' for one job `if`.
export function draftSkipKind(ifText) {
  if (ifText == null) return 'none';
  const e = unquote(norm(ifText));
  if (!/draft/i.test(e)) return 'none';
  if (/\balways\s*\(/i.test(e)) return 'unverified';
  const whole = unwrap(e);
  if (PROVEN.includes(whole)) return 'proven';
  if (splitTop(whole, '||')?.length === 1) {
    const terms = splitTop(whole, '&&');
    if (terms && terms.length > 1 && terms.some((t) => PROVEN.includes(unwrap(t)))) return 'proven';
  }
  return 'unverified';
}

// ---- concurrency -------------------------------------------------------------------------------------------------------------
const PR_GROUP_KEY = /pull_request\.number|head_ref|github\.ref/;
const groupOk = (c) => PR_GROUP_KEY.test(c.group);
// true / 'true' / an expression that is exactly "this is a pull_request event" (ci.yml's own spelling); any other expression is
// not provably true and counts as missing.
function cancelOk(c) {
  const v = c.cancelInProgress;
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  const e = unquote(norm(v));
  return e === 'true' || e === "github.event_name == 'pull_request'";
}

// ---- the audit ---------------------------------------------------------------------------------------------------------------
function ancestorsOf(job, byId) {
  const seen = new Set();
  const stack = [...job.needs];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    stack.push(...byId.get(id).needs);
  }
  return [...seen].map((id) => byId.get(id));
}

// One workflow's audit entry, or null when it produces none of the required checks (or has no pull_request trigger).
export function auditWorkflowText(text, required) {
  const facts = workflowFacts(text);
  const byId = new Map(facts.jobs.map((j) => [j.id, j]));
  const producing = facts.jobs.map((j) => ({ job: j, names: jobCheckNames(j).filter((n) => required.includes(n)) })).filter((p) => p.names.length > 0);
  const pr = facts.triggers.pullRequest;
  if (producing.length === 0 || pr === null) return null;
  const missing = new Set();

  // draft-skip: per producing job, its own `if` or any `needs` ancestor's (an ancestor's skip makes this job skip too).
  let unverified = false; let absent = false;
  for (const { job } of producing) {
    const chain = [job, ...ancestorsOf(job, byId)].map((j) => draftSkipKind(j.ifText));
    if (chain.includes('proven')) continue;
    if (chain.includes('unverified')) unverified = true; else absent = true;
  }
  if (absent) missing.add('draft-skip');
  if (unverified) missing.add('draft-skip-unverified');

  const types = pr.types ?? DEFAULT_PR_TYPES;
  if (!types.includes('ready_for_review')) missing.add('no-ready_for_review');
  if (!types.includes('converted_to_draft')) missing.add('no-converted_to_draft');

  for (const { job } of producing) {
    const levels = [facts.concurrency, job.concurrency].filter(Boolean);
    const grouped = levels.filter(groupOk);
    if (grouped.length === 0) missing.add('no-pr-concurrency-group');
    if (!(grouped.length ? grouped : levels).some(cancelOk)) missing.add('no-cancel-in-progress');
  }
  const order = ['draft-skip', 'draft-skip-unverified', 'no-ready_for_review', 'no-converted_to_draft', 'no-pr-concurrency-group', 'no-cancel-in-progress'];
  return { name: facts.name, produces: [...new Set(producing.flatMap((p) => p.names))], missing: order.filter((c) => missing.has(c)) };
}

// The required checks the audit looks at: configured ones, never the pipeline's own guard / review contexts.
export function auditedChecks(ci) {
  return requiredChecks(ci).filter((c) => !PROVENANCE_CHECKS.includes(c));
}

// [{ file, name, produces, missing }] for every workflow under <root>/.github/workflows that produces a required check, or
// { file, unparsable: true } for one that is not valid YAML. A missing directory audits nothing.
export function auditDraftWorkflows(root, config) {
  const dir = join(root, '.github', 'workflows');
  const required = auditedChecks(config?.ci);
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.ya?ml$/.test(e.name)).map((e) => e.name).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = `.github/workflows/${n}`;
    let text;
    try { text = readFileSync(join(dir, n), 'utf8'); } catch { out.push({ file, unparsable: true }); continue; }
    try {
      const entry = auditWorkflowText(text, required);
      if (entry) out.push({ file, ...entry });
    } catch { out.push({ file, unparsable: true }); }
  }
  return out;
}

const REMEDY = {
  'draft-skip': 'no job that produces a required check skips drafts (add `if: ${{ !github.event.pull_request.draft }}`)',
  'draft-skip-unverified': 'the draft skip is not one of the recognised spellings, so it is unverified (use `!github.event.pull_request.draft`, `github.event.pull_request.draft == false`, or `github.event_name != \'pull_request\' || !github.event.pull_request.draft`, alone or `&&`-joined; `always()` hides it)',
  'no-ready_for_review': 'pull_request `types` lacks ready_for_review (a bare `pull_request:` gets only opened/synchronize/reopened)',
  'no-converted_to_draft': 'pull_request `types` lacks converted_to_draft',
  'no-pr-concurrency-group': 'the concurrency group has no per-PR key (pull_request.number, head_ref or github.ref)',
  'no-cancel-in-progress': 'concurrency lacks a literal `cancel-in-progress: true` (an expression other than `github.event_name == \'pull_request\'` is not provably true)',
};

// One warning line per file with findings. Empty for a clean audit.
export function draftWorkflowWarnings(audit) {
  const out = [];
  for (const a of audit ?? []) {
    if (a.unparsable) out.push(`draft-workflows: ${a.file} is not valid YAML, so it could not be audited for ci.draft_while_iterating`);
    else if (a.missing.length) out.push(`draft-workflows: ${a.file} (${a.produces.join(', ')}) is not ready for ci.draft_while_iterating: ${a.missing.map((c) => `${c}: ${REMEDY[c]}`).join('; ')}`);
  }
  return out;
}
