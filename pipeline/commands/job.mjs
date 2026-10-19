// Detached jobs for commands that outlive a Bash tool call (full verify, CI waits, Codex reviews): `start` runs a
// command in the background, `wait`/`read` report on it. Jobs live in <repo>/.review/jobs/<name>/ and run from the
// repo root. `start` is also a guard: it refuses any command the git guard or the file guard would deny, so "use a
// job" is never a way around a hook. Exit codes: 0 started / running / finished OK, 1 refused / failed / lost /
// already running, 2 usage error or no such job.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guardVerdict } from '../lib/command-guard.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { headSha } from '../lib/git.mjs';
import { startJob, waitJob, readJob } from '../lib/jobs.mjs';
import { escapeArgument } from '../lib/proc.mjs';

export const meta = {
  summary: 'run a long command detached (start), poll it (wait), or read its state (read)',
  usage: [
    'pipeline job start [--repo DIR] [--tag TAG] NAME -- CMD...   -> {ok, name, jobDir, pid, runId, tag}; exit 1 {ok:false, refused:true, reason} when a guard denies CMD',
    '  --tag TAG: what the job is about (default: the repo HEAD sha); keep the returned runId and hand it to wait/read as --run-id',
    'pipeline job wait  [--repo DIR] [--run-id ID] NAME [--timeout SEC]   (default 540, max 570) -> {ok, name, state, tag, runId, exitCode?, tail}',
    'pipeline job read  [--repo DIR] [--run-id ID] NAME   -> same shape, without waiting',
    '  --run-id ID: the runId start returned; if the job name was started again since, state is "replaced" ({ok:false}, exit 1)',
    '  exit 0: running, or done with exit code 0 · exit 1: done non-zero, lost, replaced, refused, name already running · exit 2: no such job / usage',
    '  CMD is the argument list after "--"; arguments with spaces, quotes or shell metacharacters are quoted for the shell',
    '  that runs the job (POSIX single quotes; on Windows double quotes), so each stays ONE argument. For pipes, &&, or',
    '  redirects pass a shell explicitly: job start NAME -- bash -c "a && b".',
  ].join('\n'),
};

export const MAX_WAIT_SECONDS = 570;
export const DEFAULT_WAIT_SECONDS = 540;
const POLL_MS = 250;

const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WIN_SAFE = /^[A-Za-z0-9_@+=:,./\\-]+$/;

// One argument, quoted so the job's shell reads it back as exactly that one argument.
function quoteArg(arg, platform) {
  if (platform === 'win32') return WIN_SAFE.test(arg) ? arg : escapeArgument(arg, false); // cmd.exe: "..." with ^-escaped metacharacters
  return POSIX_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// The command line the job's shell will run: arguments joined with single spaces, each quoted only when it has to be.
export function quoteCommand(args, platform = process.platform) {
  return args.map((a) => quoteArg(String(a), platform)).join(' ');
}

// What the guards must judge. The runner hands the quoted line to a shell, so that is what really runs; but a caller
// who passed one argument holding a whole command line (`-- "git push origin main"`) MEANT the unquoted reading, which
// the hooks also judge. Either reading denying is a refusal (same rule as the hooks' job-start unwrapping).
function readings(args, platform) {
  return [...new Set([quoteCommand(args, platform), args.join(' ')])].filter((s) => s.trim() !== '');
}

function jobError(err) {
  const message = String(err?.message ?? err);
  if (/^invalid job name/.test(message)) return new UsageError(message);
  if (/already running/.test(message)) return { exitCode: EXIT.FAILED, output: { ok: false, error: 'already-running', message } };
  return { exitCode: EXIT.USAGE, output: { ok: false, error: 'job', message } };
}

// The default tag. A repo with no commit yet has no HEAD; the tag is a label, not evidence, so that is "untagged".
function headOrNull(root) {
  try {
    return headSha({ cwd: root });
  } catch {
    return undefined;
  }
}

async function start(rest, ctx) {
  const dd = rest.indexOf('--');
  if (dd < 0) throw new UsageError('job start needs "--" before the command: pipeline job start NAME -- CMD...');
  const { values, positionals } = parseCommandArgs(rest.slice(0, dd), { repo: { type: 'string' }, tag: { type: 'string' } });
  if (positionals.length !== 1) throw new UsageError('job start takes exactly one NAME before "--"');
  if (values.tag !== undefined && values.tag.trim() === '') throw new UsageError('--tag must not be empty');
  const [name] = positionals;
  const args = rest.slice(dd + 1);
  if (args.length === 0 || args[0].trim() === '') throw new UsageError('job start needs a command after "--"');

  const root = resolveRepo(values, ctx);
  const env = ctx?.env ?? process.env;
  const platform = process.platform;

  // startJob runs this before it touches the filesystem, so a refused command leaves no job directory behind.
  let refusal = null;
  const policy = () => {
    for (const reading of readings(args, platform)) {
      const verdict = guardVerdict(reading, { cwd: root, env });
      if (!verdict.allow) {
        refusal = verdict.reason;
        return verdict;
      }
    }
    return { allow: true };
  };

  try {
    const started = startJob(name, quoteCommand(args, platform), { cwd: root, policy, tag: values.tag ?? headOrNull(root) });
    return { exitCode: EXIT.OK, output: { ok: true, ...started } };
  } catch (err) {
    if (refusal !== null) return { exitCode: EXIT.FAILED, output: { ok: false, refused: true, reason: refusal } };
    const mapped = jobError(err);
    if (mapped instanceof UsageError) throw mapped;
    return mapped;
  }
}

// running and done-with-0 are fine; done-nonzero and lost are failures; a job that never existed is a usage-level error.
function jobResult(name, snap) {
  if (snap.state === 'missing') {
    return { exitCode: EXIT.USAGE, output: { ok: false, name, error: 'not-found', ...snap } };
  }
  const ok = snap.state === 'running' || (snap.state === 'done' && snap.exitCode === 0);
  return { exitCode: ok ? EXIT.OK : EXIT.FAILED, output: { ok, name, ...snap } };
}

function nameOf(positionals, sub) {
  if (positionals.length !== 1) throw new UsageError(`job ${sub} takes exactly one NAME`);
  return positionals[0];
}

async function inspect(sub, rest, ctx) {
  const options = { repo: { type: 'string' }, 'run-id': { type: 'string' }, ...(sub === 'wait' ? { timeout: { type: 'string' } } : {}) };
  const { values, positionals } = parseCommandArgs(rest, options);
  const name = nameOf(positionals, sub);
  const timeoutSec = sub === 'wait' ? intOption(values, 'timeout', { min: 0, max: MAX_WAIT_SECONDS }) ?? DEFAULT_WAIT_SECONDS : 0;
  const root = resolveRepo(values, ctx);
  const expectRunId = values['run-id'];
  if (expectRunId !== undefined && expectRunId.trim() === '') throw new UsageError('--run-id must not be empty');
  try {
    const snap = sub === 'wait'
      ? await waitJob(name, { cwd: root, timeoutMs: timeoutSec * 1000, pollMs: POLL_MS, expectRunId })
      : readJob(name, { cwd: root, expectRunId });
    return jobResult(name, snap);
  } catch (err) {
    const mapped = jobError(err);
    if (mapped instanceof UsageError) throw mapped;
    return mapped;
  }
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'start') return start(rest, ctx);
  if (sub === 'wait' || sub === 'read') return inspect(sub, rest, ctx);
  throw new UsageError('usage: pipeline job (start [--tag TAG] NAME -- CMD... | wait [--run-id ID] NAME [--timeout SEC] | read [--run-id ID] NAME)');
});
