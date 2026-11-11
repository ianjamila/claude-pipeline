// The "owner only" check shared by the commands an agent must not run on itself (`pipeline update`, `pipeline model-floor reset`):
// refused inside Claude Code, i.e. CLAUDECODE=1 or a Claude Code process among the ancestors of this one (an agent can unset the
// variable, so the process tree is the backstop). The owner's admin switch lifts it (the guard stops an agent from setting that one).
// Returns why the caller is inside Claude Code (a short phrase), or null when the owner may proceed.
// `ctx.hasClaudeCodeAncestor` is the test seam for the process-tree walk.
import { hasClaudeCodeAncestor } from './claude-ancestry.mjs';

export function insideClaudeCode(env, ctx = {}) {
  if (env?.PIPELINE_ADMIN === '1') return null;
  if (env?.CLAUDECODE === '1') return 'CLAUDECODE=1';
  return (ctx.hasClaudeCodeAncestor ?? hasClaudeCodeAncestor)() ? 'a Claude Code process is an ancestor of this one' : null;
}
