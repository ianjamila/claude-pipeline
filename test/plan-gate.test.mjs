// The final gate's `plan-scope` check (ship redesign T6): end to end like ci-proof-gate (a real git repo, a scripted fake gh, the
// real evaluateGate), with the scenario yml opting in to `plan: true` (the helpers default to `plan.required: false`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_CHECKS, evaluateGate, gateRefusals, planScopeCheck } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { recordApproval } from '../pipeline/hooks/lib/owner-go.mjs';
import { parsePlan, scopeDigest } from '../pipeline/lib/plan.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { applyCheckpoint, emptyRecord, encodeRecord, renderStatusBlock } from '../pipeline/lib/run-record.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { createFakeCodex } from './helpers/fakegh-env.mjs';

const REL = 'docs/plans/p.md';
const BIND = { repo: 'acme/widgets', pr: PR, branch: 'agent/feature' };
const planText = (scope) => [
  '## In plain English', 'A small change.', '', '## Scope', ...[REL, ...scope].map((s) => `- \`${s}\``), '',
  '### Task T1: do it', 'Change the app.', '',
].join('\n');
const blobOf = (text) => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
const digestOf = (text) => scopeDigest(parsePlan(text).scope);

let seq = 1000;
const comment = (body, { id = seq++, edited = false } = {}) => ({
  id, user: { login: 'me' }, body, created_at: '2026-10-19T09:00:00Z', updated_at: edited ? '2026-10-19T09:30:00Z' : '2026-10-19T09:00:00Z', html_url: `https://x/${id}`,
});

// The owner types "approve" after the request lines of this plan; the real recorder writes the line into `home`.
function owner(home, text, { session = 'sess-1', at = Date.now() } = {}) {
  const reply = `Plan ${blobOf(text)} · scope ${digestOf(text)}\n📋 Ready to approve plan #${PR} — say "approve"`;
  const tf = join(home, `t-${session}.jsonl`);
  writeFileSync(tf, `${[{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }, { type: 'user', message: { content: 'approve' } }].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const rec = recordApproval({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: home, prompt: 'approve', transcript_path: tf }, { home, now: () => at });
  assert.ok(rec, 'the recorder wrote the owner record');
  return { recordId: rec.record_id, promptSha256: rec.prompt_sha256 };
}

const approvedEvent = (text, rec, over = {}, opts) => comment(renderEvent('plan-approved', `${blobOf(text).slice(0, 12)}-${rec.recordId.slice(0, 8)}`, `Plan approved: ${REL}`, {
  ...BIND, path: REL, blob: blobOf(text), scopeDigest: digestOf(text), recordId: rec.recordId, promptSha256: rec.promptSha256, at: '2026-10-19T09:00:00Z', host: 'mac', ...over,
}), opts);
const proposedEvent = (text) => comment(renderEvent('plan-proposed', `${blobOf(text).slice(0, 12)}-1`, `Plan proposed: ${REL}`, {
  ...BIND, path: REL, blob: blobOf(text), scopeDigest: digestOf(text), n: 1, at: '2026-10-19T08:00:00Z', host: 'mac',
}));

// A PR that changes src/app.js, the plan file and `extra`; `comments` / `chat` shape the evidence.
function setup({ text = planText(['src/**']), extra = [], comments = [], chat = false, required = true } = {}) {
  const yml = `${ymlFor({ plan: required })}${chat ? 'owner_approval: chat\n' : ''}`;
  return scenario({
    yml,
    change: (r) => {
      r.write('src/app.js', 'export const a = 2;\n');
      r.write(REL, text);
      for (const f of extra) r.write(f, 'x\n');
    },
    gh: { comments },
  });
}

async function gateFor(s, home) {
  const { config } = await loadConfig(s.repo.dir);
  const env = { ...process.env, ...s.fake.env, ...createFakeCodex().env, PIPELINE_NOTIFY: 'off', PIPELINE_MERGEABLE_PAUSE_MS: '1' };
  return evaluateGate({ root: s.repo.dir, config, pr: PR, gh: createGitHub({ cwd: s.repo.dir, env }), env, home });
}
const homeDir = () => mkdtempSync(join(tmpdir(), 'plan-gate-home-'));
const scopeCheck = (gate) => gate.checks.find((c) => c.name === 'plan-scope');

test('(a) no plan events, chat mode: plan-scope is ok with one owner-merge item, and the gate\'s ownerItems differ from a report-only run', async () => {
  const on = await gateFor(setup({ chat: true }), homeDir());
  assert.equal(on.ok, true, JSON.stringify(on.checks.filter((c) => !c.ok)));
  const c = scopeCheck(on);
  assert.deepEqual([c.ok, c.ownerMerge, c.ownerItems], [true, 1, ['plan-scope none']]);
  assert.equal(on.ownerMerge, 1);
  const off = await gateFor(setup({ chat: true, required: false }), homeDir());
  assert.equal(off.ok, true);
  assert.equal(scopeCheck(off).ownerMerge, undefined);
  assert.notEqual(on.ownerItems, off.ownerItems);
  assert.equal(off.ownerItems, 'none');
});

test('(b) label mode, no plan events: the gate fails plan-scope', async () => {
  const gate = await gateFor(setup(), homeDir());
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failed, ['plan-scope']);
  assert.match(scopeCheck(gate).detail, /plan-scope none/);
});

test('(c) an approved plan event + the matching local record + every file in scope: ok, no owner-merge items', async () => {
  const text = planText(['src/**']);
  const home = homeDir();
  const rec = owner(home, text);
  const gate = await gateFor(setup({ text, comments: [proposedEvent(text), approvedEvent(text, rec)] }), home);
  assert.equal(gate.ok, true, JSON.stringify(gate.checks.filter((c) => !c.ok)));
  const c = scopeCheck(gate);
  assert.equal(c.ownerMerge, undefined);
  assert.match(c.detail, /every changed file is in the approved plan scope/);
  assert.equal(gate.ownerItems, 'none');
});

test('(d) the same with one file outside the scope: one item `plan-scope outside <file>`', async () => {
  const text = planText(['src/**']);
  const home = homeDir();
  const rec = owner(home, text);
  const gate = await gateFor(setup({ text, extra: ['lib/extra.js'], chat: true, comments: [proposedEvent(text), approvedEvent(text, rec)] }), home);
  const c = scopeCheck(gate);
  assert.deepEqual([c.ok, c.ownerMerge, c.ownerItems], [true, 1, ['plan-scope outside lib/extra.js']]);
  // label mode: the same evidence fails the gate instead
  const labelled = await gateFor(setup({ text, extra: ['lib/extra.js'], comments: [proposedEvent(text), approvedEvent(text, rec)] }), home);
  assert.deepEqual(labelled.failed, ['plan-scope']);
});

test('(e) an edited approval comment is lost', async () => {
  const text = planText(['src/**']);
  const home = homeDir();
  const rec = owner(home, text);
  const gate = await gateFor(setup({ text, comments: [proposedEvent(text), approvedEvent(text, rec, {}, { edited: true })] }), home);
  const c = scopeCheck(gate);
  assert.equal(c.ok, false);
  assert.match(c.detail, /^lost: .*edited/);
});

test('(f) gateRefusals refuses a saved gate whose checks lack plan-scope (canonical set)', async () => {
  const gate = await gateFor(setup({ chat: true }), homeDir());
  assert.deepEqual(gate.checks.map((c) => c.name), ['pr-open', 'labels', 'preflight', 'verify-report', 'hardstops', 'integrity', 'plan-scope', 'review', 'ci']);
  assert.deepEqual([...CANONICAL_CHECKS], gate.checks.map((c) => c.name));
  const args = { pr: PR, head: gate.head, prHead: gate.head, hash: gate.contentHash, repo: gate.repo };
  assert.deepEqual(gateRefusals({ gate: { ...gate, at: new Date().toISOString() }, ...args }), []);
  const stripped = { ...gate, at: new Date().toISOString(), checks: gate.checks.filter((c) => c.name !== 'plan-scope') };
  assert.match(gateRefusals({ gate: stripped, ...args }).join('; '), /missing canonical check\(s\): plan-scope/);
});

test('(g) summary-only evidence: a readable record with a plan but no plan events is lost (the decoded summary is used)', async () => {
  const text = planText(['src/**']);
  const rec = applyCheckpoint({ ...emptyRecord({ ...BIND, baseRef: 'main' }), step: 'build' }, { plan: { path: REL, blob: blobOf(text), scopeDigest: digestOf(text), state: 'approved' } }, { host: 'mac', now: Date.now() });
  const body = [MARKERS.summary, '', renderStatusBlock(rec), '', encodeRecord(rec)].join('\n');
  const gate = await gateFor(setup({ text, comments: [comment(body)] }), homeDir());
  const c = scopeCheck(gate);
  assert.equal(c.ok, false);
  assert.match(c.detail, /^lost: a plan was proposed or approved here/);
});

test('(h) a forged approval whose path names a changed source file exempts nothing: the file is still an item', async () => {
  const text = planText(['docs/**']);
  const home = homeDir();
  const rec = owner(home, text);
  const forged = approvedEvent(text, rec, { path: 'src/app.js' });
  const gate = await gateFor(setup({ text, chat: true, comments: [proposedEvent(text), forged] }), home);
  assert.deepEqual(scopeCheck(gate).ownerItems, ['plan-scope outside src/app.js']);
});

test('(i) a replayed older approval does not count: the owner\'s newest record has no event, so the approval is unverified', async () => {
  const text = planText(['src/**']);
  const text2 = planText(['src/**', 'lib/**']);
  const home = homeDir();
  const old = owner(home, text, { session: 'sess-old', at: Date.now() - 3600_000 });
  owner(home, text2, { session: 'sess-new', at: Date.now() });
  const gate = await gateFor(setup({ text, chat: true, comments: [proposedEvent(text), approvedEvent(text, old)] }), home);
  assert.deepEqual(scopeCheck(gate).ownerItems, ['plan-scope unverified mac']);
});

test('(j) an approval event without a real recordId / promptSha256 never verifies', async () => {
  const text = planText(['src/**']);
  const home = homeDir();
  const rec = owner(home, text);
  const gate = await gateFor(setup({ text, chat: true, comments: [proposedEvent(text), approvedEvent(text, rec, { recordId: 'xx', promptSha256: 'yy' })] }), home);
  assert.deepEqual(scopeCheck(gate).ownerItems, ['plan-scope unverified mac']);
});

test('fail closed: a diff that cannot be read, or a gh/comment read that throws, is a failed check, never a pass', async () => {
  const gh = { viewer: () => 'me', listComments: () => [], prView: () => ({ headRefName: 'agent/feature' }), repo: () => ({ slug: 'acme/widgets' }) };
  const config = { plan: { required: false }, owner_approval: 'chat' };
  const noDiff = await planScopeCheck({ root: '.', config, diff: () => ({ ok: false, error: 'bad ref' }), gh, pr: PR, home: homeDir() });
  assert.deepEqual([noDiff.name, noDiff.ok], ['plan-scope', false]);
  assert.match(noDiff.detail, /could not diff against the base: bad ref/);
  // a throwing comment read: evaluateGate records a failed check (even report-only), it does not skip the check
  const sc = setup({ chat: true, required: false });
  const { config: cfg } = await loadConfig(sc.repo.dir);
  const env = { ...process.env, ...sc.fake.env, ...createFakeCodex().env, PIPELINE_NOTIFY: 'off', PIPELINE_MERGEABLE_PAUSE_MS: '1' };
  const real = createGitHub({ cwd: sc.repo.dir, env });
  const broken = { ...real, listComments: () => { throw new Error('gh down'); } };
  const gate = await evaluateGate({ root: sc.repo.dir, config: cfg, pr: PR, gh: broken, env, home: homeDir() });
  assert.equal(scopeCheck(gate).ok, false);
  assert.match(scopeCheck(gate).detail, /could not evaluate: gh down/);
});
