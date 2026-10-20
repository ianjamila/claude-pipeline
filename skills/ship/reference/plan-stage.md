# Plan stage (ship Step 1.5)

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. Every run writes a plan, commits it, has it reviewed by risk and waits
for the owner's typed "approve" BEFORE any code is written. The approval is the owner's own prompt, recorded by the
owner-go hook on the machine where they typed it; a copy goes on the PR as a pointer. Nothing you write on GitHub counts
as approval, and you never type, quote or simulate the owner's prompt.

## Rollout rule (say it once, early)

Both machines must run `P update` (the `pipeline update` command) before any new-style run (run records are
version 2). The owner never says "merge" to a v2 run on an older CLI: an old gate has no `plan-scope` check. If the
session reports a stale CLI, tell the owner before starting the plan.

## Sizes and the plan file

The plan lives at `<plan.dir>/<YYYY-MM-DD>-<slug>.md` (`P config` → `plan.dir`, default `docs/plans`; `P plan record`
refuses a file outside it, exit 2, nothing posted). Small plans are committed too.
- **Small** (about 3 files or fewer, no hard-stop path expected): 10-30 lines, written by you.
- **Medium / big**: superpowers brainstorming, then writing-plans with the output path set to `plan.dir`.

Required, and parsed by the CLI (a plan missing one is refused as `plan-invalid`):
- `## In plain English`: 2-4 sentences, reused in the approval request and the PR body.
- `## Scope`: a flat list; each item is EXACTLY one single-backtick code span holding a repo-relative path or glob. The
  plan lists ITSELF in Scope (there is no exemption). End Scope with a column-0 `## ` heading.
- `### Task <id>: <title>` headings; the full text up to the next heading is the task definition (1 to 50 tasks).

The parser reads what the owner sees rendered, so it refuses: raw HTML, HTML comments, entities and autolinks outside
fences and code spans; headings, setext underlines (`---` / `===` under text) and thematic breaks inside Scope; nested
or quoted list items in Scope; scope items that are not exactly one single-backtick code span; non-ASCII scope entries;
invisible characters; link reference definitions; and backticks that pair differently per line than per paragraph. So:
keep a code span on ONE line, and write placeholders such as `<slug>` inside code spans, never bare. Headings inside
fenced code blocks are ignored.

Small-plan example (about 15 lines):

````markdown
## In plain English
The search box on the patients page now ignores upper and lower case, so staff find people on the first try.

## Scope
- `src/app/patients/search.ts`
- `src/app/patients/search.test.ts`
- `docs/plans/2026-10-20-search-case.md`

## Tasks

### Task 1: Case-insensitive patient search
Make the search compare lower-cased names. Test first: a name typed in capitals is found.
````

## Commit, push, draft PR

1. Commit the plan alone with `[skip ci]` in the message (a plan-only push must not start a full CI suite):
   `git add <plan>`, `git commit -m "docs(plan): <title> [skip ci]"`, then the commit trailer.
2. `git push -u origin agent/<slug>`, then `gh pr create --draft --title "<title>" --body-file <file>` (the body is the
   plan's plain-English section plus the request). The first Step 2 checkpoint no longer creates the PR.
3. `P plan record --pr N --file <plan> --request-file <file>` (the request file seeds the run record's request).
   - Exit 1 `dirty` (the file differs from `HEAD`) or `unpushed` (`HEAD` is not the pushed branch): commit and push, rerun.
   - Exit 1 `plan-invalid`: fix what `errors` names. Exit 1 `record-unreadable`: the PR's run record is legacy, invalid,
     unsupported or another repo's; stop and tell the owner (never overwrite it).
   - Exit 0 prints `blob`, `scopeDigest`, `scope`, `tasks` and `requestLines`. A rerun on the same blob reuses the
     posted proposal; restoring an earlier blob makes that proposal active again.

## Risk, then reviews

`P plan risk --pr N` rates the active plan: `high` when Scope can touch a high-risk, hard-stop or security path or a task
names such an area; `medium` for more than 3 tasks or more than `risk.medium_files` entries; else `low`. You may raise it
(money, concurrency) but never lower it. Tell the owner BEFORE any review: `Risk <level> (<reasons>). Reviews: Codex
xhigh + 1 recheck[ + Fable once]. Say "skip Fable" / "add Fable" / "skip review" to change.` and go on unless they answer.

| risk | reviewers |
|---|---|
| low (small plan) | none: the owner's approval is the review |
| medium | Codex review + 1 recheck |
| high | Codex review + 1 recheck, then Fable once on the corrected plan |

Caps are per PR for the whole plan stage: Codex 2 (review + recheck), Fable 1. An owner request for more is recorded with
`--extra "<the owner's exact words>"` (buys one more run) and shown in the approval request. A key is consumed when its
start event is posted, even if the run then crashes; `<blob12>` is the first 12 characters of the active blob.

**Codex.** `P plan review` reserves the launch itself (never call `P plan start --reviewer codex`: exit 1 `use-plan-review`):
- `P job start planreview -- node ~/.claude/pipeline/bin/pipeline.mjs plan review --pr N --key codex-<blob12>-1 --effort xhigh`
  then `P job wait planreview --run-id <runId> --timeout 540` until done; read `exitCode` and the JSON in `tail`.
- Fix what is real in the plan, commit with `[skip ci]`, push, `P plan record` again (a new active blob), then the recheck:
  `... plan review --pr N --key codex-<blob12>-2 --prior .review/plan/codex-<old blob12>-1.md`. It resumes the first run's
  Codex thread when it has one.
- Exit 1 `cap` ⇒ ask the owner for an extra or to skip. Exit 1 `already-started` ⇒ do NOT launch again (the key is
  consumed); a new run needs a NEW key within the cap or an owner extra. `stale-start` / `superseded` ⇒ the plan moved
  while Codex ran; the paid result is kept aside and does not count: record the new blob and use a new key if the cap allows.
  Exit 3 ⇒ Codex or GitHub is unavailable (the key stays consumed): tell the owner, offer to skip or retry later.

**Fable** (high risk only, after the corrected plan is recorded):
- `P plan start --pr N --reviewer fable --key fable-<blob12>-1` prints `claim` and `promptHeader`. Exit 1 `cap` /
  `already-started` as above; exit 3 `not-visible` ⇒ the reservation was not listed back: do NOT launch.
- Dispatch `fable-reviewer` (mode `plan`) with the `promptHeader` pasted verbatim as the FIRST two lines, then the plan
  path and the worktree path. The Agent description is exactly the tag `pipeline-fable-plan <key>`.
- `P plan findings --pr N --key <key> --tag "pipeline-fable-plan <key>" --claim <claim>`. It proves the model and the
  header, refuses a transcript older than the start, and re-checks that your claim is still the earliest start for the key.
  Any refusal writes nothing: a failed proof is not a pass; tell the owner and rule in chat.

**Cost.** `plan review` books Codex itself (`cost: booked | not-reported | failed:…`). Codex usage on a resumed thread is
cumulative, and the recheck books only its own delta. Book the rest yourself, best effort:
`P cost --pr N --phase plan --role fable --execution agent:<agentId> --from-transcript <the agent's output file>`; add
`--phase plan --role codex --execution codex:<session> …` only when the `cost` field says `failed`. Rebooking the same
execution key replaces its entry. The plan-phase token total goes into the approval request.

## Approval request

Show, in plain English: the `## In plain English` text; the plan (or, over 150 lines, its path, its section list and the
`## Scope` list in full); the reviewer tally ("Codex found X, accepted Y, rejected Z because …; Fable …"); the plan token
total; any owner extras. The Scope list is the one `P plan record` printed (`scope`), NEVER the rendered markdown: they
can differ. The reply ENDS with exactly these two lines (`requestLines` verbatim; the recorder binds the owner's "approve"
to the LAST reply only, so anything said since means showing the request again):

```
Plan <blob40> · scope <scopeDigest12>
📋 Ready to approve plan #N — say "approve"
```

Then `P summary --pr N --outcome awaiting-plan-approval --action "Read the plan, then say \"approve\""` (it pushes the
owner's phone) and STOP. An issue-driven run (`agent-build`, owner not at the keyboard) stops here too.

## On "approve"

`P plan approve --pr N` (never before the owner typed it). It posts the `plan-approved` pointer, copies the approved
tasks into the run record and moves a plan-stage run to `build`; run it again if it exits 3. The owner's newest local
plan record for this PR decides: an older "approve" replayed later does not count, and a record naming another repo never
matches (a record without a repo still matches on PR, blob and scope digest: a documented residual). Exit 1:
- `superseded` / `no-approval` / `scope-mismatch` ⇒ the owner approved another plan or none: re-show the active request.
- `plan-changed` ⇒ the plan file at its path on `HEAD` differs from the approved blob: re-record, show a new request.
- `unpushed` ⇒ local `HEAD` is not the PR head: push (or pull), run it again.
- `record-unreadable` ⇒ the run record is legacy, invalid, unsupported or foreign: stop, tell the owner.
- `no-proposal` ⇒ run `P plan record` first. `lost` ⇒ the plan evidence is missing or was edited: stop for the owner.

Then Step 2 builds the approved tasks. Implementers get the FULL task text from the approved blob
(`git show <blob>`), never the clipped copy in the run record.

## Amending an approved plan

Edit the plan, commit with `[skip ci]`, push, `P plan record` (a new active proposal), show a NEW request with the scope
difference and why, and wait for "approve". Until then the gate uses the last approved blob and the record's tasks stay
the approved set, so new or changed tasks are not built and extra files show up as owner-merge items.

## Another machine

`P resume plan` re-shows the plan request (`enter: plan`) only while build work remains and this machine has no matching
owner record; the owner types "approve" again here. With no build work left the gate adds one `plan-scope unverified
<host>` owner-merge item instead (the owner's "merge" covers it). `planApproveFirst` on a `build` route ⇒ run
`P plan approve --pr N` before building.
