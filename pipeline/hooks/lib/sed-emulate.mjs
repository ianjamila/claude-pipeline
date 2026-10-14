// Why: `sed -i 's/X/sh/' ok.sh` turns the old text of a script into a new one (`git puX origin main` becomes a push), so the line-writes guard could not
// judge a script a line edits in place and refused every `sed -i ...; node x.mjs` as "built from pieces". This module computes the text such an edit leaves, exactly
// or not at all: `applySed({ args, word }, text)` returns every text the edit may leave in the file `word` (GNU and BSD readings of the options, of `\n` / `\t` in a
// replacement, of the missing last newline and of `q` in an in-place edit), or null when the program is not one we emulate exactly (the caller keeps "built from pieces").
// Emulated: s (any delimiter; flags g p I N), d, p, q; line / $ / regex addresses and `a,b` ranges, `!`; BRE / ERE with POSIX classes, intervals, unquantified groups
// and a top-level alternation of literals. Refused: quantified groups, back-references in patterns, \U \L \E \u \l, the empty regex, other commands, `$name` and backticks.
const MAX_TEXT = 256 * 1024; // (bigger files are refused: the regex work grows with them)
const MAX_UNBOUNDED = 3; // (`.*.*.*.*x` backtracks polynomially: refused past this many unbounded quantifiers)
// Why: a JS regex cannot be stopped once it runs, and a hook that outlasts its timeout is allowed: `s/.*a.*b.*c/x/` took 11 s on ONE line of 1,000 characters. Each
// application of a regex is charged its worst case before it runs, L * (L+1)^u * b for a line of L characters (u: unbounded quantifiers, b: the choices the bounded
// ones and an alternation add), and an edit whose charges pass MAX_WORK is not computed (null). Measured worst: ~3 ns per unit, so MAX_WORK is ~0.3 s.
const MAX_WORK = 1e8;
class TooMuchWork extends Error {}
const MAX_INTERVAL = 255;
const NL = '\n';
const NON_ASCII = /[^\x00-\x7f]/;

const POSIX_CLASS = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f' };
const lit = (c) => (/[\\^$.*+?()[\]{}|/-]/.test(c) ? `\\${c}` : c);
const classChar = (c) => (/[\\\][^-]/.test(c) ? `\\${c}` : c);

// A [bracket expression] at src[i] -> { js, next } or null (an escape, an equivalence / collating element, an odd range, no end)
function bracket(src, i) {
  const n = src.length;
  let j = i + 1;
  let neg = false;
  if (src[j] === '^') { neg = true; j++; }
  let items = '';
  let first = true;
  let prevPlain = false;
  let usedClass = false;
  for (; ; first = false) {
    if (j >= n) return null;
    const c = src[j];
    if (c === ']' && !first) break;
    if (c === '\\') return null; // (GNU reads `\n` / `\t` in a bracket, BSD a backslash: not the same expression)
    if (c === '[' && ':.='.includes(src[j + 1] ?? '')) {
      if (src[j + 1] !== ':') return null;
      const end = src.indexOf(':]', j + 2);
      const cls = end < 0 ? undefined : POSIX_CLASS[src.slice(j + 2, end)];
      if (cls === undefined) return null;
      items += cls; j = end + 2; prevPlain = false; usedClass = true;
      continue;
    }
    if (c === '-') {
      if (first || src[j + 1] === ']') items += '\\-';
      else if (!prevPlain || src[j + 1] === '[' || src[j + 1] === '\\') return null; // (a range between plain characters only)
      else items += '-';
      j++; prevPlain = false;
      continue;
    }
    items += classChar(c); j++; prevPlain = true;
  }
  return { js: `[${neg ? '^' : ''}${items}]`, next: j + 1, sens: neg || usedClass };
}

// BRE / ERE -> a JS pattern source, or null: { js, groups }; { invalid } for parentheses that do not pair (every sed rejects the program, whatever it is run on)
function translate(src, ere) {
  const n = src.length;
  let js = '';
  let raw = '';
  let branchLiteral = true;
  const branches = [];
  let groups = 0;
  let depth = 0;
  let unbounded = 0;
  let choices = 1; // (the bounded quantifiers' and the alternation's: the work factor besides the unbounded ones)
  let sens = false; // Why: what `.`, a negated bracket, a class, \w \s \b, an empty match and the I flag stand for depends on the locale (bytes or multibyte characters), JS reads UTF-16: not the same on non-ASCII text
  let atom = 'start'; // start (of a branch) | single (a quantifier may follow) | group | quant | bol | assert
  const put = (s, ch) => { js += s; atom = 'single'; if (ch === undefined) branchLiteral = false; else raw += ch; };
  const quant = (q, isUnbounded) => { if (atom !== 'single') return false; js += q; atom = 'quant'; branchLiteral = false; if (isUnbounded) unbounded++; if (q === '?') choices *= 2; return true; };
  const alt = () => {
    if (depth > 0 || !branchLiteral || raw === '' || groups > 0) return false;
    branches.push({ js, raw });
    js = ''; raw = ''; atom = 'start';
    return true;
  };
  const interval = (i, open, close) => { // at the first character after the opening: -> next index or -1
    const end = src.indexOf(close, i);
    const m = end < 0 ? null : /^(\d+)(?:(,)(\d*))?$/.exec(src.slice(i, end));
    if (!m || atom !== 'single') return -1;
    const lo = Number(m[1]);
    const hi = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : lo;
    if (lo > MAX_INTERVAL || (hi !== Infinity && (hi > MAX_INTERVAL || hi < lo))) return -1;
    js += `{${lo}${m[2] ? ',' : ''}${m[2] && hi !== Infinity ? hi : ''}}`;
    atom = 'quant'; branchLiteral = false;
    if (hi === Infinity) unbounded++;
    else choices *= hi - lo + 1;
    void open;
    return end + close.length;
  };
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === '\\') {
      const e = src[i + 1];
      if (e === undefined) return null;
      i += 2;
      if (!ere && e === '(') { depth++; groups++; js += '('; atom = 'start'; branchLiteral = false; continue; }
      if (!ere && e === ')') { if (depth <= 0) return { invalid: true }; depth--; js += ')'; atom = 'group'; continue; }
      if (!ere && e === '{') { i = interval(i, '\\{', '\\}'); if (i < 0) return null; continue; }
      // Why: GNU reads \| \+ \? \w \W \s \S \b \B \< \> in a BRE as alternation / quantifiers / classes / word edges, BSD reads some of them another way (or not at all): refused
      if (!ere && (e === '|' || e === '+' || e === '?')) return null;
      if ('wWsSbB<>'.includes(e)) return null;
      if (/[0-9]/.test(e)) return null; // (a back-reference)
      if (e === 'n') { put('\\n', NL); continue; }
      if (/[A-Za-z]/.test(e) || e === "'" || e === '`') return null; // (\t, \x41, \cX, \d065 ... are read differently)
      put(lit(e), e);
      continue;
    }
    if (c === '[') { const b = bracket(src, i); if (!b) return null; if (b.sens) sens = true; put(b.js); i = b.next; continue; }
    if (c === '.') { sens = true; put('[\\s\\S]'); i++; continue; }
    if (c === '*') {
      i++;
      if (!ere && (atom === 'start' || atom === 'bol')) { put('\\*', '*'); continue; }
      if (!quant('*', true)) return null;
      continue;
    }
    if (ere && (c === '+' || c === '?')) { i++; if (!quant(c, c === '+')) return null; continue; }
    if (ere && c === '{') { i = interval(i + 1, '{', '}'); if (i < 0) return null; continue; }
    if (ere && c === '(') { i++; depth++; groups++; js += '('; atom = 'start'; branchLiteral = false; continue; }
    if (ere && c === ')') { i++; if (depth <= 0) return null; depth--; js += ')'; atom = 'group'; continue; }
    if (ere && c === '|') { i++; if (!alt()) return null; continue; }
    if (c === '^' && (ere || atom === 'start')) { i++; js += '^'; atom = ere ? 'assert' : 'bol'; branchLiteral = false; continue; }
    if (c === '$' && (ere || i === n - 1 || src.startsWith('\\)', i + 1) || src.startsWith('\\|', i + 1))) { i++; js += '(?![\\s\\S])'; atom = 'assert'; branchLiteral = false; continue; }
    put(lit(c), c); i++;
  }
  if (depth !== 0) return { invalid: true };
  if (unbounded > MAX_UNBOUNDED) return null;
  if (branches.length) {
    if (!branchLiteral || raw === '') return null;
    branches.push({ js, raw });
    js = branches.sort((a, b) => b.raw.length - a.raw.length).map((b) => b.js).join('|'); // (POSIX takes the longest of the alternatives at a place: literals, longest first)
    choices *= branches.length;
  }
  return { js, groups, sens, cost: { u: unbounded, b: choices } };
}

// ---- the program ----------------------------------------------------------------------------------------------------

// the text up to the unescaped delimiter d at prog[i] (after it) -> { text, next } or null; `\d` becomes d. brackets: BSD skips a [bracket expression] first.
function readPart(prog, i, d, regex, brackets) {
  const n = prog.length;
  let text = '';
  while (i < n) {
    const c = prog[i];
    if (c === '\\') {
      if (i + 1 >= n) return null;
      text += prog[i + 1] === d && d !== '\n' ? d : c + prog[i + 1];
      i += 2;
      continue;
    }
    if (brackets && regex && c === '[') {
      let j = i + 1;
      if (prog[j] === '^') j++;
      if (prog[j] === ']') j++;
      while (j < n && prog[j] !== ']') {
        if (prog[j] === '[' && ':.='.includes(prog[j + 1] ?? '')) { const close = prog.indexOf(`${prog[j + 1]}]`, j + 2); j = close < 0 ? j + 1 : close + 2; } else j++;
      }
      if (j >= n) return null;
      text += prog.slice(i, j + 1); i = j + 1;
      continue;
    }
    if (c === d) return { text, next: i + 1 };
    if (c === NL) return null;
    text += c; i++;
  }
  return null;
}
const DELIM_BAD = /[A-Za-z0-9\\\s&]/;
const BRE_SPECIAL = /[.*[\]^$]/;
const ERE_SPECIAL = /[.*[\]^$+?(){}|]/;

// -> [command] or null. A command: { a1, a2, neg, cmd, re?, repl?, flags? }; an address { type: 'line' | 'last' | 're', n?, src?, icase? }
function parseProgram(prog, ere, brackets) {
  const n = prog.length;
  let i = 0;
  const cmds = [];
  const ws = () => { while (i < n && (prog[i] === ' ' || prog[i] === '\t')) i++; };
  const delimOk = (d) => d !== undefined && !DELIM_BAD.test(d) && !(ere ? ERE_SPECIAL : BRE_SPECIAL).test(d);
  const address = () => {
    const c = prog[i];
    if (c >= '0' && c <= '9') { const m = /^\d+/.exec(prog.slice(i)); i += m[0].length; return Number(m[0]) === 0 ? false : { type: 'line', n: Number(m[0]) }; }
    if (c === '$') { i++; return { type: 'last' }; }
    if (c === '/' || c === '\\') {
      const d = c === '\\' ? prog[i + 1] : '/';
      if (c === '\\') { if (!delimOk(d)) return false; i++; }
      i++;
      const r = readPart(prog, i, d, true, brackets);
      if (!r || r.text === '') return false; // (the empty regex means the last one used)
      i = r.next;
      let icase = false;
      for (; prog[i] === 'I' || prog[i] === 'M'; i++) { if (prog[i] === 'M') return false; icase = true; }
      return { type: 're', src: r.text, icase };
    }
    return null; // (no address)
  };
  const end = () => { ws(); if (i >= n) return true; if (prog[i] === ';' || prog[i] === NL) { i++; return true; } return false; };
  while (i < n) {
    const c0 = prog[i];
    if (c0 === ' ' || c0 === '\t' || c0 === NL || c0 === ';' || c0 === '\r') { i++; continue; }
    const c = { a1: null, a2: null, neg: false };
    let a = address();
    if (a === false) return null;
    if (a) {
      c.a1 = a; ws();
      if (prog[i] === ',') {
        i++; ws();
        a = address();
        if (!a) return null; // (a +N / ~N / first~step second address, or none)
        c.a2 = a; ws();
      }
    }
    while (prog[i] === '!' || prog[i] === ' ' || prog[i] === '\t') { if (prog[i] === '!') c.neg = !c.neg; i++; }
    const k = prog[i++];
    if (k === 's') {
      const d = prog[i];
      if (!delimOk(d)) return null;
      const re = readPart(prog, i + 1, d, true, brackets);
      if (!re || re.text === '') return null;
      const rp = readPart(prog, re.next, d, false, brackets);
      if (!rp) return null;
      i = rp.next;
      const flags = { g: false, p: false, icase: false, nth: 1 };
      for (; i < n; i++) {
        const f = prog[i];
        if (f === 'g') flags.g = true; else if (f === 'p') flags.p = true; else if (f === 'i' || f === 'I') flags.icase = true;
        else if (f >= '0' && f <= '9') { const m = /^\d+/.exec(prog.slice(i)); flags.nth = Number(m[0]); i += m[0].length - 1; if (flags.nth === 0) return null; } else break;
      }
      if (!end()) return null;
      Object.assign(c, { cmd: 's', re: re.text, repl: rp.text, flags, delim: d });
    } else if (k === 'd' || k === 'p') {
      if (!end()) return null;
      c.cmd = k;
    } else if (k === 'q') {
      ws(); while (prog[i] >= '0' && prog[i] <= '9') i++; // (the exit code)
      if (!end()) return null;
      c.cmd = 'q';
    } else return null;
    cmds.push(c);
  }
  return cmds;
}

const ERROR = Symbol('sed error'); // (a program every sed rejects, such as a reference to a group the pattern lacks: the files are left as they are)
// the replacement as parts for a dialect: GNU reads `\n` / `\t` as a newline / tab, BSD as the letters
function replacement(raw, delim, dialect, groups) {
  const parts = [];
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '&') { parts.push(s, 0); s = ''; continue; }
    if (c === NL) return null;
    if (c !== '\\') { s += c; continue; }
    const e = raw[++i];
    if (e === undefined) return null;
    if (e >= '0' && e <= '9') { if (Number(e) > groups) return ERROR; parts.push(s, Number(e)); s = ''; } else if (e === 'n') s += dialect === 'gnu' ? NL : 'n';
    else if (e === 't') s += dialect === 'gnu' ? '\t' : 't';
    else if (e === NL) s += NL;
    else if (/[A-Za-z]/.test(e)) return null; // (\U \L \E \u \l, \x41, \cX, \o101, \d065 ...)
    else s += e; // (\\ \& \/ \<delimiter> and any other escaped character)
  }
  parts.push(s);
  void delim;
  return parts;
}

// ---- compile --------------------------------------------------------------------------------------------------------

// does the pattern match the empty string at several places (`x*`)? sed steps over characters there, JS over UTF-16 units
const manyEmpty = (js) => { let n = 0; for (const m of 'ab'.matchAll(new RegExp(js, 'g'))) if (m[0] === '') n++; return n > 1; };
const INVALID = Symbol('invalid regex');
function compile(cmds, ere) {
  const out = [];
  let dialectSensitive = false;
  let hasQ = false;
  let sensitive = false;
  let streamy = false; // (q, a line number, $ or a range: with several files the answer depends on how the sed joins them)
  const addr = (a) => {
    if (!a || a.type !== 're') return a;
    const t = translate(a.src, ere);
    if (t?.invalid) return INVALID;
    if (t !== null && (t.sens || a.icase)) sensitive = true;
    return t === null ? false : { type: 're', re: new RegExp(t.js, a.icase ? 'i' : ''), cost: t.cost };
  };
  for (const c of cmds) {
    const a1 = addr(c.a1);
    const a2 = addr(c.a2);
    if (a1 === INVALID || a2 === INVALID) return { error: true };
    if (a1 === false || a2 === false) return null;
    const k = { a1, a2, neg: c.neg, cmd: c.cmd };
    if (c.cmd === 'q' || c.a2 || (c.a1 && c.a1.type !== 're')) streamy = true;
    if (c.cmd === 'q') hasQ = true;
    if (c.cmd === 's') {
      const t = translate(c.re, ere);
      if (t === null) return null;
      if (t.invalid) return { error: true };
      const gnu = replacement(c.repl, c.delim, 'gnu', t.groups);
      const bsd = replacement(c.repl, c.delim, 'bsd', t.groups);
      if (gnu === ERROR || bsd === ERROR) return { error: true };
      if (gnu === null || bsd === null) return null;
      if (JSON.stringify(gnu) !== JSON.stringify(bsd)) dialectSensitive = true;
      if (t.sens || c.flags.icase || manyEmpty(t.js)) sensitive = true;
      Object.assign(k, { re: new RegExp(t.js, c.flags.icase ? 'gi' : 'g'), repl: { gnu, bsd }, flags: c.flags, cost: t.cost });
    }
    out.push(k);
  }
  return { cmds: out, dialectSensitive, hasQ, sensitive, streamy };
}

// ---- run ------------------------------------------------------------------------------------------------------------

// one application of a regex to a line of `len` characters: its worst case is added to `work` first, and past MAX_WORK it does not run
function charge(work, cost, len) {
  work.n += 1 + len * (len + 1) ** cost.u * cost.b;
  if (work.n > MAX_WORK) throw new TooMuchWork();
}
const test = (a, ps, ln, last, work) => (a.type === 'line' ? ln === a.n : a.type === 'last' ? last : (charge(work, a.cost, ps.length), a.re.test(ps)));
function selected(c, st, ps, ln, last, work) {
  let m;
  if (!c.a1) m = true;
  else if (!c.a2) m = test(c.a1, ps, ln, last, work);
  else if (!st.active) {
    m = test(c.a1, ps, ln, last, work);
    if (m) st.active = c.a2.type === 'line' ? c.a2.n > ln : c.a2.type === 'last' ? !last : true; // (a number at or before this line: just this line)
  } else {
    m = true;
    if (c.a2.type === 'line' ? ln >= c.a2.n : c.a2.type === 'last' ? last : test(c.a2, ps, ln, last, work)) st.active = false;
  }
  return c.neg ? !m : m;
}
// s///: GNU's rules for an empty match (not right after the previous match) and for the Nth / Nth-and-later matches; null: nothing replaced
function substitute(ps, c, dialect, work) {
  charge(work, c.cost, ps.length); // (the searches of one line together scan it once)
  const { re, flags } = c;
  const parts = c.repl[dialect];
  let out = '';
  let copied = 0;
  let search = 0;
  let count = 0;
  let prevEnd = -1;
  let did = false;
  while (search <= ps.length) {
    re.lastIndex = search;
    const m = re.exec(ps);
    if (!m) break;
    const s = m.index;
    const e = s + m[0].length;
    if (e === s && s === prevEnd) { search = s + 1; continue; }
    count++;
    if (count >= flags.nth) {
      out += ps.slice(copied, s);
      for (const p of parts) out += typeof p === 'string' ? p : (m[p] ?? '');
      copied = e; did = true;
      if (!flags.g) break;
    }
    prevEnd = e;
    search = e === s ? e + 1 : e;
  }
  return did ? out + ps.slice(copied) : null;
}
// the lines the program leaves, or null when its regex work would pass MAX_WORK (`work`: { n }, shared by every run of one edit)
function execute(r, quiet, text, dialect, qFull, work) {
  try {
    return run(r, quiet, text, dialect, qFull, work);
  } catch (e) {
    if (e instanceof TooMuchWork) return null;
    throw e;
  }
}
function run(r, quiet, text, dialect, qFull, work) {
  const lines = text === '' ? [] : text.split(NL);
  if (text.endsWith(NL)) lines.pop();
  const out = [];
  const states = r.cmds.map(() => ({ active: false }));
  let ln = 1;
  for (let quit = false; ln <= lines.length && !quit; ln++) {
    let ps = lines[ln - 1];
    const last = ln === lines.length;
    let del = false;
    for (const [k, c] of r.cmds.entries()) {
      if (!selected(c, states[k], ps, ln, last, work)) continue;
      if (c.cmd === 'd') { del = true; break; }
      if (c.cmd === 'q') { quit = true; break; }
      if (c.cmd === 'p') out.push(ps);
      else { const res = substitute(ps, c, dialect, work); if (res !== null) { ps = res; if (c.flags.p) out.push(ps); } }
    }
    if (!del && !quiet) out.push(ps);
    if (quit && qFull) out.push(...lines.slice(ln)); // (GNU -i cuts the file at q; the rest may be kept)
  }
  return out;
}

// ---- the arguments ----------------------------------------------------------------------------------------------------

const LONG = ['quiet', 'silent', 'regexp-extended', 'in-place', 'expression', 'separate', 'unbuffered', 'posix', 'debug', 'follow-symlinks', 'sandbox', 'binary', 'line-length', 'file', 'null-data', 'zero-terminated', 'help', 'version'];
// The one reader of sed's arguments (the programs, the files, the in-place flag and the backup suffix all come from it). `dialect` is the sed reading them: 'gnu' (options anywhere, -i takes an attached suffix
// only), 'posix' (GNU options, but they end at the first operand: POSIXLY_CORRECT) or 'bsd' (options end at the first operand, a bare -i / -I takes the next word as its suffix, -l is a switch, a `--` swallowed as a
// suffix does not end the options). Returns { inPlace, suffixes: [{ value, word }], scripts, scriptFiles, files, values, consumed, opts, quiet, ere, stream, exotic, unknown, bad }:
// `exotic`: an option the emulation does not model (-f -l -z -b -a --posix ...) or that no sed has (a usage error: nothing is edited); `unknown`: a word this reading cannot place (an ambiguous --abbreviation, a
// run-time word where the program or an option goes): the caller treats the sed as possibly editing anything; `bad`: no program (sed stops with a usage error).
export function readSedArgs(args, dialect) {
  const bsd = dialect === 'bsd';
  const r = { dialect, inPlace: false, suffixes: [], scripts: [], scriptFiles: [], files: [], values: [], consumed: new Set(), opts: [], quiet: false, ere: false, follow: false, stream: false, exotic: false, unknown: false, bad: false };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const hits = LONG.filter((x) => nm !== '' && x.startsWith(nm));
      const full = LONG.includes(nm) ? nm : hits.length === 1 ? hits[0] : null;
      // Why: a --name no sed has stops with a usage error and edits nothing (not emulated); an ambiguous abbreviation (--s, --f) may be any candidate
      // (a long option the shell has not finished, `--$O`, may be --in-place=.sh)
      if (full === null) { if (hits.length > 1 || dynamic(a)) r.unknown = true; else r.exotic = true; continue; }
      r.opts.push(a);
      const val = () => (eq > 0 ? a.slice(eq + 1) : (args[++i] ?? ''));
      if (full === 'quiet' || full === 'silent') r.quiet = true;
      else if (full === 'regexp-extended') r.ere = true;
      else if (full === 'follow-symlinks') r.follow = true; // (the edit and its backup go to the link's target)
      else if (full === 'in-place') { r.inPlace = true; r.suffixes.push({ value: eq > 0 ? a.slice(eq + 1) : '', word: false }); } // (optional argument: attached only)
      else if (full === 'expression') { r.scripts.push(val()); r.consumed.add(r.scripts[r.scripts.length - 1]); }
      else if (full === 'file') { r.scriptFiles.push(val()); r.values.push(r.scriptFiles[r.scriptFiles.length - 1]); r.exotic = true; } else if (full === 'line-length') { r.values.push(val()); r.exotic = true; } else if (['posix', 'null-data', 'zero-terminated', 'help', 'version'].includes(full)) r.exotic = true;
    } else if (a.length > 1 && a[0] === '-') {
      r.opts.push(a);
      for (let k = 1; k < a.length; k++) {
        const rest = a.slice(k + 1);
        const ch = a[k];
        if (ch === 'n') r.quiet = true;
        else if (ch === 'E' || ch === 'r') r.ere = true;
        else if (ch === 's' || ch === 'u') continue;
        else if (ch === 'i' || ch === 'I') {
          r.inPlace = true;
          if (ch === 'I') r.stream = true; // (BSD -I: the files are one input stream)
          if (rest !== '') r.suffixes.push({ value: rest, word: false });
          else if (bsd) { // (BSD: the next word is the suffix, whatever it looks like)
            if (i + 1 >= args.length) r.bad = true; else { i++; r.suffixes.push({ value: args[i], word: true }); r.consumed.add(args[i]); }
          } else r.suffixes.push({ value: '', word: false });
          break;
        } else if (ch === 'e') {
          r.scripts.push(rest !== '' ? rest : (args[++i] ?? ''));
          r.consumed.add(r.scripts[r.scripts.length - 1]);
          break;
        } else if (ch === 'f') {
          r.scriptFiles.push(rest !== '' ? rest : (args[++i] ?? ''));
          r.values.push(r.scriptFiles[r.scriptFiles.length - 1]);
          r.exotic = true;
          break;
        } else if (ch === 'l') {
          r.exotic = true; // (-l takes a value in GNU and is a switch in BSD)
          if (!bsd) { r.values.push(rest !== '' ? rest : (args[i + 1] ?? '')); if (rest === '') i++; break; }
        } else if (ch === 'z' || ch === 'b' || ch === 'a') r.exotic = true;
        else if (ch === '$' || ch === '`') r.unknown = true; // (an option letter the shell fills in)
        else r.exotic = true; // (an option no sed has: a usage error)
      }
    } else {
      // Why: a word the shell fills in (`$O`) may be an option (`-i`) wherever options are still read: the first operand for every reading (also after -e), any operand for GNU, which permutes
      if (/^[`$]/.test(a) && dynamic(a)) r.unknown = true;
      if (bsd || dialect === 'posix') { pos.push(...args.slice(i)); break; }
      pos.push(a);
    }
  }
  if (r.unknown) { r.scripts.push(...pos.slice(0, 1)); r.files = pos; return r; } // (a reading that cannot place the words: every one may be a program or a file)
  if (!r.scripts.length && !r.scriptFiles.length) { if (!pos.length) r.bad = true; else { r.scripts.push(pos.shift()); r.consumed.add(r.scripts[0]); } }
  r.files = pos;
  return r;
}
export const sedReadings = (args) => ['gnu', 'posix', 'bsd'].map((d) => readSedArgs(args, d));

const MEMO = new Map();
// $name, ${...}, $(...) and backticks are the shell's, not the program's; $d $p $s $q are sed addresses ($1 $@ $! ... are the shell's) unless the line assigns a variable of that name
const SPECIAL = /\$([dpsq])(?![A-Za-z0-9_])|\$!/g;
// Why: a word the shell has not finished (`$O`, `${n}p`, a backtick) may be any option (`-i`) or program text; an address such as `$d` / `$p` is the sed's own
export const dynamic = (prog) => /[`]|\$[A-Za-z0-9_{(@*#?$!\-[]/.test(prog.replace(SPECIAL, ''));
// Why: in single quotes `$d` / `$!` are the program's, in double quotes the shell turns them into nothing (an unset variable) or a process id, and what is left of the program (`;s/X/sh/`) is another program: every way is a reading
function progVariants(prog, vars) {
  const parts = [];
  const opts = [];
  let last = 0;
  for (const m of prog.matchAll(SPECIAL)) {
    if (m[1] !== undefined && vars.has(m[1])) return null;
    parts.push(prog.slice(last, m.index));
    opts.push(m[0] === '$!' ? [m[0], '', '9999999'] : [m[0], '']);
    last = m.index + m[0].length;
  }
  parts.push(prog.slice(last));
  if (opts.length > 4) return null;
  let outs = [parts[0]];
  for (const [k, o] of opts.entries()) outs = outs.flatMap((s) => o.map((x) => s + x + parts[k + 1]));
  return outs;
}
function prepare(args, vars) {
  const key = args.join('\u0000') + '\u0001' + [...vars].filter((v) => v.length === 1).sort().join('');
  if (MEMO.has(key)) return MEMO.get(key);
  let out = [];
  for (const dialect of ['gnu', 'posix', 'bsd']) {
    const r = readSedArgs(args, dialect);
    // (an option not modelled, a word no reading can place, a script file, no program: not emulated)
    if (r.exotic || r.unknown || r.bad || r.scriptFiles.length) { out = null; break; }
    r.prog = r.scripts.join(NL);
    r.nfiles = r.files.length;
    const progs = dynamic(r.prog) ? null : progVariants(r.prog, vars);
    if (progs === null) { out = null; break; }
    for (const prog of progs) {
      if (!out.some((x) => x.prog === prog && x.ere === r.ere && x.quiet === r.quiet && x.inPlace === r.inPlace && [...x.consumed].join('\u0000') === [...r.consumed].join('\u0000') && [...x.files].join('\u0000') === r.files.join('\u0000'))) out.push({ ...r, prog, files: new Set(r.files), operands: r.files, compiled: undefined });
    }
  }
  if (MEMO.size > 500) MEMO.clear();
  MEMO.set(key, out);
  return out;
}
// the program of one reading, parsed the way GNU and BSD both read it (a different reading of a delimited part is refused) and compiled; null when not emulated
function compiled(r) {
  if (r.compiled !== undefined) return r.compiled;
  const gnu = parseProgram(r.prog, r.ere, false);
  const bsd = parseProgram(r.prog, r.ere, true);
  r.compiled = gnu === null || bsd === null || JSON.stringify(gnu) !== JSON.stringify(bsd) ? null : compile(gnu, r.ere);
  return r.compiled;
}

// L5f: the emulation runs only for an allowlist of plain argv shapes; every other spelling is refused (the callers keep "built from pieces"). Why: each exotic spelling is one more place where
// the emulation and the real sed can read the words differently. Finding what a sed may WRITE (readSedArgs / sedReadings) is a separate job and stays as strict as it was.
// Shape: [-i | -i.SUF | --in-place | --in-place=.SUF (once; a bare -i may be followed by BSD's empty suffix '')] [-E | -r | -n | a bundle of them] [-e PROG]... [PROG] FILE, all words plain.
const PLAIN_WORD = /^[A-Za-z0-9_.\/\\:+@%,=-]+$/; // (a path or suffix: nothing the shell expands, no leading-dash trick below)
const SUFFIX = /^\.[A-Za-z0-9_-]+$/;
export function emulatedShape(args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return false;
  let i = 0;
  let inPlace = 0;
  let hasE = false;
  const progs = [];
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') { inPlace++; if (args[i + 1] === '' && i + 2 < args.length) i++; } // (BSD: -i '' is an empty suffix)
    else if (a === '--in-place') inPlace++;
    else if (a.startsWith('-i.') || a.startsWith('--in-place=.')) { if (!SUFFIX.test(a.startsWith('--') ? a.slice(11) : a.slice(2))) return false; inPlace++; }
    else if (a === '-e') { if (++i >= args.length) return false; hasE = true; progs.push(args[i]); }
    else if (/^-[nEr]+$/.test(a)) continue;
    else if (a.startsWith('-') && a !== '-') return false;
    else break;
  }
  if (inPlace !== 1) return false;
  if (!hasE) { if (i >= args.length) return false; progs.push(args[i++]); }
  if (args.length - i !== 1 || !PLAIN_WORD.test(args[i]) || args[i].startsWith('-')) return false;
  return progs.every((p) => p !== undefined && !/[\0`]/.test(p) && !dynamic(p));
}

// Every text the in-place edit `sed <args>` may leave in the file named by the word `word` when it held `text`, or null (not emulated exactly). A reading in which the word
// is not edited (BSD takes the first word after a bare -i as its suffix) leaves the text as it is.
export function applySed({ args, word, vars = [], posix = false }, text) {
  if (text.length > MAX_TEXT) return null;
  if (posix || process.env.POSIXLY_CORRECT !== undefined || !emulatedShape(args)) return null; // (L5f: anything outside the plain shapes is "built from pieces", as before the emulation)
  const readings = prepare(args, new Set(vars));
  if (readings === null) return null;
  const outs = new Set();
  const work = { n: 0 };
  for (const r of readings) {
    // a reading in which this sed does not edit in place (its -i is an -e value, or an operand) leaves the text as it is
    if (!r.inPlace) { outs.add(text); continue; }
    // Why: a word the reading takes for the program or a suffix is not edited; any other word it does not know as an operand is a differential in the reading: not computed
    if (!r.files.has(word)) { if (r.consumed.has(word)) { outs.add(text); continue; } return null; }
    const c = compiled(r);
    if (c === null) return null;
    if (c.error) { outs.add(text); continue; }
    // Why: several files are one stream for BSD -I (and `q` ends them all), so a line number, $, a range or q means another file's lines; one file is the only case computed
    if (c.cmds.length > 0 && r.nfiles > 1 && (r.stream || c.streamy)) return null;
    // Why: the same file twice (`f f`, `f ./f`, a link) is edited twice: operands must be plain, different names, and the edit is also tried applied a second time
    // (an empty program, GNU's reading of `-i '' 's/a/b/' f`, edits nothing however many names there are)
    const many = r.nfiles > 1;
    // Why: an option or an operand (this one too: `f*` also reaches a backup file another edit of the same sed made) with a $, a glob, a brace or a tilde is whatever the shell makes of it (more words, another option, the same file again): not computed
    if (c.cmds.length > 0 && [...r.opts, ...r.operands].some((x) => /^~|[`$*?[\]{}]/.test(x))) return null;
    if (many && c.cmds.length > 0 && (r.nfiles !== r.files.size || [...r.files].some((x) => /[/\\]|^\.\.?$/.test(x)) || new Set([...r.files].map((x) => x.toLowerCase())).size !== r.files.size)) return null;
    if (c.sensitive && (NON_ASCII.test(text) || NON_ASCII.test(r.prog))) return null;
    if (NON_ASCII.test(r.prog) && r.prog.includes('[')) return null;
    for (const dialect of c.dialectSensitive ? ['gnu', 'bsd'] : ['gnu']) {
      for (const qFull of c.hasQ ? [false, true] : [false]) {
        const lines = execute(c, r.quiet, text, dialect, qFull, work);
        if (lines === null) return null;
        if (many) { const again = execute(c, r.quiet, lines.length ? `${lines.join(NL)}${NL}` : '', dialect, qFull, work); if (again === null) return null; outs.add(again.length ? `${again.join(NL)}${NL}` : ''); } // (an alias of the file among the operands)
        const body = lines.length ? lines.join(NL) : '';
        outs.add(lines.length ? `${body}${NL}` : '');
        if (lines.length && text !== '' && !text.endsWith(NL)) outs.add(body); // (the last line had no newline: GNU keeps it so, BSD adds one)
      }
    }
  }
  return [...outs];
}
