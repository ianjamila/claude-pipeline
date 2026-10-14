# `pipeline worktrees` (prune / keep / unkeep / holding / schedule) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a `pipeline worktrees` command that removes finished worktrees automatically and safely (report-only until the
owner flips `mode: on`), plus a keep-lock, a holding folder for evidence, a nightly schedule and ship integration.

**Architecture:** four focused library modules under `pipeline/lib/worktree-prune/` — pure rules (`rules.mjs`), PR
discovery (`prs.mjs`), fact gathering from git/fs/proc (`inspect.mjs`), and mutations (`act.mjs`) — composed by one
command module `pipeline/commands/worktrees.mjs`. Every mutation is gated by one mode table. Removal goes through a
quarantine move (`git worktree move`) so the final inspection happens on a path no new writer can reach.

**Tech Stack:** Node ≥ 20 ESM, `node:test` + `node:assert/strict`, existing helpers (`lib/git.mjs`, `lib/github.mjs`,
`lib/locks.mjs`, `lib/config.mjs`, `lib/local-branches.mjs`, `lib/notify.mjs`, `lib/cmd-common.mjs`, `lib/cli.mjs`).

**Spec:** `docs/specs/2026-10-13-worktree-prune-design.md` (rev 3, owner-approved 2026-10-13). Section numbers below
(§n, "rule n") refer to it.

## Global Constraints

- Default `worktrees.mode` is `report`; nothing is mutated unless `mode: on` and not `--dry-run` (spec §3 mode table).
- Never: delete a branch, run `git worktree prune`, pass `--force` to any git worktree command, run `supabase`, touch
  `<worktree_dir>/*.md` siblings, `*.stack`, `.claude/worktrees/*`, or the Command Centre registry (rule 8).
- Never release a git worktree lock whose reason does not start with `pipeline-keep:`; never release one carrying another
  run's id.
- Any incomplete or failing PR query ⇒ the affected worktree is kept, never treated as "no open PR" (rule 2).
- Lock name: `worktrees-prune-<sha256(realpath(git common dir)).slice(0,12)>` (must match `/^[A-Za-z0-9._-]+$/`).
- Holding: `~/.local/share/pipeline/holding/<repoSlugSafe>/<YYYY-MM-DD>/` with `MANIFEST.json`; purge after 30 days
  measured from `archivedAt`; invalid/future timestamps ⇒ keep. Env override `PIPELINE_HOLDING_DIR` (tests).
- Log: `~/.local/state/pipeline/prune-<repoSlugSafe>.log`, last 30 runs. Env override `PIPELINE_PRUNE_LOG_DIR`.
- Tests must pass on ubuntu AND windows CI (`.github/workflows/ci.yml`): Linux-only behaviour (`/proc`, `crontab`) is
  injected in tests and reported as "unavailable ⇒ keep" on other platforms.
- Output: every subcommand returns `{exitCode, output}` with one JSON object; exit 0 completed, 2 usage/env/config,
  3 dependency unavailable (`guardGh`).
- No new dependencies.

## Review Focus

1. **A file appears between the last pre-move check and `git worktree remove`** — the worktree must be moved back intact
   and kept (Task 5 tests (a) pre-move and (b) post-move via a write into the quarantined path).
2. **Run killed mid-removal** (after the quarantine move, or after archiving) — the next run must restore the quarantine
   to its original path before evaluating anything (Task 5 `restoreLeftovers` test; Task 6 CLI test).
3. **`mode: report` / `off` / `--dry-run` with expired holding batches and an eligible worktree** — disk must be
   byte-identical before/after (Task 6 snapshot test).
4. **Invoked from inside a linked worktree** (how ship calls it) — same candidates, config and lock as from the main
   checkout; the caller's own worktree is never a removal candidate while ship's keep-lock is on it (Task 3 + Task 6).
5. **GitHub flakiness** — a GraphQL error on one branch keeps that worktree and still evaluates the others; a rate-limit
   on the repo-identity call exits 3 with nothing changed (Task 2 + Task 6).

---

## File structure

| File | Responsibility |
|---|---|
| `pipeline/lib/config.mjs` (modify) | `worktrees` block: defaults + validation |
| `pipeline/templates/pipeline.yml` (modify) | documented example block |
| `pipeline/lib/local-branches.mjs` (modify) | `parseWorktreePorcelain` also returns `locked` / `prunable` / `detached` |
| `pipeline/lib/worktree-prune/rules.mjs` (new) | pure decisions: mode table, lock name, path classification, PR lifecycle, in-use verdict |
| `pipeline/lib/worktree-prune/prs.mjs` (new) | per-branch paginated PR discovery + repo identity check |
| `pipeline/lib/worktree-prune/inspect.mjs` (new) | canonical root, candidates, status + tree walk, ancestry, process/transcript/memory/mtime signals |
| `pipeline/lib/worktree-prune/act.mjs` (new) | quarantine move, re-inspect, move back, archive + manifest, cache delete, remove, leftovers, holding list/purge |
| `pipeline/commands/worktrees.mjs` (new) | CLI: prune / keep / unkeep / holding / schedule; lock; report; notify; log |
| `pipeline/lib/notify.mjs` (modify) | new `worktrees` event |
| `skills/ship/SKILL.md` (modify) | Step 0, Step 1, resume step 3, Step 7 calls |
| `docs/cli.md` (modify) | `## worktrees` section with exact `meta.usage` |
| `test/worktree-prune-rules.test.mjs`, `test/worktree-prune-prs.test.mjs`, `test/worktree-prune-inspect.test.mjs`, `test/worktree-prune-act.test.mjs`, `test/worktrees-cli.test.mjs` (new) | tests per module |

---

### Task 1: Config block + worktree porcelain fields

**Files:**
- Modify: `pipeline/lib/config.mjs` (DEFAULTS ~line 18, KEYS ~line 74, `validateConfig` ~line 333)
- Modify: `pipeline/templates/pipeline.yml` (after the `worktree_dir` line)
- Modify: `pipeline/lib/local-branches.mjs:14-29`
- Test: `test/config.test.mjs` (append), `test/local-branches.test.mjs` (append; create the file if it does not exist)

**Interfaces:**
- Produces: `config.worktrees = { mode: 'off'|'report'|'on', protect: string[], min_idle_hours: int, min_merged_hours: int,
  delete: string[], archive: string[], memory_dirs: string[] }`.
- Produces: `parseWorktreePorcelain(out)` entries gain `locked: string|null` (reason, `''` when locked without reason),
  `prunable: boolean`, `detached: boolean`.

- [ ] **Step 1: Write failing config tests** (append to `test/config.test.mjs`, following its existing style of writing a
  temp `.claude/pipeline.yml` and calling `loadConfig`):

```js
test('worktrees block: defaults when absent', async () => {
  const r = await loadFrom('version: 1\nproject: x\ndefault_branch: main\n'); // use the file's existing helper for a temp repo + loadConfig
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.worktrees, {
    mode: 'report',
    protect: ['foundation', '*.stack'],
    min_idle_hours: 24,
    min_merged_hours: 24,
    delete: ['node_modules/', '.next/', 'supabase/.temp/', 'test-results/', 'playwright-report/', 'next-env.d.ts', 'public/sw.js', 'tsconfig.tsbuildinfo', '*.log'],
    archive: ['.review/', '.verify/'],
    memory_dirs: ['~/claude-memory'],
  });
});

test('worktrees block: rejects a bad mode, unknown key, non-positive hours', async () => {
  const r = await loadFrom('version: 1\nproject: x\nworktrees:\n  mode: yes\n  min_idle_hours: 0\n  bogus: 1\n');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /worktrees\.mode/.test(e)));
  assert.ok(r.errors.some((e) => /worktrees\.min_idle_hours/.test(e)));
  assert.ok(r.errors.some((e) => /unknown key: worktrees\.bogus/.test(e)));
});

test('worktrees block: a path in delete must not also be in archive', async () => {
  const r = await loadFrom("version: 1\nproject: x\nworktrees:\n  delete: ['.review/']\n");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /worktrees: .review\/ is in both delete and archive/.test(e)));
});
```

If `test/config.test.mjs` has no `loadFrom` helper, add one at the top of the appended block:

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function loadFrom(yml) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'pipeline.yml'), yml);
  return loadConfig(dir);
}
```

- [ ] **Step 2: Run** `npm test -- config` → the three new tests FAIL (`worktrees` undefined / no errors).

- [ ] **Step 3: Implement.** In `DEFAULTS` add:

```js
  worktrees: {
    mode: 'report',
    protect: ['foundation', '*.stack'],
    min_idle_hours: 24,
    min_merged_hours: 24,
    delete: ['node_modules/', '.next/', 'supabase/.temp/', 'test-results/', 'playwright-report/', 'next-env.d.ts', 'public/sw.js', 'tsconfig.tsbuildinfo', '*.log'],
    archive: ['.review/', '.verify/'],
    memory_dirs: ['~/claude-memory'],
  },
```

In `KEYS` add `worktrees: ['mode', 'protect', 'min_idle_hours', 'min_merged_hours', 'delete', 'archive', 'memory_dirs'],`.
In `validateConfig`, next to the `risk` block:

```js
  const wt = section(config, 'worktrees', errors);
  if (wt) {
    if (!['off', 'report', 'on'].includes(wt.mode)) errors.push('worktrees.mode must be one of off, report, on');
    for (const k of ['protect', 'delete', 'archive', 'memory_dirs']) checkStrArray(wt[k], `worktrees.${k}`, errors);
    for (const k of ['min_idle_hours', 'min_merged_hours']) checkPosInt(wt[k], `worktrees.${k}`, errors);
    if (isStrArray(wt.delete) && isStrArray(wt.archive)) {
      for (const p of wt.delete) if (wt.archive.includes(p)) errors.push(`worktrees: ${p} is in both delete and archive`);
    }
  }
```

(Use the exact names of the existing helpers; `section` already reports unknown keys via `KEYS.worktrees`.)
In `pipeline/templates/pipeline.yml`, after `worktree_dir`, add the commented block:

```yaml
# worktrees:                 # `pipeline worktrees prune` (spec docs/specs/2026-10-13-worktree-prune-design.md)
#   mode: report             # off | report | on — nothing is removed until this says on
#   protect: [foundation, "*.stack"]
#   min_idle_hours: 24
#   min_merged_hours: 24
```

- [ ] **Step 4: Write failing porcelain test** (append to/create `test/local-branches.test.mjs`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreePorcelain } from '../pipeline/lib/local-branches.mjs';

test('parseWorktreePorcelain: locked, prunable, detached', () => {
  const out = [
    'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r/.worktrees/a', 'HEAD bbb', 'branch refs/heads/a', 'locked pipeline-keep: ship run 7', '',
    'worktree /r/.worktrees/b', 'HEAD ccc', 'detached', 'locked', '',
    'worktree /r/.worktrees/c', 'HEAD ddd', 'branch refs/heads/c', 'prunable gitdir file points to non-existent location', '',
  ].join('\n');
  const [m, a, b, c] = parseWorktreePorcelain(out, 'linux');
  assert.equal(m.locked, null); assert.equal(m.prunable, false); assert.equal(m.detached, false);
  assert.equal(a.locked, 'pipeline-keep: ship run 7');
  assert.equal(b.locked, ''); assert.equal(b.detached, true); assert.equal(b.branch, null);
  assert.equal(c.prunable, true);
});
```

- [ ] **Step 5: Run** `npm test -- local-branches` → FAIL. **Implement** in `parseWorktreePorcelain`: initialise
  `locked: null, prunable: false, detached: false`; add branches
  `else if (line === 'locked' || line.startsWith('locked ')) entry.locked = line === 'locked' ? '' : line.slice(7);`
  `else if (line === 'prunable' || line.startsWith('prunable ')) entry.prunable = true;`
  `else if (line === 'detached') entry.detached = true;`. Update the return-shape comment.

- [ ] **Step 6: Run** `npm test` → all PASS (existing inbox/resume tests must still pass with the extra fields).

- [ ] **Step 7: Commit** `git add pipeline/lib/config.mjs pipeline/templates/pipeline.yml pipeline/lib/local-branches.mjs test/config.test.mjs test/local-branches.test.mjs && git commit -m "feat(worktrees): config block + lock/prunable fields in worktree porcelain"`

---

### Task 2: Pure rules + PR discovery

**Files:**
- Create: `pipeline/lib/worktree-prune/rules.mjs`, `pipeline/lib/worktree-prune/prs.mjs`
- Test: `test/worktree-prune-rules.test.mjs`, `test/worktree-prune-prs.test.mjs`

**Interfaces:**
- Produces (`rules.mjs`):
  - `MODE_ACTIONS` and `modeAllows(mode, action, { dryRun }) -> boolean`, actions:
    `'evaluate' | 'remove' | 'restore-leftover' | 'purge' | 'keep-lock'`.
  - `lockNameFor(commonDirRealpath) -> string`.
  - `matchesPattern(relPath, pattern) -> boolean` (pattern ending `/` = directory prefix; `*.ext` = basename glob;
    otherwise exact relative path).
  - `classifyEntries(entries, { delete, archive }) -> { del: string[], arch: string[], blockers: string[] }` where
    `entries` = `[{ path, kind: 'tracked-change'|'untracked'|'ignored'|'file' , isSymlink, isDir }]`.
  - `ALWAYS_BLOCK = [/^\.env/, /(^|\/)HANDOFF[^/]*\.md$/i, /\.patch$/]`.
  - `selectLifecycle(prs, { nowMs, minMergedHours }) -> { ok: true, pr } | { ok: false, reason }`.
  - `isProtectedName(slug, protect) -> boolean`.
  - `inUseReasons(signals) -> string[]` (empty = not in use).
- Produces (`prs.mjs`):
  - `BRANCH_PRS_QUERY` (string).
  - `fetchBranchPrs(gh, branch) -> { ok: true, prs } | { ok: false, reason }` (never throws for GitHub errors).
  - `checkRepoIdentity(gh, originUrl) -> { ok: true, slug } | { ok: false, reason }`.

- [ ] **Step 1: Write failing rules tests** — `test/worktree-prune-rules.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeAllows, lockNameFor, matchesPattern, classifyEntries, selectLifecycle, isProtectedName, inUseReasons } from '../pipeline/lib/worktree-prune/rules.mjs';

test('mode table (spec §3)', () => {
  const t = (mode, action, dryRun = false) => modeAllows(mode, action, { dryRun });
  assert.equal(t('off', 'evaluate'), false);
  assert.equal(t('report', 'evaluate'), true);
  assert.equal(t('report', 'remove'), false);
  assert.equal(t('on', 'remove'), true);
  assert.equal(t('on', 'remove', true), false);
  assert.equal(t('off', 'restore-leftover'), true);
  assert.equal(t('on', 'restore-leftover', true), false);
  assert.equal(t('report', 'purge'), false);
  assert.equal(t('on', 'purge'), true);
  assert.equal(t('on', 'purge', true), false);
  assert.equal(t('off', 'keep-lock'), true);
  assert.throws(() => t('on', 'nonsense'), /unknown action/);
});

test('lock name is valid for locks.mjs and stable', () => {
  const n = lockNameFor('/home/u/repo/.git');
  assert.match(n, /^worktrees-prune-[0-9a-f]{12}$/);
  assert.equal(n, lockNameFor('/home/u/repo/.git'));
  assert.notEqual(n, lockNameFor('/home/u/other/.git'));
});

test('matchesPattern', () => {
  assert.equal(matchesPattern('node_modules/a/b.js', 'node_modules/'), true);
  assert.equal(matchesPattern('pkg/node_modules/x', 'node_modules/'), false);
  assert.equal(matchesPattern('a/b/c.log', '*.log'), true);
  assert.equal(matchesPattern('public/sw.js', 'public/sw.js'), true);
  assert.equal(matchesPattern('public/sw.json', 'public/sw.js'), false);
});

test('classifyEntries: caches deleted, evidence archived, anything else blocks', () => {
  const cfg = { delete: ['node_modules/', '*.log'], archive: ['.review/'] };
  const r = classifyEntries([
    { path: 'node_modules/x', kind: 'ignored' },
    { path: 'npm-debug.log', kind: 'ignored' },
    { path: '.review/state.json', kind: 'ignored' },
    { path: 'notes.txt', kind: 'ignored' },
    { path: 'src/new.ts', kind: 'untracked' },
    { path: 'src/a.ts', kind: 'tracked-change' },
    { path: '.env.local', kind: 'ignored' },
    { path: 'HANDOFF-x.md', kind: 'ignored' },
    { path: '.superpowers', kind: 'ignored', isSymlink: true },
    { path: '.superpowers/plan.md', kind: 'ignored' },
  ], cfg);
  assert.deepEqual(r.del.sort(), ['node_modules/x', 'npm-debug.log']);
  assert.deepEqual(r.arch, ['.review/state.json']);
  assert.deepEqual(r.blockers.sort(), ['.env.local', '.superpowers/plan.md', 'HANDOFF-x.md', 'notes.txt', 'src/a.ts', 'src/new.ts'].sort());
});

const H = 3600e3;
const now = Date.parse('2026-10-13T00:00:00Z');
const pr = (o) => ({ number: 1, state: 'MERGED', createdAt: '2026-10-01T00:00:00Z', mergedAt: new Date(now - 30 * H).toISOString(), headRefOid: 'a'.repeat(40), isCrossRepository: false, ...o });

test('selectLifecycle', () => {
  const s = (prs) => selectLifecycle(prs, { nowMs: now, minMergedHours: 24 });
  assert.deepEqual(s([pr()]), { ok: true, pr: pr() });
  assert.equal(s([]).reason, 'no PR');
  assert.equal(s([pr(), pr({ number: 2, state: 'OPEN', createdAt: '2026-10-02T00:00:00Z', mergedAt: null })]).reason, 'open PR #2 on this branch');
  assert.equal(s([pr({ isCrossRepository: true })]).reason, 'ambiguous: fork PR with the same branch name');
  assert.equal(s([pr(), pr({ number: 2 })]).reason, 'ambiguous order: PRs #1, #2 created at the same time');
  assert.equal(s([pr({ state: 'CLOSED', mergedAt: null })]).reason, 'newest PR #1 was closed without merging');
  assert.equal(s([pr({ mergedAt: new Date(now - 2 * H).toISOString() })]).reason, 'PR #1 merged less than 24h ago');
  assert.equal(s([pr({ mergedAt: 'garbage' })]).reason, 'PR #1 has no valid merge time');
  // the newest lifecycle wins: an old CLOSED PR followed by a merged one is fine
  assert.equal(s([pr({ number: 1, state: 'CLOSED', mergedAt: null, createdAt: '2026-09-01T00:00:00Z' }), pr({ number: 2 })]).pr.number, 2);
});

test('isProtectedName', () => {
  assert.equal(isProtectedName('foundation', ['foundation', '*.stack']), true);
  assert.equal(isProtectedName('ops.stack', ['foundation', '*.stack']), true);
  assert.equal(isProtectedName('agent-x', ['foundation', '*.stack']), false);
});

test('inUseReasons', () => {
  assert.deepEqual(inUseReasons({ locked: null, processes: { available: true, pids: [] }, transcripts: [], memoryNotes: [], recentFiles: [] }), []);
  const r = inUseReasons({ locked: 'pipeline-keep: ship run 9', processes: { available: false }, transcripts: ['/t/a.jsonl'], memoryNotes: ['/m/x.md'], recentFiles: ['src/a.ts'] });
  assert.deepEqual(r, [
    'locked (pipeline-keep: ship run 9)',
    'cannot check running processes on this platform',
    'a Claude session mentioned it recently (/t/a.jsonl)',
    'a memory note says it is still needed (/m/x.md)',
    'files changed recently (src/a.ts)',
  ]);
});
```

- [ ] **Step 2: Run** `npm test -- worktree-prune-rules` → FAIL (module missing).

- [ ] **Step 3: Implement `pipeline/lib/worktree-prune/rules.mjs`:**

```js
// Pure decisions for `pipeline worktrees` (spec docs/specs/2026-10-13-worktree-prune-design.md §3–§4). No I/O here:
// everything is a function of the facts gathered by inspect.mjs / prs.mjs, so every rule arm is unit-testable.
import { createHash } from 'node:crypto';

// spec §3 mode table. dryRun overrides everything to "evaluate only".
const TABLE = {
  evaluate: { off: false, report: true, on: true },
  remove: { off: false, report: false, on: true },
  'restore-leftover': { off: true, report: true, on: true },
  purge: { off: false, report: false, on: true },
  'keep-lock': { off: true, report: true, on: true },
};
export const MODE_ACTIONS = Object.freeze(Object.keys(TABLE));

export function modeAllows(mode, action, { dryRun = false } = {}) {
  const row = TABLE[action];
  if (!row) throw new Error(`unknown action: ${action}`);
  if (dryRun) return action === 'evaluate';
  return row[mode] === true;
}

export const lockNameFor = (commonDir) => `worktrees-prune-${createHash('sha256').update(commonDir).digest('hex').slice(0, 12)}`;

const base = (p) => p.slice(p.lastIndexOf('/') + 1);
export function matchesPattern(rel, pattern) {
  if (pattern.endsWith('/')) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
  if (pattern.startsWith('*.')) return base(rel).endsWith(pattern.slice(1));
  return rel === pattern;
}

export const ALWAYS_BLOCK = Object.freeze([/^\.env/, /(^|\/)HANDOFF[^/]*\.md$/i, /\.patch$/]);

// entries: [{ path (posix, relative), kind, isSymlink }]. A `.superpowers` symlink is allowed (removal unlinks it only);
// anything under a real `.superpowers/` directory blocks.
export function classifyEntries(entries, { delete: del, archive }) {
  const out = { del: [], arch: [], blockers: [] };
  for (const e of entries) {
    const p = e.path;
    if (p === '.superpowers' && e.isSymlink) continue;
    if (e.kind === 'tracked-change' || e.kind === 'untracked') { out.blockers.push(p); continue; }
    if (ALWAYS_BLOCK.some((re) => re.test(p))) { out.blockers.push(p); continue; }
    if (del.some((pat) => matchesPattern(p, pat))) out.del.push(p);
    else if (archive.some((pat) => matchesPattern(p, pat))) out.arch.push(p);
    else out.blockers.push(p);
  }
  return out;
}

// prs: same-branch PRs from prs.mjs. spec §4 rule 3.
export function selectLifecycle(prs, { nowMs, minMergedHours }) {
  if (prs.length === 0) return { ok: false, reason: 'no PR' };
  if (prs.some((p) => p.isCrossRepository)) return { ok: false, reason: 'ambiguous: fork PR with the same branch name' };
  const open = prs.find((p) => p.state === 'OPEN');
  if (open) return { ok: false, reason: `open PR #${open.number} on this branch` };
  const t = (p) => Date.parse(p.createdAt);
  const sorted = [...prs].sort((a, b) => t(b) - t(a));
  const newest = sorted[0];
  if (!Number.isFinite(t(newest))) return { ok: false, reason: `PR #${newest.number} has no valid creation time` };
  const tied = sorted.filter((p) => t(p) === t(newest));
  if (tied.length > 1) return { ok: false, reason: `ambiguous order: PRs ${tied.map((p) => `#${p.number}`).sort().join(', ')} created at the same time` };
  if (newest.state !== 'MERGED') return { ok: false, reason: `newest PR #${newest.number} was closed without merging` };
  const merged = Date.parse(newest.mergedAt);
  if (!Number.isFinite(merged) || merged > nowMs) return { ok: false, reason: `PR #${newest.number} has no valid merge time` };
  if (nowMs - merged < minMergedHours * 3600e3) return { ok: false, reason: `PR #${newest.number} merged less than ${minMergedHours}h ago` };
  return { ok: true, pr: newest };
}

const glob = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
export const isProtectedName = (slug, protect) => protect.some((p) => glob(p).test(slug));

// signals: { locked: string|null, processes: {available, pids}, transcripts: string[], memoryNotes: string[], recentFiles: string[] }
export function inUseReasons(s) {
  const r = [];
  if (s.locked !== null && s.locked !== undefined) r.push(`locked (${s.locked || 'no reason given'})`);
  if (!s.processes.available) r.push('cannot check running processes on this platform');
  else if (s.processes.pids.length) r.push(`in use by process ${s.processes.pids.join(', ')}`);
  if (s.transcripts.length) r.push(`a Claude session mentioned it recently (${s.transcripts[0]})`);
  if (s.memoryNotes.length) r.push(`a memory note says it is still needed (${s.memoryNotes[0]})`);
  if (s.recentFiles.length) r.push(`files changed recently (${s.recentFiles.slice(0, 3).join(', ')})`);
  return r;
}
```

- [ ] **Step 4: Run** `npm test -- worktree-prune-rules` → PASS.

- [ ] **Step 5: Write failing PR discovery tests** — `test/worktree-prune-prs.test.mjs`, stubbing `gh` through
  `createGitHub({ cwd, ghFn })` (as `test/github.test.mjs:373` does):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { fetchBranchPrs, checkRepoIdentity } from '../pipeline/lib/worktree-prune/prs.mjs';

const ok = (obj) => ({ code: 0, stdout: JSON.stringify(obj), stderr: '', timedOut: false });
const repoView = ok({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
const page = (nodes, hasNextPage = false, endCursor = null) => ok({ data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } } });
const node = (o) => ({ number: 5, state: 'MERGED', createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-02T00:00:00Z', headRefName: 'feat/x', headRefOid: 'a'.repeat(40), isCrossRepository: false, headRepository: { nameWithOwner: 'acme/widgets' }, ...o });

function gh(script) {
  const calls = [];
  const ghFn = (args) => { calls.push(args); return script(args, calls.length); };
  return { gh: createGitHub({ cwd: '.', ghFn }), calls };
}

test('fetchBranchPrs: one page, filters by exact branch name', () => {
  const { gh: g, calls } = gh((args) => (args[0] === 'repo' ? repoView : page([node(), node({ number: 6, headRefName: 'feat/x-2' })])));
  const r = fetchBranchPrs(g, 'feat/x');
  assert.equal(r.ok, true);
  assert.deepEqual(r.prs.map((p) => p.number), [5]);
  assert.ok(calls.some((a) => a.join(' ').includes('headRefName')));
});

test('fetchBranchPrs: follows pagination', () => {
  const { gh: g } = gh((args, n) => (args[0] === 'repo' ? repoView : n === 2 ? page([node()], true, 'c1') : page([node({ number: 7, state: 'OPEN', mergedAt: null })])));
  assert.deepEqual(fetchBranchPrs(g, 'feat/x').prs.map((p) => p.number), [5, 7]);
});

test('fetchBranchPrs: any GitHub error => ok:false, never an empty list', () => {
  const { gh: g } = gh((args) => (args[0] === 'repo' ? repoView : { code: 1, stdout: '', stderr: 'API rate limit exceeded', timedOut: false }));
  const r = fetchBranchPrs(g, 'feat/x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /PR data incomplete/);
});

test('fetchBranchPrs: a cursor that does not advance => ok:false', () => {
  const { gh: g } = gh((args) => (args[0] === 'repo' ? repoView : page([node()], true, 'same')));
  assert.equal(fetchBranchPrs(g, 'feat/x').ok, false);
});

test('checkRepoIdentity: gh repo must equal origin', () => {
  const { gh: g } = gh(() => repoView);
  assert.deepEqual(checkRepoIdentity(g, 'git@github.com:acme/widgets.git'), { ok: true, slug: 'acme/widgets' });
  assert.equal(checkRepoIdentity(g, 'https://github.com/acme/widgets').ok, true);
  assert.match(checkRepoIdentity(g, 'https://github.com/other/widgets.git').reason, /does not match origin/);
});
```

- [ ] **Step 6: Run** `npm test -- worktree-prune-prs` → FAIL.

- [ ] **Step 7: Implement `pipeline/lib/worktree-prune/prs.mjs`:**

```js
// Per-branch PR discovery for `pipeline worktrees prune` (spec §4 rule 2). Complete or nothing: any GitHub error,
// non-advancing cursor or page cap returns ok:false, which the caller turns into "kept: PR data incomplete" — a
// truncated answer is never read as "no open PR".
import { parseRemote } from '../notify.mjs';

export const BRANCH_PRS_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, CLOSED, MERGED], first: $first, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number state createdAt mergedAt headRefName headRefOid isCrossRepository headRepository { nameWithOwner } }
    }
  }
}`;

export function fetchBranchPrs(gh, branch) {
  const prs = [];
  try {
    gh.pagePullRequests(BRANCH_PRS_QUERY, (nodes) => {
      for (const n of nodes) if (n.headRefName === branch) prs.push(n);
    }, { branch });
  } catch (err) {
    return { ok: false, reason: `PR data incomplete: ${String(err?.stderr || err?.message || err).split('\n')[0].slice(0, 160)}` };
  }
  return { ok: true, prs };
}

export function checkRepoIdentity(gh, originUrl) {
  let slug;
  try {
    slug = gh.repo().slug;
  } catch (err) {
    return { ok: false, reason: `cannot read the GitHub repository: ${String(err?.stderr || err?.message).slice(0, 160)}`, unavailable: true };
  }
  const o = parseRemote(originUrl);
  const originSlug = o ? `${o.owner}/${o.name}` : null;
  if (!originSlug || originSlug.toLowerCase() !== slug.toLowerCase()) return { ok: false, reason: `gh repository ${slug} does not match origin (${originUrl})` };
  return { ok: true, slug };
}
```

`pagePullRequests` today takes `(query, visit)` and passes only `{owner, name, first, after}`. **Modify
`pipeline/lib/github.mjs` `pagePullRequests(query, visit, extraVars = {})`** to spread `extraVars` into the variables
(`self.graphql(query, { owner, name, first: GRAPHQL_PAGE, after, ...extraVars })`). Add a github test asserting extra variables reach
`gh api graphql` as `-f branch=feat/x`. Check `parseRemote` returns `{ owner, name }` (it is exported from
`lib/notify.mjs:350`); if its return keys differ, adapt the two lines that read it.

- [ ] **Step 8: Run** `npm test` → PASS.

- [ ] **Step 9: Commit** `git add pipeline/lib/worktree-prune/rules.mjs pipeline/lib/worktree-prune/prs.mjs pipeline/lib/github.mjs test/worktree-prune-rules.test.mjs test/worktree-prune-prs.test.mjs test/github.test.mjs && git commit -m "feat(worktrees): pure prune rules + complete per-branch PR discovery"`

---

### Task 3: Fact gathering (`inspect.mjs`)

**Files:**
- Create: `pipeline/lib/worktree-prune/inspect.mjs`
- Test: `test/worktree-prune-inspect.test.mjs`

**Interfaces:**
- Consumes: `listWorktrees`, `parseWorktreePorcelain` (Task 1); `git`, `GitError`, `isAncestor`, `NETWORK_TIMEOUT_MS`
  from `lib/git.mjs`; `gitCommonDir` from `lib/repo.mjs`; `isProtectedName` (Task 2).
- Produces:
  - `resolveCanonicalRoot(dir) -> { root, commonDir }` — `commonDir` realpath'd; `root` = first `listWorktrees` entry.
  - `listCandidates(root, { worktreeDir, protect }) -> { candidates: [{ slug, path, branch, head, locked }], skipped: [{ slug, path, reason }] }`.
  - `statusEntries(wtPath) -> [{ path, kind }]` from `git status --porcelain=v1 --ignored --untracked-files=all -z`.
  - `walkTree(wtPath) -> [{ path, isSymlink, isDir, mtimeMs }]` (no symlink following; skips `.git` file).
  - `entriesFor(wtPath) -> [{ path, kind, isSymlink }]` = status entries expanded so every file under an ignored
    directory is listed individually (the walk supplies them), with `isSymlink` from the walk.
  - `checkAncestry(root, { head, pr }) -> { ok: true } | { ok: false, reason }` — fetch `refs/pull/<n>/head`, compare to
    `pr.headRefOid`, `git merge-base --is-ancestor head pr.headRefOid`.
  - `processesInside(dir, { procRoot = '/proc', platform = process.platform }) -> { available, pids }`.
  - `transcriptMentions(needles, { dirs, sinceMs }) -> string[]` (paths of `*.jsonl` modified ≥ sinceMs containing any needle).
  - `defaultTranscriptDirs(home = os.homedir(), env = process.env) -> string[]` — `$CLAUDE_CONFIG_DIR/projects` plus every
    `<home>/.claude*/projects` that exists, de-duplicated by realpath.
  - `memoryMentions({ slug, branch }, { dirs }) -> string[]` — `*.md` under each dir (one level of subdirs), excluding
    `MEMORY-archive.md` and any `archive/` dir, whose text contains the slug or branch on a line that also matches
    `/BUILDING|ledger home|\bkeep\b/i`.
  - `recentFiles(walk, { sinceMs, ignore }) -> string[]` — files (not dirs) with `mtimeMs >= sinceMs` not matching any
    pattern in `ignore` (the delete + archive lists).

- [ ] **Step 1: Write failing tests** — `test/worktree-prune-inspect.test.mjs` using `createTmpRepo()` from
  `test/helpers/tmprepo.mjs` and a bare origin like `test/artifacts.test.mjs` `world()`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, utimesSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { resolveCanonicalRoot, listCandidates, entriesFor, checkAncestry, processesInside, transcriptMentions, memoryMentions, recentFiles, walkTree } from '../pipeline/lib/worktree-prune/inspect.mjs';

function world() {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a\n'); repo.write('.gitignore', 'node_modules/\n.review/\n*.log\n.env*\nnotes.txt\n'); repo.commit('init');
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  repo.git(['init', '--bare', '-q', origin]);
  repo.git(['remote', 'add', 'origin', origin]);
  repo.git(['push', '-q', 'origin', 'main']);
  mkdirSync(join(repo.dir, '.worktrees'));
  const add = (slug, branch) => { repo.git(['worktree', 'add', '-q', '-b', branch, join('.worktrees', slug), 'main']); return join(repo.dir, '.worktrees', slug); };
  return { repo, origin, add };
}

test('canonical root is the main worktree from anywhere', () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const a = resolveCanonicalRoot(repo.dir);
  const b = resolveCanonicalRoot(wt);
  assert.equal(a.root, b.root);
  assert.equal(a.commonDir, b.commonDir);
  assert.equal(realpathSync(a.root), realpathSync(repo.dir));
});

test('listCandidates: direct children of worktree_dir only; protect, locked, detached skipped', () => {
  const { repo, add } = world();
  add('agent-x', 'agent/x'); add('foundation', 'f'); add('ops.stack', 's'); const d = add('det', 'd');
  repo.git(['-C', d, 'checkout', '-q', '--detach']);
  const l = add('locked-one', 'l'); repo.git(['worktree', 'lock', '--reason', 'owner', l]);
  const { candidates, skipped } = listCandidates(repo.dir, { worktreeDir: '.worktrees', protect: ['foundation', '*.stack'] });
  assert.deepEqual(candidates.map((c) => c.slug), ['agent-x']);
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.slug, s.reason])), {
    foundation: 'protected', 'ops.stack': 'protected', det: 'detached HEAD', 'locked-one': 'locked (owner)',
  });
});

test('entriesFor: untracked, ignored files listed per file; symlink flagged', () => {
  const { add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, 'node_modules', 'p'), { recursive: true }); writeFileSync(join(wt, 'node_modules', 'p', 'i.js'), '');
  writeFileSync(join(wt, 'new.ts'), ''); writeFileSync(join(wt, 'notes.txt'), '');
  const e = Object.fromEntries(entriesFor(wt).map((x) => [x.path, x.kind]));
  assert.equal(e['node_modules/p/i.js'], 'ignored');
  assert.equal(e['new.ts'], 'untracked');
  assert.equal(e['notes.txt'], 'ignored');
});

test('checkAncestry: behind the merged head is fine, local-only commit is not, sha mismatch is not', () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  writeFileSync(join(wt, 'b.txt'), 'b'); repo.git(['-C', wt, 'add', 'b.txt']); repo.git(['-C', wt, 'commit', '-qm', 'b']);
  const local = repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim();
  writeFileSync(join(wt, 'c.txt'), 'c'); repo.git(['-C', wt, 'add', 'c.txt']); repo.git(['-C', wt, 'commit', '-qm', 'c']);
  const prHead = repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim();
  repo.git(['-C', wt, 'push', '-q', 'origin', `HEAD:refs/pull/9/head`]);
  repo.git(['-C', wt, 'reset', '-q', '--hard', local]);
  assert.deepEqual(checkAncestry(repo.dir, { head: local, pr: { number: 9, headRefOid: prHead } }), { ok: true });
  assert.match(checkAncestry(repo.dir, { head: local, pr: { number: 9, headRefOid: 'f'.repeat(40) } }).reason, /does not match/);
  writeFileSync(join(wt, 'd.txt'), 'd'); repo.git(['-C', wt, 'add', 'd.txt']); repo.git(['-C', wt, 'commit', '-qm', 'local only']);
  const ahead = repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim();
  assert.match(checkAncestry(repo.dir, { head: ahead, pr: { number: 9, headRefOid: prHead } }).reason, /commits that are not in PR #9/);
  assert.match(checkAncestry(repo.dir, { head: local, pr: { number: 404, headRefOid: prHead } }).reason, /could not fetch PR #404/);
});

test('processesInside: fake /proc tree; non-linux is unavailable', () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const target = mkdtempSync(join(tmpdir(), 'wt-'));
  mkdirSync(join(proc, '101', 'fd'), { recursive: true });
  mkdirSync(join(proc, '202', 'fd'), { recursive: true });
  symlinkSync(target, join(proc, '101', 'cwd'));
  symlinkSync(tmpdir(), join(proc, '202', 'cwd'));
  symlinkSync(join(target, 'x.log'), join(proc, '202', 'fd', '3'));
  assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'linux' }), { available: true, pids: [101, 202] });
  assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'win32' }), { available: false, pids: [] });
}, { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' });

test('transcriptMentions / memoryMentions / recentFiles', () => {
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj')); writeFileSync(join(t, 'proj', 's1.jsonl'), '{"cwd":"/r/.worktrees/agent-x"}\n');
  writeFileSync(join(t, 'proj', 'old.jsonl'), '/r/.worktrees/agent-x'); utimesSync(join(t, 'proj', 'old.jsonl'), 1, 1);
  assert.deepEqual(transcriptMentions(['/r/.worktrees/agent-x'], { dirs: [t], sinceMs: Date.now() - 3600e3 }).map((p) => p.endsWith('s1.jsonl')), [true]);
  const m = mkdtempSync(join(tmpdir(), 'mem-'));
  mkdirSync(join(m, 'eaglewatch')); mkdirSync(join(m, 'archive'));
  writeFileSync(join(m, 'eaglewatch', 'a.md'), 'agent-x is BUILDING phase 2\n');
  writeFileSync(join(m, 'eaglewatch', 'b.md'), 'agent-x merged long ago\n');
  writeFileSync(join(m, 'archive', 'c.md'), 'agent-x BUILDING\n');
  writeFileSync(join(m, 'eaglewatch', 'MEMORY-archive.md'), 'agent-x BUILDING\n');
  assert.deepEqual(memoryMentions({ slug: 'agent-x', branch: 'agent/x' }, { dirs: [m] }).map((p) => p.endsWith('a.md')), [true]);
  const walk = [{ path: 'src/a.ts', isDir: false, mtimeMs: Date.now() }, { path: 'node_modules/x', isDir: false, mtimeMs: Date.now() }, { path: 'old.ts', isDir: false, mtimeMs: 1 }];
  assert.deepEqual(recentFiles(walk, { sinceMs: Date.now() - 3600e3, ignore: ['node_modules/'] }), ['src/a.ts']);
});
```

- [ ] **Step 2: Run** `npm test -- worktree-prune-inspect` → FAIL.

- [ ] **Step 3: Implement `pipeline/lib/worktree-prune/inspect.mjs`.** Key implementation details (write the module in
  full; each function ≤ 40 lines):
  - `resolveCanonicalRoot(dir)`: `const top = repoRoot(dir); const commonDir = realpathSync(gitCommonDir(top)); const root = listWorktrees(top)[0].path; return { root, commonDir };`
  - `listCandidates`: `const wtDir = path.join(root, worktreeDir)`; for each `listWorktrees(root).slice(1)` entry: skip
    unless `path.dirname(entry.path)` is `samePath` with `wtDir`; `slug = path.basename(entry.path)`; reasons in order:
    `slug.startsWith('.')` ⇒ ignore silently (quarantine dir and dotfiles); `isProtectedName` ⇒ `'protected'`;
    `entry.prunable` ⇒ `'prunable (directory missing)'`; `entry.detached || !entry.branch` ⇒ `'detached HEAD'`;
    `entry.locked !== null` ⇒ `` `locked (${entry.locked || 'no reason given'})` ``; else candidate
    `{ slug, path: entry.path, branch, head, locked: null }`.
  - `statusEntries`: `git(['status', '--porcelain=v1', '--ignored', '--untracked-files=all', '-z'], { cwd })`, split on
    `\0`; `!! ` ⇒ `ignored`, `?? ` ⇒ `untracked`, anything else ⇒ `tracked-change` (rename entries consume the next
    `\0` field). Paths are posix relative; a trailing `/` (ignored directory) is kept as a directory marker.
  - `walkTree(wt)`: iterative `readdirSync(dir, { withFileTypes: true })`, `lstatSync` per entry, never descend into a
    symlink, skip the top-level `.git` file; return posix relative paths.
  - `entriesFor(wt)`: from `statusEntries`; for each ignored/untracked directory marker, replace it with every
    non-directory walk entry under it (same kind); attach `isSymlink` from the walk by path.
  - `checkAncestry(root, { head, pr })`: `git(['fetch', '--no-tags', '-q', 'origin', `+refs/pull/${pr.number}/head:refs/pipeline-prune/pr-${pr.number}`], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS })`
    in try/catch (`GitError` ⇒ `{ ok:false, reason: `could not fetch PR #${n}: …` }`); compare
    `revParse('refs/pipeline-prune/pr-<n>')` with `pr.headRefOid` (mismatch ⇒ `` `fetched PR #${n} head does not match GitHub (${a.slice(0,7)} ≠ ${b.slice(0,7)})` ``);
    `isAncestor(head, pr.headRefOid, { cwd: root })` false ⇒ `` `has commits that are not in PR #${n}` ``. Always delete
    the temp ref afterwards (`git update-ref -d`), in a `finally`.
  - `processesInside(dir, { procRoot, platform })`: `platform !== 'linux'` ⇒ `{ available:false, pids:[] }`; else for
    each numeric entry of `procRoot`: `readlinkSync(cwd)` and every `readlinkSync(fd/*)`; if any resolves `isInside(dir)`
    or equals it, collect the pid; ignore `EACCES`/`ENOENT` per entry (other users' processes); return sorted pids.
    If `readdirSync(procRoot)` itself fails ⇒ `{ available:false, pids:[] }`.
  - `transcriptMentions`: walk each dir two levels (`<dir>/<project>/*.jsonl` and `<dir>/<project>/<session>/subagents/*.jsonl`),
    keep files with `mtimeMs >= sinceMs`, read in 1 MiB chunks with `openSync`/`readSync` and check `includes` of each
    needle across chunk boundaries (keep the last `maxNeedleLength` bytes of the previous chunk). Return matching paths.
  - `defaultTranscriptDirs`: `[env.CLAUDE_CONFIG_DIR && join(env.CLAUDE_CONFIG_DIR, 'projects'), ...readdirSync(home).filter((n) => /^\.claude/.test(n)).map((n) => join(home, n, 'projects'))]`, existing only, unique by `realpathSync`.
  - `memoryMentions`: `expandHome` each dir (from `lib/paths.mjs`); files `*.md` at depth 1–2, skip `MEMORY-archive.md`
    and any path segment `archive`; a file matches when some line contains (`slug` or `branch`) and matches
    `/BUILDING|ledger home|\bkeep\b/i`.
  - `recentFiles`: filter non-dirs, `mtimeMs >= sinceMs`, not `ignore.some((p) => matchesPattern(path, p))`.

- [ ] **Step 4: Run** `npm test -- worktree-prune-inspect` → PASS. Run full `npm test` → PASS.

- [ ] **Step 5: Commit** `git add pipeline/lib/worktree-prune/inspect.mjs test/worktree-prune-inspect.test.mjs && git commit -m "feat(worktrees): gather prune facts (candidates, status walk, ancestry, in-use signals)"`

---

### Task 4: Holding folder (archive, manifest, list, purge)

**Files:**
- Create: `pipeline/lib/worktree-prune/act.mjs` (holding part)
- Test: `test/worktree-prune-act.test.mjs` (holding part)

**Interfaces:**
- Produces:
  - `holdingRoot(repoSlug, env = process.env) -> string` — `env.PIPELINE_HOLDING_DIR || ~/.local/share/pipeline/holding`,
    joined with `repoSlug.replace(/[^A-Za-z0-9._-]/g, '_')`.
  - `archivePaths({ wtPath, rels, holdingDir, slug, pr, nowMs }) -> { batchDir, items }` — moves each rel (file) to
    `<holdingDir>/<YYYY-MM-DD>/<slug>/<rel>`, numeric suffix on collision, writes/updates `MANIFEST.json` in the dated
    dir: `{ version: 1, items: [{ original, stored, size, sha256, archivedAt, slug, pr }] }`.
  - `listHolding(holdingDir) -> [{ batch, archivedAt, items, bytes, restore: string[] }]` (restore = `mv` commands).
  - `purgeHolding(holdingDir, { nowMs, days = 30 }) -> { purged: string[], kept: [{ batch, reason }] }` — a batch is
    purged only when EVERY item's `archivedAt` parses, is ≤ now, and is older than `days`.

- [ ] **Step 1: Write failing tests:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archivePaths, listHolding, purgeHolding, holdingRoot } from '../pipeline/lib/worktree-prune/act.mjs';

const day = 86400e3;
const T = Date.parse('2026-10-13T00:00:00Z');

test('holdingRoot sanitises the slug and honours the env override', () => {
  assert.equal(holdingRoot('acme/widgets', { PIPELINE_HOLDING_DIR: '/h' }), join('/h', 'acme_widgets'));
});

test('archive -> manifest -> list -> collision suffix', () => {
  const wt = mkdtempSync(join(tmpdir(), 'wt-')); const h = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 'state.json'), '{"a":1}');
  const r = archivePaths({ wtPath: wt, rels: ['.review/state.json'], holdingDir: h, slug: 'agent-x', pr: 9, nowMs: T });
  assert.equal(existsSync(join(wt, '.review', 'state.json')), false);
  const m = JSON.parse(readFileSync(join(r.batchDir, 'MANIFEST.json'), 'utf8'));
  assert.equal(m.items[0].original, join(wt, '.review', 'state.json'));
  assert.equal(m.items[0].archivedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(readFileSync(m.items[0].stored, 'utf8'), '{"a":1}');
  writeFileSync(join(wt, '.review', 'state.json'), '{"a":2}');
  const r2 = archivePaths({ wtPath: wt, rels: ['.review/state.json'], holdingDir: h, slug: 'agent-x', pr: 9, nowMs: T });
  assert.notEqual(r2.items[0].stored, m.items[0].stored);
  const l = listHolding(h);
  assert.equal(l.length, 1); assert.equal(l[0].items, 2); assert.match(l[0].restore[0], /^mv /);
});

test('purge: only batches whose every item is > 30 days old; bad/future timestamps keep', () => {
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  const mk = (name, archivedAt) => { mkdirSync(join(h, name)); writeFileSync(join(h, name, 'MANIFEST.json'), JSON.stringify({ version: 1, items: [{ original: '/x', stored: join(h, name, 'x'), size: 0, sha256: '', archivedAt }] })); };
  mk('2026-09-01', new Date(T - 40 * day).toISOString());
  mk('2026-10-01', new Date(T - 10 * day).toISOString());
  mk('bad', 'not a date');
  mk('future', new Date(T + day).toISOString());
  const r = purgeHolding(h, { nowMs: T });
  assert.deepEqual(r.purged, ['2026-09-01']);
  assert.deepEqual(r.kept.map((k) => k.batch).sort(), ['2026-10-01', 'bad', 'future']);
  assert.equal(existsSync(join(h, '2026-09-01')), false);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the four functions (use `renameSync`, falling back to
  `copyFileSync` + `unlinkSync` on `EXDEV`; sha256 via `createHash` over the file read before moving; batch date
  `new Date(nowMs).toISOString().slice(0, 10)`; `rmSync(batchDir, { recursive: true })` for purge).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git commit -am "feat(worktrees): holding folder with manifest, list and 30-day purge"` (add the new files first).

---

### Task 5: Quarantine removal + leftovers (`act.mjs`)

**Files:**
- Modify: `pipeline/lib/worktree-prune/act.mjs`
- Test: `test/worktree-prune-act.test.mjs` (append)

**Interfaces:**
- Consumes: `entriesFor`, `walkTree`, `processesInside` (Task 3); `classifyEntries` (Task 2); `archivePaths` (Task 4).
- Produces:
  - `QUARANTINE_DIR = '.prune-quarantine'`.
  - `removeWorktree({ root, wt, cfg, pr, holdingDir, runId, runStartMs, settleMs = 5000, hooks = {}, procOpts })
     -> { removed: true, archived, deleted } | { removed: false, reason, restored: boolean }`
    where `wt = { slug, path }`, `cfg = { delete, archive }`. `hooks.afterMove(quarantinePath)` is a test seam.
  - `restoreLeftovers(root, worktreeDir) -> [{ from, to, restored: boolean, reason? }]`.

**Algorithm (spec §2), exactly:**
1. `q = join(root, worktreeDir, QUARANTINE_DIR, `${slug}.${runId}`)`; `mkdirSync(dirname(q), { recursive: true })`.
2. `git worktree move <wt.path> <q>` (cwd root). Failure ⇒ `{ removed:false, reason:'move refused: …', restored:false }` (nothing changed).
3. `hooks.afterMove?.(q)`; then wait `settleMs`.
4. Re-inspect `q`: `classifyEntries(entriesFor(q), cfg).blockers` non-empty ⇒ reason `write detected during removal (<first>)`;
   any walk entry outside `cfg.delete`/`cfg.archive` with `mtimeMs >= runStartMs` ⇒ same reason;
   `processesInside(q, procOpts)` not available or pids ⇒ `in use during removal`. Any ⇒ `git worktree move <q> <wt.path>`
   and return `{ removed:false, reason, restored:true }` (if the move back fails, return `restored:false` and the reason
   includes the quarantine path so the report tells the owner where it is).
5. `archivePaths({ wtPath: q, rels: arch, … })` with `arch` from the re-inspection; `rmSync` each `del` path
   (`{ recursive: true, force: false }`, never following symlinks: use `lstat`, `unlinkSync` for links).
6. `git worktree remove <q>` (no `--force`). Failure ⇒ `{ removed:false, reason:'git refused removal: …', restored:false }`
   — leave `q` in place; `restoreLeftovers` puts it back next run.

`restoreLeftovers`: for each dir in `<root>/<worktreeDir>/.prune-quarantine/`: name `<slug>.<runId>`; target
`<root>/<worktreeDir>/<slug>`; if target exists ⇒ `{ restored:false, reason:'original path is taken' }`; if git still
knows the quarantine as a worktree (`listWorktrees`) ⇒ `git worktree move q target`; else (a plain dir — git already
removed its metadata) ⇒ leave it and report `{ restored:false, reason:'not a worktree any more — inspect by hand' }`.

- [ ] **Step 1: Write failing tests** (reuse `world()` from Task 3 — copy it into this test file):

```js
test('removeWorktree: eligible tree is archived, cleaned and removed; branch kept', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, 'node_modules')); writeFileSync(join(wt, 'node_modules', 'i.js'), '');
  mkdirSync(join(wt, '.review')); writeFileSync(join(wt, '.review', 's.json'), '{}');
  const h = mkdtempSync(join(tmpdir(), 'hold-'));
  // runStartMs in the future: the files above were written "before the run" even if the clock has not ticked since
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: ['node_modules/'], archive: ['.review/'] }, pr: 9, holdingDir: h, runId: 'r1', runStartMs: Date.now() + 5000, settleMs: 0, procOpts: { platform: 'linux', procRoot: mkdtempSync(join(tmpdir(), 'p-')) } });
  assert.equal(r.removed, true);
  assert.equal(existsSync(wt), false);
  assert.match(repo.git(['branch', '--list', 'agent/x']), /agent\/x/);
  assert.equal(listHolding(h)[0].items, 1);
});

test('removeWorktree: a file written after the move => moved back intact, kept', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const r = await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r2', runStartMs: Date.now(), settleMs: 0,
    procOpts: { platform: 'linux', procRoot: mkdtempSync(join(tmpdir(), 'p-')) },
    hooks: { afterMove: (q) => writeFileSync(join(q, '.env.local'), 'SECRET=1') } });
  assert.deepEqual([r.removed, r.restored], [false, true]);
  assert.match(r.reason, /write detected during removal/);
  assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'SECRET=1');
});

test('removeWorktree: an absolute-path write after the move fails loudly (ENOENT)', async () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  let err;
  await removeWorktree({ root: repo.dir, wt: { slug: 'agent-x', path: wt }, cfg: { delete: [], archive: [] }, pr: 9, holdingDir: mkdtempSync(join(tmpdir(), 'h-')), runId: 'r3', runStartMs: Date.now(), settleMs: 0,
    procOpts: { platform: 'linux', procRoot: mkdtempSync(join(tmpdir(), 'p-')) },
    hooks: { afterMove: () => { try { writeFileSync(join(wt, 'HANDOFF.md'), 'x'); } catch (e) { err = e; } } } });
  assert.equal(err?.code, 'ENOENT');
});

test('restoreLeftovers: a quarantine left by a killed run goes back to its original path', () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const q = join(repo.dir, '.worktrees', '.prune-quarantine', 'agent-x.dead');
  mkdirSync(join(repo.dir, '.worktrees', '.prune-quarantine'));
  repo.git(['worktree', 'move', wt, q]);
  const r = restoreLeftovers(repo.dir, '.worktrees');
  assert.deepEqual(r.map((x) => x.restored), [true]);
  assert.equal(existsSync(wt), true);
});
```

Add one more for the processes arm: a fake `/proc` whose pid `cwd` symlink points into the quarantine path created inside
`hooks.afterMove` ⇒ restored + reason `in use during removal` (skip on win32 like Task 3).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per the algorithm. `settleMs` waits via
  `await new Promise((r) => setTimeout(r, settleMs))`.
- [ ] **Step 4: Run** `npm test` → PASS. **Step 5: Commit** `git commit -am "feat(worktrees): quarantine-move removal with re-inspection and leftover restore"`.

---

### Task 6: The `worktrees` command (prune / keep / unkeep / holding) + notify + docs

**Files:**
- Create: `pipeline/commands/worktrees.mjs`
- Modify: `pipeline/lib/notify.mjs` (EVENTS: add `worktrees: { label: 'Worktree cleanup', priority: 3, tag: 'broom' }`)
- Modify: `docs/cli.md` (new `## worktrees` section, alphabetical: after `## version`, before the exempt final section)
- Test: `test/worktrees-cli.test.mjs`

**Interfaces:**
- Consumes everything above; `withLock`, `LockTimeoutError` (`lib/locks.mjs`); `requireConfig` (via the canonical root —
  NOT `resolveRepo`'s checkout); `createGitHub`, `guardGh`; `notifyEvent`.
- Produces `meta.usage` (exact text — `docs/cli.md` and `test/skills-commands.test.mjs` read it):

```
pipeline worktrees prune [--repo DIR] [--dry-run] [--notify]   -> {ok, mode, removed:[...], wouldRemove:[...], kept:[...], restored:[...], outside:[...], holding:{batches, purged}}
pipeline worktrees keep NAME [--reason TEXT] [--repo DIR]   -> {ok, slug, locked}
pipeline worktrees unkeep NAME [--run ID] [--repo DIR]   -> {ok, slug, unlocked}
pipeline worktrees holding [--purge] [--repo DIR]   -> {ok, batches:[...], purged:[...]}
pipeline worktrees schedule (--install | --remove | --status) [--at HH:MM] [--repo DIR]   -> {ok, installed, line, timezone}
```

**`prune` flow:**
1. `parseCommandArgs`; `{ root, commonDir } = resolveCanonicalRoot(values.repo ?? ctx.cwd)`; `{ config } = await requireConfig(root)`;
   `w = config.worktrees`; `mode = w.mode`; `dryRun = values['dry-run']`.
2. `mode === 'off'` and not dry-run ⇒ still run `restoreLeftovers` (allowed in every mode), return `{ ok:true, mode:'off', disabled:true, restored }`.
3. Lock: `withLock(lockNameFor(commonDir), fn, { dir: env.PIPELINE_LOCK_DIR || undefined, waitMs: 0 })` — a held lock ⇒
   `{ ok:true, skipped:'already running' }` exit 0 (catch `LockTimeoutError`).
4. Inside the lock: if any `index.lock` exists under `commonDir` (top-level or `worktrees/*/index.lock`) ⇒ return
   `{ ok:true, skipped:'git operation in progress' }`.
5. `restoreLeftovers` (skip actual moves on `--dry-run`; report what would be restored).
6. `guardGh`: `gh = createGitHub({ cwd: root, env })`; `checkRepoIdentity(gh, git remote get-url origin)`; failure ⇒
   `unavailable` ⇒ throw for exit 3, mismatch ⇒ `Fail(EXIT.USAGE, {error:'repo-mismatch'})`.
7. For each candidate (sequentially): PRs (`fetchBranchPrs`) → `selectLifecycle` → `checkAncestry` → `entriesFor` +
   `classifyEntries` (blockers ⇒ kept) → in-use signals (`processesInside`, `transcriptMentions([path, branch])` over
   `defaultTranscriptDirs()` since `now - min_idle_hours`, `memoryMentions`, `recentFiles` over `walkTree` ignoring
   delete+archive) → `inUseReasons` (non-empty ⇒ kept). First failure ⇒ `kept.push({ slug, reason })`.
8. Eligible: `modeAllows(mode,'remove',{dryRun})` ⇒ `removeWorktree(...)` (re-check lock state and HEAD first: re-read
   `listWorktrees` entry; changed ⇒ kept `changed during the run`) ⇒ `removed` / `kept`; else ⇒ `wouldRemove` with size
   (`du`-style sum of walk sizes).
9. Outside-worktree report (spec §6, report only): container-root `.claude/*brief*`, `.claude/*.patch`,
   `.claude/*-ledgers/`, root `.review/`, `.verify/`, `screenshots from mac/` (exists-only), and `/tmp/claude-<uid>/`
   session dirs (top two levels, size + newest mtime) → `outside: [{ path, bytes, newestMs }]`.
10. Holding: `listHolding`; `modeAllows(mode,'purge',{dryRun})` ⇒ `purgeHolding`.
11. Log line appended to `<PIPELINE_PRUNE_LOG_DIR or ~/.local/state/pipeline>/prune-<slug>.log` (keep last 30 lines).
12. `--notify` and (`removed.length || restored.length`) ⇒ `notifyEvent({ event:'worktrees', pr:null, action: summary, ids: removed.map(r => r.slug) }, { cwd: root, env, ...ctx.notifyDeps })`.
13. Output `{ ok:true, mode, dryRun, removed, wouldRemove, kept, restored, outside, holding, summary }` where `summary` is
    the one-line text in spec §7.

**`keep NAME`**: find the worktree `<root>/<worktree_dir>/NAME` in `listWorktrees`; already locked with a non-pipeline
reason ⇒ `{ ok:true, locked:false, reason:'already locked by someone else' }`; else
`git worktree lock --reason "pipeline-keep: <TEXT or 'kept by hand'>" <path>` (if already locked by pipeline-keep:
`unlock` then `lock` to refresh the reason).
**`unkeep NAME [--run ID]`**: unlock only when the lock reason starts with `pipeline-keep:` and, if `--run` is given,
contains `ship run <ID>`; otherwise `{ ok:true, unlocked:false, reason }`.
**`holding [--purge]`**: list; `--purge` obeys the mode table (`report`/`off` ⇒ `purged: []`, `note: 'purge needs mode: on'`).

- [ ] **Step 1: Write failing CLI tests** — `test/worktrees-cli.test.mjs`, spawning the real CLI like
  `test/artifacts.test.mjs` with `createFakeGh` (match `^repo view` → `REPO_VIEW` and `^api graphql` → a page whose nodes
  are the scripted PRs; `PIPELINE_HOLDING_DIR`, `PIPELINE_PRUNE_LOG_DIR`, `PIPELINE_LOCK_DIR`, `HOME` all pointed at temp
  dirs so transcripts/memory are empty). The origin must be named so `checkRepoIdentity` passes: add the bare origin as
  `origin` and also set `remote.origin.url` to `https://github.com/acme/widgets.git` with
  `url.<bare path>.insteadOf=https://github.com/acme/widgets.git` so fetches still hit the bare repo. Tests:
  1. `report` mode (default) with one eligible merged worktree ⇒ exit 0, `wouldRemove` has it, **filesystem snapshot
     identical** before/after (paths + mtimes of the whole temp tree, holding dir with an expired batch included).
  2. `off` mode ⇒ `disabled:true`, snapshot identical, expired holding batch still there.
  3. `--dry-run` with `mode: on` ⇒ snapshot identical.
  4. `mode: on` ⇒ eligible removed, open-PR worktree kept with `open PR #…`, no-PR worktree kept, local-only-commit
     worktree kept, untracked-file worktree kept; holding has the archived `.review` file; branch refs unchanged.
  5. Invoked with `--repo <a linked worktree>` ⇒ same `kept`/`wouldRemove` as from the main checkout.
  6. GraphQL failure for one branch (fake gh returns exit 1 when the argv contains that branch) ⇒ that worktree kept with
     `PR data incomplete`, others still evaluated.
  7. `repo view` fails ⇒ exit 3, snapshot identical.
  8. Second concurrent run (hold the lock first with `test/fixtures/hold-lock.mjs` using the same lock name) ⇒
     `skipped: 'already running'`.
  9. `keep` then `prune` (mode on) ⇒ kept `locked (pipeline-keep: …)`; `unkeep --run 5` on a lock with run 7 ⇒ not
     unlocked; `unkeep --run 7` ⇒ unlocked; `unkeep` on an owner lock (`git worktree lock --reason owner`) ⇒ not unlocked.
  10. A leftover quarantine from a "killed run" (created with `git worktree move`) is restored in `off` mode too.
- [ ] **Step 2: Run** `npm test -- worktrees-cli` → FAIL.
- [ ] **Step 3: Implement** `pipeline/commands/worktrees.mjs` per the flow above (sub-verb dispatch like `job.mjs`), add
  the notify EVENT, write the `docs/cli.md` section: summary line + the exact `meta.usage` block + a short paragraph
  linking the spec and stating the mode table.
- [ ] **Step 4: Run** `npm test` (whole suite: `cli.test.mjs` checks docs drift, `notify-coverage` the event table) → PASS.
- [ ] **Step 5: Commit** `git add pipeline/commands/worktrees.mjs pipeline/lib/notify.mjs docs/cli.md test/worktrees-cli.test.mjs && git commit -m "feat(worktrees): pipeline worktrees prune/keep/unkeep/holding command"`

---

### Task 7: Nightly schedule (`worktrees schedule`)

**Files:**
- Modify: `pipeline/commands/worktrees.mjs` (`schedule` sub-verb)
- Test: `test/worktrees-cli.test.mjs` (append; unit-level via exported `scheduleLine` + injected crontab)

**Interfaces:**
- Produces: `scheduleLine({ nodePath, binPath, root, at }) -> string` and `applySchedule({ action, line, marker, crontabFn, tzFn })`.
  Marker comment: `# claude-pipeline worktrees-prune <lockName>`.
  Line: `<MM> <HH> * * * cd <root-quoted> && <nodePath> <binPath> worktrees prune --notify >/dev/null 2>&1 # claude-pipeline worktrees-prune <lockName>`.
- `--install`: Linux only (else exit 2 `schedule is only supported on Linux (cron) in this version`); reads `crontab -l`
  (no crontab ⇒ empty), replaces any line with the same marker, writes via `crontab -`; returns
  `{ installed:true, line, timezone, warning? }` where `timezone` comes from `/etc/timezone` or `timedatectl show -p Timezone --value`;
  a zone other than `Asia/Manila` ⇒ `warning: 'cron runs in <zone>, not Asia/Manila — 02:30 is local to that zone'`.
  Default `--at 02:30`. `nodePath = process.execPath`, `binPath` = this install's `pipeline/bin/pipeline.mjs` (absolute).
- `--remove`: drops the marker line. `--status`: reports whether it is present.

- [ ] **Step 1: Failing tests** for `scheduleLine` (format, quoting a root with spaces), `applySchedule` install (adds
  one line, idempotent on second install, preserves other lines incl. the two existing `# claude-memory-health` style
  entries), remove, status, tz warning, non-Linux refusal.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git commit -am "feat(worktrees): nightly cron schedule install/remove/status"`

---

### Task 8: Ship integration

**Files:**
- Modify: `skills/ship/SKILL.md` — Step 0 (after `P labels ensure`, ~line 91), Step 1 (after the `git worktree add`, ~line 101),
  Step 7 (~line 311), Resume step 3 (~line 350)
- Test: existing `test/skills-commands.test.mjs`, `test/notify-coverage.test.mjs` (must stay green)

- [ ] **Step 1: Edit SKILL.md:**
  - Step 0, new bullet after labels: ``P worktrees prune --notify`` — "removes worktrees whose PR merged ≥ 24h ago (only
    when `worktrees.mode: on`; otherwise it reports). Read `summary`; never act on `kept` yourself."
  - Step 1, after the `git worktree add` block: ``P worktrees keep agent-<slug> --reason "ship run <runId>"`` — "so no
    cleanup removes the worktree while this run uses it."
  - Resume step 3, after the worktree is in place: the same `keep` line with the resumed run id.
  - Step 7: replace "Remove the worktree (git worktree remove …) when the PR is merged or closed; keep it while the PR
    waits…" with: ``P worktrees unkeep agent-<slug> --run <runId>`` then ``P worktrees prune --notify`` — "the worktree is
    removed by prune once its PR has been merged for 24 h; never remove it by hand."
- [ ] **Step 2: Run** `npm test` → PASS (the skills-commands test validates every `P worktrees … --flag` against
  `meta.usage`).
- [ ] **Step 3: Commit** `git commit -am "feat(ship): keep-lock the run's worktree and prune finished ones at Step 0/7"`

---

### Task 9: Real-machine validation (report mode) + PR evidence

**Files:** none in the repo (evidence goes into the PR body).

- [ ] **Step 1:** From this worktree run against eaglewatch in report mode (no config change there; default is report):
  `node pipeline/bin/pipeline.mjs worktrees prune --repo ~/projects/eaglewatch --dry-run` — capture the JSON to the
  scratchpad; confirm: the three merged worktrees from the 2026-10-13 survey are in `wouldRemove` or kept with a reason
  that matches reality (e.g. "a Claude session mentioned it recently"); every OPEN-PR worktree is kept; `outside` lists
  the root scratch and `/tmp/claude-1000`; nothing on disk changed (`git -C ~/projects/eaglewatch worktree list` identical
  before/after).
- [ ] **Step 2:** Run the same from inside an eaglewatch linked worktree (`--repo ~/projects/eaglewatch/.worktrees/<any>`)
  and diff the two JSON outputs (must be identical except timing fields).
- [ ] **Step 3:** WSL2 runtime checks (spec §10): (a) `processesInside` finds this session's shell when its cwd is inside
  a test worktree; (b) `git worktree move` of a worktree with a live process cwd inside succeeds and the process's
  `/proc/<pid>/cwd` follows the move (record result); (c) `worktrees schedule --status` reports the zone.
- [ ] **Step 4:** Record results for the PR body. No commit.

---

## Not in this plan (owner steps after merge)

- Install the new pipeline version (`install.mjs`), then `P worktrees schedule --install --repo ~/projects/eaglewatch`.
- After ≥ 3 nights of reports: owner sets `worktrees: { mode: on }` in eaglewatch's `.claude/pipeline.yml` (an
  eaglewatch PR), and in the same session the two global CLAUDE.md copies + memory
  `feedback-auto-remove-finished-worktrees` are reconciled (spec §8 step 4).
