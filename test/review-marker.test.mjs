// Unit tests for lib/review-marker.mjs: the review-complete comment as review-complete writes it and the guards workflow reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_COMPLETE_MARKER, REVIEW_CONTEXT, REVIEW_MARKER_TEXT, latestReviewComment, parseReviewRecord } from '../pipeline/lib/review-marker.mjs';
import { REVIEW_COMPLETE_MARKER as COMMAND_MARKER, reviewCompleteBody } from '../pipeline/commands/review-complete.mjs';
import { REVIEW_CHECK } from '../pipeline/lib/config.mjs';
import { GUARD_CONTEXT_CHECKS } from '../pipeline/lib/guard-provenance.mjs';

const RECORD = { contentHash: 'c'.repeat(64), base: 'b'.repeat(40), head: 'a'.repeat(40), rounds: 2, codexModel: 'gpt-6-astra', modelProofDigest: null };
const T = (hhmm) => `2026-10-01T${hhmm}:00Z`;
const comment = (over = {}) => ({ id: 1, by: 'acme', at: T('10:00'), updated: T('10:00'), body: reviewCompleteBody(RECORD), ...over });
const owner = (login) => login === 'acme';

test('one marker, one status name everywhere', () => {
  assert.equal(COMMAND_MARKER, REVIEW_COMPLETE_MARKER);
  assert.ok(REVIEW_COMPLETE_MARKER.includes(REVIEW_MARKER_TEXT));
  assert.equal(REVIEW_CONTEXT, REVIEW_CHECK);
  assert.equal(GUARD_CONTEXT_CHECKS[REVIEW_CONTEXT], 'review');
});

test('parseReviewRecord round-trips what review-complete posts, with or without a Fable digest', () => {
  assert.deepEqual(parseReviewRecord(reviewCompleteBody(RECORD)), RECORD);
  const fable = { ...RECORD, modelProofDigest: 'd'.repeat(64) };
  assert.deepEqual(parseReviewRecord(reviewCompleteBody(fable)), fable);
  assert.deepEqual(parseReviewRecord(reviewCompleteBody(RECORD).replace(/\n/g, '\r\n')), RECORD, 'CRLF line ends');
  // extra keys are dropped, not trusted
  assert.deepEqual(Object.keys(parseReviewRecord(reviewCompleteBody({ ...RECORD, approved: true }))), Object.keys(RECORD));
});

test('parseReviewRecord refuses anything that is not exactly the shape', () => {
  const body = reviewCompleteBody(RECORD);
  for (const bad of [
    '', null, undefined, 'looks good', ` ${body}`, body.replace(REVIEW_COMPLETE_MARKER, '<!-- claude-pipeline:review-complete v2 -->'),
    body.replace('```json', '```'), body.replace(/\n```\n$/, '\n'), body.replace(JSON.stringify(RECORD), '{not json'),
    body.replace(JSON.stringify(RECORD), '[]'), body.replace(JSON.stringify(RECORD), 'null'),
    ...[
      { contentHash: 'c'.repeat(63) }, { contentHash: 'C'.repeat(64) }, { base: 'b'.repeat(39) }, { head: 'A'.repeat(40) }, { rounds: 0 }, { rounds: 1.5 },
      { rounds: '2' }, { codexModel: '' }, { codexModel: 7 }, { modelProofDigest: 'd'.repeat(63) }, { modelProofDigest: undefined },
    ].map((over) => reviewCompleteBody({ ...RECORD, ...over })),
  ]) assert.equal(parseReviewRecord(bad), null, JSON.stringify(bad));
});

test('latestReviewComment: the newest marker comment of an allowed author, by creation time', () => {
  assert.deepEqual(latestReviewComment([], owner), { found: false });
  assert.deepEqual(latestReviewComment([comment({ by: 'mallory' }), { ...comment(), body: 'no marker' }], owner), { found: false });
  const older = comment({ id: 1, at: T('10:00'), updated: T('10:00') });
  const newer = comment({ id: 2, at: T('10:05'), updated: T('10:05'), body: reviewCompleteBody({ ...RECORD, rounds: 3 }) });
  assert.equal(latestReviewComment([newer, older], owner).record.rounds, 3);
  // same second: the higher id is the later one
  assert.equal(latestReviewComment([{ ...newer, at: T('10:00'), updated: T('10:00') }, { ...older, id: 3 }], owner).comment.id, 3);
  // an allowed author's login is compared lowercased; a comment with no valid time is not a candidate
  assert.equal(latestReviewComment([comment({ by: 'ACME' })], owner).found, true);
  assert.equal(latestReviewComment([comment({ at: 'yesterday' })], owner).found, false);
});

test('latestReviewComment: an edited or malformed newest comment is refused, and an older valid one does not take its place', () => {
  const older = comment({ id: 1 });
  const edited = latestReviewComment([older, comment({ id: 2, at: T('10:05'), updated: T('10:06') })], owner);
  assert.deepEqual([edited.found, edited.record, edited.comment.id], [true, null, 2]);
  assert.match(edited.reason, /edited after it was posted/);
  const malformed = latestReviewComment([older, comment({ id: 3, at: T('10:05'), updated: T('10:05'), body: `${REVIEW_COMPLETE_MARKER}\nfine` })], owner);
  assert.deepEqual([malformed.record, malformed.comment.id], [null, 3]);
  assert.match(malformed.reason, /does not carry a valid review record/);
  assert.equal(latestReviewComment([comment({ updated: undefined })], owner).record, null, 'no updated_at: treated as edited');
});
