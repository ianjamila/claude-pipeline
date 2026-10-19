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
| hook `guard-git` (matcher `Bash\|PowerShell\|Monitor\|mcp__.*`) | blocks pushes/force-pushes to `main`, admin merges, protection edits, approval-label changes, whether typed in a shell, a `Monitor` command, a script file or an MCP tool call |
| hook `guard-files` (matcher `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash\|PowerShell\|Monitor\|mcp__.*`) | blocks agents editing the pipeline's own files and settings — **installed last**, after the proofs |
| hook `session-version` (SessionStart) | tells you at the top of a session when the installed pipeline is stale, edited, half-installed or older than a repo's vendored copy; silent when all is well (see [Staying current](#staying-current)) |
| hook `owner-go` (UserPromptSubmit) | records your chat "merge" (a prompt that starts with "merge") against the PR, head and owner items the reply before it showed, so `P merge` and the guards can tell your approval from the agent's word (`owner_approval: chat`, resumed runs); never blocks or changes a prompt |
| settings allow entries | `Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)` so pipeline calls don't prompt |

A manifest (`~/.claude/pipeline/INSTALLED.json`: version, git SHA, file hashes) lets the installer
refuse to overwrite skills or agents it didn't install, and lets `--check` report drift.

- **Fail-closed guards.** The two guard hooks are started through a small loader, not directly. If
  the hook file cannot be loaded (deleted, half-written, a syntax error) the loader blocks the
  tool call with exit 2 instead of letting Claude Code treat the crash as "allowed". The
  `session-version` status hook and the `owner-go` recorder are the exceptions: they never block anything.
- **Complete-install marker.** The installer writes the manifest with `"complete": false` first and
  flips it to `true` as its very last step, so an install that was interrupted (or whose later
  steps failed) is never mistaken for a good one. `--check`, `pipeline version` and the session
  warning all report it as `.incomplete`; re-running the installer (or `pipeline update`) fixes it.
- **One writer at a time.** Install and uninstall take a per-`claude-home` lock for the whole
  write run, so two of them (two terminals, two machines on a shared home) cannot interleave their
  swaps. The lock sits inside that home (`backups/.locks`) and is named for its real,
  symlink-resolved path, so reaching the home through an alias does not get around it. A lock whose owner process is gone is reclaimed; a live one is never touched, and the
  second run stops with a message naming the owner.
Requirements: Node ≥ 20, git, `gh` (authenticated); `codex` for reviews; `vercel` for projects
that deploy there.

## Install, update, uninstall

The installer refuses to run when it was started from a Claude Code session (it checks the process
ancestry: an agent must not be able to rewrite its own rules). Run it **in your own terminal**, or start
Claude with `PIPELINE_ADMIN=1 claude`.

```sh
git clone https://github.com/ianjamila/claude-pipeline ~/Claude/claude-pipeline
cd ~/Claude/claude-pipeline
./install.sh --skip-file-guard     # macOS / Linux   (Windows: .\install.ps1 --skip-file-guard)
./install.sh --check               # drift report only; exit 1 if anything differs; never writes
```

- **Update:** the install is a copy, so a merged change reaches your sessions only after you
  update it. Once the pipeline is installed, the normal path is one command in your own terminal
  (not a Claude session):
  ```sh
  node ~/.claude/pipeline/bin/pipeline.mjs update
  ```
  It looks up upstream's `main`, downloads exactly that commit into a private scratch directory
  under `~/.claude/pipeline-state/tmp` (never the system temp dir, which other accounts may be able
  to write to; it is created owner-only and refused if it is a symlink or someone else's) with an
  isolated git (no config, hooks, credential helpers or `GIT_*` variables of yours), installs from
  it, runs `install.mjs --check`, and reports success only when the installed stamp is that commit.
  A copy installed with `--skip-file-guard` stays that way. It is idempotent, and
  `settings.json` is backed up to `~/.claude/backups/settings.json.<UTC timestamp>` before every
  change; hook entries from other tools are never touched.
  - `update --check` only reports (installed stamp, upstream `main`, how they relate; exit 0 only
    when the install is complete, unmodified and identical to `main`) and works anywhere,
    including inside Claude Code. A real `update` refuses inside Claude Code, like the installer.
  - Both Claude accounts share `~/.claude/pipeline`, so `update` always installs into `~/.claude`
    and ignores `CLAUDE_CONFIG_DIR` (pass `--claude-home DIR` for any other location).
  - **Proxies are not supported yet.** The update's git runs with an allowlisted environment
    (`PATH`, `HOME`, the locale, and on Windows the few variables the runtime needs) and passes no
    `HTTPS_PROXY`, CA-bundle or `GIT_SSH*` variables, because each can redirect or intercept the
    download. On a network that needs a proxy, use the manual path below.
  - **First-time install, and the manual path:** `update` needs an installed pipeline, so the
    first install is still the clone + `install.sh` above. The same two steps update from a
    checkout (`git pull` on `main`, then `./install.sh` with the flags you originally used, then
    `./install.sh --check --skip-file-guard --claude-home ~/.claude`, expecting "No drift";
    Windows: `git pull; .\install.ps1 …`). Repeat `--skip-file-guard` until you have
    deliberately installed the file guard: an install without it installs the guard.
- **Check from inside a Claude session:** pass `--claude-home` explicitly. A session started with
  `CLAUDE_CONFIG_DIR` set (a second account) makes a bare `--check` inspect that directory instead,
  and it reports everything as missing. A second account that symlinks `skills/`, `hooks/` and
  `settings.json` to `~/.claude` also needs `agents -> ~/.claude/agents` once; updates then reach
  it automatically.
- **File guard:** leave `--skip-file-guard` on until the pipeline has been proven on a real repo,
  then run `./install.sh` without it.
- **Uninstall:** `./install.sh --uninstall` removes the files in the manifest, our hook entries
  and our allow entries (again with a settings backup).
- Other flags: `--claude-home DIR`, `--force` (take over a same-named skill/agent; the old one is
  kept in `backups/`), `--json`. The report also shows `CLAUDE_CODE_SUBAGENT_MODEL` and the
  claude / codex / gh versions. Keeping `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` is fine: pinned agent
  models (judge = Opus, arbiter = Fable) still win over it.

### Staying current

Three things tell you where an install stands:

- **The version stamp** (`node ~/.claude/pipeline/bin/pipeline.mjs version`, also written to a
  repo's `scripts/pipeline/VERSION` by `pipeline vendor`) is `<base>+<sha7>` plus flags that say
  what could *not* be proven:
  | Stamp | Meaning |
  |---|---|
  | `0.1.0+a1b2c3d` | the files are byte-for-byte what was installed from that commit |
  | `….modified` | an installed file differs from the manifest or is missing; re-run the installer or `update` |
  | `….incomplete` | an install started and did not finish (the complete-install marker is still `false`) |
  | `….unverified` | built from a source tree that was not a clean, published checkout (uncommitted edits, or HEAD not in `origin/main`), so the sha does not vouch for the files |
  | `0.1.0+unknown` | no source commit is known (no git, or no manifest), so nothing can be compared |
  A stamp with a flag or `+unknown` is never treated as "current": `update --check` exits 1, the
  session warning says the version cannot be compared, and `pipeline vendor --check` warns that a
  vendored `VERSION` carrying one does not prove which commit its files came from.
- **The SessionStart warning.** At the top of a session the `session-version` hook prints a short
  notice, and nothing at all when the install is fine. It compares your install with upstream
  `main` and with the copy a repo vendored into `scripts/pipeline/`, within a 4-second budget, and
  caches the lookups on disk (`$XDG_CACHE_HOME` or `~/.cache`, `claude-pipeline/`; `main` for 15
  minutes) so most sessions never touch the network. What the messages mean:
  | Message | What to do |
  |---|---|
  | `installed pipeline is modified / incomplete / unverified (…)` or `has no readable INSTALLED.json` | run `update` in your own terminal |
  | `claude-pipeline main is ahead of your install (abc1234 → def5678)` | run `update` |
  | `… have diverged, so it cannot be told which is newer` | `update` moves you to `main` |
  | `WARNING: this repo's scripts/pipeline (…) is NEWER than your installed pipeline` | the repo's CI rules are newer than your local CLI, so local checks may pass what CI rejects: `update` before relying on it |
  | `this repo's scripts/pipeline is out of date … a pipeline vendor PR is owed` | run `pipeline vendor` in that repo and open the PR - or say "open the vendor PR": the message ends with that offer, and Claude (told so in its own context only) checks for an already-open vendor PR first, then runs `ship` on a new `agent/` branch; it never vendors without your yes |
  | `could not check claude-pipeline main (<reason>); your install is <stamp>` | informational (the reason is one of `timed out`, `rate limited`, `not found`, `gh unavailable`, `network error`, `unexpected response`, never the raw error text): you are offline or GitHub is unreachable, so there is no comparison this session; a machine that is offline sees only this one line |
  | `this repo's scripts/pipeline/VERSION is not a version stamp` / `… carries an unrecognised stamp` | informational: the repo's `VERSION` is missing a stamp's shape, is not a plain regular file (a symlink, FIFO, …), or has parts outside the known set; its text is never echoed because the repo is untrusted |
  | `pipeline version check incomplete (timed out)` | informational: the 4-second budget ran out with nothing else to say |
  Everything read from the session's repo is treated as hostile: `VERSION` is read as a plain regular file (no symlinks, at most 256 bytes), the vendored-file comparison skips symlinks and special files, caps each file at 2 MB and stops at the deadline, and no repo or `gh` text is repeated in a message.
  The hook always exits 0 and is never started through the fail-closed loader: a failing version
  check cannot block a session.
- **`pipeline update --check`** gives the same comparison on demand, with exit codes (see above).

## Using it

Onboard a repo once, then just ask for work:

| Say | What happens |
|---|---|
| "set up the pipeline" / "onboard this repo" | `pipeline-setup` audits the repo, shows a proposal, writes `.claude/pipeline.yml`, `scripts/verify.mjs`, the guard workflow and tests on `agent/pipeline-setup`, and opens a `needs-human` PR for you to merge |
| "add a CSV export to the reports page" (any build/fix request) | `ship` runs the full flow and reports back with the PR, the review outcome and production status |
| "resume pipeline reviews" | picks up every open `awaiting-review` PR (Codex was down or out of quota) and continues from the review step |
| "ship inbox" / "what is each PR waiting on" | read-only: a table of every open PR (waiting on · last activity · next action), merges that were never watched in production, unpushed local work, orphan worktrees, and a merge / resume / close / leave suggestion for each. It closes, merges and removes nothing |
| "ship resume 123" / "pick up a stalled run" | continues PR #123 from its run record and comments, on this machine or another (after asking whether the other run stopped). It re-runs the final gate and stops for your "merge"; it never merges or rolls production back by itself (a merged run is only observed) |
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
| `needs-human` | a blocking hard-stop (migration, auth/RLS, secrets, pipeline files, major dependency bump, sensitive personal data, project extras; a project can make the non-database ones report-only, except the guard core `R4-pipeline` (workflows, `.claude/`, CODEOWNERS, pipeline scripts, files the CI checks read), via `hard_stops.report_only_rules` / `report_only_paths`: listed, never blocking) or something the pipeline couldn't settle | read the PR and its summary comment; to approve add `human-approved` in the GitHub UI (while the PR still shows the commit you reviewed), `Hard-stop scan` re-runs, then merge. A new push drops the approval: re-apply it |
| `pipeline-blocked` | verify stayed red after three fix cycles | the draft PR has the failing step and log excerpt |
| `awaiting-review` | Codex was unavailable | say "resume pipeline reviews" later |
| `test-change-approved` (you add it) | approves a PR that weakens or deletes tests; like `human-approved` it covers only the commit it was applied to | — |

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
| Gate judges the tree that will land (branch up to date with `main`) | | | ✅ `update-branch` stays allowed, merging through the API denied | ✅ `update-branch` before the gate, again in `merge` |
| Cross-model review happened | | | | ✅ no review ⇒ no merge |
| Arbiter really ran on Fable | | | | ✅ model-proof |
| Pause switch | | | ✅ can't close the pause issue | ✅ |
| Production smoke + rollback | | | | ✅ prod-watch |
| Agents can't edit their own rules | ✅ protection edits need admin | | ✅ guard-files / guard-git | |
| Owner items (`owner_approval: chat`) and resumed runs merge only on your chat "merge" for that head and item set | | | ✅ owner-go records (guard-files protects them); guard-git refuses a direct merge in a chat repo without one | ✅ `P merge` checks the record |

The label-based approvals rely on the local hook because the agents use your GitHub account.

**How an approval is bound to a commit.** When you add `human-approved` / `test-change-approved`, the guard run for
that `labeled` event first posts a receipt on the PR's head commit (a commit status `pipeline-approval: human-approved`,
created by `github-actions[bot]`, description "approved by <you>", target_url = the guard run, bound to this PR, head and moment). The label only counts for
a commit that carries a receipt that is not older than the label's latest `labeled` event, whose labeler is an allowed
approver, and whose run is verified: a `pipeline-guards.yml` run triggered by `pull_request_target` from a commit that
is on the default branch, is a first attempt (a re-run can execute an older guard revision, so re-runs never count), and
carries a verdict artifact that says the same (so a branch with its own edited copy of the workflow cannot mint receipts, nor
point a status at a genuine run that is still in progress; the final gate checks the two guard statuses the same way). Agents cannot post statuses or check runs themselves (`guard-git`). Commit
statuses belong to one sha, so an approval on A never covers a later commit B, however early B appeared elsewhere (another
branch, a fork PR). A label without a receipt for the current head (a push after approval, or the labeling run was
cancelled by a newer event before it could post) is ignored with "approval not recorded for this commit — re-apply the
label" and removed so you can re-add it. Residuals: the code of the genuine job is the trust anchor (anything that can post
statuses as `github-actions[bot]` can already post the two required statuses itself, but cannot give them the artifact the
gate demands; deleting an artifact only fails closed), and a stale browser tab can label a
head you did not review (the receipt names the head the event carried).

## Limits (stated plainly)

- **One identity.** Agents act as your GitHub account: their comments don't notify you, and
  `CODEOWNERS` documents ownership but cannot gate (you can't approve your own PR). The approval
  labels are protected by the local hook, not by GitHub; in CI only labels applied by the repo owner
  (or the logins in `ci.approvers`, which an organization-owned repo MUST list) count, and only for the exact commit
  that carries the workflow's receipt (see "How an approval is bound to a commit").
- **Hooks stop accidents, not adversaries.** guard-git and guard-files catch direct and casually
  disguised attempts (subshells, `bash -c`, `eval`, env prefixes, the `pipeline job` wrapper), not
  a determined adversary with encoded payloads. GitHub branch protection is the hard boundary.
  Coverage: Bash and PowerShell, `Monitor` commands, MCP tool calls and shell script files that contain
  a guarded command. They also deny a command line too long to be read in full (when it contains a
  guarded word), a push to a dynamic destination (only `$(git branch --show-current)`,
  `$(git rev-parse --abbrev-ref HEAD)` or a variable assigned a literal in the same command are
  understood; ship pushes `git push -u origin agent/<slug>`), `unset CLAUDECODE`, and setting
  `PIPELINE_GH`, `PIPELINE_CODEX`, `PIPELINE_VERCEL`, `PIPELINE_TEST_MODE` or `PIPELINE_UPDATE_REMOTE` on a `pipeline.mjs` command;
  the installed CLI ignores those five seam variables altogether (they exist for the test suite).
- **Your chat "merge" is checked locally.** The owner-go hook records only prompts you type (Claude Code never runs it for
  the model or a subagent), and `P merge` and guard-git trust only those records. But the agent runs as your OS user and with
  your GitHub token: a program the guards cannot see into (a script that builds the record path at run time, a test that
  calls the recorder's library, `curl` with your token, a local edit of the refs or `pipeline.yml` the guard reads) can still
  forge or skip it, and chat-mode CI passes owner items. It stops mistakes and casual workarounds, not a determined agent. The
  server-side backstop is a second GitHub identity plus a ruleset (issue #65). A direct `gh pr merge` in a chat repo must pin
  the head (`--match-head-commit`, or the head flag of the repo's merge command) the owner said "merge" for in this session. When
  the repo's merge command is a package script (`npm run merge -- {pr} --expect-head {sha}`), only that exact shape typed by hand is approvable: the
  template's own words, then `--`, the PR and the pin, with nothing between the script name and `--` and no manager option before it. Any other way
  of running the script (another manager or spelling, `run-script`, a wrapper such as `npx npm@11`, `--prefix` / `-C` / `--cwd` / workspace options,
  words before `--`) is refused in a chat repo; the refusal names the exact form. Merge through `P merge --pr N` otherwise. The chat
  mode is read from the repository the command runs in: a nested or separate clone whose own `pipeline.yml` is not chat is
  not caught (a protected registry of chat repos is the planned fix).
- **Branch protection needs GitHub Pro** for private repos. Without it a repo runs in `gate`
  mode (skills and CLI only) and preflight says so.
- **Local verify, lean CI.** The full verify runs on your machine; CI keeps the repo's existing
  checks plus the cheap guard jobs, and runs E2E only for high-risk PRs.
- **Verify slots are per machine.** `verify.max_parallel_full` limits full verifies on one computer, not across your machines, and the
  `verify.max_load` check is skipped on Windows (with a warning).
- **Agent log lives on its own branch.** `docs/agent-log.md` can't be pushed to `main` directly and a file every PR edits would
  conflict, so each run's outcome line is pushed to the orphan branch `pipeline-agent-log` (never into a PR). If that push
  fails, the line stays queued and goes out with the next run. The PR's summary comment is the immediate record.
- **Rollback race.** prod-watch re-reads the live deployment before and after rolling back and
  reports `superseded`, `recovered` or `rollback-failed`; a deploy from a merge outside the run
  can still race it, but is always detected, never silent. After a Vercel rollback, Vercel stops
  auto-assigning production domains until a deployment is promoted.

## Project settings and environment

`.claude/pipeline.yml` is documented in its template (`pipeline/templates/pipeline.yml`). Three keys deserve a
mention: `owner_approval` (`label` by default; `chat` drops the approval labels: blocking hard-stops and test-integrity
violations no longer fail CI, the ship skill stops before the merge, lists them in a PR comment and merges when you say
"merge" in chat; the PR ends as `awaiting-owner-merge`), `ci.guard_checks` (default `true`: the `Test integrity` and `Hard-stop scan` statuses are always
required on top of `ci.required_checks`; `false` only for a repo that does not run `pipeline-guards.yml`)
and `ci.approvers` (logins whose approval labels count; required for org-owned repos, otherwise approvals
fail closed with `org-repo-needs-ci.approvers`). `pipeline config` prints `warnings` for config that is valid
but suspicious. Documentation and test files are exempt from the content rules (sensitive terms, SQL, auth) but keep
one: a real-looking secret key literal (not marked fake inside the key itself) is still a `needs-human` hit there.

### Faster verify (opt-in)

Three groups of optional `verify` keys cut the wait without weakening the checks that matter. Leave them unset and
nothing changes: every verify is the full one, and runs at once.

```yaml
verify:
  after_fix: quick                 # full (default) | quick
  after_fix_steps_by_path:         # glob -> steps to add when a fix touches a match
    "supabase/**": [db, db-grants]
  after_fix_never: [sql-arms]      # steps that must always run in a full verify
  max_parallel_full: 2             # at most 2 full verifies at once on this machine
  max_load: 12                     # then wait while the 1-minute load average is above 12
  max_load_wait_minutes: 10        # ... for at most this long (default 10, maximum 10)
```

- `after_fix`: what the verifier runs after review fixes are accepted. `quick` runs `verify.quick`, plus
  `verify.full --only <steps>` for the steps whose paths (`after_fix_steps_by_path`) the fixes touched. The first full
  verify, and the gate's fresh full verify on the exact head that will merge, are always full and unchanged.
  `pipeline verify plan-after-fix --round R` prints the commands.
- `after_fix_never`: steps that may only run as part of a full verify. Listing one in `after_fix_steps_by_path` too is a config error.
- `max_parallel_full` (positive integer): full verifies of all repos on this machine share that many slots; the rest wait
  in arrival order (`pipeline verify slot --status` shows who holds them; `pipeline verify slot --run` runs only the repo's own `verify.full` in a slot, never another command). `max_load` and `max_load_wait_minutes` add a
  wait for a quiet machine after the slot is taken; when the time is up the verify runs anyway, with a warning.

Rollout: the config rejects unknown keys, so set these in a repo only after every machine that works on it has run
`pipeline update` to a version that knows them.

| Variable | Meaning |
|---|---|
| `PIPELINE_OFF=1` | ship, verify and the Stop hook stand down for the session |
| `PIPELINE_ADMIN=1` | allows the installer and `protect --apply` from a Claude session |
| `PIPELINE_MACHINE_ID` | stable id for this machine in the lock files (default: one generated once) |
| `PIPELINE_SMOKE_PORT` | the e2e smoke server's port; printed by `supabase-local env`, read by `playwright.smoke.config.ts` |
| `PIPELINE_TEST_COMMIT_AS_IS`, `PIPELINE_TEST_FORCE_ARBITER`, `PIPELINE_ARBITER_MODEL_OVERRIDE` | proof switches: see `skills/ship/reference/proof-switches.md` |

`pipeline vendor` also writes `.gitattributes` lines (`scripts/pipeline/** -text`, `scripts/verify text
eol=lf`) so a Windows checkout cannot change the vendored bytes; the `scripts/verify` shim must stay
executable.

## Troubleshooting

- **Codex quota or outage:** the PR is built, verified, opened and labelled `awaiting-review`;
  preflight warns up front. Once Codex works again say "resume pipeline reviews".
- **`model-proof` failed** (the arbiter or judge transcript doesn't show the pinned model or
  effort): the disputed items go to `needs-human`. Check that the agent files in
  `~/.claude/agents/` still pin `model:` (`./install.sh --check`), that nothing passed a `model`
  override, and that the model is available on your plan (an invalid model fails with
  `model_not_found`; it never silently falls back).
  With `owner_approval: chat` you can instead rule on the disputed items in chat: the run records it with
  `pipeline triage owner-ruling` (your exact words are published in the triage comment), you still say "merge"
  yourself, then remove `needs-human` and say `ship resume N`.
- **Installer refuses** "inside a Claude Code session": run it from your own terminal.
- **`--check` reports drift:** someone edited an installed file (or an install did not finish); run `node ~/.claude/pipeline/bin/pipeline.mjs update`, or re-run `./install.sh`.
- **A merge didn't happen:** the run's summary comment and `.review/final-gate.json` in the
  worktree say which check failed (stale verify report, head moved, a required check not green,
  a blocking label, a pause or rollback issue).

## Developing this repo

```sh
npm test                          # node:test, no dependencies (node scripts/test.mjs [name-filter…])
node scripts/verify.mjs           # the pipeline's own verify; writes .verify/report.json
node pipeline/bin/pipeline.mjs --help
```

CI (`.github/workflows/ci.yml`) runs the suite on Ubuntu (Node 20 and 24) and Windows (Node 24),
plus an installer round trip into a throwaway Claude home with a space in its path. Its job names
`test (ubuntu)` and `test (windows)` are this repo's required checks.

The repo is onboarded to itself (`.claude/pipeline.yml`) with **every path a hard-stop**, so a
change to the pipeline never auto-merges: ship builds, verifies and reviews it, then hands you a
`needs-human` PR. `scripts/verify.mjs` is the project template with only its steps changed;
`test/self-verify.test.mjs` fails if the two drift.
