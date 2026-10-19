# Stack stop (automatic stop of private Supabase stacks) Implementation Plan

> **For agentic workers:** executed through the global `ship` skill: one `implementer` subagent per task (Sonnet,
> pinned by its agent file), quick verify after each task, full verify before the PR. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** private local Supabase stacks (and a session's own dev server) are stopped once nobody needs them — first
in report-only "measure" mode — without ever touching shared stacks or deleting data.

**Architecture:** a PreToolUse hook registers every use of a private stack (lease = live Claude process) under a
per-project lock before the tool runs; a SessionEnd hook spawns a detached worker that, after the Claude process has
exited, re-checks every consumer signal and decides; a daily `P stacks sweep` (launchd) applies the owner's seven
conditions to every running stack. All decisions are pure functions over probe results that are `ok | unknown`
(fail closed). Modes start as `report`; outcomes (MISS / RESTART / CLEAN) give the owner the evidence to switch on.

**Tech Stack:** Node ≥ 20 ESM, no dependencies; `node --test` via `scripts/test.mjs`; existing helpers
`pipeline/lib/{locks,proc,paths,safe-read,claude-ancestry,notify}.mjs`, `pipeline/lib/worktree-prune/*`.

**Spec:** `docs/specs/2026-10-19-stack-stop-design.md` (rev 5, owner-approved 2026-10-19). Read it before every task.

## Global Constraints

- Shared, never stopped: config `shared` ids (this Mac: `e2e-ci`, `DRMed`, `eaglewatch-pipeline`), any project id
  ending `-pipeline`, any workdir containing `/.verify/supabase-workdir`; compared case-insensitively.
- The ONLY stop invocation: `supabase stop --workdir <realpath>`. Never bare `supabase stop`, never `--project-id`,
  `--all`, `--no-backup`; never `docker rm`, `docker stop`, `docker volume rm`. A workdir that does not exist ⇒
  report-only.
- Every probe returns `{ ok: true, value }` or `{ ok: false, reason }`; `ok: false` on any required input ⇒ keep.
- Process identity `{ pid, birth }`, birth = epoch seconds from `ps -o lstart= -p <pid>` run with `TZ=UTC LC_ALL=C`.
  Event times: UTC ISO strings (`new Date().toISOString()`).
- State root `PIPELINE_STACKS_HOME` (default `~/.claude/pipeline-state/stacks/`); a non-default root REQUIRES
  `PIPELINE_STACKS_ONLY` (comma list) and nothing outside that list is assessed or stopped.
- Machine config `<root>/config.json` missing/invalid ⇒ inert (registration records; nothing stoppable; report says
  "not configured").
- Modes `<root>/mode.json` keys `sessionEnd`, `sweeper`, `devServers` ∈ `report|apply`; missing/invalid ⇒ `report`.
  Install never writes config/modes/schedule.
- Pause file `<root>/pause`: no stop on any path; registration becomes best-effort (failures exit 0).
- Register hook: internal deadline 20 s, hook timeout 30 s, fail-closed loader; dev-bind and session-end hooks plain
  (non-blocking), timeout 10 s. Windows: every hook exits 0 at once; `P stacks` says "not supported on Windows".
- No real Docker/Supabase/lsof/ps/gh in unit tests: inject `run` (signature of `pipeline/lib/proc.mjs` `run`) or use
  fake binaries; tests never write the real `~/.claude`.
- Owner rules for this repo: every path is a hard-stop (`owner_approval: chat`); the owner merges and installs.

## Review Focus

1. **Containers without a workdir label** (the live `DRMed` stack has only `com.supabase.cli.project`): must be
   treated as "workdir unknown ⇒ report-only", never crash the sweep. Test in Task 2.
2. **Paths with spaces and non-ASCII** in worktree/stack paths (installer CI already uses a home with a space): lsof
   `-F` output, `--workdir "…"` quoting and realpath comparison must hold. Tests in Tasks 4 and 6.
3. **Register-hook latency with a big ledger** (months of lines): the hook must never read the ledger, only the
   inventory cache and the tail of `actions.jsonl`. Test in Task 5 (100k-line ledger, hook still < 1 s).
4. **`supabase` missing from the launchd PATH / CLI error on stop**: reported as `failed` with the stderr line, never
   retried in a loop, no second stop attempt that run. Test in Task 8.
5. **Two sessions exiting at once that both leased one stack**: the lock serialises them; exactly one stop call; the
   second sees the container not running and logs `already stopped`. Test in Task 11.

---

## File map

| File | Responsibility |
|---|---|
| `pipeline/lib/stacks/result.mjs` | `ok()`, `unknown()`, `allOk()` helpers |
| `pipeline/lib/stacks/paths.mjs` | state root, file names, isolation (`PIPELINE_STACKS_ONLY`) |
| `pipeline/lib/stacks/config.mjs` | machine config, shared test, modes, keep list, pause |
| `pipeline/lib/stacks/identity.mjs` | `{pid,birth}`, liveness, owning `claude` process |
| `pipeline/lib/stacks/inventory.mjs` | Docker inventory of Supabase projects + 60 s cache |
| `pipeline/lib/stacks/ledger.mjs` | append/read/repair `ledger.jsonl`, leases |
| `pipeline/lib/stacks/match.mjs` | which stacks / dev ports a tool input names |
| `pipeline/lib/stacks/register.mjs` | register flow (lock, fail-closed, just-stopped block) |
| `pipeline/lib/stacks/evidence.mjs` | C2 connections, C3 process refs, cwd checks, C4 consumer worktrees, C6, memory |
| `pipeline/lib/stacks/decide.mjs` | pure verdicts + binding check; header holds the rules |
| `pipeline/lib/stacks/act.mjs` | locked stop with re-check and post-check |
| `pipeline/lib/stacks/outcomes.mjs` | decisions log, per-generation would-stops, MISS/RESTART/CLEAN, reports |
| `pipeline/lib/stacks/dev.mjs` | dev-server binding, session-end stop, listing |
| `pipeline/lib/stacks/session-end.mjs` | the detached worker flow |
| `pipeline/lib/stacks/sweep.mjs` | the daily sweep flow |
| `pipeline/lib/schedule.mjs` | launchd/cron helpers moved out of `commands/worktrees.mjs` (re-exported there) |
| `pipeline/hooks/stack-register.mjs` | PreToolUse entry |
| `pipeline/hooks/stack-dev-bind.mjs` | PostToolUse entry |
| `pipeline/hooks/stack-session-end.mjs` | SessionEnd entry |
| `pipeline/commands/stacks.mjs` | `P stacks sweep|session-end|status|repair|init|schedule` |
| `pipeline/lib/installer.mjs`, `install.mjs` | register the three hooks; uninstall extras |
| `test/stacks-*.test.mjs`, `test/fixtures/fake-docker.mjs` | tests |
| `docs/cli.md`, `README.md`, `docs/specs/2026-10-19-stack-stop-design.md` | docs |

Test commands: `node scripts/test.mjs <name-filter>` (e.g. `node scripts/test.mjs stacks-config`); quick verify
`node scripts/verify.mjs --quick`; full `node scripts/verify.mjs`.

---

### Task 1: Foundations — result, paths, config, identity

**Files:**
- Create: `pipeline/lib/stacks/result.mjs`, `pipeline/lib/stacks/paths.mjs`, `pipeline/lib/stacks/config.mjs`,
  `pipeline/lib/stacks/identity.mjs`
- Test: `test/stacks-config.test.mjs`, `test/stacks-identity.test.mjs`

**Interfaces:**
- Produces:
  - `ok(value) → {ok:true, value}`, `unknown(reason) → {ok:false, reason}`, `allOk(results) → boolean`
  - `stacksRoot(env=process.env, home=os.homedir()) → string`
  - `stackFiles(root) → {config, mode, keep, pause, ledger, ledgerBad, actions, report, weekly, cache, locks, workers, log}`
    (all absolute; `locks` and `workers` are directories)
  - `isolation(env, root) → {isDefault, only: Set<string>|null}`; throws `StacksIsolationError` when `!isDefault && !env.PIPELINE_STACKS_ONLY`
  - `projectAllowed(project, iso) → boolean` (true when `iso.only` is null)
  - `loadMachineConfig(file) → {status:'ok'|'missing'|'invalid', error?, shared:Set<lowercase>, repos:string[], memoryDirs:string[], memoryExclude:string[], transcriptDirs:string[], devPorts:number[]}` (`~` expanded with `expandHome`)
  - `isShared({project, workdir}, cfg) → boolean`
  - `loadModes(file) → {sessionEnd, sweeper, devServers}`; `ensureModeFile(file) → void` (creates all-`report` only if absent, `wx` flag)
  - `loadKeep(file) → ok(Set<lowercase>) | unknown` (missing file ⇒ `ok(empty)`)
  - `isPaused(file) → boolean`
  - `parseLstart(text) → number|null`; `procIdentity(pid, {run}) → ok({pid,birth}) | ok(null) (no such pid) | unknown`
  - `isAlive(owner, {run}) → ok(boolean) | unknown` (alive only if same birth)
  - `findClaudeOwner({startPid=process.ppid, lookup=realLookup, run}) → ok({pid,birth}) | unknown`

- [ ] **Step 1: Write failing tests** (`test/stacks-config.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig, isShared, loadModes, ensureModeFile, loadKeep, isPaused } from '../pipeline/lib/stacks/config.mjs';
import { stacksRoot, stackFiles, isolation, projectAllowed } from '../pipeline/lib/stacks/paths.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'stacks-cfg-'));
const cfgOk = { status: 'ok', shared: new Set(['e2e-ci', 'drmed', 'eaglewatch-pipeline']) };

test('shared: config ids case-insensitive, -pipeline suffix and .verify workdir are built in', () => {
  assert.equal(isShared({ project: 'DRMed', workdir: '/x' }, cfgOk), true);
  assert.equal(isShared({ project: 'drmed', workdir: '/x' }, cfgOk), true);
  assert.equal(isShared({ project: 'acme-PIPELINE', workdir: '/x' }, { status: 'ok', shared: new Set() }), true);
  assert.equal(isShared({ project: 'p', workdir: '/r/wt/.verify/supabase-workdir' }, { status: 'ok', shared: new Set() }), true);
  assert.equal(isShared({ project: 'sa-corrections', workdir: '/r/sa.stack' }, cfgOk), false);
});

test('config missing or invalid is reported, never throws', () => {
  const d = dir();
  assert.equal(loadMachineConfig(join(d, 'none.json')).status, 'missing');
  writeFileSync(join(d, 'bad.json'), '{nope');
  assert.equal(loadMachineConfig(join(d, 'bad.json')).status, 'invalid');
  writeFileSync(join(d, 'wrong.json'), JSON.stringify({ shared: 'e2e-ci' }));
  assert.equal(loadMachineConfig(join(d, 'wrong.json')).status, 'invalid');
});

test('modes default to report; ensureModeFile never overwrites', () => {
  const d = dir(); const f = join(d, 'mode.json');
  assert.deepEqual(loadModes(f), { sessionEnd: 'report', sweeper: 'report', devServers: 'report' });
  writeFileSync(f, JSON.stringify({ sessionEnd: 'apply', sweeper: 'bogus' }));
  assert.deepEqual(loadModes(f), { sessionEnd: 'apply', sweeper: 'report', devServers: 'report' });
  ensureModeFile(f);
  assert.match(readFileSync(f, 'utf8'), /apply/);
});

test('keep list: missing = empty ok, comments ignored, unreadable = unknown', () => {
  const d = dir();
  assert.deepEqual([...loadKeep(join(d, 'keep')).value], []);
  writeFileSync(join(d, 'keep'), '# mine\nSA-Corrections\n\n');
  assert.deepEqual([...loadKeep(join(d, 'keep')).value], ['sa-corrections']);
  assert.equal(loadKeep(d).ok, false); // a directory is unreadable as a file
});

test('isolation: non-default root requires PIPELINE_STACKS_ONLY', () => {
  const root = stacksRoot({ PIPELINE_STACKS_HOME: '/tmp/x' });
  assert.throws(() => isolation({ PIPELINE_STACKS_HOME: '/tmp/x' }, root), /PIPELINE_STACKS_ONLY/);
  const iso = isolation({ PIPELINE_STACKS_HOME: '/tmp/x', PIPELINE_STACKS_ONLY: 'autostop-smoke' }, root);
  assert.equal(projectAllowed('autostop-smoke', iso), true);
  assert.equal(projectAllowed('sa-corrections', iso), false);
  assert.equal(stackFiles(root).pause, join(root, 'pause'));
});

test('pause is a plain file test', () => {
  const d = dir(); assert.equal(isPaused(join(d, 'pause')), false);
  writeFileSync(join(d, 'pause'), ''); assert.equal(isPaused(join(d, 'pause')), true);
});
```

`test/stacks-identity.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLstart, procIdentity, isAlive, findClaudeOwner } from '../pipeline/lib/stacks/identity.mjs';

const psRun = (map) => (cmd, args, opts) => {
  assert.equal(opts.env.TZ, 'UTC'); assert.equal(opts.env.LC_ALL, 'C');
  const pid = args[args.length - 1];
  if (map[pid] === 'fail') return { code: 2, stdout: '', stderr: 'ps: boom', timedOut: false };
  if (map[pid] === undefined) return { code: 1, stdout: '', stderr: '', timedOut: false };
  return { code: 0, stdout: `${map[pid]}\n`, stderr: '', timedOut: false };
};

test('parseLstart reads C-locale UTC lstart', () => {
  assert.equal(parseLstart('Mon Oct 19 02:47:17 2026'), Date.UTC(2026, 9, 19, 2, 47, 17) / 1000);
  assert.equal(parseLstart('garbage'), null);
});

test('identity: dead pid is ok(null), ps failure is unknown, reused pid is not alive', () => {
  const run = psRun({ 10: 'Mon Oct 19 02:47:17 2026', 11: 'fail' });
  assert.equal(procIdentity(12, { run }).value, null);
  assert.equal(procIdentity(11, { run }).ok, false);
  const birth = parseLstart('Mon Oct 19 02:47:17 2026');
  assert.equal(isAlive({ pid: 10, birth }, { run }).value, true);
  assert.equal(isAlive({ pid: 10, birth: birth - 5 }, { run }).value, false);
  assert.equal(isAlive({ pid: 11, birth }, { run }).ok, false);
});

test('findClaudeOwner: nearest claude ancestor; none = unknown', () => {
  const tree = { 50: { ppid: 40, comm: 'node', args: 'node hook.mjs' }, 40: { ppid: 30, comm: 'zsh', args: '/bin/zsh -c x' },
    30: { ppid: 20, comm: 'claude', args: 'claude' }, 20: { ppid: 1, comm: 'claude', args: 'claude' } };
  const lookup = (pid) => tree[pid] ?? null;
  const run = psRun({ 30: 'Mon Oct 19 02:00:00 2026' });
  assert.deepEqual(findClaudeOwner({ startPid: 50, lookup, run }).value, { pid: 30, birth: parseLstart('Mon Oct 19 02:00:00 2026') });
  assert.equal(findClaudeOwner({ startPid: 40, lookup: (p) => (p === 40 ? { ppid: 1, comm: 'zsh', args: '' } : null), run }).ok, false);
});
```

- [ ] **Step 2: Run** `node scripts/test.mjs stacks-config stacks-identity` — expect FAIL (modules missing).

- [ ] **Step 3: Implement.** Key code:

```js
// pipeline/lib/stacks/result.mjs
export const ok = (value) => ({ ok: true, value });
export const unknown = (reason) => ({ ok: false, reason: String(reason) });
export const allOk = (results) => results.every((r) => r && r.ok === true);
```

```js
// pipeline/lib/stacks/identity.mjs (excerpt)
import { run as realRun } from '../proc.mjs';
import { isClaudeCodeProcess, realLookup } from '../claude-ancestry.mjs';
import { ok, unknown } from './result.mjs';
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseLstart(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text ?? '');
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]) / 1000;
}
export const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };
export function procIdentity(pid, { run = realRun } = {}) {
  const r = run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENV, timeoutMs: 5000 });
  if (r.timedOut) return unknown('ps timed out');
  if (r.code === 1 && !r.stdout.trim()) return ok(null); // no such process
  if (r.code !== 0) return unknown(`ps exit ${r.code}: ${r.stderr.trim()}`);
  const birth = parseLstart(r.stdout.trim());
  return birth === null ? unknown(`unparsable lstart ${JSON.stringify(r.stdout.trim())}`) : ok({ pid: Number(pid), birth });
}
```

`findClaudeOwner` walks `lookup(pid)` up to 32 hops; the first entry for which `isClaudeCodeProcess({comm, args})`
is true is the owner; then `procIdentity`. Check `pipeline/lib/claude-ancestry.mjs` for the exact `realLookup`
return shape and adapt the test's fake tree to it. On win32 return `unknown('windows')`.

- [ ] **Step 4: Run** the same tests — expect PASS. Then `node scripts/verify.mjs --quick`.
- [ ] **Step 5: Commit** `feat(stacks): foundations — config, modes, keep list, isolation, process identity`.

---

### Task 2: Docker inventory + cache

**Files:**
- Create: `pipeline/lib/stacks/inventory.mjs`, `test/fixtures/fake-docker.mjs`
- Test: `test/stacks-inventory.test.mjs`

**Interfaces:**
- Consumes: `ok/unknown`, `isShared`, `loadMachineConfig` result.
- Produces:
  - `readInventory({run, cfg, realpath=fs.realpathSync}) → ok({dockerDown:boolean, stacks: Stack[]}) | unknown`
  - `Stack = {project, workdir:string|null, workdirExists:boolean, folder:string|null, shared:boolean, generation:{id,startedAt}|null, containers:[{id,name,running,startedAt}], ports:number[], volumes:string[]}`
    (`generation` = the `supabase_db_<project>` container's Id + State.StartedAt; `workdir` realpath'd when it exists)
  - `cachedInventory({file, maxAgeMs=60000, now=Date.now(), refresh}) → {inv, fresh:boolean}` where `refresh()` returns a `readInventory` result; a stale cache is returned with `fresh:false` and refreshed only when the caller calls `refreshCache({file, refresh})`.
  - `DOCKER_DOWN_RE = /Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock.*(no such file|connection refused)/i`

Docker calls (binary from seam `PIPELINE_DOCKER`, default `docker` resolved with `findOnPosixPath` + `/opt/homebrew/bin`, `/usr/local/bin`, OrbStack's `~/.orbstack/bin`):
1. `docker ps --all --filter label=com.supabase.cli.project --format {{.ID}}`
2. `docker inspect <ids…>` → JSON array: `Id`, `Name`, `Config.Labels`, `State.Running`, `State.StartedAt`,
   `NetworkSettings.Ports` (`{"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"54422"}]}`), `Mounts[].Name` where `Type=="volume"`.

- [ ] **Step 1: Failing tests** — cover: two projects grouped by label; ports collected from all containers and
  deduped/sorted; `generation` from the db container; **label without workdir (DRMed shape) ⇒ `workdir:null,
  workdirExists:false`** (Review Focus 1); workdir path with a space realpath'd; daemon-down stderr ⇒
  `ok({dockerDown:true, stacks:[]})`; timeout or invalid JSON or non-zero exit without the daemon message ⇒
  `unknown`; cache fresh/stale by mtime-free `writtenAt` field.

```js
test('DRMed-shaped container without workdir label is kept as workdir unknown', () => {
  const run = fakeDocker({ ps: 'c1\n', inspect: [container({ id: 'c1', name: '/supabase_db_DRMed', project: 'DRMed', workdir: undefined, ports: { '5432/tcp': [{ HostPort: '54322' }] } })] });
  const r = readInventory({ run, cfg: { status: 'ok', shared: new Set(['drmed']) }, realpath: (p) => p });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.stacks.map((s) => [s.project, s.workdir, s.workdirExists, s.shared]), [['DRMed', null, false, true]]);
});
test('docker daemon down is a definite "no stacks", a timeout is unknown', () => {
  assert.deepEqual(readInventory({ run: () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?', timedOut: false }), cfg: { status: 'ok', shared: new Set() } }).value, { dockerDown: true, stacks: [] });
  assert.equal(readInventory({ run: () => ({ code: 124, stdout: '', stderr: '', timedOut: true }), cfg: { status: 'ok', shared: new Set() } }).ok, false);
});
```

  `test/fixtures/fake-docker.mjs` exports `fakeDocker({ps, inspect, stats, psResult, inspectResult})` returning a
  `run` that answers by `args[0]` and records calls (`run.calls`), and `container({...})` building one inspect object.

- [ ] **Step 2:** run `node scripts/test.mjs stacks-inventory` — FAIL.
- [ ] **Step 3:** implement; `readInventory` never throws (wrap JSON.parse); `shared` uses `isShared`.
- [ ] **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): docker inventory of supabase projects with a 60 s cache`.

---

### Task 3: Ledger

**Files:** Create `pipeline/lib/stacks/ledger.mjs`; Test `test/stacks-ledger.test.mjs`

**Interfaces:**
- Produces:
  - `MAX_LINE = 4000`
  - `appendEvent(file, event) → ok | unknown` — one `JSON.stringify(event)+'\n'`, `fs.openSync(file,'a')`, `writeSync`, `fsyncSync`, close; line > MAX_LINE ⇒ `unknown('event too large')`; creates the parent dir (0700).
  - `readLedger(file) → ok(Event[]) | unknown` — missing file ⇒ `ok([])`; any unparsable or non-object line ⇒ `unknown('damaged ledger line N')`; a final line without `\n` (torn write) is also damage.
  - `leasesFor(events, stack) → Event[]` — `kind:'use'` events whose `project` equals `stack.project` (case-insensitive) OR whose `folder`/`workdir` equals the stack's folder/workdir (stack not yet running at registration time).
  - `liveOwners(events, {isAlive}) → ok(Map<"pid:birth", {owner, events}>) | unknown` (any `isAlive` unknown ⇒ unknown)
  - `repairLedger(file, badFile) → {moved:number}` — moves damaged lines to `badFile`, rewrites the rest atomically (temp + rename).
- Event shape (Task 5 writes it): `{t, kind:'use'|'dev'|'dev-post'|'dev-bind', project?, folder?, workdir?, port?, session_id, agent_id?, owner:{pid,birth}, cwd, worktree, tool, tool_use_id?}`

- [ ] **Step 1: Failing tests:** append+read round trip; 4001-char event ⇒ unknown and nothing written; damaged
  middle line ⇒ `unknown` mentioning the line number; torn last line ⇒ unknown; `repairLedger` moves exactly the bad
  lines and the result reads ok; `leasesFor` matches by folder for a not-yet-running stack; two processes appending
  1000 lines each concurrently (spawn `node -e` children) ⇒ 2000 parseable lines.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): append-only lease ledger with damage detection and repair`.

---

### Task 4: Matching tool inputs to stacks and dev ports

**Files:** Create `pipeline/lib/stacks/match.mjs`; Test `test/stacks-match.test.mjs`

**Interfaces:**
- Consumes: `Stack` from Task 2.
- Produces:
  - `DEV_RE = /\b(?:next\s+(?:dev|start)|npm\s+(?:run\s+)?(?:dev|start)|npm\s+start)\b/`
  - `devTargets(command) → [{port}]` (port from `-p N`, `--port N`, `--port=N`, `PORT=N`; default 3000)
  - `prefilter({tool, input, inventory}) → boolean` — Bash: `/supabase|\.stack\b|psql|docker\s+exec|:\d{4,5}\b|SUPABASE|PG[A-Z]+=/` or any project id / folder name / container name of `inventory` as a whole word; file tools: `input.file_path`/`input.path`/`input.notebook_path` inside any inventory folder, or any path segment ending `.stack` or equal to `supabase`.
  - `cwdChain(command, cwd) → string[]` — `[cwd, …each absolute/relative cd target applied in order]`
  - `stackTargets({tool, input, cwd, inventory, exists=fs.existsSync, realpath}) → [{project?, folder?, workdir?, via}]`
    - `via ∈ 'workdir'|'folder'|'project'|'container'|'port'|'config-search'|'path'`
    - `--workdir X` / `--workdir=X` (quoted or not) resolved against every `cwdChain` entry; accepted only where `<dir>/supabase/config.toml` exists; `project` read from that config (`project_id = "…"`).
    - bare `supabase <sub>` without `--workdir`: upward search from each chain dir for `supabase/config.toml`.
    - inventory matches: folder basename (`sa-corrections.stack`), project id whole-word, `supabase_<svc>_<project>`, `:<port>` / `127.0.0.1:<port>` / `localhost:<port>`.
    - over-matching is fine (quoted text, `true || supabase stop`) — never return a "revoke".
  - `isStartCommand(command) → boolean` (`supabase … start`)
  - `readProjectId(configToml) → string|null`

- [ ] **Step 1: Failing tests** (table-driven; inventory = `sa-corrections` at `/w/.worktrees/sa-corrections.stack`
  ports 54421/54422, plus `sub detach` with a SPACE in its path `/w/.worktrees/sub detach.stack` — Review Focus 2):

```js
const cases = [
  ['supabase status -o env --workdir ../sa-corrections.stack > ../sa-corrections.stack/.status.env', '/w/.worktrees/sa-correction-requests', ['sa-corrections']],
  ['cd /w/.worktrees/sa-correction-requests && supabase db reset --local --workdir ../sa-corrections.stack', '/', ['sa-corrections']],
  ['npx supabase test db --workdir "../sub detach.stack"', '/w/.worktrees/x', ['sub-detach']],
  ['docker exec -i supabase_db_sa-corrections psql -U postgres -c "select 1"', '/', ['sa-corrections']],
  ['SUPABASE_URL=http://127.0.0.1:54421 node scripts/seed.mjs', '/', ['sa-corrections']],
  ['true || supabase stop --workdir ../sa-corrections.stack', '/w/.worktrees/sa-correction-requests', ['sa-corrections']],
  ['echo "sa-corrections is done"', '/', ['sa-corrections']], // over-match: adds a lease, never removes one
  ['git status', '/', []],
];
```

  plus: `supabase start --workdir ../new.stack` for a folder with `supabase/config.toml` but no container ⇒
  `[{folder:'new.stack', workdir:'/w/.worktrees/new.stack', project:'new-proj', via:'workdir'}]`; bare
  `supabase start` inside a worktree whose config says `e2e-ci` ⇒ target with `project:'e2e-ci'` (the caller drops it
  as shared); Read of `/w/.worktrees/sa-corrections.stack/supabase/config.toml` ⇒ sa-corrections; `devTargets` for
  `npm run dev`, `npm start`, `next dev -p 4000`, `PORT=4017 npm run dev`, `next start --port=4001`.
- [ ] **Step 2:** FAIL. **Step 3:** implement with a small tokenizer (reuse `splitCommand` from `proc.mjs` per
  `&&`/`||`/`;`/`|`/newline segment). **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): match tool inputs to private stacks and dev ports`.

---

### Task 5: Register flow + PreToolUse hook

**Files:**
- Create: `pipeline/lib/stacks/register.mjs`, `pipeline/hooks/stack-register.mjs`
- Test: `test/stacks-register.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4; `acquire`/`release` from `pipeline/lib/locks.mjs` (lock name `stacks-<project>` lowercased and
  sanitised to `[A-Za-z0-9._-]`, `dir: files.locks`).
- Produces:
  - `register(input, deps) → Promise<{exit:0|2, message?:string, events:object[]}>`
    `input` = hook stdin JSON (`tool_name`, `tool_input`, `cwd`, `session_id`, `agent_id?`, `tool_use_id`).
    `deps = {env, platform, run, now, root, files, cfg, inventory: () => {inv, fresh}, refreshInventory, owner: () => result, acquire, release, deadlineMs:20000}`
  - Hook entry: reads stdin (pattern: `pipeline/hooks/session-version.mjs` `readInput`), builds real deps, calls
    `register`, writes `message` to stderr and exits with `exit`. win32 ⇒ exit 0 immediately.

Flow (mirror spec §1 exactly):
1. win32 ⇒ 0. Dev patterns first: for each `devTargets` ⇒ event `kind:'dev'` with `tPre` (append failure here ⇒ log
   only, exit 0: dev recording is not a safety gate).
2. `prefilter` miss ⇒ 0 (no ledger read, no docker call — Review Focus 3).
3. Inventory from cache; refresh only after a prefilter hit; `dockerDown` ⇒ log, 0; `unknown` ⇒ fail (step 6).
4. Targets = `stackTargets`, drop `shared`, drop `!projectAllowed`. None ⇒ 0.
5. Owner via `findClaudeOwner`; `worktree` = `git rev-parse --show-toplevel` of `cwd` if it is inside a
   `.worktrees/` dir or a configured repo, else `'none'`.
6. For each target: `acquire('stacks-<project>', {dir, waitMs: remaining deadline})`; if the latest `actions.jsonl`
   record for this project (read only the last 64 KB) is `stopped` newer than the inventory snapshot AND tool is Bash
   AND `!isStartCommand` ⇒ release, exit 2 with the restart message from the spec; else `appendEvent`; release.
7. Any failure in 3/5/6 ⇒ paused ? (log + exit 0) : exit 2 with
   `autostop could not register use of stack <p> (<reason>) — retry; pause with: touch <files.pause>` (+ lock path when the lock is the reason).

- [ ] **Step 1: Failing tests** (pure `register` with injected deps + 3 end-to-end `spawnSync` runs of the real hook
  with `PIPELINE_STACKS_HOME`/`PIPELINE_STACKS_ONLY` and a fake `docker` via `PIPELINE_DOCKER` seam):
  - lease written for each case of Task 4's table (one line per stack);
  - shared-only command ⇒ exit 0, no line;
  - each failure (inventory unknown, owner unknown, lock timeout, append unknown) ⇒ exit 2 with the reason; the same
    with the pause file present ⇒ exit 0 and a log line;
  - docker daemon down ⇒ exit 0;
  - `npm run dev` ⇒ `dev` event even though the stack prefilter misses (F4);
  - just-stopped: actions tail says `stopped` after snapshot ⇒ Bash `supabase status --workdir …` exit 2 with
    "was just stopped automatically", `supabase start --workdir …` exit 0 and a lease, Read of the folder exit 0;
  - **Review Focus 3:** with a 100 000-line ledger present, an unrelated `git status` and a matching command each
    finish in < 1000 ms and never open the ledger for reading (spy `readFileSync`/inject `fs`);
  - concurrency order (b) of the spec is in Task 11; here: lock held by a live fake holder ⇒ waits, then registers
    once released (use `test/fixtures/hold-lock.mjs`).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): register stack use before every tool call (fail closed, pause-aware)`.

---

### Task 6: Evidence probes (C2, C3, cwd, C4, C6, memory)

**Files:** Create `pipeline/lib/stacks/evidence.mjs`; Test `test/stacks-evidence.test.mjs`

**Interfaces:**
- Consumes: `Stack`, ledger events, `processesInside` and `transcriptMentions` from
  `pipeline/lib/worktree-prune/inspect.mjs`, PR lookup used by worktree-prune (`pipeline/lib/worktree-prune/prs.mjs` —
  read it and reuse its function for "PR state of a branch", fail closed the same way), `listWorktrees` from
  `pipeline/lib/local-branches.mjs`.
- Produces (all `ok|unknown`):
  - `connections(stack, {run}) → ok([{pid, command, port}])` — `lsof -nP -w -iTCP -sTCP:ESTABLISHED -F pcn`; a client
    line `n127.0.0.1:61234->127.0.0.1:54422` whose remote port ∈ `stack.ports`; OrbStack/Docker server-side lines
    (`…:54422->…`) are ignored. lsof non-zero exit with output ⇒ unknown (partial).
  - `processRefs(stack, {run, excludePids:Set}) → ok([{pid, command, field:'cmdline'|'env'|'cwd'}])` — `ps -axE -ww
    -o pid=,command=` (env TZ/LC_ALL as Task 1); match stack folder, absolute workdir, `supabase_<svc>_<project>`,
    project id whole-word (`(^|[^\w-])id($|[^\w-])`), `:<port>`; plus `processesInside(stack.workdir)` for cwd.
    A positive control is required: our own pid's line must appear in the ps output, else unknown.
  - `cwdInside(dirs, {run, excludePids}) → ok([{pid, dir}])` (wraps `processesInside`; `available:false` ⇒ unknown)
  - `consumerWorktrees(stack, {events, transcripts, repos, run, readFile}) → ok([{path, exists, branch, via:'ledger'|'transcript'|'env'}])` — union of ledger `worktree` fields (≠ `'none'`), transcript backfill (sessions whose Bash commands name the stack folder with `--workdir`; their `cwd` ⇒ worktree), and every worktree of every configured repo whose root `.env*` files contain `127.0.0.1:<port>` or `localhost:<port>` for a stack port.
  - `prStates(worktrees, {gh}) → ok(Map<path, {state:'OPEN'|'MERGED'|'CLOSED'|'NONE', headMatches:boolean}>) | unknown`
  - `transcriptRefs(stack, {dirs, sinceMs}) → ok([file])`
  - `memoryRefs(stack, {dirs, exclude, readFile}) → ok([file])` — any unreadable `.md` ⇒ unknown.

- [ ] **Step 1: Failing tests** with captured real-shaped fixtures (copy small excerpts of real `lsof -F pcn` and
  `ps -axE` output into the test; paths with spaces — Review Focus 2): client vs server side; partial lsof ⇒
  unknown; env-only reference (`SUPABASE_URL=http://127.0.0.1:54421` in the env part of the ps line) ⇒ field `env`;
  hyphenated id `sub-detachments` does NOT match inside `sub-detachments-followups` but DOES match `sub-detachments.stack`;
  own pid missing from ps ⇒ unknown; `.env.local` with `localhost:54421` makes that worktree a consumer; unreadable
  memory note ⇒ unknown; excluded note names ignored.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): consumer evidence probes (connections, process refs, worktrees, notes)`.

---

### Task 7: Verdicts and target binding (pure)

**Files:** Create `pipeline/lib/stacks/decide.mjs` (its header comment states the rules from the spec's Hard rules,
C1–C6 and the seven conditions, verbatim enough that a reader needs nothing else); Test `test/stacks-decide.test.mjs`

**Interfaces:**
- Produces:
  - `checkBinding(assessed, current) → {ok:boolean, reasons:string[]}` — `current = {workdirExists, workdirReal, labelWorkdirReal, configProject, labelProject, generation, shared}`; all of spec "Target binding" must agree.
  - `sessionEndVerdict(e) → {verdict:'stop'|'kept', reasons}` with
    `e = {stack, paused, keep:Result, otherLiveLeases:Result, connections:Result, processRefs:Result, cwdProcs:Result, binding}`
  - `sweepVerdict(e) → {verdict:'stop'|'kept'|'listed', reasons}` with
    `e = {stack, paused, keep, liveLeases, consumers:Result, prStates:Result, cwdProcs, connections, processRefs, uptimeMs, memory:Result, transcripts:Result, binding}`;
    `listed` = cannot decide (owner unknown / unknown probe / missing workdir); `kept` = in use.
  - `DAY_MS = 86_400_000`; uptime must be `> DAY_MS` (strict).

- [ ] **Step 1: Failing tests — mutation style.** Build one `baseSweep()` evidence object whose verdict is `stop`,
  then flip exactly one input per test and assert the verdict is not `stop` and the reason names it:

```js
const flips = {
  'shared': (e) => { e.stack.shared = true; },
  'live lease': (e) => { e.liveLeases = ok([{ owner: { pid: 9, birth: 1 } }]); },
  'no consumers known': (e) => { e.consumers = ok([]); },
  'consumer worktree open PR': (e) => { e.prStates = ok(new Map([['/w/a', { state: 'OPEN', headMatches: true }]])); },
  'merged but head differs': (e) => { e.prStates = ok(new Map([['/w/a', { state: 'MERGED', headMatches: false }]])); },
  'cwd process': (e) => { e.cwdProcs = ok([{ pid: 5, dir: '/w/a' }]); },
  'connection': (e) => { e.connections = ok([{ pid: 6, command: 'node', port: 54422 }]); },
  'process ref': (e) => { e.processRefs = ok([{ pid: 7, command: 'node x', field: 'env' }]); },
  'uptime exactly 24h': (e) => { e.uptimeMs = DAY_MS; },
  'memory mention': (e) => { e.memory = ok(['home/x.md']); },
  'keep listed': (e) => { e.keep = ok(new Set([e.stack.project])); },
  'recent transcript': (e) => { e.transcripts = ok(['/t/s.jsonl']); },
  'paused': (e) => { e.paused = true; },
  'missing workdir': (e) => { e.stack.workdirExists = false; },
  ...Object.fromEntries(['cwdProcs', 'connections', 'processRefs', 'memory', 'keep', 'transcripts', 'consumers', 'prStates', 'liveLeases']
    .map((k) => [`${k} unknown`, (e) => { e[k] = unknown('probe failed'); }])),
};
for (const [name, flip] of Object.entries(flips)) test(`sweep: ${name} prevents stop`, () => {
  const e = baseSweep(); assert.equal(sweepVerdict(e).verdict, 'stop');
  flip(e); const v = sweepVerdict(e); assert.notEqual(v.verdict, 'stop'); assert.ok(v.reasons.length > 0);
});
```

  Same pattern for `sessionEndVerdict` and for every `checkBinding` field (workdir realpath, label workdir, config
  project, label project, generation id, generation startedAt, shared — including a symlinked workdir re-pointed at a
  config whose project is `e2e-ci`).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): pure verdicts and target binding`.

---

### Task 8: Locked stop with re-check and post-check

**Files:** Create `pipeline/lib/stacks/act.mjs`; Test `test/stacks-act.test.mjs`

**Interfaces:**
- Consumes: `checkBinding`, verdict functions, `acquire/release`, inventory, `appendDecision` (Task 9 — until then
  pass a `log` callback).
- Produces:
  - `stopArgs(workdirReal) → ['stop', '--workdir', workdirReal]` (the single place the argv is built)
  - `FORBIDDEN = ['--all', '--no-backup', '--project-id']`
  - `stopStack({stack, mode, reassess, files, run, supabaseBin, acquire, release, log, now}) → Promise<{action:'stopped'|'would-stop'|'kept'|'failed'|'already-stopped'|'skipped-lock', reasons, post?}>`
    `reassess()` re-runs inventory + the caller's verdict under the lock and returns `{verdict, reasons, current}`.
  - Post-check: `docker inspect` the generation id ⇒ `State.Running === false`; `docker volume ls --filter
    label=com.supabase.cli.project=<project> -q` non-empty ⇒ `volumePresent:true`.

- [ ] **Step 1: Failing tests** with `fakeDocker` + a fake supabase `run` that records argv:
  - every `stopped` call's argv equals `stopArgs(workdirReal)` and contains none of `FORBIDDEN`; no docker call has
    `rm`, `stop` or `volume rm`;
  - re-check under the lock turns `stop` into `kept` when a lease appeared after the first assessment;
  - pause file created between assessment and lock ⇒ `kept` (paused);
  - mode `report` ⇒ `would-stop`, no supabase call;
  - **Review Focus 4:** supabase binary missing (`run` returns code 1 / ENOENT text) ⇒ `failed` with the stderr line;
    called exactly once;
  - container already not running at re-check ⇒ `already-stopped`, no call;
  - lock not acquired within 60 s (fake holder) ⇒ `skipped-lock`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): stop a stack only under its lock after a full re-check`.

---

### Task 9: Decisions log, outcomes, reports

**Files:** Create `pipeline/lib/stacks/outcomes.mjs`; Test `test/stacks-outcomes.test.mjs`

**Interfaces:**
- Produces:
  - `appendDecision(file, rec)` — `rec = {t, source:'session-end'|'sweep', project, generation, action, reasons, evidence, memBytes?}` (uses `appendEvent`)
  - `readDecisions(file) → ok(rec[]) | unknown`
  - `wouldStops(decisions) → Map<"project|genId|startedAt", rec>` — one record per generation (first wins; later
    sweeps of the same generation update `lastSeen`, never add a second would-stop)
  - `classifyUse(rec, use) → 'MISS'|'RESTART'|null` — `use = {t, birth}`; within 2 h of `rec.t`: `birth*1000 < Date.parse(rec.t)` ⇒ MISS, else RESTART; after 2 h ⇒ null
  - `outcomeSummary(decisions, uses, now) → {miss, restart, clean, gbFreed, rows}` over the last 7 days
  - `memoryOfProject(project, {run}) → ok(bytes)|unknown` — `docker stats --no-stream --format {{.Name}}\t{{.MemUsage}}`, sum rows named `supabase_*_<project>` (parse `512.3MiB / 7.6GiB`)
  - `renderReport(state) → string` (markdown; headlines in the spec's order: MISS (must be 0 to switch on), RESTART,
    CLEAN, GB freed; dangling installed hook files; damaged ledger + `P stacks repair`; listed stacks with blockers;
    dev rows) and `renderWeekly(state) → string` (the section for the weekly worktree report)

- [ ] **Step 1: Failing tests:** dedupe per generation over 3 sweeps; restarted container (new StartedAt) ⇒ new
  would-stop; MISS vs RESTART boundary at exactly the would-stop time and at 2 h; GB sum from mixed MiB/GiB; report
  contains "MISS 0" headline and the repair hint when the ledger is damaged; weekly section lists only the last 7 days.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): decision log, MISS/RESTART/CLEAN outcomes, sweep and weekly reports`.

---

### Task 10: Dev servers — binder hook, session-end stop, listing

**Files:** Create `pipeline/lib/stacks/dev.mjs`, `pipeline/hooks/stack-dev-bind.mjs`; Test `test/stacks-dev.test.mjs`

**Interfaces:**
- Consumes: ledger (`kind:'dev'` events), `findClaudeOwner`, `procIdentity`, `lookup` (claude-ancestry `realLookup`).
- Produces:
  - `listeners(port, {run}) → ok([{pid, birth, cwd}])` — `lsof -nP -w -iTCP:<port> -sTCP:LISTEN -F pn` + `procIdentity` + cwd via `lsof -a -p <pid> -d cwd -Fn`
  - `bindDev(record, {owner, run, lookup, others:Event[], now}) → {bound:{listenerPid, listenerBirth}} | {bound:null, reason}` — ancestry of the listener (walk `lookup`) must contain `owner.pid`; birth ∈ `[tPre-2, tPost+60]`; cwd inside `record.worktree`/`record.cwd`; no other session's dev record for the port whose window contains the birth; one listener binds once (check existing `dev-bind` events).
  - Hook `stack-dev-bind.mjs` (PostToolUse Bash): appends `dev-post` (`tPost`) for this `tool_use_id`; then for this
    session's unbound dev records (≥ 3 s, ≤ 10 min old) tries `bindDev` and appends `dev-bind`. Never blocks; exits 0
    always; internal deadline 8 s.
  - `devSessionEnd(owner, events, {run, kill=process.kill, mode, sleep}) → rows` — for each `dev-bind` of that owner: alive with same `{pid,birth}` and cwd inside ⇒ `would-stop`/SIGTERM then 10 s check, never SIGKILL; also emits `aliveAfterExitMs` measurement.
  - `devRows({ports, events, run, isAlive, prStates}) → [{port, pid, cwd, worktree, uptimeS, boundOwnerAlive, verdict:'owned'|'orphan candidate'|'unknown'}]`

- [ ] **Step 1: Failing tests** (Codex F3 cases): listener started by a terminal (ancestry without owner) ⇒ unbound;
  replacement listener appears before first bind (A's launch failed) ⇒ unbound (ancestry); pid reuse (same pid,
  different birth) at session end ⇒ not killed; detached listener (ppid 1 at bind time) ⇒ unbound; bound + alive ⇒
  report mode `would-stop` and no kill; apply mode ⇒ exactly one SIGTERM, no SIGKILL even if still alive after 10 s.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): bind a session's own dev server by ancestry; stop only that one`.

---

### Task 11: Session-end hook and worker

**Files:** Create `pipeline/lib/stacks/session-end.mjs`, `pipeline/hooks/stack-session-end.mjs`; Test
`test/stacks-session-end.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - Hook: stdin JSON (`reason`, `session_id`, `cwd`); `reason === 'clear'` or win32 ⇒ exit 0; else `findClaudeOwner`
    (unknown ⇒ log, exit 0), spawn `process.execPath [<home>/pipeline/bin/pipeline.mjs, 'stacks', 'session-end',
    '--owner', '<pid>:<birth>']` with `{detached:true, stdio:['ignore', logFd, logFd], env}` + `unref()`, write
    `workers/<childPid>.json`, exit 0. Whole hook ≤ 2 s.
  - `runSessionEnd({owner, deps}) → Promise<{waited, dev:rows, stacks:[{project, action, reasons}]}>`:
    1. poll `isAlive(owner)` every 2 s up to 10 min; still alive ⇒ record `session still running`, return.
    2. `devSessionEnd` first.
    3. for each stack leased by `owner` (`leasesFor` over `readLedger`; ledger unknown ⇒ record and stop deciding):
       evidence (`otherLiveLeases`, C2, C3, cwd in consumer worktrees from ledger + transcripts ≤ 24 h + env files, and
       the stack folder) → `sessionEndVerdict` → `stopStack` (mode `sessionEnd`) → `appendDecision`.
    4. re-probe C1–C3 for every would-stop/stopped project at +30 min and +120 min (`sleep` injected), record uses
       for outcome classification, then remove `workers/<pid>.json` and exit.

- [ ] **Step 1: Failing tests** (injected clock/sleep, fake probes):
  - `clear` ⇒ no spawn; `prompt_input_exit` ⇒ one spawn with the owner arg; spawn uses `detached:true` and `unref`;
  - owner still alive after 10 min ⇒ no decisions;
  - another live owner leased the stack ⇒ `kept` naming that owner;
  - surviving process from the exiting session holding a connection ⇒ `kept` (no exemption — Codex R1 #1);
  - **concurrency (spec Testing, both orders):** (a) stopper holds the lock (test seam `deps.afterLock` pauses it) →
    a `register()` for the same project waits → stop completes → register gets the lock, sees `stopped` → exit 2 with
    the restart message; (b) register holds the lock → stopper waits → `reassess` sees the new lease → `kept`;
  - **Review Focus 5:** two owners exit at once, both leased the stack, no other evidence ⇒ exactly one supabase stop
    call; the other run records `already-stopped`;
  - re-probe at +30 min sees a use by a process born before the decision ⇒ MISS recorded.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): session-end hook and detached worker`.

---

### Task 12: Sweep flow, `P stacks` command, shared schedule helpers

**Files:**
- Create: `pipeline/lib/stacks/sweep.mjs`, `pipeline/commands/stacks.mjs`, `pipeline/lib/schedule.mjs`
- Modify: `pipeline/commands/worktrees.mjs` (move `scheduleLine`, `detectTimezone`, `schedulePlist`, `applyLaunchd`,
  their constants and cron helpers into `pipeline/lib/schedule.mjs`; keep `export { … } from '../lib/schedule.mjs'`
  so existing imports and tests keep working; parameterise the run arguments so the plist runs
  `stacks sweep --apply --summary-only`)
- Modify: `docs/cli.md` (new `## stacks` section copied from `meta.usage`)
- Test: `test/stacks-sweep.test.mjs`, `test/stacks-cli.test.mjs`; existing `test/worktrees-cli.test.mjs` must pass unchanged

**Interfaces:**
- Produces:
  - `runSweep({apply, deps}) → Promise<{ok, summary, rows, report:path}>` — run lock `stacks-sweep` (`waitMs:0`,
    busy ⇒ `{ok:true, summary:'already running'}`); config not ok ⇒ report "not configured", no decisions;
    inventory; per stack: evidence → `sweepVerdict` → (`apply && modes.sweeper==='apply'`) ? `stopStack` : record;
    outcomes update — a "use" is any ledger `use` event (owner birth from the event) or C2/C3 hit after an open
    would-stop; dev rows; installed-hook health (each `~/.claude/pipeline/hooks/stack-*.mjs` exists and its
    settings.json entry is present, via `inspectHooks`) for the report headline; write `report.md` +
    `weekly-section.md`. On win32 every subcommand returns `{ok:false, error:'not supported on Windows'}` exit 2.
  - `meta.usage` lines:
    `pipeline stacks sweep [--apply] [--summary-only]   -> {ok, summary, stopped:[...], wouldStop:[...], listed:[...], kept:[...]}`
    `pipeline stacks session-end --owner PID:BIRTH   -> {ok, waited, stacks:[...], dev:[...]}`
    `pipeline stacks status   -> {ok, configured, modes, paused, leases:[...], report}`
    `pipeline stacks repair   -> {ok, moved}`
    `pipeline stacks init [--write]   -> {ok, config, written}`
    `pipeline stacks schedule (--install [--at HH:MM] | --remove | --status)   -> {ok, installed|removed, label, timezone, warning?}`
  - `init` prints the proposed config for this Mac (shared `e2e-ci`, `DRMed`, `eaglewatch-pipeline`; repos
    `~/Claude/eaglewatch`, `~/Claude/DRMed`; memoryDirs `~/claude-memory/home|eaglewatch|drmed`; memoryExclude
    `supabase-stack-autostop.md`, `MEMORY-archive.md`; devPorts `[3000, 4000, 4017]`) and writes it only with
    `--write` and only if absent.
  - schedule label `com.claude-pipeline.stacks-sweep`, default `--at 09:12`, log `cron-stacks-sweep.log` under the
    prune log dir.

- [ ] **Step 1: Failing tests:** sweep on a fixture machine reproducing today's (spec "Real … production home"
  expectations): e2e-ci/DRMed/eaglewatch-pipeline ⇒ shared rows; sa-corrections with consumer worktree
  `sa-correction-requests` open ⇒ kept; sub-detachments with live process refs ⇒ kept; a fully orphaned fixture stack
  ⇒ `wouldStop` (mode report) and zero supabase calls; `--apply` with mode report ⇒ still zero calls; config missing ⇒
  "not configured" and zero decisions; second concurrent sweep ⇒ "already running". CLI: usage text equals
  `docs/cli.md` section (the existing docs test enforces it); `init` without `--write` writes nothing; `schedule
  --install` with a fake `launchctlFn` writes the plist with the stacks label (assert XML contains
  `stacks</string>` and `sweep</string>`).
- [ ] **Step 2:** FAIL. **Step 3:** implement (move schedule helpers first, run `node scripts/test.mjs worktrees` to
  prove no regression, then the new code). **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(stacks): daily sweep and the stacks command; share schedule helpers with worktrees`.

---

### Task 13: Installer — register the three hooks; uninstall extras

**Files:** Modify `pipeline/lib/installer.mjs`, `install.mjs`, `.github/scripts/installer-round-trip.sh`; Test
`test/install.test.mjs` (extend)

**Interfaces:**
- `HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit']`
- New exports: `STACK_REGISTER_MATCHERS = ['Bash', 'Read|Edit|Write|Grep|Glob|NotebookEdit']`,
  `STACK_REGISTER_TIMEOUT_S = 30`, `STACK_HOOK_TIMEOUT_S = 10`, `ourStackGroups(home) → {PreToolUse:[…], PostToolUse:[…], SessionEnd:[…]}`
  (register via the fail-closed `handlerFor(home, 'stack-register')` with timeout 30; dev-bind and session-end as
  plain `{command:'node', args:[<path>], timeout:10}` like `sessionHandlerFor`).
- `mergeSettings` appends them; `removeOurSettings` strips them and drops emptied `PostToolUse`/`SessionEnd` keys only
  if we emptied them; `inspectHooks`/`computeDrift` expect them; `buildPlan` required hooks list adds
  `stack-register`, `stack-dev-bind`, `stack-session-end`; `formatReport` and uninstall hook count include them.
- Uninstall extras (`install.mjs` `doUninstall`): before removing files, touch `<stacks root>/pause` if the root
  exists, wait ≤ 120 s for `workers/*.json` pids to exit (report survivors), run the schedule removal for
  `com.claude-pipeline.stacks-sweep` if its plist exists. Never touches stacks, volumes, ledger, config, modes.

- [ ] **Step 1: Failing tests:** fresh install adds exactly one register group per matcher, one PostToolUse and one
  SessionEnd group, all marked ours; foreign PostToolUse/SessionEnd entries (e.g. the owner's
  `tab-event.sh`/`heartbeat.mjs` shapes) survive install, reinstall (no-op diff) and uninstall; `--check` reports no
  drift after install and reports drift when the SessionEnd entry is removed by hand; uninstall leaves foreign
  SessionEnd entries and removes ours; uninstall with a live fake worker pid waits then reports it.
  Extend `installer-round-trip.sh` to assert the three hooks appear after install and vanish after uninstall.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + quick verify.
- [ ] **Step 5: Commit** `feat(install): register the stack hooks (PreToolUse, PostToolUse, SessionEnd)`.

---

### Task 14: Docs

**Files:** Modify `README.md` ("What gets installed" table: three new hook rows + the note that dev-bind and
session-end are non-blocking and register is fail-closed; "Using it": `P stacks` with measure-first explanation and
how to switch a mode, pause, keep list); `docs/specs/2026-10-19-stack-stop-design.md` (already copied — fix module
names to match this plan: rules header in `pipeline/lib/stacks/decide.mjs`); `docs/HANDOFF.md` if it lists
subsystems. Test: `node scripts/test.mjs docs-facts skills-commands` must pass.

- [ ] **Step 1:** edit docs. **Step 2:** run the doc tests. **Step 3: Commit** `docs(stacks): README, spec names`.

---

### Task 15: Real-machine evidence (controller + verifier, not CI)

Run on the Mac from the feature worktree after full verify is green; paste results into the PR body.

- [ ] **Step 1: Isolated smoke.** `ROOT=$(mktemp -d)`; write `$ROOT/config.json` (shared as `init`, repos as `init`),
  `$ROOT/mode.json` all `apply`; `export PIPELINE_STACKS_HOME=$ROOT PIPELINE_STACKS_ONLY=autostop-smoke`; record the
  production `~/.claude/pipeline-state/stacks/mode.json` sha (or "absent") before.
- [ ] **Step 2:** scratch project: `supabase init` in a scratch dir, set `project_id = "autostop-smoke"`, shift ports
  (+3000), `supabase start -x studio,imgproxy,edge-runtime,logflare,vector,realtime,storage-api,inbucket,postgres-meta
  --workdir <dir>`; seed `create table sentinel(x int); insert into sentinel values (42);` via `docker exec -i
  supabase_db_autostop-smoke psql -U postgres`.
- [ ] **Step 3:** headless session with test settings pointing at the worktree hooks (`--settings <json>` with the
  three hook entries using worktree paths): `claude -p --model haiku --settings <json> "Run exactly this bash command
  and nothing else: supabase status --workdir <dir>"`. After it exits, wait for the worker (`workers/` empty, ≤ 3 min).
  Expect: decision `stopped` in `$ROOT/actions.jsonl`; `docker ps` shows no running `autostop-smoke` containers;
  `docker volume ls --filter label=com.supabase.cli.project=autostop-smoke` non-empty.
- [ ] **Step 4:** `supabase start …` again; `select x from sentinel` ⇒ 42 (data kept).
- [ ] **Step 5:** repeat Step 3 while a second consumer holds a connection (`docker exec -i … psql` kept open in the
  background, killed afterwards) ⇒ decision `kept` naming the process.
- [ ] **Step 6:** a second headless session that never touches the smoke stack exits during Step 5 ⇒ its worker
  records no stack decisions.
- [ ] **Step 7:** `kill -9` a headless session after it registered ⇒ no SessionEnd; `P stacks sweep` (isolated)
  shows its lease dead.
- [ ] **Step 8:** production `mode.json` sha unchanged; `supabase stop --workdir <dir>` (our own smoke stack, data
  kept) to free memory; the smoke volume stays (never delete volumes) and is listed in the PR body.
- [ ] **Step 9: Real-machine sweep, report only.** The production root has no config until the owner installs, so use
  an isolated root whose `config.json` is the `init` proposal, `mode.json` all `report`, and `PIPELINE_STACKS_ONLY`
  = today's real private stack ids. Put a `supabase` wrapper first on PATH that logs its argv and exits 1 on `stop`.
  Expected rows as in the spec (shared ×3, sub-detachments kept, sa-corrections kept) and zero `stop` calls in the
  wrapper log.

---

## After merge (owner steps, listed in the PR body)

1. Owner reinstalls on the Mac (`! node install.mjs` from the main checkout, or a `PIPELINE_ADMIN=1` session).
2. `P stacks init --write` (Claude, when the owner says so) → review the config.
3. `P stacks schedule --install` (Claude, when the owner says so).
4. Claude adds the ~10-line read-only include to `~/.claude/scripts/worktree-autoclean.mjs` (diff shown first,
   backup kept).
5. 7 days later: owner reads `report.md` (MISS must be 0) and decides whether to flip any mode to `apply`; global
   CLAUDE.md gains its one line only then.
6. PC: reinstall there too; inert until a config is written.
