---
name: review
description: Use for ANY request to build, add, implement, fix, change, or refactor code in a git repository that has .claude/pipeline.yml — features, bug fixes, UI tweaks, migrations, "make X do Y", "can you add…", "fix the bug where…". Builds on a branch with tests, opens a draft pull request, runs the cross-model review loop (Codex → judge → arbiter), then hands the owner the exact merge request. Repos without .claude/pipeline.yml never merge; offer pipeline-setup.
when_to_use: Any code-changing request in a repo, unless the session was started with PIPELINE_OFF=1 or the user says not to use the pipeline. Also issues labelled agent-build ("build #123": read the issue, put `Closes #123` in the PR body).
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
   `needs-human` / `pipeline-blocked` / `pipeline-pause` / `pipeline-rollback`. The guards block these; don't route around them.
2. No cross-model review, no merge. Codex unavailable (`exitCode: 3`) ⇒ `gh pr edit N --add-label awaiting-review`,
   `P comment --pr N --kind awaiting-review --reason "<reason from the JSON>"`, tell the owner, stop (outcome `awaiting-review`). A failed Codex run is never "no findings".
3. Never pass a `model` parameter to `judge`, `arbiter` or `implementer`: their agent files pin the model (Sonnet, Fable, Sonnet).
4. Keep your context lean: work from `P` JSON, subagent summaries and file paths; hand paths, not logs or diffs, to subagents.
5. Anything over 2 minutes runs as `P job start <name> -- <command>`, then `P job wait <name> --run-id <runId> --timeout 540`
   until `state` is `done` (`replaced`/`lost` ⇒ start it again once). Read `exitCode` (the command's own code) and the JSON in `tail`.
6. The whole suite is CI's job: locally you run only `verify.quick`, on the changed area. Never run `verify.full` here.
7. **Stop ritual.** Every stop below names its outcome. Once the PR exists, run `P summary --pr N --outcome <outcome> --built "<one line: what was built>"`
   (it renders the cost bookings into the PR comment), then `P agent-log publish --line "<agentLogLine from the summary JSON>"`, then tell the owner.

Opt-out: `PIPELINE_OFF=1` or the user says not to use the pipeline ⇒ do the task normally (still never push to main).

## 0. Preflight

`P preflight` (exit 2, no config ⇒ offer pipeline-setup; you may still open a PR but nothing merges), `P config` (note
`verify.quick`, `default_branch`, `worktree_dir`, `review.max_rounds`, `merge.command`), `P labels ensure` (exit 3 ⇒ GitHub unreachable: say so, stop).
Picking up an existing `awaiting-review` PR (Codex was unavailable): `P state show --pr N`, then continue at section 2 with the round it shows.

## 1. Branch and build

1. `git fetch origin <default_branch>` and `git worktree add --no-track -b agent/<slug> <worktree_dir>/agent-<slug> origin/<default_branch>`
   (`--no-track`: a branch tracking `origin/main` can make a bare push target main). All work happens there; give subagents its absolute path.
2. Split the work into small tasks. Per task dispatch the `implementer` agent with: the task, worktree path, acceptance criteria,
   the tests to write (a bug ⇒ the failing test first, its failing output kept), `verify.quick`, and the commit trailer your system
   context prescribes (pass it verbatim). Independent tasks may run in parallel only on different files.
3. Quick check on the changed area (`verify.quick`) after each task and before every push. Red ⇒ implementer with the failing
   step and excerpt, max 3 fix cycles; still red ⇒ stop (outcome `blocked`): before the PR exists (step 4) only report to the owner; once it exists,
   first `gh pr edit N --add-label pipeline-blocked` and `P comment --pr N --kind blocked`, then the stop ritual.
4. Draft PR: `git push -u origin agent/<slug>`, `gh pr create --draft --title "<title>" --body-file <file>`. The body opens
   with `## In plain English` (2–4 jargon-free sentences: what changes for users and why), then what and why, tests added, the quick check
   and its head sha, risk. UI change ⇒ `P artifacts push --pr N --dir .verify/screenshots`, put the returned image links in the body.
5. `mkdir -p .review`, then on the real diff: `P risk --base origin/<default_branch> --head HEAD`,
   `P hardstops --base origin/<default_branch> --head HEAD > .review/hardstops.json` (kept: 3.3 names its hits) and `P integrity --base origin/<default_branch> --head HEAD`.
   Note whether ANY item is `blocking` or `ownerMerge` (hard-stop) or a test-integrity `violations` / `ownerMerge` entry; 3.3 depends on it. The review below runs either way.
   `owner_approval: label`: a blocking hit or a violation you cannot undo ends in a park (below) after the review. `owner_approval: chat`: nothing blocks, the hits are
   advisory + `ownerMerge`, and the PR ends with the owner-merge ending of 3.3 (no `needs-human` label).

## 2. Review rounds (max `review.max_rounds`, plus the one extra round `P state outcome` calls `extraRound`)

Round `R`; `P codex-review` itself refuses any other round (`round-cap`). Commands run as jobs report the real code as `exitCode`.

1. **Codex.** base: round 1 `git merge-base origin/<default_branch> HEAD`, later the previous round's `toHead` (`.review/state.json`);
   head: the pushed HEAD; effort: `review.effort[<risk>]`, later rounds `review.effort.followup`.
   `P job start codex-rR -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review --pr N --round R --base <base> --head <head> --effort <effort>`,
   then `P job wait codex-rR …`. Exit 2 `empty-range`: the "fix" changed no code, go back to step 5. `base-mismatch` / `head-moved`: recompute and rerun.
   An interrupted round (no triage comment yet): `P state discard-round --round R --pr N` before rerunning it.
   `baseOnly: true` (only main merged in): Codex did not run, no items, not counted; it carries the last reviewed result forward.
   `resolutionOnly: true` (a main conflict resolved by choosing lines): a real review of just the resolution, triaged as usual
   (an ACCEPT still needs its fix round) but not counted; `resolutionIneligible: "<reason>"` ⇒ a normal counted round.
2. **Who reviews.** The output names `reviewer`. `fable` (medium/high risk, `risk.high_risk_paths` or `review.arbiter_always_paths`):
   skip the judge; the arbiter pass (step 4) is the review every round, even with zero Codex items. `judge`: `P triage light-lane --round R`
   when `P risk` said `lightLane` and Codex returned only WORTH CONSIDERING items, else the judge below.
3. **Judge.** Only for items without a `final` yet. `d8` = first 8 characters of `shasum -a 256 .review/round-R/codex.json`. Invoke `judge`
   with description `pipeline-judge R<R> <d8>` and a prompt of: worktree path, `.review/round-R/codex.json`, `.review/round-R/diff.patch`, PR title, risk,
   and the pending ids. Then `P triage validate --round R --from-tag "pipeline-judge R<R> <d8>"` (exit 2 `not-found`: wait, retry once; exit 1: reinvoke once
   with the `errors`; `not-found` / invalid twice ⇒ park, cause `judge:not-found` / `judge:invalid`). A disputed bug with a settle test: implementer writes and commits the test only, then
   `P triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd "<cmd>" --test-file <file>` (the CLI runs it itself). `bug-confirmed` makes the item
   ACCEPT: fixed and marked implemented in step 5, like any accepted item.
4. **Arbiter** (when `P arbiter needed --round R` says `needed`). One call: the `arbiter` agent, description = the `tag` it printed, prompt starting
   with its `promptHeader` pasted verbatim, then `Read <inputPath> and rule on every item in it.` (Fable round: and review the diff it names). Then
   `P arbiter apply --round R --tag "<the same tag>"`; exit 2 `not-found`: wait, retry once, then park (cause `arbiter:not-found`);
   exit 1 ⇒ the items are `needsHuman` (Fable round: run `needed` and the arbiter once more; failing twice ⇒ park, cause `arbiter:model-proof`).
5. **Publish and fix.** `P comment --pr N --kind triage` FIRST, then `P followups create --round R` for FOLLOW-UP items, then the triage comment again
   (issue links). ACCEPT items: one `implementer` dispatch with `P state show --round R --accepted`; it fixes, adds tests, runs `verify.quick`, commits;
   push. Then **`P state mark-implemented --ids <ids>`** for each fixed ACCEPT item: `review-complete` refuses an ACCEPT that is not marked, from ANY round,
   and exit 2 `no-code-change` means the fix changed no code (back to the implementer; marking never replaces a fix).
6. **Outcome.** `P state outcome`: `clean` ⇒ leave the loop; `needsHuman` non-empty ⇒ see Owner rulings; more rounds left ⇒ round R+1 (the Codex fix
   check reviews only what changed since this round's head); none left ⇒ park, cause `unresolved: <ids>`.
**Park** (every `needs-human` stop is this): `gh pr edit N --add-label needs-human`, `P comment --pr N --kind needs-human --reason "<cause, what was checked, what the owner does>"`,
then the stop ritual with outcome `needs-human`. The summary renders from the round state, so at least one Codex round must have run; before that a stop is `blocked` or `awaiting-review`.

Book every agent call (implementer, judge, arbiter) right after it returns:
`P cost --pr N --phase <build|review> --role <implementer|judge|arbiter> --from-transcript <the agent's transcript>` (add `--retry` on a fix retry). The transcript is
`~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl`; the `agentId` is in the Agent tool's result. Calls made before the PR exists (no `N` yet)
are noted (role, phase, transcript) and all booked right after `gh pr create`. A failed `P cost` is a warning, never a reason to stop.

## Owner rulings (only with `owner_approval: chat` in `P config`)

An item left `needsHuman` (failed model proof, low-confidence arbiter, a dismissed security item) is cleared only by the owner's word.
Run `P triage ruling-request --pr N --ids R1-B1,R2-S3`. Your reply says "answer with only `<id>: accept | follow-up | reject`; reasons in another
message" and **ends with the exact `line` it printed**, nothing after it. The owner-go hook records the owner's next prompt against that line. Per
item: `P triage owner-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason "<why>" --owner-quote "<the owner's whole answer, copied, never paraphrased>" --pr N`.
A refusal (changed finding text, wrong id, other words, label mode) ⇒ ask again with a fresh `ruling-request`. Then re-post `P comment --pr N --kind triage`,
`P followups create --round R`, and the comment again; an ACCEPT is built, `mark-implemented`, and reviewed in a new round. In label mode, `needsHuman`
items end in `needs-human` (as in step 6): the owner rules outside this session.

## 3. Review complete, ready, hand-off

1. `P review-complete --pr N` (HEAD pushed and equal to the PR head). Exit 0 posts the marker comment and takes `awaiting-review` off. Exit 1 ⇒ read
   `reason` (a commit since the last round, an unmarked ACCEPT, a Fable pass owed) and go back to the round it names. Any later commit that changes
   the code needs another round and another `review-complete`.
2. Only after that exit 0. If the head changed since 1.5 ran (any review fix), re-run 1.5 on it first: the label below, the CI reading and 3's ending use its notes.
   High risk (1.5's `P risk`) ⇒ `gh pr edit N --add-label <ci.e2e_label>` (if configured); then `gh pr ready N`.
   CI runs now and is the full proof. Checks can take a few seconds to appear (`gh pr checks --watch` exits 1 "no checks reported"), so poll first:
   `P job start ci -- bash -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do gh pr checks N --required >/dev/null 2>&1; [ $? -ne 1 ] && break; sleep 10; done; gh pr checks N --watch --required'`,
   then `P job wait ci …`. `owner_approval: label` with a blocking item noted at 1.5: the guard checks reporting just those items are
   expected to be red — that is not a fix target: park (section 2) once the other checks are green.
   Any other red ⇒ implementer fix, push, back to step 1 of this section. Base moved ⇒ `P update-branch --pr N`, `git pull --ff-only`, review again if content changed.
3. **STOP** (outcome `awaiting-owner-merge`; `owner_approval: label` with a blocking item parks instead, no merge request): run the stop ritual first, then tell the owner in plain English what changed, the PR link, the review outcome and
   follow-up issues. Which ending depends on the item note from 1.5 (as refreshed in step 2):
   - **Any `blocking` / `ownerMerge` / test-integrity item** (always the case for a protected-area PR under `owner_approval: chat`): NO `Head …` / `🔀` lines
     (`P merge --owner-go` refuses such a diff) and no `needs-human` label. Say the PR is reviewed and CI is green, name the protected areas it touches
     (from `.review/hardstops.json` and `P integrity`), and give the repo's `merge.command` from `P config` with `{pr}` = N and `{sha}` = the head sha
     filled in (EagleWatch: `npm run merge -- <PR> --expect-head <sha>`) for the owner to run.
   - **No such item**: the reply's LAST two lines are exactly (sha12 = first 12 characters of `git rev-parse HEAD`; owner/name from
     `gh repo view --json nameWithOwner`; the digest is `none` on the `--owner-go` route):
     `Head <sha12> · items <digest> · repo <owner/name>`
     `🔀 Ready to merge #N — say "merge"`
     The owner-go hook binds the owner's "merge" to the LAST reply: if anything else was said since, or the context was compacted since you showed
     it, show both lines again. Never type or simulate the owner's "merge". The owner then says "merge" and you run `P merge --pr N --owner-go`
     (only that command: it checks the owner's record); no record ⇒ `P merge` says so: show the request again and wait.
