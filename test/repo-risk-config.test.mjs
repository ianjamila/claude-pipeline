// The repo's own .claude/pipeline.yml: it must validate, and its risk settings must stay what the rating tests and the plan assume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { validateConfig } from '../pipeline/lib/config.mjs';
import { matchAny } from '../pipeline/lib/glob.mjs';
import { assessRisk, reviewLane } from '../pipeline/lib/risk.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = parseYaml(fs.readFileSync(path.join(root, '.claude', 'pipeline.yml'), 'utf8'));

test('repo config: .claude/pipeline.yml passes validateConfig', () => {
  const r = validateConfig(raw);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('repo config: every literal high_risk_paths entry exists on disk', () => {
  const list = raw.risk.high_risk_paths;
  assert.ok(Array.isArray(list) && list.length > 0);
  for (const p of list.filter((x) => !/[*?[{]/.test(x))) {
    assert.ok(fs.existsSync(path.join(root, p)), `${p} is in risk.high_risk_paths but does not exist`);
  }
});

test('repo config: ignore_hard_stop_rules is exactly P-path and R4-config', () => {
  assert.deepEqual(raw.risk.ignore_hard_stop_rules, ['P-path', 'R4-config']);
  assert.deepEqual(validateConfig(raw).config.risk.ignore_hard_stop_rules, ['P-path', 'R4-config']);
});

test('repo config: the rating tests read this same high_risk_paths list (no hand-copied fixture); no duplicates; the helper and wrapper files are in it', () => {
  const src = fs.readFileSync(path.join(root, 'test', 'risk-rate-branch.test.mjs'), 'utf8');
  assert.match(src, /CP_HIGH = parseYaml\(.*\.claude\/pipeline\.yml.*\)\.risk\.high_risk_paths/, 'risk-rate-branch.test.mjs must read the real list, not a copy');
  const list = raw.risk.high_risk_paths;
  assert.equal(new Set(list).size, list.length);
  for (const p of ['pipeline/lib/glob.mjs', 'pipeline/lib/git.mjs', 'pipeline/lib/diff.mjs', 'pipeline/lib/doc-paths.mjs', 'pipeline/lib/docs-exempt.mjs', 'pipeline/lib/yaml.mjs', 'pipeline/vendor/**', 'pipeline/lib/proc.mjs', 'pipeline/lib/paths.mjs', 'pipeline/lib/resolution.mjs', 'pipeline/lib/seams.mjs', 'pipeline/lib/shell-words.mjs', 'install.sh', 'install.ps1']) {
    assert.ok(list.includes(p), p);
  }
});

// Relative imports of a source file. STATIC ones (`import ... from`, `export ... from`, bare `import './x.mjs'`, multi-line, any comment or
// string or regex-literal or nested-template shape) come from V8's own module parser, run in ONE child process per call
// (test/fixtures/static-imports.mjs, `vm.SourceTextModule` needs --experimental-vm-modules); this file does not parse JavaScript itself.
// A source that does not parse throws, so the test fails closed. DYNAMIC `import('./x.mjs')` needs a literal specifier ('…', "…", or a
// backtick without `${`) and is found by a regex over the RAW text with no comment stripping. A block or line comment may sit between
// `import`, `(`, the specifier and the closing `,` or `)`. The regex may only OVER-match: a mention inside a comment or string is taken as an
// import, which is the safe direction (importClosure skips a dynamic target that does not exist on disk). A computed or interpolated
// specifier has no path to follow and is deliberately not matched.
// No match may consume text: the pattern is tried with a STICKY regex at EVERY `import` token (one candidate per token), so a real literal
// import always matches from its own token and an earlier `import`, comment or quote cannot swallow it. A block comment ends at its FIRST
// `*/` and a line comment at its line end (no backtracking to a later one), so one candidate never reaches into the next import.
const STATIC_IMPORTS_HELPER = path.join(root, 'test', 'fixtures', 'static-imports.mjs');
const SKIP = String.raw`(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*(?![^\n]))*`;
const DYNAMIC_IMPORT_AT = new RegExp(String.raw`import${SKIP}\(${SKIP}(?:'([^'\n]+)'|"([^"\n]+)"|\`((?:[^\`$\\]|\$(?!\{))+)\`)${SKIP}[,)]`, 'y');

function staticSpecifiers(sources) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', STATIC_IMPORTS_HELPER], {
    input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`static import parse failed (exit ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function dynamicSpecifiers(src) {
  const out = [];
  for (const token of src.matchAll(/\bimport/g)) {
    DYNAMIC_IMPORT_AT.lastIndex = token.index;
    const m = DYNAMIC_IMPORT_AT.exec(src);
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

// One entry per source: { static: [...], dynamic: [...] }.
function scanImports(sources) {
  const stat = staticSpecifiers(sources);
  return sources.map((src, i) => ({ static: stat[i], dynamic: dynamicSpecifiers(src) }));
}

const isRelative = (spec) => spec.startsWith('./') || spec.startsWith('../');
const relFrom = (fromAbs, spec) => path.relative(root, path.resolve(path.dirname(fromAbs), spec)).split(path.sep).join('/');

// Direct relative imports of each file in `rels` (repo-relative, posix): every static one (a missing target is reported by the caller),
// plus each dynamic one whose target exists on disk. Bare specifiers (node:fs, packages) are ignored.
function directImports(rels) {
  const scans = scanImports(rels.map((rel) => {
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `${rel} is imported but does not exist`);
    return fs.readFileSync(abs, 'utf8');
  }));
  return rels.map((rel, i) => {
    const abs = path.join(root, rel);
    const stat = scans[i].static.filter(isRelative).map((s) => relFrom(abs, s));
    const dyn = scans[i].dynamic.filter(isRelative).map((s) => relFrom(abs, s)).filter((t) => fs.existsSync(path.join(root, t)));
    return [...new Set([...stat, ...dyn])];
  });
}

function importClosure(startRel) {
  const seen = new Set();
  let frontier = [startRel];
  while (frontier.length) {
    const batch = [...new Set(frontier)].filter((rel) => !seen.has(rel));
    for (const rel of batch) seen.add(rel);
    frontier = directImports(batch).flat();
  }
  return [...seen].sort();
}

test('repo config: the import scanner finds multi-line, export-from and bare imports and skips bare specifiers and comments', () => {
  const src = "import a from './a.mjs';\nimport {\n  b,\n  c,\n} from '../b.mjs';\nexport { d } from './d.mjs';\nimport './e.mjs';\nimport fs from 'node:fs';\n// import x from './nope.mjs';\nexport const s = './f.mjs';\n";
  assert.deepEqual(scanImports([src])[0].static, ['./a.mjs', '../b.mjs', './d.mjs', './e.mjs', 'node:fs']);
});

test('repo config: the import scanner follows a dynamic import with a literal path (any quote, a backtick with no interpolation), ignores an interpolated or computed one, and over-matches a commented one', () => {
  const src = "const m = await import('./dyn.mjs');\nconst n = import(\"../up.mjs\").then((x) => x);\nawait import(name);\nawait import(`./tpl-${x}.mjs`);\nawait import(`./tick.mjs`);\nawait import(/* why */ './cmt.mjs', { with: {} });\n// await import('./mention.mjs');\n";
  assert.deepEqual(scanImports([src])[0].dynamic, ['./dyn.mjs', '../up.mjs', './tick.mjs', './cmt.mjs', './mention.mjs']);
});

test('repo config: the dynamic-import scan allows a comment between import, the paren, the specifier and the closing paren or comma', () => {
  const src = [
    "await import('./a-trail.mjs' /* why */);",
    "await import /* why */ ('./b-before-paren.mjs');",
    "await import( // why",
    "  './c-line.mjs');",
    "await import(\n  /* one */ /* two */ // three\n  \"./d-mixed.mjs\" // four\n  , { with: {} });",
    "await import /* a */ // b\n (`./e-tick.mjs` /* c */);",
    "await import(/* a * / b */ './f-star.mjs');",
    "await import(/* why */ name);",
    "",
  ].join('\n');
  assert.deepEqual(scanImports([src])[0].dynamic, ['./a-trail.mjs', './b-before-paren.mjs', './c-line.mjs', './d-mixed.mjs', './e-tick.mjs', './f-star.mjs']);
});

test('repo config: round-4 regressions (R4-B1, R4-F1): no dynamic-import match consumes a later import, whatever comment or computed import comes first', () => {
  // A computed import with a leading block comment must not reach a later `*/` and eat the real import after it.
  const computed = "await import(/* @vite-ignore */ url);\nawait import('./real.mjs');\nlog(/* level */ 'info', msg);\n";
  assert.deepEqual(scanImports([computed])[0].dynamic, ['./real.mjs']);
  // Codex's case: a mention in a line comment opens a `/*` that a later line comment closes; the real import in between stays found.
  const fake = "// import('./fake.mjs' /*\nawait import('./real.mjs');\n// */);\n";
  assert.deepEqual(scanImports([fake])[0].dynamic, ['./fake.mjs', './real.mjs']);
  // The earlier test's `import(/* why */ name)` line moved FIRST must still return every later specifier.
  const moved = [
    "await import(/* why */ name);",
    "await import('./a-trail.mjs' /* why */);",
    "await import /* why */ ('./b-before-paren.mjs');",
    "await import( // why",
    "  './c-line.mjs');",
    "",
  ].join('\n');
  assert.deepEqual(scanImports([moved])[0].dynamic, ['./a-trail.mjs', './b-before-paren.mjs', './c-line.mjs']);
  // A static import with a comment before its brace, then a comment before a later parenthesis.
  const staticFirst = "import /* types */ { a } from './a.mjs';\nconst s = f /* x */ ('./not-an-import.mjs');\nawait import('./later.mjs');\n";
  assert.deepEqual(scanImports([staticFirst])[0].dynamic, ['./later.mjs']);
});

test('repo config: the import scanner does not skip a multi-line import whose braces hold a comment with a quote, semicolon or brace', () => {
  const src = [
    "import {",
    "  a, // the owner's pick; see #1",
    "  /* don't drop; \"b\" } */ b,",
    "  c, // a } stray brace",
    "} from './multi.mjs';",
    "import { d } from './after.mjs';",
    "",
  ].join('\n');
  assert.deepEqual(scanImports([src])[0].static, ['./multi.mjs', './after.mjs']);
});

test('repo config: a `/*` inside a string, a `//` comment, a regex literal or a nested template does not hide the imports after it', () => {
  const inString = "const g = 'a /* b';\nimport { x } from './kept-after-string.mjs';\nconst h = 'src/**/*.mjs';\nexport { y } from './kept-after-glob.mjs';\n";
  assert.deepEqual(scanImports([inString])[0].static, ['./kept-after-string.mjs', './kept-after-glob.mjs']);
  const inLine = "// see /* the glob\nimport { x } from './kept-after-line.mjs';\n// and src/**/ here\nimport './kept-after-glob.mjs';\n";
  assert.deepEqual(scanImports([inLine])[0].static, ['./kept-after-line.mjs', './kept-after-glob.mjs']);
  const inTemplate = "const t = `/* ${1}`;\nimport z from './kept-after-template.mjs';\n/* real */ import w from './kept-after-block.mjs';\n";
  assert.deepEqual(scanImports([inTemplate])[0].static, ['./kept-after-template.mjs', './kept-after-block.mjs']);
  // A real block comment still hides an import it holds, and ends at its own `*/`.
  assert.deepEqual(scanImports(["/*\nimport a from './hidden.mjs';\n*/\nimport b from './shown.mjs';\n"])[0].static, ['./shown.mjs']);
  // Round-2 regressions (R2-B1, R2-F1): the old hand-written scanner opened a fake block comment at each of these and dropped the import after it.
  const inRegex = "const re = /[/*]/;\nimport x from './late.mjs';\n";
  assert.deepEqual(scanImports([inRegex])[0].static, ['./late.mjs']);
  const nested = "const g = `${a ? `${d}/*` : ''}`;\nimport x from './late.mjs';\n";
  assert.deepEqual(scanImports([nested])[0].static, ['./late.mjs']);
  const tickInRegex = "const r = /[`'\"]/;\nconst t = `a/*`;\nimport x from './late.mjs';\nexport * from './reexp.mjs';\n";
  assert.deepEqual(scanImports([tickInRegex])[0].static, ['./late.mjs', './reexp.mjs']);
  const everything = ["const re = /[/*]/;", "const g = `${a ? `${d}/*` : ''}`;", "import x from './late.mjs';", "import {", "  a, // a } stray brace", "  /* b } */ b,", "} from './multi.mjs';", "export * from './reexp.mjs';", ""].join('\n');
  assert.deepEqual(scanImports([everything])[0].static, ['./late.mjs', './multi.mjs', './reexp.mjs']);
});

test('repo config: a source the engine cannot parse makes the scanner throw (the closure test fails closed)', () => {
  assert.throws(() => scanImports(["import x from './a.mjs';\nconst = ;\n"]), /static import parse failed/);
});

test('repo config: the gate and review-proof named set is in risk.high_risk_paths, and a one-line change to any of them rates high', () => {
  const named = [
    'pipeline/lib/transcript.mjs', 'pipeline/lib/ci-proof.mjs', 'pipeline/lib/integrity.mjs', 'pipeline/lib/guard-provenance.mjs',
    'pipeline/lib/state.mjs', 'pipeline/lib/review-publish.mjs', 'pipeline/lib/review-context.mjs', 'pipeline/lib/locks.mjs',
    'pipeline/lib/round-status.mjs', 'pipeline/commands/final-gate.mjs', 'pipeline/commands/triage.mjs', 'pipeline/commands/model-proof.mjs',
    'pipeline/bin/pipeline.mjs',
    // direct imports of finalgate.mjs, then the helpers the review commands run on
    'pipeline/lib/closing-keywords.mjs', 'pipeline/lib/preflight.mjs', 'pipeline/lib/verify-steps.mjs', 'pipeline/lib/merge-queue.mjs',
    'pipeline/lib/github.mjs', 'pipeline/lib/codex.mjs', 'pipeline/lib/codex-exec.mjs', 'pipeline/lib/fix-verify.mjs',
    'pipeline/lib/hold.mjs', 'pipeline/lib/merge-hold.mjs', 'pipeline/lib/cli.mjs', 'pipeline/lib/cmd-common.mjs',
    'pipeline/lib/review-lease-wiring.mjs',
    // the commands that read or write a gate input or proof, the thin wrappers, and the libs they use (listed by hand: no import reaches them)
    'pipeline/commands/state.mjs', 'pipeline/commands/model-floor.mjs', 'pipeline/lib/owner-only.mjs', 'pipeline/commands/verify.mjs',
    'pipeline/lib/command-guard.mjs', 'pipeline/commands/ci-wait.mjs', 'pipeline/lib/ci-wait.mjs',
    'pipeline/commands/risk.mjs', 'pipeline/commands/hardstops.mjs', 'pipeline/commands/integrity.mjs', 'pipeline/commands/preflight.mjs',
    // the comment publisher, the update commands (owner-only guards), and the libs the gate-side commands use
    'pipeline/lib/claude-ancestry.mjs', 'pipeline/lib/protection.mjs', 'pipeline/commands/comment.mjs', 'pipeline/commands/update.mjs',
    'pipeline/lib/update-schedule.mjs',
  ];
  const list = raw.risk.high_risk_paths;
  const { config } = validateConfig(raw);
  for (const p of named) {
    assert.ok(matchAny(p, list, { nocase: true }), `${p} is not matched by risk.high_risk_paths`);
    const files = [{ path: p, added: ['// one line'], removed: [] }];
    const r = assessRisk({ files, hits: [], config });
    assert.equal(r.level, 'high', `${p}: ${r.reasons.join('; ')}`);
    assert.equal(r.drivers.path, true, p);
    assert.equal(reviewLane({ level: r.level, files, config }).reviewer, 'fable', p);
  }
  // Control: a file outside the list with the same one-line change stays low and goes to the judge.
  const other = [{ path: 'pipeline/lib/unlisted-example.mjs', added: ['// one line'], removed: [] }];
  assert.equal(assessRisk({ files: other, hits: [], config }).level, 'low');
});

test('repo config: every file the risk rating imports (transitively) is covered by risk.high_risk_paths', () => {
  const list = raw.risk.high_risk_paths;
  const closure = importClosure('pipeline/lib/risk.mjs');
  // The 14 files the rater reads today (2026-11-13). A walker that silently loses an import drops one of them and fails here; a NEW
  // import only grows the closure and must be covered by the check below.
  const known = [
    'pipeline/lib/risk.mjs', 'pipeline/lib/config.mjs', 'pipeline/lib/diff.mjs', 'pipeline/lib/doc-paths.mjs', 'pipeline/lib/git.mjs',
    'pipeline/lib/glob.mjs', 'pipeline/lib/hardstops.mjs', 'pipeline/lib/paths.mjs', 'pipeline/lib/proc.mjs', 'pipeline/lib/resolution.mjs',
    'pipeline/lib/seams.mjs', 'pipeline/lib/shell-words.mjs', 'pipeline/lib/yaml.mjs', 'pipeline/vendor/js-yaml.mjs',
  ];
  assert.deepEqual(known.filter((f) => !closure.includes(f)), [], `import closure of pipeline/lib/risk.mjs lost a known file: ${closure.join(', ')}`);
  assert.ok(closure.length >= known.length, `suspiciously small import closure: ${closure.join(', ')}`);
  const uncovered = closure.filter((f) => !matchAny(f, list, { nocase: true }));
  assert.deepEqual(uncovered, [], `imported by pipeline/lib/risk.mjs but not in risk.high_risk_paths: ${uncovered.join(', ')}`);
});

test('repo config: every relative import of pipeline/lib/finalgate.mjs (depth 1) is covered by risk.high_risk_paths', () => {
  const list = raw.risk.high_risk_paths;
  const [direct] = directImports(['pipeline/lib/finalgate.mjs']);
  // finalgate.mjs imports a few dozen files today (2026-11-13); a scanner that silently loses its imports fails here.
  assert.ok(direct.length >= 20, `suspiciously few direct imports of finalgate.mjs: ${direct.join(', ')}`);
  for (const f of ['pipeline/lib/triage.mjs', 'pipeline/lib/model-floor.mjs', 'pipeline/hooks/lib/owner-go.mjs']) assert.ok(direct.includes(f), `${f} is no longer found in finalgate.mjs's imports: ${direct.join(', ')}`);
  const uncovered = direct.filter((f) => !matchAny(f, list, { nocase: true }));
  assert.deepEqual(uncovered, [], `imported by pipeline/lib/finalgate.mjs but not in risk.high_risk_paths: ${uncovered.join(', ')}`);
});
