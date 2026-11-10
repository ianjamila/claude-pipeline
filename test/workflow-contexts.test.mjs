// Every workflow template (and this repo's own workflows) only uses expression contexts GitHub allows at the key it sits in.
// GitHub rejects the WHOLE file when a key uses a context it does not allow there (docs: "Contexts -> Context availability"), e.g.
// `runner.temp` in a job-level `env:`. Such a workflow never runs on its real trigger; on every push it shows up only as an instant
// `push` failure with 0 jobs. That is how a project's queue-guards.yml jammed its merge queue on 2026-11-10: its job-level env read
// `runner.temp`, so the Queue guards poster never ran (eaglewatch-ph/eaglewatch#1787). Only a real GitHub run proves a file loads;
// this catches the class from the YAML alone.
//
// Scope: the keys whose availability is narrower than a step's: workflow-level env / concurrency / run-name, and a job's
// if / env / name / runs-on / timeout-minutes / continue-on-error / concurrency / strategy / environment. Steps, `with:`, job
// `outputs`, `services` and `container` are not checked. Only the named contexts below count, so function names (`contains(`),
// string literals and step ids never do. A bare context (`toJSON(runner)`) counts the same as `runner.temp`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONTEXTS = ['github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy', 'matrix', 'needs', 'inputs'];

// Allowed contexts per key, from GitHub's context-availability table.
const ALLOWED = {
  'env': ['github', 'secrets', 'inputs', 'vars'],
  'concurrency': ['github', 'inputs', 'vars'],
  'run-name': ['github', 'inputs', 'vars'],
  'jobs.<id>.if': ['github', 'needs', 'vars', 'inputs'],
  'jobs.<id>.env': ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'],
  'jobs.<id>.name': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'jobs.<id>.runs-on': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'jobs.<id>.timeout-minutes': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'jobs.<id>.continue-on-error': ['github', 'needs', 'strategy', 'vars', 'matrix', 'inputs'],
  'jobs.<id>.concurrency': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'jobs.<id>.environment': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'jobs.<id>.environment.url': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs', 'job', 'runner', 'env', 'steps'],
  'jobs.<id>.strategy': ['github', 'needs', 'vars', 'inputs'],
};

const EXPR = /\$\{\{([\s\S]*?)\}\}/g;

/** Context names used in one expression body: `runner.temp`, `runner['temp']` and a bare `toJSON(runner)` alike. */
function contextsIn(expr) {
  const bare = String(expr).replace(/'(?:[^']|'')*'/g, "''"); // string literals are not references
  const out = new Set();
  // An identifier not reached through `.` (a property such as `needs.runner.result` is not the context) and not a function call.
  for (const m of bare.matchAll(/(?<![\w.-])([A-Za-z_][\w-]*)(?!\s*\()(?![\w-])/g)) {
    if (CONTEXTS.includes(m[1])) out.add(m[1]);
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

/** Context names a key's value uses. `if:` may be a bare expression without `${{ }}`. */
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
  const allowed = ALLOWED[key];
  for (const c of used(value, opts)) {
    if (!allowed.includes(c)) findings.push(`${file}: ${where} uses \`${c}\`, GitHub allows only ${allowed.join(', ')} there, so it rejects the whole file`);
  }
}

/** @param {Map<string, string>|[string, string][]} files basename -> YAML text. @returns {string[]} findings; empty = clean. */
function workflowContextFindings(files) {
  const findings = [];
  for (const [file, text] of files) {
    let doc;
    try {
      doc = parseYaml(text);
    } catch (e) {
      findings.push(`${file}: not valid YAML (${e.message.split('\n')[0]})`);
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    for (const key of ['env', 'concurrency', 'run-name']) {
      if (doc[key] !== undefined) check(findings, file, key, key, doc[key]);
    }
    const jobs = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
    for (const [id, job] of Object.entries(jobs)) {
      if (!job || typeof job !== 'object') continue;
      for (const k of ['if', 'env', 'name', 'runs-on', 'timeout-minutes', 'continue-on-error', 'concurrency', 'strategy']) {
        if (job[k] === undefined) continue;
        check(findings, file, `jobs.${id}.${k}`, `jobs.<id>.${k}`, job[k], { bareIf: k === 'if' });
      }
      const env = job.environment;
      if (env === undefined) continue;
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        for (const [k, v] of Object.entries(env)) {
          // `url` sees more contexts than the environment's name does.
          if (k === 'url') check(findings, file, `jobs.${id}.environment.url`, 'jobs.<id>.environment.url', v);
          else check(findings, file, `jobs.${id}.environment.${k}`, 'jobs.<id>.environment', v);
        }
      } else check(findings, file, `jobs.${id}.environment`, 'jobs.<id>.environment', env);
    }
  }
  return findings;
}

const wf = (text) => workflowContextFindings([['x.yml', text]]);
const job = (body) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n${body}\n    steps:\n      - run: echo\n`;

// ---- the real files ---------------------------------------------------------------------------------------------------------

test('every workflow template and this repo\'s own workflows use only contexts GitHub allows at each key', () => {
  const files = [];
  for (const dir of ['pipeline/templates/workflows', '.github/workflows']) {
    for (const f of readdirSync(join(root, dir)).filter((n) => /\.ya?ml$/.test(n))) files.push([`${dir}/${f}`, readFileSync(join(root, dir, f), 'utf8')]);
  }
  assert.ok(files.length >= 5, 'the templates and the repo workflows were found');
  assert.deepEqual(workflowContextFindings(files), []);
});

// ---- the checker itself -----------------------------------------------------------------------------------------------------

test('contexts: the runner context in a job-level env is flagged (the 2026-11-10 queue-guards bug)', () => {
  const f = wf(job('    env:\n      DIR: ${{ runner.temp }}/queue-verdict'));
  assert.equal(f.length, 1);
  assert.match(f[0], /jobs\.j\.env uses `runner`/);
});

test('contexts: a bare context is caught as well as runner.x / runner[...]', () => {
  assert.equal(wf(job('    env:\n      A: ${{ toJSON(runner) }}')).length, 1, 'bare in a function call');
  assert.equal(wf(job("    env:\n      A: ${{ runner['temp'] }}")).length, 1, 'bracket access');
  assert.equal(wf(job('    env:\n      A: ${{ format(\'{0}\', steps) }}')).length, 1, 'another context, bare');
});

test('contexts: workflow-level env / concurrency / run-name allow only github, secrets (env only), inputs and vars', () => {
  const top = (key, expr) => `on: push\n${key}: ${expr}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
  assert.equal(wf(top('run-name', '"${{ github.actor }} ${{ vars.X }}"')).length, 0);
  assert.equal(wf(top('run-name', '"${{ env.X }}"')).length, 1);
  assert.equal(wf(top('concurrency', '"${{ secrets.X }}"')).length, 1);
  assert.equal(wf(top('env', '{ A: "${{ secrets.X }}" }')).length, 0);
  assert.equal(wf(top('env', '{ A: "${{ env.B }}" }')).length, 1);
});

test('contexts: job-level if (with or without ${{ }}), name, runs-on, timeout-minutes, continue-on-error, concurrency, strategy', () => {
  assert.equal(wf(job("    if: github.event_name == 'push' && needs.x.result == 'success'")).length, 0);
  assert.equal(wf(job('    if: runner.os == \'Linux\'')).length, 1, 'bare if expression');
  assert.equal(wf(job('    if: ${{ env.X }}')).length, 1);
  assert.equal(wf(job('    name: "${{ matrix.os }}"')).length, 0);
  assert.equal(wf(job('    name: "${{ steps.a.outputs.b }}"')).length, 1);
  assert.equal(wf(job('    timeout-minutes: ${{ fromJSON(runner.x) }}')).length, 1);
  assert.equal(wf(job('    continue-on-error: ${{ matrix.experimental }}')).length, 0);
  assert.equal(wf(job('    concurrency: { group: "${{ job.status }}" }')).length, 1);
  assert.equal(wf(job('    strategy: { matrix: { os: ["${{ matrix.x }}"] } }')).length, 1, 'strategy itself does not see matrix');
  assert.equal(wf(job('    env:\n      A: ${{ secrets.X }} ${{ matrix.y }} ${{ needs.a.outputs.b }}')).length, 0);
});

test('contexts: environment.name allows less than environment.url (url also sees job, runner, env, steps)', () => {
  assert.equal(wf(job('    environment:\n      name: prod\n      url: "${{ steps.deploy.outputs.url }}/${{ runner.name }}/${{ env.X }}/${{ job.status }}"')).length, 0);
  assert.equal(wf(job('    environment:\n      name: "${{ env.X }}"\n      url: https://x')).length, 1);
  assert.equal(wf(job('    environment: "${{ runner.os }}"')).length, 1, 'the short form is the name');
});

test('contexts: string literals, function names, property names and step-level uses are not references', () => {
  assert.equal(wf(job("    env:\n      A: ${{ contains('runner env steps', github.ref) }}")).length, 0, 'inside a string literal');
  assert.equal(wf(job('    env:\n      A: ${{ needs.runner.outputs.env }}')).length, 0, 'property names after a dot');
  assert.equal(wf(job('    env:\n      A: ${{ format(\'{0}\', github.sha) }}')).length, 0, 'function names');
  const step = 'on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n        env: { D: "${{ runner.temp }}" }\n        with: { p: "${{ runner.temp }}" }\n';
  assert.equal(wf(step).length, 0, 'steps may use runner');
});

test('contexts: invalid YAML is a finding, not a crash', () => {
  assert.match(wf('a: [')[0], /not valid YAML/);
});
