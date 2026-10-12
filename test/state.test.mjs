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
