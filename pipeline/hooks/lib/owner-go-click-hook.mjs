// Why (#261): the PostToolUse half of hooks/owner-go.mjs, kept here so a test can hand it a home and a recorder (the hook script itself always runs, takes the account's real home
// and exits 0). One AskUserQuestion hook input -> the one line the agent is told, or null (nothing printed). Never throws.
import { recordClick } from './owner-go-click.mjs';

const HEAD = '[claude-pipeline owner-go]';

// The line for one click result, in the style of the typed lines (hooks/owner-go.mjs). null prints nothing.
export function clickLine(result) {
  if (result?.recorded) {
    const r = result.recorded;
    if (r.kind === 'ruling') return `${HEAD} the owner's click is recorded: ruling recorded for ${r.repo} #${r.pr}: ${(r.ids ?? []).join(', ')} (pass --owner-quote ${JSON.stringify(String(r.prompt ?? ''))})`;
    if (r.kind === 'extra-round') return `${HEAD} the owner's click is recorded: extra round for ${r.repo} #${r.pr} counted round ${r.k} head ${String(r.head).slice(0, 12)}: run P codex-review --pr ${r.pr} --round <the n from round-request>`;
    const reqs = Array.isArray(r.requests) ? r.requests : [];
    const shown = reqs.map((q) => `${q.repo ?? '(no repo: approves nothing)'} #${q.pr} head ${String(q.head).slice(0, 12)} items ${q.items}`);
    const runs = reqs.filter((q) => q.repo).map((q) => `P merge --pr ${q.pr} --owner-go`);
    return `${HEAD} the owner's click is recorded: "merge" for ${shown.length ? shown.join('; ') : 'no Head/items/repo request in the ask'}${runs.length ? ` — run ${runs.join(' and ')} now` : ''}`;
  }
  if (result?.declined !== undefined) return `${HEAD} the owner chose ${JSON.stringify(String(result.declined))}: nothing is approved; stop and say what stays open`;
  if (result?.refused) return `${HEAD} the click could not be verified (${result.refused}): ask the owner to type the closing words instead`;
  return null;
}

// (R1-F1) What the hook script writes to stdout for that line. Claude Code adds plain exit-0 stdout to the model's context only on UserPromptSubmit / SessionStart; on PostToolUse the
// channel is JSON `hookSpecificOutput.additionalContext`. '' (print nothing) when there is no line.
export function clickHookOutput(line) {
  if (typeof line !== 'string' || line === '') return '';
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } })}\n`;
}

// The dialog-hook check handed to the recorder, loaded lazily: a lib that will not load refuses the click ('dialog-hooks-unavailable') and breaks nothing else.
export async function dialogHookCheck({ home, input }, load = () => import('./dialog-hooks.mjs')) {
  try {
    const { checkDialogHooks } = await load();
    return await checkDialogHooks({ home, cwd: input?.cwd });
  } catch {
    return { ok: false, reason: 'dialog-hooks-unavailable' };
  }
}

// `record` and `check` are injectable for tests; the options go to recordClick (home, now, sleep, pollMs).
export async function clickHookLine(input, { record = recordClick, check = dialogHookCheck, ...opts } = {}) {
  try {
    if (input?.hook_event_name !== 'PostToolUse' || input.tool_name !== 'AskUserQuestion') return null;
    return clickLine(await record(input, { ...opts, hookCheck: check }));
  } catch {
    return null;
  }
}
