// What a non-zero exit of the merge command means once GitHub says the PR is MERGED (used by both routes of commands/merge.mjs).
//
// `pipeline merge` runs the project's merge command with cwd = the PR's worktree, where the PR branch is checked out. gh
// `pr merge --delete-branch` merges, then tries to check out the base branch there: git refuses because the base is checked out in
// another worktree, and gh exits 1 AFTER the merge without deleting the local branch. gh returns on that error BEFORE it deletes the
// remote branch, so the remote branch is left too unless the repository deletes branches on merge (delete_branch_on_merge). That one case
// is named (localCleanup); anything else keeps the old note and now carries the command's output so the next unknown cause has evidence.
//
// This never decides merged / not merged: GitHub's state does. It only words a merge that already happened.
import { tailLines } from './cmd-io.mjs';

export const OLD_NOTE = 'the merge command exited non-zero but the PR is MERGED';
export const WORKTREE_NOTE = 'merged; gh could not switch away from or delete the local branch because a worktree holds it, and it returns there before deleting the remote branch, so that is left too unless the repository deletes branches on merge (delete_branch_on_merge); remove the worktree as usual and delete the remote branch if it is still there';

// git's own messages (C locale; a translated one falls to the unknown-cause path).
const GIT_DIAGNOSTIC = "(?:fatal: '[^']+' is already (?:checked out at|used by worktree at) '[^']+'|error: Cannot delete branch '[^']+' (?:checked out|used by worktree) at '[^']+')\\.?";
// A whole line that is one such diagnostic, optionally wrapped by gh on the same line.
const DIAGNOSTIC_LINE = new RegExp(`^\\s*(?:(?:failed to run git|failed to delete local branch \\S+):\\s*)*${GIT_DIAGNOSTIC}\\s*$`);
const ERROR_LIKE = /\b(?:error|fatal|failed|denied|cannot|could not|unable)\b/i;

export const commandTail = (ran) => tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 30);

// The worktree case needs ALL of: exit code exactly 1, not timed out, no signal, at least one git worktree diagnostic, and every
// error-looking line of the FULL output (not the 30-line tail) is such a diagnostic.
function isWorktreeCase(ran) {
  if (ran.code !== 1 || ran.timedOut || ran.signal) return false;
  const lines = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`.split(/\r?\n/);
  let found = false;
  for (const line of lines) {
    if (DIAGNOSTIC_LINE.test(line)) { found = true; continue; }
    if (ERROR_LIKE.test(line)) return false;
  }
  return found;
}

// The fields to add to a MERGED result. Exit 0 adds nothing.
export function classifyMergeCommand(ran) {
  if (ran.code === 0) return {};
  const commandOutput = commandTail(ran);
  if (isWorktreeCase(ran)) return { commandExitCode: ran.code, localCleanup: { skipped: true, reason: 'worktree' }, commandOutput, note: WORKTREE_NOTE };
  return { commandExitCode: ran.code, commandOutput, note: OLD_NOTE };
}
