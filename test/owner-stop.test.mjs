// Owner stops (owner_approval: chat): creation, the local pending file, the flush, and the reader. In process, against an in-memory
// stand-in for the GitHub client (the real client is sync, so a "gate" is a hook that runs inside one of its calls). Pending files and
// locks go under a private temp home (deps.home), never the real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnerStop, flushPendingStops, ownerStopProblems, removePendingStop, ownerStopsDir, stopReplyLines } from '../pipeline/lib/owner-stop.mjs';
import { listEvents, openOwnerStops, parseEvent, renderEvent } from '../pipeline/lib/run-events.mjs';
import { UnavailableError } from '../pipeline/lib/cli.mjs';
import { GhError } from '../pipeline/lib/proc.mjs';
import { acquire, release } from '../pipeline/lib/locks.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 })));
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const PR = 41;
const HEAD = 'a'.repeat(40);
const REMOTE = 'git@github.com:acme/widgets.git';

// An in-memory GitHub: one PR's comments, a call log, and switches to make single calls fail.
function fakeGh({ comments = [], me = 'me' } = {}) {
  const log = [];
  const g = { comments, log, fail: {}, onList: null, onPost: null };
  let next = 500;
  const boom = (what) => new GhError({ code: 1, stderr: `HTTP 502 (${what})`, args: [what] });
  g.viewer = () => { log.push('viewer'); if (g.fail.viewer) throw boom('viewer'); return me; };
  g.listComments = () => {
    log.push('list');
    g.onList?.();
    if (g.fail.list) throw boom('list');
    return g.comments.map((c) => ({ ...c }));
  };
  g.createComment = (n, body) => {
    log.push('post');
    g.onPost?.(body);
    if (g.fail.post === 'lost') throw boom('post');
    const c = { id: next++, user: { login: me }, body };
    if (g.fail.post === 'landed') { g.comments.push(c); throw boom('post timed out'); }
    if (g.fail.post) throw boom('post');
    g.comments.push(c);
    return { id: c.id, url: `https://x/${c.id}` };
  };
  g.events = () => listEvents(g.comments, me);
  g.stops = () => g.events().filter((e) => e.kind === 'owner-stop');
  return g;
}

// A fresh home + deps; ids come from a queue so tests can name them.
function rig({ ids = ['11111111', '22222222', '33333333'], disarm = () => true, remoteUrl = () => REMOTE } = {}) {
  const home = tmp('cp-owner-stop-');
  const queue = [...ids];
  const calls = [];
  const deps = {
    home, remoteUrl, newId: () => queue.shift(), now: () => Date.parse('2026-10-20T08:00:00Z'), hostname: () => 'box',
    disableAutoMerge: (a) => { calls.push(['disarm', a.pr]); return disarm(a); },
    lock: { waitMs: 5000, pollMs: 5 },
  };
  const files = () => (existsSync(ownerStopsDir(home)) ? readdirSync(ownerStopsDir(home)) : []);
  return { home, deps, calls, files };
}
const root = '/nonexistent-root';
const open = (g, r, extra = {}) => openOwnerStop({ gh: g, pr: PR, root, cause: 'merge:command-failed', head: HEAD, env: {}, deps: r.deps, ...extra });
const releaseEvent = (id, cid = 900) => ({ id: cid, user: { login: 'me' }, body: renderEvent('owner-stop-released', id, 'released', { id }) });

test('opened: the pending file exists before the first GitHub call and is gone after the event posts; event data and reply lines exact', async () => {
  const r = rig();
  const g = fakeGh();
  const seen = [];
  g.onList = () => seen.push(['list', r.files()]);
  g.onPost = () => seen.push(['post', r.files()]);
  const out = await open(g, r);
  assert.deepEqual(r.calls, [['disarm', PR]]);
  assert.deepEqual(seen.map(([k, f]) => [k, f.length]), [['list', 1], ['post', 1]], 'one pending file at the events read and at the post');
  assert.match(seen[0][1][0], /^acme__widgets__41__11111111\.json$/);
  assert.deepEqual(r.files(), [], 'deleted once the event is posted');
  assert.deepEqual(g.log, ['list', 'viewer', 'post'], 'the first gh call is the events read');
  const [ev] = g.stops();
  assert.equal(ev.id, '11111111');
  assert.equal(ev.sentence, "Owner stop 11111111 on #41 (merge:command-failed): only the owner's reply releases it.");
  assert.deepEqual(ev.data, { repo: 'acme/widgets', pr: PR, id: '11111111', cause: 'merge:command-failed', head: HEAD, at: '2026-10-20T08:00:00.000Z', host: 'box', autoMergeDisarmed: true });
  assert.equal(out.id, '11111111');
  assert.deepEqual(out.stop, { id: '11111111', cause: 'merge:command-failed', head: HEAD, at: '2026-10-20T08:00:00.000Z' });
  assert.equal(out.reply, 'Stopped #41 · stop 11111111\n⏸ Waiting on you for #41 — rule in chat, then say "ship resume 41"');
  assert.equal(out.reused, false);
});

test('a second call reuses the open stop id and writes no second event', async () => {
  const r = rig();
  const g = fakeGh();
  await open(g, r);
  const again = await open(g, r);
  assert.equal(again.id, '11111111');
  assert.equal(again.reused, true);
  assert.equal(g.stops().length, 1);
  assert.deepEqual(r.files(), [], 'our own candidate file is deleted');
  assert.equal(again.stop.cause, 'merge:command-failed', 'the display copy follows the existing event');
});

test('repo identity comes from the local remote: no gh call before the pending write; no remote => stop-not-persisted and nothing claimed', async () => {
  const r = rig({ remoteUrl: () => { throw new Error('no remote'); } });
  const g = fakeGh();
  await assert.rejects(open(g, r), (e) => e.exitCode === 1 && e.output.error === 'stop-not-persisted');
  assert.deepEqual(g.log, []);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.files(), []);
});

test('1a: auto-merge is disarmed before the events read and the result lands in the event; a failed disarm still posts and the reply warns', async () => {
  const r = rig({ disarm: () => false });
  const g = fakeGh();
  const order = [];
  g.onList = () => order.push('list');
  r.deps.disableAutoMerge = () => { order.push('disarm'); return false; };
  const out = await open(g, r);
  assert.deepEqual(order, ['disarm', 'list']);
  assert.equal(g.stops()[0].data.autoMergeDisarmed, false);
  assert.equal(out.autoMergeDisarmed, false);
  assert.equal(out.reply.split('\n')[0], `⚠ auto-merge could not be disarmed on #${PR}: run gh pr merge ${PR} --disable-auto`);
  assert.equal(out.reply.split('\n')[1], 'Stopped #41 · stop 11111111');
  // a throwing disarm is "unknown", not an abort
  const r2 = rig();
  r2.deps.disableAutoMerge = () => { throw new Error('gh missing'); };
  const g2 = fakeGh();
  await open(g2, r2);
  assert.equal(g2.stops()[0].data.autoMergeDisarmed, null);
});

test('1a: ownerStopProblems reports an armed auto-merge on a stopped PR; label mode adds nothing and makes no gh call', async () => {
  const r = rig();
  const g = fakeGh();
  await open(g, r);
  g.log.length = 0;
  const armed = await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', autoMergeRequest: { enabledAt: 'x' }, deps: r.deps });
  assert.equal(armed.length, 2);
  assert.match(armed[0], /owner stop 11111111 \(merge:command-failed\) is open/);
  assert.match(armed[1], /auto-merge is armed on a stopped PR: gh pr merge 41 --disable-auto/);
  const clear = await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', autoMergeRequest: null, deps: r.deps });
  assert.equal(clear.length, 1);
  g.log.length = 0;
  assert.deepEqual(await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'label', autoMergeRequest: { enabledAt: 'x' }, deps: r.deps }), []);
  assert.deepEqual(g.log, [], 'label mode: zero gh calls');
});

test('1b: the FIRST events read failing keeps the pending file, exits 3 naming the id; readers refuse; with GitHub back the flush posts the SAME id', async () => {
  const r = rig();
  const g = fakeGh();
  g.fail.list = true;
  await assert.rejects(open(g, r), (e) => e instanceof UnavailableError && e.stopId === '11111111' && /owner stop 11111111 is held locally/.test(e.message) && /Stopped #41 · stop 11111111/.test(e.reply));
  assert.equal(r.files().length, 1);
  const down = await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps });
  assert.ok(down.length >= 1 && down.some((p) => /11111111/.test(p)), `blocks while GitHub is down: ${down}`);
  g.fail.list = false;
  const blocked = await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps });
  assert.equal(g.stops().length, 1, 'the flush ran and posted');
  assert.equal(g.stops()[0].id, '11111111', 'the SAME id');
  assert.ok(blocked.some((p) => /owner stop 11111111 \(merge:command-failed\) is open/.test(p)), 'and the open stop blocks');
  assert.deepEqual(r.files(), []);
});

test('2: GitHub down at the post: exit 3, pending stays, blocked; the flush posts the same id; a landed-but-timed-out post is not duplicated', async () => {
  const r = rig();
  const g = fakeGh();
  g.fail.post = 'lost';
  await assert.rejects(open(g, r), (e) => e instanceof UnavailableError && /11111111/.test(e.message));
  assert.equal(r.files().length, 1);
  const pending = JSON.parse(readFileSync(join(ownerStopsDir(r.home), r.files()[0]), 'utf8'));
  assert.deepEqual([pending.state, pending.stop.id, pending.detail.autoMergeDisarmed], ['unposted', '11111111', true]);
  assert.ok((await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps })).some((p) => /11111111/.test(p)));
  g.fail.post = false;
  const f = await flushPendingStops({ gh: g, pr: PR, root, deps: r.deps });
  assert.deepEqual([f.ok, f.posted], [true, ['11111111']]);
  assert.equal(g.stops().length, 1);
  assert.deepEqual(r.files(), []);

  // landed but the reply was lost
  const r2 = rig({ ids: ['44444444'] });
  const g2 = fakeGh();
  g2.fail.post = 'landed';
  await assert.rejects(open(g2, r2), UnavailableError);
  assert.equal(g2.stops().length, 1, 'it did land');
  g2.fail.post = false;
  const f2 = await flushPendingStops({ gh: g2, pr: PR, root, deps: r2.deps });
  assert.deepEqual([f2.ok, f2.posted], [true, []], 'seen on the list: not posted again');
  assert.equal(g2.stops().length, 1);
  assert.deepEqual(r2.files(), []);
});

test('3: a corrupt pending file fails closed; a local write failure is stop-not-persisted', async () => {
  const r = rig();
  const g = fakeGh();
  mkdirSync(ownerStopsDir(r.home), { recursive: true });
  writeFileSync(join(ownerStopsDir(r.home), 'acme__widgets__41__deadbeef.json'), '{not json');
  const probs = await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps });
  assert.ok(probs.some((p) => /deadbeef.*unreadable pending stop file/.test(p)), String(probs));
  // another PR's file does not matter
  writeFileSync(join(ownerStopsDir(r.home), 'acme__widgets__42__cafebabe.json'), '{not json');
  assert.equal((await ownerStopProblems({ gh: g, pr: 43, root, ownerApproval: 'chat', deps: r.deps })).length, 0);
  // the folder cannot be written: `.claude` is a regular file
  const bad = tmp('cp-owner-stop-bad-');
  writeFileSync(join(bad, '.claude'), 'x');
  const g2 = fakeGh();
  await assert.rejects(open(g2, { ...r, deps: { ...r.deps, home: bad } }), (e) => e.exitCode === 1 && e.output.error === 'stop-not-persisted' && /nothing was posted/.test(e.output.message));
  assert.deepEqual(g2.log, []);
});

test('4: two open stops (cross-machine race) both block, the reply lists both ids, and a release of one leaves the other open', async () => {
  const r = rig();
  const g = fakeGh({ comments: [] });
  const mk = (id, cid) => ({ id: cid, user: { login: 'me' }, body: renderEvent('owner-stop', id, 's', { repo: 'acme/widgets', pr: PR, id, cause: 'c', head: null, at: '2026-10-20T07:00:00.000Z', host: 'h', autoMergeDisarmed: true }) });
  g.comments.push(mk('aaaaaaaa', 10), mk('bbbbbbbb', 11));
  const probs = await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps });
  assert.equal(probs.length, 2);
  const out = await open(g, r);
  assert.deepEqual(out.ids, ['aaaaaaaa', 'bbbbbbbb']);
  assert.equal(out.reply, 'Stopped #41 · stop aaaaaaaa\nStopped #41 · stop bbbbbbbb\n⏸ Waiting on you for #41 — rule in chat, then say "ship resume 41"');
  assert.equal(g.stops().length, 2, 'nothing collapses them');
  g.comments.push(releaseEvent('aaaaaaaa'));
  assert.deepEqual(openOwnerStops(g.events()).map((e) => e.id), ['bbbbbbbb']);
});

test('4b(i): with the lock, session B waits and ends up reusing the one stop A posted; both pending files are gone and only one event exists', async () => {
  const r = rig({ ids: ['aaaaaaaa', 'bbbbbbbb'] });
  const g = fakeGh();
  let started;
  let b;
  g.onList = () => {
    if (started) return;
    started = true;
    // A is inside its critical section (holds the lock, has read the events): B starts now
    b = open(g, r);
    assert.equal(r.files().length, 2, 'B wrote its own pending file before waiting for the lock');
  };
  const a = await open(g, r);
  const bOut = await b;
  // A flushes the OTHER pending file of the PR (B's, already on disk) before it reconciles, so the one stop that exists is B's candidate
  // and A reuses it; B, after the lock, finds it open and reuses it too. Either way: one event, one id for both, no file left.
  assert.equal(g.stops().length, 1);
  assert.equal(a.id, g.stops()[0].id);
  assert.deepEqual([bOut.id, bOut.reused], [a.id, true]);
  assert.deepEqual(r.files(), []);
});

test('4b(ii): two crashed sessions left S1 and S2; S1 posts, S2\'s POST fails: S1\'s file goes, S2\'s stays and blocks, the next flush posts S2', async () => {
  const r = rig();
  const g = fakeGh();
  // two sessions that each wrote a file and then died before GitHub answered
  for (const [id, at] of [['aaaaaaaa', '2026-10-20T07:00:00.000Z'], ['bbbbbbbb', '2026-10-20T07:01:00.000Z']]) {
    g.fail.list = true;
    r.deps.newId = () => id;
    r.deps.now = () => Date.parse(at);
    await assert.rejects(open(g, r), UnavailableError);
  }
  g.fail.list = false;
  assert.equal(r.files().length, 2);
  let posts = 0;
  g.onPost = () => { posts += 1; if (posts === 2) g.fail.post = 'lost'; };
  const f = await flushPendingStops({ gh: g, pr: PR, root, deps: r.deps });
  assert.equal(f.ok, false);
  assert.deepEqual(f.posted, ['aaaaaaaa']);
  assert.deepEqual(f.remaining.map((x) => x.id), ['bbbbbbbb']);
  assert.deepEqual(r.files(), ['acme__widgets__41__bbbbbbbb.json']);
  assert.ok((await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps })).some((p) => /bbbbbbbb/.test(p)), 'still blocked');
  g.fail.post = false;
  const f2 = await flushPendingStops({ gh: g, pr: PR, root, deps: r.deps });
  assert.deepEqual([f2.ok, f2.posted], [true, ['bbbbbbbb']]);
  assert.deepEqual(g.stops().map((e) => e.id).sort(), ['aaaaaaaa', 'bbbbbbbb']);
  assert.deepEqual(r.files(), []);
});

test('4b: cleanup is identity-checked: a file whose stop id, repo or PR is not the one confirmed is left alone; removePendingStop removes only its id', async () => {
  const r = rig();
  const g = fakeGh();
  g.fail.list = true;
  await assert.rejects(open(g, r), UnavailableError);
  const name = r.files()[0];
  const file = join(ownerStopsDir(r.home), name);
  const good = JSON.parse(readFileSync(file, 'utf8'));
  // the file's content names ANOTHER stop than its name: not ours to delete, and it blocks
  writeFileSync(file, JSON.stringify({ ...good, stop: { ...good.stop, id: 'deadbeef' } }));
  g.fail.list = false;
  const f = await flushPendingStops({ gh: g, pr: PR, root, deps: r.deps });
  assert.equal(f.ok, false);
  assert.deepEqual(r.files(), [name], 'left alone');
  // restore it; removing another id does nothing, removing its own id deletes it
  writeFileSync(file, JSON.stringify(good));
  assert.equal(await removePendingStop({ pr: PR, root, id: '99999999', deps: r.deps }), true);
  assert.deepEqual(r.files(), [name]);
  assert.equal(await removePendingStop({ pr: PR, root, id: '11111111', deps: r.deps }), true);
  assert.deepEqual(r.files(), []);
});

test('5: label mode makes no gh call, reads no files and never opens anything', async () => {
  const r = rig();
  const g = fakeGh();
  assert.deepEqual(await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'label', deps: r.deps }), []);
  assert.deepEqual(await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: undefined, deps: r.deps }), []);
  assert.deepEqual(g.log, []);
  assert.deepEqual(r.files(), []);
});

test('a leftover stop file does not suppress an already-open stop, and a released stop no longer blocks', async () => {
  const r = rig();
  const g = fakeGh();
  await open(g, r);
  g.comments.push(releaseEvent('11111111'));
  assert.deepEqual(await ownerStopProblems({ gh: g, pr: PR, root, ownerApproval: 'chat', deps: r.deps }), []);
  const p = parseEvent(g.comments[0].body);
  assert.equal(p.kind, 'owner-stop');
});

test('stopReplyLines: the wait line is last; a disarm warning goes above the Stopped lines', () => {
  assert.deepEqual(stopReplyLines({ pr: 7, ids: ['aaaaaaaa'] }), ['Stopped #7 · stop aaaaaaaa', '⏸ Waiting on you for #7 — rule in chat, then say "ship resume 7"']);
  assert.equal(stopReplyLines({ pr: 7, ids: ['a'], autoMergeDisarmed: false })[0].startsWith('⚠ auto-merge could not be disarmed on #7'), true);
  assert.equal(stopReplyLines({ pr: 7, ids: ['a'], autoMergeDisarmed: null })[0], 'Stopped #7 · stop a', 'unknown (no disarm result) is not a warning');
});

test('a busy stop lock is exit 3 with the pending file left in place (the PR stays blocked)', async () => {
  const r = rig();
  const g = fakeGh();
  const held = await acquire('owner-stop-acme__widgets__41', { dir: join(r.home, '.claude', 'pipeline-state', 'locks') });
  try {
    r.deps.lock = { waitMs: 60, pollMs: 10 };
    await assert.rejects(open(g, r), (e) => e instanceof UnavailableError && /owner stop 11111111 is held locally/.test(e.message));
    assert.equal(r.files().length, 1);
    assert.deepEqual(g.log, []);
  } finally {
    release(held);
  }
});
