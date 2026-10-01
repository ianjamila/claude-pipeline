# Audit checklist (read-only)

| Area | Look at | Record |
|---|---|---|
| Stack | package.json / pyproject / go.mod / Cargo.toml / Gemfile | languages, frameworks, versions |
| Package manager | lockfiles, `packageManager`, `.nvmrc`, CI setup steps | install command (`npm ci`, `pnpm i --frozen-lockfile`, `uv sync`…) |
| Tests | test configs, test dirs, CI test steps | unit runner + command, E2E runner, DB tests, coverage thresholds |
| Lint/typecheck | eslint/biome/ruff/mypy/tsc configs, custom guard scripts | commands; which run in CI |
| CI | `.github/workflows/*` | per workflow: triggers, path filters, job names (= check names), secrets, durations, draft handling |
| Merge flow | merge scripts, pre-push hooks, docs (README/CONTRIBUTING/CLAUDE.md) | existing gate + its flags; whether docs go straight to main |
| Database | `supabase/`, `prisma/`, `migrations/`, `alembic/` | migration dir, local reset command, how migrations reach prod (on merge? manual?) |
| Hosting | `vercel.json`, `netlify.toml`, `fly.toml`, Dockerfiles, deployments API | preview URL source, production URL, rollback method |
| Protection | `gh api …/protection`, `…/rulesets`, repo settings | current state, plan limits, token admin rights |
| Claude config | `CLAUDE.md`, `AGENTS.md`, `.claude/` | rules to keep, structure checkers |
| Sensitive areas | grep paths/identifiers: auth, role, rbac, policy, rls, grant, admin, service_role, secret, payroll, salary, health, patient, medical, biometric, face | hard-stop candidates; ask the owner only about ambiguous ones |
| Data | seed scripts, fixtures, `.env*` | synthetic? any real data or prod URLs that must never be used |
| Cost | CI README notes, run durations (`gh run list`) | Actions minutes constraints → lean CI vs full verify in CI |
