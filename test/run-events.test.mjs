import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { EVENT_KINDS, listEvents, parseEvent, postEvent, readEvents, renderEvent, resolvedRollbacks, unresolvedRollbacks } from '../pipeline/lib/run-events.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';

const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };
const ME = { match: '^api user', stdout: 'me\n' };
const POST = { match: '^api -X POST repos/acme/widgets/issues/4/comments ', stdoutJson: { id: 90, html_url: 'https://x/90' } };

const DATA = { repo: 'acme/widgets', environment: 'production', headBeforeMerge: 'a'.repeat(40), deployment: { id: 5, sha: 'b'.repeat(40), url: 'https://d' } };

test('renderEvent / parseEvent round trip for every kind', () => {
  for (const kind of EVENT_KINDS) {
    const body = renderEvent(kind, 'pr4-1', 'Production was on deploy 5 before the merge.', DATA);
    assert.ok(body.startsWith(`<!-- claude-pipeline:event:${kind}:pr4-1 -->`));
    const e = parseEvent(body);
    assert.deepEqual([e.kind, e.id, e.dataStatus], [kind, 'pr4-1', 'ok']);
    assert.deepEqual(e.data, DATA);
    assert.equal(e.sentence, 'Production was on deploy 5 before the merge.');
  }
});

test('renderEvent refuses an unknown kind or an id that could break the marker', () => {
  assert.throws(() => renderEvent('nope', 'x', 's', {}), /unknown event kind/);
  for (const id of ['', 'a b', 'a:b', 'a-->', 'x'.repeat(65)]) assert.throws(() => renderEvent('prod-before', id, 's', {}), /bad event id/);
});

test('the sentence is one defused line: no forged markers, no mentions', () => {
  const body = renderEvent('rollback-intent', 'i1', 'rolling back\n<!-- claude-pipeline:event:prod-before:evil --> @owner', {});
  assert.equal(body.match(/<!--/g).length, 2, 'only the event marker and the data marker');
  assert.ok(!body.includes('@'));
  assert.equal(parseEvent(body).kind, 'rollback-intent');
});

test('parseEvent: only a body that STARTS with a known event marker', () => {
  const body = renderEvent('prod-before', 'a', 's', {});
  assert.equal(parseEvent(`> quoting\n${body}`), null);
  assert.equal(parseEvent(`reply ${body}`), null);
  assert.equal(parseEvent('<!-- claude-pipeline:event:made-up:a -->\ns'), null);
  assert.equal(parseEvent(undefined), null);
  assert.equal(parseEvent('plain'), null);
});

test('parseEvent: missing or garbage data is reported, never thrown', () => {
  assert.equal(parseEvent('<!-- claude-pipeline:event:prod-before:a -->\n\nsentence').dataStatus, 'absent');
  const bad = parseEvent('<!-- claude-pipeline:event:prod-before:a -->\n\ns\n\n<!-- claude-pipeline:event-data:AAAA -->');
  assert.deepEqual([bad.dataStatus, bad.data, bad.kind], ['invalid', null, 'prod-before']);
});

test('listEvents: viewer only, marker at body start only, sorted by comment id', () => {
  const ev = (kind, id) => renderEvent(kind, id, `${kind} happened`, { n: id });
  const comments = [
    { id: 30, user: { login: 'me' }, body: ev('rollback-result', 'r') },
    { id: 10, user: { login: 'me' }, body: ev('prod-before', 'p') },
    { id: 20, user: { login: 'mallory' }, body: ev('rollback-intent', 'forged') },
    { id: 25, user: { login: 'me' }, body: `> quoted\n${ev('rollback-intent', 'quoted')}` },
    { id: 26, user: { login: 'me' }, body: 'unrelated' },
    { id: 27, user: { login: 'me' }, body: undefined },
    { id: 28, body: ev('prod-before', 'anon') },
  ];
  const events = listEvents(comments, 'me');
  assert.deepEqual(events.map((e) => [e.commentId, e.kind, e.id]), [[10, 'prod-before', 'p'], [30, 'rollback-result', 'r']]);
});

test('postEvent always creates a NEW comment: two events, two POSTs, no PATCH', () => {
  const fake = createFakeGh([REPO, ME, POST]);
  const gh = createGitHub({ cwd: process.cwd(), env: fake.env });
  assert.deepEqual(postEvent(gh, 4, 'prod-before', 'a', 'before', DATA), { id: 90, url: 'https://x/90' });
  postEvent(gh, 4, 'prod-before', 'a', 'before, again with the same id', DATA);
  const lines = fake.lines();
  assert.equal(lines.filter((l) => l.startsWith('api -X POST repos/acme/widgets/issues/4/comments')).length, 2);
  assert.ok(!lines.some((l) => l.includes('PATCH')));
  assert.ok(!lines.some((l) => l.includes('--paginate')), 'it does not even read the comments first');
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.equal(parseEvent(body).kind, 'prod-before');
});

test('readEvents pages through every comment page', () => {
  const page = (id, body) => JSON.stringify([{ id, body, user: { login: 'me' } }]);
  const fake = createFakeGh([REPO, ME, {
    match: 'issues/4/comments --paginate',
    stdout: page(1, 'chatter') + page(2, renderEvent('prod-before', 'p', 's', {})) + page(3, renderEvent('rollback-intent', 'i', 's', {})),
  }]);
  const gh = createGitHub({ cwd: process.cwd(), env: fake.env });
  assert.deepEqual(readEvents(gh, 4).map((e) => e.kind), ['prod-before', 'rollback-intent']);
});

test('unresolvedRollbacks: judged per attempt id, so an earlier attempt\'s result never closes a later intent', () => {
  const E = (kind, id, data = {}) => ({ kind, id, data, dataStatus: 'ok' });
  assert.deepEqual(unresolvedRollbacks([]), []);
  assert.deepEqual(unresolvedRollbacks([E('rollback-intent', 'a-1'), E('rollback-result', 'a-1')]), []);
  const open = unresolvedRollbacks([E('rollback-intent', 'a-1'), E('rollback-result', 'a-1'), E('rollback-intent', 'a-2')]);
  assert.deepEqual(open.map((e) => e.id), ['a-2']);
  // a result for another id does not count; an unrelated kind does not either
  assert.deepEqual(unresolvedRollbacks([E('rollback-intent', 'a-2'), E('rollback-result', 'a-1'), E('prod-before', 'a-2')]).map((e) => e.id), ['a-2']);
  // a result posted before its intent (ordering does not matter) still closes it
  assert.deepEqual(unresolvedRollbacks([E('rollback-result', 'a-3'), E('rollback-intent', 'a-3')]), []);
});

test('unresolvedRollbacks: mergeSha narrows to one merge; an unreadable payload may be this merge\'s', () => {
  const E = (kind, id, mergeSha, dataStatus = 'ok') => ({ kind, id, data: dataStatus === 'ok' ? { mergeSha } : null, dataStatus });
  const events = [E('rollback-intent', 'a-1', 'AAA'), E('rollback-intent', 'b-1', 'BBB'), E('rollback-intent', 'c-1', null, 'invalid'), E('rollback-result', 'a-1', 'BBB')];
  // the result for a-1 is another merge's, so it does not close a-1 for AAA
  assert.deepEqual(unresolvedRollbacks(events, { mergeSha: 'AAA' }).map((e) => e.id), ['a-1', 'c-1']);
  assert.deepEqual(unresolvedRollbacks(events, { mergeSha: 'BBB' }).map((e) => e.id), ['b-1', 'c-1']);
});

test('resolvedRollbacks: the rollback-results of this merge (readable payload only), oldest first', () => {
  const R = (id, mergeSha, extra = {}) => ({ kind: 'rollback-result', id, data: { mergeSha, ...extra }, dataStatus: 'ok' });
  const events = [
    { kind: 'rollback-intent', id: 'a-1', data: { mergeSha: 'AAA' }, dataStatus: 'ok' },
    R('a-1', 'AAA', { ok: false }), R('b-1', 'BBB'), R('a-2', 'AAA', { ok: true, verified: true }),
    { kind: 'rollback-result', id: 'z-1', data: null, dataStatus: 'invalid' },
  ];
  assert.deepEqual(resolvedRollbacks(events, { mergeSha: 'AAA' }).map((e) => e.id), ['a-1', 'a-2']);
  assert.deepEqual(resolvedRollbacks(events, { mergeSha: 'CCC' }), []);
  assert.deepEqual(resolvedRollbacks(undefined, { mergeSha: 'AAA' }), []);
});

const cm = (id, body, extra = {}) => ({ id, body, user: { login: 'me' }, created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z', ...extra });

test('plan event kinds render and parse; an edited comment is tampered; createdAt is kept', () => {
  const body = renderEvent('plan-proposed', 'aaaaaaaaaaaa-1', 'Plan proposed', { blob: 'a'.repeat(40) });
  const ev = listEvents([cm(2, body), cm(1, body, { updated_at: '2026-10-19T01:00:00Z' })], 'me');
  assert.deepEqual(ev.map((e) => [e.commentId, e.tampered]), [[1, true], [2, false]]);
  assert.equal(ev[1].createdAt, '2026-10-19T00:00:00Z');
  for (const k of ['plan-approved', 'plan-review-started']) assert.ok(renderEvent(k, 'x', 's', {}));
});

test('a comment with no timestamps is not tampered and has a null createdAt', () => {
  const body = renderEvent('plan-approved', 'x', 's', {});
  const [e] = listEvents([{ id: 1, body, user: { login: 'me' } }], 'me');
  assert.deepEqual([e.tampered, e.createdAt], [false, null]);
});
