// The Rulings block in the owner's merge request (plan 2026-11-05-claude-rulings E5, E11, section 10.3): the hook binds it, `P merge --owner-go` compares it with the live state,
// the review-complete check keeps a PR whose review is not finished (or whose published state differs) from merging, and nothing merges under a decision that can still change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalGap, holdBlock, presentedRequests, rulingsBlockDigest } from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, mergeRequest, ownerSays, runHook } from './helpers/owner-go.mjs';
import { LOCK_DIR, PR, bump, cli, ghEntries, scenario, ymlFor } from './helpers/gate-env.mjs';
import { createFakeCodex, createFakeGh } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { arbiterItem, claudeItem, comment, markerBody, publishedComments, rulingState } from './helpers/rulings-world.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { evaluateOwnerGo, localContentHash, reviewCheck, reviewCompletionCheck } from '../pipeline/lib/finalgate.mjs';
import { rulingsBlock } from '../pipeline/lib/triage.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { MARKERS, triageComment } from '../pipeline/lib/render.mjs';
import { withReviewLock } from '../pipeline/lib/review-context.mjs';
import { reviewContentHash } from '../pipeline/lib/review-publish.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const REPO = 'acme/app';
const H = 'Rulings 0123456789ab';
const ROW1 = 'R1-B1 · REJECT · BLOCKING · security · by claude+codex · content 0123456789ab · "Missing check" · why: a false positive';
const ROW2 = 'R1-B2 · FOLLOW-UP · BLOCKING · bug · by arbiter · content 1123456789ab · "Unchecked input" · why: unreachable';
const HEADLINE = `Head ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}`;
const READY = '🔀 Ready to merge #58 — say "merge"';
const reply = (...lines) => `Here is the request.\n${[...lines, HEADLINE, READY].join('\n')}`;
const only = (text) => {
  const r = presentedRequests(text);
  assert.equal(r.requests.length, 1, JSON.stringify(r));
  return r.requests[0];
};
const BLOCK = [H, ROW1, ROW2].join('\n');

// ---- the hook: what binds ---------------------------------------------------------------------------------------------------------------

test('hook: a request ending with the block binds exactly the block (its normalized digest) and nothing else changes', () => {
  const q = only(reply(H, ROW1, ROW2));
  assert.equal(q.rulings, rulingsBlockDigest(BLOCK));
  assert.match(q.rulings, /^[0-9a-f]{64}$/);
  const { rulings, ...rest } = q;
  assert.deepEqual(rest, { pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO });
  // white space is normalized, a changed row is a changed digest
  assert.equal(only(reply(`  ${H}  `, ROW1.replace(' · ', '  ·  '), ROW2)).rulings, q.rulings);
  assert.notEqual(only(reply(H, ROW1.replace('false positive', 'true positive'), ROW2)).rulings, q.rulings);
  assert.notEqual(only(reply(H, ROW1)).rulings, q.rulings);
});

test('hook: Rulings above Areas above Hold above Head all bind together; blank lines anywhere in the block are transparent', () => {
  const hold = { id: 'LE_x1', login: 'jamila', at: '2026-11-05T09:00:00Z' };
  const text = ['Intro.', H, '', ROW1, ROW2, '', 'Areas hard-stop', '', holdBlock(hold), `Head ${HEAD.slice(0, 12)} · items ${ITEMS} · hold ${hold.id} · repo ${REPO}`, '', '🔀 Ready to merge #58 and lift its needs-human hold — say "merge"'].join('\n');
  const q = only(text);
  assert.equal(q.rulings, rulingsBlockDigest(BLOCK));
  assert.equal(q.hold, hold.id);
  assert.equal(typeof q.areas, 'string');
});

test('hook: a reply with no block produces the record it always did (no rulings field)', () => {
  assert.deepEqual(presentedRequests(`Two items.\n${HEADLINE}\n${READY}`), { prs: [58], requests: [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }] });
});

test('hook: misplaced, non-contiguous, header-less, duplicate-header and header-only blocks bind no rulings', () => {
  const unbound = (text, why) => {
    const r = presentedRequests(text);
    assert.ok(r.requests.every((q) => q.rulings === undefined), `${why}: ${JSON.stringify(r)}`);
  };
  unbound(reply(ROW1, ROW2), 'rows with no header');
  unbound(reply(H), 'a header with no rows');
  unbound(reply(H, 'And some prose.', ROW1), 'prose between header and rows');
  unbound(reply(H, ROW1, 'Prose in the middle.', ROW2), 'rows split by prose');
  unbound(reply(H, ROW1, H, ROW2), 'a duplicate header');
  unbound(reply(H, ROW1, ROW2, H, ROW2), 'a second block stacked on the first');
  unbound(reply('Rulings 0123456789ab and more words', ROW1), 'a prose look-alike of the header');
  unbound(reply(`${H} extra`, ROW1), 'a header with trailing words');
  unbound(reply('Rulings: what I think', 'R1-B1 is fine'), 'prose that starts like the block');
  // a block BELOW the Areas line (wrong order) binds nothing, and the reply fails closed as a malformed Areas block
  assert.deepEqual(presentedRequests(`Areas hard-stop\n${H}\n${ROW1}\n${HEADLINE}\n${READY}`).requests, []);
  // a row redrawn by a lone carriage return is not a row
  unbound(`${H}\n${ROW1}\rredrawn\n${HEADLINE}\n${READY}`, 'a redrawn line');
  // the request itself still binds when the block is dropped
  assert.equal(only(reply(ROW1, ROW2)).rulings, undefined);
});

test('hook: a block with several PRs on the 🔀 line binds nothing for the whole reply', () => {
  const text = `${BLOCK}\n#58 ${HEADLINE}\n#59 Head ${'a'.repeat(12)} · items ${ITEMS} · repo ${REPO}\n🔀 Ready to merge #58, #59 — say "merge"`;
  assert.deepEqual(presentedRequests(text).requests, []);
  // the same reply without a block still binds both, as before
  assert.equal(presentedRequests(text.replace(BLOCK, 'Notes.')).requests.length, 2);
});

test('hook: the record keeps `rulings` through the real hook entry point, and a reply without a block records none', (t) => {
  const entries = (text) => [{ type: 'user', message: { content: 'ship it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY }, { type: 'assistant', message: { content: [{ type: 'text', text }] } }];
  const withBlock = runHook(t, { entries: entries(reply(H, ROW1, ROW2)), prompt: 'merge' });
  assert.equal(withBlock.status, 0);
  assert.equal(withBlock.record.requests[0].rulings, rulingsBlockDigest(BLOCK));
  const plain = runHook(t, { entries: entries(`Two items.\n${HEADLINE}\n${READY}`), prompt: 'merge' });
  assert.deepEqual(plain.record.requests, [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }]);
});

test('approvalGap: a record with a block never covers a PR whose live block differs, an absent field reads as none, null compares nothing', (t) => {
  const q = { repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], hold: undefined };
  ownerSays(t, 'merge', reply(H, ROW1, ROW2));
  assert.equal(approvalGap({ ...q, rulings: rulingsBlockDigest(BLOCK) }), 'ok');
  assert.equal(approvalGap({ ...q, rulings: 'none' }), 'none', 'a record with a block never approves a PR without one');
  assert.equal(approvalGap({ ...q, rulings: rulingsBlockDigest(`${BLOCK}\nR1-B3 · REJECT · x`) }), 'none');
  assert.equal(approvalGap({ ...q }), 'none', 'a caller that forgot the field compares as none');
  assert.equal(approvalGap({ ...q, rulings: null }), 'ok', 'the gated route binds no block');
});

test('approvalGap: a record with no rulings field approves a PR without rulings and refuses one with them', (t) => {
  const q = { repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], hold: undefined };
  ownerSays(t, 'merge', `Two items.\n${HEADLINE}\n${READY}`);
  assert.equal(approvalGap({ ...q, rulings: 'none' }), 'ok');
  assert.equal(approvalGap({ ...q, rulings: rulingsBlockDigest(BLOCK) }), 'none');
  assert.equal(approvalGap({ ...q, rulings: null }), 'ok');
});

// ---- the world: a PR whose review ended, run through the real CLI ---------------------------------------------------------------------

const goYml = () => `${ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}')}owner_approval: chat\n`;
const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
function world({ items = [claudeItem()], yml = goYml(), baseFiles = {} } = {}) {
  const s = scenario({ yml, report: null, state: null, change: unique, baseFiles });
  // (re)writes the local state and what the PR holds, consistently: the triage comment with it and the marker for it
  s.set = (next, { marker = {}, state = rulingState({ hash: s.hash, items: next }) } = {}) => {
    s.items = next;
    s.state = state;
    saveState(s.repo.dir, state);
    s.fake = createFakeGh(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', comments: publishedComments(state, { hash: s.hash, head: s.head, base: s.baseTip, marker }) }));
  };
  s.set(items);
  s.go = (env = {}) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
  s.dry = () => cli(['merge', '--pr', String(PR), '--dry-run', '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  s.writes = () => s.fake.lines().filter((l) => /-X (POST|DELETE|PUT|PATCH)|^pr edit|--disable-auto/.test(l));
  return s;
}
const entriesFor = (text) => [{ type: 'user', message: { content: 'ship it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY }, { type: 'assistant', message: { content: [{ type: 'text', text }] } }];
// The reply the owner answers, exactly as the dry run prints it (nothing retyped), through the REAL hook.
const approveViaHook = (t, s) => {
  const d = s.dry();
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  const step = d.json.ownerStep;
  const text = ['Here is the request.', step.rulings, step.areas, step.hold, step.line, step.ready ?? `🔀 Ready to merge #${PR} — say "merge"`].filter(Boolean).join('\n');
  const h = runHook(t, { entries: entriesFor(text), prompt: 'merge' });
  assert.equal(h.status, 0);
  return { step, record: h.record };
};
const refusedGo = (r, s, pattern, error = 'owner-go') => {
  assertExit(r, 1);
  assert.equal(r.json.error, error, r.stdout);
  assert.match(JSON.stringify(r.json), pattern);
  assert.deepEqual(s.mergeCalls(), [], 'no merge command may run');
};

test('END TO END: the dry run prints the block, the real hook records it, `P merge --owner-go` merges; an ordinary PR prints no block', (t) => {
  const s = world({ items: [claudeItem(), arbiterItem()] });
  const { step, record } = approveViaHook(t, s);
  assert.equal(step.kind, 'say-merge');
  assert.equal(step.rulingCount, 2);
  assert.match(step.rulings, /^Rulings [0-9a-f]{12}\nR1-B1 · REJECT · BLOCKING · security · by claude · content [0-9a-f]{12} · "Missing check" · why: .+\nR1-B2 · REJECT · BLOCKING · security · by arbiter · /);
  assert.equal(record.requests[0].rulings, rulingsBlockDigest(step.rulings), 'the hook bound the block the dry run printed');
  const r = s.go();
  assertExit(r, 0, `${r.stderr}${r.stdout}`);
  assert.equal(r.json.merged, true);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
  // no dismissals: no block in the output, and a record with no block merges
  const plain = world({ items: [] });
  const d = plain.dry();
  assert.equal('rulings' in d.json.ownerStep, false);
  assert.equal('rulingCount' in d.json.ownerStep, false);
  ownerSays(t, 'merge', mergeRequest(PR, plain.head, 'none'));
  assertExit(plain.go(), 0);
});

test('a ruling added, removed or changed, a why or title edited, or finding text changed after the owner said "merge" is refused', (t) => {
  const cases = {
    added: (items) => [...items, arbiterItem({ id: 'R1-B3', fingerprint: 'fp-3' })],
    removed: (items) => items.slice(0, 1),
    'decision changed': (items) => [items[0], arbiterItem({ final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'the arbiter found it unreachable' }, followupIssue: 5 })],
    'why edited': (items) => [items[0], arbiterItem({ final: { decision: 'REJECT', by: 'arbiter', needsHuman: false, reason: 'another reason entirely' } })],
    'title edited': (items) => [items[0], arbiterItem({ title: 'A different title' })],
    'finding text changed': (items) => [items[0], arbiterItem({ detail: 'the finding now says something else' })],
    'who decided changed': (items) => [items[0], arbiterItem({ final: { decision: 'REJECT', by: 'test', needsHuman: false, reason: 'the arbiter found it unreachable' } })],
  };
  for (const [name, change] of Object.entries(cases)) {
    const s = world({ items: [claudeItem(), arbiterItem()] });
    approveViaHook(t, s);
    s.set(change(s.items)); // same head; state and published copy kept consistent: only the rulings moved
    refusedGo(s.go(), s, /ulings/, 'owner-go');
    assert.deepEqual(s.writes(), [], name);
  }
});

test('a record with no rulings field refuses a PR with rulings and approves one without', (t) => {
  const s = world({ items: [claudeItem()] });
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none')); // the shape before this change: no block
  const r = s.go();
  refusedGo(r, s, /Rulings [0-9a-f]{12}/);
  assert.match(r.json.reason, /R1-B1 · REJECT · BLOCKING/, 'the refusal prints the block to show');
  s.set([]);
  assertExit(s.go(), 0);
});

// ---- the review-complete check (E5) -----------------------------------------------------------------------------------------------------

const gh = (comments) => ({ viewer: () => 'me', listComments: () => comments });
async function checkWorld({ items = [], marker = {}, local = 'state', state, yml = goYml(), later = null } = {}) {
  const s = scenario({ yml, report: null, state: null, change: unique });
  const { config } = await loadConfig(s.repo.dir);
  const st = state ?? rulingState({ hash: s.hash, items, rounds: later ? later(s.hash) : [] });
  if (local === 'state') saveState(s.repo.dir, st);
  s.config = config;
  s.st = st;
  s.published = (over = {}) => publishedComments(over.state ?? st, { hash: s.hash, head: s.head, base: s.baseTip, marker, ...over });
  s.check = (g = gh(s.published()), extra = {}) => reviewCompletionCheck({ root: s.repo.dir, config, pr: PR, gh: g, sleep: async () => {}, env: {}, ...extra });
  return s;
}
const refusal = (r, pattern) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.name, 'review-complete');
  assert.match(r.detail, pattern);
  return r;
};

test('review-complete: no history and no local state (or the state of another PR) passes with no rulings; local state with no history refuses', async () => {
  const none = await checkWorld({ local: 'none' });
  const r = await none.check(gh([]));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.rulings, { block: '', digest: 'none', blockDigest: 'none', count: 0 });
  const other = await checkWorld({ state: rulingState({ hash: 'a'.repeat(64), pr: 99 }) });
  assert.equal((await other.check(gh([]))).ok, true);
  const orphan = await checkWorld();
  refusal(await orphan.check(gh([])), /review-complete --pr 12/);
  // someone else's triage comment is no history of ours
  const theirs = await checkWorld({ local: 'none' });
  assert.equal((await theirs.check(gh([comment(1, triageComment(rulingState({ hash: 'a'.repeat(64) })), { login: 'stranger' })]))).ok, true);
});

test('review-complete: history but no local state (a fresh worktree), an undecodable triage comment, an edited or malformed marker all refuse with their remedy', async () => {
  const fresh = await checkWorld({ local: 'none' });
  refusal(await fresh.check(), /state show --pr 12/);
  const w = await checkWorld();
  refusal(await w.check(gh([comment(1, `${MARKERS.triage}\nnot a state`)])), /no readable review state/);
  const published = w.published();
  refusal(await w.check(gh([published[0], { ...published[1], updated_at: '2026-11-05T12:00:00Z' }])), /edited/);
  refusal(await w.check(gh([published[0], comment(2, '<!-- claude-pipeline:review-complete v1 -->\nno record', { at: '2026-11-05T10:05:00Z' })])), /valid review record/);
  refusal(await w.check(gh([published[0]])), /review-complete --pr 12/);
});

test('review-complete: a complete review passes (block fields returned); a main-only update (head moved, hash same) passes; a marker for other content refuses; a baseOnly round after a clean one passes', async () => {
  const w = await checkWorld({ items: [claudeItem()] });
  const ok = await w.check();
  assert.equal(ok.ok, true, ok.detail);
  assert.equal(ok.rulings.count, 1);
  assert.equal(ok.rulings.blockDigest, rulingsBlockDigest(rulingsBlock(w.st)));
  assert.equal((await w.check(gh(w.published({ marker: { head: 'e'.repeat(40) } })))).ok, true, 'marker.head is not compared');
  refusal(await w.check(gh(w.published({ hash: 'b'.repeat(64) }))), /other content/);
  const based = await checkWorld({ later: (hash) => [{ n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: hash, items: [], baseOnly: true }] });
  assert.equal(based.st.rounds.length, 2);
  const r = await based.check();
  assert.equal(r.ok, true, r.detail);
});

test('review-complete: a legacy marker (no rulingsDigest) passes with no rulings and is refused with an arbiter dismissal until review-complete writes the digest', async () => {
  const none = await checkWorld({ items: [] });
  assert.equal((await none.check()).ok, true);
  const arb = await checkWorld({ items: [arbiterItem()] });
  const legacy = arb.published();
  legacy[1] = comment(2, markerBody({ contentHash: arb.hash, head: arb.head, base: arb.baseTip, digest: 'none', stateHash: reviewContentHash(arb.st) }), { at: '2026-11-05T10:05:00Z' });
  refusal(await arb.check(gh(legacy)), /rulings.*review-complete --pr 12/);
  assert.equal((await arb.check(gh(arb.published()))).ok, true, 'cured by the marker review-complete writes');
});

test('review-complete: the local state must equal the published one (a late local change refuses), with one bounded re-read for list lag', async () => {
  const w = await checkWorld({ items: [claudeItem()] });
  const later = rulingState({ hash: w.hash, items: [claudeItem({ final: { ...claudeItem().final, reason: 'edited later' } })] });
  refusal(await w.check(gh(w.published({ state: later }))), /differs from the one published.*review-complete --pr 12/);
  const full = w.published();
  let calls = 0;
  let slept = 0;
  const lagging = { viewer: () => 'me', listComments: () => { calls += 1; return calls === 1 ? [full[0]] : full; } };
  const r = await w.check(lagging, { sleep: async () => { slept += 1; } });
  assert.equal(r.ok, true, r.detail);
  assert.equal(slept, 1);
  assert.equal(calls, 2, 'exactly one re-read');
  let always = 0;
  refusal(await w.check({ viewer: () => 'me', listComments: () => { always += 1; return [full[0]]; } }), /review-complete --pr 12/);
  assert.equal(always, 2, 'never more than one re-read');
});

test('review-complete (R5-B1): the marker is bound to the state it was issued for: a state republished after it refuses, as does a marker with no state hash or another round count', async () => {
  const w = await checkWorld({ items: [claudeItem()] });
  const ok = await w.check();
  assert.equal(ok.ok, true, ok.detail);
  // a state republished after the marker (comment --kind triage): local and published agree, but the marker was issued for the old one
  const later = rulingState({ hash: w.hash, items: [claudeItem({ final: { ...claudeItem().final, reason: 'republished after the marker' } })] });
  saveState(w.repo.dir, later);
  const marker = { stateHash: reviewContentHash(w.st) };
  refusal(await w.check(gh(w.published({ state: later, marker }))), /issued for another review state.*review-complete --pr 12/);
  assert.equal((await w.check(gh(w.published({ state: later })))).ok, true, 'a marker issued for that very state passes');
  // a marker from before the field cannot prove it
  refusal(await w.check(gh(w.published({ state: later, marker: { stateHash: 'none' } }))), /no review-state hash.*review-complete --pr 12/);
  // the round count is bound too
  refusal(await w.check(gh(w.published({ state: later, marker: { rounds: 2 } }))), /2 round\(s\).*review-complete --pr 12/);
});

test('review-complete: an unimplemented ACCEPT, a forced ACCEPT not implemented and a Claude FOLLOW-UP without an issue refuse; the issue cures the last', async () => {
  const accept = claudeItem({ id: 'R1-B1', final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'real' } });
  const forced = claudeItem({ id: 'R1-B2', fingerprint: 'fp-f', final: { decision: 'ACCEPT', by: 'claude', forcedBy: 'second-review', needsHuman: false, reason: 'codex says accept', claude: { ruledAt: 'x', cause: 'low-confidence', critical: true, overruled: null } } });
  for (const it of [accept, forced]) {
    const w = await checkWorld({ items: [it] });
    refusal(await w.check(), /findings are unresolved/);
  }
  const followup = (issue) => claudeItem({ final: { decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'tracked', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: null } }, followupIssue: issue });
  refusal(await (await checkWorld({ items: [followup(null)] })).check(), /without a filed issue: R1-B1/);
  assert.equal((await (await checkWorld({ items: [followup(5)] })).check()).ok, true);
});

test('review-complete: corrupt local state fails the check (no throw); evaluateOwnerGo reports it and returns the block fields', async () => {
  const w = await checkWorld();
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), '{ not json');
  refusal(await w.check(), /unreadable/);
  const g = { ...gh([]), prView: () => ({}), repo: () => ({ slug: 'acme/widgets', host: 'github.com' }), checks: () => [], pullFiles: () => [] };
  const live = await evaluateOwnerGo({ root: w.repo.dir, config: w.config, pr: PR, gh: g, env: {} });
  assert.ok(live.failed.includes('review-complete'));
  assert.equal(live.rulingsDigest, 'none');
  assert.equal(live.rulingCount, 0);
  assert.equal(live.rulings, '');
});

test('review-complete: evaluateOwnerGo measures from GitHub\'s base, so a stale local base after update-branch + pull does not refuse', async () => {
  const w = await checkWorld({ items: [claudeItem()] });
  const published = w.published();
  const stale = w.baseTip;
  w.repo.git(['checkout', 'main']);
  w.repo.write('src/other.js', 'export const other = 1;\n');
  const tip = w.repo.commit('main moved');
  w.repo.git(['checkout', 'agent/feature']);
  w.repo.git(['merge', '--no-ff', '--no-edit', 'main']);
  w.repo.git(['update-ref', 'refs/heads/main', stale]); // the cached base the PR's own pull leaves behind
  const g = { ...gh(published), prView: () => ({ baseRefOid: tip, baseRefName: 'main' }), repo: () => ({ slug: 'acme/widgets', host: 'github.com' }), checks: () => [], pullFiles: () => [] };
  const live = await evaluateOwnerGo({ root: w.repo.dir, config: w.config, pr: PR, gh: g, sleep: async () => {}, env: {} });
  const completion = live.checks.find((c) => c.name === 'review-complete');
  assert.equal(completion.ok, true, completion.detail);
  assert.equal(live.rulingCount, 1);
  // The same check measured from the stale base sees main's commit as part of the PR: this is what the base from GitHub avoids.
  refusal(await w.check(gh(published)), /no clean review round/);
});

test('review-complete: the docs-only exemption keeps a PR whose only newer commit adds lines to a listed document', async () => {
  const yml = `${goYml()}review:\n  docs_exempt_paths: ["docs/guide.md"]\n`;
  const e = await checkWorld({ yml, items: [], local: 'none' });
  const st = addRound(emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'low', maxRounds: 2 }), { n: 1, fromHead: e.baseTip, toHead: e.head, contentHashAtToHead: e.hash, items: [] });
  st.currentContentHash = e.hash;
  e.repo.write('docs/guide.md', '# Guide\n\nMore.\n');
  e.repo.commit('docs');
  const hash2 = localContentHash(e.repo.dir, e.config);
  assert.notEqual(hash2, e.hash);
  saveState(e.repo.dir, st);
  const r = await e.check(gh(publishedComments(st, { hash: hash2, head: e.head, base: e.baseTip })));
  assert.equal(r.ok, true, r.detail);
});

// ---- the gated route (E3) ---------------------------------------------------------------------------------------------------------------

async function reviewOf(items) {
  const s = scenario({ report: null, state: null, change: unique });
  const { config } = await loadConfig(s.repo.dir);
  saveState(s.repo.dir, rulingState({ hash: s.hash, items }));
  return reviewCheck({ root: s.repo.dir, config, pr: PR, repo: 'acme/widgets', diff: () => ({ ok: true, files: ['src/app.js'] }), hash: s.hash, ownerGo: {} });
}

test('gated route: a Claude dismissal is an owner item (ownerMerge, review-ruling line); arbiter dismissals add nothing; a changed ruling changes the item', async () => {
  const claude = await reviewOf([claudeItem()]);
  assert.equal(claude.ok, true, claude.detail);
  assert.equal(claude.ownerMerge, 1);
  assert.match(claude.ownerItems[0], /^review-ruling R1-B1 [0-9a-f]{12}$/);
  assert.match(claude.detail, /Claude-made dismissal/);
  const arbiter = await reviewOf([arbiterItem()]);
  assert.equal(arbiter.ok, true, arbiter.detail);
  assert.equal(arbiter.ownerMerge, undefined);
  assert.equal(arbiter.ownerItems, undefined);
  const changed = await reviewOf([claudeItem({ final: { ...claudeItem().final, reason: 'a different reason' } })]);
  assert.notEqual(changed.ownerItems[0], claude.ownerItems[0]);
  const row = rulingsBlock(rulingState({ hash: 'h', items: [claudeItem()] })).split('\n')[1];
  assert.equal(claude.ownerItems[0].split(' ')[2], createHash('sha256').update(row).digest('hex').slice(0, 12));
  const noIssue = await reviewOf([claudeItem({ final: { decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'later', claude: { ruledAt: 'x', cause: 'low-confidence', critical: true, overruled: null } } })]);
  assert.equal(noIssue.ok, false);
  assert.match(noIssue.detail, /without a filed issue/);
});

test('gated route: the final gate counts the Claude dismissal; a changed ruling after the owner said "merge" is refused by the owner-item compare; the record needs no Rulings block', async (t) => {
  const s = scenario({ state: null });
  saveState(s.repo.dir, rulingState({ hash: s.hash, items: [claudeItem()] }));
  const g = s.gate();
  assertExit(g, 0, `${g.stderr}${g.stdout}`);
  const gate = s.gateFile();
  assert.equal(gate.ownerMerge, 1);
  // the owner approves the item set exactly as final-gate printed it; the shown request has NO Rulings block (this route does not bind it)
  ownerSays(t, 'merge', mergeRequest(PR, s.head, gate.ownerItems));
  saveState(s.repo.dir, rulingState({ hash: s.hash, items: [claudeItem({ final: { ...claudeItem().final, reason: 'changed after the owner approved' } })] }));
  const flags = cli(['merge', '--pr', String(PR), '--owner-approved-head', s.head, '--owner-approved-items', gate.ownerItems], { dir: s.repo.dir, fake: s.fake, env: s.env });
  assert.equal(flags.code, 1, flags.stdout);
  assert.match(JSON.stringify(flags.json), /owner items changed since the owner said/);
  assert.deepEqual(s.mergeCalls(), []);
});

// ---- E2: the review lock for the whole merge --------------------------------------------------------------------------------------------

const SLOW = [
  "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
  "writeFileSync('.review/merge-started', '1');",
  'await new Promise((resolve) => setTimeout(resolve, 3500));',
  '',
].join('\n');
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');

test('E2: while a merge command runs, a concurrent claude-ruling fails lock-timeout and changes nothing', async (t) => {
  const s = world({ items: [claudeItem()], yml: goYml().replace('scripts/fake-merge.mjs', 'scripts/slow-merge.mjs'), baseFiles: { 'scripts/slow-merge.mjs': SLOW } });
  approveViaHook(t, s);
  const env = { ...process.env, PIPELINE_MERGEABLE_PAUSE_MS: '1', PIPELINE_LOCK_DIR: LOCK_DIR, PIPELINE_MACHINE_ID: 'gate-env-test-machine', ...s.fake.env, ...createFakeCodex().env, ...s.env };
  const child = spawn(process.execPath, [bin, 'merge', '--pr', String(PR), '--owner-go'], { cwd: s.repo.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', resolve));
  const started = join(s.repo.dir, '.review', 'merge-started');
  for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(started), 'the merge command started');
  const before = readFileSync(join(s.repo.dir, '.review', 'state.json'), 'utf8');
  const w = cli(['triage', 'claude-ruling', '--round', '1', '--id', 'R1-B1', '--decision', 'REJECT', '--reason', 'changed my mind', '--pr', String(PR)], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, PIPELINE_LOCK_WAIT_MS: '300' } });
  assertExit(w, 2, `${w.stderr}${w.stdout}`);
  assert.equal(w.json.error, 'lock-timeout');
  assert.equal(readFileSync(join(s.repo.dir, '.review', 'state.json'), 'utf8'), before, 'the state is unchanged');
  await done;
  assert.equal(JSON.parse(out).merged, true, out);
});

test('E2: a writer holding the review lock first makes `P merge --owner-go` refuse cleanly: nothing merged, nothing written; free again afterwards', async (t) => {
  const s = world({ items: [claudeItem()] });
  approveViaHook(t, s);
  let r;
  await withReviewLock(s.repo.dir, PR, { env: { PIPELINE_LOCK_DIR: LOCK_DIR } }, async () => {
    r = s.go({ PIPELINE_LOCK_WAIT_MS: '200' });
  });
  refusedGo(r, s, /review lock/, 'lock-timeout');
  assert.match(r.json.reasons.join(' '), /nothing was changed/);
  assert.deepEqual(s.writes(), []);
  assertExit(s.go(), 0);
});
