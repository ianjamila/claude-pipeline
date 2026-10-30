import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { EVENT_KINDS, parseEvent, postEvent, renderEvent } from '../pipeline/lib/run-events.mjs';
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
