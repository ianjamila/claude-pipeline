// `pipeline plan record | approve | risk | start | review | findings`: the plan stage of a ship run (spec 2026-10-19 §§2-3).
// `record` pins the committed plan file by its git blob and posts a `plan-proposed` pointer event; `approve` turns the owner's
// typed "approve" (a local owner-go plan record, never the agent's say-so) into a `plan-approved` pointer and the run record's
// tasks; `risk` rates the active plan before it is reviewed. `start` reserves one paid plan-review launch against the per-PR
// budget (Codex 2, Fable 1, owner extras), `review` runs the Codex plan review under such a reservation and `findings` takes
// the proven Fable plan review. Events are POINTERS: scope and tasks are always re-parsed from the approved blob.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import {
  FINDINGS_SCHEMA_PATH, assignIds, buildCodexArgs, buildCodexResumeArgs, buildPlanReviewPrompt, renderFindingsMarkdown, validateFindings,
} from '../lib/codex.mjs';
import { askCodex, usageDelta } from '../lib/codex-run.mjs';
import { git, headSha } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { GhError } from '../lib/proc.mjs';
import { run as costRun } from './cost.mjs';
import { sha256, writeFileAtomic, writeJson } from '../lib/review-context.mjs';
import { extractJsonBlock, findSubagentTranscript, proveModel } from '../lib/transcript.mjs';
import { PlanError, parsePlan, planRequestLines, scopeDigest } from '../lib/plan.mjs';
import { activeProposal, bindOf, latestApproval, matchingLocalRecord, newestLocalRecord, recordsForRepo, startsValidity } from '../lib/plan-state.mjs';
import { scopeMayHitGlob, securityGlobs } from '../lib/risk.mjs';
import { LIMITS, bindRecord } from '../lib/run-record.mjs';
import { VIEW_FIELDS, createRunRecorder } from '../lib/run-progress.mjs';
import { listEvents, postEvent } from '../lib/run-events.mjs';
import { summaryFromComments } from '../lib/summary-comment.mjs';
import { MAX_AGE_MS, PLAN_RECORD_MAX_AGE_MS, accountHome, readPlanApprovals } from '../hooks/lib/owner-go.mjs';

export const meta = {
  summary: 'the plan stage: record the committed plan, record the owner\'s "approve", rate its risk, reserve and run its reviews',
  usage: [
    'pipeline plan record --pr N --file PATH [--request-file F] [--repo DIR]',
    '  -> {ok, blob, scopeDigest, path, scope, tasks:[{id,title,specSha}], requestLines, event:{id, reused}, warnings}; posts one plan-proposed event (none when this blob is already the active proposal) and checkpoints step plan',
    '  -> exit 1 {error: dirty | unpushed | plan-invalid | record-unreadable} (the file must be committed and pushed, and parse as a plan that lists itself in its Scope), 2 usage (the file must sit under config plan.dir, default docs/plans; nothing is posted), 3 GitHub unavailable',
    '  -> show the owner requestLines VERBATIM (the first line, then the 📋 line) together with the plan\'s plain-English section and Scope list; the owner types "approve"',
    'pipeline plan approve --pr N [--repo DIR]',
    '  -> {ok, blob, scopeDigest, event:{id, reused}, stepChanged, repaired, warnings}; needs the owner\'s "approve" recorded by the owner-go hook for the active plan (24 h; an approval event already on the PR is repaired for 30 days); posts one plan-approved event, copies the approved tasks into the run record and moves a plan-stage (or stopped/blocked with open tasks) run to build',
    '  -> exit 1 {error: no-proposal | no-approval | superseded | scope-mismatch | lost | plan-changed | unpushed | record-unreadable}, 3 GitHub unavailable',
    'pipeline plan risk --pr N [--repo DIR]',
    '  -> {ok, level: low|medium|high, reasons, blob}; high when the plan\'s Scope can touch a high-risk, hard-stop or security path or a task names a risky area; medium for more than 3 tasks or more than risk.medium_files scope entries',
    'pipeline plan start --pr N --reviewer codex|fable --key KEY [--extra TEXT] [--repo DIR]',
    '  -> {ok, go:true, key, reviewer, planBlob, claim, promptHeader}; reserves one paid launch BEFORE it happens (one event; caps per PR: codex 2 = review + recheck, fable 1; --extra = the owner\'s words, recorded verbatim, buys one more); start the Fable reviewer with promptHeader (ROUND: plan / INPUT-DIGEST: ...) pasted verbatim as the first two lines',
    '  -> exit 1 {error: cap | already-started | use-plan-review | no-proposal | lost} (a key that already exists never launches twice; use-plan-review = Codex reviews are reserved only by `plan review`, which launches the run itself), 3 {error: not-visible} or GitHub unavailable (the new event was not listed back: nothing may launch)',
    'pipeline plan review --pr N --key KEY [--extra TEXT] [--effort high|xhigh] [--model M] [--prior FILE] [--repo DIR]',
    '  -> {ok, key, n, counts:{blocking, suggestions, worth_considering}, path, resumed, cost: booked|not-reported|failed:...}; reserves the launch itself (as `start`, --extra passes through), runs Codex over the active plan, writes .review/plan/KEY.json and .md; the second run is a recheck (--prior FILE = the first run\'s markdown) and resumes the first run\'s Codex session when it has one',
    '  -> exit 1 {error: cap | already-started | stale-start | superseded | no-proposal | lost}, 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github, session} (the key stays consumed; .review/plan/KEY.failed.json keeps the session)',
    'pipeline plan findings --pr N --key KEY --tag TAG --claim CLAIM [--projects-dir DIR] [--max-age-ms N] [--repo DIR]',
    '  -> {ok, key, n, counts, path, errors}; --claim = the claim `plan start` returned; takes the Fable plan review from the subagent transcript tagged TAG after proving the model (claude-fable- at effort high), the prompt header of the valid start and a transcript no older than the start, then re-lists the PR and checks the claim is still the earliest for the key; nothing is written on any refusal',
    '  -> exit 1 {error: no-start | stale-start | superseded | exists, or errors:[...]}, 2 no transcript for TAG, 3 GitHub could not confirm the claim',
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
  return { pr, gh, view, viewer, comments, events: listEvents(comments, viewer), bind, summary };
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
  const { config } = await requireConfig(root);
  const abs = path.resolve(ctx.cwd ?? process.cwd(), file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new UsageError(`--file must be inside the repository (${file})`);
  // The plan lives under config plan.dir: a plan anywhere else is refused before anything is read or posted.
  const planDir = path.posix.normalize(config.plan.dir).replace(/\/+$/, '');
  if (planDir !== '.' && !rel.startsWith(`${planDir}/`)) throw new UsageError(`--file ${rel} is outside plan.dir (${config.plan.dir}): write the plan there`);
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
    // Same refusal list as `approve`: never start a fresh record over one we cannot read (it may be a gate-stage one).
    if (['unsupported', 'invalid', 'legacy'].includes(px.summary.status)) {
      throw fail('record-unreadable', `the run record on this PR is ${px.summary.status} (from a newer or older pipeline, damaged or another PR's): update the pipeline CLI or fix the summary comment first; nothing was posted`);
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
    // Re-recording moves the run to the plan stage only from build / plan (or a fresh record): a later-stage record is never reset.
    const cur = px.summary.status === 'ok' ? px.summary.record : null;
    const toPlan = cur === null || cur.step === 'build' || cur.step === 'plan';
    const recorder = createRunRecorder({ gh: px.gh, pr: px.pr });
    recorder.update({ ...(toPlan ? { step: 'plan', outcome: null } : {}), plan: { path: rel, blob, scopeDigest: digest, state: 'proposed' }, ...(request !== undefined ? { request } : {}) }, { initialStep: 'plan' });
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
    // Like `record`: the checkout must be the PR head, so what is pinned below is what the PR holds.
    const local = headSha({ cwd: root });
    if (local !== px.view.headRefOid) throw fail('unpushed', `local HEAD ${local.slice(0, 7)} is not the PR head ${String(px.view.headRefOid).slice(0, 7)}: check out / push the PR head, then approve`);
    // The approved plan must be the committed file at its path (as `record` pins it): never approve a blob the checkout does not hold there.
    let atPath = null;
    try { atPath = active.path ? git(['rev-parse', `HEAD:${active.path}`], { cwd: root }).trim() : null; } catch { atPath = null; }
    if (atPath !== active.blob) throw fail('plan-changed', `the active plan blob ${active.blob.slice(0, 12)} is not the committed ${active.path || '(no path)'} at HEAD (${atPath ? atPath.slice(0, 12) : 'missing'}): check out the PR head, or record the plan again`);
    // A record we cannot read may be a gate-stage one: never reset it (spec B1).
    if (['unsupported', 'invalid', 'legacy'].includes(px.summary.status)) {
      throw fail('record-unreadable', `the run record on this PR is ${px.summary.status} (from a newer or older pipeline, damaged or another PR's): update the pipeline CLI or fix the summary comment first; nothing was posted`);
    }
    const home = ctx.home ?? accountHome();
    const now = () => nowOf(ctx);
    const wantRec = (r) => ({ pr: px.pr, blob: active.blob, scopeDigest: digest, recordId: r.recordId, promptSha256: r.promptSha256 });

    // REPAIR first: an approval event for this blob is already on the PR and the owner's record is still within 30 days
    // (resume accepts that long, so its repair must too). No new issuance, so the 24 h rule does not apply.
    const existingApproval = latestApproval(px.events, px.bind);
    const wasApproved = (e) => e.kind === 'plan-approved' && e.dataStatus === 'ok' && !e.tampered && e.data?.blob === active.blob
      && e.data?.repo === px.bind.repo && e.data?.pr === px.bind.pr && e.data?.branch === px.bind.branch;
    const old = recordsForRepo(readPlanApprovals({ home, now, maxAgeMs: PLAN_RECORD_MAX_AGE_MS }), px.bind.repo);
    // Only an event whose record is the owner's NEWEST for this PR repairs: an older approved plan replayed later is not (F4).
    const newestOld = newestLocalRecord(old, px.pr);
    const repairEvent = existingApproval.status === 'approved'
      ? px.events.filter(wasApproved).reverse().find((e) => { const m = matchingLocalRecord(old, wantRec({ recordId: e.data.recordId, promptSha256: e.data.promptSha256 })); return m !== null && newestOld !== null && m.recordId === newestOld.recordId; })
      : undefined;

    let event;
    let repaired = false;
    if (repairEvent) {
      repaired = true;
      event = { id: repairEvent.commentId, reused: true };
    } else {
      const recs = recordsForRepo(readPlanApprovals({ home, now, maxAgeMs: MAX_AGE_MS }), px.bind.repo).filter((r) => r.pr === px.pr).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
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

// ---- the reviewer budget: start, review, findings --------------------------------------------------------------------------
// A plan review is a paid run. Its slot is reserved by ONE event comment posted BEFORE the launch; the launch is owned by the
// caller whose `claim` is on the earliest comment for the key, and a reserved key is consumed even when the run then crashes.

const KEY_RE = /^[A-Za-z0-9._-]{1,48}$/;
const EXTRA_MAX = 500;
const PRIOR_MAX = 100_000;
const SESSION_RE = /^[A-Za-z0-9_-]{8,}$/;
// Fable plan reviews number their findings from here, so an id never collides with a Codex review's R1-/R2- ids.
const FABLE_BASE_N = 100;

function keyOption(values) {
  const key = requireOption(values, 'key');
  if (!KEY_RE.test(key)) throw new UsageError(`--key must match ${KEY_RE} (letters, digits, . _ -; at most 48)`);
  return key;
}

function extraOption(values) {
  if (values.extra === undefined) return undefined;
  const text = values.extra.trim();
  if (text === '') throw new UsageError('--extra must not be empty: it records the owner\'s words');
  if (text.length > EXTRA_MAX) throw new UsageError(`--extra is longer than ${EXTRA_MAX} characters`);
  return text;
}

const startOf = (comments, viewer, reviewer, key) => startsValidity(listEvents(comments, viewer)).find((x) => x.reviewer === reviewer && x.key === key);
const planDirOf = (root) => path.join(root, '.review', 'plan');
const keyDigest = (px, planBlob, key) => sha256([px.bind.repo, px.pr, 'fable-plan', planBlob, key].join('\n'));

// Reserve one launch: the claim protocol. Returns the valid start this caller owns, or throws the exit-1/3 reason it may not launch.
function reserve(px, { reviewer, key, extra, ctx }) {
  const active = activeOrFail(px.events, px.bind);
  const before = startOf(px.comments, px.viewer, reviewer, key);
  if (before) {
    throw fail('already-started', `${reviewer} key ${key} was already started (comment ${before.commentId}); a started key never launches twice, another run needs a new key`, { valid: before.valid, commentId: before.commentId });
  }
  const claim = randomBytes(8).toString('hex');
  try {
    postEvent(px.gh, px.pr, 'plan-review-started', `${reviewer}-${key}`, `Plan review started: ${reviewer} ${key}`, {
      ...px.bind, reviewer, key, planBlob: active.blob, claim, ...(extra ? { extra } : {}), at: isoOf(ctx), host: hostname(),
    });
  } catch (err) {
    // An ambiguous POST (timeout, 502) may still have created the comment: the re-list below decides.
    if (!(err instanceof GhError)) throw err;
  }
  const found = startOf(px.gh.listComments(px.pr), px.viewer, reviewer, key);
  if (!found) throw new Fail(EXIT.UNAVAILABLE, { ok: false, error: 'not-visible', message: 'the reservation comment was not listed back by GitHub: nothing may launch; run the command again (it re-checks the key)' });
  if (found.claim !== claim) throw fail('already-started', `another caller's reservation for ${reviewer} key ${key} is the earliest (comment ${found.commentId}): it owns the launch`, { commentId: found.commentId });
  if (!found.valid) throw fail('cap', `the per-PR ${reviewer} budget is used up (the start is recorded and takes no slot): the owner can allow one more with --extra "<their words>"`, { commentId: found.commentId });
  return { found, claim, active };
}

async function start(argv, ctx) {
  const { values } = parseCommandArgs(argv, { pr: { type: 'string' }, reviewer: { type: 'string' }, key: { type: 'string' }, extra: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  intOption(values, 'pr', { required: true, min: 1 });
  const reviewer = requireOption(values, 'reviewer');
  if (reviewer !== 'codex' && reviewer !== 'fable') throw new UsageError('--reviewer must be codex or fable');
  const key = keyOption(values);
  const extra = extraOption(values);
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  if (reviewer === 'codex') throw fail('use-plan-review', 'Codex plan reviews are reserved only by `pipeline plan review` (it launches the run itself), so no key can be burnt that nobody launches');
  return guardGh(() => {
    const px = prContext(values, ctx, root);
    const { found, claim } = reserve(px, { reviewer, key, extra, ctx });
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true, go: true, key, reviewer, planBlob: found.planBlob, claim,
        ...(reviewer === 'fable' ? { promptHeader: `ROUND: plan\nINPUT-DIGEST: ${keyDigest(px, found.planBlob, key)}` } : {}),
      },
    };
  });
}

// After a paid run: is this caller's reservation still the one that counts, and is the plan still the one that was reviewed?
// A run that no longer counts is written to <key>.superseded.json only (never a review, never booked); the owner sees it in the cost line.
function standing(px, { reviewer, key, claim, planBlob }) {
  const comments = px.gh.listComments(px.pr);
  const active = activeProposal(listEvents(comments, px.viewer), px.bind);
  if (active.status !== 'ok' || active.blob !== planBlob) return { ok: false, error: 'stale-start', message: 'the active plan changed while the review ran: the result is set aside, not counted' };
  const now = startOf(comments, px.viewer, reviewer, key);
  if (!now || (claim !== null && now.claim !== claim) || !now.valid) return { ok: false, error: 'superseded', message: 'another caller\'s reservation for this key is the earliest (or the start is no longer valid): the result is set aside, not counted' };
  return { ok: true };
}

const setAside = (root, key, payload) => {
  mkdirSync(planDirOf(root), { recursive: true });
  writeJson(path.join(planDirOf(root), `${key}.superseded.json`), payload);
};

const readJsonOrNull = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

const countsOf = (f) => ({ blocking: f.blocking.length, suggestions: f.suggestions.length, worth_considering: f.worth_considering.length });

async function review(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, key: { type: 'string' }, extra: { type: 'string' }, effort: { type: 'string' }, model: { type: 'string' }, prior: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  intOption(values, 'pr', { required: true, min: 1 });
  const key = keyOption(values);
  const extra = extraOption(values);
  const effort = values.effort ?? 'high';
  if (effort !== 'high' && effort !== 'xhigh') throw new UsageError('--effort must be high or xhigh');
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const model = values.model ?? config.review.codex_model;
  let priorText;
  if (values.prior !== undefined) {
    const abs = path.resolve(ctx.cwd ?? process.cwd(), values.prior);
    try {
      priorText = readFileSync(abs, 'utf8');
    } catch (err) {
      throw new UsageError(`--prior: cannot read ${values.prior} (${err.code ?? err.message})`);
    }
    if (Buffer.byteLength(priorText) > PRIOR_MAX) throw new UsageError(`--prior: ${values.prior} is larger than ${PRIOR_MAX} bytes`);
  }

  return guardGh(async () => {
    const px = prContext(values, ctx, root);
    // Everything that could refuse the launch is checked BEFORE the slot is reserved: a reserved key is consumed.
    const act = activeOrFail(px.events, px.bind);
    try {
      buildPlanReviewPrompt({ pr: px.pr, planPath: act.path, blob: act.blob, kind: 'review' });
      buildCodexArgs({ cwd: root, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath: path.join(planDirOf(root), 'x.raw.json'), json: true });
    } catch (err) {
      throw err.message.startsWith('invalid') ? new UsageError(err.message) : fail('plan-invalid', err.message);
    }
    const { found, claim, active } = reserve(px, { reviewer: 'codex', key, extra, ctx });
    const planBlob = found.planBlob;
    // The launch is bound to the blob it reserved for.
    if (active.blob !== planBlob) throw fail('stale-start', 'the active plan is not the one this start reserved');
    const dir = planDirOf(root);
    mkdirSync(dir, { recursive: true });

    const validCodex = startsValidity(listEvents(px.gh.listComments(px.pr), px.viewer)).filter((x) => x.reviewer === 'codex' && x.valid);
    const n = Math.max(1, validCodex.findIndex((x) => x.key === key) + 1);
    const earlier = validCodex.slice(0, Math.max(0, n - 1)).reverse();
    const kind = earlier.length > 0 ? 'recheck' : 'review';
    // The first run's session, usage and markdown: the most recent earlier start that completed.
    let from = null;
    for (const e of earlier) {
      const done = readJsonOrNull(path.join(dir, `${e.key}.json`));
      if (done) { from = { key: e.key, session: done.session, usage: done.usage, md: path.join(dir, `${e.key}.md`) }; break; }
    }
    let prior = priorText;
    if (kind === 'recheck' && prior === undefined && from && existsSync(from.md)) prior = readFileSync(from.md, 'utf8');

    let prompt;
    try {
      prompt = buildPlanReviewPrompt({ pr: px.pr, planPath: active.path, blob: planBlob, kind, priorFindingsMarkdown: prior ?? '' });
    } catch (err) {
      throw fail('plan-invalid', err.message);
    }
    const outPath = path.join(dir, `${key}.raw.json`);
    let args;
    let resumed = false;
    try {
      if (kind === 'recheck' && from && typeof from.session === 'string' && SESSION_RE.test(from.session) && !from.session.startsWith('-')) {
        args = buildCodexResumeArgs({ sessionId: from.session, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath });
        resumed = true;
      } else {
        args = buildCodexArgs({ cwd: root, model, effort, schemaPath: FINDINGS_SCHEMA_PATH, outPath, json: true });
      }
    } catch (err) {
      throw new UsageError(err.message);
    }

    const r = await askCodex({ root, args, prompt, outPath, env: ctx.env, json: true });
    if (!r.ok) {
      writeJson(path.join(dir, `${key}.failed.json`), { key, reviewer: 'codex', blob: planBlob, reason: r.reason, session: r.session ?? null, at: isoOf(ctx), ...(r.errors ? { errors: r.errors } : {}), ...(r.detail ? { detail: r.detail } : {}) });
      return {
        exitCode: EXIT.UNAVAILABLE,
        output: { ok: false, unavailable: true, reason: r.reason, key, session: r.session ?? null, ...(r.errors ? { errors: r.errors } : { code: r.code, timedOut: r.timedOut, detail: r.detail }) },
      };
    }

    let verdict;
    try {
      verdict = standing(px, { reviewer: 'codex', key, claim, planBlob });
    } catch (err) {
      if (!(err instanceof GhError)) throw err;
      setAside(root, key, { key, reviewer: 'codex', blob: planBlob, reason: 'github-unavailable', findings: r.findings, session: r.session, usage: r.usage, at: isoOf(ctx) });
      return { exitCode: EXIT.UNAVAILABLE, output: { ok: false, unavailable: true, reason: 'github', key, message: 'the run finished but GitHub could not confirm the reservation: the result is set aside, not counted' } };
    }
    if (!verdict.ok) {
      setAside(root, key, { key, reviewer: 'codex', blob: planBlob, reason: verdict.error, findings: r.findings, session: r.session, usage: r.usage, at: isoOf(ctx) });
      throw fail(verdict.error, verdict.message, { key, path: path.join(dir, `${key}.superseded.json`) });
    }

    const items = assignIds(r.findings, n, () => '', { contentHash: planBlob });
    writeJson(path.join(dir, `${key}.json`), {
      findings: r.findings, items, blob: planBlob, reviewer: 'codex', key, session: r.session, resumedFrom: resumed ? from.key : null, usage: r.usage,
    });
    writeFileAtomic(path.join(dir, `${key}.md`), renderFindingsMarkdown(r.findings, n, items));

    // Codex usage is cumulative over a resumed thread (see codex-run.mjs): a recheck books only its own share.
    let cost = 'not-reported';
    const own = r.session && r.usage ? (resumed ? usageDelta(r.usage, from.usage) : r.usage) : null;
    if (own) {
      const booked = await costRun([
        '--pr', String(px.pr), '--phase', 'plan', '--role', 'codex', '--execution', `codex:${r.session}:${key}`,
        '--input', String(Math.max(0, own.input_tokens - own.cached_input_tokens)), '--cache-read', String(own.cached_input_tokens),
        '--output', String(own.output_tokens), '--usd', '0', '--repo', root,
      ], ctx);
      cost = booked.output?.ok ? 'booked' : `failed:${booked.output?.error ?? 'not-recorded'}`;
    }
    return {
      exitCode: EXIT.OK,
      output: { ok: true, key, n, kind, resumed, counts: countsOf(r.findings), path: path.join(dir, `${key}.json`), session: r.session, cost },
    };
  });
}

async function findings(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, key: { type: 'string' }, tag: { type: 'string' }, claim: { type: 'string' }, 'projects-dir': { type: 'string' }, 'max-age-ms': { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  intOption(values, 'pr', { required: true, min: 1 });
  const key = keyOption(values);
  const tag = requireOption(values, 'tag');
  const claim = requireOption(values, 'claim');
  if (!/^[0-9a-f]{16}$/.test(claim)) throw new UsageError('--claim must be the 16-hex claim `plan start` returned');
  const maxAgeMs = intOption(values, 'max-age-ms', { min: 1 });
  const root = resolveRepo(values, ctx);
  await requireConfig(root);
  return guardGh(() => {
    const px = prContext(values, ctx, root);
    const comments = px.gh.listComments(px.pr);
    const starts = startsValidity(listEvents(comments, px.viewer));
    const start = starts.find((x) => x.reviewer === 'fable' && x.key === key);
    if (!start || !start.valid) throw fail('no-start', `no valid fable start for key ${key} on this PR (run \`pipeline plan start --reviewer fable\` first)`);
    const active = activeOrFail(listEvents(comments, px.viewer), px.bind);
    if (active.blob !== start.planBlob) throw fail('stale-start', 'the active plan is no longer the one this start reserved: the review would not be of the plan the owner sees');
    const dir = planDirOf(root);
    const outJson = path.join(dir, `${key}.json`);
    if (existsSync(outJson)) throw fail('exists', `findings for key ${key} are already recorded (${outJson})`);

    const found = findSubagentTranscript({ tag, projectsDir: values['projects-dir'], ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) });
    if (!found) throw new Fail(EXIT.USAGE, { ok: false, error: 'not-found', message: `no recent subagent transcript tagged ${JSON.stringify(tag)}` });
    const readOr = (file, what) => {
      try { return readFileSync(file, 'utf8'); } catch (err) { throw new Fail(EXIT.USAGE, { ok: false, error: 'read', message: `cannot read ${what} ${file}: ${err.code ?? err.message}` }); }
    };
    const jsonlText = readOr(found.jsonlPath, 'transcript');
    const metaText = found.metaPath === null ? undefined : readOr(found.metaPath, 'meta');

    const errors = [];
    // The transcript must start at or after the start event: an older one answers an older prompt.
    let firstTs = NaN;
    try { firstTs = Date.parse(JSON.parse(jsonlText.split('\n').find((l) => l.trim() !== '') ?? '').timestamp); } catch { firstTs = NaN; }
    const startedTs = Date.parse(start.createdAt ?? '');
    if (!Number.isFinite(firstTs) || !Number.isFinite(startedTs)) errors.push('the transcript\'s first line or the start event has no readable timestamp');
    else if (firstTs < startedTs) errors.push(`the transcript begins at ${new Date(firstTs).toISOString()}, older than the start event (${start.createdAt})`);

    const proof = proveModel({ jsonlText, metaText, expectModelPrefix: 'claude-fable-', expectEffort: 'high', expectMetaModel: null, expectAgentType: 'fable-reviewer' });
    errors.push(...proof.errors);
    const digest = keyDigest(px, start.planBlob, key);
    if (!/^ROUND: plan[ \t]*$/m.test(proof.firstUserText ?? '')) errors.push('the reviewer\'s prompt does not carry ROUND: plan');
    if (!new RegExp(`^INPUT-DIGEST: ${digest}[ \\t]*$`, 'm').test(proof.firstUserText ?? '')) errors.push('the reviewer\'s prompt does not carry this start\'s INPUT-DIGEST');

    let result = null;
    try {
      result = extractJsonBlock(proof.finalAssistantText);
      const checked = validateFindings(result);
      if (!checked.ok) { errors.push(...checked.errors.map((e) => `findings: ${e}`)); result = null; }
    } catch {
      errors.push('findings: no JSON found in the reviewer\'s final message');
    }
    if (errors.length > 0 || result === null) {
      return { exitCode: EXIT.FAILED, output: { ok: false, key, error: 'unproven', message: 'the transcript was not accepted: nothing was recorded', errors } };
    }

    // The claim recheck `review` does after its run: is this caller's reservation still the earliest, and the plan still the reviewed one?
    const verdict = standing(px, { reviewer: 'fable', key, claim, planBlob: start.planBlob }); // a GhError becomes exit 3 (guardGh)
    if (!verdict.ok) throw fail(verdict.error, verdict.message, { key });

    const n = FABLE_BASE_N + Math.max(1, starts.filter((x) => x.reviewer === 'fable' && x.valid).findIndex((x) => x.key === key) + 1);
    const items = assignIds(result, n, () => '', { contentHash: start.planBlob });
    mkdirSync(dir, { recursive: true });
    writeJson(outJson, { findings: result, items, blob: start.planBlob, reviewer: 'fable', key, transcript: found.jsonlPath });
    writeFileAtomic(path.join(dir, `${key}.md`), renderFindingsMarkdown(result, n, items).replace(/^# Codex review — round \d+/, '# Fable plan review'));
    return { exitCode: EXIT.OK, output: { ok: true, key, n, counts: countsOf(result), path: outJson, errors: [] } };
  });
}


const SUBCOMMANDS = { record, approve, risk, start, review, findings };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline plan ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
