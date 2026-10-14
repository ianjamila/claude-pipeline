// Owner push notifications: one push per terminal event of a ship run, to the owner's phone/Mac through ntfy and, on a
// WSL2 PC, a Windows toast. Design: docs/plans/2026-10-12-owner-push-notify.md (v2 + v3 amendments).
//
// Rules this module keeps:
// - It NEVER throws from notifyEvent and never changes the exit code of the command that calls it. A push is a courtesy;
//   losing one must not turn a green run red.
// - The topic/token live only in the environment or ~/.config/claude-secrets.sh (a PUBLIC repo must not carry them).
//   That file is parsed as literal assignments, never sourced. No secret reaches the ledger, a result or stderr.
// - One push per event: a reservation in a ledger (under a machine lock) makes a replay a no-op; a delivery that was
//   acknowledged is never repeated, an ambiguous or failed one may be retried.
// - Everything is bounded (hard cap 15 s) and every effect (fetch, spawn, gh, git, clock, fs dirs) is injectable.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { withLock } from './locks.mjs';
import { run as runProc, runAsync, overrideCommand } from './proc.mjs';

// ---- outcome -> event ---------------------------------------------------------------------------------------------------
// `pipeline summary --outcome <word>` -> the event pushed for it, or null for "no push" (prod-watch pushed already, or the
// owner is the one who ended it). A word that is not a key here is unclassified: no push, and the caller says so.
export const OUTCOME_EVENTS = Object.freeze({
  'awaiting-owner-merge': 'owner-merge',
  'needs-human': 'needs-human', // the caller upgrades it to 'arbiter-escalation' when the review state says so
  blocked: 'stopped',
  'awaiting-review': 'stopped',
  stopped: 'stopped',
  merged: null,
  'no-production': null,
  closed: null,
  'merged-externally': null,
  'prod-unknown': null, // prod-watch exited with no outcome; it already pushed "Production check unfinished"
  superseded: null,
  recovered: null,
  'rollback-failed': null,
  'changed-during-recovery': null,
  'rollback-skipped': null,
  'not-live': null,
  'deploy-failed': null,
  'deploy-not-observed': null,
  'needs-owner': null, // an observe-only prod-watch (ship resume) pushed it already
});

// { known, event } for a summary outcome word. Unknown words are known:false, event:null.
export function classifyOutcome(word) {
  if (typeof word !== 'string' || !Object.hasOwn(OUTCOME_EVENTS, word)) return { known: false, event: null };
  return { known: true, event: OUTCOME_EVENTS[word] };
}

// The one thing to do for each push event when the caller gave no --action.
export function defaultAction(event, { head, ids = [], reason } = {}) {
  const h = head ? String(head).slice(0, 7) : '';
  switch (event) {
    case 'owner-merge':
      return `Check the listed items, then say "merge"${h ? ` for head ${h}` : ''}`;
    case 'arbiter-escalation':
      return ids.length ? `Rule on ${ids.join(', ')} in the triage comment` : 'Rule on the escalated items in the triage comment';
    case 'needs-human':
      return 'Read the needs-human comment and decide';
    default:
      return reason ? `Read the PR: ${reason}` : 'Read the PR: the run stopped';
  }
}

const EVENTS = Object.freeze({
  'owner-merge': { label: 'Ready to merge', priority: 4, tag: 'white_check_mark' },
  'needs-human': { label: 'Needs you', priority: 4, tag: 'raising_hand' },
  'arbiter-escalation': { label: 'Arbiter escalation', priority: 4, tag: 'scales' },
  stopped: { label: 'Run stopped', priority: 4, tag: 'octagonal_sign' },
  'prod-unknown': { label: 'Production check unfinished', priority: 4, tag: 'question' },
  worktrees: { label: 'Worktree cleanup', priority: 3, tag: 'broom' },
  test: { label: 'Test', priority: 3, tag: 'bell' },
});

// ---- production events --------------------------------------------------------------------------------------------------
const PROD_PRIORITY = Object.freeze({
  merged: 3,
  superseded: 4,
  'not-live': 4,
  'deploy-failed': 4,
  'deploy-not-observed': 4,
  recovered: 4,
  'rollback-failed': 5,
  'changed-during-recovery': 5,
  'rollback-skipped': 5,
  'needs-owner': 5,
});
const PROD_LABEL = Object.freeze({
  merged: 'Production OK',
  superseded: 'Production superseded',
  'not-live': 'Production not live',
  'deploy-failed': 'Deploy failed',
  'deploy-not-observed': 'Deploy not observed',
  recovered: 'Rolled back',
  'rollback-failed': 'ROLLBACK FAILED',
  'changed-during-recovery': 'PRODUCTION CHANGED',
  'rollback-skipped': 'ROLLBACK SKIPPED',
  'needs-owner': 'PRODUCTION FAILING',
});
// Outcomes whose rollback issue carries the label that pauses further agent merges.
const PAUSING = new Set(['recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped']);
const num = (a) => (a && Number.isInteger(Number(a.number)) && Number(a.number) > 0 ? Number(a.number) : null);

// The push for a prod-watch output object, or null when none is owed (`no-production`, unknown outcome).
// Wording is built only from artifacts that exist; a missing issue is never read as "merges are not paused".
export function prodEvent(output, { pr } = {}) {
  const outcome = output?.outcome;
  if (typeof outcome !== 'string' || !Object.hasOwn(PROD_PRIORITY, outcome)) return null;
  const prNumber = pr ?? output.pr ?? undefined;
  const issueN = num(output.issue);
  const revertN = num(output.revertPr);
  const sha = String(output.mergeSha ?? '');
  const target = prNumber ? `#${prNumber}` : (sha ? sha.slice(0, 7) : 'the merge');
  const issueNote = issueN
    ? ''
    : PAUSING.has(outcome)
      ? ' Rollback issue could not be confirmed — check whether merges are paused.'
      : ' The tracking issue could not be opened.';
  let action;
  switch (outcome) {
    case 'merged':
      action = 'Live and healthy — nothing to do.';
      break;
    case 'recovered': {
      const parts = ['Rolled back, prod healthy.'];
      if (revertN && issueN) parts.push(`Review revert PR #${revertN}; close issue #${issueN} to unpause merges.`);
      else if (revertN) parts.push(`Review revert PR #${revertN}.`);
      else parts.push(`Revert PR could not be opened — revert ${target} by hand or fix forward${issueN ? `; close issue #${issueN} after` : ''}.`);
      if (!issueN) parts.push('Rollback issue could not be confirmed — check whether merges are paused.');
      action = parts.join(' ');
      break;
    }
    case 'deploy-failed':
      action = `Deploy failed: open the deployment log, then fix forward or revert ${target}.${issueN ? ` Issue #${issueN} has the steps.` : ''}${issueNote}`;
      break;
    case 'deploy-not-observed':
      action = `Deploy was not observed: check Vercel for ${target}, run the smoke by hand or redeploy.${issueN ? ` Issue #${issueN}.` : ''}${issueNote}`;
      break;
    case 'not-live':
      action = `${target} is not what production serves: check the live deployment, promote it if it should be live.${issueN ? ` Issue #${issueN}.` : ''}${issueNote}`;
      break;
    case 'superseded':
      action = `A newer deploy replaced ${target}: confirm it has your fix, else fix forward or revert.${issueN ? ` Issue #${issueN}.` : ''}${issueNote}`;
      break;
    case 'rollback-failed':
      action = `Rollback FAILED, production may be unhealthy: check it now and roll back by hand.${issueN ? ` Issue #${issueN}.` : ''}${issueNote}`;
      break;
    case 'changed-during-recovery':
      action = `Production changed while rolling back: check which deployment is live and healthy now.${issueN ? ` Issue #${issueN}.` : ''}${issueNote}`;
      break;
    case 'needs-owner': // observe-only (ship resume): nothing was rolled back, and no issue is ever opened
      action = `Production fails the smoke after ${target} and nothing was rolled back (resumed run, observe only): check it now and roll back by hand if needed.`;
      break;
    default: // rollback-skipped
      action = `Rollback was skipped, production may be unhealthy: check it now.${issueN ? ` Issue #${issueN}.` : ''}${issueNote}`;
  }
  return {
    event: `prod-${outcome}`,
    label: PROD_LABEL[outcome],
    priority: PROD_PRIORITY[outcome],
    tag: PROD_PRIORITY[outcome] >= 5 ? 'rotating_light' : outcome === 'merged' ? 'rocket' : 'warning',
    pr: prNumber,
    head: sha || undefined,
    outcome,
    ids: [issueN ? `issue#${issueN}` : null, revertN ? `revert#${revertN}` : null].filter(Boolean),
    action,
    ...(issueN ? { issueNumber: issueN, issueUrl: output.issue?.url } : {}),
  };
}

// prod-watch ended with an error and no outcome (merge sha never resolved, deploy API kept failing).
export function prodErrorEvent({ error, reason, pr, head } = {}) {
  const why = String(reason ?? error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 120);
  const target = pr ? `#${pr}'s` : 'the merge\'s';
  return {
    event: 'prod-unknown',
    pr,
    head,
    outcome: 'prod-unknown',
    cause: String(error ?? 'unknown').slice(0, 60),
    action: `Production check couldn't finish (${why}): check ${target} deployment by hand`,
  };
}

// ---- config -------------------------------------------------------------------------------------------------------------
export const DEFAULT_SECRETS_FILE = path.join(os.homedir(), '.config', 'claude-secrets.sh');
const INVALID = Symbol('invalid');
const ASSIGN = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/;

// One assigned value: bare, '…' or "…", optionally followed by a `# comment`. Anything the shell would expand or treat
// as syntax ($, backtick, backslash, a bare ; & | < > ( ) quote) is INVALID for that key: we do not interpret it.
function parseValue(raw) {
  const s = raw.replace(/\r$/, '');
  if (s === '') return '';
  if (/^\s/.test(s)) return INVALID;
  let inner;
  let rest;
  if (s[0] === "'" || s[0] === '"') {
    const end = s.indexOf(s[0], 1);
    if (end < 0) return INVALID;
    inner = s.slice(1, end);
    rest = s.slice(end + 1);
  } else {
    const m = /^(\S*)(.*)$/.exec(s);
    inner = m[1];
    rest = m[2];
    if (/[;&|<>()'"]/.test(inner)) return INVALID;
  }
  if (rest.trim() !== '' && !/^\s+#/.test(rest)) return INVALID;
  if (/[$`\\]/.test(inner)) return INVALID;
  return inner;
}

// Literal assignments in a secrets file -> Map(name -> string | INVALID). The last assignment of a name wins.
export function parseSecrets(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = ASSIGN.exec(line.replace(/\r$/, '')); // `.` does not match \r, so a CRLF file needs it gone first
    if (m) out.set(m[1], parseValue(m[2]));
  }
  return out;
}

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const MACHINE_RE = /^[A-Za-z0-9 _.-]{1,20}$/;
const DEFAULT_SERVER = 'https://ntfy.sh';

function validServer(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost');
  if (!ok || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}` || u.origin;
}

// { ok:true, topic, server, token } | { ok:false, reason }. Per field: the environment first, then the file. A field that
// is present but invalid stops the send (never a fallback to another server or a looser value). A blank topic or token
// counts as unset; a blank server does not (the default applies only when NTFY_SERVER is unset everywhere). The optional
// NTFY_MACHINE (the label shown in the title) is read the same way but is cosmetic: an invalid value is dropped
// (`machineInvalid: true`) and never stops the send.
export function loadNotifyConfig({ env = process.env, secretsFile, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (String(env.PIPELINE_NOTIFY ?? '').toLowerCase() === 'off') return { ok: false, reason: 'disabled' };
  const file = secretsFile ?? env.PIPELINE_SECRETS_FILE ?? DEFAULT_SECRETS_FILE;
  let fromFile = new Map();
  try {
    fromFile = parseSecrets(readFile(file));
  } catch {
    /* no file: the environment may still say it all */
  }
  const pick = (name) => {
    const e = env[name];
    if (e !== undefined && e !== '') return e;
    const f = fromFile.get(name);
    return f === undefined || f === '' ? undefined : f;
  };
  const topic = pick('NTFY_TOPIC');
  // The server is the one field where blank is NOT "unset": a present value (even blank) wins and must be valid, so a
  // typo'd `NTFY_SERVER=` can never silently route the push to the public default.
  const rawServer = env.NTFY_SERVER !== undefined ? env.NTFY_SERVER : fromFile.get('NTFY_SERVER');
  const token = pick('NTFY_TOKEN');
  if (topic === INVALID || (topic !== undefined && !TOPIC_RE.test(topic))) return { ok: false, reason: 'invalid-config:topic' };
  if (topic === undefined && rawServer === undefined && token === undefined) return { ok: false, reason: 'no-topic' };
  let server = DEFAULT_SERVER;
  if (rawServer !== undefined) {
    server = rawServer === INVALID ? null : validServer(rawServer);
    if (!server) return { ok: false, reason: 'invalid-config:server' };
  }
  if (token === INVALID || (token !== undefined && !TOKEN_RE.test(token))) return { ok: false, reason: 'invalid-config:token' };
  if (topic === undefined) return { ok: false, reason: 'no-topic' };
  const rawMachine = pick('NTFY_MACHINE');
  const machineInvalid = rawMachine !== undefined && (rawMachine === INVALID || !MACHINE_RE.test(rawMachine));
  return { ok: true, topic, server, token, ...(rawMachine !== undefined && !machineInvalid ? { machine: rawMachine } : {}), ...(machineInvalid ? { machineInvalid: true } : {}) };
}

// Which machine the run is on: Mac (darwin), PC (WSL or Windows), otherwise the sanitized hostname.
export function machineLabel({ platform = process.platform, wsl = false, hostname = () => os.hostname() } = {}) {
  if (platform === 'darwin') return 'Mac';
  if (wsl || platform === 'win32') return 'PC';
  let h = '';
  try { h = String(hostname() ?? ''); } catch { /* fall through */ }
  h = h.trim().replace(/[^A-Za-z0-9 _.-]+/g, '-').slice(0, 20).trim();
  return h || 'unknown';
}

// Replace every secret (and the server path) with *** in text that may be surfaced.
export function scrubber({ topic, token, server } = {}) {
  const needles = new Set();
  if (topic) needles.add(topic);
  if (token) needles.add(token);
  if (server) {
    needles.add(server);
    try {
      const p = new URL(server).pathname.replace(/\/+$/, '');
      if (p.length > 1) needles.add(p);
    } catch { /* not a URL */ }
  }
  const list = [...needles].sort((a, b) => b.length - a.length);
  return (text) => {
    let s = String(text ?? '');
    for (const n of list) s = s.split(n).join('***');
    return s;
  };
}

// ---- message ------------------------------------------------------------------------------------------------------------
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// `machine` is the "[Mac]" prefix; the whole title is clipped to 80 characters, so the label is never cut away.
export function buildTitle(pr, title, machine) {
  const t = clean(title);
  const prefix = machine ? `[${machine}] ` : '';
  if (!pr) return clip(`${prefix}${t || 'Pipeline'}`, 80);
  return clip(`${prefix}${t ? `#${pr} ${t}` : `#${pr}`}`, 80);
}

// -> { title, message, priority, tags, click? }. Body: "<label>: <action> [items: ids] (repo)", at most 300 characters.
export function buildMessage(ev, { repoName, click, machine } = {}) {
  const def = EVENTS[ev.event] ?? {};
  const label = ev.label ?? def.label ?? ev.event;
  const ids = (ev.ids ?? []).filter((i) => !/^(issue|revert)#/.test(i));
  const suffix = repoName ? ` (${repoName})` : '';
  let head = `${label}: ${clean(ev.action)}${ids.length ? ` [items: ${ids.join(', ')}]` : ''}`;
  if (head.length + suffix.length > 300) head = `${head.slice(0, 300 - suffix.length - 1)}…`;
  const tags = [ev.tag ?? def.tag, repoName && repoName.replace(/[^A-Za-z0-9_-]/g, '')].filter(Boolean);
  return {
    title: buildTitle(ev.pr, ev.title, machine),
    message: head + suffix,
    priority: ev.priority ?? def.priority ?? 4,
    tags,
    ...(click ? { click } : {}),
  };
}

// ---- identity -----------------------------------------------------------------------------------------------------------
// sha256 of repo | pr | event | head | outcome | sorted needs-human ids | cause. Never the action text: a reworded retry of
// the same stop must not push twice.
export function eventKey(ev, { repo, head }) {
  const parts = [repo ?? '', ev.pr ?? '', ev.event, head ?? '', ev.outcome ?? '', [...(ev.ids ?? [])].sort().join(','), ev.cause ?? ''];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// owner/name (and host) from a remote URL: https, ssh:// and scp-like (git@host:owner/name.git) forms.
export function parseRemote(url) {
  const s = String(url ?? '').trim();
  let host;
  let p;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    host = scp[1];
    p = scp[2];
  } else {
    try {
      const u = new URL(s);
      host = u.hostname;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  const segs = p.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[segs.length - 2];
  const name = segs[segs.length - 1];
  return { host, owner, name, slug: `${owner}/${name}` };
}

// ---- ledger -------------------------------------------------------------------------------------------------------------
export const LEDGER_NAME = 'notify-ledger.jsonl';
export const RESERVATION_STALE_MS = 2 * 60_000;
export const LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
export const defaultStateDir = () => path.join(os.homedir(), '.claude', 'pipeline-state');

// -> { records, dirty } : parsed records, with corrupt lines skipped (dirty) and records past 90 days dropped (dirty).
function readLedger(file, nowMs) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: [], dirty: false };
  }
  const records = [];
  let dirty = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      dirty = true;
      continue;
    }
    const t = Date.parse(r?.t);
    if (!r || typeof r.key !== 'string' || typeof r.kind !== 'string' || !Number.isFinite(t)) {
      dirty = true;
      continue;
    }
    if (nowMs - t > LEDGER_MAX_AGE_MS) {
      dirty = true;
      continue;
    }
    records.push(r);
  }
  return { records, dirty };
}

function rewriteLedger(file, records) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) prefix = '\n'; // a torn last line: keep ours on its own line
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* no file yet */ }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// Has this key been delivered (ntfy acknowledged) or is a send in flight?
function keyState(records, key, nowMs) {
  let sent = false;
  let inflightSince = null;
  for (const r of records) {
    if (r.key !== key) continue;
    if (r.kind === 'reserved') inflightSince = Date.parse(r.t);
    else if (r.kind === 'ntfy') {
      if (r.status === 'sent') sent = true;
      inflightSince = null;
    }
  }
  if (sent) return 'sent';
  if (inflightSince !== null && nowMs - inflightSince < RESERVATION_STALE_MS) return 'in-flight';
  return 'free';
}

// ---- transports ---------------------------------------------------------------------------------------------------------
// Resolves the value of `promise`, or `fallback` after ms (the promise is abandoned, never awaited again).
function within(promise, ms, fallback) {
  let timer;
  const t = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([Promise.resolve(promise), t]).finally(() => clearTimeout(timer));
}

// Node's happy-eyeballs gives each resolved address only 250 ms (net.getDefaultAutoSelectFamilyAttemptTimeout()). Measured on
// the owner's WSL2 PC (Node 24.21) that failed ~4 of 5 real publishes with ETIMEDOUT after ~282 ms; 2500 ms succeeded 5/5.
// The pipeline CLI is a short-lived process, so raising the process-wide default is acceptable. It only ever raises, and is a
// no-op on a Node without the API (engines >=20). get/set are injectable for the test.
export const MIN_ATTEMPT_TIMEOUT_MS = 2500;
export function raiseAutoSelectFamilyTimeout({ get = net.getDefaultAutoSelectFamilyAttemptTimeout, set = net.setDefaultAutoSelectFamilyAttemptTimeout, minMs = MIN_ATTEMPT_TIMEOUT_MS } = {}) {
  if (typeof get !== 'function' || typeof set !== 'function') return false;
  try {
    const cur = get();
    if (typeof cur === 'number' && cur >= minMs) return false;
    set(minMs);
    return true;
  } catch {
    return false;
  }
}

// One retry on a network-level failure (fetch rejected) when at least this much of the ntfy budget remains.
const RETRY_MIN_REMAINING_MS = 1000;

async function sendNtfy({ cfg, push, fetchFn, timeoutMs, signal, nowFn = () => Date.now() }) {
  const controller = new AbortController();
  const onCap = () => controller.abort();
  signal?.addEventListener('abort', onCap, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = nowFn();
  const body = {
    topic: cfg.topic,
    title: push.title,
    message: push.message,
    priority: push.priority,
    tags: push.tags,
    ...(push.click ? { click: push.click, actions: [{ action: 'view', label: 'Open', url: push.click }] } : {}),
  };
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const remaining = Math.max(1, timeoutMs - (nowFn() - startedAt));
        const res = await within(
          fetchFn(cfg.server, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }),
          remaining,
          'timeout',
        );
        if (res === 'timeout') return { status: 'failed', detail: 'timed out' };
        // Any HTTP response is final: a 4xx/5xx is never retried.
        if (!res?.ok) return { status: 'failed', detail: `HTTP ${res?.status ?? '?'}` };
        return { status: 'sent' };
      } catch (err) {
        const left = timeoutMs - (nowFn() - startedAt);
        if (attempt >= 2 || controller.signal.aborted || left < RETRY_MIN_REMAINING_MS) {
          return { status: 'failed', detail: String(err?.message ?? err) };
        }
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCap);
    controller.abort();
  }
}

// The Windows toast script is a CONSTANT. The title/body/url travel as base64 UTF-8 JSON on stdin and are XML-escaped
// inside it, so no notification text is ever spliced into PowerShell source or toast XML.
export const TOAST_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$d = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)) | ConvertFrom-Json',
  '$t = [System.Security.SecurityElement]::Escape([string]$d.title)',
  '$b = [System.Security.SecurityElement]::Escape([string]$d.body)',
  '$u = [System.Security.SecurityElement]::Escape([string]$d.url)',
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$launch = ''",
  "if ($u) { $launch = ' activationType=\"protocol\" launch=\"' + $u + '\"' }",
  "$xml = '<toast' + $launch + '><visual><binding template=\"ToastGeneric\"><text>' + $t + '</text><text>' + $b + '</text></binding></visual></toast>'",
  '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$doc.LoadXml($xml)',
  '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_AUMID}').Show($toast)`,
].join('\n');

export const encodeToastScript = (script = TOAST_SCRIPT) => Buffer.from(script, 'utf16le').toString('base64');
export const toastArgs = () => ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeToastScript()];
export const toastPayload = ({ title, body, url }) => Buffer.from(JSON.stringify({ title, body, url: url ?? '' }), 'utf8').toString('base64');

export function detectWsl({ env = process.env, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFile('/proc/version'));
  } catch {
    return false;
  }
}

export function findOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return path.join(dir, name);
    } catch { /* not here */ }
  }
  return null;
}

async function sendToast({ push, spawnFn, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    let stderr = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCap);
      resolve(r);
    };
    const kill = () => {
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const onCap = () => {
      kill();
      finish({ status: 'failed', detail: 'cancelled' });
    };
    try {
      child = spawnFn('powershell.exe', toastArgs(), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      finish({ status: 'failed', detail: String(err?.message ?? err) });
      return;
    }
    signal?.addEventListener('abort', onCap, { once: true });
    timer = setTimeout(() => {
      kill();
      finish({ status: 'failed', detail: 'timed out' });
    }, timeoutMs);
    child.stderr?.on?.('data', (c) => { if (stderr.length < 500) stderr += String(c); });
    child.stdin?.on?.('error', () => {});
    child.on('error', (err) => finish({ status: 'failed', detail: String(err?.message ?? err) }));
    child.on('close', (code) => finish(code === 0 ? { status: 'sent' } : { status: 'failed', detail: `exit ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` }));
    try {
      child.stdin.end(toastPayload({ title: clean(push.title), body: clean(push.message), url: /^https:\/\//.test(push.click ?? '') ? push.click : '' }));
    } catch { /* the close/error handlers settle it */ }
  });
}

// ---- runner -------------------------------------------------------------------------------------------------------------
export const BUDGET = Object.freeze({ lookupMs: 3000, lockMs: 1000, ntfyMs: 5000, toastMs: 8000, capMs: 15000 });

const LOOKUP_KILL_SLACK_MS = 500;

async function defaultLookup(pr, { cwd, env, timeoutMs }) {
  const { cmd, prefixArgs } = overrideCommand('PIPELINE_GH', 'gh', env);
  const r = await runAsync(cmd, [...prefixArgs, 'pr', 'view', String(pr), '--json', 'title,url'], { cwd, env, timeoutMs });
  if (r.code !== 0 || r.timedOut) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { title: typeof j.title === 'string' ? j.title : undefined, url: typeof j.url === 'string' ? j.url : undefined };
  } catch {
    return null;
  }
}

const defaultGit = (args, { cwd }) => {
  const r = runProc('git', args, { cwd, timeoutMs: 2000 });
  return r.code === 0 ? r.stdout.trim() : '';
};

// Sends one push for `event` ({event, pr?, title?, action, cause?, outcome?, ids?, head?, ...}); never throws.
// -> { sent, reason?, transports: {ntfy, toast}, errors?, ledger? }
export async function notifyEvent(event, deps = {}) {
  const transports = { ntfy: 'n/a', toast: 'n/a' };
  const errors = {};
  const out = (extra) => ({ sent: transports.ntfy === 'sent' || transports.toast === 'sent', transports, ...(Object.keys(errors).length ? { errors } : {}), ...extra });
  const budget = { ...BUDGET, ...(deps.budget ?? {}) };
  const cap = new AbortController();
  let capTimer;
  let scrub = (s) => String(s);
  const timedOut = new Promise((resolve) => {
    capTimer = setTimeout(() => {
      cap.abort();
      resolve(out({ reason: 'timeout' }));
    }, budget.capMs);
  });
  try {
    const inner = runNotify(event, deps, { transports, errors, budget, signal: cap.signal, out, setScrub: (s) => { scrub = s; } });
    inner.catch(() => {}); // a late rejection after the cap already answered must not be unhandled
    return await Promise.race([inner, timedOut]);
  } catch (err) {
    return { sent: false, reason: 'error', transports, errors: { internal: scrub(err?.message ?? err).slice(0, 200) } };
  } finally {
    clearTimeout(capTimer);
  }
}

async function runNotify(event, deps, { transports, errors, budget, signal, out, setScrub }) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const cwd = deps.cwd ?? process.cwd();
  // Only the real transport needs the slow-network tolerance; a test that injects fetch never touches the process default.
  if (!deps.fetch) raiseAutoSelectFamilyTimeout();
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const git = deps.git ?? defaultGit;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const lockDir = deps.lockDir ?? path.join(stateDir, 'locks');
  const ledgerFile = path.join(stateDir, LEDGER_NAME);

  if (!event || typeof event.event !== 'string' || !(event.event in EVENTS || event.event.startsWith('prod-'))) {
    return out({ reason: 'unknown-event' });
  }
  const cfg = loadNotifyConfig({ env, secretsFile: deps.secretsFile, readFile: deps.readFile });
  if (!cfg.ok) return out({ reason: cfg.reason });
  const scrub = scrubber(cfg);
  setScrub(scrub);

  // Identity comes from local git only (no GitHub call), so it is the same offline, online and across worktrees.
  const remote = parseRemote(git(['remote', 'get-url', 'origin'], { cwd }));
  const repoSlug = remote?.slug ?? '';
  const repoName = remote?.name ?? path.basename(cwd);
  const head = event.head ?? git(['rev-parse', 'HEAD'], { cwd });
  const key = eventKey(event, { repo: repoSlug, head });
  const ts = () => new Date(now()).toISOString();
  const rec = (kind, status) => ({ t: ts(), key, kind, status, event: event.event, pr: event.pr ?? null, repo: repoSlug });

  // 1. Reserve. A held or broken lock never costs the alert: send anyway and say the ledger was bypassed.
  let ledger;
  try {
    const decision = await withLock('notify-ledger', () => {
      const { records, dirty } = readLedger(ledgerFile, now());
      const state = keyState(records, key, now());
      if (state !== 'free') return state;
      if (dirty) rewriteLedger(ledgerFile, records);
      appendRecord(ledgerFile, rec('reserved'));
      return 'free';
    }, { dir: lockDir, waitMs: budget.lockMs, pollMs: 25 });
    if (decision !== 'free') return out({ reason: 'duplicate' });
  } catch {
    ledger = 'unlocked';
  }

  const record = async (kind, status) => {
    try {
      await withLock('notify-ledger', () => appendRecord(ledgerFile, rec(kind, status)), { dir: lockDir, waitMs: budget.lockMs, pollMs: 25 });
    } catch {
      try { appendRecord(ledgerFile, rec(kind, status)); } catch { ledger = 'unrecorded'; }
    }
  };

  // 2. Title/URL: only when the caller has no title (a test or an offline summary passes it, or none at all).
  let title = event.title;
  let url = event.url;
  if (!title && event.pr && !event.test) {
    const lookup = deps.lookup ?? defaultLookup;
    // The lookup as a whole stays within budget.lookupMs. The default lookup kills its own process TREE a little earlier
    // (proc.mjs killTree: taskkill /T /F on Windows); the outer race is only a net for an injected lookup that hangs. If
    // both fired together the push would carry on (and the command exit) while the killed gh still held its cwd.
    const killMs = budget.lookupMs - Math.min(LOOKUP_KILL_SLACK_MS, Math.floor(budget.lookupMs / 5));
    const found = await within(Promise.resolve().then(() => lookup(event.pr, { cwd, env, timeoutMs: killMs })).catch(() => null), budget.lookupMs, null);
    title = found?.title;
    url ??= found?.url;
  }
  const web = remote ? `https://${remote.host}/${remote.slug}` : null;
  if (!url && web && event.pr) url = `${web}/pull/${event.pr}`;
  if (event.issueNumber && web) url = event.issueUrl && /^https:\/\//.test(event.issueUrl) ? event.issueUrl : `${web}/issues/${event.issueNumber}`;
  const wsl = deps.isWsl ? deps.isWsl() : detectWsl({ env, readFile: deps.readFile });
  const machine = cfg.machine ?? machineLabel({ platform: deps.platform, wsl, hostname: deps.hostname });
  const push = buildMessage({ ...event, title }, { repoName, click: url, machine });

  // 3. Send. Each transport records its own result the moment it settles, so an acknowledged ntfy is never lost to a
  // hung toast (or to the hard cap), and a retry cannot send it twice.
  const hasPs = wsl && (deps.hasPowershell ? deps.hasPowershell() : Boolean(findOnPath('powershell.exe', env)));
  const jobs = [
    (async () => {
      const r = await sendNtfy({ cfg, push, fetchFn, timeoutMs: budget.ntfyMs, signal, nowFn: now });
      transports.ntfy = r.status;
      if (r.detail) errors.ntfy = scrub(r.detail).slice(0, 200);
      await record('ntfy', r.status);
    })(),
  ];
  if (hasPs) {
    jobs.push((async () => {
      const r = await sendToast({ push, spawnFn, timeoutMs: budget.toastMs, signal });
      transports.toast = r.status;
      if (r.detail) errors.toast = scrub(r.detail).slice(0, 200);
      await record('toast', r.status);
    })());
  }
  await Promise.all(jobs);
  const sent = transports.ntfy === 'sent' || transports.toast === 'sent';
  return out({ ...(sent ? {} : { reason: 'send-failed' }), ...(ledger ? { ledger } : {}), ...(cfg.machineInvalid ? { machineLabel: 'default (invalid NTFY_MACHINE)' } : {}) });
}

// The `notify --test` event: a timestamp in the identity so it is never deduplicated.
export function testEvent(nowMs = Date.now()) {
  return {
    event: 'test',
    title: 'Pipeline notify test',
    action: 'If you can read this, owner notifications work on this device.',
    cause: `test:${new Date(nowMs).toISOString()}`,
    outcome: 'test',
    test: true,
  };
}
