// Publication of the review state as a compare-and-swap on content (lib/review-publish.mjs), the repo-wide review lock key, `state show` / `discard-round`
// with local verdicts, and the pure rulings inventory and eligibility rules (lib/triage.mjs). Plan 2026-11-05-claude-rulings.md E1, E2 (key), E5, E7, E9, E11.
// Two kinds of test: in-process ones over a tiny in-memory gh (publishTriage's own rules), and CLI ones against the real commands with a gh that remembers
// the PR's comments (test/fixtures/fake-gh-comments.mjs), two worktrees of one repo sharing it.
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createCommentsGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { addRound, decodeFromComment, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { MARKERS, triageComment } from '../pipeline/lib/render.mjs';
import { REVIEW_COMPLETE_MARKER } from '../pipeline/lib/review-marker.mjs';
import { establishBaseline, readBaseline, readPublished, publishTriage, reviewContentHash, writeBaseline } from '../pipeline/lib/review-publish.mjs';
import { reviewLockName } from '../pipeline/lib/review-context.mjs';
import { reviewEligibilityProblems, rulingContentDigest, rulingsBlock, rulingsDigest, rulingsInventory } from '../pipeline/lib/triage.mjs';
import { buildReviewPrompt } from '../pipeline/lib/codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const holdLock = join(here, 'fixtures', 'hold-lock.mjs');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const H = (c) => c.repeat(64);

// ---- synthetic states ------------------------------------------------------------------------

const decided = (over = {}) => ({ decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'fine', ...over });
const waiting = (cause = 'low-confidence') => ({ decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence', cause });
const it = (id, over = {}) => ({
  id, source: 'codex', fingerprint: `fp-${id}`, bucket: 'BLOCKING', category: 'bug', title: `Title ${id}`, file: 'src/a.js', line: 1, detail: `detail ${id}`, final: decided(), ...over,
});
const mk = (items, { n = 1, base = emptyState({ repo: 'acme/widgets', pr: 7, branch: 'feat/x' }) } = {}) =>
  addRound(base, { n, fromHead: 'a'.repeat(40), toHead: 'b'.repeat(40), contentHashAtToHead: H('c'), items });
// A copy of the state with item `id` changed (and optionally a second round added).
const change = (state, id, over) => ({ ...state, rounds: state.rounds.map((r) => ({ ...r, items: r.items.map((i) => (i.id === id ? { ...i, ...over } : i)) })) });
const verdict = (decision = 'REJECT', confidence = 'high') => ({ decision, confidence, reasoning: 'checked', model: 'm', effort: 'high', inputDigest: H('a'), ranAt: '2026-11-05T10:00:00.000Z' });
const claudeFinal = (over = {}) => ({ decision: 'REJECT', by: 'claude', needsHuman: false, reason: 'not real', claude: { ruledAt: 'now', cause: 'low-confidence', critical: true, overruled: waiting() }, ...over });
const published = (state) => decodeFromComment(state);

// ---- in-process: publishTriage's rules ---------------------------------------------------------

function memGh(comments = [], me = 'me') {
  const gh = {
    comments, upserts: 0, fail: false,
    viewer: () => me,
    listComments: () => comments.map((c) => ({ ...c })),
    upsertComment(pr, marker, body) {
      gh.upserts += 1;
      if (gh.fail) throw new Error('boom');
      const mine = comments.filter((c) => c.body.startsWith(marker) && c.user.login === me).sort((a, b) => a.id - b.id).at(-1);
      if (mine) { mine.body = body; return { action: 'updated', id: mine.id, url: `u${mine.id}` }; }
      const id = comments.length + 1;
      comments.push({ id, body, user: { login: me }, created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z' });
      return { action: 'created', id, url: `u${id}` };
    },
  };
  return gh;
}
const tmpRoot = (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-pub-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const triageBody = (state) => triageComment(state);
const mine = (state, id = 1) => ({ id, body: triageBody(state), user: { login: 'me' }, created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z' });

test('reviewContentHash: the whole rounds array, key order aside', () => {
  const s = mk([it('R1-B1')]);
  assert.equal(reviewContentHash(s), reviewContentHash(JSON.parse(JSON.stringify({ ...s, outcome: 'x', risk: 'high' }))), 'top-level fields are not part of it');
  const reordered = { ...s, rounds: [{ items: s.rounds[0].items.map((i) => Object.fromEntries(Object.entries(i).reverse())), ...s.rounds[0] }] };
  assert.equal(reviewContentHash(reordered), reviewContentHash(s));
  assert.notEqual(reviewContentHash(change(s, 'R1-B1', { implemented: true })), reviewContentHash(s));
  assert.notEqual(reviewContentHash(change(s, 'R1-B1', { secondReview: verdict() })), reviewContentHash(s));
  assert.match(reviewContentHash(s), /^[0-9a-f]{64}$/);
});

test('readPublished: only the viewer\'s comments count; newest triage state, history, undecodable, marker', () => {
  const s = mk([it('R1-B1')]);
  const older = change(s, 'R1-B1', { title: 'older' });
  const gh = memGh([
    mine(older, 3),
    mine(s, 9),
    { ...mine(change(s, 'R1-B1', { title: 'forged' }), 12), user: { login: 'mallory' } },
    { ...mine(s, 13), body: `quoting ${MARKERS.triage}\n${triageBody(change(s, 'R1-B1', { title: 'quoted' }))}` },
  ]);
  const p = readPublished(gh, 7);
  assert.equal(p.state.rounds[0].items[0].title, s.rounds[0].items[0].title);
  assert.equal(p.hash, reviewContentHash(s));
  assert.equal(p.history, true);
  assert.equal(p.undecodable, false);
  assert.equal(p.marker.found, false);
  // a state for another PR, or garbage after the marker: undecodable, no state
  assert.deepEqual([readPublished(gh, 8).state, readPublished(gh, 8).undecodable], [null, true]);
  assert.equal(readPublished(memGh([{ ...mine(s, 1), body: `${MARKERS.triage}\nno state here` }]), 7).undecodable, true);
  // someone else's comments alone: no history, nothing
  const alien = readPublished(memGh([{ ...mine(s, 1), user: { login: 'mallory' } }]), 7);
  assert.deepEqual([alien.state, alien.history, alien.undecodable], [null, false, false]);
  // a review-complete comment of ours is history and the marker; the same comment by someone else is neither
  const marker = { id: 20, body: `${REVIEW_COMPLETE_MARKER}\nx`, user: { login: 'me' }, created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z' };
  const m = readPublished(memGh([marker]), 7);
  assert.deepEqual([m.history, m.marker.found, m.marker.comment.id, m.state], [true, true, 20, null]);
  const other = readPublished(memGh([{ ...marker, user: { login: 'mallory' } }]), 7);
  assert.deepEqual([other.history, other.marker.found], [false, false]);
});

test('publishTriage: the first publication creates the comment and records the baseline', (t) => {
  const root = tmpRoot(t);
  const gh = memGh();
  const s = mk([it('R1-B1')]);
  const r = publishTriage({ gh, root, pr: 7, state: s });
  assert.equal(r.action, 'created');
  assert.equal(readBaseline(root, 7), reviewContentHash(s));
  assert.equal(readBaseline(root, 8), null, 'a baseline is for one PR');
  assert.equal(published(gh.comments[0].body).rounds.length, 1);
});

test('publishTriage: allowed when the PR holds what this copy last published; refused when it holds something else', (t) => {
  const root = tmpRoot(t);
  const s0 = mk([it('R1-B1')]);
  const gh = memGh([mine(s0)]);
  writeBaseline(root, 7, reviewContentHash(s0));
  const s1 = change(s0, 'R1-B1', { reason: 'mine' });
  assert.equal(publishTriage({ gh, root, pr: 7, state: s1 }).action, 'updated');
  assert.equal(readBaseline(root, 7), reviewContentHash(s1));
  // somebody else published s2 meanwhile: the baseline (s1) no longer matches the PR
  const s2 = change(s0, 'R1-B1', { reason: 'theirs' });
  gh.comments[0].body = triageBody(s2);
  const before = gh.upserts;
  assert.throws(() => publishTriage({ gh, root, pr: 7, state: change(s1, 'R1-B1', { reason: 'mine again' }) }), (e) => {
    assert.equal(e.exitCode, 1);
    assert.equal(e.output.error, 'stale-publication');
    assert.match(e.output.reason, /pipeline state show --pr 7/);
    return true;
  });
  assert.equal(gh.upserts, before, 'nothing was written');
  assert.equal(readBaseline(root, 7), reviewContentHash(s1), 'the baseline did not move');
});

test('publishTriage: a retry after a crash between the upsert and the baseline write is unchanged, and repairs the baseline', (t) => {
  const root = tmpRoot(t);
  const s0 = mk([it('R1-B1')]);
  const s1 = change(s0, 'R1-B1', { reason: 'mine' });
  const gh = memGh([mine(s1)]); // the upsert of s1 happened ...
  writeBaseline(root, 7, reviewContentHash(s0)); // ... the baseline write did not
  const r = publishTriage({ gh, root, pr: 7, state: s1 });
  assert.equal(r.action, 'unchanged');
  assert.equal(gh.upserts, 0, 'no second write');
  assert.equal(readBaseline(root, 7), reviewContentHash(s1));
});

test('publishTriage: with no baseline only a state that extends the published one may publish (a state from an older CLI)', (t) => {
  const s0 = mk([it('R1-B1')]);
  const extended = mk([it('R2-B1')], { n: 2, base: s0 });
  const root = tmpRoot(t);
  const gh = memGh([mine(s0)]);
  assert.equal(publishTriage({ gh, root, pr: 7, state: extended }).action, 'updated', 'extends: allowed');
  const root2 = tmpRoot(t);
  const gh2 = memGh([mine(s0)]);
  assert.throws(() => publishTriage({ gh: gh2, root: root2, pr: 7, state: change(s0, 'R1-B1', { final: decided({ reason: 'other' }) }) }), (e) => e.output.error === 'stale-publication');
  assert.equal(readBaseline(root2, 7), null);
  // a published comment with no readable state is nothing to protect: it is replaced
  const gh3 = memGh([{ ...mine(s0), body: `${MARKERS.triage}\nold format` }]);
  assert.equal(publishTriage({ gh: gh3, root: tmpRoot(t), pr: 7, state: s0 }).action, 'updated');
});

test('publishTriage: a failed upsert leaves the baseline alone', (t) => {
  const root = tmpRoot(t);
  const gh = memGh();
  gh.fail = true;
  assert.throws(() => publishTriage({ gh, root, pr: 7, state: mk([it('R1-B1')]) }), /boom/);
  assert.equal(readBaseline(root, 7), null);
});

test('establishBaseline (R6-F1): with a baseline already present it makes no GitHub read; without one it reads once and writes it when the states are equal', (t) => {
  const root = tmpRoot(t);
  const s = mk([it('R1-B1')]);
  const gh = memGh([mine(s)]);
  let reads = 0;
  const listComments = gh.listComments;
  gh.listComments = (...a) => { reads += 1; return listComments(...a); };
  assert.equal(establishBaseline({ gh, root, pr: 7, state: s }), true);
  assert.equal(reads, 1, 'no baseline: one comments read');
  assert.equal(readBaseline(root, 7), reviewContentHash(s));
  reads = 0;
  assert.equal(establishBaseline({ gh, root, pr: 7, state: s }), false);
  assert.equal(reads, 0, 'baseline present: no comments read');
  assert.equal(establishBaseline({ gh, root, pr: 7, state: s, published: readPublished(memGh([mine(s)]), 7) }), false, 'a passed published result is still honoured');
});

// ---- CLI: two worktrees of one PR ---------------------------------------------------------------

const CHAT_YML = `${pipelineYml()}owner_approval: chat\n`;

function world(t, { origin = null } = {}) {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-pubw-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', CHAT_YML);
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', 'export const a = 1;\n');
  repo.commit('init');
  if (origin) repo.git(['remote', 'add', 'origin', origin]);
  const dirB = join(scratch, 'wt-b');
  repo.git(['worktree', 'add', '-q', dirB, '-b', 'other']);
  const fake = createCommentsGh([{ match: '^repo view', stdoutJson: { ...REPO_VIEW, nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets' } }]);
  const lockDir = join(scratch, 'locks');
  const w = {
    A: repo.dir, B: dirB, fake, lockDir, scratch, repo,
    cli(dir, args, env = {}) {
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: dir, env: { ...process.env, ...fake.env, PIPELINE_LOCK_DIR: lockDir, ...env }, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* asserted on */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    comment: (dir, env) => w.cli(dir, ['comment', '--pr', '7', '--kind', 'triage'], env),
    show: (dir) => w.cli(dir, ['state', 'show', '--pr', '7']),
    state: (dir) => JSON.parse(readFileSync(join(dir, '.review', 'state.json'), 'utf8')),
    pub: () => decodeFromComment(w.fake.comments().filter((c) => c.body.startsWith(MARKERS.triage)).at(-1).body),
    baseline: (dir) => JSON.parse(readFileSync(join(dir, '.review', 'published-baseline.json'), 'utf8')),
  };
  return w;
}

test('two worktrees: B publishes after restoring, A is refused as stale, and recovers through state show', (t) => {
  const w = world(t);
  const s0 = mk([it('R1-B1'), it('R1-B2')]);
  saveState(w.A, s0);
  const first = w.comment(w.A);
  assertExit(first, 0, first.stdout + first.stderr);
  assert.equal(first.json.action, 'created');
  assert.equal(w.baseline(w.A).hash, reviewContentHash(s0));

  // B has no state: it restores the published one, and its baseline is that state
  const restored = w.show(w.B);
  assertExit(restored, 0, restored.stdout + restored.stderr);
  assert.equal(restored.json.source, 'published');
  assert.deepEqual(w.baseline(w.B), { pr: 7, hash: reviewContentHash(s0) });

  const sB = change(s0, 'R1-B1', { final: decided({ reason: 'B decided' }) });
  saveState(w.B, sB);
  assertExit(w.comment(w.B), 0);
  assert.equal(w.pub().rounds[0].items[0].final.reason, 'B decided');

  // A decided something else from the same base: refused, nothing written, then state show restores B's work and A redoes its decision
  const sA = change(s0, 'R1-B2', { final: decided({ reason: 'A decided' }) });
  saveState(w.A, sA);
  const stale = w.comment(w.A);
  assertExit(stale, 1, stale.stdout);
  assert.equal(stale.json.error, 'stale-publication');
  assert.match(stale.json.reason, /pipeline state show --pr 7/);
  assert.equal(reviewContentHash(w.pub()), reviewContentHash(sB), 'the PR still holds B\'s state');
  const show = w.show(w.A);
  assertExit(show, 0, show.stdout + show.stderr);
  assert.equal(show.json.source, 'quarantined');
  assert.ok(show.json.quarantinedTo.startsWith('.review/stale-'));
  assert.equal(reviewContentHash(w.state(w.A)), reviewContentHash(sB));
  assert.equal(w.baseline(w.A).hash, reviewContentHash(sB));
  assert.equal(w.comment(w.A).json.action, 'unchanged');
});

test('comment --kind triage takes the review lock: a holder in another worktree blocks it, and nothing is published', async (t) => {
  const w = world(t);
  saveState(w.B, mk([it('R1-B1')]));
  const release = join(w.scratch, 'release');
  mkdirSync(w.lockDir, { recursive: true });
  const holder = spawn(process.execPath, [holdLock, w.lockDir, reviewLockName(w.A, 7), '20000', '--release', release]);
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const blocked = w.comment(w.B, { PIPELINE_LOCK_WAIT_MS: '300' });
  assertExit(blocked, 2, blocked.stdout);
  assert.equal(blocked.json.error, 'lock-timeout');
  assert.equal(w.fake.comments().length, 0, 'nothing was published while the lock was held elsewhere');
  writeFileSync(release, '');
  await new Promise((resolve) => holder.once('exit', resolve));
  assertExit(w.comment(w.B), 0);
  assert.equal(w.fake.comments().length, 1);
});

test('comment --kind triage: other kinds take no lock, and a state of another PR is refused', async (t) => {
  const w = world(t);
  saveState(w.A, mk([it('R1-B1')]));
  const release = join(w.scratch, 'release2');
  mkdirSync(w.lockDir, { recursive: true });
  const holder = spawn(process.execPath, [holdLock, w.lockDir, reviewLockName(w.A, 7), '20000', '--release', release]);
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const awaiting = w.cli(w.A, ['comment', '--pr', '7', '--kind', 'awaiting-review', '--reason', 'codex is down'], { PIPELINE_LOCK_WAIT_MS: '300' });
  assertExit(awaiting, 0, awaiting.stdout + awaiting.stderr);
  writeFileSync(release, '');
  await new Promise((resolve) => holder.once('exit', resolve));
  const wrong = w.cli(w.A, ['comment', '--pr', '8', '--kind', 'triage']);
  assertExit(wrong, 2, wrong.stdout);
});

// ---- CLI: state show with local verdicts, discard-round -----------------------------------------

const waitingState = () => mk([it('R1-B1', { final: waiting() }), it('R1-S1', { bucket: 'SUGGESTION', category: 'design', final: waiting() })]);

test('state show: a local second-review verdict or Claude ruling on top of what was published is kept (local-ahead) and publishes later', (t) => {
  for (const [name, edit] of [
    ['verdict', (s) => change(s, 'R1-B1', { secondReview: verdict() })],
    ['claude final', (s) => change(s, 'R1-B1', { final: claudeFinal() })],
    ['forced accept', (s) => change(s, 'R1-B1', { secondReview: verdict('ACCEPT'), final: claudeFinal({ decision: 'ACCEPT', forcedBy: 'second-review' }) })],
  ]) {
    const w = world(t);
    const s0 = waitingState();
    saveState(w.A, s0);
    assertExit(w.comment(w.A), 0);
    const ahead = edit(s0);
    saveState(w.A, ahead);
    const r = w.show(w.A);
    assertExit(r, 0, name + r.stdout + r.stderr);
    assert.equal(r.json.source, 'local-ahead', name);
    assert.match(r.json.warnings.join(' '), /comment --pr 7 --kind triage/, name);
    assert.deepEqual(w.state(w.A), JSON.parse(JSON.stringify(ahead)), `${name}: the local state is untouched`);
    assert.equal(readdirSync(join(w.A, '.review')).filter((n) => n.startsWith('stale-')).length, 0, `${name}: nothing was quarantined`);
    assertExit(w.comment(w.A), 0, name);
    assert.equal(w.show(w.A).json.source, 'local', `${name}: published now`);
  }
});

test('state show: a truly superseded copy is still quarantined (other published state or no baseline); an owner ruling over a waiting item is local-ahead', (t) => {
  // 1. the baseline is not the published hash: another checkout published since
  const a = world(t);
  const s0 = waitingState();
  saveState(a.A, s0);
  assertExit(a.comment(a.A), 0);
  writeBaseline(a.A, 7, H('f'));
  saveState(a.A, change(s0, 'R1-B1', { secondReview: verdict() }));
  assert.equal(a.show(a.A).json.source, 'quarantined');
  // 2. an owner ruling over an item still waiting for a human is local progress, like the owner's override of a Claude final (R2-F1): kept, not restored without it
  const b = world(t);
  saveState(b.A, s0);
  assertExit(b.comment(b.A), 0);
  saveState(b.A, change(s0, 'R1-B1', { final: { decision: 'ACCEPT', by: 'owner', needsHuman: false, reason: 'ok', ownerQuote: 'R1-B1: accept', overruled: waiting() } }));
  assert.equal(b.show(b.A).json.source, 'local-ahead');
  // 3. no baseline file at all (a copy from an older CLI that does not extend the published one)
  const c = world(t);
  saveState(c.A, s0);
  assertExit(c.comment(c.A), 0);
  rmSync(join(c.A, '.review', 'published-baseline.json'));
  saveState(c.A, change(s0, 'R1-B1', { secondReview: verdict() }));
  assert.equal(c.show(c.A).json.source, 'quarantined');
});

test('state show (R5-B2): with no baseline file and a local state equal to the published one it writes the baseline, so the first local decision is local-ahead, not quarantined', (t) => {
  const w = world(t);
  const s0 = waitingState();
  saveState(w.A, s0);
  assertExit(w.comment(w.A), 0);
  rmSync(join(w.A, '.review', 'published-baseline.json')); // a checkout from before the baseline existed
  const same = w.show(w.A);
  assertExit(same, 0, same.stdout + same.stderr);
  assert.equal(same.json.source, 'local');
  assert.deepEqual(w.baseline(w.A), { pr: 7, hash: reviewContentHash(s0) });
  saveState(w.A, change(s0, 'R1-B1', { secondReview: verdict() }));
  assert.equal(w.show(w.A).json.source, 'local-ahead', 'the first decision on a published item is kept');
  // a stale baseline of an equal state is refreshed too
  const w2 = world(t);
  saveState(w2.A, s0);
  assertExit(w2.comment(w2.A), 0);
  writeBaseline(w2.A, 7, H('f'));
  assert.equal(w2.show(w2.A).json.source, 'local');
  assert.equal(w2.baseline(w2.A).hash, reviewContentHash(s0));
  // local != published with no baseline: no baseline is invented, and the copy is quarantined as before
  const w3 = world(t);
  saveState(w3.A, s0);
  assertExit(w3.comment(w3.A), 0);
  rmSync(join(w3.A, '.review', 'published-baseline.json'));
  saveState(w3.A, change(s0, 'R1-B1', { secondReview: verdict() }));
  assert.equal(readBaseline(w3.A, 7), null);
  assert.equal(w3.show(w3.A).json.source, 'quarantined');
});

// A Claude ruling is published, then changed locally (tightened to ACCEPT, or overridden by the owner) and the publication failed or was never made: the PR
// still holds the baseline, so the change is local progress (R1-B2, R1-F1). The same change on top of a PR that moved on is a superseded copy.
const claudeRejected = () => mk([it('R1-B1', { final: claudeFinal() }), it('R1-S1', { bucket: 'SUGGESTION', category: 'design', final: decided() })]);
const tightened = () => claudeFinal({ decision: 'ACCEPT', reason: 'real after all', claude: { ruledAt: 'later', cause: 'low-confidence', critical: false, overruled: claudeFinal() } });
const overridden = () => ({ decision: 'ACCEPT', by: 'owner', needsHuman: false, reason: 'owner says fix', ownerQuote: 'R1-B1: accept', ruledAt: 'later', overruled: claudeFinal() });

test('state show: a published Claude ruling tightened to ACCEPT, or overridden by the owner, locally is kept (local-ahead), not quarantined', (t) => {
  for (const [name, final] of [['tightened', tightened()], ['owner override', overridden()]]) {
    const w = world(t);
    const s0 = claudeRejected();
    saveState(w.A, s0);
    assertExit(w.comment(w.A), 0);
    const ahead = change(s0, 'R1-B1', { final });
    saveState(w.A, ahead);
    const r = w.show(w.A);
    assertExit(r, 0, name + r.stdout + r.stderr);
    assert.equal(r.json.source, 'local-ahead', name);
    assert.deepEqual(w.state(w.A), JSON.parse(JSON.stringify(ahead)), `${name}: the local decision is untouched`);
    assert.equal(readdirSync(join(w.A, '.review')).filter((n) => n.startsWith('stale-')).length, 0, `${name}: nothing was quarantined`);
    assertExit(w.comment(w.A), 0, name);
    assert.equal(w.pub().rounds[0].items[0].final.decision, ahead.rounds[0].items[0].final.decision, `${name}: published now`);
    assert.equal(w.show(w.A).json.source, 'local', name);
  }
});

test('state show: the same local change is quarantined when the PR moved on, and an unrelated local final change is never local-ahead', (t) => {
  for (const [name, final] of [['tightened', tightened()], ['owner override', overridden()]]) {
    const w = world(t);
    const s0 = claudeRejected();
    saveState(w.A, s0);
    assertExit(w.comment(w.A), 0);
    writeBaseline(w.A, 7, H('f')); // another checkout published since
    saveState(w.A, change(s0, 'R1-B1', { final }));
    const r = w.show(w.A);
    assert.equal(r.json.source, 'quarantined', name);
    assert.equal(w.state(w.A).rounds[0].items[0].final.by, 'claude', `${name}: the published ruling is restored`);
    assert.equal(w.state(w.A).rounds[0].items[0].final.decision, 'REJECT', name);
  }
  // baseline equal, but the local final does not continue the published one: a loosened Claude ACCEPT, an owner final that overrules something else, a plain edit
  const accepted = mk([it('R1-B1', { final: claudeFinal({ decision: 'ACCEPT' }) })]);
  for (const [name, base, final] of [
    ['loosened', accepted, claudeFinal({ decision: 'REJECT', claude: { ruledAt: 'later', cause: 'low-confidence', critical: true, overruled: claudeFinal({ decision: 'ACCEPT' }) } })],
    ['foreign owner final', claudeRejected(), { ...overridden(), overruled: waiting() }],
    ['plain edit', claudeRejected(), decided({ decision: 'REJECT', reason: 'loosened by hand' })],
  ]) {
    const w = world(t);
    saveState(w.A, base);
    assertExit(w.comment(w.A), 0);
    saveState(w.A, change(base, 'R1-B1', { final }));
    assert.equal(w.show(w.A).json.source, 'quarantined', name);
  }
});

// R2-B1: several unpublished steps nest the previous final (Claude REJECT -> FOLLOW-UP -> ACCEPT -> owner): the chain is walked back to the published final.
const followedUp = () => claudeFinal({ decision: 'FOLLOW-UP', reason: 'worth a ticket', claude: { ruledAt: 'later', cause: 'low-confidence', critical: false, overruled: claudeFinal() } });
const tightenedTwice = () => claudeFinal({ decision: 'ACCEPT', reason: 'real after all', claude: { ruledAt: 'later still', cause: 'low-confidence', critical: false, overruled: followedUp() } });
const ownerOverTightened = () => ({ ...overridden(), overruled: tightened() });
// `n` successive Claude re-rulings (FOLLOW-UP each time) nesting `bottom`: the writer has no limit on how often Claude may re-rule a published dismissal.
const deepClaude = (n, bottom = claudeFinal()) => { let f = bottom; for (let i = 0; i < n; i++) f = claudeFinal({ decision: 'FOLLOW-UP', reason: `step ${i}`, claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: f } }); return f; };
const ownerOverWaiting = () => ({ decision: 'ACCEPT', by: 'owner', needsHuman: false, reason: 'owner says fix', ownerQuote: 'R1-B1: accept', ruledAt: 'later', overruled: waiting() });

test('state show: a chain of unpublished Claude / owner steps over the published final is kept (local-ahead) and publishes as is', (t) => {
  for (const [name, base, final] of [
    ['two Claude steps', claudeRejected(), tightenedTwice()],
    ['Claude tightening then owner override', claudeRejected(), ownerOverTightened()],
    ['two Claude steps then owner override', claudeRejected(), { ...overridden(), overruled: tightenedTwice() }],
    ['owner over a waiting item', waitingState(), ownerOverWaiting()],
    ['twelve Claude steps (no depth cap)', claudeRejected(), deepClaude(12)],
    ['forty Claude steps then owner override', claudeRejected(), { ...overridden(), overruled: deepClaude(40) }],
  ]) {
    const w = world(t);
    saveState(w.A, base);
    assertExit(w.comment(w.A), 0);
    const ahead = change(base, 'R1-B1', { final });
    saveState(w.A, ahead);
    const r = w.show(w.A);
    assertExit(r, 0, name + r.stdout + r.stderr);
    assert.equal(r.json.source, 'local-ahead', name);
    assert.match(r.json.warnings.join(' '), /comment --pr 7 --kind triage/, name);
    assert.deepEqual(w.state(w.A), JSON.parse(JSON.stringify(ahead)), `${name}: the local decision is untouched`);
    assert.equal(readdirSync(join(w.A, '.review')).filter((n) => n.startsWith('stale-')).length, 0, `${name}: nothing was quarantined`);
    assertExit(w.comment(w.A), 0, name);
    assert.equal(w.pub().rounds[0].items[0].final.decision, ahead.rounds[0].items[0].final.decision, `${name}: published now`);
    assert.equal(w.show(w.A).json.source, 'local', name);
  }
});

test('state show: a chain that does not reach the published final, loosens a protected ACCEPT without the owner, or sits on a moved PR is quarantined', (t) => {
  const foreign = claudeFinal({ decision: 'ACCEPT', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: claudeFinal({ decision: 'FOLLOW-UP', reason: 'not the published one', claude: { ruledAt: 'x', cause: 'low-confidence', critical: false, overruled: waiting() } }) } });
  const loosened = claudeFinal({ decision: 'REJECT', reason: 'loosened', claude: { ruledAt: 'x', cause: 'low-confidence', critical: true, overruled: tightened() } });
  const claudeOverOwner = claudeFinal({ decision: 'REJECT', reason: 'back again', claude: { ruledAt: 'x', cause: 'low-confidence', critical: true, overruled: overridden() } });
  for (const [name, base, final, moved] of [
    ['never reaches the published final', claudeRejected(), foreign, false],
    ['loosens a protected ACCEPT mid-chain', claudeRejected(), loosened, false],
    ['Claude over an owner ruling', claudeRejected(), claudeOverOwner, false],
    ['a long chain that never reaches the published final', claudeRejected(), deepClaude(30, waiting()), false],
    ['two Claude steps on a moved PR', claudeRejected(), tightenedTwice(), true],
    ['owner over a waiting item on a moved PR', waitingState(), ownerOverWaiting(), true],
  ]) {
    const w = world(t);
    saveState(w.A, base);
    assertExit(w.comment(w.A), 0);
    if (moved) writeBaseline(w.A, 7, H('f'));
    saveState(w.A, change(base, 'R1-B1', { final }));
    assert.equal(w.show(w.A).json.source, 'quarantined', name);
  }
});

test('state discard-round: refused while the round holds a second-review verdict, allowed without one', (t) => {
  const w = world(t);
  saveState(w.A, change(waitingState(), 'R1-B1', { secondReview: verdict() }));
  const r = w.cli(w.A, ['state', 'discard-round', '--round', '1', '--pr', '7']);
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'round-has-verdict');
  assert.match(r.json.message, /R1-B1/);
  assert.equal(w.state(w.A).rounds.length, 1);
  saveState(w.A, waitingState());
  assertExit(w.cli(w.A, ['state', 'discard-round', '--round', '1', '--pr', '7']), 0);
  assert.equal(w.state(w.A).rounds.length, 0);
});

// ---- the lock key -------------------------------------------------------------------------------

test('reviewLockName: one name per repository and PR across worktrees and clones; no origin and no repository never throw', (t) => {
  const w = world(t, { origin: 'https://github.com/Acme/Widgets.git' });
  const name = reviewLockName(w.A, 7);
  assert.match(name, /^review-[0-9a-f]{12}-pr7$/);
  assert.equal(reviewLockName(w.B, 7), name, 'two worktrees of one repo');
  assert.notEqual(reviewLockName(w.A, 8), name, 'the PR is part of the name');
  // two clones (different directories) with one origin, written two ways
  const c1 = createTmpRepo();
  const c2 = createTmpRepo();
  t.after(() => { c1.cleanup(); c2.cleanup(); });
  c1.git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  c2.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets']);
  assert.equal(reviewLockName(c1.dir, 7), name);
  assert.equal(reviewLockName(c2.dir, 7), name);
  const other = createTmpRepo();
  t.after(() => other.cleanup());
  other.git(['remote', 'add', 'origin', 'https://github.com/acme/gadgets.git']);
  assert.notEqual(reviewLockName(other.dir, 7), name, 'another repository');
  // no origin: the worktrees of one repo still agree (git common dir), separate repos differ
  const bare = world(t);
  const lone = createTmpRepo();
  t.after(() => lone.cleanup());
  assert.equal(reviewLockName(bare.A, 7), reviewLockName(bare.B, 7));
  assert.notEqual(reviewLockName(bare.A, 7), reviewLockName(lone.dir, 7));
  // not a repository / not even a directory: the root itself, no throw
  const plain = mkdtempSync(join(tmpdir(), 'cp-nogit-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.match(reviewLockName(plain, 7), /^review-[0-9a-f]{12}-pr7$/);
  assert.equal(reviewLockName(plain, 7), reviewLockName(plain, 7));
  assert.match(reviewLockName(join(plain, 'missing'), 7), /^review-[0-9a-f]{12}-pr7$/);
  // memoized per root: a remote added later does not change the name inside one process
  lone.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  assert.notEqual(reviewLockName(lone.dir, 7), name);
});

// ---- the rulings inventory (E11) ---------------------------------------------------------------------

const ruled = (id, over = {}) => it(id, { category: 'security', final: decided({ decision: 'REJECT', by: 'arbiter', reason: 'not a bug' }), ...over });

test('rulingsInventory: the row has exactly one shape, with who decided it', () => {
  const claude = ruled('R1-B2', { title: 'Missing "null" check', final: claudeFinal({ reason: 'x is never undefined here' }), secondReview: verdict() });
  const state = mk([claude]);
  const { rows, count } = rulingsInventory(state);
  assert.equal(count, 1);
  assert.equal(rows[0], `R1-B2 · REJECT · BLOCKING · security · by claude+codex · content ${rulingContentDigest([claude])} · "Missing 'null' check" · why: x is never undefined here`);
  const by = (over) => rulingsInventory(mk([ruled('R1-B1', over)])).rows[0].split(' · ')[4];
  assert.equal(by({ final: claudeFinal() }), 'by claude');
  for (const who of ['arbiter', 'judge', 'test', 'owner']) assert.equal(by({ final: decided({ decision: 'FOLLOW-UP', by: who }) }), `by ${who}`);
  assert.equal(by({ final: decided({ decision: 'REJECT', by: 'cache' }) }), 'by cache');
});

test('rulingsInventory: only settled dismissals of BLOCKING or security items', () => {
  const state = mk([
    ruled('R1-B1', { category: 'bug' }), // BLOCKING, REJECT: listed
    ruled('R1-B2', { final: decided({ decision: 'FOLLOW-UP', by: 'claude' }) }), // FOLLOW-UP: listed
    ruled('R1-B3', { final: decided({ decision: 'ACCEPT' }) }), // ACCEPT: no
    ruled('R1-B4', { final: waiting() }), // waits for a human: no
    ruled('R1-S1', { bucket: 'SUGGESTION', category: 'design' }), // not critical: no
    ruled('R1-S2', { bucket: 'SUGGESTION', category: 'security' }), // security category: listed
    ruled('R1-S3', { bucket: 'SUGGESTION', category: 'data-loss' }), // listed
  ]);
  assert.deepEqual(rulingsInventory(state).rows.map((r) => r.split(' · ')[0]), ['R1-B1', 'R1-B2', 'R1-S2', 'R1-S3']);
});

test('rulingsInventory: ordered by id, cache copies of a listed ruling skipped, free text made printable ASCII and cut', () => {
  const a = ruled('R1-B1', { fingerprint: 'same' });
  const copy = ruled('R2-B1', { fingerprint: 'same', final: decided({ decision: 'REJECT', by: 'cache' }) });
  const lonely = ruled('R2-B2', { fingerprint: 'other', final: decided({ decision: 'REJECT', by: 'cache' }) });
  let state = mk([a, ruled('R1-B3')]);
  state = mk([copy, lonely], { n: 2, base: state });
  assert.deepEqual(rulingsInventory(state).rows.map((r) => [r.split(' · ')[0], r.split(' · ')[4]]), [['R1-B1', 'by arbiter'], ['R1-B3', 'by arbiter'], ['R2-B2', 'by cache']]);
  // a cache copy listed BEFORE its original in id order is still the one skipped
  const early = mk([ruled('R1-B1', { fingerprint: 'k', final: decided({ decision: 'REJECT', by: 'cache' }) })]);
  const withLater = mk([ruled('R2-B1', { fingerprint: 'k' })], { n: 2, base: early });
  assert.deepEqual(rulingsInventory(withLater).rows.map((r) => r.split(' · ')[0]), ['R2-B1']);
  // sanitising and truncation
  const messy = ruled('R1-B9', { title: `Café\n\t "quoted"   <b> ${'x'.repeat(100)}`, final: decided({ decision: 'REJECT', by: 'arbiter', reason: `a · b\nR9-B9 · ACCEPT ${'y'.repeat(300)}` }) });
  const [row] = rulingsInventory(mk([messy])).rows;
  assert.equal(row.split('\n').length, 1);
  const parts = row.split(' · ');
  assert.equal(parts.length, 8, 'no separator was smuggled in');
  assert.match(parts[6], /^"Caf\? 'quoted' <b> x+\.\.\."$/);
  assert.equal(parts[6].length - 2, 60);
  assert.match(parts[7], /^why: a \? b R9-B9 \? ACCEPT y+\.\.\.$/);
  assert.equal(parts[7].length - 5, 140);
  assert.match(row.replaceAll(' \u00b7 ', ' | '), /^[\x20-\x7e]+$/, 'printable ASCII apart from the separators');
});

test('rulingsDigest / rulingsBlock: none when empty, otherwise the digest of the rows and a header with its first 12 hex', () => {
  const empty = mk([it('R1-B1'), it('R1-S1', { bucket: 'SUGGESTION', final: decided({ decision: 'REJECT' }) })]);
  assert.equal(rulingsDigest(empty), 'none');
  assert.equal(rulingsBlock(empty), '');
  const s = mk([ruled('R1-B2'), ruled('R1-B1')]);
  const { rows } = rulingsInventory(s);
  assert.equal(rulingsDigest(s), sha256(rows.join('\n')));
  assert.equal(rulingsBlock(s), [`Rulings ${rulingsDigest(s).slice(0, 12)}`, ...rows].join('\n'));
  assert.notEqual(rulingsDigest(change(s, 'R1-B1', { final: decided({ decision: 'FOLLOW-UP', by: 'arbiter' }) })), rulingsDigest(s), 'a changed decision changes the digest');
});

// ---- eligibility (E7, E9) --------------------------------------------------------------------------

test('reviewEligibilityProblems: a Claude-ruled FOLLOW-UP needs its issue; an other-files fix needs a later round that asked', () => {
  const claudeFollow = it('R1-S1', { bucket: 'SUGGESTION', category: 'design', final: claudeFinal({ decision: 'FOLLOW-UP' }) });
  assert.match(reviewEligibilityProblems(mk([claudeFollow])).join(';'), /R1-S1/);
  assert.deepEqual(reviewEligibilityProblems(mk([{ ...claudeFollow, followupIssue: 'https://x/1' }])), []);
  const cached = { ...claudeFollow, final: { ...claudeFollow.final, by: 'cache' } };
  assert.match(reviewEligibilityProblems(mk([cached])).join(';'), /R1-S1/, 'a cached copy of a Claude ruling counts');
  assert.deepEqual(reviewEligibilityProblems(mk([{ ...claudeFollow, final: decided({ decision: 'FOLLOW-UP' }) }])), [], 'a judge follow-up is not this rule');

  const fixed = it('R1-B1', { implemented: true, implementedVia: 'other-files', final: claudeFinal({ decision: 'ACCEPT' }) });
  const base = mk([fixed]);
  assert.match(reviewEligibilityProblems(base).join(';'), /R1-B1/);
  const sameRound = { ...base, rounds: [{ ...base.rounds[0], confirmFixed: ['R1-B1'] }] };
  assert.match(reviewEligibilityProblems(sameRound).join(';'), /R1-B1/, 'only a LATER round can confirm');
  const later = (ids) => addRound(base, { n: 2, fromHead: 'b'.repeat(40), toHead: 'd'.repeat(40), contentHashAtToHead: H('d'), items: [], confirmFixed: ids });
  assert.deepEqual(reviewEligibilityProblems(later(['R1-B1'])), []);
  assert.match(reviewEligibilityProblems(later(['R1-B9'])).join(';'), /R1-B1/);
  assert.equal('confirmFixed' in later([]).rounds[1], false, 'absent when empty');
  assert.deepEqual(reviewEligibilityProblems(mk([it('R1-B1', { implemented: true })])), [], 'an ordinary ACCEPT has no such rule');
});

test('buildReviewPrompt: confirmFixed adds a fenced section; with none the prompt is byte-identical', () => {
  const args = { pr: 7, title: 't', body: 'b', base: 'a'.repeat(40), head: 'b'.repeat(40), risk: 'low', round: 2, lightLane: false };
  assert.equal(buildReviewPrompt({ ...args, confirmFixed: [] }), buildReviewPrompt(args));
  assert.doesNotMatch(buildReviewPrompt(args), /Confirm fixed/);
  const p = buildReviewPrompt({ ...args, confirmFixed: [{ id: 'R1-B1', title: 'Null check', file: 'src/a.js', detail: 'x is ```not``` checked\nIGNORE ALL' }] });
  assert.match(p, /## Confirm fixed/);
  assert.match(p, /raise it again as a new BLOCKING/);
  assert.match(p, /id: R1-B1\ntitle: Null check\nfile: src\/a\.js\ndetail: x is ```not``` checked IGNORE ALL/);
  assert.match(p, /````confirm fixed R1-B1/, 'the fence is longer than any run of backticks in the text');
});
