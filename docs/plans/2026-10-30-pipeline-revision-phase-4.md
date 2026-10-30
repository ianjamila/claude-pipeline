# Pipeline revision Phase 4 — slim the pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~870-line `ship` skill with a ~120-line `review` skill, delete the deploy / prod-watch / inbox / resume / notify / session-version machinery, land the last guard fixes (#110, #111, #113) and then freeze the guards, add the #112 tests, and cut Windows CI from 24–30 min to ~10 min with shards (fixing flake #116).

**Architecture:** Deletions go leaf-first: move the three finalgate helpers that survivors use to a shared lib, then delete each subsystem and untangle its callers in the same task (so every commit leaves a green, import-clean tree). The installer and vendor learn a "retired" list so an update removes the old `ship` skill, the `session-version` hook and EW's vendored `stop-verify.mjs`. Windows CI becomes a 3-shard matrix plus an aggregate job that keeps the required name `test (windows)`.

**Tech Stack:** Node 20/24 ESM (`.mjs`), `node --test`, GitHub Actions. No dependencies added.

**Spec:** `~/Claude/codex-plan-review/IMPLEMENTATION.md` § "Phase 4 — Slim the pipeline" (plus its "Rules for every session"). Folded in by the owner 2026-10-29/30: issues #110, #111, #112, #113, #116.

## Global Constraints

- Worktree `~/Claude/claude-pipeline/.worktrees/pipeline-revision-phase-4`, branch `chore/pipeline-revision-phase-4` from origin/main `7eeabc9`. Small commits; stage files by name (never `git add -A` / `git add .`). Never push to main, never force-push.
- Never run `ship` on CP. Don't edit anything under `~/.claude` (the owner installs). Don't edit EW from here.
- Mac load: no full suite locally. Run only the touched test files: `node scripts/test.mjs <basename-substring>` (matches by basename SUBSTRING), one invocation at a time. For a guard change run the whole family: `node scripts/test.mjs guard` (~10 min). Never run a mutation script while a suite runs.
- The pipeline guard blocks `node -e` / heredocs containing guarded words (ownerMerge, merge commands, remove-label) → use the Edit tool or a `.mjs` file in the scratchpad.
- Keep `pipeline/lib/config.mjs` accepting `production:`, `preview:`, `smoke_checks:` and `verify.stop_queue_wait_minutes` exactly as today (EW's config uses them; Phase 5 re-vendors).
- Keep `pipeline/lib/run-progress.mjs` (cost needs it), the stack hooks, the Fable model proof (`lib/transcript.mjs`, `commands/model-proof.mjs`), `run-record` / `run-cost` step names (old run records must stay readable).
- Guard hooks (`pipeline/hooks/**`): the ONLY changes in this phase are Task 5's (#110, #111, #113, and protecting the installed `skills/review`). After Task 5 they are frozen.
- Bug fixes: failing test first, mutation-check it (revert the fix → the test fails).

## Review Focus

1. **An existing install updated in place** (has `skills/ship/`, the SessionStart `session-version` group, the old `Read|Edit|Write|Grep|Glob|NotebookEdit` stack-register matcher) → after `update`, all three are gone/replaced, `--check` reports no drift, a second update is a no-op, the owner's own hooks are untouched; an owner-edited ship file is backed up, not lost. Pinned in Task 4 (hooks, matcher, retirement mechanism) and Task 6 (ship).
2. **A dangling import** left by a deletion (a module or test still importing a deleted file, found only when that path runs) → a static test fails. Pinned in Task 3 (`test/no-dangling-imports.test.mjs`).
3. **A Windows shard failing or being cancelled** → the aggregate `test (windows)` check is red, never green or skipped. Pinned in Task 8.
4. **A ruling request reused for changed content** (same id `R1-B1`, different finding text) → `owner-ruling` refuses. Pinned in Task 5.
5. **EW's vendored copy after a re-vendor** (no `stop-verify.mjs`, EW's real `.claude/pipeline.yml` still validates) → vendor removes the retired file, `--check` flags a leftover, EW's config validates. Pinned in Task 4 + final verification.

---

### Task 1: Shared lib for the finalgate helpers

**Files:**
- Create: `pipeline/lib/cmd-io.mjs`
- Modify: `pipeline/lib/finalgate.mjs` (remove the three, import them from cmd-io), `pipeline/commands/agent-log.mjs:13`, `pipeline/commands/smoke.mjs:8`, `pipeline/commands/summary.mjs:18`, `pipeline/commands/final-gate.mjs:8`
- Test: `test/cmd-io.test.mjs` (move the existing tests of these three from their current test file; do not duplicate)

**Interfaces:**
- Produces: `inlineOptionValues`, `tailLines`, `writeReviewJson` exported from `pipeline/lib/cmd-io.mjs` with UNCHANGED signatures. finalgate does not re-export them; every caller imports from cmd-io.

- [ ] Step 1: `git grep -n "inlineOptionValues\|tailLines\|writeReviewJson"` — list every caller and every test.
- [ ] Step 2: Move the three functions verbatim (with any private helpers only they use) into `cmd-io.mjs`; repoint callers.
- [ ] Step 3: Move their tests into `test/cmd-io.test.mjs`; run `node scripts/test.mjs cmd-io`, `node scripts/test.mjs final-gate`, `node scripts/test.mjs smoke`, `node scripts/test.mjs summary`, `node scripts/test.mjs agent-log` → PASS.
- [ ] Step 4: Commit `refactor: move finalgate's shared helpers to lib/cmd-io`.

### Task 2: Delete deploy / prod-watch / vercel; untangle merge and the final gate

**Files:**
- Delete: `pipeline/lib/{prodwatch,deploy,vercel}.mjs`, `pipeline/commands/{prod-watch,deploy}.mjs`, `test/prod-watch.test.mjs` and every test file that only tests them.
- Modify: `pipeline/commands/merge.mjs` (drop `currentProduction`, `prodBefore`, `prod-before.json`, the prod-before event comment and its fail-closed step 3c; exit 3 now means only "GitHub unavailable"; `prodBefore` leaves the output), `pipeline/lib/finalgate.mjs` (drop `previewCheck`; `expectedCheckNames()` takes no argument and returns `CANONICAL_CHECKS`), callers of `expectedCheckNames`, `test/{cli-gh,github,guard-npm-scripts,hardstops,gate-fix-seams,cli-gate-ci,ci-guards,agent-log-close,config,docs-facts}.test.mjs` where they reference the deleted code, `pipeline/templates/pipeline.yml` comments, `docs/cli.md`, `README.md`.
- Keep: `lib/agentlog-close.mjs` (parses the CI-posted prod-smoke marker; imports nothing deleted), `config.mjs` validation of `preview`/`production` (unchanged; add a one-line comment that the gate and merge no longer read them — only `P smoke` reads `production`).

**Interfaces:**
- Produces: `expectedCheckNames(): string[]` (no parameter). `P merge` output `{ok, merged, mergeSha, warning?, warnings?}` (no `prodBefore`).

- [ ] Step 1: Failing tests first: in `test/merge*.test.mjs`, a repo whose config has `production:` set merges WITHOUT any deployments API call and without writing `.review/prod-before.json`; in the final-gate test, a config with `preview:` set yields a gate whose check names equal `CANONICAL_CHECKS` (no `preview`). Run → FAIL.
- [ ] Step 2: Delete and untangle as listed; update `meta.usage` strings of merge and final-gate to match.
- [ ] Step 3: `git grep -nE "prodwatch|prod-watch|lib/deploy|vercel\.mjs|findDeployment|currentProduction|prodBefore|preview-smoke"` → only docs/specs, docs/plans, run-record/run-cost step-name data and `files-policy` patterns (frozen guard) remain. List what remains in the commit message.
- [ ] Step 4: Run each touched test file → PASS. Commit `refactor!: remove deploy, prod-watch and vercel; merge and final gate no longer read deployments`.

### Task 3: Delete inbox / resume-plan / notify / guard-replay; untangle summary, worktree-prune, local-branches

**Files:**
- Delete: `pipeline/lib/{inbox,resume-plan,notify}.mjs`, `pipeline/commands/{inbox,resume,notify}.mjs`, `tools/guard-replay/`, `test/{inbox,inbox-command,resume-plan,resume-command,notify,notify-coverage}.test.mjs`, `test/fixtures/notify-send.mjs`. (session-version goes in Task 4, with the installer change, so no commit is uninstallable.)
- Keep `--notify` on `P worktrees prune` as an accepted, documented no-op (installed cron/launchd schedules pass it); drop it from `WORKTREES_PRUNE_ARGS` in `pipeline/lib/schedule.mjs` so new schedules stop adding it. If a schedule `--check` compares installed args to `WORKTREES_PRUNE_ARGS`, an old schedule with `--notify` must still count as current (test it).
- Create: `pipeline/lib/remote-url.mjs` with `parseRemote` moved verbatim from notify (+ its tests into `test/remote-url.test.mjs`).
- Create: `test/no-dangling-imports.test.mjs`.
- Modify: `pipeline/commands/summary.mjs` (drop the notify step and the `notify` output field; keep everything else), `pipeline/lib/worktree-prune/{prs,run}.mjs` (import `parseRemote` from remote-url; drop the notify step and its output field), `pipeline/lib/local-branches.mjs` (delete exports with no remaining caller — expected `localBranchState`, `orphanWorktrees` — and their tests; keep `listWorktrees`), `scripts/test.mjs` (drop `PIPELINE_NOTIFY`; drop `PIPELINE_SECRETS_FILE` only if `git grep` shows nothing else reads it), `test/{cli-gate-log,run-record}.test.mjs` where they reference deleted code, `docs/cli.md`, `README.md`, `docs/HANDOFF.md`.

**Interfaces:**
- Produces: `parseRemote(url)` from `pipeline/lib/remote-url.mjs` (same signature/return as before). `P summary` / `P worktrees prune` outputs without a `notify` key.

- [ ] Step 1: Write `test/no-dangling-imports.test.mjs`: walk `pipeline/`, `scripts/`, `test/`, `install.mjs`, `.github/scripts/` for `.mjs`; for each static `import … from '<rel>'` / `export … from '<rel>'` / `import('<literal rel>')` with a relative specifier, assert the resolved file exists. Assertion message names importer and specifier. Run → FAIL once the deletions start, PASS at the end.
- [ ] Step 2: Delete and untangle as listed.
- [ ] Step 3: `git grep -nE "inbox|resume-plan|notify|guard-replay"` outside docs/specs and docs/plans → only `checkpoint --resumed` / merge's resumed-run refusal (kept: it guards old run records), the `--notify` no-op and the ship skill (Task 6). Run `no-dangling-imports`, `remote-url`, `summary`, `worktree`, `schedule`, `local-branches`, `cli-gate-log`, `run-record` → PASS.
- [ ] Step 4: Commit `refactor!: remove inbox, resume, notify and guard-replay`.

### Task 4: Retire session-version and stop-verify (installer + vendor); narrow the stack-register matcher

**Files:**
- Delete: `pipeline/lib/session-version.mjs`, `pipeline/hooks/session-version.mjs`, `test/session-version.test.mjs`, `pipeline/templates/scripts/pipeline/stop-verify.mjs`.
- Modify: `pipeline/lib/installer.mjs` (hook list ~L152, SessionStart group, classifier ~L606/619), `pipeline/commands/vendor.mjs` (ENTRIES), `install.sh` / `install.ps1` / `install.mjs` only if they name session-version, `.github/scripts/installer-round-trip.sh:26` (expected matcher list), `test/{guard-files,identity,install}.test.mjs` where they reference session-version, `skills/pipeline-setup/SKILL.md` (no Stop hook / stop-verify), `docs/cli.md` (vendor, install).
- Test: `test/install.test.mjs`, `test/vendor.test.mjs`, `test/templates.test.mjs`, `test/config.test.mjs`.
- NOT here: the ship skill (retired in Task 6, together with its complete replacement).

**Interfaces:**
- Produces: `RETIRED_HOOKS = ['session-version']` and a retirement mechanism Task 6 reuses for `RETIRED_SKILLS = ['ship']`: a retired unit's manifest-listed files are removed on update; a manifest-listed file the owner modified is backed up exactly like today's edited-unit backup (`install.mjs` ~L270, `test/install.test.mjs` ~L982) before removal and reported; files in that directory the manifest does not list are kept and reported, never deleted; an update interrupted mid-retirement completes on the next run. `STACK_REGISTER_MATCHERS = ['Bash', 'Edit|Write|MultiEdit|NotebookEdit']`. Vendor `RETIRED_ENTRIES = ['stop-verify']`.

- [ ] Step 1: Failing install tests, built on an install made by the CURRENT main shape (SessionStart group running `pipeline/hooks/session-version.mjs`, the old stack-register matcher `Read|Edit|Write|Grep|Glob|NotebookEdit`, plus one owner SessionStart hook and one owner PreToolUse hook): after `update` → `pipeline/hooks/session-version.mjs` gone, no settings entry runs it, stack-register sits on exactly the two new matchers, the owner's hooks byte-identical, `--check` no drift, a second update changes nothing, `--uninstall` from the old shape leaves no pipeline files. Plus the generic retired-unit cases above (modified file backed up, unlisted file kept, interrupted update completes), exercised on a test-only retired unit so Task 6 only adds `'ship'` to the list.
- [ ] Step 2: Failing vendor tests: vendoring into a repo that has `scripts/pipeline/stop-verify.mjs` from an earlier vendor removes it and says so; `--check` on such a repo reports it as drift; a repo without it is unaffected. The existing vendored-module loading tests still pass for the remaining entries.
- [ ] Step 3: Implement. The settings classifier must still recognise an old session-version entry and an old-matcher stack-register entry as OURS (so update removes/replaces them). `config.mjs` keeps accepting `stop_queue_wait_minutes` (comment: retired, kept for configs that still set it). Update `installer-round-trip.sh` to the new matcher list.
- [ ] Step 4: Run `install`, `vendor`, `templates`, `config`, `identity`, `no-dangling-imports` → PASS; `bash .github/scripts/installer-round-trip.sh "<scratchpad>/claude home"` → PASS. Commit `feat(installer)!: retire session-version and stop-verify; stack-register on Bash + write tools`.

### Task 5: Last guard fixes (#110, #111, #113), then freeze

**Files:**
- Modify: `pipeline/hooks/lib/owner-go.mjs` (~L93–96 RULING_LINE, ~L244–260 recorder, ~L359–368 lookup), `pipeline/commands/triage.mjs` (new subcommand + owner-ruling check), `pipeline/lib/triage.mjs` (digest), `pipeline/hooks/lib/files-policy.mjs` (inode check), `pipeline/hooks/lib/line-writes.mjs` (~L244 curl glob).
- Test: `test/owner-go.test.mjs`, `test/triage*.test.mjs`, `test/guard-files.test.mjs`, `test/guard-owner-stop-forge.test.mjs` or wherever the current curl `-g` case lives (port the two test changes of commits 23a45ae + f36818a, branch `agent/chat-mode-no-needs-human`, whose code then lived in git-policy.mjs).

**Interfaces:**
- Produces: `rulingContentDigest(items): string` in `pipeline/lib/triage.mjs` = first 12 hex of sha256 over `JSON.stringify` of one tuple per item, sorted by id: `[ID_UPPER, source, bucket, category, title, file, line, detail, codexReasoning, arbiter?.reasoning]` (each `?? null`). These are the REAL item fields (Codex items: `pipeline/lib/codex.mjs` ~L255–275 `title`, `detail`, `codexReasoning`; Fable items: `pipeline/lib/triage.mjs` ~L130–142 `title`, `detail`, and the reasoning NESTED at `item.arbiter.reasoning`). Never hash mutable decision fields (`final`, owner-ruling results, `implemented`), so applying the first decision of a request does not invalidate the others. Confirm every finding-text field of both schemas is in the tuple; tests build items with the real producers, never hand-made `{title, body}`. `P triage ruling-request --pr N --ids A,B [--repo DIR]` → `{ok, line}` where `line` = `⚖️ Owner ruling needed #N: A, B · content <digest12> · repo <owner/name>`, digest over exactly the asked ids from the PR's current triage state (unknown id → exit 1). RULING_LINE accepts `· content <12 hex>` (recorded as `content`). `owner-ruling --id X` recomputes the digest over the record's FULL `ids` list from current state (any of them missing → refuse) and requires it to equal `record.content`.

- [ ] Step 1 (#110): failing tests — (a) ruling recorded for `R1-B1` with digest X; R1-B1's `detail` changes in triage state; `owner-ruling` refuses with a message naming the content change; (a2) separate cases changing ONLY `title`, ONLY `codexReasoning`, ONLY a Fable item's `detail`, ONLY a Fable item's `arbiter.reasoning`; (b) unchanged content → accepted; (c) a two-id request (`R1-B1, R1-S2`): R1-S2's text changes → ruling on R1-B1 is refused too; (c2) a two-id request answered for both: applying R1-B1's ruling first, then R1-S2's → both accepted (the first application does not change the digest); (d) a record without `content` (old line shape) → refused, fail closed. Implement; mutation-check (drop the digest comparison → (a) fails; drop `title` / `arbiter.reasoning` from the tuple → the matching (a2) case fails).
- [ ] Step 2 (#111): failing tests on the REAL filesystem — a script (run-time path) creates a symlink to `<cwd>/.review` and writes `state.json` through it → denied; same for `round-1/<file>` through a symlink to `.review/round-1`. Allow tests that must stay green: `.review/hardstops.json` and other scratch files directly in `.review` (today's `test/guard-files.test.mjs` ~L960 case), written by name and through the alias. Implement WITHOUT adding `.review` to `hitInode`'s root set (`files-policy.mjs` ~L275 walks ancestors, so that would protect every child): instead keep the protected-NAME rule — a target whose parent directory has the dev+ino of `<cwd>/.review` is a hit only if its basename matches the REVIEW_FILE_SRC names; any target under a directory whose dev+ino equals an existing `<cwd>/.review/round-*` is a hit. Missing directory → no entry (no error). Mutation-check.
- [ ] Step 2b (Codex P1): add `.claude/skills/review` to the protected skill list in `files-policy.mjs` (~L37–40, next to `.claude/skills/ship`, which stays for older installs). Tests: an Edit/Write tool call and a shell write (`>`/`tee`/`cp`) to `~/.claude/skills/review/SKILL.md` are denied; writing a different skill under `~/.claude/skills/` stays allowed. Mutation-check.
- [ ] Step 3 (#113): port the two commits: any curl write to a GitHub URL containing `[` or `{` is refused whether or not `-g` / `--globoff` is present; the IPv6 exemption needs a colon and must end the host. Port their tests. Mutation-check.
- [ ] Step 4: Run `node scripts/test.mjs guard`, then `owner-go`, then `triage` → PASS (one at a time). Commit per issue (`fix(guard): … (#110)` etc.).

### Task 6: The review skill; verify and docs follow

**Files:**
- Create: `skills/review/SKILL.md` (target ~120 lines, hard cap 160), optionally `skills/review/reference/<one file>.md` only for the owner-merge and owner-ruling line formats.
- Delete: `skills/ship/**`; in `pipeline/lib/installer.mjs` set `SKILLS = ['review', 'verify', 'pipeline-setup']` and add `'ship'` to Task 4's `RETIRED_SKILLS`, with an install test from the old shape (`skills/ship/**` in the manifest, one file owner-edited, one owner-added file): ship removed, edited file backed up, added file kept, `--check` clean.
- Modify: `skills/verify/SKILL.md` (drop "before every commit you intend to push" and verify-at-every-turn; the rule becomes: quick check on the changed area before a push, CI is the full proof; keep the bug-fix-test-first, DB allow/deny and screenshot rules), `skills/pipeline-setup/SKILL.md` (ship → review), `README.md`, `docs/cli.md` (every "skills/ship" reference, incl. owner-go and triage usage strings in `pipeline/commands/*.mjs` and comments in `pipeline/lib/*.mjs` — NOT `pipeline/hooks/**` comments, frozen; Task 5 already updated the hook comments it touched).
- Test: create `test/skills.test.mjs`.

**Skill content (the decisions; wording is the implementer's):** frontmatter `name: review`, description triggers on build/fix/change requests in a repo with `.claude/pipeline.yml` (same trigger set as ship's description minus inbox/resume/merge/prod). Steps: (1) branch + worktree from origin/main; (2) build via the `implementer` agent (Sonnet), failing test first for bugs; (3) quick check (`verify.quick`) on the changed area — never the full verify locally; (4) draft PR, body opens `## In plain English`; (5) `P risk`; (6) `P codex-review` round 1; (7) low → `judge` (Sonnet) + `P triage`; medium/high or `risk.high_risk_paths` / `review.arbiter_always_paths` → `P arbiter` + the `arbiter` agent (Fable) review round; (7b) publish the triage / owner rulings the way the ship loop does today; (8) fixes via implementer, then `P state mark-implemented` for each fixed ACCEPT item (review-complete refuses outstanding accepts from ANY round: `pipeline/lib/triage.mjs` ~L377, `pipeline/commands/review-complete.mjs` ~L46); (9) Codex fix check + the round's outcome evaluation, capped at `review.max_rounds` + the confirm round (`round-cap`); (10) book every agent call with `P cost --from-transcript`; (11) `P review-complete` posts the marker comment; (12) mark ready only after that comment exists; (13) STOP: give the owner the `Head <sha12> · items <digest> · repo <owner/name>` + `🔀 Ready to merge #N — say "merge"` lines (and re-show them if a compaction happened since); the owner merges (`P merge --owner-go` or the repo's own merge command). Owner rulings: end the reply with the line `P triage ruling-request` returns (Task 5). No deploy, smoke, prod-watch, inbox, resume or notify steps. Every `P <cmd>` used must exist; flags copied from each command's `meta.usage`. Source of truth for the kept loop mechanics: `skills/ship/reference/review-loop.md` (read it before deleting; keep every state transition review-complete depends on, drop only the ship-only steps).

- [ ] Step 1: Write `test/skills.test.mjs`: (a) every `P <name>` / `pipeline <name>` in `skills/**/*.md` is a file in `pipeline/commands/`; (b) no skill mentions `prod-watch`, `P deploy`, `P inbox`, `P resume`, `P notify`, `skills/ship`; (c) `skills/review/SKILL.md` ≤ 160 lines and contains `review-complete`, `cost --from-transcript`, `Ready to merge`, `mark-implemented`, `ruling-request`, `owner-ruling`; (d) installer `SKILLS` equals the directory list under `skills/`. Plus an acceptance scenario in the existing CLI test style (temp repo + fake gh, as the review-complete / triage tests already do): round 1 Codex item ACCEPTed → fixed → `state mark-implemented` → clean round 2 → `review-complete` succeeds; and one with an owner ruling via `ruling-request` → recorded answer → `owner-ruling` → `review-complete` succeeds. The scenario runs the commands in the order the skill lists them. Run → FAIL.
- [ ] Step 2: Write the skill, delete ship, update verify / pipeline-setup / docs / usage strings.
- [ ] Step 3: Run `skills`, `docs-facts`, `install`, `templates` → PASS. Commit `feat!: replace the ship skill with a short review skill`.

### Task 7: #112 tests and the asHead precondition

**Files:**
- Modify: `pipeline/lib/git.mjs` (~L476–480 `treeFingerprint(o, { asHead })`; the final gate calls it at `pipeline/lib/finalgate.mjs` ~L453).
- Test: `test/guard-provenance.test.mjs` (or the file covering `ci-guards-run` review evaluation), `test/smoke*.test.mjs`, `test/git.test.mjs`.

- [ ] Step 1: Review evaluation + v2 artifact tests (`pipeline/templates/scripts/pipeline/ci-guards-run.mjs` review evaluation, `pipeline/lib/guard-provenance.mjs`): allowed vs other authors; an edited review-complete comment; malformed JSON; content-hash mismatch; a v1 verdict artifact rejected for the review check but still valid for the two older guards. Behaviour must already hold — if a test fails, it is a bug: report it, fix test-first.
- [ ] Step 2: Smoke bypass header tests (`pipeline/templates/scripts/pipeline/smoke.mjs` ~L57): header sent only to the exact allowed origin; denied origin, loopback, a redirect to another origin, invalid paths get no header; the secret never appears in any error/output.
- [ ] Step 3: asHead: failing tests — `treeFingerprint(o, { asHead: X })` throws when X's tree ≠ HEAD's tree, and when X is not a valid commit; for an equal-tree commit it returns the fingerprint with X's sha as prefix. Implement the check (`git rev-parse X^{tree}` vs `HEAD^{tree}`). The existing final-gate same-tree reuse tests stay green. Mutation-check.
- [ ] Step 4: Run each touched file → PASS. Commit `test: review evaluation, v2 artifact, smoke bypass header; enforce asHead same tree (#112)`.

### Task 8: Windows CI in 3 shards; flake #116

**Files:**
- Modify: `scripts/test.mjs` (`--shard I/N`), `.github/workflows/ci.yml`, `test/cli-review.test.mjs` (#116), `test/tested-tree.test.mjs` (~L156: it finds jobs by name and requires a tested-tree step in `test-windows`, which becomes the aggregate — keep the assertions for ubuntu and for EACH shard, including the shard-specific `JOB_NAME` and the installer step's condition; the aggregate has no tested-tree step and always evaluates its dependency result).
- Test: create `test/test-runner.test.mjs`, `test/ci-workflow.test.mjs`.

**Interfaces:**
- Produces: `node scripts/test.mjs --shard I/N [names…]`: sorted file list, assigned by longest-first greedy on file size in bytes (stable tie-break by name) to N bins, runs bin I. `I/N` invalid (non-integer, I<1, I>N, N>8) → stderr message, exit 2. A pure exported `shardFiles(files: {name,size}[], i, n): string[]` in `scripts/lib/shard.mjs` holds the logic (the runner stays thin).

- [ ] Step 1: `test/test-runner.test.mjs`: for N in 1..4 the bins are disjoint, cover every file, are identical across two calls, and no bin is empty when files ≥ N; invalid specs exit 2. Run → FAIL. Implement → PASS.
- [ ] Step 2: ci.yml: job `test-windows-shard` (matrix `shard: [1, 2, 3]`, `fail-fast: false`, name `test (windows ${{ matrix.shard }}/3)`, Node 24, `node scripts/test.mjs --shard ${{ matrix.shard }}/3`; the installer round trip runs in shard 3 only; tested-tree step keeps working with `JOB_NAME` = the shard's name). Aggregate job `test-windows`, name `test (windows)`, `needs: test-windows-shard`, `if: always()`, ubuntu runner, one step that exits 1 unless `needs.test-windows-shard.result == 'success'`. Ubuntu job unchanged (Node 20 + 24). Update the header comment (required names) and the old "~30-36 min" comment.
- [ ] Step 3: `test/ci-workflow.test.mjs` (text/regex over ci.yml, no YAML lib needed unless `pipeline/vendor/js-yaml.mjs` is easy to import — prefer it): every name in `.claude/pipeline.yml` `ci.required_checks` is a job `name:`; the `test (windows)` job needs the shard job, has `if: always()` and its step tests `result == 'success'`; the shard job has `fail-fast: false`. Run → PASS.
- [ ] Step 4 (#116): in the codex-review timeout test, on `win32` replace the `process.kill(pid, 0)` ESRCH assertion with a poll (≤ 10 s) and, if the PID still answers, accept it only when the late-write assertion that follows holds (the observable effect); other platforms keep the strict ESRCH check. Run `node scripts/test.mjs cli-review` → PASS.
- [ ] Step 5: Commit `ci: shard Windows into 3 jobs behind an aggregate test (windows) check; fix Windows PID flake (#116)`.

---

## Final verification (main session, not an implementer)

1. `node scripts/test.mjs no-dangling-imports skills docs-facts install vendor` → PASS.
2. EW compatibility without editing EW: in the scratchpad, `git init` a temp repo, copy EW foundation's `.claude/pipeline.yml` into it (never `.env.local`), run `node pipeline/bin/pipeline.mjs vendor --repo <tmp>` then `node pipeline/bin/pipeline.mjs config --repo <tmp>` → config valid; `node --check` every vendored `scripts/pipeline/**/*.mjs`; run `node scripts/test.mjs vendor` (its vendored-module loading tests).
3. Push, open the DRAFT PR; CI (ubuntu + 3 Windows shards + aggregate) is the full proof. Note the Windows wall time.
4. Codex (spec command, diff in the scratchpad) + one recheck; Fable attacker subagent (spec brief). Fix what they prove.
5. PR body: `## In plain English`, what changed, the verify-step → CI-check map (below), checks, Codex/Fable findings, risk. Mark ready only per the owner; STOP for the owner's "merge".

**Verify step → required CI check (EW, for the PR body):** install/typecheck/lint/unit → `Typecheck + Vitest` (required); build → `Vercel` (required); hard stops / test integrity → `Hard-stop scan`, `Test integrity` (required); db, db-grants → `Replay from zero` (NOT required); sql-arms → `SQL arms` (NOT required); e2e → `Playwright suite` (label-gated, NOT required; Phase 5 adds `ready_for_review`). The three NOT-required ones are the gap to close in Phase 5's protection step.
