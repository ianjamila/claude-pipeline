// Generic verify runner: proves this repo works. pipeline-setup copies this file to scripts/verify.mjs and the project
// edits STEPS below; everything else is project-independent. It is what `verify.full` / `verify.quick` in
// .claude/pipeline.yml run, and the Stop hook, `ship` and CI all trust its report.
//   node scripts/verify.mjs                full run: every step, in order, stop at the first failure
//   node scripts/verify.mjs --quick        only steps marked quick:true (using quickCmd when a step has one)
//   node scripts/verify.mjs --only a,b     just those steps (report mode "partial"; never a substitute for a full run)
//   node scripts/verify.mjs --list         print the steps
// Writes .verify/report.json (+ .verify/logs/<step>.log). Exit 0 all passed, 1 a step failed, 2 refused or usage error.
// Safety: it refuses to run at all when NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL / DATABASE_URL (in the environment or in
// a step's env) point anywhere but localhost, because the db steps reset the database. Consecutive steps with the same
// lockGroup hold ONE machine-wide lock "<group>-<project>" so two worktrees never reset the same database at once.
// Libraries come from scripts/pipeline/lib (vendored by `pipeline vendor`).
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './pipeline/lib/config.mjs';
import { headSha, isClean, mergeBase, revParse, treeFingerprint } from './pipeline/lib/git.mjs';
import { withLock } from './pipeline/lib/locks.mjs';
import { runShell, runShellAsync } from './pipeline/lib/proc.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'my-app'; // must match `project:` in .claude/pipeline.yml (names the dedicated Supabase and its lock)

// ---- EDIT THIS: the steps for this project ----------------------------------------------------------------------------
// name      unique, letters/digits/./_/- (it names the log file)
// cmd       shell command (POSIX sh, or cmd.exe on Windows); exit 0 = pass
// quick     true = also part of `--quick` (the Stop hook runs that, so keep these fast: seconds, not minutes)
// quickCmd  cheaper command to use in quick mode instead of cmd (e.g. an incremental or changed-files-only variant)
// lockGroup 'db' = needs the dedicated local database; consecutive steps in one group run under a single lock
// env       extra environment: an object, or a function returning one (called just before the step starts)
// timeoutMs per-step limit (default 30 minutes)
const STEPS = [
  { name: 'install', cmd: 'npm ci', quick: false },
  { name: 'typecheck', cmd: 'npx tsc --noEmit', quick: true, quickCmd: 'npx tsc --noEmit --incremental --tsBuildInfoFile .verify/tsbuildinfo' },
  { name: 'lint', cmd: 'npm run lint', quick: true },
  { name: 'unit', cmd: 'npx vitest run', quick: true, quickCmd: 'npx vitest run --changed origin/main' },
  { name: 'db', cmd: `node scripts/pipeline/supabase-local.mjs reset-and-test --project ${PROJECT}`, quick: false, lockGroup: 'db' },
  { name: 'build', cmd: 'npm run build', quick: false, lockGroup: 'db', env: () => supabaseEnv() },
  { name: 'e2e', cmd: 'npx playwright test --project=smoke', quick: false, lockGroup: 'db', env: () => supabaseEnv() },
];

// The dedicated local Supabase's URLs and keys as environment variables (KEY=value lines from supabase-local.mjs).
function supabaseEnv() {
  const r = runShell(`node scripts/pipeline/supabase-local.mjs env --project ${PROJECT}`, { cwd: ROOT });
  if (r.code !== 0) throw new Error(`could not read the local Supabase environment: ${(r.stderr || r.stdout).trim()}`);
  return Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}
// ---- end of the project-specific part ---------------------------------------------------------------------------------

export const DB_URL_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'DATABASE_URL'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const STEP_TIMEOUT_MS = 30 * 60_000;
const EXCERPT_LINES = 40;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

class UsageError extends Error {}
class Refused extends Error {}

const human = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// Last N lines of a log, readable in a terminal-less place: colours gone, and a progress bar that redraws itself with
// carriage returns shows only its final state.
export function excerpt(text, n = EXCERPT_LINES) {
  const clean = String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((l) => l.replace(/\r+$/, '').split('\r').pop());
  while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
  return clean.slice(-n).join('\n');
}

// Which of the guarded variables point somewhere other than this machine. Reports names and hosts only: a DATABASE_URL
// carries a password and must never be echoed.
export function nonLocalDb(env) {
  const bad = [];
  for (const name of DB_URL_VARS) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    let host = null;
    try { host = new URL(String(raw).trim()).hostname.toLowerCase(); } catch { /* unparseable: cannot prove it is local */ }
    if (host === null || !LOCAL_HOSTS.has(host)) bad.push({ name, host: host === null ? 'unparseable value' : host });
  }
  return bad;
}

const refusal = (bad, where) => `refusing to run: ${bad.map((b) => `${b.name} points at non-local host "${b.host}"`).join('; ')} (in ${where}). verify resets the database; use the dedicated local Supabase.`;

function validateSteps(steps) {
  const seen = new Set();
  if (!Array.isArray(steps) || steps.length === 0) throw new UsageError('STEPS must be a non-empty array');
  for (const s of steps) {
    if (!s || typeof s.name !== 'string' || !NAME_RE.test(s.name)) throw new UsageError(`bad step name: ${JSON.stringify(s?.name)} (use letters, digits, ".", "_", "-")`);
    if (seen.has(s.name)) throw new UsageError(`duplicate step name: ${s.name}`);
    seen.add(s.name);
    if (typeof s.cmd !== 'string' || !s.cmd.trim()) throw new UsageError(`step ${s.name}: cmd must be a non-empty string`);
    if (s.quickCmd !== undefined && (typeof s.quickCmd !== 'string' || !s.quickCmd.trim())) throw new UsageError(`step ${s.name}: quickCmd must be a non-empty string`);
    if (s.lockGroup !== undefined && (typeof s.lockGroup !== 'string' || !NAME_RE.test(s.lockGroup))) throw new UsageError(`step ${s.name}: bad lockGroup`);
  }
}

// Consecutive steps sharing a lockGroup become one segment (one lock acquisition); everything else is its own segment.
function segmentsOf(steps) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.lockGroup && last && last.group === s.lockGroup) last.steps.push(s);
    else out.push({ group: s.lockGroup ?? null, steps: [s] });
  }
  return out;
}

function gitInfo(root, defaultBranch) {
  const o = { cwd: root };
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const head = safe(() => headSha(o));
  const baseRef = `origin/${defaultBranch}`;
  const base = safe(() => revParse(baseRef, o));
  return {
    head,
    base,
    mergeBase: base ? safe(() => mergeBase('HEAD', baseRef, o)) : null,
    dirty: head === null ? null : safe(() => !isClean(o)),
    tree: safe(() => treeFingerprint(o)), // fixed at the START: the report is bound to the tree that was verified
  };
}

function writeReport(file, report) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Runs verify. Returns { exitCode, report } (report is null when nothing ran: usage error or --list).
 * opts: argv, cwd (repo root; default = the directory above scripts/), env (default process.env), steps (default STEPS),
 *       lockDir (default: the machine-wide lock directory), lockWaitMs (default: 30 min), out (stdout-like), err (stderr-like).
 */
export async function runVerify(opts = {}) {
  const { argv = [], cwd = ROOT, env = process.env, steps = STEPS, lockDir, lockWaitMs, out = process.stdout, err = process.stderr } = opts;
  const say = (s) => out.write(`${s}\n`);
  const warn = (s) => err.write(`${s}\n`);

  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { quick: { type: 'boolean' }, only: { type: 'string' }, list: { type: 'boolean' } }, allowPositionals: false, strict: true }));
    validateSteps(steps);
    if (values.only !== undefined) {
      const known = new Set(steps.map((s) => s.name));
      const unknown = values.only.split(',').map((s) => s.trim()).filter((s) => s && !known.has(s));
      if (unknown.length > 0 || values.only.trim() === '') throw new UsageError(`unknown step(s): ${unknown.join(', ') || '(none given)'}. Steps: ${[...known].join(', ')}`);
    }
  } catch (e) {
    warn(`verify: ${e.message}`);
    return { exitCode: 2, report: null };
  }

  if (values.list) {
    for (const s of steps) say(`${s.name.padEnd(14)} ${s.quick ? 'quick' : '     '} ${(s.lockGroup ? `lock:${s.lockGroup}` : '').padEnd(10)} ${s.cmd}${s.quickCmd ? `  (quick: ${s.quickCmd})` : ''}`);
    return { exitCode: 0, report: null };
  }

  const only = values.only === undefined ? null : new Set(values.only.split(',').map((s) => s.trim()).filter(Boolean));
  const mode = only ? 'partial' : values.quick ? 'quick' : 'full';
  const selected = steps.filter((s) => (only ? only.has(s.name) : values.quick ? s.quick === true : true));
  if (selected.length === 0) {
    warn(`verify: no steps selected for mode ${mode}`);
    return { exitCode: 2, report: null };
  }
  const commandOf = (s) => (values.quick && s.quickCmd ? s.quickCmd : s.cmd);

  const loaded = await loadConfig(cwd);
  if (!loaded.ok) warn(`verify: ignoring unusable .claude/pipeline.yml (${loaded.errors.join('; ')}); using defaults`);
  const config = loaded.ok ? loaded.config : null;
  const reportFile = resolve(cwd, config?.verify?.report ?? '.verify/report.json');
  const logsDir = join(cwd, '.verify', 'logs');
  const lockName = (group) => `${group}-${slug(config?.project ?? basename(cwd))}`;

  const startedAt = new Date();
  const report = {
    version: 1,
    mode,
    ok: false,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    expectedSteps: selected.map((s) => s.name),
    git: gitInfo(cwd, config?.default_branch ?? 'main'),
    steps: selected.map((s) => ({ name: s.name, status: 'not-run', durationMs: 0, command: commandOf(s), exitCode: null, errorExcerpt: '' })),
  };
  const row = (s) => report.steps[selected.indexOf(s)];
  const finish = (exitCode, error) => {
    report.finishedAt = new Date().toISOString();
    report.ok = exitCode === 0;
    if (error) report.error = error;
    writeReport(reportFile, report);
    return { exitCode, report };
  };

  try {
    const bad = nonLocalDb(env);
    if (bad.length > 0) {
      warn(`verify: ${refusal(bad, 'the environment')}`);
      return finish(2, refusal(bad, 'the environment'));
    }
    for (const s of selected) {
      if (typeof s.env === 'function') continue; // resolved (and checked) when the step starts
      const badStep = nonLocalDb(s.env ?? {});
      if (badStep.length > 0) {
        warn(`verify: ${refusal(badStep, `step ${s.name}'s env`)}`);
        return finish(2, refusal(badStep, `step ${s.name}'s env`));
      }
    }

    mkdirSync(logsDir, { recursive: true });
    for (const s of selected) rmSync(join(logsDir, `${s.name}.log`), { force: true }); // a stale log must not pass for this run's

    // One step. Returns true to continue, false to stop (failure).
    async function runStep(s) {
      const r = row(s);
      const stepEnv = typeof s.env === 'function' ? await s.env() : (s.env ?? {});
      const badNow = nonLocalDb({ ...env, ...stepEnv });
      if (badNow.length > 0) throw new Refused(refusal(badNow, `step ${s.name}'s env`));
      say(`[run ] ${s.name}: ${r.command}`);
      const t0 = Date.now();
      const res = await runShellAsync(r.command, { cwd, env: env === process.env ? stepEnv : { ...env, ...stepEnv }, timeoutMs: s.timeoutMs ?? STEP_TIMEOUT_MS });
      r.durationMs = Date.now() - t0;
      r.exitCode = res.code;
      const output = `${res.stdout}${res.stderr ? `${res.stdout && !res.stdout.endsWith('\n') ? '\n' : ''}${res.stderr}` : ''}`;
      writeFileSync(join(logsDir, `${s.name}.log`), output);
      const passed = res.code === 0 && !res.timedOut;
      r.status = passed ? 'pass' : 'fail';
      if (!passed) {
        r.errorExcerpt = excerpt(`${res.timedOut ? `[timed out after ${human(s.timeoutMs ?? STEP_TIMEOUT_MS)}]\n` : ''}${output}`);
        say(`[FAIL] ${s.name} (exit ${res.code}${res.timedOut ? ', timed out' : ''}, ${(r.durationMs / 1000).toFixed(1)}s)`);
        say(r.errorExcerpt.split('\n').slice(-15).map((l) => `       ${l}`).join('\n'));
      } else {
        say(`[pass] ${s.name} (${(r.durationMs / 1000).toFixed(1)}s)`);
      }
      return passed;
    }

    let stopped = false;
    for (const seg of segmentsOf(selected)) {
      if (!seg.group) {
        stopped = !(await runStep(seg.steps[0]));
      } else {
        let lastNote = -Infinity;
        try {
          await withLock(lockName(seg.group), async () => {
            for (const s of seg.steps) {
              if (!(await runStep(s))) { stopped = true; return; }
            }
          }, {
            ...(lockDir ? { dir: lockDir } : {}),
            ...(lockWaitMs !== undefined ? { waitMs: lockWaitMs, pollMs: Math.min(100, lockWaitMs) } : {}),
            onWait: (owner, waitedMs) => {
              if (waitedMs - lastNote >= 30_000) {
                lastNote = waitedMs;
                warn(`verify: waiting for lock ${lockName(seg.group)} held by pid ${owner?.pid ?? '?'} on ${owner?.host ?? '?'}`);
              }
            },
          });
        } catch (e) {
          if (e?.name !== 'LockTimeoutError' && e?.name !== 'LockLostError') throw e;
          // Could not take the lock (timeout), or lost it while steps ran: the group's results cannot be trusted.
          const ran = seg.steps.filter((s) => row(s).status !== 'not-run');
          const target = ran.length > 0 ? row(ran[ran.length - 1]) : row(seg.steps[0]);
          target.status = 'fail';
          target.errorExcerpt = excerpt(`${e.message}\n${target.errorExcerpt}`);
          warn(`verify: ${e.message}`);
          stopped = true;
        }
      }
      if (stopped) break;
    }

    const ok = report.steps.every((s) => s.status === 'pass');
    const failed = report.steps.find((s) => s.status === 'fail');
    say(`verify (${mode}): ${ok ? 'PASS' : `FAIL at ${failed?.name ?? '?'}`} - ${report.steps.filter((s) => s.status === 'pass').length}/${report.steps.length} steps passed. Report: ${reportFile}`);
    return finish(ok ? 0 : 1);
  } catch (e) {
    warn(`verify: ${e.message}`);
    return finish(2, e instanceof Refused ? e.message : `internal error: ${e.message}`);
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  runVerify({ argv: process.argv.slice(2) }).then((r) => { process.exitCode = r.exitCode; });
}
