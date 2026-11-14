// #261 (click-to-approve, PR A, plan Rev 6 B6): what `--ask` on `merge --dry-run --owner-go`, `triage round-request` and `triage ruling-request` share. The command prints the typed closing
// block exactly as before; with `--ask` it also issues the matching ask (hooks/lib/owner-go-click.mjs) and prints `ask: { askId, questions }` for the review skill to hand to AskUserQuestion
// VERBATIM, or `ask: null, askSkipped: <reason>` when a click cannot count here (the owner then types, as before). Nothing here decides what the owner may approve: the question text is the
// typed block and the recorder reads the click through the typed parsers.
import { checkDialogHooks } from '../hooks/lib/dialog-hooks.mjs';
import { issueAsk } from '../hooks/lib/owner-go-click.mjs';

// May a click stand in for the owner's typed words in this repository, on this machine, right now? -> { ok: true, hookLayersSha256 } | { ok: false, reason }.
// Checked in this order: owner_approval chat (label mode has no typed words to replace), pipeline.yml `owner_go.click` (a repository may only switch clicks OFF), the dialog hooks (B5: a hook
// that could answer the dialog for the owner must be one the owner approved, `pipeline owner-go approve-dialog-hooks`).
// Why a click cannot count under THIS config (the part of the gate that needs no hooks), or null. merge --prs reads it from each PR's own worktree (R26-B1).
export function clickConfigRefusal(config) {
  if (config.owner_approval !== 'chat') return 'owner_approval is not chat (label mode: no typed words to replace)';
  if (config.owner_go?.click === 'off') return 'owner_go.click is off in pipeline.yml';
  return null;
}

export function clickGate({ config, root, ctx = {} }) {
  const refusal = clickConfigRefusal(config);
  if (refusal !== null) return { ok: false, reason: refusal };
  let hooks;
  try {
    hooks = checkDialogHooks({ home: ctx.home, cwd: root, projectDirs: [process.env.CLAUDE_PROJECT_DIR], managedPaths: ctx.managedPaths });
  } catch (err) {
    return { ok: false, reason: `the dialog hooks could not be checked (${String(err?.message ?? err).slice(0, 200)})` };
  }
  if (!hooks.ok) return { ok: false, reason: `dialog hooks not approved: ${hooks.reason} (the owner runs \`pipeline owner-go approve-dialog-hooks\` in their own terminal)` };
  return { ok: true, hookLayersSha256: hooks.hookLayersSha256 };
}

// The fields to add to a command's output: { ask: { askId, questions } } or { ask: null, askSkipped }. `parts` = what a builder (mergeAsk, roundAsk, rulingAsk, mergeManyAsk) returned, or null
// when there is nothing to ask (then `unaskable` says why).
export function askFields({ gate, parts, unaskable, ctx = {} }) {
  if (!gate.ok) return { ask: null, askSkipped: gate.reason };
  if (parts === null || parts === undefined) return { ask: null, askSkipped: unaskable ?? 'nothing to ask' };
  const issued = issueAsk({ ...parts, hookLayersSha256: gate.hookLayersSha256, home: ctx.home });
  if (issued.error) return { ask: null, askSkipped: `the ask could not be issued: ${issued.error}` };
  return { ask: { askId: issued.askId, questions: issued.questions } };
}
