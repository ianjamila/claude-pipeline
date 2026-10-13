// Why: the owner runs this pipeline on several machines and two Claude accounts, and nothing used to say when the
// installed copy had fallen behind, been edited, or was older than the rules a repo's CI already enforces. The
// SessionStart hook (hooks/session-version.mjs) says so, once, at the top of a session - and says NOTHING when all is
// well. The decision is a pure function over gathered facts (messagesFor), so every case is a table row in a test; the
// gathering (gatherFacts) is bounded by ONE deadline shared by every git and network step, takes its collaborators by
// injection, and never throws. Lookups are cached on disk (main's sha briefly, a definitive compare forever, keyed by
// the full shas) so most sessions never touch the network; a cache that cannot be read or written is just a miss.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedIdentity, parseStamp, stampIsTrusted, gitIn } from './identity.mjs';
import { mainSha, compare } from './upstream.mjs';
import { readRegularFile, realpathInside } from './safe-read.mjs';

export const DEADLINE_MS = 4000;
export const MAIN_TTL_MS = 15 * 60 * 1000;
export const UPDATE_COMMAND = 'node ~/.claude/pipeline/bin/pipeline.mjs update';
export const TIMEOUT_LINE = 'pipeline version check incomplete (timed out)';

const OWN_TERMINAL = `run \`${UPDATE_COMMAND}\` in your own terminal`;
const short = (sha) => String(sha ?? '').slice(0, 7);
const isTimeout = (r) => Boolean(r && (r.timedOut || /timed out/i.test(String(r.reason ?? ''))));

// Everything this hook prints goes to Claude as context, and some of what it handles is controlled by someone else (the
// session's repo, whatever gh/git said). So nothing from those sources is ever echoed: a failure reason is reduced to
// one word from a fixed vocabulary, and a repo's stamp is rebuilt from validated parts or not described at all.
export function reasonLabel(reason) {
  const text = String(reason ?? '');
  if (/timed? ?out/i.test(text)) return 'timed out';
  if (/rate.?limit|\b(?:403|429)\b/i.test(text)) return 'rate limited';
  if (/\b404\b|not found|no such (?:file|repo)|could not resolve to/i.test(text) && !/command not found|spawn/i.test(text)) return 'not found';
  if (/ENOENT|spawn|command not found|not installed|is not recognized/i.test(text)) return 'gh unavailable';
  if (/network|resolve host|could not resolve|connect|ECONN|ENOTFOUND|EAI_AGAIN|offline|unreachable|dial|tls|ssl/i.test(text)) return 'network error';
  return 'unexpected response';
}

const STAMP_BASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z-]{1,24})?$/;
const STAMP_SHA = /^[0-9a-f]{7,64}$/;
const STAMP_FLAGS = ['modified', 'incomplete', 'unverified'];

// A repo-supplied stamp, described only from parts that passed strict checks - or null when any part did not.
export function safeStampLabel(parsed) {
  if (!parsed || typeof parsed.base !== 'string' || !STAMP_BASE.test(parsed.base)) return null;
  if (parsed.sha !== null && !(typeof parsed.sha === 'string' && STAMP_SHA.test(parsed.sha))) return null;
  if (!Array.isArray(parsed.flags) || !parsed.flags.every((f) => STAMP_FLAGS.includes(f))) return null;
  return `${parsed.base}+${parsed.sha ? short(parsed.sha) : 'unknown'}${parsed.flags.map((f) => `.${f}`).join('')}`;
}

// Does the installed identity need its own warning (case 1)? Returns the states, [] when it is clean.
export function installedProblems(installed) {
  const states = [];
  if (installed.complete === false) states.push('incomplete (a previous install did not finish)');
  const changed = (installed.modified?.length ?? 0) + (installed.missing?.length ?? 0) + (installed.extra?.length ?? 0) + (installed.scanError?.length ?? 0);
  if (changed > 0) states.push(`modified (${changed} installed file${changed === 1 ? ' differs' : 's differ'} from what was installed)`);
  if (installed.sourceDirty) states.push('unverified (built from a source tree that was not a clean checkout)');
  return states;
}

// ---- the decision ------------------------------------------------------------------------------------------------

// facts = {
//   installed:  an installedIdentity() result, or null (nothing readable installed)
//   repo:       null (no git repo at the session's cwd) | { root, vendoredStamp: string | null }
//   main:       null (not looked up) | { ok: true, sha } | { ok: false, reason, timedOut? }
//   installedVsMain:     null | compare(installedSha, mainSha) result      ('ahead' = main has commits the install lacks)
//   vendoredVsInstalled: null | compare(vendoredSha, installedSha) result  ('behind' = the vendored copy is newer,
//                                                                          'ahead' = the install is newer)
//   vendorDrift: null | [{ file, reason }]   (only read when the install is newer than the vendored copy)
//   timedOut:   true when a step was skipped or cut off by the deadline
// }
// Returns the lines to show, [] when everything is fine. "check incomplete (timed out)" is the line of last resort: it
// appears only when nothing else was worth saying.
export function messagesFor(facts) {
  const lines = [];
  let timedOut = facts.timedOut === true;
  const { installed, repo } = facts;

  // Case 1: the install itself cannot be trusted. Updating fixes it, so nothing else is worth comparing.
  if (!installed) {
    return [`installed pipeline has no readable INSTALLED.json, so its version cannot be told: ${OWN_TERMINAL}`];
  }
  const problems = installedProblems(installed);
  if (problems.length > 0) {
    return [`installed pipeline is ${problems.join(' and ')} (${installed.stamp}): ${OWN_TERMINAL}`];
  }
  if (!installed.sourceSha) {
    return [`cannot tell whether your installed pipeline (${installed.stamp}) is current, its stamp names no source commit: ${OWN_TERMINAL}`];
  }
  const inst7 = short(installed.sourceSha);

  // Cases 2 and 5: the install against upstream's main.
  const main = facts.main;
  if (main && main.ok === false) {
    if (isTimeout(main)) timedOut = true;
    else lines.push(`could not check claude-pipeline main (${reasonLabel(main.reason)}); your install is ${installed.stamp}`);
  } else if (main && main.ok) {
    const c = facts.installedVsMain;
    if (c?.status === 'ahead') {
      lines.push(`claude-pipeline main is ahead of your install (${inst7} → ${short(main.sha)}): ${OWN_TERMINAL}`);
    } else if (c?.status === 'diverged') {
      lines.push(`your installed pipeline (${inst7}) and claude-pipeline main (${short(main.sha)}) have diverged, so it cannot be told which is newer: ${OWN_TERMINAL} to move to main`);
    } else if (c?.status === 'unresolved') {
      if (isTimeout(c)) timedOut = true;
      else lines.push(`could not compare your installed pipeline (${inst7}) with claude-pipeline main (${short(main.sha)}): ${reasonLabel(c.reason)}`);
    }
    // identical / behind (the install is newer than published main): nothing to say
  }

  // Cases 3, 4 and 5: this repo's vendored scripts/pipeline against the install.
  if (repo && repo.vendoredStamp !== null) {
    const parsed = parseStamp(repo.vendoredStamp);
    if (!parsed) {
      lines.push('this repo\'s scripts/pipeline/VERSION is not a version stamp, so it cannot be compared with your install');
    } else if (!stampIsTrusted(parsed)) {
      const label = safeStampLabel(parsed);
      lines.push(label
        ? `this repo's scripts/pipeline is stamped ${label}, which does not name a published pipeline commit, so it cannot be compared with your install (${inst7})`
        : `this repo's scripts/pipeline carries an unrecognised stamp, which does not name a published pipeline commit, so it cannot be compared with your install (${inst7})`);
    } else {
      const c = facts.vendoredVsInstalled;
      const vend7 = short(parsed.sha);
      if (c?.status === 'behind') {
        lines.push(`WARNING: this repo's scripts/pipeline (${vend7}) is NEWER than your installed pipeline (${inst7}): the repo's CI rules are newer than your local CLI, so local checks may pass what CI rejects. Run \`${UPDATE_COMMAND}\` in your own terminal before relying on it`);
      } else if (c?.status === 'ahead') {
        const drift = facts.vendorDrift;
        if (Array.isArray(drift) && drift.length > 0) {
          lines.push(`this repo's scripts/pipeline is out of date (${vend7}, your install is ${inst7}) — a \`pipeline vendor\` PR is owed (${drift.length} vendored file${drift.length === 1 ? '' : 's'} differ)`);
        }
        // only the commit differs, the vendored content matches: nothing to say
      } else if (c?.status === 'diverged') {
        lines.push(`this repo's scripts/pipeline (${vend7}) and your installed pipeline (${inst7}) have diverged, so it cannot be told which is newer`);
      } else if (c?.status === 'unresolved') {
        if (isTimeout(c)) timedOut = true;
        else lines.push(`could not compare this repo's scripts/pipeline (${vend7}) with your installed pipeline (${inst7}): ${reasonLabel(c.reason)}`);
      }
    }
  }

  if (lines.length === 0 && timedOut) return [TIMEOUT_LINE];
  return lines;
}

// The vendor-owed finding (case 4) is the one the owner can act on by just saying yes. messagesFor still returns the
// plain finding; formatOutput adds the offer to what the owner reads and, to Claude's context only, how to act on it.
export const VENDOR_OFFER = ' — say "open the vendor PR" and Claude opens it';
const VENDOR_OWED = /a `pipeline vendor` PR is owed \(\d+ vendored files? differ\)$/;
export const isVendorOwedLine = (line) => typeof line === 'string' && VENDOR_OWED.test(line);

// Claude-only guidance (never in systemMessage). inst7 is the validated short sha of the installed pipeline.
export function vendorGuidance(inst7) {
  return 'Vendor PR owed: offer once, early in the session, to open the vendor PR for this repo. Never vendor without the owner agreeing. '
    + 'If the owner agrees, first look for one already open in this repo (`gh pr list --state open --search "chore(pipeline): vendor in:title"`); '
    + 'if one exists, point the owner to it (`ship resume <N>`) instead of opening a second. '
    + `Otherwise run the ship skill with a request to refresh scripts/pipeline from the installed claude-pipeline ${inst7} with \`pipeline vendor --repo .\` on a new agent/ branch (never on the current branch).`;
}

// The exact stdout of a SessionStart hook with something to say; '' (print nothing) otherwise. With opts.installed7 and
// a vendor-owed line among the lines, the owner's message ends with the offer and Claude's context gets the guidance.
export function formatOutput(lines, opts = {}) {
  if (!lines || lines.length === 0) return '';
  const context = lines.join('\n');
  const offer = typeof opts?.installed7 === 'string' && opts.installed7 !== '' && lines.some(isVendorOwedLine);
  const text = offer ? lines.map((l) => (isVendorOwedLine(l) ? `${l}${VENDOR_OFFER}` : l)).join('\n') : context;
  const additionalContext = offer ? `${context}\n${vendorGuidance(opts.installed7)}` : context;
  return `${JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`;
}

// ---- the cache ---------------------------------------------------------------------------------------------------

export const cacheDirFor = (env = process.env, home = os.homedir()) => path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'claude-pipeline');

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_COMPARES = 200;

function readJson(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, file);
  } catch { /* a cache that cannot be written is just a miss */ }
}

// main's sha is remembered for MAIN_TTL_MS; a compare is remembered forever, but only a definitive answer between two
// FULL shas (history never changes), looked up with whatever prefixes the caller holds. Nothing here throws.
export function createCache(dir, now = Date.now) {
  const mainFile = path.join(dir, 'main-sha.json');
  const compareFile = path.join(dir, 'compare.json');
  return {
    readMain() {
      const v = readJson(mainFile);
      if (!v || !FULL_SHA.test(String(v.sha)) || typeof v.at !== 'number') return null;
      const age = now() - v.at;
      return age >= 0 && age < MAIN_TTL_MS ? v.sha : null;
    },
    writeMain(sha) {
      if (FULL_SHA.test(String(sha))) writeJson(mainFile, { sha, at: now() });
    },
    lookupCompare(base, head) {
      const entries = readJson(compareFile)?.entries;
      if (!entries || typeof entries !== 'object') return null;
      const b = String(base).toLowerCase();
      const h = String(head).toLowerCase();
      for (const [key, status] of Object.entries(entries)) {
        const [kb, kh] = key.split('...');
        if (FULL_SHA.test(kb ?? '') && FULL_SHA.test(kh ?? '') && kb.startsWith(b) && kh.startsWith(h)
          && ['identical', 'ahead', 'behind', 'diverged'].includes(status)) return { status, baseSha: kb, headSha: kh };
      }
      return null;
    },
    storeCompare(result) {
      if (!['identical', 'ahead', 'behind', 'diverged'].includes(result?.status) || !FULL_SHA.test(String(result.baseSha)) || !FULL_SHA.test(String(result.headSha))) return;
      const entries = readJson(compareFile)?.entries ?? {};
      entries[`${result.baseSha}...${result.headSha}`] = result.status;
      const keys = Object.keys(entries);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_COMPARES))) delete entries[k];
      writeJson(compareFile, { entries });
    },
  };
}

// ---- gathering the facts -----------------------------------------------------------------------------------------

export const STAMP_MAX_BYTES = 256;

// The repo's scripts/pipeline/VERSION, read as hostile input: null when there is no vendored copy (no file, or a
// scripts/pipeline that resolves outside the repo - ignored as if absent); '' when something is THERE but cannot be
// safely read (a symlink, FIFO, device, directory, unreadable) - which messagesFor words as "not a version stamp"
// without echoing a byte; otherwise at most STAMP_MAX_BYTES of the file (a longer file is cut, so it cannot parse).
export function readVendoredStamp(file, root) {
  const dir = path.dirname(file);
  if (!realpathInside(root, dir)) return null;
  const r = readRegularFile(file, STAMP_MAX_BYTES);
  if (r.status === 'missing') return null;
  if (r.status !== 'ok') return '';
  return r.buffer.toString('utf8');
}

// Bounded by the hook's deadline; an injected dep may return a plain array (a finished drift) or { drift, timedOut }.
const realVendorDrift = async (root, { deadlineAt, now }) => (await import('../commands/vendor.mjs')).vendorDriftBounded(root, { deadlineAt, now });

// Collects the facts messagesFor needs, within `deadlineMs` in total. Anything that cannot finish in time is left out and
// flagged timedOut; any unexpected error is swallowed (a version check must never disturb a session).
export async function gatherFacts({ home, cwd, env = process.env, now = Date.now, deadlineMs = DEADLINE_MS, deps = {} }) {
  const d = {
    installedIdentity, mainSha, compare, gitIn, vendorDrift: realVendorDrift,
    readFile: readVendoredStamp, cache: createCache(cacheDirFor(env), now), ...deps,
  };
  const end = now() + deadlineMs;
  const left = () => end - now();
  const facts = { installed: null, repo: null, main: null, installedVsMain: null, vendoredVsInstalled: null, vendorDrift: null, timedOut: false };
  const cut = (r) => { if (r && r.status === 'unresolved' && left() <= 0) r.timedOut = true; return r; };
  try {
    try { facts.installed = d.installedIdentity(home); } catch { facts.error = true; return facts; }
    const inst = facts.installed;
    // Case 1 and "no source sha" end the story before any git or network step: updating is the whole advice.
    if (!inst || installedProblems(inst).length > 0 || !inst.sourceSha) return facts;

    // This session's repo and its vendored stamp (local only: one git call, one file).
    if (typeof cwd === 'string' && cwd && left() > 0) {
      const top = d.gitIn(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: Math.max(1, left()) });
      if (top.code === 0 && top.stdout.trim()) {
        const root = top.stdout.trim();
        let vendoredStamp = null;
        try {
          const text = d.readFile(path.join(root, 'scripts', 'pipeline', 'VERSION'), root);
          vendoredStamp = typeof text === 'string' ? text.trim() : null;
        } catch { /* no vendored copy */ }
        facts.repo = { root, vendoredStamp };
      } else if (top.timedOut) facts.timedOut = true;
    } else if (typeof cwd === 'string' && cwd) facts.timedOut = true;

    // main, then the install against it.
    const cachedMain = d.cache.readMain();
    if (cachedMain) {
      facts.main = { ok: true, sha: cachedMain };
    } else if (left() > 0) {
      const m = d.mainSha({ timeoutMs: Math.max(1, left()), env, home });
      facts.main = m.ok ? m : { ...m, timedOut: left() <= 0 };
      if (m.ok) d.cache.writeMain(m.sha);
    } else facts.timedOut = true;
    const relate = (base, head) => {
      if (head.startsWith(base) || base.startsWith(head)) return { status: 'identical' };
      const hit = d.cache.lookupCompare(base, head);
      if (hit) return hit;
      if (left() <= 0) { facts.timedOut = true; return null; }
      const r = cut(d.compare(base, head, { timeoutMs: Math.max(1, left()), env }));
      d.cache.storeCompare(r);
      return r;
    };
    if (facts.main?.ok) facts.installedVsMain = relate(inst.sourceSha, facts.main.sha);

    // The vendored copy against the install - only when its stamp names a commit it can be compared by.
    const vendored = facts.repo?.vendoredStamp != null ? parseStamp(facts.repo.vendoredStamp) : null;
    if (vendored && stampIsTrusted(vendored)) {
      facts.vendoredVsInstalled = relate(vendored.sha, inst.sourceSha);
      if (facts.vendoredVsInstalled?.status === 'ahead') {
        // hashing the repo's files is the one unbounded step, so it runs only with time left and stops at the deadline
        if (left() <= 0) facts.timedOut = true;
        else {
          const r = await d.vendorDrift(facts.repo.root, { deadlineAt: end, now });
          const drift = Array.isArray(r) ? r : r?.drift;
          if (!Array.isArray(r) && r?.timedOut) facts.timedOut = true;
          else if (Array.isArray(drift)) facts.vendorDrift = drift;
        }
      }
    }
  } catch {
    // swallowed: whatever was gathered so far is all there is
  }
  return facts;
}

// The whole check: facts -> output text ('' when nothing to say). Never throws.
export async function checkSession(opts) {
  try {
    const facts = await gatherFacts(opts);
    // an identity read that threw is a bug in this check, not a finding about the install
    return facts.error && !facts.installed ? '' : formatOutput(messagesFor(facts), { installed7: short(facts.installed?.sourceSha) });
  } catch { return ''; }
}
