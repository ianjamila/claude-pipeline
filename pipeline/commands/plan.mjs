// `pipeline plan record | approve | risk`: the plan stage of a ship run (spec 2026-10-19 §§2-3). `record` pins the committed
// plan file by its git blob and posts a `plan-proposed` pointer event; `approve` turns the owner's typed "approve" (a local
// owner-go plan record, never the agent's say-so) into a `plan-approved` pointer and the run record's tasks; `risk` rates the
// active plan before it is reviewed. Events are POINTERS: scope and tasks are always re-parsed from the approved blob.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, headSha } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { PlanError, parsePlan, planRequestLines, scopeDigest } from '../lib/plan.mjs';
import { activeProposal, bindOf, latestApproval, matchingLocalRecord } from '../lib/plan-state.mjs';
import { scopeMayHitGlob, securityGlobs } from '../lib/risk.mjs';
import { LIMITS, bindRecord } from '../lib/run-record.mjs';
import { VIEW_FIELDS, createRunRecorder } from '../lib/run-progress.mjs';
import { listEvents, postEvent } from '../lib/run-events.mjs';
import { summaryFromComments } from '../lib/summary-comment.mjs';
import { MAX_AGE_MS, PLAN_RECORD_MAX_AGE_MS, accountHome, readPlanApprovals } from '../hooks/lib/owner-go.mjs';

export const meta = {
  summary: 'the plan stage: record the committed plan, record the owner\'s "approve", rate the plan\'s risk',
  usage: [
    'pipeline plan record --pr N --file PATH [--request-file F] [--repo DIR]',
    '  -> {ok, blob, scopeDigest, path, scope, tasks:[{id,title,specSha}], requestLines, event:{id, reused}, warnings}; posts one plan-proposed event (none when this blob is already the active proposal) and checkpoints step plan',
    '  -> exit 1 {error: dirty | unpushed | plan-invalid} (the file must be committed and pushed, and parse as a plan that lists itself in its Scope), 3 GitHub unavailable',
    '  -> show the owner requestLines VERBATIM (the first line, then the 📋 line) together with the plan\'s plain-English section and Scope list; the owner types "approve"',
    'pipeline plan approve --pr N [--repo DIR]',
    '  -> {ok, blob, scopeDigest, event:{id, reused}, stepChanged, repaired, warnings}; needs the owner\'s "approve" recorded by the owner-go hook for the active plan (24 h; an approval event already on the PR is repaired for 30 days); posts one plan-approved event, copies the approved tasks into the run record and moves a plan-stage (or stopped/blocked with open tasks) run to build',
    '  -> exit 1 {error: no-proposal | no-approval | superseded | scope-mismatch | lost | record-unreadable}, 3 GitHub unavailable',
    'pipeline plan risk --pr N [--repo DIR]',
    '  -> {ok, level: low|medium|high, reasons, blob}; high when the plan\'s Scope can touch a high-risk, hard-stop or security path or a task names a risky area; medium for more than 3 tasks or more than risk.medium_files scope entries',
  ].join('\n'),
};

const HEX40 = /^[0-9a-f]{40}$/;
const RISKY_WORDS = /\b(migration|rls|row[- ]level|grant|revoke|policy|auth|secret|token|password|payroll|money|concurrency|lock)\b/i;

const fail = (error, message, extra = {}) => new Fail(EXIT.FAILED, { ok: false, error, message, ...extra });

// Everything the subcommands read from the PR once. Event comments, the run record and the plan blobs are separate sources.
function prContext(values, ctx, root) {
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const gh = createGitHub({ cwd: root, env: ctx.env });
  const view = gh.prView(pr, [...VIEW_FIELDS]);
  const viewer = gh.viewer();
  const comments = gh.listComments(pr);
  const bind = bindOf({ repo: gh.repo().slug, pr, branch: view.headRefName });
  // summaryFromComments already decodes: use .status / .record, never decodeRecord(summary.body) (Codex plan R1-4).
  let summary = summaryFromComments(comments, viewer);
  if (summary.status === 'ok' && bindRecord(summary.record, bind).length) summary = { ...summary, status: 'invalid', record: undefined };
  return { pr, gh, view, comments, events: listEvents(comments, viewer), bind, summary };
}

const readBlobFrom = (root) => (blob) => {
  if (!HEX40.test(String(blob))) return null;
  try { return git(['cat-file', 'blob', blob], { cwd: root }); } catch { return null; }
};

const nowOf = (ctx) => (ctx.now ?? Date.now)();
const isoOf = (ctx) => new Date(nowOf(ctx)).toISOString();

function readRequest(root, file) {
  const abs = path.resolve(root, file);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new UsageError(`--request-file: cannot read ${file} (${err.code ?? err.message})`);
  }
  if (Buffer.byteLength(text) > LIMITS.request) throw new UsageError(`--request-file: ${file} is larger than ${LIMITS.request} bytes`);
  return text;
}

function parseBlob(readBlob, blob) {
  const text = readBlob(blob);
  if (text == null) throw fail('lost', `the plan blob ${String(blob).slice(0, 12)} is not in this clone: fetch the branch, or record the plan again`);
  try {
    return parsePlan(text);
  } catch (err) {
    if (err instanceof PlanError) throw fail('lost', `the plan no longer parses: ${err.message}`, { problems: err.problems });
    throw err;
  }
}

function activeOrFail(events, bind) {
  const active = activeProposal(events, bind);
  if (active.status === 'none') throw fail('no-proposal', 'no plan has been recorded on this PR: run `pipeline plan record` first');
  if (active.status === 'lost') throw fail('lost', `${active.reason}. Recovery: record the plan again (\`pipeline plan record\`); the owner's new "approve" clears it`);
  return active;
}

// ---- record ----------------------------------------------------------------------------------------------------------------

async function record(argv, ctx) {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, file: { type: 'string' }, 'request-file': { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  intOption(values, 'pr', { required: true, min: 1 });
  const file = requireOption(values, 'file');
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  const abs = path.resolve(ctx.cwd ?? process.cwd(), file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new UsageError(`--file must be inside the repository (${file})`);
  const request = values['request-file'] !== undefined ? readRequest(root, values['request-file']) : undefined;

  let blob;
  try {
    blob = git(['rev-parse', `HEAD:${rel}`], { cwd: root }).trim();
  } catch {
    throw fail('dirty', `${rel} is not committed at HEAD: commit the plan (small plans too), push, then record it`);
  }
  let worktreeBlob;
  try {
    worktreeBlob = git(['hash-object', '--', abs], { cwd: root }).trim();
  } catch {
    worktreeBlob = null;
  }
  if (worktreeBlob !== blob) throw fail('dirty', `${rel} differs from its committed version: commit the change (the owner approves exactly what is committed)`);

  const local = headSha({ cwd: root });
  return guardGh(() => {
    const px = prContext(values, ctx, root);
    if (local !== px.view.headRefOid) {
      throw fail('unpushed', `local HEAD ${local.slice(0, 7)} is not the PR head ${String(px.view.headRefOid).slice(0, 7)}: push first, then record the plan`);
    }
    let plan;
    try {
      plan = parsePlan(readBlobFrom(root)(blob), { path: rel });
    } catch (err) {
      if (err instanceof PlanError) throw fail('plan-invalid', err.message, { problems: err.problems });
      throw err;
    }
    const digest = scopeDigest(plan.scope);
    const active = activeProposal(px.events, px.bind);
    let event;
    if (active.status === 'ok' && active.blob === blob) {
      event = { id: active.event.commentId, reused: true };
    } else {
      const n = 1 + px.events.filter((e) => e.kind === 'plan-proposed').length;
      const posted = postEvent(px.gh, px.pr, 'plan-proposed', `${blob.slice(0, 12)}-${n}`, `Plan proposed: ${rel}`, {
        ...px.bind, path: rel, blob, scopeDigest: digest, n, at: isoOf(ctx), host: hostname(),
      });
      event = { id: posted.id, reused: false };
    }
    const recorder = createRunRecorder({ gh: px.gh, pr: px.pr });
    recorder.update({ step: 'plan', outcome: null, plan: { path: rel, blob, scopeDigest: digest, state: 'proposed' }, ...(request !== undefined ? { request } : {}) }, { initialStep: 'plan' });
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true, blob, scopeDigest: digest, path: rel, scope: plan.scope,
        tasks: plan.tasks.map(({ id, title, specSha }) => ({ id, title, specSha })),
        requestLines: planRequestLines({ pr: px.pr, blob, scopeDigest: digest }), event, warnings: recorder.warnings,
      },
    };
  });
}

// ---- approve ---------------------------------------------------------------------------------------------------------------

// Is every task of the approved plan done in the record at the same spec? (a task whose spec changed is open again)
const openTasks = (tasks, recorded) => tasks.some((t) => !(recorded ?? []).some((r) => r.id === t.id && r.specSha === t.specSha && r.done === true));

async function approve(argv, ctx) {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  const readBlob = readBlobFrom(root);
  return guardGh(() => {
    const px = prContext(values, ctx, root);
    const active = activeOrFail(px.events, px.bind);
    const parsed = parseBlob(readBlob, active.blob);
    const digest = scopeDigest(parsed.scope);
    if (digest !== active.scopeDigest) throw fail('lost', 'the recorded scope digest does not match the plan blob: record the plan again');
    // A record we cannot read may be a gate-stage one: never reset it (spec B1).
    if (px.summary.status === 'unsupported' || px.summary.status === 'invalid') {
      throw fail('record-unreadable', `the run record on this PR is ${px.summary.status} (from a newer pipeline, damaged or another PR's): update the pipeline CLI or fix the summary comment first; nothing was posted`);
    }
    const home = ctx.home ?? accountHome();
    const now = () => nowOf(ctx);
    const wantRec = (r) => ({ pr: px.pr, blob: active.blob, scopeDigest: digest, recordId: r.recordId, promptSha256: r.promptSha256 });

    // REPAIR first: an approval event for this blob is already on the PR and the owner's record is still within 30 days
    // (resume accepts that long, so its repair must too). No new issuance, so the 24 h rule does not apply.
    const existingApproval = latestApproval(px.events, px.bind);
    const wasApproved = (e) => e.kind === 'plan-approved' && e.dataStatus === 'ok' && !e.tampered && e.data?.blob === active.blob
      && e.data?.repo === px.bind.repo && e.data?.pr === px.bind.pr && e.data?.branch === px.bind.branch;
    const old = readPlanApprovals({ home, now, maxAgeMs: PLAN_RECORD_MAX_AGE_MS });
    const repairEvent = existingApproval.status === 'approved'
      ? px.events.filter(wasApproved).reverse().find((e) => matchingLocalRecord(old, wantRec({ recordId: e.data.recordId, promptSha256: e.data.promptSha256 })))
      : undefined;

    let event;
    let repaired = false;
    if (repairEvent) {
      repaired = true;
      event = { id: repairEvent.commentId, reused: true };
    } else {
      const recs = readPlanApprovals({ home, now, maxAgeMs: MAX_AGE_MS }).filter((r) => r.pr === px.pr).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      const rec = recs[0];
      if (!rec) throw fail('no-approval', 'the owner has not typed "approve" for this plan in the last 24 hours (the hook records it): show the plan request and wait');
      if (rec.blob !== active.blob) throw fail('superseded', `the owner approved plan ${rec.blob.slice(0, 12)}, but the active plan is ${active.blob.slice(0, 12)}: show the active plan request again`);
      if (rec.scopeDigest !== digest) throw fail('scope-mismatch', 'the owner approved a different Scope than the active plan\'s: show the active plan request again');
      const same = px.events.filter((e) => wasApproved(e) && e.data.recordId === rec.recordId).at(-1);
      if (same) {
        event = { id: same.commentId, reused: true };
      } else {
        const posted = postEvent(px.gh, px.pr, 'plan-approved', `${active.blob.slice(0, 12)}-${rec.recordId.slice(0, 8)}`, `Plan approved: ${active.path}`, {
          ...px.bind, path: active.path, blob: active.blob, scopeDigest: digest, recordId: rec.recordId,
          promptSha256: rec.promptSha256, recordedAt: rec.ts, at: isoOf(ctx), host: hostname(),
        });
        event = { id: posted.id, reused: false };
      }
    }

    // The approved tasks are ALWAYS reconciled into the record (normaliseTask keeps `done` only where specSha is unchanged,
    // so a later-stage record loses nothing it legitimately built). The step moves to build only from the plan stage.
    const rec0 = px.summary.status === 'ok' ? px.summary.record : null;
    const endedOpen = rec0?.step === 'ended' && (rec0.outcome === 'stopped' || rec0.outcome === 'blocked') && openTasks(parsed.tasks, rec0.tasks);
    const toBuild = rec0 === null || rec0.step === 'plan' || endedOpen;
    const recorder = createRunRecorder({ gh: px.gh, pr: px.pr });
    const updated = recorder.update({
      tasks: parsed.tasks.map(({ id, title, spec, specSha }) => ({ id, title, spec, specSha })),
      plan: { path: active.path, blob: active.blob, scopeDigest: digest, state: 'approved' },
      ...(toBuild ? { step: 'build', outcome: null } : {}),
    }, { initialStep: 'build' });
    if (!updated) {
      return {
        exitCode: EXIT.UNAVAILABLE,
        output: { ok: false, error: 'checkpoint-failed', message: 'the approval is on the PR but the run record was not updated: run `pipeline plan approve` again (it reuses the event)', event, warnings: recorder.warnings },
      };
    }
    return {
      exitCode: EXIT.OK,
      output: { ok: true, blob: active.blob, scopeDigest: digest, event, stepChanged: toBuild, repaired, warnings: recorder.warnings },
    };
  });
}

// ---- risk ------------------------------------------------------------------------------------------------------------------

async function risk(argv, ctx) {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  intOption(values, 'pr', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  return guardGh(() => {
    const px = prContext(values, ctx, root);
    const active = activeOrFail(px.events, px.bind);
    const plan = parseBlob(readBlobFrom(root), active.blob);
    const globs = [...new Set([...config.risk.high_risk_paths, ...config.hard_stops.paths, ...securityGlobs(config)])];
    const reasons = [];
    for (const entry of plan.scope) {
      const hit = globs.find((g) => scopeMayHitGlob(entry, g));
      if (hit !== undefined) reasons.push(`scope ${entry} can touch the risky path ${hit}`);
    }
    for (const t of plan.tasks) {
      const m = RISKY_WORDS.exec(`${t.title}\n${t.text}`);
      if (m) reasons.push(`task ${t.id} mentions "${m[1].toLowerCase()}"`);
    }
    let level = reasons.length ? 'high' : 'low';
    if (level === 'low' && plan.tasks.length > 3) { level = 'medium'; reasons.push(`${plan.tasks.length} tasks > 3`); }
    if (level === 'low' && plan.scope.length > config.risk.medium_files) { level = 'medium'; reasons.push(`${plan.scope.length} scope entries > ${config.risk.medium_files}`); }
    if (reasons.length === 0) reasons.push('small plan');
    return { exitCode: EXIT.OK, output: { ok: true, level, reasons: reasons.slice(0, 12), blob: active.blob } };
  });
}

const SUBCOMMANDS = { record, approve, risk };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline plan ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
