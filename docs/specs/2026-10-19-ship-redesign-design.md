# Ship redesign (redesign PR 4) — design

Status: DRAFT r2 (Codex astra-xhigh R1 findings 1–9 + P3 folded in; next: Codex recheck, then Fable once). Owner
decisions 2026-10-15 (memory `pipeline-redesign-2026-10-15`, items 1–3, 5–7 + planning budget) and 2026-10-19 (this
session) are the requirements; cp issue #88 is folded in. Risk: **high** (pipeline core: merge gate, owner-approval
recorder, guards, run state).

## In plain English
Every ship run gets a written plan that the owner approves before any code is written, and that approval is stored on
the PR in a form only the owner's own "approve" can produce. Reviewers are picked by risk (Fable only for risky work),
cheaper models do the mechanical checks, and the merge gate flags any file the PR changed that the approved plan did not
list. When main is so busy that the pipeline can never catch up, it hands the owner a green PR to merge in GitHub, saying
plainly what was and was not verified, instead of looping.

## Owner decisions this design must honour
- D1 Owner approves EVERY plan: plain-English summary + full plan + "reviewers found X / rejected Y because Z". A real
  pipeline state: plan committed on the branch, approval bound to the plan hash, `awaiting-plan-approval` outcome;
  issue-driven runs stop + push.
- D2 Planning by size: small = short plan in chat (owner 10-19: ALSO committed as a short plan file); medium/big =
  superpowers brainstorming → writing-plans → Codex. Plan tasks = ship's tasks file; ship implementers build (no SDD loop).
- D3 Plan reviewers: medium = Codex + 1 recheck; risky (DB/RLS/money/concurrency/security/pipeline core) = + Fable once on
  the corrected plan. Risk + Fable use told to the owner BEFORE review; owner can skip/add. Codex Astra xhigh for
  gate-level work.
- D5 Models: Haiku verifier (screenshots stay Sonnet) + Explore/lookups on Haiku; Sonnet security review on
  DB/auth/secrets PRs (ON by default, see 5). Sonnet main-session trial is item 7, NOT this PR.
- D6 Fable at PR stage = arbiter only; optional `review.final_pass` Fable for risky PRs when Codex finds nothing BLOCKING
  (default off).
- D7 ship starts with a one-line route; decide silently, ask only when ambiguous.
- Planning budget = review caps (Codex review + 1 recheck, 1 Fable) + reported token use; no numeric ceiling.
- 10-19: approval word "approve"; files outside the approved scope = owner-merge items (not a hard failure); one PR.
- Fail-closed requirements from `docs/plans/2026-10-15-verify-speedup.md` "Not in this PR": a pre-PR plan identity;
  approved scope kept separately from later edits (re-recording must not erase a violation); approval stored durably
  (not in the disposable run record); "never had a plan" distinct from "plan lost" (fail closed); budget reserved
  BEFORE a reviewer is dispatched (idempotent on retry); token tallies deduplicated per message id and persisted before
  switching machines.

## Trust model (Codex R1-1)
- The run record stays display + routing hints (`run-record.mjs` header). Everything the gate relies on is an **event**
  (`run-events.mjs`: its own comment, created once, viewer-authored, must START with the marker).
- Events are agent-writable today: `git-policy.mjs:35` allows `addComment` / `updateIssueComment`, and its REST policy
  (~829) does not protect event comments. This design closes that as an ordinary path:
  1. **Protected issuance.** guard-git refuses any command that is not a `P` invocation and whose text contains
     `claude-pipeline:event:` (gh pr/issue comment `--body`, `gh api` fields, graphql bodies, curl). guard-files refuses
     Write/Edit content containing `claude-pipeline:event:` outside the pipeline's own source/tests. Comment DELETE
     (REST `DELETE …/issues/comments/*`, graphql `deleteIssueComment`, already absent from the allow-list) is denied for
     agents. The residual is the documented #58 one (same OS user; a program the guards cannot see into; the owner's
     token): no new residual.
  2. **Edit detection.** An event comment whose `updated_at` differs from `created_at` is **tampered**; tampered counts
     as unreadable.
  3. **Binding.** `plan-approved` data carries `{repo, pr, branch, path, blob (full 40), scope[], scopeDigest, tasks[],
     ownerGo: {recordId, promptSha256, recordedAt}, at, host}`; every reader re-checks repo/pr/branch against the live PR.
  4. **Local proof when present.** On the machine that recorded it, `P plan approve` and the gate also check the local
     owner-go record (guarded folder, `owner-go.mjs`); another machine relies on the event (cross-machine durability).
  5. **Deletion.** Deleting every plan event can at most turn `lost` into `none` (section 4), and `none` is itself an
     owner-merge item shown to the owner as "no approved plan": never an auto-merge.

## 1. Route line (D7) — skill prose only
ship Step 0 ends with one line: `Route: ship | brainstorm first | debug first | superpowers-only | plan + several ships`
plus a 1-clause reason. Ask only when two routes are equally plausible. "plan + several ships" = one plan whose tasks the
owner split into PRs for a rule-5 reason; each ship run records its own plan file (a subset) and gets its own approval.

## 2. Plan stage (D1, D2)
New Step 1.5 between "branch" and "build" (details in new `skills/ship/reference/plan-stage.md`; SKILL.md keeps a short
summary).

1. **Write the plan** at `<plan.dir>/<YYYY-MM-DD>-<slug>.md` (config `plan.dir`, default `docs/plans`).
   - small (≤ ~3 files, no hard-stop path expected): 10–30 lines written by the controller.
   - medium/big: superpowers brainstorming → writing-plans (output path overridden to `plan.dir`).
   Required sections (parsed by `P plan record`, refused when missing):
   - `## In plain English` (2–4 sentences, reused in the approval request and the PR body).
   - `## Scope`: bullet list of backticked repo-relative paths or globs (`glob.mjs` syntax). Non-empty.
   - `### Task <id>: <title>` headings; the text up to the next heading is the task `spec` (clipped to `LIMITS.spec`).
     1..`LIMITS.tasks` tasks.
2. **Commit + push + draft PR** (Step 2's first-checkpoint PR creation moves here): commit the plan,
   `git push -u origin agent/<slug>`, `gh pr create --draft`.
3. **`P plan record --pr N --file <plan>`** (new: `pipeline/commands/plan.mjs` + pure `pipeline/lib/plan.mjs`):
   - The plan must be committed and pushed: `HEAD:<plan>` blob == the working file, `HEAD` == `origin/agent/<slug>`
     (else exit 1 `dirty` / `unpushed`).
   - Parses scope + tasks; `blob` = full blob sha; `scopeDigest` = sha256(sorted unique scope lines)[:12];
     each task gets `specSha` = sha256(title + spec)[:12].
   - Posts event `plan-proposed`, id `<blob12>`, data `{repo, pr, branch, path, blob, scope[], scopeDigest, tasks[], at,
     host}`. Idempotent: an existing untampered event with the same blob is reused.
   - Checkpoints the record: `step: plan`, `plan: {path, blob, scopeDigest, state: 'proposed'}` (display only).
   - Prints `{blob, scopeDigest, tasks, requestLines}`.
   **The active proposal (R1-2)** is the LATEST untampered `plan-proposed` event by comment id. Older proposals are
   superseded and can never be approved.
4. **Reviews** (section 3). Each fix commits a new revision and runs `P plan record` again.
5. **Approval request** (D1). The reply shows the plain-English summary, the full plan (or its path + section list when
   > 150 lines; the owner can ask for all of it), the reviewer tally ("Codex found X; accepted Y; rejected Z because …;
   Fable …"), the plan-phase token total, any owner extras, then ENDS with exactly:
   `Plan <blob12> · scope <scopeDigest>`
   `📋 Ready to approve plan #N — say "approve"`
   Then `P summary --pr N --outcome awaiting-plan-approval --action "Read the plan, then say \"approve\""`. Issue-driven
   runs (agent-build label, owner not at the keyboard) stop here; the summary pushes the owner's phone.
6. **Owner says "approve"** → the owner-go recorder (2a) writes a `kind: "plan"` record → `P plan approve --pr N`:
   - re-reads events; the active proposal's blob must start with the record's blob prefix and match its scope digest
     (else exit 1 `superseded` / `no-approval`: re-show the request for the active proposal and wait);
   - record ≤ 24 h old, not in the future (existing UTC expiry + future-skew rules, `owner-go.mjs` ~245), this PR;
   - posts event `plan-approved`, id `<blob12>` (data in the trust model, scope + tasks COPIED from the active proposal,
     never re-read from the file);
   - checkpoints `step: build`, `tasks` = the approved event's tasks. **Task completion survives only when `specSha` is
     unchanged**; a changed task definition resets `done` (fixes `applyCheckpoint` ~260 keeping `done` by id alone).
7. Build continues from the approved tasks (`--tasks-file` stays for runs without a plan, e.g. resumed legacy runs).

**Plan amended after approval**: edit the plan, `P plan record` (new active proposal), a NEW approval request (scope diff
+ why), wait. Until approved, the gate uses the LAST APPROVED scope, so extra files show as owner-merge items; build of
new or changed tasks waits for the approval (the record's tasks stay the approved set).

### 2a. Owner-go recorder learns "approve"
`pipeline/hooks/lib/owner-go.mjs` (+ the `hooks/owner-go.mjs` context line):
- `parsePlanApproval`: prompt STARTS with `approve`/`approved` (+ optional `#N`, blob prefix ≥ 7 hex, the merge fillers);
  `?`, "don't approve", "approve later" → null.
- `presentedPlanRequests(text)`: the reply's last non-blank line is the 📋 line; the line right above it is the
  `Plan <hex12+> · scope <hex12>` line. Same terminal-block-only rule as merge (prose between, text after, or two Plan
  lines bind nothing).
- Records get `kind: "plan"`; merge records `kind: "merge"` (absent = merge, for older records). A "merge" never
  satisfies `P plan approve` and an "approve" never satisfies `P merge` (unit tests both ways).
- Each record gets a `recordId` (random 16 hex) and `promptSha256` copied into the event.

## 3. Plan reviewers and budget (D3, budget)
**Risk before review.** `P plan risk --pr N` (pure over the active proposal's scope): `high` when a scope glob can match
`risk.high_risk_paths`, a hard-stop path, a security trigger path (5), or the task text names a hard-stop rule family;
else `medium` for > 3 tasks or > `risk.medium_files` scope entries; else `low`. The controller may raise it (money,
concurrency are semantic), never lower it. Before the first review it tells the owner `Risk <level> (<reasons>).
Reviews: Codex xhigh + 1 recheck[ + Fable once]. Say "skip Fable" / "add Fable" / "skip review" to change.` and proceeds
unless the owner answers.

| risk | reviewers |
|---|---|
| low (small plan) | none: the owner's approval is the review |
| medium | Codex review + 1 recheck |
| high | Codex review + 1 recheck, then Fable once on the corrected plan |

**Reservations (R1-4).** `P plan reserve --pr N --reviewer codex|fable --key <key> [--extra "<owner words>"]` posts event
`plan-review-reserved`, id `<reviewer>-<key>`, data `{reviewer, key, planBlob, extra, at, host}`:
- **Validity by order, not by uniqueness.** After posting, the command re-lists events. For each reviewer the valid
  reservations are the first `cap + extras` untampered ones by comment id (cap: codex 2, fable 1; each `--extra` adds
  one and records the owner's words verbatim). A reservation outside that window is **void**: the command exits 1
  `cap` and the reviewer must not run. Two machines racing for the last slot: the earlier comment wins, the later one
  is void.
- **Idempotent retry.** The same `key` returns the existing reservation (no second comment).
- **One execution per reservation.** `P plan review` (Codex) posts `plan-review-started` (id `<reservation id>`) before
  launching Codex and refuses a reservation that already has one. A crash after `started` consumes the reservation;
  re-running needs a new valid reservation (within the cap or an owner extra). For Fable (a subagent the CLI cannot
  launch) the skill reserves first and puts the reservation id in the Agent tag; `P plan findings --kind fable --tag
  <tag>` refuses a transcript whose tag names no valid reservation, a reservation that already has findings, or a
  transcript older than the reservation, so skipping `reserve` buys nothing (prevention is procedural; counting is not).
**Codex plan review.** `P plan review --pr N --reservation <id> [--effort xhigh|high]` runs Codex on the active plan
(new plan prompt in `pipeline/lib/codex.mjs`: plan file + read-only repo; same `codex-findings.schema.json`) as a job.
Output `.review/plan/<reservation>.json` + markdown. Effort `xhigh` for high risk, else `high`. A recheck resumes the
first run's Codex session when one exists.
**Fable plan pass.** New agent `agents/fable-reviewer.md` (model fable, effort high, read-only; mode `plan` | `pr`).
Findings are taken from the PROVEN transcript's final text (`P model-proof` / `finalAssistantText`, as `arbiter apply`
does at `arbiter.mjs` ~208), never from a controller-written file.
**Token report (R1-8).** `run-cost.mjs` gains phase `plan` and roles `codex`, `fable`, `security`, `screenshot`. Cost
entries gain an **execution key** (`--execution <agentId | codex session | reservation id>`): booking the same execution
again REPLACES its entry (totals are derived from entries), so a retry or machine switch never double-counts; within an
execution, messages stay deduplicated per message id (existing, `run-cost.mjs` ~159). Bookings go to the draft PR's
record at once, so they persist before a machine switch; the approval request shows the plan total. No numeric ceiling.
Residual: two simultaneous writers of the record can lose one booking (last-writer-wins record; documented, display only).

## 4. Gate check `plan-scope`
New check in `pipeline/lib/finalgate.mjs`, after `integrity`, over untampered viewer-authored events:
- **approved**: latest `plan-approved` (by comment id) whose data binds to this repo/PR/branch → its `scope`. Changed
  files (the hardstops file list, base...head; for a rename BOTH old and new paths must be in scope) not matched by any
  scope glob, minus this PR's own plan file → one owner-merge item each: `plan-scope outside <file>`. None → ok.
- **none**: no plan event at all and no record `plan` field → ok:true with ONE owner-merge item `plan-scope none`
  (legacy / adopted PRs, or deleted events: never auto-merge without the owner's "merge").
- **lost** → `ok: false` (`plan-scope: lost`): a `plan-proposed` event, a record `plan` field, or a tampered/unreadable
  plan event exists, but no readable bound `plan-approved` event.
- `owner_approval: label`: `outside` / `none` items block (→ `needs-human`), as hard-stop hits do.
- `plan.required: false` (config) → the check reports only, never adds items or fails.
Items fold into `ownerItems`, so a newly outside file after the owner's "merge" needs a new stop.

## 5. PR-stage reviewers and model mix (D5, D6)
- `agents/verifier.md` → `model: haiku`; it no longer reads screenshots.
- New `agents/screenshot-reviewer.md` (model sonnet, Read/Glob): one line per `.verify/screenshots/*` image; ship Step 3.4
  dispatches it for UI changes.
- Explore lookups: ship + verify skills say "Explore with `model: haiku` for lookups". Invariant 5 is unchanged (it names
  judge/arbiter/implementer/verifier only).
- **Security review (R1-9: on by default).** `P risk` gains `security: true|false` + reasons. Default triggers: any hit of
  the database, auth and secrets hard-stop families (`R1-*`, `R2-*`, `R3-secrets`, `hardstops.mjs` header) — blocking OR
  advisory/ownerMerge. `review.security.paths` adds globs; `review.security: off` is the explicit opt-out. When true,
  round 1 dispatches new agent `agents/security-reviewer.md` (model sonnet, read-only) alongside Codex; re-dispatched in
  a later round only if the security-trigger files changed since round 1.
- **Reviewer obligations (R1-6).** `P review expect --round R --source security|fable --tag <tag>` registers an obligation
  in the round state BEFORE dispatch. `P review add --round R --source <s> --tag <tag>` runs the model proof itself
  (security: `claude-sonnet-`; fable: `claude-fable-`), takes the JSON from the proven final text, validates it against
  the findings schema and merges items with prefix `X` (security) or `F` (fable) before the judge. `roundOutcome`
  (`triage.mjs` ~293) and `reviewValidFor` treat an unmet obligation (pending, proof failed, unparsable output) as NOT
  clean, even with zero items; proof failure records `needsHuman` item `<source>-proof`. An empty proven result meets the
  obligation.
- **Final pass.** `review.final_pass: off|risky` (default `off`). With `risky` and `P risk` level high, once per PR, when a
  round's Codex output has no BLOCKING: `expect` + dispatch `fable-reviewer` (mode `pr`) + `add` before the judge.
- Arbiter unchanged. The judge triages added items like Codex items; `P triage validate` accepts the new prefixes.

## 6. Busy main → owner merges in GitHub (cp #88) — an explicit owner override (R1-5)
This exit does NOT claim GitHub's merge equals what was verified. It hands the owner a PR whose own head is fully proven,
with an honest statement of the integration evidence, and lets the owner take that risk, which they already do by hand
(eaglewatch #1512). The gate is untouched.
**Trigger (R1-P3).** The record keeps `behindBaseReturns`: a list of distinct `{headBefore, baseTip}` pairs, appended at the
source by `P merge` (its own update before `error: behind-base`) and by `P update-branch` (only when it merged the base).
On the 2nd distinct pair the skill runs **`P handoff check --pr N`** instead of a 3rd loop.
**Conditions (all, read live; any miss → today's needs-human path):**
1. Base branch protection does NOT require up-to-date branches (`required_status_checks.strict` false; unreadable = not eligible).
2. A LIVE `P final-gate` evaluation on the current head fails ONLY `pr-open: behind-base` (pause/rollback issues, labels,
   CI, review, verify report, hard-stops, plan-scope all evaluated now, not from a saved gate).
3. Owner-merge items: either none, or the owner already said "merge" for this head + item set (else the normal
   awaiting-owner-merge stop comes first).
4. `git merge-tree` of head vs base tip T: no conflicts.
5. `verify.quick` passes on the local prospective merge tree (head merged with T, in a temp worktree).
**Action.** Outcome `owner-ui-merge` (step `awaiting-owner-merge`). PR comment: head sha; T; "verified: full verify + CI
+ review on head; quick verify on head merged with main@T. NOT verified: full verify / CI on the merged tree"; main's
commits since the verified base with their files and whether any touch this PR's files (overlap is shown, not hidden);
"merge in GitHub only if you accept that; the pipeline will not merge". Summary pushes the owner. If main moves past T
the inbox shows "main moved N commits since the hand-off". When the owner merges, resume / inbox route
`merged-externally` (agent log; prod watch per `production.watch`, observe-only).
**Not the dropped 10-14 design:** that one changed what the gate accepts; this one leaves the gate alone and makes the
owner's existing manual step explicit and evidenced.

## 7. Run state, resume, inbox (R1-3)
- `STEPS` gains `plan` (first). `OUTCOMES` gains `awaiting-plan-approval` (step `plan`) and `owner-ui-merge` (step
  `awaiting-owner-merge`). `EVENT_KINDS` gains `plan-proposed`, `plan-approved`, `plan-review-reserved`,
  `plan-review-started`. Record fields `plan` (display), `behindBaseReturns`.
- **`RECORD_VERSION` → 2** for every record this version writes; older CLIs then read `unsupported` ("update the CLI"),
  not `invalid` (`resume-plan.mjs` ~165).
- **Resume derives plan state from events FIRST**, before any task/step routing (`resume-plan.mjs` ~113): if a plan
  event exists and the active proposal has no bound `plan-approved` → `enter: plan` (show its request lines again, stop;
  never approve for the owner), whatever the record's step or outcome (`stopped`, `blocked`, missing record). Tampered →
  `enter: decision` ("plan evidence tampered").
- Partial failures: event posted + checkpoint failed → events win on the next read; checkpoint written + event failed →
  the record's `plan` field without events = `lost` at the gate and `plan` on resume (re-run `P plan record`, which is
  idempotent); `plan approve` event posted + checkpoint failed → resume sees approval, routes `build`. An event write
  failure (GitHub down) exits 3 and the run stops `stopped`; nothing is assumed approved.
- `owner-ui-merge` → resume checks `merged-externally`, else stops with the same comment.
- Inbox: `waitingOn` gains `plan approval` and `owner GitHub merge`.

## 8. Config + rollout (R1-7)
```yaml
plan:
  dir: docs/plans        # where plan files live
  required: true         # default; false = plan-scope reports only
review:
  final_pass: off        # off | risky
  security:              # or `security: off`
    paths: []            # extra trigger globs (hard-stop DB/auth/secrets families trigger by default)
```
- **This PR adds NO new keys to cp's own `.claude/pipeline.yml`** (the installed CLI would reject them,
  `config.mjs` ~94, and `merge.mjs` ~45 needs valid config). Defaults give the new behaviour. Key changes, if any, go in
  a follow-up after both machines run `pipeline update`.
- Mixed versions: the owner runs `pipeline update` on BOTH machines before any new-style run; until then an older machine
  reads new records as `unsupported` and stops (no damage). The session-version hook already warns on a stale CLI.
- Rollback: reinstall the previous version; PRs with v2 records then read `unsupported` until re-update (finish or
  re-update rather than resuming them on the old CLI). Unknown event kinds are ignored by old readers.
- After update, open PRs with no plan events get one `plan-scope none` item: chat-mode repos ask for the owner's "merge"
  (already true for resumed runs); EW low-risk PRs opened before this version lose auto-merge once.

## 9. Testing
Unit (node:test, existing style):
- plan parser (sections missing/empty refused; task spec clipping; specSha);
- `plan record` push/dirty checks + idempotency; active proposal = latest; superseded approval refused;
- owner-go `approve` parsing + binding (wrong blob/scope, older reply, two Plan lines, merge↔approve cross-rejection,
  24 h expiry, future clock, UTC);
- events: fabricated by a non-viewer, edited (`updated_at`), deleted, malformed data, newer-event precedence, wrong
  repo/PR/branch binding;
- guard-git / guard-files: commands and file writes containing the event marker refused; comment DELETE refused;
  `P` itself allowed;
- reservations: cap, idempotent key, two racing reservations (order decides), `--extra`, started-twice refused, crash
  after started consumes, Fable transcript older than reservation refused;
- cost: same execution booked twice = once; new phase/roles;
- gate `plan-scope`: none / lost (each cause) / outside / inside / rename / label mode / `required: false`;
- obligations: pending, proof failed, unparsable, empty proven result = clean, zero-items-but-failed = not clean;
- `P risk` security flag defaults + `security: off`;
- handoff: each condition failing alone; overlap shown; distinct pair counting;
- record v2 + new steps/outcomes; old reader sees `unsupported`; resume `plan` routing over every record state;
  task `done` reset on specSha change; inbox strings.
- Skill lint: SKILL.md / reference files name only existing `P` commands and flags.

## Out of scope
Item 7 (Sonnet main session), inbox improvements (PR 5), cp #67, PC setup, #72 macOS CI, step-based test limits.
Every file is a cp hard-stop → the owner merges in chat; both machines run `pipeline update` after merge.
