# Plan v2 — owner push notifications for the ship pipeline (claude-pipeline repo)

(v2 revises v1 after Codex plan review round 1; the "R1 #n" tags say which finding each change answers.)

## Goal (unchanged)
The owner wants to walk away while `ship` runs. Push to iPhone + Mac via **ntfy**, plus a **Windows toast** when the run
is on the WSL2 PC. ntfy topic lives ONLY in `~/.config/claude-secrets.sh` (chmod 600), never in a repo (claude-pipeline is
PUBLIC). One push per event, ONLY for: (1) owner-merge waiting for "merge", (2) needs-human, (3) a run that stopped on a
failure it could not fix, (4) an arbiter escalation, (5) the production smoke result. Each push: PR number, PR title,
the ONE thing to do. Never on routine progress.

## Core change from v1: notify at the END of a run, from two places only (R1 #1, #3)
v1 fired from four commands mid-run, which both missed terminal paths and needed folding rules. v2:

- **`pipeline summary`** is THE terminal notifier. A run that stops with a PR — for any reason other than a merge —
  ends in `P summary --pr N --outcome <o>`. The skill is changed so that is true for EVERY such stop (see "Terminal-path
  inventory"). summary classifies the outcome into exactly one event and sends at most one push.
- **`pipeline prod-watch`** sends the production-smoke push (it alone knows rollback / issue / revert-PR artifacts).
  summary with a prod-watch outcome word (`merged`, `recovered`, `superseded`, …) never pushes — prod-watch already did.

Consequences:
- Mid-run label additions (e.g. Step 3.5 hard-stop `needs-human` in label mode, while the review loop still runs) do
  NOT push; the owner can't act until the run ends, and the run's end push carries the complete reason. Intentional.
- No arbiter→needs-human folding: when a run ends `needs-human`, summary reads `.review/state.json`; if any item has
  `final.needsHuman` from arbitration (arbiter ruling with low confidence / dismissed BLOCKING security-data item, or
  reason `model-proof`) the event is **arbiter-escalation**, and the message names ALL open needs-human items (arbiter
  ones first), so it is complete by construction. Otherwise the event is **needs-human**.
- Stops before a PR exists (preflight / labels-ensure failures at Step 0) happen while the owner is at the keyboard
  starting the run → no push, documented. Step 2's verify-red stop already opens a draft PR first, so it is covered.
- Not covered (documented limitation): a controller session that dies without reaching summary (killed, crash).

### Outcome → event map (single table in `pipeline/lib/notify.mjs`, exported)
| summary `--outcome` | event | default action (overridden by `--action`) |
|---|---|---|
| `awaiting-owner-merge` | owner-merge | `Check the listed items, then say "merge" for head <sha7>` |
| `needs-human` | needs-human or arbiter-escalation (from state) | `Read the needs-human comment and decide` / `Rule on <ids> in the triage comment` |
| `blocked` | stopped | `Verify stays red after 3 fixes: read the blocked comment` |
| `awaiting-review` | stopped | `Codex unavailable (<reason>): say "resume pipeline reviews" later` |
| `stopped` (NEW, no-state outcome) | stopped | `Read the PR: the run stopped` |
| `merged`, `no-production`, and every prod-watch outcome word | none (prod-watch pushed) | — |
| anything else (unknown word) | **stopped** (fail-safe: an unclassified stop still reaches the owner) | `Read the PR summary` |

`stopped` joins `NO_STATE_OUTCOMES` so it works with no review state.

### Terminal-path inventory → skill edits (R1 #1)
Every "stop" in `skills/ship/SKILL.md`, `reference/gates-and-exits.md`, `reference/review-loop.md` gets an explicit
summary call with `--action "<one line>"`. Known paths today that end WITHOUT a summary and get
`P summary --pr N --outcome stopped --action …`:
- final-gate `labels` / `preflight` failure (blocking label, pause/rollback issue, protection mismatch) — gates-and-exits §final-gate
- final-gate exit 3 twice (GitHub unavailable)
- merge `pre-merge` label/pause stop; merge "closed without merging" / "a blocker appeared while waiting"
- merge exit 3 `production-unknown` and GitHub-unavailable-after-retry
- update-branch `not-open`, exit 3 after retry
- deploy url exit 3 twice is already needs-human → make its summary explicit
Review-loop shorthand "label needs-human, summary, stop" (step 7, judge `not-found`/invalid twice, arbiter `not-found`)
becomes the explicit `gh pr edit --add-label needs-human` + `P comment --kind needs-human --reason …` +
`P summary --outcome needs-human --action …` sequence.

**Coverage test** (new, in the existing skills/docs agreement suite): every `--outcome <word>` that appears in the
three skill files must be a key of the exported outcome map (push or explicit no-push); and every paragraph/table row in
those files that tells the controller to "stop" (regex over imperative stop phrases: `stop`, `Stop.`, `, stop`,
`then stop`) must also mention `summary` or be on an allowlist of pre-PR / merged paths (Step 0 preflight, Step 6
merged→prod-watch). A new stop added to the skill without a summary fails the suite.

## Notification must not depend on GitHub annotation succeeding (R1 #2)
summary: compute the event BEFORE any GitHub call; run the existing title lookup + comment upsert; then in a `finally`
send the push whether or not GitHub succeeded, using the title if it was fetched, else `#N` only (and repo name).
The command's exit code / JSON stay exactly what they would have been, plus a `notify` field. Tests: title lookup fails,
comment upsert fails (exit 3) → push still sent once, exit still 3.
prod-watch: notify after `runProdWatch` returns (production lock already released), from its output object.

## Message
- Title: `#<N> <PR title>` (truncated to 80 chars). Tag/body includes repo short name (`eaglewatch`, `DRMed`, …).
- Body: `<event label>: <action>` (+ for arbiter/needs-human, item ids). ≤ 300 chars.
- Priority: owner-merge 4, needs-human 4, arbiter-escalation 4, stopped 4, prod merged 3, prod superseded / not-live /
  deploy-failed / deploy-not-observed 4, prod recovered 4, prod rollback-failed / changed-during-recovery /
  rollback-skipped 5 (urgent).
- Click: PR URL, or for prod outcomes the rollback issue URL when that artifact EXISTS.
- **prod-watch actions are built from artifacts that exist (R1 #7):**
  - recovered + revertPr + issue: `Rolled back, prod healthy. Review revert PR #X; close issue #Y to unpause merges.`
  - recovered, revert PR missing (branch conflict / error): `Rolled back, prod healthy. Revert PR could not be opened — revert #N by hand or fix forward; close issue #Y after.`
  - issue missing: `… rollback issue could not be opened — merges are NOT paused` (accurate wording per prodwatch.mjs).
  - existing artifact-failure tests in `test/prod-watch.test.mjs` (~line 442) extended to assert the push text.
  - merged: `Live and healthy — nothing to do.`

## Transports
- **ntfy**: JSON publish `POST <server>` body `{topic,title,message,priority,tags,click,actions:[{action:"view",label:"Open",url}]}`
  via global `fetch` + `AbortSignal.timeout(5000)`. Optional bearer token.
- **Windows toast** only under WSL (`/proc/version` ~ /microsoft/i or `WSL_DISTRO_NAME`) and `powershell.exe` resolvable.
  The PowerShell script is a **constant** string; the data (title, body, url) is passed as ONE base64-encoded UTF-8 JSON
  env var (`PIPELINE_TOAST_B64`) decoded inside the script and inserted into the toast XML via
  `[System.Security.SecurityElement]::Escape` — no user text is ever spliced into PowerShell source (R1 uncertainty:
  injection). AUMID: stock Windows PowerShell AUMID; `activationType="protocol" launch=<url>` for click-to-open.
  Spawned async with a 10 s kill timer. Real display / Unicode / click validated at rollout with `pipeline notify --test`.
- Mac: nothing extra (ntfy reaches it).

## Config / secret (R1 #6)
- Generic literal-assignment parser for `~/.config/claude-secrets.sh` lines `^\s*(export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$`:
  value may be bare, `'…'` or `"…"`; any value containing `$`, a backtick or `\` (expansion) is rejected for that key.
  Never sourced / eval'd. Only NTFY_TOPIC / NTFY_SERVER / NTFY_TOKEN are read.
- Per-field precedence: environment variable, then file, independently for each of the three.
- Per-field validation: topic `^[A-Za-z0-9_-]{1,64}$`; server `https://` URL (or `http://localhost[:port]`), default
  `https://ntfy.sh` only when NTFY_SERVER is unset everywhere; token `^[A-Za-z0-9_.-]{1,256}$`. Any present-but-invalid
  field → no send, `notify:{sent:false, reason:"invalid-config:<field>"}` — never fall back to another server.
- No topic → silent no-op, `reason:"no-topic"`.
- `PIPELINE_NOTIFY=off` disables all; `scripts/test.mjs` and CI set it; tests inject fake transports.
- **Confidentiality tests**: sentinel topic + token; assert they never appear in stdout, stderr, command JSON, the
  ledger, job logs, or rendered comments — including when the transport throws an error whose message echoes the URL
  (errors are scrubbed by replacing topic/token/server-path with `***` before surfacing).

## One push per event — atomic reservation (R1 #3, #4)
- Ledger `~/.claude/pipeline-state/notify-ledger.jsonl`; per-machine by design (runs are per machine). UTC ISO times.
- **Event identity** = sha256 of `repo | pr | event | headSha(or mergeSha) | causeDigest`, where causeDigest =
  sorted open needs-human item ids + the action text (summary) or the prod outcome + artifact numbers (prod-watch). So:
  same terminal state replayed (retry, resume, re-run of summary) → suppressed; same head but a different reason or new
  items → new push; new head → new push. When GitHub is down, headSha comes from local `git rev-parse HEAD` and title
  is omitted — identity does not depend on GitHub.
- **Protocol**: under `withLock('notify-ledger', …, {waitMs: 2000})` read the ledger, and if the key has a `sent` or a
  fresh (< 2 min) `reserved` record → skip (`duplicate`); else append `reserved`. Release the lock. Send (ntfy and toast
  in parallel). Re-take the lock (2 s) and append the result per transport (`ntfy: sent|failed`, `toast: sent|failed|n/a`).
- **Retry policy (stated)**: a key whose ntfy result is `sent` is never re-sent. A key with ntfy `failed`, or a stale
  `reserved` (crash mid-send), may be re-sent by a later identical invocation; an ambiguous HTTP timeout may therefore
  produce a duplicate push — accepted (better a rare duplicate than a lost alert). Toast is best-effort and never causes
  an ntfy resend. Lock timeout → send without reservation (alert beats dedup) and report `ledger:"unlocked"`.
- Corrupt ledger lines are skipped; records older than 90 days are dropped when the ledger is rewritten (on reserve).
- Tests: two concurrent processes on the same key → exactly one send; reserve→crash→retry sends; ntfy ok + toast fail
  → no resend; changed reason on same head → second push; corrupt line tolerated.

## Bounded and never blocking (R1 #5)
- Whole notify operation capped at **15 s** wall clock (one AbortController): lock ≤ 2 s ×2, title lookup only if the
  caller didn't already have it, via an async `gh pr view` with a 5 s kill timer (not the 60 s sync wrapper), ntfy 5 s,
  toast 10 s in parallel. On cap: abort fetch, kill children, return `{sent:false, reason:"timeout"}`.
- Never throws; never changes the host command's exit code or JSON beyond adding `notify`. prod-watch notifies after its
  production lock is released; summary after its comment work.
- Tests: lock held by another process → completes in ~2 s and still sends; hung `gh` → killed at 5 s; hung fetch →
  aborted; host exit code/output preserved in each case.

## New command
`pipeline notify --test` (one real push to all transports, reports per-transport result — rollout check) and
`pipeline notify --event stopped --pr N --action "…"` (manual, for the rare stop not expressible through summary).
Docs: CLI reference + skills-commands / docs-facts agreement tests updated for `notify`, `--action`, outcome `stopped`.

## Vendoring / install (P3 from R1)
Untouched vendored subset (vendor.mjs:20) → eaglewatch `pipeline vendor --check` stays clean. Installer walks
`pipeline/` (installer.mjs:131). Acceptance checks: after install, `pipeline notify --test` resolves (command discovery)
and INSTALLED.json lists `pipeline/lib/notify.mjs` + `pipeline/commands/notify.mjs` (manifest coverage; installer test
asserts walked files include them).

## Rollout
PR via ship (every path is a hard-stop in this repo → needs-human; main unprotected → owner merges). Owner reinstalls in
a non-Claude terminal. `pipeline notify --test` → owner confirms iPhone, Mac, Windows toast (incl. click). Mac needs the
same NTFY_TOPIC line in its own secrets file.

## v3 amendments (Codex recheck R2; these override v2 where they conflict)
- **R2 #1 prod-watch errors with no outcome** (`merge-sha-unresolved`, deploy API throwing after retries): prod-watch
  notifies from its own `finally` with event `prod-unknown` — "Production check couldn't finish (<reason>): check
  #N's deployment by hand" (priority 4). Skill also routes a prod-watch exit without `outcome` to
  `summary --outcome stopped --cause prod-watch:<error>`. Tests: unresolved SHA (prod-watch.test.mjs ~931) and a
  deploy API that keeps failing → one push each, exit codes unchanged.
- **R2 #2 deadline vs acknowledged delivery**: ntfy and toast record their results INDEPENDENTLY, each the moment it
  settles (own 1 s lock write). Budget: title lookup ≤ 3 s (skipped when the caller has it), reserve lock ≤ 1 s, ntfy
  ≤ 5 s, ntfy record ≤ 1 s; toast in parallel ≤ 8 s + its own record; hard cap 15 s with the ntfy record always inside
  it. An acknowledged ntfy is never lost to a hung toast. Test: slow lookup + acked ntfy + hung toast, then identical
  retry → no second ntfy.
- **R2 #3 wording**: missing `issue` → "Rollback issue could not be confirmed — check whether merges are paused." Never
  infer pause state from `issue:null`. Tests: lost acknowledgement, pre-existing pause issue.
- **R2 #4 WSL env bridge**: no env var. PowerShell gets the constant script via `-EncodedCommand` and the base64 JSON
  data on **stdin** (`[Console]::In.ReadToEnd()`), so WSLENV is irrelevant. Test the spawn args/stdin; validate on the PC.
- **R2 #5 explicit classification, no fail-safe push**: unknown outcome words → NO push, plus `notify:{sent:false,
  reason:"unclassified-outcome"}` and a stderr warning; the coverage test fails if any `--outcome` word in the skill
  files is unclassified. `update-branch not-open` → summary `closed` (owner closed it) or `merged-externally` — both
  explicit no-push. Only `stopped` / `blocked` / `awaiting-review` / `needs-human` / `awaiting-owner-merge` push.
  Tests: cancellation, external merge, unknown progress word → no push.
- **R2 P3 stable identity**: identity = repo | pr | event | head | outcome | sorted open needs-human ids | `--cause
  <code>` (short slug the skill passes, e.g. `final-gate:labels`, `codex:quota`, `verify-red`) — never the action text,
  so a reworded retry doesn't re-push.
- **Offline repo identity**: repo = owner/name parsed from local `git remote get-url origin` (no GitHub call), used
  for the ledger key and the push text; same across worktrees. Test outage → online replay across two worktrees.
- **Rollout step restored**: before the delivery check, ask the owner for the topic (or generate one), append
  `export NTFY_TOPIC=…` to `~/.config/claude-secrets.sh` keeping chmod 600, then `pipeline notify --test`.
