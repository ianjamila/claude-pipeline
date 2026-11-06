# Follow-ups 2026-11-06: #185, #188, ruling hook across compaction, P merge false exit 1, one Closes keyword per issue

One PR, branch `agent/cp-followups-1106`, base origin/main babea9a. Risk: HIGH (pipeline/hooks/** is a high-risk path; item 3 is
the owner-word provenance of rulings, merges and extra rounds). Fable plan pass runs (security / pipeline core).

## 1. #185 — Win32 name aliases in the @-import scan (pipeline/lib/docs-exempt.mjs)

Today `@docs/ledger.md::$DATA` (NTFS default data stream), `@docs::$INDEX_ALLOCATION/ledger.md` (a directory's index stream) and
`@docs/LEDGER~1.MD` / `@DOCS~1/ledger.md` (8.3 short names) are judged as plain relative paths that do not exist, so a listed document
an instruction file imports through them keeps the exemption. Windows opens all of them as the listed file.

Fix (fail closed, keep the prose cases that cannot be an alias exempt):
- **8.3 short names:** any path segment (every segment, judged as written and after the trailing-punctuation / #fragment cuts, like the
  dotted check) matching `/~\d+(?:\.|$)/` is refused: "cannot be judged because a segment that looks like a Windows short name (8.3)
  has two readings: this needs a review round". Short names depend on the volume (and switch to hashed forms after ~4), so they are
  never computed, only refused.
- **NTFS streams (Codex plan review: refuse, never strip-and-judge).** A named stream (`notes.md:instructions:$DATA`) holds other bytes
  than the file, so scanning the stream-free path proves nothing about it; the default stream (`::$DATA`) and a directory's index stream
  (`docs::$INDEX_ALLOCATION/…`) ARE the file / directory. So: a token with a `:` past the drive position (isAbsoluteOrHome already refuses a
  leading drive) is cut at the first segment that holds a `:`; that segment is cut at its colon; the path up to and including that cut
  segment is resolved in the reviewed tree (resolveInTree, symlinks followed). If it names ANY entry (file, directory, link), or the resolve
  is Unjudgeable, or the cut segment is empty (`:x`, `docs/:y`), the token is refused: "cannot be judged because a `:` past the drive names an
  NTFS stream of <path>: this needs a review round". Only when nothing at that prefix exists in the tree (a git checkout cannot carry
  streams of a file it does not have) is the token judged as written, as today. So `@ab:c` / `@note:later` stay exempt (the existing
  "not a drive, not a home, not a climb" test keeps passing) while `@docs/ledger.md::$DATA`, `@docs/ledger.md:x`, `@notes.md:instructions:$DATA`
  and `@docs::$INDEX_ALLOCATION/ledger.md` are refused. Judged on the token as written and on each trailing-punctuation / #fragment cut.
- **Symlink targets:** resolveInTree refuses a target with a `:` or a short-name segment (Unjudgeable), like a backslash today.
- Tests (test/docs-exempt.test.mjs): `::$DATA`, `:x` named stream of a listed doc, named stream of a NON-listed existing file
  (`@notes.md:instructions:$DATA`, refused), directory `::$INDEX_ALLOCATION`, upper and lower case short names in the last and in a middle
  segment, short name with trailing punctuation, empty segment after the cut, symlink target with a colon / short name, and
  `@ab:c` / `@note:later` / `@foo~bar` still exempt. No fixture
  builds paths from the OS temp dir or creates backslash symlink targets (Windows CI).

## 2. #188 — output past maxBuffer must never read as the child's own exit 1

- `pipeline/lib/proc.mjs` toResult returns `overBuffer: boolean` (ENOBUFS) beside timedOut / signal. Its code mapping stays.
  runShellAsync / any other result builder in proc.mjs: same field where a buffer cap exists (check).
- `pipeline/lib/git.mjs` exec: overBuffer is abnormal like a timeout or a signal ("output over the N-byte limit"), so it throws GitError
  before any caller can read code 1. GitError gains `abnormal: true` for all three so a catch that maps `code === 1` to an answer can tell.
- Audit (Codex plan review: not only `code === 1`): every run-result adapter or caller that turns a non-zero exit, or stderr text, into an
  answer. Find them by `timedOut` / `.signal` checks (every adapter that checks those must check overBuffer too, BEFORE reading stdout or
  stderr) and by `code === 1` / `code !== 0` / stderr classifiers. Known: git.mjs mergeTree / mergeTreeDetailed (code 1 = conflicts),
  hardstops.mjs knownEnvNames (~1655, GitError code 1 = no match, without the stderr check its siblings ~1714/~1728 have),
  stacks/evidence.mjs lsof reads (~178, ~294, via call()), stacks/inventory.mjs adapter (~59) and docker inspect classifier (~146: a cut
  stderr of only "No such object" lines plus a whole stdout array would read as inventory), stacks/act.mjs (~69, ~93: abnormal read as
  absent / missing), hooks/lib/git-wiring.mjs (~67: bypasses git.mjs, maps exit 1 to "no repository override"), lib/agentlog.mjs (~199).
  Each fails closed (throw / unknown) on overBuffer. Line numbers re-checked during the build; the PR body lists the final set.
- `pipeline/lib/stacks/evidence.mjs` call(): `if (r.overBuffer) return { fail: unknown(`${name} output was over the buffer limit`) }`.
- Tests: toResult with ENOBUFS + status 0 / status 1 → overBuffer true; exec throws GitError (abnormal) on overBuffer; mergeTree with an
  overBuffer run seam → throws, never `conflicts`; knownEnvNames → not "no match"; evidence call() → unknown; inventory with a valid-looking
  stdout array + "No such object" stderr + overBuffer → unknown; act.mjs and git-wiring with overBuffer → not absent / not "no override".
  Run seams only, no real 64 MiB output.

## 3. The ruling hook across compaction (pipeline/hooks/lib/owner-go.mjs, unfiled: filed as an issue and closed by this PR)

Reproduced from transcript 4369b774 (lines are file lines):
- **Second miss (compaction).** 1557 the ask (owner-started turn) ends with `⚖️ Owner ruling needed #179: R5-F1 · content … · repo …`;
  1567 `system compact_boundary`; 1568 a `user` entry, string content, `isCompactSummary: true`, `isVisibleInTranscriptOnly: true`,
  `entrypoint: cli`, no promptSource / origin; 1592 the owner's typed `R5-F1: follow-up`. isPromptEntry(1568) is true and entrySource is
  'unknown', so lastReplyText opens a new (empty) reply slot there; the owner's prompt is "current", the slot before it is the summary's
  empty one → '' → no ask → refused.
- **First miss (synthetic turn).** 1496 a prompt entry with `promptSource: system`, `origin.kind: peer` (a subagent hand-back) started the
  turn; the ask (1522) was written inside that turn; 1532 the owner's typed answer. recordRuling reads with skipSynthetic: the synthetic
  turn is dropped and, by the R1-F3 rule (owner decision 2026-11-03: any text in a dropped reply voids the slot), its own text voided
  the slot → '' → refused. Same owner experience, different cause.

Fix:
- **Compaction is transparent.** In lastReplyText and currentEntryIsSynthetic a `user` entry with `isCompactSummary === true` is skipped:
  it opens no slot, adds no text, does not change `skipping` or `lastIsPrompt`. The summary's text is never part of a reply (it is model
  text that may quote an old ruling line; counting it would revive an ask). `system` entries are already ignored. This applies to all three
  readers: rulings (recordRuling), merge approval (lastRequestText via recordApproval) and extra-round grants (recordRoundGrant).
- **An ask made in a synthetic turn stands on its own (rulings only, skipSynthetic).** A dropped synthetic turn whose collected assistant
  text ENDS with a canonical ruling line (presentedRuling of that text is non-null) AND in which nothing surfaced after that text becomes a
  new reply slot holding that text, exactly as if an owner prompt had started the turn. Ordered rule (Codex plan review P1), per synthetic
  turn, entries in transcript order:
  - state: `text` (assistant text of this turn, concatenated as for an owner reply), `surfacedAfterText` (false), `anything` (false);
  - assistant text block (non-empty): `text += block`, `surfacedAfterText = false`, `anything = true`;
  - tool_use input / tool_result that surfaces an ask (inputSurfacesAsk / surfacesAsk, unchanged): `surfacedAfterText = true`, `anything = true`;
  - the turn ends at the NEXT prompt entry of any source (flushed before that entry is handled) or at the end of the entries (flushed after
    the loop, so an answer not yet appended to the transcript sees the same result as one that is);
  - flush: if `presentedRuling(text) !== null && !surfacedAfterText` → push a new slot holding `text` (lastIsPrompt = false); else if
    `anything` → void the current last slot (today's rule); else (tool-only, nothing surfaced) → the slot stands.
  So `ruling-request` call → its result → canonical line → owner answer: promoted (the line came last). Canonical line → tool output that
  asks about another PR → owner answer: voided (the last thing shown was not the line). Consecutive synthetic turns: each flushes on its
  own; a later synthetic turn with text voids an earlier promoted slot, a later tool-only one leaves it. The promoted ask binds only its own
  PR / ids / content digest (presentedRuling of that text); tests assert the recorded PR, ids and digest.
  R1-F3 / R4-F3 / R5-B2 are unchanged for every turn that does not end with the line. Why this is no weaker: the ask is agent-written in either kind of turn; what binds is the owner's
  TYPED answer (entrySource 'owner', promptProvenance at owner-ruling), the ids on the last line and the content digest owner-ruling
  recomputes. A synthetic turn ending with the line is what the owner last saw, which is the R1-F3 rationale itself ("the owner answers the
  ask they last saw"). This narrows R1-F3, so it is called out in the PR for the owner.
- What stays: nothing the agent prints can stand in for the owner's words; an answered ask is never revived (a later owner prompt is a
  boundary; compaction adds none and removes none). A summary entry's source is 'unknown' (no promptSource / origin; entrypoint cli), so
  currentEntryIsSynthetic (which rejects only 'synthetic') does not refuse it at record time; it can never be recorded anyway because the
  hook records the SUBMITTED prompt's words, and at use time promptProvenance treats an 'unknown' entry in a modern transcript as synthetic.
  Tests cover the recorder (lastReplyText / record*) and the use-time check (promptProvenance) separately.
- Tests (test/owner-go*.test.mjs, transcript fixtures built in memory with the real entry shapes above):
  ruling ask → stop-hook / turn_duration / away_summary system entries → compact_boundary → summary (isCompactSummary) → attachments →
  owner prompt: recorded. The same for a 🔀 merge request (recordApproval) and an extra-round request (recordRoundGrant).
  Negative: a summary whose text holds a ruling line, after an answered ask → nothing recorded; an answered ask, then compaction, then a
  second typed answer → nothing recorded; ask, compaction, agent text after the summary (auto-compact mid-turn) → the last line decides.
  Codex's two sequences, each with the owner answer appended and not yet appended: `ruling-request` call → result → canonical line → answer
  (recorded for that PR / ids / digest) and canonical line → tool output asking about another PR → answer (nothing recorded); two
  consecutive synthetic turns (promoted, then text → voided; promoted, then tool-only → stands).
  Synthetic turn ending with the ruling line → recorded; synthetic turn with the line and trailing text → voided; synthetic turn with only
  `ls` tool calls after an owner-turn ask → ask stands (existing); synthetic turn with a non-canonical ask text → voided (existing).
- Docs: the comment block above lastReplyText; docs/cli.md / skills text that describes "a compaction loses a ruling (ask again)", if any.

## 4. `P merge` reports commandExitCode 1 on every merge (pipeline/commands/merge.mjs)

Cause, verified: P merge runs the merge command with cwd = the PR's worktree, where `agent/<slug>` is checked out. gh 2.92
`pr merge --delete-branch` (pkg/cmd/pr/merge/merge.go deleteLocalBranch) merges, then, because the current branch is the PR head,
checks out the base branch: git refuses (`fatal: 'main' is already checked out at '<main checkout>'`, exit 128, reproduced in a scratch
repo), gh returns that error (exit 1) and skips the branch deletes. Evidence: the #179 worktree's reflog has no checkout after the merge and
the local branch still exists. Remote branches are still removed: all three repos have delete_branch_on_merge on. `--auto` does not
avoid it (an immediately mergeable PR merges directly and runs the same step).

Fix: in both routes (gated and --owner-go), when the command exits non-zero and GitHub says MERGED:
- classified as the worktree case ONLY when ALL hold (Codex plan review P2): exit code exactly 1, not timed out, no signal; the output
  holds a git worktree diagnostic (`fatal: '<b>' is already checked out at '<p>'`, `fatal: '<b>' is already used by worktree at '<p>'`,
  `error: Cannot delete branch '<b>' checked out at '<p>'` / `… used by worktree at '<p>'`); and EVERY line of the output that looks like
  an error (`/\b(?:error|fatal|failed|denied|cannot|could not|unable)\b/i`) either is one of those diagnostics or is gh's own wrapper of it
  on the same line (`failed to run git: fatal: …`, `failed to delete local branch <b>: …` followed by the diagnostic). Then
  `ok: true, merged: true, commandExitCode: 1, localCleanup: { skipped: true, reason: 'worktree' }`, commandOutput (tail, 30 lines) and the
  note "merged; gh could not switch away from or delete the local branch because a worktree holds it (remove the worktree as usual)".
  A bare `failed to delete local branch` (permissions, a ref lock) is NOT the worktree case.
- any other non-zero exit with MERGED (unknown cause, mixed diagnostics, a timeout or signal after recognised text) → as today
  (commandExitCode + the old note) PLUS commandOutput (tail, 30 lines) so the next unknown cause has evidence.
- not merged → unchanged (failure). Classification never decides merged / not merged; GitHub's state does.
- Tests in test/merge*.test.mjs with the existing command seam, BOTH routes (gated and --owner-go): merged + checkout diagnostic, merged +
  branch-delete diagnostic, merged + bare "failed to delete local branch" with a permission / ref-lock cause (unknown), merged + worktree
  diagnostic plus an unrelated error line (unknown), merged + worktree diagnostic then timeout (unknown), merged + exit 2 with the diagnostic
  (unknown), not merged + checkout diagnostic (still a failure). docs/cli.md and the usage string updated.

## 5. One closing keyword per issue

GitHub links only the first number of `Closes #170, #171, #167`. skills/review/SKILL.md (when_to_use "build #123" line and step 1.4
body) says to write one keyword per issue: `Closes #170. Closes #171. Closes #167.` test/docs-facts.test.mjs pins that sentence (no
existing pin conflicts; no PR template exists in claude-pipeline, DRMed or EagleWatch). This PR's own body uses the form.

## Out of scope (named, not built)
- Changing a project's merge.command (e.g. `--repo` stops gh's local step entirely): each repo's own config; suggested to the owner.
- A P check that flags `Closes #a, #b` in a PR body.
- Re-vendoring DRMed / EagleWatch after merge: own small PRs, owner asked first.

## Fable plan pass (one adversarial pass, 2026-11-06): all eight findings accepted; they override the sections above

1. (blocker, item 3) Promote a synthetic turn ONLY when its prompt entry has `promptSource === 'system'` AND `entrypoint === 'cli'` (a
   notice the interactive UI renders: task notices, subagent hand-backs). `sdk` / `sdk-cli` (a headless `claude -p --resume` of this
   session writes into the owner's transcript and shows nothing on screen), other non-human origins and 'unknown' keep today's R1-F3 rule.
   Test: an sdk-cli turn ending with the line → voided.
2. (blocker, item 3) Queued answers: an owner prompt typed while the agent was busy (`promptSource: 'queued'`) can be delivered after a
   promoted ask the owner never saw. A ruling recorded against a PROMOTED ask carries `ask_turn: 'synthetic'`; at use time
   (promptProvenance / ownedBy) such a record whose prompt entry has `promptSource === 'queued'` is refused; the recorder also refuses when
   the current entry is already in the transcript as queued. Owner-turn asks have a narrower, pre-existing form of this: follow-up issue.
3. (item 3) Skip a compaction summary only when BOTH `isCompactSummary === true` and `isVisibleInTranscriptOnly === true` (invisible to the
   owner); a visible summary stays a boundary.
4. (item 1) The tree holds blobs and links only, so a directory is not an entry: after the cut, "exists" = an entry equal to the resolved
   prefix OR any entry under `lc(prefix) + '/'`; resolveInTree exposes the resolved directory path so a symlinked directory is followed first.
5. (item 1) Judge the colon rule on the trailing-punctuation-cut candidates only, so prose `@README.md:` is not refused (`::$DATA`, `:x.`
   are still caught).
6. (item 2) Also: stacks/register.mjs ~202-207 (exit 128 + text → 'none'), stacks/identity.mjs ~49-50 / ~82-84, stacks/outcomes.mjs ~318,
   stacks/act.mjs ~208, commands/merge-hold.mjs ~49 (runShellAsync: no cap, document it). spawnAsync has no maxBuffer: overBuffer n/a, say
   so. Every `GitError && code === 1` catch tests `!err.abnormal` (a SIGKILLed git throws code 1 today too), not only for overBuffer.
7. (item 4) spawnAsync drops the close event's signal: return `signal` from it (and runShellAsync) and test it; otherwise a killed merge
   command that already printed the diagnostic classifies as the worktree case.
8. (item 4) Classify on the FULL stdout+stderr; the 30-line tail is only the output field. A non-C locale's translated `fatal:` falls to
   the unknown-cause path (acceptable; noted in docs).
