# ship inbox + ship resume — plan v4 (2026-10-12)

Reviewed by Codex (gpt-6-astra, session 01a12feb…) three times: v1 (xhigh) 5 P1 + 9 P2 + P3; v2 recheck (high) 5 P1
+ 3 P2 left; v3 (high, owner-requested) 3 P1 + 4 P2 left. v4 consolidates every resolution; the log is at the end.

## Problem

The owner has 25 open PRs on eaglewatch (15 drafts, oldest 2026-09-23) and can no longer tell what each waits on.
Measured 2026-10-12: 11/25 carry any `claude-pipeline:*` comment, 3/25 a summary comment, 14/25 none. A run that
stops mid-way (terminal closed, Mac↔PC switch) cannot be picked up: resume mode handles only `awaiting-review`, and
these live on one machine: Step 2 commits and task specs, `.verify/report.json`, `.review/round-*` (incl.
`model-proof.json`), `.review/prod-before.json` (rollback target), follow-up issue identities (deduped from local
state only), the agent-log queue, detached `P job`s (they outlive the terminal). The summary comment is written only
at Step 7.

## Goals and guarantees

1. `ship inbox` (read-only): every open PR → waiting on · last activity · next action, plus a merge / resume / close
   / leave triage.
2. `ship resume <pr>`: continue a stalled run on either machine from the PR's comments + branch. Guarantee:
   **recovery from the latest durable checkpoint**; work after it that never left the machine is surfaced, never
   reset or discarded.
3. **Resume never merges on its own.** Every resumed or adopted run re-runs the Step 5 gate and stops at
   `awaiting-owner-merge`; only an owner "merge" for that exact head in that session merges. Records never count as
   approval.
4. **Resume never rolls production back.** A resumed merged run observes production and reports; rollback stays
   with the original run or the owner.
5. **Concurrency trade-off (owner decision 2026-10-12):** no exclusive lock. One person starts every session by
   hand. A display-only heartbeat plus a confirmation prompt guards accidental overlap. Under a knowing overlap,
   duplicates of follow-up/incident issues are tolerated and REPORTED (never auto-closed); irreversible git/merge
   effects stay destination-enforced (non-force push; update-branch pinned to the expected head; merge
   `--match-head-commit`); critical evidence is append-only so no writer can erase it.

## A. Run record + events — `pipeline/lib/run-record.mjs`, `pipeline/lib/run-events.mjs`, `pipeline/lib/summary-comment.mjs`

**Record** (display + routing hints, editable, last writer wins), in the summary comment:
```
<!-- claude-pipeline:summary -->
<!-- claude-pipeline:status:start --> ### Pipeline run status  (step · next · head · host · heartbeat) <!-- claude-pipeline:status:end -->
<summary sections — only after a run ended>
<!-- claude-pipeline:record:<base64(gzip(json))> -->
```
- Enums: `step` = `build | verify | pr | review | gate | awaiting-owner-merge | merge | prod-watch | ended`;
  `outcome` = null while running, else every `P summary` outcome (`merged`, `blocked`, `needs-human`,
  `awaiting-review`, `awaiting-owner-merge`) and every prod-watch outcome (`superseded`, `recovered`,
  `rollback-failed`, `changed-during-recovery`, `rollback-skipped`, `not-live`, `deploy-failed`,
  `deploy-not-observed`, `no-production`). Exhaustive outcome→step table; round-trip test per outcome.
- Fields: `v:1, repo, pr, branch, baseRef, step, outcome, next, detail, head, request (≤2 KB), tasks[{id, title,
  spec ≤1 KB, done}], verify{head, tree, mode, ok, failedStep}, round, mergeSha, inFlight{kind, host, startedAt,
  maxMinutes} | null, heartbeat{host, at}, agentLogLine, cliVersion, history[≤20]{step, head, host, at}`.
- Decode: viewer-authored comment that STARTS with the summary marker; gzip+base64, size cap, LAST marker wins,
  shape validation. Results: `ok | absent | legacy` (pipeline summary without a record: "legacy summary, pre-record
  CLI") `| unsupported` (v > 1) `| invalid`. Bound to the live PR (`repo`, `pr`, `branch`); `head` only informs.
- **One writer** `writeSummaryComment(gh, pr, {record?, sections?})`: reads the comment, keeps the part the caller
  does not supply, upserts. Used by `P summary`, `P comment --kind summary`, `P checkpoint`.

**Events** (append-only evidence, never edited, one new comment each):
`<!-- claude-pipeline:event:<kind>:<id> -->` + a one-line human sentence + `<!-- claude-pipeline:event-data:<b64gz> -->`.
Kinds: `prod-before` (repo, environment, pr, headBeforeMerge, deployment{id, sha, url}) written by `P merge`
BEFORE the merge command runs; `rollback-intent` (merge sha, failing deployment, target) written by prod-watch
immediately BEFORE it rolls back; `rollback-result` (ok, live after, verified) right after; `recovery-reported`
(incident issue url, revert PR url) after reporting. Read: viewer-authored, starts with the event marker, full REST
pagination. The editable record never holds the only copy of any of these.

## B. `P checkpoint` — `pipeline/commands/checkpoint.mjs`

```
pipeline checkpoint --pr N --step S [--next TEXT] [--detail TEXT] [--request-file F] [--tasks-file F]
                    [--task-done ID] [--verify-report] [--round R] [--repo DIR]
  -> {ok, url, record, warnings}; exit 1 {error: unpushed | behind | diverged}; 2 usage; 3 gh unavailable
```
- Refuses unless local HEAD == the PR's remote head (`gh pr view --json headRefOid`).
- Sets `heartbeat{host, at}`; `--verify-report` copies the report only when its head and tree match HEAD.
- `--tasks-file` = JSON `[{id, title, spec}]`; `--task-done ID` flips one.
- `inFlight` is written by `P merge` (kind merge, maxMinutes = 2 × merge.wait_minutes + 15), `P prod-watch` (kind
  prod-watch, production.deploy_timeout_minutes + 30) and `P update-branch` (30), and cleared by them on exit.

## C. ship skill (`skills/ship/SKILL.md` + references)

- Step 2: after the FIRST task commits → `git push -u origin agent/<slug>`, `gh pr create --draft` (body: request +
  task list), `P checkpoint --pr N --step build --request-file … --tasks-file … --task-done <first>`. Each later
  task: push + `P checkpoint --task-done`. Full verify: `P checkpoint --step verify --verify-report`.
- Step 3 edits the existing PR body; the blocked path labels the existing PR.
- Checkpoints at Step 3 (`pr`), each round end (`review --round R`), Step 5 start (`gate`), owner-merge stop
  (`awaiting-owner-merge`); Step 7 `P summary` sets `ended` + outcome.
- Review loop order (review-loop.md): `P comment --kind triage` (decided items, fingerprints) BEFORE
  `P followups create`, then the triage comment again with the issue links.
- Step 0 routes: `inbox` → **Inbox**; `resume <pr>` → **Resume mode**.

## D. Review replay

- **Published triage state is authoritative.** `P state show --pr N`: when local and published states differ, local
  is kept only if it strictly EXTENDS the published one (identical published rounds: n, toHead, contentHash and the
  full decided items); otherwise local `.review/` moves to `.review/stale-<ts>/` and the published state is
  restored. Output says `source: local | published | quarantined`.
- An unpublished (incomplete) round is discarded before it is re-run with the same number.
- **Follow-ups pending**: a published round with FOLLOW-UP items (not needsHuman) lacking `followupIssue` ⇒ resume
  routes to `followups` (replay `P followups create` from the published items, no Codex) before the gate.
- `followups create` stamps `<!-- claude-pipeline:followup pr=<N> fp=<fingerprint> -->` at the start of each issue
  body and, before creating, looks up viewer-authored `agent-suggestion` issues (open and closed) starting with that
  marker: one found ⇒ reuse; several ⇒ lowest number is canonical, the rest reported as duplicates.
- `arbiter apply` stores the model-proof summary in the round (state → triage comment); `summary` reads state
  first, files as fallback.
- Adoption: "no run record" ≠ "no review state" — recover triage state first; round 1 only when none exists.

## E. `ship resume <pr>` — `pipeline/lib/resume-plan.mjs` + `P resume plan`

```
pipeline resume list [--repo DIR]          -> awaiting-review PRs + open PRs whose record is mid-run (outcome null)
pipeline resume plan --pr N [--repo DIR]   -> {ok, pr, branch, enter, reason, record, events, heartbeat, local,
                                               autoMerge, confirm, worktree}
```
- **Local branch state**: `refs/heads/<branch>` and every worktree holding it vs the live head: `equal | ahead n |
  behind | diverged | dirty`. Never `worktree add -B`. Reuse a worktree holding the branch; else `git worktree add
  <path> <branch>` for an existing local ref; else `--no-track -b <branch> <path> origin/<branch>`. `behind` ⇒
  `git merge --ff-only`; `ahead` ⇒ push (no force) first; `diverged` / `dirty` ⇒ stop and report. Fork PRs ⇒
  `not-resumable`.
- `confirm`: heartbeat < 90 min from another host, or an `inFlight` within its maxMinutes ⇒ the skill asks the owner
  "the run on <host> (step X, <n> min ago) has stopped?" before doing anything.
- `autoMerge`: an armed auto-merge request on an open PR with no live in-flight merge ⇒ the skill disarms it
  (existing `disableAutoMerge`) and reports.
- Routing `enter` (pure, table-tested): `closed` · `ended` · `observe-prod` (merged, no terminal outcome; runs
  `prod-watch` in observe-only mode from a detached worktree of `origin/<base>` at the merge commit; a
  `rollback-intent` without `rollback-result` ⇒ report "a rollback may have been in progress" with live vs target;
  never rolls back) · `local-work` · `decision` (`needs-human`: show reason, do nothing) · `build` (tasks left; specs
  from the record) · `verify` (no passing verify for this head+tree) · `review` (no state / incomplete round /
  content changed since the last clean round) · `followups` · `gate` (every other open reviewed PR: fresh Step 5,
  then the owner-merge stop). No record ⇒ `adopt: true` (Step 3.2 checks on the real diff, request "adopted PR #N",
  then the review route).
- `prod-watch --observe-only` (new flag): same smokes and outcome detection, rollback and reporting disabled; an
  outcome that would have rolled back becomes `needs-owner` with the evidence.

## F. `P inbox` — `pipeline/commands/inbox.mjs` + pure `pipeline/lib/inbox.mjs`

```
pipeline inbox [--stale-days 14] [--merged-days 7] [--no-git] [--repo DIR]
  -> {ok, generatedAt, bases[{ref, sha}], prs[], strandedAfterMerge[], local{unpushed[], orphanWorktrees[]}}
```
Facts: one paginated GraphQL query for open PRs without comment bodies (number, title, url, isDraft, createdAt,
baseRefName, headRefName, headRefOid, isCrossRepository, labels, mergeable, autoMergeRequest, latest review
submittedAt, last commit committedDate + statusCheckRollup contexts); per PR the paginated REST comments (markers,
bodies, `updated_at`); one `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base> refs/pull/<n>/head …`
per distinct base; `git merge-tree --write-tree <baseSha> <head>` ⇒ `conflicts`, `alreadyOnBase`; canonical review
hash extended to an explicit head (agent log excluded; added to the hash-parity tests). `--no-git` / git < 2.38 /
fetch error ⇒ those facts `null`. Local worktrees and branch refs per PR branch.

CI (advisory; every merge still re-runs the real gate): for each configured `ci.required_checks` name the latest
context ⇒ `passed` only when every name has a successful (or allowed-skipped) row; any failure ⇒ `failed`; any
missing, pending or unknown ⇒ `incomplete`.

Classification precedence:
1. `nothing-left` — `alreadyOnBase` ⇒ close.
2. `running` — heartbeat < 90 min or live inFlight ⇒ leave.
3. `owner-decision` — `needs-human` (reason from our needs-human comment; in `owner_approval: chat` repos a
   hard-stop-only reason ⇒ "label-mode leftover: remove the label, then ship resume N").
4. `failing-check` — CI `failed`, `conflicts`, `pipeline-blocked`, or record verify failed for this head.
5. `review` — `awaiting-review`; content hash ≠ last reviewed; outcome not clean; follow-ups pending; or untracked
   and active ⇒ "never reviewed: ship resume N adopts it".
6. `owner-merge` — record outcome `awaiting-owner-merge`, record.head == headRefOid, not draft, CI `passed`, no
   conflicts. Otherwise ⇒ `pipeline` "re-gate: ship resume N".
7. `abandoned` — untracked (no record, no triage) and lastActivity older than stale-days ⇒ close ("no pipeline
   history, last activity <date>"); otherwise `pipeline` (stalled mid-run ⇒ "stalled on <host> since …: ship resume
   N"; draft never gated ⇒ "ship resume N").
`lastActivity` = max(last commit committedDate, every comment's `updated_at`, review submittedAt, createdAt), as
instants; label events excluded; future clamps to now; boundary inclusive. Local unpushed/dirty work overrides
`nextAction`. Stranded after merge: merged within `--merged-days`, viewer record with no terminal outcome or a
`rollback-intent` without `rollback-result`.

## G. Inbox section in the skill

`P inbox` → table (PR · title · waiting on · last activity · next action), stranded-after-merge, local work, then
the triage grouped **merge / resume / close / leave**, one reason each. Read-only. A project memory index, when the
skill knows one, is grepped for `#<N>` for extra context.

## Tasks (implementer = Sonnet, one commit each; pure logic test-first)

1. `run-record.mjs` + `run-events.mjs` + `summary-comment.mjs`; `summary` and `comment --kind summary` on the one
   writer. Tests: round trip per outcome, last marker wins, foreign-author ignored, garbage/oversize/unsupported/
   legacy, binding mismatch, writer keeps the other part both ways, events never edited, event pagination.
2. `checkpoint.mjs`; `inFlight` set/cleared by merge, prod-watch, update-branch; `prod-before` event from merge
   before the merge command. Tests: unpushed/behind/diverged refusal, tasks, verify head/tree mismatch ignored,
   inFlight cleared on every exit path.
3. prod-watch: `rollback-intent` / `rollback-result` / `recovery-reported` events; `--observe-only`. Tests: crash on
   both sides of the rollback and of each event write (intent without result is reported), observe-only never calls
   rollback / issue / revert.
4. Review replay (D). Tests: published-wins + quarantine incl. same head/hash but different decisions; incomplete
   round discarded; follow-ups pending route; marker dedupe incl. duplicates and quoted markers in foreign issues;
   crash before first creation / between creations / before links published.
5. Canonical hash with explicit head + parity scenarios.
6. `inbox.mjs` pure classifier + `commands/inbox.mjs` IO. Tests: fixture per category, precedence ties, CI
   incomplete never suggests merge, activity/time cases, REST comments > 100, fetch/merge-tree on a tmp repo,
   `--no-git`.
7. `resume-plan.mjs` + `resume plan` / widened `resume list`. Tests: routing table incl. adopt-with-triage, fork,
   ahead/behind/diverged/dirty, confirm cases, auto-merge armed, observe-prod with/without rollback-intent.
8. Skill + docs: SKILL.md, reference/pr-and-summary.md, review-loop.md, gates-and-exits.md (observe-only),
   docs/cli.md, README. `skills-commands` / `docs-facts` tests pass.
9. Full verify, PR, review loop, final Fable pass. Then, read-only: run the inbox from this branch against
   eaglewatch and give the owner the triage (nothing closed or merged).

## Out of scope (suggested follow-ups)

Automatic rollback on a resumed run; an exclusive cross-machine lock; agent-log line re-queue across machines (the
line stays in the record and lands when its machine next stages); a scheduled inbox digest; Command Centre badges.

## Review log

| Round | Finding | Resolution |
|---|---|---|
| v1 #1 P1 | resume can auto-merge | Goal 3 |
| v1 #2 P1, v2 R1–R3, R6 | lease not exclusive / fencing / run.json / reacquire | Goal 5: lease dropped (owner decision); heartbeat + confirm |
| v1 #3 P1 | rollback target lost; branch deleted | A `prod-before` event before merge; E observe-prod from a base worktree |
| v1 #4 P1 | `-B` resets unpushed work | E local branch state |
| v1 #5 P1, v2 R4, R7 | review replay | D |
| v1 #6–#10, #12–#14 | enums, writers, comment paging, hash, base fetch, abandonment, activity, task intent | A, B, F |
| v1 #11, v3 #7 | CI evidence | F CI: `passed` needs positive evidence for every required name |
| v2 R5, v3 #1–#2 | partial / overlapping rollback | Goal 4 + A events + `--observe-only` |
| v3 #3 | overlapping writers erase recovery evidence | A append-only events; record is display |
| v3 #4 | early triage leaves follow-ups uncreated | D follow-ups pending route |
| v3 #5 | concurrent duplicate issues | Goal 5 tolerate + report; D canonical lowest number |
| v3 #6 | `revert/…` violates `agent/revert-*` | resume no longer creates reverts (Goal 4) |
| v2 R8 | adoption ignores triage | D adoption |
| v2/v3 P3 | legacy wording; consolidate v3 | A `legacy`; this document |
| v3 note | queued auto-merge binding unproven | E `autoMerge`: disarm when no live in-flight merge |
