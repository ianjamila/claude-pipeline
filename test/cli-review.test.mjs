// End-to-end tests for the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// They spawn the real CLI against a real throwaway git repo, a scripted fake gh and a scripted fake codex, because the
// contract the ship skill depends on is the pair (stdout JSON, exit code) plus the .review/ files left behind.
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { contentHash } from '../pipeline/lib/git.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { currentContentHash, excerptWindow, reviewBaseRef } from '../pipeline/lib/review-context.mjs';
import { MARKERS, triageComment } from '../pipeline/lib/render.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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
const findingsOf = (blocking = [], suggestions = [], worth = []) => ({
  summary: 'Reviewed.', blocking, suggestions, worth_considering: worth,
});
// B1 + S1 + S2 + W1: the set most tests triage.
const standardFindings = () => findingsOf(
  [finding()],
  [finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability' }), finding({ title: 'Extract constant', file: 'src/b.js', line: 5, category: 'design' })],
  [finding({ title: 'Consider caching', file: 'src/a.js', line: 20, category: 'performance', testable: false })],
);

// What `followups create` asks before it files anything: who we are and which issues of ours exist (none).
const NO_ISSUES = [
  { match: '^api user', stdout: 'me\n' },
  { match: '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=30 --paginate', stdout: '[]' },
];

const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
];

function transcript({ prompt, text, model = 'claude-fable-5-1', effort = 'high' }) {
  const lines = [
    { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: prompt }, uuid: 'u-1', timestamp: '2026-10-01T09:00:00.000Z' },
    {
      type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', effort, perTurnEffort: effort,
      message: { model, id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
      uuid: 'a-1', timestamp: '2026-10-01T09:00:06.000Z',
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
// `triage settle` runs the proving test itself: commit a tiny test file that exits with `code` (bug-disproved passes, bug-confirmed
// fails by default) and return the CLI args that run it.
function settleArgs(w, id, result, { code = result === 'bug-confirmed' ? 1 : 0, file = 'src/proof.test.js', cmd, output = 'proof output' } = {}) {
  w.repo.write(file, `console.log(${JSON.stringify(output)});\nprocess.exit(${code});\n`);
  w.repo.git(['add', '-A']);
  if (w.repo.git(['status', '--porcelain=v1', '--', file]).trim() !== '') w.repo.git(['commit', '-q', '-m', `proof for ${id}`]);
  return ['triage', 'settle', '--id', id, '--result', result, '--test-cmd', cmd ?? `node ${file}`, '--test-file', file];
}
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

// ---- a world: repo on a feature branch, scratch dir, fake gh, fake codex ---------------------

// By default the feature commit is big enough (>= 50 changed lines) to be off the light lane, so the arbiter rules apply in
// full; `light: true` keeps the change tiny.
function world(t, { gh = GH, light = false, yml = pipelineYml() } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  // As pipeline-setup leaves a real repo: the review's own files are never part of a commit (a fix commit would
  // otherwise carry .review/ and look like a big, medium-risk change).
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  if (!light) repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-review-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // The PR as GitHub reports it: its base branch and the head commit it holds (what review-complete compares to).
  const withPr = (sha) => gh.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: sha, ...e.stdoutJson } } : e));
  const fake = createFakeGh(withPr(head));
  const capture = join(scratch, 'codex-capture.jsonl');
  const lockDir = join(scratch, 'locks');

  const w = {
    repo, base, head, scratch, fake, capture, lockDir,
    // Tell the fake GitHub the PR's head moved (after a new commit).
    prHead: (sha) => fake.setScript(withPr(sha)),
    cli(args, env = {}) {
      const merged = {
        ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: capture,
        PIPELINE_LOCK_DIR: lockDir, ...env,
      };
      for (const k of [
        'PIPELINE_TEST_FORCE_ARBITER', 'PIPELINE_ARBITER_MODEL_OVERRIDE', 'PIPELINE_TEST_MODE', 'PIPELINE_CODEX_TIMEOUT_MS',
        'PIPELINE_LOCK_WAIT_MS', 'FAKE_CODEX_EXIT', 'FAKE_CODEX_STDERR', 'FAKE_CODEX_NO_WRITE', 'FAKE_CODEX_OUTPUT',
        'FAKE_CODEX_HANG', 'FAKE_CODEX_DURING', 'FAKE_CODEX_DURING_OUTPUT',
      ]) {
        if (!(k in env)) delete merged[k];
      }
      // TEST_BIN: run another copy of the CLI (an installed one) instead of the checkout.
      const useBin = merged.TEST_BIN ?? bin;
      delete merged.TEST_BIN;
      const r = spawnSync(process.execPath, [useBin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null: the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    codex(round, findings, { from = base, to = head, env = {}, extra = [] } = {}) {
      const out = w.file(`findings-${round}.json`, findings);
      return w.cli(
        ['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high', ...extra],
        { FAKE_CODEX_OUTPUT: out, ...env },
      );
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    stateText: () => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8'),
    item: (id) => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === id),
    roundFile: (n, name) => join(repo.dir, '.review', `round-${n}`, name),
    captured: () => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    // Judge answer for round n; `decisions` maps id -> [decision, confidence, extra].
    judge(n, decisions) {
      const items = Object.entries(decisions).map(([id, [decision, confidence = 'high', extra = {}]]) => ({
        id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' }, ...extra,
      }));
      return w.cli(['triage', 'validate', '--round', String(n), '--file', w.file(`judge-${n}.json`, { items })]);
    },
  };
  return w;
}

// <tmp>/p/<encoded-cwd>/<session>/subagents/agent-<id>.{jsonl,meta.json}: the layout Claude Code writes.
function installTranscript(w, { jsonl, meta, agentId = 'a1' }) {
  const root = join(w.scratch, `projects-${agentId}-${Math.random().toString(36).slice(2, 8)}`);
  const dir = join(root, '-tmp-work', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), jsonl);
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, ...meta }));
  return root;
}

// ---- review-context ---------------------------------------------------------------------------

test('excerptWindow: +/-20 lines around a line, clamped; line 0 means the whole file (or its head for display)', () => {
  const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const mid = excerptWindow(text, 50);
  assert.deepEqual([mid.start, mid.end, mid.lines.length], [30, 70, 41]);
  assert.deepEqual([excerptWindow(text, 3).start, excerptWindow(text, 3).end], [1, 23]);
  assert.equal(excerptWindow(text, 100).end, 100);
  assert.equal(excerptWindow(text, 0).lines.length, 100);
  assert.equal(excerptWindow(text, 0, { maxLines: 41 }).lines.length, 41);
  assert.equal(excerptWindow(text, 500), null, 'a line past the end of the file has no excerpt');
  assert.equal(excerptWindow(null, 5), null);
  assert.equal(excerptWindow('', 5), null);
});

test('currentContentHash: hashes against origin/<default> when that ref exists, else the local default branch', async (t) => {
  const w = world(t);
  const { config } = await loadConfig(w.repo.dir);
  assert.equal(reviewBaseRef(w.repo.dir, config), 'main');
  const local = currentContentHash(w.repo.dir, config);
  assert.equal(local, contentHash('main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));

  // origin/main one commit behind the base the branch forked from: the hash must now include that extra commit.
  w.repo.checkout('main');
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const ahead = w.repo.commit('main moves on');
  w.repo.checkout('feat/x');
  w.repo.git(['rebase', '-q', 'main']);
  w.repo.git(['update-ref', 'refs/remotes/origin/main', w.base]);
  assert.equal(reviewBaseRef(w.repo.dir, config), 'origin/main');
  const viaOrigin = currentContentHash(w.repo.dir, config);
  assert.equal(viaOrigin, contentHash('origin/main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));
  assert.notEqual(viaOrigin, contentHash('main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));
  assert.ok(ahead);
});

// ---- codex-review -----------------------------------------------------------------------------

test('codex-review: a valid findings file becomes round 1 with ids, state, codex.json and codex.md', async (t) => {
  const w = world(t);
  const r = w.codex(1, standardFindings());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.round, 1);
  assert.deepEqual(r.json.counts, { blocking: 1, suggestions: 2, worth_considering: 1 });
  assert.equal(r.json.preRuled, 0);
  assert.equal(r.json.lightLane, false, 'a 60+ line change is off the light lane');
  assert.equal(r.json.path, join(w.repo.dir, '.review', 'round-1'));

  const state = w.state();
  assert.deepEqual([state.pr, state.repo, state.branch, state.risk, state.lightLane, state.maxRounds], [7, 'acme/widgets', 'feat/x', 'low', false, 2]);
  assert.equal(r.json.reviewer, 'judge', 'a low-risk PR with no sensitive path is triaged by the judge');
  assert.equal(state.reviewer, 'judge');
  assert.deepEqual([state.rounds[0].fableRequired, state.rounds[0].codexModel, state.rounds[0].forkPoint], [undefined, 'gpt-6-astra', w.base]);
  const round = state.rounds[0];
  assert.deepEqual([round.n, round.fromHead, round.toHead], [1, w.base, w.head]);
  assert.equal(round.contentHashAtToHead, contentHash('main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));
  assert.deepEqual(round.items.map((i) => i.id), ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
  assert.ok(round.items.every((i) => /^[0-9a-f]{40}$/.test(i.fingerprint) && !i.final));

  const codexJson = JSON.parse(readFileSync(w.roundFile(1, 'codex.json'), 'utf8'));
  assert.equal(codexJson.findings.blocking[0].title, 'Missing null check');
  assert.equal(codexJson.items.length, 4);
  const md = readFileSync(w.roundFile(1, 'codex.md'), 'utf8');
  assert.match(md, /# Codex review — round 1/);
  assert.match(md, /R1-B1/);
  const patch = readFileSync(w.roundFile(1, 'diff.patch'), 'utf8');
  assert.match(patch, /\+export const v12 = compute\(x\.y\);/);
  assert.ok(existsSync(w.roundFile(1, 'codex-raw.json')));

  // Codex was invoked read-only on the repo, with the schema, the pinned model/effort, and the prompt on stdin.
  const [call] = w.captured();
  const at = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(call.argv[0], 'exec');
  assert.equal(at('-o'), w.roundFile(1, 'codex-raw.json'));
  assert.equal(at('-C'), w.repo.dir);
  assert.match(at('--output-schema'), /codex-findings\.schema\.json$/);
  assert.ok(call.argv.includes('model="gpt-6-astra"') && call.argv.includes('model_reasoning_effort="high"'));
  assert.equal(call.argv.at(-1), '-');
  assert.match(call.stdin, /PR: #7/);
  assert.match(call.stdin, /Title: Add compute/);
  assert.match(call.stdin, new RegExp(`git diff ${w.base}\\.\\.${w.head}`));
  assert.match(call.stdin, /Review round: 1/);
  assert.match(call.stdin, /Risk level: low/);
  assert.doesNotMatch(call.stdin, /Prior rulings/);
});

test('codex-review: a large binary document in the range is left out of diff.patch and named in it and in the prompt', (t) => {
  const w = world(t, { light: true });
  const { repo } = w;
  // the sheet lands on main first, so this PR (merged with main) DELETES it, as the 234 MB spreadsheet PR did
  repo.checkout('main');
  repo.write('data/old.xlsx', randomBytes(5 * 1024 * 1024));
  const fork = repo.commit('the sheet lands on main');
  repo.checkout('feat/x');
  repo.git(['merge', '-q', '--no-edit', 'main']);
  repo.rm('data/old.xlsx');
  const head = repo.commit('drop the sheet');
  w.prHead(head);

  const r = w.codex(1, findingsOf(), { from: fork, to: head });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([w.state().rounds[0].fromHead, w.state().rounds[0].toHead], [fork, head]);
  const patch = readFileSync(w.roundFile(1, 'diff.patch'), 'utf8');
  assert.ok(patch.length < 20_000, `diff.patch is ${patch.length} bytes`);
  assert.match(patch, /\+export const v12 = compute\(x\.y\);/, 'the rest of the diff is there');
  assert.doesNotMatch(patch, /GIT binary patch/);
  const note = 'data/old.xlsx — large binary (5.0 MiB), deleted, content not shown';
  assert.ok(patch.includes(note), 'the patch names the skipped file');
  const [call] = w.captured();
  assert.match(call.stdin, /## Large binary files/);
  assert.ok(call.stdin.includes(`- ${note}`), 'and so does the prompt');
  assert.equal(w.state().rounds[0].contentHashAtToHead, contentHash('main', 'HEAD', { cwd: repo.dir, exclude: ['docs/agent-log.md'] }));
});

test('codex-review: --model overrides the configured model; a bad effort or model is a usage error before anything runs', (t) => {
  const w = world(t);
  const ok = w.codex(1, findingsOf(), { extra: ['--model', 'gpt-test-1'] });
  assertExit(ok, 0);
  assert.ok(w.captured()[0].argv.includes('model="gpt-test-1"'));
  assert.equal(w.state().rounds[0].items.length, 0, 'an empty review is a valid round with no items');

  const w2 = world(t);
  const badEffort = w2.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w2.base, '--head', w2.head, '--effort', 'ultra']);
  assertExit(badEffort, 2);
  const badModel = w2.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w2.base, '--head', w2.head, '--effort', 'high', '--model', 'x"; rm']);
  assertExit(badModel, 2);
  assert.equal(w2.captured().length, 0);
  assert.ok(!existsSync(join(w2.repo.dir, '.review', 'state.json')));
});

test('codex-review: quota, auth and a missing binary are exit 3 with unavailable:true and a reason; no state is written', (t) => {
  const w = world(t);
  const quota = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'ERROR: You hit your usage limit. Try again later.' } });
  assertExit(quota, 3);
  assert.equal(quota.json.ok, false);
  assert.equal(quota.json.unavailable, true);
  assert.equal(quota.json.reason, 'quota');
  assert.match(quota.json.detail, /usage limit/);

  const auth = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'Not logged in. Run codex login.' } });
  assertExit(auth, 3);
  assert.equal(auth.json.reason, 'auth');

  const other = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '2', FAKE_CODEX_STDERR: 'segfault' } });
  assertExit(other, 3);
  assert.equal(other.json.reason, 'error');

  const missing = w.cli(
    ['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'],
    { PIPELINE_CODEX: join(w.scratch, 'no-such-codex-binary') },
  );
  assertExit(missing, 3);
  assert.equal(missing.json.unavailable, true);
  assert.equal(missing.json.reason, 'unavailable');

  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')), 'a failed Codex run must not leave a round behind');
});

test('codex-review: output that is not valid findings is exit 3 reason malformed, never "no findings"', (t) => {
  const w = world(t);
  const garbage = w.file('garbage.json', 'this is not json {');
  const a = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: garbage });
  assertExit(a, 3);
  assert.equal(a.json.unavailable, true);
  assert.equal(a.json.reason, 'malformed');

  const wrongShape = w.codex(1, { summary: 'ok', blocking: [{ title: 'x' }], suggestions: [], worth_considering: [] });
  assertExit(wrongShape, 3);
  assert.equal(wrongShape.json.reason, 'malformed');
  assert.ok(wrongShape.json.errors.length > 0);

  const missingKeys = w.codex(1, { summary: 'ok' });
  assertExit(missingKeys, 3);
  assert.equal(missingKeys.json.reason, 'malformed');
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')));
});

test('codex-review: a leftover raw file from an earlier run is never read as this run\'s answer', (t) => {
  const w = world(t);
  const stale = w.roundFile(1, 'codex-raw.json');
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, JSON.stringify(findingsOf([finding()])));
  const old = new Date(Date.now() - 3600e3);
  utimesSync(stale, old, old);
  const r = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_NO_WRITE: '1' });
  assertExit(r, 3);
  assert.equal(r.json.reason, 'malformed');
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')));
  assert.ok(!existsSync(stale), 'the stale file was removed before Codex ran');
});

test('codex-review: an answer Codex writes during the run is read even when its source bytes are old (fake writes fresh, not a Windows copy)', (t) => {
  // windows-latest flake: the fake copied a findings file written before a slow CLI start, CopyFileW kept that old
  // mtime, and the freshness check rejected the run as "codex output file predates this run".
  const w = world(t);
  const src = w.file('findings-old.json', findingsOf([finding()]));
  const old = new Date(Date.now() - 3600e3);
  utimesSync(src, old, old);
  const r = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: src });
  assertExit(r, 0);
});

test('codex-review: rounds must arrive in order; an existing round, a skipped round and another PR\'s state are exit 2', (t) => {
  const w = world(t);
  const skipped = w.codex(2, findingsOf());
  assertExit(skipped, 2);
  assert.equal(skipped.json.error, 'round-order');
  assert.equal(w.captured().length, 0, 'Codex is not even started');
  assert.ok(!existsSync(join(w.repo.dir, '.review')), 'a refused round leaves nothing behind');

  assertExit(w.codex(1, findingsOf()), 0);
  const again = w.codex(1, findingsOf());
  assertExit(again, 2);
  assert.match(again.json.message, /already exists/);
  assertExit(w.codex(3, findingsOf()), 2);
  assert.equal(w.captured().length, 1);

  const otherPr = w.cli(['codex-review', '--pr', '8', '--round', '2', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file('x.json', findingsOf()) });
  assertExit(otherPr, 2);
  assert.equal(otherPr.json.error, 'state-pr-mismatch');
});

test('codex-review: --head must be the checked-out HEAD (the content hash is of HEAD); a moved base ref resolves to full SHAs', (t) => {
  const w = world(t);
  const wrong = w.codex(1, findingsOf(), { to: w.base });
  assertExit(wrong, 2);
  assert.equal(wrong.json.error, 'head-mismatch');
  assert.equal(w.captured().length, 0);

  const short = w.codex(1, findingsOf(), { from: w.base.slice(0, 10), to: w.head.slice(0, 10) });
  assertExit(short, 0, short.stderr + short.stdout);
  assert.deepEqual([w.state().rounds[0].fromHead, w.state().rounds[0].toHead], [w.base, w.head]);
});

test('codex-review: GitHub being unreachable is exit 3 with unavailable:true, reason github', (t) => {
  const w = world(t, { gh: [{ match: '.', code: 1, stderr: 'HTTP 502' }] });
  const r = w.codex(1, findingsOf());
  assertExit(r, 3);
  assert.equal(r.json.unavailable, true);
  assert.equal(r.json.reason, 'github');
  assert.equal(w.captured().length, 0);
});

test('codex-review: rulings from earlier rounds go into the next prompt and pre-rule an unchanged finding (cache)', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, { ...STANDARD_JUDGE, 'R1-B1': ['REJECT', 'high', DISPUTED] }), 0, 'the judge disputes the bug and a test can decide');
  const settled = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved', { file: 'src/a.test.js', output: 'compute(undefined) returns 0' }));
  assertExit(settled, 0);

  // A second commit that leaves a.js (lines 1-32 around the finding) and b.js alone.
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const r = w.codex(2, findingsOf([finding(), finding({ title: 'A brand new problem', file: 'src/c.js', line: 1 })]), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.preRuled, 1);
  assert.deepEqual(r.json.counts, { blocking: 2, suggestions: 0, worth_considering: 0 });

  const prompt = w.captured()[1].stdin;
  assert.match(prompt, /## Prior rulings/);
  assert.match(prompt, /- R1-B1: Missing null check — REJECT: test disproved: src\/a\.test\.js \(exit 0\): compute\(undefined\) returns 0/);
  assert.match(prompt, /Review round: 2/);
  assert.match(prompt, new RegExp(`git diff ${w.head}\\.\\.${head2}`));

  const same = w.item('R2-B1');
  assert.equal(same.final.by, 'cache');
  assert.equal(same.final.decision, 'REJECT');
  assert.equal(w.item('R2-B2').final ?? null, null);
  assert.equal(w.state().rounds[1].toHead, head2);
});

// ---- review range across an update-branch (main merged into the PR branch) ---------------------

// Main moves on (a commit touching `files`), then the PR branch merges it in, the way "Update branch" does. A conflict
// is resolved with `resolve` (path -> content). `branch` merges another branch instead; `evil` is written into the merge
// commit itself (an "evil merge": changes that are in neither parent). -> the merge commit.
function mergeMainInto(w, files, { resolve = {}, branch = 'main', evil = {} } = {}) {
  w.repo.checkout(branch);
  for (const [file, content] of Object.entries(files)) w.repo.write(file, content);
  w.repo.commit('main moves on');
  w.repo.checkout('feat/x');
  try {
    w.repo.git(['merge', '--no-ff', ...(Object.keys(evil).length > 0 ? ['--no-commit'] : []), '-m', 'Merge main into feat/x', branch]);
    if (Object.keys(evil).length > 0) {
      for (const [file, content] of Object.entries(evil)) w.repo.write(file, content);
      w.repo.git(['add', '-A']);
      w.repo.git(['commit', '-q', '--no-edit']);
    }
  } catch (err) {
    if (Object.keys(resolve).length === 0) throw err;
    for (const [file, content] of Object.entries(resolve)) w.repo.write(file, content);
    w.repo.git(['add', '-A']);
    w.repo.git(['commit', '-q', '--no-edit']);
  }
  return w.repo.git(['rev-parse', 'HEAD']).trim();
}
// The real repo ignores .review/; the throwaway one commits everything with add -A, which would put round files into the diffs under test.
function worldIgnoringReview(t, opts) {
  const w = world(t, opts);
  writeFileSync(join(w.repo.dir, '.git', 'info', 'exclude'), '.review/\n');
  return w;
}
const patchOf = (w, n) => readFileSync(w.roundFile(n, 'diff.patch'), 'utf8');

test('codex-review: a round after no merge reviews previous toHead..head, recorded as the previous head', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  const round = w.state().rounds[1];
  assert.deepEqual([round.fromHead, round.reviewBase, round.reviewBaseKind], [w.head, w.head, 'previous']);
  assert.match(patchOf(w, 2), /src\/c\.js/);
  assert.doesNotMatch(patchOf(w, 2), /src\/a\.js/);
  assert.doesNotMatch(w.captured()[1].stdin, /merged in from the base branch/);
  assert.equal(w.state().rounds[0].reviewBase, w.base, 'round 1 is reviewed against the merge base');
});

test('codex-review: commits merged in from the base branch are not in the next round\'s diff, the prompt or the record', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  mergeMainInto(w, { 'src/from-main.js': 'export const other = "someone else\'s PR";\n' });
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('later pr commit');
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);

  const patch = patchOf(w, 2);
  assert.doesNotMatch(patch, /from-main\.js/, 'main\'s file is not shown to Codex');
  assert.match(patch, /src\/c\.js/, 'the PR\'s own later commit is');
  const round = w.state().rounds[1];
  assert.equal(round.reviewBaseKind, 'synthetic');
  assert.equal(round.fromHead, w.head);
  assert.equal(round.toHead, head2);
  assert.match(round.reviewBase, /^[0-9a-f]{40,64}$/);
  const prompt = w.captured()[1].stdin;
  assert.match(prompt, new RegExp(`git diff ${round.reviewBase}\\.\\.${head2}`));
  assert.match(prompt, /merged in from the base branch are excluded/);
});

test('codex-review: a round that only merged the base branch in is recorded as baseOnly and Codex is not run', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  const calls = w.captured().length;
  const r = w.codex(2, findingsOf([finding()]), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, true);
  assert.deepEqual(r.json.counts, { blocking: 0, suggestions: 0, worth_considering: 0 });
  assert.equal(w.captured().length, calls, 'the Codex stub was not called');
  const round = w.state().rounds[1];
  assert.deepEqual([round.n, round.baseOnly, round.items, round.toHead, round.reviewBaseKind], [2, true, [], merged, 'synthetic']);

  // Nothing pending and the content is what round 1 reviewed: the outcome treats it like a clean round.
  const outcome = w.cli(['state', 'outcome']);
  assertExit(outcome, 0);
  assert.equal(outcome.json.clean, true, JSON.stringify(outcome.json));
  assert.equal(outcome.json.coverageValid, true);
});

test('codex-review: a conflicting merge falls back to the whole PR against the new base, never main\'s own changes', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  // Main edits the very line (src/a.js 12) that round 1 reviewed the PR changing, so merging what was reviewed with the new
  // base conflicts; the real merge resolves it by hand.
  const mainA = aFile(false).replace('v12 = 12', 'v12 = 1200');
  const merged = mergeMainInto(w, { 'src/a.js': mainA, 'src/from-main.js': 'export const other = 1;\n' }, { resolve: { 'src/a.js': aFile(true) } });
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('later pr commit');
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  const round = w.state().rounds[1];
  assert.equal(round.reviewBaseKind, 'whole-pr');
  assert.equal(round.reviewBase, w.repo.git(['merge-base', 'main', head2]).trim());
  const patch = patchOf(w, 2);
  assert.doesNotMatch(patch, /from-main\.js/);
  assert.match(patch, /src\/a\.js/, 'the whole PR is reviewed');
  assert.match(patch, /src\/c\.js/);
  assert.ok(merged);
});

test('codex-review: a PR that targets a branch other than the default branch excludes nothing, and a merge-only round still runs Codex', (t) => {
  const gh = GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, baseRefName: 'release' } } : e));
  const w = worldIgnoringReview(t, { gh });
  w.repo.git(['branch', 'release', w.base]);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-release.js': 'export const x = 1;\n' }, { branch: 'release' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined);
  assert.equal(w.captured().length, 2, 'Codex ran');
  assert.match(patchOf(w, 2), /from-release\.js/, 'the author-chosen base branch\'s code is reviewed');
  assert.equal(w.state().rounds[1].reviewBaseKind, 'previous');
});

test('codex-review: code merged in from a branch other than the PR\'s base is reviewed (only the default branch is left out)', (t) => {
  const w = worldIgnoringReview(t);
  w.repo.git(['branch', 'side', w.base]);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-side.js': 'export const x = 1;\n' }, { branch: 'side' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined, 'not a base-only round');
  assert.equal(w.captured().length, 2, 'Codex ran');
  assert.match(patchOf(w, 2), /from-side\.js/);
});

test('codex-review: an evil merge (extra changes inside the merge commit) is in the diff, and is not a base-only round', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' }, { evil: { 'src/smuggled.js': 'export const evil = true;\n' } });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined);
  assert.equal(w.captured().length, 2, 'Codex ran');
  const patch = patchOf(w, 2);
  assert.match(patch, /smuggled\.js/, 'what the merge commit itself adds is reviewed');
  assert.doesNotMatch(patch, /from-main\.js/, 'what really came from main is not');
  assert.equal(w.state().rounds[1].reviewBaseKind, 'synthetic');
});

test('codex-review: a stale origin/<default> can only widen the reviewed range', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  // origin/main still points at the old fork point (no fetch could update it) although main was merged in.
  w.repo.git(['update-ref', 'refs/remotes/origin/main', w.base]);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(patchOf(w, 2), /from-main\.js/, 'the merged-in commits are not known to be main\'s, so they are shown');
  assert.equal(r.json.baseOnly, undefined);
});

test('codex-review: when the code around a ruled finding changed, the ruling is not reused', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT', 'high', DISPUTED] }), 0);
  assertExit(w.cli(settleArgs(w, 'R1-B1', 'bug-disproved')), 0);
  w.repo.write('src/a.js', aFile(true).replace('v13 = 13', 'v13 = 13 + 1'));
  const head2 = w.repo.commit('touch the excerpt');
  const r = w.codex(2, findingsOf([finding()]), { from: w.head, to: head2 });
  assertExit(r, 0);
  assert.equal(r.json.preRuled, 0, 'the excerpt changed, so the fingerprint differs and the item is reopened');
});

// ---- triage validate / settle / light-lane ----------------------------------------------------

const JUDGE_TAG = 'pipeline-judge R1 abcd1234';

function judgeTranscript(w, decisions, { model = 'claude-sonnet-5-5', effort = 'medium', agentType = 'judge' } = {}) {
  const items = Object.entries(decisions).map(([id, [decision, confidence = 'high']]) => ({
    id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' },
  }));
  return installTranscript(w, {
    jsonl: transcript({ prompt: 'Triage round 1.', text: fenced({ items }), model, effort }),
    meta: { agentType, description: JUDGE_TAG },
  });
}
const STANDARD_JUDGE = {
  'R1-B1': ['ACCEPT'], 'R1-S1': ['REJECT', 'high'], 'R1-S2': ['REJECT', 'low'], 'R1-W1': ['FOLLOW-UP'],
};

test('triage validate --from-tag: the judge JSON is read from the transcript and the decisions are applied', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const projects = judgeTranscript(w, STANDARD_JUDGE);
  const r = w.cli(['triage', 'validate', '--round', '1', '--from-tag', JUDGE_TAG, '--projects-dir', projects]);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.counts, { ACCEPT: 1, 'FOLLOW-UP': 1, REJECT: 2 });
  assert.equal(r.json.judgeProof.ok, true, JSON.stringify(r.json.judgeProof));
  assert.deepEqual(r.json.settled.sort(), ['R1-B1', 'R1-W1']);
  assert.deepEqual(r.json.unsettled.sort(), ['R1-S1', 'R1-S2'], 'dismissed SUGGESTIONs wait for the arbiter');

  assert.deepEqual(w.item('R1-B1').final, { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'judge: ACCEPT R1-B1' });
  assert.equal(w.item('R1-W1').final.decision, 'FOLLOW-UP');
  assert.equal(w.item('R1-S1').final ?? null, null);
  assert.equal(w.item('R1-S1').judge.decision, 'REJECT');
  assert.equal(w.item('R1-S2').judge.confidence, 'low');
  assert.ok(existsSync(w.roundFile(1, 'triage.json')));
});

test('triage validate: a judge transcript on the wrong model is only a recorded warning, the decisions still apply', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const projects = judgeTranscript(w, STANDARD_JUDGE, { model: 'claude-opus-5-5' });
  const r = w.cli(['triage', 'validate', '--round', '1', '--from-tag', JUDGE_TAG, '--projects-dir', projects]);
  assertExit(r, 0);
  assert.equal(r.json.judgeProof.ok, false);
  assert.ok(r.json.judgeProof.errors.some((e) => /unexpected model claude-opus-5-5/.test(e)));
  assert.equal(w.item('R1-B1').final.decision, 'ACCEPT');
});

test('triage validate: unknown, duplicate or missing ids are exit 1 with the errors and the state is untouched', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const before = w.stateText();
  const bad = w.judge(1, { 'R1-B1': ['ACCEPT'], 'R1-S1': ['REJECT'], 'R1-S2': ['REJECT'], 'R1-W9': ['ACCEPT'] });
  assertExit(bad, 1);
  assert.equal(bad.json.ok, false);
  assert.ok(bad.json.errors.includes('unknown id R1-W9'));
  assert.ok(bad.json.errors.includes('missing id R1-W1'));
  assert.equal(w.stateText(), before);
  assert.ok(!existsSync(w.roundFile(1, 'triage.json')));

  const notJson = w.cli(['triage', 'validate', '--round', '1', '--file', w.file('nope.txt', 'I think everything is fine.')]);
  assertExit(notJson, 1);
  assert.match(notJson.json.errors[0], /no JSON found/);
  assert.equal(w.stateText(), before);

  const badDecision = w.judge(1, { 'R1-B1': ['MAYBE'], 'R1-S1': ['REJECT'], 'R1-S2': ['REJECT'], 'R1-W1': ['ACCEPT'] });
  assertExit(badDecision, 1);
  assert.ok(badDecision.json.errors.some((e) => /R1-B1: decision must be one of/.test(e)));
});

test('triage validate: usage and environment errors (no locator, both locators, missing round, unknown tag)', (t) => {
  const w = world(t);
  assertExit(w.cli(['triage', 'validate', '--round', '1']), 2, 'no state yet');
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.cli(['triage', 'validate', '--round', '1']), 2);
  assertExit(w.cli(['triage', 'validate', '--round', '1', '--file', 'a', '--from-tag', 'b']), 2);
  assertExit(w.cli(['triage', 'validate', '--round', '5', '--file', w.file('j.json', { items: [] })]), 2);
  assertExit(w.cli(['triage', 'validate', '--round', '1', '--from-tag', 'pipeline-judge R1 deadbeef', '--projects-dir', join(w.scratch, 'none')]), 2);
  assertExit(w.cli(['triage', 'bogus']), 2);
  assertExit(w.cli(['triage']), 2);
});

test('triage validate: items already ruled (cache, test) are not the judge\'s to decide', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  editState(w, (st) => { st.rounds[0].items[0].final = { decision: 'ACCEPT', by: 'test', needsHuman: false, reason: 'test confirmed: a.test.js fails' }; });
  const wholeRound = w.judge(1, { 'R1-B1': ['REJECT'], 'R1-S1': ['ACCEPT'] });
  assertExit(wholeRound, 1, 'R1-B1 already has a final, so judging it is an unknown id');
  const ok = w.judge(1, { 'R1-S1': ['ACCEPT'] });
  assertExit(ok, 0);
  assert.equal(w.item('R1-B1').final.by, 'test');
});

test('triage validate: PIPELINE_TEST_FORCE_ARBITER=1 keeps every judged item for the arbiter', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const items = Object.entries(STANDARD_JUDGE).map(([id, [decision, confidence = 'high']]) => ({
    id, decision, confidence, reason: 'r', disputedBug: false, settleTest: { possible: false, plan: '' },
  }));
  const r = w.cli(['triage', 'validate', '--round', '1', '--file', w.file('j.json', { items })], { PIPELINE_TEST_FORCE_ARBITER: '1' });
  assertExit(r, 0);
  assert.deepEqual(r.json.settled, []);
  assert.deepEqual(r.json.unsettled.sort(), ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
});

test('triage settle: a test result settles the item and outranks the judge; bad input is exit 2', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  // S1 and S2 are the judge's REJECTs that a test can decide: disputed bugs with a possible settle test
  assertExit(w.judge(1, { ...STANDARD_JUDGE, 'R1-S1': ['REJECT', 'high', DISPUTED], 'R1-S2': ['REJECT', 'low', DISPUTED] }), 0);

  const r = w.cli(settleArgs(w, 'R1-S1', 'bug-confirmed', { file: 'src/b.test.js', output: 'expected 3 got 4' }));
  assertExit(r, 0);
  assert.equal(r.json.final.decision, 'ACCEPT');
  assert.equal(r.json.final.by, 'test');
  assert.equal(w.item('R1-S1').test.status, 'bug-confirmed');
  assert.match(w.item('R1-S1').final.reason, /b\.test\.js \(exit 1\): expected 3 got 4/);

  assert.equal(w.cli(settleArgs(w, 'R1-S2', 'bug-disproved')).json.final.decision, 'REJECT');
  assertExit(w.cli(['triage', 'settle', '--id', 'R1-S2', '--result', 'maybe', '--test-cmd', 'node src/proof.test.js', '--test-file', 'src/proof.test.js']), 2);
  assertExit(w.cli(settleArgs(w, 'R1-B1', 'bug-confirmed')), 1, 'not a disputed bug');
  assertExit(w.cli(settleArgs(w, 'R9-B1', 'bug-confirmed')), 2);
  assertExit(w.cli(['triage', 'settle', '--id', 'R1-S2', '--result', 'bug-confirmed']), 2, 'a result needs a test to run');
  assertExit(w.cli(['triage', 'settle', '--id', 'R1-S2', '--result', 'bug-confirmed', '--evidence', 'trust me']), 2, 'free-text evidence is no longer accepted');
  assertExit(w.cli(['triage', 'settle', '--result', 'bug-confirmed', '--test-cmd', 'x', '--test-file', 'y']), 2);
});

test('triage light-lane: closes untriaged WORTH CONSIDERING items; refused unless the review is on the light lane', (t) => {
  const w = world(t, { light: true });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  const r = w.cli(['triage', 'light-lane', '--round', '1']);
  assertExit(r, 0);
  assert.deepEqual(r.json.marked, ['R1-W1']);
  assert.deepEqual(w.item('R1-W1').final, { decision: 'REJECT', by: 'light-lane', needsHuman: false, reason: 'light lane — not triaged' });
  assert.equal(w.state().lightLane, true);

  const w2 = world(t);
  assertExit(w2.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  const refused = w2.cli(['triage', 'light-lane', '--round', '1']);
  assertExit(refused, 1);
  assert.equal(refused.json.ok, false);
  assert.equal(w2.item('R1-W1').final ?? null, null);
});

// ---- arbiter needed / apply -------------------------------------------------------------------

function readyForArbiter(t, opts, decisions = STANDARD_JUDGE) {
  const w = world(t, opts);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, decisions), 0);
  return w;
}

const SORT_RULINGS = {
  rulings: [
    { id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 already covers this.' },
    { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/b.js:5 really is duplicated.' },
  ],
};
const promptFor = (digest, round = 1) => `ROUND: ${round}\nINPUT-DIGEST: ${digest}\nRead the input file and rule on every item.`;

function arbiterRun(w, { text, prompt, model, effort, meta = {}, env = {}, agentId = 'a1', extraArgs = [], jsonl } = {}) {
  const needed = w.state().rounds[0].arbiter;
  const projects = installTranscript(w, {
    agentId,
    jsonl: jsonl ?? transcript({ prompt: prompt ?? promptFor(needed.inputDigest), text: text ?? fenced(SORT_RULINGS), model, effort }),
    meta: { agentType: 'arbiter', description: needed.tag, ...meta },
  });
  return w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects, ...extraArgs], env);
}

test('arbiter needed: nothing to arbitrate is {needed:false}; otherwise writes the digest-stamped input with excerpts', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const untriaged = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(untriaged, 0);
  assert.deepEqual(untriaged.json, { needed: false, items: [], mode: 'dispute' });
  assert.ok(!existsSync(w.roundFile(1, 'arbiter-input.md')));

  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.needed, true);
  assert.deepEqual(r.json.items, ['R1-S1', 'R1-S2']);
  assert.equal(r.json.inputPath, w.roundFile(1, 'arbiter-input.md'));
  assert.match(r.json.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.json.digest8, r.json.digest.slice(0, 8));
  assert.equal(r.json.tag, `pipeline-arbiter R1 ${r.json.digest8}`);

  const text = readFileSync(r.json.inputPath, 'utf8');
  const m = /^ROUND: 1\nINPUT-DIGEST: ([0-9a-f]{64})\n\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'header, blank line, body');
  assert.equal(m[1], r.json.digest);
  assert.equal(sha256(m[2]), r.json.digest, 'the digest is the sha256 of the body');
  for (const needle of [
    '## R1-S1', '## R1-S2', 'SUGGESTION', 'maintainability', 'Rename helper', 'src/b.js:3',
    'Codex detail:', 'x is dereferenced before it is checked', 'Codex reasoning:', 'compute(x.y) throws',
    'REJECT (confidence high) - judge: REJECT R1-S1', 'REJECT (confidence low)', 'Test result: none',
    'Code at HEAD, src/b.js lines 1-8:', 'export const w3 = 3;',
  ]) assert.ok(text.includes(needle), `missing ${needle}`);
  assert.ok(!text.includes('## R1-B1') && !text.includes('## R1-W1'), 'only items that need the arbiter are in the input');

  const stored = w.state().rounds[0].arbiter;
  assert.deepEqual(stored, { inputDigest: r.json.digest, items: ['R1-S1', 'R1-S2'], tag: r.json.tag, mode: 'dispute' });
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.digest, r.json.digest, 'deterministic for unchanged state');
});

test('arbiter needed: the excerpt is +/-20 lines of the file at HEAD, numbered, and cannot break out of its fence', (t) => {
  const w = world(t);
  w.repo.write('src/f.js', Array.from({ length: 60 }, (_, i) => (i === 29 ? '// ``` closes a naive fence' : `const f${i + 1} = ${i + 1};`)).join('\n') + '\n');
  const head2 = w.repo.commit('add f');
  assertExit(w.codex(1, findingsOf([finding({ title: 'Look at f', file: 'src/f.js', line: 30 })]), { to: head2 }), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT'] }), 0);
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  const text = readFileSync(r.json.inputPath, 'utf8');
  assert.match(text, /Code at HEAD, src\/f\.js lines 10-50:/);
  assert.match(text, /^10 \| const f10 = 10;$/m);
  assert.match(text, /^50 \| const f50 = 50;$/m);
  assert.doesNotMatch(text, /const f9 = 9;/);
  assert.doesNotMatch(text, /const f51 = 51;/);
  assert.match(text, /\n````\n10 \| /, 'the fence is longer than the backticks inside the excerpt');
});

test('arbiter needed on the light lane: a dismissed SUGGESTION is settled by the judge, only a dismissed BLOCKING item goes to the arbiter', (t) => {
  const w = world(t, { light: true });
  assertExit(w.codex(1, standardFindings()), 0);
  assert.equal(w.state().lightLane, true);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  assert.equal(w.item('R1-S1').final.by, 'judge');
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.needed, false);

  const w2 = world(t, { light: true });
  assertExit(w2.codex(1, standardFindings()), 0);
  assertExit(w2.judge(1, { ...STANDARD_JUDGE, 'R1-B1': ['REJECT'] }), 0);
  assert.deepEqual(w2.cli(['arbiter', 'needed', '--round', '1']).json.items, ['R1-B1']);
});

test('arbiter needed --force (and PIPELINE_TEST_FORCE_ARBITER=1) sends every judged-but-unsettled item', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assert.deepEqual(w.cli(['arbiter', 'needed', '--round', '1', '--force']).json.items, ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
  assert.deepEqual(w.cli(['arbiter', 'needed', '--round', '1'], { PIPELINE_TEST_FORCE_ARBITER: '1' }).json.items, ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
});

test('arbiter apply: a Fable transcript for this round and digest is proven, its rulings applied, proof files written', (t) => {
  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  const r = arbiterRun(w);
  assertExit(r, 0, r.stderr + JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.errors, []);
  assert.equal(r.json.tag, needed.json.tag);
  assert.deepEqual(r.json.items.map((i) => [i.id, i.ruling, i.needsHuman]), [['R1-S1', 'REJECT', false], ['R1-S2', 'ACCEPT', false]]);

  const s1 = w.item('R1-S1');
  assert.equal(s1.final.by, 'arbiter');
  assert.equal(s1.final.decision, 'REJECT');
  assert.equal(s1.final.needsHuman, false);
  assert.equal(s1.arbiter.confidence, 'high');
  assert.match(s1.arbiter.transcript, /agent-a1\.jsonl$/);
  assert.equal(w.item('R1-S2').final.decision, 'ACCEPT');
  assert.equal(w.item('R1-B1').final.by, 'judge', 'items the arbiter never saw keep the judge\'s decision');

  const rulings = JSON.parse(readFileSync(w.roundFile(1, 'rulings.json'), 'utf8'));
  assert.equal(rulings.proofOk, true);
  assert.equal(rulings.rulings.length, 2);
  const proof = JSON.parse(readFileSync(w.roundFile(1, 'model-proof.json'), 'utf8'));
  assert.equal(proof.ok, true);
  assert.equal(proof.round, 1);
  assert.equal(proof.tag, needed.json.tag);
  assert.deepEqual(proof.models, { 'claude-fable-5-1': 1 });
  assert.deepEqual(proof.efforts, { high: 1 });
  assert.deepEqual(proof.errors, []);
  assert.match(proof.transcript, /agent-a1\.jsonl$/);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
  assert.deepEqual(w.state().rounds[0].modelProof, { transcript: proof.transcript, models: { 'claude-fable-5-1': 1 }, effort: 'high' }, 'the proof summary travels in the state');

});

test('arbiter apply: the agent id can be given instead of the tag', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const needed = w.state().rounds[0].arbiter;
  const projects = installTranscript(w, {
    agentId: 'abc123', jsonl: transcript({ prompt: promptFor(needed.inputDigest), text: fenced(SORT_RULINGS) }),
    meta: { agentType: 'arbiter', description: 'some other description' },
  });
  const r = w.cli(['arbiter', 'apply', '--round', '1', '--agent-id', 'abc123', '--projects-dir', projects]);
  assertExit(r, 0, r.stderr + JSON.stringify(r.json));
  assertExit(w.cli(['arbiter', 'apply', '--round', '1', '--agent-id', 'abc123', '--tag', 'x']), 2, 'only one locator');
});

// What the unproven paths must all do: exit 1, every arbitrated item needsHuman, the judge's decision kept as the
// fallback, model-proof.json recording the failure.
function assertAllNeedHuman(w, r, errorPattern) {
  assertExit(r, 1, r.stderr + JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.some((e) => errorPattern.test(e)), `errors ${JSON.stringify(r.json.errors)} should match ${errorPattern}`);
  for (const id of ['R1-S1', 'R1-S2']) {
    const item = w.item(id);
    assert.equal(item.final.needsHuman, true, id);
    assert.equal(item.final.by, 'arbiter');
    assert.equal(item.final.decision, 'REJECT', 'falls back to the judge\'s decision, never the unproven ruling');
    assert.match(item.final.reason, /model-proof failed/);
    assert.equal(item.arbiter.ruling, null);
    assert.equal(item.arbiter.reasoning, 'unverified');
  }
  assert.equal(w.item('R1-B1').final.needsHuman, false, 'items that never went to the arbiter are unaffected');
  const proof = JSON.parse(readFileSync(w.roundFile(1, 'model-proof.json'), 'utf8'));
  assert.equal(proof.ok, false);
  assert.ok(proof.errors.length > 0);
  assert.equal(JSON.parse(readFileSync(w.roundFile(1, 'rulings.json'), 'utf8')).proofOk, false);
  assert.equal(w.state().rounds[0].modelProof, undefined, 'a failed proof is not recorded as one');
}

test('arbiter apply: a <synthetic> (API error) transcript is exit 1 and every arbitrated item needsHuman', (t) => {
  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']).json;
  const jsonl = readFileSync(join(here, 'fixtures', 'transcripts', 'synthetic-error.jsonl'), 'utf8')
    .replace('abc123def456abc123def456abc123def456abc123def456abc123def456abcd', needed.digest);
  const r = arbiterRun(w, { jsonl });
  assertAllNeedHuman(w, r, /unexpected model <synthetic>/);
  assert.ok(r.json.errors.some((e) => /API error/.test(e)));
});

test('arbiter apply: a non-Fable model, or the wrong effort, is exit 1 needsHuman', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w, arbiterRun(w, { model: 'claude-opus-5-1' }), /unexpected model claude-opus-5-1/);
  const w2 = readyForArbiter(t);
  w2.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w2, arbiterRun(w2, { effort: 'low' }), /unexpected effort low/);
});

test('arbiter apply: a correct Fable transcript that answered a different digest or round is exit 1 needsHuman', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const wrongDigest = arbiterRun(w, { prompt: promptFor('0'.repeat(64)) });
  assertAllNeedHuman(w, wrongDigest, /INPUT-DIGEST/);

  const w2 = readyForArbiter(t);
  const needed = w2.cli(['arbiter', 'needed', '--round', '1']).json;
  assertAllNeedHuman(w2, arbiterRun(w2, { prompt: promptFor(needed.digest, 2) }), /ROUND: 1/);

  // "ROUND: 1" must not be satisfied by "ROUND: 12", nor the digest by a longer line that merely starts with it
  const w3 = readyForArbiter(t);
  const n3 = w3.cli(['arbiter', 'needed', '--round', '1']).json;
  assertAllNeedHuman(w3, arbiterRun(w3, { prompt: `ROUND: 12\nINPUT-DIGEST: ${n3.digest}\nrule` }), /ROUND: 1/);
  const w4 = readyForArbiter(t);
  const n4 = w4.cli(['arbiter', 'needed', '--round', '1']).json;
  assertAllNeedHuman(w4, arbiterRun(w4, { prompt: `ROUND: 1\nINPUT-DIGEST: ${n4.digest}ff\nrule` }), /INPUT-DIGEST/);
});

test('arbiter apply: arbiter-input.md edited after `arbiter needed` no longer matches the stored digest', (t) => {
  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']).json;
  writeFileSync(needed.inputPath, readFileSync(needed.inputPath, 'utf8').replace('Rename helper', 'Rename helper (edited)'));
  assertAllNeedHuman(w, arbiterRun(w), /body no longer matches/);

  const w2 = readyForArbiter(t);
  const n2 = w2.cli(['arbiter', 'needed', '--round', '1']).json;
  rmSync(n2.inputPath);
  assertAllNeedHuman(w2, arbiterRun(w2), /arbiter-input\.md is missing/);
});

test('arbiter apply: rulings that do not cover exactly the needed ids, or are not JSON, are exit 1 needsHuman', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const missing = fenced({ rulings: [SORT_RULINGS.rulings[0]] });
  assertAllNeedHuman(w, arbiterRun(w, { text: missing }), /rulings: missing id R1-S2/);

  const w2 = readyForArbiter(t);
  w2.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w2, arbiterRun(w2, { text: 'I rule: accept both.' }), /no JSON found/);

  const w3 = readyForArbiter(t);
  w3.cli(['arbiter', 'needed', '--round', '1']);
  const bad = fenced({ rulings: [{ ...SORT_RULINGS.rulings[0], ruling: 'maybe' }, SORT_RULINGS.rulings[1]] });
  assertAllNeedHuman(w3, arbiterRun(w3, { text: bad }), /R1-S1: ruling must be one of/);
  const unverified = JSON.parse(readFileSync(w3.roundFile(1, 'rulings.json'), 'utf8'));
  assert.equal(unverified.rulings[0].reasoning, 'unverified');
});

test('arbiter apply: a per-call model override fails the proof (proof 6), with or without PIPELINE_ARBITER_MODEL_OVERRIDE', (t) => {
  // proof switch #6: the override model does not exist; the agent errors; nothing may be trusted
  const synthetic = (digest) => readFileSync(join(here, 'fixtures', 'transcripts', 'synthetic-error.jsonl'), 'utf8')
    .replace('abc123def456abc123def456abc123def456abc123def456abc123def456abcd', digest);

  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']).json;
  const withEnv = arbiterRun(w, {
    jsonl: synthetic(needed.digest), meta: { model: 'claude-nonexistent-0' }, env: { PIPELINE_ARBITER_MODEL_OVERRIDE: 'claude-nonexistent-0' },
  });
  assertAllNeedHuman(w, withEnv, /unexpected model <synthetic>/);
  assert.ok(withEnv.json.errors.some((e) => /per-call model override present/.test(e)), 'the switch never excuses an override: the proof fails for it as well');

  const w2 = readyForArbiter(t);
  const n2 = w2.cli(['arbiter', 'needed', '--round', '1']).json;
  const withoutEnv = arbiterRun(w2, { jsonl: synthetic(n2.digest), meta: { model: 'claude-nonexistent-0' } });
  assertAllNeedHuman(w2, withoutEnv, /per-call model override present: claude-nonexistent-0/);

  // an override that silently swapped a GOOD-looking model in without the switch is also refused
  const w3 = readyForArbiter(t);
  w3.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w3, arbiterRun(w3, { meta: { model: 'claude-fable-5-1' } }), /per-call model override present/);
});

test('arbiter apply: no transcript is exit 2 and leaves the state untouched; no `arbiter needed` yet is exit 2', (t) => {
  const w = readyForArbiter(t);
  assertExit(w.cli(['arbiter', 'apply', '--round', '1']), 2, 'needed has not run');
  w.cli(['arbiter', 'needed', '--round', '1']);
  const before = w.stateText();
  const r = w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', join(w.scratch, 'none')]);
  assertExit(r, 2);
  assert.equal(r.json.error, 'not-found');
  assert.equal(w.stateText(), before);
});

test('arbiter apply: an arbiter that wants a human (low confidence) is final but needsHuman, and a test result is never overridden', (t) => {
  const w = readyForArbiter(t, undefined, { ...STANDARD_JUDGE, 'R1-S1': ['REJECT', 'high', DISPUTED] });
  w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(w.cli(settleArgs(w, 'R1-S1', 'bug-confirmed')), 0);
  const text = fenced({
    rulings: [
      { id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'covered' },
      { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'low', reasoning: 'depends on product intent' },
    ],
  });
  const r = arbiterRun(w, { text });
  assertExit(r, 0);
  assert.equal(w.item('R1-S1').final.by, 'test', 'a test outranks the arbiter');
  assert.equal(w.item('R1-S2').final.needsHuman, true);
  assert.equal(w.item('R1-S2').final.decision, 'ACCEPT');
});

// ---- state ------------------------------------------------------------------------------------

test('state show: filters by round, accepted, disputed and needs-human; mark-implemented drops an item from accepted', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const noState = world(t);
  assertExit(noState.cli(['state', 'show']), 2);

  const disputed = { disputedBug: true, settleTest: { possible: true, plan: 'a.test.js: expect compute(undefined) to throw' } };
  assertExit(w.judge(1, { ...STANDARD_JUDGE, 'R1-S1': ['REJECT', 'high', disputed] }), 0);
  const all = w.cli(['state', 'show']);
  assert.equal(all.json.count, 4);
  assert.equal(all.json.recovered, false);
  assert.equal(all.json.pr, 7);
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items.map((i) => i.id), ['R1-B1']);
  assert.deepEqual(w.cli(['state', 'show', '--disputed']).json.items.map((i) => i.id), ['R1-S1']);
  assert.deepEqual(w.cli(['state', 'show', '--needs-human']).json.items, []);
  assert.deepEqual(w.cli(['state', 'show', '--round', '1']).json.items.length, 4);
  assertExit(w.cli(['state', 'show', '--round', '2']), 2);

  // settling the disputed bug removes it from --disputed
  assertExit(w.cli(settleArgs(w, 'R1-S1', 'bug-confirmed')), 0);
  assert.deepEqual(w.cli(['state', 'show', '--disputed']).json.items, []);
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items.map((i) => i.id), ['R1-B1', 'R1-S1']);

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.commit('fix');
  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R1-S1']);
  assertExit(marked, 0);
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items, []);
  assert.equal(w.item('R1-B1').implemented, true);

  const before = w.stateText();
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-W1']), 2, 'only an ACCEPTED item can be implemented');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R9-B9']), 2);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', '']), 2);
  assert.equal(w.stateText(), before, 'a bad id list changes nothing');
});

test('state mark-implemented: files that came in from merging the base branch do not count as the fix', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  w.repo.write('src/a.test.js', 'console.log("only a test");\n');
  w.repo.commit('add a test');
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.match(refused.json.message, /only test files changed \(src\/a\.test\.js\)/, 'main\'s src/from-main.js is not the PR\'s change');

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
});

test('state mark-implemented fails closed: a conflicting base merge, or a state whose toHead git cannot resolve, refuses the mark', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  // The default branch edits the line round 1 reviewed the PR changing: the trial merge conflicts, so the PR's own change
  // since round 1 cannot be separated from main's, and no fix is accepted on a guess.
  // The PR is then rebuilt on top of main (a rebase): no merge commit records how the conflict was resolved, so nothing
  // marks where the PR's own work since round 1 starts.
  w.repo.checkout('main');
  w.repo.write('src/a.js', aFile(false).replace('v12 = 12', 'v12 = 1200'));
  w.repo.write('src/from-main.js', 'export const other = 1;\n');
  w.repo.commit('main moves on');
  w.repo.git(['checkout', '-q', '-B', 'feat/x', 'main']);
  w.repo.write('src/a.js', aFile(true));
  w.repo.commit('feature, rebuilt on main');
  w.repo.write('src/a.test.js', 'console.log("test");\n');
  w.repo.commit('add a test');
  const before = w.stateText();
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'base-unresolved');
  assert.equal(w.stateText(), before, 'nothing was marked');

  // An unresolvable toHead is an error, never "a non-test file changed".
  const w2 = worldIgnoringReview(t);
  assertExit(w2.codex(1, findingsOf([finding()])), 0);
  assertExit(w2.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  w2.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w2.repo.commit('fix');
  const st = JSON.parse(w2.stateText());
  st.rounds[0].toHead = 'f'.repeat(40);
  writeFileSync(join(w2.repo.dir, '.review', 'state.json'), JSON.stringify(st));
  const bad = w2.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(bad, 2, bad.stderr + bad.stdout);
  assert.equal(bad.json.error, 'base-unresolved');
  assert.equal(w2.item('R1-B1').implemented, undefined);
});

// A conflicting base merge cannot be separated from the PR's own change by a trial merge, so the PR's work since round N is
// measured from the merge commit that resolved the conflict (the latest one on the PR's first-parent history whose other parent
// is the default branch carrying the current fork point).
const conflictMerge = (w, extra = {}) =>
  mergeMainInto(w, { 'src/a.js': aFile(false).replace('v12 = 12', 'v12 = 1200'), 'src/from-main.js': 'export const other = 1;\n', ...extra }, { resolve: { 'src/a.js': aFile(true) } });
const acceptedWorld = (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  return w;
};
const fixA = (w) => {
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  return w.repo.commit('fix');
};

test('state mark-implemented: after a conflicting base merge is resolved, a real fix committed after the resolution counts', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  fixA(w);
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R1-B1').implemented, true);
});

test('state mark-implemented: after a resolved conflicting merge, only a test file committed since is still refused', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  w.repo.write('src/a.test.js', 'console.log("test");\n');
  w.repo.commit('add a test');
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change');
  assert.match(refused.json.message, /only test files changed \(src\/a\.test\.js\)/);
  assert.equal(w.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: a resolved conflicting merge with no later commit is refused', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change');
  assert.equal(w.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: files main brings in after the resolving merge do not count as the fix', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  w.repo.write('src/a.test.js', 'console.log("test");\n');
  w.repo.commit('add a test');
  mergeMainInto(w, { 'src/more-from-main.js': 'export const more = 1;\n' }); // a clean second update-branch
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change', 'main\'s new file is not the PR\'s change');
  assert.doesNotMatch(refused.json.message, /more-from-main/);
});

test('state mark-implemented: a fix committed before a later clean base merge still counts, and the later merge alone does not', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  fixA(w);
  mergeMainInto(w, { 'src/more-from-main.js': 'export const more = 1;\n' }); // update-branch again, no conflict
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R1-B1').implemented, true);

  const w2 = acceptedWorld(t);
  conflictMerge(w2);
  mergeMainInto(w2, { 'src/more-from-main.js': 'export const more = 1;\n' });
  const refused = w2.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change');
  assert.equal(w2.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: a conflict resolved by merging a branch other than the default branch stays unresolved', (t) => {
  const w = acceptedWorld(t);
  // main gets the conflicting change; a side branch (containing it plus more) is what the PR merges, so no merge commit
  // brings in the default branch itself.
  w.repo.checkout('main');
  w.repo.write('src/a.js', aFile(false).replace('v12 = 12', 'v12 = 1200'));
  w.repo.commit('main moves on');
  w.repo.git(['checkout', '-q', '-b', 'side', 'main']);
  w.repo.write('src/side.js', 'export const side = 1;\n');
  w.repo.commit('side work');
  w.repo.checkout('feat/x');
  try { w.repo.git(['merge', '--no-ff', '-m', 'merge side', 'side']); } catch {
    w.repo.write('src/a.js', aFile(true));
    w.repo.git(['add', '-A']);
    w.repo.git(['commit', '-q', '--no-edit']);
  }
  fixA(w);
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'base-unresolved');
  assert.doesNotMatch(refused.json.message, /resolve the base branch merge and try again/);
});

test('state record-followup and set-outcome', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.cli(['state', 'record-followup', '--id', 'R1-W1', '--url', 'https://github.com/acme/widgets/issues/3']), 0);
  assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/3');
  assertExit(w.cli(['state', 'record-followup', '--id', 'R1-W1', '--url', 'not a url']), 2);
  assertExit(w.cli(['state', 'record-followup', '--id', 'R7-W1', '--url', 'https://x.test/1']), 2);
  assertExit(w.cli(['state', 'set-outcome', '--outcome', 'needs-human']), 0);
  assert.equal(w.state().outcome, 'needs-human');
  assertExit(w.cli(['state', 'set-outcome', '--outcome', '']), 2);
  assertExit(w.cli(['state', 'set-outcome']), 2);
  assertExit(w.cli(['state', 'nope']), 2);
});

test('state outcome: a round with nothing to fix is clean; coverage follows the content hash; a new ACCEPT is not clean', (t) => {
  const w = world(t);
  assertExit(w.cli(['state', 'outcome']), 2, 'no state at all');
  assertExit(w.codex(1, findingsOf()), 0);
  const clean = w.cli(['state', 'outcome']);
  assertExit(clean, 0);
  assert.equal(clean.json.clean, true);
  assert.equal(clean.json.coverageValid, true);
  assert.equal(clean.json.currentContentHash, w.state().rounds[0].contentHashAtToHead);
  assert.deepEqual([clean.json.rounds, clean.json.maxRounds, clean.json.reachedMax], [1, 2, false]);
  assert.deepEqual([clean.json.extraRound, clean.json.effectiveMaxRounds], [false, 2]);

  // content changed after the review: exit stays 0, clean turns false
  w.repo.write('src/b.js', `${bFile}export const extra = 1;\n`);
  w.repo.commit('after review');
  const stale = w.cli(['state', 'outcome']);
  assertExit(stale, 0);
  assert.equal(stale.json.clean, false);
  assert.equal(stale.json.coverageValid, false);

  // a different world: a finding that the judge ACCEPTs
  const w2 = world(t);
  assertExit(w2.codex(1, findingsOf([finding()])), 0);
  assertExit(w2.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const accepted = w2.cli(['state', 'outcome']);
  assertExit(accepted, 0);
  assert.equal(accepted.json.clean, false);
  assert.deepEqual(accepted.json.newAccepted, ['R1-B1']);
  assert.deepEqual(accepted.json.openBlocking, ['R1-B1']);

  // fixed and implemented: still not clean until a later round reviews the fix
  w2.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w2.repo.commit('fix');
  assertExit(w2.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.equal(w2.cli(['state', 'outcome']).json.clean, false);
  assertExit(w2.codex(2, findingsOf(), { from: w2.head, to: head2 }), 0);
  const round2 = w2.cli(['state', 'outcome']);
  assert.equal(round2.json.clean, true, JSON.stringify(round2.json));
  assert.deepEqual(round2.json.newAccepted, []);
});

test('state show --pr rebuilds a lost state from the newest triage comment of ours', (t) => {
  const w0 = world(t);
  assertExit(w0.codex(1, standardFindings()), 0);
  assertExit(w0.judge(1, STANDARD_JUDGE), 0);
  const real = w0.state();
  const forged = { ...real, rounds: [], risk: 'forged' };
  const gh = [
    ...GH,
    { match: '^api user', stdout: 'me\n' },
    {
      match: 'issues/(7|8)/comments --paginate', // PR 8 gets the same comments: their embedded state says PR 7
      stdoutJson: [
        { id: 3, user: { login: 'me' }, body: triageComment({ ...real, risk: 'older' }) },
        { id: 9, user: { login: 'me' }, body: triageComment(real) },
        { id: 12, user: { login: 'mallory' }, body: triageComment(forged) },
        { id: 13, user: { login: 'me' }, body: `quoting ${MARKERS.triage}\n${triageComment(forged)}` },
      ],
    },
  ];
  const w = world(t, { gh });
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.recovered, true);
  assert.equal(r.json.count, 4);
  assert.deepEqual(w.state(), real, 'the recovered state is saved byte-for-byte as the comment carried it');
  assert.equal(w.cli(['state', 'show', '--pr', '7']).json.recovered, false, 'second call reads the local copy');

  const wrongPr = world(t, { gh });
  const mismatch = wrongPr.cli(['state', 'show', '--pr', '8']);
  assertExit(mismatch, 2);
  assert.ok(!existsSync(join(wrongPr.repo.dir, '.review', 'state.json')));
  assertExit(w.cli(['state', 'show', '--pr', '8']), 2, 'a local state of another PR is not served');

  const noComment = world(t, { gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: 'issues/7/comments --paginate', stdoutJson: [] }] });
  assertExit(noComment.cli(['state', 'show', '--pr', '7']), 2);
  const ghDown = world(t, { gh: [{ match: '.', code: 1, stderr: 'HTTP 502' }] });
  assertExit(ghDown.cli(['state', 'show', '--pr', '7']), 3);
});

// ---- review-complete --------------------------------------------------------------------------

const REMOVE_LABEL = { match: '^pr edit 7 --remove-label awaiting-review', code: 0 };
// What review-complete asks and posts: who we are, our earlier comments (none), then the new marker comment.
const REVIEW_COMMENT = [
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
];
const postedBodies = (w) => w.fake.calls().filter((c) => /^api -X POST repos\/acme\/widgets\/issues\/7\/comments /.test(c.argv.join(' '))).map((c) => JSON.parse(c.stdin).body);
const reviewJson = (body) => JSON.parse(/```json\n(.*)\n```/.exec(body)[1]);

test('review-complete: removes awaiting-review only when the review is valid for the current content', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.cli(['review-complete', '--pr', '7']), 1, 'no state: no review has run');
  assertExit(w.codex(1, findingsOf()), 0);

  const ok = w.cli(['review-complete', '--pr', '7']);
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.deepEqual([ok.json.ok, ok.json.removed], [true, true]);
  assert.ok(w.fake.lines().includes('pr edit 7 --remove-label awaiting-review'));

  // the branch moved on after the review: the label stays
  const calls = w.fake.lines().filter((l) => l.startsWith('pr edit')).length;
  w.repo.write('src/b.js', `${bFile}export const extra = 1;\n`);
  w.prHead(w.repo.commit('unreviewed change'));
  const stale = w.cli(['review-complete', '--pr', '7']);
  assertExit(stale, 1);
  assert.equal(stale.json.ok, false);
  assert.match(stale.json.reason, /no review round covers the current content/);
  assert.equal(w.fake.lines().filter((l) => l.startsWith('pr edit')).length, calls, 'no label call when not valid');

  assertExit(w.cli(['review-complete', '--pr', '8']), 1, 'state of another PR');
});

test('review-complete: unresolved items or an unimplemented ACCEPT keep the label', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  const pending = w.cli(['review-complete', '--pr', '7']);
  assertExit(pending, 1);
  assert.match(pending.json.reason, /waiting for a decision: R1-B1/);

  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const accepted = w.cli(['review-complete', '--pr', '7']);
  assertExit(accepted, 1);
  assert.match(accepted.json.reason, /not implemented: R1-B1/);
  assert.ok(!w.fake.lines().some((l) => l.startsWith('pr edit')));
});

test('review-complete: Codex outage then recovery (exit 3, then a clean review, then the label comes off)', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  const outage = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'usage limit reached' } });
  assertExit(outage, 3);
  assertExit(w.cli(['review-complete', '--pr', '7']), 1, 'nothing was reviewed yet');

  assertExit(w.codex(1, findingsOf()), 0, 'Codex is back: the same round can be run again');
  assertExit(w.cli(['review-complete', '--pr', '7']), 0);
  assert.ok(w.fake.lines().includes('pr edit 7 --remove-label awaiting-review'));
});

test('review-complete: a gh failure while removing the label is exit 3, not success', (t) => {
  const w = world(t, { gh: [...GH, ...REVIEW_COMMENT, { match: '^pr edit', code: 1, stderr: 'HTTP 502' }] });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['review-complete', '--pr', '7']), 3);
});

test('review-complete: posts the marker comment with {contentHash, base, head, rounds, codexModel, modelProofDigest}; an identical one is reused', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.deepEqual(r.json.comment, { id: 77, url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' });
  const [body] = postedBodies(w);
  assert.ok(body.startsWith('<!-- claude-pipeline:review-complete v1 -->\n'), body);
  const record = reviewJson(body);
  assert.deepEqual(Object.keys(record), ['contentHash', 'base', 'head', 'rounds', 'codexModel', 'modelProofDigest']);
  assert.deepEqual(record, {
    contentHash: w.state().rounds[0].contentHashAtToHead, base: w.base, head: w.head, rounds: 1, codexModel: 'gpt-6-astra', modelProofDigest: null,
  });
  assert.deepEqual(r.json.review, record);
  // The hash is the one a guard can recompute from git alone: contentHash(base, head) minus the agent log.
  assert.equal(record.contentHash, contentHash(record.base, record.head, { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));

  // A retry finds our own identical latest comment and posts nothing new; someone else's copy does not count.
  w.fake.setScript([
    ...GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: w.head, ...e.stdoutJson } } : e)),
    REMOVE_LABEL,
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [{ id: 76, user: { login: 'mallory' }, body: 'x' }, { id: 77, user: { login: 'me' }, body, html_url: 'u77' }] },
  ]);
  const again = w.cli(['review-complete', '--pr', '7']);
  assertExit(again, 0, again.stdout);
  assert.deepEqual([again.json.reused, again.json.comment], [true, { id: 77, url: 'u77' }]);
  assert.equal(postedBodies(w).length, 1);
});

// The recheck nudge: a ready PR gets no event from a comment, so review-complete adds and removes `pipeline-recheck`.
const RECHECK_ADD = 'pr edit 7 --add-label pipeline-recheck';
const RECHECK_REMOVE = 'pr edit 7 --remove-label pipeline-recheck';
const RECHECK_OK = [{ match: '^pr edit 7 --add-label pipeline-recheck', code: 0 }, { match: '^pr edit 7 --remove-label pipeline-recheck', code: 0 }];
// The PR as the first look (headRefOid, isDraft, labels) sees it; the read-back after removing awaiting-review is a later, separate look.
const PR_VIEW_AFTER = { match: '^pr view 7 --json labels', stdoutJson: { labels: [] } };
const gotPr = (view) => GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, ...view } } : e));

test('review-complete recheck: a ready PR without awaiting-review gets pipeline-recheck added, then removed (recheck triggered)', (t) => {
  const w = world(t, { gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: false, labels: [{ name: 'agent-build' }] }), REMOVE_LABEL, ...RECHECK_OK, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.recheck, 'triggered');
  assert.equal(r.json.recheckError, undefined);
  const edits = w.fake.lines().filter((l) => l.startsWith('pr edit'));
  assert.deepEqual(edits, ['pr edit 7 --remove-label awaiting-review', RECHECK_ADD, RECHECK_REMOVE]);
});

test('review-complete recheck: a ready PR that had awaiting-review needs no nudge (the unlabel fired the event): recheck label-removed', (t) => {
  const w = world(t, { gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: false, labels: [{ name: 'awaiting-review' }] }), REMOVE_LABEL, ...RECHECK_OK, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.recheck, 'label-removed');
  const edits = w.fake.lines().filter((l) => l.startsWith('pr edit'));
  assert.deepEqual(edits, ['pr edit 7 --remove-label awaiting-review']);
});

test('review-complete recheck: a draft gets its run when it is marked ready (recheck on-ready), no pipeline-recheck label', (t) => {
  for (const labels of [[], [{ name: 'awaiting-review' }]]) {
    const w = world(t, { gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: true, labels }), REMOVE_LABEL, ...RECHECK_OK, ...REVIEW_COMMENT] });
    assertExit(w.codex(1, findingsOf()), 0);
    const r = w.cli(['review-complete', '--pr', '7']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.recheck, 'on-ready');
    assert.ok(!w.fake.lines().includes(RECHECK_ADD), 'no label added to a draft');
  }
});

test('review-complete recheck: a failed nudge never undoes the posted comment: exit 0, recheck failed, recheckError names `P labels`', (t) => {
  const w = world(t, {
    gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: false, labels: [] }), REMOVE_LABEL, { match: '^pr edit 7 --add-label pipeline-recheck', code: 1, stderr: "could not add label: 'pipeline-recheck' not found" }, ...RECHECK_OK, ...REVIEW_COMMENT],
  });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.removed, true);
  assert.equal(r.json.recheck, 'failed');
  assert.match(r.json.recheckError, /P labels/);
  assert.ok(w.fake.lines().includes(RECHECK_ADD));
  assert.ok(!w.fake.lines().includes(RECHECK_REMOVE), 'no remove after a failed add');
  assert.equal(postedBodies(w).length, 1, 'the review-complete comment stays');
});

// A world whose only change is to a path the config sends to Fable every round, at low risk.
const SENSITIVE_YML = `${pipelineYml()}review:\n  arbiter_always_paths: [src/a.js]\n`;
const FABLE_CLEAN = { rulings: [], findings: [] };

test('a sensitive PR with ZERO Codex findings still requires the Fable pass: not clean, no review-complete, until a proven pass', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT], yml: SENSITIVE_YML });
  const r = w.codex(1, findingsOf());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.reviewer, r.json.reviewerReasons, r.json.lightLane], ['fable', ['sensitive path: src/a.js'], false]);
  assert.equal(w.state().risk, 'low', 'the lane, not the risk level, sends it to Fable');
  assert.deepEqual(w.state().rounds[0].sensitivePaths, ['src/a.js']);
  // Codex was given the attacker's brief for the sensitive file.
  assert.match(w.captured()[0].stdin, /## Attacker's brief[\s\S]*```sensitive paths\nsrc\/a\.js\n```/);

  const pending = w.cli(['state', 'outcome']).json;
  assert.deepEqual([pending.clean, pending.fablePending], [false, [1]]);
  const early = w.cli(['review-complete', '--pr', '7']);
  assertExit(early, 1);
  assert.match(early.json.reason, /Fable review pass has not been proven for round 1/);
  assert.equal(postedBodies(w).length, 0);
  const judged = w.judge(1, {});
  assertExit(judged, 2);
  assert.equal(judged.json.error, 'fable-round', 'one reviewer layer: no judge on a Fable round');

  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(needed, 0, needed.stdout);
  assert.deepEqual([needed.json.needed, needed.json.mode, needed.json.items, needed.json.scope], [true, 'review', [], 'whole-pr']);
  const input = readFileSync(needed.json.inputPath, 'utf8');
  assert.match(input, /Mode: REVIEW/);
  assert.match(input, /your own review is the whole job/);
  assert.match(input, /Sensitive files \(attack them[^\n]*\n```sensitive paths\nsrc\/a\.js\n```/, 'paths are data in a fence');
  assert.match(input, /untrusted data written by the change author/);
  assert.match(input, /Why Fable reviews this PR: sensitive path\./, 'no author-chosen path outside the fence');
  const diff = readFileSync(needed.json.diffPath, 'utf8');
  assert.match(diff, /compute\(x\.y\)/, 'the whole PR diff is what Fable reviews');
  assert.ok(input.includes(`Diff sha256: ${sha256(diff)}`));

  // An answer without its own review (no findings list) does not count: the round stays pending.
  assertExit(arbiterRun(w, { text: fenced({ rulings: [] }) }), 1);
  assert.deepEqual(w.cli(['state', 'outcome']).json.fablePending, [1]);
  // A diff edited after needed fails the proof too.
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  writeFileSync(w.state().rounds[0].arbiter.diffPath, 'nothing to see\n');
  const tampered = arbiterRun(w, { text: fenced(FABLE_CLEAN) });
  assertExit(tampered, 1);
  assert.ok(tampered.json.errors.some((e) => /no longer matches the digest/.test(e)), JSON.stringify(tampered.json.errors));

  // needed again (rewrites the diff), then a proven, clean Fable pass: clean, and review-complete carries the proof digest.
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  const proven = arbiterRun(w, { text: fenced(FABLE_CLEAN) });
  assertExit(proven, 0, proven.stdout);
  assert.deepEqual([proven.json.mode, proven.json.findings], ['review', []]);
  assert.equal(w.cli(['state', 'outcome']).json.clean, true);
  assert.deepEqual(w.cli(['arbiter', 'needed', '--round', '1']).json, { needed: false, items: [], mode: 'review', done: true });
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 0, done.stdout);
  assert.match(reviewJson(postedBodies(w).at(-1)).modelProofDigest, /^[0-9a-f]{64}$/);
});

test('Fable review: its own findings become items R<n>-F<k>; Codex items are ruled in the same pass; an ACCEPT reopens the loop', (t) => {
  const w = world(t, { yml: SENSITIVE_YML });
  assertExit(w.codex(1, findingsOf([], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability' })])), 0);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  assert.deepEqual([needed.json.mode, needed.json.items], ['review', ['R1-S1']], 'an untriaged Codex item goes straight to Fable');
  const answer = {
    rulings: [{ id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 is fine' }],
    findings: [{
      bucket: 'BLOCKING', category: 'bug', title: 'x can be undefined', file: 'src/a.js', line: 12, detail: 'compute(x.y) with x undefined throws',
      ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/a.js:12 dereferences x',
    }],
  };
  const r = arbiterRun(w, { text: fenced(answer) });
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json.findings, [{ id: 'R1-F1', bucket: 'BLOCKING', ruling: 'ACCEPT', needsHuman: false }]);
  assert.equal(w.item('R1-S1').final.decision, 'REJECT');
  const f1 = w.item('R1-F1');
  assert.deepEqual([f1.source, f1.final.by, f1.file, f1.line], ['fable', 'arbiter', 'src/a.js', 12]);
  assert.match(f1.fingerprint, /^[0-9a-f]{40}$/);
  const o = w.cli(['state', 'outcome']).json;
  assert.deepEqual([o.clean, o.openBlocking, o.newAccepted], [false, ['R1-F1'], ['R1-F1']]);
  assert.deepEqual(JSON.parse(readFileSync(w.roundFile(1, 'rulings.json'), 'utf8')).findings, answer.findings);

  // A proven review is final: another transcript cannot re-add (or soften) its findings.
  const softer = { ...answer, findings: [{ ...answer.findings[0], bucket: 'WORTH_CONSIDERING', ruling: 'FOLLOW-UP' }] };
  const again = arbiterRun(w, { text: fenced(softer), agentId: 'a2' });
  assertExit(again, 2, again.stdout);
  assert.equal(again.json.error, 'already-applied');
  assert.deepEqual([w.item('R1-F1').bucket, w.item('R1-F1').final.decision], ['BLOCKING', 'ACCEPT']);
  assert.equal(w.state().rounds[0].items.filter((i) => i.id === 'R1-F1').length, 1);
});

// Round 1: a proven Fable pass raises finding1 (FOLLOW-UP). Round 2 (an unrelated change): Fable raises it again as ACCEPT.
function twoFableRounds(t) {
  const w = world(t, { yml: SENSITIVE_YML });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  const finding1 = {
    bucket: 'SUGGESTION', category: 'maintainability', title: 'Name w3 better', file: 'src/b.js', line: 3, detail: 'w3 says nothing',
    ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'src/b.js:3 is a vague name',
  };
  assertExit(arbiterRun(w, { text: fenced({ rulings: [], findings: [finding1] }) }), 0);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w.repo.commit('unrelated change');
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  const needed2 = w.cli(['arbiter', 'needed', '--round', '2']);
  assert.deepEqual([needed2.json.mode, needed2.json.scope], ['review', 'round']);
  const applyRound2 = (agentId) => w.cli(['arbiter', 'apply', '--round', '2', '--projects-dir', installTranscript(w, {
    agentId,
    jsonl: transcript({ prompt: promptFor(needed2.json.digest, 2), text: fenced({ rulings: [], findings: [{ ...finding1, ruling: 'ACCEPT' }] }) }),
    meta: { agentType: 'arbiter', description: needed2.json.tag },
  })]);
  return { w, applyRound2 };
}

test('Fable review: a finding an earlier Fable pass settled, raised again unchanged, takes the cached ruling (no fresh ACCEPT)', (t) => {
  const { w, applyRound2 } = twoFableRounds(t);
  const r2 = applyRound2('a3');
  assertExit(r2, 0, r2.stdout);
  assert.deepEqual([w.item('R2-F1').final.by, w.item('R2-F1').final.decision], ['cache', 'FOLLOW-UP']);
  assert.deepEqual(w.cli(['state', 'outcome']).json.newAccepted, []);
});

test('Fable review: a weaker earlier ruling (the judge) never overrules a finding a proven Fable pass raises', (t) => {
  const { w, applyRound2 } = twoFableRounds(t);
  editState(w, (s) => { s.rounds[0].items[0].final.by = 'judge'; }); // as if the Sonnet judge had ruled it in round 1
  const r2 = applyRound2('a4');
  assertExit(r2, 0, r2.stdout);
  assert.deepEqual([w.item('R2-F1').final.by, w.item('R2-F1').final.decision], ['arbiter', 'ACCEPT']);
});

test('arbiter apply: a Fable round whose input was not written in review mode is refused (stale-input), never proven', (t) => {
  const w = world(t, { yml: SENSITIVE_YML });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  editState(w, (s) => { delete s.rounds[0].arbiter.mode; }); // an older install, a restored or edited state
  const r = arbiterRun(w, { text: fenced({ rulings: [] }) });
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'stale-input');
  assert.deepEqual(w.cli(['state', 'outcome']).json.fablePending, [1]);
});

test('codex-review: rounds stop at review.max_rounds plus ONE extra confirm round (exit 2 round-cap)', (t) => {
  const w = world(t, { yml: `${pipelineYml()}review:\n  max_rounds: 1\n` });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  const extra = w.codex(2, findingsOf([finding({ title: 'Another', file: 'src/b.js', line: 2 })]), { from: w.head, to: head2 });
  assertExit(extra, 0, 'the one confirm round: round 1 only accepted a fix');
  assertExit(w.judge(2, { 'R2-B1': ['ACCEPT'] }), 0);
  w.repo.write('src/b.js', bFile.replace('w2 = 2', 'w2 = 22'));
  const head3 = w.repo.commit('fix 2');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R2-B1']), 0);
  const capped = w.codex(3, findingsOf(), { from: head2, to: head3 });
  assertExit(capped, 2, capped.stdout);
  assert.equal(capped.json.error, 'round-cap');
  assert.match(capped.json.message, /review\.max_rounds \(1\) and its one extra round/);
  assert.equal(w.captured().length, 2, 'Codex never ran for the capped round');
});

// ---- followups create -------------------------------------------------------------------------

test('followups create: one agent-suggestion issue per FOLLOW-UP item, URL recorded, never filed twice', (t) => {
  const url = 'https://github.com/acme/widgets/issues/11';
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 11, html_url: url } }] });
  const longTitle = `Consider caching ${'very '.repeat(40)}hard`;
  assertExit(w.codex(1, findingsOf(
    [],
    [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })],
    [finding({ title: longTitle, file: 'src/a.js', line: 20, detail: 'cache it @someone <!-- x -->', category: 'performance' })],
  )), 0);
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'], 'R1-W1': ['FOLLOW-UP'] }), 0);

  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, [{ id: 'R1-W1', number: 11, url }]);
  assert.deepEqual(r.json.skipped, []);
  const posts = w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues '));
  assert.equal(posts.length, 1, 'only the FOLLOW-UP item gets an issue');
  const body = JSON.parse(posts[0].stdin);
  assert.ok(body.title.startsWith('[agent-suggestion] Consider caching'));
  assert.ok(Array.from(body.title).length <= 120);
  assert.deepEqual(body.labels, ['agent-suggestion']);
  for (const needle of ['cache it', 'Codex reasoning:', 'judge: FOLLOW-UP R1-W1', 'From PR #7, item R1-W1', 'src/a.js:20']) {
    assert.ok(body.body.includes(needle), `issue body should include ${needle}: ${body.body}`);
  }
  assert.equal(body.body.split('\n')[0], '<!-- claude-pipeline:followup pr=7 fp=' + w.item('R1-W1').fingerprint + ' -->', 'the marker is the first line');
  const modelText = body.body.split('\n').slice(1).join('\n');
  assert.ok(!modelText.includes('@someone') && !modelText.includes('<!--'), 'model text is defused');
  assert.equal(w.item('R1-W1').followupIssue, url);

  const again = w.cli(['followups', 'create', '--round', '1']);
  assertExit(again, 0);
  assert.deepEqual(again.json.created, []);
  assert.deepEqual(again.json.skipped, ['R1-W1']);
  assert.equal(w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues ')).length, 1);
  assertExit(w.cli(['followups', 'create', '--round', '4']), 2);
  assertExit(w.cli(['followups']), 2);
});

test('followups create: a gh failure is exit 3 and nothing is recorded as filed', (t) => {
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST', code: 1, stderr: 'HTTP 502' }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 3);
  assert.equal(w.item('R1-W1').followupIssue ?? null, null);
});

// ---- a whole round, end to end ----------------------------------------------------------------

test('a full round: codex -> judge -> arbiter -> implement -> follow-ups -> clean second round -> label off', (t) => {
  const url = 'https://github.com/acme/widgets/issues/21';
  const w = world(t, {
    gh: [
      ...GH, REMOVE_LABEL,
      { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 21, html_url: url } },
      { match: '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=30 --paginate', stdout: '[]' },
      { match: '^api user', stdout: 'me\n' },
      { match: 'issues/7/comments --paginate', stdoutJson: [] },
      { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-5' } },
    ],
  });
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.needed, true);
  assertExit(arbiterRun(w), 0);
  assert.equal(w.item('R1-S1').final.decision, 'REJECT');

  // implement the accepted items (B1 from the judge, S2 from the arbiter)
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items.map((i) => i.id), ['R1-B1', 'R1-S2']);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.write('src/b.js', bFile.replace('w5 = 5', 'FIVE = 5'));
  const head2 = w.repo.commit('implement accepted items');
  w.prHead(head2);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R1-S2']), 0);
  assert.equal(w.cli(['followups', 'create', '--round', '1']).json.created[0].id, 'R1-W1');
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'round 1 accepted things: a later round must review the fixes');
  assertExit(w.cli(['review-complete', '--pr', '7']), 1);

  // round 2 reviews the fix commit only and finds nothing
  const r2 = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r2, 0, r2.stderr + r2.stdout);
  const outcome = w.cli(['state', 'outcome']);
  assert.equal(outcome.json.clean, true, JSON.stringify(outcome.json));
  assertExit(w.cli(['state', 'set-outcome', '--outcome', 'merged']), 0);
  assertExit(w.cli(['review-complete', '--pr', '7']), 0);

  // the comments the loop posts are rendered from the files these commands left behind
  const posted = () => w.fake.calls().filter((c) => /^api -X POST repos\/acme\/widgets\/issues\/7\/comments /.test(c.argv.join(' '))).map((c) => JSON.parse(c.stdin).body);
  assertExit(w.cli(['comment', '--pr', '7', '--kind', 'triage']), 0);
  const triage = posted().at(-1);
  assert.ok(triage.startsWith(MARKERS.triage));
  assert.match(triage, /R1-S1/);
  assertExit(w.cli(['comment', '--pr', '7', '--kind', 'summary', '--outcome', 'merged']), 0);
  const summary = posted().at(-1);
  assert.ok(summary.startsWith(MARKERS.summary));
  assert.match(summary, /Fable proof: .*agent-a1\.jsonl, models claude-fable-5-1×1, effort high/);
  assert.ok(summary.includes(url), 'the follow-up issue recorded by followups create is listed');
});

// ---- review fixes: bind the range, guard cache reuse and settle, lock the state ----------------

// Add `edit(fn)` to a world: change the state file the way an earlier (hypothetical) step would have left it.
const editState = (w, fn) => {
  const s = w.state();
  fn(s);
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), JSON.stringify(s, null, 2));
};
const noState = (w) => !existsSync(join(w.repo.dir, '.review', 'state.json'));
const DISPUTED = { disputedBug: true, settleTest: { possible: true, plan: 'write a failing test' } };

test('codex-review: round 1 must review exactly mergeBase..head; base == head, or any other base, is exit 2 and Codex never runs', (t) => {
  // Reviewer repro R1: --base == --head recorded an EMPTY review as full coverage (lightLane forced on, hard stops
  // hidden), and review-complete then removed awaiting-review.
  const w = world(t);
  const same = w.codex(1, findingsOf(), { from: w.head, to: w.head });
  assertExit(same, 2, same.stdout);
  assert.equal(same.json.error, 'base-mismatch');
  assert.match(same.json.message, new RegExp(w.base));
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const narrow = w.codex(1, findingsOf(), { from: w.head, to: head2 });
  assertExit(narrow, 2);
  assert.equal(narrow.json.error, 'base-mismatch');
  assert.equal(w.captured().length, 0, 'Codex is not even started');
  assert.ok(noState(w), 'nothing recorded');
  assertExit(w.cli(['review-complete', '--pr', '7']), 1);

  // the real merge base is accepted, by SHA or by an abbreviation of it
  const ok = w.codex(1, findingsOf(), { from: w.base.slice(0, 12), to: head2 });
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.equal(w.state().rounds[0].fromHead, w.base);
});

test('codex-review: round N > 1 must start at the previous round\'s toHead; any other base is exit 2', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf()), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('fix');
  for (const from of [w.base, head2]) {
    const r = w.codex(2, findingsOf(), { from, to: head2 });
    assertExit(r, 2, `base ${from}`);
    assert.equal(r.json.error, 'base-mismatch');
    assert.match(r.json.message, new RegExp(w.head));
  }
  assert.equal(w.captured().length, 1);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
});

test('codex-review: risk and light lane come from the whole PR on every round, and a growing PR leaves the light lane', (t) => {
  const w = world(t, { light: true });
  assert.equal(w.codex(1, findingsOf()).json.lightLane, true);
  assert.equal(w.state().lightLane, true);
  w.repo.write('src/big.js', Array.from({ length: 80 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head2 = w.repo.commit('grow');
  // round 2 reviews only the 80-line commit, but the PR as a whole is now over the cap; a fix round can never
  // turn the light lane on, and a PR that outgrew it must stop using it
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0);
  assert.equal(r.json.lightLane, false);
  assert.equal(w.state().lightLane, false);
  assert.ok(/Risk level: (low|medium|high)/.test(w.captured()[1].stdin));
});

test('codex-review: a hard-stop file anywhere in the PR makes the risk high (computed from mergeBase..head, not --base)', (t) => {
  const w = world(t);
  w.repo.write('.github/workflows/ci.yml', 'name: x\n');
  const head2 = w.repo.commit('workflow');
  const r = w.codex(1, findingsOf(), { from: w.base, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.state().risk, 'high');
  assert.equal(r.json.lightLane, false);
});

test('codex-review: a finding path that tries to leave the repository reads nothing outside the git tree (reviewer repro R3)', (t) => {
  const w = world(t);
  const f = (file) => finding({ title: `T ${file}`, file });
  assertExit(w.codex(1, findingsOf([f('../../../../../../etc/passwd'), f('/etc/passwd'), f(':/src/a.js'), f('src/../src/a.js')])), 0);
  const needed = w.cli(['arbiter', 'needed', '--round', '1', '--force']);
  assertExit(needed, 0);
  const input = readFileSync(needed.json.inputPath, 'utf8');
  assert.ok(!input.includes('root:') && !input.includes('/bin/'), 'no file outside the repository is quoted');
  assert.equal((input.match(/does not exist at HEAD/g) ?? []).length >= 2, true);
});

// -- the ruled cache

test('codex-review cache: a dismissal is never reused for a finding that came back higher-severity or as a security category', (t) => {
  // Reviewer repro 2: a WORTH CONSIDERING performance FOLLOW-UP was reused for the same text escalated to a
  // BLOCKING security finding, which then looked "ruled" and let the review go clean.
  const w = world(t);
  const idea = (over = {}) => finding({ title: 'Cache grows', file: 'src/a.js', line: 20, category: 'performance', testable: false, ...over });
  assertExit(w.codex(1, findingsOf([], [], [idea()])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');

  const escalated = w.codex(2, findingsOf([idea({ category: 'security' })]), { from: w.head, to: head2 });
  assertExit(escalated, 0, escalated.stderr + escalated.stdout);
  assert.equal(escalated.json.preRuled, 0);
  assert.equal(w.item('R2-B1').final ?? null, null, 'still pending: it must be triaged like a new finding');
  assert.equal(w.cli(['state', 'outcome']).json.clean, false);
  assert.equal(w.cli(['state', 'outcome']).json.openBlocking[0], 'R2-B1');
});

test('codex-review cache: same fingerprint but another bucket or category is reopened; the same bucket and category is reused', (t) => {
  const w = world(t);
  const idea = (over = {}) => finding({ title: 'Cache grows', file: 'src/a.js', line: 20, category: 'performance', testable: false, ...over });
  assertExit(w.codex(1, findingsOf([], [], [idea()])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['REJECT'] }), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');

  const r = w.codex(2, findingsOf([], [idea({ category: 'design' }), idea({ title: 'Cache grows' })], [idea()]), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R2-S1').final ?? null, null, 'other category');
  assert.equal(w.item('R2-S2').final ?? null, null, 'other bucket (SUGGESTION, was WORTH CONSIDERING)');
  assert.equal(w.item('R2-W1').final.by, 'cache', 'identical bucket and category');
});

// -- triage settle

test('triage settle: a needsHuman item stays with the human (reviewer repro R2: a settle used to override it)', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding({ title: 'sec', category: 'security', file: 'src/a.js' })])), 0);
  editState(w, (s) => {
    s.rounds[0].items[0].judge = { decision: 'REJECT', confidence: 'high', reason: 'r', ...DISPUTED };
    s.rounds[0].items[0].final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'would dismiss a blocking security/data item' };
  });
  const before = w.stateText();
  const s = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(s, 1, s.stdout);
  assert.equal(s.json.ok, false);
  assert.match(s.json.reason, /needs a human/);
  assert.equal(w.stateText(), before, 'state untouched');
  assert.equal(w.cli(['state', 'outcome']).json.needsHuman[0], 'R1-B1');
});

test('triage settle: only a disputed bug with a possible settle test and no test result yet can be settled', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding(), finding({ title: 'Second' }), finding({ title: 'Third' }), finding({ title: 'Fourth' }), finding({ title: 'Fifth' })])), 0);
  const judged = (id, extra) => ({ id, decision: 'REJECT', confidence: 'high', reason: 'no', disputedBug: false, settleTest: { possible: false, plan: '' }, ...extra });
  const j = w.file('j.json', { items: [
    judged('R1-B1', DISPUTED), judged('R1-B2', {}), judged('R1-B3', { disputedBug: true }), judged('R1-B4', DISPUTED), judged('R1-B5', DISPUTED),
  ] });
  assertExit(w.cli(['triage', 'validate', '--round', '1', '--file', j]), 0);
  const settle = (id) => w.cli(settleArgs(w, id, 'bug-confirmed'));

  assertExit(settle('R1-B2'), 1, 'the judge did not dispute it as a bug');
  assertExit(settle('R1-B3'), 1, 'disputed, but no settle test is possible');
  editState(w, (s) => { s.rounds[0].items[3].final = { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'x' }; });
  assertExit(settle('R1-B4'), 1, 'the arbiter already ruled');
  editState(w, (s) => { s.rounds[0].items[4].final = { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'x' }; s.rounds[0].items[4].implemented = true; });
  assertExit(settle('R1-B5'), 1, 'already implemented');
  for (const id of ['R1-B2', 'R1-B3', 'R1-B4', 'R1-B5']) assert.equal(w.item(id).test?.status ?? 'none', 'none', id);

  const ok = settle('R1-B1');
  assertExit(ok, 0, ok.stdout);
  assert.equal(w.item('R1-B1').final.by, 'test');
  assertExit(settle('R1-B1'), 1, 'a second result for an item that already has one');
});

// -- follow-ups

test('followups create: a finding already filed (any round, cache reuse or not) is never filed again; needsHuman items wait', (t) => {
  const url = 'https://github.com/acme/widgets/issues/31';
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 31, html_url: url } }] });
  const posts = () => w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues ')).length;
  const idea = (over = {}) => finding({ title: 'Cache grows', file: 'src/a.js', line: 20, category: 'performance', testable: false, ...over });
  assertExit(w.codex(1, findingsOf([], [], [idea()])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  assert.equal(w.cli(['followups', 'create', '--round', '1']).json.created.length, 1);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');

  // round 2 raises it again: once as the identical finding (cache), once under another category that the judge also
  // sends to a follow-up (so its ruling does not come from the cache)
  assertExit(w.codex(2, findingsOf([], [], [idea({ category: 'design' }), idea()]), { from: w.head, to: head2 }), 0);
  assert.equal(w.item('R2-W2').final.by, 'cache');
  assert.equal(w.item('R2-W2').followupIssue, url, 'the issue number travels with the cached ruling');
  assertExit(w.judge(2, { 'R2-W1': ['FOLLOW-UP', 'high'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '2']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, []);
  assert.deepEqual([...r.json.skipped].sort(), ['R2-W1', 'R2-W2']);
  assert.equal(posts(), 1, 'one issue for one fingerprint, across the whole review');
  assert.equal(w.item('R2-W1').followupIssue, url, 'the existing issue is recorded on the item');

  // a follow-up that needs a human is not filed
  editState(w, (s) => {
    s.rounds[1].items.push({ ...s.rounds[1].items[0], id: 'R2-W9', fingerprint: 'other-fp', followupIssue: null, final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, reason: 'low confidence' } });
  });
  const held = w.cli(['followups', 'create', '--round', '2']);
  assertExit(held, 0);
  assert.deepEqual(held.json.created, []);
  assert.deepEqual(held.json.held, ['R2-W9']);
  assert.equal(posts(), 1);
  assert.equal(w.item('R2-W9').followupIssue ?? null, null);
});

// -- review-complete

test('review-complete: refuses when the local HEAD is not the head GitHub holds for the PR', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  w.prHead('0'.repeat(40));
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /HEAD .* is not the head of PR #7/);
  assert.ok(!w.fake.lines().some((l) => l.startsWith('pr edit')), 'no label call');
  w.prHead(w.head);
  assertExit(w.cli(['review-complete', '--pr', '7']), 0);
});

test('review-complete: reads the labels back and exits 3 when awaiting-review is still on the PR', (t) => {
  const w = world(t, { gh: [{ match: '^pr view 7 --json labels', stdoutJson: { labels: [{ name: 'awaiting-review' }, { name: 'agent-build' }] } }, ...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.unavailable, true);
  assert.match(r.json.message ?? r.json.reason, /awaiting-review is still/);
  assert.ok(w.fake.lines().includes('pr edit 7 --remove-label awaiting-review'));
});

test('review-complete: a clean first round does not count once a later round accepted something (R3\')', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  const head1 = w.head; // the world already ignores .review/, so the content hash is only the code
  assertExit(w.codex(1, findingsOf(), { to: head1 }), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  w.prHead(head2);
  assertExit(w.codex(2, findingsOf([finding({ title: 'late bug', file: 'src/c.js', line: 1 })]), { from: head1, to: head2 }), 0);
  assertExit(w.judge(2, { 'R2-B1': ['ACCEPT'] }), 0);
  // the "fix" removes the file again: the branch now has exactly the content round 1 reviewed, and nothing is unresolved
  w.repo.rm('src/c.js');
  const head3 = w.repo.commit('drop it');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R2-B1']), 0);
  w.prHead(head3);
  const outcome = w.cli(['state', 'outcome']).json;
  assert.deepEqual([outcome.pending, outcome.needsHuman, outcome.unimplemented], [[], [], []]);
  assert.equal(outcome.currentContentHash, w.state().rounds[0].contentHashAtToHead, 'same content as round 1');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stdout);
  assert.ok(!w.fake.lines().some((l) => l.startsWith('pr edit')));
});

// -- Codex run: timeout, late writes, empty answers

test('codex-review: a timeout kills Codex AND what it started; a late write from that run is never read', async (t) => {
  const w = world(t);
  const pidFile = join(w.scratch, 'helper.pid');
  const r = w.cli(
    ['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'],
    { PIPELINE_CODEX_TIMEOUT_MS: '700', FAKE_CODEX_HANG: pidFile, FAKE_CODEX_OUTPUT: w.file('late.json', findingsOf([finding()])) },
  );
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.unavailable, true);
  assert.equal(r.json.timedOut, true);
  assert.equal(r.json.reason, 'unavailable');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 3000)); // the helper would have written its answer at 2 s
  assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'the helper process is gone');
  assert.ok(!existsSync(w.roundFile(1, 'codex-raw.json')), 'nothing was written after the timeout');
  assert.ok(noState(w));
});

test('codex-review: an answer whose summary is empty or whitespace is exit 3 malformed', (t) => {
  const w = world(t);
  for (const summary of ['', '   \n\t']) {
    const r = w.codex(1, { summary, blocking: [], suggestions: [], worth_considering: [] });
    assertExit(r, 3, JSON.stringify(summary));
    assert.equal(r.json.reason, 'malformed');
    assert.ok(r.json.errors.some((e) => /summary/.test(e)));
  }
  assert.ok(noState(w));
});

// -- concurrency

test('codex-review: a round recorded while Codex was running is not overwritten (exit 2, the recorded round stays)', (t) => {
  const w = world(t);
  const mine = w.file('mine.json', findingsOf());
  const theirs = w.file('theirs.json', findingsOf([finding()]));
  const during = `node "${bin}" codex-review --pr 7 --round 1 --base ${w.base} --head ${w.head} --effort high`;
  const r = w.cli(
    ['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'],
    { FAKE_CODEX_OUTPUT: mine, FAKE_CODEX_DURING: during, FAKE_CODEX_DURING_OUTPUT: theirs },
  );
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'round-order');
  assert.match(r.json.message, /already exists/);
  assert.equal(w.state().rounds.length, 1);
  assert.deepEqual(w.state().rounds[0].items.map((i) => i.id), ['R1-B1'], 'the round that got there first is intact');
});

test('every command that changes the review state waits for the per-PR lock (and gives up with exit 2 lock-timeout)', async (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.needed, true);
  const judgeFile = w.file('j2.json', { items: [] });
  const { tryAcquire, release } = await import('../pipeline/lib/locks.mjs');
  const { repoRoot } = await import('../pipeline/lib/repo.mjs');
  const { reviewLockName } = await import('../pipeline/lib/review-context.mjs');
  const name = reviewLockName(repoRoot(w.repo.dir), 7);
  assert.match(name, /^review-[0-9a-f]{12}-pr7$/);
  const held = tryAcquire(name, { dir: w.lockDir });
  assert.equal(held.acquired, true);
  const before = w.stateText();
  const env = { PIPELINE_LOCK_WAIT_MS: '250' };
  const mutating = [
    ['triage', 'validate', '--round', '1', '--file', judgeFile],
    ['triage', 'settle', '--id', 'R1-B1', '--result', 'bug-confirmed', '--test-cmd', 'node src/p.test.js', '--test-file', 'src/p.test.js'],
    ['triage', 'light-lane', '--round', '1'],
    ['arbiter', 'needed', '--round', '1'],
    ['arbiter', 'apply', '--round', '1', '--tag', 'whatever'],
    ['state', 'show'],
    ['state', 'mark-implemented', '--ids', 'R1-B1'],
    ['state', 'record-followup', '--id', 'R1-W1', '--url', 'https://example.com/1'],
    ['state', 'set-outcome', '--outcome', 'x'],
    ['followups', 'create', '--round', '1'],
    ['review-complete', '--pr', '7'],
  ];
  try {
    for (const args of mutating) {
      const r = w.cli(args, env);
      assertExit(r, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.json.error, 'lock-timeout', args.join(' '));
      assert.equal(w.stateText(), before, `${args.join(' ')} changed the state while the lock was held`);
    }
    const calls = w.captured().length;
    w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
    const head2 = w.repo.commit('fix');
    const cr = w.cli(['codex-review', '--pr', '7', '--round', '2', '--base', w.head, '--head', head2, '--effort', 'high'], { ...env, FAKE_CODEX_OUTPUT: w.file('r2.json', findingsOf()) });
    assertExit(cr, 2, cr.stdout);
    assert.equal(cr.json.error, 'lock-timeout');
    assert.equal(w.captured().length, calls + 1, 'Codex ran without the lock; only recording the round needs it');
    const readOnly = w.cli(['state', 'outcome'], env);
    assertExit(readOnly, 0, 'a read-only command does not need the lock');
  } finally {
    release(held.lock);
  }
  assertExit(w.cli(['state', 'set-outcome', '--outcome', 'done']), 0, 'free again once released');
});

test('codex-review: takes the lock only AFTER Codex answered, and gives up with lock-timeout when it is held then', async (t) => {
  const w = world(t);
  const { tryAcquire, release } = await import('../pipeline/lib/locks.mjs');
  const { repoRoot } = await import('../pipeline/lib/repo.mjs');
  const { reviewLockName } = await import('../pipeline/lib/review-context.mjs');
  const held = tryAcquire(reviewLockName(repoRoot(w.repo.dir), 7), { dir: w.lockDir });
  try {
    const r = w.codex(1, findingsOf(), { env: { PIPELINE_LOCK_WAIT_MS: '250' } });
    assert.equal(w.captured().length, 1, 'Codex ran without waiting for the lock');
    assertExit(r, 2, r.stdout);
    assert.equal(r.json.error, 'lock-timeout');
    assert.ok(noState(w));
  } finally {
    release(held.lock);
  }
});

// -- the arbiter proof stays pinned

test('arbiter apply: --expect-model / --expect-effort are test switches; a normal run is always pinned to claude-fable- at effort high', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const asked = ['--expect-model', 'claude-opus-', '--expect-effort', 'low'];
  assertAllNeedHuman(w, arbiterRun(w, { model: 'claude-opus-5-1', effort: 'low', extraArgs: asked }), /unexpected model claude-opus-5-1/);

  const w2 = readyForArbiter(t);
  w2.cli(['arbiter', 'needed', '--round', '1']);
  const honoured = arbiterRun(w2, { model: 'claude-opus-5-1', effort: 'low', extraArgs: asked, env: { PIPELINE_TEST_MODE: '1' } });
  assertExit(honoured, 0, honoured.stdout);
  assert.equal(honoured.json.ok, true);
});

test('arbiter apply: an installed copy ignores PIPELINE_TEST_MODE (with a warning); the proof stays pinned', (t) => {
  const installed = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-installed-'))), 'pipeline');
  t.after(() => rmSync(join(installed, '..'), { recursive: true, force: true }));
  cpSync(join(here, '..', 'pipeline'), installed, { recursive: true });
  writeFileSync(join(installed, 'INSTALLED.json'), '{}');
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const asked = ['--expect-model', 'claude-opus-', '--expect-effort', 'low'];
  const r = arbiterRun(w, { model: 'claude-opus-5-1', effort: 'low', extraArgs: asked, env: { PIPELINE_TEST_MODE: '1', TEST_BIN: join(installed, 'bin', 'pipeline.mjs') } });
  assertAllNeedHuman(w, r, /unexpected model claude-opus-5-1/);
  assert.match(r.stderr, /ignoring PIPELINE_TEST_MODE/);
});

test('arbiter apply: PIPELINE_ARBITER_MODEL_OVERRIDE never relaxes the proof, not even for a model that looks right', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const r = arbiterRun(w, { meta: { model: 'claude-fable-5-1' }, env: { PIPELINE_ARBITER_MODEL_OVERRIDE: 'claude-fable-5-1' } });
  assertAllNeedHuman(w, r, /per-call model override present: claude-fable-5-1/);
  assert.match(w.item('R1-S1').final.reason, /model-proof/);
});

// -- an accepted BLOCKING item cannot be "resolved" without a code change

test('an accepted BLOCKING item cannot be marked implemented with no code change, nor cleared by an empty review round', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);

  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(marked, 2, marked.stdout);
  assert.equal(marked.json.error, 'no-code-change');
  assert.ok(!w.item('R1-B1').implemented);

  // Even if it were marked, a round over the empty range would review nothing.
  const empty = w.codex(2, findingsOf(), { from: w.head, to: w.head });
  assertExit(empty, 2, empty.stdout);
  assert.equal(empty.json.error, 'empty-range');
  assert.equal(w.state().rounds.length, 1, 'no round was recorded');
  assert.equal(w.captured().length, 1, 'Codex was not even run for the empty range');
  assert.equal(w.cli(['state', 'outcome']).json.clean, false);
});

test('codex-review: a later round whose content is unchanged since the last round is refused when items were accepted; a real fix passes', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  // An empty commit moves HEAD but not the content.
  w.repo.git(['commit', '-q', '--allow-empty', '-m', 'nothing']);
  const head2 = w.repo.git(['rev-parse', 'HEAD']).trim();
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'empty-range');

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head3 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head3 }), 0);
});

test('mark-implemented: a commit that only adds or edits tests is not a fix; a source change is', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  w.repo.write('src/a.test.js', "test('null x', () => {});\n");
  w.repo.git(['add', 'src/a.test.js']); // just the test: the untracked .review/ state stays out
  w.repo.git(['commit', '-q', '-m', 'test only']);
  const testOnly = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(testOnly, 2, testOnly.stdout);
  assert.equal(testOnly.json.error, 'no-code-change');
  assert.match(testOnly.json.message, /only test files/);
  assert.ok(!w.item('R1-B1').implemented);

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.ok(w.item('R1-B1').implemented);
});

test('mark-implemented: a testing finding is fixed by a test-only commit; a bug finding still is not (#53)', (t) => {
  const w = world(t);
  const testing = finding({ title: 'Cover the old-code path', file: 'src/a.js', category: 'testing' });
  assertExit(w.codex(1, findingsOf([finding()], [testing])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'], 'R1-S1': ['ACCEPT'] }), 0);
  w.repo.write('src/a.test.js', "test('old path', () => {});\n");
  w.repo.git(['add', 'src/a.test.js']);
  w.repo.git(['commit', '-q', '-m', 'test only']);

  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-S1']);
  assertExit(marked, 0, marked.stderr + marked.stdout);
  assert.ok(w.item('R1-S1').implemented);
  const bug = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(bug, 2, bug.stdout);
  assert.equal(bug.json.error, 'no-code-change', 'the same test-only commit never clears a bug finding');
  assert.ok(!w.item('R1-B1').implemented);
});

test('mark-implemented: a fix to the finding\'s own file counts even under a test glob; another test file does not (#53)', (t) => {
  const w = world(t);
  w.repo.write('e2e/fixtures/env.ts', 'export const env = {};\n');
  const head = w.repo.commit('add a launch helper');
  assertExit(w.codex(1, findingsOf([finding({ file: 'e2e/fixtures/env.ts' })]), { to: head }), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);

  w.repo.write('e2e/other.spec.ts', "test('x', () => {});\n");
  w.repo.git(['add', 'e2e/other.spec.ts']);
  w.repo.git(['commit', '-q', '-m', 'another test']);
  const other = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(other, 2, other.stdout);
  assert.equal(other.json.error, 'no-code-change');

  w.repo.write('e2e/fixtures/env.ts', 'export const env = { TZ: "UTC" };\n');
  w.repo.git(['add', 'e2e/fixtures/env.ts']);
  w.repo.git(['commit', '-q', '-m', 'fix the helper']);
  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(marked, 0, marked.stderr + marked.stdout);
  assert.ok(w.item('R1-B1').implemented);
});

test('codex-review: with nothing accepted, a later round over an unchanged tree is still allowed', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT'] }), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: w.head }), 0);
});

// -- triage settle: the pipeline runs the proving test itself

// A world whose R1-B1 is a disputed BLOCKING bug (or security item) a test can decide.
function disputedWorld(t, category = 'bug') {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding({ category })])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT', 'high', DISPUTED] }), 0);
  return w;
}

test('triage settle: the CLI runs the test; the command, file, exit code and head are recorded with the output', (t) => {
  const w = disputedWorld(t);
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved', { output: 'compute(undefined) is 0' }));
  assertExit(r, 0, r.stdout + r.stderr);
  const rec = w.item('R1-B1').test;
  assert.equal(rec.status, 'bug-disproved');
  assert.equal(rec.cmd, 'node src/proof.test.js');
  assert.equal(rec.file, 'src/proof.test.js');
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.head, w.repo.git(['rev-parse', 'HEAD']).trim());
  assert.match(rec.evidence, /compute\(undefined\) is 0/);
  assert.equal(w.item('R1-B1').final.needsHuman, false, 'a non-security dismissal by test is final');
});

test('triage settle: a passing test cannot confirm a bug, a failing test cannot disprove one (state untouched)', (t) => {
  const w = disputedWorld(t);
  const before = () => w.stateText();
  const snapshot = before();
  const disproveFail = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved', { code: 1 }));
  assertExit(disproveFail, 1, disproveFail.stdout);
  assert.match(disproveFail.json.reason, /needs the test to pass/);
  const confirmPass = w.cli(settleArgs(w, 'R1-B1', 'bug-confirmed', { code: 0 }));
  assertExit(confirmPass, 1, confirmPass.stdout);
  assert.match(confirmPass.json.reason, /needs the test to fail/);
  assert.equal(before(), snapshot);
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: a test that cannot be trusted as proof is refused before anything runs', (t) => {
  const w = disputedWorld(t);
  const snapshot = w.stateText();
  const base = ['triage', 'settle', '--id', 'R1-B1', '--result', 'bug-disproved'];
  // Not in the PR head.
  w.repo.write('src/x.test.js', 'process.exit(0);\n');
  const notCommitted = w.cli([...base, '--test-cmd', 'node src/x.test.js', '--test-file', 'src/x.test.js']);
  assertExit(notCommitted, 1, notCommitted.stdout);
  assert.match(notCommitted.json.reason, /not in the PR head/);
  // Committed, then edited: the run would not prove the head.
  w.repo.commit('add x test');
  w.repo.write('src/x.test.js', 'process.exit(1);\n');
  const dirty = w.cli([...base, '--test-cmd', 'node src/x.test.js', '--test-file', 'src/x.test.js']);
  assert.match(dirty.json.reason, /uncommitted changes/);
  w.repo.write('src/x.test.js', 'process.exit(0);\n');
  // Not a test file, command that does not run it, file that does not exist.
  const notTest = w.cli([...base, '--test-cmd', 'node src/a.js', '--test-file', 'src/a.js']);
  assert.match(notTest.json.reason, /not a test file/);
  const notNamed = w.cli([...base, '--test-cmd', 'true', '--test-file', 'src/x.test.js']);
  assert.match(notNamed.json.reason, /must run --test-file/);
  const missing = w.cli([...base, '--test-cmd', 'node src/none.test.js', '--test-file', 'src/none.test.js']);
  assert.match(missing.json.reason, /not in the PR head/);
  for (const r of [notCommitted, dirty, notTest, notNamed, missing]) assertExit(r, 1);
  w.repo.rm('src/x.test.js');
  assert.equal(w.item('R1-B1').test, undefined);
  assert.equal(w.stateText(), snapshot);
});

test('triage settle: a command that cannot run (127) is not a failing test and confirms nothing', (t) => {
  const w = disputedWorld(t);
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-confirmed', { cmd: 'definitely-not-a-command-xyz src/proof.test.js' }));
  assertExit(r, 1, r.stdout);
  assert.match(r.json.reason, /could not be run/);
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: a passing test that dismisses a security item still goes to a human (needsHuman), never skipping that rule', (t) => {
  const w = disputedWorld(t, 'security');
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(r, 0, r.stdout + r.stderr);
  const final = w.item('R1-B1').final;
  assert.equal(final.decision, 'REJECT');
  assert.equal(final.by, 'test');
  assert.equal(final.needsHuman, true);
  assert.deepEqual(w.cli(['state', 'outcome']).json.needsHuman, ['R1-B1']);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false);
  // Confirming a security bug by a failing test is the safe direction and stays automatic.
  const w2 = disputedWorld(t, 'auth');
  assertExit(w2.cli(settleArgs(w2, 'R1-B1', 'bug-confirmed')), 0);
  assert.equal(w2.item('R1-B1').final.needsHuman, false);
  assert.equal(w2.item('R1-B1').final.decision, 'ACCEPT');
});

// ---- review replay: published state wins (state show --pr, discard-round) ---------------------------------

const ISSUES_URL = '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=30 --paginate';
const COMMENTS = (...comments) => [
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: comments },
];
const mine = (state, id = 9) => ({ id, user: { login: 'me' }, body: triageComment(state) });

// A local one-round review (codex + judge) whose triage comment is already on the PR: the fake GitHub is scripted with the
// state this very world produced, so heads and hashes agree whatever the clock did.
function publishedWorld(t) {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const published = w.state();
  const script = JSON.parse(readFileSync(join(w.fake.dir, 'script.json'), 'utf8'));
  w.fake.setScript([...script, ...COMMENTS(mine(published))]);
  return { w, published };
}
const staleDirs = (w) => readdirSync(join(w.repo.dir, '.review')).filter((n) => n.startsWith('stale-'));

test('state show --pr: equal local and published state is served from local, nothing moved', (t) => {
  const { w, published } = publishedWorld(t);
  assert.deepEqual(w.state(), published, 'precondition: the two worlds produced the same state');
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.source, r.json.recovered, r.json.quarantinedTo], ['local', false, undefined]);
  assert.deepEqual(staleDirs(w), []);
});

test('state show --pr: a lost local state is rebuilt with source published', (t) => {
  const { w: src, published } = publishedWorld(t);
  const w = world(t, { gh: [...GH, ...COMMENTS(mine(published))] });
  assert.ok(src);
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.source, r.json.recovered], ['published', true]);
});

test('state show (no --pr) never asks GitHub and reports source local', (t) => {
  const { w } = publishedWorld(t);
  const before = w.fake.calls().length;
  const r = w.cli(['state', 'show']);
  assertExit(r, 0);
  assert.equal(r.json.source, 'local');
  assert.equal(w.fake.calls().length, before);
});

test('state show --pr: GitHub unavailable with a local state serves it as local-unverified with a warning; with no local state it stays exit 3', (t) => {
  const { w, published } = publishedWorld(t);
  const down = [{ match: '.', code: 1, stderr: 'HTTP 502' }];
  w.fake.setScript(down);
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.source, 'local-unverified');
  assert.equal(r.json.recovered, false);
  assert.equal(r.json.pr, 7);
  assert.equal(r.json.count, 4);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /GitHub unavailable/);
  assert.deepEqual(w.state(), published, 'the local state is served, never rewritten or moved');
  assert.deepEqual(staleDirs(w), []);
  // nothing local to fall back to: still unavailable
  const none = world(t, { gh: down });
  assertExit(none.cli(['state', 'show', '--pr', '7']), 3);
});

test('state show --pr: local that strictly extends the published state (an unpublished round 2) is kept', (t) => {
  const { w, published } = publishedWorld(t);
  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.source, 'local');
  assert.equal(w.state().rounds.length, 2);
  assert.deepEqual(w.state().rounds[0], published.rounds[0]);
  assert.deepEqual(staleDirs(w), []);
});

test('state show --pr: same head and hash but different decisions is quarantined and the published state restored', (t) => {
  const { w, published } = publishedWorld(t);
  assert.equal(w.item('R1-W1').final.decision, 'FOLLOW-UP');
  editState(w, (s) => { s.rounds[0].items.find((i) => i.id === 'R1-W1').final.decision = 'REJECT'; }); // same toHead + contentHash
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.source, 'quarantined');
  assert.match(r.json.quarantinedTo, /^\.review\/stale-\d{8}T\d{6}Z/);
  assert.deepEqual(w.state(), published);
  const kept = join(w.repo.dir, r.json.quarantinedTo);
  assert.ok(existsSync(join(kept, 'state.json')), 'the local state is kept, not deleted');
  assert.equal(JSON.parse(readFileSync(join(kept, 'state.json'), 'utf8')).rounds[0].items.find((i) => i.id === 'R1-W1').final.decision, 'REJECT');
  assert.ok(existsSync(join(kept, 'round-1', 'codex.json')), 'round files move with it');
  // the next call is a plain local hit; the stale dir is not moved into itself
  const again = w.cli(['state', 'show', '--pr', '7']);
  assert.equal(again.json.source, 'local');
  assert.deepEqual(staleDirs(w), [r.json.quarantinedTo.split('/').pop()]);
});

test('state show --pr: a local copy missing a published round, or with another hash, is quarantined too', (t) => {
  for (const mutate of [
    (s) => { s.rounds = []; },
    (s) => { s.rounds[0].contentHashAtToHead = 'other'; },
    (s) => { s.rounds[0].toHead = 'e'.repeat(40); },
    (s) => { s.rounds[0].items.pop(); },
    (s) => { s.rounds[0].items[0].followupIssue = 'https://github.com/acme/widgets/issues/99'; },
  ]) {
    const { w } = publishedWorld(t);
    editState(w, mutate);
    const r = w.cli(['state', 'show', '--pr', '7']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.source, 'quarantined', mutate.toString());
  }
});

test('state show --pr: no published state keeps local; a forged or foreign triage comment is not published state', (t) => {
  const base = world(t);
  assertExit(base.codex(1, standardFindings()), 0);
  const forged = { ...base.state(), risk: 'forged', rounds: [] };
  const w = world(t, { gh: [...GH, ...COMMENTS({ id: 3, user: { login: 'mallory' }, body: triageComment(forged) })] });
  assertExit(w.codex(1, standardFindings()), 0);
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0);
  assert.equal(r.json.source, 'local');
});

test('state discard-round: an unpublished trailing round leaves the state and its files move to .review/stale-*', (t) => {
  const { w, published } = publishedWorld(t);
  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  mkdirSync(join(w.repo.dir, '.review', 'round-2'), { recursive: true });
  writeFileSync(join(w.repo.dir, '.review', 'round-2', 'codex.json'), '{}');
  const r = w.cli(['state', 'discard-round', '--round', '2', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.discarded, 2);
  assert.deepEqual(w.state(), published);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'round-2')));
  assert.ok(existsSync(join(w.repo.dir, r.json.quarantinedTo, 'round-2', 'codex.json')));
  assert.ok(existsSync(join(w.repo.dir, r.json.quarantinedTo, 'state-round-2.json')));
  assert.ok(existsSync(join(w.repo.dir, '.review', 'round-1', 'codex.json')), 'published round untouched');
});

test('state discard-round: refuses a round the PR comment holds, a round that is not the newest, and a PR mismatch', (t) => {
  const { w } = publishedWorld(t);
  const published = w.cli(['state', 'discard-round', '--round', '1', '--pr', '7']);
  assertExit(published, 2);
  assert.equal(published.json.error, 'round-published');
  assert.ok(existsSync(join(w.repo.dir, '.review', 'round-1', 'codex.json')));
  assert.equal(w.state().rounds.length, 1);
  assert.deepEqual(staleDirs(w), []);

  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  assertExit(w.cli(['state', 'discard-round', '--round', '1', '--pr', '7']), 2);
  assert.equal(w.cli(['state', 'discard-round', '--round', '9', '--pr', '7']).json.error, 'no-round');
  assert.equal(w.cli(['state', 'discard-round', '--round', '2', '--pr', '8']).json.error, 'state-pr-mismatch');
  assertExit(w.cli(['state', 'discard-round']), 2);
  assert.match(w.cli(['state', 'bogus']).stdout + w.cli(['state', 'bogus']).stderr, /discard-round/);
});

test('state discard-round: a gh outage is exit 3 and nothing is moved', (t) => {
  const { w } = publishedWorld(t);
  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  w.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 502' }]);
  assertExit(w.cli(['state', 'discard-round', '--round', '2', '--pr', '7']), 3);
  assert.equal(w.state().rounds.length, 2);
  assert.deepEqual(staleDirs(w), []);
});

// ---- followupsPending (state outcome) ----------------------------------------------------------------------

test('state outcome: followupsPending is true until every ready FOLLOW-UP has an issue; a held one never counts', (t) => {
  const url = 'https://github.com/acme/widgets/issues/11';
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 11, html_url: url } }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false, 'undecided is not a pending follow-up');
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, true);
  assertExit(w.cli(['followups', 'create', '--round', '1']), 0);
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false);
  editState(w, (s) => { s.rounds[0].items[0].followupIssue = null; s.rounds[0].items[0].final.needsHuman = true; });
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false, 'needsHuman follow-ups are held, not pending');
});

// ---- followups create: marker dedupe ----------------------------------------------------------------------

const FP_ISSUE = (w) => `${'<!-- claude-pipeline:followup pr=7 fp='}${w.item('R1-W1').fingerprint} -->`;
const issue = (number, body, over = {}) => ({ number, html_url: `https://github.com/acme/widgets/issues/${number}`, state: 'open', body, user: { login: 'me' }, ...over });

function followupWorld(t, issues, { post = { number: 50, html_url: 'https://github.com/acme/widgets/issues/50' } } = {}) {
  const w = world(t, {
    gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: ISSUES_URL, stdoutJson: issues }, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: post }],
  });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  return w;
}
const posts = (w) => w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues '));

test('followups create: no marker issue yet creates one whose body starts with the marker', (t) => {
  const w = followupWorld(t, [issue(3, 'unrelated suggestion')]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.created.length, 1);
  assert.deepEqual([r.json.reused, r.json.duplicates], [[], []]);
  assert.ok(JSON.parse(posts(w)[0].stdin).body.startsWith(`${FP_ISSUE(w)}\n`));
});

test('followups create: one existing issue of ours with the marker is reused, even when it is closed', (t) => {
  const w0 = followupWorld(t, []);
  const marker = FP_ISSUE(w0);
  for (const state of ['open', 'closed']) {
    const w = followupWorld(t, [issue(41, `${marker}\nbody`, { state })]);
    // same fingerprint in a fresh world: the finding text is identical
    const r = w.cli(['followups', 'create', '--round', '1']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json.created, [], state);
    assert.deepEqual(r.json.reused, [{ id: 'R1-W1', number: 41, url: 'https://github.com/acme/widgets/issues/41' }]);
    assert.equal(posts(w).length, 0);
    assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/41', 'recorded like a created one');
    assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false);
  }
});

test('followups create: several marker issues: the lowest number is canonical, the rest are listed and never closed', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const w = followupWorld(t, [issue(60, `${marker}\nb`), issue(44, `${marker}\na`, { state: 'closed' }), issue(52, `${marker}\nc`)]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.reused[0].number, 44);
  assert.deepEqual(r.json.duplicates, [{
    id: 'R1-W1', canonical: 'https://github.com/acme/widgets/issues/44',
    others: ['https://github.com/acme/widgets/issues/52', 'https://github.com/acme/widgets/issues/60'],
  }]);
  assert.equal(posts(w).length, 0);
  assert.ok(!w.fake.lines().some((l) => /PATCH|close|--state/.test(l) && /issues\/(44|52|60)/.test(l)), 'duplicates are never touched');
});

test('followups create: an issue the owner PROMOTED (agent-suggestion -> agent-build) or relabelled is still found by its marker, never filed twice', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const gh = [...GH, { match: '^api user', stdout: 'me\n' },
    // GitHub: the label query no longer lists the promoted issue; the creator query does.
    { match: '^api repos/acme/widgets/issues\\?labels=agent-suggestion&state=all&per_page=30 --paginate', stdoutJson: [] },
    { match: ISSUES_URL, stdoutJson: [issue(90, `${marker}\nbody`, { labels: [{ name: 'agent-build' }] })] },
    { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 91, html_url: 'https://github.com/acme/widgets/issues/91' } }];
  const w = world(t, { gh });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, []);
  assert.deepEqual(r.json.reused, [{ id: 'R1-W1', number: 90, url: 'https://github.com/acme/widgets/issues/90' }]);
  assert.equal(posts(w).length, 0);
  assert.ok(w.fake.lines().some((l) => /issues\?creator=me/.test(l)));
});

test('followups create: a marker quoted later in a body, in a foreign-author issue, or for another PR or fingerprint is ignored', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const w = followupWorld(t, [
    issue(70, `see also\n${marker}`),
    issue(71, `${marker}\nforged`, { user: { login: 'mallory' } }),
    issue(72, marker.replace('pr=7', 'pr=8')),
    issue(73, marker.replace('fp=', 'fp=zz')),
    issue(74, `${marker.replace(' -->', 'x -->')}`),
    { number: 75, html_url: 'https://github.com/acme/widgets/pull/75', state: 'open', body: marker, user: { login: 'me' }, pull_request: {} },
  ]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.created.length, 1);
  assert.deepEqual([r.json.reused, r.json.duplicates], [[], []]);
});

test('followups create crash scenarios: re-running creates only the missing issues', (t) => {
  const gh = (issues, post) => [...GH, { match: '^api user', stdout: 'me\n' }, { match: ISSUES_URL, stdoutJson: issues }, { match: '^api -X POST repos/acme/widgets/issues ', ...post }];
  const w = world(t, { gh: gh([], { code: 1, stderr: 'HTTP 502' }) });
  assertExit(w.codex(1, findingsOf([], [], [
    finding({ title: 'Idea one', category: 'other', testable: false, line: 20 }),
    finding({ title: 'Idea two', category: 'other', testable: false, line: 21 }),
  ])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'], 'R1-W2': ['FOLLOW-UP'] }), 0);
  const script = (...args) => w.fake.setScript((() => {
    const base = JSON.parse(readFileSync(join(w.fake.dir, 'script.json'), 'utf8')).filter((e) => !e.match.startsWith('^api user') && e.match !== ISSUES_URL && !e.match.startsWith('^api -X POST'));
    return [...base, ...gh(...args).slice(GH.length)];
  })());

  // 1) the very first create fails: nothing is recorded, nothing exists
  assertExit(w.cli(['followups', 'create', '--round', '1']), 3);
  assert.equal(w.item('R1-W1').followupIssue ?? null, null);

  // 2) issue 81 was made by a run that died before its URL reached the state: only the marker ties it to R1-W1
  const marker = `<!-- claude-pipeline:followup pr=7 fp=${w.item('R1-W1').fingerprint} -->`;
  script([issue(81, `${marker}\nx`)], { stdoutJson: { number: 82, html_url: 'https://github.com/acme/widgets/issues/82' } });
  const before = posts(w).length;
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.reused.map((x) => x.id), ['R1-W1']);
  assert.deepEqual(r.json.created.map((x) => x.id), ['R1-W2'], 'only the missing one is created');
  assert.equal(posts(w).length - before, 1);
  assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/81');
  assert.equal(w.item('R1-W2').followupIssue, 'https://github.com/acme/widgets/issues/82');

  // 3) state published, then the first issue created and the second create dies: the recorded one is not filed twice
  editState(w, (st) => { st.rounds[0].items.find((i) => i.id === 'R1-W2').followupIssue = null; });
  script([issue(81, `${marker}\nx`)], { code: 1, stderr: 'HTTP 502' });
  assertExit(w.cli(['followups', 'create', '--round', '1']), 3);
  assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/81', 'the first stays recorded');
  assert.equal(w.item('R1-W2').followupIssue ?? null, null);

  // 4) everything filed: a further run is a no-op
  script([], { stdoutJson: { number: 83, html_url: 'https://github.com/acme/widgets/issues/83' } });
  const done = w.cli(['followups', 'create', '--round', '1']);
  assert.deepEqual(done.json.created.map((x) => x.id), ['R1-W2']);
  const again = w.cli(['followups', 'create', '--round', '1']);
  assert.deepEqual([again.json.created, again.json.reused, again.json.skipped.sort()], [[], [], ['R1-W1', 'R1-W2']]);
});

test('followups create: an issue-list outage is exit 3 and nothing is filed', (t) => {
  const w = world(t, { gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: ISSUES_URL, code: 1, stderr: 'HTTP 502' }, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 1, html_url: 'https://x.test/1' } }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  assertExit(w.cli(['followups', 'create', '--round', '1']), 3);
  assert.equal(posts(w).length, 0, 'never create blind when the duplicate check could not run');
});

// ---- model proofs travel in the state ---------------------------------------------------------------------

test('summary reads model proofs from the state rounds, the files only as a fallback', (t) => {
  const url = 'https://github.com/acme/widgets/pull/7#issuecomment-5';
  const w = world(t, {
    gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: 'issues/7/comments --paginate', stdoutJson: [] },
      { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 5, html_url: url } }],
  });
  assertExit(w.codex(1, findingsOf()), 0);
  editState(w, (s) => { s.rounds[0].modelProof = { transcript: '/t/from-state.jsonl', models: { 'claude-fable-5-1': 2 }, effort: 'high' }; });
  const body = () => JSON.parse(w.fake.calls().filter((c) => c.argv.join(' ').includes('/comments ')).at(-1).stdin).body;
  assertExit(w.cli(['summary', '--pr', '7', '--outcome', 'merged']), 0);
  assert.ok(body().includes('from-state.jsonl'), 'proof comes from the state although no model-proof.json exists');

  // a state without the proof falls back to the file
  editState(w, (s) => { delete s.rounds[0].modelProof; });
  writeFileSync(w.roundFile(1, 'model-proof.json'), JSON.stringify({ ok: true, transcript: '/t/from-file.jsonl', models: { 'claude-fable-5-1': 1 }, efforts: { high: 1 } }));
  assertExit(w.cli(['summary', '--pr', '7', '--outcome', 'merged']), 0);
  assert.ok(body().includes('from-file.jsonl'));
});

// ---- triage owner-ruling (owner_approval: chat) -----------------------------------------------

const CHAT_YML = `${pipelineYml()}owner_approval: chat\n`;
const QUOTE = 'Yes, file it as a follow-up, not part of this PR.';

// A round whose listed items an arbiter left waiting for a human (what `arbiter apply` does on a failed model proof).
function waitingForHuman(w, decisions) {
  const state = w.state();
  for (const item of state.rounds[0].items) {
    if (decisions[item.id]) item.final = { decision: decisions[item.id], by: 'arbiter', needsHuman: true, reason: 'model-proof failed' };
  }
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), JSON.stringify(state));
}
const rule = (id, decision, { quote = QUOTE, reason = 'owner confirmed in chat', extra = [] } = {}) =>
  ['triage', 'owner-ruling', '--round', '1', '--id', id, '--decision', decision, '--reason', reason, '--owner-quote', quote, ...extra];

test('triage owner-ruling: refused in label mode, for an item that needs no human, a missing item, an empty quote or reason', (t) => {
  const label = world(t);
  assertExit(label.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(label, { 'R1-B1': 'FOLLOW-UP' });
  const refused = label.cli(rule('R1-B1', 'FOLLOW-UP'));
  assertExit(refused, 1);
  assert.match(refused.json.reason, /owner_approval: chat/);
  assert.equal(label.item('R1-B1').final.by, 'arbiter', 'state untouched');

  const w = world(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'], 'R1-S1': ['ACCEPT'] }), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  const settledItem = w.cli(rule('R1-S1', 'ACCEPT'));
  assertExit(settledItem, 1);
  assert.match(settledItem.json.reason, /does not need a human/);
  assert.equal(w.item('R1-S1').final.by, 'judge');
  const missing = w.cli(rule('R1-X9', 'REJECT'));
  assertExit(missing, 1);
  assert.match(missing.json.reason, /no item R1-X9 in round 1/);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: '   ' })), 1);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { reason: ' ' })), 1);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: 'x'.repeat(1001) })), 1);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { extra: ['--pr', '99'] })), 1, 'a PR number that is not the review state\'s');
  assertExit(w.cli(rule('R1-B1', 'MAYBE')), 2);
  assertExit(w.cli(['triage', 'owner-ruling', '--round', '1', '--id', 'R1-B1', '--decision', 'REJECT', '--reason', 'r']), 2, 'no --owner-quote at all');
  assertExit(w.cli(['triage', 'owner-ruling', '--round', '9', '--id', 'R1-B1', '--decision', 'REJECT', '--reason', 'r', '--owner-quote', 'q']), 2);
  assert.equal(w.item('R1-B1').final.by, 'arbiter', 'every refusal left the state untouched');
});

test('triage owner-ruling: records the owner ruling, keeps the overruled final, and clears the needs-human block', (t) => {
  const w = world(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-S1': 'REJECT' });
  assert.deepEqual(w.cli(['state', 'outcome']).json.needsHuman, ['R1-B1', 'R1-S1']);

  const r = w.cli(rule('R1-B1', 'FOLLOW-UP', { extra: ['--pr', '7'] }));
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  const final = w.item('R1-B1').final;
  assert.deepEqual({ ...final, ruledAt: undefined }, {
    decision: 'FOLLOW-UP', by: 'owner', needsHuman: false, reason: 'owner confirmed in chat', ownerQuote: QUOTE, ruledAt: undefined,
    overruled: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, reason: 'model-proof failed' },
  });
  assert.ok(!Number.isNaN(Date.parse(final.ruledAt)));
  assert.deepEqual(r.json.final, final);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'one item still waits');
  assertExit(w.cli(rule('R1-S1', 'REJECT')), 0);
  const outcome = w.cli(['state', 'outcome']).json;
  assert.deepEqual(outcome.needsHuman, []);
  assert.equal(outcome.clean, true, JSON.stringify(outcome));
  assertExit(w.cli(rule('R1-S1', 'ACCEPT')), 1, 'an item the owner already ruled is settled: no second ruling');
});

test('triage owner-ruling: ACCEPT stays unclean until the fix is built and a later round reviews it', (t) => {
  const w = world(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'REJECT' });
  assertExit(w.cli(rule('R1-B1', 'ACCEPT')), 0);
  assert.notEqual(w.item('R1-B1').implemented, true, 'ACCEPT still has to be built');
  const open = w.cli(['state', 'outcome']).json;
  assert.equal(open.clean, false);
  assert.deepEqual(open.unimplemented, ['R1-B1']);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'built but not yet re-reviewed');
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  assert.equal(w.cli(['state', 'outcome']).json.clean, true);
});

test('triage owner-ruling: works on a published round, and a state rebuilt from the triage comment keeps the ruling', (t) => {
  const w0 = world(t, { yml: CHAT_YML });
  assertExit(w0.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w0, { 'R1-B1': 'FOLLOW-UP' });
  assertExit(w0.cli(rule('R1-B1', 'FOLLOW-UP')), 0);
  const ruled = w0.state();
  const gh = [
    ...GH,
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [{ id: 9, user: { login: 'me' }, body: triageComment(ruled) }] },
  ];
  const w = world(t, { gh, yml: CHAT_YML });
  const shown = w.cli(['state', 'show', '--pr', '7']);
  assertExit(shown, 0, shown.stderr + shown.stdout);
  assert.equal(shown.json.recovered, true);
  assert.deepEqual(w.item('R1-B1').final, ruled.rounds[0].items[0].final);
  assert.ok(triageComment(w.state()).includes(`owner (chat): ${QUOTE}`));
});

test('followups create: a FOLLOW-UP ruled by the owner is filed, one that is still waiting for a human is held', (t) => {
  const url = 'https://github.com/acme/widgets/issues/31';
  const w = world(t, { yml: CHAT_YML, gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 31, html_url: url } }] });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  const held = w.cli(['followups', 'create', '--round', '1']);
  assert.deepEqual([held.json.held, held.json.created], [['R1-B1'], []]);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP')), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, [{ id: 'R1-B1', number: 31, url }]);
  const post = w.fake.calls().find((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues '));
  assert.ok(JSON.parse(post.stdin).body.includes('**Owner (why this is a follow-up, not part of the PR):** owner confirmed in chat'));
});

test('arbiter needed: returns promptHeader, exactly the ROUND / INPUT-DIGEST header of the input file', (t) => {
  const w = readyForArbiter(t);
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 0);
  assert.equal(r.json.promptHeader, `ROUND: 1\nINPUT-DIGEST: ${r.json.digest}`);
  assert.ok(readFileSync(r.json.inputPath, 'utf8').startsWith(`${r.json.promptHeader}\n\n`));
  assert.equal(arbiterRun(w, { prompt: `${r.json.promptHeader}\nRule on every item.` }).code, 0, 'a prompt that starts with the header passes the proof');
});

test('triage settle: a cached copy of an owner ruling (by cache, ownerQuote kept) is still the owner\'s word', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  editState(w, (s) => {
    s.rounds[0].items[0].judge = { decision: 'REJECT', confidence: 'high', reason: 'r', ...DISPUTED };
    s.rounds[0].items[0].final = { decision: 'REJECT', by: 'cache', needsHuman: false, reason: 'ok', ownerQuote: 'reject it', ruledAt: '2026-10-14T00:00:00.000Z' };
  });
  const before = w.stateText();
  const s = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(s, 1, s.stdout);
  assert.match(s.json.reason, /already ruled by the owner/);
  assert.equal(w.stateText(), before, 'state untouched');
});

test('triage owner-ruling: says the ruling is not published yet and that state show would restore the published state without it', (t) => {
  const w = world(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  const r = w.cli(rule('R1-B1', 'FOLLOW-UP', { extra: ['--pr', '7'] }));
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.published, false);
  assert.match(r.json.next, /comment --pr 7 --kind triage/);
  assert.match(r.json.next, /state show/);
});
