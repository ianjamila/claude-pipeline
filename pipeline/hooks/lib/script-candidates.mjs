// Why: `bash $X f.sh`, `source $X`, `node $X f.mjs`: when a word before the script (or the script itself) expands at
// run time, the guard cannot tell which word the shell will run, so it must not conclude "no file runs". The two
// policies share this list of every word that could be the script: each word from argv[1] on, as written; for a word
// with a known variable also its expanded value, whole and split on whitespace (an unquoted expansion splits); and
// for a glob, the existing files it matches. Each policy then judges the files like any other script.
// Pure apart from the injected `readDir` (fs.readdirSync-like: names, or null when not a directory).
import { readdirSync } from 'node:fs';
import { SCRIPT_EXT } from './shell-parse.mjs';

export const MAX_CANDIDATES = 32; // more words than this are refused, not judged
const MAX_GLOB_WORK = 5000; // directory entries looked at across one command
const GLOB_CHARS = /[*?[]/;

export const defaultReadDir = (dir) => {
  try { return readdirSync(dir); } catch { return null; }
};

// Names matching one glob segment (`*`, `?`, `[a-z]`, `[!x]`). A leading dot needs a literal dot in the pattern.
function segmentRegExp(seg) {
  let re = '';
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[' && seg.indexOf(']', k + 2) > 0) {
      const q = seg.indexOf(']', k + 2);
      let body = seg.slice(k + 1, q).replace(/\\/g, '\\\\');
      if (body[0] === '!') body = `^${body.slice(1)}`;
      re += `[${body}]`;
      k = q;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
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
    if (!Array.isArray(names)) return;
    let re;
    try { re = segmentRegExp(seg); } catch { budget.over = true; return; } // a bracket expression JS rejects
    for (const n of names) {
      if (++budget.work > MAX_GLOB_WORK) { budget.over = true; return; }
      if (re.test(n) && (!n.startsWith('.') || seg.startsWith('.'))) walk(i + 1, add(pre, n));
    }
  };
  walk(0, abs ? '/' : '');
  return out;
}

// sf: the {ambiguous, words, needExt} object scriptFileOf returned.
// expand(word): the word with known variables, $HOME and ~ replaced (anything unknown stays as written).
// dirs: the directories the command may run in; joinPath(dir, rel): resolves rel against dir for readDir.
// Returns { files, dynamic, over }: the candidate paths to judge; whether a word still holds `$` or a backtick (so
// the script is only known at run time); whether there were too many candidates (or a glob too big) to judge.
export function scriptCandidates(sf, { expand, dirs, joinPath, readDir }) {
  const files = new Set();
  const budget = { work: 0, over: false };
  let dynamic = false;
  const add = (c) => { if (!sf.needExt || SCRIPT_EXT.test(c)) files.add(c); };
  for (const w of sf.words) {
    const e = expand(w);
    const readings = e !== w && w.includes('$') ? [e, ...e.split(/\s+/)] : [e];
    for (const r of new Set(readings)) {
      if (r === '') continue; // an empty word runs nothing
      if (/[$`]/.test(r)) { dynamic = true; continue; }
      if (!GLOB_CHARS.test(r)) { add(r); continue; }
      for (const d of dirs) for (const m of globMatches(r, d, readDir, joinPath, budget)) add(m);
    }
    if (budget.over || files.size > MAX_CANDIDATES) return { files: [], dynamic, over: true };
  }
  return { files: [...files], dynamic, over: false };
}
