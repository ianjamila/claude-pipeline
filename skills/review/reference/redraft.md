# review — Rule 8 (`P redraft`) outcomes

Read by the `review` skill (`skills/review/SKILL.md`, Rule 8) before a push to a READY PR whose `P redraft` did not answer a plain exit 0. Rule 8: before ANY `git push` to a READY PR (fix, settle test, owner override build, docs-exempt row, conflict resolution, owner-requested change), `P redraft --pr N` first (`--reason ci-failed` for a CI-red fix). It releases the merge hold and, with `ci.draft_while_iterating`, turns the PR to draft so CI waits; 3.2 marks it ready again.

## Outcomes

- `not-open` / `merge-in-progress` ⇒ don't push, tell the owner.
- Exit 0 with `autoMergeDisabled: true` ⇒ the PR is now a draft: don't push, tell the owner their merge was cancelled, wait for their word.
- `autoMergeDisabled: false` ⇒ auto-merge is STILL armed: don't push or mark ready until the owner disables it by hand (they run `gh pr merge N --disable-auto`) and it is confirmed off: tell them, then wait for their word.
- Exit 3 with `stage:read` ⇒ retry once, then don't push, tell the owner.
- Exit 3 with `stage:convert` / `convert-failed` ⇒ retry once, then push anyway and say so.

## A push that went out WITHOUT redraft

Run `P redraft --pr N` right after it (`converted_to_draft` cancels the running suite, so most of the wasted run is saved).

## Not yours

Pushes the pipeline makes itself (`update-branch`, `P merge` catch-ups) are not yours.

## Exception

No `P redraft` on a queue-removed removal itself or the re-queue of the SAME head (a draft makes `P merge` refuse it; `reference/owner-merge.md`); only the fix push after it follows Rule 8.
