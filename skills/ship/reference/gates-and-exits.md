# Final gate, merge and production watch — outputs and what to do

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. For commands run as jobs (`update-branch`, `merge`, `prod-watch`),
the codes below are the job's `exitCode`, and the JSON is in the `tail` (or `<jobDir>/log`); see
Invariant 8 in `SKILL.md`. `P final-gate` runs directly. `merge`, `prod-watch --pr N` and `update-branch` also show themselves in the PR's run record
(`inFlight`, cleared on exit) so another machine sees them running; no `P checkpoint` is needed around them.

## `P final-gate --pr N`

Exit 0: every check passed and `.review/final-gate.json` was written. Exit 1: read `failed[]` and
the matching `checks[].detail`. Exit 3: GitHub unavailable: wait a minute, run it once more; still 3
⇒ `P summary --pr N --outcome stopped --cause final-gate:github --action "GitHub was unreachable: re-run ship resume when it is back"`,
stop with the PR open (nothing is lost) and tell the user.

A stop on any failed check below follows "Ending a run with a PR open" in `SKILL.md`: a `needs-human` row is the
**needs-human** shape (label, comment, `P summary --outcome needs-human --action …`); the `labels` / `preflight` row is
`P summary --outcome stopped`.

| failed check | detail says | do |
|---|---|---|
| `pr-open` | `PR is a draft` | `gh pr ready N`, run again |
| | `behind-base: …` (the PR is behind its base) | `P update-branch --pr N` (Step 5.2), `git pull --ff-only`, re-verify (Step 5.3), a new review round if `P state outcome` says `coverageValid: false`, then run again |
| | `merge conflicts`, `PR base is …` | `needs-human` + `P summary --outcome needs-human --cause final-gate:pr-open --action "…"` |
| | `mergeable state … not MERGEABLE` | GitHub was still computing: wait ~30 s, run again |
| | `PR head … is not the local HEAD` | `git push origin agent/<slug>` (or `git pull --ff-only`), run again |
| `labels`, `preflight` | blocking label, pause/rollback issue, protection mismatch | `P summary --pr N --outcome stopped --cause final-gate:labels --action "<which label, issue or setting blocks the merge>"` (`--cause final-gate:preflight` for a preflight failure), stop: the PR stays open; tell the user which one |
| `verify-report` | stale head, dirty tree, tree changed, steps mismatch, not `full` | commit or clean the tree, fresh `verify.full` (Step 5.3), run again |
| | `step X was skipped; list it in verify.skippable_steps` (or `skipped without a reason`) | the owner decides whether X may be skipped: if yes they add it to `verify.skippable_steps` in `pipeline.yml` (never you); otherwise re-run `verify.full` so X really runs. A pass says `N steps: M ran, K skipped: X — <reason>`: quote the skipped steps in the PR body |
| | `ci-proof-pending:<step> (…)` | the report deferred <step> to CI (`--defer`) and the newest GitHub run for this head is queued or running: wait for it, at most `verify.ci_proof_wait_minutes` (Step 5.7), then run the gate again |
| | `ci-proof-failed:<step> (…)` | the configured GitHub job went red for this exact head: treat it like a red local step (fix cycle, new commit ⇒ back to Step 5.1); do NOT re-run it to "get a pass" on the Mac without a fix |
| | `ci-proof-missing:<step> (…)` | no usable GitHub proof: no run, a cancelled or skipped run (a draft PR), another PR or fork, a tree that is not this head's, a PR that touches `.github/**`, `.claude/pipeline.yml`, `scripts/verify*` or `verify.ci_proof_inputs`, settings the base branch does not have, or any GitHub error. Run a fresh FULL `verify.full` WITHOUT `--defer` at once (never `--only`: the gate refuses a partial report), then the gate again. Never wait on this |
| `hardstops` | blocking hits (report-only hits pass: the detail says `N report-only`; with `owner_approval: chat` it passes and says `N owner-merge`, and the gate output has `ownerMerge` > 0) | Step 3.5 (`needs-human`); chat mode: **Owner-merge approval** in SKILL.md |
| `integrity` | test weakening (chat mode: passes, `N owner-merge test-integrity violation(s)`, counted in `ownerMerge`) | implementer restores the tests, or `needs-human` (chat mode: **Owner-merge approval**) |
| `review` | no clean round covers the current content, or open items (an item the owner ruled in chat with `P triage owner-ruling` passes but the detail lists `N owner-ruled item(s), owner-merge: <id "quote">` and `ownerMerge` > 0) | Step 4 (a new round), then Step 5 again; chat mode: **Owner-merge approval** in SKILL.md |
| `ci` | checks failing / not passing | fix the cause (new commit ⇒ Step 5.1); `required check(s) missing` ⇒ `needs-human` + `P summary --outcome needs-human --cause final-gate:ci --action "…"` (the CI config is wrong) |
| `preview` | no/old smoke evidence, deployment mismatch | redo Step 5.6 on the current head |

**Chat mode (`owner_approval: chat`):** every "merge again", "retry" and "back to Step 5" in this table ends at a new `P merge`, and each
one passes the **Owner-merge approval** rule in SKILL.md first: with `ownerMerge` > 0 a retry on the SAME head needs no new
approval, but any new head (update-branch, `head-moved`, a fix commit) needs the owner's "merge" again for that sha.

## `P update-branch --pr N` (job)

Run in Step 5.2. It merges the base into the PR branch on GitHub (`PUT pulls/{n}/update-branch` with
`expected_head_sha`; no local push, never a force push), but only when the base tip is not part of the PR
head and re-checks; at most 3 updates. It never waits for checks (they may only start once the PR is
marked ready or labelled, Step 5.4-5.5, which is where CI is waited on); `--wait-checks` opts in, adding
the outcomes below marked *(only with `--wait-checks`)*.

| `exitCode` | JSON `outcome` | meaning → do |
|---|---|---|
| 0 | `up-to-date` | the base is part of `head`; `updated: true` = this run merged it in → `git pull --ff-only` (`pullNeeded`), re-verify, gate `head` |
| 1 | `rebase-needed` | the update conflicts → `needs-human` + `P summary --outcome needs-human --cause update-branch:rebase-needed --action "…"`; a human rebases or merges by hand |
| 1 | `head-moved` | the PR head is not the one you verified, GitHub refused `expected_head_sha`, or the new head is not GitHub's merge commit of the base into your head (an external push raced it): nothing more was updated → `git fetch`, look, Step 5.1 |
| 1 | `cycle-cap` | the base kept moving (3 updates, still behind) → `needs-human` + `P summary --outcome needs-human --cause update-branch:cycle-cap --action "…"` |
| 1 | `head-timeout` | GitHub accepted the update but never showed a new head → run again once, then `needs-human` + `P summary --outcome needs-human --cause update-branch:head-timeout --action "…"` |
| 1 | `checks-failed`, `checks-timeout` *(only with `--wait-checks`)* | the updated head did not get green required checks → treat as failing CI on that head |
| 1 | `not-open` | the PR is closed or merged → closed: `P summary --pr N --outcome closed`; merged elsewhere: `P summary --pr N --outcome merged-externally` (neither pushes); stop |
| 3 | GitHub unavailable | wait a minute, retry once, then `P summary --pr N --outcome stopped --cause update-branch:github --action "…"` and stop |

## `P merge --pr N` (job)

`merge` re-runs the whole gate live and re-reads GitHub just before it merges.

| `exitCode` | JSON | meaning → do |
|---|---|---|
| 0 | `merged: true`, `mergeSha` | merged → prod-watch with `--sha <mergeSha> --pr N` |
| 0 | `mergeSha: null` + `warning` | merged, but GitHub did not name the merge commit → prod-watch with `--pr N` only (it looks the commit up) |
| 1 | `error: "gate"` | the saved gate is stale or for another head → `P final-gate --pr N` again, then merge again |
| 1 | `error: "behind-base"`, `outcome`, `head` | the base moved after the gate: merge already ran `update-branch` once on the approved head and refused (`outcome: updated`, `head` = the new head), so nothing merged on a stale tree → back to Step 5.2 (`git pull --ff-only`), re-verify, `P final-gate`, merge again. `outcome: rebase-needed` (conflict) ⇒ `needs-human` + `P summary --outcome needs-human --cause merge:rebase-needed --action "…"`; `head-moved` ⇒ `git fetch`, re-read, Step 5.1; `cycle-cap` / `head-timeout` ⇒ Step 5.2 once more, then `needs-human` + `P summary --outcome needs-human --cause merge:behind-base --action "…"` |
| 1 | `error: "live-check"`, `reasons` = `<check>: <detail>` | a check failed live: handle it like the `final-gate` table; `pr-open: behind-base:` ⇒ update the branch, re-verify, back to Step 5.2 |
| 1 | `error: "pre-merge"`, `reasons` | a label, a pause/rollback issue, a new push or a draft/closed PR appeared in the last seconds: head moved ⇒ back to Step 5; label or pause ⇒ `P summary --pr N --outcome stopped --cause merge:pre-merge --action "<which label or pause issue appeared>"`, stop and tell the user |
| 1 | `error: "pre-merge"`, `reason` = "could not record the verify proof on the PR (ci-proof-used event | run record)" | for a repo with `verify.deferrable_steps`, merge records which proof each deferrable step stood on (the Mac, or GitHub run <id> attempt <n>), taken from the live gate, in an append-only `ci-proof-used` event and in the run record, before it runs the merge command, and refuses without them. Nothing merged: retry once, then `P summary --pr N --outcome stopped --cause merge:ci-proof-record --action "Merge refused: the verify proof could not be recorded on the PR"`, stop and tell the user |
| 1 | `error: "pre-merge"`, `reasons` = "could not record the rollback target on the PR (prod-before event)" | merge posts the `prod-before` event (the known-good production deployment, the only copy of the rollback target that survives this machine) before it runs the merge command, and refuses to merge without it. Nothing merged: retry once, then `P summary --pr N --outcome stopped --cause merge:prod-before --action "Merge refused: the rollback target could not be recorded on the PR"`, stop and tell the user |
| 1 | `error: "pre-merge"`, `reason` = "resumed run: the owner must say \"merge\" for this exact head (then pass …)" | the PR's run record is marked `resumed` (a run taken over by Resume mode or adopted): nothing merged. Only the owner's recorded "merge" for this exact head and item set lifts it, by re-running `P merge` with `--owner-approved-head <full head> --owner-approved-items <ownerItems>`; without it show the request (Owner-merge approval: the `Head <sha12> · items <ownerItems>` and 🔀 lines) and wait for the owner's "merge", `P summary --pr N --outcome awaiting-owner-merge --action "Say \"merge\" for head <sha12>"` (label mode: `needs-human`) and stop per Owner-merge approval → "Resumed runs" |
| 1 | `error: "pre-merge"`, `reason` = "the final gate left items for the owner (owner_approval: chat): the owner must say \"merge\" for this exact head and item set (then pass …)" | `owner_approval: chat` and the gate (from final-gate.json, or the live gate right before the merge) has `ownerMerge > 0`, without the owner's recorded "merge" for it: nothing merged. Re-run `P merge --pr N` with `--owner-approved-head <full head> --owner-approved-items <ownerItems>` once the owner said "merge"; without it show the request (Owner-merge approval: the `Head <sha12> · items <ownerItems>` and 🔀 lines) and wait for the owner's "merge", `P summary --pr N --outcome awaiting-owner-merge --action "Check the listed items, then say \"merge\" for head <sha12>"` and stop per Owner-merge approval (`> 0`) |
| 1 | `error: "pre-merge"`, `reason` = "… so the resumed-run guard cannot be checked: the owner must say \"merge\" for this exact head (then pass …)" | the PR's run record could not be read (GitHub error) or is `invalid` / `unsupported`, so it may be a resumed one: nothing merged. Retry `P merge` once (a passing GitHub blip clears it). Still refused ⇒ treat it as a resumed run: only the owner's recorded "merge" lifts it (`--owner-approved-head <full head> --owner-approved-items <ownerItems>`); without it show the request (Owner-merge approval: the `Head <sha12> · items <ownerItems>` and 🔀 lines) and wait for the owner's "merge", `P summary --pr N --outcome awaiting-owner-merge --action "Say \"merge\" for head <sha12>"` (label mode: `needs-human`) and stop |
| 1 | any of the three above with "(no owner \"merge\" is recorded for #N head … items …)" or "(--owner-approved-items is not the gate's owner-item set …)" appended | the flags were passed but the owner-go recorder holds no matching "merge" (the owner never typed it after this request, the reply before it was not the request, it is older than a day, or another head / item set / PR was shown), or the flags do not name the gate's head and `ownerItems`: nothing merged. Never retry with other flags: show the request (Owner-merge approval: the `Head <sha12> · items <ownerItems>` and 🔀 lines) and wait for the owner's "merge" |
| 1 | `error: "pre-merge"`, `reason` = "the owner items changed since the owner said \"merge\" (now …, approved …): show them and ask again" | the live gate right before the merge found another owner-item set than the one the owner approved (an item added or swapped at the same head): nothing merged. Run `P final-gate --pr N`, show the new items and show the request (Owner-merge approval: the `Head <sha12> · items <ownerItems>` and 🔀 lines) and wait for the owner's "merge" |
| 1 | no `error`, `reason` "merge command failed (exit …)" | read `commandOutput`; the PR is not merged and `autoMergeDisabled` says auto-merge was switched off: one retry after `P final-gate`, then `needs-human` + `P summary --outcome needs-human --cause merge:command-failed --action "…"` |
| 1 | `reason` "not merged in time" / "could not read the PR state" | not merged, auto-merge disabled: the base probably moved or a check is pending → Step 5.2, then retry (max 2), then `needs-human` + `P summary --outcome needs-human --cause merge:not-merged --action "…"` |
| 1 | `reason` "closed without merging" | the PR was closed: `P summary --pr N --outcome closed` (no push); stop; tell the user |
| 1 | `reason` "a blocker appeared while waiting" | `P summary --pr N --outcome stopped --cause merge:blocker --action "<the blocker named in reason>"`; stop; tell the user |
| 3 | `error: "production-unknown"` | no known-good production deployment found in `production.environment`: nothing merged → `P summary --pr N --outcome stopped --cause merge:production-unknown --action "Record a known-good production deployment"`, stop, tell the user |
| 3 | GitHub unavailable | wait a minute, retry once, then `P summary --pr N --outcome stopped --cause merge:github --action "GitHub was unreachable: re-run ship resume when it is back"` and stop |

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
| `needs-owner` (1) | only with `--observe-only`: the smoke fails on the live deployment and a normal watch would have rolled back (or ended `rollback-skipped` / `changed-during-recovery`). Nothing was changed, no issue, no label; `evidence` has the live deployment, the known-good target and the smoke failure | `needs-owner` |

`--observe-only` is what a resumed run uses after a merge: same smokes, never a rollback, issue, revert PR, label or event, and it
works from a detached worktree at the merge commit (the rollback target comes from the `prod-before` event when
`.review/prod-before.json` is missing). If its JSON has `rollbackInterrupted: {intent, liveNow}`, a rollback began (a
`rollback-intent` event) and nothing recorded how it ended: tell the owner, with the live deployment next to the target. The owner
decides; resume never rolls back. A normal `prod-watch --pr N` posts `rollback-intent` BEFORE it rolls back (if that comment cannot
be posted it does not roll back: `rollback-skipped`), then `rollback-result` and `recovery-reported`.

Tell the user at once for every outcome except `merged`/`no-production`: say what is live now, what
was changed (rolled back or not), and which issue/PR to look at; for URGENT ones say that production
may be unhealthy right now. `--outcome` takes any short word once review state exists, so use the
outcome name from the table.

A prod-watch job that exits with no `outcome` in its JSON (`error: merge-sha-unresolved`, `not-merged`, or
`deploy-check-failed`) has already pushed "Production check unfinished" itself. Write
`P summary --pr N --outcome prod-unknown --cause prod-watch:<error>` (classified, pushes nothing, so the owner
gets one push, not two), tell the user to check production by hand, and do not rerun prod-watch.
