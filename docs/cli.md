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
  mode dispute (a judge round): only the items the dispute rules send; {needed:false} when there are none
  start the arbiter prompt with promptHeader, pasted verbatim (the two lines ROUND: / INPUT-DIGEST:): without them `arbiter apply` cannot prove the arbiter saw this input and marks every item needsHuman
pipeline arbiter apply --round R [--tag TAG | --agent-id ID] [--projects-dir DIR] [--max-age-ms N] [--repo DIR]
  the proof is pinned to claude-fable- at effort high; --expect-model / --expect-effort are honoured only with PIPELINE_TEST_MODE=1 in a repo checkout (an installed copy ignores it)
  -> {ok, round, tag, transcript, errors, items[, findings]}; exit 0 proven + applied, 1 unproven (every arbitrated item needsHuman), 2 no transcript
  mode review: the answer must also carry `findings` (Fable's own review, [] when clean); proven findings become items R<n>-F<k>;
    unproven ones are kept in rulings.json as `unverifiedFindings` and the round stays Fable-pending (run needed + the arbiter again)
```

Exit: `needed`: 0 (`needed:false` is also 0) · `apply`: 0 proven + applied, 1 proof failed (arbitrated items marked needsHuman), 2 no transcript found / usage.

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

record where the ship run stands in the PR summary comment (refuses unless local HEAD is the pushed PR head).

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

## codex-review

run one Codex review round over base..head and record its findings.

```
pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]
  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, reviewer, reviewerReasons, path}
  --base must be the PR's merge base for round 1 and the previous round's toHead after that, else exit 2 {error:base-mismatch}
  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head)
  exit 2 {error:round-cap} past review.max_rounds, except ONE extra round when the last round only accepted fixes (state outcome extraRound);
    base-only rounds (below) never count toward the cap
  reviewer: fable (medium/high risk or a sensitive path: risk.high_risk_paths, review.arbiter_always_paths) records the round as fableRequired
    (the Fable pass must run: arbiter needed/apply) and gives Codex an attacker's brief for the sensitive files; judge otherwise. Once fable, always fable
  commits merged in from the PR's base branch since the previous round are left out of the reviewed diff; a round that only merged them in
    is recorded without running Codex: {ok:true, baseOnly:true, counts all 0}
  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver
  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)
```

Exit: 0 round recorded · 2 usage, base-mismatch or round-cap · 3 Codex or GitHub could not deliver (quota, auth, unavailable, error, malformed, github): never "no findings".

A later round is diffed against what the previous round reviewed plus the PR's base branch as it is now (a trial merge, `reviewBaseKind: synthetic`), not against the previous head itself, so commits an "Update branch" merged in from the default branch (`origin/<default_branch>`) are never shown to Codex: they were reviewed in their own PRs. Only the default branch counts: a PR that targets another branch, or code merged in from any other branch, is reviewed in full (nothing is left out, and Codex always runs). A stale `origin/<default_branch>` (the best-effort fetch failed) can only make the range bigger. When that trial merge conflicts (or git is older than 2.38), the round reviews the whole PR against the new base instead (`whole-pr`). Each round records `reviewBase` and `reviewBaseKind` next to `fromHead` / `toHead`. A round whose only new commit is such a merge is recorded as `baseOnly: true` with no items and Codex is not run; it does not count toward `review.max_rounds`, and it is not a review: it carries the last reviewed round's result forward to the merged-in content, so the outcome is clean only if that reviewed round was (fixes it accepted still need a reviewed round). `state mark-implemented` measures "a non-test file changed since round N" the same way and fails closed: when that range cannot be worked out exactly (conflicting trial merge, git error) it refuses with `base-unresolved`.

## comment

render and upsert a pipeline PR comment (triage, summary, needs-human, blocked, awaiting-review).

```
pipeline comment --pr N --kind triage|summary|needs-human|blocked|awaiting-review [--outcome O] [--built TEXT] [--reason TEXT] [--hits-file F] [--repo DIR]
```

Exit: 0 comment posted/updated · 2 usage · 3 GitHub (`gh`) unavailable.

## config

load and validate .claude/pipeline.yml.

```
pipeline config [--repo DIR]   -> {ok, path, config}; exit 2 when missing or invalid
```

Exit: 0 valid · 2 missing or invalid (`errors` listed). A valid config may carry `warnings` (e.g. `ci.required_checks` omits the guard contexts `Test integrity` / `Hard-stop scan`, or `verify.stop_queue_wait_minutes` is above 0 and a leftover Stop hook running `stop-verify` in `.claude/settings.json` has a `timeout` below 900 + minutes * 60 seconds). `verify.stop_queue_wait_minutes` (integer 0..30, default 0) is retired together with the Stop hook (`stop-verify`) and nothing reads it; it is still accepted so a config that sets it validates. `ci.review_check` (boolean, default false) adds the `Cross-model review` status to the guard workflow and to every required-check list (preflight, `protect`, the final gate); `true` with `ci.guard_checks: false` is an error (nothing would post it). Turn it on in the same change that applies branch protection with it.

## cost

book tokens / USD / retries of one agent call in the run record (shown by `P summary`).

```
pipeline cost --pr N --phase build|verify|pr|review|gate|merge|... --role implementer|judge|arbiter|verifier|controller|other
              [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X | --model M] [--from-transcript FILE] [--retry] [--session ID]... [--repo DIR]
  -> {ok, recorded, cost, warnings}; exit 2 usage (a negative or non-numeric amount), 3 GitHub unavailable
  An unknown --role is booked as `other`, an unknown --phase as `other`. --from-transcript FILE: sum the message.usage of a Claude transcript (JSONL, at most 50 MB);
  explicit --input/--output/--cache-* then add to it. --retry alone (no amounts) only counts a retry.
  USD: --usd X as given; otherwise list price (opus / sonnet / haiku / fable) of each transcript message's own model (--model M prices the messages
  that carry none) plus the explicit tokens at --model M. Tokens with no known model add no USD (a warning says so).
```

Exit: 0 booked · 1 the run record could not be written (`warnings` says why) · 2 usage · 3 GitHub (`gh`) unavailable.

Cost attribution (issue #57): the run record gets a `cost` section {total, byPhase, byRole, retries, guardBlocks, sessions}, each of total / phase / role holding {input, output, cacheRead, cacheWrite, usd, calls}. Phases are the record steps; roles are implementer, judge, arbiter, verifier, controller and other (an unknown phase or role is booked as `other`). Records written before this have no `cost` section and everything that reads it treats that as "nothing booked". `P summary` shows the totals and both breakdowns in the status block and as `cost` in its JSON. `--session ID` (on `cost` or `summary`) names a Claude session of the run; `summary` counts the guard denies of those sessions in `<home>/.claude/pipeline-state/guard-log.jsonl` (override with `PIPELINE_GUARD_LOG_FILE`) into `guardBlocks` and keeps each session's own count in `guardBySession` ({sessionId: denies}, at most 20 sessions, `null` while the count is unknown; shown as `(s1 2 · s2 0)` after the status-line count). A missing log leaves the count unknown (shown as a dash), unreadable lines are skipped and reported in `warnings`. The numbers are display only: no command decides anything from them. The amounts are what the caller books (`--from-transcript` sums a transcript's own usage counts; the USD figure is whatever `--usd` says).

## final-gate

prove this PR head is verified, reviewed, and CI-green; writes .review/final-gate.json.

```
pipeline final-gate --pr N [--repo DIR]   -> {ok, repo, pr, base, head, tree, contentHash, checks[{name,ok,detail}], failed[], at, proofs?}; exit 0 all checks pass, 1 any fails (pr-open detail starts "behind-base:" when the PR is behind its base: update the branch and re-verify), 3 GitHub unavailable
```

Exit: 0 every check passes (writes .review/final-gate.json) · 1 any check fails · 3 GitHub (`gh`) unavailable.

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

merge the PR if (and only if) the final gate passes again, live; waits for MERGED.

```
pipeline merge --pr N [--owner-approved-head SHA --owner-approved-items DIGEST | --owner-go] [--repo DIR]   -> {ok, merged, mergeSha, warning?, warnings?} ; --owner-go (work that never ran ship: no final-gate.json) merges the local HEAD when the owner-go hook recorded the owner's "merge" for this PR, that head and items none, the PR is open, not a draft, MERGEABLE, not behind its base, without a blocking label, every required check is green on that head and the diff has no hard-stop or test-integrity item (error owner-go / live-check / pre-merge otherwise; output mode owner-go, nothing written); exit 0 merged (mergeSha:null + warning when GitHub cannot name the merge commit), 1 not merged / refused (error: gate|behind-base|live-check|pre-merge; behind-base = the base moved: the branch was updated (or the update failed, see outcome), re-verify and run final-gate again), 3 GitHub unavailable. While it runs the run record of the PR shows inFlight {kind: merge} and step merge; for a repo with verify.deferrable_steps the proofs of the live gate (where each deferrable step was proved: the Mac, or a GitHub run and attempt) are recorded in the run record and in an append-only ci-proof-used event comment before the merge command, and when either write fails nothing is merged (error pre-merge); warnings lists a run record write that failed (never fatal). A run record marked resumed (`P checkpoint --resumed`: a run taken over by ship resume) refuses with error pre-merge unless the owner approved it; so does a run record that cannot be checked (unreadable, invalid or unsupported: it may be a resumed one), and with owner_approval: chat a gate with ownerMerge > 0. Approved = --owner-approved-head names the full gate head, --owner-approved-items the gate's ownerItems, AND the owner-go hook recorded the owner's "merge" for exactly that PR, head and item set (the flags alone refuse); the live gate must still show those ownerItems
```

Exit: 0 merged (a merge commit GitHub cannot name yet is `mergeSha: null` plus a `warning`) · 1 not merged / refused by the live gate or by the last pre-merge look at GitHub (run final-gate again; `behind-base`: the base moved, the branch was just updated on GitHub, so pull, re-verify and gate the new head) · 3 GitHub unavailable.

Resumed runs: `merge` reads the PR's run record (the viewer's own summary comment) before anything irreversible; when it carries `resumed` (set by `checkpoint --resumed`, never cleared), `merge` refuses with exit 1 `{merged: false, error: pre-merge, reason: resumed run: the owner must say "merge" for this exact head (then pass …)}` unless the owner approved it (below). A record that cannot be checked fails closed: unreadable comments, or an `invalid` / `unsupported` (newer version) record, refuse the same way (`reason: <the run record could not be read (…) | the run record is invalid|unsupported>, so the resumed-run guard cannot be checked: …`), because it may be a resumed one. No record (`absent`) or a `legacy` comment is an ordinary run.

Owner approval (#58): with `owner_approval: chat` a gate with `ownerMerge > 0`, and any resumed or unchecked run, merges only with `--owner-approved-head <full gate head> --owner-approved-items <the gate's ownerItems>` AND a record of the owner-go hook (`~/.claude/pipeline-state/owner-go/<session>.jsonl` under the account's home, never `$HOME`; written only when the owner types a prompt starting with "merge" right after a reply that showed `Head <sha12> · items <ownerItems> · repo <owner/name>` and the 🔀 line; valid 24 h) for exactly that repository (`gh repo view`'s nameWithOwner, case-insensitive), PR, head and item set; a request line without `· repo` approves nothing (Phase 3b). The flags alone refuse (the reason then ends with `(no owner "merge" is recorded for owner/name #N head … items …)`). The live gate must still show the approved `ownerItems`, else `reason: the owner items changed since the owner said "merge" …`. `final-gate` reports `ownerItems` (a 12-character digest of the owner items, `none` without any).

Owner-go (`--owner-go`, owner decision 2026-10-28): the route for work that never ran the ship loop (no verify report, no review state, no `final-gate.json`). The reply asking for the merge ends with `Head <sha12> · items none · repo <owner/name>` above the 🔀 line; once the owner types "merge" the owner-go hook records it, and `merge --pr N --owner-go` then checks, in this order: the record for this repository, PR, the local HEAD and items `none` (else `error: owner-go`, nothing read from GitHub); the live PR (open, not a draft, MERGEABLE, not behind its base, at the local HEAD, no blocking label) and every required check green on that head, guard statuses and `Cross-model review` only with their provenance, and a diff without any hard-stop or test-integrity item, blocking or owner-merge (the agent writes `items none`, so a diff with an owner item must take the gated route, whose approval is bound to the gate's `ownerItems`) (else `error: live-check` with the failing checks); the last pre-merge look (`error: pre-merge`). It runs `merge.command` pinned to the head (`{sha}`) and waits for MERGED like the gated route. It proves no verify step, writes no gate file and refuses `--owner-approved-head` / `--owner-approved-items` (usage, exit 2). The final gate file itself is now valid for 24 h (the owner's "merge" window): `merge` re-runs the whole gate live anyway.

Run record: before the merge command, `merge` sets the record's `inFlight` `{kind: merge, host, startedAt, maxMinutes: 2 × merge.wait_minutes + 15}` and `step: merge`. On every exit `inFlight` is cleared: merged → `step: merge` and `mergeSha`; not merged → `step: gate`. `merge` makes no deployments call and writes no `.review/prod-before.json`, whether or not `production` is configured. The run record itself is display: a failed record write is listed in `warnings` and never fails the merge.

## model-proof

prove a subagent ran on the expected model and effort.

```
pipeline model-proof (--tag TAG | --agent-id ID) [--expect-model claude-fable-] [--expect-effort high]
                     [--expect-agent-type TYPE] [--expect-meta-model MODEL] [--projects-dir DIR] [--max-age-ms N]
  -> {ok, transcript, meta, models, efforts, errors, finalAssistantText, stopReasonMissing, finalVia}; exit 0 proven, 1 mismatch, 2 not found/unreadable
```

Exit: 0 proven · 1 mismatch · 2 transcript not found / usage.

## preflight

report whether the pipeline may merge (config, gh, protection, pause, Codex).

```
pipeline preflight [--repo DIR]   (exit 0 can merge, 1 cannot, 2 config missing/invalid)
```

Exit: 0 pipeline may merge · 1 it may not (`reasons`) · 2 config missing or invalid.

Branch protection must require `ci.required_checks` AND, unless `ci.guard_checks: false`, the guard contexts `Test integrity` and `Hard-stop scan` (plus `Cross-model review` with `ci.review_check: true`); `protect` sets that same list.

## protect

print (or with --apply, set) the GitHub branch protection and repo settings the pipeline relies on.

```
pipeline protect [--apply] [--checks a,b] [--repo DIR]   (--apply needs PIPELINE_ADMIN=1)
```

Exit: 0 dry run printed, or applied with nothing missing or unpinned · 1 no admin rights / plan limit, or something still missing or `unpinned` after applying · 2 usage (`--apply` without `PIPELINE_ADMIN=1`) · 3 GitHub (`gh`) unavailable.

Every required check is pinned to the GitHub Actions app (`app_id: 15368`): only a status a workflow posted with `GITHUB_TOKEN` satisfies it, never one posted with a person's token (which agents share), so `Test integrity`, `Hard-stop scan` and `Cross-model review` cannot be posted from a terminal. Do not list a check another app posts (a deploy provider) in `ci.required_checks`: nothing could satisfy it. The read-back after `--apply` lists checks GitHub reports without that pin in `unpinned` and fails. The default list is `requiredChecks` (`ci.required_checks`, the guard contexts unless `ci.guard_checks: false`, and `Cross-model review` with `ci.review_check: true`).

## review-complete

post the review-complete comment (and remove awaiting-review) once the review is valid for the current content.

```
pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, posted|reused, comment:{id, url}, review, removed, recheck, recheckError?}; exit 1 {ok:false, reason} when the review is not valid
  the checked-out HEAD must be the head GitHub holds for the PR; the PR must have had every Fable pass its risk or paths need
  the comment starts with the line `<!-- claude-pipeline:review-complete v1 -->` and carries the JSON {contentHash, base, head, rounds, codexModel, modelProofDigest}
  (base = the merge base the content hash is measured from; modelProofDigest = sha256 of the Fable model proofs, null when no Fable pass ran);
  an identical latest comment of ours is reused, not posted again; exit 3 when GitHub is unavailable or the label is still on the PR after removal
```

Exit: 0 comment posted (or our identical one reused) and the label is off · 1 review not valid for this head (nothing posted) · 2 usage · 3 GitHub unavailable, or the label still on the PR after removal.

Run it at the end of every clean review, before `gh pr ready`: the review instructions mark a PR ready only once this
comment exists. The comment is append-only evidence (a new comment per new head, never an edit). `contentHash` is
`contentHash(base, head)` minus the agent log (git.mjs), so a check that fetches only git data can recompute it.
Validity is the state's (every round clean, coverage = this content) PLUS a lane re-check from the PR itself: a PR whose
files, size or recorded risk call for the Fable pass is refused unless some round ran a proven one.

With `ci.review_check: true` the guard workflow turns this comment into the `Cross-model review` status (success only when
the newest such comment by an allowed author names the content hash of the PR head). A comment starts no workflow, so
`recheck` says how the guards learn about it: `on-ready` (a draft: marking it ready starts them), `label-removed`
(removing `awaiting-review` already did), `triggered` (a ready PR: the command added and removed the label
`pipeline-recheck`, created by `P labels`), or `failed` with `recheckError` (the comment stands; add and remove any label
by hand). A failed nudge never changes the exit code. The guards recompute the hash from the BASE branch's config
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
  quarantinedTo) and the published state is restored. source is local | published | quarantined | local-unverified
  (GitHub unreachable but a local state exists: served as is with a `warnings` entry, exit 0; with no local state exit 3)
pipeline state discard-round --round R [--pr N] [--repo DIR]
  -> drop an unpublished, trailing round R from the local state and move .review/round-R/ into .review/stale-<UTC time>/;
     refused (exit 2) when the PR triage comment already holds round R
pipeline state outcome [--repo DIR]   -> roundOutcome + {clean, followupsPending, rounds, reviewedRounds, maxRounds}; exit 0 whether or not clean
pipeline state mark-implemented --ids a,b [--repo DIR]
  -> exit 2 {error:no-code-change} unless the branch content differs from what the accepting round reviewed
     and a non-test file changed since (a test file counts for a testing finding or the finding's own file)
pipeline state record-followup --id ID --url URL [--repo DIR]
pipeline state set-outcome --outcome TEXT [--repo DIR]
```

Exit: 0 · 2 no state / usage (`outcome` is 0 whether or not `clean`).

## summary

upsert the PR summary comment and print the agent-log line.

```
pipeline summary --pr N --outcome O [--built TEXT] [--action TEXT] [--cause CODE] [--session ID]... [--repo DIR]   -> {ok, url, agentLogLine, pendingLogLine?, cost}   (--action/--cause: accepted, unused; pendingLogLine: only for --outcome merged, the same line with outcome "merged — prod smoke pending")
```

Exit: 0 · 2 usage / no state · 3 GitHub (`gh`) unavailable.

Without `.review/state.json` only `--outcome blocked`, `awaiting-review`, `stopped`, `closed` and `merged-externally` are accepted (the early-stop paths: verify red three times, Codex out in round 1, a stop on a gate or merge refusal, the owner closing the PR, a merge made outside the pipeline): the comment is rendered with no rounds (a `blocked` one names the failing step from the verify report) and `agentLogLine` is still printed. Any other outcome without state is exit 2.


## triage

apply the judge triage, settle disputed bugs with test results, close the light lane, ask for and record owner rulings made in chat.

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
pipeline triage owner-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason TEXT --owner-quote TEXT [--pr N] [--repo DIR]
  -> {ok, round, id, final, published: false, next}; records the OWNER's decision (final.by owner, needsHuman false, the exact quote and time, the overruled final kept) for an item that needs a human
  -> only with owner_approval: chat; exit 1 for label mode, an item that is not waiting for a human (settled items are not reopened), a missing item, an empty reason or quote, or a --pr that is not the review state's
  -> works on an already published round. ACCEPT still needs the fix and a later review round; FOLLOW-UP is filed by `followups create`; the quote is published in the triage comment and the final gate counts it as ownerMerge (the owner's "merge" is still needed)
  -> the quote must be the WHOLE owner prompt that answered a reply ENDING with the line `triage ruling-request` printed (`⚖️ Owner ruling needed #N: ID[, ID…] · content <digest12> · repo owner/name`; the owner-go hook records it; any session, last 24 h; white space and case aside), and that answer must be nothing but decisions, `ID: accept|follow-up|reject` per asked id, the id always written (any other word decides nothing; over 1000 characters is not recorded); exit 1 otherwise, or when gh resolves the repository off github.com
  -> the request is bound to the findings' text: the digest is recomputed over ALL the ids of the request from the current review state and must equal the recorded one, so a rebuilt review that reuses an id for a changed finding (or a request in the old line shape, with no digest) cannot reuse the ruling; ask again with ruling-request
  -> pass the owner's own words as --owner-quote, never a paraphrase; then re-post the triage comment NOW (`pipeline comment --pr N --kind triage`); until then the ruling is local only (`published: false`) and `pipeline state show` restores the published state without it
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

bring the PR branch up to date with its base on GitHub (update-branch with expected_head_sha), return the new head (checks are not waited for by default).

```
pipeline update-branch --pr N [--expect-head SHA] [--max-cycles N=3] [--wait-checks] [--repo DIR]   -> {ok, outcome, updated, cycles, base, startHead, head, localHead, pullNeeded, message?, warnings?}; outcome up-to-date (exit 0; when updated: git pull --ff-only, then re-verify and run the gate on `head`; checks are NOT waited for unless --wait-checks) | rebase-needed | head-moved | cycle-cap | head-timeout | not-open | (with --wait-checks) checks-failed | checks-timeout (exit 1; rebase-needed = the update conflicts, needs-human), 3 GitHub unavailable. While it runs the run record of the PR shows inFlight {kind: update-branch}; warnings lists a record write that failed (never fatal)
```

Exit: 0 `up-to-date` (the base tip is part of the PR head; `updated` says whether this run merged the base in: then `git pull --ff-only`, re-verify, and gate `head`) · 1 `rebase-needed` (the update conflicts: `needs-human`, never a force push), `head-moved` (someone pushed since the verified head, GitHub refused `expected_head_sha`, or the new head is not GitHub's merge of the base into the pinned head: nothing more was updated), `cycle-cap` (the base kept moving), `head-timeout` (GitHub never showed the new head), `not-open`; with `--wait-checks` also `checks-failed` / `checks-timeout` · 3 GitHub (`gh`) unavailable, including any unexpected failure reading checks.

Run record: `inFlight` `{kind: update-branch, maxMinutes: 30}` is set before the update and cleared on every exit; a failed record write is listed in `warnings` and never fails the update.

## vendor

copy the CI-side scripts into a project (scripts/pipeline/); --check reports drift.

```
pipeline vendor --repo DIR [--check]
```

Exit: 0 copied / no drift · 1 drift found (`--check`) · 2 usage.

Vendoring removes a leftover `scripts/pipeline/stop-verify.mjs` from an earlier vendor (the Stop hook was retired; output `removed` lists it, and only that file is ever deleted); `--check` reports it as drift with reason `retired`. If `.claude/settings.json` or `.claude/settings.local.json` still has a hook that runs `stop-verify`, both modes add a `warnings` entry telling the owner to remove that Stop hook entry; the settings files are never edited. Vendoring also appends `scripts/pipeline/** -text` and `scripts/verify text eol=lf` to the project's `.gitattributes` (idempotent; output `gitattributes` lists what was added), so a Windows autocrlf checkout cannot make the byte comparison drift. `--check` warns when the entries are missing. The vendored libs include `lib/review-marker.mjs` (the review-complete marker and its parser, used by the guards for `Cross-model review`).

## verify

plan the verify commands for the ship loop (plan-after-fix); limit parallel full verifies (slot).

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

`slot --run` is for repos that set `verify.max_parallel_full: <n>` (a positive integer): at most n full verifies of ALL repos run at once on this machine, the rest wait in arrival order, so one machine is not overloaded by several sessions' database-heavy verifies. It wraps the run instead of an acquire/release pair because a slot is a machine lock (pipeline/lib/locks.mjs) owned by a live process: the wrapper is that process for exactly as long as the verify runs, and a wrapper killed hard frees its slot through the usual dead-owner reclaim. It runs ONLY the repo's `verify.full` from `.claude/pipeline.yml` (plus a validated `--only`), never a command of the caller's, so it cannot be used as an exec that walks past the git and file guards; since a PR can change that config, the exact command line is also judged by the same guards as `job start` first (denied: exit 1 `{ok:false, refused:true, reason}`, nothing queued or run). The wrapper exits with the verify's exit code (128 + n for a signal) and prints nothing on stdout. Before the verify starts it writes ONE JSON line to stderr, `{"slot":{"index","of","waitedSeconds","loadWaitSeconds","warnings"}}`, which the ship summary quotes. `verify.max_load` (positive number, needs `max_parallel_full`) adds a second, optional wait AFTER the slot is held: while the 1-minute load average is above it, re-check every 5-30 s (random, so waiters do not start together) for at most `verify.max_load_wait_minutes` (default 10, at most 10), then run anyway with a warning. On Windows the load check is skipped (warning). `slot --status` is read only. `PIPELINE_LOCK_DIR` moves the lock directory (a test seam; changing it splits the machine-wide limit).

## version

print the pipeline version.

```
pipeline version
```

Exit: 0.

## worktrees

remove finished worktrees (prune), keep one with a lock (keep / unkeep), list or purge the holding folder.

```
pipeline worktrees prune [--repo DIR] [--dry-run] [--notify] [--summary-only]   (--notify: accepted, does nothing; old schedules pass it)   -> {ok, mode, removed:[...], wouldRemove:[...], kept:[...], hiddenProcesses, restored:[...], outside:[...], holding:{batches, purged}, summary, log} | --summary-only: one line {ok, summary, errors?}
pipeline worktrees keep NAME [--reason TEXT] [--repo DIR]   -> {ok, slug, locked}
pipeline worktrees unkeep NAME [--run ID] [--repo DIR]   -> {ok, slug, unlocked}
pipeline worktrees holding [--purge] [--repo DIR]   -> {ok, batches:[...], purged:[...]}
pipeline worktrees schedule (--install [--at HH:MM] | --remove | --status) [--repo DIR]   -> {ok, installed, line, timezone, warning?} | {ok, removed} | {ok, installed, line}   (macOS: a launchd LaunchAgent; adds plist, changed, loaded, note)
```

Design: [docs/specs/2026-10-13-worktree-prune-design.md](specs/2026-10-13-worktree-prune-design.md). `--repo` may name the
container, a linked worktree or a subdirectory: candidates, config (the main worktree's `.claude/pipeline.yml`) and the
run lock all come from the main worktree. A worktree is removed only when its newest same-repo PR merged at least
`min_merged_hours` ago, every local commit is in that PR, nothing but `delete` / `archive` files is left in it, and
nothing uses it (lock, process, a recent Claude transcript whose session worked there — its `cwd` inside the worktree or
a tool call naming the path; a tool result or prose that merely prints it does not count — memory note, recently changed
file); removal goes through a quarantine move and a final re-inspection, and the `archive` files wait 30 days in the
holding folder (archiving and purging both take a lock on that folder, so two clones of one repo cannot overwrite each other's files or manifest, and a purge never runs mid-archive; a lock not obtained within 30 s keeps the worktree, or makes the purge skip that run and report `purgeSkipped`). The process check reads `/proc` on Linux and runs one `lsof` on macOS (fail-closed: a missing or failing `lsof`, or
one that cannot show our own process's cwd — the positive control — keeps every candidate); on Windows every candidate
is kept ("cannot check running processes on this platform") and prune never removes anything there — `mode: on` is
report-only in effect. A `pipeline-keep:` lock older than 7 days is reported as `stale keep (<N>d: <reason>) — still needed?` (its own
group in the summary) and never released. `worktrees.mode` governs every mutation:

| action | off | report (default) | on | `--dry-run` |
|---|---|---|---|---|
| evaluate and report worktrees | no (`disabled: true`) | yes | yes | yes |
| remove a worktree, delete caches, archive evidence | no | no | yes | no |
| move back a quarantine left by a killed run | yes | yes | yes | report only |
| purge holding batches older than 30 days | no | no | yes | no |
| `keep` / `unkeep` locks | yes | yes | yes | n/a |

`unkeep` releases only a `pipeline-keep:` lock, and with `--run ID` only the one whose reason carries `ship run ID`.

Every completed `prune` (a full run, `skipped`, or off mode's `disabled`) has a one-line `summary` and appends it, with a
timestamp, to `prune-<repo>.log` in the prune log directory (the last 30 kept; its path is `log`). `--summary-only`
prints only `{ok, summary}` (plus `errors` when a step failed) as one compact JSON line; a run that fails before it has a
summary prints its usual error object, also on one line.

Exit: 0 completed (also `skipped: "already running"` / `"git operation in progress"`) · 2 usage, repo, config, or the
`gh` repository does not match `origin` · 3 GitHub unavailable.

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
