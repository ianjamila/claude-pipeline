// `pipeline stacks`: automatic stop of private local Supabase stacks (and a session's own dev server) once nobody needs them.
// Spec: docs/specs/2026-10-19-stack-stop-design.md. This file currently wires only `session-end`, the detached worker the
// SessionEnd hook starts (see lib/stacks/session-end.mjs); the sweep and the other subcommands arrive with Task 12b.
// Windows: every subcommand answers "not supported on Windows" (exit 2).
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { runSessionEnd } from '../lib/stacks/session-end.mjs';

export const meta = {
  summary: 'stop private local Supabase stacks and dev servers once nobody needs them (session-end worker)',
  usage: 'pipeline stacks session-end --owner PID:BIRTH   -> {ok, waited, stacks:[...], dev:[...]}',
};

const OWNER_RE = /^(\d+):(\d+)$/;

export function parseOwner(text) {
  const m = OWNER_RE.exec(String(text ?? ''));
  if (!m) throw new UsageError('--owner must be PID:BIRTH (birth = epoch seconds)');
  const owner = { pid: Number(m[1]), birth: Number(m[2]) };
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isSafeInteger(owner.birth)) throw new UsageError('--owner must be PID:BIRTH (birth = epoch seconds)');
  return owner;
}

export async function run(argv, ctx = {}) {
  const [sub, ...rest] = argv;
  if (process.platform === 'win32') return { exitCode: EXIT.USAGE, output: { ok: false, error: 'unsupported', message: 'not supported on Windows' } };
  if (sub !== 'session-end') throw new UsageError(`stacks needs a subcommand: session-end --owner PID:BIRTH${sub ? ` (got ${JSON.stringify(sub)})` : ''}`);
  const { values } = parseCommandArgs(rest, { owner: { type: 'string' } }, { allowPositionals: false });
  const owner = parseOwner(values.owner);
  const result = await runSessionEnd({ owner, deps: ctx.env ? { env: ctx.env } : {} });
  return { exitCode: EXIT.OK, output: { ok: true, ...result }, compact: true };
}
