// `P plan record | approve | risk` (ship redesign T4): real git repo, scripted fake gh whose comment list follows what the
// command posted (absorb), and the owner's "approve" written by the real recorder into a temp home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { run } from '../pipeline/commands/plan.mjs';
import { readPlanApprovals, recordApproval } from '../pipeline/hooks/lib/owner-go.mjs';
import { parsePlan, scopeDigest } from '../pipeline/lib/plan.mjs';
import { listEvents, parseEvent, renderEvent } from '../pipeline/lib/run-events.mjs';
import { applyCheckpoint, decodeRecord, emptyRecord, encodeRecord, renderStatusBlock } from '../pipeline/lib/run-record.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { planResumeFacts } from '../pipeline/lib/plan-state.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const REL = 'docs/plans/p.md';
const T0 = Date.parse('2026-10-19T10:00:00Z');
const HOUR = 3600 * 1000;
const BIND = { repo: 'acme/widgets', pr: 7, branch: 'agent/x' };

const planText = ({ scope = ['src/**'], tasks = ['T1'], body = 'Add the widget.' } = {}) => [
  '## In plain English', 'A small change.', '', '## Scope', ...[REL, ...scope].map((s) => `- \`${s}\``), '',
  ...tasks.flatMap((t) => [`### Task ${t}: do ${t}`, body, '']),
].join('\n');

function setup(t, { text = planText(), yml = pipelineYml() } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  repo.write(REL, text);
  const head = repo.commit('plan');
  const fake = createFakeGh([]);
  const home = mkdtempSync(join(tmpdir(), 'plan-home-'));
  const w = { repo, fake, home, headOid: head, comments: [], nextId: 100, absorbed: 0, now: T0 };
  const script = () => [
    { match: '^api user', stdout: 'me\n' },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^pr view 7', stdoutJson: { headRefOid: w.headOid, headRefName: 'agent/x', baseRefName: 'main' } },
    { match: '^api repos/acme/widgets/issues/7/comments --paginate', stdoutJson: w.comments },
    { match: '-X POST repos/acme/widgets/issues/7/comments', stdoutJson: { id: 9000, html_url: 'https://x/9000' } },
    { match: '-X PATCH repos/acme/widgets/issues/comments/', stdoutJson: { id: 9001, html_url: 'https://x/9001' } },
  ];
  w.sync = () => fake.setScript(script());
  w.add = (body, id = w.nextId++) => { w.comments.push({ id, user: { login: 'me' }, body, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', html_url: `https://x/${id}` }); return id; };
  // What the commands posted (POST) or rewrote (PATCH) becomes the comment list the next call reads.
  w.absorb = () => {
    const calls = fake.calls().slice(w.absorbed);
    w.absorbed += calls.length;
    for (const c of calls) {
      const a = c.argv.join(' ');
      if (/-X POST .*issues\/7\/comments/.test(a)) {
        const body = JSON.parse(c.stdin).body;
        if (body.startsWith(MARKERS.summary)) w.summaryId = w.add(body);
        else w.add(body);
      } else if (/-X PATCH .*issues\/comments\//.test(a)) {
        const c2 = w.comments.find((x) => x.id === w.summaryId);
        c2.body = JSON.parse(c.stdin).body;
      }
    }
    w.sync();
  };
  w.posts = () => fake.calls().filter((c) => c.argv.includes('POST') && /issues\/7\/comments/.test(c.argv.join(' '))).map((c) => JSON.parse(c.stdin).body);
  w.events = () => w.posts().map(parseEvent).filter(Boolean);
  w.setSummary = (record) => { w.summaryId = w.add([MARKERS.summary, '', renderStatusBlock(record), '', encodeRecord(record)].join('\n')); w.sync(); };
  w.summary = () => decodeRecord(w.comments.find((x) => x.id === w.summaryId).body).record;
  w.call = async (args, ctx = {}) => run(args, { cwd: repo.dir, env: { ...process.env, ...fake.env }, home, now: () => w.now, ...ctx });
  w.sync();
  w.blob = () => repo.git(['rev-parse', `HEAD:${REL}`]).trim();
  w.recommit = (text, msg = 'edit plan') => { repo.write(REL, text); w.headOid = repo.commit(msg); w.sync(); };
  // The owner types "approve" after the request lines of the plan with this blob; the recorder writes the line at `at`.
  w.approves = (blob, digest, { at = T0, pr = 7, session = 'sess-1' } = {}) => {
    const reply = `Plan ${blob} · scope ${digest}\n📋 Ready to approve plan #${pr} — say "approve"`;
    const tf = join(home, `t-${session}-${at}.jsonl`);
    writeFileSync(tf, [{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }, { type: 'user', message: { content: 'approve' } }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const rec = recordApproval({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: home, prompt: 'approve', transcript_path: tf }, { home, now: () => at });
    assert.ok(rec, 'the recorder wrote the owner record');
    return rec;
  };
  w.digest = () => scopeDigest(parsePlan(repo.git(['cat-file', 'blob', w.blob()])).scope);
  return w;
}

const rec0 = (over = {}) => applyCheckpoint({ ...emptyRecord({ ...BIND, baseRef: 'main' }), step: 'build' }, over, { host: 'mac', now: T0 });

test('record refuses a dirty or uncommitted plan (exit 1 dirty) and an unpushed HEAD', async (t) => {
  const w = setup(t);
  w.repo.write(REL, `${planText()}\nedited after commit\n`);
  let r = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'dirty']);
  w.repo.git(['checkout', '--', REL]);
  w.repo.write('docs/plans/new.md', planText());
  r = await w.call(['record', '--pr', '7', '--file', 'docs/plans/new.md']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'dirty']);
  w.headOid = 'f'.repeat(40);
  w.sync();
  r = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'unpushed']);
  assert.equal(w.posts().length, 0);
});

test('record refuses a plan that does not list itself in its Scope (plan-invalid), via the real CLI', (t) => {
  const w = setup(t, { text: planText().replace(`- \`${REL}\`\n`, '') });
  const r = spawnSync(process.execPath, [bin, 'plan', 'record', '--pr', '7', '--file', REL], { cwd: w.repo.dir, env: { ...process.env, ...w.fake.env }, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.error, 'plan-invalid');
  assert.match(out.problems.join(' '), /own path/);
});

test('record posts one plan-proposed and checkpoints step plan; a retry with the same blob posts nothing', async (t) => {
  const w = setup(t);
  const r = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  const blob = w.blob();
  assert.equal(r.output.blob, blob);
  assert.equal(r.output.event.reused, false);
  assert.deepEqual(r.output.tasks.map((x) => x.id), ['T1']);
  assert.deepEqual(r.output.requestLines, [`Plan ${blob} · scope ${w.digest()}`, '📋 Ready to approve plan #7 — say "approve"']);
  const events = w.events();
  assert.deepEqual(events.map((e) => e.kind), ['plan-proposed']);
  assert.deepEqual([events[0].data.blob, events[0].data.path, events[0].data.n, events[0].data.pr, events[0].data.branch], [blob, REL, 1, 7, 'agent/x']);
  w.absorb();
  assert.deepEqual([w.summary().step, w.summary().plan.state, w.summary().plan.blob], ['plan', 'proposed', blob]);
  const again = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.equal(again.output.event.reused, true);
  assert.equal(w.events().length, 1, 'no second event');
});

test('record A, B, A posts a third occurrence with n: 3', async (t) => {
  const w = setup(t);
  const a = planText();
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.recommit(planText({ body: 'Different words.' }));
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.recommit(a, 'restore plan');
  const r = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.equal(r.output.event.reused, false);
  assert.deepEqual(w.events().map((e) => e.data.n), [1, 2, 3]);
});

test('approve: no proposal, no approval, superseded, scope-mismatch', async (t) => {
  const w = setup(t);
  let r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'no-proposal']);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'no-approval']);
  w.approves('1'.repeat(40), w.digest());
  r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'superseded']);
  w.approves(w.blob(), '0'.repeat(12), { at: T0 + 1000, session: 'sess-2' });
  r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'scope-mismatch']);
  assert.equal(w.events().filter((e) => e.kind === 'plan-approved').length, 0);
});

test('approve with a matching record posts plan-approved and moves the run to build with the plan tasks', async (t) => {
  const w = setup(t, { text: planText({ tasks: ['T1', 'T2'] }) });
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  const owner = w.approves(w.blob(), w.digest());
  const r = await w.call(['approve', '--pr', '7']);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.stepChanged, r.output.repaired, r.output.event.reused], [true, false, false]);
  const ap = w.events().find((e) => e.kind === 'plan-approved');
  assert.deepEqual([ap.data.blob, ap.data.recordId, ap.data.promptSha256, ap.data.scopeDigest, ap.data.path], [w.blob(), owner.record_id, owner.prompt_sha256, w.digest(), REL]);
  w.absorb();
  const rec = w.summary();
  assert.deepEqual([rec.step, rec.outcome, rec.plan.state], ['build', null, 'approved']);
  assert.deepEqual(rec.tasks.map((x) => [x.id, x.done, x.specSha?.length]), [['T1', false, 12], ['T2', false, 12]]);
  // a second call finds the event and the record: nothing new is posted
  const again = await w.call(['approve', '--pr', '7']);
  assert.equal(again.exitCode, 0);
  assert.deepEqual([again.output.event.reused, again.output.stepChanged], [true, false]);
  assert.equal(w.events().filter((e) => e.kind === 'plan-approved').length, 1);
});

for (const step of ['gate', 'awaiting-owner-merge']) {
  test(`approve at step ${step} reconciles tasks but never resets the step`, async (t) => {
    const w = setup(t);
    await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
    const tasks = parsePlan(w.repo.git(['cat-file', 'blob', w.blob()])).tasks;
    // the later-stage record was written from the approved plan earlier: T1 is done at its spec
    w.setSummary(rec0({ step, outcome: step === 'gate' ? null : 'awaiting-owner-merge', tasks: tasks.map((x) => ({ ...x, done: true })), plan: { path: REL, blob: w.blob(), scopeDigest: w.digest(), state: 'approved' } }));
    w.approves(w.blob(), w.digest());
    const r = await w.call(['approve', '--pr', '7']);
    assert.equal(r.exitCode, 0, JSON.stringify(r.output));
    assert.equal(r.output.stepChanged, false);
    w.absorb();
    assert.equal(w.summary().step, step);
    assert.equal(w.summary().tasks[0].done, true, 'a task already built at the same spec stays done');
  });
}

test('approve refuses an unsupported (v: 3) or foreign run record: record-unreadable, nothing posted', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.approves(w.blob(), w.digest());
  const before = w.posts().length;
  const c = w.comments.find((x) => x.id === w.summaryId);
  c.body = [MARKERS.summary, '', encodeRecord({ ...rec0({ step: 'gate' }), v: 3 })].join('\n');
  w.sync();
  let r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'record-unreadable']);
  assert.equal(w.posts().length, before);
  // a record that belongs to another PR is unreadable too
  c.body = [MARKERS.summary, '', encodeRecord({ ...rec0({ step: 'gate' }), pr: 8 })].join('\n');
  w.sync();
  r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'record-unreadable']);
  assert.equal(w.posts().length, before);
});

test('repair: an approval event already on the PR is accepted with a 25 h old record; with no event the 24 h rule holds', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  const owner = w.approves(w.blob(), w.digest());
  // no event yet, 25 h later: issuance keeps the 24 h rule
  w.now = T0 + 25 * HOUR;
  let r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'no-approval']);
  // the approval event exists (posted before the checkpoint failed), the record is 25 h old: repaired, no new event
  w.add(renderEvent('plan-approved', `${w.blob().slice(0, 12)}-${owner.record_id.slice(0, 8)}`, 'Plan approved', {
    ...BIND, path: REL, blob: w.blob(), scopeDigest: w.digest(), recordId: owner.record_id, promptSha256: owner.prompt_sha256,
  }));
  w.sync();
  r = await w.call(['approve', '--pr', '7']);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.repaired, r.output.event.reused, r.output.stepChanged], [true, true, true]);
  assert.equal(w.events().filter((e) => e.kind === 'plan-approved').length, 0, 'no new plan-approved event was posted');
  w.absorb();
  assert.equal(w.summary().tasks.length, 1);
  assert.equal(w.summary().step, 'build');
  // after 31 days even a repair is refused
  w.now = T0 + 31 * 24 * HOUR;
  r = await w.call(['approve', '--pr', '7']);
  assert.equal(r.output.error, 'no-approval');
});

test('repair of a stopped record: approve sets step build, clears the outcome and the resume facts stop asking for a checkpoint', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  const owner = w.approves(w.blob(), w.digest());
  w.add(renderEvent('plan-approved', `${w.blob().slice(0, 12)}-${owner.record_id.slice(0, 8)}`, 'Plan approved', {
    ...BIND, path: REL, blob: w.blob(), scopeDigest: w.digest(), recordId: owner.record_id, promptSha256: owner.prompt_sha256,
  }));
  // the checkpoint failed, then the run was stopped: step ended, outcome stopped, no tasks
  w.comments.find((x) => x.id === w.summaryId).body = [MARKERS.summary, '', encodeRecord(rec0({ step: 'ended', outcome: 'stopped', plan: { path: REL, blob: w.blob(), scopeDigest: w.digest(), state: 'proposed' } }))].join('\n');
  w.sync();
  const r = await w.call(['approve', '--pr', '7']);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.repaired, r.output.stepChanged], [true, true]);
  w.absorb();
  const rec = w.summary();
  assert.deepEqual([rec.step, rec.outcome, rec.tasks.length], ['build', null, 1]);
  const facts = planResumeFacts({
    events: listEvents(w.comments, 'me'), bind: BIND, recordPlan: rec.plan, localRecords: readPlanApprovals({ home: w.home, now: () => w.now }), recordTasks: rec.tasks,
    readBlob: (b) => w.repo.git(['cat-file', 'blob', b]),
  });
  assert.deepEqual([facts.approval, facts.needsApproveCheckpoint, facts.openWork], ['verified', false, true]);
});

test('approve 24 h boundary: exactly 24 h ok, 24 h + 1 s refused, a record 10 minutes in the future refused', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.approves(w.blob(), w.digest());
  w.now = T0 + 24 * HOUR + 1000;
  assert.equal((await w.call(['approve', '--pr', '7'])).output.error, 'no-approval');
  w.now = T0 + 24 * HOUR;
  assert.equal((await w.call(['approve', '--pr', '7'])).exitCode, 0);
  const f = setup(t);
  await f.call(['record', '--pr', '7', '--file', REL]); f.absorb();
  f.approves(f.blob(), f.digest(), { at: T0 + 10 * 60 * 1000 });
  assert.equal((await f.call(['approve', '--pr', '7'])).output.error, 'no-approval');
});

// ---- risk ------------------------------------------------------------------------------------------------------------------

async function riskOf(t, opts, { yml } = {}) {
  const w = setup(t, { text: planText(opts), ...(yml ? { yml } : {}) });
  const rec = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.equal(rec.exitCode, 0, JSON.stringify(rec.output));
  w.absorb();
  return (await w.call(['risk', '--pr', '7'])).output;
}

test('risk: migrations, db/, brace and ./ scopes are high; a doc file with one task is low', async (t) => {
  assert.equal((await riskOf(t, { scope: ['supabase/migrations/x.sql'] })).level, 'high');
  assert.equal((await riskOf(t, { scope: ['db/'] })).level, 'high');
  assert.equal((await riskOf(t, { scope: ['src/{a,b}.sql'] })).level, 'high');
  assert.equal((await riskOf(t, { scope: ['./supabase/x.sql'] })).level, 'high');
  const low = await riskOf(t, { scope: ['docs/guide.md'] });
  assert.deepEqual([low.level, low.reasons], ['low', ['small plan']]);
});

test('risk: a task naming a risky area, more than 3 tasks, and a configured hard-stop path', async (t) => {
  const words = await riskOf(t, { scope: ['docs/guide.md'], body: 'Rotate the secret used by the job.' });
  assert.equal(words.level, 'high');
  assert.match(words.reasons.join(' '), /"secret"/);
  assert.equal((await riskOf(t, { scope: ['docs/guide.md'], tasks: ['T1', 'T2', 'T3', 'T4'] })).level, 'medium');
  const yml = `${pipelineYml()}hard_stops:\n  paths: ['payments/**']\n`;
  assert.equal((await riskOf(t, { scope: ['payments/'] }, { yml })).level, 'high');
  assert.equal((await riskOf(t, { scope: ['docs/guide.md'] }, { yml })).level, 'low');
});

test('risk without a recorded plan is no-proposal (exit 1), via the real CLI', (t) => {
  const w = setup(t);
  const r = spawnSync(process.execPath, [bin, 'plan', 'risk', '--pr', '7'], { cwd: w.repo.dir, env: { ...process.env, ...w.fake.env }, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).error, 'no-proposal');
});

test('an unknown subcommand is a usage error', async (t) => {
  const w = setup(t);
  await assert.rejects(() => w.call(['nope']), /usage: pipeline plan record\|approve\|risk/);
});

// ---- security review F4 / F6 / F8 ----------------------------------------------------------------------------------------------

test('F6: approve refuses when the active proposal\'s blob is not the blob at its path in the checkout', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  const blobA = w.blob();
  const digestA = w.digest();
  w.recommit(planText({ scope: ['src/**', 'evil/**'] }), 'sneak an edit');
  assert.notEqual(w.blob(), blobA);
  w.approves(blobA, digestA);
  const before = w.posts().length;
  const r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'plan-changed']);
  assert.equal(w.posts().length, before, 'nothing was posted');
});

test('F8: approve refuses a legacy run record; record keeps a later-stage step', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.approves(w.blob(), w.digest());
  const c = w.comments.find((x) => x.id === w.summaryId);
  const saved = c.body;
  c.body = `${MARKERS.summary}\n\nold pre-record summary, no record block`;
  w.sync();
  const before = w.posts().length;
  const r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'record-unreadable']);
  assert.equal(w.posts().length, before);
  // record at a later stage must not pull the run back to the plan stage
  c.body = saved; w.sync();
  w.setSummary(rec0({ step: 'gate' }));
  const again = await w.call(['record', '--pr', '7', '--file', REL]);
  assert.equal(again.exitCode, 0, JSON.stringify(again.output));
  w.absorb();
  assert.deepEqual([w.summary().step, w.summary().plan.state], ['gate', 'proposed']);
});

test('F4: approve does not repair from an older approval event once the owner approved a newer plan', async (t) => {
  const w = setup(t);
  const textA = planText();
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  const blobA = w.blob(), digestA = w.digest();
  w.approves(blobA, digestA);
  assert.equal((await w.call(['approve', '--pr', '7'])).exitCode, 0); w.absorb();
  w.recommit(planText({ scope: ['src/**', 'lib/**'] }), 'plan B');
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.approves(w.blob(), w.digest(), { at: T0 + 1000, session: 'sess-2' }); // the owner approved B; `approve` has not run for it
  w.recommit(textA, 'back to plan A');
  assert.equal(w.blob(), blobA);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  const before = w.events().filter((e) => e.kind === 'plan-approved').length;
  const r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'superseded']);
  assert.equal(w.events().filter((e) => e.kind === 'plan-approved').length, before);
});

test('N3: approve refuses when local HEAD is not the PR head', async (t) => {
  const w = setup(t);
  await w.call(['record', '--pr', '7', '--file', REL]); w.absorb();
  w.approves(w.blob(), w.digest());
  w.headOid = 'd'.repeat(40); w.sync();
  const before = w.posts().length;
  const r = await w.call(['approve', '--pr', '7']);
  assert.deepEqual([r.exitCode, r.output.error], [1, 'unpushed']);
  assert.equal(w.posts().length, before);
});

test('N4: record refuses an unreadable (legacy, invalid or foreign) run record and posts nothing', async (t) => {
  for (const make of [() => `${MARKERS.summary}\n\nold pre-record summary`, () => [MARKERS.summary, '', encodeRecord({ ...rec0({ step: 'gate' }), pr: 8 })].join('\n'), () => [MARKERS.summary, '', encodeRecord({ ...rec0({ step: 'gate' }), v: 3 })].join('\n')]) {
    const w = setup(t);
    w.summaryId = w.add(make()); w.sync();
    const r = await w.call(['record', '--pr', '7', '--file', REL]);
    assert.deepEqual([r.exitCode, r.output.error], [1, 'record-unreadable']);
    assert.equal(w.posts().length, 0, 'nothing posted');
  }
});

// ---- plan.dir ----------------------------------------------------------------------------------------------------------------

test('record refuses a plan path outside config plan.dir (usage error, exit 2, nothing posted), via the real CLI', (t) => {
  const w = setup(t);
  const cli = (file) => spawnSync(process.execPath, [bin, 'plan', 'record', '--pr', '7', '--file', file], { cwd: w.repo.dir, env: { ...process.env, ...w.fake.env }, encoding: 'utf8' });
  for (const file of ['notes/p.md', 'docs/plans-evil/p.md', 'p.md']) {
    w.repo.write(file, planText().replace(`\`${REL}\``, `\`${file}\``));
    w.headOid = w.repo.commit(`plan at ${file}`);
    w.sync();
    const r = cli(file);
    assert.equal(r.status, 2, `${file}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /outside plan\.dir \(docs\/plans\)/);
  }
  assert.equal(w.posts().length, 0, 'nothing was posted');
  assert.equal(cli(REL).status, 0, 'a path inside plan.dir still records');
});

test('record honours a configured plan.dir and refuses the default one then', async (t) => {
  const w = setup(t, { yml: pipelineYml().replace('plan:\n', 'plan:\n  dir: plans/\n') });
  w.repo.write('plans/q.md', planText().replace(`\`${REL}\``, '`plans/q.md`'));
  w.headOid = w.repo.commit('plan in plans/');
  w.sync();
  await assert.rejects(() => w.call(['record', '--pr', '7', '--file', REL]), /outside plan\.dir \(plans\/\)/);
  const r = await w.call(['record', '--pr', '7', '--file', 'plans/q.md']);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
});
