// Updates the installed pipeline to upstream's main with one command, run by the owner in their own terminal:
// resolve main's sha, download exactly that commit into a private scratch directory under the Claude home with an isolated git, install from it with
// the installer (the same install.mjs a manual install runs), then prove the result with the installer's own --check.
// `--check` only reports (and is allowed anywhere, including inside Claude Code): installed stamp, main, how they relate.
// Why it refuses inside Claude Code: an update replaces the guard hooks, which is the one thing an agent must not do to
// itself (install.mjs makes the same refusal). It takes no install lock of its own: install.mjs, which it runs as a
// child, holds the per-claude-home lock for the write, so there is exactly one owner and no deadlock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';
import { hasClaudeCodeAncestor } from '../lib/claude-ancestry.mjs';
import { installedIdentity } from '../lib/identity.mjs';
import { readManifest } from '../lib/installer.mjs';
import { expandHome } from '../lib/paths.mjs';
import { run as runProcess } from '../lib/proc.mjs';
import { makePrivateTmpDir } from '../lib/private-tmp.mjs';
import { compare, fetchRemote, isolatedGit, mainSha, makeIsoDir, removeTree } from '../lib/upstream.mjs';

export const meta = {
  summary: 'update the installed pipeline to upstream main (run in your own terminal); --check only reports',
  usage: [
    'pipeline update [--claude-home DIR] [--check] [--json]',
    '  Fetches upstream main (github.com/ianjamila/claude-pipeline), installs it and verifies the install.',
    '  --claude-home DIR  where the pipeline is installed (default ~/.claude: both Claude accounts share ~/.claude/pipeline,',
    '                     so CLAUDE_CONFIG_DIR is deliberately not consulted)',
    '  --check            read-only: report the installed stamp, upstream main and how they relate; exit 0 only when',
    '                     the install is complete, unmodified and identical to main (allowed inside Claude Code)',
    '  --json             no progress text on stderr (the result is always one JSON object on stdout)',
    '  Refuses inside Claude Code (run it in your own terminal) unless --check or PIPELINE_ADMIN=1.',
  ].join('\n'),
};

const NETWORK_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 180000;
const INSTALL_TIMEOUT_MS = 300000;

const sha7 = (sha) => (sha ? String(sha).slice(0, 7) : null);

// One argument for a command the owner pastes: POSIX sh single quotes ('\'' for a quote), PowerShell single quotes ('').
// Always quoted, so a home with spaces ("C:\Users\Jane Doe\.claude") or shell metacharacters stays one literal argument.
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const tail = (text, n = 1500) => String(text ?? '').trim().slice(-n);

// What `--check` and the update result say about the installed copy.
function installedSummary(id) {
  if (!id) return null;
  return {
    stamp: id.stamp, base: id.base, sourceSha: id.sourceSha, complete: id.complete,
    sourceDirty: id.sourceDirty, modified: id.modified, missing: id.missing, extra: id.extra ?? [], scanError: id.scanError ?? [],
  };
}

// The relation of the installed commit to main, per the GitHub compare API: `compare(installed, main)`.
function relate(id, main, env) {
  if (!id) return { status: 'unresolved', reason: 'nothing is installed there' };
  if (!id.sourceSha) return { status: 'unresolved', reason: 'the installed copy records no source commit' };
  return compare(id.sourceSha, main.sha, { timeoutMs: NETWORK_TIMEOUT_MS, env });
}

const clean = (id) => Boolean(id && id.complete && !id.sourceDirty && id.modified.length === 0 && id.missing.length === 0 && (id.extra?.length ?? 0) === 0 && (id.scanError?.length ?? 0) === 0);

// Fetches exactly `sha` into <tmp>/src with an isolated git (its private config/hooks directory is `isoDir`) and checks it out detached. Returns the source directory;
// throws an Error with a plain-language message when any step fails or the checked-out HEAD is not `sha`.
function fetchSource(tmp, isoDir, sha, remote) {
  const src = path.join(tmp, 'src');
  const step = (what, r) => {
    if (r.code !== 0 || r.timedOut) {
      throw new Error(`${what} ${r.timedOut ? 'timed out' : 'failed'}${tail(r.stderr, 400) ? `: ${tail(r.stderr, 400)}` : ''}`);
    }
    return r;
  };
  const opts = { isoDir, cwd: tmp, allowFile: remote.local };
  step('git init', isolatedGit(['init', '--quiet', '--template=', src], { ...opts, timeoutMs: 30000 }));
  step(`git fetch ${sha7(sha)}`, isolatedGit(['-C', src, 'fetch', '--quiet', '--depth', '1', '--no-tags', remote.url, sha], { ...opts, timeoutMs: FETCH_TIMEOUT_MS }));
  step('git checkout', isolatedGit(['-C', src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], { ...opts, timeoutMs: 120000 }));
  const head = step('git rev-parse', isolatedGit(['-C', src, 'rev-parse', 'HEAD'], { ...opts, timeoutMs: 30000 })).stdout.trim();
  if (head !== sha) throw new Error(`fetched ${sha7(head) || 'nothing'} but asked for ${sha7(sha)}`);
  return src;
}

// The installer is code that was just downloaded, run as the owner. It gets the caller's environment minus the
// variables that make Node load other code into it (NODE_OPTIONS `--require` / `--import`, NODE_PATH); the tests'
// PIPELINE_ADMIN / PIPELINE_INSTALL_NO_PROBES / PIPELINE_LOCK_DIR pass through.
const NODE_INJECTION_VARS = new Set(['NODE_OPTIONS', 'NODE_PATH']);
export function installerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !NODE_INJECTION_VARS.has(k.toUpperCase())));
}

// The download lives under <home>/pipeline-state/tmp, and only an installer that knows that root (install.mjs imports
// TMP_ROOT_REL from pipeline/lib/private-tmp.mjs - keep that import, this check reads it) accepts a --source inside the
// Claude home; an older one (rolling back to an earlier main, or a branch installed before it merged) rejects it and
// the update would die in `install-failed` with a message about overwriting. Better to say so up front.
export function installerAcceptsPrivateTmpSource(src) {
  try {
    if (!fs.statSync(path.join(src, 'pipeline', 'lib', 'private-tmp.mjs')).isFile()) return false;
    return /\bTMP_ROOT_REL\b/.test(fs.readFileSync(path.join(src, 'install.mjs'), 'utf8'));
  } catch {
    return false;
  }
}

function runInstaller(src, args, env) {
  const r = runProcess(process.execPath, [path.join(src, 'install.mjs'), ...args], { cwd: src, env: installerEnv(env), replaceEnv: true, timeoutMs: INSTALL_TIMEOUT_MS });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON: the stderr tail explains */ }
  return { code: r.code, ok: r.code === 0 && !r.timedOut, json, stderr: tail(r.stderr), timedOut: r.timedOut };
}

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const { values } = parseCommandArgs(argv, {
    'claude-home': { type: 'string' },
    check: { type: 'boolean' },
    json: { type: 'boolean' },
  }, { allowPositionals: false });
  const say = (line) => { if (!values.json) process.stderr.write(`${line}\n`); };

  if (!values.check && env.PIPELINE_ADMIN !== '1') {
    const inside = env.CLAUDECODE === '1'
      ? 'CLAUDECODE=1'
      : (ctx.hasClaudeCodeAncestor ?? hasClaudeCodeAncestor)() ? 'a Claude Code process is an ancestor of this one' : null;
    if (inside) {
      const message = `pipeline update refuses to run inside a Claude Code session (${inside}): an update replaces the guard hooks. Run it in your own terminal (\`node ~/.claude/pipeline/bin/pipeline.mjs update\`); \`--check\` is allowed anywhere.`;
      say(message);
      return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
    }
  }

  const home = path.resolve(expandHome(values['claude-home'] || path.join(os.homedir(), '.claude')));
  const main = mainSha({ timeoutMs: NETWORK_TIMEOUT_MS, env, home });
  const before = installedIdentity(home);

  if (!main.ok) {
    const message = `could not resolve upstream main: ${main.reason}`;
    say(message);
    return {
      exitCode: EXIT.FAILED,
      output: { ok: false, mode: values.check ? 'check' : 'update', error: 'upstream-unresolved', message, home, installed: installedSummary(before), main: null, status: 'unresolved', upToDate: false },
    };
  }

  const relation = relate(before, main, env);

  if (values.check) {
    const upToDate = relation.status === 'identical' && clean(before);
    say(`installed ${before?.stamp ?? 'nothing'}; upstream main ${sha7(main.sha)}: ${relation.status}${relation.reason ? ` (${relation.reason})` : ''}${upToDate ? '' : ' - run `pipeline update` in your own terminal'}`);
    return {
      exitCode: upToDate ? EXIT.OK : EXIT.FAILED,
      output: { ok: upToDate, mode: 'check', home, installed: installedSummary(before), main: { sha: main.sha, via: main.via }, status: relation.status, compare: relation, upToDate },
    };
  }

  // The installer's guard-file choice survives an update: a copy installed with --skip-file-guard stays that way.
  const manifest = readManifest(home).manifest;
  const flags = manifest?.hooks?.guardFiles === false ? ['--skip-file-guard'] : [];
  const downgrade = relation.status === 'behind' || relation.status === 'diverged';
  if (downgrade) say(`warning: the installed commit ${sha7(before?.sourceSha)} is not an ancestor of upstream main ${sha7(main.sha)} (${relation.status}); updating replaces it.`);

  const result = {
    mode: 'update', home, before: before?.stamp ?? null, after: null, main: { sha: main.sha, via: main.via },
    status: relation.status, skipFileGuard: flags.length > 0, install: null, check: null,
  };
  const fail = (error, message, extra = {}) => {
    say(`update failed: ${message}`);
    return { exitCode: EXIT.FAILED, output: { ok: false, ...result, error, message, ...extra } };
  };

  let tmp = null;
  let isoDir = null;
  try {
    // Both scratch directories (the download the installer is then RUN from, and the git config/hooks one) live in the
    // trusted private root under `home`, never os.tmpdir(): see private-tmp.mjs. If it cannot be established, stop.
    try {
      fs.mkdirSync(home, { recursive: true }); // a first install into a home that does not exist yet; the installer would make it anyway
      tmp = makePrivateTmpDir(home, 'claude-pipeline-update-');
      isoDir = makeIsoDir(home);
    } catch (err) {
      return fail('fetch-failed', `could not create a private scratch directory under ${home} (${String(err?.message ?? err).slice(0, 200)})`);
    }
    say(`fetching upstream main ${sha7(main.sha)} ...`);
    let src;
    try {
      src = fetchSource(tmp, isoDir, main.sha, fetchRemote(env));
    } catch (err) {
      return fail('fetch-failed', err.message);
    }
    if (!installerAcceptsPrivateTmpSource(src)) {
      const rest = flags.map((f) => ` ${f}`).join('');
      const posix = `./install.sh --claude-home ${shQuote(home)}${rest}`;
      const windows = `.\\install.ps1 --claude-home ${psQuote(home)}${rest}`;
      return fail('installer-too-old', `upstream main ${sha7(main.sha)} has an older installer that cannot install from the folder this command downloads into, so nothing was changed. Update from a clone of that version instead: run \`${posix}\` in it (on Windows: \`${windows}\`).`);
    }
    say(`installing into ${home} ...`);
    const common = ['--claude-home', home, '--source', src, '--json', ...flags];
    const install = runInstaller(src, common, env);
    result.install = { ok: install.ok, exitCode: install.code, error: install.json?.error ?? null };
    if (!install.ok) return fail('install-failed', install.json?.error || install.stderr || `install.mjs exited ${install.code}`, { stderr: install.stderr });
    const check = runInstaller(src, ['--check', ...common], env);
    result.check = { ok: check.ok, exitCode: check.code, drift: check.json?.drift ?? [] };
    if (!check.ok) {
      const lines = (check.json?.drift ?? []).slice(0, 5).map((d) => d.message);
      return fail('check-failed', `the install did not verify: ${lines.join('; ') || check.stderr || `install.mjs --check exited ${check.code}`}`, { stderr: check.stderr });
    }
    const after = installedIdentity(home);
    result.after = after?.stamp ?? null;
    if (!after || !after.complete || after.sourceSha !== main.sha || !clean(after)) {
      return fail('unverified', `the installed copy reads ${after?.stamp ?? 'nothing'}, not a clean ${sha7(main.sha)}`);
    }
    say(`updated: ${result.before ?? 'nothing'} -> ${result.after}`);
    return {
      exitCode: EXIT.OK,
      output: { ok: true, ...result, installed: installedSummary(after), changed: result.before !== result.after, downgrade, warnings: install.json?.warnings ?? [] },
    };
  } finally {
    if (isoDir) removeTree(isoDir);
    if (tmp) removeTree(tmp);
  }
}
