// #58: the owner's chat "merge", as the owner-go recorder writes it. `P merge` reads the records from the account's real home
// (never $HOME, which the agent could point elsewhere), so a test writes its record there under a random session name and
// deletes it afterwards (t.after, and at process exit for a test that died before t.after ran). A random temp-repo head never matches anything else.
// ISOLATION (#122): the folder is shared by every test and every concurrent run of the suite, and a ruling or a round grant matches on
// repository, PR and item (or round) only. A test that records those must build its world with a repository name of its own
// (test/cli-review.test.mjs ownerWorld: a unique slug per test), so its records can never match another test's or another process's.
// Approval records are bound to a head instead; the temp repos use fixed author details, so identical fixtures made in the same second
// can share heads - callers of ownerSays keep that known risk (tracked in a follow-up issue).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { accountHome, areasBlock, ownerGoDir, recordApproval, recordRoundGrant, recordRuling } from '../../pipeline/hooks/lib/owner-go.mjs';

const HOOK = fileURLToPath(new URL('../../pipeline/hooks/owner-go.mjs', import.meta.url));

// What Claude Code writes on a prompt entry the owner typed (#128): the use-time provenance check accepts a record only for such an entry.
export const OWNER_ENTRY = { origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli' };

// Where a test transcript lives: <account home>/.claude-ownergo-test-<uuid>/projects/-repo/t.jsonl, a root the use-time provenance check accepts (R1-B2; lib/paths.mjs isTranscriptFile).
// Codex #145 P1: only $CLAUDE_CONFIG_DIR and a folder directly under the account's home with the guard's name shape are roots, so a temp dir's own .claude/ no longer is one.
// Like the owner-go records, the folder lives in the account home, so it is removed after the test and at exit.
const transcriptIn = (t) => {
  const cfg = join(accountHome(), `.claude-ownergo-test-${randomUUID()}`);
  cleanupAtExit(cfg);
  t.after(() => rmSync(cfg, { recursive: true, force: true }));
  mkdirSync(join(cfg, 'projects', '-repo'), { recursive: true });
  return join(cfg, 'projects', '-repo', 't.jsonl');
};

// What the recorder writes when the owner types `prompt` after a reply that showed `reply`. Returns the record (or null).
// `entry` overrides the prompt entry's provenance fields (a test of a prompt that is NOT the owner's).
// `after` (#128 use-time check): once the record is written, the prompt's transcript entry is replaced by one with these provenance fields
// (the hook cannot always tell at record time), or removed with 'missing'. R2-F3: 'elsewhere' moves the transcript to <dir>/claude-config/projects/-repo/t.jsonl, the shape of a transcript in a custom config dir
// that the checking process does not know (the record's transcript_path is patched to it; the prompt entry is the owner's).
export const ownerSays = (t, prompt, reply, entry, after) => said(t, prompt, reply, recordApproval, entry, after);
// Phase 3b: the same for a ruling (the reply ends with rulingRequest's line).
export const ownerRules = (t, prompt, reply, entry, after) => said(t, prompt, reply, recordRuling, entry, after);
// Owner-granted extra round: the same for the owner's `extra round` (the reply ends with roundRequest's line).
export const ownerGrants = (t, prompt, reply, entry, after) => said(t, prompt, reply, recordRoundGrant, entry, after);

// Files this process wrote and has not removed yet. Removed at exit, so an uncaught error or a failed test before t.after still leaves
// nothing behind. Only paths this process itself wrote are ever touched: production accepts `test-<uuid>` session names and reads
// consumed grants without an age limit, so a sweep of the folder by name or age could destroy real owner evidence.
const leftovers = new Set();
let exitHook = false;
export function cleanupAtExit(file) {
  leftovers.add(file);
  if (exitHook) return;
  exitHook = true;
  process.on('exit', () => { for (const f of leftovers) rmSync(f, { recursive: true, force: true }); });
}

function said(t, prompt, reply, recorder, entry = OWNER_ENTRY, after = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-go-'));
  const transcript = transcriptIn(t);
  const promptId = `pid-${randomUUID()}`;
  writeFileSync(transcript, `${[
    { type: 'user', message: { content: 'ship it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY },
    { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    { type: 'user', message: { content: prompt }, promptId, ...entry },
  ].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const session = `test-${randomUUID()}`;
  const file = join(ownerGoDir(), `${session}.jsonl`);
  cleanupAtExit(file);
  const record = recorder({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript, cwd: dir, prompt, prompt_id: promptId });
  if (after === 'elsewhere') {
    const moved = join(dir, 'claude-config', 'projects', '-repo', 't.jsonl');
    mkdirSync(join(dir, 'claude-config', 'projects', '-repo'), { recursive: true });
    writeFileSync(moved, readFileSync(transcript));
    writeFileSync(file, readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.stringify({ ...JSON.parse(l), transcript_path: moved })).join('\n') + '\n');
  } else if (after !== undefined) {
    const kept = [
      { type: 'user', message: { content: 'ship it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY },
      { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    ];
    if (after !== 'missing') kept.push({ type: 'user', message: { content: prompt }, promptId, ...after });
    writeFileSync(transcript, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }
  t.after(() => {
    rmSync(file, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return record;
}

// The reply's merge request, as the ship skill shows it (Owner-merge approval). Phase 3b: it names the repository (the fake gh's by
// default, fakegh-env.mjs REPO_VIEW); null leaves the repo out, as a request from before Phase 3b did.
// `areas` (protected areas): the ids `P merge --dry-run --owner-go` reports; they are printed as the Areas line directly above the Head line.
export const mergeRequest = (pr, head, items, repo = 'acme/widgets', areas = []) => `Owner items listed above.\n${areas.length > 0 ? `${areasBlock(areas)}\n` : ''}Head ${head.slice(0, 12)} · items ${items}${repo === null ? '' : ` · repo ${repo}`}\n🔀 Ready to merge #${pr} — say "merge"`;

// A reply that asks the owner to rule on review items, as the ship skill ends it (review-loop.md, Owner rules in chat).
// #110: the line carries the content digest `P triage ruling-request` prints (a placeholder unless a test passes the real one).
export const rulingRequest = (pr, ids, repo = 'acme/widgets', content = 'c0ffee000000') => `R1-B1 is waiting for your decision.\n⚖️ Owner ruling needed #${pr}: ${ids.join(', ')}${content === null ? '' : ` · content ${content}`} · repo ${repo}`;

// A reply that asks for one more counted review round, as `P triage round-request` prints it (k = the counted ordinal; head >= 12 hex).
export const roundRequest = (pr, k, head, repo = 'acme/widgets') => `Round ${k - 1} left items open.\n🔁 Extra review round needed #${pr}: round ${k} · head ${head.slice(0, 12)} · repo ${repo}`;

// The flags P merge takes for it.
export const approvalFlags = (head, items) => ['--owner-approved-head', head, '--owner-approved-items', items];

// #128: runs the real hook (a subprocess, the account's real home) for a prompt submitted after `entries`, the way Claude Code would:
// the transcript is written first (`appended`: the current prompt is already in it, as its last entry) and the record, if any, is deleted
// afterwards. Returns { stdout, status, record } (record: the owner-go line written for the session, or null).
export function runHook(t, { entries, prompt, entry = OWNER_ENTRY, appended = true, input = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-go-hook-'));
  const transcript = transcriptIn(t);
  const promptId = `pid-${randomUUID()}`;
  const all = appended ? [...entries, { type: 'user', message: { content: prompt }, promptId, ...entry }] : entries;
  writeFileSync(transcript, `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const session = `test-${randomUUID()}`;
  const file = join(ownerGoDir(), `${session}.jsonl`);
  t.after(() => {
    rmSync(file, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  const stdin = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript, cwd: dir, prompt, prompt_id: promptId, ...input });
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });
  let record = null;
  try { record = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop()); } catch { /* nothing was recorded */ }
  return { stdout: r.stdout, status: r.status, record };
}
