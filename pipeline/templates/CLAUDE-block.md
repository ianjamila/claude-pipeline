<!-- claude-pipeline:start -->
## Agent pipeline (global `ship` / `verify` skills)

- **All code changes go through `ship`** (branch → tests → full verify → PR → Codex review loop
  → final gate → merge → production smoke), unless the user opts out for the session
  (`PIPELINE_OFF=1 claude`, or says "don't use the pipeline").
- **Never push to `main`** and never force-push. Merges happen only through the pipeline's merge
  step after its final gate, or by the owner.
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
