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
import { openOwnerStops, postEvent, readEvents } from '../lib/run-events.mjs';
import { flushPendingStops, removePendingStop } from '../lib/owner-stop.mjs';
import { approvedRelease } from '../hooks/lib/owner-go.mjs';
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
    "  owner_approval: chat: an open owner stop (no needs-human label exists) makes every checkpoint but `ended` / `awaiting-owner-merge` exit 1 {error: owner-stop-open}; `--resumed` releases it, and only with the owner's typed reply (`ship resume N`, or `merge` to a reply that offered it) recorded for that PR and stop id by the owner-go hook: exit 1 {error: owner-release-missing, stops, released} otherwise (nothing is posted for a stop without that record); a stop held only on this machine (GitHub unreachable) exits 1 {error: owner-stop-held}",
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
  return guardGh(async () => {
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

    // Chat mode: owner stops are events, never a label. Open stop + no --resumed = refused; --resumed releases only what the owner released
    // (the owner-go record for this PR and stop id), release event FIRST, then the record copy and the local pending file.
    let released = [];
    if (config.owner_approval === 'chat') {
      const resting = step === 'ended' || step === 'awaiting-owner-merge';
      const flushed = await flushPendingStops({ gh, pr, root, deps: ctx.ownerStopDeps });
      if (flushed.remaining.length > 0 && !resting) {
        const ids = flushed.remaining.map((r) => r.id);
        return { exitCode: EXIT.FAILED, output: { ok: false, error: 'owner-stop-held', stops: ids, message: `owner stop ${ids.join(', ')} has not reached GitHub yet (${flushed.remaining[0].why}): it blocks merging on this machine; tell the owner, and retry once GitHub is reachable` } };
      }
      const open = openOwnerStops(readEvents(gh, pr));
      if (open.length > 0 && !values.resumed && !resting) {
        const ids = open.map((e) => String(e.id));
        return { exitCode: EXIT.FAILED, output: { ok: false, error: 'owner-stop-open', stops: ids, message: `owner stop ${ids.join(', ')} is open on #${pr}: only the owner's reply releases it. Show the Stopped line(s) and wait for "ship resume ${pr}"; then \`checkpoint --resumed\`` } };
      }
      if (open.length > 0 && values.resumed) {
        const ownerGoDeps = ctx.ownerGoDeps ?? {};
        const slug = gh.repo().slug;
        const missing = [];
        for (const e of open) {
          const id = String(e.id);
          const rec = approvedRelease({ pr, stop: id, ...ownerGoDeps });
          if (!rec) { missing.push(id); continue; }
          postEvent(gh, pr, 'owner-stop-released', id, `Owner stop ${id} on #${pr} released by the owner's reply.`, {
            repo: slug, pr, id, at: new Date().toISOString(), host: hostname(),
            releaseRef: { kind: rec.kind === 'resume' ? 'resume' : 'merge', session: rec.session, ts: rec.ts, prompt_sha256: rec.prompt_sha256 },
          });
          released.push(id);
          try { await removePendingStop({ pr, root, id, deps: ctx.ownerStopDeps }); } catch { /* the event is the authority: a leftover file only repeats a flush that finds the release */ }
        }
        if (missing.length > 0) {
          return { exitCode: EXIT.FAILED, output: { ok: false, error: 'owner-release-missing', stops: missing, released, message: `the owner has not released stop ${missing.join(', ')} (no recorded "ship resume ${pr}" / "merge" naming it): show the stop lines and wait; if the owner already answered and the hook is old, run \`pipeline update\`` } };
        }
      }
      if (values.resumed) { patch.ownerStop = null; patch.outcome = null; }
    }

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
    return { exitCode: EXIT.OK, output: { ok: true, url: posted.url, action: posted.action, record, warnings, ...(released.length ? { released } : {}) } };
  });
});
