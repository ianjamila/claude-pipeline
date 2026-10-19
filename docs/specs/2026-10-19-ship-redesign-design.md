# Ship redesign (redesign PR 4) — design

Status: DRAFT for review (Codex xhigh + 1 recheck, then Fable once). Owner decisions 2026-10-15 (memory
`pipeline-redesign-2026-10-15`, items 1–3, 5–7 + planning budget) and 2026-10-19 (this session) are the requirements;
cp issue #88 is folded in. Risk: **high** (pipeline core: merge gate, owner-approval recorder, hooks, run state).

## In plain English
Every ship run gets a written plan that the owner approves before any code is written, and that approval is stored
permanently on the PR. Reviewers are picked by risk (Fable only for risky work), cheaper models do the mechanical
checks, and the merge gate flags any file the PR changed that the approved plan did not list. When main is so busy
that the pipeline can never catch up, it hands the owner a clean, green PR to merge in GitHub instead of looping.

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
  DB/auth/secrets PRs. (Sonnet main-session trial is item 7, NOT this PR.)
- D6 Fable at PR stage = arbiter only; optional `review.final_pass` Fable for risky PRs when Codex finds nothing BLOCKING
  (default off).
- D7 ship starts with a one-line route; decide silently, ask only when ambiguous.
- Planning budget = review caps (Codex review + 1 recheck, 1 Fable) + reported token use; no numeric ceiling.
- 10-19: approval word "approve"; files outside the approved scope = owner-merge items (not a hard failure); one PR.
- Fail-closed requirements carried from `docs/plans/2026-10-15-verify-speedup.md` "Not in this PR": a pre-PR plan
  identity; approved scope kept separately from later edits (re-recording must not erase a violation); approval stored
  durably (not in the disposable run record); "never had a plan" distinct from "plan lost" (fail closed); budget reserved
  BEFORE a reviewer is dispatched (idempotent on retry); token tallies deduplicated per message id (already true:
  `run-cost.mjs` ~159) and persisted before switching machines.

## Approach chosen
**Open the draft PR at the plan stage; plan facts live in append-only PR event comments.** Rejected: local-only state
(`~/.claude/pipeline-state`, not cross-machine) and commit trailers (agent-written, prove nothing). The run record stays
display + routing hints (`run-record.mjs` header); everything the gate relies on is an event (`run-events.mjs`: own
comment, created once, never edited, viewer-authored, must START with the marker).

## 1. Route line (D7) — skill prose only
ship Step 0 ends with one line: `Route: ship | brainstorm first | debug first | superpowers-only | plan + several ships`
plus a 1-clause reason. Ask only when two routes are equally plausible. "plan + several ships" = one approved plan whose
tasks the owner split into PRs for one of the rule-5 reasons; each ship run then records the SAME plan with its own scope
subset.

## 2. Plan stage (D1, D2)
New Step 1.5 between "branch" and "build" (details in a new `skills/ship/reference/plan-stage.md`; SKILL.md keeps a
short summary).

1. **Write the plan** in the worktree at `<plan.dir>/<YYYY-MM-DD>-<slug>.md` (config `plan.dir`, default `docs/plans`).
   - small (≤ ~3 files, no hard-stop path expected): 10–30 lines written by the controller.
   - medium/big: superpowers brainstorming → writing-plans (its output path is overridden to `plan.dir`).
   Required sections (parsed by `P plan record`, refused when missing):
   - `## Scope`: a bullet list of backticked repo-relative paths or globs (`glob.mjs` syntax). Non-empty.
   - `### Task <id>: <title>` headings, each followed by its acceptance criteria/tests text (→ tasks `spec`, clipped to
     `LIMITS.spec`). 1..`LIMITS.tasks` tasks.
   - `## In plain English` (2–4 sentences, reused in the approval request and the PR body).
2. **Commit + push + draft PR** (moves Step 2's first-checkpoint PR creation here): `git add <plan>`, commit,
   `git push -u origin agent/<slug>`, `gh pr create --draft`.
3. **`P plan record --pr N --file <plan>`** (new command, `pipeline/commands/plan.mjs` + pure `pipeline/lib/plan.mjs`):
   - The plan must be committed and pushed: blob sha of `HEAD:<plan>` == working file, `HEAD` == `origin/agent/<slug>`
     (else exit 1 `unpushed`/`dirty`).
   - Parses scope + tasks; computes `planId = <blob sha>`, `scopeDigest = sha256(sorted unique scope lines)[:12]`.
   - Posts event `plan-proposed`, id `<blob12>` (idempotent: an existing event with that id is reused), data
     `{path, blob, scope[], scopeDigest, tasks[], at, host}`.
   - Checkpoints the record: `step: plan`, `tasks` (from the plan), `plan: {path, blob, scopeDigest}` (display only).
   - Prints `{planId, scopeDigest, tasks, requestLines}` where `requestLines` are the two terminal lines below.
4. **Reviews** (section 3), each fix commits a new plan revision → `P plan record` again (new `plan-proposed` event;
   older ones stay).
5. **Approval request** (D1): the reply shows the plain-English summary, the full plan (or its path + section list when
   > 150 lines, with the owner able to ask for all of it), the reviewer tally ("Codex found X; accepted Y; rejected Z
   because …; Fable found …"), then ENDS with exactly:
   `Plan <blob12> · scope <scopeDigest>`
   `📋 Ready to approve plan #N — say "approve"`
   Run state: `P summary --pr N --outcome awaiting-plan-approval --action "Read the plan, then say \"approve\""`.
   Issue-driven runs (agent-build label, owner not at the keyboard) stop here; summary pushes the owner's phone.
6. **Owner says "approve"** → the owner-go recorder (section 2a) writes an approval record → `P plan approve --pr N
   --plan <blob12> --scope <scopeDigest>` checks the record (same PR, same blob prefix, same scope digest, ≤ 24 h old,
   this session) and that the matching `plan-proposed` event exists, then posts event `plan-approved`, id `<blob12>`,
   data `{path, blob, scope[], scopeDigest, ownerQuote, recordedAt, at, host}` (scope copied from the proposed event,
   never re-read from the file). Checkpoint `step: build`. Exit 1 `no-approval` → show the request again and wait.
7. Build continues as today from the plan's tasks (no separate tasks file; `--tasks-file` stays accepted for runs
   without a plan, e.g. resumed legacy runs).

**Plan amended after approval** (a task turns out to need more files): the controller edits the plan, `P plan record`,
shows a NEW approval request (diff of scope + why) and waits. Until approved, the gate uses the last APPROVED scope, so
the extra files show as owner-merge items (section 4) — re-recording never erases them.

### 2a. Owner-go recorder learns "approve"
`pipeline/hooks/lib/owner-go.mjs` (+ `hooks/owner-go.mjs` context line):
- `parseApproval` gains a sibling `parsePlanApproval`: prompt STARTS with `approve` (`approve`, `approve #N`,
  `approve <blob prefix>`, `approved`, fillers as for merge); `?`, "don't approve", "approve later" → null.
- `presentedPlanRequests(text)`: the reply's last non-blank line is the 📋 line; the line right above it is the
  `Plan <hex12+> · scope <hex12>` line. Same terminal-block-only rule as merge (prose between, or text after, binds
  nothing; two Plan lines = ambiguous = nothing).
- Records go to the same `owner-go` folder with `kind: "plan"`; merge records are `kind: "merge"` (absent = merge, for
  records written before this version). A "merge" prompt never satisfies `P plan approve` and an "approve" prompt never
  satisfies `P merge` (unit tests both ways).
- guard-files already protects the folder and the recorder (#58); no new residual beyond the documented one.

## 3. Plan reviewers and budget (D3, budget)
**Risk before review.** `P plan risk --pr N` (pure over the approved/proposed scope globs): `high` when a scope glob can
match `risk.high_risk_paths`, a blocking hard-stop path, or `review.security.paths`; else `medium` for > 3 tasks or
> `risk.medium_files` scope entries; else `low`. The controller may raise it (money, concurrency are semantic) but never
lower it. It tells the owner, BEFORE the first review: `Risk <level> (<reasons>). Reviews: Codex xhigh + 1 recheck[ +
Fable once]. Say "skip Fable" / "add Fable" / "skip review" to change.` and waits only if the owner answers; otherwise
proceeds.

Reviewer matrix:
| risk | reviewers |
|---|---|
| low (small plan) | none: the owner's approval is the review |
| medium | Codex review + 1 recheck |
| high | Codex review + 1 recheck, then Fable once on the corrected plan |

**`P plan review --pr N --kind codex|codex-recheck [--effort xhigh]`** runs Codex on the plan (new plan prompt in
`pipeline/lib/codex.mjs`: the plan file + read-only repo access, same findings schema `codex-findings.schema.json`), as a
job. Output `.review/plan/<kind>-<blob12>.json` + markdown. Effort: `xhigh` when risk is high, else `high`.
**Fable plan pass**: new agent `agents/fable-reviewer.md` (model fable, effort high, read-only tools; mode `plan` or `pr`),
dispatched with a tag, proven with `P model-proof --tag … --expect-agent-type fable-reviewer`; its findings are written
by the controller to `.review/plan/fable-<blob12>.json` via `P plan findings --kind fable --tag <tag>` (which runs the
proof itself and refuses unproven output).

**Reservation before dispatch.** `P plan reserve --pr N --reviewer codex|fable --key <key> [--extra "<owner words>"]`:
- Posts event `plan-review-reserved`, id `<reviewer>-<n>`, data `{reviewer, n, key, planBlob, extra, at, host}`.
- Idempotent: an existing reservation with the same `key` is returned, never a second one. `key` = `<reviewer>-<planBlob12>-<attempt>` chosen by the controller; a retry after a crash reuses it.
- Caps: `codex` 2 (review + recheck), `fable` 1. A reservation past the cap needs `--extra` with the owner's words
  (recorded verbatim, shown in the approval request and the PR summary). Exit 1 `cap` otherwise.
- `P plan review` / `P plan findings` refuse to run without a matching reservation (exit 1 `unreserved`).
**Token report.** Every plan reviewer's use is booked with `P cost --pr N --phase plan --role <codex|fable|controller>
…` (transcripts via `--from-transcript`, already deduplicated per message id). The record lives on the draft PR, so it
is persisted before a machine switch. The approval request and the PR summary show the plan-phase total. No numeric
ceiling.

## 4. Gate check `plan-scope`
New check in `pipeline/lib/finalgate.mjs`, after `integrity`, reading events (viewer-authored only):
- **approved**: latest `plan-approved` event (by comment id) with readable data → `scope`. Changed files (base...head,
  same list hardstops uses) not matched by any scope glob, minus always-allowed (`plan.dir/**` for this PR's plan path
  only) → one owner-merge item each: `plan-scope outside <file>`. None outside → ok.
- **none**: no `plan-proposed` and no `plan-approved` event, and the record has no `plan` → ok:true with ONE
  owner-merge item `plan-scope none` (legacy / adopted PRs never auto-merge without the owner's "merge").
- **lost**: any `plan-proposed` event, or a record `plan` field, but no readable `plan-approved` event → `ok: false`
  (`plan-scope: lost`). Unreadable event data counts as lost.
- `owner_approval: label`: items become blocking (same mapping as hard-stop hits: `needs-human`).
- Config `plan.required` (default `true` for repos on this version; `false` restores today's behaviour: the check
  reports and never adds items). Read from main's config like the rest of the gate.

The items fold into `ownerItems` (digest the owner's "merge" binds to), so a newly outside file after the owner said
"merge" needs a new stop.

## 5. PR-stage reviewers and model mix (D5, D6)
- `agents/verifier.md` → `model: haiku`. It no longer reads screenshots.
- New `agents/screenshot-reviewer.md` (model sonnet, Read/Glob only): reads `.verify/screenshots/*`, returns one line per
  image. ship Step 3.4 dispatches it for UI changes.
- Explore lookups: ship + verify skills say "Explore with `model: haiku` for lookups" (invariant 5 is unchanged: it
  names judge/arbiter/implementer/verifier only).
- **Security review.** Config `review.security: {paths: [...], rules: [...]}` (default: none = off). `P risk` gains
  `security: true|false` (+ reasons) when the diff matches. When true, round 1 dispatches new agent
  `agents/security-reviewer.md` (model sonnet, read-only) in parallel with Codex; its JSON (codex-findings schema) enters
  the round via **`P review add --round R --source security --file <json>`**: validated against the schema, ids
  prefixed `X` (e.g. `XB1`), merged into the round's items before the judge. Once per PR (round 1 only, re-run only if
  the security paths changed after round 1).
- **Final pass.** Config `review.final_pass: off|risky` (default `off`). With `risky` and `P risk` level high, when a
  round's Codex output has no BLOCKING, dispatch `fable-reviewer` (mode `pr`) once per PR before the judge; `P review add
  --round R --source fable --tag <tag>` proves Fable via the transcript (as `arbiter apply` does) and merges with prefix
  `F`. Proof failure → items `needsHuman` (same as arbiter).
- Arbiter unchanged (Fable, pinned). The judge triages added items like Codex items; `P triage validate` accepts the new
  prefixes.

## 6. Busy main → owner merges in GitHub (cp #88)
**Trigger.** The record counts behind-base returns per head lineage (`behindBaseReturns`, bumped by `P update-branch`
when it actually merged the base). The skill's "max 2 such returns, then needs-human" becomes: on the 2nd return run
**`P handoff check --pr N`**.
**Conditions (all; any miss → today's needs-human path):**
1. Branch protection on the base does NOT require up-to-date branches (`required_status_checks.strict` false, read via
   the API; unreadable = not eligible).
2. The last saved final gate for the CURRENT head passed every check except `pr-open: behind-base` and gate freshness.
3. Required CI green on the current head (live read).
4. Review `coverageValid` true for the current head.
5. `git merge-tree` of head vs current base tip: no conflicts.
6. Files changed on the base since the verified base sha ∩ files this PR changes = ∅.
7. No owner-merge items outstanding beyond ones the owner already said "merge" to for this head (otherwise the normal
   awaiting-owner-merge stop comes first).
**Action.** New outcome `owner-ui-merge` (step `awaiting-owner-merge`): PR comment lists head sha, the base commits
since the verified base (with "touch none of this PR's files"), and "merge in GitHub when it shows green; the pipeline
will not". Summary pushes the owner. The pipeline never merges, never auto-merges, never changes the gate for other
runs. When the owner merges, `ship resume N` / inbox sees `merged-externally` and closes the run (agent log; prod watch
per `production.watch`, observe-only).
**Why this is not the dropped 10-14 freshness design:** that one changed what the gate accepts; this one leaves the gate
alone and hands the merge to the owner, which the owner already does by hand (eaglewatch #1512, 2026-10-19).

## 7. Run state changes
- `STEPS` gains `plan` (first). `emptyRecord` starts at `plan` when the run has a plan, `build` otherwise.
- `OUTCOMES` gains `awaiting-plan-approval` (step `plan`, next "owner reads the plan and says \"approve\"") and
  `owner-ui-merge` (step `awaiting-owner-merge`, next "owner merges in GitHub when green").
- `EVENT_KINDS` gains `plan-proposed`, `plan-approved`, `plan-review-reserved`.
- `resume plan`: route `plan` → show the latest proposed plan's request lines again and stop (never approve on the
  owner's behalf; a `plan-approved` event for the latest blob → route `build`). `owner-ui-merge` → `merged-externally`
  check, else stop with the same comment.
- Inbox: `waitingOn` gains `plan approval` and `owner GitHub merge`.
- Record field `plan` (display), `behindBaseReturns` (int). Older records without them stay valid.

## 8. Config (all optional; unknown keys are rejected, so EW may set them only after both machines reinstall)
```yaml
plan:
  dir: docs/plans        # where plan files live
  required: true         # plan-scope gate check adds items / fails closed
review:
  final_pass: off        # off | risky
  security:
    paths: []            # globs; empty = security review off
    rules: []            # hard-stop rule names that also trigger it
```
cp's own pipeline.yml: `plan.required: true`, `review.security.paths: [pipeline/hooks/**, pipeline/lib/owner-go*, install*]`.

## 9. Error handling (fail closed)
- Event write fails (GitHub down) → the step that needs it exits 3; the run stops `stopped` with the cause; nothing is
  assumed approved.
- Record says `plan` but events unreadable → gate `lost` (fails).
- Owner-go record missing/stale/mismatched → `P plan approve` exit 1; the skill re-shows the request.
- A plan edited after approval without re-approval → gate uses the approved scope; extra files become items.

## 10. Testing
Unit (node:test, existing style): plan parser (scope/tasks/plain-English; missing sections refused); `plan record`
idempotency and push checks; owner-go `approve` parsing + binding (wrong blob, wrong scope, older reply, merge vs
approve cross-rejection, 24 h expiry); reservation caps, idempotent key, `--extra`; gate `plan-scope` none / lost /
outside / inside / label-mode / `required: false`; `P review add` schema + prefix + Fable proof failure; `P risk`
security flag; handoff conditions (each one failing alone); run-record new steps/outcomes; resume routing for `plan` and
`owner-ui-merge`; inbox waitingOn strings. Skill text: a lint test that SKILL.md references only existing `P` commands.

## Out of scope
Item 7 (Sonnet main session), inbox improvements (PR 5), cp #67, PC setup, #72 macOS CI, step-based test limits.

## Rollout
Every file is a cp hard-stop → owner merges in chat; both machines run `pipeline update` after merge. EW gets
`plan.required` defaults automatically on update (no EW config change needed); EW `review.security` keys only after
both machines reinstall. Existing open PRs (no plan events) get the single `plan-scope none` item → owner "merge" as
today for chat-mode repos; low-risk EW PRs opened before this version lose auto-merge (owner says "merge").
