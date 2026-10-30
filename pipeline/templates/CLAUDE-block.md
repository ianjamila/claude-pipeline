<!-- claude-pipeline:start -->
## Agent pipeline (global `review` / `verify` skills)

- **All code changes go through `review`** (branch → tests → quick check → PR → Codex review loop
  → owner merge), unless the user opts out for the session
  (`PIPELINE_OFF=1 claude`, or says "don't use the pipeline").
- **Never push to `main`** and never force-push. Merges happen only when the owner says "merge"
  (the pipeline's merge command), never by the agent.
- **Never claim something is done without `verify` evidence**: the verify report table, the new
  tests that cover the change, and screenshots for UI changes.
- **Agents never apply database migrations to production, never use production data, keys or
  URLs, and never run prod-writing scripts.** Migrations ship as files in a PR; the owner applies
  them after approval.
- **Hard-stop PRs** (migrations, auth/RLS/permissions, secrets/env, pipeline files, major
  dependency upgrades, sensitive personal data, and the project extras in
  `.claude/pipeline.yml`) end as `needs-human`. Only the owner adds `human-approved`.
- Synthetic test data only.
<!-- claude-pipeline:end -->
