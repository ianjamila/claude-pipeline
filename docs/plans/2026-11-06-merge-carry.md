# Merge-carry: the owner's "merge" survives updates that only merge main (2026-11-06)

Full design and review record: `~/claude-notes/plans/2026-11-05-merge-survives-main-reviewed.md` (sections 8, 12 to 14). This note is the
short version that ships with the code.

## What and why

On `--owner-go`, the owner's "merge" is bound to one head. When main moves while CI or the owner's reply is pending, the branch is behind
again, the head changes on update, and the owner has to say "merge" a second time for a change that touched nothing of theirs. Merge-carry
lets the go for head H0 cover updates of H0 that ONLY merge main in, and nothing else.

## Consent (what the owner sees)

- The request block starts with `Carry: also covers main-only updates (clean merges of main, no other change)` (`CARRY_LINE`), directly
  above its first line (Rulings / Areas / Hold / Head), and its Head line shows at least 16 hex (`CARRY_MIN_HEAD`).
- `merge --dry-run --owner-go` hands that over as `ownerStep.carry` plus `ownerStep.line`. It is offered only for `owner_approval: chat`,
  no eligible needs-human hold, github.com. `ownerStep.path` is `as-is` (passes at H0 now) or `needs-update` (the only blockers are the
  behind-base ones, moved to `updateFirst`, `wouldMerge` true). `carryNote` says so in one sentence; the eventual path is never promised.
- The recorder (`presentedRequests`) sets `carry: true` on the one request of a one-PR block with the line directly above it; any other
  placement is prose and binds nothing. A held PR never carries (C12).

## Proof rules

- `lib/approval-carry.mjs` accepts a new head only when the first-parent chain from H0 (at most 10 steps) is nothing but clean merges of the
  protected branch that GitHub made (verified, committer `noreply@github.com`), checked in a throwaway bare repository with pinned merge
  settings (in-tree merge attributes refuse), against GitHub's fresh `baseRefOid`, with no replace refs / grafts / shallow history. The
  prefix of the owner's recorded head must be at least 16 hex. Anything else is `carry-proof` and the go is void.
- The final phase re-makes the proof against the scan's own base, runs the complete `--owner-go` evaluation (every check, the review, CI on
  that head) and the approval check, then merges pinned to the head.
- F2: for `--owner-go`, `pr-open` compares the PR's base with GitHub's default branch, never the PR-editable `config.default_branch`; a
  gh answer without a default branch fails closed.

## The loop (`lib/owner-go-carry-loop.mjs`, run as a job)

Entered only when the live evaluation at H0 fails for being behind alone (`behindOnly`) and the record for H0 carries the line. At most 3
cycles; per cycle: hold / label / merge-hold / default-branch checks, one GitHub update, fetch and proof, fast-forward of the checkout (owned
by the job, `lib/merge-job.mjs`; the git guard refuses other branch-changing git in it), config reload, review refresh (`--base-only` round and
review-complete, never a real review), CI for exactly that head, final phase under the review lock. A base that moves during the wait starts
the next cycle. Refusals carry `goVoid` (true: show a fresh request; false: the go stands, retry later) and `carry` stats.

## Residuals (accepted)

- F11: between the proof and the merge command GitHub could change the head again; the merge is pinned to the proved head
  (`--match-head-commit`), the base is pinned while waiting, so such a change refuses instead of landing.
- A fork PR cannot be updated by the token (GitHub refuses): the loop stops with `carry` and the go stands.
- Terminal cases (a dead job, a closed or merged PR, auto-merge that cannot be confirmed off) stop with a plain-English note; a dead job's
  claim on the checkout is reconciled with GitHub by the next run before anything is updated.
- The review refresh carries only a pure main merge; main changing the rules that judge the PR (protected paths, hard stops) changes the
  owner items, the go is void and the owner is asked again (X1).

## What stays exact-head

The gated route (`--owner-approved-head` / `--owner-approved-items` plus the owner-go record) and the direct-merge guard (a `gh pr merge` or
the repo's merge command) still bind the go to exactly one head: they do not read `carry`.
