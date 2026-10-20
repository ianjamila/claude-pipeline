// Tiny glob matcher (no dependencies) for hard-stop, test-file and high-risk path lists.
// Why hand-rolled: a wrong match either blocks a safe PR or waves a sensitive one through, so
// the semantics are small, explicit and tested. `**` matches whole segments only; `*` and `?`
// never cross `/` and treat dotfiles like any other file; `[` `]` are literal (no char classes);
// a glob with no `/` is anchored to the whole path, never the basename. Paths and globs are both
// normalised (`\` -> `/`, leading `./`), and a glob's leading `/` goes and trailing `/` means the
// directory, so `./lib/**`, `/lib/**`, `lib/` and `lib\**` all say the same thing. Paths come from
// pull requests and patterns from config, so compile time and match time are both bounded: see the
// caps below and the "atomic" star pieces in chunkSource.

const MAX_WILDCARDS = 16;
const MAX_ALTERNATIVES = 256;

const cache = new Map();

function tooComplex() {
  return new Error('glob too complex');
}

// Repo-relative POSIX form: `\` -> `/`, then drop any leading `./`.
function normalizePath(p) {
  if (typeof p !== 'string') throw new TypeError(`path must be a string, got ${typeof p}`);
  let s = p.replaceAll('\\', '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

// Same, for globs, plus: a leading `/` is dropped (everything is repo-relative) and a trailing `/`
// names a directory, so `lib/payroll/` becomes `lib/payroll/**`.
export function normalizeGlob(g) {
  if (typeof g !== 'string') throw new TypeError(`glob must be a string, got ${typeof g}`);
  let s = g.replaceAll('\\', '/');
  while (s.startsWith('./') || s.startsWith('/')) s = s.slice(s.startsWith('/') ? 1 : 2);
  return s.endsWith('/') ? `${s}**` : s;
}

function escapeChar(c) {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
}

// A run of stars or a `?` is one wildcard token; the cap bounds how much regex a glob can generate.
function checkWildcardCap(glob) {
  if ((glob.match(/\*+|\?/g) ?? []).length > MAX_WILDCARDS) throw tooComplex();
}

// Index of the `}` closing the `{` at `open`, or -1 when the group never closes.
function findClose(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

// Split a brace body on its top-level commas (commas inside nested braces stay put).
function splitAlternatives(body) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(body.slice(from));
  return parts;
}

// Bash-style brace expansion done up front, so every alternative is a complete glob and `**` is
// judged by its real neighbours ("a/{**,x}/b" becomes "a/**/b" and "a/x/b"). A `{` that never
// closes stays literal, and so does a stray `}`. Throws once the result passes MAX_ALTERNATIVES.
function expandBraces(glob, budget = { left: MAX_ALTERNATIVES }) {
  for (let open = glob.indexOf('{'); open !== -1; open = glob.indexOf('{', open + 1)) {
    const close = findClose(glob, open);
    if (close === -1) continue;
    const head = glob.slice(0, open);
    const tail = glob.slice(close + 1);
    return splitAlternatives(glob.slice(open + 1, close)).flatMap((alt) => expandBraces(head + alt + tail, budget));
  }
  if (--budget.left < 0) throw tooComplex();
  return [glob];
}

// Token kinds for a brace-free glob: lit (with .c), any (?), star (* or a non-segment **),
// slash, gs (a whole-segment `**/`, consumes its slash), gsEnd (a trailing whole-segment `**`).
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '*') {
      let j = i;
      while (src[j] === '*') j++;
      const wholeSegment = j - i >= 2 && (i === 0 || src[i - 1] === '/');
      const last = toks[toks.length - 1];
      if (wholeSegment && j === src.length) {
        if (last?.k === 'gs') toks.pop(); // `**/**` is just `**`
        toks.push({ k: 'gsEnd' });
      } else if (wholeSegment && src[j] === '/') {
        j++;
        if (last?.k !== 'gs') toks.push({ k: 'gs' }); // `**/**/` is just `**/`
      } else {
        toks.push({ k: 'star' });
      }
      i = j;
    } else if (c === '?') {
      toks.push({ k: 'any' });
      i++;
    } else if (c === '/') {
      toks.push({ k: 'slash' });
      i++;
    } else {
      toks.push({ k: 'lit', c });
      i++;
    }
  }
  return toks;
}

function fixedSource(toks) {
  return toks.map((t) => (t.k === 'lit' ? escapeChar(t.c) : t.k === 'any' ? '[^/]' : '/')).join('');
}

// Regex source for tokens containing no `**`. A star plus the fixed text up to the next star is one
// "piece". When another star follows, the piece takes the EARLIEST occurrence of its text and never
// gives it back: `(?=(...))\N` is an atomic group. That is sound because the next star can always
// absorb the extra text a later occurrence would have skipped, and (a star never crossing `/`) a
// piece that itself contains `/` can only match in one place anyway. Without it, `*a*a*a*a*b` is
// n^4 backtracking. The last piece is a plain greedy star: it must reach the end, so earliest is wrong.
function chunkSource(toks, ctx) {
  let out = '';
  let i = 0;
  while (i < toks.length) {
    if (toks[i].k !== 'star') {
      out += fixedSource([toks[i]]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < toks.length && toks[j].k !== 'star') j++;
    const fixed = fixedSource(toks.slice(i + 1, j));
    if (j < toks.length) {
      const n = ++ctx.groups;
      out += `(?=([^/]*?${fixed}))(?:\\${n})`;
    } else {
      out += `[^/]*${fixed}`;
    }
    i = j;
  }
  return out;
}

// Regex source for one brace-free glob. `**/` groups split it into chunks. A chunk that is followed
// by another `**` always ends in `/` and spans a fixed number of whole segments, so it too takes
// the earliest segment boundary where it matches, atomically; the next `**` absorbs the rest.
// That keeps `**/a/**/a/**/b` linear instead of one nested loop per `**`. The last chunk stays plain.
function globSource(src, ctx) {
  const chunks = [[]];
  const seps = [];
  for (const t of tokenize(src)) {
    if (t.k === 'gs' || t.k === 'gsEnd') {
      seps.push(t.k);
      chunks.push([]);
    } else {
      chunks[chunks.length - 1].push(t);
    }
  }
  let out = chunkSource(chunks[0], ctx);
  for (let s = 0; s < seps.length; s++) {
    const chunk = chunks[s + 1];
    if (seps[s] === 'gsEnd') {
      out += '.*';
    } else if (s === seps.length - 1) {
      out += `(?:.*/)?${chunkSource(chunk, ctx)}`;
    } else {
      const n = ++ctx.groups;
      out += `(?=((?:.*?/)??${chunkSource(chunk, ctx)}))(?:\\${n})`;
    }
  }
  return out;
}

export function globToRegExp(glob, { nocase = false } = {}) {
  const normalized = normalizeGlob(glob);
  const key = `${nocase ? 'i' : 's'}:${normalized}`;
  let re = cache.get(key);
  if (!re) {
    checkWildcardCap(normalized);
    const ctx = { groups: 0 };
    const body = expandBraces(normalized)
      .map((alt) => globSource(alt, ctx))
      .join('|');
    // `s` lets `.*` cross a newline in an odd filename, so a newline is an ordinary name char
    // everywhere; no `g`/`y` so the cached regex holds no state. `i` only when asked: hard-stop
    // callers pass nocase because over-matching is the safe direction for them.
    re = new RegExp(`^(?:${body})$`, nocase ? 'si' : 's');
    cache.set(key, re);
  }
  return re;
}

export function matchGlob(path, glob, options) {
  return globToRegExp(glob, options).test(normalizePath(path));
}

// Gitignore-style list: entries run in order and the LAST one that matches decides, so a later
// `!x` carves an exception out of an earlier match and a later positive entry can put it back.
export function matchAny(path, globs, options) {
  if (!Array.isArray(globs)) throw new TypeError('globs must be an array');
  const p = normalizePath(path);
  let matched = false;
  for (const entry of globs) {
    if (typeof entry !== 'string') throw new TypeError(`glob must be a string, got ${typeof entry}`);
    const negated = entry.startsWith('!');
    if (globToRegExp(negated ? entry.slice(1) : entry, options).test(p)) matched = !negated;
  }
  return matched;
}
