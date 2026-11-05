// review.docs_exempt_paths: a commit after the last review round that only ADDS lines to listed, ordinary documents needs no new round.
// Real git throughout (the helper reads history, modes and merge bases); the review state is hand-built from the real hashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { DEFAULTS, validateConfig } from '../pipeline/lib/config.mjs';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { contentHash } from '../pipeline/lib/git.mjs';
import { isDocPath } from '../pipeline/lib/doc-paths.mjs';
import { docsExemptFrom } from '../pipeline/lib/docs-exempt.mjs';
import { reviewCheck } from '../pipeline/lib/finalgate.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { parseReviewRecord } from '../pipeline/lib/review-marker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const LEDGER = 'docs/ledger.md';
const AGENT_LOG = 'docs/agent-log.md';

const ymlWith = (list, extra = '') => `${pipelineYml()}review:\n  docs_exempt_paths: ${JSON.stringify(list)}\n${extra}`;
const baseline = () => validateConfig(parseYaml(pipelineYml())).config;

// main: init; feat/x: one reviewed code commit (the round's toHead). The state holds one clean round for it.
function world(t, { list = [LEDGER], yml, items = [], fable = false, baseFiles = {} } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml ?? ymlWith(list));
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', 'export const a = 1;\n');
  repo.write('src/b.js', 'export const b = 2;\n');
  repo.write(LEDGER, '# Ledger\n\n| 1 | first |\n');
  repo.write('docs/other.md', '# Other\n');
  repo.write('docs/guide.html', '<p>guide</p>\n');
  repo.write('CLAUDE.md', '# rules\n');
  for (const [p, c] of Object.entries(baseFiles)) repo.write(p, c);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', 'export const a = 2;\n');
  const head = repo.commit('feature');
  const w = { repo, base, head, dir: repo.dir };
  w.hash = (ref = 'HEAD') => contentHash('main', ref, { cwd: repo.dir, exclude: [AGENT_LOG] });
  const state = addRound(emptyState({ repo: 'acme/widgets', pr: 7, branch: 'feat/x', risk: 'low', maxRounds: 2 }), {
    n: 1, fromHead: base, toHead: head, contentHashAtToHead: w.hash(head), items, ...(fable ? { fableRequired: true, fableReasons: ['test'] } : {}),
  });
  w.state = state;
  w.append = (rel, line) => { writeFileSync(join(repo.dir, rel), readFileSync(join(repo.dir, rel), 'utf8') + line); };
  w.exempt = (config = baseline(), s = state) => docsExemptFrom(s, { root: repo.dir, config, hash: w.hash('HEAD') });
  return w;
}
const refused = (r, pattern) => {
  assert.equal(r.exempt, false, `expected a refusal, got ${JSON.stringify(r)}`);
  assert.match(r.reason, pattern);
  return r;
};

// ---- the happy path ---------------------------------------------------------------------------------------------------

test('a commit that only appends to a listed document is exempt, and the files are named', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | second |\n');
  w.repo.commit('ledger row');
  const r = w.exempt();
  assert.equal(r.exempt, true, r.reason);
  assert.deepEqual(r.files, [LEDGER]);
});

test('a NEW listed document added after the round is exempt too (additions only)', (t) => {
  const w = world(t, { list: [LEDGER, 'docs/new.md'] });
  w.repo.write('docs/new.md', '# New\n');
  w.repo.commit('new doc');
  const r = w.exempt();
  assert.equal(r.exempt, true, r.reason);
  assert.deepEqual(r.files, ['docs/new.md']);
});

test('several commits after the round, all documents-only, are exempt', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('one');
  w.append(LEDGER, '| 3 | c |\n');
  w.repo.commit('two');
  assert.equal(w.exempt().exempt, true);
});

// ---- refusals ---------------------------------------------------------------------------------------------------------

test('default (empty list, or no key): refused, as today, and marked off', (t) => {
  const w = world(t, { list: [] });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = refused(w.exempt(), /docs_exempt_paths/);
  assert.equal(r.off, true);
  const bare = world(t, { yml: pipelineYml() });
  bare.append(LEDGER, '| 2 | b |\n');
  bare.repo.commit('ledger row');
  assert.equal(bare.exempt().off, true);
});

test('docs plus code in the commits: refused, and the reason names the code file', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  w.append('src/b.js', 'export const c = 3;\n');
  w.repo.commit('mixed');
  refused(w.exempt(), /src\/b\.js/);
});

test('a document that is not listed forces a round and is named', (t) => {
  const w = world(t);
  w.append('docs/other.md', 'more\n');
  w.repo.commit('other doc');
  refused(w.exempt(), /docs\/other\.md/);
});

test('a listed document next to an unlisted one: refused naming the unlisted one', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  w.append('docs/other.md', 'more\n');
  w.repo.commit('both');
  refused(w.exempt(), /docs\/other\.md/);
});

test('nothing changed since the round: nothing to exempt', (t) => {
  const w = world(t);
  refused(w.exempt(), /no file changed|nothing/i);
});

test('a rename from a code file into a listed path is refused (both sides are checked)', (t) => {
  const w = world(t, { list: [LEDGER, 'docs/new.md'] });
  w.repo.git(['mv', 'src/b.js', 'docs/new.md']);
  w.repo.commit('move code into docs');
  refused(w.exempt(), /src\/b\.js/);
});

test('a deleted listed document is refused', (t) => {
  const w = world(t);
  w.repo.rm(LEDGER);
  w.repo.commit('drop ledger');
  refused(w.exempt(), /docs\/ledger\.md/);
});

test('a mode change on a listed document is refused', (t) => {
  const w = world(t);
  chmodSync(join(w.dir, LEDGER), 0o755);
  w.repo.git(['update-index', '--chmod=+x', LEDGER]);
  w.repo.git(['commit', '-q', '-m', 'chmod']);
  refused(w.exempt(), /mode/);
});

test('a symlink at a listed path is refused', (t) => {
  const w = world(t, { list: [LEDGER, 'docs/link.md'] });
  symlinkSync('../src/a.js', join(w.dir, 'docs', 'link.md'));
  w.repo.commit('link');
  refused(w.exempt(), /docs\/link\.md/);
});

test('an edited line (not just an addition) in a listed document is refused', (t) => {
  const w = world(t);
  writeFileSync(join(w.dir, LEDGER), '# Ledger\n\n| 1 | CHANGED |\n');
  w.repo.commit('edit a row');
  refused(w.exempt(), /docs\/ledger\.md/);
});

test('a binary (NUL) file at a listed path is refused', (t) => {
  const w = world(t, { list: [LEDGER, 'docs/bin.md'] });
  writeFileSync(join(w.dir, 'docs', 'bin.md'), Buffer.from([0x23, 0x20, 0x00, 0x01, 0x0a]));
  w.repo.commit('nul');
  refused(w.exempt(), /docs\/bin\.md/);
});

test('a main merge that touches only allowed documents is refused (any merge since the round)', (t) => {
  const w = world(t);
  w.repo.checkout('main');
  w.append(LEDGER, '| 9 | from main |\n');
  w.repo.commit('main ledger row');
  w.repo.checkout('feat/x');
  w.repo.git(['merge', '-q', '--no-edit', 'main']);
  refused(w.exempt(), /merge/);
});

test('a merge that discards an upstream code change and also edits an allowed document is refused', (t) => {
  const w = world(t);
  w.repo.checkout('main');
  w.repo.write('src/b.js', 'export const b = 99;\n');
  w.repo.commit('main code change');
  w.repo.checkout('feat/x');
  w.repo.git(['merge', '-q', '-s', 'ours', '--no-edit', 'main']); // takes nothing from main: the upstream change is discarded
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  refused(w.exempt(), /merge/);
});

test('rewritten history (the round\'s toHead is not an ancestor of HEAD) is refused', (t) => {
  const w = world(t);
  w.repo.git(['reset', '-q', '--hard', w.base]);
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('rewritten');
  refused(w.exempt(), /ancestor|history/);
});

test('a toHead that was edited in the state (hash not that commit\'s) is refused', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  const second = w.repo.commit('ledger row');
  const forged = structuredClone(w.state);
  forged.rounds[0].toHead = second; // claims the review covered the docs commit: its hash is the round's, not this commit's
  refused(w.exempt(baseline(), forged), /hash/);
});

test('an unresolved item still refuses', (t) => {
  const w = world(t, { items: [{ id: 'R1-B1', bucket: 'BLOCKING', title: 't', file: 'src/a.js', line: 1 }] });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  refused(w.exempt(), /unresolved|review/i);
});

test('a missing Fable pass still refuses', (t) => {
  const w = world(t, { fable: true });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  refused(w.exempt(), /unresolved|review|Fable/i);
});

test('a commit that adds a path to the list and changes it is refused (the list is read at the reviewed head)', (t) => {
  const w = world(t, { list: [] });
  w.repo.write('.claude/pipeline.yml', ymlWith([LEDGER]));
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('widen the list and use it');
  const r = w.exempt();
  assert.equal(r.exempt, false);
  assert.match(r.reason, /pipeline\.yml|docs_exempt_paths/);
});

// ---- eligibility: validation and the run-time check -------------------------------------------------------------------

const withList = (list, extra = {}) => validateConfig({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' }, review: { docs_exempt_paths: list, ...(extra.review ?? {}) }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'review')) });

test('validation: the default is an empty list and a clean doc entry is accepted', () => {
  assert.deepEqual(DEFAULTS.review.docs_exempt_paths, []);
  assert.equal(validateConfig({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' } }).ok, true);
  const ok = withList([LEDGER, 'docs/agent-guide/prod-ledger.md', 'CHANGELOG.md']);
  assert.equal(ok.ok, true, ok.errors?.join('; '));
});

test('validation refuses each forbidden class of entry', () => {
  const cases = {
    'agent instruction file': ['CLAUDE.md'],
    'agent instruction file in docs/': ['docs/AGENTS.md'],
    'ordinary source file': ['src/app.js'],
    'html': ['docs/guide.html'],
    'mdx': ['docs/page.mdx'],
    'workflow-directory markdown': ['.github/PULL_REQUEST_TEMPLATE.md'],
    'claude directory': ['.claude/notes.md'],
    'skills directory': ['skills/review/NOTES.md'],
    'pipeline directory': ['pipeline/NOTES.md'],
    'a glob': ['docs/*.md'],
    'a brace glob': ['docs/{a,b}.md'],
    'a directory': ['docs/'],
    'absolute': ['/docs/a.md'],
    'dot-dot': ['docs/../CLAUDE.md'],
    'leading ./': ['./docs/a.md'],
    'backslash': ['docs\\a.md'],
    'not a string': [42],
    'empty string': [''],
    'supabase directory': ['supabase/README.md'],
    'migrations directory': ['docs/migrations/notes.md'],
    'secrets path': ['docs/secrets/a.md'],
    'auth path': ['docs/auth/flow.md'],
    'payroll path': ['docs/payroll-notes.md'],
    'repeated': [LEDGER, LEDGER],
  };
  for (const [label, list] of Object.entries(cases)) {
    const r = withList(list);
    assert.equal(r.ok, false, label);
    assert.ok(r.errors.some((e) => e.includes('docs_exempt_paths')), `${label}: ${r.errors.join('; ')}`);
  }
  assert.equal(withList('docs/a.md').ok, false, 'not an array');
});

test('validation refuses a path another list protects: hard_stops.paths, integrity.test_globs, arbiter_always_paths, high_risk_paths', () => {
  const protectedBy = {
    'hard_stops.paths': { hard_stops: { paths: ['docs/ledger.md'] } },
    'hard_stops.paths glob': { hard_stops: { paths: ['docs/**'] } },
    'integrity.test_globs': { integrity: { test_globs: ['docs/**'] } },
    'review.arbiter_always_paths': { review: { arbiter_always_paths: ['docs/**'] } },
    'risk.high_risk_paths': { risk: { high_risk_paths: ['docs/ledger.md'] } },
  };
  for (const [label, extra] of Object.entries(protectedBy)) {
    const r = withList([LEDGER], extra);
    assert.equal(r.ok, false, label);
    assert.ok(r.errors.some((e) => e.includes('docs_exempt_paths')), `${label}: ${r.errors.join('; ')}`);
  }
});

test('doc-paths: isDocPath keeps its classification', () => {
  for (const p of ['README.md', 'docs/a/b.md', 'docs/notes.txt', 'CHANGELOG', 'LICENSE.txt']) assert.equal(isDocPath(p), true, p);
  for (const p of ['src/a.js', 'CLAUDE.md', 'docs/guide.html', 'notes.txt', 'skills/x.md', 'docs/page.mdx']) assert.equal(isDocPath(p), false, p);
});

// A config that skipped validation (here: committed straight into the reviewed head) cannot make the run-time check accept a path.
test('run-time check: a listed ordinary source file is refused although nothing validated the list', (t) => {
  const w = world(t, { list: ['src/a.js'] });
  w.append('src/a.js', 'export const extra = 1;\n');
  w.repo.commit('source append');
  refused(w.exempt(), /src\/a\.js/);
});

test('run-time check: a listed .html is refused although nothing validated the list', (t) => {
  const w = world(t, { list: ['docs/guide.html'] });
  w.append('docs/guide.html', '<p>more</p>\n');
  w.repo.commit('html append');
  refused(w.exempt(), /docs\/guide\.html/);
});

test('run-time check: CLAUDE.md and a hard-stop-listed document are refused with a list that skipped validation', (t) => {
  const a = world(t, { list: ['CLAUDE.md'] });
  a.append('CLAUDE.md', 'rule\n');
  a.repo.commit('rule');
  refused(a.exempt(), /CLAUDE\.md/);

  const yml = `${ymlWith([LEDGER])}hard_stops:\n  paths: ["docs/ledger.md"]\n`;
  const b = world(t, { yml });
  b.append(LEDGER, '| 2 | b |\n');
  b.repo.commit('ledger row');
  refused(b.exempt(), /docs\/ledger\.md/);

  // also when only the CURRENT config (not the reviewed one) protects it
  const c = world(t);
  c.append(LEDGER, '| 2 | b |\n');
  c.repo.commit('ledger row');
  const strict = validateConfig(parseYaml(`${pipelineYml()}risk:\n  high_risk_paths: ["docs/ledger.md"]\n`)).config;
  refused(c.exempt(strict), /docs\/ledger\.md/);
});

// ---- the final gate's review check, and review-complete ---------------------------------------------------------------

const gateRoot = (w) => { saveState(w.dir, w.state); return w.dir; };
const gateReview = (w, over = {}) => reviewCheck({
  root: gateRoot(w), config: baseline(), pr: 7, repo: 'acme/widgets',
  diff: () => ({ ok: true, files: [{ path: LEDGER, status: 'M', binary: false, added: [{ line: 1, text: 'x' }], removed: [] }] }),
  hash: w.hash('HEAD'), hashError: null, ...over,
});

test('final gate: a docs-only commit after the round passes the review check and names the exempt files and the reviewed head', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = gateReview(w);
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /docs\/ledger\.md/);
  assert.ok(r.detail.includes(w.head.slice(0, 12)), r.detail);
  assert.match(r.detail, /docs-only/i);
});

test('final gate: with the default empty list the same commit fails the review check, as today', (t) => {
  const w = world(t, { list: [] });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = gateReview(w);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no clean review round covers the current content/);
});

test('final gate: a code file in the later commit fails the review check and names it', (t) => {
  const w = world(t);
  w.append('src/b.js', 'export const c = 3;\n');
  w.repo.commit('code');
  const r = gateReview(w);
  assert.equal(r.ok, false);
  assert.match(r.detail, /src\/b\.js/);
});

// review-complete, end to end (real CLI, scripted gh).
const GH = (head) => [
  { match: '^pr view 7', stdoutJson: { title: 'T', body: 'B', headRefName: 'feat/x', baseRefName: 'main', headRefOid: head, isDraft: true, labels: [] } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^pr edit 7 --remove-label awaiting-review', code: 0 },
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
];
function complete(t, w) {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-docs-exempt-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  saveState(w.dir, w.state);
  const head = w.repo.git(['rev-parse', 'HEAD']).trim();
  const fake = createFakeGh(GH(head));
  const r = spawnSync(process.execPath, [bin, 'review-complete', '--pr', '7'], {
    cwd: w.dir, encoding: 'utf8', env: { ...process.env, ...fake.env, PIPELINE_LOCK_DIR: join(scratch, 'locks') },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* assertions below show it */ }
  const posted = fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues/7/comments ')).map((c) => JSON.parse(c.stdin).body);
  return { code: r.status, json, stderr: r.stderr, posted, head };
}

test('review-complete: a docs-only commit after the round posts the marker with the CURRENT hash and head, naming the files and the reviewed head', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = complete(t, w);
  assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.posted.length, 1);
  const record = parseReviewRecord(r.posted[0]);
  assert.ok(record, 'the vendored marker parser still reads the body');
  assert.equal(record.contentHash, w.hash('HEAD'));
  assert.equal(record.head, r.head);
  assert.deepEqual(Object.keys(JSON.parse(/```json\n(.*)\n```/.exec(r.posted[0])[1])), ['contentHash', 'base', 'head', 'rounds', 'codexModel', 'modelProofDigest']);
  assert.match(r.posted[0], /docs\/ledger\.md/);
  assert.ok(r.posted[0].includes(w.head.slice(0, 12)), 'the reviewed head is named');
  assert.match(r.posted[0], /docs-only/i);
  assert.deepEqual(r.json.docsExempt.files, [LEDGER]);
});

test('review-complete: mixed docs and code is refused, naming the code file, and posts nothing', (t) => {
  const w = world(t);
  w.append(LEDGER, '| 2 | b |\n');
  w.append('src/b.js', 'export const c = 3;\n');
  w.repo.commit('mixed');
  const r = complete(t, w);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /src\/b\.js/);
  assert.equal(r.posted.length, 0);
});

test('review-complete: with the default empty list a docs commit is refused with today\'s reason', (t) => {
  const w = world(t, { list: [] });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = complete(t, w);
  assert.equal(r.code, 1);
  assert.match(r.json.reason, /no review round covers the current content/);
  assert.equal(r.posted.length, 0);
});

test('review-complete: an unresolved item still refuses a docs-only commit', (t) => {
  const w = world(t, { items: [{ id: 'R1-B1', bucket: 'BLOCKING', title: 't', file: 'src/a.js', line: 1 }] });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = complete(t, w);
  assert.equal(r.code, 1);
  assert.match(r.json.reason, /waiting for a decision: R1-B1/);
  assert.equal(r.posted.length, 0);
});

test('review-complete: a missing Fable pass still refuses a docs-only commit', (t) => {
  const w = world(t, { fable: true });
  w.append(LEDGER, '| 2 | b |\n');
  w.repo.commit('ledger row');
  const r = complete(t, w);
  assert.equal(r.code, 1);
  assert.match(r.json.reason, /Fable/);
  assert.equal(r.posted.length, 0);
});
