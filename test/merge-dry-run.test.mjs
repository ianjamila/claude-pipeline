// F2: `pipeline merge --pr N --dry-run [--owner-go]` through the real CLI against the scripted fake gh. The verdict of a real `P merge` without
// anything that writes or merges: the fake gh records ZERO write calls, `.review` and `git for-each-ref` are unchanged, and a git
// subprocess spy (fixtures/git-spy-preload.mjs) sees no fetch / update-ref / checkout / worktree / push. The real merge is covered by the
// other merge tests; this file only asserts the dry run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertExit } from './helpers/assert-exit.mjs';
import { GIT_WRITES, gitCalls, gitSpyEnv } from './helpers/git-spy.mjs';
import { cli, ghEntries, PR, ymlFor } from './helpers/gate-env.mjs';
import { RUN, ciRow, setup, ymlWith } from './helpers/ci-proof-env.mjs';
import { ciEntries, okGate } from './helpers/ci-proof-merge-env.mjs';
import { scenario } from './helpers/gate-env.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { treeFingerprint } from '../pipeline/lib/git.mjs';
import { verifyReportCheck } from '../pipeline/lib/finalgate.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'cp-dryrun-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

const b64 = (text) => Buffer.from(text).toString('base64');
const contents = (sha, text) => ({ match: `repos/acme/widgets/contents/\\.claude/pipeline\\.yml\\?ref=${sha}`, stdoutJson: ['file', 'base64', b64(text)] });

// What GitHub says about the PR for the dry run: the same reply as ghEntries gives, plus baseRefOid (only a readOnly gate asks for it).
const prReply = (s, o = {}) => ({
  state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: (o.labels ?? []).map((name) => ({ name })), mergeable: 'MERGEABLE',
  mergeStateStatus: o.merge ?? 'CLEAN', baseRefOid: o.baseRefOid ?? s.baseTip ?? 'b'.repeat(40),
});
const script = (s, o = {}) => [
  ...(o.before ?? []),
  { match: '^pr view 12 --json state,headRefOid.*baseRefOid', stdoutJson: prReply(s, o) },
  ...ghEntries({ prHead: s.head, prFiles: s.prFiles, mergeStateStatus: o.merge ?? 'CLEAN', labels: o.labels, behindBy: o.behindBy, ...o.gh }),
];

// Every .review file with its bytes: a dry run changes none.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = readFileSync(p, 'utf8');
    }
  };
  walk(join(dir, '.review'));
  return out;
}

// Runs the dry run with the git spy on. -> { r, git: [git subcommands the CLI started], writes: [gh calls that write or merge] }
function dry(s, args = [], env = {}) {
  const log = join(scratch, `git-${n += 1}.jsonl`);
  const seen = s.fake.calls().length;
  const r = cli(['merge', '--pr', String(PR), '--dry-run', ...args], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...gitSpyEnv(log), ...env } });
  const calls = s.fake.calls().slice(seen).map((c) => c.argv.join(' '));
  const writes = calls.filter((l) => /(^| )-X (POST|PATCH|PUT|DELETE)\b/.test(l) || /^pr (merge|edit|ready|close|comment|review)\b/.test(l) || /update-branch/.test(l) || /^(issue|label) (create|edit|close|comment)/.test(l));
  return { r, git: gitCalls(log), writes, calls };
}
const kinds = (r) => r.json.blockers.map((b) => b.kind);
const noGitWrites = (d) => assert.deepEqual(d.git.filter((c) => GIT_WRITES.test(c)), [], `git state changed: ${d.git.join(' | ')}`);

// ---- the read-only contract ----------------------------------------------------------------------------------------------------

test('dry run, clean PR: wouldMerge, exit 0, ZERO write calls to gh, nothing under .review changed, no git write, refs identical', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  // A crashed save's tmp file, over an hour old: a real run's loadState deletes it, a dry run must leave it (it writes and deletes nothing).
  const strayTmp = join(s.repo.dir, '.review', 'state.json.4242.deadbeef.tmp');
  writeFileSync(strayTmp, '{}');
  const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(strayTmp, aged, aged);
  const before = { review: snapshot(s.repo.dir), refs: s.repo.git(['for-each-ref']), calls: s.fake.calls().length };
  const d = dry(s);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.deepEqual([d.r.json.ok, d.r.json.dryRun, d.r.json.wouldMerge, d.r.json.blockers], [true, true, true, []]);
  assert.equal(d.r.json.ownerStep, null, 'a low-risk review: P merges by itself');
  assert.deepEqual(d.writes, [], 'no update-branch, comment, label or merge call');
  assert.deepEqual(snapshot(s.repo.dir), before.review);
  assert.ok(existsSync(strayTmp), 'the aged stray tmp file survives a dry run');
  assert.equal(s.repo.git(['for-each-ref']), before.refs);
  assert.deepEqual(s.mergeCalls(), [], 'the merge command never ran');
  noGitWrites(d);
  assert.ok(d.git.length > 0, 'the spy is live (it saw the read-only git calls)');
  assert.ok(!d.calls.some((l) => /update-branch|pr merge/.test(l)));
});

test('dry run with a deferred-CI config reads the base settings from the contents API at baseRefOid: no fetch, refs untouched', () => {
  const s = setup({ report: ciRow });
  const entries = (o) => [...ciEntries(s, [{ id: 101, number: 5 }]), contents(s.baseTip, ymlWith()), ...script(s, o)];
  s.fake.setScript(entries());
  okGate(s);
  const refs = s.repo.git(['for-each-ref']);
  const d = dry(s);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.equal(d.r.json.wouldMerge, true, JSON.stringify(d.r.json.blockers));
  assert.ok(d.calls.some((l) => l.includes(`contents/.claude/pipeline.yml?ref=${s.baseTip}`)), d.calls.join('\n'));
  assert.ok(d.git.some((c) => c.startsWith(`cat-file -e ${s.baseTip}`)), 'the base commit was checked locally');
  assert.deepEqual(d.writes, []);
  noGitWrites(d);
  assert.equal(s.repo.git(['for-each-ref']), refs);
});

test('dry run, deferred-CI config and the contents API cannot be read: blocker proof-settings-unverified (never a silent pass)', () => {
  const s = setup({ report: ciRow });
  s.fake.setScript([...ciEntries(s, [{ id: 101, number: 5 }]), contents(s.baseTip, ymlWith()), ...script(s)]);
  okGate(s);
  s.fake.setScript([
    ...ciEntries(s, [{ id: 101, number: 5 }]),
    { match: 'contents/\\.claude/pipeline\\.yml', code: 1, stderr: 'gh: Not Found (HTTP 404)' },
    ...script(s),
  ]);
  const d = dry(s);
  assertExit(d.r, 1, `${d.r.stderr}${d.r.stdout}`);
  assert.equal(d.r.json.wouldMerge, false);
  assert.ok(kinds(d.r).includes('proof-settings-unverified'), JSON.stringify(d.r.json.blockers));
  assert.match(d.r.json.blockers.find((b) => b.kind === 'proof-settings-unverified').detail, /proof-settings-unverified: could not read/);
  noGitWrites(d);
});

test('dry run: a local origin/main that is BEHIND the PR\'s baseRefOid is not used - the protected-input scan reads the settings at baseRefOid', () => {
  const s = setup({ report: ciRow });
  s.fake.setScript([...ciEntries(s, [{ id: 101, number: 5 }]), contents(s.baseTip, ymlWith()), ...script(s)]);
  okGate(s);
  // main moves on (one commit, present locally); origin/main in this clone stays where it was: stale
  s.repo.checkout('main');
  s.repo.write('docs/moved.md', '# moved\n');
  const moved = s.repo.commit('main moves on');
  s.repo.checkout('agent/feature');
  assert.equal(s.repo.git(['rev-parse', 'origin/main']).trim(), s.baseTip, 'the remote-tracking ref is stale');
  // the base AT baseRefOid declares src/** an input of the CI proof; the stale origin/main (ymlWith()) does not
  s.fake.setScript([...ciEntries(s, [{ id: 101, number: 5 }]), contents(moved, ymlWith({ inputs: ['src/**'] })), ...script(s, { baseRefOid: moved })]);
  const refs = s.repo.git(['for-each-ref']);
  const d = dry(s);
  assertExit(d.r, 1, `${d.r.stderr}${d.r.stdout}`);
  assert.match(d.r.json.blockers.map((b) => b.detail).join('\n'), /this PR changes src\/app\.js, an input of the CI proof/);
  assert.ok(d.calls.some((l) => l.includes(`ref=${moved}`)), 'the settings were read at baseRefOid');
  assert.ok(!d.calls.some((l) => l.includes(`ref=${s.baseTip}`)), 'never at the stale local ref');
  noGitWrites(d);
  assert.equal(s.repo.git(['for-each-ref']), refs);
});

test('readOnly verifyReportCheck: the proof check gets base {ref, sha} = baseRefOid, never the stale local origin/<base>', async () => {
  const s = setup({ report: ciRow });
  s.repo.checkout('main');
  s.repo.write('docs/moved.md', '# moved\n');
  const moved = s.repo.commit('main moves on');
  s.repo.checkout('agent/feature');
  const { config } = await loadConfig(s.repo.dir);
  const gh = { repo: () => ({ slug: 'acme/widgets' }), apiText: () => JSON.stringify(['file', 'base64', b64(ymlWith())]) };
  const calls = [];
  const refs = s.repo.git(['for-each-ref']);
  const c = await verifyReportCheck({
    root: s.repo.dir, config, head: s.head, tree: treeFingerprint({ cwd: s.repo.dir }), o: { cwd: s.repo.dir }, pr: PR, gh, env: {}, proofs: [],
    ciProof: async (a) => { calls.push(a); return { state: 'pass', reason: 'ok', run: RUN }; }, readOnly: true, baseSha: moved,
  });
  assert.equal(c.ok, true, c.detail);
  assert.deepEqual(calls[0].base, { ref: 'main', sha: moved });
  assert.equal(s.repo.git(['for-each-ref']), refs);
});

test('dry run: the PR\'s baseRefOid is not in this repository -> proof-settings-unverified (no fetch to get it)', () => {
  const s = setup({ report: ciRow });
  s.fake.setScript([...ciEntries(s, [{ id: 101, number: 5 }]), contents(s.baseTip, ymlWith()), ...script(s)]);
  okGate(s);
  const missing = 'e'.repeat(40);
  s.fake.setScript([...ciEntries(s, [{ id: 101, number: 5 }]), contents(missing, ymlWith()), ...script(s, { baseRefOid: missing })]);
  const d = dry(s);
  assertExit(d.r, 1, `${d.r.stderr}${d.r.stdout}`);
  assert.match(d.r.json.blockers.find((b) => b.kind === 'proof-settings-unverified').detail, /is not in this repository/);
  assert.ok(!d.calls.some((l) => l.includes('contents/')), 'it did not even ask GitHub for a commit it cannot diff against');
  noGitWrites(d);
});

// ---- behind-ness, read-only ----------------------------------------------------------------------------------------------------

test('dry run: mergeStateStatus BEHIND, or a clean state whose compare shows the head lacks the base tip -> behind-base, and the branch is never updated', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  for (const o of [{ merge: 'BEHIND' }, { merge: 'CLEAN', behindBy: 2 }]) {
    s.fake.setScript(script(s, o));
    const d = dry(s);
    assertExit(d.r, 1, JSON.stringify(o));
    assert.ok(kinds(d.r).includes('behind-base'), `${JSON.stringify(o)}: ${JSON.stringify(d.r.json.blockers)}`);
    assert.equal(d.r.json.wouldMerge, false);
    assert.deepEqual(d.writes, [], 'no update-branch call');
    assert.ok(!d.calls.some((l) => /update-branch/.test(l)));
  }
});

test('dry run: mergeStateStatus UNKNOWN, DIRTY or a compare error is behind-base-unverified (DIRTY also conflicts), never "not behind"', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  for (const [label, o] of [
    ['UNKNOWN', { merge: 'UNKNOWN' }],
    ['DIRTY', { merge: 'DIRTY' }],
    ['compare error', { merge: 'CLEAN', before: [{ match: 'repos/acme/widgets/compare/', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] }],
  ]) {
    s.fake.setScript(script(s, o));
    const d = dry(s);
    assertExit(d.r, 1, label);
    assert.ok(kinds(d.r).includes('behind-base-unverified'), `${label}: ${JSON.stringify(d.r.json.blockers)}`);
    assert.equal(kinds(d.r).includes('conflicts'), label === 'DIRTY', label);
    assert.deepEqual(d.writes, [], label);
  }
});

test('dry run collects every blocker: a failed live check AND a branch behind its base are both listed', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  s.fake.setScript(script(s, { merge: 'BEHIND', labels: ['needs-human'] }));
  const d = dry(s);
  assertExit(d.r, 1);
  assert.ok(kinds(d.r).includes('live-check') && kinds(d.r).includes('behind-base'), JSON.stringify(d.r.json.blockers));
  assert.match(d.r.json.blockers.filter((b) => b.kind === 'live-check').map((b) => b.detail).join('\n'), /labels: blocking label/);
  assert.deepEqual(d.writes, []);
});

test('dry run with no final-gate.json: blocker gate, and the live checks are still collected', () => {
  const s = setup({});
  s.fake.setScript(script(s, { merge: 'BEHIND' }));
  const d = dry(s);
  assertExit(d.r, 1);
  assert.ok(kinds(d.r).includes('gate') && kinds(d.r).includes('behind-base'), JSON.stringify(d.r.json.blockers));
});

// ---- the owner step -------------------------------------------------------------------------------------------------------------

const chatYml = () => `${ymlFor()}hard_stops:\n  paths: ['src/**']\nowner_approval: chat\n`;
const hardStopYml = () => `${ymlFor()}hard_stops:\n  paths: ['src/**']\n`;

test('dry run, ownerMerge > 0 under owner_approval: chat -> ownerStep owner-runs with the filled merge command and NO request line', () => {
  const s = scenario({ yml: chatYml(), gh: { mergeStateStatus: 'CLEAN' } });
  s.fake.setScript(script(s));
  const g = s.gate();
  assertExit(g, 0, `${g.stderr}${g.stdout}`);
  assert.ok(g.json.ownerMerge > 0);
  const d = dry(s);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.equal(d.r.json.wouldMerge, true);
  assert.deepEqual(d.r.json.ownerStep, { kind: 'owner-runs', command: `node scripts/fake-merge.mjs ${PR} ${s.head}` });
  assert.ok(!JSON.stringify(d.r.json).includes('Ready to merge'), 'no request line');
  assert.deepEqual(d.writes, []);
});

test('dry run, clean PR with no owner item that is not a low-risk review -> ownerStep say-merge with the exact Head line', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  const file = join(s.repo.dir, '.review', 'state.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), risk: 'high' }));
  const d = dry(s);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.deepEqual(d.r.json.ownerStep, { kind: 'say-merge', line: `Head ${s.head.slice(0, 12)} · items none · repo acme/widgets` });
});

test('dry run, a resumed run record -> ownerStep owner-approval-flags (reported, not refused)', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  const record = {
    v: 1, repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', step: 'gate', outcome: null, next: '', detail: '', head: null,
    request: '', tasks: [], verify: null, round: 0, mergeSha: null, inFlight: null, heartbeat: null, agentLogLine: null, cliVersion: null, history: [],
    resumed: { at: '2026-10-12T08:00:00.000Z', host: 'pc-2', head: 'a'.repeat(40) },
  };
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (num, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record });
  s.fake.setScript(script(s, { gh: { comments: [{ id: 77, user: { login: 'me' }, body }] } }));
  const d = dry(s);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.equal(d.r.json.ownerStep.kind, 'owner-approval-flags');
  assert.deepEqual(d.writes, []);
});

// ---- --owner-go ------------------------------------------------------------------------------------------------------------------

test('dry run --owner-go: the owner-go route preconditions are checked live, the Head line is reported, the owner record is not required', () => {
  const s = scenario({ report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });
  s.fake.setScript(script(s));
  const before = s.repo.git(['for-each-ref']);
  const d = dry(s, ['--owner-go']);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.deepEqual([d.r.json.wouldMerge, d.r.json.mode], [true, 'owner-go']);
  assert.deepEqual(d.r.json.ownerStep, { kind: 'say-merge', line: `Head ${s.head.slice(0, 12)} · items none · repo acme/widgets` });
  assert.deepEqual(d.writes, []);
  assert.deepEqual(s.mergeCalls(), []);
  noGitWrites(d);
  assert.equal(s.repo.git(['for-each-ref']), before);

  // a blocking label and a failing required check are blockers on that route too
  s.fake.setScript(script(s, { labels: ['needs-human'], gh: { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] } }));
  const bad = dry(s, ['--owner-go']);
  assertExit(bad.r, 1);
  assert.match(bad.r.json.blockers.map((b) => b.detail).join('\n'), /labels: blocking label[\s\S]*ci: /);
});

test('dry run --owner-go: a baseRefOid that is not a full sha is its own blocker (the base re-read cannot be skipped), besides scan-range', () => {
  const s = scenario({ report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });
  s.fake.setScript(script(s, { baseRefOid: 'nothex' }));
  const d = dry(s, ['--owner-go']);
  assertExit(d.r, 1);
  assert.equal(d.r.json.wouldMerge, false);
  assert.match(d.r.json.blockers.map((b) => b.detail).join('\n'), /did not name the PR's base commit as a full 40-character sha \(baseRefOid is null\)/);
  assert.deepEqual(d.writes, []);
});

test('dry run --owner-go, chat mode, a protected diff -> say-merge with the LIVE items digest and the Areas line; nothing is written', async () => {
  const s = scenario({ yml: chatYml(), report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });
  s.fake.setScript(script(s));
  const before = s.repo.git(['for-each-ref']);
  const d = dry(s, ['--owner-go']);
  assertExit(d.r, 0, `${d.r.stderr}${d.r.stdout}`);
  assert.equal(d.r.json.wouldMerge, true, JSON.stringify(d.r.json.blockers));
  const { ownerStep } = d.r.json;
  assert.equal(ownerStep.kind, 'say-merge');
  assert.match(ownerStep.line, new RegExp(`^Head ${s.head.slice(0, 12)} · items [0-9a-f]{12} · repo acme/widgets$`));
  assert.doesNotMatch(ownerStep.line, /items none/);
  assert.equal(ownerStep.areaIds.length, 1);
  assert.equal(ownerStep.areas, `Areas ${ownerStep.areaIds.join(' ')}`);
  assert.deepEqual(d.writes, []);
  assert.deepEqual(s.mergeCalls(), []);
  noGitWrites(d);
  assert.equal(s.repo.git(['for-each-ref']), before);
});

test('dry run --owner-go, label mode, a blocking hard-stop -> blocker owner-items and ownerStep owner-runs', () => {
  const s = scenario({ yml: hardStopYml(), report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });
  s.fake.setScript(script(s));
  const d = dry(s, ['--owner-go']);
  assertExit(d.r, 1);
  assert.match(d.r.json.blockers.map((b) => b.detail).join('\n'), /owner-items:/);
  assert.equal(d.r.json.ownerStep.kind, 'owner-runs');
});

// ---- usage and availability --------------------------------------------------------------------------------------------------

test('--dry-run with --owner-approved-head / --owner-approved-items is a usage error (exit 2); nothing is called', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  for (const extra of [['--owner-approved-head', s.head], ['--owner-approved-items', 'none']]) {
    const d = dry(s, extra);
    assertExit(d.r, 2, `${d.r.stderr}${d.r.stdout}`);
    assert.match(`${d.r.stderr}${d.r.stdout}`, /--dry-run takes no --owner-approved-head/);
    assert.deepEqual(d.calls.filter((l) => /^pr (view|merge)/.test(l)), []);
  }
});

test('dry run, GitHub unavailable -> exit 3', () => {
  const s = setup({});
  s.fake.setScript(script(s));
  assertExit(s.gate(), 0);
  s.fake.setScript([{ match: '^pr view', code: 1, stderr: 'gh: Server Error (HTTP 502)' }, ...script(s)]);
  const d = dry(s);
  assertExit(d.r, 3, `${d.r.stderr}${d.r.stdout}`);
});
