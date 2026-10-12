// Shared scaffolding for the cli-gate*.test.mjs files: a real git repo holding a PR branch with a full evidence trail
// (verify report, review state, preview smoke) plus a scripted fake gh, and a runner for the real CLI. Every option of
// `scenario` breaks exactly one thing, so a failing final-gate check names the check that caught it. The suite is
// split over several files only so node runs them in parallel: each CLI call costs about a second.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, pipelineYml, REPO_VIEW } from './fakegh-env.mjs';
import { addRound, emptyState, saveState } from '../../pipeline/lib/state.mjs';
import { contentHash, mergeBase, treeFingerprint } from '../../pipeline/lib/git.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pipeline', 'bin', 'pipeline.mjs');
export const PR = 12;
export const AGENT_LOG = 'docs/agent-log.md';
export const STEPS = ['install', 'typecheck', 'lint', 'unit', 'build'];
export const MERGE_SHA = 'c'.repeat(40);
// The base tip GitHub's compare reports (base_commit): update-branch's merge commit must have it as second parent.
export const BASE_SHA = '9'.repeat(40);
export const ME = { match: '^api user', stdout: 'me\n' };
export const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };

// Spawns the real CLI inside `dir` against a fake gh. PIPELINE_* switches of the caller are scrubbed so a developer
// running this inside a pipeline session cannot change the outcome.
export function cli(args, { dir, fake, env = {} }) {
  // PIPELINE_MERGEABLE_PAUSE_MS shortens the 2 s wait between `mergeable: UNKNOWN` re-reads (it can never lengthen it).
  const base = { ...process.env, PIPELINE_NOTIFY: 'off', PIPELINE_MERGEABLE_PAUSE_MS: '1', ...(fake?.env ?? {}), ...createFakeCodex().env, ...env };
  for (const k of ['PIPELINE_OFF', 'PIPELINE_ADMIN', 'PIPELINE_MERGE_WAIT_MS', 'PIPELINE_MERGE_POLL_MS']) if (!(k in env)) delete base[k];
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: dir, env: base, encoding: 'utf8', timeout: 120_000 });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch { /* leave null: the assertion on the code will show stderr */ }
  return { code: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

// ---- scenario: a PR branch with a full evidence trail ---------------------------------------------

const FAKE_MERGE = [
  "import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
  "if (process.env.FAKE_MERGE_SWAP) copyFileSync(process.env.FAKE_MERGE_SWAP, process.env.PIPELINE_FAKE_GH_SCRIPT);",
  "if (process.env.FAKE_MERGE_EXIT) { process.stderr.write('merge gate refused: base moved\\n'); process.exit(Number(process.env.FAKE_MERGE_EXIT)); }",
  '',
].join('\n');
const FAKE_SMOKE = [
  'const url = process.argv[2];',
  'for (let i = 1; i <= Number(process.env.FAKE_SMOKE_LINES ?? 1); i++) console.log(`line ${i}`);',
  "console.log(`smoke url=${url} expect=${process.env.PIPELINE_SMOKE_EXPECT_TEXT ?? '(none)'}`);",
  "process.exit(url.includes('bad') ? 1 : 0);",
  '',
].join('\n');

export function ymlFor({ preview = false, production = false, smokeCommand = 'node scripts/fake-smoke.mjs {url}' } = {}) {
  let yml = pipelineYml('gate', ['ci']);
  yml += 'merge:\n  command: node scripts/fake-merge.mjs {pr} {sha}\n  wait_minutes: 1\n';
  if (preview) yml += `preview:\n  environment: Preview\n  smoke: ${smokeCommand}\n`;
  if (production) {
    yml += `production:\n  url: https://example.com\n  environment: Production\n  smoke: ${smokeCommand}\n  rollback:\n    command: echo rollback\n`;
  }
  return yml;
}

export const bump = (r) => r.write('src/app.js', 'export const a = 2;\n');

export function reviewState(hash, { pending = false } = {}) {
  let s = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'low' });
  s.currentContentHash = hash;
  const items = pending ? [{ id: 'F1', bucket: 'BLOCKING', title: 'open question', judge: { decision: 'ACCEPT', confidence: 'high', reason: 'x' } }] : [];
  s = addRound(s, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: hash, items });
  return s;
}

export const PREVIEW_URL = 'https://pr-12.example.test';

// GitHub deployments for the PR head in the Preview environment. `previewDeploy`: undefined = no entries (the gh fake
// then errors on the lookup), null = GitHub reports no deployment, object = {url, sha?, state?, id?}.
function previewDeployEntries(o) {
  if (o.previewDeploy === undefined) return [];
  if (o.previewDeploy === null) return [{ match: 'deployments\\?.*sha=', stdoutJson: [] }];
  const d = o.previewDeploy;
  return [
    { match: 'deployments/901/statuses', stdoutJson: [{ state: d.state ?? 'success', environment_url: d.url }] },
    { match: 'deployments\\?.*sha=', stdoutJson: [{ id: 901, sha: d.sha ?? o.prHead, environment: 'Preview', created_at: '2026-10-01T00:00:00Z' }] },
  ];
}

const UPDATE_REPLIES = {
  accepted: { match: 'pulls/12/update-branch', stdoutJson: { message: 'Updating pull request branch.', url: 'https://github.com/acme/widgets/pull/12' } },
  conflict: { match: 'pulls/12/update-branch', code: 1, stderr: 'gh: merge conflict between base and head (HTTP 422)', stdoutJson: { message: 'merge conflict between base and head', status: '422' } },
  'head-moved': { match: 'pulls/12/update-branch', code: 1, stderr: "gh: expected head sha didn't match current head ref. (HTTP 422)", stdoutJson: { message: "expected head sha didn't match current head ref.", status: '422' } },
  forbidden: { match: 'pulls/12/update-branch', code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)', stdoutJson: { message: 'Resource not accessible by integration', status: '403' } },
};

export function ghEntries(o) {
  const pr = {
    state: o.state ?? 'OPEN', headRefOid: o.prHead, baseRefName: o.base ?? 'main', isDraft: o.isDraft ?? false,
    labels: 'rawLabels' in o ? o.rawLabels : (o.labels ?? []).map((name) => ({ name })), mergeable: o.mergeable ?? 'MERGEABLE',
  };
  if (o.mergeStateStatus) pr.mergeStateStatus = o.mergeStateStatus;
  if (o.noLabels) delete pr.labels; // `labels` absent from the reply entirely
  if (o.noMergeable) delete pr.mergeable;

  const ci = o.ci ?? [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }];
  return [
    ...(typeof o.extra === 'function' ? o.extra(o) : (o.extra ?? [])),
    ...previewDeployEntries(o),
    { match: '^pr view 12 --json state,headRefOid', stdoutJson: pr },
    // The run record merge / update-branch keep in the summary comment: no comment yet, and writing one succeeds.
    { match: '^pr view 12 --json headRefOid,headRefName,baseRefName', stdoutJson: { headRefOid: o.prHead, headRefName: 'agent/feature', baseRefName: o.base ?? 'main' } },
    { match: 'repos/acme/widgets/issues/12/comments --paginate', stdoutJson: o.comments ?? [] },
    { match: '-X POST repos/acme/widgets/issues/12/comments', stdoutJson: { id: 501, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-501' } },
    { match: '-X PATCH repos/acme/widgets/issues/comments/', stdoutJson: { id: 501, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-501' } },
    { match: '^pr view 12 --json state,mergeCommit', stdoutJson: { labels: [], ...(o.mergeView ?? { state: 'MERGED', mergeCommit: { oid: MERGE_SHA } }) } },
    { match: '^pr merge 12 --disable-auto', code: o.disableAutoCode ?? 0 },
    // `behindBy`: how many base commits the PR head lacks (compare); 0 = up to date, which is what merge's update step expects.
    // `update`: what PUT pulls/12/update-branch answers: accepted (default) | conflict | head-moved (the two 422s) | forbidden.
    UPDATE_REPLIES[o.update ?? 'accepted'],
    { match: 'repos/acme/widgets/compare/', stdoutJson: { status: o.behindBy ? 'diverged' : 'ahead', behind_by: o.behindBy ?? 0, ahead_by: 1, base: BASE_SHA } },
    // `commitParents`: { <sha>: [parent shas] } for GET commits/<sha> (the update-branch result is bound to its parents).
    ...Object.entries(o.commitParents ?? {}).map(([commit, parents]) => ({ match: `commits/${commit} --jq`, stdoutJson: parents })),
    o.requiredCi === 'error'
      ? { match: '^pr checks 12 .*--required$', code: 1, stderr: "no required checks reported on the 'main' branch" }
      : o.requiredCi === 'fail502'
        ? { match: '^pr checks 12 .*--required$', code: 1, stderr: 'gh: Server Error (HTTP 502)' }
        : { match: '^pr checks 12 .*--required$', stdoutJson: o.requiredCi ?? ci },
    { match: '^pr checks 12 ', stdoutJson: ci },
    { match: '^auth status', code: 0 },
    ME,
    REPO,
    { match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) },
    { match: '^issue list --label pipeline-pause', stdoutJson: o.pause ?? [] },
    { match: '^issue list --label pipeline-rollback', stdoutJson: o.rollback ?? [] },
    { match: '^issue list', stdoutJson: [] },
  ];
}

// Builds the repo (base on main, PR commit on agent/feature) plus every piece of evidence a passing gate needs.
// Each option breaks exactly one thing. Evidence files all live in gitignored dirs, so they never change the tree.
export function scenario(opts = {}) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', opts.yml ?? ymlFor(opts));
  repo.write('.gitignore', '.verify/\n.review/\n');
  repo.write('src/app.js', 'export const a = 1;\n');
  repo.write('test/app.test.js', "import test from 'node:test';\ntest('a', () => {});\n");
  repo.write('docs/guide.md', '# Guide\n');
  repo.write('scripts/fake-merge.mjs', FAKE_MERGE);
  repo.write('scripts/fake-smoke.mjs', FAKE_SMOKE);
  for (const [file, content] of Object.entries(opts.baseFiles ?? {})) repo.write(file, content);
  repo.commit('init');
  repo.branch('agent/feature');
  (opts.change ?? bump)(repo);
  const head = repo.commit('feature');
  const hash = contentHash(mergeBase('main', 'HEAD', { cwd: repo.dir }), 'HEAD', { cwd: repo.dir, exclude: [AGENT_LOG] });

  if (opts.state !== null) {
    saveState(repo.dir, opts.state === 'stale' ? reviewState('0'.repeat(64)) : reviewState(hash, { pending: opts.state === 'pending' }));
  }
  if (opts.report !== null) {
    const steps = STEPS.map((name) => ({ name, status: 'pass', durationMs: 5, command: name, exitCode: 0, errorExcerpt: '' }));
    const report = {
      version: 1, mode: 'full', ok: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      expectedSteps: [...STEPS], git: { head, base: 'main', dirty: false, tree: treeFingerprint({ cwd: repo.dir }) }, steps,
    };
    opts.report?.(report);
    repo.write('.verify/report.json', JSON.stringify(report, null, 2));
  }
  opts.afterReport?.(repo);
  if (opts.previewSmoke !== undefined) repo.write('.review/preview-smoke.json', JSON.stringify(opts.previewSmoke(head)));

  const fake = createFakeGh(ghEntries({ prHead: head, ...(opts.preview ? { previewDeploy: { url: PREVIEW_URL } } : {}), ...opts.gh }));
  const env = opts.env ?? {};
  const s = {
    repo, fake, head, hash, env,
    gate: () => cli(['final-gate', '--pr', String(PR)], { dir: repo.dir, fake, env }),
    merge: (extraEnv = {}) => cli(['merge', '--pr', String(PR)], { dir: repo.dir, fake, env: { ...env, ...extraEnv } }),
    gateFile: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'final-gate.json'), 'utf8')),
    editGate: (fn) => {
      const g = s.gateFile();
      fn(g);
      writeFileSync(join(repo.dir, '.review', 'final-gate.json'), JSON.stringify(g));
    },
    mergeCalls: () => (existsSync(join(repo.dir, '.review', 'merge-calls.log')) ? readFileSync(join(repo.dir, '.review', 'merge-calls.log'), 'utf8').trim().split('\n') : []),
  };
  return s;
}

export const named = (json, name) => json.checks.find((c) => c.name === name);
export function assertOnlyFails(r, name, detail) {
  assert.equal(r.code, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.failed, [name], JSON.stringify(r.json.checks.filter((c) => !c.ok)));
  if (detail) assert.match(named(r.json, name).detail, detail);
}

