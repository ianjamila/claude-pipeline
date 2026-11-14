// Test side of fixtures/git-spy-preload.mjs: the env that makes a spawned CLI record its git subprocesses, and a reader for the log.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const preload = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'git-spy-preload.mjs');

export const gitSpyEnv = (logFile) => ({
  GIT_SPY_LOG: logFile,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim(),
});

// Every git invocation so far as its argument list with the pinned `-c k=v` pairs removed ("fetch --no-tags origin ...").
export function gitCalls(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
    const args = JSON.parse(l).args;
    const out = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-c') i += 1;
      else out.push(args[i]);
    }
    return out.join(' ');
  });
}

// The subcommands that change shared git state; a read-only command must start none of them. Two READ forms are not writes: `config --get <key>` and
// `symbolic-ref -q <ref>` (one ref, no target): risk.mjs#trustedDefaultBranch reads origin/HEAD and the origin remote's URL with them (#448).
export const GIT_WRITES = /^(fetch|pull|push|update-ref|checkout|switch|worktree|reset|merge|rebase|commit|branch|tag|gc|prune|clone|remote|config(?!\s+--get(\s|$))|add|stash|clean|restore|symbolic-ref(?!\s+-q\s+\S+$)|pack-refs|repack)(\s|$)/;
