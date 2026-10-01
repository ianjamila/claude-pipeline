// The only way the pipeline talks to the Vercel CLI, so tests swap in a scripted fake with PIPELINE_VERCEL (the same
// seam as PIPELINE_GH). Two questions matter to prod-watch: "which deployment does the production domain serve right
// now" (inspectAlias) and "make production serve that older one" (rollback). Both fail loudly: inspectAlias throws
// when it cannot tell, because a guess about what is live could let a rollback remove somebody else's deploy.
import { existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { overrideCommand, run } from './proc.mjs';
import { gitCommonDir } from './repo.mjs';

const INSPECT_TIMEOUT_MS = 90_000;
const TAIL_CHARS = 4000;
// Vercel waits up to --timeout for the rollback itself; allow a minute on top before we give up on the process.
const ROLLBACK_SLACK_MS = 60_000;

export const vercelCommand = (env) => overrideCommand('PIPELINE_VERCEL', 'vercel', env);

export class VercelError extends Error {
  constructor({ args, code, stderr = '', timedOut = false, message }) {
    super(message ?? `vercel ${args.join(' ')} ${timedOut ? 'timed out' : 'failed'} (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    this.name = 'VercelError';
    this.args = args;
    this.code = code;
    this.timedOut = timedOut;
  }
}

// A target/domain becomes an argv entry (never a shell string), but one that starts with `-` would still be read by the
// CLI as an option, and whitespace can only come from a corrupted record.
function assertSafeArg(value, what) {
  if (typeof value !== 'string' || !/^[^\s-]\S*$/.test(value)) throw new TypeError(`unsafe ${what}: ${JSON.stringify(value)}`);
  return value;
}

export const tail = (text, max = TAIL_CHARS) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `...${s.slice(-max)}` : s;
};

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

// Tolerates banner lines around the JSON (older CLIs print update notices on stdout).
function parseJson(text) {
  const s = String(text ?? '');
  try {
    return JSON.parse(s);
  } catch {
    const from = s.indexOf('{');
    const to = s.lastIndexOf('}');
    if (from < 0 || to <= from) return null;
    try {
      return JSON.parse(s.slice(from, to + 1));
    } catch {
      return null;
    }
  }
}

// The deployment a production domain points at: { id, url (host, no scheme), readyState, createdAt (epoch ms|null), target }.
// Run it where the project is linked (see linkedProjectDir). Throws VercelError on any failure or unusable answer.
export function inspectAlias(domain, { cwd, env, runFn = run } = {}) {
  assertSafeArg(domain, 'domain');
  const { cmd, prefixArgs } = vercelCommand(env);
  const args = [...prefixArgs, 'inspect', domain, '--format', 'json'];
  const r = runFn(cmd, args, { cwd, env, timeoutMs: INSPECT_TIMEOUT_MS });
  const shown = ['inspect', domain, '--format', 'json'];
  if (r.code !== 0 || r.timedOut) throw new VercelError({ args: shown, code: r.code, stderr: r.stderr, timedOut: r.timedOut });
  const json = parseJson(r.stdout);
  if (!json || typeof json.id !== 'string' || !json.id || typeof json.url !== 'string' || !json.url) {
    throw new VercelError({ args: shown, code: r.code, message: `vercel ${shown.join(' ')} returned no deployment id/url: ${tail(r.stdout, 200)}` });
  }
  return {
    id: json.id,
    url: json.url.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
    readyState: json.readyState ?? json.status ?? null,
    createdAt: toMs(json.createdAt ?? json.created),
    target: json.target ?? null,
  };
}

function durationMs(text) {
  const m = /^(\d+)(s|m)$/.exec(String(text));
  return m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000) : 180_000;
}

// Points production at `target` (a deployment URL or id). Never throws for a failed rollback: the caller records the
// output and decides; `ok` is true only for exit 0 within the time limit.
export function rollback(target, { cwd, env, timeout = '3m', runFn = run } = {}) {
  assertSafeArg(target, 'rollback target');
  const { cmd, prefixArgs } = vercelCommand(env);
  const r = runFn(cmd, [...prefixArgs, 'rollback', target, '--yes', '--timeout', timeout], {
    cwd,
    env,
    timeoutMs: durationMs(timeout) + ROLLBACK_SLACK_MS,
  });
  return { ok: r.code === 0 && !r.timedOut, code: r.code, tail: tail(`${r.stdout}\n${r.stderr}`) };
}

// `vercel inspect` needs the project link (.vercel/project.json), which is gitignored and so missing from a fresh
// agent worktree. Use `root` when it is linked, else the main checkout that owns the worktree, else `root` and let the
// CLI report what is missing.
export function linkedProjectDir(root) {
  const linked = (dir) => existsSync(join(dir, '.vercel', 'project.json'));
  if (linked(root)) return root;
  try {
    const common = gitCommonDir(root);
    const main = basename(common) === '.git' ? dirname(common) : null;
    if (main && resolve(main) !== resolve(root) && linked(main)) return main;
  } catch {
    /* not a git checkout: fall through */
  }
  return root;
}
