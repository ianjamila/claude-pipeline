# Plan: faster verify for database-heavy PRs (claude-pipeline)

Date 2026-10-15 · Repo ianjamila/claude-pipeline · Branch (to create) agent/verify-speedup · Risk: HIGH (changes the final gate, the last check before a merge) · Reviews: Codex + 1 recheck, then Fable once.

## In plain English
Database PRs wait over an hour today because the slow database test suite runs again after every review fix. After this change:
1. Review fixes get a lighter check (minutes, not an hour). The full check still runs once on the final version.
2. On that final version, GitHub's run of the database suite can count instead of re-running it on the Mac, but only if GitHub ran it on the exact same commit, it passed, and the PR didn't change GitHub's own test setup. Otherwise the Mac runs it as before.
3. Only a set number of full checks run at once on a machine; the rest queue in order instead of all piling on and timing out.
4. Every merge records which proof was used (Mac or GitHub), so you can always see it.
5. (Already done in #73: the merge tool itself refuses a sensitive PR unless you said "merge" for that exact version.)
Nothing changes for a repo until it opts in through its settings file. Eaglewatch opts in with a small follow-up PR in its own repo.

## Why
PR #1517 (2026-10-15) ran SQL arms 3 times (build, round-1 fixes, round-2 fix): over an hour. CI runs the same suite. Today the gate never sees CI's "SQL arms" (it is not a required check and is path-filtered), so the Mac must repeat it.

## Tasks

### T1 — lighter verify after review fixes (opt-in)
- Config: `verify.after_fix: full | quick` (default `full` = today's behaviour).
- `quick`: after ACCEPT fixes the verifier runs TWO checked invocations (Codex R1-7: `--only` replaces the quick set, it does not add to it, template verify.mjs:249):
  1. `verify.quick` (typecheck, lint, quick unit tests);
  2. when the round's fix diff (`<round's reviewed head>..HEAD`, renames counted on both sides) matches a glob in the new optional `verify.after_fix_steps_by_path` map (e.g. `supabase/** -> [db, db-grants]`), `verify.full --only <those steps>`. Steps listed in `verify.after_fix_never` (eaglewatch: `sql-arms`) are refused in the map.
  Either red stops the round (fix cycle, as today). New `P verify plan-after-fix --round R` prints the exact commands so the skill never builds them by hand.
- Unchanged: the initial full verify (Step 2.2) — the early database proof before any review — and the fresh full verify at the gate (Step 5.3). The gate still refuses anything but a full, clean report on the exact head.
- Files: skills/ship/reference/review-loop.md §6, skills/ship/SKILL.md Step 4 summary, pipeline/commands/verify.mjs (new subcommand) or a small new module, pipeline/lib/config.mjs (validate), pipeline/templates/pipeline.yml, docs.
- Tests: config validation (values, map shape, unknown/never steps refused); plan-after-fix: no match -> quick only; match -> both commands; rename into/out of a mapped path; behaviour test that a red second invocation fails the round.

### T2 — CI proof for a deferred step at the final gate (opt-in)
- **Trusted proof identity (Codex R1-1).** Config: `verify.ci_proof: { <step>: { workflow: ".github/workflows/<file>.yml", job: "<job name>", event: "pull_request" } }`. Matched by workflow FILE PATH + job name, never by check name alone, so another workflow emitting "SQL arms" never counts.
- **The proof settings are taken from the base branch, not the PR (Codex R1-1).** The gate reads `verify.ci_proof`, `verify.deferrable_steps` and `verify.ci_proof_inputs` from `.claude/pipeline.yml` at `origin/<default_branch>`; a PR that changes them gets no CI proof (local proof required). Automatically protected inputs, always: `.github/**`, `.claude/pipeline.yml`, `scripts/verify*`, plus the repo's `verify.ci_proof_inputs` (eaglewatch: the suite's specs, runner and deps files).
- **Defer is separate from skip (Codex R1-2).** New `verify.deferrable_steps`, separate from `skippable_steps`. A step in `deferrable_steps` may be reported only as `pass`, or `skipped` with `skipKind: "ci"`; any other shape for it (no skipKind, `local`, legacy skip) is refused. A step in BOTH lists (eaglewatch sql-arms: local "no inputs changed" skip + CI deferral) must carry an explicit `skipKind` of `local` or `ci`; `local` keeps today's rule, `ci` requires the CI proof; missing/unknown kinds are refused. Steps only in `skippable_steps` keep the legacy behaviour byte-for-byte.
- Verify template (`pipeline/templates/scripts/verify.mjs`): new `--defer <step>` flag reports `status: skipped`, `skipKind: "ci"`, reason `deferred to CI (<workflow>#<job>)`; the template's own local skips gain `skipKind: "local"`.
- **Run selection (Codex R1-3).** The gate lists workflow runs via `repos/<slug>/actions/workflows/<file>/runs?head_sha=<head>&event=<event>` with complete pagination, keeps runs whose `head_sha`, `repository.full_name` and `path` match, and takes the run with the highest `run_number`, then its highest `run_attempt` (no timestamps involved). Then the jobs of that attempt (`.../runs/<id>/attempts/<n>/jobs`, paginated) must contain exactly one job named `<job>` (a matrix/sharded job: an aggregator job name is configured); it must be `completed` + `success`. Any newer run or attempt that is queued/in progress -> `pending` (an older success never wins). Missing fields, duplicates, an incomplete page -> refused (fail closed).
- **The run must belong to THIS PR (Codex R2-1, corrected by Fable).** `pull_requests` is filled at READ time, not run time (guard-provenance.mjs:24-27; live eaglewatch runs 732/733 show today's main tip as `base.sha` and a newer PR head), so it proves the PR link but NOT what was tested. Binding, following guard-provenance.mjs:147: `pull_requests` has exactly one entry = this PR number with `base.ref` = the default branch; `head_branch` = the PR's `headRefName`; `head_repository.full_name` = this repo (not `repository`, which is wrong for forks). **What was tested:** where the run carries `referenced_workflows` (eaglewatch's does: `ref: refs/pull/<N>/merge` + the merge commit sha it executed), require `ref == refs/pull/<N>/merge` and that commit's `tree.sha` == `git rev-parse HEAD^{tree}` after Step 5.2 (head already contains the base tip, merge.mjs:97-104) — a deterministic "this run tested exactly my tree" proof. Without `referenced_workflows`: tree equality follows from 5.2's up-to-date head; documented as the weaker case. Missing linkage -> refused, never guessed. Fixtures built from the real run shapes (runs 730 skipped-draft, 732 cancelled, 733).
- Outcomes: success -> pass, records the proof; pending -> `ci-proof-pending:<step>`; failure -> fails like a red check (fix cycle); **cancelled = superseded (run 732), not red -> treated as missing**; none / ineligible / a `gh`/API error -> `ci-proof-missing:<step>`, and the skill immediately re-runs a fresh FULL verify without `--defer` (Codex R2-2: `--only` would leave a partial report the gate refuses). No waiting on an API error.
- **Where the check lives (Fable).** NOT a new gate check: `CANONICAL_CHECKS` is frozen (finalgate.mjs:34) and `gateRefusals` refuses missing or unexpected names (finalgate.mjs:540-546), so a new name would break every saved gate and the "unchanged" promise. The proof is evaluated INSIDE `verifyReportCheck` when a `skipKind: "ci"` row appears; results go in a new `proofs: [...]` field on the gate JSON; `ci-proof-pending/missing` are detail causes of `verify-report`. `skipOf` lives in pipeline/lib/verify-steps.mjs:12 (added to Files).
- **Sequencing so CI can actually win (Fable).** The SQL arms job skips drafts (`if: !draft`, run 730 skipped) and today the PR is readied at 5.5, AFTER the gate's verify, so CI would only start then. With `ci_proof` configured, the skill runs `gh pr ready` right after Step 5.2, so CI runs in parallel with the (deferred) local verify. This adds zero CI minutes: eaglewatch's own `npm run merge` already requires "SQL arms" whenever its inputs change (expected-checks.mjs:199) — T2 only moves an existing wait earlier and stops the Mac repeating it.
- **Waiting limits (Codex R1-8, Fable).** Deferral only when eligible up front (no protected input touched). Wait for the proof at most `verify.ci_proof_wait_minutes` — no fixed default; the eaglewatch follow-up sets it from the measured CI duration (sharded) and `merge.wait_minutes`, never above the local sql-arms time it replaces. Past it, or on `ci-proof-missing`, a fresh full verify without `--defer` runs at once. `git fetch origin <default_branch>` before reading the base-branch settings. Activation for eaglewatch is gated on PR B (always-report + draft runs + 3 shards with an aggregator that is green only when all shards ran) and one measured DB PR.
- **The merge records the proof it used (Codex R1-9).** `P merge` re-evaluates the proof live (inside the verify-report re-check) and writes the selected run/attempt/job into the run record and the PR summary before merging; a failure to write stops the merge (fail closed). It also posts an append-only `ci-proof-used` run event (run-events.mjs pattern, Codex R2 P3), so a later summary rewrite or record reset cannot erase the audit trail. The summary prints "SQL arms proof: GitHub run <id> attempt <n>" or "Mac".
- Files: pipeline/lib/finalgate.mjs, pipeline/lib/verify-steps.mjs, pipeline/lib/ci-proof.mjs (new), pipeline/lib/config.mjs, pipeline/commands/merge.mjs, pipeline/lib/run-record.mjs (proof field), pipeline/templates/scripts/verify.mjs (+ scripts/verify.mjs, test/self-verify.test.mjs), skills/ship/SKILL.md 5.3/5.5/5.7/6, skills/ship/reference/gates-and-exits.md, docs/cli.md, README.
- Tests: exact-head success passes + recorded; other head refused; other workflow with the same check/job name refused; PR that edits `.claude/pipeline.yml`, `.github/**` or a `ci_proof_inputs` path -> no CI proof; deferrable step reported with missing / unknown / `local`-only-allowed-when-in-both / legacy skip shapes; highest run_number/run_attempt wins; newer queued attempt blocks an older success; equal/missing metadata refused; pagination across pages incl. a truncated page; matrix/aggregator job; failure/cancelled; gate passes with run A then merge sees run B -> B recorded; persistence failure stops the merge; same head + same workflow path but a different PR or base -> refused; empty `pull_requests` -> refused; base not an ancestor / different workflow blob -> refused; end-to-end "deferred full report -> proof missing -> fresh full verify -> gate passes"; merge integration (canonical check list, legacy configs, live proof replacement, finalgate.mjs ~540); `plan-after-fix` commands for both a plain `node scripts/verify.mjs` and an `npm run verify --` config (argument forwarding); repos without the keys unchanged (whole existing gate suite green).

### T3 — fewer full verifies at once on one machine (opt-in) — redesigned after Fable
Fable: a load threshold adds waiting instead of removing it (load 40-60 on 14 cores is normal, eaglewatch scripts/verify.mjs:134; every waiter would release together), and the 106-min case was slot contention + the 60-min run cap (sql-arms-slots.mjs header), not start-time load.
- **Primary: full-verify slots.** Config `verify.max_parallel_full: <n>` (unset = no limit). New `P verify slot --acquire|--release` uses the proven machine lock in pipeline/lib/locks.mjs (stale-owner reclaim, per-machine): at most n full verifies of ANY repo run at once on this machine; others queue in arrival order. The skill wraps every full verify (Steps 2.2, 5.3, after-fix when `full`) in acquire/release; release also on failure/kill (lock reclaim handles crashes).
- **Secondary, optional: load check.** `verify.max_load` with a short timeout (default ≤ 10 min), 5-30 s random jitter and a re-check before starting, so waiters don't release together. On timeout it proceeds with a warning.
- The summary reports seconds waited for a slot / for load, so the values can be tuned from data. Eaglewatch's numbers are picked from measurement, not guessed.
- Windows native: loadavg is 0 -> load check is a no-op with a note; slots still work.
- Files: pipeline/commands/verify.mjs (slot subcommand, alongside plan-after-fix), pipeline/lib/locks.mjs (reuse; extend only if needed), skills/ship/SKILL.md, docs/cli.md. Commands are discovered from filenames (pipeline.mjs:12): no dispatcher change.
- Tests: slots (n reached -> queue in order; release frees; dead owner reclaimed; two repos share the machine limit), load check (below at once, jitter, timeout proceeds with warning), Windows no-op.

### T5 — the merge tool itself enforces the owner's "merge" — DONE before this PR: shipped as the #58 fix in #73 (3651520); kept here for the record, not built again
Fable + confirmed in code: with `owner_approval: chat`, a gate with `ownerMerge > 0` is held only by skill prose (SKILL.md "Owner-merge approval"); `P merge` (merge.mjs ~55-75) demands `--owner-approved-head` only for resumed or unreadable records. A weaker controller could merge a hard-stop PR without the owner.
- `P merge`: when the saved gate (and its live re-check) for the head has `ownerMerge > 0` in chat mode, refuse unless `--owner-approved-head <full 40-char sha>` equals that head. Same refusal shape as the resumed-run rule (`error: pre-merge`, nothing merged). Label mode unchanged.
- Skill text: say the CLI enforces it (prose stays as the explanation). Any `ownerMerge` source counts: hard-stop hits, integrity violations, owner-ruled review items.
- Tests: chat + ownerMerge>0 without flag -> refused; wrong/short sha -> refused; exact head -> merges; ownerMerge 0 -> unchanged; label mode unchanged; resumed rule still works; head moved after approval -> refused.

### T6 — docs + agent log
README "Project settings" section, cli.md, template pipeline.yml comments, agent-log line.

```pipeline-scope
pipeline/lib/finalgate.mjs
pipeline/lib/config.mjs
pipeline/lib/ci-proof.mjs
pipeline/lib/verify-steps.mjs
pipeline/lib/locks.mjs
pipeline/lib/run-record.mjs
pipeline/lib/run-events.mjs
pipeline/commands/verify.mjs
pipeline/commands/merge.mjs
pipeline/templates/pipeline.yml
pipeline/templates/scripts/verify.mjs
scripts/verify.mjs
skills/ship/**
test/**
docs/**
README.md
```

## Not in this PR (proposed follow-ups)
- MOVED to the ship-redesign PR (owner 10-15, after Codex R1-4/5/6): the gate's "files outside the approved plan" check and the planning budget. They need the plan-approval state first: a pre-PR plan identity, the approved scope kept separately from later edits (re-recording must not erase a violation), approval stored durably (not in the disposable run record), "never had a plan" distinct from "plan lost" (fail closed), budget reserved BEFORE a reviewer is dispatched (idempotent on retry), token tallies deduplicated per message id and persisted before switching machines. Budget = review caps (Codex review + 1 recheck, 1 Fable) + reported token use; no numeric ceiling.
- eaglewatch PR (after this merges and after #1507): its verify.mjs supports `--defer`; pipeline.yml sets `after_fix: quick`, `after_fix_steps_by_path`, `deferrable_steps: [sql-arms]`, `ci_proof: {sql-arms: {workflow: .github/workflows/migration-replay.yml, job: "SQL arms", event: pull_request}}`, `ci_proof_inputs: [supabase/tests/sql-arms/**, scripts/sql-arms*, scripts/lib/sql-arms-deps.mjs, ...]`, `max_parallel_full` (value from measurement), `ci_proof_wait_minutes` (from measured sharded CI time); re-vendor. eaglewatch's verify.mjs (since #1507, merged 10-15) reports its "no sql-arms dependency changed" skip as `status: skipped` + `skipReason` with no kind; the follow-up must add `skipKind: "local"` to that row, because sql-arms will be in both lists and the stricter gate refuses an unlabelled skip there. Enabling CI proof there needs evidence first (Codex R1/R2 gaps): the aggregator job is green only when ALL expected shards ran and passed (an always-report job after skipped or empty shards must not count), the CI job runs the same suite as local sql-arms on the PR head checkout, its draft->ready trigger and path filter behave as assumed, and the run/attempt/job API shapes match the fixtures. Until PR B lands (always-report + draft runs + 3 shards with one aggregator job), eaglewatch enables only `after_fix` and the slot limit.
- eaglewatch PR B (with/after #1516): run SQL arms on draft DB PRs and always report.
- Item 6 (local shards) deferred; item 7 (pre-migrated base DB) measure first.

## Measure after enabling
Compare one database PR before and after (total wait, Mac minutes, CI minutes), including a timeout-plus-fallback case, against the owner's "no longer waits, no extra cost" rule.

## Safety argument
- The gate still needs a fresh, clean, full report on the exact head. The only new way a step passes without running locally is a successful run of the configured workflow + job, tied to this PR, that tested exactly this tree, on a PR that did not touch the workflow, the pipeline settings or the suite's inputs; the settings themselves come from main. Anything unclear falls back to the Mac, never to a pass.
- Everything is opt-in; repos without the new keys behave exactly as today.
- Every file here is a claude-pipeline hard-stop: the owner merges in chat. Both machines reinstall after merge.

## Budget
Build order (Fable): T1 -> T3 -> T5 -> T6 -> T2 (T5 already merged in #73, so this PR builds T1 -> T3 -> T6 -> T2) (T2 last; it is idle until eaglewatch PR B anyway). One PR by default; if T2's review drags, carve it out late with reason (d): T1/T3 unblock eaglewatch now. Implementers: Sonnet, one per task. Planning used: Codex xhigh review + 1 recheck, Fable once (owner decision: review caps + token report, no numeric ceiling).

## Rollout
config.mjs rejects unknown keys (config.mjs:3, 87, 123) and the verify template ignores an unusable config (template verify.mjs:252), so the eaglewatch follow-up that sets the new keys may merge ONLY after both machines have reinstalled this version. Eaglewatch enables `after_fix` + slots right after both reinstalls; `ci_proof` only after PR B and one measured DB PR.
