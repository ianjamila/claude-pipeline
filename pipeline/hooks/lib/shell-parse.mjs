// Why: the guard hooks must see EVERY simple command hidden in a compound Bash line (`a && b`, `$(...)`,
// `bash -c '...'`, `sudo env X=1 git ...`). A command missed here is a guard bypass; a command invented
// from quoted text blocks a harmless one. So this lexes like a shell (quotes, escapes, comments, heredocs)
// and recurses into every place a shell would execute text. Best effort, never throws; when a safety cap
// cuts parsing short the returned array carries a non-enumerable `truncated: true`, and when the command that
// runs is only known at run time (`bash -c "$X"`, `$g push`, `curl … | sh`) it carries `dynamic: true`, so callers can fail closed.
// Each command is {argv, env, raw, depth, redirects}; redirections are stripped from argv but recorded in `redirects`.

const MAX_COMMANDS = 500;
const MAX_NEST = 200; // in-place nesting of $( ), ( ), <( ) before we give up on the line
const MAX_WORK = 8_000_000; // total characters lexed across all recursive parses
const HARD_MAX_DEPTH = 50;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'esac', 'coproc']);
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
const base = (w) => String(w).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');

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

// A word whose value is only known at run time: `$VAR`, `$(..)`, backticks, or a glob. It may become no word, one
// word or several, so it hides which of the words after it is the script.
const EXPANDS = /[$`*?[]/;
const hasExpansion = (w) => EXPANDS.test(w);

// bash -c "script" / bash -lc ... / bash script.sh / bash (reads stdin)
// -s, `-`, /dev/stdin and /dev/fd/0 all mean "read the script from stdin".
// `amb`: a word up to the operand expands, so the operand found here may not be the one the shell picks.
function shellInvocation(argv) {
  let i = 1;
  let sawC = false;
  let sawS = false;
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--') { i++; break; }
    if (t.length < 2 || (t[0] !== '-' && t[0] !== '+')) break;
    if (t.startsWith('--')) { i += t === '--rcfile' || t === '--init-file' ? 2 : 1; continue; }
    if (t[0] === '-' && t.includes('c')) sawC = true;
    if (t[0] === '-' && t.includes('s')) sawS = true;
    i += /[oO]$/.test(t) ? 2 : 1; // -o / -O take an option name
  }
  if (sawC) return i < argv.length ? { kind: 'script', text: argv[i] } : { kind: 'none' };
  if (sawS) return { kind: 'stdin' };
  if (i < argv.length) return STDIN_FILES.has(argv[i]) ? { kind: 'stdin' } : { kind: 'file', text: argv[i], amb: argv.slice(1, i + 1).some(hasExpansion) };
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
// `ambiguous: true` (shells, source, interpreters): a word from argv[1] up to the operand expands at run time (`$X f.sh`,
// `$(..)`, a glob), so `file` is only a guess; `words` (argv[1..]) are the candidates, `needExt` says an interpreter
// only runs a file with a script extension. The caller expands what it can and judges every candidate.
export function scriptFileOf(argv) {
  if (!argv.length) return null;
  const name = base(argv[0]);
  if (SHELLS.has(name)) {
    const r = shellInvocation(argv);
    if (r.kind === 'file' && !r.text.startsWith('<(')) return r.amb ? { kind: 'shell', file: r.text, ambiguous: true, words: argv.slice(1) } : { kind: 'shell', file: r.text };
    return r.kind === 'stdin' && r.amb ? { kind: 'shell', file: undefined, ambiguous: true, words: argv.slice(1) } : null;
  }
  if (name === 'source' || name === '.') {
    const op = argv[1];
    if (op === undefined || STDIN_FILES.has(op) || op.startsWith('<(')) return null;
    return hasExpansion(op) ? { kind: 'shell', file: op, ambiguous: true, words: argv.slice(1) } : { kind: 'shell', file: op };
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
  if (/[/]/.test(argv[0]) && !argv[0].includes('\\') && !SYSTEM_BIN.test(argv[0])) return { kind: 'exec', file: argv[0] };
  return null;
}
const INTERPRETER_NO_EXT = new Set(['python', 'ruby', 'perl', 'php']);

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

// Static text a command writes to stdout (or hands a shell on stdin): its heredocs and here-strings, and what
// echo / printf print. `st.dyn` is set when any of it is only known at run time.
function producedBy(seg, st, hops = 0) {
  const out = [];
  if (hops > 6) return out;
  for (const h of seg.heredocs) out.push(h.text);
  for (const hs of seg.herestrings) {
    out.push(hs.text);
    if (hs.dyn) st.dyn = true;
    for (const sub of hs.subs) out.push(...producedBy(sub, st, hops + 1));
  }
  const pa = seg.final ? seg.final.argv : [];
  const pn = pa.length ? base(pa[0]) : '';
  if (pn === 'echo' || pn === 'printf') {
    for (const a of pa.slice(1)) {
      const m = seg.meta.get(a);
      if (!m) continue;
      if (m.dyn) st.dyn = true;
      for (const sub of m.subs) out.push(...producedBy(sub, st, hops + 1));
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
  const st = { dyn: false };
  const texts = [];
  for (const h of seg.heredocs) texts.push(h.text);
  let fed = seg.stdinSubs.length > 0 || (seg.pipedFrom !== null && seg.pipedFrom.length > 0);
  let fedTexts = 0;
  for (const hs of seg.herestrings) {
    texts.push(hs.text);
    if (hs.dyn) st.dyn = true;
    for (const sub of hs.subs) texts.push(...producedBy(sub, st, 1));
  }
  for (const sub of seg.stdinSubs) { const t = producedBy(sub, st, 1); fedTexts += t.length; texts.push(...t); }
  const walk = (stage, hops) => {
    if (hops > 8) return;
    for (const p of stage) {
      const t = producedBy(p, st, 0);
      fedTexts += t.length;
      texts.push(...t);
      if (p.pipedFrom) walk(p.pipedFrom, hops + 1);
    }
  };
  if (seg.pipedFrom) walk(seg.pipedFrom, 0);
  const unknown = (fed && fedTexts === 0) || seg.stdinFile || st.dyn;
  return { texts, unknown };
}

// ---- the parser ---------------------------------------------------------------------------------

function emit(ctx, argv, env, raw, depth, redirects = []) {
  if (ctx.out.length >= MAX_COMMANDS) { ctx.truncated = true; ctx.stopped = true; return null; }
  const cmd = { argv, env, raw, depth, redirects };
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
    let wsubs = []; // segments run by substitutions inside the word
    let wstart = 0; // source index where the word began
    let redir = null; // pending redirection whose target word comes next: 'file' | 'heredoc' | 'herestring'
    let rop = ''; // that redirection's operator
    let rfd = null; // and its explicit fd prefix
    let strip = false;
    let lit = 0; // inside the (...) of NAME=(...) array literals
    let lastSep = ';';

    const startSeg = () => {
      if (!inWord) wstart = this.i;
      if (!seg) {
        seg = {
          words: [], heredocs: [], herestrings: [], redirects: [], stdinSubs: [], stdinFile: false, meta: new Map(), win: new Map(),
          start: this.i, depth, pending: 0, muted, raw: '', final: null, groupStage: null,
          pipedFrom: lastSep === '|' ? this.lastStage : null,
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
      const subs = wsubs;
      const from = wstart;
      cur = '';
      inWord = false;
      qa = -1;
      bm = [];
      wdyn = false;
      wsubs = [];
      const mode = redir;
      redir = null;
      if (mode === 'file') {
        // >&2 / 2>&1 duplicate a descriptor: the target is recorded as &2 / &1 so it is not mistaken for a file name
        const dup = (rop === '>&' || rop === '<&') && /^(?:[0-9]+|-)$/.test(text);
        seg.redirects.push({ op: rop, target: dup ? '&' + text : text, fd: rfd });
        if (rop === '<') {
          if (subs.length && text.startsWith('<(')) seg.stdinSubs.push(...subs);
          else seg.stdinFile = true;
        }
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
      seg.words.push({ text, qa: q, bm: marks, dyn, subs, win });
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
        else if (nx === '[') {
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
        } else { endSeg(this.i); lastSep = ';'; this.i++; }
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
          if (inWord && qa < 0 && /^[0-9]+$/.test(cur)) { rfd = Number(cur); cur = ''; inWord = false; bm = []; wdyn = false; wsubs = []; } else flushWord();
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
      } else if (c === '(') {
        if (inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(cur) && (qa < 0 || qa >= cur.length)) {
          lit = 1; cur += '('; this.i++; // NAME=(a b) array literal, not a subshell
        } else {
          endSeg(this.i);
          lastSep = ';';
          this.i++;
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
        if ((c === '{' && !cur.endsWith('$')) || c === ',' || c === '}') bm.push(cur.length);
        cur += c;
        this.i++;
      }
    }
    endSeg(n);
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
      return emit(this.ctx, [], env, seg.raw, seg.depth);
    }
    for (; i < words.length; i++) {
      const a = assignOf(words[i]);
      if (!a) break;
      setEnv(env, a[0], a[1]);
    }
    if (i >= words.length) return Object.keys(env).length ? emit(this.ctx, [], env, seg.raw, seg.depth) : null;
    // brace expansion: {a,b} in an unquoted word becomes several words (assignment words before the command are exempt)
    const argv = [];
    for (const w of words.slice(i)) {
      if (w.bm.length >= 3 && this.ctx.braceWork <= MAX_BRACE_WORK) {
        const r = expandBraces(w.text, w.bm);
        if (r.over) this.ctx.truncated = true;
        this.ctx.braceWork += r.list.length + w.bm.length;
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
    for (let guard = 0; guard < 32 && a.length; guard++) {
      const un = unwrap(a);
      if (!un) break;
      for (const k of Object.keys(un.env)) setEnv(env, k, un.env[k]);
      a = this.winFix(un.argv, seg);
    }
    // a command name that is only known at run time ($g push, $(echo git) push)
    if (a.length && (a[0].startsWith('$') || a[0].includes('$(') || a[0].includes('`'))) this.ctx.dynamic = true;
    const cmd = emit(this.ctx, a, env, seg.raw, seg.depth);
    if (!isExec) seg.final = { argv: a };
    this.interpret(a, seg);
    return cmd;
  }

  // The words of an interpreter's script: flag the run as dynamic if they hold run-time expansions, and
  // parse whatever a substitution among them prints (eval "$(cat <<'EOF' ... EOF)" runs the heredoc body).
  noteWords(seg, words, depth) {
    for (const w of words) {
      const m = seg.meta.get(w);
      if (!m) continue;
      if (m.dyn) this.ctx.dynamic = true;
      const st = { dyn: false };
      for (const sub of m.subs) for (const text of producedBy(sub, st, 1)) this.subParse(text, depth);
    }
  }

  runScript(seg, words, text, depth) {
    this.noteWords(seg, words, depth);
    this.subParse(text, depth);
  }

  runStdin(seg, depth) {
    const src = stdinSource(seg);
    for (const text of src.texts) this.subParse(text, depth);
    if (src.unknown) this.ctx.dynamic = true;
  }

  // bash <(cmd) / source <(cmd): the script is whatever cmd prints
  runProcessSub(seg, word, depth) {
    const m = seg.meta.get(word);
    const st = { dyn: false };
    let found = 0;
    for (const sub of m ? m.subs : []) {
      for (const text of producedBy(sub, st, 1)) { found++; this.subParse(text, depth); }
    }
    if (found === 0 || st.dyn) this.ctx.dynamic = true;
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

  interpret(argv, seg) {
    if (!argv.length) return;
    const name = base(argv[0]);
    const depth = seg.depth + 1;
    if (SHELLS.has(name)) {
      const r = shellInvocation(argv);
      if (r.kind === 'script') this.runScript(seg, [r.text], r.text, depth);
      else if (r.kind === 'stdin') this.runStdin(seg, depth);
      else if (r.kind === 'file' && r.text.startsWith('<(')) this.runProcessSub(seg, r.text, depth);
    } else if (name === 'source' || name === '.') {
      const op = argv[1];
      if (op === undefined) return;
      if (STDIN_FILES.has(op)) this.runStdin(seg, depth);
      else if (op.startsWith('<(')) this.runProcessSub(seg, op, depth);
      else this.noteWords(seg, [op], depth);
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
  const ctx = { out: [], maxDepth: Math.min(Math.max(requested, 0), HARD_MAX_DEPTH), truncated: false, dynamic: false, stopped: false, muted: 0, nest: 0, work: 0, braceWork: 0 };
  let parser = null;
  try {
    parser = new Parser(ctx, String(str ?? ''));
    parser.parseTop(0);
  } catch {
    ctx.truncated = true;
    try { parser?.drain(true); } catch { /* best effort */ }
  }
  Object.defineProperty(ctx.out, 'truncated', { value: ctx.truncated, enumerable: false });
  Object.defineProperty(ctx.out, 'dynamic', { value: ctx.dynamic, enumerable: false });
  return ctx.out;
}

// Every redirection of every command, in order: [{op, target, fd}]. `target` is the redirect word with quotes
// removed (otherwise raw); `&1` / `&2` / `&-` for descriptor duplication / close; null for a heredoc.
export function allRedirects(commands) {
  const out = [];
  for (const c of commands ?? []) if (Array.isArray(c?.redirects)) out.push(...c.redirects);
  return out;
}
