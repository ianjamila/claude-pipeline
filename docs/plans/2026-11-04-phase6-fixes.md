# Phase 6 fixes + folded follow-ups (2026-11-04) — rev 4 (after Codex plan R1 + recheck + ONE Fable pass: 0 blocking, all folded)

Owner prune 2026-11-04: KEEP ALL. One CP PR (branch `agent/phase6-fixes`), built by hand (owner opted CP out of ship/review), Codex
plan review + ONE Fable plan pass (installer ancestry is a security surface; CI wait gates the hand-off), Codex review of the diff
before ready. F7 is a separate EW PR through EW's own `review` flow. Owner ruling on Codex R1 F2 findings (11-04): NO guard change —
F2 becomes `P merge --dry-run` (guard hooks stay FROZEN).

## F1. Review skill §3.2: CI wait passes on a draft-era SKIPPED required check

**Bug (Phase 6, EW #1631):** after `gh pr ready N`, the head's only run of `Typecheck + Vitest` is the draft-era SKIPPED one until
the `ready_for_review` run exists. The poll loop breaks at once (checks exist) and `gh pr checks N --watch --required` sees nothing
pending → exit 0 → hand-off ~14 min early. Same race EW's gate solves (`scripts/lib/merge-gate.mjs` `waitForFreshChecks`).

**Fix:** `pipeline ci-wait --pr N [--repo DIR] [--appear-timeout SEC=300] [--timeout SEC=3600] [--interval SEC=15]`
(`pipeline/commands/ci-wait.mjs`; pure state machine in `pipeline/lib/ci-wait.mjs`, everything external injected: readers, clock, sleep).

*Role (rev 3):* ci-wait decides WHEN CI is done so the hand-off is not early; it is not the merge authority. Producer provenance
(guard statuses from the pipeline-guards workflow, required rows) is re-proved by `P merge`'s live gate (`finalgate.mjs` ~525–575) and
by GitHub branch protection before any merge. ci-wait still never reports success on evidence it knows to be incomplete.

*Required set (independent inventory, Codex R1-4, R2-2):* two policy sources, each read to one of three outcomes — `present` (rows),
`absent` (authoritative: classic protection 404 "Branch not protected"; rules endpoint 200 with no `required_status_checks` rule) or
`unreadable` (anything else). Classic: `GET repos/O/R/branches/<base>/protection` `required_status_checks.checks[] {context, app_id}` /
`contexts[]` — extract the reader `pipeline/commands/protect.mjs` uses (~121) into a shared lib, no duplicate. Rules: `GET
repos/O/R/rules/branches/<base>` (paginated) `required_status_checks` → `parameters.required_status_checks[] {context,
integration_id}`. Required set = union. Either source `unreadable` ⇒ verdict `unverified` (exit 1) after the wait, with diagnostics
listing `requiredChecks(config.ci)` (config.mjs ~101, which adds the implicit guard/review contexts) and their states; both `absent` ⇒
exit 1 `no-required-checks`. Never a success with part of the set unknown. app_id/integration_id `-1`, `null` or missing ⇒ any app
(as protect.mjs ~31).

*Observations per poll (Codex R1-5, Fable 1/3):* REST, not `gh pr checks`: `GET repos/O/R/commits/<head>/check-runs?per_page=100`
with `--paginate --jq '.check_runs'` (per-page ARRAYS, so `parseConcatenatedJson` in github.mjs ~30 reads every page; a bare
`--paginate` yields concatenated objects and loses page 2) — fields `id`, `name`, `app.id`, `status`, `conclusion`, `check_suite.id`;
and the status LIST `GET repos/O/R/commits/<head>/statuses?per_page=100` (paginated; `id`, `context`, `state`, `creator.login`,
`created_at`) reduced to the latest per context by highest `id` — exactly what finalgate ~543 reads. NOT the combined `/status`
endpoint: its items carry no `creator`, so every app-pinned guard status (EW: Test integrity, Hard-stop scan, Cross-model review @15368)
would stay `missing` forever. Statuses carry no app id. Matching (Codex R2-3): an identity with NO app pin
matches check runs of that name (any app) and the status of that context. An identity pinned to app A matches check runs whose
`app.id` = A, and a status only when its `creator.login` is A's known bot (`KNOWN_APP_BOTS`: 15368 → `github-actions[bot]`, the rule
finalgate already applies; 8329 → the login seen on a captured EW Vercel status — verify from a real EW head before adding it); an
unknown app's status never satisfies a pin (the identity stays `missing` ⇒ reported, never passed). Latest check run per (name, app)
= highest `id` (verify with a captured re-run fixture: a re-queued run must carry a new, larger id; if the fixture disproves it, order by
`check_suite.id` then `id`, and refuse to judge an ambiguous pair). Never order by startedAt. When several producers match one
identity (two apps on an unpinned name, or a check run plus a status), EVERY matching producer's latest result must be terminal-good;
the worst counts (fail > cancelled > pending > missing > pass).

*Per-identity state:* `missing` (nothing reported) · `pending` (check run not completed / status `pending`) · `pass` (success,
neutral) · `fail` (failure, timed_out, action_required, startup_failure, stale; status failure/error) · `cancelled` · `skipped`
split by freshness: the skipped check run's workflow run (`GET repos/O/R/actions/runs?check_suite_id=<id>`, cached per suite) has
`created_at` ≥ readyAt ⇒ `fresh-skip`; earlier, or unreadable ⇒ `stale-skip`. A non-Actions skipped check run (no workflow run) ⇒
`stale-skip`. readyAt = latest `ready_for_review` event of `GET repos/O/R/issues/N/timeline` (paginated; parsed as UTC via Date.parse);
PR never a draft (no event) ⇒ PR `created_at`. All timestamps are GitHub's (one clock).
Residual (Fable 5, documented in the module comment): freshness is judged only for SKIPPED results. A draft-era SUCCESS of a name
whose ready-event run is not created yet (seconds after `gh pr ready`) counts as pass; the window is narrow (the skipped job of the
same workflow keeps the wait open until that workflow's ready run exists) and `P merge`'s live gate re-reads CI before any merge.
Requiring a ready-era run for every identity would hang on checks whose workflows do not trigger on `ready_for_review`.

*BUILD NOTE (11-04, real EW data PR 1631):* a draft-era FAILURE (Cross-model review) stands until re-posted after ready, so failures get the same freshness rule as skips: `stale-fail` (result predates readyAt) waits until --appear-timeout, then becomes `failed`; a fresh failure still ends the wait at once.

*One state machine (Codex R1-6):* poll until every identity is terminal-good (`pass`/`fresh-skip`) ⇒ exit 0; any `fail`/`cancelled`
⇒ exit 1 `failed` right away (names + html_url) — unless `--wait-all` (Codex R2-7: label mode with blocking items expects some guard
checks red and must park only once the OTHERS are green): then failures are recorded and the wait goes on until no identity is
`pending`/`missing`/`stale-skip` (or the deadlines), and the verdict is `failed` listing every failure with the rest's final states; `pending` keeps waiting until `--timeout` ⇒ exit 1 `timeout`; `missing`/`stale-skip`
keep waiting until `--appear-timeout` (measured from command start) ⇒ exit 1 `missing` / `stale-skipped` naming them ("their workflow
did not run on the ready event: re-run it or ask the owner"). Before exit 0 re-read the PR: head moved ⇒ exit 1 `head-moved`; draft
again ⇒ exit 1 `draft`. A draft at start ⇒ exit 2 `draft` ("gh pr ready first"). GitHub read failure: retried next poll; 5 in a row ⇒
exit 3 `github`. Reuse `pipeline/lib/github.mjs` gh-api helpers (keep their handling of gh exit codes with valid JSON).

*Output:* one JSON line `{ok, verdict, head, readyAt, requiredSource, checks:[{name, appId, state, url}]}`; a progress line on stderr
when the waiting set changes.

*Skill §3.2:* replace the bash loop with `P job start ci -- node ~/.claude/pipeline/bin/pipeline.mjs ci-wait --pr N`, then
`P job wait ci --run-id …` repeated until done; non-zero ⇒ read `verdict` (failed → implementer fix; head-moved → back to §3 step 1;
missing/stale-skipped/unverified/no-required-checks → report to the owner). Label mode with a blocking item from 1.5 runs it with
`--wait-all` and parks when the only failures are the expected guard checks. meta.usage + help list it.

*Tests (`test/ci-wait.test.mjs`, captured-shape fixtures):* the Phase 6 race (stale skip, ready run appears at poll 3, pending, pass ⇒
exit 0 only after the pass; assert simulated elapsed time); partial appearance (A pass, B missing ⇒ waits, then `missing` at the
appear deadline); a row that disappears; fresh skip mixed with pending and pass (waits for pending, then exit 0); queued re-run with
null timestamps beats an older success (highest id); same name from two apps (app_id set picks the right one; unset takes worst);
legacy status context pass/pending/failure; pinned identity + success status from a wrong creator ⇒ stays `missing`; check run pass +
status failure on one unpinned name ⇒ `failed`; failure ⇒ immediate `failed`; `--wait-all`: expected-red + pending + pass ⇒ waits for the
pending, verdict lists the failure; head moved; draft again; both sources absent ⇒ `no-required-checks`; classic unreadable + rules
readable (and the reverse) ⇒ `unverified` even when everything reported passes; both unreadable ⇒ `unverified` with config
diagnostics; paginated check-runs (>100) and rules; 5 read failures ⇒ exit 3. Fixtures are CAPTURED shapes (an EW PR head: check-runs,
statuses incl. a re-run, protection, rules) saved under test/fixtures/ci-wait/ with tokens/URLs scrubbed. Plus: a guard status posted
by github-actions[bot] under a 15368 pin ⇒ pass; check-runs on 2 pages ⇒ both pages read. Mutation checks: treat skipped as pass ⇒ the
race test fails; order by startedAt ⇒ the re-run test fails.

## F2. `P merge --dry-run` (owner ruling: no guard change)

Agents want the merge verdict without the owner's "merge". `pipeline merge --pr N --dry-run [--owner-go]` runs the same checks as a
real `P merge` (gate file, resumed-run guard, ownerMerge, behind-base, live `evaluateGate`, owner-go route preconditions) and stops
before anything that writes or merges:
- never calls `bringUpToDate` (it updates the branch): reads behind-ness read-only (PR `mergeStateStatus` BEHIND or the compare API
  head-lacks-base-tip) and reports `behind-base` as a blocker;
- no run record / inFlight write, no `postEvent` (ci-proof-used), no label/comment, no merge command, no files written;
- no shared git state change (Codex R2-4): `evaluateGate` → deferred-proof validation → `baseProofSettings` (finalgate.mjs ~234/372)
  runs `git fetch` and moves `origin/<base>`. Add a `readOnly` option threaded through evaluateGate: in it, the base's proof settings
  are read from the GitHub contents API at the PR's `baseRefOid` (`repos/O/R/contents/.claude/pipeline.yml?ref=<sha>`) — the same
  bytes the fetch would give for that commit — with no git fetch/update-ref/checkout/worktree. Unreadable ⇒ blocker
  `proof-settings-unverified` (never a silent pass). Fable 2: the settings' `ref` (feeds `protectedInputHit` → `diffFiles(ref,
  'HEAD')`, finalgate ~260–266) and `sha` (the proof check's `base`, ~282) are BOTH set to `baseRefOid` in readOnly, never the local,
  possibly stale `origin/<base>`; if `git cat-file -e <baseRefOid>^{commit}` fails locally ⇒ `proof-settings-unverified`. Real `P
  merge` keeps the fetch path unchanged.
- behind-ness (Fable 4): `mergeStateStatus` BEHIND ⇒ `behind-base`; CLEAN/HAS_HOOKS/UNSTABLE/BLOCKED ⇒ then the compare API
  (`gh.compare`, updatebranch.mjs ~105: head lacks base tip ⇒ `behind-base`); `UNKNOWN`/`DIRTY`, or a compare error ⇒ blocker
  `behind-base-unverified` (DIRTY also reported as `conflicts`). Never "not behind" by default.
- collects ALL blockers instead of returning at the first (where the checks are independent), and reports the owner step instead of
  refusing on it, matching the review skill's two hand-off routes (Codex R2 note): `{ok, dryRun:true, wouldMerge, blockers:[{kind,
  detail}], ownerStep}` with `ownerStep` = `null` (low-risk, P merges itself) · `{kind:"say-merge", line}` (the exact `Head … · items …
  · repo …` line, for the no-protected-item route incl. `--owner-go`) · `{kind:"owner-runs", command}` (ownerMerge > 0 /
  protected-area PR under `owner_approval: chat`: the repo's merge.command filled with PR + head, which the owner runs; no request
  line) · `{kind:"owner-approval-flags"}` (resumed / unchecked run record). It grants nothing: the real run re-checks the owner's record.
- exit 0 when wouldMerge (given the owner's word where ownerNeeded), 1 otherwise, 3 GitHub unavailable.
- Tests (`test/merge-dry-run.test.mjs`, existing merge test fakes): clean ⇒ wouldMerge, and the fake gh recorded ZERO write calls
  (update-branch, comments, labels, merge), no file under `.review` changed, the git subprocess spy saw no fetch/update-ref/
  checkout/worktree/push, and `git for-each-ref` output is identical before and after; a deferred-CI config (verify.deferrable_steps)
  reads base settings via the contents API, unreadable ⇒ `proof-settings-unverified`; local `origin/main` BEHIND the PR's baseRefOid ⇒
  the protected-input scan and proof base use baseRefOid (not the stale ref); baseRefOid missing locally ⇒ `proof-settings-unverified`;
  mergeStateStatus UNKNOWN / compare error ⇒ `behind-base-unverified`; behind base ⇒ blocker, no update call;
  ownerMerge > 0 under chat ⇒ `owner-runs` with the filled command and NO request line; clean no-item ⇒ `say-merge` line; failed live check + behind ⇒ both blockers listed; owner-go route; `--dry-run` combined with
  `--owner-approved-head` ⇒ usage error (exit 2). Mutation: let dry-run reach bringUpToDate ⇒ the no-write test fails.
- Review skill: name it where an agent wants a verdict ("never run the repo's merge command to preview; use `P merge --pr N --dry-run`").

## F3. codex-review: save the prompt sent to Codex

`pipeline/commands/codex-review.mjs`: after `buildReviewPrompt` and BEFORE spawning Codex (so a timed-out or crashed round still
keeps it — Fable 6), write `round-<R>/prompt.md` (writeFileAtomic; the round dir is already guard-protected via REVIEW_FILE_SRC) from
the SAME buffer later passed as stdin, and pass `promptSha256` (sha256 of that buffer, not a re-serialisation) into the round record;
`pipeline/lib/state.mjs` `addRound` (~152) must persist the new field (it whitelists fields) and the triage comment encoding must
round-trip it. Older states without it still load. Tests: prompt.md bytes == what the fake Codex received on stdin; the saved state
round carries the matching hash; save → comment-encode → load round-trips it; an old state loads; a high-risk round's prompt.md holds
the attacker brief. `pipeline artifacts` lists prompt.md if it lists round files.

## F4. Owner commands in a `!` shell lack /opt/homebrew/bin

(a) Review skill §3 step 3 + parking text: an owner `gh …` command is written with the absolute gh path, shell-quoted. The agent's
own shell may lack /opt/homebrew/bin too (Fable F4 note), so the fallback dirs (`/opt/homebrew/bin/gh`, `/usr/local/bin/gh`) are the
normal route, not the exception; `command -v gh` only when it answers. (b) `pipeline protect` prints its owner `gh` lines with the resolved
absolute gh path on POSIX (reuse `proc.mjs` `findOnPosixPath` + fallback dirs; Windows unchanged), quoted with protect.mjs's POSIX
`shellWord` (~99) — NOT `escapeArgument`, which is cmd.exe quoting (Codex R2-6). Tests: resolved path used; fallback dir used when PATH
lacks gh; paths with a space, an apostrophe and `$`/`;` survive a real `sh -c` round trip (the printed word, run through sh, names
the same path). (c) README "Owner commands" note.

## F5. Rebalance the Windows CI shards by measured time

Bytes-balanced today; 6 PR runs (11-03/04): shard 2 6–9 min, shards 1/3 14–29 min. Steps:
1. Evidence first (Codex R1): fetch one Windows shard log (`gh run view --log --job <id>`) and check whether the reporter prints a
   per-FILE duration. It is not assumed.
2. Timing source (Codex R2-5: nesting-0 events are top-level TESTS, several per file, and the file wrapper is not reported when
   children are): `scripts/test.mjs` gains an opt-in per-file timing reporter (`scripts/lib/file-times-reporter.mjs`) that records,
   per `event.data.file`, the parent's wall clock (Date.now()) at the FIRST and LAST event of that file and reports the span (covers
   module load, setup/teardown and every top-level test), plus the SUM of nesting-0 durations as a cross-check. Weight = span.
   Verify first with a fixture file holding a 300 ms top-level setup, two top-level tests (200 ms + 100 ms, one async with concurrency)
   and an after-hook: span must be ≥ 600 ms and the two-file run must not overwrite one file with another. If the parent does not
   stream a file's events as they happen (Node buffers them), fall back to `CP_TEST_TIMES` running each file of the shard as its own
   `node --test` and wall-clocking it (used only by the weight-refresh run, never in normal CI). Added next to the default reporter
   when `CP_TEST_TIMES=<path>` is set; output JSON `{file: {spanMs, sumMs}}`. CI's Windows shard step sets it and prints the JSON
   between marker lines at the end of the step (no artifact needed). The installer round trip stays in shard 3 (measured ~0 min).
3. `scripts/shard-weights.mjs <run-id>…` reads those marker blocks from the runs' Windows job logs and writes
   `scripts/lib/test-weights.json` (median ms per file over the runs). First weights: from this PR's own CI runs (two pushes), committed
   in a follow-up commit of this PR.
4. `shardFiles` weight = measured ms when known, else bytes × (median ms/byte of measured files); same deterministic longest-first
   greedy, ties by name. Tests extend `test/test-runner.test.mjs` (where the shard tests live): weights override bytes; unknown file
   fallback; bins partition; deterministic; reporter emits per-file ms for a 2-file fixture.
   BUILD NOTE (11-04): the span reporter did NOT hold on Node 24 (events of a later file are replayed only after earlier files end; enqueue is queue time; summary excludes module load). Built instead: `scripts/lib/file-times-preload.mjs` via `node --import` when CP_TEST_TIMES is set; each test-file child appends its whole wall clock at exit; output `{file:{spanMs}}` (no sumMs). Verified on the plan fixture (slow >= 600 ms, quick >= 140 ms, separate entries).
5. Proof: the shard minutes of the PR's last CI run, reported in the PR body (before/after table).

## F6. Installer: false "Claude Code ancestor" on Windows (#25)

Test side shipped (HOME_LEAF `cp-home`). Product fixes in `pipeline/lib/claude-ancestry.mjs`:
1. PID reuse (Windows only; POSIX re-parents orphans): `realLookup` win32 also returns `created` = CreationDate as integer epoch ms
   (PowerShell `([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()` in the Select, so no locale/timezone string parsing).
   The walk starts by looking up the installer's OWN process (`process.pid`) to get its creation time, then for each parent:
   - the parent IS Claude Code ⇒ refuse, whatever the times (unchanged; a reused PID that lands on Claude itself still refuses —
     fail closed, rare, the message says "close Claude Code or retry");
   - the parent is NOT Claude Code and was created MORE THAN 2 s after its child ⇒ treated as a recycled PID: stop the walk (false).
     This is what #25 hit: the walk passed through a recycled PID into an unrelated chain;
   - missing / non-finite `created` on either side, equal times or a gap ≤ 2 s ⇒ continue as today.
   Clock rollback (Codex R2-1, corrected): Win32 CreationDate is wall-clock based, so a rollback larger than 2 s between a real
   non-Claude parent's start and its child's start would make the walk stop early and miss a Claude Code further up. Windows grants
   changing the system time only to administrators (SeSystemtimePrivilege); NTP slews/steps are far below 2 s in normal operation. Stated
   as a residual in the module comment (same class as the existing "an agent's own client" residuals: needs a deliberate admin
   action). The `CLAUDECODE` environment check is unchanged and still refuses first. Fable to rule on whether this residual is
   acceptable or the rule must fail closed (refuse) on a reversal instead (which would bring #25 back when the recycled PID's chain
   reaches Claude).
2. Argument match (Codex R1-7 — no generic script-position parsing, which would miss `bun run …` / `deno run …` forms): keep every
   `CLAUDE_ARGS` alternative; widen the generic one to accept a closing quote after the name (`[\\/]claude(?:\.exe)?(?=["']?(?:\s|$))`,
   Codex R2-8) so `node "C:\Program Files\x\claude"` is detected; and blank out ONLY the operand of the installer's own `--claude-home`
   flag (`--claude-home X`, `--claude-home=X`, `"…"`-quoted with spaces, or not) before matching, and only when the command line also
   names `install.mjs` as a word. The blanking is a token-level replace of that one operand (quote-aware), never of the runtime's
   script word. Both the `install.mjs` word test and the `--claude-home` operand are evaluated on the quote-aware TOKEN list (Fable 7):
   a `--claude-home` or `install.mjs` inside a quoted token (e.g. a `-p "…"` prompt) neither counts nor blanks the next token. A Claude
   Code process never carries that flag.
   Fable ruling 11-04: ACCEPT the clock-rollback residual (do not fail closed: it would reinstate #25 with no security gain). The module
   comment lists it next to the existing detach/re-parent residuals (POSIX double-fork/setsid re-parents to launchd; on Windows a
   same-user process can set PROC_THREAD_ATTRIBUTE_PARENT_PROCESS) and names the PreToolUse guard that blocks command lines naming
   install.mjs as the primary control; the installer's refusal message keeps pointing at it.
- Tests (`test/claude-ancestry.test.mjs`): reused PID (non-Claude parent created > 2 s later) ends the walk before a Claude further
  up; a reused PID that IS Claude still refuses; 1 s skew continues and detects; normal chain with creation times still detected;
  missing times ⇒ still detected; equal times ⇒ continues; injected clock-rollback chain documents the residual (stops — asserted so a
  later change of the rule is deliberate); the win32 lookup parses the epoch-ms field from a captured PowerShell JSON line;
  `node install.mjs --claude-home C:\x\claude bun run /usr/local/bin/claude`-style mixes: blanking removes only the operand; `node /usr/local/bin/claude`, `bun run /usr/local/bin/claude`,
  `deno run -A /x/claude`, `node "C:\Program Files\x\claude"` and `node …\@anthropic-ai\claude-code\cli.js` detected; `node install.mjs
  --claude-home C:\x\claude` and `--claude-home="C:\x y\claude"` not detected; `node other.mjs --claude-home C:\x\claude` still
  detected (flag only honoured with install.mjs). Closes #25.

## F7 (EW PR). Cancel in-flight runs when a PR goes back to draft

`.github/workflows/e2e.yml`, `checks.yml`, `migration-replay.yml`: add `converted_to_draft` to `pull_request.types`; for that event the
concurrency group is the workflow's REAL per-PR group (so `cancel-in-progress` cancels the running suite) while every job still skips
(draft). e2e.yml's group expression gets the explicit case; header comments ("NO DRAFT EVENT STARTS IT" → "…and converting to draft
cancels a running one"); EW's workflow-label-gates test extended. Independent of the CP PR (no vendoring dependency now F2 is in P).
Through EW's `review` flow.

## Out of scope (owner-only, unchanged)
Two `protect --apply` CLI tests (owner adds), PROMPTS.md protect lines → foundation path (owner edit), eaglewatch-ai-grammar-review.md
size (other session). Hand-off fix 5 (judge model) is observed on the next judged PR.

## Verification
CP: `node scripts/test.mjs <changed test names>` locally (no full local suite); CI is the proof (ubuntu + 3 Windows shards). Codex
review of the CP diff + one recheck before ready. EW: its `review` flow.
