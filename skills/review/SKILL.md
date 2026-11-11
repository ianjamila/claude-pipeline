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
2. No cross-model review, no merge. Codex unavailable (`exitCode: 3`) ⇒ `gh pr edit N --add-label awaiting-review`,
   `P comment --pr N --kind awaiting-review --reason "<reason from the JSON>"`, tell the owner, stop (outcome `awaiting-review`). A failed Codex run is never "no findings".
3. Never pass a `model` parameter to `judge`, `arbiter`, `arbiter-fix` or `implementer`: their agent files pin the model (Sonnet, Fable, Fable, Sonnet).
4. Keep your context lean: work from `P` JSON, subagent summaries and file paths; hand paths, not logs or diffs, to subagents.
5. Anything over 2 minutes runs as `P job start <name> -- <command>`, then `P job wait <name> --run-id <runId> --timeout 540`
   until `state` is `done` (`replaced`/`lost` ⇒ start it again once). Read `exitCode` (the command's own code) and the JSON in `tail`.
6. The whole suite is CI's job: locally you run only `verify.quick`, on the changed area. Never run `verify.full` here.
7. **Stop ritual.** Every stop below names its outcome. Once the PR exists, run `P summary --pr N --outcome <outcome> --built "<one line: what was built>"`
   (it renders the cost bookings into the PR comment), then `P agent-log publish --line "<agentLogLine from the summary JSON>"`, then tell the owner.

Opt-out: `PIPELINE_OFF=1` or the user says not to use the pipeline ⇒ do the task normally (still never push to main).

## 0. Preflight

`P preflight` (exit 2, no config ⇒ offer pipeline-setup; you may still open a PR but nothing merges), `P config` (note
`verify.quick`, `default_branch`, `worktree_dir`, `review.max_rounds`, `merge.command`), `P labels ensure` (exit 3 ⇒ GitHub unreachable: say so, stop). A `claudeCode` warning in the preflight JSON (this terminal's build is older than the installed one) ⇒ tell the owner to restart before a Fable round; it never blocks anything else.
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
   and its head sha, risk. Issues it closes: one keyword per issue, `Closes #170. Closes #171.` (GitHub closes only the first number of
   `Closes #170, #171`). UI change ⇒ `P artifacts push --pr N --dir .verify/screenshots`, put the returned image links in the body.
5. `mkdir -p .review`, then on the real diff: `P risk --base origin/<default_branch> --head HEAD`,
   `P hardstops --base origin/<default_branch> --head HEAD > .review/hardstops.json` (kept: 3.3 names its hits) and `P integrity --base origin/<default_branch> --head HEAD`.
   Note whether ANY item is `blocking` or `ownerMerge` (hard-stop) or a test-integrity `violations` / `ownerMerge` entry; 3.3 depends on it. The review below runs either way.
   `owner_approval: label`: a blocking hit or a violation you cannot undo ends in a park (below) after the review. `owner_approval: chat`: nothing blocks, the hits are
   advisory + `ownerMerge`, and the PR ends with the owner-merge ending of 3.3 (no `needs-human` label).

## 2. Review rounds (max `review.max_rounds`, plus the one extra round `P state outcome` calls `extraRound`, plus one per owner `extra round`)

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
4. **Arbiter** (when `P arbiter needed --round R` says `needed`). One call: the agent named in the `agent` field of its output (`arbiter`, or `arbiter-fix` when `brief` is `fix-verify`: a fix round, Fable at effort medium with a narrow verify-the-fixes input; use exactly the one named, `apply` refuses the other; if `arbiter-fix` cannot be started (an agent file the terminal has not loaded) or the owner wants a full review, run `P arbiter needed --round R --full` and use `arbiter` at effort high; the forced full brief sticks for the round: later plain `needed` calls, such as the retry after a restart or after an unproven pass, keep it until a pass is proven), description = the `tag` it printed, prompt starting
   with its `promptHeader` pasted verbatim, then `Read <inputPath> and rule on every item in it.` (Fable round: and review the diff it names). Then
   `P arbiter apply --round R --tag "<the same tag>"`; exit 2 `not-found`: wait, retry once, then park (cause `arbiter:not-found`);
   exit 1 with `restartRequired` (`stale-terminal` from `needed`, `stale-model` from `apply`; Fable round) ⇒ do NOT retry here and do NOT park: outcome `blocked`, with no `pipeline-blocked`
   label and no `needs-human`. Post the CLI's `advice` text (`P comment --pr N --kind blocked --reason "<advice>"`), with `merge.hold_command` in `P config` `P merge-hold --pr N --release --reason restart`,
   run the stop ritual, and tell the owner to restart the terminal (or update Claude Code / `pipeline model-floor reset`, as the advice says). After the restart: `P arbiter needed --round R` and the arbiter again.
   Exit 1 `error: model-floor-busy` ⇒ run `P arbiter apply` once more after a minute (no new arbiter call). Exit 1 `unrecognised-fable`, `model-floor-unreadable` or
   `model-floor-unwritable` ⇒ no new Fable pass can fix it: do NOT re-run the arbiter; stop `blocked` exactly like the `restartRequired` stop, posting the CLI's `advice`.
   Any other exit 1 ⇒ the items are `needsHuman` (Fable round: run `needed` and the arbiter once more; failing twice ⇒ park, cause `arbiter:model-proof`).
5. **Publish and fix.** `P comment --pr N --kind triage` FIRST, then `P followups create --round R` for FOLLOW-UP items, then the triage comment again
   (issue links). ACCEPT items: one `implementer` dispatch with `P state show --round R --accepted`; it fixes, adds tests, runs `verify.quick`, commits;
   push. Then **`P state mark-implemented --ids <ids>`** for each fixed ACCEPT item: `review-complete` refuses an ACCEPT that is not marked, from ANY round,
   and exit 2 `no-code-change` means the fix changed no code (back to the implementer; marking never replaces a fix).
6. **Outcome.** `P state outcome`: `clean` ⇒ leave the loop; `needsHuman` non-empty ⇒ see Rulings; more rounds left ⇒ round R+1 (the Codex fix
   check reviews only what changed since this round's head); none left ⇒ park, cause `unresolved: <ids>`, except one case: `reachedMax`, no
   `extraRound`, `owner_approval: chat`, and the fixes are pushed and `verify.quick` is green ⇒ ask the owner for one more round (Extra round, below). Label mode ⇒ park.
**Park** (every `needs-human` stop is this): `gh pr edit N --add-label needs-human`, `P comment --pr N --kind needs-human --reason "<cause, what was checked, what the owner does>"`,
with `merge.hold_command` in `P config` `P merge-hold --pr N --release --reason parked` (a parked PR must not keep the merge line), then the stop ritual with outcome `needs-human`. The summary renders from the round state, so at least one Codex round must have run; before that a stop is `blocked` or `awaiting-review`. The park comment is your own text: 3.3 shows a later hold from GitHub's label event and quotes the comment only as agent-written.

Book every agent call (implementer, judge, arbiter; an `arbiter-fix` call is booked as role `arbiter`) right after it returns:
`P cost --pr N --phase <build|review> --role <implementer|judge|arbiter> --from-transcript <the agent's transcript>` (add `--retry` on a fix retry). The transcript is
`~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl`; the `agentId` is in the Agent tool's result. Calls made before the PR exists (no `N` yet)
are noted (role, phase, transcript) and all booked right after `gh pr create`. A failed `P cost` is a warning, never a reason to stop.

## Rulings and extra round (only with `owner_approval: chat` in `P config`)

An item left `needsHuman` ⇒ never ask the owner to type a ruling: decide it yourself and record it with a reason:
`P triage claude-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason "<why>" --pr N`. Read `reference/owner-merge.md` (Extra round, 3.3) for the rest.

- ACCEPT is always allowed. FOLLOW-UP alone only for a non-BLOCKING, non-security item.
- Any REJECT, or dismissing a BLOCKING or security item, needs Codex first, run BEFORE you form a view:
  `P triage second-review --round R --ids … --pr N` as a job. Codex ACCEPT ⇒ the item is ACCEPT, fix it. Codex dismisses at high confidence ⇒ claude-ruling may dismiss;
  the stricter of the two stands. Below high ⇒ ACCEPT. Exit 3 ⇒ rule 2 (`awaiting-review`); never substitute another reviewer.
- A malfunction cause (`model-proof`, `invalid-arbiter`, `invalid-judge`): `P arbiter needed --round R` re-runs the arbiter, or ACCEPT.
- You may tighten your own dismissal to ACCEPT before the merge, never loosen an ACCEPT. Only the owner's typed path loosens: if, and only if, the owner says they want to dismiss it,
  follow `reference/owner-merge.md` Owner override.
- `stale-publication` (the PR holds a review state this copy did not publish): `P state show --pr N`, then redo the last step. `P review-complete` republishes the state and is the remedy the merge refusal names.
- The owner objects to a ruling in free text ⇒ re-rule it ACCEPT, fix it: that makes a new head, so a new review and a new request.
- Label mode ⇒ no rulings: park as before.

**Extra round.** `P state outcome` with `reachedMax: true` and no `extraRound` / `grantedRound` ⇒
ask for one more round: `P triage round-request --pr N`. Read `reference/owner-merge.md` (section Extra round) BEFORE asking: your reply must end with the exact `line` it prints.
Never type, paraphrase or forge the owner's words, and never run Codex outside `codex-review`. Label mode ⇒ no grant exists: a reached max parks (step 6).

## 3. Review complete, ready, hand-off

1. `P review-complete --pr N` (HEAD pushed and equal to the PR head). Exit 0 posts the marker comment and takes `awaiting-review` off. Exit 1 ⇒ read
   `reason` (a commit since the last round, an unmarked ACCEPT, a Fable pass owed) and go back to the round it names. A reason naming `fable-refresh` (a Fable proof below the newest Fable) ⇒ `P state fable-refresh --pr N` (an uncounted Fable-only round on the pushed head), then 2.4 for that round (the pass reviews the whole PR diff), 2.5 and 2.6 as usual, then `P review-complete` again. A reason `behind-base` (a draft behind its base) ⇒ run its `remedy` (`P update-branch --pr N`, `git pull --ff-only`, the baseOnly `codex-review` round, `review-complete` again) BEFORE `gh pr ready`, so CI runs once on current main. Any later commit that changes
   the code needs another round and another `review-complete`. One exception: commits after the last round that ONLY ADD lines to `review.docs_exempt_paths` documents (`P config`) need no round, and each added line must be a strict ledger row (`` | 0240 | `name` | YYYY-MM-DD | #PR | | ``, last in the file, numbers rising, for a migration at the reviewed head); anything else, or a listed document an instruction file `@`-imports, takes a round;
   `review-complete` posts for the current head (`docsExempt`), a refusal names the file that forces a round. Verification of that head is still owed.
2. Only after that exit 0. If the head changed since 1.5 ran (any review fix), re-run 1.5 on it first: the label below, the CI reading and 3's ending use its notes.
   High risk (1.5's `P risk`) ⇒ `gh pr edit N --add-label <ci.e2e_label>` (if configured); then `gh pr ready N`.
   CI runs now and is the full proof. Wait with `P job start ci -- node ~/.claude/pipeline/bin/pipeline.mjs ci-wait --pr N`, then
   `P job wait ci --run-id <runId> …` again until it is done. Never `gh pr checks --watch` here: right after `gh pr ready` a required
   check's only result is the draft-era SKIPPED one, which `gh` counts as passed (Phase 6: hand-off 14 min early); ci-wait waits for
   every required check of the base branch to report after the PR became ready. Its `verdict` when not ok: `failed` ⇒ implementer fix
   (below; a ready-era failure of an attempt a re-run has superseded is waited on, so `failed` is the newer attempt's own result, unless its message says "superseded by a newer attempt that never reported": then the superseded failure stood at `--appear-timeout` and no newer result replaced it); `head-moved` / `base-changed` ⇒ back to step 1 of this section; `missing` / `stale-skipped` (a required check never ran on the ready event: ci-wait only says `missing` once no run that could produce the check is still going on the head (a ready-era run, or one started before ready: `heldBy.predatesReady`), and `stale-skipped` once nothing created or (re-)started after `gh pr ready` is still running, since a `needs:`-gated aggregate appears late by design; `heldBy` in the output names the run it was waiting on),
   `unverified` (branch protection or rules unreadable), `no-required-checks`, `timeout` ⇒ tell the owner in plain English, with the
   check names, and wait. `owner_approval: label` with a blocking item noted at 1.5: run it with `--wait-all`; the guard checks
   reporting just those items are expected to be red — that is not a fix target: park (section 2) once ci-wait shows every other check
   green. Any other red ⇒ implementer fix, push, back to step 1 of this section. With `merge.hold_command` in `P config`, a `failed` verdict first releases this PR's merge hold:
   `P merge-hold --pr N --release --reason ci-failed` (a red PR must not keep the merge line; it acts only on N).
   Base moved ⇒ `P update-branch --pr N`, `git pull --ff-only`, review again if content changed. With `merge.hold_command`, update-branch takes this PR's merge hold right
   before the update (output `hold`), so another PR's merge cannot undo the catch-up's CI round. The hold stays through that pipeline-made head (`P merge-hold --release --reason new-commits`
   answers `kept: own-successor` for it, so run that release whenever you push; it decides). update-branch releases the hold itself on `checks-failed` (`ci-failed`) and `rebase-needed` (`update-conflict`):
   `holdRelease` not `confirmed` ⇒ run that release once yourself, from this PR's own worktree on its branch (a provider may refuse a release from any other checkout or a detached HEAD: EagleWatch does). `head-timeout`, `checks-timeout`, `cycle-cap`, `head-moved` keep it (retry, or re-read: a PR-side push ⇒ the `new-commits` release).
   `outcome: "queued-behind"` (another PR's older merge hold is ahead; `blockedBy`, `doNotUpdate`) ⇒ never update past it; wait your turn:
   `P job start turn -- node ~/.claude/pipeline/bin/pipeline.mjs merge-hold --pr N --check --wait` (one check every 5 min, up to 120 min), `P job wait turn --run-id <runId> --timeout 540`
   until done. `outcome: "front"` ⇒ `P update-branch --pr N` again. `timeout` / `unreadable` ⇒ `P merge-hold --pr N --release --reason queued-behind`, report it as in 3's
   **Queued behind** and stop. `hold-unreadable` ⇒ retry once after 60 s (a confirmed hold is kept, `holdTaken: true`; a take that may have half-written one is already released: `holdRelease`), then tell the owner and stop
   (with `holdTaken: true`, first `P merge-hold --pr N --release --reason hold-unreadable`).
   **Queue mode** (`P update-branch` answers `outcome: "queue-mode"`, the dry run says `queue: true`): it exists only when GitHub reports a merge queue on the base branch, which tests the PR on top of main and everything ahead of it. A moved base is no problem there: no `P update-branch` for "behind", no merge hold (`P merge-hold` answers `queueMode: true`), no catch-up CI. One exception, only for a custom `merge.command` and a PR that is not queued yet (the default command and a queued PR always get `queue-mode`): a branch that does not contain the commit the base names in `.claude/merge-queue-aware` (the commit that taught the repo's merge script the queue) may carry a merge script that does not know it (a custom `merge.command` runs the branch's own script), so `P merge` and the dry run refuse it as `queue-branch-predates-switch`; there `P update-branch --pr N` DOES catch it up in queue mode when the refusal says `branchState: predates` (output `queueCatchUp: true`; no merge hold), then `git pull --ff-only`, re-verify, a review round (base-only), `P review-complete` and ask the owner again. For `branchState: unknown` (the base's marker is missing, malformed, names a commit GitHub does not know or names a commit that is not on the base) an update cannot help: `P update-branch` answers `queue-mode` with no PUT and the marker on the base must be added or fixed (no review round); a GitHub read error answers `queue-unreadable` (the dry run's blocker has that kind too, not the predates one): try again, and a head GitHub does not have (not pushed yet) says to push it first. `owner-merge.md` (Merge as a job) has the merge-job outcomes. Queue off ⇒ everything above as today.
3. **STOP** (outcome `awaiting-owner-merge`; `owner_approval: label` with a blocking item parks instead, no merge request): run the stop ritual first, then tell the owner in plain English what changed, the PR link, the review outcome and
   follow-up issues.
   Then Read `reference/owner-merge.md` (section 3.3) and end the reply exactly as it says: which ending applies depends on the item note from 1.5 (as refreshed in step 2)
   (a `blocking` item ⇒ the repo's `merge.command`; otherwise `P merge --pr N --dry-run --owner-go` and its closing lines). The owner says "merge" ⇒ `P merge --pr N --owner-go` as a job
   (`P job start merge -- …`), never `gh pr merge` yourself. The block order is Rulings (when present), Areas, Hold, Head, 🔀; copy it from the dry run, never type the digest. Read the dry run whole: grep or a single-key `jq` drops the Rulings block. The closing lines look like:
   `Head <sha12> · items <digest> · repo <owner/name>`
   `🔀 Ready to merge #N — say "merge"`
