# Final gate, merge and production watch — outputs and what to do

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. For commands run as jobs (`update-branch`, `merge`, `prod-watch`),
the codes below are the job's `exitCode`, and the JSON is in the `tail` (or `<jobDir>/log`); see
Invariant 8 in `SKILL.md`. `P final-gate` runs directly.

## `P final-gate --pr N`

Exit 0: every check passed and `.review/final-gate.json` was written. Exit 1: read `failed[]` and
the matching `checks[].detail`. Exit 3: GitHub unavailable: wait a minute, run it once more; still 3
⇒ stop with the PR open (nothing is lost) and tell the user.

| failed check | detail says | do |
|---|---|---|
| `pr-open` | `PR is a draft` | `gh pr ready N`, run again |
| | `behind-base: …` (the PR is behind its base) | `P update-branch --pr N` (Step 5.2), `git pull --ff-only`, re-verify (Step 5.3), a new review round if `P state outcome` says `coverageValid: false`, then run again |
| | `merge conflicts`, `PR base is …` | `needs-human` |
| | `mergeable state … not MERGEABLE` | GitHub was still computing: wait ~30 s, run again |
| | `PR head … is not the local HEAD` | `git push origin agent/<slug>` (or `git pull --ff-only`), run again |
| `labels`, `preflight` | blocking label, pause/rollback issue, protection mismatch | stop: the PR stays open; tell the user which one |
| `verify-report` | stale head, dirty tree, tree changed, steps mismatch, not `full` | commit or clean the tree, fresh `verify.full` (Step 5.3), run again |
| `hardstops` | blocking hits (report-only hits pass: the detail says `N report-only`; with `owner_approval: chat` it passes and says `N owner-merge`, and the gate output has `ownerMerge` > 0) | Step 3.5 (`needs-human`); chat mode: **Owner merges in chat** in SKILL.md |
| `integrity` | test weakening (chat mode: passes, `N owner-merge test-integrity violation(s)`, counted in `ownerMerge`) | implementer restores the tests, or `needs-human` (chat mode: **Owner merges in chat**) |
| `review` | no clean round covers the current content, or open items | Step 4 (a new round), then Step 5 again |
| `ci` | checks failing / not passing | fix the cause (new commit ⇒ Step 5.1); `required check(s) missing` ⇒ `needs-human` (the CI config is wrong) |
| `preview` | no/old smoke evidence, deployment mismatch | redo Step 5.6 on the current head |

## `P update-branch --pr N` (job)

Run in Step 5.2. It merges the base into the PR branch on GitHub (`PUT pulls/{n}/update-branch` with
`expected_head_sha`; no local push, never a force push), but only when the base tip is not part of the PR
head and re-checks; at most 3 updates. It never waits for checks (they may only start once the PR is
marked ready or labelled, Step 5.4-5.5, which is where CI is waited on); `--wait-checks` opts in, adding
the outcomes below marked *(only with `--wait-checks`)*.

| `exitCode` | JSON `outcome` | meaning → do |
|---|---|---|
| 0 | `up-to-date` | the base is part of `head`; `updated: true` = this run merged it in → `git pull --ff-only` (`pullNeeded`), re-verify, gate `head` |
| 1 | `rebase-needed` | the update conflicts → `needs-human`; a human rebases or merges by hand |
| 1 | `head-moved` | the PR head is not the one you verified, GitHub refused `expected_head_sha`, or the new head is not GitHub's merge commit of the base into your head (an external push raced it): nothing more was updated → `git fetch`, look, Step 5.1 |
| 1 | `cycle-cap` | the base kept moving (3 updates, still behind) → `needs-human` |
| 1 | `head-timeout` | GitHub accepted the update but never showed a new head → run again once, then `needs-human` |
| 1 | `checks-failed`, `checks-timeout` *(only with `--wait-checks`)* | the updated head did not get green required checks → treat as failing CI on that head |
| 1 | `not-open` | the PR is closed or merged → stop |
| 3 | GitHub unavailable | wait a minute, retry once, then stop |

## `P merge --pr N` (job)

`merge` re-runs the whole gate live and re-reads GitHub just before it merges.

| `exitCode` | JSON | meaning → do |
|---|---|---|
| 0 | `merged: true`, `mergeSha` | merged → prod-watch with `--sha <mergeSha> --pr N` |
| 0 | `mergeSha: null` + `warning` | merged, but GitHub did not name the merge commit → prod-watch with `--pr N` only (it looks the commit up) |
| 1 | `error: "gate"` | the saved gate is stale or for another head → `P final-gate --pr N` again, then merge again |
| 1 | `error: "behind-base"`, `outcome`, `head` | the base moved after the gate: merge already ran `update-branch` once on the approved head and refused (`outcome: updated`, `head` = the new head), so nothing merged on a stale tree → back to Step 5.2 (`git pull --ff-only`), re-verify, `P final-gate`, merge again. `outcome: rebase-needed` (conflict) ⇒ `needs-human`; `head-moved` ⇒ `git fetch`, re-read, Step 5.1; `cycle-cap` / `head-timeout` ⇒ Step 5.2 once more, then `needs-human` |
| 1 | `error: "live-check"`, `reasons` = `<check>: <detail>` | a check failed live: handle it like the `final-gate` table; `pr-open: behind-base:` ⇒ update the branch, re-verify, back to Step 5.2 |
| 1 | `error: "pre-merge"`, `reasons` | a label, a pause/rollback issue, a new push or a draft/closed PR appeared in the last seconds: head moved ⇒ back to Step 5; label or pause ⇒ stop and tell the user |
| 1 | no `error`, `reason` "merge command failed (exit …)" | read `commandOutput`; the PR is not merged and `autoMergeDisabled` says auto-merge was switched off: one retry after `P final-gate`, then `needs-human` |
| 1 | `reason` "not merged in time" / "could not read the PR state" | not merged, auto-merge disabled: the base probably moved or a check is pending → Step 5.2, then retry (max 2), then `needs-human` |
| 1 | `reason` "closed without merging" / "a blocker appeared while waiting" | stop; tell the user |
| 3 | `error: "production-unknown"` | no known-good production deployment found in `production.environment`: nothing merged, tell the user |
| 3 | GitHub unavailable | wait a minute, retry once, then stop |

## `P prod-watch` outcomes (job)

`ok` is true only for `merged`. For every other outcome prod-watch has already opened the issue
(and, for `recovered`, the revert PR); you only report it and write the summary. Rollback happened
only in `recovered` / `rollback-failed`.

| outcome (exit) | what happened | `summary --outcome` |
|---|---|---|
| `merged` (0), `no-production` (0) | production serves the merge and passes the smoke (or none is configured) | `merged` |
| `superseded` (1) | this merge's deployment failed the smoke, but a different healthy deployment is live; nothing rolled back | `superseded` |
| `recovered` (1) | smoke failed, production was rolled back to the known-good deployment and is healthy; revert PR (`needs-human`) + `pipeline-rollback` issue (pauses merges until the owner closes it) | `recovered` |
| `rollback-failed` (1) | the rollback did not restore a healthy production: URGENT | `rollback-failed` |
| `changed-during-recovery` (1), `rollback-skipped` (1) | the live deployment changed during recovery, or no rollback was attempted (no known-good record, provider `other`, lock): production may be unhealthy: URGENT | the outcome name |
| `not-live` (1) | the merge's deployment never went live (production kept serving an older one, e.g. never promoted after an earlier rollback); nothing rolled back | `not-live` |
| `deploy-failed` (1) | the Production deployment of the merge failed; the previous one still serves | `deploy-failed` |
| `deploy-not-observed` (3) | no successful deployment seen within `deploy_timeout_minutes`: unknown whether it is live; do NOT rerun (it would open a second issue) | `deploy-not-observed` |

Tell the user at once for every outcome except `merged`/`no-production`: say what is live now, what
was changed (rolled back or not), and which issue/PR to look at; for URGENT ones say that production
may be unhealthy right now. `--outcome` takes any short word once review state exists, so use the
outcome name from the table.
