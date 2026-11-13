# Owner approval of past review rounds + published-history protection (2026-11-12)

Status: plan, revision 3. Codex plan review (2 passes) and one Fable adversarial pass are folded in. Owner decisions 2026-11-12:
a DISTINCT line and record kind for past rounds (Fable's preferred design), and the published-history hole fixed in the SAME PR.

## Problem

1. `verifyOwnerGrants` (pipeline/lib/owner-grants.mjs), which `review-complete` and the final gate call, needs every counted round
   with ordinal k > review.max_rounds + 1 to carry a verified `ownerGrant`. Rounds that ran before cp #104 have none, so a PR with one
   can never pass `review-complete` or get the required `Cross-model review` status. A published round has no recovery path.
   Live cases in eaglewatch-ph/eaglewatch:
   - #1448: rounds 5 and 6, toHeads fabde3622… and 3817cdcbf…. Later granted rounds 7 and 8, and resolution round 9, are clean.
   - #1533: round 5, toHead 2601d8fdb…. Granted rounds 6 and 7 follow, with a fix in progress.
2. Hole that exists today (Fable P1): the published review history is not tamper-proof.
   - `publishTriage` (lib/review-publish.mjs:105) allows any local state to replace the published one whenever
     `published.hash === baseline`, and `.review/published-baseline.json` is not guard-protected (hooks/lib/files-policy.mjs:70).
   - So an agent can write the baseline file and republish a shorter history. That erases published rounds and owner grants, and
     resets the round count.
   - codex-review never reads the published state, and with no local state it admits round 1.

## Design

### A. Protect the published history (fixes problem 2; the anchor for B)
- Add `.review/published-baseline.json` to the guard's protected review files (`REVIEW_FILE_SRC`, files-policy.mjs). Only pipeline
  commands write it.
- New `historyPreserved(local, published)` in review-context.mjs. It is true when every published round is present locally with the
  same (n, toHead, contentHashAtToHead), and published grant metadata is add-only: a published `ownerGrant` is deep-equal locally.
  Item decisions may still change, which is what the baseline path exists for.
- `publishTriage` checks it on BOTH paths (baseline and no-baseline). A failure refuses `history-loss` and names the rounds or grants
  that would be lost. This covers review-complete's publish too (review-complete.mjs:259).
- codex-review, for EVERY counted admission, reads the published state first:
  - Every published round must be present locally, by identity. Otherwise it refuses `stale-history` with `state show` advice.
  - A local state that strictly extends the published one, because an earlier publish failed, refuses `unpublished-history` with
    publish advice (`P comment --pr N --kind triage`).
  - The rule applies only when the triage comment exists. With no comment (a new PR) it passes. An undecodable comment refuses.
- `state show` stays non-destructive (Fable P5). When the published side differs only by grant metadata on identity-equal rounds, it
  copies that metadata onto the local rounds and keeps local trailing rounds; it does not quarantine.

### B. Owner approval of a past round
- **Line:** `🔂 Approve past review round #N: round <k> · head <sha12> · repo <owner/name>`.
- **Record:** the owner-go hook recorder gains a parser `presentedPastRoundRequest` and a recorder kind `past-round`. Strictness is the
  same as `recordRoundGrant`: notOwnerPrompt, notOwnerWords, queuedAnswer, length cap, the same words (`extra round` / `approve round`
  with the same target rules). It is additive; `extra-round` handling is unchanged.
- **Separation:** `isRoundRecord` requires `kind === 'extra-round'`, so codex-review, `ownerGrantedRounds` and round-request ignore
  past-round records. A past-round approval can never admit a new run, so no extra codex-review guard is needed for it. A test pins
  this.
- **Verification:** `verifyOwnerGrant` accepts kind `past-round` only for an `ownerGrant` with `past: true`, and `extra-round` only for
  one without it. The rest is unchanged: record + provenance + marker + quote, bound to (repo, pr, k, toHead).
- **Eligibility** (one predicate, `pastRoundsNeedingApproval(state, published, {maxRounds})` in owner-grants.mjs) → `[{n, k, toHead}]`.
  A round qualifies when ALL of these hold:
  - it is counted, with k > max + 1;
  - it is identity-equal in the PUBLISHED state;
  - a LATER counted round exists in the published state (Fable P2 fallback: a forward grant converted into a fake round is always
    the last one);
  - and EITHER it has no `ownerGrant` and no `admission`, OR its `ownerGrant` fails here with `no-record` / `provenance`. The second
    case is re-approval after the transcripts are cleaned up (Fable P3: `cleanupPeriodDays: 45`).
  - Excluded: k === max + 1 with admission 'normal', and admission 'owner' without a grant. Those refusals keep today's text.
  - `verifyOwnerGrants`' refusal for a qualifying round names the remedy.
- **`P triage round-request --pr N --past`:**
  - Preconditions: owner_approval chat; a github.com slug; state PR === --pr; max_rounds configured; full SHAs.
  - It runs A's history check read-only. Local behind or ahead ⇒ it refuses with the matching advice BEFORE asking (Fable P6).
  - It picks the oldest qualifying round and prints `{ok, line, k, n, head, past: true, remaining}`. State is untouched.
  - Skill text: "approves round n, which ALREADY RAN at head <12>; review date not recorded".
- **`P state past-round-grant --pr N --round n`,** under the review lock:
  1. Same preconditions + A's history check (in sync, or local strictly ahead only by verified grant metadata) + eligibility.
  2. Records: kind `past-round` for (repo, pr, k, toHead) with owner provenance, within 24 h. None ⇒ refuse `no-grant`.
  3. Claim ALL matching records together, like codex-review (Fable P4), with `claimGrantMarkers` unchanged, and record the newest.
     Resume: if a record for (k, toHead) already verifies with `verifyOwnerGrant` (record + marker), write it without a new claim, and
     claim any leftover unspent duplicates. No `purpose` field (Fable P8).
  4. Save `ownerGrant {grantId, k, quote, ownerTs, past: true}` and `admission: 'owner'` on round n. There is no `legacyGrantAt`; the
     marker's `consumedAt` is the time.
  5. Before saving, any grant metadata that is only local or different must pass `verifyOwnerGrant` here (Fable P3).
  6. Publish. Output `{ok, round, k, grantId, claimed, saved, published, remaining}`.
  - Pre-claim refusals leave state and markers unchanged. A failure after the claim keeps the markers, reports what happened, and can
    be resumed.
- **Display:** `effectiveMaxRounds` / `ownerGranted` (lib/triage.mjs:716/811, lib/round-ask.mjs:33) count only grants without
  `past: true`. A test proves a past grant admits nothing.

### C. Docs
- review skill: a "Past rounds" paragraph (when review-complete or the gate names a qualifying round: round-request --past → the
  owner types → past-round-grant → repeat → review-complete), plus the new refusals `history-loss`, `stale-history` and
  `unpublished-history` with their remedies.
- owner-merge.md: the 🔂 line, and that it is never used for new rounds.
- Risk note: every grant needs the owner's transcript, which is cleaned after 45 days. Re-approval through this path is the recovery.

## Tests (each refusal also proves state and markers are unchanged)
- A:
  - The baseline file write is blocked by the guard.
  - publishTriage refuses dropped rounds or grants on both paths; decisions may still change.
  - Fable trigger B (fresh worktree, round 1, publish) and trigger A (stale checkout + forged baseline) both refuse.
  - codex-review stale-history / unpublished-history / no comment / undecodable.
  - state show copies published grant metadata and keeps a local trailing round.
- B, parser and recorder: the 🔂 line parses; the extra-round parser does not accept it and vice versa; harness / queued / peer turns
  are not recorded.
- B, separation: a past-round record never admits codex-review or counts in round-request.
- B, eligibility: qualifying cases; the exclusions; a last-round fake refused; re-approval after `provenance`; n ≠ k histories.
- B, past-round-grant:
  - The happy path ⇒ verifyOwnerGrants accepts the round.
  - Refusals: no record; another k or head; another kind; expired; synthetic provenance; label mode on direct call; out of sync;
    unverifiable local grant metadata.
  - Duplicates are claimed together. Resume after a save failure, and after 24 h. A publish failure leads to a retry.
- End to end, temp HOME, with fixtures that mirror #1448 (two past rounds) and #1533 (one): approve each ⇒ review-complete passes,
  and the final gate's grant check passes.

## Risk
Pipeline core and owner authority:
- B adds a new kind of owner approval, bound to an exact (pr, k, head), for rounds that already ran.
- A narrows today's publish and admission paths; there is no loosening.
- The hook change is additive: a new parser and record kind.
- Conflict surface: open cp PRs #266 and #269 also edit hooks/lib/owner-go.mjs and owner-grants.mjs, in other regions. Rebase
  carefully; neither is this session's.
- Size: likely more than 500 lines with tests. If review needs it, split A (protection) from B (past rounds), with A first.
