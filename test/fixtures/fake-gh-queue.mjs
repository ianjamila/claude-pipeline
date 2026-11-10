// A stateful stand-in for `gh` for the merge-queue route tests (test/merge-queue-route.test.mjs). Same script format and call log as
// fake-gh.mjs (PIPELINE_FAKE_GH_SCRIPT, PIPELINE_FAKE_GH_LOG); the GraphQL queue calls are answered from a state file (PIPELINE_FAKE_GH_QUEUE):
//   { phase, idx, last, enqueues, phases: [[{ pr, events }, ...], ...], enqueueFail?: { "<nth enqueue>": "stderr text" }, failQueueState?: true, failQueueStateFrom?: <nth read on>, failQueueEvents?: true }
// A `phase` is what GitHub shows between two enqueues: each `QueueState` read returns the next reply of the current phase (the last one repeats),
// `QueueEvents` returns the events of the reply the last state read returned, and a successful `mutation Enqueue` moves to the next phase.
// `pr` is the GraphQL pullRequest node (id, state, headRefOid, isMergeQueueEnabled, mergeCommit, mergeQueueEntry). Anything else is answered by the script.
// With PIPELINE_FAKE_GH_FALLBACK=<path of another fake> every call that is NOT a queue call goes to that fake instead (the needs-human hold tests use
// test/fixtures/fake-gh-hold.mjs, which also logs the call itself). `liftedChecks: [rows, ...]` (the last repeats) answers `pr checks 12` (not --required)
// from the moment the hold fake's state no longer carries needs-human: the guard statuses re-posting after a hold lift.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const log = process.env.PIPELINE_FAKE_GH_LOG;
const stateFile = process.env.PIPELINE_FAKE_GH_QUEUE;
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const out = (data) => process.stdout.write(JSON.stringify({ data }));
const repliesNow = () => state.phases[Math.min(state.phase, state.phases.length - 1)];

const fallback = process.env.PIPELINE_FAKE_GH_FALLBACK;
const queueCall = joined.startsWith('api graphql') && /query (QueueState|QueueEvents|PrNodeId)|mutation (Enqueue|Dequeue)/.test(joined);
const liftedNow = () => {
  try { return !JSON.parse(readFileSync(process.env.PIPELINE_FAKE_GH_STATE, 'utf8')).labels.includes('needs-human'); } catch { return false; }
};
const liftedChecks = fallback && state.liftedChecks && /^pr checks 12 /.test(joined) && !joined.includes('--required') && liftedNow();
if (fallback && !queueCall && !liftedChecks) {
  await import(pathToFileURL(fallback).href); // (the fallback logs the call and answers it)
} else {
const stdin = (() => {
  if (!argv.includes('--input')) return '';
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
})();
if (log) appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd(), stdin })}\n`);

if (liftedChecks) {
  const i = Math.min(state.liftedChecksIdx ?? 0, state.liftedChecks.length - 1);
  state.liftedChecksIdx = (state.liftedChecksIdx ?? 0) + 1;
  save();
  process.stdout.write(JSON.stringify(state.liftedChecks[i]));
} else if (joined.startsWith('api graphql') && joined.includes('query QueueState')) {
  state.stateReads = (state.stateReads ?? 0) + 1;
  if (state.failQueueState || (state.failQueueStateFrom && state.stateReads >= state.failQueueStateFrom)) {
    save();
    process.stderr.write('gh: Server Error (HTTP 502)');
    process.exitCode = 1;
  } else {
    const replies = repliesNow();
    const i = Math.min(state.idx ?? 0, replies.length - 1);
    state.idx = (state.idx ?? 0) + 1;
    state.last = i;
    save();
    out({ repository: { pullRequest: replies[i].pr } });
  }
} else if (joined.startsWith('api graphql') && joined.includes('query QueueEvents')) {
  if (state.failQueueEvents) {
    process.stderr.write('gh: Server Error (HTTP 502)');
    process.exitCode = 1;
  } else {
    const events = repliesNow()[state.last ?? 0]?.events ?? [];
    out({ repository: { pullRequest: { timelineItems: { nodes: events, pageInfo: { hasNextPage: false, endCursor: null } } } } });
  }
} else if (joined.startsWith('api graphql') && joined.includes('query PrNodeId')) {
  out({ repository: { pullRequest: { id: 'PR_node12' } } });
} else if (joined.startsWith('api graphql') && joined.includes('mutation Enqueue')) {
  state.enqueues = (state.enqueues ?? 0) + 1;
  const fail = state.enqueueFail?.[String(state.enqueues)];
  if (fail !== undefined) {
    save();
    process.stderr.write(fail);
    process.exitCode = 1;
  } else {
    state.phase += 1;
    state.idx = 0;
    state.last = 0;
    save();
    out({ enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1', state: 'QUEUED', position: 1 } } });
  }
} else if (joined.startsWith('api graphql') && joined.includes('mutation Dequeue')) {
  state.dequeues = (state.dequeues ?? 0) + 1;
  save();
  out({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } });
} else {
  const entries = JSON.parse(readFileSync(process.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
  const hit = entries.find((e) => new RegExp(e.match).test(joined));
  if (!hit) {
    process.stderr.write(`fake-gh-queue: no match for ${joined}`);
    process.exitCode = 99;
  } else {
    if (hit.stdoutJson !== undefined) process.stdout.write(JSON.stringify(hit.stdoutJson));
    else if (hit.stdout) process.stdout.write(hit.stdout);
    if (hit.stderr) process.stderr.write(hit.stderr);
    process.exitCode = hit.code ?? 0;
  }
}
}
