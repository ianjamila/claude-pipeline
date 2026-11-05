# Merge hold: take it at hand-off, honour `hold:queued-behind` (cp PR 2 of EW #1642)

Rev 3 (2026-11-05).
- Rev 2 folded the Codex plan review (session 01a1ab28):
  - B1: owner-go checks holds before its stale refusal, and the lock is cooperative for merge commands that are not hold-aware.
  - B2: the hold is re-checked before every update PUT.
  - B3: the status answer is bound to the requested PR.
  - B4: bounded wait (since dropped, see below).
  - S5: acquisition rule by `ownerStep` kind.
  - S6: the ship skill is out of scope.
- The Codex recheck added: callback refusals propagate through merge step 1b.
- Rev 3 folds the Fable adversarial pass:
  - F9 (cheaper design): NO automatic wait. The session reports the blocker and its expiry, then stops; the owner re-prompts. This also removes F1's unbounded loop.
  - F2: release on leaving the hand-off, via a third key.
  - F3: never touch another PR's hold.
  - F4: the check command must differ from take/release, and the dry run says it runs the check.
  - F5: 5-min check timeout, plus one retry in the skill.
  - F6: a fresh "merge" is needed after any queued-behind refusal.
  - F7: parse the full command output.
  - F8: the wording follows `wouldMerge`.
  - F10: renewal starvation is documented.

Owner-approved follow-up of EagleWatch #1642 (merged ecfb8c17d). That PR added a cooperative merge lock to EagleWatch:
- A `merge-hold` label (90-min TTL). While it is active, every OTHER PR's `npm run merge` refuses.
- A `hold:queued-behind #A` verdict from EagleWatch's merge gate. It means: a stale PR is behind an older hold, so do NOT update this branch until #A merges.

See EW `scripts/lib/merge-hold.mjs`, `scripts/lib/merge-gate.mjs` and `docs/agent-guide/workflow.md`. EW #1687 adds the
machine-readable `npm run merge-hold -- --status <pr> --json`.

The pipeline does not know about the lock yet:

1. The review skill hands the owner a merge request but never takes the hold. Main can move while the owner reads, which makes the waiting PR stale and costs a ~25-min CI round.
2. `P merge` and `P update-branch` can update a branch that EagleWatch said must not be updated. A stale PR fails the owner-go live check `pr-open` with "behind-base …; update the branch" before EW's own command ever runs.
3. A `hold:queued-behind` refusal from the repo's merge command surfaces only as "merge command failed (exit 1)".

## Design

### Config (`pipeline/lib/config.mjs`): three optional keys under `merge`, all three or none
- `merge.hold_command` (`{pr}` required, `{sha}` not allowed). Takes or keeps the hold for PR `{pr}`.
  - EW: `npm run merge-hold -- {pr}`.
  - Exit 0 means the hold is confirmed. 1 means refused or NOT confirmed. Anything else is an error.
- `merge.hold_release_command` (`{pr}` required, `{reason}` required, `{sha}` not allowed). Releases PR `{pr}`'s own hold.
  - EW: `npm run merge-hold -- {pr} --release --reason {reason}`.
  - `{reason}` is filled shell-quoted by the pipeline from fixed texts only (below).
- `merge.hold_check_command` (`{pr}` required, `{sha}` not allowed). READ-ONLY.
  - Its LAST non-empty stdout line is one compact JSON object: `{"pr":N,"blockedBy":[{"number":A,"title":"…","since":"<ISO>","expires":"<ISO>"}]}`. Exit 0.
  - `blockedBy` lists the OTHER PRs' active holds that would block N, oldest first. The provider owns the TTL and the ordering.
  - EW: `npm run merge-hold -- --status {pr} --json`.
  - It must differ from both other commands (F4). A copied take command would make every dry run write a label.
- Absent: behaviour is unchanged for every repo. Unknown keys are still rejected.
- Docs next to the keys must cover:
  - Rollout: the keys need a pipeline version that knows them.
  - Rollback: remove the keys first. That also removes the pipeline-side enforcement, but EW's own gate still enforces.
  - The enforcement statement (below).
  - Renewal starvation (F10): a PR whose hold expires and is renewed goes to the back of the queue. The owner's exits are merging the PR ahead, EW `--release` of that PR, or EW `--ignore-hold`.

### Library `pipeline/lib/merge-hold.mjs` (new, small)
- `HOLD_QUEUED_BEHIND = 'hold:queued-behind'`, equal to EW's constant. A test pins EW's line format.
- `checkHolds({ config, pr, root, env, run })` returns one of:
  - `{ configured:false }`
  - `{ configured:true, ok:true, blockedBy:[…] }`
  - `{ configured:true, ok:false, why }`

  Timeout is 5 min (F5): EW's gh-transient backs off 60/120/240 s on a rate limit. The answer is readable only if:
  - the exit code is 0;
  - the last non-empty stdout line is a non-null object;
  - `pr` is a safe positive integer equal to the requested PR;
  - `blockedBy` is an array of objects, each with a safe positive integer `number` that is not the PR itself (`title`, `since` and `expires` are optional strings or null).

  Anything else is unreadable.
- `takeHold(...)` and `releaseHold({ …, reason })` return `{ configured:false }` or `{ configured:true, confirmed: code===0, code, lines }` (the last 5 lines).
- `queuedBehindFrom(text)` returns `{ prs:[A,…] }` (deduplicated, in order) or `null`. It finds the lines containing `hold:queued-behind` and the `#A` numbers on them. It reads the FULL stdout+stderr of the merge command, not the 30-line display tail (F7).
- `holdGate(...)` returns one of:
  - `null` (not configured, or readable with no blockers);
  - `{ error:'queued-behind', verdict:'hold:queued-behind', blockedBy, doNotUpdate:true, reason }`, where the reason names #A, its title and its expiry in PHT;
  - `{ error:'hold-unreadable', reason }`.

### `P merge`
- **Owner-go path** (`ownerGoMerge`, EW's route):
  - After the host check and BEFORE `evaluateOwnerGo`, run `holdGate`. A refusal is returned as is: exit 1, nothing written, no "update the branch" advice. The approval checks are untouched and still run after it.
  - After the merge command fails and the PR is not merged, `queuedBehindFrom(full output)` maps the failure to the `queued-behind` refusal. MERGED still wins, and auto-merge abandonment still runs first; the refusal carries `commandExitCode` and `autoMergeDisabled`.
- **Gate path** (step 1b):
  - Run `holdGate` BEFORE `bringUpToDate`, and pass it in as `beforeUpdate` (below).
  - A `bringUpToDate` result with outcome `queued-behind` or `hold-unreadable` is returned as THAT refusal, keeping `blockedBy`, `doNotUpdate`, `updated`, `cycles` and `head`. This happens before the generic `behind-base` conversion.
  - The same output mapping applies after a failed merge command.
- **Enforcement statement** (docs and skill): the pipeline-side check is cooperative. A hold placed between the check and the merge command is caught only by a hold-aware merge command (EW's gate re-checks right before `gh pr merge`). A repo that opts in with the default `gh pr merge` command gets the pre-check only.
- **Dry run:**
  - Runs `holdGate` and reports `holds: { readable, blockedBy }` (configured repos only).
  - A `queued-behind` or `hold-unreadable` result is a blocker named `merge-hold`.
  - The usage/summary text says the dry run runs the repo's read-only hold check (F4).

### `P update-branch` and `bringUpToDate`
- `bringUpToDate` gains an optional `beforeUpdate()` callback, called immediately before EVERY `gh.updateBranch` PUT.
  - A non-null return stops the loop with that outcome and preserves `updated` (= cycles > 0), `cycles`, `head` and `startHead`.
  - When the callback is not given, behaviour is unchanged.
- `P update-branch` and `P merge` step 1b pass `holdGate` as `beforeUpdate` when configured. Either outcome exits 1.
- There is no override flag. The owner has EW's `--ignore-hold`.
- Read-then-PUT is not atomic; this is documented.

### `P merge-hold --pr N [--check | --release --reason <code>]` (new command, `pipeline/commands/merge-hold.mjs`)
- **Default:** `takeHold`. Output `{ ok, configured, confirmed, code, lines }`. Not configured gives exit 0 with `{ ok:true, configured:false }`.
- **`--check`:** `holdGate` only, read-only. Exit 0 when there are no blockers; exit 1 on queued-behind or unreadable.
- **`--release --reason <code>`:** `releaseHold`.
  - `<code>` is one of `new-commits`, `parked`, `owner-declined`, `handoff-withdrawn`. It maps to a fixed sentence, so no free text reaches the shell.
- It never merges. It acts only on PR N, the session's own PR.
- Registered in the CLI and in the permission allowlist template like the other `P` commands.

### Skill `skills/review/SKILL.md` (ship is retired and not touched)
- **Take (§3.3).** After the dry run, and only when the dry run has `wouldMerge: true` and `ownerStep.kind` is `say-merge` (with or without areas) or `owner-runs`:
  - run `P merge-hold --pr N`;
  - add one plain-English line to the reply: hold confirmed (other merges pause up to 90 min), or NOT confirmed (say so and continue);
  - keep the ending lines LAST and unchanged.
- **Release (F2).** When the session leaves the hand-off state for PR N, run `P merge-hold --pr N --release --reason <code>`. That is: a new commit is pushed after the hand-off, the PR is parked, or the owner declines or asks for changes. A successful merge needs no release; EW removes the label.
- **Queued behind at merge.** When the owner says "merge" and `P merge` returns `error:'queued-behind'`:
  - tell the owner which PR is ahead and when its hold expires (PHT);
  - do NOT run `P update-branch`;
  - list the owner's options: wait and say "merge" again after #A merges or the hold expires; merge #A; or EW's own release / `--ignore-hold`;
  - stop.
- **Fresh "merge" (F6).** On the next owner prompt, run the dry run again and show the new lines. A "merge" given before the refusal is never reused, so `P merge --owner-go` runs only on a "merge" given after the new lines.
- **Hold ahead at hand-off.** When the hand-off dry run itself shows a `merge-hold` blocker, say so with #A and its expiry, give no merge lines, and stop.
- **Base moved (§3.2).** When `P update-branch` returns `outcome:'queued-behind'`, report it the same way and stop.
- **Unreadable.** On `hold-unreadable` anywhere, retry once after 60 s (F5). If it is still unreadable, tell the owner and stop.
- **Other PRs' holds (F3).** Never release or ignore a hold on any PR other than N. Never use `--ignore-hold`.
- Docs command reference: the three keys, the enforcement statement, rollout/rollback, starvation, and the new command.

### Not in this PR
- `ci-wait` returning `missing` while a matrix aggregator is late. Another session owns it (cp #168, branch agent/ci-wait-late-aggregate).
- Teaching the Bash guard to refuse EW `merge-hold --release` for a PR other than the session's (F3 hardening). FOLLOW-UP.
- The EW side. The `--json` producer is in EW #1687. The three keys go into EW `.claude/pipeline.yml` only AFTER this PR is merged and installed.

## Tests (node:test, `test/`)
- **Config:**
  - all three keys are accepted;
  - a partial set, a missing `{pr}` or `{reason}`, a `{sha}`, an empty value, or a check command equal to take/release is rejected;
  - when the keys are absent, nothing changes.
- **Lib:**
  - a banner followed by a JSON last line parses;
  - each of these is unreadable: non-zero exit, timeout, invalid JSON, null, an array, a missing or mismatched `pr`, a blocker `number` that is not a positive int or equals the PR;
  - `queuedBehindFrom` handles EW's exact stderr line, the line placed after 40 other lines, two `#A`, and `#1400` repeated (deduplicated); unrelated text gives null;
  - the release reason is a fixed sentence and shell-quoted.
- **`P merge`, owner-go path:**
  - hold blocked: refused before `evaluateOwnerGo`; for a stale PR, there is no "update the branch" reason and zero GitHub writes;
  - unreadable: `hold-unreadable`;
  - the merge command prints the queued-behind line on stderr only and exits 1: `queued-behind` with `blockedBy:[1400]` and `autoMergeDisabled` reported;
  - PR MERGED despite that text: reported as merged;
  - a non-matching failure: the generic reason;
  - not configured: unchanged (existing tests stay green).
- **`P merge`, gate path:**
  - blocked before update: zero updateBranch calls;
  - unreadable: refused;
  - first check clear but `beforeUpdate` blocks or becomes unreadable: the exact error (not `behind-base`), blocker metadata kept, zero PUTs, merge command never run;
  - not configured: updates as before.
- **`bringUpToDate` / `P update-branch`:**
  - a hold that appears between cycle 1 and cycle 2: outcome `queued-behind`, `updated:true`, `cycles:1`, exactly one PUT;
  - blocked at entry: zero PUTs, `updated:false`.
- **`P merge-hold`:**
  - take exits 0/1/2 map correctly;
  - not configured: ok with `configured:false`;
  - `--check`;
  - `--release` with each reason code; an unknown code is a usage error.
- **Dry run:**
  - `holds` appears only when configured;
  - a blocked hold is a `merge-hold` blocker;
  - with the check configured, exactly one shell call (the check) and zero `gh` writes.

## Risk
Pipeline core: `P merge`, `P update-branch`, `bringUpToDate`. Every new behaviour is gated on new optional config, so repos without it are unchanged. The only new refusals are fail-closed ones for repos that opted in.
