---
name: ship
description: Use for ANY request to build, add, implement, fix, change, refactor, or ship code in a git repository — features, bug fixes, UI tweaks, migrations, "make X do Y", "can you add…", "fix the bug where…". Runs the autonomous pipeline end to end — branch, implement with tests, full verify, pull request, cross-model review loop (Codex → judge → arbiter), final gate, merge, production smoke, rollback, summary — so changes reach production only when proven. Repos without .claude/pipeline.yml never merge; offer pipeline-setup.
when_to_use: Any code-changing request in a repo, unless the session was started with PIPELINE_OFF=1 or the user says not to use the pipeline. Also "resume pipeline reviews", "ship it", "/ship", "promote agent-suggestion", issues labelled agent-build, "ship inbox", "what is each PR waiting on", "ship resume <pr>", "pick up a stalled run".
argument-hint: "[what to build] | inbox | resume <pr>"
---

# ship — autonomous build → verify → review → merge

You are the **controller**. You orchestrate; subagents and the `pipeline` CLI do the work.
`P` below means `node ~/.claude/pipeline/bin/pipeline.mjs` (type it exactly like that so the
permission allowlist matches). Every `P` command prints one JSON object; exit codes: 0 ok,
1 check failed/blocked, 2 usage/env error, 3 dependency unavailable. `N` is the pull request
number, `R` a review round number, `<slug>` the branch slug.

## Invariants (never break these)

1. Nothing merges except through `P merge`, and only after `P final-gate` passed for the exact
   head being merged. Never run `gh pr merge`, `npm run merge`, or the GitHub UI yourself.
2. Never push to `main`/`master`, never force-push, never add `human-approved` /
   `test-change-approved`, never remove `needs-human` / `pipeline-blocked` / `pipeline-pause` /
   `pipeline-rollback` labels, never close pause/rollback issues. `awaiting-review` comes off only
   through `P review-complete` (Resume mode), never by hand. (Hooks also block these; don't try to
   route around them.) Always push with an explicit name: `git push -u origin agent/<slug>`.
3. Hard-stops are decided by `P hardstops`, never by your judgment. A BLOCKING hit (`blocking` array, i.e.
   `ok: false`) means the PR ends in `needs-human`, however harmless it looks. Report-only hits (`advisory`
   array: rules the project downgraded in `hard_stops.report_only_rules` / `report_only_paths`) never stop the
   PR and never need `human-approved`; list them in the PR body.
   **`owner_approval: chat`** (`P config`): blocking hits come back inside `advisory` with `ownerMerge: true` and
   `ok` is true, so they do not end in `needs-human`: see **Owner-merge approval** below. `owner_approval: label` (the
   default) is everything above, unchanged.
4. No cross-model review ⇒ no merge. Codex unavailable ⇒ `awaiting-review`, `P summary --outcome awaiting-review`, stop.
5. **Never pass a `model` parameter when invoking `judge` or `arbiter`** — a per-call model
   overrides their pinned Opus/Fable (only exception: the proof switch in
   `reference/proof-switches.md`). Don't pass one to `implementer` or `verifier` either: their agent
   files already pin Sonnet.
6. Keep your own context lean: work from `P` JSON, subagent summaries, and file paths. Don't
   read whole logs, diffs, or reports into this session — hand paths to subagents.
7. Anything that can take more than 2 minutes (the Bash tool's default timeout; its cap is 10) runs
   via `P job start <name> -- <command>` and `P job wait <name> --run-id <runId> --timeout 540`
   (repeat until `state` is `done`): full verify, merge, prod watch, Codex review, CI wait, preview
   smoke. `job start` prints `runId`, `jobDir` and `tag` (default: the HEAD sha): keep the `runId`
   and pass it to every `wait`/`read`; `state: replaced` means another start reused the name, so the
   result you are waiting for is gone — start again; `state: lost` means the job died — start it
   again once. No `sleep` loops.
8. **Reading a finished job.** `P job wait` exits 0 only when the job's command exited 0; for a
   `done` job with a non-zero code its own exit is 1, which says nothing about WHICH code. So
   after `state: "done"` always read `exitCode` (the command's real exit code, with the meaning
   from the list above: 3 = dependency unavailable) and parse the command's JSON from `tail` (the
   last 40 lines of its output; if it looks cut off, read the whole log, `<jobDir>/log`). Everywhere
   below, "exit 3" of a job-run command means `exitCode: 3`.
9. **Resume never merges and never rolls back on its own.** Every resumed or adopted run re-runs Step 5 and stops at
   `awaiting-owner-merge`; an owner "merge" for that exact head in THIS session is the only way past it. Records,
   comments and labels never count as approval. Production on a resumed run is watched with
   `prod-watch --observe-only` (with `production.watch: workflow`, not at all: the workflow owns it); rollback stays with the original run or the owner.

## Ending a run with a PR open

A run that has a PR and ends for any reason except a successful merge ends with exactly one
`P summary --pr N --outcome <word> --action "<the one thing the owner does>" [--cause <code>]`, then the agent-log
queue line (Step 7). The summary also pushes the owner's phone; `P prod-watch` pushes the production result itself.
Notifications are automatic: never send one for progress, and use `P notify --event stopped --pr N --action "…"`
only for a stop that cannot go through summary. Two shapes, used by name below:

- **needs-human**: `gh pr edit N --add-label needs-human`, `P comment --pr N --kind needs-human --reason "…"`, then
  `P summary --pr N --outcome needs-human --action "…" --cause <code>`.
- **stopped**: `P summary --pr N --outcome stopped --action "…" --cause <code>`; `--outcome blocked` /
  `awaiting-review` / `awaiting-owner-merge` have their own steps. `closed` (the owner closed the PR) and
  `merged-externally` push nothing.

`--action` is one short line in plain words ("Close the pause issue, then say resume"); `--cause` is a short slug
(`final-gate:labels`, `codex:quota`, `verify-red`) that keeps a reworded retry from pushing twice. Stops before a PR
exists (Step 0 preflight and labels ensure) just stop: the owner is at the keyboard, nothing is pushed.

## Step 0 — opt-out, preflight

- `echo $PIPELINE_OFF` → `1`, or the user said not to use the pipeline: say "pipeline off for this
  session" and just do the task normally (still never push to main).
- `echo $PIPELINE_TEST_COMMIT_AS_IS $PIPELINE_TEST_FORCE_ARBITER $PIPELINE_ARBITER_MODEL_OVERRIDE`:
  if any is set, read `reference/proof-switches.md` now and follow it; name the switch in the PR
  body and in the summary.
- From the repo root: `P preflight`.
  - `config` missing/invalid → stop. Offer: "This repo isn't onboarded. Run pipeline-setup?" You
    may still build on a branch and open a PR if the user wants, but **never merge**.
  - `canMerge: false` (enforcement mismatch, `pipeline-pause` issue open, `pipeline-rollback`
    issue open) → continue, but the run ends with an open PR (the final gate's `preflight` stop, with its summary); say why up front.
  - `codex.available: false` → warn: "Codex is unavailable; the PR will wait in awaiting-review."
  - `clean: false` in the main checkout is fine — you work in a new worktree.
- `P config` once: note `verify.full`, `verify.quick`, `default_branch`, `worktree_dir`, whether
  `preview` is `null`, and `merge`/`production`. Config `warnings` are advice: mention them.
- `P labels ensure` (idempotent; later steps use `pipeline-blocked`, `needs-human`,
  `awaiting-review`). Exit 3 ⇒ GitHub is unreachable: say so and stop.
- `P worktrees prune --notify` (skip it for `ship inbox`, which is read-only) removes worktrees whose PR merged ≥ 24h ago
  (only when `worktrees.mode: on`; otherwise it reports). Read `summary` (or `skipped`); never act on `kept` yourself.
- `inbox` argument ("ship inbox", "what is each PR waiting on") → **Inbox** below (read-only; skip Steps 1–7).
- `resume <pr>` argument or "resume pipeline reviews" → **Resume mode** below.

## Step 1 — branch

```
git fetch origin <default_branch>
git worktree add --no-track -b agent/<slug> <worktree_dir>/agent-<slug> origin/<default_branch>
```
`--no-track` matters: a branch tracking `origin/main` can make a bare `git push` target main. `<slug>`: 2–5 lowercase words from the request. All later work happens in that worktree; tell
every subagent its absolute path. Estimate risk from the paths you expect to touch (final risk
comes from `P risk` on the real diff; the higher wins).

Then `P worktrees keep agent-<slug> --reason "ship run agent-<slug>"` so no cleanup removes the worktree while this run uses it.
The run id in the reason is the worktree's directory name (no PR exists yet); Step 7 and Resume step 3 use the same id.
`keep` / `unkeep` exiting 2 with `no-such-worktree` (the worktree is not a direct child of `worktree_dir`) is a warning:
note it in the summary and carry on, never stop the run for it.

## Step 2 — build and verify

1. Split the work into small tasks. For each, dispatch the **implementer** agent with: the task,
   worktree path, acceptance criteria, which tests to write (bug fix ⇒ failing test first), the
   quick-verify command (`verify.quick`), and the **commit trailer**: the attribution line your
   system context prescribes for commits (`Co-Authored-By: …`); pass it verbatim every time so
   every commit ends with it. Independent tasks may run in parallel only if they touch different
   files.
   **Checkpoints** (so another machine can continue; detail in `reference/pr-and-summary.md`). When the FIRST task
   commits: `git push -u origin agent/<slug>`, `gh pr create --draft --title "<title>" --body-file <file>` (body: the
   request + the task list; ignore `ci.draft_while_iterating` here, Step 5.5 readies it), then
   `P checkpoint --pr N --step build --request-file <file> --tasks-file <file> --task-done <first id>`. The tasks file
   is JSON `[{id, title, spec}]`, `spec` = acceptance criteria + the tests to write. After each later task: push, then
   `P checkpoint --pr N --step build --task-done <id>`. A `checkpoint` exit 1 `unpushed` ⇒ `git push`; `behind` ⇒
   `git pull --ff-only`; `diverged` ⇒ stop and report; then checkpoint again.
2. Dispatch the **verifier** with `verify.full` (from `P config`). Green ⇒ `P checkpoint --pr N --step verify
   --verify-report`, then Step 3.
3. Red ⇒ dispatch an implementer with the failing step + excerpt (paths, not logs). Max **3 fix
   cycles**. Still red ⇒ stop early, in this order:
   ```
   git push origin agent/<slug>
   gh pr edit N --add-label pipeline-blocked --body-file <body file>
   P comment --pr N --kind blocked
   P summary --pr N --outcome blocked --cause verify-red --action "Read the blocked comment: verify stays red after 3 fixes" --built "<what was attempted and where it stuck>"
   P agent-log queue --line "<agentLogLine from the summary output>"
   ```
   (The PR exists since the first checkpoint: label it, no second `gh pr create`. `blocked` works without review
   state; the PR body carries the verify report table.) Stop.

## Step 3 — pull request

1. `git push origin agent/<slug>` (the PR exists since Step 2).
2. Run the deterministic checks on the real diff (`mkdir -p .review` first). Save the hard-stop JSON to a
   file (exit 1 means blocking hits, which is expected; exit 0 with a non-empty `advisory` means report-only):
   `P risk --base origin/<default_branch> --head HEAD`,
   `P hardstops --base origin/<default_branch> --head HEAD > .review/hardstops.json`,
   `P integrity --base origin/<default_branch> --head HEAD`.
   Test-integrity violations: have an implementer restore the tests; if the change truly needs
   them gone, treat it like a hard-stop (`needs-human`: only the owner adds `test-change-approved`). With
   `owner_approval: chat` they come back as `ok: true` with the violations under `ownerMerge`: restore the tests
   if you can, else keep them as owner-merge items (see **Owner-merge approval**).
3. `gh pr edit N --body-file <file>` with the body from
   `reference/pr-and-summary.md`: in plain English (first), what & why, verify summary (step table + head sha), tests added,
   screenshots, risk level + reasons, hard-stop hits (blocking, and report-only under their own heading). Keep it
   a draft (Step 5.5 readies it). End the step with `P checkpoint --pr N --step pr`.
4. UI change ⇒ `P artifacts push --pr N --dir .verify/screenshots`
   (pushes the images to the `pipeline-artifacts` branch, never your worktree; returns markdown
   image links), then update the PR body with them (`gh pr edit N --body-file <file>`).
5. BLOCKING hard-stop hits (`blocking` non-empty; report-only hits alone do not count) ⇒ `gh pr edit N --add-label needs-human` and post
   `P comment --pr N --kind needs-human --reason "<one paragraph: why, what was verified, what the owner does>" --hits-file .review/hardstops.json`.
   Then still run the review loop (Step 4) so the owner gets a reviewed PR, but skip Steps 5–6
   (no merge). End with `P summary --pr N --outcome needs-human --action "…" --cause hard-stop`.
   `owner_approval: chat`: when `ownerMerge` (from `P hardstops` or `P integrity`) is non-empty instead, do NOT
   add `needs-human`; list the items in the PR body under "Owner merges in chat" and carry on with Steps 4–5; the **Owner-merge approval** rule gates the merge.

## Step 4 — review loop

Follow `reference/review-loop.md` exactly. In short, per round `R` (max `review.max_rounds`):
Codex (`P codex-review --pr N --round R …` as a job; light lane with nothing but WORTH CONSIDERING items ⇒
`P triage light-lane --round R` and skip the judge) → judge (`judge` agent, no model param, only
for items without a ruling yet; `P triage validate --round R --from-tag "pipeline-judge R<R> <d8>"`)
→ settle disputed bugs with tests (implementer commits the test; `P triage settle … --test-cmd …
--test-file …` runs it) → arbiter if `P arbiter needed` says so (`arbiter` agent, no model param,
one batched call; its prompt starts with the `promptHeader` from `P arbiter needed`, pasted verbatim) → `P arbiter apply --round R --tag "pipeline-arbiter R<R> <digest8>"` (proves
Fable from the subagent transcript; the tag is the Agent call's description) → implement ACCEPTED
items (implementer + verifier full verify) → `P followups create --round R` for FOLLOW-UP →
`P comment --pr N --kind triage`. After each round: `P checkpoint --pr N --step review --round R`. Exit when
`P state outcome` says `clean`. Order and replay traps (triage comment BEFORE `followups create`, `P state
discard-round` for an interrupted round): `reference/review-loop.md`. Not clean after the
last round, or any item `needsHuman` ⇒ label `needs-human`, post
`P comment --pr N --kind needs-human --reason "…"` (no `--hits-file`),
`P summary --pr N --outcome needs-human --action "…" --cause review:<reason>`, stop. With `owner_approval: chat` and items still `needsHuman`, that
summary's `--action` is "Rule on <ids> in chat (accept / follow-up / reject), remove needs-human, then say ship resume N"; when the owner
rules in chat, record it with `P triage owner-ruling` (**Owner rules in chat** in `reference/review-loop.md`).

Codex `exitCode: 3` at any point (Codex unavailable) ⇒ `gh pr edit N --add-label awaiting-review`,
`P comment --pr N --kind awaiting-review --reason "<reason from the JSON>"`,
`P summary --pr N --outcome awaiting-review --cause codex:<reason> --action "Say \"resume pipeline reviews\" when Codex is back" --built "<what is done>"` (works even in round 1, when no
review state exists yet), `P agent-log queue --line "<agentLogLine>"`, stop.

## Step 5 — final gate

Details and every exit code: `reference/gates-and-exits.md`. First: `P checkpoint --pr N --step gate`.

1. Recompute the checks on the head as it is NOW (review fixes may have moved risk): `P risk`,
   `P hardstops … > .review/hardstops.json` and `P integrity`, as in Step 3.2. A new blocking
   hard-stop hit ⇒ Step 3.5. Then, only when `production.watch` is `workflow` (read it from `P config`), `P agent-log close
   --queue` (queues the production results the workflow posted on earlier merged PRs; exit 1 = some PRs could not be read: still run `agent-log stage` and name them in the summary; exit 3 = GitHub unavailable: skip the close, still stage); then `P agent-log stage --pr N`
   (commits this run's log line + queued lines into the PR branch) and `git push origin agent/<slug>`.
2. Up to date with the base — docs-only and light-lane PRs too, so the gate (and the CI it waits on)
   judges the tree that will land: `P job start update -- node ~/.claude/pipeline/bin/pipeline.mjs
   update-branch --pr N` → `P job wait update --run-id <runId> --timeout 540` (repeat until `done`).
   It asks GitHub to merge the base into the PR branch only when the base tip is not part of the PR
   head (pinned to the head you just pushed; never a force push) and repeats at most 3 times if the
   base keeps moving. It does NOT wait for checks (they may not start until the PR is ready or
   labelled, 5.4-5.5): the CI wait in 5.5 and the gate in 5.7 judge the new head. Read `exitCode` and
   the JSON in `tail`:
   - 0 `up-to-date` ⇒ if `pullNeeded`, `git pull --ff-only` (the gate now names `head`; 5.3 onward re-verifies it).
   - 1 `rebase-needed` (the update conflicts) or `cycle-cap` ⇒ **needs-human** (`--cause update-branch:<outcome>`,
     `--action "Rebase or merge the base into the branch by hand"`), stop after the summary.
   - 1 `head-moved` (someone pushed since you verified, or the new head is not GitHub's merge commit; nothing more
     was updated) ⇒ `git fetch`, look at what landed, back to 5.1.
   - 1 `head-timeout` ⇒ run it once more, then **needs-human** (`--cause update-branch:head-timeout`).
   - 1 `not-open` ⇒ PR closed: `P summary --pr N --outcome closed`; PR merged elsewhere: `P summary --pr N --outcome
     merged-externally`. Neither pushes. Stop.
   - 3 ⇒ GitHub unavailable: retry once; still 3 ⇒ `P summary --pr N --outcome stopped --cause update-branch:github
     --action "GitHub was unreachable: re-run ship resume when it is back"`, stop.
3. Verifier: fresh `verify.full` on the current head (must be clean, full mode). Then
   `P state outcome`: if `coverageValid` is `false` the PR content changed since the last clean
   review round (an update-branch, a late fix) ⇒ go back to Step 4 for a new round, then return here.
4. High risk (from the Step 5.1 `P risk`) ⇒ `gh pr edit N --add-label <ci.e2e_label>` (if configured).
5. Draft ⇒ `gh pr ready N`. Wait for CI on this head: checks can take a few seconds to appear after
   a push (`gh pr checks --watch` then exits 1 "no checks reported"), so poll first:
   `P job start ci -- bash -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do gh pr checks N --required >/dev/null 2>&1; [ $? -ne 1 ] && break; sleep 10; done; gh pr checks N --watch --required'`
   → `P job wait ci --run-id <runId> --timeout 540` (repeat until `done`). The job's exit code is
   only a hint: `P final-gate` re-reads CI itself.
6. Preview — skip this step when `preview` is `null` in `P config`. Otherwise, with the FULL
   40-character head sha (`git rev-parse HEAD`; an abbreviation just waits out the timeout):
   `P deploy url --sha <head> --environment <preview.environment> --timeout 480` (its default wait
   is 900 s, longer than the Bash tool allows: keep `--timeout` ≤ 480, or run it as a job). Exit 3
   ⇒ nothing deployed in time: run it once more, then **needs-human** (`--cause deploy-url`, `--action "Check why the
   preview did not deploy"`), stop after the summary. Exit 1 ⇒ the deployment failed:
   fix the cause (new commit ⇒ back to 5.1). Then, as a job (it can run 5 minutes):
   `P job start smoke -- node ~/.claude/pipeline/bin/pipeline.mjs smoke --target preview --url <url> --sha <head>`
   (UI-text changes: add `--expect-text "<new text>"`) → `P job wait smoke …`; read `exitCode`.
7. `P final-gate --pr N`. Any failed check ⇒ fix the cause (a new commit ⇒ back to 5.1; PR
   content changed ⇒ Step 4 too) or, if it isn't fixable by you, stop: **needs-human** (`--cause final-gate:<check>`) after the summary; for the
   `labels` / `preflight` failures use `P summary --pr N --outcome stopped --cause final-gate:<check> --action "<which
   label, issue or setting blocks the merge>"` (details in `reference/gates-and-exits.md`).
   `behind-base:` in the `pr-open` detail (main moved since 5.2) ⇒ Step 5.2, then 5.3 onward.

## Step 6 — merge and production

**Every `P merge` attempt (the first, a retry, one after an update-branch or a new head) first passes the
**Owner-merge approval** rule below.** With `owner_approval: label` its `ownerMerge` count rule is a no-op, but its
resumed-run rule is not: a run in Resume mode or on an adopted PR never calls `P merge` without the owner's "merge"
(`P merge` itself refuses a resumed record, or one it cannot check, without `--owner-approved-head`). `P merge`,
`P prod-watch --pr N` and `P update-branch` keep the record's in-flight marker themselves (no checkpoint needed around
them). `P merge` posts the `prod-before` event before merging and refuses (`error: pre-merge`, nothing merged) when it
cannot: see `reference/gates-and-exits.md`.

1. `P job start merge -- node ~/.claude/pipeline/bin/pipeline.mjs merge --pr N` (a resumed run adds `--owner-approved-head <sha>`, see below) → `P job wait
   merge --run-id <runId> --timeout 540`; read `exitCode` and the JSON in `tail`:
   - 0 ⇒ merged. `mergeSha` is the merge commit; `null` (with a `warning`) means GitHub did not
     name it yet: still run prod-watch, with `--pr N` alone (2 below). Never skip prod-watch unless `production.watch` is `workflow` (2 below).
   - 1 ⇒ NOT merged. `error: gate | behind-base | live-check | pre-merge`, or a `reason` (merge command failed,
     not merged in time, PR closed, blocker appeared): act per `reference/gates-and-exits.md`.
     "Update the branch" cases (`error: behind-base` — merge already updated the branch itself, or could not
     (`outcome`: `rebase-needed` ⇒ **needs-human**, `--cause merge:rebase-needed`) — or `behind-base:` in a live
     check) ⇒ back to Step 5.2, re-verify, a new review round if content changed; max 2 such returns, then
     **needs-human** (`--cause merge:behind-base`).
   - 3 ⇒ `error: production-unknown` (no known-good production deployment recorded) or GitHub
     unavailable: nothing merged; wait a minute and retry once, then
     `P summary --pr N --outcome stopped --cause merge:production-unknown|merge:github --action "<record a known-good
     production deployment | re-run ship resume when GitHub is back>"`, stop, and tell the user.
2. Merged with `production.watch: workflow` (`P config`; the default is `session`) ⇒ do NOT run prod-watch: a CI workflow of
   the project smokes production and posts the result on the merged PR, and nothing is rolled back. prod-watch is what
   sends the production push, so here no production push is sent: the workflow owns that result. Summary outcome
   `merged` (it pushes nothing); tell the user the workflow posts the production result on the PR and never rolls back (a later ship run
   copies it into the agent log, Step 5.1). Otherwise merged ⇒ `P job start prod -- node ~/.claude/pipeline/bin/pipeline.mjs prod-watch --sha
   <mergeSha> --pr N [--expect-text …]` (no `mergeSha`: `prod-watch --pr N`, it reads the merge
   commit itself) → `P job wait prod --run-id <runId> --timeout 540`. `--expect-text` must be text
   the NEW build shows: smokes of a rolled-back or superseded deployment ignore it. Read the
   `outcome` in the JSON (`exitCode` 0 = `merged`). `merged` / `no-production` ⇒ summary `merged`; every
   other outcome — `superseded`, `recovered`, `rollback-failed`, `changed-during-recovery`,
   `rollback-skipped`, `not-live`, `deploy-failed`, `deploy-not-observed` — ⇒ summary with that same word
   (no push: prod-watch sent it). A prod-watch job that exits with no `outcome` in its JSON (`error`
   `merge-sha-unresolved`, `not-merged`, `deploy-check-failed`) has already pushed "Production check unfinished": write
   `P summary --pr N --outcome prod-unknown --cause prod-watch:<error>` (it pushes nothing) and tell the user to
   check production by hand; do not rerun it.
   What each one means and what to do is in `reference/gates-and-exits.md`. On a failed smoke prod-watch rolls back by itself (`vercel rollback <known-good> --yes --timeout 3m`,
   never `production.rollback.command`), opens the issue and a revert PR. Report any outcome other
   than `merged` to the user immediately, in plain words.

## Owner-merge approval (`owner_approval: chat`) — applies to EVERY merge attempt

**Resumed runs, in both modes:** a run in Resume mode or on an adopted PR (its run record carries `resumed`) never calls
`P merge` without the owner's "merge" for that exact head in this session, whatever `ownerMerge` says and in `label` mode
too. Without it, STOP: `chat` ⇒ `P checkpoint --pr N --step awaiting-owner-merge`, `P summary --pr N --outcome
awaiting-owner-merge --built "…"`, and the reply's last two lines below (items may be none); `label` ⇒ add `needs-human`,
`P comment --pr N --kind needs-human --reason "resumed run: the owner merges"`, `P summary --pr N --outcome needs-human
--built "…"`. When the owner says "merge" for that head, run `P merge --pr N --owner-approved-head <sha>` (the full 40-character
head the gate covered; any other head is refused).

Owner-merge items are hard-stop hits or test-integrity violations that `label` mode would block. Immediately before
each `P merge`, take the `ownerMerge` count of the `P final-gate --pr N` that covers the head you are about to merge:
- `0` ⇒ merge as usual.
- `> 0` (also review items the owner ruled in chat with `P triage owner-ruling`: the gate's `review` detail lists their ids and the
  owner's quotes; show them in the stop comment) ⇒ merge ONLY if the owner said "merge" in THIS session for exactly this head sha and no owner-merge item beyond
  the ones shown to them. A "merge" given for an earlier head never carries over: a new commit, an update-branch, a rebase or
  a retry after a head change (Step 5.2, a `behind-base` return, a refreshed gate) needs a new stop. If there is no such
  approval, STOP:
  1. Post one comment: `gh pr comment N --body "<each item: rule, file, one-line why; head <sha7>; the owner merges by saying \"merge\" in chat>"`.
  2. `P checkpoint --pr N --step awaiting-owner-merge`, then `P summary --pr N --outcome awaiting-owner-merge --action "Check the listed items, then say \"merge\" for head <sha7>" --built "…"`, queue the agent-log line (Step 7), end the run with
     outcome `awaiting-owner-merge`, keep the worktree. The reply's LAST two lines are exactly (7 = the first 7 characters of the head):
     `Head <sha7>`
     `🔀 Ready to merge #N — say "merge"`
- When the owner then says "merge" and the head and items are unchanged, run Step 6 (final gate again if the base moved,
  `P merge`, prod-watch, rollback handling). If the head changed or new items appeared after they said "merge",
  show the updated items and the new head and stop again, with a new `awaiting-owner-merge` summary for that head.
The owner's chat message is the approval; never add an approval label yourself (invariant 2).

## Step 7 — summary

`P summary --pr N --outcome <outcome> --action "<the one thing the owner does>" --built "<2–3 sentences>"` posts the summary comment
(outliers first) and prints `agentLogLine`. Queue that line — `P agent-log queue --line
"<agentLogLine>"` — for every outcome except a clean `merged` (that run's line was staged in
Step 5.1). Then tell the user, in plain English: what shipped, PR link, outcome, follow-up issues,
anything needing them. Release the worktree's keep lock: `P worktrees unkeep agent-<slug> --run agent-<slug>`, then
`P worktrees prune --notify` and read `summary` (or `skipped`). Prune removes the worktree once its PR has been merged
for 24 h and keeps it while the PR waits for a human or for Codex; never remove it by hand.

## Inbox ("ship inbox", "what is each PR waiting on") — read-only

From the repo root: `P job start inbox -- node ~/.claude/pipeline/bin/pipeline.mjs inbox` → `P job wait inbox --run-id
<runId> --timeout 540` (25+ PRs can take ~2 min); read `exitCode` and the JSON in `tail` (or `<jobDir>/log`; `--no-git`
skips the base fetch and merge-tree when git is the slow part). Then show:
1. A table: PR · title · `waitingOn` · `lastActivity` (date) · `nextAction`.
2. `strandedAfterMerge` (merged, run never finished watching production), `local.unpushed` (work that never left a
   machine) and `local.orphanWorktrees` (listed only, never removed), then any `warnings`.
3. The triage grouped **merge / resume / close / leave**, one line of reason each. `suggest` / `triage` is the
   starting point; the final call is yours (say when it differs, and why). If the project has an auto-memory index you
   already know, grep it for `#<N>` for context. A `merge` suggestion is not approval: only `ship resume N` + an owner
   "merge" merges.

Never close, merge, label, comment on a PR, or remove a worktree from the inbox; offer `ship resume N` / the close as
the owner's next move.

## Resume mode ("ship resume <pr>", "resume pipeline reviews")

`P resume list` shows what is pickable (`awaiting-review` PRs and mid-run ones). For a PR (or the one given):
1. `P resume plan --pr N` (read-only), then, before anything else:
   - `confirm` non-null ⇒ ask the owner "has the run on <host> (<step>, <n> min ago) stopped?" and WAIT. No ⇒ stop.
   - `autoMerge.action: disarm` ⇒ `gh pr merge N --disable-auto`, tell the owner.
2. Route on `enter`:
   - `closed` / `ended` / `not-resumable` ⇒ report `reason`, stop.
   - `decision` ⇒ show the `needs-human` reason, stop (the owner decides; with `owner_approval: chat` and review items `needsHuman`, tell them to rule on the ids in chat, see **Owner rules in chat** in `reference/review-loop.md`). The label alone does not mean this: Step 3.5 adds it before the review loop, so a run whose record is mid-run or ended `awaiting-review` / `blocked` / `awaiting-owner-merge` resumes as usual (the plan's `notes` say the run still ends in `needs-human`, no merge); `decision` is only for an ended `needs-human` outcome or no usable record.
   - `local-work` ⇒ report the worktree state (diverged / dirty / unpushed), stop. Never reset or discard it.
   - `observe-prod` with `production.watch: workflow` (`P config`) ⇒ do NOT run prod-watch: the project's CI workflow owns
     the production smoke and posts its result on the merged PR (Step 5.2). Close the record: `P state show --pr N` (rebuilds
     `.review/state.json` from the triage comment when this checkout has none), then `P summary --pr N --outcome merged` (pushes
     nothing); tell the owner the production result is the workflow's comment on the PR. Never roll back.
   - `observe-prod` ⇒ `git worktree add --detach <worktree_dir>/agent-<slug>-prod <mergeSha>` (fetch `origin/<base>`
     first), then `P worktrees keep agent-<slug>-prod --reason "ship run agent-<slug>-prod"`; run `P job start prod -- node ~/.claude/pipeline/bin/pipeline.mjs prod-watch --observe-only --pr N` from there, report the outcome and any
     `rollbackInterrupted`, then release the lock: `P worktrees unkeep agent-<slug>-prod --run agent-<slug>-prod`. prod-watch records the outcome itself (run record `step: ended`, `outcome` set, summary sections kept; a
     `deploy-not-observed` outcome stays open to watch again), so nothing else needs writing and the next `resume plan` routes `ended`. `needs-owner` ⇒
     tell the owner at once. Never roll back.
   - `build | verify | review | followups | gate` ⇒ steps 3–5, then the matching step. A run that ended `needs-human` for review items and whose label the owner removed after ruling in chat routes here (`gate` once the rulings made the review clean, `review` while an ACCEPT still has to be built and reviewed).
3. Worktree per `worktree.action`: `reuse` ⇒ `cd` into `path`; `add-existing-ref` ⇒ `git worktree add <path> <branch>`;
   `add-from-remote` ⇒ `git fetch origin <branch>` then `git worktree add --no-track -b <branch> <path> origin/<branch>`;
   never `-B`. Then `then: ff-only` ⇒ `git merge --ff-only <liveHead>` (the plan's exact `liveHead` sha; `plan` already refreshed `origin/<branch>`, but never trust a tracking ref), `then: push` ⇒ `git push origin <branch>`.
   Then `P worktrees keep <worktree dir name> --reason "ship run <worktree dir name>"` (the directory name of the worktree
   in use, e.g. `agent-<slug>`; the same id Step 7 passes to `unkeep --run`). `P preflight`. Then take the run over: `P checkpoint --pr N --step <enter> --resumed` (`followups` ⇒ `--step review`;
   for `adopt: true` step 5's checkpoint is the take-over and carries `--resumed`). The flag marks the record, so `P merge`
   will not run without `--owner-approved-head` even after a later session picks the run up. The plan's `stop` is where the run ends, with its `P summary --outcome <stop>` (Step 5 / Owner-merge approval).
4. `P state show --pr N`; read `source`. `quarantined` ⇒ tell the owner the local `.review/` went to `quarantinedTo`
   and the published state was restored. Exit 2 `no-state` is normal when Codex was down in round 1.
5. `adopt: true` (no run record: the PR was not started by the pipeline) ⇒ Step 3.2 checks on the real diff, then
   `P checkpoint --pr N --step review --resumed --request-file <file with "adopted PR #N">`; review from published state first.
6. Continue: `build` ⇒ Step 2 with the unfinished tasks from `record.tasks`; `verify` ⇒ Step 2.2; `review` ⇒ Step 4
   from the first incomplete round (`P state discard-round` for an unpublished one); `followups` ⇒ `P followups create
   --round R`, re-post the triage comment, then Step 5; `gate` ⇒ Step 5.
7. After a clean review, `P review-complete --pr N` removes `awaiting-review` (exit 1 ⇒ the review is not valid for
   this head: run another round). Every route that reaches Step 5 ends at the plan's `stop` (invariant 9), with its
   `P summary --outcome awaiting-owner-merge` (chat) or `needs-human` (label), see **Owner-merge approval** "Resumed runs". Step 6
   runs only after the owner says "merge" for the head the gate covered, and then with `--owner-approved-head <sha>`.

## Promoting suggestions

An issue relabelled `agent-build` (or the user saying "build #123") is a normal ship request:
read the issue, link it in the PR body (`Closes #123`).

## Failure quick reference

| Situation | Do |
|---|---|
| verify red after 3 fix cycles | draft PR + `pipeline-blocked`, `summary --outcome blocked --action …`, stop |
| blocking hard-stop hit | review loop, then `needs-human` + `summary --outcome needs-human --action …`, stop (`owner_approval: chat`: review loop, gate, then `summary --outcome awaiting-owner-merge`) |
| Codex unavailable / quota (`exitCode: 3`) | `awaiting-review`, `summary --outcome awaiting-review --action …`, stop |
| `P arbiter apply` proof fails | items → `needs-human` (the CLI marks them), `summary --outcome needs-human --action …`, stop (chat mode: the action is "Rule on <ids> in chat (accept / follow-up / reject), remove needs-human, then say ship resume N") |
| `triage validate` / `arbiter apply` exit 2 `not-found` | transcript not written yet: wait ~10 s, retry once, then `needs-human` + `summary --outcome needs-human --action …` |
| final gate fails, can't fix | `needs-human` + `summary --outcome needs-human --action …` (`labels` / `preflight`: `summary --outcome stopped --action …`), stop |
| `behind-base:` / base moved | `P update-branch --pr N` (Step 5.2), re-verify, new round if content changed (max 2 times, then `needs-human` + `summary --outcome needs-human --action …`); `rebase-needed` ⇒ the same |
| merge exit 3 `production-unknown` | nothing merged; `summary --outcome stopped --action …`, stop, tell the user |
| prod smoke fails | prod-watch handles rollback + issue + revert PR and pushes the owner; `summary` with its outcome word; tell the user. With `production.watch: workflow` there is no prod-watch: the workflow's PR comment is the record, nothing is rolled back and no production push is sent; tell the user |
| pause/rollback issue open | PR stays open: `summary --outcome stopped --cause merge-paused --action "Close the pause/rollback issue"`, explain |
| `checkpoint` exit 1 `unpushed` / `behind` / `diverged` | `git push origin agent/<slug>` / `git pull --ff-only` / `summary --outcome stopped --cause checkpoint:diverged --action …`, stop and report; checkpoint again |
| `resume plan` has `confirm` | ask the owner whether the other run stopped; wait; never start on a guess |
| `resume plan` `enter: local-work` | report the diverged/dirty/unpushed worktree, stop; never reset it |
| `merge` `error: pre-merge` naming `prod-before` | nothing merged (the rollback evidence could not be posted): retry once, then `summary --outcome stopped --cause merge:prod-before --action …`, tell the user |
| observe-only `needs-owner` | production fails the smoke; nothing changed. prod-watch pushes the owner; tell them now with `evidence`; they decide |
