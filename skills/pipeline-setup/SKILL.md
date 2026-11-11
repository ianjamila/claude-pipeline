---
name: pipeline-setup
description: Use when the user says "set up the pipeline", "onboard this repo", "add the agent pipeline", "make this repo shippable by agents", or when review/verify finds no .claude/pipeline.yml. Audits the repo read-only, then creates everything the global review/verify pipeline needs — .claude/pipeline.yml, scripts/verify with --quick and a JSON report, missing test tooling (Vitest, Playwright, pgTAP for Supabase), tamper-proof CI guard checks (test integrity + hard-stop scan), CODEOWNERS, a permission allowlist, CLAUDE.md rules, labels — and branch protection via gh api.
when_to_use: Onboarding any git repo (any stack) to the autonomous pipeline, re-running setup after the stack changed, or repairing drift reported by `pipeline vendor --check` / `pipeline preflight`.
---

# pipeline-setup — onboard a repo to the pipeline

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. Templates live in
`~/.claude/pipeline/templates/`. The onboarding PR touches pipeline files, so it is a hard-stop
by definition: it ends `needs-human` and the owner merges it. Never push to `main`.

## a. Audit (changes nothing in the repo yet)

Work through `reference/audit-checklist.md` and write the findings to
`.review/setup/audit.md` — the audit's only write, a scratch file under `.review/` (the
`.gitignore` step below makes it ignored, so it never lands in a commit): stack, package manager + lockfile, Node/Python
versions, test frameworks and where tests live, lint/typecheck, existing CI workflows (job names,
triggers, path filters, secrets, cost notes), any existing merge gate or pre-push hooks,
database + migrations (and how migrations reach production), hosting + preview deploys +
production URL + rollback options, branch protection (`gh api
repos/{o}/{r}/branches/<default>/protection` — 403 "Upgrade to GitHub Pro" means the plan can't
protect private repos), existing `CLAUDE.md` / `AGENTS.md` / `.claude/`, sensitive areas
(auth, roles, RLS, payroll, health, biometrics, secrets, prod-writing scripts).
Delegate wide reads to an Explore subagent (model sonnet) and keep only its summary.

Then show the owner a short proposal: verify steps, CI changes, hard-stop list, merge command,
smoke + rollback plan. Ask ONLY about hard-stops you cannot infer (e.g. "is `lib/billing/`
customer financial data?"). Everything else: decide using the stack recipe.

## Build (in a worktree)

```
git fetch origin <default>
git worktree add <worktree_dir>/pipeline-setup -b agent/pipeline-setup origin/<default>
```
Use implementer subagents for the file work; give each the exact template path + values.

### b. `scripts/verify`

- Copy `templates/scripts/verify` (POSIX shim) and `templates/scripts/verify.mjs` with `cp` (never
  re-write the shim from text: it must stay **executable**; check `git ls-files -s scripts/verify`
  shows mode `100755`, else `chmod +x scripts/verify && git update-index --chmod=+x scripts/verify`).
  Fill the `STEPS` of `verify.mjs` from `reference/stack-recipes.md`. Full mode must cover, where the stack has them:
  clean install → typecheck → lint/static guards → unit tests → database reset + all migrations
  + permission/policy tests → production build → Playwright E2E smoke (screenshots to
  `.verify/screenshots/`). `--quick` = typecheck + lint + tests related to changed files.
- Writes `.verify/report.json` (per step: status `pass|fail|not-run|skipped`, duration, error excerpt, `skipReason` when skipped; plus `mode`,
  `expectedSteps`, git head/tree/dirty). Fail fast.
- Add missing tooling: Vitest (JS/TS unit), Playwright (`e2e/smoke/*.spec.ts`, own config +
  port), pgTAP (`supabase/tests/*.test.sql`, run by `supabase test db`). Start each with at least
  one real test (pgTAP: one allowed-role and one denied-role check using `set local role` +
  `request.jwt.claims`). Templates: `templates/e2e/playwright.smoke.config.ts` (reads
  `PIPELINE_SMOKE_PORT`) and `templates/e2e/smoke.spec.ts`; `templates/pgtap/rls_example.test.sql`;
  the dedicated Supabase stack is `scripts/pipeline/supabase-local.mjs` (vendored in step e;
  `supabase-local env --project <id>` prints the stack's URLs/keys and `PIPELINE_SMOKE_PORT`, which the
  e2e config and the smoke server share).
- Database/E2E steps run against a dedicated local instance (own project id + port offset) under
  a machine-wide lock, and refuse any non-localhost URL. Synthetic seed data only — never real
  personal, client, health, biometric, financial, or payroll records.
- Run full verify until green in the worktree. That run is the evidence in the PR body.

### c. `.claude/pipeline.yml`

From `templates/pipeline.yml`: verify commands and `verify.expected_steps` (the step names of
`STEPS` in order, so final-gate holds the report to YOUR list, not the one the report declares), and
`verify.skippable_steps` only if a step may be skipped by a `skipIf` in `verify.mjs` (the owner's list: final-gate refuses any other skipped step);
`merge.command` (must contain `{pr}` and
`{sha}`; reuse an existing merge gate if the repo has one, with flags that refuse branch
updates and pin the head); `ci.required_checks` (your CI job names; `Test integrity` and `Hard-stop scan` are required on top of
them unless you set `ci.guard_checks: false`, only for a repo that does not run `pipeline-guards.yml`) and
`ci.approvers` (GitHub logins whose approval labels count: REQUIRED when the repo is owned by an
organization, otherwise every approval fails closed with `org-repo-needs-ci.approvers`; ask the owner for
the logins); preview (environment name in GitHub
deployments + smoke command); production (URL, provider, read-only smoke, rollback command (documentation only: the pipeline no longer watches production
or rolls back) + notes; `watch: workflow` only when a CI workflow of the project
posts the production smoke result on the merged PR); `smoke_checks` (GET-only, unauthenticated); `risk.high_risk_paths`; `hard_stops.paths` /
`patterns` / `auth_calls` (project extras on top of the universal list); `hard_stops.disable_rules: [R6-sensitive]` only when
sensitive-data words are routine for the domain (an HR/payroll/medical app; nothing else can be switched off — ask the owner
first); `hard_stops.report_only_rules` / `report_only_paths` downgrade non-database rules to report-only (listed, never blocking, no
`human-approved` needed; allowed: `R1-data-write` (app `.from().delete/upsert`), `R2-auth`, `R2-auth-removed`, `R3-secrets`, `R4-config`
(CLAUDE.md / AGENTS.md, markdown under `.github`, local git hooks, a new plain package.json script), `R5-major-dep`, `R6-sensitive`,
`P-pattern`; database rules, raw destructive SQL and `R4-pipeline` (the guard core) always block) — ask the owner which; review settings.
Validate: `P config` (it prints `warnings`: read them, e.g. a missing guard context).

### d. CI + branch protection

- If the repo has no CI that runs verify-equivalent checks on PRs, add
  `templates/workflows/verify.yml`. If it already has CI (and minutes are a constraint), keep it
  and make sure the required checks always report: remove `paths:`/`paths-ignore:` trigger
  filters from required workflows and use a job-level docs-only skip instead (a workflow that
  never triggers never reports, which blocks every such PR).
- Branch protection is applied **after the onboarding PR merges**: `P protect --repo .` prints
  the exact `gh api` calls (required checks = `ci.required_checks` + the two guard contexts, each pinned to GitHub Actions;
  a check another app posts, such as `Vercel`, keeps its current app or takes `--pin Vercel=<app id>`); `P protect --repo . --apply` (requires the session to have been
  started with `PIPELINE_ADMIN=1`) applies them: PR required, required checks, enforce admins,
  linear history, no force pushes/deletions, auto-merge allowed, squash only. 403 ⇒ tell the
  owner what plan/permission is missing and print the command for them to run.

### e. Test-integrity + hard-stop checks

`P vendor --repo .` copies `ci-guard`, `ci-guards-run`, `queue-guards-run`, `smoke` and `supabase-local`
(plus `lib/`, `vendor/js-yaml.mjs` and a `VERSION` file) into `scripts/pipeline/` (and removes a `stop-verify.mjs` an earlier vendor left there), and appends
`scripts/pipeline/** -text` and `scripts/verify text eol=lf` to `.gitattributes` so a Windows checkout cannot
rewrite them (commit that file; `P vendor --repo . --check` reports drift and warns when the lines are
missing). The `VERSION` file holds the stamp of the pipeline that ran `vendor` (`<base>+<sha7>`, with
`.modified` / `.incomplete` / `.unverified` or `+unknown` when that cannot be proven), so run `vendor` from an
up-to-date, unedited install (`pipeline update` first); `--check` warns when the stamp proves nothing. Copy
`templates/workflows/pipeline-guards.yml` (runs on `pull_request_target` from the base branch,
never executes PR code, posts the `Test integrity` and `Hard-stop scan` commit statuses). If the
repo has a merge-gate registry of expected checks, register the workflow there as enforced by
branch protection.

A repo whose default branch uses GitHub's merge queue also copies `templates/workflows/queue-intake.yml` and
`templates/workflows/queue-guards.yml` (vendored `queue-guards-run.mjs` and `lib/queue-members.mjs` come with `P vendor`).
`Queue intake` runs on `merge_group`; `Queue guards` follows it with `workflow_run`, so GitHub runs the default branch's copy
only, and posts the guard statuses on the queue commit for the member PRs' exact queued heads. Register `Queue guards` like
`pipeline-guards.yml` and do not edit it from a PR.

Queue mode itself needs no setting: `P merge`, `P final-gate`, the dry run, `P update-branch` and `P merge-hold` ask GitHub live
whether the base branch has a merge queue, and with none they behave as before. In queue mode `P merge` enqueues the owner-approved head,
and `P queue-sweep` (LaunchAgent `com.claude-pipeline.queue-sweep`, every 10 min, written and removed by the installer) carries a queued PR to its end
when no session is watching. The repo's own queue settings, its `merge_group` triggers and its `Queue gate` check are the repo's workflow PR (EagleWatch's A2), not part of onboarding here.

A repo that turns the queue on AND has a custom `merge.command` (it runs the PR branch's own script) must first declare which commit made that script queue-aware: add the plain file `.claude/merge-queue-aware` to the BASE branch (first line that is not blank or a `#` comment = the full 40-hex sha of that commit). `P merge` reads it from the base branch through GitHub and refuses (`queue-branch-predates-switch`) any branch that does not contain the commit, or when the file is missing or unreadable. Order for the rollout: land the queue-aware script, add the file on the base branch, THEN install this pipeline version / switch the queue on. A repo on the default merge command needs no file.

**Before moving a repo into a GitHub organization** (lessons from EagleWatch's move, 2026-11-09; do these first):

1. Set `ci.approvers: [<owner login>]` in `.claude/pipeline.yml` and merge it while the repo is still user-owned. An org-owned repo with `approvers: []`
   trusts nobody (`org-repo-needs-ci.approvers`): `Cross-model review` fails, approval labels get no receipt, and the fix cannot merge afterwards (base config plus required checks).
2. Move CI runners off a third-party runner provider first (or install it on the org): the move cancels every running job.
3. Guard statuses posted before the move are refused ("the run belongs to a different repository"). Re-judge each ready PR with a FRESH guard run (add, then remove
   the `pipeline-recheck` label: a new `pull_request_target` run on current main). Never `gh run rerun`: a re-run reuses the old event's sha (old main config) and attempt 2 or later never counts.
4. Owner-go grants and merge records are keyed by repo name. After the move the owner records it in a plain terminal:
   `pipeline repo-move --from <old> --to <new> --at <move time UTC>`.
5. Vercel's Git link silently dies on a transfer (no deploys, no statuses): the owner disconnects and reconnects the repo in the Vercel dashboard right after.
   Also re-check secrets, variables, protection and labels, and re-show any in-flight merge request (its Head line names the repo).

### f. CODEOWNERS

`templates/CODEOWNERS` → `.github/CODEOWNERS`. Replace `{{OWNER}}` with the repo owner's handle
(`@login`) and the `{{HARD_STOP_LINES}}` line with one line per project hard-stop path (same owner). (With a single GitHub identity this documents ownership; approval happens via the
`human-approved` label.)

### g. `.claude/settings.json`

Merge `templates/settings.json`: the permission allowlist for the
commands the review skill runs (pipeline CLI, verify, `gh pr create|edit|ready|checks|update-branch`, `git push|pull|
fetch|add|commit|worktree`…; nothing that merges or edits protection). Keep existing keys. Never add
`--dangerously-skip-permissions` or `bypassPermissions`. If the repo's `.claude/settings.json` (or `settings.local.json`) still has a Stop hook
that runs `stop-verify` (an older onboarding), remove that entry: vendor deletes the script and warns, but never edits the settings.

### h. CLAUDE.md

Insert `templates/CLAUDE-block.md` (all work through `review` unless the user opts out; never push
to main; never claim done without verify evidence; agents never apply migrations or touch
production data; hard-stop PRs wait for the owner's `human-approved`). Respect any structure
checker the repo has for CLAUDE.md.

### Also

- `.gitignore`: `.verify/`, `.review/` and the worktree directory (`<worktree_dir>/`, default `.worktrees/`: it
  must be ignored or the agent worktrees show up as untracked files). Create `docs/agent-log.md` from the template.
- `P labels ensure`.
- Commit in logical steps, push `agent/pipeline-setup`, open the PR with the audit summary,
  verify evidence, and the protection command; label `needs-human`; `P comment --pr N --kind needs-human
  --reason "Onboarding PR: it adds pipeline files, a hard-stop by definition. Review, add human-approved, merge."`
  (`--reason` is required). Tell the owner: review, add `human-approved`, merge; then ask Claude to "apply
  pipeline branch protection" (needs a session started with `PIPELINE_ADMIN=1`).
- After protection is applied: `P preflight` must report `enforcement.mode: "github"`.
