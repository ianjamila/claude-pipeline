// Why: the guard hooks must see EVERY simple command hidden in a compound Bash line (`a && b`, `$(...)`,
// `bash -c '...'`, `sudo env X=1 git ...`). A command missed here is a guard bypass; a command invented
// from quoted text blocks a harmless one. So this lexes like a shell (quotes, escapes, comments, heredocs)
// and recurses into every place a shell would execute text. Best effort, never throws; when a safety cap
// cuts parsing short the returned array carries a non-enumerable `truncated: true`, and when the command that
// runs is only known at run time (`bash -c "$X"`, `$g push`, `curl … | sh`) it carries `dynamic: true`, so callers can fail closed.
// It carries `subshell: true` when the line opens a ( subshell at the top level (its commands keep depth 0, so they look
// like they run in this shell; what they assign or cd is lost).
// Each command is {argv, env, raw, depth, redirects}; redirections are stripped from argv but recorded in `redirects`.
// A shell / source / eval fed script text from files (`bash < f.sh`, `cat f.sh | bash`, `eval "$(cat f.sh)"`) carries them in a
// non-enumerable `feeds`; scriptFeedsOf turns it into script-file records for the callers.

import { sqlShellEscapes, sqlFamilyOf, sqlClientPlan, SQL_CLIENT_NAMES, SQL_RC_MENTION } from './sql-clients.mjs';
const MAX_COMMANDS = 500;
const MAX_NEST = 200; // in-place nesting of $( ), ( ), <( ) before we give up on the line
const MAX_WORK = 8_000_000; // total characters lexed across all recursive parses
const HARD_MAX_DEPTH = 50;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
// the counter (ctx.ctl) each construct kind of ctlOpen raises: in a loop, a function body, an if / case branch
const CTL_COUNTER = { loop: 'loop', fn: 'fn', if: 'cond', case: 'cond', cbrace: 'cond' }; // (cbrace: a { group after && / || / |)
const ctlMarks = (c) => ({ loop: c.loop > 0, fn: c.fn > 0, trap: c.trap > 0, cond: c.cond > 0 });
const LOOP_WORDS = new Set(['while', 'until', 'for', 'select', 'repeat', 'foreach']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'esac', 'coproc']);
// A word right before a ( that opens a subshell, a condition or arithmetic (`if(true)`, `for((i=0;;))`), not a glob qualifier group.
const LEAD_WORDS = new Set([...KEYWORDS, 'for', 'case', 'select', 'in', 'time', 'function', 'foreach', 'switch', 'catch', 'elseif', 'param', 'trap', 'return', 'exit', 'throw']);
// A group on a glob word that holds nothing but qualifier characters (`*(.)`, `*(^/)`, `*(om[1,3])`, `*(N)`) is not also read as a subshell.
const QUALIFIER_ONLY = /^[/.@=*%^,\-[\]\d#qpPrwxARWXsStNDnMTUGEIoOmacLlbY]*$/;
const MAX_QUALIFIER_CODES = 32; // code strings taken from the groups of one word; more than this and the parse is flagged truncated
const MAX_QUALIFIER_CHARS = 65_536; // characters of those code strings, together (each is parsed again); more than this and the parse is flagged truncated
const PS_ENV_RE = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(=?)([\s\S]*)$/i;
const MAX_BRACE_WORK = 20_000; // brace-expansion results across one line; beyond it words stay unexpanded and the parse is flagged truncated
const BRACE_CAP = 64; // results of one brace expression; beyond it we keep the first ones and set `truncated`
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'ksh', 'ksh93', 'mksh', 'pdksh', 'yash', 'rbash', 'fish', 'csh', 'tcsh']);
const TMUX_RUNNERS = new Set(['new-session', 'new', 'new-window', 'neww', 'split-window', 'splitw', 'respawn-pane', 'respawnp', 'respawn-window', 'respawnw', 'run-shell', 'run', 'pipe-pane', 'pipep', 'display-popup', 'popup', 'if-shell', 'if']);
const TMUX_KEY_RE = /^(Enter|Space|Tab|Escape|BSpace|Up|Down|Left|Right|Home|End|PageUp|PageDown|[CMS]-.+|F[0-9]+|KP.+)$/;
const PS_START_VALUED = ['workingdirectory', 'verb', 'windowstyle', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror', 'credential', 'environment'];
const STDIN_FILES = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);
const DYN_AFTER_DOLLAR = /[A-Za-z_{0-9@*#?!$[-]/;
const WIN_PATH_RE = /[^\\]\\[^\\]|^\\\\/; // C:\Git\git.exe, .\git.exe, \\server\share\git.exe
const ANSI_C = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

const isSpace = (c) => c === ' ' || c === '\t' || c === '\r';
// Why: zsh EQUALS expansion: a command word `=git` runs the `git` found on PATH, so it names the same command (`=` alone and `==x` are ordinary words).
const base = (w) => String(w).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '').replace(/^=(?=[^=(~])/, '');

// The name hooks should compare against: basename, lowercased, without .exe/.cmd/.bat/.com.
// Handles /usr/bin/git, C:\Git\bin\Git.EXE and .\git.exe alike.
export function commandName(argv0) {
  return base(argv0 ?? '');
}

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

// keepWin: a backslash before a path-ish character stays (C:\Git\git.exe) instead of acting as an escape.
function splitArgsImpl(str, keepWin) {
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
      else if (keepWin && i + 1 < n && /[A-Za-z0-9._:\\-]/.test(s[i + 1])) { has = true; cur += c + s[i + 1]; i += 2; }
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

export function splitArgs(str) {
  return splitArgsImpl(str, false);
}

// Bash brace expansion of one word. `marks` are the indexes of the `{` `,` `}` characters that were written
// unquoted (quoted, escaped and `${` ones never expand). Returns the words it expands to.
function expandBraces(text, marks) {
  if (marks.length > 400) return { list: [text], over: true }; // would recurse too deep; caller flags truncated
  const mk = new Set(marks);
  let over = false;
  const range = (a, b) => {
    for (let p = a; p < b; p++) {
      if (!(mk.has(p) && text[p] === '{')) continue;
      let depth = 1;
      let q = -1;
      const commas = [];
      for (let j = p + 1; j < b; j++) {
        if (!mk.has(j)) continue;
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { if (--depth === 0) { q = j; break; } }
        else if (text[j] === ',' && depth === 1) commas.push(j);
      }
      if (q < 0 || commas.length === 0) continue; // not a brace expression: `{x}`, unclosed `{`
      const pre = text.slice(a, p);
      const starts = [p + 1, ...commas.map((c) => c + 1)];
      const ends = [...commas, q];
      const post = range(q + 1, b);
      const out = [];
      for (let k = 0; k < starts.length; k++) {
        for (const alt of range(starts[k], ends[k])) {
          for (const tail of post) {
            if (out.length >= BRACE_CAP) { over = true; return out; }
            out.push(pre + alt + tail);
          }
        }
      }
      return out;
    }
    return [text.slice(a, b)];
  };
  const list = range(0, text.length);
  return { list, over };
}

// ---- wrapper unwrapping -------------------------------------------------------------------------

// Skips option words starting at argv[i]. `shortVal` lists short flag letters that take a value
// (attached or as the next word); `longVal` lists long flags that take a separate value word.
// `seen` (optional Set) collects the short letters and long names that were present.
function skipOpts(argv, i, shortVal = '', longVal = [], seen = null) {
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') return i + 1;
    if (t.length < 2 || t[0] !== '-') return i;
    if (t[1] === '-') {
      seen?.add(t.split('=')[0]);
      i += !t.includes('=') && longVal.includes(t) ? 2 : 1;
      continue;
    }
    let step = 1;
    for (let k = 1; k < t.length; k++) {
      seen?.add(t[k]);
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

const shellCmd = (script) => ({ argv: ['sh', '-c', script], env: {} });

function unwrapSudo(shortVal, longVal) {
  return (argv) => {
    const seen = new Set();
    let i = skipOpts(argv, 1, shortVal, longVal, seen);
    const env = {};
    for (; i < argv.length; i++) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(argv[i]);
      if (!kv) break;
      setEnv(env, kv[1], kv[2]);
    }
    if (i >= argv.length) return null;
    // sudo -s / -i 'string': the string runs through a shell (`sh -c`), it is not a program name
    if (seen.has('s') || seen.has('i') || seen.has('--shell') || seen.has('--login')) return { argv: ['sh', '-c', argv.slice(i).join(' ')], env };
    return rest(argv, i, env);
  };
}

// su [-] [user] -c 'string'
function unwrapSu(argv) {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--command') return argv[i + 1] === undefined ? null : shellCmd(argv[i + 1]);
    if (t.startsWith('--command=')) return shellCmd(t.slice('--command='.length));
    if (/^-[A-Za-z]*c$/.test(t)) return argv[i + 1] === undefined ? null : shellCmd(argv[i + 1]);
  }
  return null;
}

// flock [opts] file cmd...  /  flock [opts] file -c 'string'  /  flock -c 'string' file
function unwrapFlock(argv) {
  let i = 1;
  const scan = () => {
    while (i < argv.length) {
      const t = argv[i];
      if (t === '--') { i++; return null; }
      if (t.length < 2 || t[0] !== '-') return null;
      if (t === '--command') { const s = argv[i + 1] ?? ''; i += 2; return s; }
      if (t.startsWith('--command=')) { i++; return t.slice('--command='.length); }
      if (t[1] === '-') { i += !t.includes('=') && ['--timeout', '--wait', '--conflict-exit-code'].includes(t) ? 2 : 1; continue; }
      let step = 1;
      let script = null;
      for (let k = 1; k < t.length; k++) {
        if (t[k] === 'c' && k === t.length - 1) { script = argv[i + 1] ?? ''; step = 2; break; }
        if ('wE'.includes(t[k])) { if (k === t.length - 1) step = 2; break; }
      }
      i += step;
      if (script !== null) return script;
    }
    return null;
  };
  let script = scan();
  if (script !== null) return shellCmd(script);
  i++; // the lock file, directory or fd
  script = scan();
  if (script !== null) return shellCmd(script);
  return rest(argv, i);
}

// macOS: arch [-arch name | -x86_64 | -arm64 | ...] [-d var] [-e var=val] prog args
function unwrapArch(argv) {
  let i = 1;
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') { i++; break; }
    if (t.length < 2 || t[0] !== '-') break;
    i += t === '-arch' || t === '-d' || t === '-e' ? 2 : 1;
  }
  return rest(argv, i);
}

// ssh [opts] host cmd...: the words after the host are a command line the remote shell runs.
function unwrapSsh(argv) {
  const i = skipOpts(argv, 1, 'bcDEeFIiJLlmOopQRSWw');
  const words = argv.slice(i + 1); // argv[i] is the host
  return i < argv.length && words.length ? shellCmd(words.join(' ')) : null;
}

// taskset [-c LIST | MASK] cmd... (-p only changes a running process)
function unwrapTaskset(argv) {
  const seen = new Set();
  let i = skipOpts(argv, 1, 'c', ['--cpu-list'], seen);
  if (seen.has('p') || seen.has('--pid')) return null;
  if (!seen.has('c') && !seen.has('--cpu-list')) i++;
  return rest(argv, i);
}

// script -c 'string' [file]  (util-linux)  /  script [-q] file cmd...  (BSD, macOS)
function unwrapScript(argv) {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--command') return argv[i + 1] === undefined ? null : shellCmd(argv[i + 1]);
    if (t.startsWith('--command=')) return shellCmd(t.slice('--command='.length));
    if (/^-[A-Za-z]*c$/.test(t)) return argv[i + 1] === undefined ? null : shellCmd(argv[i + 1]);
  }
  return rest(argv, skipOpts(argv, 1, 't') + 1); // + the typescript file
}

// screen [opts] cmd args  /  screen -X stuff 'string'
function unwrapScreen(argv) {
  const seen = new Set();
  const i = skipOpts(argv, 1, 'ScsTtpeh', ['--sessionname'], seen);
  if (seen.has('X')) {
    const k = argv.indexOf('stuff', i);
    return k >= 0 && argv[k + 1] !== undefined ? shellCmd(argv[k + 1].replace(/\\[nr]/g, ' ')) : null;
  }
  return rest(argv, i);
}

// GNU parallel [opts] template ::: args  — the template is a shell command line; {} stands for an argument
function unwrapParallel(argv) {
  const i = skipOpts(argv, 1, 'jNnSaIdLmsTEUCwoteqXr', ['--jobs', '--sshlogin', '--arg-file', '--delimiter', '--max-args', '--header', '--colsep']);
  const sep = argv.findIndex((w, k) => k >= i && /^::::?$/.test(w));
  const template = argv.slice(i, sep < 0 ? argv.length : sep);
  if (!template.length) return null;
  const args = sep < 0 ? [] : argv.slice(sep + 1);
  const text = template.join(' ');
  const hasSlot = /\{[^{}\s]*\}/.test(text);
  return shellCmd(!args.length ? text : hasSlot ? text.replace(/\{[^{}\s]*\}/g, args[0]) : `${text} ${args.join(' ')}`);
}

// wsl [-d distro] [-u user] [--cd dir] [-e] cmd...
function unwrapWsl(argv) {
  const i = skipOpts(argv, 1, 'du', ['--distribution', '--user', '--cd', '--exec']);
  if (i >= argv.length) return null;
  return argv.length - i === 1 && /\s/.test(argv[i]) ? shellCmd(argv[i]) : rest(argv, i); // one string goes through the shell
}

// npx / bunx / pnpx [opts] cmd args, `-c 'string'`; npm|pnpm|yarn exec|dlx|x [opts] cmd args
function unwrapPackageRunner(argv, fromIndex) {
  for (let k = fromIndex; k < argv.length; k++) {
    const t = argv[k];
    if (t === '--call' || t === '-c') return argv[k + 1] === undefined ? null : shellCmd(argv[k + 1]);
    if (t.startsWith('--call=')) return shellCmd(t.slice('--call='.length));
  }
  return rest(argv, skipOpts(argv, fromIndex, 'p', ['--package', '--prefix', '--workspace', '--registry', '--cache']));
}
const runnerAt = (subs) => (argv) => (subs.includes(argv[1]) ? unwrapPackageRunner(argv, 2) : null);

const WRAPPERS = {
  env: unwrapEnv,
  unbuffer: plain('', []),
  taskset: unwrapTaskset,
  'sandbox-exec': plain('fpnD'),
  ssh: unwrapSsh,
  script: unwrapScript,
  screen: unwrapScreen,
  parallel: unwrapParallel,
  wsl: unwrapWsl,
  npx: (argv) => unwrapPackageRunner(argv, 1),
  bunx: (argv) => unwrapPackageRunner(argv, 1),
  pnpx: (argv) => unwrapPackageRunner(argv, 1),
  npm: runnerAt(['exec', 'x']),
  pnpm: runnerAt(['exec', 'dlx']),
  yarn: runnerAt(['exec', 'dlx']),
  command: unwrapCommand,
  builtin: plain(),
  noglob: plain(), // (zsh precommand modifiers: `noglob read k` runs read; #56 Fable review of 2edea61)
  nocorrect: plain(),
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
  su: unwrapSu,
  flock: unwrapFlock,
  arch: unwrapArch,
  caffeinate: plain('tw'),
  busybox: plain(),
};

function unwrap(argv) {
  const name = base(argv[0]);
  return Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name](argv) : null;
}

// ---- interpreter invocations --------------------------------------------------------------------

// A word whose value is only known at run time: `$VAR`, `$(..)`, backticks, or a glob (also zsh extendedglob operators
// `^`, `#`, a non-leading `~`, which only act when the user's zshrc sets extendedglob; `~1`, a trailing `~` and `=~` are
// ordinary). It may become no word, one word or several, so it hides which of the words after it is the script.
// (and zsh EQUALS: `=tool` is the PATH lookup of `tool`; `==`, `=(` and `=~` are not)
const EXPANDS = /[$`*?[^#]|[^=]~(?!\d|$)|^=[^=(~]/;
const EQUALS_WORD = /^=[^=(~\s]/;
export const isEqualsWord = (w) => EQUALS_WORD.test(w);
// Why: `source NAME` / `. NAME` without a slash looks NAME up in the PATH directories first, then in the cwd (bash; zsh also searches PATH): the record then lists PATH as places to look
// (only when the line itself sets PATH -- a prefix, `export PATH=...`, `PATH=...; ` -- the hook's own PATH holds the user's tools, not files the line plants)
export function sourcePathSearch(rec, argv, cmds = []) {
  if (!cmds.some((c) => Object.hasOwn(c.env ?? {}, 'PATH') || (c.argv ?? []).some((a) => /^PATH(?:\+?=|\[)/.test(a)))) return false;
  if (!rec || rec.kind !== 'shell' || !['source', '.'].includes(base(argv?.[0] ?? ''))) return false;
  return (rec.words ?? [rec.file]).some((w) => typeof w === 'string' && w !== '' && !w.includes('/'));
}
const hasExpansion = (w) => EXPANDS.test(w);
// A word that is a process substitution: the shell runs a command and reads its output through a /dev/fd path.
// (zsh's `=(cmd)` is the same thing with a temp file)
// (also `${x:-<(cmd)}`: the default word of a parameter expansion holds one)
const isProcSub = (w) => w.startsWith('<(') || w.startsWith('=(') || /^\$\{[^}]*[<>=]\(/.test(w);

// bash -c "script" / bash -lc ... / bash script.sh / bash (reads stdin)
// -s, `-`, /dev/stdin and /dev/fd/0 all mean "read the script from stdin".
// `amb`: a word up to the decision point (the operand, or the `-c` / `-s` that made it a string or stdin) expands, so what
// the shell runs may not be what the words as written say (`bash -o $X -c f.sh`: an empty $X makes -o swallow -c, and f.sh is the script file).
function shellInvocation(argv) {
  let i = 1;
  let sawC = false;
  let sawS = false;
  // Why (#56): `bash -n f.sh` only reads f.sh for syntax errors and runs none of it (noexec). Every shell here has -n: bash/sh/dash/ksh/zsh/yash/csh/fish
  // ("read commands but do not execute them"). Only a plain `-n` in a cluster of short options turns it on; `+n` turns it off again, bash ignores it in an
  // interactive shell (`-i`), and any long option or -o / +o name we do not read (zsh `-o exec`, `--no-exec`) leaves it off.
  let noexec = false;
  let execUnsure = false;
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') { i++; break; }
    if (t.length < 2 || (t[0] !== '-' && t[0] !== '+') || (t[0] === '+' && !/^\+[A-Za-z]/.test(t))) break; // (`+(f|fa).sh` is a pattern operand, not an option)
    if (t.startsWith('--')) { execUnsure = true; i += t === '--rcfile' || t === '--init-file' ? 2 : 1; continue; }
    if (t[0] === '-' && t.includes('c')) sawC = true;
    if (t[0] === '-' && t.includes('s')) sawS = true;
    if (/n/.test(t.slice(1))) noexec = t[0] === '-';
    if (/i/.test(t.slice(1))) execUnsure = true;
    if (/[oO]$/.test(t) && /exec/i.test(argv[i + 1] ?? '')) execUnsure = true;
    i += /[oO]$/.test(t) ? 2 : 1; // -o / -O take an option name
  }
  const before = argv.slice(1, i).some(hasExpansion);
  if (sawC) return i < argv.length ? { kind: 'script', text: argv[i], amb: before } : { kind: 'none' };
  if (sawS) return { kind: 'stdin', amb: before };
  if (i < argv.length) return STDIN_FILES.has(argv[i]) ? { kind: 'stdin', amb: before } : { kind: 'file', text: argv[i], amb: argv.slice(1, i + 1).some(hasExpansion), parseOnly: noexec && !execUnsure && !before };
  return { kind: 'stdin', amb: argv.slice(1).some(hasExpansion) }; // `bash -$X` may be `bash -x f.sh`
}

// ---- script files -------------------------------------------------------------------------------

const INTERPRETER = /^(?:node|nodejs|deno|bun|tsx|ts-node|python\d*(?:\.\d+)*|ruby|perl|php)$/;
export const SCRIPT_EXT = /\.(?:m?[jt]s|cjs|jsx|tsx|py|rb|pl|php|sh|bash|zsh)$/i;
const SYSTEM_BIN = /^(?:\/usr)?(?:\/local)?\/(?:s?bin|libexec)\/|^\/opt\/homebrew\/s?bin\//;
// Flags that make an interpreter run inline code, a module or a test runner instead of a file.
const INLINE_FLAGS = new Set(['-e', '-E', '-p', '-c', '-m', '--eval', '--print', '--check', '--test', '--input-type']);
const INTERP_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '-W', '-X', '-I', '-x', '--env-file', '--title', '--max-old-space-size']);

// Why: a command whose OPTIONS can make it run code (a shell's `-c` / `-s`, `source`, an interpreter, find -exec, sed -e / w, awk, make) and that has a word with a default / alternative
// (`bash ${A:--c ./ev.sh}`): the word may be an option when A is unset, so the policies judge the line again with each reading (see spliceLines).
const SPLICE_HEADS = new Set(['source', '.', 'eval', 'find', 'awk', 'gawk', 'mawk', 'sed', 'gsed', 'make', 'gmake']);
const DEFAULTED_WORD = /\$\{!?(?:[A-Za-z_]\w*(?:\[[^\]}]*\])?|\d+|[@*#?$!-]):?[-=+]/;
export function splicesOptions(argv) {
  if (!argv?.length) return false;
  const name = base(argv[0]);
  return (SHELLS.has(name) || INTERPRETER.test(name) || SPLICE_HEADS.has(name)) && argv.slice(1).some((w) => DEFAULTED_WORD.test(w));
}
// the command's own text; a record without one is rebuilt from its words (a word with an expansion stays bare so it splits)
export const spliceText = (c) => (typeof c.raw === 'string' && c.raw ? c.raw : c.argv.map((w) => (DEFAULTED_WORD.test(w) || /^[\w@%+=:,./-]+$/.test(w) ? w : `"${w.replace(/[\\"`$]/g, '\\$&')}"`)).join(' '));

// The file a command will read and run: `bash f`, `source f`, `. f`, `node f.mjs`, `python f.py`, `./f`.
// {kind:'shell'} is run as a shell script (the caller judges its commands), {kind:'interp'} is program text in
// another language (the caller scans it), {kind:'exec'} is a program run by path (shell or interpreter, from its
// shebang). Null when the command runs no file (`bash -c`, stdin, process substitution, `node -e`, a test runner).
// `ambiguous: true` (shells, source, interpreters; a program run by path whose name expands): a word from argv[1] up to the
// operand expands at run time (`$X f.sh`, `$(..)`, a glob), so `file` is only a guess; `words` (argv[1..]) are the candidates, `needExt` says an interpreter
// only runs a file with a script extension. The caller expands what it can and judges every candidate.
// `raw` (optional) is the command's own text and `line` the whole line it came from. The parser turns zsh/ksh pattern syntax
// into other words and cuts the command there (`bash f<1-2>.sh` has a redirect, `bash *(N)` and `bash +(a|b).sh` have
// subshells), so if the command's text holds such a pattern the result is ambiguous AND `unresolvable`: no candidate list
// can be built, the caller must refuse.
// The parser reports no offsets, so the command is located by its text; when that text occurs more than once, EVERY
// occurrence is checked and any pattern refuses (a harmless decoy copy must not hide the real one). The operand is NOT
// located inside the text: it is written differently from its dequoted value (`a""b<1-9>.sh`, `x{y,z}<1-2>.sh`), so
// the whole command text is checked, with quoted and escaped characters masked (see maskQuoted).
export function scriptFileOf(argv, raw = '', line = raw) {
  const sf = scriptFileOfArgv(argv);
  if (!sf || sf.unresolvable || typeof raw !== 'string' || !raw) return sf;
  return hasPatternSyntax(raw, line, sf.file) ? { kind: sf.kind, file: sf.file, ambiguous: true, unresolvable: true, words: sf.words ?? argv.slice(1), ...(sf.needExt === undefined ? {} : { needExt: sf.needExt }) } : sf;
}

// Does the command's text (`raw`, located in `line`) hold pattern syntax the parser cut the command at? `file`: the operand, if any.
function hasPatternSyntax(raw, line, file) {
  let starts = [];
  if (typeof line === 'string') for (let i = line.indexOf(raw); i >= 0 && starts.length <= MAX_OCCURRENCES; i = line.indexOf(raw, i + 1)) starts.push(i);
  const text = starts.length ? line : raw; // not a substring of the line (nested script text): the command's own text
  if (!starts.length) starts = [0];
  let pattern = starts.length > MAX_OCCURRENCES; // too many places to check: refuse
  // the operand's own spelling, searched in the text, only ever ADDS refusals: a quoted operand that spells a pattern
  // (`'@(f|fa).sh'`) has been refused since round 2, and the masked check below would let it through
  const ats = [];
  if (file !== undefined) for (let i = raw.indexOf(file); i >= 0 && ats.length <= MAX_OCCURRENCES; i = raw.indexOf(file, i + 1)) ats.push(i);
  if (ats.length > MAX_OCCURRENCES) pattern = true;
  const wordEnd = (from) => { let e = from; while (e < text.length && !/\s/.test(text[e])) e++; return e; };
  for (const st of starts) {
    const masked = maskQuoted(text.slice(st, wordEnd(st + raw.length)));
    if (PATTERN_SYNTAX.test(masked) || ZSH_ALTERNATION.test(masked.replace(/'[^']*'/g, (q) => '_'.repeat(q.length)))) pattern = true;
    for (const at of ats) if (PATTERN_SYNTAX.test(text.slice(st, wordEnd(st + at + file.length)))) pattern = true;
  }
  return pattern;
}

// The command's text with everything the shell does not read as pattern syntax replaced by '_' (same length, so `"a"<1-2>`
// still reads as `___<1-2>`): single quotes, double quotes (backslash escapes), $'..' (backslash escapes) and a backslash
// with the character it escapes. Cut at the first newline that is not escaped or quoted (a heredoc body is not the command).
// A double-quoted `$(` or backtick can hold quotes of its own, which this scan does not follow: from there on nothing is masked.
function maskQuoted(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\n') break;
    if (c === '\\') { out += '__'.slice(0, Math.min(2, t.length - i)); i++; continue; }
    const ansi = c === '$' && t[i + 1] === "'";
    if (c === "'" || c === '"' || ansi) {
      const q = ansi ? "'" : c;
      let j = i + (ansi ? 2 : 1);
      for (; j < t.length && t[j] !== q; j++) {
        if (q === '"' && (t[j] === '`' || (t[j] === '$' && t[j + 1] === '('))) return out + '_'.repeat(j - i) + t.slice(j);
        if (t[j] === '\\' && (q === '"' || ansi)) j++;
      }
      out += '_'.repeat(Math.min(j + 1, t.length) - i);
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}
const MAX_OCCURRENCES = 32;
// `$BASH`, `${BASH}`, `${BASH:-bash}`, `${BASH-sh}`: the shell running the script (or the shell the default names)
const BASH_WORD = /^\$(?:BASH|\{BASH(?::?-(?:bash|sh))?\})$/;
const BASH_DEFAULT = /^\$\{BASH:?-bash\}$/; // (the only spelling that names bash whether the shell is bash (it sets BASH) or zsh / sh (BASH unset))
const BASH_REF = /\$BASH(?![A-Za-z0-9_])|\$\{BASH(?::?-(?:bash|sh))?\}/g;
// commands that bind a name given as an operand (`read N`, `declare N=v`, `printf -v N`, `let`, zsh `vared` ...): a name that is not a plain word could be BASH
const BINDERS = /(?<![\w.$/-])(?:read|declare|typeset|local|export|readonly|mapfile|readarray|getopts|unset|let|vared|zparseopts|printf|print|strftime|zstyle|sysread|zstat|getln|integer|float|select|set|autoload|compgen|private|zformat|zregexparse|ztcp|zsocket|zpty|zselect|zsystem|sysopen|syswrite|pcre_match|zgetattr|zlistattr|zcurses|compadd|zle|coproc)(?![\w-])([^\n;&|<>]*)/g; // (the module builtins: see ZSH_NAME_BINDERS)
// Why (#56, Codex recheck of d925d42): zsh builtins that bind names their operands give in shapes the guards do not read (`zparseopts -a B`, `b:=B` specs,
// `vared B`, `strftime -s B`, `zstat -A B`, `integer B=5`): the git and files guards treat one on the line as binding any name. (`print -v B` is read like printf -v.)
// (and the module builtins that bind a name or set REPLY / MATCH: zformat -f / -a, zregexparse, ztcp / zsocket / zpty (REPLY), zselect -A, zsystem flock -f,
// sysopen -u, syswrite -c, pcre_match -v / -a (MATCH), zgetattr, zlistattr, zcurses, compadd -A / -O, zle -U / widgets)
export const ZSH_NAME_BINDERS = new Set(['vared', 'zparseopts', 'strftime', 'zstyle', 'sysread', 'zstat', 'getln', 'integer', 'float', 'private', 'zformat', 'zregexparse',
  'ztcp', 'zsocket', 'zpty', 'zselect', 'zsystem', 'sysopen', 'syswrite', 'pcre_match', 'zgetattr', 'zlistattr', 'zcurses', 'compadd', 'zle']);
// #81: the end (just after the closing `))`) of the `$((` arithmetic that starts at i, or -1 when it cannot be told from a subshell inside a command
// substitution (`$((cmd) )`, `$((a); b)`) or holds a quote, backtick or backslash (those would need the frames).
const arithEnd = (s, i) => {
  let depth = 0;
  for (let j = i + 3; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`' || c === '\\') return -1;
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; else return s[j + 1] === ')' ? j + 2 : -1; }
  }
  return -1;
};
// The text with what the shell never expands blanked out: single-quoted strings and comments (double-quoted text expands, so it stays). Null for `$'…'`
// or an unterminated quote (the caller keeps its answer).
export function withoutLiteralText(s, { dqData = false } = {}) {
  // Why (#56 replay): `for n in 1 2; do echo "$n $(gh pr view $n --jq '.x')"; done` lost its readings because a quote inside a $( … ) inside double quotes
  // gave up. A $( … ) starts a fresh quoting context (its single quotes are quotes again), so each context is a frame on a stack: top, a double-quoted
  // string, a $( … ), a backtick. Still given up (null): a bare ( or $(( inside a $( … ) (a case pattern or arithmetic would end it early), a quote or ( inside
  // backticks, $'…', and anything left open at the end.
  // Also given up: a `case` inside a $( … ) -- its patterns end in a bare `)` that this scanner would take for the end of the $( … ), and every quote after
  // it would then be read in the wrong context (security review of 61296d8).
  // `dqData` (#56 replay: `for f in a.ts b.ts; do node -e "const f='$f'; fs.readFileSync(f)"; done` read `f=` and `(f` in the program as shell text): inside
  // double quotes only `$name`, `${…}`, `$( … )` and backticks are the shell's, so any other word there is blanked too. A `${…}` is kept as written (`${f:=x}`
  // assigns); one holding a quote, a `$`, a backtick, a brace or a backslash ends the blanking for the rest of the text (kept, as without dqData). `$[ … ]`
  // (arithmetic, it can assign) gives up.
  let out = '';
  const stack = ['top'];
  const cur = () => stack[stack.length - 1];
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    const fr = cur();
    if (ch === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (fr === 'tick') {
      if (ch === '`') stack.pop();
      else if (ch === "'" || ch === '"' || ch === '(') return null;
      out += ch; i++; continue;
    }
    if (fr === 'dq') {
      if (ch === '"') stack.pop();
      // Why (#81 replay): `"$n,$((n+6))p"` gave up at the second `(` (a sub frame), so the readings were off for the whole line. An arithmetic holds no quote, so it
      // is copied as written (the caller judges the names in it); one that cannot be followed still gives up.
      else if (ch === '$' && s.startsWith('$((', i)) { const e = arithEnd(s, i); if (e < 0) return null; out += s.slice(i, e); i = e; continue; }
      else if (ch === '$' && s[i + 1] === '(') { stack.push('sub'); out += '$('; i += 2; continue; }
      else if (ch === '`') stack.push('tick');
      else if (dqData) {
        if (ch === '$' && s[i + 1] === '[') return null;
        if (ch === '$' && s[i + 1] === '{') {
          const j = s.indexOf('}', i + 2);
          if (j < 0 || /["'`$\\{]/.test(s.slice(i + 2, j))) dqData = false;
          else { out += s.slice(i, j + 1); i = j + 1; continue; }
        } else if (ch === '$' && /[A-Za-z0-9_]/.test(s[i + 1] ?? '')) {
          const w = /^\$[A-Za-z0-9_]+/.exec(s.slice(i))[0];
          out += w; i += w.length; continue;
        } else if (/[A-Za-z0-9_]/.test(ch)) {
          const w = /^[A-Za-z0-9_]+/.exec(s.slice(i))[0];
          out += ' '.repeat(w.length); i += w.length; continue;
        }
      }
      out += ch; i++; continue;
    }
    // top or sub: the same quoting rules
    if (ch === '$' && s[i + 1] === "'") return null;
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      out += ' '.repeat(j + 1 - i); i = j + 1; continue;
    }
    if (ch === '"') { stack.push('dq'); out += ch; i++; continue; }
    if (fr === 'sub') {
      if (ch === '$' && s[i + 1] === '(') { if (s[i + 2] === '(') return null; stack.push('sub'); out += '$('; i += 2; continue; }
      if (ch === '(') return null;
      if (ch === 'c' && s.startsWith('case', i) && !/[A-Za-z0-9_]/.test(s[i + 4] ?? '') && (i === 0 || !/[A-Za-z0-9_]/.test(s[i - 1]))) return null;
      if (ch === ')') { stack.pop(); out += ch; i++; continue; }
      if (ch === '`') return null;
    }
    if (ch === '#' && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
      const j = s.indexOf('\n', i);
      const e = j < 0 ? s.length : j;
      out += ' '.repeat(e - i); i = e; continue;
    }
    out += ch; i++;
  }
  return stack.length === 1 ? out : null;
}
export const INDIRECT_EXPANSION = /\$\{(?:!|\((?!%\)[:}])[^)]*\)|[A-Za-z_]\w*::=)/; // (fail closed: `${!…}`, zsh `${N::=…}` and every zsh flag expansion but the prompt-only `${(%):…}` with no name (the script-directory idiom `${${(%):-%x}:A:h}`); P, e, A, … can assign)
// Is there an indirect expansion in the text the shell expands? (#56 replay of 96848c2: a JavaScript template `${(err.stderr || …)}` in a quoted heredoc
// body or a single-quoted `node -e '…'` program is no expansion, and refusing it cost ~110 lines in 21 days.) Quoted heredoc bodies and single-quoted
// text are blanked; unquoted bodies and double-quoted text expand, so they stay. True (fail closed) where the text cannot be told: `$'…'`, an unterminated
// quote, heredoc spans that cannot be placed.
export function indirectExpansionOnLine(str, cmds) {
  if (!INDIRECT_EXPANSION.test(str)) return false;
  let t = String(str);
  if (/<</.test(t)) {
    const spans = cmds?.heredocSpans;
    if (!Array.isArray(spans)) return true;
    for (const [a, b, quoted] of spans) {
      if (!(a >= 0 && a <= b && b <= t.length)) return true;
      // (an unquoted body expands, and its quotes are text: `'${(P)N::=x}'` there is a real expansion, and a lone `'` must not shift the scan of the lines
      // after it. So it is judged as written, then blanked like a quoted one; security review of e9ec717)
      if (!quoted && INDIRECT_EXPANSION.test(t.slice(a, b).replace(SAFE_FLAG_EXPANSION, '${'))) return true;
      t = t.slice(0, a) + t.slice(a, b).replace(/[^\n]/g, ' ') + t.slice(b);
    }
  }
  // Single-quoted text is blanked by a scanner of its own: withoutLiteralText also blanks comments, and it reads the `#` of `${(#)X}` as one. Nothing else
  // is taken out, so text left in only refuses more. A backslash keeps the next character from the shell, in or out of double quotes (`\${(e as X)}` is
  // text; `\\${…}` still expands). `$'…'` and an unterminated single quote: true.
  let u = '';
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q === "'") { if (ch === "'") q = null; u += ch === '\n' ? '\n' : ' '; continue; }
    if (ch === '\\') { u += '  '; i++; continue; }
    // (a $( … ) or backtick inside double quotes starts a new quoting context, whose quotes this scanner does not follow: `"$(echo '"')${(P)N::=x}"; echo "'"`
    // would lose its place and blank the real expansion. Then nothing is blanked: the whole text is judged; security review of f79370b)
    if (q === '"' && (ch === '`' || (ch === '$' && t[i + 1] === '('))) return INDIRECT_EXPANSION.test(t.replace(SAFE_FLAG_EXPANSION, '${'));
    if (q === '"') { if (ch === '"') q = null; u += ch; continue; }
    // (a comment's quotes are no quotes: `B=x # it's` … `# '` would blank the lines between. Where a comment may start, nothing is blanked)
    if (ch === '#' && (i === 0 || /[\s;&|()]/.test(t[i - 1]))) return INDIRECT_EXPANSION.test(t.replace(SAFE_FLAG_EXPANSION, '${'));
    if (ch === "'") { if (t[i - 1] === '$') return true; q = "'"; u += ' '; continue; }
    if (ch === '"') q = '"';
    u += ch;
  }
  return q === "'" || INDIRECT_EXPANSION.test(u.replace(SAFE_FLAG_EXPANSION, '${'));
}
// Why (#56 replay of 96848c2): `for x in ${(f)f}`, `FILES=("${(@f)$(git diff --name-only)}")`, `${(@u)FILES}` are common zsh and cannot assign: flags
// that only split, join, sort, unique, quote or count (no P, e, A, g, ~, ^, =, # (arithmetic: it can assign)), with a plain delimiter, followed by a NAME and `}` or by a command
// substitution (it runs in a subshell). Anything else after the flags (`${(f)F::=x}`, `${(f)F:=x}`, `${(s:$x:)…}`) stays an indirect expansion.
const SAFE_FLAG_EXPANSION = /\$\{\((?:[@fFuUoOinkvaqQzLcwWt0]|[sj]:[^:$(){}'"`\\]*:)+\)(?=[A-Za-z_]\w*\}|"?\$\()/g;
// zsh `=~` and the (#b) / (#m) glob flags set these, bash `=~` sets BASH_REMATCH
const MATCH_NAMES = ['MATCH', 'match', 'MBEGIN', 'MEND', 'mbegin', 'mend', 'BASH_REMATCH'];
// The names a command sets without being given them: `read` REPLY (zsh `read -A`: reply), `select` REPLY, `getopts` OPTARG / OPTIND, `mapfile` MAPFILE,
// `[[ … =~ … ]]` and a (#…) pattern flag the match names. (Why, #56 Codex recheck of d925d42: `for REPLY in 5; do read <<< 7; gh issue close $REPLY; done`
// closed issue 7 while the readings judged 5.)
export function implicitBindsOf(c) {
  const nm = c.argv?.length ? commandName(c.argv[0]) : '';
  const out = nm === 'read' ? ['REPLY', 'reply'] : nm === 'select' ? ['REPLY'] : nm === 'getopts' ? ['OPTARG', 'OPTIND'] : nm === 'mapfile' || nm === 'readarray' ? ['MAPFILE'] : [];
  if (nm === '[[' || [...(c.argv ?? []), ...Object.values(c.env ?? {}), ...(c.redirects ?? []).map((r) => r.target ?? '')].some((w) => String(w).includes('(#'))) out.push(...MATCH_NAMES);
  // (#56, Fable review of 2edea61) also: an option that carries its name (`printf -vk`, `wait -pk`; `wait -p k`), an array element (`k[0]=7`: `$k` is
  // element 0), a named file descriptor (`exec {k}>f`: k is the fd number), `coproc k { …; }` (k, k_PID; COPROC without a name), and the names the
  // shell sets by itself (`$_` after every command, RANDOM, SECONDS, …: a value the line gives them is not what a later use reads)
  const argv = c.argv ?? [];
  if (nm === 'printf' || nm === 'print' || nm === 'wait') {
    for (const [i, a] of argv.entries()) {
      const m = /^-[A-Za-z]*?[vp]([A-Za-z_]\w*)$/.exec(a);
      if (m) out.push(m[1]);
      else if (/^-[A-Za-z]*[vp]$/.test(a) && /^[A-Za-z_]\w*$/.test(argv[i + 1] ?? '')) out.push(argv[i + 1]);
    }
  }
  const el = /^([A-Za-z_]\w*)\[[^\]]*\]\+?=/.exec(argv[0] ?? '');
  if (el) out.push(el[1]);
  for (const a of argv) { const fd = /^\{([A-Za-z_]\w*)\}$/.exec(a); if (fd) out.push(fd[1]); }
  if (/^\s*coproc\b/.test(String(c.raw ?? ''))) {
    out.push('COPROC', 'COPROC_PID');
    if (/^[A-Za-z_]\w*$/.test(argv[0] ?? '')) out.push(argv[0], `${argv[0]}_PID`);
  }
  if (argv.length) out.push(...SHELL_SET_NAMES);
  return out;
}
export const SHELL_SET_NAMES = ['_', 'RANDOM', 'SRANDOM', 'SECONDS', 'LINENO', 'EPOCHSECONDS', 'EPOCHREALTIME', 'BASHPID', 'HISTCMD', 'status', 'pipestatus', 'PIPESTATUS', 'ERRNO'];
// Is BASH ever bound by the text? Fail closed: every mention that is not a plain reference counts (also with quotes taken out: `read B""ASH`), a binder
// whose operand name is not a plain word (`declare "${n}SH=x"`, `read -r "$v"`, `export $n=x`, `read BA{SH,}`), `(( $n = 1 ))`, eval, source / `.` (the sourced
// file may bind it), an ANSI-C string with an escape. A mention inside a quote or comment only makes this stricter.
// `(( $n = 1 ))`: a `((`, later a `$`, later an `=` on one line (first occurrences only: linear, a pattern with `[^\n]*` twice is not)
function arithAssignsByName(line) {
  const p = line.indexOf('((');
  const d = p < 0 ? -1 : line.indexOf('$', p);
  return d >= 0 && line.indexOf('=', d) >= 0;
}
function bindsBash(text) {
  const str = text.replace(/\\\r?\n/g, ''); // (a backslash-newline inside a name is removed before the shell reads it: `BA\<nl>SH=x` binds BASH)
  const mentions = (s) => /(?<![A-Za-z0-9_])BASH(?![A-Za-z0-9_])/.test(s.replace(BASH_REF, ''));
  if (mentions(str) || mentions(str.replace(/['"\\]/g, ''))) return true;
  if (/(?<![\w./$-])(?:source|eval)(?![\w-])/.test(str)) return true;
  if (/(?:^|[\n;&|({`!]|\b(?:then|do|else|elif|if|while|until|builtin|command)\b)\s*\.\s+\S/.test(str)) return true;
  if (/\$'[^']*\\[xuU0-7]/.test(str)) return true;
  if (str.split('\n').some(arithAssignsByName)) return true;
  for (const m of str.matchAll(BINDERS)) {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    const vOpt = /^(?:printf|print)$/.test(m[0].trim().split(/\s/)[0]);
    const names = vOpt ? toks.filter((x, i) => i > 0 && /^-\w*v$/.test(toks[i - 1])) : toks.filter((x) => !x.startsWith('-'));
    if (names.some((x) => /[$`{}*?[\\'"(~]/.test(x.split('=')[0]))) return true;
  }
  return false;
}
// ksh/bash extglob (`*(`, `?(`, `+(`, `@(`, `!(`), zsh `(#i)` and `<1-2>` numeric ranges attached to a word
const PATTERN_SYNTAX = /[*?+@!\]]\(|\(#|[^\s<>&|;(]<\d*-\d*>/;
// zsh alternation `(a|b)`: a `(` that opens no substitution, with a `|` and no blank before the `)`. Only the text with quotes masked is checked (a
// quoted `'^(A|B)='` is a regex argument, not a glob; maskQuoted stops masking inside a double-quoted `$(`, so single-quoted runs are masked again)
const ZSH_ALTERNATION = /(?<![$<>=(])\([^\s]*\|[^\s]*\)/;

// (the arguments of a program named by a variable, for the policies that judge the command line it expands to; not part of the record's shape)
const withArgs = (sf, argv) => Object.defineProperty(sf, 'args', { value: argv.slice(1), enumerable: false });
function scriptFileOfArgv(argv) {
  if (!argv.length) return null;
  const name = base(argv[0]);
  if (SHELLS.has(name)) {
    const r = shellInvocation(argv);
    if (r.kind === 'file' && r.parseOnly && !r.amb && !isProcSub(r.text) && !FD_PATH.test(r.text)) return null; // (`bash -n f.sh`: checks the syntax, runs nothing)
    // a `<(...)` operand is script text, not a file, unless a word before it expands: then it is one more candidate word
    if (r.kind === 'file' && (r.amb || !isProcSub(r.text))) return r.amb ? { kind: 'shell', file: r.text, ambiguous: true, words: argv.slice(1) } : { kind: 'shell', file: r.text };
    return r.amb && (r.kind === 'stdin' || r.kind === 'script') ? { kind: 'shell', file: undefined, ambiguous: true, words: argv.slice(1) } : null;
  }
  if (name === 'source' || name === '.') {
    const op = argv[1];
    if (op === undefined || STDIN_FILES.has(op) || isProcSub(op)) return null;
    // `source -p PATH file` (bash 5.3): an option shifts the operand, so any word may be the file
    return hasExpansion(op) || op.startsWith('-') ? { kind: 'shell', file: op, ambiguous: true, words: argv.slice(1) } : { kind: 'shell', file: op };
  }
  if (INTERPRETER.test(name)) {
    let i = 1;
    if ((name === 'deno' || name === 'bun') && argv[1] === 'run') i = 2;
    for (; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--') { i++; break; }
      if (INLINE_FLAGS.has(t.split('=')[0]) || (/^-[A-Za-z]*[ecEmp]$/.test(t) && !t.startsWith('--') && name !== 'node')) return null;
      if (t.length > 1 && t[0] === '-') { if (INTERP_VALUE_FLAGS.has(t)) i++; continue; }
      break;
    }
    const file = argv[i];
    const needExt = name !== 'node' && !INTERPRETER_NO_EXT.has(name);
    if (argv.slice(1, i + 1).some(hasExpansion)) return { kind: 'interp', file, ambiguous: true, words: argv.slice(1), needExt };
    if (file === undefined || (needExt && !SCRIPT_EXT.test(file))) return null;
    return STDIN_FILES.has(file) ? null : { kind: 'interp', file };
  }
  // (a backslash is an ordinary file name character off Windows, so a path holding one is judged like any other)
  if (/[/]/.test(argv[0]) && !SYSTEM_BIN.test(argv[0])) {
    // `./ev*.sh` / `$D/x.sh`: the shell runs whatever the word expands to, so it is a candidate list of one word
    return hasExpansion(argv[0]) ? withArgs({ kind: 'exec', file: argv[0], ambiguous: true, words: [argv[0]] }, argv) : { kind: 'exec', file: argv[0] };
  }
  // `=tool`: zsh runs the file `tool` resolves to on PATH (the candidates are its PATH directories, see script-candidates.mjs)
  // `X=./evil.sh; $X`: a program named by a variable has no `/` to show it is a path
  if (/[$`]/.test(argv[0]) || EQUALS_WORD.test(argv[0])) return withArgs({ kind: 'exec', file: argv[0], ambiguous: true, words: [argv[0]] }, argv);
  return null;
}
const INTERPRETER_NO_EXT = new Set(['python', 'ruby', 'perl', 'php']);
// A descriptor path (`/dev/fd/3`): a shell run on it reads whatever the descriptor was opened from
const FD_PATH = /^\/(?:dev|proc\/self)\/fd\/(?:[3-9]|[1-9]\d+)$|^\/(?:dev|proc\/self)\/fd\/\$/;
// Marks a command as one that reads its program / script from stdin (an output process substitution's stream reaches those); non-enumerable like `feeds`
function markStdin(cmd, interp, sql = false) {
  if (!cmd) return;
  Object.defineProperty(cmd, 'stdinShell', { value: true, enumerable: false, configurable: true });
  if (interp) Object.defineProperty(cmd, 'interpStdin', { value: true, enumerable: false, configurable: true });
  if (sql) Object.defineProperty(cmd, 'sqlStdin', { value: sql, enumerable: false, configurable: true });
}
// Why: an interpreter given no script operand (`node`, `python3 -u`, `node -`) reads its program from stdin: `node < f.mjs` runs the file like `node f.mjs`
function interpReadsStdin(argv) {
  const name = base(argv[0]);
  let i = 1;
  if ((name === 'deno' || name === 'bun') && argv[1] === 'run') i = 2;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { i++; break; }
    if (INLINE_FLAGS.has(t.split('=')[0]) || (/^-[A-Za-z]*[ecEmp]$/.test(t) && !t.startsWith('--') && name !== 'node')) return false;
    if (/^(?:-v|-V|-h|--version|--help|--v8-options)$/.test(t)) return false; // prints and exits
    if (t.length > 1 && t[0] === '-') { if (INTERP_VALUE_FLAGS.has(t)) i++; continue; }
    break;
  }
  return i >= argv.length || STDIN_FILES.has(argv[i]);
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
      return Buffer.from(argv[i + 1] ?? '', 'base64').toString('utf16le'); // (a throw ends in finalize's truncated, which both policies deny)
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

// Commands that print the files named on their command line. Value: [short options that take a value, long options that take a value].
// Only the EXACT ones print them as they are (the file is the text); head / tail print part of a file and tac reverses its lines, so what
// reaches the shell is not the file (`tail -n +2` drops the line that opened a quote around the rest): they are word-scanned like sed / awk.
const READERS = {
  cat: ['', []], tac: ['', []], less: ['', []], more: ['', []], bat: ['', []], batcat: ['', []],
  head: ['nc', ['--lines', '--bytes']], tail: ['nc', ['--lines', '--bytes']],
};
// Why: only option-less `cat` (and `cat -u`, `--`) prints its files byte for byte. `cat -n/-s/-A` number, squeeze or show characters, `bat` / `less` decorate
// and page, `head -c` / `tail -c` cut: what reaches the shell is computed from the file, so it is scanned, never rebuilt as the file's own text.
// (the words after a `--` are file operands, even `-n`: the same reading as line-writes' isExactCat)
const exactCopy = (name, argv) => {
  if (name !== 'cat') return false;
  const dd = argv.indexOf('--', 1);
  return argv.slice(1, dd < 0 ? undefined : dd).every((w) => w === '-u' || w === '-' || w[0] !== '-');
};
const MAX_FEED_FILES = 64; // more files than this feed one command: refused, not judged

// The file operands of a reader: words that are not options, minus the values of options that take one.
function readerOperands(argv, shortVal, longVal) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { out.push(...argv.slice(i + 1)); break; }
    if (t.length < 2 || t[0] !== '-') { out.push(t); continue; }
    if (t[1] === '-') { if (!t.includes('=') && longVal.includes(t)) i++; continue; }
    for (let k = 1; k < t.length; k++) {
      if (!shortVal.includes(t[k])) continue;
      if (k === t.length - 1) i++;
      break;
    }
  }
  return out;
}

// Every word of a command that rewrites what it reads (sed, awk, base64, tr, grep ...) that could name a file: all non-option
// words (option values and sed/awk programs among them), `--file=F` / `if=F` values. Which of them is a file is only known to the caller.
function looseOperands(argv) {
  const out = [];
  argv.forEach((w, idx) => {
    if (idx === 0 || w === '' || /:\/\//.test(w)) return; // a URL is not a local file
    if (w[0] === '-') { const eq = w.indexOf('='); if (eq > 0) out.push([w.slice(eq + 1), w, idx]); return; }
    const kv = /^(?:if|file|input)=(.+)$/.exec(w);
    out.push([kv ? kv[1] : w, w, idx]);
  });
  return out;
}

// Readers whose first non-option word is a program or pattern TEXT (`grep -E '^(A|B)='`, `sed 's/^/x/'`), not a file: the only word that
// may be taken as the literal text it spells. Any other operand or option value (`--include='*.sh'`, `-g`, `-name`) may be a pattern the
// producer expands to real files itself. -e / -f (and the long forms) make every non-option word a file.
const PROGRAM_READERS = new Set(['sed', 'gsed', 'grep', 'egrep', 'fgrep', 'awk', 'gawk', 'mawk', 'jq']);
const NO_PROGRAM_FLAG = /^(?:-[A-Za-z]*[ef]|--(?:expression|regexp|file|from-file)(?:=.*)?)$/;
function programIndex(name, argv) {
  if (!PROGRAM_READERS.has(name) || argv.slice(1).some((a) => NO_PROGRAM_FLAG.test(a))) return -1;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--') return i + 1;
    if (argv[i][0] !== '-' || argv[i] === '-') return i;
    if (/^-[ABCmdD]$/.test(argv[i])) i++;
  }
  return -1;
}

// Commands whose output never is the text of a file they were given (system queries): their words are not file operands of a feed (they still
// feed the shell text, so they are scanned / judged as every other producer; ENV_PRODUCERS print the environment, which is dynamic).
const ENV_PRODUCERS = new Set(['printenv', 'sysctl', 'ioreg']);
const NO_FILE_PRODUCERS = new Set(['ps', 'pgrep', 'pidof', 'date', 'uname', 'whoami', 'id', 'hostname', 'pwd', 'uptime', 'df', 'free', 'sw_vers', 'arch', 'nproc', 'tty', 'seq', 'which', 'printenv', 'vm_stat', 'sysctl', 'ioreg']);

// Producers that read files nobody names: a directory walk or archive listing. What they print could be any file under it.
function readsUnnamedFiles(name, argv) {
  if (['find', 'fd', 'fdfind', 'rg', 'ag', 'ack', 'locate', 'xargs', 'tar', 'bsdtar', 'unzip', 'ls', 'dir'].includes(name)) return true;
  if (name === 'git') return argv.some((a) => ['grep', 'show', 'cat-file', 'archive'].includes(a));
  return ['grep', 'egrep', 'fgrep'].includes(name) && argv.some((a) => /^-[A-Za-z]*[rR]/.test(a) || /^--(?:recursive|include|exclude|dereference-recursive)/.test(a));
}

// The one script a shell / interpreter / program run by path reads (`bash $F/stack.sh env`), when no word BEFORE it can shift which word it is.
// The operand itself may expand (it is then a word for the caller to resolve or refuse); null: no script, or the words before it expand.
function producerScript(argv) {
  const name = argv.length ? base(argv[0]) : '';
  if (SHELLS.has(name)) {
    const r = shellInvocation(argv);
    if (r.kind !== 'file' || isProcSub(r.text)) return null;
    return argv.slice(1, argv.indexOf(r.text, 1)).some(hasExpansion) ? null : r.text;
  }
  const sf = scriptFileOfArgv(argv);
  return sf && !sf.ambiguous && !sf.unresolvable && typeof sf.file === 'string' && sf.file !== '' ? sf.file : null;
}

// The index of the word that holds the program text of an inline interpreter run (`node -e CODE`, `node --eval=CODE`, `python -c CODE`, `php -r CODE`), or -1.
function inlineCodeIndex(name, argv) {
  if (!INTERPRETER.test(name)) return -1;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--' || t === '-' || t[0] !== '-') return -1;
    const flag = t.split('=')[0];
    if (['-e', '-E', '-p', '-c', '-r', '--eval', '--print'].includes(flag) || (name !== 'node' && /^-[A-Za-z]*[ecEpr]$/.test(t))) return t.includes('=') && t[1] === '-' ? i : i + 1;
    if (INTERP_VALUE_FLAGS.has(t)) i++;
  }
  return -1;
}

// groups: the exact files, one array per producer in the order it names them (what `st.files` was filled from), so the join can be rebuilt
// seq: the stream's parts in the order its producers run ({text} a static producer prints, {file} an exact reader's file, {scan} a rewriting producer's word); see producePieces
// ordered: set while producePieces records seq (a static producer then does not make the stream `mixed` by itself)
// unordered: the producers' texts may not make the stream in the order recorded (one may stop the group, print elsewhere, not run, run in the background); unsure:
// the same except stopping the group, which only cuts the stream short (a guarded word found in a part of it is in the whole: the scan of a rewritten stream holds)
const newSt = () => ({ dyn: false, unordered: false, unsure: false, mixed: false, ordered: false, seq: [], whole: new Set(), files: [], groups: [], computed: [], raws: [], pat: new Set(), unq: new Set(), ops: new Set() });
const hasTextPiece = (seq) => (seq ?? []).some((p) => Object.hasOwn(p, 'text'));

// Adds what `b` collected to `a` (a descriptor opened twice, a variable assigned twice: both may be read).
function mergeSt(a, b) {
  const out = newSt();
  for (const x of [a, b]) {
    out.dyn = out.dyn || x.dyn;
    out.unordered = out.unordered || x.unordered;
    out.unsure = out.unsure || x.unsure;
    out.mixed = out.mixed || x.mixed;
    out.files.push(...x.files); out.groups.push(...x.groups); out.computed.push(...x.computed); out.raws.push(...x.raws); out.seq.push(...x.seq);
    for (const k of ['pat', 'unq', 'ops', 'whole']) for (const w of x[k]) out[k].add(w);
  }
  // (two texts that may each be read are not one stream: static text in either cannot be placed)
  const some = (x) => x.files.length || x.computed.length || x.seq.length;
  if ((hasTextPiece(a.seq) || hasTextPiece(b.seq)) && some(a) && some(b)) out.mixed = true;
  return out;
}

// Why: `X=$(cat f.sh); eval "$X"`: the variable holds the text of a file (the substitution strips trailing newlines and an unquoted use splits it into words,
// so it is never the file's exact text: scanned, like a rewriting producer's). Assigned once or twice, in a branch or not: every assignment is remembered.
function noteVarFeeds(ctx, name, subs) {
  const st = newSt();
  subsProduced(subs, st, 1);
  if (!st.files.length && !st.computed.length && !st.dyn) return;
  const e = newSt();
  e.dyn = st.dyn;
  for (const w of [...st.files, ...st.computed]) { e.computed.push(w); e.pat.add(w); e.ops.add(w); }
  e.raws.push(...st.raws);
  const prev = ctx.varFeeds.get(name);
  ctx.varFeeds.set(name, prev ? mergeSt(prev, e) : e);
}

// Why: a substitution's files are the exact script text only when one quoted substitution is the whole script (`eval "$(cat f)"`, `bash -c "$(cat f)"`). Unquoted it is
// split into words (`eval $(cat f)`, `$(cat f)`: f's lines become ONE command), eval joins several words with spaces and text around it is added to it (`eval "x $(cat f)"`):
// the files are then scanned, like a variable that holds a file's text (noteVarFeeds).
function scannedSubs(st) {
  for (const w of st.files) { st.computed.push(w); st.pat.add(w); st.ops.add(w); st.whole.add(w); }
  st.files.length = 0;
  st.groups.length = 0;
}

// The feeds of the variables `text` refers to (`$X`, `${X}`, `"$X"`), added to `st`; `seg.vf` is the line's table of variables that hold file text.
const VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
function varFeedsInto(seg, text, st) {
  if (!seg.vf || !seg.vf.size || typeof text !== 'string' || !text.includes('$')) return;
  for (const m of text.matchAll(VAR_REF)) {
    const e = seg.vf.get(m[1]);
    if (!e) continue;
    if (e.dyn) st.dyn = true;
    for (const w of e.computed) { st.computed.push(w); st.pat.add(w); st.ops.add(w); }
    st.raws.push(...e.raws);
  }
}

// What the command `seg` prints, when its output reaches the shell through a file: the files it reads. `exact`: nothing
// between the command and the shell rewrites its output, so a plain reader's files ARE the script text (`st.files`); otherwise
// the text is computed at run time and the files are only worth a look (`st.computed`).
function noteReads(seg, name, argv, st, exact) {
  if (name === 'echo' || name === 'printf') return; // static text, handled by producedBy
  // such a producer's words stay candidates as before, but they are not FILE operands for the join rule (scriptFeedsOf): `ps -o rss= -p $pid` names none
  const noFile = NO_FILE_PRODUCERS.has(name);
  if (ENV_PRODUCERS.has(name)) st.dyn = true; // what it prints is the environment's, only known at run time
  if (readsUnnamedFiles(name, argv)) st.dyn = true; // the files it reads are unknown: the dynamic rules apply (refused when the line names a guarded operation / protected file)
  const reader = Object.hasOwn(READERS, name);
  // a shell / interpreter / program run by path that is given a script (`bash $F/stack.sh env`): the script is the one file it reads, the words after it are the script's own arguments
  const script = reader ? null : producerScript(argv);
  // [operand, the word it came from, argv index, argOnly]; a word with no unquoted pattern character is a literal name even if it looks like a regex (`'^(A|B)='`).
  // The script's other words stay scanned (the script may print a file they name: `s.sh` = `cat "$1"`), but they are not FILE operands for the join rule.
  const scriptArgs = () => looseOperands(argv).filter(([w]) => w !== script).map(([w, full, idx]) => [w, full, idx, true]);
  // Why: `node -e 'code'` / `python -c 'code'`: the code text is a program, not a file name (JS `[0] === 2` or a backtick made it a glob that could not be resolved);
  // the words after it stay candidates, the program may print a file it is given (`node -e '...readFileSync(process.argv[1])' f.sh`)
  const code = reader ? -1 : inlineCodeIndex(name, argv);
  const words = reader ? readerOperands(argv, ...READERS[name]).map((w) => [w, w]) : script !== null ? [[script, script, argv.indexOf(script)], ...scriptArgs()] : looseOperands(argv).filter(([, , idx]) => idx !== code);
  for (const f of seg.stdinFiles) { words.push([f, f]); st.pat.add(f); }
  const list = exact && (exactCopy(name, argv) || argv.length === 0) ? st.files : st.computed;
  const prog = reader ? -1 : programIndex(name, argv);
  const group = [];
  for (const [w, full, idx, argOnly] of words) {
    if (w === '' || w === '-' || STDIN_FILES.has(w)) continue;
    list.push(w);
    if (list === st.files) group.push(w);
    if (seg.pat.has(full) || idx !== prog) st.pat.add(w);
    if (seg.pat.has(full)) st.unq.add(w); // an unquoted pattern: the shell really globs it (`find . -name '*.sh'` does not)
    // a FILE operand for the join rule: not a system query's word, not a script's argument. Kept apart from `pat`, which also decides whether a
    // scanned word is globbed (`bash ok.sh f*.sh`: the shell expands f*.sh, so it must stay a pattern — review R3-B1)
    if (!noFile && !argOnly) st.ops.add(w);
  }
  if (group.length) st.groups.push(group);
  if (group.length && seg.sep === '&') st.unordered = st.unsure = true; // (a job in the background: the order it prints in, among the others, is not known)
  // Why: a producer that may not run (after && / ||, in an if / case branch, a loop, a function body or a trap action) leaves its text out of the stream, or
  // repeats it: `{ cat a; false && cat b; cat c; } | bash` runs a+c, which the join a+b+c hides (Codex review 3 of #50). Such a join is not rebuilt (refused).
  if (group.length && (seg.sep === '&&' || seg.sep === '||' || Object.values(seg.ctl ?? {}).some(Boolean))) st.unordered = st.unsure = true;
  if (words.length) st.raws.push(seg.raw);
}

// producedBy over a substitution's segments: a command whose output is piped on (`$(cat f | tr a b)`) is only exact when it is last.
function subsProduced(subs, st, hops) {
  const piped = new Set();
  for (const s of subs) if (s.pipedFrom) for (const p of s.pipedFrom) piped.add(p);
  const out = [];
  for (const s of subs) out.push(...producedBy(s, st, hops, !piped.has(s)));
  return out;
}

// The exact text a static producer prints, or null when it cannot be rebuilt exactly: echo (its newline; `-n`), printf with a format of plain text, `%s`, `%%`
// and `\n` (the format is reused for the arguments left), cat of a quoted heredoc (its last newline; `<<-` strips the tabs) or of a here-string. An expansion,
// a backslash echo may interpret (zsh's does by default), an option, another format or an unquoted heredoc that expands is not rebuilt.
function staticOutput(seg) {
  const pa = seg.final ? seg.final.argv : [];
  const pn = pa.length ? base(pa[0]) : '';
  // (bash ends an argument at a NUL, `$'git pu\0#'` prints `git pu`; zsh keeps it: neither is rebuilt -- Codex review 4)
  if (pa.some((w) => w.includes('\0')) || [...seg.heredocs, ...seg.herestrings].some((h) => h.text.includes('\0'))) return null;
  if (pn === 'echo' || pn === 'printf') {
    if (seg.heredocs.length || seg.herestrings.length || pa.slice(1).some((w) => seg.meta.has(w) || seg.pat.has(w))) return null;
  }
  if (pn === 'echo') {
    const nl = pa[1] === '-n' ? '' : '\n';
    const words = pa.slice(nl ? 1 : 2);
    if (words[0]?.startsWith('-') || words.some((w) => w.includes('\\'))) return null;
    return words.join(' ') + nl;
  }
  if (pn === 'printf') {
    const fmt = pa[1];
    if (fmt === undefined || fmt.startsWith('-')) return null;
    const toks = fmt.match(/%s|%%|\\n|[^%\\]+/g) ?? [];
    if (toks.join('') !== fmt) return null;
    const args = pa.slice(2);
    const n = toks.filter((t) => t === '%s').length;
    let out = '';
    let k = 0;
    do {
      for (const t of toks) out += t === '%s' ? args[k++] ?? '' : t === '%%' ? '%' : t === '\\n' ? '\n' : t;
    } while (n > 0 && k < args.length);
    return out;
  }
  if (pn === 'cat' && pa.length === 1 && !seg.stdinFiles.length && seg.heredocs.length + seg.herestrings.length === 1) {
    const h = seg.heredocs[0];
    if (h) {
      if (!h.lines || (!h.quoted && /[$`\\]/.test(h.text))) return null; // (no line: '' and one empty line look alike)
      return h.text + '\n'; // (`<<-` tabs already stripped: readHeredocs)
    }
    const hs = seg.herestrings[0];
    return hs.dyn || hs.subs.length ? null : hs.text + '\n';
  }
  return null;
}

// Why: static text (echo, printf, a heredoc) and files in ONE stream (`{ echo "begin;"; cat m.sql; cat <<'SQL' ... SQL } | psql`, daily database work): the stream
// is rebuilt from what each producer prints, in the order they run (st.seq), and judged as one text (scriptFeedsOf). `stages`: the stream's producers in source order
// (a pipeline's earlier commands feed its last one: their part is the last one's), `run(s)`: producedBy for one of them, returning the texts it adds. A producer whose
// static text cannot be rebuilt exactly (staticOutput) or comes with files makes the stream `mixed`; one that may not run (after && / ||, in a branch or loop,
// in the background) makes it `unsure`: either is refused when static text and files feed one program (scriptFeedsOf).
function producePieces(stages, st, run) {
  const onward = new Set();
  for (const s of stages) for (const p of s.pipedFrom ?? []) onward.add(p);
  const was = st.ordered;
  st.ordered = true;
  const out = [];
  try {
    let mark = null;
    let texts = 0;
    let piped = false;
    for (const s of stages) {
      if (!mark) { mark = { files: st.files.length, computed: st.computed.length }; texts = 0; piped = false; }
      const t = run(s);
      out.push(...t);
      texts += t.length;
      if (s.pipedFrom?.length) piped = true;
      if (onward.has(s)) continue; // (its output is the next command's input)
      const files = st.files.slice(mark.files);
      const computed = st.computed.slice(mark.computed);
      mark = null;
      const may = s.sep === '&' || s.sep === '&&' || s.sep === '||' || Object.values(s.ctl ?? {}).some(Boolean);
      if (may && (texts || files.length || computed.length)) st.unsure = true;
      if (!texts) {
        for (const w of files) st.seq.push({ file: w });
        for (const w of computed) st.seq.push({ scan: w });
        continue;
      }
      // (a line that defines a function or can rename a command -- `echo() { :; }`, alias, enable -n, functions[echo]=, source, eval ... -- may print anything
      // under echo's name: not rebuilt, without telling which names it reaches -- Codex review 4; see noteRedef)
      const text = files.length || computed.length || piped || s.defs?.redef || s.fns?.size ? null : staticOutput(s);
      if (text === null) { st.mixed = true; continue; }
      if (text !== '') st.seq.push({ text });
    }
  } finally { st.ordered = was; }
  return out;
}

// Whether `st.seq` is the whole stream st describes: its file parts are st.files in order, its scan parts st.computed (anything added outside producePieces --
// `< F`, a descriptor, a client's -f file -- leaves it incomplete, so static text in it cannot be placed).
function seqCovers(st) {
  const files = st.seq.filter((p) => Object.hasOwn(p, 'file')).map((p) => p.file);
  const scans = st.seq.filter((p) => Object.hasOwn(p, 'scan')).map((p) => p.scan).sort();
  const comp = [...st.computed].sort();
  return files.length === st.files.length && files.every((w, i) => w === st.files[i]) && scans.length === comp.length && scans.every((w, i) => w === comp[i]);
}

// Static text a command writes to stdout (or hands a shell on stdin): its heredocs and here-strings, and what
// echo / printf print. `st.dyn` is set when any of it is only known at run time; `st.files` / `st.computed` collect the files
// it reads (see noteReads).
function producedBy(seg, st, hops = 0, exact = true) {
  const out = [];
  if (hops > 6) return out;
  for (const h of seg.heredocs) out.push(h.text);
  for (const hs of seg.herestrings) {
    out.push(hs.text);
    if (hs.dyn) st.dyn = true;
    out.push(...subsProduced(hs.subs, st, hops + 1));
    varFeedsInto(seg, hs.text, st);
  }
  const pa = seg.final ? seg.final.argv : [];
  const pn = pa.length ? base(pa[0]) : '';
  // Why: the stream several producers make is rebuilt only when each of them really feeds it, all of them (background review of f3aa3f6): one whose stdout goes
  // elsewhere (`cat b >&2`, `> /dev/null`) adds nothing, and a command between them that is no reader and no static text (`exit`, a test, `false` under set -e)
  // may stop the group and drop the producers after it (`a`+`b` pushes main while the joined `a`+`b`+`c` reads main-feature). Such a join is refused (unordered).
  const OUT = ['>', '>>', '>|', '&>', '&>>', '>&'];
  if ((seg.redirects ?? []).some((r) => OUT.includes(r.op) && (r.fd === null || r.fd === undefined || r.fd === 1) && r.target !== '&1')) st.unordered = st.unsure = true;
  if (pa.length && !['echo', 'printf', 'true', ':'].includes(pn) && !Object.hasOwn(READERS, pn)) st.unordered = true;
  // (static text in the same stream as files, `{ cat a; printf %s sh; cat b; }`: the files would be judged joined without it -- Codex recheck of a5c0e5a. Only a
  // stream producePieces records is rebuilt with it; anywhere else (`eval "$(echo x; cat f)"`, a variable, xargs) it is not)
  if (!st.ordered && (seg.heredocs.length || seg.herestrings.length || pn === 'echo' || pn === 'printf')) st.mixed = true;
  noteReads(seg, pn, pa, st, exact);
  if (pn === 'echo' || pn === 'printf') {
    for (const a of pa.slice(1)) {
      varFeedsInto(seg, a, st);
      const m = seg.meta.get(a);
      if (!m) continue;
      if (m.dyn) st.dyn = true;
      out.push(...subsProduced(m.subs, st, hops + 1));
    }
  }
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

// What a bare `bash` / `sh` (reading stdin) will run: its own heredoc / here-string / `< <(...)`, or what earlier
// pipeline stages print (`echo "..." | bash`, `{ echo ...; } | sh`, `cat <<EOF | sh`). `unknown` means some of
// it is only known at run time (`curl ... | sh`, `bash < file`).
function stdinSource(seg) {
  const st = newSt();
  const texts = [];
  st.files.push(...seg.stdinFiles); // `bash < F`: the script is the file
  if (seg.stdinFiles.length) st.groups.push([...seg.stdinFiles]);
  for (const e of seg.fdFeeds) { st.computed.push(...e.computed); for (const w of e.computed) { st.pat.add(w); st.ops.add(w); } st.raws.push(...e.raws); if (e.dyn) st.dyn = true; }
  for (const h of seg.heredocs) texts.push(h.text);
  let fed = seg.stdinSubs.length > 0 || (seg.pipedFrom !== null && seg.pipedFrom.length > 0);
  let fedTexts = 0;
  for (const hs of seg.herestrings) {
    // (`bash <<< "$(cat f)"`: the text is what the substitution prints, judged below; the word itself read as script would be a command word, which is split. Only
    // files read as they are: a program's output is unknown text, and reading the word again keeps what that means)
    const shape = hs.subs.length > 0 && !hs.subs.some((x) => x.split) && (hs.text.match(/\$\(|`/g) ?? []).length === 1 && /^(?:\$\(|`)/.test(hs.text) && /[)`]$/.test(hs.text);
    const before = { files: st.files.length, computed: st.computed.length, dyn: st.dyn };
    const produced = subsProduced(hs.subs, st, 1);
    const whole = shape && st.files.length > before.files && st.computed.length === before.computed && st.dyn === before.dyn;
    if (!whole) texts.push(hs.text);
    if (hs.dyn) st.dyn = true;
    texts.push(...produced);
    varFeedsInto(seg, hs.text, st);
  }
  { const t = producePieces(seg.stdinSubs, st, (s) => producedBy(s, st, 1, !seg.stdinSubs.some((x) => x.pipedFrom?.includes(s)))); fedTexts += t.length; texts.push(...t); }
  const subsSeq = st.seq.length;
  const walk = (stage, hops) => {
    if (hops > 8) return [];
    const got = [];
    for (const p of stage) {
      got.push(...producedBy(p, st, 0, hops === 0));
      if (p.pipedFrom) got.push(...walk(p.pipedFrom, hops + 1));
    }
    return got;
  };
  // (each of the stage's commands with what its upstream prints into it: one part of the stream)
  if (seg.pipedFrom) {
    const t = producePieces(seg.pipedFrom, st, (p) => [...producedBy(p, st, 0, true), ...(p.pipedFrom ? walk(p.pipedFrom, 1) : [])]);
    fedTexts += t.length;
    texts.push(...t);
    if (subsSeq && st.seq.length > subsSeq && hasTextPiece(st.seq)) st.mixed = true; // (`< <(...)` and a pipe: one of them is the stdin, not both in a row)
  }
  const unknown = (fed && fedTexts === 0) || seg.stdinFile || st.dyn;
  return { texts, unknown, st };
}

// The text a command prints (`out`: its heredocs / here-strings, echo / printf text, the files a reader names) and what it reads on stdin
// (`stdin`: its own heredoc, `< F`, `<(...)`, the pipe it is fed from). `files` hold text as it is, `computed` are files a rewriting
// command (sed, base64 ...) reads, `dyn` is set when part of it is only known at run time, `fed` when stdin comes from a pipe or a substitution.
function streamsOf(seg, argv) {
  const view = { ...seg, final: { argv } };
  const o = newSt();
  const outTexts = producedBy(view, o);
  const s = stdinSource(view);
  return {
    out: { texts: outTexts, files: o.files, computed: o.computed, dyn: o.dyn },
    stdin: { texts: s.texts, files: s.st.files, computed: s.st.computed, dyn: s.st.dyn, fed: seg.stdinSubs.length > 0 || (seg.pipedFrom !== null && seg.pipedFrom.length > 0) },
  };
}

// ---- script text fed to a shell from files ---------------------------------------------------------

// `cmd.feeds` (not enumerable, like `sep`) lists the files the text a shell / source / eval runs comes from, when it is not
// named as a script file: `files` hold the text as it is (a stdin redirect, `cat F |`, `<(cat F)`, `$(<F)`), `computed` are words
// a command that rewrites its input (sed, awk, base64, tr ...) may read; `raws` are the producers' command texts.
// `interp`: the fed text is the program of an interpreter (`node < f.mjs`), not shell script text; 'sql': the input of psql / mysql / sqlite3 (only its shell escapes run).
function addFeeds(cmd, st, interp = false) {
  if (!cmd || (!st.files.length && !st.computed.length && !st.rcOnly)) return;
  if (!cmd.feeds) Object.defineProperty(cmd, 'feeds', { value: { files: [], groups: [], computed: [], raws: [], pat: [], unq: [], ops: [], rc: [], seqs: [], whole: [], unordered: false, unsure: false, mixed: false, interp: false, sql: false }, enumerable: false });
  if (st.unordered) cmd.feeds.unordered = true;
  if (st.unsure) cmd.feeds.unsure = true;
  if (st.mixed) cmd.feeds.mixed = true;
  // (each stream keeps its own parts: two feeds of one command are two texts, not one; static text in a stream that is not wholly recorded cannot be placed)
  if (hasTextPiece(st.seq)) { if (seqCovers(st)) cmd.feeds.seqs.push([...st.seq]); else cmd.feeds.mixed = true; }
  if (typeof interp === 'string') cmd.feeds.sql = interp;
  else if (interp) cmd.feeds.interp = true;
  cmd.feeds.pat.push(...st.pat);
  cmd.feeds.unq.push(...st.unq);
  cmd.feeds.ops.push(...st.ops);
  cmd.feeds.whole.push(...(st.whole ?? []));
  cmd.feeds.files.push(...st.files);
  cmd.feeds.groups.push(...st.groups);
  cmd.feeds.computed.push(...st.computed);
  cmd.feeds.raws.push(...st.raws);
}

// A file operand that is not one exact file name: it expands (glob, `$`, substitution), lists names (`{a,b}.sh`, `{1..3}`) or names someone
// else's home / the working directory by tilde (`~root/x`, `~+/x`; `~` and `~/x` are the user's home, which the policies resolve).
const BRACE_LIST = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
// `globs`: whether a pattern character counts (an exact reader's operand: any; a rewriting producer's: only an unquoted one, since
// `find . -name '*.sh'` or `grep -e '^x' a b` quote their patterns for the producer, not for the shell).
const opaqueFile = (w, globs) => (globs ? hasExpansion(w) : /[$`]/.test(w)) || BRACE_LIST.test(w) || /^~[^/]/.test(w);

// The files that feed the text `cmd` runs, as script-file records the callers judge: {kind:'shell'} like `bash F` (the text is
// the file), {kind:'scan'} for a file a rewriting command read (the text is computed at run time, so the caller refuses the
// file when it holds a guarded word). A word that expands is ambiguous (the caller lists the candidates); pattern syntax the
// parser cut the producer at, or too many files, is unresolvable (the caller must refuse). `line` is the whole line `cmd` came from.
// `resolve` (optional): the caller's value for a word that holds `$` (the variables the line has set: `F=x/y; ... $F/s.sh`); a word it
// returns without `$` / backtick / whitespace is that one file name and is decided on as such, anything else stays as written.
// Why: a command whose name is a variable (`$PSQL $DB < q.sql`) may be a shell reading its script from stdin; when the caller knows the value and it is one of
// these programs, the file is data for it. Not a shell, an interpreter or a wrapper that starts one (env, sudo, xargs ...): an unknown name stays a possible shell.
// (the SQL clients are not here: sql-clients.mjs models them, and one outside its option allowlist keeps its stdin as a feed)
const DATA_PROGRAMS = new Set(['pg_restore', 'jq', 'yq', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'cut', 'tr', 'head', 'tail', 'cat', 'less', 'more', 'diff', 'cmp', 'column', 'md5sum', 'shasum', 'sha256sum', 'cksum', 'xxd', 'od', 'base64', 'nl', 'fold', 'paste', 'comm']);
export function isDataProgram(value) {
  if (typeof value !== 'string' || /[$`;&|<>()\\"'\n]/.test(value)) return false;
  const first = value.trim().split(/\s+/)[0] ?? '';
  return (!first.includes('/') || first.startsWith('/')) && DATA_PROGRAMS.has(base(first));
}
// Why: psql / mysql / sqlite3 and their cousins run shell commands, write files and include other files from the text they read: see sql-clients.mjs (one model for
// the direct path, the variable-named path and the files). A value that names one (`Q=psql`, `PSQL="psql -h x"`) is a client, not a shell.
export const isSqlShellProgram = (value) => sqlFamilyValue(value) !== null;
export { sqlShellEscapes };
// the client family a resolved command value names (`psql -h localhost`), or null
function sqlFamilyValue(value) {
  if (typeof value !== 'string' || /[$`;&|<>()\\"'\n]/.test(value)) return null;
  const first = value.trim().split(/\s+/)[0] ?? '';
  return !first.includes('/') || first.startsWith('/') ? sqlFamilyOf(base(first)) : null;
}
function mergeFeeds(a, b) {
  const out = { ...a, unordered: a.unordered || b.unordered, unsure: a.unsure || b.unsure, mixed: a.mixed || b.mixed, interp: a.interp || b.interp, sql: a.sql || b.sql };
  for (const k of ['files', 'groups', 'computed', 'raws', 'pat', 'unq', 'ops', 'rc', 'seqs', 'whole']) out[k] = [...(a[k] ?? []), ...(b[k] ?? [])];
  return out;
}

export function scriptFeedsOf(cmd, line = cmd?.raw, resolve = null) {
  let raw0 = cmd?.feeds;
  let extra = [];
  if (cmd?.headDyn && typeof resolve === 'function') {
    // Why: a command named by a variable may be a shell reading its script from stdin; when its value is a database client it is modelled like the same client named
    // directly (sql-clients.mjs): its stdin and files are SQL input, its options and text are judged, and anything outside the allowlist leaves it a possible shell.
    const prog = resolve(cmd.argv?.[0] ?? '');
    const fam = sqlFamilyValue(prog);
    const plan = fam ? sqlClientPlan(fam, [...prog.trim().split(/\s+/).slice(1), ...cmd.argv.slice(1)], cmd.env ?? {}, resolve) : null;
    if (plan?.modelled) {
      if (cmd.headStdinSql) extra.push(...feedRecords(cmd, line, resolve, { ...cmd.headStdinSql, sql: fam }));
      if (plan.lines.length) extra.push({ kind: 'sqllines', file: 'the SQL text', lines: plan.lines });
      for (const f of plan.files) extra.push({ kind: 'sql', family: fam, file: f });
      extra.push(...rcRecords(plan.rc, line));
    } else {
      if (cmd.headStdin && (plan || !isDataProgram(prog))) raw0 = raw0 ? mergeFeeds(raw0, cmd.headStdin) : cmd.headStdin;
      if (plan && cmd.headStdinSql) extra.push(...feedRecords(cmd, line, resolve, { ...cmd.headStdinSql, sql: 'any' }));
      if (plan) {
        if (plan.lines.length) extra.push({ kind: 'sqllines', file: 'the SQL text', lines: plan.lines });
        for (const f of plan.files) extra.push({ kind: 'sql', family: 'any', file: f });
        extra.push(...rcRecords(plan.rc, line));
      }
    }
  } else if (cmd?.headStdin) {
    raw0 = raw0 ? mergeFeeds(raw0, cmd.headStdin) : cmd.headStdin;
  }
  return [...feedRecords(cmd, line, resolve, raw0), ...extra];
}
// The rc files a client reads before its input; a line that also names one (so may write it) leaves it unknown (a name only known at run time).
function rcRecords(rc, line) {
  return (rc ?? []).flatMap((r) => [{ kind: 'sql', family: r.family, file: r.file, rc: true, ...(r.glob ? { ambiguous: true, words: [r.file] } : {}) }, ...(SQL_RC_MENTION.test(String(line)) ? [{ kind: 'sql', family: r.family, file: '$SQL_RC_UNKNOWN', rc: true }] : [])]);
}

function feedRecords(cmd, line, resolve, raw0) {
  if (!raw0) return [];
  return [...feedRecords1(cmd, line, resolve, raw0), ...rcRecords(raw0.rc, line)];
}
function feedRecords1(cmd, line, resolve, raw0) {
  const R = (w) => {
    if (typeof resolve !== 'function' || !w.includes('$')) return w;
    const e = resolve(w);
    return typeof e === 'string' && e !== '' && !/[$`\s]/.test(e) ? e : w;
  };
  const f = { files: raw0.files.map(R), groups: raw0.groups.map((g) => g.map(R)), computed: raw0.computed.map(R), raws: raw0.raws, pat: raw0.pat.map(R), unq: raw0.unq.map(R), ops: (raw0.ops ?? []).map(R) };
  const exact = [...new Set(f.files)];
  const computed = [...new Set(f.computed)].filter((w) => !exact.includes(w));
  const rec = (kind) => (w) => (hasExpansion(w) ? { kind, file: w, ambiguous: true, words: [w] } : { kind, file: w });
  // a computed producer's word quoted in the command (`grep '^(A|B)=' F`, `sed 's/^/x/'`) never globs: with no `$` / backtick it is the literal name it spells
  const pat = new Set(f.pat);
  // (`whole`: the file's text is the stream itself, split into words: one that cannot be read is refused like a script -- scannedSubs)
  const whole = new Set((raw0.whole ?? []).map(R));
  const lit0 = (w) => (hasExpansion(w) && !pat.has(w) && !/[$`]/.test(w) ? { kind: 'scan', file: w } : rec('scan')(w));
  const lit = (w) => (whole.has(w) ? { ...lit0(w), whole: true } : lit0(w));
  const out = [...exact.map(rec('shell')), ...computed.map(lit)];
  const raws = [cmd.raw, ...f.raws].filter((r) => typeof r === 'string' && r);
  const refuse = { kind: 'shell', file: out[0]?.file ?? '', ambiguous: true, unresolvable: true, words: [] };
  if (out.length > MAX_FEED_FILES || raws.some((r) => hasPatternSyntax(r, line))) return [refuse];
  if (raw0.mixed && (f.files.length || f.computed.length)) return [refuse]; // (static text and files in one stream that cannot be rebuilt: see producedBy / producePieces)
  // Several files feed ONE program: the shell reads their texts one after the other, so they are ALSO judged joined (a record with `joined`), in
  // command-line order, repeats included (`cat a b` with `git pu` in a and `sh origin main` in b); each file is still judged on its own. Only a
  // single reader names them in an order that can be rebuilt: feeds from several producers (or a word that expands) are refused. A rewriting
  // producer's words are scanned joined as well (the order it prints them in is not known, so the caller looks at both orders).
  // Fail closed (review R1-B2 follow-up): when two or more file operands feed the program and ANY of them cannot be resolved to one exact file
  // (a glob, `$`, a substitution, a brace list, `~user`), the text the shell reads cannot be rebuilt, so the line is refused instead of
  // judging each word on its own (a guarded word split across a literal file and a glob / variable file escaped that way). Operands are
  // counted across the exact readers and the rewriting producers' file-role words (not their program text: `sed 's/$/x/' f`).
  const ops = new Set(f.ops);
  const rewritten = f.computed.filter((w) => pat.has(w) && ops.has(w));
  const unq = new Set(f.unq);
  if (f.files.length + rewritten.length >= 2 && (f.files.some((w) => opaqueFile(w, true)) || rewritten.some((w) => opaqueFile(w, unq.has(w))))) return [refuse];
  // Fail closed (review R2-B1): exact readers and rewriting producers feeding the SAME program (`{ cat a; tail -c 99 b; } | bash`) are one text
  // of which only the exact half can be rebuilt, so judging a alone and b scanned lets a guarded line split across them through. Any feed that
  // combines both kinds is refused, as are several producers of one kind.
  if (f.files.length >= 1 && f.computed.length >= 1) return [refuse];
  // a reader's operand that is itself a process substitution (`cat a <(tail -c 99 b) | bash`) is the text ANOTHER producer prints, not a file name
  if ([...f.files, ...f.computed].some(isProcSub)) return [refuse];
  // Why: static text and files in one stream (`{ echo "begin;"; cat m.sql; cat <<'SQL' ... SQL } | psql`) are judged as the text they make, in the order they run:
  // a record with `pieces` ({text} / {file}; a rewriting producer's words are {file} parts of a `scan` record). Refused when the order is not certain, a file
  // part is not one exact name, or exact and rewritten parts meet (as for several files below).
  const streams = (raw0.seqs ?? []).filter(hasTextPiece);
  // (`covered`: the streams hold every file that feeds the program, so the joins below would only repeat them without the static text)
  const inStreams = { files: [], scans: [] };
  if (streams.length && (f.files.length || f.computed.length)) {
    // (only a SQL client's stream is rebuilt, where just its shell escapes run: every such stream in 21 days fed psql. Text fed to a shell or an interpreter is
    // the program itself, and static text in it is refused as before -- owner, Codex review 4 of #50; a stream of more parts than MAX_FEED_FILES too)
    if (!raw0.sql || raw0.both || raw0.interp || raw0.unsure) return [refuse];
    if (streams.some((seq) => seq.length > MAX_FEED_FILES)) return [refuse];
    for (const seq of streams) {
      const parts = seq.map((p) => (Object.hasOwn(p, 'text') ? p : Object.hasOwn(p, 'file') ? { file: R(p.file) } : { scan: R(p.scan) }));
      const exactParts = parts.filter((p) => Object.hasOwn(p, 'file')).map((p) => p.file);
      const scans = parts.filter((p) => Object.hasOwn(p, 'scan')).map((p) => p.scan);
      if (!exactParts.length && !scans.length) continue;
      if (exactParts.length && scans.length) return [refuse];
      if (exactParts.length && raw0.unordered) return [refuse]; // (an exact stream cut short is another script; a scan of a rewritten one holds: see newSt)
      inStreams.files.push(...exactParts);
      inStreams.scans.push(...scans);
      if (exactParts.some((w) => opaqueFile(w, true) || isProcSub(w))) return [refuse];
      if (scans.some((w) => isProcSub(w) || (pat.has(w) && ops.has(w) && opaqueFile(w, unq.has(w))))) return [refuse];
      if (exactParts.length) out.push({ kind: 'shell', file: exactParts.join(' '), joined: exactParts, pieces: parts });
      else {
        // (a rewriting producer's program words and words that expand are left out of the join, as below)
        const kept = parts.filter((p) => !Object.hasOwn(p, 'scan') || !hasExpansion(p.scan)).map((p) => (Object.hasOwn(p, 'scan') ? { file: p.scan } : p));
        const names = kept.filter((p) => Object.hasOwn(p, 'file')).map((p) => p.file);
        if (names.length) out.push({ kind: 'scan', file: names.join(' '), joined: names, pieces: kept });
      }
    }
  }
  // (each side sorted once: sorting y again for every element was quadratic, 60,000 parts ran past the hook's 15 s limit -- Codex review 4)
  const same = (x, y) => { if (x.length !== y.length) return false; const a = [...x].sort(); const b = [...y].sort(); return a.every((w, i) => w === b[i]); };
  const covered = (inStreams.files.length || inStreams.scans.length) && same(inStreams.files, f.files) && same(inStreams.scans, f.computed);
  if (f.files.length >= 2 && !covered) {
    // Why: `{ cat a; cat b; } | bash`: the producers run one after the other, so the text is their files in the order the line names them (`cat a b`
    // is the same program). Refused when a job in the background makes the order unknown, or a file operand cannot be tied to one producer.
    const names = f.groups.flat();
    if (names.length !== f.files.length || (f.groups.length > 1 && raw0.unordered)) return [refuse];
    out.push({ kind: 'shell', file: names.join(' '), joined: names });
  }
  const words = f.computed.filter((w) => !hasExpansion(w));
  if (words.length >= 2 && !covered) out.push({ kind: 'scan', file: words.join(' '), joined: words });
  if (raw0.interp) for (const r of out) if (r.kind === 'shell') r.kind = 'interp';
  if (raw0.sql) for (const r of out) if (r.kind === 'shell') { r.kind = 'sql'; r.family = raw0.sql; }
  // a client outside the option allowlist may be a shell: its input is judged as a script too
  if (raw0.both) out.push(...out.filter((r) => r.kind === 'sql').map((r) => ({ ...r, kind: 'shell', family: undefined })));
  return out;
}

// ---- zsh glob qualifiers ----------------------------------------------------------------------------------

// Why: in zsh `ls *(e:'cmd':)` runs cmd for every match, `*(e{cmd})` and `*(e'cmd')` too (the first character after the e is the delimiter, a
// bracket closes with its partner), `*(+name)` runs the function or command name, and `oe` / `o+name` sort by running code. The group is
// part of the glob word, not a subshell. Whatever the qualifier grammar, the code follows an `e` + delimiter or a `+` + name, so every such
// place in the text between the parentheses is taken as code (more than zsh would: `(see|git)` yields the commands `git`; a harmless
// false reading). The delimiter's end is read both ways (the first partner, and the balanced one) and the text both as written and
// with the quotes removed, since the quoting decides which character the shell sees.
const BRACKETS = { '{': '}', '[': ']', '<': '>', '(': ')' };

function dequote(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'") { const j = str.indexOf("'", i + 1); out += str.slice(i + 1, j < 0 ? str.length : j); i = j < 0 ? str.length : j; }
    else if (c === '"') {
      for (i++; i < str.length && str[i] !== '"'; i++) {
        if (str[i] === '\\' && /["\\$`]/.test(str[i + 1] ?? '')) i++;
        out += str[i];
      }
    } else if (c === '$' && str[i + 1] === "'") { const r = readAnsiC(str, i + 1); out += r.text; i = r.next - 1; }
    else if (c === '\\' && i + 1 < str.length) out += str[++i];
    else out += c;
  }
  return out;
}

// Bounded: one linear pass (the balanced close of every bracket delimiter is looked up in a table built once per bracket kind, and the
// first-partner search resumes where the last one ended), `emit(code)` returns false to stop (the caller's cap), and `expired()` is polled
// as it goes. Returns true when it stopped early, so the caller can flag the parse truncated instead of scanning on.
function qualifierCodes(t, emit, expired = null) {
  const matches = new Map(); // open char -> Map(position of an open char -> position of its balanced close)
  const matchOf = (open, close) => {
    let m = matches.get(open);
    if (m) return m;
    m = new Map();
    const stack = [];
    for (let k = 0; k < t.length; k++) {
      if ((k & 4095) === 0 && expired?.()) { m.expired = true; break; }
      if (t[k] === open) stack.push(k);
      else if (t[k] === close && stack.length) m.set(stack.pop(), k);
    }
    matches.set(open, m);
    return m;
  };
  const firstClose = new Map(); // close char -> { from, at } of the last search (the first occurrence at or after `from`)
  const nextClose = (close, from) => {
    const last = firstClose.get(close);
    if (last && last.from <= from && (last.at < 0 || last.at >= from)) return last.at;
    const at = t.indexOf(close, from);
    firstClose.set(close, { from, at });
    return at;
  };
  for (let p = 0; p < t.length; p++) {
    if ((p & 1023) === 0 && expired?.()) return true;
    if (t[p] === 'e' && p + 1 < t.length && !/[\w\s]/.test(t[p + 1])) {
      const open = t[p + 1];
      const close = BRACKETS[open] ?? open;
      const first = nextClose(close, p + 2);
      if (!emit(first < 0 ? t.slice(p + 2) : t.slice(p + 2, first))) return true;
      if (close !== open) {
        const m = matchOf(open, close);
        if (m.expired) return true;
        const q = m.get(p + 1) ?? -1;
        if (q >= 0 && q !== first && !emit(t.slice(p + 2, q))) return true;
      }
    } else if (t[p] === '+' && /[A-Za-z_]/.test(t[p + 1] ?? '')) {
      NAME_RE.lastIndex = p + 1;
      LONG_NAME_RE.lastIndex = p + 1;
      const name = NAME_RE.exec(t)[0];
      const long = LONG_NAME_RE.exec(t)[0];
      if (!emit(name)) return true;
      if (long !== name && !emit(long)) return true;
    }
  }
  return false;
}
const NAME_RE = /\w+/y;
const LONG_NAME_RE = /[^\s,)^|~#*?[\]<>'"`$;&(){}]+/y;

// ---- startup files ------------------------------------------------------------------------------------

// Why: a shell runs files before its script: bash $BASH_ENV (non-interactive), sh/dash/ksh $ENV, zsh $ZDOTDIR/.zshenv (default
// $HOME) always, .zprofile/.zlogin/.zlogout with -l and .zshrc with -i, bash --rcfile/--init-file when interactive. They are not
// named on the command, so `BASH_ENV=f.sh bash x.sh` ran f.sh unjudged. Strict on purpose: every POSIX-family shell gets both
// BASH_ENV and ENV (bash as sh, `--posix`), and an option that expands (`zsh $X -c`) could be -l or -i, so all zsh files count.
const NO_STARTUP = new Set(['fish', 'csh', 'tcsh']);
const VAR_DECLS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

// Why: `declare` / `typeset` / `local` attributes change the value a name holds: -l / -u lower / upper case it, zsh -L / -R / -Z pad or cut it to a width, -i
// evaluates it as arithmetic, -n makes it a reference. `transform`: 'lower' | 'upper' (applied to an assigned value); `unknown`: a value that cannot be
// worked out from the text. `bare`: names declared without a value (the attribute then applies to every later assignment, and to the current value).
export function declAttrs(argv) {
  const out = { transform: null, unknown: false, assigns: [], bare: [] };
  let lower = false;
  let upper = false;
  let ended = false;
  for (const a of argv.slice(1)) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && /^[-+][A-Za-z0-9]+$/.test(a)) {
      if (a[0] === '-') for (const ch of a.slice(1)) { if (ch === 'l') lower = true; else if (ch === 'u') upper = true; else if ('LRZin'.includes(ch)) out.unknown = true; }
      continue;
    }
    ended = true; // (options stop at the first name: `declare D=x -u` makes -u a bad name, D keeps its case)
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
    if (m) out.assigns.push([m[1], m[2]]);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) out.bare.push(a);
  }
  if (lower && upper) out.unknown = true;
  else out.transform = lower ? 'lower' : upper ? 'upper' : null;
  return out;
}
export const applyTransform = (value, transform) => (transform === 'lower' ? String(value).toLowerCase() : transform === 'upper' ? String(value).toUpperCase() : value);

// The options before the operand: login / interactive flags (zsh), `unknown` when one expands, and the rc files bash is given.
function startupOptions(argv, lit = new Set()) {
  const o = { login: false, interactive: false, unknown: false, rc: [] };
  let sawC = false;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') break;
    // `zsh $X -c`, `bash @(-l) -c`, `zsh ^x -c`: a word that expands (or globs) may become -l or -i unless it starts with a plain literal
    // character. Only script TEXT written out in quotes with no expansion (`sh -c '(cd d; make)'`) is exempt: an unquoted expansion can split into options
    if (/^[-+]/.test(t) ? hasExpansion(t) : !/^[A-Za-z0-9_.\/~]/.test(t) && !(sawC && lit.has(t))) o.unknown = true;
    if (t.length < 2 || (t[0] !== '-' && t[0] !== '+')) break;
    if (t.startsWith('--')) {
      if (t === '--login') o.login = true;
      else if (t === '--interactive') o.interactive = true;
      else if (t === '--rcfile' || t === '--init-file') { if (argv[i + 1] !== undefined) o.rc.push(argv[i + 1]); i++; } else if (/^--(?:rcfile|init-file)=/.test(t)) o.rc.push(t.slice(t.indexOf('=') + 1));
      continue;
    }
    if (t.includes('l')) o.login = true;
    if (t.includes('i')) o.interactive = true;
    if (t.includes('c')) sawC = true;
    if (/[oO]$/.test(t)) {
      const v = argv[++i] ?? '';
      if (hasExpansion(v)) o.unknown = true;
      if (/^login$/i.test(v)) o.login = true;
      if (/^interactive$/i.test(v)) o.interactive = true;
    }
  }
  return o;
}

// Values a startup variable may have for `cmd`: its own prefix (`BASH_ENV=f.sh bash`, `env BASH_ENV=f.sh bash`) replaces every other
// source; otherwise every bare or `export`/`declare`/... assignment anywhere on the line (exported or not, before or after,
// reached or not), `inherited(name)` (the policy's own variable tracking) and the hook's environment. Values are words as written.
function startupValues(cmd, cmds, name, env, inherited) {
  const own = cmd.env && Object.hasOwn(cmd.env, name) ? cmd.env[name] : undefined;
  if (own !== undefined && own !== '') return [own];
  const out = new Set(inherited(name));
  for (const c of cmds) {
    if (!c.argv.length) { if (Object.hasOwn(c.env, name)) out.add(c.env[name]); continue; }
    if (!VAR_DECLS.has(base(c.argv[0]))) continue;
    for (const w of c.argv.slice(1)) {
      const m = ASSIGN_RE.exec(w);
      if (m && m[1] === name) out.add(w.slice(m[0].length));
    }
  }
  for (const k of Object.keys(env ?? {})) if (k.toUpperCase() === name && typeof env[k] === 'string') out.add(env[k]);
  out.delete(undefined);
  out.delete('');
  return [...out];
}

// The shell a script run by path starts, from its first line: `#!/bin/bash -l` -> ['/bin/bash', '-l'], `#!/usr/bin/env -S bash -l` ->
// ['bash', '-l'], `#!/bin/zsh` -> ['/bin/zsh']. Null when it is not a shebang or the program is not a shell. Strict: the kernel hands the
// shell ONE argument, but every word after the program counts as an option, so a flag in any of them is seen.
export function shebangShell(text) {
  if (typeof text !== 'string' || !text.startsWith('#!')) return null;
  const tokens = text.slice(2).split(/\r?\n/, 1)[0].trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (base(tokens[0] ?? '') === 'env') {
    i = 1;
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^-[uC]$|^--(?:unset|chdir)$/.test(t)) i++; // options with a value
      else if (/^-S./.test(t) && !t.startsWith('--')) { tokens[i] = t.slice(2); break; } // `-Sbash -l`
      else if (!t.startsWith('-') && !ASSIGN_RE.test(t)) break;
    }
  }
  const prog = tokens[i];
  return prog !== undefined && SHELLS.has(base(prog)) ? [prog, ...tokens.slice(i + 1)] : null;
}

// The values PATH may have for `cmd` (words as written), where zsh looks up `=tool`: its own prefix replaces every other source, unless it
// refers to `$PATH` (`PATH=bin:$PATH cmd`), which stands for them; those are every assignment on the line, what the policy knows and the hook's environment.
export function pathValuesOf(cmd, cmds = [], { env = {}, inherited = () => [] } = {}) {
  const own = cmd?.env && Object.hasOwn(cmd.env, 'PATH') && cmd.env.PATH !== '' ? cmd.env.PATH : undefined;
  if (own !== undefined && !/\$\{?PATH\b/.test(own)) return [own];
  return [...new Set([...(own === undefined ? [] : [own]), ...startupValues({ env: {} }, cmds, 'PATH', env, inherited)])];
}

// What the line assigns to the startup variables, for the scripts it runs in this shell (`BASH_ENV=f.sh; source outer.sh`): {NAME: [values]}.
export function startupVarsOf(cmds, { env = {}, inherited = () => [] } = {}) {
  const out = {};
  for (const n of ['BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME']) out[n] = startupValues({ env: {} }, cmds, n, env, inherited);
  return out;
}

// The startup files the shell `cmd` runs, as script-file records ({kind:'shell'}; a value with `$` / a backtick is ambiguous, so
// the callers refuse it when the line mentions a guarded operation / protected path, like a script named at run time).
// `cmds`: the commands of the line (for assignments elsewhere on it); `env`: the hook's environment; `inherited(name)`: values the
// policy already knows (array; `$NAME` stands for one it cannot know); `exec`: a program run by path, which may be a shell script.
// `implicit: true` marks the default $HOME/.zshenv, which no word on the line names.
export function startupFilesOf(cmd, cmds = [], { env = {}, inherited = () => [], exec = false } = {}) {
  const argv = cmd?.argv;
  if (!argv?.length) return [];
  const name = base(argv[0]);
  const shell = SHELLS.has(name) && !NO_STARTUP.has(name);
  if (!shell && !exec) return [];
  const out = [];
  // home: the file is the real home's (its directory is the environment's HOME): judged like the implicit one as far as programs the guard does not model go (see sourcedTexts)
  const add = (file, implicit = false, home = false) => {
    if (file === '' || out.some((o) => o.file === file)) return;
    const rec = /[$`]/.test(file) ? { kind: 'shell', file, ambiguous: true, words: [file] } : { kind: 'shell', file };
    if (home) rec.home = true;
    out.push(implicit ? { ...rec, implicit: true } : rec);
  };
  const isHome = (d) => typeof env.HOME === 'string' && env.HOME !== '' && !/[$`~]/.test(d) && d.replace(/\/+$/, '') === env.HOME.replace(/\/+$/, '');
  const values = (n) => startupValues(cmd, cmds, n, env, inherited);
  for (const n of ['BASH_ENV', 'ENV']) for (const v of values(n)) add(v);
  const opts = shell ? startupOptions(argv, cmd.litWords) : { login: false, interactive: false, unknown: false, rc: [] };
  for (const r of opts.rc) add(r);
  const dirOf = (d) => d.replace(/\/+$/, '');
  const ownHome = cmd.env && Object.hasOwn(cmd.env, 'HOME') && cmd.env.HOME !== '' ? cmd.env.HOME : null;
  // $HOME as the child sees it: its own prefix, else every value the line gives it, else the real home (judged too: an agent may have written it)
  const homes = ownHome === null ? [...values('HOME'), '~'] : [ownHome];
  if (exec) {
    // (the shebang is not read here: a zsh script run by path gets .zshenv from the ZDOTDIR / HOME the line names; the real home is not judged for it)
    for (const d of [...values('ZDOTDIR'), ...homes.filter((h) => h !== '~')]) add(`${dirOf(d)}/.zshenv`, false, isHome(d));
    return out;
  }
  if (name === 'zsh') {
    const zNames = ['.zshenv'];
    if (opts.login || opts.unknown) zNames.push('.zprofile', '.zlogin', '.zlogout');
    if (opts.interactive || opts.unknown) zNames.push('.zshrc');
    const own = cmd.env && Object.hasOwn(cmd.env, 'ZDOTDIR') && cmd.env.ZDOTDIR !== '' ? [cmd.env.ZDOTDIR] : null;
    for (const d of own ?? [...values('ZDOTDIR'), ...homes]) for (const z of zNames) add(`${dirOf(d)}/${z}`, d === '~' && !own, isHome(d));
    return out;
  }
  // bash and the POSIX shells: a login shell reads the profile files (bash the first of three: all are judged), an interactive one
  // ~/.bashrc (and $ENV, above); strict: the union for every one of them, since sh may be bash and bash may run as sh
  const names = [];
  if (opts.login || opts.unknown) names.push('.bash_profile', '.bash_login', '.profile', '.bash_logout');
  if (opts.interactive || opts.unknown) names.push('.bashrc');
  for (const h of homes) for (const n of names) add(`${dirOf(h)}/${n}`, h === '~', isHome(h));
  return out;
}

// ---- the parser ---------------------------------------------------------------------------------

// Does the `(` at s[i] open a zsh alternation `(a|b)`: a group with a `|` at some level, no blank, and no substitution, quote or operator inside?
function zshAlternationAt(s, i) {
  let depth = 0;
  let bar = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '(') depth++;
    else if (c === ')') { if (--depth === 0) return bar; }
    else if (c === '|') bar = true;
    else if (/[\s;&<>`$'"\\]/.test(c)) return false;
  }
  return false;
}

// Why: the stream rebuild (producePieces) takes echo / printf / cat for the shell's own; a line that can make a name run something else -- an alias, a builtin turned
// off (enable -n, zsh disable), zsh's functions / aliases / builtins tables (`functions[echo]=:`, `read -A aliases`), autoload, a sourced or eval'd text, a trap --
// switches the rebuild off for the whole line (as does any function it defines: ctx.fns). Codex review 4 of #50; the owner chose this over chasing each name.
const REDEF_CMDS = new Set(['alias', 'unalias', 'enable', 'disable', 'functions', 'unfunction', 'unhash', 'autoload', 'source', '.', 'eval', 'emulate', 'zmodload', 'trap']);
const REDEF_TABLE = /^(?:dis_)?(?:functions|functions_source|aliases|galiases|saliases|builtins|reswords)(?:\[|\+?=|$)/;
function noteRedef(ctx, argv, env) {
  if (!ctx.defs || ctx.defs.redef) return;
  if (argv.length && REDEF_CMDS.has(base(argv[0]))) ctx.defs.redef = true;
  else if (argv.some((w) => REDEF_TABLE.test(w)) || Object.keys(env ?? {}).some((k) => REDEF_TABLE.test(k))) ctx.defs.redef = true;
}

function emit(ctx, argv, env, raw, depth, redirects = [], sep = ';') {
  noteRedef(ctx, argv, env);
  if (ctx.out.length >= MAX_COMMANDS) { ctx.truncated = true; ctx.stopped = true; return null; }
  const cmd = { argv, env, raw, depth, redirects };
  // grp: the subshells (`$( )`, `( )`, backticks, `<( )`) it runs inside, outermost first, as ids: a cd in one is lost when it ends. Not enumerable
  Object.defineProperty(cmd, 'grp', { value: ctx.grp, enumerable: false });
  // ctl: it is in a loop (may run again after a later command), a function body or a trap action (runs when called / when the signal fires: maybe after any command),
  // an if / case branch (cond: may not run; loops, function bodies and traps may not either). Not enumerable
  Object.defineProperty(cmd, 'ctl', { value: ctlMarks(ctx.ctl), enumerable: false });
  // sep: the operator before it (; & && || |), for callers that care whether it surely runs; not enumerable, like `truncated`
  Object.defineProperty(cmd, 'sep', { value: sep, enumerable: false });
  ctx.out.push(cmd);
  return cmd;
}

class Parser {
  constructor(ctx, src) {
    this.ctx = ctx;
    this.src = src;
    this.i = 0;
    this.queue = []; // finished segments waiting for their heredoc bodies before they are interpreted
    this.hd = []; // heredocs whose bodies start after the current line
    this.log = []; // every segment interpreted by this parser, in order
    this.lastStage = []; // segments of the previous pipeline stage (a simple command, or a whole (...) / { ...; } group)
    this.braceStack = []; // log positions where standalone { groups opened
    this.subAcc = []; // segments run by substitutions inside the word being lexed
    this.lastDqDyn = false;
    this.cmd = null; // the command object interpret() is working on
    this.comments = null; // [start, end] of each comment of this text, when asked for (see withoutComments)
    this.ctlFrom = []; // ctx.out length when each open construct opened
    this.ctlStack = []; // loops / function bodies / { groups open (see ctlOpen), for every nesting level of this text
    this.ctlBase = 0; // where the current level's entries start
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
  // Returns the segments that parse interpreted (used to find what a substitution prints).
  subParse(text, depth) {
    const ctx = this.ctx;
    if (depth > ctx.maxDepth) { ctx.truncated = true; return []; }
    const p = new Parser(ctx, text);
    try {
      p.parseTop(depth);
    } catch {
      ctx.truncated = true;
      try { p.drain(true); } catch { /* best effort */ }
    }
    return p.log;
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
    const mark = this.log.length;
    this.i += 2;
    this.inGroup(() => this.nestParse(depth + 1, { stopAtParen: true, noRedir: s[start] === '$' && s[this.i] === '(' }));
    this.subAcc.push(...this.log.slice(mark));
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
    this.subAcc.push(...this.inGroup(() => this.subParse(body, depth + 1)));
    return s.slice(start, this.i);
  }

  // End (just past the closing brace) of the plain parameter expansion `${...}` at `from`, or -1 when it holds anything lexed as code
  // (`$(`, `<(`, `>(`, `=(`, backticks, `$'`, a newline) or never closes: those take the ordinary path. Quotes and `\` inside are skipped; `${` nests.
  paramSpan(from) {
    const s = this.src;
    const n = s.length;
    let depth = 0;
    for (let j = from; j < n; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === '`' || c === '\n') return -1;
      if ((c === '<' || c === '>' || c === '=') && s[j + 1] === '(') return -1; // <(cmd) >(cmd) =(cmd) run code in the operand word
      if (c === '$') {
        const nx = s[j + 1];
        if (nx === '(' || nx === "'") return -1;
        if (nx === '{') { depth++; j++; }
        continue;
      }
      if (c === "'") { j = s.indexOf("'", j + 1); if (j < 0) return -1; continue; }
      if (c === '"') {
        for (j++; j < n && s[j] !== '"'; j++) {
          if (s[j] === '\\') j++;
          else if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return -1;
        }
        if (j >= n) return -1;
        continue;
      }
      if (c === '}' && --depth === 0) return j + 1;
    }
    return -1;
  }

  // Body of a double-quoted string (this.i is just past the opening quote). Substitutions run inside it.
  // Sets this.lastDqDyn when something inside is only known at run time ($VAR, $(...), backticks).
  readDq(depth) {
    const s = this.src;
    const n = s.length;
    let out = '';
    let dyn = false;
    while (this.i < n && !this.ctx.stopped) {
      const c = s[this.i];
      const nx = s[this.i + 1];
      if (c === '"') { this.i++; break; }
      if (c === '\\') {
        if (nx === undefined) { out += '\\'; this.i++; }
        else if (nx === '\n') this.i += 2;
        else if (nx === '\r' && s[this.i + 2] === '\n') this.i += 3;
        else if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { out += nx; this.i += 2; }
        else { out += '\\' + nx; this.i += 2; }
      } else if (c === '$' && nx === '(') { dyn = true; out += this.substitution(depth); }
      else if (c === '`') { dyn = true; out += this.backtick(depth); }
      else {
        if (c === '$' && nx !== undefined && DYN_AFTER_DOLLAR.test(nx)) dyn = true;
        out += c;
        this.i++;
      }
    }
    this.lastDqDyn = dyn;
    return out;
  }

  // this.i is at the start of the lines after a command line that opened heredocs: consume the bodies.
  readHeredocs() {
    const s = this.src;
    let pos = this.i;
    for (const h of this.hd) {
      const lines = [];
      const bodyAt = pos;
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
      // Why: `<<-` strips the leading tabs of the body before the command reads it (`bash <<-'EOF'` + `\tgit pu\` + `\tsh origin main`: one push the tabs hid)
      const raw = lines.join('\n');
      const text = h.strip ? lines.map((l) => l.replace(/^\t+/, '')).join('\n') : raw;
      h.seg.heredocs.push({ text, quoted: h.quoted, lines: lines.length });
      // where the body sits in the line (see heredocSpans in simpleCommands): only for a body this parser read out of the line itself and that ended at
      // its terminator; one read out of another text (backticks, bash -c, a body's own substitution) or that ran to the end is not located.
      // The span covers the raw body as written (tabs included), not the stripped text
      if (found && this.src === this.ctx.rootSrc) this.ctx.hdSpans.push([bodyAt, bodyAt + raw.length, h.quoted]);
      else this.ctx.hdForeign = true;
      h.seg.pending--;
      if (h.seg.muted) continue;
      const grp = this.ctx.grp;
      this.ctx.grp = h.seg.grp; // (the body expands where its command runs: inside the subshells that command was written in)
      try {
        // No terminator: either a malformed command or a `<<` we mistook for a heredoc that then swallowed the rest
        // of the line. Parsing the body as script costs a false positive at worst, never a miss.
        if (!found) this.subParse(text, h.seg.depth + 1);
        // An unquoted heredoc still expands $(...) and backticks, so a body can run commands. Quoted ones are inert data.
        else if (!h.quoted) this.scanExpansions(text, h.seg.depth);
      } finally { this.ctx.grp = grp; }
    }
    this.hd = [];
    this.i = pos;
    this.drain(false);
  }

  // Runs the substitutions ($(...), backticks) found in `text` (a heredoc body or $[ ] arithmetic) as commands.
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
    const saved = this.subAcc;
    this.subAcc = [];
    const base = this.ctlBase;
    this.ctlBase = this.ctlStack.length;
    try { this.lex(depth, stopAtParen, noRedir); } finally {
      ctx.nest--; this.subAcc = saved;
      while (this.ctlStack.length > this.ctlBase) { const kind = this.ctlStack.pop(); this.ctlFrom.pop(); if (CTL_COUNTER[kind]) ctx.ctl[CTL_COUNTER[kind]]--; } // (left open: ends with the level)
      this.ctlBase = base;
    }
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
    let bm = []; // indexes in `cur` of unquoted { , } characters (brace expansion candidates)
    let wdyn = false; // the word contains an expansion that is only known at run time
    let wpat = false; // the word holds an UNQUOTED glob / pattern character (`*?[^#~`, or a glued group): the shell may expand it to file names
    let wsubs = []; // segments run by substitutions inside the word
    let wstart = 0; // source index where the word began
    let redir = null; // pending redirection whose target word comes next: 'file' | 'heredoc' | 'herestring'
    let rop = ''; // that redirection's operator
    let rfd = null; // and its explicit fd prefix
    let strip = false;
    let lit = 0; // inside the (...) of NAME=(...) array literals, or of a glob group (litGlob)
    let litGlob = false; // the group is a glob qualifier / pattern group: its | & ; < > are word characters
    let gRaw = 0; // source index just after the group's opening (
    let gCur = 0; // index in `cur` just after it
    let gGlob = false; // the word before the group holds a glob character
    let lastSep = ';';
    // `case` statements open at this level: st 'subj' (its word comes next), 'in', 'pat' (patterns up to `)` come next: no commands),
    // 'body' (an arm's commands, up to ;; ;& ;;& ;| or esac), 'end' (the esac word comes next). A stack: arms hold nested cases.
    const cs = [];
    let fnPending = false; // an empty `()` after names was just read: the next group is a function body

    const startSeg = () => {
      if (!inWord) wstart = this.i;
      if (!seg) {
        seg = {
          words: [], heredocs: [], herestrings: [], redirects: [], stdinSubs: [], stdinFile: false, stdinFiles: [], outSubs: [], fdFeeds: [], vf: ctx.varFeeds, fns: ctx.fns, defs: ctx.defs, cmd: null, meta: new Map(), win: new Map(),
          start: this.i, depth, pending: 0, muted, raw: '', final: null, groupStage: null, pat: new Set(), grp: ctx.grp, ctl: ctlMarks(ctx.ctl),
          pipedFrom: lastSep === '|' ? this.lastStage : null, sep: lastSep,
        };
      }
    };
    const mark = () => { if (qa < 0) qa = cur.length; inWord = true; };
    const takeSubs = () => {
      if (this.subAcc.length) { wsubs.push(...this.subAcc); this.subAcc.length = 0; }
    };
    const flushWord = () => {
      if (!inWord) return;
      const text = cur;
      const q = qa;
      const marks = bm;
      const dyn = wdyn;
      const pat = wpat;
      const subs = wsubs;
      const from = wstart;
      cur = '';
      inWord = false;
      qa = -1;
      bm = [];
      wdyn = false;
      wpat = false;
      wsubs = [];
      const mode = redir;
      redir = null;
      if (mode === 'file') {
        // >&2 / 2>&1 duplicate a descriptor: the target is recorded as &2 / &1 so it is not mistaken for a file name
        const dup = (rop === '>&' || rop === '<&') && /^(?:[0-9]+|-)$/.test(text);
        seg.redirects.push({ op: rop, target: dup ? '&' + text : text, fd: rfd });
        if (subs.length && text.startsWith('>(')) seg.outSubs.push(subs); // `cat f > >(bash)`: the substitution's commands read what this command writes
        // Why: `exec 3< f.sh; bash <&3`: a descriptor opened from a file earlier on the line (or a `{fd}<` named one) is read by the shell that gets it as stdin
        if ((rop === '<' || rop === '<>') && ((rfd !== null && rfd !== 0) || (rfd === null && /^\{[A-Za-z_]\w*\}$/.test(seg.words[seg.words.length - 1]?.text ?? '')))) {
          const e = newSt();
          if (subs.length && isProcSub(text)) subsProduced(subs, e, 1); else if (text !== '/dev/null') { e.files.push(text); e.groups.push([text]); }
          const prev = this.ctx.fdFeeds.get(rfd ?? '{}');
          this.ctx.fdFeeds.set(rfd ?? '{}', prev ? mergeSt(prev, e) : e);
        }
        if (rop === '<&' && (rfd === null || rfd === 0)) {
          const es = /^[0-9]+$/.test(text) ? [this.ctx.fdFeeds.get(Number(text))] : [...this.ctx.fdFeeds.values()];
          seg.stdinFile = true; // (a descriptor's contents are never known from this command alone: the dynamic rules apply)
          for (const e of [...es, this.ctx.fdFeeds.get('{}')]) if (e) { seg.stdinFiles.push(...e.files); seg.fdFeeds.push(e); }
        }
        if (rop === '<') {
          if (subs.length && isProcSub(text)) seg.stdinSubs.push(...subs);
          else seg.stdinFile = true;
        }
        // the file a command reads as stdin (`< F`, `<> F`; fd 0 only: `3< F` feeds nothing)
        if ((rop === '<' || rop === '<>') && (rfd === null || rfd === 0) && !isProcSub(text) && text !== '/dev/null') seg.stdinFiles.push(text);
        return;
      }
      if (mode === 'herestring') {
        seg.redirects.push({ op: '<<<', target: text, fd: rfd });
        seg.herestrings.push({ text, dyn, subs });
        return;
      }
      if (mode === 'heredoc') {
        seg.redirects.push({ op: '<<', target: null, fd: rfd });
        seg.pending++;
        this.hd.push({ delim: text, strip, quoted: q >= 0, seg });
        return;
      }
      let win;
      if (s.slice(from, Math.min(this.i, n)).includes('\\')) {
        const parts = splitArgsImpl(s.slice(from, Math.min(this.i, n)), true);
        if (parts.length === 1 && parts[0] !== text && WIN_PATH_RE.test(parts[0])) win = parts[0];
      }
      if (seg.words.length === 0 && q < 0) {
        if (text === '{') this.braceStack.push(this.log.length);
        else if (text === '}' && this.braceStack.length) seg.groupStage = this.log.slice(this.braceStack.pop()).filter((x) => x.depth === depth); // (see the ( ) group)
      }
      const top = cs[cs.length - 1];
      const cmdPos = seg.kwOnly !== false; // every word before this one is an unquoted keyword or `{` (kept as it goes: a rescan per word is quadratic)
      // (`time` and its options before a compound command: `time if ...; fi` -- review of #50)
      const timeOpt = seg.timePrefix === true && /^(?:-[A-Za-z]+|--)$/.test(text);
      seg.kwOnly = cmdPos && q < 0 && (KEYWORDS.has(text) || text === '{' || text === 'time' || timeOpt);
      seg.timePrefix = cmdPos && q < 0 && (text === 'time' || timeOpt);
      if (top?.st === 'subj') top.st = 'in';
      else if (top?.st === 'in') { if (q < 0 && text === 'in') top.st = 'pat'; else { cs.pop(); this.ctlClose(['case']); } } // `case x {` (zsh) and the like: patterns read as commands (strict)
      else if (q < 0 && cmdPos && text === 'esac' && (top?.st === 'body' || top?.st === 'end')) { cs.pop(); seg.closesFrom = this.ctlClose(['case']); }
      else if (q < 0 && cmdPos && text === 'esac') ctx.ctlBroken = true; // (an esac with no case we opened: a prefix we do not model hid it)
      else if (q < 0 && cmdPos && text === 'case') { cs.push({ st: 'subj' }); this.ctlOpen('case'); seg.ctl = { ...seg.ctl, cond: true }; }
      // loops, if / case branches and function bodies (see emit: ctl): `while`/`for`/... open a loop (its own words loop too), `done` closes one; `if`/`fi`, `case`/`esac` likewise; a `{` after `f()` (or
      // `function f`) opens a function body, any other command-position `{` a plain group; `}` closes the last of those
      // (`function NAME` -- after keywords or `time`, its `{` on this line or the next: every word up to the `{` / `(` is a name the text defines)
      let fnName = false;
      if (q < 0 && cmdPos && text === 'function') seg.fnActive = true;
      else if (seg.fnActive && text !== '{') { fnName = true; ctx.fns.add(text); seg.fnHasName = true; }
      const fnKw = text === '{' && seg.fnActive === true && seg.fnHasName === true;
      if (q < 0 && cmdPos && LOOP_WORDS.has(text)) { this.ctlOpen('loop'); seg.ctl = { ...seg.ctl, loop: true }; }
      else if (q < 0 && cmdPos && text === 'if') { this.ctlOpen('if'); seg.ctl = { ...seg.ctl, cond: true }; }
      else if (q < 0 && cmdPos && text === 'fi') seg.closesFrom = this.ctlClose(['if']);
      else if (q < 0 && cmdPos && text === 'done') seg.closesFrom = this.ctlClose(['loop']);
      else if (q < 0 && cmdPos && text === '}') seg.closesFrom = this.ctlClose(['fn', 'brace', 'cbrace']);
      else if (q < 0 && (cmdPos || fnKw) && text === '{') {
        // (a plain group after && / || runs only when that holds, and one that is a pipeline stage runs in a subshell: its commands may not run here -- review of #50)
        const kind = fnPending || fnKw ? 'fn' : ['&&', '||', '|'].includes(seg.sep) ? 'cbrace' : 'brace';
        this.ctlOpen(kind);
        if (kind === 'fn') seg.ctl = { ...seg.ctl, fn: true }; // (the body's first command is in this segment: `{ echo x > f; }`)
        if (kind === 'cbrace') seg.ctl = { ...seg.ctl, cond: true };
      }
      if (text === '{' || text === '(') seg.fnActive = false;
      fnPending = fnName && seg.fnActive === true; // (a name of `function NAME` ending the line: its body may open on the next)
      seg.words.push({ text, qa: q, bm: marks, dyn, subs, win, pat });
    };
    const endSeg = (idx) => {
      flushWord();
      redir = null;
      lit = 0; // an unclosed NAME=( must not keep swallowing whitespace after a real operator
      if (!seg) return;
      seg.raw = s.slice(seg.start, Math.min(idx, n)).trim();
      this.queue.push(seg);
      this.lastStage = seg.groupStage ?? [seg];
      seg = null;
      this.drain(false);
    };

    while (this.i < n && !ctx.stopped) {
      if (cs.length && cs[cs.length - 1].st === 'pat' && !inWord && lit === 0) {
        endSeg(this.i);
        lastSep = ';';
        const top = cs[cs.length - 1];
        this.caseGap();
        if (/^esac(?=$|[\s;&|()<>])/.test(s.slice(this.i, this.i + 5))) top.st = 'end'; // (the word itself is lexed as usual)
        else if (this.casePattern(depth)) top.st = 'body';
        else { cs.pop(); this.ctlClose(['case']); } // a pattern no shell accepts: what follows is read as commands, as before
        continue;
      }
      const c = s[this.i];
      if (lit > 0 && (isSpace(c) || c === '\n')) { cur += ' '; this.i++; continue; }
      if (lit > 0 && (c === '(' || c === ')')) {
        lit += c === '(' ? 1 : -1;
        if (litGlob && lit === 0) this.qualifierCode(s.slice(gRaw, this.i), cur.slice(gCur), depth, gGlob);
        cur += c; this.i++; continue;
      }
      if (lit > 0 && litGlob && (c === '|' || c === '&' || c === ';' || c === '<' || c === '>')) { cur += c; this.i++; continue; }

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
        const from = this.i;
        while (this.i < n && s[this.i] !== '\n') this.i++;
        if (this.comments) this.comments.push([from, this.i]);
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
        if (this.lastDqDyn) wdyn = true;
        takeSubs();
      } else if (c === '`') {
        startSeg(); inWord = true; wdyn = true;
        const n0 = this.subAcc.length;
        cur += this.backtick(depth);
        for (const x of this.subAcc.slice(n0)) x.split = true; // (unquoted: what it prints is split into words, see scannedSubs)
        takeSubs();
      } else if (c === '$') {
        startSeg();
        const nx = s[this.i + 1];
        if (nx === '(') { inWord = true; wdyn = true; const n0 = this.subAcc.length; cur += this.substitution(depth); for (const x of this.subAcc.slice(n0)) x.split = true; takeSubs(); }
        else if (nx === "'") { mark(); const r = readAnsiC(s, this.i + 1); cur += r.text; this.i = r.next; }
        else if (nx === '"') { mark(); this.i += 2; cur += this.readDq(depth); if (this.lastDqDyn) wdyn = true; takeSubs(); }
        else if (nx === '{' && this.paramSpan(this.i) > 0) {
          // `${f%%(*}`, `${x:-a b;c}`: one word; the ( ) ; | & and blanks inside the braces are not shell syntax
          const end = this.paramSpan(this.i);
          inWord = true; wdyn = true;
          const body = s.slice(this.i, end);
          // `${x:-(bash f.sh)}` is no command, but no body between parentheses is ever dropped: each balanced group is also judged
          // One pass with a stack of open positions (a rescan from every `(` is quadratic: 150,000 of them outlast the hook timeout, which reads as allow);
          // the evaluation's deadline is read as it goes. The groups are judged in the order of their opening parenthesis.
          const open = [];
          const groups = [];
          for (let k = 0; k < body.length; k++) {
            if ((k & 1023) === 0 && this.ctx.expired?.()) { this.ctx.stopped = true; this.ctx.truncated = true; break; }
            if (body[k] === '(') open.push(k);
            else if (body[k] === ')' && open.length) groups.push([open.pop(), k]);
          }
          groups.sort((a, b) => a[0] - b[0]);
          for (const [o, k] of groups) {
            if (this.ctx.stopped) break;
            if (body.slice(o + 1, k).trim()) this.subParse(body.slice(o + 1, k), depth + 1);
          }
          cur += body;
          this.i = end;
        } else if (nx === '[') {
          // $[ expr ] is old-style arithmetic: its << is a shift, never a heredoc
          inWord = true; wdyn = true;
          let d = 0;
          let j = this.i + 1;
          for (; j < n; j++) { if (s[j] === '[') d++; else if (s[j] === ']' && --d === 0) break; }
          cur += s.slice(this.i, Math.min(j + 1, n));
          this.scanExpansions(s.slice(this.i + 2, j), depth);
          this.i = Math.min(j + 1, n);
        } else { inWord = true; if (nx !== undefined && DYN_AFTER_DOLLAR.test(nx)) wdyn = true; cur += '$'; this.i++; }
      } else if (c === ';') {
        endSeg(this.i);
        lastSep = ';';
        const top = cs[cs.length - 1];
        const nx = s[this.i + 1];
        if (top?.st === 'body' && (nx === ';' || nx === '&' || nx === '|')) {
          // ;; ;& ;;& (bash) ;| (zsh) end an arm: patterns come next
          this.i += nx === ';' && s[this.i + 2] === '&' ? 3 : 2;
          top.st = 'pat';
        } else this.i++;
      } else if (c === '&') {
        const nx = s[this.i + 1];
        if (nx === '&') { endSeg(this.i); lastSep = '&&'; this.i += 2; }
        else if (nx !== '>' || noRedir) { flushWord(); const closed = seg?.closesFrom; endSeg(this.i); this.markClosedOut(closed); lastSep = '&'; this.i++; } // a background job: the command before it ran in a subshell
        else if (nx === '>' && !noRedir) {
          flushWord(); startSeg();
          redir = 'file'; rfd = null;
          if (s[this.i + 2] === '>') { rop = '&>>'; this.i += 3; } else { rop = '&>'; this.i += 2; }
        }
      } else if (c === '|') {
        const nx = s[this.i + 1];
        flushWord(); // (`}|cat`: the closing word first)
        const closed = seg?.closesFrom;
        endSeg(this.i);
        if (nx !== '|') this.markClosedOut(closed);
        if (nx === '|') { lastSep = '||'; this.i += 2; }
        else if (nx === '&') { lastSep = '|'; this.i += 2; }
        else { lastSep = '|'; this.i++; }
      } else if ((c === '<' || c === '>') && !noRedir) {
        if (s[this.i + 1] === '(') {
          startSeg(); inWord = true;
          cur += this.substitution(depth);
          takeSubs();
        } else {
          // an all-digit unquoted word glued to the operator is the fd number (2>&1), not an argument
          rfd = null;
          if (inWord && qa < 0 && /^[0-9]+$/.test(cur)) { rfd = Number(cur); cur = ''; inWord = false; bm = []; wdyn = false; wpat = false; wsubs = []; } else flushWord();
          startSeg();
          let j = this.i + 1;
          if (c === '>') {
            if (s[j] === '>' || s[j] === '&' || s[j] === '|') j++;
            rop = s.slice(this.i, j);
            redir = 'file';
          } else if (s[j] === '<') {
            if (s[j + 1] === '<') { j += 2; rop = '<<<'; redir = 'herestring'; }
            else { j++; strip = s[j] === '-'; if (strip) j++; rop = '<<'; redir = 'heredoc'; }
          } else {
            if (s[j] === '&' || s[j] === '>') j++;
            rop = s.slice(this.i, j);
            redir = 'file';
          }
          this.i = j;
        }
      } else if (c === '=' && !inWord && s[this.i + 1] === '(' && !noRedir) {
        // zsh `=(cmd)`: process substitution to a temp file, like <(cmd)
        startSeg(); inWord = true;
        cur += this.substitution(depth);
        takeSubs();
      } else if (c === '(') {
        if (!inWord && seg && seg.words.length > 0 && !seg.words.some((w) => w.qa < 0 && ['case', 'select'].includes(w.text)) && !seg.words.every((w) => LEAD_WORDS.has(w.text.toLowerCase())) && zshAlternationAt(s, this.i)) {
          // zsh `bash (f|x).sh`: after a command's words a `(` opens a glob group (an alternation), not a subshell (bash: a syntax error)
          startSeg(); inWord = true;
          lit = 1; litGlob = true; wpat = true; gGlob = false; cur += '('; this.i++; gRaw = this.i; gCur = cur.length;
        } else if (inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(cur) && (qa < 0 || qa >= cur.length)) {
          lit = 1; litGlob = false; cur += '('; this.i++; // NAME=(a b) array literal, not a subshell
        } else if (inWord && s[this.i + 1] !== ')' && !(seg && seg.words.length === 0 && qa < 0 && LEAD_WORDS.has(cur.toLowerCase()))) {
          // `*(e:'cmd':)`, `foo(+f)`, `*.(jpg|png)`: a glob group glued to a word is part of the word (and `f()` is a function definition)
          lit = 1; litGlob = true; wpat = true; gGlob = /[*?[]/.test(cur); cur += '('; this.i++; gRaw = this.i; gCur = cur.length;
        } else {
          flushWord();
          // `f ()`, `f()`, zsh `f g ()`, `function f ()`: the words before an empty `()` are names of functions, and the next `{ }` or `( )` is their body
          const head = /^\(\s*\)/.test(s.slice(this.i, this.i + 64)) && seg ? seg.words.filter((w, k) => !(k === 0 && w.qa < 0 && w.text === 'function')).map((w) => w.text) : null;
          const body = fnPending; // (this group is the body of the function named just before it)
          // (a subshell after && / || runs only when that holds, and one that is a pipeline stage runs apart: its commands may not run, as for a { } group (cbrace).
          // `{ cat a; true || (cat x); cat c; } | bash` runs a+c, which the join a+x+c hid)
          const cond = !body && !(seg && seg.words.length) && ['&&', '||', '|'].includes(lastSep);
          endSeg(this.i);
          lastSep = ';';
          this.i++;
          if (depth === 0) this.ctx.subshell = true; // ((...)) arithmetic too: conservative (and the `()` of `f()`: flowStart reads it as "from here on, maybe later")
          const mark0 = this.log.length;
          if (body) this.ctx.ctl.fn++;
          if (cond) this.ctx.ctl.cond++;
          try {
            this.inGroup(() => this.nestParse(depth, { stopAtParen: true, noRedir: noRedir || s[this.i] === '(' })); // ((...)) is arithmetic
          } finally { if (body) this.ctx.ctl.fn--; if (cond) this.ctx.ctl.cond--; }
          fnPending = false;
          if (head?.length) { for (const name of head) ctx.fns.add(name); fnPending = true; }
          // Why: the group's own commands print into the pipe; a substitution's body (`{ X=$(cat x); cat a; cat b; } | bash`, one level deeper) prints into its word, not the
          // stream, so it is no part of it (x's text in front of a+b hid a guarded line in the join)
          this.lastStage = this.log.slice(mark0).filter((x) => x.depth === depth);
        }
      } else if (c === ')') {
        endSeg(this.i);
        lastSep = ';';
        this.i++;
        if (stopAtParen) return;
      } else {
        startSeg();
        inWord = true;
        if (!(lit > 0 && litGlob) && ((c === '{' && !cur.endsWith('$')) || c === ',' || c === '}')) bm.push(cur.length); // (the cheap test first: endsWith flattens the word built so far)
        if (/[*?[^#~]/.test(c)) wpat = true;
        cur += c;
        this.i++;
      }
    }
    if (lit > 0 && litGlob) { this.ctx.dynamic = true; this.qualifierCode(s.slice(gRaw), cur.slice(gCur), depth, false); } // never closed: cannot be delimited
    endSeg(n);
  }

  // The code a glob group runs (see qualifierCodes): each string is parsed as commands one level deeper, like a `-c` string.
  qualifierCode(raw, deq, depth, wordGlob) {
    // The word may just as well be a subshell glued to a word (`{(bash f.sh); }`, `foo(bash f.sh)`), so the whole body is also parsed as commands:
    // nothing between the parentheses is ever dropped.
    if (raw.trim() && !(wordGlob && QUALIFIER_ONLY.test(raw))) this.subParse(raw, depth + 1);
    // Collected within the bound: never more than MAX_QUALIFIER_CODES distinct codes (and each is dequoted only once it is taken).
    const codes = new Set();
    let cut = false;
    let chars = 0;
    const take = (withDeq) => (code) => {
      if (code === '' || codes.has(code)) return true;
      if ((chars += code.length) > MAX_QUALIFIER_CHARS) return false;
      codes.add(code);
      if (withDeq) { const d = dequote(code); chars += d.length; codes.add(d); }
      codes.delete('');
      return codes.size <= MAX_QUALIFIER_CODES && chars <= MAX_QUALIFIER_CHARS;
    };
    const expired = this.ctx.expired;
    cut = qualifierCodes(raw, take(true), expired) || qualifierCodes(deq, take(false), expired);
    if (cut) { this.ctx.truncated = true; if (expired?.()) this.ctx.stopped = true; }
    let n = 0;
    for (const code of codes) {
      if (++n > MAX_QUALIFIER_CODES) break;
      if (expired?.()) { this.ctx.truncated = true; this.ctx.stopped = true; break; }
      this.subParse(code, depth + 1);
    }
  }

  // Blanks, newlines (with the heredoc bodies they start), line continuations and comments before a `case` arm's patterns.
  caseGap() {
    const s = this.src;
    const n = s.length;
    while (this.i < n) {
      const c = s[this.i];
      if (isSpace(c)) this.i++;
      else if (c === '\n') { this.i++; if (this.hd.length) this.readHeredocs(); }
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2;
      else if (c === '#') { while (this.i < n && s[this.i] !== '\n') this.i++; }
      else break;
    }
  }

  // Reads one `case` arm's patterns (`a|b)`, `(a)`, `"$r"/*)`) through the closing `)`: true when it did. Patterns are no commands, but the
  // substitutions in them run (parsed as commands here), and the body of a group (`@(a|b)`, `x(e:...:)`, zsh `=(...)`) is also judged like a glob
  // qualifier: nothing between parentheses is dropped. False, with this.i back where it was, for text no shell takes as a pattern list (two words
  // without a `|`, ; & < > or a newline before the `)`, the end of the text): the caller then reads it as commands, as before (strict).
  // Every scan is charged to the work budget: a failed scan is lexed again, and nested failures must not multiply unseen.
  casePattern(depth) {
    const ctx = this.ctx;
    const s = this.src;
    const n = s.length;
    const start = this.i;
    let i = start;
    const done = (ok) => {
      ctx.work += Math.max(i - start, 1);
      if (ctx.work > MAX_WORK) { ctx.stopped = true; ctx.truncated = true; }
      this.subAcc.length = 0;
      this.i = ok ? i : start;
      return ok;
    };
    if (s[i] === '(') i++;
    let d = 0;
    let word = false; // the current alternative has begun
    let gap = false; // a blank ended it: only | or ) may follow
    let gOpen = 0;
    while (i < n) {
      if (ctx.stopped || ((i & 1023) === 0 && ctx.expired?.())) { ctx.stopped = true; ctx.truncated = true; return done(false); }
      const c = s[i];
      if (d === 0 && isSpace(c)) { gap = word; i++; continue; }
      if (d === 0 && c === ')') { i++; return done(true); }
      if (d === 0 && c === '|') { word = false; gap = false; i++; continue; }
      if (gap || c === '\n' || c === ';' || c === '&' || c === '<' || c === '>') return done(false);
      word = true;
      if (c === '\\') i += 2;
      else if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? n : j + 1; }
      else if (c === '"' || (c === '$' && s[i + 1] === '"')) { this.i = i + (c === '$' ? 2 : 1); this.readDq(depth); i = this.i; }
      else if (c === '$' && s[i + 1] === '(') { this.i = i; this.substitution(depth); i = this.i; }
      else if (c === '`') { this.i = i; this.backtick(depth); i = this.i; }
      else if (c === '$' && s[i + 1] === "'") i = readAnsiC(s, i + 1).next;
      else if (c === '$' && s[i + 1] === '{' && this.paramSpan(i) > 0) i = this.paramSpan(i);
      else if (c === '(') { if (d++ === 0) gOpen = i + 1; i++; }
      else if (c === ')') { if (--d === 0) this.qualifierCode(s.slice(gOpen, i), s.slice(gOpen, i), depth, false); i++; }
      else i++;
    }
    return done(false);
  }

  // Interprets one finished simple command: strip keywords/assignments/wrappers, emit it, recurse into interpreters.
  finalize(seg) {
    if (seg.muted) return;
    this.log.push(seg);
    const grp = this.ctx.grp;
    const ctl = this.ctx.ctl;
    this.ctx.ctl = { loop: +seg.ctl.loop, fn: +seg.ctl.fn, trap: +seg.ctl.trap, cond: +seg.ctl.cond };
    this.ctx.grp = seg.grp; // (what it runs, `bash -c` text included, is in the subshells it was written in, wherever the queue finishes it)
    try {
      this.finalizeSeg(seg);
    } catch {
      // never lose the command to an unexpected failure: report its words as written and say we were cut short
      this.ctx.truncated = true;
      const argv = seg.words.map((w) => w.text);
      if (argv.length) emit(this.ctx, argv, {}, seg.raw, seg.depth, [...seg.redirects]);
    } finally { this.ctx.grp = grp; this.ctx.ctl = ctl; }
  }

  // A loop / function body / plain `{` group opens at this nesting level (closed by ctlClose, or when the level ends: see parseList).
  ctlOpen(kind) {
    this.ctlStack.push(kind);
    this.ctlFrom.push(this.ctx.out.length);
    if (CTL_COUNTER[kind]) this.ctx.ctl[CTL_COUNTER[kind]]++;
  }

  // Closes the last open construct of one of `kinds` at this level, and whatever was opened after it; nothing when there is none.
  ctlClose(kinds) {
    for (let k = this.ctlStack.length - 1; k >= this.ctlBase; k--) {
      if (!kinds.includes(this.ctlStack[k])) continue;
      const from = this.ctlFrom[k];
      while (this.ctlStack.length > k) { const kind = this.ctlStack.pop(); this.ctlFrom.pop(); if (CTL_COUNTER[kind]) this.ctx.ctl[CTL_COUNTER[kind]]--; }
      return from;
    }
    this.ctx.ctlBroken = true; // (a closer with no opener we saw: a prefix we do not model hid it (`nocorrect if ...`), so the marks are not to be trusted)
    return undefined;
  }

  // The commands of a construct that closed right before `|` or a background `&` ran in a subshell: they may not run in this shell (marked cond). Commands still
  // waiting for a heredoc are not out yet: the marks are then not to be trusted.
  markClosedOut(from) {
    if (from === undefined) return;
    if (this.queue.length) this.ctx.ctlBroken = true;
    for (const c of this.ctx.out.slice(from)) c.ctl.cond = true;
  }

  // Runs fn with one more subshell open (see emit: grp).
  inGroup(fn) {
    const saved = this.ctx.grp;
    this.ctx.grp = [...saved, ++this.ctx.grpN];
    try { return fn(); } finally { this.ctx.grp = saved; }
  }

  finalizeSeg(seg) {
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
    for (const w of seg.words) {
      if (w.pat) seg.pat.add(w.text);
      if (w.win !== undefined) seg.win.set(w.text, w.win);
      if (w.dyn || w.subs.length) {
        const m = seg.meta.get(w.text) ?? { dyn: false, subs: [] };
        m.dyn = m.dyn || w.dyn;
        m.subs.push(...w.subs);
        seg.meta.set(w.text, m);
      }
    }
    seg.final = { argv: [] };
    let last = null;
    for (const g of groups) last = this.finalizeGroup(g, seg) ?? last;
    if (seg.outSubs.length || seg.words.some((w) => w.subs.length && w.text.includes('>('))) this.feedOutSubs(seg);
    // Redirections belong to the command they were written on; a redirect with no command of its own
    // (`> file`, `{ a; } > file`, `(a) > file`) still has to reach the caller.
    if (last) last.redirects = [...seg.redirects];
    else if (seg.redirects.length) emit(this.ctx, [], {}, seg.raw, seg.depth, [...seg.redirects]);
  }

  // Returns the command object that was emitted for this group of words (or null).
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
      return emit(this.ctx, [], env, seg.raw, seg.depth, [], seg.sep);
    }
    for (; i < words.length; i++) {
      const a = assignOf(words[i]);
      if (!a) break;
      setEnv(env, a[0], a[1]);
    }
    for (let k = 0; k < words.length; k++) {
      // (the prefix assignments of a command are only in that command's environment, but `X=$(cat f) cmd` alone, `export X=$(cat f)` and `declare X=...` stay)
      if (k >= i && !(k > i && ['export', 'declare', 'typeset', 'local', 'readonly'].includes(words[i].text))) continue;
      const a = assignOf(words[k]);
      if (a && words[k].subs.length && (i >= words.length || k > i)) noteVarFeeds(this.ctx, a[0], words[k].subs);
    }
    if (i >= words.length) return Object.keys(env).length ? emit(this.ctx, [], env, seg.raw, seg.depth, [], seg.sep) : null;
    // brace expansion: {a,b} in an unquoted word becomes several words (assignment words before the command are exempt)
    const argv = [];
    for (const w of words.slice(i)) {
      if (w.bm.length >= 3 && this.ctx.braceWork <= MAX_BRACE_WORK) {
        const r = expandBraces(w.text, w.bm);
        if (r.over) this.ctx.truncated = true;
        this.ctx.braceWork += r.list.length + w.bm.length;
        if (w.pat) for (const x of r.list) seg.pat.add(x);
        argv.push(...r.list);
      } else {
        if (w.bm.length >= 3) this.ctx.truncated = true; // budget spent: left as written
        argv.push(w.text);
      }
    }
    return this.process(argv, env, seg, false);
  }

  // Replaces argv[0] by its backslash-preserving spelling when the word was a Windows path (C:\Git\git.exe).
  winFix(a, seg) {
    if (!a.length || seg.win.size === 0) return a;
    const w = seg.win.get(a[0]);
    return w === undefined ? a : [w, ...a.slice(1)];
  }

  process(argv, env, seg, isExec) {
    let a = this.winFix(argv, seg);
    let fan = null; // the xargs / parallel that built this command from stdin text
    for (let guard = 0; guard < 32 && a.length; guard++) {
      const un = unwrap(a);
      if (!un) break;
      if (!fan && (base(a[0]) === 'xargs' || base(a[0]) === 'parallel')) fan = a;
      for (const k of Object.keys(un.env)) setEnv(env, k, un.env[k]);
      a = this.winFix(un.argv, seg);
    }
    // Why: bash sets $BASH to its own path (zsh leaves it unset), so `"${BASH:-bash}" f.sh` runs f.sh with bash: read as bash, unless the text (or the environment) can bind
    // the name. Every other spelling (`$BASH f.sh` vanishes under zsh and runs f.sh itself) keeps its run-time head AND adds the bash / sh readings, so it is judged as strictly as either
    let bashAlso = null;
    if (a.length && BASH_WORD.test(a[0])) {
      if (this.ctx.bashPlain && BASH_DEFAULT.test(a[0])) { a = ['bash', ...a.slice(1)]; if (this.ctx.bashState) this.ctx.bashState.rewrote = true; }
      else bashAlso = a.slice(1);
    }
    // a command name that is only known at run time ($g push, $(echo git) push)
    const headDyn = a.length > 0 && (a[0].startsWith('$') || a[0].includes('$(') || a[0].includes('`'));
    if (headDyn) this.ctx.dynamic = true;
    const cmd = emit(this.ctx, a, env, seg.raw, seg.depth, [], seg.sep);
    if (bashAlso) for (const sh of ['bash', 'sh']) emit(this.ctx, [sh, ...bashAlso], env, seg.raw, seg.depth, [], seg.sep);
    if (cmd) Object.defineProperty(cmd, 'litWords', { value: new Set(a.filter((w) => !seg.meta.get(w)?.dyn && !seg.pat.has(w))), enumerable: false });
    if (!isExec) { seg.final = { argv: a }; seg.cmd = cmd; }
    // what the command prints and what it reads on stdin, for callers that ask which text a write of its output holds (see line-writes.mjs); lazy, most commands never need it
    if (cmd && !isExec) Object.defineProperty(cmd, 'streams', { value: () => streamsOf(seg, a), enumerable: false });
    if (fan && cmd && !isExec) this.fanOut(seg, fan, a, cmd);
    if (headDyn && cmd) {
      Object.defineProperty(cmd, 'headDyn', { value: true, enumerable: false });
      const hv = newSt();
      varFeedsInto(seg, a[0], hv); // `X=$(cat f.sh); $X`
      if (hv.dyn) this.ctx.dynamic = true;
      addFeeds(cmd, hv);
      // `$X < f.sh`, `cat f.sh | $X`: the program may be a shell reading its script from stdin
      const saved = this.cmd;
      this.cmd = cmd;
      try {
        // the files it reads, as a scan (refused only when they hold a guarded word: `$PSQL < q.sql` is data, `X="sh -s"; $X < f.sh` is a script); heredoc text is not judged here
        const src0 = stdinSource(seg);
        const st = src0.st;
        // (a heredoc / here-string / pipe text: a shell escape in it is a command of this line, in case the name is a database client)
        for (const text of src0.texts) { const e = sqlShellEscapes(text); if (e.length) this.subParse(e.join('\n'), seg.depth + 1); }
        const sqlSt = { ...st, files: [...st.files], groups: st.groups.map((g) => [...g]), computed: [...st.computed] };
        st.computed.push(...st.files);
        st.files.length = 0;
        st.groups.length = 0;
        // Why: kept apart from the other feeds so a caller that knows the command name is a data program (`$PSQL < q.sql`) can leave it out (scriptFeedsOf)
        const held = {};
        addFeeds(held, st);
        if (held.feeds) Object.defineProperty(cmd, 'headStdin', { value: held.feeds, enumerable: false });
        const heldSql = {};
        addFeeds(heldSql, sqlSt, 'any');
        Object.defineProperty(cmd, 'headDyn', { value: true, enumerable: false });
        if (heldSql.feeds) Object.defineProperty(cmd, 'headStdinSql', { value: heldSql.feeds, enumerable: false });
      } finally { this.cmd = saved; }
      // `$(cat f.sh)` as the command: the shell runs whatever the substitution prints
      const m = seg.meta.get(a[0]);
      const st = newSt();
      if (m) { subsProduced(m.subs, st, 1); scannedSubs(st); }
      addFeeds(cmd, st);
    }
    this.interpret(a, seg, cmd);
    return cmd;
  }

  // Why: `xargs -I{} sh -c '{}' < f.sh`, `xargs bash -c < f.sh`, `cat f.sh | xargs -0 sh -c`: xargs puts the text it reads into the command line of the shell, as the
  // script it runs (no operand after -c: the first word it reads; the replacement string among the script words: each line). Quote handling
  // and splitting change the text, so the files are scanned. `fan`: the xargs / parallel words, `argv`: the command it starts.
  fanOut(seg, fan, argv, cmd) {
    if (!SHELLS.has(base(argv[0]))) return;
    const r = shellInvocation(argv);
    const repl = new Set(['{}']);
    let argFile = null;
    for (let k = 1; k < fan.length; k++) {
      const t = fan[k];
      if ((t === '-I' || t === '-J') && fan[k + 1] !== undefined) repl.add(fan[k + 1]);
      else if (/^-[IJ]./.test(t) || /^--replace=./.test(t)) repl.add(t.startsWith('--') ? t.slice(10) : t.slice(2));
      else if (/^-i./.test(t)) repl.add(t.slice(2));
      if (t === '-a' || t === '--arg-file') argFile = fan[k + 1] ?? null;
      else if (/^-a./.test(t) && t[1] !== '-') argFile = t.slice(2);
      else if (t.startsWith('--arg-file=')) argFile = t.slice(11);
    }
    const parallel = base(fan[0]) === 'parallel';
    const fed = r.kind === 'none' || (r.kind === 'script' && (parallel ? /\{[^}]*\}/.test(r.text) : [...repl].some((x) => r.text.includes(x))));
    if (!fed) return;
    const src = stdinSource(seg);
    const st = src.st;
    for (const text of src.texts) this.subParse(text, seg.depth + 1);
    st.computed.push(...st.files);
    st.files.length = 0;
    st.groups.length = 0;
    if (argFile !== null) { st.computed.push(argFile); st.pat.add(argFile); st.ops.add(argFile); st.raws.push(seg.raw); }
    if (st.dyn || (src.unknown && !st.computed.length)) this.ctx.dynamic = true;
    addFeeds(cmd, st);
  }

  // Why: `tee >(bash) < f.sh`, `cat f.sh | tee >(bash)`, `cat f.sh > >(bash)`: the commands of an output process substitution read the stream of the command it is an
  // operand of (what that command reads on stdin, and what it prints). A shell among them gets those files as its script text, in every
  // position of the substitution's own pipeline (the stream is not rebuilt through its other stages).
  feedOutSubs(seg) {
    const subs = [...seg.outSubs.flat()];
    for (const w of seg.words) if (w.subs.length && w.text.includes('>(')) subs.push(...w.subs);
    const targets = subs.filter((x) => x.cmd?.stdinShell);
    if (!targets.length || !seg.final) return;
    const view = { ...seg, final: { argv: seg.final.argv } };
    const src = stdinSource(view);
    const out = newSt();
    if (base(seg.final.argv[0] ?? '') !== 'tee') producedBy(view, out); // (tee copies its stdin; its operands are the files it writes)
    const merged = mergeSt(src.st, out);
    // (a file operand of a producer is also its stdin file: once is enough, and an exact file is not also scanned)
    merged.computed = [...new Set(merged.computed)].filter((w) => !w.startsWith('>(') && !merged.files.includes(w));
    for (const t of targets) {
      if (merged.dyn || (src.unknown && !merged.files.length && !merged.computed.length)) this.ctx.dynamic = true;
      addFeeds(t.cmd, merged, t.cmd.sqlStdin || !!t.cmd.interpStdin);
    }
  }

  // `node < f.mjs`, `cat f.sh | python3`: an interpreter with no script operand reads its program from stdin
  runInterpStdin(seg) {
    const src = stdinSource(seg);
    markStdin(this.cmd, true);
    if (src.st.dyn || (src.unknown && !src.st.files.length && !src.st.computed.length)) this.ctx.dynamic = true;
    addFeeds(this.cmd, src.st, true);
  }

  // `psql < q.sql`, `cat q.sql | sqlite3 db`, `mysql -e '\! cmd'`, `psql -f q.sql`: the shell commands, writes and includes in the text a database client reads run like a script
  // line (sql-clients.mjs holds the model, shared with a client named by a variable). The files it reads are judged for those only; a text only known at run time
  // (`pg_dump | psql`) is a dynamic feed, refused with guarded text around. Outside the option allowlist the client may be anything: its stdin is a script.
  runSql(seg, argv, depth) {
    const fam = sqlFamilyOf(base(argv[0]));
    const plan = sqlClientPlan(fam, argv.slice(1), this.cmd?.env ?? {});
    const src = stdinSource(seg);
    markStdin(this.cmd, false, plan.modelled ? fam : false);
    for (const text of src.texts) {
      if (!plan.modelled) this.subParse(text, depth);
      const e = sqlShellEscapes(text, { family: plan.modelled ? fam : 'any' });
      if (e.length) this.subParse(e.join('\n'), depth);
    }
    if (plan.lines.length) this.subParse(plan.lines.join('\n'), depth);
    const st = src.st;
    for (const f of plan.files) { st.files.push(f); st.groups.push([f]); }
    if (st.dyn || (src.unknown && !st.files.length && !st.computed.length)) this.ctx.dynamic = true;
    addFeeds(this.cmd, st, plan.modelled ? fam : 'any');
    if (!plan.modelled && this.cmd?.feeds) this.cmd.feeds.both = true;
    // (the rc files it reads first: recorded even with no input at all)
    if (plan.rc.length && this.cmd) {
      if (!this.cmd.feeds) addFeeds(this.cmd, { ...newSt(), rcOnly: true }, plan.modelled ? fam : false);
      if (this.cmd.feeds && plan.modelled && !this.cmd.feeds.sql) this.cmd.feeds.sql = fam;
      this.cmd.feeds.rc.push(...plan.rc);
    }
  }

  // `bash /dev/fd/3`, `source /dev/fd/3`: the script is whatever the descriptor was opened from
  runFd(seg, word) {
    markStdin(this.cmd, false);
    const n = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/.exec(word)?.[1];
    const es = n === undefined ? [] : [this.ctx.fdFeeds.get(Number(n)), this.ctx.fdFeeds.get('{}')].filter(Boolean);
    if (!es.length) { this.ctx.dynamic = true; return; }
    for (const e of es) { addFeeds(this.cmd, e); if (e.dyn) this.ctx.dynamic = true; }
  }

  // The words of an interpreter's script: flag the run as dynamic if they hold run-time expansions, and
  // parse whatever a substitution among them prints (eval "$(cat <<'EOF' ... EOF)" runs the heredoc body).
  // `feed`: the words are script text (eval, -c), so the files a substitution among them reads are recorded on the command
  noteWords(seg, words, depth, feed = false) {
    let exact = words.length > 0;
    for (const w of words) {
      const m = seg.meta.get(w);
      if (!m) continue;
      if (m.dyn) this.ctx.dynamic = true;
      const st = newSt();
      for (const text of subsProduced(m.subs, st, 1)) this.subParse(text, depth);
      if (feed && st.dyn) this.ctx.dynamic = true;
      // (only files read as they are: a program's output is unknown text, and reading the word again keeps what that means -- it may cd, run anything)
      if (!st.files.length || st.computed.length || st.dyn) exact = false;
      if (feed && (words.length > 1 || m.subs.some((x) => x.split) || (w.match(/\$\(|`/g) ?? []).length !== 1 || !/^(?:\$\(|`)/.test(w) || !/[)`]$/.test(w))) { scannedSubs(st); exact = false; }
      if (feed) addFeeds(this.cmd, st);
    }
    return exact && words.every((w) => seg.meta.has(w));
  }

  runScript(seg, words, text, depth) {
    // Why: `eval "$(cat f)"`: the script is f's text, judged as it is (noteWords); read again, the text `$(cat f)` would be a command word, which is split (scanned)
    if (this.noteWords(seg, words, depth, true)) return;
    this.subParse(text, depth);
  }

  runStdin(seg, depth) {
    markStdin(this.cmd, false);
    const src = stdinSource(seg);
    for (const text of src.texts) this.subParse(text, depth);
    if (src.unknown) this.ctx.dynamic = true;
    addFeeds(this.cmd, src.st);
  }

  // bash <(cmd) / source <(cmd): the script is whatever cmd prints
  runProcessSub(seg, word, depth) {
    const m = seg.meta.get(word);
    const st = newSt();
    let found = 0;
    const subs = m ? m.subs : [];
    // (what the substitution prints is the script itself, one stream: recorded in order, see producePieces)
    for (const text of producePieces(subs, st, (s) => producedBy(s, st, 1, !subs.some((x) => x.pipedFrom?.includes(s))))) { found++; this.subParse(text, depth); }
    if (found === 0 || st.dyn) this.ctx.dynamic = true;
    addFeeds(this.cmd, st);
  }

  // `bash $X <(cmd)`: when a word before it expands, a process substitution among the words may be the script the shell runs
  maybeProcessSubs(seg, argv, depth, skip) {
    for (const w of argv.slice(1)) if (isProcSub(w) && w !== skip) this.runProcessSub(seg, w, depth);
  }

  tmux(argv, seg, depth) {
    let i = 1;
    while (i < argv.length && argv[i].length > 1 && argv[i][0] === '-') { // global options; -c runs a shell command
      if (argv[i] === '-c' && argv[i + 1] !== undefined) this.runScript(seg, [argv[i + 1]], argv[i + 1], depth);
      i += /^-[LSfcT]$/.test(argv[i]) ? 2 : 1;
    }
    const sub = argv[i];
    const keys = sub === 'send-keys' || sub === 'send';
    if (sub === undefined || (!keys && !TMUX_RUNNERS.has(sub))) return;
    const args = argv.slice(i + 1);
    let pos = args.slice(skipOpts(args, 0, keys ? 'tN' : 'tsncexyFlp'));
    if (keys) pos = pos.filter((w) => !TMUX_KEY_RE.test(w));
    if (!pos.length) return;
    this.runScript(seg, pos, pos.join(' '), depth);
    if (pos.length > 1) for (const w of pos) if (/\s/.test(w)) this.subParse(w, depth);
  }

  // PowerShell Start-Process / cmd start: the program (and its arguments) it launches
  startLauncher(argv, seg, name) {
    const toks = argv.slice(1);
    const psMode = name !== 'start' || toks.some((t) => /^-[A-Za-z]{2,}/.test(t));
    if (psMode) {
      let file = null;
      let args = null;
      const pos = [];
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.length > 1 && t[0] === '-') {
          const n = t.slice(1).toLowerCase();
          if ('filepath'.startsWith(n)) file = toks[++k] ?? null;
          else if ('argumentlist'.startsWith(n) || n === 'args') args = toks[++k] ?? null;
          else if (n.length >= 2 && PS_START_VALUED.some((v) => v.startsWith(n))) k++;
        } else pos.push(t);
      }
      if (file === null && pos.length) file = pos.shift();
      if (args === null && pos.length) args = pos.shift();
      if (file === null) return;
      const list = args === null ? [] : /\s/.test(args) ? splitArgs(args) : args.split(',');
      this.process([file, ...list.filter((x) => x !== '')], {}, seg, true);
      return;
    }
    let k = 0;
    while (k < toks.length && toks[k][0] === '/') k += /^\/(d|affinity|node)$/i.test(toks[k]) ? 2 : 1;
    const rest = toks.slice(k);
    if (!rest.length) return;
    if (rest[0] === '') { if (rest.length > 1) this.process(rest.slice(1), {}, seg, true); return; }
    this.process(rest, {}, seg, true);
    if (rest.length > 1) this.process(rest.slice(1), {}, seg, true); // the first word may have been a window title
  }

  // `cmd` is the command object emitted for `argv` (what it reads or is fed is recorded on it, see scriptFeedsOf)
  interpret(argv, seg, cmd = null) {
    const saved = this.cmd;
    this.cmd = cmd;
    try { this.interpretWords(argv, seg); } finally { this.cmd = saved; }
  }

  interpretWords(argv, seg) {
    if (!argv.length) return;
    const name = base(argv[0]);
    const depth = seg.depth + 1;
    if (SHELLS.has(name)) {
      const r = shellInvocation(argv);
      if (r.kind === 'script') this.runScript(seg, [r.text], r.text, depth);
      else if (r.kind === 'stdin') this.runStdin(seg, depth);
      else if (r.kind === 'file' && isProcSub(r.text)) this.runProcessSub(seg, r.text, depth);
      else if (r.kind === 'file' && FD_PATH.test(r.text)) this.runFd(seg, r.text);
      if (r.amb) this.maybeProcessSubs(seg, argv, depth, r.kind === 'file' ? r.text : undefined);
    } else if (name === 'source' || name === '.') {
      const op = argv[1];
      if (op === undefined) return;
      if (STDIN_FILES.has(op)) this.runStdin(seg, depth);
      else if (FD_PATH.test(op)) this.runFd(seg, op);
      else if (isProcSub(op)) this.runProcessSub(seg, op, depth);
      else this.noteWords(seg, [op], depth);
      if (hasExpansion(op) || op.startsWith('-')) this.maybeProcessSubs(seg, argv, depth, isProcSub(op) ? op : undefined);
    } else if (INTERPRETER.test(name) && interpReadsStdin(argv)) {
      this.runInterpStdin(seg);
    } else if (SQL_CLIENT_NAMES.has(name)) {
      this.runSql(seg, argv, depth);
    } else if (name === 'eval') {
      if (argv.length > 1) this.runScript(seg, argv.slice(1), argv.slice(1).join(' '), depth);
    } else if (name === 'trap') {
      // trap 'script' SIGNAL...: the first word runs as a script when the signal fires
      let k = 1;
      while (k < argv.length && (argv[k] === '-l' || argv[k] === '-p' || argv[k] === '--')) k++;
      if (argv.length - k >= 2 && argv[k] !== '-') {
        this.ctx.ctl.trap++;
        try { this.runScript(seg, [argv[k]], argv[k], depth); } finally { this.ctx.ctl.trap--; }
      }
    } else if (name === 'watch') {
      const i = skipOpts(argv, 1, 'n', ['--interval']);
      if (i < argv.length) this.runScript(seg, argv.slice(i), argv.slice(i).join(' '), depth); // watch runs its args via sh -c
    } else if (name === 'tmux') {
      this.tmux(argv, seg, depth);
    } else if (name === 'pwsh' || name === 'powershell') {
      const text = pwshInvocation(argv);
      if (text) this.runScript(seg, argv.slice(1), text, depth);
    } else if (name === 'iex' || name === 'invoke-expression') {
      const words = argv.slice(1).filter((w) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(w));
      if (words.length) this.runScript(seg, words, words.join(' '), depth);
    } else if (name === 'start-process' || name === 'saps' || name === 'start') {
      this.startLauncher(argv, seg, name);
    } else if (name === 'cmd') {
      const text = cmdInvocation(argv);
      if (text) this.runScript(seg, argv.slice(1), text, depth);
    } else if (name === 'find') {
      for (const sub of findExecs(argv)) this.process(sub, {}, seg, true);
    }
  }
}

function newCtx(maxDepth, expired, bashState) {
  return { out: [], expired, maxDepth, truncated: false, dynamic: false, subshell: false, grp: [], grpN: 0, ctl: { loop: 0, fn: 0, trap: 0, cond: 0 }, ctlBroken: false, fns: new Set(), defs: { redef: false }, stopped: false, muted: 0, nest: 0, work: 0, braceWork: 0, varFeeds: new Map(), fdFeeds: new Map(), bashPlain: false, bashState, rootSrc: null, hdSpans: [], hdForeign: false };
}

// The text with every comment the lexer skips blanked out (newlines kept), from a lexing pass that interprets nothing (muted); null when that pass did not
// read the whole text (a limit, an error): the caller keeps the text as it is.
function withoutComments(src, maxDepth, expired) {
  const ctx = newCtx(Math.min(Math.max(maxDepth, 0), HARD_MAX_DEPTH), expired, null);
  ctx.muted = 1;
  const p = new Parser(ctx, src);
  p.comments = [];
  try { p.parseTop(0); } catch { return null; }
  if (ctx.stopped || ctx.truncated) return null;
  let out = '';
  let at = 0;
  for (const [a, b] of p.comments) { out += src.slice(at, a) + ' '.repeat(b - a); at = b; }
  return out + src.slice(at);
}

export function simpleCommands(str, opts) {
  const requested = Number.isFinite(opts?.maxDepth) ? Math.trunc(opts.maxDepth) : 5;
  // opts.expired: () => true once the evaluation's wall-clock deadline has passed; scans that can run long poll it and give up (truncated)
  const expired = typeof opts?.expired === 'function' ? opts.expired : null;
  const bashState = opts?.bashState; // the evaluation's shared record of the BASH rewrite (see below)
  const ctx = newCtx(Math.min(Math.max(requested, 0), HARD_MAX_DEPTH), expired, bashState);
  let parser = null;
  try {
    parser = new Parser(ctx, String(str ?? ''));
    ctx.rootSrc = parser.src;
    // Why: every text of an evaluation (script, startup file, file the line wrote, heredoc body, nested frame) is parsed apart, but another text may bind BASH for the shell that runs this
    // one. The first text that can bind it ends the rewrite for every text after it; a text already rewritten before that is stale, and the policy reruns the evaluation (bashState.bound)
    // (a word in a comment is no binding: when the text looks like it binds BASH, it is checked again without the comments the lexer sees; any doubt keeps the first answer)
    const binds = bindsBash(parser.src) && bindsBash(withoutComments(parser.src, requested, expired) ?? parser.src);
    if (binds && bashState) bashState.bound = true;
    ctx.bashPlain = (opts?.env ?? process.env).BASH === undefined && !binds && !bashState?.bound;
    parser.parseTop(0);
  } catch {
    ctx.truncated = true;
    try { parser?.drain(true); } catch { /* best effort */ }
  }
  Object.defineProperty(ctx.out, 'truncated', { value: ctx.truncated, enumerable: false });
  Object.defineProperty(ctx.out, 'dynamic', { value: ctx.dynamic, enumerable: false });
  Object.defineProperty(ctx.out, 'subshell', { value: ctx.subshell, enumerable: false });
  // fns: every name the text defines as a function (`f()`, `function f`, zsh `f g ()`), wherever it is
  Object.defineProperty(ctx.out, 'fns', { value: ctx.fns, enumerable: false });
  // ctlBroken: the loop / branch / function marks (ctl) are not to be trusted (an unmatched closer, a construct finished out of order): callers read the line as before
  Object.defineProperty(ctx.out, 'ctlBroken', { value: ctx.ctlBroken, enumerable: false });
  // heredocSpans: [start, end, quoted] of every heredoc body in the text (quoted: its delimiter was quoted, so nothing in it expands), or null when one cannot be located (read out of other text, no terminator, a parse that gave up)
  Object.defineProperty(ctx.out, 'heredocSpans', { value: ctx.hdForeign || ctx.truncated ? null : ctx.hdSpans, enumerable: false });
  return ctx.out;
}

// Every redirection of every command, in order: [{op, target, fd}]. `target` is the redirect word with quotes
// removed (otherwise raw); `&1` / `&2` / `&-` for descriptor duplication / close; null for a heredoc.
export function allRedirects(commands) {
  const out = [];
  for (const c of commands ?? []) if (Array.isArray(c?.redirects)) out.push(...c.redirects);
  return out;
}
