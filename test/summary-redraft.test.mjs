// `pipeline summary` on a DRAFT that the pipeline itself turned back to draft (`pipeline redraft`) and nobody has marked ready since: one line in the comment
// ("Back to draft for fixes since <time> (<age>)") and `redraft: {draftSince}` in the output; anything else adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, scenario, ghEntries, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const convert = (login, at) => ({ event: 'converted_to_draft', created_at: at, actor: { login } });
const ready = (at) => ({ event: 'ready_for_review', created_at: at, actor: { login: 'me' } });

function world({ isDraft = true, timeline = [], timelineReply = null } = {}) {
  const s = scenario();
  s.fake.setScript(ghEntries({
    prHead: s.head,
    comments: [],
    extra: [
      { match: '^pr view 12 --json title', stdoutJson: { title: 'T', headRefName: 'agent/feature', baseRefName: 'main', headRefOid: s.head, isDraft } },
      { match: 'issues/12/timeline', ...(timelineReply ?? { stdoutJson: timeline }) },
    ],
  }));
  return s;
}
const summary = (s) => cli(['summary', '--pr', String(PR), '--outcome', 'stopped'], { dir: s.repo.dir, fake: s.fake, env: s.env });
const bodies = (s) => s.fake.calls().filter((c) => c.argv[0] === 'api' && c.argv.includes('-X') && c.stdin).map((c) => JSON.parse(c.stdin).body ?? '');

test('P summary: a draft the pipeline turned back to draft (its own login, no ready after) gets the "Back to draft" line and redraft.draftSince', () => {
  const s = world({ timeline: [convert('someone', '2026-11-12T01:00:00Z'), convert('me', '2026-11-12T02:00:00Z')] });
  const r = summary(s);
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json.redraft, { draftSince: '2026-11-12T02:00:00Z' });
  assert.ok(bodies(s).some((b) => /Back to draft for fixes since 2026-11-12T02:00:00Z \(\d+ (min|h|d)\)/.test(b)), 'the comment carries the line');
});

test('P summary: no line when someone else made it a draft, when it was marked ready after, when the PR is not a draft, or when the timeline cannot be read', () => {
  for (const [label, s] of [
    ['draft by someone else', world({ timeline: [convert('someone', '2026-11-12T02:00:00Z')] })],
    ['ready after the convert', world({ timeline: [convert('me', '2026-11-12T02:00:00Z'), ready('2026-11-12T03:00:00Z')] })],
    ['not a draft', world({ isDraft: false, timeline: [convert('me', '2026-11-12T02:00:00Z')] })],
    ['timeline unreadable', world({ timelineReply: { code: 1, stderr: 'gh: Server Error (HTTP 502)' } })],
  ]) {
    const r = summary(s);
    assertExit(r, 0, `${label}: ${r.stdout}`);
    assert.equal('redraft' in r.json, false, label);
    assert.ok(!bodies(s).some((b) => b.includes('Back to draft')), label);
  }
  const notDraft = world({ isDraft: false, timeline: [convert('me', '2026-11-12T02:00:00Z')] });
  summary(notDraft);
  assert.equal(notDraft.fake.lines().filter((l) => l.includes('/timeline')).length, 0, 'a PR that is not a draft makes no timeline read');
});
