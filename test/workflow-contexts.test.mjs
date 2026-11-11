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

// Same rules as eaglewatch-ph/eaglewatch scripts/lib/workflow-contexts.mjs after its review (#1787, rounds 1-4):
// steps / job outputs (no `jobs`; step if: no `secrets`), reusable-call with/secrets, container/services, workflow_call
// defaults/outputs, bare + any-case names, a quote-aware linear-time expression pattern.
const CONTEXTS = ['github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy', 'matrix', 'needs', 'inputs']

const JOB = ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']
const CONTAINER_ENV = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'inputs']
const ALL_BUT_JOBS = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs']
const CREDENTIALS = ['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'secrets', 'inputs']

// Allowed contexts per key, from GitHub's context-availability table.
const ALLOWED = {
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
}

// Quote-aware: a `}}` inside a string literal does not end the expression (GitHub reads it the same way).
// The three alternatives never overlap (a quote only starts a string; `}` only alone), so an unclosed `${{` fails in
// linear time instead of backtracking over every pairing of the quotes after it (review R3). A `''` escape reads as
// two adjacent strings: the same end as GitHub's quote toggle.
const EXPR = /\$\{\{((?:'[^']*'|[^'}]|\}(?!\}))*)\}\}/g

/** Context names used in one expression body (lower-cased; string literals removed first). */
function contextsIn(expr) {
  const bare = String(expr).replace(/'(?:[^']|'')*'/g, "''")
  const out = new Set()
  // A name not preceded by a property dot / word char, and not a function call (followed by `(`).
  for (const m of bare.matchAll(/(?<![\w.-])([A-Za-z_][\w-]*)(?![\w-])(?!\s*\()/g)) {
    const name = m[1].toLowerCase()
    if (CONTEXTS.includes(name)) out.add(name)
  }
  return [...out]
}

/** Every string leaf under a value (env maps, concurrency objects, runs-on arrays). */
function strings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** Context names a value uses. `if:` may be a bare expression without `${{ }}`. */
function used(value, { bareIf = false } = {}) {
  const found = new Set()
  for (const s of strings(value)) {
    const bodies = [...s.matchAll(EXPR)].map((m) => m[1])
    if (bareIf && bodies.length === 0) bodies.push(s)
    for (const b of bodies) for (const c of contextsIn(b)) found.add(c)
  }
  return [...found]
}

function check(findings, file, where, key, value, opts) {
  if (value === undefined) return
  const allowed = ALLOWED[key]
  for (const c of used(value, opts)) {
    if (!allowed.includes(c)) {
      findings.push(`${file}: ${where} uses \`${c}\` — GitHub allows only ${allowed.join(', ')} there, so it rejects the whole file`)
    }
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** container / one service: credentials and env have their own lists, every other key (image, options …) the base one. */
function checkContainer(findings, file, where, keyBase, value) {
  const base = keyBase === 'jobs.<id>.container' ? keyBase : 'jobs.<id>.services'
  if (!isObj(value)) return check(findings, file, where, base, value)
  for (const [k, v] of Object.entries(value)) {
    if (k === 'credentials') check(findings, file, `${where}.credentials`, `${keyBase}.credentials`, v)
    else if (k === 'env') check(findings, file, `${where}.env`, `${keyBase}.env.<id>`, v)
    else check(findings, file, `${where}.${k}`, base, v)
  }
}

function workflowContextFindings(files) {
  const findings = []
  for (const [file, text] of files) {
    let doc
    try {
      doc = parseYaml(text)
    } catch (e) {
      findings.push(`${file}: not valid YAML (${e.message.split('\n')[0]})`)
      continue
    }
    if (!isObj(doc)) continue
    for (const key of ['env', 'concurrency', 'run-name']) check(findings, file, key, key, doc[key])
    const call = isObj(doc.on) && isObj(doc.on.workflow_call) ? doc.on.workflow_call : null
    if (call) {
      for (const [id, inp] of Object.entries(isObj(call.inputs) ? call.inputs : {})) {
        if (isObj(inp)) check(findings, file, `on.workflow_call.inputs.${id}.default`, 'on.workflow_call.inputs.<id>.default', inp.default)
      }
      for (const [id, out] of Object.entries(isObj(call.outputs) ? call.outputs : {})) {
        if (isObj(out)) check(findings, file, `on.workflow_call.outputs.${id}.value`, 'on.workflow_call.outputs.<id>.value', out.value)
      }
    }
    const jobs = isObj(doc.jobs) ? doc.jobs : {}
    for (const [id, job] of Object.entries(jobs)) {
      if (!isObj(job)) continue
      const at = (k) => `jobs.${id}.${k}`
      for (const k of ['if', 'env', 'name', 'runs-on', 'timeout-minutes', 'continue-on-error', 'concurrency', 'strategy']) {
        check(findings, file, at(k), `jobs.<id>.${k}`, job[k], { bareIf: k === 'if' })
      }
      if (isObj(job.environment)) {
        const { url, ...rest } = job.environment
        check(findings, file, at('environment'), 'jobs.<id>.environment', rest)
        check(findings, file, at('environment.url'), 'jobs.<id>.environment.url', url)
      } else {
        check(findings, file, at('environment'), 'jobs.<id>.environment', job.environment)
      }
      check(findings, file, at('with'), 'jobs.<id>.with.<id>', job.with)
      check(findings, file, at('secrets'), 'jobs.<id>.secrets.<id>', job.secrets === 'inherit' ? undefined : job.secrets)
      if (isObj(job.defaults)) check(findings, file, at('defaults.run'), 'jobs.<id>.defaults.run', job.defaults.run)
      if (job.container !== undefined) checkContainer(findings, file, at('container'), 'jobs.<id>.container', job.container)
      if (job.services !== undefined && !isObj(job.services)) check(findings, file, at('services'), 'jobs.<id>.services', job.services)
      for (const [sid, svc] of Object.entries(isObj(job.services) ? job.services : {})) {
        checkContainer(findings, file, at(`services.${sid}`), 'jobs.<id>.services.<id>', svc)
      }
      check(findings, file, at('outputs'), 'jobs.<id>.outputs.<id>', job.outputs)
      const steps = Array.isArray(job.steps) ? job.steps : []
      steps.forEach((step, i) => {
        if (!isObj(step)) return
        const name = `steps[${step.id ?? i}]`
        check(findings, file, at(`${name}.if`), 'jobs.<id>.steps.if', step.if, { bareIf: true })
        for (const [k, v] of Object.entries(step)) {
          if (k === 'if' || k === 'uses' || k === 'id') continue
          check(findings, file, at(`${name}.${k}`), 'jobs.<id>.steps.<key>', v)
        }
      })
    }
  }
  return findings
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

test('contexts: steps and job outputs never read jobs; a step if: never reads secrets', () => {
  const steps = (s) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${s}\n`;
  assert.equal(wf(steps("      - if: secrets.T != ''\n        run: echo")).length, 1);
  assert.deepEqual(wf(steps("      - if: ${{ runner.os == 'Linux' && steps.a.outputs.ok == 'true' }}\n        run: echo \"${{ secrets.T }}\"")), []);
  assert.equal(wf(steps('      - run: echo "${{ jobs.x.result }}"')).length, 1);
  assert.equal(wf(job('    outputs:\n      o: ${{ jobs.x.outputs.y }}')).length, 1);
  assert.deepEqual(wf(job('    outputs:\n      o: ${{ steps.a.outputs.y }}')), []);
});

test('contexts: a reusable call\'s job-level with:/secrets:, defaults.run and services are checked', () => {
  const call = (s) => `on: push\njobs:\n  c:\n    uses: ./.github/workflows/x.yml\n${s}\n`;
  assert.equal(wf(call('    with:\n      dir: ${{ runner.temp }}')).length, 1);
  assert.deepEqual(wf(call('    with:\n      sha: ${{ github.sha }}\n    secrets: inherit')), []);
  assert.equal(wf(call('    secrets:\n      T: ${{ steps.a.outputs.t }}')).length, 1);
  assert.equal(wf(job('    defaults:\n      run:\n        working-directory: ${{ runner.temp }}')).length, 1);
  assert.equal(wf(job('    services: ${{ fromJSON(env.S) }}')).length, 1);
});

test('contexts: a }} inside a string literal does not end the expression, and an unclosed ${{ fails fast', () => {
  assert.equal(wf(job("    env:\n      X: ${{ format('{{0}}', runner.temp) }}")).length, 1);
  assert.deepEqual(wf(job("    strategy:\n      matrix: ${{ fromJSON('{\"i\":[{\"c\":{\"runner\":\"a\"}}]}') }}")), []);
  const quotes = Array.from({ length: 60 }, (_, i) => `'q${i}'`).join(' ');
  const t0 = Date.now();
  assert.deepEqual(wf(`on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "\${{ github.sha }"\n          echo ${quotes}\n`), []);
  assert.ok(Date.now() - t0 < 1000);
});
