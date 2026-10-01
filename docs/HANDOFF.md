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
