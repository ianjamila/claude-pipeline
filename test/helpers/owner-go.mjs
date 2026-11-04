// #58: the owner's chat "merge", as the owner-go recorder writes it. `P merge` reads the records from the account's real home
// (never $HOME, which the agent could point elsewhere), so a test writes its record there under a random session name and
// deletes it afterwards (t.after, and at process exit for a test that died before t.after ran).
// ISOLATION (#122): the folder is shared by every test and every concurrent run of the suite, and a ruling or a round grant matches on
// repository, PR and item (or round) only. A test that records those must build its world with a repository name of its own
// (test/cli-review.test.mjs ownerWorld: a unique slug per test), so its records can never match another test's or another process's.
// Approval records are bound to a head instead; the temp repos use fixed author details, so identical fixtures made in the same second
// can share heads - callers of ownerSays keep that known risk (tracked in a follow-up issue).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ownerGoDir, recordApproval, recordRoundGrant, recordRuling } from '../../pipeline/hooks/lib/owner-go.mjs';

// What the recorder writes when the owner types `prompt` after a reply that showed `reply`. Returns the record (or null).
export const ownerSays = (t, prompt, reply) => said(t, prompt, reply, recordApproval);
// Phase 3b: the same for a ruling (the reply ends with rulingRequest's line).
export const ownerRules = (t, prompt, reply) => said(t, prompt, reply, recordRuling);

// Owner-granted extra round: the same for the owner's `extra round` (the reply ends with roundRequest's line).
export const ownerGrants = (t, prompt, reply) => said(t, prompt, reply, recordRoundGrant);

// Files this process wrote and has not removed yet. Removed at exit, so an uncaught error or a failed test before t.after still leaves
// nothing behind. Only paths this process itself wrote are ever touched: production accepts `test-<uuid>` session names and reads
// consumed grants without an age limit, so a sweep of the folder by name or age could destroy real owner evidence.
const leftovers = new Set();
let exitHook = false;
export function cleanupAtExit(file) {
  leftovers.add(file);
  if (exitHook) return;
  exitHook = true;
  process.on('exit', () => { for (const f of leftovers) rmSync(f, { force: true }); });
}

function said(t, prompt, reply, recorder) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-go-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, `${[
    { type: 'user', message: { content: 'ship it' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    { type: 'user', message: { content: prompt } },
  ].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const session = `test-${randomUUID()}`;
  const file = join(ownerGoDir(), `${session}.jsonl`);
  cleanupAtExit(file);
  const record = recorder({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript, cwd: dir, prompt });
  t.after(() => {
    rmSync(file, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return record;
}

// The reply's merge request, as the ship skill shows it (Owner-merge approval). Phase 3b: it names the repository (the fake gh's by
// default, fakegh-env.mjs REPO_VIEW); null leaves the repo out, as a request from before Phase 3b did.
export const mergeRequest = (pr, head, items, repo = 'acme/widgets') => `Owner items listed above.\nHead ${head.slice(0, 12)} · items ${items}${repo === null ? '' : ` · repo ${repo}`}\n🔀 Ready to merge #${pr} — say "merge"`;

// A reply that asks the owner to rule on review items, as the ship skill ends it (review-loop.md, Owner rules in chat).
// #110: the line carries the content digest `P triage ruling-request` prints (a placeholder unless a test passes the real one).
export const rulingRequest = (pr, ids, repo = 'acme/widgets', content = 'c0ffee000000') => `R1-B1 is waiting for your decision.\n⚖️ Owner ruling needed #${pr}: ${ids.join(', ')}${content === null ? '' : ` · content ${content}`} · repo ${repo}`;

// A reply that asks for one more counted review round, as `P triage round-request` prints it (k = the counted ordinal; head >= 12 hex).
export const roundRequest = (pr, k, head, repo = 'acme/widgets') => `Round ${k - 1} left items open.\n🔁 Extra review round needed #${pr}: round ${k} · head ${head.slice(0, 12)} · repo ${repo}`;

// The flags P merge takes for it.
export const approvalFlags = (head, items) => ['--owner-approved-head', head, '--owner-approved-items', items];
