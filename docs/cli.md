# pipeline CLI reference

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs <command>`. Commands live one per file in `pipeline/commands/` and export
`meta.summary` and `meta.usage`; the usage blocks below are copied from `meta.usage` (a test fails if they drift) and
the same text is printed by `P <command> --help`. `P --help` lists every command.

Every command prints ONE JSON object on stdout (human text goes to stderr). Exit codes: **0** ok · **1** check failed /
blocked · **2** usage or environment error (also: unknown command, unknown flag) · **3** a dependency is unavailable
(Codex, GitHub, a deployment that never finished). Flags after a bare `--` belong to the command being run (`job start`).
`--repo DIR` (default: the current directory) is accepted by every repo-scoped command and resolves to the repository top level.

## agent-log

queue a line for the agent log, publish queued lines to the `pipeline-agent-log` branch, or close pending prod-smoke lines. The log lives on that orphan branch (like `pipeline-artifacts`), never in a PR branch.

```
pipeline agent-log queue --line "<line>" [--repo DIR]   -> {ok, queued, file}; a line already in the queue is not added again
pipeline agent-log publish [--line "<line>"] [--repo DIR]   -> {ok, branch, commit, pushed, lines, remaining}; queues --line, drops lines the log branch or origin/<default> already has,
  appends the rest to config.agent_log on the orphan branch pipeline-agent-log and pushes ONLY that ref (never forced; a lost race is retried on the new tip);
  the caller's HEAD, index, branches and working tree are never touched, nothing is committed to a PR branch. Published entries leave the queue only after
  the push succeeded; exit 3 when the push or the network fails (the lines stay queued for the next run, a note in the summary is enough);
  the log branch is untrusted data: a commit holds ONLY the log file, the file is read only as a regular file under 5 MB (a bigger one: exit 1, error log-too-large, lines stay queued), existing lines are only appended after
pipeline agent-log stage [--pr N] [--line "<line>"] [--repo DIR]   -> DEPRECATED alias of publish (older skills call it): never commits into the worktree or PR branch;
  prints {ok, deprecated: true, committed: null, ...publish's fields}. With --pr N the run's line (--line, or the default "merged — prod smoke pending" line built from the PR title; exit 3 when GitHub cannot be reached)
  is QUEUED HELD for PR N, not published: a later publish (or stage) publishes it once PR N is MERGED, drops it when N was CLOSED unmerged, and keeps it while N is open
  or GitHub is unreadable (held entries count in remaining, and in held); publish asks GitHub only when a held entry exists
pipeline agent-log close [--queue] [--pr N]... [--all] [--repo DIR]   -> {ok, lines, pending, skipped, unreadable, originReadable, originRefreshed, queued?, scanError?}; for every "prod smoke pending" log line reads the
  bot-authored prod-smoke-result comments on that PR (production.watch: workflow) and prints one resolution line per PR whose newest result
  is not logged yet (never an earlier minute than the newest logged one; the same minute only when the line differs); the log read is the worktree log plus the origin/<default> copy plus the log branch copy; one repo-wide read of the comments since the last successful read on this machine (at least 14 days)
  finds new results on any PR (a hit only triggers reading the whole comment history of that PR), and a PR is read on its own only when it has no
  resolution line, is the newest pending PR, is named by --pr N (repeatable) or --all is given (a resolved PR the scan did not mention is `skipped`,
  costing no call); a dry run unless --queue (queues each line like `queue`, a line already queued is not added again; never commits; only --queue advances the scan window, and only when the origin/<default> copy of the log was readable AND the fetches of origin/<default> and the log branch succeeded, else originReadable / originRefreshed is false and a note goes to stderr); exit 1 when some
  PRs could not be read (`unreadable`; the lines for the others are still produced and queued: still run `publish` and name them in the summary), 3 when GitHub is
  unavailable (skip the close, still publish)
```

Exit: 0 ok · 1 some PRs could not be read (close; the others are still processed and queued), or the log on the branch is over 5 MB (publish; lines stay queued) · 2 usage / config · 3 GitHub cannot say, the push or network failed (publish; lines stay queued), or queue lock timeout.

## arbiter

decide which items need the arbiter, then prove and apply its rulings.

```
pipeline arbiter needed --round R [--force] [--repo DIR]
  -> {needed:false, items:[], mode} | {needed:true, mode, items, inputPath, digest, digest8, tag, promptHeader[, diffPath, scope]}
  mode review (a Fable round: medium/high risk or a sensitive path): always needed, even with zero items, until a proven pass is applied
    (then {needed:false, done:true}); the input carries the diff to review (scope whole-pr the first time, round after that)
  mode review in a terminal whose Claude Code build is older than the installed one (stale): exit 1 {ok:false, error: stale-terminal, restartRequired: true,
    claudeCode: {running, installed, stale}, advice} BEFORE any input is written (no Fable spend); restart the terminal, then run needed again; unknown versions (stale null) do not stop it;
    the stop is saved as round.arbiter.failure {cause, advice, at}
  a retry clears an unproven or malformed ruling (model-proof / invalid-arbiter, in either mode) so the arbiter answers again; the owner's and Claude's rulings are kept; an item the arbiter no longer needs is settled by the judge again
  mode dispute (a judge round): only the items the dispute rules send; {needed:false} when there are none
  start the arbiter prompt with promptHeader, pasted verbatim (the two lines ROUND: / INPUT-DIGEST:): without them `arbiter apply` cannot prove the arbiter saw this input and marks every item needsHuman
pipeline arbiter apply --round R [--tag TAG | --agent-id ID] [--projects-dir DIR] [--max-age-ms N] [--repo DIR]
  the proof is pinned to claude-fable- at effort high; --expect-model / --expect-effort are honoured only with PIPELINE_TEST_MODE=1 in a repo checkout (an installed copy ignores it)
  -> {ok, round, tag, transcript, errors, items[, findings]}; exit 0 proven + applied, 1 unproven (every arbitrated item needsHuman), 2 no transcript
  any Fable on any line of the transcript must be at least this machine's floor (whatever --expect-model says): older => exit 1, error stale-model,
    restartRequired: true, floor: {newest, seen}, advice (restart this terminal, or update Claude Code); the items wait with cause stale-model. A proven pass
    with a newer Fable raises the floor (only a transcript under the account's own projects folder, no --projects-dir; exit 1 model-floor-busy / model-floor-unwritable otherwise unproven)
    just before it raises or saves anything, apply checks it still holds the floor lock and reads the floor again: lock gone => exit 1 model-floor-busy, floor now above the proof => exit 1 stale-model; either way nothing is saved but round.arbiter.failure
  a proof that passed only through an owner allowance (an id the parser cannot read) or a hold below MIN_FABLE adds floor: {newest, allowed: [ids], heldBelowMin: <hold>|null} to the output
    and allowed / heldBelowMin (each only when present) to round-N/model-proof.json and the round's stored modelProof summary
  an apply that fails on the floor (stale-model, model-floor-unreadable, unrecognised-fable, model-floor-busy, model-floor-unwritable) saves round.arbiter.failure {cause, advice, at} and prints the same `advice` in its output;
    model-floor-busy: run apply again in a minute; the other causes are not fixed by another Fable pass
    (a zero-item Fable round has no item to carry the cause); the next apply that proves clears it
  mode review: the answer must also carry `findings` (Fable's own review, [] when clean); proven findings become items R<n>-F<k>;
    unproven ones are kept in rulings.json as `unverifiedFindings` and the round stays Fable-pending (run needed + the arbiter again)
```

Exit: `needed`: 0 (`needed:false` is also 0) · `apply`: 0 proven + applied, 1 proof failed (arbitrated items marked needsHuman), 2 no transcript found / usage.

`needed` on a Fable round from a terminal that runs an older Claude Code than the installed one (`claudeCode.stale`) exits 1 `stale-terminal` with `restartRequired` before it writes anything: restart the terminal, then run `needed` again (an unknown version never stops it). That stop, and an `apply` that fails on the Fable floor (`stale-model`, `model-floor-unreadable`, `unrecognised-fable`, `model-floor-busy`, `model-floor-unwritable`), is saved as `round.arbiter.failure {cause, advice, at}`, shown by `state outcome` (`arbiterFailures`) and in the triage comment (`Round R arbiter stopped: <cause> — <advice>`); an `apply` that proves clears it.

A Fable review round (`fableRequired`, set by `codex-review`) is not clean until `apply` proves a pass, even with zero
Codex items: `state outcome` lists it in `fablePending` and `review-complete` refuses. A failed proof leaves it pending:
run `needed` again (it clears the unproven rulings, keeps the owner's) and start the arbiter again. `triage validate`
refuses a Fable round (`fable-round`): there is one reviewer after Codex.

## artifacts

publish UI screenshots to the pipeline-artifacts branch and print PR-body markdown.

```
pipeline artifacts push --pr N --dir DIR [--repo DIR]   -> {ok, files:[{name, markdown}], skipped:[{name, reason}]}   (png/jpg/jpeg/webp/gif, max 20 files, each <= 5 MB)
```

Exit: 0 pushed (or nothing to push) · 2 environment / git error · 3 GitHub (`gh`) unavailable.

## checkpoint

record where the review run stands in the PR summary comment (refuses unless local HEAD is the pushed PR head).

```
pipeline checkpoint --pr N --step build|verify|pr|review|gate|awaiting-owner-merge|merge|ended [--next TEXT] [--detail TEXT]
                    [--request-file F] [--tasks-file F] [--task-done ID] [--verify-report] [--round R] [--resumed] [--repo DIR]
  -> {ok, url, action, record, warnings}; exit 1 {error: unpushed | behind | diverged} (local HEAD is not the PR head on GitHub), 2 usage, 3 GitHub unavailable
  --request-file: the user's request, text, at most 2 KB · --tasks-file: JSON [{id, title, spec}] · --task-done ID: mark one task done (repeatable)
  --resumed: this run was taken over from an earlier session (or adopts a PR): stamps record.resumed {at, host, head}, which later checkpoints keep and which makes `P merge` require the owner's recorded "merge" (--owner-approved-head + --owner-approved-items)
  --verify-report: copy {head, tree, mode, ok, failedStep} of the verify report, only when its head and tree are this HEAD's (otherwise a warning)
```

Exit: 0 recorded · 1 `unpushed` (local HEAD is ahead of the PR head on GitHub: push first) / `behind` (the PR has newer commits: pull) / `diverged` (neither is an ancestor of the other, or the PR head is not fetched here: nothing is written) · 2 usage (unknown `--step`, a `--request-file` over 2 KB or not text, a bad `--tasks-file`, a record from a newer pipeline version) · 3 GitHub (`gh`) unavailable.

`--resumed` is passed by a session that takes over a stalled run (or adopts a PR) as its first checkpoint (kept so records written by the removed `ship resume` stay guarded): it stamps `record.resumed` `{at, host, head}`, which later checkpoints keep, and which makes `merge` demand the owner's recorded "merge" for the exact head and owner-item set (`--owner-approved-head` + `--owner-approved-items`, checked against the owner-go records). It sets the heartbeat (`os.hostname()` and the time) and keeps the summary sections already in the comment. `--verify-report` copies the report at `verify.report` only when its head and tree are this HEAD's; otherwise it is ignored and `warnings` says why. A step other than `ended` / `awaiting-owner-merge` clears a previous `outcome` (the run is going again).

## ci-wait

wait until the required CI of a ready PR is really done (ignores a draft-era skipped run), then report the verdict.

```
pipeline ci-wait --pr N [--repo DIR] [--appear-timeout SEC=300] [--timeout SEC=3600] [--interval SEC=15] [--wait-all]   -> {ok, verdict, head, readyAt, requiredSource, checks:[{name, appId, state, url}], message?, failures?, statusEvidence?, heldBy?, configChecks?}; verdict passed (exit 0) | failed | timeout | missing | stale-skipped | unverified | no-required-checks | head-moved | base-changed | draft (exit 1; a draft at the start: exit 2) | github (exit 3, 5 GitHub reads in a row failed)
```

Exit: 0 `passed` (every required check is pass or a fresh skip, the head and the base branch did not move, the PR is not a draft again) · 1 `failed` (a required check failed or was cancelled; names and urls in `message` and `failures`; a failure that predates the ready event and was never replaced stands at `--appear-timeout`, marked "result predates ready", or "superseded by a newer attempt that never reported" for a failure a newer attempt of the run was meant to replace; a failure read from a commit status is confirmed by one more read of the head's statuses first, so one a newer status already replaced is not reported, and `statusEvidence` lists the status ids and created_at it rests on) / `timeout` (a check stayed pending past `--timeout`, or an absent one was still held by a running ready-era run) / `missing` (a required check reported nothing within `--appear-timeout`, measured from the start of the command, and no check run or workflow run created after the ready event was still running on the head) / `stale-skipped` (only a draft-era skipped run exists: its workflow did not run on the ready event; re-run it or ask the owner) / `unverified` (branch protection or the rulesets could not be read, so the required set is incomplete: never a success; `configChecks` lists the checks the config names and their states) / `no-required-checks` (neither protection nor a ruleset requires any status check) / `head-moved` / `base-changed` (the PR was retargeted to another base branch, same head: its required checks are those of the new base, so the wait restarts; `newBase`) / `draft` (the PR went back to draft) · 2 a draft at the start (`gh pr ready` first) or usage · 3 `github` (5 GitHub reads in a row failed; a single failed read is retried on the next poll).

It decides WHEN CI is done, not whether to merge: `pipeline merge` re-proves guard-status provenance and re-reads CI live. The required set is the union of classic branch protection (`branches/<base>/protection`, shared with `protect`) and the `required_status_checks` rules of `rules/branches/<base>`; each source is `present`, `absent` or `unreadable` (reported in `requiredSource`). Results come from the REST check-runs and status lists of the head (every page). An identity pinned to an app (`app_id` / `integration_id`; -1, null or missing = any app) matches check runs of that app, and a status only when its creator is the app's known bot (15368 `github-actions[bot]`, 8329 `vercel[bot]`); an unknown app's status never satisfies a pin. The latest check run per name and app is the one with the highest id (a re-run gets a new id), never the latest start time. A SKIPPED run counts as done only when its workflow run was created at or after the latest `ready_for_review` event (the PR's creation time if it was never a draft). A FAILED or CANCELLED result is judged the same way, except that a check run is dated by its workflow run's `run_started_at` (a re-run keeps `created_at` and moves `run_started_at`, so a re-run started after ready that then failed is a fresh failure; a run with no `run_started_at` falls back to `created_at`; a failure whose own completed/started time is earlier than the start of an attempt 2 or later is dated by its own time, since it belongs to the previous attempt), else by its own completed/started time; a status by its created_at. A draft-era failed or cancelled result is `stale-fail` and keeps waiting like a draft-era skip until `--appear-timeout` for the ready-era result to replace it (EW's `Cross-model review` status is a draft-era failure until it is re-posted after `gh pr ready`), while a fresh failure ends the wait at once. A ready-era failure of an earlier attempt that a newer attempt of the same workflow run has superseded (own completed/started time after ready but before the latest attempt's start, attempt 2 or later) is `superseded`: it does not end the wait, the newer attempt's check run (higher id) replaces it and decides. If the newer attempt never reports for that identity, the stale-failure deadlines apply: `--timeout` (verdict `timeout`, `heldBy` naming the run) while a ready-era run still holds the wait, else `failed` at `--appear-timeout` marked "superseded by a newer attempt that never reported"; a superseded failure is never a pass. A re-run's SKIP is not dated that way: a re-run replays the draft-era payload, so a skip stays on `created_at` and is `stale-skip` until a run created after the ready event replaces it; freshness that cannot be read counts as fresh. A FAILED `Cross-model review` status has a second rule, for an already-ready PR that got a new head: the guards run posts it as a failure until `pipeline review-complete` posts the marker comment for that head, and the recheck then re-posts it, so a failure created strictly before the newest comment (by created_at) that parses as a review-complete record for the head being waited on is `stale-fail` too (marked "result predates ready" if never re-posted; equal instants are not stale). The failure is ALSO stale when its `target_url` is a GitHub Actions run (`.../actions/runs/<id>`, a job suffix is ignored) whose `run_started_at` (else `created_at`) is strictly before that comment: a guards run that started before the marker can still publish its failure a few seconds after it, until the recheck cancels it. That run is read lazily (`gh api repos/<slug>/actions/runs/<id>`), once per run per poll; an unreadable run or time, or a url that is not an Actions run, leaves the created_at rule alone. The PR's comments are read lazily, only when such a failure needs dating, once per poll and again in the confirming re-read; the author and edit state of the comment are not checked (freshness only: it can turn a fail into a longer wait, never a pass); an unreadable comment list or a marker with an unreadable created_at is ignored, leaving the ready-event rule alone. Other contexts and check runs are unaffected. A draft-era success is not second-guessed. `--appear-timeout` is not final while the head still has an unfinished check run or workflow run (queued, in progress, waiting, pending) that could produce what is absent: the wait then goes on up to `--timeout` and the output carries `heldBy` ({kind: check-run | workflow-run, id, name, status, createdAt, url, predatesReady}, the run that last held the wait), because a `needs:`-gated aggregate job (EW's `Typecheck + Vitest`, a `test (windows)` aggregate) is only created when its shard jobs finish, 8-22 minutes after ready. Which runs hold depends on what is absent. A run created or (re-)started (a re-run keeps its `created_at` and moves `run_started_at`) at or after the ready event always holds, `predatesReady: false`. While at least one required identity is `missing` (no producer at all), a run that started BEFORE the ready event holds too, `predatesReady: true`, because a draft-era push may already have started the tests whose aggregate is still to come (PR #196: the push while draft ran the tests, `gh pr ready` came 4 minutes later, the aggregate appeared 22 minutes after that); a draft-era SUCCESS of that run counts as a pass (the documented residual). Such a run holds only if it could produce a missing identity: for one pinned to an app, a check run of that app, or, for GitHub Actions (15368), a workflow run; an unpinned identity accepts any run. A run whose age cannot be read holds a missing identity as well, `predatesReady: null`. When only `stale-skip` / `stale-fail` / `superseded` identities are absent, a run that started before ready never holds (its result would be stale too), and when the missing identities resolve into draft-era results while such a run is still going, the hold ends with the stale verdict (`stale-skipped` / `failed`). A verdict that would end the wait is confirmed by one more read of the head's check runs and statuses first (#168). `--wait-all` records failures and keeps waiting until nothing is pending, missing or stale-skipped (for a label-mode run that expects some guard checks red); a deadline still ends it with its own verdict. Progress goes to stderr when the waiting set changes.

## codex-review

run one Codex review round over base..head and record its findings.

```
pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]
  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, reviewer, reviewerReasons, path}
  --base must be the PR's merge base for round 1 and the previous round's toHead after that, else exit 2 {error:base-mismatch}
  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head, an empty commit,
    an amend); the message names the accepted items still waiting for a fix, or says the content is what round N reviewed. Never for a round that only merged
    the base branch in (below): that is recorded as baseOnly even when the content hash did not move
  exit 2 {error:round-cap} past review.max_rounds, except ONE extra round when the last round only accepted fixes (state outcome extraRound)
    or ONE round per owner grant (owner_approval: chat only): the owner typed "extra round" after a reply ending with the line triage round-request
    printed, for this repository, PR, counted round and head (an owner record younger than 24 h; the automatic extra round is used first). The
    grant is claimed AFTER Codex answered, under the final lock, as the last step before the state is saved, by exclusively creating a machine-global marker (one grant admits one run on
    this machine): a grant already used, or recorded for another head ("ask again"), is exit 2 round-cap; Codex exit 3, head-moved and a kill before the claim
    leave the grant open (a failure after the claim spends it: ask again). Success adds grantUsed:{grantId}; the round records admission and ownerGrant {grantId, k, quote, ownerTs}
    base-only rounds and resolution-only rounds (below) never count toward the cap
  reviewer: fable (medium/high risk or a sensitive path: risk.high_risk_paths, review.arbiter_always_paths) records the round as fableRequired
    (the Fable pass must run: arbiter needed/apply) and gives Codex an attacker's brief for the sensitive files; judge otherwise. Once fable, always fable
  confirm fixed: an accepted item that a forced or Claude ruling marked implemented through files other than the one it names (state mark-implemented,
    implementedVia other-files) is listed in the prompt of the next round that runs Codex (not a base-only one), with its original finding fenced as untrusted
    text: Codex says whether it is really fixed and raises it again as BLOCKING when it is not. The round records round.confirmFixed:[ids] (absent when none)
  commits merged in from the PR's base branch since the previous round are left out of the reviewed diff; a round that only merged them in
    is recorded without running Codex: {ok:true, baseOnly:true, counts all 0}
  when that merge conflicted and the resolution only chose lines the two sides already had, Codex reviews just the resolution:
    {resolutionOnly:true, conflicted, conflictedCount}; the round is a real review but does not count toward the cap. Otherwise
    the whole PR is reviewed as before (a counted round) and {resolutionIneligible:"<reason>"} says why the resolution was not
    taken alone
  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver
  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)
```

Exit: 0 round recorded · 2 usage, base-mismatch or round-cap · 3 Codex or GitHub could not deliver (quota, auth, unavailable, error, malformed, github): never "no findings".

A later round is diffed against what the previous round reviewed plus the PR's base branch as it is now (a trial merge, `reviewBaseKind: synthetic`), not against the previous head itself, so commits an "Update branch" merged in from the default branch (`origin/<default_branch>`) are never shown to Codex: they were reviewed in their own PRs. Only the default branch counts: a PR that targets another branch, or code merged in from any other branch, is reviewed in full (nothing is left out, and Codex always runs). A stale `origin/<default_branch>` (the best-effort fetch failed) can only make the range bigger. When that trial merge conflicts (or git is older than 2.38), the round reviews the whole PR against the new base instead (`whole-pr`). Each round records `reviewBase` and `reviewBaseKind` next to `fromHead` / `toHead`. When that conflict was resolved only by choosing, in each conflict block, lines the two sides already had (nothing typed, nothing else changed, text files only, no PR work in the merge range, no merge/diff/eol attribute on the paths), the round is instead shown just the resolution (the trial merge with its conflict markers left in, `reviewBaseKind: resolution`) and is recorded as `resolutionOnly: true` with `conflicted`, `conflictedCount` and per-block `blocks` (`droppedTheirs`: base-branch lines the resolution dropped, named in the prompt; the stored list is cut to 50 blocks, dropped ones first, and `blockCount` / `blocksWithDrops` / `droppedTheirsTotal` are counted over all blocks). More than 1000 conflict blocks, or an unexpected stack overflow in the check, is not eligible (`too-many-blocks`). A `round-cap` refusal carries `resolutionIneligible` when the free round was tried. That is a real review (Codex, judge or Fable, an ACCEPT needs its fix round) that does not count toward `review.max_rounds`; any doubt keeps the counted `whole-pr` round and the output carries `resolutionIneligible`. On another clone `arbiter` rebuilds the marker tree from the round's commits (`review-base-unavailable` when it cannot, never another range). A round whose only new commit is such a merge is recorded as `baseOnly: true` with no items and Codex is not run; it does not count toward `review.max_rounds`, and it is not a review: it carries the last reviewed round's result forward to the merged-in content, so the outcome is clean only if that reviewed round was (fixes it accepted still need a reviewed round). `state mark-implemented` measures "a non-test file changed since round N" the same way and fails closed: when that range cannot be worked out exactly (conflicting trial merge, git error) it refuses with `base-unresolved`. A file counts only when it changed since the round AND its current content was written by an ordinary (non-merge) commit of the PR, not by a merge or by the default branch: a line typed into a merge commit is never the fix (`no-code-change`, naming the files).

## comment

render and upsert a pipeline PR comment (triage, summary, needs-human, blocked, awaiting-review).

```
pipeline comment --pr N --kind triage|summary|needs-human|blocked|awaiting-review [--outcome O] [--built TEXT] [--reason TEXT] [--hits-file F] [--repo DIR]
  --kind triage publishes the review state under the review lock as a compare-and-swap on its content (lib/review-publish.mjs): it is refused
  (exit 1 {ok:false, error:'stale-publication', reason}) when the PR holds a state this copy neither published nor restored: run `pipeline state show --pr N`
  and redo the decision; {action:'unchanged'} when the PR already holds exactly this state. The other kinds take no lock.
  --kind blocked renders the verify report's failure; with --reason TEXT it renders a "the review stopped: TEXT" comment instead (no report needed), e.g. the advice of a stop that waits for a terminal restart.
```

Exit: 0 comment posted/updated · 2 usage · 3 GitHub (`gh`) unavailable.

## config

load and validate .claude/pipeline.yml.

```
pipeline config [--repo DIR]   -> {ok, path, config}; exit 2 when missing or invalid
```

Optional `merge.hold_command`, `merge.hold_release_command` and `merge.hold_check_command` (all three or none) are documented under Merge hold in the `merge` section.

Exit: 0 valid · 2 missing or invalid (`errors` listed). A valid config may carry `warnings` (e.g. `ci.required_checks` omits the guard contexts `Test integrity` / `Hard-stop scan`, or `verify.stop_queue_wait_minutes` is above 0 and a leftover Stop hook running `stop-verify` in `.claude/settings.json` has a `timeout` below 900 + minutes * 60 seconds). `verify.stop_queue_wait_minutes` (integer 0..30, default 0) is retired together with the Stop hook (`stop-verify`) and nothing reads it; it is still accepted so a config that sets it validates. `ci.review_check` (boolean, default false) adds the `Cross-model review` status to the guard workflow and to every required-check list (preflight, `protect`, the final gate); `true` with `ci.guard_checks: false` is an error (nothing would post it). Turn it on in the same change that applies branch protection with it.

## cost

book tokens / USD / retries of one agent call in the run record (shown by `P summary`).

```
pipeline cost --pr N --phase build|verify|pr|review|gate|merge|... --role implementer|judge|arbiter|verifier|controller|other
              [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X | --model M] [--from-transcript FILE] [--retry] [--session ID]... [--repo DIR]
  -> {ok, recorded, cost, warnings}; exit 2 usage (a negative or non-numeric amount), 3 GitHub unavailable
  An unknown --role is booked as `other`, an unknown --phase as `other`. --from-transcript FILE: sum the message.usage of a Claude transcript (JSONL, at most 50 MB);
  explicit --input/--output/--cache-* then add to it. --retry alone (no amounts) only counts a retry.
  USD: --usd X as given; otherwise the list price of each transcript message's own model version (--model M prices the messages that carry none)
  plus the explicit tokens at --model M. Tokens with no known model add no USD (a warning says so). Priced tokens are also booked in
  cost.byPrice (keyed model|tier|speed) so a later price table can re-price them; output `bucketed` says whether this entry carries them.
```

Exit: 0 booked · 1 the run record could not be written (`warnings` says why) · 2 usage · 3 GitHub (`gh`) unavailable.

Cost attribution (issue #57): the run record gets a `cost` section {total, byPhase, byRole, retries, guardBlocks, sessions}, each of total / phase / role holding {input, output, cacheRead, cacheWrite, usd, calls}. Phases are the record steps; roles are implementer, judge, arbiter, verifier, controller and other (an unknown phase or role is booked as `other`). Records written before this have no `cost` section and everything that reads it treats that as "nothing booked". `P summary` shows the totals and both breakdowns in the status block and as `cost` in its JSON. `--session ID` (on `cost` or `summary`) names a Claude session of the run; `summary` counts the guard denies of those sessions in `<home>/.claude/pipeline-state/guard-log.jsonl` (override with `PIPELINE_GUARD_LOG_FILE`) into `guardBlocks` and keeps each session's own count in `guardBySession` ({sessionId: denies}, at most 20 sessions, `null` while the count is unknown; shown as `(s1 2 · s2 0)` after the status-line count). A missing log leaves the count unknown (shown as a dash), unreadable lines are skipped and reported in `warnings`. The numbers are display only: no command decides anything from them. The amounts are what the caller books (`--from-transcript` sums a transcript's own usage counts; the USD figure is whatever `--usd` says).

List prices (USD per million tokens; the claude-api table of 2026-11-03, `PRICE_TABLE_DATE` in `lib/run-cost.mjs`), as [input, output, cache read, cache write 5 min, cache write 1 h]: `claude-fable-5-2` [8, 40, 0.20, 10, 16]; `claude-fable-5-1` [10, 50, 0.25, 12.5, 20]; `claude-fable-5` [10, 50, 1.00, 12.5, 20]; `claude-opus-5-5` [4, 20, 0.20, 5, 8]; `claude-opus-5`, `-4-8`, `-4-7`, `-4-6` [5, 25, 0.50, 6.25, 10]; `claude-sonnet-5-5` [2, 10, 0.10, 2.5, 4]; `claude-sonnet-5` [2, 10, 0.20, 2.5, 4]; `claude-sonnet-4-6` [3, 15, 0.30, 3.75, 6]; `claude-haiku-5-5` [0.10, 0.50, 0.01, 0.125, 0.20] for a prompt of at most 100,000 tokens and [0.50, 2.50, 0.05, 0.625, 1.00] above; `claude-haiku-4-5` [1, 5, 0.10, 1.25, 2]. A model id is looked up exactly (an 8-digit date suffix and a `[1m]` suffix are dropped), else it is priced as the newest row of its family (`claude-fable-5-3` as Fable 5.2; the bare names `fable`, `opus`, `sonnet`, `haiku` that `--model` takes mean that row), else it is unpriced. Prices are an estimate, not a bill, and old records are never re-priced.

`usageFromTranscript` splits a message's cache writes by `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` when the transcript has them (anything beyond the two parts, or the whole count when there is no split, is 5 min); `cacheWrite` in the totals stays the 5 min + 1 h sum. Haiku 5.5's tier is decided per message: input + cache read + cache write (5 min + 1 h) above 100,000 tokens takes the higher row, exactly 100,000 does not. **Fast mode** (`usage.speed: "fast"`) prices input and output at 16 / 80 for Fable 5.2 and 8 / 40 for Opus 5.5; the fast cache prices are not known, so a fast message with any cache tokens (or of a model with no fast price) is counted in `unpricedMessages` and adds no USD rather than a guess.

**Repricing buckets.** A cost entry priced from a transcript (or from hand tokens given with `--model`) also carries `byPrice`, summed into `cost.byPrice` and shown in the `cost` JSON of `P cost` and `P summary`: keys `"<model id>|<tier std|>100k>|<speed std|fast>"`, each `{input, output, cacheRead, cacheWrite5m, cacheWrite1h, messages}`. Every dimension the price depends on is a key or a field, so a later table can re-price a record exactly; that holds while the tier boundaries are unchanged (a table that moves the 100,000 boundary cannot re-bucket old messages). Unpriced messages are bucketed too, so a later table can price them. `cost.priceTables` counts the bucketed entries per table date (`{"2026-11-03": 2}`; a record priced under two tables shows both, and `P summary` prints it as one `Priced with table` line). A hand entry (`--input` etc. with no `--model`) and any entry with `--usd` carry no buckets, and the `P cost` output says `"bucketed": false`; hand tokens without a model next to a transcript stay out of the buckets (also `bucketed: false`). Records written before this have neither field, and every reader treats that as "nothing bucketed".

## final-gate

prove this PR head is verified, reviewed, and CI-green; writes .review/final-gate.json.

```
pipeline final-gate --pr N [--repo DIR]   -> {ok, repo, pr, base, head, tree, contentHash, checks[{name,ok,detail}], failed[], at, proofs?}; exit 0 all checks pass, 1 any fails (pr-open detail starts "behind-base:" when the PR is behind its base: update the branch and re-verify), 3 GitHub unavailable
```

Exit: 0 every check passes (writes .review/final-gate.json) · 1 any check fails · 3 GitHub (`gh`) unavailable.

Owner-granted rounds (`owner_approval: chat`): a counted round past `review.max_rounds` and its one automatic extra round exists only because the owner typed `extra round` (see `triage round-request` and `codex-review`). The `review` check does not believe the review state for that: it re-proves every round that carries an `ownerGrant` against the owner's record (the owner-go hook's file for the session, read at any age) and its machine-global marker (`consumed/<grantId>.json` in the same folder): same repository, PR and counted round, the marker's head is the round's head, and the quote is the record's words byte for byte. A counted round past max+1 without a verified grant, a round recorded as owner-admitted without one, and a round past max recorded as a normal admission all fail `review`. A passing detail shows `owner-granted round K: "<quote>"`; a grant is never an owner-merge item (it lets a round run, it approves no merge). The records live on the machine where the owner typed, so run the gate (and `review-complete`) on the machine that reviewed a granted round; elsewhere it fails with "round n: owner grant cannot be verified on this machine", and the way out is running the gate on that machine; `P state discard-round --pr N --round n` (then `P triage round-request` and asking the owner again) applies only to an unpublished trailing round, and is refused with `round-published` once the round is in the triage comment. The gate and `review-complete` take the cap from `review.max_rounds` in the config, never from the state: a state that records a larger or non-finite `maxRounds` fails the `review` check. `state outcome` reports `grantedRound` (the open grant) and `autoExtraOrdinal`.

The owner-go hook records three kinds of chat words, each only for a prompt the owner types after a reply ending in the matching CLI-printed line: `merge` (the 🔀 line), a ruling answer (the ⚖️ line) and `extra round` (the 🔁 line). The hook also fires for harness-injected turns (task notices, other sessions' messages, scheduled turns), which no recorder keeps; and a record is used only while its prompt is still the owner's in the transcript (#128), for an `extra round` exactly as for a `merge`: a grant whose prompt is synthetic or gone from the transcript admits no round (`codex-review` says it "cannot be confirmed as typed by the owner") and fails the `review` check (`provenance`). A pending ruling, 🔀 merge or extra-round request survives a context compaction: the summary entry Claude Code writes (`isCompactSummary` and `isVisibleInTranscriptOnly`) opens no reply slot and its own text never counts (#189). A ruling asked in a turn started by a notice the terminal shows (`promptSource: system`, `entrypoint: cli`: a task notice, a subagent hand-back) whose reply ENDS with the ⚖️ line, with nothing surfaced after it, is itself the pending ask (this narrows the 2026-11-03 rule that any text in such a reply voids the ask; an sdk / `claude -p --resume` turn never counts). No answer typed while the agent was busy (`promptSource: queued`) records or approves anything, for a `merge`, an `extra round` or a ruling alike (the transcript cannot tell what was on screen when the owner typed, and such a prompt is delivered after everything the agent printed meanwhile): the hook prints one line saying so (the owner-go hook never blocks), and the agent re-runs `P merge --pr N --dry-run --owner-go` / `triage round-request` / `triage ruling-request`, shows the FRESH closing lines and asks once more after the reply ends; the refusal texts of `merge`, `codex-review` and `triage owner-ruling` name this case too (#191). A turn the terminal does not render (a headless `claude -p --resume` turn, any non-human origin that is not a harness notice, a prompt source Claude Code adds later) binds nothing: its text is never the request a `merge` or `extra round` answers, and it voids a pending ruling ask when it shows anything.

The `guard-files` hook keeps those session transcripts from being forged (#128). Program text it cannot read as a path (a `python3 -c`, `node -e` or heredoc body with a call or an index) that names a Claude Code config root (`$CLAUDE_CONFIG_DIR`, the configured root, or a `.claude*` folder under the home, however the path is built, including a quoted piece with a path tail such as `'.claude/projects/-repo'` next to a real home lookup) is refused whatever it does, read or write, with or without a `projects` or `.jsonl` word (R6-B1, R6-F1, R7-B1, R7-F2): no list of write verbs can keep up with the ways a program can write a file. A `projects/<proj>/memory` path in such a program no longer excuses it: memory notes are written with the Write tool or a shell `cp`, whose literal-path rules are unchanged. A program that names no config root stays allowed, and a repo's own `.claude/` (also under a `/home/...` path) is not the config root. Renaming or obfuscating the root name in the program text (a name built at run time) is a known residual, tracked in issue #154.

`proofs` appears only for a repo with `verify.deferrable_steps`, when `verify-report` passed: `[{step, source: "local"}]` for a step the Mac ran, `[{step, source: "ci", run: {id, attempt, jobId, workflow, job, url}}]` for a step a GitHub Actions run vouched for (a report row `skipped` with `skipKind: "ci"`). The gate reads `deferrable_steps`, `ci_proof` and `ci_proof_inputs` from the BASE branch's `.claude/pipeline.yml`, never the PR's, and takes the proof only when ALL hold: the PR touches none of `.github/**`, `.claude/pipeline.yml`, `scripts/verify*` or `ci_proof_inputs`; the newest `pull_request` run of the configured workflow file for this exact head belongs to this PR (one `pull_requests` entry, this PR into the base branch, its head branch, a head from this repo, not a fork); the merge commit that run executed (`refs/pull/N/merge` in `referenced_workflows`) has the same tree as the PR head (a run that does not say is not accepted); and exactly one job there has the configured name and succeeded (when the `ci_proof` entry also lists `steps`, each named step must appear exactly once in that job as completed + success; a skipped, missing, repeated or failed step is `ci-proof-missing:<step>`, and the `run` in the proof then also carries `steps`). A newer queued or running run is `ci-proof-pending:<step>`; a red job is `ci-proof-failed:<step>`; everything else, including any GitHub error and a cancelled or skipped run, is `ci-proof-missing:<step>`: the Mac must run the step. `pipeline merge` re-evaluates the proof live and records the one it used.

## followups

open an agent-suggestion issue for each FOLLOW-UP item of a round.

```
pipeline followups create --round R [--repo DIR]
  -> {ok, round, created:[{id, number, url}], reused:[{id, number, url}], duplicates:[{id, canonical, others:[url]}],
      skipped:[ids already filed], held:[ids waiting for a human]}
  one issue per fingerprint across the whole review; a FOLLOW-UP that needs a human is held, not filed.
  Each issue body starts with <!-- claude-pipeline:followup pr=N fp=FINGERPRINT -->; before creating, an issue of ours
  (any state) with that marker is REUSED (several: lowest number is canonical, the rest are listed, never closed)
```

Exit: 0 · 2 usage / no state · 3 GitHub (`gh`) unavailable.

## guard-log

count guard denies per day and reason code from the deny log.

```
pipeline guard-log [--days N] [--file PATH]   -> {ok, file, days:{YYYY-MM-DD:{total,byCode}}, total, perDay, skipped}; default 7 days
```

Exit: 0 (a missing log is an empty summary) · 2 usage.

Both guard hooks append one line per deny to `~/.claude/pipeline-state/guard-log.jsonl`: `{ts, session, hook, reason_code, cmd_hash}`. The command and reason text are never stored (`cmd_hash` is the first 16 hex of the command's SHA-256). The file rotates to `guard-log.1.jsonl` past 5 MB; `PIPELINE_GUARD_LOG=0` turns the log off. `perDay` is the total divided by the days that have entries; lines that cannot be read are counted in `skipped`.

## hardstops

list hard-stop hits for a branch diff (exit 1 on blocking hits unless human-approved).

```
pipeline hardstops --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, approved, hits, blocking, advisory, ownerMerge}; exit 1 when blocking hits and not approved (ownerMerge = hits the owner merges in chat, owner_approval: chat)
```

With `owner_approval: chat` in pipeline.yml every would-be-blocking hit is returned as `advisory` + `ownerMerge` (also listed under `ownerMerge`; the owner merges them by saying "merge" in chat) and the exit is 0.

Exit: 0 no blocking hits (report-only hits, `advisory`, are listed but never block), or blocking hits approved by `human-approved` · 1 unapproved blocking hits · 2 usage / config.

## integrity

check that a branch diff does not weaken tests (exit 1 unless test-change-approved).

```
pipeline integrity --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, overridden, violations, base, head, ownerMerge?}; exit 1 when not ok (owner_approval: chat: always ok, violations repeated under ownerMerge)
```

With `owner_approval: chat` in pipeline.yml violations never fail the check: they are also returned under `ownerMerge` and the owner merges in chat.

Exit: 0 ok or overridden by `test-change-approved` · 1 violations · 2 usage / config.

## job

run a long command detached (start), poll it (wait), or read its state (read).

```
pipeline job start [--repo DIR] [--tag TAG] NAME -- CMD...   -> {ok, name, jobDir, pid, runId, tag}; exit 1 {ok:false, refused:true, reason} when a guard denies CMD
  --tag TAG: what the job is about (default: the repo HEAD sha); keep the returned runId and hand it to wait/read as --run-id
pipeline job wait  [--repo DIR] [--run-id ID] NAME [--timeout SEC]   (default 540, max 570) -> {ok, name, state, tag, runId, exitCode?, tail}
pipeline job read  [--repo DIR] [--run-id ID] NAME   -> same shape, without waiting
  --run-id ID: the runId start returned; if the job name was started again since, state is "replaced" ({ok:false}, exit 1)
  exit 0: running, or done with exit code 0 · exit 1: done non-zero, lost, replaced, refused, name already running · exit 2: no such job / usage
  CMD is the argument list after "--"; arguments with spaces, quotes or shell metacharacters are quoted for the shell
  that runs the job (POSIX single quotes; on Windows double quotes), so each stays ONE argument. For pipes, &&, or
  redirects pass a shell explicitly: job start NAME -- bash -c "a && b".
```

Exit: 0 started / running / done with exit code 0 · 1 refused by a guard, done non-zero, lost, replaced, or the name is already running · 2 usage / no such job.

## labels

create or align the pipeline labels on GitHub.

```
pipeline labels ensure [--repo DIR]
```

Exit: 0 · 3 GitHub (`gh`) unavailable.

## merge

merge the PR if (and only if) the final gate passes again, live; waits for MERGED

```
pipeline merge --pr N [--owner-approved-head SHA --owner-approved-items DIGEST | --owner-go] [--repo DIR]   -> {ok, merged, mergeSha, warning?, warnings?, holdLifted?, commandExitCode?, localCleanup?, commandOutput?, note?} ; pipeline merge --pr N --dry-run [--owner-go] [--repo DIR]   -> {ok, dryRun:true, wouldMerge, blockers:[{kind, detail}], ownerStep} : the verdict without merging or writing anything (see --dry-run below) ; --owner-go (work that never ran the review skill: no final-gate.json) merges the local HEAD when the PR is open, not a draft, MERGEABLE, not behind its base, without a blocking label, every required check is green on that head, the scan of GitHub's own range merge-base(baseRefOid, HEAD)..HEAD passes (check scan-range: base commit present locally, no replace ref / grafts / shallow clone, GitHub's pulls/N/files list matches the local diff) and the diff has no blocking hard-stop or test-integrity violation, AND the owner-go hook recorded the owner's "merge" for this PR, that head, the LIVE items digest (items none when the diff has no owner item; a diff with chat-mode owner items needs a record for exactly their digest) and, for protected areas, the `Areas <ids>` line shown directly above the Head line (error live-check / owner-go / pre-merge otherwise, naming the lines to show; the last look re-reads baseRefOid and headRefOid and refuses when either moved, and on both routes refuses a PR body that lists several issues after one closing keyword ("Closes #1, #2" closes only #1; the dry run lists it as a pre-merge blocker); output mode owner-go, nothing written); a needs-human hold the request named (Hold line, hold field, lift wording; see docs/cli.md Owner-go) is lifted by that same owner word and put back whenever nothing merged (output holdLifted on a merge; holdRestored + holdRestoredNote, holdKept + holdKeptNote, holdRestoreUnverified + holdRestoreNote or holdRemovedByOther otherwise; error hold | hold-recovery | hold-restore | merge-in-progress; hold-restore carries holdRestoreFailed: true and exit 1; hold-recovery disarms auto-merge first and adds autoMergeDisarmFailed: true when it could not (disable it by hand) or prMerged: true when the PR merged after all; merge-in-progress = another P merge for the same PR runs on this machine (per-PR lock; other machines are not seen), nothing changed); both routes first put right an earlier --owner-go run that lifted a hold and died (hold-recovery; the dry run lists it as blocker hold-lift-orphan, a lift that cannot be verified as hold-lift-unverified, a merge running now as merge-in-progress); when the review skill ran for the PR (a triage or review-complete comment of ours, or a local review state) the check review-complete also needs the review completed for exactly this content, the local state equal to the published one and every dismissal shown (rulings: the block the owner is shown, ownerStep.closing (say-merge only) = the closing lines to end the reply with, pasted verbatim: the Rulings block when present, Areas, Hold, Head, then the 🔀 line, joined by a newline (the behind / queue / park notes are not part of it); ownerStep.rulings = `Rulings <digest12>` and its rows, printed directly above the Areas / Hold / Head lines; ownerStep.rulingCount; absent for an ordinary PR); a dismissal Claude made counts as an owner item on the gated route (ownerMerge > 0); both routes run under the review lock of the PR (merge lock first, then review lock) from before the live read until MERGED or until nothing merged and auto-merge is disarmed, so a review writer waits and then fails lock-timeout; a merge that cannot take it refuses lock-timeout with nothing changed (the dry run takes no lock); exit 0 merged (mergeSha:null + warning when GitHub cannot name the merge commit), 1 not merged / refused (error: gate|behind-base|live-check|pre-merge|queued-behind|hold-unreadable; behind-base = the base moved: the branch was updated (or the update failed, see outcome), re-verify and run final-gate again), 3 GitHub unavailable. For a repo with merge.hold_command / hold_release_command / hold_check_command (a cooperative merge lock of its own) the repo's read-only hold check runs before anything is updated or merged: on --owner-go right after that recovery (hold-recovery), before the live check and the owner-go approval check; on the gated route after that recovery, the gate-file check (error gate) and the resumed-run / ownerMerge checks read from the gate file (error pre-merge), before the branch is brought up to date and the live gate: another PR's active hold that would block this one is error queued-behind {verdict: hold:queued-behind, blockedBy:[PR numbers], holds, doNotUpdate:true, reason} (nothing is updated or merged; do NOT run update-branch; wait, or the owner merges the PR ahead; a fresh "merge" is needed afterwards), an unreadable check is error hold-unreadable (retry later); the check runs again before every branch update, and a merge command whose output says hold:queued-behind is mapped to queued-behind too (cooperative: only a hold-aware merge command catches a hold taken after the check). The gated route's branch update (the behind-base step) is taken under this PR's own hold: the hold is TAKEN right before the update PUT once the check shows nothing ahead and the check runs again after the take (hold in the refusal output: {taken, tookThisCall, take}); the update's merge commit is recorded as the pipeline's own successor head (successors in the refusal) so a later `merge-hold --release --reason new-commits` keeps the hold. This call releases at once a hold its take may have written (every take that ran, whatever its exit code: exit 1 means refused OR not confirmed, and the provider can add the label before it fails to confirm; releasing a label that was never written is a harmless no-op), and the refusal carries holdRelease {reason, confirmed, code, lines} (a release that was not confirmed is also a warnings line), when an older hold turns up after the take (queued-behind; holdTaken), when the re-check cannot be read after an unconfirmed take (hold-unreadable; a CONFIRMED hold is kept, the refusal then says holdTaken: true) or when the update conflicts (behind-base / rebase-needed, reason update-conflict: a hand merge follows); every other failed update and an accepted one keep the hold. The dry run takes and releases nothing. While it runs the run record of the PR shows inFlight {kind: merge} and step merge; for a repo with verify.deferrable_steps the proofs of the live gate (where each deferrable step was proved: the Mac, or a GitHub run and attempt) are recorded in the run record and in an append-only ci-proof-used event comment before the merge command, and when either write fails nothing is merged (error pre-merge); warnings lists a run record write that failed (never fatal). A run record marked resumed (`P checkpoint --resumed`: a run taken over by ship resume) refuses with error pre-merge unless the owner approved it; so does a run record that cannot be checked (unreadable, invalid or unsupported: it may be a resumed one), and with owner_approval: chat a gate with ownerMerge > 0. Approved = --owner-approved-head names the full gate head, --owner-approved-items the gate's ownerItems, AND the owner-go hook recorded the owner's "merge" for exactly that PR, head and item set (the flags alone refuse); the live gate must still show those ownerItems. Behind its base (--owner-go only, real run and --dry-run; the gated route still updates the branch): refused as behind-base unless the BASE commit's .claude/pipeline.yml (never the PR's own copy) has merge.behind_base: disjoint AND mergeStateStatus is CLEAN|HAS_HOOKS|UNSTABLE|BLOCKED (never BEHIND / DIRTY / UNKNOWN) AND mergeable is MERGEABLE AND the paths main changed since the merge base (git diff -M, renames as both names, compared NFC and case-folded) share none with the PR's paths AND none matches .github/**, .claude/pipeline.yml, scripts/verify*, **/.gitattributes, **/.gitmodules, **/.nvmrc, **/.node-version, **/.tool-versions, the base's verify.ci_proof_inputs or its merge.behind_base_stale_paths AND main removed no directory the PR adds into; the output then carries behind {behindBy, mergeBase, baseRefOid, mainFiles, rule: disjoint} (null when up to date), the dry run's say-merge ownerStep gains behindNote (show it above the Areas / Head lines) and a compare-API behind whose base tip is not the checked baseRefOid stays a blocker. The owner's "merge" stays bound to head + items (+ Areas), not to main's commit: the real run re-checks all of this against the base it finds. Every --owner-go merge also pins GitHub's baseRefOid while it waits: a base that moved off the evaluated one disables auto-merge and the run exits 1 (not merged). --dry-run (an agent previewing the verdict; never run the repo's merge command for that; for a repo with the hold keys it DOES run the repo's read-only hold check, reports holds {readable, blockedBy} and names a blocking or unreadable hold as blocker merge-hold, and withdraws every "update the branch" advice from the blockers while a hold is ahead) runs the same checks as the real run (gate file, resumed-run guard, ownerMerge, behind base, the live gate, the --owner-go preconditions) and stops before anything that writes or merges: it never updates the branch (behind-ness is read from GitHub: mergeStateStatus BEHIND, or the compare API showing the head lacks the base tip; blocker behind-base; UNKNOWN / DIRTY or a compare error: behind-base-unverified), writes no run record, event, label, comment or file, and changes no git state (no fetch: for a repo with verify.deferrable_steps the base proof settings are read from the GitHub contents API at the PR's baseRefOid, which must exist locally, else blocker proof-settings-unverified). It collects every blocker it can find instead of stopping at the first, and names the owner step instead of refusing on it: ownerStep null (a low-risk review: P merges by itself; or a hardstops / integrity scan that could not run: fix that blocker first, nothing is handed off) | {kind: say-merge, line, areas?, areaIds?, hold?, holdInfo?, ready?, parkNote?} (the exact "Head … · items … · repo …" line; for --owner-go the items are the LIVE scan's digest, and for protected areas `areas` is the `Areas <ids>` line to print directly above it; with an eligible needs-human hold (--owner-go, owner_approval: chat, needs-human the only blocking label, a complete readable timeline) `line` carries `· hold <id>`, `hold` is the `Hold <id> by <login> at <ISO>` line to print between Areas and Head, `holdInfo` {id, login, at} the hold as the timeline event shows it (the account is shared: never call it the owner or the agent hold), `ready` the exact 🔀 line ending `and lift its needs-human hold` to close the reply with (without a hold there is no `ready`: print the plain 🔀 line), `parkNote` {label, text, updatedAt} the newest agent-written needs-human park comment as one line prefixed `quoted note: `, only when it was updated at or after the hold event) | {kind: owner-runs, command} (gated route: ownerMerge > 0; --owner-go: a blocking hard-stop / integrity violation, or any owner item under owner_approval: label; the repo's merge.command filled with PR and head, which the owner runs) | {kind: owner-approval-flags} (a resumed or unchecked run record); for a repo with the hold keys every non-null ownerStep also carries holdEligible: true only for a say-merge / owner-runs ending whose blockers are none, or only the owner-items check and the hardstops / integrity checks behind it when they are a real verdict (hits / violations; a scan that could not run, "could not evaluate" / "could not diff", leaves ownerStep null) (the hand-off may take the merge hold; any other blocker, a hold ahead or an unreadable hold check makes it false). It grants nothing: the real run re-checks the owner's record. Exit 0 wouldMerge (given the owner's word where ownerStep says so), 1 blockers, 2 --dry-run with --owner-approved-head / --owner-approved-items, 3 GitHub unavailable
```

Exit: 0 merged (a merge commit GitHub cannot name yet is `mergeSha: null` plus a `warning`) · 1 not merged / refused by the live gate or by the last pre-merge look at GitHub (run final-gate again; `behind-base`: the base moved, the branch was just updated on GitHub, so pull, re-verify and gate the new head) · 3 GitHub unavailable.

Resumed runs: `merge` reads the PR's run record (the viewer's own summary comment) before anything irreversible; when it carries `resumed` (set by `checkpoint --resumed`, never cleared), `merge` refuses with exit 1 `{merged: false, error: pre-merge, reason: resumed run: the owner must say "merge" for this exact head (then pass …)}` unless the owner approved it (below). A record that cannot be checked fails closed: unreadable comments, or an `invalid` / `unsupported` (newer version) record, refuse the same way (`reason: <the run record could not be read (…) | the run record is invalid|unsupported>, so the resumed-run guard cannot be checked: …`), because it may be a resumed one. No record (`absent`) or a `legacy` comment is an ordinary run.

Owner approval (#58): with `owner_approval: chat` a gate with `ownerMerge > 0`, and any resumed or unchecked run, merges only with `--owner-approved-head <full gate head> --owner-approved-items <the gate's ownerItems>` AND a record of the owner-go hook (`~/.claude/pipeline-state/owner-go/<session>.jsonl` under the account's home, never `$HOME`; written only when the owner types a prompt starting with "merge" right after a reply that showed `Head <sha12> · items <ownerItems> · repo <owner/name>` and the 🔀 line; valid 24 h) for exactly that repository (`gh repo view`'s nameWithOwner, case-insensitive), PR, head and item set; a request line without `· repo` approves nothing (Phase 3b). The flags alone refuse (the reason then ends with `(no owner "merge" is recorded for owner/name #N head … items …)`). The live gate must still show the approved `ownerItems`, else `reason: the owner items changed since the owner said "merge" …`. `final-gate` reports `ownerItems` (a 12-character digest of the owner items, `none` without any).

Behind its base (`merge.behind_base`, owner ruling 2026-11-05; `--owner-go` and its `--dry-run` only): a PR that lacks commits of its base is refused as `behind-base` (update the branch and re-verify) unless the BASE commit's `.claude/pipeline.yml` sets `merge.behind_base: disjoint` (default `update`; the PR's own copy is never read, `merge.behind_base_stale_paths` likewise, so a PR cannot loosen its own rule) and ALL of: GitHub's `mergeStateStatus` is `CLEAN`, `HAS_HOOKS`, `UNSTABLE` or `BLOCKED` (the same list the dry run reads; never `BEHIND`, `DIRTY` or `UNKNOWN`) and `mergeable` is `MERGEABLE`; main's changed paths (merge-base(`baseRefOid`, HEAD)..`baseRefOid`, read like the PR's own diff: renames as both names, C-quoted names decoded, compared after NFC normalisation and lower-casing) share none with the PR's; none of them matches `.github/**`, `.claude/pipeline.yml`, `scripts/verify*`, `**/.gitattributes`, `**/.gitmodules`, `**/.nvmrc`, `**/.node-version`, `**/.tool-versions` (built in, cannot be configured away), the base's `verify.ci_proof_inputs` or its `merge.behind_base_stale_paths` (globs, default `[]`: add the toolchain files, e.g. `package.json`, `package-lock.json`, `tsconfig*.json`, `supabase/**`); and main did not remove a directory the PR adds a file into. Then the live evaluation returns `behind {behindBy, mergeBase, baseRefOid, mainFiles, rule: "disjoint"}` (`null` when up to date), the merge output carries it, the dry run reads the compare API's behind as accepted only when its base tip is that `baseRefOid`, and `ownerStep` (`say-merge`) gains `behindNote` ("behind main by N commit(s); main's M new file(s) touch none of this PR's files"), which the review skill shows above the Areas / Head lines. The owner's "merge" is bound to head + items (+ Areas), not to main's commit: if main moves again before the real run, the run re-checks all of the above against the new base. Residual risk: a meaning-level clash the file lists cannot see (main renames a function the PR calls from an untouched file) lands on main; main's own push CI catches it.

Owner-go (`--owner-go`, owner decision 2026-10-28; protected areas 2026-11-05): the route for work that never ran the review skill (no verify report, no review state, no `final-gate.json`), and, with `owner_approval: chat`, for a PR whose diff has hard-stop / test-integrity items the owner merges in chat. The reply asking for the merge ends with `Head <sha12> · items <digest> · repo <owner/name>` above the 🔀 line (`items none` for a diff without owner items; the digest is `ownerItems` of the live scan otherwise) and, for a diff with protected areas, with an `Areas <id> <id> …` line (the distinct hard-stop rule ids / integrity kinds, sorted, one space apart: `merge --dry-run --owner-go` prints it as `ownerStep.areas`) DIRECTLY above the Head line (`#N areas …` above `#N head …` in the several-PR form). The recorder accepts exactly that shape (an Areas line that is repeated, malformed, against the 🔀 line or another PR's binds nothing; one with prose between it and the Head line is not part of the block, so the request binds without areas) and stores sha256 of the block in the record's `areas` (a record without it means "no areas"). Blank (whitespace-only) lines anywhere in the reply are transparent ("directly above" means the next non-blank line above, so a blank line between Areas / Hold / Head or before the 🔀 line voids nothing); prose still ends the block. A PR that carries a `needs-human` hold the owner's "merge" lifts adds a Hold line and the lift wording (next paragraph). Once the owner types "merge" the owner-go hook records it, and `merge --pr N --owner-go` then checks, in this order: the live PR (open, not a draft, MERGEABLE, not behind its base, at the local HEAD, no blocking label) and every required check green on that head, guard statuses and `Cross-model review` only with their provenance; `scan-range`: the diff is scanned over GitHub's own range, merge-base(`baseRefOid`, HEAD)..HEAD, with `baseRefOid` and `headRefOid` read from GitHub (the head must be the local HEAD, the base commit a local object: else refused, "git fetch <remote> <base>"; never a local ref the agent could move), refused when the clone can show another history than GitHub's (a replace ref, `.git/info/grafts`, a shallow clone) or when GitHub's file list for the PR (`pulls/N/files`, both names of a rename) names a file the local diff lacks; and `owner-items`: no blocking hard-stop, no test-integrity violation, and no owner item under `owner_approval: label` (else `error: live-check` with the failing checks); then the record for this repository, PR, the local HEAD, the LIVE items digest, the live areas and the live hold (else `error: owner-go`, naming the lines to show: a record for `items none` never covers a diff with items, a record for another digest never covers items that now hash to the live one, a record without `areas` covers only a diff without areas, and a record without `hold` never covers a PR that has an eligible hold); the last pre-merge look (`error: pre-merge`), which also re-reads `baseRefOid` and `headRefOid` and refuses when either moved since the scan. It runs `merge.command` pinned to the head (`{sha}`) and waits for MERGED like the gated route, with GitHub's `baseRefOid` pinned to the one that was scanned (a queued merge never lands on a base nobody checked: the wait ends `blocked`, auto-merge is disabled, exit 1). It proves no verify step, writes no gate file and refuses `--owner-approved-head` / `--owner-approved-items` (usage, exit 2). The final gate file itself is now valid for 24 h (the owner's "merge" window): `merge` re-runs the whole gate live anyway. Since #128 the "merge" must also be confirmed as typed by the owner when it is used: the record's prompt entry in the session transcript (found by the hook's `prompt_id`, else by its words and time) must be the owner's, not a background notice, another session's or a subagent's message, a scheduled or headless turn; otherwise `P merge` refuses with "cannot be confirmed as typed by the owner" and the request must be shown and the owner asked to type "merge" again (the same check applies to the gate flags above). The transcript counts only under a `.claude*` folder directly under the account's home (`~/.claude`, `~/.claude-work`; the home as given and as the file system resolves it, no `..` in the path): `$CLAUDE_CONFIG_DIR` names no root, because `merge` runs in the agent's shell, where the variable is the agent's own word. When the record's transcript is anywhere else, the refusal says so: the owner's Claude Code config dir must be a `.claude*` folder directly under the home.

Owner-go hold lift (2026-11-05, design record `docs/plans/2026-11-05-chat-merge-protected.md`): under `owner_approval: chat` the owner's "merge" also lifts the ONE `needs-human` hold the request named, so no label is cleared by hand. A hold is eligible only when `needs-human` is the PR's only blocking label (never `awaiting-review`, `pipeline-blocked`, pause or rollback), the PR timeline is complete (paginated, every `labeled` / `unlabeled` event well-formed) and shows the label as applied, and the newest `needs-human` `labeled` event can be shown as a Hold block (a login with `_`, an EMU account, cannot: not eligible); anything unreadable leaves `needs-human` an ordinary blocker (check `labels`). The hold is the newest `labeled` event, `{id: node_id, login, at}`; the account is shared with the agent, so the pipeline never says whose hold it is. `merge --dry-run --owner-go` then adds to `ownerStep` (kind `say-merge`): `hold` (the `Hold <id> by <login> at <ISO>` line), `holdInfo` (`{id, login, at}`), `line` (the Head line carrying `· hold <id>` between `items` and `repo`), `ready` (the exact 🔀 line `🔀 Ready to merge #N and lift its needs-human hold — say "merge"`; absent without a hold: print the plain 🔀 line) and, only when the agent's `needs-human` park comment was updated at or after the hold event, `parkNote` (`{label: "pipeline park note (agent-written)", text, updatedAt}`; `text` is one line prefixed `quoted note: `, so no quoted line can pass for a request line); the hold counts as lifted by the owner's word in the `labels` check and the pre-merge look, every other blocker is kept, and an earlier run's orphaned lift is blocker `hold-lift-orphan` (a lift comment with a timeline, PR or, for `--owner-go`, comments that cannot be read is `hold-lift-unverified`, as the real run's `hold-recovery` refusal). The reply's closing block, top to bottom, is `Areas …` (when present), `Hold …`, `Head … · items … · hold <id> · repo …`, then the `ready` line; the recorder (hooks/lib/owner-go.mjs `presentedRequests`) reads the request only when the reply's last non-blank line IS the 🔀 line (only spaces before it: `Do not 🔀 Ready to merge …` binds nothing) and binds a request with a hold only in exactly that shape: the Hold line directly above the Head line (Areas directly above the Hold line), its id equal to the Head line's `hold` field, the lift wording on the 🔀 line (`and lift its needs-human hold`; several PRs `and lift their needs-human holds`, valid only when every PR listed carries a hold; the wording without a hold, or a hold without the wording, binds nothing), the `hold` field once and before `repo`. A line that starts with the canonical `Hold <id> by ` anywhere in the reply and is not consumed exactly so (prose between it and its Head line, two in a row, an earlier block's, another PR's, a different id, a malformed rest) voids the WHOLE reply: nothing is recorded, unlike a stray Areas line, which only drops the areas (prose such as "Hold on, …" is no Hold line). The record keeps the hold id and sha256 of the Hold block; `approvalGap` compares both with the LIVE hold, so a record for hold X never covers hold Y, a record without a hold (shown before Hold lines existed, or by an older hook) never lifts one, and a record with a hold never approves a PR that has none now. The real run goes: (0) recovery (below) → eligibility → live scan → record check → the pre-merge look, with the bound hold the only thing exempted (the labels check and this first look; the look after the lift and the wait use the plain rule, so a `needs-human` added meanwhile blocks and is restored) → re-read the timeline (the newest hold must still be the bound one and the label present, else `error: hold`, nothing changed) → post the append-only `hold-lifted` event comment (hold, head, items; a failed comment refuses with the label untouched and an abort event) → install SIGHUP / SIGINT / SIGTERM handlers → `DELETE` the label (HTTP 404: someone else removed it first, which is theirs to keep: not put back, `holdRemovedByOther: true`) → post the append-only `hold-lift-deleted` marker comment (same lift id; an ordering barrier: a failed post restores and refuses) → read the timeline again, up to 3 retries 2 s apart (`PIPELINE_HOLD_RETRY_MS` can only shorten the pause), until it shows the marker comment (matched by the comment id the POST returned, so the read is at least as new as the delete), the bound hold, exactly one `needs-human` removal between the two and no newer `needs-human` event (a newer one, more than one removal, or no marker restores and refuses with `error: hold`) → the plain pre-merge look → the merge command and the wait. Whenever nothing merged (command failure, timeout, closed, a blocker, a refusal, an exception) the label is put back after auto-merge is disarmed, unless the PR turned out MERGED (then the label stays off and the run reports the merge), and the output says what the timeline then shows: `holdRestored: true` with `holdRestoredNote` (a NEW `labeled` event exists, so the owner's old "merge" cannot lift it: the owner must say "merge" again, with the new Hold line), `holdKept: true` with `holdKeptNote` (the label never left: the hold the owner approved is still the newest), or `holdRestoreUnverified: true` with `holdRestoreNote` (the label is on but a new hold could not be confirmed: ask again); if the label cannot be added the run is `error: hold-restore`, exit 1, `holdRestoreFailed: true`, naming the PR (add the label by hand). A merged run reports `holdLifted: <id>`. A run that ends without its delete having taken effect (a refusal after the lift comment, a 404, a label that never left) posts a `hold-lift-aborted` event so recovery never reads a later manual removal as its own. A signal kills the merge command's process group, disarms auto-merge and then restores the label (unless the PR is MERGED) before exiting 129 / 130 / 143, so a merge cannot land on a PR that has the hold again. Recovery (`P merge`, both routes, and the dry run's `hold-lift-orphan` blocker; `P preflight` has no `--pr` form and does none): a `hold-lifted` event of the viewer for the newest hold, newer than that hold, with no later `hold-lift-aborted` of the viewer for it, the PR open, the label absent, and the first `unlabeled` event after the hold within 15 minutes of the lift comment (a later one was a manual removal), is an interrupted run: auto-merge is disarmed first (the project's merge command may have armed it), the PR is read again (MERGED: nothing is put back, `prMerged: true`), then the label is put back and the run refused (`error: hold-recovery`, `holdRestored: true`; `hold-restore` when the re-add fails); a failed disarm still restores the label but adds `autoMergeDisarmFailed: true` and says "auto-merge may still be armed on #N: disable it by hand" (gh errors on `--disable-auto` when auto-merge was never armed, so a failed disable is followed by `gh pr view N --json autoMergeRequest`: a clean read showing none counts as disarmed, here and in every other `autoMergeDisabled` report, no false alarm); once a lift comment of ours exists, a timeline or PR that cannot be read refuses in both routes, and unreadable PR comments refuse `--owner-go` ("PR comments unreadable …") after one retry (the gated route tolerates only that, its run-record guard reads the same comments and fails closed itself). Every `P merge` (both routes) holds a per-repo-and-PR lock (lib/locks.mjs, `merge-<owner>__<name>-pr<N>`, in `PIPELINE_LOCK_DIR` or the machine lock directory) from before recovery to the end, the wait included, and recovery changes labels only while holding it: a live holder refuses the second run (`error: merge-in-progress`, nothing changed), a dead holder's lock is taken over, and the dry run reports blocker `merge-in-progress` and skips the orphan judgement. The merge command runs in its own process group, so a run killed outright leaves it running: while it runs its group id is kept in `<lock dir>/<lock name>.child.json`, a run that takes the lock over refuses `merge-in-progress` while that group is alive or the record is unreadable (nothing changed; wait, or stop it and remove the file), and a record whose group is gone is dropped. The dry run makes the same judgements read-only (lib/locks.mjs `peek`: a dead local holder or an unfinished lock older than 60 s is stale, as for `tryAcquire`; no machine-id file is created). Residuals: the lock is per machine, a run on another machine is not seen; a run killed between spawning the merge command and writing its record leaves an unrecorded child. Label mode and the gated route are unchanged: the gated route lifts no hold. The review skill (section 3.3) copies the dry run's `areas`, `hold`, `line` and `ready` verbatim and never types the owner's word.

Merge command exited non-zero but the PR is MERGED (both routes): GitHub's state decides merged, the exit code never does. The merge command runs with the PR's worktree as its cwd, so `gh pr merge --delete-branch` merges and then cannot check out the base branch there (git: `fatal: 'main' is already checked out at '<path>'`) and exits 1 after the merge. That case alone is reported as `{ok: true, merged: true, commandExitCode: 1, localCleanup: {skipped: true, reason: "worktree"}, commandOutput, note}`: the local branch is left in place, remove the worktree as usual. gh returns on that local-branch error BEFORE it deletes the remote branch, so the remote branch is left too unless the repository deletes branches on merge (`delete_branch_on_merge`); delete it by hand if it is still there. It is recognised only when ALL hold: the exit code is exactly 1, the command was neither timed out nor killed by a signal, the FULL stdout and stderr (not just the 30-line `commandOutput` tail) hold a git worktree diagnostic (`fatal: '<b>' is already checked out at '<p>'`, `fatal: '<b>' is already used by worktree at '<p>'`, `error: Cannot delete branch '<b>' checked out at '<p>'` or `… used by worktree at '<p>'`, alone on a line or wrapped by gh as `failed to run git: …` / `failed to delete local branch <b>: …`), and EVERY error-looking line of that output (error, fatal, failed, denied, cannot, could not, unable) is such a diagnostic. Any other non-zero exit with a MERGED PR (a permission or ref-lock failure, an extra error line, exit 2, a timeout or a signal) keeps `commandExitCode` and the note "the merge command exited non-zero but the PR is MERGED" and now also carries `commandOutput` (the last 30 lines of stdout then stderr) as evidence; it has no `localCleanup`. The diagnostics are matched in git's C-locale wording: a translated message (a non-C locale) falls to this unknown-cause path, which is still reported as merged. A PR that is not merged stays a failure whatever the output says.

Run record: before the merge command, `merge` sets the record's `inFlight` `{kind: merge, host, startedAt, maxMinutes: 2 × merge.wait_minutes + 15}` and `step: merge`. On every exit `inFlight` is cleared: merged → `step: merge` and `mergeSha`; not merged → `step: gate`. `merge` makes no deployments call and writes no `.review/prod-before.json`, whether or not `production` is configured. The run record itself is display: a failed record write is listed in `warnings` and never fails the merge.

### Rulings (owner-go)

Default: an item left `needsHuman` is decided by Claude, with a reason, through `triage claude-ruling` (a REJECT, or a dismissal of a BLOCKING or security item, only after a Codex `triage second-review` that also dismisses it at high confidence). The owner is not asked to type a ruling; the typed `<id>: accept | follow-up | reject` path (`triage owner-ruling`) stays as a rare override.

- **Rulings block.** `merge --dry-run --owner-go` prints, for a single-PR request, a `Rulings <digest12>` header and one row per dismissed BLOCKING or security item (who decided: `claude+codex`, `claude`, arbiter, test, owner; content digest; the reason, cut to 140 printable ASCII characters). It is `ownerStep.rulings` and sits directly above the `Areas` / `Hold` / `Head` lines, which the reply copies verbatim. The owner-go hook records the owner's "merge" against the sha256 of that block, and `merge` compares it with the live rulings: a changed, missing, retyped or misplaced block, or one in a reply that names several PRs, binds nothing. No rulings means no block (an ordinary request is unchanged). A `say-merge` dry run also prints `ownerStep.closing`: the Rulings block (when present), the Areas line, the Hold line, the `Head … · items … · repo …` line and the 🔀 line (the lift form when a hold is lifted) joined by a newline, in that order and exactly as printed in their own fields; the reply ends with it pasted verbatim. The behind / queue / park notes are prose above it and not part of it; `owner-runs` and `owner-approval-flags` have no `closing`. The gated route (`--owner-approved-items`) does not bind the block; a Claude-made dismissal there is a `review-ruling <id> <12hex>` owner item instead.
- **`review-complete` owner-go check.** `merge --owner-go` now also runs the review-complete check, once a review ran on the PR (a triage or review-complete comment from us exists; a PR the review skill never touched is unchanged). It refuses, naming its remedy: no marker, a marker for other content, a marker without the current rulings digest, or a state on this machine that differs from the one published on the PR: `pipeline review-complete --pr N` (it publishes this copy first); an unreadable local or published state: `pipeline state show --pr N`; no clean round covering the content, an unmarked ACCEPT, a Claude-ruled FOLLOW-UP without its issue, or a fix outside the named file that no later round confirmed: finish the round it names, then `review-complete`.
- **Publication.** The review state is published as a compare-and-swap on its content (a sha256 of the rounds; the baseline is `.review/published-baseline.json`). A publisher whose copy is not what the PR holds is refused with `stale-publication`: run `pipeline state show --pr N`, then redo the step. A checkout from before the baseline existed (no baseline file) whose state equals the published one gets the baseline from `state show`, and from `triage claude-ruling` / `second-review` / `owner-ruling` before they change the state; a state that differs from the published one gets none. The review lock is per machine, so two machines publishing in the same second can still race; the equality check at merge time catches the loser.
- **Locks.** `merge --owner-go` holds the review lock (one per repository and PR, shared by every worktree and clone on the machine) for the whole merge, until MERGED or until auto-merge is confirmed disarmed. A ruling, second review or triage publication meanwhile waits, then fails `lock-timeout` (exit 2) and changes nothing: decisions are frozen while a merge is armed. `merge` itself answers `lock-timeout` when another command holds that lock.
- **Deployment and rollback.** There is one install per machine and every `pipeline` call is a fresh process, so `pipeline update` takes effect at once (a `pipeline job` that is already running finishes on the old code). A review state written by `claude-ruling` or `second-review` carries `version: 2`; a CLI that knows only version 1 cannot be taught to refuse it. Rolling back to a CLI from before this change while a PR holds Claude rulings therefore loses only the owner-go Rulings check (the flow as it was): finish or re-rule those PRs first. Every other state stays version 1.
- **Pre-existing PRs.** A PR whose review ran before the update may need one `pipeline review-complete --pr N` after it, so that its marker, published state and rulings digest agree.

### Merge hold (`merge.hold_command`, `merge.hold_release_command`, `merge.hold_check_command`)

For a repo whose merge command keeps a cooperative merge lock (EagleWatch: a `merge-hold` label with a 90-minute TTL; while it is active every OTHER PR's `npm run merge` refuses, and a stale PR behind an older hold gets the verdict `hold:queued-behind #A`: do not update this branch until #A merges). Three optional keys under `merge`, **all three or none** (a partial set is a config error; unknown keys are still rejected). Absent, nothing changes for the repo.

| key | placeholders | what it does | EagleWatch |
|---|---|---|---|
| `hold_command` | `{pr}` required, `{sha}` not allowed | takes or keeps the hold for PR `{pr}`. Exit 0 = hold confirmed, 1 = refused or NOT confirmed (the label may already be written when the confirming event is late, so the pipeline releases after any take that ran), anything else = error | `npm run merge-hold -- {pr}` |
| `hold_release_command` | `{pr}` and `{reason}` required, `{sha}` not allowed | releases PR `{pr}`'s own hold. The pipeline fills `{reason}` shell-quoted from fixed sentences only (codes `new-commits`, `parked`, `owner-declined`, `handoff-withdrawn`, `ci-failed`, `update-conflict`, `queued-behind`, `hold-unreadable`, `restart`) | `npm run merge-hold -- {pr} --release --reason {reason}` |
| `hold_check_command` | `{pr}` required, `{sha}` not allowed | READ-ONLY. Exit 0 and the LAST non-empty stdout line is one compact JSON object `{"pr":N,"blockedBy":[{"number":A,"title":"…","since":"<ISO>","expires":"<ISO>"}]}`; `blockedBy` lists the OTHER PRs' active holds that would block N, oldest first (the provider owns the TTL and the order). 5-minute timeout | `npm run merge-hold -- --status {pr} --json` |

The check command must differ from both other commands (a copied take command would make every dry run write a label). The answer is unreadable, and refused (`hold-unreadable`, fail closed), unless the exit code is 0, the last line is a JSON object, `pr` is the requested PR, and every `blockedBy[].number` is a positive integer other than the PR itself.

Where it applies: `pipeline merge-hold` (take / check / release, below); `merge` before anything is updated or merged: on `--owner-go` right after the orphan-lift recovery (`hold-recovery`, which may itself write the needs-human label back, then refuses the run) and before the live check and the owner-go approval check; on the gate path after that recovery, the gate-file check (`gate`) and the resumed-run / `ownerMerge` checks read from the gate file (`pre-merge`), before the branch is brought up to date and the live gate — so on either route a held PR is refused with `queued-behind` and no "update the branch" advice; `update-branch` before every update PUT (and `merge` before its own branch update), which now also TAKES the PR's hold first (Taking the hold for a catch-up, below); the dry run (read-only check, below). After a failed merge command the pipeline reads its FULL output for `hold:queued-behind` lines and, when the PR is not merged, reports `error: queued-behind` instead of "merge command failed". Every hold refusal (`queued-behind`, `hold-unreadable`) carries `verdict`, `doNotUpdate: true` and `reason`; `blockedBy` is a list of PR numbers and `holds` carries the detail objects (`number`, `title`, `since`, `expires`); a PR that is MERGED is reported as merged whatever the text says. The verdict means "do not update": the pipeline never updates a held branch and has no override flag; the owner's exits are in Renewal starvation below.

**Enforcement.** The pipeline-side check is cooperative: it reads the hold, then acts, and the two are not atomic. A hold placed between the check and the merge command is caught only by a hold-aware merge command (EagleWatch's gate re-checks right before `gh pr merge`); a repo that opts in with the default `gh pr merge` command gets the pre-check only. Likewise an update PUT can race a hold taken a moment after the pre-PUT read.

**Rollout and rollback.** Rollout: the keys need a pipeline version that knows them (older versions reject unknown `merge.*` keys), so merge and install the pipeline change first and only then add the three keys to the repo's `.claude/pipeline.yml`. Rollback: remove the three keys first (config errors otherwise), then downgrade. Removing them also removes the pipeline-side enforcement; the repo's own merge gate still enforces.

**Renewal starvation.** A PR whose hold expires and is renewed goes to the back of the queue, so a PR that keeps waiting can be passed by one that renews in time. The owner's exits: merge the PR that is ahead, release that PR's hold with the provider's own `--release`, or use the provider's `--ignore-hold`. The pipeline never releases another PR's hold or uses `--ignore-hold`.

**Dry run.** `merge --dry-run` (either route) now runs the repo's read-only `hold_check_command` (exactly one shell call, zero GitHub writes) when the keys are configured, and reports `holds: {readable, blockedBy}`. A `queued-behind` or `hold-unreadable` result is a blocker named `merge-hold` and `wouldMerge` is false. When a hold is ahead, the `behind-base` blocker and the `pr-open` live-check blocker say "do NOT update" instead of advising an update. `ownerStep.holdEligible` says whether the hand-off may take the hold: true for a `say-merge` / `owner-runs` ending whose blockers are none, or only the `owner-items` check and the `hardstops` / `integrity` checks behind it when they are a real verdict (hits / violations; a scan that could not run, "could not evaluate" / "could not diff", leaves ownerStep null) (an `owner-runs` hand-off under `--owner-go` always has those, so `wouldMerge` is false for it); false with a hold ahead, an unreadable check or any other blocker. Repos without the keys: no `holds` field, nothing run.


**Taking the hold for a catch-up.** The catch-up PUT of `update-branch` and of `merge` (the gate path's behind-base step) is made while this PR holds its turn, so the CI round that follows cannot be invalidated by another session's merge (cooperative: the repo's gate refuses other merges while the hold is active). Right before the first PUT, once the check shows nothing ahead, the pipeline runs `hold_command`, then runs the check AGAIN (a take that failed or timed out may still have written the label, and another session may have taken one meanwhile); only a clear re-check lets the PUT go. A take that is not confirmed carries on without a hold (`hold.taken: false`: the hold is cooperative, a missing hold is not a safety loss). Both commands report `hold: {taken, tookThisCall, mayHold, take}` (`mayHold`: the take ran, so it may have written the label: exit 1 means refused OR not confirmed, and the provider can exit 1 after adding the label, so every take that ran is released on the failure paths; releasing a label that was never written is a harmless no-op). The record of what the pipeline itself made is kept in the git common dir, outside `.review/`: one file per accepted update, `<git-common-dir>/pipeline/merge-hold/pr-<N>/<head>.json` = `{version, pr, from, to, baseSha, at}` (written at once, atomic, shared by every worktree; files older than 30 days, and `*.tmp` leftovers of a crashed write older than 1 hour, are pruned on write; a lost record only means a release proceeds). `merge-hold --release --reason new-commits` keeps the hold (`kept: true`, nothing run) when the PR head is such a recorded successor AND GitHub still shows its parents as exactly `[from, baseSha]`; a push by anyone else, an unrecorded head or an unreadable head releases as before.

Cleanup after a refusal that follows this call's own take (after any take that ran, i.e. `mayHold`; a take that could not be started, `notStarted`, wrote nothing and is not released): `update-branch` releases the hold it took on `checks-failed` (`ci-failed`), `rebase-needed` (`update-conflict`) and on a `hold-unreadable` re-check after an UNCONFIRMED take (`hold-unreadable`; after a CONFIRMED take the hold is real and only the check failed to read, so it is KEPT and the refusal carries `holdTaken: true`), and reports `holdRelease: {reason, confirmed, code, lines, notStarted?}` (plus a warning when the release was not confirmed; `notStarted: true` with `code: null` when the release command could not be started); it KEEPS the younger hold on a `queued-behind` race loss (`holdTaken: true`: the caller waits with `merge-hold --check --wait` and releases `queued-behind` when the wait ends in `timeout`/`unreadable`) and on every other outcome (`head-timeout`, `checks-timeout`, `cycle-cap`, `head-moved`, `not-open`). `merge` STOPS after its refusal, so it releases at once on a race loss (`queued-behind`), on an unreadable re-check after an unconfirmed take (`hold-unreadable`; a confirmed hold is kept, `holdTaken: true`) and when the update conflicts (`rebase-needed`, code `update-conflict`: a hand merge follows), and the refusal carries `holdRelease` (`holdTaken` too for the first two); its other failed updates (`head-timeout`, `head-moved`, `cycle-cap`, `not-open`) and its `behind-base` refusal after an accepted update keep the hold and add `hold` and `successors`. Nothing is taken or released by a refusal that came before this call's take, by `--dry-run`, or by a repo without the keys.

### Queue mode (GitHub merge queue)

Queue mode exists only when GitHub reports a merge queue on the PR's base branch (`isMergeQueueEnabled`, read live by `merge`, `final-gate`, the owner-go evaluator, the dry run, `update-branch` and `merge-hold`); there is no config key. Queue off, or the queue turned off later, is exactly the behaviour described above. Queue state that cannot be read refuses (`queue-unreadable`); it never falls back to a direct merge.

In queue mode `merge` enqueues the owner-approved head (pinned with `expectedHeadOid`, so a moved head is refused), skips the behind-base catch-up, the merge hold and merge-carry, keeps every other gate check, and then watches the entry with today's stop conditions (`needs-human` / `pipeline-blocked` labels, open `pipeline-pause` / `pipeline-rollback` issues => a confirmed dequeue). A removal for failed group checks re-queues the SAME head once (counted across restarts, under the original approval); any other removal, or a second one, ends as `queue-removed`. Every call first reconciles with GitHub: a PR already queued is watched, never enqueued twice; an already merged PR is reported merged. The record lives in `<git common dir>/pipeline/merge-queue/pr-<N>.json`; after a terminal end a fresh decision for the same head starts a new record and a new one-retry budget: on the `--owner-go` route a fresh owner "merge" (newer than the end); on the gated route a `final-gate` run that passed after the end (wherever the owner's word is required: items for the owner, a resumed run, a run record that cannot be checked, a fresh "merge" newer than the end is needed and a newer gate run never revives an older word; the `queue-removed` text then says so instead of sending the agent back to `final-gate`), else `queue-removed` says which. The record also stores the `route` that opened it (`gated` | `owner-go`). A watch resumed from a worktree at another commit than the queued one follows the record's head: the entry's removal is noted on the record (reason, failing checks; a stop condition ends it `blocked`) and is never re-queued from that worktree. A live record belongs to the head its worktree queued, so a `merge` run at ANOTHER head reads GitHub for the RECORD's head and ends that record only where the record's own head says so (merged, closed, a removal that is not re-queueable, the PR head moved off it with no entry left; then the owned hold goes back once and the caller's head is judged from a clean slate, and the refusal or the caller's own later refusal carries `holdRestored` + `holdRestoredNote` when that put the label back). A group-check removal that IS re-queueable is noted once and left live (`requeue-due`) when the worktree that queued it can still re-queue it; when that worktree is this very one (it moved on to another head), is gone, is at another head or belongs to another repository, the removal ends the record at once as `queue-removed` (hold restored, the reason says why: the same checks the sweep's re-queue makes); a PR head off the record while an entry is live at that head changes nothing and is refused `head-moved`; a PR at the record's head that is not queued and has no removal is refused `head-moved` too, and the record is left to `queue-sweep`.

Output adds `queue: true, queued, requeued: 0|1, position?, stillQueued?, removal?`. `stillQueued: true` (exit 0, `merged: false`) means the watch budget ran out with the entry still in the queue: nothing was dequeued, no hold was restored; run `merge` again to keep watching. `removal` is `{reason, failing}` (`failing` = the failed checks on the queue commit). Refusal kinds: `queue-unreadable` (queue state unreadable, nothing enqueued), `enqueue-failed` (GitHub did not accept the enqueue within 60 s; the command's last 20 output lines), `queue-removed` (removed and not re-queueable, with `removal`), `blocked` (a stop condition was found while queued: `problems`; the PR was dequeued), `head-moved` (the PR head is no longer the approved one; nothing was queued or merged), `closed` (the PR was closed without merging), `queued-elsewhere` (another checkout or machine already queued it; a record is kept here and `queue-sweep` carries it on), `requeue-due` (the live record is for another head: its one automatic re-queue is due and belongs to the worktree that queued it, `queuedHead` / `recordRoot` name it, `removal` has the reason; nothing was ended, restored or enqueued from this worktree, and `queue-sweep` re-queues it from there; run `P queue-sweep` right after, because `P merge` never sweeps its own PR). The built-in default merge command cannot run on a queue branch, so `merge` enqueues itself unless `merge.command` is customised (a customised command must enqueue).

The `needs-human` hold in queue mode (a hold the owner's "merge" lifts, `--owner-go`): from the confirmed enqueue on, the QUEUE ENTRY (its record's `hold`: the full binding `{id, login, at, holdBlock}`, owner `session` -> `pending` -> `entry`), not the `merge` process, owns the lifted label. It stays lifted while the PR waits, so a `stillQueued` result and a signal after the confirm restore nothing (output `holdLifted`, `holdRecordOwned: true`, `holdNote`); a signal while the enqueue may or may not have landed (`pending`) makes ONE bounded look (<= 10 s) at GitHub: queued => owner `entry`, no restore; confirmed not queued => restored; unreadable => nothing restored, the record stays `pending` for the next call. The label goes back once, only at an unmerged terminal end (`queue-removed`, `blocked`, `closed`, `head-moved`; output `holdRestored` / `holdRestoreFailed`; a label that is on already is a new hold and is left). A removal for failed group checks is not terminal: the hold stays lifted and the same head is re-queued once under the RECORDED hold binding (the label is gone, so the live hold would read "none"); a `needs-human` on the PR at that moment is a NEW hold: `blocked`, no re-queue. A restart (`P merge` again, `P queue-sweep`) and orphan recovery decide through the one `settleRecord`. With no record here (another checkout, machine or a pruned directory) recovery asks GitHub BEFORE disarming auto-merge or restoring: a live entry at the lift comment's head gets a record (owner `entry`) and the run is refused `queued-elsewhere`; auto-merge is never disabled for a PR with a live entry. After a hold lift the guard statuses (`Test integrity`, `Hard-stop scan`, `Cross-model review`) are re-posted as `pending`: the enqueue waits (bounded by `merge.wait_minutes`) until they leave `pending` and are green with the same provenance, else it refuses `pre-merge` and puts the hold back.

`--dry-run` in queue mode adds `queue: true`, drops the `behind-base` / `behind-base-unverified` / `merge-hold` blockers and `ownerStep.behindNote` / `holdInfo`, and adds `ownerStep.queueNote` ("GitHub's merge queue tests it on top of main and everything ahead of it, then merges it — one \"merge\" is enough."). A PR already queued or merged is a `queueState` blocker ("already queued at position N" / "already merged"); a queue that cannot be read is a `queue-unreadable` blocker (never an all-clear). The repo's merge-hold check is not run and `holds` / `holdEligible` are absent. Conflicts still block; the Head / Areas / Rulings / Hold / 🔀 lines are unchanged.

Stop conditions with no job watching: the queue poster checks them when a group starts and `Queue gate` re-reads them at the end of the group's run. The one remaining gap is the time between that last read and GitHub's merge of the group; it is covered by the watch's 90-second poll while a `merge` job runs, and otherwise reported by `queue-sweep` as merged under veto. A predecessor that merged while the group ran is settled, not re-checked: the poster skips its guard check when its PR merged at its own queue commit (on the default branch) and says `#N (merged)`; one that left any other way is an `error`, and a member still in the queue keeps the full check.

## merge-hold

take, check or release the repo's cooperative merge hold for this PR (repos with merge.hold_* keys; otherwise a no-op)

```
pipeline merge-hold --pr N [--repo DIR]   -> {ok, configured, confirmed, code, lines} : take (or keep) PR N's own hold with merge.hold_command; exit 0 confirmed, 1 refused or NOT confirmed, 2 the command errored (any other exit code, a timeout, or a command that could not be started: `code:null, notStarted:true`); a repo without the keys: exit 0 {ok:true, configured:false}
pipeline merge-hold --pr N --check [--repo DIR]   -> {ok, configured, readable, blockedBy:[PR numbers], holds, error?, verdict?, doNotUpdate?, reason?} : READ-ONLY, runs merge.hold_check_command; exit 0 nothing ahead of this PR, 1 error queued-behind (another PR's active hold is ahead: do NOT update the branch) or hold-unreadable
pipeline merge-hold --pr N --check --wait [--max-minutes M=120] [--repo DIR]   -> {ok, configured, outcome: front|timeout|unreadable, polls, waitedMinutes, blockedBy, holds?, reason?} : polls the READ-ONLY check at once and then every 5 minutes (fixed: the repo's check costs ~15 API calls and the budget is shared) until nothing is ahead of this PR; M is an integer 5..240 and bounds when a poll may START (a running check keeps its own 5 min timeout); exit 0 front (retry the update now), 1 timeout (still queued behind blockedBy) or unreadable (two unreadable answers in a row); a repo without the keys: exit 0 {ok:true, configured:false}. Run it as `pipeline job start turn -- pipeline merge-hold --pr N --check --wait` (it runs longer than a tool call may)
pipeline merge-hold --pr N --release --reason <new-commits|parked|owner-declined|handoff-withdrawn|ci-failed|update-conflict|queued-behind|hold-unreadable|restart> [--repo DIR]   -> {ok, configured, confirmed, code, lines, warnings?} : release PR N's own hold with merge.hold_release_command (the code maps to a fixed sentence; no free text reaches the shell); same exit codes as take. Exception: --reason new-commits on a PR head that THIS repo's `pipeline update-branch` / `pipeline merge` produced (a recorded successor whose parents GitHub still shows as exactly [the head it was made from, the base tip of that update]) runs nothing and keeps the hold: exit 0 {ok:true, configured:true, kept:true, why:'own-successor', head}; a PR-side push, an unrecorded head or a head that cannot be read releases as usual (the unreadable case with a warning). Codes added for the automatic cases: ci-failed (the required checks failed), update-conflict (the catch-up conflicts), queued-behind (an older hold is ahead and the wait ended), hold-unreadable (the check could not be read)
It never merges and acts only on the PR given (the session's own); use it to hold the merge queue at a merge hand-off and to release it when the hand-off ends without a merge.

Queue mode (the base branch has a GitHub merge queue; see merge): no merge hold is needed. `--check` answers `{ok: true, outcome: 'front', queueMode: true}` and a take answers `{ok: true, taken: false, queueMode: true}`, running no hold command; `--release` is unchanged.
```

Exit: 0 hold confirmed / released, or `--check` found no blockers, or the repo has no `merge.hold_*` keys (`{ok: true, configured: false}`) · 1 the hold was refused or not confirmed, or `--check` found `queued-behind` (a blocker is ahead: `blockedBy`, `doNotUpdate: true`, a reason naming #A, its title and its expiry in PHT) or `hold-unreadable` · 2 usage (an unknown `--reason` code) or environment error.

Default runs `merge.hold_command` for PR N; `lines` is the last 5 output lines. `--check` runs `hold_check_command` only (read-only, same answer as the dry run's `holds`). `--release --reason <code>` runs `hold_release_command`; the code maps to a fixed sentence, so no free text reaches the shell. The review skill takes the hold at hand-off and releases it when the hand-off is withdrawn (a new commit, the PR parked, the owner declines or asks for changes); a review that stops for a terminal restart (`restartRequired`) releases it with `--reason restart`; a successful merge needs no release (the repo's merge command removes the hold). Configuration, enforcement, rollout and rollback: see Merge hold under `merge`.

`--release --reason new-commits` first reads the PR head (one `gh pr view`) and keeps the hold, running nothing, when it is the pipeline's own successor head (output `{ok: true, configured: true, kept: true, why: 'own-successor', head}`, exit 0; see Taking the hold for a catch-up under `merge`); a head that cannot be read releases with a `warnings` line. The new reason codes `ci-failed`, `update-conflict`, `queued-behind` and `hold-unreadable` are used by the automatic releases of `update-branch` and `merge` and by the skill (`ci-failed` before a fix, `queued-behind` when a wait ends). `--check --wait [--max-minutes M]` polls the read-only check at once and then every 5 minutes (fixed, no override: the repo's check costs about 15 API calls and the 5,000/hour budget is shared; `M` is an integer 5..240, default 120, and bounds when a poll may START: a poll starts only if it can start by the deadline, a running check keeps its own 5-minute timeout) and answers `outcome: front` (exit 0: nothing is ahead, update again), `timeout` (still queued, exit 1) or `unreadable` (two unreadable answers in a row, exit 1, fail closed). It runs longer than a tool call may: start it with `pipeline job start turn -- pipeline merge-hold --pr N --check --wait`.

## model-floor

show the Fable model floor; reset it (owner only, run in your own terminal): back to the shipped minimum, optionally holding it.

```
pipeline model-floor show   -> {ok, floor, MIN_FABLE, registry, readableAllowed: [allowed ids the parser reads now: drop one with `reset --remove-allow <id>`], file, error?} : READ-ONLY, runs anywhere; exit 0, or 1 when the registry file is unreadable (reviews are blocked until a reset)
pipeline model-floor reset [--hold <fable model id> | --clear-hold] [--clear-lock]   -> {ok, floor, hold, file, clearedLock}
pipeline model-floor reset --clear-lock --keep-floor   (clear a stuck floor lock and nothing else: the registry, the learned floor, the hold and the allowances stay as they are)
pipeline model-floor reset [--allow-id <exact claude-fable-… id> ... | --remove-allow <id> ... | --clear-allow]   (also takes the options above; the output then carries allow: [ids] when any are set)
  with --allow-id, --remove-allow and/or --clear-allow (and no --hold / --clear-hold; --clear-lock alongside is fine) it is not a reset: it changes the allow list and keeps the learned floor (newest, history) and the hold; a corrupt registry is refused
  (exit 1 model-floor-unreadable): run a plain `model-floor reset` first.
  Owner only: refused inside Claude Code (exit 2 `refused`); run it in your own terminal (`node ~/.claude/pipeline/bin/pipeline.mjs model-floor reset`).
  A plain reset (no --allow-id / --remove-allow / --clear-allow, or together with --hold / --clear-hold; a bare --clear-lock too, which also forgets the learned floor: use --clear-lock --keep-floor to keep it) rewrites the registry to the shipped minimum (a corrupt or unreadable registry is replaced); an existing hold and allowed ids are kept.
  --hold <id>   also caps the floor at that Fable id (a claude-fable-* id) until `model-floor reset --clear-hold`. Use it to roll back an alias
                (the `fable` alias moved to a model you do not want) or when the two accounts resolve different Fables. It also lowers the version
                below which a recorded Fable proof is re-reviewed, so a review proven with the held model can complete.
  --clear-hold  lift the cap (not with --hold)
  --allow-id <id>  accept that exact claude-fable-* id although the parser cannot read it; repeatable, at most 10. An allowance never raises the floor for an id the parser cannot read, and an id the parser reads that is below the floor is refused all the same.
                A claude-fable-* id the parser cannot read blocks reviews, including the PR that fixes the parser: run `model-floor reset --allow-id <the new id>` in your own
                terminal, merge the parser fix, then `model-floor reset --remove-allow <that id>` (neither forgets the learned floor).
                Until then `arbiter apply`, `model-proof`, `review-complete`, the final gate and `preflight` say the allowance is in force. (`--hold` does not unblock an unreadable id: it only caps the floor.)
  --remove-allow <id>  remove exactly that id from the allow list (repeatable; the other ids stay). An id that is not on the list is refused (exit 2), naming the list. Not with --clear-allow, nor with --allow-id for the same id.
  --clear-allow remove every allowed id (not with --allow-id or --remove-allow); to drop one id use --remove-allow
  --clear-lock  first remove a floor lock left behind by another host or an unreadable owner record (a dead holder's lock clears itself). It removes only the lock it inspected (a lock a review takes meanwhile stays: exit 1 model-floor-lock-changed) and does nothing when there is none. It refuses while the holder is a running process on this machine (exit 1 model-floor-lock-live, naming the pid and the lock folder): confirm that pid is a pipeline process (`ps -p <pid> -o command=`) and stop it or wait for it; when it is not (the pid was reused by an unrelated program), remove the lock folder by hand. A lock that cannot be read (permissions, I/O error) is refused too (model-floor-lock-unreadable). Another recovery, or a review that is just starting up, holds the lock for a moment: it refuses with model-floor-lock-busy (exit 1); run it again in a moment. On its own it is a plain reset (the learned floor goes back to the minimum): add --keep-floor to clear the lock and keep the learned floor
  --keep-floor  with --clear-lock and nothing else: remove the lock and rewrite nothing (a corrupt registry is refused: run `model-floor reset --clear-lock` first)
```

Exit: 0 ok · 1 the registry is unreadable (`show`) or could not be written / is locked (`reset`) · 2 usage, or `reset` refused inside Claude Code.

The floor is the oldest Fable model a review may be proven with on this machine: `max(MIN_FABLE, newest Fable proven here)`, capped by an owner hold; a Fable id the parser cannot read, if the owner allowed it by exact name (`--allow-id`), is accepted and never raises the floor (an allowed id the parser reads and that is below the floor is refused like any other, so a forgotten allowance cannot pass an old model). A call with only `--allow-id` / `--remove-allow` / `--clear-allow` changes the allow list and keeps the learned floor and the hold (`--remove-allow <id>` drops one id and leaves the rest; `--clear-allow` drops them all); only a plain `reset` goes back to the minimum. A stuck floor lock is cleared with `reset --clear-lock --keep-floor`, which touches nothing else (it refuses, `model-floor-lock-live`, while the lock's holder is a running process on this machine: confirm the pid is a pipeline process with `ps -p <pid> -o command=` and stop it or wait, or, when it is not (a recycled pid), remove the lock folder it names by hand, so a review mid-proof never loses the lock it relies on; it removes only the lock it inspected and a lock taken meanwhile survives; `arbiter apply` also re-checks the lock and re-reads the floor just before it saves); a bare `--clear-lock` is a plain reset. While an allowance, or a hold below `MIN_FABLE`, is what lets a proof count, `arbiter apply` and `model-proof` print `floor: {newest, allowed, heldBelowMin}`, `review-complete` and the final gate's review check add a note naming the round, and `preflight` warns. Recorded proofs are re-reviewed below the lower of `MIN_FABLE` and the hold. The registry lives under the account's `owner-go/model-floor/`, which the guard protects, so only the pipeline commands (never an agent's shell) write it. A plain `reset` is the only way down: it writes the shipped minimum back and keeps (or sets with `--hold`, or clears with `--clear-hold`) the ceiling.

## model-proof

prove a subagent ran on the expected model and effort.

```
pipeline model-proof (--tag TAG | --agent-id ID) [--expect-model claude-fable-] [--expect-effort high]
                     [--expect-agent-type TYPE] [--expect-meta-model MODEL] [--projects-dir DIR] [--max-age-ms N]
  -> {ok, transcript, meta, models, efforts, claudeCodeVersions, errors, finalAssistantText, stopReasonMissing, finalVia}; exit 0 proven, 1 mismatch, 2 not found/unreadable
  any Fable on any line must also be at least this machine's floor (read-only here, the floor is never raised): older => exit 1, error stale-model, restartRequired: true,
    floor: {newest, seen}, advice
  a proof that passed only through an owner allowance (an id the parser cannot read) or a hold below MIN_FABLE adds floor: {newest, allowed: [ids], heldBelowMin: <hold>|null} to the output
```

Exit: 0 proven · 1 mismatch · 2 transcript not found / usage.

## preflight

report whether the pipeline may merge (config, gh, protection, pause, Codex).

```
pipeline preflight [--repo DIR]   (exit 0 can merge, 1 cannot, 2 config missing/invalid)
  warnings (informational, never change canMerge): a stale terminal; an owner allowance (model-floor reset --allow-id) or a hold below MIN_FABLE still in force in the model floor registry; an allowed id the parser can read now (the allowance is no longer needed)
```

Exit: 0 pipeline may merge · 1 it may not (`reasons`) · 2 config missing or invalid.

The report also carries `claudeCode: {running, installed, stale}` (the Claude Code build this terminal runs, from `AI_AGENT`, against the installed one, from `CLAUDE_CODE_EXECPATH`; `stale` is `true` when the terminal is older, `null` when either is unknown) and a `warnings` array; a stale terminal adds a "restart it before a review's Fable pass" warning. Neither ever changes `canMerge` or the exit code.

Branch protection must require `ci.required_checks` AND, unless `ci.guard_checks: false`, the guard contexts `Test integrity` and `Hard-stop scan` (plus `Cross-model review` with `ci.review_check: true`); `protect` sets that same list.

## protect

print (or with --apply, set) the GitHub branch protection and repo settings the pipeline relies on.

```
pipeline protect [--apply] [--checks a,b] [--pin NAME=APP_ID,...] [--repo DIR]   (--apply needs PIPELINE_ADMIN=1)
```

Exit: 0 dry run printed, or applied with nothing missing or unpinned · 1 no admin rights / plan limit, or something still missing or `unpinned` after applying · 2 usage (`--apply` without `PIPELINE_ADMIN=1`) · 3 GitHub (`gh`) unavailable.

Every required check is pinned to the GitHub Actions app (`app_id: 15368`): only a status a workflow posted with `GITHUB_TOKEN` satisfies it, never one posted with a person's token (which agents share), so `Test integrity`, `Hard-stop scan` and `Cross-model review` cannot be posted from a terminal. A check another app posts (a deploy provider's `Vercel`, say) cannot be satisfied by GitHub Actions, so before building the payload `protect` reads the branch's current protection and keeps such a check on the app it is already pinned to (a positive app id other than Actions; `-1`/null "any app" is not kept); `--pin NAME=APP_ID` names the app for a first setup or overrides a kept pin. Both are printed on stderr and listed in `pins`. The three guard contexts are always pinned to Actions: `--pin` refuses them and a foreign pin on them is not kept. A dry run that cannot read the current protection still prints the commands without kept pins and says so; `--apply` stops instead (exit 3), since applying without the current pins would move a deploy provider's check onto Actions and block every PR (a branch with no protection yet, or a 403, reads as "nothing to keep"). The read-back after `--apply` lists checks GitHub reports without their pin in `unpinned` and fails. The default list is `requiredChecks` (`ci.required_checks`, the guard contexts unless `ci.guard_checks: false`, and `Cross-model review` with `ci.review_check: true`). The `commands` it prints begin with the ABSOLUTE path of the `gh` it found (PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, ...), quoted for sh, because the owner pastes them into a shell whose PATH can lack `gh`; on Windows, or when no `gh` is found, they begin with a bare `gh`.

## queue-sweep

carry every queued PR of the pipeline repos to its end (the renewable observer for queue mode).

```
pipeline queue-sweep [--repo <root>]   -> {ok, repos:[{root, settled:[{pr, outcome, terminal?, hold?, position?, removalReason?, message?, why?}], skipped:[{pr, why}], errors:[text]}]} ; settles each live merge-queue record once (merged | queued | requeued | ended | unsettled ...); no live record = no GitHub call; exit 0, 1 when a record could not be settled (unsettled / restore-failed / error)
```

Settles each live merge-queue record (see merge, Queue mode) of every pipeline repo the machine knows, or only `--repo`: one reconcile with GitHub per record, then the same rules as `merge` (a removal for failed group checks is re-queued once from the recorded worktree when the checks of the route that opened the record pass: for an `owner-go` record (or one written before the route was recorded) the owner-go record is still valid and the live scan, approval and stop-condition checks pass; for a `gated` record the worktree's `final-gate.json` still passes the checks `merge` applies to it (repo, check list, PR head, patch, age, not future-dated), and the live gate (the same owner items as the gate's), owner approval (where the gate left owner items, or where the first enqueue stood on the owner's word) and stop-condition checks pass; a stop condition dequeues; an owned `needs-human` hold is restored only at an unmerged terminal end). Each terminal outcome (merged / removed with the failing check / blocked with the reason) is reported to the owner: a line on stderr, a line in `queue-sweep-notices.log` (next to the other pipeline logs) and, on macOS, a banner (`PIPELINE_NO_BANNER=1` turns the banner off). A re-queue is only attempted from the worktree the owner approved (its directory exists, its HEAD is still the recorded head, same repository) and then runs that route's full evaluation again; otherwise the record ends `removed`, an owned hold goes back and the notice says to re-run `P merge --pr N`. Without `--repo` it sweeps the repos of the `stacks` machine config plus every repo a `merge`, `final-gate` or `queue-sweep --repo` named before. A record whose PR a `merge` job is working on (the same per-repo-and-PR merge lock) is skipped this run. It exits at once, with no API call, when no live record exists. `final-gate` and `merge` run the same settling for the repo first, best-effort; `final-gate`'s never enqueues.

On macOS a LaunchAgent `com.claude-pipeline.queue-sweep` runs it every 10 minutes (and at load), written, health-checked (the installer's check mode reports it missing or not loaded) and removed by the installer for the user's own Claude home only (a scratch `--claude-home`, an isolated stacks root and other platforms never touch it), built with the same helpers as the `stacks` sweep agent.

## repo-move

record that a GitHub repository was renamed or transferred, so your earlier owner approvals still count (run in your own terminal); --list shows the records.

```
pipeline repo-move --list   -> {ok, file, moves, error}
pipeline repo-move --from <owner/name> --to <owner/name> [--at <ISO time>]   -> {ok, added, move, moves, file}
  Records the move in ~/.claude/pipeline-state/owner-go/repo-moves.json (agents cannot write it). GitHub must confirm it: the old name has to
  resolve to the new full name and to the same repository id. --at is when the move happened (default: now; at most 5 minutes ahead of now); only approvals, rulings and
  grants made BEFORE it count for the new name, never the other way round. Adding the same move (same time) twice is a no-op, the same names at a later time are appended (a move back and forth); a second move out of the same name at the same instant
  but to a different name is refused (one name cannot lead to two places at once: fix or remove the earlier entry; such a tie never aliases); an invalid existing file
  is refused (fix or remove it).
  Refuses inside Claude Code (run it in your own terminal) unless --list is given or the owner launched Claude Code with the admin switch.
```

Exit: 0 recorded / already recorded / listed · 1 GitHub does not confirm the move (the old name must resolve to the new full name and the same repository id), the existing file is invalid, or `--list` found an invalid file · 2 usage (including an `--at` more than 5 minutes ahead of now), or refused inside Claude Code · 3 GitHub unavailable (a name that does not resolve counts as unavailable).

Why: the owner-go records (your chat "merge", `⚖️` rulings, `extra round` grants and their consumed markers) store the repository name as it was shown, and every check compares it with the current `origin`. After a rename or transfer an old record would stop verifying. The move is kept in `repo-moves.json`, inside the owner-go records folder the guards protect (an agent cannot write it). A record that names the old name counts for the new one only when it was made BEFORE the move; a record naming the new name never counts for the old, and one made at the old name after the move is a different repository's. A missing or invalid file means no aliasing. The guard-status provenance check likewise accepts a run URL under a former name when `repos/<former>` and `repos/<current>` answer the same repository id.

## review-complete

post the review-complete comment (and remove awaiting-review) once the review is valid for the current content.

```
pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, posted|reused, comment:{id, url}, review, removed, recheck, recheckError?}; exit 1 {ok:false, reason} when the review is not valid
  origin/<default_branch> is fetched first (best effort: offline keeps the cached ref, and a coverage refusal then says it could not be refreshed), so a PR updated
  from its base branch and pulled is judged against the main that was merged in
  after the validity checks it also refuses (exit 1) while a Claude-ruled follow-up has no issue or a fix made outside the file the finding names is not yet
  confirmed by a later round, and (exit 1 {error:closing-keywords}) a PR body that lists several issues after one closing keyword ("Closes #1, #2" closes only #1),
  then publishes the triage state when the PR holds a different one (exit 1 {error:stale-publication} when the PR holds a state this
  copy did not publish or restore: run `pipeline state show --pr N`), and only then posts the marker. The record carries rulingsDigest only when there are rulings
  the checked-out HEAD must be the head GitHub holds for the PR; the PR must have had every Fable pass its risk or paths need
  the comment starts with the line `<!-- claude-pipeline:review-complete v1 -->` and carries the JSON {contentHash, base, head, rounds, codexModel, modelProofDigest, stateHash}
  (base = the merge base the content hash is measured from; modelProofDigest = sha256 of the Fable model proofs, null when no Fable pass ran; stateHash = the hash of the review state the marker
  was issued for: the owner-go review-complete check refuses a state republished after the marker, and a marker from before the field, until `review-complete` is run again);
  an identical latest comment of ours is reused, not posted again; exit 3 when GitHub is unavailable or the label is still on the PR after removal
  a round past review.max_rounds must carry the owner's extra-round grant (codex-review records it), re-proved here against the owner's record and its marker on THIS machine (the
  same check as the final gate's review check): exit 1 {ok:false, reason: "round n: owner grant cannot be verified on this machine ..."} otherwise
  a proven Fable round recorded with a Fable older than MIN_FABLE (or the lower hold of model-floor reset --hold) that no later whole-PR pass at or above it replaced is refused: exit 1 {ok:false, error:fable-refresh, reason, staleFableRounds:[{round, models}]},
  the reason names the rounds and models and says `run `pipeline state fable-refresh --pr N``; the final gate's review check refuses the same PR the same way
  when a proven Fable round counts as current only because of the owner's allowance (model-floor reset --allow-id, an id the parser cannot read) or a hold below MIN_FABLE, the comment gets one line
  "Standing Fable bypass: Fable round 3 counted via owner allowance <id>" (or "... via owner hold <id> (below <MIN_FABLE>)"), the output carries fableBypass:{note, rounds:[{round, via, id}]},
  and the final gate's review check detail carries the same note
```

Exit: 0 comment posted (or our identical one reused) and the label is off · 1 review not valid for this head (nothing posted) · 2 usage · 3 GitHub unavailable, or the label still on the PR after removal.

Run it at the end of every clean review, before `gh pr ready`: the review instructions mark a PR ready only once this
comment exists. The comment is append-only evidence (a new comment per new head, never an edit). `contentHash` is
`contentHash(base, head)` minus the agent log (git.mjs), so a check that fetches only git data can recompute it.
Validity is the state's (every round clean, coverage = this content) PLUS a lane re-check from the PR itself: a PR whose
files, size or recorded risk call for the Fable pass is refused unless some round ran a proven one.

Docs-only exemption (`review.docs_exempt_paths`, default empty = off): the one exception to "coverage = this content". When the last round
is valid for its OWN content (nothing unresolved, every Fable pass proven) and its hash really is the hash of its `toHead`, and
the only changes since `toHead` ADD ledger rows to files listed in that list, the comment is posted for the CURRENT hash and head (the record's
shape is unchanged, so the vendored guards read it as ever) with a visible line naming the files and the reviewed head, and the output
carries `docsExempt: {files, reviewedHead}`. The final gate's `review` check uses the same helper (`lib/docs-exempt.mjs`) and shows the files
in its detail; verify/CI coverage of the docs head is NOT exempted. Every condition: the list is read from `.claude/pipeline.yml` AT `toHead`
(a commit cannot widen its own exemption); every entry is an exact path of an ordinary document (`lib/doc-paths.mjs`: markdown anywhere,
text/rst/adoc under `docs/`, LICENSE/CHANGELOG; never an agent-instruction file (`CLAUDE` / `AGENTS` / `AGENT` / `GEMINI` `.md` and their `.<variant>.md` forms, e.g. `AGENTS.override.md`, `CLAUDE.local.md`; `.cursorrules`; `copilot-instructions.md`; any depth and case: the same list, `isAgentInstructionPath`, makes them R4-config hard stops), html, mdx, source, or anything under
any dot-directory (`.claude/ .github/ .cursor/ ...`), `app/`, `pages/`, `skills/ agents/ pipeline/ scripts/`) that no hard-stop path rule claims and that is not on `integrity.test_globs`,
`hard_stops.paths`, `review.arbiter_always_paths`, `risk.high_risk_paths`, nor under `supabase/` or a `migrations` directory (validated by
config AND re-checked at run time); `toHead` is an ancestor of HEAD, no merge commit and no merge-base change since; every changed file
(both sides of a rename) is listed, a regular 100644 non-binary file, and only added to (no edited or removed line, deletion, rename, mode
change, symlink). Every added line must be a strict ledger row, `` | NNNN | `name` | YYYY-MM-DD | #PR | | `` (four-digit number, the Note column empty: a row
with a note, prose, a blank line or CRLF takes a round); the added rows are the last lines of the file, their numbers strictly increase and
continue above the last row of the reviewed file, and `NNNN_name.sql` is a regular file in a directory called `migrations` in the tree at `toHead`.
No instruction file of the reviewed head (and no file it `@`-imports, up to 5 hops, symlinks followed, case-insensitive) may import a listed document, and no
symlink on the way may cycle, dangle or lead out of the repository. An import the scan cannot judge inside the reviewed tree also takes a round: a relative path that
climbs above the repo root (lexically or through a symlink), `@/abs/path`, `@~/path` and `@~`, a drive on every platform (`@C:\x`, `@c:/x`, `@C:x`), and any token or symlink target with a backslash (`@docs\ledger.md`, `@..\x`, `@\\server\share`: a separator on Windows, a filename character on POSIX, so it cannot be judged; an escaped space `\ ` counts too), and any token with a path segment that ends in a dot or a space (`@docs./ledger.md`: Windows drops it; sentence punctuation after the path is not one). A path that only does not exist in the tree (`@supabase/ssr`) is ignored.
A reviewed file with no final newline takes a round for any append (git sees its last line as edited); the reason says so.
A refusal names the file that forces a round: `reason` ends with "the docs-only exemption does not apply: <file> ...".

With `ci.review_check: true` the guard workflow turns this comment into the `Cross-model review` status (success only when
the newest such comment by an allowed author names the content hash of the PR head). A comment starts no workflow, so
`recheck` says how the guards learn about it: `on-ready` (a draft: marking it ready starts them), `label-removed`
(removing `awaiting-review` already did), `triggered` (a ready PR: the command added and removed the label
`pipeline-recheck`, created by `P labels`), or `failed` with `recheckError` (the comment stands; add and remove
`pipeline-recheck` by hand — only labels the guards act on start a run, see the header of `pipeline-guards.yml`). A failed nudge never changes the exit code. The guards recompute the hash from the BASE branch's config
(`agent_log`) and the base tip the workflow checked out; this command uses the local config and `origin/<default>`. When the
two differ (a stale local `origin` ref, an agent log renamed on the branch) the status fails closed with "the content changed
since the review": fetch, re-run the review, and post again.

## risk

assess the risk level of a branch diff.

```
pipeline risk --base REF --head REF [--repo DIR]   -> {ok, level, reasons, lightLane, changedLines, fileCount, hardStops, base, head, mergeBase}
```

Exit: 0 whenever a level could be computed (it is a report, not a gate) · 2 usage / config / git.

Levels: a blocking hard-stop hit, an `ownerMerge` hit (owner_approval: chat) or a `risk.high_risk_paths` match is
`high`; a report-only (advisory) hit alone is `medium`; size adds `medium` / `high` by `risk.medium_lines`,
`risk.high_lines`, `risk.medium_files`. The level picks the reviewer after Codex (`codex-review` records it): `low` →
the judge (Sonnet); `medium` / `high`, or any file on `risk.high_risk_paths` or `review.arbiter_always_paths` → one
Fable pass per round that rules on every Codex item and reviews the diff itself (`arbiter needed` mode `review`).

## smoke

run the configured preview/production smoke command and record the result.

```
pipeline smoke --target preview|production --url URL [--expect-text T] [--sha SHA] [--repo DIR]   -> {ok, target, url, sha, exitCode, tail, at}; exit 0 passed, 1 failed, 2 not configured/usage
```

Exit: 0 passed · 1 failed · 2 not configured / usage.

Optional firewall bypass: with `smoke_bypass_header: x-smoke-key` (lowercase `x-` name, default null) in `.claude/pipeline.yml` and the secret in the `PIPELINE_SMOKE_BYPASS_KEY` environment variable, the vendored `scripts/pipeline/smoke.mjs` sends that one header, only when the base's origin is exactly one of `smoke_bypass_origins` (required, non-empty when the header is set; https origins such as `https://www.example.com`, no wildcards, default `[]`; never a preview URL, other host or localhost), so a firewall "Bypass" rule can let a CI runner through. It is a firewall hint, not app auth (still a cookie-less GET, redirects not followed). The value is read from the environment only (the smoke command inherits the caller's environment) and is never printed: the smoke's JSON gains `bypassHeader: true|false` (whether it was sent; false when the env value is missing or the base is not a listed origin).

PATH of project commands: `merge.command` (merge), the `smoke` commands (smoke) run with the caller's environment. When `gh` is not on that `PATH` but the pipeline's own `gh()` finds it in a fixed install dir (`/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/usr/bin`), that directory is APPENDED to the command's `PATH`, so a command that spawns `gh` itself (a sandbox `PATH` often lacks `/opt/homebrew/bin`) no longer fails `spawn gh ENOENT`. Unchanged on Windows, under a `PIPELINE_GH` override, or when `gh` is nowhere.

## stacks

stop private local Supabase stacks and dev servers once nobody needs them (daily sweep, session-end worker, status, repair, init, schedule).

```
pipeline stacks sweep [--apply] [--summary-only]   -> {ok, summary, stopped:[...], wouldStop:[...], listed:[...], kept:[...]}
pipeline stacks session-end --owner PID:BIRTH   -> {ok, waited, stacks:[...], dev:[...]}
pipeline stacks status   -> {ok, configured, modes, paused, leases:[...], report}
pipeline stacks repair   -> {ok, moved}
pipeline stacks init [--write]   -> {ok, config, written}
pipeline stacks schedule (--install [--at HH:MM] | --remove | --status)   -> {ok, installed|removed, label, timezone, warning?}
```

## state

show or update the review loop state (.review/state.json).

```
pipeline state show [--round R] [--accepted] [--disputed] [--needs-human] [--pr N] [--repo DIR]
  -> {ok, recovered, source, count, items}; with --pr and no local state, rebuilds it from the PR triage comment
  with --pr and a local state: the published (triage comment) state is authoritative. Local is kept (source local) when it
  equals or strictly EXTENDS the published one; otherwise .review/ moves to .review/stale-<UTC time>/ (source quarantined,
  quarantinedTo) and the published state is restored. source is local | published | quarantined | local-ahead | local-unverified
  (local-ahead: the PR still holds what this copy last published, every published round and item is still in the local copy, and the local copy holds a second-review verdict or a Claude / forced final that was
  never published, or a decision that continues the published Claude / forced final or the published final of an item waiting for a human (a tightened ACCEPT, an owner ruling; possibly several unpublished steps, whose overruled chain reaches the published final), or an implementation mark or a follow-up issue link added after the last publish: kept, with a warning naming the retry command). A restored or quarantined copy records the published state as its baseline
  (.review/published-baseline.json), which is what the next publication is checked against (lib/review-publish.mjs)
  (GitHub unreachable but a local state exists: served as is with a `warnings` entry, exit 0; with no local state exit 3)
pipeline state discard-round --round R [--pr N] [--repo DIR]
  -> drop an unpublished, trailing round R from the local state and move .review/round-R/ into .review/stale-<UTC time>/;
     refused (exit 2) when the PR triage comment already holds round R, or (error round-has-verdict) when the round holds a second-review verdict
pipeline state outcome [--repo DIR]   -> roundOutcome + {clean, arbiterFailures, followupsPending, rounds, reviewedRounds, maxRounds}; exit 0 whether or not clean
  first fetches origin/<default_branch> (best effort: offline keeps the cached ref), so a PR updated from its base branch is not read as changed
  grantedRound {k, grantId, head, quote}: the owner's open extra-round grant for the next counted round and the checked-out HEAD (chat mode, an owner
  record younger than 24 h, not yet used) - it lifts reachedMax and effectiveMaxRounds by one; null otherwise. autoExtraOrdinal: the counted round the
  automatic extra round took, or null
pipeline state mark-implemented --ids a,b [--repo DIR]
  -> exit 2 {error:no-code-change} unless the branch content differs from what the accepting round reviewed
     and a non-test file changed since (a test file counts for a testing finding or the finding's own file)
  -> a forced or Claude-ruled ACCEPT whose named file is empty or was not changed is still marked, with implementedVia 'other-files': the next codex-review
     round asks Codex to confirm it (round.confirmFixed) and review-complete waits for that round. Ordinary ACCEPTs get no such field
  -> exit 3 {ok:false, unavailable:true, reason:base-refresh} and nothing is marked when origin/<default_branch> cannot be fetched (offline, remote down) while the
     hash would be measured from it - also with no origin remote but a leftover origin/<default_branch> ref: a stale base would count the default branch's commits as the fix
pipeline state fable-refresh --pr N [--repo DIR]
  -> {ok, round, staleRounds, scope: "whole-pr"}: opens an uncounted Fable-only round (no Codex, not counted against review.max_rounds, allowed past it and with no new commit) on the pushed head, so a Fable pass proven with
     a Fable older than MIN_FABLE (or the lower hold of model-floor reset --hold) is re-reviewed. Refused (exit 2) unless a proven Fable round is below that and no later whole-PR pass at or above it replaced it (error nothing-stale), every earlier round is finished
     (error unfinished-round: a Fable pass owed, an undecided, human-owed, unimplemented or newly accepted item), HEAD is the head of PR N on GitHub (error head-not-pushed; exit 3 when GitHub is unreachable)
     and the content is what the last round reviewed, or only ledger rows were added since (review.docs_exempt_paths; the round then stays pinned at the last reviewed head) (error content-moved: run a normal codex-review round instead, its Fable pass already reads the whole PR). Then: arbiter needed --round R, the arbiter, arbiter apply
pipeline state record-followup --id ID --url URL [--repo DIR]
pipeline state set-outcome --outcome TEXT [--repo DIR]
```

Exit: 0 · 2 no state / usage (`outcome` is 0 whether or not `clean`).

## summary

upsert the PR summary comment and print the agent-log line.

```
pipeline summary --pr N --outcome O [--built TEXT] [--session ID]... [--repo DIR]   -> {ok, url, agentLogLine, pendingLogLine?, cost}   (pendingLogLine: only for --outcome merged, the same line with outcome "merged — prod smoke pending")
```

Exit: 0 · 2 usage / no state · 3 GitHub (`gh`) unavailable.

Without `.review/state.json` only `--outcome blocked`, `awaiting-review`, `stopped`, `closed` and `merged-externally` are accepted (the early-stop paths: verify red three times, Codex out in round 1, a stop on a gate or merge refusal, the owner closing the PR, a merge made outside the pipeline): the comment is rendered with no rounds (a `blocked` one names the failing step from the verify report) and `agentLogLine` is still printed. Any other outcome without state is exit 2.


## triage

apply the judge triage, settle disputed bugs with test results, close the light lane, ask for and record owner rulings made in chat, record Claude's own rulings, run the blind Codex second review.

```
pipeline triage validate --round R (--from-tag TAG | --file F) [--projects-dir DIR] [--max-age-ms N] [--repo DIR]
  -> {ok, round, counts:{ACCEPT,FOLLOW-UP,REJECT}, settled, unsettled, judgeProof}; exit 1 + errors when the judge output is invalid (state untouched)
pipeline triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd CMD --test-file FILE [--repo DIR]
  -> the CLI runs CMD in the repo itself (free-text evidence is not accepted): bug-disproved needs exit 0, bug-confirmed needs a failing exit; FILE must be a committed, clean test file at HEAD named in CMD
  -> only for a disputed bug with a possible settle test and no test result yet; exit 1 for an item that needs a human, was ruled by the arbiter or is implemented
  -> a bug-disproved result on a security/auth/permissions/data item is still needsHuman
pipeline triage light-lane --round R [--repo DIR]
pipeline triage ruling-request --pr N --ids ID[,ID…] [--repo DIR]
  -> {ok, line}: the LAST line of the reply that asks the owner to rule, `⚖️ Owner ruling needed #N: ID, ID · content <digest12> · repo owner/name`; the digest covers the text of exactly those items in the current review state (exit 1 for an unknown id, a --pr that is not the review state's, or a repository off github.com)
pipeline triage round-request --pr N [--repo DIR]
  -> {ok, line, k, n, head}: the LAST line of the reply that asks the owner for ONE more review round past review.max_rounds, `🔁 Extra review round needed #N: round K · head <head12> · repo owner/name`
     (k = the counted round it would be: reviewed rounds + 1, base-only and resolution-only rounds not counted; n = the round number to pass to codex-review --round; head = the checked-out HEAD)
  -> commit, push and quick-verify first: the grant is for that head. The owner answers `extra round` (or `grant round K`, optionally with #N); the owner-go hook records it, and
     `codex-review --round n` then claims it (see its usage). Exit 1 for label mode (no grant exists), a --pr that is not the review state's, a repository off github.com,
     or a round that is already allowed (within review.max_rounds, the automatic extra round, or an open grant for this head)
pipeline triage claude-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --pr N [--repo DIR]
  -> {ok, round, id, final, published, next?}; records CLAUDE's decision (final.by claude, needsHuman false, the overruled final and the cause kept) for an item waiting for a human, or tightens a Claude dismissal
  -> only with owner_approval: chat; exit 1 for label mode, a --pr that is not the review state's, an empty reason or one over 1000 characters, or a ruling the rules refuse (state untouched)
  -> ACCEPT is always allowed (also for a judge/arbiter malfunction). FOLLOW-UP alone only for a non-BLOCKING, non-security item with a known cause; any REJECT, and any dismissal of a BLOCKING or security item,
     needs a second review already on the item that also dismisses it at high confidence (the result is the stricter of the two). Refused: a dismissal through a model-proof / invalid-arbiter / invalid-judge
     malfunction (re-run the judge/arbiter, or ACCEPT), a loosened ACCEPT (only the owner's typed ruling loosens), an implemented item, and anything settled by a test, the judge, the arbiter or the owner
  -> the ruling is published at once, under the review lock (published: true): the triage comment is updated as a compare-and-swap on the state's content (lib/review-publish.mjs). When GitHub cannot be reached the ruling stands locally (published: false, next = the retry, `pipeline comment --kind triage`); when the PR holds a state this copy did not publish or restore it is published: false, publishError: 'stale-publication' (run `pipeline state show --pr N`, then redo). It writes review state format version 2
pipeline triage second-review --round R --ids ID[,ID…] --pr N [--repo DIR]
  -> {ok, round, verdicts:[{id, decision, confidence, reasoning, final}], forcedAccept:[ids], published, publishError?, next}; runs ONE Codex call (review.codex_model, effort high, read-only, fresh session) over a BLIND packet of the named items
     and stores its verdict in each item (item.secondReview), for claude-ruling to read. The packet is built from the review state and git alone: the original finding (id, bucket, category, title, file, line, detail, the reviewer's reasoning),
     the test evidence the CLI recorded, the pinned head, the PR title and risk, fenced as untrusted text; never the judge's, the arbiter's or Claude's reason or decision. Codex is told to verify the claims in the code, read-only
  -> only with owner_approval: chat; each id must be an item of round R that waits for a human (final.needsHuman) with a cause that is not a judge/arbiter malfunction, is not implemented and has no second review yet: anything else refuses the whole call naming the id (exit 1, state untouched)
     (ONE second review per item: a second call refuses). Codex ACCEPT sets the final ACCEPT at once (final.forcedBy second-review; fix it); a dismissal leaves the final as it was: at high confidence claude-ruling may dismiss it (the stricter of the two stands), below high only ACCEPT (or the owner's typed ruling) is possible
  -> the check runs under the review lock, Codex runs outside it, then the state is read again under the lock: nothing is recorded (exit 1) when HEAD moved, an item's final or finding text changed, or a verdict appeared meanwhile
  -> exit 1 {ok:false, reason} for an answer that is not exactly one valid verdict per requested id (or no usable answer after Codex exited 0): nothing is stored, so run it again. exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|github} when Codex or GitHub could not deliver: state untouched, the PR waits (review-loop.md rule 2)
  -> the prompt and the raw answer are kept as .review/round-R/second-review-<first id>.md and .json; the result is published like a Claude ruling (published / publishError / next as for claude-ruling); it writes review state format version 2; env PIPELINE_CODEX_TIMEOUT_MS as for codex-review
pipeline triage owner-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --owner-quote TEXT [--pr N] [--repo DIR]
  -> {ok, round, id, final, published: false, next}; records the OWNER's decision (final.by owner, needsHuman false, the exact quote and time, the overruled final kept) for an item that needs a human
  -> only with owner_approval: chat; exit 1 for label mode, an item that is not waiting for a human and has no unimplemented Claude ruling (settled items are not reopened), a missing item, an empty reason or quote, or a --pr that is not the review state's
  -> works on an already published round. ACCEPT still needs the fix and a later review round; FOLLOW-UP is filed by `followups create`; the quote is published in the triage comment and the final gate counts it as ownerMerge (the owner's "merge" is still needed)
  -> the quote must be the WHOLE owner prompt that answered a reply ENDING with the line `triage ruling-request` printed (`⚖️ Owner ruling needed #N: ID[, ID…] · content <digest12> · repo owner/name`; the owner-go hook records it; any session, last 24 h; white space and case aside), and that answer must be nothing but decisions, `ID: accept|follow-up|reject` per asked id, the id always written (any other word decides nothing; over 1000 characters is not recorded); exit 1 otherwise, or when gh resolves the repository off github.com
  -> the request is bound to the findings' text: the digest is recomputed over ALL the ids of the request from the current review state and must equal the recorded one, so a rebuilt review that reuses an id for a changed finding (or a request in the old line shape, with no digest) cannot reuse the ruling; ask again with ruling-request
  -> pass the owner's own words as --owner-quote, never a paraphrase; then re-post the triage comment NOW (`pipeline comment --pr N --kind triage`); until then the ruling is local only (`published: false`); `pipeline state show` restores the published state without it, except a ruling that overrules a published Claude / forced final or a published final waiting for a human, which it keeps (local-ahead) and warns about
```

Exit: `validate`: 0 applied, 1 judge output invalid (state untouched) · `settle`: 0 recorded, 1 refused · `light-lane`: 0 · `ruling-request`: 0 the line, 1 refused (unknown id, a wrong --pr, a repository off github.com) · `owner-ruling`: 0 recorded, 1 refused (label mode, a settled or missing item, empty words, a wrong --pr, no recorded owner answer that is the quote and says the decision, or one bound to other finding text or to no content digest) · 2 usage / no state.

## update

update the installed pipeline to upstream main (run in your own terminal); --check only reports.

```
pipeline update [--claude-home DIR] [--check] [--json]
  Fetches upstream main (github.com/ianjamila/claude-pipeline), installs it and verifies the install.
  --claude-home DIR  where the pipeline is installed (default ~/.claude: both Claude accounts share ~/.claude/pipeline,
                     so CLAUDE_CONFIG_DIR is deliberately not consulted)
  --check            read-only: report the installed stamp, upstream main and how they relate; exit 0 only when
                     the install is complete, unmodified and identical to main (allowed inside Claude Code)
  --json             no progress text on stderr (the result is always one JSON object on stdout)
  Refuses inside Claude Code (run it in your own terminal) unless --check or PIPELINE_ADMIN=1.
```

Exit: 0 updated / up to date (`--check`: complete, unmodified and identical to main) · 1 not up to date (`--check`), upstream unreachable, or the fetch / install / verification failed · 2 usage, or refused inside Claude Code.

Runs `install.mjs` from a clean, isolated download of exactly the commit main points to, then `install.mjs --check`; it succeeds only when that check passes and the installed stamp is that commit. It takes no install lock itself (the installer it runs does). A copy installed with `--skip-file-guard` stays that way.

## update-branch

bring the PR branch up to date with its base on GitHub (update-branch with expected_head_sha), return the new head (checks are not waited for by default)

```
pipeline update-branch --pr N [--expect-head SHA] [--max-cycles N=3] [--wait-checks] [--repo DIR]   -> {ok, outcome, updated, cycles, base, startHead, head, localHead, pullNeeded, successors, hold?, holdRelease?, message?, warnings?}; outcome up-to-date (exit 0; when updated: git pull --ff-only, then re-verify and run the gate on `head`; checks are NOT waited for unless --wait-checks) | rebase-needed | head-moved | cycle-cap | head-timeout | not-open | queued-behind | hold-unreadable | (with --wait-checks) checks-failed | checks-timeout (exit 1; rebase-needed = the update conflicts, needs-human), 3 GitHub unavailable. For a repo with the merge.hold_* keys the repo's read-only hold check runs before every update: queued-behind {verdict: hold:queued-behind, blockedBy:[PR numbers], holds, doNotUpdate:true, reason} = another PR's active hold is ahead (nothing is updated; do NOT retry: wait, or the owner merges the PR ahead), hold-unreadable = the check could not be read (retry later); both exit 1, and updated/cycles say what was done before. For such a repo the hold of this PR is TAKEN right before the first update (after the check shows nothing ahead; the check runs once more after the take), so the catch-up CI round cannot be invalidated by another session's merge; `hold` {taken, tookThisCall, mayHold, take: {confirmed, code, lines} | null} says what happened (a take that is not confirmed carries on without a hold: the hold is cooperative). A refusal after this call's take carries holdTaken. queued-behind after the take = another older hold won the race: the younger hold is KEPT (wait with `merge-hold --check --wait`, then update again). Auto-release, only for a hold THIS call may have written (hold.mayHold = the take ran, whatever its answer: exit 1 means refused OR not confirmed, and the provider can add the label before it fails to confirm; releasing a label that was never written is a harmless no-op): checks-failed (--wait-checks) releases reason ci-failed, rebase-needed releases update-conflict, a hold-unreadable re-check releases hold-unreadable only when the take was NOT confirmed (a confirmed hold is real, only the check could not be read: it is KEPT and the refusal carries holdTaken: true; retry later or release it by hand); output holdRelease {reason, confirmed, code, lines} and a warnings line when the release was not confirmed (repeat it with `merge-hold --release`). Every other outcome keeps the hold. successors lists every accepted update as {from, to, baseSha} (the pipeline's own heads; each is also written to the git common dir so `merge-hold --release --reason new-commits` keeps the hold on it). While it runs the run record of the PR shows inFlight {kind: update-branch}; warnings lists a record write that failed or a successor record that could not be written (never fatal)
```

Exit: 0 `up-to-date` (the base tip is part of the PR head; `updated` says whether this run merged the base in: then `git pull --ff-only`, re-verify, and gate `head`) · 1 `rebase-needed` (the update conflicts: `needs-human`, never a force push), `head-moved` (someone pushed since the verified head, GitHub refused `expected_head_sha`, or the new head is not GitHub's merge of the base into the pinned head: nothing more was updated), `cycle-cap` (the base kept moving), `head-timeout` (GitHub never showed the new head), `not-open`; with `--wait-checks` also `checks-failed` / `checks-timeout` · 3 GitHub (`gh`) unavailable, including any unexpected failure reading checks.

Merge hold (repos with `merge.hold_*`): before EVERY update PUT the hold check runs again. `queued-behind` (a blocker is ahead; `blockedBy` as PR numbers, `holds` with the detail, `doNotUpdate: true`, reason with #A, title and expiry in PHT) and `hold-unreadable` (the check could not be read; fail closed) are exit 1 outcomes that stop the loop with `updated` (= cycles > 0), `cycles`, `head` and `startHead` kept: blocked at entry means zero PUTs and `updated: false`; a hold that appears between cycles means `updated: true` and the PUTs already made. Do not update a `queued-behind` branch: wait until #A merges or its hold expires (`pipeline merge-hold --pr N --check --wait`). The hold of this PR is taken right before the first PUT, the successor heads are recorded and the failed-catch-up releases happen as described under Taking the hold for a catch-up in `merge`. There is no override flag (the owner has the provider's `--ignore-hold`). Read-then-PUT is not atomic.

Queue mode (the base branch has a GitHub merge queue; see merge): a moved base needs no catch-up, so the command answers `{ok: true, outcome: 'queue-mode', updated: false}` (exit 0) and makes no API update; a queue that cannot be read refuses (exit 1, `outcome: 'queue-unreadable'`, nothing updated).

Run record: `inFlight` `{kind: update-branch, maxMinutes: 30}` is set before the update and cleared on every exit; a failed record write is listed in `warnings` and never fails the update.

## vendor

copy the CI-side scripts into a project (scripts/pipeline/); --check reports drift.

```
pipeline vendor --repo DIR [--check]
```

Exit: 0 copied / no drift · 1 drift found (`--check`) · 2 usage.

Vendoring removes a leftover `scripts/pipeline/stop-verify.mjs` from an earlier vendor (the Stop hook was retired; output `removed` lists it, and only that file is ever deleted); `--check` reports it as drift with reason `retired`. If `.claude/settings.json` or `.claude/settings.local.json` still has a hook that runs `stop-verify`, both modes add a `warnings` entry telling the owner to remove that Stop hook entry; the settings files are never edited. Vendoring also appends `scripts/pipeline/** -text` and `scripts/verify text eol=lf` to the project's `.gitattributes` (idempotent; output `gitattributes` lists what was added), so a Windows autocrlf checkout cannot make the byte comparison drift. `--check` warns when the entries are missing. The vendored libs include `lib/review-marker.mjs` (the review-complete marker and its parser, used by the guards for `Cross-model review`).

Workflow-context check: vendor also copies `scripts/pipeline/workflow-contexts.mjs` (with `lib/workflow-contexts.mjs`). It reads the project's own `.github/workflows/*.yml|*.yaml` as data and fails when an expression uses a context GitHub does not allow at that key (for example `runner.temp` in a job-level `env:`): GitHub then rejects the WHOLE file, and a `workflow_run`-only workflow never runs (that jammed a merge queue on 2026-11-10). Run it from the repo root (`--repo DIR` optional). Exit 0 and `N workflow file(s) checked, no disallowed contexts` when clean (a project with no workflow files is clean); exit 1 with one line per finding (file, key, context; a file that is not valid YAML is a finding); exit 2 only for a usage error or an unreadable directory. The `verify.yml` template runs it before `node scripts/verify.mjs`.

Warning `workflow-contexts-unwired`: plain vendor and `--check` add it to `warnings` (not drift; the exit code does not change, and it also appears next to drift) when no file directly under `.github/workflows/` contains `scripts/pipeline/workflow-contexts.mjs`; a missing or unreadable `.github/workflows/` gives the same warning. The vendored check protects a project only when its CI runs it.

Adopting it in an existing project: in ONE PR, re-vendor (`pipeline vendor --repo .`) and add the step `node scripts/pipeline/workflow-contexts.mjs` to the workflow that runs on every PR and is a required check (a project that uses the `verify.yml` template already has it after re-copying). Until the step is wired, vendoring only warns.

## verify

plan the verify commands for the review skill (plan-after-fix); limit parallel full verifies (slot).

```
pipeline verify plan-after-fix --round R [--repo DIR]   -> {ok, mode, commands, matchedSteps, base, head, files}
  verify.after_fix full (default): commands = [verify.full]. quick: commands = [verify.quick] plus, when the fixes since round R's
  reviewed head (renames count on both sides) touch a path in verify.after_fix_steps_by_path, verify.full --only <those steps>;
  run them in order, either red = fix cycle. exit 1 {ok:false, error} when round R has no recorded review state (fail closed)
  verify.max_parallel_full set: the full commands above come back as `node ~/.claude/pipeline/bin/pipeline.mjs verify slot --run [--only STEPS]`
pipeline verify slot --run [--only STEP,STEP... | --defer STEP,STEP...] [--repo DIR]   wait for a free slot, run the repo's verify.full (with --only STEPS appended; npm gets "--" first),
  inherited stdio, free the slot when it ends; exit code = verify.full's. It runs nothing else: any other argument, or "--", is a usage error (exit 2).
  The exact command line is judged first by the same git and file guards as `job start`: denied -> exit 1 {ok:false, refused:true, reason}, nothing queued or run.
  Slots are machine-wide (all repos); the limit is verify.max_parallel_full of the repo it runs in; unset = it runs at once. Waiters go in arrival order.
  One stderr line before verify.full starts: {"slot":{index,of,waitedSeconds,loadWaitSeconds,warnings}}. With verify.max_load it then waits (5-30 s jitter between
  checks, at most verify.max_load_wait_minutes) while the 1-minute load average is above it, and proceeds with a warning when the time is up.
  --defer STEPS (each in verify.deferrable_steps) is appended like --only, for the gate's full verify of a repo with verify.ci_proof; not with --only.
  SIGINT/SIGTERM/SIGHUP go to the running verify. STEPS: letters, digits and . _ : - only, no repeats, each in verify.expected_steps when that is set.
pipeline verify slot --status   -> {ok, lockDir, holders[{index,pid,host,startedAt,alive}], waiters[{seq,pid,host,alive}]}   (read only; the whole machine)
```

Exit (plan-after-fix): 0 · 1 `no-round-state` / `base-not-ancestor` (run `verify.full` instead) · 2 usage.

`slot --run` is for repos that set `verify.max_parallel_full: <n>` (a positive integer): at most n full verifies of ALL repos run at once on this machine, the rest wait in arrival order, so one machine is not overloaded by several sessions' database-heavy verifies. It wraps the run instead of an acquire/release pair because a slot is a machine lock (pipeline/lib/locks.mjs) owned by a live process: the wrapper is that process for exactly as long as the verify runs, and a wrapper killed hard frees its slot through the usual dead-owner reclaim. It runs ONLY the repo's `verify.full` from `.claude/pipeline.yml` (plus a validated `--only`), never a command of the caller's, so it cannot be used as an exec that walks past the git and file guards; since a PR can change that config, the exact command line is also judged by the same guards as `job start` first (denied: exit 1 `{ok:false, refused:true, reason}`, nothing queued or run). The wrapper exits with the verify's exit code (128 + n for a signal) and prints nothing on stdout. Before the verify starts it writes ONE JSON line to stderr, `{"slot":{"index","of","waitedSeconds","loadWaitSeconds","warnings"}}`, which the run summary quotes. `verify.max_load` (positive number, needs `max_parallel_full`) adds a second, optional wait AFTER the slot is held: while the 1-minute load average is above it, re-check every 5-30 s (random, so waiters do not start together) for at most `verify.max_load_wait_minutes` (default 10, at most 10), then run anyway with a warning. On Windows the load check is skipped (warning). `slot --status` is read only. `PIPELINE_LOCK_DIR` moves the lock directory (a test seam; changing it splits the machine-wide limit).

## version

print the pipeline version.

```
pipeline version
```

Exit: 0.

## worktrees

remove finished worktrees (prune), keep one with a lock (keep / unkeep), list or purge the holding folder, check for an open Claude session (sessions).

```
pipeline worktrees prune [--repo DIR] [--dry-run] [--notify] [--summary-only]   (--notify: accepted, does nothing; old schedules pass it)   -> {ok, mode, removed:[...], wouldRemove:[...], kept:[...], hiddenProcesses, liveSessions?, restored:[...], outside:[...], holding:{batches, purged}, summary, log} | --summary-only: one line {ok, summary, errors?}
pipeline worktrees keep NAME [--reason TEXT] [--repo DIR]   -> {ok, slug, locked}
pipeline worktrees unkeep NAME [--run ID] [--repo DIR]   -> {ok, slug, unlocked}
pipeline worktrees holding [--purge] [--repo DIR]   -> {ok, batches:[...], purged:[...]}
pipeline worktrees sessions DIR   -> {ok, dir, available, open:[{id, pid}], unplaced:[...], reason?}   read-only, needs no repo, config or GitHub; exit 0 = the scan is complete and no session is open in DIR, 1 = a session is open there, 2 = usage, 3 = unsure (scan unavailable or partial, or a session folder that cannot be resolved): treat every non-zero as "keep"
pipeline worktrees schedule (--install [--at HH:MM] | --remove | --status) [--repo DIR]   -> {ok, installed, line, timezone, warning?} | {ok, removed} | {ok, installed, line}   (macOS: a launchd LaunchAgent; adds plist, changed, loaded, note)
```

Design: [docs/specs/2026-10-13-worktree-prune-design.md](specs/2026-10-13-worktree-prune-design.md). `--repo` may name the
container, a linked worktree or a subdirectory: candidates, config (the main worktree's `.claude/pipeline.yml`) and the
run lock all come from the main worktree. A worktree is removed only when its newest same-repo PR merged at least
`min_merged_hours` ago, every local commit is in that PR, nothing but `delete` / `archive` files is left in it, and
nothing uses it (lock, process, a Claude session that is open there now, a recent Claude transcript whose session worked
there — its `cwd` inside the worktree or a tool call naming the path; a tool result or prose that merely prints it does not
count — memory note, recently changed file); removal goes through a quarantine move and a final re-inspection (which scans the
open Claude sessions again), and the `archive` files wait 30 days in the
holding folder (archiving and purging both take a lock on that folder, so two clones of one repo cannot overwrite each other's files or manifest, and a purge never runs mid-archive; a lock not obtained within 30 s keeps the worktree, or makes the purge skip that run and report `purgeSkipped`). The process check reads `/proc` on Linux and runs one `lsof` on macOS (fail-closed: a missing or failing `lsof`, or
one that cannot show our own process's cwd — the positive control — keeps every candidate); on Windows every candidate
is kept ("cannot check running processes on this platform") and prune never removes anything there — `mode: on` is
report-only in effect. **Open Claude sessions** (`liveSessions` in the output): a session whose shell `cd`'d into a worktree
holds nothing there for `lsof` to see, and once it has been idle longer than `min_idle_hours` its transcript is too old for the
transcript check, so Claude Code's own record of which sessions are open is read: `<config>/sessions/<pid>.json` for
`$CLAUDE_CONFIG_DIR` and every `~/.claude*` (de-duplicated by realpath; a session both accounts list counts once). A record counts
only while its pid is alive and the process started when its `procStart` (UTC) says (`ps -o pid=,lstart=` under `TZ=UTC`, so a
reused pid is ignored). The session is where the last `cwd` of its transcript (`projects/*/<sessionId>.jsonl` of every config dir,
not only the one that listed it, read from the end; when several accounts hold one, a `cwd` in the worktree from any of them counts)
says, or in the folder it started in when it has no transcript yet; one inside the worktree (any spelling of the path)
keeps it as `a Claude session is open there now (<id> pid <pid>)`, however long it has been idle, and the quarantine re-inspection
asks again with a fresh scan. Fail-closed: a config dir (or the home folder) that cannot be listed or resolved for any reason but "is not there", a record that cannot be read or parsed, `ps` failing, a start time in an unrecognised
format (or every running pid disagreeing with its `procStart`), or a live session whose transcript cannot be read or whose folder
is unknown keeps **every** candidate (`an open Claude session could not be placed: <why>`). No `sessions/` folder in any config dir
(an older Claude Code, another tool) and Windows make the signal unavailable: the run says `live-session signal unavailable (<why>)`
in its summary and `liveSessions: {available: false, reason}`, and decides by the other checks as before. A `pipeline-keep:` lock older than 7 days is reported as `stale keep (<N>d: <reason>) — still needed?` (its own
group in the summary) and never released. `worktrees.mode` governs every mutation:

| action | off | report (default) | on | `--dry-run` |
|---|---|---|---|---|
| evaluate and report worktrees | no (`disabled: true`) | yes | yes | yes |
| remove a worktree, delete caches, archive evidence | no | no | yes | no |
| move back a quarantine left by a killed run | yes | yes | yes | report only |
| purge holding batches older than 30 days | no | no | yes | no |
| `keep` / `unkeep` locks | yes | yes | yes | n/a |

`sessions DIR` is a read-only check for a person or agent about to remove a worktree by hand: "is a Claude Code session open in DIR right now?" It uses the same scan as `prune` (the `<config>/sessions/<pid>.json` records, placed by the last `cwd` of their transcripts) but needs no repository, `.claude/pipeline.yml` or GitHub, and `worktrees.mode` does not apply. Exit 0 only when the scan is available and complete and no session is open in DIR; 1 when one is (`open` lists id and pid; this wins over an unplaced session); 2 for a usage error (no DIR, DIR not a directory); 3 when the answer is unsure: the scan is unavailable (`available: false` and a `reason`: Windows, no `sessions/` folder), any session could not be placed (`unplaced`), or a session's working folder cannot be resolved (denied, deleted, a loop) and is not DIR by its logged spelling, which could be an alias of DIR (this strictness is only for `sessions`; prune still reads such a folder as elsewhere). Treat every non-zero exit as "keep".

`unkeep` releases only a `pipeline-keep:` lock, and with `--run ID` only the one whose reason carries `ship run ID`.

Every completed `prune` (a full run, `skipped`, or off mode's `disabled`) has a one-line `summary` and appends it, with a
timestamp, to `prune-<repo>.log` in the prune log directory (the last 30 kept; its path is `log`). `--summary-only`
prints only `{ok, summary}` (plus `errors` when a step failed) as one compact JSON line; a run that fails before it has a
summary prints its usual error object, also on one line.

Exit (prune / keep / holding / schedule): 0 completed (also `skipped: "already running"` / `"git operation in progress"`) · 2 usage, repo, config, or the
`gh` repository does not match `origin` · 3 GitHub unavailable. `sessions`: 0 nothing open · 1 open · 2 usage · 3 unsure (see above).

`schedule` (Linux: cron; macOS: launchd, below) keeps one crontab line per repository, found again by the marker comment
`# claude-pipeline worktrees-prune <lock name>` at its end: `--install` adds it (or replaces it in place, so installing from the
main checkout or any linked worktree gives the same single line) to run `worktrees prune --summary-only` from the main checkout at
`--at HH:MM` (default `02:30`), `--remove` deletes it, `--status` says whether it is there. Every other crontab line is kept
byte-for-byte. cron's own `PATH` is only `/usr/bin:/bin`, so `--install` looks up `node`, `git` and `gh` on the current `PATH`
(exit 2 `tool-missing` if `git` or `gh` is not found) and the job sets `PATH` to their directories plus `/usr/bin:/bin`. Its
output is appended to `cron-<lock name>.log` in the prune log directory (`~/.local/state/pipeline`, or `PIPELINE_PRUNE_LOG_DIR`;
created at install), so a failed start leaves a trace; the file is not rotated, and `--summary-only` keeps it to one line
per run. cron runs in the host's time zone: `--install`
reports it as `timezone` (from `timedatectl`, else the `/etc/localtime` link, else `/etc/timezone`) and adds a `warning` when
it is not `Asia/Manila` or cannot be read. The job only does what `worktrees.mode` allows, so a repository still on `report` just gets the report.

**macOS (launchd).** The Mac sleeps, so a 02:30 cron job is missed; launchd runs a missed `StartCalendarInterval` job when the
Mac wakes. On macOS `schedule` therefore installs one per-user LaunchAgent per repository instead of a crontab line (Windows
is still `unsupported-platform`: "schedule is only supported on Linux (cron) and macOS (launchd)"):

- Label `com.claude-pipeline.<lock name>` (the same lock name as the cron marker); plist
  `~/Library/LaunchAgents/<label>.plist`. It runs `node <pipeline> worktrees prune --summary-only` from the main
  checkout at `--at HH:MM` (default `02:30`, `StartCalendarInterval`, `RunAtLoad` false). Its `PATH` is the directories of `node`,
  `git` and `gh` (found at install time; exit 2 `tool-missing` if `git` or `gh` is missing) plus `/usr/bin:/bin:/usr/sbin:/sbin`
  (`lsof` is `/usr/sbin/lsof`).
- Output goes to the same `cron-<lock name>.log` in the prune log directory (`~/.local/state/pipeline`, or
  `PIPELINE_PRUNE_LOG_DIR`), standard output and error alike.
- `--install` writes the plist only when its text differs, then `launchctl bootout gui/<uid>/<label>` (a "not loaded" failure is
  ignored) and `launchctl bootstrap gui/<uid> <plist>`; so a repeat install also reloads the job. A failing bootstrap is exit 2
  `{error: "launchctl"}`. The result is `{ok, installed, line, plist, changed, timezone, warning?, note}` (`line` is the plist
  path); `timezone` comes from the `/etc/localtime` link, and `warning` fires when it is not `Asia/Manila` or unreadable.
- `--remove` boots the job out, checks with `launchctl print` that it is really gone, and only then deletes the plist: `{ok, removed}`;
  a job that is still loaded is exit 2 `{error: "launchctl", message: "could not unload <label>: …"}` and the plist stays; so does a `print` that fails without saying the job is gone (exit 113 / "Could not find service" is the only confirmation), `message: "could not confirm <label> is unloaded: …"`. `--status` is `{ok, installed, line, plist, loaded, warning?}` (`warning` only when `print` fails unexplained):
  `installed` means the plist exists **and** launchd has it loaded; `line` is the plist path (or `null` when it is missing).
- Check by hand: `launchctl print gui/$(id -u)/<label>`.

To replace a hand-made Mac cleanup job, the owner runs `pipeline worktrees schedule --install` once per repository and sets
`worktrees.mode: on` in that repository's `.claude/pipeline.yml` (until then the job only reports).

## Where this differs from spec section 5.2

The spec table was written before the build; the CLI that shipped differs as follows (the CLI is authoritative).

| Spec 5.2 | Shipped |
|---|---|
| `triage-validate`, `arbiter-needed`, `rulings-apply` | `triage validate`, `arbiter needed`, `arbiter apply` (apply proves the model from the transcript itself; no separate `model-proof` step needed) |
| `triage-comment`, `summary` | `comment --kind triage|summary|needs-human|blocked|awaiting-review`; `summary` also posts the summary comment |
| `agent-log --line` (docs-only PR) | `agent-log queue --line` and `agent-log publish [--line]` (appends to the orphan branch `pipeline-agent-log`; `stage` is a deprecated alias that commits nothing) |
| not listed | `artifacts push`, `followups create`, `hardstops`, `integrity`, `job start\|wait\|read`, `protect`, `review-complete`, `state show\|outcome\|mark-implemented\|record-followup\|set-outcome`, `triage settle\|light-lane\|owner-ruling`, `vendor`, `version` |
| `risk` returns `files[]`, `stats` | `risk` returns `level, reasons, lightLane, changedLines, fileCount, hardStops, base, head, mergeBase` |
