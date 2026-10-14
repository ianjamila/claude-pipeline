# `pipeline worktrees prune` — automatic cleanup of finished worktrees (design)

Status: rev 3 · 2026-10-13 · repo: claude-pipeline (generic; first user: eaglewatch)
Reviews: Fable (high) approve-with-changes on rev 1; Codex gpt-6-astra (high) review of rev 1 + one recheck of rev 2
("needs revision": 3 retained + 4 new findings). Rev 3 answers all of them (§11). Review budget spent — no further
Codex round; runtime validation is in §10.

## 1. Goal and why

Owner decision 2026-10-09 (memory `feedback-auto-remove-finished-worktrees`): *"i dont want to keep repeating to
remove them if they're not needed anymore."* Finished worktrees must disappear on their own; anything unfinished or in
use must never be touched. The decision named a follow-up — a `pipeline worktrees prune` command that ship runs — which
was never built, so worktrees piled up again (15 in eaglewatch, ~20 GB, on 2026-10-13).

**Guarantees (stated precisely):**
- **Latency:** a finished worktree is removed by the first run after its PR has been merged for `min_merged_hours` (24 h)
  — the nightly run or any ship Step 0/7 — so within ~48 h worst case, usually ~24–30 h.
- **Work is never lost:** commits are all on GitHub and the branch is kept; a worktree holding anything else (untracked
  or unknown ignored files) is kept. Review/verify evidence of a removed worktree is kept in the holding folder for
  30 days, then purged — that retention is deliberate (the owner's 10-09 rule allowed deleting it outright).
- **Off means off:** one `mode` setting governs every mutation this feature can make (§3).

## 2. The exclusion argument (how a concurrent writer is handled)

Codex (rev 2) showed that check-then-delete leaves a window: a session can write an ignored file (`.env.local`, a
handoff) after the last check, and plain `git worktree remove` would delete it. Rev 3 closes the window by **taking the
path away before the final inspection**:

1. All rule checks pass (§4 rules 1–6).
2. `git worktree move <wt> <worktree_dir>/.prune-quarantine/<slug>.<runId>` — an atomic same-filesystem rename that also
   updates git's worktree metadata. From this instant the worktree's known path does not exist: a session writing by
   absolute path gets `ENOENT` (loud, nothing lost), `cd` fails, and ship resume sees no worktree and re-creates it from
   the kept branch (`worktree.action: add-existing-ref`, ship SKILL "resume" step 3).
3. Wait 5 s, then **re-inspect the quarantined tree**: full walk (no symlink following) — any path not in the allowlist,
   any file with mtime ≥ run start, any `git status` change, or any process whose cwd/fd points inside ⇒ **move it back**
   to the original path and keep it (reported as "write detected during removal").
4. Otherwise archive evidence, delete caches, then look once more: anything left in the tree at all (a blocker, or a
   new evidence/cache file written while archiving) ⇒ move it back. Only an empty-of-ignored tree reaches
   `git worktree remove` (never `--force`), which would otherwise delete late evidence unarchived.

**Other users' processes are not visible.** `/proc/<pid>/cwd` and `fd/` of a process owned by another user (a root
daemon, a container, anything started through sudo) cannot be read without privileges, so step 3 cannot see whether
such a process sits inside the tree. They are counted and reported ("N processes could not be inspected"), never a
keep reason: every non-root user sees every root daemon that way, so it would keep everything. What protects the tree
from such a process is the quarantine re-inspection itself, which has limits. It catches a write to any file that is
not covered by the delete or archive patterns (mtime ≥ run start) and any new blocker file, and the tree is moved back.
It does not catch a write to a delete-pattern (cache) path: that file is deleted along with the rest of the cache,
undetected. A write to an archive-pattern (evidence) path does not move the tree back either: the file is archived
and kept in holding.

The only writers that can still reach the quarantined tree are processes holding a cwd/fd opened before the move; step 3
detects those (and their writes) after the move, so there is no unobserved window left except the sub-second gap between
the re-inspection and `remove` for a process that opens nothing new — it would hit `ENOENT` too.

**Interrupted run:** a leftover `.prune-quarantine/<slug>.<runId>` from a dead run is never deleted: the next run moves it
back to `<worktree_dir>/<slug>` (if that path is free; else reports it) before doing anything else.

**Locks:** pre-existing locks (any `git worktree lock`, including the owner's) mean "keep" and are never released.
Ship's keep-lock (§5) carries `pipeline-keep: ship run <runId>`; ship releases only a lock whose reason carries its own
run id. Prune itself creates no worktree locks.

## 3. Command surface, canonical root, config, mode

```
pipeline worktrees prune  [--repo DIR] [--dry-run] [--json] [--notify]
pipeline worktrees keep   <slug> [--reason TEXT]     # git worktree lock, reason "pipeline-keep: <TEXT>"
pipeline worktrees unkeep <slug>                     # only removes a pipeline-keep lock
pipeline worktrees holding [--purge] [--json]        # list holding batches + restore commands; purge per mode
```
- **Canonical root:** whatever directory `--repo` points at (container, a linked worktree, a subdirectory), the command
  resolves `git rev-parse --path-format=absolute --git-common-dir`, and the canonical root is the **main worktree** of
  that common dir (first entry of `git worktree list --porcelain`). Candidate discovery, config and lock identity all
  derive from it, so ship (running inside a feature worktree) and cron (running in the container) see the same thing.
  (Existing `resolveRepo` returns the current checkout's top level — prune adds a `resolveCanonicalRoot` helper.)
- **Config source:** the main worktree's working copy of `.claude/pipeline.yml` (the owner's checkout of the default
  branch), never a feature branch's copy. New optional block:
  ```yaml
  worktrees:
    mode: report          # off | report | on   (default report)
    protect: [foundation, "*.stack"]
    min_idle_hours: 24
    min_merged_hours: 24
    delete: [node_modules/, .next/, supabase/.temp/, test-results/, playwright-report/, next-env.d.ts, public/sw.js, tsconfig.tsbuildinfo, "*.log"]
    archive: [.review/, .verify/]
  ```
  A path matching both lists is **archived** (archive wins): `.verify/logs/tests.log` is evidence even though `*.log`
  would delete it.
- **Mode policy — one switch for every mutation:**

  | action | off | report | on | `--dry-run` (any mode) |
  |---|---|---|---|---|
  | evaluate + report worktrees | no (prints "disabled") | yes | yes | yes |
  | quarantine / remove worktree, delete caches, archive evidence | no | no | yes | no |
  | restore a leftover quarantine (§2) | **yes** (it only undoes) | yes | yes | report only |
  | `holding --purge` | no | no | yes | no |
  | ship keep/unkeep locks | yes (they only protect) | yes | yes | n/a |

  Nothing else in this feature writes anywhere (no `.git/info/exclude` edits, no root-file moves — see §6).
- **Machine lock:** `locks.mjs` name `worktrees-prune-<first 12 hex of sha256(realpath(git common dir))>` (the helper
  accepts only `[A-Za-z0-9._-]`); a second concurrent run exits "already running".
- Node module like the other commands (the guard-git hook blocks shell scripts that pass unverifiable variables to git).
- Exit 0 on a completed run (skips are normal); 2 on environment errors (no git/gh, bad config, PR data unavailable).

## 4. Rules (all must hold, in order; first failure ⇒ "kept: <reason>")

1. **Candidate set.** `git worktree list --porcelain` entries whose path is a direct child of
   `<canonical root>/<worktree_dir>/`, name not starting with `.`. Never: the main worktree, `protect` globs,
   `.claude/worktrees/*`, pipeline temp worktrees, paths outside the root. Skip detached HEAD, locked and prunable
   entries; never run `git worktree prune`.
2. **Complete PR discovery, per branch, same repository only.** For each candidate's branch, a paginated GraphQL query
   through `github.mjs` `pagePullRequests` on `repository(owner,name).pullRequests(headRefName: $branch,
   states: [OPEN, CLOSED, MERGED])` returning `number state createdAt mergedAt headRefOid isCrossRepository
   headRepository { nameWithOwner }`. The `gh` repository and `origin`'s URL must name the same `owner/name` (checked
   once per run; mismatch ⇒ exit 2). Any page error, rate limit, non-advancing cursor or page cap ⇒ that worktree is
   kept ("PR data incomplete") — a truncated answer is never read as "no open PR".
3. **Exactly one finished lifecycle.** Drop nothing silently: if any returned PR is cross-repository (a fork using the same
   branch name) ⇒ kept ("ambiguous: fork PR with same branch name"). Of the same-repo PRs: any OPEN ⇒ kept; none ⇒ kept
   ("no PR"); the newest by `createdAt` (ties ⇒ kept, "ambiguous order") must be MERGED with `mergedAt` ≥
   `min_merged_hours` ago; CLOSED-unmerged newest ⇒ kept (reported).
4. **No local-only commits.** `git fetch origin refs/pull/<N>/head`; the fetched sha must equal that PR's `headRefOid`;
   then `git merge-base --is-ancestor HEAD <headRefOid>`. Fetch failure, missing object or not-an-ancestor ⇒ kept.
   (Verified 2026-10-13: #1446 and #1433 local HEADs are behind their merged heads — gate update-branch merges plus commits
   pushed from another checkout — so the old "HEAD == PR head" rule wrongly blocked them.)
5. **Nothing unique in the folder.** `git status --porcelain=v1 --ignored --untracked-files=all` plus a full tree walk:
   any tracked change or `??` path ⇒ kept; every ignored path must match `delete` or `archive`; anything else (including
   `.env*`, `HANDOFF*.md`, `*.patch`, a real `.superpowers/` directory) ⇒ kept. A `.superpowers` **symlink** into
   `~/claude-notes` is allowed (removal unlinks only). All paths `realpath`-contained in the worktree; symlinks never
   followed.
6. **Not in use.** Not locked; no process cwd/fd inside (`/proc/*/cwd`, `/proc/*/fd`); no Claude transcript modified in
   the last `min_idle_hours` shows a session working in the worktree (`~/.claude/projects/**/*.jsonl` and
   `~/.claude-eaglewatch/projects/**/*.jsonl`, de-duplicated by realpath). A JSONL line counts only when its top-level
   `cwd` equals or is inside the worktree path, or it carries a `tool_use` content block whose `input` names the path
   (under any spelling: the path, its realpath, or an alias through a symlinked ancestor such as `~/Claude`);
   tool results and user/assistant prose do not (one `git worktree list` or `ship inbox` output names every worktree),
   and branch names are not searched (they appear in every PR list). Fail-closed: a line that names the path but is
   not a JSON object counts, and so does a recent transcript that cannot be read. No non-archived memory note
   (`~/claude-memory/*/*.md` excluding `MEMORY-archive.md`, `archive/`) names the slug, branch or notes path together with
   `BUILDING`, `ledger home` or `keep`; no file outside `delete`/`archive` modified in the last `min_idle_hours` (judged
   per file, never by directory mtime).
7. **Quarantine, re-inspect, remove** — §2. Skip the whole run if any `index.lock` exists in the common git dir.
8. **Never:** delete a branch, `git worktree prune`, `--force`, `supabase stop`, touch `*.stack` folders or
   `<worktree_dir>/*.md` siblings, edit the Command Centre registry (report the slug instead).

## 5. When it runs

- **Ship** calls `pipeline worktrees prune --repo <its worktree>` at Step 0 (also the catch-up after the PC was off —
  cron does not fire while WSL is down) and Step 7. Ship takes `pipeline worktrees keep <slug> --reason "ship run <runId>"`
  at Step 1 (and on resume, step 3) and releases it at Step 7; a pipeline-keep lock older than 7 days (the mtime of the
  worktree's `locked` file in its admin dir, found through the `.git` file's `gitdir:` line) is reported as
  "stale keep (<N>d: <reason>) — still needed?", grouped apart in the summary, never released automatically.
- **Nightly** user crontab at 02:30 in the system time zone. Installed cron (3.0pl1) has no `CRON_TZ`; the installer
  checks the system zone (`/etc/timezone` / `timedatectl`) and warns if it is not Asia/Manila instead of claiming it.
  Absolute node path (nvm), log `~/.local/state/pipeline/prune-<repo>.log`, last 30 runs kept; every completed run
  (skipped and off mode included) writes its one line there. The cron line runs `prune --notify --summary-only`, so
  its own unrotated output file grows by one line per night.

## 6. Files outside worktrees — all report-only in this version

| Category | Action |
|---|---|
| A. caches / evidence inside a worktree being removed | `mode: on` only: caches deleted, `archive` paths moved to holding |
| B. container-root scratch (`.claude/*brief*`, `*.patch`, `*-ledgers/`) | report (path, size, age, memory notes citing it) |
| C. `/tmp/claude-<uid>/` session scratch | report (size + age per session dir) |
| D. `screenshots from mac/` (eaglewatch) | report |
| root `.review/`, `.verify/` | report (ship resume reads `.review/`) |

B/C/D/root files move only when a later spec defines completion and ownership for them. (Adding `screenshots from mac/`
to `.git/info/exclude` is a one-time manual step outside this command.)

**Holding folder** `~/.local/share/pipeline/holding/<repo>/<YYYY-MM-DD>/`: per batch `MANIFEST.json` (original absolute
path, size, sha256, archived-at); `original` is the worktree's real path, never the quarantine it was archived from
(the quarantine no longer exists afterwards); name collisions get a numeric suffix; `holding` lists batches with the
exact restore command (`mkdir -p '<dir>' && mv '<stored>' '<original>'`). `holding --purge` (nightly, `mode: on` only) deletes batches whose **archive time** is > 30 days old; an
invalid or future timestamp ⇒ kept.

## 7. Reporting

One summary per run (also a push notification with `--notify` when something was removed, restored or newly blocked):
```
worktrees prune (eaglewatch, report mode): would remove 3 (4.0 GB): agent-prod-smoke #1456, admin-tier-literal-sites
#1446, sa-corrections #1433 · kept 12: 9 open PR, 2 no PR, 1 in use (transcript 2h ago) · outside worktrees: 3 items
(report only) · holding: 0 batches
```
`--json`: per-worktree decision with the failing rule, for tests and ship's Step 7 summary.

## 8. Rollout

1. Ship the command; default `mode: report`. eaglewatch `pipeline.yml` gets `worktrees: {mode: report}`.
2. ≥ 3 nights of reports; owner reads them.
3. Owner flips `mode: on` (one line; `report`/`off` is the off switch, effective on the next run).
4. Same PR as step 3: reconcile both copies of the global CLAUDE.md "Clean up worktrees after merge" section to describe
   the command (PC copy still says "never automatically"; Mac copy was rewritten 10-09); update memory
   `feedback-auto-remove-finished-worktrees`.

## 9. Testing

**Unit** (pure decision function over fixtures): every rule's pass/fail arm; capped/erroring pagination ⇒ kept; fork PR
with the same `headRefName` ⇒ kept; tie on `createdAt` ⇒ kept; OPEN follow-up PR on a reused branch ⇒ kept;
CLOSED-unmerged; ancestor vs local-only commits; pull-ref sha ≠ `headRefOid`; `??` file; unknown ignored file;
`.superpowers` dir vs symlink; symlink escaping the worktree; stale keep lock; lock-name derivation is valid for
`locks.mjs` and identical from the container and a linked worktree; mode table (every action × off/report/on/dry-run,
including expired holding batches); invalid/future archive timestamps.

**Integration** (temp git repo with a bare origin and real worktrees, `gh` stubbed):
- report mode and off mode change nothing on disk (snapshot before/after), including with expired holding batches;
- on mode removes only the eligible worktree; archive + manifest + restore round trip;
- **writer after the last pre-move check:** a file created (a) after rule 6 but before the move and (b) inside the
  quarantined tree via a held fd/cwd after the move ⇒ moved back, kept, file intact;
- absolute-path write after the move ⇒ `ENOENT`, nothing lost;
- a run killed after the move ⇒ next run restores the quarantine to the original path;
- two concurrent runs ⇒ second exits "already running";
- invoked from a linked worktree and from the container ⇒ same candidates, same config, same lock name.

**Real-machine dry run** against eaglewatch in report mode, output attached to the PR.

## 10. Runtime validation still owed (cannot be settled by review)

Process visibility of `/proc/*/fd` for other users' or sandboxed processes on WSL2 (by design they are not visible to
a non-root prune: they are counted as `hiddenProcesses` and left to the quarantine re-inspection — mtime + blockers —
to catch their writes, §2); cron execution with WSL idle/asleep;
`git worktree move` behaviour with a process cwd inside on WSL2's ext4. All three are exercised by the integration tests
on this PC before `mode: on`.

## 11. Review findings and how rev 3 answers them

| Finding | Answer |
|---|---|
| Codex P1-1 (retained) race after last check; best-effort not enough | §2 quarantine move: path removed atomically before final inspection; post-move re-inspect incl. cwd/fd; move back on any write; tests inject the writer after the last pre-move check |
| Codex P1-2 (retained) 200-PR cap, fork name collisions | §4 r2 per-branch paginated discovery with `isCrossRepository`/`headRepository`; truncation ⇒ keep; r3 fork ⇒ keep; "newest" = `createdAt`, ties ⇒ keep; gh repo == origin check |
| Codex P1-3 evidence purge vs "nothing lost" | §1 guarantees restated: work never lost; evidence retained 30 d by design |
| Codex P1-4 (retained) D + root evidence lack completion checks | §6 all report-only |
| Codex P1-5 C ownership | report-only (resolved in rev 2) |
| Codex new P1 off switch doesn't govern everything | §3 mode table covers every mutation incl. purge; tests per mode |
| Codex new P2 lock name `x:y` rejected | §3 hashed `[A-Za-z0-9._-]` name |
| Codex new P2 canonical root / config source | §3 `resolveCanonicalRoot`, main worktree's config; tests from both locations |
| Codex new P2 `CRON_TZ` unsupported | §5 system zone, installer check |
| Codex latency claim | §1 ~48 h worst case |
| Codex: ship resume enters worktrees directly; release only own locks | §2 locks paragraph; §5 keep on resume; resume re-creates a missing worktree |
| Fable findings (rev 1) | carried from rev 2: transcripts + memory signals, temp-worktree exclusion, allowlist additions, stash dropped, CLOSED ⇒ report, one query per branch not per PR, Command Centre untouched |

## 12. Out of scope

Deleting branches; moving/deleting B, C, D or root evidence; other repos until they opt in via `pipeline.yml` (DRMed can
later); Mac-specific scheduling (launchd) — the PC is the machine where worktrees pile up today.
