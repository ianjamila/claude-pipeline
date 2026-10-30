// #58: what stops `P merge` from merging a hard-stop PR without the owner, and what lets a low-risk PR through.
// Owner ruling 2026-10-14: low-risk, non-hard-stop PRs MAY auto-merge after the final gate; a hard-stop / needs-human /
// `owner_approval: chat` PR still needs the owner's go bound to the exact head SHA.
//
// Findings (read the code before trusting a green run):
//  - label mode (default): a blocking hard-stop fails the gate AND the live re-gate, whatever labels the PR carries and
//    whatever flag is passed. `P merge` cannot merge such a PR at all; the owner merges it in the GitHub UI.
//  - chat mode: the gate passes with ownerMerge > 0. `P merge` then refuses unless the owner-go recorder holds the owner's "merge"
//    for this PR, the exact head and the gate's owner-item set, and the flags name them (checked on the gate file and again on the live
//    gate), for normal and resumed runs alike. The flags alone are the agent's word and refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalFlags, mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { cli, scenario, ymlFor, ghEntries, PR } from './helpers/gate-env.mjs';
import { CANONICAL_CHECKS } from '../pipeline/lib/finalgate.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';

const hardStopYml = (extra = '') => `${ymlFor()}hard_stops:\n  paths: ['src/**']\n${extra}`;
const chatYml = () => hardStopYml('owner_approval: chat\n');
const mergeWith = (s, args = []) => cli(['merge', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });
const forgeGate = (s) => writeFileSync(join(s.repo.dir, '.review', 'final-gate.json'), JSON.stringify({
  ok: true, repo: 'acme/widgets', pr: PR, head: s.head, contentHash: s.hash,
  checks: CANONICAL_CHECKS.map((name) => ({ name, ok: true, detail: '' })), at: new Date().toISOString(),
}));
const OLD = 'a'.repeat(40);

// ---- label mode: a hard-stop PR cannot be merged by the agent at all ----------------------------------------------------

test('label mode, hard-stop PR, no approval: the gate fails and P merge refuses (no merge command)', () => {
  const s = scenario({ yml: hardStopYml() });
  const g = s.gate();
  assertExit(g, 1);
  assert.equal(g.json.checks.find((c) => c.name === 'hardstops').ok, false);
  const r = mergeWith(s);
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.deepEqual(s.mergeCalls(), []);
});

test('label mode, hard-stop PR: a forged passing gate file does not help, the live re-gate refuses on hardstops', () => {
  const s = scenario({ yml: hardStopYml() });
  assertExit(s.gate(), 1);
  forgeGate(s);
  const r = mergeWith(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'live-check');
  assert.match(r.json.reasons.join('\n'), /hardstops: 1 hard-stop hit/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('label mode, hard-stop PR: a human-approved label (stale or added by the agent) and an approval flag for an old head change nothing', () => {
  const s = scenario({ yml: hardStopYml(), gh: { labels: ['human-approved'] } });
  assertExit(s.gate(), 1);
  forgeGate(s);
  for (const args of [[], ['--owner-approved-head', OLD], ['--owner-approved-head', s.head]]) {
    const r = mergeWith(s, args);
    assertExit(r, 1);
    assert.equal(r.json.error, 'live-check', args.join(' '));
    assert.match(r.json.reasons.join('\n'), /hardstops:/);
  }
  assert.deepEqual(s.mergeCalls(), []);
});

// ---- the owner's ruling: a low-risk PR merges after the final gate, with no approval flag -------------------------------

test('low-risk PR (no hard-stop hit) merges through P merge after the final gate, in label mode and in chat mode', () => {
  for (const yml of [undefined, `${ymlFor()}owner_approval: chat\n`]) {
    const s = scenario(yml ? { yml } : {});
    const g = s.gate();
    assertExit(g, 0);
    assert.equal(g.json.ownerMerge, 0);
    const r = mergeWith(s);
    assertExit(r, 0);
    assert.equal(r.json.merged, true);
    assert.equal(s.mergeCalls().length, 1);
  }
});

// ---- chat mode: a head with items for the owner merges only with the owner's approval of that exact head ------------------

test('chat mode, hard-stop PR: the gate passes only as an owner-merge item (ownerMerge > 0)', () => {
  const s = scenario({ yml: chatYml() });
  const g = s.gate();
  assertExit(g, 0);
  assert.ok(g.json.ownerMerge > 0, 'the owner must be asked');
});

test('chat mode, hard-stop PR, resumed run: a wrong or missing approval head refuses (the one enforced case)', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  const record = {
    v: 1, repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', step: 'gate', outcome: null, next: '', detail: '', head: null,
    request: '', tasks: [], verify: null, round: 0, mergeSha: null, inFlight: null, heartbeat: null, agentLogLine: null, cliVersion: null, history: [],
    resumed: { at: '2026-10-12T08:00:00.000Z', host: 'pc-2', head: OLD },
  };
  // Same record plumbing as checkpoint.test.mjs: the viewer's own summary comment carries the record.
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (n, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record });
  s.fake.setScript(ghEntries({
    prHead: s.head,
    comments: [{ id: 77, user: { login: 'me' }, body }],
    extra: [{ match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'u' } }],
  }));
  for (const args of [[], ['--owner-approved-head', OLD]]) {
    const r = mergeWith(s, args);
    assertExit(r, 1);
    assert.equal(r.json.error, 'pre-merge', args.join(' '));
  }
  assert.deepEqual(s.mergeCalls(), []);
});

test('chat mode, hard-stop PR, normal run, NO approval: P merge refuses before touching GitHub', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  const r = mergeWith(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /owner must say "merge" for this exact head/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('chat mode, hard-stop PR, normal run, STALE approval (an older head): P merge refuses', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  for (const args of [['--owner-approved-head', OLD], ['--owner-approved-head', s.head.slice(0, 12)]]) {
    const r = mergeWith(s, args);
    assertExit(r, 1);
    assert.equal(r.json.error, 'pre-merge', args.join(' '));
  }
  assert.deepEqual(s.mergeCalls(), []);
});

test('chat mode, hard-stop PR: a gate file edited to ownerMerge 0 is caught by the live gate', () => {
  const s = scenario({ yml: chatYml() });
  assertExit(s.gate(), 0);
  forgeGate(s); // (no ownerMerge field: the early check passes)
  const r = mergeWith(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.deepEqual(s.mergeCalls(), []);
});

// ---- the owner's "merge", recorded by the owner-go hook (#58) ----------------------------------------------------------------
const request = mergeRequest;
const approve = (s, g) => approvalFlags(s.head, g.json.ownerItems);

test('chat mode, hard-stop PR: the owner\'s recorded "merge" for the exact head and items merges', (t) => {
  const s = scenario({ yml: chatYml() });
  const g = s.gate();
  assertExit(g, 0);
  assert.match(g.json.ownerItems, /^[0-9a-f]{12}$/, 'the gate names the owner-item set');
  const rec = ownerSays(t, 'merge', request(PR, s.head, g.json.ownerItems));
  assert.equal(rec.requests.length, 1);
  const r = mergeWith(s, approve(s, g));
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(s.mergeCalls().length, 1);
});

test('Phase 3b chat mode, hard-stop PR: the recorded "merge" does not count when gh resolves the repository on another host', (t) => {
  const s = scenario({ yml: chatYml(), gh: { extra: [{ match: '^repo view', stdoutJson: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' }, url: 'https://ghe.corp/acme/widgets' } }] } });
  const g = s.gate();
  assertExit(g, 0);
  ownerSays(t, 'merge', request(PR, s.head, g.json.ownerItems));
  const r = mergeWith(s, approve(s, g));
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /on ghe\.corp, not github\.com/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('chat mode, hard-stop PR: the approval flags supplied by the agent itself, with no owner "merge" recorded, refuse', () => {
  const s = scenario({ yml: chatYml() });
  const g = s.gate();
  assertExit(g, 0);
  const r = mergeWith(s, approve(s, g));
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /no owner "merge" is recorded for acme\/widgets #\d+ head [0-9a-f]{12} items [0-9a-f]{12}/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('chat mode, hard-stop PR: a "merge" for another head, other items or another PR, or a prompt that is not an approval, refuses', (t) => {
  const s = scenario({ yml: chatYml() });
  const g = s.gate();
  assertExit(g, 0);
  const items = g.json.ownerItems;
  ownerSays(t, 'merge', request(PR, OLD, items)); // (an older head)
  ownerSays(t, 'merge', request(PR, s.head, 'f'.repeat(12))); // (another item set)
  ownerSays(t, 'merge', request(PR + 1, s.head, items)); // (another PR)
  ownerSays(t, 'do not merge', request(PR, s.head, items));
  ownerSays(t, 'merge?', request(PR, s.head, items));
  ownerSays(t, `merge #${PR + 1}`, request(PR, s.head, items)); // (the owner named another PR)
  const r = mergeWith(s, approve(s, g));
  assertExit(r, 1);
  assert.match(r.json.reason, /no owner "merge" is recorded/);
  // the flags must also name the gate's own head and items
  for (const args of [['--owner-approved-head', s.head], ['--owner-approved-head', s.head, '--owner-approved-items', 'none']]) {
    const x = mergeWith(s, args);
    assertExit(x, 1);
    assert.match(x.json.reason, /--owner-approved-items is not the gate's owner-item set/, args.join(' '));
  }
  assert.deepEqual(s.mergeCalls(), []);
});

test('chat mode, hard-stop PR: items that changed after the owner\'s "merge" (same head) refuse on the live gate', (t) => {
  const s = scenario({ yml: chatYml() });
  const g = s.gate();
  assertExit(g, 0);
  // the gate file the owner was shown named another item set; the live gate computes the real one
  const shown = 'e'.repeat(12);
  const file = join(s.repo.dir, '.review', 'final-gate.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ownerItems: shown }));
  ownerSays(t, 'merge', request(PR, s.head, shown));
  const r = mergeWith(s, ['--owner-approved-head', s.head, '--owner-approved-items', shown]);
  assertExit(r, 1);
  assert.equal(r.json.error, 'pre-merge');
  assert.match(r.json.reason, /the owner items changed since the owner said "merge"/);
  assert.deepEqual(s.mergeCalls(), []);
});

// ---- `P merge --owner-go`: work that never ran ship merges on the owner's recorded "merge" alone (items none) -----------------
// Only the owner-go record, the live PR state and the required checks gate it; there is no final-gate.json and no verify evidence.
const goYml = (opts = {}) => ymlFor(opts).replace('{pr} {sha}', '{pr} --match-head-commit {sha}');
const goScenario = (opts = {}) => scenario({ yml: goYml(opts.yml), ...opts.rest, gh: opts.gh, report: null, state: null });
const goMerge = (s, extra = []) => mergeWith(s, ['--owner-go', ...extra]);
const reviewFiles = (s) => (existsSync(join(s.repo.dir, '.review')) ? readdirSync(join(s.repo.dir, '.review')) : []);

test('--owner-go: no owner "merge" recorded refuses with error owner-go and runs no merge command', () => {
  const s = goScenario();
  const r = goMerge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-go');
  assert.match(r.json.reason, /no owner "merge" is recorded for acme\/widgets #\d+ head [0-9a-f]{12} items none/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('--owner-go: a recorded "merge" for this PR, the local HEAD and items none merges, pinned to the full head, writing nothing', (t) => {
  const s = goScenario();
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mode, 'owner-go');
  assert.equal(r.json.head, s.head);
  assert.equal(r.json.mergeSha, 'c'.repeat(40));
  assert.equal('prodBefore' in r.json, false);
  assert.deepEqual(s.mergeCalls(), [`${PR} --match-head-commit ${s.head}`]);
  // no gate file, no prod-before record (neither a file nor an event comment)
  assert.equal(reviewFiles(s).includes('final-gate.json'), false, reviewFiles(s).join(','));
  assert.equal(reviewFiles(s).some((f) => /prod-before/.test(f)), false);
  assert.equal(s.fake.lines().some((l) => /prod-before/.test(l) || /issues\/12\/comments/.test(l) && /-X POST/.test(l)), false, s.fake.lines().join('\n'));
  assert.equal(r.json.warnings, undefined, 'no production configured: no prod-before warning');
});

test('--owner-go: a "merge" for another head, other items, another PR or that is not an approval refuses with owner-go', (t) => {
  const s = goScenario();
  ownerSays(t, 'merge', mergeRequest(PR, OLD, 'none')); // (an older head)
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'f'.repeat(12))); // (items other than none)
  ownerSays(t, 'merge', mergeRequest(PR + 1, s.head, 'none')); // (another PR)
  ownerSays(t, 'do not merge', mergeRequest(PR, s.head, 'none'));
  const r = goMerge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-go');
  assert.deepEqual(s.mergeCalls(), []);
});

test('Phase 3b --owner-go: a "merge" for the same PR and head in another repository, or with no repository named, refuses', (t) => {
  const s = goScenario();
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none', 'acme/gadgets')); // (another repository: a fork, a mirror)
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none', null)); // (a request line from before Phase 3b)
  const r = goMerge(s);
  assertExit(r, 1);
  assert.equal(r.json.error, 'owner-go');
  assert.match(r.json.reason, /`Head [0-9a-f]{12} · items none · repo acme\/widgets`/);
  assert.deepEqual(s.mergeCalls(), []);
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none', 'ACME/Widgets')); // (GitHub names are case-insensitive)
  assertExit(goMerge(s), 0);
});

// Phase 3b: gh may resolve owner/name on a server other than github.com (GH_HOST, an ssh host alias, a sole logged-in enterprise
// host); there the owner's "merge" for acme/widgets names another repository, as the guard already holds for a direct merge.
test('Phase 3b --owner-go: a repository gh resolves on a host other than github.com refuses, even with the "merge" recorded', (t) => {
  for (const url of ['https://ghe.corp/acme/widgets', undefined]) {
    const s = goScenario({ gh: { extra: [{ match: '^repo view', stdoutJson: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' }, url } }] } });
    ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none', 'acme/widgets'));
    const r = goMerge(s);
    assertExit(r, 1);
    assert.equal(r.json.error, 'owner-go');
    assert.match(r.json.reason, url ? /on ghe\.corp, not github\.com/ : /on an unknown host, not github\.com/);
    assert.deepEqual(s.mergeCalls(), []);
  }
});

test('--owner-go: the live PR must be ready: behind base, a draft, a red required check or a blocking label refuse (live-check)', (t) => {
  const cases = {
    'behind base': { mergeStateStatus: 'BEHIND' },
    draft: { isDraft: true },
    'red required check': { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] },
    'needs-human': { labels: ['needs-human'] },
    'awaiting-review': { labels: ['awaiting-review'] },
    'pipeline-blocked': { labels: ['pipeline-blocked'] },
  };
  for (const [name, gh] of Object.entries(cases)) {
    const s = goScenario({ gh });
    ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
    const r = goMerge(s);
    assertExit(r, 1, name);
    assert.equal(r.json.error, 'live-check', `${name}: ${r.stdout}`);
    assert.ok(r.json.reasons.length > 0, name);
    assert.deepEqual(s.mergeCalls(), [], name);
    assert.equal(reviewFiles(s).includes('final-gate.json'), false, name);
  }
});

test('--owner-go with --owner-approved-head or --owner-approved-items is a usage error (exit 2)', (t) => {
  const s = goScenario();
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  for (const args of [['--owner-approved-head', s.head], ['--owner-approved-items', 'none'], ...[approvalFlags(s.head, 'none')]]) {
    const r = goMerge(s, args);
    assertExit(r, 2, args.join(' '));
    assert.match(`${r.stderr}${r.stdout}`, /--owner-go takes no --owner-approved-head/, args.join(' '));
  }
  assert.deepEqual(s.mergeCalls(), []);
});

test('--owner-go with production configured: merges, records no prod-before and says so in a warning', (t) => {
  const s = goScenario({ yml: { production: true } });
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mode, 'owner-go');
  assert.equal('prodBefore' in r.json, false);
  assert.match((r.json.warnings ?? []).join('\n'), /no prod-before/);
  assert.equal(s.fake.lines().some((l) => /prod-before/.test(l)), false);
});

// Fable attacker pass: the agent writes `items none` itself, so a diff with an owner item (or a blocking hard-stop) never takes
// the owner-go route, whatever the owner's record says: it needs the gated route bound to the gate's ownerItems digest.
test('--owner-go refuses a diff with a hard-stop: owner-merge item (chat) or blocking hit (label mode)', (t) => {
  for (const yml of [chatYml(), hardStopYml()]) {
    const s = scenario({ yml: yml.replace('{pr} {sha}', '{pr} --match-head-commit {sha}'), report: null, state: null });
    ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
    const r = goMerge(s);
    assertExit(r, 1);
    assert.equal(r.json.error, 'live-check');
    assert.match(r.json.reasons.join('\n'), /hardstops|owner-items: 1 owner item/);
    assert.deepEqual(s.mergeCalls(), []);
  }
});
