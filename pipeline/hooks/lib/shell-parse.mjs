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
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'esac', 'coproc']);
// A word right before a ( that opens a subshell, a condition or arithmetic (`if(true)`, `for((i=0;;))`), not a glob qualifier group.
const LEAD_WORDS = new Set([...KEYWORDS, 'for', 'case', 'select', 'in', 'time', 'function', 'foreach', 'switch', 'catch', 'elseif', 'param', 'trap', 'return', 'exit', 'throw']);
// A group on a glob word that holds nothing but qualifier characters (`*(.)`, `*(^/)`, `*(om[1,3])`, `*(N)`) is not also read as a subshell.
const QUALIFIER_ONLY = /^[/.@=*%^,\-[\]\d#qpPrwxARWXsStNDnMTUGEIoOmacLlbY]*$/;
const MAX_QUALIFIER_CODES = 32; // code strings taken from the groups of one word; more than this and the parse is flagged truncated
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
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') { i++; break; }
    if (t.length < 2 || (t[0] !== '-' && t[0] !== '+') || (t[0] === '+' && !/^\+[A-Za-z]/.test(t))) break; // (`+(f|fa).sh` is a pattern operand, not an option)
    if (t.startsWith('--')) { i += t === '--rcfile' || t === '--init-file' ? 2 : 1; continue; }
    if (t[0] === '-' && t.includes('c')) sawC = true;
    if (t[0] === '-' && t.includes('s')) sawS = true;
    i += /[oO]$/.test(t) ? 2 : 1; // -o / -O take an option name
  }
  const before = argv.slice(1, i).some(hasExpansion);
  if (sawC) return i < argv.length ? { kind: 'script', text: argv[i], amb: before } : { kind: 'none' };
  if (sawS) return { kind: 'stdin', amb: before };
  if (i < argv.length) return STDIN_FILES.has(argv[i]) ? { kind: 'stdin', amb: before } : { kind: 'file', text: argv[i], amb: argv.slice(1, i + 1).some(hasExpansion) };
  return { kind: 'stdin', amb: argv.slice(1).some(hasExpansion) }; // `bash -$X` may be `bash -x f.sh`
}

// ---- script files -------------------------------------------------------------------------------

const INTERPRETER = /^(?:node|nodejs|deno|bun|tsx|ts-node|python\d*(?:\.\d+)*|ruby|perl|php)$/;
export const SCRIPT_EXT = /\.(?:m?[jt]s|cjs|jsx|tsx|py|rb|pl|php|sh|bash|zsh)$/i;
const SYSTEM_BIN = /^(?:\/usr)?(?:\/local)?\/(?:s?bin|libexec)\/|^\/opt\/homebrew\/s?bin\//;
// Flags that make an interpreter run inline code, a module or a test runner instead of a file.
const INLINE_FLAGS = new Set(['-e', '-E', '-p', '-c', '-m', '--eval', '--print', '--check', '--test', '--input-type']);
const INTERP_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '-W', '-X', '-I', '-x', '--env-file', '--title', '--max-old-space-size']);

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
const BINDERS = /(?<![\w.$/-])(?:read|declare|typeset|local|export|readonly|mapfile|readarray|getopts|unset|let|vared|zparseopts|printf|print|strftime|zstyle|sysread|zstat|getln|integer|float|select|set|autoload|compgen)(?![\w-])([^\n;&|<>]*)/g;
// Is BASH ever bound by the text? Fail closed: every mention that is not a plain reference counts (also with quotes taken out: `read B""ASH`), a binder
// whose operand name is not a plain word (`declare "${n}SH=x"`, `read -r "$v"`, `export $n=x`, `read BA{SH,}`), `(( $n = 1 ))`, eval, source / `.` (the sourced
// file may bind it), an ANSI-C string with an escape. A mention inside a quote or comment only makes this stricter.
// `(( $n = 1 ))`: a `((`, later a `$`, later an `=` on one line (first occurrences only: linear, a pattern with `[^\n]*` twice is not)
function arithAssignsByName(line) {
  const p = line.indexOf('((');
  const d = p < 0 ? -1 : line.indexOf('$', p);
  return d >= 0 && line.indexOf('=', d) >= 0;
}
function bindsBash(str) {
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

function scriptFileOfArgv(argv) {
  if (!argv.length) return null;
  const name = base(argv[0]);
  if (SHELLS.has(name)) {
    const r = shellInvocation(argv);
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
    return hasExpansion(argv[0]) ? { kind: 'exec', file: argv[0], ambiguous: true, words: [argv[0]] } : { kind: 'exec', file: argv[0] };
  }
  // `=tool`: zsh runs the file `tool` resolves to on PATH (the candidates are its PATH directories, see script-candidates.mjs)
  // `X=./evil.sh; $X`: a program named by a variable has no `/` to show it is a path
  if (/[$`]/.test(argv[0]) || EQUALS_WORD.test(argv[0])) return { kind: 'exec', file: argv[0], ambiguous: true, words: [argv[0]] };
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
const exactCopy = (name, argv) => name === 'cat' && argv.slice(1).every((w) => w === '-u' || w === '--' || w === '-' || w[0] !== '-');
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
const newSt = () => ({ dyn: false, unordered: false, files: [], groups: [], computed: [], raws: [], pat: new Set(), unq: new Set(), ops: new Set() });

// Adds what `b` collected to `a` (a descriptor opened twice, a variable assigned twice: both may be read).
function mergeSt(a, b) {
  const out = newSt();
  for (const x of [a, b]) {
    out.dyn = out.dyn || x.dyn;
    out.unordered = out.unordered || x.unordered;
    out.files.push(...x.files); out.groups.push(...x.groups); out.computed.push(...x.computed); out.raws.push(...x.raws);
    for (const k of ['pat', 'unq', 'ops']) for (const w of x[k]) out[k].add(w);
  }
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
  if (group.length && seg.sep === '&') st.unordered = true; // (a job in the background: the order it prints in, among the others, is not known)
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
    texts.push(hs.text);
    if (hs.dyn) st.dyn = true;
    texts.push(...subsProduced(hs.subs, st, 1));
    varFeedsInto(seg, hs.text, st);
  }
  { const t = subsProduced(seg.stdinSubs, st, 1); fedTexts += t.length; texts.push(...t); }
  const walk = (stage, hops) => {
    if (hops > 8) return;
    for (const p of stage) {
      const t = producedBy(p, st, 0, hops === 0);
      fedTexts += t.length;
      texts.push(...t);
      if (p.pipedFrom) walk(p.pipedFrom, hops + 1);
    }
  };
  if (seg.pipedFrom) walk(seg.pipedFrom, 0);
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
  if (!cmd.feeds) Object.defineProperty(cmd, 'feeds', { value: { files: [], groups: [], computed: [], raws: [], pat: [], unq: [], ops: [], rc: [], unordered: false, interp: false, sql: false }, enumerable: false });
  if (st.unordered) cmd.feeds.unordered = true;
  if (typeof interp === 'string') cmd.feeds.sql = interp;
  else if (interp) cmd.feeds.interp = true;
  cmd.feeds.pat.push(...st.pat);
  cmd.feeds.unq.push(...st.unq);
  cmd.feeds.ops.push(...st.ops);
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
  const out = { ...a, unordered: a.unordered || b.unordered, interp: a.interp || b.interp, sql: a.sql || b.sql };
  for (const k of ['files', 'groups', 'computed', 'raws', 'pat', 'unq', 'ops', 'rc']) out[k] = [...(a[k] ?? []), ...(b[k] ?? [])];
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
  const lit = (w) => (hasExpansion(w) && !pat.has(w) && !/[$`]/.test(w) ? { kind: 'scan', file: w } : rec('scan')(w));
  const out = [...exact.map(rec('shell')), ...computed.map(lit)];
  const raws = [cmd.raw, ...f.raws].filter((r) => typeof r === 'string' && r);
  const refuse = { kind: 'shell', file: out[0]?.file ?? '', ambiguous: true, unresolvable: true, words: [] };
  if (out.length > MAX_FEED_FILES || raws.some((r) => hasPatternSyntax(r, line))) return [refuse];
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
  if (f.files.length >= 2) {
    // Why: `{ cat a; cat b; } | bash`: the producers run one after the other, so the text is their files in the order the line names them (`cat a b`
    // is the same program). Refused when a job in the background makes the order unknown, or a file operand cannot be tied to one producer.
    const names = f.groups.flat();
    if (names.length !== f.files.length || (f.groups.length > 1 && raw0.unordered)) return [refuse];
    out.push({ kind: 'shell', file: names.join(' '), joined: names });
  }
  const words = f.computed.filter((w) => !hasExpansion(w));
  if (words.length >= 2) out.push({ kind: 'scan', file: words.join(' '), joined: words });
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

function qualifierCodes(t) {
  const out = [];
  for (let p = 0; p < t.length; p++) {
    if (t[p] === 'e' && p + 1 < t.length && !/[\w\s]/.test(t[p + 1])) {
      const open = t[p + 1];
      const close = BRACKETS[open] ?? open;
      const first = t.indexOf(close, p + 2);
      out.push(first < 0 ? t.slice(p + 2) : t.slice(p + 2, first));
      if (close !== open) {
        let depth = 1;
        let q = p + 2;
        for (; q < t.length; q++) { if (t[q] === open) depth++; else if (t[q] === close && --depth === 0) break; }
        if (q < t.length && q !== first) out.push(t.slice(p + 2, q));
      }
    } else if (t[p] === '+' && /[A-Za-z_]/.test(t[p + 1] ?? '')) {
      const name = /^\w+/.exec(t.slice(p + 1))[0];
      out.push(name);
      const long = /^[^\s,)^|~#*?[\]<>'"`$;&(){}]+/.exec(t.slice(p + 1))[0];
      if (long !== name) out.push(long);
    }
  }
  return out;
}

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
  const add = (file, implicit = false) => {
    if (file === '' || out.some((o) => o.file === file)) return;
    const rec = /[$`]/.test(file) ? { kind: 'shell', file, ambiguous: true, words: [file] } : { kind: 'shell', file };
    out.push(implicit ? { ...rec, implicit: true } : rec);
  };
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
    for (const d of [...values('ZDOTDIR'), ...homes.filter((h) => h !== '~')]) add(`${dirOf(d)}/.zshenv`);
    return out;
  }
  if (name === 'zsh') {
    const zNames = ['.zshenv'];
    if (opts.login || opts.unknown) zNames.push('.zprofile', '.zlogin', '.zlogout');
    if (opts.interactive || opts.unknown) zNames.push('.zshrc');
    const own = cmd.env && Object.hasOwn(cmd.env, 'ZDOTDIR') && cmd.env.ZDOTDIR !== '' ? [cmd.env.ZDOTDIR] : null;
    for (const d of own ?? [...values('ZDOTDIR'), ...homes]) for (const z of zNames) add(`${dirOf(d)}/${z}`, d === '~' && !own);
    return out;
  }
  // bash and the POSIX shells: a login shell reads the profile files (bash the first of three: all are judged), an interactive one
  // ~/.bashrc (and $ENV, above); strict: the union for every one of them, since sh may be bash and bash may run as sh
  const names = [];
  if (opts.login || opts.unknown) names.push('.bash_profile', '.bash_login', '.profile', '.bash_logout');
  if (opts.interactive || opts.unknown) names.push('.bashrc');
  for (const h of homes) for (const n of names) add(`${dirOf(h)}/${n}`, h === '~');
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

function emit(ctx, argv, env, raw, depth, redirects = [], sep = ';') {
  if (ctx.out.length >= MAX_COMMANDS) { ctx.truncated = true; ctx.stopped = true; return null; }
  const cmd = { argv, env, raw, depth, redirects };
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
    this.nestParse(depth + 1, { stopAtParen: true, noRedir: s[start] === '$' && s[this.i] === '(' });
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
    this.subAcc.push(...this.subParse(body, depth + 1));
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
      // No terminator: either a malformed command or a `<<` we mistook for a heredoc that then swallowed the rest
      // of the line. Parsing the body as script costs a false positive at worst, never a miss.
      if (!found) this.subParse(text, h.seg.depth + 1);
      // An unquoted heredoc still expands $(...) and backticks, so a body can run commands. Quoted ones are inert data.
      else if (!h.quoted) this.scanExpansions(text, h.seg.depth);
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
    try { this.lex(depth, stopAtParen, noRedir); } finally { ctx.nest--; this.subAcc = saved; }
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

    const startSeg = () => {
      if (!inWord) wstart = this.i;
      if (!seg) {
        seg = {
          words: [], heredocs: [], herestrings: [], redirects: [], stdinSubs: [], stdinFile: false, stdinFiles: [], outSubs: [], fdFeeds: [], vf: ctx.varFeeds, cmd: null, meta: new Map(), win: new Map(),
          start: this.i, depth, pending: 0, muted, raw: '', final: null, groupStage: null, pat: new Set(),
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
        else if (text === '}' && this.braceStack.length) seg.groupStage = this.log.slice(this.braceStack.pop());
      }
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
        if (this.lastDqDyn) wdyn = true;
        takeSubs();
      } else if (c === '`') {
        startSeg(); inWord = true; wdyn = true;
        cur += this.backtick(depth);
        takeSubs();
      } else if (c === '$') {
        startSeg();
        const nx = s[this.i + 1];
        if (nx === '(') { inWord = true; wdyn = true; cur += this.substitution(depth); takeSubs(); }
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
        this.i++;
      } else if (c === '&') {
        const nx = s[this.i + 1];
        if (nx === '&') { endSeg(this.i); lastSep = '&&'; this.i += 2; }
        else if (nx === '>' && !noRedir) {
          flushWord(); startSeg();
          redir = 'file'; rfd = null;
          if (s[this.i + 2] === '>') { rop = '&>>'; this.i += 3; } else { rop = '&>'; this.i += 2; }
        } else { endSeg(this.i); lastSep = '&'; this.i++; } // a background job: the command before it ran in a subshell
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
          endSeg(this.i);
          lastSep = ';';
          this.i++;
          if (depth === 0) this.ctx.subshell = true; // ((...)) arithmetic too: conservative
          const mark0 = this.log.length;
          this.nestParse(depth, { stopAtParen: true, noRedir: noRedir || s[this.i] === '(' }); // ((...)) is arithmetic
          this.lastStage = this.log.slice(mark0);
        }
      } else if (c === ')') {
        endSeg(this.i);
        lastSep = ';';
        this.i++;
        if (stopAtParen) return;
      } else {
        startSeg();
        inWord = true;
        if (((c === '{' && !cur.endsWith('$')) || c === ',' || c === '}') && !(lit > 0 && litGlob)) bm.push(cur.length);
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
    const codes = new Set();
    for (const code of qualifierCodes(raw)) { codes.add(code); codes.add(dequote(code)); }
    for (const code of qualifierCodes(deq)) codes.add(code);
    codes.delete('');
    let n = 0;
    for (const code of codes) {
      if (++n > MAX_QUALIFIER_CODES) { this.ctx.truncated = true; break; }
      this.subParse(code, depth + 1);
    }
  }

  // Interprets one finished simple command: strip keywords/assignments/wrappers, emit it, recurse into interpreters.
  finalize(seg) {
    if (seg.muted) return;
    this.log.push(seg);
    try {
      this.finalizeSeg(seg);
    } catch {
      // never lose the command to an unexpected failure: report its words as written and say we were cut short
      this.ctx.truncated = true;
      const argv = seg.words.map((w) => w.text);
      if (argv.length) emit(this.ctx, argv, {}, seg.raw, seg.depth, [...seg.redirects]);
    }
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
      if (this.ctx.bashPlain && BASH_DEFAULT.test(a[0])) a = ['bash', ...a.slice(1)];
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
      if (m) subsProduced(m.subs, st, 1);
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
    for (const w of words) {
      const m = seg.meta.get(w);
      if (!m) continue;
      if (m.dyn) this.ctx.dynamic = true;
      const st = newSt();
      for (const text of subsProduced(m.subs, st, 1)) this.subParse(text, depth);
      if (feed && st.dyn) this.ctx.dynamic = true;
      if (feed) addFeeds(this.cmd, st);
    }
  }

  runScript(seg, words, text, depth) {
    this.noteWords(seg, words, depth, true);
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
    for (const text of subsProduced(m ? m.subs : [], st, 1)) { found++; this.subParse(text, depth); }
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
      if (argv.length - k >= 2 && argv[k] !== '-') this.runScript(seg, [argv[k]], argv[k], depth);
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

export function simpleCommands(str, opts) {
  const requested = Number.isFinite(opts?.maxDepth) ? Math.trunc(opts.maxDepth) : 5;
  // opts.expired: () => true once the evaluation's wall-clock deadline has passed; scans that can run long poll it and give up (truncated)
  const expired = typeof opts?.expired === 'function' ? opts.expired : null;
  const ctx = { out: [], expired, maxDepth: Math.min(Math.max(requested, 0), HARD_MAX_DEPTH), truncated: false, dynamic: false, subshell: false, stopped: false, muted: 0, nest: 0, work: 0, braceWork: 0, varFeeds: new Map(), fdFeeds: new Map(), bashPlain: false };
  let parser = null;
  try {
    parser = new Parser(ctx, String(str ?? ''));
    ctx.bashPlain = (opts?.env ?? process.env).BASH === undefined && !bindsBash(parser.src);
    parser.parseTop(0);
  } catch {
    ctx.truncated = true;
    try { parser?.drain(true); } catch { /* best effort */ }
  }
  Object.defineProperty(ctx.out, 'truncated', { value: ctx.truncated, enumerable: false });
  Object.defineProperty(ctx.out, 'dynamic', { value: ctx.dynamic, enumerable: false });
  Object.defineProperty(ctx.out, 'subshell', { value: ctx.subshell, enumerable: false });
  return ctx.out;
}

// Every redirection of every command, in order: [{op, target, fd}]. `target` is the redirect word with quotes
// removed (otherwise raw); `&1` / `&2` / `&-` for descriptor duplication / close; null for a heredoc.
export function allRedirects(commands) {
  const out = [];
  for (const c of commands ?? []) if (Array.isArray(c?.redirects)) out.push(...c.redirects);
  return out;
}
