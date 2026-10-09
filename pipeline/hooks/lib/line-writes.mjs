// Why (item h): `echo '<push main>' > n.sh; bash n.sh`, `cp f.sh n.sh; bash n.sh`, `curl -o n.sh URL; bash n.sh`: a script the line itself
// creates or overwrites before running it was judged on the file system as it is NOW (a missing file runs nothing, an existing one is
// judged on its old content). This module works out the WRITES of a line, in order, and what each may put in the file; the two policies
// ask `writtenTo(frames, P)` whenever they are about to judge a script file P and judge every content it returns, as well as P itself.
// - `writesOf(cmds)`: per command, the files it writes (a redirection, or a command that writes files: cp mv ln install rsync ditto tee dd
//   curl wget sed -i tar unzip git checkout ...) with the contents it may put there: a static text (echo / printf / heredoc), a source file
//   (cp A B, cat A > B, tee B < A), a file a rewriting command computes from (scan), or unknown.
// - A command that is not read-only and not modelled (make, npm run, a script ...) may have created ANY file: that matters only for a script
//   that is missing now (an existing harmless script is judged on its content; an unmodelled program overwriting it is a residual).
// - A write counts for a command when it comes before it on the line (strictly: even a conditional or background one), runs in the same
//   pipeline, races with a background job, or may repeat before it (a loop).
// Pure: the policies supply how to expand a word and where a command runs (see newWriteFrame).
import { commandName } from './shell-parse.mjs';

// ---- control flow -------------------------------------------------------------------------------------------

// The parser drops compound-command keywords but leaves them at the start of the command's raw text (`while ! gh …`,
// `do sleep 30`, `then git push`); `for` / `case` / `select` stay as the command name.
const FLOW_START = /^\s*(?:if|then|elif|else|while|until|for|do|case|select)(?=[\s;&|(){]|$)/;
// Index of the first command that may run conditionally or repeatedly because of control flow; every command from
// there on is treated that way (conservative after the loop / if ends). -1: none. 0: the whole line: a ( subshell, which
// the parser reports (it reads quotes, escapes, $'…' and heredocs like a shell, so prose such as `-m "fix (again)"` does
// not count), or a parse cut short, where a subshell may have gone unseen.
export function flowStart(cmds) {
  if (cmds.subshell || cmds.truncated) return 0;
  return cmds.findIndex((c) => FLOW_START.test(c.raw ?? '') || ['for', 'case', 'select'].includes(c.argv[0]));
}
export const inFlow = (from, i) => from >= 0 && i >= from;

// ---- static text ----------------------------------------------------------------------------------------------

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', '"': '"', "'": "'" };
const cp = (n) => { try { return String.fromCodePoint(n); } catch { return null; } };

// Reads the backslash escapes of printf / echo -e. mode: 'printf' (\NNN octal, 1-3 digits), 'echo' (\0NNN: a 0 and up to 3 digits, the bash / sh form).
// Every escape that can be read is read (\c stops the output there); `bad` is set when one cannot be read exactly (an unknown \X is kept or dropped
// depending on the shell), the text keeps it as written.
const ESCAPE = /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(0[0-7]{0,3}|[1-7][0-7]{0,2})|([\s\S]|$))/g;
function decodeEscapes(s, mode) {
  let out = '';
  let bad = false;
  let last = 0;
  ESCAPE.lastIndex = 0;
  for (let m = ESCAPE.exec(s); m; m = ESCAPE.exec(s)) {
    out += s.slice(last, m.index);
    last = ESCAPE.lastIndex;
    const [whole, x, u, U, o, c] = m;
    if (x !== undefined) out += String.fromCharCode(parseInt(x, 16));
    else if (u !== undefined || U !== undefined) {
      const ch = cp(parseInt(u ?? U, 16));
      if (ch === null) { bad = true; out += whole; } else out += ch;
    } else if (o !== undefined) {
      if (mode !== 'echo') out += String.fromCharCode(parseInt(o, 8) & 255);
      else if (o[0] === '0') out += String.fromCharCode(parseInt(o.slice(1) || '0', 8) & 255);
      else out += whole; // echo -e does not read \NNN: kept as written (the printf reading is judged too)
    } else if (c === 'c') return { text: out, bad, cut: true }; // stops the output
    else if (c !== undefined && SIMPLE_ESCAPES[c] !== undefined) out += SIMPLE_ESCAPES[c];
    else { bad = true; out += whole; } // an unknown \X, a trailing backslash
  }
  return { text: out + s.slice(last), bad };
}
const unescapeText = (s, mode) => { const r = decodeEscapes(s, mode); return r.bad || r.cut ? null : r.text; };

// What `printf FORMAT ARG...` prints, when it is certain: only %s and %% conversions (no flag, width or precision: %.4s truncates, %c, %d and %b
// compute) and escapes read exactly; the format is reused until the arguments are used up. '' for -v (assigns a variable, prints nothing).
// null: not certain, the caller treats the content as unknown.
export function printfText(argv) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '-') {
    if (argv[i] === '--') { i++; break; }
    if (argv[i] === '-v') return '';
    return null;
  }
  const fmt = argv[i] ?? '';
  const args = argv.slice(i + 1);
  if (/%(?!%|s)/.test(fmt.replace(/%%/g, ''))) return null;
  const body = unescapeText(fmt, 'printf');
  if (body === null) return null;
  // the format's own escapes are read first, so a %s that an escape produced (\x25s) is not mistaken for a conversion: it is not one in the shell either
  const parts = fmt.split(/(%%|%s)/);
  let out = '';
  let used = 0;
  for (let round = 0; round < 1000; round++) {
    let consumed = 0;
    for (const part of parts) {
      if (part === '%%') out += '%';
      else if (part === '%s') { consumed++; out += args[used++] ?? ''; } else {
        const u = unescapeText(part, 'printf');
        if (u === null) return null;
        out += u;
      }
    }
    if (consumed === 0 || used >= args.length) break;
  }
  return out;
}

// What `echo ARG...` may print: as written, and with escapes read (zsh and sh's echo read them by default, bash with -e; -E / no -e keep them):
// every reading is judged, and so is the \NNN octal form some echos read. `bad`: an escape could not be read exactly, so the text is not certain.
function echoTexts(argv) {
  let k = 1;
  while (k < argv.length && /^-[neE]+$/.test(argv[k])) k++;
  const raw = argv.slice(k).join(' ');
  const echo = decodeEscapes(raw, 'echo');
  const printf = decodeEscapes(raw, 'printf');
  const texts = [raw, echo.text, printf.text];
  return { texts: [...new Set([...texts, ...texts.map((x) => x + '\n')])], bad: echo.bad || printf.bad }; // (with and without the newline echo adds: -n drops it)
}

// ---- records ---------------------------------------------------------------------------------------------------

// A record: { idx, dest, items, copy?, link?, subtree?, inline? }
//   dest     the word naming what is written (null: anywhere)
//   copy     cp-like: the written path is `dest` or `dest/basename(source)`, and a source directory fills `dest` / `dest/basename(source)`
//   link     'sym' | 'hard': the source of a symlink is read relative to the link's directory
//   subtree  every file below `dest` may be written (tar -x, unzip, git clone ...)
//   inline   program text of node -e / python -c ...: it may write a file whose name it spells
// items: what the file may hold: { text } | { file: word } | { scan: word } (a file a rewriting command computes the text from) | { unknown: true }
const UNKNOWN = [{ unknown: true }];
const WRITE_OPS = new Set(['>', '>>', '>|', '>&', '&>', '&>>', '<>']);

const PURE = new Set([
  'echo', 'printf', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'ls', 'stat', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'shasum', 'sha256sum', 'sha1sum',
  'md5', 'md5sum', 'file', 'readlink', 'realpath', 'test', '[', '[[', 'cut', 'du', 'hexdump', 'sort', 'uniq', 'tr', 'jq', 'tree', 'xxd', 'find', 'date', 'basename', 'dirname',
  'expr', 'seq', 'pwd', 'which', 'type', 'sleep', 'true', 'false', ':', 'cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'shift', 'read',
  'wait', 'let', 'return', 'exit', 'break', 'continue', 'trap', 'alias', 'unalias', 'hash', 'mkdir', 'rm', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'kill', 'time',
  'for', 'case', 'select', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'esac', 'in', '!', '{', '}', 'sed', 'gsed', 'awk', 'gawk', 'mawk', 'nawk', 'gh', 'git',
  'get-content', 'get-childitem', 'gc', 'gci', 'write-host', 'write-output',
]);
// git subcommands that change the working tree in ways we do not follow (the files of a branch switch, a merge, a pull ...) or write named files
const GIT_TREE = new Set(['checkout', 'switch', 'restore', 'reset', 'merge', 'pull', 'rebase', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'clean', 'clone', 'worktree', 'submodule', 'checkout-index', 'read-tree', 'sparse-checkout', 'bisect', 'init', 'mv']);
const GIT_OUTPUT = new Set(['diff', 'log', 'show', 'format-patch', 'archive', 'bundle', 'shortlog', 'whatchanged', 'range-diff', 'diff-tree']);
// does the program text name this file (not as the tail of a longer name: test.mjs in shell-parse.test.mjs)?
export const namesFile = (text, base) => new RegExp(`(?<![\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
// program text that can write a file or start something that does
const CAN_WRITE = /write|append|rename|copy|\bcp\b|\bmv\b|\bln\b|truncate|symlink|open\s*\(|>>?|\btee\b|shutil|move|dump|save|\bsed\b|spawn|exec|system|subprocess|child_process|popen|Popen|require\(|import /i;
const WRITER_NAMES = new Set(['cp', 'mv', 'ln', 'install', 'ditto', 'rsync', 'tee', 'dd', 'curl', 'wget', 'sed', 'gsed', 'tar', 'bsdtar', 'gtar', 'unzip', 'git', 'perl', 'ruby']);
const PS_WRITERS = new Set(['set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item', 'tee-object', 'export-csv', 'invoke-webrequest', 'invoke-restmethod', 'sc', 'ac', 'ni', 'cpi', 'mi', 'iwr', 'irm']);
const INLINE_RUNNERS = { node: /^(?:-e|-p|--eval|--print)$/, nodejs: /^(?:-e|-p|--eval|--print)$/, deno: /^eval$/, bun: /^(?:-e|--eval)$/, python: /^-c$/, python3: /^-c$/, perl: /^-[A-Za-z]*e$/, ruby: /^-[A-Za-z]*e$/, php: /^-r$/ };

// curl: the short options that take a value (the rest are switches), the long options that name an output file, the long switches and value options we
// know. Anything else (an unknown long option, a config file -K, `-:` groups) is not certain: null, the command is unmodelled.
const CURL_SHORT_VALUE = 'AbcCdDeEFHKmoPQrtTuUwXxyYz';
const CURL_LONG_OUT = new Set(['output', 'dump-header', 'cookie-jar', 'trace', 'trace-ascii', 'stderr', 'etag-save', 'hsts', 'alt-svc', 'libcurl', 'output-dir']);
const CURL_LONG_VALUE = new Set(['header', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'request', 'user-agent', 'user', 'referer', 'max-time', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'form', 'form-string', 'write-out', 'proxy', 'proxy-user', 'upload-file', 'range', 'cookie', 'cacert', 'cert', 'key', 'url', 'resolve', 'connect-to', 'limit-rate', 'continue-at', 'time-cond', 'oauth2-bearer', 'json', 'variable', 'expand-url', 'aws-sigv4', 'interface', 'dns-servers', 'noproxy', 'proto', 'request-target', 'speed-limit', 'speed-time', 'max-filesize', 'max-redirs', 'tls-max', 'tlsv1', 'ciphers', 'pinnedpubkey', 'quote', 'telnet-option', 'ftp-port', 'unix-socket', 'etag-compare', 'happy-eyeballs-timeout-ms', 'max-redirs', 'keepalive-time', 'local-port', 'parallel-max', 'rate', 'retry-connrefused']);
const CURL_LONG_SWITCH = new Set(['silent', 'show-error', 'location', 'fail', 'insecure', 'head', 'include', 'verbose', 'compressed', 'globoff', 'remote-name', 'remote-name-all', 'remote-header-name', 'create-dirs', 'progress-bar', 'no-progress-meter', 'fail-with-body', 'location-trusted', 'get', 'http1.1', 'http2', 'http3', 'ipv4', 'ipv6', 'no-buffer', 'netrc', 'anyauth', 'basic', 'digest', 'negotiate', 'ntlm', 'tcp-nodelay', 'raw', 'path-as-is', 'show-headers', 'fail-early', 'parallel', 'parallel-immediate', 'no-keepalive', 'junk-session-cookies', 'ssl-reqd', 'ssl', 'tlsv1.2', 'tlsv1.3', 'disable', 'proxy-insecure', 'suppress-connect-headers', 'styled-output', 'xattr', 'remove-on-error', 'skip-existing', 'no-clobber', 'clobber', 'compressed-ssh', 'doh-insecure', 'ignore-content-length']);
function curlRecords(args, idx) {
  const out = [];
  const unknown = (dest, extra = {}) => ({ idx, dest, items: UNKNOWN, ...extra });
  let remote = false;
  let header = false;
  let outDir = '';
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { urls.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : null;
      if (nm === 'config' || nm === 'next') return null;
      if (CURL_LONG_OUT.has(nm)) {
        const v = val ?? args[++i] ?? '';
        if (nm === 'output-dir') outDir = v; else if (v !== '-' && v !== '') out.push(unknown(v));
      } else if (nm === 'remote-name' || nm === 'remote-name-all') remote = true;
      else if (nm === 'remote-header-name') { remote = true; header = true; } else if (CURL_LONG_VALUE.has(nm)) { if (val === null) i++; } else if (!CURL_LONG_SWITCH.has(nm)) return null; // not certain
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === ':' ) return null;
        if (ch === 'O') { remote = true; continue; }
        if (ch === 'J') { remote = true; header = true; continue; }
        if (!CURL_SHORT_VALUE.includes(ch)) continue; // a switch
        if (ch === 'K') return null;
        const rest = a.slice(k + 1);
        const v = rest !== '' ? rest.replace(/^=/, '') : (args[++i] ?? '');
        if (ch === 'o' || ch === 'D' || ch === 'c') { if (v !== '-' && v !== '') out.push(unknown(v)); }
        break;
      }
      continue;
    }
    urls.push(a);
  }
  if (remote) {
    for (const u of urls) if (urlBase(u)) out.push(unknown(outDir ? `${outDir.replace(/\/+$/, '')}/${urlBase(u)}` : urlBase(u)));
    if (header) out.push(unknown(outDir || '.', { subtree: true })); // the name comes from the response
  }
  return out;
}

// Minimal getopt: `shortVal` / `longVal` name the options that take a value.
function getopt(args, shortVal = '', longVal = []) {
  const pos = [];
  const opts = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { pos.push(...args.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) opts.push({ name: t.slice(2, eq), value: t.slice(eq + 1) });
      else opts.push({ name: t.slice(2), value: longVal.includes(t.slice(2)) ? (args[++i] ?? '') : null });
    } else if (t.length > 1 && t[0] === '-') {
      for (let k = 1; k < t.length; k++) {
        if (!shortVal.includes(t[k])) { opts.push({ name: t[k], value: null }); continue; }
        let value = t.slice(k + 1);
        if (value.startsWith('=')) value = value.slice(1);
        else if (value === '') value = args[++i] ?? '';
        opts.push({ name: t[k], value });
        break;
      }
    } else pos.push(t);
  }
  return { pos, opts };
}
const optValue = (opts, ...names) => opts.find((o) => names.includes(o.name) && o.value !== null)?.value ?? null;
const hasOpt = (opts, ...names) => opts.some((o) => names.includes(o.name));

const COPY_VALUE = {
  cp: ['tS', ['target-directory', 'suffix']], mv: ['tS', ['target-directory', 'suffix']], install: ['mogStT', ['mode', 'owner', 'group', 'suffix', 'target-directory']],
  ln: ['tS', ['target-directory', 'suffix']], ditto: ['', []], rsync: ['eBMfT', ['rsh', 'exclude', 'include', 'filter', 'exclude-from', 'include-from', 'files-from', 'temp-dir', 'backup-dir', 'suffix']],
};

const dedupe = (items) => [...new Map(items.map((i) => [JSON.stringify(i), i])).values()];
const textItems = (texts) => texts.map((text) => ({ text }));

// The pieces a written text is joined from, in order (each piece is a list of alternatives): a command that concatenates (cat A B, tee) puts its
// operands one after the other. Without parts the items are the alternatives of one piece.
const withParts = (items, parts) => Object.assign(items, { parts });
const partsOfStream = (x) => [...x.texts.map((text) => [{ text }]), ...x.files.map((file) => [{ file }]), ...(x.computed.length || x.dyn ? [[{ unknown: true }]] : [])];

// `items` plus the files the command's `< F` redirects name
const withRedirectedInput = (cmd, items) => [...items, ...(cmd.redirects ?? []).filter((r) => (r.op === '<' || r.op === '<>') && typeof r.target === 'string' && r.target && !r.target.startsWith('&')).map((r) => ({ file: r.target }))];

// The contents of stdin for a command that copies it to a file (tee, dd, cat): items from the heredoc / here-string / `< F` / pipe feeding it.
function stdinItems(cmd) {
  const s = cmd.streams?.();
  if (!s) return withRedirectedInput(cmd, [{ unknown: true }]); // no stream information: the content is unknown, but a `< F` is still a source
  const x = s.stdin;
  const items = [...textItems(x.texts), ...x.files.map((file) => ({ file }))];
  for (const f of x.computed) items.push({ scan: f });
  const unknown = x.computed.length || x.dyn || (x.fed && !x.texts.length && !x.files.length);
  if (unknown) items.push({ unknown: true });
  return withParts(dedupe(items), [...partsOfStream(x), ...(unknown && !x.computed.length && !x.dyn ? [[{ unknown: true }]] : [])]);
}

// What a command prints on stdout, for `> F`: known for echo / printf / the readers (cat ...) / `:`; anything else is unknown.
function stdoutItems(cmd) {
  const argv = cmd.argv;
  if (!argv.length) return UNKNOWN; // a group `{ ...; } > F` / `( ... ) > F`, or a bare `> F`
  const name = commandName(argv[0]);
  const s = cmd.streams?.();
  if (!s) { // no stream information (never "nothing written"): the text it prints is unknown, and every file it could be reading is a source
    const names = argv.slice(1).filter((a) => !a.startsWith('-') && a !== '');
    const own = name === 'echo' ? textItems(echoTexts(argv).texts) : [];
    return withRedirectedInput(cmd, [{ unknown: true }, ...own, ...names.map((file) => ({ file }))]);
  }
  const items = [];
  const fromStream = (x) => {
    items.push(...textItems(x.texts), ...x.files.map((file) => ({ file })));
    for (const f of x.computed) items.push({ scan: f });
    if (x.computed.length || x.dyn) items.push({ unknown: true });
  };
  if (name === 'echo' || name === 'printf') {
    const pt = name === 'echo' ? null : printfText(argv);
    if (name === 'echo') { const e = echoTexts(argv); items.push(...textItems(e.texts)); if (e.bad) items.push({ unknown: true, authored: true }); } // (an escape we cannot read exactly: unknown)
    else if (pt === null) items.push({ unknown: true, authored: true }); // a conversion or escape we do not read exactly: text the line itself wrote
    else items.push({ text: pt });
    fromStream(s.out); // what a command substitution in the arguments prints
  } else if (['cat', 'tac', 'head', 'tail', 'less', 'more', 'bat', 'batcat'].includes(name)) {
    fromStream(s.out);
    fromStream(s.stdin);
    const stdinUnknown = s.stdin.fed && !s.stdin.texts.length && !s.stdin.files.length && !s.stdin.computed.length;
    if (stdinUnknown) items.push({ unknown: true });
    return withParts(items.length ? dedupe(items) : [{ text: '' }], [...partsOfStream(s.out), ...partsOfStream(s.stdin), ...(stdinUnknown ? [[{ unknown: true }]] : [])]);
  } else if (name === ':' || name === 'true' || name === 'false') items.push({ text: '' });
  else return [{ unknown: true }, ...s.out.computed.map((scan) => ({ scan }))]; // a program's output: unknown, but the files it reads are worth a scan (base64 -d x.b64)
  return items.length ? dedupe(items) : [{ text: '' }];
}

function redirectRecords(cmd, idx) {
  const out = [];
  for (const r of cmd.redirects ?? []) {
    if (!WRITE_OPS.has(r.op) || typeof r.target !== 'string' || !r.target || r.target.startsWith('&') || r.target === '/dev/null') continue;
    if (r.op === '<>' && (r.fd === null || r.fd === 0)) continue; // opened for reading
    let items;
    if (r.fd === null || r.fd === 1) items = stdoutItems(cmd);
    else if (r.fd === 2) items = [...textItems([cmd.argv.join(' '), ...cmd.argv]), { unknown: true }]; // stderr: messages that quote the arguments
    else items = UNKNOWN;
    // `&>` / `>&` also catch stderr
    if ((r.op === '&>' || r.op === '&>>' || r.op === '>&') && !items.some((i) => i.unknown)) items = [...items, ...textItems([cmd.argv.join(' '), ...cmd.argv])];
    out.push({ idx, dest: r.target, items, parts: items.parts, append: r.op === '>>' || r.op === '&>>' });
  }
  return out;
}

const urlBase = (u) => u.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();

// The records of the files a command writes by its arguments, or null when it is not a writer we model.
function argRecords(cmd, name, idx) {
  const args = cmd.argv.slice(1);
  const unknown = (dest, extra = {}) => ({ idx, dest, items: UNKNOWN, ...extra });
  if (COPY_VALUE[name] || (name === 'git' && gitSub(args) === 'mv')) {
    const mv = name === 'git'; // git mv SRC DST: the words after the real subcommand
    const [sv, lv] = mv ? ['', []] : COPY_VALUE[name];
    const { pos, opts } = getopt(mv ? args.slice(gitSubAt(args) + 1) : args, sv, lv);
    if (name === 'install' && hasOpt(opts, 'd', 'directory')) return [];
    const target = optValue(opts, 't', 'target-directory');
    let dest;
    let sources;
    if (target !== null) { dest = target; sources = pos; } else if (pos.length >= 2) { dest = pos[pos.length - 1]; sources = pos.slice(0, -1); } else if (name === 'ln' && pos.length === 1) { dest = '.'; sources = pos; } else return [];
    return [{ idx, dest, copy: true, link: name === 'ln' ? (hasOpt(opts, 's', 'symbolic') ? 'sym' : 'hard') : undefined, items: sources.map((file) => ({ file })) }];
  }
  if (name === 'uniq') { // uniq [OPTION] [INPUT [OUTPUT]]
    const { pos } = getopt(args, 'fsw', ['skip-fields', 'skip-chars', 'check-chars', 'group']);
    return pos.length >= 2 ? [{ idx, dest: pos[1], items: [{ file: pos[0] }] }] : [];
  }
  if (name === 'sort') { // sort -o OUT / --output=OUT: the lines of its inputs, reordered
    const { pos, opts } = getopt(args, 'okSTtpC', ['output', 'key', 'field-separator', 'buffer-size', 'temporary-directory', 'files0-from', 'compress-program', 'parallel', 'batch-size', 'random-source']);
    const out = optValue(opts, 'o', 'output');
    return out === null ? null : [{ idx, dest: out, items: [...pos.map((scan) => ({ scan })), ...stdinItems(cmd).map((i) => (i.file !== undefined ? { scan: i.file } : i)), { unknown: true }] }];
  }
  if (name === 'less' || name === 'more') { // the log file of the input that is piped in
    const { opts } = getopt(args, 'oObhjkpPtTxyz', ['log-file', 'LOG-FILE']);
    const out = optValue(opts, 'o', 'O', 'log-file', 'LOG-FILE');
    return out === null ? null : [{ idx, dest: out, items: stdinItems(cmd) }];
  }
  if (name === 'xxd') { // xxd [infile [outfile]]
    const { pos } = getopt(args, 'clgsoiL', ['cols', 'len', 'groupsize', 'seek']);
    return pos.length >= 2 ? [{ idx, dest: pos[1], items: [{ scan: pos[0] }, { unknown: true }] }] : null;
  }
  if (name === 'tee') {
    const { pos } = getopt(args);
    const append = hasOpt(getopt(args).opts, 'a', 'append');
    return pos.filter((p) => p !== '-').map((dest) => { const items = stdinItems(cmd); return { idx, dest, items, parts: items.parts, append }; });
  }
  if (name === 'dd') {
    const of = args.find((a) => a.startsWith('of='))?.slice(3);
    const inp = args.find((a) => a.startsWith('if='))?.slice(3);
    const append = args.some((a) => /^conv=.*notrunc/.test(a) || /^oflag=.*append/.test(a));
    const items = inp ? [{ file: inp }] : stdinItems(cmd);
    return of ? [{ idx, dest: of, items, parts: items.parts, append }] : [];
  }
  if (name === 'curl') return curlRecords(args, idx);
  if (name === 'wget') {
    const { pos, opts } = getopt(args, 'OPoaeUTtwQi', ['output-document', 'directory-prefix', 'output-file', 'append-output', 'save-cookies', 'execute', 'user-agent', 'timeout', 'tries', 'wait', 'input-file']);
    const out = [];
    const o = optValue(opts, 'O', 'output-document');
    const dir = optValue(opts, 'P', 'directory-prefix') ?? '';
    if (hasOpt(opts, 'e', 'execute')) return null; // .wgetrc commands can name any output
    for (const lf of [optValue(opts, 'o', 'output-file'), optValue(opts, 'a', 'append-output'), optValue(opts, 'save-cookies')]) if (lf) out.push(unknown(lf));
    if (o !== null) out.push(unknown(o));
    else for (const u of pos) out.push(unknown(dir ? `${dir.replace(/\/+$/, '')}/${urlBase(u) || 'index.html'}` : urlBase(u) || 'index.html'));
    if (hasOpt(opts, 'r', 'recursive', 'm', 'mirror')) out.push(unknown(dir || '.', { subtree: true }));
    return out;
  }
  if (name === 'sed' || name === 'gsed' || name === 'perl' || name === 'ruby') {
    const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='));
    const wfiles = name === 'sed' || name === 'gsed' ? sedWriteTargets(args) : [];
    if (!inPlace) return wfiles.length ? wfiles.map((d) => unknown(d)) : null; // `w FILE` / `s///w FILE` write a file too
    const { pos, opts } = getopt(args, name === 'sed' || name === 'gsed' ? 'efl' : 'eIlF', ['expression', 'file', 'line-length']);
    const hasProgram = hasOpt(opts, 'e', 'f', 'expression', 'file');
    return (name === 'sed' || name === 'gsed' ? (hasProgram ? pos : pos.slice(1)) : (hasProgram ? pos : pos.slice(1))).map((dest) => unknown(dest));
  }
  if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
    const first = args[0] ?? '';
    const extract = (/^[A-Za-z]/.test(first) && first.includes('x')) || args.some((a) => /^-[A-Za-z]*x/.test(a) && !a.startsWith('--')) || args.includes('--extract') || args.includes('--get');
    const { opts } = getopt(args.map((a, i) => (i === 0 && /^[A-Za-z]/.test(a) ? `-${a}` : a)), 'CfT', ['directory', 'file']);
    if (args.some((a) => /^--(?:to-command|checkpoint-action|use-compress-program|rsh-command)/.test(a) || a === '-I')) return null;
    if (!extract) { // c / r / u write the archive named by -f
      const make = (/^[A-Za-z]/.test(first) && /[cru]/.test(first)) || args.some((a) => /^-[A-Za-z]*[cru]/.test(a) && !a.startsWith('--')) || args.some((a) => /^--(?:create|append|update)$/.test(a));
      const arc = optValue(opts, 'f', 'file');
      return make && arc && arc !== '-' ? [unknown(arc)] : [];
    }
    return [unknown(optValue(opts, 'C', 'directory') ?? '.', { subtree: true })];
  }
  if (name === 'unzip') {
    const { opts } = getopt(args, 'dxP', ['exclude']);
    if (hasOpt(opts, 'l', 'p', 'Z', 't', 'v')) return [];
    return [unknown(optValue(opts, 'd') ?? '.', { subtree: true })];
  }
  if (name === 'git') {
    // global options, then the subcommand
    let i = 0;
    let dir = null;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C') { dir = args[i + 1] ?? null; i += 2; } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(args[i])) i += 2; else i++;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const at = (p) => (dir && !p.startsWith('/') && !p.startsWith('~') ? `${dir.replace(/\/+$/, '')}/${p}` : p);
    if (sub === 'checkout' || sub === 'restore' || sub === 'checkout-index') {
      const { pos } = getopt(rest, sub === 'checkout' ? 'bB' : 'sS', ['source', 'orphan', 'conflict', 'pathspec-from-file']);
      return pos.map((p) => unknown(at(p)));
    }
    if (sub === 'clone') {
      const { pos } = getopt(rest, 'bcoju', ['branch', 'depth', 'origin', 'config', 'template', 'reference', 'separate-git-dir', 'jobs']);
      const d = pos[1] ?? (pos[0] ? urlBase(pos[0]).replace(/\.git$/, '') : '.');
      return [unknown(at(d), { subtree: true })];
    }
    if (GIT_OUTPUT.has(sub)) { // git diff --output=F, git log --output=F, git archive -o F, git format-patch -o DIR
      const { opts } = getopt(rest, 'o', ['output', 'output-directory']);
      const out = optValue(opts, 'o', 'output', 'output-directory');
      if (out === null) return null;
      return [unknown(at(out), { subtree: sub === 'format-patch' })];
    }
    if (sub === 'worktree' && rest[0] === 'add') {
      const { pos } = getopt(rest.slice(1), 'bB', ['reason']);
      return pos[0] ? [unknown(at(pos[0]), { subtree: true })] : [];
    }
    return null;
  }
  if (PS_WRITERS.has(name)) {
    const words = args.filter((a) => !a.startsWith('-'));
    return [...words.map((dest) => ({ idx, dest, items: [...words.map((file) => ({ file })), { unknown: true }] }))];
  }
  return null;
}

// Is the command read-only as far as creating or replacing a script file goes? (A command that is not may have created ANY file.)
// The index of the git subcommand among `args` (after the global options and their values)
function gitSubAt(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(args[i]) ? 2 : 1;
  return i;
}
const gitSub = (args) => args[gitSubAt(args)];

// Builtins and tools that never write a file by their own arguments (a redirect is a separate write); every other command on PURE is also checked for
// an output-like option below.
const NO_OUTPUT_OPTIONS = new Set([
  'echo', 'printf', 'true', 'false', ':', 'cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'shift', 'read', 'wait', 'let', 'return',
  'exit', 'break', 'continue', 'trap', 'alias', 'unalias', 'hash', 'mkdir', 'rm', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'kill', 'time', 'test', '[', '[[', 'sleep', 'for',
  'case', 'select', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'esac', 'in', '!', '{', '}', 'pwd', 'type', 'which',
]);
// -o is "only matching" for these, not an output file
const SHORT_O_OK = new Set(['ls', 'grep', 'egrep', 'fgrep', 'rg', 'stat']);
const OUTPUT_LONG = /^--[A-Za-z-]*(?:output|log-file|out-file|outfile|to-file|write|save|dump)[A-Za-z-]*(?:=|$)/i;

// What a sed program does besides editing text: { runs, writes }. `w FILE` / `W FILE` / the `w` flag of s write a file (the name runs to the end of the line),
// `e` / the `e` flag run a command; with or without a space after the letter (GNU sed takes `wn.sh`). The s and y commands and the address regexes are
// read as such first, so a letter inside a pattern or a replacement (`s/a/export/`, `/error/p`) is not a command. Anything else that looks like a
// w / W / e at a command position counts, strictly.
const SED_S = /s([^\sA-Za-z0-9\\])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1([gpiImMe0-9]*)(w?)/g;
const SED_Y = /y([^\sA-Za-z0-9\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1/g;
const SED_ADDR = /\/(?:\\.|[^/\\])*\/[IM]*/g;
const SED_CMD = /(?:^|[;{}\s\d$!,])([wWe])/g;
export function sedScan(prog) {
  const writes = [];
  let runs = false;
  let out = '';
  let last = 0;
  SED_S.lastIndex = 0;
  for (let m = SED_S.exec(prog); m; m = SED_S.exec(prog)) {
    if (m[4].includes('e')) runs = true;
    out += prog.slice(last, m.index) + ' ';
    last = SED_S.lastIndex;
    if (m[5]) { // the w flag: the file name is the rest of the line
      const eol = prog.indexOf('\n', last);
      const end = eol < 0 ? prog.length : eol;
      writes.push(prog.slice(last, end).trim());
      last = end;
      SED_S.lastIndex = end;
    }
  }
  out += prog.slice(last);
  out = out.replace(SED_Y, ' ');
  // w / W: read before the address regexes are cut out (`1w/home/u/x` is not an address) and after (`/re/w file`); e only after (`/error/p`)
  const noAddr = out.replace(SED_ADDR, ' ');
  for (const [text, withE] of [[out, false], [noAddr, true]]) {
    SED_CMD.lastIndex = 0;
    for (let m = SED_CMD.exec(text); m; m = SED_CMD.exec(text)) {
      if (m[1] === 'e') { if (withE) runs = true; continue; }
      const eol = text.indexOf('\n', SED_CMD.lastIndex);
      const end = eol < 0 ? text.length : eol;
      writes.push(text.slice(SED_CMD.lastIndex, end).trim());
      SED_CMD.lastIndex = end;
    }
  }
  return { runs, writes: [...new Set(writes.filter(Boolean))] };
}
export const sedUnsafe = (prog) => { const r = sedScan(prog); return r.runs || r.writes.length > 0 || /(?:^|[;{}\s\d$!,])[wWe]\s*$/.test(prog); };
// The sed programs among the arguments: the script words (-e PROG, -ePROG, -ne PROG, --expression=PROG, --expression PROG) and the positional words (the first is the
// program, the rest files: all are scanned); `file`: a -f / --file script, whose text we do not read here.
export function sedPrograms(args) {
  const progs = [];
  let file = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { progs.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (nm === 'expression') progs.push(eq > 0 ? a.slice(eq + 1) : (args[++i] ?? ''));
      else if (nm === 'file') { file = true; if (eq < 0) i++; } else if (nm === 'line-length' && eq < 0) i++;
    } else if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        const rest = a.slice(k + 1);
        if (a[k] === 'e') { progs.push(rest !== '' ? rest : (args[++i] ?? '')); break; }
        if (a[k] === 'f') { file = true; if (rest === '') i++; break; }
        if (a[k] === 'l') { if (rest === '') i++; break; }
        if (a[k] === 'i') break; // -i[SUFFIX]
      }
    } else progs.push(a);
  }
  return { progs, file };
}
// does any program of these sed arguments write a file or run a command (or is a script file we cannot read)?
export function sedArgsUnsafe(args) {
  const { progs, file } = sedPrograms(args);
  return file || progs.some(sedUnsafe);
}
// The files a sed program may write (the name is read both to the end of the line and up to a `;` / `}`)
export function sedWriteTargets(args) {
  const out = [];
  for (const prog of sedPrograms(args).progs) for (const w of sedScan(prog).writes) out.push(w, w.split(/[;}]/)[0].trim());
  return [...new Set(out.filter(Boolean))];
}

function isPure(cmd, name) {
  const args = cmd.argv.slice(1);
  if (!cmd.argv.length) return true; // a bare assignment / redirect
  if (name === 'git') {
    const sub = gitSub(args);
    return !GIT_TREE.has(sub) && !args.some((a) => OUTPUT_LONG.test(a) || a === '-o');
  }
  if (name === 'gh') return !args.some((a) => /^(?:download|checkout|clone)$/.test(a) || OUTPUT_LONG.test(a));
  if (name === 'sed' || name === 'gsed') return !args.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || OUTPUT_LONG.test(a) || sedArgsUnsafe(args));
  if (['awk', 'gawk', 'mawk', 'nawk'].includes(name)) return !args.some((a) => (a.startsWith('-') ? /^-[A-Za-z]*[ifE]/.test(a) || OUTPUT_LONG.test(a) : /[>|]|\bsystem\s*\(/.test(a)));
  if (name === 'find') return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
  if (name === 'xxd') return !args.includes('-r') && args.filter((a) => !a.startsWith('-')).length <= 1;
  if (name === 'uniq') return args.filter((a) => !a.startsWith('-')).length <= 1;
  if (name === 'rg') return !args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a)) && !args.some((a) => OUTPUT_LONG.test(a));
  if (!PURE.has(name)) return false;
  if (NO_OUTPUT_OPTIONS.has(name)) return true;
  // when unsure, not pure: any output-like option (-o FILE, --output=F, --log-file ...) of a tool on the list
  return !args.some((a) => OUTPUT_LONG.test(a) || (!SHORT_O_OK.has(name) && /^-[A-Za-z]*[oO]/.test(a)) || a === '-i' || a === '--in-place');
}

// The writes of a line: { recs, unmodelled }. `unmodelled` is the set of command indexes that may have created any file.
export function writesOf(cmds) {
  const recs = [];
  const unmodelled = new Set();
  cmds.forEach((cmd, idx) => {
    recs.push(...redirectRecords(cmd, idx));
    if (!cmd.argv.length) return;
    const name = commandName(cmd.argv[0]);
    const mine = argRecords(cmd, name, idx);
    if (mine) recs.push(...mine);
    const inline = INLINE_RUNNERS[name];
    if (inline) {
      const at = cmd.argv.findIndex((a, i) => i > 0 && inline.test(a));
      if (at > 0) {
        const program = [...cmd.argv.slice(at + 1), ...Object.values(cmd.env ?? {})].join(' ');
        recs.push({ idx, dest: null, inline: program, items: [{ program }], loose: true });
      } // (the program, its arguments and the variables it is given)
    }
    // a program the parser does not unwrap (strace, chroot, nsenter, a wrapper we have never seen) that is handed a writer: the writer's own writes, and a write to
    // any file (the wrapper may have changed the directory or the root) with unknown content
    if (!mine && !isPure(cmd, name)) {
      const at = cmd.argv.findIndex((w, i) => i > 0 && WRITER_NAMES.has(commandName(w)));
      if (at > 0) {
        const inner = { ...cmd, argv: cmd.argv.slice(at) };
        Object.defineProperty(inner, 'streams', { value: cmd.streams, enumerable: false }); // (its stdin is the wrapper's stdin)
        recs.push(...(argRecords(inner, commandName(inner.argv[0]), idx) ?? []), { idx, dest: null, items: UNKNOWN, loose: true });
      }
    }
    // a modelled writer (and a read-only command) cannot create a file we did not list; anything else may. git is only modelled for the
    // subcommands that write named paths: a checkout / merge / pull also changes files we do not follow
    if ((name === 'sed' || name === 'gsed') && (sedPrograms(cmd.argv.slice(1)).file || sedPrograms(cmd.argv.slice(1)).progs.some((p) => sedScan(p).runs))) unmodelled.add(idx);
    const sub = name === 'git' ? gitSub(cmd.argv.slice(1)) : '';
    const modelled = mine && !(name === 'git' && GIT_TREE.has(sub) && !['clone', 'worktree', 'mv'].includes(sub));
    if (!modelled && !isPure(cmd, name)) unmodelled.add(idx);
  });
  return { recs, unmodelled };
}

// ---- which writes count for a command ------------------------------------------------------------------------

// A function body, a trap or an alias runs when it is called, not where it is written: with any of them on the line, what a command wrote may be seen by
// a script judged anywhere else on it.
const FUNCTION_DEF = /(?:^|[\s;&|(){])(?:function\s+[^\s(){};&|<>]+|[A-Za-z_][\w.:-]*\s*\(\s*\))/;
const DEFERRING = new Set(['trap', 'alias', 'eval', 'unalias', 'enable', 'hash', 'setopt', 'shopt', 'functions', 'autoload', 'precmd', 'preexec', 'command_not_found_handle']);
const hasDeferred = (cmds) => cmds.some((c) => FUNCTION_DEF.test(c.raw ?? '') || DEFERRING.has(commandName(c.argv[0] ?? '')));

// Can the command at `idx` run before the command at `at`, or while it runs? Anything earlier on the line counts (even a conditional
// one); a later one counts when they share a pipeline, when `at` is a background job, or when a loop may repeat them.
function visible(frame, at, idx) {
  if (idx === at) return false;
  if (idx < at || frame.deferred) return true;
  const { cmds, from } = frame;
  if (from >= 0 && at >= from && idx >= from) return true;
  let hi = at;
  while (hi + 1 < cmds.length && cmds[hi + 1].sep === '|') hi++;
  let lo = at;
  while (lo > 0 && cmds[lo].sep === '|') lo--;
  if (idx >= lo && idx <= hi) return true;
  return cmds[hi + 1]?.sep === '&';
}

// One frame per command list being evaluated (the line, then each script text judged inside it). `i` is the command being judged now.
// - expand(word): the word with variables, ~ and $HOME expanded, or null when it is only known at run time (a `$` left, a glob)
// - locate(expanded, idx): the paths the word may name for the command at idx: absolute ones, or the word itself when the directory is unknown
// - isAbs(path), p: the policy's path functions (node:path or node:path.posix), ci: compare names ignoring case
// - real(path): the path with symlinks followed (a missing tail kept), or null when it cannot be told; omitted: paths are taken as written
export function newWriteFrame(cmds, { expand, locate, isAbs, p, ci = false, real = null }) {
  const w = writesOf(cmds);
  return { cmds, recs: w.recs, unmodelled: w.unmodelled, from: flowStart(cmds), i: -1, expand, locate, isAbs, p, ci, real, deferred: hasDeferred(cmds) };
}

const fold = (f, s) => (f.ci ? s.toLowerCase() : s);
// The real location of a path (symlinks followed through the longest existing prefix), or null when it cannot be told. A path is judged
// both as written and by where it really is, so a write through a directory alias (`alias -> real`) reaches the script named by its real path.
function canon(f, p) {
  f.canonCache ??= new Map();
  if (!f.canonCache.has(p)) {
    let v = p;
    try { v = f.real ? f.real(p) : p; } catch { v = null; }
    if (v === null) f.unresolved = true;
    f.canonCache.set(p, v);
  }
  return f.canonCache.get(p);
}
// P relative to directory d: '' when they are the same path, the relative path when P is below d, else null. Only a first segment of exactly `..` leaves d
// (a file named `..x.sh` is inside it).
function relUnder(f, P, d) {
  const lex = (a, b) => {
    const rel = f.p.relative(fold(f, f.p.resolve(a)), fold(f, f.p.resolve(b)));
    return rel === '' ? '' : rel.split(/[\\/]/)[0] === '..' || f.p.isAbsolute(rel) ? null : rel;
  };
  const r = lex(d, P);
  if (r !== null) return r;
  const cd = canon(f, f.p.resolve(d));
  const cp = canon(f, f.p.resolve(P));
  return cd === null || cp === null ? null : lex(cd, cp);
}
const same = (f, a, b) => relUnder(f, b, a) === '';
// the path of P below directory d, or null
const below = (f, P, d) => relUnder(f, P, d) || null;
const nameOf = (f, s) => f.p.basename(String(s).replace(/[\\/]+$/, ''));

// The items a record puts in P (null: it does not write P).
function match(f, rec, P) {
  const p = f.p;
  const loose = (items) => Object.assign([...items], { loose: true }); // may or may not be the file: its place in the order is unknown
  if (rec.inline !== undefined) return namesFile(rec.inline, p.basename(P)) && CAN_WRITE.test(rec.inline) ? loose(rec.items) : null;
  if (rec.dest === null) return loose(rec.items);
  const e = f.expand(rec.dest);
  // a target only known at run time may be any file its fixed parts allow (`/work/out-$n.txt` is not /work/cmp.mjs)
  if (e === null) return dynamicMayBe(f, rec.dest, P) ? loose(rec.items) : null;
  const out = [];
  for (const d of f.locate(e, rec.idx)) {
    if (!f.isAbs(d)) { // the directory is unknown: compare the names
      out.loose = true;
      if (fold(f, p.basename(d)) === fold(f, p.basename(P))) out.push(...rec.items);
      else if (rec.copy) for (const it of rec.items) { const se = it.file === undefined ? undefined : f.expand(it.file); if (se === null || (se !== undefined && fold(f, nameOf(f, se)) === fold(f, p.basename(P)))) out.push(it); }
      if (rec.subtree) out.push(...rec.items);
      continue;
    }
    if (same(f, d, P)) { out.push(...rec.items); continue; }
    if (rec.subtree && below(f, P, d) !== null) out.push(...rec.items);
    if (!rec.copy) continue;
    for (const it of rec.items) {
      if (it.file === undefined) continue;
      const se = f.expand(it.file);
      if (se === null) { // the source is only known at run time: it may be any file that lands in d
        if (below(f, P, d) !== null) out.push({ unknown: true });
        continue;
      }
      const name = nameOf(f, se);
      const into = name && name !== '.' && name !== '..' ? p.join(d, name) : null;
      if (into && same(f, into, P)) { out.push(it); continue; }
      // a directory copied or linked: its files appear below d (as d itself, or as d/name)
      for (const root of [d, into]) {
        const rel = root ? below(f, P, root) : null;
        if (rel === null) continue;
        for (const s of f.locate(se, rec.idx)) out.push({ abs: p.join(s, rel) });
      }
    }
  }
  return out.length ? out : null;
}

// ---- ordered content: a file built from pieces ----------------------------------------------------------------
// `printf 'git pu' > n.sh; printf 'sh origin main' >> n.sh`: no piece holds the guarded word, the file does. The content of a file is its current
// text (or what the last truncating write put there) followed by every append in order, a concatenating writer's operands joined in order.
const MAX_JOINED = 64;
const product = (a, b) => {
  if (a.length * b.length > MAX_JOINED) return null;
  const out = [];
  for (const x of a) for (const y of b) out.push(x + y);
  return [...new Set(out)];
};

function hitsOn(frames, upto, asOf, P) {
  const pairs = linkPairs(frames, upto, asOf);
  const names = pairs.length ? namesOf(pairs, P) : [P];
  const out = [];
  for (let fi = 0; fi <= upto; fi++) {
    const f = frames[fi];
    const at = fi === upto ? asOf : f.i;
    for (const rec of f.recs) {
      if (!visible(f, at, rec.idx)) continue;
      for (const Pv of names) {
        const items = match(f, rec, Pv);
        if (items) { out.push({ fi, f, rec, items, loose: items.loose === true, P: Pv }); break; }
      }
    }
  }
  // a write that may or may not be this file, followed by an exact write that replaces the whole file, changed nothing that matters
  let lastExact = -1;
  out.forEach((h, i) => { if (!h.loose && !h.rec.append) lastExact = i; });
  return out.filter((h, i) => !(h.loose && i < lastExact));
}

// Every text the file P may hold after the writes before (frames[0..upto], command asOf), or null when it cannot be built (a piece is unknown or
// computed, a write's place is unknown, too many combinations). A file nothing writes is its current text.
function contentsOf(frames, upto, asOf, P, io, depth) {
  if (depth > 4) { io.pieces = true; return null; }
  const hits = hitsOn(frames, upto, asOf, P);
  // a write that may or may not be this file is tried both ways (its own content is judged on its own, as unknown content); more than four are left out
  const loose = hits.filter((h) => h.loose).slice(0, 4);
  const out = new Set();
  for (let mask = 0; mask < 1 << loose.length; mask++) {
    let seq = [{ cur: true }];
    for (const h of hits) {
      if (h.loose && !(mask & (1 << loose.indexOf(h)))) continue;
      if (h.loose && loose.indexOf(h) < 0) continue;
      if (h.rec.append) seq.push(h); else seq = [h];
    }
    // a file put together from several pieces that cannot be built is "built from pieces at run time"; one unknown piece alone is just unknown content.
    // Only a write to the file itself counts: a piece of a write that merely may hit it is the unknown-content signal, never a refusal
    const multi = seq.length > 1 || seq.some((el) => (el.rec?.parts?.length ?? 0) > 1);
    const looseIn = seq.some((el) => el.loose);
    const fail = () => { if (multi && !looseIn) io.pieces = true; return null; };
    let acc = [''];
    let ok = true;
    for (const el of seq) {
      let alts;
      if (el.cur) {
        if (!io.exists(P)) alts = [''];
        else { const text = io.readText(P); if (typeof text !== 'string') { fail(); ok = false; break; } alts = [text]; }
      } else alts = partAlternatives(frames, el, io, depth);
      if (alts === null) { fail(); ok = false; break; }
      acc = product(acc, alts);
      if (acc === null) { fail(); ok = false; break; }
    }
    if (ok) for (const x of acc) out.add(x);
    else if (!looseIn) return null;
  }
  return out.size ? [...out] : null;
}

function partAlternatives(frames, h, io, depth) {
  const { f, rec, fi } = h;
  let acc = [''];
  for (const part of rec.parts ?? [h.items]) {
    const alts = [];
    for (const it of part) {
      if (it.text !== undefined) alts.push(it.text);
      else if (it.file !== undefined || it.abs !== undefined) {
        let paths;
        if (it.abs !== undefined) paths = [it.abs];
        else {
          const e = f.expand(it.file);
          if (e === null) return null;
          paths = f.locate(e, rec.idx).filter((x) => f.isAbs(x));
          if (rec.link === 'sym' && !f.isAbs(e)) paths.push(f.p.resolve(f.p.dirname(h.P), e));
          if (!paths.length) return null;
        }
        for (const x of paths) {
          const sub = contentsOf(frames, fi, rec.idx, x, io, depth + 1);
          if (sub === null) return null;
          alts.push(...sub);
        }
      } else return null; // scan / unknown
    }
    acc = product(acc, alts);
    if (acc === null) return null;
  }
  return acc;
}

// Could the word, with its run-time parts ($VAR, $(...), globs, {a,b}) replaced by anything, name P? A relative word may be anywhere (its directory is unknown).
function dynamicMayBe(f, word, P) {
  const parts = String(word).split(/(\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!$-]|`[^`]*`|\[[^\]]*\]|\{[^}]*\}|[*?])/);
  const re = parts.map((s, i) => (i % 2 ? '.*' : s.replace(/[.+^|()\\]/g, '\\$&').replace(/[\[\]{}$]/g, '\\$&'))).join('');
  const abs = /^\//.test(parts[0] ?? '') || /^[A-Za-z]:/.test(parts[0] ?? '');
  try {
    return new RegExp(abs ? `^(?:[A-Za-z]:)?${re}$` : `(?:^|[\\\\/])${re}$`, f.ci ? 'is' : 's').test(P.replace(/\\/g, '/'));
  } catch {
    return true; // a pattern we cannot build: it may be
  }
}

const MAX_CHAIN = 6; // a file copied from a file copied from a file ...

// Everything a write before the command being judged may have put in the script file `target`:
// { texts, files, scans, unknown } or null when no write reaches it. `files` are the sources (and their own sources, in turn): the
// caller judges each as the script it is. `exists(path)`: is there a file now (a missing one may have been created by an unmodelled command).
// `ignoreUnmodelled`: the real home's startup files (no word on the line names them) are not "a missing script that something may have created".
// `viaUnmodelled` in the result: the answer depends on a command we do not model (a cached verdict must not outlive a new one).
// `readText(path)`: the text of a file now (string, or null). `joined`: the whole texts the file may hold when several writes build it (appends, cat A B);
// `pieces`: it is built from pieces and cannot be put together (a piece unknown, computed or too many), so no single piece can be judged for what the file runs.
export function writtenTo(frames, target, { exists, readText = () => null, ignoreUnmodelled = false }) {
  if (!frames.length || !frames.some((f) => f.recs.length || f.unmodelled.size)) return null;
  const st = { texts: new Set(), files: new Set(), scans: new Set(), programs: new Set(), authored: false, unknown: false, any: false, seen: new Set(), ignoreUnmodelled, viaUnmodelled: false };
  const upto = frames.length - 1;
  collect(frames, upto, frames[upto].i, target, st, 0, exists);
  if (!st.any) return null;
  // the whole text the writes build together (judged in addition to each piece)
  const io = { exists, readText, pieces: false };
  const built = contentsOf(frames, upto, frames[upto].i, target, io, 0);
  const joined = (built ?? []).filter((x) => !st.texts.has(x));
  return { texts: [...st.texts], files: [...st.files], scans: [...st.scans], programs: [...st.programs], authored: st.authored, unknown: st.unknown, viaUnmodelled: st.viaUnmodelled, joined, pieces: io.pieces };
}

// The links the line makes before the command: [alias, real, frame] for `ln -s REAL ALIAS` (and a hard link). A directory alias makes
// every path below it a second name for the same file, so a script is also judged under its other names.
function linkPairs(frames, upto, asOf) {
  const pairs = [];
  pairs.any = false; // a link is made before the command, whether or not we can place it
  frames.slice(0, upto + 1).forEach((f, fi) => {
    const at = fi === upto ? asOf : f.i;
    for (const rec of f.recs) {
      if (!rec.link || !visible(f, at, rec.idx)) continue;
      pairs.any = true;
      const e = f.expand(rec.dest);
      if (e === null) continue;
      for (const d of f.locate(e, rec.idx).filter((x) => f.isAbs(x))) {
        for (const it of rec.items) {
          const se = it.file === undefined ? null : f.expand(it.file);
          if (se === null) continue;
          const srcs = f.locate(se, rec.idx).filter((x) => f.isAbs(x));
          if (rec.link === 'sym' && !f.isAbs(se)) srcs.push(f.p.resolve(f.p.dirname(d), se));
          for (const s of srcs) pairs.push([d, s, f], [f.p.join(d, nameOf(f, se)), s, f]);
        }
      }
    }
  });
  return pairs;
}

// P and the other names the line's links give it (alias <-> real, to a small fixed point)
function namesOf(pairs, P) {
  const out = [P];
  for (let round = 0; round < 4 && out.length < 16; round++) {
    for (const v of [...out]) {
      for (const [alias, real, f] of pairs) {
        const a = relUnder(f, v, alias);
        if (a !== null) { const n = a ? f.p.join(real, a) : real; if (!out.includes(n)) out.push(n); }
        const b = relUnder(f, v, real);
        if (b !== null) { const n = b ? f.p.join(alias, b) : alias; if (!out.includes(n)) out.push(n); }
      }
    }
  }
  return out;
}

function collect(frames, upto, asOf, P, st, depth, exists) {
  const key = `${upto}\u0000${asOf}\u0000${P}`;
  if (st.seen.has(key)) return;
  st.seen.add(key);
  const pairs = linkPairs(frames, upto, asOf);
  const names = pairs.length ? namesOf(pairs, P) : [P];
  for (const h of hitsOn(frames, upto, asOf, P)) {
    if (h.loose && st.ignoreUnmodelled) continue; // (the real home's startup files: only the line's exact writes reach them, not a target known only at run time)
    absorb(frames, h.fi, h.f, h.rec, h.items, h.P, st, depth, exists);
    if (!h.loose && !h.rec.append) st.lastReplace = [h.fi, h.rec.idx]; // an exact write that replaces the file: what came before it no longer matters
  }
  if (frames.some((x) => x.unresolved)) pairs.any = true;
  for (let fi = 0; fi <= upto; fi++) {
    const f = frames[fi];
    const at = fi === upto ? asOf : f.i;
    // links we cannot follow (a link made on the line, a path whose real location is unknown): a write that ends in the script's NAME may reach it
    if (pairs.any || frames.some((x) => x.unresolved)) {
      for (const rec of f.recs) {
        if (!visible(f, at, rec.idx) || rec.inline !== undefined) continue;
        if (rec.subtree) { st.any = true; st.unknown = true; continue; }
        if (rec.dest === null) continue;
        const e = f.expand(rec.dest);
        if (e === null) continue;
        const base = fold(f, f.p.basename(P));
        const written = [nameOf(f, e), ...(rec.copy ? rec.items.map((it) => (it.file === undefined ? null : f.expand(it.file))).filter((s) => s).map((s) => nameOf(f, s)) : [])];
        // (what it copies in is judged as well: the name matches, the place may not be the one we think)
        if (written.some((n) => fold(f, n) === base)) { st.unknown = true; absorb(frames, fi, f, rec, rec.items, P, st, depth, exists); }
      }
    }
  }
  // a script that is missing now may have been created by any command we do not model, unless an exact write put the whole file there after it
  if (!st.ignoreUnmodelled && !exists(P)) {
    for (let fi = 0; fi <= upto; fi++) {
      const f = frames[fi];
      const at = fi === upto ? asOf : f.i;
      for (const idx of f.unmodelled) {
        if (!visible(f, at, idx)) continue;
        if (st.lastReplace && (fi < st.lastReplace[0] || (fi === st.lastReplace[0] && idx < st.lastReplace[1]))) continue;
        st.any = true; st.unknown = true; st.viaUnmodelled = true;
      }
    }
  }
}

// The items of a record that reaches the script: texts and sources are judged, anything unknown is the run-time rule.
function absorb(frames, fi, f, rec, items, Pv, st, depth, exists) {
  st.any = true;
  for (const it of items) {
    if (it.text !== undefined) st.texts.add(it.text);
    else if (it.program !== undefined) st.programs.add(it.program);
    else if (it.unknown) { st.unknown = true; if (it.authored) st.authored = true; }
    else if (it.scan !== undefined) addFiles(f, rec, it.scan, Pv, st, fi, depth, exists, 'scans');
    else if (it.abs !== undefined) addPath(frames, fi, rec, it.abs, st, depth, exists, 'files');
    else if (it.file !== undefined) addFiles(f, rec, it.file, Pv, st, fi, depth, exists, 'files', frames);
  }
}

function addPath(frames, fi, rec, abs, st, depth, exists, into) {
  st[into].add(abs);
  if (into === 'files' && depth < MAX_CHAIN) collect(frames, fi, rec.idx, abs, st, depth + 1, exists);
}

function addFiles(f, rec, word, P, st, fi, depth, exists, into, frames = null) {
  const e = f.expand(word);
  if (e === null) { st.unknown = true; return; }
  const paths = f.locate(e, rec.idx).filter((x) => f.isAbs(x));
  if (!paths.length) { st.unknown = true; return; } // a relative source in a directory we do not know
  // a symlink's relative source is read from the link's own directory
  if (rec.link === 'sym' && !f.isAbs(e)) paths.push(f.p.resolve(f.p.dirname(P), e));
  for (const x of paths) {
    st[into].add(x);
    if (into === 'files' && frames && depth < MAX_CHAIN) collect(frames, fi, rec.idx, x, st, depth + 1, exists);
  }
}

// Names the line's writes put into directory `dir` (so `bash n*.sh` after `cp f.sh n.sh` has n.sh among its glob matches).
export function writtenNamesIn(frames, dir) {
  const out = new Set();
  for (const f of frames) {
    for (const rec of f.recs) {
      if (rec.dest === null || rec.inline !== undefined || !visible(f, f.i, rec.idx)) continue;
      const e = f.expand(rec.dest);
      if (e === null) continue;
      for (const d of f.locate(e, rec.idx)) {
        if (!f.isAbs(d)) continue;
        if (same(f, f.p.dirname(d), dir)) out.add(f.p.basename(d));
        if (rec.copy && same(f, d, dir)) for (const it of rec.items) { const se = f.expand(it.file ?? ''); if (se) out.add(nameOf(f, se)); }
      }
    }
  }
  return [...out];
}

// A fingerprint of the writes that count for the command being judged now, for memo keys that must not outlive a change of them: the actual
// visible records (not their number), so two different write sets never share a cached verdict.
export function writeSignature(frames) {
  return JSON.stringify(frames.map((f) => f.recs.filter((r) => visible(f, f.i, r.idx))));
}
// Is there a command we do not model before the one being judged? (any number of them make a missing script equally unknown)
export const unmodelledBefore = (frames) => frames.some((f) => [...f.unmodelled].some((x) => visible(f, f.i, x)));

// The records of a finished frame (a script judged while the caller ran), rewritten with absolute paths and attributed to the calling command `idx`, so the
// commands that run after the script see what it wrote (`bash mk.sh; bash n.sh` with mk.sh doing `cp f.sh n.sh`).
export function exportRecords(f, idx) {
  const out = [];
  const absOf = (word, at) => {
    const e = f.expand(word);
    return e === null ? null : f.locate(e, at).filter((x) => f.isAbs(x));
  };
  for (const rec of f.recs) {
    if (rec.inline !== undefined) { out.push({ ...rec, idx }); continue; }
    const convert = (items, d) => items.flatMap((it) => {
      if (it.file === undefined && it.scan === undefined) return [it];
      const key = it.file !== undefined ? 'file' : 'scan';
      const paths = absOf(it[key], rec.idx);
      if (paths === null || !paths.length) return [{ unknown: true }];
      const more = key === 'file' && rec.link === 'sym' && d && !f.isAbs(f.expand(it.file) ?? '/') ? [f.p.resolve(f.p.dirname(d), f.expand(it.file))] : []; // a symlink's relative source is read from the link's directory
      return [...paths, ...more].map((p) => ({ [key]: p }));
    });
    const dests = rec.dest === null ? [null] : (absOf(rec.dest, rec.idx) ?? [null]);
    for (const d of dests.length ? dests : [null]) {
      const items = convert(rec.items, d);
      out.push({ ...rec, idx, dest: d, items, parts: rec.parts?.map((part) => convert(part, d)) });
    }
  }
  return out;
}

// The readings of a program's text to look for a guarded command in: as written, with string concatenation joined ('git pu'+'sh'), with quotes and escapes stripped.
export function flattenProgram(text) {
  const joined = String(text).replace(/['"`]\s*\+\s*['"`]/g, '');
  return [...new Set([String(text), joined, joined.replace(/['"`\\]/g, '')])];
}
