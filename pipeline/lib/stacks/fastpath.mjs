// The cheap decisions of the stack hooks, taken BEFORE the hooks load their libraries. stack-register runs before every Bash and
// file-tool call and stack-dev-bind after every Bash call; most of those calls (an `ls`, a read of an ordinary file) leave
// nothing for either to do, yet loading locks, ledger, identity and inventory just to find that out is most of what the hooks
// cost. Imports here are node builtins plus match.mjs, paths.mjs, dev-ages.mjs and inventory-cache.mjs, never register.mjs or dev.mjs.
//
// Every answer is a strict SUPERSET check: true means "the full path provably does nothing for this call", and any doubt is false.
//   - registerCanSkip: register() returns { exit: 0, events: [] } at its "2. stack prefilter" step exactly when devTargets(command)
//     is empty and prefilter(...) says no. The tool, tool input and command come from callOf (match.mjs), which register.mjs uses too, and the
//     inventory is the one register's own cache read gives (the stale cache included), so the two cannot disagree.
//   - devBindCanSkip: runDevBind() appends in two places. (1) A `dev-post` for this tool call's own dev record, which only a
//     command devTargets() matches ever got. (2) A `dev-bind` for an EARLIER unbound dev record of the same session that is
//     between MIN_AGE_MS and MAX_AGE_MS old, and a later plain `ls` is usually the call that binds it, so a command devTargets()
//     cannot match is NOT enough. What proves (2) empty is the ledger: a due record's tPre is within MAX_AGE_MS of now and the
//     record was appended at or after tPre, so the ledger's mtime is no older than that either. A ledger that does not exist, or
//     whose mtime is older than MAX_AGE_MS + LEDGER_SLACK_MS, holds no due record. A stat error other than ENOENT, an mtime in the
//     future or one that is not a number proves nothing and is "do not skip".
// The hooks call these inside their own try/catch: any error here, or in importing this file, sends the call down the full path.
import fs from 'node:fs';
import os from 'node:os';
import { MAX_AGE_MS } from './dev-ages.mjs';
import { cachedInventory } from './inventory-cache.mjs';
import { callOf, devTargets, prefilter } from './match.mjs';
import { stackFiles, stacksRoot } from './paths.mjs';

// Extra age on top of MAX_AGE_MS before a ledger counts as too old to hold a due record: covers a coarse file-system clock and
// the gap between a record's `t` and the moment its line reached the disk.
export const LEDGER_SLACK_MS = 60 * 1000;

// ---- stack-register ----

// true only when register() would do nothing for this call: no dev record (devTargets) and the stack prefilter says no.
export function registerCanSkip({ input, inventory, platform = process.platform } = {}) {
  const { tool, toolInput, command } = callOf(input);
  if (devTargets(command).length > 0) return false;
  return !prefilter({ tool, input: toolInput, inventory, platform });
}

// registerCanSkip with the inventory register's own default cache read gives: the cache file under the stacks root, stale or not.
export function registerFastSkip({ input, env = process.env, home = os.homedir(), now = Date.now(), platform = process.platform } = {}) {
  const file = stackFiles(stacksRoot(env, home)).cache;
  return registerCanSkip({ input, inventory: cachedInventory({ file, now }).inv, platform });
}

// ---- stack-dev-bind ----

// true only when runDevBind() would append nothing. `ledgerFile` is the ledger path; `statSync` is injectable for tests.
export function devBindCanSkip({ input, now = Date.now(), ledgerFile, statSync = fs.statSync } = {}) {
  // runDevBind's own immediate no-ops
  if (input?.tool_name !== 'Bash') return true;
  if (!(typeof input?.session_id === 'string' && input.session_id !== '')) return true;
  // a command that starts a dev server may have a record of its own to stamp, whatever the ledger looks like
  if (devTargets(callOf(input).command).length > 0) return false;
  let mtimeMs;
  try {
    mtimeMs = statSync(ledgerFile).mtimeMs;
  } catch (err) {
    return err?.code === 'ENOENT'; // no ledger, no record; every other failure proves nothing
  }
  if (!Number.isFinite(mtimeMs)) return false;
  return now - mtimeMs > MAX_AGE_MS + LEDGER_SLACK_MS; // a future mtime gives a negative age: not skipped
}

// devBindCanSkip with the ledger runDevBind itself would read.
export function devBindFastSkip({ input, env = process.env, home = os.homedir(), now = Date.now(), statSync } = {}) {
  return devBindCanSkip({ input, now, ledgerFile: stackFiles(stacksRoot(env, home)).ledger, ...(statSync ? { statSync } : {}) });
}
