import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { MARKERS } from '../pipeline/lib/render.mjs';
import {
  OUTCOMES, OUTCOME_NEXT, OUTCOME_STEP, RECORD_VERSION, STEPS, STATUS_END, STATUS_START, LIMITS,
  applyCheckpoint, bindRecord, decodeRecord, emptyRecord, encodeRecord, outcomeNext, recordForOutcome, renderStatusBlock,
} from '../pipeline/lib/run-record.mjs';

const ID = { repo: 'acme/widgets', pr: 7, branch: 'feat/x', baseRef: 'main' };
const NOW = Date.UTC(2026, 9, 12, 8, 30, 0);
const CTX = { host: 'pc-1', now: NOW };
const withMarker = (rec) => `${MARKERS.summary}\n\nsections\n\n${encodeRecord(rec)}`;
const rawMarker = (value) => `<!-- claude-pipeline:record:${gzipSync(Buffer.from(JSON.stringify(value))).toString('base64')} -->`;

test('every outcome has a step, a next line, and a known step', () => {
  assert.deepEqual(Object.keys(OUTCOME_STEP).sort(), [...OUTCOMES].sort());
  assert.deepEqual(Object.keys(OUTCOME_NEXT).sort(), [...OUTCOMES].sort());
  for (const o of OUTCOMES) assert.ok(STEPS.includes(OUTCOME_STEP[o]), o);
  assert.equal(OUTCOME_STEP['awaiting-owner-merge'], 'awaiting-owner-merge');
  // prod-unknown: prod-watch never learned the result, so the merged run stays in its prod-watch step (stranded, resumable).
  assert.deepEqual(OUTCOMES.filter((o) => OUTCOME_STEP[o] !== 'ended'), ['awaiting-owner-merge', 'prod-unknown']);
  assert.equal(OUTCOME_STEP['prod-unknown'], 'prod-watch');
});

test('every `P summary` outcome word the owner push knows is a record outcome too (else the record would stay "running")', async () => {
  const { OUTCOME_EVENTS } = await import('../pipeline/lib/notify.mjs');
  for (const w of Object.keys(OUTCOME_EVENTS)) assert.ok(OUTCOMES.includes(w), w);
});

for (const outcome of [null, ...OUTCOMES]) {
  test(`round trip: outcome ${outcome}`, () => {
    const rec = { ...emptyRecord(ID), outcome, step: outcome ? OUTCOME_STEP[outcome] : 'review', head: 'a'.repeat(40) };
    const r = decodeRecord(withMarker(rec));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.record, rec);
  });
}

test('the encoded marker is one HTML comment that cannot close early', () => {
  const m = encodeRecord(emptyRecord(ID));
  assert.match(m, /^<!-- claude-pipeline:record:[A-Za-z0-9+/=]+ -->$/);
  assert.ok(!m.slice(4, -4).includes('--'));
});

test('the LAST record marker wins (a quoted or forged one earlier does not)', () => {
  const forged = { ...emptyRecord(ID), step: 'merge' };
  const real = { ...emptyRecord(ID), step: 'review' };
  const body = `${MARKERS.summary}\n${encodeRecord(forged)}\ntext\n${encodeRecord(real)}`;
  assert.equal(decodeRecord(body).record.step, 'review');
});

test('a last marker that is garbage is invalid even when an earlier one is fine', () => {
  const body = `${withMarker(emptyRecord(ID))}\n<!-- claude-pipeline:record:AAAA -->`;
  assert.equal(decodeRecord(body).status, 'invalid');
});

test('a body that does not START with the summary marker is absent, record or not', () => {
  assert.equal(decodeRecord(`quoting ${MARKERS.summary}\n${encodeRecord(emptyRecord(ID))}`).status, 'absent');
  assert.equal(decodeRecord('hello').status, 'absent');
  assert.equal(decodeRecord(undefined).status, 'absent');
  assert.equal(decodeRecord(null).status, 'absent');
});

test('legacy: a summary comment from before records has the marker and no record', () => {
  assert.deepEqual(decodeRecord(`${MARKERS.summary}\n\n### Outcome\n\n**merged**`), { status: 'legacy' });
});

test('garbage never throws and reads as invalid', () => {
  for (const junk of [
    '<!-- claude-pipeline:record:!!!! -->', // not matched at all -> legacy
    '<!-- claude-pipeline:record:AAAA -->',
    `<!-- claude-pipeline:record:${Buffer.from('not gzip').toString('base64')} -->`,
    rawMarker('a string'),
    rawMarker([1, 2]),
    rawMarker(null),
  ]) {
    const r = decodeRecord(`${MARKERS.summary}\n${junk}`);
    assert.ok(['invalid', 'legacy'].includes(r.status), `${junk} -> ${r.status}`);
    assert.equal(r.record, undefined);
  }
});

test('oversize payload (decompresses past the cap) is invalid, not an allocation', () => {
  const big = rawMarker({ ...emptyRecord(ID), detail: 'a'.repeat(2 * 1024 * 1024) });
  assert.equal(decodeRecord(`${MARKERS.summary}\n${big}`).status, 'invalid');
});

test('v > RECORD_VERSION is unsupported, v 0 / missing is invalid', () => {
  assert.equal(decodeRecord(`${MARKERS.summary}\n${rawMarker({ ...emptyRecord(ID), v: RECORD_VERSION + 1 })}`).status, 'unsupported');
  assert.equal(decodeRecord(`${MARKERS.summary}\n${rawMarker({ ...emptyRecord(ID), v: 0 })}`).status, 'invalid');
  const { v, ...noV } = emptyRecord(ID);
  assert.equal(decodeRecord(`${MARKERS.summary}\n${rawMarker(noV)}`).status, 'invalid');
});

test('shape validation: pr, step, outcome, lists', () => {
  for (const bad of [
    { pr: 0 }, { pr: 1.5 }, { pr: '7' }, { step: 'dancing' }, { outcome: 'great' }, { outcome: undefined },
    { tasks: 'x' }, { history: {} }, { inFlight: 'now' },
  ]) {
    const rec = { ...emptyRecord(ID), ...bad };
    if ('outcome' in bad && bad.outcome === undefined) delete rec.outcome;
    assert.equal(decodeRecord(`${MARKERS.summary}\n${rawMarker(rec)}`).status, 'invalid', JSON.stringify(bad));
  }
});

test('shape validation: a bad task or history entry makes the record invalid, never a throw downstream', () => {
  const ok = { id: 'T1', title: 't', spec: 's', done: false };
  for (const bad of [
    { tasks: [null] }, { tasks: ['x'] }, { tasks: [[]] }, { tasks: [{ title: 'no id' }] }, { tasks: [{ ...ok, id: 7 }] },
    { tasks: [{ ...ok, id: 'x'.repeat(65) }] }, { tasks: [{ ...ok, id: '' }] }, { tasks: [{ ...ok, done: 'yes' }] },
    { tasks: [ok, null] }, { history: ['x'] }, { history: [null] }, { history: [[]] },
  ]) {
    const rec = { ...emptyRecord(ID), ...bad };
    const decoded = decodeRecord(`${MARKERS.summary}\n${rawMarker(rec)}`);
    assert.equal(decoded.status, 'invalid', JSON.stringify(bad));
    assert.equal(decoded.record, undefined);
  }
  // good ones: `done` may be absent, ids may be exactly 64 characters
  const good = { ...emptyRecord(ID), tasks: [{ id: 'x'.repeat(64), title: 't', spec: 's' }, ok], history: [{ step: 'build', head: null, host: 'h', at: 'now' }] };
  assert.equal(decodeRecord(`${MARKERS.summary}\n${rawMarker(good)}`).status, 'ok');
  // a task id the codec would later refuse is refused up front
  assert.throws(() => applyCheckpoint(emptyRecord(ID), { tasks: [{ id: 'x'.repeat(65), title: 't' }] }, CTX), /task id/);
});

test('bindRecord: names every mismatch, ignores head and an unspecified live value', () => {
  const rec = { ...emptyRecord(ID), head: 'old' };
  assert.deepEqual(bindRecord(rec, { repo: 'acme/widgets', pr: 7, branch: 'feat/x' }), []);
  assert.deepEqual(bindRecord(rec, { repo: 'acme/widgets', pr: 7 }), []);
  const reasons = bindRecord(rec, { repo: 'acme/other', pr: 8, branch: 'feat/y' });
  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /^repo/);
  assert.match(reasons[1], /^pr/);
  assert.match(reasons[2], /^branch/);
});

test('applyCheckpoint: heartbeat, history, no mutation of the input', () => {
  const rec = emptyRecord(ID);
  const before = JSON.stringify(rec);
  const next = applyCheckpoint(rec, { step: 'verify', head: 'abc1234567', next: 'run verify', round: 1 }, CTX);
  assert.equal(JSON.stringify(rec), before);
  assert.deepEqual(next.heartbeat, { host: 'pc-1', at: '2026-10-12T08:30:00.000Z' });
  assert.deepEqual(next.history, [{ step: 'verify', head: 'abc1234567', host: 'pc-1', at: '2026-10-12T08:30:00.000Z' }]);
  assert.deepEqual([next.step, next.next, next.round], ['verify', 'run verify', 1]);
  assert.equal(applyCheckpoint(rec, {}, { host: 'h', now: new Date(NOW) }).heartbeat.at, '2026-10-12T08:30:00.000Z');
});

test('applyCheckpoint: resumed is stamped by a patch, normalised, and never cleared by a later one; it survives the codec', () => {
  const resumed = { at: '2026-10-12T08:00:00.000Z', host: 'pc-2', head: 'a'.repeat(40) };
  const a = applyCheckpoint(emptyRecord(ID), { step: 'review', resumed }, CTX);
  assert.deepEqual(a.resumed, resumed);
  const b = applyCheckpoint(a, { step: 'gate' }, CTX);
  assert.deepEqual(b.resumed, resumed);
  assert.deepEqual(applyCheckpoint(a, { resumed: null }, CTX).resumed, resumed, 'null cannot clear it');
  assert.throws(() => applyCheckpoint(emptyRecord(ID), { resumed: 'yes' }, CTX), /resumed/);
  const body = `${MARKERS.summary}\n\n${encodeRecord(b)}`;
  assert.deepEqual(decodeRecord(body).record.resumed, resumed);
});

test('applyCheckpoint: history keeps the newest 20', () => {
  let rec = emptyRecord(ID);
  for (let i = 0; i < 25; i += 1) rec = applyCheckpoint(rec, { head: `h${i}` }, { host: 'x', now: NOW + i });
  assert.equal(rec.history.length, LIMITS.history);
  assert.equal(rec.history[0].head, 'h5');
  assert.equal(rec.history.at(-1).head, 'h24');
});

test('applyCheckpoint: request <= 2048 chars, task spec <= 1024, by code point', () => {
  const long = applyCheckpoint(emptyRecord(ID), {
    request: 'r'.repeat(5000),
    tasks: [{ id: 'T1', title: 'one', spec: '😀'.repeat(3000) }],
  }, CTX);
  assert.ok(Array.from(long.request).length <= 2048);
  assert.ok(Array.from(long.tasks[0].spec).length <= 1024);
  assert.ok(!long.tasks[0].spec.includes('�'));
});

test('applyCheckpoint: tasks replace the list, keep done for omitted flags, done marks ids', () => {
  let rec = applyCheckpoint(emptyRecord(ID), { tasks: [{ id: 'T1', title: 'a', spec: 's1' }, { id: 'T2', title: 'b', spec: 's2' }] }, CTX);
  assert.deepEqual(rec.tasks.map((t) => t.done), [false, false]);
  rec = applyCheckpoint(rec, { done: ['T1'] }, CTX);
  assert.deepEqual(rec.tasks.map((t) => t.done), [true, false]);
  rec = applyCheckpoint(rec, { tasks: [{ id: 'T1', title: 'a2' }, { id: 'T3', title: 'c', spec: 's3' }] }, CTX);
  assert.deepEqual(rec.tasks, [
    { id: 'T1', title: 'a2', spec: 's1', done: true },
    { id: 'T3', title: 'c', spec: 's3', done: false },
  ]);
  assert.throws(() => applyCheckpoint(rec, { done: ['T9'] }, CTX), /unknown task id/);
  assert.throws(() => applyCheckpoint(rec, { tasks: [{ title: 'no id' }] }, CTX), /id/);
});

test('applyCheckpoint: rejects an unknown step / outcome, sets and clears inFlight', () => {
  const rec = emptyRecord(ID);
  assert.throws(() => applyCheckpoint(rec, { step: 'dancing' }, CTX), /unknown step/);
  assert.throws(() => applyCheckpoint(rec, { outcome: 'great' }, CTX), /unknown outcome/);
  const busy = applyCheckpoint(rec, { inFlight: { kind: 'merge', host: 'pc-1', startedAt: '2026-10-12T08:00:00Z', maxMinutes: 10 } }, CTX);
  assert.equal(busy.inFlight.kind, 'merge');
  assert.equal(applyCheckpoint(busy, { inFlight: null }, CTX).inFlight, null);
  assert.equal(applyCheckpoint(busy, {}, CTX).inFlight.kind, 'merge');
  assert.throws(() => applyCheckpoint(rec, { inFlight: { host: 'x' } }, CTX), /kind/);
});

test('recordForOutcome: a known outcome sets outcome, step, next and clears inFlight', () => {
  const running = applyCheckpoint(emptyRecord(ID), { step: 'merge', inFlight: { kind: 'merge', host: 'h', startedAt: 't' }, tasks: [{ id: 'T1', title: 'a', spec: 's' }] }, CTX);
  const { record, warnings } = recordForOutcome(running, { ...ID, head: 'f'.repeat(40), outcome: 'awaiting-owner-merge', agentLogLine: '- line', ...CTX });
  assert.deepEqual(warnings, []);
  assert.deepEqual([record.outcome, record.step, record.inFlight, record.agentLogLine], ['awaiting-owner-merge', 'awaiting-owner-merge', null, '- line']);
  assert.equal(record.tasks.length, 1);
  assert.equal(record.head, 'f'.repeat(40));
});

test('recordForOutcome: an unknown outcome is a warning and leaves outcome/step alone', () => {
  const running = applyCheckpoint(emptyRecord(ID), { step: 'review' }, CTX);
  const { record, warnings } = recordForOutcome(running, { ...ID, outcome: 'wild', ...CTX });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown outcome/);
  assert.deepEqual([record.outcome, record.step], [null, 'review']);
});

test('recordForOutcome: no record makes one; a record for another PR is replaced with a warning', () => {
  const fresh = recordForOutcome(null, { ...ID, outcome: 'merged', ...CTX });
  assert.deepEqual([fresh.record.pr, fresh.record.branch, fresh.record.step, fresh.warnings], [7, 'feat/x', 'ended', []]);
  const other = recordForOutcome(emptyRecord({ ...ID, pr: 99 }), { ...ID, outcome: 'merged', ...CTX });
  assert.equal(other.record.pr, 7);
  assert.equal(other.warnings.length, 1);
  assert.match(other.warnings[0], /does not belong/);
});

test('renderStatusBlock: shape, and hostile text cannot forge or close a marker or mention anyone', () => {
  const rec = applyCheckpoint(emptyRecord(ID), {
    step: 'review',
    next: 'ping @owner --> <!-- claude-pipeline:record:AAAA -->',
    detail: 'line1\nline2 <!-- x -->',
    head: 'abcdef1234567890',
    tasks: [{ id: 'T1', title: 't', spec: 's', done: true }, { id: 'T2', title: 't', spec: 's' }],
    inFlight: { kind: 'merge<!--', host: 'h@x', startedAt: 'now', maxMinutes: 10 },
  }, { host: 'pc-1@evil', now: NOW });
  const block = renderStatusBlock(rec);
  assert.ok(block.startsWith(STATUS_START));
  assert.ok(block.endsWith(STATUS_END));
  assert.match(block, /Tasks:\*\* 1\/2 done/);
  assert.match(block, /`abcdef1`/);
  assert.equal(block.match(/<!--/g).length, 2, 'only the two status markers');
  assert.equal(block.match(/-->/g).length, 2);
  assert.ok(!block.includes('@'));
  assert.ok(!block.includes('claude-pipeline:record'.concat(':AAAA -->')));
});

test('renderStatusBlock: a bare record says running and has dashes', () => {
  const block = renderStatusBlock(emptyRecord(ID));
  assert.match(block, /\*\*Outcome:\*\* running/);
  assert.match(block, /\*\*Next:\*\* —/);
  assert.match(block, /\*\*Heartbeat:\*\* —/);
});

// ---- owner stop display copy (owner_approval: chat) -------------------------------------------------------------------

const STOP = { id: 'ab12cd34', cause: 'merge:command-failed', head: 'a'.repeat(40), at: '2026-10-20T08:00:00.000Z' };
const decodeOf = (rec, opts) => decodeRecord(`${MARKERS.summary}\n${rawMarker(rec)}`, opts);

test('ownerStop copy: applyCheckpoint sets it, later patches keep it, null clears it; v is 2 only while it is present', () => {
  const base = emptyRecord(ID);
  assert.equal(base.v, 1, 'a fresh record is readable by old CLIs');
  const stopped = applyCheckpoint(base, { ownerStop: STOP }, CTX);
  assert.deepEqual(stopped.ownerStop, STOP);
  assert.equal(stopped.v, 2);
  const later = applyCheckpoint(stopped, { step: 'review', round: 2, outcome: null }, CTX);
  assert.deepEqual(later.ownerStop, STOP, 'an ordinary patch keeps the copy (unknown keys survive the clone)');
  assert.equal(later.v, 2);
  const cleared = applyCheckpoint(later, { ownerStop: null }, CTX);
  assert.equal('ownerStop' in cleared, false);
  assert.equal(cleared.v, 1, 'back to 1 once the copy is gone');
  assert.equal(applyCheckpoint(base, { step: 'verify' }, CTX).v, 1, 'no copy, no event: v stays 1');
  // a record that says v 2 without a copy is brought back to 1 on the next write
  assert.equal(applyCheckpoint({ ...base, v: 2 }, { step: 'verify' }, CTX).v, 1);
});

test('ownerStop copy: normalised to {id, cause, head, at}; a malformed patch throws', () => {
  const r = applyCheckpoint(emptyRecord(ID), { ownerStop: { id: 'ab12cd34', at: STOP.at, extra: 'x' } }, CTX);
  assert.deepEqual(r.ownerStop, { id: 'ab12cd34', cause: null, head: null, at: STOP.at });
  for (const bad of ['ab12cd34', [], { ...STOP, id: 'nope' }, { ...STOP, id: 5 }, { ...STOP, cause: 'bad cause!' }, { ...STOP, cause: 7 }, { ...STOP, head: 5 }, { ...STOP, at: undefined }]) {
    assert.throws(() => applyCheckpoint(emptyRecord(ID), { ownerStop: bad }, CTX), /ownerStop/, JSON.stringify(bad));
  }
});

test('ownerStop copy: survives encode/decode; a malformed copy => invalid', () => {
  const rec = applyCheckpoint(emptyRecord(ID), { ownerStop: STOP }, CTX);
  const decoded = decodeRecord(withMarker(rec));
  assert.equal(decoded.status, 'ok');
  assert.deepEqual(decoded.record.ownerStop, STOP);
  for (const bad of ['x', [], 5, { ...STOP, id: '' }, { ...STOP, id: 'ZZZZZZZZ' }, { ...STOP, cause: 'a b' }, { ...STOP, head: 7 }, { ...STOP, at: null }, {}]) {
    assert.equal(decodeOf({ ...rec, ownerStop: bad }).status, 'invalid', JSON.stringify(bad));
  }
  assert.equal(decodeOf({ ...rec, ownerStop: { ...STOP, cause: null, head: null } }).status, 'ok', 'cause and head may be null');
});

test('rollout tripwire: an OLD CLI (max version 1) reads a record with an open stop as unsupported, an ordinary one as ok', () => {
  const stopped = applyCheckpoint(emptyRecord(ID), { ownerStop: STOP }, CTX);
  assert.equal(RECORD_VERSION, 2);
  assert.equal(decodeOf(stopped).status, 'ok', 'this CLI reads it');
  assert.equal(decodeOf(stopped, { maxVersion: 1 }).status, 'unsupported', 'the old CLI would refuse it and demand the owner\'s "merge"');
  assert.equal(decodeOf(applyCheckpoint(emptyRecord(ID), { step: 'verify' }, CTX), { maxVersion: 1 }).status, 'ok', 'ordinary records stay readable by old CLIs');
  assert.equal(decodeOf({ ...emptyRecord(ID), v: 3 }).status, 'unsupported');
});

test('outcomeNext: label mode (and no mode) is today\'s text for every outcome; chat only changes needs-human', () => {
  for (const o of OUTCOMES) {
    assert.equal(outcomeNext(o), OUTCOME_NEXT[o], o);
    assert.equal(outcomeNext(o, { ownerApproval: 'label', stop: STOP, pr: 7 }), OUTCOME_NEXT[o], `${o} label`);
    if (o !== 'needs-human') assert.equal(outcomeNext(o, { ownerApproval: 'chat', stop: STOP, pr: 7 }), OUTCOME_NEXT[o], `${o} chat`);
  }
  assert.equal(OUTCOME_NEXT['needs-human'], 'owner review: add `human-approved`, then merge', 'the label text is untouched');
  assert.equal(outcomeNext('needs-human', { ownerApproval: 'chat', stop: STOP, pr: 7 }), 'owner reply needed in chat (stop ab12cd34): ship resume 7');
  assert.equal(outcomeNext('needs-human', { ownerApproval: 'chat', pr: 7 }), 'owner reply needed in chat: ship resume 7');
  assert.equal(outcomeNext('needs-human', { ownerApproval: 'chat' }), 'owner reply needed in chat: ship resume N');
  assert.equal(outcomeNext('needs-human', { ownerApproval: 'weird', pr: 7 }), OUTCOME_NEXT['needs-human'], 'an unknown mode is label behaviour');
});

test('recordForOutcome: label mode writes no copy and stays v 1 (needs-human included); chat mode writes the chat text and the copy it is given', () => {
  const label = recordForOutcome(null, { ...ID, outcome: 'needs-human', ...CTX }).record;
  assert.deepEqual([label.v, label.next, 'ownerStop' in label], [1, OUTCOME_NEXT['needs-human'], false]);
  const labelWithStop = recordForOutcome(null, { ...ID, outcome: 'needs-human', ownerApproval: 'label', ownerStop: STOP, ...CTX }).record;
  assert.equal('ownerStop' in labelWithStop, false, 'label mode never records a stop');
  const chatNoStop = recordForOutcome(null, { ...ID, outcome: 'needs-human', ownerApproval: 'chat', ...CTX }).record;
  assert.deepEqual([chatNoStop.v, chatNoStop.outcome, chatNoStop.next, 'ownerStop' in chatNoStop], [1, 'needs-human', 'owner reply needed in chat: ship resume 7', false]);
  const chat = recordForOutcome(null, { ...ID, outcome: 'needs-human', ownerApproval: 'chat', ownerStop: STOP, ...CTX }).record;
  assert.deepEqual([chat.v, chat.next, chat.ownerStop], [2, 'owner reply needed in chat (stop ab12cd34): ship resume 7', STOP]);
});

test('recordForOutcome: a later outcome (stopped, merged...) neither clears nor sets the copy; only the event is the authority', () => {
  const stopped = applyCheckpoint(emptyRecord(ID), { ownerStop: STOP }, CTX);
  for (const ownerApproval of [undefined, 'label', 'chat']) {
    const after = recordForOutcome(stopped, { ...ID, outcome: 'stopped', ownerApproval, ...CTX }).record;
    assert.deepEqual([after.outcome, after.ownerStop, after.v], ['stopped', STOP, 2], String(ownerApproval));
  }
});

test('the status block shows the open stop only while the copy is present', () => {
  const plain = renderStatusBlock(emptyRecord(ID));
  assert.doesNotMatch(plain, /Owner stop/);
  const shown = renderStatusBlock(applyCheckpoint(emptyRecord(ID), { ownerStop: STOP }, CTX));
  assert.match(shown, /^- \*\*Owner stop:\*\* ab12cd34 \(merge:command-failed\)$/m);
  const noCause = renderStatusBlock(applyCheckpoint(emptyRecord(ID), { ownerStop: { ...STOP, cause: null } }, CTX));
  assert.match(noCause, /^- \*\*Owner stop:\*\* ab12cd34$/m);
});
