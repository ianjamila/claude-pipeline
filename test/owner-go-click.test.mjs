// #261 (click-to-approve, PR A, T1): the owner's click on a choice dialog as a recorded "merge" / "extra round" / ruling. The transcripts under test/fixtures/click/<build>/ are trimmed copies
// (prompt, AskUserQuestion tool_use, its tool_result; cwd and repo names neutral, every metadata field as that Claude Code build wrote it), one folder per build in CLICK_BUILDS, recorded by
// scripts/click-spike.mjs (2.1.322: the 2026-11-11 spikes by hand): genuine-click (a keystroke click), pretooluse-hook-answer, permissionrequest-hook-answer, model-prefilled-answers,
// preview-annotations, multiselect-click, and from 2.1.323 on pretooluse-ask-prefill (a hook that answers "ask" with prefilled answers: Claude Code submits them itself, stamped user_temporary
// but with reasonCode hook:PreToolUse). The fixture-driven cases run for EVERY build in CLICK_BUILDS, so a new build gets the whole matrix by adding its folder. A test rewrites the dialog text
// and answer inside a copy to bind a real closing block (and moves the result's time 30 s after the tool_use when the recording was answered sooner than MIN_ANSWER_MS, so the 2 s floor is
// never what a case proves); it never touches a metadata field unless the case IS that field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OWNER_GO_REL, approvalGap, approvedPr, claimGrantMarkers, grantIdOf, ownerGoDir, ownerGrantedRounds, ownerRuled, readApprovals, verifyOwnerGrant,
} from '../pipeline/hooks/lib/owner-go.mjs';
import {
  ASKS_REL, CLICK_BUILDS, HUMAN_DECISION, MIN_ANSWER_MS, asksDir, canonicalDialog, clickEvidence, clickProvenance, dialogSha256, issueAsk, mergeAsk, mergeManyAsk, readAsk, recordClick, roundAsk, rulingAsk,
} from '../pipeline/hooks/lib/owner-go-click.mjs';
import { mergeRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';

const REPO = 'acme/app';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD2 = 'fedcba9876543210fedcba9876543210fedcba98';
const ITEMS = 'abcdef012345';
const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const FIX = new URL('./fixtures/click/', import.meta.url);
const OLDEST = '2.1.322'; // the build the rest of this file's builds-agnostic tests (and its few 2.1.322-specific assertions) run on
const BUILD_DIR = (build) => new URL(`${build}/`, FIX);
const loadFixture = (name, build = OLDEST) => readFileSync(new URL(`${name}.jsonl`, BUILD_DIR(build)), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const buildNo = (b) => b.split('.').map(Number);
const buildAtLeast = (b, min) => { const [x, y] = [buildNo(b), buildNo(min)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };
// The fixture set every build in CLICK_BUILDS must have; pretooluse-ask-prefill exists from 2.1.323 on (2.1.322 has no such Claude Code behaviour to record).
const REQUIRED = ['genuine-click', 'pretooluse-hook-answer', 'permissionrequest-hook-answer', 'model-prefilled-answers', 'preview-annotations', 'multiselect-click'];
const requiredFor = (build) => (buildAtLeast(build, '2.1.323') ? [...REQUIRED, 'pretooluse-ask-prefill'] : REQUIRED);
const OK = () => ({ ok: true, hookLayersSha256: null });
const noSleep = async () => {};

const mergeParts = (pr = 58, head = HEAD) => mergeAsk({ repo: REPO, pr, closing: mergeRequest(pr, head, ITEMS, REPO) });
const roundParts = () => roundAsk({ repo: REPO, pr: 58, line: roundRequest(58, 4, GHEAD, REPO) });
const rulingParts = () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequest(58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000') });
const manyParts = () => mergeManyAsk({
  repo: REPO,
  entries: [58, 59].map((pr) => ({ pr, lines: [`#${pr} head ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}`] })),
  ready: '🔀 Ready to merge #58, #59 — say "merge"',
});

// An ask file written by hand the way a copy of the lib minted outside the three commands would (R1-F4): any title, options and actions, a consistent dialog hash.
function forgeAsk({ kind, repo, prs, header, title, block, options, actions, hookLayersSha256, home, issuedAt }) {
  const askId = `ask-${'a1b2c3d4e5f6'}`;
  mkdirSync(asksDir(home), { recursive: true });
  const dialog = canonicalDialog({ question: `${title} (${askId})\n\n${block}`, header, multiSelect: kind === 'merge-many', options });
  writeFileSync(join(asksDir(home), `${askId}.json`), `${JSON.stringify({ v: 1, askId, kind, repo, prs, dialog, dialogSha256: dialogSha256(dialog), actions, issuedAt: new Date(issuedAt).toISOString(), hookLayersSha256 })}\n`);
  return { askId, questions: [dialog] };
}

// A world: a temp home, an issued ask and a transcript holding the fixture's entries rewritten to the ask's dialog and `answer` (default: the approving label). `tamper(dialog)` returns the dialog the
// transcript shows instead of the issued one; `mutate({ prompt, use, result })` edits the entries (a metadata case); `fixture` picks the spike transcript; `write: false` leaves the transcript with
// the prompt and the tool_use only (poll tests append the result themselves).
function world(t, { parts = mergeParts(), answer = null, fixture = 'genuine-click', build = OLDEST, tamper = null, mutate = null, hookLayersSha256 = null, issueBeforeUseMs = 10000, write = true, forge = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-click-'));
  const entries = loadFixture(fixture, build);
  const [prompt, use, result] = entries;
  // a recording the script made by keys or a hook was answered in under 2 s: move the answer to 30 s so that the 2 s floor is never what a case proves (mutate may still set its own time)
  if (Date.parse(result.timestamp) - Date.parse(use.timestamp) < MIN_ANSWER_MS) result.timestamp = new Date(Date.parse(use.timestamp) + 30000).toISOString();
  const issuedAt = Date.parse(use.timestamp) - issueBeforeUseMs;
  const issued = forge ? forgeAsk({ ...parts, hookLayersSha256, home, issuedAt }) : issueAsk({ ...parts, hookLayersSha256, home, now: () => issuedAt });
  assert.ok(issued.askId, `issue failed: ${JSON.stringify(issued)}`);
  const dialog = tamper ? tamper(structuredClone(issued.questions[0])) : issued.questions[0];
  const chosen = answer ?? Object.keys(parts.actions).find((l) => parts.actions[l] !== null);
  const block = use.message.content.find((b) => b.type === 'tool_use');
  block.input = { questions: [dialog] };
  const stamped = typeof result.toolUseResult === 'object' && result.toolUseResult !== null ? result.toolUseResult : {}; // (the rejected spike's result is a string)
  result.toolUseResult = { ...stamped, questions: [structuredClone(dialog)], answers: { [dialog.question]: chosen } };
  if (!('annotations' in stamped)) delete result.toolUseResult.annotations;
  result.message.content[0].content = `Your questions have been answered: "${dialog.question}"="${chosen}". You can now continue with these answers in mind.`;
  mutate?.({ prompt, use, result, dialog });
  const cfg = join(home, '.claude-click-test');
  mkdirSync(join(cfg, 'projects', '-repo'), { recursive: true });
  const file = join(cfg, 'projects', '-repo', 't.jsonl');
  const text = (es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(file, text(write ? [prompt, use, result] : [prompt, use]));
  const answeredAt = Date.parse(result.timestamp);
  const w = {
    home, file, issued, askId: issued.askId, dialog, prompt, use, result, session: use.sessionId, toolUseId: block.id, answeredAt, issuedAt, text,
    now: () => answeredAt + 1000,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: '/work/app', tool_use_id: block.id, tool_input: { questions: [dialog] }, tool_response: {} },
  };
  w.click = (over = {}, input = {}) => recordClick({ ...w.input, ...input }, { home, now: w.now, sleep: noSleep, hookCheck: OK, ...over });
  w.records = () => { try { return readFileSync(join(ownerGoDir(home), `${w.session}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  w.gap = (over = {}) => approvalGap({ repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], home, now: w.now, ...over });
  return w;
}

// ---- the happy paths, through every consumer --------------------------------------------------------------------------------------------

test('a genuine click on Merge records the typed record plus via/ask, ts = the answer time, and every consumer accepts it', (t) => {
  const w = world(t);
  return w.click().then((r) => {
    assert.equal(r.recorded?.via, 'ask', JSON.stringify(r));
    assert.equal(r.kind, 'merge');
    assert.equal(r.recorded.prompt, 'merge');
    assert.equal(r.recorded.ts, new Date(w.answeredAt).toISOString(), 'ts is the tool_result entry time, not the recording time');
    assert.equal(r.recorded.prompt_id, null);
    assert.equal(r.recorded.transcript_path, w.file);
    assert.deepEqual([r.recorded.ask.askId, r.recorded.ask.toolUseId, r.recorded.ask.clickId.length], [w.askId, w.toolUseId, 16]);
    assert.deepEqual(r.recorded.requests.map((q) => [q.pr, q.head, q.items, q.repo]), [[58, HEAD.slice(0, 12), ITEMS, REPO]]);
    assert.equal(clickProvenance(r.recorded, { home: w.home }), 'owner');
    assert.equal(w.gap(), 'ok');
    assert.equal(approvedPr({ repo: REPO, pr: 58, head: HEAD, session: w.session, home: w.home, now: w.now }), true);
    assert.equal(readApprovals({ home: w.home, now: w.now })[0].via, 'ask', 'readApprovals keeps via/ask');
    assert.ok(existsSync(join(asksDir(w.home), `${w.askId}.spent`)), 'the spent marker is there');
  });
});

test('the head moved after the click: the approval covers the old head only (approvalGap none)', async (t) => {
  const w = world(t);
  assert.equal((await w.click()).recorded?.via, 'ask');
  assert.equal(w.gap({ head: HEAD2 }), 'none');
  assert.equal(w.gap(), 'ok');
});

test('a ruling click (Accept all) rules every asked item through ownerRuled', async (t) => {
  const w = world(t, { parts: rulingParts(), answer: 'Accept all' });
  const r = await w.click();
  assert.equal(r.recorded?.kind, 'ruling', JSON.stringify(r));
  assert.equal(r.recorded.prompt, 'R1-B1: accept, R2-S3: accept');
  assert.equal(clickProvenance(r.recorded, { home: w.home }), 'owner');
  const q = { repo: REPO, pr: 58, quote: 'R1-B1: accept, R2-S3: accept', decision: 'ACCEPT', contentOf: () => 'c0ffee000000', home: w.home, now: w.now };
  assert.equal(ownerRuled({ ...q, id: 'R1-B1' }), true);
  assert.equal(ownerRuled({ ...q, id: 'R2-S3' }), true);
  assert.equal(ownerRuled({ ...q, id: 'R1-B1', decision: 'REJECT', quote: 'R1-B1: reject' }), false);
  assert.equal(ownerRuled({ ...q, id: 'R1-B1', contentOf: () => 'other0000000' }), false, 'the finding-content digest is still checked');
});

test('an extra-round click is a grant: ownerGrantedRounds sees it, and a consumed one verifies 30 h later', async (t) => {
  const w = world(t, { parts: roundParts(), answer: 'Yes, one more round' });
  const r = await w.click();
  assert.equal(r.recorded?.kind, 'extra-round', JSON.stringify(r));
  const q = { repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: w.now };
  const granted = ownerGrantedRounds(q);
  assert.equal(granted.length, 1);
  const claim = claimGrantMarkers(granted, { repo: REPO, pr: 58, k: 4, head: GHEAD, checkout: '/work/app' }, { home: w.home, now: w.now });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(ownerGrantedRounds(q).length, 0, 'consumed');
  const later = { home: w.home, now: () => w.answeredAt + 30 * 3600 * 1000 };
  const v = verifyOwnerGrant({ repo: REPO, pr: 58, k: 4, toHead: GHEAD, ownerGrant: { grantId: grantIdOf(r.recorded), quote: 'extra round', k: 4 } }, later);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(clickProvenance(r.recorded, later), 'owner', 'the proof is immutable: no expiry against now');
});

test('merge-many: ticked labels become one approval per PR; a partial or foreign label records nothing', async (t) => {
  const w = world(t, { parts: manyParts(), answer: 'Merge #58, Merge #59', fixture: 'multiselect-click' });
  const r = await w.click();
  assert.equal(r.kind, 'merge-many', JSON.stringify(r));
  assert.equal(r.recorded.prompt, 'merge #58 #59');
  assert.equal(w.gap(), 'ok');
  assert.equal(w.gap({ pr: 59 }), 'ok');
  const one = world(t, { parts: manyParts(), answer: 'Merge #59', fixture: 'multiselect-click' });
  assert.equal((await one.click()).recorded?.prompt, 'merge #59');
  assert.equal(one.gap(), 'none', 'only the ticked PR is approved');
  assert.equal(one.gap({ pr: 59 }), 'ok');
  const odd = world(t, { parts: manyParts(), answer: 'Merge #58, merge everything', fixture: 'multiselect-click' });
  assert.deepEqual(await odd.click(), { refused: 'answer-not-a-label' });
  assert.equal(odd.records().length, 0);
});

test('every build in CLICK_BUILDS: a genuine click and a multiselect click are recorded (the build allowlist admits the recorded builds)', async (t) => {
  for (const build of CLICK_BUILDS) {
    const w = world(t, { build });
    const r = await w.click();
    assert.equal(r.recorded?.via, 'ask', `${build}: ${JSON.stringify(r)}`);
    assert.equal(r.recorded.prompt, 'merge');
    assert.equal(clickProvenance(r.recorded, { home: w.home }), 'owner', build);
    assert.equal(w.gap(), 'ok', build);
    assert.equal(JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.spent`), 'utf8')).producerVersion, build);
    // (the multiselect recording's own answer varies by build; the test binds the labels it needs in the copy)
    const many = world(t, { build, parts: manyParts(), answer: 'Merge #58, Merge #59', fixture: 'multiselect-click' });
    const m = await many.click();
    assert.equal(m.kind, 'merge-many', `${build}: ${JSON.stringify(m)}`);
    assert.equal(m.recorded.prompt, 'merge #58 #59');
    assert.equal(many.gap({ pr: 59 }), 'ok', build);
  }
});

test('a genuine 2.1.323 click (the recording, answered after 30 s) is recorded and proven', async (t) => {
  const w = world(t, { build: '2.1.323' });
  const r = await w.click();
  assert.equal(r.recorded?.via, 'ask', JSON.stringify(r));
  assert.equal(clickProvenance(r.recorded, { home: w.home }), 'owner');
  assert.equal(w.gap(), 'ok');
});

test('"Other" free text goes through the same strict parser: "merge" records, "merge after CI" records nothing and consumes nothing', async (t) => {
  const yes = world(t, { answer: 'merge' });
  assert.equal((await yes.click()).recorded?.prompt, 'merge');
  assert.equal(yes.gap(), 'ok');
  const no = world(t, { answer: 'merge after CI' });
  assert.deepEqual(await no.click(), { refused: 'nothing-bound' });
  assert.equal(no.records().length, 0);
  assert.equal(existsSync(join(asksDir(no.home), `${no.askId}.spent`)), false, 'the ask stays answerable');
  const other = world(t, { answer: 'merge #99' });
  assert.deepEqual(await other.click(), { refused: 'nothing-bound' }, 'a PR the closing lines never asked about binds nothing');
});

test('"Not yet" is a declined marker, no record; a later click on the same ask is refused', async (t) => {
  const w = world(t, { answer: 'Not yet' });
  assert.deepEqual(await w.click(), { declined: 'Not yet' });
  assert.equal(w.records().length, 0);
  const marker = JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.spent`), 'utf8'));
  assert.equal(marker.declined, true);
  assert.deepEqual(await w.click(), { declined: 'Not yet', replay: true }, 'the same click again is idempotent');
  assert.equal(w.gap(), 'none');
});

test('replaying the same click is idempotent: one record, same clickId; a crash between marker and record is finished from the marker', async (t) => {
  const w = world(t);
  const first = await w.click();
  const again = await w.click();
  assert.equal(again.replay, true);
  assert.equal(again.recorded.ask.clickId, first.recorded.ask.clickId);
  assert.equal(w.records().length, 1);
  // crash: the marker is there, the record is not
  const home2 = world(t);
  assert.equal((await home2.click()).recorded?.via, 'ask');
  writeFileSync(join(ownerGoDir(home2.home), `${home2.session}.jsonl`), '');
  const finished = await home2.click();
  assert.equal(finished.recorded?.ts, new Date(home2.answeredAt).toISOString(), 'the finish keeps the answer time');
  assert.equal(home2.records().length, 1);
});

test('readers drop a duplicate record of one click (same ask.clickId)', async (t) => {
  const w = world(t);
  const { recorded } = await w.click();
  appendFileSync(join(ownerGoDir(w.home), `${w.session}.jsonl`), `${JSON.stringify(recorded)}\n`);
  assert.equal(w.records().length, 2);
  assert.equal(readApprovals({ home: w.home, now: w.now }).length, 1);
});

test('a second click on an ask already answered is refused (one ask, one use)', async (t) => {
  const w = world(t);
  assert.equal((await w.click()).recorded?.via, 'ask');
  // another dialog call (new tool_use id) with the same question text
  const second = structuredClone([w.use, w.result]);
  const [use2, result2] = second;
  use2.uuid = 'u-second-use'; use2.message.content[0].id = 'toolu_second';
  result2.uuid = 'u-second-result'; result2.parentUuid = 'u-second-use'; result2.sourceToolAssistantUUID = 'u-second-use'; result2.message.content[0].tool_use_id = 'toolu_second';
  appendFileSync(w.file, w.text([use2, result2]));
  assert.deepEqual(await w.click({}, { tool_use_id: 'toolu_second' }), { refused: 'spent' });
  assert.equal(w.records().length, 1);
});

// ---- the refusals ---------------------------------------------------------------------------------------------------------------------

test('an answer a hook gave (PreToolUse updatedInput, PermissionRequest) is refused: no user_temporary stamp (every build)', async (t) => {
  for (const build of CLICK_BUILDS) {
    for (const fixture of ['pretooluse-hook-answer', 'permissionrequest-hook-answer']) {
      const w = world(t, { fixture, build });
      assert.deepEqual(await w.click(), { refused: 'not-a-human-answer' }, `${build} ${fixture}`);
      assert.equal(w.records().length, 0);
    }
  }
});

// 2.1.323: a PreToolUse hook that answers "ask" with `updatedInput.answers` makes Claude Code show the dialog and then SUBMIT the prefilled answer itself after ~1.5-2 s, stamped
// decision accept / source user_temporary / grantScope once, but reasonCode "hook:PreToolUse" (a person's click: "unknown"), annotations {} and no `answers` in the tool_use input.
test('a hook-prefilled "ask" answer that Claude Code submitted itself is refused not-a-human-answer, whatever the answer time (every build that has the case)', async (t) => {
  const builds = [...new Set(['2.1.323', ...CLICK_BUILDS.filter((b) => buildAtLeast(b, '2.1.323'))])]; // 2.1.323 always: it is the build that recorded the case
  for (const build of builds) {
    const w = world(t, { fixture: 'pretooluse-ask-prefill', build, mutate: ({ use, result }) => { result.timestamp = new Date(Date.parse(use.timestamp) + 40000).toISOString(); } });
    assert.equal(w.result.permissionDecision.reasonCode, 'hook:PreToolUse', 'the fixture is the recorded hook auto-submit');
    assert.deepEqual(Object.keys(w.use.message.content[0].input), ['questions']);
    const ev = clickEvidence(w.file, w.toolUseId, { home: w.home });
    assert.deepEqual([ev.ok, ev.reason], [false, 'not-a-human-answer'], `${build} clickEvidence`);
    assert.deepEqual(await w.click(), { refused: 'not-a-human-answer' }, build);
    assert.equal(w.records().length, 0);
    // the recording's own, shorter time refuses the same way (the stamp is checked before the floor)
    const fast = world(t, { fixture: 'pretooluse-ask-prefill', build, mutate: ({ use, result }) => { result.timestamp = new Date(Date.parse(use.timestamp) + 1487).toISOString(); } });
    assert.equal(clickEvidence(fast.file, fast.toolUseId, { home: fast.home }).reason, 'not-a-human-answer');
  }
});

test('the human stamp is the WHOLE permissionDecision: an extra key, a missing grantScope or reasonCode, another grantScope or reasonCode is refused not-a-human-answer', async (t) => {
  assert.deepEqual(HUMAN_DECISION, { decision: 'accept', source: 'user_temporary', grantScope: 'once', reasonCode: 'unknown' });
  assert.ok(Object.isFrozen(HUMAN_DECISION));
  const { grantScope: _g, ...noGrantScope } = HUMAN_DECISION;
  const { reasonCode: _r, ...noReasonCode } = HUMAN_DECISION;
  const cases = {
    'extra key': { ...HUMAN_DECISION, reasonType: 'hook' },
    'no grantScope': noGrantScope,
    'no reasonCode': noReasonCode,
    'only decision and source': { decision: 'accept', source: 'user_temporary' },
    'another grantScope': { ...HUMAN_DECISION, grantScope: 'session' },
    'hook reasonCode': { ...HUMAN_DECISION, reasonCode: 'hook:PreToolUse' },
    'another reasonCode': { ...HUMAN_DECISION, reasonCode: 'rule' },
    'another source': { ...HUMAN_DECISION, source: 'user_permanent' },
    'not an object': 'accept',
    absent: undefined,
  };
  for (const build of CLICK_BUILDS) {
    for (const [name, pd] of Object.entries(cases)) {
      const w = world(t, { build, mutate: ({ result }) => { if (pd === undefined) delete result.permissionDecision; else result.permissionDecision = pd; } });
      assert.deepEqual(await w.click(), { refused: 'not-a-human-answer' }, `${build} ${name}`);
      assert.equal(w.records().length, 0, name);
    }
    const genuine = world(t, { build });
    assert.deepEqual(genuine.result.permissionDecision, HUMAN_DECISION, `${build}: the genuine fixture carries exactly the human stamp`);
  }
});

test('the model pre-filling `answers` in the tool input is refused (an input key, and the dialog was rejected on 2.1.322; auto-submitted with the human stamp on 2.1.323) (every build)', async (t) => {
  for (const build of CLICK_BUILDS) {
    const w = world(t, { fixture: 'model-prefilled-answers', build, mutate: ({ use, result }) => { use.message.content[0].input.answers = { x: 'Merge' }; result.message.content[0].is_error = undefined; result.timestamp = new Date(Date.parse(use.timestamp) + 2500).toISOString(); } });
    assert.deepEqual(await w.click(), { refused: 'tool-use-shape' }, build);
    assert.equal(w.records().length, 0);
  }
});

test('2.1.323 model-prefilled-answers: the recording itself carries the exact human stamp, so only the tool-use shape check refuses it (answer >= 2 s)', async (t) => {
  const w = world(t, { fixture: 'model-prefilled-answers', build: '2.1.323', mutate: ({ use, result }) => { use.message.content[0].input.answers = { x: 'Merge' }; result.timestamp = new Date(Date.parse(use.timestamp) + 2058).toISOString(); } });
  assert.deepEqual(w.result.permissionDecision, HUMAN_DECISION);
  assert.ok(Date.parse(w.result.timestamp) - Date.parse(w.use.timestamp) >= MIN_ANSWER_MS);
  assert.deepEqual(clickEvidence(w.file, w.toolUseId, { home: w.home }), { ok: false, reason: 'tool-use-shape' });
});

test('annotations (the owner pressed n for notes, or an option preview was copied in) are refused; the preview spike transcript too (every build)', async (t) => {
  for (const build of CLICK_BUILDS) {
    const notes = world(t, { build, mutate: ({ result, dialog }) => { result.toolUseResult.annotations = { [dialog.question]: { notes: 'but only after lunch' } }; } });
    assert.deepEqual(await notes.click(), { refused: 'annotations' }, build);
    const preview = world(t, { fixture: 'preview-annotations', build });
    assert.deepEqual(await preview.click(), { refused: 'annotations' }, `${build}: the dialog itself is canonical here; the annotations are what refuses`);
    const withPreview = world(t, { build, tamper: (d) => { d.options[1].preview = 'Rulings ...'; return d; } });
    assert.equal((await withPreview.click()).refused, 'dialog-not-canonical', build);
    const loaded = loadFixture('preview-annotations', build)[2].toolUseResult.annotations;
    assert.ok(Object.values(loaded).some((a) => 'preview' in a), `${build}: the spike copied the chosen option preview into annotations`);
  }
});

test('a dialog edited after issue is refused: one character, an added option, another header, multiSelect flipped, a description changed', async (t) => {
  const cases = {
    'one character': (d) => { d.question = d.question.replace('Merge #58?', 'Merge #58!'); return d; },
    'option added': (d) => { d.options.push({ label: 'Maybe', description: 'x' }); return d; },
    'header changed': (d) => { d.header = 'Approve'; return d; },
    'multiSelect flipped': (d) => { d.multiSelect = true; return d; },
    'description changed': (d) => { d.options[1].description = 'Merge it, whatever it is.'; return d; },
    'option removed': (d) => { d.options.shift(); return d; },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const w = world(t, { tamper, answer: 'Merge' });
    assert.deepEqual(await w.click(), { refused: 'dialog-differs' }, name);
    assert.equal(w.records().length, 0, name);
  }
});

test('the result must show the same dialog as the tool_use', async (t) => {
  const w = world(t, { mutate: ({ result }) => { result.toolUseResult.questions[0].header = 'Other'; } });
  assert.deepEqual(await w.click(), { refused: 'result-dialog-differs' });
});

test('an ask id this machine never issued, or none, is not ours (null)', async (t) => {
  const w = world(t);
  const forged = { ...w.input, tool_input: { questions: [{ ...w.dialog, question: w.dialog.question.replace(w.askId, 'ask-aaaaaaaaaaaa') }] } };
  assert.equal(await recordClick(forged, { home: w.home, now: w.now, sleep: noSleep, hookCheck: OK }), null);
  const none = { ...w.input, tool_input: { questions: [{ ...w.dialog, question: 'Merge it?' }] } };
  assert.equal(await recordClick(none, { home: w.home, now: w.now, sleep: noSleep, hookCheck: OK }), null);
  assert.equal(await w.click({}, { tool_name: 'Bash' }), null);
  assert.equal(await w.click({}, { agent_id: 'sub-1' }), null);
  assert.equal(await w.click({}, { transcript_path: join(w.home, '.claude-click-test', 'projects', '-repo', 'x', 'subagents', 'a.jsonl') }), null);
  assert.equal(await w.click({}, { session_id: '../etc' }), null);
});

test('entry checks: sidechain, is_error, a parent chain elsewhere, headless entrypoint, a build off the allowlist, the two entries on different builds', async (t) => {
  const cases = {
    'sidechain use': [({ use }) => { use.isSidechain = true; }, 'sidechain'],
    'sidechain result': [({ result }) => { result.isSidechain = true; }, 'sidechain'],
    is_error: [({ result }) => { result.message.content[0].is_error = true; }, 'tool-result-shape'],
    'parent elsewhere': [({ result }) => { result.parentUuid = 'u-somewhere-else'; }, 'chain'],
    'source elsewhere': [({ result }) => { result.sourceToolAssistantUUID = 'u-somewhere-else'; }, 'chain'],
    'sdk-cli result': [({ result }) => { result.entrypoint = 'sdk-cli'; }, 'entrypoint'],
    'sdk-cli use': [({ use }) => { use.entrypoint = 'sdk-cli'; }, 'entrypoint'],
    'versions differ': [({ result }) => { result.version = '2.1.323'; }, 'version'],
    'permissionDecision with a hook reason': [({ result }) => { result.permissionDecision = { ...HUMAN_DECISION, reasonCode: 'hook:PreToolUse' }; }, 'not-a-human-answer'],
    'other session': [({ result }) => { result.sessionId = '22222222-2222-4222-8222-222222222222'; }, 'session'],
    'two blocks': [({ result }) => { result.message.content.push({ type: 'text', text: 'x' }); }, 'tool-result-shape'],
    'answers for two questions': [({ result }) => { result.toolUseResult.answers.extra = 'x'; }, 'answers-shape'],
    'permission denied': [({ result }) => { result.permissionDecision = { decision: 'deny', source: 'user_temporary' }; }, 'not-a-human-answer'],
    'no annotations key': [({ result }) => { delete result.toolUseResult.annotations; }, 'annotations'],
  };
  for (const [name, [mutate, reason]] of Object.entries(cases)) {
    const w = world(t, { mutate });
    assert.deepEqual(await w.click(), { refused: reason }, name);
    assert.equal(w.records().length, 0, name);
  }
  for (const other of ['2.1.321', '2.1.324']) {
    const unlisted = world(t, { mutate: ({ use, result }) => { use.version = other; result.version = other; } });
    assert.deepEqual(await unlisted.click(), { refused: 'build-not-allowlisted' }, other);
    assert.equal(unlisted.records().length, 0, other);
  }
});

test('CLICK_BUILDS is frozen; every build has its fixture folder with the required files, and every fixture was written by that build', () => {
  assert.ok(Object.isFrozen(CLICK_BUILDS));
  assert.ok(CLICK_BUILDS.length > 0 && CLICK_BUILDS.every((b) => /^\d+\.\d+\.\d+$/.test(b)));
  assert.equal(new Set(CLICK_BUILDS).size, CLICK_BUILDS.length);
  for (const build of CLICK_BUILDS) {
    const files = readdirSync(BUILD_DIR(build)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
    for (const name of requiredFor(build)) assert.ok(files.includes(name), `${build} is missing test/fixtures/click/${build}/${name}.jsonl (record it with scripts/click-spike.mjs)`);
    for (const name of files) {
      const entries = loadFixture(name, build);
      assert.equal(entries.length, 3, `${build}/${name}`);
      assert.deepEqual([entries[1].version, entries[2].version], [build, build], `${build}/${name}: the fixture's version field is its folder name`);
    }
  }
  // no fixture folder for a build that is not allowlisted is a stale recording
  const folders = readdirSync(FIX, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(folders, [...CLICK_BUILDS].sort(), 'every fixture folder is an allowlisted build and vice versa');
});

test('an answer sooner than 2 s after the dialog opened is a typed-ahead key, refused; 2 s exactly passes', async (t) => {
  const early = world(t, { mutate: ({ use, result }) => { result.timestamp = new Date(Date.parse(use.timestamp) + 1999).toISOString(); } });
  assert.deepEqual(await early.click(), { refused: 'too-fast' });
  const edge = world(t, { mutate: ({ use, result }) => { result.timestamp = new Date(Date.parse(use.timestamp) + 2000).toISOString(); } });
  assert.equal((await edge.click()).recorded?.via, 'ask');
});

test('a superseded ask cannot be answered; a newer ask of the same kind, repo and PR supersedes the older, other PRs do not', async (t) => {
  const w = world(t);
  const newer = issueAsk({ ...mergeParts(), home: w.home, now: () => w.issuedAt + 1000 });
  assert.ok(newer.askId);
  assert.ok(existsSync(join(asksDir(w.home), `${w.askId}.superseded`)));
  assert.deepEqual(await w.click(), { refused: 'superseded' });
  assert.equal(w.records().length, 0);
  const other = issueAsk({ ...mergeParts(59), home: w.home, now: () => w.issuedAt + 2000 });
  assert.ok(other.askId);
  assert.equal(existsSync(join(asksDir(w.home), `${newer.askId}.superseded`)), false, 'another PR leaves it alone');
});

test('an ask older than 24 h at answer time, or answered before it was issued, is refused', async (t) => {
  const old = world(t, { issueBeforeUseMs: 25 * 3600 * 1000 });
  assert.deepEqual(await old.click(), { refused: 'expired' });
  const before = world(t, { issueBeforeUseMs: -60000 });
  assert.deepEqual(await before.click(), { refused: 'answered-before-issue' });
});

test('the dialog-hook check: unchecked refuses, a changed fingerprint refuses, the issue-time fingerprint admits', async (t) => {
  const w = world(t, { hookLayersSha256: 'a'.repeat(64) });
  assert.deepEqual(await recordClick(w.input, { home: w.home, now: w.now, sleep: noSleep }), { refused: 'dialog-hooks-unchecked' });
  assert.deepEqual(await w.click({ hookCheck: () => ({ ok: true, hookLayersSha256: 'b'.repeat(64) }) }), { refused: 'dialog-hooks-changed' });
  assert.deepEqual(await w.click({ hookCheck: () => ({ ok: false, reason: 'dialog-hook-unlisted: notify.mjs' }) }), { refused: 'dialog-hook-unlisted: notify.mjs' });
  assert.equal(w.records().length, 0);
  assert.equal((await w.click({ hookCheck: () => ({ ok: true, hookLayersSha256: 'a'.repeat(64) }) })).recorded?.via, 'ask');
  const marker = JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.spent`), 'utf8'));
  assert.deepEqual([marker.producerVersion, marker.hookLayersSha256, marker.declined], ['2.1.322', 'a'.repeat(64), false]);
});

// ---- the transcript lands after the hook starts (S6) --------------------------------------------------------------------------------------

test('the tool_result entry not yet written: polled in 100 ms steps, recorded once it appears', async (t) => {
  const w = world(t, { write: false });
  let slept = 0;
  const sleep = async (ms) => { slept += ms; if (slept === 300) appendFileSync(w.file, w.text([w.result])); };
  const r = await w.click({ sleep });
  assert.equal(r.recorded?.via, 'ask', JSON.stringify(r));
  assert.equal(slept, 300);
});

test('the entry never appears: refused not-in-transcript after the whole poll, nothing recorded', async (t) => {
  const w = world(t, { write: false });
  let slept = 0;
  const r = await w.click({ sleep: async (ms) => { slept += ms; }, pollMs: 1000 });
  assert.deepEqual(r, { refused: 'not-in-transcript' });
  assert.equal(slept, 1000);
  assert.equal(w.records().length, 0);
});

// ---- the proof every consumer runs (B4) ------------------------------------------------------------------------------------------------------

test('clickProvenance: a gone transcript entry or marker is missing; a changed answer, time or binding is not the owner', async (t) => {
  const w = world(t);
  const { recorded } = await w.click();
  const home = w.home;
  assert.equal(clickProvenance({ ...recorded, ts: new Date(w.answeredAt + 5000).toISOString() }, { home }), 'synthetic', 'ts must be the answer time');
  assert.equal(clickProvenance({ ...recorded, prompt: 'merge #58' }, { home }), 'synthetic');
  assert.equal(clickProvenance({ ...recorded, requests: [{ ...recorded.requests[0], head: HEAD2.slice(0, 12) }] }, { home }), 'synthetic', 'the binding is recomputed from the dialog text');
  assert.equal(clickProvenance({ ...recorded, ask: { ...recorded.ask, clickId: '0000000000000000' } }, { home }), 'synthetic');
  assert.equal(clickProvenance({ ...recorded, session: 'other-session' }, { home }), 'synthetic');
  assert.equal(clickProvenance({ ...recorded, transcript_path: '/tmp/.claude-x/projects/-r/t.jsonl' }, { home }), 'missing');
  // the owner's answer replaced by another one in the transcript: the recorded prompt no longer follows from it
  const swapped = structuredClone(w.result);
  swapped.toolUseResult.answers[w.dialog.question] = 'Not yet';
  writeFileSync(w.file, w.text([w.prompt, w.use, swapped]));
  assert.equal(clickProvenance(recorded, { home }), 'synthetic');
  // the entry gone
  writeFileSync(w.file, w.text([w.prompt, w.use]));
  assert.equal(clickProvenance(recorded, { home }), 'missing');
  assert.equal(w.gap(), 'provenance', 'a matching record with no evidence behind it approves nothing');
  assert.equal(approvedPr({ repo: REPO, pr: 58, head: HEAD, session: w.session, home, now: w.now }), false);
});

test('clickProvenance: a hook-stamped result written into the transcript afterwards is not the owner', async (t) => {
  const w = world(t);
  const { recorded } = await w.click();
  const forged = structuredClone(w.result);
  forged.permissionDecision = { decision: 'accept', source: 'hook', reasonType: 'hook' };
  writeFileSync(w.file, w.text([w.prompt, w.use, forged]));
  assert.equal(clickProvenance(recorded, { home: w.home }), 'synthetic');
  assert.equal(w.gap(), 'provenance');
});

test('clickProvenance: a spent marker removed or declined is no proof', async (t) => {
  const w = world(t);
  const { recorded } = await w.click();
  const spent = join(asksDir(w.home), `${w.askId}.spent`);
  const marker = JSON.parse(readFileSync(spent, 'utf8'));
  writeFileSync(spent, `${JSON.stringify({ ...marker, declined: true })}\n`);
  assert.equal(clickProvenance(recorded, { home: w.home }), 'synthetic');
  writeFileSync(spent, '{"v":1,"askId"');
  assert.equal(clickProvenance(recorded, { home: w.home }), 'synthetic', 'a partial marker is spent, never trusted');
  writeFileSync(spent, `${JSON.stringify({ ...marker, clickId: '1111111111111111' })}\n`);
  assert.equal(clickProvenance(recorded, { home: w.home }), 'synthetic');
});

// ---- the pieces -------------------------------------------------------------------------------------------------------------------------

test('R1-F4: an ask file with a relabelled dialog (\'Skip #58 for now?\', Yes => merge) records nothing and is no proof; the installed builders\' dialogs still read', async (t) => {
  const real = mergeParts();
  const relabelled = { ...real, title: 'Skip #58 for now?', options: [{ label: 'Not yet', description: 'Do nothing.' }, { label: 'Yes', description: 'Skip it.' }], actions: { 'Not yet': null, Yes: 'merge' } };
  const w = world(t, { parts: relabelled, answer: 'Yes', forge: true });
  assert.deepEqual(await w.click(), { refused: 'ask-invalid' });
  assert.deepEqual(w.records(), []);
  assert.equal(readAsk(w.askId, { home: w.home }).reason, 'invalid');
  // an installed dialog whose option MEANING was changed in the file (same labels, Merge mapped to a decline-looking text / another text) is no installed dialog either
  const swapped = world(t, { parts: { ...real, actions: { 'Not yet': 'merge', Merge: null } }, answer: 'Not yet', forge: true });
  assert.deepEqual(await swapped.click(), { refused: 'ask-invalid' });
  assert.deepEqual(swapped.records(), []);
  // a hand-made spent marker + record cannot make it proof either
  const rec = { v: 1, ts: new Date(w.answeredAt).toISOString(), session: w.session, via: 'ask', transcript_path: w.file, ask: { askId: w.askId, toolUseId: w.toolUseId, clickId: 'x'.repeat(16) }, prs: [58], requests: [] };
  writeFileSync(join(asksDir(w.home), `${w.askId}.spent`), `${JSON.stringify({ v: 1, askId: w.askId, clickId: rec.ask.clickId, toolUseId: w.toolUseId, answeredAt: new Date(w.answeredAt).toISOString(), dialogSha256: w.issued.questions[0] && dialogSha256(w.dialog) })}\n`);
  assert.equal(clickProvenance(rec, { home: w.home }), 'synthetic');
  // the real builders' dialogs of every kind read back
  for (const parts of [mergeParts(), roundParts(), rulingParts(), manyParts()]) {
    const home = mkdtempSync(join(tmpdir(), 'owner-go-click-'));
    const issued = issueAsk({ ...parts, home, now: () => 1 });
    assert.equal(readAsk(issued.askId, { home }).ok, true, parts.kind);
  }
  // issueAsk itself refuses a dialog that is not one of the installed ones
  assert.match(issueAsk({ ...relabelled, home: mkdtempSync(join(tmpdir(), 'owner-go-click-')) }).error, /unknown-dialog/);
});

test('canonicalDialog: fixed key order, multiSelect defaults to false, no preview, no unknown keys', () => {
  const c = canonicalDialog({ options: [{ description: 'd', label: 'l' }], header: 'h', question: 'q' });
  assert.equal(JSON.stringify(c), '{"question":"q","header":"h","multiSelect":false,"options":[{"label":"l","description":"d"}]}');
  assert.equal(canonicalDialog({ ...c, options: [{ ...c.options[0], preview: 'x' }] }), null);
  assert.equal(canonicalDialog({ ...c, extra: 1 }), null);
  assert.equal(canonicalDialog({ ...c, multiSelect: 'yes' }), null);
  assert.equal(canonicalDialog({ ...c, options: [] }), null);
  assert.equal(dialogSha256({ ...c, options: [{ ...c.options[0], preview: 'x' }] }), null);
  assert.equal(dialogSha256({ ...c, multiSelect: false }), dialogSha256({ question: 'q', header: 'h', options: c.options }));
});

test('issueAsk: question = title (askId) + blank line + block; an unbindable closing is never issued; the file is private and exact-create', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-click-'));
  const parts = mergeParts();
  const r = issueAsk({ ...parts, home, now: () => 1 });
  assert.match(r.askId, /^ask-[0-9a-f]{12}$/);
  assert.equal(r.questions[0].question, `Merge #58? (${r.askId})\n\n${mergeRequest(58, HEAD, ITEMS, REPO)}`);
  assert.deepEqual(r.questions[0].options.map((o) => o.label), ['Not yet', 'Merge']);
  assert.ok(r.questions[0].options.every((o) => !('preview' in o)));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(asksDir(home), `${r.askId}.json`), 'utf8'))), ['v', 'askId', 'kind', 'repo', 'prs', 'dialog', 'dialogSha256', 'actions', 'issuedAt', 'hookLayersSha256']);
  // the closing lines are another PR's, another repository's, or no request at all
  assert.match(issueAsk({ ...mergeAsk({ repo: REPO, pr: 58, closing: mergeRequest(59, HEAD, ITEMS, REPO) }), home }).error, /unbindable/);
  assert.match(issueAsk({ ...mergeAsk({ repo: REPO, pr: 58, closing: mergeRequest(58, HEAD, ITEMS, 'other/repo') }), home }).error, /unbindable/);
  assert.match(issueAsk({ ...mergeAsk({ repo: REPO, pr: 58, closing: 'looks fine' }), home }).error, /unbindable/);
  assert.match(issueAsk({ ...roundAsk({ repo: REPO, pr: 58, line: 'extra please' }), home }).error, /unbindable/);
  assert.match(issueAsk({ ...rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1'], line: rulingRequest(59, ['R1-B1'], REPO) }), home }).error, /unbindable/);
  assert.equal(mergeManyAsk({ repo: REPO, entries: [{ pr: 1, lines: [] }], ready: '' }), null);
});

test('ASKS_REL is the owner-go folder + /asks (the literal avoids a load-time import cycle with owner-go.mjs)', () => {
  assert.equal(ASKS_REL, `${OWNER_GO_REL}/asks`);
});

test('clickEvidence reports what the transcript holds, and nothing for an unprotected path', async (t) => {
  const w = world(t);
  const ev = clickEvidence(w.file, w.toolUseId, { home: w.home });
  assert.equal(ev.ok, true, JSON.stringify(ev));
  assert.deepEqual([ev.version, ev.session, ev.question === w.dialog.question, ev.answer, ev.answeredAt], ['2.1.322', w.session, true, 'Merge', w.result.timestamp]);
  assert.equal(ev.dialogSha256, dialogSha256(w.dialog));
  assert.equal(clickEvidence(w.file, w.toolUseId, { home: tmpdir() }).reason, 'transcript-not-protected');
  assert.equal(clickEvidence(w.file, 'toolu_nope', { home: w.home }).reason, 'not-in-transcript');
});

// #269 R26-F2: the record's kind is part of what the click proves, so a record cannot be relabelled as another kind.
test('clickProvenance: a record whose kind differs from the clicked ask is not the owner (merge, extra-round, ruling)', async (t) => {
  const merge = world(t);
  const m = (await merge.click()).recorded;
  assert.equal(clickProvenance(m, { home: merge.home }), 'owner');
  for (const kind of ['extra-round', 'past-round', 'ruling']) {
    assert.equal(clickProvenance({ ...m, kind, repo: REPO, pr: 58, k: 4, head: GHEAD }, { home: merge.home }), 'synthetic', `a merge click relabelled ${kind}`);
  }
  const round = world(t, { parts: roundParts(), answer: 'Yes, one more round' });
  const r = (await round.click()).recorded;
  assert.equal(clickProvenance(r, { home: round.home }), 'owner');
  for (const kind of ['past-round', 'ruling']) assert.equal(clickProvenance({ ...r, kind }, { home: round.home }), 'synthetic', `an extra-round click relabelled ${kind}`);
  const { kind: _dropped, ...noKind } = r;
  assert.equal(clickProvenance(noKind, { home: round.home }), 'synthetic', 'an extra-round click with its kind removed');
  const ruling = world(t, { parts: rulingParts(), answer: 'Accept all' });
  const g = (await ruling.click()).recorded;
  assert.equal(clickProvenance(g, { home: ruling.home }), 'owner');
  for (const kind of ['extra-round', 'past-round']) assert.equal(clickProvenance({ ...g, kind }, { home: ruling.home }), 'synthetic', `a ruling click relabelled ${kind}`);
  const { kind: _k2, ...rulingNoKind } = g;
  assert.equal(clickProvenance(rulingNoKind, { home: ruling.home }), 'synthetic', 'a ruling click with its kind removed');
});
