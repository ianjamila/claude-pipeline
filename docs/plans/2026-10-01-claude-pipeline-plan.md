# Claude Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementer subagents run on **Sonnet**; reviews on Sonnet unless a step names Codex/Fable.

**Goal:** Build the global Claude Code build→verify→review→merge pipeline (`ianjamila/claude-pipeline` → `~/.claude`), onboard EagleWatch with it, and prove it with seven real runs.

**Architecture:** Skills (process) + subagents (judgment) + one zero-dependency Node CLI `pipeline.mjs` (every deterministic decision) + two global PreToolUse hooks. Projects carry `.claude/pipeline.yml`, `scripts/verify`, vendored CI guard scripts, and tamper-proof `pull_request_target` guard jobs. GitHub Pro branch protection is the hard boundary. Spec: `docs/specs/2026-10-01-claude-pipeline-design.md` (read §3, §5–§8, §16 before any task).

**Tech Stack:** Node ≥ 20 (ESM, `node:test`, `node:util.parseArgs`, `child_process`), git, gh CLI, codex-cli 0.154, Claude Code 2.1.285, vendored js-yaml, GitHub Actions, Supabase CLI + pgTAP, Playwright, Vercel.

---

## Conventions for every task

- Repo: `~/Claude/claude-pipeline` (abbrev. `$CP`). Run tests with `node scripts/test.mjs [name-filter]` from `$CP` (Node 20 lacks --test globbing; the runner lists `test/*.test.mjs`). Fixtures live under `test/fixtures/` and `test/helpers/` and are never named `*.test.mjs`.
- Pure logic lives in `pipeline/lib/*.mjs` and takes injected IO (`run`, `readFile`, `now`) so it is unit-testable; CLI commands in `pipeline/commands/*.mjs` wire real IO.
- Every `gh` invocation goes through `pipeline/lib/proc.mjs#gh()` which honours `PIPELINE_GH` (a command string, e.g. `node /abs/fake-gh.mjs`).
- No npm dependencies. Only vendored file: `pipeline/vendor/js-yaml.mjs`.
- Cross-platform: `path.join`, no shell for git/gh (spawn argv), configured project commands run with `shell: true`. Never assume `/` separators in tests; normalise with `toPosix()` from `pipeline/lib/paths.mjs`.
- Commit after each task with only that task's files: `git add <files> && git commit -m "<type>: <msg>"` + trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. If `index.lock` exists, wait 2 s and retry (parallel implementers).
- Command names in this plan supersede the spec §5.2 table (e.g. `deploy url` = spec `preview-url`; `triage validate` = `triage-validate`; `arbiter needed|apply` = `arbiter-needed`/`rulings-apply`; `comment --kind triage` = `triage-comment`).
- JSON to stdout, human text to stderr. Exit codes: 0 ok · 1 check failed/blocked · 2 usage/env error · 3 dependency unavailable.

## Revision 2 overrides (after Codex plan review) — READ BEFORE ANY TASK

Spec §17 (R1–R13) supersedes earlier text. Per-task deltas; each bullet is mandatory and needs tests:

- **Order:** Task 5.4's CI-side templates (`ci-guard.mjs`, `stop-verify.mjs`, `smoke.mjs`) move to new **Task 1.11** (before Task 2.1 `vendor`). Installer tests (4.1) use fixture source trees under `test/fixtures/src-tree/`, not the real skills.
- **1.4 git:** add `patchId(base, head, {exclude:[paths]})` (`git diff <mergeBase>..head -- . ':!<p>'` piped to `git patch-id --stable`), `commitTime(sha)`.
- **1.5 hardstops (R7):** add `R2-auth-removed`, `R2-sql-removed`, `R1-migration-edited` (status M/D/R under any `**/migrations/**`), config `hard_stops.auth_calls: []`; renames test old AND new paths. New test rows: removed `await requireSAScope(` (with `auth_calls:['requireSAScope']`) → hit; removed `requireRole(` generic → hit; removed `using (owner = auth.uid())` line in a new multi-line `create policy` replaced by `using (true)` → hit (R2-sql-removed + added `create policy` line); edit of an existing migration file → R1-migration-edited; rename `lib/auth/x.ts`→`lib/x.ts` → R2 via old path; test-file removals of `requireRole(` → no hit.
- **1.7 transcript (R13):** `proveModel` also returns `firstUserText`, `finalAssistantText`, `finalStopReason`; new `extractRulings({finalAssistantText})` (last fenced ```json block, else whole text). Tests: digest present/absent, `stop_reason` ≠ `end_turn` → fail, truncated (no final assistant) → fail.
- **1.9 triage/state:** state records per round `{head, patchId}` of the reviewed diff and `reviewClean:{patchId, head}` when a round exits clean; `roundOutcome` unchanged; new `reviewValidFor(state, patchId)`.
- **1.10 jobs (R6):** `startJob` refuses commands that `guard-git`/`guard-files` evaluators deny (import `evaluateGitCommand`, `evaluateBashForFiles` from the hooks; Task 3.x must therefore export those evaluators and 1.10's guard check lands after 3.2/3.3 — implement 1.10 with an injectable `policy` defaulting to allow, then wire the real evaluators in Task 3.3 Step "wire jobs").
- **New 1.11 CI-side templates:** `pipeline/templates/scripts/pipeline/{ci-guard,stop-verify,smoke}.mjs` + `test/templates.test.mjs` cases from Task 5.4 (moved here).
- **New 1.12 locks (R8, R12):** `pipeline/lib/locks.mjs`: `withLock(name, fn, {dir: ~/.claude/pipeline-state/locks, staleAfterMs, waitMs})` using `fs.mkdirSync` atomic lock dir + `owner.json {pid, host, runId, startedAt}`; stale when pid not alive (same host) or older than `staleAfterMs`; tests: contention, stale recovery, release on throw.
- **2.1 vendor:** copies the Task 1.11 templates; `--check` compares sha256.
- **2.2 preflight:** also returns `currentProduction` (latest Production deployment id/url/sha via GitHub deployments + `vercel inspect` when `production.provider: vercel`).
- **2.3 review commands:** `arbiter apply --agent-id ID --round N` (no `--file`): rulings parsed from the transcript (R13); `review-complete --pr N` (R11) removes `awaiting-review` only if `reviewValidFor(currentPatchId)`; e2e test outage (fake codex exit quota → label added) → codex ok → `review-complete` → label removed.
- **2.4 gate/merge (R2, R3, R8, R9):** `final-gate` builds the R3 evidence contract and rejects: report `mode≠full`; `steps` ≠ `expectedSteps`; any step not pass; `git.head`≠PR head; `git.tree`≠current tree; `dirty`; report older than head commit time; review not valid for current patch-id; preview sha ≠ head; required checks not `pass` (accept `skipping` only when the trusted classifier says the diff is docs-only). `merge --pr N`: re-reads PR head/labels/pause/rollback/patch-id, runs `fill(merge.command,{pr, sha: approvedHead})`, waits ≤ 15 min for MERGED, else `gh pr merge N --disable-auto` + exit 1. Records known-good Production deployment before merging. `prod-watch` (R8): lock `prod-<project>`, ownership check, targeted rollback, re-smoke, outcomes `merged|superseded|recovered|rollback-failed`. `agent-log` (R9): `agent-log stage --pr N --line …` (commit into the PR branch) and `agent-log queue --line …` / `flush` (queue file under git common dir).
- **3.2/3.3 hooks (R6):** parser unwraps `node …/pipeline.mjs job start NAME -- <cmd>` (and `pipeline job start`); guard-files denies Bash containing `disableAllHooks`; guard-files denies `pipeline.mjs protect --apply` unless admin; export `evaluateGitCommand` and `evaluateBashForFiles`; then wire them into `jobs.mjs` (Task 1.10 policy). New cases: `node ~/.claude/pipeline/bin/pipeline.mjs job start x -- gh pr edit 1 --add-label human-approved` → deny; `… job start x -- git push origin main` → deny; `echo '{"disableAllHooks":true}' > .claude/settings.local.json` → deny; `node ~/.claude/pipeline/bin/pipeline.mjs protect --apply` → deny.
- **4.1 installer (R10):** backups named `settings.json.YYYYMMDDTHHMMSSZ`; tests include a claude-home path with spaces.
- **0.2 proc (R10):** on win32, resolve executables via `where`; `.cmd`/`.bat` → spawn `cmd.exe` with `['/d','/s','/c', quoted]` (quote each arg: wrap in `"…"`, double internal `"`, caret-escape `^&|<>()%!`); tests run the quoting function on all platforms.
- **5.4 templates (R1, R4, R5, R12):** `pipeline-guards.yml` implements the R4 lifecycle + R5 label reset (`permissions: contents: read, pull-requests: write, statuses: write`; `pull-requests: write` used only to remove the two approval labels on `synchronize`). `verify.mjs` template: `expectedSteps`, `mode`, `partial` for `--only`, tree hash, dedicated Supabase instance (`--workdir` temp copy, port offset, lock), localhost-only refusal, separate Playwright smoke config + port. pgTAP template uses `set local role authenticated` + `request.jwt.claims`.
- **6.1 CI (R10):** every step `shell: bash`; install into `"$RUNNER_TEMP/claude home"` (space).
- **8.1 EagleWatch (R1, R2, R9):** `merge-gate.mjs` gains `--expect-head <sha>` (+ tests) and the blocking-label refusal; `expected-checks.mjs` registers `pipeline-guards.yml` as excused with the reason; `checks.yml` loses `paths-ignore` and gains the docs-only job-level skip; `merge.command: "npm run merge -- {pr} --no-update --expect-head {sha}"`.
- **Phase 9:** each proof records immutable base/head SHAs; P5 change = an unbounded in-memory cache in a low-traffic helper.
- **Phase 10:** reviews pin `--base <sha>` of an immutable range (claude-pipeline: root commit..tag `v0.1.0-review`; EagleWatch: onboarding PR's base..merge SHAs).

- **Revision 3 (spec §18) also binding:** 1.4 adds `contentHash()` (R3′) instead of patchId; 1.5 adds enclosing-SQL-statement classification (R7′) with the `schema.sql` predicate test; 1.9 state stores `{fromHead,toHead,contentHashAtToHead}` per round and `reviewValidFor(state, contentHash)`; 1.12 locks follow R12′; 0.2 `quoteForCmd`/spawn follow R10′ (cross-spawn port) + Windows CI `.cmd` fixture test; 2.4 prod-watch follows R8′; 5.4 `pipeline-guards.yml` implements R5′ (timeline + check-suite timestamps, owner actor check, best-effort stale-label removal); 8.1 removes the `paths:` filter in `checks.yml` and registers the guard workflow in `KNOWN_NON_GATES`.
- **Arbiter/judge transcript lookup:** ship sets the Agent `description` to `pipeline-judge R<N> <digest8>` / `pipeline-arbiter R<N> <digest8>`; `triage validate --from-tag` and `arbiter apply --tag` locate the transcript via `subagents/*.meta.json` `description` (newest within 6 h) when no agent id is given, and parse the JSON from the final assistant message. Judge transcript model is recorded (expected `claude-opus-`, warning only).
- **New CLI helpers:** `artifacts push --pr-branch B --dir D` (orphan branch `pipeline-artifacts`, returns markdown links); `followups create --round R` (gh issue per FOLLOW-UP item, label `agent-suggestion`, records URLs); `triage light-lane --round R`.
- **Hard-stop PRs:** ship runs the review loop before ending in `needs-human` (owner gets a reviewed PR); no final gate/merge.

## File map

```
$CP/
  package.json  .gitignore  VERSION  README.md
  install.mjs  install.sh  install.ps1
  pipeline/
    bin/pipeline.mjs
    commands/{config,preflight,labels,risk,integrity,codex-review,triage,arbiter,model-proof,
              state,comment,deploy,smoke,prod-watch,summary,agent-log,final-gate,merge,job,
              vendor,protect,resume}.mjs
    lib/{proc,paths,yaml,config,glob,diff,git,hardstops,risk,integrity,transcript,codex,
         triage,state,render,deploy,finalgate,jobs,labels}.mjs
    hooks/{guard-git,guard-files}.mjs  hooks/lib/{shell-parse,hook-io}.mjs
    schemas/{codex-findings,triage,rulings}.schema.json
    templates/  (see Task 6.x)
    vendor/js-yaml.mjs  vendor/README.md
  skills/{ship,verify,pipeline-setup}/SKILL.md (+ reference/*.md)
  agents/{implementer,verifier,judge,arbiter}.md
  test/*.test.mjs  test/fixtures/**
  .github/workflows/ci.yml
  .claude/pipeline.yml
  docs/{specs,plans,proofs}/
```

---

## Phase 0 — Scaffold

### Task 0.1: Repo skeleton + vendored YAML

**Files:** Create `package.json`, `.gitignore`, `VERSION`, `pipeline/vendor/js-yaml.mjs`, `pipeline/vendor/README.md`, `pipeline/lib/yaml.mjs`, `test/yaml.test.mjs`

- [ ] **Step 1:** `package.json`:
```json
{ "name": "claude-pipeline", "private": true, "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "test": "node scripts/test.mjs" } }
```
`.gitignore`: `node_modules/`, `.verify/`, `.review/`, `*.log`. `VERSION`: `0.1.0`.
- [ ] **Step 2:** Vendor js-yaml: `cd /tmp && npm pack js-yaml@latest && tar xzf js-yaml-*.tgz`. Use `package/dist/js-yaml.mjs` if present; if the latest major has no single-file ESM dist, use the newest 4.x that does (`npm pack js-yaml@4`). Copy to `pipeline/vendor/js-yaml.mjs`, prepend the LICENSE text as a block comment, record version + sha256 in `pipeline/vendor/README.md`.
- [ ] **Step 3:** Failing test `test/yaml.test.mjs`:
```js
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
test('parses nested maps, lists, strings with braces', () => {
  const y = parseYaml('a: 1\nb:\n  c: [x, y]\nd: "npm run merge -- {pr}"\n');
  assert.deepEqual(y, { a: 1, b: { c: ['x', 'y'] }, d: 'npm run merge -- {pr}' });
});
test('throws a readable error with line number on bad yaml', () => {
  assert.throws(() => parseYaml('a: [1,\n'), /line/i);
});
```
- [ ] **Step 4:** `pipeline/lib/yaml.mjs`: `export function parseYaml(text) { return yaml.load(text, { schema: yaml.JSON_SCHEMA }) }` (import default/namespace per the vendored build). Run `node scripts/test.mjsyaml.test.mjs` → PASS. Commit `chore: scaffold + vendored js-yaml`.

### Task 0.2: proc + paths helpers

**Files:** Create `pipeline/lib/proc.mjs`, `pipeline/lib/paths.mjs`, `test/proc.test.mjs`, `test/fixtures/fake-gh.mjs`

- [ ] **Step 1:** Tests:
  - `run('node', ['-e','process.stdout.write("hi")'])` → `{code:0, stdout:'hi', stderr:'', timedOut:false}`.
  - `run` with `timeoutMs: 200` on `node -e "setTimeout(()=>{},5000)"` → `timedOut:true`, `code` non-zero.
  - `runShell('echo hi', {cwd})` → stdout contains `hi` (works on Windows `cmd` and POSIX `sh`).
  - `gh(['pr','view','1','--json','number'])` with `PIPELINE_GH="node <abs>/test/fixtures/fake-gh.mjs"` → stdout from the fake.
  - `ghJson([...])` parses JSON; non-zero exit throws `GhError` carrying `{code, stderr}`.
  - `toPosix('a\\b\\c')` → `'a/b/c'`; `expandHome('~/x', '/h')` → `/h/x`; `isInside('/h/.claude/pipeline/x', '/h/.claude/pipeline')` true; case-insensitive on `win32`/`darwin`.
- [ ] **Step 2:** Implement. `run(cmd, args, {cwd, env, input, timeoutMs})` = `spawnSync` with `windowsHide:true`, `encoding:'utf8'`, `maxBuffer: 64MB`; on win32 resolve `gh`, `git`, `npm`, `codex`, `vercel` via `shell:false` + `.cmd` fallback (`where` lookup cached). `gh(args, opts)` splits `PIPELINE_GH` with a minimal quote-aware splitter (reuse `hooks/lib/shell-parse.mjs#splitArgs` once Task 3.1 lands; until then a local splitter, then refactor).
  `fake-gh.mjs`: reads `PIPELINE_FAKE_GH_SCRIPT` (path to a JSON file mapping `argv.join(' ')` regex → `{stdout, stderr, code}`), appends each call to `PIPELINE_FAKE_GH_LOG` (JSONL) so tests can assert calls.
- [ ] **Step 3:** PASS; commit `feat: proc/paths helpers + fake gh`.

---

## Phase 1 — Pure libraries (parallelisable: 1.1–1.4 independent; 1.5 needs 1.1–1.3; 1.6–1.9 independent of each other)

### Task 1.1: config

**Files:** Create `pipeline/lib/config.mjs`, `test/config.test.mjs`, `test/fixtures/pipeline-valid.yml`

Interface:
```js
export const DEFAULTS; // see below
export function validateConfig(obj) // → { ok, errors: string[], config }  (config = defaults deep-merged)
export async function loadConfig(repoDir, { readFile }) // → { ok, errors, config, path }
export function fill(template, vars) // '{pr}' etc.; unknown {x} left as is; throws if a required var missing when strict
```
`DEFAULTS`: `enforcement:'github'`, `worktree_dir:'.worktrees'`, `verify.report:'.verify/report.json'`, `verify.screenshots:'.verify/screenshots'`, `merge.command:'gh pr merge {pr} --squash --auto --delete-branch'`, `ci.draft_while_iterating:false`, `review:{codex_model:'gpt-6-astra', effort:{low:'medium',medium:'medium',high:'high',followup:'medium'}, max_rounds:3, light_lane_max_lines:50, exempt_docs_only:[]}`, `risk:{high_risk_paths:[], medium_lines:150, high_lines:600, medium_files:10}`, `hard_stops:{paths:[], patterns:[]}`, `integrity:{test_globs:[default list from spec §6.3]}`, `labels:{}`, `agent_log:'docs/agent-log.md'`, `preview:null`, `production:null`.

Tests (each a `test()`):
1. valid fixture → `ok`, defaults filled (`review.max_rounds===3`).
2. missing `version` → error `version must be 1`.
3. `enforcement:'nope'` → error mentions `github|gate`.
4. `merge.command` without `{pr}` → error.
5. `verify.full` missing → error.
6. `review.max_rounds: 9` → error `1..5`.
7. `production: {url:'https://x'}` without `smoke` → error; `production: null` ok.
8. `hard_stops.patterns[0].regex` invalid regex → error names the pattern.
9. `loadConfig` on dir without `.claude/pipeline.yml` → `{ok:false, errors:['missing .claude/pipeline.yml']}`.
10. `fill('npm run merge -- {pr}', {pr:12})` → `'npm run merge -- 12'`; `fill('{url}/login',{})` unchanged.

- [ ] Write tests → FAIL → implement → PASS → commit `feat: pipeline.yml config loader`.

### Task 1.2: glob

**Files:** Create `pipeline/lib/glob.mjs`, `test/glob.test.mjs`

`globToRegExp(glob)` and `matchAny(path, globs)`; POSIX-normalised input; supports `**`, `*`, `?`, `{a,b}`, leading `!` negation in `matchAny` lists (last match wins); dotfiles matched by `*`.

Table test (path, glob, expected): (`a/b/c.ts`,`a/**`,T) (`a/b/c.ts`,`**/*.ts`,T) (`c.ts`,`**/*.ts`,T) (`a/b.test.ts`,`**/*.test.*`,T) (`.github/workflows/x.yml`,`.github/**`,T) (`lib/sa-payroll/x.ts`,`lib/sa-payroll/**`,T) (`lib/payroll.ts`,`lib/payroll/**`,F) (`app/api/cron/sa-payroll-x/route.ts`,`app/api/cron/sa-payroll-*/**`,T) (`x/middleware.ts`,`**/middleware.{ts,js,mjs}`,T) (`middleware.ts`,`**/middleware.{ts,js,mjs}`,T) (`scripts/reseed_x.mjs`,`scripts/reseed_*`,T) (`scripts/sub/reseed_x.mjs`,`scripts/reseed_*`,F). `matchAny('a/b.ts',['**','!a/**'])` → F.

- [ ] Tests → impl → PASS → commit `feat: glob matcher`.

### Task 1.3: diff parser

**Files:** Create `pipeline/lib/diff.mjs`, `test/diff.test.mjs`, `test/fixtures/diffs/*.diff`

`parseUnifiedDiff(text)` for `git diff -M --unified=0 --no-color --no-ext-diff` output → `[{oldPath, newPath, status:'A'|'M'|'D'|'R', binary, added:[{line, text}], removed:[{line, text}]}]`; `/dev/null` handled; quoted paths with spaces handled; `\ No newline at end of file` ignored; `stats(files)` → `{files, added, removed, changedLines}`.

Fixtures + tests: add file; delete file; modify with 2 hunks; rename with edits (`similarity index`, `rename from/to`); rename without edits; binary file; path with spaces (quoted). Assert line numbers of added/removed lines.

- [ ] Tests → impl → PASS → commit `feat: unified diff parser`.

### Task 1.4: git wrapper

**Files:** Create `pipeline/lib/git.mjs`, `test/git.test.mjs`, `test/helpers/tmprepo.mjs`

`tmprepo.mjs` helper: creates a temp repo (`git init -b main`, user config), `write(path, content)`, `commit(msg)`, `branch(name)`, returns `{dir, sha()}`. Interface:
```js
export function git(args, { cwd, run })
export function mergeBase(a, b, o) ; headSha(o) ; currentBranch(o) ; isClean(o)
export function diffFiles(base, head, o) // parseUnifiedDiff of `git diff -M --unified=0 base...head`
export function showFile(ref, path, o) // null when absent
export function grepAtRef(ref, fixedString, o) // boolean, `git grep -F -q -e s ref`
export function treeFingerprint(o) // sha256(headSha + `git diff HEAD --binary` + sorted untracked list + their sha256)
```
Tests on a tmp repo: diffFiles detects added/removed lines between two commits; showFile at old ref; grepAtRef true/false; fingerprint changes after editing a tracked file and after adding an untracked file, stable otherwise.

- [ ] Tests → impl → PASS → commit `feat: git wrapper`.

### Task 1.5: hard-stops + risk

**Files:** Create `pipeline/lib/hardstops.mjs`, `pipeline/lib/risk.mjs`, `test/hardstops.test.mjs`, `test/risk.test.mjs`

```js
export function classifyHardStops({ files, config, baseEnvNames, basePkg, headPkg }) // → hits[]
//   hit = { rule:'R1-destructive'|'R2-auth'|'R3-secrets'|'R4-pipeline'|'R5-major-dep'|'R6-sensitive'|'P-path'|'P-pattern', file, line?, excerpt?, detail }
export async function collectHardStops({ base, head, cwd, config, run }) // IO wrapper: diffFiles, base env names via grepAtRef, package.json at both refs
export function assessRisk({ files, hits, config }) // → { level:'low'|'medium'|'high', reasons[], changedLines }
export function isLightLane({ level, changedLines, hits, config }) // low && changedLines < config.review.light_lane_max_lines && hits.length===0
```
Rules exactly as spec §8 (SQL rules apply to `**/*.sql` and `**/migrations/**`, with `--` line comments and `/* */` blocks stripped before matching; R6 path rules skip `*.md` and `docs/**`; R3 env-name rule: names extracted from added lines via `process\.env\.([A-Z][A-Z0-9_]*)`, `process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]`, `import\.meta\.env\.([A-Z][A-Z0-9_]*)`, `Deno\.env\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)` and flagged if not in `baseEnvNames` (the IO wrapper computes `baseEnvNames` with `grepAtRef(base, 'process.env.'+NAME)` OR `import.meta.env.`+NAME per candidate); R5 compares `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` by parsing the first `\d+(\.\d+)?(\.\d+)?` of each range — major up, or `0.x` minor up ⇒ hit; unparsable ranges (git URLs, `workspace:`) ignored).

Hard-stop test table (fixture file contents built inline):
| # | change | expect |
|---|---|---|
|1|`supabase/migrations/1_x.sql` adds `DROP TABLE foo;`|R1|
|2|migration adds `-- drop table later` only|none|
|3|migration adds `create table t(id int);`|none (universal)|
|4|migration adds `create policy p on t for select using (auth.uid() = owner);`|R2|
|5|migration adds `grant select on t to authenticated;`|R2|
|6|`lib/a.ts` adds `const k = process.env.NEW_SECRET` (absent on base)|R3|
|7|`lib/a.ts` adds `process.env.NEXT_PUBLIC_SUPABASE_URL` (present on base)|none|
|8|`.env.example` modified|R3|
|9|`.github/workflows/x.yml` modified|R4|
|10|workflow adds `${{ secrets.FOO }}`|R3 + R4|
|11|`vitest.config.ts` modified|R4|
|12|`.claude/pipeline.yml` modified|R4|
|13|package.json `next` `15.5.15`→`16.0.0`|R5|
|14|package.json `zod` `^3.22.0`→`^3.23.0`|none|
|15|package.json `foo` `0.3.0`→`0.4.0`|R5|
|16|`lib/payroll/compute.ts` modified|R6|
|17|`docs/payroll-guide.md` modified|none|
|18|`middleware.ts` modified|R2|
|19|`app/x/page.tsx` adds `createAdminClient(`|R2|
|20|migration file deleted|R1|
|21|config `hard_stops.paths:['lib/sa-payroll/**']`, `lib/sa-payroll/a.ts`|P-path (+R6)|
|22|config pattern `{name:'face', regex:'face(api|-recog)', paths:['**/*.ts']}` matched on added line|P-pattern|
|23|`app/(public)/login/page.tsx` text change|none|
|24|rename `lib/util.ts`→`lib/payroll/util.ts`|R6 on new path|
|25|`ALTER TABLE t RENAME COLUMN a TO b;`|R1|
|26|`UPDATE users SET role='admin';`|R1|

Risk tests: (a) 10 changed lines, no hits → low, light lane true; (b) 200 lines → medium; (c) 11 files × 2 lines → medium; (d) any hit → high; (e) path in `risk.high_risk_paths` → high; (f) 700 lines → high; (g) low but 60 lines → light lane false.

- [ ] Tests → impl → PASS → commit `feat: hard-stop classifier and risk level`.

### Task 1.6: integrity

**Files:** Create `pipeline/lib/integrity.mjs`, `test/integrity.test.mjs`

```js
export function checkIntegrity({ files, config, labels = [] }) // → { ok, overridden, violations:[{rule, file, line?, excerpt}] }
```
Rules (spec §6.3). Test-file = `matchAny(path, config.integrity.test_globs)`; default globs: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**`, `e2e/**`, `supabase/tests/**`.
- `test-deleted`: status D on a test file, or R from test file to non-test path.
- `skip-or-only-added`: added line in a test file matching `/\b(?:it|test|describe|suite|context)\.(?:skip|only|todo|fixme)\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\btest\.describe\.(?:skip|only|fixme)\s*\(|@pytest\.mark\.skip|\bpytest\.skip\s*\(/`, or in `**/*.sql` test files `/\bskip\s*\(/i`.
- `coverage-lowered`: in files matching `**/{vitest,jest}.config.*`, `package.json`, `**/.nycrc*`, `**/codecov.y*ml`: for each key in `lines|branches|functions|statements|threshold` a removed `key: N` and an added `key: M` with M < N; or removed `thresholds`/`coverageThreshold` key with no added counterpart.
- `assertions-edited`: removed lines in M-status test files matching `/\bexpect\s*\(|\bassert\w*\s*[.(]|\.should\b|\bt\.(?:is|ok|equal|deepEqual|throws)\b|\b(?:ok|is|isnt|results_eq|throws_ok|lives_ok)\s*\(/` AND no new test case anywhere in the diff (added line matching `/\b(?:it|test)(?:\.each)?\s*\(|\bdef test_|\bSELECT\s+(?:ok|is|results_eq|throws_ok)\b/i` or a newly added test file).
- `labels` includes `test-change-approved` → `ok:true, overridden:true`, violations still listed.

Tests: the 18 cases listed in spec-plan notes (deleted; renamed out; renamed within tests ok; `it.skip(`; `describe.only(`; `test.fixme(`; `xit(`; `.skip(` in non-test file ok; coverage 80→70 violation; 70→80 ok; assertion edit without new test violation; with new `it(` ok; new test file only ok; non-test change ok; pgTAP `SELECT skip(` violation; label override; removed whole `it` block violation; comment-only removal ok).

- [ ] Tests → impl → PASS → commit `feat: test integrity checker`.

### Task 1.7: transcript / model proof

**Files:** Create `pipeline/lib/transcript.mjs`, `test/transcript.test.mjs`, `test/fixtures/transcripts/{fable-ok,fable-wrong-effort,synthetic-error,mixed-models,empty,malformed}.jsonl` (+ matching `.meta.json`)

```js
export function findSubagentTranscript(agentId, { projectsDir, sessionId }) // → path|null (searches <projectsDir>/*/<sessionId|*>/subagents/agent-<id>.jsonl, newest mtime)
export function proveModel({ jsonlText, metaText, expectModelPrefix, expectEffort, expectMetaModel }) // → { ok, assistantLines, models:{}, efforts:{}, errors:[] }
```
Fixtures are minimal real-shaped lines, e.g.:
`{"type":"assistant","agentId":"a1","requestId":"req_1","effort":"high","perTurnEffort":"high","message":{"model":"claude-fable-5-1","content":[{"type":"text","text":"{}"}]}}`
Failure conditions (each a test): zero assistant lines; any model not starting with prefix (`<synthetic>`, `claude-opus-5-5` mid-stream); any `isApiErrorMessage:true` or `error` key; any line missing `effort` or with a different value; meta `model` present and not equal to `expectMetaModel` (default: must be absent); malformed JSON line → `ok:false` with `errors` containing `unparseable line N`. `fable-ok` → ok with `models:{'claude-fable-5-1':2}`.

- [ ] Tests → impl → PASS → commit `feat: subagent transcript model proof`.

### Task 1.8: codex helpers

**Files:** Create `pipeline/lib/codex.mjs`, `pipeline/schemas/codex-findings.schema.json`, `test/codex.test.mjs`

Schema (OpenAI structured output compatible: every object `additionalProperties:false`, all properties required):
```json
{ "type":"object","additionalProperties":false,
  "required":["summary","blocking","suggestions","worth_considering"],
  "properties":{
    "summary":{"type":"string"},
    "blocking":{"type":"array","items":{"$ref":"#/$defs/finding"}},
    "suggestions":{"type":"array","items":{"$ref":"#/$defs/finding"}},
    "worth_considering":{"type":"array","items":{"$ref":"#/$defs/finding"}}},
  "$defs":{"finding":{"type":"object","additionalProperties":false,
    "required":["title","file","line","category","detail","reasoning","testable"],
    "properties":{"title":{"type":"string"},"file":{"type":"string"},"line":{"type":"integer"},
      "category":{"type":"string","enum":["bug","security","auth","permissions","data-integrity","data-loss","broken-behaviour","performance","maintainability","testing","design","docs","other"]},
      "detail":{"type":"string"},"reasoning":{"type":"string"},"testable":{"type":"boolean"}}}}}
```
```js
export function buildCodexArgs({ cwd, model, effort, schemaPath, outPath }) // ['exec','--sandbox','read-only','--color','never','-C',cwd,'-o',outPath,'--output-schema',schemaPath,'-c',`model="${model}"`,'-c',`model_reasoning_effort="${effort}"`,'-']
export function buildReviewPrompt({ pr, title, body, base, head, risk, round, lightLane, priorRulings }) // prompt read from stdin
export function classifyCodexFailure({ code, stderr, stdout, timedOut }) // 'quota'|'auth'|'unavailable'|'error'
export function assignIds(findingsJson, round, excerptFor) // → items with id R{round}-{B|S|W}{n}, fingerprint
export function renderFindingsMarkdown(findingsJson, round)
```
Prompt must say: review ONLY `git diff <base>..<head>` in this worktree (read surrounding code as needed); bucket definitions verbatim from the brief (BLOCKING = bugs, security, data loss, broken behaviour; SUGGESTIONS = clear improvements; WORTH CONSIDERING = ideas, trade-offs, future work); every finding needs file + line + reasoning; `testable` = can a unit/integration test prove or disprove it; don't repeat items listed in `priorRulings` unless their code changed; read AGENTS.md/CLAUDE.md for project rules.
`classifyCodexFailure` tests: `usage limit reached` / `rate limit` / `429` / `insufficient_quota` / `You've hit your usage limit` → quota; `not logged in` / `401` / `Unauthorized` / `please run codex login` → auth; `ENOENT` / `command not found` / `timedOut:true` → unavailable; other non-zero → error. `assignIds` stable ids + fingerprints (sha1 of `file|normalized title|excerpt`), normalized title = lowercase, collapse whitespace, strip punctuation.

- [ ] Tests → impl → PASS → commit `feat: codex review helpers + findings schema`.

### Task 1.9: triage rules + state + render

**Files:** Create `pipeline/lib/triage.mjs`, `pipeline/lib/state.mjs`, `pipeline/lib/render.mjs`, `pipeline/schemas/{triage,rulings}.schema.json`, `test/triage.test.mjs`, `test/state.test.mjs`, `test/render.test.mjs`

Item shape (state): `{id, round, bucket:'BLOCKING'|'SUGGESTION'|'WORTH_CONSIDERING', category, title, file, line, codexReasoning, fingerprint, judge:{decision:'ACCEPT'|'FOLLOW-UP'|'REJECT', confidence:'high'|'low', reason, disputedBug, settleTest:{possible, plan}}|null, test:{status:'none'|'bug-confirmed'|'bug-disproved', evidence}, arbiter:{ruling, confidence, reasoning, agentId}|null, final:{decision, by:'judge'|'test'|'arbiter'|'cache'|'light-lane', needsHuman, reason}|null, implemented:false, followupIssue:null}`.

Judge output schema `triage.schema.json`: `{items:[{id, decision, confidence, reason, disputedBug, settleTest:{possible, plan}}]}`; rulings schema: `{rulings:[{id, ruling, confidence, reasoning}]}`.

```js
export function validateTriage(json, itemIds) ; export function validateRulings(json, itemIds)
export function arbiterNeeded(item, { lightLane }) // spec §7.3; light lane: only BLOCKING + judge REJECT|FOLLOW-UP
export function applyJudge(items, triage) ; export function applyTestResult(item, status, evidence)
export function applyRulings(items, rulings, { proofOk, agentId }) // needsHuman per §7.3
export function finalizeWithoutArbiter(items) // judge decision becomes final where arbiter not needed
export function reuseRuled(items, ruledCache) // same fingerprint → final.by='cache'
export function roundOutcome(state) // → { clean, openBlocking[], newAccepted[], needsHuman[] , reachedMax }
```
Test table: the 15 cases (BLOCKING ACCEPT high → no arbiter; BLOCKING REJECT high → arbiter; SUGGESTION FOLLOW-UP → arbiter; WORTH REJECT high → no arbiter; low confidence → arbiter; disputed bug confirmed by test → ACCEPT by test, no arbiter; disputed untestable → arbiter; light lane SUGGESTION REJECT → no arbiter, BLOCKING REJECT → arbiter; arbiter REJECT high on BLOCKING security → needsHuman; arbiter ACCEPT high on BLOCKING security → final ACCEPT; arbiter low → needsHuman; proofOk=false → all arbitrated needsHuman reason `model-proof`; cache reuse by fingerprint; fingerprint change → not reused; roundOutcome clean / reachedMax not clean).
`state.mjs`: `loadState(dir)`, `saveState(dir, s)` (write tmp + rename), `encodeForComment(s)` → base64 of gzip JSON, `decodeFromComment(body)` reading `<!-- claude-pipeline:state:BASE64 -->`.
`render.mjs`: `triageComment(state)` (marker `<!-- claude-pipeline:triage -->`, table `| Round | ID | Bucket | Finding | Decision | By | Conf. | Reason |`, embedded state marker), `summaryComment(state, {outcome, built, followups})` (order spec §10.2; Outliers first; includes Fable model-proof line `transcript: <path>, model claude-fable-5-1 ×N, effort high`), `needsHumanComment({reasons, hits})`, `blockedComment(report)`, `awaitingReviewComment(reason)`, `agentLogLine({date, pr, title, risk, rounds, arbiterCalls, outcome})`. Tests assert section order and key strings.

- [ ] Tests → impl → PASS → commit `feat: triage rules, review state, comment rendering`.

### Task 1.10: jobs (detached long-running commands)

**Files:** Create `pipeline/lib/jobs.mjs`, `test/jobs.test.mjs`

```js
export function startJob(name, command, { cwd, dir = '.review/jobs' }) // spawn detached shell command; writes <dir>/<name>/{log, meta.json:{command,pid,startedAt}}; on exit writes exit.json {code, finishedAt}
export async function waitJob(name, { cwd, timeoutMs }) // → { state:'running'|'done'|'missing', exitCode?, tail (last 40 log lines), elapsedMs }
```
Implementation: start a tiny wrapper `node pipeline/lib/job-runner.mjs <dir> -- <command>` detached (`detached:true`, `stdio:'ignore'`, `unref()`), runner spawns the shell command with output piped to the log and writes `exit.json`. Tests: quick command → wait returns done exit 0 and tail; failing command → exitCode 1; long command with `timeoutMs:300` → running; missing → missing. Starting a job whose previous run is still running → error.

- [ ] Tests → impl → PASS → commit `feat: detached job runner`.

---

## Phase 2 — CLI (needs Phase 1)

### Task 2.1: dispatcher + simple commands

**Files:** Create `pipeline/bin/pipeline.mjs`, `pipeline/commands/{config,risk,integrity,model-proof,job,vendor}.mjs`, `test/cli.test.mjs`

`pipeline.mjs <subcommand> [options]` — `parseArgs` per command; unknown subcommand → exit 2 with usage. Commands:
- `config [--repo DIR]` → `{ok, config}` / exit 2.
- `risk --base REF --head REF [--repo DIR]` → `{level, reasons, hardStops, lightLane, stats}`; exit 0 always (it's a report).
- `integrity --base REF --head REF [--labels a,b] [--repo DIR]` → `{ok, overridden, violations}`; exit 1 if not ok.
- `hardstops --base REF --head REF [--labels a,b]` → `{ok, approved, hits}`; exit 1 if hits and no `human-approved` label.
- `model-proof --agent-id ID [--session-id S] [--expect-model claude-fable-] [--expect-effort high] [--expect-meta-model M] [--projects-dir D]` → writes `.review/round-N/model-proof.json` when `--round N` given; exit 0/1/2.
- `job start NAME -- CMD...` / `job wait NAME [--timeout 540]`.
- `vendor --repo DIR [--check]` → copies `pipeline/lib/{proc,paths,yaml,config,glob,diff,git,hardstops,risk,integrity}.mjs`, `pipeline/vendor/js-yaml.mjs`, and `pipeline/templates/scripts/pipeline/{ci-guard,stop-verify,smoke}.mjs` into `<repo>/scripts/pipeline/` (`lib/`, `vendor/`), writes `scripts/pipeline/VERSION` (`<VERSION>+<git sha>`); `--check` → exit 1 listing drifted files.
CLI tests use `tmprepo` + spawn `node pipeline/bin/pipeline.mjs …`: config ok/missing; risk on a migration DROP → high + R1; integrity on a deleted test → exit 1; hardstops with `--labels human-approved` → exit 0 `approved:true`; model-proof with fixtures dir → ok/mismatch exits; vendor into temp repo then `vendor --check` → exit 0, after editing a vendored file → exit 1.

- [ ] Tests → impl → PASS → commit `feat: pipeline CLI core commands`.

### Task 2.2: GitHub-facing commands (fake gh tests)

**Files:** Create `pipeline/lib/labels.mjs`, `pipeline/lib/deploy.mjs`, `pipeline/commands/{preflight,labels,comment,deploy,resume,protect}.mjs`, `test/cli-gh.test.mjs`, `test/fixtures/gh/*.json`

- `labels ensure [--repo DIR]` → creates missing labels with colours/descriptions: needs-human `#b60205`, awaiting-review `#fbca04`, pipeline-blocked `#d93f0b`, pipeline-pause `#5319e7`, pipeline-rollback `#b60205`, agent-suggestion `#0e8a16`, agent-build `#1d76db`, human-approved `#0e8a16`, test-change-approved `#0e8a16` (`gh label list --json name`, `gh label create`).
- `preflight [--repo DIR]` → spec §5.2 shape. Enforcement probe: `gh api repos/{o}/{r}/branches/{b}/protection` → 200 parse: `protected:true` and `missing[]` = required settings not matching §6.6 (enforce_admins.enabled, required_linear_history.enabled, allow_force_pushes.enabled===false, required checks ⊇ `ci.required_checks`, PR reviews present); 403 "Upgrade to GitHub Pro" → `{protected:false, reason:'plan'}`; 404 → `{protected:false, reason:'not-protected'}`. `mode = protected && missing.length===0 ? 'github' : 'gate'`. Exit 1 when config says `github` and mode is `gate` (`canMerge:false` in output). Pause: `gh issue list --label pipeline-pause --state open --json number,title,url`; rollback same with `pipeline-rollback`. Codex: `codex --version` + `codex login status` (exit 0 → available). `PIPELINE_OFF=1` → `{off:true}` and exit 0 with `canMerge:false`. Clean: `git status --porcelain` empty.
- `comment --pr N --kind triage|summary|needs-human|blocked|awaiting-review [--outcome O]` → renders from state and upserts by marker (`gh api repos/{o}/{r}/issues/{n}/comments --paginate` → find marker → `PATCH …/issues/comments/{id}` else `POST`). Bodies passed via `--input -` (stdin JSON) to avoid quoting issues.
- `deploy url --sha SHA --environment ENV [--timeout S]` → polls `gh api repos/{o}/{r}/deployments?sha=SHA&environment=ENV` then `…/deployments/{id}/statuses` until a `success` status with `environment_url` (or `failure`/`error` → exit 1; timeout → exit 3).
- `resume list` → open PRs with label `awaiting-review` (`gh pr list --label awaiting-review --json number,title,headRefName,url`).
- `protect --repo DIR [--apply] [--checks a,b]` → prints the exact `gh api -X PUT …/protection --input -` JSON (spec §6.6) and repo-settings PATCH; with `--apply` executes them and reads back; on 403 prints "requires GitHub Pro" or "token lacks admin: run <exact command>".
Tests with fake gh: preflight on 403 → gate + canMerge false; on full protection JSON → github; pause issue open → `pause.open:true`; comment upsert PATCHes existing marker comment and POSTs when absent (assert via fake gh log); deploy url success path & timeout; protect prints exact JSON (snapshot) and `--apply` calls PUT + PATCH.

- [ ] Tests → impl → PASS → commit `feat: GitHub-facing pipeline commands`.

### Task 2.3: review-loop commands

**Files:** Create `pipeline/commands/{codex-review,triage,arbiter,state}.mjs`, `test/cli-review.test.mjs`, `test/fixtures/fake-codex.mjs`

- `codex-review --pr N --round R --base SHA --head SHA --effort E [--model M] [--repo DIR]`: writes `.review/round-R/diff.patch`, runs `codex` (honours `PIPELINE_CODEX` for tests) with `buildCodexArgs` + prompt on stdin, timeout 30 min (run via a job when called by skills — the command itself is synchronous), validates output JSON against the schema, `assignIds`, appends items to state, writes `codex.json` + `codex.md`; failures → `classifyCodexFailure` → exit 3 with `{unavailable:true, reason}`; malformed output → exit 3 `reason:'malformed'` (never treated as "no findings").
- `triage validate --round R --file F` → validates judge JSON, `applyJudge`, `reuseRuled`, then writes `triage.json`; exit 1 with errors on invalid.
- `triage settle --id ID --result bug-confirmed|bug-disproved --evidence TEXT`.
- `arbiter needed --round R` → `{needed, items[]}` and writes `.review/round-R/arbiter-input.md` with, per item: id, bucket, category, finding title/detail, Codex reasoning, judge decision+reason+confidence, test result, and a ±20-line excerpt read from the head worktree (`file`, `line`).
- `arbiter apply --round R --file RULINGS --agent-id ID [--expect-model claude-fable-] [--expect-effort high]` → runs model-proof internally first, then `applyRulings` with `proofOk`, saves `rulings.json` + `model-proof.json`; `finalizeWithoutArbiter` for the rest.
- `state show|outcome|set-outcome|record-followup --id ID --url URL|mark-implemented --ids a,b`.
Tests: fake codex writing a valid findings file → items with ids; fake codex exiting 1 with `usage limit` → exit 3 `reason:'quota'`; malformed → exit 3; triage validate rejects unknown ids; arbiter needed writes input with excerpt; arbiter apply with fixture transcript ok → rulings applied, with synthetic transcript → all needsHuman.

- [ ] Tests → impl → PASS → commit `feat: review-loop commands`.

### Task 2.4: gate, merge, smoke, prod-watch, summary, agent-log

**Files:** Create `pipeline/lib/finalgate.mjs`, `pipeline/commands/{final-gate,merge,smoke,prod-watch,summary,agent-log}.mjs`, `test/cli-gate.test.mjs`

- `final-gate --pr N`: checks, each recorded `{name, ok, detail}`: (1) `.verify/report.json` `ok`, `mode:'full'`, `git.head === PR headRefOid`, `git.dirty === false`; (2) PR labels ∩ {needs-human, awaiting-review, pipeline-blocked} = ∅; (3) preflight: not off, no pause, no rollback, `canMerge`; (4) hardstops on `merge-base..head` = none; (5) integrity ok; (6) review state `roundOutcome.clean` OR docs-only exemption (`review.exempt_docs_only` + only additions); (7) CI: `gh pr checks N --required --json name,state,bucket` (fallback without `--required` when protection absent) all `pass`; (8) `.review/preview-smoke.json` `{ok:true, sha: head}` when `preview` configured. Writes `.review/final-gate.json {ok, sha, checks, at}`; exit 1 when any fails.
- `merge --pr N`: requires `final-gate.json.ok` and `sha === current head`; runs `fill(config.merge.command, {pr})` (via `job` when `--background`); afterwards reads `gh pr view N --json state,mergeCommit` → `{merged, mergeSha}`; exit 1 if not merged.
- `smoke --target preview|production --url URL [--expect-text T] [--sha SHA]` → runs configured command with `{url}`; extra env `PIPELINE_SMOKE_EXPECT_TEXT`; writes `.review/<target>-smoke.json {ok, sha, url, output tail}`.
- `prod-watch --sha MERGE_SHA [--expect-text T] [--pr N]`: deploy url (Production env) → smoke production → ok ⇒ `{outcome:'merged'}`; fail ⇒ run `vercel rollback <known-good> --yes --timeout 3m` directly (NOT `production.rollback.command`) → create issue (label `pipeline-rollback`, body with evidence + rollback notes) → `git revert` branch `agent/revert-<pr>` from latest default branch, push, `gh pr create` labelled `needs-human` → `{outcome:'reverted', issue, revertPr}`; deployment timeout ⇒ exit 3 + issue (label `pipeline-rollback`? **no** — label `needs-human` issue "production deploy not observed").
- `summary --pr N --outcome O [--built TEXT]` → upserts summary comment; prints agent-log line.
- `agent-log --line TEXT [--pr N]` → worktree from origin/default on `agent/agent-log-<pr>-<ts>`, append line to `agent_log` (create with header `# Agent log` if missing), commit, push, `gh pr create` (title `docs: agent log #<pr>`), then `final-gate` docs-only path + `merge`.
Tests (fake gh + tmprepo): final-gate fails for dirty report / stale sha / blocking label / pause / hard-stop hit / CI pending; passes on happy path; merge refuses without gate; prod-watch: success path; failing smoke → rollback command invoked (fake via `PIPELINE_SHELL_LOG`), issue + revert PR created; agent-log creates branch + PR calls.

- [ ] Tests → impl → PASS → commit `feat: final gate, merge, smoke, prod watch, summary, agent log`.

---

## Phase 3 — Global hooks

### Task 3.1: shell parser

**Files:** Create `pipeline/hooks/lib/shell-parse.mjs`, `test/shell-parse.test.mjs`

`splitArgs(str)` (quotes, escapes) and `simpleCommands(str)` → `[{argv, env:{}, raw}]` splitting on `;`, `&&`, `||`, `|`, `&`, newlines; extracts `$(…)` and backtick bodies as additional commands; recurses into `bash|sh|zsh|dash -c <str>`, `eval <str…>`; strips wrappers `env`, `command`, `exec`, `nohup`, `time`, `sudo`, `xargs` (best-effort: `xargs git push …` keeps `git push …`), leading `VAR=val` assignments (recorded in `env`); handles `cd x && …`. Tests: 20 parse cases including nested quotes, `$(git push origin main)`, `bash -c "git push -f"`, heredoc text not executed (`cat <<EOF\ngit push origin main\nEOF` → the heredoc body is NOT a command; parser must skip heredoc bodies).

- [ ] Tests → impl → PASS → commit `feat: hook shell parser`.

### Task 3.2: guard-git

**Files:** Create `pipeline/hooks/lib/hook-io.mjs`, `pipeline/hooks/guard-git.mjs`, `test/guard-git.test.mjs`

`hook-io.mjs`: `readInput()` (stdin JSON), `deny(reason)` → prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}}` exit 0, `allow()` → exit 0 no output. Internal errors caught → fail-closed policy per spec §5.5.
Guard logic exported as `evaluateGitCommand(command, { cwd, currentBranch(dir), issueLabels(n, repoDir) })` → `{decision:'allow'|'deny', reason}` so tests don't spawn; the script wires real `git rev-parse --abbrev-ref HEAD` (cwd or `-C`) and `gh issue view N --json labels` (5 s timeout).
Tests: the 42 DENY and 24 ALLOW cases enumerated in the plan appendix A (copy them verbatim into a table-driven test). Plus a spawn test: pipe a PreToolUse JSON for `git push origin main` into `node pipeline/hooks/guard-git.mjs` → stdout deny JSON; for `git status` → empty stdout, exit 0.

- [ ] Tests → impl → PASS → commit `feat: global git guard hook`.

### Task 3.3: guard-files

**Files:** Create `pipeline/hooks/guard-files.mjs`, `test/guard-files.test.mjs`

`evaluateFileTool({tool_name, tool_input, cwd}, { home, env, platform, realpath })` → decision. Protected set from spec §5.5 relative to `home`. Bash rule: protected reference = command contains (after `~`/`$HOME`/`${HOME}`/`%USERPROFILE%`/`$env:USERPROFILE`/absolute-home normalisation, case-insensitive on win32/darwin, `\`→`/`) one of `/.claude/skills/{ship,verify,pipeline-setup}`, `/.claude/agents/{implementer,verifier,judge,arbiter}.md`, `/.claude/pipeline/`, `/.claude/settings.json` **prefixed by the home path** (or by `process.env.HOME`/`os.homedir()` expressions). Allowed when every simple command referencing them has first token in {`cat`,`head`,`tail`,`less`,`more`,`ls`,`stat`,`wc`,`grep`,`rg`,`diff`,`cmp`,`shasum`,`sha256sum`,`md5`,`file`,`find` (no `-delete`/`-exec`), `git` (`log|show|diff|status`), `jq` (no `-i`), `node` when argv[1] is `<home>/.claude/pipeline/bin/pipeline.mjs` or `<home>/.claude/pipeline/hooks/*.mjs`} and the command has no `>`/`>>` redirect to a protected path and no `tee`. Always deny: Bash containing `PIPELINE_ADMIN`; Bash invoking `install.mjs|install.sh|install.ps1` inside a claude-pipeline checkout (dir containing `pipeline/hooks/guard-files.mjs`) unless the only extra arg is `--check`; file-tool write whose content contains `PIPELINE_ADMIN`; file-tool write to `**/.claude/settings*.json` whose content contains `disableAllHooks`. Bypass: `env.PIPELINE_ADMIN === '1'` (process env).
Tests: plan appendix B (22 DENY, 14 ALLOW), run for `platform:'linux'` with `home:'/home/u'` and a subset for `platform:'win32'` with `home:'C:\\Users\\u'`; symlink case creates a real symlink in a tmp dir (skip when `fs.symlinkSync` throws EPERM).

- [ ] Tests → impl → PASS → commit `feat: global pipeline-file guard hook`.

### Task 3.4: verify Claude Code hook command form

**Files:** Create `docs/proofs/hook-exec-form.md`

- [ ] **Step 1:** In a scratch dir create `settings.json`:
```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "node", "args": ["<abs>/probe.mjs"], "timeout": 10 } ] } ] } }
```
`probe.mjs` appends its stdin to `probe.log` and denies when the command contains `DENYME`.
- [ ] **Step 2:** `claude -p --model haiku --settings ./settings.json --allowedTools "Bash" "Run the bash command: echo DENYME"`; then check `probe.log` exists and the reply says the command was blocked.
- [ ] **Step 3:** If `probe.log` missing → exec form unsupported → installer uses `command: "node \"<abs>\""` form; record the result + Claude Code version in `docs/proofs/hook-exec-form.md`. Commit `docs: hook exec-form probe`.

---

## Phase 4 — Installer

### Task 4.1: install.mjs + wrappers

**Files:** Create `install.mjs`, `install.sh`, `install.ps1`, `test/install.test.mjs`

```
node install.mjs [--claude-home DIR] [--check] [--uninstall] [--skip-file-guard] [--force]
```
Behaviour (spec §5.6): refuse when `CLAUDECODE=1` and `PIPELINE_ADMIN!=='1'` unless `--check`; copy `skills/{ship,verify,pipeline-setup}` → `<home>/skills/…`, `agents/*.md` → `<home>/agents/`, `pipeline/` → `<home>/pipeline/`; refuse overwriting a skill/agent dir/file not listed in `<home>/pipeline/INSTALLED.json` unless `--force`; backup `settings.json` to `<home>/backups/settings.json.<ISO>`; `mergeHooks(settings, ours)` pure: removes existing PreToolUse handlers whose command/args contain `/.claude/pipeline/hooks/` (after `\`→`/`), then appends guard-git (`matcher:"Bash"`, timeout 15) and — unless `--skip-file-guard` — guard-files (`matcher:"Edit|Write|MultiEdit|NotebookEdit|Bash"`, timeout 15) **as the last entry**; adds `permissions.allow` entry `Bash(node <home>/.claude/pipeline/bin/pipeline.mjs:*)` (posix path form) once; never touches other keys; writes manifest with version, `git rev-parse HEAD`, sha256 per installed file; prints a report incl. `CLAUDE_CODE_SUBAGENT_MODEL` (settings env / process env / grep of `~/.zshrc ~/.bashrc ~/.zprofile ~/.profile`, PowerShell `$PROFILE` on win32) with the note "pinned agent models still win (verified 2.1.285)", and versions of claude/codex/gh. `--check`: compute plan, print drift, exit 1 if any. `--uninstall`: remove installed files listed in manifest + our hook/allow entries.
`install.sh`: `#!/usr/bin/env sh` → `exec node "$(dirname "$0")/install.mjs" "$@"`; `install.ps1`: `node "$PSScriptRoot/install.mjs" @args; exit $LASTEXITCODE`.
Tests (temp HOME): existing settings with other PreToolUse/Stop hooks + env → after install those are untouched, ours present once, guard-files last; second install idempotent (byte-identical settings); `--skip-file-guard` omits it; uninstall restores (other hooks intact, ours gone); foreign `skills/verify` dir → refuse without `--force`; `CLAUDECODE=1` w/o admin → exit 2; `--check` after install → exit 0, after modifying an installed file → exit 1; backup file created.

- [ ] Tests → impl → PASS → commit `feat: cross-platform installer`.

---

## Phase 5 — Skills and agents (controller writes these; Sonnet reviews)

### Task 5.1: agents

**Files:** Create `agents/{implementer,verifier,judge,arbiter}.md`, `test/agents.test.mjs`

Frontmatter (exact):
- implementer: `name: implementer`, `description` (when ship/verify needs code or tests written), `model: sonnet`, `tools: Read, Edit, Write, Grep, Glob, Bash`, `color: blue`.
- verifier: `model: sonnet`, `tools: Bash, Read, Grep, Glob`, `color: green`.
- judge: `model: opus`, `effort: high`, `tools: Read, Grep, Glob`, `color: purple`.
- arbiter: `model: fable`, `effort: high`, `tools: Read, Grep, Glob`, `color: red`.
Bodies (rules to include): implementer — TDD; small commits (`git add` specific files); quick verify before returning; never push to main / force push; never edit pipeline files (.github, .claude, scripts/verify*, scripts/pipeline, test config, CODEOWNERS) unless the task says so; never weaken/skip/delete tests; synthetic data only, no real personal/client/health/biometric/payroll records; never touch production (no MCP, no prod URLs/keys); return ≤ 15-line summary + `git diff --stat` + commits list. verifier — run exactly the given command (via `pipeline job start/wait` when > 9 min possible), read the report JSON, return a table `step | status | duration | excerpt` and nothing else; never edit files. judge — input files; decide every item ACCEPT/FOLLOW-UP/REJECT with confidence and one-line reason; ACCEPT only if in scope, small, clear benefit; disputed bug ⇒ propose a `settleTest` plan; output ONLY the JSON block matching `triage.schema.json`. arbiter — input `arbiter-input.md`; rule per item with confidence + ≤ 3-sentence reasoning; be explicit when evidence is insufficient (confidence low); never identify which model you are; output ONLY JSON matching `rulings.schema.json`.
Test: parse frontmatter of each file and assert the exact fields above.

- [ ] Write → test PASS → commit `feat: pipeline subagents`.

### Task 5.2: verify skill

**Files:** Create `skills/verify/SKILL.md`, extend `test/skills.test.mjs`
Frontmatter: `name: verify`; `description` (≤ 1,024 chars, pushy): "Use whenever code changed and before saying anything is done, fixed, working, passing or ready — proves the change with the project's verify command…"; `when_to_use`. Body sections: When; Commands (`pipeline.yml` verify.full/quick; fallback discovery when missing — then say "cannot certify"); Loop (run → read `.verify/report.json` → fix → rerun; long runs via `pipeline job`); UI rule (Playwright screenshots of every affected page into `.verify/screenshots/`, then Read each image); DB rule (role-allow + role-deny test, pgTAP for Supabase); Bug rule (failing test first, show it failing); Definition of done; Evidence format (paste step table + new test names + screenshot paths); Opt-out (`PIPELINE_OFF=1` or user says so → follow the user).
Test: frontmatter present, `description.length + when_to_use.length ≤ 1536`, body contains `report.json`, `failing test first`, `screenshots`, `PIPELINE_OFF`.

- [ ] Write → test → commit `feat: verify skill`.

### Task 5.3: ship skill + references

**Files:** Create `skills/ship/SKILL.md`, `skills/ship/reference/{review-loop,pr-and-summary,proof-switches}.md`, extend `test/skills.test.mjs`
SKILL.md ≤ 500 lines: frontmatter (`name: ship`, pushy description: "Use for ANY request to build, add, fix, change, implement, refactor or ship code in a git repo — runs the autonomous build → verify → review → merge pipeline…"); Step 0 opt-out + preflight; Steps 1–8 per spec §7.1 with the exact `pipeline` commands; the main-session discipline rules: keep only summaries; long commands via `pipeline job`; **never pass `model` when invoking judge or arbiter** (except the documented `PIPELINE_ARBITER_MODEL_OVERRIDE` proof switch); hard-stops decided by `pipeline hardstops`, never by judgment; Codex exit 3 ⇒ `awaiting-review` + stop; never merge except via `pipeline merge`; resume mode ("resume pipeline reviews" → `pipeline resume list`). review-loop.md: round procedure, judge/arbiter prompts (what files to pass), settle-by-test protocol, light lane, exit rules, triage comment updates, follow-up issue template. pr-and-summary.md: PR body template, screenshots via `pipeline-artifacts` orphan branch (`git worktree add --orphan` fallback `git checkout --orphan`), needs-human paragraph template, summary + agent-log steps, prod-watch handling. proof-switches.md: `PIPELINE_TEST_COMMIT_AS_IS` (commit the given patch, skip fix cycles), `PIPELINE_TEST_FORCE_ARBITER` (send all of round 1's judged items to the arbiter), `PIPELINE_ARBITER_MODEL_OVERRIDE` (pass this model to the arbiter call) — each must be named in the PR body and summary when used.
Test: frontmatter + length limits; body contains `pipeline preflight`, `never pass`, `awaiting-review`, `pipeline merge`, `PIPELINE_OFF`.

- [ ] Write → test → commit `feat: ship skill`.

### Task 5.4: pipeline-setup skill + references + templates

**Files:** Create `skills/pipeline-setup/SKILL.md`, `skills/pipeline-setup/reference/{audit-checklist,stack-recipes}.md`, `pipeline/templates/**` (below), extend `test/skills.test.mjs`, create `test/templates.test.mjs`
Templates:
- `templates/pipeline.yml` (commented, all keys).
- `templates/scripts/verify` (POSIX shim), `templates/scripts/verify.mjs` — generic step runner: `STEPS` array at top (`{name, cmd, quick:boolean, env?}`), `--quick`, `--only a,b`, fail-fast, logs, report schema §6.2, git info, Ctrl-C safe; exported `runSteps` for tests.
- `templates/scripts/pipeline/ci-guard.mjs` — CI entry: `--check integrity|hardstops --base SHA --head SHA --labels csv` → prints a markdown summary to `$GITHUB_STEP_SUMMARY` and JSON to stdout; exit 0/1.
- `templates/scripts/pipeline/stop-verify.mjs` — spec §6.5 (+ `PIPELINE_OFF`), fingerprint cache `.verify/stop-hook.json`, loop cap 3.
- `templates/scripts/pipeline/smoke.mjs` — reads `smoke.checks` from pipeline.yml section (`[{path, status:[…], contains:[…], location_contains}]`) + `--expect-text`; GET only, `redirect:'manual'`, no cookies, 15 s timeout per request, 2 retries; JSON result.
- `templates/workflows/pipeline-guards.yml` — spec §16.1: `on: pull_request_target: types [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]`; `permissions: {contents: read, pull-requests: read, statuses: write}`; `concurrency: pipeline-guards-${{ github.event.pull_request.number }}` with `cancel-in-progress: true`; single job (`runs-on: ubuntu-latest`, timeout 5): checkout base SHA (`persist-credentials: false`), `git fetch origin +refs/pull/${{ github.event.pull_request.number }}/head:pr-head --depth=200` + base deepen, `node scripts/pipeline/ci-guard.mjs --check integrity …` and `--check hardstops …`, then post two commit statuses on `github.event.pull_request.head.sha` via `gh api repos/$REPO/statuses/$SHA -f state=success|failure -f context="Test integrity" -f description=…` (and `Hard-stop scan`), `target_url` = run URL. Never runs npm or any PR file.
- `templates/workflows/verify.yml` — for repos that want full verify in CI (not used by EagleWatch).
- `templates/CODEOWNERS`, `templates/CLAUDE-block.md`, `templates/settings.json` (Stop hook `node scripts/pipeline/stop-verify.mjs`, timeout 900; allowlist), `templates/agent-log.md`, `templates/pgtap/rls_example.test.sql`, `templates/e2e/smoke.spec.ts` (screenshots to `.verify/screenshots/<name>.png`).
SKILL.md: steps a–h (spec §5.3) with the exact commands; audit is read-only and produces a written proposal; branch `agent/pipeline-setup` in a worktree; uses `pipeline vendor`; `pipeline labels ensure`; branch protection via `pipeline protect` after the PR merges (or prints the command); asks only about hard-stops it cannot infer; the onboarding PR is `needs-human` by construction. stack-recipes.md: Node/Next.js + Supabase + Vercel (EagleWatch/DRMed shape), plain Node, Python, generic.
Tests: `templates.test.mjs` — `verify.mjs` `runSteps` on a tmp dir with fake steps (`node -e "process.exit(0)"`, `node -e "console.error('boom');process.exit(3)"`) → fail-fast, report fields, excerpt contains `boom`, later steps `not-run`; `stop-verify.mjs` with a fake quick command: no changes → allow; failing → block JSON; 3rd identical failure → allow with systemMessage; `PIPELINE_OFF=1` → allow; `smoke.mjs` against a local `http.createServer` (login page 200 with text, `/` → 307 `/login`) → ok, and with wrong expect-text → fail; `ci-guard.mjs` on tmprepo deleted test → exit 1. `pipeline-guards.yml` parsed with yaml: trigger is `pull_request_target`, no `actions/setup-node` run of PR code, checkout `ref` is the base sha, `persist-credentials: false`, permissions exactly as above.

- [ ] Write → tests → commit `feat: pipeline-setup skill and project templates`.

---

## Phase 6 — Repo CI, self-config, README, publish

### Task 6.1: repo CI + self pipeline.yml + README

**Files:** Create `.github/workflows/ci.yml`, `.claude/pipeline.yml`, `README.md`
- `ci.yml`: `on: [pull_request, push: {branches:[main]}]`; jobs `test-ubuntu` (name: `test (ubuntu)`, node 20 and 24 via two steps with `actions/setup-node`) and `test-windows` (name: `test (windows)`, node 20); each runs `node scripts/test.mjs` and `node install.mjs --claude-home "$RUNNER_TEMP/claude-home" --skip-file-guard` then `--check`.
- `.claude/pipeline.yml`: `project: claude-pipeline`, verify full/quick `node scripts/test.mjs`, `merge.command: gh pr merge {pr} --squash --auto --delete-branch`, `ci.required_checks: ["test (ubuntu)", "test (windows)"]`, `hard_stops.paths: ["**"]`, `preview: null`, `production: null`.
- README: what it is; install/update (`git pull && ./install.sh` / `.\install.ps1`, run in a terminal or launch Claude with `PIPELINE_ADMIN=1`); uninstall; one-line prompts; opt-out; enforcement matrix (spec §13); limits; troubleshooting (Codex quota → resume; model-proof failures).
- [ ] Run `node scripts/test.mjs` → all PASS. Commit `chore: CI, self pipeline config, README`.

### Task 6.2: publish
- [ ] `gh repo create ianjamila/claude-pipeline --private --source ~/Claude/claude-pipeline --remote origin --push` (initial push to main is allowed: no guard installed yet, no protection yet).
- [ ] Wait for CI (`gh run watch`), both jobs green. If Windows fails, fix + push via PR? — no protection yet, so push fixes directly to main **only** until Task 8.2 applies protection; record each.

---

## Phase 7 — Plan-level gates before touching EagleWatch

### Task 7.1: whole-repo review (Sonnet)
- [ ] Dispatch a Sonnet `superpowers:code-reviewer` over `$CP` against the spec; fix confirmed findings (implementer). Commit.

### Task 7.2: local install (file guard deferred)
- [ ] From a terminal context: `PIPELINE_ADMIN=1 node ~/Claude/claude-pipeline/install.mjs --skip-file-guard`. Check report: skills/agents/pipeline installed; guard-git present; allowlist entry; `CLAUDE_CODE_SUBAGENT_MODEL` reported.
- [ ] Headless smoke (fresh session picks up skills/agents): `claude -p --model haiku "List the agent types you can spawn and the skills named ship, verify, pipeline-setup. Reply as JSON."` from `~/Claude/eaglewatch/.worktrees/foundation` → includes implementer, verifier, judge, arbiter, ship, verify, pipeline-setup.
- [ ] Guard-git live check: `claude -p --model haiku --allowedTools Bash "Run: git push origin main --dry-run"` in a tmp repo → reply shows the hook denial.

---

## Phase 8 — Onboard EagleWatch with pipeline-setup (dogfood)

### Task 8.1: run pipeline-setup
- [ ] Owner prerequisite reminder: upgrade to GitHub Pro (protection is applied in 8.2; setup can proceed meanwhile).
- [ ] In `~/Claude/eaglewatch`: `git fetch origin && git worktree add .worktrees/pipeline-setup -b agent/pipeline-setup origin/main`; run the `pipeline-setup` skill there. Expected outputs (spec §11): `.claude/pipeline.yml`; `scripts/verify` + `scripts/verify.mjs` (steps install/typecheck/lint/unit/db/build/e2e; quick typecheck-incremental/fast-guards/vitest related); `scripts/pipeline/` via `pipeline vendor`; `.github/workflows/pipeline-guards.yml`; `checks.yml` docs-only short-circuit (`changes` job + `if:`); `static-guards.yml` path filter removed; `migration-replay.yml` + `supabase test db`; `scripts/lib/expected-checks.mjs` registry entries (`Test integrity`, `Hard-stop scan` as always-obliged status contexts; `Static guards` always obliged) + their `scripts/__tests__`; `scripts/lib/merge-gate.mjs` refuses `needs-human|awaiting-review|pipeline-blocked` (+ test); `supabase/tests/*.test.sql` pgTAP RLS tests on synthetic fixtures; `e2e/smoke/*.spec.ts` + `smoke` Playwright project; `.github/CODEOWNERS`; `.claude/settings.json`; `CLAUDE.md` block (passes `npm run lint:claude-md`); `.gitignore` `.verify/ .review/`; `docs/agent-log.md`; labels ensured.
- [ ] Full verify green on the branch (`pipeline job start verify -- node scripts/verify.mjs` / `job wait`), evidence in PR body.
- [ ] `gha-security-review` skill on `pipeline-guards.yml`; fix findings.
- [ ] PR opened, `needs-human` (pipeline files). Ask the owner to review + merge (or explicitly authorise the controller to merge it).

### Task 8.2: branch protection
- [ ] After Pro is active and 8.1 merged: `pipeline protect --repo ~/Claude/eaglewatch/.worktrees/foundation --apply` (checks: `Typecheck + Vitest`, `Static guards`, `Test integrity`, `Hard-stop scan`, `Vercel`), repo settings (auto-merge on, squash only, default workflow permissions read). Same for `ianjamila/claude-pipeline` (`test (ubuntu)`, `test (windows)`). Read back; `pipeline preflight` → `enforcement.mode: github`.

---

## Phase 9 — Proofs (EagleWatch, real pipeline)

Run each ship invocation in a **fresh headless session** from the EagleWatch container root so the run looks exactly like real use, with Sonnet as the main-session model (proves "works whichever model runs the main session"):
`claude -p --model sonnet --permission-mode auto --output-format stream-json --verbose "<prompt>" > ~/Claude/claude-pipeline/docs/proofs/runs/<n>.jsonl` launched via `pipeline job start proof-<n> -- …` and monitored with `job wait`. (`auto` is the owner's normal mode. If it refuses a needed command, add a narrow rule to the project allowlist and rerun — never `bypassPermissions` / `--dangerously-skip-permissions`.) Evidence collected into `docs/proofs/2026-10-01-proofs.md`.

- [ ] **P1** — prompt: "Use ship: change the subtitle text on the public login page to '<new text>'." Expect auto-merge, Production deployment for the merge SHA, prod smoke finds text, summary + agent-log PR merged. Then "Use ship: revert the login subtitle change from #<n>." Expect same.
- [ ] **P2** — `PIPELINE_TEST_COMMIT_AS_IS=1`, prompt with a patch that breaks a unit test. Expect verify red → draft PR `pipeline-blocked`, never merged.
- [ ] **P3** — prompt: "Use ship: add a migration that tightens the select policy on <synthetic-fixture table>." Expect Hard-stop scan red, `needs-human`, left open; nothing applied to prod.
- [ ] **P4** — throwaway branch (manual, not ship): delete a test file that fails, open PR → `Test integrity` red; `npm run merge` refuses.
- [ ] **P5** — prompt a change with a deliberate trade-off (e.g. an unbounded in-memory cache in a low-traffic helper). Expect judge dispute → arbiter → model-proof `claude-fable-5-1` effort high → ruling in summary Outliers. If the judge doesn't dispute, document and rerun with `PIPELINE_TEST_FORCE_ARBITER=1`.
- [ ] **P6** — `PIPELINE_ARBITER_MODEL_OVERRIDE=claude-nonexistent-0` + `PIPELINE_TEST_FORCE_ARBITER=1` on a small change → `model_not_found` → model-proof fails → `needs-human`.
- [ ] **P7** — open issue "Pipeline paused (proof 7)" labelled `pipeline-pause`; small change via ship → PR opened, not merged; preflight shows paused; close issue (owner action or controller with explicit note — the guard blocks agents; controller uses `!`-equivalent terminal step documented).
- [ ] Cleanup: close P2–P7 PRs + delete branches, close test issues; P1 reverted via ship. Record links.

---

## Phase 10 — Post-build reviews (owner-mandated)

### Task 10.1: Codex Astra high
- [ ] `node ~/.claude/skills/codex-review/scripts/review.mjs --worktree ~/Claude/claude-pipeline --context-file <ctx> --base <first commit> --model astra --effort high` (no pipe); open report, confirm `Status: Completed`. Same for the EagleWatch onboarding diff (`--base origin/main` on the merged commit range).
### Task 10.2: Fable high
- [ ] `claude -p --model fable --effort high --allowedTools "Read,Grep,Glob" --output-format json "<review prompt + paths>"` → confirm `modelUsage` contains only `claude-fable-5-1` and save the review.
### Task 10.3: fix + reinstall
- [ ] Triage both reviews (judge-style), fix confirmed findings with implementers + tests, PRs on claude-pipeline (protected now → owner merges since `hard_stops: **`), reinstall `--skip-file-guard`.

---

## Phase 11 — Install the file guard last
- [ ] `PIPELINE_ADMIN=1 node install.mjs` (full). Prove: headless `claude -p --model haiku "Edit ~/.claude/skills/ship/SKILL.md: add a blank line at the end"` → denied; `PIPELINE_ADMIN=1 claude -p …` → allowed (then revert with admin); `claude -p "Run: export PIPELINE_ADMIN=1"` → denied. Record in proofs doc.

## Phase 12 — Optional: agent-build Action
- [ ] Only after Phases 9–11 pass: `templates/workflows/agent-build.yml` (spec §14) in EagleWatch via ship (needs-human). Test Codex + Fable auth on the runner with a dry `workflow_dispatch`; report.

## Phase 13 — Finish
- [ ] Final report: files (global vs per-project), GitHub-enforced vs skill-enforced, what couldn't be set up and why, the two one-line prompts. Update memory (project + feedback files) and the EagleWatch atlas hand-notes if relevant.

---

## Appendix A — guard-git cases

DENY: `git push origin main` · `git push origin HEAD:main` · `git push origin HEAD:refs/heads/main` · `git push origin feature:master` · `git push --force origin agent/x` · `git push -f` · `git push origin +agent/x` · `git push --force-with-lease origin agent/x` · `git push --force-with-lease=agent/x:abc origin agent/x` · `git push --force-if-includes origin agent/x` · `git push origin :main` · `git push origin --delete main` · `git push --all origin` · `git push --mirror origin` · `cd repo && git push origin main` · `git -C /repo push origin main` · `FOO=1 git push origin main` · `bash -c "git push origin main"` · `sh -c 'git push -f'` · `echo hi; git push origin main` · `git push origin main 2>&1 | tail -5` · `git push` (branch main) · `git push origin` (branch master) · `git push origin HEAD` (branch main) · `gh pr merge 12 --admin --squash` · `gh api -X PUT repos/o/r/branches/main/protection --input p.json` · `gh api --method DELETE repos/o/r/branches/main/protection` · `gh api repos/o/r/rulesets -X POST --input r.json` · `gh api -X PATCH repos/o/r -f allow_auto_merge=false` · `gh repo edit --enable-auto-merge=false` · `gh pr edit 12 --add-label human-approved` · `gh pr edit 12 --add-label "bug,test-change-approved"` · `gh issue edit 5 --remove-label pipeline-pause` · `gh pr edit 12 --remove-label needs-human` · `gh api repos/o/r/issues/12/labels -f "labels[]=human-approved"` · `gh api -X DELETE repos/o/r/issues/12/labels/needs-human` · `gh issue close 7` (issue 7 labelled pipeline-pause) · `gh issue close 7` (lookup fails) · `eval "git push origin main"` · `git push origin main --dry-run` · `echo $(git push origin main)` · `git push origin refs/heads/agent/x:refs/heads/main`.

ALLOW: `git push -u origin agent/feature-x` · `git push origin agent/x` (branch agent/x) · `git push origin HEAD` (branch agent/x) · `git push` (branch agent/x) · `git status` · `git log main..HEAD` · `git checkout main` · `git pull origin main` · `git fetch origin main` · `git merge origin/main` · `echo "git push origin main"` · `gh pr merge 12 --squash --auto --delete-branch` · `gh api repos/o/r/branches/main/protection` · `gh pr edit 12 --add-label needs-human` · `gh pr edit 12 --remove-label run-e2e` · `gh issue close 9` (no guarded label) · `gh pr view 12 --json labels` · `npm run merge -- 12` · `git push origin agent/main-menu-fix` · `git push origin feature/master-data` · `git commit -m "push to main later"` · `grep -r "git push origin main" docs/` · `gh api repos/o/r/rulesets` · `gh label create human-approved --color 0e8a16`.

## Appendix B — guard-files cases (home `/home/u`; Windows subset `C:\Users\u`)

DENY: Edit `~/.claude/skills/ship/SKILL.md` · Write `/home/u/.claude/agents/arbiter.md` · Edit `/home/u/.claude/pipeline/hooks/guard-git.mjs` · Write `/home/u/.claude/settings.json` · MultiEdit `/home/u/.claude/skills/verify/SKILL.md` · NotebookEdit `/home/u/.claude/pipeline/x.ipynb` · Write `/repo/.claude/settings.local.json` content `{"disableAllHooks": true}` · Edit `/repo/.claude/settings.json` new_string containing `disableAllHooks` · Bash `sed -i '' 's/x/y/' ~/.claude/skills/ship/SKILL.md` · Bash `echo x > $HOME/.claude/agents/judge.md` · Bash `cp evil.md ${HOME}/.claude/skills/ship/SKILL.md` · Bash `rm -rf /home/u/.claude/pipeline` · Bash `PIPELINE_ADMIN=1 node install.mjs` · Bash `export PIPELINE_ADMIN=1` · Bash `node /home/u/Claude/claude-pipeline/install.mjs` · Bash `sh install.sh` (cwd = claude-pipeline checkout) · Write `/tmp/x.sh` content containing `PIPELINE_ADMIN` · Bash `node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/settings.json','{}')"` · Edit `C:\Users\u\.claude\skills\ship\SKILL.md` (win32) · Bash `Set-Content $env:USERPROFILE\.claude\settings.json x` (win32) · Edit `/home/u/.claude/skills/ship/../ship/SKILL.md` · Edit via symlink `/tmp/link/SKILL.md` → `~/.claude/skills/ship`.

ALLOW: Bash `cat ~/.claude/skills/ship/SKILL.md` · Bash `ls ~/.claude/pipeline` · Bash `grep -n foo ~/.claude/settings.json` · Edit `/repo/src/app.ts` · Edit `/home/u/.claude/skills/graphify/SKILL.md` · Edit `/home/u/.claude/agents/other.md` · Write `/repo/.claude/settings.json` without `disableAllHooks` · Edit `/home/u/.claude/CLAUDE.md` · Edit `/home/u/.claude/projects/-x/memory/a.md` · Edit `~/.claude/skills/ship/SKILL.md` with env `PIPELINE_ADMIN=1` · Bash `node ~/.claude/pipeline/bin/pipeline.mjs preflight` · Bash `git -C ~/Claude/claude-pipeline status` · Bash `diff ~/.claude/skills/ship/SKILL.md ~/Claude/claude-pipeline/skills/ship/SKILL.md` · Bash `node install.mjs --check` (cwd = claude-pipeline checkout).
