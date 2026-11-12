# Fable floor + per-version prices (PR A) and automatic `pipeline update` (PR B)

Status: PLAN rev4 (2026-11-10; Codex r1: 5×P1 3×P2 taken; Codex recheck: 5 new P1 / 2 P2 / 1 P3 taken in rev3; Fable
pass on rev3: 2 P1 / 6 P2 / P3s taken in rev4, owner answered its 4 decisions: stop an old terminal BEFORE the Fable pass,
RE-REVIEW rounds proven below the newest Fable, lean SessionStart hook, `pupdate` alias added to ~/.zshrc 11-10). Owner decisions: PR A **fails closed**;
PR B is **its own PR**, built on #226's scheduler and porting what still applies from #67 (#67 closed, branch kept, when
PR B opens). Review route: Codex plan review + one recheck → one Fable pass → owner → build via the review skill.
Guard hooks (`pipeline/hooks/guard-*`, `pipeline/hooks/lib/*-policy.mjs`) are frozen: neither PR touches them.

## Why

- The arbiter agent pins `model: fable`, an alias the **running** Claude Code build resolves. Auto-update is off, so a
  terminal opened before an update keeps the old Fable: on 11-10, 12 of 13 terminals still resolved `claude-fable-5-1`
  after 2.1.321 (→ `claude-fable-5-2`) was installed. The proof checks only the prefix `claude-fable-`, so the older
  model passes silently. Owner: "the Fable that reviews in my pipeline must always be the newest".
- `lib/run-cost.mjs` prices by family at old list prices, overstating `P summary` USD by ~50% (skews Phase 7).
- `pipeline update` is owner-only and manual; installs lag main by hours to days.

## PR A: Fable floor + prices (risk HIGH: review gate and model proof)

Base: origin/main (0d63c60). No dependency on #226 and no shared file (Codex P3); rebase if #226 lands first.

### A1. Model versions + a protected per-machine floor: new `pipeline/lib/model-floor.mjs`
- `parseModelId(id)` → `{family, major, minor}` for `claude-<family>-<major>[-<minor>][-YYYYMMDD]`, family ∈ fable,
  mythos, opus, sonnet, haiku; `null` otherwise. `compareVersions(a, b)`.
- **Where (Codex P1-1):** `<accountHome>/.claude/pipeline-state/owner-go/model-floor/fable.json`. `owner-go/` is already
  in the frozen guard's protected set (`files-policy.mjs`: agents cannot write, move or delete anything under it through
  Bash or the write tools; the pipeline CLI, which agents run but cannot steer, writes it). `accountHome()` is the passwd
  home, not `$HOME` (same reason as owner-go: a `HOME=/tmp/x` prefix must not point the check at an agent-writable
  folder). The owner-go readers list only `*.jsonl` files, so a subdirectory is invisible to them (a test pins this).
- **Floor = max(code constant, registry).** `MIN_FABLE = 'claude-fable-5-2'` ships in the code, so a missing or fresh
  registry (new machine, deleted by the owner) is never "no floor" (Codex bootstrap gap). The registry only adds versions
  newer than the constant. Bumping the constant is a normal pipeline PR when a new Fable ships.
- Format `{version: 1, newest, provenAt, claudeCode, transcript, history: [last 10 raises]}`. Corrupt / wrong schema /
  unreadable ⇒ fail closed; the message names the file and the owner's reset: a new subcommand `pipeline model-floor
  reset`, owner-only with the same check `update` uses (refused inside Claude Code), which rewrites the file to the
  code constant.
- **Test seam (Codex P2-6):** `PIPELINE_MODEL_FLOOR_DIR` is honoured only by a repo checkout (no `INSTALLED.json`,
  the same installed-copy check `testMode` uses), independent of `PIPELINE_TEST_MODE`, so production-mode tests of the
  checkout are isolated too. An installed copy ignores it with a stderr warning, like `PIPELINE_TEST_MODE`.

### A2. The proof enforces the floor, atomically (`arbiter apply`, `model-proof`)
- `proveModel` also returns `claudeCodeVersions` (the `version` field on each transcript line). Additive only.
- **Any Fable in the transcript is checked (Codex P1-2)**, whatever `--expect-model` says (default prefix, an exact
  `claude-fable-5-1`, a broader prefix). Only a test-mode run whose transcript has no Fable at all skips the floor.
- Every assistant line's Fable model must be ≥ the floor; one older line fails the proof (mixed transcripts included). A
  `claude-fable-…` id the parser cannot read fails closed ("unrecognised Fable version id X: update the pipeline").
- Failure: proof not ok, error `stale-model`: `older Fable claude-fable-5-1 (this machine's floor: claude-fable-5-2).
  This terminal runs Claude Code 2.1.318: restart it (or update Claude Code), then run the review again.` Output adds
  `restartRequired: true`, `floor: {newest, seen}`.
- **Atomic acceptance (Codex P1-3):** in `applyLocked`, after every other proof check passes, take the machine-wide lock
  `model-floor` (inside the existing per-PR state lock; nothing takes them in the other order, so no deadlock). Its lock
  file lives in the registry's own folder (`…/owner-go/model-floor/`), resolved from `accountHome()` like the registry:
  never `PIPELINE_LOCK_DIR` or `os.homedir()`, so processes with different `HOME` values share one lock (Codex r2 P1-1;
  the checkout-only seam moves registry and lock together). Then:
  read floor → compare → if the pass is newer, write the registry (atomic tmp + rename) → `saveState` → release. A
  registry write failure fails the proof (`model-floor-unwritable`, fail closed) and nothing is published. A `saveState`
  failure after a raise leaves only a higher floor (harmless; the retry re-proves). So a 5.1 proof either publishes
  before 5.2 was ever proven (a correct ordering) or sees the raised floor and is refused. Lock wait ≤ 30 s, then a named
  error `model-floor-busy`; `model-floor reset` may clear a stale floor lock (the generic "remove the lock dir" advice
  is not given: agents cannot touch owner-go).
- **Who may raise the floor (Fable P1-1):** only `arbiter apply`, only on a fully proven pass, only when no
  `--projects-dir` was given and the transcript lies under the account home's own projects root (`accountHome()`, not
  `os.homedir()`), and only from the installed copy at `<accountHome>/.claude/pipeline` or a checkout whose floor dir is
  redirected by the seam. `model-proof` is read-only against the floor (checks, never raises). So a fixture transcript or
  a steered `$HOME` cannot push the real floor up and wedge every review.
- Cause `stale-model` joins `MALFUNCTION_CAUSES` / `NEEDS_HUMAN_CAUSES` (triage.mjs): the unproven placeholder carries
  it when the floor is the only failure, `arbiter needed` clears it like `model-proof`, `needsHumanCause` reports it.

### A3. Running vs installed Claude Code: stop BEFORE the Fable pass (owner decision 11-10, Fable P1-2)
- New `pipeline/lib/claude-code-version.mjs`: running = `AI_AGENT` (`claude-code_2-1-321_agent` → `2.1.321`);
  installed = `package.json` two levels above `CLAUDE_CODE_EXECPATH` (both measured on this Mac 11-10; the build
  verifies them again and pins the parse with fixtures). Either unknown ⇒ `stale: null`.
- `P arbiter needed` on a Fable round: `stale: true` ⇒ exit 1 `restartRequired` (`error: stale-terminal`) **before** any
  Fable spend. Why: the floor alone lets old terminals keep proving the old Fable until some fresh terminal happens to
  prove the new one (the 11-10 case: 12 of 13 stale). Owner accepted the cost: an occasional restart when both builds
  resolve the same Fable (Codex r1 P2-7's point). `stale: null` ⇒ no stop; the floor (A2) still decides.
- `P preflight` gains `claudeCode: {running, installed, stale}` + a `warnings` line; it **never changes `canMerge`**.

### A4. Review skill + docs
- `skills/review/SKILL.md` step 4: `arbiter needed` or `arbiter apply` exit 1 with `restartRequired` ⇒ do **not** retry
  in this terminal, do **not** park. Stop with outcome `blocked`, spelled out (Fable P2-1): **no** `pipeline-blocked`
  label (only the owner clears it, line 20) and **no** `needs-human`; `P comment --kind blocked` with the CLI's `advice`
  text; `merge-hold --release --reason restart` when a hold command is configured (a stopped PR must not keep the merge
  line, line 92); then the stop ritual. On resume after the restart: `P arbiter needed --round R` and the arbiter again.
- The CLI gives the advice statelessly (no memory of an earlier stop needed): the transcript's build older than the
  installed one ⇒ "restart this terminal"; not older ⇒ "update Claude Code, or the owner runs `model-floor reset`".
  `restartRequired` is set whenever any line is below the floor, even next to other errors. A zero-item Fable round has
  no item to carry the cause, so the failure is also persisted as `round.arbiter.failure: {cause, advice, at}`.
  Rulings list: `stale-model` / `stale-terminal` are malfunction causes.
- `docs/cli.md` (arbiter apply, model-proof, model-floor reset, preflight, cost), README (floor, file, reset).

### A4b. Owner recovery that holds, and old proofs re-reviewed (Fable P2-2, P2-3)
- `model-floor reset [--hold <id>]`: back to the code constant; `--hold` also sets a ceiling the floor cannot rise above
  until `model-floor reset --clear-hold` (for an alias rollback, or the two accounts resolving different Fables). A
  `claude-fable-…` id the parser cannot read blocks reviews, including the PR that fixes the parser: the documented
  owner path is `model-floor reset --hold <last good id>` from a plain terminal, then merge the parser fix.
- **Old proofs (owner decision 11-10: re-review, not grandfather):** `review-complete` and the final gate's `review`
  check refuse a PR with any proven Fable round whose recorded model is below `MIN_FABLE`, naming the rounds; remedy:
  the skill opens a new round and runs a fresh Fable pass (one extra pass per affected PR). This applies to every repo
  the installed pipeline serves (EagleWatch's ~26 open PRs included) from the moment PR A is installed. The PR body lists
  the expected count (measured at build time from published states).

### A5. Prices per model version (`lib/run-cost.mjs`)
USD per MTok `[input, output, cache read, cache write 5 m, cache write 1 h]` (claude-api skill table 2026-11-03; cache
write = 1.25× input for 5 m, 2× for 1 h):

| id | in | out | read | write 5m | write 1h |
|---|---|---|---|---|---|
| claude-fable-5-2 | 8 | 40 | 0.20 | 10 | 16 |
| claude-fable-5-1 | 10 | 50 | 0.25 | 12.5 | 20 |
| claude-fable-5 | 10 | 50 | 1.00 | 12.5 | 20 |
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 | 8 |
| claude-opus-5, -4-8, -4-7, -4-6 | 5 | 25 | 0.50 | 6.25 | 10 |
| claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.5 | 4 |
| claude-sonnet-5 | 2 | 10 | 0.20 | 2.5 | 4 |
| claude-sonnet-4-6 | 3 | 15 | 0.30 | 3.75 | 6 |
| claude-haiku-5-5 (prompt ≤ 100K) | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
| claude-haiku-5-5 (prompt > 100K) | 0.50 | 2.50 | 0.05 | 0.625 | 1.00 |
| claude-haiku-4-5 | 1 | 5 | 0.10 | 1.25 | 2 |

- Lookup: exact id (date suffix stripped) → else the family's newest row → else unpriced (as today).
- `usageFromTranscript` splits cache writes by `usage.cache_creation.ephemeral_1h_input_tokens` / `_5m_` when present
  (else all 5 m). Haiku 5.5's tier is per message: input + cache read + cache write > 100K ⇒ the higher row.
- Fast mode (`usage.speed: "fast"`): Fable 5.2 16/80, Opus 5.5 8/40 (cache rows scale the same way; the build checks
  the live pricing page for fast cache prices, else leaves them unpriced and counts them in `unpricedMessages`).
- **Repricing buckets (Codex P2-8):** cost entries also carry `byPrice`, keyed `"<model id>|<tier>|<speed>"` (tier
  `std` or `>100k`, speed `std` or `fast`), each `{input, output, cacheRead, cacheWrite5m, cacheWrite1h, messages}`. Every dimension the price depends
  on is a key or a field, so a later table re-prices a record exactly. `P cost --from-transcript` fills it; hand entries
  (no model) are not bucketed and say so. `addCostEntry`, the record serializer and `costReport` carry it;
  `costShapeProblem` tolerates its absence (old records). `record.cost.priceTables` counts entries per table date
  (`{'2026-11-03': n}`), so a record priced under two tables shows both. Old records are not re-priced. Exact repricing
  holds while tier boundaries are unchanged; a table that moves the 100K boundary cannot re-bucket old messages.

### A6. Tests (repo `npm test` + verify.quick)
- model-floor: parse (dated, no-minor, unknown family, garbage), compare, constant vs registry, raise-only, corrupt /
  wrong-schema / unreadable ⇒ fail closed, absent ⇒ constant, reset subcommand (owner-only, refused inside Claude Code),
  installed copy ignores the dir override, owner-go readers ignore the subdirectory.
- arbiter apply / model-proof: older ⇒ exit 1 `stale-model` + `restartRequired`, items `needsHuman` with that cause;
  equal ⇒ ok; newer ⇒ ok + floor raised; mixed-model transcript ⇒ refused; exact and broad `--expect-model` with an old
  Fable ⇒ refused; test-mode non-Fable skips; failed proof never raises; registry-write failure ⇒ nothing published;
  zero-item Fable round; retry after `arbiter needed` clears the cause; two processes with different `HOME` values
  share one lock and one registry.
- **Interleaving test (Codex r2 P2-7):** floor 5.2. Process A proves an acceptable `claude-fable-5-2` and pauses between
  its floor compare and its publish (a pause seam honoured only in test mode in a checkout); process B proves
  `claude-fable-5-3` meanwhile. With the lock, B waits for A, so A publishes under floor 5.2 and then B raises it to 5.3.
  The assertion: no proof is ever published under a floor above its own model. With the lock removed (the mutation
  check), A publishes after B's raise and the assertion fails.
- **Fixtures:** success fixtures move from `claude-fable-5-1` to `claude-fable-5-2`; the intentional stale fixtures stay 5.1.
- Rev4 additions: `model-proof` never raises; `--projects-dir` or a transcript outside the account projects root never
  raises; `arbiter needed` stops a stale terminal before any spend (`stale-terminal`), `stale: null` does not stop;
  `round.arbiter.failure` on a zero-item round; advice text both ways; `reset --hold` caps the floor and
  `--clear-hold` lifts it; floor lock busy > 30 s ⇒ `model-floor-busy`; `review-complete` + final gate refuse a PR with
  a Fable round below `MIN_FABLE` and accept it after a fresh round; fast-mode pricing bucket.
- **Retrofit (Codex P2-6, r2 P2-6):** every checkout-run proof test (cli-review, model-proof, production-mode) runs with
  a scratch `PIPELINE_MODEL_FLOOR_DIR`. Installed copies ignore that override by design, so installed-copy tests never
  present a Fable transcript that could pass (they keep their non-Fable / failing fixtures, and a test pins that rule);
  the installed copy's floor enforcement is proven in-process with an injected home. A suite-level check still asserts
  the real registry is unchanged afterwards.
- claude-code-version + preflight: parse, stale true/false/unknown, `canMerge` unchanged, older build + acceptable
  model ⇒ proof ok.
- run-cost: every row, family fallback, 1 h split, Haiku boundary (100,000 vs 100,001), `byPrice` round trip through
  `P cost` → record → `P summary`, mixed price-table provenance, old records unchanged.
- Mutation check: flip the floor comparison and drop the lock; the suite must fail both.

## PR B: automatic `pipeline update` (risk HIGH: replaces the guard hooks unattended)

Base: origin/main **after #226 merges** (interval LaunchAgents in `lib/schedule.mjs`, `knownRepos`, `defaultNotify`,
`liveRecords`; contracts re-read from merged main before building). Not #67's `lib/launchd.mjs`, not its guard edits.

### B1. Review leases + one admission lock (Codex r1 P1-4/5, r2 P1-2/3/4)
- New `pipeline/lib/review-lease.mjs`. **Protected storage (r2 P1-3):** leases live under
  `<accountHome>/.claude/pipeline-state/owner-go/review-leases/` (the frozen guard's protected namespace, like the floor;
  real directory, no symlinks, owner-go's existing checks reused). Agents cannot delete or forge them; only pipeline
  commands write them.
- **One file per holder (r2 P1-4):** `<sessionId>.json` = `{sessionId, pid + process start time of the owning Claude Code
  session, leases: {<worktree>: {repoId, pr|branch, generation, openedAt, renewedAt}}}`. A session edits only its own
  file (under a per-file lock), so two sessions on the same PR hold two leases and one closing never removes the other.
  Every open gets a new `generation`; closing names the generation, so an old `ended` run cannot close a resumed lease.
  A branch lease becomes a PR lease on the first command that knows the PR number (same generation).
- **Holder identity (Fable P2-5):** the Claude Code ancestor pid → that session's own record
  `<config>/sessions/<pid>.json` (the lookup `worktree-prune/live-sessions.mjs` already does), giving pid, start time
  and session id. `claude-ancestry.mjs` gains a function that returns the pid (today it returns only a boolean). Live =
  pid and start time match AND the session record's id equals the lease's (a `/clear` keeps the pid but changes the id,
  so the old lease dies) AND `renewedAt` is within 6 h (idle terminals stop blocking updates). `CLAUDECODE=1` but the
  lookup fails ⇒ a TTL-only lease (6 h). A detached `P job` is covered by its job record (live pid). A plain terminal
  (no Claude ancestor, no `CLAUDECODE`) writes no lease. (Superseded by `docs/plans/2026-11-12-terminal-leases-hardening.md`: a plain terminal now takes a process lease.)
- **Lifecycle:** opened-or-renewed by every pipeline command that reads or writes a worktree's review state (renew opens
  if absent, so a review started on an older install gets a lease at its next command); closed by the stop ritual
  (`P summary --outcome …`) and by `ended` runs. A long Fable pass with no command in between stays covered: the lease
  lives as long as its session.
- **Admission = a separate protected lock held by the installer process (r2 P1-2, Fable P2-4):** a new lock `admission`
  in `owner-go/review-leases/` (protected; resolved from `accountHome()`, never `PIPELINE_LOCK_DIR`). Not the installer's
  own lock: that one is fail-fast, honours `PIPELINE_LOCK_DIR`, keys on `CLAUDE_CONFIG_DIR` (split across the two
  accounts) and sits in unprotected `backups/.locks`, so review commands would make a manual `pipeline update` fail.
  Opening or renewing a lease takes `admission` briefly (bounded wait, then "pipeline update in progress, retry in a
  minute"). `install.mjs --require-no-live-reviews` takes its own lock, then `admission` (bounded wait), scans leases,
  live jobs, held state/merge/queue locks and live merge-queue records, aborts with exit 3 `deferred` if any is live, and
  otherwise holds `admission` through the swap and its own verification, with a self-deadline (abort before swapping if
  the scan or download overruns). The flag refuses unless the target home is `<accountHome>/.claude`. The process doing
  the writes holds the lock, so a killed parent (`update --scheduled`) cannot release it early. Lock order: installer
  lock → `admission`; a review command takes `admission` (brief, released) → per-PR state lock → `model-floor`. Nothing
  the installer runs while holding `admission` opens a lease (a test pins it). No cycle.
- Dead-holder files are swept by the installer's scan. A live but idle session holding a lease blocks updates; that is
  the B2 24 h notice's job. An unreadable lease file counts as live.

### B2. `pipeline update --scheduled` (what the job runs; ported from #67)
- Current and unmodified ⇒ exit 0, silent. Behind ⇒ download main, then run the installer with
  `--require-no-live-reviews` and #67's under-lock `--expect-installed` check (edits or a manual install during the
  download ⇒ no install). Exit 3 `deferred` ⇒ exit 0 with one log line naming what is live.
- Modified, ahead, diverged **or incomplete** (an interrupted install's partial manifest) ⇒ never touched automatically
  (r2 P1-5: drift alone cannot tell an interrupted install from an owner edit, and #67's rule stands); notify once per
  (reason, main sha) with the exact `pipeline update` command for the owner to run by hand. Transient failure (lock busy,
  GitHub unreachable) notifies only after 3 in a row; a good run clears the streak. A failed verify notifies with the
  drift list; the job does not retry that main sha.
- Deferred continuously > 24 h (wall-clock from the first deferral, stored in the status file; a clock jump backwards
  resets it) ⇒ one notification naming the lease holders.
- Rollout: the first install of PR B is the owner's manual `pipeline update`; from then on every command runs the new
  code (each command is a fresh process), so a command that loaded old modules cannot outlive an install.

### B3. Schedule: `pipeline update schedule --install [--every N] | --remove | --status`
- macOS: LaunchAgent `com.claude-pipeline.auto-update` through #226's `schedulePlist({interval})` + `applyLaunchd`
  (RunAtLoad: a Mac waking from sleep catches up; launchd does not overlap runs of one job, and the run also takes the
  install lock). N ∈ 5, 10, 15, 20, 30, 60 (default 15). Linux/WSL: one crontab line through the existing cron helpers.
  Native Windows: `unsupported-platform`.
- `--install` refuses inside Claude Code like `update` (it arranges an unattended guard-hook swap: owner only, once per
  machine). `--status` / `--remove` run anywhere.

### B4. Notices
- After an install: `defaultNotify` (event `pipeline-update`): "pipeline updated to <sha> (<PR title>)".
- The job writes `<accountHome>/.claude/pipeline-state/update-status.json` (current / behind / deferred-by-review /
  blocked-modified / failed). **Owner decision 11-10: a lean SessionStart hook** (reverses part of Phase 4 #125's
  retirement on purpose): it only reads that file (no network, no git, hard 1 s budget, silent on any error) and prints
  one line when not current ("pipeline update available — installs automatically when no review is running" / "…
  waiting on a review in <repo> #N" / "… needs you: run pupdate"). Installer: a new non-guard hook unit; the retired
  session-version entry stays retired (different file name), and `--check` reports the new one like the other units.

### B5. Short alias
Done 11-10 (owner OK): `~/.zshrc` has `alias pupdate='PATH="/opt/homebrew/bin:$PATH" node
"$HOME/.claude/pipeline/bin/pipeline.mjs" update'`. README documents it; the installer never edits dotfiles.

### B6. Tests + docs
- Port #67's update-schedule / update-scheduled tests onto #226's scheduler.
- Leases: open / renew / close, two sessions on one PR (closing one keeps the other), stale-generation close ignored,
  branch → PR migration, dead-pid sweep, PID reuse, unreadable ⇒ live, protected-path refusal of an agent `rm`/write
  of a lease file (guard behaviour pinned), **a review that starts after the final scan** (deterministic: the installer
  holds its lock, a review command waits, the swap finishes before the lease is granted), a long Fable gap (no commands
  for > 30 min, lease still live), crash recovery (session killed mid-review ⇒ lease void at the next scan), **the
  updater killed mid-install** (the installer child keeps the lock to the end; no review admitted meanwhile).
- Each defer signal alone defers; none ⇒ installs; `--expect-installed` mismatch under the lock ⇒ no install;
  interrupted install, then an owner edit ⇒ never auto-installed, owner notified; failed verify ⇒ one notification;
  24 h notice incl. a backwards clock jump; refusal inside Claude Code; status file contents.
- `/clear` in a session (same pid, new id) ⇒ old lease dead; idle > 6 h ⇒ dead; two accounts' sessions share one
  `admission` lock; a manual `pipeline update` is not blocked by review commands' lease renewals.
- Hooks during the swap (Fable P2-6): a guard hook started while `swapIn` has the old unit renamed away and the new one
  not yet in place must DENY (fail closed), pinned by a test; the residual (a hook run in that instant is refused, not
  allowed) is stated in the PR.
- SessionStart hook: reads only the status file, prints nothing when current, never fails a session start.
- README "Automatic updates", docs/cli.md.

## Notes from the Fable pass (taken)
- `PIPELINE_MODEL_FLOOR_DIR` is not in the frozen guard's seam list; acceptable, since it is honoured only by a checkout
  (agent-editable anyway) and never by the installed copy.
- `owner-go.mjs` `realDirChain` is not exported: export it (no behaviour change) and reuse it for the floor and lease
  folders; the lock helper creates folders without a symlink check, so the new folders are created through
  `realDirChain` first.
- Considered and kept: leases instead of run records + holder liveness (run records do not span the direct Fable
  call); the lock across `saveState` (cheap, and it makes the ordering argument trivial).

## Out of scope / suggestions
- Cross-machine floor: seed each machine's registry from proven models in published triage states (the PC keeps its own).
- A one-off re-pricing script of pre-11-10 run records from their transcripts for Phase 7, if Phase 7 needs old USD.
- Leases also give the command-centre wallboard a "reviews running now" panel for free.

## Order
PR A: plan recheck → Fable pass → owner → build now (no #226 dependency) → merge → owner `P update` → Phase 7.
PR B: after #226 merges, build in parallel with PR A's review rounds (shared files: docs/cli.md, README; second to merge
rebases).
