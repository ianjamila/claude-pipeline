# claude-pipeline

A global **build → verify → review → merge → production check** pipeline for Claude Code. Once a
repo is onboarded, asking Claude to build or fix something runs the whole flow unattended: a
branch and worktree, the change plus tests, a full local verify, a pull request, a cross-model
review loop (Codex finds, an Opus judge triages, a Fable arbiter rules on disputes), a final gate
bound to the exact commit, the merge, a production smoke test, and an automatic rollback if
production breaks. Nothing reaches `main` without proof, and anything sensitive stops for you.

Design: [`docs/specs/2026-10-01-claude-pipeline-design.md`](docs/specs/2026-10-01-claude-pipeline-design.md) ·
plan: [`docs/plans/2026-10-01-claude-pipeline-plan.md`](docs/plans/2026-10-01-claude-pipeline-plan.md) ·
CLI reference: [`docs/cli.md`](docs/cli.md).

## What gets installed

Into `~/.claude` (or `$CLAUDE_CONFIG_DIR`):

| Piece | What it does |
|---|---|
| skills `ship`, `verify`, `pipeline-setup` | the process: ship runs the flow, verify proves a change works, pipeline-setup onboards a repo |
| agents `implementer`, `verifier` (Sonnet), `judge` (Opus), `arbiter` (Fable) | the judgment; models are pinned in the agent files and proven from transcripts |
| `pipeline/bin/pipeline.mjs` | one zero-dependency Node CLI that makes every deterministic decision (hard-stops, final gate, merge, rollback) |
| hook `guard-git` (`Bash\|PowerShell`) | blocks pushes/force-pushes to `main`, admin merges, protection edits, approval-label changes |
| hook `guard-files` | blocks agents editing the pipeline's own files and settings — **installed last**, after the proofs |
| settings allow entries | `Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)` so pipeline calls don't prompt |

A manifest (`~/.claude/pipeline/INSTALLED.json`: version, git SHA, file hashes) lets the installer
refuse to overwrite skills or agents it didn't install, and lets `--check` report drift.
Requirements: Node ≥ 20, git, `gh` (authenticated); `codex` for reviews; `vercel` for projects
that deploy there.

## Install, update, uninstall

The installer refuses to run inside a Claude Code session (an agent must not be able to rewrite
its own rules). Run it **in your own terminal**, or start Claude with `PIPELINE_ADMIN=1 claude`.

```sh
git clone https://github.com/ianjamila/claude-pipeline ~/Claude/claude-pipeline   # private repo
cd ~/Claude/claude-pipeline
./install.sh --skip-file-guard     # macOS / Linux   (Windows: .\install.ps1 --skip-file-guard)
./install.sh --check               # drift report only; exit 1 if anything differs; never writes
```

- **Update:** `git pull && ./install.sh` (Windows: `git pull; .\install.ps1`). Re-running is
  idempotent; `settings.json` is backed up to `~/.claude/backups/settings.json.<UTC timestamp>`
  before every change, and hook entries from other tools are never touched.
- **File guard:** leave `--skip-file-guard` on until the pipeline has been proven on a real repo,
  then run `./install.sh` without it.
- **Uninstall:** `./install.sh --uninstall` removes the files in the manifest, our hook entries
  and our allow entries (again with a settings backup).
- Other flags: `--claude-home DIR`, `--force` (take over a same-named skill/agent; the old one is
  kept in `backups/`), `--json`. The report also shows `CLAUDE_CODE_SUBAGENT_MODEL` and the
  claude / codex / gh versions. Keeping `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` is fine: pinned agent
  models (judge = Opus, arbiter = Fable) still win over it.

## Using it

Onboard a repo once, then just ask for work:

| Say | What happens |
|---|---|
| "set up the pipeline" / "onboard this repo" | `pipeline-setup` audits the repo, shows a proposal, writes `.claude/pipeline.yml`, `scripts/verify.mjs`, the guard workflow and tests on `agent/pipeline-setup`, and opens a `needs-human` PR for you to merge |
| "add a CSV export to the reports page" (any build/fix request) | `ship` runs the full flow and reports back with the PR, the review outcome and production status |
| "resume pipeline reviews" | picks up every open `awaiting-review` PR (Codex was down or out of quota) and continues from the review step |
| "build #123" or relabel an issue `agent-suggestion` → `agent-build` | builds a follow-up idea the review loop filed |
| "verify this" / "is it working?" | `verify` runs the repo's verify and shows the evidence |

To onboard another project (e.g. DRMed): open Claude in that repo and say *"Set up the pipeline
for this repo. Ask me about hard-stops you can't infer."*

**Opting out:** start a session with `PIPELINE_OFF=1 claude`, or tell Claude not to use the
pipeline. ship and verify stand down and the project Stop hook skips; branch protection and the
global git guard stay on regardless.

**Pausing all merges in a repo:** open an issue labelled `pipeline-pause`. While it is open no run
merges (PRs still get built, verified and reviewed). Agents cannot close it. A failed production
smoke opens a `pipeline-rollback` issue that has the same effect until you close it.

### When a PR stops for you

| Label | Meaning | What you do |
|---|---|---|
| `needs-human` | a hard-stop (migration, auth/RLS, secrets, pipeline files, major dependency bump, sensitive personal data, project extras) or something the pipeline couldn't settle | read the PR and its summary comment; to approve add `human-approved` in the GitHub UI, `Hard-stop scan` re-runs, then merge |
| `pipeline-blocked` | verify stayed red after three fix cycles | the draft PR has the failing step and log excerpt |
| `awaiting-review` | Codex was unavailable | say "resume pipeline reviews" later |
| `test-change-approved` (you add it) | approves a PR that weakens or deletes tests | — |

Hard-stop PRs still go through the full review loop first, so you always get a reviewed PR.

## Enforcement — what stops what

| Guarantee | GitHub (Pro) | CI | Global hook | Skill / CLI |
|---|---|---|---|---|
| No direct or force push to `main` | ✅ protection (enforce admins) | | ✅ guard-git | ✅ |
| Required checks green before merge | ✅ required checks | ✅ | | ✅ final-gate |
| Hard-stop needs the owner | ✅ via required `Hard-stop scan` | ✅ | ✅ label guard | ✅ |
| Test weakening blocked | ✅ via required `Test integrity` | ✅ | ✅ label guard | |
| Linear history / squash | ✅ | | | ✅ |
| Fresh full verify bound to the head commit | | | | ✅ final-gate |
| Cross-model review happened | | | | ✅ no review ⇒ no merge |
| Arbiter really ran on Fable | | | | ✅ model-proof |
| Pause switch | | | ✅ can't close the pause issue | ✅ |
| Production smoke + rollback | | | | ✅ prod-watch |
| Agents can't edit their own rules | ✅ protection edits need admin | | ✅ guard-files / guard-git | |

The label-based approvals rely on the local hook because the agents use your GitHub account.

## Limits (stated plainly)

- **One identity.** Agents act as your GitHub account: their comments don't notify you, and
  `CODEOWNERS` documents ownership but cannot gate (you can't approve your own PR). The approval
  labels are protected by the local hook, not by GitHub.
- **Hooks stop accidents, not adversaries.** guard-git and guard-files catch direct and casually
  disguised attempts (subshells, `bash -c`, `eval`, env prefixes, the `pipeline job` wrapper), not
  a determined adversary with encoded payloads. GitHub branch protection is the hard boundary.
- **Branch protection needs GitHub Pro** for private repos. Without it a repo runs in `gate`
  mode (skills and CLI only) and preflight says so.
- **Local verify, lean CI.** The full verify runs on your machine; CI keeps the repo's existing
  checks plus the cheap guard jobs, and runs E2E only for high-risk PRs.
- **Agent log is delayed.** `docs/agent-log.md` can't be pushed to `main` directly, so each run's
  outcome line is committed in the *next* ship PR. The PR's summary comment is the immediate record.
- **Rollback race.** prod-watch re-reads the live deployment before and after rolling back and
  reports `superseded`, `recovered` or `rollback-failed`; a deploy from a merge outside the run
  can still race it, but is always detected, never silent. After a Vercel rollback, Vercel stops
  auto-assigning production domains until a deployment is promoted.

## Troubleshooting

- **Codex quota or outage:** the PR is built, verified, opened and labelled `awaiting-review`;
  preflight warns up front. Once Codex works again say "resume pipeline reviews".
- **`model-proof` failed** (the arbiter or judge transcript doesn't show the pinned model or
  effort): the disputed items go to `needs-human`. Check that the agent files in
  `~/.claude/agents/` still pin `model:` (`./install.sh --check`), that nothing passed a `model`
  override, and that the model is available on your plan (an invalid model fails with
  `model_not_found`; it never silently falls back).
- **Installer refuses** "inside a Claude Code session": run it from your own terminal.
- **`--check` reports drift:** someone edited an installed file; re-run `./install.sh`.
- **A merge didn't happen:** the run's summary comment and `.review/final-gate.json` in the
  worktree say which check failed (stale verify report, head moved, a required check not green,
  a blocking label, a pause or rollback issue).

## Developing this repo

```sh
npm test                          # node:test, no dependencies (node scripts/test.mjs [name-filter…])
node scripts/verify.mjs           # the pipeline's own verify; writes .verify/report.json
node pipeline/bin/pipeline.mjs --help
```

CI (`.github/workflows/ci.yml`) runs the suite on Ubuntu (Node 20 and 24) and Windows (Node 20),
plus an installer round trip into a throwaway Claude home with a space in its path. Its job names
`test (ubuntu)` and `test (windows)` are this repo's required checks.

The repo is onboarded to itself (`.claude/pipeline.yml`) with **every path a hard-stop**, so a
change to the pipeline never auto-merges: ship builds, verifies and reviews it, then hands you a
`needs-human` PR. `scripts/verify.mjs` is the project template with only its steps changed;
`test/self-verify.test.mjs` fails if the two drift.
