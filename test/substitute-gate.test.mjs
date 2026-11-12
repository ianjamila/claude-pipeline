// A PR a Claude stand-in reviewed while Codex was out of quota (plan 2026-11-11-codex-substitute-reviewer R4-1, R4-11, R5-1, R5-6, R5-10): the one inventory, the owner item and its Areas
// token in every gate route, the marker fields, the escalation / proof refusals, and the merge routes (owner-go only; label mode: by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { approvalGap } from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, runHook } from './helpers/owner-go.mjs';
import { PR, bump, cli, ghEntries, scenario, ymlFor } from './helpers/gate-env.mjs';
import { createFakeGh } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { claudeItem, publishedComments } from './helpers/rulings-world.mjs';
import { floorEnv } from './helpers/floor-env.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { areasOf, reviewCheck, reviewCompletionCheck, substituteRouteProblem } from '../pipeline/lib/finalgate.mjs';
import { recheckGated, recheckOwnerGo } from '../pipeline/lib/queue-route.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { parseReviewRecord } from '../pipeline/lib/review-marker.mjs';
import { reviewCompleteBody, reviewRecord } from '../pipeline/commands/review-complete.mjs';
import { substituteDigest, substituteInventory, substituteItemLine, substituteRefusal, substituteSummary } from '../pipeline/lib/triage.mjs';

const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
const goYml = (mode = 'chat') => `${ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}')}owner_approval: ${mode}\n`;
const MODELS = { 'substitute-opus': 'claude-opus-4-8', 'substitute-fable': 'claude-fable-5-2' };
const sub = (agent = 'substitute-opus', over = {}) => ({
  agent, models: { [MODELS[agent]]: 3 }, evidence: 'quota', resetAt: null, outageAt: '2026-11-11T07:23:00.000Z', attempts: 1,
  proof: { transcript: '/t/x.jsonl', models: { [MODELS[agent]]: 3 }, effort: 'high' }, ...over,
});
const round = (n, hash, over = {}) => ({ n, fromHead: 'a', toHead: 'b', contentHashAtToHead: hash, items: [], ...over });
// A state whose rounds are given as [n, extra] pairs; maxRounds 2 is the config default.
function stateOf(hash, rounds, { risk = 'low', pr = PR } = {}) {
  let s = emptyState({ repo: 'acme/widgets', pr, branch: 'agent/feature', risk, maxRounds: 2 });
  s.currentContentHash = hash;
  for (const [n, over] of rounds) s = addRound(s, round(n, hash, over));
  return s;
}
const subRound = (agent = 'substitute-opus', risk = 'low', over = {}) => ({ firstReviewer: 'substitute', substitute: sub(agent), risk, ...over });
const H = 'a'.repeat(64);

// ---- the inventory ---------------------------------------------------------------------------------------------------------------------

test('substituteInventory: rounds and substitute second reviews, one digest and one item line; Codex second reviews are not in it; a further review changes the digest', () => {
  const plain = stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low' }]]);
  assert.deepEqual(substituteInventory(plain), []);
  assert.equal(substituteDigest(plain), 'none');
  assert.equal(substituteItemLine(plain), null);
  assert.equal(substituteSummary(plain), null);
  const one = stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low' }], [2, subRound()]]);
  assert.deepEqual(substituteInventory(one), [{ round: 2, agent: 'substitute-opus', evidence: 'quota', models: ['claude-opus-4-8'] }]);
  assert.match(substituteItemLine(one), /^review-substitute substitute [0-9a-f]{12}$/);
  assert.deepEqual(areasOf([substituteItemLine(one)]), ['substitute']);
  assert.deepEqual(substituteSummary(one), { rounds: [2], agents: ['substitute-opus'], models: ['claude-opus-4-8'] });
  // a second review by a substitute (task D writes secondReview.by) joins the inventory; a Codex one does not; a cached copy is listed once
  const item = (id, by, over = {}) => ({ id, bucket: 'BLOCKING', category: 'bug', title: 't', fingerprint: `fp-${id}`, secondReview: { by, decision: 'ACCEPT', evidence: 'quota', models: ['claude-opus-4-8'] }, ...over });
  const two = stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low', items: [item('R1-B1', 'substitute-opus'), item('R1-B2', 'codex')] }], [2, subRound('substitute-opus', 'low', { items: [item('R2-B1', 'substitute-opus', { fingerprint: 'fp-R1-B1' })] })]]);
  const inv = substituteInventory(two);
  assert.deepEqual(inv.map((e) => e.round ?? e.item), [2, 'R1-B1']);
  assert.notEqual(substituteDigest(two), substituteDigest(one), 'a second review at the same head changes the digest');
  const more = stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low' }], [2, subRound()], [3, subRound()]]);
  assert.notEqual(substituteDigest(more), substituteDigest(one), 'a further substitute round changes it');
});

// ---- escalation and proof (review-complete, the gated route, the owner-go scan all call this) -----------------------------------------------

test('substituteRefusal: Opus-only cover of a PR that became high-risk is substitute-escalation until a whole-PR Fable-substitute or Codex round; a Codex incremental round does not clear it', () => {
  const rose = [[1, subRound('substitute-opus', 'medium')], [2, { codexModel: 'gpt-x', risk: 'high' }]];
  assert.equal(substituteRefusal(stateOf(H, rose, { risk: 'high' }))?.error, 'substitute-escalation');
  assert.equal(substituteRefusal(stateOf(H, [...rose, [3, { codexModel: 'gpt-x', risk: 'high' }]], { risk: 'high' }))?.error, 'substitute-escalation', 'an incremental Codex round after the rise is not coverage');
  assert.equal(substituteRefusal(stateOf(H, [...rose, [3, { codexModel: 'gpt-x', risk: 'high', wholePr: true }]], { risk: 'high' })), null, 'a whole-PR Codex round clears it');
  assert.equal(substituteRefusal(stateOf(H, [...rose, [3, subRound('substitute-fable', 'high', { wholePr: true })]], { risk: 'high' })), null, 'a whole-PR Fable-substitute round clears it');
  assert.equal(substituteRefusal(stateOf(H, [[1, subRound('substitute-opus', 'medium')]], { risk: 'medium' })), null, 'no rise: nothing owed');
  assert.equal(substituteRefusal(stateOf(H, [[1, subRound('substitute-fable', 'high')]], { risk: 'high' })), null, 'Fable from the start');
});

test('substituteRefusal: an unproven substitute round (wrong agent for the risk, wrong family, no transcript, effort, Fable under the floor) is substitute-unproven', () => {
  const one = (over, risk = 'low') => substituteRefusal(stateOf(H, [[1, { ...subRound('substitute-opus', risk), substitute: sub('substitute-opus', over) }]], { risk }));
  assert.equal(one({}), null);
  assert.match(one({ agent: 'someone-else' }).reason, /not substitute-opus or substitute-fable/);
  assert.match(one({ proof: { transcript: '', models: { 'claude-opus-4-8': 1 }, effort: 'high' } }).reason, /no proof transcript/);
  assert.match(one({ proof: { transcript: '/t', models: {}, effort: 'high' } }).reason, /records no model/);
  assert.match(one({ proof: { transcript: '/t', models: { 'claude-sonnet-4-5': 1 }, effort: 'high' } }).reason, /not a Opus/);
  assert.match(one({ proof: { transcript: '/t', models: { 'claude-opus-4-8': 1 }, effort: 'low' } }).reason, /effort "low" is not high/);
  // (a lone Opus round at high risk is an escalation first; with a later whole-PR Fable round that clears it, the Opus round itself is the wrong agent)
  const cleared = substituteRefusal(stateOf(H, [[1, subRound('substitute-opus', 'high')], [2, subRound('substitute-fable', 'high', { wholePr: true })]], { risk: 'high' }));
  assert.match(cleared.reason, /round 1: .*needs substitute-fable, but substitute-opus reviewed it/, 'wrong agent for a high-risk round');
  const fable = (models, gate) => substituteRefusal(stateOf(H, [[1, { ...subRound('substitute-fable', 'high'), substitute: sub('substitute-fable', { proof: { transcript: '/t', models, effort: 'high' } }) }]], { risk: 'high' }), gate);
  assert.equal(fable({ 'claude-fable-5-2': 2 }), null);
  assert.match(fable({ 'claude-opus-4-8': 2 }).reason, /not a Fable/, 'an Opus transcript offered for a Fable round');
  assert.match(fable({ 'claude-fable-5-2': 2 }, { threshold: 'claude-fable-5-3', allow: [] }).reason, /below the Fable floor/, 'a floor raised between apply and merge makes the round stale');
  assert.equal(substituteRefusal(stateOf(H, [[1, { firstReviewer: 'substitute', risk: 'low' }]]))?.error, 'substitute-unproven', 'marked substitute with no record at all');
});

// A substitute second review as task D stores it (state.mjs secondReview.by + evidence + models + proof).
const subItem = (id, agent = 'substitute-opus', over = {}, proofOver = {}) => ({
  id, bucket: 'BLOCKING', category: 'bug', title: 't', fingerprint: `fp-${id}`,
  secondReview: { by: agent, decision: 'ACCEPT', evidence: 'quota', models: { [MODELS[agent]]: 3 }, proof: { transcript: '/t/2nd.jsonl', models: { [MODELS[agent]]: 3 }, effort: 'high' , ...proofOver }, ...over },
});

test('substituteRefusal: a substitute SECOND review is judged like a round (agent, risk at that time, transcript, family, effort, Fable floor); a Codex second review and a proven one are not', () => {
  const two = (item, risk = 'low', gate) => substituteRefusal(stateOf(H, [[1, { codexModel: 'gpt-x', risk, items: [item] }]], { risk }), gate);
  assert.equal(two(subItem('R1-B1')), null, 'a proven Opus second review');
  assert.equal(two(subItem('R1-B1', 'substitute-fable', {}, {}), 'high'), null, 'a proven Fable second review at high risk');
  assert.equal(two({ ...subItem('R1-B1'), secondReview: { by: 'codex', decision: 'ACCEPT' } }), null, 'a Codex second review needs no substitute proof');
  const bad = (item, re, risk = 'low', gate) => {
    const r = two(item, risk, gate);
    assert.equal(r?.error, 'substitute-unproven');
    assert.match(r.reason, re);
  };
  bad({ ...subItem('R1-B1'), secondReview: { by: 'substitute-other', decision: 'ACCEPT' } }, /second review of R1-B1: agent "substitute-other" is not substitute-opus or substitute-fable/);
  bad({ ...subItem('R1-B1'), secondReview: { by: 'substitute-opus', decision: 'ACCEPT', evidence: 'quota' } }, /second review of R1-B1: no proof transcript/, 'low');
  bad(subItem('R1-B1', 'substitute-opus', {}, { transcript: '' }), /no proof transcript/);
  bad(subItem('R1-B1', 'substitute-opus', {}, { models: {} }), /records no model/);
  bad(subItem('R1-B1', 'substitute-opus', {}, { models: { 'claude-sonnet-4-5': 1 } }), /not a Opus/);
  bad(subItem('R1-B1', 'substitute-opus', {}, { effort: 'low' }), /effort "low" is not high/);
  bad(subItem('R1-B1', 'substitute-opus'), /needs substitute-fable, but substitute-opus reviewed it/, 'high');
  bad(subItem('R1-B1', 'substitute-fable', {}, { models: { 'claude-opus-4-8': 2 } }), /not a Fable/, 'high');
  bad(subItem('R1-B1', 'substitute-fable'), /below the Fable floor/, 'high', { threshold: 'claude-fable-5-3', allow: [] });
  // the risk a second review needed is the PR's at that round: a risk that rose only LATER does not make an Opus second review wrong, a risk already high does
  const later = substituteRefusal(stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low', items: [subItem('R1-B1')] }], [2, { codexModel: 'gpt-x', risk: 'high', wholePr: true }]], { risk: 'high' }));
  assert.equal(later, null);
  // a cached copy in a later round is the same review: one problem, not two
  const copy = stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low', items: [subItem('R1-B1', 'substitute-opus', {}, { effort: 'low' })] }], [2, { codexModel: 'gpt-x', risk: 'low', items: [subItem('R2-B1', 'substitute-opus', { }, { effort: 'low' })].map((i) => ({ ...i, fingerprint: 'fp-R1-B1' })) }]]);
  assert.equal(substituteRefusal(copy).reason.split('; ').length, 1);
});

// ---- the marker (R5-6) ------------------------------------------------------------------------------------------------------------------

// The parser as it stood before the substitute fields (validation copied from the commit before this one): it must accept the new marker and drop the keys it does not know.
function oldParse(body) {
  const lines = String(body).split('\n');
  const at = lines.indexOf('```json');
  const r = JSON.parse(lines[at + 1]);
  const HASH = /^[0-9a-f]{64}$/;
  const SHA = /^[0-9a-f]{40}$/;
  if (!HASH.test(String(r.contentHash)) || !SHA.test(String(r.base)) || !SHA.test(String(r.head))) return null;
  if (!Number.isInteger(r.rounds) || r.rounds < 1 || typeof r.codexModel !== 'string' || r.codexModel === '') return null;
  if (r.modelProofDigest !== null && !HASH.test(String(r.modelProofDigest))) return null;
  return { contentHash: r.contentHash, base: r.base, head: r.head, rounds: r.rounds, codexModel: r.codexModel, modelProofDigest: r.modelProofDigest };
}

test('marker: substitute and substituteDigest are written only with a substitute; codexModel is none-substitute:<model> with no Codex round, the newest Codex model when mixed; old and new parsers accept it', () => {
  const args = { contentHash: H, base: 'b'.repeat(40), head: 'c'.repeat(40), modelProofs: [], defaultCodexModel: 'gpt-default' };
  const plain = reviewRecord(stateOf(H, [[1, { codexModel: 'gpt-x', risk: 'low' }]]), args);
  assert.equal('substitute' in plain, false);
  assert.equal(plain.codexModel, 'gpt-x');
  const only = reviewRecord(stateOf(H, [[1, subRound()]]), args);
  assert.equal(only.codexModel, 'none-substitute:claude-opus-4-8');
  assert.deepEqual(only.substitute, { rounds: [1], agents: ['substitute-opus'], models: ['claude-opus-4-8'] });
  assert.match(only.substituteDigest, /^[0-9a-f]{64}$/);
  const mixed = reviewRecord(stateOf(H, [[1, { codexModel: 'gpt-old', risk: 'low' }], [2, subRound()], [3, { codexModel: 'gpt-new', risk: 'low' }], [4, subRound()]]), args);
  assert.equal(mixed.codexModel, 'gpt-new');
  const body = reviewCompleteBody(only);
  assert.match(body, /no Codex round, substitute review of round\(s\) 1 by substitute-opus/);
  const now = parseReviewRecord(body);
  assert.deepEqual(now.substitute, only.substitute);
  assert.equal(now.substituteDigest, only.substituteDigest);
  assert.equal(parseReviewRecord(reviewCompleteBody(plain)).substituteDigest, undefined, 'an ordinary marker reads exactly as before');
  assert.equal(oldParse(body).codexModel, 'none-substitute:claude-opus-4-8', 'an older vendored parser accepts it');
  // malformed fields are refused by the new parser
  const bad = (patch) => parseReviewRecord(reviewCompleteBody({ ...only, ...patch }));
  assert.equal(bad({ substituteDigest: 'zz' }), null);
  assert.equal(bad({ substitute: { rounds: ['x'], agents: [], models: [] } }), null);
  assert.equal(bad({ substitute: undefined }), null, 'a digest with no summary');
});

// ---- the gated route's review check, every return branch ------------------------------------------------------------------------------------------

async function reviewOf(state, { yml = goYml(), floor = {} } = {}) {
  const s = scenario({ yml, report: null, state: null, change: unique });
  const { config } = await loadConfig(s.repo.dir);
  const st = typeof state === 'function' ? state(s.hash) : state;
  saveState(s.repo.dir, st);
  return reviewCheck({ root: s.repo.dir, config, pr: PR, repo: 'acme/widgets', diff: () => ({ ok: true, files: ['src/app.js'] }), hash: s.hash, ownerGo: {}, floorOpts: { env: floorEnv(), ...floor } });
}

test('reviewCheck: the substitute item is on every passing branch (alone, with a Claude dismissal), a refused escalation / unproven round fails', async () => {
  const alone = await reviewOf((h) => stateOf(h, [[1, subRound()]]));
  assert.equal(alone.ok, true, alone.detail);
  assert.equal(alone.ownerMerge, 1);
  assert.match(alone.ownerItems[0], /^review-substitute substitute [0-9a-f]{12}$/);
  const withRuling = await reviewOf((h) => stateOf(h, [[1, subRound('substitute-opus', 'low', { items: [claudeItem()] })]]));
  assert.equal(withRuling.ok, true, withRuling.detail);
  assert.equal(withRuling.ownerMerge, 2);
  assert.ok(withRuling.ownerItems.some((l) => l.startsWith('review-ruling')) && withRuling.ownerItems.some((l) => l.startsWith('review-substitute')));
  const ordinary = await reviewOf((h) => stateOf(h, [[1, { codexModel: 'gpt-x', risk: 'low' }]]));
  assert.equal(ordinary.ownerMerge, undefined);
  const esc = await reviewOf((h) => stateOf(h, [[1, subRound('substitute-opus', 'medium')], [2, { codexModel: 'gpt-x', risk: 'high' }]], { risk: 'high' }));
  assert.equal(esc.ok, false);
  assert.match(esc.detail, /^substitute-escalation:/);
  const wrong = await reviewOf((h) => stateOf(h, [[1, subRound('substitute-opus', 'high')], [2, subRound('substitute-fable', 'high', { wholePr: true })]], { risk: 'high' }));
  assert.match(wrong.detail, /^substitute-unproven:.*substitute-fable/);
  const raised = await reviewOf((h) => stateOf(h, [[1, subRound('substitute-fable', 'high')]], { risk: 'high' }), { floor: { env: floorEnv() } });
  assert.equal(raised.ok, true, raised.detail);
});

// ---- the world: a PR whose review ended with a substitute round, through the real CLI -----------------------------------------------------------------

function world({ build = (h) => stateOf(h, [[1, subRound()]]), yml = goYml(), marker = {}, withReport = false } = {}) {
  const s = scenario({ yml, report: withReport ? undefined : null, state: null, change: unique });
  s.set = (state, over = {}) => {
    s.state = state;
    saveState(s.repo.dir, state);
    s.fake = createFakeGh(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', comments: publishedComments(state, { hash: s.hash, head: s.head, base: s.baseTip, marker: over.marker ?? marker }) }));
  };
  s.set(build(s.hash));
  const env = { ...s.env, ...floorEnv() };
  s.go = () => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env });
  s.dry = (goFlag = true) => cli(['merge', '--pr', String(PR), '--dry-run', ...(goFlag ? ['--owner-go'] : [])], { dir: s.repo.dir, fake: s.fake, env });
  s.cliEnv = env;
  return s;
}
const entriesFor = (text) => [{ type: 'user', message: { content: 'ship it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY }, { type: 'assistant', message: { content: [{ type: 'text', text }] } }];
const say = (t, step, { dropAreas = false } = {}) => {
  const text = ['Here is the request.', step.rulings, dropAreas ? '' : step.areas, step.hold, step.line, step.ready ?? `🔀 Ready to merge #${PR} — say "merge"`].filter(Boolean).join('\n');
  const h = runHook(t, { entries: entriesFor(text), prompt: 'merge' });
  assert.equal(h.status, 0);
  return h.record;
};

test('END TO END (substitute-only PR, no dismissed findings): the dry run prints the substitute Areas line, the hook records it, --owner-go merges; without the Areas line it is refused', (t) => {
  const s = world();
  const d = s.dry();
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  const step = d.json.ownerStep;
  assert.equal(step.kind, 'say-merge');
  assert.deepEqual(step.areaIds, ['substitute']);
  assert.match(step.areas, /^Areas substitute$/);
  assert.equal(step.rulings, undefined, 'no Rulings row: the hook binds only R<n>-<x><n> rows');
  assert.equal(step.substitute[0].agent, 'substitute-opus');
  assert.match(step.line, new RegExp(`^Head ${s.head.slice(0, 12)} · items [0-9a-f]{12}`));
  // a "merge" recorded for the request WITHOUT the Areas line does not cover the PR
  say(t, step, { dropAreas: true });
  const refused = s.go();
  assertExit(refused, 1);
  assert.equal(refused.json.error, 'owner-go');
  assert.deepEqual(s.mergeCalls(), []);
  // the full request (Areas line included) does
  say(t, step);
  const ok = s.go();
  assertExit(ok, 0, `${ok.stderr}${ok.stdout}`);
  assert.equal(ok.json.merged, true);
});

test('an old "merge" never covers one more substitute round or substitute second review at the same head (the items digest changes)', (t) => {
  const s = world();
  const step = s.dry().json.ownerStep;
  say(t, step);
  // one more substitute round, republished so the marker and the PR agree: the live scan now has another digest
  s.set(stateOf(s.hash, [[1, subRound()], [2, subRound()]]));
  const r = s.go();
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-go');
  assert.deepEqual(s.mergeCalls(), []);
  assert.notEqual(s.dry().json.ownerStep.line, step.line);
});

test('approvalGap binds the Areas line: a record whose areas lack `substitute` never covers the PR', (t) => {
  const s = world();
  const step = s.dry().json.ownerStep;
  say(t, step, { dropAreas: true });
  const asked = { repo: 'acme/widgets', pr: PR, head: s.head, items: step.line.match(/items ([0-9a-f]{12})/)[1], hold: undefined, rulings: 'none' };
  assert.notEqual(approvalGap({ ...asked, areas: ['substitute'] }), 'ok');
});

test('the gated route refuses a PR with a substitute review (substitute-owner-go-only) whatever approval flags are passed, and so does the low-risk path; the dry run says so', () => {
  const s = world({ withReport: true });
  const g = s.gate();
  assertExit(g, 0, `${g.stderr}${g.stdout}`);
  const gate = s.gateFile();
  assert.equal(gate.ownerMerge, 1, 'the review check carries the item');
  const flags = ['--owner-approved-head', s.head, '--owner-approved-items', gate.ownerItems];
  const r = cli(['merge', '--pr', String(PR), ...flags], { dir: s.repo.dir, fake: s.fake, env: s.cliEnv });
  assertExit(r, 1);
  assert.equal(r.json.error, 'substitute-owner-go-only');
  assert.match(r.json.reasons[0], /--dry-run --owner-go/);
  const plain = s.merge();
  assert.equal(plain.json.error, 'substitute-owner-go-only', 'no approval at all (the low-risk path) is refused the same way');
  assert.deepEqual(s.mergeCalls(), []);
  const dry = s.dry(false);
  assert.ok(dry.json.blockers.some((b) => b.kind === 'substitute-owner-go-only'), JSON.stringify(dry.json.blockers));
  assert.equal(dry.json.ownerStep, null);
});

test('label mode: `P merge` refuses substitute-label-mode on the gated and the owner-go route, and the dry runs report it', () => {
  const s = world({ yml: goYml('label') });
  s.gate();
  const gated = cli(['merge', '--pr', String(PR), '--owner-approved-head', s.head, '--owner-approved-items', 'abcdef012345'], { dir: s.repo.dir, fake: s.fake, env: s.cliEnv });
  assert.equal(gated.json.error, 'substitute-label-mode', gated.stdout);
  assert.match(gated.json.reasons[0], /by hand/);
  const go = s.go();
  assert.equal(go.json.error, 'substitute-label-mode', go.stdout);
  for (const flag of [true, false]) assert.ok(s.dry(flag).json.blockers.some((b) => b.kind === 'substitute-label-mode'));
  assert.deepEqual(s.mergeCalls(), []);
});

test('queue rechecks (gated and owner-go) see the item: substitute-owner-go-only / substitute-label-mode, and an ordinary PR is unaffected', async () => {
  const w = world();
  const { config } = await loadConfig(w.repo.dir);
  const base = { root: w.repo.dir, pr: PR, gh: null, env: {}, head: w.head, repo: 'acme/widgets', hold: null };
  const gated = await recheckGated({ root: w.repo.dir, config, pr: PR, gh: null, env: {}, gate: {}, ownerApproved: true, ownerMergeReason: 'x' });
  assert.deepEqual([gated.ok, gated.error], [false, 'substitute-owner-go-only']);
  const labelCfg = { ...config, owner_approval: 'label' };
  assert.equal((await recheckOwnerGo({ ...base, config: labelCfg })).error, 'substitute-label-mode');
  assert.equal((await recheckGated({ root: w.repo.dir, config: labelCfg, pr: PR, gh: null, env: {}, gate: {}, ownerApproved: true, ownerMergeReason: 'x' })).error, 'substitute-label-mode');
  assert.equal(substituteRouteProblem({ root: w.repo.dir, config, pr: PR, route: 'owner-go' }), null, 'owner-go in chat mode is the route');
  const ordinary = world({ build: (h) => stateOf(h, [[1, { codexModel: 'gpt-x', risk: 'low' }]]) });
  assert.equal(substituteRouteProblem({ root: ordinary.repo.dir, config, pr: PR, route: 'gated' }), null);
});

// ---- the review-complete check (owner-go scan) ----------------------------------------------------------------------------------------------------

const gh = (comments) => ({ viewer: () => 'me', listComments: () => comments });
async function completion(s, comments) {
  const { config } = await loadConfig(s.repo.dir);
  return reviewCompletionCheck({ root: s.repo.dir, config, pr: PR, gh: gh(comments), sleep: async () => {}, env: floorEnv(), hash: s.hash });
}

test('review-complete check: the marker must carry the live substituteDigest (an older marker after a second review at the same head is refused, also for a queued merge), escalation and unproven rounds are refused', async () => {
  const s = world();
  const ok = await completion(s, publishedComments(s.state, { hash: s.hash, head: s.head, base: s.baseTip }));
  assert.equal(ok.ok, true, ok.detail);
  assert.equal(ok.substitute.line, substituteItemLine(s.state));
  // a marker written before the substitute round (no digest) over a state that now holds one
  const old = await completion(s, publishedComments(s.state, { hash: s.hash, head: s.head, base: s.baseTip, marker: { substituteDigest: 'none', substitute: null } }));
  assert.equal(old.ok, false);
  assert.match(old.detail, /does not carry the current substitute reviews/);
  // a substitute second review added at the same head (state republished, marker still the old one)
  const item = { id: 'R1-B1', bucket: 'BLOCKING', category: 'bug', title: 't', fingerprint: 'fp', secondReview: { by: 'substitute-opus', decision: 'ACCEPT', evidence: 'quota', models: ['claude-opus-4-8'] }, judge: { decision: 'ACCEPT' }, final: { decision: 'ACCEPT', by: 'judge', needsHuman: false }, implemented: true };
  const later = stateOf(s.hash, [[1, subRound('substitute-opus', 'low', { items: [item] })]]);
  const stale = await completion(s, publishedComments(later, { hash: s.hash, head: s.head, base: s.baseTip, marker: { substituteDigest: substituteDigest(s.state), stateHash: undefined } }));
  assert.equal(stale.ok, false);
  const wrong = world({ build: (h) => stateOf(h, [[1, subRound('substitute-opus', 'high')], [2, subRound('substitute-fable', 'high', { wholePr: true })]], { risk: 'high' }) });
  const bad = await completion(wrong, publishedComments(wrong.state, { hash: wrong.hash, head: wrong.head, base: wrong.baseTip }));
  assert.match(bad.detail, /^substitute-unproven:/);
});
