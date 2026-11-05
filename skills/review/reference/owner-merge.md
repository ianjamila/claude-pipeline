# review — owner override, extra round and the merge hand-off

Read by the `review` skill (`skills/review/SKILL.md`) at the points it names: Owner override and Extra round (section 2, step 6) and 3.3 (the hand-off).

## Owner override (rare; only with `owner_approval: chat` in `P config`)

Only for an owner who says they want to dismiss what Claude or Codex would not (an item Claude or Codex's second review made ACCEPT): never offer or ask for it. By default you decide
(`P triage claude-ruling`, SKILL.md Rulings). This path is the only one that loosens an ACCEPT or clears an item Claude may not rule on.
Run `P triage ruling-request --pr N --ids R1-B1,R2-S3`. Your reply says "answer with only `<id>: accept | follow-up | reject`; reasons in another
message" and **ends with the exact `line` it printed**, nothing after it. The owner-go hook records the owner's next prompt against that line. Per
item: `P triage owner-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason "<why>" --owner-quote "<the owner's whole answer, copied, never paraphrased>" --pr N`.
A background notice or another session's message between your ask and the owner's answer does not break a pending ruling (the answer binds across them) only while you answer it with tool calls alone: any text in your reply to such a turn voids the pending ask whatever it says (nothing is recorded, ask again), so keep a reply to a notice to tool calls; if you did write text, the owner's answer is refused with a nudge and you show the ask again in your reply to that prompt; a merge request does break (any later reply makes it stale): show it again. An answer the hook could not confirm as typed by the owner is refused (`provenance`) ⇒ ask again.
A refusal (changed finding text, wrong id, other words, label mode) ⇒ ask again with a fresh `ruling-request`. Then re-post `P comment --pr N --kind triage`,
`P followups create --round R`, and the comment again; an ACCEPT is built, `mark-implemented`, and reviewed in a new round. In label mode, `needsHuman`
items end in `needs-human` (as in step 6): the owner rules outside this session.

## Extra round

**Extra round** (only with `owner_approval: chat`; the owner's `extra round` is the only thing that lifts `review.max_rounds`). When `P state outcome` says
`reachedMax: true` with no `extraRound` and no `grantedRound`: commit and push the fixes and get `verify.quick` green (the grant names the head to be
reviewed), then run `P triage round-request --pr N`. It prints `{line, k, n, head}`; keep `n`. Your reply says in one plain-English paragraph what is
still open and what the extra round will review, and **ends with the exact `line`**, nothing after it. Then wait. When the owner types `extra round`
the owner-go hook records it against that line and prints a context line; only then run
`P codex-review --pr N --round <n from round-request> …` as in step 1 (it claims the grant after Codex answers; the output shows `grantUsed`). One grant is one
round: if that round accepts items again, ask again or park. A refusal that says the grant "cannot be confirmed as typed by the owner" (#128: the prompt was a harness message, or its transcript entry is gone or elsewhere) is a refusal too: `round-request` again, and the owner types `extra round` themselves. A refusal (`round-cap` "ask again", grant already used, head moved) ⇒ run `round-request` again. Never
type, paraphrase or forge the owner's words, and never run Codex outside `codex-review`. Label mode ⇒ no grant exists: park as before. `review-complete` and the
final gate re-prove the grant from the owner's record on this machine, so finish the review here.

## 3.3 Endings: the merge hand-off

Which ending depends on the item note from 1.5 (as refreshed in step 2):

   - **A `blocking` item** (a blocking hard-stop or test-integrity violation: always under `owner_approval: label`) : NO `Head …` / `🔀` lines
     (`P merge --owner-go` refuses such a diff) and no `needs-human` label. Say the PR is reviewed and CI is green, name what blocks it
     (from `.review/hardstops.json` and `P integrity`), and give the repo's `merge.command` from `P config` with `{pr}` = N and `{sha}` = the head sha
     filled in (EagleWatch: `npm run merge -- <PR> --expect-head <sha>`) for the owner to run.
   - **Protected areas under `owner_approval: chat`** (`ownerMerge` items, nothing blocking): the owner's "merge" covers them. Run
     `P merge --pr N --dry-run --owner-go`; for a `say-merge` with `areas`, name the protected areas in plain English from its `areaIds` (never from the
     agent-writable `.review/hardstops.json`) and end the reply with the closing lines (last bullet). A dry run with blockers ⇒ fix them first; `owner-runs` ⇒ the first bullet.
     `ownerStep.behindNote` (behind main, accepted: base config `merge.behind_base: disjoint`) ⇒ say it in plain English ABOVE the closing lines (Areas / Hold / Head), never between them; "merge" still covers only that head and items.
   - **Rulings** (`ownerStep.rulings` present: dismissed BLOCKING or security items, single-PR requests only; several PRs with rulings ⇒ a separate reply for each): in plain English, above the closing lines, say what was dismissed and why, naming each item;
     then print the `Rulings <digest12>` block verbatim from the dry run, directly above `Areas` / `Hold` / `Head`. Never type or edit the block: that makes the "merge" bind nothing.
   - **A `needs-human` hold** (`ownerStep.hold` present, with or without areas): say in plain English that the owner's "merge" also lifts the needs-human hold; report it from the event, `ownerStep.holdInfo` (who added the label, when: the account is shared, so never call it the owner's or yours);
     quote `ownerStep.parkNote.text` only when `parkNote` is present, labelled `pipeline park note (agent-written)`, never as the hold's reason. Never start a prose line with `Hold <x> by`: a Hold-looking line outside the closing lines voids the request.
   - **Merge as a job.** The owner says "merge" ⇒ `P job start merge -- node ~/.claude/pipeline/bin/pipeline.mjs merge --pr N --owner-go`, then `P job wait merge --run-id <runId> --timeout 540` until `state` is `done` (it can outlast the Bash tool's 10-minute cap; `replaced`/`lost` ⇒ dry run and `gh pr view` first). Read `exitCode` and `tail`:
     `merged: true` ⇒ done (`holdLifted` names the lifted hold). `error: hold-recovery` with `prMerged: true` ⇒ the PR DID merge (an earlier run's auto-merge fired while recovery disarmed it): report it merged, read the merge commit with `gh pr view N --json mergeCommit`, make no new request. Output with `holdRestored`, `holdKept`, `holdRestoreUnverified`, `holdRemovedByOther`, any other `error: hold-recovery`, or `merge-in-progress` (another P merge of the PR is running, or an earlier run's merge command is still running after that run died; wait and run the dry run again) ⇒ nothing merged: tell the owner plainly, show the NEW dry-run lines; `autoMergeDisarmFailed` ⇒ the owner disables auto-merge by hand; a restored hold is a new hold, so the owner must say "merge" again.
     `holdRestoreFailed` (`error: hold-restore`) ⇒ the owner re-adds the label by hand; "PR comments unreadable" ⇒ run again later. A changed digest, areas or hold ⇒ show the new lines.
   - Any owner command that starts with `gh` is written with gh's absolute path, shell-quoted (`/opt/homebrew/bin/gh …` on this kind of Mac, else `/usr/local/bin/gh`; `command -v gh` when it answers): the owner's `!` prompt shell does not load the PATH that has gh.
   - To preview the verdict before the owner's word, use only `P merge --pr N --dry-run` (add `--owner-go` for that route): same checks, writes and merges nothing; its `ownerStep` says which ending above applies.
     Never run the repo's own merge command (`npm run merge …`, even with `--dry-run`) to preview: the git guard refuses it, and the dry run grants nothing.
   - **No such item**, and the closing lines of every request: the reply's LAST lines are exactly (sha12 = first 12 characters of `git rev-parse HEAD`; owner/name from `gh repo view --json nameWithOwner`; on `--owner-go` copy
     them from the dry run, never type the digest: `ownerStep.rulings` when present, then `ownerStep.areas` and `ownerStep.hold` when present, then `ownerStep.line`, then `ownerStep.ready` when present, with nothing after):
     `Head <sha12> · items <digest> · repo <owner/name>`
     `🔀 Ready to merge #N — say "merge"`
     The owner-go hook binds the owner's "merge" to the LAST reply: if anything else was said since, or the context was compacted, show the lines again (a blank line between them is harmless, prose is not). Never type or simulate the owner's "merge".
     No record ⇒ `P merge` says so: show the request again and wait; but after a Hold line, with an installed pipeline that predates hold support (`P update --check` shows it behind main), say "run pipeline update first" instead.
     A refusal that the transcript is not under a trusted config dir: the owner's Claude Code config dir must be a `.claude*` folder directly under the home (`CLAUDE_CONFIG_DIR` does not count): tell the owner. Label mode and the gated route are unchanged (the gated route lifts no hold).
