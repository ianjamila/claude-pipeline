#!/usr/bin/env node
// Why (#58): global UserPromptSubmit hook (~/.claude/settings.json) that records the owner's chat "merge", and (Phase 3b) the owner's
// answer to a review-item ruling request, and the owner's `extra round` for one more review round past the cap (lib/owner-go.mjs has
// the rules and the residual). Only a prompt the owner types reaches this event; the model cannot raise it. It must never
// block a prompt: it always exits 0, and it is started WITHOUT the guards' fail-closed loader (an exit 2 here would swallow
// the owner's message). On UserPromptSubmit, stdout is added to the model's context: one line says what was recorded, so the
// agent can run `P merge` with the matching flags; nothing is printed otherwise.
try {
  const { readHookInput } = await import('./lib/hook-io.mjs');
  const { recordApproval, recordRuling, recordRoundGrant } = await import('./lib/owner-go.mjs');
  const input = await readHookInput();
  const record = recordApproval(input);
  const ruling = recordRuling(input);
  const round = recordRoundGrant(input);
  if (ruling) process.stdout.write(`[claude-pipeline owner-go] the owner's ruling is recorded for ${ruling.repo} #${ruling.pr}: ${ruling.ids.join(', ')} (pass words from it as --owner-quote).\n`);
  if (round) process.stdout.write(`[claude-pipeline owner-go] the owner's extra round is recorded for ${round.repo} #${round.pr} counted round ${round.k} head ${round.head.slice(0, 12)}: run P codex-review --pr ${round.pr} --round <the n from round-request>\n`);
  if (record) {
    const shown = record.requests.map((q) => `${q.repo ?? '(no repo: approves nothing)'} #${q.pr} head ${q.head} items ${q.items}`);
    const prs = record.prs.map((n) => `#${n}`).join(', ');
    process.stdout.write(`[claude-pipeline owner-go] the owner's "merge" is recorded: ${shown.length ? shown.join('; ') : 'no Head/items/repo request was shown in the last merge request'}${prs ? `; PRs ${prs}` : ''}.\n`);
  }
} catch { /* never block or break a prompt */ }
process.exitCode = 0;
