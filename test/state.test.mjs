import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { renameSync as realRename } from 'node:fs';
import {
  emptyState,
  loadState,
  saveState,
  encodeForComment,
  decodeFromComment,
  addRound,
  updateItems,
  SUPPORTED_STATE_VERSION,
  STATE_VERSION_DEFERRAL,
  STATE_VERSION_SUBSTITUTE,
  STATE_VERSION_OUT_OF_MODEL,
  STATE_VERSION_POST_MAX,
  stateNeedsPostMaxVersion,
  maxRiskOf,
  stateNeedsOutOfModelVersion,
  withStateVersion,
} from '../pipeline/lib/state.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cp-state-'));
}

const it = (id, over = {}) => ({
  id, round: 1, bucket: 'BLOCKING', category: 'logic', title: `t ${id}`, file: 'a.js', line: 1,
  detail: 'd', codexReasoning: 'r', testable: false, fingerprint: `fp-${id}`, judge: null,
  test: { status: 'none', evidence: '' }, arbiter: null, final: null, implemented: false, followupIssue: null,
  ...over,
});

function sampleState() {
  let s = emptyState({ repo: 'ianjamila/x', pr: 12, branch: 'agent/x', risk: 'medium', lightLane: false, maxRounds: 3 });
  s = addRound(s, {
    n: 1, fromHead: 'aaa', toHead: 'bbb', contentHashAtToHead: 'hash1',
    items: [
      it('R1-B1', { title: 'unicode — “quotes” | pipe ✓', judge: { decision: 'ACCEPT', confidence: 'high', reason: 'r', disputedBug: false, settleTest: { possible: false, plan: '' } } }),
      it('R1-S1', { bucket: 'SUGGESTION', final: { decision: 'REJECT', by: 'judge', needsHuman: false, reason: 'meh' } }),
    ],
  });
  return s;
}

test('emptyState: carries the run identity and starts with no rounds', () => {
  const s = emptyState({ repo: 'o/r', pr: 7, branch: 'b', risk: 'low', lightLane: true, maxRounds: 3 });
  assert.equal(s.repo, 'o/r');
  assert.equal(s.pr, 7);
  assert.equal(s.branch, 'b');
  assert.equal(s.risk, 'low');
  assert.equal(s.lightLane, true);
  assert.equal(s.maxRounds, 3);
  assert.deepEqual(s.rounds, []);
  assert.equal(s.currentContentHash, '');
  // Must be JSON-serialisable as-is.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('saveState then loadState round-trips the state exactly', () => {
  const dir = tmp();
  try {
    const s = sampleState();
    saveState(dir, s);
    assert.deepEqual(loadState(dir), s);
    // Saving again replaces the file.
    const s2 = addRound(s, { n: 2, fromHead: 'bbb', toHead: 'ccc', contentHashAtToHead: 'hash2', items: [] });
    saveState(dir, s2);
    assert.deepEqual(loadState(dir), s2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState returns null when there is no state, even when .review/ is absent', () => {
  const dir = tmp();
  try {
    assert.equal(loadState(dir), null);
    mkdirSync(join(dir, '.review'));
    assert.equal(loadState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState throws a readable error on a corrupt file instead of returning null', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.review'));
    writeFileSync(join(dir, '.review', 'state.json'), '{"rounds": [');
    assert.throws(() => loadState(dir), /corrupt review state.*state\.json/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState writes atomically: only state.json is left behind, never a tmp file', () => {
  const dir = tmp();
  try {
    saveState(dir, sampleState());
    saveState(dir, sampleState());
    assert.deepEqual(readdirSync(join(dir, '.review')), ['state.json']);
    // The file on disk is always complete, valid JSON.
    JSON.parse(readFileSync(join(dir, '.review', 'state.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState leaves no tmp file and keeps the old state when the write fails', () => {
  const dir = tmp();
  try {
    const s = sampleState();
    saveState(dir, s);
    const circular = { a: 1 };
    circular.self = circular;
    assert.throws(() => saveState(dir, circular));
    assert.deepEqual(readdirSync(join(dir, '.review')), ['state.json']);
    assert.deepEqual(loadState(dir), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('encodeForComment / decodeFromComment round-trip, including unicode and pipes', () => {
  const s = sampleState();
  const marker = encodeForComment(s);
  assert.match(marker, /^<!-- claude-pipeline:state:[A-Za-z0-9+/=]+ -->$/);
  assert.ok(!marker.includes('\n'));
  assert.deepEqual(decodeFromComment(marker), s);
});

test('decodeFromComment finds the marker inside a longer comment body', () => {
  const s = sampleState();
  const body = `<!-- claude-pipeline:triage -->\n### Pipeline review triage\n\n| a | b |\n\n${encodeForComment(s)}`;
  assert.deepEqual(decodeFromComment(body), s);
});

test('decodeFromComment uses the last marker, so quoted text cannot override the real state', () => {
  const fake = { ...sampleState(), pr: 666 };
  const real = sampleState();
  const body = `${encodeForComment(fake)}\nmore text\n${encodeForComment(real)}`;
  assert.equal(decodeFromComment(body).pr, 12);
});

test('decodeFromComment returns null for garbage and never throws', () => {
  const gz = (v) => gzipSync(Buffer.from(v)).toString('base64');
  const marker = (b64) => `<!-- claude-pipeline:state:${b64} -->`;
  const garbage = [
    '',
    'no marker here',
    '<!-- claude-pipeline:state: -->',
    marker('!!!not-base64!!!'),
    '<!-- claude-pipeline:state:%%% -->',
    marker(Buffer.from('plain text, not gzip').toString('base64')),
    marker(gz('this is not json')),
    marker(gz('[1,2,3]')),
    marker(gz('null')),
    marker(gz('"a string"')),
    marker(gz('42')),
    marker(gz('{"truncated": ')),
    marker('H4sIAAAAAAAAA'), // truncated gzip header
    '<!-- claude-pipeline:state:AAAA',
    null,
    undefined,
    42,
    {},
  ];
  for (const g of garbage) {
    assert.equal(decodeFromComment(g), null, JSON.stringify(g));
  }
});

test('decodeFromComment refuses a decompression bomb instead of exhausting memory', () => {
  // Valid JSON, so only the size cap (not a parse failure) can be what rejects it.
  const json = `{"pr":1,"rounds":[],"pad":"${'a'.repeat(64 * 1024 * 1024)}"}`;
  const bomb = gzipSync(Buffer.from(json)).toString('base64');
  assert.ok(bomb.length < 200_000, 'the comment itself is small');
  assert.equal(decodeFromComment(`<!-- claude-pipeline:state:${bomb} -->`), null);
});

test('addRound appends a round without mutating the old state', () => {
  const s0 = emptyState({ repo: 'o/r', pr: 1, branch: 'b', risk: 'low', lightLane: false, maxRounds: 3 });
  const items = [it('R1-B1')];
  const s1 = addRound(s0, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items });
  assert.equal(s0.rounds.length, 0);
  assert.equal(s1.rounds.length, 1);
  assert.deepEqual(s1.rounds[0], { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items });
  items[0].title = 'changed after the fact';
  assert.equal(s1.rounds[0].items[0].title, 't R1-B1', 'state does not alias the caller items');
  const s2 = addRound(s1, { n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [] });
  assert.deepEqual(s2.rounds.map((r) => r.n), [1, 2]);
});

test('addRound refuses a round number that already exists', () => {
  const s = sampleState();
  assert.throws(() => addRound(s, { n: 1, fromHead: 'x', toHead: 'y', contentHashAtToHead: 'h', items: [] }), /round 1 already/i);
});

test('updateItems replaces items by id within round n, keeps the rest, and does not mutate', () => {
  const s = sampleState();
  const judged = { ...s.rounds[0].items[0], implemented: true };
  const s2 = updateItems(s, 1, [judged]);
  assert.equal(s2.rounds[0].items[0].implemented, true);
  assert.equal(s2.rounds[0].items[1].id, 'R1-S1', 'other items kept');
  assert.equal(s.rounds[0].items[0].implemented, false, 'original state untouched');
  // A full list in a different order keeps the original order.
  const s3 = updateItems(s2, 1, [s2.rounds[0].items[1], s2.rounds[0].items[0]]);
  assert.deepEqual(s3.rounds[0].items.map((i) => i.id), ['R1-B1', 'R1-S1']);
  // Unknown ids are appended (a round can gain items).
  const s4 = updateItems(s, 1, [it('R1-W1', { bucket: 'WORTH_CONSIDERING' })]);
  assert.deepEqual(s4.rounds[0].items.map((i) => i.id), ['R1-B1', 'R1-S1', 'R1-W1']);
});

test('updateItems throws for a round that does not exist', () => {
  assert.throws(() => updateItems(sampleState(), 9, []), /round 9/i);
});

// ---- review fixes: fail-closed state handling ------------------------------------------------

test('addRound requires items to be an array', () => {
  const s = emptyState({ repo: 'o/r', pr: 1, branch: 'b', risk: 'low', lightLane: false, maxRounds: 3 });
  const base = { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h' };
  for (const items of [undefined, null, 'x', {}, 7, { length: 0 }]) {
    assert.throws(() => addRound(s, { ...base, items }), /items/i, String(items));
  }
  assert.equal(addRound(s, { ...base, items: [] }).rounds.length, 1);
});

test('loadState throws on a file that parses to anything other than a plain object', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.review'));
    for (const text of ['[]', 'null', '"a string"', '42', 'true', '[{"rounds":[]}]']) {
      writeFileSync(join(dir, '.review', 'state.json'), text);
      assert.throws(() => loadState(dir), /corrupt review state/i, text);
    }
    writeFileSync(join(dir, '.review', 'state.json'), '{"rounds":[]}');
    assert.deepEqual(loadState(dir), { rounds: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decodeFromComment returns null unless the state has a rounds array and a positive integer pr', () => {
  const enc = (v) => encodeForComment(v);
  const good = { pr: 12, rounds: [] };
  assert.deepEqual(decodeFromComment(enc(good)), good);
  const bad = [
    {}, { pr: 12 }, { rounds: [] },
    { pr: 12, rounds: {} }, { pr: 12, rounds: 'x' }, { pr: 12, rounds: null },
    { pr: 0, rounds: [] }, { pr: -3, rounds: [] }, { pr: 1.5, rounds: [] },
    { pr: '12', rounds: [] }, { pr: null, rounds: [] }, { pr: NaN, rounds: [] }, { pr: Infinity, rounds: [] },
  ];
  for (const b of bad) assert.equal(decodeFromComment(enc(b)), null, JSON.stringify(b));
});

test('saveState retries a rename that fails with EPERM, EBUSY or EACCES, waiting 50 ms between tries', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const dir = tmp();
    try {
      const s = sampleState();
      let calls = 0;
      const waits = [];
      const rename = (from, to) => {
        calls += 1;
        if (calls <= 3) throw Object.assign(new Error('locked'), { code });
        return realRename(from, to);
      };
      saveState(dir, s, { rename, sleep: (ms) => waits.push(ms) });
      assert.equal(calls, 4, code);
      assert.deepEqual(waits, [50, 50, 50], code);
      assert.deepEqual(loadState(dir), s);
      assert.deepEqual(readdirSync(join(dir, '.review')), ['state.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('saveState gives up after 20 retries, throws the rename error and removes its tmp file', () => {
  const dir = tmp();
  try {
    const s = sampleState();
    saveState(dir, s);
    let calls = 0;
    let waits = 0;
    const rename = () => {
      calls += 1;
      throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
    };
    assert.throws(() => saveState(dir, addRound(s, { n: 2, fromHead: 'x', toHead: 'y', contentHashAtToHead: 'h', items: [] }), { rename, sleep: () => { waits += 1; } }), /still locked/);
    assert.equal(calls, 21, 'first try plus 20 retries');
    assert.equal(waits, 20);
    assert.deepEqual(readdirSync(join(dir, '.review')), ['state.json']);
    assert.deepEqual(loadState(dir), s, 'old state intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState does not retry an error that is not a transient lock', () => {
  const dir = tmp();
  try {
    let calls = 0;
    const rename = () => {
      calls += 1;
      throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    };
    assert.throws(() => saveState(dir, sampleState(), { rename, sleep: () => assert.fail('must not wait') }), /disk gone/);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState removes stray state.json.*.tmp files older than an hour, and only those', () => {
  const dir = tmp();
  try {
    const rd = join(dir, '.review');
    mkdirSync(rd);
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    const put = (name, when) => {
      writeFileSync(join(rd, name), 'x');
      utimesSync(join(rd, name), when, when);
    };
    put('state.json.111.aaaa.tmp', old);
    put('state.json.222.bbbb.tmp', recent);
    put('other.tmp', old);
    put('notes.txt', old);
    writeFileSync(join(rd, 'state.json'), JSON.stringify({ pr: 1, rounds: [] }));
    utimesSync(join(rd, 'state.json'), old, old);
    assert.deepEqual(loadState(dir), { pr: 1, rounds: [] });
    assert.equal(existsSync(join(rd, 'state.json.111.aaaa.tmp')), false, 'old stray tmp removed');
    assert.equal(existsSync(join(rd, 'state.json.222.bbbb.tmp')), true, 'recent tmp may be a live write');
    assert.equal(existsSync(join(rd, 'other.tmp')), true);
    assert.equal(existsSync(join(rd, 'notes.txt')), true);
    assert.equal(existsSync(join(rd, 'state.json')), true, 'the state itself is never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState cleans stray tmp files even when there is no state.json yet', () => {
  const dir = tmp();
  try {
    const rd = join(dir, '.review');
    mkdirSync(rd);
    writeFileSync(join(rd, 'state.json.9.cccc.tmp'), 'x');
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(join(rd, 'state.json.9.cccc.tmp'), old, old);
    assert.equal(loadState(dir), null);
    assert.deepEqual(readdirSync(rd), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- review replay helpers ------------------------------------------------------------------------

import { decidedItemsKey, followupsPending, stateExtends } from '../pipeline/lib/review-context.mjs';

const fu = (id, over = {}) => it(id, { final: { decision: 'FOLLOW-UP', by: 'judge', needsHuman: false, reason: 'later' }, ...over });
const withItems = (...items) => addRound(emptyState({ repo: 'x/y', pr: 3, branch: 'b' }), { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items });

test('followupsPending: a ready FOLLOW-UP without an issue; not a held, filed, or other decision', () => {
  assert.equal(followupsPending(withItems(fu('R1-W1'))), true);
  assert.equal(followupsPending(withItems(fu('R1-W1', { followupIssue: 'https://x.test/1' }))), false);
  assert.equal(followupsPending(withItems(fu('R1-W1', { final: { decision: 'FOLLOW-UP', needsHuman: true } }))), false);
  assert.equal(followupsPending(withItems(it('R1-B1', { final: { decision: 'ACCEPT', needsHuman: false } }))), false);
  assert.equal(followupsPending(withItems(it('R1-B1'))), false, 'undecided');
  assert.equal(followupsPending(emptyState({ repo: 'x/y', pr: 3, branch: 'b' })), false);
  const two = addRound(withItems(fu('R1-W1', { followupIssue: 'u' })), { n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [fu('R2-W1')] });
  assert.equal(followupsPending(two), true, 'any round counts');
});

test('stateExtends: equal and extra trailing rounds extend; any change to a published round does not', () => {
  const pub = withItems(it('R1-B1', { final: { decision: 'ACCEPT', needsHuman: false } }), it('R1-S1'));
  assert.equal(stateExtends(structuredClone(pub), pub), true);
  const more = addRound(structuredClone(pub), { n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [it('R2-B1')] });
  assert.equal(stateExtends(more, pub), true);
  assert.equal(stateExtends(pub, more), false, 'local lacking a published round');

  const edit = (fn) => { const s = structuredClone(pub); fn(s.rounds[0]); return s; };
  for (const fn of [
    (r) => { r.toHead = 'z'; },
    (r) => { r.contentHashAtToHead = 'z'; },
    (r) => { r.items[0].final.decision = 'REJECT'; },
    (r) => { r.items[0].implemented = true; },
    (r) => { r.items[1].followupIssue = 'https://x.test/1'; },
    (r) => { r.items[1].judge = { decision: 'REJECT' }; },
    (r) => { r.items[1].arbiter = { ruling: 'ACCEPT' }; },
    (r) => { r.items[1].fingerprint = 'other'; },
    (r) => { r.items.pop(); },
  ]) assert.equal(stateExtends(edit(fn), pub), false, fn.toString());
  // fields outside the decided set (titles, detail) and key order do not matter
  assert.equal(stateExtends(edit((r) => { r.items[0].title = 'reworded'; r.items[0].final = { reason: undefined, ...r.items[0].final }; }), pub), true);
  assert.equal(decidedItemsKey({ items: [{ id: 'a', final: { x: 1, y: 2 } }] }), decidedItemsKey({ items: [{ final: { y: 2, x: 1 }, id: 'a' }] }));
});

test('addRound keeps resolutionOnly with its conflicted paths, count and blocks; a normal round carries none of them', () => {
  const s0 = emptyState({ repo: 'ianjamila/x', pr: 12, branch: 'agent/x', risk: 'low', lightLane: true, maxRounds: 3 });
  const blocks = [{ path: 'a.js', block: 1, droppedTheirs: 2 }];
  const s1 = addRound(s0, {
    n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [], reviewBase: 'tree', reviewBaseKind: 'resolution',
    resolutionOnly: true, conflicted: ['a.js'], conflictedCount: 3, blocks,
  });
  const r = s1.rounds[0];
  assert.deepEqual([r.resolutionOnly, r.conflicted, r.conflictedCount, r.blocks], [true, ['a.js'], 3, blocks]);
  blocks[0].droppedTheirs = 99;
  assert.equal(s1.rounds[0].blocks[0].droppedTheirs, 2, 'copied, not shared');
  const plain = addRound(s0, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [], conflicted: ['x'], resolutionOnly: false });
  for (const k of ['resolutionOnly', 'conflicted', 'conflictedCount', 'blocks']) assert.equal(Object.hasOwn(plain.rounds[0], k), false, k);
});

test('a resolution-only round survives save / load and the published-comment round trip; an old state reads as not resolutionOnly', () => {
  const dir = tmp();
  try {
    let s = emptyState({ repo: 'ianjamila/x', pr: 12, branch: 'agent/x', risk: 'low', lightLane: true, maxRounds: 3 });
    s = addRound(s, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [] });
    s = addRound(s, {
      n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [], reviewBase: 'tree', reviewBaseKind: 'resolution', forkPoint: 'f',
      resolutionOnly: true, conflicted: ['a b.js', 'c\nd.js'], conflictedCount: 2, blocks: [{ path: 'a b.js', block: 1, droppedTheirs: 0 }],
    });
    saveState(dir, s);
    assert.deepEqual(loadState(dir), s);
    const back = decodeFromComment(encodeForComment(s));
    assert.deepEqual(back, s);
    assert.equal(back.rounds[0].resolutionOnly, undefined, 'old rounds are not resolutionOnly');
    assert.deepEqual(back.rounds[1].conflicted, ['a b.js', 'c\nd.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addRound persists promptSha256; it survives save, comment encode/decode and load; a state without it still loads', () => {
  const sha = 'ab'.repeat(32);
  const withSha = addRound(emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'low' }), {
    n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [], promptSha256: sha,
  });
  assert.equal(withSha.rounds[0].promptSha256, sha);
  assert.equal(decodeFromComment(encodeForComment(withSha)).rounds[0].promptSha256, sha);
  const dir = tmp();
  try {
    saveState(dir, withSha);
    assert.equal(loadState(dir).rounds[0].promptSha256, sha);

    // an old state (no field) loads unchanged, and addRound does not invent one
    const old = sampleState();
    assert.equal(Object.hasOwn(old.rounds[0], 'promptSha256'), false);
    saveState(dir, old);
    assert.deepEqual(loadState(dir), old);
    assert.deepEqual(decodeFromComment(encodeForComment(old)), old);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- cp #256: substitute rounds, state version 4, maxRisk -------------------------------------------------------------------

const subRound = (over = {}) => ({
  n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [], firstReviewer: 'substitute',
  substitute: { agent: 'substitute-opus', models: ['claude-opus-4-8'], reason: 'quota', resetAt: null }, ...over,
});

test('addRound keeps the substitute fields (firstReviewer, substitute, wholePr, reviewBase, patchSha256, risk, governor, budget); a plain round carries none', () => {
  const s0 = emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'medium' });
  const full = addRound(s0, subRound({
    wholePr: true, reviewBase: 'fork', reviewBaseKind: 'merge-base', patchSha256: 'cd'.repeat(32), risk: 'high',
    governor: { usedPct: 93, threshold: 'hard' }, budget: { used: 6, budget: 6 },
  })).rounds[0];
  assert.equal(full.firstReviewer, 'substitute');
  assert.deepEqual(full.substitute, { agent: 'substitute-opus', models: ['claude-opus-4-8'], reason: 'quota', resetAt: null });
  assert.deepEqual([full.wholePr, full.reviewBase, full.patchSha256, full.risk], [true, 'fork', 'cd'.repeat(32), 'high']);
  assert.deepEqual(full.governor, { usedPct: 93, threshold: 'hard' });
  assert.deepEqual(full.budget, { used: 6, budget: 6 });
  const plain = addRound(s0, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [], wholePr: false }).rounds[0];
  for (const k of ['firstReviewer', 'substitute', 'wholePr', 'patchSha256', 'risk', 'governor', 'budget']) assert.equal(Object.hasOwn(plain, k), false, k);
  const input = { agent: 'substitute-opus' };
  const copied = addRound(s0, subRound({ substitute: input })).rounds[0];
  input.agent = 'changed';
  assert.equal(copied.substitute.agent, 'substitute-opus', 'copied, not shared');
});

test('state version 4: a substitute round, a substitute second review, a governor or a budget decision save as 4; a plain state stays as it was', () => {
  assert.equal(STATE_VERSION_SUBSTITUTE, 4);
  assert.ok(STATE_VERSION_SUBSTITUTE > STATE_VERSION_DEFERRAL, 'a reader from before this change (supports up to the deferral version) refuses it');
  const s0 = emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'low' });
  const plain = addRound(s0, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [] });
  assert.equal(plain.version, 1);
  assert.equal(addRound(s0, subRound()).version, 4);
  assert.equal(addRound(s0, subRound({ substitute: undefined, firstReviewer: undefined, governor: { usedPct: 91, threshold: 'hard' } })).version, 4, 'governor');
  assert.equal(addRound(s0, subRound({ substitute: undefined, firstReviewer: undefined, budget: { used: 7, budget: 6 } })).version, 4, 'budget');
  // a later writer keeps the higher version
  assert.equal(addRound({ ...addRound(s0, subRound()), version: 3 }, { n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [] }).version, 4);
  assert.equal(withStateVersion(addRound(s0, subRound()), 2).version, 4);
  // a substitute second review lands through updateItems
  const withItem = addRound(s0, { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'h', items: [it('R1-B1')] });
  assert.equal(updateItems(withItem, 1, [it('R1-B1', { secondReview: { by: 'substitute-opus', decision: 'REJECT' } })]).version, 4);
  assert.equal(updateItems(withItem, 1, [it('R1-B1', { secondReview: { by: 'codex', decision: 'REJECT' } })]).version, 1);
});

test('state version 4 is what is SAVED and PUBLISHED: saveState and encodeForComment raise a state that holds a substitute round, and a state above the supported version is refused', () => {
  const dir = tmp();
  try {
    const s = addRound(emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'low' }), subRound());
    const stale = { ...s, version: 1 }; // a writer that rebuilt the state from an old copy
    saveState(dir, stale);
    assert.equal(loadState(dir).version, 4);
    assert.equal(decodeFromComment(encodeForComment(stale)).version, 4);
    saveState(dir, { ...s, version: SUPPORTED_STATE_VERSION + 1 });
    assert.throws(() => loadState(dir), /version 7.*supports.*6/);
    assert.equal(decodeFromComment(encodeForComment({ ...s, version: SUPPORTED_STATE_VERSION + 1 })), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- #374: the state version for the out-of-model semantics (N1 / F4) and round.trustedConfigSha ------------------------------------------------------

test('addRound persists trustedConfigSha (a sha, or null for "pinned unavailable") and a plain round carries none; it survives save / load / comment round trip', () => {
  const base = emptyState({ repo: 'a/b', pr: 7, branch: 'x' });
  const round = { n: 1, fromHead: 'a', toHead: 'b', contentHashAtToHead: 'c', items: [] };
  assert.equal(Object.hasOwn(addRound(base, round).rounds[0], 'trustedConfigSha'), false);
  const withSha = addRound(base, { ...round, trustedConfigSha: 'f'.repeat(40) });
  assert.equal(withSha.rounds[0].trustedConfigSha, 'f'.repeat(40));
  const pinnedNull = addRound(base, { ...round, trustedConfigSha: null });
  assert.equal(pinnedNull.rounds[0].trustedConfigSha, null, 'null is a pinned "unavailable", not "absent"');
  const dir = tmp();
  try {
    saveState(dir, withSha);
    assert.deepEqual(loadState(dir), withSha);
    assert.deepEqual(decodeFromComment(encodeForComment(withSha)), withSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maxRisk only goes up: a smaller diff never lowers it, and a legacy state starts it from what it recorded (fail toward high)', () => {
  const add = (s, n, risk) => addRound(s, { n, fromHead: 'a', toHead: 'b', contentHashAtToHead: `h${n}`, items: [], ...(risk ? { risk } : {}) });
  let s = emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'medium' });
  s = add(s, 1, 'medium');
  assert.equal(s.maxRisk, 'medium');
  s = add({ ...s, risk: 'high' }, 2, 'high');
  assert.equal(s.maxRisk, 'high');
  s = add({ ...s, risk: 'low' }, 3, 'low'); // the diff shrank: state.risk is shown as-is, maxRisk stays
  assert.equal(s.maxRisk, 'high');
  assert.equal(s.rounds.map((r) => r.risk).join(), 'medium,high,low');
  // R4-14: legacy states (no maxRisk)
  assert.equal(maxRiskOf({ risk: 'medium', rounds: [] }), 'medium');
  assert.equal(maxRiskOf({ risk: 'low', rounds: [{ risk: 'high' }, { risk: 'low' }] }), 'high', 'the highest recorded round risk counts');
  assert.equal(maxRiskOf({ risk: null, rounds: [{ n: 1 }] }), 'high', 'nothing readable: fail toward high');
  assert.equal(maxRiskOf({ risk: 'weird', maxRisk: 7, rounds: [] }), 'high');
  assert.equal(maxRiskOf({ risk: 'low', maxRisk: 'high', rounds: [] }), 'high');
  assert.equal(maxRiskOf(null), 'high');
  // a legacy state gains maxRisk on its next round, from what it recorded
  const legacy = { ...emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'high' }) };
  assert.equal(add({ ...legacy, rounds: [{ n: 1, items: [] }] }, 2, 'low').maxRisk, 'high', 'state.risk high is read');
  assert.equal(add({ repo: 'o/r', pr: 3, rounds: [{ n: 1, items: [] }] }, 2, 'low').maxRisk, 'high', 'an earlier round with nothing readable: high');
});

test('N1/F4: stateNeedsOutOfModelVersion is true only when a final carries outOfModel; withStateVersion then lifts the state to the next version', () => {
  const plain = sampleState();
  assert.equal(stateNeedsOutOfModelVersion(plain), false);
  assert.equal(plain.version, 1, 'an ordinary state stays at version 1 (readable by every old CLI)');
  const marked = updateItems(plain, 1, [it('R1-S1', { final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'r', outOfModel: 'guards' } })]);
  assert.equal(stateNeedsOutOfModelVersion(marked), true);
  const bumped = withStateVersion(marked, STATE_VERSION_OUT_OF_MODEL);
  assert.equal(bumped.version, STATE_VERSION_OUT_OF_MODEL);
  assert.equal(SUPPORTED_STATE_VERSION, STATE_VERSION_POST_MAX);
  assert.ok(STATE_VERSION_OUT_OF_MODEL > STATE_VERSION_SUBSTITUTE, 'above the substitute version an installation from before this change supports');
  assert.equal(stateNeedsOutOfModelVersion({ rounds: [{ items: [{ final: { outOfModel: '' } }] }] }), false, 'an empty marker is no marker');
  assert.equal(stateNeedsOutOfModelVersion(null), false);
});

test('N1/F4: a state carrying BOTH substitute data and an out-of-model final is written as version 5 (the highest any feature needs), and a substitute-only state stays 4', () => {
  const dir = tmp();
  try {
    const s0 = emptyState({ repo: 'o/r', pr: 3, branch: 'b', risk: 'low' });
    const subOnly = addRound(s0, subRound({ items: [it('R1-S1', { bucket: 'SUGGESTION' })] }));
    assert.equal(subOnly.version, STATE_VERSION_SUBSTITUTE);
    const both = updateItems(subOnly, 1, [it('R1-S1', { bucket: 'SUGGESTION', final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'r', outOfModel: 'guards' } })]);
    assert.equal(both.version, STATE_VERSION_OUT_OF_MODEL);
    assert.equal(both.rounds[0].firstReviewer, 'substitute');
    const stale = { ...both, version: 1 }; // a writer that rebuilt the state from an old copy
    saveState(dir, stale);
    assert.equal(loadState(dir).version, STATE_VERSION_OUT_OF_MODEL);
    assert.equal(decodeFromComment(encodeForComment(stale)).version, STATE_VERSION_OUT_OF_MODEL);
    // a later round on the version-5 state keeps 5
    assert.equal(addRound(both, { n: 2, fromHead: 'b', toHead: 'c', contentHashAtToHead: 'h2', items: [] }).version, STATE_VERSION_OUT_OF_MODEL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N1: an old reader (the pre-#374 loadState rule: refuse a version above 4, the substitute version) refuses a state holding an outOfModel final, and its unfiled FOLLOW-UP is never read as complete', () => {
  // A fixture of the pre-change reader: state.mjs#newerThanSupported with SUPPORTED_STATE_VERSION 4, as installed CLIs still have it.
  const OLD_SUPPORTED = 4;
  const oldReaderRefuses = (state) => Number.isFinite(state.version) && state.version > OLD_SUPPORTED;
  const plain = sampleState();
  assert.equal(oldReaderRefuses(plain), false, 'a plain state round-trips through an old reader');
  const marked = withStateVersion(updateItems(plain, 1, [it('R1-S1', { bucket: 'SUGGESTION', final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'r', outOfModel: 'guards' } })]), STATE_VERSION_OUT_OF_MODEL);
  assert.equal(oldReaderRefuses(marked), true, 'the old reader never gets as far as reading the unfiled FOLLOW-UP');
  const dir = tmp();
  try {
    saveState(dir, plain);
    assert.deepEqual(loadState(dir), plain, 'a plain state round-trips unchanged');
    saveState(dir, marked);
    assert.deepEqual(loadState(dir), marked, 'the new reader loads it');
    // The new reader's own refusal rule is unchanged: one version up is refused.
    saveState(dir, { ...marked, version: SUPPORTED_STATE_VERSION + 1 });
    assert.throws(() => loadState(dir), /newer pipeline wrote it/);
    assert.equal(decodeFromComment(encodeForComment({ ...marked, version: SUPPORTED_STATE_VERSION + 1 })), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F4 (PR B): the state version is bumped to 6 ONLY when a final carries postMax; a plain state and an out-of-model one keep their versions and round-trip unchanged', () => {
  const plain = sampleState();
  assert.equal(stateNeedsPostMaxVersion(plain), false);
  assert.equal(plain.version, 1);
  const postMax = { from: 'ACCEPT', by: 'arbiter', ordinal: 5, max: 3 };
  const marked = updateItems(plain, 1, [it('R1-S1', { bucket: 'SUGGESTION', final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'r', postMax } })]);
  assert.equal(stateNeedsPostMaxVersion(marked), true);
  assert.equal(marked.version, STATE_VERSION_POST_MAX, 'updateItems writes the version the state needs');
  const oom = updateItems(plain, 1, [it('R1-S1', { bucket: 'SUGGESTION', final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'r', outOfModel: 'guards' } })]);
  assert.equal(oom.version, STATE_VERSION_OUT_OF_MODEL, 'an out-of-model state stays at 5');
  assert.equal(stateNeedsPostMaxVersion({ rounds: [{ items: [{ final: { postMax: null } }] }] }), false);
  assert.equal(stateNeedsPostMaxVersion(null), false);
  // an old reader (the version-5 rule of the installed #374 PR A CLI) refuses the new state instead of reading the unfiled FOLLOW-UP as complete
  const refusesAt5 = (state) => Number.isFinite(state.version) && state.version > 5;
  assert.equal(refusesAt5(marked), true);
  assert.equal(refusesAt5(oom), false);
  assert.equal(refusesAt5(plain), false);
  const dir = tmp();
  try {
    saveState(dir, plain);
    assert.deepEqual(loadState(dir), plain, 'a plain state round-trips unchanged');
    saveState(dir, { ...marked, version: 1 });
    assert.equal(loadState(dir).version, STATE_VERSION_POST_MAX, 'a stale writer is lifted back');
    assert.equal(decodeFromComment(encodeForComment({ ...marked, version: 1 })).version, STATE_VERSION_POST_MAX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
