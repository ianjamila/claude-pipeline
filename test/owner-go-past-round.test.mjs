// The owner's approval of a PAST review round (plan 2026-11-12-legacy-round-grants, section B, hook/record half): the 🔂 line, the kind 'past-round'
// record, its separation from the extra-round record and its verification at the gate. The extra-round tests stay in owner-go.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  claimGrantMarkers, grantIdOf, ownerGoDir, ownerGrantGap, ownerGrantedRounds, ownerPastRoundRecords, parsePastRoundGrant, parseRoundGrant, pastRoundGrantsFor,
  presentedPastRoundRequest, presentedRoundRequest, recordPastRoundGrant, recordRoundGrant, verifyOwnerGrant,
} from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, linesOf, pastRoundRequest, roundRequest } from './helpers/owner-go.mjs';

const REPO = 'acme/app';
const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const PASK = pastRoundRequest(5, 6, GHEAD, REPO); // round 6 of PR 5 ran before the cap existed
const RASK = roundRequest(5, 6, GHEAD, REPO);
const AT = Date.parse('2026-11-12T10:00:00Z');
const NOW = () => AT;

const tmp = () => mkdtempSync(join(tmpdir(), 'owner-go-past-'));
let pid = 0;
const promptEntry = (text, meta = OWNER_ENTRY) => ({ type: 'user', message: { content: text }, promptId: `pid-${++pid}`, ...meta });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
// A hook input whose transcript is <home>/.claude/projects/-repo/t-*.jsonl: [owner opening, the agent's reply (or `entries`), the prompt being submitted].
function input(home, prompt, reply, { meta = OWNER_ENTRY, extra = {}, entries = null } = {}) {
  const e = promptEntry(prompt, meta);
  mkdirSync(join(home, '.claude', 'projects', '-repo'), { recursive: true });
  const file = join(home, '.claude', 'projects', '-repo', `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, linesOf([promptEntry('go'), ...(entries ?? [said(reply)]), e]));
  return { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt, prompt_id: e.promptId, transcript_path: file, ...extra };
}
const past = (home, prompt, reply = PASK, o = {}) => recordPastRoundGrant(input(home, prompt, reply, o), { home, now: NOW });
const q = (home, o = {}) => ({ repo: REPO, pr: 5, k: 6, head: GHEAD, home, now: () => AT + 1000, ...o });

test('past round: the 🔂 line is the last non-blank line and names PR, counted round, head and repository', () => {
  assert.deepEqual(presentedPastRoundRequest(PASK), { pr: 5, k: 6, head: GHEAD.slice(0, 12), repo: REPO });
  assert.deepEqual(presentedPastRoundRequest(`${PASK}\n\n  `), { pr: 5, k: 6, head: GHEAD.slice(0, 12), repo: REPO }, 'trailing blank lines');
  assert.deepEqual(presentedPastRoundRequest(`🔂 Approve past review round #5: round 6 | head ${GHEAD} | repo Acme/App`), { pr: 5, k: 6, head: GHEAD, repo: 'acme/app' });
  assert.equal(presentedPastRoundRequest('Approve past review round #5: round 6 · head abcdef012345 · repo a/b').pr, 5, 'the 🔂 mark is optional');
  for (const bad of [
    `${PASK}\nanything after`,
    `${PASK}\nmore\nThen prose.`,
    'Approve past review round #5: round 6 · head abcdef012345', // no repo
    'Approve past review round #5: round 6 · head abcdef01234 · repo a/b', // 11-char head
    'Approve past review round #5: round 6 · head abcdef01234g · repo a/b', // not hex
    `Approve past review round #5: round 6 · head ${'a'.repeat(41)} · repo a/b`,
    'Approve past review round #5: round x · head abcdef012345 · repo a/b',
    'Approve past review round: round 6 · head abcdef012345 · repo a/b',
    'Approve past review round #5: round 6 · head abcdef012345 · repo acme',
    '', null,
  ]) assert.equal(presentedPastRoundRequest(bad), null, String(bad));
  assert.equal(presentedPastRoundRequest(`${PASK}\nA mid-reply line: ${PASK}\nnext`), null, 'a line in the middle of a reply binds nothing');
});

test('past round: neither parser accepts the other\'s line', () => {
  assert.equal(presentedRoundRequest(PASK), null, 'the extra-round parser refuses the 🔂 line');
  assert.equal(presentedPastRoundRequest(RASK), null, 'the past-round parser refuses the 🔁 line');
  assert.notEqual(presentedRoundRequest(RASK), null);
  assert.notEqual(presentedPastRoundRequest(PASK), null);
});

test('past round: the owner\'s words are the extra-round ones plus "approve", with the same target rules', () => {
  for (const [p, want] of [
    ['approve round', { prs: [], numbers: [] }],
    ['Approve past round.', { prs: [], numbers: [] }],
    ['approve past review round #5', { prs: [5], numbers: [] }],
    ['extra round', { prs: [], numbers: [] }],
    ['grant round 6 #5 please', { prs: [5], numbers: [6] }],
  ]) assert.deepEqual(parsePastRoundGrant(p), want, p);
  for (const p of ['approve round?', 'no approve round', 'approve rounds', 'approve round later', 'approve round #12345678', 'approve', 'approve past', 'merge', '', null]) {
    assert.equal(parsePastRoundGrant(p), null, String(p));
  }
  assert.equal(parseRoundGrant('approve round'), null, 'the extra-round words are unchanged: "approve round" grants no extra round');
  assert.equal(parseRoundGrant('approve past round'), null);
});

test('past round: recorded after a reply that ends with the 🔂 line, verbatim, as kind past-round; each recorder ignores the other line', () => {
  const home = tmp();
  const r = past(home, 'Approve  past round, please');
  assert.deepEqual([r.v, r.kind, r.repo, r.pr, r.k, r.head, r.prompt, r.session, r.ts], [1, 'past-round', REPO, 5, 6, GHEAD.slice(0, 12), 'Approve  past round, please', 'sess-1', new Date(AT).toISOString()]);
  assert.match(r.prompt_sha256, /^[0-9a-f]{64}$/);
  const h1 = tmp();
  assert.equal(recordRoundGrant(input(h1, 'extra round', PASK), { home: h1, now: NOW }), null, 'the extra-round recorder: a 🔂 line is no request');
  assert.equal(past(tmp(), 'extra round', RASK), null, 'the past-round recorder: a 🔁 line is no request');
  // the same words after each line record under their own kind
  const h2 = tmp();
  assert.equal(recordRoundGrant(input(h2, 'extra round', RASK), { home: h2, now: NOW }).kind, 'extra-round');
  assert.equal(past(tmp(), 'extra round', PASK).kind, 'past-round');
});

test('past round: no record for a wrong reply shape, wrong words, a long prompt, a sub-agent or another hook event', () => {
  const home = tmp();
  const no = (why, i) => assert.equal(recordPastRoundGrant(i, { home, now: NOW }), null, why);
  no('text after the line', input(home, 'approve round', `${PASK}\nBy the way.`));
  no('line mid-reply', input(home, 'approve round', `${PASK}\nCI is green.\nDone.`));
  no('an older reply', input(home, 'approve round', null, { entries: [said(PASK), promptEntry('and?'), said('Still thinking.')] }));
  no('no line at all', input(home, 'approve round', 'Nothing asked.'));
  no('no repo', input(home, 'approve round', PASK.replace(/ · repo .*$/, '')));
  no('short head', input(home, 'approve round', PASK.replace(GHEAD.slice(0, 12), GHEAD.slice(0, 11))));
  no('wrong words', input(home, 'merge', PASK));
  no('a question', input(home, 'approve round?', PASK));
  no('later filler', input(home, 'approve round after CI', PASK));
  no('an empty prompt', input(home, '  ', PASK));
  const long = `approve round ${'please '.repeat(60)}`;
  assert.ok(long.length > 300);
  no('over-length prompt (never cut)', input(home, long, PASK));
  no('subagent', input(home, 'approve round', PASK, { extra: { agent_id: 'a1' } }));
  no('other hook event', input(home, 'approve round', PASK, { extra: { hook_event_name: 'PreToolUse' } }));
  no('odd session', input(home, 'approve round', PASK, { extra: { session_id: '../x' } }));
  assert.equal(ownerPastRoundRecords(q(home)).length, 0);
});

test('past round: a prompt naming another PR or round than the line records nothing; bare integers are read against the line', () => {
  const home = tmp();
  for (const p of ['approve round #5', 'approve round 6', 'approve round 6 #5', 'approve round 5', 'approve past round 5 6']) assert.ok(past(home, p), p);
  for (const p of ['approve round #6', 'approve round 7', 'approve round 5 #6', 'approve round 4 #5', 'approve round #5 #6']) assert.equal(past(home, p), null, p);
});

test('past round: a harness-injected, queued or peer turn is not recorded', () => {
  const NOTICE = { origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', entrypoint: 'cli' };
  const PEER = { origin: { kind: 'peer' }, promptSource: 'system', isMeta: true, entrypoint: 'cli' };
  const SCHEDULED = { promptSource: 'system', isMeta: true, entrypoint: 'cli' };
  const SDK = { promptSource: 'sdk', turnOrigin: 'sdk', entrypoint: 'sdk-cli' };
  const QUEUED = { origin: { kind: 'human' }, promptSource: 'queued', entrypoint: 'cli' };
  for (const [name, meta] of [['notice', NOTICE], ['peer', PEER], ['scheduled', SCHEDULED], ['sdk', SDK], ['queued', QUEUED]]) {
    assert.equal(past(tmp(), 'approve round', PASK, { meta }), null, name);
    assert.equal(past(tmp(), 'extra round', PASK, { meta }), null, `${name}: the extra-round words too`);
  }
  // the hook input's own provenance fields
  assert.equal(past(tmp(), 'approve round', PASK, { extra: { promptSource: 'system' } }), null, 'hook input says system');
  assert.equal(past(tmp(), 'approve round', PASK, { extra: { origin: { kind: 'peer' } } }), null, 'hook input origin is not human');
  assert.ok(past(tmp(), 'approve round', PASK), 'control: the owner\'s own typed words record');
});

test('past round: a past-round record is invisible to every extra-round reader, and an extra-round record to the past-round readers', () => {
  const home = tmp();
  const rec = past(home, 'approve round');
  assert.ok(rec);
  assert.deepEqual(ownerGrantedRounds(q(home)), [], 'ownerGrantedRounds (codex-review, round-request, state)');
  assert.deepEqual(ownerGrantedRounds(q(home, { anyHead: true, head: undefined })), [], 'any head too');
  assert.equal(ownerGrantGap(q(home)), 'none', 'ownerGrantGap: no extra-round record at all');
  // the past-round readers see it: unspent, < 24 h, owner provenance
  assert.deepEqual(pastRoundGrantsFor(q(home)).map(grantIdOf), [grantIdOf(rec)]);
  assert.deepEqual(ownerPastRoundRecords(q(home)).map(grantIdOf), [grantIdOf(rec)]);
  // bound to (repo, pr, k, head)
  for (const [why, o] of [['other repo', { repo: 'acme/fork' }], ['other PR', { pr: 6 }], ['other round', { k: 7 }], ['other head', { head: `${'0'.repeat(12)}${GHEAD.slice(12)}` }]]) {
    assert.deepEqual(ownerPastRoundRecords(q(home, o)), [], why);
  }
  assert.equal(ownerPastRoundRecords(q(home, { head: GHEAD.slice(0, 12) })).length, 0, 'a short head matches nothing');
  assert.equal(ownerPastRoundRecords(q(home, { anyHead: true, head: undefined })).length, 1, 'anyHead drops the head test');
  assert.equal(ownerPastRoundRecords(q(home, { repo: 'ACME/App' })).length, 1, 'repository names compare lower case');
  assert.deepEqual(ownerPastRoundRecords(q(home, { now: () => AT + 25 * 3600_000 })), [], 'older than 24 h');
  // the other way round
  const home2 = tmp();
  assert.ok(recordRoundGrant(input(home2, 'extra round', RASK), { home: home2, now: NOW }));
  assert.equal(ownerGrantedRounds(q(home2)).length, 1);
  assert.deepEqual(pastRoundGrantsFor(q(home2)), []);
  assert.deepEqual(ownerPastRoundRecords(q(home2)), []);
});

test('past round: a spent marker, or a prompt that is no longer the owner\'s, takes the record out of the past-round lookups', () => {
  const home = tmp();
  const rec = past(home, 'approve round');
  assert.equal(claimGrantMarkers([rec], { repo: REPO, pr: 5, k: 6, head: GHEAD, checkout: '/x' }, { home, now: () => AT + 500 }).ok, true);
  assert.deepEqual(pastRoundGrantsFor(q(home)), [], 'spent');
  // provenance: the same record with its prompt entry rewritten as a harness turn
  const home2 = tmp();
  const i = input(home2, 'approve round', PASK);
  assert.ok(recordPastRoundGrant(i, { home: home2, now: NOW }));
  writeFileSync(i.transcript_path, linesOf([promptEntry('go'), said(PASK), { ...promptEntry('approve round', { promptSource: 'system', isMeta: true, entrypoint: 'cli' }), promptId: i.prompt_id }]));
  assert.equal(pastRoundGrantsFor(q(home2)).length, 1, 'the record exists');
  assert.deepEqual(ownerPastRoundRecords(q(home2)), [], 'but it is not confirmed as the owner\'s');
});

// verifyOwnerGrant: the two kinds back two kinds of ownerGrant and never cross.
function claimed(home, rec) {
  assert.equal(claimGrantMarkers([rec], { repo: REPO, pr: 5, k: 6, head: GHEAD, checkout: '/x' }, { home, now: () => AT + 500 }).ok, true);
}
const late = (home) => ({ home, now: () => AT + 40 * 24 * 3600_000 });

test('past round: verifyOwnerGrant takes a past-round record only for an ownerGrant with past: true', () => {
  const home = tmp();
  const rec = past(home, 'approve round');
  claimed(home, rec);
  const grantId = grantIdOf(rec);
  const v = { repo: REPO, pr: 5, k: 6, toHead: GHEAD };
  const ok = verifyOwnerGrant({ ...v, ownerGrant: { grantId, quote: rec.prompt, past: true } }, late(home));
  assert.equal(ok.ok, true);
  assert.equal(ok.record.kind, 'past-round');
  for (const [why, ownerGrant] of [
    ['no past flag', { grantId, quote: rec.prompt }],
    ['past: false', { grantId, quote: rec.prompt, past: false }],
  ]) {
    const r = verifyOwnerGrant({ ...v, ownerGrant }, late(home));
    assert.deepEqual([r.ok, r.reason], [false, 'no-record'], `${why}: a past-round record is no extra-round grant`);
  }
  assert.deepEqual(verifyOwnerGrant({ ...v, ownerGrant: { grantId, quote: rec.prompt, past: 'true' } }, late(home)), { ok: false, reason: 'malformed' }, 'past must be a boolean');
  // the rest is unchanged: bound to (repo, pr, k, toHead), marker, quote
  const bad = (why, o, ownerGrant = { grantId, quote: rec.prompt, past: true }) => assert.equal(verifyOwnerGrant({ ...v, ownerGrant, ...o }, late(home)).ok, false, why);
  bad('other repo', { repo: 'acme/fork' });
  bad('other PR', { pr: 6 });
  bad('other round', { k: 7 });
  bad('other full head', { toHead: `${GHEAD.slice(0, 12)}${'0'.repeat(28)}` });
  bad('paraphrased quote', {}, { grantId, quote: 'APPROVE ROUND', past: true });
  bad('another ownerGrant.k', {}, { grantId, quote: rec.prompt, past: true, k: 7 });
  // no marker: a second record nobody consumed
  const other = past(home, 'approve past round');
  assert.ok(other);
  assert.equal(verifyOwnerGrant({ ...v, ownerGrant: { grantId: grantIdOf(other), quote: other.prompt, past: true } }, late(home)).reason, 'no-marker');
});

test('past round: verifyOwnerGrant takes an extra-round record only for an ownerGrant WITHOUT past', () => {
  const home = tmp();
  const rec = recordRoundGrant(input(home, 'extra round', RASK), { home, now: NOW });
  assert.ok(rec);
  claimed(home, rec);
  const grantId = grantIdOf(rec);
  const v = { repo: REPO, pr: 5, k: 6, toHead: GHEAD };
  assert.equal(verifyOwnerGrant({ ...v, ownerGrant: { grantId, quote: rec.prompt } }, late(home)).ok, true, 'control: as before');
  assert.equal(verifyOwnerGrant({ ...v, ownerGrant: { grantId, quote: rec.prompt, past: false } }, late(home)).ok, true, 'past: false reads as no flag');
  const crossed = verifyOwnerGrant({ ...v, ownerGrant: { grantId, quote: rec.prompt, past: true } }, late(home));
  assert.deepEqual([crossed.ok, crossed.reason], [false, 'no-record'], 'an extra-round record cannot back a past grant');
});

test('past round: the hook records it and prints ONE context line naming the counted round, exits 0; a 🔁 line keeps its own line', () => {
  const hook = fileURLToPath(new URL('../pipeline/hooks/owner-go.mjs', import.meta.url));
  const dir = tmp();
  const session = `test-hook-${Math.random().toString(36).slice(2)}`;
  const run = (reply, prompt) => spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify(input(dir, prompt, reply, { extra: { session_id: session } })) });
  try {
    const miss = run(PASK, 'hello there');
    assert.deepEqual([miss.status, miss.stdout], [0, ''], 'nothing recorded: nothing printed');
    const r = run(PASK, 'approve round');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `[claude-pipeline owner-go] the owner's past-round approval is recorded for ${REPO} #5 counted round 6 head ${GHEAD.slice(0, 12)}: run P state past-round-grant --pr 5 --round <the n from round-request --past>\n`);
    const e = run(RASK, 'extra round');
    assert.match(e.stdout, /the owner's extra round is recorded for acme\/app #5 counted round 6 head [0-9a-f]{12}: run P codex-review --pr 5 --round/);
    assert.doesNotMatch(e.stdout, /past-round/);
  } finally {
    rmSync(join(ownerGoDir(), `${session}.jsonl`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
