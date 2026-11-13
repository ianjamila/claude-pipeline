# review — Rule 8 (`P redraft`) outcomes

Read by the `review` skill (`skills/review/SKILL.md`, Rule 8) before a push to a READY PR whose `P redraft` did not answer a plain exit 0. Rule 8: before ANY `git push` to a READY PR (fix, settle test, owner override build, docs-exempt row, conflict resolution, owner-requested change), `P redraft --pr N --before-push` first (`--reason ci-failed` for a CI-red fix). It releases the merge hold and, with `ci.draft_while_iterating`, turns the PR to draft so CI waits; 3.2 marks it ready again.

## Order

Commit the fix, then `P redraft --pr N --before-push`, then `git push`. `--before-push` refuses (exit 1, `nothing-to-push`, nothing released or changed) when your checkout's HEAD is the PR head or already part of it: there is nothing to push, so do not push and do not redraft. A rebase or amend (diverged HEAD) or a new commit on top proceeds. `beforePushUnchecked: true` (checked-out branch is not the PR's, or the commits could not be compared) means the check was skipped: carry on.

## Outcomes

- `not-open` / `merge-in-progress` ⇒ don't push, tell the owner. `head-moved` (exit 1: the PR head changed while redraft ran) ⇒ don't push; find out who moved it, then run `P redraft` again on the new head.
- Exit 0 with `autoMergeDisabled: true` ⇒ the PR is now a draft: don't push, tell the owner their merge was cancelled, wait for their word. This also covers an already-draft PR whose leftover armed auto-merge redraft just cancelled.
- `autoMergeDisabled: false` ⇒ auto-merge is STILL armed: don't push or mark ready until the owner disables it by hand (they run `gh pr merge N --disable-auto`) and it is confirmed off: tell them, then wait for their word.
- `approvalVoided: true` (a warning) ⇒ an approval label on this head will not survive the fix push: after the PR is ready again, tell the owner to re-apply it. It never stops the push.
- Exit 3 with `stage:read` ⇒ retry once, then don't push, tell the owner.
- Exit 3 with `stage:convert`: the conversion could not be confirmed, so it may still land. `outcome: convert-unconfirmed` (still ready after three re-reads) or `unknown` (the re-read failed) ⇒ do NOT push: run `P redraft --pr N` again (it is idempotent; a later run sees the draft and settles any armed auto-merge), and if it stays unconfirmed tell the owner.
- Exit 0 with `outcome: reconciled-converted` ⇒ the conversion's answer was lost but a re-read shows the draft on the same head: push (unless `autoMergeDisabled` is present, see above).
- Exit 1 with `convert-failed` ⇒ GitHub refused the conversion and a fresh read shows the PR open, ready, on the same head, with no merge-queue entry and no armed auto-merge: only then push anyway and say so. Any other state seen on that read is one of the outcomes above (`merge-in-progress` and the like): follow it.
- A `warnings` line saying the hold release was NOT released (it was tried twice) ⇒ run the `merge-hold --release` command it names from the PR's own worktree before the push, or tell the owner.

## A push that went out WITHOUT redraft

Run plain `P redraft --pr N` right after it (`converted_to_draft` cancels the running suite, so most of the wasted run is saved). Not `--before-push`: your HEAD already equals the PR head, so it would refuse with `nothing-to-push`.

## Not yours

Pushes the pipeline makes itself (`update-branch`, `P merge` catch-ups) are not yours.

## Exception

No `P redraft` on a queue-removed removal itself or the re-queue of the SAME head (a draft makes `P merge` refuse it; `reference/owner-merge.md`); only the fix push after it follows Rule 8.
