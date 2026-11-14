# Special rounds and the one-command-at-a-time flow

The old, still valid way to run a round one command at a time (what `P round codex` / `P round publish` chain), and the special cases: an interrupted round (discard-round), `baseOnly`, `resolutionOnly`, `empty-range`, base/head moves, a job that is `lost`, `replaced` or `missing` (reconcile: never discard a round because of `replaced` alone, another session may own it).



## Old rule 5 (jobs by hand)

5. Anything over 2 minutes runs as `P job start <name> -- <command>`, then `P job wait <name> --run-id <runId> --timeout 540`
   until `state` is `done` (`replaced`/`lost` ⇒ start it again once). Read `exitCode` (the command's own code) and the JSON in `tail`.

## Old 2.1 Codex (one command at a time; the substitute path is in substitute.md)

1. **Codex.** base: round 1 `git merge-base origin/<default_branch> HEAD`, later the previous round's `toHead` (`.review/state.json`);
   head: the pushed HEAD; `P state outcome` `nextRound.base` is the base (the merge base when `wholePrOwed`: that round reviews the whole PR). BEFORE every codex-review call run it with `--plan` (same `--pr --round --base --head`) and pass its `expectedEffort` as `--effort`: codex-review refuses any other.
   `P job start codex-rR -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review --pr N --round R --base <base> --head <head> --effort <effort>`,
   then `P job wait codex-rR --run-id <runId> --timeout 540` until `state` is `done` (Old rule 5), and read `exitCode` and the JSON in `tail`. Exit 2 `empty-range`: the "fix" changed no code, go back to step 5. Exit 2 `base-mismatch`: the base is not the one codex-review admits (the previous round's `toHead`, or the merge base for round 1 / a whole-PR round): recompute and rerun. Exit 2 `head-moved`: the PR head moved while Codex ran: recompute the head and rerun. Exit 3 with `substitute.eligible` (a real quota stop, or `reason: withheld`) ⇒ `reference/substitute.md`; not eligible ⇒ rule 2 of SKILL.md.
   An interrupted round (no triage comment yet): `P state discard-round --round R --pr N` before rerunning it.
   `baseOnly: true` (only main merged in): Codex did not run, no items, not counted; it carries the last reviewed result forward.
   `resolutionOnly: true` (a main conflict resolved by choosing lines): a real review of just the resolution, triaged as usual
   (an ACCEPT still needs its fix round) but not counted; `resolutionIneligible: "<reason>"` ⇒ a normal counted round.

## Old 2.5 and 2.6 (publish, fix, outcome)

5. **Publish and fix.** `P comment --pr N --kind triage` FIRST, then `P followups create --round R` for FOLLOW-UP items, then the triage comment again
   (issue links). ACCEPT items: one `implementer` dispatch with `P state show --round R --accepted`; it fixes, adds tests, runs `verify.quick`, commits (same line: return immediately when done; no background work; waits only via `job wait`, max 3);
   push (Rule 8). Then **`P state mark-implemented --ids <ids>`** for each fixed ACCEPT item: `review-complete` refuses an ACCEPT that is not marked, from ANY round,
   and exit 2 `no-code-change` means the fix changed no code (back to the implementer; marking never replaces a fix).
6. **Outcome.** `P state outcome`: `clean` ⇒ leave the loop; `needsHuman` non-empty ⇒ see Rulings; more rounds left ⇒ round R+1 (the Codex fix
   check reviews only what changed since this round's head); none left ⇒ park, cause `unresolved: <ids>`, except one case: `reachedMax`, no
   `extraRound`, `owner_approval: chat`, and the fixes are pushed and `verify.quick` is green ⇒ ask the owner for one more round (Extra round, below): the ask shows rounds, booked cost and open-item severity, and when only low-severity fixes are left it recommends filing them as follow-ups instead (`reference/owner-merge.md`, Follow up instead of a round). Label mode ⇒ park.
