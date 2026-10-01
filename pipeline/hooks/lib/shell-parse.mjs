// Why: the guard hooks must see EVERY simple command hidden in a compound Bash line (`a && b`, `$(...)`,
// `bash -c '...'`, `sudo env X=1 git ...`). A command missed here is a guard bypass; a command invented
// from quoted text blocks a harmless one. So this lexes like a shell (quotes, escapes, comments, heredocs)
// and recurses into every place a shell would execute text. Best effort, never throws; when a safety cap
// cuts parsing short the returned array carries a non-enumerable `truncated: true` so callers can fail closed.

const MAX_COMMANDS = 500;
const MAX_NEST = 200; // in-place nesting of $( ), ( ), <( ) before we give up on the line
const MAX_WORK = 8_000_000; // total characters lexed across all recursive parses
const HARD_MAX_DEPTH = 50;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'esac', 'coproc']);
const PS_ENV_RE = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(=?)([\s\S]*)$/i;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const ANSI_C = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

const isSpace = (c) => c === ' ' || c === '\t' || c === '\r';
const base = (w) => String(w).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');

function setEnv(env, key, value) {
  // defineProperty so a variable literally named __proto__ is recorded instead of poisoning the prototype
  Object.defineProperty(env, key, { value, enumerable: true, writable: true, configurable: true });
}

// A leading NAME=value word is an assignment only when the `NAME=` part was written unquoted.
function assignOf(w) {
  const m = ASSIGN_RE.exec(w.text);
  if (!m || (w.qa >= 0 && m[0].length > w.qa)) return null;
  return [m[1], w.text.slice(m[0].length)];
}

// Decodes the body of $'...' (ANSI-C quoting). `i` is the index of the opening quote.
function readAnsiC(s, i) {
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "'") return { text: out, next: j + 1 };
    if (c === '\\' && j + 1 < s.length) {
      const nx = s[j + 1];
      if (Object.hasOwn(ANSI_C, nx)) { out += ANSI_C[nx]; j += 2; continue; }
      let m = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(j + 1, j + 4));
      if (!m) m = /^u([0-9a-fA-F]{1,4})/.exec(s.slice(j + 1, j + 6));
      if (m) { out += String.fromCharCode(parseInt(m[1], 16)); j += 1 + m[0].length; continue; }
      m = /^([0-7]{1,3})/.exec(s.slice(j + 1, j + 4));
      if (m) { out += String.fromCharCode(parseInt(m[1], 8)); j += 1 + m[0].length; continue; }
      out += '\\' + nx;
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  return { text: out, next: s.length };
}

export function splitArgs(str) {
  const s = String(str ?? '');
  const n = s.length;
  const out = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (has) { out.push(cur); cur = ''; has = false; }
      i++;
    } else if (c === "'") {
      has = true;
      const j = s.indexOf("'", i + 1);
      if (j < 0) { cur += s.slice(i + 1); i = n; } else { cur += s.slice(i + 1, j); i = j + 1; }
    } else if (c === '"') {
      has = true;
      i++;
      while (i < n && s[i] !== '"') {
        const nx = s[i + 1];
        if (s[i] === '\\' && (nx === '"' || nx === '\\' || nx === '$' || nx === '`')) { cur += nx; i += 2; }
        else if (s[i] === '\\' && nx === '\n') i += 2;
        else { cur += s[i]; i++; }
      }
      i++; // closing quote (or one past the end when unterminated)
    } else if (c === '$' && s[i + 1] === "'") {
      has = true;
      const r = readAnsiC(s, i + 1);
      cur += r.text;
      i = r.next;
    } else if (c === '\\') {
      if (s[i + 1] === '\n') i += 2;
      else if (i + 1 < n) { has = true; cur += s[i + 1]; i += 2; }
      else i++;
    } else {
      has = true;
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

// ---- wrapper unwrapping -------------------------------------------------------------------------

// Skips option words starting at argv[i]. `shortVal` lists short flag letters that take a value
// (attached or as the next word); `longVal` lists long flags that take a separate value word.
function skipOpts(argv, i, shortVal = '', longVal = []) {
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') return i + 1;
    if (t.length < 2 || t[0] !== '-') return i;
    if (t[1] === '-') {
      i += !t.includes('=') && longVal.includes(t) ? 2 : 1;
      continue;
    }
    let step = 1;
    for (let k = 1; k < t.length; k++) {
      if (shortVal.includes(t[k])) {
        if (k === t.length - 1) step = 2;
        break;
      }
    }
    i += step;
  }
  return i;
}

const rest = (argv, i, env = {}) => (i < argv.length ? { argv: argv.slice(i), env } : null);
const plain = (shortVal, longVal) => (argv) => rest(argv, skipOpts(argv, 1, shortVal, longVal));

function unwrapEnv(argv) {
  let a = argv;
  const env = {};
  let i = 1;
  let optsDone = false;
  while (i < a.length) {
    const t = a[i];
    if (!optsDone && t === '--') { optsDone = true; i++; continue; }
    if (!optsDone && t.startsWith('-') && t.length > 1) {
      if (/^-[A-Za-z]*S/.test(t) || t.startsWith('--split-string')) {
        // -S "git push -f": the string is split into words and becomes the command line
        let str;
        let end = i + 1;
        if (t.startsWith('--split-string=')) str = t.slice('--split-string='.length);
        else if (t === '--split-string' || t === '-S') { str = a[i + 1] ?? ''; end = i + 2; }
        else str = t.slice(t.indexOf('S') + 1);
        a = [...a.slice(0, i), ...splitArgs(str), ...a.slice(end)];
        continue;
      }
      const valued = t === '-u' || t === '-C' || t === '-P' || t === '--unset' || t === '--chdir';
      i += valued ? 2 : 1;
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t);
    if (!kv) break;
    setEnv(env, kv[1], kv[2]);
    i++;
  }
  return rest(a, i, env);
}

function unwrapCommand(argv) {
  let i = 1;
  while (i < argv.length && argv[i].length > 1 && argv[i][0] === '-') {
    if (argv[i] === '--') { i++; break; }
    if (/[vV]/.test(argv[i])) return null; // `command -v git` only looks the command up, it runs nothing
    i++;
  }
  return rest(argv, i);
}

function unwrapSudo(shortVal, longVal) {
  return (argv) => {
    let i = skipOpts(argv, 1, shortVal, longVal);
    const env = {};
    for (; i < argv.length; i++) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(argv[i]);
      if (!kv) break;
      setEnv(env, kv[1], kv[2]);
    }
    return rest(argv, i, env);
  };
}

const WRAPPERS = {
  env: unwrapEnv,
  command: unwrapCommand,
  builtin: plain(),
  exec: plain('a'),
  nohup: plain(),
  setsid: plain(),
  time: plain('fo', ['--format', '--output']),
  nice: plain('n', ['--adjustment']),
  ionice: plain('cnpP', ['--class', '--classdata', '--pid', '--pgid']),
  stdbuf: plain('ioe', ['--input', '--output', '--error']),
  timeout: (argv) => rest(argv, skipOpts(argv, 1, 'sk', ['--signal', '--kill-after']) + 1), // + DURATION
  xargs: plain('IJnPLdEsaRS', ['--arg-file', '--delimiter', '--max-args', '--max-chars', '--max-procs', '--process-slot-var']),
  sudo: unwrapSudo('ugCDhprtTU', ['--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--close-from', '--chroot', '--command-timeout']),
  doas: unwrapSudo('uC', []),
};

function unwrap(argv) {
  const name = base(argv[0]);
  return Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name](argv) : null;
}

// ---- interpreter invocations --------------------------------------------------------------------

// bash -c "script" / bash -lc ... / bash script.sh / bash (reads stdin)
function shellInvocation(argv) {
  let i = 1;
  let sawC = false;
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') { i++; break; }
    if (t.length < 2 || (t[0] !== '-' && t[0] !== '+')) break;
    if (t.startsWith('--')) { i += t === '--rcfile' || t === '--init-file' ? 2 : 1; continue; }
    if (t[0] === '-' && t.includes('c')) sawC = true;
    i += /[oO]$/.test(t) ? 2 : 1; // -o / -O take an option name
  }
  if (i < argv.length) return sawC ? { kind: 'script', text: argv[i] } : { kind: 'file' };
  return sawC ? { kind: 'none' } : { kind: 'stdin' };
}

const PWSH_VALUE_FLAGS = ['executionpolicy', 'windowstyle', 'workingdirectory', 'inputformat', 'outputformat', 'version', 'configurationname', 'settingsfile', 'custompipename'];
const PWSH_VALUE_ALIASES = ['ep', 'w', 'wd', 'if', 'of', 'o', 'v', 'config'];

// pwsh -NoProfile -Command "script" / -c / -EncodedCommand <base64 utf16le> / positional script text
function pwshInvocation(argv) {
  for (let i = 1; i < argv.length; i++) {
    const f = argv[i].toLowerCase();
    if (f[0] !== '-' && f[0] !== '/') return argv.slice(i).join(' ');
    const name = f.replace(/^[-/]+/, '');
    if (name === '') continue;
    if ('command'.startsWith(name)) return argv.slice(i + 1).join(' ');
    if (name === 'ec' || (name[0] === 'e' && 'encodedcommand'.startsWith(name))) {
      try { return Buffer.from(argv[i + 1] ?? '', 'base64').toString('utf16le'); } catch { return null; }
    }
    if ('file'.startsWith(name)) return null;
    if (PWSH_VALUE_ALIASES.includes(name) || (name.length >= 2 && PWSH_VALUE_FLAGS.some((v) => v.startsWith(name)))) i++;
  }
  return null;
}

function cmdInvocation(argv) {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i].toLowerCase();
    if (t === '/c' || t === '/k' || t === '/r') return argv.slice(i + 1).join(' ');
  }
  return null;
}

function findExecs(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i])) continue;
    const sub = [];
    let j = i + 1;
    for (; j < argv.length && argv[j] !== ';' && argv[j] !== '+'; j++) sub.push(argv[j]);
    if (sub.length) out.push(sub);
    i = j;
  }
  return out;
}

// Text a bare `bash` / `sh` (no -c, no script file) would read from stdin: its own heredoc / here-string,
// or what the previous pipeline stage prints (`echo "..." | bash`, `cat <<EOF | sh`).
function stdinTexts(seg) {
  const out = [];
  const add = (x) => {
    for (const h of x.heredocs) out.push(h.text);
    for (const t of x.herestrings) out.push(t);
  };
  add(seg);
  const p = seg.pipedFrom;
  if (!p) return out;
  add(p);
  const pa = p.final ? p.final.argv : [];
  const pn = pa.length ? base(pa[0]) : '';
  if (pn === 'echo') {
    let k = 1;
    let interpret = false;
    while (k < pa.length && /^-[neE]+$/.test(pa[k])) { if (pa[k].includes('e')) interpret = true; k++; }
    const t = pa.slice(k).join(' ');
    out.push(interpret ? t.replace(/\\n/g, '\n') : t);
  } else if (pn === 'printf') {
    for (const a of pa.slice(1)) out.push(a.replace(/\\n/g, '\n'));
  }
  return out;
}

// ---- the parser ---------------------------------------------------------------------------------

function emit(ctx, argv, env, raw, depth) {
  if (ctx.out.length >= MAX_COMMANDS) { ctx.truncated = true; ctx.stopped = true; return; }
  ctx.out.push({ argv, env, raw, depth });
}

class Parser {
  constructor(ctx, src) {
    this.ctx = ctx;
    this.src = src;
    this.i = 0;
    this.queue = []; // finished segments waiting for their heredoc bodies before they are interpreted
    this.hd = []; // heredocs whose bodies start after the current line
    this.lastSeg = null;
    ctx.work += src.length;
    if (ctx.work > MAX_WORK) { ctx.stopped = true; ctx.truncated = true; }
  }

  parseTop(depth) {
    this.parseList(depth, {});
    this.drain(true);
  }

  drain(force) {
    while (this.queue.length && (force || this.queue[0].pending === 0)) this.finalize(this.queue.shift());
  }

  // Parses text found inside this one (backticks, bash -c, eval, ...) as its own script at `depth`.
  subParse(text, depth) {
    const ctx = this.ctx;
    if (depth > ctx.maxDepth) { ctx.truncated = true; return; }
    const p = new Parser(ctx, text);
    try {
      p.parseTop(depth);
    } catch {
      ctx.truncated = true;
      try { p.drain(true); } catch { /* best effort */ }
    }
  }

  // Parses in place (same source string) so quoting and heredocs inside $( ) / ( ) stay correct.
  nestParse(depth, opts) {
    const ctx = this.ctx;
    if (depth > ctx.maxDepth) {
      ctx.truncated = true;
      ctx.muted++;
      try { this.parseList(depth, opts); } finally { ctx.muted--; }
    } else {
      this.parseList(depth, opts);
    }
  }

  // `$(`, `<(` or `>(` at this.i: parse the body as commands, return the original text of the whole construct.
  substitution(depth) {
    const s = this.src;
    const start = this.i;
    this.i += 2;
    this.nestParse(depth + 1, { stopAtParen: true, noRedir: s[start] === '$' && s[this.i] === '(' });
    return s.slice(start, this.i);
  }

  backtick(depth) {
    const s = this.src;
    const n = s.length;
    const start = this.i;
    let body = '';
    this.i++;
    while (this.i < n) {
      const c = s[this.i];
      if (c === '`') { this.i++; break; }
      const nx = s[this.i + 1];
      if (c === '\\' && (nx === '`' || nx === '\\' || nx === '$')) { body += nx; this.i += 2; continue; }
      body += c;
      this.i++;
    }
    this.subParse(body, depth + 1);
    return s.slice(start, this.i);
  }

  // Body of a double-quoted string (this.i is just past the opening quote). Substitutions run inside it.
  readDq(depth) {
    const s = this.src;
    const n = s.length;
    let out = '';
    while (this.i < n && !this.ctx.stopped) {
      const c = s[this.i];
      const nx = s[this.i + 1];
      if (c === '"') { this.i++; return out; }
      if (c === '\\') {
        if (nx === undefined) { out += '\\'; this.i++; }
        else if (nx === '\n') this.i += 2;
        else if (nx === '\r' && s[this.i + 2] === '\n') this.i += 3;
        else if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { out += nx; this.i += 2; }
        else { out += '\\' + nx; this.i += 2; }
      } else if (c === '$' && nx === '(') out += this.substitution(depth);
      else if (c === '`') out += this.backtick(depth);
      else { out += c; this.i++; }
    }
    return out;
  }

  // this.i is at the start of the lines after a command line that opened heredocs: consume the bodies.
  readHeredocs() {
    const s = this.src;
    let pos = this.i;
    for (const h of this.hd) {
      const lines = [];
      let found = false;
      while (pos < s.length) {
        const eol = s.indexOf('\n', pos);
        const end = eol < 0 ? s.length : eol;
        const line = s.slice(pos, end);
        pos = eol < 0 ? s.length : eol + 1;
        let cmp = line.replace(/\r$/, '');
        if (h.strip) cmp = cmp.replace(/^\t+/, '');
        if (cmp === h.delim) { found = true; break; }
        lines.push(line);
      }
      const text = lines.join('\n');
      h.seg.heredocs.push({ text, quoted: h.quoted });
      h.seg.pending--;
      if (h.seg.muted) continue;
      // No terminator: either a malformed command or a `<<` we mistook for a heredoc (e.g. `$[1<<3]`) that then
      // swallowed the rest of the line. Parsing the body as script costs a false positive at worst, never a miss.
      if (!found) this.subParse(text, h.seg.depth + 1);
      // An unquoted heredoc still expands $(...) and backticks, so a body can run commands. Quoted ones are inert data.
      else if (!h.quoted) this.scanExpansions(text, h.seg.depth);
    }
    this.hd = [];
    this.i = pos;
    this.drain(false);
  }

  scanExpansions(text, depth) {
    const p = new Parser(this.ctx, text);
    const n = text.length;
    while (p.i < n && !this.ctx.stopped) {
      const c = text[p.i];
      if (c === '\\') p.i += 2;
      else if (c === '$' && text[p.i + 1] === '(') p.substitution(depth);
      else if (c === '`') p.backtick(depth);
      else p.i++;
    }
    p.drain(true);
  }

  parseList(depth, { stopAtParen = false, noRedir = false }) {
    const ctx = this.ctx;
    if (ctx.nest >= MAX_NEST) { ctx.stopped = true; ctx.truncated = true; this.i = this.src.length; return; }
    ctx.nest++;
    try { this.lex(depth, stopAtParen, noRedir); } finally { ctx.nest--; }
  }

  lex(depth, stopAtParen, noRedir) {
    const ctx = this.ctx;
    const s = this.src;
    const n = s.length;
    const muted = ctx.muted > 0;
    let seg = null;
    let cur = '';
    let inWord = false;
    let qa = -1; // index in `cur` where quoting first appeared (-1: none)
    let redir = null; // pending redirection whose target word comes next: 'file' | 'heredoc' | 'herestring'
    let strip = false;
    let lit = 0; // inside the (...) of NAME=(...) array literals
    let lastSep = ';';

    const startSeg = () => {
      if (!seg) {
        seg = { words: [], heredocs: [], herestrings: [], start: this.i, depth, pending: 0, muted, raw: '', final: null, pipedFrom: lastSep === '|' ? this.lastSeg : null };
      }
    };
    const mark = () => { if (qa < 0) qa = cur.length; inWord = true; };
    const flushWord = () => {
      if (!inWord) return;
      const text = cur;
      const q = qa;
      cur = '';
      inWord = false;
      qa = -1;
      const mode = redir;
      redir = null;
      if (mode === 'file') return;
      if (mode === 'herestring') { seg.herestrings.push(text); return; }
      if (mode === 'heredoc') {
        seg.pending++;
        this.hd.push({ delim: text, strip, quoted: q >= 0, seg });
        return;
      }
      seg.words.push({ text, qa: q });
    };
    const endSeg = (idx) => {
      flushWord();
      redir = null;
      lit = 0; // an unclosed NAME=( must not keep swallowing whitespace after a real operator
      if (!seg) return;
      seg.raw = s.slice(seg.start, Math.min(idx, n)).trim();
      this.queue.push(seg);
      this.lastSeg = seg;
      seg = null;
      this.drain(false);
    };

    while (this.i < n && !ctx.stopped) {
      const c = s[this.i];
      if (lit > 0 && (isSpace(c) || c === '\n')) { cur += ' '; this.i++; continue; }
      if (lit > 0 && (c === '(' || c === ')')) { lit += c === '(' ? 1 : -1; cur += c; this.i++; continue; }

      if (isSpace(c)) {
        flushWord();
        this.i++;
      } else if (c === '\n') {
        const had = !!seg || inWord;
        endSeg(this.i);
        if (had) lastSep = ';';
        this.i++;
        if (this.hd.length) this.readHeredocs();
      } else if (c === '#' && !inWord) {
        while (this.i < n && s[this.i] !== '\n') this.i++;
      } else if (c === '\\') {
        const nx = s[this.i + 1];
        if (nx === '\n') this.i += 2;
        else if (nx === '\r' && s[this.i + 2] === '\n') this.i += 3;
        else if (nx === undefined) this.i++;
        else { startSeg(); mark(); cur += nx; this.i += 2; }
      } else if (c === "'") {
        startSeg(); mark();
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) { cur += s.slice(this.i + 1); this.i = n; } else { cur += s.slice(this.i + 1, j); this.i = j + 1; }
      } else if (c === '"') {
        startSeg(); mark();
        this.i++;
        cur += this.readDq(depth);
      } else if (c === '`') {
        startSeg(); inWord = true;
        cur += this.backtick(depth);
      } else if (c === '$') {
        startSeg();
        const nx = s[this.i + 1];
        if (nx === '(') { inWord = true; cur += this.substitution(depth); }
        else if (nx === "'") { mark(); const r = readAnsiC(s, this.i + 1); cur += r.text; this.i = r.next; }
        else if (nx === '"') { mark(); this.i += 2; cur += this.readDq(depth); }
        else { inWord = true; cur += '$'; this.i++; }
      } else if (c === ';') {
        endSeg(this.i);
        lastSep = ';';
        this.i++;
      } else if (c === '&') {
        const nx = s[this.i + 1];
        if (nx === '&') { endSeg(this.i); lastSep = '&&'; this.i += 2; }
        else if (nx === '>' && !noRedir) { flushWord(); startSeg(); redir = 'file'; this.i += s[this.i + 2] === '>' ? 3 : 2; }
        else { endSeg(this.i); lastSep = ';'; this.i++; }
      } else if (c === '|') {
        const nx = s[this.i + 1];
        endSeg(this.i);
        if (nx === '|') { lastSep = '||'; this.i += 2; }
        else if (nx === '&') { lastSep = '|'; this.i += 2; }
        else { lastSep = '|'; this.i++; }
      } else if ((c === '<' || c === '>') && !noRedir) {
        if (s[this.i + 1] === '(') {
          startSeg(); inWord = true;
          cur += this.substitution(depth);
        } else {
          // an all-digit unquoted word glued to the operator is the fd number (2>&1), not an argument
          if (inWord && qa < 0 && /^[0-9]+$/.test(cur)) { cur = ''; inWord = false; } else flushWord();
          startSeg();
          let j = this.i + 1;
          if (c === '>') {
            if (s[j] === '>' || s[j] === '&' || s[j] === '|') j++;
            redir = 'file';
          } else if (s[j] === '<') {
            if (s[j + 1] === '<') { j += 2; redir = 'herestring'; }
            else { j++; strip = s[j] === '-'; if (strip) j++; redir = 'heredoc'; }
          } else {
            if (s[j] === '&' || s[j] === '>') j++;
            redir = 'file';
          }
          this.i = j;
        }
      } else if (c === '(') {
        if (inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(cur) && (qa < 0 || qa >= cur.length)) {
          lit = 1; cur += '('; this.i++; // NAME=(a b) array literal, not a subshell
        } else {
          endSeg(this.i);
          lastSep = ';';
          this.i++;
          this.nestParse(depth, { stopAtParen: true, noRedir: noRedir || s[this.i] === '(' }); // ((...)) is arithmetic
        }
      } else if (c === ')') {
        endSeg(this.i);
        lastSep = ';';
        this.i++;
        if (stopAtParen) return;
      } else {
        startSeg();
        inWord = true;
        cur += c;
        this.i++;
      }
    }
    endSeg(n);
  }

  // Interprets one finished simple command: strip keywords/assignments/wrappers, emit it, recurse into interpreters.
  finalize(seg) {
    if (seg.muted) return;
    // A standalone `{` or `}` word starts/ends a group (bash `{ a; }`, PowerShell `ForEach-Object { a }`), so it
    // splits the segment: the words around it are separate commands.
    const groups = [];
    let group = [];
    for (const w of seg.words) {
      if (w.qa < 0 && (w.text === '{' || w.text === '}')) {
        if (group.length) groups.push(group);
        group = [];
      } else group.push(w);
    }
    if (group.length) groups.push(group);
    seg.final = { argv: [] };
    for (const g of groups) this.finalizeGroup(g, seg);
  }

  finalizeGroup(words, seg) {
    let i = 0;
    for (;;) {
      const w = words[i];
      if (!w || w.qa >= 0) break;
      if (KEYWORDS.has(w.text)) i++;
      else if (w.text === 'function' && i + 1 < words.length) i += 2;
      else break;
    }
    const env = {};
    // PowerShell: `$env:NAME = "v"` / `$env:NAME="v"` sets an environment variable
    const ps = i < words.length ? PS_ENV_RE.exec(words[i].text) : null;
    const nextEq = ps && ps[2] === '' && words[i + 1] && words[i + 1].text.startsWith('=') ? words[i + 1].text : null;
    if (ps && (ps[2] === '=' || nextEq)) {
      let value = ps[3];
      if (nextEq) value = nextEq.length > 1 ? nextEq.slice(1) : (words[i + 2]?.text ?? '');
      else if (value === '') value = words[i + 1]?.text ?? '';
      setEnv(env, ps[1], value);
      emit(this.ctx, [], env, seg.raw, seg.depth);
      return;
    }
    for (; i < words.length; i++) {
      const a = assignOf(words[i]);
      if (!a) break;
      setEnv(env, a[0], a[1]);
    }
    if (i >= words.length) {
      if (Object.keys(env).length) emit(this.ctx, [], env, seg.raw, seg.depth);
      return;
    }
    this.process(words.slice(i).map((w) => w.text), env, seg, false);
  }

  process(argv, env, seg, isExec) {
    let a = argv;
    for (let guard = 0; guard < 32 && a.length; guard++) {
      const un = unwrap(a);
      if (!un) break;
      for (const k of Object.keys(un.env)) setEnv(env, k, un.env[k]);
      a = un.argv;
    }
    emit(this.ctx, a, env, seg.raw, seg.depth);
    if (!isExec) seg.final = { argv: a };
    this.interpret(a, seg);
  }

  interpret(argv, seg) {
    if (!argv.length) return;
    const name = base(argv[0]);
    const depth = seg.depth + 1;
    if (SHELLS.has(name)) {
      const r = shellInvocation(argv);
      if (r.kind === 'script') this.subParse(r.text, depth);
      else if (r.kind === 'stdin') for (const t of stdinTexts(seg)) this.subParse(t, depth);
    } else if (name === 'eval') {
      if (argv.length > 1) this.subParse(argv.slice(1).join(' '), depth);
    } else if (name === 'trap') {
      // trap 'script' SIGNAL...: the first word runs as a script when the signal fires
      let k = 1;
      while (k < argv.length && (argv[k] === '-l' || argv[k] === '-p' || argv[k] === '--')) k++;
      if (argv.length - k >= 2 && argv[k] !== '-') this.subParse(argv[k], depth);
    } else if (name === 'pwsh' || name === 'powershell') {
      const text = pwshInvocation(argv);
      if (text) this.subParse(text, depth);
    } else if (name === 'cmd') {
      const text = cmdInvocation(argv);
      if (text) this.subParse(text, depth);
    } else if (name === 'find') {
      for (const sub of findExecs(argv)) this.process(sub, {}, seg, true);
    }
  }
}

export function simpleCommands(str, opts) {
  const requested = Number.isFinite(opts?.maxDepth) ? Math.trunc(opts.maxDepth) : 5;
  const ctx = { out: [], maxDepth: Math.min(Math.max(requested, 0), HARD_MAX_DEPTH), truncated: false, stopped: false, muted: 0, nest: 0, work: 0 };
  let parser = null;
  try {
    parser = new Parser(ctx, String(str ?? ''));
    parser.parseTop(0);
  } catch {
    ctx.truncated = true;
    try { parser?.drain(true); } catch { /* best effort */ }
  }
  Object.defineProperty(ctx.out, 'truncated', { value: ctx.truncated, enumerable: false });
  return ctx.out;
}
