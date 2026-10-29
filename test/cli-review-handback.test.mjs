// End-to-end: `triage validate --from-tag` and `arbiter apply` accept a subagent whose report arrives as a SubagentHandback
// call (plain text at the end of such a session is not delivered), and refuse one whose hand-back is not acknowledged.
// Kept apart from cli-review.test.mjs; the world/transcript plumbing below is a trimmed copy of that file's helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExit } from './helpers/assert-exit.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
const bFile = Array.from({ length: 8 }, (_, i) => `export const w${i + 1} = ${i + 1};`).join('\n') + '\n';
const finding = (over = {}) => ({
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true, ...over,
});
const standardFindings = () => ({
  summary: 'Reviewed.',
  blocking: [finding()],
  suggestions: [
    finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability' }),
    finding({ title: 'Extract constant', file: 'src/b.js', line: 5, category: 'design' }),
  ],
  worth_considering: [finding({ title: 'Consider caching', file: 'src/a.js', line: 20, category: 'performance', testable: false })],
});
const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
];

function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-review-hb-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = createFakeGh(GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: head, ...e.stdoutJson } } : e)));
  const w = {
    repo, base, head, scratch,
    cli(args, extraEnv = {}) {
      const env = {
        ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: join(scratch, 'codex-capture.jsonl'),
        PIPELINE_LOCK_DIR: join(scratch, 'locks'), ...extraEnv,
      };
      for (const k of ['PIPELINE_TEST_FORCE_ARBITER', 'PIPELINE_ARBITER_MODEL_OVERRIDE', 'PIPELINE_TEST_MODE', 'FAKE_CODEX_OUTPUT']) {
        if (!(k in extraEnv)) delete env[k];
      }
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    codex(round, findings) {
      const out = w.file(`findings-${round}.json`, findings);
      return w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', base, '--head', head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: out });
    },
    judge(n, decisions) {
      return w.cli(['triage', 'validate', '--round', String(n), '--file', w.file(`judge-${n}.json`, decisionsOf(decisions))]);
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    item: (id) => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === id),
  };
  return w;
}

// Hand-back transcript: prompt, thinking line, the SubagentHandback call, then the harness acknowledgment as the last line.
function handbackTranscript({ prompt, message, model, effort = 'high', ack = true }) {
  const asst = (extra) => ({
    type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', effort, perTurnEffort: effort,
    message: { model, id: 'msg_1', role: 'assistant', stop_reason: null, ...extra },
  });
  const lines = [
    { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: prompt }, uuid: 'u-1' },
    asst({ content: [{ type: 'thinking', thinking: 'weighing', signature: 'sig' }] }),
    { ...asst({ content: [{ type: 'tool_use', id: 'toolu_hb', name: 'SubagentHandback', input: { message } }] }), uuid: 'a-hb', wireToolInputs: { toolu_hb: { message } } },
  ];
  if (ack) {
    lines.push({
      type: 'user', toolEndsTurn: true, toolUseResult: { success: true, message: 'Report delivered to your caller.' }, sourceToolAssistantUUID: 'a-hb',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_hb', type: 'tool_result', content: [{ type: 'text', text: '{"success":true}' }] }] },
    });
  }
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
const fenced = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n\nThat is my full report; the reasoning above is in the JSON.`;

function installTranscript(w, { jsonl, meta, agentId = 'a1' }) {
  const root = join(w.scratch, `projects-${agentId}`);
  const dir = join(root, '-tmp-work', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), jsonl);
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, ...meta }));
  return root;
}

const JUDGE_TAG = 'pipeline-judge R1 abcd1234';
const decisionsOf = (decisions) => ({
  items: Object.entries(decisions).map(([id, [decision, confidence = 'high']]) => ({
    id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' },
  })),
});
const STANDARD_JUDGE = { 'R1-B1': ['ACCEPT'], 'R1-S1': ['REJECT', 'high'], 'R1-S2': ['REJECT', 'low'], 'R1-W1': ['FOLLOW-UP'] };
const SORT_RULINGS = {
  rulings: [
    { id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 already covers this.' },
    { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/b.js:5 really is duplicated.' },
  ],
};
const promptFor = (digest) => `ROUND: 1\nINPUT-DIGEST: ${digest}\nRead the input file and rule on every item.`;

const judgeMeta = { agentType: 'judge', description: JUDGE_TAG };

test('triage validate --from-tag: a judge that reports through SubagentHandback is proven and its decisions applied', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const projects = installTranscript(w, {
    jsonl: handbackTranscript({ prompt: 'Triage round 1.', message: fenced(decisionsOf(STANDARD_JUDGE)), model: 'claude-sonnet-5-5', effort: 'medium' }),
    meta: judgeMeta,
  });
  const r = w.cli(['triage', 'validate', '--round', '1', '--from-tag', JUDGE_TAG, '--projects-dir', projects]);
  assertExit(r, 0);
  assert.equal(r.json.judgeProof.ok, true, JSON.stringify(r.json.judgeProof));
  assert.equal(r.json.judgeProof.finalVia, 'handback');
  assert.equal(r.json.judgeProof.stopReasonMissing, true);
  assert.deepEqual(r.json.judgeProof.errors, []);
  assert.deepEqual(r.json.counts, { ACCEPT: 1, 'FOLLOW-UP': 1, REJECT: 2 });
  assert.equal(w.item('R1-B1').final.decision, 'ACCEPT');
});

test('triage validate --from-tag: a hand-back that was never acknowledged is a recorded proof failure', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const projects = installTranscript(w, {
    jsonl: handbackTranscript({ prompt: 'Triage round 1.', message: fenced(decisionsOf(STANDARD_JUDGE)), model: 'claude-sonnet-5-5', effort: 'medium', ack: false }),
    meta: judgeMeta,
  });
  const r = w.cli(['triage', 'validate', '--round', '1', '--from-tag', JUDGE_TAG, '--projects-dir', projects]);
  assert.equal(r.json.judgeProof.ok, false);
  assert.equal(r.json.judgeProof.finalVia, null);
  assert.ok(r.json.judgeProof.errors.includes('hand-back not acknowledged'), r.json.judgeProof.errors.join('|'));
});

test('arbiter apply: an arbiter that reports through SubagentHandback is proven and its rulings applied', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(needed, 0);
  const projects = installTranscript(w, {
    jsonl: handbackTranscript({ prompt: promptFor(needed.json.digest), message: fenced(SORT_RULINGS), model: 'claude-fable-5-1' }),
    meta: { agentType: 'arbiter', description: needed.json.tag },
  });
  const r = w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects]);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.errors, []);
  assert.equal(r.json.finalVia, 'handback');
  assert.deepEqual(r.json.items.map((i) => [i.id, i.ruling, i.needsHuman]), [['R1-S1', 'REJECT', false], ['R1-S2', 'ACCEPT', false]]);
  assert.equal(w.item('R1-S2').final.by, 'arbiter');
  const proof = JSON.parse(readFileSync(join(w.repo.dir, '.review', 'round-1', 'model-proof.json'), 'utf8'));
  assert.equal(proof.ok, true);
  assert.equal(proof.finalVia, 'handback');
});

test('arbiter apply: an unacknowledged hand-back is exit 1 and every arbitrated item goes to a human', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  const projects = installTranscript(w, {
    jsonl: handbackTranscript({ prompt: promptFor(needed.json.digest), message: fenced(SORT_RULINGS), model: 'claude-fable-5-1', ack: false }),
    meta: { agentType: 'arbiter', description: needed.json.tag },
  });
  const r = w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects]);
  assertExit(r, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.includes('hand-back not acknowledged'), r.json.errors.join('|'));
  assert.equal(w.item('R1-S1').final.needsHuman, true);
});

test('model-proof: reports finalVia handback with the delivered message', (t) => {
  const w = world(t);
  const projects = installTranscript(w, {
    jsonl: handbackTranscript({ prompt: 'p', message: fenced(SORT_RULINGS), model: 'claude-fable-5-1' }),
    meta: { agentType: 'arbiter', description: 'tag-x' },
  });
  const r = w.cli(['model-proof', '--tag', 'tag-x', '--projects-dir', projects]);
  assertExit(r, 0);
  assert.equal(r.json.ok, true, JSON.stringify(r.json.errors));
  assert.equal(r.json.finalVia, 'handback');
  assert.equal(r.json.finalAssistantText, fenced(SORT_RULINGS));
});
