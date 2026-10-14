// One model of the SQL command-line clients (psql, mysql/mariadb, sqlite3, pgcli/mycli/usql), shared by the parser (a client named in the line),
// by both policies (a client named by a variable: `Q=psql; $Q -f x.sql`) and by the files they read.
// Why: these clients run shell commands and write files from the TEXT they read (psql `\! cmd`, `\o |cmd`, mysql `system cmd`, sqlite3 `.shell cmd`),
// include other files (`\i`, `source`, `.read`), and start from rc files and options of their own. The guards judge that text like shell lines, so the
// model is an ALLOWLIST: a meta-command outside the known-safe set is an unknown shell line (dynamic: refused when guarded text is around), never skipped.
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { newEvalBudget, checkDeadline } from './script-candidates.mjs'; // (used only when a scan runs, so the import cycle through shell-parse is harmless)

const FAMILY = { psql: 'psql', pgcli: 'psql', usql: 'psql', mysql: 'mysql', mariadb: 'mysql', mycli: 'mysql', sqlite3: 'sqlite' };
const PROG = { psql: 'psql', mysql: 'mysql', sqlite: 'sqlite3' };
export const SQL_CLIENT_NAMES = new Set(Object.keys(FAMILY));
export const sqlFamilyOf = (name) => FAMILY[name] ?? null;

// A shell line that stands for "something this client runs that cannot be known": a command named by a variable, so it is dynamic and the policies
// refuse it when the line (or the text it sits in) mentions a guarded operation or a protected file.
// (the name carries a random suffix: a fixed one could be a variable the command itself sets, which files-policy would then take for this placeholder)
export const SQL_UNKNOWN_VAR = `SQL_UNKNOWN_SHELL_LINE_${randomBytes(8).toString('hex')}`;
const UNKNOWN = `$${SQL_UNKNOWN_VAR}`;
const clean = (s) => String(s).replace(/\\/g, '').replace(/[`'"\\;&|<>()${}\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
const unq = (w) => String(w).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
// (a name psql could interpolate has `:`; only a drive letter keeps one)
const PLAIN = /^(?:[A-Za-z]:)?[\w.\/~+@%,=-]+$/;

// ---- the text a client reads ------------------------------------------------------------------------------

const PSQL_SAFE = new Set(['set', 'unset', 'timing', 'x', 'echo', 'qecho', 'warn', 'pset', 'a', 't', 'T', 'C', 'H', 'f', 'l', 'list', 'conninfo', 'encoding', 'c', 'connect', 'q', 'quit',
  'if', 'elif', 'else', 'endif', 'prompt', 'password', 'copyright', 'h', 'help', '?', 'gexec', 'gdesc', 'watch', 'crosstabview', 'sf', 'sv', 'z', 'errverbose', 'parse', 'bind', 'bind_named',
  'close', 'flush', 'flushrequest', 'getresults', 'sendpipeline', 'startpipeline', 'syncpipeline', 'endpipeline', 'restrict', 'unrestrict', 'lo_list', 'lo_unlink', 'lo_import', 'drds', ';', '\\']);
const MYSQL_SAFE = new Set(['g', 'G', 'c', 'p', 'r', 'R', 's', 'u', 'w', 'W', 'n', 't', 'd', 'C', 'q', 'h', '?', '#', 'x', '0', "'", '"', '%', '_', 'b', 'Z', '\\']);

// Every sqlite3 dot command; a typed word is any PREFIX of one (`.sh x` is `.shell x`, `.rea f` is `.read f`).
const SQLITE_CMDS = ['archive', 'auth', 'backup', 'bail', 'binary', 'cd', 'changes', 'check', 'clone', 'connection', 'databases', 'dbconfig', 'dbinfo', 'dump', 'echo', 'eqp', 'excel', 'exit', 'expert', 'explain',
  'filectrl', 'fullschema', 'headers', 'header', 'help', 'import', 'imposter', 'indexes', 'limit', 'lint', 'load', 'log', 'mode', 'nonce', 'nullvalue', 'once', 'open', 'output', 'parameter', 'print', 'progress',
  'prompt', 'quit', 'read', 'recover', 'restore', 'save', 'scanstats', 'schema', 'selftest', 'separator', 'session', 'sha3sum', 'shell', 'show', 'stats', 'system', 'tables', 'testcase', 'testctrl', 'timeout',
  'timer', 'trace', 'unmodule', 'version', 'vfsinfo', 'vfslist', 'vfsname', 'width', 'www'];
const SQLITE_SAFE = new Set(['bail', 'binary', 'changes', 'connection', 'databases', 'dbinfo', 'dump', 'echo', 'eqp', 'exit', 'explain', 'fullschema', 'headers', 'header', 'help', 'indexes', 'limit', 'lint', 'mode',
  'nullvalue', 'parameter', 'print', 'progress', 'prompt', 'quit', 'schema', 'separator', 'show', 'stats', 'tables', 'timeout', 'timer', 'version', 'width']);
// roles of the commands that are not simply safe
const SQLITE_ROLE = { shell: 'shell', system: 'shell', read: 'read', output: 'out', once: 'out', import: 'import', save: 'write', backup: 'write', open: 'openw', log: 'write', trace: 'write', cd: 'unknown' };

// sqlite's own reading of a double-quoted dot-command argument (shell.c resolve_backslashes): \a \b \t \n \v \f \r \" \' \\, octal \NNN (up to three digits), \xHH.
// Anything that cannot be modelled exactly (an unknown escape, a NUL, a byte past ASCII: C strings end at the NUL and the rest is encoding-dependent) is `bad`.
const SQLITE_ESC = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', "'": "'", '\\': '\\' };
function sqliteDecode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const c = s[++i];
    let v;
    if (c !== undefined && Object.hasOwn(SQLITE_ESC, c)) v = SQLITE_ESC[c];
    else if (c !== undefined && /[0-7]/.test(c)) {
      let n = +c;
      for (let k = 0; k < 2 && /[0-7]/.test(s[i + 1] ?? ''); k++) n = n * 8 + +s[++i];
      if (n === 0 || n > 0x7f) return { text: s, bad: true };
      v = String.fromCharCode(n);
    } else if (c === 'x' && /^[0-9a-fA-F]/.test(s[i + 1] ?? '')) {
      let h = s[++i];
      if (/[0-9a-fA-F]/.test(s[i + 1] ?? '')) h += s[++i];
      const n = parseInt(h, 16);
      if (n === 0 || n > 0x7f) return { text: s, bad: true };
      v = String.fromCharCode(n);
    } else return { text: s, bad: true };
    out += v;
  }
  return { text: out, bad: out.includes('\0') };
}

// Words of a meta-command's argument text: quotes removed; a backtick part is a shell command (returned apart).
// sqlite mode reads the words the way sqlite does: double-quoted arguments are backslash-decoded, single-quoted ones are literal (`bad`: a word that could not be modelled
// exactly, or a quoted word glued to more text; `quoted[i]`: the word had quotes).
function metaArgs(rest, mode = 'psql') {
  const words = [];
  const quoted = [];
  const ticks = [];
  let bad = false;
  for (const m of rest.matchAll(/`([^`]*)`/g)) ticks.push(m[1]);
  const body = rest.replace(/`[^`]*`/g, ' ');
  if (mode === 'sqlite') {
    for (const m of body.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
      if (m[1] !== undefined || m[2] !== undefined) {
        const glued = body[m.index + m[0].length] !== undefined && !/\s/.test(body[m.index + m[0].length]);
        const d = m[2] !== undefined ? sqliteDecode(m[2]) : { text: m[1], bad: false };
        if (d.bad || glued) bad = true;
        words.push(d.text);
        quoted.push(true);
      } else { words.push(m[3]); quoted.push(false); }
    }
    return { words, ticks, bad, quoted };
  }
  for (const m of body.matchAll(/'((?:[^'\\]|''|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
  return { words, ticks, bad, quoted };
}

// Why: the nested evaluation must judge the real path text, so a name that is not a plain word is emitted shell-quoted (single quotes, so nothing in it expands); a sqlite `file:` URI names
// the file (`file:/p?mode=rwc`, `file:///p`, `file://host/p`, percent-escapes decoded)
const shq = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
function uriPath(f) {
  if (!/^file:/i.test(f)) return f;
  let p = f.slice(5).replace(/[?#].*$/s, '').replace(/^\/\/[^/]*(?=\/)/, '');
  try { p = decodeURIComponent(p); } catch { /* keep the text as written */ }
  return p || f;
}
const targetOf = (f) => { if (!f) return shq(''); const u = uriPath(f); return PLAIN.test(u) ? u : shq(u); };
// psql interpolation: `:name`, `:'name'`, `:"name"`. Not tracked per quote (block comments, E'' escapes, dollar quotes and multi-line strings all hide a quote from a line scan): any `:` followed by
// a name character or a quote counts, except the `::` cast.
function interpolates(text) {
  return /(?<!:):(?!:)[A-Za-z_'"]/.test(String(text).replace(/::/g, '  '));
}

/**
 * The shell lines the text of a database client's input runs: escapes (`\! cmd`), writes (`: > FILE` for a file the client writes), includes (`psql < FILE`),
 * and an unknown line for every meta-command outside the known-safe set.
 * @param {string} text
 * @param {{family?: string, sources?: string[]}} opts family: psql | mysql | sqlite | mycnf | any (unknown client); sources: absolute paths of the files the text was read
 * from (`\ir` is relative to the directory of the one being read, `\i` and the rest to the working directory, where the sub-script is judged);
 * budget: the evaluation budget (its deadline is checked once per line; none given: a fresh one), a scan past it throws GuardLimit, which the policies turn into a denial.
 */
export function sqlShellEscapes(text, opts = {}) {
  const fam = opts.family ?? 'any';
  const t = String(text ?? '');
  const out = [];
  const sources = opts.sources ?? [];
  let shellRest;
  const budget = opts.budget ?? newEvalBudget();
  const unknown = (raw) => out.push(`${UNKNOWN} ${clean(raw)}`);
  // Why: the whole input as an unknown line is the same line however often it is asked for, and cleaning all of it once per input LINE is quadratic output (6,500 chars gave 2.7 MB)
  let wholeUnknown = false;
  const unknownWhole = () => { if (!wholeUnknown) { wholeUnknown = true; unknown(t); } };
  const write = (f) => out.push(`: > ${targetOf(f)}`);
  const include = (prog, w, relative) => {
    const f = unq(w);
    const cands = relative && sources.length && !isAbsolute(f) && !f.startsWith('~') ? [...new Set([...sources.map((s) => join(dirname(s), f).replace(/\\/g, '/')), f])] : [f];
    for (const c of cands) out.push(`${prog} < ${PLAIN.test(c) ? c : shq(c)}`);
  };
  const run = (cmd) => { if (cmd.trim()) out.push(cmd.trim()); };
  // (the command of a sqlite `|cmd` argument: unquoted it is the rest of the text after the pipe; quoted, the whole decoded word after it)
  const pipeCommand = (rest, word) => (/^\s*\|/.test(rest) ? rest.replace(/^\s*\|/, '') : word.slice(1));
  const all = fam === 'any';
  const interp = (fam === 'psql' || all) && interpolates(t); // (once: the answer is about the whole input, not the line)

  // ---- psql: `\word args` anywhere in a line (quotes are not tracked: a backslash in a string is read as a command, fail closed).
  // Why: a shell escape's text is the REST OF THE LINE, unsplit (`\! git push origin ma\in`: the shell reads `ma\in` as main); a later backslash in it also leaves the line unknown.
  const psql = (line) => {
    // Why: psql re-lexes the value of an interpolated variable (`\set x '\\! cmd'` then `:x` on any line is a backslash command), so any interpolation, or a `\set` value that holds a backslash, is unknown input
    // (`\gset` fills variables from a query result, whose text is unknown; `\set` anywhere on the line, then a backslash after it)
    if (interp || /\\set\b[\s\S]*\\./.test(line) || /\\gset\b/.test(line)) unknownWhole();
    let at = line.indexOf('\\');
    while (at >= 0) {
      const m = /^\\(\\|[A-Za-z0-9_]+|.)/.exec(line.slice(at));
      if (!m) break;
      const word = m[1];
      let whole = line.slice(at + m[0].length);
      let skipped = 0; // (the length cut off the front of `whole`: the offset of the next backslash is relative to what is left)
      // Why: `\g (format=csv) |cmd` / `\g (opts) FILE`: the leading balanced option list is not the target; unbalanced, the input is unknown
      if (word === 'g' || word === 'gx') {
        const lead = /^\s*\(/.exec(whole);
        if (lead) {
          let depth = 0;
          let end = -1;
          for (let k = lead[0].length - 1; k < whole.length; k++) { if (whole[k] === '(') depth++; else if (whole[k] === ')' && --depth === 0) { end = k; break; } }
          if (end < 0) { unknownWhole(); break; }
          whole = whole.slice(end + 1);
          skipped = end + 1;
        }
      }
      const next = whole.indexOf('\\');
      const own = next < 0 ? whole : whole.slice(0, next);
      const piped = /^\s*\|/.test(own);
      const escape = word === '!' || (piped && /^(?:o|out|g|gx|w|s)$/.test(word)) || (word === 'copy' && /\bprogram\b/i.test(whole));
      const rest = escape ? whole : own;
      if (escape && next >= 0) unknown(line.slice(at));
      const { words, ticks } = metaArgs(rest);
      for (const k of ticks) run(k);
      // Why: psql interpolates :var / :'var' / :"var" in the arguments (`\set f ~/.claude/x` then `\o :f`): the target, include or command is only known at run time,
      // so the whole input is the unknown line (what the variable was set to sits elsewhere in it)
      if (/^(?:!|i|include|ir|include_relative|o|out|g|gx|w|s|lo_export|copy)$/.test(word) && /(?:^|[\s'"(,]):['"]?[A-Za-z_]/.test(rest)) unknownWhole();
      if (word === '!') { if (rest.trim()) run(rest); else { unknown(line.slice(at)); shellRest = true; } }
      else if (/^(?:i|include)$/.test(word)) { if (words[0]) include('psql', words[0], false); }
      else if (/^(?:ir|include_relative)$/.test(word)) { if (words[0]) include('psql', words[0], true); }
      else if (word === 'o' || word === 'out' || word === 'g' || word === 'gx' || word === 'w' || word === 's') {
        if (piped) run(rest.replace(/^\s*\|/, ''));
        else { const f = words.find((w) => !w.startsWith('(')); if (f) write(f); }
      } else if (word === 'lo_export') { if (words[1]) write(words[1]); }
      else if (word === 'copy') {
        for (const p of rest.matchAll(/\bprogram\s+('(?:[^']|'')*'|"[^"]*"|\S+)/gi)) run(unq(p[1]));
        for (const p of rest.matchAll(/\bto\s+('(?:[^']|'')*'|"[^"]*"|[^\s;]+)/gi)) { const f = unq(p[1]); if (!/^(?:stdout|pstdout|program)$/i.test(f)) write(f); }
      } else if (PSQL_SAFE.has(word) || /^d[A-Za-z+]*$/.test(word) || /^l(?:ist)?\+?$/.test(word)) { /* safe */ }
      else if (all) { /* judged by the other tables */ } else unknown(line.slice(at));
      at = escape || next < 0 ? -1 : at + m[0].length + skipped + next;
      if (at >= 0 && line[at] !== '\\') { unknownWhole(); at = -1; } // (the scan must land on a backslash; anything else means the offsets are off: unknown input)
    }
  };
  // ---- mysql: bare words at the start of a statement, `\X` commands anywhere in a line (`\!` and `\P` take the rest of the line, unsplit)
  const mysql = (line) => {
    let m;
    for (m of line.matchAll(/(?:^|;)\s*(system|source|tee|pager|edit)(?![\w])\s*([^\n]*)/gi)) {
      const w = m[1].toLowerCase();
      if (w === 'system' || w === 'pager') { run(m[2]); if (w === 'system' && !m[2].trim()) shellRest = true; }
      else if (w === 'tee') { const f = unq(m[2].replace(/;\s*$/, '').trim()); if (f) write(f); }
      else if (w === 'edit') unknown(m[0]);
      else { const f = unq(m[2].replace(/;.*$/, '').trim()); if (f) include('mysql', f, false); else unknown(m[0]); }
    }
    let at = line.indexOf('\\');
    while (at >= 0) {
      const b = /^\\(.)/.exec(line.slice(at));
      if (!b) break;
      const c = b[1];
      const whole = line.slice(at + 2);
      const next = whole.indexOf('\\');
      const escape = c === '!' || c === 'P';
      const rest = escape || c === '.' || c === 'T' ? whole : next < 0 ? whole : whole.slice(0, next);
      if (c === '\\') { /* a doubled backslash */ }
      else if (escape) { run(whole); if (!whole.trim()) shellRest = true; if (next >= 0) unknown(line.slice(at)); }
      else if (c === '.') { const f = unq(rest.replace(/;.*$/, '').trim()); if (f) include('mysql', f, false); else unknown(line.slice(at)); }
      else if (c === 'T') { const f = unq(rest.replace(/;\s*$/, '').trim()); if (f) write(f); }
      else if (MYSQL_SAFE.has(c)) { /* safe */ }
      else if (all) { /* judged by the other tables */ } else unknown(line.slice(at));
      at = escape || next < 0 ? -1 : at + 2 + next;
    }
  };
  // ---- sqlite3: a line that starts with `.` (at the start of a statement; a line inside a statement is read the same way, fail closed)
  const sqlite = (line) => {
    const m = /^\s*\.([A-Za-z0-9_]*)([\s\S]*)$/.exec(line);
    if (!m) return;
    const [, word, rest] = m;
    const cands = word ? SQLITE_CMDS.filter((c) => c.startsWith(word.toLowerCase())) : [];
    const { words, ticks, bad: badArgs, quoted } = metaArgs(rest, 'sqlite');
    for (const k of ticks) run(k);
    if (!cands.length) { unknown(line); return; }
    let bad = badArgs; // (an argument that could not be decoded exactly: the line is unknown, whatever else it is read as)
    for (const c of new Set(cands)) {
      const role = SQLITE_ROLE[c];
      if (role === 'shell') { run(rest); if (!rest.trim()) shellRest = true; }
      // Why: sqlite removes the quotes before it looks for the pipe (`.output "|cmd"` runs cmd), so the decision is made on the decoded word; the command is what follows the `|` in the argument text
      else if (role === 'read') { if (words[0]?.startsWith('|')) run(pipeCommand(rest, words[0])); else if (words[0]) include('sqlite3', words[0], false); }
      else if (role === 'out') { if (words[0]?.startsWith('|')) run(pipeCommand(rest, words[0])); else if (words[0]?.startsWith('-')) bad = true; else if (words[0] && words[0] !== 'stdout') write(words[0]); }
      else if (role === 'import') {
        const k = words.findIndex((w) => !w.startsWith('-'));
        // (a quoted `|cmd` is the decoded word; unquoted, the old rest-of-text reading)
        if (k >= 0 && quoted[k] && words[k].startsWith('|')) run(words[k].slice(1));
        else if (/^\s*(?:-\S+\s+)*["']?\|/.test(rest) || words[k]?.startsWith('|')) run(rest.replace(/^[^|]*\|/, '').replace(/["']\s*\S*\s*$/, ''));
      }
      else if (role === 'openw') { const f = words.filter((w) => !w.startsWith('-')).pop(); if (f && f !== ':memory:') write(f); }
      else if (role === 'write') { const f = words[words.length - 1]; if (f && !f.startsWith('-')) write(f); }
      else if (!SQLITE_SAFE.has(c)) bad = true;
    }
    if (bad) unknown(line);
  };
  // Why: writefile('F', data), ATTACH 'F' AS x and VACUUM INTO 'F' create F. The target counts only as ONE complete literal directly followed by the closing , / ) / AS / ;
  // (comments stripped); a concatenation, a parenthesis or a computed name is unknown (the whole line).
  const sqliteSql = (whole) => {
    // (unknown: the text as it is, and with its string concatenations joined, so a name split as 'a' || 'b' is read whole)
    const CAT = /'\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*\|\|\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*'/g;
    let flagged = false; // (the same two lines however many matches ask for them)
    const unknownSql = () => { if (flagged) return; flagged = true; unknown(whole); unknown(whole.replace(CAT, '')); };
    const text = whole;
    // (comments are cut first, then the lines are folded: `writefile(\n'F',\n x)` is one call)
    const bare = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
    if (/\b(?:edit|load_extension)\s*\(/i.test(bare)) unknownSql();
    const LIT = "('(?:[^']|'')*'|\"[^\"]*\")";
    const take = (re, word) => {
      for (const m of bare.matchAll(new RegExp('\\b' + word + '\\b', 'gi'))) {
        const sticky = new RegExp(re, 'iy');
        sticky.lastIndex = m.index;
        const hit = sticky.exec(bare);
        if (hit) { const f = unq(hit[1]); if (f && f !== ':memory:') write(f); } else unknownSql();
      }
    };
    take('writefile\\s*\\(\\s*' + LIT + '\\s*[,)]', 'writefile');
    take('attach\\s+(?:database\\s+)?' + LIT + '\\s+as\\b', 'attach');
    take('vacuum\\s+(?:\\w+\\s+)?into\\s+' + LIT + '\\s*(?:;|$)', 'vacuum\\s+(?:\\w+\\s+)?into');
  };
  // ---- rc files of the mysql clients: `pager = cmd` runs a command, `tee = file` writes
  const mycnf = (line) => {
    const m = /^\s*(pager|tee|init[-_]command)\s*=\s*(.*)$/i.exec(line);
    if (!m) return;
    if (/^pager$/i.test(m[1])) run(unq(m[2]));
    else if (/^tee$/i.test(m[1])) write(unq(m[2]));
    else unknown(line);
  };

  // Why: a bare `\!` (mysql `system`, sqlite `.shell` with nothing after it) starts a shell that reads the REST of the client's input: every later line is shell text too
  shellRest = false;
  for (const line of t.split(/\r\n|\r|\n/)) {
    checkDeadline(budget);
    if (shellRest) run(line);
    if (fam === 'psql' || all) psql(line);
    if (fam === 'mysql' || all) mysql(line);
    if (fam === 'sqlite' || all) sqlite(line);
    if (fam === 'mycnf') mycnf(line);
  }
  if (fam === 'sqlite' || all) sqliteSql(t);
  return out.map((x) => x.trim()).filter(Boolean);
}

// ---- the client's command line ---------------------------------------------------------------------------

const ROLE_ENV = /^(?:PAGER|PSQL_PAGER|MYSQL_PAGER|EDITOR|VISUAL|PSQL_EDITOR|PSQL_EDITOR_LINENUMBER_ARG|PSQLRC|PSQL_WATCH_PAGER|SHELL|MYSQL_HOME|SQLITE_HISTORY|PSQL_HISTORY|PGSYSCONFDIR|HOME|XDG_CONFIG_HOME|PGSERVICEFILE)$/;
// Options by client: [name, takes a value, role]. A role: cmd (SQL text run), file (input file), out (output file or |command), log (output file), set (variable),
// pset (print setting), norc, bad (runs something we do not model); no role: harmless.
const O = (s) => s.trim().split(/\s+/).map((x) => { const [n, a, r] = x.split(':'); return [n, a === '1', r || '']; });
const PSQL_LONG = O('command:1:cmd file:1:file output:1:out log-file:1:log set:1:set variable:1:set pset:1:pset dbname:1 host:1 port:1 username:1 field-separator:1 record-separator:1 table-attr:1 no-psqlrc:0:norc list version help echo-all echo-errors echo-queries echo-hidden no-readline quiet single-step single-line no-align csv html tuples-only expanded single-transaction no-password password field-separator-zero record-separator-zero');
const PSQL_SHORT = { c: [1, 'cmd'], f: [1, 'file'], o: [1, 'out'], L: [1, 'log'], v: [1, 'set'], P: [1, 'pset'], d: [1], h: [1], p: [1], U: [1], F: [1], R: [1], T: [1], X: [0, 'norc'], ...Object.fromEntries([...'aAbeEHlnqsStVwWxz01?'].map((c) => [c, [0]])) };
const MYSQL_LONG = O('execute:1:cmd tee:1:out pager:2:bad init-command:1:bad defaults-file:1:bad defaults-extra-file:1:bad login-path:1:bad no-defaults:0:norc database:1 host:1 user:1 port:1 socket:1 protocol:1 default-character-set:1 delimiter:1 prompt:1 password:2 connect-timeout:1 max-allowed-packet:1 max-join-size:1 net-buffer-length:1 select-limit:1 histignore:1 ssl-mode:1 ssl-ca:1 ssl-cert:1 ssl-key:1 character-sets-dir:1 default-auth:1 plugin-dir:1 server-public-key-path:1 local-infile:2 debug:2 auto-rehash auto-vertical-output batch binary-as-hex binary-mode column-names column-type-info comments compress connect-expired-password debug-check debug-info enable-cleartext-plugin force help html ignore-spaces line-numbers named-commands no-auto-rehash no-beep no-pager no-tee one-database pipe print-defaults quick raw reconnect safe-updates secure-auth show-warnings sigint-ignore silent skip-column-names skip-line-numbers syslog table unbuffered verbose version vertical wait xml i-am-a-dummy');
const MYSQL_SHORT = { e: [1, 'cmd'], D: [1], h: [1], u: [1], P: [1], S: [1], p: [2], ...Object.fromEntries([...'AbBCEfGHiLnNoqrstTUvVwWXZ?I#'].map((c) => [c, [0]])) };
const SQLITE_OPTS = O('cmd:1:cmd init:1:file separator:1 nullvalue:1 newline:1 vfs:1 maxsize:1 mmap:1 lookaside:2 pagecache:2 heap:1 memtrace append ascii bail batch box column csv echo header noheader help html interactive json line list markdown nofollow quote readonly safe stats table tabs version zip deserialize no-rowid-in-view');

function longMatch(table, name) {
  const exact = table.find((o) => o[0] === name);
  if (exact) return exact;
  const c = table.filter((o) => o[0].startsWith(name));
  return c.length === 1 ? c[0] : null; // (an ambiguous or unknown abbreviation: not modelled)
}

/**
 * The words after a client's name (options, values, SQL text): what it reads and writes, or `modelled: false` when anything is outside the allowlist.
 * @returns {{modelled: boolean, texts: string[], files: string[], writes: string[], pipes: string[], noRc: boolean, init: boolean, positional: string[]}}
 */
export function sqlClientArgv(family, words, env = {}) {
  const r = { modelled: true, texts: [], files: [], writes: [], pipes: [], noRc: false, init: false, positional: [] };
  const bad = () => { r.modelled = false; };
  if (Object.keys(env).some((k) => ROLE_ENV.test(k))) bad();
  const apply = (role, v, name) => {
    if (role === 'cmd') r.texts.push(v);
    else if (role === 'file') { r.files.push(v); if (family === 'sqlite') r.init = true; }
    else if (role === 'out') { if (/^\s*\|/.test(v)) r.pipes.push(v.replace(/^\s*\|/, '')); else if (v) r.writes.push(v); if (family === 'mysql') bad(); }
    else if (role === 'log') { if (v) r.writes.push(v); }
    else if (role === 'set') { if (ROLE_ENV.test(String(v).split('=')[0].trim()) || /^(?:PAGER|EDITOR|SHELL)/i.test(v) || String(v).includes('\\')) bad(); } // (a backslash in a value: psql re-lexes it when interpolated)
    else if (role === 'pset') { if (/^\s*pager/i.test(v)) bad(); }
    else if (role === 'norc') r.noRc = true;
    else if (role === 'bad') bad();
    void name;
  };
  const longs = family === 'psql' ? PSQL_LONG : family === 'mysql' ? MYSQL_LONG : SQLITE_OPTS;
  const shorts = family === 'psql' ? PSQL_SHORT : MYSQL_SHORT;
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { i++; break; }
    if (w.startsWith('--') || (family === 'sqlite' && w.length > 1 && w.startsWith('-'))) {
      const body = w.replace(/^--?/, '');
      const [name, ...eq] = body.split('=');
      const o = longMatch(longs, name);
      // (an unknown or ambiguous abbreviation: its value may still be a file or SQL text)
      if (!o) { bad(); if (eq.length) { r.files.push(eq.join('=')); r.texts.push(eq.join('=')); } continue; }
      let v = eq.length ? eq.join('=') : null;
      if (o[1]) { if (v === null) v = words[++i]; if (v === undefined) { bad(); break; } }
      else if (v !== null && family !== 'mysql') bad();
      if (family === 'sqlite' && o[0] === 'lookaside') i++; // (two values)
      if (family === 'sqlite' && o[0] === 'pagecache') i++;
      apply(o[2], v ?? '', o[0]);
    } else if (w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const s = shorts[w[j]];
        if (!s) { bad(); break; }
        if (s[0] === 2) break; // (mysql -p[password]: the rest of the word)
        if (s[0] === 1) {
          let v = w.slice(j + 1);
          if (v === '') v = words[++i];
          if (v === undefined) { bad(); break; }
          apply(s[1], v, w[j]);
          break;
        }
        apply(s[1], '', w[j]);
      }
    } else r.positional.push(w);
  }
  r.positional.push(...words.slice(i));
  // sqlite3: the first positional is the database, the rest is SQL text (dot commands too)
  if (family === 'sqlite') {
    r.texts.push(...r.positional.slice(1));
    r.positional = r.positional.slice(0, 1);
    if (r.positional[0] && r.positional[0] !== ':memory:' && !/[$`]/.test(r.positional[0])) r.writes.push(r.positional[0]); // (opening a database creates / writes the file)
  }
  return r;
}

// The rc files a client reads before its input (judged like input). `~/.psqlrc` (unless -X), `~/.sqliterc` (unless -init), the mysql option files' pager lines.
export function sqlRcFiles(family, argv) {
  const mk = (fam, files) => files.map((file) => ({ file, family: fam, ...(/[*?]/.test(file) ? { glob: true } : {}) }));
  // psql: the system psqlrc and ~/.psqlrc (+ its version-suffixed names); sqlite3: ~/.sqliterc and the XDG one; mysql: the option files (the login file is read too)
  if (family === 'psql') return argv.noRc ? [] : mk('psql', ['/etc/postgresql-common/psqlrc', '/etc/psqlrc', '/usr/local/etc/psqlrc', '/opt/homebrew/etc/psqlrc', '~/.psqlrc', '~/.psqlrc-*']);
  if (family === 'sqlite') return argv.init ? [] : mk('sqlite', ['~/.sqliterc', '~/.config/sqlite3/sqliterc']);
  if (family === 'mysql') return argv.noRc ? [] : mk('mycnf', ['/etc/my.cnf', '/etc/mysql/my.cnf', '~/.my.cnf', '~/.mylogin.cnf']);
  return [];
}
// A line that names an rc file the client reads (so the line may write it): the rc is unknown
export const SQL_RC_MENTION = /psqlrc|sqliterc|my\.cnf|mylogin\.cnf|PGSYSCONFDIR|XDG_CONFIG_HOME|MYSQL_HOME|\bHOME\s*=/i;

// ---- one plan per client invocation (the direct path and the variable-named path both use it) ----------------

export const sqlUnknownLine = (raw) => `${UNKNOWN} ${clean(raw)}`;
/**
 * What a client invocation does besides reading its stdin: shell lines (escapes, writes, the escapes of -c / -e / positional SQL text), input files to judge
 * (`-f`, `-init`, and every file-like word of a command line outside the allowlist), and the rc files it reads first.
 * @param {string} family psql | mysql | sqlite
 * @param {string[]} words the words after the client's name (a variable-named client: the words its value adds, then the line's)
 * @param {Record<string,string>} env the command's own `NAME=value` prefix
 * @param {((w:string)=>string|null)|null} resolve value of a word that holds `$` (variable-named path), or null
 */
export function sqlClientPlan(family, words, env = {}, resolve = null) {
  const ws = words.map((w) => { const e = resolve && w.includes('$') ? resolve(w) : null; return typeof e === 'string' && e !== '' && !/[$`\s]/.test(e) ? e : w; });
  const a = sqlClientArgv(family, ws, env);
  const lines = [];
  const files = [...a.files].filter((f) => f !== '-');
  if (a.modelled) {
    // (a text that starts with an expansion is only known at run time: it may be any meta-command)
    for (const t of a.texts) lines.push(...(/^\s*["']?[$`]/.test(t) ? [sqlUnknownLine(t)] : sqlShellEscapes(t, { family })));
  } else {
    // outside the allowlist (an unknown option, a pager / editor setting): every word may be a file or SQL text, judged under every table
    for (const w of ws) if (!w.startsWith('-')) { lines.push(...sqlShellEscapes(w, { family: 'any' })); files.push(w); }
    for (const t of a.texts) lines.push(...sqlShellEscapes(t, { family: 'any' }));
  }
  lines.push(...a.pipes);
  for (const w of a.writes) lines.push(`: > ${targetOf(w)}`);
  return { modelled: a.modelled, lines, files, rc: sqlRcFiles(family, a) };
}
