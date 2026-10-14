# Stack recipes for scripts/verify

Each recipe lists `STEPS` for `scripts/verify.mjs` (`quick: true` marks steps that also run in
`--quick`). Commands run from the repo root; a failing step stops the run.

## Next.js / Node + Supabase + Vercel (EagleWatch, DRMed shape)

| name | command | quick |
|---|---|---|
| install | `npm ci` (or the lockfile's manager) | no |
| typecheck | `npx tsc --noEmit --incremental --tsBuildInfoFile .verify/tsbuildinfo` | yes |
| lint | the repo's lint/static-guard scripts (the same list CI runs; add a test asserting verify ⊇ CI list) | yes (fast subset) |
| unit | `npx vitest run` | no |
| unit-related | `npx vitest related <changed files> --run` (skip when no changed source) | yes (quick only) |
| db | `node scripts/pipeline/supabase-local.mjs reset-and-test --project <id>` (vendored template: temp `.verify/supabase-workdir` copy, project id `<id>-pipeline`, own port offset) under the `db` lock: start if needed → `supabase db reset` → `supabase test db`; pgTAP starter: `templates/pgtap/rls_example.test.sql` | no |
| build | `npm run build` with the dedicated instance's env (`supabase-local.mjs env --project <id>`; the `verify.mjs` template's `supabaseEnv()` does this) | no |
| e2e | `npx playwright test -c playwright.smoke.config.ts --project=smoke` (templates `e2e/playwright.smoke.config.ts` + `e2e/smoke.spec.ts`; its port comes from `PIPELINE_SMOKE_PORT`, which `supabase-local env` prints; screenshots to `.verify/screenshots/`) | no |

Set `verify.expected_steps` in `pipeline.yml` to these step names, in order (only the steps the repo really has). A slow step
may carry a `skipIf` in `verify.mjs` (full mode only; it must fail closed); list it in `verify.skippable_steps` or final-gate refuses
the skipped report.

Preview: GitHub deployments environment `Preview`; production: provider `vercel`. On a failed production
smoke `pipeline prod-watch` itself runs the Vercel CLI (`vercel rollback <known-good> --yes --timeout 3m`, where
`<known-good>` is the deployment production served before the merge); it never executes
`production.rollback.command`. That key is still required by validation: write the equivalent manual command
(`vercel rollback <known-good> --yes`) as documentation for humans. After a rollback Vercel stops auto-assigning
production domains until a deployment is promoted.

## Plain Node / TypeScript library

install → typecheck → lint → `npm test` → `npm run build` (if present). No preview/production.

## Python

install (`uv sync --frozen` / `pip install -r requirements.txt`) → `ruff check` → `mypy` (if
configured) → `pytest -q` → build (`python -m build`, if packaging). DB: `alembic upgrade head`
against a throwaway local database + permission tests.

## Generic / unknown

Ask the owner for the commands that prove the app works; wrap them as steps; mark the stack as
"custom" in pipeline.yml comments.
