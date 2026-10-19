# Spec — automatic stop of private Supabase stacks (2026-10-19, rev 5)

Owner request 2026-10-19 (re-entry prompt in [[supabase-stack-autostop]]). Owner decisions: `/clear` keeps stacks
(stop only when the Claude process exits) · sub-detachments: leave it, owner found by backfill · CLAUDE.md
never-stop list names `eaglewatch-pipeline` (applied) · dev servers: session-end stop of the session's OWN server +
report-only listing of orphans · **code lives in `ianjamila/claude-pipeline`** (owner 2026-10-19; the short-lived
`claude-machine-tools` repo/PR #1 was closed), shipped with `ship`, installed by the pipeline's own installer ·
**F1 policy: measure first** — everything runs in
report mode with near-miss tracking; the owner switches stopping on after reading 7 days of numbers.

Review history: Codex R1 (9 findings) → rev 2 → Codex recheck (5 resolved; F1–F7 open/new) → rev 3 → Fable final
pass ("ready with fixes": P1 pause contradiction, install-from-worktree hazard, near-miss classification; P2 dev
ancestry re-walk, file-tool block; P3 a–j) → rev 4 (all folded in) → rev 5 (this: home moved to claude-pipeline — installer copies, `P stacks` command, machine config, weekly-report include; safety rules unchanged). Codex session
01a15213-80de-7d11-a002-0204cf9e1fa6. Review cap reached: no further review rounds on the spec; the code gets its
own Codex review inside ship.

## Goal
Private stacks stop by themselves once nobody needs them. Shared stacks are never touched. Nothing is deleted
(`supabase stop` keeps the data volume; `supabase start --workdir X` restarts it with its data). Anything that cannot
be proved unused is listed for the owner, never stopped. Because observation cannot prove non-use against every
possible consumer (Codex F1), stopping starts switched off and is enabled only on measured evidence.

## Hard rules (enforced in code, tested)
- **Shared, never stopped:** project_id `e2e-ci`, `DRMed`, `eaglewatch-pipeline`, any project_id ending `-pipeline`,
  any workdir under `/.verify/supabase-workdir`.
- **Fail closed everywhere.** Every probe returns `ok | unknown`; a failed, timed-out, partial or unparsable result
  (ps, lsof, docker, gh, ledger, memory notes, transcripts) is `unknown`, and `unknown` on any required check ⇒ keep +
  report. One damaged ledger line ⇒ the whole ledger is `unknown` ⇒ nothing is stopped that run.
- **Target binding (immediately before each stop, under the project lock):** all must agree, else keep:
  `realpath(workdir)` == the running db container's `com.supabase.cli.workdir` label (realpath'd) == the workdir
  assessed; `project_id` read NOW from `<workdir>/supabase/config.toml` == the container's `com.supabase.cli.project`
  label == the project assessed; that project is not shared; container Id and `State.StartedAt` == the ones assessed
  (a restarted container is a new generation ⇒ reassessed next run). **A stack whose workdir no longer exists is
  report-only** (binding cannot be proved); there is no `--project-id` fallback.
- The only stop command ever run: `supabase stop --workdir <realpath>`. Never bare `supabase stop`, never
  `--project-id`, `--all` or `--no-backup`, never `docker rm|stop|volume rm`.
- After a stop: db container not running AND the project's data volume still present, both logged; a failure is
  reported, never retried in a loop.
- Process identity = `{pid, birth}`; birth = epoch seconds from `ps -o lstart=` run with `TZ=UTC LC_ALL=C` (same env in
  hooks and launchd). Event times are UTC ISO instants. Unparsable birth/time ⇒ `unknown`.
- **One root for all state and settings:** `PIPELINE_STACKS_HOME` (default `~/.claude/pipeline-state/stacks/`) holds the
  machine config (below),
  ledger, locks, mode file, keep list, pause file, logs and the latest report. A non-default `PIPELINE_STACKS_HOME` REQUIRES
  `PIPELINE_STACKS_ONLY` (comma list); the code refuses to assess or stop any other project then (smoke isolation).
- **Modes** (`<PIPELINE_STACKS_HOME>/mode.json`): `sessionEnd`, `sweeper`, `devServers`, each `report` or `apply`; missing
  or unreadable ⇒ `report`. Install writes all three as `report` and never changes an existing file. Pause:
  `<PIPELINE_STACKS_HOME>/pause`. Keep list: `<PIPELINE_STACKS_HOME>/keep` (one project_id per line, `#` comments; unreadable ⇒
  `unknown`).
- **Pause is checked by every stop path** (session-end, sweeper, dev servers) under the project lock right before
  acting; paused ⇒ nothing is stopped. While paused, registration is best-effort (a failure logs and exits 0), so
  pause is a working escape hatch when registration itself is broken.
- The shared list is compared case-insensitively.
- **Machine config** `<PIPELINE_STACKS_HOME>/config.json` (the pipeline has no machine-level config yet; per-repo
  `pipeline.yml` is the wrong place because stacks are machine-wide): `shared` (extra shared project ids — on this Mac
  `e2e-ci`, `DRMed`, `eaglewatch-pipeline`), `repos` (repo roots whose worktrees are scanned), `memoryDirs`,
  `transcriptDirs` (default `~/.claude*/projects`), `devPorts` (default `[3000, 4000, 4017]`), `memoryExclude`.
  Built in and not removable: any project id ending `-pipeline`, any workdir under `/.verify/supabase-workdir`.
  **Config missing or invalid ⇒ the feature is inert:** registration still records (cheap, harmless), nothing is
  assessed as stoppable, the report says "not configured". So a machine that installs the pipeline (the PC) gets no
  behaviour change until its owner writes a config. `P stacks init` writes this Mac's config only when asked, and
  prints it for review.
- Windows: hooks exit 0 at once (no-op); the CLI says "not supported on Windows". macOS and Linux paths are tested on
  every CI OS through injected `platform`, as worktree-prune does.

## Consumers: who counts as using a stack
A stack is in use if ANY holds (all sources evaluated together):
- **C1 Ledger lease:** a live Claude process registered a use (component 1). Never revoked by command text; a lease
  ends only when its `{pid, birth}` is dead.
- **C2 Live connections:** an ESTABLISHED TCP connection from any host process to any published host port of the
  project's containers (port bindings of every container labelled with the project; `lsof -nP -iTCP
  -sTCP:ESTABLISHED`, matched on the `->host:PORT` client side).
- **C3 Live process references:** any process (other than the autostop worker itself) whose command line OR
  environment (`ps -axE -ww`, verified to work for this user's processes on this Mac) names the stack folder, a
  container name of the project (`supabase_*_<project>`), the project_id as a whole word, or one of its published
  ports as `:<port>`; or whose cwd is inside the stack folder.
- **C4 Consumer worktrees:** every worktree that (a) a ledger event or transcript backfill ties to the stack, or
  (b) has a `.env*` file at its root pointing at one of the stack's published ports (`127.0.0.1:<port>` /
  `localhost:<port>`). A live process with cwd inside a consumer worktree ⇒ in use (session-end); an existing consumer
  worktree with an open PR or no PR ⇒ in use (sweeper).
- **C6 Recent transcripts (sweeper only):** a transcript modified in the last 24 h names the stack folder/project.
Other users' processes (R3-1): their real use of a stack is covered by C2 (server side) and by C3's command line; their environment and cwd/open files cannot be read without root, so those checks see this user's processes only (reports show `hidden: N`).
(Kong/Postgres traffic mining is dropped from the gates — Codex's P3 simplification; it may come back as a report
column later.)

## Components

### 1. Register hook — `pipeline/hooks/stack-register.mjs` (PreToolUse, matchers `Bash` and `Read|Edit|Write|Grep|Glob|NotebookEdit`; runs BEFORE the tool)
- **Dispatch first, then filter:** dev-server patterns (`next dev|next start|npm run dev|npm run start|npm start`,
  `-p/--port/PORT=`, default 3000) are recorded before any stack filtering. Stack prefilter: Bash text matching
  `supabase|\.stack\b|psql|docker exec|:\d{4,5}\b|SUPABASE|PG[A-Z]+=` OR a file-tool path inside any `*.stack` folder
  or `supabase/` folder, OR any whole-word match of a project_id from the inventory cache (the cache is read first;
  reading it is cheap). No match ⇒ exit 0.
- Inventory: private stacks from `docker ps`/`inspect` (workdir, folder, container names, published ports), cached
  ≤ 60 s under `PIPELINE_STACKS_HOME`.
- Registers the session for EVERY private stack the input names in any way (workdir resolved against the hook cwd and
  any `cd` in the text, folder name, project id, container name, published port; bare `supabase <cmd>` by upward
  `supabase/config.toml` search; file-tool paths inside the stack folder). Over-matching only adds leases.
  `supabase start --workdir X` for a stack not running yet registers by folder; the lease applies once a container
  with that workdir label exists.
- **Fail closed for required registration:** once the prefilter matched and the input targets (or may target) a
  private stack, ANY failure — inventory unknown, owner `{pid, birth}` not found, lock not acquired, append failed —
  exits 2 with "autostop could not register use of stack X (<reason>) — retry; pause with touch
  <PIPELINE_STACKS_HOME>/pause" (plus the lock path when the lock is the reason). Internal deadline 20 s; hook timeout 30 s (a
  timed-out PreToolUse hook does not block, so the internal deadline is what makes it fail closed). Paused ⇒ still
  registers, but any failure logs and exits 0. A definitive "cannot connect to the Docker daemon" means no stack can be
  running ⇒ exit 0 + log; only a timeout or partial docker result is `unknown` ⇒ exit 2. Inputs that cannot target a
  private stack (prefilter miss, or only shared stacks named) ⇒ exit 0 without a lease.
- Prefilter uses the inventory cache even when stale; it refreshes the cache only after a prefilter hit.
- Owner lookup: walk the parent chain to the nearest process whose command is `claude` (a nested headless `claude -p`
  resolves to the inner one); none found ⇒ owner `unknown` ⇒ exit 2 when a private stack is targeted.
- `worktree` field = the git worktree containing the cwd, or `none` when the cwd is not inside a worktree (e.g. `~`);
  `none` never becomes a consumer worktree (such a lease still counts under C1 while its owner lives).
- **Lock order:** takes the per-project lock (component 5) for the append. If a stop holds it, waits within the
  deadline. After acquiring, if the stack was stopped by autostop since the inventory snapshot and the tool is Bash
  and the command is not a `supabase start`, it blocks (exit 2; file tools are never blocked by this): "stack X was just stopped automatically (data kept). Run `supabase start
  -x studio,imgproxy,edge-runtime,logflare,vector --workdir X`, then retry." Only reachable in `apply` mode.
- Event: `{t, kind: "use"|"dev", project?, workdir?, folder?, port?, session_id, agent_id?, owner: {pid, birth},
  cwd, worktree, tool}` → `<PIPELINE_STACKS_HOME>/ledger.jsonl` (O_APPEND, one line < 4 KB). PostToolUse of the same
  tool_use_id adds `tPost` for dev records.

### 2. Dev-server binder — `pipeline/hooks/stack-dev-bind.mjs` (PostToolUse, matcher `Bash`)
- For this session's unbound dev records (≤ 10 min old, ≥ 3 s after launch): find LISTEN sockets on the port; bind
  `{listenerPid, listenerBirth}` only if the listener's process ANCESTRY (walked now) contains this session's claude
  `{pid, birth}`, its birth ∈ [tPre − 2 s, tPost + 60 s] and its cwd is inside the recorded worktree. A detached
  (re-parented) or foreign listener stays unbound ⇒ never killed, reported. One listener binds to at most one record.

### 3. Session-end hook — `pipeline/hooks/stack-session-end.mjs` (SessionEnd)
- `reason == "clear"` ⇒ nothing. Otherwise spawns a detached worker (`node <home>/pipeline/bin/pipeline.mjs stacks session-end
  --owner <pid>:<birth>`, `detached: true`, stdio to the log, `unref()`), writes its pid to
  `<PIPELINE_STACKS_HOME>/workers/`, returns at once.
- Worker waits ≤ 10 min for that owner to be gone; still alive ⇒ logs "session still running", decides nothing.
- Dev servers: for each listener bound to that owner (ancestry was proved at bind time; it cannot be re-walked once
  the owner is gone) that is still alive with the same `{pid, birth}` and cwd inside the recorded worktree ⇒
  `would stop` (report) / SIGTERM + 10 s check, never SIGKILL (apply). Every bound listener also gets a measurement
  row "still alive N s after owner exit" (Claude Code may already kill its background shells on exit; the numbers
  show whether this path matters).
- Stacks: for each private stack the owner leased, under the project lock, fresh binding + C1–C4: decision **stop**
  only if container running; not shared; workdir exists; not keep-listed; no live lease from another owner; no C2;
  no C3; no live process with cwd in any consumer worktree or the stack folder. `report` ⇒ logs `would stop`;
  `apply` ⇒ stops. Else logs `kept` + reasons; every C3 reason names the matching process (pid, command) and the
  field that matched (cmdline / env / cwd) so over-matching is visible.
- C4(a) at session-end uses the ledger and transcripts modified ≤ 24 h only (bounded scan).
- After deciding, the worker stays detached and re-probes C1–C3 for each `would stop`/`stopped` project at +30 min
  and +120 min (near-miss evidence, component 6), then exits.

### 4. Daily sweeper — `P stacks sweep [--apply]` (code in `pipeline/lib/stacks/`, command `pipeline/commands/stacks.mjs`)
Scheduled with `P stacks schedule --install [--at 09:12] | --remove | --status`, reusing worktree-prune's
`schedulePlist` / `applyLaunchd` / cron helpers (label `com.claude-pipeline.stacks-sweep`, `RunAtLoad` false, log
`<logdir>/cron-stacks-sweep.log`). Dry run unless `--apply` AND mode `sweeper: apply`. Pause file + a run lock
(`withLock('stacks-sweep', …, {waitMs: 0})`, second run = "already running"). Subcommands: `sweep`, `session-end`
(the worker), `status` (current leases, modes, last report path), `repair`, `init`, `schedule`.
For every running `supabase_db_*` container, verdict **stop** only if ALL hold (owner's 7 conditions, made precise):
1. not shared;
2. no live ledger lease (C1);
3. the consumer-worktree set (C4) is NON-EMPTY and EVERY member is gone or has a merged/closed PR with HEAD == PR
   head; empty set ⇒ owner unknown ⇒ listed. Folder names never identify owners. One `gh pr list --state all` per
   repo, fail closed;
4. no live process with cwd in any consumer worktree or the stack folder; no C2; no C3;
5. container up > 24 h (`State.StartedAt`, UTC; exactly 24 h is not > 24 h);
6. no memory note (`~/claude-memory/{home,eaglewatch,drmed}/*.md`, excluding `supabase-stack-autostop.md` and
   `MEMORY-archive.md`) names the project_id or the stack folder name; unreadable note ⇒ unknown;
7. not keep-listed;
plus: workdir exists (binding) and no C6. With `--apply` every condition is re-evaluated under the project lock
against the same container generation before the stop. Dev servers: report only (listener, pid, cwd/worktree,
uptime, bound owner alive?, worktree PR state, verdict `owned | orphan candidate | unknown`); never killed here.

### 5. Locking
Reuse the pipeline lock helper (`pipeline/lib/locks.mjs`: mkdir lock + exclusively published
owner.json, dead-pid / never-finished reclaim serialized by a guard dir, live pid never reclaimed), lock name
`stacks-<project>`, lock dir `<PIPELINE_STACKS_HOME>/locks` (passed as `dir`). Register holds it for the append (ms); stops hold it for final checks + stop + post-check
(≤ 60 s wait, else skip this stack this run).

### 6. Measurement (F1 policy) and reports
- Every `would stop` / `stopped` decision is logged to `<PIPELINE_STACKS_HOME>/actions.jsonl` with project, generation,
  reasons and the evidence summary.
- A `would stop` is recorded once per container generation (Id + StartedAt); later sweeps update its outcome instead of
  emitting a new one. Each records the benefit: memory of the project's containers (`docker stats --no-stream`) —
  "would have freed N GB".
- **Outcome of each would-stop**, classified on every later probe (worker re-probes at +30/+120 min, each register,
  each sweep):
  - **MISS** (the safety signal): a lease, C2 connection or C3 reference within 2 h from a process whose birth is
    BEFORE the would-stop time — a live consumer the checks missed. Logged with pid, command, and which check missed it.
  - **RESTART** (cost only, data kept): a new use within 2 h from a process born AFTER the would-stop time.
  - **CLEAN**: no use within 2 h; stays CLEAN-after-N-days while unused.
- Sweep report `<PIPELINE_STACKS_HOME>/report.md` (latest) headlines: MISS count (7 days, must be 0 to switch on), RESTART
  count, CLEAN count and total GB that would have been freed; any missing/dangling installed hook file; a damaged
  ledger (stopping disabled until `P stacks repair`, owner-run, moves the bad line to
  `ledger.bad.jsonl`); then stacks listed for the owner with blockers and dev-server rows.
- **Weekly worktree report:** every sweep also writes `<PIPELINE_STACKS_HOME>/weekly-section.md` (last 7 days:
  would-stops/stops, MISS/RESTART/CLEAN counts, GB that would be freed, listed stacks, dev orphan candidates, link to
  the sweep report). `~/.claude/scripts/worktree-autoclean.mjs` (not in any repo) gets a ~10-line read-only include of
  that file under "## Supabase stacks & dev servers" (missing file ⇒ one line "stack sweeper not installed"). That
  out-of-repo edit is made after the PR merges, its diff shown to the owner, backup kept at
  `~/.claude/scripts/.backup/worktree-autoclean.mjs.<date>`.
- After 7 days the owner reads the numbers; flipping a mode to `apply` is the owner's decision (a one-line edit of
  `mode.json`, done by Claude only when the owner says so).

### 7. Install, rollback — the pipeline installer
- The existing installer copies `pipeline/` into `~/.claude/pipeline` (staged, sha256-verified, manifest
  `INSTALLED.json`), so new `pipeline/hooks/stack-*.mjs` and `pipeline/lib/stacks/*` install with it; copies cannot
  dangle (Fable P1-2 is moot). Install refuses to run inside Claude Code unless `PIPELINE_ADMIN=1`: the owner runs it
  (`! node install.mjs` from the main checkout after merge, or a `PIPELINE_ADMIN=1` session), on the Mac and later
  the PC.
- Hook registration follows the installer's pattern: add `PostToolUse` and `SessionEnd` to `HOOK_EVENTS`; a
  fail-closed handler like `handlerFor` (an import failure exits 2) for `stack-register` (PreToolUse, matchers
  `Bash` and `Read|Edit|Write|Grep|Glob|NotebookEdit`, timeout 30) and plain non-blocking handlers like
  `sessionHandlerFor` for `stack-dev-bind` (PostToolUse `Bash`, timeout 10) and `stack-session-end` (SessionEnd,
  timeout 10); entries in `mergeSettings`, `removeOurSettings`, `inspectHooks`, `computeDrift`, `buildPlan`'s
  required list, uninstall's hook count and `formatReport`. Identified as ours by the `/pipeline/hooks/` path as today.
- Install never writes the machine config, the mode file or the schedule: `mode.json` is created all-`report` on
  first use if absent; `P stacks init` (config) and `P stacks schedule --install` are separate, owner-asked steps.
- Uninstall (`node install.mjs --uninstall`) removes the hook entries and files as today, and additionally touches
  `<PIPELINE_STACKS_HOME>/pause`, waits ≤ 2 min for workers listed in `workers/`, and removes the schedule; keeps
  ledger, logs, keep list, config and mode file; never touches stacks or volumes. Rollback = uninstall, or install an
  older commit.
- No worktree-autoclean replacement any more (the weekly report uses the include above), so the F6 restore problem
  disappears.

### 8. Docs
Header of `pipeline/lib/stacks/decide.mjs` holds the rules (pure verdicts; no fs, subprocess, environment or clock). The module set in `pipeline/lib/stacks/`: `paths` (state root, isolation), `config` (machine config, modes, keep list, pause), `result` (ok/unknown), `inventory` (Docker stacks), `identity` (process birth), `evidence` (ps/lsof probes), `match` (which stack a tool call names), `assess` (facts per stack), `decide` (verdicts), `act` (the only `supabase stop`), `ledger` (leases), `register` (register hook flow), `dev` (dev servers), `session-end` (hook and worker), `sweep` (daily sweep), `outcomes` (decisions log and reports), `uninstall` (pause and worker wait); repo README explains modes and the measure-first policy. Global
CLAUDE.md shared-stacks bullet gains one line only when a mode is switched to `apply`. Memory note
[[supabase-stack-autostop]] updated at each step.

## Testing
- **Unit (`node --test`, fake binaries via env `SUPABASE_BIN`, `DOCKER_BIN`, `LSOF_BIN`, `PS_BIN`, `GH_BIN`;
  `PIPELINE_STACKS_HOME` per test):**
  - register entry point (stdin JSON → exit code, ledger lines): relative `--workdir ../x.stack`, `cd` chains,
    `status -o env … > file`, `npx supabase`, port-only, container-name-only and project-id-only mentions, `docker
    exec -i supabase_db_x psql`, file-tool paths in a stack folder, quoted / `true || supabase stop` text (adds,
    never removes), bare `supabase start` in a worktree ⇒ e2e-ci ⇒ no lease, `npm run dev` / `npm start` / `next dev
    -p 4000` dev records; each failure (inventory, owner, lock, append) ⇒ exit 2; unrelated command ⇒ exit 0 and no
    I/O beyond the cache read.
  - verdicts, mutation-style: each of C1–C4, C6, sweeper conditions 1–7 and every binding field (workdir realpath,
    config project, label project, container Id/StartedAt, symlinked workdir re-pointed at an e2e-ci / DRMed /
    eaglewatch-pipeline config, missing workdir) flipped one at a time turns **stop** into **kept**.
  - fail closed: ps/lsof/docker/gh timeout, permission error, partial output with non-zero exit, truncated ledger
    line, unreadable memory note or keep list ⇒ `unknown` ⇒ kept.
  - identity: pid reuse with another birth is dead; TZ change keeps the same birth; exact-24 h boundary.
  - dev servers: listener not descended from the session (terminal-started), replacement before first bind, failed
    launch, pid reuse, detached listener ⇒ none bound/killed.
  - concurrency, both orders, with a test seam that pauses a stopper right after taking the lock: (a) stopper holds
    the lock → register waits → stop finishes → register gets the lock, sees "stopped by autostop" → exit 2 with the
    restart message; (b) register holds the lock first → stopper waits → its re-check under the lock sees the new
    lease → kept.
  - locks: simultaneous stale reclaimers, crash before owner.json, release after ownership changed (covered by
    the helper's own suite; one integration test here with the `stacks-` name).
  - fake argv log: only `stop --workdir <abs>`; never for shared; never `--project-id`, `--all`, `--no-backup`; no
    docker rm/stop/volume rm.
  - install (extend `test/install.test.mjs`): settings.json with foreign hooks incl. PostToolUse/SessionEnd entries:
    install → reinstall (no-op) → uninstall ⇒ foreign entries intact, ours added/removed, `--check` drift-free;
    installer-round-trip CI script covers the new hooks.
  - outcomes: use within 2 h by a process born before the would-stop ⇒ MISS; born after ⇒ RESTART; none ⇒ CLEAN;
    the same generation on the next sweep ⇒ one record updated, not a second would-stop.
  - pause: paused + broken ledger dir ⇒ register exits 0 and logs; paused ⇒ no stop on every path even when all
    checks pass; docker daemon down ⇒ register exits 0; docker timeout ⇒ exit 2.
  - "just stopped" block applies to Bash only, never to Read/Grep of the stack folder.
- **Real (Mac), isolated:** `PIPELINE_STACKS_HOME=<scratch>`, `PIPELINE_STACKS_ONLY=autostop-smoke`, modes in that home
  set to `apply`; the production `mode.json` stays `report` (checked before/after). Throwaway project
  `autostop-smoke` (`supabase start -x` all optional services); sentinel row seeded; headless `claude -p --model
  haiku` with `PIPELINE_STACKS_HOME` and `PIPELINE_STACKS_ONLY` exported. Before merge (inside ship verify evidence)
  the hooks come from `--settings <test settings>` pointing at the feature worktree (the installed pipeline has no
  stack hooks yet, so nothing runs twice); after the owner installs, the same run uses the installed hooks and NO
  `--settings` copy. It runs `supabase status --workdir <smoke>` and exits ⇒ SessionEnd ⇒
  detached worker survives teardown ⇒ stack stopped; `supabase start` again ⇒ sentinel row readable. Again with a
  second consumer holding a connection (`docker exec … psql` kept open) ⇒ kept. A second headless session that never
  touched the smoke stack exits during the test ⇒ no decision about any stack. kill -9 of a headless session ⇒ no
  SessionEnd ⇒ sweeper dry run (isolated home) sees the lease dead.
- **Real (Mac), production home, report mode, after the owner installs:** one Bash call naming a private stack ⇒ lease line;
  sweeper dry run on today's machine; expected: e2e-ci, DRMed, eaglewatch-pipeline = shared; sub-detachments = kept
  (consumer worktree sub-detachments-followups open, live process refs); sa-corrections = kept (consumer worktree
  sa-correction-requests open).
- The smoke stack's volume is left in place (never delete volumes) and reported.
- Interactive `/clear`, `/exit`, resume and terminal-close checks: listed for the owner to try once in report mode
  (each leaves a log line that says what was decided).

## Known limits
- Unregistered consumers that hold no connection, no env/cmdline reference and no cwd in a consumer worktree can be
  missed. Measure-first exists for this: near-misses show whether it happens before anything is stopped.
- A session that crashed while its worktree's PR is open keeps its stack until that PR is merged/closed (condition 3).

## Out of scope / later (owner to prune)
- Killing orphaned dev servers in the sweeper.
- Idle rule: stop a stack whose every lease is dead and that had no use for N days even if its PR is open.
- Kong/Postgres traffic as a report column.
- SessionStart hint "N stacks are listed for your decision".
- Auto-stopping idle stacks of live sessions.
- Same treatment on the PC.
