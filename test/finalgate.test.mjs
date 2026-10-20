// Unit tests for the pure parts of the final gate, merge and agent-log libraries. The CLI behaviour (real git, fake
// gh) is covered in cli-gate.test.mjs; here every branch of the small decision functions is pinned directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import {
  BLOCKING_LABELS, CANONICAL_CHECKS, GATE_MAX_AGE_MS, abandonMerge, blockingLabelsOf, expectedCheckNames, gateRefusals, inlineOptionValues,
  isDocsOnly, isLogOnly, labelNames, labelsCheck, mergeTiming, preMergeProblems, readPrSettled, readReviewJson, tailLines, waitBlockers, waitForMerge, writeReviewJson,
} from '../pipeline/lib/finalgate.mjs';
import {
  AGENT_LOG_HEADER, appendLines, assertSingleLine, buildAgentLogLine, countArbiterCalls, resolveLogPath,
} from '../pipeline/lib/agentlog.mjs';

const f = (path, extra = {}) => ({ path, oldPath: extra.status === 'A' ? null : path, newPath: path, status: 'M', binary: false, added: [{ line: 1, text: 'x' }], removed: [], ...extra });
const SHA = 'a'.repeat(40);

// ---- classifiers ---------------------------------------------------------------------------------

test('isDocsOnly: only markdown, docs/ text and LICENSE/CHANGELOG count; one code file spoils it; empty is not docs-only', () => {
  assert.equal(isDocsOnly([f('README.md'), f('docs/a/b.md'), f('packages/x/NOTES.md'), f('docs/notes.txt')]), true);
  assert.equal(isDocsOnly([f('README.md'), f('src/app.js')]), false);
  assert.equal(isDocsOnly([]), false);
  assert.equal(isDocsOnly(null), false);
});

test('isDocsOnly: agent instruction files are never docs, at any depth, in any case', () => {
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', 'copilot-instructions.md']) {
    assert.equal(isDocsOnly([f(name)]), false, name);
    assert.equal(isDocsOnly([f(`docs/deep/er/${name}`)]), false, `docs/deep/er/${name}`);
    assert.equal(isDocsOnly([f('README.md'), f(`packages/x/${name}`)]), false, `packages/x/${name}`);
    assert.equal(isDocsOnly([f(`sub/${name.toUpperCase()}`)]), false, 'upper case');
    assert.equal(isDocsOnly([{ oldPath: `docs/${name}`, newPath: 'docs/renamed.md', status: 'R' }]), false, 'a rename out of an instruction file');
  }
  assert.equal(isDocsOnly([f('docs/claude-notes.md'), f('docs/agents-overview.md')]), true, 'similar names are still docs');
});

test('isDocsOnly: files under docs/ that are not text docs are NOT docs-only (reviewer repro E)', () => {
  assert.equal(isDocsOnly([f('docs/deploy.sh')]), false);
  assert.equal(isDocsOnly([f('docs/x.png', { binary: true })]), false);
  assert.equal(isDocsOnly([f('docs/x.md', { binary: true })]), false, 'binary content never counts, whatever the name');
  assert.equal(isDocsOnly([f('docs/build.mjs')]), false);
  assert.equal(isDocsOnly([f('docs/a/b.png')]), false);
  assert.equal(isDocsOnly([f('docsx/a.js')]), false);
  assert.equal(isDocsOnly([f('README.MD')]), true, 'extensions are case-insensitive');
});

test('isDocsOnly: instruction, hook, workflow and pipeline directories are never docs, markdown or not', () => {
  for (const p of ['.claude/skills/a.md', '.claude/commands/x.md', '.github/pull_request_template.md', '.githooks/README.md', 'skills/ship/SKILL.md',
    'agents/reviewer.md', 'pipeline/README.md', 'scripts/NOTES.txt', 'packages/x/skills/a.md', 'docs/pipeline/design.md']) {
    assert.equal(isDocsOnly([f('README.md'), f(p)]), false, p);
  }
  assert.equal(isDocsOnly([f('docs/pipelines.md'), f('my-scripts/readme.md')]), true, 'only whole directory names are excluded');
  assert.equal(isDocsOnly([{ path: 'docs/a.md', status: 'A' }]), true, 'a file record without oldPath/newPath still works');
});

test('isDocsOnly: a rename counts by BOTH paths (moving code into docs/ is not a docs change)', () => {
  const moved = { path: 'docs/app.md', oldPath: 'src/app.js', newPath: 'docs/app.md', status: 'R', binary: false, added: [], removed: [] };
  assert.equal(isDocsOnly([moved]), false);
  assert.equal(isDocsOnly([{ ...moved, oldPath: 'docs/old.md' }]), true);
  assert.equal(isDocsOnly([{ ...moved, oldPath: 'docs/old.sh' }]), false);
});

test('isLogOnly: only additions to the configured log file qualify', () => {
  const log = 'docs/agent-log.md';
  assert.equal(isLogOnly([f(log, { status: 'A' })], log), true);
  assert.equal(isLogOnly([f(log)], log), true, 'appending to an existing log (M, no removed lines)');
  assert.equal(isLogOnly([f(log, { removed: [{ line: 3, text: 'old' }] })], log), false, 'editing history is not log-only');
  assert.equal(isLogOnly([f(log, { status: 'D' })], log), false);
  assert.equal(isLogOnly([f(log), f('src/app.js')], log), false);
  assert.equal(isLogOnly([f(log, { binary: true })], log), false);
  assert.equal(isLogOnly([], log), false);
  assert.equal(isLogOnly([f('docs/agent-log.md')], './docs/agent-log.md'), true, 'a leading ./ in config is normalised');
  assert.equal(isLogOnly([f('docs/other.md')], log), false);
});

test('isLogOnly: a file record without `removed` counts as no removals; unexpected shapes fail closed (reviewer finding 11)', () => {
  const log = 'docs/agent-log.md';
  const bare = { path: log, status: 'A', binary: false };
  assert.equal(isLogOnly([bare], log), true);
  assert.equal(isLogOnly([{ ...bare, removed: undefined }], log), true);
  assert.equal(isLogOnly([{ ...bare, removed: null }], log), false);
  assert.equal(isLogOnly([{ ...bare, removed: 'x' }], log), false);
  assert.equal(isLogOnly([{ ...bare, removed: { length: 0 } }], log), false);
  assert.equal(isLogOnly([null], log), false);
  assert.equal(isLogOnly(['docs/agent-log.md'], log), false);
  assert.equal(isLogOnly([{ ...bare, status: undefined }], log), false);
  assert.equal(isLogOnly([{ ...bare, removed: [{ line: 1, text: 'x' }] }], log), false);
  assert.equal(isLogOnly({ path: log }, log), false);
});

test('blocking labels: objects or strings, matched case-insensitively', () => {
  assert.deepEqual(labelNames([{ name: 'a' }, 'b', null, {}]), ['a', 'b']);
  assert.deepEqual(blockingLabelsOf([{ name: 'Needs-Human' }, { name: 'bug' }, 'pipeline-blocked']), ['Needs-Human', 'pipeline-blocked']);
  assert.deepEqual(blockingLabelsOf(undefined), []);
  assert.deepEqual([...BLOCKING_LABELS], ['needs-human', 'awaiting-review', 'pipeline-blocked']);
});

test('labelsCheck: labels must be a list of objects with string names; anything else fails closed (reviewer finding 7)', () => {
  assert.equal(labelsCheck({ labels: [] }).ok, true);
  assert.equal(labelsCheck({ labels: [{ name: 'bug' }] }).ok, true);
  assert.equal(labelsCheck({ labels: [{ name: 'needs-human' }] }).ok, false);
  for (const labels of [undefined, null, 'needs-human', {}, [{}], [null], [{ name: 7 }], [{ name: 'bug' }, {}], ['bug'], [[]]]) {
    const c = labelsCheck({ labels });
    assert.equal(c.ok, false, JSON.stringify(labels));
    assert.match(c.detail, /labels/, JSON.stringify(labels));
  }
  assert.equal(labelsCheck(undefined).ok, false);
});

// ---- chat mode: the needs-human label is ignored and the owner-stop reader is consulted (plan D3 / T4) ----------------------------------------------

test('blockingLabelsOf / labelsCheck in chat mode: needs-human (any case) is ignored, the other blockers stay, stop problems fail; label mode keeps its exact text', () => {
  const chat = { ownerApproval: 'chat' };
  assert.deepEqual(blockingLabelsOf([{ name: 'Needs-Human' }, { name: 'awaiting-review' }], chat), ['awaiting-review']);
  assert.deepEqual(blockingLabelsOf([{ name: 'needs-human' }]), ['needs-human'], 'the default is unchanged');
  assert.deepEqual(blockingLabelsOf([{ name: 'needs-human' }], { ownerApproval: 'label' }), ['needs-human']);
  assert.equal(labelsCheck({ labels: [{ name: 'needs-human' }] }).detail, 'blocking label(s): needs-human');
  assert.equal(labelsCheck({ labels: [] }).detail, 'no blocking labels');
  const ignored = labelsCheck({ labels: [{ name: 'needs-human' }] }, chat);
  assert.deepEqual([ignored.ok, ignored.detail], [true, 'no blocking labels (needs-human ignored: owner_approval chat)']);
  assert.equal(labelsCheck({ labels: [] }, chat).detail, 'no blocking labels');
  const stop = labelsCheck({ labels: [] }, { ...chat, stopProblems: ['owner stop ab12cd34 (x) is open'] });
  assert.deepEqual([stop.ok, stop.detail], [false, 'owner stop ab12cd34 (x) is open']);
  const both = labelsCheck({ labels: [{ name: 'pipeline-blocked' }] }, { ...chat, stopProblems: ['owner stop ab12cd34 (x) is open'] });
  assert.equal(both.detail, 'blocking label(s): pipeline-blocked; owner stop ab12cd34 (x) is open');
  assert.equal(labelsCheck({ labels: null }, chat).ok, false, 'unreadable labels still fail closed');
  assert.equal(labelsCheck({ labels: [] }, { stopProblems: ['x'] }).ok, true, 'label mode never looks at stop problems');
});

const stopBody = (id) => renderEvent('owner-stop', id, 'stop', { repo: 'o/r', pr: 12, id, cause: 'merge:command-failed', head: null, at: '2026-10-20T08:00:00.000Z', host: 'h', autoMergeDisarmed: true });
function chatGh({ view, comments = [], issues = {}, commentsError = null } = {}) {
  const calls = { views: [], comments: 0 };
  return {
    calls,
    prView: (pr, fields) => { calls.views.push([pr, [...fields]]); return view; },
    listIssues: ({ label }) => issues[label] ?? [],
    listComments: () => { calls.comments += 1; if (commentsError) throw commentsError; return comments; },
    viewer: () => 'me',
  };
}
const mine = (body, id = 1) => ({ id, user: { login: 'me' }, body });
const NOROOT = mkdtempSync(join(tmpdir(), 'finalgate-noremote-'));
const OPEN_VIEW = { state: 'OPEN', headRefOid: SHA, isDraft: false, labels: [] };

test('preMergeProblems: chat adds autoMergeRequest to the read, ignores needs-human and reports an open stop; label mode reads exactly the old fields and never lists comments', async () => {
  const chatArgs = { pr: 12, head: SHA, ownerApproval: 'chat', root: NOROOT };
  const clean = chatGh({ view: OPEN_VIEW });
  assert.deepEqual(await preMergeProblems({ gh: clean, ...chatArgs }), []);
  assert.deepEqual(clean.calls.views, [[12, ['state', 'headRefOid', 'labels', 'isDraft', 'autoMergeRequest']]]);
  assert.deepEqual(await preMergeProblems({ gh: chatGh({ view: { ...OPEN_VIEW, labels: [{ name: 'needs-human' }] } }), ...chatArgs }), []);
  const stopped = await preMergeProblems({ gh: chatGh({ view: OPEN_VIEW, comments: [mine(stopBody('ab12cd34'))] }), ...chatArgs });
  assert.match(stopped.join(), /owner stop ab12cd34 \(merge:command-failed\) is open/);
  const armed = await preMergeProblems({ gh: chatGh({ view: { ...OPEN_VIEW, autoMergeRequest: { enabledAt: 'x' } }, comments: [mine(stopBody('ab12cd34'))] }), ...chatArgs });
  assert.match(armed.join(), /auto-merge is armed on a stopped PR: gh pr merge 12 --disable-auto/);
  const unreadable = await preMergeProblems({ gh: chatGh({ view: OPEN_VIEW, commentsError: new Error('HTTP 502') }), ...chatArgs });
  assert.match(unreadable.join(), /owner stops could not be read from GitHub \(HTTP 502\)/);
  const label = chatGh({ view: OPEN_VIEW, comments: [mine(stopBody('ab12cd34'))] });
  assert.deepEqual(await preMergeProblems({ gh: label, pr: 12, head: SHA }), []);
  assert.deepEqual(label.calls.views, [[12, ['state', 'headRefOid', 'labels', 'isDraft']]]);
  assert.equal(label.calls.comments, 0, 'label mode: no extra gh call');
});

test('waitBlockers: the polling view carries autoMergeRequest in chat only; a new stop or a read failure is a blocker on that poll; label mode is untouched', async () => {
  const args = { pr: 12, root: NOROOT, ownerApproval: 'chat' };
  const view = { labels: [{ name: 'needs-human' }] };
  const chat = waitBlockers(chatGh({}), args);
  assert.deepEqual(chat.extraFields, ['autoMergeRequest']);
  assert.deepEqual(await chat(view), []);
  assert.match((await waitBlockers(chatGh({ comments: [mine(stopBody('ab12cd34'))] }), args)(view)).join(), /owner stop ab12cd34/);
  assert.match((await waitBlockers(chatGh({ commentsError: new Error('HTTP 502') }), args)(view)).join(), /owner stops could not be read/);
  assert.match((await waitBlockers(chatGh({}), args)({ labels: null })).join(), /labels could not be read/, 'malformed labels still block');
  const label = chatGh({ comments: [mine(stopBody('ab12cd34'))] });
  const plain = waitBlockers(label);
  assert.equal(plain.extraFields, undefined);
  assert.deepEqual(await plain(view), ['blocking label(s): needs-human']);
  assert.equal(label.calls.comments, 0);
});

test('waitForMerge asks for labels (and the blocker\'s extra fields) only when it has blockers', async () => {
  const seen = [];
  const gh = { prView: (pr, fields) => { seen.push([...fields]); return { state: 'MERGED', mergeCommit: { oid: SHA } }; } };
  await waitForMerge({ gh, pr: 1, waitMs: 0, pollMs: 1 });
  await waitForMerge({ gh, pr: 1, waitMs: 0, pollMs: 1, blockers: Object.assign(async () => [], { extraFields: ['autoMergeRequest'] }) });
  await waitForMerge({ gh, pr: 1, waitMs: 0, pollMs: 1, blockers: async () => [] });
  assert.deepEqual(seen, [['state', 'mergeCommit'], ['state', 'mergeCommit', 'labels', 'autoMergeRequest'], ['state', 'mergeCommit', 'labels']]);
});

test('tailLines: last N lines, colours stripped, long lines clipped, trailing blanks dropped', () => {
  const text = `${Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n')}\n\n`;
  const t = tailLines(text, 30).split('\n');
  assert.equal(t.length, 30);
  assert.equal(t[0], 'l11');
  assert.equal(t.at(-1), 'l40');
  assert.equal(tailLines('\x1b[31mred\x1b[0m'), 'red');
  assert.ok(tailLines('x'.repeat(1000)).length < 500);
  assert.equal(tailLines(undefined), '');
});

test('inlineOptionValues: folds \`--name value\` into \`--name=value\` so dash-leading values (markdown bullets) survive parseArgs', () => {
  assert.deepEqual(inlineOptionValues(['--pr', '12', '--line', '- 2026 · #12'], ['--line']), ['--pr', '12', '--line=- 2026 · #12']);
  assert.deepEqual(inlineOptionValues(['--line=- x', '--pr', '1'], ['--line']), ['--line=- x', '--pr', '1']);
  assert.deepEqual(inlineOptionValues(['--line'], ['--line']), ['--line'], 'a dangling flag is left for parseArgs to reject');
  assert.deepEqual(inlineOptionValues(['--other', '--line'], ['--line']), ['--other', '--line']);
  assert.deepEqual(inlineOptionValues(['--built', '- a', '--outcome', 'ok'], ['--built', '--outcome']), ['--built=- a', '--outcome=ok']);
});

// ---- gateRefusals --------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-01T12:00:00Z');
const checksOf = (names = CANONICAL_CHECKS) => names.map((name) => ({ name, ok: true, detail: '' }));
const goodGate = (over = {}) => ({
  ok: true, repo: 'acme/widgets', pr: 12, head: SHA, contentHash: 'h1', at: '2026-10-01T11:50:00Z', checks: checksOf(), ...over,
});
const refusals = (gate, over = {}) => gateRefusals({ gate, pr: 12, head: SHA, prHead: SHA, hash: 'h1', repo: 'acme/widgets', now: NOW, ...over });

test('gateRefusals: a matching, fresh gate has no refusals', () => {
  assert.deepEqual(refusals(goodGate()), []);
});

test('gateRefusals: every mismatch is refused, each with its own reason', () => {
  const other = 'b'.repeat(40);
  assert.match(refusals(null)[0], /no final-gate\.json/);
  assert.match(refusals(goodGate({ ok: false })).join(), /did not pass/);
  assert.match(refusals(goodGate({ checks: [{ name: 'pr-open', ok: false }, ...checksOf().slice(1)] })).join(), /failing or missing checks/);
  assert.match(refusals(goodGate({ checks: [] })).join(), /failing or missing checks/);
  assert.match(refusals(goodGate({ pr: 13 })).join(), /PR #13, not #12/);
  assert.match(refusals(goodGate({ head: 'short' })).join(), /no valid head SHA/);
  assert.match(refusals(goodGate({ head: other })).join(), /worktree is at/);
  assert.match(refusals(goodGate(), { prHead: other }).join(), /PR head is/);
  assert.match(refusals(goodGate({ contentHash: 'h2' })).join(), /content hash differs/);
  assert.match(refusals(goodGate({ contentHash: '' }), { hash: '' }).join(), /content hash differs/, 'an empty hash never matches an empty hash');
  assert.match(refusals(goodGate(), { hash: '' }).join(), /content hash differs/);
});

test('gateRefusals: the check-name set is pinned: every canonical check, once, and nothing else', () => {
  assert.deepEqual([...CANONICAL_CHECKS], ['pr-open', 'labels', 'preflight', 'verify-report', 'hardstops', 'integrity', 'review', 'ci']);
  assert.deepEqual(expectedCheckNames(false), [...CANONICAL_CHECKS]);
  assert.deepEqual(expectedCheckNames(true), [...CANONICAL_CHECKS, 'preview']);
  assert.deepEqual(refusals(goodGate({ checks: checksOf(expectedCheckNames(true)) }), { previewConfigured: true }), []);
  assert.match(refusals(goodGate({ checks: [{ name: 'x', ok: true }] })).join(), /missing canonical check\(s\): pr-open, labels, preflight, verify-report, hardstops, integrity, review, ci/);
  assert.match(refusals(goodGate({ checks: checksOf().filter((c) => c.name !== 'ci') })).join(), /missing canonical check\(s\): ci$/);
  assert.match(refusals(goodGate({ checks: checksOf(CANONICAL_CHECKS.filter((n) => n !== 'review')) })).join(), /missing canonical check\(s\): review/);
  assert.match(refusals(goodGate(), { previewConfigured: true }).join(), /missing canonical check\(s\): preview/);
  assert.match(refusals(goodGate({ checks: checksOf(expectedCheckNames(true)) })).join(), /unexpected check\(s\): preview/);
  assert.match(refusals(goodGate({ checks: [...checksOf(), { name: 'bonus', ok: true }] })).join(), /unexpected check\(s\): bonus/);
  assert.match(refusals(goodGate({ checks: [...checksOf(), { name: 'ci', ok: true }] })).join(), /more than once/);
  assert.match(refusals(goodGate({ checks: [...checksOf().slice(0, 7), null] })).join(), /failing or missing checks/);
});

test('gateRefusals: the gate must name the repo it is being merged in', () => {
  assert.match(refusals(goodGate({ repo: undefined })).join(), /records no repo/);
  assert.match(refusals(goodGate({ repo: '' })).join(), /records no repo/);
  assert.match(refusals(goodGate({ repo: 7 })).join(), /records no repo/);
  assert.match(refusals(goodGate({ repo: 'someone/else' })).join(), /someone\/else, not acme\/widgets/);
  assert.match(refusals(goodGate(), { repo: undefined }).join(), /could not determine the repo/);
});

test('gateRefusals: age limit is 30 minutes; a missing, bad or future timestamp is refused', () => {
  const at = (msAgo) => new Date(NOW - msAgo).toISOString();
  assert.deepEqual(refusals(goodGate({ at: at(GATE_MAX_AGE_MS - 1000) })), []);
  assert.match(refusals(goodGate({ at: at(GATE_MAX_AGE_MS + 60_000) })).join(), /minutes old/);
  assert.match(refusals(goodGate({ at: undefined })).join(), /no valid timestamp/);
  assert.match(refusals(goodGate({ at: 'yesterday-ish' })).join(), /no valid timestamp/);
  assert.match(refusals(goodGate({ at: at(-10 * 60_000) })).join(), /future/);
});

// ---- waitForMerge, mergeTiming ------------------------------------------------------------------

function fakeGh(views) {
  const calls = [];
  return {
    calls,
    prView(pr, fields) {
      calls.push({ pr, fields });
      const next = views.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};

test('waitForMerge: returns merged with the merge commit once GitHub says MERGED', async () => {
  const gh = fakeGh([{ state: 'OPEN' }, { state: 'OPEN' }, { state: 'MERGED', mergeCommit: { oid: 'abc' } }]);
  const r = await waitForMerge({ gh, pr: 12, waitMs: 60_000, pollMs: 10_000, ...clock() });
  assert.deepEqual(r, { state: 'merged', mergeSha: 'abc' });
  assert.deepEqual(gh.calls[0].fields, ['state', 'mergeCommit']);
  assert.equal(gh.calls.length, 3);
});

test('waitForMerge: still OPEN at the deadline is a timeout; CLOSED ends early', async () => {
  const open = Array.from({ length: 50 }, () => ({ state: 'OPEN' }));
  const gh = fakeGh(open);
  const r = await waitForMerge({ gh, pr: 12, waitMs: 30_000, pollMs: 10_000, ...clock() });
  assert.equal(r.state, 'timeout');
  assert.equal(gh.calls.length, 4, 'polls at 0, 10, 20 and 30 s');
  assert.deepEqual(await waitForMerge({ gh: fakeGh([{ state: 'CLOSED' }]), pr: 12, waitMs: 60_000, pollMs: 1, ...clock() }), { state: 'closed' });
});

test('waitForMerge: zero wait looks exactly once; transient errors are tolerated, three in a row are not', async () => {
  const once = fakeGh([{ state: 'OPEN' }]);
  assert.equal((await waitForMerge({ gh: once, pr: 12, waitMs: 0, pollMs: 10, ...clock() })).state, 'timeout');
  assert.equal(once.calls.length, 1);
  const flaky = fakeGh([new Error('boom'), new Error('boom'), { state: 'MERGED', mergeCommit: null }]);
  assert.deepEqual(await waitForMerge({ gh: flaky, pr: 12, waitMs: 60_000, pollMs: 1, ...clock() }), { state: 'merged', mergeSha: null });
  const dead = fakeGh([new Error('a'), new Error('b'), new Error('c'), { state: 'MERGED' }]);
  const r = await waitForMerge({ gh: dead, pr: 12, waitMs: 60_000, pollMs: 1, ...clock() });
  assert.equal(r.state, 'error');
  assert.match(r.error, /c/);
});

test('waitForMerge: a blocker found on an OPEN poll ends the wait at once; MERGED is never second-guessed', async () => {
  const gh = fakeGh([{ state: 'OPEN', labels: [] }, { state: 'OPEN', labels: [{ name: 'needs-human' }] }, { state: 'MERGED', mergeCommit: { oid: 'abc' } }]);
  const seen = [];
  const blockers = async (view) => {
    seen.push(view.labels.length);
    return view.labels.length ? ['blocking label(s): needs-human'] : [];
  };
  const r = await waitForMerge({ gh, pr: 12, waitMs: 60_000, pollMs: 10, blockers, ...clock() });
  assert.deepEqual(r, { state: 'blocked', problems: ['blocking label(s): needs-human'] });
  assert.deepEqual(seen, [0, 1]);
  assert.deepEqual(gh.calls[0].fields, ['state', 'mergeCommit', 'labels']);

  const merged = fakeGh([{ state: 'MERGED', mergeCommit: { oid: 'abc' }, labels: [{ name: 'needs-human' }] }]);
  const never = async () => { throw new Error('blockers must not run for a merged PR'); };
  assert.deepEqual(await waitForMerge({ gh: merged, pr: 12, waitMs: 1000, pollMs: 10, blockers: never, ...clock() }), { state: 'merged', mergeSha: 'abc' });
});

test('waitForMerge: MERGED without a merge commit is re-read three times before giving up', async () => {
  const gh = fakeGh([{ state: 'MERGED', mergeCommit: null }, { state: 'MERGED' }, { state: 'MERGED', mergeCommit: { oid: 'late' } }]);
  assert.deepEqual(await waitForMerge({ gh, pr: 12, waitMs: 1000, pollMs: 10, ...clock() }), { state: 'merged', mergeSha: 'late' });
  const never = fakeGh([{ state: 'MERGED', mergeCommit: null }, { state: 'MERGED', mergeCommit: null }, { state: 'MERGED', mergeCommit: null }, { state: 'MERGED', mergeCommit: null }, { state: 'MERGED', mergeCommit: { oid: 'too-late' } }]);
  assert.deepEqual(await waitForMerge({ gh: never, pr: 12, waitMs: 1000, pollMs: 10, ...clock() }), { state: 'merged', mergeSha: null });
  assert.equal(never.calls.length, 4, 'one read plus three re-reads');
});

test('abandonMerge: disables auto-merge, then re-reads the PR; a PR that merged in the meantime is reported merged', async () => {
  const order = [];
  const gh = { prView: (pr, fields) => { order.push('read'); return { state: 'MERGED', mergeCommit: { oid: 'ff' } }; } };
  const r = await abandonMerge({ gh, pr: 12, disable: () => { order.push('disable'); return true; }, pollMs: 1, ...clock() });
  assert.deepEqual(order, ['disable', 'read']);
  assert.deepEqual(r, { autoMergeDisabled: true, merged: true, mergeSha: 'ff' });

  const open = await abandonMerge({ gh: { prView: () => ({ state: 'OPEN' }) }, pr: 12, disable: () => true, pollMs: 1, ...clock() });
  assert.deepEqual(open, { autoMergeDisabled: true, merged: false, mergeSha: null });

  // merged but the commit is not readable yet: still merged (the caller decides what a missing sha means)
  const noSha = await abandonMerge({ gh: { prView: () => ({ state: 'MERGED', mergeCommit: null }) }, pr: 12, disable: () => false, pollMs: 1, ...clock() });
  assert.deepEqual(noSha, { autoMergeDisabled: false, merged: true, mergeSha: null });

  const down = await abandonMerge({ gh: { prView: () => { throw new Error('HTTP 502'); } }, pr: 12, disable: () => true, pollMs: 1, ...clock() });
  assert.equal(down.merged, false);
  assert.equal(down.autoMergeDisabled, true);
  assert.match(down.readError, /502/);
});

test('readPrSettled: mergeable UNKNOWN is re-read up to three times with a pause, then returned as is (reviewer finding 9)', async () => {
  const gh = fakeGh([{ mergeable: 'UNKNOWN' }, { mergeable: 'UNKNOWN' }, { mergeable: 'MERGEABLE', n: 3 }]);
  const slept = [];
  const view = await readPrSettled({ gh, pr: 12, fields: ['mergeable'], sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(view, { mergeable: 'MERGEABLE', n: 3 });
  assert.deepEqual(slept, [2000, 2000], 'the default pause is 2 s');

  const stuck = fakeGh(Array.from({ length: 10 }, () => ({ mergeable: 'UNKNOWN' })));
  const last = await readPrSettled({ gh: stuck, pr: 12, fields: ['mergeable'], sleep: async () => {}, pauseMs: 5 });
  assert.equal(last.mergeable, 'UNKNOWN');
  assert.equal(stuck.calls.length, 4);

  const settled = fakeGh([{ mergeable: 'CONFLICTING' }]);
  await readPrSettled({ gh: settled, pr: 12, fields: ['mergeable'], sleep: async () => { throw new Error('no pause needed'); } });
  assert.equal(settled.calls.length, 1);
});

test('mergeTiming: the wait can only be shortened by the test hook, never stretched', () => {
  const config = { merge: { wait_minutes: 15 } };
  assert.deepEqual(mergeTiming(config, {}), { waitMs: 900_000, pollMs: 10_000 });
  assert.deepEqual(mergeTiming(config, { PIPELINE_MERGE_WAIT_MS: '300', PIPELINE_MERGE_POLL_MS: '50' }), { waitMs: 300, pollMs: 50 });
  assert.equal(mergeTiming(config, { PIPELINE_MERGE_WAIT_MS: '99999999' }).waitMs, 900_000);
  assert.equal(mergeTiming(config, { PIPELINE_MERGE_WAIT_MS: 'abc', PIPELINE_MERGE_POLL_MS: '0' }).waitMs, 900_000);
  assert.equal(mergeTiming(config, { PIPELINE_MERGE_POLL_MS: '0' }).pollMs, 10_000);
});

// ---- review-dir json -----------------------------------------------------------------------------

test('writeReviewJson / readReviewJson: round-trips, and unreadable or non-object files read as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rj-'));
  writeReviewJson(dir, 'x.json', { a: 1 });
  assert.deepEqual(readReviewJson(dir, 'x.json'), { a: 1 });
  assert.equal(readReviewJson(dir, 'missing.json'), null);
  writeFileSync(join(dir, '.review', 'bad.json'), '{nope');
  assert.equal(readReviewJson(dir, 'bad.json'), null);
  writeFileSync(join(dir, '.review', 'arr.json'), '[1]');
  assert.equal(readReviewJson(dir, 'arr.json'), null);
});

// ---- agent log helpers ---------------------------------------------------------------------------

test('appendLines: header for a new file, then lines in order; duplicates are skipped', () => {
  const fresh = appendLines(null, ['- a', '- b', '- a']);
  assert.equal(fresh.text, `${AGENT_LOG_HEADER}- a\n- b\n`);
  assert.deepEqual(fresh.fresh, ['- a', '- b']);
  const more = appendLines(fresh.text, ['- b', '- c']);
  assert.deepEqual(more.fresh, ['- c']);
  assert.equal(more.text, `${AGENT_LOG_HEADER}- a\n- b\n- c\n`);
  assert.equal(appendLines('# Agent log\n- x', ['- y']).text, '# Agent log\n- x\n- y\n', 'a missing final newline is repaired');
  assert.equal(appendLines(fresh.text, ['- a']).text, fresh.text);
});

test('assertSingleLine: trims, refuses empty and multi-line values', () => {
  assert.equal(assertSingleLine('  - x  '), '- x');
  assert.throws(() => assertSingleLine(''), /non-empty/);
  assert.throws(() => assertSingleLine('a\nb'), /single line/);
  assert.throws(() => assertSingleLine('a\r- forged'), /single line/);
  assert.throws(() => assertSingleLine('a\u2028b'), /single line/);
  assert.throws(() => assertSingleLine(5), /non-empty string/);
});

test('resolveLogPath: stays inside the repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-log-'));
  mkdirSync(join(root, 'docs'));
  assert.equal(resolveLogPath(root, 'docs/agent-log.md'), join(root, 'docs', 'agent-log.md'));
  assert.throws(() => resolveLogPath(root, '../escape.md'), /inside the repo/);
  assert.throws(() => resolveLogPath(root, '/etc/passwd'), /relative/);
  assert.throws(() => resolveLogPath(root, 'C:\\x.md'), /relative/);
  assert.throws(() => resolveLogPath(root, '.'), /inside the repo/);
  assert.throws(() => resolveLogPath(root, ''), /non-empty/);
  assert.throws(() => resolveLogPath(root, undefined), /non-empty/);
});

test('countArbiterCalls / buildAgentLogLine: arbiter counted per round; line format matches the spec', () => {
  const state = {
    risk: 'medium',
    rounds: [
      { n: 1, items: [{ id: 'F1', arbiter: { ruling: 'ACCEPT' } }, { id: 'F2', arbiter: { ruling: 'REJECT' } }] },
      { n: 2, items: [{ id: 'F3' }] },
      { n: 3, arbiter: { called: true }, items: [] },
    ],
  };
  assert.equal(countArbiterCalls(state), 2);
  assert.equal(countArbiterCalls(null), 0);
  const line = buildAgentLogLine({ state, pr: 7, title: 'Add | widget', outcome: 'merged', now: new Date('2026-10-01T23:59:59Z') });
  assert.equal(line, '- 2026-10-01 · #7 · Add &#124; widget · risk medium · rounds 3 · arbiter 2 · merged');
  assert.match(buildAgentLogLine({ state: null, pr: 1, title: 't', outcome: 'o' }), /risk unknown · rounds 0 · arbiter 0/);
});

test('review dir helpers do not need a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rj2-'));
  writeReviewJson(dir, 'a.json', { ok: true });
  assert.match(readFileSync(join(dir, '.review', 'a.json'), 'utf8'), /"ok": true/);
});

const releaseBody = (id) => renderEvent('owner-stop-released', id, 'released', { repo: 'o/r', pr: 12, id, at: '2026-10-20T09:00:00.000Z', host: 'h', releaseRef: { kind: 'resume', session: 'x', ts: 'x', prompt_sha256: 'x' } });

test('preMergeProblems / waitBlockers: expectedStops compares the stop HISTORY (newest id, released ids), so a released new stop is caught; unchanged history and label mode are not', async () => {
  const chatArgs = { pr: 12, head: SHA, ownerApproval: 'chat', root: NOROOT };
  const history = [mine(stopBody('ab12cd34'), 1), mine(releaseBody('ab12cd34'), 2)];
  const same = { stopId: 'ab12cd34', released: ['ab12cd34'] };
  assert.deepEqual(await preMergeProblems({ gh: chatGh({ view: OPEN_VIEW, comments: history }), ...chatArgs, expectedStops: same }), []);
  const grown = [...history, mine(stopBody('7c1d4e90'), 3), mine(releaseBody('7c1d4e90'), 4)];
  const changed = await preMergeProblems({ gh: chatGh({ view: OPEN_VIEW, comments: grown }), ...chatArgs, expectedStops: same });
  assert.match(changed.join(), /owner stop history changed since the merge request was read \(newest stop ab12cd34 -> 7c1d4e90, released 1 -> 2\)/);
  // a release alone (the same newest stop) also changes it
  const releasedLater = await preMergeProblems({ gh: chatGh({ view: OPEN_VIEW, comments: history }), ...chatArgs, expectedStops: { stopId: 'ab12cd34', released: [] } });
  assert.match(releasedLater.join(), /history changed/);
  // no stops at the start, one released pair now
  assert.match((await waitBlockers(chatGh({ comments: [mine(stopBody('ab12cd34'), 1), mine(releaseBody('ab12cd34'), 2)] }), { ...chatArgs, expectedStops: { stopId: null, released: [] } })({ labels: [] })).join(), /history changed.*none -> ab12cd34/);
  assert.match((await waitBlockers(chatGh({ commentsError: new Error('HTTP 502') }), { ...chatArgs, expectedStops: same })({ labels: [] })).join(), /owner stops could not be read/);
  // label mode: expectedStops is ignored and no comments are listed
  const label = chatGh({ view: OPEN_VIEW, comments: grown });
  assert.deepEqual(await preMergeProblems({ gh: label, pr: 12, head: SHA, expectedStops: same }), []);
  assert.equal(label.calls.comments, 0);
});
