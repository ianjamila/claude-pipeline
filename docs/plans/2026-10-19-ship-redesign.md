# Ship redesign (redesign PR 4) Implementation Plan

> **For agentic workers:** this plan is executed by the `ship` pipeline itself (owner decision D2: ship's implementer
> agents build it task by task, no SDD loop on top). Each `### Task` is one implementer dispatch. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** make every ship run plan first, get the owner's typed "approve" bound to the exact plan, review by risk with the
right models, flag out-of-plan files at the merge gate, and hand a busy-main PR to the owner for a GitHub merge.

**Architecture:** a pure plan parser (`lib/plan.mjs`) and pure evidence logic over PR event comments
(`lib/plan-state.mjs`) feed a new `P plan` command (record / approve / risk / start / review / findings). The trust root
is the owner-go record (hook-written, guarded) plus the plan's git blob; PR events are pointers only. The final gate gains
a `plan-scope` check; review rounds gain derived reviewer obligations (security, Fable final pass); a new `P handoff`
command covers cp #88; resume / inbox / summary learn the new step and outcomes.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, no dependencies. GitHub via the `gh` CLI wrapper (`pipeline/lib/github.mjs`),
Codex via `codex exec` (`pipeline/lib/codex.mjs`).

**Spec:** `docs/specs/2026-10-19-ship-redesign-design.md` (r4, owner-approved 2026-10-19). Read it with this plan; section
numbers below (§N) refer to it.

## In plain English
Before writing code, every ship run now writes a short plan, shows it to the owner, and waits for the owner to type
"approve". The approval is tied to that exact plan, and the merge gate later lists any file the PR changed that the plan
did not mention. Reviewers are chosen by risk, cheaper models do routine checks, and when main moves too fast to catch
up the pipeline hands the owner a green PR to merge in GitHub with an honest note of what was tested.

## Scope
- `pipeline/lib/plan.mjs`
- `pipeline/lib/plan-state.mjs`
- `pipeline/lib/obligations.mjs`
- `pipeline/lib/handoff.mjs`
- `pipeline/lib/codex-run.mjs`
- `pipeline/lib/run-record.mjs`
- `pipeline/lib/run-events.mjs`
- `pipeline/lib/run-cost.mjs`
- `pipeline/lib/config.mjs`
- `pipeline/lib/finalgate.mjs`
- `pipeline/lib/risk.mjs`
- `pipeline/lib/hardstops.mjs`
- `pipeline/lib/codex.mjs`
- `pipeline/lib/triage.mjs`
- `pipeline/lib/state.mjs`
- `pipeline/lib/resume-plan.mjs`
- `pipeline/lib/inbox.mjs`
- `pipeline/lib/notify.mjs`
- `pipeline/lib/installer.mjs`
- `pipeline/lib/pr-facts.mjs`
- `pipeline/lib/updatebranch.mjs`
- `pipeline/commands/plan.mjs`
- `pipeline/commands/review.mjs`
- `pipeline/commands/handoff.mjs`
- `pipeline/commands/cost.mjs`
- `pipeline/commands/codex-review.mjs`
- `pipeline/commands/merge.mjs`
- `pipeline/commands/update-branch.mjs`
- `pipeline/commands/resume.mjs`
- `pipeline/commands/inbox.mjs`
- `pipeline/commands/summary.mjs`
- `pipeline/commands/risk.mjs`
- `pipeline/commands/final-gate.mjs`
- `pipeline/commands/review-complete.mjs`
- `pipeline/hooks/lib/owner-go.mjs`
- `pipeline/hooks/owner-go.mjs`
- `pipeline/hooks/lib/files-policy.mjs`
- `agents/*.md`
- `skills/ship/**`
- `skills/verify/SKILL.md`
- `docs/cli.md`
- `docs/plans/2026-10-19-ship-redesign.md`
- `docs/specs/2026-10-19-ship-redesign-design.md`
- `test/**`
- `VERSION`

## Global Constraints
- Node ≥ 20, ESM (`"type": "module"`), no new npm dependencies.
- Every cp file is a hard-stop (`hard_stops.paths: ["**"]`): the owner merges in chat; nothing auto-merges.
- **No new keys in cp's own `.claude/pipeline.yml`** (§8: the installed CLI would reject them; defaults give the
  behaviour). `test/self-verify.test.mjs` loads that file and must stay green.
- `config.mjs` rejects unknown keys: every new key goes into `DEFAULTS` and `KEYS`.
- `skills/*/SKILL.md` ≤ 500 lines (`test/docs-facts.test.mjs`). Every `P <cmd> [<sub>] --flag` written in `skills/**` or
  `agents/**` must appear in that command's `meta.usage` (`test/skills-commands.test.mjs`).
- A new agent file must be added to `AGENTS` in `pipeline/lib/installer.mjs` AND to `PROTECTED_REL` in
  `pipeline/hooks/lib/files-policy.mjs`.
- Approval word "approve"; out-of-plan files = owner-merge items (label mode: blocking); small plans are committed too.
- Plan request lines (exact): `Plan <blob40> · scope <scopeDigest12>` then `📋 Ready to approve plan #N — say "approve"`.
- Caps per PR: Codex 2 (review + recheck), Fable 1; owner extras recorded verbatim.
- Test command: `node scripts/test.mjs <filename-substring>`; quick verify `node scripts/verify.mjs --quick`; full
  `node scripts/verify.mjs`.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Bump `VERSION` 0.1.0 → 0.2.0 (records become v2; both machines must update).

## Review Focus
1. A plan whose body contains fenced code blocks with `## ` or `### Task` lines (this very plan) must not be parsed as
   sections or tasks → T1 test "headings inside fences are ignored".
2. Deleted and renamed files against the scope: a deletion has `newPath: null`; a rename must have BOTH paths in scope →
   T1 `outsideScope` tests (delete, rename half-covered).
3. A reply ending in a merge request (🔀) answered with "approve", or ending in a plan request (📋) answered with "merge",
   must record nothing of the other kind → T3 cross tests.
4. GitHub lists comments without the one just posted (eventual listing): `plan start` must exit 3 `not-visible`, never
   `go` → T5 test with a fake gh that drops the new comment.
5. Legacy PRs and test fixtures with no plan events: chat mode → one `plan-scope none` item; label mode → the gate fails;
   `plan.required: false` → report only. Existing gate tests must keep passing via the helper default → T6.
6. Event data is a pointer: a forged `path` exempts nothing (T4 `trustedPlanPath`, T6 test h); one key = at most one
   paid launch, owned by the earliest comment's `claim` (T5 tests 2, 2b).
7. Partial failures resume safely: approval event posted + checkpoint failed → `build` via `P plan approve` (T9 d2/d3);
   a confirmed branch update is recorded on every `bringUpToDate` exit (T8).

## Revision log
- r2 (2026-10-20, Codex astra-xhigh plan review, 8 P1 / 4 P2 / 1 P3, all verified against the code and folded):
  R1-1 trusted plan path (T4/T6); R1-2 launch ownership by `claim` + extras after a void start (T4/T5); R1-3
  `lastRequestText` plan marker + duplicate-line rejection (T3); R1-4 decoded summary used directly (T4/T6); R1-5 resume
  judged against the approved blob's tasks + `needsApproveCheckpoint` (T4/T9); R1-6 `protection.json` + update pairs
  from `bringUpToDate` on every exit (T8); R1-7 CI-tested base from the run, pinned `gate.head`, re-check before post
  (T8); R1-8 round-range files + `base0.repo` (T7); R1-9 `scopeMayHitGlob` (T4); R1-10 Codex session/usage via
  `--json` + `exec resume` (T5); R1-11 no cost-entry eviction (T2); R1-12 fenced-text assertion + config keys moved to
  T4; P3 `runShellAsync` (T8). Spec clarification (R1-2): a void start takes no slot, so one owner extra after it buys
  exactly one more run.

---

### Task T1: Plan parser and scope matcher (`lib/plan.mjs`)

**Files:**
- Create: `pipeline/lib/plan.mjs`
- Test: `test/plan.test.mjs`

**Interfaces:**
- Consumes: `matchAny(path, globs)` from `pipeline/lib/glob.mjs`; `LIMITS` from `pipeline/lib/run-record.mjs`; `clip` from
  `pipeline/lib/render.mjs`.
- Produces:
  - `class PlanError extends Error { problems: string[] }`
  - `MAX_PLAN_BYTES = 262144`, `MAX_SCOPE_ENTRIES = 500`
  - `parsePlan(text: string) → { plainEnglish: string, scope: string[], tasks: Array<{id, title, text, spec, specSha}> }`
    (throws `PlanError`)
  - `scopeDigest(scope: string[]) → string` (12 hex)
  - `outsideScope({ files, scope, planPath }) → string[]` (sorted unique paths)
  - `planRequestLines({ pr, blob, scopeDigest }) → [string, string]`
  - `PLAN_LINE_RE`, `PLAN_READY_RE` (owner-go keeps an identical copy, T3)

- [ ] **Step 1: Write the failing tests** (`test/plan.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, outsideScope, parsePlan, planRequestLines, scopeDigest } from '../pipeline/lib/plan.mjs';

const PLAN = [
  '# Thing', '', '## In plain English', 'It does a thing.', '',
  '## Scope', '- `src/a.mjs`', '- `test/**`', '* `docs/x.md` (the doc)', '',
  '### Task T1: First', 'Acceptance: a works.   ', '', '### Task T2: Second', 'b works', '',
].join('\n');

test('parses plain English, scope and tasks', () => {
  const p = parsePlan(PLAN);
  assert.equal(p.plainEnglish, 'It does a thing.');
  assert.deepEqual(p.scope, ['src/a.mjs', 'test/**', 'docs/x.md']);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.title]), [['T1', 'First'], ['T2', 'Second']]);
  assert.equal(p.tasks[0].text, 'Acceptance: a works.');
  assert.match(p.tasks[0].specSha, /^[0-9a-f]{12}$/);
});

test('specSha is computed on the full text before clipping and ignores CRLF / trailing spaces', () => {
  const long = 'x'.repeat(3000);
  const a = parsePlan(PLAN.replace('b works', `${long}A`));
  const b = parsePlan(PLAN.replace('b works', `${long}B`));
  assert.equal(a.tasks[1].spec, b.tasks[1].spec); // both clipped to LIMITS.spec
  assert.notEqual(a.tasks[1].specSha, b.tasks[1].specSha);
  assert.equal(parsePlan(PLAN.replaceAll('\n', '\r\n')).tasks[0].specSha, parsePlan(PLAN).tasks[0].specSha);
});

test('headings inside fenced code blocks are ignored', () => {
  const fenced = PLAN + ['```markdown', '## Scope', '- `evil/**`', '### Task T9: Fake', '```', ''].join('\n');
  const p = parsePlan(fenced);
  assert.deepEqual(p.scope, ['src/a.mjs', 'test/**', 'docs/x.md']);
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2']);
  assert.ok(p.tasks[1].text.includes('### Task T9'), 'a fenced block stays part of the task text (full definition)');
});

test('missing sections, empty scope, bad entries and duplicate ids are refused with every problem listed', () => {
  assert.throws(() => parsePlan('# x\n'), (e) => e instanceof PlanError && e.problems.length === 3);
  assert.throws(() => parsePlan(PLAN.replace('- `src/a.mjs`', '- `../up.mjs`')), /\.\./);
  assert.throws(() => parsePlan(PLAN.replace('- `src/a.mjs`', '- `/abs.mjs`')), /absolute/);
  assert.throws(() => parsePlan(PLAN.replace('### Task T2', '### Task T1')), /duplicate task id T1/);
});

test('scopeDigest is order- and duplicate-insensitive', () => {
  assert.equal(scopeDigest(['b', 'a', 'a']), scopeDigest(['a', 'b']));
  assert.match(scopeDigest(['a']), /^[0-9a-f]{12}$/);
});

test('outsideScope: renames need both paths, deletions use the old path, the plan file is always allowed', () => {
  const f = (oldPath, newPath, status = 'M') => ({ oldPath, newPath, path: newPath ?? oldPath, status });
  const files = [f('src/a.mjs', 'src/a.mjs'), f('lib/old.mjs', 'src/new.mjs', 'R'), f('gone.mjs', null, 'D'), f('docs/plans/p.md', 'docs/plans/p.md')];
  assert.deepEqual(outsideScope({ files, scope: ['src/**'], planPath: 'docs/plans/p.md' }), ['gone.mjs', 'lib/old.mjs']);
});

test('planRequestLines renders the exact two terminal lines', () => {
  assert.deepEqual(planRequestLines({ pr: 7, blob: 'a'.repeat(40), scopeDigest: 'b'.repeat(12) }), [
    `Plan ${'a'.repeat(40)} · scope ${'b'.repeat(12)}`,
    '📋 Ready to approve plan #7 — say "approve"',
  ]);
});
```

- [ ] **Step 2: Run to verify it fails** — `node scripts/test.mjs plan.test` → FAIL (module not found).

- [ ] **Step 3: Implement `pipeline/lib/plan.mjs`**

```js
// The plan file every ship run commits before building (spec 2026-10-19 §2). Pure: no IO. The plan's scope and tasks are
// always re-parsed from the approved git blob (never from event data), so editing the file after approval changes nothing.
import { createHash } from 'node:crypto';
import { matchAny } from './glob.mjs';
import { clip } from './render.mjs';
import { LIMITS } from './run-record.mjs';

export const MAX_PLAN_BYTES = 256 * 1024;
export const MAX_SCOPE_ENTRIES = 500;
export const PLAN_LINE_RE = /^\s*Plan\s+([0-9a-f]{40})\s*(?:·|\|)\s*scope\s+([0-9a-f]{12})\s*$/;
export const PLAN_READY_RE = /📋\s*Ready to approve plan\s+#(\d{1,6})\b/;
const TASK_HEAD = /^### Task ([A-Za-z0-9._-]{1,64}):[ \t]+(\S.*?)\s*$/;
const SCOPE_ITEM = /^\s*[-*]\s+`([^`\n]+)`/;
const FENCE = /^\s*(```|~~~)/;

export class PlanError extends Error {
  constructor(problems) {
    super(`plan: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Line i is inside a fenced code block (the fence lines themselves count as inside).
function fenceMask(lines) {
  const mask = [];
  let open = null;
  for (const l of lines) {
    const m = FENCE.exec(l);
    if (open) { mask.push(true); if (m && m[1] === open) open = null; continue; }
    if (m) { open = m[1]; mask.push(true); continue; }
    mask.push(false);
  }
  return mask;
}

function sectionLines(lines, mask, title) {
  const re = new RegExp(`^## ${title}\\s*$`, 'i');
  const start = lines.findIndex((l, i) => !mask[i] && re.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && !mask[i] && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { lines: lines.slice(start + 1, end), mask: mask.slice(start + 1, end) };
}

function trimBlank(arr) {
  const out = arr.map((l) => l.replace(/[ \t]+$/, ''));
  while (out.length && out[0] === '') out.shift();
  while (out.length && out.at(-1) === '') out.pop();
  return out;
}

export function scopeProblem(e) {
  if (e.startsWith('/') || /^[A-Za-z]:/.test(e)) return 'absolute paths are not allowed';
  if (e.includes('\\')) return 'use forward slashes';
  if (e.split('/').includes('..')) return '".." is not allowed';
  if (e.startsWith('!')) return 'negated entries are not allowed';
  return null;
}

export function parsePlan(text) {
  if (typeof text !== 'string') throw new PlanError(['the plan is not text']);
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw new PlanError([`the plan is larger than ${MAX_PLAN_BYTES} bytes`]);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const problems = [];

  const pe = sectionLines(lines, mask, 'In plain English');
  const plainEnglish = pe ? trimBlank(pe.lines).join('\n') : '';
  if (!plainEnglish) problems.push('missing or empty "## In plain English" section');

  const sc = sectionLines(lines, mask, 'Scope');
  const scope = [];
  if (!sc) problems.push('missing "## Scope" section');
  else {
    sc.lines.forEach((l, i) => {
      if (sc.mask[i]) return;
      const m = SCOPE_ITEM.exec(l);
      if (!m) return;
      const e = m[1].trim();
      const why = scopeProblem(e);
      if (why) problems.push(`scope entry ${JSON.stringify(e)}: ${why}`);
      else if (!scope.includes(e)) scope.push(e);
    });
    if (scope.length === 0) problems.push('the "## Scope" section lists no backticked paths');
    if (scope.length > MAX_SCOPE_ENTRIES) problems.push(`more than ${MAX_SCOPE_ENTRIES} scope entries`);
  }

  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = TASK_HEAD.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (mask[j] || !/^#{2,3} /.test(lines[j]))) j++;
    const [id, title] = [m[1], m[2]];
    if (seen.has(id)) problems.push(`duplicate task id ${id}`);
    seen.add(id);
    const body = trimBlank(lines.slice(i + 1, j)).join('\n');
    tasks.push({ id, title: clip(title, LIMITS.title), text: body, spec: clip(body, LIMITS.spec), specSha: sha(`${title}\n${body}`).slice(0, 12) });
    i = j - 1;
  }
  if (tasks.length === 0) problems.push('no "### Task <id>: <title>" headings');
  if (tasks.length > LIMITS.tasks) problems.push(`more than ${LIMITS.tasks} tasks`);
  if (problems.length) throw new PlanError(problems);
  return { plainEnglish, scope, tasks };
}

export const scopeDigest = (scope) => sha([...new Set(scope.map(String))].sort().join('\n')).slice(0, 12);

export function outsideScope({ files, scope, planPath }) {
  const out = new Set();
  for (const f of files ?? []) {
    for (const p of new Set([f.oldPath, f.newPath, f.path].filter((x) => typeof x === 'string' && x !== '' && x !== '/dev/null'))) {
      if (p === planPath) continue;
      if (!matchAny(p, scope)) out.add(p);
    }
  }
  return [...out].sort();
}

export const planRequestLines = ({ pr, blob, scopeDigest: d }) => [
  `Plan ${blob} · scope ${d}`,
  `📋 Ready to approve plan #${pr} — say "approve"`,
];
```

- [ ] **Step 4: Run** `node scripts/test.mjs plan.test` → PASS.
- [ ] **Step 5: Commit** `git add pipeline/lib/plan.mjs test/plan.test.mjs && git commit -m "feat(plan): plan parser, scope digest and scope matcher"` (+ trailer).

---

### Task T2: Record v2, plan events with tamper flag, keyed cost entries

**Files:**
- Modify: `pipeline/lib/run-record.mjs` (STEPS/OUTCOMES/OUTCOME_STEP/OUTCOME_NEXT ~12-68, `RECORD_VERSION` 10,
  `emptyRecord` 94, `shapeProblem` 121, `normaliseTask` 221, `applyCheckpoint` 246)
- Modify: `pipeline/lib/run-events.mjs` (`EVENT_KINDS` 7, `listEvents` 44)
- Modify: `pipeline/lib/run-cost.mjs` (`ROLES` 10, `PHASES` 13, `costShapeProblem` 92; add `bookCost`)
- Modify: `pipeline/commands/cost.mjs` (`--execution`, verify-after-write)
- Test: `test/run-record.test.mjs` (extend), `test/run-events.test.mjs` (create if absent, else extend), `test/run-cost.test.mjs` (extend)

**Interfaces:**
- Produces:
  - `STEPS` = `['plan', 'build', 'verify', 'pr', 'review', 'gate', 'awaiting-owner-merge', 'merge', 'prod-watch', 'ended']`
  - `OUTCOMES` += `'awaiting-plan-approval'` (→ step `plan`, next `owner reads the plan and says "approve"`), `'owner-ui-merge'`
    (→ step `awaiting-owner-merge`, next `owner merges in GitHub if they accept the hand-off`)
  - `RECORD_VERSION = 2`; v1 records still decode; every `applyCheckpoint` writes `v: 2`
  - record optional fields: `plan: {path, blob, scopeDigest, state: 'proposed'|'approved'}`,
    `behindBaseUpdates: [{headBefore, baseTip}]` (≤ 20), `handoff: {head, baseTip, at}`
  - patch keys `plan`, `behindBaseUpdate` (appends a distinct pair), `handoff`
  - tasks carry optional `specSha` (12 hex); `done` survives only while `specSha` is unchanged
  - `EVENT_KINDS` += `'plan-proposed', 'plan-approved', 'plan-review-started'`
  - `listEvents` entries gain `createdAt` and `tampered` (`created_at` and `updated_at` both present and different)
  - `ROLES` += `'codex', 'fable', 'security', 'screenshot'`; `PHASES` += `'plan'`
  - `bookCost(cost, entry, { key }) → cost` (key matches `EXEC_KEY_RE = /^(agent|codex|ctl|plan):[A-Za-z0-9._:-]{1,120}$/`;
    same key replaces), `MAX_COST_ENTRIES = 200`. Invariant: `total`/`byPhase`/`byRole` = unkeyed bookings + the sum of
    `entries`; nothing is ever evicted, so a replayed key is always recognised. At the limit a NEW key throws
    `cost-entries-full` (replacing an existing key still works); `P cost` exits 1 with that error (Codex plan R1-11).
  - `P cost … --execution KEY`

- [ ] **Step 1: Failing tests**

```js
// test/run-record.test.mjs (append)
import { RECORD_VERSION, STEPS, OUTCOME_STEP, applyCheckpoint, decodeRecord, emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
const AT = { host: 'mac', now: Date.parse('2026-10-19T00:00:00Z') };
const H = (c) => c.repeat(40);

test('v2: plan step first, new outcomes routed, v1 records still read, writes upgrade to v2', () => {
  assert.equal(RECORD_VERSION, 2);
  assert.equal(STEPS[0], 'plan');
  assert.equal(OUTCOME_STEP['awaiting-plan-approval'], 'plan');
  assert.equal(OUTCOME_STEP['owner-ui-merge'], 'awaiting-owner-merge');
  const v1 = { ...emptyRecord({ repo: 'a/b', pr: 3, branch: 'x', baseRef: 'main' }), v: 1 };
  assert.equal(decodeRecord(`${MARKERS.summary}\n${encodeRecord(v1)}`).status, 'ok');
  assert.equal(applyCheckpoint(v1, { step: 'plan' }, AT).v, 2);
  assert.equal(decodeRecord(`${MARKERS.summary}\n${encodeRecord({ ...v1, v: 3 })}`).status, 'unsupported');
});

test('plan, behindBaseUpdate (distinct pairs, capped) and handoff patches', () => {
  let r = emptyRecord({ repo: 'a/b', pr: 3, branch: 'x', baseRef: 'main' });
  r = applyCheckpoint(r, { plan: { path: 'docs/plans/p.md', blob: H('a'), scopeDigest: 'b'.repeat(12), state: 'proposed' } }, AT);
  assert.equal(r.plan.state, 'proposed');
  assert.throws(() => applyCheckpoint(r, { plan: { path: 'p', blob: 'zz', scopeDigest: 'b'.repeat(12), state: 'proposed' } }, AT), /plan/);
  const pair = { headBefore: H('1'), baseTip: H('2') };
  r = applyCheckpoint(r, { behindBaseUpdate: pair }, AT);
  r = applyCheckpoint(r, { behindBaseUpdate: pair }, AT);
  assert.equal(r.behindBaseUpdates.length, 1);
  r = applyCheckpoint(r, { handoff: { head: H('3'), baseTip: H('4'), at: '2026-10-19T00:00:00Z' } }, AT);
  assert.equal(r.handoff.baseTip, H('4'));
  assert.equal(decodeRecord(`${MARKERS.summary}\n${encodeRecord(r)}`).status, 'ok');
});

test('task done survives only while specSha is unchanged', () => {
  let r = emptyRecord({ repo: 'a/b', pr: 3, branch: 'x', baseRef: 'main' });
  r = applyCheckpoint(r, { tasks: [{ id: 'T1', title: 't', spec: 's', specSha: 'a'.repeat(12) }], done: ['T1'] }, AT);
  assert.equal(applyCheckpoint(r, { tasks: [{ id: 'T1', title: 't', spec: 's', specSha: 'a'.repeat(12) }] }, AT).tasks[0].done, true);
  assert.equal(applyCheckpoint(r, { tasks: [{ id: 'T1', title: 't', spec: 's2', specSha: 'c'.repeat(12) }] }, AT).tasks[0].done, false);
});
```

```js
// test/run-events.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { listEvents, renderEvent } from '../pipeline/lib/run-events.mjs';
const c = (id, body, extra = {}) => ({ id, body, user: { login: 'me' }, created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z', ...extra });

test('plan event kinds render and parse; an edited comment is tampered; createdAt is kept', () => {
  const body = renderEvent('plan-proposed', 'aaaaaaaaaaaa-1', 'Plan proposed', { blob: 'a'.repeat(40) });
  const ev = listEvents([c(2, body), c(1, body, { updated_at: '2026-10-19T01:00:00Z' })], 'me');
  assert.deepEqual(ev.map((e) => [e.commentId, e.tampered]), [[1, true], [2, false]]);
  assert.equal(ev[1].createdAt, '2026-10-19T00:00:00Z');
  for (const k of ['plan-approved', 'plan-review-started']) assert.ok(renderEvent(k, 'x', 's', {}));
});
```

```js
// test/run-cost.test.mjs (append)
import { MAX_COST_ENTRIES, bookCost, emptyCost } from '../pipeline/lib/run-cost.mjs';
const E = (input) => ({ phase: 'plan', role: 'codex', input, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.5 });

test('bookCost: the same execution key replaces its entry; totals stay derived', () => {
  let c = bookCost(emptyCost(), E(100), { key: 'codex:s1' });
  c = bookCost(c, E(150), { key: 'codex:s1' });
  assert.equal(c.total.input, 150);
  assert.equal(c.total.calls, 1);
  assert.equal(c.byPhase.plan.input, 150);
  assert.equal(c.byRole.codex.input, 150);
  c = bookCost(c, E(10), { key: 'agent:x' });
  assert.equal(c.total.input, 160);
  assert.throws(() => bookCost(c, E(1), { key: 'nope' }), /execution key/);
});

test('bookCost never evicts: at the limit a new key is refused, an existing key still replaces, totals never double', () => {
  let c = emptyCost();
  for (let i = 0; i < MAX_COST_ENTRIES; i++) c = bookCost(c, E(1), { key: `agent:a${i}` });
  assert.throws(() => bookCost(c, E(1), { key: 'agent:new' }), /cost-entries-full/);
  const again = bookCost(c, E(5), { key: 'agent:a0' }); // the oldest key, replayed (retry / other machine)
  assert.equal(again.total.input, MAX_COST_ENTRIES - 1 + 5);
  assert.equal(again.total.calls, MAX_COST_ENTRIES);
});
```

- [ ] **Step 2: Run** `node scripts/test.mjs run-record run-events run-cost` → FAIL.

- [ ] **Step 3: Implement**
  - `run-record.mjs`:
    - `RECORD_VERSION = 2`; prepend `'plan'` to `STEPS`; add the two outcomes to `OUTCOMES`, `OUTCOME_STEP`,
      `OUTCOME_NEXT` with the `next` texts above.
    - `emptyRecord` keeps `step: 'build'` (callers pass `step: 'plan'` explicitly) and `v: RECORD_VERSION`.
    - `shapeProblem`: accept `r.v` 1 or 2. Validate the optional fields:
      - `plan`: `isPlainObject` + `blob` /^[0-9a-f]{40}$/ + `scopeDigest` /^[0-9a-f]{12}$/ + `state` in
        `['proposed','approved']` + `path` string ≤ 200;
      - `behindBaseUpdates`: an array of ≤ 20 `{headBefore, baseTip}` 40-hex pairs;
      - `handoff`: `{head, baseTip}` 40-hex + `at` string;
      - a task's `specSha`, when present, /^[0-9a-f]{12}$/.
    - `normaliseTask(t, previous)`:
```js
const specSha = t.specSha ?? previous?.specSha;
const changed = typeof t.specSha === 'string' && typeof previous?.specSha === 'string' && t.specSha !== previous.specSha;
return {
  id: String(t.id),
  title: text(t.title ?? previous?.title, LIMITS.title),
  spec: text(t.spec ?? previous?.spec, LIMITS.spec),
  ...(typeof specSha === 'string' && /^[0-9a-f]{12}$/.test(specSha) ? { specSha } : {}),
  done: t.done === undefined ? (!changed && previous?.done === true) : t.done === true,
};
```
    - `applyCheckpoint`: `next.v = RECORD_VERSION`, then:
```js
if (patch.plan !== undefined) next.plan = normalisePlan(patch.plan); // throws 'plan: …' on a bad shape (same checks as shapeProblem)
if (patch.behindBaseUpdate != null) {
  const p = normalisePair(patch.behindBaseUpdate); // 40-hex headBefore/baseTip or throw
  const list = next.behindBaseUpdates ?? [];
  if (!list.some((x) => x.headBefore === p.headBefore && x.baseTip === p.baseTip)) next.behindBaseUpdates = [...list, p].slice(-20);
}
if (patch.handoff !== undefined) next.handoff = patch.handoff === null ? null : normaliseHandoff(patch.handoff);
```
      Update the `applyCheckpoint` doc comment listing patch keys.
  - `run-events.mjs`: add the three kinds to `EVENT_KINDS`. In `listEvents`, map to
    `{ commentId, url, createdAt: c.created_at ?? null, tampered: Boolean(c.created_at && c.updated_at && c.updated_at !== c.created_at), ...event }`.
    Update the header comment: an edited event comment is tampered; readers that rely on an event must treat tampered as
    unreadable.
  - `run-cost.mjs`: add the roles and the phase. Add `bookCost`:
```js
export const MAX_COST_ENTRIES = 200;
export const EXEC_KEY_RE = /^(agent|codex|ctl|plan):[A-Za-z0-9._:-]{1,120}$/;
// One execution's usage, booked once: booking the same key again REPLACES its earlier entry (a retry, or the same
// transcript booked on another machine, never double-counts). Totals stay the sum of what was booked.
export function bookCost(cost, entry, { key } = {}) {
  if (key === undefined) return addCostEntry(cost, entry);
  if (!EXEC_KEY_RE.test(String(key))) throw new Error(`bad execution key ${JSON.stringify(String(key).slice(0, 40))}`);
  let c = cost ?? emptyCost();
  const old = c.entries?.[key];
  // Never evict: an evicted key would be booked again on replay while its old amount stays in the totals.
  if (!old && Object.keys(c.entries ?? {}).length >= MAX_COST_ENTRIES) throw new Error(`cost-entries-full: ${MAX_COST_ENTRIES} keyed entries already booked on this PR`);
  if (old) c = subtractCostEntry(c, old);
  c = addCostEntry(c, entry);
  return { ...c, entries: { ...(c.entries ?? {}), [key]: normalisedEntry(entry) } }; // { phase, role (normalised), input, output, cacheRead, cacheWrite, usd } exactly as addCostEntry stored them
}
```
    `subtractCostEntry` mirrors `addCostEntry` (same normalisation, subtracts every amount and one `call` from `total`,
    `byPhase[phase]`, `byRole[role]`, rounding `usd` to 6 decimals, never below 0). `costShapeProblem` accepts an
    optional `entries` plain object.
  - `commands/cost.mjs`: add `execution: { type: 'string' }` and `--execution KEY` to `meta.usage`. With it, call
    `bookCost(..., { key })` through the record patch. Then **verify after write**: re-read with
    `readSummaryComment(gh, pr)`; if `record.cost.entries?.[key]` does not deep-equal what was booked, re-apply and
    write again (max 3 attempts). Still missing → exit 1 `{ ok: false, error: 'not-persisted', key }`. Without
    `--execution` the behaviour is unchanged. Booking a key needs the patch path to support it: add
    `patch.cost.keyedEntry = { key, entry }` handled in `applyCheckpoint` via `bookCost`.
  - Test in `test/cli-gate-log.test.mjs`'s style (import `run` from `pipeline/commands/cost.mjs` with a fake gh):
    booking the same `--execution codex:s1` twice leaves `calls: 1`; a fake gh whose upsert silently drops the write
    → exit 1 `not-persisted`.

- [ ] **Step 4: Run** `node scripts/test.mjs run-record run-events run-cost cost checkpoint resume-plan inbox summary` → PASS
  (existing tests that assert `RECORD_VERSION === 1` or the old `STEPS` list are updated to the new values, nothing else).
- [ ] **Step 5: Commit** `feat(record): v2 record with plan step + outcomes, tamper-aware events, keyed cost entries`.

---

### Task T3: Owner-go recorder learns "approve"

**Files:**
- Modify: `pipeline/hooks/lib/owner-go.mjs` (`parseApproval` 43, `recordApproval` 170, `readApprovals` 213)
- Modify: `pipeline/hooks/owner-go.mjs` (context line)
- Test: `test/owner-go.test.mjs` (extend), `test/guard-owner-go.test.mjs` (run, unchanged)

**Interfaces:**
- Consumes: nothing from `pipeline/lib/`. The hook lib must stay self-contained (`lib/finalgate.mjs` imports FROM
  `hooks/lib/owner-go.mjs`, never the other way, and projects may vendor hook files without `lib/`). So owner-go.mjs
  defines its OWN copies of `PLAN_LINE_RE` / `PLAN_READY_RE`, and a parity test asserts
  `ownerGo.PLAN_LINE_RE.source === plan.PLAN_LINE_RE.source` (same for READY).
- Produces:
  - `parsePlanApproval(prompt) → null | { prs: number[], blobs: string[] }`
  - `presentedPlanRequest(text) → null | { pr, blob, scopeDigest }`
  - plan record line: `{ v: 1, kind: 'plan', ts, session, prompt_sha256, record_id, cwd, prs: [], requests: [], plan: { pr, blob, scopeDigest } }`
  - `PLAN_RECORD_MAX_AGE_MS = 30 * 24 * 3600 * 1000`
  - `readPlanApprovals({ home, now, maxAgeMs = PLAN_RECORD_MAX_AGE_MS }) → Array<{ ts, session, recordId, promptSha256, pr, blob, scopeDigest }>`
  - `readApprovals` skips `kind: 'plan'` lines (merge readers never see plan records)

- [ ] **Step 1: Failing tests** (append to `test/owner-go.test.mjs`, reusing its `tmp`, `said`, `input` helpers)

```js
import { parsePlanApproval, presentedPlanRequest, readPlanApprovals, readApprovals, recordApproval, approvedRequest, PLAN_RECORD_MAX_AGE_MS } from '../pipeline/hooks/lib/owner-go.mjs';
const BLOB = 'ab'.repeat(20);
const SCOPE = 'cd'.repeat(6);
const PLAN_REQ = `Here is the plan.\nPlan ${BLOB} · scope ${SCOPE}\n📋 Ready to approve plan #58 — say "approve"`;
const MERGE_REQ = `Two items.\nHead ${'e'.repeat(12)} · items none\n🔀 Ready to merge #58 — say "merge"`;
const NOW = Date.parse('2026-10-19T10:00:00Z');

test('parsePlanApproval accepts approve forms and refuses questions and negations', () => {
  assert.deepEqual(parsePlanApproval('approve'), { prs: [], blobs: [] });
  assert.deepEqual(parsePlanApproval('Approved #58.'), { prs: [58], blobs: [] });
  assert.deepEqual(parsePlanApproval(`approve ${BLOB.slice(0, 7)}`), { prs: [], blobs: [BLOB.slice(0, 7)] });
  for (const p of ['approve?', "don't approve", 'approve later', 'why approve', 'merge']) assert.equal(parsePlanApproval(p), null, p);
});

test('presentedPlanRequest binds only the terminal two-line block', () => {
  assert.deepEqual(presentedPlanRequest(PLAN_REQ), { pr: 58, blob: BLOB, scopeDigest: SCOPE });
  assert.equal(presentedPlanRequest(`${PLAN_REQ}\nmore text`), null);
  assert.equal(presentedPlanRequest(PLAN_REQ.replace(BLOB, BLOB.slice(0, 12))), null, 'a 12-hex blob is refused');
  assert.equal(presentedPlanRequest(PLAN_REQ.replace('\n📋', '\nprose\n📋')), null);
  // Spec §2a ambiguity: exactly ONE Plan line and ONE 📋 line in the whole reply, and no 🔀 merge line.
  const other = `Plan ${'ef'.repeat(20)} · scope ${SCOPE}`;
  assert.equal(presentedPlanRequest(PLAN_REQ.replace('Here is the plan.\n', `Here is the plan.\n${other}\n`)), null, 'consecutive duplicate Plan lines');
  assert.equal(presentedPlanRequest(`Old: Plan ${BLOB} · scope ${SCOPE}\n${PLAN_REQ}`), null, 'a second Plan line anywhere');
  assert.equal(presentedPlanRequest(`🔀 Ready to merge #58 — say "merge"\n${PLAN_REQ}`), null, 'mixed merge + plan request');
});

test('the recorder reads a reply that ends with ONLY the plan request (no merge marker), and still refuses a stale one', () => {
  const home = tmp();
  // said() replies have no 🔀 line: lastRequestText must accept the 📋 marker on the plan path.
  assert.equal(recordApproval(input(home, 'approve', [said(PLAN_REQ)]), { home, now: () => NOW })?.kind, 'plan');
  // A later assistant turn with text but no request makes the old request stale (same slot rule as merge).
  const home2 = tmp();
  assert.equal(recordApproval(input(home2, 'approve', [said(PLAN_REQ), said('Working on it.')]), { home: home2, now: () => NOW }), null);
});

test('"approve" after a plan request writes a plan record; merge readers never see it', () => {
  const home = tmp();
  const rec = recordApproval(input(home, 'approve', [said(PLAN_REQ)]), { home, now: () => NOW });
  assert.equal(rec.kind, 'plan');
  assert.match(rec.record_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(rec.plan, { pr: 58, blob: BLOB, scopeDigest: SCOPE });
  assert.equal(readApprovals({ home, now: () => NOW }).length, 0);
  assert.equal(readPlanApprovals({ home, now: () => NOW })[0].blob, BLOB);
});

test('cross-kind: "approve" after a merge request and "merge" after a plan request record nothing of the other kind', () => {
  const home = tmp();
  assert.equal(recordApproval(input(home, 'approve', [said(MERGE_REQ)]), { home, now: () => NOW }), null);
  recordApproval(input(home, 'merge', [said(PLAN_REQ)]), { home, now: () => NOW });
  assert.equal(readPlanApprovals({ home, now: () => NOW }).length, 0);
  assert.equal(approvedRequest({ pr: 58, head: 'e'.repeat(40), items: 'none', home, now: () => NOW }), false);
});

test('approve narrowed by #N or blob prefix; a mismatch records nothing', () => {
  const home = tmp();
  assert.equal(recordApproval(input(home, 'approve #59', [said(PLAN_REQ)]), { home, now: () => NOW }), null);
  assert.equal(recordApproval(input(home, `approve ${'f'.repeat(7)}`, [said(PLAN_REQ)]), { home, now: () => NOW }), null);
  assert.ok(recordApproval(input(home, `approve #58 ${BLOB.slice(0, 8)}`, [said(PLAN_REQ)]), { home, now: () => NOW }));
});

test('the request-line regexes match pipeline/lib/plan.mjs exactly', async () => {
  const plan = await import('../pipeline/lib/plan.mjs');
  const og = await import('../pipeline/hooks/lib/owner-go.mjs');
  assert.equal(og.PLAN_LINE_RE.source, plan.PLAN_LINE_RE.source);
  assert.equal(og.PLAN_READY_RE.source, plan.PLAN_READY_RE.source);
});

test('plan records are read for 30 days, never from the future, and subagent prompts never record', () => {
  const home = tmp();
  recordApproval(input(home, 'approve', [said(PLAN_REQ)]), { home, now: () => NOW });
  assert.equal(readPlanApprovals({ home, now: () => NOW + PLAN_RECORD_MAX_AGE_MS - 1000 }).length, 1);
  assert.equal(readPlanApprovals({ home, now: () => NOW + PLAN_RECORD_MAX_AGE_MS + 1000 }).length, 0);
  assert.equal(readPlanApprovals({ home, now: () => NOW - 10 * 60_000 }).length, 0);
  assert.equal(recordApproval(input(home, 'approve', [said(PLAN_REQ)], { agent_id: 'x' }), { home, now: () => NOW }), null);
});
// The 24 h issuance window and the UTC / future-skew boundaries are checked by `P plan approve` (T4 tests):
// a record exactly 24 h old is accepted, 24 h + 1 s refused; a record dated in the future beyond the existing skew
// allowance (owner-go.mjs ~245) is refused; timestamps are compared as UTC epoch ms.
```

- [ ] **Step 2: Run** `node scripts/test.mjs owner-go` → FAIL.

- [ ] **Step 3: Implement** in `pipeline/hooks/lib/owner-go.mjs`:

```js
import { randomBytes } from 'node:crypto';
// Same text as pipeline/lib/plan.mjs (a parity test keeps them equal; this file must not import lib/).
export const PLAN_LINE_RE = /^\s*Plan\s+([0-9a-f]{40})\s*(?:·|\|)\s*scope\s+([0-9a-f]{12})\s*$/;
export const PLAN_READY_RE = /📋\s*Ready to approve plan\s+#(\d{1,6})\b/;
export const PLAN_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// "approve", "approved", "approve #58", "approve <blob prefix ≥7>", with the merge fillers. Anything else is not an approval.
export function parsePlanApproval(prompt) {
  const t = String(prompt ?? '').trim();
  const m = /^approved?(?![A-Za-z0-9_-])([\s\S]*)$/i.exec(t);
  if (!m || m[1].includes('?')) return null;
  const prs = [];
  const blobs = [];
  for (const tok of m[1].replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    let x;
    if ((x = /^#?(\d{1,6})$/.exec(tok))) prs.push(Number(x[1]));
    else if (/^[0-9a-f]{7,40}$/i.test(tok)) blobs.push(tok.toLowerCase());
    else if (!FILLER.test(tok)) return null;
  }
  return { prs: [...new Set(prs)], blobs: [...new Set(blobs)] };
}

// The plan request a reply ENDS with: the last non-blank line is the 📋 line and the line right above it the Plan line.
// Ambiguous replies record nothing (spec §2a): any other Plan / 📋 line anywhere in the reply, or any 🔀 merge line.
export function presentedPlanRequest(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const ready = PLAN_READY_RE.exec(lines.at(-1) ?? '');
  const plan = PLAN_LINE_RE.exec(lines.at(-2) ?? '');
  if (!ready || !plan) return null;
  const count = (re) => lines.filter((l) => re.test(l)).length;
  if (count(PLAN_LINE_RE) !== 1 || count(PLAN_READY_RE) !== 1 || count(READY_LINE) !== 0) return null;
  return { pr: Number(ready[1]), blob: plan[1], scopeDigest: plan[2] };
}
```
  `lastRequestText` today returns a reply only when it matches the MERGE marker (`READY_LINE`, ~139), so a reply ending
  in the plan request reads as `''` (Codex plan R1-3). Give it an option `lastRequestText(transcriptPath, { prompt,
  ready = READY_LINE })` and use `ready` in the final test; the merge path passes nothing (unchanged behaviour), the plan
  path passes `ready: PLAN_READY_RE`. The slot/staleness logic above that line is shared and NOT changed. Check that
  `READY_LINE` is a non-global regex (`.test` on a `/g` regex is stateful); if it is global, use a non-global copy.
  `recordApproval`: after the `notOwnerPrompt` / session checks, `const a = parseApproval(input?.prompt)`; when `a` is
  null, try the plan path:
```js
const pa = parsePlanApproval(input?.prompt);
if (!pa) return null;
const shown = presentedPlanRequest(lastRequestText(String(input?.transcript_path ?? ''), { prompt: String(input.prompt), ready: PLAN_READY_RE }));
if (!shown) return null;
if (pa.prs.length && !pa.prs.includes(shown.pr)) return null;
if (pa.blobs.length && !pa.blobs.some((b) => shown.blob.startsWith(b))) return null;
record = { v: 1, kind: 'plan', ts, session, prompt_sha256, record_id: randomBytes(8).toString('hex'), cwd, prs: [], requests: [], plan: shown };
```
  The merge path adds `kind: 'merge'` to its record. Factor the existing append-write block into `appendRecord(home,
  session, record)` so both paths share it unchanged. `readApprovals`: `if (r?.kind === 'plan') continue;` right after
  the `v`/session check. `readPlanApprovals` reuses the same file-reading loop (factor it into `readRecordLines({ home,
  session, now, maxAgeMs })`, which yields the parsed lines that pass the `v`, session-name, future-skew and age
  checks) and maps `kind === 'plan'` lines whose `plan.pr` is an integer, `plan.blob` 40-hex, `plan.scopeDigest` 12-hex,
  and `record_id` 16-hex to `{ ts, session, recordId, promptSha256: r.prompt_sha256, ...r.plan }`. Extend the header
  comment: plan records, the 24 h issuance window (checked by `P plan approve`) vs the 30-day validity.
  `pipeline/hooks/owner-go.mjs`: when `record.kind === 'plan'`, print
  `[claude-pipeline owner-go] the owner's "approve" is recorded: plan #${pr} blob ${blob.slice(0, 12)} scope ${scopeDigest}.`

- [ ] **Step 4: Run** `node scripts/test.mjs owner-go merge-owner-approval owner-approval-chat guard-owner-go` → PASS.
- [ ] **Step 5: Commit** `feat(owner-go): record the owner's "approve" for a plan, bound to blob + scope`.

---

### Task T4: Plan evidence logic + `P plan record | approve | risk`

**Files:**
- Create: `pipeline/lib/plan-state.mjs`
- Create: `pipeline/commands/plan.mjs` (subcommands `record`, `approve`, `risk`; T5 adds `start`, `review`, `findings`)
- Modify: `pipeline/lib/risk.mjs` (export `scopeMayHitGlob`, `securityGlobs`)
- Modify: `pipeline/lib/config.mjs` (the T6 keys, moved here)
- Test: `test/plan-state.test.mjs`, `test/plan-command.test.mjs`, `test/risk.test.mjs` (extend), `test/config.test.mjs` (extend)

**Interfaces:**
- Consumes: T1 (`parsePlan`, `scopeDigest`, `planRequestLines`, `PlanError`), T2 (`listEvents` with `tampered`,
  `postEvent`, `readEvents`, record `plan` patch), T3 (`readPlanApprovals`, `MAX_AGE_MS`), `createRunRecorder`
  (`run-progress.mjs`), `readSummaryComment`.
- Produces (`plan-state.mjs`, pure):
  - `bindOf({ repo, pr, branch })`
  - `activeProposal(events, bind) → { status: 'none' } | { status: 'lost', reason } | { status: 'ok', event, blob, path, scopeDigest, n }`
  - `latestApproval(events, bind) → { status: 'none' } | { status: 'lost', reason } | { status: 'approved', event, blob, path, recordId, promptSha256, host }`
  - `matchingLocalRecord(records, { pr, blob, scopeDigest, recordId, promptSha256 }) → record | null`
  - `trustedPlanPath({ path, blob, planDir, blobAtPath }) → string | null`
  - `planScopeVerdict({ events, bind, recordPlan, localRecords, readBlob, blobAtPath, planDir, files, required, ownerApproval, host }) → { ok, detail, ownerMerge, ownerItems }` (used by T6)
  - `startsValidity(events, { caps = { codex: 2, fable: 1 } }) → Array<{ reviewer, key, commentId, createdAt, valid, extra, planBlob, claim }>` (used by T5)
  - `planResumeFacts({ events, bind, recordPlan, localRecords, recordTasks, readBlob }) → { evidence: boolean, active, approval: 'verified'|'unverified'|'none'|'lost', openWork: boolean, needsApproveCheckpoint: boolean, lostReason? }` (used by T9)
- Produces (`P plan`):
  - `pipeline plan record --pr N --file PATH [--request-file F] [--repo DIR]` → `{ ok, blob, scopeDigest, path, tasks: [{id, title, specSha}], requestLines, event: { id, reused } }`; exit 1 `dirty|unpushed|plan-invalid`, 3 GitHub
  - `pipeline plan approve --pr N [--repo DIR]` → `{ ok, blob, scopeDigest, event: { id, reused }, stepChanged }`; exit 1 `no-proposal|no-approval|superseded|scope-mismatch|lost`
  - `pipeline plan risk --pr N [--repo DIR]` → `{ ok, level, reasons }`

- [ ] **Step 1: Failing tests** `test/plan-state.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeProposal, latestApproval, planScopeVerdict, startsValidity } from '../pipeline/lib/plan-state.mjs';
import { scopeDigest } from '../pipeline/lib/plan.mjs';
const BIND = { repo: 'a/b', pr: 7, branch: 'agent/x' };
const A = 'a'.repeat(40), B = 'b'.repeat(40);
let id = 0;
const ev = (kind, data, extra = {}) => ({ kind, id: `e${++id}`, commentId: id, createdAt: `2026-10-19T00:00:${String(id).padStart(2, '0')}Z`, tampered: false, dataStatus: 'ok', data: { ...BIND, ...data }, ...extra });
const PLAN = (scope) => `## In plain English\nx\n\n## Scope\n${scope.map((s) => `- \`${s}\``).join('\n')}\n\n### Task T1: t\nbody\n`;

test('active proposal = latest; restoring an earlier blob makes it active again', () => {
  const evs = [ev('plan-proposed', { blob: A, n: 1 }), ev('plan-proposed', { blob: B, n: 2 }), ev('plan-proposed', { blob: A, n: 3 })];
  assert.equal(activeProposal(evs, BIND).blob, A);
  assert.equal(activeProposal([...evs.slice(0, 2)], BIND).blob, B);
  assert.equal(activeProposal([ev('plan-proposed', { blob: A }, { tampered: true })], BIND).status, 'lost');
  assert.equal(activeProposal([ev('plan-proposed', { blob: A, pr: 8 })], BIND).status, 'lost');
});

test('a tampered or unreadable event newer than the latest approval blocks fallback', () => {
  const ok = ev('plan-approved', { blob: A, recordId: '1'.repeat(16), promptSha256: 'p' });
  assert.equal(latestApproval([ok], BIND).status, 'approved');
  assert.equal(latestApproval([ok, ev('plan-proposed', { blob: B }, { tampered: true })], BIND).status, 'lost');
  assert.equal(latestApproval([ok, ev('plan-approved', {}, { dataStatus: 'invalid' })], BIND).status, 'lost');
});

const verdict = (over) => planScopeVerdict({
  events: [], bind: BIND, recordPlan: null, localRecords: [], readBlob: () => null, planDir: 'docs/plans',
  blobAtPath: (p, b) => p === 'docs/plans/p.md' && b === A,
  files: [{ oldPath: 'src/a.mjs', newPath: 'src/a.mjs', path: 'src/a.mjs' }], required: true, ownerApproval: 'chat', host: 'mac', ...over,
});

test('none: one owner-merge item; required:false reports only; label mode fails', () => {
  assert.deepEqual([verdict({}).ok, verdict({}).ownerItems], [true, ['plan-scope none']]);
  assert.deepEqual([verdict({ required: false }).ok, verdict({ required: false }).ownerMerge], [true, 0]);
  assert.equal(verdict({ ownerApproval: 'label' }).ok, false);
});

test('lost: proposal without approval, record plan without events, local record without events, missing blob', () => {
  assert.equal(verdict({ events: [ev('plan-proposed', { blob: A })] }).ok, false);
  assert.equal(verdict({ recordPlan: { blob: A } }).ok, false);
  assert.equal(verdict({ localRecords: [{ pr: 7, blob: A }] }).ok, false);
  const ap = ev('plan-approved', { blob: A, path: 'docs/plans/p.md', recordId: '1'.repeat(16), promptSha256: 'p', host: 'mac' });
  assert.match(verdict({ events: [ap] }).detail, /lost/);
});

test('approved: verified vs unverified, outside files listed, plan file allowed', () => {
  const ap = ev('plan-approved', { blob: A, path: 'docs/plans/p.md', recordId: '1'.repeat(16), promptSha256: 'p', host: 'pc' });
  const readBlob = (b) => (b === A ? PLAN(['src/**']) : null);
  const files = [{ path: 'src/a.mjs', oldPath: 'src/a.mjs', newPath: 'src/a.mjs' }, { path: 'x.mjs', oldPath: 'x.mjs', newPath: 'x.mjs' }, { path: 'docs/plans/p.md', oldPath: 'docs/plans/p.md', newPath: 'docs/plans/p.md' }];
  const unverified = verdict({ events: [ap], readBlob, files });
  assert.deepEqual(unverified.ownerItems.sort(), ['plan-scope outside x.mjs', 'plan-scope unverified pc']);
  const local = [{ pr: 7, blob: A, scopeDigest: scopeDigest(['src/**']), recordId: '1'.repeat(16), promptSha256: 'p' }];
  assert.deepEqual(verdict({ events: [ap], readBlob, files, localRecords: local }).ownerItems, ['plan-scope outside x.mjs']);
});

test('a copied approval pointer with a substituted path exempts nothing (Codex plan R1-1)', () => {
  const readBlob = (b) => (b === A ? PLAN(['src/**']) : null);
  const local = [{ pr: 7, blob: A, scopeDigest: scopeDigest(['src/**']), recordId: '1'.repeat(16), promptSha256: 'p' }];
  const forged = ev('plan-approved', { blob: A, path: 'x.mjs', recordId: '1'.repeat(16), promptSha256: 'p', host: 'mac' });
  const files = [{ path: 'x.mjs', oldPath: 'x.mjs', newPath: 'x.mjs' }];
  assert.deepEqual(verdict({ events: [forged], readBlob, files, localRecords: local }).ownerItems, ['plan-scope outside x.mjs']);
  // a path under plan.dir whose committed content is NOT the approved blob is not exempt either
  const other = ev('plan-approved', { blob: A, path: 'docs/plans/q.md', recordId: '1'.repeat(16), promptSha256: 'p', host: 'mac' });
  const q = [{ path: 'docs/plans/q.md', oldPath: 'docs/plans/q.md', newPath: 'docs/plans/q.md' }];
  assert.deepEqual(verdict({ events: [other], readBlob, files: q, localRecords: local }).ownerItems, ['plan-scope outside docs/plans/q.md']);
});

test('startsValidity: duplicate keys collapse, caps per PR, extras count only from their position on', () => {
  const s = (reviewer, key, extra) => ev('plan-review-started', { reviewer, key, planBlob: A, ...(extra ? { extra } : {}) });
  const evs = [s('codex', 'k1'), s('codex', 'k1'), s('codex', 'k2'), s('codex', 'k3'), s('codex', 'k4', 'owner: one more'), s('fable', 'f1'), s('fable', 'f2')];
  assert.deepEqual(startsValidity(evs).map((x) => [x.key, x.valid]), [['k1', true], ['k2', true], ['k3', false], ['k4', true], ['f1', true], ['f2', false]]);
  // a later extra never revives k3; a second extra is needed for a fifth run
  const more = [...evs, s('codex', 'k5'), s('codex', 'k6', 'owner: again')];
  assert.deepEqual(startsValidity(more).filter((x) => x.reviewer === 'codex').map((x) => x.valid), [true, true, false, true, false, true]);
  // an edited start counts against every reviewer
  assert.equal(startsValidity([s('codex', 'k1'), ev('plan-review-started', { reviewer: 'codex', key: 'k2', planBlob: A }, { tampered: true }), s('codex', 'k3')]).at(-1).valid, false);
});
```

- [ ] **Step 2: Run** `node scripts/test.mjs plan-state` → FAIL.

- [ ] **Step 3: Implement `pipeline/lib/plan-state.mjs`**

```js
// Plan evidence on a PR (spec 2026-10-19 §§2–4, trust model): PR event comments are POINTERS only (anything on GitHub is
// writable with the agent's token). Approval is verified only against a local owner-go plan record; scope and tasks are
// always re-parsed from the approved git blob. Pure: callers pass events (listEvents), local records and a blob reader.
import { parsePlan, outsideScope, scopeDigest } from './plan.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const KEY_RE = /^[A-Za-z0-9._-]{1,48}$/;
const usable = (e) => e && !e.tampered && e.dataStatus === 'ok';
export const bindOf = ({ repo, pr, branch }) => ({ repo, pr, branch });
const binds = (e, b) => e.data?.repo === b.repo && e.data?.pr === b.pr && e.data?.branch === b.branch;
const hostWord = (h) => String(h ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';

export function activeProposal(events, bind) {
  const props = (events ?? []).filter((e) => e.kind === 'plan-proposed');
  const last = props.at(-1);
  if (!last) return { status: 'none' };
  if (!usable(last)) return { status: 'lost', reason: `the latest plan proposal (comment ${last.commentId}) is ${last.tampered ? 'edited' : 'unreadable'}` };
  if (!binds(last, bind) || !HEX40.test(String(last.data.blob))) return { status: 'lost', reason: `the latest plan proposal (comment ${last.commentId}) does not belong to this PR` };
  return { status: 'ok', event: last, blob: last.data.blob, path: String(last.data.path ?? ''), scopeDigest: last.data.scopeDigest, n: props.length };
}

export function latestApproval(events, bind) {
  const plan = (events ?? []).filter((e) => e.kind === 'plan-proposed' || e.kind === 'plan-approved');
  const i = plan.findLastIndex((e) => e.kind === 'plan-approved');
  if (i < 0) return { status: 'none' };
  const ap = plan[i];
  const bad = plan.slice(i).find((e) => !usable(e));
  if (bad) return { status: 'lost', reason: `plan evidence comment ${bad.commentId} is ${bad.tampered ? 'edited' : 'unreadable'}` };
  if (!binds(ap, bind) || !HEX40.test(String(ap.data.blob))) return { status: 'lost', reason: `the latest approval (comment ${ap.commentId}) does not belong to this PR` };
  return { status: 'approved', event: ap, blob: ap.data.blob, path: String(ap.data.path ?? ''), recordId: ap.data.recordId, promptSha256: ap.data.promptSha256, host: hostWord(ap.data.host) };
}

export const matchingLocalRecord = (records, w) => (records ?? []).find((r) => r.pr === w.pr && r.blob === w.blob && r.scopeDigest === w.scopeDigest
  && (w.recordId === undefined || r.recordId === w.recordId) && (w.promptSha256 === undefined || r.promptSha256 === w.promptSha256)) ?? null;

function parsedBlob(readBlob, blob) {
  const text = readBlob(blob);
  if (text == null) return { error: `the approved plan blob ${blob.slice(0, 12)} is not in this clone` };
  try { return { plan: parsePlan(text) }; } catch (err) { return { error: `the approved plan no longer parses (${err.message})` }; }
}

// blobAtPath(path, blob) → true only when some commit in merge-base..head has `<commit>:<path>` equal to blob (the
// caller runs `git log --format=%H <mergeBase>..<head> -- <path>` + `git rev-parse <c>:<path>`; any git error → false).
export function trustedPlanPath({ path: p, blob, planDir, blobAtPath }) {
  const dir = String(planDir ?? '').replace(/\/+$/, '');
  if (typeof p !== 'string' || !dir || !p.startsWith(`${dir}/`) || !p.endsWith('.md') || p.split('/').includes('..')) return null;
  return blobAtPath(p, blob) === true ? p : null;
}

export function planScopeVerdict({ events, bind, recordPlan, localRecords, readBlob, blobAtPath, planDir, files, required, ownerApproval, host }) {
  const lost = (reason) => ({ status: 'lost', reason });
  let v;
  const ap = latestApproval(events, bind);
  const trace = (events ?? []).some((e) => e.kind === 'plan-proposed') || recordPlan != null || (localRecords ?? []).some((r) => r.pr === bind.pr);
  if (ap.status === 'lost') v = lost(ap.reason);
  else if (ap.status === 'none') v = trace ? lost('a plan was proposed or approved here, but no approval comment is on the PR') : { status: 'none', items: ['plan-scope none'] };
  else {
    const p = parsedBlob(readBlob, ap.blob);
    if (p.error) v = lost(p.error);
    else {
      const digest = scopeDigest(p.plan.scope);
      const verified = matchingLocalRecord(localRecords, { pr: bind.pr, blob: ap.blob, scopeDigest: digest, recordId: ap.recordId, promptSha256: ap.promptSha256 });
      // The event's `path` is a pointer an agent can forge (Codex plan R1-1): exempt it only when it is a Markdown file
      // under plan.dir AND git proves the APPROVED blob was committed at that path on this branch.
      const planPath = trustedPlanPath({ path: ap.path, blob: ap.blob, planDir, blobAtPath });
      const items = outsideScope({ files, scope: p.plan.scope, planPath }).map((f) => `plan-scope outside ${f}`);
      if (!verified) items.push(`plan-scope unverified ${ap.host}`);
      v = { status: 'approved', items, verified: Boolean(verified) };
    }
  }
  if (!required) return { ok: true, detail: `report only (plan.required: false): ${v.status}${v.items?.length ? `, ${v.items.length} item(s)` : ''}`, ownerMerge: 0, ownerItems: [] };
  if (v.status === 'lost') return { ok: false, detail: `lost: ${v.reason}. Recovery: re-show the active plan request; the owner's new "approve" clears it`, ownerMerge: 0, ownerItems: [] };
  if (v.items.length === 0) return { ok: true, detail: 'every changed file is in the approved plan scope', ownerMerge: 0, ownerItems: [] };
  const shown = v.items.slice(0, 5).join('; ') + (v.items.length > 5 ? '; ...' : '');
  if (ownerApproval !== 'chat') return { ok: false, detail: `${v.items.length} plan-scope item(s): ${shown}`, ownerMerge: 0, ownerItems: [] };
  return { ok: true, detail: `${v.items.length} owner-merge plan-scope item(s): ${shown}`, ownerMerge: v.items.length, ownerItems: v.items };
}

export function startsValidity(events, { caps = { codex: 2, fable: 1 } } = {}) {
  const used = { codex: 0, fable: 0 };
  const extras = { codex: 0, fable: 0 };
  const seen = new Set();
  const out = [];
  for (const e of (events ?? []).filter((x) => x.kind === 'plan-review-started')) {
    if (!usable(e) || !Object.hasOwn(caps, e.data?.reviewer) || !KEY_RE.test(String(e.data?.key))) {
      // An edited or unreadable start still spent a slot as far as anyone can tell: count it against every reviewer.
      for (const r of Object.keys(used)) used[r] += 1;
      continue;
    }
    const r = e.data.reviewer;
    const k = `${r}:${e.data.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const extra = typeof e.data.extra === 'string' && e.data.extra.trim() ? e.data.extra.trim() : null;
    if (extra) extras[r] += 1;
    const valid = used[r] < caps[r] + extras[r];
    // A void start launched nothing, so it takes no slot: one owner extra after it buys exactly one more run
    // (clarifies spec §3 "position": the position among slot-taking starts). It is never revived later.
    if (valid) used[r] += 1;
    out.push({ reviewer: r, key: e.data.key, commentId: e.commentId, createdAt: e.createdAt, valid, extra, planBlob: e.data.planBlob ?? null, claim: typeof e.data.claim === 'string' ? e.data.claim : null });
  }
  return out;
}

// Open work is judged against the APPROVED blob's tasks, never against the record alone (Codex plan R1-5): when the
// plan-approved event was posted but the checkpoint that copies tasks failed, the record has no tasks (or stale ones),
// and every approved task that is not done in the record with the same specSha is open.
export function planResumeFacts({ events, bind, recordPlan, localRecords, recordTasks, readBlob }) {
  const active = activeProposal(events, bind);
  const ap = latestApproval(events, bind);
  const evidence = active.status !== 'none' || ap.status !== 'none' || recordPlan != null || (localRecords ?? []).some((r) => r.pr === bind.pr);
  if (active.status === 'lost') return { evidence, active: null, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: active.reason };
  if (ap.status === 'lost') return { evidence, active, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: ap.reason };
  const approvedActive = ap.status === 'approved' && active.status === 'ok' && ap.blob === active.blob;
  if (!approvedActive) return { evidence, active: active.status === 'ok' ? active : null, approval: 'none', openWork: true, needsApproveCheckpoint: false };
  const p = parsedBlob(readBlob, ap.blob);
  if (p.error) return { evidence, active, approval: 'lost', openWork: true, needsApproveCheckpoint: false, lostReason: p.error };
  const verified = matchingLocalRecord(localRecords, { pr: bind.pr, blob: ap.blob, scopeDigest: scopeDigest(p.plan.scope), recordId: ap.recordId, promptSha256: ap.promptSha256 });
  const done = new Set((recordTasks ?? []).filter((t) => t.done === true && typeof t.specSha === 'string').map((t) => `${t.id}\n${t.specSha}`));
  const openWork = p.plan.tasks.some((t) => !done.has(`${t.id}\n${t.specSha}`));
  // The approval event exists but the record never got it (checkpoint failed): resume re-runs `P plan approve`, which
  // reuses the event and copies the approved tasks into the record before any build step.
  const needsApproveCheckpoint = recordPlan?.blob !== ap.blob || recordPlan?.state !== 'approved'
    || p.plan.tasks.some((t) => !(recordTasks ?? []).some((r) => r.id === t.id && r.specSha === t.specSha));
  return { evidence, active, approval: verified ? 'verified' : 'unverified', openWork, needsApproveCheckpoint };
}
```
  Tests (append to `test/plan-state.test.mjs`): an approved active plan with `recordTasks: []` and `recordPlan: null`
  → `openWork: true, needsApproveCheckpoint: true`; the same with every task done at the matching `specSha` and
  `recordPlan.state: 'approved'` → `openWork: false, needsApproveCheckpoint: false`; a record task done at an OLD
  `specSha` → open; a blob that is not in the clone → `approval: 'lost'`.

- [ ] **Step 4: `pipeline/commands/plan.mjs`** — dispatcher like `commands/triage.mjs` (`SUBCOMMANDS` map + `guarded`), with
  `meta.usage` lines starting `pipeline plan <sub>` for every subcommand (the skills-commands test reads them). Shared
  helper `prContext(values, ctx)` → `{ root, config, pr, gh, viewer, comments, events, bind, summary }` where `gh =
  createGitHub({ cwd: root, env: ctx.env })`, `view = gh.prView(pr, ['headRefOid', 'headRefName', 'baseRefName'])`,
  `bind = { repo: gh.repo().slug, pr, branch: view.headRefName }`, `comments = gh.listComments(pr)`, `events =
  listEvents(comments, gh.viewer())`, `summary = summaryFromComments(comments, viewer)`. `summaryFromComments` ALREADY
  decodes (`summary-comment.mjs:22` returns `{ status, record?, sections, url, id }`, no `body`): use `summary.status`
  / `summary.record` directly, never `decodeRecord` again (Codex plan R1-4). A record whose `repo`/`pr`/`branch` differ
  from `bind` is treated as unreadable (`status: 'invalid'`). `approve` refuses (exit 1 `record-unreadable`) when
  `summary.status` is `unsupported` or `invalid`, so it can never reset a gate-stage record it could not read; only
  `absent` counts as "no record".
  Wrap GitHub calls in `guardGh` (exit 3). `readBlob = (b) => { try { return git(['cat-file', 'blob', b], { cwd: root }); } catch { return null; } }` (use the `git` runner from `pipeline/lib/git.mjs`).
  - `record`:
    1. `rel` = repo-relative `--file` (must be inside the repo, ≤ `MAX_PLAN_BYTES`).
    2. `blob = git rev-parse HEAD:<rel>`; `git hash-object <file>` must equal it (else exit 1 `dirty`).
    3. `HEAD === view.headRefOid` (else exit 1 `unpushed`).
    4. `parsePlan` (`PlanError` → exit 1 `plan-invalid` with `problems`).
    5. `active = activeProposal(events, bind)`. When `active.status === 'ok' && active.blob === blob`, reuse it.
       Otherwise `postEvent(gh, pr, 'plan-proposed', `${blob.slice(0, 12)}-${n}`, `Plan proposed: ${rel}`, { ...bind,
       path: rel, blob, scopeDigest, n, at, host })` with `n = 1 + count of plan-proposed events`.
    6. `createRunRecorder({ gh, pr }).update({ step: 'plan', outcome: null, plan: { path: rel, blob, scopeDigest,
       state: 'proposed' }, ...(request ? { request } : {}) }, { initialStep: 'plan' })`.
    7. Output as in Interfaces, plus the recorder's `warnings`.
  - `approve`:
    1. `active` must be `ok` (`none` → exit 1 `no-proposal`, `lost` → exit 1 `lost`).
    2. `parsePlan(readBlob(active.blob))` (missing → `lost`).
    3. `digest = scopeDigest(...)`; it must equal `active.scopeDigest` (else `lost`).
    4. `recs = readPlanApprovals({ home: ctx.home ?? accountHome(), maxAgeMs: MAX_AGE_MS }).filter((r) => r.pr === pr)`,
       newest first (`ctx.home` exists for tests only; the CLI never reads `$HOME` for this, `owner-go.mjs`
       `accountHome`).
    5. Checks: none → `no-approval`; newest `.blob !== active.blob` → `superseded`; `.scopeDigest !== digest` →
       `scope-mismatch`.
    6. Reuse an existing `plan-approved` event with the same `blob` + `recordId`. Else post `plan-approved` with id
       `${blob.slice(0, 12)}-${recordId.slice(0, 8)}` and data `{ ...bind, path, blob, scopeDigest: digest, recordId,
       promptSha256, recordedAt: rec.ts, at, host }`.
    7. Record:
       - If `summary.record?.step === 'plan'` or there is no record: `update({ step: 'build', plan: { ..., state:
         'approved' }, tasks: parsed.tasks.map(({ id, title, spec, specSha }) => ({ id, title, spec, specSha })) })`,
         `stepChanged: true`.
       - Else `update({ plan: { ..., state: 'approved' } })`, `stepChanged: false` (spec B1).
  - `risk`:
    1. `active` → `parsePlan(readBlob(active.blob))`.
    2. `riskGlobs = [...config.risk.high_risk_paths, ...config.hard_stops.paths, ...securityGlobs(config)]`, where
       `securityGlobs` = `['**/*.sql', '**/migrations/**', 'supabase/**', ...(config.review.security === 'off' ? [] :
       config.review.security.paths)]`. Its definition is shared with T7; put it in `risk.mjs`.
    3. `high` when any scope entry `scopeMayHitGlob` any risk glob, or a task text matches
       `/\b(migration|rls|row[- ]level|grant|revoke|policy|auth|secret|token|password|payroll|money|concurrency|lock)\b/i`.
    4. Else `medium` when tasks > 3 or scope > `config.risk.medium_files`; else `low`. `reasons` name each trigger.
  - `scopeMayHitGlob(entry, glob)` (in `risk.mjs`, exported; Codex plan R1-9: a bare static-prefix test made the empty
    prefix of `**/*.sql` match everything, so every plan was high):
    - a LITERAL entry (no `*?[{`) → exact `matchAny(entry, [glob], { nocase: true })` (`glob.mjs` semantics);
    - two globs → overlap only when BOTH hold: (a) static prefixes compatible (one equals or starts with the other +
      `/`; the empty prefix is compatible with any), and (b) tails compatible: `tail(g)` = the literal text after the
      last wildcard in the last segment (`**/*.sql` → `.sql`, `src/**` → `''`); compatible when either tail is `''` or
      one ends with the other (case-insensitive). Conservative: may over-flag, never misses a real overlap.
    - Tests (`test/risk.test.mjs`): `docs/a.md` vs default globs → no; `supabase/migrations/x.sql` → yes; `src/**` vs
      `**/*.sql` → yes; `docs/**/*.md` vs `**/*.sql` → no; `**` vs anything → yes; `db/*.SQL` vs `**/*.sql` → yes.
  - Config keys move here from T6 (Codex plan R1-12: `risk` reads `config.review.security`, so its default must exist
    at this commit): add `DEFAULTS.plan`, `DEFAULTS.review.final_pass`, `DEFAULTS.review.security`, their `KEYS` and
    validation exactly as written in T6 Step 3 `config.mjs`, with T6's `test/config.test.mjs` cases. T6 then only adds
    the gate check.
  - Tests `test/plan-command.test.mjs`: use `createTmpRepo()` (`test/helpers/tmprepo.mjs`) + `createFakeGh(entries)`
    (`test/helpers/fakegh-env.mjs`, entry format as in `test/cli-review.test.mjs`) and spawn `pipeline/bin/pipeline.mjs`.
    Cases:
    - `record` refuses a dirty plan (exit 1 `dirty`) and an unpushed HEAD (fake `prView` headRefOid ≠ HEAD → `unpushed`);
    - `record` posts one `plan-proposed`, and a retry with the same blob posts nothing (`event.reused: true`);
    - A→B→A posts a third occurrence `n: 3`;
    - `approve` with no local record → `no-approval`;
    - with a record for an older blob → `superseded`;
    - with a matching record → posts `plan-approved` and sets `step: build` + tasks. Write the record with
      `recordApproval` into a temp `home`, then import `run` from `pipeline/commands/plan.mjs` and pass `ctx.home` (no
      env override exists: `accountHome()` ignores `$HOME` on purpose);
    - `approve` again at `step: gate` → event reused/posted, `stepChanged: false`, step stays `gate`; the same at
      `step: awaiting-owner-merge` (the summary comment is the fake gh's real comment shape, decoded once);
    - `approve` with an `unsupported` (v: 3) summary record → exit 1 `record-unreadable`, nothing posted;
    - `approve` 24 h boundary: a local record exactly 24 h old → ok; 24 h + 1 s → `no-approval`; a record 10 min in the
      future beyond the skew allowance → `no-approval`;
    - `risk`: a scope `supabase/migrations/x.sql` → `high`; `docs/a.md` with one task in a repo whose
      `hard_stops.paths` is the default → `low`.
- [ ] **Step 5: Run** `node scripts/test.mjs plan-state plan-command plan.test risk config self-verify` → PASS.
- [ ] **Step 6: Commit** `feat(plan): plan evidence logic and P plan record/approve/risk`.

---

### Task T5: Reviewer budget + plan reviews (`P plan start | review | findings`)

**Files:**
- Create: `pipeline/lib/codex-run.mjs` (moved `askCodex` from `commands/codex-review.mjs` 211-242, behaviour unchanged)
- Modify: `pipeline/commands/codex-review.mjs` (import `askCodex` from `codex-run.mjs`)
- Modify: `pipeline/lib/codex.mjs` (add `buildPlanReviewPrompt`, `buildCodexResumeArgs`; `buildCodexArgs` gains an optional `json` flag)
- Modify: `pipeline/commands/plan.mjs` (add `start`, `review`, `findings`)
- Test: `test/plan-budget.test.mjs`, `test/codex.test.mjs` (extend)

**Interfaces:**
- Consumes: `startsValidity`, `activeProposal` (T4); `findSubagentTranscript`, `proveModel`, `extractJsonBlock`
  (`lib/transcript.mjs`); `buildCodexArgs`, `validateFindings`, `assignIds`, `renderFindingsMarkdown`,
  `FINDINGS_SCHEMA_PATH` (`lib/codex.mjs`); `sha256` (`lib/review-context.mjs`).
- Produces:
  - `askCodex({ root, args, prompt, outPath, env, timeoutMs, json = false }) → { ok: true, findings, session, usage } | { ok: false, reason, session }` (exit-3 reasons as today; `json: false` = today's behaviour, `session`/`usage` null)
  - `buildCodexResumeArgs({ sessionId, model, effort, schemaPath, outPath }) → string[]` (in `codex.mjs`; `sessionId` must match `/^[A-Za-z0-9_-]{8,}$/`)
  - `pipeline plan start` exit 1 `{ error: 'already-started' }` (key already exists, or another caller's claim won)
  - `buildPlanReviewPrompt({ pr, planPath, blob, kind: 'review'|'recheck', priorFindingsMarkdown = '' }) → string`
  - `pipeline plan start --pr N --reviewer codex|fable --key KEY [--extra TEXT] [--repo DIR]` → exit 0 `{ go: true, key, reviewer, planBlob, promptHeader? }` (fable: `ROUND: plan\nINPUT-DIGEST: <64 hex>`), exit 1 `{ error: 'cap' }`, exit 3 `{ error: 'not-visible' }`
  - `pipeline plan review --pr N --key KEY [--effort high|xhigh] [--model M] [--prior FILE] [--repo DIR]` → `{ ok, key, counts, path }`
  - `pipeline plan findings --pr N --key KEY --tag TAG [--projects-dir DIR] [--max-age-ms N] [--repo DIR]` → `{ ok, key, counts, path, errors }`
  - files `.review/plan/<key>.json` (`{ findings, items, blob, reviewer, key }`) and `.review/plan/<key>.md`

- [ ] **Step 1: Failing tests** `test/plan-budget.test.mjs` (import `run` from `pipeline/commands/plan.mjs`, fake gh via
  `createFakeGh`). Cases:
  1. Two `start --reviewer codex` with different keys → both `go`; a third → exit 1 `cap`; `--extra "owner: one more"`
     → `go`.
  2. A retry with an existing key posts no comment (the fake gh records POSTs) and exits 1 `already-started` — it
     never returns `go` twice for one key.
  2b. Two racing callers with the same key (fake gh lists BOTH comments after both POSTs): exactly one gets `go` (the
     one whose `claim` is on the earliest comment), the other `already-started`; count `go` results = 1.
  3. A fake gh whose `listComments` omits the comment just created → exit 3 `not-visible`, never `go`.
  4. A POST that fails with a 502 but whose comment appears on the re-list → decided normally (ambiguous POST).
  5. `start --reviewer fable` prints `promptHeader` with `ROUND: plan` and a 64-hex digest that changes with the key.
  6. `findings` refuses:
     - a key with no valid start;
     - a transcript whose first line `timestamp` is older than the start's `createdAt`;
     - a transcript whose first user message lacks the header;
     - an existing `.review/plan/<key>.json`.
     It accepts a proven Fable transcript fixture (copy the shape from the arbiter tests' transcript fixtures: grep
     `test/` for `arbiter apply`) and writes the file.
  `test/codex.test.mjs`: `buildPlanReviewPrompt` refuses a non-40-hex blob and a `..` plan path, names the blob, and
  for `recheck` includes the prior findings text.

- [ ] **Step 2: Run** `node scripts/test.mjs plan-budget codex.test` → FAIL.

- [ ] **Step 3: Implement**
  - `codex-run.mjs`: move `askCodex` verbatim (with its timeout constant and `classifyCodexFailure` use); export it;
    `codex-review.mjs` imports it. Run `node scripts/test.mjs cli-review codex` to prove no behaviour change.
  - `buildPlanReviewPrompt` (in `codex.mjs`, next to `buildReviewPrompt`):
```js
export function buildPlanReviewPrompt({ pr, planPath, blob, kind, priorFindingsMarkdown = '' }) {
  if (!Number.isInteger(pr) || pr <= 0) throw new Error('pr must be a positive integer');
  if (!/^[0-9a-f]{40}$/.test(String(blob))) throw new Error('blob must be 40 hex');
  if (!/^[A-Za-z0-9._/-]+$/.test(String(planPath)) || String(planPath).split('/').includes('..')) throw new Error('bad plan path');
  if (kind !== 'review' && kind !== 'recheck') throw new Error('kind must be review|recheck');
  return [
    `You are reviewing an IMPLEMENTATION PLAN for pull request #${pr}, not a diff. The plan is the file ${planPath} (git blob ${blob}); read it, then read the repository code it changes (read-only).`,
    'Find what would make the plan fail its own goal or the spec it cites: missing requirements, wrong file/function names, steps that contradict the code, unsafe orderings, missing tests, placeholders.',
    'BLOCKING = following the plan as written would ship a bug, a security/approval hole, or break an existing invariant. SUGGESTIONS = concrete improvements. WORTH_CONSIDERING = optional.',
    'Each finding: title, file (the plan path or the code file), line (0 if none), category, detail, reasoning, testable. Answer with JSON matching the schema.',
    ...(kind === 'recheck' ? ['This is the ONE recheck. Your earlier findings are below; say for each whether the revised plan resolves it, and report only unresolved or new problems.', '', defuseMarkdown(priorFindingsMarkdown)] : []),
  ].join('\n');
}
```
  - `start` — launch ownership (Codex plan R1-2: reusing an existing key must NOT authorise another paid launch; spec
    §3 "a valid start is consumed even if the run then crashes"):
    1. Validate `--key` (`/^[A-Za-z0-9._-]{1,48}$/`) and `--reviewer`; require an active proposal (`ok`).
    2. `find = () => startsValidity(listEvents(gh.listComments(pr), viewer)).find((s) => s.reviewer === reviewer && s.key === key)`
       (the EARLIEST comment with that key, duplicates collapsed).
    3. If found BEFORE posting → exit 1 `{ error: 'already-started', valid, commentId }`: this caller never launches
       (a retry after a crash, or a second controller). The slot is consumed; another run needs a new key (cap or extra).
    4. Otherwise `claim = randomBytes(8).toString('hex')` and `postEvent(gh, pr, 'plan-review-started', `${reviewer}-${key}`,
       `Plan review started: ${reviewer} ${key}`, { ...bind, reviewer, key, planBlob: active.blob, claim, ...(extra ? {
       extra } : {}), at, host })`.
    5. Catch a `GhError` from the POST and still re-list (ambiguous POST). After the POST, `find()` again: not found →
       exit 3 `not-visible`.
    6. `found.claim !== claim` → exit 1 `already-started` (another caller's comment is the earliest: it owns the launch).
    7. `found.valid` → exit 0 `{ go: true, key, reviewer, planBlob: found.planBlob, claim }`; else exit 1 `cap`.
    8. For fable, `promptHeader = `ROUND: plan\nINPUT-DIGEST: ${sha256([bind.repo, pr, 'fable-plan', found.planBlob, key].join('\n'))}``.
    9. The launch is bound to `found.planBlob`: `review` and `findings` refuse (exit 1 `stale-start`) when the active
       proposal's blob is no longer `found.planBlob`.
  - `review`:
    1. Run the `start` logic for `codex` (exit 1/3 passthrough; only `go: true` continues — exactly one launch per key).
    2. Prompt: `kind` is `recheck` when another valid codex start with an earlier `commentId` exists; `--prior FILE`
       supplies its markdown (always, also when resuming, so the recheck works without a session).
    3. Session (Codex plan R1-10; spec §3 "a recheck resumes the first run's Codex session when one exists"): for a
       recheck, read `.review/plan/<earlier key>.json` `session`. When it is a valid id, `args = buildCodexResumeArgs({
       sessionId, model, effort, schemaPath, outPath })` = `['exec', 'resume', <id>, '-c', 'sandbox_mode="read-only"',
       '--json', '-o', outPath, '--output-schema', schemaPath, '-c', model…, '-c', effort…, '-']` (`resume` accepts
       neither `-C` nor `--sandbox`: the spawn cwd carries the repo, and the sandbox is re-pinned through the config
       key, as `~/.claude/skills/codex-review/scripts/review.mjs` ~120 does; verified on codex-cli 0.154: `exec resume`
       takes `--json`, `-o` and `--output-schema`). Otherwise a fresh run with `buildCodexArgs` (+ `--json`) and the
       prior findings in the prompt; the output notes `resumed: false`.
    4. `askCodex(...)` gains a `json: true` mode: parse stdout JSONL, take `thread_id` from the `thread.started` event
       as `session` and `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`) from the LAST
       `turn.completed`; either missing → `null` (never guessed). Return `{ ok, findings, session, usage }`. On failure
       → exit 3 with its reason; the `session` is still written to `.review/plan/<key>.failed.json` when known.
    5. `items = assignIds(findings, n, () => '', { contentHash: found.planBlob })` with `n` = the start's position among
       valid codex starts.
    6. Write `.review/plan/<key>.json` (`{ findings, items, blob, reviewer, key, session, resumedFrom, usage }`) + `.md`
       (`renderFindingsMarkdown(findings, n, items)`), then book cost when `session` is known: `bookCost` key
       `codex:<session>`, phase `plan`, role `codex`, tokens from `usage` (input = input_tokens − cached, cacheRead =
       cached, output = output_tokens), `usd: 0` (Codex is not billed to Claude); `usage: null` → no booking, the output
       says `cost: 'not-reported'` and the approval request says so. The booking goes through the same
       verify-after-write path as `P cost --execution` (T2).
    7. Tests (`test/plan-budget.test.mjs`, fake `codex` bin printing JSONL): session + usage captured and booked once
       (re-running `review` with the same key exits `already-started`, no second booking); a recheck resumes the first
       session (fake codex records its argv: `exec resume <id>`); missing `thread.started` → fresh recheck with
       `resumed: false`, `cost: 'not-reported'`; an interrupted run (fake codex exits 1 after `thread.started`) → exit
       3, `<key>.failed.json` holds the session, and the key is consumed.
  - `findings`:
    1. Require a valid `fable` start for `key` and no existing `.review/plan/<key>.json`.
    2. `found = findSubagentTranscript({ tag, projectsDir, maxAgeMs })` (null → exit 2).
    3. The first JSONL line's `timestamp` must be ≥ `start.createdAt`.
    4. `proof = proveModel({ jsonlText, metaText, expectModelPrefix: 'claude-fable-', expectEffort: 'high',
       expectMetaModel: null, expectAgentType: 'fable-reviewer' })`.
    5. Header lines `ROUND: plan` and `INPUT-DIGEST: <digest>` must be in `proof.firstUserText` (same regexes as
       `arbiter.mjs` ~199).
    6. `json = extractJsonBlock(proof.finalAssistantText)` → `validateFindings`.
    7. Any error → exit 1 with `errors`, nothing written. Else write the files as for `review`.
- [ ] **Step 4: Run** `node scripts/test.mjs plan-budget codex cli-review` → PASS.
- [ ] **Step 5: Commit** `feat(plan): per-PR reviewer budget (plan start) and Codex/Fable plan reviews`.

---

### Task T6: Gate check `plan-scope` (config keys land in T4)

**Files:**
- Reference only: `pipeline/lib/config.mjs` (`DEFAULTS` 24-72, `KEYS` 95-111, `validateConfig` ~436/499) — edited in T4
- Modify: `pipeline/lib/finalgate.mjs` (`CANONICAL_CHECKS` 38, `evaluateGate` 614-647, new `planScopeCheck`)
- Modify: `pipeline/commands/final-gate.mjs` (pass `home: ctx.home` through)
- Modify: `test/helpers/gate-env.mjs`, `test/helpers/fakegh-env.mjs` (`pipelineYml`), `test/helpers/ci-proof-env.mjs`: the
  generated yml gets `plan:\n  required: false` by default (an opt-in `plan: true` option omits it), so existing gate
  scenarios keep their meaning
- Test: `test/config.test.mjs` (extend), `test/plan-gate.test.mjs` (create), `test/finalgate.test.mjs` (`CANONICAL_CHECKS` fixture)

**Interfaces:**
- Consumes: `planScopeVerdict`, `bindOf` (T4); `readPlanApprovals` (T3); `listEvents` (T2); `summaryFromComments`
  (`lib/summary-comment.mjs`), `decodeRecord`.
- Produces:
  - config `plan: { dir: 'docs/plans', required: true }`; `review.final_pass: 'off'|'risky'` (default `'off'`); `review.security: 'off' | { paths: string[] }` (default `{ paths: [] }`)
  - `CANONICAL_CHECKS = ['pr-open','labels','preflight','verify-report','hardstops','integrity','plan-scope','review','ci']`
  - `evaluateGate({ …, home })` (optional, default `accountHome()`)

- [ ] **Step 1: Failing tests**
  - `test/config.test.mjs` (WRITTEN IN T4 with the keys; listed here as the reference):
    - defaults: `config.plan` deep-equals `{ dir: 'docs/plans', required: true }`, `review.final_pass === 'off'`, and
      `review.security` deep-equals `{ paths: [] }`;
    - accepted: `plan.required: false`, `review.security: off`, `review.security: {paths: ["auth/**"]}`;
    - refused: `plan.dir: /abs` (`plan.dir must be a relative path`), `plan.extra: 1` (`unknown key: plan.extra`),
      `review.final_pass: always`, and `review.security: {paths: [1]}`.
  - `test/plan-gate.test.mjs` (end to end like `test/ci-proof-gate.test.mjs:222-250` `gateFor`, with the scenario
    yml opting in to `plan: true`):
    - (a) no plan events, chat mode → `plan-scope` ok with `ownerMerge: 1`, and `gate.ownerItems` changes vs the same
      PR with `required: false`;
    - (b) label mode, no events → the gate fails `plan-scope`;
    - (c) an approved plan event + matching local record in a temp `home` + every file in scope → ok, `ownerMerge: 0`;
    - (d) the same with one file outside → one item `plan-scope outside <file>`;
    - (e) an edited (`updated_at` ≠ `created_at`) approval → `ok: false` detail `lost`;
    - (f) `gateRefusals` of a saved gate whose check names lack `plan-scope` → refused (canonical set).

- [ ] **Step 2: Run** `node scripts/test.mjs config plan-gate finalgate` → FAIL.

- [ ] **Step 3: Implement**
  - `config.mjs` — ALREADY DONE in T4 (moved there so `P plan risk` has its defaults); this is the reference text T4
    implements, and the `test/config.test.mjs` cases above are written in T4. T6 changes nothing in config.mjs:
    - `DEFAULTS.plan = { dir: 'docs/plans', required: true }`;
    - `DEFAULTS.review.final_pass = 'off'` and `DEFAULTS.review.security = { paths: [] }`;
    - `KEYS.plan = ['dir', 'required']`; `KEYS.review` += `'final_pass', 'security'`.
    - Validation:
```js
const plan = section(config, 'plan', errors);
if (plan) {
  if (!isStr(plan.dir) || plan.dir === '' || plan.dir.startsWith('/') || plan.dir.split('/').includes('..')) errors.push('plan.dir must be a relative path');
  if (typeof plan.required !== 'boolean') errors.push('plan.required must be true or false');
}
// inside the review block:
if (!['off', 'risky'].includes(review.final_pass)) errors.push('review.final_pass must be off or risky');
if (review.security !== 'off') {
  if (!isObj(review.security)) errors.push('review.security must be off or a mapping');
  else {
    unknownKeys(review.security, ['paths'], 'review.security.', errors);
    checkStrArray(review.security.paths, 'review.security.paths', errors);
  }
}
```
  - `finalgate.mjs`: insert `'plan-scope'` after `'integrity'` in `CANONICAL_CHECKS`; in `evaluateGate` push
    `await safely('plan-scope', () => planScopeCheck({ root, config, diff, gh, pr, home }))` right after integrity.
```js
async function planScopeCheck({ root, config, diff, gh, pr, home }) {
  const d = diff();
  if (!d.ok) return check('plan-scope', false, `could not diff against the base: ${d.error}`);
  const viewer = gh.viewer();
  const comments = gh.listComments(pr);
  const view = gh.prView(pr, ['headRefName']);
  // summaryFromComments already decodes: { status, record? } (Codex plan R1-4). A summary we cannot read while plan
  // events exist is covered by the events; a readable record with a plan but no events is `lost` (verdict).
  const summary = summaryFromComments(comments, viewer);
  const bind = bindOf({ repo: gh.repo().slug, pr, branch: view.headRefName });
  const own = summary.status === 'ok' && summary.record?.repo === bind.repo && summary.record?.pr === pr;
  const verdict = planScopeVerdict({
    events: listEvents(comments, viewer),
    bind,
    recordPlan: own ? summary.record.plan ?? null : null,
    localRecords: readPlanApprovals({ home }),
    readBlob: (b) => { try { return git(['cat-file', 'blob', b], { cwd: root }); } catch { return null; } },
    blobAtPath: (p, b) => committedAt({ root, base: d.mergeBase, head: d.head, path: p, blob: b }),
    planDir: config.plan.dir,
    files: d.files,
    required: config.plan.required,
    ownerApproval: config.owner_approval,
    host: hostname(),
  });
  return check('plan-scope', verdict.ok, verdict.detail, verdict.ownerMerge, verdict.ownerItems);
}
```
    `committedAt({ root, base, head, path, blob })` (in `finalgate.mjs`): `git log --format=%H <base>..<head> -- <path>`
    (cap 200 commits), then true when any `git rev-parse <c>:<path>` equals `blob`; any git error → false. Take the
    merge base / head from whatever `diff()` already computed (check its return fields; if it does not expose them,
    compute `mergeBase(baseRef, head)` the same way the integrity check does). Extra tests in `plan-gate.test.mjs`:
    - (g) summary-only evidence: a readable record with `plan` but no plan events → `lost` (proves the decoded summary
      is used: with the old `decodeRecord(summary.body)` bug it reads `none`);
    - (h) a forged approval comment whose `path` names a changed source file → that file is still an item.
  - Update `test/finalgate.test.mjs`'s `checksOf` default via `CANONICAL_CHECKS` (it already imports it). Update
    `docs/cli.md` (gate checks list).
- [ ] **Step 4: Run** `node scripts/test.mjs config plan-gate finalgate ci-proof-gate cli-gate gate-fix merge-owner-approval owner-approval-chat self-verify` → PASS.
- [ ] **Step 5: Commit** `feat(gate): plan-scope check (approved scope, none/lost/unverified) + plan/review config keys`.

---

### Task T7: Security trigger, derived reviewer obligations, new agents, model mix

**Files:**
- Modify: `pipeline/lib/hardstops.mjs` (export `isSqlPath` ~104)
- Modify: `pipeline/lib/risk.mjs` (add `assessSecurity`; `securityGlobs` exists from T4), `pipeline/commands/risk.mjs` (output)
- Modify: `pipeline/commands/review-complete.mjs` (`whyNot` names unmet obligations)
- Create: `pipeline/lib/obligations.mjs`
- Modify: `pipeline/lib/state.mjs` (`addRound` keeps `obligations`), `pipeline/lib/triage.mjs` (`roundOutcome` 293, `reviewValidFor` 321)
- Modify: `pipeline/commands/codex-review.mjs` (write obligations at round creation)
- Create: `pipeline/commands/review.mjs` (`header`, `add`)
- Create: `agents/fable-reviewer.md`, `agents/security-reviewer.md`, `agents/screenshot-reviewer.md`
- Modify: `agents/verifier.md` (model haiku; drop screenshot reading)
- Modify: `pipeline/lib/installer.mjs` (`AGENTS` 15, `SUBAGENT_NOTE` 30), `pipeline/hooks/lib/files-policy.mjs` (`PROTECTED_REL` 33-46)
- Test: `test/obligations.test.mjs`, `test/review-add.test.mjs`, `test/risk.test.mjs` (extend), `test/docs-facts.test.mjs` (extend), `test/install.test.mjs` (extend), `test/guard-files.test.mjs` (extend)

**Interfaces:**
- Produces:
  - `assessSecurity({ files, hits, config }) → { security: boolean, reasons: string[] }`
  - `securityGlobs(config) → string[]`
  - `requiredObligations({ round, security, securityInRange, level, finalPass, blockingCount, priorRounds }) → Array<'security'|'fable'>`
  - `obligationDigest({ repo, pr, source, base, head }) → 64 hex`
  - round field `obligations: Array<{ source, status: 'pending'|'met'|'failed', digest, reason?, tag? }>`
  - `roundOutcome(state)` += `unmetObligations: string[]` (`R<n>:<source>` pending), failed obligations appear in `needsHuman` as `R<n>:<source>-proof`; `clean` requires both empty
  - `reviewValidFor` false while any round has a non-met obligation
  - `pipeline review header --pr N --round R --source security|fable --base SHA --head SHA` → `{ ok, promptHeader, digest }`
  - `pipeline review add --round R --source security|fable --tag TAG [--projects-dir DIR] [--max-age-ms N] [--repo DIR]` → `{ ok, round, source, added: [ids], errors }`; added ids `R<n>-X<letter><i>` (security) / `R<n>-F<letter><i>` (fable)

- [ ] **Step 1: Failing tests**
  - `test/risk.test.mjs`:
    - a plain new migration `supabase/migrations/1_t.sql` creating a table with no hits → `security: true`;
    - a `R2-auth` hit on `src/x.ts` → true;
    - `docs/a.md` only → false;
    - `review.security: 'off'` → false;
    - `review.security.paths: ['src/auth/**']` + `src/auth/a.ts` → true.
  - `test/obligations.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredObligations, obligationDigest } from '../pipeline/lib/obligations.mjs';
import { roundOutcome, reviewValidFor } from '../pipeline/lib/triage.mjs';
const base = { round: 1, security: true, securityInRange: false, level: 'high', finalPass: 'off', blockingCount: 0, priorRounds: [] };
test('security in round 1; later rounds only when trigger files changed; fable only with final_pass risky + high + no BLOCKING, once', () => {
  assert.deepEqual(requiredObligations(base), ['security']);
  assert.deepEqual(requiredObligations({ ...base, round: 2 }), []);
  assert.deepEqual(requiredObligations({ ...base, round: 2, securityInRange: true }), ['security']);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky' }), ['fable']);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky', blockingCount: 1 }), []);
  assert.deepEqual(requiredObligations({ ...base, security: false, finalPass: 'risky', priorRounds: [{ obligations: [{ source: 'fable', status: 'met' }] }] }), []);
  assert.match(obligationDigest({ repo: 'a/b', pr: 1, source: 'security', base: 'x', head: 'y' }), /^[0-9a-f]{64}$/);
});
const st = (obligations) => ({ maxRounds: 3, currentContentHash: 'h', rounds: [{ n: 1, contentHashAtToHead: 'h', items: [], obligations }] });
test('an unmet obligation keeps a round with zero items from being clean; failed → needsHuman; met → clean', () => {
  assert.equal(roundOutcome(st([{ source: 'security', status: 'pending', digest: 'd' }])).clean, false);
  assert.deepEqual(roundOutcome(st([{ source: 'fable', status: 'failed', digest: 'd' }])).needsHuman, ['R1:fable-proof']);
  assert.equal(roundOutcome(st([{ source: 'security', status: 'met', digest: 'd' }])).clean, true);
  assert.equal(reviewValidFor(st([{ source: 'security', status: 'pending', digest: 'd' }]), 'h'), false);
});
```
  - `test/review-add.test.mjs` (import `run` from `pipeline/commands/review.mjs`; a state with a round-1 pending security
    obligation; transcript fixtures as in the arbiter tests). Cases:
    - a proven Sonnet transcript with the right header and an empty findings JSON → obligation `met`, no items;
    - the same with 1 blocking → item `R1-XB1` added with `bucket: 'BLOCKING'`;
    - an Opus transcript → `failed` + needsHuman;
    - a header with another head's digest → `failed`;
    - `add` for a `met` obligation → exit 1 `already-met`;
    - `add` after `failed` → allowed once more.
  - `test/docs-facts.test.mjs`:
    - `verifier.md` has `model: haiku`;
    - `fable-reviewer.md` has `model: fable` + `effort: high`;
    - `security-reviewer.md` and `screenshot-reviewer.md` have `model: sonnet` and no `effort:`.
  - `test/install.test.mjs`: the three new agents install and appear in the manifest.
  - `test/guard-files.test.mjs`: a Write to `~/.claude/agents/fable-reviewer.md` is denied.

- [ ] **Step 2: Run** `node scripts/test.mjs risk obligations review-add docs-facts install guard-files` → FAIL.

- [ ] **Step 3: Implement**
  - `hardstops.mjs`: `export const isSqlPath = …` (no behaviour change).
  - `risk.mjs`:
```js
// securityGlobs: already exported by T4 (same definition).
const SECURITY_RULE = (rule) => /^R1-/.test(rule) || /^R2-/.test(rule) || rule === 'R3-secrets';
export function assessSecurity({ files, hits, config }) {
  if (config.review.security === 'off') return { security: false, reasons: ['security review off (review.security: off)'] };
  const reasons = [];
  const globs = securityGlobs(config);
  const paths = [...new Set(files.flatMap((f) => [f.oldPath, f.newPath, f.path]).filter((p) => typeof p === 'string' && p))];
  const sql = paths.filter((p) => isSqlPath(p) || matchAny(p, globs, { nocase: true }));
  if (sql.length) reasons.push(`database/security path: ${sql.slice(0, 5).join(', ')}${sql.length > 5 ? ' …' : ''}`);
  const rules = [...new Set(hits.filter((h) => SECURITY_RULE(h.rule)).map((h) => h.rule))];
  if (rules.length) reasons.push(`hard-stop family: ${rules.join(', ')}`);
  return { security: reasons.length > 0, reasons };
}
```
    `commands/risk.mjs` adds `security` and `securityReasons` to its output.
  - `obligations.mjs`:
```js
import { createHash } from 'node:crypto';
export const OBLIGATION_SOURCES = Object.freeze(['security', 'fable']);
export function requiredObligations({ round, security, securityInRange, level, finalPass, blockingCount, priorRounds }) {
  const out = [];
  if (security && (round === 1 || securityInRange)) out.push('security');
  const fableMet = (priorRounds ?? []).some((r) => (r.obligations ?? []).some((o) => o.source === 'fable' && o.status === 'met'));
  if (finalPass === 'risky' && level === 'high' && blockingCount === 0 && !fableMet) out.push('fable');
  return out;
}
export const obligationDigest = ({ repo, pr, source, base, head }) => createHash('sha256').update([repo, pr, source, base, head].join('\n')).digest('hex');
export const promptHeader = (round, digest) => `ROUND: ${round}\nINPUT-DIGEST: ${digest}`;
```
  - `codex-review.mjs`, inside the review lock just before `addRound` (Codex plan R1-8: every input is defined here,
    for every round):
    1. `sec = assessSecurity({ files, hits, config })` (full range: `files` = `diffFiles(forkPoint, head, o)` ~172,
       `hits` ~173).
    2. The round's own range is `base` (this round's `fromHead`, the previous round's head) .. `head`:
       `rangeFiles = round > 1 ? diffFiles(base, head, o) : files`;
       `changedInRange = new Set(rangeFiles.flatMap((f) => [f.oldPath, f.newPath, f.path]).filter(Boolean))`;
       `inRange = round > 1 && assessSecurity({ files: rangeFiles, hits: hits.filter((h) => changedInRange.has(h.file)),
       config }).security`. Compute `rangeFiles` BEFORE taking the lock (git work outside the lock, like `files`).
    3. `repo = base0.repo` (set by `emptyState` from `slug` on round 1, loaded from state on later rounds — `slug` is
       only initialised when no state exists, ~127-130, so it must not be used here).
    4. `obligations = requiredObligations({ round, security: sec.security, securityInRange: inRange, level,
       finalPass: config.review.final_pass, blockingCount: findings.blocking.length, priorRounds: base0.rounds })
       .map((source) => ({ source, status: 'pending', digest: obligationDigest({ repo, pr, source, base:
       review.base, head }) }))`.
    5. Test (`test/review-add.test.mjs`, end to end through `P codex-review` with a fake codex, then `P review header`
       and `P review add`): round 1 touches `supabase/migrations/1.sql` → security obligation; round 2 changes the SQL
       file again → a new round-2 security obligation whose digest has the real `owner/repo` (no `undefined`), and a
       transcript with the header from `P review header` is accepted (`met`); round 2 touching only `docs/a.md` → no
       obligation.
    4. Pass `obligations` into `addRound` and print them in the command output (`obligations: [{source, promptHeader}]`)
       so the controller knows what to dispatch.
    `state.mjs` `addRound` copies `obligations` when given (an array of known sources); `loadState` / comment decoding
    keep it.
  - `triage.mjs` `roundOutcome`:
```js
const obl = state.rounds.flatMap((r) => (r.obligations ?? []).map((o) => ({ ...o, n: r.n })));
const unmetObligations = obl.filter((o) => o.status === 'pending').map((o) => `R${o.n}:${o.source}`);
const failedObligations = obl.filter((o) => o.status === 'failed').map((o) => `R${o.n}:${o.source}-proof`);
// needsHuman = [...item ids needing a human, ...failedObligations]; clean additionally requires unmetObligations.length === 0
```
    `reviewValidFor` returns false when any round has an obligation with `status !== 'met'`. `commands/review-complete.mjs`
    `whyNot` names unmet obligations ("reviewer obligations not met: …") before the coverage message.
  - `commands/review.mjs` (`header`, `add`; `meta.usage` lines `pipeline review header …` / `pipeline review add …`):
    - `header` prints `promptHeader(round, obligationDigest(...))`.
    - `add`, under `withReviewLock`:
      1. `loadState`, find round R and the obligation for `--source`: absent → exit 1 `no-obligation`; `met` → exit 1
         `already-met`.
      2. `findSubagentTranscript({ tag, … })` (null → exit 2).
      3. `proveModel({ …, expectModelPrefix: source === 'fable' ? 'claude-fable-' : 'claude-sonnet-', expectEffort:
         source === 'fable' ? 'high' : null, expectMetaModel: null, expectAgentType: source === 'fable' ?
         'fable-reviewer' : 'security-reviewer' })`. Check how `proveModel` treats a null `expectEffort` and keep Sonnet
         (no effort line) passing.
      4. The header (`^ROUND: R$`, `^INPUT-DIGEST: <obligation.digest>$`) must be in `firstUserText`.
      5. `extractJsonBlock` → `validateFindings`.
      6. Any error → set the obligation `{ status: 'failed', reason: errors.join('; ').slice(0, 300), tag }`, save,
         exit 1.
      7. Else `items = assignIds(json, R, excerptFor, { contentHash })` with ids rewritten `R<n>-<B|S|W><i>` →
         `R<n>-<X|F><B|S|W><i>`; append to the round via `updateItems`; set the obligation `met` with `tag`; save;
         exit 0.
  - Agents (frontmatter exactly; bodies are plain instructions):
    - `agents/fable-reviewer.md`: `name: fable-reviewer`, description "Adversarial reviewer on Fable for a plan (mode
      plan) or a PR diff (mode pr, final pass). Read-only. Returns findings JSON.", `model: fable`, `effort: high`,
      `tools: Read, Grep, Glob, Bash`, `color: red`. Body:
      1. The first lines of your prompt are `ROUND:` / `INPUT-DIGEST:`: never change them.
      2. Mode `plan`: attack the plan at the given path against the code. Mode `pr`: review `git diff <base>...<head>`
         in the given worktree.
      3. Read-only: no edits, no git writes, no network.
      4. Final message: ONE ```json block matching `pipeline/schemas/codex-findings.schema.json` (summary, blocking,
         suggestions, worth_considering; each finding: title, file, line, category, detail, reasoning, testable).
      5. Empty lists are fine.
    - `agents/security-reviewer.md`: same output contract; `model: sonnet`, no effort, `tools: Read, Grep, Glob, Bash`,
      `color: orange`. Focus: RLS/grants/policies, auth checks, secret handling, injection, data exposure in migrations
      and app code of the diff.
    - `agents/screenshot-reviewer.md`: `model: sonnet`, no effort, `tools: Read, Glob`, `color: yellow`. Read every
      `.verify/screenshots/*` image in the given worktree; one line per image (`<path> — <observation>`); flag
      overflow, cut text, wrong copy, dark-mode contrast. Never edits.
    - `agents/verifier.md`: `model: haiku`; remove instruction 4 (screenshots) and the `Screenshots:` output line.
  - `installer.mjs`: `AGENTS = ['implementer', 'verifier', 'judge', 'arbiter', 'fable-reviewer', 'security-reviewer', 'screenshot-reviewer']`;
    `SUBAGENT_NOTE` names "judge=opus, arbiter=fable, fable-reviewer=fable, verifier=haiku, security-reviewer=sonnet,
    screenshot-reviewer=sonnet, implementer=sonnet".
  - `files-policy.mjs` `PROTECTED_REL` += `.claude/agents/fable-reviewer.md`, `.claude/agents/security-reviewer.md`,
    `.claude/agents/screenshot-reviewer.md`.
- [ ] **Step 4: Run** `node scripts/test.mjs risk obligations review-add triage cli-review review-complete docs-facts install guard-files skills-commands` → PASS.
- [ ] **Step 5: Commit** `feat(review): default security review, derived reviewer obligations, Fable final pass, Haiku verifier`.

---

### Task T8: Busy-main hand-off (`P handoff check`, cp #88)

**Files:**
- Create: `pipeline/lib/handoff.mjs` (pure eligibility + comment rendering)
- Create: `pipeline/commands/handoff.mjs`
- Modify: `pipeline/lib/updatebranch.mjs` (`bringUpToDate` returns the confirmed update pairs)
- Modify: `pipeline/commands/merge.mjs` (~104-112: record the updates), `pipeline/commands/update-branch.mjs` (~33-38)
- Test: `test/handoff.test.mjs`, `test/handoff-command.test.mjs`, `test/update-branch.test.mjs` (extend)

**Interfaces:**
- Consumes: `evaluateGate` (T6), `createRunRecorder`, `bringUpToDate` result `{ updated, startHead, base (a branch NAME), head, updates }`, `gh.protection(branch)` → `{ status, json }` (`github.mjs:347`; 200 = `json` holds the protection, 403/404 = answers), `runShellAsync` (`proc.mjs` ~232), `ciProof`-style run listing (`ci-proof.mjs`), record `behindBaseUpdates` / `handoff` (T2).
- `bringUpToDate` gains `updates: Array<{ headBefore, baseTip }>` on EVERY return (`out()`): one pair pushed right
  after the parents check confirms `next` is the merge of `baseSha` into `head` (both 40-hex SHAs; `base` stays the
  branch name). So a `cycle-cap`, `checks-failed` or `head-timeout` exit after a confirmed update still reports it.
- Produces:
  - `handoffEligibility({ updates, strict, gate, mergeTreeOk, quickVerifyOk }) → { eligible, reasons: string[] }`
  - `renderHandoffComment({ pr, head, baseTip, ciBase, commits: [{sha, subject, files}], prFiles, ownerItems, productionWatch }) → string` (starts with `MARKERS`-style marker `<!-- claude-pipeline:handoff -->`)
  - `pipeline handoff check --pr N [--post] [--repo DIR]` → exit 0 `{ eligible: true, head, baseTip, commits, overlap, ownerItems, quickVerify, production, posted? }`, exit 1 `{ eligible: false, reasons }`, exit 3 GitHub

- [ ] **Step 1: Failing tests** `test/handoff.test.mjs`
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffEligibility, renderHandoffComment } from '../pipeline/lib/handoff.mjs';
const gate = (failed) => ({ checks: [{ name: 'pr-open', ok: !failed.includes('pr-open'), detail: failed.includes('pr-open') ? 'behind-base: 2 commits' : '' }, { name: 'ci', ok: !failed.includes('ci'), detail: '' }] });
const ok = { updates: 2, strict: false, gate: gate(['pr-open']), mergeTreeOk: true, quickVerifyOk: true };
test('eligible only with every condition', () => {
  assert.equal(handoffEligibility(ok).eligible, true);
  for (const [k, v] of [['updates', 1], ['strict', true], ['strict', null], ['gate', gate(['pr-open', 'ci'])], ['gate', gate([])], ['mergeTreeOk', false], ['quickVerifyOk', false]]) {
    assert.equal(handoffEligibility({ ...ok, [k]: v }).eligible, false, `${k}=${JSON.stringify(v)}`);
  }
});
test('the comment says what was and was not verified, shows overlap, items and the production line', () => {
  const body = renderHandoffComment({ pr: 9, head: 'a'.repeat(40), baseTip: 'b'.repeat(40), ciBase: 'c'.repeat(40), commits: [{ sha: 'd'.repeat(40), subject: 'x', files: ['src/a.mjs'] }], prFiles: ['src/a.mjs'], ownerItems: ['hardstop R4-pipeline x'], productionWatch: 'session' });
  assert.match(body, /NOT verified: full verify \/ CI on head merged with main@bbbbbbbbbbbb/);
  assert.match(body, /CI on head merged with main@cccccccccccc/);
  assert.match(body, /touches this PR's files: src\/a\.mjs/);
  assert.match(body, /hardstop R4-pipeline x/);
  assert.match(body, /nobody watches production .* until you say `ship resume 9`/);
  assert.match(body, /the pipeline will not merge/);
});
```
  `test/handoff-command.test.mjs`:
  - `merge.mjs`'s behind-base `updated` path appends a `behindBaseUpdates` pair to the record;
  - `update-branch` with `updated: true` appends one, and with `up-to-date` it appends none;
  - `handoff check` with 1 recorded update → exit 1 `fewer than 2 base updates`;
  - with a `strict: true` protection fixture → exit 1;
  - with a conflicting base → exit 1 `merge-tree conflicts`;
  - with a quick verify that fails in the temp tree → exit 1, and the temp worktree is removed (`git worktree list`);
  - eligible + `--post` → one comment posted and record `handoff` set.

- [ ] **Step 2: Run** `node scripts/test.mjs handoff` → FAIL.

- [ ] **Step 3: Implement**
  - `handoff.mjs`:
    - `handoffEligibility` reasons: `fewer than 2 base updates`; `branch protection requires up-to-date branches (or
      could not be read)` when `strict !== false`; `the live gate fails more than behind-base: <names>`; `the live gate
      is not behind base`; `merge-tree conflicts with main`; `quick verify failed on head merged with main`.
    - The gate condition: `failed = gate.checks.filter((c) => !c.ok)`; it must be exactly one check named `pr-open`
      whose detail starts with `behind-base`.
    - `renderHandoffComment` bullet lines exactly as spec §6 Action:
      - verified/not-verified line with `ciBase` and `baseTip` (12-char shas);
      - each base commit `sha12 subject (files…)`, then `Overlap: touches this PR's files: …` or `Overlap: none of
        this PR's files`;
      - owner items (or `none`);
      - production line — `session`: "with production.watch: session, nobody watches production or rolls back after a
        GitHub merge until you say `ship resume N` (observe-only, never rolls back)"; `workflow`: "the project's
        workflow posts the production result on this PR"; `none`: "no production environment";
      - last line: "Merge in GitHub only if you accept this; the pipeline will not merge."
  - `commands/handoff.mjs check` — everything is pinned to `H = gate.head` (never the mutable `HEAD`; Codex plan R1-7):
    1. Read the record (`readSummaryComment`; use `.status`/`.record`): `updates = record.behindBaseUpdates?.length ?? 0`.
    2. `p = gh.protection(baseRefName)`: `strict = p.status === 200 ? p.json?.required_status_checks?.strict ?? false
       : null` (403/404/throw → `null` = not provably off → not eligible; Codex plan R1-6).
    3. `gate = await evaluateGate({ root, config, pr, gh, env: ctx.env, home: ctx.home })`; `H = gate.head`. Local
       `git rev-parse HEAD` must equal `H` (else exit 1 `head-moved`).
    4. `git fetch origin <base>`; `baseTip = rev-parse origin/<base>`; `mergeTree = git merge-tree --write-tree H
       <baseTip>` (exit 0 → tree sha; non-zero → conflict).
    5. Quick verify:
       - commit the tree: `git commit-tree <tree> -p H -p <baseTip> -m "handoff check"`, with env
         `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` = `claude-pipeline <pipeline@localhost>`;
       - `git worktree add --detach <os.tmpdir()>/cp-handoff-<pr>-<rand> <commit>`;
       - symlink `node_modules` from `root` when it exists;
       - run `config.verify.quick` there with `runShellAsync(command, { cwd: tmp, timeoutMs: 10 * 60_000 })`
         (`proc.mjs` ~232: platform shell, kills the process tree on timeout; never a hardcoded `sh -c`; P3);
       - in `finally`: `git worktree remove --force <tmp>`, then `git worktree prune`.
    6. Skip the quick verify when an earlier condition already failed (report `quickVerify: { skipped: true }`).
    7. `commits` = `git log --format=%H%x09%s <mergeBase(H, baseTip)>..<baseTip>` + `git diff --name-only` per
       commit (cap 50 commits).
    8. `prFiles` = `diffFiles(mergeBase(H, baseTip), H)` paths.
    9. `ciBase` = the base the COMPLETED CI run on `H` actually tested, never today's `potentialMergeCommit` (it moves
       with main; `ci-proof.mjs` 28-33): `ciTestedBase({ gh, pr, head: H })` in `handoff.mjs` lists
       `actions/runs?head_sha=H&event=pull_request` (paginated like `ci-proof.mjs`), keeps completed runs bound to this
       PR, reads each run's `referenced_workflows` entry with `ref: refs/pull/<N>/merge` → that commit's parents (API
       `git/commits/<sha>`); the tested base = the parent that is not `H`. All runs agree → that sha; none usable or
       they disagree → `'unknown'`, and the comment says "CI on head merged with main@unknown (could not prove which
       base CI used)".
    10. `ownerItems` = `gate.checks.flatMap((c) => c.ownerItems ?? [])`; `production = config.production?.watch ??
        (config.production ? 'session' : 'none')`.
    11. With `--post` and eligible, re-validate right before publishing: `gh.prView(pr, ['headRefOid'])` and local
        `HEAD` both still equal `H`, and a fresh `evaluateGate` still meets the eligibility gate condition (only
        `pr-open` behind-base fails) with the same `head`. Any change → exit 1 `{ eligible: false, reasons: ['the PR
        changed during the check: run it again'] }`, nothing posted. Else `gh.createComment(pr,
        renderHandoffComment(...))` and `createRunRecorder(...).update({ handoff: { head: H, baseTip, at } })`.
  - `merge.mjs`: right after `bringUpToDate` returns and BEFORE any branch on its outcome (so `cycle-cap`,
    `checks-failed`, `head-timeout` after a confirmed update are recorded too):
    `for (const u of synced.updates) recorder.update({ behindBaseUpdate: u }, { initialStep: 'gate' })` (one recorder,
    best effort; warnings into the refusal's `extra.warnings`).
  - `update-branch.mjs`: in the `finally` that clears `inFlight`, record EVERY pair of `r.updates` (one
    `recorder.update({ behindBaseUpdate: u })` per pair before the `inFlight`-clearing update; the record dedups pairs).
  - Extra tests: `bringUpToDate` with `maxCycles: 1` whose base moves again → `cycle-cap` AND `updates.length === 1`
    with 40-hex `baseTip`; `merge` on that path records the pair; `handoff check` with protection `{ status: 200, json:
    { required_status_checks: { strict: false } } }` → strict passes, `{ status: 404 }` → not eligible; base moved
    after CI (the run's merge commit parent ≠ today's base) → the comment names the run's base, not today's; a fake
    gh whose PR head changes between the check and the post → nothing posted; `runShellAsync` is the runner (a quick
    verify command that is a shell builtin chain `true && true` passes on every platform).
- [ ] **Step 4: Run** `node scripts/test.mjs handoff cli-gate-merge gate-fix-merge update-branch` → PASS.
- [ ] **Step 5: Commit** `feat(handoff): hand a fully verified busy-main PR to the owner for a GitHub merge (#88)`.

---

### Task T9: Resume, inbox, summary and notify for the new step and outcomes

**Files:**
- Modify: `pipeline/lib/resume-plan.mjs` (`route` 91-126, `routeMerged` 51-68, `REPORT_ONLY` 22, `STOPS_AT_OWNER` 193)
- Modify: `pipeline/commands/resume.mjs` (facts: `plan`)
- Modify: `pipeline/lib/inbox.mjs` (`classifyPr` 149-234, `SUGGEST` 72), `pipeline/commands/inbox.mjs` (facts: `handoffMoved`)
- Modify: `pipeline/lib/notify.mjs` (`OUTCOME_EVENTS` 24 + event texts), `pipeline/commands/summary.mjs` (`NO_STATE_OUTCOMES` 31, `planPush` 91)
- Test: `test/resume-plan.test.mjs`, `test/inbox.test.mjs`, `test/notify-coverage.test.mjs`, `test/summary*.test.mjs` (extend)

**Interfaces:**
- Consumes: `planResumeFacts` (T4), `readPlanApprovals` (T3), outcomes (T2).
- Produces:
  - `planResume(facts)` with `facts.plan = { evidence, active, approval, openWork, needsApproveCheckpoint, lostReason? }` (absent = legacy, no plan routing)
  - new `enter` values: `plan` (re-show the request, stop) and `owner-ui-merge` (report-only)
  - `stop` for `plan` = `awaiting-plan-approval`
  - inbox `waitingOn` += `plan-approval` (suggest `leave`), `owner-github-merge` (suggest `leave`)
  - notify events `plan-approval` ("Plan for #N needs your approval: read it, then say \"approve\"") and `owner-ui-merge` ("PR #N is green: merge it in GitHub if you accept the hand-off")

- [ ] **Step 1: Failing tests**
  - `test/resume-plan.test.mjs` (use the file's existing facts builder):
    - (a) `plan: { evidence: true, approval: 'none', openWork: true }` with a record at `step: 'gate'` and `outcome:
      'stopped'` → `enter: 'plan'`, `adopt: false`, `stop: 'awaiting-plan-approval'`;
    - (b) `approval: 'unverified', openWork: true` → `plan`;
    - (c) `approval: 'unverified', openWork: false` → normal routing (e.g. `gate`);
    - (d) `approval: 'lost'` → `enter: 'decision'` with the reason naming the recovery;
    - (d2) `approval: 'verified', openWork: true, needsApproveCheckpoint: true` with a record at `step: 'plan'` and
      NO tasks (the event-success / checkpoint-failure sequence) → `enter: 'build'`, `planApproveFirst: true` — never
      review or gate;
    - (d3) end to end in `test/resume*.test.mjs` (command level): post `plan-approved` through a fake gh whose summary
      upsert fails, then `P resume plan` → `build` with `planApproveFirst`; then `P plan approve` succeeds, the record
      holds the approved tasks, and a second `P resume plan` routes to `build` WITHOUT `planApproveFirst`;
    - (e) no `plan` key → identical to today's routing for every existing fixture (run the whole file);
    - (f) state `OPEN` with record outcome `owner-ui-merge` → `enter: 'owner-ui-merge'`;
    - (g) state `MERGED` with record outcome `owner-ui-merge` → `observe-prod`.
  - `test/inbox.test.mjs`:
    - record outcome `awaiting-plan-approval` → `waitingOn: 'plan-approval'`, `suggest: 'leave'`;
    - record outcome `owner-ui-merge` with the PR behind base and CI green → `owner-github-merge` (never `pipeline`),
      and with `handoffMoved: 3` the reason contains `main moved 3 commits since the hand-off`;
    - failing CI still wins (`failing-check`).
  - `test/notify-coverage.test.mjs` passes once `OUTCOME_EVENTS` covers both outcomes (it enforces that every `OUTCOMES`
    word is classified).

- [ ] **Step 2: Run** `node scripts/test.mjs resume-plan inbox notify summary` → FAIL.

- [ ] **Step 3: Implement**
  - `resume-plan.mjs`:
    - `REPORT_ONLY` += `'plan', 'owner-ui-merge'`.
    - In `route()`, right after the `local-work` check (line ~99) and before the needs-human `decision`:
```js
const p = facts.plan; // route(facts, record): the parameter is `facts` (Codex plan R1-5)
if (p?.evidence) {
  if (p.approval === 'lost') return { enter: 'decision', reason: `plan evidence lost or tampered (${p.lostReason ?? 'unknown'}): re-show the active plan request; the owner's new "approve" clears it` };
  if (p.approval !== 'verified' && p.openWork) return { enter: 'plan', reason: p.active ? `plan ${p.active.blob.slice(0, 12)} is not approved on this machine: show its request and wait for "approve"` : 'no active plan proposal: run P plan record' };
  // Approval event posted but its checkpoint failed (spec §7): the approval is verified here, so resume builds — after
  // re-running the idempotent `P plan approve`, which copies the approved tasks into the record.
  if (p.approval === 'verified' && p.needsApproveCheckpoint) return { enter: 'build', reason: 'the plan is approved but the run record missed it: run P plan approve (reuses the event, copies the approved tasks), then build the open tasks', planApproveFirst: true };
}
if (record?.outcome === 'owner-ui-merge') return { enter: 'owner-ui-merge', reason: 'handed to the owner for a GitHub merge; the pipeline does not merge' };
```
    - `routeMerged`: `observe-prod` also when `record?.outcome === 'owner-ui-merge'`.
    - `stop`: `enter === 'plan' ? 'awaiting-plan-approval' : …existing…`.
  - `commands/resume.mjs`:
    - Compute `plan = planResumeFacts({ events: listEvents(comments, viewer) /* full events with data */, bind,
      recordPlan: record?.plan ?? null, localRecords: readPlanApprovals({ home: ctx.home }), recordTasks:
      record?.tasks, readBlob: (b) => { try { return git(['cat-file', 'blob', b], { cwd: root }); } catch { return
      null; } } })` (resume runs in the PR's worktree; a missing blob → `approval: 'lost'` → `decision`, never a silent
      skip of the plan step). Check the actual `enter` value list in `resume-plan.mjs` and use the existing name for the
      build step if it is not `build`.
    - `analyseComments` returns only `{kind,id}` events: extend `pr-facts.mjs` `analyseComments` to also return
      `fullEvents` (the `listEvents` output). Pass `plan` into `planResume`; show `plan` in the output.
  - `inbox.mjs`:
    - `SUGGEST` += `'plan-approval': 'leave', 'owner-github-merge': 'leave'`.
    - New branches placed after `failing-check` (204) and `review` (208), before `owner-merge` (216):
      - `record?.outcome === 'awaiting-plan-approval'` → `plan-approval`, reason `plan waiting for the owner's
        "approve"`, nextAction `read the plan, then say "approve"`.
      - `record?.outcome === 'owner-ui-merge'` → `owner-github-merge`, reason `handed off for a GitHub merge${f.handoffMoved
        > 0 ? `; main moved ${f.handoffMoved} commits since the hand-off` : ''}`, nextAction `merge in GitHub if you
        accept the hand-off (head ${sha7(f.headRefOid)})`.
    - `commands/inbox.mjs`: for such records with `record.handoff?.baseTip`, `facts.handoffMoved =
      gh.compare(record.handoff.baseTip, baseRefName).aheadBy ?? 0` (best effort; use whichever compare field counts
      commits on the base since that sha; check `github.mjs` `compare`).
  - `notify.mjs`: `OUTCOME_EVENTS['awaiting-plan-approval'] = 'plan-approval'`,
    `OUTCOME_EVENTS['owner-ui-merge'] = 'owner-ui-merge'`, plus their title/body templates next to the `owner-merge`
    event's.
  - `summary.mjs`: `NO_STATE_OUTCOMES` += `'awaiting-plan-approval'` (no review state exists yet).
- [ ] **Step 4: Run** `node scripts/test.mjs resume-plan resume inbox notify summary checkpoint` → PASS.
- [ ] **Step 5: Commit** `feat(resume,inbox): route the plan step, awaiting-plan-approval and owner-ui-merge`.

---

### Task T10: Skills, agents prose and docs

**Files:**
- Create: `skills/ship/reference/plan-stage.md`
- Modify: `skills/ship/SKILL.md`, `skills/ship/reference/review-loop.md`, `skills/ship/reference/gates-and-exits.md`,
  `skills/ship/reference/pr-and-summary.md`, `skills/verify/SKILL.md`, `docs/cli.md`, `VERSION`
- Test: `test/skills-commands.test.mjs`, `test/docs-facts.test.mjs` (extend with the needles below)

**Interfaces:** consumes every command and flag defined in T2–T9 exactly as spelled in their `meta.usage`.

- [ ] **Step 1: Failing test additions** (`test/docs-facts.test.mjs`)
  - `SKILL.md` contains `Route:`, `reference/plan-stage.md`, `📋 Ready to approve plan`, `P plan record`, `P plan approve`.
  - `plan-stage.md` contains `P plan risk`, `P plan start`, `P plan review`, `P plan findings`, `Plan <blob40> · scope`,
    `[skip ci]`, `--request-file`, `pipeline update` (the update-both-machines rule).
  - `review-loop.md` contains `P review header`, `P review add`, `obligations`.
  - `gates-and-exits.md` contains `plan-scope`, `owner-ui-merge`, `P handoff check`.
  - `SKILL.md` stays ≤ 500 lines.

- [ ] **Step 2: Run** `node scripts/test.mjs docs-facts skills-commands` → FAIL.

- [ ] **Step 3: Write the prose**
  - `SKILL.md`:
    - Step 0, after `P worktrees prune`: "**Route.** Before Step 1 write ONE line: `Route: ship | brainstorm first |
      debug first | superpowers-only | plan + several ships` + a short reason. Ask only when two routes are equally
      plausible."
    - New **Step 1.5 — plan** (≤ 25 lines): plan file per `reference/plan-stage.md`.
      1. Commit `[skip ci]`, push, `gh pr create --draft`.
      2. `P plan record --pr N --file <plan> --request-file <file>`.
      3. `P plan risk --pr N` → tell the owner the risk + reviewers.
      4. Reviews via `P plan start` / `P plan review` / `P plan findings`.
      5. The approval request ending with the two lines.
      6. `P summary --pr N --outcome awaiting-plan-approval --action "Read the plan, then say \"approve\""` → STOP.
      7. On the owner's "approve": `P plan approve --pr N`, then Step 2.
      8. Issue-driven runs stop at the request.
    - Step 2.1:
      - the draft PR already exists (Step 1.5);
      - the tasks are the approved plan's (no `--tasks-file`);
      - push + `P checkpoint --pr N --step build --task-done <id>` after each task;
      - implementers get the FULL task text from the plan file at the approved blob (`git show <blob>`).
    - Step 2.2: the verifier is Haiku (no change in how it is called).
    - Step 3.4: dispatch `screenshot-reviewer` on `.verify/screenshots` and paste its lines into the PR body.
    - Step 4: "The round's `obligations` (from `P codex-review`) are dispatched before the judge: see
      `reference/review-loop.md` **Reviewer obligations**."
    - Step 5.2/6.1: "On the second recorded base update (the gate or `P merge` returns behind-base again on a fully
      verified head), run `P handoff check --pr N --post` BEFORE another update-branch; eligible ⇒ `P summary --pr N
      --outcome owner-ui-merge --action "Merge in GitHub if you accept the hand-off"` and stop; not eligible ⇒ today's
      path."
    - Resume mode: `enter: plan` ⇒ show the active plan request (plain English, scope, the two lines) and stop;
      `owner-ui-merge` ⇒ report, stop.
    - Failure table rows:
      - `plan approve` exit 1 `superseded|no-approval` ⇒ re-show the active request;
      - gate `plan-scope: lost` ⇒ re-show the request, the owner re-approves;
      - `plan start` exit 1 `cap` ⇒ ask the owner for an extra or skip;
      - `plan start` / `plan review` exit 1 `already-started` ⇒ do NOT launch (the key is consumed); a new run needs a
        new key within the cap or an owner extra;
      - `P resume plan` → `build` with `planApproveFirst` ⇒ run `P plan approve --pr N` first.
    - Model notes: "Explore with `model: haiku` for lookups."
    - Trim elsewhere if needed to stay ≤ 500 lines (move the Inbox section's detail into `reference/pr-and-summary.md`
      if required).
  - `reference/plan-stage.md` (new, ~150 lines):
    - plan sizes and the required sections (with a 15-line small-plan example);
    - plan dir `plan.dir`;
    - commit `[skip ci]`;
    - risk + reviewer matrix (spec §3 table);
    - the exact reserve/launch sequence:
      - Codex: `P job start planreview -- node ~/.claude/pipeline/bin/pipeline.mjs plan review --pr N --key
        codex-<blob12>-1 --effort xhigh` → `P job wait …`; fix, `P plan record`, then the recheck with key
        `codex-<blob12>-2 --prior .review/plan/<first key>.md`;
      - Fable: `P plan start --pr N --reviewer fable --key fable-<blob12>-1` → dispatch `fable-reviewer` with the
        printed `promptHeader` as the first lines, Agent description = the tag `pipeline-fable-plan <key>` → `P plan
        findings --pr N --key <key> --tag "<tag>"`;
    - cost booking `P cost --pr N --phase plan --role codex|fable --execution codex:<session>|agent:<id> …`;
    - the approval request template (summary, plan or Scope in full, reviewer tally, plan token total, extras, two
      lines);
    - amendment rules;
    - the machine-switch rule (resume re-shows the request only while build work remains);
    - the rollout rule: both machines run `node ~/.claude/pipeline/bin/pipeline.mjs update` before any new-style run,
      and the owner never says "merge" to a v2 run on an older CLI.
  - `review-loop.md`: new **Reviewer obligations** section.
    1. `P codex-review` prints `obligations`.
    2. For each: `P review header --pr N --round R --source <s> --base <reviewBase> --head <head>`.
    3. Dispatch `security-reviewer` / `fable-reviewer` (mode pr) with the header as the first lines and tag
       `pipeline-<s> R<R> <digest8>`.
    4. `P review add --round R --source <s> --tag "<tag>"`.
    5. A failed proof = needs-human, rule in chat or re-dispatch once.
    6. The judge then triages `X`/`F` items like Codex items.
  - `gates-and-exits.md`:
    - `plan-scope` rows (`none`, `outside`, `unverified`, `lost`, label mode);
    - `P handoff check` exit codes and reasons;
    - outcome `owner-ui-merge`.
  - `pr-and-summary.md`: PR body gains "Plan: <path> @ <blob12>, approved <date>" and the plan-phase cost line.
  - `skills/verify/SKILL.md`: screenshots are read by `screenshot-reviewer` (Sonnet); lookups via Explore on Haiku.
  - `docs/cli.md`: `plan`, `review`, `handoff` commands; `cost --execution`; the gate's `plan-scope` check; record v2.
  - `VERSION`: `0.2.0`.
- [ ] **Step 4: Run** `node scripts/test.mjs docs-facts skills-commands` → PASS.
- [ ] **Step 5: Commit** `docs(ship): route line, plan stage, reviewer obligations, hand-off; verify skill model notes`.

---

### Task T11: Full verify and live integration evidence

**Files:** none new (evidence goes into the PR body).

- [ ] **Step 1:** `node scripts/verify.mjs` (full) → green; record the step table + head sha.
- [ ] **Step 2: Live evidence on this PR** (Codex R2 validation gaps), run with the WORKTREE's CLI, not the installed one:
  `node <worktree>/pipeline/bin/pipeline.mjs plan record --pr N --file docs/plans/2026-10-19-ship-redesign.md`. Check:
  - it posts one `plan-proposed` comment that the immediate re-list returns (read-your-writes), with comment ids rising;
  - running it again reuses it.
- [ ] **Step 3:** two `plan start --reviewer codex --key live-1` runs started at the same time from two shells, using the
  worktree CLI (owner-run if the guard refuses parallel shells): exactly one `go`, the other exits 1
  `already-started`. Note the comment ids and both `claim` values.
- [ ] **Step 4:** paste the results into the PR body under "Integration evidence"; delete nothing (events are
  append-only; they document this PR's own plan stage).

---

## Rollout (after merge; owner)
1. `node ~/.claude/pipeline/bin/pipeline.mjs update` on the Mac AND the PC before any new-style ship run (records become v2).
2. Never say "merge" to a v2 run from a machine still on 0.1.x.
3. EW gets the defaults on update (`plan.required: true`, security review on). EW's open PRs get one
   `plan-scope none` item each: say "merge" as usual.
4. Optional EW follow-up (after both machines updated): `review.security.paths`, `review.final_pass: risky`.

## Budget
Planning used Codex astra-xhigh review + 1 recheck and Fable high once (on the spec; caps used). Build: one Sonnet
implementer per task (T1–T10), T11 by the controller. Review: the normal ship review loop (Codex rounds ≤ 3, judge,
arbiter only on disputes). Sizing: ~2,000–2,500 changed lines incl. tests; one PR (owner 10-19). If the review stalls on
one part, carve it out late with a stated reason (rule 5).
