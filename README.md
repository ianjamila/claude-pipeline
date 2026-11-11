# claude-pipeline

A global **build → verify → review → merge → production check** pipeline for Claude Code. Once a
repo is onboarded, asking Claude to build or fix something runs the build and review unattended: a
branch and worktree, the change plus tests, a quick local check, a draft pull request, a cross-model
review loop (Codex finds, a Sonnet judge triages low-risk PRs, a Fable pass rules on and reviews every medium/high-risk or sensitive PR), then CI (the full proof) on the
exact commit. You merge: the agent hands you the exact merge request and never merges itself. Nothing reaches `main` without proof, and anything sensitive stops for you.

Design: [`docs/specs/2026-10-01-claude-pipeline-design.md`](docs/specs/2026-10-01-claude-pipeline-design.md) ·
plan: [`docs/plans/2026-10-01-claude-pipeline-plan.md`](docs/plans/2026-10-01-claude-pipeline-plan.md) ·
CLI reference: [`docs/cli.md`](docs/cli.md).

## What gets installed

Into `~/.claude` (or `$CLAUDE_CONFIG_DIR`):

| Piece | What it does |
|---|---|
| skills `review`, `verify`, `pipeline-setup` | the process: review builds the change and runs the cross-model review, then asks you to merge; verify runs the quick check; pipeline-setup onboards a repo |
| agents `implementer`, `verifier` (Sonnet), `judge` (Opus), `arbiter` (Fable) | the judgment; models are pinned in the agent files and proven from transcripts |
| `pipeline/bin/pipeline.mjs` | one zero-dependency Node CLI that makes every deterministic decision (hard-stops, final gate, merge) |
| hook `guard-git` (matcher `Bash\|PowerShell\|Monitor\|mcp__.*`) | blocks pushes/force-pushes to `main`, admin merges, protection edits, approval-label changes, whether typed in a shell, a `Monitor` command, a script file or an MCP tool call |
| hook `guard-files` (matcher `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash\|PowerShell\|Monitor\|mcp__.*`) | blocks agents editing the pipeline's own files and settings — **installed last**, after the proofs |
| hook `owner-go` (UserPromptSubmit) | records your chat "merge" (a prompt that starts with "merge"), your typed ruling when you override one (a ruling request) and your `extra round` (a prompt that starts with `extra round` or `grant round`: one more review round past `review.max_rounds`) against the PR, head and owner items the reply before it showed, so `P merge` and the guards can tell your approval from the agent's word (`owner_approval: chat`, resumed runs); never blocks or changes a prompt |
| hook `stack-register` (PreToolUse on `Bash` and the write tools `Edit\|Write\|MultiEdit\|NotebookEdit`, 30 s) | records which private Supabase stack a session is about to use, before the tool runs; **fail-closed** like the guards (an unloadable file blocks with exit 2) |
| hook `stack-dev-bind` (PostToolUse on `Bash`, 10 s) | notes which stack a dev server you started is bound to; non-blocking |
| hook `update-notice` (SessionStart, 5 s) | prints one line at the start of a session when the automatic update has something to say (see Automatic updates); it only reads a small status file, never touches the network, and never blocks a session; non-blocking |
| hook `stack-session-end` (SessionEnd, 10 s) | when a session ends (not on `/clear`) it starts a detached worker that decides whether that session's stacks can be stopped; non-blocking |
| settings allow entries | `Bash(node ~/.claude/pipeline/bin/pipeline.mjs:*)` so pipeline calls don't prompt |

A manifest (`~/.claude/pipeline/INSTALLED.json`: version, git SHA, file hashes) lets the installer
refuse to overwrite skills or agents it didn't install, and lets `--check` report drift.

- **Fail-closed guards.** The two guard hooks are started through a small loader, not directly. If
  the hook file cannot be loaded (deleted, half-written, a syntax error) the loader blocks the
  tool call with exit 2 instead of letting Claude Code treat the crash as "allowed". The
  `owner-go` recorder and the `stack-dev-bind`, `stack-session-end` and `update-notice` hooks are the exceptions: they never block anything. `stack-register` is fail-closed like the guards.
- **Complete-install marker.** The installer writes the manifest with `"complete": false` first and
  flips it to `true` as its very last step, so an install that was interrupted (or whose later
  steps failed) is never mistaken for a good one. `--check`, `pipeline version` and the session
  warning all report it as `.incomplete`; re-running the installer (or `pipeline update`) fixes it.
- **One writer at a time.** Install and uninstall take a per-`claude-home` lock for the whole
  write run, so two of them (two terminals, two machines on a shared home) cannot interleave their
  swaps. The lock sits inside that home (`backups/.locks`) and is named for its real,
  symlink-resolved path, so reaching the home through an alias does not get around it. A lock whose owner process is gone is reclaimed; a live one is never touched, and the
  second run stops with a message naming the owner.
Requirements: Node ≥ 20, git, `gh` (authenticated); `codex` for reviews.

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

- **Update:** the install is a copy, so a merged change reaches your sessions only after it is
  updated: by you, or by the optional scheduled job (see Automatic updates below). Once the
  pipeline is installed, the manual path is one command in your own terminal
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

Two things tell you where an install stands:

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
  A stamp with a flag or `+unknown` is never treated as "current": `update --check` exits 1, and
  `pipeline vendor --check` warns that a vendored `VERSION` carrying one does not prove which commit its files came from.
- **`pipeline update --check`** compares your install with upstream `main` on demand, with exit codes (see above).

### Automatic updates

Optional. A small job on your machine checks `main` every few minutes and installs it for you, but
only when no review is running, so a review is never cut off halfway. The manual `update` keeps
working exactly as before.

- **The `pupdate` shortcut.** Put this in your own `~/.zshrc` (the installer never edits your
  dotfiles):
  ```sh
  alias pupdate='PATH="/opt/homebrew/bin:$PATH" node "$HOME/.claude/pipeline/bin/pipeline.mjs" update'
  ```
  `pupdate --check` reports, `pupdate` updates. Like `update`, it refuses inside a Claude session.
- **Turning it on (once per machine, owner only).**
  1. Run `pupdate` once, in a plain terminal, so the installed copy is the first one that has this
     feature. Nothing can switch it on before that.
  2. Run `node ~/.claude/pipeline/bin/pipeline.mjs update schedule --install`, again in your own
     terminal: it is refused inside Claude Code, because it arranges for the guard hooks to be
     replaced unattended. `--every N` sets the minutes between runs: 5, 10, 15, 20, 30 or 60
     (default 15). Running it again with another `--every` replaces the job.
  3. `update schedule --status` shows whether the job is installed; `update schedule --remove` takes
     it away. Both run anywhere, including inside Claude Code. `./install.sh --uninstall` does not
     remove the job: run `update schedule --remove` first.

  On a Mac the job is the LaunchAgent `com.claude-pipeline.auto-update` (it also runs when loaded,
  so a Mac that slept catches up). On Linux or WSL it is one crontab line. Native Windows is not
  supported (`unsupported-platform`). The job runs the **installed** pipeline; `git` and `gh` must
  be on your `PATH` when you install it, and its log is `~/.local/state/pipeline/cron-auto-update.log`.
- **What one run does.**
  - Up to date: nothing, and no message.
  - Behind `main`: downloads it, then installs it **only if no review is running**. If one is, it
    writes nothing, logs one line saying what is live, and tries again next run.
  - If the installed copy changed while the download ran (an edit of yours, a manual update), it
    installs nothing and looks again next run.
  - **Never touched automatically:** an install that is modified, incomplete (an interrupted
    install), ahead of `main` or diverged from it. The job cannot tell an interrupted install from
    one you edited on purpose, so it leaves it alone and tells you the exact command to run
    yourself.
  - After an install it runs the installer's own check. If that fails you get one message with the
    drift, and that version of `main` is not retried (the next `main` is).
- **What counts as "a review is running".** The installer looks, under a lock, for any of these:
  - a *review lease*: while you are in a Claude session, every pipeline command that touches a
    worktree's review (`codex-review`, `merge`, `verify`, `summary` and so on; the list is in
    `docs/cli.md`) records that the session is working on it. `summary` (the stop ritual) or an
    ended run closes it. A lease stops counting when the session is gone, after `/clear` or a
    resume (same process, new session id), or after 6 hours with no pipeline command; a detached
    `P job` still running in the worktree keeps it alive. A plain terminal takes no lease;
  - a `P job` that is still running (or just starting) in a worktree of a repo this machine knows;
  - a held review, merge or queue lock, or a merge command that outlived its run;
  - a merge-queue record that is not finished;
  - anything it cannot read, or cannot finish looking at within two minutes: that counts as
    "live", never as "safe".

  While it swaps files it also holds a separate lock, so a review command that starts in that
  moment waits (up to 20 seconds); if the swap is still going, the command stops without doing
  anything: `update-in-progress`, "retry in a minute".
- **When it tells you.** A banner on a Mac, a line in the job's log and a line in
  `~/.local/state/pipeline/pipeline-update-notices.log`, only when you have to act or something was
  installed:
  - after an install: "pipeline updated to <sha7> (<PR title>)";
  - a blocked install (modified, incomplete, ahead, diverged), a failed check, or any other
    failure: once per reason and `main` sha, with the command to run;
  - a temporary problem (GitHub cannot be reached to look up or compare `main`, or another install
    holds the install lock): only on the third run in a row; one good run ends the count;
  - waiting for a review for more than 24 hours: once per wait, naming what is live. The clock
    starts at the first deferral; if the system clock jumps backwards the count starts again.
- **The status file and the line at session start.** Every run writes
  `~/.claude/pipeline-state/update-status.json` (state `current`, `behind`, `deferred-by-review`,
  `blocked-modified` or `failed`; when it last checked; the installed and `main` shas; the command
  to run). The `update-notice` hook reads only that file when a session starts and prints one line,
  nothing when you are current:
  - `pipeline update available — installs automatically when no review is running`
  - `pipeline update waiting on a review in <repo> #N` (or just the repo, or `a running review`)
  - `pipeline update needs you: run pupdate` (blocked or failed)
- **A stated limit.** The swap replaces the guard hooks one by one. A guard hook that Claude Code
  starts in the instant its own file is being swapped is **refused** (the loader fails closed,
  exit 2), never allowed: the tool call that triggered it fails and can simply be retried.

### The Fable floor

The whole-PR review pass runs on Fable, and a proof from an older Fable is refused once a newer one has been proven on your machine.
That lowest accepted version is the **floor**. It is stored in `~/.claude/pipeline-state/owner-go/model-floor/fable.json`, where agents cannot write:
only a fully proven pass (`arbiter apply`) raises it, and it starts at the pipeline's `MIN_FABLE` constant. Bumping `MIN_FABLE` is a normal pipeline PR.

- **A stale terminal stops, it does not park.** If the terminal's Claude Code build is older than the installed one, `arbiter needed` exits 1
  `stale-terminal` before any Fable spend; if the pass ran on an older Fable than the floor, `arbiter apply` exits 1 `stale-model`. Both carry
  `restartRequired` and an `advice` line. The agent stops (outcome `blocked`, no label), posts the advice and asks you to restart the
  terminal (or update Claude Code). `pipeline preflight` shows a `claudeCode` warning up front; it never changes whether a PR can merge.
- **Old proofs are re-reviewed, not grandfathered.** `review-complete` and the final gate refuse a PR whose Fable round was proven below the
  newest Fable (the reason says `fable-refresh`); the agent runs `pipeline state fable-refresh --pr N`, which opens one uncounted Fable-only
  round on the pushed head (no Codex, not counted against `review.max_rounds`) that reviews the whole PR diff.
- **Owner commands.** `pipeline model-floor show` prints the floor, any hold and any lock. `pipeline model-floor reset [--hold <id> | --clear-hold] [--allow-id <id> | --remove-allow <id> | --clear-allow] [--clear-lock [--keep-floor]]`
  (your own terminal only) returns the floor to the code constant. `--hold <id>` also sets a ceiling the floor cannot rise above, for an alias
  rollback or for two accounts that resolve different Fables, until `--clear-hold`; it also lowers the version below which a recorded Fable proof is
  re-reviewed, so a review proven with the held model can complete. A Fable id the parser cannot read blocks reviews, including the PR that fixes the
  parser (a hold does not help): run `model-floor reset --allow-id <the exact new id>` from a plain terminal (repeatable, at most 10; an allowance never raises the
  floor for an id the parser cannot read), merge the parser fix, then `model-floor reset --remove-allow <that id>` (`--clear-allow` drops every allowed id instead). Those calls (with or without `--clear-lock`) change only the allow list: the learned floor and any hold are kept
  (a corrupt registry is refused; run a plain `model-floor reset` first), and an allowed id the parser can read is judged by its version like any other (refused below the floor, able to raise it); once the parser reads an allowed id, `model-floor show` lists it under `readableAllowed` and `preflight` warns that the allowance is no longer needed and names the `--remove-allow` command. A floor lock left behind by another host or an unreadable record is cleared with `model-floor reset --clear-lock --keep-floor` (it removes the lock and rewrites nothing; a bare `--clear-lock` is a plain reset, which also forgets the learned floor). Both refuse (`model-floor-lock-live`, naming the pid and the lock folder) while the lock's holder is a running process on this machine: confirm the pid is a pipeline process (`ps -p <pid> -o command=`) and stop it or wait for it; if it is not (a recycled pid), remove the lock folder by hand. They remove only the lock they inspected (one a review takes meanwhile survives), do nothing when there is no lock, and refuse a lock they cannot read (`model-floor-lock-unreadable`). When another recovery, or a review that is just starting up, holds the lock for a moment they refuse with `model-floor-lock-busy` (exit 1): run the command again in a moment. `arbiter apply` also re-checks that it still holds the lock, and re-reads the floor, just before it saves.
  While an allowance or a hold below the shipped minimum is what lets a proof count, `arbiter apply` and `model-proof` print `floor: {newest, allowed, heldBelowMin}`,
  `review-complete` and the final gate's review check name the round, and `pipeline preflight` warns until you clear it. Every floor failure of `arbiter apply` carries an `advice` line saying which of these to do.
- **Cost reports** price each call per model version, so a Fable bump does not reprice earlier PRs.

## Using it

Onboard a repo once, then just ask for work:

| Say | What happens |
|---|---|
| "set up the pipeline" / "onboard this repo" | `pipeline-setup` audits the repo, shows a proposal, writes `.claude/pipeline.yml`, `scripts/verify.mjs`, the guard workflow and tests on `agent/pipeline-setup`, and opens a `needs-human` PR for you to merge |
| "add a CSV export to the reports page" (any build/fix request) | `review` builds it on a branch, opens a draft PR, runs the Codex review loop, and ends with a merge request for you to answer |
| "build #123" or relabel an issue `agent-suggestion` → `agent-build` | builds a follow-up idea the review loop filed |
| "verify this" / "is it working?" | `verify` runs the repo's verify and shows the evidence |

To onboard another project (e.g. DRMed): open Claude in that repo and say *"Set up the pipeline
for this repo. Ask me about hard-stops you can't infer."*

**Opting out:** start a session with `PIPELINE_OFF=1 claude`, or tell Claude not to use the
pipeline. review and verify stand down; branch protection and the
global git guard stay on regardless.

### `P stacks`: stopping private Supabase stacks nobody needs

Private local stacks (one per worktree) keep eating memory after the work is done. `P stacks` stops the ones nobody uses.

- **Measure first.** Every mode (`sessionEnd`, `sweeper`, `devServers`) starts as `report`: it logs what it *would* stop and stops nothing. Check `P stacks status`. After 7 days with `MISS 0` (a stack it would have stopped was used within 2 h by a process that was already running), flip one mode to `apply` in `~/.claude/pipeline-state/stacks/mode.json`. Only you do that.
- **What counts as use.** Starting, stopping, querying or editing a stack registers a lease; just looking (`docker ps`, `docker logs`, `ls`, `grep`, the Read / Grep / Glob tools) does not. A session that was alive at the would-stop but only inspected the stack until then is a RESTART, not a MISS, when its own transcript shows nothing but read-only work (needs the config's `transcriptDirs`); anything doubtful stays a MISS.
- **Pause.** `touch ~/.claude/pipeline-state/stacks/pause` stops everything on every path; delete the file to resume.
- **Keep list.** `~/.claude/pipeline-state/stacks/keep` holds one project id per line (`#` comments); a listed project is never stopped.
- **Setup.** `P stacks init --write` writes the machine config (which ids are shared, which repos to scan). `P stacks schedule --install` adds the daily sweep. Install writes neither.
- **Look and fix.** `P stacks status` shows modes, leases and the last report. `P stacks repair` moves a damaged ledger aside.
- **Safety.** Shared stacks (your configured ids, anything ending `-pipeline`, anything under `.verify/supabase-workdir`) are never stopped. The only stop command is `supabase stop --workdir <dir>`, which keeps the data. Volumes are never deleted. Any doubt (a probe fails, a process cannot be read) means the stack is kept. Processes of other OS users are seen by their connections and command lines only; their environment and open files cannot be read without root.

**Pausing all merges in a repo:** open an issue labelled `pipeline-pause`. While it is open no run
merges (PRs still get built, verified and reviewed). Agents cannot close it. An open
`pipeline-rollback` issue (one you or your own tooling opened) has the same effect until you close it.

### When a PR stops for you

| Label | Meaning | What you do |
|---|---|---|
| `needs-human` | a blocking hard-stop (migration, auth/RLS, secrets, pipeline files, major dependency bump, sensitive personal data, project extras; a project can make the non-database ones report-only, except the guard core `R4-pipeline` (workflows, `.claude/`, CODEOWNERS, pipeline scripts, files the CI checks read), via `hard_stops.report_only_rules` / `report_only_paths`: listed, never blocking) or something the pipeline couldn't settle | read the PR and its summary comment; to approve add `human-approved` in the GitHub UI (while the PR still shows the commit you reviewed), `Hard-stop scan` re-runs, then merge. A new push drops the approval: re-apply it |
| `pipeline-blocked` | verify stayed red after three fix cycles | the draft PR has the failing step and log excerpt |
| `awaiting-review` | Codex was unavailable | ask for the review again once Codex works; `pipeline review-complete` takes the label off |
| `test-change-approved` (you add it) | approves a PR that weakens or deletes tests; like `human-approved` it covers only the commit it was applied to | — |

Hard-stop PRs still go through the full review loop first, so you always get a reviewed PR.

Commands the agent hands you to run (a merge command, `pipeline protect` lines) are written with `gh`'s absolute path
(`/opt/homebrew/bin/gh …`): a command typed at Claude Code's `!` prompt runs in a shell that does not load your login PATH, so a bare
`gh` is "command not found" there. To see whether a PR would merge without merging it, the agent runs `pipeline merge --pr N
--dry-run`; it changes nothing and grants nothing.

`pipeline merge --owner-go` (and its dry run) refuse a PR that lacks commits of its base, as does every merge route. A repo can opt in to
merging such a PR as it is when main's new commits touch none of the PR's files: `merge.behind_base: disjoint` in `.claude/pipeline.yml`
**on the base branch** (the PR's own copy is never read). Changes to CI and toolchain files on main (`.github/**`, the pipeline config,
`scripts/verify*`, `.gitattributes`, `.nvmrc`, ...), the repo's `verify.ci_proof_inputs` and its `merge.behind_base_stale_paths` globs always force
the update. Your "merge" is still for that exact head and items, not for main's commit; the request shown to you says the PR is behind.
See [docs/cli.md](docs/cli.md) (`merge`).

## Enforcement — what stops what

| Guarantee | GitHub (Pro) | CI | Global hook | Skill / CLI |
|---|---|---|---|---|
| No direct or force push to `main` | ✅ protection (enforce admins) | | ✅ guard-git | ✅ |
| Required checks green before merge | ✅ required checks | ✅ | | ✅ final-gate |
| Hard-stop needs the owner | ✅ via required `Hard-stop scan` | ✅ | ✅ label guard | ✅ |
| Test weakening blocked | ✅ via required `Test integrity` | ✅ | ✅ label guard | |
| Linear history / squash | ✅ | | | ✅ |
| Full proof on the head commit | | ✅ CI runs the full verify | | ✅ the merge checks the required checks for that exact head (and the verify report, when `final-gate` is used) |
| Gate judges the tree that will land (branch up to date with `main`) | | | ✅ `update-branch` stays allowed, merging through the API denied | ✅ `update-branch` before the gate, again in `merge` |
| Cross-model review happened | | | ✅ guard-files keeps agents from writing a repo's review state (`.review/state.json`, round folders, gate / smoke records); guard-git keeps them from posting the review-complete or triage markers | ✅ no review ⇒ no merge |
| Arbiter really ran on Fable | | | | ✅ model-proof |
| Pause switch | | | ✅ can't close the pause issue | ✅ |
| Agents can't edit their own rules | ✅ protection edits need admin | | ✅ guard-files / guard-git | |
| Owner items (`owner_approval: chat`) and resumed runs merge only on your chat "merge" for that repository, head and item set | | | ✅ owner-go records (guard-files protects them); guard-git refuses a direct merge in a chat repo without one | ✅ `P merge` checks the record |

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
  Coverage: Bash and PowerShell, `Monitor` commands, MCP tool calls, shell script files and package scripts (`npm run NAME`, `npm test`, `pnpm NAME`, `yarn NAME`, `bun run NAME`, with their
  `pre` / `post` hooks, read from the nearest package.json or the one `--prefix` / `-C` / `--dir` / `--cwd` / a workspace option names) that contain
  a guarded command. Install, pack, publish and version run their lifecycle scripts (`prepare`, `postinstall` ...), which are opened too (`--ignore-scripts` turns them off). Any
  `npm_*` / `yarn_*` / `pnpm_*` / `bun_*` / `COREPACK_*` variable, `INIT_CWD`, a .npmrc (the project's, the user's, and the global one under the prefix the user's or the project's `prefix=` / `--prefix` / node's own place names: `<prefix>/etc/npmrc`) that sets `script-shell`, `node-options` or `globalconfig`, a `prefix=` the guard cannot work out (an unknown `${VAR}`), a subcommand or option the guard does not know, and the manager's own writes earlier on the line (`npm pkg set`, `npm set-script`, `npm config set`, `npm init` ...) make the script unknown, and it is refused. `npm explore PKG -- CMD` runs CMD in `node_modules/PKG` of the project: CMD is judged like `bash -c CMD` run there, a file it runs inside that package is opened (a program run by path in node_modules is not otherwise), and a PKG that is not a plain name (a variable, a glob, `..`, a path) or a `-g` explore is refused; without CMD it opens an interactive shell and there is nothing to judge. A line that writes package.json or a configuration file before the manager reads it is refused too, and one that may write it (a target only known at run time) when it also mentions a guarded operation: the same rule as for a script file, so, like a script file, a `git checkout`, a `git worktree add`, a `tar x` or a background job earlier on the line is not followed. They also deny a command line too long to be read in full (when it contains a
  guarded word), a push to a dynamic destination (only `$(git branch --show-current)`,
  `$(git rev-parse --abbrev-ref HEAD)` or a variable assigned a literal in the same command are
  understood; the review skill pushes `git push -u origin agent/<slug>`), `unset CLAUDECODE`, and setting
  `PIPELINE_GH`, `PIPELINE_CODEX`, `PIPELINE_VERCEL`, `PIPELINE_TEST_MODE` or `PIPELINE_UPDATE_REMOTE` on a `pipeline.mjs` command;
  the installed CLI ignores those five seam variables altogether (they exist for the test suite).
  The stack-stop seams `PIPELINE_DOCKER`, `PIPELINE_PS`, `PIPELINE_LSOF`, `PIPELINE_SUPABASE`, `PIPELINE_STACKS_DEADLINE_MS` and `PIPELINE_INSTALL_WORKER_WAIT_MS` follow a stricter rule: an installed copy ignores them always; in the repo checkout they count only when `PIPELINE_STACKS_HOME` points somewhere other than the default `~/.claude/pipeline-state/stacks` **and** `PIPELINE_STACKS_ONLY` names the projects that isolated run may touch.
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
  not caught (a protected registry of chat repos is the planned fix). One more vector is open: a nested `claude -p`, `claude --resume` or
  `claude --continue` run from the agent's shell may produce a top-level prompt the hook records as yours, for a "merge", a ruling or an
  `extra round` alike; no guard names the `claude` CLI yet (see #132 / PR #133).
- **Branch protection needs GitHub Pro** for private repos. Without it a repo runs in `gate`
  mode (skills and CLI only) and preflight says so.
- **Quick check locally, CI is the full proof.** The agent runs only `verify.quick` on the changed area; CI runs the full verify, the
  repo's existing checks and the cheap guard jobs (E2E only for high-risk PRs). The owner merges, never the agent.
- **Verify slots are per machine.** `verify.max_parallel_full` limits full verifies on one computer, not across your machines, and the
  `verify.max_load` check is skipped on Windows (with a warning).
- **Agent log lives on its own branch.** `docs/agent-log.md` can't be pushed to `main` directly and a file every PR edits would
  conflict, so each run's outcome line is pushed to the orphan branch `pipeline-agent-log` (never into a PR). If that push
  fails, the line stays queued and goes out with the next run. The PR's summary comment is the immediate record.

## Project settings and environment

`.claude/pipeline.yml` is documented in its template (`pipeline/templates/pipeline.yml`). Three keys deserve a
mention: `owner_approval` (`label` by default; `chat` drops the approval labels: blocking hard-stops and test-integrity
violations no longer fail CI, the review skill stops before the merge, lists them in a PR comment and merges when you say
"merge" in chat; the PR ends as `awaiting-owner-merge`), `ci.guard_checks` (default `true`: the `Test integrity` and `Hard-stop scan` statuses are always
required on top of `ci.required_checks`; `false` only for a repo that does not run `pipeline-guards.yml`), `ci.review_check`
(default `false`; `true` makes the guards also post `Cross-model review`, green only when the newest review-complete comment
names the head's content hash, and every required-check list includes it; turn it on together with branch protection)
and `ci.approvers` (logins whose approval labels count; required for org-owned repos, otherwise approvals
fail closed with `org-repo-needs-ci.approvers`). `pipeline config` prints `warnings` for config that is valid
but suspicious. Documentation and test files are exempt from the content rules (sensitive terms, SQL, auth) but keep
one: a real-looking secret key literal (not marked fake inside the key itself) is still a `needs-human` hit there.

### Merge hold (opt-in)

For a repo whose merge command keeps a cooperative merge lock (EagleWatch's `merge-hold` label), `pipeline.yml` can carry three
`merge` keys, all three or none: `hold_command` (take the hold; `{pr}`), `hold_release_command` (release it; `{pr}` and `{reason}`)
and `hold_check_command` (a read-only check that prints one JSON line naming the PRs whose holds block this one; `{pr}`). EagleWatch:
`npm run merge-hold -- {pr}`, `npm run merge-hold -- {pr} --release --reason {reason}`, `npm run merge-hold -- --status {pr} --json`.
With them the review skill takes the hold when it hands you the merge request and releases it when the request is withdrawn; `pipeline merge`
and `pipeline update-branch` refuse (`queued-behind`) instead of updating a branch that must wait for an older hold, and a dry run runs the
read-only check. The pipeline-side check is cooperative (only a hold-aware merge command catches a hold taken after the check). Merge and
install the pipeline change before adding the keys; to roll back, remove the keys first. A PR whose hold expires and is renewed goes to the
back of the queue; your exits are merging the PR ahead, releasing its hold, or the provider's `--ignore-hold`. Details: `docs/cli.md`, Merge hold under `merge`.

### Queue mode (GitHub merge queue; automatic)

No setting: when GitHub reports a merge queue on a PR's base branch, `pipeline merge` enqueues the exact head you approved ("merge" once, no catch-up CI, no merge hold,
no `pipeline update-branch`) and GitHub merges it after testing it on top of main and everything ahead of it. The pipeline keeps watching the usual stop conditions
(`needs-human` / `pipeline-blocked`, pause and rollback issues) and re-queues the same head once if the group's checks removed it; a second removal is red CI. Sessions cannot
enqueue, dequeue or enable auto-merge by hand (the guard points them to `P merge --pr N`). If the session ends, `pipeline queue-sweep` carries every queued PR to its end: on macOS the
installer writes the LaunchAgent `com.claude-pipeline.queue-sweep` (every 10 minutes, exits at once when nothing is queued) and removes it on uninstall. Queue off: nothing changes.
One gap stays: a stop condition set after the queue's last check but before GitHub merges the group is caught only while a `merge` job polls; otherwise the sweep reports it afterwards.
Details: `docs/cli.md`, Queue mode under `merge`, and `queue-sweep`.

### Smoke firewall bypass header (opt-in)

If a firewall (for example Vercel's) answers 429 to CI runner IPs, the production smoke can send one secret header that a
firewall "Bypass" rule matches. Set `smoke_bypass_header: x-smoke-key` in `pipeline.yml` (a lowercase `x-` name; default
`null` = nothing extra is sent), list where it may go in `smoke_bypass_origins: ["https://www.example.com"]` (required
when the header is set; exact https origins, no wildcards or paths) and put the secret in the `PIPELINE_SMOKE_BYPASS_KEY` environment variable, never in a file.
It is a firewall hint, not app authentication: the smoke stays a cookie-less, GET-only request, the header goes only to a base whose
origin is exactly in `smoke_bypass_origins` (never a preview URL, another host or localhost; redirects are not followed), and the value is never printed. The smoke's JSON gains
`bypassHeader: true|false` (whether it was sent); a configured name with no environment value is `false`, not an error.
Re-vendor (`pipeline vendor`) so the project's `scripts/pipeline/smoke.mjs` and `lib/config.mjs` know the key.

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

A fourth, stricter group lets GitHub's own test run replace one slow local step at the final gate:

```yaml
verify:
  deferrable_steps: [sql-arms]     # steps whose local run a GitHub Actions run may replace
  ci_proof:
    sql-arms: { workflow: .github/workflows/migration-replay.yml, job: "SQL arms", event: pull_request }
  ci_proof_inputs: [supabase/tests/sql-arms/**]   # extra paths that make a PR ineligible
  ci_proof_wait_minutes: 20        # how long the pipeline waits for that run (unset = it does not wait)
```

- Safety rule: the Mac is skipped for a step only when the final gate finds a passed run of exactly that workflow file and job, on this
  exact commit, for this pull request (not a fork), whose merged test copy has the same files as the pull request's head, and the pull
  request changed neither the CI setup (`.github/**`), the pipeline settings, the verify scripts nor `ci_proof_inputs`. The three settings are
  read from the main branch, never from the pull request. Anything unclear (no run, still running, cancelled, a GitHub error) sends the step
  back to the Mac; `merge` records which proof was used (Mac, or GitHub run and attempt) on the pull request.
- `steps` (optional, per `ci_proof` entry): a list of step names inside that job, e.g. `ci_proof: { typecheck: { workflow: .github/workflows/checks.yml, job: "Typecheck + Vitest", steps: ["Typecheck", "Vitest"] } }`.
  A job with a step-level skip (a docs-only PR) reports `success` although every work step was skipped, so for such a job the green job alone
  proves nothing. With `steps`, the proof is taken only when each named step appears exactly once in the job and is `completed` with
  conclusion `success`; absent, repeated, skipped, cancelled or failed (even under a green job) sends the step back to the Mac. Names are matched
  exactly (case and spaces), at most 20 names of at most 200 characters, no repeats. The job's `steps` come from the run's jobs listing, or one extra read of the job.
  A repo's `scripts/pipeline/lib/config.mjs` (vendored) must know `steps` before the key is set: run `pipeline update`, then `pipeline vendor` in the repo.
- `ci_proof_wait_minutes` is the longest the pipeline waits for the GitHub run before it runs the step on the Mac instead; set it from the measured CI time.
- Rollout: eaglewatch enables `ci_proof` only after its PR B (draft runs, always-report, sharded jobs with one aggregator job) and one measured database PR.
  Until then it uses only `after_fix` and the slot limit.

Rollout: the config rejects unknown keys, so set these in a repo only after every machine that works on it has run
`pipeline update` to a version that knows them.

| Variable | Meaning |
|---|---|
| `PIPELINE_OFF=1` | review and verify stand down for the session |
| `PIPELINE_ADMIN=1` | allows the installer and `protect --apply` from a Claude session |
| `PIPELINE_MACHINE_ID` | stable id for this machine in the lock files (default: one generated once) |
| `PIPELINE_SMOKE_BYPASS_KEY` | secret value of the `smoke_bypass_header` header (see "Smoke firewall bypass header"); read only by `scripts/pipeline/smoke.mjs`, never printed |
| `PIPELINE_SMOKE_PORT` | the e2e smoke server's port; printed by `supabase-local env`, read by `playwright.smoke.config.ts` |
| `PIPELINE_TEST_COMMIT_AS_IS`, `PIPELINE_TEST_FORCE_ARBITER`, `PIPELINE_ARBITER_MODEL_OVERRIDE` | proof switches (test and proof runs only; see docs/cli.md) |

`pipeline vendor` also writes `.gitattributes` lines (`scripts/pipeline/** -text`, `scripts/verify text
eol=lf`) so a Windows checkout cannot change the vendored bytes; the `scripts/verify` shim must stay
executable.

## Troubleshooting

- **Codex quota or outage:** the PR is built, verified, opened and labelled `awaiting-review`;
  preflight warns up front. Once Codex works again, ask for the review to be run again on that PR (`P state show --pr N` restores its review state).
- **`model-proof` failed** (the arbiter or judge transcript doesn't show the pinned model or
  effort): the disputed items go to `needs-human`. Check that the agent files in
  `~/.claude/agents/` still pin `model:` (`./install.sh --check`), that nothing passed a `model`
  override, and that the model is available on your plan (an invalid model fails with
  `model_not_found`; it never silently falls back).
  With `owner_approval: chat` Claude now decides those items itself and records why (`pipeline triage claude-ruling`): a dismissal of a BLOCKING or security item, or any REJECT, needs a Codex
  second review that also dismisses it at high confidence, and every such dismissal is shown to you in a Rulings block above the merge request, so your "merge" covers it. You are not asked to type a ruling.
  If you want to dismiss something Claude or Codex would not, say so: the typed path stays as the override (`pipeline triage owner-ruling`; it asks with a `⚖️ Owner ruling needed` line, your whole answer
  is recorded on this machine and must be only the decisions, `R1-B1: accept` / `follow-up` / `reject` per item, reasons in another message; it is published in the triage comment). Then remove `needs-human`.
- **Installer refuses** "inside a Claude Code session": run it from your own terminal.
- **Repo moved / transferred?** Your earlier "merge", ruling and `extra round` records name the old repository, so `P review-complete` / `P merge` can say an owner grant "cannot be verified". In your own terminal (not in Claude Code) record the move once; GitHub must confirm it, and only records made before the move then count for the new name:
  `node ~/.claude/pipeline/bin/pipeline.mjs repo-move --from ianjamila/eaglewatch --to eaglewatch-ph/eaglewatch --at 2026-11-09T06:58:25Z` (`repo-move --list` shows what is recorded).
- **`--check` reports drift:** someone edited an installed file (or an install did not finish); run `node ~/.claude/pipeline/bin/pipeline.mjs update`, or re-run `./install.sh`.
- **A merge didn't happen:** `P merge` prints its refusal `reasons`, which say which check failed
  (head moved, a required check not green, a hard-stop or test-integrity item, a blocking label,
  a pause or rollback issue; `.review/final-gate.json` only exists when `P final-gate` was run).

## Developing this repo

```sh
npm test                          # node:test, no dependencies (node scripts/test.mjs [name-filter…])
node scripts/verify.mjs           # the pipeline's own verify; writes .verify/report.json
node pipeline/bin/pipeline.mjs --help
```

CI (`.github/workflows/ci.yml`) runs the suite on Ubuntu (Node 20 and 24) and Windows (Node 24),
plus an installer round trip into a throwaway Claude home with a space in its path. Its job names
`test (ubuntu)` and `test (windows)` are this repo's required checks. The Windows suite runs as three
parallel shards (`node scripts/test.mjs --shard I/3`, named `test (windows 1/3)` to `3/3`); `test (windows)`
is the aggregate that is green only when all three succeeded.

The repo is onboarded to itself (`.claude/pipeline.yml`) with **every path a hard-stop**, so a
change to the pipeline never auto-merges: the review skill builds, checks and reviews it, then hands you a
`needs-human` PR. `scripts/verify.mjs` is the project template with only its steps changed;
`test/self-verify.test.mjs` fails if the two drift.
