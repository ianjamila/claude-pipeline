// R8-F4 / R9: replacing the run record must not drop the merge gate's fail-closed state. An unreadable (invalid) record is replaced by one
// marked `resumed` (so `P merge` still needs the owner's word), a record from a newer CLI that is seen is not overwritten, and a write whose re-read
// sees a `resumed` mark carries it over. The re-read is NOT atomic (GitHub has no conditional edit): the durable evidence is the append-only
// run-resumed event, which `resumedRunState` (what `P merge` reads) counts beside the record.
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

// A stateful stand-in for the github wrapper (viewer / listComments / upsertComment / createComment / prView / repo).
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
    createComment(pr, body) {
      next += 1;
      comments.push({ id: next, body, user: { login: 'me' }, html_url: `https://x/${next}` });
      return { id: next, url: `https://x/${next}` };
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

// R9-F1: a record bound to another repo / branch is replaced, but the mark the merge gate reads is not dropped with it.
test('baseRecordFor: a resumed record bound to another repo or branch (rename / transfer) is replaced by a fresh one that is still resumed', () => {
  for (const moved of [{ repo: 'acme/old-name' }, { branch: 'feat/old-branch' }, { pr: 99 }]) {
    const { record, warnings } = baseRecordFor({ status: 'ok', record: { ...resumedRecord(), ...moved } }, ID);
    assert.deepEqual(record.resumed, RESUMED, JSON.stringify(moved));
    assert.deepEqual([record.repo, record.branch, record.pr], [ID.repo, ID.branch, PR], 'bound to this PR again');
    assert.match(warnings[0], /does not belong to this PR/);
  }
});

test('recorder: after a repo rename the next record write keeps the merge gate reading the run as resumed', () => {
  const gh = memoryGh();
  seed(gh, { ...resumedRecord(), repo: 'acme/old-name' });
  assert.deepEqual(recorderFor(gh).update({ step: 'merge' }).resumed, RESUMED);
  const after = readSummaryComment(gh, PR);
  assert.deepEqual([after.status, after.record.repo, after.record.resumed], ['ok', ID.repo, RESUMED]);
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

// R1-F3 (#407): the recorder's first read is ok, another writer corrupts the comment, and the writer's own re-read stamps the record resumed: that is reported too.
test('recorder: a record that turns unreadable between the recorder\'s read and the writer\'s re-read is reported in recorder.warnings, once', () => {
  const gh = memoryGh();
  seed(gh, plain());
  const real = gh.listComments;
  let reads = 0;
  gh.listComments = () => { reads += 1; return reads === 1 ? real() : real().map((c) => (c.body.startsWith(MARKERS.summary) ? { ...c, body: INVALID_BODY } : c)); };
  const recorder = recorderFor(gh);
  assert.ok(recorder.update({ step: 'merge' }), 'the write itself still happens');
  const marked = recorder.warnings.filter((w) => /could not be read; started a new one, marked resumed/.test(w));
  assert.equal(marked.length, 1, JSON.stringify(recorder.warnings));
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

test('recorder: a checkpoint --resumed that lands BEFORE the guarded writer\'s re-read (after the first read) is carried over; one landing after the re-read is the event\'s job (see resumedRunState)', () => {
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

test('recorder: a newer-CLI record that appears after the first read but before the guarded writer\'s re-read is not overwritten', () => {
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
// transfer) is carried by the guarded writer's re-read.
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

test('writeRunRecord: an invalid comment replaced by a resumed-marked record also leaves a run-resumed event, posted before the record', () => {
  const gh = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  gh.createComment = (pr, body) => { gh.comments.push({ id: 60, body, user: { login: 'me' } }); return { id: 60, url: 'u' }; };
  writeRunRecord(gh, PR, { record: plain(), repo: ID.repo, branch: ID.branch, host: 'pc-1', now: NOW });
  const events = gh.comments.map((c) => parseEvent(c.body)).filter((e) => e?.kind === 'run-resumed');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].data.host, events[0].data.head], ['pc-1', HEAD]);
});

// R10-B1: the event is REQUIRED. A write that stamps a resumed mark the re-read does not carry must have posted the event first; when the post fails nothing is
// written (the comment stays invalid, which the gate reads as unchecked, and the next write retries). Residual, stated honestly: a writer whose read
// PREDATES the corruption can still PATCH an unmarked record over an invalid one (GitHub has no conditional edit), whatever this path does.
test('writeRunRecord: when the run-resumed event cannot be posted nothing is written and the call fails; the invalid comment stays invalid (a stale pre-corruption PATCH remains the residual)', () => {
  const broken = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  broken.createComment = () => { throw new Error('boom 502'); };
  assert.throws(() => writeRunRecord(broken, PR, { record: plain(), repo: ID.repo, branch: ID.branch, host: 'pc-1', now: NOW }), /boom 502/);
  assert.equal(broken.comments.find((c) => c.id === 7).body, INVALID_BODY, 'the comment was not touched');
  assert.equal(readSummaryComment(broken, PR).status, 'invalid');
  assert.equal(resumedRunState(broken, PR).unchecked, 'the run record is invalid', 'the gate still fails closed');
  // the recorder turns the throw into a warning and a null record, and the next write retries
  const rec = recorderFor(broken);
  assert.equal(rec.update({ step: 'review' }), null);
  assert.match(rec.warnings.join('\n'), /run record not updated: boom 502/);
  broken.createComment = (pr, body) => { broken.comments.push({ id: 61, body, user: { login: 'me' } }); return { id: 61, url: 'u' }; };
  assert.ok(recorderFor(broken).update({ step: 'review' }).resumed);
  assert.equal(resumedRunState(broken, PR).resumed, true);
});

test('writeRunRecord: a resumed stamp made on an earlier read still gets its event when the re-read is no longer invalid (ok, unmarked)', () => {
  const gh = memoryGh();
  seed(gh, plain());
  gh.createComment = (pr, body) => { gh.comments.push({ id: 62, body, user: { login: 'me' } }); return { id: 62, url: 'u' }; };
  // baseRecordFor saw an invalid record and stamped; a stale writer then replaced it with an ordinary one before the re-read
  const stamped = { ...plain(), resumed: RESUMED };
  const posted = writeRunRecord(gh, PR, { record: stamped, host: 'pc-1', now: NOW });
  assert.deepEqual(posted.record.resumed, RESUMED);
  const events = gh.comments.map((c) => parseEvent(c.body)).filter((e) => e?.kind === 'run-resumed');
  assert.deepEqual(events.map((e) => e.data), [RESUMED]);
  // the caller that already posted its own event (skipResumedEvent), or a re-read that already carries the mark, posts none
  const again = memoryGh();
  seed(again, resumedRecord());
  again.createComment = () => { throw new Error('must not post'); };
  assert.deepEqual(writeRunRecord(again, PR, { record: stamped }).record.resumed, RESUMED);
  const skipped = memoryGh();
  seed(skipped, plain());
  skipped.createComment = () => { throw new Error('must not post'); };
  assert.deepEqual(writeRunRecord(skipped, PR, { record: stamped, skipResumedEvent: true }).record.resumed, RESUMED);
});

// R11-F1: `P summary` and `P comment --kind summary` build their record without baseRecordFor, so they hand the writer the status of THEIR first read
// (`firstRead`): an invalid one is stamped and its event posted exactly as baseRecordFor's callers do, even when a stale writer has since PATCHed an ordinary record.
test('writeRunRecord: a first read that was invalid stamps resumed and posts the event although the re-read is ok and unmarked (stale writer in between)', () => {
  const gh = memoryGh();
  seed(gh, plain()); // what the stale writer PATCHed over the corrupted comment
  gh.createComment = (pr, body) => { gh.comments.push({ id: 64, body, user: { login: 'me' } }); return { id: 64, url: 'u' }; };
  const posted = writeRunRecord(gh, PR, { record: plain(), firstRead: { status: 'invalid' }, host: 'pc-1', now: NOW });
  assert.deepEqual(posted.record.resumed, { at: new Date(NOW).toISOString(), host: 'pc-1', head: HEAD });
  const events = gh.comments.map((c) => parseEvent(c.body)).filter((e) => e?.kind === 'run-resumed');
  assert.deepEqual(events.map((e) => e.data), [posted.record.resumed], 'the run-resumed event was posted');
  assert.equal(resumedRunState(gh, PR).resumed, true);
  // a failed post still writes nothing (the event is required)
  const broken = memoryGh();
  seed(broken, plain());
  const before = mineBody(broken);
  broken.createComment = () => { throw new Error('boom 502'); };
  assert.throws(() => writeRunRecord(broken, PR, { record: plain(), firstRead: { status: 'invalid' }, host: 'pc-1', now: NOW }), /boom 502/);
  assert.equal(mineBody(broken), before);
  // an ordinary first read (ok, absent) changes nothing
  for (const firstRead of [{ status: 'ok', record: plain() }, { status: 'absent' }, undefined]) {
    const ordinary = memoryGh();
    seed(ordinary, plain());
    ordinary.createComment = () => { throw new Error('must not post'); };
    assert.equal(writeRunRecord(ordinary, PR, { record: plain(), firstRead }).record.resumed, undefined);
  }
});

test('writeRunRecord: a malformed resumed.head (not shape-checked on decode) cannot block the mandatory event', () => {
  for (const head of ['bad head/with*chars', 'x'.repeat(200), '\n<!--', '\u00e9\u00e9']) {
    const gh = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
    gh.createComment = (pr, body) => { gh.comments.push({ id: 63, body, user: { login: 'me' } }); return { id: 63, url: 'u' }; };
    const record = { ...plain(), head, resumed: { at: new Date(NOW).toISOString(), host: 'pc-1', head } };
    writeRunRecord(gh, PR, { record, host: 'pc-1', now: NOW });
    const events = gh.comments.map((c) => parseEvent(c.body)).filter((e) => e?.kind === 'run-resumed');
    assert.equal(events.length, 1, JSON.stringify(head));
    assert.equal(resumedRunState(gh, PR).resumed, true, JSON.stringify(head));
  }
});

// #407: P summary / P comment --kind summary build their record from null, so baseRecordFor's warning never reaches them: the shared writer reports the mark it stamps.
test('writeRunRecord: stamping resumed on an unreadable record returns baseRecordFor\'s warning (and an ordinary write returns none)', () => {
  const gh = memoryGh([{ id: 7, body: INVALID_BODY, user: { login: 'me' } }]);
  const posted = writeRunRecord(gh, PR, { record: plain(), firstRead: { status: 'invalid' }, host: 'pc-1', now: NOW });
  assert.equal(posted.warnings.length, 1);
  assert.match(posted.warnings[0], /could not be read; started a new one, marked resumed/);
  assert.equal(baseRecordFor({ status: 'invalid' }, { ...ID, host: 'pc-1', now: NOW }).warnings[0], posted.warnings[0], 'the same wording');
  assert.deepEqual(writeRunRecord(memoryGh(), PR, { record: plain() }).warnings, []);
});
