// Chat mode without needs-human (docs/plans/2026-10-20-chat-mode-no-needs-human.md, D2): the owner's typed reply releases an owner stop, only through
// `P checkpoint --resumed` and only with the owner-go record for that exact PR and stop id; and `P merge` demands an owner "merge" given to a request that carried
// the PR's newest stop id. Real CLI against the scripted gh fake; the owner's replies are recorded in the real owner-go folder under random sessions (ownerSays).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { approvalFlags, mergeRequest, ownerSays, resumeSays, stopReply } from './helpers/owner-go.mjs';
import { renderEvent, parseEvent } from '../pipeline/lib/run-events.mjs';
import { decodeRecord } from '../pipeline/lib/run-record.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';

const S1 = '5f3a9c2e';
const S2 = '0a1b2c3d';
const S3 = '1111aaaa'; // (the owner's records live in the real owner-go folder for a day: tests that need an unreleased stop use ids no other test releases)
const S4 = '2222bbbb';
const chatYml = (extra = '') => `${ymlFor()}owner_approval: chat\n${extra}`;
let cid = 600;
const stopComment = (id, over = {}) => ({ id: cid++, user: { login: 'me' }, body: renderEvent('owner-stop', id, `Owner stop ${id}`, { repo: 'acme/widgets', pr: PR, id, cause: 'merge:command-failed', head: null, at: '2026-10-20T08:00:00.000Z', host: 'box', autoMergeDisarmed: true }), ...over });
const releaseComment = (id, over = {}) => ({ id: cid++, user: { login: 'me' }, body: renderEvent('owner-stop-released', id, `Owner stop ${id} released`, { repo: 'acme/widgets', pr: PR, id, at: '2026-10-20T09:00:00.000Z', host: 'box', releaseRef: { kind: 'resume', session: 'x', ts: 'x', prompt_sha256: 'x' } }), ...over });

const writes = (s) => s.fake.calls()
  .filter((c) => c.argv[0] === 'api' && c.argv.includes('-X') && /issues\/(?:\d+\/comments|comments\/\d+)$/.test(c.argv.at(-3)))
  .map((c) => ({ method: c.argv[c.argv.indexOf('-X') + 1], body: JSON.parse(c.stdin).body }));
const eventWrites = (s) => writes(s).filter((w) => w.body.startsWith('<!-- claude-pipeline:event:')).map((w) => parseEvent(w.body));
const recordWrites = (s) => writes(s).filter((w) => w.body.startsWith(MARKERS.summary)).map((w) => decodeRecord(w.body).record);
const checkpoint = (s, args) => cli(['checkpoint', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });
const withStops = (yml, ...comments) => scenario({ yml, gh: { comments } });

test('self-resume: --resumed on an open stop with no owner reply is refused and posts nothing', () => {
  const s = withStops(chatYml(), stopComment(S1));
  const r = checkpoint(s, ['--step', 'gate', '--resumed']);
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-release-missing');
  assert.deepEqual(r.json.stops, [S1]);
  assert.deepEqual(writes(s), [], 'no event, no record write');
});

test('a release recorded BEFORE the stop, naming another stop, or for another PR does not release it', (t) => {
  const s = withStops(chatYml(), stopComment(S1));
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none')); // an approval predating the stop: no stop line
  resumeSays(t, PR, stopReply(PR, S2)); // another stop id
  resumeSays(t, PR + 1, stopReply(PR + 1, S1)); // another PR
  const r = checkpoint(s, ['--step', 'gate', '--resumed']);
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-release-missing');
  assert.deepEqual(eventWrites(s), []);
});

test('the owner\'s "ship resume N" after the stop reply releases it: release event with the record as releaseRef, copy cleared, resumed stamped', (t) => {
  const s = withStops(chatYml(), stopComment(S1));
  const rec = resumeSays(t, PR, stopReply(PR, S1));
  const r = checkpoint(s, ['--step', 'gate', '--resumed']);
  assertExit(r, 0);
  const [ev] = eventWrites(s);
  assert.equal(ev.kind, 'owner-stop-released');
  assert.equal(ev.id, S1);
  assert.deepEqual(ev.data.releaseRef, { kind: 'resume', session: rec.session, ts: rec.ts, prompt_sha256: rec.prompt_sha256 });
  assert.equal(ev.data.pr, PR);
  assert.ok(r.json.record.resumed, 'resumed is stamped');
  assert.equal(r.json.record.outcome, null);
  assert.equal(r.json.record.ownerStop, undefined);
  assert.deepEqual(r.json.released, [S1]);
  const order = writes(s).map((w) => (w.body.startsWith('<!-- claude-pipeline:event:') ? 'event' : 'record'));
  assert.deepEqual(order, ['event', 'record'], 'the release event is posted FIRST');
});

test('"merge" after a Stopped / Head / 🔀 offer also releases (releaseRef kind merge)', (t) => {
  const s = withStops(chatYml(), stopComment(S1));
  ownerSays(t, 'merge', stopReply(PR, S1, { merge: { head: s.head, items: 'none' } }));
  const r = checkpoint(s, ['--step', 'gate', '--resumed']);
  assertExit(r, 0);
  assert.equal(eventWrites(s)[0].data.releaseRef.kind, 'merge');
});

test('several open stops: one owner reply naming all releases all; a stop it did not name stays open (exit 1, the named one is released)', (t) => {
  const s = withStops(chatYml(), stopComment(S1), stopComment(S2));
  resumeSays(t, PR, stopReply(PR, [S1, S2]));
  const r = checkpoint(s, ['--step', 'gate', '--resumed']);
  assertExit(r, 0);
  assert.deepEqual(eventWrites(s).map((e) => e.id).sort(), [S1, S2].sort());
  const s2 = withStops(chatYml(), stopComment(S3), stopComment(S4));
  resumeSays(t, PR, stopReply(PR, S3));
  const r2 = checkpoint(s2, ['--step', 'gate', '--resumed']);
  assertExit(r2, 1);
  assert.equal(r2.json.error, 'owner-release-missing');
  assert.deepEqual(r2.json.stops, [S4]);
  assert.deepEqual(eventWrites(s2).map((e) => e.id), [S3], 'the stop the owner named is released, the other stays open');
});

test('a checkpoint without --resumed on an open stop is refused; the resting steps and a PR with no open stop are not', () => {
  const s = withStops(chatYml(), stopComment(S1));
  const r = checkpoint(s, ['--step', 'review']);
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-stop-open');
  assert.deepEqual(writes(s), []);
  assertExit(checkpoint(s, ['--step', 'ended']), 0);
  assertExit(checkpoint(s, ['--step', 'awaiting-owner-merge']), 0);
  const released = withStops(chatYml(), stopComment(S1), releaseComment(S1));
  assertExit(checkpoint(released, ['--step', 'review']), 0);
  assertExit(checkpoint(withStops(chatYml()), ['--step', 'gate', '--resumed']), 0); // adopting a PR with no stop
});

test('label mode: --resumed and plain checkpoints never look at stops or releases', (t) => {
  const s = withStops(ymlFor(), stopComment(S1));
  assertExit(checkpoint(s, ['--step', 'review']), 0);
  assertExit(checkpoint(s, ['--step', 'gate', '--resumed']), 0);
  assert.deepEqual(eventWrites(s), []);
  assert.ok(recordWrites(s).length >= 1);
});

// ---- P merge: the owner's "merge" must have been given to a request that carried the newest stop id ---------------------------------------
const merge = (s, args = []) => cli(['merge', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });

test('forged release, end to end: an approval from before the stop, plus a well-formed release comment, still does not merge', (t) => {
  const s = withStops(chatYml(), stopComment(S1), releaseComment(S1)); // the release is what a forged `addComment` would leave
  assertExit(s.gate(), 0);
  const items = s.gateFile().ownerItems;
  ownerSays(t, 'merge', mergeRequest(PR, s.head, items)); // recorded before the stop: its request carried no stop line
  const r = merge(s, approvalFlags(s.head, items));
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /no owner "merge" is recorded.*stop 5f3a9c2e/s);
  assert.deepEqual(s.mergeCalls(), []);
  // the controller prints Stopped + Head + 🔀 and the owner types "merge": the same command merges
  ownerSays(t, 'merge', stopReply(PR, S1, { merge: { head: s.head, items } }));
  const ok = merge(s, approvalFlags(s.head, items));
  assertExit(ok, 0);
  assert.equal(ok.json.merged, true);
  assert.equal(s.mergeCalls().length, 1);
});

test('a released stop makes the run a resumed one: P merge demands the owner\'s "merge" even for a low-risk head', (t) => {
  const s = withStops(chatYml(), stopComment(S1), releaseComment(S1));
  assertExit(s.gate(), 0);
  const r = merge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /resumed run/);
  ownerSays(t, 'merge', stopReply(PR, S1, { merge: { head: s.head, items: 'none' } }));
  assertExit(merge(s, approvalFlags(s.head, 'none')), 0);
});

test('a release from another user, an unreadable release and a release for another id release nothing', () => {
  const other = releaseComment(S1, { user: { login: 'mallory' } });
  const bad = { id: cid++, user: { login: 'me' }, body: `<!-- claude-pipeline:event:owner-stop-released:${S1} -->\n\nreleased\n<!-- claude-pipeline:event-data:!!!! -->` };
  for (const extra of [other, bad, releaseComment(S2)]) {
    const s = withStops(chatYml(), stopComment(S1), extra);
    const r = checkpoint(s, ['--step', 'review']);
    assertExit(r, 1);
    assert.equal(r.json.error, 'owner-stop-open', JSON.stringify(extra).slice(0, 60));
  }
});

test('an unreadable events list at P merge refuses (chat); a PR with no stop merges on a plain approval; label mode never reads events', (t) => {
  const s = scenario({ yml: chatYml(), gh: { extra: [{ match: 'issues/12/comments --paginate', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] } });
  s.gate();
  const r = merge(s);
  assert.notEqual(r.code, 0);
  assert.deepEqual(s.mergeCalls(), []);
  const plain = scenario({ yml: chatYml() });
  assertExit(plain.gate(), 0);
  assertExit(merge(plain), 0);
  const label = scenario({ gh: { comments: [stopComment(S1), releaseComment(S1)] } });
  assertExit(label.gate(), 0);
  assertExit(merge(label), 0);
});

test('final-gate prints the newest stop id in chat mode (null with none); label mode prints none', () => {
  const none = withStops(chatYml());
  assert.equal(none.gate().json.stop, null);
  const s = withStops(chatYml(), stopComment(S1), releaseComment(S1), stopComment(S2), releaseComment(S2));
  assert.deepEqual(s.gate().json.stop, { id: S2 });
  assert.equal(withStops(ymlFor(), stopComment(S1)).gate().json.stop, undefined);
});

// ---- P merge on a PR with an OPEN owner stop (the label no longer blocks it in chat mode) ---------------------------------------------------
const S5 = '3333cccc';
const S6 = '4444dddd';

test('an open owner stop blocks P merge even for a low-risk head with no owner items and no release', () => {
  const s = withStops(chatYml(), stopComment(S5));
  assertExit(s.gate(), 0);
  const r = merge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, new RegExp(`open owner stop.*${S5}|${S5}.*open`, 's'));
  assert.deepEqual(s.mergeCalls(), []);
});

test('several open stops: the owner\'s "merge" must have been given to a request that carried EVERY open id, not just the newest', (t) => {
  const s = withStops(chatYml(), stopComment(S5), stopComment(S6));
  assertExit(s.gate(), 0);
  const items = s.gateFile().ownerItems;
  ownerSays(t, 'merge', stopReply(PR, S6, { merge: { head: s.head, items } })); // the reply listed only the newest id
  const r = merge(s, approvalFlags(s.head, items));
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, new RegExp(S5));
  assert.deepEqual(s.mergeCalls(), []);
  ownerSays(t, 'merge', stopReply(PR, [S5, S6], { merge: { head: s.head, items } }));
  assertExit(merge(s, approvalFlags(s.head, items)), 0);
  assert.equal(s.mergeCalls().length, 1);
});
