// `P merge --owner-go` on a diff with owner items (plan 2026-11-05-chat-merge-protected, A.2, A.3, rev 4 item 2b without the hold): with
// owner_approval: chat the owner's "merge" covers a hard-stop / test-integrity item when the record is for exactly what the LIVE scan found:
// its items digest and the Areas line shown right above the Head line. A record for `items none` never covers a diff with items, a record for
// digest X never covers items that now hash to Y, and a blocking hit is refused whatever the record says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { areasOf, evaluateOwnerGo, ownerItemsCheck } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { approvalGap, areasBlock, areasDigest, presentedRequests } from '../pipeline/hooks/lib/owner-go.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const goYml = () => ymlFor().replace('{pr} {sha}', '{pr} --match-head-commit {sha}');
const yml = (mode) => `${goYml()}hard_stops:\n  paths: ['src/**']\nowner_approval: ${mode}\n`;
// A unique head per fixture (see test/owner-go-scan-range.test.mjs): the owner's records are matched on repo, PR and head.
const unique = (change = bump) => (repo) => { change(repo); repo.write('.salt', randomUUID()); };
const world = (opts = {}) => scenario({ yml: yml('chat'), report: null, state: null, ...opts, change: unique(opts.change) });
const deleteTest = (repo) => { bump(repo); repo.git(['rm', '-q', 'test/app.test.js']); };
const goMerge = (s) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
const stubGh = (s) => ({
  prView: () => ({ state: 'OPEN', headRefOid: s.head, baseRefName: 'main', baseRefOid: s.baseTip, isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
  checks: () => [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }],
  pullFiles: () => s.prFiles,
  repo: () => ({ slug: 'acme/widgets', host: 'github.com' }),
});
// What the live scan of s finds: the digest and the areas the owner has to be shown.
const liveOf = async (s) => {
  const { config } = await loadConfig(s.repo.dir);
  return evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: stubGh(s), env: {} });
};
const refused = (r, error, pattern, s) => {
  assertExit(r, 1);
  assert.equal(r.json.error, error, r.stdout);
  assert.match(JSON.stringify(r.json), pattern);
  assert.deepEqual(s.mergeCalls(), [], 'no merge command may run');
};

// ---- A.3: the record must be for the live digest and the Areas shown -------------------------------------------------------

test('--owner-go, chat mode, protected diff: a record for the live digest and the matching Areas line merges, pinned to the head', async (t) => {
  const s = world();
  const live = await liveOf(s);
  assert.equal(live.areas.length, 1);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, live.ownerItems, 'acme/widgets', live.areas));
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
});

test('--owner-go, chat mode, several areas (a hard-stop path and a deleted test): the Areas line lists them sorted and the record must match', async (t) => {
  const s = world({ change: deleteTest });
  const live = await liveOf(s);
  assert.equal(live.areas.length, 2, JSON.stringify(live.ownerItemLines));
  assert.deepEqual(live.areas, [...live.areas].sort());
  // mergeRequest prints the Areas line through areasBlock, which sorts and dedupes: handing it the ids reversed still puts `Areas <sorted>` on the page.
  // (A page that is NOT in that canonical shape is refused: see the unsorted and duplicate tests below.)
  ownerSays(t, 'merge', mergeRequest(PR, s.head, live.ownerItems, 'acme/widgets', [...live.areas].reverse()));
  assertExit(goMerge(s), 0);
});

test('--owner-go, chat mode: a record for `items none` never covers a diff with items; the refusal names the live lines to show', async (t) => {
  const s = world();
  const live = await liveOf(s);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  const r = goMerge(s);
  refused(r, 'owner-go', new RegExp(`items ${live.ownerItems}`), s);
  assert.ok(r.json.reason.includes(areasBlock(live.areas)), r.json.reason);
  assert.ok(r.json.reason.includes(`Head ${s.head.slice(0, 12)} · items ${live.ownerItems} · repo acme/widgets`), r.json.reason);
});

test('--owner-go, chat mode: a record for another digest (the items changed since the owner said "merge") is refused', async (t) => {
  const s = world();
  const live = await liveOf(s);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'f'.repeat(12), 'acme/widgets', live.areas));
  refused(goMerge(s), 'owner-go', new RegExp(`items ${live.ownerItems}`), s);
});

test('--owner-go, chat mode: the right digest without the Areas line is refused (the owner was not shown the areas)', async (t) => {
  const s = world();
  const live = await liveOf(s);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, live.ownerItems));
  refused(goMerge(s), 'owner-go', /Areas /, s);
});

test('--owner-go, chat mode: the right digest with other areas in the Areas line is refused', async (t) => {
  const s = world();
  const live = await liveOf(s);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, live.ownerItems, 'acme/widgets', ['R9-other']));
  refused(goMerge(s), 'owner-go', /Areas /, s);
});

const dryRun = (s) => cli(['merge', '--pr', String(PR), '--dry-run', '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });

test('round trip: the dry run\'s printed ownerStep.areas + ownerStep.line, as the reply shows them, are recorded, read back and approve the real merge', async (t) => {
  const s = world({ gh: { mergeStateStatus: 'CLEAN' } });
  const d = dryRun(s);
  assertExit(d, 0, `${d.stderr}${d.stdout}`);
  const { ownerStep } = d.json;
  assert.equal(ownerStep.kind, 'say-merge');
  const reply = `Protected areas listed above.\n${ownerStep.areas}\n${ownerStep.line}\n🔀 Ready to merge #${PR} — say "merge"`; // the exact printed text, nothing retyped
  const live = await liveOf(s);
  const [request, ...rest] = presentedRequests(reply).requests;
  assert.equal(rest.length, 0);
  assert.equal(request.head, s.head.slice(0, 12));
  assert.equal(request.items, live.ownerItems);
  assert.equal(request.areas, areasDigest(live.areas));
  ownerSays(t, 'merge', reply);
  assert.equal(approvalGap({ repo: 'acme/widgets', pr: PR, head: s.head, items: live.ownerItems, areas: live.areas }), 'ok');
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
});

test('--owner-go, chat mode: an Areas line on the page that is not the canonical sorted one (`Areas b a`) is refused, whatever the live areas are', async (t) => {
  const s = world({ change: deleteTest });
  const live = await liveOf(s);
  assert.equal(live.areas.length, 2);
  const [first, second] = live.areas; // sorted
  const head = `Head ${s.head.slice(0, 12)} · items ${live.ownerItems} · repo acme/widgets`;
  const reply = `Areas ${second} ${first}\n${head}\n🔀 Ready to merge #${PR} — say "merge"`;
  // the digest is of the text as written, so it is not the digest of the canonical block P merge compares
  assert.notEqual(presentedRequests(reply).requests[0]?.areas, areasDigest(live.areas));
  ownerSays(t, 'merge', reply);
  refused(goMerge(s), 'owner-go', /Areas /, s);
});

test('--owner-go, chat mode: a duplicate in the Areas line (`Areas a a`) is refused, even when the distinct ids are the live areas', async (t) => {
  const s = world();
  const live = await liveOf(s);
  assert.equal(live.areas.length, 1);
  const [only] = live.areas;
  const head = `Head ${s.head.slice(0, 12)} · items ${live.ownerItems} · repo acme/widgets`;
  const reply = `Areas ${only} ${only}\n${head}\n🔀 Ready to merge #${PR} — say "merge"`;
  assert.notEqual(presentedRequests(reply).requests[0]?.areas, areasDigest(live.areas));
  ownerSays(t, 'merge', reply);
  refused(goMerge(s), 'owner-go', /Areas /, s);
});

test('--owner-go: an Areas line on a diff that has none is refused too (the record must be for exactly what was found)', (t) => {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique() });
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none', 'acme/widgets', ['R2-auth-removed']));
  refused(goMerge(s), 'owner-go', /is recorded for acme\/widgets #12 head/, s);
});

test('--owner-go: an old record without the areas field (shown before Areas lines) still approves a diff without items', (t) => {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique() });
  const record = ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  assert.equal('areas' in record.requests[0], false, 'a request without an Areas line stores no areas field');
  assertExit(goMerge(s), 0);
});

test('approvalGap: a record without areas means "no areas" (old records keep working, and never cover a diff with areas); the gated route passes areas: null (binds none); undefined fails closed', (t) => {
  const head = randomUUID().replaceAll('-', '').padEnd(40, 'a').slice(0, 40);
  ownerSays(t, 'merge', mergeRequest(PR, head, 'none'));
  const q = { repo: 'acme/widgets', pr: PR, head, items: 'none' };
  assert.equal(approvalGap({ ...q, areas: [] }), 'ok');
  assert.equal(approvalGap({ ...q, areas: ['R2-auth-removed'] }), 'none');
  assert.equal(approvalGap({ ...q, areas: null }), 'ok', 'areas: null (the gated route) is bound by items only');
  assert.equal(approvalGap(q), 'ok', 'undefined compares as no areas, which this record says');
  const withAreas = randomUUID().replaceAll('-', '').padEnd(40, 'b').slice(0, 40);
  ownerSays(t, 'merge', mergeRequest(PR, withAreas, 'abcdefabcdef', 'acme/widgets', ['R2-x', 'R1-y']));
  const p = { repo: 'acme/widgets', pr: PR, head: withAreas, items: 'abcdefabcdef' };
  assert.equal(approvalGap({ ...p, areas: ['R1-y', 'R2-x'] }), 'ok');
  assert.equal(approvalGap({ ...p, areas: ['R2-x'] }), 'none');
  assert.equal(approvalGap({ ...p, areas: [] }), 'none');
  assert.equal(approvalGap({ ...p, areas: null }), 'ok', 'null = this route does not bind areas');
  assert.equal(approvalGap(p), 'none', 'undefined is NOT "compare nothing": it compares as no areas, so a caller that forgets them fails closed');
  assert.equal(areasDigest([]), 'none');
});

// ---- A.2: what no record can cover --------------------------------------------------------------------------------------

test('--owner-go, label mode: a blocking hard-stop is refused as live-check whatever the record says', (t) => {
  const s = scenario({ yml: yml('label'), report: null, state: null, change: unique() });
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  refused(goMerge(s), 'live-check', /owner-items: hardstops did not pass/, s);
});

test('--owner-go, label mode: a test-integrity violation (a deleted test) is refused as live-check whatever the record says', (t) => {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique(deleteTest) });
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  refused(goMerge(s), 'live-check', /integrity/, s);
});

test('--owner-go, chat mode: a record for the live digest and Areas does not help when the PR is not ready (live-check comes first)', async (t) => {
  const s = world({ gh: { labels: ['needs-human'] } });
  const live = await liveOf(s);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, live.ownerItems, 'acme/widgets', live.areas));
  refused(goMerge(s), 'live-check', /labels/, s);
});

// ---- the dry run reports the live digest and the Areas line --------------------------------------------------------------

test('the Areas block is `Areas <sorted ids>` and its digest is sha256 of exactly that text', () => {
  assert.equal(areasBlock(['R2-b', 'R1-a', 'R2-b']), 'Areas R1-a R2-b');
  assert.equal(areasBlock([]), '');
  assert.notEqual(areasDigest(['R1-a']), areasDigest(['R1-a', 'R2-b']));
});

// ---- C: known harmless output --------------------------------------------------------------------------------------------

test('--owner-go: `gh pr merge --delete-branch` printing "\'main\' is already checked out" after the merge still reports merged (MERGED is MERGED)', (t) => {
  const stub = [
    "import { appendFileSync, mkdirSync } from 'node:fs';",
    "mkdirSync('.review', { recursive: true });",
    "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
    "console.log('Merged pull request #12');",
    "console.error(\"failed to delete local branch agent/feature: fatal: 'main' is already checked out at '/work/main'\");",
    'process.exit(1);',
    '',
  ].join('\n');
  const s = scenario({
    yml: goYml().replace('node scripts/fake-merge.mjs', 'node scripts/checked-out-merge.mjs'), report: null, state: null, change: unique(),
    baseFiles: { 'scripts/checked-out-merge.mjs': stub },
  });
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.commandExitCode, 1);
  assert.match(r.json.note, /exited non-zero but the PR is MERGED/);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
});

// ---- D: the guards do not refuse the commands this route uses -----------------------------------------------------------

const PIPE = 'node ~/.claude/pipeline/bin/pipeline.mjs';
const COMMANDS = [
  `${PIPE} merge --pr 12 --owner-go`,
  `${PIPE} merge --pr 12 --dry-run --owner-go`,
  `${PIPE} job start merge -- ${PIPE} merge --pr 12 --owner-go`,
];
test('guards: `P merge --pr N --owner-go` and its dry-run form (also under `P job start`) are not refused by the git or files guards', () => {
  const home = '/home/u';
  const ownerGo = {
    mode: () => 'chat', mergeTemplates: () => [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }], repoOf: () => 'o/chat', approvedHead: () => false,
  };
  for (const command of COMMANDS) {
    for (const wiring of [undefined, ownerGo]) {
      const v = evaluateGitCommand(command, { cwd: '/repo', home, currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...(wiring ? { ownerGo: wiring } : {}) });
      assert.equal(v.decision, 'allow', `${command}: ${v.reason}`);
    }
    const f = evaluateBashForFiles(command, { home, env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false, cwd: '/repo' });
    assert.equal(f.decision, 'allow', `${command}: ${f.reason}`);
  }
  // the guard still refuses what the route replaces: the agent merging by itself
  assert.equal(evaluateGitCommand('gh pr merge 12 --squash --match-head-commit ' + 'a'.repeat(40), { cwd: '/repo', home, currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ownerGo: { mode: () => 'chat', mergeTemplates: () => [], repoOf: () => 'o/chat', approvedHead: () => false } }).decision, 'deny');
});

// ---- the terminal-block parser: exactly one Areas line, directly above its Head line --------------------------------------------

const A = 'a'.repeat(12);
const B = 'b'.repeat(12);
const READY = (n) => `🔀 Ready to merge #${n} — say "merge"`;
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('parser: an Areas line directly above the Head line binds the request with the digest of the block', () => {
  const r = presentedRequests(`Areas R1-a R2-b\nHead ${A} · items abcdefabcdef · repo acme/widgets\n${READY(7)}`);
  assert.deepEqual(r.requests, [{ pr: 7, head: A, items: 'abcdefabcdef', repo: 'acme/widgets', areas: sha('Areas R1-a R2-b') }]);
  assert.equal(r.requests[0].areas, areasDigest(['R2-b', 'R1-a']), 'the same digest P merge computes from the live scan');
  // spacing and case of the keyword are tolerated; the digest is of the canonical text
  assert.equal(presentedRequests(`  areas   R1-a  R2-b \nHead ${A} · items none\n${READY(7)}`).requests[0].areas, sha('Areas R1-a R2-b'));
  // no Areas line: no areas field (= "no areas")
  assert.deepEqual(presentedRequests(`Head ${A} · items none\n${READY(7)}`).requests, [{ pr: 7, head: A, items: 'none', repo: null }]);
});

test('parser: the several-PR form carries `#N areas …` above `#N head …`', () => {
  const text = `#7 areas R1-a\n#7 head ${A} · items abcdefabcdef\n#8 head ${B} · items none\n🔀 Ready to merge #7, #8 — say "merge"`;
  assert.deepEqual(presentedRequests(text).requests, [
    { pr: 7, head: A, items: 'abcdefabcdef', repo: null, areas: sha('Areas R1-a') },
    { pr: 8, head: B, items: 'none', repo: null },
  ]);
  // another PR's number on the Areas line binds nothing
  assert.deepEqual(presentedRequests(`#8 areas R1-a\n#7 head ${A} · items none\n${READY(7)}`).requests, []);
  assert.deepEqual(presentedRequests(`areas R1-a\n#7 head ${A} · items none\n${READY(7)}`).requests, []);
});

test('parser: a repeated Areas line, one against the 🔀 line, or a malformed one binds nothing', () => {
  const head = `Head ${A} · items abcdefabcdef`;
  for (const [why, text] of [
    ['repeated', `Areas R1-a\nAreas R1-a\n${head}\n${READY(7)}`],
    ['two different', `Areas R1-a\nAreas R2-b\n${head}\n${READY(7)}`],
    ['below the Head line', `${head}\nAreas R1-a\n${READY(7)}`],
    ['against the 🔀 line only', `Areas R1-a\n${READY(7)}`],
    ['no ids', `Areas\n${head}\n${READY(7)}`],
    ['a bad id', `Areas R1-a, R2-b\n${head}\n${READY(7)}`],
    ['prose after the keyword', `Areas touched: the auth code\n${head}\n${READY(7)}`],
  ]) assert.deepEqual(presentedRequests(text).requests, [], why);
});

test('parser: an Areas line with prose between it and the Head line is no part of the block; the request binds without areas', () => {
  const r = presentedRequests(`Areas R1-a\nMore words.\nHead ${A} · items abcdefabcdef\n${READY(7)}`);
  assert.deepEqual(r.requests, [{ pr: 7, head: A, items: 'abcdefabcdef', repo: null }]);
  assert.equal('areas' in r.requests[0], false, 'so it approves no diff that has areas');
  // a line that is not an Areas line at all (a bullet) is prose too
  assert.equal('areas' in presentedRequests(`- Areas R1-a\nHead ${A} · items abcdefabcdef\n${READY(7)}`).requests[0], false);
});

// ---- an owner item that falls in no area cannot be shown ---------------------------------------------------------------------

test('owner-items fails closed when items exist but name no area (an item line with an empty rule: nothing to put on the Areas line)', () => {
  // No real hard-stop / integrity path builds such a line today (a rule id is never ''), so this drives ownerItemsCheck and areasOf directly.
  const ok = { ok: true };
  const items = ['integrity  src/x.js'];
  assert.deepEqual(areasOf(items), []);
  const c = ownerItemsCheck({ items, hardstops: ok, integrity: ok, label: false });
  assert.equal(c.ok, false, c.detail);
  assert.match(c.detail, /no area/);
  // one area-less item among normal ones still fails: the Areas line would leave it out
  const mixed = ownerItemsCheck({ items: ['integrity deleted-test test/a.js', 'integrity  src/x.js'], hardstops: ok, integrity: ok, label: false });
  assert.equal(mixed.ok, false, mixed.detail);
  assert.match(mixed.detail, /1 owner item\(s\) name no area \(integrity  src\/x\.js\)/);
  // the normal case is untouched: items with areas pass, and no items pass
  assert.equal(ownerItemsCheck({ items: ['integrity deleted-test test/a.js'], hardstops: ok, integrity: ok, label: false }).ok, true);
  assert.equal(ownerItemsCheck({ items: [], hardstops: ok, integrity: ok, label: false }).ok, true);
});
