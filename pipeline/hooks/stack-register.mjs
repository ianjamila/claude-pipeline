#!/usr/bin/env node
// Why: PreToolUse hook (matchers `Bash` and `Edit|Write|MultiEdit|NotebookEdit`) that records, BEFORE the tool runs, that
// this Claude process is using a private Supabase stack. Started through the installer's fail-closed loader (a load failure
// exits 2). Exit 2 blocks the call; every failure after a stack was named exits 2 with the reason, unless the pause file
// exists (then it is only logged). All judgement is in lib/stacks/register.mjs; this file reads stdin, calls it, writes the
// message to stderr and exits with its verdict. Windows: exits 0 at once.
// Fast path: most calls name no stack and start no dev server, and then register() returns exit 0 after its prefilter. That
// decision is made first, by lib/stacks/fastpath.mjs (a few small modules), so register.mjs and what it pulls in (locks, ledger,
// identity, inventory) are only loaded when the call could matter. The fast path can only skip: any error in it (the import, the
// cache read, the decision) is swallowed and the call takes the full path, never exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') process.exit(0);

// The pause file, found without importing anything from the pipeline (used when the imports themselves failed).
function pausedWithoutImports() {
  try {
    const root = process.env.PIPELINE_STACKS_HOME ? path.resolve(process.env.PIPELINE_STACKS_HOME) : path.join(os.homedir(), '.claude', 'pipeline-state', 'stacks');
    fs.statSync(path.join(root, 'pause'));
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
  }
}

async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('hook input is not a JSON object');
  return value;
}

let verdict;
try {
  const input = await readInput();
  let skip = false;
  try {
    const { registerFastSkip } = await import('../lib/stacks/fastpath.mjs');
    skip = registerFastSkip({ input }) === true;
  } catch {
    skip = false; // fail closed: whatever went wrong, the full path decides
  }
  if (skip) verdict = { exit: 0 };
  else {
    const { register } = await import('../lib/stacks/register.mjs');
    verdict = await register(input);
  }
} catch (err) {
  const why = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300);
  verdict = pausedWithoutImports() ? { exit: 0 } : { exit: 2, message: `autostop could not register use of stack (internal error: ${why}) — retry; pause with: touch ${path.join(process.env.PIPELINE_STACKS_HOME || path.join(os.homedir(), '.claude', 'pipeline-state', 'stacks'), 'pause')}` };
}
const code = verdict?.exit === 0 ? 0 : 2;
const message = verdict?.message ? `${verdict.message}\n` : '';
// exit explicitly: an unread stdin pipe or an open handle would otherwise keep the process alive
if (message) process.stderr.write(message, () => process.exit(code));
else process.exit(code);
