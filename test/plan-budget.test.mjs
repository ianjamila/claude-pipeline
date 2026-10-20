// `P plan start | review | findings` (ship redesign T5): the per-PR reviewer budget and the Codex / Fable plan reviews. A real git
// repo, a STATEFUL fake gh (fixtures/fake-gh-store.mjs: it keeps the comments the commands post, so a command's own re-list sees
// them, and can lag or fail on request) and the scripted fake codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { run } from '../pipeline/commands/plan.mjs';
import { parseEvent, renderEvent } from '../pipeline/lib/run-events.mjs';
import { decodeRecord } from '../pipeline/lib/run-record.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { sha256 } from '../pipeline/lib/review-context.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeGhStore = join(here, 'fixtures', 'fake-gh-store.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');
const REL = 'docs/plans/p.md';
const SESSION1 = '01a15771-c132-7fe3-9ec0-1dec54d940a6';

const planText = (extra = '') => [
  '## In plain English', 'A small change.', '', '## Scope', `- \`${REL}\``, '- `src/**`', '',
  '### Task T1: do T1', `Add the widget.${extra}`, '',
].join('\n');
const ymlText = ['version: 1', 'project: demo', 'enforcement: github', 'verify:', '  full: npm run verify', '  quick: npm run verify:quick', 'ci:', '  required_checks: [ci]', '  guard_checks: false', ''].join('\n');

const finding = (over = {}) => ({ title: 'Missing step', file: REL, line: 3, category: 'design', detail: 'The plan skips a step.', reasoning: 'Step 2 needs it.', testable: false, ...over });
const findingsOf = (blocking = []) => ({ summary: 'Reviewed.', blocking, suggestions: [], worth_considering: [] });
const jsonl = (session, usage) => [
  ...(session ? [{ type: 'thread.started', thread_id: session }] : []), { type: 'turn.started' },
  ...(usage ? [{ type: 'turn.completed', usage: { cache_write_input_tokens: 0, reasoning_output_tokens: 0, ...usage } }] : []),
].map((e) => JSON.stringify(e)).join('\n') + '\n';

function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', ymlText);
  repo.write(REL, planText());
  const head = repo.commit('plan');
  const scratch = mkdtempSync(join(tmpdir(), 'plan-budget-'));
  const store = join(scratch, 'store.json');
  const capture = join(scratch, 'codex-capture.jsonl');
  const w = { repo, scratch, store, capture, home: mkdtempSync(join(tmpdir(), 'plan-budget-home-')), now: Date.parse('2026-10-19T10:00:00Z') };
  writeFileSync(store, JSON.stringify({ head, headRef: 'agent/x', comments: [], nextId: 100 }));
  w.read = () => JSON.parse(readFileSync(store, 'utf8'));
  w.edit = (fn) => { const s = w.read(); fn(s); writeFileSync(store, JSON.stringify(s)); };
  w.env = (extra = {}) => ({
    ...process.env, PIPELINE_GH: `node "${fakeGhStore}"`, PIPELINE_FAKE_STORE: store, PIPELINE_FAKE_GH_LOG: join(scratch, 'gh.jsonl'),
    PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: capture, ...extra,
  });
  w.call = (args, env = {}) => run(args, { cwd: repo.dir, env: w.env(env), home: w.home, now: () => w.now });
  w.events = () => w.read().comments.map((c) => parseEvent(c.body)).filter(Boolean);
  w.starts = () => w.events().filter((e) => e.kind === 'plan-review-started');
  w.summary = () => decodeRecord(w.read().comments.find((c) => c.body.startsWith(MARKERS.summary)).body).record;
  w.blob = () => repo.git(['rev-parse', `HEAD:${REL}`]).trim();
  w.record = async () => { const r = await w.call(['record', '--pr', '7', '--file', REL]); assert.equal(r.exitCode, 0, JSON.stringify(r.output)); return r; };
  w.captured = () => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.file = (name, content) => { const f = join(scratch, name); writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); return f; };
  // The env that makes the fake codex answer with findings and (optionally) JSONL events.
  w.codexEnv = ({ findings = findingsOf([finding()]), session = SESSION1, usage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } } = {}) => ({
    FAKE_CODEX_OUTPUT: w.file(`findings-${Math.random().toString(36).slice(2, 8)}.json`, findings),
    FAKE_CODEX_STDOUT: jsonl(session, usage),
  });
  return w;
}

const startArgs = (reviewer, key, extra) => ['start', '--pr', '7', '--reviewer', reviewer, '--key', key, ...(extra ? ['--extra', extra] : [])];
const reviewArgs = (key, extra, more = []) => ['review', '--pr', '7', '--key', key, ...(extra ? ['--extra', extra] : []), ...more];

test('start (fable): a first key goes, a second is over the cap of 1 (recorded, exit 1 cap), an owner extra buys one more', async (t) => {
  const w = world(t);
  await w.record();
  const a = await w.call(startArgs('fable', 'f1'));
  assert.equal(a.exitCode, 0, JSON.stringify(a.output));
  assert.deepEqual([a.output.go, a.output.key, a.output.reviewer, a.output.planBlob], [true, 'f1', 'fable', w.blob()]);
  assert.match(a.output.claim, /^[0-9a-f]{16}$/);
  const b = await w.call(startArgs('fable', 'f2'));
  assert.deepEqual([b.exitCode, b.output.error], [1, 'cap']);
  const c = await w.call(startArgs('fable', 'f3', 'owner: one more'));
  assert.equal(c.exitCode, 0, JSON.stringify(c.output));
  assert.equal(c.output.go, true);
  const kinds = w.starts().map((e) => [e.data.key, e.data.extra ?? null]);
  assert.deepEqual(kinds, [['f1', null], ['f2', null], ['f3', 'owner: one more']]);
});

test('start: validates the key and the reviewer; needs an active proposal; codex is refused (use-plan-review)', async (t) => {
  const w = world(t);
  const none = await w.call(startArgs('fable', 'f1'));
  assert.deepEqual([none.exitCode, none.output.error], [1, 'no-proposal']);
  await w.record();
  await assert.rejects(() => w.call(startArgs('fable', 'bad key!')), /--key/);
  await assert.rejects(() => w.call(startArgs('gemini', 'k1')), /--reviewer/);
  const codex = await w.call(startArgs('codex', 'c1'));
  assert.deepEqual([codex.exitCode, codex.output.error], [1, 'use-plan-review']);
  assert.equal(w.starts().length, 0, 'a refused codex start posts nothing');
});

test('start: a retry with an existing key posts no comment and never returns go twice', async (t) => {
  const w = world(t);
  await w.record();
  assert.equal((await w.call(startArgs('fable', 'f1'))).exitCode, 0);
  const posts = () => readFileSync(join(w.scratch, 'gh.jsonl'), 'utf8').split('\n').filter((l) => /-X","POST|"POST"/.test(l)).length;
  const before = posts();
  const again = await w.call(startArgs('fable', 'f1'));
  assert.deepEqual([again.exitCode, again.output.error], [1, 'already-started']);
  assert.equal(again.output.valid, true);
  assert.equal(posts(), before, 'no POST on the retry');
  assert.equal(w.starts().length, 1);
});

test('plan review: two runs launch, a third is over the cap, one owner extra buys exactly one more', async (t) => {
  const w = world(t);
  await w.record();
  const env = w.codexEnv();
  assert.equal((await w.call(reviewArgs('c1'), env)).exitCode, 0);
  assert.equal((await w.call(reviewArgs('c2'), env)).exitCode, 0);
  const third = await w.call(reviewArgs('c3'), env);
  assert.deepEqual([third.exitCode, third.output.error], [1, 'cap']);
  const launches = () => w.captured().length;
  assert.equal(launches(), 2, 'the void start launched nothing');
  const extra = await w.call(reviewArgs('c4', 'owner: one more'), env);
  assert.equal(extra.exitCode, 0, JSON.stringify(extra.output));
  assert.equal(launches(), 3);
  const again = await w.call(reviewArgs('c5'), env);
  assert.equal(again.output.error, 'cap', 'one extra buys exactly one run');
});

test('a void plan-review start takes no slot: after a void start, one owner extra buys exactly one more run', async (t) => {
  const w = world(t);
  await w.record();
  const env = w.codexEnv();
  for (const k of ['c1', 'c2', 'c3']) await w.call(reviewArgs(k), env);
  assert.equal(w.captured().length, 2);
  assert.equal((await w.call(reviewArgs('c4', 'owner: go on'), env)).exitCode, 0);
  assert.equal((await w.call(reviewArgs('c5'), env)).output.error, 'cap');
  assert.equal(w.captured().length, 3);
});

test('two racing callers with the same key: only the earliest comment\'s claim gets go, the other is already-started', async (t) => {
  const w = world(t);
  await w.record();
  const first = await w.call(startArgs('fable', 'race'));
  assert.equal(first.exitCode, 0);
  // The second caller lists BEFORE it posts and does not see the first comment yet; after its own POST both are listed.
  w.edit((s) => { s.comments.find((c) => String(c.body).includes('plan-review-started')).hideForGets = 1; });
  const second = await w.call(startArgs('fable', 'race'));
  assert.deepEqual([second.exitCode, second.output.error], [1, 'already-started']);
  assert.equal(w.starts().length, 2, 'both comments exist');
  assert.equal([first, second].filter((r) => r.output.go === true).length, 1, 'exactly one go');
});

test('start: a listing that omits the comment just created is exit 3 not-visible, never go', async (t) => {
  const w = world(t);
  await w.record();
  w.edit((s) => { s.hidePosted = true; });
  const r = await w.call(startArgs('fable', 'f1'));
  assert.deepEqual([r.exitCode, r.output.error], [3, 'not-visible']);
  assert.equal(r.output.go, undefined);
});

test('start: a POST that fails with 502 but whose comment appears on the re-list is decided normally', async (t) => {
  const w = world(t);
  await w.record();
  w.edit((s) => { s.failPostAfterStore = 1; });
  const r = await w.call(startArgs('fable', 'f1'));
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.go, true);
  assert.equal(w.starts().length, 1);
});

test('start (fable): promptHeader carries ROUND: plan and a 64-hex digest that changes with the key', async (t) => {
  const w = world(t);
  await w.record();
  const a = await w.call(startArgs('fable', 'f1', 'owner: more'));
  const b = await w.call(startArgs('fable', 'f2', 'owner: again'));
  const digest = (r) => /^ROUND: plan\nINPUT-DIGEST: ([0-9a-f]{64})$/.exec(r.output.promptHeader)?.[1];
  assert.ok(digest(a) && digest(b));
  assert.notEqual(digest(a), digest(b));
  assert.equal(digest(a), sha256(['acme/widgets', 7, 'fable-plan', w.blob(), 'f1'].join('\n')));
});

// ---- findings (Fable) ---------------------------------------------------------------------------------------------------------

const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
function installTranscript(w, { prompt, text, tag, ts = '2026-10-19T09:30:00.000Z', model = 'claude-fable-5-1', effort = 'high', agentType = 'fable-reviewer', agentId = 'a1' }) {
  const projects = mkdtempSync(join(w.scratch, 'projects-'));
  const dir = join(projects, '-tmp-work', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', isSidechain: true, agentId, message: { role: 'user', content: prompt }, uuid: 'u-1', timestamp: ts },
    { type: 'assistant', isSidechain: true, agentId, requestId: 'req_1', effort, perTurnEffort: effort, message: { model, id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }, uuid: 'a-1', timestamp: '2026-10-19T09:30:06.000Z' },
  ];
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, agentType, description: tag }));
  return projects;
}
const findingsArgs = (key, tag, projects, claim, more = []) => ['findings', '--pr', '7', '--key', key, '--tag', tag, '--claim', claim, '--projects-dir', projects, ...more];

test('findings: refuses a key with no valid start, a transcript older than the start, a prompt without the header, an existing file', async (t) => {
  const w = world(t);
  await w.record();
  const TAG = 'plan-fable f1';
  const good = (header) => installTranscript(w, { prompt: `${header}\nReview the plan.`, text: fenced(findingsOf([finding()])), tag: TAG });

  // no start at all
  const noStart = await w.call(findingsArgs('f1', TAG, good('ROUND: plan\nINPUT-DIGEST: ' + '0'.repeat(64)), '0'.repeat(16)));
  assert.deepEqual([noStart.exitCode, noStart.output.error], [1, 'no-start']);

  const start = await w.call(startArgs('fable', 'f1'));
  const header = start.output.promptHeader;
  const claim = start.output.claim;

  // a transcript whose first line is older than the start event
  const old = await w.call(findingsArgs('f1', TAG, installTranscript(w, { prompt: `${header}\nGo.`, text: fenced(findingsOf()), tag: TAG, ts: '2026-10-19T08:00:00.000Z' }), claim));
  assert.equal(old.exitCode, 1);
  assert.match(old.output.errors.join(' '), /older than/);

  // a first user message without the header
  const noHeader = await w.call(findingsArgs('f1', TAG, good('Please review the plan.'), claim));
  assert.equal(noHeader.exitCode, 1);
  assert.match(noHeader.output.errors.join(' '), /ROUND: plan|INPUT-DIGEST/);

  // the wrong model
  const wrong = await w.call(findingsArgs('f1', TAG, installTranscript(w, { prompt: `${header}\nGo.`, text: fenced(findingsOf()), tag: TAG, model: 'claude-opus-5-1' }), claim));
  assert.equal(wrong.exitCode, 1);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'plan', 'f1.json')), 'nothing written on any refusal');

  // a proven transcript is accepted and written
  const ok = await w.call(findingsArgs('f1', TAG, good(header), claim));
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.output));
  assert.deepEqual(ok.output.counts, { blocking: 1, suggestions: 0, worth_considering: 0 });
  const written = JSON.parse(readFileSync(join(w.repo.dir, '.review', 'plan', 'f1.json'), 'utf8'));
  assert.deepEqual([written.reviewer, written.key, written.blob], ['fable', 'f1', w.blob()]);
  assert.equal(written.items.length, 1);
  assert.match(readFileSync(join(w.repo.dir, '.review', 'plan', 'f1.md'), 'utf8'), /Fable plan review/);

  // already recorded
  const again = await w.call(findingsArgs('f1', TAG, good(header), claim));
  assert.deepEqual([again.exitCode, again.output.error], [1, 'exists']);
});

test('findings: no transcript is exit 2; a plan re-recorded after the start is stale-start', async (t) => {
  const w = world(t);
  await w.record();
  const start = await w.call(startArgs('fable', 'f1'));
  const none = await w.call(findingsArgs('f1', 'plan-fable f1', mkdtempSync(join(w.scratch, 'empty-')), start.output.claim));
  assert.equal(none.exitCode, 2);
  // the plan changes: a new blob is the active proposal
  w.repo.write(REL, planText(' Changed.'));
  const head = w.repo.commit('edit plan');
  w.edit((s) => { s.head = head; });
  await w.record();
  const projects = installTranscript(w, { prompt: `${start.output.promptHeader}\nGo.`, text: fenced(findingsOf()), tag: 'plan-fable f1' });
  const stale = await w.call(findingsArgs('f1', 'plan-fable f1', projects, start.output.claim));
  assert.deepEqual([stale.exitCode, stale.output.error], [1, 'stale-start']);
});

// ---- review (Codex) -----------------------------------------------------------------------------------------------------------

const planDir = (w) => join(w.repo.dir, '.review', 'plan');
const readPlanFile = (w, name) => JSON.parse(readFileSync(join(planDir(w), name), 'utf8'));

test('review: session and usage are captured and booked once under codex:<session>:<key>; the same key again is already-started', async (t) => {
  const w = world(t);
  await w.record();
  const r = await w.call(reviewArgs('c1'), w.codexEnv());
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.ok, r.output.key, r.output.resumed, r.output.cost], [true, 'c1', false, 'booked']);
  assert.deepEqual(r.output.counts, { blocking: 1, suggestions: 0, worth_considering: 0 });
  const file = readPlanFile(w, 'c1.json');
  assert.deepEqual([file.reviewer, file.key, file.blob, file.session, file.resumedFrom], ['codex', 'c1', w.blob(), SESSION1, null]);
  assert.deepEqual(file.usage, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 });
  assert.equal(file.items[0].id, 'R1-B1');
  assert.ok(existsSync(join(planDir(w), 'c1.md')));
  const entry = w.summary().cost.entries[`codex:${SESSION1}:c1`];
  assert.deepEqual([entry.phase, entry.role, entry.input, entry.cacheRead, entry.output, entry.usd], ['plan', 'codex', 600, 400, 50, 0]);
  // the argv of a first run: fresh exec with --json, the schema and the sandbox
  const argv = w.captured()[0].argv;
  assert.deepEqual([argv[0], argv.includes('--json'), argv.includes('--sandbox')], ['exec', true, true]);
  assert.match(w.captured()[0].stdin, /IMPLEMENTATION PLAN for pull request #7/);

  const again = await w.call(reviewArgs('c1'), w.codexEnv());
  assert.deepEqual([again.exitCode, again.output.error], [1, 'already-started']);
  assert.equal(w.captured().length, 1, 'no second launch');
  assert.deepEqual(Object.keys(w.summary().cost.entries), [`codex:${SESSION1}:c1`], 'no second booking');
});

test('review: a recheck resumes the first session (exec resume <id>) and books only its own share of the cumulative usage', async (t) => {
  const w = world(t);
  await w.record();
  await w.call(reviewArgs('c1'), w.codexEnv());
  const prior = w.file('prior.md', readFileSync(join(planDir(w), 'c1.md'), 'utf8'));
  // Codex reports usage CUMULATIVE over the thread: the second turn's figures include the first's.
  const second = await w.call(reviewArgs('c2', undefined, ['--prior', prior]), w.codexEnv({ findings: findingsOf(), usage: { input_tokens: 2500, cached_input_tokens: 1400, output_tokens: 120 } }));
  assert.equal(second.exitCode, 0, JSON.stringify(second.output));
  assert.deepEqual([second.output.resumed, second.output.cost], [true, 'booked']);
  const call = w.captured()[1];
  assert.deepEqual(call.argv.slice(0, 3), ['exec', 'resume', SESSION1]);
  assert.ok(!call.argv.includes('--sandbox') && !call.argv.includes('-C'));
  assert.match(call.stdin, /ONE recheck/);
  assert.match(call.stdin, /Missing step/, 'the prior findings are in the prompt');
  const file = readPlanFile(w, 'c2.json');
  assert.deepEqual([file.resumedFrom, file.session], ['c1', SESSION1]);
  assert.deepEqual(file.usage, { input_tokens: 2500, cached_input_tokens: 1400, output_tokens: 120 }, 'the stored figures are as reported');
  const entries = w.summary().cost.entries;
  assert.deepEqual(Object.keys(entries).sort(), [`codex:${SESSION1}:c1`, `codex:${SESSION1}:c2`], 'review and recheck on one session are two entries');
  const e2 = entries[`codex:${SESSION1}:c2`];
  assert.deepEqual([e2.input, e2.cacheRead, e2.output], [500, 1000, 70]);
});

test('review: no thread.started means no session: cost not-reported, nothing booked, and a recheck is fresh (resumed: false)', async (t) => {
  const w = world(t);
  await w.record();
  const first = await w.call(reviewArgs('c1'), w.codexEnv({ session: null, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }));
  assert.equal(first.exitCode, 0, JSON.stringify(first.output));
  assert.deepEqual([first.output.resumed, first.output.cost], [false, 'not-reported']);
  assert.equal(readPlanFile(w, 'c1.json').session, null);
  assert.deepEqual(Object.keys(w.summary().cost?.entries ?? {}), []);
  const prior = w.file('prior.md', readFileSync(join(planDir(w), 'c1.md'), 'utf8'));
  const second = await w.call(reviewArgs('c2', undefined, ['--prior', prior]), w.codexEnv({ session: null, usage: null }));
  assert.deepEqual([second.exitCode, second.output.resumed, second.output.cost], [0, false, 'not-reported']);
  const call = w.captured()[1];
  assert.ok(!call.argv.includes('resume'));
  assert.match(call.stdin, /ONE recheck/);
  assert.match(call.stdin, /Missing step/);
});

test('review: an interrupted run (exit 1 after thread.started) is exit 3, the failed file keeps the session, and the key is consumed', async (t) => {
  const w = world(t);
  await w.record();
  const r = await w.call(reviewArgs('c1'), { FAKE_CODEX_STDOUT: jsonl(SESSION1, null), FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'boom' });
  assert.equal(r.exitCode, 3);
  assert.deepEqual([r.output.ok, r.output.unavailable, r.output.reason, r.output.session], [false, true, 'error', SESSION1]);
  assert.equal(readPlanFile(w, 'c1.failed.json').session, SESSION1);
  assert.ok(!existsSync(join(planDir(w), 'c1.json')));
  const retry = await w.call(reviewArgs('c1'), w.codexEnv());
  assert.deepEqual([retry.exitCode, retry.output.error], [1, 'already-started']);
  assert.equal(w.captured().length, 1);
  // The consumed key took its slot: one more key fits under the cap of two, then the third is void.
  assert.equal((await w.call(reviewArgs('c2'), w.codexEnv())).exitCode, 0);
  assert.equal((await w.call(reviewArgs('c3'), w.codexEnv())).output.error, 'cap');
});

test('review: when another caller\'s claim turns out to be the earliest after the run, the result is superseded and not counted', async (t) => {
  const w = world(t);
  await w.record();
  // While "Codex is thinking" the start comment's claim is rewritten to another caller's (the listing had lagged for us).
  const hijack = join(w.scratch, 'hijack.mjs');
  const eventsUrl = new URL('../pipeline/lib/run-events.mjs', import.meta.url).href;
  writeFileSync(hijack, [
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    `import { parseEvent, renderEvent } from '${eventsUrl}';`,
    `const f = process.env.PIPELINE_FAKE_STORE; const s = JSON.parse(readFileSync(f, 'utf8'));`,
    `for (const c of s.comments) { const e = parseEvent(c.body); if (e?.kind === 'plan-review-started') c.body = renderEvent(e.kind, e.id, e.sentence, { ...e.data, claim: 'ffffffffffffffff' }); }`,
    `writeFileSync(f, JSON.stringify(s));`,
  ].join('\n'));
  const r = await w.call(reviewArgs('c1'), { ...w.codexEnv(), FAKE_CODEX_DURING: `node "${hijack}"` });
  assert.deepEqual([r.exitCode, r.output.error], [1, 'superseded']);
  assert.ok(existsSync(join(planDir(w), 'c1.superseded.json')));
  assert.ok(!existsSync(join(planDir(w), 'c1.json')), 'never shown as a review');
  assert.deepEqual(Object.keys(w.summary().cost?.entries ?? {}), [], 'never booked');
});

test('review: a plan re-recorded while Codex ran is stale-start: the result is set aside, not counted', async (t) => {
  const w = world(t);
  await w.record();
  const bump = join(w.scratch, 'bump.mjs');
  writeFileSync(bump, [
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    `import { parseEvent, renderEvent } from '${new URL('../pipeline/lib/run-events.mjs', import.meta.url).href}';`,
    `const f = process.env.PIPELINE_FAKE_STORE; const s = JSON.parse(readFileSync(f, 'utf8'));`,
    `const data = s.comments.map((c) => parseEvent(c.body)).find((e) => e?.kind === 'plan-proposed').data;`,
    `s.comments.push({ id: s.nextId++, user: { login: 'me' }, body: renderEvent('plan-proposed', 'later-2', 'Plan proposed', { ...data, blob: 'b'.repeat(40), n: 2 }), created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z' });`,
    `writeFileSync(f, JSON.stringify(s));`,
  ].join('\n'));
  const r = await w.call(reviewArgs('c1'), { ...w.codexEnv(), FAKE_CODEX_DURING: `node "${bump}"` });
  assert.deepEqual([r.exitCode, r.output.error], [1, 'stale-start']);
  assert.ok(!existsSync(join(planDir(w), 'c1.json')));
});
