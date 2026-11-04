// Preloaded (node --import) into a spawned CLI: records every `git` subprocess it starts (spawnSync / spawn / execFileSync), one JSON
// line { args } each, to the file named in GIT_SPY_LOG. Used to prove a command never fetches, moves a ref, checks out or pushes.
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const log = process.env.GIT_SPY_LOG;
const isGit = (file) => /^git(\.exe)?$/i.test(basename(String(file)));
for (const name of ['spawnSync', 'spawn', 'execFileSync', 'execFile']) {
  const original = cp[name];
  cp[name] = function spied(file, args, ...rest) {
    if (isGit(file)) appendFileSync(log, `${JSON.stringify({ args: Array.isArray(args) ? args : [] })}\n`);
    return original.call(this, file, args, ...rest);
  };
}
syncBuiltinESMExports();
