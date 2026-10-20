// Scaffolding for the CI-proof LOOKUP tests (ci-proof.test.mjs): a real temporary git repo (the lookup compares real trees) and a fake
// GitHub client serving the REAL reply shapes kept in test/fixtures/ci-proof (a workflow run, its jobs, a merge commit). No network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './tmprepo.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ci-proof');
export const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

export const SLUG = 'acme/widgets';
export const PR = 12;
export const BRANCH = 'agent/feature';
export const MERGE_SHA = 'd'.repeat(40);
export const SPEC = { workflow: '.github/workflows/migration-replay.yml', job: 'SQL arms', event: 'pull_request' };

// The fixture run rewritten for this repo, PR and head. `patch` is shallow-merged over the result.
export function runFor({ head, id = 5001, number = 778, attempt = 1, pr = PR, patch = {} }) {
  const r = fixture('run.json');
  r.id = id;
  r.run_number = number;
  r.run_attempt = attempt;
  r.head_sha = head;
  r.head_branch = BRANCH;
  r.html_url = `https://github.com/${SLUG}/actions/runs/${id}`;
  r.repository.full_name = SLUG;
  r.head_repository.full_name = SLUG;
  r.pull_requests = [{ number: pr, head: { ref: BRANCH, sha: head }, base: { ref: 'main', sha: '9'.repeat(40) } }];
  r.referenced_workflows = [{ path: `${SLUG}/.github/workflows/broken-main-issue.yml@${MERGE_SHA}`, ref: `refs/pull/${pr}/merge`, sha: MERGE_SHA }];
  return { ...r, ...patch };
}

// The fixture jobs rewritten for a run: the aggregator "SQL arms", three shards and the rest. `patch(job)` edits the aggregator.
export function jobsFor(run, { patch } = {}) {
  const body = fixture('jobs.json');
  body.jobs = body.jobs.map((j, i) => ({ ...j, id: run.id * 100 + i, run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha }));
  if (patch) patch(body.jobs.find((j) => j.name === SPEC.job));
  return body;
}

// The steps array of a real job object (name, status, conclusion, number), as a checks.yml-like job lays them out. `outcomes` maps a step
// name to [status, conclusion]; every other step is completed+success. A docs-only PR skips every work step: pass `skipped` for them.
export const STEP_NAMES = ['Set up job', 'Checkout', 'Detect docs-only', 'Install', 'Typecheck', 'Vitest', 'Post Checkout', 'Complete job'];
export function stepsList(outcomes = {}, names = STEP_NAMES) {
  return names.map((name, i) => {
    const [status, conclusion] = outcomes[name] ?? ['completed', 'success'];
    return { name, status, conclusion, number: i + 1, started_at: '2026-10-20T01:00:00.000Z', completed_at: '2026-10-20T01:00:05.000Z' };
  });
}

const GH_ERROR = (msg) => Object.assign(new Error(msg), { name: 'GhError' });

// A ready scenario: repo + head + fake gh. `s.runs` / `s.jobs[runId]` / `s.view` / `s.mergeTree` can be changed before calling ciProof(s.args).
export function lookupScenario() {
  const repo = createTmpRepo();
  repo.write('a.txt', 'one\n');
  repo.commit('init');
  const head = repo.commit('feature', { allowEmpty: true });
  const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim();
  const s = {
    repo, head, tree, calls: [],
    runs: [], jobs: {}, mergeTree: tree, pageSize: 100,
    view: { headRefOid: head, headRefName: BRANCH, baseRefName: 'main' },
    fail: new Set(), // path fragments whose GET throws a GhError
    totals: {}, // path fragment -> total_count override
    jobDetail: {}, // job id -> the body of GET actions/jobs/<id> (default: the listed job object itself)
  };
  s.addRun = (opts = {}) => {
    const run = runFor({ head, ...opts });
    s.runs.push(run);
    s.jobs[run.id] ??= jobsFor(run);
    return run;
  };
  const page = (items, key, path, total) => {
    const n = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    const per = s.pageSize;
    return { total_count: total ?? items.length, [key]: items.slice((n - 1) * per, n * per) };
  };
  s.gh = {
    calls: s.calls,
    repo: () => {
      if (s.fail.has('repo')) throw GH_ERROR('gh repo view failed');
      return { slug: SLUG };
    },
    prView: (n, fields) => {
      s.calls.push(`pr view ${n} ${fields.join(',')}`);
      if (s.fail.has('prView')) throw GH_ERROR('gh pr view failed');
      return s.view;
    },
    api: (method, path) => {
      s.calls.push(`${method} ${path}`);
      if (method !== 'GET') throw new Error(`unexpected ${method}`);
      for (const f of s.fail) if (path.includes(f)) throw GH_ERROR(`gh api ${path} failed (HTTP 502)`);
      const override = (p) => Object.entries(s.totals).find(([f]) => p.includes(f))?.[1];
      let m;
      if (/\/actions\/workflows\/[^/]+\/runs\?/.test(path)) return page(s.runs, 'workflow_runs', path, override(path));
      if ((m = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(path))) {
        const body = s.jobs[m[1]];
        if (!body) throw GH_ERROR(`no jobs for run ${m[1]} (HTTP 404)`);
        return page(body.jobs, 'jobs', path, override(path) ?? body.total_count);
      }
      if ((m = /\/actions\/jobs\/(\d+)$/.exec(path))) {
        const hit = Object.values(s.jobs).flatMap((b) => b.jobs).find((j) => j.id === Number(m[1]));
        if (!hit) throw GH_ERROR(`no job ${m[1]} (HTTP 404)`);
        return s.jobDetail[hit.id] ?? hit;
      }
      if ((m = /\/git\/commits\/([0-9a-f]{40})$/.exec(path))) {
        if (m[1] !== MERGE_SHA) throw GH_ERROR('unknown commit (HTTP 404)');
        return { ...fixture('commit.json'), sha: m[1], tree: { sha: s.mergeTree } };
      }
      throw new Error(`fake gh: unexpected path ${path}`);
    },
  };
  Object.defineProperty(s, 'args', {
    get: () => ({ root: repo.dir, step: 'sql-arms', spec: { ...SPEC }, pr: PR, head, tree: 'fingerprint', base: { ref: 'main', sha: '9'.repeat(40) }, gh: s.gh, env: {} }),
  });
  return s;
}
