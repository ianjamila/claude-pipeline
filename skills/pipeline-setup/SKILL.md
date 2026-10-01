---
name: pipeline-setup
description: Use when the user says "set up the pipeline", "onboard this repo", "add the agent pipeline", "make this repo shippable by agents", or when ship/verify finds no .claude/pipeline.yml. Audits the repo read-only, then creates everything the global ship/verify pipeline needs — .claude/pipeline.yml, scripts/verify with --quick and a JSON report, missing test tooling (Vitest, Playwright, pgTAP for Supabase), tamper-proof CI guard checks (test integrity + hard-stop scan), CODEOWNERS, a Stop hook running quick verify, a permission allowlist, CLAUDE.md rules, labels — and branch protection via gh api.
when_to_use: Onboarding any git repo (any stack) to the autonomous pipeline, re-running setup after the stack changed, or repairing drift reported by `pipeline vendor --check` / `pipeline preflight`.
---

# pipeline-setup — onboard a repo to the pipeline

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. Templates live in
`~/.claude/pipeline/templates/`. The onboarding PR touches pipeline files, so it is a hard-stop
by definition: it ends `needs-human` and the owner merges it. Never push to `main`.

## a. Audit (read-only — change nothing yet)

Work through `reference/audit-checklist.md` and write the findings to
`.review/setup/audit.md` (gitignored scratch): stack, package manager + lockfile, Node/Python
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

- Copy `templates/scripts/verify` (POSIX shim) and `templates/scripts/verify.mjs`; fill its
  `STEPS` from `reference/stack-recipes.md`. Full mode must cover, where the stack has them:
  clean install → typecheck → lint/static guards → unit tests → database reset + all migrations
  + permission/policy tests → production build → Playwright E2E smoke (screenshots to
  `.verify/screenshots/`). `--quick` = typecheck + lint + tests related to changed files.
- Writes `.verify/report.json` (per step: status, duration, error excerpt; plus `mode`,
  `expectedSteps`, git head/tree/dirty). Fail fast.
- Add missing tooling: Vitest (JS/TS unit), Playwright (`e2e/smoke/*.spec.ts`, own config +
  port), pgTAP (`supabase/tests/*.test.sql`, run by `supabase test db`). Start each with at least
  one real test (pgTAP: one allowed-role and one denied-role check using `set local role` +
  `request.jwt.claims`).
- Database/E2E steps run against a dedicated local instance (own project id + port offset) under
  a machine-wide lock, and refuse any non-localhost URL. Synthetic seed data only — never real
  personal, client, health, biometric, financial, or payroll records.
- Run full verify until green in the worktree. That run is the evidence in the PR body.

### c. `.claude/pipeline.yml`

From `templates/pipeline.yml`: verify commands; `merge.command` (must contain `{pr}` and
`{sha}`; reuse an existing merge gate if the repo has one, with flags that refuse branch
updates and pin the head); `ci.required_checks`; preview (environment name in GitHub
deployments + smoke command); production (URL, provider, read-only smoke, rollback command +
notes); `smoke_checks` (GET-only, unauthenticated); `risk.high_risk_paths`; `hard_stops.paths` /
`patterns` / `auth_calls` (project extras on top of the universal list); review settings.
Validate: `P config`.

### d. CI + branch protection

- If the repo has no CI that runs verify-equivalent checks on PRs, add
  `templates/workflows/verify.yml`. If it already has CI (and minutes are a constraint), keep it
  and make sure the required checks always report: remove `paths:`/`paths-ignore:` trigger
  filters from required workflows and use a job-level docs-only skip instead (a workflow that
  never triggers never reports, which blocks every such PR).
- Branch protection is applied **after the onboarding PR merges**: `P protect --repo .` prints
  the exact `gh api` calls; `P protect --repo . --apply` (requires the session to have been
  started with `PIPELINE_ADMIN=1`) applies them: PR required, required checks, enforce admins,
  linear history, no force pushes/deletions, auto-merge allowed, squash only. 403 ⇒ tell the
  owner what plan/permission is missing and print the command for them to run.

### e. Test-integrity + hard-stop checks

`P vendor --repo .` copies the guard scripts into `scripts/pipeline/`. Copy
`templates/workflows/pipeline-guards.yml` (runs on `pull_request_target` from the base branch,
never executes PR code, posts the `Test integrity` and `Hard-stop scan` commit statuses). If the
repo has a merge-gate registry of expected checks, register the workflow there as enforced by
branch protection.

### f. CODEOWNERS

`templates/CODEOWNERS` → `.github/CODEOWNERS`, one line per hard-stop path, owner = the repo
owner. (With a single GitHub identity this documents ownership; approval happens via the
`human-approved` label.)

### g. `.claude/settings.json`

Merge `templates/settings.json`: the Stop hook (`node scripts/pipeline/stop-verify.mjs`, timeout
900) and the permission allowlist for pipeline commands. Keep existing keys. Never add
`--dangerously-skip-permissions` or `bypassPermissions`.

### h. CLAUDE.md

Insert `templates/CLAUDE-block.md` (all work through `ship` unless the user opts out; never push
to main; never claim done without verify evidence; agents never apply migrations or touch
production data; hard-stop PRs wait for the owner's `human-approved`). Respect any structure
checker the repo has for CLAUDE.md.

### Also

- `.gitignore`: `.verify/`, `.review/`. Create `docs/agent-log.md` from the template.
- `P labels ensure`.
- Commit in logical steps, push `agent/pipeline-setup`, open the PR with the audit summary,
  verify evidence, and the protection command; label `needs-human`; `P comment --pr N --kind
  needs-human`. Tell the owner: review, add `human-approved`, merge; then ask Claude to "apply
  pipeline branch protection" (needs a session started with `PIPELINE_ADMIN=1`).
- After protection is applied: `P preflight` must report `enforcement.mode: "github"`.
