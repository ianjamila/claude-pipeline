// Shared CLI plumbing so every subcommand behaves the same: one JSON object on stdout,
// human notes on stderr, and a small fixed set of exit codes the skills can branch on.
import { parseArgs } from 'node:util';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, UNAVAILABLE: 3 });

export class UsageError extends Error {}
export class UnavailableError extends Error {}

// Parse argv for one command. `options` uses node:util parseArgs syntax; unknown flags are
// usage errors rather than silently ignored, because a typo'd safety flag must not pass.
export function parseCommandArgs(argv, options = {}, { allowPositionals = true } = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
}

export function requireOption(values, name) {
  const v = values[name];
  if (v === undefined || v === null || v === '') throw new UsageError(`missing --${name}`);
  return v;
}

export function intOption(values, name, { required = false, min = -Infinity, max = Infinity } = {}) {
  const raw = values[name];
  if (raw === undefined) {
    if (required) throw new UsageError(`missing --${name}`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer in ${min}..${max}`);
  return n;
}

// Commands return { exitCode, output }; output is serialised as the single stdout JSON object, indented unless the
// command asks for `compact: true` (one line, for a log that is appended to). `silent: true` prints nothing at all (a
// scheduled job's quiet run); only the exit code is returned.
export function emit({ exitCode = EXIT.OK, output = {}, compact = false, silent = false }, { stdout = process.stdout } = {}) {
  if (silent) return exitCode;
  stdout.write(JSON.stringify(output, null, compact ? 0 : 2) + '\n');
  return exitCode;
}

export function errorResult(err) {
  if (err instanceof UsageError) return { exitCode: EXIT.USAGE, output: { ok: false, error: 'usage', message: err.message } };
  if (err instanceof UnavailableError) return { exitCode: EXIT.UNAVAILABLE, output: { ok: false, error: 'unavailable', message: err.message } };
  return { exitCode: EXIT.USAGE, output: { ok: false, error: 'internal', message: String(err?.stack || err) } };
}
