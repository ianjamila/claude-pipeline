# Machine-proof speed checks (step-based test limits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ~47 speed checks in the test suite (guards, parser, hard-stops, glob, transcript) stop failing on a slower or busier machine while still catching a real blow-up.

**Architecture:** Hybrid (owner's choice, 2026-10-20), in two parts:
1. Every CPU-ms cap is multiplied by a *machine factor*. A reference workload is timed once per test process and compared with the speed this Mac gives it, so a Windows CI runner ~4× slower gets ~4× the allowance, and a fast machine never gets less than today.
2. Where the code under test already reads the evaluation clock inside the loop a test stresses, the test passes a *virtual clock*. Each read advances it by a fixed step, so both the read count and the evaluation deadline are the same on every machine. The test asserts a ceiling on that count, and for linear-scaling tests it also asserts a ceiling on how fast the count grows.

No guard decision changes in production.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, `node:assert/strict`; repo `ianjamila/claude-pipeline`; CI ubuntu (Node 20/24) + windows (Node 24).

**Spec:** this document (design agreed in chat 2026-10-20; sizing by an Explore pass on main 5f5d1c3; Codex plan review R1 folded in).

## Design (the spec)

- **Why:** CPU-ms caps flake on shared runners. On Ubuntu, a case taking ~1 s on the Mac failed its 3 s cap (#83), and Windows CI is ~4× slower than this Mac. Each flake costs a CI rerun, and inside a session it costs a whole-context retry. The real 5 s evaluation deadline is a second flake source: on a slow runner it can end a run early, so a test that expects "too many script files" gets "took too long" instead (Codex R1-3, `guard-budget` ~65).
- **In scope (group A, ~47 sites in 15 files):** every assertion that compares CPU time with a threshold. That covers `process.cpuUsage`, `cpuTime`, `cpuTimed`, `assertLinear`, and the local `cpu()` / `cpuMs()` wrappers. The files are these, each a `test/*.test.mjs`:
  - `guard-budget`, `guard-t8b`, `guard-files-bypass`
  - `guard-a2-shell`, `guard-a2-shell-s9`, `guard-a2-shell-s6`
  - `guard-line-writes`, `guard-line-hazards`, `guard-script-expansion`, `guard-git`, `guard-hidden-assignments`
  - `shell-parse`, `transcript`, `hardstops-bypass`, `glob`
- **Out of scope (group B, ~16 sites):** wall-clock checks of real waits: hung processes, lock timeouts, `startJob` returning, and notify timeouts, in `notify`, `stacks-*`, `jobs` and `locks`. A step count cannot stand in for a timer there. Unchanged.
- **Machine factor:** `factor = clamp(bestCpuMs(reference) / REF_MS, 1, 8)`, computed lazily once per process.
  - **Reference workload:** about 100–200 ms of CPU on this Mac, so a 15 ms Windows clock tick is under 15 % of a sample. Best of 3, after one discarded warm-up.
  - **`REF_MS`:** a constant in the helper, measured on this Mac.
  - **Override:** `PIPELINE_TIMING_FACTOR=<number>` sets the factor, clamped the same way. A fast machine gets factor 1, so no cap ever tightens.
  - **Logging:** each process logs its factor once through `t.diagnostic`, so CI logs show it next to the case timings.
- **Virtual clock:** `virtualClock(msPerRead)` returns an object whose `now()` does `reads += 1` and then returns `reads * msPerRead`. The evaluation budget sets `deadline = now() + 5000` on its first read, so the deadline falls at a fixed read count: about `5000 / msPerRead` reads after the first. That count is the same on every machine.
  - **Policies:** the clock is passed as `opts.now` to `evaluateGitCommand` / `evaluateBashForFiles`, which both already accept it.
  - **`simpleCommands`:** it takes `opts.expired` instead. Pass `virtualExpired(limitReads)`, which counts reads and returns `reads > limitReads`.
  - **`msPerRead`:** set per case to `5000 / (2 × CEIL)`, so the virtual deadline lies at twice the ceiling.
  - **Effect:** a case that passes today finishes on every machine, and a run-away case is cut off at a fixed count. The production clock and deadline are untouched.
- **Which cases get a step check:** only a case whose *stressed input dimension* runs through a loop that reads the clock. For each such case the implementer records, in an eligibility table, the input dimension stressed and the `file:line` of the read in that loop. The table goes in the PR body. The loops that read the clock are these:
  - shell-parse scans every 1024 / 4096 iterations (`shell-parse.mjs` ~1534, ~1550, ~2415, ~2614)
  - write-order work every 64 units (`line-writes.mjs` `tick` ~1457, ~1569)
  - `countScript` per script (`script-candidates.mjs` ~501)
  
  A case whose stressed loop does not read the clock stays CPU-only, however many reads the surrounding work makes. Example: the glob matching and directory loops at `script-candidates.mjs` ~590–653, stressed by `guard-script-expansion` ~628/655.
- **sed meter:** `applySed`'s regex work counter (`work.n`) becomes readable through an optional third argument. That is the only production-code change.
- **Step ceilings:** `CEIL` = 2× the count measured on this branch, rounded up to 2 significant figures. `FLOOR` = ⌊measured / 4⌋, at least 1, to prove the meter sees the work. The measured value goes in a comment next to the constant. Linear-scaling cases assert `reads(n) <= 2.5 × reads(n/2) + 4`, each size from its own counted run on the same shape.
- **Determinism:** a count is reproducible only along the same completed path. A step check therefore also asserts the case's expected outcome (verdict and refusal reason, as today). If a count differs between macOS, Linux and Windows (git-policy matches case per platform, ~2493), the ceiling and floor must hold on all three, as shown by CI. A case that cannot hold them keeps its CPU check only, and the PR body lists it.
- **What stays CPU-only (scaled):** code with no clock read in its loops: `pipeline/lib/hardstops.mjs`, `pipeline/lib/glob.mjs`, `pipeline/lib/transcript.mjs` `proveText`, `assigningDefaults`, `piecesMatch`, the median of ordinary commands, and every case the eligibility rule rejects.
- **#83's CPU-OR-wall check** (`guard-hidden-assignments` ~256) keeps its OR, and both caps are scaled. The evaluation it times also gets the virtual clock where eligible.

## Global Constraints

- No change to any guard's allow/refuse decision in production. The only production-code change is Task 2's optional `work` argument to `applySed`.
- Group B tests untouched.
- Every timing helper lives in `test/helpers/timing.mjs`. The local `cpu()` / `cpuMs()` wrappers in `guard-t8b`, `guard-line-hazards`, `guard-hidden-assignments`, `glob` and `hardstops-bypass` are replaced by imports.
- A failed CPU cap's message names the measured ms, the base cap, the factor and the scaled cap (e.g. `t8b shape 7: 812ms > 6000ms x1.0 = 6000ms`). A failed step check names the label, the reads, the floor and the ceiling.
- Comments follow the repo's style: a `// Why:` line only where the reason is not obvious.
- Commits end with the session's `Co-Authored-By:` trailer.
- Quick verify: `node scripts/verify.mjs --quick`; full: `node scripts/verify.mjs`. Acceptance also needs CI green on ubuntu and windows.

## Review Focus

1. **A step check that counts the wrong loop:** the eligibility table, plus Task 5's per-assertion mutation coverage.
2. **Factor runaway on a loaded machine:** factor 8 could hide a 7× slowdown there. The clamp bounds it, and the step checks still bite whatever the load. Test: the factor clamps (Task 1).
3. **Virtual deadline too close:** a case cut off by the virtual deadline must fail loudly, because its expected outcome changes. `msPerRead` = 5000 / (2·CEIL) keeps a 2× margin over the ceiling.
4. **The helper's own tests depending on the machine:** the synthetic `assertLinear` tests pin `slackFactor: 1`. Run the helper suite at factor 1 and at factor 8 (Task 1).
5. **A cap scaled DOWN:** a factor below 1 must be impossible, even on a fast CI machine (Task 1).

---

### Task 1: machine factor and virtual clock helpers

**Files:**
- Modify: `test/helpers/timing.mjs`
- Test: `test/timing.test.mjs`

**Interfaces:**
- Produces (all exported from `test/helpers/timing.mjs`):
  - `REF_MS: number`: the reference workload's best CPU ms on this Mac.
  - `referenceWork(): number`: a fixed workload shaped like guard work.
    - Builds a string of about 1 MB, scans it with `charCodeAt`, runs a few regex `exec` passes, does `Map`/`Set` inserts and string slicing.
    - Repeats in a batch until it takes ~100–200 ms of CPU on this Mac.
    - Returns a checksum so the JIT cannot drop the work.
  - `factorFrom(bestMs: number, env?: object): number`: the override `o = Number(env.PIPELINE_TIMING_FACTOR)` is used only when `Number.isFinite(o) && o > 0`; otherwise the ratio `bestMs / REF_MS`. The result is clamped to [1, 8].
  - `machineFactor(): number`: memoized. It runs one discarded warm-up, then returns `factorFrom(bestOf(3, () => cpuTime(referenceWork)), process.env)`.
  - `cpuCap(ms: number): number`: `ms * machineFactor()`.
  - `assertCpuUnder(ms: number, baseMs: number, label: string): void`: fails when `ms >= cpuCap(baseMs)`, using the Global Constraints message.
  - `virtualClock(msPerRead: number): { now: () => number, reads: number }`
  - `virtualExpired(limitReads: number): { expired: () => boolean, reads: number }`
  - `assertSteps(reads: number, { floor: number, ceil: number, label: string }): void`
  - `assertLinearSteps(readsHalf: number, readsFull: number, label: string): void`: fails unless `readsFull <= 2.5 * readsHalf + 4`.
  - `assertLinear(small, large, opts)`: gets a new option `slackFactor` (default `machineFactor()`). The slack used is `slackMs * slackFactor`.

- [ ] **Step 1: Write the failing tests** in `test/timing.test.mjs`:
  - **Existing synthetic `assertLinear` tests:** add `slackFactor: 1` to each, so they never depend on the machine.
  - **Scaled slack:** `assertLinear(() => 50, () => 200, { slackFactor: 8 })` passes, because the excess of 100 ms is under 25 × 8 = 200. With `slackFactor: 1` the same call throws `/not linear/`.
  - **`factorFrom` ratio:** it gives 1 at `REF_MS / 2` (it never scales down), 3 at `3 * REF_MS`, and 8 at `100 * REF_MS`.
  - **`factorFrom` override:** `{ PIPELINE_TIMING_FACTOR: '4' }` gives 4. `'0.5'` gives 1. With `bestMs = 4 * REF_MS`, the overrides `'abc'`, `'-2'`, `'0'` and `'Infinity'` each give 4: they fall back to the ratio.
  - **`cpuCap` / `machineFactor`:** `cpuCap(1000) === 1000 * machineFactor()`, and a second `machineFactor()` call returns the same value.
  - **`assertCpuUnder`:** `assertCpuUnder(1e9, 5, 'x')` throws `/x: 1000000000ms > 5ms x[\d.]+ = [\d.]+ms/`. `assertCpuUnder(0, 5, 'x')` passes.
  - **`virtualClock(10)`:** successive `now()` calls return 10, 20, 30, and `reads === 3`. Then the clock deadline test: `newEvalBudget(c.now)` from `pipeline/hooks/lib/script-candidates.mjs` lets 500 `checkDeadline` calls pass and throws `GuardLimit` on the 501st (deadline = 10 + 5000; the 501st call reads 5020).
  - **`virtualExpired(2)`:** returns `false, false, true` and `reads === 3`.
  - **`assertSteps`:** `assertSteps(0, { floor: 1, ceil: 10, label: 'z' })` throws `/z: 0 clock reads/`. 11 throws. 5 passes.
  - **`assertLinearSteps`:** `(10, 30, 'q')` throws; `(10, 24, 'q')` passes.
- [ ] **Step 2: Run** `node --test test/timing.test.mjs` → FAIL (exports missing).
- [ ] **Step 3: Implement** the exports. To set `REF_MS`, time `referenceWork` 10 times, each in a fresh process on this Mac (best of 3 each). Use the median, rounded up to a whole ms, and note the date and machine (`Ians-MacBook-Pro-3`) in a comment. Log the factor once per process with `t.diagnostic` from the first test that uses it, or log it from the helper on first computation with `console.log('# timing factor', f)`.
- [ ] **Step 4: Run** `node --test test/timing.test.mjs` → PASS. Run it again with `PIPELINE_TIMING_FACTOR=8` → PASS.
- [ ] **Step 5: Commit** `test(timing): machine factor for CPU caps and a virtual clock for step checks`

### Task 2: `applySed` takes an optional work meter

**Files:**
- Modify: `pipeline/hooks/lib/sed-emulate.mjs:550` (the signature and the `const work = { n: 0 }` line)
- Test: `test/guard-line-writes.test.mjs`, next to the existing applySed timing test (~2101)

**Interfaces:**
- Produces: `applySed({ args, word, vars = [], posix = false }, text, work = { n: 0 })`. The caller's object receives the regex work units `execute` charges. Existing callers pass nothing and are unchanged.

- [ ] **Step 1: Write the failing test** `applySed reports its regex work through the optional meter`:
  - Run one of the 4 programs of the ~2101 test over its 8 kB text with `const w = { n: 0 }`, and assert `w.n > 0`.
  - Extend the existing test: for each program, add `assertSteps(w.n, { floor, ceil, label })`, with the constants set by the Design rule.
  - In the same test, change its CPU cap to `assertCpuUnder(ms, 500, …)`.
- [ ] **Step 2: Run** `node --test --test-name-pattern applySed test/guard-line-writes.test.mjs` → FAIL (`w.n` stays 0).
- [ ] **Step 3: Implement**: add the third parameter and use it in place of the local object.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(sed-emulate): applySed accepts a work meter (tests count its regex work)`

### Task 3: guard and parser speed checks become machine-proof

**Files (Modify, tests only):**
- `test/guard-budget.test.mjs`
- `test/guard-t8b.test.mjs`
- `test/guard-files-bypass.test.mjs`
- `test/guard-a2-shell.test.mjs`
- `test/guard-a2-shell-s9.test.mjs`
- `test/guard-a2-shell-s6.test.mjs`
- `test/guard-line-writes.test.mjs` (~2069, ~2074)
- `test/guard-line-hazards.test.mjs`
- `test/guard-script-expansion.test.mjs`
- `test/guard-git.test.mjs`
- `test/shell-parse.test.mjs`
- `test/guard-hidden-assignments.test.mjs`

**Interfaces:** Consumes everything from Task 1.

The line numbers come from the Explore inventory on 052e586. Re-locate each site with `grep -n "cpuUsage\|cpuTime\|cpuTimed\|assertLinear\|cpu()" <file>`. Rules for every site:
- **CPU caps:** each `ms < N` CPU assertion becomes `assertCpuUnder(ms, N, '<label>')`. The label names the case, for example the shape index.
- **Eligibility first.** For each site, write a row in `.review/step-eligibility.md`: file:line, the stressed input dimension, the clock-reading loop that dimension runs through (file:line of the read), and the verdict (step / CPU-only + why). Only "step" rows get a step check.
- **Step check through a policy:** when the call goes through `evaluateGitCommand(cmd, opts)` or `evaluateBashForFiles(cmd, opts)`:
  - Pass `now: c.now` from a fresh `virtualClock(msPerRead)`, with one clock per guard so git and files are counted apart.
  - Assert the step range on `c.reads`.
  - Keep the case's existing verdict and reason assertions.
- **Step check through `simpleCommands(str, opts)`:** pass `expired: e.expired` from `virtualExpired(2 * CEIL)`, assert the step range on `e.reads`, and assert `!out.truncated` unless the case expects truncation today.
- **Measure first:**
  - Run each eligible case once with a temporary `console.log` of the count. Use a provisional clock: `virtualClock(0.001)`, or `virtualExpired(Infinity)`.
  - Set `CEIL`, `FLOOR` and `msPerRead = 5000 / (2 * CEIL)` by the Design rule, then remove the log.
  - A case whose count is below 4 has no step check, and its table row says so.
- **Linear sites:**
  - The paren scan at guard-budget ~254 keeps its CPU `assertLinear`. Add `assertLinearSteps(readsAtN, readsAt2N, label)` from one counted run at n = 20 000 and one at n = 40 000.
  - The qualifier benchmark at guard-budget ~304–313 times 16 parses at 4 000 against one at 64 000. Keep that CPU comparison as is. Add separate counted `simpleCommands(…, { maxDepth: 1, expired })` runs on the same shape at 32 000 and 64 000, and apply `assertLinearSteps` to them.
- **CPU caps only, no step checks:**
  - `piecesMatch` (line-writes ~2074)
  - `assigningDefaults` (line-hazards ~204)
  - the median-of-30 ordinary commands (files-bypass ~509)
  - the glob cases of `guard-script-expansion` (their matching and directory loops do not read the clock)
- **Local wrappers:** replace the local `cpu()` wrappers (t8b ~70, line-hazards ~188, hidden-assignments ~245) with imports from the helper.
- **hidden-assignments ~256 (#83):** keep `cpuMs < cpuCap(3000) || wallMs < cpuCap(3000)`.

- [ ] **Step 1: Convert the parser-heavy files:** `guard-budget`, `guard-t8b`, `shell-parse` and `guard-a2-shell-s6`. Write their eligibility rows, measure, and set the constants.
  Run `node --test test/guard-budget.test.mjs test/guard-t8b.test.mjs test/shell-parse.test.mjs test/guard-a2-shell-s6.test.mjs` → PASS. Run the same command again with `PIPELINE_TIMING_FACTOR=8` → PASS.
- [ ] **Step 2: Commit** `test(guards): parser speed checks scale with the machine and count steps`
- [ ] **Step 3: Convert the remaining 8 files** the same way. Run them → PASS, and again with `PIPELINE_TIMING_FACTOR=8` → PASS.
- [ ] **Step 4: Commit** `test(guards): policy speed checks scale with the machine and count steps`

### Task 4: non-guard speed checks scale with the machine

**Files (Modify, tests only):**
- `test/hardstops-bypass.test.mjs` (527–593, and its local `cpuMs` at ~15)
- `test/glob.test.mjs` (341–371)
- `test/transcript.test.mjs` (~969)

- [ ] **Step 1:** Replace each cap with `assertCpuUnder(ms, N, label)`, and the local wrappers with helper imports. `assertLinear` at hardstops ~575 keeps its explicit factor/ratio; its slack scales through the helper's default.
- [ ] **Step 2: Run** `node --test test/hardstops-bypass.test.mjs test/glob.test.mjs test/transcript.test.mjs` → PASS. Run the same command again with `PIPELINE_TIMING_FACTOR=8` → PASS.
- [ ] **Step 3: Commit** `test: hard-stop, glob and transcript speed caps scale with the machine`

### Task 5: prove every step check bites, then verify everywhere

- [ ] **Step 1: Run one mutation per clock-reading loop family that a "step" row names.** None of these is committed. Run each mutation at `PIPELINE_TIMING_FACTOR=8`, so the CPU caps stay out of the way, then restore the file with `git checkout -- <file>`.
  - **(a) Parser scans:** in `simpleCommands`, run two extra full parse passes on fresh contexts that share the same `expired`, before the real pass.
  - **(b) Write-order work:** in `line-writes.mjs`, make `tick` charge `n * 3`.
  - **(c) Script chain:** in `countScript`, call `checkDeadline` three times per script.
  - **(d) sed meter:** in `applySed`, run `execute` three times per reading, keeping the first result.
  - **(e) Growth (size-dependent):** for each linear site, run the two extra parser passes of (a) only when the source is longer than the midpoint of that site's two sizes. The paren scan uses 20 000 / 40 000, so the cut is 30 000; the qualifier uses 32 000 / 64 000, so the cut is 48 000. Only the larger run grows, so the growth ratio triples.
- [ ] **Step 2: Map every step assertion to a mutation.** In the linear tests, `assertLinearSteps` runs BEFORE the per-size `assertSteps`. A growth assertion is proven only by mutation (e) failing it with its own `not linear in clock reads` message; a ceiling failure is no evidence for it. Ceiling proofs and growth proofs are separate rows. Each one must fail under at least one mutation, with `clock reads` in the message, or a changed outcome caused by the virtual deadline.
  - Record a table in `.review/mutation-proofs.md` (uncommitted; the PR body quotes it). It has one row per step assertion: the assertion's label, the mutation that fails it, and the failing message.
  - A step assertion that no mutation fails is removed, and its table row is changed to "CPU-only".
- [ ] **Step 3: Prove the CPU message format.** Set one t8b cap to 1 ms, run at factor 1, and confirm the message format. Revert the change.
- [ ] **Step 4: Run** `node scripts/verify.mjs` → PASS (full).
- [ ] **Step 5: Re-prove after any later change.** Any change to a bound, fixture, `msPerRead` or clock rate after Step 2 (including Step 6's) re-runs the affected mutations, updates `.review/mutation-proofs.md` and re-runs Step 4. The final table names the head sha it was proven on, and every row must hold for the final constants.
- [ ] **Step 6: Push and check CI.** After the push, CI on ubuntu (Node 20/24) and windows must be green. From the CI logs, put each platform's `# timing factor` line in the PR body. If a step count fails on one platform only, apply the Determinism rule: widen the bounds to cover all three platforms, or demote the check to CPU-only and list it, then go back to Step 5.

## Not in this PR

- New step counters inside `hardstops.mjs`, `glob.mjs`, `transcript.mjs`, `assigningDefaults`, `piecesMatch` or the glob loops of `script-candidates.mjs`. The owner chose the hybrid, so these stay on scaled CPU caps.
- Group B wall-clock waits.
