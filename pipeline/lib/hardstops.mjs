// Hard-stop classifier: a PR it flags can NEVER auto-merge; it waits for the human owner. A false negative lets
// something dangerous (dropped data, weakened row-level security, a leaked secret, an edit to the pipeline's own rules,
// a major dependency jump, payroll/health/biometric data) reach production unattended; a false positive costs one click.
// So every judgement call below errs toward flagging. The same file is vendored into each project and runs in CI.
//
// Rules: R0-unscannable | R1-destructive | R1-migration-edited | R2-auth | R2-auth-removed | R2-sql-removed |
//        R2-sql-statement | R3-secrets | R4-pipeline | R5-major-dep | R6-sensitive | P-path | P-pattern
//
// Shape: a pure core (`classifyHardStops` and the helpers exported for tests) plus ONE supported entry point,
// `collectHardStops`, which gathers what a diff cannot show: env names already on the base, package.json /
// requirements before and after, and whole SQL statements around changed lines. `classifyHardStops` refuses to run when
// the diff touches SQL or package.json and the matching inputs were not passed, so a caller cannot silently lose coverage.
//
// Principles that matter for safety:
//  * A file whose content we cannot read (binary diff of a non-asset, a line over 20,000 chars) is itself a hit
//    (R0-unscannable): git marks a text file "binary" on a single NUL byte, and nothing else would look at it.
//  * Content rules (SQL, auth, secrets, env, sensitive terms) judge PRODUCTION code only: not tests, not documentation.
//    "Documentation" is a file that cannot execute (markdown, text, images, pdf); under docs/ a .ts/.js/.sql module is
//    still code, because production code can import it. Test files are exempt from every content rule EXCEPT key-shaped
//    secret literals (a real key committed in a fixture leaks all the same; a "fake" marker counts only when it sits in the
//    credential token itself, never in a comment or a neighbouring name on the line).
//    Path rules and the R1 migration rules judge every file.
//  * An exempt file wired into production would never be judged, so BOTH directions are flagged (R0-unscannable):
//      - forward: production code adds an import of one. Specifiers are read over the whole new file (an import split over
//        lines, or a Python bracketed / backslash statement, is one import) and count when a line they span was added; comments
//        are never blanked (a prefix such as `-- i;` or `// */` is not always a comment): every line is read raw, and an import
//        written inside a comment is flagged too. Python statements are joined by a tokenizer that skips strings and `#`
//        comments before counting brackets, with no length cap while a bracket is open; a file over ~2 MB is R0-unscannable. Each import specifier (JS/TS `from`,
//        `import`, `import()`, `require()`; Python `from a.b import` / `import a.b`; Ruby `require` / `require_relative`
//        / `load`) is turned into every repo path it could name (relative: resolved against the importing file; otherwise
//        from the root, with `@/` `~/` `#/` `@@/` stripped and every path-segment suffix; Python dotted -> slash path; each
//        with source extensions, `/index`, `/__init__` and, for TypeScript ESM, `.js` standing for `.ts`) and flagged when ANY of them passes the SAME test-file predicate the
//        exemption uses, so no spelling of a path can reach an exempt location unseen. Over-matching is the safe direction.
//      - reverse: the PR edits an exempt test file that production code at head ALREADY imports (the importing line is not in
//        the diff, so the forward check never sees it), directly or through other test files (prod -> tests/a -> tests/b):
//        a grep of the head tree finds the files that mention the changed basenames, they are read whole and the same
//        resolver says which really import them; test importers join the chain for a bounded number of rounds. A grep that
//        fails, or a result or chain over its cap, flags the changed test files concerned.
//  * Content that MOVES is judged too: a rename from an exempt path (test, docs) into production code carries lines the
//    diff does not show (R0-unscannable), and a symlink (mode 120000) or submodule (160000) can make a production path serve
//    a file from an exempt one or point at unreviewed code (R4-pipeline). A 100% rename has no mode line in the unified
//    diff, so symlink / gitlink are read from the old and new tree modes (`git diff --raw`), not from diff headers.
//  * Binary assets (images, fonts, media, pdf, svg, snapshots) are accepted unread. Archives and blobs (.zip .gz .tgz .bin)
//    and .wasm are not: code that extracts or loads an existing one runs whatever replaces it, with no source line to read.
//    An archive is accepted only as a test fixture (every path of the change a test file); anything else is R0-unscannable.
//  * A pure mode change (chmod) is NOT a finding: it adds no unjudged content, since the file's content was judged when it
//    was added (and a change to or from a symlink or submodule mode is caught above).
//  * SQL keyword rules run on comment-stripped text; the stripper is string-aware and only carries a block comment across
//    CONSECUTIVE added lines (a gap means we cannot know the state, so we assume code). In non-SQL code, SQL lives in
//    strings, so only multi-word forms are matched there (no bare "grant" or "truncate").
//  * `-U0` diffs show single lines, so the wrapper also classifies the WHOLE enclosing statement of every changed SQL line
//    at both base and head (an edit inside a multi-line `create policy` has no keyword on the changed line).
//  * Path rules test the old AND the new path, case-insensitively. Exclusions (docs, tests) match the path as written.
import { posix } from 'node:path';
import { matchAny } from './glob.mjs';
import { DEFAULTS } from './config.mjs';
import { diffFiles, diffModes, mergeBase, showFile, git, GitError } from './git.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------

// A line longer than this is not scanned by any regex (ReDoS guard); its file becomes R0-unscannable instead.
const MAX_LINE = 20_000;

// Inclusion test (a hit when TRUE), case-insensitive: over-matching is the safe direction.
const inc = (p, globs) => matchAny(p, globs, { nocase: true });

const MIGRATION_GLOBS = ['**/migrations/**'];
// Documentation = content that cannot execute. Anything else under docs/ (a .ts, .mjs, .sql, .json, extensionless file...)
// is code: `import x from '@/docs/evil'` resolves from the repo root in a typical Next app. .mdx is executable (JSX, imports),
// so it is code everywhere; a .md under a Next route dir (app/, pages/) is a page when pageExtensions include md.
const DOC_EXT = /\.(?:md|txt|rst|adoc|png|jpe?g|gif|webp|avif|ico|pdf)$/i;
const MD_ROUTE_GLOBS = ['**/app/**', '**/pages/**'];
const isNonCode = (p) => {
  if (/\.mdx$/i.test(p)) return false;
  if (matchAny(p, ['docs/**'])) return DOC_EXT.test(p);
  return /\.md$/i.test(p) && !matchAny(p, MD_ROUTE_GLOBS);
};

// `docs/migrations/notes.md` documents migrations; it is not one.
const isMigrationPath = (p) => !/\.md$/.test(p) && inc(p, MIGRATION_GLOBS);
// "SQL file": `**/*.sql` or anything under a migrations dir.
const isSqlPath = (p) => inc(p, ['**/*.sql']) || isMigrationPath(p);
// "Code file": not markdown, not under docs/, not a GENUINE test file. An EXCLUSION test, so it matches the path as written.
// A test glob never hides code that really runs: a migration (the Supabase CLI applies `<n>_<name>.sql` whatever the name
// says), any .sql outside supabase/tests/, a route handler / server entry, or a Next page under a directory that happens
// to be called `test`. Only a file NAMED *.test.* / *.spec.* or one in a plain test directory is exempt.
const PGTAP_DIR = ['**/supabase/tests/**'];
const TEST_NAME = /\.(?:test|spec)\.[^/]+$/i;
const NEXT_ENTRY_GLOBS = ['**/app/**/{page,layout,route,default,template,error,not-found,loading,actions,middleware,proxy}.*'];
const isTestFile = (p, testGlobs) => {
  if (!matchAny(p, testGlobs)) return false;
  if (isMigrationPath(p)) return false;
  if (/\.sql$/i.test(p)) return matchAny(p, PGTAP_DIR);
  if (TEST_NAME.test(p)) return true;
  return !inc(p, SERVER_ENTRY_GLOBS) && !inc(p, NEXT_ENTRY_GLOBS);
};
const isCodeFile = (p, testGlobs) => !isNonCode(p) && !isTestFile(p, testGlobs);

// Binary changes we accept without reading: assets nobody can hide logic in.
// (wasm is NOT one: replacing an existing module changes what runs with no source line in the diff. Neither are archives
// and blobs: code that extracts or loads an existing .zip / .gz / .tgz / .bin runs whatever the replacement holds.)
const BINARY_ASSET = /\.(?:png|jpe?g|gif|webp|avif|ico|svg|pdf|woff2?|ttf|otf|eot|mp4|mov|mp3|wav|snap)$/i;
// Accepted unread ONLY as a test fixture (every path of the change a test file).
const BINARY_FIXTURE = /\.(?:zip|gz|tgz|bin)$/i;

const R2_PATH_GLOBS = [
  '**/auth/**', '**/middleware.{ts,tsx,js,jsx,mjs,mts,cjs,cts}', '**/*rbac*/**', '**/*rbac*', '**/roles*', '**/roles*/**',
  '**/permissions*', '**/permissions/**', '**/rls/**', '**/*policy*.{ts,js,mjs,sql}',
  // Beyond the spec: Next 16 renamed middleware.ts to proxy.ts; session/JWT modules; the admin-client / service-role
  // module itself; Supabase's auth settings.
  '**/proxy.{ts,tsx,js,jsx,mjs,mts,cjs,cts}', '**/middleware/**', '**/authz*', '**/authn*', '**/session*', '**/session*/**', '**/jwt*',
  '**/jwt*/**', '**/supabase/admin.*', '**/*admin-client*', '**/*admin_client*', '**/*adminclient*', '**/*service-role*',
  '**/*service_role*', '**/*servicerole*', '**/supabase/config.toml',
];
// Any path segment containing auth / oauth / authz / authenticate / authorize, but not author / authority.
const AUTH_SEGMENT = /auth(?!or(?!iz))/i;
// A login/logout/sign-in directory or file holds auth logic; its pure UI files (tsx, css, ...) do not.
const LOGIN_SEGMENT = /^(?:log-?in|log-?out|sign-?in|sign-?out|sign-?up)(?:\.[^.]+)?$/i;
const UI_FILE = /\.(?:tsx|jsx|css|scss|less|svg|png|jpe?g|gif|webp|md|mdx)$/i;
const isAuthLogicPath = (p) =>
  p.split('/').some((s) => AUTH_SEGMENT.test(s)) || (!UI_FILE.test(p) && p.split('/').some((s) => LOGIN_SEGMENT.test(s)));

// A NEW file here is a new server entry point: someone must check it authenticates.
const SERVER_ENTRY_GLOBS = ['**/app/**/route.*', '**/pages/api/**', '**/supabase/functions/*/index.*'];

const R3_PATH_GLOBS = [
  '**/.env*', '**/*.pem', '**/*.key', '**/secrets/**',
  // Beyond the spec: other private-key / credential containers.
  '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.netrc',
  '**/credentials*.json', '**/*service-account*.json',
];
const R4_PATH_GLOBS = [
  '**/.github/**', '**/.claude/**', '**/.githooks/**', '**/CODEOWNERS',
  // Agent-instruction files steer the agents that review and write code; a PR must not rewrite its own rules.
  '**/CLAUDE.md', '**/AGENTS.md', '**/.cursorrules', '**/.github/copilot-instructions.md',
  // A submodule add repoints the checkout at code nobody reviewed here.
  '**/.gitmodules', '**/scripts/verify*', '**/scripts/verify*/**',
  '**/scripts/pipeline/**', '**/pipeline.yml', '**/vitest.config.*', '**/vitest.workspace.*', '**/jest.config.*',
  '**/playwright*.config.*', '**/.nycrc*', '**/codecov.y*ml', '**/.husky/**',
  // Beyond the spec: other places the verify gate or the build can be loosened.
  '**/vitest.setup.*', '**/jest.setup.*', '**/cypress.config.*', '**/.mocharc*', '**/eslint.config.*', '**/.eslintrc*',
  '**/lefthook*.y*ml', '**/.pre-commit-config.y*ml', '**/.gitattributes', '**/next.config.*', '**/vite.config.*',
  '**/tsconfig*.json',
];
// pgTAP tests are the RLS safety net: deleting or moving one weakens it (editing one is left to the test-integrity check).
const TEST_DIR_GLOBS = ['**/supabase/tests/**'];
const WORKFLOW_GLOBS = ['**/.github/workflows/**'];

// `\b` treats `_` as a word character, so `tin_number` would dodge `\btin\b`; use explicit [a-z0-9] boundaries.
const SENSITIVE_PATH = new RegExp(
  'biometric|facial|face[-_]?(?:recog|match|detect|api)|liveness|rekognition|fingerprint|selfie|' +
    'health[-_]?(?:record|data|info|card)|medical|patient|diagnos(?:is|es)(?![a-z])|payroll|payslip|salar(?:y|ies)|wage|' +
    'bank[-_]?account|philhealth|pag[-_]?ibig|' +
    '(?<![a-z0-9])(?:compensations?|withholdings?|gov[-_]?contributions?|bir[-_]?2316)(?![a-z0-9])|(?<![0-9])13th[-_]?month(?![a-z0-9])|' +
    '(?<![a-z0-9])(?:bank(?:ing)?|faces?|pii|ssn|tin|sss)(?![a-z0-9])',
  'i',
);
// Terms inside added lines (word-bounded; `_` and camelCase count as separators).
const SENSITIVE_TEXT = new RegExp(
  '(?<![a-z0-9])(?:payroll|payslip|salar(?:y|ies)|philhealth|pag-?ibig|sss_number|tin_number|biometric|face_embedding|' +
    'fingerprint_template|bank_account|iban|routing_number|diagnosis|patient_id|medical_record|' +
    'compensations?|withholdings?|gov[-_ ]?contributions?|bir[-_ ]?2316)(?![a-z0-9])|(?<![0-9])13th[-_ ]?month(?![a-z0-9])',
  'i',
);
// employeeTin.ts / validateSSN.ts / getPayroll() have no separator before the term; test a camelCase-split copy as well.
const camelSplit = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const isSensitivePath = (p) => SENSITIVE_PATH.test(p) || SENSITIVE_PATH.test(p.replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
const isSensitiveText = (t) => SENSITIVE_TEXT.test(t) || SENSITIVE_TEXT.test(camelSplit(t));

// ---------------------------------------------------------------------------------------------------------------
// SQL: comment/string-aware scanning
// ---------------------------------------------------------------------------------------------------------------

const MASK = ''; // stands in for a comment character; same length as the original, so offsets line up.
// BEGIN ATOMIC / CASE / END are tracked so a `BEGIN ATOMIC ... END` function body is one statement (see scanSql).
const SQL_SPECIAL = /--|\/\*|'|"|\$|;|\b(?:BEGIN\s+ATOMIC|CASE|END)\b/gi;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const isIdentChar = (c) => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);

// End index (exclusive) of the quoted run starting at `start`. `''` / `""` are escaped quotes; E'..' strings also
// take backslash escapes.
function endOfQuoted(text, start, backslash) {
  const q = text[start];
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (backslash && c === '\\') j += 2;
    else if (c !== q) j++;
    else if (text[j + 1] === q) j += 2;
    else return j + 1;
  }
  return text.length;
}

// One pass over SQL text. Returns `marked` (same text, comment characters replaced by MASK, newlines kept) and `semis`
// (offsets of the statement-ending `;` that sit outside strings, comments and dollar-quoted bodies). Block comments do
// not nest (Postgres nests them; ignoring that only ever exposes MORE text to the rules). A dollar-quoted body is
// scanned recursively as code (plpgsql bodies are real code with real comments) but cannot end the outer statement.
// A SQL-standard `BEGIN ATOMIC ... END` body (its CASE ... END pairs counted) likewise holds its `;`s inside ONE statement.
function scanSql(text) {
  const out = [];
  const semis = [];
  const blank = (s) => s.replace(/[^\n]/g, MASK);
  let atomic = 0; // 0 = outside a BEGIN ATOMIC body; else 1 + the number of open CASE
  let i = 0;
  while (i < text.length) {
    SQL_SPECIAL.lastIndex = i;
    const m = SQL_SPECIAL.exec(text);
    if (!m) {
      out.push(text.slice(i));
      break;
    }
    if (m.index > i) out.push(text.slice(i, m.index));
    i = m.index;
    const tok = m[0];
    if (tok === '--') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      out.push(blank(text.slice(i, end)));
      i = end;
    } else if (tok === '/*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out.push(blank(text.slice(i, end)));
      i = end;
    } else if (tok === "'" || tok === '"') {
      const eString = tok === "'" && /[eE]/.test(text[i - 1] ?? '') && !isIdentChar(text[i - 2]);
      const end = endOfQuoted(text, i, eString);
      out.push(text.slice(i, end));
      i = end;
    } else if (tok === '$') {
      DOLLAR_TAG.lastIndex = i;
      const t = isIdentChar(text[i - 1]) ? null : DOLLAR_TAG.exec(text);
      if (!t) {
        out.push('$');
        i++;
        continue;
      }
      const tag = t[0];
      const bodyStart = i + tag.length;
      const close = text.indexOf(tag, bodyStart);
      const bodyEnd = close === -1 ? text.length : close;
      out.push(tag, scanSql(text.slice(bodyStart, bodyEnd)).marked);
      i = bodyEnd;
      if (close !== -1) {
        out.push(tag);
        i = close + tag.length;
      }
    } else if (tok !== ';') {
      // A keyword token: only meaningful around a BEGIN ATOMIC body.
      if (/^BEGIN/i.test(tok)) atomic = atomic === 0 ? 1 : atomic;
      else if (atomic > 0 && /^CASE$/i.test(tok)) atomic++;
      else if (atomic > 0 && /^END$/i.test(tok)) atomic--;
      out.push(tok);
      i += tok.length;
    } else {
      if (atomic === 0) semis.push(i);
      out.push(';');
      i++;
    }
  }
  return { marked: out.join(''), semis };
}

// `text` with `--` and `/* */` comments blanked to spaces (same length, same newlines). Strings keep their content.
export function stripSqlComments(text) {
  return scanSql(text).marked.replaceAll(MASK, ' ');
}

// Comment-stripped text for each line of one side of a diff. Consecutive line numbers form a run that is scanned as one
// piece (so a block comment or a multi-line string is understood); a gap restarts the scan in "code" state.
function maskLines(lines) {
  const sorted = [...lines].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const result = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const masked = stripSqlComments(run.map((l) => l.text).join('\n')).split('\n');
    run.forEach((l, i) => result.push({ line: l.line, text: l.text, masked: masked[i] ?? l.text }));
    run = [];
  };
  for (const l of sorted) {
    if (run.length > 0 && l.line !== run[run.length - 1].line + 1) flush();
    run.push(l);
  }
  flush();
  return result;
}

// For each 1-based line, every statement that has code on that line: text from just after the previous top-level `;`
// to the next one (or the file edges), comments removed, blank lines dropped. Deduped, in file order. A line holding
// only whitespace or a comment belongs to no statement: its edit cannot change what a statement does.
export function enclosingStatements(sqlText, lineNumbers) {
  const { marked, semis } = scanSql(sqlText);
  const n = sqlText.length;
  const lineStarts = [0];
  for (let i = sqlText.indexOf('\n'); i !== -1; i = sqlText.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const firstSemiAtOrAfter = (pos) => {
    let lo = 0;
    let hi = semis.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (semis[mid] >= pos) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const wanted = new Set();
  for (const ln of lineNumbers) {
    if (!Number.isInteger(ln) || ln < 1 || ln > lineStarts.length) continue;
    const start = lineStarts[ln - 1];
    const end = ln < lineStarts.length ? lineStarts[ln] - 1 : n;
    const code = marked.slice(start, end).replaceAll(MASK, ' ');
    const first = code.search(/\S/);
    if (first === -1) continue;
    const last = code.search(/\S\s*$/);
    for (let k = firstSemiAtOrAfter(start + first); k <= firstSemiAtOrAfter(start + last); k++) wanted.add(k);
  }
  const out = [];
  const seen = new Set();
  for (const k of [...wanted].sort((a, b) => a - b)) {
    const from = k === 0 ? 0 : semis[k - 1] + 1;
    const to = k < semis.length ? semis[k] + 1 : n;
    const text = marked
      .slice(from, to)
      .replaceAll(MASK, '')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.trim() !== '')
      .join('\n')
      .trim();
    if (text !== '' && text !== ';' && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Rule tables
// ---------------------------------------------------------------------------------------------------------------

const IDENT = String.raw`(?:"[^"]*"|\w+)(?:\.(?:"[^"]*"|\w+))*`;
const re = (src) => new RegExp(src, 'i');

// SQL rules: [label, sqlRe, codeRe?]. `sqlRe` runs on SQL files (comment-stripped lines, whole statements). `codeRe`, when
// present, runs on added lines of other code files, where SQL lives inside strings: only multi-word forms, so ordinary
// prose and identifiers ("grant access", `truncate()`, "drop down") do not match. Without a `codeRe` the rule is SQL-only.
const R1_SQL = [
  // Any DROP in SQL (CONSTRAINT / SEQUENCE / OWNED ... are one-way too); an object list in code.
  ['DROP', re(String.raw`\bDROP\s+\w+`), re(String.raw`\bDROP\s+(?:TABLE|COLUMN|SCHEMA|(?:MATERIALIZED\s+)?VIEW|FUNCTION|POLICY|TRIGGER|INDEX|TYPE|DATABASE|ROLE|EXTENSION|CONSTRAINT|SEQUENCE|DOMAIN|USER|OWNED)\b`)],
  ['TRUNCATE', re(String.raw`\bTRUNCATE\b`), re(String.raw`\bTRUNCATE\s+TABLE\b|\bTRUNCATE\s+(?:ONLY\s+)?[\w."]+\s*(?:;|CASCADE\b|RESTART\b|['"\x60])`)],
  ['ALTER TABLE ... RENAME', re(String.raw`\bALTER\s+TABLE\b[^;]*\bRENAME\b`), re(String.raw`\bALTER\s+TABLE\b[^;]*\bRENAME\b`)],
  ['RENAME COLUMN/TO', re(String.raw`\bRENAME\s+(?:COLUMN|TO)\b`), re(String.raw`\bRENAME\s+(?:COLUMN|TO)\b`)],
  ['DELETE FROM', re(String.raw`\bDELETE\s+FROM\b`), re(String.raw`\bDELETE\s+FROM\b`)],
  // Quoted names (with spaces), an alias, ONLY: `update "My Table" t set ...`.
  ['UPDATE ... SET', re(String.raw`\bUPDATE\s+(?:ONLY\s+)?${IDENT}(?:\s+(?:AS\s+)?(?:"[^"]*"|\w+))?\s+SET\b`), re(String.raw`\bUPDATE\s+(?:ONLY\s+)?${IDENT}(?:\s+(?:AS\s+)?(?:"[^"]*"|\w+))?\s+SET\b`)],
  ['ALTER COLUMN ... TYPE', re(String.raw`\bALTER\s+COLUMN\b[^;]*\b(?:TYPE|SET\s+DATA\s+TYPE)\b`), re(String.raw`\bALTER\s+COLUMN\b[^;]*\b(?:TYPE|SET\s+DATA\s+TYPE)\b`)],
  // COLUMN is optional in `ALTER TABLE t ALTER c TYPE x`.
  ['ALTER TABLE ... ALTER x TYPE', re(String.raw`\bALTER\s+TABLE\b[^;]*\bALTER\s+(?:COLUMN\s+)?(?:"[^"]*"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b`), re(String.raw`\bALTER\s+TABLE\b[^;]*\bALTER\s+(?:COLUMN\s+)?(?:"[^"]*"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b`)],
  ['ALTER COLUMN ... DROP', re(String.raw`\bALTER\s+COLUMN\b[^;]*\bDROP\b`), re(String.raw`\bALTER\s+COLUMN\b[^;]*\bDROP\b`)],
  ['ALTER TABLE ... ALTER x DROP', re(String.raw`\bALTER\s+TABLE\b[^;]*\bALTER\s+(?:COLUMN\s+)?(?:"[^"]*"|\w+)\s+DROP\b`)],
  ['ON CONFLICT DO UPDATE', re(String.raw`\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b`), re(String.raw`\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b`)],
  ['MERGE INTO', re(String.raw`\bMERGE\s+INTO\b`), re(String.raw`\bMERGE\s+INTO\b`)],
  // Dynamic SQL cannot be scanned. (`EXECUTE FUNCTION` in a trigger and `GRANT EXECUTE ON` are not dynamic SQL.)
  ['EXECUTE (dynamic SQL)', re(String.raw`(?<!\b(?:GRANT|REVOKE)\s+)\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)`)],
];

// psql meta-commands run other files, shell commands or reconnect as someone else: nothing a diff of this line shows.
const PSQL_META = /^\s*\\(?:(?:i|ir|include|include_relative|copy|connect|c|o|set|gset|g|gexec|lo_import|lo_export)(?![A-Za-z0-9_])|!)/;

const R2_SQL = [
  ['POLICY', re(String.raw`\b(?:CREATE|ALTER|DROP)\s+POLICY\b`), re(String.raw`\b(?:CREATE|ALTER|DROP)\s+POLICY\b`)],
  ['ROW LEVEL SECURITY', re(String.raw`\b(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b`), re(String.raw`\b(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b`)],
  ['GRANT', re(String.raw`\bGRANT\b`), re(String.raw`\bGRANT\b[^;\n]*\b(?:ON|TO)\b`)],
  ['REVOKE', re(String.raw`\bREVOKE\b`), re(String.raw`\bREVOKE\b[^;\n]*\b(?:ON|FROM|TO)\b`)],
  ['SECURITY DEFINER/INVOKER', re(String.raw`\bSECURITY\s+(?:DEFINER|INVOKER)\b`), re(String.raw`\bSECURITY\s+(?:DEFINER|INVOKER)\b`)],
  ['auth.uid/jwt/role()', re(String.raw`\bauth\.(?:uid|jwt|role|email)\s*\(`)],
  ['ROLE DDL', re(String.raw`\b(?:CREATE|ALTER|DROP)\s+ROLE\b`), re(String.raw`\b(?:CREATE|ALTER|DROP)\s+ROLE\b`)],
  ['SET ROLE', re(String.raw`\bSET\s+(?:(?:LOCAL|SESSION)\s+)?ROLE\b`)],
  ['BYPASSRLS', re(String.raw`\bBYPASSRLS\b`), re(String.raw`\bBYPASSRLS\b`)],
  // Beyond the spec: other ways to change who can see or do what.
  ['DEFAULT PRIVILEGES', re(String.raw`\bDEFAULT\s+PRIVILEGES\b`), re(String.raw`\bDEFAULT\s+PRIVILEGES\b`)],
  ['OWNER TO', re(String.raw`\bOWNER\s+TO\b`)],
  ['SET SESSION AUTHORIZATION', re(String.raw`\bSET\s+(?:(?:LOCAL|SESSION)\s+)?SESSION\s+AUTHORIZATION\b`)],
  ['security_invoker turned off', re(String.raw`\bsecurity_invoker\s*=\s*(?:off|false|0|'(?:off|false|0)')`)],
  ['request.jwt', re(String.raw`\brequest\.jwt\b`)],
  // Functions are where RLS helpers live (a SECURITY INVOKER one is still what a policy trusts).
  ['CREATE FUNCTION', re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b`), re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b`)],
  // A view runs with its owner's rights unless it says security_invoker: it can bypass RLS.
  ['CREATE VIEW without security_invoker', re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE|MATERIALIZED)\s+)*VIEW\b(?![^;]*\bsecurity_invoker\b)`), re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE|MATERIALIZED)\s+)*VIEW\b(?![^;]*\bsecurity_invoker\b)`)],
  ['write to auth schema', re(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?"?auth"?\.`), re(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?"?auth"?\.`)],
  ['write to storage.buckets', re(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?"?storage"?\."?buckets\b`), re(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?"?storage"?\."?buckets\b`)],
  ['CREATE/ALTER USER', re(String.raw`\b(?:CREATE|ALTER)\s+USER\b`), re(String.raw`\b(?:CREATE|ALTER)\s+USER\s+(?:"[^"]*"|\w+)\s+(?:WITH|PASSWORD|LOGIN|NOLOGIN|SUPERUSER|CREATEDB|CREATEROLE)\b`)],
  ['trigger on auth table', re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b[^;]*\bON\s+"?auth"?\.`), re(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b[^;]*\bON\s+"?auth"?\.`)],
  ['admin/owner role row', re(String.raw`\bINSERT\s+INTO\s+[\w."]*roles?\b[^;]*['"](?:admin|owner|super_?admin)['"]`), re(String.raw`\bINSERT\s+INTO\s+[\w."]*roles?\b[^;]*['"](?:admin|owner|super_?admin)['"]`)],
  ['PUBLICATION', re(String.raw`\b(?:CREATE|ALTER|DROP)\s+PUBLICATION\b`), re(String.raw`\b(?:CREATE|ALTER|DROP)\s+PUBLICATION\b`)],
  ['SET SCHEMA', re(String.raw`\bALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|SEQUENCE)\b[^;]*\bSET\s+SCHEMA\b`), re(String.raw`\bALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|SEQUENCE)\b[^;]*\bSET\s+SCHEMA\b`)],
];

// First matching label. `code` selects the code-file regexes; a rule with none is skipped there.
const firstSql = (rules, text, code) => {
  for (const [label, sqlRe, codeRe] of rules) {
    const r = code ? codeRe : sqlRe;
    if (r?.test(text)) return label;
  }
  return null;
};
const firstRule = (rules, text) => rules.find(([, r]) => r.test(text))?.[0] ?? null;

// R2-auth in non-SQL code: credentials, the all-powerful client, admin roles, insecure cookies, new server entry points.
const SERVICE_ROLE = /service[_-]?role|supabase[_-]?admin|create[_-]?admin[_-]?client|supabase_service/i;
const AUTH_ADMIN = /\bauth\.admin\./i;
const ROLE_LITERAL = /role\s*[:=]\s*['"](?:admin|owner|super_?admin)/i;
const COOKIE_INSECURE = /\b(?:httpOnly|secure)\s*:\s*false\b/i;
const USE_SERVER = /^\s*['"]use server['"]/;
// R1 in code: a Supabase write that destroys or overwrites rows. Only when `.from(` is on the same line (low noise).
const DATA_WRITE = /\.(?:delete|upsert)\s*\(/i;

// R2-auth-removed: a guard deleted from non-test code. Beyond the spec: `_?` (snake_case codebases), getSession/getClaims
// (Supabase's other auth reads), and the guard SHAPES that need no named helper (401/403, login redirect, role compare,
// middleware matcher).
const AUTH_REMOVED = [
  ['require*Auth/Role/Admin/Scope/Permission/User/Session()', /\brequire\w*(?:Auth|Role|Admin|Scope|Permission|User|Session)\w*\s*\(/i],
  ['assert*Auth/Role/Permission()', /\bassert\w*(?:Auth|Role|Permission)\w*\s*\(/i],
  ['checkPermission()', /\bcheck_?Permission\w*\s*\(/i],
  ['authorize()', /\bauthorize\w*\s*\(/i],
  ['auth.getUser()', /\bauth\.get_?User\s*\(/i],
  ['getUser()', /\bget_?User\s*\(/i],
  ['getSession()/getClaims()', /\bget_?(?:Session|Claims)\s*\(/i],
  ['isAdmin()', /\bis_?Admin\s*\(/i],
  ['hasRole()', /\bhas_?Role\s*\(/i],
  ['can()', /\bcan\s*\(/i],
  ['401/403 response', /\bstatus\s*[:=]\s*40[13]\b/],
  ['login redirect', /\bredirect\s*\(\s*['"`]\/?(?:login|sign-?in|auth)/i],
  ['role comparison', /\.role\s*[!=]==?\s*['"`]/i],
  ['middleware matcher', /\bmatcher\s*:/],
];
// A removed comment or a bare string literal ("Forbidden: ask your admin") is not a removed guard.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|--(?:\s|$)|#(?![A-Za-z_$])|\*(?:\s|\/|$))/;
const STRING_ONLY_LINE = /^\s*(['"`]).*\1[,;]?\s*$/;

const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// R3: content that is a secret by shape. The hit never repeats the line: a leaked key must not be copied into a report.
const SECRET_LITERALS = [
  ['Stripe live key', /sk_live_[0-9A-Za-z]{10,}/],
  ['Stripe restricted key', /rk_live_[0-9A-Za-z]{10,}/],
  ['AWS access key id', /AKIA[0-9A-Z]{16}/],
  ['private key block', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ['GitHub token', /ghp_[0-9A-Za-z]{30,}/],
  ['GitHub fine-grained token', /github_pat_[0-9A-Za-z_]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Vault secret', /vault\.create_secret\s*\(/i],
];
// Test files: key-shaped literals only (no JWT: local Supabase demo keys are JWTs and live in every e2e setup; no Vault),
// and not when the KEY ITSELF says it is fake. A real key pasted into a fixture is still a leaked key, and a "// example"
// comment or a neighbouring `fakeUser` says nothing about it.
const TEST_SECRET_LITERALS = SECRET_LITERALS.filter(([name]) => name !== 'JWT' && name !== 'Vault secret');
const FAKE_MARKER = /example|fake|dummy|placeholder|not[-_ ]?real|redacted|x{6,}|0{8,}/i;
const TEST_SECRET_SCANNERS = TEST_SECRET_LITERALS.map(([name, r]) => [name, new RegExp(r.source, `${r.flags}g`)]);
const TOKEN_CHAR = /[A-Za-z0-9_\-+/=]/;
const TOKEN_CHAR_LEFT = /[A-Za-z0-9_-]/; // not `=`, `/`, `+`: `placeholder=<key>` is a key after a label, not a fake key
// The first key-shaped literal on the line that does not carry a fake marker in the credential token itself: the regex match
// extended over the adjacent token characters (AWS's documented `AKIAIOSFODNN7EXAMPLE` is exempt through its own tail).
function realLookingSecret(text) {
  for (const [name, r] of TEST_SECRET_SCANNERS) {
    for (const m of text.matchAll(r)) {
      let a = m.index;
      let b = m.index + m[0].length;
      while (a > 0 && TOKEN_CHAR_LEFT.test(text[a - 1])) a--;
      while (b < text.length && TOKEN_CHAR.test(text[b])) b++;
      if (!FAKE_MARKER.test(text.slice(a, b))) return name;
    }
  }
  return null;
}
// ---------------------------------------------------------------------------------------------------------------
// Imports: which repo paths does an added `import` line reach? (Exempt test files wired into production are never judged.)
// ---------------------------------------------------------------------------------------------------------------

const IMPORT_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.vue', '.svelte', '.py', '.rb'];
const ALIAS_PREFIX = /^(?:@@|@|~|#)\//;
const MAX_SPECIFIER = 500;
const MAX_SEGMENTS = 24;
// Directories the old fixed regex flagged that the test globs do not cover; kept so no import it caught is lost.
const LEGACY_TEST_DIR = /(?:^|\/)(?:__mocks__|__fixtures__|fixtures)\//i;

const JS_FAMILY = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/i;
const PY_FILE = /\.pyi?$/i;
const RB_FILE = /\.(?:rb|rake|gemspec|ru)$|(?:^|\/)(?:Rakefile|Gemfile)$/i;
// A specifier: a quote, 1..N characters of ANY kind but that quote and a line break, the SAME quote. It cannot swallow a line break
// or an unclosed quote from earlier text, so an import split over lines, or after a stray `require("` in a comment, still reads.
const SPEC_Q = String.raw`(['"\`])((?:(?!\1)[^\n\r]){1,${MAX_SPECIFIER}})\1`;
const JS_IMPORT_FORMS = [
  new RegExp(String.raw`\bfrom\s*${SPEC_Q}`, 'g'), // import x from '..' / export * from '..'
  new RegExp(String.raw`\bimport\s*${SPEC_Q}`, 'g'), // import '..'
  new RegExp(String.raw`\b(?:require|import)(?:\.resolve|Actual|Mock)?\s*\(\s*${SPEC_Q}`, 'g'), // require('..') import('..')
];
const RB_IMPORT_FORM = new RegExp(String.raw`\b(?:require_relative|require|load)\s*\(?\s*${SPEC_Q}`, 'g');
// The names of a `from X import a, b` list end at a `;`, a `#` or the end of the text, however long the list is.
const PY_FROM = /(?:^|;)\s*from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+([^#\n;]*)/gm;
const PY_IMPORT = /(?:^|;)\s*import\s+([^#\n;]+)/gm;
const PY_DYNAMIC = new RegExp(String.raw`\b(?:import_module|__import__)\s*\(\s*${SPEC_Q}`, 'g');

// Every module specifier in `text` (any number of lines): [{ spec, py, start, end }] with the match's offsets (py: a dotted
// Python module, else a path-like string). Generous on purpose: an extra specifier can only add a false positive. Reading
// whole text means an import split over lines (`require(\n  '../x'\n)`, `import {\n a,\n} from '..'`) is read like any other.
export function importSpecifiers(text, file) {
  const out = [];
  const isPy = PY_FILE.test(file);
  const isJs = JS_FAMILY.test(file);
  const add = (spec, py, index, length) => out.push({ spec, py, start: index, end: index + length });
  const python = (src, base) => {
    for (const m of src.matchAll(PY_FROM)) {
      add(m[1], true, base + m.index, m[0].length);
      for (const item of m[2].replace(/[()]/g, ' ').split(',')) {
        const name = /^\s*([A-Za-z_]\w*)/.exec(item)?.[1];
        if (name) add(m[1].endsWith('.') ? `${m[1]}${name}` : `${m[1]}.${name}`, true, base + m.index, m[0].length);
      }
    }
    for (const m of src.matchAll(PY_IMPORT)) {
      for (const item of m[1].split(',')) {
        const mod = /^\s*([A-Za-z_][\w.]*)/.exec(item)?.[1];
        if (mod) add(mod, true, base + m.index, m[0].length);
      }
    }
  };
  if (isPy) {
    python(text, 0);
    for (const m of text.matchAll(PY_DYNAMIC)) add(m[2], true, m.index, m[0].length);
    return out;
  }
  for (const r of JS_IMPORT_FORMS) for (const m of text.matchAll(r)) add(m[2], false, m.index, m[0].length);
  if (!isJs) for (const m of text.matchAll(RB_IMPORT_FORM)) add(m[2], false, m.index, m[0].length);
  // A Python import has no quotes; skipping lines that have them keeps `import test from 'node:test'` out of the Python reading.
  let base = 0;
  for (const line of text.split('\n')) {
    if (!/['"`{]/.test(line)) python(line, base);
    base += line.length + 1;
  }
  return out;
}

// importSpecifiers over `segments` ([{ text, from, to }]: a piece of source and the 1-based lines it covers), each result
// carrying the line range of the segments it spans: { spec, py, from, to }.
function scanSegments(segments, file) {
  const starts = [];
  let pos = 0;
  for (const g of segments) {
    starts.push(pos);
    pos += g.text.length + 1;
  }
  const segOf = (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return segments[lo];
  };
  return importSpecifiers(segments.map((g) => g.text).join('\n'), file).map((m) => ({
    spec: m.spec, py: m.py, from: segOf(m.start).from, to: segOf(Math.max(m.start, m.end - 1)).to,
  }));
}

// Python statements that span lines (an open bracket, a trailing backslash, an open triple-quoted string) as one segment each, so
// `from pkg import (\n a,\n tests,\n)` is one import whichever of its lines was touched. Brackets are counted by a small tokenizer
// that skips string literals (single, double, triple-quoted; a prefix such as r/b/f/u changes nothing about where a literal ends;
// backslash escapes) and `#` comments first, so `x = "("` or a docstring `"""Helpers (see below` cannot desync the depth. A
// statement runs until its brackets close (however many blank or comment lines sit inside) or the file ends. The text of a segment
// has comments removed and its lines joined by a space.
function pythonStatements(lines) {
  const segs = [];
  let str = null; // the delimiter of the string literal we are inside (carried across lines for triple quotes)
  for (let i = 0; i < lines.length; ) {
    const start = i;
    const parts = [];
    let depth = 0;
    for (;;) {
      const line = lines[i];
      let out = '';
      let escapedEol = false;
      let j = 0;
      while (j < line.length) {
        const c = line[j];
        if (str !== null) {
          if (c === '\\') {
            escapedEol = j + 1 >= line.length;
            out += line.slice(j, j + 2);
            j += 2;
          } else if (line.startsWith(str, j)) {
            out += str;
            j += str.length;
            str = null;
          } else {
            out += c;
            j++;
          }
        } else if (c === '#') {
          break;
        } else if (c === '"' || c === "'") {
          str = line.startsWith(c.repeat(3), j) ? c.repeat(3) : c;
          out += str;
          j += str.length;
        } else {
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
          out += c;
          j++;
        }
      }
      if (str !== null && str.length === 1 && !escapedEol) str = null; // an unterminated one-line string ends with its line
      const cont = str === null && /\\\s*$/.test(out);
      if (cont) out = out.replace(/\\\s*$/, '');
      if (out.trim() !== '') parts.push(out.trim());
      i++;
      if (i >= lines.length || !(depth > 0 || cont || str !== null)) break;
    }
    segs.push({ text: parts.join(' '), from: start + 1, to: i });
  }
  return segs;
}

// A string-BLIND fallback for Python: every `from X import (` runs to the first line containing `)`, and every line ending in a
// backslash is joined with the next, ignoring string state entirely. The tokenizer above can be desynced by string syntax it does
// not model (PEP 701 f-strings reuse their own quote inside `{...}`: `f"{d["("]}"`); this reading cannot, because it reads no
// strings. Over-joining here only ever adds candidates. One linear pass: the head of the open statement (`from X import` or
// `import`) is carried, and each continuation line becomes its own short `<head> <names>` segment, so no file shape can make it
// quadratic and no padding (blank or comment lines) can separate a name from its head.
// Heads are found anywhere on the line (`x = 1; from app import (`, `if c: import os, \`), and the LAST one on a line opens.
const PY_BRACKET_FROM = /(?:^|[;:])\s*(from\s+\.*[\w.]*\s+import)\s*\(/g;
const PY_HEAD = /(?:^|[;:])\s*(from\s+\.*[\w.]*\s+import|import)\s/g;
const lastMatch = (re, s) => { let m = null; for (const x of s.matchAll(re)) m = x; return m; };
function pythonImportFallback(lines) {
  const segs = [];
  let head = null; // the head of the statement still open on this line
  let bracket = false; // open through `(` (until a `)`) rather than through a trailing backslash
  let headLine = 0; // 1-based line of the head: each segment spans head..this line, so an edit to the head alone counts too
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Brackets and continuations are judged on the comment-stripped text: a `)` in a comment neither closes nor blocks a statement.
    const code = line.replace(/#.*$/, '');
    const names = code.replace(/\\\s*$/, '');
    if (head !== null) {
      segs.push({ text: `${head} ${names.replace(/[()]/g, ' ').trim()}`, from: headLine, to: i + 1 });
      if (bracket ? code.includes(')') : !/\\\s*$/.test(code)) head = null;
      continue;
    }
    const b = lastMatch(PY_BRACKET_FROM, code);
    if (b && !code.slice(b.index + b[0].length).includes(')')) {
      head = b[1];
      bracket = true;
      headLine = i + 1;
    } else if (/\\\s*$/.test(code)) {
      const h = lastMatch(PY_HEAD, code);
      if (h) {
        head = h[1];
        bracket = false;
        headLine = i + 1;
      }
    }
  }
  return segs;
}

// Every import in an array of source lines, with the line range it spans. Three readings, unioned: the lines joined (an import
// split over lines is one import), each line alone (nothing earlier can swallow it), and for Python the logical statements.
function scanImports(lines, file) {
  // Every line is read RAW, comments and all: an import inside a comment is a false positive we accept (a comment prefix such as
  // `-- i; require(..)` or `// */ require(..)` is not always a comment).
  const one = lines.map((l, i) => ({ text: l, from: i + 1, to: i + 1 }));
  const found = new Map();
  const take = (list) => {
    for (const m of list) found.set(`${m.from}\0${m.to}\0${m.py}\0${m.spec}`, m);
  };
  take(scanSegments(one, file));
  for (const g of one) if (g.text !== '') take(scanSegments([g], file));
  if (PY_FILE.test(file)) {
    take(scanSegments(pythonStatements(lines), file));
    for (const g of pythonImportFallback(lines)) take(scanSegments([g], file));
  }
  return [...found.values()];
}

// The JS extensions a TypeScript-ESM import writes for a file that is really the TS one (`./x.js` -> x.ts).
const TS_SWAP = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };

// The repo paths a specifier written in `fromFile` may name, each with how sure we are of the path:
//   'exact'  the resolved path (relative specifiers; bare JS names)
//   'loose'  a path from the repo root, with or without a source root or alias in front of it (matches a file by its tail)
//   'fwd'    a wild guess (the specifier's tail, a single trailing segment): only ever used to flag an IMPORT, never to match a file
// Relative -> resolved against the importing file's directory. Non-relative -> as written, with `@/` `~/` `#/` `@@/` stripped,
// and every path-segment suffix (`@acme/x/tests/h` also tries `x/tests/h` and `tests/h`). Python dotted -> slash path. Each path also
// with every source extension, `/index.<ext>` / `/__init__.py`, and (TypeScript ESM) the `.ts` file a written `.js` stands for.
// Over-matching is the safe direction.
export function importCandidates(spec, fromFile, { python = false } = {}) {
  const out = [];
  const seen = new Set();
  const push = (p, mode) => {
    const clean = p.replace(/^(?:\.{1,2}\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
    if (clean === '' || clean === '.' || clean === '..') return;
    const lower = clean.toLowerCase();
    const swapped = Object.entries(TS_SWAP).flatMap(([from, tos]) => (lower.endsWith(from) ? tos.map((to) => clean.slice(0, -from.length) + to) : []));
    for (const b of [clean, ...swapped]) {
      for (const v of [b, ...IMPORT_EXTS.flatMap((e) => [`${b}${e}`, `${b}/index${e}`]), `${b}/__init__.py`]) {
        const key = `${mode}\0${v}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ path: v, mode });
        }
      }
    }
  };
  // `whole`: the mode of the path as written; its multi-segment suffixes take `multi`, a single trailing segment is always 'fwd'.
  const withSuffixes = (p, whole, multi) => {
    const segs = p.split('/').filter(Boolean).slice(-MAX_SEGMENTS);
    push(segs.join('/'), whole);
    for (let i = 1; i < segs.length; i++) push(segs.slice(i).join('/'), i < segs.length - 1 ? multi : 'fwd');
  };

  let s = String(spec).trim();
  if (s === '' || s.length > MAX_SPECIFIER) return out;
  s = s.slice(s.lastIndexOf('!') + 1).replace(/\?.*$/, '').replaceAll('\\', '/'); // webpack loaders, query strings
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const dots = python ? /^\.*/.exec(s)[0].length : 0;
  const rel = python ? dots > 0 : /^\.{1,2}(?:\/|$)/.test(s);
  if (rel) {
    const rest = python ? s.slice(dots).replaceAll('.', '/') : s;
    const up = python ? '../'.repeat(dots - 1) : '';
    push(posix.normalize(posix.join(dir === '' ? '.' : dir, up, rest)), 'exact');
    withSuffixes(rest.replace(/^(?:\.{1,2}\/)+/, ''), 'fwd', 'fwd'); // `./spec/x` written in lib/ may still be meant from the root
    return out;
  }
  const root = (python ? s.replaceAll('.', '/') : s).replace(/^\/+/, '');
  const forms = new Set([root]);
  if (!python && ALIAS_PREFIX.test(root)) forms.add(root.replace(ALIAS_PREFIX, ''));
  for (const form of forms) withSuffixes(form, !python && !form.includes('/') ? 'exact' : 'loose', 'loose');
  return out;
}

// Does any of `specs` reach a test file (or a legacy test dir)? -> the first such specifier, or null.
function reachesTestModule(specs, file, testGlobs) {
  for (const { spec, py } of specs) {
    for (const c of importCandidates(spec, file, { python: py })) {
      if (isTestFile(c.path, testGlobs) || LEGACY_TEST_DIR.test(c.path)) return spec;
    }
  }
  return null;
}

// More than this many distinct specifiers on the added lines of one file is not a real import list: flagged outright.
const MAX_SPECIFIERS_PER_FILE = 500;
// The added lines of production code `d` that import a test module. Specifiers are read over the WHOLE new file when its text
// is known (`headText`), so an import split across lines is caught whichever of its lines the diff touched; without it, over
// the added lines only (lines nobody added read as blank). A specifier counts when any line it spans was added.
function addedImportLines(d, added, headText, testGlobs) {
  if (added.length === 0) return [];
  const file = d.newPath ?? d.file;
  const addedAt = new Map(added.map((l) => [l.line, l]));
  let lines;
  if (typeof headText === 'string') lines = headText.split('\n');
  else {
    lines = Array.from({ length: added.reduce((m, l) => Math.max(m, l.line), 0) }, () => '');
    for (const l of added) lines[l.line - 1] = l.text;
  }
  const touched = new Map(); // spec -> first added line it spans
  for (const m of scanImports(lines, file)) {
    let first = null;
    for (let n = m.from; n <= m.to && first === null; n++) if (addedAt.has(n)) first = n;
    const key = `${m.py}\0${m.spec}`;
    if (first !== null && !touched.has(key)) touched.set(key, { spec: m.spec, py: m.py, line: first });
  }
  if (touched.size > MAX_SPECIFIERS_PER_FILE) return [addedAt.get([...touched.values()][0].line)];
  const out = [];
  for (const t of touched.values()) if (reachesTestModule([t], file, testGlobs) !== null) out.push(addedAt.get(t.line));
  return out;
}

const SECRETS_REF = /\bsecrets\s*[.[]/i;
// Beyond the spec's env/build: install/ignore commands run code at deploy; crons, rewrites, redirects, headers and
// functions change what the deployment exposes or runs.
const VERCEL_KEY = /"(?:env|build\w*|installCommand|ignoreCommand|devCommand|crons|rewrites|redirects|headers|functions)"/i;

// R3: env var reads. Wider than the spec: lower/mixed-case names, getenv, Bun.env, backtick keys, destructuring.
const Q = '[\'"`]';
const NAME = '([A-Za-z_][A-Za-z0-9_]*)';
const ENV_ACCESS = [
  new RegExp(String.raw`process\.env\.${NAME}`, 'g'),
  new RegExp(String.raw`process\.env\[\s*${Q}${NAME}${Q}\s*\]`, 'g'),
  new RegExp(String.raw`import\.meta\.env\.${NAME}`, 'g'),
  new RegExp(String.raw`import\.meta\.env\[\s*${Q}${NAME}${Q}\s*\]`, 'g'),
  new RegExp(String.raw`Deno\.env\.get\(\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(String.raw`Bun\.env\.${NAME}`, 'g'),
  new RegExp(String.raw`os\.environ(?:\.get|\.setdefault|\.pop)?\(?\[?\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(String.raw`\bgetenv\(\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(String.raw`\benv\(\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(String.raw`\bENV\[\s*${Q}${NAME}${Q}\s*\]`, 'g'),
];
// A validated env object (t3-env, SvelteKit's $env/*, a local `env` module): `env.NAME` reads count only in files that
// import one, otherwise `env.FOO` is just a property. `$env/*` named imports are names in any file.
const ENV_IMPORT = /import\s+(?:type\s+)?\{[^}]*\benv\b[^}]*\}\s*from|\$env\/(?:static|dynamic)\/|@t3-oss\/env|\bcreateEnv\s*\(|\bimport\s+env\s+from|\bconst\s*\{[^}]*\benv\b[^}]*\}\s*=\s*require/;
const ENV_OBJ_ACCESS = [
  new RegExp(String.raw`(?<![\w.$])env\.([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])`, 'g'),
  new RegExp(String.raw`(?<![\w.$])env\[\s*${Q}([A-Z][A-Z0-9_]*)${Q}\s*\]`, 'g'),
];
const ENV_STATIC_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]\$env\/(?:static|dynamic)\/\w+['"]/g;
const ENV_OBJECT = String.raw`(?:process\.env|import\.meta\.env|Bun\.env)\b`;
const ENV_DESTRUCTURE = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${ENV_OBJECT}`, 'g');
const ENV_DESTRUCTURE_TAIL = new RegExp(String.raw`^\s*\}\s*=\s*${ENV_OBJECT}`);
// Whatever of these is left after every recognised literal access is dynamic use: `process.env[x]`, `{...process.env}`,
// `process.env?.X`, `const e = process.env`, a read split over two lines.
const ENV_ROOT = /process\.env|import\.meta\.env|Bun\.env|Deno\.env\.toObject|os\.environ/;
// A destructure whose names are on earlier lines of the diff: they cannot be checked against the base, so it always flags.
const UNKNOWN_ENV = '(multi-line env destructuring)';
// In files that already deal with env (a zod/createEnv schema, a destructure), a new `NAME:` / `NAME,` line is a new var.
const ENV_SHAPE = /^\s*([A-Z][A-Z0-9_]{3,})\s*[:,]/;
const ENV_MENTION = /process\.env|import\.meta\.env|z\.object|createEnv|Bun\.env|os\.environ|\$env\//;

// What one source line reads from the environment: literal names (plus UNKNOWN_ENV for a multi-line destructure) and
// whether anything dynamic is left.
// `envObject`: the file imports an env object, so `env.NAME` / `env['NAME']` are reads too.
export function scanEnvLine(text, { envObject = false } = {}) {
  const names = new Set();
  let rest = text;
  rest = rest.replace(ENV_STATIC_IMPORT, (_m, inner) => {
    for (const item of inner.split(',')) {
      const id = /^\s*([A-Z][A-Z0-9_]*)\s*(?:as\b|$)/.exec(item);
      if (id) names.add(id[1]);
    }
    return ' ';
  });
  for (const r of ENV_ACCESS) {
    rest = rest.replace(r, (_m, name) => {
      names.add(name);
      return ' ';
    });
  }
  if (envObject) {
    for (const r of ENV_OBJ_ACCESS) {
      rest = rest.replace(r, (_m, name) => {
        names.add(name);
        return ' ';
      });
    }
  }
  rest = rest.replace(ENV_DESTRUCTURE, (_m, inner) => {
    for (const item of inner.split(',')) {
      const id = /^\s*([A-Za-z_]\w*)/.exec(item);
      if (id) names.add(id[1]);
    }
    return ' ';
  });
  if (ENV_DESTRUCTURE_TAIL.test(rest) && !rest.includes('{')) {
    names.add(UNKNOWN_ENV);
    rest = rest.replace(ENV_DESTRUCTURE_TAIL, ' ');
  }
  return { names: [...names], dynamic: ENV_ROOT.test(rest) };
}

// Names of the environment variables read on one line of source.
export const envNamesIn = (text, opts) => scanEnvLine(text, opts).names;

// ---------------------------------------------------------------------------------------------------------------
// Dependencies (R5)
// ---------------------------------------------------------------------------------------------------------------

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// Semver ranges never contain `:` `/` or `@`; git/file/workspace/npm-alias specs always do.
const NON_REGISTRY = /[:/@]/;
const MAX_RANGE = 500;

function parseRange(range) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  return m ? { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) } : null;
}

// The highest major a range admits (Infinity when nothing caps it): `^15` is 15, `>=15` is Infinity, `^15 || ^16` is 16,
// `>=1 <3` is 2. A change that RAISES this widens what an install may pull in, even if no version string moved.
function upperMajor(range) {
  let best = -Infinity;
  for (const alt of range.split('||')) {
    let cap = Infinity;
    let seen = false;
    for (const tok of alt.trim().split(/[\s,]+/).filter(Boolean)) {
      const m = /^(\^|~>|~=|~|>=|<=|==|===|=|>|<)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(tok);
      if (!m || /^[xX*]$/.test(m[2])) continue;
      seen = true;
      const op = m[1] ?? '';
      const major = Number(m[2]);
      if (op === '>' || op === '>=') continue;
      if (op === '<') {
        const exact = Number(m[3] ?? 0) === 0 && Number(m[4] ?? 0) === 0;
        cap = Math.min(cap, exact && major > 0 ? major - 1 : major);
      } else {
        cap = Math.min(cap, major);
      }
    }
    best = Math.max(best, seen ? cap : Infinity);
  }
  return best;
}

// Why `from` -> `to` needs a human, or null. Major up, 0.x minor up (breaking by convention), major DOWN (reintroduces old
// code), or the range WIDENED (`^15` -> `>=15`, `^15 || ^16`, `*`, `latest`). Ranges that cannot be compared (git URLs,
// workspace:, *, latest) are ignored while they stay the same; if the spec CHANGES we cannot prove it safe, so it flags (a
// dependency retargeted at a git URL is a supply-chain change).
function rangeChange(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || from === to) return null;
  const odd = (r) => r.length > MAX_RANGE || NON_REGISTRY.test(r);
  const a = odd(from) ? null : parseRange(from);
  const b = odd(to) ? null : parseRange(to);
  if (!a || !b) return `${from} -> ${to} (range changed; not comparable as semver)`;
  if (b.major > a.major) return `${from} -> ${to} (major upgrade)`;
  if (b.major < a.major) return `${from} -> ${to} (major downgrade)`;
  if (a.major === 0 && b.minor > a.minor) return `${from} -> ${to} (0.x minor upgrade)`;
  if (upperMajor(to) > upperMajor(from)) return `${from} -> ${to} (range widened)`;
  return null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// package.json scripts that gate verification or run code at install/publish time, and config blocks that decide what
// the gates check.
const SCRIPT_NAME = /^(?:pre|post)?(?:test|verify|lint|typecheck|build|prepare|prepack|publish(?:Only)?|install|merge|e2e|coverage|vercel-build|ci|check)(?:[:.-].*)?$/i;
const GATE_BLOCKS = ['husky', 'lint-staged', 'jest', 'nyc', 'vitest', 'c8', 'mocha', 'ava', 'eslintConfig', 'simple-git-hooks'];

function npmRules({ file, base, head }, sink) {
  if (!isObj(base) || !isObj(head)) return;

  // Same dep across sections: a move between sections with a major change is still a major change.
  const baseSpecs = new Map();
  for (const section of DEP_SECTIONS) {
    if (!isObj(base[section])) continue;
    for (const [name, spec] of Object.entries(base[section])) {
      if (!baseSpecs.has(name)) baseSpecs.set(name, { section, spec });
    }
  }
  for (const section of DEP_SECTIONS) {
    if (!isObj(head[section])) continue;
    for (const [name, spec] of Object.entries(head[section])) {
      const prior = isObj(base[section]) && Object.hasOwn(base[section], name) ? { section, spec: base[section][name] } : baseSpecs.get(name);
      if (!prior) continue; // new deps are not hits
      const why = rangeChange(prior.spec, spec);
      const moved = prior.section === section ? '' : ` (moved from ${prior.section} to ${section})`;
      if (why) sink.add('R5-major-dep', file, `${section}: ${name} ${why}${moved}`);
    }
  }

  const engines = rangeChange(base.engines?.node, head.engines?.node);
  if (engines) sink.add('R5-major-dep', file, `engines.node ${engines}`);

  // packageManager: a major bump is R5, any other change still alters how the gates run.
  if (base.packageManager !== head.packageManager) {
    const ver = (s) => (typeof s === 'string' ? s.slice(s.indexOf('@') + 1) : undefined);
    const why = rangeChange(ver(base.packageManager), ver(head.packageManager));
    if (why && /major/.test(why)) sink.add('R5-major-dep', file, `packageManager ${base.packageManager} -> ${head.packageManager}`);
    else sink.add('R4-pipeline', file, `packageManager changed (${base.packageManager} -> ${head.packageManager})`);
  }

  // overrides / resolutions pin or replace transitive dependencies: any change to them is a supply-chain lever.
  for (const [key, a, b] of [
    ['overrides', base.overrides, head.overrides],
    ['resolutions', base.resolutions, head.resolutions],
    ['pnpm.overrides', base.pnpm?.overrides, head.pnpm?.overrides],
  ]) {
    for (const name of new Set([...Object.keys(isObj(a) ? a : {}), ...Object.keys(isObj(b) ? b : {})])) {
      if (!sameJson(a?.[name], b?.[name])) sink.add('R5-major-dep', file, `${key}: ${name} ${JSON.stringify(a?.[name] ?? null)} -> ${JSON.stringify(b?.[name] ?? null)}`);
    }
  }

  for (const name of new Set([...Object.keys(isObj(base.scripts) ? base.scripts : {}), ...Object.keys(isObj(head.scripts) ? head.scripts : {})])) {
    if (SCRIPT_NAME.test(name) && base.scripts?.[name] !== head.scripts?.[name]) sink.add('R4-pipeline', file, `package.json scripts.${name} changed`);
  }
  for (const key of GATE_BLOCKS) {
    if (!sameJson(base[key], head[key])) sink.add('R4-pipeline', file, `package.json "${key}" changed`);
  }
}

// requirements*.txt / pyproject.toml: a flat name -> specifier map (`==1.2`, `>=1,<2`, `^1.2`).
function flatRules({ file, base, head }, sink) {
  if (!isObj(base) || !isObj(head)) return;
  for (const [name, spec] of Object.entries(head)) {
    if (!Object.hasOwn(base, name)) continue;
    const why = rangeChange(base[name], spec);
    if (why) sink.add('R5-major-dep', file, `${name} ${why}`);
  }
}

// Lockfiles: a direct dependency can jump a major with package.json untouched (an existing `^15` range, or a pin the lock
// moves). Only DIRECT dependencies are judged (transitive churn is routine), by comparing the highest locked version.
export const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const NPM_TOP = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/;
const add = (map, name, version) => {
  if (typeof version === 'string' && /^\d/.test(version)) (map[name] ??= []).push(version);
};

// -> { versions: {name: [version]}, direct: [name] | null (the lockfile does not say) } or null when it cannot be read.
export function parseLockfile(file, text) {
  const base = baseName(file).toLowerCase();
  const versions = Object.create(null);
  if (base.endsWith('.json')) {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObj(j)) return null;
    if (isObj(j.packages)) {
      for (const [key, v] of Object.entries(j.packages)) {
        const m = NPM_TOP.exec(key);
        if (m && isObj(v)) add(versions, m[1], v.version);
      }
      const root = j.packages[''];
      const direct = isObj(root) ? DEP_SECTIONS.flatMap((sec) => Object.keys(isObj(root[sec]) ? root[sec] : {})) : null;
      return { versions, direct };
    }
    if (isObj(j.dependencies)) {
      for (const [name, v] of Object.entries(j.dependencies)) if (isObj(v)) add(versions, name, v.version);
      return { versions, direct: null };
    }
    return null;
  }
  const lines = text.split('\n');
  if (base === 'pnpm-lock.yaml') {
    if (!/^lockfileVersion\s*:/m.test(text)) return null;
    for (const line of lines) {
      const m = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^@/\s'"]+)@(\d[^(:'"\s]*)/.exec(line) ?? /^ {2}['"]?\/((?:@[^/\s'"]+\/)?[^/\s'"]+)\/(\d[^_(:'"\s/]*)/.exec(line);
      if (m) add(versions, m[1], m[2]);
    }
    return { versions, direct: null };
  }
  // yarn.lock (classic `version "1.2.3"`, berry `version: 1.2.3`): header lines name every requested range of one entry.
  let names = [];
  let sawEntry = false;
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      names = [];
      if (!line.trimEnd().endsWith(':') || line.startsWith('__metadata')) continue;
      sawEntry = true;
      for (const part of line.trimEnd().slice(0, -1).split(',')) {
        const spec = part.trim().replace(/^["']|["']$/g, '');
        const at = spec.indexOf('@', 1);
        if (at > 0) names.push(spec.slice(0, at));
      }
      continue;
    }
    const v = /^ {2}version:?\s+["']?([^"'\s]+)/.exec(line);
    if (v) for (const n of new Set(names)) add(versions, n, v[1]);
  }
  const content = lines.some((l) => l.trim() !== '' && !l.startsWith('#') && !l.startsWith('__metadata') && !/^\s/.test(l));
  if (!sawEntry && content) return null;
  return { versions, direct: null };
}

const highest = (list) => list.map((v) => ({ v, ...parseRange(v) })).filter((x) => 'major' in x).sort((a, b) => b.major - a.major || b.minor - a.minor)[0];

// Direct dependencies whose highest locked version moved a major (or a 0.x minor, or down a major).
function lockRules({ file, base, head, direct }, sink) {
  for (const name of direct ?? Object.keys(head)) {
    const a = base[name] && highest(base[name]);
    const b = head[name] && highest(head[name]);
    if (!a || !b) continue; // new, removed or unreadable: not a bump
    if (b.major > a.major || b.major < a.major || (a.major === 0 && b.minor > a.minor)) {
      sink.add('R5-major-dep', file, `${name} ${a.v} -> ${b.v} (lockfile major bump)`);
    }
  }
}

const PY_NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const PY_SPEC = String.raw`(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[\w.*+!-]+\s*,?\s*)`;
const normName = (n) => n.toLowerCase().replace(/[_.]+/g, '-');

// Dependency specifiers of a requirements.txt or pyproject.toml, as a flat map. Lenient on purpose: a missed line is a
// missed bump, so anything that looks like `name<op>version` counts.
export function parsePythonDeps(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim();
    let m = new RegExp(`^(${PY_NAME})(?:\\[[^\\]]*\\])?\\s*(${PY_SPEC}+)`).exec(line); // requirements.txt
    if (m) out[normName(m[1])] = m[2].replace(/\s+/g, '');
    for (m of line.matchAll(new RegExp(`["']\\s*(${PY_NAME})(?:\\[[^\\]]*\\])?\\s*(${PY_SPEC}+)\\s*(?:;[^"']*)?["']`, 'g'))) {
      out[normName(m[1])] = m[2].replace(/\s+/g, ''); // pyproject PEP 621: "name>=1.0,<2"
    }
    m = new RegExp(`^(${PY_NAME})\\s*=\\s*["']\\s*([\\^~<>=!]*\\s*\\d[^"']*)["']\\s*$`).exec(line); // poetry: name = "^1.2"
    if (m && !['name', 'version', 'description', 'readme', 'license'].includes(m[1])) out[normName(m[1])] = m[2].replace(/\s+/g, '');
    m = new RegExp(`^(${PY_NAME})\\s*=\\s*\\{[^}]*version\\s*=\\s*["']([^"']+)["']`).exec(line); // poetry inline table
    if (m) out[normName(m[1])] = m[2].replace(/\s+/g, '');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// classifyHardStops
// ---------------------------------------------------------------------------------------------------------------

const excerpt = (text) => {
  const t = text.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

// Collects hits, dropping duplicates: one per (rule, file, line); hits with no line are told apart by their detail.
function makeSink() {
  const seen = new Map();
  return {
    add(rule, file, detail, { line, excerpt: ex } = {}) {
      const key = `${rule}\0${file}\0${line ?? ''}\0${line === undefined ? detail : ''}`;
      if (seen.has(key)) return;
      const hit = { rule, file };
      if (line !== undefined) hit.line = line;
      if (ex !== undefined) hit.excerpt = ex;
      hit.detail = detail;
      seen.set(key, hit);
    },
    list: () => [...seen.values()],
  };
}

// A pattern that does not compile must stop the run (fail closed), not silently match nothing.
function compilePattern(p) {
  try {
    return { ...p, re: new RegExp(p.regex, 'i') };
  } catch (e) {
    throw new Error(`hard_stops.patterns "${p.name}": regex does not compile (${e.message})`);
  }
}

function settings(config) {
  const hs = config?.hard_stops ?? {};
  const authCalls = (hs.auth_calls ?? []).map((name) => [`${name}()`, new RegExp(String.raw`\b${escapeRe(name)}\s*\(`, 'i')]);
  return {
    paths: hs.paths ?? [],
    patterns: (hs.patterns ?? []).map(compilePattern),
    testGlobs: config?.integrity?.test_globs ?? DEFAULTS.integrity.test_globs,
    authRemoved: [...AUTH_REMOVED, ...authCalls],
  };
}

function describe(f, cx) {
  const paths = [...new Set([f.oldPath, f.newPath, f.path].filter(Boolean))];
  const file = f.path ?? f.newPath ?? f.oldPath;
  return {
    file, paths, status: f.status, binary: Boolean(f.binary), gitlink: Boolean(f.gitlink),
    oldPath: f.oldPath ?? null, newPath: f.newPath ?? null,
    added: f.added ?? [], removed: f.removed ?? [],
    sql: paths.some(isSqlPath),
    // Added lines live in the new path, removed lines in the old one.
    symlink: Boolean(f.symlink),
    addedIsCode: isCodeFile(f.newPath ?? file, cx.testGlobs),
    addedIsTest: isTestFile(f.newPath ?? file, cx.testGlobs),
    removedIsCode: isCodeFile(f.oldPath ?? file, cx.testGlobs),
  };
}

const STATUS_WORD = { M: 'edited', D: 'deleted', R: 'renamed' };

function pathRules(d, cx, sink) {
  // R0: a binary diff of anything but a plain asset cannot be read, so nothing below can vouch for it.
  if (d.binary && !d.paths.every((p) => BINARY_ASSET.test(p) || (BINARY_FIXTURE.test(p) && isTestFile(p, cx.testGlobs)))) {
    sink.add('R0-unscannable', d.file, "binary diff; content can't be checked");
  }

  // A submodule (gitlink) entry points the repo at code this diff does not contain.
  if (d.gitlink) sink.add('R4-pipeline', d.file, 'submodule (gitlink) entry added, changed or removed');
  // A symlink's diff is only its target path; the file it serves can live in an exempt location (tests/, docs/).
  if (d.symlink) sink.add('R4-pipeline', d.file, 'symlink (mode 120000) added, changed or removed: the file it points to is not judged');
  // Moving a file out of an exempt path into production: its lines were never judged and a 100% rename shows none.
  if (d.status === 'R' && d.oldPath && d.newPath && !isCodeFile(d.oldPath, cx.testGlobs) && isCodeFile(d.newPath, cx.testGlobs)) {
    sink.add('R0-unscannable', d.file, `moved from a test/docs path (${d.oldPath}) into production code; its content was never judged`);
  }

  // R1: existing migrations are immutable; deleting one (or moving it out of the migrations dir) is destructive.
  const inMigrations = d.paths.some(isMigrationPath);
  if (inMigrations && STATUS_WORD[d.status]) sink.add('R1-migration-edited', d.file, `existing migration ${STATUS_WORD[d.status]}`);
  if (inMigrations && d.status === 'D') sink.add('R1-destructive', d.file, 'migration file deleted');
  if (d.status === 'R' && d.oldPath && isMigrationPath(d.oldPath) && !(d.newPath && isMigrationPath(d.newPath))) {
    sink.add('R1-destructive', d.file, 'migration moved out of the migrations dir');
  }

  const code = d.paths.filter((p) => isCodeFile(p, cx.testGlobs));
  const r2 = code.find((p) => inc(p, R2_PATH_GLOBS) || isAuthLogicPath(p));
  if (r2) sink.add('R2-auth', d.file, `auth/roles/permissions path: ${r2}`);
  if (d.status === 'A' && code.some((p) => inc(p, SERVER_ENTRY_GLOBS))) sink.add('R2-auth', d.file, 'new server entry point (check it authenticates)');
  const r6 = code.find(isSensitivePath);
  if (r6) sink.add('R6-sensitive', d.file, `sensitive-data path: ${r6}`);

  const r3 = d.paths.find((p) => inc(p, R3_PATH_GLOBS));
  if (r3) sink.add('R3-secrets', d.file, `secret/credential file: ${r3}`);
  const r4 = d.paths.find((p) => inc(p, R4_PATH_GLOBS));
  if (r4) sink.add('R4-pipeline', d.file, `pipeline/verify file: ${r4}`);
  if ((d.status === 'D' || d.status === 'R') && d.paths.some((p) => inc(p, TEST_DIR_GLOBS))) {
    sink.add('R4-pipeline', d.file, `pgTAP test ${STATUS_WORD[d.status]}`);
  }

  const pp = d.paths.find((p) => inc(p, cx.paths));
  if (pp) sink.add('P-path', d.file, `project hard-stop path: ${pp}`);
}

// Everything the env rules say about one added line, shared with the IO wrapper so both agree on what a "candidate" is.
function envFinding(l, envish, envObject) {
  const { names, dynamic } = scanEnvLine(l.text, { envObject });
  const shape = envish ? ENV_SHAPE.exec(l.text)?.[1] : undefined;
  return { names, dynamic, possible: shape && !names.includes(shape) ? shape : undefined };
}

function addedCodeRules(d, added, cx, env, sink) {
  const live = (l) => !COMMENT_LINE.test(l.text);
  const isWorkflow = d.paths.some((p) => inc(p, WORKFLOW_GLOBS));
  const isVercel = d.paths.some((p) => baseName(p).toLowerCase() === 'vercel.json');
  const envish = env.envFiles ? env.envFiles.has(d.file) : [...added, ...d.removed].some((l) => ENV_MENTION.test(l.text));
  const envObject = env.importFiles ? env.importFiles.has(d.file) : ENV_IMPORT.test([...added, ...d.removed].map((l) => l.text).join('\n'));

  if (d.sql) {
    for (const l of maskLines(added)) {
      const ex = { line: l.line, excerpt: excerpt(l.text) };
      const r1 = firstSql(R1_SQL, l.masked, false);
      if (r1) sink.add('R1-destructive', d.file, `destructive SQL: ${r1}`, ex);
      const r2 = firstSql(R2_SQL, l.masked, false);
      if (r2) sink.add('R2-auth', d.file, `auth/RLS SQL: ${r2}`, ex);
      if (PSQL_META.test(l.masked)) sink.add('R1-destructive', d.file, 'psql meta-command (runs other files/programs)', ex);
    }
  }

  for (const l of addedImportLines(d, added, cx.headFiles?.get(d.file), cx.testGlobs)) {
    sink.add('R0-unscannable', d.file, 'imports a test/fixture module into production code; test files are not judged', { line: l.line, excerpt: excerpt(l.text) });
  }

  for (const l of added) {
    const ex = { line: l.line, excerpt: excerpt(l.text) };

    if (!d.sql && live(l)) {
      const r1 = firstSql(R1_SQL, l.text, true);
      if (r1) sink.add('R1-destructive', d.file, `destructive SQL in code: ${r1}`, ex);
      const r2 = firstSql(R2_SQL, l.text, true);
      if (r2) sink.add('R2-auth', d.file, `auth/RLS SQL in code: ${r2}`, ex);
    }
    if (live(l) && l.text.includes('.from(') && DATA_WRITE.test(l.text)) sink.add('R1-destructive', d.file, 'data write in code (.from(...).delete/upsert)', ex);

    if (SERVICE_ROLE.test(l.text)) sink.add('R2-auth', d.file, 'service-role / admin-client reference', ex);
    if (AUTH_ADMIN.test(l.text)) sink.add('R2-auth', d.file, 'auth.admin API call', ex);
    if (live(l) && ROLE_LITERAL.test(l.text)) sink.add('R2-auth', d.file, 'role literal admin/owner', ex);
    if (COOKIE_INSECURE.test(l.text)) sink.add('R2-auth', d.file, 'httpOnly/secure turned off', ex);
    if (USE_SERVER.test(l.text)) sink.add('R2-auth', d.file, "'use server' added: new server entry point (check it authenticates)", ex);

    const secret = SECRET_LITERALS.find(([, r]) => r.test(l.text));
    if (secret) sink.add('R3-secrets', d.file, `secret-like literal (${secret[0]})`, { line: l.line }); // no excerpt: it IS the secret
    if (isWorkflow && SECRETS_REF.test(l.text)) sink.add('R3-secrets', d.file, 'workflow reads secrets.*', ex);
    if (isVercel && VERCEL_KEY.test(l.text)) sink.add('R3-secrets', d.file, 'vercel.json env/build/deploy setting changed', ex);

    const found = envFinding(l, envish, envObject);
    const parts = [];
    const fresh = found.names.filter((n) => !env.known.has(n));
    if (fresh.length > 0) parts.push(`new env var ${fresh.join(', ')}`);
    if (found.dynamic) parts.push('dynamic env access (names cannot be checked)');
    if (found.possible && !env.known.has(found.possible)) parts.push(`possible new env var ${found.possible}`);
    if (parts.length > 0) sink.add('R3-secrets', d.file, parts.join('; '), ex);

    if (live(l) && isSensitiveText(l.text)) sink.add('R6-sensitive', d.file, 'sensitive-data term in added code', ex);
  }
}

// The one content rule test files keep: a key-shaped literal that does not itself announce being fake.
function testSecretRules(d, added, sink) {
  for (const l of added) {
    const secret = realLookingSecret(l.text);
    if (secret) sink.add('R3-secrets', d.file, `secret-like literal in a test file (${secret})`, { line: l.line });
  }
}

function removedCodeRules(d, removed, cx, sink) {
  const isVercel = d.paths.some((p) => baseName(p).toLowerCase() === 'vercel.json');
  if (d.sql) {
    for (const l of maskLines(removed)) {
      const r2 = firstSql(R2_SQL, l.masked, false);
      // `line` here is the OLD-file line number (the line no longer exists in the new file).
      if (r2) sink.add('R2-sql-removed', d.file, `removed auth/RLS SQL: ${r2}`, { line: l.line, excerpt: excerpt(l.text) });
    }
  }
  for (const l of removed) {
    if (isVercel && VERCEL_KEY.test(l.text)) sink.add('R3-secrets', d.file, 'vercel.json env/build/deploy setting changed', { line: l.line, excerpt: excerpt(l.text) });
    if (COMMENT_LINE.test(l.text) || STRING_ONLY_LINE.test(l.text)) continue;
    const rule = firstRule(cx.authRemoved, l.text);
    if (rule) sink.add('R2-auth-removed', d.file, `removed auth guard: ${rule}`, { line: l.line, excerpt: excerpt(l.text) });
  }
}

function patternRules(d, added, removed, cx, sink) {
  for (const pat of cx.patterns) {
    // `paths` names the files to scan; without it, every code file. An empty list means "unspecified", not "nothing".
    const scoped = pat.paths?.length > 0;
    const inScope = scoped && d.paths.some((p) => inc(p, pat.paths));
    const lines = [...((scoped ? inScope : d.addedIsCode) ? added : []), ...((scoped ? inScope : d.removedIsCode) ? removed : [])];
    for (const l of lines) {
      if (pat.re.test(l.text)) sink.add('P-pattern', d.file, `matches project pattern "${pat.name}"`, { line: l.line, excerpt: excerpt(l.text) });
    }
  }
}

function lineRules(d, cx, env, sink) {
  // ReDoS guard: no regex ever sees a huge line. The file is flagged instead, so it cannot hide behind one.
  if ([...d.added, ...d.removed].some((l) => l.text.length > MAX_LINE)) {
    sink.add('R0-unscannable', d.file, `a changed line is longer than ${MAX_LINE} characters; content rules skipped`);
  }
  // A NUL inside a line means UTF-16 (or binary) data: its characters are interleaved with NULs, so no keyword regex can match.
  if ([...d.added, ...d.removed].some((l) => l.text.includes('\0'))) {
    sink.add('R0-unscannable', d.file, "a changed line contains a NUL byte (UTF-16 or binary data); content can't be checked");
  }
  const fit = (l) => l.text.length <= MAX_LINE;
  const added = d.added.filter(fit);
  const removed = d.removed.filter(fit);
  // Content rules judge production code only: not tests, not docs/markdown.
  if (d.addedIsCode) addedCodeRules(d, added, cx, env, sink);
  else if (d.addedIsTest) testSecretRules(d, added, sink);
  if (d.removedIsCode) removedCodeRules(d, removed, cx, sink);
  patternRules(d, added, removed, cx, sink);
}

const needs = (cond, msg) => {
  if (!cond) throw new TypeError(`classifyHardStops: ${msg}; run it through collectHardStops (the only entry point with full coverage)`);
};

// files: parseUnifiedDiff output. config: pipeline config. Inputs a diff cannot show (the wrapper always supplies them):
//   baseEnvNames  env var names already read on the base (Set or array)
//   basePkg/headPkg  parsed root package.json, or pkgPairs: [{file, base, head}] (npm), [{file, kind:'flat', base, head}]
//                    (name -> specifier map: requirements.txt / pyproject.toml), [{file, error}] (unparseable)
//   sqlStatements [{file, text}]: whole statements around changed lines of .sql files, from base and head
//   envFiles      Set of changed files that mention process.env / z.object / createEnv (default: judged from the diff lines)
//   envImportFiles  Set of changed files that import an env object, so `env.NAME` is a read (default: judged from the diff lines)
//   headFiles     Map file -> whole new content of changed code files (optional): lets the import check read an import split over lines
//   guardLosses   [{file, kind:'code'|'sql', detail}] guards that vanished from the whole file without a removed line (commented out)
// Throws TypeError when the diff touches SQL or package.json and sqlStatements / pkgPairs (or basePkg+headPkg) are missing.
// Returns hits `{ rule, file, line?, excerpt?, detail }`.
export function classifyHardStops({ files, config, baseEnvNames = new Set(), basePkg, headPkg, pkgPairs, sqlStatements, envFiles, envImportFiles, guardLosses = [], headFiles }) {
  const cx = { ...settings(config), headFiles: new Map(headFiles instanceof Map ? headFiles : Object.entries(headFiles ?? {})) };
  const sink = makeSink();
  const known = new Set(baseEnvNames);
  const env = { known, envFiles: envFiles === undefined ? null : new Set(envFiles), importFiles: envImportFiles === undefined ? null : new Set(envImportFiles) };

  const pairs = [...(pkgPairs ?? [])];
  if (basePkg !== undefined || headPkg !== undefined) pairs.push({ file: 'package.json', base: basePkg ?? null, head: headPkg ?? null });

  for (const f of files) {
    const d = describe(f, cx);
    if (baseName(d.file).toLowerCase() === 'package.json') {
      needs(pairs.some((p) => p.file === d.file), `the diff touches ${d.file} but no pkgPairs entry (or basePkg/headPkg) was given`);
    }
    if (LOCKFILE.test(baseName(d.file))) {
      needs(pairs.some((p) => p.file === d.file), `the diff touches ${d.file} but no pkgPairs entry was given`);
    }
    if (d.sql && !d.binary && d.added.length + d.removed.length > 0) {
      needs(Array.isArray(sqlStatements), `the diff changes SQL (${d.file}) but sqlStatements was not given`);
    }
    pathRules(d, cx, sink);
    lineRules(d, cx, env, sink);
  }

  for (const pair of pairs) {
    if (pair.kind === 'lock') {
      if (pair.error) sink.add('R0-unscannable', pair.file, `${baseName(pair.file)} could not be parsed (${pair.error}); dependency changes unchecked`);
      else lockRules(pair, sink);
    } else if (pair.error) sink.add('R5-major-dep', pair.file, `${baseName(pair.file)} could not be parsed (${pair.error}); dependency changes unchecked`);
    else if (pair.kind === 'flat') flatRules(pair, sink);
    else npmRules(pair, sink);
  }

  for (const s of sqlStatements ?? []) {
    if (!isCodeFile(s.file, cx.testGlobs)) continue; // pgTAP tests and docs are not production SQL
    const text = s.text ?? '';
    if (text.length > MAX_LINE) {
      sink.add('R0-unscannable', s.file, `a SQL statement is longer than ${MAX_LINE} characters; content rules skipped`);
      continue;
    }
    const r2 = firstSql(R2_SQL, text, false);
    if (r2) sink.add('R2-sql-statement', s.file, `statement with ${r2}: ${oneLine(text).slice(0, 120)}`);
    const r1 = firstSql(R1_SQL, text, false);
    if (r1) sink.add('R1-destructive', s.file, `destructive statement (${r1}): ${oneLine(text).slice(0, 120)}`);
  }

  for (const g of guardLosses) sink.add(g.kind === 'sql' ? 'R2-sql-removed' : 'R2-auth-removed', g.file, g.detail);

  return sink.list();
}

// ---------------------------------------------------------------------------------------------------------------
// Guards switched off without a removed line (IO-free helpers; collectHardStops feeds them whole files)
// ---------------------------------------------------------------------------------------------------------------

// A diff that only ADDS `/*` and `*/` lines around a guard removes no line, so the removed-line rules never see it. So
// when a changed file adds comment delimiters, the whole base and head files are comment-stripped and compared.
// Comment forms: /* */, <!-- -->, python triple quotes, ruby =begin/=end, lua --[[ ]], and // to end of line. The stripper
// is deliberately not string-aware: a delimiter inside a string can only make code look commented out on BOTH sides
// (equal counts) or on one side (a flagged difference), never hide a loss.
const COMMENT_DELIM = /\/\*|\*\/|<!--|-->|"""|'''|^=begin|^=end|--\[\[|\]\]/m;
const END = String.raw`(?![\s\S])`;
const CODE_COMMENT = new RegExp(
  [
    String.raw`\/\*[\s\S]*?(?:\*\/|${END})`, String.raw`<!--[\s\S]*?(?:-->|${END})`, `"""[\\s\\S]*?(?:"""|${END})`, `'''[\\s\\S]*?(?:'''|${END})`,
    String.raw`^=begin[\s\S]*?(?:^=end|${END})`, String.raw`--\[\[[\s\S]*?(?:\]\]|${END})`, String.raw`\/\/[^\n]*`,
  ].join('|'),
  'gm',
);
export const addsCommentDelimiter = (lines) => lines.some((l) => l.text.length <= MAX_LINE && COMMENT_DELIM.test(l.text));
export const stripCodeComments = (text) => text.replace(CODE_COMMENT, (m) => m.replace(/[^\n]/g, ' '));

// Per auth-guard rule: how many lines of the (comment-stripped) text carry it.
function guardCounts(text, rules) {
  const counts = new Map();
  for (const line of stripCodeComments(text).split('\n')) {
    if (STRING_ONLY_LINE.test(line)) continue;
    const rule = firstRule(rules, line);
    if (rule) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return counts;
}

// Guard rules that match fewer live lines in the head file than in the base file.
export function lostCodeGuards(baseText, headText, rules) {
  const before = guardCounts(baseText, rules);
  const after = guardCounts(headText, rules);
  return [...before].filter(([rule, n]) => n > (after.get(rule) ?? 0)).map(([rule]) => rule);
}

const SQL_GUARD_LABELS = new Set(['POLICY', 'ROW LEVEL SECURITY', 'GRANT', 'REVOKE']);
const SQL_GUARD_RULES = R2_SQL.filter(([label]) => SQL_GUARD_LABELS.has(label));

// RLS / policy / grant statements of a SQL file, comment-stripped and whitespace-normalised: normalised text -> label.
export function sqlGuardStatements(text) {
  const lines = text.split('\n').map((_, i) => i + 1);
  const out = new Map();
  for (const stmt of enclosingStatements(text, lines)) {
    const label = firstSql(SQL_GUARD_RULES, stmt, false);
    if (label) out.set(oneLine(stmt).toLowerCase(), { label, text: oneLine(stmt) });
  }
  return out;
}

// RLS / policy / grant statements present in the base file but not live in the head file.
export function lostSqlGuards(baseText, headText) {
  const head = sqlGuardStatements(headText);
  return [...sqlGuardStatements(baseText)].filter(([key]) => !head.has(key)).map(([, v]) => v);
}

// ---------------------------------------------------------------------------------------------------------------
// collectHardStops (IO)
// ---------------------------------------------------------------------------------------------------------------

// Patterns (ERE, one per line) that find a READ of env var `name` on the base. A bare mention (docs, comments, a name
// that merely contains it) is not enough: the code must actually access it. `git grep -o` prints only the matched text,
// and that text goes back through scanEnvLine, so each pattern must match the WHOLE access form scanEnvLine recognises.
function accessPatterns(name) {
  const q = '[\'"`]';
  const end = '([^A-Za-z0-9_]|$)';
  return [
    String.raw`process\.env\.${name}${end}`,
    String.raw`process\.env\[[[:space:]]*${q}${name}${q}[[:space:]]*\]`,
    String.raw`import\.meta\.env\.${name}${end}`,
    String.raw`import\.meta\.env\[[[:space:]]*${q}${name}${q}[[:space:]]*\]`,
    String.raw`Deno\.env\.get\([[:space:]]*${q}${name}${q}`,
    String.raw`Bun\.env\.${name}${end}`,
    String.raw`os\.environ(\.get|\.setdefault|\.pop)?\(?\[?[[:space:]]*${q}${name}${q}`,
    String.raw`getenv\([[:space:]]*${q}${name}${q}`,
    String.raw`env\([[:space:]]*${q}${name}${q}`,
    String.raw`ENV\[[[:space:]]*${q}${name}${q}[[:space:]]*\]`,
    String.raw`\{([^}]*[^A-Za-z0-9_}])?${name}([^A-Za-z0-9_}][^}]*)?\}[[:space:]]*=[[:space:]]*(process\.env|import\.meta\.env|Bun\.env)`,
    // An imported env object (`env.NAME`) and SvelteKit's `$env/*` named imports; the leading char keeps `a.env.NAME` out.
    String.raw`(^|[^A-Za-z0-9_.$])env\.${name}${end}`,
    String.raw`(^|[^A-Za-z0-9_.$])env\[[[:space:]]*${q}${name}${q}[[:space:]]*\]`,
    String.raw`import[[:space:]]*(type[[:space:]]+)?\{([^}]*[^A-Za-z0-9_}])?${name}([^A-Za-z0-9_}][^}]*)?\}[[:space:]]*from[[:space:]]*${q}\$env/`,
  ];
}

// Which of `names` does the base tree already READ? ONE `git grep` per batch of names, patterns on stdin, outside
// markdown and docs/. The matched text goes back through the same extractor the classifier uses.
function knownEnvNames(ref, names, o) {
  const known = new Set();
  const list = [...names].filter((n) => n !== UNKNOWN_ENV);
  for (let i = 0; i < list.length; i += 50) {
    const input = list.slice(i, i + 50).flatMap(accessPatterns).join('\n');
    let out;
    try {
      out = git(['grep', '-E', '-o', '-h', '-I', '--no-color', '-f', '-', ref, '--', '.', ':!*.md', ':!docs/**'], { ...o, input });
    } catch (e) {
      if (e instanceof GitError && e.code === 1) continue; // git grep: no match
      throw e;
    }
    for (const line of out.split('\n')) for (const name of envNamesIn(line, { envObject: true })) known.add(name);
  }
  return known;
}

function parseJson(text) {
  if (text === null) return { value: null };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: true };
  }
}

// Reverse check. A test file is exempt from content rules, so when production code ALREADY imports one (directly, or through
// other test files: prod -> tests/a.ts -> tests/b.ts), editing that file changes what production runs and nothing judges the
// new content. For the changed (added, modified, renamed-into) test files: one grep of the head tree for files mentioning
// their basenames (just the names, so an import split over lines is still found), the importers read whole at head and run
// through the import resolver; an importer that is a test file joins the chain and the next round looks for ITS importers.
// Fails closed (every changed test file concerned is flagged) when a git call fails, a round finds more than `maxFiles` files,
// the chain grows past MAX_CHAIN_FILES or MAX_CHAIN_ROUNDS, or a name cannot be searched for.
// Every file the import parser reads (JS_FAMILY / PY_FILE / RB_FILE; a plain pathspec's `*` also matches `/`, so `*Gemfile` is
// any directory's Gemfile). Keep in step with those three tests: a language missing here is a blind spot for the reverse check.
const CODE_PATHSPECS = ['*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.mts', '*.cts', '*.vue', '*.svelte', '*.astro', '*.mdx',
  '*.py', '*.pyi', '*.rb', '*.rake', '*.gemspec', '*.ru', '*Rakefile', '*Gemfile'];
const MAX_CHAIN_ROUNDS = 5;
const MAX_CHAIN_FILES = 300;
const READ_BATCH = 200;
const MAX_HEAD_TEXT = 2_000_000;
// Whole-file import reading applies to exactly the files the parser reads (the same three tests importSpecifiers uses).
const IMPORT_SOURCE = { test: (p) => JS_FAMILY.test(p) || PY_FILE.test(p) || RB_FILE.test(p) };
const stem = (p) => {
  const b = baseName(p);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
};

// Files of the tree at `ref` (limited to code) that contain any of `names`.
function filesMentioning(ref, names, o) {
  let out;
  try {
    out = git(['grep', '-I', '-F', '-l', '-z', '--no-color', ...names.flatMap((n) => ['-e', n]), ref, '--', ...CODE_PATHSPECS], o);
  } catch (e) {
    if (e instanceof GitError && e.code === 1 && (e.stderr ?? '').trim() === '') return []; // git grep: no match
    throw e;
  }
  return out.split('\0').filter(Boolean).map((r) => r.slice(r.indexOf(':') + 1));
}

// Whole content (as arrays of lines) of `files` at `ref`: every line matches \`^\`, so one grep prints them all.
function readLines(ref, files, o) {
  const texts = new Map();
  for (let i = 0; i < files.length; i += READ_BATCH) {
    let out;
    try {
      out = git(['grep', '-I', '-n', '-z', '--no-color', '-e', '^', ref, '--', ...files.slice(i, i + READ_BATCH).map((p) => `:(literal)${p}`)], o);
    } catch (e) {
      if (e instanceof GitError && e.code === 1 && (e.stderr ?? '').trim() === '') continue;
      throw e;
    }
    for (const rec of out.split('\n')) {
      if (rec === '') continue;
      const a = rec.indexOf('\0');
      const b = a === -1 ? -1 : rec.indexOf('\0', a + 1);
      if (b === -1) throw new Error('unreadable search output');
      const file = rec.slice(rec.indexOf(':') + 1, a);
      const lines = texts.get(file) ?? [];
      lines[Number(rec.slice(a + 1, b)) - 1] = rec.slice(b + 1);
      texts.set(file, lines);
    }
  }
  for (const [file, lines] of texts) {
    let size = 0;
    for (let i = 0; i < lines.length; i++) size += (lines[i] ??= '').length + 1;
    if (size > MAX_HEAD_TEXT) throw new Error(`${file} is larger than ${MAX_HEAD_TEXT} characters`);
  }
  return texts;
}

function reverseImportHits(ds, head, o, cx, maxFiles) {
  const changed = [...new Set(ds.filter((d) => d.status !== 'D' && d.newPath && d.addedIsTest).map((d) => d.newPath))];
  if (changed.length === 0) return [];
  const unchecked = (why, files = changed) => files.map((file) => ({ rule: 'R0-unscannable', file, detail: `test file changed; production code importing it could not be checked (${why})` }));
  const rootsOf = new Map(changed.map((p) => [p, new Set([p])])); // test file in the chain -> changed files it leads to
  const found = new Map(); // changed file -> where production reaches it
  let frontier = [...changed];
  for (let round = 0; frontier.length > 0; round++) {
    const concerned = [...new Set(frontier.flatMap((p) => [...rootsOf.get(p)]))];
    if (round >= MAX_CHAIN_ROUNDS) return unchecked(`test files import each other more than ${MAX_CHAIN_ROUNDS} deep`, concerned);
    const names = new Set();
    for (const p of frontier) {
      names.add(stem(p));
      if (/^(?:index|__init__)$/.test(stem(p)) && p.includes('/')) names.add(baseName(p.slice(0, p.lastIndexOf('/'))));
    }
    // git splits a pattern on newlines and ORs the pieces; a name with one cannot be searched for faithfully.
    if ([...names].some((n) => n === '' || /[\n\0]/.test(n))) return unchecked('a file name cannot be searched for', concerned);

    let texts;
    try {
      const files = filesMentioning(head, [...names], o);
      if (files.length > maxFiles) return unchecked(`more than ${maxFiles} files mention it`, concerned);
      texts = readLines(head, files, o);
    } catch (e) {
      return unchecked(`the search failed: ${oneLine(String(e.message)).slice(0, 120)}`, concerned);
    }

    // suffix -> frontier files it ends: a candidate of mode 'loose' names a file by its tail.
    const tails = new Map();
    for (const p of frontier) {
      const segs = p.split('/');
      for (let i = 0; i < segs.length; i++) {
        const t = segs.slice(i).join('/');
        tails.set(t, [...(tails.get(t) ?? []), p]);
      }
    }
    const next = new Set();
    for (const [file, lines] of texts) {
      const isTest = isTestFile(file, cx.testGlobs);
      if (!isTest && !isCodeFile(file, cx.testGlobs)) continue;
      const reached = new Map(); // frontier file -> line of the first import that reaches it
      for (const m of scanImports(lines, file)) {
        for (const c of importCandidates(m.spec, file, { python: m.py })) {
          if (c.mode === 'fwd') continue;
          for (const t of tails.get(c.path) ?? []) if ((c.mode !== 'exact' || t === c.path) && t !== file && !reached.has(t)) reached.set(t, m.from);
        }
      }
      for (const [t, line] of reached) {
        if (!isTest) {
          for (const r of rootsOf.get(t)) if (!found.has(r)) found.set(r, `${file}:${line}${r === t ? '' : `, through ${t}`}`);
          continue;
        }
        let mine = rootsOf.get(file);
        let grew = false;
        if (!mine) {
          mine = new Set();
          rootsOf.set(file, mine);
          grew = true;
        }
        for (const r of rootsOf.get(t)) if (!mine.has(r)) {
          mine.add(r);
          grew = true;
        }
        if (grew) next.add(file); // new importers of it may exist, and it may now lead to more changed files
      }
    }
    if (rootsOf.size > MAX_CHAIN_FILES) return unchecked(`more than ${MAX_CHAIN_FILES} test files in the import chain`, concerned);
    frontier = [...next];
  }
  return [...found].map(([file, by]) => ({
    rule: 'R0-unscannable', file,
    detail: `production code (${by}) already imports this test file; its new content is never judged`,
  }));
}

// symlink / gitlink from the tree modes (see diffModes): the unified diff misses them on a 100% rename. A path touched by any
// entry that has a 120000 / 160000 mode on either side counts, so a retyped file is covered too.
function applyTreeModes(files, modes) {
  const symlinks = new Set();
  const gitlinks = new Set();
  for (const m of modes) {
    for (const [set, mode] of [[symlinks, '120000'], [gitlinks, '160000']]) {
      if (m.oldMode === mode || m.newMode === mode) for (const p of [m.oldPath, m.newPath]) if (p) set.add(p);
    }
  }
  for (const f of files) {
    const own = [f.oldPath, f.newPath].filter(Boolean);
    if (own.some((p) => symlinks.has(p))) f.symlink = true;
    if (own.some((p) => gitlinks.has(p))) f.gitlink = true;
  }
}

export async function collectHardStops({ base, head, cwd, config, maxImporterHits = 5000 }) {
  const o = { cwd };
  const files = diffFiles(base, head, o);
  const mb = mergeBase(base, head, o);
  applyTreeModes(files, diffModes(base, head, o));
  const cx = settings(config);
  const ds = files.map((f) => describe(f, cx));

  // Env: which changed files deal with env, and every name an added line reads (or, in those files, looks like it declares).
  const envFiles = new Set();
  const envImportFiles = new Set();
  const candidates = new Set();
  for (const [i, d] of ds.entries()) {
    if (!d.addedIsCode) continue;
    let envish = [...d.added, ...d.removed].some((l) => l.text.length <= MAX_LINE && ENV_MENTION.test(l.text));
    if (!envish && d.newPath && d.added.some((l) => l.text.length <= MAX_LINE && ENV_SHAPE.test(l.text))) {
      envish = ENV_MENTION.test(showFile(head, d.newPath, o) ?? ''); // the schema may sit outside the changed lines
    }
    if (envish) envFiles.add(d.file);
    // `env.NAME` counts when the file imports an env object: on a changed line, or on an unchanged one (read the head file).
    let envObject = ENV_IMPORT.test([...d.added, ...d.removed].filter((l) => l.text.length <= MAX_LINE).map((l) => l.text).join('\n'));
    if (!envObject && d.newPath && d.added.some((l) => l.text.length <= MAX_LINE && /(?<![\w.$])env[.[]/.test(l.text))) {
      envObject = ENV_IMPORT.test(showFile(head, d.newPath, o) ?? '');
    }
    if (envObject) envImportFiles.add(d.file);
    for (const l of files[i].added) {
      if (l.text.length > MAX_LINE) continue;
      const f = envFinding(l, envish, envObject);
      for (const n of [...f.names, f.possible]) if (n) candidates.add(n);
    }
  }
  const baseEnvNames = candidates.size > 0 ? knownEnvNames(mb, candidates, o) : new Set();

  // Dependency files before/after: npm package.json (root and nested) and Python requirements / pyproject.
  const pkgPairs = [];
  for (const f of files) {
    const names = [f.oldPath, f.newPath].filter(Boolean);
    if (names.some((p) => LOCKFILE.test(baseName(p)))) {
      const file = f.path ?? f.newPath ?? f.oldPath;
      const dir = (f.newPath ?? f.oldPath).includes('/') ? `${(f.newPath ?? f.oldPath).slice(0, (f.newPath ?? f.oldPath).lastIndexOf('/'))}/` : '';
      const before = f.oldPath ? showFile(mb, f.oldPath, o) : null;
      const after = f.newPath ? showFile(head, f.newPath, o) : null;
      const b = before === null ? { versions: {}, direct: [] } : parseLockfile(f.oldPath, before);
      const h = after === null ? { versions: {}, direct: [] } : parseLockfile(f.newPath, after);
      if (!b || !h) {
        pkgPairs.push({ file, kind: 'lock', error: !h && !b ? 'base and head' : !h ? 'head' : 'base' });
        continue;
      }
      // Direct names: package.json beside the lockfile (head and base), plus the lockfile's own root entry; if neither
      // tells us, every locked package counts as direct.
      let direct = null;
      const known = [b.direct, h.direct];
      for (const text of [showFile(head, `${dir}package.json`, o), showFile(mb, `${dir}package.json`, o)]) {
        const parsed = text === null ? null : parseJson(text).value;
        if (isObj(parsed)) known.push(DEP_SECTIONS.flatMap((sec) => Object.keys(isObj(parsed[sec]) ? parsed[sec] : {})));
      }
      if (known.some(Array.isArray)) direct = [...new Set(known.filter(Array.isArray).flat())];
      pkgPairs.push({ file, kind: 'lock', base: b.versions, head: h.versions, direct });
      continue;
    }
    const isNpm = names.some((p) => baseName(p) === 'package.json');
    const isPy = names.some((p) => /^requirements[^/]*\.txt$/i.test(baseName(p)) || baseName(p).toLowerCase() === 'pyproject.toml');
    if (!isNpm && !isPy) continue;
    const before = f.oldPath ? showFile(mb, f.oldPath, o) : null;
    const after = f.newPath ? showFile(head, f.newPath, o) : null;
    const file = f.path ?? f.newPath ?? f.oldPath;
    if (isPy) {
      pkgPairs.push({ file, kind: 'flat', base: parsePythonDeps(before ?? ''), head: parsePythonDeps(after ?? '') });
      continue;
    }
    const b = parseJson(before);
    const h = parseJson(after);
    if (b.error || h.error) pkgPairs.push({ file, error: h.error && b.error ? 'base and head' : h.error ? 'head' : 'base' });
    else pkgPairs.push({ file, base: b.value, head: h.value });
  }

  // Whole statements around changed lines of .sql files: head side for added lines, base side for removed ones.
  const sqlStatements = [];
  for (const [i, d] of ds.entries()) {
    const f = files[i];
    if (f.binary || !d.paths.some((p) => /\.sql$/i.test(p))) continue;
    if (!d.addedIsCode && !d.removedIsCode) continue;
    const sides = [
      [f.newPath, head, f.added, d.addedIsCode],
      [f.oldPath, mb, f.removed, d.removedIsCode],
    ];
    for (const [path, ref, lines, isCode] of sides) {
      if (!path || !isCode || !lines || lines.length === 0) continue;
      const text = showFile(ref, path, o);
      if (text === null) continue;
      for (const stmt of enclosingStatements(text, lines.map((l) => l.line))) sqlStatements.push({ file: d.file, text: stmt });
    }
  }

  // Guards commented out by wrapping them (only delimiter lines added): compare the whole base and head files.
  const guardLosses = [];
  for (const [i, d] of ds.entries()) {
    const f = files[i];
    if (f.binary || !f.oldPath || !f.newPath || !d.addedIsCode || !d.removedIsCode) continue;
    if (!d.sql && !addsCommentDelimiter(f.added)) continue;
    const before = showFile(mb, f.oldPath, o);
    const after = showFile(head, f.newPath, o);
    if (before === null || after === null) continue;
    if (d.sql) {
      for (const g of lostSqlGuards(before, after)) {
        guardLosses.push({ file: d.file, kind: 'sql', detail: `auth/RLS statement no longer live (commented out or removed): ${g.label}: ${g.text.slice(0, 120)}` });
      }
    } else {
      for (const rule of lostCodeGuards(before, after, cx.authRemoved)) {
        guardLosses.push({ file: d.file, kind: 'code', detail: `removed auth guard (commented out): ${rule}` });
      }
    }
  }

  // Whole new content of changed code files, so the import check reads an import split over several lines as one.
  const headFiles = new Map();
  const tooBig = [];
  for (const d of ds) {
    if (!d.addedIsCode || d.binary || d.symlink || d.gitlink || !d.newPath || d.added.length === 0) continue;
    // Only languages the import parser reads: a 3 MB lockfile or data file must not turn every dependency PR into R0.
    // Other files keep the per-added-line import pass.
    if (!IMPORT_SOURCE.test(d.newPath)) continue;
    const text = showFile(head, d.newPath, o);
    if (text === null) continue;
    if (text.length <= MAX_HEAD_TEXT) headFiles.set(d.file, text);
    else tooBig.push({ rule: 'R0-unscannable', file: d.file, detail: `file is larger than ${MAX_HEAD_TEXT} characters; its imports cannot be checked` });
  }
  const hits = classifyHardStops({ files, config, baseEnvNames, pkgPairs, sqlStatements, envFiles, envImportFiles, guardLosses, headFiles });
  return [...hits, ...tooBig, ...reverseImportHits(ds, head, o, cx, maxImporterHits)];
}
