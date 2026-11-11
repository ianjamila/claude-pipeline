// Expression contexts GitHub allows at each workflow key. Vendored into projects (scripts/pipeline/lib/), where the CLI entry
// scripts/pipeline/workflow-contexts.mjs runs it over the project's own .github/workflows.
//
// Input: Map<basename, yaml text> of every .github/workflows file. Output: findings (strings); empty = clean. A file that is not
// valid YAML is a finding too (GitHub rejects it just the same).
// GitHub rejects a WHOLE workflow file whose expression uses a context the key does not allow
// (docs: "Contexts → Context availability"), e.g. `runner.temp` in a job-level `env:`. Such a file never
// runs on its real trigger; on every push it shows up only as an instant `push` failure with 0 jobs
// ("This run likely failed because of a workflow file issue"). That is how the queue-guards.yml template jammed
// a project's merge queue on 2026-11-10: its job-level env read `runner.temp`, so the Queue guards poster never ran.
//
// Scope: every key in GitHub's table whose availability is narrower than a step's: workflow-level env /
// concurrency / run-name, on.workflow_call input defaults and output values, and the job-level keys below,
// including a reusable-workflow call's job-level `with:` and `secrets:` (narrower than a step's `with:`) and
// container / services; plus steps and job `outputs`, which allow every context EXCEPT `jobs` (only a
// workflow_call output value may read it), and a step `if:`, which does not allow `secrets` either. Only the named contexts below count (case-insensitive, as GitHub resolves them), with or
// without a property access (`runner.temp`, `runner['temp']`, `toJSON(runner)`); function names, string
// literals and property names never count. Not covered: special functions outside their keys (e.g.
// `hashFiles` outside steps) — a separate rule set. Real YAML parsing (vendored js-yaml, JSON schema).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';

export const CONTEXTS = ['github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy', 'matrix', 'needs', 'inputs'];

const JOB = ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'];
const CONTAINER_ENV = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'inputs'];
const ALL_BUT_JOBS = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs'];
const CREDENTIALS = ['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'secrets', 'inputs'];

// Allowed contexts per key, from GitHub's context-availability table.
export const ALLOWED = {
  'env': ['github', 'secrets', 'inputs', 'vars'],
  'concurrency': ['github', 'inputs', 'vars'],
  'run-name': ['github', 'inputs', 'vars'],
  'on.workflow_call.inputs.<id>.default': ['github', 'inputs', 'vars'],
  'on.workflow_call.outputs.<id>.value': ['github', 'jobs', 'vars', 'inputs'],
  'jobs.<id>.if': ['github', 'needs', 'vars', 'inputs'],
  'jobs.<id>.env': ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'],
  'jobs.<id>.name': JOB,
  'jobs.<id>.runs-on': JOB,
  'jobs.<id>.timeout-minutes': JOB,
  'jobs.<id>.continue-on-error': JOB,
  'jobs.<id>.concurrency': JOB,
  'jobs.<id>.environment': JOB,
  'jobs.<id>.environment.url': ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs'],
  'jobs.<id>.strategy': ['github', 'needs', 'vars', 'inputs'],
  'jobs.<id>.with.<id>': JOB,
  'jobs.<id>.secrets.<id>': ['github', 'needs', 'strategy', 'matrix', 'secrets', 'inputs', 'vars'],
  'jobs.<id>.defaults.run': ['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'inputs'],
  'jobs.<id>.container': JOB,
  'jobs.<id>.container.credentials': CREDENTIALS,
  'jobs.<id>.container.env.<id>': CONTAINER_ENV,
  'jobs.<id>.services': JOB,
  'jobs.<id>.services.<id>.credentials': CREDENTIALS,
  'jobs.<id>.services.<id>.env.<id>': CONTAINER_ENV,
  'jobs.<id>.outputs.<id>': ALL_BUT_JOBS,
  'jobs.<id>.steps.if': ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs'],
  'jobs.<id>.steps.<key>': ALL_BUT_JOBS,
};

// Quote-aware: a `}}` inside a string literal does not end the expression (GitHub reads it the same way).
// The three alternatives never overlap (a quote only starts a string; `}` only alone), so an unclosed `${{` fails in
// linear time instead of backtracking over every pairing of the quotes after it (review R3). A `''` escape reads as
// two adjacent strings: the same end as GitHub's quote toggle.
const EXPR = /\$\{\{((?:'[^']*'|[^'}]|\}(?!\}))*)\}\}/g;

/** Context names used in one expression body (lower-cased; string literals removed first). */
export function contextsIn(expr) {
  // GitHub ignores whitespace between tokens: `inputs. runner` reads the property `runner`, so a dot swallows the whitespace
  // after it (starts only at a dot, so linear) before the lookbehind below judges the name.
  const bare = String(expr).replace(/'(?:[^']|'')*'/g, "''").replace(/\.\s+/g, ".");
  const out = new Set();
  // A name not preceded by a property dot / word char, and not a function call (followed by `(`).
  for (const m of bare.matchAll(/(?<![\w.-])([A-Za-z_][\w-]*)(?![\w-])(?!\s*\()/g)) {
    const name = m[1].toLowerCase();
    if (CONTEXTS.includes(name)) out.add(name);
  }
  return [...out];
}

/** Every string leaf under a value (env maps, concurrency objects, runs-on arrays). */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Context names a value uses. `if:` may be a bare expression without `${{ }}`. */
function used(value, { bareIf = false } = {}) {
  const found = new Set();
  for (const s of strings(value)) {
    const bodies = [...s.matchAll(EXPR)].map((m) => m[1]);
    if (bareIf && bodies.length === 0) bodies.push(s);
    for (const b of bodies) for (const c of contextsIn(b)) found.add(c);
  }
  return [...found];
}

function check(findings, file, where, key, value, opts) {
  if (value === undefined) return;
  const allowed = ALLOWED[key];
  for (const c of used(value, opts)) {
    if (!allowed.includes(c)) {
      findings.push(`${file}: ${where} uses \`${c}\` — GitHub allows only ${allowed.join(', ')} there, so it rejects the whole file`);
    }
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** container / one service: credentials and env have their own lists, every other key (image, options …) the base one. */
function checkContainer(findings, file, where, keyBase, value) {
  const base = keyBase === 'jobs.<id>.container' ? keyBase : 'jobs.<id>.services';
  if (!isObj(value)) return check(findings, file, where, base, value);
  for (const [k, v] of Object.entries(value)) {
    if (k === 'credentials') check(findings, file, `${where}.credentials`, `${keyBase}.credentials`, v);
    else if (k === 'env') check(findings, file, `${where}.env`, `${keyBase}.env.<id>`, v);
    else check(findings, file, `${where}.${k}`, base, v);
  }
}

export function workflowContextFindings(files) {
  const findings = [];
  for (const [file, text] of files) {
    let doc;
    try {
      doc = parseYaml(text);
    } catch (e) {
      findings.push(`${file}: not valid YAML (${e.message.split('\n')[0]})`);
      continue;
    }
    if (!isObj(doc)) continue;
    for (const key of ['env', 'concurrency', 'run-name']) check(findings, file, key, key, doc[key]);
    const call = isObj(doc.on) && isObj(doc.on.workflow_call) ? doc.on.workflow_call : null;
    if (call) {
      for (const [id, inp] of Object.entries(isObj(call.inputs) ? call.inputs : {})) {
        if (isObj(inp)) check(findings, file, `on.workflow_call.inputs.${id}.default`, 'on.workflow_call.inputs.<id>.default', inp.default);
      }
      for (const [id, out] of Object.entries(isObj(call.outputs) ? call.outputs : {})) {
        if (isObj(out)) check(findings, file, `on.workflow_call.outputs.${id}.value`, 'on.workflow_call.outputs.<id>.value', out.value);
      }
    }
    const jobs = isObj(doc.jobs) ? doc.jobs : {};
    for (const [id, job] of Object.entries(jobs)) {
      if (!isObj(job)) continue;
      const at = (k) => `jobs.${id}.${k}`;
      for (const k of ['if', 'env', 'name', 'runs-on', 'timeout-minutes', 'continue-on-error', 'concurrency', 'strategy']) {
        check(findings, file, at(k), `jobs.<id>.${k}`, job[k], { bareIf: k === 'if' });
      }
      if (isObj(job.environment)) {
        const { url, ...rest } = job.environment;
        check(findings, file, at('environment'), 'jobs.<id>.environment', rest);
        check(findings, file, at('environment.url'), 'jobs.<id>.environment.url', url);
      } else {
        check(findings, file, at('environment'), 'jobs.<id>.environment', job.environment);
      }
      check(findings, file, at('with'), 'jobs.<id>.with.<id>', job.with);
      check(findings, file, at('secrets'), 'jobs.<id>.secrets.<id>', job.secrets === 'inherit' ? undefined : job.secrets);
      if (isObj(job.defaults)) check(findings, file, at('defaults.run'), 'jobs.<id>.defaults.run', job.defaults.run);
      if (job.container !== undefined) checkContainer(findings, file, at('container'), 'jobs.<id>.container', job.container);
      if (job.services !== undefined && !isObj(job.services)) check(findings, file, at('services'), 'jobs.<id>.services', job.services);
      for (const [sid, svc] of Object.entries(isObj(job.services) ? job.services : {})) {
        checkContainer(findings, file, at(`services.${sid}`), 'jobs.<id>.services.<id>', svc);
      }
      check(findings, file, at('outputs'), 'jobs.<id>.outputs.<id>', job.outputs);
      const steps = Array.isArray(job.steps) ? job.steps : [];
      steps.forEach((step, i) => {
        if (!isObj(step)) return;
        const name = `steps[${step.id ?? i}]`;
        check(findings, file, at(`${name}.if`), 'jobs.<id>.steps.if', step.if, { bareIf: true });
        for (const [k, v] of Object.entries(step)) {
          if (k === 'if' || k === 'uses' || k === 'id') continue;
          check(findings, file, at(`${name}.${k}`), 'jobs.<id>.steps.<key>', v);
        }
      });
    }
  }
  return findings;
}

const WORKFLOW_FILE = /\.ya?ml$/;

// Reads <root>/.github/workflows/*.yml|*.yaml (sorted, regular files only) and checks them: { checked, findings }. A project
// without that directory has zero workflow files, which is not an error; any other read failure throws (the CLI exits 2).
export function scanWorkflowDir(root) {
  const dir = join(root, '.github', 'workflows');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e?.code === 'ENOENT') return { checked: 0, findings: [] };
    throw e;
  }
  const files = new Map(
    entries
      .filter((e) => e.isFile() && WORKFLOW_FILE.test(e.name))
      .map((e) => e.name)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
  );
  return { checked: files.size, findings: workflowContextFindings(files) };
}
