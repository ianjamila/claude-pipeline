---
name: review
description: Use for ANY request to build, add, implement, fix, change, or refactor code in a git repository that has .claude/pipeline.yml — features, bug fixes, UI tweaks, migrations, "make X do Y", "can you add…", "fix the bug where…". Builds on a branch with tests, opens a draft pull request, runs the cross-model review loop (Codex → judge → arbiter), then hands the owner the exact merge request. Repos without .claude/pipeline.yml never merge; offer pipeline-setup.
when_to_use: Any code-changing request in a repo, unless the session was started with PIPELINE_OFF=1 or the user says not to use the pipeline. Also issues labelled agent-build ("build #123": read the issue, put `Closes #123` in the PR body; one keyword per issue, `Closes #1. Closes #2.`).
argument-hint: "[what to build]"
---

# review — build, cross-model review, owner merge

You are the **controller**: you orchestrate, subagents and the `pipeline` CLI do the work. `P` below means
`node ~/.claude/pipeline/bin/pipeline.mjs` (type it exactly so the permission allowlist matches). Every `P` command
prints one JSON object; exit 0 ok, 1 check failed/refused, 2 usage/env error, 3 dependency unavailable. `N` is the PR
number, `R` a review round, `<slug>` 2–5 lowercase words from the request.

## Rules

1. Only the owner decides a merge: the one merge you run is `P merge --pr N --owner-go`, after the owner's own "merge" for that head
   (3.3). You never run `gh pr merge` or the repo's merge command yourself, never push to `main`/`master`
   or force-push (`git push -u origin agent/<slug>`), never add `human-approved` / `test-change-approved`, never remove
   `needs-human` / `pipeline-blocked` / `pipeline-pause` / `pipeline-rollback` yourself (`P merge --owner-go` lifts exactly the `needs-human` hold the owner's verified "merge" named, 3.3). The guards block these; don't route around them.
2. No cross-model review, no merge. Codex unavailable (`exitCode: 3`) with `substitute.eligible` ⇒ the substitute path (2.1), not a stop. Otherwise ⇒ `gh pr edit N --add-label awaiting-review`,
   `P comment --pr N --kind awaiting-review --reason "<reason from the JSON>"`, tell the owner, stop (outcome `awaiting-review`). A failed Codex run is never "no findings".
3. Never pass a `model` parameter to `judge`, `arbiter`, `arbiter-fix`, `implementer`, `substitute-opus` or `substitute-fable`: their agent files pin the model (Sonnet, Fable, Fable, Sonnet, Opus, Fable).
4. Keep your context lean: work from `P` JSON, subagent summaries and file paths; hand paths, not logs or diffs, to subagents.
5. Anything over 2 minutes is a background wait: `P round codex` (2.1) is started with Bash `run_in_background: true` and wakes you once; any other long command runs as `P job start <name> -- <command>`, then `P job wait <name> --run-id <runId> --until-done` in the background (or in the foreground `--timeout 540`, repeated until `state` is `done`; `replaced`/`lost` ⇒ start it again once). Read `exitCode` and the JSON in `tail` (`job read --full` has the whole stdout). The by-hand flow stays valid: `reference/special-rounds.md`.
6. The whole suite is CI's job: locally you run only `verify.quick`, on the changed area. Never run `verify.full` here.
7. **Stop ritual.** Every stop below names its outcome. Once the PR exists, run `P summary --pr N --outcome <outcome> --built "<one line: what was built>"`
   (it renders the cost bookings into the PR comment), then `P agent-log publish --line "<agentLogLine from the summary JSON>"`, then tell the owner.
8. Before ANY `git push` to a READY PR (fix, settle test, owner override build, docs-exempt row, conflict resolution, owner-requested change): `P redraft --pr N` first (`--reason ci-failed` for a CI-red fix); it releases the merge hold and turns the PR to draft so CI waits; 3.2 marks it ready again. `not-open` / `merge-in-progress` / `autoMergeDisabled` / `stage:read|convert` outcomes, and the exceptions, are in `reference/redraft.md` (the full Rule 8): read it before the first such push.

Opt-out: `PIPELINE_OFF=1` or the user says not to use the pipeline ⇒ do the task normally (still never push to main).

## 0. Preflight

`P preflight` (exit 2, no config ⇒ offer pipeline-setup; you may still open a PR but nothing merges), `P config` (note
`verify.quick`, `default_branch`, `worktree_dir`, `review.max_rounds`, `merge.command`), `P labels ensure` (exit 3 ⇒ GitHub unreachable: say so, stop). A `claudeCode` warning in the preflight JSON (this terminal's build is older than the installed one) ⇒ tell the owner to restart before a Fable round; it never blocks anything else.
Picking up an existing `awaiting-review` PR (Codex was unavailable): `P state show --pr N`, then continue at section 2 with the round it shows.

## 1. Branch and build

Details of steps 2–5: `reference/build.md`.

1. `git fetch origin <default_branch>` and `git worktree add --no-track -b agent/<slug> <worktree_dir>/agent-<slug> origin/<default_branch>`
   (`--no-track`: a branch tracking `origin/main` can make a bare push target main). All work happens there; give subagents its absolute path.
2. ONE `implementer` dispatch builds the whole change (tasks in order, tests first, `verify.quick`, the commit trailer, "return immediately when done"); more only for a big change; continue THE SAME agent before a fresh dispatch.
3. `verify.quick` after each dispatch and before every push; red ⇒ implementer, max 3 fix cycles, then stop (outcome `blocked`).
4. Draft PR: `git push -u origin agent/<slug>`, `gh pr create --draft`; body opens with `## In plain English`; one keyword per issue (`Closes #170. Closes #171.`).
5. `mkdir -p .review`, then `P risk`, `P hardstops > .review/hardstops.json` and `P integrity` on the real diff; note any `blocking` / `ownerMerge` item or integrity violation (3.3 depends on it). The review runs either way.

## 2. Review rounds (max `review.max_rounds`, plus the one extra round `P state outcome` calls `extraRound`, plus one per owner `extra round`)

Round `R`; `P codex-review` itself refuses any other round (`round-cap`). The old one-command-at-a-time flow stays valid and is written out in `reference/special-rounds.md`.

1. **Codex.** `P round codex --pr N --round R`, started with Bash `run_in_background: true` (plan, Codex job, wait; you are woken once). Base and head default to what `codex-review` admits. It returns `codex` (`counts`, `codexPath`, `baseOnly`, `resolutionOnly`), `reviewer`, and for a Fable round the `arbiter needed` JSON as `arbiter`. `state: "running"` ⇒ run it again (it adopts the job). A refusal is that step's own JSON: exit 2 `empty-range` (the "fix" changed no code: back to 5), `base-mismatch` / `head-moved` / `update-in-progress` (rerun); exit 3 with `substitute.eligible` ⇒ `reference/substitute.md`; `replaced` / `lost` / `missing`, an interrupted round, `baseOnly`, `resolutionOnly` ⇒ `reference/special-rounds.md`. Not eligible ⇒ rule 2.
2. **Who reviews.** `reviewer`: `fable` ⇒ skip the judge, the arbiter (4) is the review every round, even with zero Codex items; `judge` ⇒ `P triage light-lane --round R` when `P risk` said `lightLane` and Codex returned only WORTH CONSIDERING items, else 3 (`reference/judge-and-settle.md`).
3. **Judge.** Only items without a `final`: the `judge` agent, then `P triage validate --round R --from-tag "pipeline-judge R<R> <d8>"`; a disputed bug with a settle test: `reference/judge-and-settle.md`.
4. **Arbiter** (`arbiter.needed` from step 1, else `P arbiter needed --round R`): ONE call of the agent it names, description = its `tag`, prompt = its `promptHeader` verbatim, then `Read <inputPath> and rule on every item in it.`; then `P arbiter apply --round R --tag "<tag>"`. Errors (`not-found`, `restartRequired`, `model-floor-busy`, …): `reference/arbiter-errors.md`.
   After the judge or arbiter returns, send TWO Bash calls in the SAME message: `P cost … --from-transcript <transcript>` and `P arbiter apply …` (or `P triage validate …`); they serialise on their locks. Booking: `reference/cost-booking.md`.
5. **Publish and fix.** `P round publish --pr N --round R` (`comment --kind triage`, `followups create`, the comment again, the accepted items at `accepted.path`, `outcome`; rerun it after any failure). ACCEPT items: one `implementer` dispatch with that path; push (Rule 8). Then TWO Bash calls in the SAME message: `P cost … implementer` and `P state mark-implemented --ids <ids>` (exit 2 `no-code-change`: back to the implementer).
6. **Outcome.** `P state outcome`: `clean` ⇒ leave the loop; `needsHuman` non-empty ⇒ rulings; more rounds ⇒ round R+1 (`round codex`); none left ⇒ park, cause `unresolved: <ids>`, except `reachedMax` with `owner_approval: chat` ⇒ ask for an extra round. Park, rulings, extra round: `reference/park-and-rulings.md` and `reference/owner-merge.md`.

## 3. Review complete, ready, hand-off

Full text: `reference/ready-and-handoff.md`.

1. `P review-complete --pr N` (HEAD pushed). Exit 1 ⇒ read `reason` and go back to the round it names.
2. Only after exit 0: `gh pr ready N`, then CI via `P job start ci -- node ~/.claude/pipeline/bin/pipeline.mjs ci-wait --pr N` (never `gh pr checks --watch`); verdicts, `update-branch`, queue mode and merge holds are in the reference.
3. **STOP** (outcome `awaiting-owner-merge`): stop ritual, tell the owner in plain English what changed, the PR link, the review outcome and follow-ups; read `reference/owner-merge.md` (3.3) and end the reply exactly as it says. The closing lines look like:
   `Head <sha12> · items <digest> · repo <owner/name>`
   `🔀 Ready to merge #N — say "merge"`
