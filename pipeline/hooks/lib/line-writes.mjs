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
import { applySed } from './sed-emulate.mjs';

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

// Reads the backslash escapes of printf / echo -e. mode: 'printf' (\NNN octal, 1-3 digits: `\0120` is `\012` and a 0), 'echo' (\0NNN: a 0 and up to 3 digits, the bash / sh form).
// Every escape that can be read is read (\c stops the output there); `bad` is set when one cannot be read exactly (an unknown \X is kept or dropped
// depending on the shell), the text keeps it as written. `amb`: a printf \0NNN, which some shells read as \0NNN and bash as \0NN + a digit: the text is the bash reading, not certain.
const escapeRe = (octal) => new RegExp(`\\\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(${octal})|([\\s\\S]|$))`, 'g');
const ESCAPES = { printf: escapeRe('[0-7]{1,3}'), echo: escapeRe('0[0-7]{0,3}|[1-7][0-7]{0,2}') };
export function decodeEscapes(s, mode) {
  let out = '';
  let bad = false;
  let amb = false;
  let last = 0;
  const ESCAPE = ESCAPES[mode];
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
      if (mode !== 'echo') { out += String.fromCharCode(parseInt(o, 8) & 255); if (o.length === 3 && o[0] === '0' && /[0-7]/.test(s[ESCAPE.lastIndex] ?? '')) amb = true; } else if (o[0] === '0') out += String.fromCharCode(parseInt(o.slice(1) || '0', 8) & 255);
      else out += whole; // echo -e does not read \NNN: kept as written (the printf reading is judged too)
    } else if (c === 'c') return { text: out, bad, amb, cut: true }; // stops the output
    else if (c !== undefined && SIMPLE_ESCAPES[c] !== undefined) out += SIMPLE_ESCAPES[c];
    else { bad = true; out += whole; } // an unknown \X, a trailing backslash
  }
  return { text: out + s.slice(last), bad, amb };
}
const unescapeText = (s, mode) => { const r = decodeEscapes(s, mode); return r.bad || r.cut || r.amb ? null : r.text; };

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
    if (round === 999) return null; // Why: the arguments are not used up after the rounds we read: the text is not exact (never a cut one)
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
//   narrow   (with subtree) the writes stay inside `dest` (worktree add, clone): with a base of unknown place only a script whose path holds that name is reached
//   inline   program text of node -e / python -c ...: it may write a file whose name it spells
// items: what the file may hold: { text } | { file: word } | { scan: word } (a file a rewriting command computes the text from) | { unknown: true }
const UNKNOWN = [{ unknown: true }];
// A command whose options decide WHICH file it writes (a config file, a response header, a list, --parents ...) in a way we do not follow: it may write ANY file (an existing script too), and a
// script missing now may have been created by it (`unmodelled`)
const anywhere = (idx) => ({ idx, dest: null, items: UNKNOWN, loose: true });
const orAnywhere = (recs, idx, yes) => { if (yes) { recs.push(anywhere(idx)); recs.unmodelled = true; } return recs; };
const RC_ENV = /^(?:WGETRC|CURL_HOME|XDG_CONFIG_HOME|HOME)$/; // (a startup file of the tool is read from there: it can name outputs)
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
const CURL_SHORT_VALUE = 'AbcCdDeEFHhKmoPQrtTuUwXxyYz';
const CURL_LONG_OUT = new Set(['output', 'dump-header', 'cookie-jar', 'trace', 'trace-ascii', 'stderr', 'etag-save', 'hsts', 'alt-svc', 'libcurl', 'output-dir']);
const CURL_LONG_VALUE = new Set(['header', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'request', 'user-agent', 'user', 'referer', 'max-time', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'form', 'form-string', 'write-out', 'proxy', 'proxy-user', 'upload-file', 'range', 'cookie', 'cacert', 'cert', 'key', 'url', 'resolve', 'connect-to', 'limit-rate', 'continue-at', 'time-cond', 'oauth2-bearer', 'json', 'variable', 'expand-url', 'aws-sigv4', 'interface', 'dns-servers', 'noproxy', 'proto', 'request-target', 'speed-limit', 'speed-time', 'max-filesize', 'max-redirs', 'tls-max', 'ciphers', 'pinnedpubkey', 'quote', 'telnet-option', 'ftp-port', 'unix-socket', 'etag-compare', 'happy-eyeballs-timeout-ms', 'max-redirs', 'keepalive-time', 'local-port', 'parallel-max', 'rate']);
const CURL_LONG_SWITCH = new Set(['retry-connrefused', 'tlsv1', 'silent', 'show-error', 'location', 'fail', 'insecure', 'head', 'include', 'verbose', 'compressed', 'globoff', 'remote-name', 'remote-name-all', 'remote-header-name', 'create-dirs', 'progress-bar', 'no-progress-meter', 'fail-with-body', 'location-trusted', 'get', 'http1.1', 'http2', 'http3', 'ipv4', 'ipv6', 'no-buffer', 'netrc', 'anyauth', 'basic', 'digest', 'negotiate', 'ntlm', 'tcp-nodelay', 'raw', 'path-as-is', 'show-headers', 'fail-early', 'parallel', 'parallel-immediate', 'no-keepalive', 'junk-session-cookies', 'ssl-reqd', 'ssl', 'tlsv1.2', 'tlsv1.3', 'disable', 'proxy-insecure', 'suppress-connect-headers', 'styled-output', 'xattr', 'remove-on-error', 'skip-existing', 'no-clobber', 'clobber', 'compressed-ssh', 'doh-insecure', 'ignore-content-length']);
// wget: its options (wget's own table: a boolean takes an optional =VALUE and has a --no- form; a valued one takes the next word). An abbreviation is not resolved: our list may not be the whole of wget's,
// so an unknown or abbreviated name is unmodelled.
// the wget options that cannot rename or re-root the file a URL is saved as (the others make it `may write anywhere`)
const WGET_PLAIN = new Set(['O', 'output-document', 'P', 'directory-prefix', 'o', 'output-file', 'a', 'append-output', 'save-cookies', 'rejected-log', 'hsts-file', 'b', 'background', 'q', 'quiet', 'v', 'verbose', 'c', 'continue', 'S', 'server-response',
  '4', '6', 'inet4-only', 'inet6-only', 'check-certificate', 'show-progress', 'N', 'timestamping', 'n', 'nc', 'no-clobber', 'clobber', 'T', 'timeout', 't', 'tries', 'w', 'wait', 'waitretry', 'dns-timeout', 'connect-timeout', 'read-timeout', 'limit-rate',
  'user', 'password', 'http-user', 'http-password', 'header', 'U', 'user-agent', 'referer', 'load-cookies', 'proxy-user', 'proxy-password', 'bind-address', 'secure-protocol', 'certificate', 'certificate-type', 'private-key', 'private-key-type', 'ca-certificate',
  'ca-directory', 'crl-file', 'ciphers', 'pinnedpubkey', 'max-redirect', 'retry-on-http-error', 'retry-connrefused', 'report-speed', 'progress', 'prefer-family', 'compression', 'post-data', 'post-file', 'method', 'body-data', 'body-file', 'cache', 'cookies', 'keep-session-cookies',
  'http-keep-alive', 'auth-no-challenge', 'https-only', 'content-on-error', 'dns-cache', 'ignore-length', 'random-wait', 'proxy', 'spider', 'd', 'debug', 'h', 'help', 'V', 'version', 'hsts', 'ask-password', 'directories']);
const WGET_OPTIONS = {
  exact: true, negate: true, switchEq: true,
  shortVal: 'OPoaetTwQiBlARDIXnUY', shortSwitch: 'bdqvVhrmkKpxLsNcSFEH46',
  longVal: ['execute', 'output-file', 'append-output', 'report-speed', 'input-file', 'input-metalink', 'base', 'config', 'rejected-log', 'tries', 'retry-on-http-error', 'output-document', 'backups', 'start-pos', 'progress', 'timeout', 'dns-timeout', 'connect-timeout', 'read-timeout', 'wait', 'waitretry', 'quota', 'bind-address', 'limit-rate', 'restrict-file-names', 'prefer-family', 'user', 'password', 'use-askpass', 'local-encoding', 'remote-encoding', 'metalink-index', 'preferred-location', 'directory-prefix', 'cut-dirs', 'http-user', 'http-password', 'default-page', 'header', 'compression', 'max-redirect', 'proxy-user', 'proxy-password', 'referer', 'user-agent', 'load-cookies', 'save-cookies', 'post-data', 'post-file', 'method', 'body-data', 'body-file', 'secure-protocol', 'certificate', 'certificate-type', 'private-key', 'private-key-type', 'ca-certificate', 'ca-directory', 'crl-file', 'pinnedpubkey', 'random-file', 'egd-file', 'ciphers', 'hsts-file', 'ftp-user', 'ftp-password', 'warc-file', 'warc-header', 'warc-max-size', 'warc-dedup', 'warc-tempdir', 'level', 'accept', 'reject', 'accept-regex', 'reject-regex', 'regex-type', 'domains', 'exclude-domains', 'follow-tags', 'ignore-tags', 'include-directories', 'exclude-directories', 'bind-dns-address', 'dns-servers'],
  longOpt: [],
  longSwitch: ['help', 'version', 'background', 'debug', 'quiet', 'verbose', 'force-html', 'retry-connrefused', 'retry-on-host-error', 'continue', 'show-progress', 'timestamping', 'server-response', 'spider', 'random-wait', 'proxy', 'ask-password', 'iri', 'unlink', 'keep-badhash', 'metalink-over-http', 'xattr', 'directories', 'force-directories', 'host-directories', 'protocol-directories', 'cache', 'adjust-extension', 'ignore-length', 'save-headers', 'http-keep-alive', 'cookies', 'keep-session-cookies', 'content-disposition', 'content-on-error', 'auth-no-challenge', 'https-only', 'check-certificate', 'hsts', 'remove-listing', 'glob', 'passive-ftp', 'preserve-permissions', 'retr-symlinks', 'ftps-implicit', 'ftps-resume-ssl', 'ftps-clear-data-connection', 'ftps-fallback-to-ftp', 'warc-cdx', 'warc-compression', 'warc-digests', 'warc-keep-log', 'recursive', 'delete-after', 'convert-file-only', 'convert-links', 'backup-converted', 'mirror', 'page-requisites', 'strict-comments', 'follow-ftp', 'span-hosts', 'relative', 'parent', 'clobber', 'if-modified-since', 'use-server-timestamps', 'dns-cache', 'ignore-case', 'inet4-only', 'inet6-only', 'trust-server-names'],
};
// git clone / git worktree add: every option of the subcommand (git takes a unique prefix of a long one, and --no-X negates a boolean X)
const GIT_CLONE_OPTIONS = {
  negate: true, shortVal: 'obcuj', shortSwitch: 'lsqvn46',
  longVal: ['origin', 'branch', 'config', 'upload-pack', 'template', 'depth', 'shallow-since', 'shallow-exclude', 'reference', 'reference-if-able', 'separate-git-dir', 'jobs', 'filter', 'bundle-uri', 'server-option', 'ref-format', 'revision'],
  longOpt: ['recurse-submodules'],
  longSwitch: ['local', 'hardlinks', 'shared', 'dissociate', 'quiet', 'verbose', 'progress', 'checkout', 'bare', 'mirror', 'single-branch', 'tags', 'shallow-submodules', 'remote-submodules', 'sparse', 'reject-shallow', 'also-filter-submodules', 'recursive', 'ipv4', 'ipv6', 'no-checkout', 'no-hardlinks', 'help'],
};
const GIT_WORKTREE_ADD_OPTIONS = {
  negate: true, shortVal: 'bB', shortSwitch: 'fdq', longVal: ['reason'], longOpt: [],
  longSwitch: ['force', 'detach', 'checkout', 'lock', 'orphan', 'quiet', 'track', 'guess-remote', 'relative-paths', 'no-checkout'],
};
function curlRecords(args, idx, env = {}) {
  const out = [];
  let anyOutput = Object.keys(env).some((k) => RC_ENV.test(k)); // (a config file: -K / --config / --next / a startup file from CURL_HOME: it can name any output)
  const unknown = (dest, extra = {}) => ({ idx, dest, items: UNKNOWN, ...extra });
  let remote = false;
  let header = false;
  let outDir = '';
  const urls = [];
  const named = []; // -o / --output names: --output-dir (before or after) puts a relative one below it
  // Why: -w / --write-out prints a format; %output{FILE} (>>FILE appends) in it writes FILE, and @FILE reads the format from a file that may say the same
  const writeOut = (v) => {
    if (v.startsWith('@')) { anyOutput = true; return; }
    for (const m of v.matchAll(/%output\{([^}]*)\}?/g)) { if (!m[0].endsWith('}')) anyOutput = true; else if (m[1].replace(/^>>/, '') !== '') out.push(unknown(m[1].replace(/^>>/, ''))); }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { urls.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : null;
      if (nm === 'config' || nm === 'next') { anyOutput = true; continue; }
      if (CURL_LONG_OUT.has(nm)) {
        const v = val ?? args[++i] ?? '';
        if (nm === 'output-dir') outDir = v; else if (nm === 'output') { if (v !== '-' && v !== '') named.push(v); } else if (v !== '-' && v !== '') out.push(unknown(v));
      } else if (nm === 'url') urls.push(val ?? args[++i] ?? '');
      else if (nm === 'write-out') writeOut(val ?? args[++i] ?? '');
      else if (nm === 'remote-name' || nm === 'remote-name-all') remote = true;
      else if (nm === 'remote-header-name') { remote = true; header = true; } else if (CURL_LONG_VALUE.has(nm)) { if (val === null) i++; } else if (!CURL_LONG_SWITCH.has(nm)) return null; // not certain
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === ':') { anyOutput = true; continue; } // -: is --next: a new operation group, the output state starts again (any file)
        if (ch === 'O') { remote = true; continue; }
        if (ch === 'J') { remote = true; header = true; continue; }
        if (!CURL_SHORT_VALUE.includes(ch)) continue; // a switch
        if (ch === 'K') { anyOutput = true; break; }
        const rest = a.slice(k + 1);
        const v = rest !== '' ? rest : (args[++i] ?? ''); // (attached verbatim: `-o=n.sh` is the file `=n.sh`)
        if (ch === 'w') writeOut(v);
        if (ch === 'o') { if (v !== '-' && v !== '') named.push(v); } else if (ch === 'D' || ch === 'c') { if (v !== '-' && v !== '') out.push(unknown(v)); }
        break;
      }
      continue;
    }
    urls.push(a);
  }
  // Why: curl puts the name below --output-dir whatever it looks like (`d//abs/n.sh`); a version that leaves an absolute name alone writes it as it is: both are recorded
  const inDir = (n) => (outDir ? `${outDir.replace(/\/+$/, '')}/${n.replace(/^\/+/, '')}` : n);
  for (const n of named) { out.push(unknown(inDir(n))); if (outDir && (n.startsWith('/') || /^[A-Za-z]:/.test(n))) out.push(unknown(n)); }
  if (urls.some((u) => /[[{]/.test(u)) && !args.some((a) => a === '-g' || a === '--globoff') || out.some((o) => /#\d/.test(o.dest))) anyOutput = true; // (a globbed URL / a #1 output name makes many files)
  if (remote) {
    for (const u of urls) if (urlBase(u)) out.push(unknown(inDir(urlBase(u))));
    if (header) out.push(unknown(outDir || '.', { subtree: true })); // the name comes from the response
  }
  return orAnywhere(out, idx, anyOutput);
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
// Strict getopt for a command whose options we know completely (GNU getopt_long): a long option may be written as any unique prefix of a known one (--target-d); `longVal` take a value
// (next word or =), `longOpt` only with =, `longSwitch` none. `negate`: --no-X negates a known X (git). `bad`: an option we cannot place (unknown, ambiguous, a short option not listed): the
// operands may be shifted, so the caller treats the command as unmodelled. Opt names are the resolved full names.
function getoptStrict(args, { shortVal = '', shortSwitch = '', longVal = [], longOpt = [], longSwitch = [], negate = false, exact = false, switchEq = false }) {
  const pos = [];
  const opts = [];
  let bad = false;
  const all = [...longVal, ...longOpt, ...longSwitch];
  const resolve = (nm) => {
    if (all.includes(nm)) return nm;
    if (negate && ('no-'.startsWith(nm) || nm.startsWith('no-'))) return null; // (an abbreviation of --no-X may be the negation of any X: ambiguous)
    const m = all.filter((x) => x.startsWith(nm));
    return !exact && nm !== '' && m.length === 1 ? m[0] : null;
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { pos.push(...args.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const nm = eq > 0 ? t.slice(2, eq) : t.slice(2);
      let full = resolve(nm);
      let negated = false;
      if (full === null && negate && nm.startsWith('no-')) { full = resolve(nm.slice(3)); negated = full !== null; }
      if (full === null) { bad = true; continue; }
      if (negated || longSwitch.includes(full)) { if (eq > 0 && !negated && !switchEq) bad = true; opts.push({ name: full, value: null, negated }); } else if (longOpt.includes(full)) opts.push({ name: full, value: eq > 0 ? t.slice(eq + 1) : null });
      else opts.push({ name: full, value: eq > 0 ? t.slice(eq + 1) : (args[++i] ?? '') });
    } else if (t.length > 1 && t[0] === '-') {
      for (let k = 1; k < t.length; k++) {
        if (shortVal.includes(t[k])) {
          let value = t.slice(k + 1); // (verbatim: `-O=n.sh` is the file `=n.sh`)
          if (value === '') value = args[++i] ?? '';
          opts.push({ name: t[k], value });
          break;
        }
        if (!shortSwitch.includes(t[k])) bad = true;
        opts.push({ name: t[k], value: null });
      }
    } else pos.push(t);
  }
  return { pos, opts, bad };
}
const optValue = (opts, ...names) => opts.find((o) => names.includes(o.name) && o.value !== null)?.value ?? null;
const hasOpt = (opts, ...names) => opts.some((o) => names.includes(o.name));
const optValues = (opts, ...names) => opts.filter((o) => names.includes(o.name) && o.value !== null).map((o) => o.value); // (every occurrence: a repeated option counts each time)

// cp mv ln install: their options (GNU and BSD), complete, so a long option can be resolved and an unknown one is noticed
const COPY_STRICT = {
  cp: { shortVal: 'tS', shortSwitch: 'abcdfHiLlnPpRrsTuvxXZ', longVal: ['target-directory', 'suffix', 'no-preserve', 'sparse'], longOpt: ['backup', 'preserve', 'reflink', 'context'],
    longSwitch: ['archive', 'attributes-only', 'copy-contents', 'debug', 'dereference', 'force', 'interactive', 'link', 'no-clobber', 'no-dereference', 'no-target-directory', 'one-file-system', 'parents', 'recursive', 'remove-destination', 'strip-trailing-slashes', 'symbolic-link', 'update', 'verbose', 'keep-directory-symlink', 'help', 'version'] },
  mv: { shortVal: 'tS', shortSwitch: 'bfhinTuvxZ', longVal: ['target-directory', 'suffix'], longOpt: ['backup', 'update', 'context'],
    longSwitch: ['debug', 'exchange', 'force', 'interactive', 'no-clobber', 'no-copy', 'no-target-directory', 'strip-trailing-slashes', 'verbose', 'help', 'version'] },
  ln: { shortVal: 'tS', shortSwitch: 'bdFfhiLnPrsTvw', longVal: ['target-directory', 'suffix'], longOpt: ['backup'],
    longSwitch: ['directory', 'force', 'interactive', 'logical', 'no-dereference', 'physical', 'relative', 'symbolic', 'no-target-directory', 'verbose', 'help', 'version'] },
  install: { shortVal: 'mogStBfl', shortSwitch: 'bCcdDMpsTUvZ', longVal: ['mode', 'owner', 'group', 'suffix', 'target-directory', 'strip-program'], longOpt: ['backup', 'context'],
    longSwitch: ['compare', 'directory', 'debug', 'preserve-timestamps', 'preserve-context', 'strip', 'no-target-directory', 'unprivileged', 'verbose', 'create-leading', 'help', 'version'] },
};
// sort / uniq: their options (GNU and BSD), complete, so --out= (a unique prefix of --output) is found and an option we do not know is noticed
const SORT_OPTIONS = {
  shortVal: 'kotST', shortSwitch: 'bdfgiMhnRrVcCmsuzHlBp',
  longVal: ['key', 'field-separator', 'output', 'buffer-size', 'temporary-directory', 'files0-from', 'compress-program', 'parallel', 'batch-size', 'random-source', 'sort'], longOpt: ['check'],
  longSwitch: ['ignore-leading-blanks', 'dictionary-order', 'ignore-case', 'general-numeric-sort', 'ignore-nonprinting', 'month-sort', 'human-numeric-sort', 'numeric-sort', 'random-sort', 'reverse', 'version-sort', 'merge', 'stable', 'unique', 'zero-terminated', 'debug', 'help', 'version', 'radix-sort', 'mergesort', 'heapsort', 'qsort'],
};
const UNIQ_OPTIONS = {
  shortVal: 'fsw', shortSwitch: 'cdDiuz', longVal: ['skip-fields', 'skip-chars', 'check-chars'], longOpt: ['all-repeated', 'group'],
  longSwitch: ['count', 'repeated', 'ignore-case', 'unique', 'zero-terminated', 'help', 'version'],
};
// sort that only prints: every option read, no -o / --output, no --compress-program (it runs a program)
export function sortArgsPure(args) {
  const { opts, bad } = getoptStrict(args, SORT_OPTIONS);
  return !bad && !hasOpt(opts, 'o', 'output', 'compress-program');
}
// rsync: long options that name files we do not follow (a batch, a backup / link / compare / copy / partial / temp dir, a log, a daemon or config, a file list), an abbreviation counts
const RSYNC_FILE_OPTIONS = ['backup', 'backup-dir', 'suffix', 'link-dest', 'copy-dest', 'compare-dest', 'partial-dir', 'temp-dir', 'log-file', 'write-batch', 'only-write-batch', 'read-batch', 'daemon', 'config', 'files-from', 'remove-source-files', 'write-devices', 'sparse', 'rsh', 'rsync-path', 'remote-option'];
const COPY_VALUE = {
  ditto: ['', []], rsync: ['eBMfT', ['rsh', 'exclude', 'include', 'filter', 'exclude-from', 'include-from', 'files-from', 'temp-dir', 'backup-dir', 'suffix']],
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

// cat with no option at all (-u is ignored, -- and - are operands) prints its files as they are; every other reader and every other cat option changes the text
const isExactCat = (name, argv) => {
  if (name !== 'cat') return false;
  const dd = argv.indexOf('--', 1);
  return argv.slice(1, dd < 0 ? undefined : dd).every((a) => a === '-u' || a === '-' || !a.startsWith('-'));
};

// What a command prints on stdout, for `> F`: known for echo / printf / the readers (cat ...) / `:`; anything else is unknown.
function stdoutItems(cmd) {
  const argv = cmd.argv;
  if (!argv.length) return UNKNOWN; // a group `{ ...; } > F` / `( ... ) > F`, or a bare `> F`
  const name = commandName(argv[0]);
  const s = cmd.streams?.();
  if (!s) { // no stream information (never "nothing written"): the text it prints is unknown, and every file it could be reading is a source
    const names = argv.slice(1).filter((a) => !a.startsWith('-') && a !== '');
    const own = name === 'echo' ? textItems(echoTexts(argv).texts) : [];
    return withRedirectedInput(cmd, [{ unknown: true }, ...own, ...names.map((w) => (isExactCat(name, argv) ? { file: w } : { scan: w }))]);
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
    if (!isExactCat(name, argv)) { // Why: tac reorders, head / tail -c cut ("…main-x" -> "…main"), cat -A / -n add text, less / bat decorate: the file is not the text, so it is scanned and the text is unknown
      for (const x of [s.out, s.stdin]) items.push(...x.files.map((scan) => ({ scan })), ...x.computed.map((scan) => ({ scan })));
      return dedupe([{ unknown: true }, ...items]);
    }
    fromStream(s.out);
    fromStream(s.stdin);
    const stdinUnknown = s.stdin.fed && !s.stdin.texts.length && !s.stdin.files.length && !s.stdin.computed.length;
    if (stdinUnknown) items.push({ unknown: true });
    // Why: for a reader the texts `out` lists (its own heredoc / here-string) ARE what it reads on stdin: the file holds them once. The files it names (cat a - < a) are
    // pieces of their own, in order, so `cat a - < a` is a twice
    const outParts = partsOfStream({ ...s.out, texts: [] });
    return withParts(items.length ? dedupe(items) : [{ text: '' }], [...outParts, ...partsOfStream(s.stdin), ...(stdinUnknown ? [[{ unknown: true }]] : [])]);
  } else if (name === ':' || name === 'true' || name === 'false') items.push({ text: '' });
  // a program's output: unknown, but the files it reads are worth a scan (base64 -d x.b64; a sed `r FILE`) -- and so are the files its upstream pipe stages read (`cat up.txt | tr A-Z a-z`); text piped in is rewritten too: text the line itself wrote that we cannot compute
  else return [{ unknown: true }, ...(s.stdin.texts.length ? [{ unknown: true, authored: true }] : []), ...[...s.out.computed, ...s.stdin.files, ...s.stdin.computed].map((scan) => ({ scan })), ...(name === 'sed' || name === 'gsed' ? sedReadFiles(argv.slice(1)).map((scan) => ({ scan })) : [])];
  return items.length ? dedupe(items) : [{ text: '' }];
}

const FD_DUP = /^&(?:\d+|-)$/; // (>&2, >&-: the only duplications)
function redirectRecords(cmd, idx) {
  const out = [];
  for (const r of cmd.redirects ?? []) {
    if (!WRITE_OPS.has(r.op) || typeof r.target !== 'string' || !r.target || FD_DUP.test(r.target) || r.target === '/dev/null') continue;
    let items;
    // Why: <> opens for reading AND writing: `cmd 1>&0 <> n.sh`, `exec 3<> n.sh` + `>&3` write the file with text we cannot follow, so it is never skipped as a read
    if (r.op === '<>' && (r.fd === null || r.fd === 0)) items = UNKNOWN;
    else if (r.fd === null || r.fd === 1) items = stdoutItems(cmd);
    else if (r.fd === 2) items = [...textItems([cmd.argv.join(' '), ...cmd.argv]), { unknown: true }]; // stderr: messages that quote the arguments
    else items = UNKNOWN;
    // `&>` / `>&` also catch stderr
    if ((r.op === '&>' || r.op === '&>>' || r.op === '>&') && !items.some((i) => i.unknown)) items = [...items, ...textItems([cmd.argv.join(' '), ...cmd.argv])];
    out.push({ idx, dest: r.target, items, parts: items.parts, append: r.op === '>>' || r.op === '&>>' });
    // Why: `>&"&"n.sh` reaches us as the target `&n.sh`: a file named with the & (and the shell may read the & as part of the operator: n.sh)
    if (r.target.startsWith('&') && r.target.length > 1) out.push({ idx, dest: r.target.slice(1), items, parts: items.parts, append: r.op === '>>' || r.op === '&>>' });
  }
  return out;
}

const urlBase = (u) => u.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();

// The records of the files a command writes by its arguments, or null when it is not a writer we model.
function argRecords(cmd, name, idx, lineEnv = {}, io = {}) {
  const args = cmd.argv.slice(1);
  const unknown = (dest, extra = {}) => ({ idx, dest, items: UNKNOWN, ...extra });
  if (COPY_STRICT[name] || COPY_VALUE[name] || (name === 'git' && gitSub(args) === 'mv')) {
    const mv = name === 'git'; // git mv SRC DST: the words after the real subcommand
    let pos;
    let opts;
    if (COPY_STRICT[name]) {
      const r = getoptStrict(args, COPY_STRICT[name]);
      if (r.bad) return null; // (an option we cannot place may have shifted the operands)
      ({ pos, opts } = r);
    } else {
      const [sv, lv] = mv ? ['', []] : COPY_VALUE[name];
      ({ pos, opts } = getopt(mv ? args.slice(gitSubAt(args) + 1) : args, sv, lv));
    }
    if (mv) { // git -C d mv a b moves inside d (the words are read there); --work-tree / --git-dir / -c / a repeated -C: not placed
      const g = gitGlobals(args);
      if (!g.plain) return orAnywhere([], idx, true);
      if (g.dir) pos = pos.map((p) => (p.startsWith('/') || p.startsWith('~') ? p : `${g.dir.replace(/\/+$/, '')}/${p}`));
    }
    if (name === 'install' && hasOpt(opts, 'd', 'directory')) return [];
    const targets = optValues(opts, 't', 'target-directory'); // (a repeated -t: every one)
    let link = name === 'ln' ? (hasOpt(opts, 's', 'symbolic') ? 'sym' : 'hard') : undefined;
    if (name === 'cp') link = hasOpt(opts, 's', 'symbolic-link') ? 'sym' : hasOpt(opts, 'l', 'link') ? 'hard' : undefined; // (cp -s / -l make links, not copies)
    // Why: --exchange swaps the two files and --strip-program runs a program: the files written are not DEST / DEST/basename. rsync takes many more options that name files (a batch, a backup or link dir, a file list ...)
    const rsyncOdd = name === 'rsync' && opts.some((o) => (o.name.length === 1 ? 'bTe'.includes(o.name) : RSYNC_FILE_OPTIONS.some((n) => n.startsWith(o.name))));
    const odd = hasOpt(opts, 'exchange', 'strip-program') || rsyncOdd || (name === 'rsync' && Object.keys({ ...cmd.env, ...lineEnv }).some((k) => /^RSYNC_/.test(k)));
    // Why: cp --parents / rsync -R put each source at DEST/<the path as written> (rsync keeps only what follows a `/./` marker): the source's own path below DEST, as a copy of it. rsync's plain form is kept too (--no-relative may follow)
    const parents = name === 'cp' && hasOpt(opts, 'parents');
    const relative = name === 'rsync' && opts.some((o) => o.name === 'R' || (o.name.length >= 3 && 'relative'.startsWith(o.name)));
    const build = (dest, srcs) => {
      const out = [];
      if (!parents) out.push({ idx, dest, copy: true, link, items: srcs.map((file) => ({ file })) });
      if (parents || relative) {
        for (const src of srcs) {
          if (src.includes('/./')) { out.push(anywhere(idx)); out.unmodelled = true; continue; }
          out.push({ idx, dest: `${dest.replace(/\/+$/, '')}/${src.replace(/^\/+/, '')}`, copy: true, link, items: [{ file: src }] });
        }
      }
      return out;
    };
    // Why: -b / --backup[=CONTROL] / -S / --suffix (install -B), or SIMPLE_BACKUP_SUFFIX / VERSION_CONTROL in the command's or the line's environment: the file replaced is first moved / copied to DEST + suffix (`~`, install .old,
    // numbered `.~N~`) and so holds DEST's OLD text (`cp -b -S .sh ok.txt n; bash n.sh` runs n's old text); a suffix only known at run time may be anything
    const backups = (dests, srcs) => {
      if (name === 'rsync' || name === 'ditto') return [];
      const envOf = (k) => (cmd.env && Object.hasOwn(cmd.env, k) ? cmd.env[k] : Object.hasOwn(lineEnv, k) ? null : undefined); // (undefined: not set, null: set, value not known)
      const sufEnv = envOf('SIMPLE_BACKUP_SUFFIX');
      const ctlEnv = envOf('VERSION_CONTROL');
      if (!hasOpt(opts, 'b', 'backup', 'S', 'suffix', 'B') && sufEnv === undefined && ctlEnv === undefined) return [];
      const ctlOpt = optValue(opts, 'backup');
      const control = ctlOpt !== null && ctlOpt !== '' ? ctlOpt : ctlEnv === undefined ? '' : ctlEnv;
      if (control !== null && /^(?:none|off)$/.test(control)) return [];
      const numbered = control === null || /^(?:t|numbered|existing|nil|)$/.test(control) || !/^(?:simple|never)$/.test(control);
      const simple = control === null || !/^(?:t|numbered)$/.test(control);
      const sufs = [...optValues(opts, 'S', 'suffix', 'B')];
      if (!sufs.length) { if (sufEnv === null) return [anywhere(idx)]; sufs.push(sufEnv !== undefined ? sufEnv : '~'); if (name === 'install' && sufEnv === undefined) sufs.push('.old'); }
      if (sufs.some((x) => /[$`*?[{]/.test(x))) return [anywhere(idx)]; // (a suffix only known at run time may be anything: /../ok.sh)
      const bases = srcs.map((src) => src.replace(/\/+$/, '').split('/').pop());
      if (bases.some((b) => /[$`*?[{]/.test(b))) return [anywhere(idx)];
      const out = [];
      for (const d of dests) {
        const olds = [d, ...bases.map((b) => `${d.replace(/\/+$/, '')}/${b}`)];
        for (const old of olds) {
          if (simple) for (const suf of sufs) out.push({ idx, dest: old + suf, items: [{ file: old }] });
          if (numbered) out.push({ idx, dest: `${old}.~[0-9]*~`, items: [{ file: old }] });
        }
      }
      return out;
    };
    if (targets.length) { const r = targets.flatMap((dest) => build(dest, pos)); r.push(...backups(targets, pos)); return orAnywhere(r, idx, odd); }
    if (pos.length >= 2) { const r = build(pos[pos.length - 1], pos.slice(0, -1)); r.push(...backups([pos[pos.length - 1]], pos.slice(0, -1))); return orAnywhere(r, idx, odd); }
    if (name === 'ln' && pos.length === 1) return [{ idx, dest: '.', copy: true, link, items: pos.map((file) => ({ file })) }];
    return null; // too few operands to place the copy (a usage error to the shell, but not one we may rely on)
  }
  if (name === 'uniq') { // uniq [OPTION] [INPUT [OUTPUT]]: OUTPUT holds the lines of INPUT with repeats dropped, not INPUT
    const { pos, bad } = getoptStrict(args, UNIQ_OPTIONS);
    if (bad) return orAnywhere([], idx, true);
    return pos.length >= 2 ? [{ idx, dest: pos[1], items: [{ scan: pos[0] }, { unknown: true }] }] : [];
  }
  if (name === 'sort') { // sort -o OUT / --output=OUT: the lines of its inputs, reordered
    const { pos, opts, bad } = getoptStrict(args, SORT_OPTIONS);
    if (bad || hasOpt(opts, 'compress-program')) return orAnywhere([], idx, true); // (an option we cannot place may be -o; --compress-program runs a program)
    const outs = optValues(opts, 'o', 'output'); // (a repeated -o: every one)
    if (!outs.length) return null;
    const items = [...pos.map((scan) => ({ scan })), ...stdinItems(cmd).map((i) => (i.file !== undefined ? { scan: i.file } : i)), { unknown: true }];
    // Why: `sort -o f f` rearranges the lines of the file's own old text (a backslash-continued command can be completed by it): an edit, not a replacement
    return outs.map((dest) => ({ idx, dest, items, ...(pos.includes(dest) ? { edit: true } : {}) }));
  }
  if (name === 'split' || name === 'csplit' || name === 'patch') return orAnywhere([], idx, true); // (files named by a prefix, a suffix scheme or the headers of a diff)
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
    const { pos, opts, bad } = getoptStrict(args, { shortSwitch: 'aip', longOpt: ['output-error'], longSwitch: ['append', 'ignore-interrupts', 'help', 'version'] });
    if (bad) return null;
    const append = hasOpt(opts, 'a', 'append');
    return pos.filter((p) => p !== '-').map((dest) => { const items = stdinItems(cmd); return { idx, dest, items, parts: items.parts, append }; });
  }
  if (name === 'dd') {
    const ofs = args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)); // (a repeated if= / of=: every one counts)
    const ins = args.filter((a) => a.startsWith('if=')).map((a) => a.slice(3));
    // Why: bs= count= skip= seek= cut the input, conv=lcase / ucase / swab / sync / block change it ("…main-x" with count=1 bs=20 is "…main"): dd is an exact copy only with if= of= status= conv=notrunc oflag=append
    const valuesOf = (key) => args.filter((a) => a.startsWith(`${key}=`)).flatMap((a) => a.slice(key.length + 1).split(','));
    const plain = args.every((a) => /^(?:if|of|status)=/.test(a) || (/^conv=/.test(a) && valuesOf('conv').every((v) => v === 'notrunc')) || (/^oflag=/.test(a) && valuesOf('oflag').every((v) => v === 'append')));
    const append = valuesOf('oflag').includes('append');
    const notrunc = valuesOf('conv').includes('notrunc');
    // conv=notrunc without append writes over the start of the old file (new text + the old tail), and a seek (seek= / oseek= not 0, oflag=seek_bytes) keeps the old head (GNU dd truncates at the seek offset): neither an append nor a replacement
    const seeks = [...valuesOf('seek'), ...valuesOf('oseek')].some((v) => !/^0+$/.test(v)) || valuesOf('oflag').includes('seek_bytes');
    const edit = (notrunc || seeks) && !append;
    const exact = plain && !edit;
    if (exact) {
      const items = ins.length ? ins.map((file) => ({ file })) : stdinItems(cmd);
      return ofs.map((of) => ({ idx, dest: of, items, parts: items.parts, append }));
    }
    const from = ins.length ? ins.map((scan) => ({ scan })) : stdinItems(cmd).flatMap((i) => (i.file !== undefined ? [{ scan: i.file }] : i.scan !== undefined || i.unknown ? [i] : []));
    return ofs.map((of) => ({ idx, dest: of, items: dedupe([...from, { unknown: true }]), append, ...(edit ? { edit: true } : {}) }));
  }
  if (name === 'curl') return curlRecords(args, idx, { ...cmd.env, ...lineEnv });
  if (name === 'wget') {
    const { pos, opts, bad } = getoptStrict(args, WGET_OPTIONS);
    if (bad) return orAnywhere([], idx, true); // (an option we do not know, or abbreviate: the output file may be named by it)
    let odd2 = false;
    const out = [];
    const os = optValues(opts, 'O', 'output-document');
    const dir = optValue(opts, 'P', 'directory-prefix') ?? '';
    // Why: the file is the one the URL says only when every option is one that cannot rename or re-root it (an ALLOWLIST: -e / --config / -i / -B / -E / --content-disposition / --restrict-file-names / --default-page /
    // --metalink-* / --preferred-location / encodings / iri / a recursive run ... are not on it); a startup file (WGETRC ...) can name anything
    const noDirs = opts.some((o) => (o.name === 'n' && o.value === 'd') || (o.name === 'directories' && o.negated));
    const recursive = hasOpt(opts, 'r', 'recursive', 'm', 'mirror', 'p', 'page-requisites');
    const odd = opts.some((o) => !WGET_PLAIN.has(o.name) && !(noDirs && ['r', 'recursive', 'm', 'mirror', 'p', 'page-requisites'].includes(o.name))) || (recursive && !noDirs) || Object.keys({ ...cmd.env, ...lineEnv }).some((k) => RC_ENV.test(k));
    for (const lf of [...optValues(opts, 'o', 'output-file'), ...optValues(opts, 'a', 'append-output'), ...optValues(opts, 'save-cookies'), ...optValues(opts, 'rejected-log'), ...optValues(opts, 'hsts-file')]) if (lf) out.push(unknown(lf));
    if (hasOpt(opts, 'b', 'background') && !hasOpt(opts, 'o', 'output-file', 'a', 'append-output')) out.push(unknown('wget-log')); // (-b logs to wget-log)
    const inDir = (n) => (dir ? `${dir.replace(/\/+$/, '')}/${n}` : n);
    if (os.length) for (const o of os) out.push(unknown(o));
    else {
      // Why: a URL names the file by its last path segment (a query stays in the name, %XX is decoded); an empty segment (index.html / --default-page) is not a name we can read; an existing file is kept and the new one is `name.1`, `name.2` ...
      const clobberSafe = hasOpt(opts, 'N', 'timestamping') || opts.some((o) => o.name === 'clobber' && o.negated) || opts.some((o) => o.name === 'n' && o.value === 'c'); // (-nc is -n with the value c; -anc is -a with the log file nc)
      for (const u of pos) {
        const noFrag = u.replace(/#.*$/, '');
        const last = noFrag.endsWith('/') ? '' : noFrag.split('/').pop();
        if (!last || last.startsWith('?')) { out.push(unknown(dir || '.', { subtree: true })); odd2 = true; continue; }
        const names = new Set([urlBase(u), last]);
        try { names.add(decodeURIComponent(last)); names.add(decodeURIComponent(urlBase(u))); } catch { names.add(last); }
        for (const n of names) { if (!n) continue; out.push(unknown(inDir(n))); if (!clobberSafe) out.push(unknown(inDir(`${n}.[0-9]*`))); }
      }
    }
    if (recursive) out.push(unknown(dir || '.', { subtree: true })); // (no directories: every file lands in the one directory)
    return orAnywhere(out, idx, odd || odd2);
  }
  if (AWK_NAMES.has(name)) { // gawk -i inplace: every file operand is edited in place
    const r = awkScan(args, { ...cmd.env, ...lineEnv }, io.readProgram);
    if (!r.inPlace && !r.writes) return null;
    const out = r.inPlace ? r.files.map((dest) => unknown(dest, { edit: true })) : [];
    // Why: a program that writes (> >> | system(...)) is an inline-program writer like node -e: one that names the script is judged by its text; any other may still compute a file name (print > f), so it is a loose write of unknown content too
    if (r.writes) { const text = [...r.programs, ...args, ...Object.values(cmd.env ?? {})].join(' '); out.push({ idx, dest: null, inline: text, awk: true, items: [{ program: text }], loose: true }, anywhere(idx)); }
    return Object.assign(out, r.other || r.writes ? { unmodelled: true } : {});
  }
  if (name === 'sed' || name === 'gsed' || name === 'perl' || name === 'ruby') {
    const isSed = name === 'sed' || name === 'gsed';
    const inPlace = args.some((a) => (isSed ? sedInPlaceArg(a) : /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))); // (perl / ruby -I is an include path)
    const wfiles = isSed ? sedWriteTargets(args) : [];
    if (!inPlace) return wfiles.length ? wfiles.map((d) => unknown(d)) : null; // `w FILE` / `s///w FILE` write a file too
    // Why: an in-place edit turns the file's old text into new text (`s/X/sh/` completes `git puX`), so the file is a piece the line cannot see: `edit` (see contentsIn)
    if (isSed) return [...sedPrograms(args).targets.map((dest) => unknown(dest, { edit: true, sed: { args, word: dest } })), ...wfiles.map((dest) => unknown(dest))]; // (one parser for the programs and the files; an in-place sed may also `w FILE`)
    const { pos, opts } = getopt(args, 'eIlF', ['expression', 'file', 'line-length']);
    const hasProgram = hasOpt(opts, 'e', 'f', 'expression', 'file');
    return (hasProgram ? pos : pos.slice(1)).map((dest) => unknown(dest, { edit: true }));
  }
  if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
    const first = args[0] ?? '';
    const extract = (/^[A-Za-z]/.test(first) && first.includes('x')) || args.some((a) => /^-[A-Za-z]*x/.test(a) && !a.startsWith('--')) || args.includes('--extract') || args.includes('--get');
    const { opts } = getopt(args.map((a, i) => (i === 0 && /^[A-Za-z]/.test(a) ? `-${a}` : a)), 'CfT', ['directory', 'file']);
    if (args.some((a) => /^--(?:to-command|checkpoint-action|use-compress-program|rsh-command)/.test(a) || a === '-I')) return null;
    if (!extract) { // c / r / u write the archive named by -f
      const make = (/^[A-Za-z]/.test(first) && /[cru]/.test(first)) || args.some((a) => /^-[A-Za-z]*[cru]/.test(a) && !a.startsWith('--')) || args.some((a) => /^--(?:create|append|update)$/.test(a));
      // Why: tar uses the last -f, but a repeated one is every archive we may be wrong about: each is written
      return make ? optValues(opts, 'f', 'file').filter((arc) => arc && arc !== '-').map((arc) => unknown(arc)) : [];
    }
    // Why: each -C applies to the members after it (and relative ones compound): with more than one the members may land anywhere
    const dirs = optValues(opts, 'C', 'directory');
    return orAnywhere(dirs.length ? dirs.map((d) => unknown(d, { subtree: true })) : [unknown('.', { subtree: true })], idx, dirs.length > 1);
  }
  if (name === 'unzip') {
    const { opts } = getopt(args, 'dxP', ['exclude']);
    if (hasOpt(opts, 'l', 'p', 'Z', 't', 'v')) return [];
    return [unknown(optValue(opts, 'd') ?? '.', { subtree: true })];
  }
  if (name === 'git') {
    // global options, then the subcommand
    const g = gitGlobals(args);
    const dir = g.dir;
    const sub = args[g.at];
    const rest = args.slice(g.at + 1);
    const at = (p) => (dir && !p.startsWith('/') && !p.startsWith('~') ? `${dir.replace(/\/+$/, '')}/${p}` : p);
    // Why: --work-tree / --git-dir / -c (core.worktree, clone.*) / a repeated -C move where a subcommand writes: only a lone `-C DIR` (read here) or no global option at all leaves the place a name can be compared with
    const placed = g.plain;
    if (sub === 'checkout' || sub === 'restore' || sub === 'checkout-index') {
      const { pos } = getopt(rest, sub === 'checkout' ? 'bB' : 'sS', ['source', 'orphan', 'conflict', 'pathspec-from-file']);
      return orAnywhere(pos.map((p) => unknown(at(p))), idx, !placed);
    }
    if (sub === 'clone') {
      // Why: `narrow` (only scripts below the directory) is right only when the directory is the word git takes: one unlisted value option shifts the operands, a global option moves the base. Else the clone may write anywhere
      const { pos, bad } = getoptStrict(rest, GIT_CLONE_OPTIONS);
      const exact = !bad && pos.length >= 1 && pos.length <= 2 && placed;
      const d = pos[1] ?? (pos[0] ? urlBase(pos[0]).replace(/\.git$/, '') : '.');
      return orAnywhere([unknown(at(d), { subtree: true, narrow: exact })], idx, !exact);
    }
    if (GIT_OUTPUT.has(sub)) { // git diff --output=F, git log --output=F (also --out=F: a prefix), git archive -o F, git format-patch -o DIR
      const { opts } = getopt(rest, 'o', ['output', 'output-directory']);
      const out = [...optValues(opts, 'o', 'output', 'output-directory')];
      for (let k = 0; k < rest.length; k++) { // (a long option that is a prefix of --output / --output-directory: git takes a unique one)
        const a = rest[k];
        if (!a.startsWith('--') || !prefixOfAny(a, ['output', 'output-directory'])) continue;
        if (a.includes('=')) out.push(a.slice(a.indexOf('=') + 1)); else if (rest[k + 1] !== undefined) out.push(rest[k + 1]);
      }
      if (!out.length) return null;
      return orAnywhere([...new Set(out)].map((o) => unknown(at(o), { subtree: sub === 'format-patch' })), idx, !placed);
    }
    if (sub === 'worktree' && rest[0] === 'add') {
      const { pos, bad } = getoptStrict(rest.slice(1), GIT_WORKTREE_ADD_OPTIONS);
      const exact = !bad && pos.length >= 1 && pos.length <= 2 && placed; // (<path> [<commit-ish>])
      return orAnywhere(pos[0] ? [unknown(at(pos[0]), { subtree: true, narrow: exact })] : [], idx, !exact);
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
// git's global options, read the way git does: `-C DIR`, `-c K=V`, `--git-dir X` / `--git-dir=X` take a value (the next word only without `=`); the rest are switches.
// `at`: the index of the subcommand, `dir`: the last -C, `nC`: how many -C, `plain`: only options that cannot change what a subcommand writes or runs (-C aside)
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);
const GIT_GLOBAL_PLAIN = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--no-lazy-fetch', '--no-advice', '--bare', '--version']);
const SAME_GITDIR = /^(?:\.\/)?\.git\/?$/; // (the repository git would find anyway)
function gitGlobals(args) {
  let i = 0;
  let dir = null;
  let nC = 0;
  let plain = true;
  let readOk = true; // only options that merely choose which repository is read (no program, config or pager)
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    // Why: --git-dir / --work-tree / --namespace make git read ANOTHER repository's config (fsmonitor, diff.external, textconv, pager): not a read we can call pure
    if (GIT_GLOBAL_VALUE.has(a)) { if (a === '-C') { dir = args[i + 1] ?? null; nC++; } else { plain = false; if (!(a === '--git-dir' && SAME_GITDIR.test(args[i + 1] ?? ''))) readOk = false; } i += 2; continue; }
    // `--git-dir=X` is one word (skipping a second would swallow the subcommand), `--exec-path[=P]` never takes the next word
    if (!GIT_GLOBAL_PLAIN.has(a)) { plain = false; if (!(a.startsWith('--git-dir=') && SAME_GITDIR.test(a.slice(10)))) readOk = false; }
    i++;
  }
  return { at: i, dir, nC, plain: plain && nC <= 1, readOk };
}
const gitSubAt = (args) => gitGlobals(args).at;
const gitSub = (args) => args[gitSubAt(args)];

// Purity is an ALLOWLIST of read-only shapes (anything else may write a file, run a pager / hook / alias, or change the tree): `format-patch`, `bundle`, `archive -o`, `worktree add`, `stash push`, `am`,
// `apply`, `notes`, any `-c` / `--config-env` / `--exec-path` / `-p`, an alias (`git x` for an x that is no builtin) are none of them. A prefix of a long option counts (git takes a unique one: --out=F is --output=F).
const prefixOfAny = (a, names) => { if (!a.startsWith('--')) return false; const nm = a.slice(2).split('=')[0]; return nm !== '' && names.some((n) => n.startsWith(nm)); };
const GIT_PLAIN_READ = new Set(['status', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'annotate', 'describe', 'merge-base', 'for-each-ref', 'show-ref', 'name-rev', 'rev-list', 'count-objects', 'show-branch', 'check-ignore', 'check-attr', 'var', 'version', 'ls-remote', 'cherry', 'verify-commit', 'verify-tag', 'fsck-objects', 'get-tar-commit-id', 'merge-tree', 'diff-index', 'diff-files']);
const GIT_DIFFLIKE = new Set(['diff', 'log', 'show', 'shortlog', 'whatchanged', 'diff-tree', 'range-diff']);
const GIT_ENV_RISK = /^(?:GIT_(?:CONFIG\w*|EXTERNAL_DIFF|PAGER|EXEC_PATH|SSH\w*|PROXY_COMMAND|ASKPASS|EDITOR|SEQUENCE_EDITOR|TEMPLATE_DIR|ALTERNATE_OBJECT_DIRECTORIES|DIR|WORK_TREE|OBJECT_DIRECTORY|INDEX_FILE|TRACE\w*)|PAGER|EDITOR|VISUAL|SSH_ASKPASS)$/;
function gitPure(args, envKeys = [], cfgWritten = false) {
  if (envKeys.some((k) => GIT_ENV_RISK.test(k))) return false;
  const g = gitGlobals(args);
  if (!g.readOk) return false;
  const sub = args[g.at];
  const rest = args.slice(g.at + 1);
  if (sub === undefined) return true;
  if (cfgWritten && sub !== 'version') return false; // (the line may have written the config a read runs programs from)
  const dashed = rest.filter((a) => a.startsWith('-'));
  const pos = rest.filter((a) => !a.startsWith('-'));
  // Why: ls-remote -u / --upload-pack / --exec / --receive-pack run a program on the other side; stash show / list and reflog print diffs, so --output / -o / ext-diff / textconv apply to them too
  const outputish = rest.some((a) => prefixOfAny(a, ['output', 'output-directory', 'ext-diff', 'textconv']) || (!a.startsWith('--') && /^-[a-z0-9]*o/.test(a)));
  if (GIT_PLAIN_READ.has(sub)) return !rest.some((a) => prefixOfAny(a, ['output', 'output-directory', 'ext-diff', 'textconv']) || (a === '-o' && sub !== 'ls-files')) && !(sub === 'ls-remote' && rest.some((a) => prefixOfAny(a, ['upload-pack', 'exec', 'receive-pack']) || (!a.startsWith('--') && /^-[A-Za-z]*u/.test(a))));
  if (GIT_DIFFLIKE.has(sub)) return !rest.some((a) => prefixOfAny(a, ['output', 'output-directory', 'ext-diff', 'textconv']) || /^-[a-z0-9]*o/.test(a));
  if (sub === 'grep') return !rest.some((a) => (!a.startsWith('--') && /^-[A-Za-z0-9]*O/.test(a)) || prefixOfAny(a, ['open-files-in-pager'])); // (-O may be bundled: -iO)
  if (sub === 'branch') {
    if (dashed.some((a) => (!a.startsWith('--') && /[dDmMcCfutT]/.test(a.slice(1))) || /^--(?:delete|move|copy|force|set-upstream|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog)/.test(a))) return false;
    return !pos.length || dashed.some((a) => a === '-l' || a === '--list');
  }
  if (sub === 'tag') {
    if (dashed.some((a) => /^--(?:delete|annotate|sign|force|file|message|local-user|cleanup|create-reflog|verify)/.test(a) || (!a.startsWith('--') && /[adsfmFuv]/.test(a.slice(1))))) return false;
    return !pos.length || dashed.some((a) => a === '-l' || a === '--list');
  }
  if (sub === 'remote') return (!pos.length && dashed.every((a) => a === '-v' || a === '--verbose')) || ['show', 'get-url'].includes(pos[0]);
  if (sub === 'config') {
    if (!dashed.some((a) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'].includes(a))) return false;
    return dashed.every((a) => /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|--show-origin|--show-scope|--global|--local|--system|--worktree|--null|-z|--name-only|--bool|--int|--path|--bool-or-int|--expiry-date|--includes|--no-includes|--fixed-value|--type=\S*|--default=\S*|--file=\S*|--blob=\S*|--)$/.test(a));
  }
  if (sub === 'symbolic-ref') return !dashed.some((a) => /^(?:-d|-m|--delete)$/.test(a)) && pos.length <= 1;
  if (sub === 'worktree') return pos[0] === 'list';
  if (sub === 'stash') return (pos[0] === 'list' || pos[0] === 'show') && !outputish;
  if (sub === 'reflog') return (!pos.length || pos[0] === 'show' || pos[0] === 'exists') && !outputish;
  return false;
}

// gh: read subcommands only. A download / checkout / clone / alias / extension / config / an unknown subcommand (a user alias runs anything) writes files or runs a program; `--web` starts a browser; `api` only as a GET.
const GH_READ = { pr: ['view', 'list', 'checks', 'diff', 'status'], issue: ['view', 'list', 'status'], run: ['view', 'list', 'watch'], release: ['view', 'list'], repo: ['view', 'list'], workflow: ['view', 'list'], label: ['list'], auth: ['status'], search: ['prs', 'issues', 'repos', 'commits', 'code'], status: [], variable: ['list', 'get'], secret: ['list'], ruleset: ['list', 'view', 'check'], cache: ['list'], gist: ['list', 'view'], project: ['list', 'view'] };
const GH_ENV_RISK = /^(?:GH_(?:PAGER|BROWSER|EDITOR|CONFIG_DIR|PATH|DEBUG|[A-Z_]*EXTENSION\w*)|PAGER|BROWSER|EDITOR|VISUAL)$/;
function ghPure(args, envKeys = []) {
  if (envKeys.some((k) => GH_ENV_RISK.test(k))) return false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) { if (args[i] !== '--version') return false; i++; }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined || sub === 'version') return true;
  if (rest.some((a) => a === '-w' || a === '--web' || /^--(?:web|editor)\b/.test(a))) return false;
  if (sub === 'api') {
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === '-X' || a === '--method') { if (!/^get$/i.test(rest[k + 1] ?? '')) return false; k++; } else if (/^-X./.test(a)) { if (!/^-XGET$/i.test(a)) return false; } else if (/^--method=/.test(a)) { if (!/^--method=get$/i.test(a)) return false; } else if (a === '--input' || a.startsWith('--input=') || /^-[a-zA-Z]*[fF]/.test(a) && !a.startsWith('--') || /^--(?:field|raw-field)\b/.test(a)) return false;
    }
    return true;
  }
  const subs = GH_READ[sub];
  if (!subs) return false;
  if (!subs.length) return true;
  const verb = rest.find((a) => !a.startsWith('-'));
  return subs.includes(verb);
}

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

// What a sed program does besides editing text: { runs, writes, reads, unknown }. `w FILE` / `W FILE` / the `w` flag of s write a file (the name runs to the end of the line),
// `e` / the `e` flag run a command; with or without a space after the letter (GNU sed takes `wn.sh`). `r` / `R` read a file into the output. `unknown`: a part we cannot read (an unknown
// command letter, an unterminated s / address): strict, like a w.
// Why: sed is read structurally, like the shell does: addresses (`/re/`, `\cREc`, numbers, `$`, `a,b`, `a,+N`), then the command, with s / y bodies read up to THEIR delimiter (any character, letters too) and a / i / c
// text, labels and file names read to where they end. A letter inside a pattern, a replacement or an address (`s/a/export/`, `/error/p`, `/as/w f`) is therefore not a command, and a w behind
// them is not hidden. GNU sed ends a delimited part at the first unescaped delimiter; BSD sed skips a [bracket expression] first: both readings are made and their findings joined.
const SED_LEGACY = /(?:^|[;{}\s\d$/])[wWe](?:\s|$)|\/[gpiIm0-9]*[we](?=\s|$|;|\})/; // the pre-parser check, kept as a backstop (it reads a w / e at a command position loosely, strictly)
const SED_LEGACY_S = /s([^\sA-Za-z0-9\\])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1([gpiImMe0-9]*)(w?)/g;
const SED_LEGACY_Y = /y([^\sA-Za-z0-9\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1/g;
const SED_LEGACY_ADDR = /\/(?:\\.|[^/\\])*\/[IM]*/g;
const SED_LEGACY_CMD = /(?:^|[;{}\s\d$!,])([wWe])/g;
function sedParse(prog, brackets) {
  const out = { runs: false, writes: [], reads: [], unknown: false };
  const n = prog.length;
  let i = 0;
  const ws = () => { while (i < n && (prog[i] === ' ' || prog[i] === '\t')) i++; };
  const digits = () => { while (i < n && prog[i] >= '0' && prog[i] <= '9') i++; };
  const toEol = () => { let e = prog.indexOf('\n', i); if (e < 0) e = n; const t = prog.slice(i, e).trim(); i = e; return t; };
  // a [bracket expression] at i (BSD): its end, or i + 1 when it never closes
  const bracketEnd = () => {
    let j = i + 1;
    if (prog[j] === '^') j++;
    if (prog[j] === ']') j++;
    while (j < n && prog[j] !== ']') {
      if (prog[j] === '[' && ':.='.includes(prog[j + 1] ?? '')) { const close = prog.indexOf(prog[j + 1] + ']', j + 2); j = close < 0 ? j + 1 : close + 2; } else j++;
    }
    return j < n ? j + 1 : i + 1;
  };
  // the text up to the next unescaped delimiter d (i is after the opening one); false when there is none
  const part = (d, regex) => {
    while (i < n) {
      const c = prog[i];
      if (c === '\\') { i += 2; continue; }
      if (brackets && regex && c === '[') { i = bracketEnd(); continue; }
      i++;
      if (c === d) return true;
    }
    return false;
  };
  const addr = () => {
    const c = prog[i];
    if (c >= '0' && c <= '9') { digits(); if (prog[i] === '~') { i++; digits(); } return true; }
    if (c === '$') { i++; return true; }
    if (c === '/' || c === '\\') {
      let d = '/';
      if (c === '\\') { d = prog[i + 1]; i++; if (d === undefined || d === '\n' || d === '\\') { out.unknown = true; return true; } }
      i++;
      if (!part(d, true)) out.unknown = true;
      while (prog[i] === 'I' || prog[i] === 'M') i++;
      return true;
    }
    return false;
  };
  while (i < n) {
    const c0 = prog[i];
    if (c0 === ' ' || c0 === '\t' || c0 === '\n' || c0 === ';' || c0 === '\r') { i++; continue; }
    if (addr()) {
      ws();
      while (prog[i] === ',') {
        i++; ws();
        if (prog[i] === '+' || prog[i] === '~') { i++; digits(); } else if (!addr()) out.unknown = true;
        ws();
      }
    }
    while (i < n && (prog[i] === '!' || prog[i] === ' ' || prog[i] === '\t')) i++;
    if (i >= n) break;
    const c = prog[i++];
    if (c === 's') {
      const d = prog[i];
      if (d === undefined || d === '\n' || d === '\\') { out.unknown = true; continue; }
      i++;
      if (!part(d, true) || !part(d, false)) { out.unknown = true; i = n; continue; }
      for (;;) { // the flags
        const f = prog[i];
        if (f === undefined) break;
        if ('gpiImM'.includes(f) || (f >= '0' && f <= '9') || f === ' ' || f === '\t') i++;
        else if (f === 'e') { out.runs = true; i++; } else if (f === 'w') { i++; const t = toEol(); if (t) out.writes.push(t); else out.unknown = true; break; } else break;
      }
    } else if (c === 'y') {
      const d = prog[i];
      if (d === undefined || d === '\n' || d === '\\') { out.unknown = true; continue; }
      i++;
      if (!part(d, false) || !part(d, false)) { out.unknown = true; i = n; }
    } else if (c === 'a' || c === 'i' || c === 'c') { // the text runs to the end of the line (a backslash continues it)
      while (i < n && prog[i] !== '\n') i += prog[i] === '\\' ? 2 : 1;
    } else if (c === 'w' || c === 'W') { const t = toEol(); if (t) out.writes.push(t); else out.unknown = true; } else if (c === 'r' || c === 'R') { const t = toEol(); if (t) out.reads.push(t); } else if (c === 'e') { out.runs = true; toEol(); } else if (c === ':' || c === 'b' || c === 't' || c === 'T' || c === 'v') {
      ws();
      while (i < n && !' \t\n;'.includes(prog[i]) && (c === ':' || c === 'v' || prog[i] !== '}')) i++;
    } else if (c === 'l' || c === 'L' || c === 'q' || c === 'Q') { ws(); digits(); } else if (c === '#') toEol();
    else if (!'{}=dDgGhHnNpPxzF'.includes(c)) out.unknown = true;
  }
  return out;
}
// The pre-parser scan: s / y bodies and address regexes cut out with / delimiters, then any w / W / e at a command position.
function sedLegacyScan(prog) {
  const writes = [];
  let runs = false;
  let out = '';
  let last = 0;
  SED_LEGACY_S.lastIndex = 0;
  for (let m = SED_LEGACY_S.exec(prog); m; m = SED_LEGACY_S.exec(prog)) {
    if (m[4].includes('e')) runs = true;
    out += prog.slice(last, m.index) + ' ';
    last = SED_LEGACY_S.lastIndex;
    if (m[5]) { // the w flag: the file name is the rest of the line
      const eol = prog.indexOf('\n', last);
      const end = eol < 0 ? prog.length : eol;
      writes.push(prog.slice(last, end).trim());
      last = end;
      SED_LEGACY_S.lastIndex = end;
    }
  }
  out += prog.slice(last);
  out = out.replace(SED_LEGACY_Y, ' ');
  // w / W: read before the address regexes are cut out (`1w/home/u/x` is not an address) and after (`/re/w file`); e only after (`/error/p`)
  const noAddr = out.replace(SED_LEGACY_ADDR, ' ');
  for (const [text, withE] of [[out, false], [noAddr, true]]) {
    SED_LEGACY_CMD.lastIndex = 0;
    for (let m = SED_LEGACY_CMD.exec(text); m; m = SED_LEGACY_CMD.exec(text)) {
      if (m[1] === 'e') { if (withE) runs = true; continue; }
      const eol = text.indexOf('\n', SED_LEGACY_CMD.lastIndex);
      const end = eol < 0 ? text.length : eol;
      writes.push(text.slice(SED_LEGACY_CMD.lastIndex, end).trim());
      SED_LEGACY_CMD.lastIndex = end;
    }
  }
  return { runs, writes };
}
export function sedScan(prog) {
  const a = sedParse(prog, false);
  const b = sedParse(prog, true);
  const old = sedLegacyScan(prog);
  // (a program one reading cannot parse is an error to the sed that reads it that way: unknown only when neither reading gets through)
  return { runs: a.runs || b.runs || old.runs, writes: [...new Set([...a.writes, ...b.writes, ...old.writes].filter(Boolean))], reads: [...new Set([...a.reads, ...b.reads])], unknown: a.unknown && b.unknown };
}
export const sedUnsafe = (prog) => { const r = sedScan(prog); return r.runs || r.writes.length > 0 || r.unknown || SED_LEGACY.test(prog) || /(?:^|[;{}\s\d$!,])[wWe]\s*$/.test(prog); };
// an in-place option of sed: -i / -I (BSD) in a bundle, or --in-place / any abbreviation of it (GNU takes a unique prefix: --in-pl, --i)
export const sedInPlaceArg = (a) => /^-[A-Za-z]*[iI]/.test(a) || (a.startsWith('--') && a.length > 2 && 'in-place'.startsWith(a.slice(2).split('=')[0]));
// The sed programs among the arguments: the script words (-e PROG, -ePROG, -ne PROG, --expression=PROG, --expression PROG; a GNU long option may be abbreviated: --expr) and, when there
// is none, the first positional word (the rest are files: a file named web.ts / etc/passwd / ~/.claude/pipeline/... is not a `w` / `e` / `s///e` program). BSD `-i ''` takes its suffix before the
// program, so after a bare -i the second positional word is scanned too. `file`: a -f / --file script, whose text we do not read here. `targets`: the file words.
export function sedPrograms(args) {
  const progs = [];
  const pos = [];
  const early = new Set(); // positional words that come before an option word: BSD / POSIXLY_CORRECT sed stop reading options at the first of them, so it is the program there
  let file = false;
  let script = false;
  let bareInPlace = false;
  let dashedSuffix = false; // BSD: the word after a bare -i is its suffix, even a dashed one (`-i -l 'w o' f`)
  const values = []; // values of the options that take one (-l N, --line-length N, -f / --file): under a dashed suffix they may be the program
  const longIs = (nm, full) => nm !== '' && full.startsWith(nm);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a.length > 1) for (const w of pos) early.add(w);
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (longIs(nm, 'expression')) { script = true; progs.push(eq > 0 ? a.slice(eq + 1) : (args[++i] ?? '')); } else if (longIs(nm, 'file')) { file = true; script = true; values.push(eq > 0 ? a.slice(eq + 1) : (args[i + 1] ?? '')); if (eq < 0) i++; } else if (longIs(nm, 'line-length')) { values.push(eq > 0 ? a.slice(eq + 1) : (args[i + 1] ?? '')); if (eq < 0) i++; }
    } else if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        const rest = a.slice(k + 1);
        if (a[k] === 'e') { script = true; progs.push(rest !== '' ? rest : (args[++i] ?? '')); break; }
        if (a[k] === 'f') { file = true; script = true; values.push(rest !== '' ? rest : (args[i + 1] ?? '')); if (rest === '') i++; break; }
        if (a[k] === 'l') { values.push(rest !== '' ? rest : (args[i + 1] ?? '')); if (rest === '') { progs.push(args[i + 1] ?? ''); i++; } break; } // (-l takes a value in GNU, is a switch in BSD: that word is a program in one reading)
        if (a[k] === 'i' || a[k] === 'I') { if (rest === '') { bareInPlace = true; if ((args[i + 1] ?? '').startsWith('-')) dashedSuffix = true; } break; } // -i[SUFFIX] (BSD -I too; BSD takes a bare suffix as the next word)
      }
    } else pos.push(a);
  }
  if (!script) progs.push(...pos.slice(0, bareInPlace ? 2 : 1));
  progs.push(...[...early].filter((w) => !progs.includes(w)));
  if (dashedSuffix) progs.push(...[...pos, ...values].filter((w) => !progs.includes(w))); // (strict: the swallowed option may have hidden which word is the program)
  // the files it edits / reads: every positional word when a script option gave the program, else those after the program (after a bare -i the first word is the program (GNU) or the suffix (BSD): every word is a possible file; so is a word before an option)
  const targets = [...new Set([...(script || bareInPlace ? pos : pos.slice(1)), ...early])];
  return { progs, file, targets };
}
// The files the sed programs `r` / `R` read into their output (sources of what the sed writes)
export function sedReadFiles(args) {
  return [...new Set(sedPrograms(args).progs.flatMap((p) => sedScan(p).reads))];
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

// awk: its arguments read as gawk's getopt_long does (a long option may be a unique prefix). Pure (read-only) is an allowlist: -F / -v / -e (program text, scanned) / harmless switches. A program (or --source value) that
// writes, pipes, runs (system) or pulls code in (@include / @load), a program FILE (-f / -E, not read here), -i / --include / -l / --load / -W and every unknown or ambiguous option is not pure.
// `inPlace`: gawk's inplace library (-i inplace, --include inplace, @include "inplace") rewrites every file operand; `other`: not pure for a reason beyond the edit (any include may be a ./inplace.awk, see below).
const AWK_NAMES = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const AWK_LONG = {
  value: ['assign', 'field-separator'], source: ['source'], include: ['include'], code: ['exec', 'file', 'load'],
  optional: ['debug', 'dump-variables', 'gen-pot', 'pretty-print', 'profile'],
  switch: ['bignum', 'characters-as-bytes', 'copyright', 'csv', 'help', 'lint', 'lint-old', 'no-optimize', 'non-decimal-data', 'optimize', 'posix', 're-interval', 'sandbox', 'traditional', 'use-lc-numeric', 'version'],
};
const AWK_PROGRAM_CODE = /[>|]|\bsystem\s*\(|@(?:include|load|namespace)\b/;
// Why: only the bare names `inplace` / `inplace.awk` are gawk's own library; a path (-i /tmp/x/inplace.awk) is anyone's code. gawk's default AWKPATH starts with `.`, so even a bare name may load ./inplace.awk (a file the
// line writes): every include is still an in-place edit of the operands, but also code we cannot place (`other`: unmodelled). AWKPATH / AWKLIBPATH set: the same.
const AWK_INPLACE_INCLUDE = /@include\s*(["'])inplace(?:\.awk)?\1/g;
const isInplaceLib = (v) => /^inplace(?:\.awk)?$/.test(v);
function awkScan(args, env = {}, read = null) {
  const r = { impure: false, other: false, inPlace: false, writes: false, programs: [], files: [] };
  const libPath = Object.keys(env ?? {}).some((k) => /^AWK(?:LIB)?PATH$/.test(k));
  const pos = [];
  let progOpt = false;
  const bad = () => { r.impure = true; r.other = true; };
  const program = (t) => {
    r.programs.push(t);
    const stripped = t.replace(AWK_INPLACE_INCLUDE, () => { r.inPlace = true; bad(); return ''; });
    if (AWK_PROGRAM_CODE.test(stripped)) { if (/[>|]|\bsystem\s*\(/.test(stripped)) r.writes = true; bad(); }
  };
  // Why: a program FILE (-f / -E / --file / --exec) is scanned like the program text when it can be read; unreadable (or no reader: the caller cannot place it) = not pure
  // (a device or a pipe -- `-`, /dev/stdin, /dev/fd/N, /proc/... -- is not a file the hook can read: awk would see other text)
  const programFile = (w) => { const texts = read && !/^(?:-|\/(?:dev|proc|sys)(?:\/|$))/.test(w) ? read(w) : null; if (texts === null || texts === undefined) bad(); else for (const t of texts) program(t); };
  const all = Object.values(AWK_LONG).flat();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const full = all.includes(nm) ? nm : (() => { const m = all.filter((x) => x.startsWith(nm)); return nm !== '' && m.length === 1 ? m[0] : null; })();
      if (full === null) { bad(); continue; }
      const val = () => (eq > 0 ? a.slice(eq + 1) : (args[++i] ?? ''));
      if (AWK_LONG.value.includes(full)) val();
      else if (full === 'source') { progOpt = true; program(val()); } else if (full === 'include') { if (isInplaceLib(val())) r.inPlace = true; bad(); } else if (AWK_LONG.code.includes(full)) { progOpt = true; if (full === 'load') { val(); bad(); } else programFile(val()); } else if (AWK_LONG.optional.includes(full)) bad();
      else if (eq > 0 && !['lint', 'optimize'].includes(full)) bad(); // (a switch given a value: not a form we know)
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        const rest = a.slice(k + 1);
        const val = () => (rest !== '' ? rest : (args[++i] ?? ''));
        if (ch === 'F' || ch === 'v') { val(); break; }
        if (ch === 'e') { progOpt = true; program(val()); break; }
        if (ch === 'i') { if (isInplaceLib(val())) r.inPlace = true; bad(); break; }
        if (ch === 'f' || ch === 'E') { progOpt = true; programFile(val()); break; }
        if ('lW'.includes(ch)) { val(); bad(); break; }
        if (!'bcCMnNOPrsStVh'.includes(ch)) { bad(); break; } // (-d -D -o -p -g -L write or run, and so does anything we do not know)
      }
      continue;
    }
    pos.push(a);
  }
  if (!progOpt) { if (pos.length) program(pos[0]); r.files = pos.slice(1); } else r.files = pos;
  if (libPath) bad();
  return r;
}
export const awkArgsPure = (args, env = {}, read = null) => !awkScan(args, env, read).impure;

function isPure(cmd, name, lineEnv = {}, io = {}) {
  const args = cmd.argv.slice(1);
  if (!cmd.argv.length) return true; // a bare assignment / redirect
  if (name === 'git') return gitPure(args, [...Object.keys(cmd.env ?? {}), ...Object.keys(lineEnv)], io.gitCfg === true);
  if (name === 'gh') return ghPure(args, [...Object.keys(cmd.env ?? {}), ...Object.keys(lineEnv)]);
  if (name === 'sed' || name === 'gsed') return !args.some((a) => sedInPlaceArg(a) || OUTPUT_LONG.test(a)) && !sedArgsUnsafe(args);
  if (AWK_NAMES.has(name)) return awkArgsPure(args, { ...cmd.env, ...lineEnv }, io.readProgram);
  if (name === 'find') return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
  if (name === 'xxd') return !args.includes('-r') && args.filter((a) => !a.startsWith('-')).length <= 1;
  if (name === 'uniq') { const { pos, bad } = getoptStrict(args, UNIQ_OPTIONS); return !bad && pos.length <= 1; }
  if (name === 'sort') return sortArgsPure(args);
  if (name === 'rg') return !args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a)) && !args.some((a) => OUTPUT_LONG.test(a));
  if (!PURE.has(name)) return false;
  if (NO_OUTPUT_OPTIONS.has(name)) return true;
  // when unsure, not pure: any output-like option (-o FILE, --output=F, --log-file ...) of a tool on the list
  return !args.some((a) => OUTPUT_LONG.test(a) || (!SHORT_O_OK.has(name) && /^-[A-Za-z]*[oO]/.test(a)) || a === '-i' || a === '--in-place');
}

// A command that is not provably pure and whose arguments name the script (path, basename, a directory above it, a glob / variable that may match it) may have written it: every other word of its arguments that
// is a file is a possible source of the text, and the text may be anything. Not for: the command's own script operand (`node t.mjs a` runs t.mjs), read-only tools. A command that does not name the script
// is the old residual (`make; bash ok.sh`): only a script that is missing now counts as maybe-created.
const INTERPRETER = /^(?:bash|sh|zsh|dash|ksh|ash|fish|csh|tcsh|source|\.|node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|ruby|perl|php|pwsh|powershell|exec)$/;
const READ_ONLY_TOOLS = new Set(['shellcheck', 'od', 'strings', 'nl', 'fold', 'fmt', 'rev', 'comm', 'column', 'expand', 'unexpand', 'pr', 'zcat', 'gzcat', 'xzcat', 'bzcat', 'cksum', 'sum', 'b2sum', 'sha224sum', 'sha384sum', 'sha512sum', 'nm', 'otool', 'ldd', 'objdump']);
// Why: only the script operand of the command's OWN interpreter (argv[0], through env / timeout / nice ... and their options) is run, not written; `mytool node ok.sh` runs mytool, which may write ok.sh. The values of an
// interpreter's options (node -r ok.sh, bash -o posix, python -W x) are not the script: they stay named.
const WRAPPERS = new Set(['env', 'timeout', 'nice', 'nohup', 'time', 'command', 'exec', 'stdbuf', 'setsid', 'ionice', 'sudo', 'doas', 'builtin', 'xcrun', 'caffeinate']);
// Per interpreter: the option that carries program text (then there is NO script operand: `node -e '...' ok.sh` runs the program, which may write ok.sh) and the options whose value is a module or a setting (skipped)
const INTERP_CODE = { shell: /^-[A-Za-z]*c$/, node: /^(?:-[A-Za-z]*[ep]|--eval|--print)$/, perl: /^-[A-Za-z]*[eE]$/, python: /^(?:-[A-Za-z]*c|-m)$/, php: /^-[A-Za-z]*r$/ };
const INTERP_VALUE = { shell: /^(?:-o|-O|--rcfile|--init-file)$/, node: /^(?:-r|--require|--import|--loader|--experimental-loader)$/, perl: /^(?:-I|-M|-m)$/, python: /^(?:-W|-X)$/, php: /^(?:-d|-c)$/ };
const interpFamily = (n) => (/^(?:bash|sh|zsh|dash|ksh|ash|fish|csh|tcsh|source|\.|exec)$/.test(n) ? 'shell' : /^(?:node|nodejs|deno|bun|tsx|ts-node)$/.test(n) ? 'node' : /^(?:perl|ruby)$/.test(n) ? 'perl' : /^python[\d.]*$/.test(n) ? 'python' : n === 'php' ? 'php' : 'shell');
// -> { script, code }: the index of the script operand and of the program text (-1: none). With program text there is no script operand.
function interpreterOperand(argv) {
  let j = 0;
  while (j < argv.length) {
    const w = argv[j];
    if (INTERPRETER.test(commandName(w))) break;
    if (!(WRAPPERS.has(commandName(w)) || w.startsWith('-') || /^\w+=/.test(w) || /^\d+(?:\.\d+)?[smhd]?$/.test(w))) return { script: -1, code: -1 }; // (something else comes first: it is the command)
    j++;
  }
  if (j >= argv.length) return { script: -1, code: -1 };
  const fam = interpFamily(commandName(argv[j]));
  for (let k = j + 1; k < argv.length; k++) {
    if (argv[k] === '--') return { script: argv[k + 1] === undefined ? -1 : k + 1, code: -1 };
    if (INTERP_CODE[fam].test(argv[k])) return { script: -1, code: argv[k + 1] === undefined ? -1 : k + 1 };
    if (INTERP_VALUE[fam].test(argv[k])) { k++; continue; }
    if (!argv[k].startsWith('-')) return { script: k, code: -1 };
  }
  return { script: -1, code: -1 };
}
function genericRecord(cmd, name, idx) {
  if (READ_ONLY_TOOLS.has(name)) return null;
  const exempt = new Set();
  // (the program text itself is judged as text -- unwrapped by the parser or the inline-program record -- it is not a file name)
  const at = interpreterOperand(cmd.argv);
  if (at.script > 0) exempt.add(at.script);
  if (at.code > 0) exempt.add(at.code);
  const words = new Set();
  let tooLong = false;
  const add = (w) => { if (w !== '' && !w.startsWith('-')) words.add(w); };
  cmd.argv.slice(1).filter((_, k) => !exempt.has(k + 1)).forEach((w) => { // (the arguments only: a prefix assignment such as BASH_ENV=rc is the shell's startup file, judged on its own)
    const eq = w.indexOf('=');
    if (eq > 0) add(w.slice(eq + 1)); // (--out=F, of=F, NAME=F)
    add(w);
    // Why: -oN.sh / -fok.sh / -o=N.sh / -xfok.sh attach the value to the option letters: every tail of a single-dash word may be the file
    if (/^-[A-Za-z]/.test(w) && w.length > 2) { if (w.length > 80) tooLong = true; else for (let k = 2; k < w.length; k++) add(w[k] === '=' ? w.slice(k + 1) : w.slice(k)); }
  });
  if (tooLong) return anywhere(idx); // (a word too long to take apart: the command may write any file, never a cut list)
  if (!words.size) return null;
  const list = [...words];
  return { idx, dest: null, generic: list, items: [{ unknown: true }, ...list.map((file) => ({ file }))], loose: true };
}
// Why: a program-text file judged as shell makes hundreds of generic records of a few words each, and every script / source asked about is tried against all of them: the words that expand the same way every time (no variable,
// tilde or %NAME%) are expanded and located once per record (and per place the command runs), and P is compared to their directories by its ancestors, not by one path computation per word.
// (a word with no variable, tilde or %NAME% expands the same way every time it is asked: remembered; the others as the line's variables stand now)
const VOLATILE_WORD = /\$[\w{(]|`|%[A-Za-z]|~/;
function expandWord(f, w) {
  if (VOLATILE_WORD.test(w)) return f.expand(w);
  f.expanded ??= new Map();
  if (!f.expanded.has(w)) f.expanded.set(w, f.expand(w));
  return f.expanded.get(w);
}
// (where a word may be for the command at idx: remembered while that command's directory is as it was, see stamp)
function locateWord(f, e, idx) {
  const key = `${idx}\u0000${f.stamp ? f.stamp(idx) : ''}\u0000${e}`; // (the command's own place: the same relative word after a cd is another file)
  f.located ??= new Map();
  let r = f.located.get(key);
  if (r === undefined) { r = f.locate(e, idx); if (f.located.size > 100_000) f.located.clear(); f.located.set(key, r); }
  return r;
}
function classifyWord(f, rec, w, e, t) {
  if (e === null) { t.dyn.push(w); return; }
  for (const d of locateWord(f, e, rec.idx)) {
    if (!f.isAbs(d)) { t.rel.push(d); continue; } // (the directory is unknown: its names in a row)
    t.abs.add(resolvedFold(f, d));
    const cd = canon(f, f.p.resolve(d));
    if (cd !== null) t.real.add(resolvedFold(f, cd));
  }
}
const newTargets = (stamp = '') => ({ stamp, abs: new Set(), real: new Set(), rel: [], dyn: [], vol: [] });
function genericTargets(f, rec) {
  const stamp = f.stamp ? f.stamp(rec.idx) : '';
  f.targets ??= new Map();
  let t = f.targets.get(rec);
  if (t && t.stamp === stamp) return t;
  t = newTargets(stamp);
  for (const w of rec.generic) { if (VOLATILE_WORD.test(w)) t.vol.push(w); else classifyWord(f, rec, w, expandWord(f, w), t); }
  f.targets.set(rec, t);
  return t;
}
function targetsName(f, t, P) {
  const a = ancestorsOf(f, P);
  for (const x of a.lex) if (t.abs.has(x)) return true;
  for (const x of a.real) if (t.real.has(x)) return true;
  for (const d of t.rel) if (mayBeBelow(f, d, P)) return true;
  for (const w of t.dyn) if (dynamicMayBe(f, w, P)) return true;
  return false;
}
// does any word of the generic record name the script P (as it is, a directory above it, or a pattern that may match it)?
function namesScript(f, rec, P) {
  tick(f);
  if (targetsName(f, genericTargets(f, rec), P)) return true;
  for (const w of genericTargets(f, rec).vol) { // (a word with a variable expands as the line's variables stand now)
    const t = newTargets();
    classifyWord(f, rec, w, expandWord(f, w), t);
    if (targetsName(f, t, P)) return true;
  }
  return false;
}

// The writes of a line: { recs, unmodelled }. `unmodelled` is the set of command indexes that may have created any file.
export function writesOf(cmds, io = {}) {
  const recs = [];
  const unmodelled = new Set();
  // Why: `export WGETRC=w.rc; wget URL`, `CURL_HOME=d; export CURL_HOME; curl URL`, `declare -x HOME=d; ...`, `export AWKPATH=d; awk -i inplace ...`: a variable set or exported by ANY command of the line may be in a later command's environment
  const lineEnv = {};
  for (const c of cmds) {
    for (const k of Object.keys(c.env ?? {})) lineEnv[k] = '';
    if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(commandName(c.argv[0] ?? ''))) for (const a of c.argv.slice(1)) { const m = /^([A-Za-z_]\w*)(?:=|$)/.exec(a); if (m) lineEnv[m[1]] = ''; }
  }
  // Why: a git read (status, diff, log) runs core.fsmonitor / diff.external / textconv / core.pager from the repository or user config: when the line may write one (a path under .git/, .gitattributes, a git config file, a target
  // known only at run time, a write to any file) or changes it (git config / init / clone / remote / submodule), no git command on it is a pure read
  const CFG_PATH = /(?:^|[\\/])\.git(?:[\\/]|$)|(?:^|[\\/])\.git(?:attributes|config|modules)$|(?:^|[\\/])git[\\/](?:config|attributes)$|[$`*?[{]/;
  const gitCfg = cmds.some((c, idx) => {
    const n = commandName(c.argv[0] ?? '');
    if (n === 'git' && ['config', 'init', 'clone', 'remote', 'submodule'].includes(gitSub(c.argv.slice(1))) && !gitPure(c.argv.slice(1))) return true;
    return [...redirectRecords(c, idx), ...(c.argv.length ? argRecords(c, n, idx, lineEnv, {}) ?? [] : [])].some((r) => r.dest === null || CFG_PATH.test(String(r.dest)));
  });
  io = { ...io, gitCfg };
  cmds.forEach((cmd, idx) => {
    recs.push(...redirectRecords(cmd, idx));
    if (!cmd.argv.length) return;
    const name = commandName(cmd.argv[0]);
    const here = { readProgram: io.readProgram ? (word) => io.readProgram(word, idx) : null, gitCfg }; // (an awk program file is read where this command runs)
    const mine = argRecords(cmd, name, idx, lineEnv, here);
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
    if (!mine && !isPure(cmd, name, lineEnv, here)) {
      const g = genericRecord(cmd, name, idx); // (also for an inline program: its other words may be files it writes)
      if (g) recs.push(g);
      const at = cmd.argv.findIndex((w, i) => i > 0 && WRITER_NAMES.has(commandName(w)));
      if (at > 0) {
        const inner = { ...cmd, argv: cmd.argv.slice(at) };
        Object.defineProperty(inner, 'streams', { value: cmd.streams, enumerable: false }); // (its stdin is the wrapper's stdin)
        recs.push(...(argRecords(inner, commandName(inner.argv[0]), idx, lineEnv) ?? []), { idx, dest: null, items: UNKNOWN, loose: true });
      }
    }
    // a modelled writer (and a read-only command) cannot create a file we did not list; anything else may. git is only modelled for the
    // subcommands that write named paths: a checkout / merge / pull also changes files we do not follow
    if ((name === 'sed' || name === 'gsed') && (sedPrograms(cmd.argv.slice(1)).file || sedPrograms(cmd.argv.slice(1)).progs.some((p) => sedScan(p).runs))) unmodelled.add(idx);
    const sub = name === 'git' ? gitSub(cmd.argv.slice(1)) : '';
    const modelled = mine && !mine.unmodelled && !(name === 'git' && GIT_TREE.has(sub) && !['clone', 'worktree', 'mv'].includes(sub));
    if (!modelled && !isPure(cmd, name, lineEnv, here)) unmodelled.add(idx);
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
function visible(frame, at, idx, late = false) {
  if (idx === at) return false;
  if (idx < at || frame.deferred || late) return true;
  const { cmds, from } = frame;
  if (from >= 0 && at >= from && idx >= from) return true;
  let hi = at;
  while (hi + 1 < cmds.length && cmds[hi + 1].sep === '|') hi++;
  let lo = at;
  while (lo > 0 && cmds[lo].sep === '|') lo--;
  if (idx >= lo && idx <= hi) return true;
  return cmds[hi + 1]?.sep === '&';
}

// Is the record of command idx of frames[fi] visible to the command being judged (command `at` of that frame, or the call into the frames above it)? Why: background work started by a script judged
// inside (a nested frame with a `&`, setsid, screen, tmux, coproc ...) outlives it, so every LATER record of every enclosing frame may land before that job runs; and a frame with a `&` we cannot place
// (`{ ...; } &`, a trailing `&`) sees all of its own later records.
function seen(frames, fi, at, idx) {
  const f = frames[fi];
  const late = fi === frames.length - 1 ? f.opaque === true : frames.slice(fi + 1).some((x) => x.bgWork);
  return visible(f, at, idx, late);
}
// The pipeline (first, last command index) that holds command i
function groupOf(cmds, i) {
  let lo = i;
  let hi = i;
  while (hi + 1 < cmds.length && cmds[hi + 1].sep === '|') hi++;
  while (lo > 0 && cmds[lo].sep === '|') lo--;
  return [lo, hi];
}
// How the record's command runs, as far as the ORDER of its write goes: `bg` a background job (it lands at any time later), `opt` it may be skipped (after && / ||, before ||, in a loop or an if) or fail. The facts of
// a finished nested frame are stamped on its exported records (exportRecords), so they survive the move to the caller.
function placeOf(f, rec) {
  const c = f.cmds;
  const [lo, hi] = groupOf(c, rec.idx);
  return {
    bg: rec.bg === true || f.opaque === true || c[hi + 1]?.sep === '&',
    opt: rec.opt === true || c[lo]?.sep === '&&' || c[lo]?.sep === '||' || c[hi + 1]?.sep === '||' || inFlow(f.from, rec.idx),
  };
}

// One frame per command list being evaluated (the line, then each script text judged inside it). `i` is the command being judged now.
// - expand(word): the word with variables, ~ and $HOME expanded, or null when it is only known at run time (a `$` left, a glob)
// - locate(expanded, idx): the paths the word may name for the command at idx: absolute ones, or the word itself when the directory is unknown
// - isAbs(path), p: the policy's path functions (node:path or node:path.posix), ci: compare names ignoring case
// - real(path): the path with symlinks followed (a missing tail kept), or null when it cannot be told; omitted: paths are taken as written
// - stamp(idx) (optional): changes whenever locate() would answer differently for the command at idx (the directory it runs in becomes known); tick() (optional): reads the evaluation's clock and throws when it is past its deadline
export function newWriteFrame(cmds, { expand, locate, isAbs, p, ci = false, real = null, readText = null, text = null, stamp = null, tick = null }) {
  // an awk program file (-f FILE): the text of every place the word may name; null when it cannot be told (a run-time word, a file we cannot read, a place we do not know)
  const readProgram = readText ? (word, idx) => {
    const e = expand(word);
    if (e === null) return null;
    const paths = locate(e, idx).filter((x) => isAbs(x)); // (the bare word is only the fallback for a directory we do not know)
    if (!paths.length || paths.some((x) => /^\/(?:dev|proc|sys)(?:\/|$)/.test(String(x).replace(/\\/g, '/')))) return null;
    const texts = paths.map((x) => readText(x));
    return texts.every((t) => typeof t === 'string') ? texts : null;
  } : null;
  const w = writesOf(cmds, { readProgram });
  // Why: a `&` the commands do not show (a trailing one, `( ... ) &`, `{ ...; } &`) makes the whole frame's order unknown (opaque); bgWork: this frame starts something that may outlive it
  const lone = typeof text === 'string' ? (text.match(/(?<![&|<>])&(?![&>])/g) ?? []).length : 0;
  const seps = cmds.filter((c) => c.sep === '&').length;
  const opaque = lone > seps || cmds.some(startsBackground);
  const bgWork = seps > 0 || opaque;
  return { cmds, recs: w.recs, unmodelled: w.unmodelled, from: flowStart(cmds), i: -1, expand, locate, isAbs, p, ci, real, stamp, tick, deferred: hasDeferred(cmds), opaque, bgWork };
}

// commands that start a job which outlives them (a `&` is read from the text)
const BACKGROUNDERS = new Set(['setsid', 'disown', 'screen', 'tmux', 'coproc', 'at', 'batch', 'systemd-run', 'daemonize', 'daemon', 'start-stop-daemon', 'launchctl', 'bg']);
const startsBackground = (c) => [...(c.raw ?? '').trim().split(/\s+/).slice(0, 3), ...c.argv.slice(0, 3).map(commandName)].some((w) => BACKGROUNDERS.has(w));

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
// (the resolved, case-folded form of a path, remembered: path.resolve is the cost when a line asks about thousands of pairs)
function resolvedFold(f, a) {
  f.resolved ??= new Map();
  let r = f.resolved.get(a);
  if (r === undefined) { r = fold(f, f.p.resolve(a)); f.resolved.set(a, r); }
  return r;
}
// every directory above P (itself included), resolved and folded, and the same for its real location
function ancestorsOf(f, P) {
  f.ancestors ??= new Map();
  let a = f.ancestors.get(P);
  if (!a) {
    const chain = (q) => {
      const out = [];
      for (let cur = resolvedFold(f, q); ; ) { out.push(cur); const up = f.p.dirname(cur); if (up === cur) break; cur = up; }
      return out;
    };
    const cp = canon(f, f.p.resolve(P));
    a = { lex: chain(P), real: cp === null ? [] : chain(cp) };
    f.ancestors.set(P, a);
  }
  return a;
}
function relUnder(f, P, d) {
  const key = `${P}\u0000${d}`;
  f.relMemo ??= new Map();
  if (f.relMemo.has(key)) return f.relMemo.get(key);
  // (both sides resolved and folded: P is below d when it starts with d and a separator; this is what path.relative says, without resolving both paths again each time)
  const lex = (a, b) => {
    const ra = resolvedFold(f, a);
    const rb = resolvedFold(f, b);
    if (ra === rb) return '';
    const base = ra.endsWith(f.p.sep) ? ra : ra + f.p.sep;
    return rb.startsWith(base) ? rb.slice(base.length) : null;
  };
  let out = lex(d, P);
  if (out === null) {
    const cd = canon(f, f.p.resolve(d));
    const cp = canon(f, f.p.resolve(P));
    out = cd === null || cp === null ? null : lex(cd, cp);
  }
  if (f.relMemo.size > 200_000) f.relMemo.clear();
  f.relMemo.set(key, out);
  return out;
}
const same = (f, a, b) => relUnder(f, b, a) === '';
// the path of P below directory d, or null
const below = (f, P, d) => relUnder(f, P, d) || null;
const nameOf = (f, s) => f.p.basename(String(s).replace(/[\\/]+$/, ''));

// A relative directory `d` of a worktree add / clone (`narrow`) whose base is unknown: can P be below it? Only if P's path holds d's names in a row (`.wt2`, `a/b`); `.` and an empty name say nothing (a directory made only of those may hold
// anything) and a `..` anywhere in it leaves the named directory, so that may hold anything too. Why: a worktree add into `.wt2` does not reach a script in /abs/other/. Not for an archive extract: its members can escape the directory (-P, `../`, symlinks).
function mayBeBelow(f, d, P) {
  const segs = String(d).replace(/\\/g, '/').split('/');
  if (segs.includes('..')) return true; // (`a/../b` / `../x` leave the named directory: it may hold anything)
  const names = segs.filter((s) => s && s !== '.').map((s) => fold(f, s));
  if (!names.length) return true;
  const have = String(P).replace(/\\/g, '/').split('/').map((s) => fold(f, s));
  for (let i = 0; i + names.length <= have.length; i++) if (names.every((n, k) => have[i + k] === n)) return true;
  return false;
}

// The items a record puts in P (null: it does not write P).
function match(f, rec, P) {
  const p = f.p;
  const loose = (items) => Object.assign([...items], { loose: true }); // may or may not be the file: its place in the order is unknown
  if (rec.inline !== undefined) return namesFile(rec.inline, p.basename(P)) && (rec.awk || CAN_WRITE.test(rec.inline)) ? loose(rec.items) : null;
  if (rec.generic !== undefined) return namesScript(f, rec, P) ? loose(rec.items) : null;
  if (rec.dest === null) return loose(rec.items);
  const e = expandWord(f, rec.dest);
  // a target only known at run time may be any file its fixed parts allow (`/work/out-$n.txt` is not /work/cmp.mjs)
  if (e === null) return dynamicMayBe(f, rec.dest, P, rec.subtree === true) ? loose(rec.items) : null; // (a subtree: any file below the directory the word may name)
  const out = [];
  for (const d of locateWord(f, e, rec.idx)) {
    if (!f.isAbs(d)) { // the directory is unknown: compare the names
      out.loose = true;
      if (fold(f, p.basename(d)) === fold(f, p.basename(P))) out.push(...rec.items);
      else if (rec.copy) for (const it of rec.items) { const se = it.file === undefined ? undefined : expandWord(f, it.file); if (se === null || (se !== undefined && fold(f, nameOf(f, se)) === fold(f, p.basename(P)))) out.push(it); }
      // Why: the names say where the files land only if no alias is involved: P is compared by its real path too (a link the line makes is already "a write that ends in the script's name", see collect)
      if (rec.subtree && (!rec.narrow || mayBeBelow(f, d, P) || [canon(f, P)].some((cp) => cp !== null && cp !== P && mayBeBelow(f, d, cp)))) out.push(...rec.items);
      continue;
    }
    if (same(f, d, P)) { out.push(...rec.items); continue; }
    if (rec.subtree && below(f, P, d) !== null) out.push(...rec.items);
    if (!rec.copy) continue;
    for (const it of rec.items) {
      if (it.file === undefined) continue;
      const se = expandWord(f, it.file);
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
        for (const s of locateWord(f, se, rec.idx)) out.push({ abs: p.join(s, rel) });
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

// Why: a hook that runs out of time is allowed by Claude Code: the loops that grow with the line (records x names x scripts) read the evaluation's clock every so often (the policy hands it over as frame.tick) and the guard gives up first
const TICK_EVERY = 64;
function tick(f, n = 1) {
  f.work = (f.work ?? 0) + n;
  if (f.work >= TICK_EVERY) { f.work = 0; f.tick?.(); }
}
function hitsOn(allFrames, upto, asOf, P) {
  const frames = allFrames.length === upto + 1 ? allFrames : allFrames.slice(0, upto + 1);
  const pairs = linkPairs(frames, upto, asOf);
  const names = pairs.length ? namesOf(pairs, P) : [P];
  const out = [];
  for (let fi = 0; fi <= upto; fi++) {
    const f = frames[fi];
    const at = fi === upto ? asOf : f.i;
    for (const rec of f.recs) {
      tick(f);
      if (!seen(frames, fi, at, rec.idx)) continue;
      for (const Pv of names) {
        const items = match(f, rec, Pv);
        if (items) { out.push({ fi, f, rec, items, loose: items.loose === true, P: Pv, place: placeOf(f, rec) }); break; }
      }
    }
  }
  // two writers of this file in one pipeline run at the same time: neither comes first
  // (grouped by pipeline: pairs of hits would be quadratic when hundreds of generic records name the file)
  const pipelines = new Map();
  for (const h of out) {
    const key = `${h.fi}:${groupOf(h.f.cmds, h.rec.idx)[0]}`;
    if (!pipelines.has(key)) pipelines.set(key, []);
    pipelines.get(key).push(h);
  }
  for (const group of pipelines.values()) if (new Set(group.map((h) => h.rec.idx)).size > 1) for (const h of group) h.place.conc = true;
  // a write that may or may not be this file, followed by an exact write that replaces the whole file, changed nothing that matters
  let lastExact = -1;
  out.forEach((h, i) => { if (certainReplace(h)) lastExact = i; });
  return out.filter((h, i) => !(h.loose && i < lastExact));
}

// Every text the file P may hold after the writes before (frames[0..upto], command asOf), or null when it cannot be built (a piece is unknown or
// computed, a write's place is unknown, too many combinations). A file nothing writes is its current text.
function contentsOf(frames, upto, asOf, P, io, depth) {
  if (depth > 4) { io.pieces = true; return null; }
  // Why: the very same question asked again while it is being answered (`cp F bak` ... `cp bak F` in a function the line calls: every copy is visible to the others, so F came from bak and bak
  // from F) adds nothing: what goes round is the text the other writes put there, and each source is judged as the file it is. It is no content (null, never the file as it is on disk: the same path
  // asked at ANOTHER point of the line is a different question)
  io.stack ??= new Set();
  const key = `${P}\u0000${upto}\u0000${asOf}`;
  if (io.stack.has(key)) return null;
  io.stack.add(key);
  try { return contentsIn(frames, upto, asOf, P, io, depth); } finally { io.stack.delete(key); }
}
// Does the copy / move / link of this hit fail because its source is missing now (and no write on the line creates it)? Then the destination keeps its text.
function copyMayFail(frames, h, exists) {
  if (!h.rec.copy) return false;
  for (const it of h.rec.items) {
    if (it.file === undefined) continue;
    const e = expandWord(h.f, it.file);
    if (e === null) continue;
    for (const x of locateWord(h.f, e, h.rec.idx).filter((q) => h.f.isAbs(q))) if (!exists(x) && hitsOn(frames, h.fi, h.rec.idx, x).length === 0) return true;
  }
  return false;
}
const MAX_VARIANTS = 1024; // the ways the writes before a command can be put in order and in or out
function contentsIn(frames, upto, asOf, P, io, depth) {
  const hits = hitsOn(frames, upto, asOf, P);
  // Why: a write that may or may not be this file (loose), may be skipped or fail (opt), runs in the background or beside another writer (bg / conc) is tried both ways, and a background or concurrent
  // one in every place among the writes that certainly run (it lands when it lands); the combinations are capped, and too many is "built from pieces" (denied), never a silent cut
  const ordered = hits.filter((h) => !h.place.bg && !h.place.conc);
  const free = hits.filter((h) => h.place.bg || h.place.conc);
  const optMemo = new Map(); // (each hit is asked once: expanding its words costs budget)
  const optional = (h) => { if (!optMemo.has(h)) optMemo.set(h, h.loose || h.place.opt || copyMayFail(frames, h, io.exists)); return optMemo.get(h); };
  const altMemo = new Map();
  const altsOf = (h) => { if (!altMemo.has(h)) altMemo.set(h, partAlternatives(frames, h, io, depth)); return altMemo.get(h); };
  const mayBeAbsent = (h) => h.place.bg || optional(h);
  const out = new Set();
  let count = 0;
  let stop = false;
  // the writes that certainly run keep the text's order (each in or out when it may be skipped); every free one is then put in at every place of the order (an earlier free one included)
  const place = (list, k) => {
    if (stop) return;
    if (k === free.length) {
      if (++count > MAX_VARIANTS) { io.pieces = true; stop = true; return; }
      tick(frames[upto], 4);
      if (variant(list) === null) stop = true;
      return;
    }
    const u = free[k];
    if (mayBeAbsent(u)) place(list, k + 1);
    for (let at = 0; at <= list.length; at++) place([...list.slice(0, at), u, ...list.slice(at)], k + 1);
  };
  const pickOrdered = (k, list) => {
    if (stop) return;
    if (k === ordered.length) { place(list, 0); return; }
    pickOrdered(k + 1, [...list, ordered[k]]);
    if (optional(ordered[k])) pickOrdered(k + 1, list);
  };
  const variant = (seqHits) => {
    let seq = [{ cur: true }];
    // Why: an emulated in-place sed turns the text before it (the file as it is, a copy, an append) into a new one, so it is one more step after them, not a replacement of them
    for (const h of seqHits) { if (h.rec.append || h.rec.sed) seq.push(h); else seq = [h]; }
    // a file put together from several pieces that cannot be built is "built from pieces at run time"; one unknown piece alone is just unknown content.
    // Only a write to the file itself counts: a piece of a write that merely may hit it is the unknown-content signal, never a refusal
    const multi = seq.length > 1 || seq.some((el) => (el.rec?.parts?.length ?? 0) > 1 || el.rec?.edit); // (an in-place edit is old text + a program: two pieces)
    const looseIn = seq.some((el) => el.loose);
    const fail = () => { if (multi && !looseIn) io.pieces = true; return null; };
    let acc = [''];
    for (const el of seq) {
      if (el.rec?.sed) { // (every text the edit may leave, see sed-emulate.mjs; a program it does not emulate exactly is "built from pieces")
        const next = new Set(); // (the edit may fail or be skipped: an unwritable directory, syntax one sed rejects, a missing file ... the text it was to edit stays)
        for (const text of acc) {
          const edited = applySed(el.rec.sed, text);
          if (edited === null) { io.sedRefused = true; fail(); return looseIn ? true : null; }
          for (const x of edited) next.add(x);
        }
        if (next.size > MAX_JOINED) { io.pieces = true; return looseIn ? true : null; }
        acc = [...next];
        continue;
      }
      let alts;
      if (el.cur) {
        if (!io.exists(P)) alts = [''];
        else { const text = io.readText(P); if (typeof text !== 'string') { fail(); return looseIn ? true : null; } alts = [text]; }
      } else alts = altsOf(el);
      if (alts === null) { fail(); return looseIn ? true : null; }
      acc = product(acc, alts);
      if (acc === null) { io.pieces = true; return looseIn ? true : null; } // (too many combinations: refused, never dropped)
    }
    for (const x of acc) out.add(x);
    return true;
  };
  pickOrdered(0, []);
  return stop || !out.size ? null : [...out];
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
          const e = expandWord(f, it.file);
          if (e === null) return null;
          paths = locateWord(f, e, rec.idx).filter((x) => f.isAbs(x));
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
    if (acc === null) { io.pieces = true; return null; } // (too many combinations: refused, never cut)
  }
  return acc;
}

// Could the word, with its run-time parts ($VAR, $(...), globs, {a,b}) replaced by anything, name P? A relative word may be anywhere (its directory is unknown).
// (the pattern a word stands for depends on the word alone: true = anything, a RegExp, or null when it cannot be built; built once, not once per name asked)
const DYNAMIC_PATTERNS = new Map();
function dynamicMayBe(f, word, P, below = false) {
  const key = `${f.ci ? 1 : 0}${below ? 1 : 0}${word}`;
  let pat = DYNAMIC_PATTERNS.get(key);
  if (pat === undefined) {
    pat = dynamicPattern(f, word, below);
    if (DYNAMIC_PATTERNS.size > 20_000) DYNAMIC_PATTERNS.clear();
    DYNAMIC_PATTERNS.set(key, pat);
  }
  return pat === true || pat === null || pat.test(P.replace(/\\/g, '/'));
}
function dynamicPattern(f, word, below) {
  // Why: a leading tilde prefix is not a name: ~+ is the command's directory (the rest is then a relative word), ~- the previous directory and ~user a home are unknown (anywhere, absolute)
  let w = String(word);
  let lead = '';
  const tilde = /^~([^/\\]+)(?=[/\\]|$)/.exec(w);
  if (tilde) {
    if (tilde[1] === '+') { w = w.slice(2).replace(/^[/\\]+/, ''); if (w === '') return true; } else { w = w.slice(tilde[0].length); lead = '.*'; }
  }
  // `.` segments and repeated slashes change nothing; a `..` that is left may reach any directory, so the word may be the file
  const segs = w.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  if (segs.includes('..')) return true;
  w = (/^[\\/]/.test(w) ? '/' : '') + segs.join('/');
  if (w === '' || w === '/') return true;
  const parts = w.split(/(\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!$-]|`[^`]*`|\[[^\]]*\]|\{[^}]*\}|[*?])/);
  const re = lead + parts.map((s, i) => (i % 2 ? '.*' : s.replace(/[.+^|()\\]/g, '\\$&').replace(/[\[\]{}$]/g, '\\$&'))).join('');
  const abs = lead !== '' || /^\//.test(parts[0] ?? '') || /^[A-Za-z]:/.test(parts[0] ?? '');
  try {
    const end = below ? '(?:[\\\\/].*)?$' : '$';
    return new RegExp(abs ? `^(?:[A-Za-z]:)?${re}${end}` : `(?:^|[\\\\/])${re}${end}`, f.ci ? 'is' : 's');
  } catch {
    return null; // a pattern we cannot build: it may be
  }
}

const MAX_CHAIN = 24; // a file copied from a file copied from a file ... (longer: refused, see `cut`)

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
  // Why: the unknown text of an in-place sed is the edit's own result: once every text it leaves is built (the program emulated for every text it may get) it is judged as a text, not as run-time content
  if (st.sedEdit && (built === null || io.pieces || io.sedRefused)) st.unknown = true;
  const joined = (built ?? []).filter((x) => !st.texts.has(x));
  return { texts: [...st.texts], files: [...st.files], scans: [...st.scans], programs: [...st.programs], authored: st.authored, unknown: st.unknown, viaUnmodelled: st.viaUnmodelled, joined, pieces: io.pieces || st.cut === true };
}

// The links the line makes before the command: [alias, real, frame] for `ln -s REAL ALIAS` (and a hard link). A directory alias makes
// every path below it a second name for the same file, so a script is also judged under its other names.
// an exact write that certainly runs, completes before the next command and replaces the whole file
const certainReplace = (h) => !h.loose && !h.rec.append && !h.place.bg && !h.place.opt && !h.place.conc;
function linkPairs(frames, upto, asOf) {
  const pairs = [];
  pairs.any = false; // a link is made before the command, whether or not we can place it
  const view = frames.slice(0, upto + 1);
  view.forEach((f, fi) => {
    const at = fi === upto ? asOf : f.i;
    for (const rec of f.recs) {
      tick(f);
      if (!rec.link || !seen(view, fi, at, rec.idx)) continue;
      pairs.any = true;
      const e = expandWord(f, rec.dest);
      if (e === null) continue;
      for (const d of locateWord(f, e, rec.idx).filter((x) => f.isAbs(x))) {
        for (const it of rec.items) {
          const se = it.file === undefined ? null : expandWord(f, it.file);
          if (se === null) continue;
          const srcs = locateWord(f, se, rec.idx).filter((x) => f.isAbs(x));
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
  tick(frames[upto], 8);
  const view = frames.length === upto + 1 ? frames : frames.slice(0, upto + 1);
  const key = `${upto}\u0000${asOf}\u0000${P}`;
  if (st.seen.has(key)) return;
  st.seen.add(key);
  const pairs = linkPairs(frames, upto, asOf);
  const names = pairs.length ? namesOf(pairs, P) : [P];
  for (const h of hitsOn(frames, upto, asOf, P)) {
    if (h.loose && st.ignoreUnmodelled) continue; // (the real home's startup files: only the line's exact writes reach them, not a target known only at run time)
    absorb(frames, h.fi, h.f, h.rec, h.items, h.P, st, depth, exists);
    if (certainReplace(h) && !copyMayFail(frames, h, exists)) st.lastReplace = [h.fi, h.rec.idx]; // an exact write that replaces the file: what came before it no longer matters
  }
  if (frames.some((x) => x.unresolved)) pairs.any = true;
  for (let fi = 0; fi <= upto; fi++) {
    const f = frames[fi];
    const at = fi === upto ? asOf : f.i;
    // links we cannot follow (a link made on the line, a path whose real location is unknown): a write that ends in the script's NAME may reach it
    if (pairs.any || frames.some((x) => x.unresolved)) {
      for (const rec of f.recs) {
        if (!seen(view, fi, at, rec.idx) || rec.inline !== undefined) continue;
        if (rec.subtree) { st.any = true; st.unknown = true; continue; }
        if (rec.dest === null) continue;
        const e = expandWord(f, rec.dest);
        if (e === null) continue;
        const base = fold(f, f.p.basename(P));
        const written = [nameOf(f, e), ...(rec.copy ? rec.items.map((it) => (it.file === undefined ? null : expandWord(f, it.file))).filter((s) => s).map((s) => nameOf(f, s)) : [])];
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
        if (!seen(view, fi, at, idx)) continue;
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
    else if (it.unknown) { if (rec.sed) st.sedEdit = true; else st.unknown = true; if (it.authored) st.authored = true; } // (an emulated sed edit is unknown only if the texts cannot be built, see writtenTo)
    else if (it.scan !== undefined) addFiles(f, rec, it.scan, Pv, st, fi, depth, exists, 'scans');
    else if (it.abs !== undefined) addPath(frames, fi, rec, it.abs, st, depth, exists, 'files');
    else if (it.file !== undefined) addFiles(f, rec, it.file, Pv, st, fi, depth, exists, 'files', frames);
  }
}

function addPath(frames, fi, rec, abs, st, depth, exists, into) {
  st[into].add(abs);
  if (into === 'files') { if (depth < MAX_CHAIN) collect(frames, fi, rec.idx, abs, st, depth + 1, exists); else st.cut = true; }
}

function addFiles(f, rec, word, P, st, fi, depth, exists, into, frames = null) {
  const e = expandWord(f, word);
  if (e === null) { st.unknown = true; return; }
  const paths = locateWord(f, e, rec.idx).filter((x) => f.isAbs(x));
  if (!paths.length) { st.unknown = true; return; } // a relative source in a directory we do not know
  // a symlink's relative source is read from the link's own directory
  if (rec.link === 'sym' && !f.isAbs(e)) paths.push(f.p.resolve(f.p.dirname(P), e));
  for (const x of paths) {
    st[into].add(x);
    if (into === 'files' && frames) { if (depth < MAX_CHAIN) collect(frames, fi, rec.idx, x, st, depth + 1, exists); else st.cut = true; }
  }
}

// Names the line's writes put into directory `dir` (so `bash n*.sh` after `cp f.sh n.sh` has n.sh among its glob matches).
export function writtenNamesIn(frames, dir) {
  const out = new Set();
  for (const [fi, f] of frames.entries()) {
    for (const rec of f.recs) {
      if (rec.dest === null || rec.inline !== undefined || !seen(frames, fi, f.i, rec.idx)) continue;
      const e = expandWord(f, rec.dest);
      if (e === null) continue;
      for (const d of locateWord(f, e, rec.idx)) {
        if (!f.isAbs(d)) continue;
        if (same(f, f.p.dirname(d), dir)) out.add(f.p.basename(d));
        if (rec.copy && same(f, d, dir)) for (const it of rec.items) { const se = expandWord(f, it.file ?? ''); if (se) out.add(nameOf(f, se)); }
      }
    }
  }
  return [...out];
}

// A fingerprint of the writes that count for the command being judged now, for memo keys that must not outlive a change of them: the actual
// visible records (not their number), so two different write sets never share a cached verdict.
export function writeSignature(frames) {
  return JSON.stringify(frames.map((f, fi) => [f.opaque === true, f.recs.filter((r) => seen(frames, fi, f.i, r.idx)).map((r) => ({ ...r, placed: placeOf(f, r) }))]));
}
// Is there a command we do not model before the one being judged? (any number of them make a missing script equally unknown)
export const unmodelledBefore = (frames) => frames.some((f, fi) => [...f.unmodelled].some((x) => seen(frames, fi, f.i, x)));

// The records of a finished frame (a script judged while the caller ran), rewritten with absolute paths and attributed to the calling command `idx`, so the
// commands that run after the script see what it wrote (`bash mk.sh; bash n.sh` with mk.sh doing `cp f.sh n.sh`).
// `existing`: the caller's records; one that is already there with the same content and an earlier or equal command index is seen in every case the new one would be, so it is not added again (200 shells running one script do not grow the list)
export function exportRecords(f, idx, existing = []) {
  const out = [];
  const keyOf = (r) => JSON.stringify({ ...r, idx: 0 });
  const seen = new Map();
  for (const r of existing) { const k = keyOf(r); if (!seen.has(k) || seen.get(k) > r.idx) seen.set(k, r.idx); }
  const absOf = (word, at) => {
    const e = expandWord(f, word);
    return e === null ? null : locateWord(f, e, at).filter((x) => f.isAbs(x));
  };
  for (const rec of f.recs) {
    const place = placeOf(f, rec); // (how it ran inside: a background job or a skippable write stays one when the caller moves on)
    if (rec.inline !== undefined) { out.push({ ...rec, idx, bg: place.bg, opt: place.opt }); continue; }
    const convert = (items, d) => items.flatMap((it) => {
      if (it.file === undefined && it.scan === undefined) return [it];
      const key = it.file !== undefined ? 'file' : 'scan';
      const paths = absOf(it[key], rec.idx);
      if (paths === null || !paths.length) return [{ unknown: true }];
      const more = key === 'file' && rec.link === 'sym' && d && !f.isAbs(expandWord(f, it.file) ?? '/') ? [f.p.resolve(f.p.dirname(d), expandWord(f, it.file))] : []; // a symlink's relative source is read from the link's directory
      return [...paths, ...more].map((p) => ({ [key]: p }));
    });
    const dests = rec.dest === null ? [null] : (absOf(rec.dest, rec.idx) ?? [null]);
    for (const d of dests.length ? dests : [null]) {
      const items = convert(rec.items, d);
      out.push({ ...rec, idx, bg: place.bg, opt: place.opt, dest: d, items, parts: rec.parts?.map((part) => convert(part, d)), ...(rec.generic ? { generic: rec.generic.flatMap((w) => { const ps = absOf(w, rec.idx); return ps && ps.length ? ps : [w]; }) } : {}) });
    }
  }
  return out.filter((r) => { const k = keyOf(r); if (seen.has(k) && seen.get(k) <= r.idx) return false; seen.set(k, r.idx); return true; });
}

// The readings of a program's text to look for a guarded command in: as written, with string concatenation joined ('git pu'+'sh'), with quotes and escapes stripped.
export function flattenProgram(text) {
  const joined = String(text).replace(/['"`]\s*\+\s*['"`]/g, '');
  return [...new Set([String(text), joined, joined.replace(/['"`\\]/g, '')])];
}
