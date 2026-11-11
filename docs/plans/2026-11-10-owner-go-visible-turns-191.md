# #191 — owner-go: invisible turns and queued answers, the same for every reader

Issue: ianjamila/claude-pipeline#191 (found while building #189). Base: main b3d809d. Branch `agent/owner-go-visible-turns`.
Risk: high (pipeline core: what makes an owner's "merge", "extra round" or ruling count). Lane: Fable.

## Problem

1. **Invisible turns bind a merge or round request.** `recordApproval` (`lastRequestText`) and `recordRoundGrant` (`lastReplyText`)
   read the reply slot WITHOUT `skipSynthetic`. In that mode every prompt entry is a boundary, including a synthetic one, so the
   text of a turn started by a headless `claude -p --resume <session>` (promptSource `sdk` / entrypoint `sdk-cli`) — which writes
   into the owner's transcript and renders NOTHING in the owner's terminal — becomes "the reply before the owner's prompt". If it
   ends with a 🔀 or round-request line, the owner's next "merge" / "extra round" (meant for the request they DID see) binds to it.
   The `Head <sha12> · items <digest>` line narrows what can be bound, not which PR. #189 already applies a visibility rule to
   rulings (`skipSynthetic`: only `promptSource: system` + `entrypoint: cli` turns are visible and may promote; any other synthetic
   turn never forms a slot and voids the slot before it when it shows anything).

2. **Queued answers to owner-turn asks.** A prompt typed while the agent is busy (`promptSource: queued`) is delivered after
   everything the agent printed meanwhile, so it is read as the answer to the LAST ask of that reply, which may be newer than what
   the owner had on screen when typing ("merge" typed for #5 while the agent goes on and ends with 🔀 for #6). #189 refuses a
   queued answer only to a PROMOTED synthetic-turn ruling ask; owner-turn asks (all three kinds) are open.


## Facts (probed 2026-11-10, Claude Code transcripts on this Mac)

- A prompt typed while busy is delivered with `promptSource: "queued"` after everything the agent printed meanwhile.
- Claude Code also writes `{"type":"queue-operation","operation":"enqueue"|"dequeue"|"remove", …}` entries. They are NOT a usable
  record of when the owner typed (Codex plan review P1 confirmed by data): subagent hand-backs enqueue WITHOUT `content` (the same
  shape as a typed prompt) and are later `remove`d WITH content; replaying the operations of session ccef88f2 from its start leaves
  5 items "in the queue" forever (no drain at idle), 5 `remove`s match no content-bearing item, and 13 of 16 `typed` prompts
  see a non-empty replayed queue. So the plan does NOT pair a queued answer with its enqueue marker (the rev 1 design is dropped).
- Queued answers are rare: 1 queued prompt in this whole two-day session (ccef88f2).
- Existing records (2026-11-10): 112 extra-round grants (96 with prompt_id, 16 legacy without); **0 of the 96 came from a queued
  prompt** (prompt ids cross-checked against every `promptSource:"queued"` entry in both accounts' transcripts). Merge records live
  24 h; 2 merge records ever came from a queued answer (both long expired).
- All use-time consumers go through `ownedBy` → `promptProvenance` (merges `approvalGap`/`approvedPr`, rulings `ownerRuled`,
  rounds `ownerGrantedRounds`/`verifyOwnerGrant`, codex-review's cap message). Record-time readers: `recordApproval`,
  `recordRoundGrant`, `recordRuling` (all called by hooks/owner-go.mjs for every prompt).

## Design

### Part A — one visibility rule for every reader (`lastReply`)

Define `visibleSynthetic(e) = entrySource(e) === 'synthetic' && e.promptSource === 'system' && e.entrypoint === 'cli'`
(today's `promote` test, named and shared). An **invisible turn** = a prompt entry with `entrySource === 'synthetic'` that is
not `visibleSynthetic`.

- A1 `skipSynthetic: true` (rulings): unchanged (#189 rules).
- A2 `skipSynthetic: false` (merge, round): an invisible turn is still a boundary (it opens a new, EMPTY slot exactly as today, so
  an older request stays stale — merges stay strict), but its assistant text is NEVER added to that slot. No text an invisible turn
  prints can be bound; the owner is asked again (the existing cost of the strict rule). Visible synthetic turns (system + cli: a
  task notice the UI renders) and owner/unknown prompts: unchanged.
- A3 **Unknown origin = invisible** (Codex P1-2): the tail read (`tailEntries`, last 4 MB) may start inside a turn whose prompt
  was cut off, so the text collected before the first prompt entry of the window (slot 0) has no known origin. `tailEntries`
  reports whether it reached the file start; when it did not, slot 0 is never returned (all modes): if the chosen slot is 0, the
  reply is '' (and `promoted: false`). Likewise in skipSynthetic mode a turn cut at the window start is not promotable (it has no
  prompt entry, so it already is not). When the file start WAS reached, slot 0 is text before any prompt (none in a real
  transcript): also refused — slot 0 is simply never a reply.
- A4 "current prompt" (Codex uncertainty): `lastIsPrompt` / `current` compare only text. A synthetic prompt with the SAME text as
  the owner's (e.g. a resumed sdk turn that sends "merge") must not make the reader skip the wrong slot: the recorders already return
  null when the current entry is synthetic (`notOwnerWords` → `currentEntryIsSynthetic`); add tests that pin this (a same-text sdk
  prompt as newest entry ⇒ nothing recorded, all three recorders).

### Part B — a queued answer never binds (every kind; record time AND use time)

Rule: **an answer the owner typed while the agent was busy (`promptSource: 'queued'`) records nothing and approves nothing** —
for "merge", "extra round" and rulings alike. The agent shows the request again; the owner answers once more. This is the
fail-closed form: the transcript cannot tell what was on screen when the owner typed (Facts), and a queued answer can otherwise
land on a newer ask. It subsumes #189's narrower rule (a queued answer to a promoted synthetic-turn ruling ask).

1. **Record time** (`recordApproval`, `recordRoundGrant`, `recordRuling`): when `currentPromptEntry(...)` is present and its
   `promptSource === 'queued'`, return null. (The hook may run before the transcript has the entry: then it records as today and
   use time refuses.)
2. **Use time** (`promptProvenance`): a found prompt entry with `promptSource === 'queued'` ⇒ `'synthetic'`, for every record
   kind (replaces the `ask_turn === 'synthetic' && queued` line; `ask_turn` stays written for the audit trail).
3. **Hook message** (rule 1 of the owner's working rules — the owner must not be left wondering): `hooks/owner-go.mjs` prints one
   line when the prompt parses as a "merge", an "extra round" or a ruling answer but nothing was recorded BECAUSE the current entry
   is queued: `[claude-pipeline owner-go] the owner's answer was typed while the agent was still working, so it is not recorded:
   show the request again (the closing lines) and ask once more.` (Exported constant + `queuedNudge(input)` in lib/owner-go.mjs;
   same never-throw, never-block contract; replaces the ruling nudge for that prompt.)
4. **Refusal texts** (use time): merge.mjs `missingApproval`, codex-review.mjs `unconfirmedGrant`, triage.mjs (line ~335, Codex P3)
   add "or was typed while the agent was still working" to the provenance explanation. Wording only; the `'provenance'` code is
   unchanged so every caller and test of it stays intact.

### Compatibility (Codex P1-3)

- Merge and ruling records expire (24 h): no stranding.
- Consumed extra-round grants are re-verified indefinitely (`verifyOwnerGrant`, final-gate, review-complete). Measured: 0 of the
  96 id-bearing grants came from a queued prompt. The 16 legacy grants (no prompt_id, pre-#128, matched by text; 8 sessions, some
  of whose transcripts do hold queued prompts) all back PRs that are MERGED or CLOSED (cp #145 #148; EW #1604 #1639 #1640 #1642
  merged, #1647 closed; checked 2026-11-10), and a grant is re-verified only by final-gate / review-complete / merge of its OPEN PR.
  So the rollout is scoped with **no affected open PR**: no recovery path is needed and none is claimed (Codex recheck P1). No
  grandfathering of ambiguous authorization. If a closed PR such as #1647 were reopened and a legacy queued grant then refused, that
  PR is parked for the owner (the existing refusal) — stated in the PR body as the accepted residual. Test: a consumed legacy
  (no prompt_id) grant whose text-matched entry is queued ⇒ `verifyOwnerGrant` refuses (pins the behaviour).
- Rollback: reverting the PR restores the old rules; no record format changes (nothing new is written except the nudge line).

## Tests (failing first; each reader)

New file `test/owner-go-visible-turns.test.mjs`, fixtures built like the existing owner-go tests:
- A2 merge: owner turn → sdk turn (promptSource sdk, entrypoint sdk-cli) whose text ends with 🔀 + Head line → owner "merge":
  recordApproval records NO request (failing first). Same with `origin.kind` non-human and with entrypoint sdk-cli alone.
- A2 round: same shape with a round-request line → recordRoundGrant returns null (failing first).
- A2 visible: system + cli task-notice turn ending with 🔀 → "merge" still records (unchanged).
- A2 tool-only invisible turn after a 🔀 owner-turn reply → "merge" records nothing (strict, unchanged).
- A3 truncation, all three recorders: the window starts inside an sdk turn whose text ends with the ask (prompt cut off, padding
  > tailBytes via the existing large-entry fixture pattern) → nothing recorded; with the window reaching the file start and a real
  owner-turn ask → recorded (control).
- A3 fixtures (Codex recheck P2): today's fixture helpers often write assistant text with NO opening prompt, which A3 now refuses.
  Update the helpers so ordinary fixtures start with a genuine owner prompt (typed) before the agent's reply — positive tests and
  parser-specific negative tests alike, so a negative still fails for its intended parser reason and not for "no opening prompt"
  (spot-check: each parser negative is made to pass by fixing only its parser defect). Keep dedicated orphan-text negatives. Add a
  positive control: a file larger than tailBytes where the candidate reply's opening owner prompt is INSIDE the window ⇒ recorded
  (guards against refusing every truncated transcript).
- A4 same-text synthetic newest prompt ("merge" / "extra round" / a ruling answer sent by an sdk turn) → nothing recorded.
- B1 each recorder: owner-turn ask, then a queued answer already in the transcript → null + the queued nudge printed by the hook
  (failing first for merge, round, owner-turn ruling).
- B2 each kind at use time: record written before the transcript had the entry (hook-before-transcript), entry later appended as
  queued → approvalGap / ownerGrantGap / ownerRuled say 'provenance' / false (failing first).
- B3 a typed (not queued) answer: unchanged, records and approves.
- Existing fixtures (Codex P2): `test/owner-go.test.mjs:~965` (a queued "merge" accepted) and `test/owner-go-compaction.test.mjs:~248`
  (owner-turn queued ruling accepted) are updated: their positive intent is kept with a `typed` answer, and each gains a queued twin
  asserting the refusal. Called out in the PR as an intentional tightening of #128/#189.
- Refusal texts: merge / codex-review / triage messages contain the queued wording (unit tests where those messages are already
  asserted; `docs/cli.md` mirror if the usage text changes — run `node --test test/cli.test.mjs`).
- Regression: every `test/owner-go*.test.mjs` suite plus merge, triage, codex-review, final-gate, review-complete tests green.

## Out of scope / follow-ups

- Telling the owner in the terminal UI itself that a queued answer was refused (the agent relays the hook line).
- If Claude Code later writes a reliable typed-at marker (a prompt id on the enqueue entry), a queued answer could bind what was
  on screen at that moment; file as an idea issue.

## Fable plan pass (2026-11-10) — no BLOCKING; every item folded in (these amend the sections above)

- F1 (SHOULD-FIX) **Invisible = not owner, not visible, when the entry carries provenance.** A prompt entry with a provenance field
  (`hasProvenanceField`) whose `entrySource` is not `'owner'` and that is not `visibleSynthetic` is INVISIBLE (covers a future
  `promptSource` value Claude Code may add, which entrySource calls 'unknown'). A field-less 'unknown' entry (interrupt marker, a
  legacy transcript) stays a boundary as today. A3 is renamed **"Cut-off origin"** (slot 0), distinct from this. Apply the rule
  only to `isPromptEntry` entries (tool_result user entries are never prompts — F7).
- F2 (SHOULD-FIX) **State the visibility premise.** `visibleSynthetic` (promptSource system + entrypoint cli) admits every turn the
  interactive UI starts itself: task notices, Agent hand-backs, peer messages, plugin messages, scheduled wake-ups, auto-continuation.
  The agent can cause each of these and fill it with a 🔀 / round line; that is NOT a bypass because the interactive UI renders the
  assistant text of every such turn (isMeta hides the PROMPT, never the reply) — the same premise as #189, now written down in the
  code comment. Tests pin the decision: merge and round twins of the A2-visible test for a peer-message turn and a plugin-message
  turn (records, intended; listed in the PR body).
- F3 (SHOULD-FIX) **Nudge condition, implementable.** `queuedNudge(input)` = the prompt parses as a merge (`parseApproval`), an
  extra round (`parseRoundGrant`) or ruling pairs (`PAIRS_ONLY`) AND `notOwnerPrompt` is false AND `notOwnerWords` is false AND
  `currentPromptEntry(...)?.promptSource === 'queued'` — whether or not an ask was shown (over-nudging is harmless). It takes
  precedence over the ruling nudge. Hook-before-transcript twin (the hook then prints "recorded …" and only use time refuses): the
  step-4 refusal texts tell the agent what to DO — re-run the dry run (`P merge --pr N --dry-run --owner-go`) / `triage
  round-request` / `triage ruling-request`, show the FRESH closing lines, and ask the owner to answer once more after the reply ends.
- F4 (NOTE) A4 test variants: sdk "merge" prompt + sdk reply ending with 🔀 (owner entry absent / present), and the race where the
  agent's background sdk entry is appended AFTER the owner's typed "merge" (different text and same text) ⇒ nothing binds.
- F5 (NOTE) Accepted cost, stated in the PR: interactive text written after a concurrent sdk-resume prompt entry lands in the
  invisible slot and is dropped ⇒ one re-ask. Same for A3: an ask turn longer than tailBytes is refused once (the re-ask recovers).
- F6 (NOTE) Nudge wording says "re-run … and show the fresh closing lines" (a stale Head line re-shown by hand binds a stale head).
  The hook's stdout contract stays plain text (switching to JSON `systemMessage` to show the owner directly → follow-up idea issue,
  after verifying harness support).
- F7 (NOTE) `tailEntries`' new return shape (entries + reachedStart) must keep `currentPromptEntry` and every other caller unchanged.
