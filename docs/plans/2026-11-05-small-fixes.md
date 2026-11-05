# Small fixes after F7 (2026-11-05)

One CP PR, branch `agent/small-fixes-1105` off origin/main acae651. Never ship/review on CP; plan → Codex (review + one recheck) → ONE
Fable pass (item 2 changes merge gating = pipeline core) → implement → CI → owner "merge".

Found on EW #1658 (F7). Not ours (other sessions): CP #159 / PR #168 (ci-wait), cp #164, CP #161/#163/#175.

## 1. codex-review: a pure main merge after accepted items is `empty-range`, not `baseOnly`

**Seen:** #1658 rounds after da69897 and f851f354 (both `Merge branch 'main'`, no conflict) exited 2 `empty-range` "round N would review
nothing: the branch content has not changed since round 2, and earlier rounds accepted items that need a fix"; `review-complete` then
passed, i.e. nothing needed a fix.

**Cause:** `pipeline/commands/codex-review.mjs:229-235` refuses when ANY round ever accepted an item (`hasAccepted`) and the content
hash (the PR's own diff against its fork point) is unchanged since the last round. The two #1658 merges left that hash unchanged (a clean merge
can change it only through context lines next to a PR hunk), and
the check runs BEFORE the code that would record the round as `baseOnly` (line 278). The accepts it names were fixed and re-reviewed
rounds ago.

**Fix:**
- Move the empty-range check after `review` / `resolutionOnly` / `baseOnly` are known (still before `checkCap`, `ensureRoundDir` and
  anything written). A `baseOnly` round is never refused as empty-range: it is recorded as today (`{ok, baseOnly:true}`, no Codex, not
  counted). That is already safe: `roundsAwaitingFixReview` / `reviewValidFor` / `roundOutcome` skip baseOnly rounds, so an accepted,
  unfixed item stays `newAccepted` / unimplemented and the PR stays not-clean.
- Every other case keeps today's refusal (`base == head` is kind `previous` with an empty patch, so never baseOnly; an empty commit; an
  amend), error code unchanged (`empty-range`, callers match on it). The message says which case it is:
  - accepts still waiting for a round that reviews their fixes (`roundOutcome(state).newAccepted` non-empty) → name those ids:
    "commit the fix for R2-B1, R2-S3 first";
  - otherwise → "nothing new to review: the content is what round N reviewed; if that round was clean, `review-complete` uses it".
- Usage text (`meta.usage`) updated.

**Tests (test/cli-review.test.mjs):**
- R1 accepts → fix + mark-implemented → R2 clean → main gains an unrelated commit → branch merges main (no conflict) → round 3 =
  `baseOnly:true`, Codex not run, `review-complete`-relevant outcome clean.
- R1 accepts, NOT fixed → pure main merge → round 2 = baseOnly (not refused); `state outcome` still not clean, `newAccepted` lists the
  item; after the fix, round 3 runs normally (counted).
- Existing: empty commit after an accept → still `empty-range` (message now names the open accept); `base == head` → still
  `empty-range`.
- (Codex plan R1) a clean main merge that changes the PR diff's CONTEXT lines (main edits lines next to a PR hunk): the content hash
  changes, the round is still `baseOnly`, and `review-complete` then passes (the baseOnly round's contentHashAtToHead covers it).
- (Codex plan R1) a conflicting main merge whose resolution only chose existing lines (`resolutionOnly`) after an accept: unchanged by
  this fix (Codex runs over the resolution, not refused as empty-range; the accept still needs its fix round).

## 2. P merge --owner-go: accept "behind, but main's new commits touch none of the PR's files"

**Seen:** #1658 needed 4 update → CI cycles: EW main lands ~1 PR / 15 min, CI takes ~25 min, so the head was always behind by the time
CI was green, and `--owner-go` (and its `--dry-run`) refuse `behind-base`.

**Not the EW rule:** EW's `scripts/lib/merge-gate.mjs` FRESH ENOUGH rule clears a check only when main's new files touch nothing the
check watches; `Typecheck + Vitest` is `when: 'always'` (all non-docs files). All 8 main deltas between #1658's updates were app code
(19–76 files) → STILL STALE every time. Owner ruling 2026-11-05: use **disjoint files** instead.

**Rule (owner-go path only — real merge and `--dry-run --owner-go`; the gated `P merge` after final-gate keeps updating the branch):**
A PR whose head lacks commits of its base is accepted as "behind but fresh enough" when ALL hold, else `behind-base` as today:
1. **Opt-in, from the base:** `merge.behind_base: disjoint` in `.claude/pipeline.yml` **as the base commit has it** (`git show
   <baseRefOid>:.claude/pipeline.yml`; baseRefOid = GitHub's, read by evaluateOwnerGo; the commit must already be local — the
   scan-range check requires that today). Never the PR's own copy (a PR must not loosen its own merge rule). Missing / invalid /
   `update` (the default) → strict, and the detail says which.
2. **GitHub agrees it can merge:** `mergeStateStatus` is one of the states the dry run already treats as readable (`CLEAN`,
   `HAS_HOOKS`, `UNSTABLE`, `BLOCKED` — one shared constant, so the real merge and the dry run accept exactly the same states; never
   `BEHIND`, which only appears under strict branch protection where GitHub itself refuses, never `DIRTY` / `UNKNOWN`); `mergeable` is
   `MERGEABLE` (prOpenCheck already requires it — #1642 landed a real README conflict between a dry run and the merge).
3. **Disjoint:** M = every path main changed from `mb = merge-base(baseRefOid, HEAD)` to `baseRefOid`, P = every path the PR
   changes (the same diff the scan uses, already cross-checked against GitHub's `pulls/N/files` by scan-range). **Both sides are
   read the same way (Fable F2):** `diffFiles` + `pathsOf` (renames as both names, C-quoted paths unquoted) — never `git diff
   --name-only` without `-z`, whose `"docs/r\303\251sum\303\251.md"` would never equal P's `docs/résumé.md`. Local git: no 300-file
   API truncation. M ∩ P = ∅, compared after NFC normalisation and lower-casing (case-insensitive, normalising file systems).
   A failed diff on either side → not fresh enough (`{ok:false}`), never null (Fable F6).
4. **Nothing on main's side that changes how the checks run:** no path in M matches (`matchGlob(p, g, { nocase: true })`, as the
   CI-proof scan does) the built-in list — `CI_PROOF_PROTECTED` (`.github/**`, `.claude/pipeline.yml`, `scripts/verify*`,
   `scripts/verify*/**`: what the required checks execute) ∪ `**/.gitattributes` (nested ones apply to their subtree — Codex plan
   R1; also matches the root file) ∪ `.gitmodules`, `.nvmrc`, `.node-version`, `.tool-versions` (they steer the CI toolchain — Fable
   F3) — nor the base's `verify.ci_proof_inputs` (the repo's own list of "inputs whose change changes what CI proves" — Fable F3) nor
   the base's `merge.behind_base_stale_paths` (globs, default `[]`; EW will add its toolchain files, e.g. `package.json`,
   `package-lock.json`, `tsconfig*.json`, `supabase/**`). The built-in part cannot be configured away.
4b. **(Fable F4) Main did not remove a directory the PR adds into:** for every PR path the PR adds (status A, or the new name of an
   R), if an ancestor directory has entries at `mb` (`git ls-tree`) but none at `baseRefOid`, refuse "main removed <dir>, which the
   PR adds into" (a path-level clash disjoint names cannot see: main moves `src/foo/`, the PR adds `src/foo/new.js`).
5. Everything else unchanged: required checks green on THIS head, labels, hard-stops / integrity / owner items, the owner's recorded
   "merge" for this head + items (+ Areas), and the last look (`preMergeProblems`) refusing when baseRefOid or headRefOid moved since
   the evaluation.
6. **(Codex plan R1, Fable F5) No landing on a base nobody checked:** the merge command may queue (`gh pr merge --auto`), so while
   `waitForMerge` polls, EVERY `--owner-go` merge (behind or not: an up-to-date PR whose main moves during the wait runs the same
   risk) adds one blocker: GitHub's `baseRefOid` is no longer the evaluated one → the existing abandon path (disable auto-merge, look
   once more, and report truthfully if it merged meanwhile). `waitBlockers` gets the evaluated base and asks for `baseRefOid` only
   then; the dry run has no wait and adds nothing. The gated `P merge` path is unchanged. Residual: main moving in the seconds
   between the last look and GitHub merging (the same as today).
7. **(Owner ruling 2026-11-05, Fable F1) The approval is NOT bound to main's commit.** The owner's "merge" stays bound to head +
   items (+ Areas); the frozen owner-go hook is not touched. If main gains more commits between the dry run and the real merge, the
   real run re-checks rules 1–6 against the new base and merges only if they still hold; its output carries `behind`
   `{behindBy, baseRefOid, mainFiles}` for the base it actually merged on.
8. **(Fable F6)** `merge.behind_base` / `behind_base_stale_paths` from the LOCAL (PR) copy of the config are never read, anywhere
   (`readBehind` included); only the base commit's.

**Code:**
- `pipeline/lib/config.mjs`: `merge.behind_base` ('update' | 'disjoint', default 'update'), `merge.behind_base_stale_paths` (string[]
  of globs, default []), allowed keys + validation + defaults.
- `pipeline/lib/finalgate.mjs`: new `behindFreshEnough({ root, config, diff, baseSha, info })` → `{ ok: true, behindBy, mergeBase,
  mainFiles }` or `{ ok: false, reason }`; `evaluateOwnerGo` passes `behind` to prOpenCheck only when it is not fresh enough, and
  returns `behind: { behindBy, mergeBase, baseRefOid, mainFiles, rule: 'disjoint' } | null`. `evaluateGate` (gated path) untouched.
- `pipeline/commands/merge.mjs`: `readBehind(gh, pr, { accepted })` — for `--dry-run --owner-go`, a compare-API "behind" whose base tip
  (`cmp.baseSha`) is the `baseRefOid` the live evaluation accepted is not a blocker; any other base (main moved in between) still is.
  Dry-run output gains `behind` (null or the accepted summary); `ownerStep.say-merge` gains `behindNote` ("behind main by N commit(s);
  main's M new file(s) touch none of this PR's files") so the request shown to the owner says it. Real `--owner-go` output gains
  `behind` too. Usage text for both modes.
- Docs: README (merge section), CLI reference, review skill's owner-go request (show `behindNote` above the Areas/Head lines).

**Tests (test/owner-go.test.mjs, test/merge-dry-run.test.mjs, test/config.test.mjs):**
- base config `disjoint`, main changed only files the PR does not touch → owner-go merges; dry run `wouldMerge` with `behind` set.
- same, but main changed a PR file → `behind-base` naming the file (first 3 + count).
- main renamed a PR file away (old name ∈ P) → `behind-base`.
- case-only difference (`Docs/A.md` vs `docs/a.md`) → `behind-base`.
- main changed `.github/workflows/x.yml` / `.claude/pipeline.yml` / a `behind_base_stale_paths` match → `behind-base`.
- PR's OWN pipeline.yml says `disjoint`, base's does not (or base has none / an invalid one) → `behind-base` (+ reason).
- mergeStateStatus `BEHIND` → `behind-base` even with `disjoint`; `DIRTY` → conflicts + behind-base-unverified as today.
- dry run: compare reports a base tip other than the evaluated baseRefOid → `behind-base`.
- a nested `sub/.gitattributes` changed on main → `behind-base`; root `.gitattributes` → `behind-base`.
- (Fable) `scripts/verify.mjs`, `.nvmrc`, a base `verify.ci_proof_inputs` match changed on main → `behind-base`.
- (Fable) a non-ASCII path (`docs/résumé.md`) and a path with a space changed on BOTH sides → `behind-base` (not accepted).
- (Fable) main removes `src/foo/` (moves it), the PR adds `src/foo/new.js` → `behind-base` naming the directory.
- (Fable) an UP-TO-DATE owner-go merge whose base moves during a queued wait → abandoned, not merged.
- mergeStateStatus `UNKNOWN` on the real `--owner-go` with `disjoint` → not accepted (parity with the dry run).
- accepted-behind merge with a queued (`--auto`) merge command; GitHub's baseRefOid changes during the wait → abandon (auto-merge
  disabled), exit 1, not merged.
- config: validation of both keys (bad value, non-array, non-string glob), defaults.

**Risk (why Fable):** the one rule that lets code reach main on a base it was not tested against. Failure mode: a meaning-level clash
the file lists cannot see (main renames a function the PR calls from an untouched file) lands on main; main's own push CI catches it
after the merge. Bounded by: owner's explicit "merge" on the exact head, opt-in per repo from the base's config, GitHub's mergeability,
toolchain/CI-config changes on main always forcing the update.

## 3. review-complete / state outcome / mark-implemented: refresh origin/<base> before hashing

**Seen:** `review-complete` right after `P update-branch` + `git pull --ff-only` refused "no review round covers the current content";
a retry moments later passed.

**Cause:** the content hash is the PR's diff against `merge-base(origin/<default_branch>, HEAD)`. `update-branch` merges main into the
PR on GitHub; `git pull --ff-only` fetches the PR branch only, so the local `origin/main` is older than the main that was merged in →
the merge base is older → the diff includes main's new commits → the hash differs from the round's. Something else (a fetch by another
command) refreshed the ref before the retry. `codex-review` fetches first and never sees it; `review-complete`, `state outcome` and
`state mark-implemented` do not fetch. The last one fails OPEN (a stale ref makes the hash differ, so an accept can be marked implemented
with no code change; `codex-review`'s empty-range check catches it later).

**Fix:** `review-context.mjs#refreshBaseRef(root, config)` — best-effort `git fetch --no-tags origin
+refs/heads/<default_branch>:refs/remotes/origin/<default_branch>` (NETWORK_TIMEOUT_MS; GitError swallowed: offline / no remote keeps
the cached ref, as codex-review does), called before `currentContentHash` in `review-complete` (inside the lock, before the hash),
`state outcome` and `state mark-implemented`. No retry loop: the stale ref is the cause. When `review-complete` still refuses on
coverage and the fetch failed, the reason adds "(origin/<branch> could not be refreshed: <first line>)". A stale ref can only make
`review-complete` / `state outcome` refuse (the round's hash was taken right after codex-review's own fetch), so best effort is safe
there. **`mark-implemented` fails CLOSED (Codex plan R1):** a stale ref makes the hash differ and would count main's commits as the
fix, so whenever the hash would be measured from `origin/<branch>` (reviewBaseRef picked it) and that ref was NOT refreshed this
call — fetch failed, timed out, or there is no `origin` remote but a leftover `refs/remotes/origin/<branch>` (Codex recheck P2) — it
exits 3 `{unavailable, reason: 'base-refresh'}` and marks nothing. Only a repo whose base resolves to the local `<branch>` (no
`origin/<branch>` ref at all) keeps today's behaviour. Test: no-origin + stale `origin/main` ref + merged newer main, unfixed accept →
exit 3, item unchanged.

**Tests (test/cli-review.test.mjs or a new test/review-complete-fetch.test.mjs):** a bare "origin" whose main moves after the local
fetch; the PR branch merges it (simulating update-branch + pull, local origin/main left stale) → `review-complete` exits 0 (without
the fix: exit 1 "no review round covers"); `state outcome` coverageValid true; `mark-implemented` on an unfixed accept → `no-code-change`;
no remote → still runs on the cached ref; `origin` pointing at a missing path (fetch fails) → `review-complete` still answers from the
cached ref, `mark-implemented` exits 3 `base-refresh` and marks nothing.

## 4. Windows shard weights refresh

DONE in the plan commit: `node scripts/shard-weights.mjs` over 8 recent successful CP CI runs (11-04/05) → 170 weights, median of
the 6 PR runs (42003385827 42003209365 41999892100 41990189638 41978076150 41968618293; the 2 main-push runs print no file times) →
`scripts/lib/test-weights.json`.
Check: the PR's own Windows shard times vs the slowest (21–29 min before cp #153; 18.5/16.7/14.2 after).

## Order / proof

1 → 3 → 2 → 4, small commits, targeted `node --test` locally per item; full suite = CI (no local full suite). Draft PR, CI green,
Codex code review + one recheck, then owner "merge" with the Head · items · repo line + 🔀.

**After merge (not in this PR):** owner updates the install; EW opts in (`merge.behind_base: disjoint` + its stale paths) in the EW
#1681 PR together with the re-vendor (the vendored validator rejects unknown `merge` keys).
