# Plan: the owner's chat "merge" covers protected-area PRs (claude-pipeline) — rev 2, with the rev 4 adversarial pass

Design record. PR 1 = #165 (sections A, rev 4 items 3 and the shown `Areas` block), PR 2 = branch `agent/owner-go-hold-lift` (section B and rev 4 items 1, 2a, 4-8: the
named hold is lifted by the same "merge"). The as-built behaviour is in `docs/cli.md` (Owner-go and Owner-go hold lift paragraphs) and `skills/review/SKILL.md` 3.3; where this
record and the code differ, the code and `docs/cli.md` win (see "As built" at the end).

Owner decision 2026-11-05 (chat, option 1): no more copy-pasting `gh pr merge …` and no more clearing `needs-human` by hand. For a
PR whose diff has hard-stop / test-integrity owner items (`owner_approval: chat`), the owner types "merge" after a 🔀 request and
the review skill runs `P merge --pr N --owner-go`; that "merge" also lifts the ONE `needs-human` hold the request named.

Builds on #145 (use-time provenance of the owner's words, transcript write-protection). Fresh branch from main.
Risk: HIGH (pipeline core, merge authority, label authority) => Codex plan review (rev 1 -> 5 findings, all addressed below) + one
adversarial plan pass (rev 4) before building.

## Today

- `P merge --owner-go` (pipeline/commands/merge.mjs `ownerGoMerge`, lib/finalgate.mjs `evaluateOwnerGo`) requires the owner's record
  for `items none` and refuses any diff with owner items (check `owner-items`).
- The gated route (final-gate.json + `--owner-approved-head/--owner-approved-items`) already binds a chat "merge" to the gate's
  `ownerItems` digest (`ownerItemsDigest`, #58).
- The review skill never runs final-gate, so a protected PR ends with "owner runs merge.command" (SKILL.md 3.3); a PR ever parked keeps
  `needs-human`, which only the owner may remove (BLOCKING_LABELS; the guards refuse the agent's label removal).

## A. Owner items bound to GitHub's base and head (finalgate.mjs, merge.mjs) — rev-1 P1-1

1. `evaluateOwnerGo` scans an explicit, immutable range: read `baseRefOid` and `headRefOid` from GitHub (`gh pr view`); require
   `headRefOid` == local HEAD and `baseRefOid` present as a local object (`git cat-file -e <sha>^{commit}`; absent => refuse
   "fetch the base", never fall back to local refs); diff = `merge-base(baseRefOid, head)..head`. hardstops/integrity/ci all use that
   diff. (This also hardens today's `items none` route: a misleading local `origin/main` can no longer empty the scan.)
2. It returns `ownerItems` (digest, 'none' when empty), the item lines and `areas` (the distinct hard-stop rules / integrity kinds),
   all from that ONE canonical item list. The `owner-items` check fails only for a BLOCKING hard-stop, an integrity VIOLATION, or any
   item in `owner_approval: label` mode.
3. `ownerGoMerge` requires `approvalGap({ repo, pr, head, items: <live digest>, hold: <bound hold or none> })` === 'ok'. A record for
   `items none` never covers a diff with items; a record for digest X never covers items that now hash to Y.
4. The final pre-merge look (`preMergeProblems`) re-reads `baseRefOid`/`headRefOid`; a moved base or head => refuse (the scan is stale).
   The merge command stays pinned to the head ({sha}).

## B. The hold the owner's "merge" lifts is named in the request (owner-go.mjs, merge.mjs) — rev-1 P1-2, P1-3, P2-4, P2-5

The request line gains one field when the PR carries `needs-human`:
`Head <sha12> · items <digest> · hold <eventId> · repo <owner/name>` — `eventId` = the node id of the newest `labeled` event for
`needs-human` in the PR timeline (`timelineOf`, paginated). The owner-go recorder stores `hold` in the approval record (absent = none);
`approvalGap` matches it exactly, so the owner's "merge" covers that one hold event and nothing else. No clocks are compared.

Rev 3 (Codex recheck P1/P2: a review status is refreshed by the label event itself, and this repo has no such status): the lift
needs NO review-freshness evidence. The owner's verified "merge" naming hold <eventId> IS the owner's removal of that hold — the
same act as clicking the label off in GitHub, which is what the owner does today without any check. What the pipeline guarantees is
only that the word covers exactly the hold the owner was shown: the hold id is in the line the owner answered (provenance-checked,
#128), the reply shows the hold from the label event, and any hold event newer than the named one is never lifted (B.2/B.4). The review
skill only reaches 3.3 after `review-complete` exit 0; P merge itself does not re-judge the review (owner authority, unchanged from today's manual flow).
(Rev 3's claim that the park comment is "not written by the agent" is withdrawn: see rev 4 item 1.)

Eligibility of a hold (read-only, GitHub only):
- `owner_approval: chat`; `needs-human` is the ONLY blocking label (never lifts `awaiting-review`, `pipeline-blocked`, pause/rollback);
- the timeline is complete and parseable (pagination done, no malformed event); anything unreadable => not eligible;
- an old approval record without `hold` never lifts anything (compatibility: a record for a held PR must name the hold).

Dry run (`P merge --pr N --dry-run --owner-go`): for an eligible hold it reports `ownerStep {kind: say-merge, line (with hold), areas}` and
treats the hold as "lifted upon the owner's merge" in BOTH blocker paths (labels check and preMergeProblems), every other blocker kept.
No record is needed to preview; nothing is written.

Real run, in this order (rev-1 optional: failure policy):
1. owner record (A.3, with hold) => live checks with the bound hold treated as liftable (every other check unchanged) => pre-merge look.
2. Re-read the timeline: the newest `needs-human` labeled event must still be the bound one and the label present; else refuse, nothing changed.
3. Remove `needs-human` (`gh api DELETE …/labels/needs-human`).
4. Re-read the timeline AFTER the delete: any `needs-human` labeled event newer than the bound one (re-applied between 2 and 3, rev-1
   P1-3) => re-add the label, refuse ("a newer hold appeared"). Re-add failure => refuse loudly naming the PR (exit 1, never merge).
5. Post the append-only event comment (hold <eventId> lifted on the owner's merge for head/items); a failed comment is a warning
   (rev 4 item 4 moves it BEFORE the delete and makes its failure a refusal).
6. Final `preMergeProblems` => merge command => wait. Merge not completed (command failure, timeout, closed, blocker) => re-add
   `needs-human` before returning (the hold comes back whenever nothing merged), and say so. The restore wraps EVERY exit after step 3
   (try/finally, exceptions included) and runs after `abandonMerge`, which may find the PR merged after all (then no restore).
   The post-delete re-read (step 4) must return a complete timeline that contains the delete's own `unlabeled` event (proof the read is
   current); otherwise re-add and refuse. A failed re-add is a loud refusal naming the PR (exit 1, never merge).

## C. Skill and docs (skills/review/SKILL.md, docs/cli.md, merge.mjs usage)
- 3.3: chat mode, protected PR: the reply names the protected areas from the dry run's `areas` (not the agent-writable
  `.review/hardstops.json`), says "your merge also lifts the needs-human hold" when the line has `hold`, and ends with the dry run's line
  then `🔀 Ready to merge #N — say "merge"`. The owner says "merge" => `P merge --pr N --owner-go`.
- Rule 1: the agent still never removes `needs-human`; `P merge` lifts the named hold on the owner's verified "merge" (3.3).
- Label mode unchanged. Gated route unchanged (it does not lift holds).
- Known harmless output: `gh pr merge --delete-branch` from a worktree prints "'main' is already checked out" after merging; MERGED is
  MERGED (waitForMerge) — test it.

## D. Guards
No guard change expected; the agent still cannot run `gh pr merge` or edit labels. Verify `P merge --owner-go` is not refused by text.

## Tests
- A: misleading local base ref (origin/main = head) => items still found from GitHub's baseRefOid; base object missing => refused;
  protected diff + record for the live digest => merges; record `none` => refused naming the line; stale digest => refused; blocking
  hard-stop / integrity violation / label mode => refused even with a record; base or head moved before merge => refused.
- B: eligible hold + record with that hold => removed, comment, merged; record without hold / other hold id => refused, label kept;
  old record without hold on a held PR => nothing lifted; exact opaque hold id compare; post-delete timeline without the delete's
  own unlabeled event / unreadable / malformed => re-added + refused; an exception after the delete => re-added; abandonMerge finds
  MERGED => not re-added; another blocking label => kept;
  label re-applied between check and delete (fake timeline) => re-added + refused; re-add failure => loud refusal; merge fails /
  times out => label re-added; paginated / malformed / unavailable timeline => not eligible; dry run first request with no record =>
  say-merge line with hold, both blocker paths cleared, nothing written; synthetic or missing "merge" prompt (#128) => nothing lifted.
- Gated route and label mode unchanged (existing tests stay green). Mutation checks on the digest compare, the hold-id match and the
  post-delete re-read.

## Rollout
- PR 1 is protected: the owner pastes its merge command once (the installed pipeline is the old one). After it merges and
  `pipeline update` runs, every later protected PR ends with 🔀 "merge". PR 2 is protected the same way, and a hold request shown
  before `pipeline update` records nothing (the old hook): the skill says "run pipeline update first".
- A consuming repo: check its `merge.command` works when `P merge` runs it for a protected PR; if it needs something only the owner
  can supply, report before merge.

## Residuals
- A hold the owner placed BEFORE the review finished is lifted by "merge" (the reply says the merge lifts it).
- The owner's GitHub account is shared with the agent's gh: the actor of a hold is unknowable, so the pipeline never says whose it is.
- Free prose around the closing block stays the agent's.

## Rev 4 — adversarial plan pass (all 8 adopted; they override the text above where they differ)
1. (P1) The park comment is agent-written (`P comment --kind needs-human` renders --reason, upserted). Never present it as the hold's
   reason. The dry run reports the hold from the EVENT: actor login + created_at; it quotes the needs-human comment only when its
   updated_at >= the event's created_at, labelled "pipeline park note (agent-written)". Rev 3's "not written by the agent" is withdrawn.
2. (P2) Bind the owner-facing facts, not just the Head line: (a) a request with `hold` binds only when the 🔀 line reads
   `🔀 Ready to merge #N and lift its needs-human hold — say "merge"` (the recorder binds nothing otherwise; the VS Code tab hook must
   still match it); (b) the dry run prints a canonical block right above the Head line: `Areas <rule ids / integrity kinds>` and
   `Hold <eventId> by <login> at <ISO>`; the terminal-block parser accepts exactly those shapes; the record stores sha256(block);
   `P merge` recomputes the block from the live scan + timeline and refuses on mismatch. Free prose stays the agent's (residual).
3. (P2) Object graph: add `GIT_NO_REPLACE_OBJECTS=1` to GIT_ENV (lib/git.mjs); refuse when refs/replace/*, info/grafts or shallow
   exist; cross-check the scanned file list against GitHub `pulls/{n}/files` (paginated): a file GitHub lists that the local diff lacks
   => refuse. Test: a replace ref hiding a hard-stop file => refused.
4. (P2) Kill-safety: post the append-only "hold <eventId> lifted on the owner's merge for head/items" comment BEFORE the delete; its
   failure refuses (nothing changed yet). SIGTERM/SIGINT/SIGHUP handlers re-add the label. `P merge` for a PR detects
   "lift comment newer than the newest needs-human labeled event, PR open, label absent, not merged" and re-adds first. The skill runs
   `P merge --owner-go` under `P job start` (the wait can outlast the Bash tool's 10-minute cap).
5. (P2) Record/parser: approvalsFor matches `(typeof q.hold === 'string' ? q.hold : 'none') === boundHold` exactly; HEAD_LINE accepts
   at most one `hold <[A-Za-z0-9_=+/-]{1,128}>` between items and repo, $-anchored; repeated/misplaced => binds nothing; the multi-PR
   `#N head …` form too; `items none · hold X` allowed (same rules). Old hook + new line records nothing: the skill says "run pipeline
   update first" instead of re-showing the line.
6. (P3) State the equivalence's two conditions: the actor is unknowable (shared account) — never describe a hold as the owner's or the
   agent's; the owner sees the machine-generated hold block (2b). A restore creates a NEW labeled event, so the old record cannot lift
   it: the owner must say "merge" again (SKILL 3.3).
7. (P3) Post-delete timeline read: bounded retry (3 x 2 s) for the delete's own unlabeled event before restoring.
8. (P3) Only evaluateOwnerGo's labelsCheck and the PRE-delete preMergeProblems exempt the bound hold; the post-delete preMergeProblems
   and waitBlockers use the plain rule (a needs-human re-added during the wait ends it as blocked => restore, idempotent add). Test it.

## Block order and a Hold line (PR 2 decision)
A `Hold` line follows the `Areas` pattern (canonical line directly above Head, digest in the record, compared in `approvalGap`) with one difference: a Hold-shaped
line (canonical prefix `Hold <id> by `) that is not consumed exactly in the closing block binds NOTHING for the whole reply, where a stray Areas line only drops the areas.
Block order, top to bottom: Areas (optional), Hold, Head, then the 🔀 line.

## As built (PR 2), changes from the text above
- The lift comment (`hold-lifted`) is posted before the delete (rev 4 item 4); a failed post refuses with the label untouched and posts `hold-lift-aborted`.
- Recovery counts a lift only within 15 minutes of the comment (a later `unlabeled` event was a manual removal), ignores one followed by a `hold-lift-aborted` of the same viewer, fails closed when
  the comments, timeline or PR cannot be read once a lift comment exists, and runs in both `P merge` routes and as the dry run's `hold-lift-orphan` blocker (`P preflight` has no `--pr` form).
- A signal kills the merge command's process group and disarms auto-merge before the label is put back, unless the PR is MERGED.
- Restore outcomes are reported from the timeline: `holdRestored` (a new hold exists), `holdKept` (the label never left), `holdRestoreUnverified`; a delete that returns HTTP 404 means someone else removed
  the label (`holdRemovedByOther`, not put back); a failed re-add is `error: hold-restore`, exit 1.
- The park note is one line prefixed `quoted note: `. Blank lines inside the closing block are ignored; prose still ends it. The use-time transcript check honours only `.claude*` folders directly under the account home.
