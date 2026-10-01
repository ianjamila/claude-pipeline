// Plumbing shared by the local commands (config, risk, hardstops, integrity, model-proof, job): resolving which repo
// a command is about, requiring a valid config, and turning git failures into a clean exit 2. Kept out of cli.mjs so
// the dispatcher's core contract stays small. Everything here fails closed: a command that cannot establish its repo,
// its config or its refs exits 2 instead of guessing, so a skill never mistakes "could not check" for "checked, fine".
import path from 'node:path';
import { EXIT } from './cli.mjs';
import { loadConfig } from './config.mjs';
import { GitError } from './git.mjs';
import { repoRoot } from './repo.mjs';

// Thrown to end a command early with a specific { exitCode, output }.
export class Fail extends Error {
  constructor(exitCode, output) {
    super(output?.message ?? output?.error ?? 'command failed');
    this.exitCode = exitCode;
    this.output = output;
  }
}

// Wraps a command's run(): Fail and GitError become results; UsageError and anything unexpected still reach the
// dispatcher's errorResult. A GitError here means a ref or repo that git rejected, which is an environment error (2).
export function guarded(fn) {
  return async (argv, ctx) => {
    try {
      return await fn(argv, ctx);
    } catch (err) {
      if (err instanceof Fail) return { exitCode: err.exitCode, output: err.output };
      if (err instanceof GitError) return { exitCode: EXIT.USAGE, output: { ok: false, error: 'git', message: err.message } };
      throw err;
    }
  };
}

// `--repo DIR` (default: the directory the command was run from) resolved to the repository's top level, so a skill
// running from a subdirectory or a worktree still addresses the right .claude/pipeline.yml and .review/.
export function resolveRepo(values, ctx) {
  const dir = path.resolve(ctx?.cwd ?? process.cwd(), values.repo ?? '.');
  try {
    return repoRoot(dir);
  } catch (err) {
    if (err instanceof GitError) throw new Fail(EXIT.USAGE, { ok: false, error: 'repo', message: `not a git repository: ${dir}` });
    throw err;
  }
}

// The validated config, or exit 2 { ok:false, error:'config', errors } when it is missing or invalid.
export async function requireConfig(root) {
  const loaded = await loadConfig(root);
  if (!loaded.ok) throw new Fail(EXIT.USAGE, { ok: false, error: 'config', errors: loaded.errors, path: loaded.path });
  return loaded;
}

// `--labels a,b` -> ['a', 'b']. Exact names (no case folding): an approval only counts when it is spelled the way the
// pipeline's own labels are, and a miss costs one label fix, not a bypass.
export function parseLabels(raw) {
  if (raw === undefined) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}
