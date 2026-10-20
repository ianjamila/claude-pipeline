import test from 'node:test';
import assert from 'node:assert/strict';
import { activeProposal, latestApproval, planResumeFacts, planScopeVerdict, startsValidity } from '../pipeline/lib/plan-state.mjs';
import { parsePlan, scopeDigest } from '../pipeline/lib/plan.mjs';
const BIND = { repo: 'a/b', pr: 7, branch: 'agent/x' };
const A = 'a'.repeat(40), B = 'b'.repeat(40);
let id = 0;
const ev = (kind, data, extra = {}) => ({ kind, id: `e${++id}`, commentId: id, createdAt: `2026-10-19T00:00:${String(id).padStart(2, '0')}Z`, tampered: false, dataStatus: 'ok', data: { ...BIND, ...data }, ...extra });
const PLAN = (scope) => `## In plain English\nx\n\n## Scope\n${scope.map((s) => `- \`${s}\``).join('\n')}\n\n### Task T1: t\nbody\n`;

test('active proposal = latest; restoring an earlier blob makes it active again', () => {
  const evs = [ev('plan-proposed', { blob: A, n: 1 }), ev('plan-proposed', { blob: B, n: 2 }), ev('plan-proposed', { blob: A, n: 3 })];
  assert.equal(activeProposal(evs, BIND).blob, A);
  assert.equal(activeProposal([...evs.slice(0, 2)], BIND).blob, B);
  assert.equal(activeProposal([ev('plan-proposed', { blob: A }, { tampered: true })], BIND).status, 'lost');
  assert.equal(activeProposal([ev('plan-proposed', { blob: A, pr: 8 })], BIND).status, 'lost');
});

test('a tampered or unreadable event newer than the latest approval blocks fallback', () => {
  const ok = ev('plan-approved', { blob: A, recordId: '1'.repeat(16), promptSha256: 'p' });
  assert.equal(latestApproval([ok], BIND).status, 'approved');
  assert.equal(latestApproval([ok, ev('plan-proposed', { blob: B }, { tampered: true })], BIND).status, 'lost');
  assert.equal(latestApproval([ok, ev('plan-approved', {}, { dataStatus: 'invalid' })], BIND).status, 'lost');
});

const verdict = (over) => planScopeVerdict({
  events: [], bind: BIND, recordPlan: null, localRecords: [], readBlob: () => null,
  files: [{ oldPath: 'src/a.mjs', newPath: 'src/a.mjs', path: 'src/a.mjs' }], required: true, ownerApproval: 'chat', host: 'mac', ...over,
});

test('none: one owner-merge item; required:false reports only; label mode fails', () => {
  assert.deepEqual([verdict({}).ok, verdict({}).ownerItems], [true, ['plan-scope none']]);
  assert.deepEqual([verdict({ required: false }).ok, verdict({ required: false }).ownerMerge], [true, 0]);
  assert.equal(verdict({ ownerApproval: 'label' }).ok, false);
});

test('lost: proposal without approval, record plan without events, local record without events, missing blob', () => {
  assert.equal(verdict({ events: [ev('plan-proposed', { blob: A })] }).ok, false);
  assert.equal(verdict({ recordPlan: { blob: A } }).ok, false);
  assert.equal(verdict({ localRecords: [{ pr: 7, blob: A }] }).ok, false);
  const ap = ev('plan-approved', { blob: A, path: 'docs/plans/p.md', recordId: '1'.repeat(16), promptSha256: 'p', host: 'mac' });
  assert.match(verdict({ events: [ap] }).detail, /lost/);
});

test('approved: verified vs unverified, outside files listed, plan file allowed', () => {
  const ap = ev('plan-approved', { blob: A, path: 'docs/plans/p.md', recordId: '1'.repeat(16), promptSha256: 'p', host: 'pc' });
  const readBlob = (b) => (b === A ? PLAN(['src/**', 'docs/plans/p.md']) : null);
  const files = [{ path: 'src/a.mjs', oldPath: 'src/a.mjs', newPath: 'src/a.mjs' }, { path: 'x.mjs', oldPath: 'x.mjs', newPath: 'x.mjs' }, { path: 'docs/plans/p.md', oldPath: 'docs/plans/p.md', newPath: 'docs/plans/p.md' }];
  const unverified = verdict({ events: [ap], readBlob, files });
  assert.deepEqual(unverified.ownerItems.sort(), ['plan-scope outside x.mjs', 'plan-scope unverified pc']);
  const local = [{ pr: 7, blob: A, scopeDigest: scopeDigest(['src/**', 'docs/plans/p.md']), recordId: '1'.repeat(16), promptSha256: 'p' }];
  assert.deepEqual(verdict({ events: [ap], readBlob, files, localRecords: local }).ownerItems, ['plan-scope outside x.mjs']);
});

test('a copied approval pointer with a substituted path exempts nothing (Codex plan R1-1)', () => {
  const readBlob = (b) => (b === A ? PLAN(['src/**']) : null);
  const local = [{ pr: 7, blob: A, scopeDigest: scopeDigest(['src/**']), recordId: '1'.repeat(16), promptSha256: 'p' }];
  const forged = ev('plan-approved', { blob: A, path: 'x.mjs', recordId: '1'.repeat(16), promptSha256: 'p', host: 'mac' });
  const files = [{ path: 'x.mjs', oldPath: 'x.mjs', newPath: 'x.mjs' }];
  assert.deepEqual(verdict({ events: [forged], readBlob, files, localRecords: local }).ownerItems, ['plan-scope outside x.mjs']);
  // copy-modify-substitute: an unplanned plan-dir file named by a fresh pointer is still an item
  const other = ev('plan-approved', { blob: A, path: 'docs/plans/q.md', recordId: '1'.repeat(16), promptSha256: 'p', host: 'mac' });
  const q = [{ path: 'docs/plans/q.md', oldPath: 'docs/plans/q.md', newPath: 'docs/plans/q.md' }];
  assert.deepEqual(verdict({ events: [other], readBlob, files: q, localRecords: local }).ownerItems, ['plan-scope outside docs/plans/q.md']);
});

test('startsValidity: duplicate keys collapse, caps per PR, extras count only from their position on', () => {
  const s = (reviewer, key, extra) => ev('plan-review-started', { reviewer, key, planBlob: A, ...(extra ? { extra } : {}) });
  const evs = [s('codex', 'k1'), s('codex', 'k1'), s('codex', 'k2'), s('codex', 'k3'), s('codex', 'k4', 'owner: one more'), s('fable', 'f1'), s('fable', 'f2')];
  assert.deepEqual(startsValidity(evs).map((x) => [x.key, x.valid]), [['k1', true], ['k2', true], ['k3', false], ['k4', true], ['f1', true], ['f2', false]]);
  // a later extra never revives k3; a second extra is needed for a fifth run
  const more = [...evs, s('codex', 'k5'), s('codex', 'k6', 'owner: again')];
  assert.deepEqual(startsValidity(more).filter((x) => x.reviewer === 'codex').map((x) => x.valid), [true, true, false, true, false, true]);
  // an edited start counts against every reviewer
  assert.equal(startsValidity([s('codex', 'k1'), ev('plan-review-started', { reviewer: 'codex', key: 'k2', planBlob: A }, { tampered: true }), s('codex', 'k3')]).at(-1).valid, false);
});

test('startsValidity carries the claim of a start; a void start takes no slot', () => {
  const s = (key, claim) => ev('plan-review-started', { reviewer: 'codex', key, planBlob: A, ...(claim ? { claim } : {}) });
  const out = startsValidity([s('k1', 'c1'), s('k2'), s('k3'), s('k4')]);
  assert.deepEqual(out.map((x) => [x.key, x.valid, x.claim]), [['k1', true, 'c1'], ['k2', true, null], ['k3', false, null], ['k4', false, null]]);
  // an extra after the void k3 buys exactly one more run
  const more = startsValidity([s('k1'), s('k2'), s('k3'), ev('plan-review-started', { reviewer: 'codex', key: 'k4', planBlob: A, extra: 'owner: one more' }), s('k5')]);
  assert.deepEqual(more.map((x) => x.valid), [true, true, false, true, false]);
});

// ---- planResumeFacts --------------------------------------------------------------------------------------------------
const P1 = PLAN(['src/**']);
const SCOPE_D = scopeDigest(['src/**']);
const T1 = parsePlan(P1).tasks[0];
const facts = (over) => planResumeFacts({
  events: [ev('plan-proposed', { blob: A, scopeDigest: SCOPE_D }), ev('plan-approved', { blob: A, recordId: '1'.repeat(16), promptSha256: 'p', scopeDigest: SCOPE_D })],
  bind: BIND, recordPlan: null, localRecords: [], recordTasks: [], readBlob: (b) => (b === A ? P1 : null), ...over,
});

test('resume facts: approved plan with an empty record has open work and needs the approve checkpoint', () => {
  const f = facts({});
  assert.deepEqual([f.approval, f.openWork, f.needsApproveCheckpoint, f.evidence], ['unverified', true, true, true]);
});

test('resume facts: every task done at the matching specSha and an approved record plan: no open work, no checkpoint', () => {
  const local = [{ pr: 7, blob: A, scopeDigest: SCOPE_D, recordId: '1'.repeat(16), promptSha256: 'p' }];
  const f = facts({ recordPlan: { blob: A, state: 'approved' }, recordTasks: [{ id: 'T1', specSha: T1.specSha, done: true }], localRecords: local });
  assert.deepEqual([f.approval, f.openWork, f.needsApproveCheckpoint], ['verified', false, false]);
});

test('resume facts: a task done at an OLD specSha is open work', () => {
  const f = facts({ recordPlan: { blob: A, state: 'approved' }, recordTasks: [{ id: 'T1', specSha: 'f'.repeat(12), done: true }] });
  assert.equal(f.openWork, true);
  assert.equal(f.needsApproveCheckpoint, true);
});

test('resume facts: a blob that is not in the clone is lost', () => {
  const f = facts({ readBlob: () => null });
  assert.equal(f.approval, 'lost');
  assert.match(f.lostReason, /not in this clone/);
});

test('resume facts: no evidence at all; a proposal without approval', () => {
  assert.equal(planResumeFacts({ events: [], bind: BIND, recordPlan: null, localRecords: [], recordTasks: [], readBlob: () => null }).evidence, false);
  const f = planResumeFacts({ events: [ev('plan-proposed', { blob: A })], bind: BIND, recordPlan: null, localRecords: [], recordTasks: [], readBlob: () => null });
  assert.deepEqual([f.evidence, f.approval, f.active.blob], [true, 'none', A]);
});
