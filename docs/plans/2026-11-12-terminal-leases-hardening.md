# Terminal leases + lease hardening (#249, #258, #259, #260, #268)

Owner go 2026-11-11: #249 with #258/#259/#260 folded into ONE hardening PR (design change: plan → Codex plan review high → one Fable
plan pass → build through the review skill). #268 folded because it is small. Base: origin/main 4ab8df4.
Risk: high (pipeline core: review leases, admission, the installer's live-work scan, concurrency with the scheduled update).

Revision 3 (after the Codex plan review + its one recheck, 2026-11-12). Resolved in the recheck: P2-4 (verify slot --run), P2-5
(cut before escape), P3 (structured liveJobIn). Still open after revision 2 and answered here:
- **Missing evidence never means dead** (recheck P1-1, first-pass P1-1/P1-2): the heartbeat is DROPPED. A process lease is dead only
  on positive evidence (its pid is gone or was reused, read from `ps`); when `ps` cannot answer, or the pid was never known, the lease
  is UNCERTAIN: it blocks (an `unchecked` entry → a scan-error), the sweep keeps it, whatever its age. The owner's way out is in
  the notice. No TTL applies to a process lease at all.
- **Older readers fail closed by construction** (first-pass P1-2): a process holder file is `version: 2`. Every existing reader
  (`readHolder` requires `version === 1`) reports it `unreadable`, which counts as LIVE and which the old sweeper never touches.
  The only older reader that can meet one is an older installer after a deliberate rollback: it then defers until the file is
  closed by its process or removed by hand (fail closed).
- **Children are not tracked** (first-pass P1-3, recheck P1-2/3/4): the lease protects PIPELINE code in use, i.e. processes that
  load files from the install. A Codex run or a verify step that outlives a killed CLI loads nothing from the install (Codex is its
  own binary, verify steps run the repo's own commands), and its result is already orphaned (the CLI that would read it is gone),
  so an update cannot harm it. Every child that DOES load the install is a `pipeline` CLI process and takes its own lease (a job's
  `codex-review`, a nested `pipeline.mjs` call), under admission. Detached `P job` children stay covered by the job rule. This is
  the threat model #249's arbiter ruling describes ("a running command has already loaded its static module graph"), stated
  explicitly in docs/cli.md.
- Recheck P3 (transitive installer): the invariant is narrowed to "nothing in the admission interval runs a LEASED command",
  tested against the schedule helpers' configured commands as well as a static search.

Out of this PR, with reasons:
- **#270** (queue mode runs a stale branch's merge script): open PR #242 (another session, round 10) already changes the same
  `merge` / `update-branch` queue paths for the pre-switch case. Folding would collide with an in-flight high-risk PR (rule 5d).
  After #242 merges, #270 is re-scoped against it (likely option 2: run `merge.command` from the base tip).
- **Wallboard "reviews running now" panel**: lives in `~/Claude/command-centre` (another repo). This PR adds the data feed it needs
  (`pipeline leases`, step 4); the panel is its own small PR there afterwards.

## The problem (#249)

`resolveHolder` returns `{ kind: 'none' }` for a process with no Claude Code ancestor and no `CLAUDECODE=1`, and
`openOrRenewLease` / `closeLease` then return `{ skipped: 'no-session' }` BEFORE `withAdmission` (review-lease.mjs ~425). So a
`pipeline codex-review` (or any of the 19 leased commands) started from a plain terminal:
1. never checks admission: it starts even while `install.mjs --require-no-live-reviews` holds admission and is swapping files;
2. leaves no live-work record: the codex call runs outside the per-PR state lock (taken only to apply results,
   codex-review.mjs ~355) and outside a `P job`, so `scanLiveWork` sees nothing and a scheduled update can swap the pipeline
   under it. The harm is bounded (the static graph is loaded) but real for the dynamic imports and for anything the command
   spawns later (`node …/pipeline.mjs` children, vendored scripts).

## Design: a process-scoped holder

### Holder (review-lease.mjs `resolveHolder`)
No Claude ancestor AND `CLAUDECODE !== '1'` ⇒ `{ kind: 'process', sessionId: 'proc-<pid>-<8 hex>', pid: process.pid, pidStart }`
instead of `none`.
- `pid` is ALWAYS recorded (revision 4). `pidStart` = `psStarts([process.pid])` for this very process; `ps` unavailable (Windows,
  sandbox) or its answer not listing our own pid ⇒ `pidStart: null` (see revision 4 for how such a lease is judged).
- The id is computed once per process and memoised (module-level, keyed on `process.pid`), so the close of the same command finds
  the same file. `<8 hex>` is random: two commands never share a file, even with a reused pid.
- `kind: 'none'` remains only for an injected test seam; production never returns it.
- `holderHandoff` gives nothing for a process holder (a job's child is a plain process too and derives its own process holder).

### File shape (older readers fail closed)
A process holder file is `{ version: 2, holder: 'process', sessionId: 'proc-…', pid, pidStart, command, leases: { <worktree>:
{ repoId, pr | branch, generation, openedAt, renewedAt, command, jobOnly? } } }`. `readHolder` accepts `version: 1` (session / TTL
holders, unchanged) and `version: 2` only with `holder: 'process'` and a `proc-` id (anything else stays `unreadable` = live).
Every reader before this PR rejects `version: 2` as unreadable, i.e. LIVE, and its sweeper never touches an unreadable file.
Session holders (version 1) gain an optional per-lease `command` (the last command that renewed), which old readers ignore.

### Judge (`makeJudge().lease`) for a process lease
- `ps` answers and the pid runs with the recorded start ⇒ LIVE (`terminal process <pid> running pipeline <command> since
  <openedAt>`), whatever its age.
- `ps` answers and the pid is gone, or runs with another start (reused) ⇒ dead (then the existing job rule: a detached job still
  running in the worktree keeps it live).
- `ps` cannot answer, or the lease has no pid (`ps` failed when it was opened) ⇒ UNCERTAIN: live, `unchecked: true`, why
  `cannot confirm that terminal process <pid|unknown> (pipeline <command>) has ended: <ps unavailable | no process id recorded>`,
  `hint: 'delete <file> if no pipeline command is running in a terminal'`. Never dead by age. The sweep keeps it.
- No TTL for process leases. (Session and TTL-only holders: unchanged.)
`scanLiveWork` maps every `unchecked` lease entry (this one and #259's) to `kind: 'scan-error'`, so the 24-hour notice says
"could not check … Fix that, or …" and the hint travels as its own field (#258). On macOS / Linux (the only platforms the scheduled
update runs on, update-schedule.mjs) `ps` is present, so an uncertain lease needs a transient `ps` failure or a process opened
while `ps` failed; on Windows a killed command's leftover file is uncertain until removed, which only matters to a manual
`--require-no-live-reviews` install there.

### Lifecycle (review-lease-wiring.mjs + bin/pipeline.mjs)
- `holdReviewLease` opens the process lease exactly as a session's: under admission (bounded wait ⇒ exit 2 `update-in-progress`,
  the command does not run) and the per-file lock, recording `command: name`.
- `settleReviewLease`: a process lease is closed after EVERY leased command, whatever its result (not only `summary` / `ended`).
  `main()` calls it from a `finally`, so a command that throws closes too. The close names its generation (unchanged).
- A `process.once('exit')` handler, registered right after the open, does the same close SYNCHRONOUSLY for paths that skip the
  `finally` (`process.exit` in hold.mjs installRestoreOnSignal on SIGINT/SIGTERM during merge; any future `process.exit`). It takes
  no lock: the file belongs to this process alone; the only other writer is the installer's sweep, which re-judges under its lock
  and at worst writes back a lease whose pid is still running at that instant, judged dead (and swept) once the process is gone.
  The `finally` close unregisters the handler. `verify slot --run` also returns a silent result with its exit code (cli.mjs
  emitter) instead of calling `process.exit` (P2-4).
- `closeLease`'s rule "a job still runs in the worktree ⇒ keep as `jobOnly`" applies unchanged (the sync close too): a
  plain-terminal `P job start` leaves a job-scoped lease that dies with the job, which also covers a job in a repo the registry
  does not know.
- SIGKILL leaves the file: the judge reads it dead once `ps` shows the pid gone, and the installer's `sweepDeadLeases` removes it.
- Session holders are unchanged, except that they now also record `command`.

### Concurrency with the scheduled update
- Lock order is unchanged: installer: install lock → admission → per-file; command: admission (brief, open only) → per-PR state
  lock → floor. Closes take only the per-file lock (as today); the synchronous exit-handler close takes none (Lifecycle).
- Race 1, command first: its lease file is written under admission before the installer can take admission; the installer's scan
  (under admission) sees it live (pid running) ⇒ defers.
- Race 2, installer first: the command waits ≤ `ADMISSION_WAIT_MS` (20 s) then refuses with `update-in-progress`; nothing ran.
- Race 3, close while the installer sweeps: they serialize on the per-file lock and the sweep re-judges under it (today's rule); a
  live process is never swept (its pid runs), so a close always finds its own lease.
- Nothing the installer runs while holding admission may run a LEASED command (it would wait on itself). A plain-process child of
  the installer would now TAKE a lease (before: skipped), so this becomes a real hazard. Today the admission interval (sweep, scan,
  doInstall, doCheck) spawns nothing (`install.mjs` / `installer.mjs` contain no spawn/exec); the schedule helpers it may (re)write
  configure `update --scheduled` and `queue-sweep`, both unleased, and only load them into launchd / cron (the job runs later, not
  under admission). Step 1 pins it: a static search for spawns in both files, plus a unit assertion that every command the schedule
  helpers configure is NOT in `LEASED_COMMANDS`. No opt-out env var is added (an agent could set it to skip admission).
- A command that waited for admission and then ran after a swap still runs with the old static module graph (pre-existing, same for
  session holders). Out of scope; noted as a follow-up suggestion.

### What changes for the owner
A leased command typed in a plain terminal during an update now waits up to 20 s and then refuses with
"pipeline update in progress, retry in a minute"; a command whose install changed while it was starting refuses with
"retry" (revision 4, R4-5). Each such command writes and
removes one small file in the protected lease folder. The scheduled update defers while a terminal `codex-review` runs. If a
terminal command's end cannot be confirmed (`ps` failing), the update waits and the 24-hour notice names the file to delete.

## Revision 4 (Fable plan pass, 2026-11-12) — these items OVERRIDE anything above that conflicts

Fable verdict: READY WITH CHANGES; (a) no-TTL/uncertain, (b) version 2, (c) untracked orphan children all hold; Codex recheck items
1–4 and P3 closed. Wording fix for (c): the processes that load the install are LEASED pipeline commands, plus accepted-unleased
ones (unleased `pipeline` commands, `job-runner.mjs`, which is covered by the job rule); none is harmed by a swap mid-run.

- **R4-1 (P1) banner built by budget.** The 24-hour notice (and the "deferred N runs" notice) is composed as head + action + cause:
  the head (`pipeline update to <sha> has been waiting more than 24 hours:`) and the ACTION are reserved first, the cause gets the
  remaining budget of `BANNER_MAX` (cut with `…`, never inside the action). Action = every hint whole when they all fit, else the
  fixed pointer `run: pipeline leases (or see <status file>)`. stderr / the notices log carry the whole uncut text with every hint.
  Test: a real `scanLiveWork` uncertain lease with a real lease path and a long worktree ⇒ the osascript argument (unescaped)
  contains the whole hint or the whole pointer, and never a cut path.
- **R4-2 (P2) dead evidence and Ctrl-C.** `pid` is always recorded. Dead = `ps` shows the pid gone or reused, OR
  `process.kill(pid, 0)` throws ESRCH (the `locks.mjs` isPidAlive precedent): the second source works without `ps`, so a Windows /
  no-ps leftover is dead once its pid is gone. Alive by `kill(pid, 0)` but no start time (no `ps`, or `pidStart: null`) ⇒
  uncertain (pid reuse cannot be excluded). Signals: at open, for each of SIGINT / SIGTERM / SIGHUP that has NO listener yet, add
  one that closes synchronously and then, if it is still the only listener, removes itself and re-raises the signal (default
  death, same exit status as today); if the command installed its own handler meanwhile (hold.mjs installRestoreOnSignal), that
  handler's `process.exit` reaches the `exit` close. Tests: Ctrl-C (SIGINT) of a running CLI ⇒ file gone, exit status 130 /
  signal unchanged; SIGKILL ⇒ dead by ESRCH even with `ps` stubbed away.
- **R4-3 (P2) `jobOnly` files bounded.** A process holder's close that must keep a job-scoped lease MOVES it into one shared
  `job-<16 hex of the canonical worktree>` version-2 file (`holder: 'job'`, no pid; judged by the job rule only), under that file's
  per-file lock, and removes its own `proc-*` file. One file per worktree whatever the number of terminal commands. The `finally`
  close of a process holder also sweeps dead `proc-*` files (sweepDeadLeases restricted to `proc-` / `job-` holders; per-file lock
  only, never admission; failures are a stderr warning).
- **R4-4 (P2) judge order.** For every holder kind: `jobOnly` (and `holder: 'job'`) leases go to the job rule ONLY, first (as
  review-lease.mjs:303 does); the process rules apply only to non-jobOnly process leases.
- **R4-5 (P2) `ps` canary + mid-swap start.** (i) Every `psStarts` query made by the judge or the holder includes the asker's own
  pid; if it is not listed, `ps` counts as unavailable (a `ps` that rejects `-o lstart=` exits 1 with no output, which today reads
  as "none run"). (ii) `bin/pipeline.mjs` reads the installed identity (`INSTALLED.json`, installed copy only) BEFORE importing the
  command module and again after the lease is held; a change ⇒ exit 2 `updated-while-starting` ("the pipeline was updated while
  this command started; nothing was changed; retry"). Applies to every leased command (session holders too); closes the
  pre-existing gap noted under Concurrency.
- **R4-6 (P2) tests.** `test/helpers/no-claude-session.mjs` + the installed-copy test (`test/cli-review.test.mjs` ~2466, `arbiter
  apply`): an installed copy ignores the lease-dir seam, so under this plan that test takes a real, momentary process lease and
  real admission in the account folder. Keep that (no env opt-out); assert the account folder holds no `proc-*` file of the test's
  pid afterwards; document that it waits ≤ 20 s if a real update holds admission. `review-lease-wiring.test.mjs`
  `world({ session: false })` cases that assert "no files" are rewritten for process leases. Platform-dependent cases (`ps`
  present / absent) branch on the platform or stub `ps`, so Windows CI asserts the ESRCH path.
- **P3s, all in scope:** v2 process / job files record `host` and `machineId` (readMachineId); a holder from another host /
  machine is uncertain (never judged by local `ps`). An unreadable `proc-*` / `job-*` file is a scan-error with the same delete hint.
  `settleReviewLease` in the `finally` tolerates `result === undefined` (a throw), and the exit / signal handlers are unregistered
  only after a successful close. #258 skew, common direction (new installer → old installed `normalizeLive`): the scan keeps the
  legacy text `…: remove .review/jobs/<name> in that worktree if it is stale` inside `detail` AND sets `hint`; the new
  `normalizeLive` strips that suffix from `detail` when `hint` is present, the old one keeps behaving as today. #259: a THROWING
  `jobLive` (`review-lease.mjs:319` and `:497`) maps to `{ unreadable: 'error' }` (fail closed), not `false`. Docs: a plain
  process that cannot write the lease folder (read-only home) now gets exit 2 `review-lease-unwritable` on leased commands.

## #259: an unreadable jobs folder

- `liveJobIn(worktree)` returns `true | false | { unreadable: <code> }`: the object for any readdir error other than ENOENT /
  ENOTDIR (P3: the code travels with it).
- ENOTDIR aligned in BOTH places as "no jobs": a job needs `.review/jobs/<name>/` (jobs.mjs creates it with mkdir; it cannot exist
  under a non-directory). `live-work-scan` `jobsIn` stops reporting ENOTDIR as a scan-error. (Every other error stays fail-closed.)
- Judge: `{ unreadable }` keeps the lease live with a distinct reason `…; the jobs folder <dir> cannot be read (<code>), treated as a
  running job` and sets `unchecked: true` on the verdict; `entryOf` and `blocking` carry it.
- `scanLiveWork` maps an `unchecked` lease entry to `kind: 'scan-error'` (detail: `cannot judge the review lease of <session> on
  <worktree>: the jobs folder cannot be read (<code>)`), so the 24-hour notice says "could not check … Fix that" instead of
  "Finish or close them", and `onlyScanErrors` is true when that is the only blocker.
- `closeLease` treats `{ unreadable }` as a running job (keeps the lease `jobOnly`, fail closed) and says so: `{ closed: true,
  jobRunning: 'unknown' }`; the sweep keeps it (unchanged). Once the folder is readable again the normal rules clear it.
- Integration test: one unreadable jobs folder through close, sweep, `scanLiveWork` and `onlyScanErrors`.

## #258: the remove hint as its own field

- `live-work-scan` `jobsIn` returns `{ detail, hint? }`; an unreadable job record gives detail `job <name> has an unreadable record
  (<why>), treated as running` and `hint: 'remove .review/jobs/<name> in that worktree if it is stale'`. The scan entry carries
  `hint` as its own field.
- `auto-update` `normalizeLive` keeps `hint` whole (never cut: a cut folder name can be another real folder; > 300 chars ⇒ dropped)
  and `detail` capped as today. `REMOVE_HINT` stays only for the skew case below.
- `describeLive` never includes hints. The 24-hour notice appends the hints only when the whole message WITH them fits
  `BANNER_MAX` (240, exported from queue-sweep.mjs) measured on the display text; otherwise it appends `(details in <status file>)`.
  The stderr / log line always carries the whole text; the status file's `deferredBy` keeps every hint whole.
- P2-5: `queue-sweep` `appleText` cuts the flattened DISPLAY text to `BANNER_MAX` FIRST and escapes afterwards (today it escapes and
  then cuts, so quotes / backslashes push a fitting message over the cut). Test the real osascript argument (injected `spawn`) with
  boundary-length messages containing quotes and backslashes: the unescaped banner text equals the whole message or the hint-free one.
- Version skew: an older downloaded installer emits only `detail` with the hint inside it. `normalizeLive` (installed side) moves a
  trailing `: remove … in that worktree if it is stale` (the exact old template, `REMOVE_HINT`) from `detail` into `hint`, so either
  producer works.
- Tests drive `normalizeLive` / the notice from REAL `scanLiveWork` output (a worktree with an unreadable job record), not a
  hand-written copy.

## #260: test race

`test/review-lease-jobs.test.mjs`: read `<name>.txt` only after the existing wait for `exit.json` (one-line reorder).

## #268: follow-up issue scan times out

`github.mjs` `listIssuesByCreator({ creator, state, since })`: `per_page=100` (was 30), optional `since=<ISO>` and its own
timeout of 180 s for this one paginated call (other calls keep 60 s). `followups create` passes `since` = the PR's `createdAt`
(one `gh pr view N --json createdAt` call) minus 1 h, as UTC ISO: a follow-up issue for PR N is created after the PR exists, so
its `updated_at` ≥ that bound; promoted (relabelled) or closed issues are still seen. A missing / unparsable `createdAt` or a failed
view ⇒ no `since` (today's full scan). Tests (stubbed `gh`): args (`per_page=100`, `since`), invalid timestamp ⇒ full scan, UTC
conversion, dedupe still finds an earlier issue for the PR, a failed page mid-pagination ⇒ the existing error (nothing filed twice).

## Step 4: `pipeline leases` (data feed for the wallboard panel)

A new read-only command, NOT leased: `pipeline leases [--all]` prints `{ ok, live: [...], unreadable: [...], dead?: [...] }`
from `scanLeases`: per entry holder kind (`session` | `ttl` | `process`), sessionId, worktree, repoId, pr / branch, command,
pid (process holders), openedAt, renewedAt, why, unchecked, hint. Exit 0 when the folder could be scanned (1 when the scan itself threw). No writes,
no sweep. docs/cli.md + README "Automatic updates" document it; the wallboard panel (separate PR in command-centre) polls it.

## Steps (implementer tasks; each with failing-first tests)

1. **Process holder** (review-lease.mjs, review-lease-wiring.mjs, bin/pipeline.mjs, verify.mjs slot exit): holder, version-2
   file, judge (live / dead / uncertain), close in `finally` + sync `exit` handler, `command` field. Tests: resolveHolder plain
   process (with/without ps); open under admission; admission held ⇒ `update-in-progress` and the command did not run (spawned
   CLI with `PIPELINE_REVIEW_LEASE_DIR` + held admission); lease live while the CLI runs, gone after a normal exit, after a usage
   error, after a throw, after `process.exit` (exit handler), after `verify slot --run` (pass and fail, stdout and exit code
   unchanged); SIGKILLed CLI ⇒ dead once the pid is gone, swept; a running pid with `renewedAt` days old (and a clock set forward)
   ⇒ live; `ps` unavailable / no pid ⇒ uncertain: live, `unchecked`, scan-error with the delete hint, NOT swept at any age;
   reused pid ⇒ dead; job running at close (both closes) ⇒ jobOnly; the judge + sweeper of 4ab8df4 (copied as a test fixture) on a
   version-2 file ⇒ unreadable, live, untouched; installer admission interval runs no leased command (static + schedule
   helpers); existing tests that asserted `skipped: 'no-session'` updated.
2. **#259** (review-lease.mjs, live-work-scan.mjs) + **#258** (live-work-scan.mjs, auto-update.mjs, queue-sweep.mjs) + **#260**.
3. **#268** (github.mjs, followups.mjs).
4. **`pipeline leases`** (new command, docs).
5. Docs: README "Automatic updates", docs/cli.md lease paragraph + the plan-B note ("a plain terminal writes no lease" ⇒ the new
   rule, the uncertain verdict and its hint, the threat model for orphaned children, the rollback behaviour), CHANGELOG if present.

Quick check (`node scripts/verify.mjs --quick`) after each step; CI runs the suite (Linux + Windows).

## After merge

Owner updates the install; then rerun `pipeline followups create --round 6` in EW worktree `agent-browser-runner-2404` for
#1760's R6-F1 (keep that worktree until then). Then the command-centre panel PR, then #270 after #242.
