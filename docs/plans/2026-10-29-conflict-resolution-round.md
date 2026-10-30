# Plan: review only the conflict resolution when main conflicts after the last round (2026-10-29)

## In plain English
When main is merged into a PR and conflicts, the person (or agent) resolving it writes a few lines by hand. Today the
pipeline then treats the WHOLE PR as unreviewed (`whole-pr`), and the round counts toward `review.max_rounds`. A PR already
at its cap is stuck: `codex-review` refuses (`round-cap`), the gate fails on `coverageValid: false`, and the only way out is
`needs-human`. Seen on eaglewatch #1574 (2026-10-29): a one-import-line conflict with #1568 parked a fully reviewed,
CI-green PR. The fix: review exactly the resolution, and don't charge the cap for it.

## Evidence (eaglewatch #1574)
- Last reviewed head `f1f91a2a3`, new fork point `17bb32776`, head `c897eb577` (hand-resolved merge commit).
- `git merge-tree --write-tree f1f91a2a3 17bb32776` exits 1 with tree `06521c7be` that holds the conflict markers.
- `git diff 06521c7be c897eb577` = 1 file, 4 deletions: exactly the resolution (marker lines + the dropped import). Nothing else.

## Design (revised after Codex plan review R1: P1 eligibility, P1 partial resolution, P2 conflict types)
Two separate questions, answered separately: (A) what range is the round shown, (B) does the round count toward the cap.
Only a round that passes EVERY eligibility test below is `resolutionOnly` (shown the resolution, not counted). Any failed
or ambiguous test ⇒ today's behaviour exactly: `whole-pr` range, counted round.

1. `lib/git.mjs`
   - `mergeTree` gains the conflict detail: run `git merge-tree --write-tree -z` and parse the NUL-delimited output
     (tree id; conflicted file info `<mode> <oid> <stage>\t<path>` entries; informational messages with their conflict
     TYPE strings). Returns `{ clean, tree, conflicts: [{ path, stages: [1,2,3 present], types: [...] }] }`. Existing
     callers keep using `clean` / `tree` unchanged.
   - New `resolutionReviewBase({ from, forkPoint, head, baseRef }, o)` → `{ base: <marker tree>, conflicted: [paths] }`
     or `{ ineligible: '<reason>' }`. `effectiveReviewBase` is NOT changed (state.mjs `markImplemented` /
     `baseAfterConflictMerge` keep their fail-closed `whole-pr` handling).
2. Eligibility (all must hold; each failure returns its reason, which codex-review prints as `resolutionIneligible`):
   a. **No PR work since the last round.** Walking HEAD's first-parent history back to `from` (`from` must be a
      first-parent ancestor of HEAD), every commit is a merge whose second parent is an ancestor of the protected
      default-branch ref (`reviewBaseRef`). Any non-merge commit, any merge of another branch, or `from` not on the
      first-parent chain ⇒ ineligible. (So a fix commit for an accepted item, before or after the conflict merge, always
      makes the round counted.)
   b. **Text content conflicts only.** Every conflicted path has all three stages (1, 2, 3: add/add, which lacks stage 1,
      is ineligible) and its only message type is git's literal `CONFLICT (contents)` (verify the literal against the
      git on this machine in a test); no "Cannot merge binary files" message, no NUL in any stage blob. All three stage
      modes and head's mode are equal and ∈ {100644, 100755} (rejects symlinks 120000 and a resolver's chmod).
      modify/delete, rename/*, directory/file, submodule, mode and binary conflicts ⇒ ineligible.
   b2. **Deterministic, attribute-free trial merge (Fable plan R1 P1-1/P1-2).** The trial merge always runs as
      `git -c merge.conflictStyle=merge -c merge.renormalize=false merge-tree --write-tree -z <full from sha> <full
      forkPoint sha>` (full 40/64-char shas, never abbreviations: they become the marker labels). merge-tree reads
      `.gitattributes` from the WORKTREE, so `git check-attr merge conflict-marker-size diff text eol -- <conflicted
      paths>` must report `unspecified` for every conflicted path; otherwise ineligible (a `-merge`/`merge=binary`/
      `merge=union`/marker-size attribute changes the tree or hides a conflict). Every conflicted path must yield ≥ 1
      parsed conflict block (a conflicted file with no markers ⇒ ineligible).
   c. **Only conflicted files changed.** `git diff --name-only --no-renames -z <markerTree>..head` is non-empty and every
      path is in `conflicted`. The full conflicted list is used for this check (not the 50-path reporting cap).
   d. **Every block resolved by SELECTING side lines only; nothing else changed.** (Codex plan R2: replacement text
      typed into a block is PR work and must be counted.) Done by alignment, not by diff hunks: for each conflicted
      file, parse its blocks in the marker-tree blob (`<<<<<<< `…[`||||||| ` base]…`=======`…`>>>>>>> `, with the
      marker length and labels merge-tree writes; ours = the lines between the opening marker and `|||||||`/`=======`,
      theirs = between `=======` and the closing marker; the base section, if any, is NOT selectable). Split the
      marker blob into alternating outside-segments O0, B1, O1, B2, … On the head blob, match O0..On in order as
      exact, contiguous line sequences (outside text byte-identical, no lines added or dropped there); what sits
      between Oi-1 and Oi in head is the resolution Ri of block Bi. Each Ri must be an interleaving of a subsequence of
      ours(Bi) and a subsequence of theirs(Bi) (each side's chosen lines keep their relative order) and contain no
      marker line. A block may resolve to nothing. The check is EXISTENTIAL (Fable P2-3): a bounded DP/backtracking
      over (anchor placement × ours pointer × theirs pointer) accepts if ANY witness decomposition exists (greedy is
      wrong: ours=[a,b], theirs=[b,a], R=[b,a,b] is valid); cap the search (e.g. 200k states) and treat hitting the cap
      as ineligible. **Parse validation by reconstruction (Fable P1-1b):** O0+ours1+O1+…+On must equal the stage-2 blob
      byte-for-byte and O0+theirs1+O1+…+On the stage-3 blob; choose the marker split that reconstructs (settles a
      `=======` line inside a side); no split reconstructs ⇒ ineligible. **Lines (Fable P2-4):** byte-exact split on
      `\n`, each line keeps its terminator (`\r\n` stays `\r` + `\n`); a final line without `\n` keeps its missing
      terminator as part of its bytes; handle git inserting a newline before a marker when a side lacks a final
      newline (the reconstruction check catches any mistake). An editor that normalises EOL makes the round counted:
      by design. Any match failure, parse doubt or a line not taken from a side ⇒ ineligible. This checks marker
      removal per block over the whole resolution, independent of hunk boundaries (Codex plan R2 P2): keeping all of
      ours, all of theirs or parts of both all pass.
   e. **History pre-check (2a) is kept** as a cheap fail-closed filter (Fable P3-7): merges must have exactly two
      parents (octopus ⇒ ineligible); a stale `origin/<default>` makes it ineligible, which is safe.
3. `commands/codex-review.mjs`, later rounds, PR target = default branch, `effectiveReviewBase` returned `whole-pr`:
   call `resolutionReviewBase`. Eligible ⇒ range = markerTree..head, `review.kind = 'resolution'`, round flags
   `resolutionOnly: true` + `conflicted` (≤ 50 stored, plus the count). Ineligible ⇒ `whole-pr`, counted, and the
   JSON output carries `resolutionIneligible: '<reason>'` so the controller knows why. Eligibility is decided before
   `checkCap` and re-checked in the locked section after Codex returns (head unchanged is already enforced).
4. A `resolutionOnly` round is a REAL review: Codex runs on that diff, triage/judge/arbiter as usual, `fableRequired`
   on a Fable PR. Prompt (`buildReviewPrompt`, `baseKind === 'resolution'`): names the conflicted files and says the
   base is the last reviewed head trial-merged with the new base branch with git's conflict markers left in, so this
   diff is exactly how each conflict was resolved; check each resolution keeps both sides' intent and adds nothing
   else; the reviewer MAY read the whole of each conflicted file (both sides via `git show <from>:<path>` /
   `git show <forkPoint>:<path>`) and report problems anywhere in those files. The conflicted paths go in the prompt's
   data fence like `sensitivePaths` (author-chosen names, Fable P3-8). Per block, the prompt states how many lines of
   the base branch's side (theirs) the resolution dropped, and asks the reviewer to justify every dropped base-branch
   line (reverting a protected fix is the real risk of a selection-only resolution).
   `reviewPatch` gains `--no-textconv` (Fable P3-6; a `diff=`/textconv attribute could blank any round's patch).
5. Cap (`lib/triage.mjs`): `countsTowardCap(r) = r.baseOnly !== true && r.resolutionOnly !== true`, used by
   `reviewedRoundCount` (so `roundCapProblem`, `extraRound`, `effectiveMaxRounds`, `reachedMax`). `roundCapProblem`
   takes `{ baseOnly, resolutionOnly }`. "Last REVIEWED round" (`lastReviewed` in `roundOutcome` / `reviewValidFor`,
   `fablePendingRounds`, `newAccepted`) still skips only `baseOnly`: a resolutionOnly round's findings, accepts and Fable
   obligation behave like any round's. An ACCEPT in it needs a fix commit, and by 2a the next round is then counted.
6. Recovery on another clone: the marker tree (and the existing `synthetic` tree) is a git object that only exists where
   it was made. New `ensureReviewBase(round, o)` used by `arbiter.mjs` before diffing from `round.reviewBase`: if the
   object is missing, rebuild it with the SAME forced invocation as 2b2 (`-c merge.conflictStyle=merge -c
   merge.renormalize=false`, full shas) — `synthetic` rounds too — after checking that `git check-attr` reports the
   round's conflicted paths unspecified in this checkout, and require the same tree id; a mismatch or failure ⇒ clear
   error (`review-base-unavailable`, naming conflict style / attributes as the likely cause), never a silent fallback
   to another range. Test: rebuild in a clone configured `merge.conflictStyle=zdiff3`.
7. State: `lib/state.mjs` `addRound` keeps `resolutionOnly: true`, `conflicted`, `conflictedCount`; published / replayed
   state round-trips them (comment encoding already keeps arbitrary round fields: verify by test); old state = false.
8. Docs: `skills/ship/reference/review-loop.md` (next to `baseOnly`: what `resolutionOnly` / `resolutionIneligible` mean),
   `docs/cli.md` codex-review output, SKILL.md one clause where base-only rounds are said not to count. review-loop.md
   says which resolutions are counted BY DESIGN (a regenerated lockfile, merged import lines, any typed text, EOL
   normalised by an editor, non-text conflicts, attributes on the conflicted path).

## Safety argument
- Range: head − (last reviewed head ⊕ new main, markers left in). Every byte head adds or drops relative to that tree
  is in the diff the reviewer sees; by 2c+2d nothing outside the conflict blocks changed and no block is left
  unresolved. Main's own code is out because main is protected and reviewed in its own PRs (as for `synthetic`).
- Cap: merge-only history (2a) does NOT by itself prove there is no PR work: work can be typed into a merge commit.
  What makes a round free is 2d: the result differs from (last reviewed head ⊕ new main) only by choosing, per
  conflict block, lines that already exist on one of the two sides. No new text can enter that way, so a feature or an
  accepted fix (both new text) always makes the round counted, including the M1-resolve / M2-clean-merge-with-a-fix
  sequence (the fix text is not a side line of any block of the marker tree built from the CURRENT fork point).
  Dropping or choosing side lines can still change behaviour; that is what the (real, Codex + Fable) review of the
  resolution round checks. Only the cap is waived, never the review.
- Ambiguity anywhere ⇒ counted `whole-pr`: the feature can only ever make the pipeline stricter-than-today or equal,
  never looser, outside the exact proven case.
- `markImplemented` is untouched (still fail-closed via `baseAfterConflictMerge`).

## Tests (node --test, existing suites; real temp git repos, fake Codex)
- git.test.mjs: `mergeTree -z` parsing (content, modify/delete, rename/delete, binary, several files, paths with
  spaces/newlines); `resolutionReviewBase` eligible case; each ineligible reason (2a non-merge commit before and after the
  resolving merge, merge of a non-default branch, `from` off the first-parent chain; 2b each non-content type + binary;
  2c extra file; 2d edit outside a block in the same file, partially resolved file (one of two blocks left with markers),
  partially resolved across files, marker line kept, diff3 base section, a NEW line typed into a block, a line from
  the base section, an outside line dropped/duplicated, ambiguous outside anchors; positive: keep all ours, all theirs,
  parts of both interleaved, empty resolution); the M1 conflict-merge then M2 clean-merge-carrying-a-fix-inside-the-
  block sequence ⇒ ineligible; several main merges incl. a later clean merge
  after the conflict merge (still eligible); `ensureReviewBase` rebuild on a fresh clone (same id) and mismatch error.
- cli-review.test.mjs (codex-review): eligible ⇒ `resolutionOnly`, diff = resolution only, Codex called, not capped at
  `max_rounds` nor after the extra round is used; ineligible ⇒ `whole-pr`, capped, `resolutionIneligible` reason;
  non-default target ⇒ unchanged; Fable PR ⇒ `fableRequired`; prompt text for `baseKind: 'resolution'`.
- triage.test.mjs: cap helpers with resolutionOnly rounds; clean carries when the resolution round is clean; ACCEPT in a
  resolution round ⇒ `newAccepted`, next (fix) round counted; extraRound already consumed; stale coverage; missing Fable
  proof on the resolution round blocks `clean`.
- state.test.mjs + an end-to-end CLI test: publish → fresh-clone `state show` replay → arbiter needed/apply on the
  resolution round (tree rebuilt) → review-complete → final-gate review check.
- Fable plan R1 cases: `-merge` / `merge=binary` / `merge=union` / `conflict-marker-size` attribute on a conflicted path
  ⇒ ineligible; conflicted file with no markers ⇒ ineligible; add/add ⇒ ineligible; symlink and chmod'd resolution ⇒
  ineligible; greedy counterexample ours=[a,b], theirs=[b,a], R=[b,a,b] ⇒ eligible; `=======` line inside a side
  (reconstruction picks the split); CRLF file; side without final newline (each side); octopus merge ⇒ ineligible;
  user config `merge.conflictStyle=zdiff3` gives the SAME marker tree id (forced config) and rebuild in such a clone
  matches; `reviewPatch` with a textconv attribute still shows the change.
- Mutation checks (each must turn a test red): subset test → "any path"; skip 2a; drop the "every block resolved" check;
  `countsTowardCap` ignores `resolutionOnly`; `ensureReviewBase` skips the id comparison.

## Out of scope (follow-ups)
- cp #88 owner-UI-merge exit when main keeps moving.
- Non-text conflict resolutions (binary, modify/delete, renames) stay counted `whole-pr` rounds; a later design could show
  reviewers the chosen side explicitly.
- Teaching `markImplemented` to use the resolution base (it fails closed today, fine).
- Existing gap Codex noted (plan R2, state.mjs:195/248): `baseAfterConflictMerge` can count changes typed into a LATER
  clean main merge as an accepted item's implementation. File as its own cp issue; not changed here.
