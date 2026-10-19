# Ship redesign (redesign PR 4) — design

Status: DRAFT r4. Codex astra-xhigh R1 (9 + P3) and recheck R2 (10 + P3) folded in (r2, r3); Fable high on r3 (B1–B4,
S1–S9, X1–X4) folded in (r4). Review caps used (Codex 2, Fable 1). Next: the owner reviews this spec, then writing-plans. Owner decisions 2026-10-15 (memory `pipeline-redesign-2026-10-15`,
items 1–3, 5–7 + planning budget) and 2026-10-19 (this session) are the requirements; cp issue #88 is folded in.
Risk: **high** (pipeline core: merge gate, owner-approval recorder, run state).

## In plain English
Every ship run gets a written plan that the owner approves before any code is written. The approval is the owner's own
typed "approve", recorded on the machine where they typed it, and a copy goes on the PR so other machines can see it.
Reviewers are picked by risk (Fable only for risky work), cheaper models do the mechanical checks, and the merge gate
flags any file the PR changed that the approved plan did not list. When main is so busy that the pipeline can never
catch up, it hands the owner a green PR to merge in GitHub, saying plainly what was and was not verified.

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
  DB/auth/secrets PRs (ON by default). Sonnet main-session trial is item 7, NOT this PR.
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

## Trust model (Codex R1-1, R2-1, R2-2)
Anything on GitHub is writable with the agent's token (the owner's: `git-policy.mjs:35` allows comment mutations;
guarding marker text is whack-a-mole, Codex R2-1). So **GitHub never proves approval**. The roots are:
1. **The owner-go record** (`~/.claude/pipeline-state/owner-go`, guarded by guard-files, written only by the
   UserPromptSubmit recorder that only a typed owner prompt reaches; `owner-go.mjs` header; `notOwnerPrompt` ~143). The
   plan record binds `{v: 1, kind: "plan", pr, blob (full 40 hex), scopeDigest, recordId, promptSha256, ts, session}` to
   the reply that showed the request lines. The folder stays write-only-by-the-hook (`files-policy.mjs` ~44: no CLI
   writes it, Fable B2). Same residual as #58 (same OS user; opaque programs; the owner's token). No new residual.
2. **The plan blob in git.** The approved plan is identified by its full blob sha; its scope and tasks are always
   re-parsed from `git cat-file blob <sha>` (content-addressed: editing the file makes a different blob). Event data is
   never the source of scope or tasks.

GitHub event comments (`run-events.mjs`) are **pointers and evidence of existence** only: `plan-proposed {blob, n}`,
`plan-approved {blob, recordId, promptSha256, host}`. They let another machine know a plan exists and which blob was
approved where; they never make anything pass on their own.

**Verified vs unverified approval.** An approval is *verified* on a machine when a local owner-go plan record exists with
the same `recordId`, `promptSha256`, PR, full blob and `scopeDigest` (recomputed from the blob). Windows: `P plan approve`
accepts a record ≤ 24 h old (existing UTC + future-skew rules, `owner-go.mjs` ~245); the gate and resume accept it for 30
days from `ts` (`PLAN_RECORD_MAX_AGE_MS`; `readApprovals` filters by age and never deletes). No "consumed" marker (Fable
B2/X3): a record binds one blob + scope, so approving it twice is idempotent and a different blob never matches.
Owner-go reader (Fable S6): records stay `v: 1`; merge readers (`readApprovals`, ~244/251) skip `kind: "plan"`; a new
`readPlanApprovals` reads only plan records.
**Unverified on this machine (Fable X2):**
- build work remains (open tasks of the active plan) → resume re-shows the plan request and waits for "approve" here;
- no build work remains → no re-approval. The gate adds owner-merge item `plan-scope unverified <host>`, which sits in
  the items digest the owner's "merge" binds to; a machine switch is a resume, and invariant 9 already requires the
  owner's "merge" for resumed runs, so the owner says one word, not two.

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
   Required sections (parsed by `pipeline/lib/plan.mjs`, refused when missing):
   - `## In plain English` (2–4 sentences, reused in the approval request and the PR body).
   - `## Scope`: bullet list of backticked repo-relative paths or globs (`glob.mjs` syntax). Non-empty.
   - `### Task <id>: <title>` headings; the FULL text up to the next heading is the task definition.
     1..`LIMITS.tasks` tasks. `specSha` = sha256 of the canonical full definition (title + text, CRLF→LF, trailing space
     trimmed), computed BEFORE any clipping (Codex R2-8). The record keeps a clipped `spec` for display; implementers get
     the full text from the approved blob.
2. **Commit + push + draft PR** (Step 2's first-checkpoint PR creation moves here): commit the plan with `[skip ci]` in
   the message (Fable S9: a plan-only push must not start eaglewatch's full suite), `git push -u origin agent/<slug>`,
   `gh pr create --draft`.
3. **`P plan record --pr N --file <plan> [--request-file <file>]`** (new: `pipeline/commands/plan.mjs`; the request file
   seeds the record's `request`, which the first Step 2 checkpoint used to set, Fable S7):
   - The plan must be committed and pushed: `HEAD:<plan>` blob == the working file, `HEAD` == `origin/agent/<slug>`
     (else exit 1 `dirty` / `unpushed`).
   - Parses; prints `{blob, scopeDigest, tasks, requestLines}`.
   - **Occurrences (Codex R2-9).** If the ACTIVE proposal (latest `plan-proposed` by comment id) already has this blob,
     it is reused (a retry). Otherwise a NEW occurrence is posted, id `<blob12>-<n>` (n = 1 + number of earlier
     proposal events), so restoring an earlier blob makes it active again.
   - Checkpoints the record: `step: plan`, `plan: {path, blob, scopeDigest, state: 'proposed'}` (display only).
4. **Reviews** (section 3). Each fix commits a new revision and runs `P plan record` again.
5. **Approval request** (D1). The reply shows the plain-English summary, the full plan (or, when > 150 lines, its path +
   section list + the `## Scope` section IN FULL, Fable S4; the owner can ask for all of it), the reviewer tally ("Codex
   found X; accepted Y; rejected Z because …; Fable …"), the plan-phase token total, any owner extras, then ENDS with
   exactly (full 40-hex blob, Fable S3: a 12-hex prefix is a 48-bit target the agent could collide):
   `Plan <blob40> · scope <scopeDigest>`
   `📋 Ready to approve plan #N — say "approve"`
   Then `P summary --pr N --outcome awaiting-plan-approval --action "Read the plan, then say \"approve\""`. Issue-driven
   runs (agent-build label, owner not at the keyboard) stop here; the summary pushes the owner's phone.
6. **Owner says "approve"** → the recorder (2a) writes a `kind: "plan"` record → `P plan approve --pr N`:
   - the active proposal's blob must equal the record's full blob, and `scopeDigest` recomputed from that blob must
     equal the record's (else exit 1 `superseded` / `no-approval`: re-show the request for the active proposal);
   - record within the 24 h issuance window, this PR; idempotent (an existing `plan-approved` for this blob + recordId is
     reused);
   - posts event `plan-approved` (pointer data, trust model). **Only when `record.step === 'plan'`** (Fable B1) it also
     checkpoints `step: build` + `tasks` re-parsed from the approved blob; a re-approval later in the run (another
     machine, amend→restore) posts the event and changes nothing else, so the run never moves backwards. **Task
     completion survives only when `specSha` is unchanged**; a changed definition resets `done` (fixes
     `applyCheckpoint` ~260 keeping `done` by id alone).
7. Build continues from the approved tasks (`--tasks-file` stays for runs without a plan, e.g. resumed legacy runs).

**Plan amended after approval**: edit the plan, `P plan record` (new active occurrence), a NEW approval request (scope diff
+ why), wait. Until approved, the gate uses the LAST VERIFIED APPROVED blob (section 4) and the record's tasks stay the
approved set, so new or changed tasks are not built and extra files show as owner-merge items.

### 2a. Owner-go recorder learns "approve"
`pipeline/hooks/lib/owner-go.mjs` (+ the `hooks/owner-go.mjs` context line):
- `parsePlanApproval`: prompt STARTS with `approve`/`approved` (+ optional `#N`, blob prefix ≥ 7 hex, the merge fillers);
  `?`, "don't approve", "approve later" → null.
- `presentedPlanRequests(text)`: the reply's last non-blank line is the 📋 line; the line right above it is the
  `Plan <hex40> · scope <hex12>` line. Same terminal-block-only rule as merge (prose between, text after, or two Plan
  lines bind nothing).
- Records get `kind: "plan"`; merge records `kind: "merge"` (absent = merge, for older records). A "merge" never
  satisfies `P plan approve` and an "approve" never satisfies `P merge` (unit tests both ways). Each record gets
  `recordId` (random 16 hex) and `promptSha256`.

## 3. Plan reviewers and budget (D3, budget)
**Risk before review.** `P plan risk --pr N` (pure over the active blob's scope): `high` when a scope glob can match
`risk.high_risk_paths`, a hard-stop path, a security trigger (section 5), or the task text names a hard-stop rule family;
else `medium` for > 3 tasks or > `risk.medium_files` scope entries; else `low`. The controller may raise it (money,
concurrency are semantic), never lower it. Before the first review it tells the owner `Risk <level> (<reasons>).
Reviews: Codex xhigh + 1 recheck[ + Fable once]. Say "skip Fable" / "add Fable" / "skip review" to change.` and proceeds
unless the owner answers.

| risk | reviewers |
|---|---|
| low (small plan) | none: the owner's approval is the review |
| medium | Codex review + 1 recheck |
| high | Codex review + 1 recheck, then Fable once on the corrected plan |

**Concurrency stance (all of section 3).** One controller drives a PR at a time: `P resume plan` already refuses to
start while another host's heartbeat is fresh without the owner's confirmation (`confirm`). The rules below make a
second controller harmless for the budget (it cannot get an extra paid run counted as valid), not impossible.

**Reserve = claim, one event (Codex R1-4, R2-3; Fable X1).** Immediately before ANY launch (Codex by `P plan review`,
Fable by the controller), `P plan start --pr N --reviewer codex|fable --key <key> [--extra "<owner words>"]` posts event
`plan-review-started {reviewer, key, planBlob, extra}`, then re-lists events and decides:
- Duplicates by `key` collapse to the EARLIEST comment with that key. A retry (same key) first re-lists and posts nothing
  when the key exists; an ambiguous POST (timeout, no response) is settled the same way.
- Per reviewer, in comment-id order: a start is **valid** iff its position ≤ cap + the extras posted BEFORE it. A later
  extra never revives an earlier void start. Void ⇒ exit 1 `cap`, do not launch. `go` ⇒ launch.
- **Caps are per PR** (the whole plan stage, every blob; Fable S5): codex 2 (review + recheck), fable 1. A later
  owner-requested amendment that needs another review uses an `--extra` with the owner's words (recorded verbatim, shown
  in the approval request and the PR summary).
- A valid start is consumed even if the run then crashes; another run needs a new valid start (cap or owner extra).
**Codex plan review.** `P plan review --pr N --key <key> [--effort xhigh|high]` (runs `plan start` itself, then Codex on
the active blob with a new plan prompt in `pipeline/lib/codex.mjs`: plan file + read-only repo; same
`codex-findings.schema.json`) as a job. Output `.review/plan/<key>.json` + markdown. Effort `xhigh` for high risk,
else `high`. A recheck resumes the first run's Codex session when one exists.
**Fable plan pass.** New agent `agents/fable-reviewer.md` (model fable, effort high, read-only; mode `plan` | `pr`). The
controller runs `P plan start --reviewer fable`, then dispatches with the prompt header it prints (`ROUND: plan`,
`INPUT-DIGEST: <sha256(repo, pr, 'fable-plan', blob, key)>`). `P plan findings --key <key> --tag <tag>` proves the model
(`claude-fable-`), checks the header in the first user message (as `arbiter apply` does, `arbiter.mjs` ~199), and takes
the JSON from the proven final text; anything else is refused.
`P plan findings` also refuses a transcript older than its start event, or a key whose findings are already recorded.
**Token report (Codex R1-8, R2-5).** `run-cost.mjs` gains phase `plan` and roles `codex`, `fable`, `security`,
`screenshot`. Each booking carries a canonical **execution key**: `agent:<agentId>` (subagent transcript),
`codex:<session id>` (Codex), `ctl:<session id>:<phase>` (controller). Entries are keyed: booking the same key again
REPLACES it, and totals are derived from entries (within an execution, messages stay deduplicated per message id,
`run-cost.mjs` ~159). **Verify after write:** `P cost` re-reads the record after writing and retries (max 3) until its
entry is present, so a concurrent writer cannot silently drop it; a final failure exits 1 and the skill re-books before
the hand-off. The approval request shows the plan total. No numeric ceiling.

## 4. Gate check `plan-scope`
New check in `pipeline/lib/finalgate.mjs`, after `integrity`. Inputs: untampered viewer-authored plan events (an event
comment whose `updated_at` differs from `created_at` is **tampered**), the local owner-go plan records for this PR, and
the git objects of the approved blobs.
- **Selection (Codex R2-2).** Take the LATEST `plan-approved` event. If it is tampered or unreadable, or any plan event
  NEWER than it is tampered or unreadable, the result is **lost** (no fallback to an older approval).
- **approved + verified** (local record matches, trust model): scope = re-parsed from the approved blob. Changed files
  (the hardstops file list, base...head; for a rename BOTH old and new paths) not matched by any scope glob, minus this
  PR's own plan file → one owner-merge item each: `plan-scope outside <file>`. None → ok.
- **approved, unverified** (no matching local record: another machine, or a forged pointer) → as above PLUS one
  owner-merge item `plan-scope unverified <host>`. Never auto-merges.
- **lost** → `ok: false` (`plan-scope: lost`): selection says lost; OR a `plan-proposed` event / record `plan` field / a
  local owner-go plan record for this PR exists but no `plan-approved` event; OR the approved blob is missing from git.
- **none** → ok:true with ONE owner-merge item `plan-scope none`: no plan event, no record `plan` field and no local plan
  record. Legacy / adopted PRs, or every trace deleted on a machine that never approved: never an auto-merge.
  Residual (accepted, shown to the owner): on a machine without the local record, deleting every plan event turns
  `lost` into `none`; both stop for the owner's "merge".
- `owner_approval: label`: items block (→ `needs-human`), as hard-stop hits do. `plan.required: false` → report only.
- **Recovery from `lost`** (Fable S8): re-show the active proposal's request; a new verified `plan-approved` (newer than
  every unreadable/tampered event) clears it. The gate's detail says so.
Items fold into `ownerItems`, so a newly outside file after the owner's "merge" needs a new stop.

## 5. PR-stage reviewers and model mix (D5, D6)
- `agents/verifier.md` → `model: haiku`; it no longer reads screenshots.
- New `agents/screenshot-reviewer.md` (model sonnet, Read/Glob): one line per `.verify/screenshots/*` image; ship Step 3.4
  dispatches it for UI changes.
- Explore lookups: ship + verify skills say "Explore with `model: haiku` for lookups". Invariant 5 is unchanged.
- **Security trigger (Codex R1-9, R2-6).** `P risk` gains `security: true|false` + reasons. True when ANY of: the diff
  touches SQL or a migration (`*.sql`, `**/migrations/**`, `supabase/**`: the same "touches SQL" test `classifyHardStops`
  uses to demand SQL inputs); a hit (blocking, advisory or ownerMerge) of the `R1-*`, `R2-*` or `R3-secrets` families;
  a `review.security.paths` glob. `review.security: off` is the explicit opt-out. The plain-table migration with zero
  hard-stop hits (`hardstops.test.mjs` ~142) triggers it (acceptance case).
- **Obligations derived, not declared (Codex R1-6, R2-4, R2-7).** `P codex-review` writes `obligations` into the round
  state WHEN it creates the round, from `P risk` on the reviewed range + config: `security` (round 1, or a later round
  whose security-trigger files changed since the last met security obligation) and `fable` (final_pass `risky`, level
  high, this round's Codex output has no BLOCKING, none met earlier in the PR). The controller cannot forget one.
  Dispatch can start in parallel with Codex: the prompt header comes from `P review header --source <s> --pr N --base
  <sha> --head <sha>` (pure: `ROUND: <R>`, `INPUT-DIGEST: sha256(repo, pr, source, base, head)`), so it is known before
  the round exists. `P review add --round R --source <s> --tag <tag>` proves the model (security `claude-sonnet-`, fable
  `claude-fable-`), checks the header (round + digest of THIS round's base/head) in the first user message, takes the
  JSON from the proven final text, validates it against the findings schema and merges items with prefix `X` / `F` before
  the judge. `roundOutcome` (`triage.mjs` ~293) and `reviewValidFor` treat any unmet obligation (pending, proof failed,
  header mismatch, unparsable) as NOT clean even with zero items; a failed proof records `needsHuman` item
  `<source>-proof`. An empty proven result meets the obligation.
- Arbiter unchanged. The judge triages added items like Codex items; `P triage validate` accepts the new prefixes.

## 6. Busy main → owner merges in GitHub (cp #88) — an explicit owner override
This exit does NOT claim GitHub's merge equals what was verified. It hands the owner a PR whose own head is fully proven,
with an honest statement of the integration evidence, and lets the owner take that risk, which they already do by hand
(eaglewatch #1512). The gate is untouched.
**Trigger (Codex R1-P3, R2-10).** The record keeps `behindBaseUpdates`: distinct `{headBefore, baseTip}` pairs, appended at
the source by `P merge` (its own update before `error: behind-base`) and by `P update-branch` (only when it merged the
base). After an update the run goes through Step 5.3–5.7 for the NEW head as today (full verify, CI, review coverage,
gate). When that head's gate (or `P merge`'s live check) then fails ONLY `pr-open: behind-base` and the run already has
≥ 2 recorded updates (Fable S1: one move during a 15-min CI is routine on eaglewatch, and a 1-update trigger would make
this exit the common path and defeat low-risk auto-merge), the skill runs **`P handoff check --pr N`** BEFORE any
further update-branch, so the fully verified head is what is handed over. Fewer updates → today's loop.
**Conditions (all, read live; any miss → the existing loop / needs-human path):**
1. Base branch protection does NOT require up-to-date branches (`required_status_checks.strict` false; unreadable = not
   eligible).
2. A LIVE `P final-gate` evaluation on the current head fails ONLY `pr-open: behind-base` (pause/rollback issues, labels,
   CI, review, verify report for this head, hard-stops, plan-scope all evaluated now).
3. `git merge-tree` of head vs base tip T: no conflicts.
4. `verify.quick` passes on the local prospective merge tree (head merged with T, in a temp worktree).
Owner-merge items do not block the hand-off (Fable X4): the owner's GitHub click is the approval, and the comment lists
every item (hard-stop files, test changes, owner-ruled review items, plan-scope items) above the merge instruction.
**Action.** Outcome `owner-ui-merge` (step `awaiting-owner-merge`). PR comment:
- head sha and T;
- "verified: full verify + review on head; CI on head merged with main@<the base GitHub used at CI time> (Fable S2:
  `pull_request` checks run on the merge ref); quick verify on head merged with main@T. NOT verified: full verify / CI
  on head merged with main@T";
- main's commits since the verified base with their files and whether any touch this PR's files (overlap shown, not
  hidden);
- the owner-merge items, if any;
- **production (Fable B4):** with `production.watch: session`, nobody watches production or rolls back after a GitHub
  merge until the owner says `ship resume N` (observe-only, never rolls back); with `workflow`, the project's workflow
  posts the result as usual;
- "merge in GitHub only if you accept that; the pipeline will not merge".
Summary pushes the owner. If main moves past T the inbox shows "main moved N commits since the hand-off". When the owner
merges, resume / inbox route `merged-externally` (agent log; prod watch per `production.watch`, observe-only).
**Not the dropped 10-14 design:** that one changed what the gate accepts; this one leaves the gate alone and makes the
owner's existing manual step explicit and evidenced.

## 7. Run state, resume, inbox (Codex R1-3)
- `STEPS` gains `plan` (first). `OUTCOMES` gains `awaiting-plan-approval` (step `plan`) and `owner-ui-merge` (step
  `awaiting-owner-merge`). `EVENT_KINDS` gains `plan-proposed`, `plan-approved`, `plan-review-started`. Record fields
  `plan` (display), `behindBaseUpdates`. `RECORD_VERSION` → 2.
- **Resume derives plan state FIRST**, before any task/step routing (`resume-plan.mjs` ~113), whatever the record's step
  or outcome (`stopped`, `blocked`, missing record): plan evidence exists (event, record `plan`, or local record), the
  active proposal has no VERIFIED approval on this machine, AND build work remains (no approved plan yet, or open tasks)
  → `enter: plan` (re-show its request lines, stop; never approve for the owner). No build work left → normal routing;
  the gate's `plan-scope unverified` item covers it (trust model, X2). Tampered/lost → `enter: decision` ("plan
  evidence lost or tampered", with the recovery in section 4).
- Partial failures: event posted + checkpoint failed → events win on the next read; checkpoint written + event failed →
  `lost` at the gate, `plan` on resume (re-run `P plan record`: idempotent); `plan approve` event posted + checkpoint
  failed → resume sees the verified approval, routes `build`. An event write failure (GitHub down) exits 3 and the run
  stops `stopped`; nothing is assumed approved.
- `owner-ui-merge` → resume checks `merged-externally`, else stops with the same comment.
- Inbox (Fable B4): `waitingOn` gains `plan approval` (outcome `awaiting-plan-approval`, nextAction "read the plan, say
  \"approve\"") and `owner GitHub merge` (outcome `owner-ui-merge`, nextAction "merge in GitHub if you accept the
  hand-off", suggest `leave`, never `resume`). Both are matched in `inbox.mjs` AFTER the conflicts/CI failing-check
  branch and BEFORE the `pipeline` fallthrough (~234): a handed-off PR is behind base by definition and must not fall
  through to "resume" (which would only re-post the hand-off).

## 8. Config + rollout (Codex R1-7, R2-P3)
```yaml
plan:
  dir: docs/plans        # where plan files live
  required: true         # default; false = plan-scope reports only
review:
  final_pass: off        # off | risky
  security:              # or `security: off`
    paths: []            # extra trigger globs (SQL/migrations + DB/auth/secrets hard-stop families trigger by default)
```
- **This PR adds NO new keys to cp's own `.claude/pipeline.yml`** (the installed CLI would reject them, `config.mjs` ~94;
  `merge.mjs` ~45 needs valid config). Defaults give the new behaviour.
- **Older CLIs (Fable B3, corrects r3):** an older CLI's `resume plan` lists a v2 record as adoptable with a warning
  (`resume-plan.test.mjs` ~245), but every write is refused (`checkpoint.mjs` ~135 throws on `unsupported`), so it
  cannot take the run over. The real old-CLI hole: `P merge` with the owner's recorded "merge" skips the unchecked-record
  and ownerMerge refusals (`merge.mjs` ~85–95), and the old gate has no `plan-scope`, so an old machine could merge a v2
  run without the scope check. Installed CLIs cannot be fixed; this is a residual the owner's "merge" accepts. Rule: the
  owner runs `pipeline update` on BOTH machines before any new-style run and never says "merge" to a v2 run on an older
  CLI. The session-version hook already warns on a stale CLI; the plan-stage skill text repeats the rule.
- Rollback: reinstall the previous version and do not resume v2 runs until re-update. Old readers ignore unknown event
  kinds.
- After update, open PRs with no plan evidence get one `plan-scope none` item: chat-mode repos ask for the owner's
  "merge"; EW low-risk PRs opened before this version lose auto-merge once.

## 9. Testing
Unit (node:test, existing style):
- plan parser (sections missing/empty refused; full-text specSha before clipping; CRLF/trailing-space canonical form);
- `plan record`: push/dirty checks; retry reuses the active occurrence; A→B→A makes A active again;
- owner-go `approve` parsing + binding (wrong blob/scope, older reply, two Plan lines, merge↔approve cross-rejection,
  24 h issuance, 30-day validity, approving the same blob twice is idempotent, full 40-hex blob required, merge readers
  skip `kind: "plan"`, future clock, UTC);
- `plan approve` at step `gate` / `awaiting-owner-merge` posts the event and leaves step + tasks unchanged (B1);
- trust: a forged `plan-approved` pointer with no local record → `unverified` item; forged pointer copying a real
  recordId but another blob → unverified; edited event → tampered → lost; newer tampered event blocks fallback to an older
  approval; deleted events with a local record → lost; deleted everything elsewhere → none;
- `plan start`: duplicate key collapses before the cap; per-PR cap across blobs; extras do not revive earlier void
  starts; two racing starts (earliest wins); ambiguous POST + re-list; consumed after crash; Fable header/digest
  mismatch, transcript older than its start, and findings recorded twice refused;
- cost: same execution key twice = once; verify-after-write retry; new phase/roles;
- gate `plan-scope`: verified / unverified / lost (each cause) / none / outside / inside / rename / blob missing / label
  mode / `required: false`;
- obligations: derived at round creation; pending, proof failed, header for another head, unparsable → not clean; zero
  items + failed proof → not clean; empty proven → clean; security re-obligation when trigger files change;
- `P risk` security flag: plain-table migration (no hits) → true; R2 hit → true; `security: off` → false;
- handoff: no trigger with < 2 recorded updates; trigger only after a fully verified post-update head; each condition
  failing alone; owner-merge items listed, not blocking; overlap shown; production line per `production.watch`;
- record v2 + new steps/outcomes; resume `plan` routing over every record state, with/without a local record, with and
  without open tasks; task `done` reset on specSha change;
- inbox: `awaiting-plan-approval` → `plan approval`; `owner-ui-merge` behind base → `owner GitHub merge` + `leave`
  (never `pipeline`/resume).
- Skill lint: SKILL.md / reference files name only existing `P` commands and flags.
Integration evidence to collect during the build (Codex R2 validation gaps; not unit-testable): GitHub REST comment
listing returns a just-created comment (read-your-writes) and comment ids are monotonic within an issue; one manual
two-session run of `P plan start` with the same key.

## Out of scope
Item 7 (Sonnet main session), inbox improvements (PR 5), cp #67, PC setup, #72 macOS CI, step-based test limits.
Possible follow-up: sync owner-go plan records between Mac and PC (claude-notes) so a machine switch needs no
re-approval. Every file here is a cp hard-stop → the owner merges in chat; both machines run `pipeline update` after merge.
