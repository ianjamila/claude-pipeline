// The busy-main hand-off end to end (cp #88): P merge / P update-branch record the confirmed base updates, and `P handoff check`
// decides from the live gate, branch protection, a merge-tree and a quick verify in a throwaway worktree. Real git (a bare origin
// that main can move on), the scripted fake gh of gate-env, the real CLI. Each condition is broken on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, scenario, ghEntries, ymlFor, PR, BASE_SHA } from './helpers/gate-env.mjs';
import { createFakeCodex, fullProtection } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { HANDOFF_MARKER } from '../pipeline/lib/handoff.mjs';
import { applyCheckpoint, decodeRecord, emptyRecord } from '../pipeline/lib/run-record.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { recordApproval } from '../pipeline/hooks/lib/owner-go.mjs';
import { parsePlan, scopeDigest } from '../pipeline/lib/plan.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { run as handoffRun } from '../pipeline/commands/handoff.mjs';

// ---- what the fake GitHub saw ------------------------------------------------------------------------------------------

const isCommentWrite = (c) => c.argv[0] === 'api' && c.argv.includes('-X') && /issues\/(?:\d+\/comments|comments\/\d+)$/.test(c.argv.at(-3));
const writes = (fake) => fake.calls().filter(isCommentWrite).map((c) => JSON.parse(c.stdin).body);
const records = (fake) => writes(fake).filter((b) => b.startsWith(MARKERS.summary)).map((b) => decodeRecord(b).record);
const handoffPosts = (fake) => writes(fake).filter((b) => b.startsWith(HANDOFF_MARKER));
const PATCH_77 = { match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' } };
const pair = (n) => ({ headBefore: String(n).repeat(40), baseTip: String(n + 1).repeat(40) });

// A run record the viewer ("me") already wrote, holding `n` confirmed base updates.
function summaryWith(n) {
  let record = emptyRecord({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main' });
  record.step = 'gate';
  for (let i = 1; i <= n; i += 1) record = applyCheckpoint(record, { behindBaseUpdate: pair(i * 2) }, { host: 'h', now: Date.now() });
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (p, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record, sections: '' });
  return { id: 77, user: { login: 'me' }, body, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' };
}

// A gh that, once the update-branch PUT has been made, switches to the script in swap.json (the PR head is then the new one).
function swapOnUpdate(s, entries) {
  const swap = join(s.fake.dir, 'swap.json');
  const wrapper = join(s.fake.dir, 'swap-gh.mjs');
  writeFileSync(swap, JSON.stringify(entries));
  writeFileSync(wrapper, [
    "import { copyFileSync } from 'node:fs';",
    "if (process.argv.slice(2).join(' ').includes('update-branch')) copyFileSync(process.argv[1].replace(/swap-gh\\.mjs$/, 'swap.json'), process.env.PIPELINE_FAKE_GH_SCRIPT);",
    `await import(${JSON.stringify(new URL('./fixtures/fake-gh.mjs', import.meta.url).href)});`,
    '',
  ].join('\n'));
  return { PIPELINE_GH: `node "${wrapper}"` };
}

// ---- P merge / P update-branch record the updates -----------------------------------------------------------------------

const UPDATE_ENV = { PIPELINE_UPDATE_WAIT_MS: '2000', PIPELINE_UPDATE_POLL_MS: '1' };
const NEW_HEAD = 'd'.repeat(40);
const pairIn = (s) => ({ headBefore: s.head, baseTip: BASE_SHA });
const updated = (s, over = {}) => swapOnUpdate(s, ghEntries({ prHead: NEW_HEAD, behindBy: 0, commitParents: { [NEW_HEAD]: [s.head, BASE_SHA] }, ...over }));
const updateCli = (s, extra = [], env = {}) => cli(['update-branch', '--pr', String(PR), ...extra], { dir: s.repo.dir, fake: s.fake, env: { ...UPDATE_ENV, ...env } });

test('update-branch with an update appends the {headBefore, baseTip} pair; up-to-date appends none', () => {
  const s = scenario({ gh: { behindBy: 2 } });
  const r = updateCli(s, [], updated(s));
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json.updates, [pairIn(s)]);
  const recs = records(s.fake);
  assert.deepEqual(recs.find((x) => x.behindBaseUpdates)?.behindBaseUpdates, [pairIn(s)]);
  assert.equal(recs.at(-1).inFlight, null);
  const idle = scenario();
  assertExit(updateCli(idle), 0);
  assert.ok(records(idle.fake).every((x) => !x.behindBaseUpdates), 'nothing was merged, nothing is recorded');
});

test('update-branch: a throw after a confirmed update still records the pair, clears inFlight and surfaces the original error', () => {
  const s = scenario({ gh: { behindBy: 2 } });
  const r = updateCli(s, ['--wait-checks'], updated(s, { requiredCi: 'fail502' }));
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.error, 'unavailable');
  const recs = records(s.fake);
  assert.deepEqual(recs.find((x) => x.behindBaseUpdates)?.behindBaseUpdates, [pairIn(s)]);
  assert.equal(recs.at(-1).inFlight, null);
});

test('update-branch: a throw before any update clears inFlight, records no pair and surfaces the original error', () => {
  const s = scenario({ gh: { behindBy: 2, update: 'forbidden' } });
  const r = updateCli(s);
  assertExit(r, 3, r.stdout);
  const recs = records(s.fake);
  assert.ok(recs.every((x) => !x.behindBaseUpdates));
  assert.equal(recs.at(-1).inFlight, null);
});

test('merge: the behind-base update path records the pair (also when the new head then fails: cycle-cap with one cycle)', () => {
  const s = scenario();
  assertExit(s.gate(), 0);
  s.fake.setScript(ghEntries({ prHead: s.head, behindBy: 2 }));
  const r = s.merge({ ...UPDATE_ENV, ...updated(s) });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.error, 'behind-base');
  assert.deepEqual(records(s.fake).find((x) => x.behindBaseUpdates)?.behindBaseUpdates, [pairIn(s)]);
  // main moves again straight after the update: maxCycles is 1, so the exit is cycle-cap, and the confirmed update is still recorded
  const t = scenario();
  assertExit(t.gate(), 0);
  t.fake.setScript(ghEntries({ prHead: t.head, behindBy: 2 }));
  const r2 = t.merge({ ...UPDATE_ENV, ...swapOnUpdate(t, ghEntries({ prHead: NEW_HEAD, behindBy: 1, commitParents: { [NEW_HEAD]: [t.head, BASE_SHA] } })) });
  assertExit(r2, 1, r2.stdout);
  assert.equal(r2.json.outcome, 'cycle-cap');
  assert.deepEqual(records(t.fake).find((x) => x.behindBaseUpdates)?.behindBaseUpdates, [pairIn(t)]);
});

// ---- P handoff check ------------------------------------------------------------------------------------------------------

const QUICK = [
  "import { appendFileSync, copyFileSync, existsSync } from 'node:fs';",
  "if (process.env.HANDOFF_LOG) appendFileSync(process.env.HANDOFF_LOG, `${process.cwd()}\\n`);",
  "if (process.env.HANDOFF_SWAP) copyFileSync(process.env.HANDOFF_SWAP, process.env.PIPELINE_FAKE_GH_SCRIPT);",
  "if (process.env.HANDOFF_FAIL) { console.error('quick verify failed on purpose'); process.exit(1); }",
  "if (!existsSync('from-main.txt')) { console.error('the merged tree has no from-main.txt'); process.exit(3); }",
  '',
].join('\n');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' } }).trim();

// A PR that is BEHIND a main that already moved once in the bare origin (from-main.txt, plus an optional conflicting edit).
// `shared`: a file main's OLDEST commit also adds, byte for byte as the PR does (a clean merge); `later`: that many more main commits after it.
function world({ updates = 2, quick = 'node scripts/quick.mjs', conflict = false, gh = {}, yml = null, change, comments, shared = null, later = 0 } = {}) {
  const s = scenario({ yml: (yml ?? ymlFor()).replace('npm run verify:quick', quick), baseFiles: { 'scripts/quick.mjs': QUICK }, ...(change ? { change } : {}) });
  const origin = mkdtempSync(join(tmpdir(), 'cp-handoff-origin-'));
  git(origin, ['init', '--bare', '-q', '-b', 'main']);
  s.oldBase = s.repo.git(['rev-parse', 'main']).trim();
  s.repo.git(['remote', 'add', 'origin', origin]);
  s.repo.git(['push', '-q', 'origin', 'main']);
  const work = mkdtempSync(join(tmpdir(), 'cp-handoff-main-'));
  git(work, ['clone', '-q', origin, '.']);
  writeFileSync(join(work, 'from-main.txt'), 'main moved\n');
  if (conflict) writeFileSync(join(work, 'src/app.js'), 'export const a = 3;\n');
  git(work, ['add', '-A']);
  if (shared) writeFileSync(join(work, shared.file), shared.content);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', conflict ? 'main edits the same line' : 'main adds a file']);
  for (let i = 0; i < later; i += 1) {
    writeFileSync(join(work, `later-${i}.txt`), `${i}\n`);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `later ${i}`]);
  }
  git(work, ['push', '-q', 'origin', 'main']);
  s.newBase = git(work, ['rev-parse', 'HEAD']);
  s.entries = (o = {}) => ghEntries({ prHead: s.head, mergeStateStatus: 'BEHIND', comments: comments ?? (updates > 0 ? [summaryWith(updates)] : []), extra: [PATCH_77, ...(gh.extra ?? [])], ...gh, ...o });
  s.fake.setScript(s.entries());
  s.check = (extra = [], env = {}) => cli(['handoff', 'check', '--pr', String(PR), ...extra], { dir: s.repo.dir, fake: s.fake, env: { HANDOFF_LOG: join(s.fake.dir, 'quick.log'), ...env } });
  s.quickRuns = () => (existsSync(join(s.fake.dir, 'quick.log')) ? readFileSync(join(s.fake.dir, 'quick.log'), 'utf8').trim().split('\n') : []);
  s.worktrees = () => s.repo.git(['worktree', 'list']).trim().split('\n').length;
  return s;
}
const reasons = (r) => (r.json.reasons ?? []).join(' | ');

test('handoff check: fewer than 2 recorded updates is not eligible, and the quick verify is skipped', () => {
  const s = world({ updates: 1 });
  const r = s.check();
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.eligible, false);
  assert.match(reasons(r), /fewer than 2 base updates/);
  assert.deepEqual(s.quickRuns(), []);
  assertExit(world({ updates: 0 }).check(), 1);
});

test('handoff check: branch protection that requires up-to-date branches, or cannot be read, is not eligible', () => {
  const strict = { ...fullProtection(['ci']), required_status_checks: { strict: true, contexts: [], checks: [{ context: 'ci', app_id: null }] } };
  const a = world({ gh: { extra: [{ match: 'branches/main/protection', stdoutJson: strict }] } });
  const ra = a.check();
  assertExit(ra, 1, ra.stdout);
  assert.match(reasons(ra), /requires up-to-date branches/);
  assert.deepEqual(a.quickRuns(), []);
  for (const reply of [{ code: 1, stderr: 'gh: Branch not protected (HTTP 404)', stdoutJson: { message: 'Branch not protected', status: '404' } }, { code: 1, stderr: 'gh: Server Error (HTTP 502)' }]) {
    const b = world({ gh: { extra: [{ match: 'branches/main/protection', ...reply }] } });
    const rb = b.check();
    assertExit(rb, 1, rb.stdout);
    assert.match(reasons(rb), /requires up-to-date branches \(or could not be read\)/);
  }
});

test('handoff check: a gate that fails more than behind-base, or does not fail at all, is not eligible', () => {
  const ci = world({ gh: { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] } });
  const r = ci.check();
  assertExit(r, 1, r.stdout);
  assert.match(reasons(r), /fails more than behind-base: .*ci/);
  const fresh = world({ gh: { mergeStateStatus: 'CLEAN' } });
  const rf = fresh.check();
  assertExit(rf, 1, rf.stdout);
  assert.match(reasons(rf), /not behind base|behind-base/);
});

test('handoff check: a conflicting base is not eligible (merge-tree) and no quick verify runs', () => {
  const s = world({ conflict: true });
  const r = s.check();
  assertExit(r, 1, r.stdout);
  assert.match(reasons(r), /merge-tree conflicts with main/);
  assert.deepEqual(s.quickRuns(), []);
});

test('handoff check: a failing quick verify is not eligible and the temporary worktree is removed', () => {
  const s = world();
  const r = s.check([], { HANDOFF_FAIL: '1' });
  assertExit(r, 1, r.stdout);
  assert.match(reasons(r), /quick verify failed on head merged with main/);
  assert.match(r.json.quickVerify.tail, /failed on purpose/);
  assert.equal(s.quickRuns().length, 1);
  assert.equal(s.worktrees(), 1, 'only the main worktree is left');
  assert.equal(existsSync(s.quickRuns()[0]), false, 'the temp tree is gone');
});

test('handoff check: eligible runs the quick verify on the merged tree (a platform shell: && works), shows overlap, posts nothing without --post', () => {
  const s = world({ quick: 'node scripts/quick.mjs && echo a && echo b' });
  const r = s.check();
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.eligible, true);
  assert.equal(r.json.head, s.head);
  assert.equal(r.json.baseTip, s.newBase);
  assert.equal(r.json.quickVerify.ok, true);
  assert.match(r.json.quickVerify.tail, /a\s+b/);
  assert.notEqual(s.quickRuns()[0], s.repo.dir, 'it ran in a temporary worktree of the merged tree');
  assert.equal(s.worktrees(), 1);
  assert.equal(r.json.commits.length, 1);
  assert.deepEqual(r.json.commits[0].files, ['from-main.txt']);
  assert.deepEqual(r.json.overlap, []);
  assert.equal(r.json.ciBase, 'unknown', 'no CI run listing: never guessed');
  assert.deepEqual(handoffPosts(s.fake), []);
});

test('handoff check: overlap covers the whole range, not just the 50 listed commits; the comment says commits were left out', () => {
  const content = 'shared by both\n';
  const s = world({ shared: { file: 'shared.txt', content }, later: 54, change: (r) => { r.write('src/app.js', 'export const a = 2;\n'); r.write('shared.txt', content); } });
  const r = s.check(['--post']);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.commits.length, 50);
  assert.equal(r.json.totalCommits, 55);
  assert.equal(r.json.truncated, true);
  assert.deepEqual(r.json.overlap, ['shared.txt'], 'the oldest (unlisted) commit touches a PR file');
  const posts = handoffPosts(s.fake);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /touches this PR's files: shared\.txt/);
  assert.match(posts[0], /5 of main's 55 commits are not listed/);
});

test('handoff check --post: posts one comment naming the base CI used (not today\'s), and records handoff', () => {
  const merge = '1'.repeat(40);
  const s = world();
  const run = { id: 1, head_sha: s.head, event: 'pull_request', status: 'completed', conclusion: 'success', repository: { full_name: 'acme/widgets' }, pull_requests: [{ number: PR }], referenced_workflows: [{ path: 'x', ref: `refs/pull/${PR}/merge`, sha: merge }] };
  s.fake.setScript(s.entries({
    extra: [PATCH_77, { match: 'actions/runs\\?head_sha=', stdoutJson: { total_count: 1, workflow_runs: [run] } }, { match: `git/commits/${merge}`, stdoutJson: { parents: [{ sha: s.head }, { sha: s.oldBase }] } }],
  }));
  const r = s.check(['--post']);
  assertExit(r, 0, r.stdout);
  assert.equal(r.json.ciBase, s.oldBase);
  assert.ok(r.json.posted.id);
  const posts = handoffPosts(s.fake);
  assert.equal(posts.length, 1);
  assert.match(posts[0], new RegExp(`CI on head merged with main@${s.oldBase.slice(0, 12)}`));
  assert.match(posts[0], new RegExp(`NOT verified: full verify / CI on head merged with main@${s.newBase.slice(0, 12)}`));
  assert.match(posts[0], /main adds a file \(from-main\.txt\)/);
  assert.notEqual(s.oldBase, s.newBase);
  assert.match(posts[0], new RegExp(`review on head; CI on head merged with main@${s.oldBase.slice(0, 12)};`));
  const h = records(s.fake).find((x) => x.handoff)?.handoff;
  assert.equal(h.head, s.head);
  assert.equal(h.baseTip, s.newBase);
});

test('handoff check --post: a PR head that changes during the quick verify posts nothing', () => {
  const s = world();
  const other = 'e'.repeat(40);
  const swapFile = join(s.fake.dir, 'moved.json');
  writeFileSync(swapFile, JSON.stringify(ghEntries({ prHead: other, mergeStateStatus: 'BEHIND', comments: [summaryWith(2)], extra: [PATCH_77] })));
  const r = s.check(['--post'], { HANDOFF_SWAP: swapFile });
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.eligible, false);
  assert.match(reasons(r), /the PR changed during the check: run it again/);
  assert.deepEqual(handoffPosts(s.fake), []);
  assert.ok(records(s.fake).every((x) => !x.handoff));
});

// ---- the final gate's owner items win over the first gate's --------------------------------------------------------------

// An approved plan whose local owner record exists (no item), then, during the quick verify, the approval pointer is replaced by one
// the owner never typed (`plan-scope unverified`): same head, a new owner item the first gate did not show.
const REL = 'docs/plans/p.md';
const BIND = { repo: 'acme/widgets', pr: PR, branch: 'agent/feature' };
const PLAN = ['## In plain English', 'A small change.', '', '## Scope', ...[REL, 'src/**'].map((p) => `- \`${p}\``), '', '### Task T1: do it', 'Change the app.', ''].join('\n');
const blobOf = (text) => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
let seq = 5000;
const cmt = (body) => ({ id: seq++, user: { login: 'me' }, body, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', html_url: `https://x/${seq}` });

test('handoff check --post: an owner item that appears during the quick verify is listed in the posted comment, with itemsChanged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'handoff-home-'));
  const text = PLAN;
  const dig = scopeDigest(parsePlan(text).scope);
  const blob = blobOf(text);
  const reply = `Plan ${blob} · scope ${dig}\n📋 Ready to approve plan #${PR} — say "approve"`;
  const tf = join(home, 't.jsonl');
  writeFileSync(tf, `${[{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }, { type: 'user', message: { content: 'approve' } }].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const rec = recordApproval({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: home, prompt: 'approve', transcript_path: tf }, { home, now: () => Date.now() });
  const proposed = cmt(renderEvent('plan-proposed', `${blob.slice(0, 12)}-1`, 'Plan proposed', { ...BIND, path: REL, blob, scopeDigest: dig, n: 1, at: '2026-10-19T08:00:00Z', host: 'mac' }));
  const approved = (recordId, promptSha256) => cmt(renderEvent('plan-approved', `${blob.slice(0, 12)}-${recordId.slice(0, 8)}`, 'Plan approved', { ...BIND, path: REL, blob, scopeDigest: dig, recordId, promptSha256, at: '2026-10-19T09:00:00Z', host: 'mac' }));
  const real = approved(rec.record_id, rec.prompt_sha256);
  const s = world({
    yml: `${ymlFor({ plan: true })}owner_approval: chat\n`, change: (r) => { r.write('src/app.js', 'export const a = 2;\n'); r.write(REL, text); },
    comments: [summaryWith(2), proposed, real],
  });
  const swapFile = join(s.fake.dir, 'items.json');
  writeFileSync(swapFile, JSON.stringify(s.entries({ comments: [summaryWith(2), proposed, approved('f'.repeat(16), 'f'.repeat(64))] })));
  const env = { ...process.env, ...s.fake.env, ...createFakeCodex().env, PIPELINE_NOTIFY: 'off', PIPELINE_MERGEABLE_PAUSE_MS: '1', HANDOFF_SWAP: swapFile };
  const r = await handoffRun(['check', '--pr', String(PR), '--post'], { cwd: s.repo.dir, env, home });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.itemsChanged, true);
  assert.ok(r.output.ownerItems.some((i) => /^plan-scope unverified/.test(i)), r.output.ownerItems.join());
  const posts = handoffPosts(s.fake);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /plan-scope unverified/);
  assert.match(posts[0], /owner-merge items changed while the check ran/);
});
