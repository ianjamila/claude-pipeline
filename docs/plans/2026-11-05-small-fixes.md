# Small fixes after F7 (2026-11-05)

One CP PR, branch `agent/small-fixes-1105` off origin/main acae651. Never ship/review on CP; plan → Codex (review + one recheck) → ONE
Fable pass (item 2 changes merge gating = pipeline core) → implement → CI → owner "merge".

Found on EW #1658 (F7). Not ours (other sessions): CP #159 / PR #168 (ci-wait), cp #164, CP #161/#163/#175.

## 1. codex-review: a pure main merge after accepted items is `empty-range`, not `baseOnly`

**Seen:** #1658 rounds after da69897 and f851f354 (both `Merge branch 'main'`, no conflict) exited 2 `empty-range` "round N would review
nothing: the branch content has not changed since round 2, and earlier rounds accepted items that need a fix"; `review-complete` then
passed, i.e. nothing needed a fix.

**Cause:** `pipeline/commands/codex-review.mjs:229-235` refuses when ANY round ever accepted an item (`hasAccepted`) and the content
hash (the PR's own diff against its fork point) is unchanged since the last round. A clean merge of main never changes that hash, and
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
2. **GitHub agrees it can merge:** `mergeStateStatus` is not `BEHIND` (that only appears under strict branch protection, where GitHub
   itself refuses) and not `DIRTY`; `mergeable` is `MERGEABLE` (prOpenCheck already requires it — #1642 landed a real README conflict
   between a dry run and the merge).
3. **Disjoint:** M = every path main changed from `merge-base(baseRefOid, HEAD)` to `baseRefOid` (local `git diff`, renames as both
   names; no 300-file API truncation), P = every path the PR changes (the same diff the scan uses, already cross-checked against
   GitHub's `pulls/N/files` by scan-range). M ∩ P = ∅, compared case-insensitively (case-insensitive file systems).
4. **Nothing on main's side that changes how the checks run:** no path in M matches the built-in list (`.github/**`,
   `.claude/pipeline.yml`, `.gitattributes`, `.gitmodules`) or the base's `merge.behind_base_stale_paths` (globs, default `[]`; EW
   will add its toolchain files, e.g. `package.json`, `package-lock.json`, `tsconfig*.json`, `supabase/**`).
5. Everything else unchanged: required checks green on THIS head, labels, hard-stops / integrity / owner items, the owner's recorded
   "merge" for this head + items (+ Areas), and the last look (`preMergeProblems`) refusing when baseRefOid or headRefOid moved since
   the evaluation.

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
coverage and the fetch failed, the reason adds "(origin/<branch> could not be refreshed: <first line>)".

**Tests (test/cli-review.test.mjs or a new test/review-complete-fetch.test.mjs):** a bare "origin" whose main moves after the local
fetch; the PR branch merges it (simulating update-branch + pull, local origin/main left stale) → `review-complete` exits 0 (without
the fix: exit 1 "no review round covers"); `state outcome` coverageValid true; `mark-implemented` on an unfixed accept → `no-code-change`;
no remote → still runs on the cached ref.

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
