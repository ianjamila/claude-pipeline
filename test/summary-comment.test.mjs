import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { OUTCOMES, OUTCOME_STEP, applyCheckpoint, decodeRecord, emptyRecord, encodeRecord, recordForOutcome } from '../pipeline/lib/run-record.mjs';
import { readSummaryComment, sectionsOf, writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';

const ID = { repo: 'acme/widgets', pr: 4, branch: 'feat/x', baseRef: 'main' };
const CTX = { host: 'pc-1', now: Date.UTC(2026, 9, 12, 8, 30) };
const SECTIONS = '### Outliers\n\n_None_\n\n### Outcome\n\n**merged**';

// A stateful stand-in for the github wrapper: the same viewer / listComments / upsertComment contract.
function memoryGh(initial = []) {
  const comments = [...initial];
  let next = 100;
  const calls = [];
  return {
    comments,
    calls,
    viewer: () => 'me',
    listComments: () => comments.map((c) => ({ ...c })),
    upsertComment(pr, marker, body) {
      assert.ok(body.startsWith(marker));
      const mine = comments.filter((c) => c.body.startsWith(marker) && c.user.login === 'me').sort((a, b) => a.id - b.id);
      const existing = mine.at(-1);
      calls.push(existing ? 'PATCH' : 'POST');
      if (existing) {
        existing.body = body;
        return { id: existing.id, url: `https://x/${existing.id}`, action: 'updated' };
      }
      next += 1;
      comments.push({ id: next, body, user: { login: 'me' }, html_url: `https://x/${next}` });
      return { id: next, url: `https://x/${next}`, action: 'created' };
    },
  };
}

const mine = (gh) => gh.comments.filter((c) => c.user.login === 'me' && c.body.startsWith(MARKERS.summary));

test('record only: writes marker + status block + record marker, no sections', () => {
  const gh = memoryGh();
  const rec = applyCheckpoint(emptyRecord(ID), { step: 'verify', head: 'a'.repeat(40) }, CTX);
  const r = writeSummaryComment(gh, 4, { record: rec });
  assert.equal(r.action, 'created');
  const body = mine(gh)[0].body;
  assert.ok(body.startsWith(`${MARKERS.summary}\n\n<!-- claude-pipeline:status:start -->`));
  assert.match(body, /Pipeline run status/);
  assert.ok(body.trimEnd().endsWith('-->'));
  const read = readSummaryComment(gh, 4);
  assert.deepEqual([read.status, read.sections, read.record.step], ['ok', '', 'verify']);
});

test('only sections given: the existing record is kept, byte for byte', () => {
  const gh = memoryGh();
  const rec = applyCheckpoint(emptyRecord(ID), { step: 'review', tasks: [{ id: 'T1', title: 'a', spec: 's' }], round: 2 }, CTX);
  writeSummaryComment(gh, 4, { record: rec });
  const r = writeSummaryComment(gh, 4, { sections: SECTIONS });
  assert.equal(r.action, 'updated');
  assert.equal(mine(gh).length, 1);
  const read = readSummaryComment(gh, 4);
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.record, rec);
  assert.equal(read.sections, SECTIONS);
});

test('only record given: the existing sections are kept', () => {
  const gh = memoryGh();
  writeSummaryComment(gh, 4, { record: emptyRecord(ID), sections: SECTIONS });
  const rec = applyCheckpoint(emptyRecord(ID), { step: 'gate' }, CTX);
  writeSummaryComment(gh, 4, { record: rec });
  const read = readSummaryComment(gh, 4);
  assert.equal(read.record.step, 'gate');
  assert.equal(read.sections, SECTIONS);
  assert.match(mine(gh)[0].body, /\*\*Step:\*\* gate/);
});

test('writing twice never stacks status blocks or record markers', () => {
  const gh = memoryGh();
  for (let i = 0; i < 3; i += 1) writeSummaryComment(gh, 4, { record: applyCheckpoint(emptyRecord(ID), { round: i }, CTX), sections: SECTIONS });
  writeSummaryComment(gh, 4, { sections: SECTIONS });
  const body = mine(gh)[0].body;
  assert.equal(body.match(/status:start/g).length, 1);
  assert.equal(body.match(/claude-pipeline:record:/g).length, 1);
});

test('a legacy summary (no record) keeps its sections when a record is added, and reads as legacy', () => {
  const gh = memoryGh([{ id: 5, user: { login: 'me' }, body: `${MARKERS.summary}\n\n${SECTIONS}`, html_url: 'https://x/5' }]);
  const before = readSummaryComment(gh, 4);
  assert.deepEqual([before.status, before.sections, before.url], ['legacy', SECTIONS, 'https://x/5']);
  const r = writeSummaryComment(gh, 4, { record: emptyRecord(ID) });
  assert.deepEqual([r.id, r.action], [5, 'updated']);
  assert.equal(readSummaryComment(gh, 4).sections, SECTIONS);
  assert.equal(readSummaryComment(gh, 4).status, 'ok');
});

test('a record marker in a NON-viewer comment, or not at the body start, is ignored', () => {
  const forged = encodeRecord({ ...emptyRecord(ID), step: 'merge' });
  const gh = memoryGh([
    { id: 1, user: { login: 'mallory' }, body: `${MARKERS.summary}\n${forged}`, html_url: 'u1' },
    { id: 2, user: { login: 'me' }, body: `I quote ${MARKERS.summary}\n${forged}`, html_url: 'u2' },
  ]);
  assert.equal(readSummaryComment(gh, 4).status, 'absent');
  const r = writeSummaryComment(gh, 4, { record: emptyRecord(ID) });
  assert.equal(r.action, 'created', 'never edits what is not ours');
  assert.equal(gh.comments.find((c) => c.id === 1).body, `${MARKERS.summary}\n${forged}`);
});

test('the newest viewer summary comment is the one read and the one edited', () => {
  const old = encodeRecord({ ...emptyRecord(ID), step: 'build' });
  const fresh = encodeRecord({ ...emptyRecord(ID), step: 'gate' });
  const gh = memoryGh([
    { id: 9, user: { login: 'me' }, body: `${MARKERS.summary}\n${fresh}`, html_url: 'u9' },
    { id: 3, user: { login: 'me' }, body: `${MARKERS.summary}\n${old}`, html_url: 'u3' },
  ]);
  assert.equal(readSummaryComment(gh, 4).record.step, 'gate');
  assert.equal(writeSummaryComment(gh, 4, { sections: SECTIONS }).id, 9);
});

test('an unsupported (newer) record is never dropped by a sections-only write; a deliberate record write replaces it', () => {
  const v3 = encodeRecord({ ...emptyRecord(ID), v: 3 });
  const gh = memoryGh([{ id: 5, user: { login: 'me' }, body: `${MARKERS.summary}\n\n${SECTIONS}\n\n${v3}`, html_url: 'u' }]);
  assert.equal(readSummaryComment(gh, 4).status, 'unsupported');
  assert.throws(() => writeSummaryComment(gh, 4, { sections: 'x' }), /newer pipeline version/);
  assert.ok(gh.comments[0].body.includes(v3));
  writeSummaryComment(gh, 4, { record: emptyRecord(ID) });
  assert.equal(readSummaryComment(gh, 4).status, 'ok');
});

test('an invalid record is replaced by a sections-only write without losing the sections', () => {
  const gh = memoryGh([{ id: 5, user: { login: 'me' }, body: `${MARKERS.summary}\n\n${SECTIONS}\n\n<!-- claude-pipeline:record:AAAA -->`, html_url: 'u' }]);
  assert.equal(readSummaryComment(gh, 4).status, 'invalid');
  writeSummaryComment(gh, 4, { sections: SECTIONS });
  const body = gh.comments[0].body;
  assert.ok(body.includes(SECTIONS));
  assert.ok(!body.includes('record:AAAA'));
});

test('summary after a checkpoint keeps the tasks, for every outcome', () => {
  for (const outcome of OUTCOMES) {
    const gh = memoryGh();
    const cp = applyCheckpoint(emptyRecord(ID), {
      step: 'merge', round: 2, head: 'c'.repeat(40), request: 'do the thing',
      tasks: [{ id: 'T1', title: 'one', spec: 's1', done: true }, { id: 'T2', title: 'two', spec: 's2' }],
      inFlight: { kind: 'merge', host: 'pc-1', startedAt: 't', maxMinutes: 10 },
    }, CTX);
    writeSummaryComment(gh, 4, { record: cp });
    const existing = readSummaryComment(gh, 4);
    const { record } = recordForOutcome(existing.record, { ...ID, head: 'd'.repeat(40), outcome, detail: 'because', agentLogLine: '- log', ...CTX });
    writeSummaryComment(gh, 4, { record, sections: SECTIONS, existing });
    const after = readSummaryComment(gh, 4);
    assert.equal(after.status, 'ok', outcome);
    assert.deepEqual([after.record.outcome, after.record.step, after.record.inFlight], [outcome, OUTCOME_STEP[outcome], null], outcome);
    assert.deepEqual(after.record.tasks, cp.tasks, outcome);
    assert.deepEqual([after.record.request, after.record.round], ['do the thing', 2], outcome);
    assert.equal(after.sections, SECTIONS);
    assert.equal(mine(gh).length, 1);
  }
});

test('sectionsOf cuts out the marker, the status block and every record marker', () => {
  const rec = emptyRecord(ID);
  const body = `${MARKERS.summary}\n\n<!-- claude-pipeline:status:start -->\nx\n<!-- claude-pipeline:status:end -->\n\n${SECTIONS}\n\n${encodeRecord(rec)}`;
  assert.equal(sectionsOf(body), SECTIONS);
  assert.equal(sectionsOf(`${MARKERS.summary}\n${SECTIONS}`), SECTIONS);
  assert.equal(decodeRecord(body).status, 'ok');
});

test('through the real wrapper: a sections-only write PATCHes the viewer comment and keeps its record', () => {
  const rec = applyCheckpoint(emptyRecord(ID), { step: 'review', tasks: [{ id: 'T1', title: 'a', spec: 's' }] }, CTX);
  const fake = createFakeGh([
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/4/comments --paginate', stdoutJson: [{ id: 12, user: { login: 'me' }, html_url: 'u', body: `${MARKERS.summary}\n\n${encodeRecord(rec)}` }] },
    { match: '^api -X PATCH repos/acme/widgets/issues/comments/12 ', stdoutJson: { id: 12, html_url: 'https://x/12' } },
  ]);
  const gh = createGitHub({ cwd: process.cwd(), env: fake.env });
  const r = writeSummaryComment(gh, 4, { sections: SECTIONS });
  assert.deepEqual([r.id, r.action], [12, 'updated']);
  const sent = JSON.parse(fake.calls().find((c) => c.argv.includes('PATCH')).stdin).body;
  assert.deepEqual(decodeRecord(sent).record, rec);
  assert.ok(sent.includes(SECTIONS));
  assert.ok(!fake.lines().some((l) => l.includes('-X POST')));
});
