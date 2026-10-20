# Stack stop: two false-MISS causes — plan (2026-10-20)

Spec: docs/specs/2026-10-19-stack-stop-design.md (§1 register hook, §6 measurement). Measure-first is unchanged: no mode.json is installed, so every
mode resolves to report (configuration, not a code invariant: apply mode still stops). This PR changes what counts as a lease (a) and how a lease-only use is classified (b).

## Evidence (live checks 2026-10-20, report mode)

Test stack `autostop-live`, two session-end would-stops, two MISSes, both false:

| would-stop (session-end) | use (ledger `use`, check C1) | owner | owner birth | what it ran |
|---|---|---|---|---|
| 03:14:13.119Z | 03:14:48.267Z via folder | pid 9705 | 03:14:01Z (1792466041) | `docker ps --filter name=<stack>` |
| 03:16:22.749Z | 03:17:06.895Z via folder | pid 72631 | 03:16:20Z (1792466180) | `docker inspect … label=…<stack>` |

Neither process had any lease, connection or process reference for the stack at or before the decision. Both were born a
few seconds before it (a new / resumed session starting while the old one exited), so the birth-only rule called them MISS.

## (a) read-only inspection is not use — `pipeline/lib/stacks/match.mjs`

New exported `readOnlyCommand(command, platform)`; `bashTargets` returns `[]` when it is true. A Bash command is read-only
only when EVERY simple command in it (`segmentsOf` + `splitCommand`, the same parse as today) is either neutral (`cd`,
`pushd`, `popd`) or a read-only inspection, and at least one is an inspection. Anything else keeps today's whole-command
match (so `echo name | xargs supabase stop`, `cat f | psql -p <port>`, `ls && supabase status` all still lease).

Revision 2 (Codex B1): before any of this, the WHOLE raw command is not read-only when it contains anything that can run a
program inside an argument, quoted or not: `$(`, a backtick, `<(`, `>(`, `${` (an expansion can hold `$(…)`), or a word
`eval` / `exec` / `source` / `.`. Revision 3 (Codex recheck B1): ANY `$` makes it not read-only (an expanded variable can inject `-exec psql …`). Regression cases: `cat "$(psql -p <port>)"`,
`ls "`supabase status`"`, `X="$(psql …)" ls`, `grep x <(psql …)`, `ls ${D:-$(supabase …)}` all still lease.

Read-only inspection = command word (after leading `VAR=value` words) in this list, with these guards:
- `ls cat head tail grep egrep fgrep wc stat du df jq realpath readlink basename dirname pwd which cut tr diff cmp lsof ps pgrep`
- `rg` without `--pre` (it runs a program per file)
- `find` without `-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls`
- `docker <sub>` where `<sub>` is the FIRST word after `docker` (a leading global flag ⇒ not read-only) and is one of
  `ps inspect logs stats top port images events version info diff`, or `container|image|volume|network|system <sub2>` with
  `<sub2>` in `ls list ps inspect logs stats top port diff history df info events`. `docker exec`, `cp`, `start`, `stop`,
  `restart`, `rm`, `run`, `compose …` are not read-only.
- No output redirection to a file: any token containing `>` makes the segment not read-only, except `>/dev/null`,
  `2>/dev/null`, `&>/dev/null`, `>>/dev/null`, `>&N`, `N>&M`, or a bare `>`/`2>`/`&>` followed by `/dev/null`.
- A segment splitCommand cannot parse (lenient), an assignment-only segment, `bash -c "…"` / `sh -c` / `xargs` / `env` /
  `sudo` / `timeout` / `watch` wrappers, `echo`/`printf` and `sed`/`awk`/`sort`/`uniq`/`tree` (they can write or run
  things) are NOT read-only: over-match stays the rule.

File tools: `Read`, `Grep`, `Glob` are read-only and no longer lease (same act as `cat` / `grep` / `ls`); `Edit`, `Write`,
`NotebookEdit` still lease. The prefilter is unchanged (it stays a cheap gate; a hit just costs one inventory lookup).

Side effect, intended: in apply mode the "just stopped automatically" block (register step 6, Bash only) no longer fires
for a read-only inspection, so `docker ps` of a stopped stack is never blocked.

Tests (`test/stacks-match.test.mjs`, failing first): a read-only table (`docker ps --filter name=…`, `docker inspect …`,
`docker logs …`, `docker container ls`, `grep … <folder>/…`, `ls <folder>`, `cat <folder>/supabase/config.toml | head`,
`lsof -i :<port>`, `ps aux | grep <project>`, `cd <folder> && ls`, `docker ps 2>/dev/null`) ⇒ `[]`; a still-use table
(`docker exec …`, `docker restart …`, `ls <folder> > out.txt`, `cat x | psql -p <port>`, `find <folder> -delete`,
`rg --pre x <project>`, `echo <project> | xargs …`, `bash -c "docker ps … <project>"`, `cd <folder> && supabase status`,
`docker --context x ps <project>`, `sed -n 1p <folder>/x`, `echo <project>` stays a lease) ⇒ target. The existing tests
that used `ls <folder>` / `docker logs <container>` / `Read` / `Grep` / `Glob` as the example of a lease change: the
`ls` / `docker logs` examples move to non-read-only commands (`cp -r`, `docker restart`) with the same `via` assertions,
and the file-tool tests assert `Read`/`Grep`/`Glob` give `[]` while `Edit`/`Write`/`NotebookEdit` still lease. These are
test-integrity owner-merge items, listed in the PR body.

## (b) alive-but-unused ⇒ RESTART only with affirmative evidence — outcomes.mjs, evidence.mjs, sweep.mjs, session-end.mjs

Revision 2 (Codex plan check B2–B4): "no recorded earlier use" is NOT proof of "no earlier use". A born-before C1 use becomes
RESTART only when the owner's OWN TRANSCRIPT proves it did nothing with the stack between its birth and the decision.

### The rule (classifyUse stays pure; the evidence is attached to the use)
`classifyUse(rec, use)`: a C1 use (`check === 'C1'`) born before the decision is RESTART only when
`use.quiet?.decision === rec.t && use.quiet.verdict === 'quiet'` (evidence computed for exactly this decision), AND
outcomeSummary found no prior sign (below). Everything else born before stays MISS; C2 / C3 never change; UNKNOWN unchanged.

**Prior sign (outcomeSummary, over the uses it is given):** any use (C1 / C2 / C3, ledger or observed) of the same project
(case-insensitive) and the same owner identity (pid AND birth, both finite) whose time is at or before the decision ⇒ MISS.
This is a fast negative only; the transcript is the positive proof.

**Quiet proof (new `evidence.ownerQuiet(stack, { dirs, sessionId, birthMs, decidedMs, … })` → ok({ verdict, file, why }) | unknown):**
- Find `<dir>/<proj>/<sessionId>.jsonl` under the configured transcriptDirs (none, or several ⇒ unknown) and every
  `<dir>/<proj>/<sessionId>/subagents/*.jsonl` (an unreadable subagents dir ⇒ unknown).
- The main file must show the process STARTED in it: the first line with `timestamp` ≥ birth − 5 s is a `SessionStart:startup`
  or `SessionStart:resume` hook attachment. A first line from `SessionStart:clear` / `:compact`, or no such line ⇒ unknown
  (after `/clear` the same process wrote an earlier transcript under another id, which cannot be found). (This is why the
  session id must come from the lease event itself.)
- Scan every line of those files with `timestamp` in [birth − 5 s, decided] (a line naming the stack without a parseable
  timestamp counts as inside). A line is a SIGN when (i) its `cwd` is inside the stack workdir, or (ii) a `tool_use` block's
  input names the stack (folder, project id, container, workdir spellings, published ports — evidence.mjs `matchers` with
  ports) and the call is not read-only (match.mjs `readOnlyCommand` for Bash; `Read`/`Grep`/`Glob` are read-only), or (iii)
  a user line's `<bash-input>` (a `!` command, which runs without PreToolUse hooks) names it, or (iv) a line naming the stack
  is not valid JSON. Any sign ⇒ `verdict: 'used'`; none ⇒ `'quiet'`. Any read error ⇒ unknown. User prompt prose and
  assistant prose never count (they are not use).
- The stack's names come from the inventory (folder, workdir, containers, ports); a stack no longer in the inventory, or
  one without ports in it ⇒ unknown (a port-only use could not be ruled out).

**Who computes it:** the sweep's `finish`, before outcomeSummary, for each C1 use that would otherwise be MISS (born before
its target decision, inside the window, no prior sign) and has a `sessionId`: one `ownerQuiet` per (owner, decision),
cached for the run; failures are notes and leave the use MISS. Config not ok / no transcriptDirs ⇒ nothing computed ⇒ MISS.
Because transcripts persist, every sweep recomputes this for existing records, so the two live false MISSes reclassify on
the next sweep after the install (the 7-day clock restarts then anyway).

### C1 provenance (B4)
- `ledgerUses` adds `sessionId` (the event's `session_id`) and `ledger: true`.
- The session-end worker's C1 observation records the LEASE's own time as `t`, the probe time as `seenAt`, and `sessionId`;
  outcomeSummary drops exact duplicates (same project, pid, birth, t, check C1).
- Legacy worker C1 observations (no `seenAt`: written by the installed b6ba128 code, including the two workers running now)
  are judged at their probe time, which can charge a lease to a LATER decision. outcomeSummary drops a legacy C1 observation
  only when the uses hold a ledger C1 use of the same project + pid + birth with `t` ≤ the observation's `t` and > the newest
  stop record of that project before the observation's `t` minus 2 h 5 min (the worker's whole observation span), i.e. the
  lease the worker saw is itself present and judged at its true time. Otherwise the legacy observation stays as it is
  (conservative). Missing / repaired ledger ⇒ no match ⇒ kept.

### Why this cannot hide a real MISS
A real MISS is a process alive at the decision that was using the stack. Its use either went through a tool call / `!`
command of its session (the transcript between its birth and the decision shows it: sign ⇒ MISS), through a child process
(that process has its own birth and its own C2 / C3 / C1 uses, unaffected), or through a session file we cannot find or
trust (clear / compact / missing / several / unreadable ⇒ unknown ⇒ MISS). Read-only inspection is the one thing allowed
before the decision, and it is the same rule as (a).

### Tests (failing first)
- outcomes: the live shape — would-stops 03:14:13 / 03:16:22 (session-end, same generation), ledger uses 9705 (born
  03:14:01; 03:14:48, 03:15:36) and 72631 (born 03:16:20; 03:17:06, 03:18:16) with sessionIds, legacy worker C1
  observations of both at +30 min, `observed` markers ⇒ with quiet proofs: MISS 0, the ONE generation row RESTART (both uses RESTART); without them: MISS (old).
  A quiet proof for another decision t ⇒ MISS. Prior sign (earlier lease, earlier C2 observation) ⇒ MISS. pid reuse (same
  pid, other birth) is not a prior sign. A legacy observation without its ledger lease stays.
- evidence `ownerQuiet` with fake fs transcripts: startup quiet ⇒ quiet; resume quiet (older lines before birth name the
  stack) ⇒ quiet; a non-read-only tool_use in the window ⇒ used; read-only `docker ps` / Read in the window ⇒ quiet; a
  `<bash-input>` ⇒ used; cwd inside workdir ⇒ used; subagent file with a use ⇒ used; first line `SessionStart:clear` ⇒
  unknown; no file / two files / unreadable ⇒ unknown; invalid JSON naming the stack ⇒ used; prose naming it ⇒ quiet.
- session-end: a C1 observation carries the lease t, seenAt and sessionId.
- sweep: finish attaches quiet proofs (fake transcripts) ⇒ report RESTART; transcriptDirs missing ⇒ MISS.
- register (Codex suggestion): `Read` no longer appends a lease (update test/stacks-register.test.mjs:368's expectation);
  in apply mode a just-stopped stack: `docker ps --filter name=<p>` passes, `docker ps … && supabase status` is blocked.

## Revision 3 (Codex plan recheck, session 01a15756) — supersedes the matching parts of (b) above

- **Quiet = no unexplained activity, not "no name match" (recheck B2).** In [birth − 5 s, decided] the owner's transcript
  lines (main file + subagents) may hold only: hook / attachment / system lines, user prompt text WITHOUT `<bash-input>`,
  assistant text, and `tool_use` blocks of `Read`, `Grep`, `Glob`, `ToolSearch`, or `Bash` whose command is
  `readOnlyCommand`. Any other tool_use (Bash non-read-only, Edit, Write, Agent, Skill, MCP, WebFetch, …), any
  `<bash-input>`, or any line that is not valid JSON ⇒ `'active'` ⇒ MISS. Stack-name matching is no longer part of the proof.
  Scope of the proof: it covers what the owner process itself did. A child or hook process that kept consuming the stack is
  its own process with its own birth and its own C2 / C3 uses (unchanged rules); one that ended before the decision was not
  a live consumer at the decision.
- **Start marker bound to this lifetime (recheck B3).** A line with `attachment.type === 'hook_success'`,
  `attachment.hookName` exactly `SessionStart:startup` or `SessionStart:resume`, `sessionId` equal to the lease's session id,
  and `timestamp` in [birth − 5 s, birth + 120 s] must exist, and it must be the FIRST `SessionStart:<source>` line in that
  range (a `:clear` / `:compact` first ⇒ unknown). It may come after the decision (live: resume marker 03:16:39, decision
  03:16:22, birth 03:16:20): no tool call runs before the SessionStart hooks, and the window scan still covers
  [birth − 5 s, decided]. No such marker ⇒ unknown ⇒ MISS.
- **Legacy observations (recheck B4).** A legacy worker C1 observation O (no `seenAt`) is dropped only when the ledger is
  provably complete over its span: the ledger was read OK, `ledger.bad.jsonl` does not exist (never repaired), and the
  ledger's FIRST event is at or before the earliest session-end stop record of O's project + generation in
  [O.t − 2 h 10 min, O.t) (that set must be non-empty). Then the lease O stands for is in the ledger and is judged at its
  true time, so dropping O loses nothing. Otherwise O stays. The sweep passes `ledgerCoverage: { ok, firstT, repaired }`.
- Live validation before the PR: run `ownerQuiet` read-only against the two real transcripts (e51acd5e, 2f3b1ba8) and paste
  the verdicts in the PR body.
- Hand-off of review: two plan rounds used (fresh + recheck); the PR review loop reviews the code.

## Spec + docs
Spec §1 (registers for every stack named … except read-only inspection; list), §6 (MISS / RESTART definitions), Known
limits (residual risk). `docs/stacks.md` or the README section if it lists what leases.
