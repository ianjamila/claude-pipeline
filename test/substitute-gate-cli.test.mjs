// The substitute gate through the real commands (plan 2026-11-11-codex-substitute-reviewer R4-1, R5-1, R5-6, R5-10): `P review-complete` refuses an escalation / an unproven
// substitute round and posts the marker for a valid one; a substitute second review added after an owner "merge" stops a merge (also on a queue base); the low-risk path
// refuses a substitute PR in both approval modes. The unit half (inventory, marker fields, the library checks) is test/substitute-gate.test.mjs, which also drives
// the gated / owner-go / label-mode `P merge` routes and the Areas binding through the CLI; this file adds what it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OWNER_ENTRY, runHook } from './helpers/owner-go.mjs';
import { PR, bump, cli, ghEntries, scenario, ymlFor } from './helpers/gate-env.mjs';
import { createFakeGh } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { publishedComments } from './helpers/rulings-world.mjs';
import { floorEnv } from './helpers/floor-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { parseReviewRecord } from '../pipeline/lib/review-marker.mjs';
import { substituteDigest, substituteSummary } from '../pipeline/lib/triage.mjs';

const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
const goYml = (mode = 'chat') => `${ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}')}owner_approval: ${mode}\n`;
const MODELS = { 'substitute-opus': 'claude-opus-4-8', 'substitute-fable': 'claude-fable-5-2' };
const sub = (agent = 'substitute-opus', over = {}) => ({
  agent, models: { [MODELS[agent]]: 3 }, evidence: 'quota', resetAt: null, outageAt: '2026-11-11T07:23:00.000Z', attempts: 1,
  proof: { transcript: '/t/x.jsonl', models: { [MODELS[agent]]: 3 }, effort: 'high' }, ...over,
});
const round = (n, hash, over = {}) => ({ n, fromHead: 'a', toHead: 'b', contentHashAtToHead: hash, items: [], ...over });
function stateOf(hash, rounds, { risk = 'low' } = {}) {
  let s = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk, maxRounds: 2 });
  s.currentContentHash = hash;
  for (const [n, over] of rounds) {
    s = addRound(s, round(n, hash, over));
    // addRound keeps a fixed set of fields; the Fable pass's outcome is written onto the round afterwards (arbiter apply / substitute apply do the same)
    const last = s.rounds.at(-1);
    for (const k of ['arbiter', 'modelProof']) if (over[k] !== undefined) last[k] = structuredClone(over[k]);
  }
  return s;
}
const subRound = (agent = 'substitute-opus', risk = 'low', over = {}) => ({ firstReviewer: 'substitute', substitute: sub(agent), risk, ...over });
const FABLE = { fableRequired: true, fableReasons: ['test'], modelProof: { transcript: '/t/f.jsonl', models: { 'claude-fable-5-2': 2 }, effort: 'high' } };
const proven = (over = {}) => ({ ...FABLE, arbiter: { proofOk: true, scope: 'whole-pr' }, ...over });
const secondReview = () => ({ id: 'R1-B1', bucket: 'BLOCKING', category: 'bug', title: 't', fingerprint: 'fp', secondReview: { by: 'substitute-opus', decision: 'REJECT', evidence: 'quota', models: ['claude-opus-4-8'] }, judge: { decision: 'REJECT' }, final: { decision: 'REJECT', by: 'judge', needsHuman: false } });

// ---- P review-complete ------------------------------------------------------------------------------------------------------------------

// A ready PR (awaiting-review label on it) whose review state is `build(hash)`; the fake gh answers what review-complete reads and writes.
function completeWorld(build) {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique });
  saveState(s.repo.dir, build(s.hash));
  const view = { headRefOid: s.head, isDraft: false, labels: [{ name: 'awaiting-review' }], body: 'Adds a thing', mergeable: 'MERGEABLE' };
  const extra = [
    { match: '^pr view 12 --json headRefOid,isDraft', stdoutJson: view },
    { match: '^pr view 12 --json labels', stdoutJson: { labels: [] } },
    { match: '^pr edit 12 --remove-label', code: 0 },
  ];
  s.fake = createFakeGh(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, extra }));
  s.complete = () => cli(['review-complete', '--pr', String(PR)], { dir: s.repo.dir, fake: s.fake, env: floorEnv() });
  s.markers = () => s.fake.calls().filter((c) => c.argv.join(' ').includes(`-X POST repos/acme/widgets/issues/${PR}/comments`)).map((c) => JSON.parse(c.stdin).body).filter((b) => b.includes('Cross-model review complete'));
  return s;
}

test('review-complete: a PR that became high-risk after Opus substitute cover (the Fable-lane round after it is incremental) is refused substitute-escalation; nothing is posted', () => {
  const s = completeWorld((h) => stateOf(h, [[1, subRound('substitute-opus', 'medium')], [2, { codexModel: 'gpt-x', risk: 'high', ...proven({ arbiter: { proofOk: true } }) }]], { risk: 'high' }));
  const r = s.complete();
  assertExit(r, 1, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'substitute-escalation');
  assert.match(r.json.reason, /no whole-PR round/);
  assert.deepEqual(s.markers(), []);
  assert.equal(s.fake.lines().filter((l) => l.startsWith('pr edit ')).length, 0, 'the awaiting-review label stays');
});

test('review-complete: an unproven substitute round (no transcript / a transcript of another model family) is refused substitute-unproven; nothing is posted', () => {
  const noTranscript = completeWorld((h) => stateOf(h, [[1, { ...subRound(), substitute: sub('substitute-opus', { proof: { transcript: '', models: { 'claude-opus-4-8': 1 }, effort: 'high' } }) }]]));
  const a = noTranscript.complete();
  assertExit(a, 1, `${a.stderr}${a.stdout}`);
  assert.equal(a.json.error, 'substitute-unproven');
  assert.match(a.json.reason, /no proof transcript/);
  assert.deepEqual(noTranscript.markers(), []);
  const wrongFamily = completeWorld((h) => stateOf(h, [[1, { ...subRound(), substitute: sub('substitute-opus', { proof: { transcript: '/t/x.jsonl', models: { 'claude-sonnet-4-5': 1 }, effort: 'high' } }) }]]));
  const b = wrongFamily.complete();
  assertExit(b, 1, `${b.stderr}${b.stdout}`);
  assert.equal(b.json.error, 'substitute-unproven');
  assert.match(b.json.reason, /not a Opus/);
  assert.deepEqual(wrongFamily.markers(), []);
  // a Fable round whose transcript shows an Opus model is the same refusal
  const opusForFable = completeWorld((h) => stateOf(h, [[1, { ...subRound('substitute-fable', 'high'), ...proven(), substitute: sub('substitute-fable', { proof: { transcript: '/t/x.jsonl', models: { 'claude-opus-4-8': 2 }, effort: 'high' } }) }]], { risk: 'high' }));
  const c = opusForFable.complete();
  assertExit(c, 1, `${c.stderr}${c.stdout}`);
  assert.equal(c.json.error, 'substitute-unproven');
  assert.match(c.json.reason, /not a Fable/);
});

test('review-complete: a valid substitute-only review posts a marker carrying substitute + substituteDigest and codexModel none-substitute:<model>', () => {
  const s = completeWorld((h) => stateOf(h, [[1, subRound()]]));
  const r = s.complete();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.review.codexModel, 'none-substitute:claude-opus-4-8');
  assert.deepEqual(r.json.review.substitute, { rounds: [1], agents: ['substitute-opus'], models: ['claude-opus-4-8'] });
  const [body, ...more] = s.markers();
  assert.equal(more.length, 0, 'exactly one marker comment');
  const record = parseReviewRecord(body);
  assert.ok(record, 'the marker parser reads the body');
  assert.equal(record.codexModel, 'none-substitute:claude-opus-4-8');
  assert.deepEqual(record.substitute, r.json.review.substitute);
  assert.match(record.substituteDigest, /^[0-9a-f]{64}$/);
  assert.equal(record.substituteDigest, substituteDigest(stateOf(s.hash, [[1, subRound()]])));
  assert.match(body, /substitute review of round\(s\) 1 by substitute-opus/);
});

test('review-complete: a high-risk PR with a whole-PR Fable substitute round posts (the escalation is cleared)', () => {
  const s = completeWorld((h) => stateOf(h, [[1, subRound('substitute-opus', 'medium')], [2, subRound('substitute-fable', 'high', proven({ wholePr: true }))]], { risk: 'high' }));
  const r = s.complete();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.deepEqual(r.json.review.substitute.agents, ['substitute-fable', 'substitute-opus']);
  assert.equal(s.markers().length, 1);
});

// ---- a substitute second review after the owner's "merge" ---------------------------------------------------------------------------------

const NO_EVENTS = { match: 'QueueEvents', stdoutJson: { data: { repository: { pullRequest: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } } };
function world({ build = (h) => stateOf(h, [[1, subRound()]]), yml = goYml(), queue = false, withReport = false } = {}) {
  const s = scenario({ yml, report: withReport ? undefined : null, state: null, change: unique });
  s.set = (state, marker = {}) => {
    s.state = state;
    saveState(s.repo.dir, state);
    s.fake = createFakeGh(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', queue, extra: queue ? [NO_EVENTS] : [], comments: publishedComments(state, { hash: s.hash, head: s.head, base: s.baseTip, marker }) }));
  };
  s.set(build(s.hash));
  const env = { ...s.env, ...floorEnv() };
  s.go = () => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env });
  s.dry = (goFlag = true) => cli(['merge', '--pr', String(PR), '--dry-run', ...(goFlag ? ['--owner-go'] : [])], { dir: s.repo.dir, fake: s.fake, env });
  s.cliEnv = env;
  return s;
}
const entriesFor = (text) => [{ type: 'user', message: { content: 'ship it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY }, { type: 'assistant', message: { content: [{ type: 'text', text }] } }];
const say = (t, step) => {
  const text = ['Here is the request.', step.areas, step.hold, step.line, `🔀 Ready to merge #${PR} — say "merge"`].filter(Boolean).join('\n');
  const h = runHook(t, { entries: entriesFor(text), prompt: 'merge' });
  assert.equal(h.status, 0);
  return h.record;
};

for (const queue of [false, true]) {
  test(`${queue ? 'queued' : 'direct'} P merge --owner-go: a substitute second review added after the owner's "merge" (state republished, marker still the old one) is refused, nothing merges or is enqueued`, (t) => {
    const s = world({ queue });
    const old = { substituteDigest: substituteDigest(s.state), substitute: substituteSummary(s.state) };
    // the owner approves the PR as it is after the second review (so the approval itself is current) ...
    const later = stateOf(s.hash, [[1, subRound('substitute-opus', 'low', { items: [secondReview()] })]]);
    s.set(later);
    const step = s.dry().json.ownerStep;
    assert.equal(step.kind, 'say-merge');
    say(t, step);
    // ... but the marker on the PR was issued before it: it does not carry the live substitute reviews
    s.set(later, old);
    const r = s.go();
    assertExit(r, 1, `${r.stderr}${r.stdout}`);
    assert.equal(r.json.merged, false);
    assert.equal(r.json.error, 'live-check', r.stdout);
    assert.match(r.json.reasons[0], /does not carry the current substitute reviews/);
    assert.deepEqual(s.mergeCalls(), []);
    assert.equal(s.fake.lines().filter((l) => /mutation Enqueue/.test(l)).length, 0, 'nothing was enqueued');
    // republishing the marker for the live state makes the same approval work
    s.set(later);
    const ok = s.dry();
    assert.equal(ok.json.ownerStep?.kind, 'say-merge', ok.stdout);
    assert.equal(ok.json.blockers?.length ?? 0, 0, ok.stdout);
  });
}

// ---- the low-risk path, both approval modes -----------------------------------------------------------------------------------------------

for (const mode of ['chat', 'label']) {
  test(`${mode} mode: plain \`P merge\` (the low-risk auto-merge path, no owner approval) refuses a PR with a substitute review, merges nothing`, () => {
    const s = world({ yml: goYml(mode), withReport: true });
    assertExit(s.gate(), 0);
    assert.equal(s.gateFile().ownerMerge, 1);
    const r = s.merge();
    assertExit(r, 1, `${r.stderr}${r.stdout}`);
    assert.equal(r.json.error, mode === 'chat' ? 'substitute-owner-go-only' : 'substitute-label-mode', r.stdout);
    assert.deepEqual(s.mergeCalls(), []);
    const dry = s.dry(false);
    assert.ok(dry.json.blockers.some((b) => b.kind === (mode === 'chat' ? 'substitute-owner-go-only' : 'substitute-label-mode')), JSON.stringify(dry.json.blockers));
  });
}
