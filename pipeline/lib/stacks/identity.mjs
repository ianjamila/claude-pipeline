// Process identity for stack-stop leases: { pid, birth }, birth = epoch seconds from `ps -o lstart=` run with TZ=UTC
// LC_ALL=C (a pid alone is not an identity: pids are reused). Everything answers ok | unknown; "no such process" is a
// POSITIVE finding, never an inference: run() reports a signalled child as exit 1 with empty output and a spawn failure
// as exit 1 plus the error text, so ps exit 1 alone proves nothing. procIdentity says "gone" (ok(null)) only when ps gave
// a clean exit 1 (no signal, no timeout, empty stdout AND stderr) and kill(pid, 0) independently throws ESRCH. Every other
// combination (signal, timeout, ENOENT text, EPERM, ps says gone but kill says alive) is unknown.
// The ancestry walk uses the injected `run` (not claude-ancestry's realLookup, which has a fixed 3 s and no budget) so a
// caller's deadline bounds every ps call; it reuses only isClaudeCodeProcess to decide what counts as Claude Code.
import { basename as pathBasename } from 'node:path';
import { run as realRun } from '../proc.mjs';
import { isClaudeCodeProcess } from '../claude-ancestry.mjs';
import { ok, unknown } from './result.mjs';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MAX_HOPS = 32;
const PS_TIMEOUT_MS = 3000; // cap per ps call
const NO_DEADLINE_IDENTITY_TIMEOUT_MS = 5000;
const MIN_REMAINING_MS = 500; // under this, a ps call is not worth starting
const DEFAULT_PS = '/bin/ps';
// Same runtime test claude-ancestry uses before it fetches a command line; only these need the second (args) lookup.
const RUNTIME = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i;

// `C`-locale lstart is `Mon Oct 19 02:47:17 2026` (day space-padded to two characters), in UTC because of TZ=UTC.
export function parseLstart(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text ?? '');
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]) / 1000;
}

// Fresh object per call; proc.mjs `run` merges it over process.env, so the parent's TZ / LC_ALL can never leak into ps.
const psEnv = () => ({ TZ: 'UTC', LC_ALL: 'C' });

// Timeout for the next ps call, or null when the deadline leaves too little time (then the caller answers unknown).
function budget(deadlineAt, now, cap) {
  if (deadlineAt === undefined || deadlineAt === null) return cap;
  const remaining = deadlineAt - now();
  return remaining < MIN_REMAINING_MS ? null : Math.min(PS_TIMEOUT_MS, remaining, cap);
}

const validPid = (pid) => Number.isInteger(pid) && pid > 0;
const defaultKill = (pid, sig) => process.kill(pid, sig);

export function procIdentity(pid, { run = realRun, kill = defaultKill, platform = process.platform, ps = DEFAULT_PS, deadlineAt, now = Date.now } = {}) {
  if (platform === 'win32') return unknown('windows');
  if (!validPid(pid)) return unknown(`bad pid ${JSON.stringify(pid)}`);
  const timeoutMs = budget(deadlineAt, now, NO_DEADLINE_IDENTITY_TIMEOUT_MS);
  if (timeoutMs === null) return unknown('deadline');
  const r = run(ps, ['-o', 'lstart=', '-p', String(pid)], { env: psEnv(), timeoutMs });
  if (r.timedOut) return unknown('ps timed out');
  if (r.signal) return unknown(`ps ended by signal ${r.signal}`);
  if (r.code === 0) {
    const text = String(r.stdout ?? '').trim();
    const birth = parseLstart(text);
    return birth === null ? unknown(`unparsable lstart ${JSON.stringify(text)}`) : ok({ pid, birth });
  }
  const silent = String(r.stdout ?? '').trim() === '' && String(r.stderr ?? '').trim() === '';
  if (r.code !== 1 || !silent) return unknown(`ps exit ${r.code}: ${String(r.stderr ?? '').trim()}`);
  // A clean "nothing printed, exit 1" is only half the proof: ask the kernel too.
  try {
    kill(pid, 0);
  } catch (err) {
    return err?.code === 'ESRCH' ? ok(null) : unknown(`kill(${pid}, 0): ${err?.code ?? err?.message}`);
  }
  return unknown(`ps found no process ${pid} but kill(${pid}, 0) says it is alive`);
}

// Alive only if the same process (same birth) is still there. A reused pid is "not alive" for the old owner.
export function isAlive(owner, opts = {}) {
  if (!owner || !validPid(owner.pid) || !Number.isFinite(owner.birth)) return unknown('owner has no usable pid and birth');
  const id = procIdentity(owner.pid, opts);
  if (!id.ok) return id;
  if (id.value === null) return ok(false);
  return ok(id.value.birth === owner.birth);
}

// One hop of the walk: { ppid, comm, args? } for `pid`, built on the injected run and the caller's deadline.
function lookupVia(pid, { run, ps, deadlineAt, now }) {
  const ask = (field) => {
    const timeoutMs = budget(deadlineAt, now, PS_TIMEOUT_MS);
    if (timeoutMs === null) return { reason: 'deadline' };
    const r = run(ps, ['-o', field, '-p', String(pid)], { env: psEnv(), timeoutMs });
    if (r.timedOut) return { reason: 'ps timed out' };
    if (r.signal) return { reason: `ps ended by signal ${r.signal}` };
    if (r.code !== 0) return { reason: `ps exit ${r.code} for pid ${pid}` };
    return { text: String(r.stdout ?? '').trim() };
  };
  const first = ask('ppid=,comm=');
  if (first.reason) return first;
  const m = /^(\d+)\s+(.+)$/.exec(first.text);
  if (!m) return { reason: `unparsable ps line for pid ${pid}` };
  const info = { ppid: Number(m[1]), comm: m[2].trim() };
  if (RUNTIME.test(pathBasename(info.comm))) {
    const second = ask('args=');
    if (second.reason) return second;
    info.args = second.text;
  }
  return { info };
}

// The nearest Claude Code process at or above `startPid` (the hook's parent by default), as { pid, birth }. Not found, a
// failed lookup, a cycle, more than 32 hops, the deadline, or Windows => unknown.
export function findClaudeOwner({ startPid = process.ppid, run = realRun, kill = defaultKill, platform = process.platform, ps = DEFAULT_PS, deadlineAt, now = Date.now, maxHops = MAX_HOPS } = {}) {
  if (platform === 'win32') return unknown('windows');
  const seen = new Set();
  let pid = startPid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) return unknown('no Claude Code process above the hook');
    seen.add(pid);
    const step = lookupVia(pid, { run, ps, deadlineAt, now });
    if (!step.info) return unknown(step.reason);
    if (isClaudeCodeProcess(step.info)) {
      const id = procIdentity(pid, { run, kill, platform, ps, deadlineAt, now });
      if (!id.ok) return id;
      return id.value === null ? unknown(`Claude Code process ${pid} exited while it was being identified`) : id;
    }
    pid = step.info.ppid;
  }
  return unknown(`no Claude Code process within ${maxHops} hops`);
}
