import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../pipeline/lib/config.mjs';
import { classifyHardStops } from '../pipeline/lib/hardstops.mjs';
import { assessRisk, isLightLane, reviewLane } from '../pipeline/lib/risk.mjs';

const config = (risk = {}) => {
  const c = structuredClone(DEFAULTS);
  c.risk = { ...c.risk, high_risk_paths: ['supabase/migrations/**', 'app/api/payroll/**'], ...risk };
  return c;
};

// `n` lines split evenly into added/removed on one file.
const file = (path, n, { status = 'M', oldPath } = {}) => {
  const added = Array.from({ length: Math.ceil(n / 2) }, (_, i) => ({ line: i + 1, text: 'a' }));
  const removed = Array.from({ length: Math.floor(n / 2) }, (_, i) => ({ line: i + 1, text: 'r' }));
  return { oldPath: oldPath ?? path, newPath: path, path, status, binary: false, added, removed };
};
const hit = (rule = 'R2-auth', f = 'lib/a.ts') => ({ rule, file: f, detail: 'x' });

test('(a) 10 lines, no hits -> low, light lane', () => {
  const files = [file('lib/a.ts', 10)];
  const r = assessRisk({ files, hits: [], config: config() });
  assert.equal(r.level, 'low');
  assert.deepEqual(r.reasons, ['small change']);
  assert.equal(r.changedLines, 10);
  assert.equal(r.fileCount, 1);
  assert.equal(isLightLane({ level: r.level, changedLines: r.changedLines, hits: [], config: config() }), true);
});

test('(b) 200 lines -> medium', () => {
  const r = assessRisk({ files: [file('lib/a.ts', 200)], hits: [], config: config() });
  assert.equal(r.level, 'medium');
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /200 changed lines/);
});

test('(c) 11 files x 2 lines -> medium', () => {
  const files = Array.from({ length: 11 }, (_, i) => file(`lib/f${i}.ts`, 2));
  const r = assessRisk({ files, hits: [], config: config() });
  assert.equal(r.level, 'medium');
  assert.equal(r.fileCount, 11);
  assert.equal(r.changedLines, 22);
  assert.match(r.reasons.join('|'), /11 files/);
});

test('exactly the thresholds stay below them (> not >=)', () => {
  assert.equal(assessRisk({ files: [file('lib/a.ts', 150)], hits: [], config: config() }).level, 'low');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 151)], hits: [], config: config() }).level, 'medium');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 600)], hits: [], config: config() }).level, 'medium');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 601)], hits: [], config: config() }).level, 'high');
  const ten = Array.from({ length: 10 }, (_, i) => file(`lib/f${i}.ts`, 2));
  assert.equal(assessRisk({ files: ten, hits: [], config: config() }).level, 'low');
});

test('(d) any hard-stop hit -> high, reason lists the rules', () => {
  const r = assessRisk({ files: [file('lib/a.ts', 2)], hits: [hit('R1-destructive'), hit('R2-auth'), hit('R2-auth', 'b.ts')], config: config() });
  assert.equal(r.level, 'high');
  assert.equal(r.reasons[0], 'hard-stop: R1-destructive, R2-auth');
});

test('(e) a high_risk_paths match -> high (old or new path)', () => {
  const a = assessRisk({ files: [file('supabase/migrations/1_x.sql', 2, { status: 'A' })], hits: [], config: config() });
  assert.equal(a.level, 'high');
  assert.match(a.reasons.join('|'), /high-risk path/);
  assert.match(a.reasons.join('|'), /supabase\/migrations\/1_x\.sql/);
  const b = assessRisk({ files: [file('lib/moved.ts', 2, { status: 'R', oldPath: 'app/api/payroll/route.ts' })], hits: [], config: config() });
  assert.equal(b.level, 'high');
  const c = assessRisk({ files: [file('Supabase/Migrations/2.sql', 2)], hits: [], config: config() });
  assert.equal(c.level, 'high');
});

test('(f) 700 lines -> high', () => {
  const r = assessRisk({ files: [file('lib/a.ts', 700)], hits: [], config: config() });
  assert.equal(r.level, 'high');
  assert.match(r.reasons.join('|'), /700 changed lines/);
});

test('(g) low with 60 lines -> not light lane; the lane needs low + no hits + under the cap', () => {
  const c = config({ medium_lines: 150 });
  const r = assessRisk({ files: [file('lib/a.ts', 60)], hits: [], config: c });
  assert.equal(r.level, 'low');
  assert.equal(isLightLane({ level: r.level, changedLines: r.changedLines, hits: [], config: c }), false);
  assert.equal(isLightLane({ level: 'low', changedLines: 49, hits: [], config: c }), true);
  assert.equal(isLightLane({ level: 'low', changedLines: 50, hits: [], config: c }), false);
  assert.equal(isLightLane({ level: 'low', changedLines: 1, hits: [hit()], config: c }), false);
  assert.equal(isLightLane({ level: 'medium', changedLines: 1, hits: [], config: c }), false);
  assert.equal(isLightLane({ level: 'high', changedLines: 1, hits: [], config: c }), false);
  assert.equal(isLightLane({ level: 'low', changedLines: 10, hits: [], config: { review: { light_lane_max_lines: 5 } } }), false);
});

test('reasons accumulate: hard-stop plus big diff plus risky path', () => {
  const r = assessRisk({ files: [file('app/api/payroll/route.ts', 700)], hits: [hit()], config: config() });
  assert.equal(r.level, 'high');
  assert.equal(r.reasons.length, 3);
});

test('no files and no hits is a low, light-lane change', () => {
  const r = assessRisk({ files: [], hits: [], config: config() });
  assert.deepEqual({ level: r.level, changedLines: r.changedLines, fileCount: r.fileCount }, { level: 'low', changedLines: 0, fileCount: 0 });
});

test('config thresholds are honoured, and a config without a risk section uses the defaults', () => {
  const tight = config({ medium_lines: 5, high_lines: 8, medium_files: 1 });
  assert.equal(assessRisk({ files: [file('lib/a.ts', 6)], hits: [], config: tight }).level, 'medium');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 9)], hits: [], config: tight }).level, 'high');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 1), file('lib/b.ts', 1)], hits: [], config: tight }).level, 'medium');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 200)], hits: [], config: {} }).level, 'medium');
  assert.equal(assessRisk({ files: [file('lib/a.ts', 700)], hits: [], config: {} }).level, 'high');
});

// ---- hardening: bad inputs must fail loudly, never quietly downgrade a PR -------------------------------------------

test('assessRisk throws TypeError unless hits and files are arrays', () => {
  for (const hits of [Promise.resolve([]), {}, undefined, null, 'x', 3]) {
    assert.throws(() => assessRisk({ files: [], hits, config: config() }), TypeError, String(hits));
  }
  assert.throws(() => assessRisk({ files: undefined, hits: [], config: config() }), TypeError);
  assert.throws(() => assessRisk({ files: {}, hits: [], config: config() }), TypeError);
});

test('assessRisk throws TypeError when a threshold is not a finite number (a string compares wrongly, NaN never trips)', () => {
  for (const [key, bad] of [['medium_lines', '150'], ['high_lines', NaN], ['medium_files', Infinity], ['high_lines', null], ['medium_lines', {}]]) {
    assert.throws(() => assessRisk({ files: [file('lib/a.ts', 2)], hits: [], config: config({ [key]: bad }) }), TypeError, `${key}=${String(bad)}`);
  }
  // A missing threshold falls back to the default instead of throwing.
  const c = config();
  delete c.risk.medium_lines;
  assert.equal(assessRisk({ files: [file('lib/a.ts', 200)], hits: [], config: c }).level, 'medium');
});

test('assessRisk throws TypeError when high_risk_paths is not a list of strings', () => {
  assert.throws(() => assessRisk({ files: [file('lib/a.ts', 2)], hits: [], config: config({ high_risk_paths: 'supabase/**' }) }), TypeError);
  assert.throws(() => assessRisk({ files: [file('lib/a.ts', 2)], hits: [], config: config({ high_risk_paths: [1] }) }), TypeError);
});

test('isLightLane throws TypeError on bad inputs instead of answering true', () => {
  const ok = { level: 'low', changedLines: 1, hits: [], config: config() };
  assert.equal(isLightLane(ok), true);
  for (const bad of [{ hits: Promise.resolve([]) }, { hits: undefined }, { changedLines: '1' }, { changedLines: NaN }, { changedLines: undefined }, { level: 'LOW' }, { level: undefined }]) {
    assert.throws(() => isLightLane({ ...ok, ...bad }), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => isLightLane({ ...ok, config: { review: { light_lane_max_lines: '50' } } }), TypeError);
  assert.throws(() => isLightLane({ ...ok, config: { review: { light_lane_max_lines: NaN } } }), TypeError);
});

test('high_risk_paths are matched case-insensitively (glob nocase) on old and new paths', () => {
  assert.equal(assessRisk({ files: [file('SUPABASE/MIGRATIONS/1.sql', 2)], hits: [], config: config() }).level, 'high');
  assert.equal(assessRisk({ files: [file('lib/x.ts', 2, { status: 'R', oldPath: 'App/Api/Payroll/route.ts' })], hits: [], config: config() }).level, 'high');
});

test('a hard-stop hit keeps a many-file change high (the file-count rule never downgrades)', () => {
  const files = Array.from({ length: 11 }, (_, i) => file(`lib/f${i}.ts`, 2));
  const r = assessRisk({ files, hits: [hit('R4-pipeline')], config: config() });
  assert.equal(r.level, 'high');
  assert.equal(r.reasons[0], 'hard-stop: R4-pipeline');
  assert.match(r.reasons.join('|'), /11 files > 10/);
  assert.equal(isLightLane({ level: r.level, changedLines: r.changedLines, hits: [hit()], config: config() }), false);
});

// ---- Phase 2: only blocking (and owner-approved) hits raise to high; report-only hits raise to medium -----------------

const advisory = (rule = 'P-path', f = 'docs/legal/terms.md') => ({ rule, file: f, detail: 'x', advisory: true });
const ownerChat = (rule = 'R2-auth', f = 'lib/a.ts') => ({ rule, file: f, detail: 'x', advisory: true, ownerMerge: true });

test('advisory-only hits -> medium (never high, never low), reason names them as advisory', () => {
  const r = assessRisk({ files: [file('docs/legal/terms.md', 2)], hits: [advisory(), advisory('R5-deps', 'package.json')], config: config() });
  assert.equal(r.level, 'medium');
  assert.deepEqual(r.reasons, ['advisory hard-stop: P-path, R5-deps']);
  assert.equal(isLightLane({ level: r.level, changedLines: r.changedLines, hits: [advisory()], config: config() }), false);
});

test('a real report-only fixture (hard_stops.report_only_paths) scores medium; the same path as a hard-stop path scores high', () => {
  const files = [file('docs/legal/terms.md', 4)];
  const soft = config();
  soft.hard_stops = { ...soft.hard_stops, report_only_paths: ['docs/legal/**'] };
  const softHits = classifyHardStops({ files, config: soft });
  assert.ok(softHits.length > 0 && softHits.every((h) => h.advisory === true && !h.ownerMerge), JSON.stringify(softHits));
  assert.equal(assessRisk({ files, hits: softHits, config: soft }).level, 'medium');

  const hard = config();
  hard.hard_stops = { ...hard.hard_stops, paths: ['docs/legal/**'] };
  const hardHits = classifyHardStops({ files, config: hard });
  assert.ok(hardHits.some((h) => !h.advisory), JSON.stringify(hardHits));
  assert.equal(assessRisk({ files, hits: hardHits, config: hard }).level, 'high');

  // owner_approval: chat turns the blocking hit advisory + ownerMerge: still high (the owner approves it in chat).
  const chat = { ...hard, owner_approval: 'chat' };
  const chatHits = classifyHardStops({ files, config: chat });
  assert.ok(chatHits.length > 0 && chatHits.every((h) => h.advisory === true && h.ownerMerge === true), JSON.stringify(chatHits));
  assert.equal(assessRisk({ files, hits: chatHits, config: chat }).level, 'high');
});

test('an ownerMerge hit -> high; a blocking hit next to advisory ones -> high, both reasons listed', () => {
  assert.equal(assessRisk({ files: [file('lib/a.ts', 2)], hits: [ownerChat()], config: config() }).level, 'high');
  const r = assessRisk({ files: [file('lib/a.ts', 2)], hits: [advisory(), hit('R1-destructive')], config: config() });
  assert.equal(r.level, 'high');
  assert.deepEqual(r.reasons, ['hard-stop: R1-destructive', 'advisory hard-stop: P-path']);
});

test('a malformed hit (advisory not exactly true) counts as blocking: it can never lower the level', () => {
  for (const h of [{ rule: 'R2-auth', advisory: 'true' }, { rule: 'R2-auth', advisory: 1 }, null]) {
    assert.equal(assessRisk({ files: [file('lib/a.ts', 2)], hits: [h], config: config() }).level, 'high', JSON.stringify(h));
  }
});

test('advisory hits plus a big diff still reach high by size', () => {
  assert.equal(assessRisk({ files: [file('lib/a.ts', 700)], hits: [advisory()], config: config() }).level, 'high');
});

// ---- review lane: who follows Codex ------------------------------------------------------------------------------

test('reviewLane: low and no sensitive path -> judge; medium or high -> fable', () => {
  assert.deepEqual(reviewLane({ level: 'low', files: [file('lib/a.ts', 2)], config: config() }), { reviewer: 'judge', reasons: [], sensitivePaths: [] });
  assert.deepEqual(reviewLane({ level: 'medium', files: [file('lib/a.ts', 2)], config: config() }).reasons, ['medium risk']);
  assert.equal(reviewLane({ level: 'medium', files: [], config: config() }).reviewer, 'fable');
  assert.equal(reviewLane({ level: 'high', files: [], config: config() }).reviewer, 'fable');
});

test('reviewLane: a low-risk PR touching review.arbiter_always_paths (old or new path, any case) -> fable, path listed', () => {
  const c = config();
  c.review = { ...c.review, arbiter_always_paths: ['lib/auth/**'] };
  const a = reviewLane({ level: 'low', files: [file('lib/auth/session.ts', 2)], config: c });
  assert.deepEqual(a, { reviewer: 'fable', reasons: ['sensitive path: lib/auth/session.ts'], sensitivePaths: ['lib/auth/session.ts'] });
  assert.equal(reviewLane({ level: 'low', files: [file('lib/x.ts', 2, { status: 'R', oldPath: 'LIB/Auth/old.ts' })], config: c }).reviewer, 'fable');
  // high_risk_paths are sensitive too (they also make the PR high).
  assert.deepEqual(reviewLane({ level: 'high', files: [file('supabase/migrations/1.sql', 2)], config: config() }).sensitivePaths, ['supabase/migrations/1.sql']);
  // A config without the key uses the default (no extra paths).
  assert.equal(reviewLane({ level: 'low', files: [file('lib/auth/session.ts', 2)], config: {} }).reviewer, 'judge');
});

test('reviewLane throws TypeError on bad inputs instead of answering judge', () => {
  const ok = { level: 'low', files: [], config: config() };
  for (const bad of [{ level: 'LOW' }, { level: undefined }, { files: undefined }, { files: Promise.resolve([]) }]) {
    assert.throws(() => reviewLane({ ...ok, ...bad }), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => reviewLane({ ...ok, config: { review: { arbiter_always_paths: 'lib/**' } } }), TypeError);
  assert.throws(() => reviewLane({ ...ok, config: { review: { arbiter_always_paths: [1] } } }), TypeError);
});
