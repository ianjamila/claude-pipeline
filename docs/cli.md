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
  the proof is pinned to claude-fable- at effort high; --expect-model / --expect-effort are honoured only with PIPELINE_TEST_MODE=1 in a repo checkout (an installed copy ignores it)
  -> {ok, round, tag, transcript, errors, items}; exit 0 proven + applied, 1 unproven (every arbitrated item needsHuman), 2 no transcript
```

Exit: `needed`: 0 (`needed:false` is also 0) · `apply`: 0 proven + applied, 1 proof failed (arbitrated items marked needsHuman), 2 no transcript found / usage.

## artifacts

publish UI screenshots to the pipeline-artifacts branch and print PR-body markdown.

```
pipeline artifacts push --pr N --dir DIR [--repo DIR]   -> {ok, files:[{name, markdown}], skipped:[{name, reason}]}   (png/jpg/jpeg/webp/gif, max 20 files, each <= 5 MB)
```

Exit: 0 pushed (or nothing to push) · 2 environment / git error · 3 GitHub (`gh`) unavailable.

## checkpoint

record where the ship run stands in the PR summary comment (refuses unless local HEAD is the pushed PR head).

```
pipeline checkpoint --pr N --step build|verify|pr|review|gate|awaiting-owner-merge|merge|prod-watch|ended [--next TEXT] [--detail TEXT]
                    [--request-file F] [--tasks-file F] [--task-done ID] [--verify-report] [--round R] [--resumed] [--repo DIR]
  -> {ok, url, action, record, warnings}; exit 1 {error: unpushed | behind | diverged} (local HEAD is not the PR head on GitHub), 2 usage, 3 GitHub unavailable
  --request-file: the user's request, text, at most 2 KB · --tasks-file: JSON [{id, title, spec}] · --task-done ID: mark one task done (repeatable)
  --resumed: this run was taken over by `ship resume` (or adopts a PR): stamps record.resumed {at, host, head}, which later checkpoints keep and which makes `P merge` require --owner-approved-head
  --verify-report: copy {head, tree, mode, ok, failedStep} of the verify report, only when its head and tree are this HEAD's (otherwise a warning)
```

Exit: 0 recorded · 1 `unpushed` (local HEAD is ahead of the PR head on GitHub: push first) / `behind` (the PR has newer commits: pull) / `diverged` (neither is an ancestor of the other, or the PR head is not fetched here: nothing is written) · 2 usage (unknown `--step`, a `--request-file` over 2 KB or not text, a bad `--tasks-file`, a record from a newer pipeline version) · 3 GitHub (`gh`) unavailable.

`--resumed` is passed by a session that takes over a stalled run (or adopts a PR) as its first checkpoint: it stamps `record.resumed` `{at, host, head}`, which later checkpoints keep, and which makes `merge` demand `--owner-approved-head`. It sets the heartbeat (`os.hostname()` and the time) and keeps the summary sections already in the comment. `--verify-report` copies the report at `verify.report` only when its head and tree are this HEAD's; otherwise it is ignored and `warnings` says why. A step other than `ended` / `awaiting-owner-merge` clears a previous `outcome` (the run is going again).

## codex-review

run one Codex review round over base..head and record its findings.

```
pipeline codex-review --pr N --round R --base SHA --head SHA --effort low|medium|high|xhigh [--model M] [--repo DIR]
  -> {ok, round, counts:{blocking, suggestions, worth_considering}, preRuled, lightLane, path}
  --base must be the PR's merge base for round 1 and the previous round's toHead after that, else exit 2 {error:base-mismatch}
  exit 2 {error:empty-range} when earlier rounds accepted items and the branch content is unchanged since the last round (base == head)
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
pipeline final-gate --pr N [--repo DIR]   -> {ok, repo, pr, base, head, tree, contentHash, checks[{name,ok,detail}], failed[], at}; exit 0 all checks pass, 1 any fails (pr-open detail starts "behind-base:" when the PR is behind its base: update the branch and re-verify), 3 GitHub unavailable
```

Exit: 0 every check passes (writes .review/final-gate.json) · 1 any check fails · 3 GitHub (`gh`) unavailable.

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

## hardstops

list hard-stop hits for a branch diff (exit 1 on blocking hits unless human-approved).

```
pipeline hardstops --base REF --head REF [--labels a,b] [--repo DIR]   -> {ok, approved, hits, blocking, advisory, ownerMerge}; exit 1 when blocking hits and not approved (ownerMerge = hits the owner merges in chat, owner_approval: chat)
```

With `owner_approval: chat` in pipeline.yml every would-be-blocking hit is returned as `advisory` + `ownerMerge` (also listed under `ownerMerge`; the owner merges them by saying "merge" in chat) and the exit is 0.

Exit: 0 no blocking hits (report-only hits, `advisory`, are listed but never block), or blocking hits approved by `human-approved` · 1 unapproved blocking hits · 2 usage / config.

## inbox

read-only triage of every open PR (and recently merged ones): what each waits for and the next action.

```
pipeline inbox [--stale-days 14] [--merged-days 7] [--no-git] [--repo DIR]
  -> {ok, generatedAt, bases[{ref, sha}], prs[], triage{merge, resume, close, leave}, strandedAfterMerge[], local{unpushed[], orphanWorktrees[]}, warnings[]}
```

Never comments, labels, closes, merges or creates a ref. Facts: one paginated GraphQL query for the open PRs (page size 20) and one for PRs merged within `--merged-days`; per PR the full paginated comment list (our run record, review state, needs-human reason and run events are read from the viewer's own comments only, so a forged marker from someone else is ignored; a record bound to another PR or branch is ignored with a warning). Git, unless `--no-git`: ONE `git fetch --no-tags origin +refs/heads/<base>:refs/remotes/origin/<base> refs/pull/<n>/head …` per distinct base (the only things it writes are fetched objects and that remote-tracking ref), then per PR `git merge-tree --write-tree` for `conflicts` / `alreadyOnBase` and the review content hash (the gate's own, agent log excluded) as `contentHash`. `--no-git`, git older than 2.38 or a failed fetch leave those facts `null` and add a `warnings` entry; with `--no-git` `local` is `{unpushed: null, orphanWorktrees: null}`. `local` lists branches with unpushed commits, uncommitted changes or a diverged ref, and worktrees under `worktree_dir` whose branch has no open PR (listed only). CI is judged against the required checks (`ci.required_checks` plus the guard contexts unless `ci.guard_checks: false`): `passed` only when every one has a successful row.

Each PR carries `waitingOn` (`nothing-left` · `running` · `owner-decision` · `failing-check` · `review` · `owner-merge` · `pipeline` · `abandoned`), `reason`, `nextAction`, `lastActivity`, `stale` and `suggest` (`merge` · `resume` · `close` · `leave`, also the keys of `triage`). A PR with no run record and no review state whose last activity is older than `--stale-days` is `abandoned` (close) whatever else is wrong with it (conflicts, a red check, a draft are appended to the reason: "; also …"); `failing-check` names the failed required checks (`ciFailed`) or the base it conflicts with. `strandedAfterMerge` lists PRs merged within `--merged-days` whose run stopped in the merge / prod-watch step or has a `rollback-intent` without a `rollback-result`.

Exit: 0 · 2 usage / config / not a git repository · 3 GitHub (`gh`) unavailable.

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
pipeline merge --pr N [--owner-approved-head SHA] [--repo DIR]   -> {ok, merged, mergeSha, prodBefore, warning?, warnings?} ; exit 0 merged (mergeSha:null + warning when GitHub cannot name the merge commit), 1 not merged / refused (error: gate|behind-base|live-check|pre-merge; behind-base = the base moved: the branch was updated (or the update failed, see outcome), re-verify and run final-gate again), 3 GitHub unavailable or no known-good production deployment. While it runs the run record of the PR shows inFlight {kind: merge} and step merge; a prod-before event comment (the known-good deployment) is posted before the merge command, and when that post fails nothing is merged (error pre-merge); warnings lists a run record write that failed (never fatal). A run record marked resumed (`P checkpoint --resumed`: a run taken over by ship resume) refuses with error pre-merge unless --owner-approved-head names the full gate head: only the owner's "merge" for that head supplies it; so does a run record that cannot be checked (unreadable, invalid or unsupported: it may be a resumed one)
```

Exit: 0 merged (a merge commit GitHub cannot name yet is `mergeSha: null` plus a `warning`; prod-watch resolves it) · 1 not merged / refused by the live gate or by the last pre-merge look at GitHub (run final-gate again; `behind-base`: the base moved, the branch was just updated on GitHub, so pull, re-verify and gate the new head) · 3 GitHub unavailable, or no known-good production deployment.

Resumed runs: `merge` reads the PR's run record (the viewer's own summary comment) before anything irreversible; when it carries `resumed` (set by `checkpoint --resumed`, never cleared), `merge` refuses with exit 1 `{merged: false, error: pre-merge, reason: resumed run: the owner must approve this exact head (pass --owner-approved-head <sha>)}` unless `--owner-approved-head` is the full 40-character gate head. A record that cannot be checked fails closed: unreadable comments, or an `invalid` / `unsupported` (newer version) record, refuse the same way (`reason: <the run record could not be read (…) | the run record is invalid|unsupported>, so the resumed-run guard cannot be checked: the owner must approve this exact head (pass --owner-approved-head <sha>)`), because it may be a resumed one. No record (`absent`) or a `legacy` comment is an ordinary run.

Run record: right after `.review/prod-before.json` is written, and before the merge command, `merge` sets the record's `inFlight` `{kind: merge, host, startedAt, maxMinutes: 2 × merge.wait_minutes + 15}` and `step: merge`, and posts, after the last look at GitHub and still before the merge command, a `prod-before` event (always a NEW comment: repo, environment, pr, `headBeforeMerge` = the approved PR head, `deployment {id, sha, url}`) when a known-good deployment was recorded (no `production` configured: no event). On every exit `inFlight` is cleared: merged → `step: prod-watch` and `mergeSha`; not merged → `step: gate`. The event fails CLOSED: it is the only cross-machine copy of the rollback target, so when it cannot be posted nothing is merged (exit 1, `error: pre-merge`, `reason: could not record the rollback target on the PR (prod-before event)`; `inFlight` is cleared). The run record itself is display: a failed record write is listed in `warnings` and never fails the merge.

## model-proof

prove a subagent ran on the expected model and effort.

```
pipeline model-proof (--tag TAG | --agent-id ID) [--expect-model claude-fable-] [--expect-effort high]
                     [--expect-agent-type TYPE] [--expect-meta-model MODEL] [--projects-dir DIR] [--max-age-ms N]
  -> {ok, transcript, meta, models, efforts, errors, finalAssistantText, stopReasonMissing, finalVia}; exit 0 proven, 1 mismatch, 2 not found/unreadable
```

Exit: 0 proven · 1 mismatch · 2 transcript not found / usage.

## notify

send the owner a push notification (ntfy, plus a Windows toast under WSL2).

```
pipeline notify --test [--repo DIR]   |   pipeline notify --event owner-merge|needs-human|arbiter-escalation|stopped --pr N --action TEXT [--cause CODE] [--repo DIR]   -> {ok, sent, reason?, transports:{ntfy, toast}}
```

`--test` sends one real push to every transport and prints the per-transport result (the rollout check; it is never deduplicated). `--event` is the manual route for a stop that cannot be expressed through `pipeline summary`.

Configuration, in this order per field: the environment, then `~/.config/claude-secrets.sh` (`PIPELINE_SECRETS_FILE` overrides the path; the file is parsed as literal `NAME=value` lines, never sourced): `NTFY_TOPIC` (required), `NTFY_SERVER` (default `https://ntfy.sh`), `NTFY_TOKEN` (optional). A field that is present but invalid sends nothing (`reason: invalid-config:<field>`); no topic is a silent `no-topic`; `PIPELINE_NOTIFY=off` disables everything (the test suite sets it). The result never contains the topic, token or server path.

One push per event: a ledger under `~/.claude/pipeline-state/` (`notify-ledger.jsonl`) makes a replay of the same event a no-op (`reason: duplicate`). Identity is repo, PR, event, head, outcome, open needs-human ids and `--cause`, never the action text. The whole call is capped at 15 s.

Exit: `--test` 0 when ntfy accepted the push, 1 when it did not · `--event` 0 whether or not a push went out (read `sent` / `reason`) · 2 usage.

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
pipeline prod-watch (--sha MERGE_SHA [--pr N] | --pr N) [--expect-text T] [--retry-wait SEC=60] [--observe-only] [--repo DIR]   -> {ok, outcome: merged|deploy-failed|deploy-not-observed|not-live|superseded|recovered|rollback-failed|changed-during-recovery|rollback-skipped|needs-owner|no-production, ..., notify}
  with only --pr N (merge printed mergeSha:null) the merge commit is read from the merged PR (up to 6 looks); exit 1 {error:not-merged} when the PR is not MERGED, exit 3 {error:merge-sha-unresolved} when GitHub never names it
  with --pr N it records rollback-intent / rollback-result / recovery-reported events on the PR and shows the watch as in flight in the run record
  --observe-only: same smokes and outcomes, but never rolls back, opens an issue or revert PR, or adds a label: what would have rolled back is {outcome: needs-owner, evidence}; a rollback-intent with no rollback-result on the PR is {rollbackInterrupted: {intent, liveNow}}; a rollback-result of this merge already on the PR (the original watch died before `P summary`) is reported as its recorded outcome, recovered (ok and verified) or rollback-failed, without re-smoking, with {recorded: {id, url, ok, verified}} and the issue / revert PR urls of its recovery-reported event; with --pr N it also records its outcome in the run record (step ended) when the record has none yet (or only prod-unknown), so resume and the inbox stop routing the PR here; works from a detached worktree at the merge commit (the known-good target is read from the prod-before event when .review/prod-before.json is absent)
```

`--expect-text` applies only to this merge's own deployment: smokes of the rolled-back or superseded (other) deployment run without it. `not-live` also covers a merge whose deployment succeeded but was never promoted while production still serves the known-good deployment (nothing is rolled back).

Events and the run record (with `--pr`): immediately BEFORE the rollback it posts a `rollback-intent` event on the PR (merge sha, failing deployment, rollback target); if that comment cannot be posted nothing is rolled back (`rollback-skipped`, "could not record the rollback intent on the PR"). Right after the rollback and its check it posts `rollback-result` (`ok`, `liveAfter`, `verified`), and after the incident issue / revert PR `recovery-reported`. Each is a NEW comment, never edited (ids `<sha7>-<n>`); failing to post the last two is only a warning. The watch also shows itself in the PR's run record (`inFlight` kind `prod-watch`, max `production.deploy_timeout_minutes` + 30 minutes, step `prod-watch`) and clears that on every exit; a record that cannot be written is a `warnings` entry, never a failure.

`--observe-only` runs the same deployment lookup, smokes and outcome detection, but never rolls back, opens an issue or revert PR, adds a label, posts an event or takes the recovery lock. A failing smoke that a normal watch would have rolled back (or ended in `rollback-skipped` / `changed-during-recovery`) is outcome `needs-owner`: `reason` plus `evidence` {`underlying` (what a normal watch would have ended with), `failingDeployment`, `liveDeployment`, `knownGood`, `smokeFailure`}. It needs no PR branch, so it can run from a detached worktree at the merge commit: the known-good target is `.review/prod-before.json` when present, else the newest `prod-before` event on the PR. If the PR has a `rollback-intent` with no `rollback-result` of the same id, the JSON carries `rollbackInterrupted: {intent, liveNow}` (the live deployment now), whatever the outcome. With `--pr N` it then writes the outcome into the run record (`step: ended`, summary sections kept) unless the record already has one; `deploy-not-observed` is not recorded (it learned nothing), and no event is posted, so an open `rollback-intent` stays open.

Exit: 0 outcome `merged` (or no production configured) · 1 any other outcome (recovered, rollback-failed, needs-owner, ...), or with --pr only: the PR is not MERGED · 3 deployment not observed / GitHub unavailable / the merge commit could not be read.

Owner push: once `runProdWatch` has returned (the production lock is released) the owner gets one push for the outcome (`merged` priority 3, the rest 4, the three unsafe-rollback outcomes 5), worded from the artifacts that exist: a missing rollback issue reads "Rollback issue could not be confirmed — check whether merges are paused", never "merges are not paused". An error exit that has no outcome (`merge-sha-unresolved`, `not-merged`, or a deploy/API error that escapes the watch) sends a "Production check unfinished" push instead; the original exit code, JSON and error are unchanged. The JSON gains `notify` (`{sent, reason?, transports}`; `{sent:false, reason:'no-event'}` for `no-production`). A replay of the same result is a `duplicate` and sends nothing.

## protect

print (or with --apply, set) the GitHub branch protection and repo settings the pipeline relies on.

```
pipeline protect [--apply] [--checks a,b] [--repo DIR]   (--apply needs PIPELINE_ADMIN=1)
```

Exit: 0 dry run printed, or applied with nothing missing · 1 no admin rights / plan limit, or something still missing after applying · 2 usage (`--apply` without `PIPELINE_ADMIN=1`) · 3 GitHub (`gh`) unavailable.

## resume

find PRs a session can pick up, and plan where a stalled run resumes.

```
pipeline resume list [--repo DIR]
  -> {ok, prs[{number, title, headRefName, url, why}]}: open PRs labelled awaiting-review, plus open PRs whose run record
     (written by this GitHub user) is readable and has no outcome yet (a run that stopped mid-way)
pipeline resume plan --pr N [--repo DIR]
  -> {ok, pr, title, url, prState, branch, base, liveHead, enter, reason, adopt, confirm, autoMerge, worktree, stop, recordStatus, record,
      events, local, mergeSha, notes[], warnings[]}; read-only (its only git writes are fetches: the PR head, the base and origin/<branch>)
     enter: closed | ended | observe-prod | not-resumable | local-work | decision | build | verify | review | followups | gate
     adopt: no run record (the PR was not started by the pipeline); confirm: {host, step, minutesAgo, why} when another run may be live,
     stop: where a run on a route that can reach Step 5 ends, never at a merge: awaiting-owner-merge (owner_approval chat) | needs-human (label mode); null on the other routes
     autoMerge: {armed, action: disarm} when an unattended auto-merge is queued, worktree: {action: reuse|add-existing-ref|add-from-remote|none, path?, then?}
  exit 2 when the PR does not exist
```

`list` shows what a session can pick up: PRs parked as `awaiting-review` and open PRs whose run record (written by this GitHub user) has no outcome, i.e. a run that stopped mid-way. `plan` reads the PR, its comments (run record, review state, events), the local branch and the worktrees holding it, and routes the resume by the pure rules in `pipeline/lib/resume-plan.mjs`:

| `enter` | When |
|---|---|
| `closed` | closed without a merge |
| `ended` | merged and nothing is left to watch |
| `observe-prod` | merged, but the run stopped in `merge` / `prod-watch`, or a `rollback-intent` has no `rollback-result`: watch production from a detached worktree of `origin/<base>` at the merge commit; never roll back |
| `not-resumable` | fork PR |
| `local-work` | the local branch diverged from the PR, or a worktree holding it is dirty: the owner decides |
| `decision` | `needs-human`; `reason` is our needs-human comment's first sentence |
| `build` / `verify` | the record has tasks not done / no passing verify for the live head and the run had only reached build or verify |
| `review` | no review state, an incomplete round, content changed since the last round, a round that is not clean, or `awaiting-review` |
| `followups` | published follow-ups without an issue |
| `gate` | everything else: a fresh gate, then the owner-merge stop (resume never merges) |

No usable run record means `adopt: true`; a published review state is still honoured ("no run record" is not "no review state"). `confirm` is set when the heartbeat is from another host and under 90 minutes old, or a command is in flight inside its time budget: ask the owner before doing anything. `autoMerge` asks the skill to disarm an armed auto-merge that no live merge owns. `worktree.action` is `reuse` (a worktree already holds the branch), `add-existing-ref`, `add-from-remote` or `none`, with `then: ff-only` (local behind) or `push` (local ahead); a branch is never reset with `-B`.

Exit: 0 · 2 usage / PR not found · 3 GitHub (`gh`) unavailable.

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
  -> {ok, recovered, source, count, items}; with --pr and no local state, rebuilds it from the PR triage comment
  with --pr and a local state: the published (triage comment) state is authoritative. Local is kept (source local) when it
  equals or strictly EXTENDS the published one; otherwise .review/ moves to .review/stale-<UTC time>/ (source quarantined,
  quarantinedTo) and the published state is restored. source is local | published | quarantined | local-unverified
  (GitHub unreachable but a local state exists: served as is with a `warnings` entry, exit 0; with no local state exit 3)
pipeline state discard-round --round R [--pr N] [--repo DIR]
  -> drop an unpublished, trailing round R from the local state and move .review/round-R/ into .review/stale-<UTC time>/;
     refused (exit 2) when the PR triage comment already holds round R
pipeline state outcome [--repo DIR]   -> roundOutcome + {clean, followupsPending}; exit 0 whether or not clean
pipeline state mark-implemented --ids a,b [--repo DIR]
  -> exit 2 {error:no-code-change} unless the branch content differs from what the accepting round reviewed
pipeline state record-followup --id ID --url URL [--repo DIR]
pipeline state set-outcome --outcome TEXT [--repo DIR]
```

Exit: 0 · 2 no state / usage (`outcome` is 0 whether or not `clean`).

## summary

upsert the PR summary comment and print the agent-log line.

```
pipeline summary --pr N --outcome O [--built TEXT] [--action TEXT] [--cause CODE] [--repo DIR]   -> {ok, url, agentLogLine, notify}
```

Exit: 0 · 2 usage / no state · 3 GitHub (`gh`) unavailable.

Without `.review/state.json` only `--outcome blocked`, `awaiting-review`, `stopped`, `closed` and `merged-externally` are accepted (the early-stop paths: verify red three times, Codex out in round 1, a stop on a gate or merge refusal, the owner closing the PR, a merge made outside the pipeline): the comment is rendered with no rounds (a `blocked` one names the failing step from the verify report) and `agentLogLine` is still printed. Any other outcome without state is exit 2.

Owner push (see `pipeline notify`): the outcome is classified before any GitHub call, and the push is sent after the comment work whether or not GitHub answered (with the PR title when it was fetched; the exit code and JSON are exactly what they would have been, plus `notify`). `awaiting-owner-merge` pushes "ready to merge", `needs-human` pushes "needs you" (or an arbiter escalation when an arbiter ruling parked an item: the push then names ALL open needs-human items, arbiter ones first), and `blocked` / `awaiting-review` / `stopped` push "run stopped". `merged`, `closed`, `merged-externally`, `prod-unknown` (written after a prod-watch exit with no outcome) and every prod-watch outcome word (prod-watch pushed already) send nothing: `notify` is `{sent:false, reason:'no-event'}`. A word that is not classified sends nothing, reports `reason:'unclassified-outcome'` and prints one warning on stderr. `--action TEXT` is the one-line "what to do" the push carries (default per event); `--cause CODE` (letters, digits, `: _ . -`, at most 60) is a short slug such as `final-gate:labels` that is part of the push's identity, so a reworded retry of the same stop does not push twice.

## triage

apply the judge triage, settle disputed bugs with test results, close the light lane.

```
pipeline triage validate --round R (--from-tag TAG | --file F) [--projects-dir DIR] [--max-age-ms N] [--repo DIR]
  -> {ok, round, counts:{ACCEPT,FOLLOW-UP,REJECT}, settled, unsettled, judgeProof}; exit 1 + errors when the judge output is invalid (state untouched)
pipeline triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd CMD --test-file FILE [--repo DIR]
  -> the CLI runs CMD in the repo itself (free-text evidence is not accepted): bug-disproved needs exit 0, bug-confirmed needs a failing exit; FILE must be a committed, clean test file at HEAD named in CMD
  -> only for a disputed bug with a possible settle test and no test result yet; exit 1 for an item that needs a human, was ruled by the arbiter or is implemented
  -> a bug-disproved result on a security/auth/permissions/data item is still needsHuman
pipeline triage light-lane --round R [--repo DIR]
```

Exit: `validate`: 0 applied, 1 judge output invalid (state untouched) · `settle`: 0 recorded, 1 refused · `light-lane`: 0 · 2 usage / no state.

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
| not listed | `artifacts push`, `followups create`, `hardstops`, `integrity`, `job start\|wait\|read`, `protect`, `resume list\|plan`, `review-complete`, `state show\|outcome\|mark-implemented\|record-followup\|set-outcome`, `triage settle\|light-lane`, `vendor`, `version` |
| `risk` returns `files[]`, `stats` | `risk` returns `level, reasons, lightLane, changedLines, fileCount, hardStops, base, head, mergeBase` |
| `prod-watch` rolls back with the rollback command | `prod-watch` runs `vercel rollback <known-good> --yes --timeout 3m` itself; `production.rollback.command` is documentation |
