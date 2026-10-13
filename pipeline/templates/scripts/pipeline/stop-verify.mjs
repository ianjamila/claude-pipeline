// Project Stop hook: refuses to let Claude end its turn while `verify.quick` is failing on code changes.
// This is a quality gate, NOT a safety boundary, so every doubt resolves to "allow": no repo, no config, an internal
// error, or three failed attempts on the same tree must never trap the session (branch protection is the real wall).
// The result for an exact tree is cached in .verify/stop-hook.json, so a turn that changed nothing costs nothing.
// Stdin is the Claude Code hook JSON; stdout is the decision JSON (`{"decision":"block",...}` or a `systemMessage`).
// Vendored into projects by `pipeline vendor` (imports ./lib/*, which is the vendored copy of pipeline/lib).
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { git, mergeBase, treeFingerprint } from './lib/git.mjs';
import { matchAny } from './lib/glob.mjs';
import { runShellAsync } from './lib/proc.mjs';

export const MAX_BLOCKS = 3;
// The checks get 14 minutes (the hook's own timeout is 1200 s: 900 s + the queue allowance, leaving room to report). A heavy step
// may first wait for room in the machine-wide heavy-check queue (verify bounds that wait by QUEUE_WAIT_QUICK_MS); the outer limit
// grows by exactly that allowance so waiting never eats the execution time. One source: scripts/lib/heavy-slots.mjs. A project
// this file is vendored into without that module has no queue and no allowance.
export const EXECUTION_TIMEOUT_MS = 840_000;
export const QUEUE_ALLOWANCE_MS = await import('../lib/heavy-slots.mjs').then((m) => m.QUEUE_WAIT_QUICK_MS ?? 0, () => 0);
export const RUN_TIMEOUT_MS = EXECUTION_TIMEOUT_MS + QUEUE_ALLOWANCE_MS;
const EXCERPT_LINES = 15;
const NOT_CODE = ['**/*.md', 'docs/**'];

const allow = (output = null) => ({ decision: 'allow', output });
const block = (reason) => ({ decision: 'block', output: { decision: 'block', reason } });

// Last `n` lines with ANSI colours stripped and absurdly long lines (minified bundles) clipped.
function tail(text, n = EXCERPT_LINES) {
  const lines = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => (l.length > 400 ? `${l.slice(0, 400)}...` : l));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n').replace(/^\s*\n/, '');
}

// -z output: no quoting problems, whatever the file names contain.
function parseStatusZ(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // A rename/copy entry is followed by its source path as a separate record.
    if (/[RC]/.test(entry.slice(0, 2)) && parts[i + 1]) files.push(parts[++i]);
  }
  return files;
}

// Everything the current work differs by: committed changes since the fork from origin/<default>, plus uncommitted.
// No merge-base (no origin, shallow clone) => only uncommitted, which is the conservative-enough fallback.
function changedFiles(root, config) {
  const o = { cwd: root };
  const files = new Set();
  let mb = null;
  try { mb = mergeBase('HEAD', `origin/${config.default_branch}`, o); } catch { /* no remote ref */ }
  if (mb) for (const f of git(['diff', '--name-only', '-z', mb], o).split('\0')) if (f) files.add(f);
  for (const f of parseStatusZ(git(['status', '--porcelain=v1', '-uall', '-z'], o))) files.add(f);
  return [...files];
}

// The fingerprint hashes untracked files, and quick verify rewrites .verify/report.json on every run. If a project did
// not gitignore .verify/, the fingerprint would change on every run, the cache would never hit and the 3-strike cap
// could never trigger. Excluding it locally (.git/info/exclude, never committed) keeps the loop cap honest.
function ensureVerifyIgnored(root) {
  const o = { cwd: root };
  try {
    git(['check-ignore', '-q', '.verify/stop-hook.json'], o);
    return;
  } catch { /* exit 1: not ignored */ }
  try {
    const exclude = resolve(root, git(['rev-parse', '--git-path', 'info/exclude'], o).trim());
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, '\n# claude-pipeline stop hook cache\n.verify/\n');
  } catch { /* best effort: without it the cache just misses more often */ }
}

function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof c?.fingerprint === 'string' && (c.result === 'pass' || c.result === 'fail') && Number.isInteger(c.blocks)) return c;
  } catch { /* missing or corrupt: treat as no cache */ }
  return null;
}

function writeCache(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

// The report file's mtime before the run, or null when there is none. Freshness compares stamps rather than mtime
// against Date.now(): Linux stamps files from a coarse clock that can trail Date.now() by a tick, so a report this
// run wrote could look older than the run itself.
function reportStamp(root, config) {
  try {
    return statSync(resolve(root, config.verify.report)).mtimeMs;
  } catch {
    return null;
  }
}

// The failing step from the verify report, but only if this very run wrote it (a stale report would blame old work).
function readReport(root, config, stampBefore) {
  try {
    const file = resolve(root, config.verify.report);
    if (stampBefore !== null && statSync(file).mtimeMs === stampBefore) return null;
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const step = Array.isArray(report?.steps) ? report.steps.find((s) => s?.status === 'fail') : null;
    return step ? { step: String(step.name ?? 'unknown step'), excerpt: String(step.errorExcerpt ?? '') } : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether Claude may stop. Returns { decision: 'allow'|'block', output } where output is the JSON object to print
 * on stdout (or null for a silent allow).
 * deps (all optional, for tests): env, run (runShellAsync shape), timeoutMs, cacheFile, loadConfig, fingerprint.
 */
export async function decide(input = {}, deps = {}) {
  const d = { env: process.env, run: runShellAsync, timeoutMs: RUN_TIMEOUT_MS, ...deps };
  try {
    return await evaluate(input ?? {}, d);
  } catch (err) {
    return allow({ systemMessage: `stop-verify hook error: ${err?.message ?? err}` });
  }
}

async function evaluate(input, d) {
  if (d.env.PIPELINE_OFF === '1') return allow();

  let root;
  try {
    root = resolve(git(['rev-parse', '--show-toplevel'], { cwd: resolve(input.cwd || process.cwd()) }).trim()); // native separators on Windows
    git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root }); // a repo with no commits has nothing to verify
  } catch {
    return allow();
  }
  const loaded = await (d.loadConfig ?? loadConfig)(root);
  if (!loaded.ok) return allow();
  const config = loaded.config;

  const changed = changedFiles(root, config);
  if (changed.length === 0 || changed.every((f) => matchAny(f, NOT_CODE))) return allow();

  const cacheFile = d.cacheFile ?? join(root, '.verify', 'stop-hook.json');
  if (!d.cacheFile) ensureVerifyIgnored(root);
  const fingerprint = (d.fingerprint ?? treeFingerprint)({ cwd: root });
  const cached = readCache(cacheFile);
  if (cached && cached.result === 'pass' && cached.fingerprint === fingerprint) return allow();

  const stampBefore = reportStamp(root, config);
  const r = await d.run(config.verify.quick, { cwd: root, env: { PIPELINE_STOP_HOOK: '1' }, timeoutMs: d.timeoutMs });
  if (r.code === 0 && !r.timedOut) {
    writeCache(cacheFile, { fingerprint, result: 'pass', blocks: 0 });
    return allow();
  }

  const blocks = cached && cached.fingerprint === fingerprint ? cached.blocks + 1 : 1;
  // Bind the failure to the tree as it is now: if verify auto-fixed files, the next turn starts from THIS tree, and
  // keying on the pre-run tree would reset the strike count every time.
  let after = fingerprint;
  try { after = (d.fingerprint ?? treeFingerprint)({ cwd: root }); } catch { /* keep the pre-run fingerprint */ }
  writeCache(cacheFile, { fingerprint: after, result: 'fail', blocks });

  const report = readReport(root, config, stampBefore);
  // stderr last: a crash message lands at the end, which is where the tail looks.
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const why = r.timedOut ? `timed out after ${Math.round(d.timeoutMs / 60_000)} min` : `exit ${r.code}`;
  const step = report ? report.step : why;
  const excerpt = report && report.excerpt.trim() ? tail(report.excerpt) : tail(output);

  if (blocks >= MAX_BLOCKS) {
    const first = report ? `${report.step}${excerpt ? `: ${excerpt.split('\n')[0]}` : ''}` : tail(output, 5) || why;
    return allow({ systemMessage: `Quick verify is still failing after ${MAX_BLOCKS} attempts — the work is NOT done: ${first}` });
  }
  return block(`Quick verify is failing (${step}):\n${excerpt}\nFix it before ending the turn, or tell the user plainly that it is still failing.`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch { /* unreadable hook input: decide on defaults */ }
  const result = await decide(input);
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  return 0; // blocking is expressed in the JSON, never in the exit code
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; });
}
