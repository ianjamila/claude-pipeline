# Claude Pipeline — design spec

Date: 2026-10-01 · Status: approved design (user), pending plan review (Codex Astra high)

## 1. Purpose and success criteria

A global, stack-agnostic **build → verify → review → merge → deploy-check** pipeline for
Claude Code, so agents can ship features to production without the owner, and nothing
reaches `main` unless it has been proven to work.

Done means:

1. Global layer installed in `~/.claude` from the private repo `ianjamila/claude-pipeline`
   by an idempotent installer that works on macOS and Windows.
2. EagleWatch onboarded by the `pipeline-setup` skill (dogfood: the skill itself does it).
3. The seven proofs in §12 pass on EagleWatch through the real pipeline, with evidence.
4. Codex (gpt-6-astra, high) and Fable (high) have reviewed the built system; findings fixed.
5. The file-guard hook is installed last and proven to block.

## 2. Owner decisions (2026-10-01)

| Topic | Decision |
|---|---|
| GitHub plan | Upgrade to **GitHub Pro** → real branch protection on private repos. Pipeline auto-detects and falls back to "gate" mode if protection is unavailable. |
| Direct pushes | **enforce_admins ON** — nobody (owner included) pushes straight to `main`. |
| Agent identity | Agents use the **owner's GitHub account**; no bot account; **no notification workaround** (comments by the owner's account do not notify the owner — accepted). |
| CI scope | **Local full verify, lean CI.** Full `scripts/verify` runs locally; CI keeps existing checks + cheap new guard jobs; E2E in CI only for high-risk PRs. |
| `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` | **Keep.** Verified (§3) it does not override pinned agent models on 2.1.285. Installer reports it; pipeline proves real models from transcripts. |
| Plan review | Codex Astra-high review of the plan before building; Codex Astra-high + Fable-high review after building. |
| Trigger | **ship auto-triggers** in onboarded repos; per-session opt-out: launch `PIPELINE_OFF=1 claude` or say so (ship/verify stand down; project Stop hook skips). Branch protection and the global git guard stay on regardless. |
| Hard-stop scan | **Required check** (server-enforced): any sensitive PR needs the owner's `human-approved` label in every session, pipeline or not. |
| Light lane | **Yes**: low risk + < 50 changed lines + no hard-stop → Codex at medium, judge only if Codex returns ≥ 1 BLOCKING/SUGGESTION, no arbiter. |
| Codex outage | PR built + verified + opened, then `awaiting-review`, stop. Preflight warns up front. "resume pipeline reviews" sweeps all open `awaiting-review` PRs and continues from the review step. |

## 3. Verified platform facts (2026-10-01)

Claude Code **2.1.285**, codex-cli **0.154.0**, gh authed as `ianjamila` (scopes `repo, workflow, read:org, gist`).

- **Skills**: `~/.claude/skills/<name>/SKILL.md` (user), `.claude/skills/<name>/SKILL.md` (project).
  Frontmatter includes `name, description, when_to_use, argument-hint, disable-model-invocation,
  user-invocable, allowed-tools, model, effort, context, agent, hooks, paths`. `description +
  when_to_use` ≤ 1,536 chars.
- **Subagents**: `~/.claude/agents/*.md`, `.claude/agents/*.md`. Frontmatter includes `name,
  description, tools, disallowedTools, model, effort, permissionMode, maxTurns, skills, hooks,
  memory, isolation, color`. `model` accepts aliases (`sonnet|opus|haiku|fable`) and full IDs.
- **Model resolution — measured, not assumed** (headless run with `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`
  in env, agents defined via `--agents`):
  - agent `model: opus` → `claude-opus-5-5`; `model: fable` → `claude-fable-5-1`;
  - no `model` → `claude-sonnet-5-5` (env var applies only to unpinned agents);
  - per-invocation Agent `model: haiku` on the opus agent → `claude-haiku-4-5-20251001`
    (**per-invocation parameter beats frontmatter** → ship must never pass `model` for judge/arbiter);
  - invalid model → hard error `model_not_found` (HTTP 404); transcript assistant line has
    `message.model = "<synthetic>"`, `isApiErrorMessage: true`, `error`. No silent fallback.
  - `effort: high` in agent definition → every assistant line records `"effort":"high"`,
    `"perTurnEffort":"high"`.
- **Transcripts** (undocumented, unstable → consumers must fail closed):
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; subagents at
  `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl` plus
  `agent-<agentId>.meta.json` (`agentType`, `description`, optional `model` override).
  Assistant lines: `type:"assistant"`, `message.model`, top-level `effort`, `perTurnEffort`,
  `requestId`, `agentId`. The Agent tool result returns the `agentId`.
- **Hooks**: PreToolUse deny = JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny","permissionDecisionReason":"…"}}` (or exit 2). Stop block =
  `{"decision":"block","reason":"…"}`; input has `stop_hook_active`. User and project hooks
  **both run** (merged). PreToolUse fires for subagent tool calls (input adds `agent_id`,
  `agent_type`). Default command-hook timeout 600 s. On Windows, command hooks run under Git Bash
  (or PowerShell if absent); `shell` field selects; an exec form with `args` exists.
  `disableAllHooks: true` in any settings file disables hooks → must be guarded.
- **Codex**: `codex exec --sandbox read-only -C <dir> -o <file> --output-schema <schema.json>
  -c model="gpt-6-astra" -c model_reasoning_effort="<level>"`; `~/.codex/config.toml` default
  model is `gpt-6-astra`.
- **GitHub (Free, private)**: branch protection and rulesets return 403 → Pro required.
  `allow_auto_merge` is currently false.
- **Vercel**: GitHub deployments API carries both environments (`creator: vercel[bot]`):
  `GET repos/{o}/{r}/deployments?sha=<sha>&environment=Preview|Production` → statuses →
  `environment_url`. Vercel CLI installed and logged in; EagleWatch project linked
  (`prj_p7VQM8ePpbOgjwATYxoZrXi1zZV6`, team `team_f518tMAcPcomALubWOV0DfdV`).
- **Local tools**: Docker via OrbStack; Supabase CLI 2.118 (`~/.local/bin`); Node 24;
  no `pwsh` locally (Windows exercised in GitHub Actions `windows-latest`).

## 4. Architecture

```
            ┌────────────── GLOBAL (~/.claude, from ianjamila/claude-pipeline) ──────────────┐
 user ──►   │ skills: ship · verify · pipeline-setup      agents: implementer · verifier      │
 prompt     │ pipeline/bin/pipeline.mjs (deterministic)           judge (opus) · arbiter (fable)│
            │ hooks: guard-git · guard-files (PreToolUse, global)                               │
            └───────────────┬──────────────────────────────────────────────────────────────────┘
                            │ reads
            ┌───────────────▼──────────── PER-PROJECT (in each repo) ──────────────────────────┐
            │ .claude/pipeline.yml · scripts/verify(.mjs) · scripts/pipeline/* (vendored CI     │
            │ helpers) · CI workflows · CODEOWNERS · .claude/settings.json (Stop hook, allow)   │
            │ CLAUDE.md rules · docs/agent-log.md                                                │
            └───────────────┬──────────────────────────────────────────────────────────────────┘
                            │ enforced by
            ┌───────────────▼──────────── GITHUB (Pro) ────────────────────────────────────────┐
            │ branch protection: PR required, required checks, enforce admins, linear history, │
            │ no force push/deletion; auto-merge allowed                                         │
            └────────────────────────────────────────────────────────────────────────────────────┘
```

Principles:

- **Judgment in agents, decisions in code.** Hard-stops, risk level, arbiter-needed, model proof,
  exit conditions, and label transitions are computed by `pipeline.mjs`, not by a model.
- **Main session stays lean.** It keeps summaries and file paths; subagents and scripts write
  bulky artifacts to `.review/` and `.verify/` (both gitignored).
- **Fail closed.** Missing config, unreadable transcript, unknown CLI output, Codex unavailable →
  never merge.
- **Same identity caveat.** Agents and owner share one GitHub identity, so GitHub cannot tell an
  agent's label from the owner's. Approval labels are protected by the local hook only (§9, §13).

## 5. Global layer

### 5.1 Repo layout — `ianjamila/claude-pipeline` (private), clone at `~/Claude/claude-pipeline`

```
README.md                      install, update, uninstall, prompts, enforcement matrix
VERSION
install.mjs  install.sh  install.ps1
skills/
  pipeline-setup/SKILL.md      + reference/audit-checklist.md, reference/stack-recipes.md
  verify/SKILL.md
  ship/SKILL.md                + reference/review-loop.md, reference/pr-and-summary.md
agents/implementer.md verifier.md judge.md arbiter.md
pipeline/
  bin/pipeline.mjs             single CLI, subcommands below
  lib/*.mjs                    config, git, gh, risk, hardstops, codex, transcript, comments…
  hooks/guard-git.mjs  guard-files.mjs  lib/shell-parse.mjs
  schemas/codex-findings.schema.json  triage.schema.json  rulings.schema.json
  templates/                   files pipeline-setup copies into projects (see §6)
  vendor/js-yaml.mjs           pinned, MIT header kept
test/*.test.mjs                node:test, no deps
.github/workflows/ci.yml       node --test on ubuntu-latest + windows-latest (Node 20 and 24)
.claude/pipeline.yml           self-onboarded: every path is a hard-stop → never auto-merges
docs/specs/ docs/plans/
```

Zero runtime dependencies besides Node ≥ 20, git, gh. YAML parsed by the vendored js-yaml.

### 5.2 `pipeline.mjs` subcommands (contract)

All subcommands print one JSON object to stdout (human text to stderr), and use exit codes:
`0` ok · `1` check failed / blocked · `2` usage or environment error · `3` dependency unavailable
(Codex down/quota, deployment not found in time).

| Subcommand | Purpose |
|---|---|
| `config [--repo DIR]` | Load + validate `.claude/pipeline.yml` (schema §6.1); fill defaults; exit 2 if missing/invalid. |
| `preflight [--repo DIR]` | `{config, gh, enforcement:{mode, protected, missing[]}, pause:{open, issues[]}, rollbackOpen, codex:{available, reason}, clean}`. Enforcement = `github` only if live protection matches §6.6; else `gate`. Exit 1 if pipeline.yml missing, gh unauthed, or declared `github` mode but protection missing. |
| `labels ensure` | Create/align the pipeline labels (§7.4). |
| `risk --base REF --head REF` | `{level, reasons[], hardStops[{rule, file, line?, excerpt}], files[], stats}` from the universal rules (§8) + project extras. |
| `codex-review --pr N --round R --base SHA --head SHA --effort E [--model M]` | Runs Codex read-only with the findings schema; writes `.review/round-R/codex.json` + `codex.md`; exit 3 on unavailable/quota/auth. |
| `triage-validate --round R` | Validate `triage.json` (judge output) against schema and finding ids. |
| `arbiter-needed --round R` | Applies §7.3 rules → `{needed, items[]}`; writes `.review/round-R/arbiter-input.md` (finding, Codex reasoning, judge reasoning, ±20-line code excerpt, test results). |
| `model-proof --agent-id ID --expect-model claude-fable- --expect-effort high` | Finds the subagent transcript, checks every assistant line: model prefix, effort, no `isApiErrorMessage`/`error`/`<synthetic>`; meta has no `model` override unless expected. `{ok, transcript, models{}, efforts{}, errors[]}`; exit 1 on mismatch, 2 if not found/unparseable. |
| `rulings-apply --round R` | Merge arbiter rulings (only if model-proof ok) into state; mark needs-human per §7.3. |
| `state …` | Read/update `.review/state.json` (rounds, items, fingerprints, ruled cache, outcome). |
| `triage-comment --pr N` | Upsert the single PR comment marked `<!-- claude-pipeline:triage -->`. |
| `preview-url --sha SHA [--timeout S]` | Vercel/any provider using GitHub deployments (env from config) → `{url}`; or run `preview.url_command`. |
| `smoke --target preview\|production --url URL [--expect-text T]` | Runs the configured smoke command with `{url}` substituted. |
| `prod-watch --sha MERGE_SHA [--expect-text T]` | Wait for Production deployment success for the merge SHA → production smoke → on failure: `vercel rollback <known-good> --yes --timeout 3m` (run by prod-watch itself, not `production.rollback.command`), issue `pipeline-rollback` with evidence, revert PR (needs-human). |
| `summary --pr N --outcome merged\|blocked\|needs-human\|reverted\|awaiting-review` | Render §10 summary → upsert comment `<!-- claude-pipeline:summary -->`; print the agent-log line. |
| `agent-log --line "…"` | Commit the line to `docs/agent-log.md` via a docs-only branch + PR (§10.3). |
| `final-gate --pr N` | Assert: fresh full verify report bound to PR head SHA & tree, no blocking labels, no open pause/rollback issue, hard-stop recheck clean, review state exit-clean. Writes `.review/final-gate.json`. |
| `merge --pr N` | Requires a passing `final-gate.json` for the current head SHA; runs `merge.command`. The only sanctioned agent merge path. |

### 5.3 Skills

Descriptions are deliberately "pushy" and keyword-rich so they trigger reliably.

**ship** — triggers on any request to build, fix, add, change, implement, or ship a feature/bug
fix in a git repo. Flow in §7. Never merges without `pipeline.yml`; offers `pipeline-setup`.

**verify** — triggers on any code change and before declaring anything done/fixed/working.
Rules: run `verify.full` (or `verify.quick` while iterating), read `.verify/report.json`, fix,
rerun until green; UI change → Playwright screenshots of affected pages (`.verify/screenshots/`)
and actually look at them; DB change → a test proving the right roles are allowed and the wrong
ones denied (pgTAP for Supabase); bug fix → failing test first, then fix. Done = verify green AND
new behaviour covered by a new test. Always paste evidence (step table from the report, test
names, screenshot paths). Works without a pipeline.yml by discovering the stack's commands, but
then says it cannot certify.

**pipeline-setup** — triggers on "set up the pipeline", "onboard this repo", or `ship` finding no
`pipeline.yml`. Steps a–h from the brief, implemented as: read-only audit → proposal shown to
the user → files written on a branch `agent/pipeline-setup` → PR labelled `needs-human` (it
touches pipeline files by definition) → branch-protection command printed or applied once the
PR is merged. Asks the user only about hard-stops it cannot infer.

### 5.4 Subagents

| Agent | model | effort | tools | Role |
|---|---|---|---|---|
| implementer | sonnet | (inherit) | Read, Edit, Write, Grep, Glob, Bash | Code + tests, small commits, quick verify; returns summary + `git diff --stat`. No MCP tools (no prod DB). |
| verifier | sonnet | (inherit) | Bash, Read, Grep, Glob | Runs verify / smoke; returns per-step pass/fail + error excerpts only. |
| judge | opus | high | Read, Grep, Glob | Triage every Codex item → ACCEPT / FOLLOW-UP / REJECT + confidence; outputs JSON per schema. |
| arbiter | fable | high | Read, Grep, Glob | Rules on batched disputes; outputs JSON per schema. |

Ship invokes judge/arbiter **without** a `model` parameter. Proof switch for test 6 only
(`PIPELINE_ARBITER_MODEL_OVERRIDE`) passes an explicit model — documented as a test-only switch.

### 5.5 Global hooks (`~/.claude/settings.json`, PreToolUse)

**guard-git** (matcher `Bash|PowerShell|Monitor|mcp__.*`): deny when any simple command (after splitting on `; && || | &`,
newlines, `$(…)`, backticks, and recursing into `bash|sh|zsh -c`, `eval`) is:
- `git push` targeting `main`/`master` (explicit refspec dest incl. `HEAD:main`,
  `refs/heads/main`, `:main`, `--delete main`), or with no refspec while the checkout's current
  branch (cwd or `-C dir`) is `main`/`master`, or `--all`/`--mirror`;
- any force push: `-f`, `--force`, `--force-with-lease[=…]`, `--force-if-includes`, `+refspec`;
- `gh pr merge … --admin`;
- `gh api` non-GET to `…/branches/*/protection*`, `…/rulesets*`, or `PATCH repos/{o}/{r}`;
  `gh repo edit`;
- adding approval labels or removing guard labels: `human-approved`, `test-change-approved`
  (add); `needs-human`, `pipeline-blocked`, `awaiting-review`, `pipeline-pause`,
  `pipeline-rollback` (remove) via `gh pr|issue edit`, `gh api …/labels`;
- `gh issue close|delete` of an issue carrying `pipeline-pause`/`pipeline-rollback`
  (looked up with `gh issue view`, 5 s timeout; lookup failure → deny).
Internal error → deny only if the command mentions `push`, `merge`, `protection`, `ruleset`,
or a guarded label; otherwise allow.

**guard-files** (matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*`), bypassed only when the
Claude Code **process** env has `PIPELINE_ADMIN=1`:
- deny file tools whose resolved target (realpath of nearest existing ancestor, case-insensitive
  on macOS/Windows) is inside: `~/.claude/skills/{pipeline-setup,verify,ship}/`,
  `~/.claude/agents/{implementer,verifier,judge,arbiter}.md`, `~/.claude/pipeline/`,
  `~/.claude/settings.json`;
- deny any file-tool write whose content contains `disableAllHooks` into `**/.claude/settings*.json`;
- deny Bash commands that mention a protected path (`~/`, `$HOME`, `${HOME}`, absolute,
  `%USERPROFILE%`, `$env:USERPROFILE` forms) unless read-only (allowlisted first token and no
  `>`/`>>`/`tee`/`-i`), any Bash command containing `PIPELINE_ADMIN`, any Bash command running a
  claude-pipeline `install.(mjs|sh|ps1)`, and any file-tool write whose content contains
  `PIPELINE_ADMIN`.
- Installed **last** (after proofs and reviews). The installer itself refuses to run when
  `CLAUDECODE=1` unless `PIPELINE_ADMIN=1` is in its process env.

Limits stated plainly: these hooks stop accidents and casual circumvention, not a determined
adversary (e.g. encoded payloads). GitHub branch protection is the hard boundary for `main`.

### 5.6 Installer

`install.mjs` (wrappers `install.sh`, `install.ps1` just exec Node):
- copies `skills/{ship,verify,pipeline-setup}`, `agents/*.md`, `pipeline/` into `~/.claude`;
  refuses to overwrite a same-named skill/agent it did not install (manifest
  `~/.claude/pipeline/INSTALLED.json` with version, git SHA, file sha256s) unless `--force`;
- backs up `settings.json` to `~/.claude/backups/settings.json.<timestamp>`; merges hook
  entries idempotently (identifies its own entries by the `/.claude/pipeline/hooks/` path) and
  never touches other hooks; writes absolute paths; guard-files entry is written last and only
  when not `--skip-file-guard`;
- `--check` (dry run + drift report, exit 1 on drift), `--uninstall`, `--skip-file-guard`;
- reports `CLAUDE_CODE_SUBAGENT_MODEL` (settings env, process env, shell rc files) with the §3
  finding; reports Claude Code / codex / gh versions.
Repo CI runs the installer against a temp `HOME` on Ubuntu and Windows.

## 6. Project layer (what pipeline-setup creates)

### 6.1 `.claude/pipeline.yml` schema (version 1)

```yaml
version: 1
project: eaglewatch
default_branch: main
enforcement: github            # github | gate ; preflight verifies live protection
worktree_dir: .worktrees       # where ship creates agent/<name> worktrees
verify:
  full: node scripts/verify.mjs
  quick: node scripts/verify.mjs --quick
  report: .verify/report.json
  screenshots: .verify/screenshots
ci:
  required_checks: ["Typecheck + Vitest", "Static guards", "Test integrity", "Hard-stop scan", "Vercel"]
  e2e_label: run-e2e           # ship applies it for high-risk PRs before the final gate
  draft_while_iterating: true
merge:
  command: "npm run merge -- {pr}"   # default: gh pr merge {pr} --squash --auto --delete-branch
preview:
  provider: github-deployments
  environment: Preview
  smoke: "node scripts/pipeline/smoke.mjs --base {url}"
production:
  url: https://ewiapp.eaglewatch.ph
  environment: Production
  deploy_timeout_minutes: 20
  smoke: "node scripts/pipeline/smoke.mjs --base {url} --production"
  rollback:
    command: "vercel rollback --yes"
    notes: "After a rollback Vercel stops auto-assigning production domains; promote the fixed deployment (vercel promote) to resume."
risk:
  high_risk_paths: ["…"]
  medium_lines: 150
  high_lines: 600
hard_stops:
  paths: ["…"]                 # project extras, globs
  patterns: [{name: "…", regex: "…", paths: ["…"]}]   # content rules on added lines
review:
  codex_model: gpt-6-astra
  effort: {low: medium, medium: medium, high: high, followup: medium}
  max_rounds: 3
  exempt_docs_only: ["docs/agent-log.md"]
agent_log: docs/agent-log.md
```

### 6.2 `scripts/verify` (+ `scripts/verify.mjs`)

- `scripts/verify` is a POSIX shim (`exec node scripts/verify.mjs "$@"`); Windows runs
  `node scripts/verify.mjs`.
- Steps run in order, **fail fast** (first failure stops; rest `not-run`), each with its log in
  `.verify/logs/<step>.log`. Report `.verify/report.json`:
  `{version:1, mode, ok, startedAt, finishedAt, git:{head, base, mergeBase, dirty, treeHash},
  steps:[{name, status:pass|fail|not-run, durationMs, command, exitCode, errorExcerpt}]}`;
  excerpt ≤ 40 lines.
- Full mode (EagleWatch): `install` (`npm ci`), `typecheck`, `lint` (the static-guard scripts
  CI runs; a unit test asserts verify's list ⊇ `static-guards.yml`'s list), `unit`
  (`vitest run`), `db` (local Supabase start if needed → `supabase db reset` → `supabase test db`
  pgTAP), `build` (`npm run build`), `e2e` (Playwright `smoke` project; screenshots to
  `.verify/screenshots/`).
- `--quick`: `typecheck`, `lint`, `unit-related` (`vitest related <changed files> --run`).
- Synthetic seed data only; the db/e2e steps refuse non-local Supabase URLs.

### 6.3 CI (lean)

- New workflow `pipeline-guards.yml` (`pull_request`: opened, synchronize, reopened,
  ready_for_review, labeled, unlabeled; no path filter; no secrets; `contents: read`):
  - job **`Test integrity`**, job **`Hard-stop scan`**. Both check out the **base SHA** for the
    trusted scripts and `pipeline.yml`, then fetch the head SHA and diff `merge-base..head`.
  - No job-level `if` filtering on label events: a skipped run would supersede a failed one and
    count as passing for required checks. Jobs always fully re-evaluate.
- **Test integrity** fails a PR that: deletes a test file; adds `.skip(`, `.only(`, `xit(`,
  `xdescribe(`, `test.fixme(`, `describe.skip`, `it.todo` (and pgTAP `skip(`) in added lines;
  lowers a coverage threshold in a test config; or removes/edits assertion lines in existing tests
  without adding a new test case. Override: label `test-change-approved` (owner only — §9).
- **Hard-stop scan** fails when the diff hits a hard-stop (§8) unless label `human-approved`.
  Its summary lists the hits.
- `supabase test db` (pgTAP) added to the existing `Replay from zero` job.
- Existing checks stay; docs-only PRs short-circuit the 10-minute `Typecheck + Vitest` job via a
  `changes` job (`if:` on a genuinely docs-only diff vs the PR base — safe because there is
  nothing to check). `Static guards` loses its path filter so it always reports (≈1 min).
- New jobs registered in EagleWatch's `scripts/lib/expected-checks.mjs` so `lint:checks` and
  `npm run merge` know them.

### 6.4 CODEOWNERS

Entries for every hard-stop path → `@ianjamila`. With one identity this documents ownership; it
does not gate (owner cannot approve own PRs). Stated in README.

### 6.5 Project `.claude/settings.json`

- **Stop hook** `node scripts/pipeline/stop-verify.mjs`: `PIPELINE_OFF=1` → allow; no code changes vs merge-base and clean
  tree → allow; same tree fingerprint already passed → allow; else run `verify.quick`; failing →
  `{"decision":"block","reason":"quick verify failing: <step>: <excerpt>"}`. Loop cap: after 3
  consecutive blocks on an identical fingerprint it allows the stop with a loud
  `systemMessage` ("quick verify still failing — work is NOT done"), recorded in
  `.verify/stop-hook.json`.
- **permissions.allow** for pipeline commands (verify, `pipeline.mjs` subcommands, gh read/PR
  commands, codex exec read-only, supabase test db, playwright, git worktree). Never
  `--dangerously-skip-permissions`.

### 6.6 Branch protection (Pro; applied by pipeline-setup via `gh api`)

`PUT repos/{o}/{r}/branches/main/protection`:
`required_status_checks {strict:false, checks: ci.required_checks}`, `enforce_admins: true`,
`required_pull_request_reviews {required_approving_review_count: 0}` (PR required, solo-safe),
`required_linear_history: true`, `allow_force_pushes: false`, `allow_deletions: false`,
`restrictions: null`. Repo: `allow_auto_merge: true`, `allow_squash_merge: true`,
`allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`.
`strict:false` because EagleWatch's gate already enforces freshness (fewer CI reruns). If the
token lacks admin, print the exact command instead.

### 6.7 CLAUDE.md block

All work goes through `ship` unless the user opts out for the session (`PIPELINE_OFF=1` or says so); never push to `main`; never claim done without `verify` evidence;
agents never apply migrations to production; hard-stop PRs wait for the owner's
`human-approved` label. EagleWatch's `check-claude-md.mjs` structure rules must stay green.

### 6.8 `.gitignore`

`.verify/`, `.review/`.

## 7. ship flow

### 7.1 Steps

1. **Preflight** — `pipeline preflight`. `PIPELINE_OFF=1` in the env → ship stands down and
   says so. Codex unreachable → warn up front that the PR will wait in `awaiting-review`. No pipeline.yml → stop, offer `pipeline-setup`, never
   merge. Declared `github` enforcement but protection missing → may open PRs, never merge. Open
   `pipeline-pause` or `pipeline-rollback` issue → open PR, never merge.
2. **Branch** — `git fetch`; worktree `<worktree_dir>/agent-<slug>` on `agent/<slug>` from
   `origin/<default_branch>`. Initial risk estimate from the plan's expected paths (final risk is
   recomputed from the real diff before the PR and again at the final gate; higher wins).
3. **Build** — implementer subagents (sonnet) in small commits with tests (TDD for bug fixes);
   verifier subagent runs `verify.full` until green; max 3 fix cycles → draft PR labelled
   `pipeline-blocked` with the report table → summary (outcome blocked) → stop.
4. **PR** — `gh pr create` (draft while iterating if `ci.draft_while_iterating`). Body: what &
   why, verify summary (step table + head SHA), tests added, screenshots (UI changes; pushed to
   orphan branch `pipeline-artifacts` under `pr-<n>/` and embedded), risk level + reasons,
   hard-stops (if any). Hard-stop → label `needs-human`, one-paragraph summary comment, stop
   (no review loop spend unless the owner asks).
5. **Review loop** — §7.2.
6. **Final gate** — verifier runs a **fresh full verify** on the final head; `pipeline risk` +
   hard-stop recheck on the final diff; high risk → apply `ci.e2e_label`; mark ready; wait for
   CI green on the head SHA (project merge command does this for EagleWatch); preview URL for
   the head SHA → preview smoke; `pipeline final-gate`; then `pipeline merge`
   (`gh pr merge --squash --auto --delete-branch` by default; EagleWatch `npm run merge`).
7. **Production** — `pipeline prod-watch --sha <merge sha>`; on failure it rolls back, opens a
   `pipeline-rollback` issue with evidence, opens a revert PR labelled `needs-human`.
8. **Summary** — `pipeline summary` (comment) + `pipeline agent-log`.

### 7.2 Review loop (inside ship, after verify is green)

Round N:
1. **Codex** — `pipeline codex-review` on `base..head` (round 1: PR base; later rounds: last
   reviewed head). Effort from `review.effort[risk]` in round 1, `review.effort.followup` after.
   Output schema forces `{summary, blocking[], suggestions[], worth_considering[]}`; each finding
   `{title, file, line, category, detail, reasoning, testable}`. Saved to
   `.review/round-N/codex.{json,md}`. Unavailable/quota/auth (exit 3) → label `awaiting-review`,
   summary, stop. Never merge without the cross-model review. **Resume:** "resume pipeline
   reviews" (or `ship --resume <pr>`) lists open `awaiting-review` PRs, rebuilds review state from
   `.review/` (or from the PR's triage comment when the local state is gone), and continues each
   from this step.
   **Light lane:** if risk is low, changed lines < 50 and no hard-stop, round 1 uses `medium`, the
   judge runs only when Codex returns ≥ 1 BLOCKING or SUGGESTION item (WORTH CONSIDERING items are
   then filed as FOLLOW-UP or listed as rejected-by-default with reason "light lane"), and the
   arbiter is skipped unless a BLOCKING item is disputed.
2. **Judge** (opus) — triages every item → ACCEPT / FOLLOW-UP / REJECT, `confidence`
   high|low, one-line reason, and for disputed bugs a `settle_test` plan. Output validated by
   `triage-validate`.
3. **Settle disputed bugs by test** — implementer writes the test the judge proposed; failing
   test ⇒ bug real ⇒ ACCEPT (test kept); passing ⇒ REJECT stands with evidence (test kept if it
   adds coverage). Recorded per item.
4. **Arbiter** (fable, high) — only when `arbiter-needed` says so (§7.3); one batched call per
   round; then `model-proof`; then `rulings-apply`.
5. **Implement** ACCEPTED items (implementer; tests where behaviour changes) → verifier full
   verify. FOLLOW-UP → `gh issue create -l agent-suggestion` (link back to PR + item).
6. **Exit** when no open BLOCKING and no new ACCEPTED items. After round 3 still not clean →
   `needs-human` + unresolved summary. Triage comment updated every round.
A ruled item is not reopened unless its code changed (fingerprint = file + normalized title +
hash of the ±20-line excerpt).

### 7.3 Arbiter rules (computed)

Arbiter needed for an item (not settled by a test) when any:
- judge REJECTs or downgrades (to FOLLOW-UP) a Codex BLOCKING or SUGGESTION item;
- judge confidence is low;
- disputed bug that cannot be tested.
Ruling is final, except → `needs-human` when: ruling confidence low; ruling would dismiss
(REJECT/FOLLOW-UP) a BLOCKING item in category security / auth / permissions / data-integrity /
data-loss (a ruling to fix proceeds); or `model-proof` fails (fallback, reroute, unavailable,
quota, wrong effort, transcript missing/unparseable) — then **all** that round's rulings go to
`needs-human`.

### 7.4 Labels

`needs-human`, `awaiting-review`, `pipeline-blocked`, `pipeline-pause`, `pipeline-rollback`,
`agent-suggestion`, `agent-build`, `human-approved`, `test-change-approved`, `run-e2e` (exists).

### 7.5 Files

`.review/state.json`, `.review/round-N/{diff.patch, codex.json, codex.md, triage.json,
arbiter-input.md, rulings.json, model-proof.json}`, `.review/final-gate.json`,
`.verify/report.json`, `.verify/logs/`, `.verify/screenshots/`.

## 8. Hard-stops (universal, in `pipeline/lib/hardstops.mjs`, mirrored into each repo's
`scripts/pipeline/` for CI)

1. **Destructive data**: added SQL/migration lines with `DROP`, `TRUNCATE`, `ALTER … RENAME`,
   `DELETE FROM`, `UPDATE … SET` (data overwrite), `ALTER COLUMN … TYPE`; deleted migration files.
2. **Auth / roles / permissions / RLS / keys**: added lines with `CREATE|ALTER|DROP POLICY`,
   `ENABLE|DISABLE ROW LEVEL SECURITY`, `GRANT`, `REVOKE`, `SECURITY DEFINER`, `auth.uid()`
   logic in SQL, `service_role`, `SERVICE_ROLE`, `supabaseAdmin`; paths `**/auth/**`,
   `middleware.*`, `**/rbac/**`, `**/roles*`, `**/permissions*`.
3. **Env vars & secrets**: `.env*`, new `process.env.NAME` / `import.meta.env.NAME` names not
   present on base, `secrets.` refs in workflows, `vercel.json` `env`.
4. **Pipeline files**: `.github/**`, `.claude/**`, `.githooks/**`, `CODEOWNERS`,
   `scripts/verify*`, `scripts/pipeline/**`, test config (`vitest.config.*`, `jest.config.*`,
   `playwright.config.*`, `supabase/tests/**` deletions).
5. **Major dependency upgrades**: `package.json` semver-major bump (or `0.x` minor) of any dep.
6. **Sensitive personal data**: paths/identifiers matching biometric, face, liveness, health,
   medical, patient, payroll, salary, wage, payslip, bank, SSN/TIN/SSS/PhilHealth/Pag-IBIG.
Plus the project's `hard_stops.paths` / `patterns`. Classification errs toward needs-human.

Risk level: `high` if any hard-stop, any `risk.high_risk_paths` hit, or changed lines >
`high_lines`; `medium` if lines > `medium_lines` or > 10 files; else `low`.

## 9. Human approval of a hard-stop PR

Owner reviews → adds `human-approved` in the GitHub UI → `Hard-stop scan` re-runs and passes →
owner merges (UI or `! npm run merge -- <n>`). Agents are blocked locally from adding that
label and from removing `needs-human`.

## 10. Post-merge

### 10.1 Production watch
Wait (≤ `deploy_timeout_minutes`) for a Production deployment status `success` for the merge
SHA → production smoke (read-only, unauthenticated; never `smoke:hydration`) → pass ⇒ outcome
`merged`. Fail ⇒ `vercel rollback <known-good> --yes --timeout 3m` (run directly by prod-watch; `rollback.command` is documentation only) → issue `pipeline-rollback` (evidence: smoke output,
deployment URL, merge SHA, rollback output, the Vercel auto-assign note) → revert PR
(`git revert <merge sha>`) labelled `needs-human` → outcome `reverted`. While a
`pipeline-rollback` issue is open, ship never merges.

### 10.2 Summary comment (`<!-- claude-pipeline:summary -->`)
Order: **Outliers** (arbiter rulings: finding · Codex view · Opus view · Fable ruling · one-line
reason; close-call rejections; strong disagreements) → what was built (2–3 sentences) →
suggestions implemented (with round) → follow-up issues (links; promote by relabelling
`agent-suggestion` → `agent-build`) → rejected ideas (one-line reasons) → outcome.

### 10.3 Agent log
`docs/agent-log.md` cannot be pushed to `main` directly, so `pipeline agent-log` appends the
line on `agent/agent-log-<pr>` and opens a docs-only PR merged through the normal merge command.
It is exempt from the Codex review only when its diff touches nothing but `docs/agent-log.md`
and only adds lines. Line format:
`- 2026-10-01 · #123 · <title> · risk low · rounds 2 · arbiter 1 · merged → prod smoke ok`.

## 11. EagleWatch onboarding specifics

- **Merge command**: `npm run merge -- {pr}` (existing gate: obliged checks, head-SHA binding,
  freshness, squash). Gate extended to refuse PRs labelled `needs-human`, `awaiting-review`,
  `pipeline-blocked`.
- **Hard-stop extras** (inferred): `supabase/migrations/**`, `supabase/config.toml`,
  `scripts/sql-arms/**` (prod apply is manual); `middleware.ts`, `lib/supabase/**`,
  `lib/auth*`, `lib/roles.ts`, `lib/admin-rbac/**`, `lib/impersonation/**`,
  `lib/rate-limit/**`, `app/auth/**`, `app/api/public/**`, `app/api/webhooks/**`,
  `app/api/cron/**`, `app/dashboard/admin/settings/impersonation-actions.ts`; payroll
  (`lib/payroll/**`, `lib/sa-payroll/**`, `components/reports/sa-payroll/**`,
  `app/dashboard/reports/securityassistant/payroll/**`,
  `app/dashboard/reports/admin/sa-payroll/**`,
  `app/dashboard/admin/clients/payroll-periods/**`,
  `app/dashboard/admin/clients/batches/payroll-actions.ts`, `app/api/cron/sa-payroll-*`,
  `lib/dtr-actions.ts`, `lib/dtr-scope.ts`, `lib/dtr/**`, `lib/dmc/**`, `lib/soundoff/pair.ts`);
  biometrics (`lib/biometrics/**`, `app/dashboard/admin/manhour/biometrics/**`,
  `app/dashboard/admin/anomalies/biometrics-staleness/**`, `lib/manhour/biometrics-links.ts`,
  `lib/ias/**`); facial-recognition rule for any future `face|facial|liveness|rekognition`
  code; prod-writing scripts (`scripts/reseed_*`, `scripts/backfill_*`, `scripts/fix_*`,
  `scripts/import-*`, `scripts/storage-cleanup/**`, `scripts/sql/**`); `vercel.json`;
  merge-gate scripts; `next.config.ts`; `package.json` scripts.
- **pgTAP**: `supabase/tests/` with RLS tests on synthetic fixtures (owner/role allowed, other
  roles denied) for at least one guarded table; runs in verify and in `Replay from zero`.
- **E2E smoke**: new `e2e/smoke/*.spec.ts` (login page renders; seeded admin reaches the
  dashboard) + Playwright project `smoke`; uses the existing synthetic seed
  (`e2e/fixtures/seed-db.mjs`, refuses non-local URLs).
- **Preview/prod smoke** (`scripts/pipeline/smoke.mjs`): GET `/login` 200 + app marker (and
  `--expect-text`), GET `/` unauthenticated redirects to `/login`, static asset 200; no cookies,
  no POST, no auth.
- **Agents never apply migrations** (no MCP tools in implementer); CLAUDE.md migration
  instructions updated to "owner applies after approval".
- **Behaviour changes**: Claude sessions can no longer push docs straight to main (docs now go
  via PR, cheap thanks to the docs-only short-circuit); the Stop hook runs in every EagleWatch
  session once merged.

## 12. Proofs (EagleWatch, real pipeline)

| # | Scenario | Expected evidence |
|---|---|---|
| 1 | Harmless UI text tweak on the public `/login` page | PR auto-merged; Production deployment for merge SHA; prod smoke finds new text; summary + agent-log; then a revert through ship (second prod deploy). |
| 2 | Deliberately broken change (ship test switch `PIPELINE_TEST_COMMIT_AS_IS` commits the given patch and skips fix cycles) | verify fails → draft PR `pipeline-blocked`; never merged; CI red. |
| 3 | RLS policy change (migration altering a policy on a synthetic-fixture table) | Hard-stop scan red; PR `needs-human`; left open; nothing applied to prod. |
| 4 | Throwaway branch deleting a failing test | `Test integrity` red; merge refused. |
| 5 | Design trade-off Codex will flag | Judge disputes → arbiter called → `model-proof` shows `claude-fable-5-1`, effort high → ruling in summary Outliers. If the judge does not dispute naturally, say so and rerun with the disclosed test switch `PIPELINE_TEST_FORCE_ARBITER=1`. |
| 6 | Arbiter pointed at an invalid model (`PIPELINE_ARBITER_MODEL_OVERRIDE=claude-nonexistent-0`) | `model_not_found`; model-proof fails; item → `needs-human`. |
| 7 | Open `pipeline-pause` issue | ship opens the PR, does not merge; preflight shows paused. |

Afterwards: close all test PRs/issues, delete branches; proof 1's change reverted via ship.

## 13. Enforcement matrix

| Guarantee | GitHub (Pro) | CI | Global hook | Skill/CLI |
|---|---|---|---|---|
| No direct/force push to main | ✅ protection (enforce admins) | | ✅ guard-git | ✅ |
| Required checks green before merge | ✅ required checks | ✅ | | ✅ final-gate |
| Hard-stop needs owner | ✅ via required `Hard-stop scan` | ✅ | ✅ label guard | ✅ |
| Test weakening blocked | ✅ via required `Test integrity` | ✅ | ✅ label guard | |
| Linear history / squash | ✅ | | | ✅ |
| Fresh full verify bound to head | | | | ✅ final-gate |
| Cross-model review happened | | | | ✅ (no review ⇒ no merge) |
| Arbiter really Fable | | | | ✅ model-proof |
| Pause switch | | | ✅ cannot close pause issue | ✅ |
| Prod smoke + rollback | | | | ✅ prod-watch |
| Agents can't edit own rules | ✅ (protection edits need admin, blocked locally) | | ✅ guard-files / guard-git | |

The label-based approvals rely on the local hook because agent and owner share one identity.

## 14. Optional — `agent-build` GitHub Action (after proofs)

Workflow on `issues: labeled` (`agent-build`): checkout repo + `ianjamila/claude-pipeline`
(secret `PIPELINE_REPO_TOKEN`, fine-grained, read-only), run `install.mjs --skip-file-guard`
into the runner's `~/.claude`, run headless Claude (`CLAUDE_CODE_OAUTH_TOKEN`, already a repo
secret) with `/ship` on the issue. PRs must be created with a PAT (GITHUB_TOKEN-created PRs do not
trigger CI). Codex on the runner needs its own auth (`OPENAI_API_KEY`); if unavailable the PR gets
`awaiting-review` and the review completes on the next local run. Fable availability on the
runner verified by `model-proof`.

## 15. Out of scope / later

Bot identity (would add notifications + server-side human approval), plugin packaging,
Slack/push notifications, DRMed onboarding (prompt in README).

## 16. Amendments found while planning (2026-10-01)

1. **Tamper-proof guard jobs.** `pull_request` runs the workflow file from the PR, so a PR could
   rewrite `Test integrity` / `Hard-stop scan` to pass. `pipeline-guards.yml` therefore uses
   `pull_request_target` (workflow + scripts + `pipeline.yml` from the **base** branch; never
   checks out or executes PR code — it only fetches `refs/pull/N/head` and reads the diff), with
   `permissions: {contents: read, statuses: write, pull-requests: read}`, and posts **commit
   statuses** with contexts `Test integrity` and `Hard-stop scan` on the PR head SHA (statuses
   are bound to the head SHA regardless of which ref the run is attached to). Required checks
   reference those status contexts. Residual risk (adversarial only): a PR-defined workflow could
   post a fake status with the same context; documented. Workflow reviewed with the
   `gha-security-review` skill.
2. **Long-running commands.** Bash tool calls cap at 10 minutes, and subagents cannot rely on
   background notifications. `pipeline job start <name> -- <cmd>` runs a command detached
   (log, exit code, timestamps under `.review/jobs/<name>/`); `pipeline job wait <name>
   --timeout 540` blocks ≤ 9 min and returns `{state: running|done, exitCode, tail}`. Used for
   full verify, the merge gate (polls up to 30 min), and prod-watch.
3. **Test seam.** All `gh` calls go through `PIPELINE_GH` (default `gh`) so CLI tests run a fake gh.
4. **Hook command form.** Use the exec form (`command` + `args`) if Claude Code 2.1.285 honours
   it (verified in the plan before use); otherwise `node "<abs path>"`.
5. **Stop hook speed.** Quick verify uses incremental `tsc` (`--incremental`, build info in
   `.verify/`) and the fast pre-push guard set; hook `timeout: 900`.
6. **Vendoring.** `pipeline vendor --repo DIR` copies the CI-side libs (config, glob, diff,
   hardstops, integrity, yaml) into `<repo>/scripts/pipeline/` with a VERSION stamp; the
   project copy is what CI runs. `pipeline vendor --check` reports drift.
7. **Global allowlist.** The installer adds `Bash(node <abs>/.claude/pipeline/bin/pipeline.mjs:*)`
   to `~/.claude/settings.json` `permissions.allow`; project settings allow
   `Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)` as typed by the skills.

## 17. Revision 2 — after Codex Astra-high plan review (2026-10-01)

Codex verdict: "needs revision". All 13 findings accepted; resolutions below supersede earlier
sections where they conflict.

- **R1 Status contexts vs EagleWatch gate.** EagleWatch's `npm run merge` does not oblige the two
  status contexts; GitHub protection requires them. The gate already blocks on any failing check
  or status in `gh pr checks`, so a red `Hard-stop scan`/`Test integrity` still blocks it.
  `pipeline-guards.yml` is registered in `expected-checks.mjs` as excused ("enforced by branch
  protection via commit statuses") so `lint:checks` stays green.
- **R2 Immutable approved head.** `merge.command` gets `{sha}`. EagleWatch:
  `npm run merge -- {pr} --no-update --expect-head {sha}` (new `--expect-head` flag in
  `merge-gate.mjs`: refuse if the PR head ≠ sha). Generic: `gh pr merge {pr} --squash --auto
  --delete-branch --match-head-commit {sha}`. Stale base ⇒ ship updates the branch and re-runs the
  final gate (fresh verify, CI, preview smoke) — max 2 attempts, then `needs-human`.
  `pipeline merge` waits until the PR is MERGED; if auto-merge is still queued after the wait it
  runs `gh pr merge --disable-auto` and fails (no unattended queued merges).
- **R3 Evidence contract.** `final-gate.json` = `{repo, pr, base, head, tree, patchId, verify:{report
  sha256, steps, expectedSteps, finishedAt}, review:{patchId, head, clean}, preview:{sha, url, ok},
  checks[]}`. Verify report carries `expectedSteps` and `mode:'full'|'quick'|'partial'`; `--only`
  ⇒ `partial` ⇒ rejected. Review validity binds to the PR patch-id (`git diff merge-base..head
  -- . ':!<agent_log>' | git patch-id --stable`), so a base-only update keeps the review but
  never the verify/preview evidence. `merge` re-checks live blockers (labels, pause, rollback,
  head, patch-id) immediately before running the merge command. Negative tests for every mismatch.
- **R4 Status lifecycle.** The guard job: posts `pending` for both contexts on the event head SHA
  first; runs both checks capturing exit codes (no early exit); re-reads the PR's current head SHA
  and labels from the API; if the head moved, posts `error` ("superseded") on the old SHA and
  exits; otherwise posts `success`/`failure`; an `if: always()` step posts `error` for any context
  still pending (crash/cancel ⇒ fail closed). Checkout keeps credentials (no PR code ever runs;
  token is `contents: read`) so `git fetch origin refs/pull/N/head` works; the fetched SHA must
  equal the event head SHA.
- **R5 Approval bound to head.** On `synchronize`, the guard job removes `human-approved` and
  `test-change-approved` (needs `pull-requests: write`) before evaluating, so an approval only ever
  covers the head it was given on. Test: approve A → push B → label gone → red.
- **R6 Hooks cover pipeline entry points.** `job start … -- <cmd>` payloads are parsed and
  evaluated by both hooks, and `jobs.mjs` itself refuses commands the shared evaluator denies.
  `pipeline protect --apply` requires `PIPELINE_ADMIN=1` in its process env. guard-files denies any
  Bash command containing `disableAllHooks`. Residual (documented): with one GitHub identity an
  agent that writes its own API client can still add a label; label approval is protected against
  accidental and casual misuse only. A bot identity would close it (out of scope by owner choice).
- **R7 Removals and weakening.** New universal rules: `R2-auth-removed` (removed non-test lines
  matching `require\w*(Auth|Role|Admin|Scope|Permission|User|Session)\w*\(`,
  `assert\w*(Auth|Role|Permission)\w*\(`, `checkPermission\(`, `authorize\(`,
  `auth\.getUser\(`, `getUser\(`, `isAdmin\(`, `hasRole\(` plus project
  `hard_stops.auth_calls`); `R2-sql-removed` (removed SQL lines with POLICY/GRANT/REVOKE/RLS/
  SECURITY DEFINER); `R1-migration-edited` (any M/D/R of an existing file under a migrations
  dir). Path rules test both old and new paths on renames.
- **R8 Rollback ownership.** Before merging, record the current Production deployment (known
  good). On smoke failure: take the machine lock `prod-<project>`, read the current Production
  deployment; if it is not the failed one ⇒ outcome `superseded` (issue, no rollback); else
  `vercel rollback <known-good> --yes` (flags probed), wait, re-smoke ⇒ `recovered`
  (`reverted` outcome + revert PR) or `rollback-failed` (urgent `needs-human` issue).
- **R9 Agent log without extra PRs.** The ship PR itself gets one docs commit appending the line
  (outcome `merged — prod smoke pending`) right before the final gate's fresh verify. Lines for
  runs that don't merge, and post-deploy outcomes, go to a queue at
  `<git-common-dir>/claude-pipeline/agent-log-queue.jsonl` and are flushed into the next ship PR.
  No docs-only PR path is needed. `checks.yml` drops its `paths-ignore` (a required workflow that
  doesn't trigger never reports) and short-circuits docs-only diffs with a job-level skip.
- **R10 Windows.** `.cmd`/`.bat` shims launched via `cmd.exe /d /s /c` with proper quoting;
  timestamps `YYYYMMDDTHHMMSSZ`; CI steps use `shell: bash`; installer tested under a path with
  spaces.
- **R11 Outage resume.** `pipeline review-complete --pr N` removes `awaiting-review` only when
  state shows a clean review for the current patch-id; e2e test outage → resume → gate.
- **R12 Local DB isolation.** Verify's db/e2e steps run against a dedicated pipeline Supabase
  instance (temp workdir copy of `supabase/` with `project_id = "<id>-pipeline"` and a port
  offset) under a machine-wide lock `supabase-<project>` held for reset → pgTAP → e2e; the e2e
  smoke uses its own Playwright config/port and env pointing at that instance; verify refuses
  non-localhost Supabase URLs itself.
- **R13 Fable proof bound to the ruling.** ship embeds `INPUT-DIGEST: <sha256 of
  arbiter-input.md>` and `ROUND: N` in the arbiter prompt. `arbiter apply --agent-id ID --round
  N` locates the transcript, requires: every assistant line Fable + effort high + no error; the
  first user message contains the digest and round; the final assistant message has
  `stop_reason: end_turn`; the rulings JSON is **parsed from that final message** (no separate
  file); ids match the round's arbiter items.
- **P3s.** Tasks reordered so each passes on its own; installer tests use fixture source trees.
  Proof 5 uses a change engineered to draw a Codex finding (unbounded cache) plus the disclosed
  force switch as fallback. Post-build reviews pin immutable base/head SHAs.
- **Also adopted.** pgTAP RLS tests switch to real session roles (`set local role
  authenticated` + `request.jwt.claims`), never a privileged connection.

## 18. Revision 3 — after Codex recheck (2026-10-01)

Recheck: resolved 1, 2, 6, 11, 13, P3-order; partial 3, 4, 5, 7, 8, 9, 10, 12; three new issues.

- **R3' Byte-exact review identity.** Replace patch-id with `contentHash` = sha256 of
  `git diff -U0 --binary --no-color <mergeBase>..<head> -- . ':!<agent_log>'` with hunk headers
  normalised to `@@` (content incl. whitespace is preserved; pure line shifts from base updates
  are not). Each review round records `{fromHead, toHead, contentHashAtToHead}`; review coverage
  is valid iff the most recent clean round's `contentHashAtToHead` equals the current
  `contentHash`. Any PR-content change after it ⇒ another round.
- **R5' Approval without event dependence.** Every guard run (any event) recomputes approval:
  valid iff `human-approved` is present AND its latest `labeled` timeline event (actor = repo
  owner) is later than `headSeenAt` = earliest `created_at` among the head SHA's check suites
  (GitHub creates them at push). No check suite ⇒ invalid (fail closed). Same for
  `test-change-approved`. A stale approval label is removed (best effort) so the owner can
  re-add it. Each run re-reads labels + head immediately before posting statuses, so the last
  run to post uses current state; statuses are per-SHA, so runs for older heads can't affect
  the current one. Reordered-event test: approve A → push B → unrelated label run → red.
- **R7' Enclosing SQL statement.** For every changed line in any `*.sql` file, the classifier
  extracts the enclosing statement from the base and head file contents (from the previous `;`
  to the next `;`, comments stripped) and applies the R2 keyword rules to the whole statement.
  Test: predicate-only change `using (owner = auth.uid())` → `using (true)` inside an existing
  multi-line `create policy` in `schema.sql` → hit.
- **R8' Rollback.** Before merging, smoke the live production and record its deployment as
  known-good. On failure: re-read the live deployment; if it isn't the merge's deployment, smoke
  it — healthy ⇒ `superseded`, failing ⇒ continue. Immediately before rollback re-read the live
  deployment (abort to `needs-human` if it changed), roll back to known-good, re-read + smoke ⇒
  `recovered` or `rollback-failed`. Residual race with deploys from merges outside this run is
  documented and detected by the post-rollback check (never silent).
- **R9' Logging.** `checks.yml` drops its `paths:` filter (not `paths-ignore`). Agent-log
  outcome lines are flushed into the next ship PR; the per-PR summary comment is the immediate
  record. Delayed logging is stated in the README.
- **R10' Windows quoting.** Port cross-spawn's (MIT) `escapeArgument`/`escapeCommand` incl.
  double meta-char escaping for `.cmd`/`.bat` targets; Windows CI runs a real `echo-args.cmd`
  fixture and asserts round-trip of args with spaces, `&`, `%`, `!`, `"`, and trailing `\`.
- **R12' Locks.** Never reclaim a lock whose owner PID is alive on this host, whatever its age;
  release only by matching `runId`. Tests: live owner past timeout keeps the lock; a replaced
  owner's release is a no-op.
- **R1 note.** EagleWatch exemption goes in `KNOWN_NON_GATES` in
  `scripts/lib/expected-checks-matchers.mjs`.
