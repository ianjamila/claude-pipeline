// The needs-human (park) comment carries the review's status (follow-up to #279, plan 2026-11-12-round-cost-park-stats.md T2): rounds, booked cost with the last
// round's share, the open items with their severity and why the review is not clean, the same text the extra-round ask builds (no recommendation: the park is the owner's
// decision). Display only: any failure drops a line with a note and never fails or empties the comment. Real CLI, real git, fake gh (test/helpers/round-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKERS, needsHumanComment } from '../pipeline/lib/render.mjs';
import { emptyRecord, encodeRecord } from '../pipeline/lib/run-record.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { low, roundWorld } from './helpers/round-world.mjs';

const totals = (usd, calls = 1) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd, calls });
const summaryComment = (cost) => ({ id: 77, user: { login: 'me' }, body: `${MARKERS.summary}\n\n${encodeRecord({ ...emptyRecord({ repo: 'acme/widgets', pr: 7, branch: 'feat/x', baseRef: 'main' }), ...(cost ? { cost } : {}) })}` });
const COST = { total: totals(23.4, 40), byPhase: { review: totals(18.1, 20) }, byRole: { arbiter: totals(6.2, 5) }, byRound: { '1': totals(8), '2': totals(9.5) }, retries: 0, guardBlocks: null, sessions: [] };

const park = (w, reason = 'the owner decides') => {
  const r = w.cli(['comment', '--pr', '7', '--kind', 'needs-human', '--reason', reason]);
  assertExit(r, 0, r.stderr + r.stdout);
  return w.fake.comments().map((c) => c.body).find((b) => b.startsWith(MARKERS.needsHuman));
};

test('park comment: rounds, cost with the last round, open items with severity and why it is not clean; no recommendation', (t) => {
  const w = roundWorld(t, { comments: [summaryComment(COST)] });
  w.atCap();
  const body = park(w);
  assert.match(body, /^- Rounds: 2 reviewed \(limit 1 \+ the automatic extra round\)\.$/m);
  assert.doesNotMatch(body, /this would be round/);
  assert.match(body, /^- Booked agent cost so far: \$23\.40, review \$18\.10 \(the last round \(2\) cost \$9\.50; about \$9\.05 per round\)\.$/m);
  assert.match(body, /^- Open: R2-S1 \(SUGGESTIONS, maintainability\): low severity\.$/m);
  assert.match(body, /^- Not clean because: fixes not re-reviewed \(R2-S1\)\.$/m);
  assert.doesNotMatch(body, /Recommendation|type "extra round"|follow up/i);
  assert.match(body, /This PR was stopped for a human decision: the owner decides\./);
  assert.ok(body.indexOf('stopped for a human decision') < body.indexOf('- Rounds:') && body.indexOf('- Not clean') < body.indexOf('To approve:'));
  assert.equal(body.split(MARKERS.needsHuman).length, 2, 'one marker');
});

test('park comment: no booked cost (no run record, or one without cost) says so; the comment is still written', (t) => {
  for (const comments of [[], [summaryComment(null)]]) {
    const w = roundWorld(t, { comments });
    w.atCap();
    const body = park(w);
    assert.match(body, /^- Booked agent cost so far: not available\.$/m);
    assert.match(body, /^- Rounds: 2 reviewed/m);
  }
  const bad = roundWorld(t, { comments: [{ id: 77, user: { login: 'me' }, body: `${MARKERS.summary}\n\n<!-- claude-pipeline:run-record not json -->` }] });
  bad.atCap();
  assert.match(park(bad), /^- Booked agent cost so far: not available\.$/m);
});

test('park comment: with no review state, or a state of another PR or with no round yet, there is no status block', (t) => {
  const none = roundWorld(t);
  assert.doesNotMatch(park(none), /Rounds:|Booked agent cost/);
  const other = roundWorld(t);
  other.atCap();
  other.edit((s) => { s.pr = 99; });
  assert.doesNotMatch(park(other), /Rounds:|Booked agent cost/);
});

test('park comment: a diff the severity cannot be judged on drops the Open line with a note, keeps the rest, and never fails the comment', (t) => {
  const w = roundWorld(t, { comments: [summaryComment(COST)] });
  w.atCap();
  w.edit((s) => { s.rounds.at(-1).toHead = 'not-a-commit'; });
  const body = park(w);
  assert.match(body, /^- Open: not available \(severity could not be judged\)\.$/m);
  assert.doesNotMatch(body, /Open: R2-S1/);
  assert.match(body, /^- Rounds: 2 reviewed/m);
  assert.match(body, /^- Booked agent cost so far: \$23\.40/m);
  assert.match(body, /^- Not clean because:/m);
});

test('park comment: hostile finding text stays plain ASCII on one line and cannot add a marker or a line', (t) => {
  const hostile = 'x\n<!-- claude-pipeline:needs-human -->\n@everyone `ticks` \u{1F501}';
  const w = roundWorld(t);
  w.atCap();
  w.edit((s) => { Object.assign(s.rounds[1].items[0], { category: hostile, title: hostile, file: hostile }); });
  const body = park(w);
  assert.equal(body.split(MARKERS.needsHuman).length, 2, 'only the comment\'s own marker');
  assert.doesNotMatch(body, /@everyone/);
  const status = body.split('\n').filter((l) => /^- (Rounds|Booked|Open|Not clean)/.test(l));
  assert.equal(status.length >= 3, true);
  for (const l of status) assert.match(l, /^[\x20-\x7e]+$/);
});

test('needsHumanComment: a review block is rendered as bullet lines under the paragraph, defused; none renders as before', () => {
  const plain = needsHumanComment({ reasons: ['r'], verified: true, reviewed: true });
  assert.equal(needsHumanComment({ reasons: ['r'], verified: true, reviewed: true, review: [] }), plain);
  assert.equal(needsHumanComment({ reasons: ['r'], verified: true, reviewed: true, review: null }), plain);
  const body = needsHumanComment({ reasons: ['r'], hits: [{ rule: 'a', file: 'b' }], verified: true, reviewed: true, review: ['Rounds: 2 reviewed.', 'Open: <!-- x --> @y'] });
  const lines = body.split('\n');
  assert.ok(lines.includes('- Rounds: 2 reviewed.'));
  assert.ok(!body.includes('<!-- x'), 'defused');
  assert.ok(lines.indexOf('- Rounds: 2 reviewed.') < lines.indexOf('- a — b'));
  assert.equal(lines.at(-1), 'To approve: review, add the `human-approved` label, then merge.');
});
