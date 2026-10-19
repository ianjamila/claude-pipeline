// Why: `bash $X f.sh`, `source $X`, `node $X f.mjs`: when a word before the script (or the script itself) expands at
// run time, the guard cannot tell which word the shell will run, so it must not conclude "no file runs". The two
// policies share this list of every word that could be the script: each word from argv[1] on, as written; for a word
// with a known variable also its expanded value, whole and split on whitespace (an unquoted expansion splits); and
// for a glob, the existing files it matches. Each policy then judges the files like any other script.
// Pure apart from the injected `readDir` (fs.readdirSync-like: names; null when the shell would match nothing there
// either; any other answer means the directory could not be listed and is refused).
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { SCRIPT_EXT, isEqualsWord } from './shell-parse.mjs';

export const MAX_CANDIDATES = 32; // more words than this are refused, not judged
// Every limit below exists because a hook that runs out of time (15 s, see HOOK_TIMEOUT_S in lib/installer.mjs) is
// ALLOWED by Claude Code, so the guard must give up first and deny.
// Script files read and judged across one whole evaluation: named, candidate and interpreter files alike. A script
// that runs 500 scripts that each run 500 more makes 500^depth judgments, so the work is counted, not just the depth.
// 128: a real chain (verify -> lint, tests, build ...) reads a few dozen scripts at most, and 128 reads of the largest
// judged file (200,000 characters) still finish in a fraction of the deadline below.
export const MAX_SCRIPT_JUDGMENTS = 128;
// Wall-clock limit for one evaluation, measured from the top-level call (nested calls share it): a third of the hook timeout.
export const EVAL_DEADLINE_MS = 5000;
// Variable expansion: one call may add at most one command line of text (the same 200,000 as MAX_LINE_CHARS), and the text
// ADDED by expansion across one evaluation is bounded too (`A=<60k chars> ...` used by thousands of words).
export const MAX_EXPANDED_CHARS = 200_000;
export const MAX_EXPANDED_TOTAL = 1_000_000;

// The command line a program-by-variable word expands to (`T="npx vitest run x"; $T` -> `npx vitest run x`), or null when the word is not one
// or the value is a single word. The shell runs that line, so the policies judge it as text one level deeper.
const PLAIN_LINE = /^[A-Za-z0-9_ \t.\/:=@%+,-]*$/;
export function execLineOf(sf, expand) {
  if (sf.kind !== 'exec' || sf.words?.length !== 1 || !sf.words[0].includes('$')) return null;
  const e = expand(sf.words[0]);
  return e !== sf.words[0] && /\s/.test(e.trim()) && !/\$\(|`/.test(e) ? e : null; // (a value holding a command substitution is unknown: candidates cover it)
}

// Why: `${X:-w}`, `${X-w}`, `${X:=w}`, `${X:+w}` read as the value of X, the word w or nothing, depending on a state the guard does not see: every reading is judged (the value as `${X}`,
// which a policy expands from the variables of the line). `over`: more readings than MAX_READINGS (the caller refuses).
const MAX_READINGS = 32;
// (a parameter is a name, a name[subscript], a digit or a special parameter, optionally indirect: ${1:-w}, ${@:-w}, ${A[0]:-w}, ${!A:-w})
const PARAM_OPEN = /\$\{(!?(?:[A-Za-z_]\w*(?:\[[^\]}]*\])?|\d+|[@*#?$!-]))(:?)([-=+?])/;
export function paramReadings(word) {
  let list = [word];
  let over = false;
  for (let round = 0; round < 16; round++) {
    const next = new Set();
    let changed = false;
    for (const s of list) {
      const m = PARAM_OPEN.exec(s);
      if (!m) { next.add(s); continue; }
      let depth = 1;
      let j = m.index + m[0].length;
      for (; j < s.length && depth; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; }
      const body = depth ? '' : s.slice(m.index + m[0].length, j - 1);
      // Why: a reading is only built when the expansion's extent is certain: the closing brace was found, and the word holds no quote, backslash or half-open $( ) (a brace inside them ends the expansion elsewhere; parentheses on their own are plain characters)
      if (depth || /['"`\\]/.test(body) || (body.includes('$(') && [...body].reduce((n, ch) => n + (ch === '(' ? 1 : ch === ')' ? -1 : 0), 0) !== 0)) { over = true; next.add(s); continue; }
      const pre = s.slice(0, m.index);
      const post = s.slice(j);
      const alts = m[3] === '+' ? [body, ''] : m[3] === '?' ? [`\${${m[1]}}`] : [`\${${m[1]}}`, body, ''];
      for (const x of alts) next.add(pre + x + post);
      changed = true;
    }
    list = [...next];
    if (list.length > MAX_READINGS) { over = true; list = list.slice(0, MAX_READINGS); break; }
    if (!changed) break;
    if (round === 15) over = true;
  }
  return Object.defineProperty(list, 'over', { value: over, enumerable: false });
}

// Why: `bash ${A:--c ./ev.sh}` / `bash ${A:--s} < ev.sh`: a default word in an OPTION position makes the shell read `-c ./ev.sh` or `-s` when A is unset, which no candidate word shows. The command is read again
// with each `${X:-w}` / `${X=w}` / `${X:+w}` replaced by its value (left as `${X}`), w and nothing, as bash does (w split into words) and as zsh does (w one word: wrapped in double quotes), and
// every such line is judged like a literal one. `over`: a reading that cannot be built exactly (a quote, backslash, backtick or `$(` near an expansion, an unclosed brace, more than MAX_READINGS lines).
// An occurrence inside single quotes is no expansion and is left alone.
export function spliceLines(raw) {
  const text = String(raw ?? '');
  let over = false;
  const walk = (s, wrap) => {
    let acc = [''];
    let q = '';
    const lit = (t) => { acc = acc.map((a) => a + t); };
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c === '\\' && q !== "'") { lit(s.slice(i, i + 2)); i += 2; continue; }
      if (q === "'") { if (c === "'") q = ''; lit(c); i++; continue; }
      if (c === "'") { q = "'"; lit(c); i++; continue; }
      if (c === '"') { q = q === '"' ? '' : '"'; lit(c); i++; continue; }
      if (c === '`' || (c === '$' && (s[i + 1] === '(' || s[i + 1] === "'"))) { over = true; lit(c); i++; continue; }
      const m = c === '$' ? PARAM_OPEN.exec(s.slice(i, i + 80)) : null;
      if (!m || m.index !== 0) { lit(c); i++; continue; }
      let depth = 1;
      let j = i + m[0].length;
      for (; j < s.length && depth; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; }
      const body = depth ? '' : s.slice(i + m[0].length, j - 1);
      if (depth || /['"`\\]/.test(body) || body.includes('$(')) { over = true; lit(s.slice(i)); break; }
      const own = `\${${m[1]}}`;
      const inner = walk(body, false);
      const alts = m[3] === '+' ? [...inner, ''] : m[3] === '?' ? [own] : [own, ...inner, ''];
      const words = alts.map((x) => (wrap && q === '' && x !== '' && x !== own ? `"${x}"` : x));
      const next = [];
      for (const a of acc) for (const w of words) next.push(a + w);
      if (next.length > MAX_READINGS) over = true;
      acc = next.slice(0, MAX_READINGS);
      i = j;
    }
    return acc;
  };
  const lines = new Set([...walk(text, false), ...walk(text, true)]);
  lines.delete(text);
  return { lines: [...lines], over };
}

// Why: `: ${X:=w}` / `${X=w}` assigns X for the commands after it, so a later `$X` may be w: the words such an expansion assigns, by name
// (The head is found first and its `}` after it, the first one at or past the head, remembered for the next head: a pattern `([^}]*)\}` scans to the end for every head of a text of
// `${a=${a=${a=…` that never closes, which is quadratic: 12 s at 200 kB. A value over MAX_VALUE_CHARS is the unknown word, which readingsOf refuses like any word that holds `$`.)
const ASSIGNING = /\$\{([A-Za-z_]\w*):?=/g;
export function assigningDefaults(text) {
  const out = new Map();
  const t = String(text ?? '');
  let close = -2;
  for (const m of t.matchAll(ASSIGNING)) {
    const from = m.index + m[0].length;
    if (close !== -1 && close < from) close = t.indexOf('}', from);
    if (close === -1) break; // (no `}` from here on: no later head closes either)
    const v = close - from > MAX_VALUE_CHARS ? UNKNOWN_WORD : t.slice(from, close);
    const ws = out.get(m[1]) ?? [];
    if (!ws.includes(v)) ws.push(v);
    out.set(m[1], ws);
  }
  for (const [n, ws] of assignedValues(String(text ?? ''))) out.set(n, [...new Set([...(out.get(n) ?? []), ...ws])]);
  return out;
}

// Why (#81 t8, found by the security pass, on main too): `G=${U:-run.sh}; bash $G`, `F=ok.sh; G=${F/ok/run}; bash $G`, `F=(ok.sh run.sh); bash ${F[1]}` run run.sh while both guards judged a word
// they could not resolve (the value is kept as written, `${U:-run.sh}`, and a script that is only known at run time is let through on a line that names no guarded operation). The value
// of an assignment that holds an expansion with an operator, or is an array, is worked out here into the words the name may hold; readingsOf then reads a later `$G` as each of them,
// like the words a `${X:=w}` assigns (above), so each is judged as a script. The name is `NAME` for a scalar and `NAME[]` for an array (every element is a candidate for any subscript,
// `[@]`, `[*]` or bare use, `+=` and `NAME[i]=` included).
//   - `${U:-w}` `${U-w}` `${U:=w}` `${U=w}` `${U:+w}` `${U+w}` (paramReadings): the value of U, w, or nothing. The value of a name nothing here gives is the environment's, as for any name the line does
//     not set: that reading is left out (a `$G` of it stays a word only known at run time, judged as before).
//   - `${F/pat/rep}` `${F//pat/rep}` `${F#p}` `${F##p}` `${F%p}` `${F%%p}` `${F^^}` `${F,,}` `${F:o:n}` on a name the text gives literal words: worked out for each (a glob `*` `?` in a pattern too). A name nothing here
//     gives is the environment's (left out as above); any other operator on a name the text does give makes the word unknown (`$(?)`: readingsOf refuses it).
export const UNKNOWN_WORD = '$(?)';
// Every limit keeps the scan linear-ish and short: a hook past its deadline is ALLOWED by the host, and a regular expression cannot be interrupted. No regular expression here matches a glob; the
// matcher below counts its steps against one allowance per call, and a pattern, value or line over a cap gives UNKNOWN_WORD (refused when the name is used as a script), never a guess.
const MAX_ASSIGN_WORDS = 32;
const MAX_ASSIGN_ENTRIES = 256; // assignments that hold an expansion or an array
const MAX_PLAIN_ENTRIES = 4096; // all assignments (plain values feed the operators)
const WILD = '*'; // the key that stands for EVERY name: the text had more than the scan follows (readingsOf refuses any word that reads a variable)
const wildcard = () => new Map([[WILD, [UNKNOWN_WORD]]]);
const MAX_VALUE_CHARS = 1024; // one assigned word, scanned
const MAX_OP_VALUE = 512; // a value an operator is applied to
const MAX_PATTERN = 64;
const MAX_STARS = 8;
const MAX_GLOB_TICKS = 200_000;
class Over extends Error {}
// whole-string glob match with `*` and `?` (a linear two-pointer walk with the star backtrack: O(pattern x value)); every step is counted
function globMatch(p, s, work) {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (++work.n > MAX_GLOB_TICKS) throw new Over();
    if (pi < p.length && p[pi] === '*') { star = pi++; mark = si; }
    else if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) { pi++; si++; }
    else if (star >= 0) { pi = star + 1; si = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}
// the value with the operator applied, or undefined (not worked out: the caller makes the word unknown)
function applyOp(v, op, arg, work) {
  if (v.length > MAX_OP_VALUE) return undefined;
  if (op === '^^') return v.toUpperCase();
  if (op === ',,') return v.toLowerCase();
  if (op === '^') return v.slice(0, 1).toUpperCase() + v.slice(1);
  if (op === ',') return v.slice(0, 1).toLowerCase() + v.slice(1);
  if (op === ':') {
    const m = /^\s{0,8}(-?\d{1,6})(?::(\d{1,6}))?$/.exec(arg);
    if (!m) return undefined;
    const off = +m[1] < 0 ? Math.max(0, v.length + +m[1]) : +m[1];
    return m[2] === undefined ? v.slice(off) : v.slice(off, off + +m[2]);
  }
  const cut = op === '/' || op === '//' ? arg.indexOf('/') : -1;
  const pat = cut < 0 ? arg : arg.slice(0, cut);
  if (pat.length > MAX_PATTERN || /[[\\]/.test(pat) || pat.split('*').length - 1 > MAX_STARS) return undefined;
  try {
    if (op === '#' || op === '##' || op === '%' || op === '%%') {
      const idx = [...Array(v.length + 1).keys()];
      if (op === '#' || op === '##') { for (const i of op === '#' ? idx : idx.reverse()) if (globMatch(pat, v.slice(0, i), work)) return v.slice(i); return v; }
      for (const i of op === '%%' ? idx : idx.reverse()) if (globMatch(pat, v.slice(i), work)) return v.slice(0, i);
      return v;
    }
    if (op === '/' || op === '//') {
      const rep = cut < 0 ? '' : arg.slice(cut + 1);
      if (pat === '' || /^[#%]/.test(pat) || /[&\\]/.test(rep)) return undefined;
      let out = '';
      let i = 0;
      while (i < v.length) {
        let hit = -1;
        for (let j = v.length; j > i; j--) if (globMatch(pat, v.slice(i, j), work)) { hit = j; break; } // (the longest match at this place)
        if (hit < 0) { out += v[i++]; continue; }
        out += rep;
        i = hit;
        if (op === '/') { out += v.slice(i); i = v.length; }
      }
      return out;
    }
  } catch (e) { if (e instanceof Over) return undefined; throw e; }
  return undefined;
}
// the index of the `}` that closes the `${` whose `{` is at s[i], or -1 when the text between holds anything the scan cannot follow exactly (a quote, a backslash, a backtick, `$(`, `$'`)
// or the brace never closes: the caller then makes the word unknown
function closeBrace(s, i) {
  let depth = 1;
  for (let j = i + 1; j < s.length && j < i + MAX_VALUE_CHARS; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '\\' || c === '`' || (c === '$' && (s[j + 1] === '(' || s[j + 1] === "'"))) return -1;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}
// one word of the value at s[i...], quotes removed exactly as the shell does for what it follows (single quotes, double quotes without expansions the scan cannot follow, concatenations),
// up to an unquoted blank or `;&|<>` (and `)` inside an array): [word, index after it]; word null when the word holds anything else (a backslash, `$'`, a backtick, `$(`, a brace or quote
// it cannot follow, more than MAX_VALUE_CHARS). A `${…}` is kept as written, its text free of quotes (closeBrace).
function valueWord(s, i, inArray) {
  let w = '';
  const stop = Math.min(s.length, i + MAX_VALUE_CHARS);
  for (; i < stop; i++) {
    const c = s[i];
    if (/\s/.test(c) || ';&|<>'.includes(c) || (c === ')' && inArray) || (c === '(' && !inArray)) return [w, i];
    if (c === '\\' || c === '`' || (c === '$' && (s[i + 1] === '(' || s[i + 1] === "'"))) return [null, i];
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0 || j >= stop) return [null, i]; w += s.slice(i + 1, j); i = j; continue; }
    if (c === '"') {
      for (i++; i < stop && s[i] !== '"'; i++) {
        const d = s[i];
        if (d === '\\' || d === '`' || (d === '$' && (s[i + 1] === '(' || s[i + 1] === "'"))) return [null, i];
        if (d === '$' && s[i + 1] === '{') { const j = closeBrace(s, i + 1); if (j < 0) return [null, i]; w += s.slice(i, j + 1); i = j; continue; }
        w += d;
      }
      if (i >= stop) return [null, i];
      continue;
    }
    if (c === '$' && s[i + 1] === '{') { const j = closeBrace(s, i + 1); if (j < 0) return [null, i]; w += s.slice(i, j + 1); i = j; continue; }
    w += c;
  }
  return i >= s.length ? [w, i] : [null, i];
}
const ASSIGN_AT = /(?<![\w$.\/-])([A-Za-z_]\w{0,63})(?:\[([^\]\n]{0,64})\])?(\+?)=/g;
function assignedValues(text) {
  // cheap, linear test first: an expansion, an array or an element assignment
  if (!(text.includes('${') || text.includes('=(') || /\]\+?=/.test(text))) return new Map();
  if (text.length > 200_000) return wildcard();
  const found = []; // { name, array, words[] } (a word null: unknown)
  let interesting = 0;
  for (const m of text.matchAll(ASSIGN_AT)) {
    if (found.length >= MAX_PLAIN_ENTRIES) return wildcard(); // (a name past the cap would not be followed)
    let i = m.index + m[0].length;
    if (m[2] === undefined && text[i] === '(') {
      const words = [];
      i++;
      let closed = false;
      for (let n = 0; n < 256 && i < text.length; n++) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;
        if (text[i] === ')') { closed = true; break; }
        let [w, j] = valueWord(text, i, true);
        if (j === i && w === '') break;
        if (w !== null) w = w.replace(/^\[[^\]]{0,64}\]=/, '');
        words.push(w);
        if (w === null) break;
        i = j;
      }
      if (!closed && words.at(-1) !== null) words.push(null); // (more elements than read, or no closing parenthesis: the rest is unknown)
      found.push({ name: m[1], array: true, words });
      if (++interesting > MAX_ASSIGN_ENTRIES) return wildcard();
    } else {
      const [w] = valueWord(text, i, false);
      // a word the scan could not follow is unknown when it holds an expansion it was meant to work out (the rest are values this reading never covered)
      if (w === null && !text.slice(i, i + 256).includes('${')) continue;
      found.push({ name: m[1], array: m[2] !== undefined, words: [w] });
      if (w === null || m[2] !== undefined || w.includes('${') || w.includes('$')) if (++interesting > MAX_ASSIGN_ENTRIES) return wildcard();
    }
  }
  if (!found.some((x) => x.array || x.words.some((w) => w === null || w.includes('${')))) return new Map();
  const cand = new Map(); // name -> Set of words (a scalar, or any element of an array)
  const arrays = new Set(found.filter((x) => x.array).map((x) => x.name));
  const opNames = new Set(found.filter((x) => x.array || x.words.some((w) => w === null || (w.includes('${') && !/^\$\{[A-Za-z_]\w*\}$/.test(w)))).map((x) => x.name));
  // a name built from one of these (`B=$A`, `B=x${A}`, `G=$F[2]`) is one of them too, to a fixed point
  for (let changed = true; changed;) {
    changed = false;
    for (const x of found) {
      if (opNames.has(x.name)) continue;
      if (x.words.some((w) => typeof w === 'string' && [...w.matchAll(/\$\{?([A-Za-z_]\w*)/g)].some((r) => opNames.has(r[1])))) { opNames.add(x.name); changed = true; }
    }
  }
  const over = new Set(); // names that had more words than kept
  const add = (k, w) => { const set = cand.get(k) ?? new Set(); if (set.size < MAX_ASSIGN_WORDS * 2) set.add(w); else over.add(k); cand.set(k, set); };
  const work = { n: 0 };
  // the words a `${…}` group stands for (inner = the text between the braces): null = leave the reading out (a value the environment gives)
  const group = (inner) => {
    if (/^\$\{\(%\):-%[xN]\}(?::[aAcefFghlPqQrstuwWx&]){0,6}$/.test(inner)) return null; // (zsh: the path of the running script, like $0: the environment's)
    const NAME = '([A-Za-z_]\\w*|\\d+|[@*])(?:\\[[^\\]]{0,64}\\])?';
    let m = new RegExp(`^${NAME}$`).exec(inner);
    if (m) return cand.has(m[1]) ? [...cand.get(m[1]), ...(over.has(m[1]) ? [UNKNOWN_WORD] : [])] : null; // (a name nothing here gives: the environment's value, left out)
    m = new RegExp(`^${NAME}(\\/\\/?|##?|%%?|\\^\\^?|,,?|:)([\\s\\S]*)$`).exec(inner);
    if (!m) return [UNKNOWN_WORD]; // (an operator or form not worked out -- ${U@Q} ${!U} ${#U} ${(P)U} ${U:#p} ${${U}:-x} -- on any name)
    // (not a substring: a zsh modifier ${0:A:h} on a name nothing here gives is the environment's, as before; any other form, and a modifier on a name the text gives, is unknown)
    if (m[2] === ':' && !/^\s{0,8}-?\d{1,6}(?::\d{1,6})?$/.test(m[3])) return /^[aAcefFghlPqQrstuwWx&]/.test(m[3]) && !cand.has(m[1]) ? null : [UNKNOWN_WORD];
    const subj = cand.get(m[1]);
    if (over.has(m[1])) return [UNKNOWN_WORD];
    if (!subj) return null;
    return [...subj].map((v) => (v === UNKNOWN_WORD ? v : applyOp(v, m[2], m[3], work) ?? UNKNOWN_WORD));
  };
  const resolve = (word) => {
    const pr = paramReadings(word);
    let alts = [...pr];
    const done = new Set(pr.over ? [UNKNOWN_WORD] : []);
    for (let guard = 0; guard < 64 && alts.length; guard++) {
      const next = [];
      for (const a of alts) {
        const at = a.indexOf('${');
        const bare = at < 0 ? /\$([A-Za-z_]\w*)/.exec(a) : null;
        if (at < 0 && !bare) { if (!/[$`]/.test(a) || a.includes(UNKNOWN_WORD)) done.add(a); continue; }
        if (bare) { for (const v of cand.get(bare[1]) ?? []) next.push(a.slice(0, bare.index) + v + a.slice(bare.index + bare[0].length)); continue; }
        const j = closeBrace(a, at + 1);
        if (j < 0) { done.add(UNKNOWN_WORD); continue; }
        for (const v of group(a.slice(at + 2, j)) ?? []) next.push(a.slice(0, at) + v + a.slice(j + 1));
      }
      alts = [...new Set(next)];
      if (alts.length > MAX_ASSIGN_WORDS * 2) { alts = alts.slice(0, MAX_ASSIGN_WORDS * 2); done.add(UNKNOWN_WORD); } // (alternatives dropped: unknown)
    }
    if (alts.length) done.add(UNKNOWN_WORD); // (not settled within the steps allowed)
    return [...done];
  };
  for (let pass = 0; pass < 3; pass++) {
    for (const x of found) {
      for (const w of x.words) {
        if (w === null) { if (opNames.has(x.name)) add(x.name, UNKNOWN_WORD); continue; }
        if (!/[$`]/.test(w)) { add(x.name, w); continue; }
        if (!opNames.has(x.name)) continue;
        for (const r of resolve(w)) add(x.name, r);
      }
    }
  }
  const out = new Map();
  for (const k of opNames) {
    if (!cand.has(k)) continue;
    const ws = [...cand.get(k)];
    // (more words than kept: the kept ones and an unknown word, never a shorter list)
    out.set(arrays.has(k) ? `${k}[]` : k, over.has(k) || ws.length > MAX_ASSIGN_WORDS ? [...ws.slice(0, MAX_ASSIGN_WORDS - 1), UNKNOWN_WORD] : ws);
  }
  return out;
}
// the readings of a word, plus those with a name an assigning expansion may have set replaced by the words it assigns, repeatedly (`: ${A:=./}; : ${B:=f.sh}; bash $A$B`).
// An assigned word that itself holds an expansion (`${X:=${Y:-w}}`, `${X:=$X/f}`) cannot be resolved here: `over`, the caller refuses.
export function readingsOf(word, assigned) {
  const rs = paramReadings(word);
  if (!assigned?.size) return rs;
  const out = new Set(rs);
  let over = rs.over === true;
  const queue = [...rs];
  while (queue.length && !over) {
    const r = queue.shift();
    for (const [key, ws] of assigned) {
      // (an array, `NAME[]`: its elements stand for any use of the name, with a subscript or without)
      const n = key === WILD ? '' : key.endsWith('[]') ? key.slice(0, -2) : key;
      const ref = key === WILD ? '\\$\\{?[A-Za-z_]' : key.endsWith('[]') ? `\\$(?:\\{${n}(?:\\[[^\\]]{0,64}\\])?\\}|${n}(?![A-Za-z0-9_])(?:\\[[^\\]]{0,64}\\])?)` : `\\$(?:\\{${n}\\}|${n}(?![A-Za-z0-9_]))`;
      if (!new RegExp(ref).test(r)) continue;
      for (const w of ws) {
        if (/[$`]/.test(w)) { over = true; break; }
        const nr = r.replace(new RegExp(ref, 'g'), () => w);
        if (out.has(nr)) continue;
        out.add(nr);
        queue.push(nr);
        if (out.size > MAX_READINGS) { over = true; break; }
      }
      if (over) break;
    }
  }
  return Object.defineProperty([...out].slice(0, MAX_READINGS), 'over', { value: over, enumerable: false });
}
// The command lines a program named by a variable or a default word may run, with its arguments (`G=bash; $G ev.sh`, `"${X:-bash}" ev.sh`): the policies judge each as text one level
// deeper. `over` (a non-enumerable property of the list): the readings were cut off or are too many, and the caller refuses.
const quoteWord = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `"${w.replace(/[\\"`]/g, '\\$&')}"`);
export function execLinesOf(sf, expand, assigned) {
  const none = Object.defineProperty([], 'over', { value: false, enumerable: false });
  if (sf.kind !== 'exec' || sf.words?.length !== 1 || !sf.words[0].includes('$')) return none;
  const w0 = sf.words[0];
  const rs = readingsOf(w0, assigned);
  const out = [];
  for (const r of rs) {
    const e = expand(r).trim();
    if (e === '' || e === w0 || e.startsWith('$') || /\$\(|`/.test(e)) continue; // (still unknown: the candidate list covers it)
    out.push([e, ...(sf.args ?? []).map(quoteWord)].join(' '));
  }
  return Object.defineProperty([...new Set(out)], 'over', { value: rs.over === true, enumerable: false });
}

// Thrown when a limit above is hit; each policy's entry point turns it into a denial carrying the message.
export class GuardLimit extends Error {}

// One per top-level evaluation, shared through every nested call. `now` is injectable so tests do not depend on timing.
// Why (#81 security follow-up): the readings of a text (one per word of a loop, one per value of a name assigned twice) are multiplied again for every script it runs: three nested scripts
// that each assign four names twice and loop over eight words were 1024 readings each, 1024^3 in all, and the check ended at the 5 s deadline instead of at once. The readings of a whole
// evaluation, nested scripts included, share this allowance; past it the check is refused (GuardLimit), as for too many script files.
export const MAX_TOTAL_READINGS = 1024;
export function newEvalBudget(now = Date.now) {
  // startupOk: startup files already judged in a given state (see the policies), so a line with many shells reads ~/.zshenv once, not once each
  return { now, deadline: now() + EVAL_DEADLINE_MS, scripts: MAX_SCRIPT_JUDGMENTS, readings: MAX_TOTAL_READINGS, grown: 0, startupOk: new Set() };
}

export function checkDeadline(budget) {
  if (budget.now() > budget.deadline) throw new GuardLimit('the check took too long (a script chain or a command line too large to verify in time), so it cannot be verified. Split it into simpler commands or name the script file.');
}

// A reading of a text is about to be judged: one unit of the shared allowance of readings.
export function countReading(budget) {
  if (--budget.readings < 0) throw new GuardLimit('too many readings to check (loops over many words, or names given several values, in scripts that run scripts ...), so what they run cannot be verified. Name the script file and write the loop words or values out.');
}

// A script file is about to be judged: one unit of the shared budget.
export function countScript(budget) {
  checkDeadline(budget);
  if (--budget.scripts < 0) throw new GuardLimit('too many script files to check (scripts that run scripts that run scripts ...), so what they run cannot be verified. Name the script file.');
}

// Why (#74): zsh applies to an UNBRACED `$NAME` a modifier after `:` (`$B:r`, `:h :t :e :a :A :l :u :q :Q :P :s/…/…/ :&`, the prefixes `:f :F :w :W :g`) and a subscript
// after `[` (`$B[1,6]`); the hook does not know the shell, so a name followed by either is a value only known at run time and is never expanded. `${B}:r` is no
// modifier (the value, then text) and `$H:8080` / `$A:$B` / `$X:done` have no modifier letter after the `:`, so they are worked out as before. (`:p :S :G`
// are not modifiers of a parameter in zsh 5.9, probed. A bash-style `$B:feature/x` IS read by zsh as `:f` + `e` + `ature/x`, so it is a run-time value too.)
// Lookahead for a regex that matches the bare name: put it after the name and after a `(?![A-Za-z0-9_])` (the name takes every letter that follows).
const ZSH_TAIL = '\\[|:[aAcefFghlPqQrstuwWx&]';
export const ZSH_MODIFIED = `(?!${ZSH_TAIL})`;
// The names the texts read with a modifier or a subscript (`$B:r`, `"$B[1,6]"`): the guards' bookkeeping of a name (known value, assigned once) does not hold for
// them, because the word the shell makes of it is not the value; they are treated as a name only known at run time.
export function zshModifiedNames(texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t).matchAll(new RegExp(`\\$(\\w+)(?!\\w)(?=${ZSH_TAIL})`, 'g'))) out.add(m[1]);
  return out;
}

// `text.replace(re, ...)` where `lookup(match, ...groups)` gives the replacement (or the match itself when nothing is known),
// counted as it grows: the text ADDED by one call may not exceed MAX_EXPANDED_CHARS, nor the text added across the evaluation
// MAX_EXPANDED_TOTAL. Growth is counted, never the length of `text` itself: a program file judged as text can be 1 MB. It throws before the oversized string exists (`A=<100k chars>; ... $A$A$A` x 50k refs is gigabytes).
export function substitute(budget, text, re, lookup) {
  let added = 0;
  return text.replace(re, (m, ...groups) => {
    const v = lookup(m, ...groups);
    if (v === m) return m;
    if (v.length > m.length) { added += v.length - m.length; budget.grown += v.length - m.length; }
    if (added > MAX_EXPANDED_CHARS || budget.grown > MAX_EXPANDED_TOTAL) {
      throw new GuardLimit('variables expand to more text than can be checked, so the command cannot be verified. Write the values out or split the command.');
    }
    return v;
  });
}

const MAX_GLOB_WORK = 5000; // directory entries looked at across one command
const MAX_GLOB_STEPS = 200_000; // matcher steps across one command (a name against a segment backtracks)
const MAX_SEGMENT = 256; // a longer glob segment is refused
const GLOB_CHARS = /[*?[]/;
// Syntax we do not resolve: ksh/zsh operators in a glob (`*(a|b)`, `<1-3>`), POSIX classes (`[[:alpha:]]`), and zsh
// extendedglob operators (`^`, `#`, a non-leading `~` that is not `~1`/trailing/`=~`) even without a glob character.
const UNSUPPORTED_GLOB = /[()|]|<\d*-\d*>|\[[:=.]/;
const EXTENDED_GLOB = /[\^#]|[^=]~(?!\d|$)/;

// null: not there, not a directory or not listable by this user (the shell matches nothing there either); false: any
// other failure (too many links, I/O, ...): the glob cannot be resolved, so it is refused.
export const defaultReadDir = (dir) => {
  try { return readdirSync(dir); } catch (e) { return ['ENOENT', 'ENOTDIR', 'EACCES'].includes(e?.code) ? null : false; }
};

// The first bytes of a file the policies refused to read whole (over the 1 MB cap), enough to see a NUL or a shebang. null
// when it is not a readable regular file.
export const HEAD_BYTES = 4096;
export function defaultReadHead(file) {
  let fd = null;
  try {
    if (!statSync(file).isFile()) return null;
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}

// Would the kernel / a shell run a program with this head as a shell script? A binary (NUL) no; an interpreter shebang
// (node, python ...) no, that text is another language; a shell shebang, any other shebang, or none at all (run as sh) yes.
const HEAD_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(\S+)/;
const HEAD_INTERPRETER = /^(?:node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|ruby|perl|php)$/;
export function isShellHead(head) {
  if (head.includes('\u0000')) return false;
  const prog = HEAD_SHEBANG.exec(head)?.[1] ?? '';
  return !HEAD_INTERPRETER.test(prog.split('/').pop());
}

// Does `name` match one glob segment (`*`, `?`, `[a-z]`, `[!x]`)? Dotfiles are included whatever the shell's dotglob /
// GLOB_DOTS settings: a candidate too many only costs a judgment. Every reading below can only match MORE names.
// - Bytes, not UTF-16 units: `?` and a bracket stand for one character (1-4 UTF-8 bytes) or one byte (C locale), so each
//   consumes any of 1 to 4 bytes; `*` any run of bytes. Letters fold case (ASCII bytes; non-ASCII letters by lower-casing
//   both sides, which may change a length, which is why units are not compared).
// - NFC and NFD: macOS lists decomposed names while the typed pattern is usually composed; both are tried, normalised alike.
// - A bracket may close at EVERY `]` after it, or be a literal `[`: the parser has dropped the quoting, so `[q\\]x]` and
//   `[q"]"x]` reach us as `[q]x]` and which `]` closes is unknowable (POSIX closes at the first one after a leading
//   `]`/`!`/`^`).
// Memoised on (segment index, name index), so many brackets cost polynomial time; every step counts against the shared
// budget (`budget.over` is set when it runs out).
function segmentMatches(seg, name, budget) {
  const seen = new Set();
  for (const f of [(x) => x, (x) => x.normalize('NFC'), (x) => x.normalize('NFD')]) {
    for (const g of [(x) => x, (x) => x.toLowerCase()]) {
      const pat = g(f(seg));
      const nm = g(f(name));
      const key = `${pat}\u0000${nm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (bytesMatch(Buffer.from(pat, 'utf8'), Buffer.from(nm, 'utf8'), budget)) return true;
      if (budget.over) return false;
    }
  }
  return false;
}

const foldByte = (b) => (b >= 0x41 && b <= 0x5a ? b + 32 : b);

function bytesMatch(s, n, budget) {
  const dead = new Set();
  const closes = [];
  s.forEach((b, i) => { if (b === 0x5d) closes.push(i); });
  const m = (i, j) => {
    if (budget.over || ++budget.steps > MAX_GLOB_STEPS) { budget.over = true; return false; }
    if (i === s.length) return j === n.length;
    const key = i * (n.length + 1) + j;
    if (dead.has(key)) return false;
    const c = s[i];
    let ok = false;
    if (c === 0x2a) { for (let k = j; k <= n.length && !ok; k++) ok = m(i + 1, k); } // *
    else if (c === 0x3f) { for (let w = 1; w <= 4 && j + w <= n.length && !ok; w++) ok = m(i + 1, j + w); } // ?
    else if (c === 0x5b) { // [
      ok = j < n.length && n[j] === 0x5b && m(i + 1, j + 1);
      for (const q of closes) {
        if (q < i + 2) continue;
        for (let w = 1; w <= 4 && j + w <= n.length && !ok; w++) ok = m(q + 1, j + w);
        if (ok) break;
      }
    } else ok = j < n.length && foldByte(n[j]) === foldByte(c) && m(i + 1, j + 1);
    if (!ok) dead.add(key);
    return ok;
  };
  return m(0, 0);
}

// Existing paths `pattern` matches, written the way the pattern was (`sub/*.sh` -> `sub/a.sh`), relative to `dir`.
// `**` needs a recursive walk: reported as over (the caller refuses) rather than guessed.
function globMatches(pattern, dir, readDir, joinPath, budget) {
  const abs = pattern.startsWith('/');
  const segs = (abs ? pattern.slice(1) : pattern).split('/');
  const out = [];
  const add = (pre, s) => (pre === '' ? s : pre === '/' ? `/${s}` : `${pre}/${s}`);
  const walk = (i, pre) => {
    if (budget.over) return;
    if (i === segs.length) { out.push(pre); return; }
    const seg = segs[i];
    if (seg === '') { walk(i + 1, pre); return; }
    if (seg.includes('**') || seg.length > MAX_SEGMENT) { budget.over = true; return; }
    if (!GLOB_CHARS.test(seg)) { walk(i + 1, add(pre, seg)); return; }
    const names = readDir(joinPath(dir, pre === '' ? '.' : pre));
    if (names === null) return; // not a directory (or nothing the shell could list): nothing matches
    if (!Array.isArray(names)) { budget.over = true; return; } // could not be listed: refuse
    for (const n of names) {
      if (++budget.work > MAX_GLOB_WORK) { budget.over = true; return; }
      if (segmentMatches(seg, n, budget)) walk(i + 1, add(pre, n));
    }
  };
  walk(0, abs ? '/' : '');
  return out;
}

// sf: the {ambiguous, words, needExt, unresolvable} object scriptFileOf returned.
// expand(word): the word with known variables, $HOME and ~ replaced (anything unknown stays as written).
// dirs: the directories the command may run in; joinPath(dir, rel): resolves rel against dir for readDir.
// ifs: the value of IFS when the text assigned it (a string; unknown if it holds `$`/backtick), else undefined. A
// known IFS adds its characters to the whitespace a variable's value is split on; an unknown one makes every word
// with a `$` unjudgeable.
// Returns { files, dynamic, over }: the candidate paths to judge; whether a word still holds `$` or a backtick (so
// the script is only known at run time); whether there were too many candidates (or a glob too big, or syntax we do not
// resolve) to judge.
export function scriptCandidates(sf, deps) {
  // an exception (a directory read that throws, a stack overflow) must not reach the hook: a hook that throws lets the command through
  try { return buildCandidates(sf, deps); } catch { return { files: [], dynamic: false, over: true }; }
}

function buildCandidates(sf, { expand, dirs, joinPath, readDir, ifs, assigned }) {
  const files = new Set();
  const budget = { work: 0, steps: 0, over: false };
  let dynamic = false;
  if (sf.unresolvable) return { files: [], dynamic, over: true };
  const ifsUnknown = typeof ifs === 'string' && /[$`]/.test(ifs);
  const splitter = new RegExp(`[\\s${typeof ifs === 'string' && !ifsUnknown ? ifs.replace(/[\]\\^-]/g, '\\$&') : ''}]+`);
  const add = (c) => { if (!sf.needExt || SCRIPT_EXT.test(c)) files.add(c); };
  const words = [];
  for (const w0 of sf.words ?? []) {
    const rs = readingsOf(w0, assigned);
    if (rs.over) return { files: [], dynamic, over: true };
    words.push(w0, ...rs); // (quoting is lost: the word as written may be a file that is literally named so)
  }
  // the file `name` in each directory PATH may hold (sf.pathValues; none given: unknown). An empty PATH entry is the cwd; a directory known only at run time makes the script unknown.
  const addPathDirs = (name) => {
    if (!sf.pathValues) dynamic = true;
    for (const v of sf.pathValues ?? []) {
      for (const comp of v.split(':')) {
        if (/^\$\{?PATH\}?$/.test(comp) || comp === '') continue;
        const dir = expand(comp);
        if (/[$`]/.test(dir)) dynamic = true;
        else add(`${dir.replace(/\/+$/, '')}/${name}`);
      }
    }
  };
  for (const w of words) {
    if (sf.pathSearch && !isEqualsWord(w) && !w.includes('/')) { const name = expand(w); if (/[$`]/.test(name)) dynamic = true; else addPathDirs(name); } // (`source NAME`: the PATH directories, then the cwd below)
    // zsh EQUALS: `=tool` is the file `tool` resolves to in a PATH directory (sf.pathValues: the values PATH may have; none given: unknown).
    // An empty PATH entry is the cwd; a directory known only at run time makes the script unknown.
    if (isEqualsWord(w)) {
      const name = expand(w.slice(1));
      add(w); // (quoting is lost: `'=tool'` is a file of that name)
      if (/[$`]/.test(name)) dynamic = true;
      else {
        add(name);
        addPathDirs(name);
      }
      if (files.size > MAX_CANDIDATES) return { files: [], dynamic, over: true };
      continue;
    }
    const e = expand(w);
    let readings = e !== w && w.includes('$') ? [e, ...e.split(splitter)] : [e];
    // a program named by a variable (`T="npx vitest run x.test.tsx"; $T`) runs its first word; the rest are its arguments. The policies evaluate the
    // value as the command line it is (see execLineOf), which judges whatever files that line runs
    if (sf.kind === 'exec' && sf.words?.length === 1 && e !== w && w.includes('$')) {
      const parts = e.split(splitter).filter((p) => p !== '');
      // (only for a plain value: with quotes, `#`, `;` ... the shell splits it differently from how it is lexed, so every part stays a candidate)
      if (parts.length > 1 && PLAIN_LINE.test(e) && typeof ifs !== 'string') readings = [e, parts[0]]; // (a custom IFS splits the value elsewhere: every part stays)
    }
    // quoting is lost (`'x$y.sh'` reads as `x$y.sh`): the word as written may be the file's real name, whatever the variable holds
    if (e !== w && w !== '') {
      add(w);
      if (GLOB_CHARS.test(w)) for (const d of dirs) for (const m of globMatches(w, d, readDir, joinPath, budget)) add(m); // 'x$y'*.sh
    }
    if (ifsUnknown && w.includes('$')) dynamic = true;
    for (const r of new Set(readings)) {
      if (r === '') continue; // an empty word runs nothing
      const glob = GLOB_CHARS.test(r);
      // still unknown at run time; but quoting is lost (`'x$y.sh'` reads as `x$y.sh`, `'x$y'*.sh` globs around a literal $),
      // so the word may be a literal file name or glob too. Its other syntax (`$(..)`, `${X#*/}`) is not ours to resolve.
      if (/[$`]/.test(r)) {
        dynamic = true;
        add(r);
        if (glob) for (const d of dirs) for (const m of globMatches(r, d, readDir, joinPath, budget)) add(m);
        continue;
      }
      if (EXTENDED_GLOB.test(r) || (glob && UNSUPPORTED_GLOB.test(r))) { add(r); budget.over = true; continue; }
      add(r); // an unmatched glob stays a literal word, and a quoted name may merely look like a glob (`'x$y'*.sh` globs with a literal $)
      if (glob) for (const d of dirs) for (const m of globMatches(r, d, readDir, joinPath, budget)) add(m);
    }
    if (budget.over || files.size > MAX_CANDIDATES) return { files: [], dynamic, over: true };
  }
  return { files: [...files], dynamic, over: false };
}
