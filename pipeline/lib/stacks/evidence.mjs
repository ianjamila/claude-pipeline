// Consumer evidence for stack-stop: who could still be using a stack. Every probe answers ok | unknown (fail closed) and,
// unlike the tolerant worktree-prune probes it borrows pure helpers from, none of them turns "could not look" into "nothing
// there": a directory that cannot be read, a note that cannot be opened, a process whose cwd lsof will not show, a PR page
// that failed are all unknown. One runner contract throughout: run(bin, args, opts) -> { code, stdout, stderr, timedOut,
// signal, pid } (pipeline/lib/proc.mjs); the lsof / ps binaries are chosen by the caller (resolveProbeBins).
//
// C2 connections   counted from the SERVER side. On macOS every published stack port is held by the Docker/OrbStack helper,
//                  which runs as this user, so `lsof -iTCP` sees the helper's end of every connection whoever the client is.
//                  Positive control: each published port has a LISTEN socket. An ESTABLISHED socket whose local port is a stack
//                  port is one connection; its client is named when lsof shows it, else it is a "hidden client" (still a
//                  connection: the stack is in use). Zero established + listeners present is a healthy ok([]).
// C3 processRefs   `ps -axww` (every user's command line) and `ps -axE -ww` (environment, this user's processes only). The
//                  second ps runs with a nonce variable in its own env; it must show it, or the environment is not visible.
// cwdInside        ps uid snapshot FIRST, then whole-machine `lsof -n -P -w -F pfn`. Every same-user pid in the snapshot must
//                  be accounted for: listed with a readable cwd (checked), or provably gone; anything else is unknown. The
//                  probe's own children are never hits (run() results carry their pids).
// Other users' processes: their environment and cwd / open files cannot be read without root. Their real use of a stack shows
// in C2 (server side) and in C3's command line; the results carry `hidden: N` (the count of such processes) so reports say so.
// Every C2 / C3 / cwd hit carries { pid, birth } read at observation time (procIdentity; birth null when that is unknown).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { run as realRun } from '../proc.mjs';
import { git as realGit } from '../git.mjs';
import { createGitHub } from '../github.mjs';
import { listWorktrees as realListWorktrees } from '../local-branches.mjs';
import { isInside, samePath } from '../paths.mjs';
import { lineShowsWork, pathSpellings, parseLsofFields, prefixMayReach, unFirm } from '../worktree-prune/inspect.mjs';
import { checkRepoIdentity, fetchBranchPrs } from '../worktree-prune/prs.mjs';
import { procIdentity } from './identity.mjs';
import { portRefRe, readOnlyCommand } from './match.mjs';
import { stacksSeam } from './paths.mjs';
import { ok, unknown } from './result.mjs';

const CALL_CAP_MS = 15000;
const MIN_REMAINING_MS = 500; // under this, a subprocess is not worth starting
const LSOF_MAX_BUFFER = 256 * 1024 * 1024;
const DEFAULT_LSOF = '/usr/sbin/lsof';
const DEFAULT_PS = '/bin/ps';
const NONCE_VAR = 'PIPELINE_STACKS_PROBE';
// A UTF-8 locale keeps non-ASCII paths printable in ps / lsof output; nothing else of ours (no tokens) reaches them.
const LOCALE = { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
const WINDOWS = () => unknown('windows');

// The lsof / ps binaries for this process: the PIPELINE_LSOF / PIPELINE_PS test seams (isolated runs in the checkout only,
// see stacksSeam), else the system paths.
export function resolveProbeBins({ env = process.env, home = os.homedir(), root, warn } = {}) {
  const pick = (name, fallback) => {
    const v = stacksSeam(name, env, { root, home, ...(warn ? { warn } : {}) });
    return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
  };
  return { lsof: pick('PIPELINE_LSOF', DEFAULT_LSOF), ps: pick('PIPELINE_PS', DEFAULT_PS) };
}

const shortMsg = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 160);
const oneLine = (s) => String(s ?? '').trim().split('\n')[0].slice(0, 160);

// One subprocess, bounded by min(15 s, time left until deadlineAt). -> { r } | { fail: unknown-result }.
function call(run, bin, args, { deadlineAt, now = Date.now, env, replaceEnv, maxBuffer } = {}) {
  let timeoutMs = CALL_CAP_MS;
  if (deadlineAt !== undefined && deadlineAt !== null) {
    const remaining = deadlineAt - now();
    if (remaining < MIN_REMAINING_MS) return { fail: unknown('deadline') };
    timeoutMs = Math.min(CALL_CAP_MS, remaining);
  }
  const name = path.basename(String(bin));
  let r;
  try {
    r = run(bin, args, { timeoutMs, ...(env ? { env } : {}), ...(replaceEnv ? { replaceEnv } : {}), ...(maxBuffer ? { maxBuffer } : {}) });
  } catch (err) {
    return { fail: unknown(`${name} could not run: ${shortMsg(err)}`) };
  }
  if (!r || typeof r !== 'object') return { fail: unknown(`${name} returned nothing`) };
  if (r.timedOut) return { fail: unknown(`${name} timed out`) };
  if (r.signal) return { fail: unknown(`${name} ended by signal ${r.signal}`) };
  return { r };
}

// { pid, birth } at observation time, or birth null when the lookup is unknown or the process just exited.
function identify(pid, { run, ps, kill, platform, deadlineAt, now }) {
  const id = procIdentity(pid, { run, ps, platform, deadlineAt, now, ...(kill ? { kill } : {}) });
  return { pid, birth: id.ok && id.value ? id.value.birth : null };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOUND_AFTER = '($|[^\\w-])';

// The ways a text can name this stack. Whole-word on the project id: `sa` must not hit `sa-followups`, but does hit
// `sa.stack`, `/sa/` and `--project sa`. The container name pattern covers `supabase_<svc>_<project>` (an underscore is a word
// character, so the id rule alone cannot see it). Over-matching only adds a reason to keep; under-matching would stop a used
// stack.
function matchers(stack, { ports = true, spellings = pathSpellings } = {}) {
  const out = [];
  const id = String(stack?.project ?? '');
  if (stack?.folder) out.push({ name: 'folder', re: new RegExp(`(^|[^\\w-])${escapeRe(stack.folder)}${BOUND_AFTER}`, 'i') });
  if (id) {
    out.push({ name: 'id', re: new RegExp(`(^|[^\\w-])${escapeRe(id)}${BOUND_AFTER}`, 'i') });
    out.push({ name: 'container', re: new RegExp(`supabase_[a-z0-9_]+?_${escapeRe(id)}${BOUND_AFTER}`, 'i') });
  }
  const dirs = stack?.workdir ? [...new Set(spellings(stack.workdir))] : [];
  for (const d of dirs) out.push({ name: 'workdir', re: new RegExp(`${escapeRe(d)}${BOUND_AFTER}`) });
  if (ports) for (const p of stack?.ports ?? []) out.push({ name: 'port', re: portRefRe(p) });
  return { patterns: out, dirs };
}
const firstMatch = (patterns, text) => {
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) return { by: p.name, text: m[0].trim() };
  }
  return null;
};

// ---------------------------------------------------------------- C2

// `lsof -F pcnT`: p<pid> starts a process, c<command>, f<fd> starts a file, n<name>, T<key>=<value> (TST=state). A file also
// starts at an `n` when the current one already has a name (output without f lines).
function parseSockets(textIn) {
  const socks = [];
  let proc = null;
  let file = null;
  const flush = () => {
    if (file && file.name !== null) socks.push(file);
    file = null;
  };
  for (const line of String(textIn).split('\n')) {
    if (line === '') continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      flush();
      proc = { pid: /^\d+$/.test(val) ? Number(val) : null, command: '' };
    } else if (tag === 'c' && proc) {
      proc.command = val;
    } else if (tag === 'f') {
      flush();
      file = { pid: proc?.pid ?? null, command: proc?.command ?? '', name: null, state: null };
    } else if (tag === 'n') {
      if (file && file.name !== null) flush();
      file ??= { pid: proc?.pid ?? null, command: proc?.command ?? '', name: null, state: null };
      file.name = val;
    } else if (tag === 'T' && val.startsWith('ST=')) {
      file ??= { pid: proc?.pid ?? null, command: proc?.command ?? '', name: null, state: null };
      file.state = val.slice(3);
    }
  }
  flush();
  return socks;
}

// "addr:port" -> { addr, port }; the port is whatever follows the last colon (IPv6 addresses are bracketed).
function endpoint(s) {
  const m = /^(.*):(\d+)$/.exec(s ?? '');
  return m ? { addr: m[1], port: Number(m[2]) } : null;
}
function splitName(name) {
  const [l, r] = String(name).split('->');
  const local = endpoint(l);
  return local ? { local, remote: r === undefined ? null : endpoint(r) } : null;
}

export function connections(stack, { run = realRun, lsof = DEFAULT_LSOF, ps = DEFAULT_PS, kill, platform = process.platform, deadlineAt, now = Date.now, excludePids = new Set() } = {}) {
  if (platform === 'win32') return WINDOWS();
  const ports = [...new Set(stack?.ports ?? [])];
  if (ports.length === 0) return ok([]);
  const c = call(run, lsof, ['-nP', '-w', '-iTCP', '-sTCP:LISTEN,ESTABLISHED', '-F', 'pcnT'], { deadlineAt, now, env: LOCALE, replaceEnv: true, maxBuffer: LSOF_MAX_BUFFER });
  if (c.fail) return c.fail;
  // lsof exits 1 when some item could not be examined; that is only believable with the positive control below.
  if (c.r.code !== 0 && c.r.code !== 1) return unknown(`lsof exit ${c.r.code}: ${oneLine(c.r.stderr)}`);
  const socks = parseSockets(c.r.stdout ?? '').map((s) => ({ ...s, ...(splitName(s.name) ?? { local: null, remote: null }) })).filter((s) => s.local);
  const portSet = new Set(ports);
  for (const p of ports) {
    if (!socks.some((s) => s.state === 'LISTEN' && s.local.port === p)) return unknown(`port ${p} listener not visible`);
  }
  const established = socks.filter((s) => s.state === 'ESTABLISHED' && s.remote);
  const servers = established.filter((s) => portSet.has(s.local.port));
  const clients = established.filter((s) => !portSet.has(s.local.port) && portSet.has(s.remote.port));
  const used = new Set();
  const found = [];
  const ctx = { run, ps, kill, platform, deadlineAt, now };
  const named = (cl, port) => {
    if (excludePids.has(cl.pid)) return;
    found.push({ ...identify(cl.pid, ctx), command: cl.command, port });
  };
  for (const sv of servers) {
    const idx = clients.findIndex((cl, i) => !used.has(i) && cl.local.port === sv.remote.port && cl.remote.port === sv.local.port && cl.local.addr === sv.remote.addr);
    const idx2 = idx >= 0 ? idx : clients.findIndex((cl, i) => !used.has(i) && cl.local.port === sv.remote.port && cl.remote.port === sv.local.port);
    if (idx2 >= 0) {
      used.add(idx2);
      named(clients[idx2], sv.local.port);
    } else {
      found.push({ pid: null, birth: null, command: 'hidden client', port: sv.local.port });
    }
  }
  // A client socket whose server side lsof did not show is a connection too (never fewer than the client side alone says).
  clients.forEach((cl, i) => { if (!used.has(i)) named(cl, cl.remote.port); });
  return ok(found);
}

// ---------------------------------------------------------------- C3

function parseRows(textIn, withUid) {
  const re = withUid ? /^\s*(\d+)\s+(\d+)\s+(.*)$/ : /^\s*(\d+)\s+(.*)$/;
  const rows = new Map();
  let last = null;
  for (const line of String(textIn).split('\n')) {
    if (line.trim() === '') continue;
    const m = re.exec(line);
    // a command line may contain a newline: the rest belongs to the process above it
    if (!m) {
      if (last) last.command += `\n${line}`;
      continue;
    }
    const row = withUid ? { uid: Number(m[2]), command: m[3] } : { command: m[2] };
    rows.set(Number(m[1]), row);
    last = row;
  }
  return rows;
}

const defaultUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

export function processRefs(stack, {
  run = realRun, ps = DEFAULT_PS, kill, platform = process.platform, deadlineAt, now = Date.now, uid = defaultUid(), excludePids = new Set(),
  nonce = randomBytes(8).toString('hex'), spellings = pathSpellings,
} = {}) {
  if (platform === 'win32') return WINDOWS();
  if (!Number.isInteger(uid)) return unknown('own uid unknown');
  const { patterns } = matchers(stack, { ports: true, spellings });
  const cmd = call(run, ps, ['-axww', '-o', 'pid=,uid=,command='], { deadlineAt, now, env: LOCALE, replaceEnv: true });
  if (cmd.fail) return cmd.fail;
  if (cmd.r.code !== 0) return unknown(`ps exit ${cmd.r.code}: ${oneLine(cmd.r.stderr)}`);
  const rows = parseRows(cmd.r.stdout, true);
  if (!Number.isInteger(cmd.r.pid) || !rows.has(cmd.r.pid)) return unknown('ps does not list itself');
  const env = call(run, ps, ['-axE', '-ww', '-o', 'pid=,command='], { deadlineAt, now, env: { ...LOCALE, [NONCE_VAR]: nonce }, replaceEnv: true });
  if (env.fail) return env.fail;
  if (env.r.code !== 0) return unknown(`ps -E exit ${env.r.code}: ${oneLine(env.r.stderr)}`);
  const envRows = parseRows(env.r.stdout, false);
  if (!Number.isInteger(env.r.pid) || !envRows.get(env.r.pid)?.command.includes(`${NONCE_VAR}=${nonce}`)) {
    return unknown('ps does not show its own environment (nonce variable not visible)');
  }
  const skip = new Set([cmd.r.pid, env.r.pid, ...excludePids]);
  const ctx = { run, ps, kill, platform, deadlineAt, now };
  const hits = [];
  for (const pid of new Set([...rows.keys(), ...envRows.keys()])) {
    if (skip.has(pid)) continue;
    const cmdline = rows.get(pid)?.command;
    let m = cmdline === undefined ? null : firstMatch(patterns, cmdline);
    let field = 'cmdline';
    if (!m && envRows.has(pid)) {
      m = firstMatch(patterns, envRows.get(pid).command);
      field = cmdline === undefined ? 'cmdline' : 'env';
    }
    if (m) hits.push({ ...identify(pid, ctx), command: (cmdline ?? envRows.get(pid).command).slice(0, 300), field, matched: m.text, by: m.by });
  }
  let hidden = 0;
  for (const [pid, row] of rows) if (!skip.has(pid) && row.uid !== uid) hidden += 1;
  return { ok: true, value: hits.sort((a, b) => a.pid - b.pid), hidden };
}

// ---------------------------------------------------------------- cwd / open files

export function cwdInside(dirs, {
  run = realRun, lsof = DEFAULT_LSOF, ps = DEFAULT_PS, kill, platform = process.platform, deadlineAt, now = Date.now, uid = defaultUid(),
  ownPid = process.pid, excludePids = new Set(), spellings = pathSpellings,
} = {}) {
  if (platform === 'win32') return WINDOWS();
  if (!Number.isInteger(uid)) return unknown('own uid unknown');
  const wanted = (dirs ?? []).filter(Boolean);
  // 1. the process table FIRST: every same-user pid in it has to be accounted for by the lsof taken after it
  const snap = call(run, ps, ['-axo', 'pid=,uid=,stat='], { deadlineAt, now, env: LOCALE, replaceEnv: true });
  if (snap.fail) return snap.fail;
  if (snap.r.code !== 0) return unknown(`ps exit ${snap.r.code}: ${oneLine(snap.r.stderr)}`);
  const table = new Map();
  for (const line of String(snap.r.stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) return unknown(`unparsable ps line ${JSON.stringify(line.slice(0, 80))}`);
    table.set(Number(m[1]), { uid: Number(m[2]), zombie: m[3].startsWith('Z') });
  }
  if (!table.has(ownPid)) return unknown('ps does not list the calling process');
  // 2. the whole machine's cwd + open files
  const ls = call(run, lsof, ['-n', '-P', '-w', '-F', 'pfn'], { deadlineAt, now, env: LOCALE, replaceEnv: true, maxBuffer: LSOF_MAX_BUFFER });
  if (ls.fail) return ls.fail;
  if (ls.r.code !== 0 && ls.r.code !== 1) return unknown(`lsof exit ${ls.r.code}: ${oneLine(ls.r.stderr)}`);
  const procs = parseLsofFields(String(ls.r.stdout ?? ''));
  if (!procs.get(ownPid)?.cwd) return unknown('lsof does not show the calling process cwd (scan is blind)');
  const skip = new Set([snap.r.pid, ls.r.pid, ...excludePids]);
  const ctx = { run, ps, kill, platform, deadlineAt, now };
  let hidden = 0;
  for (const [pid, row] of table) {
    if (skip.has(pid) || row.zombie) continue;
    const info = procs.get(pid);
    if (row.uid !== uid) {
      if (!info?.cwd) hidden += 1;
      continue;
    }
    if (info?.cwd) continue;
    if (info) return unknown(`pid ${pid} is listed by lsof without a readable cwd`);
    const id = procIdentity(pid, { run, ps, platform, deadlineAt, now, ...(kill ? { kill } : {}) });
    if (!id.ok) return unknown(`pid ${pid} is not in lsof and its state is unknown (${id.reason})`);
    if (id.value !== null) return unknown(`pid ${pid} is alive but lsof did not show it`);
  }
  const roots = wanted.map((dir) => ({ dir, roots: [...new Set(spellings(dir).map(unFirm))] }));
  const hits = [];
  for (const [pid, info] of procs) {
    if (skip.has(pid)) continue;
    for (const { dir, roots: rs } of roots) {
      const inside = rs.some((root) => info.names.some((n) => isInside(n, root, platform)) || info.prefixes.some((p) => prefixMayReach(p, root, platform)));
      if (inside) hits.push({ ...identify(pid, ctx), dir });
    }
  }
  return { ok: true, value: hits.sort((a, b) => a.pid - b.pid), hidden };
}

// ---------------------------------------------------------------- strict directory / file walking

const isMissing = (err) => err?.code === 'ENOENT';
const isGone = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

// Expands `*` / `?` path segments (config's transcriptDirs default is `<home>/.claude*/projects`). Any readdir failure while
// expanding is unknown; a segment that is not a glob is joined without a check (a missing root is the scan's note).
export function expandTranscriptDirs(dirs, { fsx = fs, platform = process.platform } = {}) {
  if (platform === 'win32') return WINDOWS();
  let current = [];
  for (const pattern of dirs ?? []) {
    const root = path.parse(pattern).root;
    const segs = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let paths = [root || '.'];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!/[*?]/.test(seg)) {
        paths = paths.map((p) => path.join(p, seg));
        continue;
      }
      const re = new RegExp(`^${seg.split('').map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRe(ch))).join('')}$`);
      const next = [];
      for (const p of paths) {
        let entries;
        try {
          entries = fsx.readdirSync(p, { withFileTypes: true });
        } catch (err) {
          return unknown(`cannot expand ${pattern}: ${p}: ${err?.code ?? shortMsg(err)}`);
        }
        for (const e of entries.filter((x) => re.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (i < segs.length - 1) {
            let isDir = e.isDirectory();
            if (!isDir && e.isSymbolicLink()) {
              try { isDir = fsx.statSync(path.join(p, e.name)).isDirectory(); } catch { isDir = false; }
            }
            if (!isDir) continue;
          }
          next.push(path.join(p, e.name));
        }
      }
      paths = next;
    }
    current.push(...paths);
  }
  const seen = new Set();
  const out = [];
  for (const p of current) {
    let real = p;
    try { real = fsx.realpathSync(p); } catch { /* a root that is not there is kept (the scan notes it) */ }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  return ok(out);
}

// *.jsonl under <dir>/<project>/ and <dir>/<project>/<session>/subagents/ modified at or after sinceMs. A configured root that
// does not exist is a note; any other failure to list or stat is unknown.
// readdir with the strict rules: a missing configured root is a note (top), a vanished inner directory is empty, anything
// else is { fail: unknown }.
function listDirStrict(fsx, d, { top = false, notes = [] } = {}) {
  try {
    return { entries: fsx.readdirSync(d, { withFileTypes: true }) };
  } catch (err) {
    if (top && isMissing(err)) { notes.push(`${d} does not exist`); return { entries: [] }; }
    if (!top && isGone(err)) return { entries: [] };
    return { fail: unknown(`cannot read ${d}: ${err?.code ?? shortMsg(err)}`) };
  }
}

// The subagent transcripts of one session: <projectDir>/<session>/subagents/*.jsonl. -> { files } | { fail }.
function subagentFiles(fsx, pdir, session) {
  const sub = listDirStrict(fsx, path.join(pdir, session, 'subagents'));
  if (sub.fail) return sub;
  return { files: sub.entries.filter((x) => x.name.endsWith('.jsonl') && !x.isDirectory()).map((x) => path.join(pdir, session, 'subagents', x.name)) };
}

function transcriptFilesStrict(dirs, sinceMs, fsx, notes) {
  const files = [];
  const list = (d, opts) => listDirStrict(fsx, d, { ...opts, notes });
  const add = (file) => {
    let st;
    try {
      st = fsx.lstatSync(file);
    } catch (err) {
      if (isGone(err)) return null;
      return unknown(`cannot stat ${file}: ${err?.code ?? shortMsg(err)}`);
    }
    if (st.mtimeMs >= sinceMs) files.push(file);
    return null;
  };
  for (const dir of dirs) {
    const top = list(dir, { top: true });
    if (top.fail) return top.fail;
    for (const project of top.entries.filter((e) => e.isDirectory() || e.isSymbolicLink())) {
      const pdir = path.join(dir, project.name);
      const inner = list(pdir);
      if (inner.fail) return inner.fail;
      for (const e of inner.entries) {
        if (e.name.endsWith('.jsonl') && !e.isDirectory()) {
          const bad = add(path.join(pdir, e.name));
          if (bad) return bad;
        } else if (e.isDirectory()) {
          const sub = subagentFiles(fsx, pdir, e.name);
          if (sub.fail) return sub.fail;
          for (const file of sub.files) {
            const bad = add(file);
            if (bad) return bad;
          }
        }
      }
    }
  }
  return { files };
}

const CHUNK = 1 << 20;
// Calls onLine(line) for every line of the file (read in 1 MiB chunks); stops and returns true when onLine does.
function scanLines(fsx, file, onLine) {
  const fd = fsx.openSync(file, 'r');
  try {
    const dec = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    for (;;) {
      const n = fsx.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const parts = (carry + dec.write(buf.subarray(0, n))).split('\n');
      carry = parts.pop();
      for (const line of parts) if (onLine(line) === true) return true;
    }
    carry += dec.end();
    return carry !== '' && onLine(carry) === true;
  } finally {
    fsx.closeSync(fd);
  }
}

// Does a transcript line show a session working with this stack? Its cwd is inside the stack workdir, or a tool_use input names
// it (folder, project id, container, workdir). Tool results and prose do not count. A candidate line that is not valid JSON counts.
function lineRefsStack(textIn, m) {
  if (!m.anyRe.test(textIn)) return false;
  let obj;
  try {
    obj = JSON.parse(textIn);
  } catch {
    return true;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return true;
  if (m.dirs.length && lineShowsWork(textIn, m.dirs)) return true;
  const blocks = [obj.message?.content, obj.content].filter(Array.isArray).flat();
  return blocks.some((b) => b?.type === 'tool_use' && firstMatch(m.patterns, JSON.stringify(b.input ?? null) ?? '') !== null);
}

function transcriptMatchers(stack, spellings) {
  const { patterns, dirs } = matchers(stack, { ports: false, spellings });
  const escapedDirs = dirs.map((d) => JSON.stringify(d).slice(1, -1));
  const anyRe = new RegExp([...patterns.map((p) => p.re.source), ...dirs.map(escapeRe), ...escapedDirs.map(escapeRe)].join('|'), 'i');
  return { patterns, dirs, anyRe };
}

export function transcriptRefs(stack, { dirs, sinceMs = 0, platform = process.platform, fsx = fs, spellings = pathSpellings } = {}) {
  if (platform === 'win32') return WINDOWS();
  const exp = expandTranscriptDirs(dirs, { fsx, platform });
  if (!exp.ok) return exp;
  const notes = [];
  const listed = transcriptFilesStrict(exp.value, sinceMs, fsx, notes);
  if (listed.fail !== undefined || listed.ok === false) return listed;
  const m = transcriptMatchers(stack, spellings);
  const hits = [];
  for (const file of listed.files) {
    try {
      if (scanLines(fsx, file, (line) => lineRefsStack(line, m))) hits.push(file);
    } catch (err) {
      if (isGone(err)) continue; // vanished since the listing
      return unknown(`cannot read ${file}: ${err?.code ?? shortMsg(err)}`);
    }
  }
  return { ok: true, value: hits, notes };
}

// ---------------------------------------------------------------- owner quiet proof (false-MISS fix, spec 2026-10-19 §6)

const SESSION_ID_RE = /^[0-9a-f-]{8,}$/i;
const START_SLACK_BEFORE_MS = 5000;
const START_WINDOW_AFTER_MS = 120000;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch']);

const lineBlocks = (obj) => [obj?.message?.content, obj?.content].filter(Array.isArray).flat();
const timeOf = (obj) => (obj?.timestamp === undefined || obj?.timestamp === null ? NaN : Date.parse(String(obj.timestamp)));

// Text a user typed on a line (string content or text blocks); a `<bash-input>` there is a `!` command, which runs without hooks.
function userHasBashInput(obj) {
  if (obj?.type !== 'user' && obj?.message?.role !== 'user') return false;
  const texts = [obj.message?.content, obj.content].flatMap((c) => (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text) : []));
  return texts.some((t) => t.includes('<bash-input>'));
}

// Why this line is more than read-only inspection (a short label), or null. `strict` (no usable timestamp): any tool call counts.
function unexplained(obj, { strict, platform }) {
  if (userHasBashInput(obj)) return 'a <bash-input> command';
  for (const b of lineBlocks(obj)) {
    if (b?.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : '?';
    if (strict) return `${name} on a line without a timestamp`;
    if (READ_TOOLS.has(name)) continue;
    if (name === 'Bash' && typeof b.input?.command === 'string' && readOnlyCommand(b.input.command, platform)) continue;
    return name === 'Bash' ? `Bash: ${String(b.input?.command ?? '').slice(0, 80)}` : name;
  }
  return null;
}

// Did the process that held a stack lease do anything but read-only inspection between its birth and the decision, according to its
// own session transcript? -> ok({ verdict: 'quiet' | 'active', file, why }) | unknown. The transcript must show the process STARTED in
// it (a SessionStart:startup / :resume hook line near the birth; after /clear or /compact an earlier transcript of the same process
// exists under another id and cannot be found), otherwise unknown. Only the owner's own tool calls are judged here: a child or
// hook process is judged by its own C2 / C3 uses. Fail closed: unknown and active both leave the use a MISS.
export function ownerQuiet({ sessionId, birthMs, decidedMs, dirs, fsx = fs, platform = process.platform } = {}) {
  if (platform === 'win32') return WINDOWS();
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return unknown('no usable session id');
  if (!Number.isFinite(birthMs) || !Number.isFinite(decidedMs)) return unknown('no usable birth or decision time');
  const exp = expandTranscriptDirs(dirs, { fsx, platform });
  if (!exp.ok) return exp;
  const mains = new Map(); // realpath -> { file, pdir }
  for (const dir of exp.value) {
    const top = listDirStrict(fsx, dir, { top: true });
    if (top.fail) return top.fail;
    for (const project of top.entries.filter((e) => e.isDirectory() || e.isSymbolicLink())) {
      const pdir = path.join(dir, project.name);
      const inner = listDirStrict(fsx, pdir);
      if (inner.fail) return inner.fail;
      if (!inner.entries.some((e) => e.name === `${sessionId}.jsonl` && !e.isDirectory())) continue;
      const file = path.join(pdir, `${sessionId}.jsonl`);
      let real = file;
      try { real = fsx.realpathSync(file); } catch { /* keep the joined path */ }
      if (!mains.has(real)) mains.set(real, { file, pdir });
    }
  }
  if (mains.size === 0) return unknown(`no transcript for session ${sessionId}`);
  if (mains.size > 1) return unknown(`more than one transcript for session ${sessionId}`);
  const { file, pdir } = [...mains.values()][0];
  const subs = subagentFiles(fsx, pdir, sessionId);
  if (subs.fail) return subs.fail;

  const lo = birthMs - START_SLACK_BEFORE_MS;
  let first = null; // earliest SessionStart marker of this session in [birth - 5 s, birth + 120 s]
  let active = null;
  const scan = (f, isMain) => {
    scanLines(fsx, f, (line) => {
      if (line.trim() === '') return false;
      let obj;
      try { obj = JSON.parse(line); } catch {
        active ??= `${path.basename(f)}: a line is not valid JSON`;
        return !isMain; // a subagent file needs no further reading; the main file is read on for the start marker
      }
      const t = timeOf(obj);
      if (isMain && obj?.attachment?.type === 'hook_success' && typeof obj.attachment.hookName === 'string' && obj.attachment.hookName.startsWith('SessionStart:')
        && obj.sessionId === sessionId && t >= lo && t <= birthMs + START_WINDOW_AFTER_MS && (first === null || t < first.t)) {
        first = { t, hook: obj.attachment.hookName };
      }
      if (active !== null) return !isMain;
      if (obj?.type === 'api-request-blob') return false; // a timestamp-less copy of the request payload (the whole history so far), not an event
      const finite = Number.isFinite(t);
      if (finite && (t < lo || t > decidedMs)) return false;
      const why = unexplained(obj, { strict: !finite, platform });
      if (why !== null) {
        active = `${why} at ${finite ? new Date(t).toISOString() : 'an unknown time'} in ${path.basename(f)}`;
        return !isMain;
      }
      return false;
    });
  };
  try {
    scan(file, true);
    if (first === null) return unknown('no start marker of this process in its transcript');
    if (first.hook !== 'SessionStart:startup' && first.hook !== 'SessionStart:resume') return unknown(`started by /clear or /compact (${first.hook}): an earlier transcript of this process cannot be found`);
    for (const f of subs.files) {
      if (active !== null) break;
      scan(f, false);
    }
  } catch (err) {
    return unknown(`cannot read ${file}: ${err?.code ?? shortMsg(err)}`);
  }
  if (active !== null) return ok({ verdict: 'active', file, why: active });
  return ok({ verdict: 'quiet', file, why: `start ${first.hook} at ${new Date(first.t).toISOString()}; only read-only inspection until the decision` });
}

// ---------------------------------------------------------------- C4 consumer worktrees

// Sessions whose Bash tool call names the stack with --workdir: each such line's cwd. -> { cwds } | unknown.
function transcriptCwds(stack, { dirs, sinceMs, fsx, spellings, notes, platform }) {
  const exp = expandTranscriptDirs(dirs, { fsx, platform });
  if (!exp.ok) return exp;
  const listed = transcriptFilesStrict(exp.value, sinceMs, fsx, notes);
  if (listed.fail !== undefined || listed.ok === false) return listed;
  const { patterns, dirs: wdirs } = matchers(stack, { ports: false, spellings });
  const named = patterns.filter((p) => p.name === 'folder' || p.name === 'workdir');
  if (named.length === 0) return { cwds: [] };
  const needle = new RegExp(named.map((p) => p.re.source).join('|'), 'i');
  const cwds = new Set();
  for (const file of listed.files) {
    try {
      let bad = null;
      scanLines(fsx, file, (line) => {
        if (!line.includes('--workdir') || !needle.test(line)) return false;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          bad = `${file}: a line naming the stack is not valid JSON`;
          return true;
        }
        const blocks = [obj?.message?.content, obj?.content].filter(Array.isArray).flat();
        const hit = blocks.some((b) => b?.type === 'tool_use' && typeof b.input?.command === 'string' && b.input.command.includes('--workdir') && needle.test(b.input.command));
        if (hit && typeof obj.cwd === 'string' && obj.cwd !== '') cwds.add(obj.cwd);
        return false;
      });
      if (bad) return unknown(bad);
    } catch (err) {
      if (isGone(err)) continue;
      return unknown(`cannot read ${file}: ${err?.code ?? shortMsg(err)}`);
    }
  }
  return { cwds: [...cwds], wdirs };
}

// A directory too broad to be "a consumer of this stack": `/`, `/Users`, a home directory (fewer than 3 path segments, like
// dev.mjs usableRoots) or the home itself. Every process on the machine is inside one of those, so it would keep every stack
// alive forever. -> a reason string, or null when the directory is specific enough.
export function tooBroadDir(dir, { home = os.homedir(), platform = process.platform } = {}) {
  const segs = String(dir).replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length < 3) return 'fewer than 3 path segments';
  if (home && samePath(dir, home, platform)) return 'the home directory';
  return null;
}

const PORT_ENV_RE = (ports) => new RegExp(`(?:127\\.0\\.0\\.1|localhost):(?:${ports.join('|')})(?!\\d)`);

export function consumerWorktrees(stack, {
  events = [], transcripts = null, repos = [], platform = process.platform, listWorktrees = realListWorktrees, fsx = fs, spellings = pathSpellings,
  home: homeDir = os.homedir(),
} = {}) {
  if (platform === 'win32') return WINDOWS();
  const notes = [];
  // worktrees of every configured repo (once)
  const known = [];
  for (const repo of repos) {
    try {
      for (const w of listWorktrees(repo)) if (w?.path && !w.bare) known.push({ ...w, repo });
    } catch (err) {
      return unknown(`cannot list worktrees of ${repo}: ${shortMsg(err)}`);
    }
  }
  const byPath = new Map();
  const add = (p, via, branch = null) => {
    const key = [...byPath.keys()].find((k) => samePath(k, p, platform));
    if (key) { byPath.get(key).vias.add(via); return; }
    byPath.set(p, { path: p, branch, via, vias: new Set([via]) });
  };
  const knownAt = (p) => known.find((w) => samePath(w.path, p, platform));
  // (a) ledger
  const ledger = [];
  for (const e of events ?? []) {
    if (e?.kind !== 'use') continue;
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
    if (!(same(e.project, stack?.project) || (stack?.folder && e.folder === stack.folder) || (stack?.workdir && e.workdir === stack.workdir))) continue;
    if (typeof e.worktree === 'string' && e.worktree !== '' && e.worktree !== 'none') ledger.push(e.worktree);
  }
  for (const p of ledger) add(p, 'ledger', knownAt(p)?.branch ?? null);
  // (a) transcript backfill
  if (transcripts?.dirs?.length) {
    const t = transcriptCwds(stack, { dirs: transcripts.dirs, sinceMs: transcripts.sinceMs ?? 0, fsx, spellings, notes, platform });
    if (t.fail !== undefined || t.ok === false) return t;
    for (const cwd of t.cwds) {
      if (stack?.workdir && isInside(cwd, stack.workdir, platform)) continue;
      const home = known.filter((w) => isInside(cwd, w.path, platform)).sort((a, b) => b.path.length - a.path.length)[0];
      // a cwd in no known worktree is only a guess at where the session worked, so it is not a consumer: a shell in some other
      // directory (an ancestor of the stack folder, `/`, the home directory, a notes folder) would keep the stack alive for nothing.
      // The too-broad / ancestor notes say why the common cases were dropped; any other outside cwd gets the generic note.
      const broad = home ? null : tooBroadDir(cwd, { home: homeDir, platform });
      const ancestor = !home && stack?.workdir && !samePath(cwd, stack.workdir, platform) && isInside(stack.workdir, cwd, platform);
      if (broad || ancestor) {
        notes.push(`transcript cwd ${JSON.stringify(cwd)} dropped as a consumer: ${broad ?? 'it is an ancestor of the stack folder'}`);
        continue;
      }
      if (!home) {
        notes.push(`transcript cwd ${JSON.stringify(cwd)} dropped as a consumer: it is in no known worktree of a configured repo`);
        continue;
      }
      add(home.path, 'transcript', home.branch ?? null);
    }
  }
  // (b) .env* at the root of every worktree of a configured repo
  const ports = [...new Set(stack?.ports ?? [])];
  if (ports.length) {
    const re = PORT_ENV_RE(ports);
    for (const w of known) {
      if (w.prunable) continue;
      let names;
      try {
        names = fsx.readdirSync(w.path, { withFileTypes: true });
      } catch (err) {
        if (isGone(err)) continue; // the directory is gone: nothing there can point at the stack
        return unknown(`cannot read ${w.path}: ${err?.code ?? shortMsg(err)}`);
      }
      for (const e of names.filter((x) => x.name.startsWith('.env') && !x.isDirectory())) {
        let body;
        try {
          body = fsx.readFileSync(path.join(w.path, e.name), 'utf8');
        } catch (err) {
          return unknown(`cannot read ${path.join(w.path, e.name)}: ${err?.code ?? shortMsg(err)}`);
        }
        if (re.test(body)) { add(w.path, 'env', w.branch ?? null); break; }
      }
    }
  }
  const value = [...byPath.values()].map((w) => {
    // true / false / null (unknown): only ENOENT/ENOTDIR prove the directory is gone; EACCES, EIO ... prove nothing
    let exists = false;
    try { exists = fsx.statSync(w.path).isDirectory(); } catch (err) { exists = isGone(err) ? false : null; }
    return { path: w.path, exists, branch: w.branch, via: w.via };
  });
  return { ok: true, value, notes };
}

// ---------------------------------------------------------------- PR state per consumer worktree

const SHA_RE = /^[0-9a-f]{40}$/;

function pickPr(prs, head) {
  const sorted = prs.map((p, i) => ({ p, i, t: Date.parse(p.createdAt) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.p);
  const open = sorted.filter((p) => p.state === 'OPEN');
  if (open.length) return { state: 'OPEN', headMatches: open.some((p) => p.headRefOid === head) };
  const matching = sorted.filter((p) => p.headRefOid === head);
  if (matching.length) return { state: matching[matching.length - 1].state, headMatches: true };
  if (sorted.length) return { state: sorted[sorted.length - 1].state, headMatches: false };
  return { state: 'NONE', headMatches: false };
}

// ok(Map<path, { state: 'OPEN'|'MERGED'|'CLOSED'|'NONE'|'GONE', headMatches, eligible }>) | unknown.
// `eligible` = the worktree no longer exists (GONE; no lookup is made) or its PR is MERGED/CLOSED with HEAD == the PR head.
// Any single worktree that cannot be judged (detached HEAD, repository mismatch, incomplete PR pages) makes the whole answer unknown.
export function prStates(worktrees, { ghFor = (cwd) => createGitHub({ cwd }), git = realGit, platform = process.platform } = {}) {
  if (platform === 'win32') return WINDOWS();
  const out = new Map();
  const repos = new Map(); // git common dir -> { gh }
  for (const w of worktrees ?? []) {
    if (w.exists === false) {
      out.set(w.path, { state: 'GONE', headMatches: true, eligible: true });
      continue;
    }
    if (w.exists === null) return unknown(`cannot tell whether ${w.path} exists (its status could not be read)`);
    let branch;
    let head;
    let origin;
    let common;
    try {
      branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: w.path }).trim();
      head = git(['rev-parse', 'HEAD'], { cwd: w.path }).trim();
      origin = git(['remote', 'get-url', 'origin'], { cwd: w.path }).trim();
      common = path.resolve(w.path, git(['rev-parse', '--git-common-dir'], { cwd: w.path }).trim());
    } catch (err) {
      return unknown(`cannot read git state of ${w.path}: ${shortMsg(err)}`);
    }
    if (branch === '' || branch === 'HEAD') return unknown(`${w.path} has a detached HEAD: its PR cannot be looked up`);
    if (!SHA_RE.test(head)) return unknown(`${w.path} HEAD is not a 40-character sha`);
    let repo = repos.get(common);
    if (!repo) {
      const gh = ghFor(w.path);
      const identity = checkRepoIdentity(gh, origin);
      if (!identity.ok) return unknown(identity.reason);
      repo = { gh };
      repos.set(common, repo);
    }
    const found = fetchBranchPrs(repo.gh, branch);
    if (!found.ok) return unknown(found.reason);
    if (found.prs.some((p) => !['OPEN', 'MERGED', 'CLOSED'].includes(p.state) || !Number.isFinite(Date.parse(p.createdAt)) || !SHA_RE.test(String(p.headRefOid)))) {
      return unknown(`unexpected pull request data for ${branch}`);
    }
    const picked = pickPr(found.prs, head);
    out.set(w.path, { ...picked, eligible: (picked.state === 'MERGED' || picked.state === 'CLOSED') && picked.headMatches });
  }
  return ok(out);
}

// ---------------------------------------------------------------- memory notes

export function memoryRefs(stack, { dirs = [], exclude = [], readFile = (f, enc) => fs.readFileSync(f, enc), platform = process.platform, fsx = fs } = {}) {
  if (platform === 'win32') return WINDOWS();
  const { patterns } = matchers(stack, { ports: false, spellings: () => [] });
  const named = patterns.filter((p) => p.name === 'folder' || p.name === 'id');
  const skip = new Set(exclude);
  const hits = [];
  const notes = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fsx.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) { notes.push(`${dir} does not exist`); continue; }
      return unknown(`cannot read memory directory ${dir}: ${err?.code ?? shortMsg(err)}`);
    }
    for (const e of entries.filter((x) => x.name.endsWith('.md') && !skip.has(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(dir, e.name);
      let body;
      try {
        body = readFile(file, 'utf8');
      } catch (err) {
        return unknown(`cannot read memory note ${file}: ${err?.code ?? shortMsg(err)}`);
      }
      if (named.some((p) => p.re.test(String(body)))) hits.push(file);
    }
  }
  return { ok: true, value: hits, notes };
}
