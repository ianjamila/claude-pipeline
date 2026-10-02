# pipeline CLI reference

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs <command>`. Commands live one per file in `pipeline/commands/` and export
`meta.summary` and `meta.usage`; the usage blocks below are copied from `meta.usage` (a test fails if they drift) and
the same text is printed by `P <command> --help`. `P --help` lists every command.

Every command prints ONE JSON object on stdout (human text goes to stderr). Exit codes: **0** ok · **1** check failed /
blocked · **2** usage or environment error (also: unknown command, unknown flag) · **3** a dependency is unavailable
(Codex, GitHub, a deployment that never finished). Flags after a bare `--` belong to the command being run (`job start`).
`--repo DIR` (default: the current directory) is accepted by every repo-scoped command and resolves to the repository top level.

## agent-log

queue a line for the agent log, or stage queued lines + this PR's line as a commit in the worktree.

```
pipeline agent-log queue --line "<line>" [--repo DIR]   -> {ok, queued, file}
pipeline agent-log stage --pr N [--line "<line>"] [--repo DIR]   -> {ok, committed, lines, file, staged, dropped}; run in the PR worktree;
  staged lines stay queued ("staged in PR N") until origin/<default> contains them, and are re-staged if that PR closes unmerged;
  default line = the PR's agent-log line with outcome "merged — prod smoke pending"; exit 2 when the worktree has other uncommitted changes,
  is on the default branch or a detached HEAD, or is not the PR's head branch at the PR's head commit; exit 3 when GitHub cannot say
```

Exit: 0 ok · 2 usage, or the worktree is not the PR's clean head branch (stage) · 3 GitHub cannot say / queue lock timeout.

## arbiter

decide which items need the arbiter, then prove and apply its rulings.

```
pipeline arbiter needed --round R [--force] [--repo DIR]
  -> {needed:false, items:[]} | {needed:true, items, inputPath, digest, digest8, tag}
pipeline arbiter apply --round R [--tag TAG | --agent-id ID] [--projects-dir DIR] [--max-age-ms N] [--repo DIR]
  the proof is pinned to claude-fable- at effort high; --expect-model / --expect-effort are honoured only with PIPELINE_TEST_MODE=1
  -> {ok, round, tag, transcript, errors, items}; exit 0 proven + applied, 1 unproven (every arbitrated item needsHuman), 2 no transcript
```

Exit: `needed`: 0 (`needed:false` is also 0) · `apply`: 0 proven + applied, 1 proof failed (arbitrated items marked needsHuman), 2 no transcript found / usage.

## artifacts

publish UI screenshots to the pipeline-artifacts branch and print PR-body markdown.

```
pipeline artifacts push --pr N --dir DIR [--repo DIR]   -> {ok, files:[{name, markdown}], skipped:[{name, reason}]}   (png/jpg/jpeg/webp/gif, max 20 files, each <= 5 MB)
```

Exit: 0 pushed (or nothing to push) · 2 environment / git error · 3 GitHub (`gh`) unavailable.

## codex-review

run one Codex review round over base..head and record its findings.

```
pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]
  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, path}
  --base must be the PR's merge base for round 1 and the previous round's toHead after that, else exit 2 {error:base-mismatch}
  exit 3 {ok:false, unavailable:true, reason: quota|auth|unavailable|error|malformed|github} when Codex or GitHub could not deliver
  env: PIPELINE_CODEX_TIMEOUT_MS overrides the 30 minute Codex timeout (tests)
```

Exit: 0 round recorded · 2 usage or base-mismatch · 3 Codex or GitHub could not deliver (quota, auth, unavailable, error, malformed, github): never "no findings".

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

Exit: 0 valid · 2 missing or invalid (`errors` listed). A valid config may carry `warnings` (e.g. `ci.required_checks` omits the guard contexts `Test integrity` / `Hard-stop scan`).

## deploy

wait for a commit's deployment and print its URL.

```
pipeline deploy url --sha SHA --environment ENV [--timeout SEC=900] [--poll SEC=15] [--repo DIR]
```

Exit: 0 deployed · 1 the deployment failed · 3 nothing finished in time (or GitHub unavailable).

## final-gate

prove this PR head is verified, reviewed, CI-green and smoked; writes .review/final-gate.json.

```
pipeline final-gate --pr N [--repo DIR]   -> {ok, repo, pr, base, head, tree, contentHash, checks[{name,ok,detail}], failed[], at}; exit 0 all checks pass, 1 any fails, 3 GitHub unavailable
```

Exit: 0 every check passes (writes .review/final-gate.json) · 1 any check fails · 3 GitHub (`gh`) unavailable.

## followups

open an agent-suggestion issue for each FOLLOW-UP item of a round.

```
pipeline followups create --round R [--repo DIR]
  -> {ok, round, created:[{id, number, url}], skipped:[ids already filed], held:[ids waiting for a human]}
  one issue per fingerprint across the whole review; a FOLLOW-UP that needs a human is held, not filed
```

Exit: 0 · 2 usage / no state · 3 GitHub (`gh`) unavailable.

## hardstops

list hard-stop hits for a branch diff (exit 1 unless human-approved).

```
pipeline hardstops --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, approved, hits}; exit 1 when hits and not approved
```

Exit: 0 no hits, or hits all approved by `human-approved` · 1 unapproved hits · 2 usage / config.

## integrity

check that a branch diff does not weaken tests (exit 1 unless test-change-approved).

```
pipeline integrity --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, overridden, violations, base, head}; exit 1 when not ok
```

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
pipeline merge --pr N [--repo DIR]   -> {ok, merged, mergeSha, prodBefore} ; exit 0 merged, 1 not merged / refused (run final-gate again), 3 GitHub unavailable or no known-good production deployment
```

Exit: 0 merged · 1 not merged / refused by the live gate (run final-gate again) · 3 GitHub unavailable, or no known-good production deployment.

## model-proof

prove a subagent ran on the expected model and effort.

```
pipeline model-proof (--tag TAG | --agent-id ID) [--expect-model claude-fable-] [--expect-effort high]
                     [--expect-agent-type TYPE] [--expect-meta-model MODEL] [--projects-dir DIR] [--max-age-ms N]
  -> {ok, transcript, meta, models, efforts, errors, finalAssistantText}; exit 0 proven, 1 mismatch, 2 not found/unreadable
```

Exit: 0 proven · 1 mismatch · 2 transcript not found / usage.

## preflight

report whether the pipeline may merge (config, gh, protection, pause, Codex).

```
pipeline preflight [--repo DIR]   (exit 0 can merge, 1 cannot, 2 config missing/invalid)
```

Exit: 0 pipeline may merge · 1 it may not (`reasons`) · 2 config missing or invalid.

Branch protection must require `ci.required_checks` AND, unless `ci.guard_checks: false`, the guard contexts `Test integrity` and `Hard-stop scan`; `protect` sets that same list.

## prod-watch

verify the production deployment of a merge; roll back safely, open an issue and a revert PR if it fails.

```
pipeline prod-watch --sha MERGE_SHA [--pr N] [--expect-text T] [--retry-wait SEC=60] [--repo DIR]   -> {ok, outcome: merged|deploy-failed|deploy-not-observed|not-live|superseded|recovered|rollback-failed|changed-during-recovery|rollback-skipped|no-production, ...}
```

`--expect-text` applies only to this merge's own deployment: smokes of the rolled-back or superseded (other) deployment run without it. `not-live` also covers a merge whose deployment succeeded but was never promoted while production still serves the known-good deployment (nothing is rolled back).

Exit: 0 outcome `merged` (or no production configured) · 1 any other outcome (recovered, rollback-failed, ...) · 3 deployment not observed / GitHub unavailable.

## protect

print (or with --apply, set) the GitHub branch protection and repo settings the pipeline relies on.

```
pipeline protect [--apply] [--checks a,b] [--repo DIR]   (--apply needs PIPELINE_ADMIN=1)
```

Exit: 0 dry run printed, or applied with nothing missing · 1 no admin rights / plan limit, or something still missing after applying · 2 usage (`--apply` without `PIPELINE_ADMIN=1`) · 3 GitHub (`gh`) unavailable.

## resume

list open PRs waiting for a cross-model review.

```
pipeline resume list [--repo DIR]
```

Exit: 0 · 3 GitHub (`gh`) unavailable.

## review-complete

remove awaiting-review once the review is valid for the current content.

```
pipeline review-complete --pr N [--repo DIR]   -> exit 0 {ok:true, removed:true}; exit 1 {ok:false, reason} when the review is not valid
  the checked-out HEAD must be the head GitHub holds for the PR; exit 3 when the label is still on the PR after removal
```

Exit: 0 label removed · 1 review not valid for this head · 2 usage · 3 label still on the PR after removal.

## risk

assess the risk level of a branch diff.

```
pipeline risk --base REF --head REF [--repo DIR]   -> {ok, level, reasons, lightLane, changedLines, fileCount, hardStops, base, head, mergeBase}
```

Exit: 0 whenever a level could be computed (it is a report, not a gate) · 2 usage / config / git.

## smoke

run the configured preview/production smoke command and record the result.

```
pipeline smoke --target preview|production --url URL [--expect-text T] [--sha SHA] [--repo DIR]   -> {ok, target, url, sha, exitCode, tail, at}; exit 0 passed, 1 failed, 2 not configured/usage
```

Exit: 0 passed · 1 failed · 2 not configured / usage.

## state

show or update the review loop state (.review/state.json).

```
pipeline state show [--round R] [--accepted] [--disputed] [--needs-human] [--pr N] [--repo DIR]
  -> {ok, recovered, count, items}; with --pr and no local state, rebuilds it from the PR triage comment
pipeline state outcome [--repo DIR]   -> roundOutcome + {clean}; exit 0 whether or not clean
pipeline state mark-implemented --ids a,b [--repo DIR]
pipeline state record-followup --id ID --url URL [--repo DIR]
pipeline state set-outcome --outcome TEXT [--repo DIR]
```

Exit: 0 · 2 no state / usage (`outcome` is 0 whether or not `clean`).

## summary

upsert the PR summary comment and print the agent-log line.

```
pipeline summary --pr N --outcome O [--built TEXT] [--repo DIR]   -> {ok, url, agentLogLine}
```

Exit: 0 · 2 usage / no state · 3 GitHub (`gh`) unavailable.

Without `.review/state.json` only `--outcome blocked` and `--outcome awaiting-review` are accepted (the two early-stop paths: verify red three times, Codex out in round 1): the comment is rendered with no rounds (a `blocked` one names the failing step from the verify report) and `agentLogLine` is still printed. Any other outcome without state is exit 2.

## triage

apply the judge triage, settle disputed bugs with test results, close the light lane.

```
pipeline triage validate --round R (--from-tag TAG | --file F) [--projects-dir DIR] [--max-age-ms N] [--repo DIR]
  -> {ok, round, counts:{ACCEPT,FOLLOW-UP,REJECT}, settled, unsettled, judgeProof}; exit 1 + errors when the judge output is invalid (state untouched)
pipeline triage settle --id ID --result bug-confirmed|bug-disproved --evidence TEXT [--repo DIR]
  -> only for a disputed bug with a possible settle test and no test result yet; exit 1 for an item that needs a human, was ruled by the arbiter or is implemented
pipeline triage light-lane --round R [--repo DIR]
```

Exit: `validate`: 0 applied, 1 judge output invalid (state untouched) · `settle`: 0 recorded, 1 refused · `light-lane`: 0 · 2 usage / no state.

## vendor

copy the CI-side scripts into a project (scripts/pipeline/); --check reports drift.

```
pipeline vendor --repo DIR [--check]
```

Exit: 0 copied / no drift · 1 drift found (`--check`) · 2 usage.

Vendoring also appends `scripts/pipeline/** -text` and `scripts/verify text eol=lf` to the project's `.gitattributes` (idempotent; output `gitattributes` lists what was added), so a Windows autocrlf checkout cannot make the byte comparison drift. `--check` warns when the entries are missing.

## version

print the pipeline version.

```
pipeline version
```

Exit: 0.

## Where this differs from spec section 5.2

The spec table was written before the build; the CLI that shipped differs as follows (the CLI is authoritative).

| Spec 5.2 | Shipped |
|---|---|
| `triage-validate`, `arbiter-needed`, `rulings-apply` | `triage validate`, `arbiter needed`, `arbiter apply` (apply proves the model from the transcript itself; no separate `model-proof` step needed) |
| `triage-comment`, `summary` | `comment --kind triage|summary|needs-human|blocked|awaiting-review`; `summary` also posts the summary comment |
| `preview-url` | `deploy url --sha SHA --environment ENV` (GitHub deployments only; no `preview.url_command`) |
| `agent-log --line` (docs-only PR) | `agent-log queue --line` and `agent-log stage --pr N` (commit into the PR branch; the queue is flushed by `stage`) |
| not listed | `artifacts push`, `followups create`, `hardstops`, `integrity`, `job start\|wait\|read`, `protect`, `resume list`, `review-complete`, `state show\|outcome\|mark-implemented\|record-followup\|set-outcome`, `triage settle\|light-lane`, `vendor`, `version` |
| `risk` returns `files[]`, `stats` | `risk` returns `level, reasons, lightLane, changedLines, fileCount, hardStops, base, head, mergeBase` |
| `prod-watch` rolls back with the rollback command | `prod-watch` runs `vercel rollback <known-good> --yes --timeout 3m` itself; `production.rollback.command` is documentation |
