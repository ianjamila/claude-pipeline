// The verdict of the same two evaluators the hooks run (git guard, file guard) on a command line, wired to the real branch and
// label lookups. Shared by the commands that start a process on the caller's behalf (`job start`, `verify slot --run`), so
// "use a job" or "use a slot" is never a way around a hook. Returns { allow: true } or { allow: false, reason }.
import os from 'node:os';
import { evaluateBashForFiles } from '../hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../hooks/lib/git-policy.mjs';
import { ownerGoWiring, realGitWiring } from '../hooks/lib/git-wiring.mjs';

export function guardVerdict(command, { cwd, env }) {
  // (#58: no session here, so a direct merge in an owner_approval: chat repo is refused; P merge is the way)
  // (and the runner's environment: GH_REPO there names the merge's repository, exactly as for a direct `gh pr merge`)
  const git = evaluateGitCommand(command, { cwd, env, ...realGitWiring(), ownerGo: ownerGoWiring(null) });
  if (git.decision !== 'allow') return { allow: false, reason: git.reason || 'denied by the git guard' };
  const files = evaluateBashForFiles(command, { home: os.homedir(), env, platform: process.platform, cwd });
  if (files.decision !== 'allow') return { allow: false, reason: files.reason || 'denied by the file guard' };
  return { allow: true };
}
