# Handoff — claude-pipeline build (paused 2026-10-01)

Read with: spec `docs/specs/2026-10-01-claude-pipeline-design.md` (§17 Rev 2, §18 Rev 3 override
earlier text) and plan `docs/plans/2026-10-01-claude-pipeline-plan.md` (the "Revision 2 overrides"
section near the top overrides task text).

## Where things are

- Repo `~/Claude/claude-pipeline` (local only, NOT on GitHub yet). Working branch `build/initial`.
- One git worktree per task under `~/Claude/cp-wt/t<task>` on branch `task/<task>`; integration
  worktrees `~/Claude/cp-wt/int` (`int/cli`) and `~/Claude/cp-wt/int2` (`int/cli2`).
- Nothing installed into `~/.claude`, nothing touched in EagleWatch, no GitHub changes.

## Task status

DONE + reviewed + fixed (committed on their task branch):
0.2 proc/paths · 1.1 config · 1.2 glob · 1.3 diff · 1.4 git · 1.6 integrity · 1.7 transcript ·
1.8 codex · 1.9 triage/state/render · 1.10 jobs · 1.12 locks · 3.1 shell-parse · 3.2 guard-git ·
2.1 local commands · 2.2 GitHub commands · 1.11 CI scripts + vendor + ci-guards-run + verify
template + supabase-local · 2.4b prod-watch + artifacts · 4.1 installer (not yet re-reviewed).
Merged into `build/initial` so far: 0.2, 1.1, 1.2, 1.3, 1.4(pre-fix), 1.7, 1.8, 1.9, 1.12, CLI
dispatcher, repo.mjs, agents, skills, templates, pipeline-guards.yml. Everything else lives on its
task branch (later commits of 1.4/1.10/1.6/3.1/3.2 are NOT yet in build/initial).

INTERRUPTED (stopped mid-work; uncommitted changes left in the worktree — inspect with
`git -C ~/Claude/cp-wt/<t> status` / `diff`, finish, run tests, commit):
- t1.5 hard-stop fix round (5 files dirty) — review findings list in plan below.
- t3.3 guard-files fix round (3 dirty) — critical bypasses: ancestor dirs, redirect targets
  resolved vs cwd, code-built home paths, vars, MCP all-strings scan, fail-open on caps, FP trims.
- t2.3 review-loop commands (9 dirty, fresh build — spec in the dispatch prompt summary below).
- t2.4a final-gate/merge/smoke/summary/agent-log (14 dirty, fresh build).

## Status 2026-10-02, updated 2026-10-05 (supersedes the lists above and items 1–3 below)

- Steps 1–2 DONE. Integration branch `int/final` in `~/Claude/cp-wt/int3` (all task branches
  merged, stage C landed, suite green 2883). `a45ba1f` = repo CI + `.claude/pipeline.yml` +
  `scripts/verify.mjs` (+ `test/self-verify.test.mjs`) + README (plan Task 6.1).
- Step 3 DONE (2026-10-02): whole-repo review (Task 7.1) by 4 Sonnet reviewers, ~50 verified
  findings, all fixed in four batches (hooks, gate, runtime, skills/docs) + a test-only-fix gap in
  `state mark-implemented`; merged at `02c74b6`. Suite 3175 pass / 0 fail / 1 skipped; `node
  scripts/verify.mjs` full PASS. Installer round trip now refuses inside a Claude session by design
  (ancestor-process check) — CI proves it.
- NEXT = step 4: owner OK, then `gh repo create ianjamila/claude-pipeline --private`, push
  int/final as main, watch CI (Windows proves .cmd quoting + installer). Fix CI on main directly
  only until protection is applied (plan 6.2).
- Step 4 IN PROGRESS (2026-10-02): repo created (private), int/final pushed as main. First CI run 36978331536 failed
  (ubuntu 1, windows 26). Direct-to-main CI fix #1 (plan 6.2 log):
  - product: stop-verify report freshness compares the report mtime before/after the run (Linux coarse mtime trailed
    Date.now()); git --show-toplevel is resolve()d in repoRoot/stop-verify/supabase-local (C:/ slashes on Windows);
    runShell/runShellAsync map cmd.exe "is not recognized" (exit 1) to 127 so triage never reads a missing runner as a
    failing test.
  - tests: realpathSync.native (RUNNER~1 short names), core.longpaths in tmprepo, empty gitconfig file instead of
    os.devNull, quoted Windows paths in guard-git commands, resolve() for POSIX-literal paths, platform-pinned
    splitCommand escapes, CRLF-normalised jq, backslash-free node -e snippet, probe built per root, cmd.exe-safe
    FAKE_CODEX_DURING_OUTPUT. Windows job timeout 45 -> 60 min (Node 20 suite alone ~36 min).
- Step 4 DONE: private repo `ianjamila/claude-pipeline`, main = `8edf5e5` (CI fix #1). CI run 36983134480
  green on `test (ubuntu)` + `test (windows)`. After a PC crash the int3 worktree was re-verified clean at
  `8edf5e5` on 2026-10-05. Branch protection not applied yet (needs GitHub Pro, step 7) — until then fixes may
  still go to main directly (plan 6.2).
- NEXT = step 5 (plan Task 7.2), owner terminal only (the installer refuses inside a Claude session):
  `PIPELINE_ADMIN=1 node ~/Claude/claude-pipeline/install.mjs --skip-file-guard`; check the report (skills /
  agents / pipeline installed, guard-git present, allowlist entry, `CLAUDE_CODE_SUBAGENT_MODEL` reported).
  Then the headless smoke (`claude -p --model haiku` lists implementer/verifier/judge/arbiter +
  ship/verify/pipeline-setup) and the guard-git live check (`git push origin main --dry-run` in a tmp repo is
  denied by the hook).

## Remaining work (in order)

1. Finish the 4 interrupted tasks (Sonnet implementers; verify dirty work first).
2. Integration: merge every `task/*` into `build/initial`, resolve conflicts (expect
   `pipeline/lib/config.mjs` DEFAULTS test_globs from 1.6, `proc.mjs` signal field from 1.4,
   `guard-git.mjs` from 2.1/3.2), dedupe `currentContentHash` (2.3 review-context.mjs vs 2.4a
   finalgate.mjs), wire `job start --tag` (HEAD sha) and `waitJob expectRunId`; fix docs:
   ship skill `artifacts push --pr N --dir D` (not `--pr-branch`), installer matcher for
   guard-git = `Bash|PowerShell`, Vercel rollback uses the CLI directly. Full suite green.
3. Whole-repo Sonnet review (plan Task 7.1) + repo CI (`.github/workflows/ci.yml`, ubuntu +
   windows, `shell: bash`) + `.claude/pipeline.yml` (all paths hard-stop) + README.
4. `gh repo create ianjamila/claude-pipeline --private`, push, CI green (Windows proves the
   .cmd quoting / installer).
5. Install locally `PIPELINE_ADMIN=1 node install.mjs --skip-file-guard` (owner terminal).
6. Onboard EagleWatch with the pipeline-setup skill (plan Phase 8; merge-gate `--expect-head`,
   KNOWN_NON_GATES registration, checks.yml drop `paths:` filter, pgTAP, smoke specs, Stop hook).
   Owner merges the onboarding PR.
7. Owner upgrades GitHub to Pro → `pipeline protect --apply` (needs PIPELINE_ADMIN=1 session).
8. Proofs 1–7 (plan Phase 9), then Codex Astra-high + Fable-high post-build review (Phase 10),
   then install the file guard last (Phase 11), optional agent-build Action, final report.

## Owner decisions (binding)

GitHub Pro + enforce_admins ON; agents use the owner's account (no bot, no notifications);
local full verify + lean CI; keep CLAUDE_CODE_SUBAGENT_MODEL=sonnet (verified: pinned agent
models still win on 2.1.285); ship auto-triggers, opt-out `PIPELINE_OFF=1`; Hard-stop scan is a
REQUIRED check; light lane on; Codex outage → awaiting-review + "resume pipeline reviews";
hard-stop PRs still get the review loop, then needs-human. Sonnet for all subagents.

## Verified facts worth keeping

- Subagent transcripts: `~/.claude/projects/<cwd>/<session>/subagents/agent-<id>.jsonl` +
  `.meta.json`; assistant lines carry `message.model`, top-level `effort`/`perTurnEffort`;
  interactive (`entrypoint: cli`) final `stop_reason` is often `null`.
- Invalid model → `model_not_found`, transcript model `<synthetic>` (no silent fallback).
- Hook exec form (`command: "node", args: [...]`) works on 2.1.285; in `claude -p`, put the
  prompt BEFORE `--allowedTools` (variadic flag swallows it).
- `vercel inspect <prod-domain> --format json` → `{id, url, target, readyState, createdAt}`;
  `vercel rollback <url|id> --yes --timeout 3m`.
- Codex: `gpt-6-astra`; `codex exec --output-schema` works for the 3-bucket JSON.
- 63% of EagleWatch's last 80 merged PRs would be hard-stops (migrations, CI/config, payroll).
