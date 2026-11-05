// End-to-end tests for `pipeline triage claude-ruling` and for what the rest of the review loop does with a Claude ruling (plan
// 2026-11-05-claude-rulings.md section 10 + E1-E11): settle, arbiter apply and the cache leave Claude's and forced finals alone, the owner's typed
// ruling can still override an unimplemented one, a retry of the arbiter clears malfunctions in dispute rounds, a newer state version is refused.
// The setup follows test/cli-review.test.mjs: the real CLI against a throwaway git repo, a scripted fake gh and a scripted fake codex.
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { ownerRules, rulingRequest } from './helpers/owner-go.mjs';
import { applyClaudeRuling, settleSecondReview } from '../pipeline/lib/triage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');
const CHAT_YML = `${pipelineYml()}owner_approval: chat\n`;

// ---- fixtures -------------------------------------------------------------------------------

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
const bFile = Array.from({ length: 8 }, (_, i) => `export const w${i + 1} = ${i + 1};`).join('\n') + '\n';
const finding = (over = {}) => ({
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true, ...over,
});
const sugg = (over = {}) => finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability', testable: false, ...over });
const findingsOf = (blocking = [], suggestions = [], worth = []) => ({ summary: 'Reviewed.', blocking, suggestions, worth_considering: worth });
const DISPUTED = { disputedBug: true, settleTest: { possible: true, plan: 'write a failing test' } };

function world(t, { yml = CHAT_YML, slug = 'acme/widgets' } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-claude-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = createFakeGh([
    { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'main', headRefOid: head } },
    { match: '^repo view', stdoutJson: { ...REPO_VIEW, nameWithOwner: slug, url: `https://github.com/${slug}` } },
  ]);
  const lockDir = join(scratch, 'locks');
  const w = {
    repo, base, head, scratch, slug,
    cli(args, env = {}) {
      const merged = { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: lockDir, ...env };
      for (const k of ['PIPELINE_TEST_FORCE_ARBITER', 'PIPELINE_TEST_MODE', 'FAKE_CODEX_OUTPUT']) if (!(k in env)) delete merged[k];
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json says so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    codex(round, findings, { from = base, to = head } = {}) {
      return w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file(`findings-${round}.json`, findings) });
    },
    judge(n, decisions) {
      const items = Object.entries(decisions).map(([id, [decision, confidence = 'high', extra = {}]]) => ({
        id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' }, ...extra,
      }));
      return w.cli(['triage', 'validate', '--round', String(n), '--file', w.file(`judge-${n}.json`, { items })]);
    },
    stateText: () => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8'),
    state: () => JSON.parse(w.stateText()),
    item: (id) => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === id),
    edit(fn) {
      const s = w.state();
      fn(s);
      writeFileSync(join(repo.dir, '.review', 'state.json'), JSON.stringify(s, null, 2));
    },
    // Put an item in the state as waiting for a human for `cause` (what an arbiter or a test leaves behind), with any other fields.
    wait(id, cause = 'low-confidence', over = {}) {
      w.edit((s) => {
        const it = s.rounds.flatMap((r) => r.items).find((i) => i.id === id);
        it.final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: cause === 'model-proof' ? 'model-proof failed: ruling not provably from Fable' : 'arbiter low confidence', ...(cause ? { cause } : {}) };
        Object.assign(it, over);
      });
    },
  };
  return w;
}

const verdict = (decision, confidence = 'high') => ({
  decision, confidence, reasoning: `codex ${decision}`, model: 'gpt-x', effort: 'high', inputDigest: 'a'.repeat(64), ranAt: '2026-11-05T10:00:00.000Z',
});
const ruling = (id, decision, { reason = 'because', pr = '7', round = '1', extra = [] } = {}) =>
  ['triage', 'claude-ruling', '--round', round, '--id', id, '--decision', decision, '--reason', reason, '--pr', pr, ...extra];

// ---- the command ------------------------------------------------------------------------------

test('claude-ruling: records Claude\'s final, keeps what it overruled and the cause, writes state version 2, and says it is not published', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()], [sugg()])), 0);
  assert.equal(w.state().version, 1, 'an ordinary review state stays at version 1');
  w.wait('R1-B1');
  w.wait('R1-S1');
  const before = w.item('R1-B1').final;

  const r = w.cli(ruling('R1-B1', 'ACCEPT', { reason: 'real bug' }));
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['final', 'id', 'next', 'ok', 'published', 'round']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.published, false);
  assert.match(r.json.next, /pipeline comment --pr 7 --kind triage/);
  const { final } = w.item('R1-B1');
  assert.deepEqual(r.json.final, final);
  assert.equal(final.decision, 'ACCEPT');
  assert.equal(final.by, 'claude');
  assert.equal(final.needsHuman, false);
  assert.equal(final.reason, 'real bug');
  assert.deepEqual({ ...final.claude, ruledAt: undefined }, { ruledAt: undefined, cause: 'low-confidence', critical: false, overruled: before });
  assert.ok(!Number.isNaN(Date.parse(final.claude.ruledAt)));
  assert.equal(w.state().version, 2);

  const f = w.cli(ruling('R1-S1', 'FOLLOW-UP', { reason: 'later' }));
  assertExit(f, 0, f.stderr + f.stdout);
  const outcome = w.cli(['state', 'outcome']).json;
  assert.deepEqual(outcome.needsHuman, [], 'nothing waits for a human any more');
  assert.deepEqual(outcome.unimplemented, ['R1-B1'], 'ACCEPT still needs the fix and a round that reviews it');
});

test('claude-ruling: the refusals leave the state byte-identical', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding(), finding({ title: 'Second', line: 14 }), finding({ title: 'Third', line: 16 })], [sugg(), sugg({ title: 'Other', line: 4 }), sugg({ title: 'Third s', line: 5 })])), 0);
  w.wait('R1-B1');
  w.wait('R1-B2', 'model-proof');
  w.wait('R1-B3', 'low-confidence', { secondReview: verdict('ACCEPT') });
  w.wait('R1-S1');
  w.wait('R1-S2', 'low-confidence', { implemented: true });
  w.wait('R1-S3', 'low-confidence', { category: 'security' });
  w.edit((s) => {
    s.rounds[0].items.push({ ...s.rounds[0].items[3], id: 'R1-S4', final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'ok' } });
  });
  const before = w.stateText();
  const refused = (args, re, code = 1) => {
    const r = w.cli(args);
    assertExit(r, code, r.stdout);
    if (code === 1) {
      assert.equal(r.json.ok, false);
      assert.match(r.json.reason, re);
    }
    assert.equal(w.stateText(), before, `state untouched by ${args.join(' ')}`);
  };
  refused(ruling('R1-B1', 'REJECT'), /second review/, 1);
  refused(ruling('R1-B1', 'FOLLOW-UP'), /second review/, 1);
  refused(ruling('R1-S1', 'REJECT'), /second review/, 1);
  refused(ruling('R1-S3', 'FOLLOW-UP'), /second review/, 1);
  refused(ruling('R1-B2', 'FOLLOW-UP'), /re-run the judge\/arbiter/, 1);
  refused(ruling('R1-B3', 'REJECT'), /second review says ACCEPT/, 1);
  refused(ruling('R1-S2', 'ACCEPT'), /implemented/, 1);
  refused(ruling('R1-S4', 'ACCEPT'), /not waiting for a human/, 1);
  refused(ruling('R1-X9', 'ACCEPT'), /no item R1-X9 in round 1/, 1);
  refused(ruling('R1-S1', 'FOLLOW-UP', { pr: '99' }), /review state is for PR #7, not #99/, 1);
  refused(ruling('R1-S1', 'FOLLOW-UP', { reason: '   ' }), /must not be empty/, 1);
  refused(ruling('R1-S1', 'FOLLOW-UP', { reason: 'x'.repeat(1001) }), /at most 1000/, 1);
  refused(ruling('R1-S1', 'MAYBE'), null, 2);
  refused(['triage', 'claude-ruling', '--round', '1', '--id', 'R1-S1', '--decision', 'ACCEPT', '--pr', '7'], null, 2);
  refused(ruling('R1-S1', 'ACCEPT', { round: '9' }), null, 2);
  refused(['triage', 'claude-ruling', '--round', '1', '--id', 'R1-S1', '--decision', 'ACCEPT', '--reason', 'r'], null, 2);

  // a critical dismissal with a verdict that is not a high-confidence dismissal
  w.edit((s) => { s.rounds[0].items.find((i) => i.id === 'R1-B1').secondReview = verdict('REJECT', 'medium'); });
  const medium = w.stateText();
  const r = w.cli(ruling('R1-B1', 'REJECT'));
  assertExit(r, 1);
  assert.match(r.json.reason, /high/);
  assert.equal(w.stateText(), medium);
});

test('claude-ruling: refused in label mode', (t) => {
  const w = world(t, { yml: pipelineYml() });
  assertExit(w.codex(1, findingsOf([], [sugg()])), 0);
  w.wait('R1-S1');
  const before = w.stateText();
  const r = w.cli(ruling('R1-S1', 'FOLLOW-UP'));
  assertExit(r, 1);
  assert.match(r.json.reason, /owner_approval: chat/);
  assert.equal(w.stateText(), before);
});

test('claude-ruling: a critical dismissal needs a high-confidence Codex dismissal already on the item, and the result is the stricter of the two', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding(), finding({ title: 'Second', line: 14 }), finding({ title: 'Third', line: 16 })])), 0);
  w.wait('R1-B1', 'low-confidence', { secondReview: verdict('FOLLOW-UP') });
  w.wait('R1-B2', 'low-confidence', { secondReview: verdict('REJECT') });
  w.wait('R1-B3', 'low-confidence', { secondReview: verdict('REJECT') });
  const a = w.cli(ruling('R1-B1', 'REJECT'));
  assertExit(a, 0, a.stdout);
  assert.equal(a.json.final.decision, 'FOLLOW-UP', 'Claude REJECT + Codex FOLLOW-UP = FOLLOW-UP');
  assert.equal(a.json.final.claude.critical, true);
  const b = w.cli(ruling('R1-B2', 'FOLLOW-UP'));
  assertExit(b, 0, b.stdout);
  assert.equal(b.json.final.decision, 'FOLLOW-UP', 'Claude FOLLOW-UP + Codex REJECT = FOLLOW-UP');
  const c = w.cli(ruling('R1-B3', 'REJECT'));
  assertExit(c, 0, c.stdout);
  assert.equal(c.json.final.decision, 'REJECT', 'both REJECT');
  // a Claude dismissal may tighten to ACCEPT, and an ACCEPT is never loosened again
  const up = w.cli(ruling('R1-B3', 'ACCEPT', { reason: 'on reflection it is real' }));
  assertExit(up, 0, up.stdout);
  assert.equal(w.item('R1-B3').final.claude.overruled.by, 'claude');
  assert.equal(w.item('R1-B3').final.claude.cause, 'low-confidence');
  const down = w.cli(ruling('R1-B3', 'REJECT'));
  assertExit(down, 1);
  assert.match(down.json.reason, /cannot loosen/);
});

// ---- writers leave Claude's and forced finals alone -------------------------------------------

const asClaude = (item, decision, extra = {}) => applyClaudeRuling({ ...item, final: { ...item.final, needsHuman: true, cause: 'low-confidence' }, ...extra }, { decision, reason: 'ruled by claude', ruledAt: '2026-11-05T11:00:00.000Z' });

test('triage settle refuses a Claude ruling and a forced final', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding(), finding({ title: 'Second', line: 14 })])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT', 'high', DISPUTED], 'R1-B2': ['REJECT', 'high', DISPUTED] }), 0);
  w.edit((s) => {
    const [b1, b2] = s.rounds[0].items;
    b1.final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence', cause: 'low-confidence' };
    b2.final = b1.final;
    s.rounds[0].items[0] = asClaude(b1, 'ACCEPT');
    s.rounds[0].items[1] = settleSecondReview({ ...b2 }, verdict('ACCEPT'));
  });
  const before = w.stateText();
  for (const id of ['R1-B1', 'R1-B2']) {
    const r = w.cli(['triage', 'settle', '--id', id, '--result', 'bug-disproved', '--test-cmd', 'node src/proof.test.js', '--test-file', 'src/proof.test.js']);
    assertExit(r, 1, r.stdout + r.stderr);
    assert.match(r.json.reason, /ruled by Claude/);
  }
  assert.equal(w.stateText(), before);
});

// The arbiter side needs a transcript the CLI can prove came from Fable: the layout Claude Code writes.
function transcript({ prompt, text }) {
  const lines = [
    { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: prompt }, uuid: 'u-1', timestamp: '2026-10-01T09:00:00.000Z' },
    {
      type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', effort: 'high', perTurnEffort: 'high',
      message: { model: 'claude-fable-5-1', id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
      uuid: 'a-1', timestamp: '2026-10-01T09:00:06.000Z',
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
function installTranscript(w, { jsonl, meta, agentId = 'a1' }) {
  const root = join(w.scratch, `projects-${agentId}-${Math.random().toString(36).slice(2, 8)}`);
  const dir = join(root, '-tmp-work', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), jsonl);
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, ...meta }));
  return root;
}
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const ARBITER_RULINGS = {
  rulings: [
    { id: 'R1-S1', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/b.js:3 really is a problem.' },
    { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/b.js:5 really is duplicated.' },
  ],
};
function arbiterApply(w, { proven = true } = {}) {
  const needed = w.state().rounds[0].arbiter;
  const jsonl = transcript({ prompt: `ROUND: 1\nINPUT-DIGEST: ${needed.inputDigest}\nRule on every item.`, text: fenced(ARBITER_RULINGS) });
  const projects = installTranscript(w, { jsonl, meta: { agentType: 'arbiter', description: needed.tag } });
  // an unproven run: the pinned model is Fable; ask for another one, honoured only in test mode, so the proof fails
  return w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects, ...(proven ? [] : ['--expect-model', 'claude-opus-9-'])], proven ? {} : { PIPELINE_TEST_MODE: '1' });
}
const DISPUTE_JUDGE = { 'R1-S1': ['REJECT', 'high'], 'R1-S2': ['REJECT', 'low'] };

test('arbiter apply does not overwrite a Claude ruling made after `arbiter needed` (and rules the other item as usual)', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([], [sugg(), sugg({ title: 'Extract constant', line: 5 })])), 0);
  assertExit(w.judge(1, DISPUTE_JUDGE), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  let claudeFinal;
  w.edit((s) => {
    const it = s.rounds[0].items[0];
    it.final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence', cause: 'low-confidence' };
    s.rounds[0].items[0] = asClaude(it, 'FOLLOW-UP');
    claudeFinal = s.rounds[0].items[0].final;
    s.version = 2;
  });
  const r = arbiterApply(w);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual(w.item('R1-S1').final, claudeFinal, 'the arbiter\'s ACCEPT did not replace Claude\'s FOLLOW-UP');
  assert.equal(w.item('R1-S2').final.by, 'arbiter');
  assert.equal(w.item('R1-S2').final.decision, 'ACCEPT');
});

test('codex-review cache: a Claude dismissal of a BLOCKING item is never reused; a non-critical one is, and its Claude ruling stays visible', (t) => {
  const w = world(t);
  const findings = findingsOf([finding()], [sugg()]);
  assertExit(w.codex(1, findings), 0);
  w.wait('R1-B1', 'low-confidence', { secondReview: verdict('REJECT') });
  w.wait('R1-S1');
  assertExit(w.cli(ruling('R1-B1', 'REJECT', { reason: 'not reachable' })), 0);
  assertExit(w.cli(ruling('R1-S1', 'FOLLOW-UP', { reason: 'tracked' })), 0);

  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const r = w.codex(2, findings, { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.preRuled, 1);
  assert.equal(w.item('R2-B1').final ?? null, null, 'the critical dismissal is looked at again');
  const cached = w.item('R2-S1').final;
  assert.equal(cached.by, 'cache');
  assert.equal(cached.decision, 'FOLLOW-UP');
  assert.equal(cached.claude.cause, 'low-confidence', 'the Claude ruling stays visible on the cached copy');
  // and the cached copy is as protected as the original: a test cannot settle it
  const s = w.cli(['triage', 'settle', '--id', 'R2-S1', '--result', 'bug-disproved', '--test-cmd', 'node src/p.test.js', '--test-file', 'src/p.test.js']);
  assertExit(s, 1);
  assert.match(s.json.reason, /ruled by Claude/);
});

// ---- the owner's typed ruling still overrides -------------------------------------------------

test('owner-ruling: overrides an unimplemented Claude ruling or forced final, refuses an implemented one (CLI layer)', (t) => {
  const w = world(t, { slug: `acme/widgets-${randomUUID()}` });
  assertExit(w.codex(1, findingsOf([finding()], [sugg(), sugg({ title: 'Extract constant', line: 5 })])), 0);
  w.wait('R1-B1');
  w.wait('R1-S1');
  w.wait('R1-S2');
  assertExit(w.cli(ruling('R1-B1', 'ACCEPT')), 0);
  assertExit(w.cli(ruling('R1-S2', 'ACCEPT')), 0);
  w.edit((s) => {
    s.rounds[0].items[1] = settleSecondReview(s.rounds[0].items[1], verdict('ACCEPT'));
    s.rounds[0].items[2].implemented = true;
  });
  const askedContent = (ids) => / · content ([0-9a-f]{12}) · /.exec(w.cli(['triage', 'ruling-request', '--pr', '7', '--ids', ids.join(',')]).json.line)[1];
  const typed = (id, decision, quote) => {
    ownerRules(t, quote, rulingRequest(7, [id], w.slug, askedContent([id])));
    return w.cli(['triage', 'owner-ruling', '--round', '1', '--id', id, '--decision', decision, '--reason', 'owner confirmed', '--owner-quote', quote, '--pr', '7']);
  };

  const claudeOne = w.item('R1-B1').final;
  const r = typed('R1-B1', 'REJECT', 'R1-B1: reject');
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(w.item('R1-B1').final.by, 'owner');
  assert.equal(w.item('R1-B1').final.decision, 'REJECT');
  assert.deepEqual(w.item('R1-B1').final.overruled, claudeOne, 'the Claude final it loosened is kept');

  const f = typed('R1-S1', 'FOLLOW-UP', 'R1-S1: follow-up');
  assertExit(f, 0, f.stdout + f.stderr);
  assert.equal(w.item('R1-S1').final.overruled.forcedBy, 'second-review');

  const before = w.stateText();
  const done = typed('R1-S2', 'REJECT', 'R1-S2: reject');
  assertExit(done, 1);
  assert.match(done.json.reason, /already implemented/);
  assert.equal(w.stateText(), before);
});

// ---- retry of the arbiter in a dispute round --------------------------------------------------

test('arbiter needed in a dispute round clears a model-proof malfunction (stored or legacy), keeps a Claude ruling, and asks again for the rest', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([], [sugg(), sugg({ title: 'Extract constant', line: 5 })])), 0);
  assertExit(w.judge(1, DISPUTE_JUDGE), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  const failed = arbiterApply(w, { proven: false });
  assertExit(failed, 1, failed.stdout + failed.stderr);
  for (const id of ['R1-S1', 'R1-S2']) {
    assert.equal(w.item(id).final.cause, 'model-proof');
    assert.equal(w.item(id).final.needsHuman, true);
  }
  // ACCEPT is allowed through a malfunction; dismissing is not
  assertExit(w.cli(ruling('R1-S1', 'ACCEPT')), 0);
  const dismiss = w.cli(ruling('R1-S2', 'FOLLOW-UP'));
  assertExit(dismiss, 1);
  assert.match(dismiss.json.reason, /re-run the judge\/arbiter/);
  // the same state as an older pipeline wrote it: no cause field
  w.edit((s) => { delete s.rounds[0].items[1].final.cause; });

  const again = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(again, 0, again.stdout + again.stderr);
  assert.equal(again.json.needed, true);
  assert.deepEqual(again.json.items, ['R1-S2'], 'only the malfunction goes back to the arbiter');
  assert.equal(w.item('R1-S1').final.by, 'claude', 'Claude\'s ruling stays');
  assert.equal(w.item('R1-S2').final ?? null, null, 'cleared, pending the arbiter');
  assert.equal(w.item('R1-S2').arbiter ?? null, null);
});

test('arbiter needed in a dispute round: an item the arbiter no longer needs is settled by the judge again, and the result is saved', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT', 'high'] }), 0);
  w.edit((s) => { s.rounds[0].items[0].final = { decision: 'ACCEPT', by: 'arbiter', needsHuman: true, reason: 'invalid arbiter output', cause: 'invalid-arbiter' }; });
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, { needed: false, items: [], mode: 'dispute' });
  assert.deepEqual(w.item('R1-B1').final, { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'judge: ACCEPT R1-B1' }, 'not stranded pending');
});

test('arbiter needed in a dispute round leaves a judgement (low confidence) and an invalid-judge final alone', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([], [sugg(), sugg({ title: 'Extract constant', line: 5 })])), 0);
  assertExit(w.judge(1, DISPUTE_JUDGE), 0);
  w.edit((s) => {
    s.rounds[0].items[0].final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence', cause: 'low-confidence' };
    s.rounds[0].items[1].final = { decision: null, by: 'judge', needsHuman: true, reason: 'invalid judge output', cause: 'invalid-judge' };
  });
  const before = w.stateText();
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 0);
  assert.equal(r.json.needed, false);
  assert.equal(w.stateText(), before);
});

// ---- the state version ------------------------------------------------------------------------

test('a state of a newer format is refused by every command that reads it', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([], [sugg()])), 0);
  w.edit((s) => { s.version = 3; });
  const r = w.cli(['state', 'outcome']);
  assertExit(r, 2, r.stdout + r.stderr);
  assert.match(r.json.message, /version 3.*supports up to 2/);
  const c = w.cli(ruling('R1-S1', 'FOLLOW-UP'));
  assertExit(c, 2, c.stdout);
});
