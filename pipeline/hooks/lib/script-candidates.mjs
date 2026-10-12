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

// Thrown when a limit above is hit; each policy's entry point turns it into a denial carrying the message.
export class GuardLimit extends Error {}

// One per top-level evaluation, shared through every nested call. `now` is injectable so tests do not depend on timing.
export function newEvalBudget(now = Date.now) {
  // startupOk: startup files already judged in a given state (see the policies), so a line with many shells reads ~/.zshenv once, not once each
  return { now, deadline: now() + EVAL_DEADLINE_MS, scripts: MAX_SCRIPT_JUDGMENTS, grown: 0, startupOk: new Set() };
}

export function checkDeadline(budget) {
  if (budget.now() > budget.deadline) throw new GuardLimit('the check took too long (a script chain or a command line too large to verify in time), so it cannot be verified. Split it into simpler commands or name the script file.');
}

// A script file is about to be judged: one unit of the shared budget.
export function countScript(budget) {
  checkDeadline(budget);
  if (--budget.scripts < 0) throw new GuardLimit('too many script files to check (scripts that run scripts that run scripts ...), so what they run cannot be verified. Name the script file.');
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

function buildCandidates(sf, { expand, dirs, joinPath, readDir, ifs }) {
  const files = new Set();
  const budget = { work: 0, steps: 0, over: false };
  let dynamic = false;
  if (sf.unresolvable) return { files: [], dynamic, over: true };
  const ifsUnknown = typeof ifs === 'string' && /[$`]/.test(ifs);
  const splitter = new RegExp(`[\\s${typeof ifs === 'string' && !ifsUnknown ? ifs.replace(/[\]\\^-]/g, '\\$&') : ''}]+`);
  const add = (c) => { if (!sf.needExt || SCRIPT_EXT.test(c)) files.add(c); };
  for (const w of sf.words) {
    // zsh EQUALS: `=tool` is the file `tool` resolves to in a PATH directory (sf.pathValues: the values PATH may have; none given: unknown).
    // An empty PATH entry is the cwd; a directory known only at run time makes the script unknown.
    if (isEqualsWord(w)) {
      const name = expand(w.slice(1));
      add(w); // (quoting is lost: `'=tool'` is a file of that name)
      if (/[$`]/.test(name)) dynamic = true;
      else {
        add(name);
        if (!sf.pathValues) dynamic = true;
        for (const v of sf.pathValues ?? []) {
          for (const comp of v.split(':')) {
            if (/^\$\{?PATH\}?$/.test(comp) || comp === '') continue;
            const dir = expand(comp);
            if (/[$`]/.test(dir)) dynamic = true;
            else add(`${dir.replace(/\/+$/, '')}/${name}`);
          }
        }
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
