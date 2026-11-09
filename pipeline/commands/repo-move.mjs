// `pipeline repo-move`: the owner records that a GitHub repository was renamed or transferred, so the owner-go records (your chat "merge",
// rulings and extra-round grants, which store the repository name as it was shown) made BEFORE the move still count for the new name.
// One way only and only for records that predate the move (hooks/lib/repo-moves.mjs). Run in your own terminal: like `pipeline update` it
// refuses inside Claude Code (an agent must not widen what its own approvals cover) unless the owner's admin switch is on. `--list` is allowed anywhere.
// The move is checked with GitHub first: the old name must resolve (GitHub redirects it) to the new full name and the same repository id.
import { EXIT, parseCommandArgs, UsageError } from '../lib/cli.mjs';
import { hasClaudeCodeAncestor } from '../lib/claude-ancestry.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { appendRepoMove, REPO_NAME, readRepoMoves, repoMovesPath } from '../hooks/lib/repo-moves.mjs';

export const meta = {
  summary: 'record that a GitHub repository was renamed or transferred, so your earlier owner approvals still count (run in your own terminal); --list shows the records',
  usage: [
    'pipeline repo-move --list   -> {ok, file, moves, error}',
    'pipeline repo-move --from <owner/name> --to <owner/name> [--at <ISO time>]   -> {ok, added, move, moves, file}',
    '  Records the move in ~/.claude/pipeline-state/owner-go/repo-moves.json (agents cannot write it). GitHub must confirm it: the old name has to',
    '  resolve to the new full name and to the same repository id. --at is when the move happened (default: now; at most 5 minutes ahead of now); only approvals, rulings and',
    '  grants made BEFORE it count for the new name, never the other way round. Adding the same move (same time) twice is a no-op, the same names at a later time are appended (a move back and forth); an invalid existing file',
    '  is refused (fix or remove it).',
    '  Refuses inside Claude Code (run it in your own terminal) unless --list is given or the owner launched Claude Code with the admin switch.',
  ].join('\n'),
};

const FUTURE_SLACK_MS = 5 * 60 * 1000; // clock skew allowance for --at
const NAME = new RegExp(`^${REPO_NAME}$`);

// { fullName, id } of what GitHub answers for `repos/<name>` (id null when it is not a positive integer).
function lookup(gh, name) {
  const text = String(gh.apiText(`repos/${name}`, '[.full_name, .id] | @tsv')).trim();
  const [fullName, id] = text.split('\t');
  return { fullName: fullName ?? '', id: /^[1-9][0-9]{0,15}$/.test(id ?? '') ? Number(id) : null };
}

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const { values } = parseCommandArgs(argv, { list: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }, at: { type: 'string' } }, { allowPositionals: false });
  const home = ctx.home;
  const file = repoMovesPath(home);

  if (values.list) {
    if (values.from !== undefined || values.to !== undefined || values.at !== undefined) throw new UsageError('--list takes no other option');
    const r = readRepoMoves({ home });
    return { exitCode: r.error ? EXIT.FAILED : EXIT.OK, output: { ok: !r.error, file, moves: r.moves, error: r.error } };
  }

  if (env.PIPELINE_ADMIN !== '1') {
    const inside = env.CLAUDECODE === '1'
      ? 'CLAUDECODE=1'
      : (ctx.hasClaudeCodeAncestor ?? hasClaudeCodeAncestor)() ? 'a Claude Code process is an ancestor of this one' : null;
    if (inside) {
      const message = `pipeline repo-move refuses to run inside a Claude Code session (${inside}): it widens which of your approvals count. Run it in your own terminal (\`node ~/.claude/pipeline/bin/pipeline.mjs repo-move --from <old> --to <new>\`); \`--list\` is allowed anywhere.`;
      process.stderr.write(`${message}\n`);
      return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
    }
  }

  const from = values.from;
  const to = values.to;
  if (!from || !to) throw new UsageError('give --from <owner/name> and --to <owner/name> (or --list)');
  if (!NAME.test(from) || !NAME.test(to)) throw new UsageError('--from and --to must be owner/name');
  if (from.toLowerCase() === to.toLowerCase()) throw new UsageError('--from and --to are the same repository name');
  const atMs = values.at === undefined ? (ctx.now ?? Date.now)() : Date.parse(values.at);
  if (!Number.isFinite(atMs)) throw new UsageError('--at must be a time such as 2026-11-09T06:58:25Z');

  if (atMs > (ctx.now ?? Date.now)() + FUTURE_SLACK_MS) throw new UsageError('--at is in the future: GitHub has already confirmed the move, so it cannot be later than now + 5 minutes (give the time it happened)');

  return guardGh(async () => {
    const gh = createGitHub({ cwd: ctx.cwd ?? process.cwd(), env, ghFn: ctx.ghFn });
    const old = lookup(gh, from);
    const now = lookup(gh, to);
    const refuse = (message) => ({ exitCode: EXIT.FAILED, output: { ok: false, error: 'not-confirmed', message } });
    if (old.fullName.toLowerCase() !== to.toLowerCase()) return refuse(`GitHub does not resolve ${from} to ${to} (it answers ${old.fullName || 'nothing'}): nothing recorded`);
    if (old.id === null || old.id !== now.id) return refuse(`${from} and ${to} are not the same repository on GitHub (ids ${old.id ?? 'unknown'} and ${now.id ?? 'unknown'}): nothing recorded`);
    const move = { from, to, at: new Date(atMs).toISOString(), repoId: old.id };
    const r = appendRepoMove(move, { home });
    if (!r.ok) return { exitCode: EXIT.FAILED, output: { ok: false, error: 'not-written', message: r.reason, file } };
    // report this very entry (names lower-cased as stored, matched by time too), not the first same-name entry in the file: A -> B can recur.
    const reported = r.moves.findLast((m) => m.from === from.toLowerCase() && m.to === to.toLowerCase() && Date.parse(m.at) === atMs);
    process.stderr.write(r.added ? `recorded: ${from} -> ${to} (${move.at}) in ${file}\n` : `already recorded: ${from} -> ${to}\n`);
    return { exitCode: EXIT.OK, output: { ok: true, added: r.added, move: reported, moves: r.moves, file } };
  });
}
