// #58: the owner's chat "merge", as the owner-go recorder writes it. `P merge` reads the records from the account's real home
// (never $HOME, which the agent could point elsewhere), so a test writes its record there under a random session name and
// deletes it afterwards (t.after). A random temp-repo head never matches anything else.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ownerGoDir, recordApproval, recordRuling } from '../../pipeline/hooks/lib/owner-go.mjs';

// What the recorder writes when the owner types `prompt` after a reply that showed `reply`. Returns the record (or null).
export const ownerSays = (t, prompt, reply) => said(t, prompt, reply, recordApproval);
// Phase 3b: the same for a ruling (the reply ends with rulingRequest's line).
export const ownerRules = (t, prompt, reply) => said(t, prompt, reply, recordRuling);

function said(t, prompt, reply, recorder) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-go-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, `${[
    { type: 'user', message: { content: 'ship it' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    { type: 'user', message: { content: prompt } },
  ].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const session = `test-${randomUUID()}`;
  const record = recorder({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript, cwd: dir, prompt });
  t.after(() => {
    rmSync(join(ownerGoDir(), `${session}.jsonl`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return record;
}

// The reply's merge request, as the ship skill shows it (Owner-merge approval). Phase 3b: it names the repository (the fake gh's by
// default, fakegh-env.mjs REPO_VIEW); null leaves the repo out, as a request from before Phase 3b did.
export const mergeRequest = (pr, head, items, repo = 'acme/widgets') => `Owner items listed above.\nHead ${head.slice(0, 12)} · items ${items}${repo === null ? '' : ` · repo ${repo}`}\n🔀 Ready to merge #${pr} — say "merge"`;

// A reply that asks the owner to rule on review items, as the ship skill ends it (review-loop.md, Owner rules in chat).
export const rulingRequest = (pr, ids, repo = 'acme/widgets') => `R1-B1 is waiting for your decision.\n⚖️ Owner ruling needed #${pr}: ${ids.join(', ')} · repo ${repo}`;

// The flags P merge takes for it.
export const approvalFlags = (head, items) => ['--owner-approved-head', head, '--owner-approved-items', items];
