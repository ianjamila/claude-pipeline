// Tiny glob matcher (no dependencies) for hard-stop, test-file and high-risk path lists.
// Why hand-rolled: a wrong match either blocks a safe PR or waves a sensitive one through, so
// the semantics are small, explicit and tested. `**` matches whole segments only; `*` and `?`
// never cross `/` and treat dotfiles like any other file; `[` `]` are literal (no char classes);
// a glob with no `/` is anchored to the whole path, never the basename.

const cache = new Map();

// Repo-relative POSIX form: `\` -> `/`, then drop any leading `./`.
function normalizePath(p) {
  if (typeof p !== 'string') throw new TypeError(`path must be a string, got ${typeof p}`);
  let s = p.replaceAll('\\', '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function escapeChar(c) {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
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
// closes stays literal, and so does a stray `}`.
function expandBraces(glob) {
  for (let open = glob.indexOf('{'); open !== -1; open = glob.indexOf('{', open + 1)) {
    const close = findClose(glob, open);
    if (close === -1) continue;
    const head = glob.slice(0, open);
    const tail = glob.slice(close + 1);
    return splitAlternatives(glob.slice(open + 1, close)).flatMap((alt) => expandBraces(head + alt + tail));
  }
  return [glob];
}

// Translate one brace-free glob to regex source.
function translate(src) {
  let out = '';
  let segStart = true;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '*') {
      let j = i;
      while (src[j] === '*') j++;
      const next = src[j];
      if (j - i >= 2 && segStart && (j === src.length || next === '/')) {
        // Whole-segment `**`: `**/` may match zero segments; a trailing `**` swallows the rest.
        if (next === '/') {
          out += '(?:.*/)?';
          i = j + 1;
        } else {
          out += '.*';
          i = j;
          segStart = false;
        }
      } else {
        out += '[^/]*';
        i = j;
        segStart = false;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
      segStart = false;
    } else if (c === '/') {
      out += '/';
      i++;
      segStart = true;
    } else {
      out += escapeChar(c);
      i++;
      segStart = false;
    }
  }
  return out;
}

export function globToRegExp(glob) {
  if (typeof glob !== 'string') throw new TypeError(`glob must be a string, got ${typeof glob}`);
  let re = cache.get(glob);
  if (!re) {
    // `s` lets `.*` cross newlines in odd filenames; no `g`/`y` so the cached regex holds no state.
    re = new RegExp(`^(?:${expandBraces(glob).map(translate).join('|')})$`, 's');
    cache.set(glob, re);
  }
  return re;
}

export function matchGlob(path, glob) {
  return globToRegExp(glob).test(normalizePath(path));
}

// Gitignore-style list: entries run in order and the LAST one that matches decides, so a later
// `!x` carves an exception out of an earlier match and a later positive entry can put it back.
export function matchAny(path, globs) {
  if (!Array.isArray(globs)) throw new TypeError('globs must be an array');
  const p = normalizePath(path);
  let matched = false;
  for (const entry of globs) {
    if (typeof entry !== 'string') throw new TypeError(`glob must be a string, got ${typeof entry}`);
    const negated = entry.startsWith('!');
    if (globToRegExp(negated ? entry.slice(1) : entry).test(p)) matched = !negated;
  }
  return matched;
}
