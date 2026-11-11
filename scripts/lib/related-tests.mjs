// Which test files `node scripts/test.mjs --related` adds to the quick check's fixed list: the ones related to what the
// branch changed. Pure (git, the file system and the weights are passed in), so test/related-tests.test.mjs runs it on a
// fixture graph. Paths are repo-relative with "/" (path.posix) everywhere; input with "\" is normalised, so Windows works.
//
// A test file is related when
//   tier 0  it is itself changed (always runs, whatever the budget);
//   tier 1  a changed file is a direct dependency of it: it imports the file, or its source mentions the file's path;
//   tier 2  a changed file is further away: reached through the imports and path mentions of the modules it depends on
//           (a test that spawns pipeline/bin/pipeline.mjs depends on everything that entry imports; that is intended).
// "Imports" are static `import|export ... from '<relative>'`, `import '<relative>'` and `import('<relative>')`. A "mention" is
// the whole repo-relative path in a string ('docs/cli.md'), or its segments as consecutive string arguments
// (join(root, 'docs', 'cli.md')). Other test files are never followed through a mention (a test that writes
// 'cli.test.mjs' into a fixture does not depend on cli.test.mjs), but a changed one that is mentioned still counts.
//
// Budget: related tests are added best-first (tier, then distance, then lightest, then name) while the summed estimated
// time stays within `budgetMs`; one that does not fit is skipped and lighter ones after it may still fit.
import { posix } from 'node:path';

// Calibrated on a 14-core Mac, 2026-11: test/cli.test.mjs 3.2 s local vs 3.3 s weighed, test/verify.test.mjs 83 s vs 188 s,
// test/git-resolution.test.mjs 165 s vs 214 s (CI spanMs overstates; it never understates). 90 s of weight is about
// 40-90 s of wall time. Measured: this feature's own 7-file diff selected 31 related tests (budget used) and `verify --quick`
// took 105 s on a loaded machine, so quick stays at about one to two minutes at most; with nothing related it is about 5 s.
export const DEFAULT_BUDGET_MS = 90_000;

const MODULE_RE = /\.(?:mjs|js|cjs)$/;
const TEST_RE = /\.test\.mjs$/;
const IMPORT_RES = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])(\.{1,2}\/[^'"]*|\.{1,2})\1/g, // import x from './a'; export * from './a'
  /\bimport\s*(['"])(\.{1,2}\/[^'"]*)\1/g, // import './a'
  /\bimport\s*\(\s*(['"`])(\.{1,2}\/[^'"`]*)\1\s*\)/g, // import('./a')
];

export const toPosix = (p) => posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '');

// CP_QUICK_RELATED_BUDGET_MS: unset/blank = default; `all` = no cap; 0 = no related tests; a positive number of ms.
// Anything else is a mistake, reported as { error } so the caller can print it and use the default.
export function parseBudget(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return { budgetMs: DEFAULT_BUDGET_MS };
  if (v.toLowerCase() === 'all') return { budgetMs: Infinity };
  if (/^\d+$/.test(v)) return { budgetMs: Number(v) };
  return { budgetMs: DEFAULT_BUDGET_MS, error: `CP_QUICK_RELATED_BUDGET_MS=${JSON.stringify(v)} is not a number of ms or "all"; using ${DEFAULT_BUDGET_MS}` };
}

// The relative specifiers a module imports.
export function importSpecs(source) {
  const out = new Set();
  for (const re of IMPORT_RES) for (const m of String(source).matchAll(re)) out.add(m[2]);
  return [...out];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Between two path segments: a separator, or the end of one string argument and the start of the next.
const SEP = '(?:[\\\\/]|[\'"`]\\s*,\\s*[\'"`])';

// Does `source` mention the repo-relative `target` path? Not as a piece of a longer name ('a.mjs' is not in 'a.mjs.bak' or
// 'data.mjs'), a leading directory may precede it ('${root}/docs/cli.md').
export function mentionsPath(source, target) {
  const segments = toPosix(target).split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const re = new RegExp(`(?<![A-Za-z0-9_.-])${segments.map(escapeRe).join(SEP)}(?![A-Za-z0-9_]|\\.[A-Za-z0-9_])`);
  return re.test(source);
}

const tokensOf = (source) => new Set(String(source).match(/[A-Za-z0-9_.-]+/g) ?? []);

// ---- the dependency graph -----------------------------------------------------------------------------------------
// files: every repo file (repo-relative); read(p) -> text | null. A deleted changed file is still a node, by path.
function makeGraph({ files, changed, read }) {
  const known = new Set([...files, ...changed].map(toPosix));
  const changedSet = new Set(changed.map(toPosix));
  // mention targets: every module (to follow into its imports) and every changed file of any kind; not other tests.
  const byBase = new Map();
  for (const p of known) {
    if (!changedSet.has(p) && !(MODULE_RE.test(p) && !TEST_RE.test(p))) continue;
    const base = posix.basename(p);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(p);
  }
  const cache = new Map();
  const resolve = (from, spec) => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const c of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`]) if (known.has(c)) return c;
    return null;
  };
  const sourceOf = (p) => { try { return read(p); } catch { return null; } };
  // deps(p): Map of the files p depends on directly -> 'strong' | 'weak'. An import is strong, and so is a mention of a path
  // with a directory ('docs/cli.md', 'pipeline/bin/pipeline.mjs'). A mention of a bare root-level name ('README.md') is weak:
  // tests write fixture files with such names far more often than they read the repo's own. A changed file that is not a
  // module (a doc, a skill, an agent file) is followed only from a test file that names it itself, never through a module
  // that happens to contain the name, so one changed README does not pull in every test that imports that module.
  const deps = (p) => {
    if (cache.has(p)) return cache.get(p);
    const out = new Map();
    const src = MODULE_RE.test(p) ? sourceOf(p) : null;
    const fromTest = TEST_RE.test(p);
    if (typeof src === 'string') {
      for (const spec of importSpecs(src)) {
        const r = resolve(p, spec);
        if (r && r !== p) out.set(r, 'strong');
      }
      for (const tok of tokensOf(src)) {
        for (const t of byBase.get(tok) ?? []) {
          if (t === p || out.has(t)) continue;
          if (!MODULE_RE.test(t) && !fromTest) continue;
          if (mentionsPath(src, t)) out.set(t, t.includes('/') ? 'strong' : 'weak');
        }
      }
    }
    cache.set(p, out);
    return out;
  };
  return { deps, changedSet };
}

// Shortest distance from `test` to a changed file: 0 = the test is changed, 1 = a direct dependency, 2+ = further.
// Strong edges only first; only when no strong path exists is a path through a weak edge (a bare root-name mention) used,
// and then the result says `weak` so the ranking puts it after every strongly related test of its tier.
function distanceToChange(graph, test) {
  if (graph.changedSet.has(test)) return { distance: 0, weak: false };
  const search = (allowWeak) => {
    const seen = new Set([test]);
    let frontier = [test];
    for (let d = 1; frontier.length > 0; d++) {
      const next = [];
      for (const node of frontier) {
        for (const [dep, kind] of graph.deps(node)) {
          if (kind === 'weak' && !allowWeak) continue;
          if (seen.has(dep)) continue;
          if (graph.changedSet.has(dep)) return d;
          seen.add(dep);
          next.push(dep);
        }
      }
      frontier = next;
    }
    return null;
  };
  const strong = search(false);
  if (strong !== null) return { distance: strong, weak: false };
  const any = search(true);
  return any === null ? null : { distance: any, weak: true };
}

// tests: test/ file names (the `.test.mjs` ones); `testDir` is where they live. weights: Map name -> estimated ms (every test).
// exclude: names that run anyway (the fixed list). Returns { selected, skipped, estimatedMs }: each entry { name, tier, distance, ms }.
export function relatedTests({ tests, testDir = 'test', changed, files, read, weights, budgetMs, exclude = [] }) {
  const changedNorm = [...new Set(changed.map(toPosix).filter(Boolean))];
  const skip = new Set(exclude);
  const graph = makeGraph({ files, changed: changedNorm, read });
  const dir = toPosix(testDir);
  const ranked = [];
  for (const name of tests) {
    if (skip.has(name) || !TEST_RE.test(name)) continue;
    const found = distanceToChange(graph, `${dir}/${name}`);
    if (found === null) continue;
    const { distance, weak } = found;
    ranked.push({ name, tier: Math.min(distance, 2), distance, weak, ms: Math.round(weights.get(name) ?? 0) });
  }
  // Within a tier, strongly related tests (imports, path mentions) come before weak ones (a bare root-name mention).
  ranked.sort((a, b) => a.tier - b.tier || Number(a.weak) - Number(b.weak) || a.distance - b.distance || a.ms - b.ms || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const selected = [];
  const skipped = [];
  let estimatedMs = 0;
  for (const t of ranked) {
    if (t.tier === 0 || estimatedMs + t.ms <= budgetMs) { selected.push(t); estimatedMs += t.ms; } else skipped.push(t);
  }
  return { selected, skipped, estimatedMs };
}

// The one-line summary printed before the run (and so kept in .verify/logs/tests.log). It shows the estimated time the
// selection used against the budget: changed test files always run and count too, so one heavy changed test can use the
// whole budget, and the line must say so.
export function describeSelection({ selected, skipped, changedCount, basis, budgetMs, estimatedMs = 0, listMax = 6 }) {
  const tiers = [0, 1, 2].map((t) => selected.filter((s) => s.tier === t).length);
  const used = Math.round(estimatedMs);
  const budget = budgetMs === Infinity ? `estimated ${used} ms, no budget cap` : `estimated ${used} of budget ${budgetMs} ms`;
  const names = skipped.map((s) => s.name);
  const shown = names.slice(0, listMax).join(', ') + (names.length > listMax ? `, +${names.length - listMax} more` : '');
  return `related tests: ${selected.length} selected (${tiers[0]} changed, ${tiers[1]} direct, ${tiers[2]} transitive), `
    + `${skipped.length} skipped over budget${skipped.length ? ` (${shown})` : ''}; ${changedCount} changed files (${basis}); ${budget}`;
}

// The full record of what a quick run covered, printed after the summary: every selected related file with its tier and
// every file skipped over budget, so a CI failure in a test quick passed can be told apart (skipped vs never related)
// from the log alone. Each line ends with ')' so no line reads as a bare test-file name.
export function describeSelectionDetail({ selected, skipped }) {
  const tierName = ['changed', 'direct', 'transitive'];
  const lines = [];
  if (selected.length) lines.push(`related selected (${selected.length}): ${selected.map((s) => `${s.name} [${tierName[s.tier] ?? s.tier}]`).join(', ')} (end)`);
  if (skipped.length) lines.push(`related skipped over budget (${skipped.length}): ${skipped.map((s) => s.name).join(', ')} (end)`);
  return lines;
}

// ---- changed files ----------------------------------------------------------------------------------------------------
// git(args) -> { ok, stdout } (stdout a string; the caller runs git in the repo root). Never throws: a git failure is
// { error }, and the caller falls back to the fixed list. Changed = branch commits since the merge base with origin/main,
// plus staged, unstaged and untracked (non-ignored) files; deleted and renamed-from paths count by path. With no
// origin/main (a clone without the remote, a shallow one) only the working-tree changes are known, and `basis` says so.
export function changedFiles(git) {
  const list = (args) => {
    const r = git(args);
    if (!r || !r.ok) return null;
    return String(r.stdout).split('\0').filter(Boolean).map(toPosix);
  };
  try {
    if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'])?.ok) return { error: 'git has no HEAD commit here' };
    const mb = git(['merge-base', 'HEAD', 'origin/main']);
    const base = mb?.ok ? String(mb.stdout).trim() : '';
    const parts = [];
    if (base) parts.push(list(['diff', '--name-only', '--no-renames', '-z', `${base}..HEAD`]));
    parts.push(list(['diff', '--name-only', '--no-renames', '-z', 'HEAD']), list(['ls-files', '-z', '--others', '--exclude-standard']));
    if (parts.some((p) => p === null)) return { error: 'a git command failed' };
    return {
      files: [...new Set(parts.flat())],
      basis: base ? `merge base ${base.slice(0, 7)} with origin/main, plus the working tree` : 'no origin/main: working-tree changes only',
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}
