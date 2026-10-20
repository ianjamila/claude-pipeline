// #58: the owner's chat "merge", as the owner-go recorder writes it. `P merge` reads the records from the account's real home
// (never $HOME, which the agent could point elsewhere), so a test writes its record there under a random session name and
// deletes it afterwards (t.after). A random temp-repo head never matches anything else.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ownerGoDir, recordApproval } from '../../pipeline/hooks/lib/owner-go.mjs';

// What the recorder writes when the owner types `prompt` after a reply that showed `reply`. Returns the record (or null).
export function ownerSays(t, prompt, reply) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-go-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, `${[
    { type: 'user', message: { content: 'ship it' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    { type: 'user', message: { content: prompt } },
  ].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const session = `test-${randomUUID()}`;
  const record = recordApproval({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript, cwd: dir, prompt });
  t.after(() => {
    rmSync(join(ownerGoDir(), `${session}.jsonl`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return record;
}

// The reply's merge request, as the ship skill shows it (Owner-merge approval).
export const mergeRequest = (pr, head, items) => `Owner items listed above.\nHead ${head.slice(0, 12)} · items ${items}\n🔀 Ready to merge #${pr} — say "merge"`;

// The flags P merge takes for it.
export const approvalFlags = (head, items) => ['--owner-approved-head', head, '--owner-approved-items', items];

// ---- owner stops (chat mode): the reply the controller prints at a stop, and the owner's release ---------------------------
// Needs a ruling or a resume: `Stopped` line(s), then the ⏸ line. With `merge: {head, items}` it is the retry offer instead
// (`Stopped` line(s), Head line, 🔀 line). `ids` may be one id or several (one `Stopped` line each).
export function stopReply(pr, ids, { merge = null } = {}) {
  const lines = [].concat(ids).map((id) => `Stopped #${pr} · stop ${id}`);
  if (merge) return `${lines.join('\n')}\nHead ${merge.head.slice(0, 12)} · items ${merge.items}\n🔀 Ready to merge #${pr} — say "merge"`;
  return `${lines.join('\n')}\n⏸ Waiting on you for #${pr} — rule in chat, then say "ship resume ${pr}"`;
}

// What the recorder writes when the owner types `ship resume <pr>` after `reply`.
export const resumeSays = (t, pr, reply, prompt = `ship resume ${pr}`) => ownerSays(t, prompt, reply);
