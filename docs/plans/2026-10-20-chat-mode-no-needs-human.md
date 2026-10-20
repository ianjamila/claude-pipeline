# Plan: `owner_approval: chat` never adds or honours `needs-human`

## For the owner
- **No more `needs-human` label.** In repos set to "chat" approval the pipeline stops adding that label, and any label already sitting on a PR is simply ignored.
- **A stop looks like this.** You get a phone notification, a comment on the PR, and Claude's chat message ends with a short line such as `Stopped #123 · stop 3fa9c2e1`, then a line saying it is waiting on you.
- **What you type.** `ship resume 123` to let it carry on, or `merge` when Claude offers a merge. Only your own typed message releases a stop; Claude cannot release it for itself.
- **An old "merge" never carries over.** If something stopped after you said "merge", you must say "merge" again, to the new request that shows the new stop line. An earlier "merge" cannot be reused.
- **New chat session?** Type `ship resume 123`; Claude shows you the stop line and you confirm once with `resume 123`. One extra message, only in that case.
- **Claude can no longer merge by hand in these repos.** Typed merge commands (including auto-merge) are refused; merging goes only through the pipeline's own merge step, which checks all of the above. A revert PR after a failed deploy is created as a draft: you mark it ready in GitHub once you have looked.
- **What still needs you:** rulings on review items, hard-stop files, and every merge that has owner items; the phone push says which.
- **What is NOT covered:** a determined program Claude writes itself, or browser tools logged in to github.com, could still edit comments (the real fix is a second GitHub account, issue #65). If GitHub is down at the moment of a stop, the block exists only on that computer until it reconnects. During the upgrade, update BOTH the Mac and the PC first. In eaglewatch, old labels will keep blocking merges until its own merge-check change lands; remove them in GitHub meanwhile.

Rev 4 (2026-10-20), after the Codex plan review of rev 1, the owner's decisions of 2026-10-20, the Codex recheck of rev 2.1 (N1-N4), and Fable's adversarial review of rev 3 (all findings adopted by the controller; see the Revision log). Owner requirement (fixed): in chat mode the pipeline never adds the
`needs-human` label; a stop for the owner is a PR comment + a phone push + a durable stop; ONLY the owner's typed chat reply
releases it; leftover labels are ignored so old PRs unstick. Label mode unchanged. Claude never removes a label (guards unchanged).
One PR (owner decision; no split).

## Summary
A chat-mode stop is an **owner stop**: an append-only `owner-stop` event (run-events.mjs) on the PR, with a short random id.
It is released only by an `owner-stop-released` event, which the CLI posts only after trusted owner-prompt evidence for that exact
stop id (the controller's reply ends with `Stopped #N · stop <id>`; the owner then types `ship resume N` / `resume N`, or `merge`
when the reply offered it). **Events are the authority**: the final gate, `P merge` (step 1a), the last look before the merge
command, every auto-merge poll, `P checkpoint`, resume routing and the inbox all read events, never the record. The run record
keeps a display copy `ownerStop` and nothing more; its one remaining job is the rollout tripwire for OLD CLIs (a record with an
open stop is version 2, so an older CLI reads it as `unsupported` and demands the owner's "merge", merge.mjs:68-72). A local pending
file (written FIRST, one file per stop id, serialized by a lock) keeps the PR blocked on this machine if the event could not be posted
yet. Guards stop an agent from editing or removing comments, from posting marker-bearing comments of the two new kinds by every route the
guard can see (`gh pr/issue comment`, `gh api` REST, GraphQL `addComment` and the other comment-creating mutations, `curl`/`wget`/`http`/`xh` to
github.com, unreadable bodies), and, in chat repos, from merging directly at all (`gh pr merge`, the configured merge command typed by
hand, auto-merge): agents merge only through `P merge`. Independently of any release, for a PR with ANY `owner-stop` event the merge request
the owner answers must carry `Stopped #N · stop <newest id>` above its Head line, and `P merge` accepts only an owner "merge" recorded against
that newest stop id, so an approval given before a stop can never be replayed (no timestamps involved). Label mode stays byte-for-byte as today.

## Code facts (verified against origin/main 5f5d1c3)
- No CLI code adds `needs-human` to a PR: `addLabels` (pipeline/lib/github.mjs:205) has no caller; every PR-label add is skill text.
  Only prodwatch.mjs:430 (incident issue, non-pausing outcomes) and :452 (revert PR) create the label in code. `P labels ensure`
  (commands/labels.mjs:13) only creates it; leave it.
- `P merge` refuses on the label today: saved gate `labels` check (finalgate.mjs:245-250), live re-evaluation (merge.mjs:132),
  `preMergeProblems` (finalgate.mjs:723-735), `waitBlockers` (:738-751) via `BLOCKING_LABELS` (:31). Nothing vendored into consumer
  repos reads `needs-human` (ci-guard.mjs / ci-guards-run.mjs read approval labels only).
- **Run events: storage and trust model (read before relying on it).**
  - Storage: each event is its own PR comment, `<!-- claude-pipeline:event:<kind>:<id> -->` + a sentence + a packed JSON payload
    (`renderEvent`, run-events.mjs:13-24). Posted with `gh.createComment` (github.mjs:341, a plain `POST .../issues/N/comments`),
    never `upsertComment`; `postEvent` (run-events.mjs:70-72) documents "a second event can never rewrite a first one".
  - Who counts: `listEvents` (:44-51) keeps only comments whose author is the viewer (`gh.viewer()`, the gh-authed account, which is the
    owner's account) and whose body STARTS with a known marker (`parseEvent` :26-41); `EVENT_KINDS` (:7) is a closed list. A quoted
    marker or another user's comment is not an event.
  - Append-only is CONVENTION, not enforcement: no pipeline code edits or deletes an event, but GitHub lets the viewer (the same token
    agents run with) or a repo admin PATCH/DELETE any comment, and nothing in the hooks looks at comment edits or at marker text
    (git-policy.mjs has no rule on `issues/comments/*`; `gh pr|issue comment --edit-last|--delete-last` is unchecked; the graphql
    allowlist even PERMITS `updateIssueComment`, git-policy.mjs:35-38; no hook mentions `claude-pipeline:event`). So the comment-edit
    guard IS still needed (events live in comments too), and a NEW forging guard is needed: an agent can today create a comment whose
    body is a valid event.
  - Matching by id is already the house pattern: `unresolvedRollbacks` (:56-60) pairs `rollback-intent` with `rollback-result` of the
    same id and counts an intent whose payload cannot be read as still open (fail closed). Open stops copy that shape.
  - Readers already hold the list: `pr-facts.mjs:78` puts `events: listEvents(comments, viewer)` into the facts that `P resume` and
    `P inbox` use, so those need no extra GitHub call.
- **The record is last-writer-wins by design** (run-record.mjs:1-3). Writers: `applyCheckpoint` (:246; patches clone the old record, so
  unknown keys survive), `recordForOutcome` (:302; `P summary` summary.mjs:169, `P comment --kind summary` comment.mjs:62),
  `createRunRecorder.update` (run-progress.mjs:33; `P merge` merge.mjs:154-158 writes `outcome: null`, `P update-branch`),
  `P checkpoint` (checkpoint.mjs:94 clears `outcome` for any step but `ended` / `awaiting-owner-merge`; :132 stamps `resumed` from the flag
  alone), `createRunRecordTracker` (prodwatch.mjs:161-176). Because the record is no longer the authority, none of them can clear a stop.
- **Old CLIs ignore events (so the tripwire stays) and a version-2 record trips them (confirmed):** `decodeRecord` returns `unsupported`
  when `record.v > RECORD_VERSION` (run-record.mjs:154). An old `P merge` then sets `unchecked` (merge.mjs:83) and, without the owner's
  approval, refuses (:92-95); an old checkpoint throws (checkpoint.mjs:135), an old recorder throws into a warning (run-progress.mjs:36),
  `P summary` / `P comment` throw (summary.mjs:167, comment.mjs:61), the tracker throws (prodwatch.mjs:163-171), and
  `writeSummaryComment` refuses to drop an unsupported record (summary-comment.mjs:42). Without the tripwire an old install in a chat repo
  would see no label, no event it understands, and merge. With it, it merges only on the owner's recorded "merge" for the exact head.
- Owner-go (hooks/lib/owner-go.mjs, hooks/owner-go.mjs): records only prompts starting with "merge" (`parseApproval` :43), bound to the
  terminal block of the reply right before (`presentedRequests` :67; `lastRequestText` :94 needs a `🔀 Ready to merge` last line), in
  `~/.claude/pipeline-state/owner-go` (protected, files-policy.mjs:45), `v: 1`, read by `readApprovals` (:213, 24 h; it currently drops
  `prompt_sha256`, :247-252) and `approvedRequest` (:259). Only the owner's typed prompt reaches the hook; subagents are ignored (:143).
- **Guard facts behind N1 / N2 (recheck).**
  - GraphQL: `GRAPHQL_ALLOWED_MUTATIONS` (git-policy.mjs:35) allows `addComment` and `addPullRequestReview` (guard-git.test.mjs:850 pins
    `addComment` allowed); `checkGraphql` (:792-808) judges mutation NAMES only; `gatherBody` (:709-745) already decodes `-f/-F key=value`,
    `@file` values and `--input` files, and sets `unknown` for `--input -` or an unreadable file. `gh` is in `CATCH_ALL_EXEMPT`
    (guarded-text.mjs:14), so the marker text scan of `guardedCommandText` never sees a `gh ...` command line: the forging rule must live in
    `checkApi` / `checkGraphql` / the `gh pr|issue comment` branch itself. `github.listComments` reads only `issues/N/comments` (github.mjs:315-316),
    so review bodies (`addPullRequestReview`) can never be events; they are still denied when they carry the marker.
  - Direct merges: `directMergeVerdict` (git-policy.mjs:~910-933) allows a direct `gh pr merge --match-head-commit H`, the configured merge command
    typed by hand (`repoMergeCommandVerdict`) and `gh pr merge --auto` whenever `ctx.ownerGo.approvedHead(pr, H)` (git-wiring.mjs:97 -> `approvedPr`, owner-go.mjs:266) finds ANY owner "merge" for that PR+head in this session
    within 24 h. It reads no events and no pending file, so a same-head approval given before a stop still opens it.
  - `P merge` is unaffected by refusing direct merges: it runs `merge.command` as its own child process (`runShellAsync`, merge.mjs:203), "which the guard
    never sees" (comment above `ownerGoMode`, git-policy.mjs:~902). The Bash hook only sees the `P merge` command line itself.
  - `approvedRequest` (owner-go.mjs:259) matches on pr + head + items only, inside the 24 h window (`readApprovals` :213): an approval for H/D recorded
    before a stop still matches after it. The resumed rule alone therefore does not stop replay; binding the approval to the newest stop id does.
  - The hook has NO rule for `curl` / `wget` / `http` / `xh` (git-policy.mjs mentions `curl` only in the `DATA_COMMANDS` word list, :1925, and
    in a comment, :79): with the viewer's token such a command can PUT `pulls/N/merge`, POST `issues/N/comments`, PATCH `issues/comments/ID` or call
    `graphql` without touching any `gh` rule.
  - `disableAutoMerge({pr, cwd, env})` (finalgate.mjs:792) runs `gh pr merge N --disable-auto` and returns a boolean; `autoMergeRequest` is already a
    `gh pr view` field (resume.mjs:66).
  - Offline repository identity exists: `parseRemote` (notify.mjs:351) on `git remote get-url origin` (notify.mjs:685; worktree-prune uses the configured URL,
    run.mjs:32) gives `owner/name` with no network; `gh.repo()` is a network call.
  - Cross-session serialization already exists: `withLock(name, fn, {dir, waitMs})` (locks.mjs:430; header locks.mjs:1-10: mkdir-atomic, owner.json, dead-PID
    reclaim) and the agent-log queue's `withQueueLock` (agentlog.mjs:33-34).
  - `P resume plan|list` promise to be read-only (resume.mjs:1-3), pinned by resume-command.test.mjs:88.
- Summary upsert failures already exit 3 (`UnavailableError`) with the push still sent in the `finally` (summary.mjs:182-185, pinned by
  cli-gate-log.test.mjs:337). Rev 1's "exit 1 on a failed write" premise was wrong and would not have persisted a stop.
- `prod-watch.mjs:85-97` exposes a narrow `github` seam; events and the tracker exist only with `--pr` (:95); the revert PR is a NEW PR
  neither can address; `prCreator` (:30-39) has no draft option, and no code path needs to un-draft: the owner marks the revert PR ready in the GitHub UI.
- Per-account runtime state lives in `~/.claude/pipeline-state/` (notify state, guard log, locks, owner-go).

## Data shapes
- Event `owner-stop`, id = stop id (`/^[0-9a-f]{8}$/`, random, minted by the CLI), data `{repo, pr, id, cause, head, at, host, autoMergeDisarmed: true|false|null}`
  (`cause` matches `/^[A-Za-z0-9:_.-]{1,60}$/`, summary.mjs:32; `head` 40-hex or null). Sentence: `Owner stop <id> on #N (<cause>): only the
  owner's reply releases it.`
- Event `owner-stop-released`, same id, data `{repo, pr, id, at, host, releaseRef}`; `releaseRef` = `{kind: 'resume'|'merge', session, ts,
  prompt_sha256}` copied from the matching owner-go record. `EVENT_KINDS` gets both kinds.
- Open stops: `openOwnerStops(events)` (run-events.mjs, next to `unresolvedRollbacks`) = `owner-stop` events (an unreadable payload still
  counts, fail closed) minus ids that have an `owner-stop-released` event with a READABLE payload for the same id (an unreadable release
  releases nothing). Oldest first.
- Record display copy: `ownerStop: {id, cause, head, at}` (validated by `shapeProblem`, run-record.mjs:121; malformed => `invalid`, and merge
  fails closed on invalid). `RECORD_VERSION` becomes 2 (readers accept up to 2); `v` is derived in `applyCheckpoint`: 2 while the copy is
  present, else 1, so ordinary records stay readable by old CLIs. The copy is set after the event is posted and cleared after the release
  event is posted, both best-effort (a failed write is a warning: the event is the authority). No `releasedStops` field is needed.
- Release evidence (owner-go record, still `v: 1`, additive): `releases: [{pr, stop}]` (one entry per `Stopped` line) and, on "merge" records, `requests[].stops: [ids]` =
  every stop id listed for that PR in the reply's terminal block; `readApprovals` passes both and `prompt_sha256` through.
- Local pending stop, ONE FILE PER STOP ID: `~/.claude/pipeline-state/owner-stops/<owner>__<repo>__<pr>__<id>.json` =
  `{v:1, repo, pr, stop:{id,cause,head,at}, detail, state: 'intent'|'unposted'}`, written atomically (tmp + rename, mode 0600, O_NOFOLLOW,
  real-dir chain like owner-go's `realDirChain`), account home from `accountHome()` (owner-go.mjs:28), never `$HOME`. `<owner>/<repo>` comes
  from the LOCAL git remote (`parseRemote(git remote get-url origin)`, no network). Folder added to the protected list (files-policy.mjs:45).
  Create, reconcile and delete are serialized per repo+PR by `withLock('owner-stop-<owner>__<repo>__<pr>', ..., {dir: <pipeline-state>/locks, waitMs})`
  (locks.mjs:430); cleanup deletes a file only after re-reading it and checking repo, pr and `stop.id` equal the ones just confirmed on GitHub.
- No timestamps are compared anywhere (no `createdAt`, no skew rule). `newestStopId(events)` (run-events.mjs) = the id of the newest `owner-stop` event of the
  PR by comment id (released or not); `null` when there is none.
- Reply lines (the controller prints `P summary`'s `reply` output verbatim; the merge request stays two lines):
  - Needs a ruling or a resume (last two lines): `Stopped #N · stop <id>` then `⏸ Waiting on you for #N — rule in chat, then say "ship resume N"`.
  - Owner may simply retry: `Stopped #N · stop <id>`, `Head <sha12> · items <digest>`, `🔀 Ready to merge #N — say "merge"`.
  - ANY merge request for a PR that has an `owner-stop` event (even a released one) carries the `Stopped #N · stop <newest id>` line above `Head` (`P final-gate` prints
    `stop: {id}|null` so the controller does not have to look). Several open stops: one `Stopped` line per id. If auto-merge could not be disarmed, a line
    `⚠ auto-merge could not be disarmed on #N: run gh pr merge N --disable-auto` goes ABOVE the `Stopped` lines.

## Design

### D1. Durable owner stop = append-only event; the record is display + tripwire (Codex #1; owner decision 1)
- `openOwnerStop` (lib/owner-stop.mjs) is the only creator, with ONE authoritative sequence (D4 has the failure cases): (1) resolve the repo
  identity locally (git remote, no network); (2) mint a candidate id and write the LOCAL pending file for it (`state: 'intent'`) BEFORE any GitHub
  call; (3) take the per-repo+PR lock; (4) call `disableAutoMerge` (a queued merge must not fire on a stopped PR; its boolean goes into the event as
  `autoMergeDisarmed`; a failure does NOT stop the sequence); (5) read events (remote; a failure leaves the pending file in place, so the PR is already
  blocked on this machine); (6) reconcile: an open stop already exists on GitHub => reuse its id, delete our own file (identity-checked), done (a second
  `needs-human` summary, or a retry after an outage, is the same terminal state); otherwise post the `owner-stop` event with our id; (7) delete our pending
  file (identity-checked); (8) release the lock. The record copy (+ `v: 2`) and the `needs-human` PR comment follow through the normal summary path,
  best-effort. A cross-machine race can leave two open stops for one PR: nothing collapses them; both block, the reply lists both ids, and one reply releases both (D2).
- `P summary --outcome needs-human [--cause C]` and `P comment --kind summary --outcome needs-human` call it in chat mode (both load
  config; an unreadable config falls back to label behaviour, as today: accepted edge, `P merge` needs a valid config anyway). Other
  outcomes (`stopped`, `blocked`, ...) never create or clear a stop. `recordForOutcome` takes `ownerApproval`; the outcome stays a
  display value. `OUTCOME_NEXT` is unchanged; new `outcomeNext(outcome, {ownerApproval, stop})` returns today's text in label mode and
  `owner reply needed in chat (stop <id>): ship resume N` in chat (Codex P3). The status block renders `- **Owner stop:** <id> (<cause>)`
  when the copy is present.
- Because readers use events, the record writers (summary, comment, checkpoint, merge progress, update-branch, tracker) cannot clear a stop
  whatever they write; a replaced, blanked or hand-edited record changes only the display and the old-CLI tripwire.
- Guards (hooks/lib/git-policy.mjs, guarded-text.mjs), because events live in comments the viewer token can change:
  1. deny `gh api -X PATCH|PUT|DELETE` (also `--method`, also the numeric `repositories/{id}/` alias via `normaliseEndpoint` :817) on
     `repos/*/issues/comments/*`; deny `gh pr comment` / `gh issue comment` with `--edit-last` or `--delete-last`; remove `updateIssueComment`
     from `GRAPHQL_ALLOWED_MUTATIONS` (:35) (`deleteIssueComment` is already outside the allowlist);
  2. NEW forging guard, covering EVERY comment-creating route (N1). The marker is `claude-pipeline:event:owner-stop` (covers both kinds), matched
     case-insensitively on the DECODED text (`safeDecode`, as `checkApi` already does for labels):
     - `gh pr comment` / `gh issue comment`: `--body`/`-b` value, `--body-file`/`-F` file content (read through `ctx.readText`);
     - `gh api` POST/PUT/PATCH whose endpoint is `repos/*/issues/N/comments` (and `pulls/N/comments`, `pulls/N/reviews`): every `-f/-F/--raw-field/--field`
       value, `@file` values and `--input` file contents (all already collected by `gatherBody`, so the haystack in `checkApi` covers them);
     - GraphQL: for any mutation that creates text (`addComment`, `addPullRequestReview`, and, should they ever be allowlisted,
       `addPullRequestReviewComment`, `addPullRequestReviewThreadReply`, `updateIssueComment`) `checkGraphql` scans the query text AND the variable
       fields (`-f body=...`, `-F`, `--input` JSON values) for the marker;
     - an UNREADABLE body (`gatherBody().unknown`: `--input -`, stdin `-F -`/`--body-file -`, unreadable `@file`, a run-time-built `query`) that targets any of
       the comment-creating routes above is DENIED, not allowed (today `checkGraphql` already denies unknown bodies at :806; the REST and `gh pr comment`
       branches gain the same rule; message: "pass the comment text with --body or -f body=..."). Reading comments and posting ordinary, readable ones stay allowed.
     - `curl` / `wget` / `http` / `https` (httpie) / `xh` (new branch beside `checkGh`, same `gatherBody`-style reading of `-d/--data*/--json/-T/--upload-file`, `@file`):
       a URL word on `github.com` or `api.github.com` is judged by `normaliseEndpoint` (:817). With any non-GET method (`-X/--request/--method`, or implied by `-d`/`--data*`/
       `-T`/`--upload-file`/`--json`) the call is DENIED for `/pulls/\d+/merge`, `/merges`, `/git/refs`, `/issues/comments/\d+`, `/issues/\d+/comments` (+ the marker scan as for
       REST) and `/graphql` (mutation names judged like `checkGraphql`). A URL built at run time (`$VAR`, `$(...)`, backticks) that points at a github host, or whose host cannot be
       read, is DENIED. GET and non-GitHub hosts are unaffected. Residual: `node -e "fetch(...)"`, `python -c`, any program the agent writes. The old idea of a marker scan
       in `guardedCommandText` for `node -e` text is DROPPED (a stop-gap that proves nothing).
  Same threat model as the other guards: they stop an agent's direct command, not a program it writes (owner-go.mjs:10-12; server-side
  backstop = issue #65). Even if a forged release slips through, D2's stop-id binding still makes `P merge` demand an owner "merge" given to a request that carried the
  newest stop id, so a forgery cannot reach a merge on an approval that predates the stop.

### D2. Authenticated release through owner-go (Codex #2, #5)
- Stop id binding: `presentedRequests` (owner-go.mjs:67) accepts a second line type in the terminal block,
  `^\s*Stopped\s+#(\d+)\s*(?:·|\|)\s*stop\s+([0-9a-f]{8})\s*$`, anywhere in the contiguous block above the last line (Head lines bind as today),
  and `lastRequestText` (:94) accepts a `⏸ Waiting on you for #N` last line (`WAIT_LINE`) as well as the 🔀 line. It returns
  `{prs, requests, stops: [{pr, stop}]}` (additive). One PR with SEVERAL `Stopped` lines binds ALL its ids (each becomes a release; `requests[].stops` lists them); two
  different Head lines for one PR still bind none, as today.
- Prompts: `parseResume(prompt)` accepts `ship resume N`, `resume N`, `ship resume #N`, and the same with a leading slash (`/ship resume N`, `/resume N`) (+ the FILLER words of `parseApproval`; a `?` or any
  other word is no approval). `recordApproval` tries `parseApproval` then `parseResume` and writes `releases`: for "merge" the stops of a
  reply that ended with the 🔀 line; for resume the stops of a reply that ended with either last line; narrowed to the PRs the prompt names.
  `approvedRelease({pr, stop, ...opts})` (24 h, any session) returns the matching record or null. The id is minted by the CLI at stop time and
  shown to the owner only afterwards, so a release cannot predate its stop, cannot name another stop, and cannot be replayed on a later one.
- Release is the controller's second step: `P checkpoint --pr N --step gate|review --resumed` (chat mode, open stops exist) requires
  `approvedRelease` for EVERY open stop it releases (it releases every open stop an owner reply named); for each it posts `owner-stop-released` (with `releaseRef`) FIRST, then clears the record
  copy and the pending file, stamps `record.resumed`, sets `outcome` null. Stops without a release stay open: exit 1
  `{error:'owner-release-missing', stops:[ids], message}` ("the owner has not released stop <id>; show the stop lines and wait; if the hook is
  old run `pipeline update`"). Without `--resumed`, any `P checkpoint` while a stop is open (steps other than `ended` /
  `awaiting-owner-merge`) exits 1 `{error:'owner-stop-open'}`. `--resumed` with no open stop (adopting a PR, ordinary resume) is unchanged.
- A "resume" prompt records NO merge approval: for `parseResume` prompts `recordApproval` writes `requests: []` even when the reply before it was a
  `Stopped / Head / 🔀` offer; only `releases` is recorded. (A "merge" prompt records both.)
- **Resumed rule:** a run is resumed when `record.resumed` OR any `owner-stop-released` event exists for the PR (merge.mjs:75-83 reads both).
  So every release, forged or real, still needs the owner's recorded "merge" for the exact head and item digest before `P merge` merges.
- **Stop-id binding (replaces the rev 3 timestamp floor):** for a PR that has ANY `owner-stop` event, `P merge` (the only merge path, N2) requires the owner-go "merge" record to carry
  the NEWEST stop id: `approvedRequest({pr, head, items, stop: newestStopId(events)})` (owner-go.mjs:259) matches only a request whose `stops` include it. The controller must therefore
  print `Stopped #N · stop <newest id>` above the Head line of every merge request for such a PR (data shapes), and the id exists only after the stop was posted, so an approval
  given for an earlier request can never match. PRs with no `owner-stop` event are unaffected (no `stop` argument). A failed events read at `P merge` is a refusal (fail closed).
- **"merge" end to end (Codex #5):** owner "merge" after a `Stopped / Head / 🔀` reply => hook records the request (pr, head, items, stops) AND the
  release (pr, stop) => `P checkpoint --step gate --resumed` posts the release => `P final-gate` regenerates the gate (no open stop; unresolved
  review items still fail `review`) => `P merge --owner-approved-head H --owner-approved-items D` (approval re-checked against the regenerated
  head and digest; changed items => refused, owner asked again). `ship resume` and "merge" differ only in the first step.
- After a `P merge` / `update-branch` that moved the branch, `P checkpoint --resumed` refuses `behind`: run `git pull --ff-only` first, then checkpoint (skill text, T6).
- **New-session resume (accepted):** `ship resume N` as the first prompt of a new session has no stop reply before it, so it records no release.
  The controller reads the events, prints the stop lines (ids from the events) and asks for one confirming `resume N`. Same session = one message.

### D3. Last-moment checks and auto-merge (Codex #3)
One reader, `ownerStopProblems({gh, pr, root, ownerApproval})` (lib/owner-stop.mjs): `[]` in label mode with no gh call. Chat: (a) flush a
local pending stop for this repo+PR first (D4), a flush failure is a problem; (b) `readEvents(gh, pr)` (PR passed explicitly), any read error
is a problem (fail closed); each open stop is a problem naming id and cause. The record is not consulted. Callers: the `labels` check
(saved + live gate), `P merge` step 1a (before `bringUpToDate` touches the branch; also the resumed rule above), `preMergeProblems`, and every
`waitBlockers` poll; a blocker in the wait ends it `blocked` and `abandonMerge` disables auto-merge (merge.mjs:221-242). Progress writes at
merge.mjs:154 cannot affect events. Resume planning and the inbox call `openOwnerStops(facts.events)` on the facts they already hold and never flush or write anything.
`ownerStopProblems` also reports an ARMED auto-merge on a PR that has an open stop (`autoMergeRequest` non-null: "auto-merge is armed on a stopped PR: gh pr merge N --disable-auto"); in
chat mode the callers add the `autoMergeRequest` field to their `gh pr view` field list (label mode keeps today's exact lists, so scripted fixtures do not change).

**Direct merges (N2).** The stop reader above is only reachable through `P merge`, so in chat repos the guard stops agents merging any other way. In
`directMergeVerdict` (git-policy.mjs:~920) the allow branch (`approvedHead(pr, head) === true`, :930) is removed: when `ownerGoMode` is `chat` (or the
repository is unknown, `-R`, a PR URL or GH_REPO, as today) every `gh pr merge` (including `--auto`, `--squash` ... with or without `--match-head-commit`),
every hand-typed configured `merge.command` (`repoMergeCommandVerdict`, canonical and non-canonical spellings) and (already denied) GraphQL
`enablePullRequestAutoMerge` is DENIED with: "in an owner_approval: chat repository agents merge only through `P merge --pr N` (it checks the owner's
\"merge\" and any open owner stop); the owner merges in the GitHub UI". `gh pr merge --disable-auto` stays allowed (it cancels: the early return in the `pr merge` branch of `checkGh`). Label mode and repos
with no pipeline config (`none`) are unchanged. `P merge` is untouched: its `merge.command` runs inside the CLI as a child process the Bash hook never sees
(merge.mjs:203; git-policy.mjs comment above `ownerGoMode`). Consequences to clean up: `git-wiring.mjs:97` `approvedHead` and `approvedPr`
(owner-go.mjs:266) lose their only caller (delete both and their tests unless a grep at implementation time finds another user); the skill sentence
"a direct `gh pr merge` ... is refused too unless the owner said merge" (skills/ship/SKILL.md:353-355) and README.md:207, :245-250 are rewritten (T6).

### D4. Persistence failure protocol (Codex #4, N3, N4)
One authoritative sequence (the same as D1; `openOwnerStop` and `flushPendingStops` both run inside the per-repo+PR lock):
0. (Same order as D1.) The auto-merge disarm of D1 step 4 runs after the lock and before the events read.
1. **Local intent first, no network.** Repo identity = `parseRemote(git remote get-url origin)` (notify.mjs:351, :685); no remote or unparseable => exit 1
   `stop-not-persisted` before anything is claimed (a repo with no GitHub remote cannot be merged by `P merge` anyway). Mint the id, write
   `owner-stops/<owner>__<repo>__<pr>__<id>.json` atomically. If even that fails: exit 1 `stop-not-persisted`.
2. **Lock** `owner-stop-<owner>__<repo>__<pr>` (locks.mjs:430, `waitMs` 30 s like `withQueueLock`; a `LockTimeoutError` leaves the pending file in place and the PR
   blocked, and the error is surfaced as exit 3).
3. **Read events** (remote). A failure here is the case Codex named: the pending file already exists, so gate, merge, last look and wait refuse on this
   machine, `P summary` exits 3 and still sends the push (the error message adds `owner stop <id> is held locally: P merge refuses until it reaches GitHub;
   tell the owner anyway`; the reply lines go to stderr so the controller can still print them).
4. **Reconcile.** First flush every OTHER pending file of this repo+PR (each file: an event with its id exists, open or released => delete it; otherwise post
   it, then delete it; one file's failure never affects another file). Then, if a stop is open on GitHub, reuse its id and delete our own file; otherwise post
   ours.
5. **Delete our file** only after re-reading it and checking repo, pr and `stop.id` match the stop just confirmed on GitHub (identity-checked cleanup; never a
   path-only unlink). Cleanup in `P checkpoint --resumed` (release) follows the same rule, under the same lock.
6. While ANY pending file exists for the PR, `ownerStopProblems` fails. `flushPendingStops` is called by `ownerStopProblems` (gate, `P merge`, last look,
   wait), `P checkpoint` (incl. release), `P summary` and `P comment`. It is NOT called by `P resume plan|list` or `P inbox`: those stay read-only (resume.mjs:1-3,
   resume-command.test.mjs:88) simply because they never flush, and they do not report pending files either.
A post that timed out but landed is seen on the next list, so it is never duplicated. Two sessions on one machine cannot interleave create/reconcile/delete
(the lock); two machines may leave two open stops, which block together and are released together (D2).
Residual (stated, not solved): the pending file is per machine, so while GitHub was unreachable at the moment of the stop another machine can
still merge; the phone push and the controller's reply are the owner's signal, and the window ends when either machine reaches GitHub.

### D5. Revert PR (R2) (Codex #4)
Chat mode only; label mode keeps the labelled, non-draft revert PR. (1) `prCreate({draft: true, labels: []})` (`prCreator` adds `--draft`); the PR then STAYS a draft: nothing in the
CLI un-drafts it, the owner marks it ready in the GitHub UI after looking, and a draft blocks merge (`pr-open` finalgate.mjs:216, `preMergeProblems` :732). (2) An `owner-stop` event is posted on the NEW PR
number, best-effort (a failure is a warning in the prod-watch output; the draft is the blocker), through a small seam `deps.ownerStopEvent(n, data)` built in prod-watch.mjs
unconditionally (not inside `pr === undefined ? {} : ...`, :95), so `prod-watch --sha` without `--pr` works. No pending file, lock, record copy or `gh pr ready` seam is used for the revert PR.
Incident issue: chat mode creates it with `labels: []` for non-pausing outcomes (pausing keep `pipeline-rollback`); `recovered` next-step text (prodwatch.mjs:233) says
"(owner decision)" in chat.

## Safety analysis — what stops a merge once the label is ignored

| Stop | Enforcer without the label |
|---|---|
| Review item `needsHuman` / pending / unresolved BLOCKING / maxRounds / judge-arbiter not-found / arbiter proof failure / verify-red parked items | `unresolved()` (triage.mjs:288) -> `reviewValidFor` false (:321-329) -> `reviewCheck` fails the gate (finalgate.mjs:485-487); `P review-complete` refuses (review-complete.mjs:28,64); `P merge` refuses a failed gate (merge.mjs:56-58, live 132-135). Enforced, and still enforced after a stop release. |
| Owner-ruled item (`P triage owner-ruling`) | `ownerRuledItems` -> `ownerMerge` (finalgate.mjs:490-494) -> owner-go "merge" for exact head + digest (merge.mjs:84-89, 118). Enforced. |
| Hard-stop hits / test-integrity violations | Chat: `ownerMerge` (hardstops.mjs:1270, integrity.mjs:319, finalgate.mjs:449) -> owner-go "merge". Enforced. |
| update-branch rebase-needed / cycle-cap / head-timeout | Condition persists (`pr-open` finalgate.mjs:212-226; `bringUpToDate` merge.mjs:107-113); the controller's stop is also an owner stop. |
| `merge:command-failed`, `merge:not-merged`, `deploy-url` timeout, required CI check missing, `update-branch:head-timeout` (no state footprint) | **Owner-stop event** from `P summary --outcome needs-human --cause <code>` (D1, D4); gate, merge, last look, wait all refuse (D3). Released only by D2. |
| Resumed runs | `record.resumed` or any release event -> `P merge` demands owner-go (merge.mjs:75-83); unreadable/invalid/unsupported record too (68-72). Enforced. |
| prod-watch revert PR | Created as a draft and left a draft; the owner un-drafts it in the UI (D5). |
| Direct `gh pr merge`, hand-typed merge command, auto-merge on a pinned head after an earlier approval (N2) | Refused outright in chat repos by the guard (D3); agents merge only through `P merge`, which reads the stops and applies the stop-id binding. |
| An owner "merge" recorded before a stop, replayed after it (N1) | Stop-id binding: the approval must have been given to a request carrying the newest stop id (D2); forged releases are denied at the source (D1 guards 2). |

## Tasks (ONE PR; commits in this order, each green)

### T1. Events and record copy: kinds, `openOwnerStops`, `ownerStop` copy, version, mode-aware next (D1)
Files: pipeline/lib/run-events.mjs (`EVENT_KINDS`, `openOwnerStops`), pipeline/lib/run-record.mjs (copy, `v` derivation, `outcomeNext`, status
line, `shapeProblem`), pipeline/commands/summary.mjs, comment.mjs (pass `ownerApproval`).
Tests (test/run-events.test.mjs, run-record.test.mjs, summary tests):
0. `newestStopId(events)` returns the newest `owner-stop` id by comment id, released or not, `null` with none.
1. `openOwnerStops`: open until a readable release of the SAME id; an unreadable-payload stop is open; an unreadable release does not release;
   a release for an unknown id is ignored; a stop/release by another user's comment, or with a quoted marker, is ignored.
2. Record copy: `applyCheckpoint` keeps it; `v` is 2 with the copy, 1 without; an old-CLI decoder (`RECORD_VERSION = 1`) says `unsupported`;
   a malformed copy => `invalid`.
3. `P summary --outcome stopped` and `P comment --kind summary --outcome stopped` after a stop: events still show the stop open; with the record
   replaced, blanked or `ownerStop` hand-removed the gate and merge STILL refuse (Codex #1 regression, both commands + record replacement).
4. Mode-aware next text pinned for both modes (label text unchanged; chat text; unreadable config => label text).
5. Label mode: no event, no copy, `v` stays 1; existing run-record / summary tests unchanged.

### T2. Stop creation, persistence, reader (D1, D3 reader, D4)
Files: new pipeline/lib/owner-stop.mjs (`openOwnerStop`, `flushPendingStops`, `ownerStopProblems`, pending store, `newStopId`), summary.mjs and
comment.mjs (chat + `needs-human` => `openOwnerStop`; output `ownerStop`, `reply`), notify.mjs (`defaultAction('needs-human')`: chat "Rule in
chat, then say ship resume N"; label unchanged), hooks/lib/files-policy.mjs:45 (protect `.claude/pipeline-state/owner-stops`).
Tests (new test/owner-stop.test.mjs; pending files under the real home with random repo/PR names removed in `t.after`, as test/helpers/owner-go.mjs does):
1. Opened: the pending file exists before the FIRST GitHub call (the fake gh records call order), is deleted after the event posts; event data exact; reply
   lines exact; second call reuses the id. Repo identity comes from the local remote with the network down (no `gh` call before the pending write).
1a. Opening a stop in chat mode calls `disableAutoMerge` before the events read; its result lands in the event (`autoMergeDisarmed`); a disarm that fails still posts the stop and the reply carries the warning line; `ownerStopProblems` reports an armed `autoMergeRequest` (chat-only extra view field), label mode adds no field.
1b. Failure injection at the FIRST lookup (N3): the initial events read (viewer / comments list) fails => summary exits 3, push sent once, pending file stays,
   `ownerStopProblems` / gate / `P merge` refuse afterwards; with GitHub back the flush posts the SAME id and removes the file.
2. GitHub down at the post: summary exits 3, push sent once, pending stays, message names the id; once GitHub is back `P final-gate`, `P merge`,
   `preMergeProblems` and the wait refuse until the flush runs; the flush posts the SAME id; a landed-but-timed-out post is not duplicated.
3. Corrupt/unreadable pending file => `ownerStopProblems` fails closed. Local write fails => `stop-not-persisted`.
4. Two open stops (cross-machine race): both block; the reply lists both `Stopped` lines; one owner reply releases both (T3 3b). No `supersededBy` exists.
4b. Interleaving (N4), driven by an in-process gate on the fake gh: two sessions open stops S1 and S2 for the same PR with separate pending files. (i) With the
   lock, B waits, then reads A's posted S1, reuses it and deletes only its own file. (ii) Files for S1 and S2 both exist (two crashed sessions): the flush posts
   S1 OK and the POST of S2 FAILS => S1's file is deleted, S2's file stays, the PR stays blocked, S2 is posted by the next flush; a cleanup that finds a file whose
   `stop.id` is not the one just confirmed leaves it alone. Same for the release cleanup in `P checkpoint --resumed`.
5. Label mode: `ownerStopProblems` returns `[]` with ZERO gh calls; `P summary --outcome needs-human` unchanged (no pending file, no event).
6. The record copy failing to write is a warning only; the stop still blocks.

### T3. Authenticated release + guards (D2, D1 guards)
Files: hooks/lib/owner-go.mjs (`parseResume`, stop lines, `WAIT_LINE`, `releases`, `approvedRelease`, `prompt_sha256` pass-through),
hooks/owner-go.mjs (message names recorded releases), pipeline/commands/checkpoint.mjs (release, `owner-stop-open`, `owner-release-missing`,
flush at start), hooks/lib/git-policy.mjs + guarded-text.mjs (comment-edit and forging rules; `directMergeVerdict` refuses direct merges in chat), hooks/lib/git-wiring.mjs
(drop `approvedHead`), hooks/lib/owner-go.mjs (`stop` argument and `requests[].stops` in `approvedRequest`/`presentedRequests`; delete `approvedPr` if unused; resume prompts record `requests: []`; leading-slash `/ship resume`),
pipeline/lib/run-events.mjs (`newestStopId`), pipeline/commands/merge.mjs (stop-id binding in step 1a), pipeline/commands/final-gate.mjs (print `stop`), hooks/lib/git-policy.mjs
(curl / wget / http / xh branch), docs/cli.md checkpoint entry.
Tests (test/owner-go.test.mjs, guard-owner-go.test.mjs, checkpoint.test.mjs, guard-git.test.mjs, test/helpers/owner-go.mjs gets `stopReply` / `resumeSays`):
1. Self-resume with no owner prompt: `--resumed` on an open stop exits 1 `owner-release-missing`; the stop stays open.
2. Approval predating the stop: an owner "merge" for the same head/items recorded BEFORE the stop does not release it; a release naming another
   stop id does not release it; a release for a first stop cannot release a later one.
2b. Stop-id binding: `approvedRequest` with `stop` rejects a record whose `requests[].stops` lack the newest id (a pre-stop approval has none); accepts one that lists it; a PR with no `owner-stop` event
   passes no `stop` and behaves as before; a failed events read at `P merge` => refusal.
3b. Several `Stopped` lines for one PR bind all ids; `--resumed` releases every open stop the reply named and one owner reply is enough; a stop not named stays open (`owner-release-missing`).
3c. `/ship resume 12` and `/resume 12` (leading slash) are accepted; other slash words are not.
3. Valid later release: reply with `Stopped #N · stop <id>` + `⏸ ...`, owner types `ship resume N` => `releases {N, id}`; `--resumed` posts the
   release event (releaseRef = the owner-go record), clears the copy and the pending file, stamps `resumed`; older than 24 h or a subagent prompt => nothing.
4. Prompt grammar: `ship resume 12`, `resume #12`, `Resume 12 please` accepted; `resume?`, `do not resume`, `resume later` not. Terminal-block rules: a stop
   line with prose between it and the last line, after the last line, or twice for one PR binds nothing.
5. "merge" path: shape-B reply, owner says "merge" => request + release recorded; chain release -> final-gate -> `P merge` merges (gate-env helpers);
   unresolved BLOCKING item => stops at the `review` check; gate head/items changed since the reply => `P merge` refuses.
6. Forged release, END TO END (N1): an owner "merge" for head H / digest D is recorded (its reply carried no stop id); merging then fails and stop S is opened; a well-formed `owner-stop-released`
   comment for S is injected as the viewer would via GraphQL `addComment` (the reducer accepts it, S is released); the gate is regenerated; `P merge --owner-approved-head H --owner-approved-items D`
   is REFUSED because no recorded "merge" carries stop S (the resumed rule also applies); the controller then prints `Stopped #N · stop S` + Head + the merge line, the owner types "merge", and the same command merges.
   A release from another user, an unreadable release payload, and a release for another id release nothing.
6b. "resume" records no merge approval: after a `Stopped / Head / 🔀` reply the owner types `ship resume N` => the owner-go record has `requests: []` and
   `releases` only; `approvedRequest(pr, H, D)` stays false; `P merge` with the flags is refused.
6c. Direct merges (N2): after a valid same-session, same-head approval an unreleased stop exists => `gh pr merge N --match-head-commit H`, `--auto`, the hand-typed
   `merge.command` (canonical form and variants, npm/yarn/pnpm spellings) are all DENIED in a chat repo; the same commands with NO stop are denied too (agents merge
   only via `P merge`); `gh pr merge N --disable-auto` is allowed; label-mode and no-config repos behave as before; the existing "allowed with approval" assertions in
   guard-owner-go.test.mjs (:28 and the GH_REPO / -R cases) are inverted for chat. `P merge` itself still merges in the CLI test (child process, no hook).
7. `P checkpoint` without `--resumed` on an open stop exits 1 `owner-stop-open`; `ended` / `awaiting-owner-merge` steps still accepted.
8. Guards denied: `gh api -X PATCH repos/o/r/issues/comments/1`, `--method=DELETE`, `repositories/{id}/issues/comments/1`, `gh pr comment 3 --edit-last`,
   `gh issue comment 3 --delete-last`, graphql `updateIssueComment`, `gh pr comment 3 --body '<!-- claude-pipeline:event:owner-stop-released:ab12cd34 -->'`,
   the same via `--body-file`, `gh api repos/o/r/issues/3/comments -f body=...marker...`. curl / wget / http / xh (guard-git.test.mjs): `curl -X PUT https://api.github.com/repos/o/r/pulls/3/merge`, `curl --request PATCH .../issues/comments/9`, `curl -d @f .../issues/3/comments`
   with the marker, `curl --data ... https://api.github.com/graphql`, `wget --method=PUT`, `http POST api.github.com/...`, `xh PUT ...`, `curl -X POST "$URL"` / `curl "https://api.github.com/$(...)"` => denied; `curl https://api.github.com/repos/o/r/pulls/3` (GET), `curl -X POST https://example.com/x` => allowed. Allowed: `gh pr comment 3 --body x`,
   GraphQL: `-f query='mutation{addComment(input:{subjectId:"x",body:"<marker>"}){clientMutationId}}'`, the marker passed via `-f body=` / `-F body=@file` / percent- or
   escape-encoded, an `--input file.json` whose variables carry it, `addPullRequestReview` with the marker; an UNREADABLE body for any of these routes
   (`--input -`, `-F body=@missing`, `gh pr comment -F -`, a run-time-built query) => denied. Allowed: `gh pr comment 3 --body x`,
   `POST .../issues/3/comments` with ordinary readable text, `GET .../issues/comments/1`, the other allowed mutations (guard-git.test.mjs:850's `addComment`
   case keeps passing with ordinary text). Run guard-count-parity and docs-fact tests.
9. Label mode: `--resumed` behaves exactly as today (no event lookup, no release lookup).

### T4. Gate, merge, auto-merge (rev 1 T1 + D3)
Files: pipeline/lib/finalgate.mjs, pipeline/commands/merge.mjs (final-gate.mjs already passes `config`).
- `blockingLabelsOf(labels, {ownerApproval})`: chat drops `needs-human` (case-insensitive); default unchanged.
- `labelsCheck(info, {ownerApproval = 'label', stopProblems = []})`: label mode identical strings. Chat: ignore `needs-human` (detail `no blocking
  labels (needs-human ignored: owner_approval chat)` when present); an open stop fails with `owner stop <id> (<cause>) is open (only the owner's reply
  releases it): say "ship resume N", or "merge" when offered`; `awaiting-review`, `pipeline-blocked` still block. `evaluateGate` (finalgate.mjs:639)
  awaits `ownerStopProblems` in chat only (a throw => the `safely` wrapper fails the check). CANONICAL_CHECKS name `labels` kept.
- `preMergeProblems({gh, pr, head, ownerApproval, root})` and `waitBlockers(gh, {pr, root, ownerApproval})`: label ignored in chat, `ownerStopProblems`
  appended (chat only). merge.mjs: step 1a refuses `error: 'owner-stop'` BEFORE `bringUpToDate`, treats "any release event" as resumed, and passes `stop = newestStopId(events)` to `approvedRequest` (merge.mjs:73; the stop-id binding of D2); :161 and
  :221 pass `config.owner_approval`, `pr`, `root`.
Tests (test/finalgate.test.mjs, merge-owner-approval.test.mjs, gate-fix-merge.test.mjs, cli-gate-merge.test.mjs; each must fail on current main):
1. chat, leftover label, clean gate, no stop => `labels` ok, gate ok. Label mode with the label => today's exact text (pin finalgate.test.mjs:103).
2. chat, review item `final.needsHuman`, no label => `review` fails.
3. chat, open stop => `labels` fails with the stop detail; record `invalid` / `unsupported` => `labels` passes (merge's own guard applies); `listComments`
   throws => fails (`could not evaluate`).
4. Mirror gate-fix-merge.test.mjs:106: chat, stop event appears after the live gate (scripted comments read in `preMergeProblems`) => `pre-merge` refusal,
   merge command never ran; read failure => refusal; label mode script unchanged (no extra gh call, existing pin passes).
5. Mirror cli-gate-merge.test.mjs:323: chat, stop appears while auto-merge is queued => wait `blocked`, `pr merge 12 --disable-auto` runs, reason names
   the stop; read failure mid-wait => same.
6. `P merge` with leftover label + clean gate + owner-go => merges in chat; label mode keeps refusing.
7. The progress write at merge.mjs:154 (and a concurrent summary/checkpoint writer) does not affect a stop that landed after the live gate.
8. Stop-id binding through `P merge`: chat, owner "merge" for H/D given to a request without a stop line, stop S created and released => `P merge` with the flags is refused until the owner says "merge" to a request that carries `Stopped #N · stop S`; no-stop PRs merge on a plain approval exactly as before; label mode never consults events.
Must stay green: test/cli-gate*.test.mjs, gate-fix-merge.test.mjs, cli-gh.test.mjs.

### T5. Resume routing, inbox, prod-watch revert PR (rev 1 T2 + D5)
Files: pipeline/lib/resume-plan.mjs, inbox.mjs, prodwatch.mjs (`report()`, seam `ownerStopEvent`), commands/prod-watch.mjs (`--draft`, seam), no `prReady`.
- resume-plan: thread `ownerApproval` into `route()`/`midRunLabel`. Chat: label never read (skip LABEL_NOTE :85, gate note :162, label branch :109);
  `enter: 'decision'` when `facts.triage.needsHumanItems.length > 0` (reason "review items need the owner's ruling in chat: <ids>"); open stops from
  `openOwnerStops(facts.events)` add the note "stop <id> is open: `P checkpoint --resumed` needs the owner's reply" and do not change `enter`. Label mode unchanged.
- inbox: chat ignores `midRunLabel` (:172), the label branch (:182-190, incl. the "label-mode leftover" text :184-186) and `LABEL_FRAGMENT` (:240-263);
  `waitingOn = 'owner-decision'` when `openOwnerStops(f.events)` is non-empty or `needsHumanItems` are open; `nextAction` `leave: owner decision needed
  (<cause or reason>); rule or reply in chat, then ship resume N`. Leftover label alone changes nothing; `owner-merge` drops `!midRunLabel` (:218).
- prod-watch: D5.
Tests (resume-plan.test.mjs, inbox.test.mjs, resume-command.test.mjs, inbox-command.test.mjs, prod-watch.test.mjs):
1. chat, leftover label, no stop, clean review => routes `gate`, no label note, stop `awaiting-owner-merge`.
2. chat, open needsHuman items => `decision` (label not required); open stop => note, normal enter.
3. Intentionally update the two chat-mode pins that encode the label: resume-plan.test.mjs:362 (the label-still-on `decision` assertion becomes label-mode
   only; the chat `gate` / `review` cases stay) and inbox.test.mjs:232 ("label-mode leftover: chat repo + hard-stop-only": chat now says owner-decision
   only with a stop or open items). Label-mode twins stay as they are.
3b. `resume plan` / `resume list` / `inbox` stay read-only with a pending stop file present: the fake gh sees NO write call (resume-command.test.mjs:88) and their output is unchanged by the file; `checkpoint`, `final-gate` and `merge` do flush it.
4. inbox chat: leftover label alone => no `owner-decision`; stop event => `owner-decision`; `awaiting-owner-merge` + leftover label => `owner-merge`, not `pipeline`.
5. prod-watch chat: incident issue without `needs-human`; revert PR created `--draft`, no label, and never un-drafted by the CLI (no `pr ready` call); the owner-stop event is posted on the NEW PR; the event post fails => warning only, PR still a draft, a later `P merge` on it refuses (draft);
   `--sha` without `--pr` posts the event on the revert PR; label mode keeps today's labels and non-draft PR (existing tests pass).

### T6. Skill and doc text (no code)
Every chat-mode "add needs-human" becomes "stop with `P summary --outcome needs-human [--cause C]`, print its `reply` lines, wait" (label mode keeps
`gh pr edit N --add-label needs-human`). Keep invariant 2's "never remove ..." wording (SKILL.md:21). Label hook guards unchanged (git-policy.mjs:26,80;
guarded-text.mjs:9). Document: the stop reply lines, the release chain ("ship resume N" or "merge", then `P checkpoint --resumed`, final-gate, merge), the
new-session confirmation, the pending-stop file, events as authority, and mixed-version behaviour (`pipeline update` on every machine).
- Skill text for the new rules: (a) every merge request for a PR that has an owner-stop event starts its terminal block with `Stopped #N · stop <newest id>` (from `P final-gate` `stop`), plus a warning line when the disarm failed; (b) after a merge attempt that moved the branch (`update-branch` / `behind-base`), run `git pull --ff-only` BEFORE `P checkpoint --resumed`; (c) the owner may type `/ship resume N`; (d) agents never merge by `gh pr merge`, the merge command or `curl`; (e) eaglewatch leftover labels block until its merge-gate PR lands, the owner removes them in the UI.
- skills/ship/SKILL.md:353-355 ("How the \"merge\" is recorded"): replace "a direct `gh pr merge`, the repo's merge command typed by hand, or auto-merge through the API is
  refused too unless the owner said \"merge\" ..." with: in an `owner_approval: chat` repo a direct `gh pr merge` (any form, incl. `--auto`), the repo's merge command
  typed by hand and auto-merge through the API are always refused; merge only with `P merge --pr N` (it reads the owner's recorded "merge", which must be recorded after
  the newest owner stop id, and any open stop). Same for README.md:26, :207 ("guard-git refuses a direct merge in a chat repo without one" => "always refuses a direct
  merge in a chat repo") and :245-250 (last sentence about pinning), and gates-and-exits.md rows 75-79 (add the "no owner merge for stop <id>" reason).
- skills/ship/SKILL.md: :26-30, 57-58, 70-71 (split the stop shape by mode), 103, 167, 177-182, 198-201 (chat `--action` "Rule on <ids> in chat (accept /
  follow-up / reject), then say ship resume N"), 225, 229, 254, 260, 290-292, 321-322, 397, 408, 425, 438-443; add the stop-reply and release steps next
  to the Owner-merge approval section.
- reference/review-loop.md: :77, 79, 97, 119, 121, 138, 159-167, 182 ("Owner rules in chat" step 4: continue with `P checkpoint --pr N --step review|gate
  --resumed` after the owner's reply, or the owner says `ship resume N`; no label to remove).
- reference/gates-and-exits.md: :15-16, 23, 32-35, 53-56, 80-81, 97; add the owner-stop row under `labels`.
- reference/pr-and-summary.md: :1, 47-57, 76. proof-switches.md:11 (chat note only). skills/pipeline-setup/SKILL.md:11, 141.
- README.md:150, 184, 349, 355, 376; docs/cli.md: :102-105, 192-195, 358, 372, 464, 511-514, 650 + final-gate, checkpoint, summary, merge entries (stop,
  `reply`, `owner-stop` / `owner-release-missing` / `owner-stop-open` errors); event kinds list.
- templates CLAUDE-block.md:16, CODEOWNERS:1, pipeline.yml:86: wording for both modes.
- Tests: test/docs-facts.test.mjs + doc-pinned tests; doc-fact tests that SKILL.md and review-loop.md mention the chat-mode stop lines, `ship resume` and
  `--resumed`, and that every documented error code exists in code.

### Size estimate (ONE PR, owner decision; far above the ~500-line guide, so review in task order)
Non-generated lines changed, rough: T1 code ~110 / tests ~140; T2 ~260 / ~280; T3 ~380 (owner-go ~100, git-policy incl. curl branch ~170, checkpoint ~70, merge + final-gate ~40) / ~450; T4 ~90 / ~200; T5 ~150 / ~160; T6 docs and skill text ~250.
Total about 990 code + 1,230 tests + 250 docs, roughly 2,450 lines.

## Rollout and rollback (mixed versions)
- Order: merge, then `pipeline update` on every machine (Mac and PC) so the CLI, skill text and owner-go hook move together.
- New CLI + old hook: stops open but cannot be released (no `releases`); `owner-release-missing` says to run `pipeline update`.
- Old CLI + an open stop: it ignores events, but the record copy makes the record v2 => `unsupported` => old `P merge` demands the owner's recorded
  "merge"; old writers refuse to touch it. The tripwire is best-effort (copy write failures are warnings), which is why it is only a rollout aid.
  Once every install is current it could be dropped; keep it until the owner says so.
- **Coordinated upgrade is required, and the gap is a stated residual.** An old CLI neither reads events nor applies the stop-id binding: with an open stop it only
  refuses when it sees the v2 copy (best-effort), and it accepts any earlier matching owner "merge" (24 h window) once the copy is missing or the owner-go
  record it consults is the old one. So: BOTH machines (Mac and PC) run `pipeline update` and confirm the installed version (`cliVersion` in a fresh run record /
  `pipeline --version`) BEFORE the eaglewatch re-vendor / consumer PR flips anything (a repo to `owner_approval: chat` with label-free stops, or skill text that
  stops without the label). Until then keep label mode on any repo that a not-yet-updated machine can merge.
- Rollback of this PR: events stay on the PRs as ordinary comments (old CLIs ignore them); records with a copy stay unsupported for the old CLI until the
  owner says "merge" or edits the comment; no data loss.
- Leftover `needs-human` labels are ignored by the new CLI in chat mode and still honoured by old CLIs (they refuse, as today). **eaglewatch:** its own merge script (`labelBlockers`, scripts/lib/merge-gate.mjs) still refuses a leftover label, so old labels there do NOT unstick until the eaglewatch merge-gate PR lands; the owner removes them in the GitHub UI meanwhile.

## Out of scope / follow-ups
- **eaglewatch (separate repo, separate PR):** `merge.command` there is `npm run merge -- {pr} --no-update --expect-head {sha}` -> scripts/merge-pr.mjs ->
  scripts/lib/merge-gate.mjs `labelBlockers` (~173-200) refuses `needs-human` without `human-approved`. Change: skip that rule when `.claude/pipeline.yml`
  has `owner_approval: chat` (vendored config loader if present; fail closed to label behaviour if unreadable); also merge-gate.mjs:1208, :1470,
  .github/workflows/README.md:347-359, scripts/__tests__/merge-gate.test.ts. Base on origin/main. Until it lands, `P merge` in eaglewatch for a PR carrying a
  leftover label still stops at that script (fails closed). Other consumer repos with their own merge script need the same check (unverified).
- Extending the forging guard to the older event kinds (`prod-before`, `rollback-*`, `ci-proof-used`) is a separate hardening idea for the owner to prune.
- Leftover labels on old PRs stay; the pipeline CLI ignores them in chat mode (eaglewatch: see Rollout).
- Follow-up, NOT in this PR: a settings deny / permission suggestion for agent-driven browser tools (Playwright / Chrome MCP) on github.com, which can click or call the API with the owner's login.
- Residuals stated, not solved: event append-only-ness is guarded for agent commands only (the owner's GitHub UI, an admin, `node -e fetch` / `python -c` / any program the agent writes, or an agent-driven browser tool on github.com can
  still edit, remove or forge a comment: owner-go.mjs:10-12, server-side backstop issue #65); the pending file is per machine (D4); unreadable config in
  summary/comment falls back to label behaviour (accepted).

## Verify
`node scripts/verify.mjs --quick` while iterating; `node scripts/verify.mjs` (full) before the PR. This repo is `owner_approval: chat`; the PR stops for the
owner's "merge" for the exact head.

## Revision log
### Codex review of rev 1 -> rev 2 (kept in 2.1, adjusted where the owner decisions changed the mechanism)
| Codex finding | Resolution |
|---|---|
| #1 P1 other summary writers (`P summary`, `P comment --kind summary`, record replacement, direct comment edits) clear R1 | The stop no longer lives in anything those writers touch: it is an append-only `owner-stop` event (D1), read by every guard; the record holds a display copy only. Comment edit/delete and forged-event guards added (T3). Tests: T1 3, T3 6, 8. |
| #2 P1 `--resumed` unauthenticated; an earlier approval can release a later stop | Release needs an owner-go record naming `(pr, stop id)` from the owner's typed `ship resume` / `merge` after a reply carrying `Stopped #N · stop <id>`; ids are random per stop (D2); the release is itself an event with a `releaseRef`; exact head + digest still checked by `P merge`. Tests: T3 1-4, 6. |
| #3 P1 last merge check and auto-merge polling lose the blocker; merge.mjs:154 overwrite window | `ownerStopProblems` (events, PR passed explicitly, fail closed) in the gate, `P merge` step 1a, `preMergeProblems` and every `waitBlockers` poll; `abandonMerge` disables auto-merge; progress writes cannot touch events (D3). Tests: T4 4, 5, 7. |
| #4 P1 failed stop persistence leaves a mergeable PR; revert PR unlabeled with a warning-only record | Local pending file first, event second, flushed later, blocks while present (D4). Revert PR created as a draft, un-drafted only after its event posts, wired for `--sha` without `--pr` (D5). Rev 1's summary premise corrected (exit 3 already). Cross-machine residual stated. Tests: T2 1-4, T5 5. |
| #5 P2 "merge" unblock has no working transition | End-to-end chain defined (D2); unresolved findings still block. Tests: T3 5. |
| P3 mode-aware `OUTCOME_NEXT` | `outcomeNext(outcome, {ownerApproval, stop})`, both modes pinned (T1 4). |
| WC rollout/rollback for older CLIs | Version-2 record copy as the tripwire; verified at each old-CLI call site; "Rollout and rollback". |
| WC preserve label-mode routing; update pinned tests (`!midRunLabel`, resume-plan.test.mjs:362, inbox.test.mjs:232) | T5 keeps label branches, updates exactly those pins intentionally, adds label-mode twins. |
| WC consumer merge scripts (eaglewatch) | Named dependency in Out of scope; fails closed until it lands. |
| WC static conclusions; failure injection, concurrency, release, label regression needed | Each task lists failure-injection, concurrency, release and label-mode regression tests; full `node scripts/verify.mjs`. |

### Codex recheck of rev 2.1 -> rev 3 (all four findings verified against the code first)
| Finding | Verified | Resolution |
|---|---|---|
| N1 P1 GraphQL `addComment` forges a release; the resumed rule does not stop approval replay | Yes: `addComment` is allowed (git-policy.mjs:35, guard-git.test.mjs:850); `checkGraphql` judges names only (:792-808); `gh` is exempt from the marker scan (guarded-text.mjs:14); `approvedRequest` has no time floor (owner-go.mjs:259) | (a) Forging guard now covers every comment-creating route: `gh pr/issue comment` body and body-file, REST comment POSTs, GraphQL `addComment` / review mutations incl. variable fields, `--input` files, decoded values; an unreadable body on those routes is denied (D1 guards 2). (b) Independent replay closure: rev 3 used a timestamp floor; rev 4 replaced it with stop-id binding (see the Fable table). Tests: T3 2b, 6, 8; T4 8. |
| N2 P1 direct merge commands bypass the stop reader | Yes: `directMergeVerdict` allows a pinned direct merge when `approvedHead` finds any same-head approval (git-policy.mjs:~920-933, git-wiring.mjs:97); it reads no events or pending files | In chat repos the guard refuses agent direct merges outright: `gh pr merge` (any form, `--auto`), hand-typed `merge.command`, API auto-merge (already denied); `--disable-auto` stays allowed. `P merge` is unaffected: it runs `merge.command` inside the CLI, a child process the hook never sees (merge.mjs:203; git-policy.mjs comment above `ownerGoMode`). The documented "owner said merge, then direct merge" path (SKILL.md:353-355, README.md:207, :245-250) is removed and the text rewritten; `approvedHead` / `approvedPr` deleted if unused. Test: T3 6c (valid same-head approval + unreleased stop + direct merge => denied; also denied without a stop). |
| N3 P1 D1 reads GitHub before the local pending write | Yes: D1 said read first, D4 said pending first | One sequence everywhere (D1 steps 1-8, D4): local intent file first (repo identity from the local git remote via `parseRemote`, no network), then lock, then read events, reconcile ids, post, cleanup. Test: T2 1, 1b (failure injection at the first lookup). |
| N4 P1 shared pending file lost-write / delete race | Yes: one file per repo+PR, atomic rename only protects torn JSON | One pending file per stop id, identity-checked cleanup (re-read, repo + pr + id), create / reconcile / delete serialized per repo+PR with `withLock` (locks.mjs:430). Test: T2 4b (one POST succeeds, one fails; B waits then reuses). |
| Suggestion P2: keep `resume plan` / `resume list` read-only | Yes: resume.mjs:1-3, resume-command.test.mjs:88 | `P resume` and `P inbox` no longer flush; they only read pending files and report them; flush happens in checkpoint (incl. release), final-gate, merge, summary, comment (D4 step 6). Test: T5 3b. |
| WC: "resume" must record no merge approval | Yes: `recordApproval` would otherwise bind a shown Head line to any prompt | Resume prompts write `requests: []`, only `releases` (D2). Test: T3 6b. |
| WC: rollout gap (old clients accept earlier approvals) | Yes | Kept as a stated residual with the procedure: both machines `pipeline update` and confirm the version before the eaglewatch re-vendor / consumer PR flips anything (Rollout). |

### Fable adversarial review of rev 3 -> rev 4 (all adopted by the controller)
| Finding | Resolution |
|---|---|
| BLOCKING 1: `curl` / `wget` / `http` / `xh` with the viewer's token bypass every gh rule (verified: no such branch; `curl` appears only in a word list, git-policy.mjs:1925) | New guard branch: non-GET to `/pulls/N/merge`, `/merges`, `/git/refs`, `/issues/comments/ID`, `/issues/N/comments` (marker scan) and `/graphql` on github hosts is denied; run-time-built github URLs denied. `node -e fetch` / `python -c` stated as the residual; the `guardedCommandText` `node -e` marker stop-gap is dropped (CUT 4). Tests: T3 8 (guard-git.test.mjs). |
| BLOCKING 2: timestamp floor depends on two clocks and a comment field | Replaced by stop-id binding: every merge request for a PR with any owner-stop event carries `Stopped #N · stop <newest id>`; owner-go records `requests[].stops`; `approvedRequest({pr, head, items, stop})` requires the newest id. All `createdAt` / `latestStopAt` / skew / Infinity text and tests deleted (T1.0, T3 2b, T4 8 rewritten). Forged-release e2e kept, now refused for the missing stop id (T3 6). |
| SHOULD-FIX 3: a queued auto-merge can fire on a stopped PR | Opening a stop calls `disableAutoMerge` first, records `autoMergeDisarmed` in the event, the reply warns when false; `ownerStopProblems` reports an armed `autoMergeRequest` (D1, D3; T2 1a). |
| SHOULD-FIX 4: several Stopped lines for one PR | All ids bind; `--resumed` releases every open stop named; `supersededBy` removed (CUT 1) (D2; T2 4, T3 3b). |
| SHOULD-FIX 5: slash form | `parseResume` accepts a leading slash (T3 3c). |
| SHOULD-FIX 6: branch moved before checkpoint | Skill text: `git pull --ff-only` before `P checkpoint --resumed` (D2, T6). |
| SHOULD-FIX 7: eaglewatch labels do not unstick | Rollout and Out of scope say so; owner removes labels in the UI until the eaglewatch merge-gate PR lands. |
| SHOULD-FIX 8: agent-driven browser tools on github.com | Residual plus a follow-up (settings deny suggestion), not in this PR. |
| CUT 1 supersededBy; CUT 3 revert PR stays a draft, event best-effort, no `prReady`; CUT 4 `node -e` marker scan; CUT 5 no pending-stop reporting in resume / inbox | Applied (D1, D4, D5, T5). **CUT 2 was not described in the instruction I received; nothing was cut for it. The controller should confirm which item it was.** |

### Owner decisions 2026-10-20 (rev 2 -> rev 2.1)
| Decision | What changed in the plan |
|---|---|
| 1. Append-only event log is the authority for stops | New event kinds `owner-stop` / `owner-stop-released` (id-matched, like `rollback-intent` / `rollback-result`); every reader uses events (gate `labels`, `P merge` 1a, `preMergeProblems`, `waitBlockers`, `P checkpoint`, resume-plan and inbox via `facts.events`). Dropped from rev 2: the `upsertComment` `keep` check, `OwnerStopError`, `releasedStops`, and record-based preservation as a safety property. The record `ownerStop` + `v: 2` is KEPT as display and as the old-CLI tripwire (old CLIs ignore events, so without it an old install would merge a label-free stop; stated in Code facts and Rollout). Run-events trust model documented with file:line: comments authored by the viewer, created by POST, append-only only by convention. Comment-edit guard KEPT (events are comments); a forging guard for marker-bearing comment bodies ADDED; "resumed" now also means any release event, so even a forged release cannot reach a merge without the owner's recorded "merge". |
| 2. One PR, no split | Header and Tasks say ONE PR; no split proposed. |
| 3. New-session resume needs one extra confirming "resume N" | Written into D2 and T6 as the accepted design. |
| 4. Pending file in the account dir + files-policy protection; broad comment-edit guard; unreadable-config fail-open edge | Accepted as written (Data shapes, D1 guards, T2/T3, Residuals). |
