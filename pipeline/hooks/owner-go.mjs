#!/usr/bin/env node
// Why (#58): global UserPromptSubmit hook (~/.claude/settings.json) that records the owner's chat "merge", and (Phase 3b) the owner's
// answer to a review-item ruling request, and the owner's `extra round` for one more review round past the cap (lib/owner-go.mjs has
// the rules and the residual). The owner's typed prompts reach this event, and (#128) so do harness-injected turns (task notices, peer and
// scheduled messages), which the recorders therefore screen out. It must never
// block a prompt: it always exits 0, and it is started WITHOUT the guards' fail-closed loader (an exit 2 here would swallow
// the owner's message). On UserPromptSubmit, stdout is added to the model's context: one line says what was recorded, so the
// agent can run `P merge` with the matching flags; nothing is printed otherwise, except (#128) one line when the owner's prompt reads as a ruling
// answer that nothing was recorded for (the agent must ask again), and (#191) one line when the owner's "merge", "extra round" or ruling answer was typed
// while the agent was still working (a queued prompt records nothing).
// (#261) The SAME script is also registered on PostToolUse for AskUserQuestion (click-to-approve, lib/owner-go-click.mjs): the owner's click on a dialog the pipeline
// issued is verified against the transcript and recorded like the typed words (lib/owner-go-click-hook.mjs). PostToolUse plain stdout does NOT reach the model, so the line goes out as JSON hookSpecificOutput.additionalContext (R1-F1): one line says the
// click is recorded, declined (nothing approved) or could not be verified (the owner types the closing words instead); nothing is printed for an AskUserQuestion that is
// not one of ours. The dialog-hook check (lib/dialog-hooks.mjs) is loaded lazily: if it cannot load, no click is admitted.
async function onPrompt(input) {
  const { recordApproval, recordRuling, recordRoundGrant, rulingNudge, queuedNudge } = await import('./lib/owner-go.mjs');
  const record = recordApproval(input);
  const ruling = recordRuling(input);
  const round = recordRoundGrant(input);
  // (#191 F3) a queued answer records nothing; its nudge takes precedence over the ruling nudge
  const nudge = ruling || round ? null : (queuedNudge(input) ?? rulingNudge(input));
  if (ruling) process.stdout.write(`[claude-pipeline owner-go] the owner's ruling is recorded for ${ruling.repo} #${ruling.pr}: ${ruling.ids.join(', ')} (pass words from it as --owner-quote).\n`);
  if (round) process.stdout.write(`[claude-pipeline owner-go] the owner's extra round is recorded for ${round.repo} #${round.pr} counted round ${round.k} head ${round.head.slice(0, 12)}: run P codex-review --pr ${round.pr} --round <the n from round-request>\n`);
  else if (nudge) process.stdout.write(`${nudge}\n`);
  if (record) {
    const shown = record.requests.map((q) => `${q.repo ?? '(no repo: approves nothing)'} #${q.pr} head ${q.head} items ${q.items}`);
    const prs = record.prs.map((n) => `#${n}`).join(', ');
    process.stdout.write(`[claude-pipeline owner-go] the owner's "merge" is recorded: ${shown.length ? shown.join('; ') : 'no Head/items/repo request was shown in the last merge request'}${prs ? `; PRs ${prs}` : ''}.\n`);
  }
}

try {
  const { readHookInput } = await import('./lib/hook-io.mjs');
  const input = await readHookInput();
  if (input?.hook_event_name === 'PostToolUse') {
    const { clickHookLine, clickHookOutput } = await import('./lib/owner-go-click-hook.mjs');
    const line = await clickHookLine(input);
    process.stdout.write(clickHookOutput(line));
  } else {
    await onPrompt(input);
  }
} catch { /* never block or break a prompt */ }
process.exitCode = 0;
