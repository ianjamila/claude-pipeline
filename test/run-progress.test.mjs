// R8-F4: the run recorder must never erase the merge gate's fail-closed state. An unreadable (invalid) record is replaced by one
// marked `resumed` (so `P merge` still needs the owner's word), a record from a newer CLI is never overwritten, and a write that
// started from a stale read carries over a `resumed` mark a concurrent checkpoint added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { applyCheckpoint, emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { readSummaryComment, writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { baseRecordFor, createRunRecorder, resumedRunState, writeRunRecord } from '../pipeline/lib/run-progress.mjs';
import { parseEvent, renderEvent } from '../pipeline/lib/run-events.mjs';

const PR = 4;
const HEAD = 'c'.repeat(40);
const ID = { repo: 'acme/widgets', pr: PR, branch: 'feat/x', baseRef: 'main' };
const NOW = Date.UTC(2026, 10, 13, 9, 0);
const RESUMED = { at: '2026-11-12T08:00:00.000Z', host: 'pc-2', head: 'a'.repeat(40) };

// A stateful stand-in for the github wrapper (viewer / listComments / upsertComment / prView / repo).
function memoryGh(initial = []) {
  const comments = [...initial];
  let next = 100;
  return {
    comments,
    viewer: () => 'me',
    listComments: () => comments.map((c) => ({ ...c })),
    upsertComment(pr, marker, body) {
      const found = comments.filter((c) => c.body.startsWith(marker) && c.user.login === 'me').sort((a, b) => a.id - b.id).at(-1);
      if (found) { found.body = body; return { id: found.id, url: `https://x/${found.id}`, action: 'updated' }; }
      next += 1;
      comments.push({ id: next, body, user: { login: 'me' }, html_url: `https://x/${next}` });
      return { id: next, url: `https://x/${next}`, action: 'created' };
    },
    prView: () => ({ headRefOid: HEAD, headRefName: ID.branch, baseRefName: ID.baseRef }),
    repo: () => ({ slug: ID.repo, host: 'github.com' }),
  };
}

const mineBody = (gh) => gh.comments.find((c) => c.user.login === 'me' && c.body.startsWith(MARKERS.summary))?.body;
const recorderFor = (gh) => createRunRecorder({ gh, pr: PR, host: 'pc-1', now: () => NOW });
const plain = () => applyCheckpoint(emptyRecord(ID), { step: 'review', head: HEAD }, { host: 'pc-1', now: NOW });
const resumedRecord = () => applyCheckpoint(plain(), { resumed: RESUMED }, { host: 'pc-2', now: NOW });
const seed = (gh, record) => writeSummaryComment(gh, PR, { record });
const INVALID_BODY = `${MARKERS.summary}\n\nsome text\n\n<!-- claude-pipeline:record:bm90LWpzb24= -->`;
const NEWER_BODY = () => `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord(ID), v: 999 })}`;

// ---- (a) invalid -> a fresh record that is still `resumed` ------------------------------------------------------------------------

test('baseRecordFor: an invalid record is replaced by a fresh one stamped resumed {at, host, head}, with the warning', () => {
  const { record, warnings } = baseRecordFor({ status: 'invalid' }, { ...ID, host: 'pc-1', now: NOW, head: HEAD });
  assert.deepEqual(record.resumed, { at: new Date(NOW).toISOString(), host: 'pc-1', head: HEAD });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be read[\s\S]*resumed/);
  assert.equal(baseRecordFor({ status: 'invalid' }, { ...ID, host: 'pc-1', now: NOW }).record.resumed.head, '', 'no head known -> empty');
});

test('baseRecordFor: an absent or legacy comment and a record of another PR stay ordinary (no resumed mark)', () => {
  for (const existing of [{ status: 'absent' }, { status: 'legacy' }]) assert.equal(baseRecordFor(existing, ID).record.resumed, undefined);
  const other = { status: 'ok', record: { ...plain(), pr: 99 } };
  assert.equal(baseRecordFor(other, ID).record.resumed, undefined);
});

test('recorder: replacing an invalid record writes a record the merge gate still reads as resumed (owner word required)', () => {
  const gh = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  assert.equal(readSummaryComment(gh, PR).status, 'invalid');
  const rec = recorderFor(gh).update({ step: 'merge' });
  assert.ok(rec, 'the write itself still happens');
  const after = readSummaryComment(gh, PR);
  // the exact predicate of pipeline/commands/merge.mjs wordRequired
  assert.equal(after.status === 'ok' && Boolean(after.record.resumed), true);
  assert.deepEqual(after.record.resumed, { at: new Date(NOW).toISOString(), host: 'pc-1', head: HEAD });
});

// ---- (b) unsupported -> never overwritten --------------------------------------------------------------------------------------

test('baseRecordFor: an unsupported (newer) record throws instead of falling through to a fresh one', () => {
  assert.throws(() => baseRecordFor({ status: 'unsupported' }, ID), /newer pipeline version/);
});

test('recorder: a record from a newer CLI is not overwritten; update returns null with a warning', () => {
  const gh = memoryGh([{ id: 7, body: NEWER_BODY(), user: { login: 'me' } }]);
  const before = mineBody(gh);
  assert.equal(readSummaryComment(gh, PR).status, 'unsupported');
  const recorder = recorderFor(gh);
  assert.equal(recorder.update({ step: 'merge' }), null);
  assert.equal(mineBody(gh), before, 'the newer CLI\'s record is untouched');
  assert.match(recorder.warnings.join('\n'), /run record not updated: .*newer pipeline version/);
});

// ---- (c) stale write: a concurrent `resumed` is carried over ---------------------------------------------------------------------

test('recorder: a checkpoint --resumed that lands between the read and the write is not erased', () => {
  const gh = memoryGh();
  seed(gh, plain());
  // the first prView runs after the recorder's first read and before its write: a concurrent run marks the record resumed
  const view = gh.prView;
  gh.prView = (...a) => { writeSummaryComment(gh, PR, { record: resumedRecord() }); return view(...a); };
  const rec = recorderFor(gh).update({ step: 'merge' });
  assert.deepEqual(rec.resumed, RESUMED);
  const after = readSummaryComment(gh, PR);
  assert.deepEqual(after.record.resumed, RESUMED);
  assert.equal(after.record.step, 'merge', 'the recorder\'s own update is kept');
});

test('recorder: a record that was already resumed keeps its mark through an ordinary update; an ordinary record stays ordinary', () => {
  const gh = memoryGh();
  seed(gh, resumedRecord());
  assert.deepEqual(recorderFor(gh).update({ step: 'merge' }).resumed, RESUMED);
  const ok = memoryGh();
  seed(ok, plain());
  assert.equal(recorderFor(ok).update({ step: 'merge' }).resumed, undefined);
});

test('recorder: a newer-CLI record that appears between the read and the write is not overwritten', () => {
  const gh = memoryGh();
  seed(gh, plain());
  const view = gh.prView;
  gh.prView = (...a) => { gh.comments[0].body = NEWER_BODY(); return view(...a); };
  const recorder = recorderFor(gh);
  assert.equal(recorder.update({ step: 'merge' }), null);
  assert.equal(mineBody(gh), NEWER_BODY());
});

// `P summary` / `P comment --kind summary` build their record from null when the comment is unreadable: the shared writer still marks it.
test('writeRunRecord: an unreadable (invalid) comment gets a record marked resumed even when the caller built a plain one', () => {
  const gh = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  const posted = writeRunRecord(gh, PR, { record: plain(), repo: ID.repo, branch: ID.branch, host: 'pc-1', now: NOW });
  assert.deepEqual(posted.record.resumed, { at: new Date(NOW).toISOString(), host: 'pc-1', head: HEAD });
  assert.equal(readSummaryComment(gh, PR).record.resumed.host, 'pc-1');
});

// R9-F1: the comment is this PR's summary comment, the one the merge gate reads: a mark on a record bound to another repo / branch (a rename or
// transfer) is carried, never dropped.
test('writeRunRecord: a resumed mark on a record bound to another repo or branch (rename / transfer) is still carried over', () => {
  for (const moved of [{ repo: 'acme/old-name' }, { branch: 'feat/old-branch' }, { pr: 99 }]) {
    const gh = memoryGh();
    seed(gh, { ...resumedRecord(), ...moved });
    const posted = writeRunRecord(gh, PR, { record: plain() });
    assert.deepEqual(posted.record.resumed, RESUMED, JSON.stringify(moved));
    assert.deepEqual(readSummaryComment(gh, PR).record.resumed, RESUMED, JSON.stringify(moved));
  }
  const ordinary = memoryGh();
  seed(ordinary, { ...plain(), repo: 'acme/old-name' });
  assert.equal(writeRunRecord(ordinary, PR, { record: plain() }).record.resumed, undefined, 'a moved ordinary record stays ordinary');
});

// ---- R9-B1: the run-resumed event is the durable evidence; the record alone is not enough -------------------------------------------

const EVENT = () => ({ id: 50, user: { login: 'me' }, body: renderEvent('run-resumed', 'pr4-aaaaaaaaaaaa', 'taken over', RESUMED) });

test('resumedRunState: the record mark, OR a viewer-authored run-resumed event, makes the run resumed; neither leaves it ordinary', () => {
  const none = memoryGh();
  seed(none, plain());
  assert.deepEqual(resumedRunState(none, PR).resumed, false);
  const byRecord = memoryGh();
  seed(byRecord, resumedRecord());
  assert.deepEqual([resumedRunState(byRecord, PR).resumed, resumedRunState(byRecord, PR).unchecked], [true, null]);
  // the R9-B1 interleaving: the event exists, the record was then overwritten by a writer that had not seen the mark
  const byEvent = memoryGh([EVENT()]);
  seed(byEvent, plain());
  const state = resumedRunState(byEvent, PR);
  assert.deepEqual([state.existing.status, state.existing.record.resumed, state.resumed, state.unchecked], ['ok', undefined, true, null]);
  // another author's event does not count
  const forged = memoryGh([{ ...EVENT(), user: { login: 'mallory' } }]);
  seed(forged, plain());
  assert.equal(resumedRunState(forged, PR).resumed, false);
});

test('resumedRunState: a record that cannot be read, or events that cannot be read, fail closed (unchecked)', () => {
  const invalid = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  assert.match(resumedRunState(invalid, PR).unchecked, /^the run record is invalid$/);
  // the record read succeeds, the events read (a second listing) fails
  const gh = memoryGh();
  seed(gh, plain());
  const list = gh.listComments;
  let calls = 0;
  gh.listComments = (...a) => { calls += 1; if (calls > 1) throw new Error('boom 502'); return list(...a); };
  const state = resumedRunState(gh, PR);
  assert.equal(state.existing.status, 'ok');
  assert.match(state.unchecked, /^the run-resumed events could not be read \(boom 502\)/);
  assert.equal(state.resumed, false);
});

test('writeRunRecord: an invalid comment replaced by a resumed-marked record also leaves a run-resumed event (best effort, warned when it fails)', () => {
  const gh = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  gh.createComment = (pr, body) => { gh.comments.push({ id: 60, body, user: { login: 'me' } }); return { id: 60, url: 'u' }; };
  const warnings = [];
  writeRunRecord(gh, PR, { record: plain(), repo: ID.repo, branch: ID.branch, host: 'pc-1', now: NOW, onWarning: (w) => warnings.push(w) });
  const events = gh.comments.map((c) => parseEvent(c.body)).filter((e) => e?.kind === 'run-resumed');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].data.host, events[0].data.head], ['pc-1', HEAD]);
  assert.deepEqual(warnings, []);
  const broken = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  broken.createComment = () => { throw new Error('boom 502'); };
  const w2 = [];
  const posted = writeRunRecord(broken, PR, { record: plain(), repo: ID.repo, branch: ID.branch, host: 'pc-1', now: NOW, onWarning: (w) => w2.push(w) });
  assert.ok(posted.record.resumed, 'the record is still written and marked');
  assert.match(w2.join('\n'), /run-resumed event not posted: boom 502/);
});
