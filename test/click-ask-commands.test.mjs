// #261 (click-to-approve, PR A, plan Rev 6 B6): `--ask` on `merge --dry-run --owner-go`, the merge-many form (`--prs`), `triage round-request` and `triage ruling-request`. The commands run IN PROCESS
// (run(argv, ctx)) with a temp account home (ctx.home, the same seam `pipeline owner-go` has) so the asks, the dialog-hook list and the owner-go folder are never the developer's real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, ghEntries, PR, REPO, scenario, ymlFor } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { presentedRequests, presentedRoundRequest, presentedRuling, readyLine } from '../pipeline/hooks/lib/owner-go.mjs';
import { asksDir, readAsk } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { run as mergeRun, dryRunMany, withAsk } from '../pipeline/commands/merge.mjs';
import { run as triageRun } from '../pipeline/commands/triage.mjs';

const homes = [];
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
// A temp account home with an empty ~/.claude: no dialog hook at all, so the hook check passes.
function newHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'click-ask-')));
  mkdirSync(join(home, '.claude'), { recursive: true });
  homes.push(home);
  return home;
}
const asks = (home) => (existsSync(asksDir(home)) ? readdirSync(asksDir(home)) : []);
// A dialog hook (PreToolUse on AskUserQuestion, or PermissionRequest) that the owner has not listed.
function addDialogHook(home, event = 'PreToolUse') {
  const dir = join(home, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notify.mjs'), 'process.exit(0)\n');
  const entry = { ...(event === 'PreToolUse' ? { matcher: 'AskUserQuestion' } : {}), hooks: [{ type: 'command', command: `node ${join(dir, 'notify.mjs')}` }] };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { [event]: [entry] } }));
}

const CHAT = (extra = '') => `${ymlFor()}owner_approval: chat\n${extra}`;
const baseEnv = (s) => ({ ...process.env, PIPELINE_MERGEABLE_PAUSE_MS: '1', PIPELINE_MACHINE_ID: 'click-ask-test', ...s.fake.env, ...s.env });
// What GitHub says about the PR for the dry run (see merge-dry-run.test.mjs).
const prView = (s) => ({ match: '^pr view 12 --json state,headRefOid.*baseRefOid', stdoutJson: { state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefOid: s.baseTip } });
const script = (s, gh = {}) => [REPO, prView(s), ...ghEntries({ prHead: s.head, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', ...gh })];
const mergeArgs = (...more) => ['--pr', String(PR), '--dry-run', '--owner-go', ...more];
const mergeCtx = (s, home) => ({ cwd: s.repo.dir, env: baseEnv(s), home, managedPaths: [] });
async function dry(s, { home, args = ['--ask'], gh } = {}) {
  s.fake.setScript(script(s, gh));
  return mergeRun(mergeArgs(...args), mergeCtx(s, home));
}
const chatWorld = (yml = CHAT()) => scenario({ yml, report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });

// ---- merge --pr N --dry-run --owner-go --ask --------------------------------------------------------------------------------------------------

test('merge --ask: a say-merge issues the ask; the question is the title and EXACTLY ownerStep.closing; the ask file is written and binds this PR', async () => {
  const s = chatWorld();
  const home = newHome();
  const r = await dry(s, { home });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  const { ownerStep, ask } = r.output;
  assert.equal(ownerStep.kind, 'say-merge');
  assert.match(ask.askId, /^ask-[0-9a-f]{12}$/);
  assert.equal(ask.questions.length, 1);
  const q = ask.questions[0];
  assert.equal(q.question, `Merge #${PR}? (${ask.askId})\n\n${ownerStep.closing}`);
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map((o) => o.label), ['Not yet', 'Merge']);
  assert.ok(q.options.every((o) => !('preview' in o)));
  // what the owner-go hook reads from the question is the request this dry run printed
  const { requests } = presentedRequests(q.question);
  assert.deepEqual(requests.map((x) => [x.pr, x.head, x.repo]), [[PR, s.head.slice(0, 12), 'acme/widgets']]);
  const file = readAsk(ask.askId, { home });
  assert.equal(file.ok, true);
  assert.deepEqual(file.ask.prs, [PR]);
  assert.equal(file.ask.kind, 'merge');
  assert.match(file.ask.hookLayersSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(asks(home), [`${ask.askId}.json`]);
});

test('merge --ask: a second ask for the same PR supersedes the first', async () => {
  const s = chatWorld();
  const home = newHome();
  const a = (await dry(s, { home })).output.ask.askId;
  const b = (await dry(s, { home })).output.ask.askId;
  assert.notEqual(a, b);
  assert.deepEqual(asks(home).sort(), [`${a}.json`, `${a}.superseded`, `${b}.json`].sort());
});

test('merge --dry-run --owner-go WITHOUT --ask writes no ask and prints no ask fields (C7: the plain dry run writes nothing)', async () => {
  const s = chatWorld();
  const home = newHome();
  const r = await dry(s, { home, args: [] });
  assert.equal(r.exitCode, 0);
  assert.equal('ask' in r.output, false);
  assert.equal('askSkipped' in r.output, false);
  assert.deepEqual(asks(home), []);
  assert.deepEqual(readdirSync(join(home, '.claude')), [], 'nothing at all was written under the account home');
});

test('merge --ask: label mode -> ask null, askSkipped names owner_approval; nothing is written', async () => {
  const s = chatWorld(ymlFor());
  const home = newHome();
  const r = await dry(s, { home });
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_approval is not chat/);
  assert.deepEqual(asks(home), []);
});

test('merge --ask: owner_go.click off -> ask null, askSkipped says so', async () => {
  const s = chatWorld(CHAT('owner_go:\n  click: off\n'));
  const home = newHome();
  const r = await dry(s, { home });
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_go\.click is off/);
  assert.deepEqual(asks(home), []);
});

test('merge --ask: a dialog hook the owner has not approved -> ask null, askSkipped carries the hook check\'s reason and the fix', async () => {
  const s = chatWorld();
  const home = newHome();
  addDialogHook(home);
  const r = await dry(s, { home });
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /^dialog hooks not approved: unlisted dialog hook ~\/\.claude\/hooks\/notify\.mjs[\s\S]*approve-dialog-hooks/);
  assert.deepEqual(asks(home), []);
});

test('merge --ask: blockers (a failing required check) -> no ask even though ownerStep is a say-merge', async () => {
  const s = chatWorld();
  const home = newHome();
  const r = await dry(s, { home, gh: { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.ownerStep.kind, 'say-merge');
  assert.equal(r.output.ask, null);
  assert.equal(r.output.askSkipped, 'blockers');
  assert.deepEqual(asks(home), []);
});

const OK_CONFIG = { owner_approval: 'chat', owner_go: { click: 'on' } };
const stepOf = (over = {}) => ({ kind: 'say-merge', line: `Head ${'a'.repeat(12)} · items none · repo acme/widgets`, closing: `Head ${'a'.repeat(12)} · items none · repo acme/widgets\n${readyLine([5])}`, ...over });

test('withAsk: an ownerStep that is not a say-merge, or a closing that binds nothing, is not asked (the reason is named)', () => {
  const home = newHome();
  const args = { root: tmpdir(), config: OK_CONFIG, pr: 5, slug: 'acme/widgets', ctx: { home, managedPaths: [] } };
  for (const ownerStep of [null, { kind: 'owner-runs', command: 'x' }, { kind: 'owner-approval-flags', reason: 'x' }]) {
    const r = withAsk({ exitCode: 0, output: { ownerStep, blockers: [] } }, args);
    assert.equal(r.output.ask, null);
    assert.equal(r.output.askSkipped, 'not-say-merge');
  }
  const bad = withAsk({ exitCode: 0, output: { ownerStep: stepOf({ closing: 'nothing the hook could read' }), blockers: [] } }, args);
  assert.equal(bad.output.ask, null);
  assert.match(bad.output.askSkipped, /^the ask could not be issued: unbindable/);
  const other = withAsk({ exitCode: 0, output: { ownerStep: stepOf({ closing: `Head ${'a'.repeat(12)} · items none · repo acme/widgets\n${readyLine([6])}` }), blockers: [] } }, args);
  assert.match(other.output.askSkipped, /^the ask could not be issued/, 'a closing for another PR is never issued');
  assert.deepEqual(asks(home), []);
});

test('merge: --ask and --prs are usage errors without --dry-run --owner-go, and --prs excludes --pr and needs 2-4 distinct PRs', () => {
  const s = chatWorld();
  const run = (...args) => cli(['merge', ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });
  const bad = [['--pr', '12', '--ask'], ['--pr', '12', '--dry-run', '--ask'], ['--pr', '12', '--owner-go', '--ask'], ['--prs', '12,13', '--dry-run', '--owner-go'], ['--pr', '12', '--prs', '12,13', '--dry-run', '--owner-go', '--ask'],
    ['--prs', '12', '--dry-run', '--owner-go', '--ask'], ['--prs', '12,12', '--dry-run', '--owner-go', '--ask'], ['--prs', '1,2,3,4,5', '--dry-run', '--owner-go', '--ask'], ['--prs', '12,x', '--dry-run', '--owner-go', '--ask']];
  for (const args of bad) {
    const r = run(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
});

// ---- merge-many ----------------------------------------------------------------------------------------------------------------------------------

const manyStep = (pr, over = {}) => {
  const line = `Head ${String(pr).padStart(12, 'c')} · items none · repo acme/widgets`;
  return { kind: 'say-merge', line, ...over, closing: [over.rulings, over.areas, over.hold, line, readyLine([pr])].filter(Boolean).join('\n') };
};
const canned = (steps) => async (pr) => {
  const step = steps[pr];
  return { pr, wouldMerge: step?.kind === 'say-merge' && !step.blocked, blockers: step?.blocked ? [{ kind: 'live-check', detail: 'ci: red' }] : [], ownerStep: step ?? null };
};
// The repo's config and `gh repo view` come from a real scenario (root is its worktree); the dry runs themselves are the canned seam.
async function many(prs, steps, { yml = CHAT(), home = newHome() } = {}) {
  const s = scenario({ yml, report: null, state: null });
  s.fake.setScript([REPO]);
  const { config } = await loadConfig(s.repo.dir);
  const r = await dryRunMany({ root: s.repo.dir, config, prs, ctx: { env: baseEnv(s), home, managedPaths: [] }, dryRunOf: canned(steps) });
  return { r, home };
}

test('merge-many: two ready PRs -> one multi-select question; each PR\'s Areas / Head lines are #N-prefixed, ONE 🔀 line; the hook reads both requests', async () => {
  const { r, home } = await many([12, 13], { 12: manyStep(12, { areas: 'Areas auth rls' }), 13: manyStep(13) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  assert.deepEqual(r.output.prs.map((p) => [p.pr, p.included]), [[12, true], [13, true]]);
  const q = r.output.ask.questions[0];
  assert.equal(q.multiSelect, true);
  assert.deepEqual(q.options.map((o) => o.label), ['Merge #12', 'Merge #13']);
  const block = ['#12 Areas auth rls', `#12 ${manyStep(12).line}`, `#13 ${manyStep(13).line}`, readyLine([12, 13])].join('\n');
  assert.ok(q.question.endsWith(`\n\n${block}`), q.question);
  assert.equal(q.question.split('\n').filter((l) => l.includes('🔀')).length, 1);
  const read = presentedRequests(q.question);
  assert.deepEqual(read.prs, [12, 13]);
  assert.deepEqual(read.requests.map((x) => [x.pr, x.head, x.repo, x.areas !== undefined]), [[12, `${'c'.repeat(10)}12`, 'acme/widgets', true], [13, `${'c'.repeat(10)}13`, 'acme/widgets', false]]);
  assert.deepEqual(readAsk(r.output.ask.askId, { home }).ask.prs, [12, 13]);
});

test('merge-many: a PR with a Rulings block, a Hold, a blocker or another ending is excluded with its reason; the rest are asked', async () => {
  const rulings = 'Rulings 0123456789ab\nR1-B1 · REJECT · BLOCKING · security · by claude · content 0123456789ab · "x" · why: y';
  const hold = 'Hold LE_1 by jamila at 2026-11-05T09:00:00Z';
  const steps = { 12: manyStep(12), 13: manyStep(13), 14: manyStep(14, { rulings, rulingCount: 1 }), 15: manyStep(15, { hold, ready: readyLine([15], { lift: true }) }) };
  const { r } = await many([12, 13, 14, 15], steps);
  assert.deepEqual(r.output.prs.map((p) => [p.pr, p.included, p.excludedReason]), [[12, true, undefined], [13, true, undefined], [14, false, 'rulings'], [15, false, 'hold']]);
  assert.deepEqual(r.output.ask.questions[0].options.map((o) => o.label), ['Merge #12', 'Merge #13']);
  assert.ok(r.output.ask.questions[0].question.endsWith(readyLine([12, 13])));
  const b = await many([12, 13, 14], { 12: manyStep(12), 13: manyStep(13, { blocked: true }), 14: { kind: 'owner-runs', command: 'x' } });
  assert.deepEqual(b.r.output.prs.map((p) => [p.included, p.excludedReason]), [[true, undefined], [false, 'blockers'], [false, 'not-say-merge']]);
  assert.equal(b.r.output.ask, null);
  assert.equal(b.r.output.askSkipped, 'fewer-than-two-ready');
  assert.deepEqual(asks(b.home), []);
});

test('merge-many: fewer than two ready -> ask null, askSkipped fewer-than-two-ready (the skill asks per PR)', async () => {
  const { r, home } = await many([12, 13], { 12: manyStep(12) });
  assert.equal(r.output.ask, null);
  assert.equal(r.output.askSkipped, 'fewer-than-two-ready');
  assert.equal(r.output.prs.find((p) => p.pr === 13).excludedReason, 'not-say-merge');
  assert.deepEqual(asks(home), []);
});

test('merge-many: label mode and click off skip the ask but still list every PR', async () => {
  const label = await many([12, 13], { 12: manyStep(12), 13: manyStep(13) }, { yml: ymlFor() });
  assert.match(label.r.output.askSkipped, /owner_approval is not chat/);
  assert.equal(label.r.output.prs.length, 2);
  const off = await many([12, 13], { 12: manyStep(12), 13: manyStep(13) }, { yml: CHAT('owner_go:\n  click: off\n') });
  assert.match(off.r.output.askSkipped, /owner_go\.click is off/);
  assert.deepEqual(asks(off.home), []);
});

// ---- triage round-request / ruling-request ---------------------------------------------------------------------------------------------------------

// A repo at PR 12 whose review state is at the round cap (max_rounds 1, one reviewed round with open items) and holds two items to rule on.
function triageWorld(yml = CHAT()) {
  const s = scenario({ yml, report: null, state: null });
  let st = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'high', maxRounds: 1 });
  const item = (id, title) => ({ id, source: 'codex', bucket: 'BLOCKING', category: 'security', title, file: 'src/app.js', line: 1, detail: 'detail', codexReasoning: 'why', final: null });
  st = addRound(st, { n: 1, fromHead: 'a', toHead: s.head, contentHashAtToHead: s.hash, items: [item('R1-B1', 'Missing check'), item('R1-S3', 'Another\nmultiline   finding')] });
  saveState(s.repo.dir, st);
  s.fake.setScript([REPO]);
  return s;
}
const triage = (s, home, ...args) => triageRun(args, { cwd: s.repo.dir, env: baseEnv(s), home, managedPaths: [] });

test('triage round-request --ask: the question is the title and exactly the printed line; the ask binds the round request', async () => {
  const s = triageWorld();
  const home = newHome();
  const plain = await triage(s, home, 'round-request', '--pr', String(PR));
  assert.equal(plain.exitCode, 0, JSON.stringify(plain.output));
  assert.equal('ask' in plain.output, false);
  assert.deepEqual(asks(home), [], 'without --ask nothing is written');
  const r = await triage(s, home, 'round-request', '--pr', String(PR), '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.line, plain.output.line);
  const q = r.output.ask.questions[0];
  assert.equal(q.question, `One more review round for #${PR}? (${r.output.ask.askId})\n\n${r.output.line}`);
  assert.deepEqual(q.options.map((o) => o.label), ['No', 'Yes, one more round']);
  assert.equal(presentedRoundRequest(q.question).pr, PR);
  assert.equal(readAsk(r.output.ask.askId, { home }).ask.kind, 'round');
});

test('triage round-request --ask: label mode refuses as before (no ask); click off and an unapproved hook give ask null + askSkipped', async () => {
  const label = triageWorld(ymlFor());
  const none = await triage(label, newHome(), 'round-request', '--pr', String(PR), '--ask');
  assert.equal(none.exitCode, 1);
  assert.match(none.output.reason, /only with owner_approval: chat/);
  const off = triageWorld(CHAT('owner_go:\n  click: off\n'));
  const homeOff = newHome();
  const r = await triage(off, homeOff, 'round-request', '--pr', String(PR), '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_go\.click is off/);
  assert.match(r.output.line, /^🔁 Extra review round needed/, 'the typed line is still printed');
  assert.deepEqual(asks(homeOff), []);
  const s = triageWorld();
  const home = newHome();
  addDialogHook(home, 'PermissionRequest');
  const h = await triage(s, home, 'round-request', '--pr', String(PR), '--ask');
  assert.equal(h.output.ask, null);
  assert.match(h.output.askSkipped, /^dialog hooks not approved: unlisted dialog hook/);
});

test('triage ruling-request --ask: item summaries above, then exactly the printed line; every option is an answer for ALL asked ids; the typed line still ends the question', async () => {
  const s = triageWorld();
  const home = newHome();
  const plain = await triage(s, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1,r1-s3');
  assert.equal(plain.exitCode, 0, JSON.stringify(plain.output));
  assert.equal('ask' in plain.output, false);
  assert.deepEqual(asks(home), []);
  const r = await triage(s, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1,r1-s3', '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.line, plain.output.line);
  const q = r.output.ask.questions[0];
  assert.equal(q.question, `Your ruling on #${PR}? (${r.output.ask.askId})\n\nR1-B1 · BLOCKING · Missing check · src/app.js:1\nR1-S3 · BLOCKING · Another multiline finding · src/app.js:1\n${r.output.line}`);
  assert.deepEqual(q.options.map((o) => o.label), ['Not now', 'Accept all', 'Follow-up all', 'Reject all']);
  assert.deepEqual(presentedRuling(q.question), { pr: PR, repo: 'acme/widgets', ids: ['R1-B1', 'R1-S3'], content: /content ([0-9a-f]{12})/.exec(r.output.line)[1] });
  const file = readAsk(r.output.ask.askId, { home }).ask;
  assert.equal(file.kind, 'ruling');
  assert.equal(file.actions['Accept all'], 'R1-B1: accept, R1-S3: accept');
});

test('triage ruling-request --ask: label mode -> ask null (the typed line stays); an unknown id still refuses', async () => {
  const label = triageWorld(ymlFor());
  const r = await triage(label, newHome(), 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_approval is not chat/);
  assert.match(r.output.line, /^⚖️ Owner ruling needed/);
  const s = triageWorld();
  const bad = await triage(s, newHome(), 'ruling-request', '--pr', String(PR), '--ids', 'R9-B9', '--ask');
  assert.equal(bad.exitCode, 1);
  assert.equal('ask' in bad.output, false);
});
