// Hard-stop classifier: a PR it flags can NEVER auto-merge; it waits for the human owner. A false negative lets
// something dangerous (dropped data, weakened row-level security, a leaked secret, an edit to the pipeline's own rules,
// a major dependency jump, payroll/health/biometric data) reach production unattended; a false positive costs one click.
// So every judgement call below errs toward flagging. The same file is vendored into each project and runs in CI.
//
// Shape: a pure core (`classifyHardStops`, `enclosingStatements`, `stripSqlComments`, `envNamesIn`: no IO, everything a
// test needs is an argument) plus one IO wrapper (`collectHardStops`) that gathers what the core cannot know from the
// diff alone: which env var names already exist on the base, package.json before/after, and the whole SQL statements
// around changed lines.
//
// Three details that matter for safety:
//  * SQL keyword rules run on comment-stripped text, but the stripper is string-aware (`select '--'; drop table x`)
//    and only carries a block comment across CONSECUTIVE added lines. A gap in line numbers means we cannot know the
//    state, so we assume code (match) rather than comment (skip).
//  * `-U0` diffs show single lines, so `using (owner = auth.uid())` -> `using (true)` inside an existing multi-line
//    `create policy` has no keyword on the changed line. The wrapper therefore also classifies the WHOLE enclosing
//    statement of every changed line, at both base and head (`R2-sql-statement`, and R1 for multi-line UPDATE/DELETE).
//  * Path rules test the old AND the new path (a rename out of `lib/auth/` is still an auth change) and both the path
//    as written and its lower-cased form. Exclusions (docs, tests) match the path as written only, so they can only
//    ever shrink, never grow, under a case change.
import { matchAny } from './glob.mjs';
import { DEFAULTS } from './config.mjs';
import { diffFiles, mergeBase, showFile, git, GitError } from './git.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------

const lower = (s) => s.toLowerCase();

// Inclusion test (a hit when TRUE). Matches as written, and with both sides lower-cased.
const matches = (p, globs) => matchAny(p, globs) || matchAny(lower(p), globs.map(lower));

const SQL_GLOBS = ['**/*.sql', '**/migrations/**'];
const MIGRATION_GLOBS = ['**/migrations/**'];
const NON_CODE_GLOBS = ['**/*.md', 'docs/**'];

const isSqlPath = (p) => matches(p, SQL_GLOBS);
const isMigrationPath = (p) => matches(p, MIGRATION_GLOBS);

// "Code file": not markdown, not under docs/, not a test file. Exclusion test (case-exact on purpose).
const isCodeFile = (p, testGlobs) => !matchAny(p, NON_CODE_GLOBS) && !matchAny(p, testGlobs);

const R2_PATH_GLOBS = [
  '**/auth/**', '**/middleware.{ts,js,mjs,cjs}', '**/*rbac*/**', '**/*rbac*', '**/roles.*', '**/roles/**',
  '**/permissions*', '**/permissions/**', '**/rls/**', '**/*policy*.{ts,js,mjs,sql}',
  // Beyond the spec: Next 16 renamed middleware.ts to proxy.ts; auth modules are often a FILE (lib/auth.ts, useAuth.ts).
  '**/proxy.{ts,js,mjs,cjs}', '**/middleware/**', '**/*auth.*', '**/auth-*', '**/auth_*', '**/authz*', '**/authn*',
  // The admin-client / service-role module itself, and Supabase's auth settings.
  '**/supabase/admin.*', '**/*admin-client*', '**/*admin_client*', '**/*adminclient*', '**/*service-role*',
  '**/*service_role*', '**/*servicerole*', '**/supabase/config.toml',
];
const R3_PATH_GLOBS = [
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/secrets/**',
  // Beyond the spec: other private-key / credential containers.
  '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.netrc',
];
const R4_PATH_GLOBS = [
  '**/.github/**', '**/.claude/**', '**/.githooks/**', '**/CODEOWNERS', '**/scripts/verify', '**/scripts/verify.*',
  '**/scripts/pipeline/**', '**/pipeline.yml', '**/vitest.config.*', '**/vitest.workspace.*', '**/jest.config.*',
  '**/playwright*.config.*', '**/.nycrc*', '**/codecov.y*ml', '**/.husky/**',
  // Beyond the spec: other places the verify gate can be loosened.
  '**/vitest.setup.*', '**/jest.setup.*', '**/cypress.config.*', '**/.mocharc*', '**/eslint.config.*', '**/.eslintrc*',
  '**/lefthook*.y*ml', '**/.pre-commit-config.y*ml',
];
const WORKFLOW_GLOBS = ['**/.github/workflows/**'];

// `\b` treats `_` as a word character, so `tin_number` would dodge `\btin\b`; use explicit [a-z0-9] boundaries.
const SENSITIVE_PATH = new RegExp(
  'biometric|facial|face[-_]?(?:recog|match|detect|api)|liveness|rekognition|health|medical|patient|diagnos|payroll|' +
    'payslip|salar(?:y|ies)|wage|bank[-_]?account|(?<![a-z0-9])(?:ssn|tin|sss)(?![a-z0-9])|philhealth|pag[-_]?ibig',
  'i',
);
// employeeTin.ts / validateSSN.ts have no separator before the acronym; test a camelCase-split copy as well.
const isSensitivePath = (p) => SENSITIVE_PATH.test(p) || SENSITIVE_PATH.test(p.replace(/([a-z0-9])([A-Z])/g, '$1-$2'));

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

// R1: destructive data. [label, regex], first match wins per line.
const R1_DESTRUCTIVE = [
  // Any DROP, not just the spec's list: DROP CONSTRAINT / SEQUENCE / DOMAIN / OWNED ... are all one-way.
  ['DROP', /\bDROP\s+\w+/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['ALTER TABLE ... RENAME', /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i],
  ['RENAME COLUMN/TO', /\bRENAME\s+(?:COLUMN|TO)\b/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
  // Optional ONLY and alias: `update users u set ...`.
  ['UPDATE ... SET', /\bUPDATE\s+(?:ONLY\s+)?[\w."]+(?:\s+(?:AS\s+)?[\w"]+)?\s+SET\b/i],
  ['ALTER COLUMN ... TYPE', /\bALTER\s+COLUMN\b[^;]*\b(?:TYPE|SET\s+DATA\s+TYPE)\b/i],
  ['ALTER COLUMN ... DROP', /\bALTER\s+COLUMN\b[^;]*\bDROP\b/i],
  ['ON CONFLICT DO UPDATE', /\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b/i],
  ['MERGE INTO', /\bMERGE\s+INTO\b/i],
];

// R2: auth / roles / RLS in SQL (also what R2-sql-removed and R2-sql-statement look for).
const R2_SQL = [
  ['POLICY', /\b(?:CREATE|ALTER|DROP)\s+POLICY\b/i],
  ['ROW LEVEL SECURITY', /\b(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i],
  ['GRANT', /\bGRANT\b/i],
  ['REVOKE', /\bREVOKE\b/i],
  ['SECURITY DEFINER/INVOKER', /\bSECURITY\s+(?:DEFINER|INVOKER)\b/i],
  ['auth.uid/jwt/role()', /\bauth\.(?:uid|jwt|role|email)\s*\(/i],
  ['ROLE DDL', /\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i],
  ['SET ROLE', /\bSET\s+(?:(?:LOCAL|SESSION)\s+)?ROLE\b/i],
  ['BYPASSRLS', /\bBYPASSRLS\b/i],
  // Beyond the spec: other ways to change who can see or do what.
  ['DEFAULT PRIVILEGES', /\bDEFAULT\s+PRIVILEGES\b/i],
  ['OWNER TO', /\bOWNER\s+TO\b/i],
  ['SET SESSION AUTHORIZATION', /\bSET\s+(?:(?:LOCAL|SESSION)\s+)?SESSION\s+AUTHORIZATION\b/i],
  ['security_invoker', /\bsecurity_invoker\b/i],
  ['request.jwt', /\brequest\.jwt\b/i],
  // Writing to Supabase's auth schema directly creates or alters accounts.
  ['write to auth schema', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?"?auth"?\./i],
];

// R2-auth, any file: credentials and the all-powerful client.
const SERVICE_ROLE = /service[_-]?role|supabase[_-]?admin|create[_-]?admin[_-]?client|supabase_service/i;

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
  ['Unauthorized/Forbidden', /\b(?:Unauthorized|Forbidden)\b/i],
  ['login redirect', /\bredirect\s*\(\s*['"`]\/?(?:login|sign-?in|auth)/i],
  ['role comparison', /\.role\s*[!=]==?\s*['"`]/i],
  ['middleware matcher', /\bmatcher\s*:/],
];

const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

const SECRETS_REF = /\bsecrets\s*[.[]/i;
// Beyond the spec's env/build: install/ignore commands run code at deploy; crons, rewrites, redirects, headers and
// functions change what the deployment exposes or runs.
const VERCEL_KEY = /"(?:env|build\w*|installCommand|ignoreCommand|devCommand|crons|rewrites|redirects|headers|functions)"/i;
// Scripts that can gut the verify gate or run code at install time. Also matches dep names like `lint-staged`
// (false positive, harmless).
const PKG_SCRIPT_KEY = /^\s*"(?:pre|post)?(?:install|prepare|publish|test|verify|lint|typecheck|build|ci|check)[\w:.-]*"\s*:/i;

// R3: env var names read by code. Wider than the spec: lower/mixed-case names, getenv, Bun.env, destructuring.
const ENV_PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /import\.meta\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.environ(?:\.get)?\(?\[?\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /Bun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
];
const ENV_OBJECT = String.raw`(?:process\.env|import\.meta\.env|Bun\.env)\b`;
const ENV_DESTRUCTURE = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${ENV_OBJECT}`, 'g');
const ENV_DESTRUCTURE_TAIL = new RegExp(String.raw`^\s*\}\s*=\s*${ENV_OBJECT}`);
// A destructure whose names are on earlier lines of the diff: they cannot be checked against the base, so it always flags.
const UNKNOWN_ENV = '(multi-line env destructuring)';

// Names of the environment variables read on one line of source.
export function envNamesIn(text) {
  const names = new Set();
  for (const re of ENV_PATTERNS) for (const m of text.matchAll(re)) names.add(m[1]);
  for (const m of text.matchAll(ENV_DESTRUCTURE)) {
    for (const item of m[1].split(',')) {
      const id = /^\s*([A-Za-z_]\w*)/.exec(item);
      if (id) names.add(id[1]);
    }
  }
  if (ENV_DESTRUCTURE_TAIL.test(text) && !text.includes('{')) names.add(UNKNOWN_ENV);
  return [...names];
}

// ---------------------------------------------------------------------------------------------------------------
// classifyHardStops
// ---------------------------------------------------------------------------------------------------------------

const excerpt = (text) => {
  const t = text.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const firstRule = (rules, text) => rules.find(([, re]) => re.test(text))?.[0] ?? null;
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
    file, paths, status: f.status,
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
  // R1: existing migrations are immutable; deleting one (or moving it out of the migrations dir) is destructive.
  const inMigrations = d.paths.some(isMigrationPath);
  if (inMigrations && STATUS_WORD[d.status]) sink.add('R1-migration-edited', d.file, `existing migration ${STATUS_WORD[d.status]}`);
  if (inMigrations && d.status === 'D') sink.add('R1-destructive', d.file, 'migration file deleted');
  if (d.status === 'R' && d.oldPath && isMigrationPath(d.oldPath) && !(d.newPath && isMigrationPath(d.newPath))) {
    sink.add('R1-destructive', d.file, 'migration moved out of the migrations dir');
  }

  const code = d.paths.filter((p) => isCodeFile(p, cx.testGlobs));
  const r2 = code.find((p) => matches(p, R2_PATH_GLOBS));
  if (r2) sink.add('R2-auth', d.file, `auth/roles/permissions path: ${r2}`);
  const r6 = code.find(isSensitivePath);
  if (r6) sink.add('R6-sensitive', d.file, `sensitive-data path: ${r6}`);

  const r3 = d.paths.find((p) => matches(p, R3_PATH_GLOBS));
  if (r3) sink.add('R3-secrets', d.file, `secret/credential file: ${r3}`);
  const r4 = d.paths.find((p) => matches(p, R4_PATH_GLOBS));
  if (r4) sink.add('R4-pipeline', d.file, `pipeline/verify file: ${r4}`);

  const pp = d.paths.find((p) => matches(p, cx.paths));
  if (pp) sink.add('P-path', d.file, `project hard-stop path: ${pp}`);
}

function sqlLineRules(d, sink) {
  for (const l of maskLines(d.added)) {
    const ex = { line: l.line, excerpt: excerpt(l.text) };
    const r1 = firstRule(R1_DESTRUCTIVE, l.masked);
    if (r1) sink.add('R1-destructive', d.file, `destructive SQL: ${r1}`, ex);
    const r2 = firstRule(R2_SQL, l.masked);
    if (r2) sink.add('R2-auth', d.file, `auth/RLS SQL: ${r2}`, ex);
  }
  for (const l of maskLines(d.removed)) {
    const r2 = firstRule(R2_SQL, l.masked);
    // `line` here is the OLD-file line number (the line no longer exists in the new file).
    if (r2) sink.add('R2-sql-removed', d.file, `removed auth/RLS SQL: ${r2}`, { line: l.line, excerpt: excerpt(l.text) });
  }
}

function lineRules(d, cx, baseEnv, sink) {
  if (d.sql) sqlLineRules(d, sink);

  const isWorkflow = d.paths.some((p) => matches(p, WORKFLOW_GLOBS));
  const isVercel = d.paths.some((p) => baseName(lower(p)) === 'vercel.json');
  const isPkg = d.paths.some((p) => baseName(lower(p)) === 'package.json');

  for (const l of d.added) {
    const ex = { line: l.line, excerpt: excerpt(l.text) };
    if (SERVICE_ROLE.test(l.text)) sink.add('R2-auth', d.file, 'service-role / admin-client reference', ex);
    if (isWorkflow && SECRETS_REF.test(l.text)) sink.add('R3-secrets', d.file, 'workflow reads secrets.*', ex);
    if (d.addedIsCode) {
      const fresh = envNamesIn(l.text).filter((name) => !baseEnv.has(name));
      if (fresh.length > 0) sink.add('R3-secrets', d.file, `new env var ${fresh.join(', ')}`, ex);
    }
  }

  for (const l of [...d.added, ...d.removed]) {
    const ex = { line: l.line, excerpt: excerpt(l.text) };
    if (isVercel && VERCEL_KEY.test(l.text)) sink.add('R3-secrets', d.file, 'vercel.json env/build setting changed', ex);
    if (isPkg && PKG_SCRIPT_KEY.test(l.text)) sink.add('R4-pipeline', d.file, 'package.json script changed', ex);
  }

  if (d.removedIsCode) {
    for (const l of d.removed) {
      const rule = firstRule(cx.authRemoved, l.text);
      if (rule) sink.add('R2-auth-removed', d.file, `removed auth guard: ${rule}`, { line: l.line, excerpt: excerpt(l.text) });
    }
  }

  for (const pat of cx.patterns) {
    // `paths` names the files to scan; without it, every code file. An empty list means "unspecified", not "nothing".
    const scoped = pat.paths?.length > 0;
    const inScope = scoped && d.paths.some((p) => matches(p, pat.paths));
    const addedInScope = scoped ? inScope : d.addedIsCode;
    const removedInScope = scoped ? inScope : d.removedIsCode;
    const lines = [...(addedInScope ? d.added : []), ...(removedInScope ? d.removed : [])];
    for (const l of lines) {
      if (pat.re.test(l.text)) sink.add('P-pattern', d.file, `matches project pattern "${pat.name}"`, { line: l.line, excerpt: excerpt(l.text) });
    }
  }
}

// ---- R5 -------------------------------------------------------------------------------------------------------

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// Semver ranges never contain `:` `/` or `@`; git/file/workspace/npm-alias specs always do.
const NON_REGISTRY = /[:/@]/;

function parseRange(range) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  return m ? { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) } : null;
}

// Why `from` -> `to` needs a human, or null. Major up, 0.x minor up (a 0.x minor is breaking by convention), major
// DOWN (reintroduces old code). Ranges that cannot be compared (git URLs, workspace:, *, latest) are ignored while they
// stay the same; if the spec CHANGES we cannot prove it safe, so it flags (a dep retargeted at a git URL is a
// supply-chain change).
function rangeChange(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || from === to) return null;
  const a = NON_REGISTRY.test(from) ? null : parseRange(from);
  const b = NON_REGISTRY.test(to) ? null : parseRange(to);
  if (!a || !b) return `${from} -> ${to} (range changed; not comparable as semver)`;
  if (b.major > a.major) return `${from} -> ${to} (major upgrade)`;
  if (b.major < a.major) return `${from} -> ${to} (major downgrade)`;
  if (a.major === 0 && b.minor > a.minor) return `${from} -> ${to} (0.x minor upgrade)`;
  return null;
}

function packageRules({ file, base, head, error }, sink) {
  if (error) {
    sink.add('R5-major-dep', file, `package.json could not be parsed (${error}); dependency changes unchecked`);
    return;
  }
  if (!isObj(base) || !isObj(head)) return;
  for (const section of DEP_SECTIONS) {
    if (!isObj(base[section]) || !isObj(head[section])) continue;
    for (const [name, range] of Object.entries(head[section])) {
      if (!Object.hasOwn(base[section], name)) continue; // new deps are not hits
      const why = rangeChange(base[section][name], range);
      if (why) sink.add('R5-major-dep', file, `${section}: ${name} ${why}`);
    }
  }
  const why = rangeChange(base.engines?.node, head.engines?.node);
  if (why) sink.add('R5-major-dep', file, `engines.node ${why}`);
}

// ---- entry point ----------------------------------------------------------------------------------------------

// files: parseUnifiedDiff output. baseEnvNames: env var names already present on the base (Set or array).
// basePkg/headPkg: parsed root package.json (or null). pkgPairs: more `{file, base, head}` or `{file, error}` pairs
// (monorepo packages). sqlStatements: `{file, text}` whole statements around changed lines, from the base and head.
// Returns hits `{ rule, file, line?, excerpt?, detail }`.
export function classifyHardStops({
  files, config, baseEnvNames = new Set(), basePkg = null, headPkg = null, pkgPairs = [], sqlStatements = [],
}) {
  const cx = settings(config);
  const baseEnv = new Set(baseEnvNames);
  const sink = makeSink();

  for (const f of files) {
    const d = describe(f, cx);
    pathRules(d, cx, sink);
    lineRules(d, cx, baseEnv, sink);
  }

  packageRules({ file: 'package.json', base: basePkg, head: headPkg }, sink);
  for (const pair of pkgPairs) packageRules(pair, sink);

  for (const s of sqlStatements) {
    const text = s.text ?? '';
    const r2 = firstRule(R2_SQL, text);
    if (r2) sink.add('R2-sql-statement', s.file, `statement with ${r2}: ${oneLine(text).slice(0, 120)}`);
    const r1 = firstRule(R1_DESTRUCTIVE, text);
    if (r1) sink.add('R1-destructive', s.file, `destructive statement (${r1}): ${oneLine(text).slice(0, 120)}`);
  }

  return sink.list();
}

// ---------------------------------------------------------------------------------------------------------------
// collectHardStops (IO)
// ---------------------------------------------------------------------------------------------------------------

// Is `name` mentioned anywhere in the tree at `ref`? Whole-word (-w), so FOO_TOKEN_OLD does not vouch for FOO_TOKEN
// (grepAtRef is substring-only and would). Exit code 1 is git grep's "no match".
function treeMentions(ref, name, o) {
  if (name === UNKNOWN_ENV) return false;
  try {
    git(['grep', '-F', '-w', '-q', '-e', name, ref, '--'], o);
    return true;
  } catch (e) {
    if (e instanceof GitError && e.code === 1) return false;
    throw e;
  }
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

  // Env names: every name an added code line reads; the ones the base tree already mentions are "known".
  const candidates = new Set();
  for (const f of files) {
    const d = describe(f, cx);
    if (!d.addedIsCode) continue;
    for (const l of d.added) for (const name of envNamesIn(l.text)) candidates.add(name);
  }
  const baseEnvNames = new Set([...candidates].filter((name) => treeMentions(mb, name, o)));

  // package.json before/after for the root and any nested package that changed.
  const pkgPairs = [];
  for (const f of files) {
    const names = [f.oldPath, f.newPath].filter(Boolean);
    if (!names.some((p) => baseName(p) === 'package.json')) continue;
    const before = f.oldPath ? showFile(mb, f.oldPath, o) : null;
    const after = f.newPath ? showFile(head, f.newPath, o) : null;
    const b = parseJson(before);
    const h = parseJson(after);
    const file = f.path ?? f.newPath ?? f.oldPath;
    if (b.error || h.error) pkgPairs.push({ file, error: h.error && b.error ? 'base and head' : h.error ? 'head' : 'base' });
    else pkgPairs.push({ file, base: b.value, head: h.value });
  }

  // Whole statements around changed lines of .sql files: head side for added lines, base side for removed ones.
  const sqlStatements = [];
  for (const f of files) {
    if (f.binary) continue;
    if (![f.oldPath, f.newPath].some((p) => p && /\.sql$/i.test(p))) continue;
    const file = f.path ?? f.newPath ?? f.oldPath;
    const sides = [
      [f.newPath, head, f.added],
      [f.oldPath, mb, f.removed],
    ];
    for (const [path, ref, lines] of sides) {
      if (!path || !lines || lines.length === 0) continue;
      const text = showFile(ref, path, o);
      if (text === null) continue;
      for (const stmt of enclosingStatements(text, lines.map((l) => l.line))) sqlStatements.push({ file, text: stmt });
    }
  }

  return classifyHardStops({ files, config, baseEnvNames, pkgPairs, sqlStatements });
}
