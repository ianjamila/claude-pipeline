// Fact gathering for `pipeline worktrees` (spec docs/specs/2026-10-13-worktree-prune-design.md §4): which worktrees are
// candidates, what is inside them, whether their commits are in the merged PR, and every "someone is using this" signal.
// Reads only (git status / fetch of a temporary ref / fs / /proc); the decisions live in rules.mjs and the mutations in act.mjs.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError, NETWORK_TIMEOUT_MS, git, isAncestor, revParse } from '../git.mjs';
import { listWorktrees } from '../local-branches.mjs';
import { expandHome, isInside, samePath } from '../paths.mjs';
import { gitCommonDir, repoRoot } from '../repo.mjs';
import { KEEP_PREFIX, STALE_KEEP_DAYS, isProtectedName, matchesPattern } from './rules.mjs';

// Errors that mean "that entry is not readable / not there (any more)": other users' processes, a process that exited.
const SKIPPABLE = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ESRCH']);
function tolerant(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    if (SKIPPABLE.has(err?.code)) return fallback;
    throw err;
  }
}

// The same answer from the main checkout and from inside any linked worktree: `root` is the first worktree git lists.
export function resolveCanonicalRoot(dir) {
  const top = repoRoot(dir);
  const commonDir = realpathSync(gitCommonDir(top));
  const root = listWorktrees(top)[0].path;
  return { root, commonDir };
}

const DAY_MS = 86400e3;

// The worktree's admin dir (<commonDir>/worktrees/<id>), read from the `gitdir:` line of its `.git` file: the id is not
// always the slug (git suffixes it when two worktrees share a basename). null when the file cannot be read or parsed.
function adminDirOf(wtPath) {
  const text = tolerant(() => readFileSync(path.join(wtPath, '.git'), 'utf8'), null);
  const m = text === null ? null : /^gitdir:[ \t]*(.+?)\s*$/m.exec(text);
  return m ? path.resolve(wtPath, m[1]) : null;
}

// spec §5: a pipeline-keep lock whose `locked` file is older than STALE_KEEP_DAYS -> "stale keep (<N>d: <reason>) — still
// needed?". Anything else (another owner's lock, a fresh keep, an age that cannot be read) -> "locked (<reason>)". Never
// releases a lock.
function lockedReason(entry, nowMs) {
  const plain = `locked (${entry.locked || 'no reason given'})`;
  if (!entry.locked.startsWith(KEEP_PREFIX)) return plain;
  const admin = adminDirOf(entry.path);
  const st = admin === null ? null : tolerant(() => statSync(path.join(admin, 'locked')), null);
  if (!st) return plain;
  const ageMs = nowMs - st.mtimeMs;
  if (ageMs <= STALE_KEEP_DAYS * DAY_MS) return plain;
  const days = Math.floor(ageMs / DAY_MS);
  const why = entry.locked.slice(KEEP_PREFIX.length).trim() || 'no reason given';
  return `stale keep (${days}d: ${why}) — still needed?`;
}

// Direct children of <root>/<worktreeDir> only. Dot-named children (the quarantine dir, dotfiles) are ignored silently;
// every other worktree that is not a candidate is reported with the reason it was skipped.
export function listCandidates(root, { worktreeDir, protect, nowMs = Date.now() }) {
  const wtDir = path.join(root, worktreeDir);
  const candidates = [];
  const skipped = [];
  for (const entry of listWorktrees(root).slice(1)) {
    if (!samePath(path.dirname(entry.path), wtDir)) continue;
    const slug = path.basename(entry.path);
    if (slug.startsWith('.')) continue;
    const skip = (reason) => skipped.push({ slug, path: entry.path, reason });
    if (isProtectedName(slug, protect)) skip('protected');
    else if (entry.prunable) skip('prunable (directory missing)');
    else if (entry.detached || !entry.branch) skip('detached HEAD');
    else if (entry.locked !== null) skip(lockedReason(entry, nowMs));
    else candidates.push({ slug, path: entry.path, branch: entry.branch, head: entry.head, locked: null });
  }
  return { candidates, skipped };
}

// -> [{ path (posix, relative; a trailing "/" marks an ignored/untracked directory), kind: ignored|untracked|tracked-change }]
// (tracked-change also covers a skip-worktree / assume-unchanged entry, see below)
export function statusEntries(wtPath) {
  const out = git(['status', '--porcelain=v1', '--ignored', '--untracked-files=all', '-z'], { cwd: wtPath });
  const fields = out.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    const kind = xy === '!!' ? 'ignored' : xy === '??' ? 'untracked' : 'tracked-change';
    entries.push({ path: f.slice(3), kind });
    if (/[RC]/.test(xy)) i += 1; // a rename/copy carries its source path as the next field
  }
  // `git status` does not report edits to a tracked file flagged skip-worktree or assume-unchanged, so the worktree would look
  // clean while holding unsaved work. `ls-files -v` tags such entries `S` (skip-worktree) or with a lowercase letter
  // (assume-unchanged, also skip-worktree + assume-unchanged). The flag alone blocks, whether or not the file was edited
  // (git cannot say cheaply, and a sparse checkout's skipped files block too): fail closed. A failing call throws, so the caller keeps.
  for (const f of git(['ls-files', '-v', '-z'], { cwd: wtPath }).split('\0')) {
    if (/^[a-zS] /.test(f)) entries.push({ path: f.slice(2), kind: 'tracked-change' });
  }
  return entries;
}

// Every entry under the worktree, symlinks not followed, the top-level `.git` file skipped. Posix relative paths.
// A directory that cannot be listed (EACCES/EPERM) is reported as an `unreadable` entry, never as an empty one: what is
// inside it is unknown, so entriesFor turns it into a blocker. Only an entry that vanished (ENOENT/ENOTDIR) is skipped.
export function walkTree(wtPath) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(wtPath, ...rel.split('/')) : wtPath;
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') out.push({ path: rel || '.', unreadable: true, isDir: true, isSymlink: false, mtimeMs: Date.now() });
      else if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      continue;
    }
    for (const d of children) {
      if (!rel && d.name === '.git') continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const st = tolerant(() => lstatSync(path.join(dir, d.name)), null);
      if (!st) continue;
      out.push({ path: childRel, isSymlink: st.isSymbolicLink(), isDir: st.isDirectory(), mtimeMs: st.mtimeMs });
      if (st.isDirectory()) stack.push(childRel);
    }
  }
  return out;
}

// Status entries with every directory marker replaced by the files under it (same kind), plus `isSymlink` from the walk.
export function entriesFor(wtPath) {
  const walk = walkTree(wtPath);
  const byPath = new Map(walk.map((w) => [w.path, w]));
  const entries = [];
  for (const e of statusEntries(wtPath)) {
    if (!e.path.endsWith('/')) {
      entries.push({ path: e.path, kind: e.kind, isSymlink: byPath.get(e.path)?.isSymlink ?? false });
      continue;
    }
    for (const w of walk) {
      if (!w.isDir && w.path.startsWith(e.path)) entries.push({ path: w.path, kind: e.kind, isSymlink: w.isSymlink });
    }
  }
  // 'tracked-change' (not 'ignored') so no delete/archive pattern, even a directory one like `node_modules/`, can allow it.
  for (const w of walk) if (w.unreadable) entries.push({ path: w.path, kind: 'tracked-change', isSymlink: false });
  return entries;
}

// Is every commit of the worktree's HEAD already in the PR's final head? Fetches refs/pull/<n>/head into a temporary ref
// (always deleted afterwards) and checks it is the head GitHub reported before trusting it.
export function checkAncestry(root, { head, pr }) {
  const n = pr.number;
  const ref = `refs/pipeline-prune/pr-${n}`;
  try {
    try {
      git(['fetch', '--no-tags', '-q', 'origin', `+refs/pull/${n}/head:${ref}`], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      return { ok: false, reason: `could not fetch PR #${n}: ${err.message}` };
    }
    const fetched = revParse(ref, { cwd: root });
    if (fetched !== pr.headRefOid) {
      return { ok: false, reason: `fetched PR #${n} head does not match GitHub (${fetched.slice(0, 7)} ≠ ${String(pr.headRefOid).slice(0, 7)})` };
    }
    if (!isAncestor(head, pr.headRefOid, { cwd: root })) return { ok: false, reason: `has commits that are not in PR #${n}` };
    return { ok: true };
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    return { ok: false, reason: `could not check PR #${n} ancestry: ${err.message}` };
  } finally {
    try {
      git(['update-ref', '-d', ref], { cwd: root });
    } catch { /* nothing to delete, or the repo is unreadable: the next run's check reports it */ }
  }
}

// Processes whose cwd or any open file lies inside `dir`. Linux reads /proc; macOS asks lsof (processesInsideLsof); any
// other platform answers "unavailable" (callers keep). On Linux a process whose links cannot be read (EACCES/EPERM: another
// user's, e.g. a root daemon) is counted in `hidden`, not guessed at; one that exited mid-scan (ENOENT/ESRCH/ENOTDIR) is
// simply gone. -> { available, pids, hidden }
export function processesInside(dir, { procRoot = '/proc', platform = process.platform, run, ownPid } = {}) {
  if (platform === 'darwin') return processesInsideLsof(dir, { platform, run, ownPid });
  if (platform !== 'linux') return { available: false, pids: [], hidden: 0 };
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return { available: false, pids: [], hidden: 0 };
  }
  // /proc reports resolved paths, so a worktree reached through a symlinked parent must also be matched by its realpath.
  const roots = [dir, tolerant(() => realpathSync(dir), dir)];
  // fd links that are not paths (socket:[N], pipe:[N], anon_inode:[eventfd]) are skipped: isInside would resolve them
  // against our own cwd. A deleted file or directory reads back as "<path> (deleted)".
  const inside = (link) => {
    if (link === null) return false;
    const p = link.replace(/ \(deleted\)$/, '');
    return path.isAbsolute(p) && roots.some((r) => isInside(p, r));
  };
  const pids = [];
  let hidden = 0;
  for (const name of names.filter((n) => /^\d+$/.test(n))) {
    const proc = path.join(procRoot, name);
    let denied = false;
    const read = (fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        if (err?.code === 'EACCES' || err?.code === 'EPERM') denied = true;
        else if (err?.code !== 'ENOENT' && err?.code !== 'ESRCH' && err?.code !== 'ENOTDIR') throw err;
        return fallback;
      }
    };
    const links = [read(() => readlinkSync(path.join(proc, 'cwd')), null)];
    for (const fd of read(() => readdirSync(path.join(proc, 'fd')), [])) {
      links.push(read(() => readlinkSync(path.join(proc, 'fd', fd)), null));
    }
    if (links.some(inside)) pids.push(Number(name));
    else if (denied) hidden += 1;
  }
  return { available: true, pids: pids.sort((a, b) => a - b), hidden };
}

const LSOF_TIMEOUT_MS = 60_000;
const LSOF_MAX_BUFFER = 64 * 1024 * 1024;
// macOS spells every path on the boot volume a second way: /System/Volumes/Data/Users/u == /Users/u (a firmlink).
const FIRMLINK = /^\/System\/Volumes\/Data(?=\/|$)/i;
const unFirm = (p) => p.replace(FIRMLINK, '');

// One external command, spawn failures kept visible (lib/proc.mjs `run` folds ENOENT into exit 1, which lsof also uses).
function runCapture(cmd, args, { env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER, killSignal: 'SIGKILL', windowsHide: true });
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout ?? '', pid: r.pid };
}

// lsof prints a "safe" form of every name (util.c safestrprt): a byte it cannot print as-is becomes \xNN (non-ASCII under a
// locale that does not know it, e.g. the C locale launchd hands a job: café -> caf\xc3\xa9), \b \f \n \r \t are spelled out,
// and any other control character is ^X (^@..^_, ^? for DEL). We decode that back to the real name. A backslash is not escaped
// itself, so EVERY backslash is ambiguous (even a recognised \xNN or \t may be a literal backslash in a directory name), and so
// is a `^` followed by @..._ or ? (a control escape, or a literal caret in the file name). A wrong guess here would hide a live
// process and let its worktree be removed, so a name with any of them is judged CONSERVATIVELY (see lsofNameForms): kept
// whenever the text before the first one could still reach a root. The decoded and raw spellings are still checked exactly.
const LSOF_NAMED = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09 };
function lsofNameForms(raw) {
  const bytes = [];
  let ambiguousAt = -1; // byte count decoded before the first ambiguous character
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    const hex = ch === '\\' ? /^x([0-9a-fA-F]{2})/.exec(raw.slice(i + 1)) : null;
    if (ch === '\\' && ambiguousAt < 0) ambiguousAt = bytes.length; // any backslash, recognised or not, may be literal
    if (hex) {
      bytes.push(parseInt(hex[1], 16));
      i += 4;
    } else if (ch === '\\' && Object.hasOwn(LSOF_NAMED, raw[i + 1])) {
      bytes.push(LSOF_NAMED[raw[i + 1]]);
      i += 2;
    } else if (ch === '^' && raw[i + 1] !== undefined && /[@-_?]/.test(raw[i + 1])) {
      if (ambiguousAt < 0) ambiguousAt = bytes.length;
      bytes.push(raw[i + 1] === '?' ? 0x7f : raw.charCodeAt(i + 1) - 0x40);
      i += 2;
    } else {
      const cp = raw.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'));
      i += cp > 0xffff ? 2 : 1;
    }
  }
  const text = (b) => Buffer.from(b).toString('utf8');
  const decoded = text(bytes);
  const prefixes = [];
  if (ambiguousAt >= 0) prefixes.push(text(bytes.slice(0, ambiguousAt)));
  // bytes that are not UTF-8 decode to U+FFFD, which no real directory name equals: the text before it is judged like an
  // ambiguous prefix too.
  const bad = decoded.indexOf('�');
  if (bad >= 0) prefixes.push(decoded.slice(0, bad));
  // the literal undecoded name covers a file whose real name contains a backslash or caret sequence
  return { names: [...new Set([decoded, raw])], prefixes };
}

// `lsof -F pfn` output -> Map<pid, { names: string[], prefixes: string[], cwd: boolean }>. `p<pid>` starts a process, `f<fd>`
// a file of it (fcwd, ftxt, numeric fds…), `n<name>` names that file; other field letters are ignored. `names` are decoded
// absolute paths (plus the raw spelling), `prefixes` the decoded text before an ambiguous escape; `cwd` = a readable
// absolute fcwd.
function parseLsofFields(text) {
  const procs = new Map();
  let cur = null;
  let fd = null;
  for (const line of text.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      const pid = Number(val);
      cur = /^\d+$/.test(val) ? procs.get(pid) ?? procs.set(pid, { names: [], prefixes: [], cwd: false }).get(pid) : null;
      fd = null;
    } else if (tag === 'f') fd = val;
    else if (tag === 'n' && cur) {
      const forms = lsofNameForms(val.replace(/ \(deleted\)$/, ''));
      const names = forms.names.filter((n) => path.isAbsolute(n)).map(unFirm); // sockets and pipes (*:443, ->0x…) are not paths
      if (names.length === 0) continue;
      cur.names.push(...names);
      cur.prefixes.push(...forms.prefixes.filter((p) => path.isAbsolute(p)).flatMap((p) => [p, unFirm(p)]));
      if (fd === 'cwd') cur.cwd = true;
    }
  }
  return procs;
}

// Could a name that starts with `prefix` (and then continues in some unknown way) lie inside `root`? Yes when the prefix
// already is the root or below it, or is still a prefix of "<root>/" (the unknown rest may complete the path). Same case
// folding as isInside on darwin.
function prefixMayReach(prefix, root, platform) {
  const fold = (s) => (platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s);
  const p = fold(prefix.replace(/\\/g, '/'));
  const r = `${fold(root.replace(/\\/g, '/')).replace(/\/$/, '')}/`;
  return p.startsWith(r) || r.startsWith(p);
}

// The environment handed to lsof: a UTF-8 locale and nothing else of ours (no tokens or other secrets), plus PATH only when
// set, because the fallback exe is the bare name 'lsof' and Node resolves it through options.env.PATH. PATH is read by name
// so the hard-stop scan can see exactly which variable leaves this process.
function lsofEnv() {
  const path = process.env.PATH;
  return { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', ...(path ? { PATH: path } : {}) };
}

// macOS: one `lsof -n -P -w -F pfn` for the whole machine. Fail-closed -> { available: false }: lsof missing, killed or timed
// out, exit status other than 0/1 (1 = "some items could not be examined", normal when other users own processes), or the
// positive control failing (our own process always has a readable cwd; if lsof does not show it the scan is blind).
// `hidden` = processes `ps` lists that lsof showed no readable cwd for (other users'); informational, never a keep reason.
function processesInsideLsof(dir, { platform, run = runCapture, ownPid = process.pid } = {}) {
  const unavailable = { available: false, pids: [], hidden: 0 };
  const exe = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
  // a UTF-8 locale keeps non-ASCII names printable where the machine has one; the decoding above covers where it has not.
  // The env is minimal on purpose (lsofEnv): lsof needs none of our variables, so it gets none of our secrets.
  const r = run(exe, ['-n', '-P', '-w', '-F', 'pfn'], { env: lsofEnv() });
  if (!r || r.error || r.signal || (r.status !== 0 && r.status !== 1)) return unavailable;
  const procs = parseLsofFields(String(r.stdout ?? ''));
  if (!procs.get(ownPid)?.cwd) return unavailable;
  const roots = [dir, tolerant(() => realpathSync(dir), dir)].map(unFirm);
  const pids = [];
  for (const [pid, info] of procs) {
    const hit = roots.some((root) => info.names.some((n) => isInside(n, root, platform)) || info.prefixes.some((p) => prefixMayReach(p, root, platform)));
    if (hit) pids.push(pid);
  }
  let hidden = 0;
  const ps = run('ps', ['-axo', 'pid=']);
  if (ps && !ps.error && !ps.signal && ps.status === 0) {
    const skip = new Set([ownPid, r.pid, ps.pid]);
    for (const m of String(ps.stdout ?? '').matchAll(/^\s*(\d+)\s*$/gm)) {
      const pid = Number(m[1]);
      if (!skip.has(pid) && !procs.get(pid)?.cwd) hidden += 1;
    }
  }
  return { available: true, pids: pids.sort((a, b) => a - b), hidden };
}

// *.jsonl files two levels down: <dir>/<project>/*.jsonl and <dir>/<project>/<session>/subagents/*.jsonl.
function transcriptFiles(dir) {
  const files = [];
  const listDir = (d) => tolerant(() => readdirSync(d, { withFileTypes: true }), []);
  for (const project of listDir(dir).filter((e) => e.isDirectory())) {
    const pdir = path.join(dir, project.name);
    for (const e of listDir(pdir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(pdir, e.name));
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        for (const s of listDir(sub)) if (s.isFile() && s.name.endsWith('.jsonl')) files.push(path.join(sub, s.name));
      }
    }
  }
  return files;
}

// Does one transcript line show a session working in a worktree? Its top-level `cwd` equals or is inside one of `paths`, or
// it carries a `tool_use` content block whose input names one. Tool results, user and assistant prose do not count: one
// `git worktree list` or `ship inbox` output names every worktree. A line that is not a JSON object counts (fail-closed).
export function lineShowsWork(text, paths) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return true;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return true;
  if (typeof obj.cwd === 'string' && paths.some((p) => isInside(obj.cwd, p))) return true;
  // JSON.stringify escapes a backslash, so a Windows path is looked for in its escaped form.
  const escaped = paths.map((p) => JSON.stringify(p).slice(1, -1));
  const blocks = [obj.message?.content, obj.content].filter(Array.isArray).flat();
  return blocks.some((b) => b?.type === 'tool_use' && escaped.some((e) => (JSON.stringify(b.input ?? null) ?? '').includes(e)));
}

const CHUNK = 1 << 20;
const LINE_CAP = 64 << 20; // a longer line that holds a needle is not parsed: it counts (fail-closed)

// Reads the file in 1 MiB chunks and parses only the lines that contain a needle (a path, raw or JSON-escaped). A line is
// gathered across chunks, and the last (longest needle - 1) bytes of the line so far are searched again with the next
// piece, so a needle cannot hide on a chunk seam.
function fileShowsWork(file, paths) {
  const needles = [...new Set(paths.flatMap((p) => [p, JSON.stringify(p).slice(1, -1)]))].map((n) => Buffer.from(n));
  const keep = Math.max(...needles.map((n) => n.length)) - 1;
  const fd = openSync(file, 'r');
  try {
    let parts = [];
    let size = 0;
    let hit = false;
    let tail = Buffer.alloc(0);
    const lineDone = () => {
      const works = hit && (size > LINE_CAP || lineShowsWork(Buffer.concat(parts).toString('utf8'), paths));
      parts = [];
      size = 0;
      hit = false;
      tail = Buffer.alloc(0);
      return works;
    };
    for (;;) {
      const chunk = Buffer.allocUnsafe(CHUNK); // fresh each time: `parts` keeps slices of it
      const n = readSync(fd, chunk, 0, CHUNK, null);
      if (n === 0) return lineDone();
      const data = chunk.subarray(0, n);
      let start = 0;
      while (start < n) {
        const nl = data.indexOf(10, start);
        const end = nl === -1 ? n : nl;
        const piece = data.subarray(start, end);
        if (!hit) {
          const seam = Buffer.concat([tail, piece.subarray(0, keep)]);
          hit = needles.some((nd) => piece.includes(nd) || seam.includes(nd));
          tail = piece.length >= keep ? piece.subarray(piece.length - keep) : Buffer.concat([tail, piece]).subarray(-keep);
        }
        size += piece.length;
        if (size <= LINE_CAP) parts.push(piece);
        if (end === n) break;
        if (lineDone()) return true;
        start = end + 1;
      }
    }
  } finally {
    closeSync(fd);
  }
}

// A recent transcript that cannot be read (EACCES/EPERM) might mention the worktree, so it counts as a mention
// (fail-closed); one that vanished since the listing does not.
function recentTranscriptMentions(file, paths) {
  try {
    return fileShowsWork(file, paths);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return true;
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw err;
  }
}

// Every spelling of a path a session may have logged: the path itself, its realpath, and the realpath reached through a
// symlink sitting in one of its ancestor directories (this PC: ~/Claude -> ~/projects; git records the real path, a
// session started under the alias logs the alias). One alias level; any entry that cannot be read is simply skipped.
export function pathSpellings(p) {
  const out = [p];
  let real;
  try {
    real = realpathSync(p);
  } catch {
    return out;
  }
  out.push(real);
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isSymbolicLink());
    } catch { /* unreadable: no alias from here */ }
    for (const e of entries) {
      try {
        const target = realpathSync(path.join(dir, e.name));
        if (target !== real && isInside(real, target)) out.push(path.join(dir, e.name, path.relative(target, real)));
      } catch { /* dangling or looping link */ }
    }
    if (path.dirname(dir) === dir) break;
  }
  return [...new Set(out)];
}

// Paths of Claude transcripts (*.jsonl) modified at or after sinceMs with a line showing a session working in `paths`,
// under any of their spellings (lineShowsWork, pathSpellings), or that cannot be read. Paths only: a branch name also appears
// in every PR list.
export function transcriptMentions(paths, { dirs, sinceMs }) {
  const wanted = [...new Set(paths.filter(Boolean).flatMap(pathSpellings))];
  if (!wanted.length) return [];
  const hits = [];
  for (const dir of dirs) {
    for (const file of transcriptFiles(dir)) {
      const st = tolerant(() => lstatSync(file), null);
      if (st && st.mtimeMs >= sinceMs && recentTranscriptMentions(file, wanted)) hits.push(file);
    }
  }
  return hits;
}

// $CLAUDE_CONFIG_DIR/projects plus every <home>/.claude*/projects that exists, de-duplicated by realpath.
export function defaultTranscriptDirs(home = os.homedir(), env = process.env) {
  const named = tolerant(() => readdirSync(home), []).filter((n) => /^\.claude/.test(n)).sort();
  const wanted = [env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, 'projects'), ...named.map((n) => path.join(home, n, 'projects'))];
  const seen = new Set();
  const dirs = [];
  for (const dir of wanted.filter(Boolean)) {
    const real = tolerant(() => realpathSync(dir), null);
    if (real === null || seen.has(real)) continue;
    seen.add(real);
    dirs.push(dir);
  }
  return dirs;
}

// Memory notes (*.md, the dir itself and one level of subdirs; never MEMORY-archive.md or an archive/ dir) with a line that
// names the slug or branch AND says the work is live (BUILDING / ledger home / keep).
export function memoryMentions({ slug, branch }, { dirs }) {
  const names = [slug, branch].filter(Boolean);
  const live = /BUILDING|ledger home|\bkeep\b/i;
  const hits = [];
  const listDir = (d) => tolerant(() => readdirSync(d, { withFileTypes: true }), []);
  const scan = (file) => {
    const text = tolerant(() => readFileSync(file, 'utf8'), '');
    if (text.split(/\r?\n/).some((line) => live.test(line) && names.some((n) => line.includes(n)))) hits.push(file);
  };
  for (const raw of dirs) {
    const dir = expandHome(raw);
    for (const e of listDir(dir)) {
      if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY-archive.md') scan(path.join(dir, e.name));
      else if (e.isDirectory() && e.name !== 'archive') {
        for (const f of listDir(path.join(dir, e.name))) {
          if (f.isFile() && f.name.endsWith('.md') && f.name !== 'MEMORY-archive.md') scan(path.join(dir, e.name, f.name));
        }
      }
    }
  }
  return hits;
}

// Files (not directories; an unreadable directory counts as a changed file) changed at or after sinceMs that match no `ignore` pattern: the delete + archive lists.
export function recentFiles(walk, { sinceMs, ignore }) {
  return walk
    .filter((w) => (!w.isDir || w.unreadable) && w.mtimeMs >= sinceMs && !ignore.some((p) => matchesPattern(w.path, p)))
    .map((w) => w.path);
}
