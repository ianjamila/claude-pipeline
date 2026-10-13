import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeAllows, lockNameFor, matchesPattern, classifyEntries, selectLifecycle, isProtectedName, inUseReasons } from '../pipeline/lib/worktree-prune/rules.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';

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

test('classifyEntries: a nested .env* blocks even under a delete or archive pattern', () => {
  const cfg = { delete: ['node_modules/', '.vercel/'], archive: ['.review/'] };
  const r = classifyEntries([
    { path: 'node_modules/.env.x', kind: 'ignored' },
    { path: '.vercel/.env.local', kind: 'ignored' },
    { path: '.review/.env', kind: 'ignored' },
    { path: 'node_modules/dotenv/index.js', kind: 'ignored' },
  ], cfg);
  assert.deepEqual(r.blockers.sort(), ['.review/.env', '.vercel/.env.local', 'node_modules/.env.x']);
  assert.deepEqual(r.del, ['node_modules/dotenv/index.js']);
  assert.deepEqual(r.arch, []);
});

test('classifyEntries: an archive pattern wins over a delete pattern (default *.log never deletes .verify/.review evidence)', () => {
  const r = classifyEntries([
    { path: '.verify/logs/tests.log', kind: 'ignored' },
    { path: '.review/reviewer.log', kind: 'ignored' },
    { path: 'npm-debug.log', kind: 'ignored' },
    { path: 'node_modules/.review/x.js', kind: 'ignored' },
  ], DEFAULTS.worktrees);
  assert.deepEqual(r.arch.sort(), ['.review/reviewer.log', '.verify/logs/tests.log']);
  assert.deepEqual(r.del.sort(), ['node_modules/.review/x.js', 'npm-debug.log']);
  assert.deepEqual(r.blockers, []);
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
