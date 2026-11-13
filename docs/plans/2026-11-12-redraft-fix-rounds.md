# Plan: back to draft before fix pushes on a ready PR (`pipeline redraft`)

Date: 2026-11-12 · Branch `agent/redraft-fix-rounds` · Risk: pipeline core (review skill + new command), Fable lane.
Owner decisions (2026-11-12): new command + skill steps (not skill text alone); Codex + Fable plan review before building.
Plan review: Codex plan review failed 3× (gpt-6-astra "model is at capacity"); owner chose the Fable pass alone. Fable: SOUND WITH
FIXES, no P0; its 13 findings are folded in below (marked F1–F13).

## In plain English

When a pull request that is already marked "ready" gets more fixes pushed (CI found a real bug, the owner asked for one more
review round, the owner objected to a ruling, the merge queue threw it out over a bug), every fix push today re-runs the repo's
full CI suite (EagleWatch: ~38 min on GitHub-hosted runners), often several times before review is clean. This change puts the PR
back to draft right before the first such push, so the heavy workflows (which skip drafts, and cancel a running suite when a PR
turns draft) stay quiet until review is complete; the existing "mark ready" step then runs the suite ONCE on the reviewed head.
Estimate: up to ~$100/month on EagleWatch.

## Facts the design rests on (verified 2026-11-12; Fable re-checked)

- `ci.draft_while_iterating` exists in the schema (`pipeline/lib/config.mjs:60,164,720`, `pipeline/templates/pipeline.yml:50`) but
  **no code reads it**. EagleWatch sets it `true` ("the heavy workflows skip drafts"), DRMed and claude-pipeline `false`. It becomes
  the switch: no new key, no consumer-repo change, no rollout ordering.
- EagleWatch checks.yml / datetime-webkit.yml / embed-probe.yml list `converted_to_draft` and share one concurrency group per PR, so
  converting to draft CANCELS a running suite; every job skips a draft.
- `ci-wait` measures from the NEWEST `ready_for_review` event (`pipeline/lib/ci-wait.mjs:132-139`): ready → draft → ready works, also
  on an unchanged head. A PR turned draft during a wait ends it with `draft` (:389/:392/:504).
- `review-complete` on a draft refuses `behind-base` and remedies it before `gh pr ready` (`review-complete.mjs:137-184`, called :254);
  for a draft the guard nudge is `recheck: 'on-ready'` (:290), and `gh pr ready` starts the guards (template
  `pipeline-guards.yml:44`).
- `P merge` refuses a draft at the gate and right before the merge command (`pipeline/lib/finalgate.mjs:192,1159`).
- EagleWatch merge hold (`scripts/lib/merge-hold.mjs`): a draft holder is ignored (:81-83); a take on a draft is refused (:258-259);
  release works from the PR's own branch. Pipeline release reasons are fixed codes → fixed sentences (`pipeline/lib/merge-hold.mjs:27-37`).
- Conditional (F3): once EagleWatch #1837 merges, e2e.yml no longer runs E2E on `synchronize`, so a fix push to a READY PR would get
  no E2E on the new head; re-readying restores it. The design does not rest on this.

## The command — `pipeline redraft --pr N [--reason CODE] [--repo DIR]`

File `pipeline/commands/redraft.mjs` (auto-discovered), same anatomy as `merge-hold.mjs`. Meaning: "I am about to push a code fix to
this PR; take it out of the hand-off". Added to `LEASED_COMMANDS` (`pipeline/lib/review-lease-wiring.mjs`) like merge-hold /
update-branch (F8). Steps in order:

1. Read: `prView(N, ['number','state','isDraft','headRefOid','autoMergeRequest'])` (array form, F10); queue mode via `queueModeFor` and,
   when on, `queueState(N)`. Any GitHub read failure, including `QueueUnreadable`, ⇒ exit 3 `{ok:false, unavailable:true}`, nothing
   changed (fail closed, F10).
2. Refuse, exit 1, nothing changed:
   - `state` not OPEN ⇒ `reason:'not-open'`.
   - `merge-in-progress` (F4) when ANY of: a `mergeQueueEntry`; a non-null `autoMergeRequest`; a local merge in progress for this PR
     (`mergeInProgress({gh, pr, env})`, `pipeline/lib/hold.mjs:203-231`); a live local queue record (`readQueueRecord`,
     `pipeline/lib/merge-queue.mjs:110`). The owner's merge is under way: do not push, tell the owner.
3. Merge hold, when `holdsConfigured(config)`: release with `--reason` (default `redraft`, new code; validated against
   `RELEASE_REASONS`, unknown ⇒ exit 2). This runs for a ready PR, and ALSO for an already-draft PR (F7: a hold left by an earlier
   unconfirmed release would otherwise come back to life, with its old timestamp, at `gh pr ready`), EXCEPT when the head is the
   pipeline's own successor (reuse the `ownSuccessor` check from `pipeline/lib/merge-hold.mjs` ~:289). Result `holdRelease:
   {reason, confirmed, code, lines, notStarted?}`; not confirmed ⇒ still exit 0 with a `warnings` entry naming the manual release
   (same wording helper as `update-branch`'s `unreleasedWarning`). Release before converting: if conversion then fails, the PR has
   still left the merge line (the safe side).
4. Conversion, only when `config.ci.draft_while_iterating === true` and the PR is ready: new `createGitHub` method
   `convertToDraft(n)` = `prNodeId(n)` (`pipeline/lib/github.mjs:366`) + GraphQL `convertPullRequestToDraft` returning
   `pullRequest { isDraft autoMergeRequest { enabledAt } }` (F10: one call, through `guardGh` and the fake gh, no gh-version
   dependency, no read-after-write lag). `isDraft` not true ⇒ exit 1 `reason:'convert-failed'`; mutation error ⇒ exit 1 with its
   message (`convert-failed`); unreachable ⇒ exit 3. If the answer shows `autoMergeRequest` non-null (armed between read and convert),
   call the existing disable-auto-merge path (`finalgate.mjs` ~:1227 / `disablePullRequestAutoMerge`) and report `autoMergeDisabled`.
   `false` ⇒ no conversion: `skipped:'draft-not-iterating'` (the repo's CI runs on drafts; a draft would save nothing).
5. Output, exit 0: `{ok:true, pr, head, wasDraft, draft, changed, skipped?, holdRelease?, autoMergeDisabled?, warnings:[]}`.

`pipeline/lib/merge-hold.mjs` gains `redraft: 'The PR went back to draft for more fixes, so its merge hold is released until it is
ready again.'`

### Advisory in `codex-review` (F13, in scope)

When `codex-review` starts a COUNTED round (not baseOnly / resolutionOnly) for an iterating repo and the PR is READY (it already reads
the PR, or one extra `prView`), its JSON gains `warnings: ["PR #N is ready: run \`pipeline redraft --pr N\` now ..."]` (key
`redraftAdvice: true`). A late redraft still cancels the running suite via `converted_to_draft`. Read failure ⇒ no advice, never a
failure.

## Skill changes (`skills/review/`)

Constraints from parity tests (F1): `SKILL.md` is capped at 160 lines (`test/skills-commands.test.mjs:141-142`; 159 today) and the
FIRST occurrence of the literal `gh pr ready N` must come after `codex-review` and `review-complete --pr N` (:163-171). So:

- **Rule 8, exactly ONE line, no literal `gh pr ready N`**: "Before ANY `git push` you make to a READY PR (fix, settle test, owner
  override build, docs-exempt row, conflict resolution, owner-requested change): `P redraft --pr N` first; it releases the merge hold
  and, with `ci.draft_while_iterating`, turns the PR to draft so CI waits; 3.2 marks it ready again. `merge-in-progress` ⇒ don't
  push, tell the owner; exit 3 / `convert-failed` ⇒ retry once, then push anyway and say so." Pushes the pipeline makes itself
  (`update-branch`, `P merge` catch-ups) are not yours and never redrafted (F5).
- All other edits inline on existing lines (no new lines):
  - 2.5 "push" ⇒ "push (Rule 8)".
  - 3.2 `failed` verdict (F2): keep the existing `P merge-hold --release --reason ci-failed` at the verdict (a flake is re-run, not
    pushed, and must not re-run the whole suite); the implementer fix's push follows Rule 8 with `--reason ci-failed`. Add the
    `draft` verdict to the list (F11): "`draft` ⇒ the PR is a draft: `gh pr ready` was skipped or undone; mark it ready, start
    ci-wait again".
  - 3.2 hold text (F6) ~:143-144: "`new-commits` … run it on every push" ⇒ "after a push Rule 8 already released it; `new-commits` is
    for a push made without `P redraft`".
  - Rulings: "owner objects ⇒ re-rule ACCEPT, fix it" and "tighten your own dismissal" (F5): append "(Rule 8)".
  - 3.1 "Any later commit that changes the code needs another round": append "(Rule 8)".
- **reference/owner-merge.md**: Extra round (~:20 "commit and push the fixes") ⇒ "(Rule 8 first)"; Owner override "an ACCEPT is built"
  (~:13-14) ⇒ Rule 8; queue mode `queue-removed` (F2): NO redraft on removal (the owner may re-queue the SAME head after a second
  removal; a draft would make `P merge` refuse); only "fix → new head" follows Rule 8; merge-hold list of reasons (~:56) gains
  `redraft` and the `new-commits` sentence is reconciled as in 3.2 (F6).
- Not changed: `update-branch` / behind-base catch-ups, queue-mode merge jobs, ci-wait.

## Docs and template

- `docs/cli.md`: intro list + `## redraft` block holding `meta.usage` VERBATIM (`test/cli.test.mjs:77-84`); re-copy the `## merge-hold`
  usage block (new reason) and the codes listed by hand at ~:365 (F9); `## codex-review` if its usage text changes.
- `pipeline/templates/pipeline.yml:50` + the config reference doc: what `draft_while_iterating: true` now does, and when to set it
  (every heavy required workflow skips drafts and lists `converted_to_draft` in its pull_request types / shares the PR concurrency group).
- `skills/pipeline-setup`: where it audits CI, set `draft_while_iterating: true` only under that condition (grep first; match wording).

## Tests

`test/redraft.test.mjs` (fake gh `test/helpers/fakegh-env.mjs`, hold shell seam as in `test/merge-hold-command.test.mjs:258-268`):
1. Ready + iterating + holds ⇒ release (redraft sentence) BEFORE the convert mutation; exit 0 `changed:true, draft:true`.
2. `--reason ci-failed` ⇒ ci-failed sentence. Unknown reason ⇒ exit 2.
3. Already draft + holds ⇒ release runs, no mutation, `changed:false`; already draft with own-successor head ⇒ no release.
4. Not iterating ⇒ release runs, no mutation, `skipped:'draft-not-iterating'`.
5. Holds not configured ⇒ no release; conversion happens.
6. Closed / merged ⇒ exit 1 `not-open`, no writes.
7. merge-in-progress, each trigger: queue entry; auto-merge armed; local `mergeInProgress`; live queue record ⇒ exit 1, no writes.
8. Mutation answers isDraft false ⇒ `convert-failed`; mutation error ⇒ `convert-failed`; read failure / QueueUnreadable ⇒ exit 3.
9. Release not confirmed ⇒ exit 0, `holdRelease.confirmed:false`, warning; conversion still done.
10. Auto-merge armed in the answer ⇒ disabled, `autoMergeDisabled:true`.
11. Lease: `redraft` in `LEASED_COMMANDS`; update the pinned list `test/review-lease-wiring.test.mjs:88-92`.
12. `merge-hold`: `redraft` accepted; update pinned literals `test/merge-hold-command.test.mjs:18,98` (F9).
13. `codex-review` advisory: ready PR + iterating + counted round ⇒ warning; draft, not iterating, baseOnly, read failure ⇒ none.
14. Skill parity: `test/skills-commands.test.mjs` (line cap, order, every cited `P` flag in usage) and `test/cli.test.mjs` green.

## Verify

`node scripts/verify.mjs --quick` after each task; CI (Linux + Windows) is the full proof.

## Rollout

Owner merges → owner reinstalls. EagleWatch (already `true`) gets the behaviour in new sessions; DRMed / claude-pipeline (`false`) get
only the hold release on push paths. No consumer-repo PR.

## Risks and how they fail

- Session forgets to re-ready ⇒ PR sits in draft; 3.2's `gh pr ready` after `review-complete` is unchanged and `P merge` refuses a
  draft (`finalgate.mjs:192,1159`): the hand-off waits, nothing merges unreviewed. The `codex-review` advisory catches a missed redraft.
- Redraft while ci-wait runs ⇒ wait ends `draft`; the skill only redrafts at a push, after the verdict; 3.2 handles `draft`.
- A repo setting `true` whose CI does not skip drafts ⇒ one duplicate suite at re-ready (no worse than today); docs state the condition.
- "CI once" is best effort on a busy main (F12): a redrafted PR often hits `behind-base`; the remedy `P update-branch` runs the hold
  gate (`pipeline/lib/merge-hold.mjs:209-214`) and may wait `queued-behind`, and a draft cannot take a hold in EagleWatch, so main
  can move again during the single CI run (then the usual base-moved path applies).
- Concurrent sessions on one PR ⇒ unchanged exposure; redraft never moves the head; the lease covers the command.

## Out of scope (suggestions)

- Template `verify.yml` / `pipeline-guards.yml` could skip drafts and list `converted_to_draft`, so new repos can turn the switch on.
