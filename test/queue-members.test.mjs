// Tests for lib/queue-members.mjs: mapping a merge-queue commit to its member PRs from GitHub's own queue-entry records
// (the D2 chain rule), cross-checked with git data. `read` / `graphql` are scripted fakes standing in for the GitHub API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberStanding, parseQueueRef, queueManifest, recheckManifest } from '../pipeline/lib/queue-members.mjs';

const REPO = 'acme/app';
const sha = (c) => c.repeat(40);
const MAIN = sha('1'); // the default branch tip, and the first entry's base
const A = sha('a'); // queue commit of entry #3
const B = sha('b'); // queue commit of entry #5
const HEAD3 = sha('3');
const HEAD5 = sha('5');
const ref = (pr, base) => `refs/heads/gh-readonly-queue/main/pr-${pr}-${base}`;

const entry = (id, pr, head, headCommit, baseCommit, extra = {}) => ({
  id, state: 'AWAITING_CHECKS', headCommit: headCommit ? { oid: headCommit } : null, baseCommit: baseCommit ? { oid: baseCommit } : null,
  pullRequest: { number: pr, headRefOid: head, baseRefName: 'main' }, ...extra,
});
const TWO = () => [entry('E3', 3, HEAD3, A, MAIN), entry('E5', 5, HEAD5, B, A)];
const commit = (s, subject, parents = 1) => ({ sha: s, parents, subject });
const TWO_COMMITS = () => ({ total: 2, commits: [commit(A, 'Fix the thing (#3)'), commit(B, 'Add the other (#5)')] });

// A scripted GitHub. `compare` is what compare <base>...<Q> shows; `defaultStatus` answers <base>...main (is it on the default branch).
function world({ entries = TWO(), compare = TWO_COMMITS(), defaultStatus = 'identical', prs = {}, graphqlFails = false } = {}) {
  const calls = [];
  const read = (path, jq) => {
    calls.push(path);
    let m = /^repos\/acme\/app\/compare\/([0-9a-f]{40})\.\.\.main$/.exec(path);
    if (m) return `${defaultStatus}\n`;
    m = /^repos\/acme\/app\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=100$/.exec(path);
    if (m) {
      if (compare === null) throw new Error('HTTP 500');
      return `${JSON.stringify(compare)}\n`;
    }
    m = /^repos\/acme\/app\/pulls\/(\d+)$/.exec(path);
    if (m && prs[m[1]]) return `${JSON.stringify(prs[m[1]])}\n`;
    throw new Error(`unscripted read ${path} ${jq}`);
  };
  const graphql = () => {
    if (graphqlFails) throw new Error('GraphQL rate limited');
    return { data: { repository: { mergeQueue: { entries: { nodes: entries } } } } };
  };
  return { read, graphql, calls };
}
const args = (w, over = {}) => ({ read: w.read, graphql: w.graphql, repo: REPO, defaultBranch: 'main', queueSha: B, queueRef: ref(5, A), ...over });

test('parseQueueRef accepts the queue ref; rejects others and other bases', () => {
  assert.deepEqual(parseQueueRef(ref(5, A), 'main'), { pr: 5, baseSha: A });
  assert.deepEqual(parseQueueRef(`gh-readonly-queue/main/pr-12-${MAIN}`, 'main'), { pr: 12, baseSha: MAIN });
  assert.deepEqual(parseQueueRef(`refs/heads/gh-readonly-queue/release/x/pr-9-${MAIN}`, 'release/x'), { pr: 9, baseSha: MAIN });
  assert.equal(parseQueueRef(ref(5, A), 'develop'), null, 'another base branch');
  assert.equal(parseQueueRef('refs/heads/main', 'main'), null);
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/main/pr-5-${A.slice(1)}`, 'main'), null, 'short sha');
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/main/pr-0-${A}`, 'main'), null, 'PR numbers start at 1');
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/main/pr-5-${A}/extra`, 'main'), null);
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/main/pr-5-${A.toUpperCase()}`, 'main'), null);
  assert.equal(parseQueueRef(undefined, 'main'), null);
});

test('manifest: 2 commits <-> 2 live entries => #3, #5 with heads and entry ids', async () => {
  const r = await queueManifest(args(world()));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.manifest, {
    queueSha: B,
    base: MAIN,
    members: [
      { pr: 3, head: HEAD3, entryId: 'E3', commit: A, baseCommit: MAIN },
      { pr: 5, head: HEAD5, entryId: 'E5', commit: B, baseCommit: A },
    ],
  });
});

test('manifest: the first entry alone (queue ref names the main tip) => one member', async () => {
  const w = world({ entries: TWO(), compare: { total: 1, commits: [commit(A, 'Fix the thing (#3)')] } });
  const r = await queueManifest(args(w, { queueSha: A, queueRef: ref(3, MAIN) }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.manifest.members.map((m) => m.pr), [3]);
  assert.equal(r.manifest.base, MAIN);
});

test('manifest: a predecessor that already merged ends the chain; its commit (on the default branch) is the base', async () => {
  // #3 merged: only #5 is live, its baseCommit A is now an ancestor of (here: equal to) the default tip.
  const w = world({ entries: [entry('E5', 5, HEAD5, B, A)], compare: { total: 1, commits: [commit(B, 'Add the other (#5)')] } });
  const r = await queueManifest(args(w));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.manifest.base, A);
  assert.deepEqual(r.manifest.members.map((m) => m.pr), [5]);
});

test('manifest: chain base that is NOT on the default branch => not ok', async () => {
  const w = world({ entries: [entry('E5', 5, HEAD5, B, A)], compare: { total: 1, commits: [commit(B, 'Add the other (#5)')] }, defaultStatus: 'diverged' });
  const r = await queueManifest(args(w));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not on the default branch/);
});

test('manifest: subject (#5) on the commit of entry #6 => not ok', async () => {
  const entries = [entry('E3', 3, HEAD3, A, MAIN), entry('E6', 6, sha('6'), B, A)];
  const r = await queueManifest(args(world({ entries }), { queueRef: ref(6, A) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /subject/);
});

test('manifest: stale queue commit (no live entry has headCommit == Q) => not ok', async () => {
  // #5 was pushed and re-enqueued: its live entry now has a different queue commit.
  const entries = [entry('E3', 3, HEAD3, A, MAIN), entry('E5b', 5, sha('9'), sha('c'), A)];
  const r = await queueManifest(args(world({ entries })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no live queue entry/);
});

test('manifest: a QUEUED entry (null headCommit) is never a match', async () => {
  const r = await queueManifest(args(world({ entries: [entry('E5', 5, HEAD5, null, null)] })));
  assert.equal(r.ok, false);
});

test('manifest: compare lists 250 commits => not ok (incomplete)', async () => {
  const many = Array.from({ length: 100 }, (_, i) => commit(sha('d'), `c${i} (#${i + 1})`));
  const r = await queueManifest(args(world({ compare: { total: 250, commits: many } })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /incomplete|250/);
});

test('manifest: compare shows fewer commits than it counts => not ok', async () => {
  const r = await queueManifest(args(world({ compare: { total: 3, commits: TWO_COMMITS().commits } })));
  assert.equal(r.ok, false);
});

test('manifest: merge commit (2 parents) => not ok', async () => {
  const compare = { total: 2, commits: [commit(A, 'Fix the thing (#3)'), commit(B, 'Add the other (#5)', 2)] };
  const r = await queueManifest(args(world({ compare })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /parent/);
});

test('manifest: compare lists other commits than the chain => not ok', async () => {
  const compare = { total: 2, commits: [commit(sha('f'), 'Fix the thing (#3)'), commit(B, 'Add the other (#5)')] };
  assert.equal((await queueManifest(args(world({ compare })))).ok, false);
  const reordered = { total: 2, commits: [commit(B, 'Add the other (#5)'), commit(A, 'Fix the thing (#3)')] };
  assert.equal((await queueManifest(args(world({ compare: reordered })))).ok, false);
});

test('manifest: the queue ref must agree with the top entry (PR number and base commit)', async () => {
  assert.equal((await queueManifest(args(world(), { queueRef: ref(3, A) }))).ok, false, 'PR number');
  assert.equal((await queueManifest(args(world(), { queueRef: ref(5, MAIN) }))).ok, false, 'base commit');
  assert.equal((await queueManifest(args(world(), { queueRef: 'refs/heads/main' }))).ok, false, 'not a queue ref');
});

test('manifest: duplicate PR numbers, a foreign base branch, a broken cycle => not ok', async () => {
  const dup = [entry('E3', 3, HEAD3, A, MAIN), entry('E3b', 3, HEAD5, B, A)];
  assert.equal((await queueManifest(args(world({ entries: dup }), { queueRef: ref(3, A) }))).ok, false);
  const foreign = TWO();
  foreign[0].pullRequest.baseRefName = 'develop';
  assert.equal((await queueManifest(args(world({ entries: foreign })))).ok, false);
  const cycle = [entry('E3', 3, HEAD3, A, B), entry('E5', 5, HEAD5, B, A)];
  assert.equal((await queueManifest(args(world({ entries: cycle })))).ok, false);
});

test('manifest: unreadable queue or compare => not ok with a reason, never a throw', async () => {
  const q = await queueManifest(args(world({ graphqlFails: true })));
  assert.equal(q.ok, false);
  assert.match(q.reason, /queue.*(unreadable|could not)/i);
  const c = await queueManifest(args(world({ compare: null })));
  assert.equal(c.ok, false);
  const none = await queueManifest(args({ read: () => '', graphql: () => ({ data: { repository: { mergeQueue: null } } }) }));
  assert.equal(none.ok, false);
  const bad = await queueManifest({ ...args(world()), queueSha: 'nope' });
  assert.equal(bad.ok, false);
});

// --- recheckManifest: what --publish asks again (round-2 finding 4) ---

const manifestOf = async (w = world()) => (await queueManifest(args(w))).manifest;
const merged = (mergeCommit) => ({ state: 'closed', merged: true, mergeCommit });

test('recheck: everything unchanged => ok', async () => {
  const r = await recheckManifest({ ...args(world()), manifest: await manifestOf() });
  assert.equal(r.ok, true, r.reason);
});

test('recheck: the top entry moved (new id, new head, new base, new PR head) => not ok', async () => {
  const m = await manifestOf();
  const moved = (mut) => {
    const e = TWO();
    mut(e[1]);
    return recheckManifest({ ...args(world({ entries: e })), manifest: m });
  };
  assert.equal((await moved((e) => { e.id = 'E5new'; })).ok, false, 'same PR re-created with a new id');
  assert.equal((await moved((e) => { e.headCommit = { oid: sha('c') }; })).ok, false);
  assert.equal((await moved((e) => { e.baseCommit = { oid: sha('c') }; })).ok, false);
  assert.equal((await moved((e) => { e.pullRequest.headRefOid = sha('c'); })).ok, false);
  const gone = await recheckManifest({ ...args(world({ entries: [entry('E3', 3, HEAD3, A, MAIN)] })), manifest: m });
  assert.equal(gone.ok, false);
});

test('recheck: predecessor A merged at its own entry commit => still ok', async () => {
  const m = await manifestOf();
  const w = world({ entries: [entry('E5', 5, HEAD5, B, A)], prs: { 3: merged(A) } });
  const r = await recheckManifest({ ...args(w), manifest: m });
  assert.equal(r.ok, true, r.reason);
});

test('recheck: predecessor removed (not merged), merged at another commit, or its commit off the default branch => not ok', async () => {
  const m = await manifestOf();
  const only5 = [entry('E5', 5, HEAD5, B, A)];
  const open = await recheckManifest({ ...args(world({ entries: only5, prs: { 3: { state: 'open', merged: false, mergeCommit: null } } })), manifest: m });
  assert.equal(open.ok, false);
  const other = await recheckManifest({ ...args(world({ entries: only5, prs: { 3: merged(sha('c')) } })), manifest: m });
  assert.equal(other.ok, false);
  const off = await recheckManifest({ ...args(world({ entries: only5, prs: { 3: merged(A) }, defaultStatus: 'diverged' })), manifest: m });
  assert.equal(off.ok, false);
  const unreadable = await recheckManifest({ ...args(world({ entries: only5 })), manifest: m });
  assert.equal(unreadable.ok, false, 'PR state unreadable');
});

test('recheck: a predecessor still live but changed (head pushed elsewhere / re-created) => not ok', async () => {
  const m = await manifestOf();
  const e = TWO();
  e[0].pullRequest.headRefOid = sha('c');
  assert.equal((await recheckManifest({ ...args(world({ entries: e })), manifest: m })).ok, false);
  const f = TWO();
  f[0].id = 'E3new';
  assert.equal((await recheckManifest({ ...args(world({ entries: f, prs: { 3: { state: 'open', merged: false, mergeCommit: null } } })), manifest: m })).ok, false);
});

test('recheck: unreadable queue => not ok', async () => {
  const m = await manifestOf();
  assert.equal((await recheckManifest({ ...args(world({ graphqlFails: true })), manifest: m })).ok, false);
});

// --- memberStanding: the poster's member check after a predecessor may have merged (eaglewatch#1769) ---

test('memberStanding: live, settled (merged at its own entry commit on the default branch), gone, unknown', async () => {
  const m = await manifestOf();
  const [a, b] = m.members;
  const only5 = [entry('E5', 5, HEAD5, B, A)];
  const ask = (w, member) => memberStanding({ ...args(w), member });
  assert.deepEqual(await ask(world(), a), { kind: 'live' }, 'still in the queue');
  assert.deepEqual(await ask(world({ entries: only5, prs: { 3: merged(A) } }), a), { kind: 'settled' });
  assert.deepEqual(await ask(world({ entries: [] }), b), { kind: 'live' }, 'the top entry owns the queue commit: never settled');
  assert.equal((await ask(world({ entries: only5, prs: { 3: merged(sha('c')) } }), a)).kind, 'gone', 'merged at another commit');
  assert.equal((await ask(world({ entries: only5, prs: { 3: { state: 'open', merged: false, mergeCommit: null } } }), a)).kind, 'gone', 'left unmerged');
  assert.equal((await ask(world({ entries: only5, prs: { 3: merged(A) }, defaultStatus: 'diverged' }), a)).kind, 'gone', 'its commit is not on the default branch');
  assert.equal((await ask(world({ entries: only5 }), a)).kind, 'unknown', 'the PR cannot be read');
  assert.equal((await ask(world({ graphqlFails: true }), a)).kind, 'unknown', 'the queue cannot be read');
});
