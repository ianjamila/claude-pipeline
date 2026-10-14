// `pipeline checkpoint --pr N --step S ...`: record where this `ship` run stands in the PR's summary comment (the run
// record), so another session or machine can pick the run up. It refuses unless the PR head on GitHub IS the local HEAD:
// a checkpoint is a statement about pushed work, never about commits only this clone has.
import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { GitError, headSha, isAncestor, treeFingerprint } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { LIMITS, STEPS, applyCheckpoint } from '../lib/run-record.mjs';
import { VIEW_FIELDS, baseRecordFor } from '../lib/run-progress.mjs';
import { readSummaryComment, writeSummaryComment } from '../lib/summary-comment.mjs';

export const meta = {
  summary: 'record where the ship run stands in the PR summary comment (refuses unless local HEAD is the pushed PR head)',
  usage: [
    'pipeline checkpoint --pr N --step build|verify|pr|review|gate|awaiting-owner-merge|merge|prod-watch|ended [--next TEXT] [--detail TEXT]',
    '                    [--request-file F] [--tasks-file F] [--task-done ID] [--verify-report] [--round R] [--resumed] [--repo DIR]',
    '  -> {ok, url, action, record, warnings}; exit 1 {error: unpushed | behind | diverged} (local HEAD is not the PR head on GitHub), 2 usage, 3 GitHub unavailable',
    "  --request-file: the user's request, text, at most 2 KB · --tasks-file: JSON [{id, title, spec}] · --task-done ID: mark one task done (repeatable)",
    '  --resumed: this run was taken over by `ship resume` (or adopts a PR): stamps record.resumed {at, host, head}, which later checkpoints keep and which makes `P merge` require the owner\'s recorded "merge" (--owner-approved-head + --owner-approved-items)',
    "  --verify-report: copy {head, tree, mode, ok, failedStep} of the verify report, only when its head and tree are this HEAD's (otherwise a warning)",
  ].join('\n'),
};

const readText = (path, root, flag, maxBytes) => {
  const file = resolve(root, path);
  let size;
  try {
    size = statSync(file).size;
  } catch (err) {
    throw new UsageError(`--${flag}: cannot read ${path} (${err.code ?? err.message})`);
  }
  if (size > maxBytes) throw new UsageError(`--${flag}: ${path} is ${size} bytes, at most ${maxBytes} allowed`);
  const text = readFileSync(file, 'utf8');
  if (text.includes('\0')) throw new UsageError(`--${flag}: ${path} is not a text file`);
  return text;
};

function readTasks(path, root) {
  let tasks;
  try {
    tasks = JSON.parse(readText(path, root, 'tasks-file', 256 * 1024));
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`--tasks-file: ${path} is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(tasks)) throw new UsageError('--tasks-file must hold a JSON array of {id, title, spec}');
  if (tasks.length > LIMITS.tasks) throw new UsageError(`--tasks-file: at most ${LIMITS.tasks} tasks`);
  for (const t of tasks) {
    if (t === null || typeof t !== 'object' || Array.isArray(t) || t.id === undefined || t.id === null || String(t.id) === '') {
      throw new UsageError('--tasks-file: every task needs an id');
    }
  }
  return tasks;
}

// {copied: record.verify} | {warning}: the report counts only when it was produced at THIS head on THIS tree.
function readVerify(root, config) {
  const file = resolve(root, config.verify.report);
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { warning: `--verify-report ignored: no usable verify report at ${config.verify.report} (${err.code ?? err.message})` };
  }
  const g = report && typeof report.git === 'object' && report.git !== null ? report.git : {};
  const reportedTree = g.tree ?? g.treeHash;
  const head = headSha({ cwd: root });
  const tree = treeFingerprint({ cwd: root });
  if (g.head !== head || typeof reportedTree !== 'string' || reportedTree !== tree) {
    return { warning: `--verify-report ignored: the report is for ${String(g.head).slice(0, 7)}${g.head === head ? ' with a different tree' : ''}, HEAD is ${head.slice(0, 7)}` };
  }
  const failed = (Array.isArray(report.steps) ? report.steps : []).find((s) => s?.status === 'fail');
  return { copied: { head, tree, mode: report.mode ?? null, ok: report.ok === true, failedStep: failed?.name ? String(failed.name).slice(0, 60) : null } };
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, step: { type: 'string' }, next: { type: 'string' }, detail: { type: 'string' },
    'request-file': { type: 'string' }, 'tasks-file': { type: 'string' }, 'task-done': { type: 'string', multiple: true },
    'verify-report': { type: 'boolean' }, resumed: { type: 'boolean' }, round: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const step = requireOption(values, 'step');
  if (!STEPS.includes(step)) throw new UsageError(`--step must be one of ${STEPS.join(', ')}`);
  const round = intOption(values, 'round', { min: 0 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);

  const patch = { step };
  // A run that is going again is not blocked/needs-human any more; only the two resting steps keep their outcome.
  if (step !== 'ended' && step !== 'awaiting-owner-merge') patch.outcome = null;
  if (values.next !== undefined) patch.next = values.next;
  if (values.detail !== undefined) patch.detail = values.detail;
  if (round !== undefined) patch.round = round;
  if (values['request-file'] !== undefined) patch.request = readText(values['request-file'], root, 'request-file', LIMITS.request);
  if (values['tasks-file'] !== undefined) patch.tasks = readTasks(values['tasks-file'], root);
  if (values['task-done']?.length) patch.done = values['task-done'];

  const local = headSha({ cwd: root });
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const view = gh.prView(pr, [...VIEW_FIELDS]);
    const remote = view.headRefOid;
    if (local !== remote) {
      // ahead of the remote = unpushed work; an ancestor of it = someone pushed past us; anything else (including a PR
      // head this clone has never fetched) cannot be proven either way and is reported as diverged.
      let error = 'diverged';
      try {
        if (isAncestor(remote, local, { cwd: root })) error = 'unpushed';
        else if (isAncestor(local, remote, { cwd: root })) error = 'behind';
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
      }
      const advice = {
        unpushed: 'push first, then checkpoint',
        behind: 'the PR has newer commits: git pull --ff-only, then checkpoint',
        diverged: 'local and pushed history differ (or the PR head is not fetched): git fetch, then reconcile before checkpointing',
      }[error];
      return { exitCode: EXIT.FAILED, output: { ok: false, error, localHead: local, remoteHead: remote, message: `local HEAD ${local.slice(0, 7)} is not the PR head ${String(remote).slice(0, 7)}: ${advice}` } };
    }

    const warnings = [];
    if (values['verify-report']) {
      const v = readVerify(root, config);
      if (v.copied) patch.verify = v.copied;
      else warnings.push(v.warning);
    }
    patch.head = local;
    if (values.resumed) patch.resumed = { at: new Date().toISOString(), host: hostname(), head: local };

    const existing = readSummaryComment(gh, pr);
    if (existing.status === 'unsupported') throw new UsageError('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI first');
    const base = baseRecordFor(existing, { repo: gh.repo().slug, pr, branch: view.headRefName, baseRef: view.baseRefName });
    warnings.push(...base.warnings);
    let record;
    try {
      record = applyCheckpoint(base.record, patch, { host: hostname(), now: Date.now() });
    } catch (err) {
      throw new UsageError(err.message);
    }
    const posted = writeSummaryComment(gh, pr, { record, existing });
    return { exitCode: EXIT.OK, output: { ok: true, url: posted.url, action: posted.action, record, warnings } };
  });
});
