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
//  * Content rules (SQL, auth, secrets, env, sensitive terms) judge PRODUCTION code only: not tests, not docs/markdown.
//    Path rules and the R1 migration rules judge every file.
//  * SQL keyword rules run on comment-stripped text; the stripper is string-aware and only carries a block comment across
//    CONSECUTIVE added lines (a gap means we cannot know the state, so we assume code). In non-SQL code, SQL lives in
//    strings, so only multi-word forms are matched there (no bare "grant" or "truncate").
//  * `-U0` diffs show single lines, so the wrapper also classifies the WHOLE enclosing statement of every changed SQL line
//    at both base and head (an edit inside a multi-line `create policy` has no keyword on the changed line).
//  * Path rules test the old AND the new path, case-insensitively. Exclusions (docs, tests) match the path as written.
import { matchAny } from './glob.mjs';
import { DEFAULTS } from './config.mjs';
import { diffFiles, mergeBase, showFile, git, GitError } from './git.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------

// A line longer than this is not scanned by any regex (ReDoS guard); its file becomes R0-unscannable instead.
const MAX_LINE = 20_000;

// Inclusion test (a hit when TRUE), case-insensitive: over-matching is the safe direction.
const inc = (p, globs) => matchAny(p, globs, { nocase: true });

const MIGRATION_GLOBS = ['**/migrations/**'];
const NON_CODE_GLOBS = ['**/*.md', 'docs/**'];

// `docs/migrations/notes.md` documents migrations; it is not one.
const isMigrationPath = (p) => !/\.md$/.test(p) && inc(p, MIGRATION_GLOBS);
// "SQL file": `**/*.sql` or anything under a migrations dir.
const isSqlPath = (p) => inc(p, ['**/*.sql']) || isMigrationPath(p);
// "Code file": not markdown, not under docs/, not a test file. An EXCLUSION test, so it matches the path as written.
const isCodeFile = (p, testGlobs) => !matchAny(p, NON_CODE_GLOBS) && !matchAny(p, testGlobs);

// Binary changes we accept without reading: assets nobody can hide logic in.
const BINARY_ASSET = /\.(?:png|jpe?g|gif|webp|avif|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp4|mov|mp3|wav|wasm|bin|snap)$/i;

const R2_PATH_GLOBS = [
  '**/auth/**', '**/middleware.{ts,js,mjs,cjs}', '**/*rbac*/**', '**/*rbac*', '**/roles*', '**/roles*/**',
  '**/permissions*', '**/permissions/**', '**/rls/**', '**/*policy*.{ts,js,mjs,sql}',
  // Beyond the spec: Next 16 renamed middleware.ts to proxy.ts; session/JWT modules; the admin-client / service-role
  // module itself; Supabase's auth settings.
  '**/proxy.{ts,js,mjs,cjs}', '**/middleware/**', '**/authz*', '**/authn*', '**/session*', '**/session*/**', '**/jwt*',
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
  '**/.github/**', '**/.claude/**', '**/.githooks/**', '**/CODEOWNERS', '**/scripts/verify*', '**/scripts/verify*/**',
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
    '(?<![a-z0-9])(?:bank(?:ing)?|faces?|pii|ssn|tin|sss)(?![a-z0-9])',
  'i',
);
// Terms inside added lines (word-bounded; `_` and camelCase count as separators).
const SENSITIVE_TEXT = new RegExp(
  '(?<![a-z0-9])(?:payroll|payslip|salar(?:y|ies)|philhealth|pag-?ibig|sss_number|tin_number|biometric|face_embedding|' +
    'fingerprint_template|bank_account|iban|routing_number|diagnosis|patient_id|medical_record)(?![a-z0-9])',
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
const SQL_SPECIAL = /--|\/\*|'|"|\$|;/g;
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
function scanSql(text) {
  const out = [];
  const semis = [];
  const blank = (s) => s.replace(/[^\n]/g, MASK);
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
    } else {
      semis.push(i);
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
const ENV_MENTION = /process\.env|import\.meta\.env|z\.object|createEnv|Bun\.env|os\.environ/;

// What one source line reads from the environment: literal names (plus UNKNOWN_ENV for a multi-line destructure) and
// whether anything dynamic is left.
export function scanEnvLine(text) {
  const names = new Set();
  let rest = text;
  for (const r of ENV_ACCESS) {
    rest = rest.replace(r, (_m, name) => {
      names.add(name);
      return ' ';
    });
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
export const envNamesIn = (text) => scanEnvLine(text).names;

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
    file, paths, status: f.status, binary: Boolean(f.binary),
    oldPath: f.oldPath ?? null, newPath: f.newPath ?? null,
    added: f.added ?? [], removed: f.removed ?? [],
    sql: paths.some(isSqlPath),
    // Added lines live in the new path, removed lines in the old one.
    addedIsCode: isCodeFile(f.newPath ?? file, cx.testGlobs),
    removedIsCode: isCodeFile(f.oldPath ?? file, cx.testGlobs),
  };
}

const STATUS_WORD = { M: 'edited', D: 'deleted', R: 'renamed' };

function pathRules(d, cx, sink) {
  // R0: a binary diff of anything but a plain asset cannot be read, so nothing below can vouch for it.
  if (d.binary && !d.paths.every((p) => BINARY_ASSET.test(p))) {
    sink.add('R0-unscannable', d.file, "binary diff; content can't be checked");
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
function envFinding(l, envish) {
  const { names, dynamic } = scanEnvLine(l.text);
  const shape = envish ? ENV_SHAPE.exec(l.text)?.[1] : undefined;
  return { names, dynamic, possible: shape && !names.includes(shape) ? shape : undefined };
}

function addedCodeRules(d, added, cx, env, sink) {
  const live = (l) => !COMMENT_LINE.test(l.text);
  const isWorkflow = d.paths.some((p) => inc(p, WORKFLOW_GLOBS));
  const isVercel = d.paths.some((p) => baseName(p).toLowerCase() === 'vercel.json');
  const envish = env.envFiles ? env.envFiles.has(d.file) : [...added, ...d.removed].some((l) => ENV_MENTION.test(l.text));

  if (d.sql) {
    for (const l of maskLines(added)) {
      const ex = { line: l.line, excerpt: excerpt(l.text) };
      const r1 = firstSql(R1_SQL, l.masked, false);
      if (r1) sink.add('R1-destructive', d.file, `destructive SQL: ${r1}`, ex);
      const r2 = firstSql(R2_SQL, l.masked, false);
      if (r2) sink.add('R2-auth', d.file, `auth/RLS SQL: ${r2}`, ex);
    }
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

    const found = envFinding(l, envish);
    const parts = [];
    const fresh = found.names.filter((n) => !env.known.has(n));
    if (fresh.length > 0) parts.push(`new env var ${fresh.join(', ')}`);
    if (found.dynamic) parts.push('dynamic env access (names cannot be checked)');
    if (found.possible && !env.known.has(found.possible)) parts.push(`possible new env var ${found.possible}`);
    if (parts.length > 0) sink.add('R3-secrets', d.file, parts.join('; '), ex);

    if (live(l) && isSensitiveText(l.text)) sink.add('R6-sensitive', d.file, 'sensitive-data term in added code', ex);
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
// Throws TypeError when the diff touches SQL or package.json and sqlStatements / pkgPairs (or basePkg+headPkg) are missing.
// Returns hits `{ rule, file, line?, excerpt?, detail }`.
export function classifyHardStops({ files, config, baseEnvNames = new Set(), basePkg, headPkg, pkgPairs, sqlStatements, envFiles }) {
  const cx = settings(config);
  const sink = makeSink();
  const known = new Set(baseEnvNames);
  const env = { known, envFiles: envFiles === undefined ? null : new Set(envFiles) };

  const pairs = [...(pkgPairs ?? [])];
  if (basePkg !== undefined || headPkg !== undefined) pairs.push({ file: 'package.json', base: basePkg ?? null, head: headPkg ?? null });

  for (const f of files) {
    const d = describe(f, cx);
    if (baseName(d.file).toLowerCase() === 'package.json') {
      needs(pairs.some((p) => p.file === d.file), `the diff touches ${d.file} but no pkgPairs entry (or basePkg/headPkg) was given`);
    }
    if (d.sql && !d.binary && d.added.length + d.removed.length > 0) {
      needs(Array.isArray(sqlStatements), `the diff changes SQL (${d.file}) but sqlStatements was not given`);
    }
    pathRules(d, cx, sink);
    lineRules(d, cx, env, sink);
  }

  for (const pair of pairs) {
    if (pair.error) sink.add('R5-major-dep', pair.file, `${baseName(pair.file)} could not be parsed (${pair.error}); dependency changes unchecked`);
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

  return sink.list();
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
    for (const line of out.split('\n')) for (const name of envNamesIn(line)) known.add(name);
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

export async function collectHardStops({ base, head, cwd, config }) {
  const o = { cwd };
  const files = diffFiles(base, head, o);
  const mb = mergeBase(base, head, o);
  const cx = settings(config);
  const ds = files.map((f) => describe(f, cx));

  // Env: which changed files deal with env, and every name an added line reads (or, in those files, looks like it declares).
  const envFiles = new Set();
  const candidates = new Set();
  for (const [i, d] of ds.entries()) {
    if (!d.addedIsCode) continue;
    let envish = [...d.added, ...d.removed].some((l) => l.text.length <= MAX_LINE && ENV_MENTION.test(l.text));
    if (!envish && d.newPath && d.added.some((l) => l.text.length <= MAX_LINE && ENV_SHAPE.test(l.text))) {
      envish = ENV_MENTION.test(showFile(head, d.newPath, o) ?? ''); // the schema may sit outside the changed lines
    }
    if (envish) envFiles.add(d.file);
    for (const l of files[i].added) {
      if (l.text.length > MAX_LINE) continue;
      const f = envFinding(l, envish);
      for (const n of [...f.names, f.possible]) if (n) candidates.add(n);
    }
  }
  const baseEnvNames = candidates.size > 0 ? knownEnvNames(mb, candidates, o) : new Set();

  // Dependency files before/after: npm package.json (root and nested) and Python requirements / pyproject.
  const pkgPairs = [];
  for (const f of files) {
    const names = [f.oldPath, f.newPath].filter(Boolean);
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

  return classifyHardStops({ files, config, baseEnvNames, pkgPairs, sqlStatements, envFiles });
}
