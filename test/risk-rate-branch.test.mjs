// rateBranch: the whole rating decision under the working-tree config AND the config committed at the default branch's fork point, stricter wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { rateBranch } from '../pipeline/lib/risk.mjs';

const yml = (extra = '') => `version: 1\nproject: p\nverify:\n  full: f\n  quick: q\n${extra}`;
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

// The cp-like config: chat approval, every path a P-path hit, and the repo's own high-risk list (read from .claude/pipeline.yml so the fixture can't drift).
const CP_HIGH = parseYaml(fs.readFileSync(fileURLToPath(new URL('../.claude/pipeline.yml', import.meta.url)), 'utf8')).risk.high_risk_paths;
const cpYml = (ignore = '[P-path, R4-config]') => yml(
  `owner_approval: chat\nhard_stops:\n  paths: ["**"]\nrisk:\n  high_risk_paths: [${CP_HIGH.map((p) => JSON.stringify(p)).join(', ')}]\n  ignore_hard_stop_rules: ${ignore}\n`,
);

// A repo whose base commit holds `baseYml`; the feature branch then applies `feature(repo)` and commits (with `commitYml` as the branch's own
// committed config when given). rate(workingYml) writes an UNCOMMITTED config when given, then rates HEAD.
export function world(t, { baseYml = yml(), feature, commitYml } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', baseYml);
  repo.write('README.md', 'base\n');
  repo.commit('init');
  repo.branch('feat/x');
  feature(repo);
  if (commitYml !== undefined) repo.write('.claude/pipeline.yml', commitYml);
  repo.commit('feature');
  const rate = async (workingYml, extra = {}) => {
    if (workingYml !== undefined) repo.write('.claude/pipeline.yml', workingYml);
    const loaded = await loadConfig(repo.dir);
    assert.equal(loaded.ok, true, (loaded.errors ?? []).join('; '));
    return rateBranch({ root: repo.dir, head: 'HEAD', config: loaded.config, ...extra });
  };
  return { repo, rate };
}

test('rateBranch: a small change with the same config is low, judge, evaluated once', async (t) => {
  const w = world(t, { feature: (r) => r.write('src/a.js', lines(5)) });
  const r = await w.rate();
  assert.equal(r.level, 'low');
  assert.equal(r.reviewer, 'judge');
  assert.equal(r.sizeOnly, false);
  assert.equal(r.baseConfig.same, true);
  assert.equal(r.lightLane, true);
});

test('rateBranch: a medium PR for size only gets the judge lane with the note; the opt-out gives Fable', async (t) => {
  const w = world(t, { feature: (r) => r.write('src/a.js', lines(200)) });
  const r = await w.rate();
  assert.deepEqual([r.level, r.sizeOnly, r.reviewer, r.sizeOnlyJudge], ['medium', true, 'judge', true]);
  assert.match(r.note, /medium for size only/);
  assert.deepEqual(r.drivers, { hardStop: false, advisory: false, path: false, size: true });
  const o = world(t, { baseYml: yml('review:\n  size_only_medium_reviewer: fable\n'), feature: (r2) => r2.write('src/a.js', lines(200)) });
  const ro = await o.rate();
  assert.deepEqual([ro.level, ro.reviewer, ro.sizeOnlyJudge], ['medium', 'fable', undefined]);
});

test('rateBranch: editing the rating config never lowers the result (uncommitted AND committed edits)', async (t) => {
  // base config: sensitive + hard-stop path src/auth/**, size-only reviewer fable, thresholds 150/600/10
  const keep = 'review:\n  size_only_medium_reviewer: fable\n';
  const baseYml = yml(`${keep}risk:\n  high_risk_paths: ["src/auth/**"]\nhard_stops:\n  paths: ["src/auth/**"]\n`);
  const edits = {
    'raise high_lines/medium_lines': yml(`${keep}risk:\n  high_risk_paths: ["src/auth/**"]\n  medium_lines: 5000\n  high_lines: 9000\nhard_stops:\n  paths: ["src/auth/**"]\n`),
    'raise medium_files': yml(`${keep}risk:\n  high_risk_paths: ["src/auth/**"]\n  medium_files: 500\nhard_stops:\n  paths: ["src/auth/**"]\n`),
    'drop high_risk_paths': yml(`${keep}hard_stops:\n  paths: ["src/auth/**"]\n`),
    'drop hard_stops.paths': yml(`${keep}risk:\n  high_risk_paths: ["src/auth/**"]\n`),
    'report_only_paths': yml(`${keep}risk:\n  high_risk_paths: ["src/auth/**"]\nhard_stops:\n  paths: ["src/auth/**"]\n  report_only_paths: ["src/auth/**"]\n`),
    'ignore rule + judge reviewer': yml('owner_approval: chat\nreview:\n  size_only_medium_reviewer: judge\nrisk:\n  high_risk_paths: []\n  ignore_hard_stop_rules: [P-path, R4-config]\nhard_stops:\n  paths: ["src/auth/**"]\n'),
    'arbiter_always_paths added then high_risk dropped': yml(`${keep}hard_stops:\n  paths: []\n`),
  };
  for (const mode of ['uncommitted', 'committed']) {
    for (const [name, edited] of Object.entries(edits)) {
      const w = world(t, { baseYml, feature: (r) => r.write('src/auth/login.js', lines(200)), ...(mode === 'committed' ? { commitYml: edited } : {}) });
      const r = await w.rate(mode === 'uncommitted' ? edited : undefined);
      assert.equal(r.reviewer, 'fable', `${mode}: ${name}`);
      assert.equal(r.sizeOnly, false, `${mode}: ${name}`);
      assert.ok(['medium', 'high'].includes(r.level), `${mode}: ${name} -> ${r.level}`);
    }
  }
});

test('rateBranch: a size-only PR whose edit sets the reviewer to judge while the base says fable stays on Fable', async (t) => {
  const baseYml = yml('review:\n  size_only_medium_reviewer: fable\n');
  for (const mode of ['uncommitted', 'committed']) {
    const edited = yml('review:\n  size_only_medium_reviewer: judge\n');
    const w = world(t, { baseYml, feature: (r) => r.write('src/a.js', lines(200)), ...(mode === 'committed' ? { commitYml: edited } : {}) });
    const r = await w.rate(mode === 'uncommitted' ? edited : undefined);
    // a committed edit of the config is itself an R4-pipeline hit (high); an uncommitted one is only caught by the base config (medium, Fable)
    assert.deepEqual([r.level, r.reviewer], [mode === 'committed' ? 'high' : 'medium', 'fable'], mode);
    assert.equal(r.sizeOnlyJudge, undefined, mode);
  }
});

test('rateBranch: a base config that is missing or invalid means Fable, even for a tiny change', async (t) => {
  const none = createTmpRepo();
  t.after(() => none.cleanup());
  none.write('README.md', 'base\n');
  none.commit('init');
  none.branch('feat/x');
  none.write('src/a.js', lines(3));
  none.commit('feature');
  none.write('.claude/pipeline.yml', yml()); // the working tree has a config; the fork point has none
  const loaded = await loadConfig(none.dir);
  const r = await rateBranch({ root: none.dir, head: 'HEAD', config: loaded.config });
  assert.deepEqual([r.level, r.reviewer, r.sizeOnly, r.baseConfig.ok], ['low', 'fable', false, false]);
  assert.ok(r.laneReasons.some((x) => /trusted base config unreadable/.test(x)));

  const bad = world(t, { baseYml: 'version: 1\nunknown_key: 3\n', feature: (rr) => rr.write('src/a.js', lines(3)) });
  const rb = await bad.rate(yml());
  assert.deepEqual([rb.level, rb.reviewer, rb.baseConfig.ok], ['low', 'fable', false]);
});

test('rateBranch: a PR whose base is not the default branch never gets the size-only judge', async (t) => {
  const w = world(t, { feature: (r) => r.write('src/a.js', lines(200)) });
  const r = await w.rate(undefined, { prBase: 'feat/other' });
  assert.deepEqual([r.level, r.sizeOnly, r.reviewer, r.stacked], ['medium', false, 'fable', true]);
  assert.ok(r.reasons.some((x) => /stacked PR: base is feat\/other/.test(x)));
});

test('rateBranch (cp-like fixture config): commands/*.mjs and markdown are low and judge (never the light lane), core files and the rater are high', async (t) => {
  const cases = [
    ['pipeline/commands/x.mjs', 'low'],
    ['skills/review/SKILL.md', 'low'],
    ['agents/judge.md', 'low'],
    ['pipeline/lib/risk.mjs', 'high'],
    ['pipeline/lib/hardstops.mjs', 'high'],
    ['pipeline/hooks/guard.mjs', 'high'],
    ['install.mjs', 'high'],
    ['pipeline/commands/merge.mjs', 'high'],
    ['package.json', 'high'],
    ['.githooks/pre-commit', 'high'],
    ['.claude/pipeline.yml', 'high'],
    ['.github/workflows/x.yml', 'high'],
    ['scripts/verify.mjs', 'high'],
  ];
  for (const [file, want] of cases) {
    const content = file.endsWith('.json') ? '{"name":"x"}\n' : file === '.claude/pipeline.yml' ? `${cpYml()}# edited\n` : lines(3);
    const w = world(t, { baseYml: cpYml(), feature: (r) => r.write(file, content) });
    const r = await w.rate();
    assert.equal(r.level, want, `${file} -> ${r.level}: ${r.reasons.join('; ')}`);
    assert.equal(r.reviewer, want === 'low' ? 'judge' : 'fable', file);
    if (want === 'low') {
      assert.equal(r.lightLane, false, `${file}: the P-path hit still blocks the light lane`);
      assert.ok(r.hits.length > 0, file);
    }
  }
});

test('rateBranch (cp-like): a big cp PR keeps Fable because its P-path hits make sizeOnly false; adding the ignore list in the PR is high', async (t) => {
  const big = world(t, { baseYml: cpYml(), feature: (r) => r.write('pipeline/commands/x.mjs', lines(200)) });
  const rb = await big.rate();
  assert.deepEqual([rb.level, rb.sizeOnly, rb.reviewer], ['medium', false, 'fable']);
  const lowering = world(t, { baseYml: cpYml('[]'), feature: (r) => r.write('pipeline/commands/x.mjs', lines(3)) });
  const rl = await lowering.rate(cpYml('[P-path, R4-config]'));
  assert.equal(rl.reviewer, 'fable');
  assert.equal(rl.level, 'high');
});

test('rateBranch: one config rates the size-only PR low and the other medium for size only: sizeOnly is true and the judge reviews (no deadlock)', async (t) => {
  // trusted base config: defaults (medium_lines 150, so 200 lines is medium); the uncommitted config raises medium_lines to 300 (low)
  const w = world(t, { feature: (r) => r.write('src/a.js', lines(200)) });
  const r = await w.rate(yml('risk:\n  medium_lines: 300\n'));
  assert.equal(r.baseConfig.same, false);
  assert.deepEqual([r.level, r.sizeOnly, r.reviewer, r.sizeOnlyJudge], ['medium', true, 'judge', true]);
  // and the other way round: the trusted config is the lenient one
  const rev = world(t, { baseYml: yml('risk:\n  medium_lines: 300\n'), feature: (r2) => r2.write('src/a.js', lines(200)) });
  const rr = await rev.rate(yml());
  assert.deepEqual([rr.level, rr.sizeOnly, rr.reviewer], ['medium', true, 'judge']);
});

test('rateBranch: a low evaluation that still has a raw hit (here an ignored one) keeps sizeOnly false, so Fable is demanded', async (t) => {
  const baseYml = yml('owner_approval: chat\nrisk:\n  medium_lines: 300\n  ignore_hard_stop_rules: [P-path]\nhard_stops:\n  paths: ["src/a.js"]\n');
  const w = world(t, { baseYml, feature: (r) => r.write('src/a.js', lines(200)) });
  // the working config lists no hard-stop path: on its own it is size-only medium (200 lines > 100) with zero hits; the trusted config rates low (its P-path hit is ignored, size under 300)
  // but still reports the raw hit, and that hit must keep the merged result from reading as size-only
  const r = await w.rate(yml('owner_approval: chat\nrisk:\n  medium_lines: 100\n'));
  assert.equal(r.sizeOnly, false);
  assert.equal(r.reviewer, 'fable');
});

test('rateBranch: hits keep the collector identity (rule, file, line) and the stricter status when both configs report the same hit', async (t) => {
  const pat = '  patterns:\n    - { name: todo, regex: "export const x" }\n';
  const feature = (r) => r.write('src/a.js', 'export const x1 = 1;\nexport const x2 = 2;\nexport const y = 3;\n');
  // one config: two matches in one file on different lines stay two hits
  const one = world(t, { baseYml: yml(`hard_stops:\n${pat}`), feature });
  const r1 = await one.rate();
  const p1 = r1.hits.filter((h) => h.rule === 'P-pattern');
  assert.deepEqual(p1.map((h) => h.line).sort(), [1, 2]);
  // two configs: the same two hits are reported by both; report-only in the working config, blocking in the trusted one -> the blocking copy survives
  const two = world(t, { baseYml: yml(`hard_stops:\n${pat}`), feature });
  const r2 = await two.rate(yml(`hard_stops:\n${pat}  report_only_rules: [P-pattern]\n`));
  const p2 = r2.hits.filter((h) => h.rule === 'P-pattern');
  assert.equal(p2.length, 2);
  assert.ok(p2.every((h) => h.advisory !== true), JSON.stringify(p2));
});

// EW#1955: the trusted fork point must not come from the working-tree config. main's config (C1) is strict; the branch `old` sits on C0, whose committed
// config was loose. An unstaged edit points default_branch at `old` and loosens the same keys: both evaluations would read loose configs.
function attackWorld(t, { remote }) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  const loose = yml('risk:\n  high_risk_paths: []\n');
  const strict = yml('review:\n  size_only_medium_reviewer: fable\nrisk:\n  high_risk_paths: ["src/vault/**"]\n');
  repo.write('.claude/pipeline.yml', loose);
  repo.write('README.md', 'base\n');
  repo.commit('c0');
  repo.git(['branch', 'old']);
  repo.write('.claude/pipeline.yml', strict);
  repo.commit('c1');
  if (remote) {
    repo.git(['update-ref', 'refs/remotes/origin/main', 'main']);
    repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  }
  repo.branch('feat/x');
  repo.write('src/vault/store.js', lines(5));
  repo.commit('feature');
  const rate = async () => {
    repo.write('.claude/pipeline.yml', `${loose}default_branch: old\n`);
    const loaded = await loadConfig(repo.dir);
    assert.equal(loaded.ok, true, (loaded.errors ?? []).join('; '));
    // the callers' diff base is the PR's own base (GitHub's baseRefName, here main), so the diff does not contain the config change itself
    const base = repo.git(['rev-parse', 'main']).trim();
    return rateBranch({ root: repo.dir, head: 'HEAD', config: loaded.config, prBase: 'main', base });
  };
  return { repo, rate };
}

test('rateBranch: an unstaged default_branch edit cannot move the trusted fork point (the remote default branch anchors it)', async (t) => {
  const w = attackWorld(t, { remote: true });
  const r = await w.rate();
  assert.equal(r.reviewer, 'fable', r.laneReasons.join('; '));
  assert.equal(r.trustedFork, w.repo.git(['rev-parse', 'main']).trim(), 'the trusted fork point is main\'s, not the branch the edited config names');
});

test('rateBranch: without a remote default branch, a default_branch the committed config does not share is an untrusted base config (Fable)', async (t) => {
  const r = await attackWorld(t, { remote: false }).rate();
  assert.equal(r.reviewer, 'fable');
  assert.equal(r.baseConfig.ok, false);
  assert.match(r.baseConfig.reason, /default_branch/);
  assert.ok(r.laneReasons.some((x) => /trusted base config unreadable/.test(x)));
});
