# Merge hold: take it at hand-off, honour `hold:queued-behind` (cp PR 2 of EW #1642)

Rev 2 (2026-11-05): Codex plan review (session 01a1ab28) folded: B1 owner-go checks holds before its stale refusal and the
lock is cooperative for non-hold-aware merge commands; B2 hold re-checked before every update PUT; B3 status bound to the
requested PR; B4 the wait polls hold status, bounded; S5 acquisition rule by ownerStep kind; S6 ship skill out of scope.
Recheck folded: callback refusals propagate through merge step 1b (not `behind-base`); a dry-run hold blocker uses the same wait.

Owner-approved follow-up of EagleWatch #1642 (merged ecfb8c17d), which added a cooperative merge lock to EagleWatch:
a `merge-hold` label (90-min TTL) that makes every OTHER PR's `npm run merge` refuse while it is active, and a
`hold:queued-behind #A` verdict from EagleWatch's merge gate meaning "a stale PR behind an older hold: do NOT update
this branch until #A merges" (EW `scripts/lib/merge-hold.mjs`, `scripts/lib/merge-gate.mjs`, `docs/agent-guide/workflow.md`).
The pipeline does not know about either yet:

1. The review skill hands the owner a merge request but never takes the hold, so main can move (and make the waiting PR
   stale — a ~25-min CI round) while the owner reads.
2. `P merge` / `P update-branch` can update a branch that EagleWatch said must not be updated (a stale PR fails the owner-go
   live check `pr-open` with "behind-base …; update the branch" before EW's own command ever runs), and a
   `hold:queued-behind` refusal from the repo's merge command surfaces only as "merge command failed (exit 1)".

## Design

### Config (`pipeline/lib/config.mjs`) — two optional keys under `merge`
- `merge.hold_command` (string, must contain `{pr}`, no `{sha}`): takes/keeps the hold for PR `{pr}`. EW: `npm run merge-hold -- {pr}`.
  Exit 0 = hold confirmed; 1 = refused / NOT confirmed; anything else = error (EW's contract).
- `merge.hold_check_command` (string, must contain `{pr}`, no `{sha}`): READ-ONLY. Its LAST non-empty stdout line is one
  compact JSON object `{"pr":N,"blockedBy":[{"number":A,"title":"…","since":"<ISO with offset>","expires":"<ISO with offset>"}]}`,
  exit 0. `blockedBy` = OTHER PRs' active holds that are older than N's own (the provider owns the TTL and ordering; the
  pipeline never recomputes expiry). EW: `npm run merge-hold -- --status {pr} --json` (added in the EW follow-up PR).
- Both keys or neither: one without the other is a config error (a check with no take, or a take nobody honours).
- Absent ⇒ behaviour unchanged for every repo. Unknown-key rejection stays.
- Rollout / rollback (docs): the keys need a pipeline version that knows them (older versions reject the config). Rolling
  the pipeline back means removing the keys first, which also removes the pipeline-side enforcement (EW's own gate still enforces).

### Library `pipeline/lib/merge-hold.mjs` (new, small)
- `HOLD_QUEUED_BEHIND = 'hold:queued-behind'` (equals EW's constant; a test pins the EW line format).
- `checkHolds({ config, pr, root, env, run })` → `{ configured:false }` | `{ configured:true, ok:true, blockedBy:[…] }` |
  `{ configured:true, ok:false, why }`. 60 s timeout. Validation: exit 0; last non-empty stdout line parses as a non-null
  object; `pr` is a safe positive integer EQUAL to the requested PR; `blockedBy` is an array of objects with a safe positive
  integer `number` ≠ pr (title/since/expires optional strings). Anything else ⇒ `ok:false` (unreadable).
- `takeHold({ config, pr, root, env, run })` → `{ configured:false }` | `{ configured:true, confirmed: code===0, code, lines }` (last 5 lines).
- `queuedBehindFrom(text)` → `{ prs:[A,…] }` (deduplicated, in order) or `null`: lines containing `hold:queued-behind`, the
  `#A` numbers on them. Works on stdout+stderr combined.
- `holdGate({ config, pr, root, env, run })` → `null` (not configured, or readable with no blockers) | a refusal
  `{ error:'queued-behind', verdict:'hold:queued-behind', blockedBy, doNotUpdate:true, reason }` | `{ error:'hold-unreadable', reason }`.
  One helper so merge, update-branch and dry run word it the same.

### `P merge`
- **owner-go path** (`ownerGoMerge`, EW's route), after the host check and BEFORE `evaluateOwnerGo`: `holdGate`; a refusal is
  returned as is (exit 1, nothing written, no "update the branch" advice). Approval checks are untouched and still run after it.
  After the merge command fails and the PR is not merged (MERGED still wins, auto-merge abandonment still runs first),
  `queuedBehindFrom(commandOutput)` ⇒ the `queued-behind` refusal (with `commandExitCode`, `autoMergeDisabled`) instead of the generic failure.
- **gate path** (step 1b): `holdGate` BEFORE `bringUpToDate`, and passed as `beforeUpdate` (below). A `bringUpToDate` result
  whose outcome is `queued-behind` / `hold-unreadable` is returned as THAT refusal (error, `blockedBy`, `doNotUpdate`, `updated`,
  `cycles`, `head`) BEFORE the generic `behind-base` conversion at merge.mjs:125. Same output mapping after a failed merge command.
- **Enforcement statement (docs + skill):** the pipeline-side check is cooperative: a hold placed between the check and the
  merge command is caught only by a hold-aware merge command (EW's gate re-checks right before `gh pr merge`). A repo that
  opts in with the default `gh pr merge` command gets the pre-check only. Documented next to the keys.
- **dry run**: `holdGate` result added as `holds: { readable, blockedBy }` (configured only). A `queued-behind` or
  `hold-unreadable` refusal IS a blocker in the dry run (the real merge would refuse), named `merge-hold`.

### `P update-branch` and `bringUpToDate`
- `bringUpToDate` gains an optional `beforeUpdate()` callback, called immediately before EVERY `gh.updateBranch` PUT (every
  cycle). A non-null return stops the loop with that outcome (`queued-behind` / `hold-unreadable`), preserving `updated`
  (= cycles > 0), `cycles`, `head`, `startHead`. Not given ⇒ unchanged.
- `P update-branch` and `P merge` step 1b pass `holdGate` as `beforeUpdate` when configured. Exit 1 on either outcome.
  No override flag (the owner has EW's `--ignore-hold`). Read-then-PUT is not atomic: documented.

### `P merge-hold --pr N [--check] [--wait --timeout-minutes M]` (new command, `pipeline/commands/merge-hold.mjs`)
- Default: `takeHold`; output `{ ok, configured, confirmed, code, lines }`; not configured ⇒ exit 0 `{ ok:true, configured:false }`.
- `--check`: `holdGate` only, read-only; exit 0 no blockers, 1 queued-behind / unreadable.
- `--wait`: poll `checkHolds` every 60 s until a readable answer with no blockers (exit 0, `{ cleared:true, waitedMinutes }`).
  Stops with exit 1 on: 3 unreadable answers in a row (`hold-unreadable`), the requested PR no longer OPEN (`not-open`),
  or the timeout (default 100 min = TTL + margin; max 180) (`timeout`, last blockers named). Expiry, removal, a closed
  blocker and a replacement blocker are all just "the next answer" from the provider. Meant to run as `P job start`.
- Never merges, never releases. Registered in the CLI and the permission allowlist template like the other `P` commands.

### Skill `skills/review/SKILL.md` (ship is retired: not touched)
- §3.3, after the dry run and BEFORE the reply: when `P config` shows `merge.hold_command` AND the dry run's
  `ownerStep.kind` is `say-merge` (with or without areas) or `owner-runs`, run `P merge-hold --pr N` and add one plain-English
  line (hold confirmed: other merges pause up to 90 min / NOT confirmed: say so and continue). Never for `owner-approval-flags`,
  a dry run whose blockers are anything but owner authorization, or a park. The ending lines stay LAST, unchanged.
- §3.3 owner says "merge" and `P merge` returns `error:'queued-behind'`: tell the owner which PR is ahead, do NOT run
  `P update-branch`, `P job start holdwait -- … merge-hold --pr N --wait`, wait for it; `cleared` ⇒ run the dry run again and
  show the new lines (the branch may now be stale: the usual update → CI → hand-off route, which takes the hold again);
  exit 1 ⇒ tell the owner the reason and stop. `hold-unreadable` ⇒ tell the owner, stop.
- §3.2 "Base moved ⇒ `P update-branch`": an `outcome:'queued-behind'` ⇒ the same wait.
- §3.3 the hand-off dry run itself shows a `merge-hold` blocker: readable (`queued-behind`) ⇒ tell the owner which PR is
  ahead and run the same bounded wait, then repeat §3.2's readiness (CI) and the dry run before the hand-off; unreadable ⇒
  tell the owner and stop.
- docs command reference: the two keys, the enforcement statement, rollout/rollback, the new command.

### Not in this PR
- `ci-wait` returning `missing` while a matrix aggregator is late: owned by another session (cp #168, branch
  agent/ci-wait-late-aggregate).
- EW side: `--status <pr> --json` in EW `scripts/merge-hold.mjs` (EW follow-up PR, producer of the contract above) and the
  two keys in EW `.claude/pipeline.yml` — only AFTER this PR is merged and installed.

## Tests (node:test, `test/`)
- config: both keys accepted; one without the other, missing `{pr}`, containing `{sha}`, empty ⇒ rejected; absent ⇒ unchanged.
- lib: banner + JSON last line parsed; non-zero exit, timeout, invalid JSON, null, array, missing/mismatched `pr`, blocker
  `number` not a positive int or equal to pr ⇒ unreadable. `queuedBehindFrom`: EW's exact stderr line, two `#A`, repeated
  `#1400` deduped, unrelated text ⇒ null.
- `P merge` owner-go: hold blocked ⇒ refused before `evaluateOwnerGo` (stale PR: no "update the branch" reason, zero GitHub
  writes); unreadable ⇒ `hold-unreadable`; merge command prints the queued-behind line on stderr only, exit 1 ⇒
  `queued-behind` with `blockedBy:[1400]`; PR MERGED despite that text ⇒ merged; non-matching failure ⇒ generic reason;
  not configured ⇒ unchanged (existing tests stay green).
- `P merge` gate path: blocked before update ⇒ zero updateBranch calls; unreadable ⇒ refused; not configured ⇒ updates as before;
  first check clear but `beforeUpdate` blocks / becomes unreadable ⇒ exact error `queued-behind` / `hold-unreadable` (not
  `behind-base`), blocker metadata kept, zero PUTs, merge command never run.
- owner-go queued-behind from the merge command with auto-merge abandonment: `autoMergeDisabled` reported on the new refusal.
- `bringUpToDate` / `P update-branch`: hold appears between cycle 1 and cycle 2 ⇒ outcome `queued-behind`, `updated:true`,
  `cycles:1`, exactly one PUT; blocked at entry ⇒ zero PUTs, `updated:false`.
- `P merge-hold`: take exit 0/1/2 mapping; not configured ⇒ ok/configured:false; `--check`; `--wait` with a fake clock:
  cleared after 2 polls, 3 unreadable ⇒ exit 1, PR closed ⇒ `not-open`, timeout names last blockers.
- dry run: `holds` only when configured; a blocked hold is a `merge-hold` blocker; dry run still writes nothing.

## Risk
Pipeline core (`P merge`, `P update-branch`, `bringUpToDate`). Every new behaviour is gated on new optional config, so repos
without it are unchanged; the only new refusals are fail-closed ones for repos that opted in.
