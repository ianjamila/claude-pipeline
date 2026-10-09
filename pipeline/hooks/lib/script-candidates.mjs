// Why: `bash $X f.sh`, `source $X`, `node $X f.mjs`: when a word before the script (or the script itself) expands at
// run time, the guard cannot tell which word the shell will run, so it must not conclude "no file runs". The two
// policies share this list of every word that could be the script: each word from argv[1] on, as written; for a word
// with a known variable also its expanded value, whole and split on whitespace (an unquoted expansion splits); and
// for a glob, the existing files it matches. Each policy then judges the files like any other script.
// Pure apart from the injected `readDir` (fs.readdirSync-like: names; null when the shell would match nothing there
// either; any other answer means the directory could not be listed and is refused).
import { readdirSync } from 'node:fs';
import { SCRIPT_EXT } from './shell-parse.mjs';

export const MAX_CANDIDATES = 32; // more words than this are refused, not judged
// Candidate scripts judged across one whole evaluation (each may be ambiguous itself, so the work multiplies with every
// nesting level; a hook that runs out of time is allowed through, so the guard must give up first and deny).
export const MAX_CANDIDATE_JUDGMENTS = 64;
const MAX_GLOB_WORK = 5000; // directory entries looked at across one command
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

// Index of the `]` closing the bracket expression that opens at seg[k], or -1 (then the `[` is an ordinary character).
// POSIX: after `[` (and one optional `!` or `^`) a `]` is a member, not the end: `[!]x]` is "any char but ] or x".
function bracketEnd(seg, k) {
  let j = k + 1;
  if (seg[j] === '!' || seg[j] === '^') j++;
  if (seg[j] === ']') j++;
  return seg.indexOf(']', j);
}

// Names matching one glob segment (`*`, `?`, `[a-z]`, `[!x]`). Case-insensitive and dotfiles included whatever the
// shell's nocaseglob / dotglob / GLOB_DOTS settings: a candidate too many only costs a judgment. A bracket expression
// becomes "any one character": its exact members (ranges, classes, negation, locale collation) can never under-match.
function segmentRegExp(seg) {
  let re = '';
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[' && bracketEnd(seg, k) > 0) {
      re += '[^/]';
      k = bracketEnd(seg, k);
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
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
    if (seg.includes('**')) { budget.over = true; return; }
    if (!GLOB_CHARS.test(seg)) { walk(i + 1, add(pre, seg)); return; }
    const names = readDir(joinPath(dir, pre === '' ? '.' : pre));
    if (names === null) return; // not a directory (or nothing the shell could list): nothing matches
    if (!Array.isArray(names)) { budget.over = true; return; } // could not be listed: refuse
    let re;
    try { re = segmentRegExp(seg); } catch { budget.over = true; return; } // a bracket expression JS rejects
    for (const n of names) {
      if (++budget.work > MAX_GLOB_WORK) { budget.over = true; return; }
      if (re.test(n)) walk(i + 1, add(pre, n));
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
export function scriptCandidates(sf, { expand, dirs, joinPath, readDir, ifs }) {
  const files = new Set();
  const budget = { work: 0, over: false };
  let dynamic = false;
  if (sf.unresolvable) return { files: [], dynamic, over: true };
  const ifsUnknown = typeof ifs === 'string' && /[$`]/.test(ifs);
  const splitter = new RegExp(`[\\s${typeof ifs === 'string' && !ifsUnknown ? ifs.replace(/[\]\\^-]/g, '\\$&') : ''}]+`);
  const add = (c) => { if (!sf.needExt || SCRIPT_EXT.test(c)) files.add(c); };
  for (const w of sf.words) {
    const e = expand(w);
    const readings = e !== w && w.includes('$') ? [e, ...e.split(splitter)] : [e];
    if (ifsUnknown && w.includes('$')) dynamic = true;
    for (const r of new Set(readings)) {
      if (r === '') continue; // an empty word runs nothing
      if (/[$`]/.test(r)) { dynamic = true; continue; }
      const glob = GLOB_CHARS.test(r);
      if (EXTENDED_GLOB.test(r) || (glob && UNSUPPORTED_GLOB.test(r))) { add(r); budget.over = true; continue; }
      add(r); // an unmatched glob stays a literal word, and a quoted name may merely look like a glob
      if (glob) for (const d of dirs) for (const m of globMatches(r, d, readDir, joinPath, budget)) add(m);
    }
    if (budget.over || files.size > MAX_CANDIDATES) return { files: [], dynamic, over: true };
  }
  return { files: [...files], dynamic, over: false };
}
