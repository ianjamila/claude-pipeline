// `P codex-review` derives reviewer obligations, `P review header` prints the prompt header and `P review add` proves a
// reviewer's transcript before its findings count (ship redesign T7). Real CLI, real git repo, scripted fake gh + codex.
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
import { roundOutcome } from '../pipeline/lib/triage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

const finding = (over = {}) => ({
  title: 'Table without RLS', file: 'supabase/migrations/1.sql', line: 1, category: 'security',
  detail: 'the new table has no row level security', reasoning: 'anon can read every row', testable: true, ...over,
});
const findingsOf = (blocking = []) => ({ summary: 'Reviewed.', blocking, suggestions: [], worth_considering: [] });
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const SQL = (extra = '') => `create table t (id int);\n${extra}`;

function world(t, { yml = pipelineYml() } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  repo.write('src/a.js', 'export const a = 1;\n');
  repo.write('docs/a.md', 'one\n');
  repo.write('.gitignore', '.review/\n'); // as in a real checkout: the review state never lands in a commit
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('supabase/migrations/1.sql', SQL());
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-review-add-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const withPr = (sha) => [
    { match: '^pr view 7', stdoutJson: { title: 'T', body: 'B', headRefName: 'feat/x', baseRefName: 'main', headRefOid: sha } },
    { match: '^repo view', stdoutJson: REPO_VIEW },
  ];
  const fake = createFakeGh(withPr(head));
  const w = {
    repo, base, head, scratch, fake,
    prHead: (sha) => fake.setScript(withPr(sha)),
    cli(args, env = {}) {
      const merged = { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: join(scratch, 'locks'), ...env };
      for (const k of ['FAKE_CODEX_OUTPUT', 'PIPELINE_TEST_MODE']) if (!(k in env)) delete merged[k];
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
    codex(round, findings, from, to) {
      return w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file(`f-${round}.json`, findings) });
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    // The prompt header for `source` over the round's recorded range, taken from the real `review header` command.
    header(round, source) {
      const r = w.state().rounds.find((x) => x.n === round);
      const h = w.cli(['review', 'header', '--pr', '7', '--round', String(round), '--source', source, '--base', r.reviewBase, '--head', r.toHead]);
      assertExit(h, 0, h.stderr + h.stdout);
      return h.json;
    },
    // <projects>/<encoded-cwd>/<session>/subagents/agent-<id>.{jsonl,meta.json}: the layout Claude Code writes.
    transcript({ prompt, text, model = 'claude-sonnet-5-1', effort, agentType = 'security-reviewer', tag = 'sec R1' }) {
      const root = join(scratch, `projects-${Math.random().toString(36).slice(2, 8)}`);
      const dir = join(root, '-tmp-work', 'session-1', 'subagents');
      mkdirSync(dir, { recursive: true });
      const line = (o) => JSON.stringify(o);
      const asst = {
        type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', ...(effort ? { effort, perTurnEffort: effort } : {}),
        message: { model, id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }, uuid: 'a-1', timestamp: '2026-10-01T09:00:06.000Z',
      };
      writeFileSync(join(dir, 'agent-a1.jsonl'), `${line({ type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: prompt }, uuid: 'u-1', timestamp: '2026-10-01T09:00:00.000Z' })}\n${line(asst)}\n`);
      writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType, description: tag, toolUseId: 'toolu_01', spawnDepth: 1 }));
      return root;
    },
    add(round, source, projects, tag = 'sec R1') {
      return w.cli(['review', 'add', '--round', String(round), '--source', source, '--tag', tag, '--projects-dir', projects]);
    },
  };
  return w;
}

// Round 1 recorded with a pending security obligation, and the header a reviewer would be given.
function readyForSecurity(t, opts) {
  const w = world(t, opts);
  const r = w.codex(1, findingsOf(), w.base, w.head);
  assertExit(r, 0, r.stderr + r.stdout);
  return w;
}
const sonnet = (w, over = {}) => {
  const h = w.header(1, 'security');
  return w.transcript({ prompt: `${h.promptHeader}\nReview the diff.`, text: fenced(findingsOf()), ...over });
};

test('codex-review: a PR touching a migration records a pending security obligation and prints its prompt header', (t) => {
  const w = world(t);
  const r = w.codex(1, findingsOf(), w.base, w.head);
  assertExit(r, 0, r.stderr + r.stdout);
  const ob = w.state().rounds[0].obligations;
  assert.deepEqual(ob.map((o) => [o.source, o.status]), [['security', 'pending']]);
  assert.match(ob[0].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.json.obligations, [{ source: 'security', promptHeader: `ROUND: 1\nINPUT-DIGEST: ${ob[0].digest}` }]);
  assert.equal(w.header(1, 'security').promptHeader, r.json.obligations[0].promptHeader, '`review header` agrees with what codex-review printed');
});

test('codex-review: a docs-only PR owes no reviewer', (t) => {
  const w = world(t);
  w.repo.git(['reset', '-q', '--hard', w.base]);
  w.repo.write('docs/a.md', 'two\n');
  const head = w.repo.commit('docs');
  const r = w.codex(1, findingsOf(), w.base, head);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.obligations, []);
  assert.equal('obligations' in w.state().rounds[0], false);
});

test('review add: a proven Sonnet transcript with the right header and no findings meets the obligation; the review is then valid', (t) => {
  const w = readyForSecurity(t);
  const r = w.add(1, 'security', sonnet(w));
  assertExit(r, 0, JSON.stringify(r.json));
  assert.deepEqual([r.json.ok, r.json.added], [true, []]);
  const ob = w.state().rounds[0].obligations[0];
  assert.deepEqual([ob.status, ob.tag], ['met', 'sec R1']);
  assert.equal(roundOutcome(w.state()).unmetObligations.length, 0);
});

test('review add: one blocking finding becomes item R1-XB1 (BLOCKING) in the round, before the judge', (t) => {
  const w = readyForSecurity(t);
  const r = w.add(1, 'security', sonnet(w, { text: fenced(findingsOf([finding()])) }));
  assertExit(r, 0, JSON.stringify(r.json));
  assert.deepEqual(r.json.added, ['R1-XB1']);
  const item = w.state().rounds[0].items.find((i) => i.id === 'R1-XB1');
  assert.deepEqual([item.bucket, item.file, item.source, item.final], ['BLOCKING', 'supabase/migrations/1.sql', 'security', undefined]);
  assert.match(item.fingerprint, /\S/);
});

test('review add: an Opus transcript fails the obligation and puts it in needsHuman', (t) => {
  const w = readyForSecurity(t);
  const r = w.add(1, 'security', sonnet(w, { model: 'claude-opus-5-1' }));
  assertExit(r, 1, JSON.stringify(r.json));
  assert.match(r.json.errors.join('; '), /unexpected model claude-opus-5-1/);
  const ob = w.state().rounds[0].obligations[0];
  assert.equal(ob.status, 'failed');
  assert.match(ob.reason, /unexpected model/);
  const o = roundOutcome({ ...w.state(), currentContentHash: 'x' });
  assert.deepEqual(o.needsHuman, ['R1:security-proof']);
  assert.equal(o.clean, false);
});

test('review add: a Sonnet transcript that carries an effort is refused (the reviewer pins none)', (t) => {
  const w = readyForSecurity(t);
  const r = w.add(1, 'security', sonnet(w, { effort: 'high' }));
  assertExit(r, 1, JSON.stringify(r.json));
  assert.match(r.json.errors.join('; '), /unexpected effort high/);
});

test('review add: a header with another head\'s digest, a wrong agent type or a missing round line fails the obligation', (t) => {
  for (const [label, over, pattern] of [
    ['digest of another head', (h) => ({ prompt: h.promptHeader.replace(/[0-9a-f]$/, (c) => (c === '0' ? '1' : '0')) }), /INPUT-DIGEST/],
    ['other agent type', () => ({ agentType: 'implementer' }), /unexpected agent type implementer/],
    ['no round line', (h) => ({ prompt: h.promptHeader.replace('ROUND: 1', 'ROUND: 2') }), /ROUND: 1/],
  ]) {
    const w = readyForSecurity(t);
    const h = w.header(1, 'security');
    const extra = over(h);
    const r = w.add(1, 'security', w.transcript({ prompt: `${h.promptHeader}\nx`, text: fenced(findingsOf()), ...extra }));
    assertExit(r, 1, `${label}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.errors.join('; '), pattern, label);
    assert.equal(w.state().rounds[0].obligations[0].status, 'failed', label);
  }
});

test('review add: an unparsable or schema-invalid answer fails the obligation', (t) => {
  const w = readyForSecurity(t);
  const r = w.add(1, 'security', sonnet(w, { text: 'looks fine to me' }));
  assertExit(r, 1, JSON.stringify(r.json));
  assert.match(r.json.errors.join('; '), /no JSON found/);
  const bad = w.add(1, 'security', sonnet(w, { text: fenced({ summary: 'x' }) }));
  assertExit(bad, 1, JSON.stringify(bad.json));
  assert.match(bad.json.errors.join('; '), /findings:/);
});

test('review add: a met obligation is already-met (exit 1); after a failure add is allowed once more; a source not owed is no-obligation', (t) => {
  const w = readyForSecurity(t);
  assertExit(w.add(1, 'security', sonnet(w, { model: 'claude-opus-5-1' })), 1);
  const again = w.add(1, 'security', sonnet(w));
  assertExit(again, 0, JSON.stringify(again.json));
  assert.equal(w.state().rounds[0].obligations[0].status, 'met');
  assert.equal('reason' in w.state().rounds[0].obligations[0], false, 'a met obligation carries no failure reason');
  const third = w.add(1, 'security', sonnet(w));
  assertExit(third, 1);
  assert.equal(third.json.error, 'already-met');
  const other = w.add(1, 'fable', sonnet(w));
  assertExit(other, 1);
  assert.equal(other.json.error, 'no-obligation');
  const none = w.cli(['review', 'add', '--round', '1', '--source', 'security', '--tag', 'nothing', '--projects-dir', join(w.scratch, 'empty-projects')]);
  assertExit(none, 1); // already met is decided before any transcript is looked for
  assert.equal(none.json.error, 'already-met');
});

test('review add: no transcript for the tag is exit 2 and leaves the obligation pending', (t) => {
  const w = readyForSecurity(t);
  const r = w.cli(['review', 'add', '--round', '1', '--source', 'security', '--tag', 'nothing', '--projects-dir', join(w.scratch, 'empty-projects')]);
  assertExit(r, 2, JSON.stringify(r.json));
  assert.equal(r.json.error, 'not-found');
  assert.equal(w.state().rounds[0].obligations[0].status, 'pending');
});

test('review-complete: whyNot names the unmet obligation of a round with zero items', (t) => {
  const w = readyForSecurity(t);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, JSON.stringify(r.json));
  assert.match(r.json.reason, /reviewer obligations not met: R1:security/);
});

test('final pass: final_pass risky on a high-risk PR with no BLOCKING owes a Fable review, proven at effort high', (t) => {
  const yml = `${pipelineYml()}review:\n  final_pass: risky\nrisk:\n  high_risk_paths: ['supabase/**']\n`;
  const w = world(t, { yml });
  const r = w.codex(1, findingsOf(), w.base, w.head);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(w.state().rounds[0].obligations.map((o) => o.source), ['security', 'fable']);
  const h = w.header(1, 'fable');
  const bad = w.add(1, 'fable', w.transcript({ prompt: h.promptHeader, text: fenced(findingsOf()), model: 'claude-fable-5-1', agentType: 'fable-reviewer', tag: 'fable R1' }), 'fable R1');
  assertExit(bad, 1, JSON.stringify(bad.json));
  assert.match(bad.json.errors.join('; '), /unexpected effort undefined/, 'Fable must be proven at effort high');
  const good = w.add(1, 'fable', w.transcript({ prompt: h.promptHeader, text: fenced(findingsOf([finding({ title: 'Attack' })])), model: 'claude-fable-5-1', effort: 'high', agentType: 'fable-reviewer', tag: 'fable R1' }), 'fable R1');
  assertExit(good, 0, JSON.stringify(good.json));
  assert.deepEqual(good.json.added, ['R1-FB1']);
  assert.deepEqual(w.state().rounds[0].obligations.map((o) => o.status), ['pending', 'met']);
});

test('final pass: a BLOCKING Codex finding means no Fable obligation yet; final_pass off (default) never owes one', (t) => {
  const w = world(t, { yml: `${pipelineYml()}review:\n  final_pass: risky\nrisk:\n  high_risk_paths: ['supabase/**']\n` });
  assertExit(w.codex(1, findingsOf([finding()]), w.base, w.head), 0);
  assert.deepEqual(w.state().rounds[0].obligations.map((o) => o.source), ['security']);
  const off = world(t);
  assertExit(off.codex(1, findingsOf(), off.base, off.head), 0);
  assert.deepEqual(off.state().rounds[0].obligations.map((o) => o.source), ['security']);
});

test('round 2: changing the SQL owes a new security review with the real owner/repo in its digest; a docs-only round owes none', (t) => {
  const w = readyForSecurity(t);
  assertExit(w.add(1, 'security', sonnet(w)), 0);
  // Round 2a: the SQL changes again.
  w.repo.write('supabase/migrations/1.sql', SQL('alter table t enable row level security;\n'));
  const head2 = w.repo.commit('rls');
  w.prHead(head2);
  const r2 = w.codex(2, findingsOf(), w.head, head2);
  assertExit(r2, 0, r2.stderr + r2.stdout);
  const ob = w.state().rounds[1].obligations;
  assert.deepEqual(ob.map((o) => [o.source, o.status]), [['security', 'pending']]);
  const h = w.header(2, 'security');
  assert.equal(h.promptHeader, r2.json.obligations[0].promptHeader);
  const expected = createHashFor({ repo: 'acme/widgets', pr: 7, source: 'security', base: w.state().rounds[1].reviewBase, head: head2 });
  assert.equal(ob[0].digest, expected, 'the digest names acme/widgets, never undefined');
  const met = w.add(2, 'security', w.transcript({ prompt: `${h.promptHeader}\nGo.`, text: fenced(findingsOf()), tag: 'sec R2' }), 'sec R2');
  assertExit(met, 0, JSON.stringify(met.json));
  assert.equal(w.state().rounds[1].obligations[0].status, 'met');
  // Round 3: only docs change.
  w.repo.write('docs/a.md', 'three\n');
  const head3 = w.repo.commit('docs');
  w.prHead(head3);
  const r3 = w.codex(3, findingsOf(), head2, head3);
  assertExit(r3, 0, r3.stderr + r3.stdout);
  assert.deepEqual(r3.json.obligations, []);
  assert.equal('obligations' in w.state().rounds[2], false);
});

import { createHash } from 'node:crypto';
function createHashFor({ repo, pr, source, base, head }) {
  return createHash('sha256').update([repo, pr, source, base, head].join('\n')).digest('hex');
}
