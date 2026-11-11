// `pipeline owner-go`: the owner's side of click-to-approve (#261). A click on a choice dialog only counts when no hook can answer that dialog for the owner, so the hooks that run on
// AskUserQuestion are listed once by the owner (hooks/lib/dialog-hooks.mjs, plan Rev 6 B5). `dialog-hooks` reports the status and is allowed anywhere; `approve-dialog-hooks` writes the list and,
// like `pipeline update`, refuses inside Claude Code (an agent must not approve its own hooks) unless the owner's admin switch is on.
import { EXIT, parseCommandArgs, UsageError } from '../lib/cli.mjs';
import { insideClaudeCode } from '../lib/owner-only.mjs';
import { approveDialogHooks, checkDialogHooks, dialogHooksFile } from '../hooks/lib/dialog-hooks.mjs';

export const meta = {
  summary: 'click-to-approve: show the hooks that run on the choice dialog (dialog-hooks) or list them as approved (approve-dialog-hooks, run in your own terminal)',
  usage: [
    'pipeline owner-go dialog-hooks   -> {ok, reason, hookLayersSha256, handlers, offenders, approvedAt, file}',
    '  Read-only. Lists every PreToolUse / PermissionRequest hook that can match AskUserQuestion (user and project settings, managed settings, enabled plugins, skill and agent frontmatter) and',
    '  says which are trusted (installed pipeline code), approved (listed in ~/.claude/pipeline-state/owner-go/dialog-hooks.json with the same bytes) or not (unlisted, changed, unresolvable).',
    '  ok is true only when none is an offender; a click on a choice dialog counts as your approval only then, otherwise the typed words are needed.',
    'pipeline owner-go approve-dialog-hooks   -> {ok, file, hooks, approvedAt}',
    '  Writes ~/.claude/pipeline-state/owner-go/dialog-hooks.json from the hooks installed now (command, script path, sha256 of the script). Refuses (nothing written) when a hook command is not',
    '  one script (sh -c, npx, inline code, pipes) or a settings / plugin / skill file cannot be read. Run it again after you change one of those hooks.',
    '  Refuses inside Claude Code (run it in your own terminal) unless the owner launched Claude Code with the admin switch.',
  ].join('\n'),
};

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const { positionals } = parseCommandArgs(argv, {}, { allowPositionals: true });
  const [sub, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`);
  const home = ctx.home;
  const cwd = ctx.cwd ?? process.cwd();
  const managed = ctx.managedPaths ? { managedPaths: ctx.managedPaths } : {};

  if (sub === 'dialog-hooks') {
    const r = checkDialogHooks({ home, cwd, ...managed });
    return {
      exitCode: r.ok ? EXIT.OK : EXIT.FAILED,
      output: { ok: r.ok, reason: r.reason, hookLayersSha256: r.hookLayersSha256, handlers: r.handlers, offenders: r.offenders, approvedAt: r.approvedAt, file: dialogHooksFile(home) },
    };
  }

  if (sub === 'approve-dialog-hooks') {
    const inside = insideClaudeCode(env, ctx);
    if (inside) {
      const message = `pipeline owner-go approve-dialog-hooks refuses to run inside a Claude Code session (${inside}): it decides which hooks may sit on the approval dialog. Run it in your own terminal (\`node ~/.claude/pipeline/bin/pipeline.mjs owner-go approve-dialog-hooks\`).`;
      process.stderr.write(`${message}\n`);
      return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
    }
    const r = approveDialogHooks({ home, cwd, now: ctx.now, ...managed });
    if (!r.ok) {
      process.stderr.write(`not approved: ${r.reason}\n`);
      return { exitCode: EXIT.FAILED, output: { ok: false, error: 'not-approved', message: r.reason, offenders: r.offenders } };
    }
    process.stderr.write(r.hooks.length === 0 ? `recorded: no dialog hooks need approval (${r.file})\n` : `recorded ${r.hooks.length} dialog hook(s) in ${r.file}:\n${r.hooks.map((h) => `  ${h.scriptPath}  ${h.sha256.slice(0, 12)}`).join('\n')}\n`);
    return { exitCode: EXIT.OK, output: { ok: true, file: r.file, hooks: r.hooks, approvedAt: r.approvedAt } };
  }

  throw new UsageError('give a subcommand: dialog-hooks | approve-dialog-hooks');
}
