#!/usr/bin/env node
// Why: PostToolUse hook (matcher `Bash`) that finishes what the PreToolUse register hook started for a dev server: it stamps
// the tool call's end time on the dev record (`dev-post`) and tries to bind the listener now serving the port to this session
// (`dev-bind`), by process ancestry only. All judgement is in lib/stacks/dev.mjs. This hook NEVER blocks: whatever happens
// (bad input, a failed import, a probe error, the internal 8 s deadline) it exits 0, at worst leaving a line in the log.
// Windows: exits 0 at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') process.exit(0);

function logFailure(why) {
  try {
    const root = process.env.PIPELINE_STACKS_HOME ? path.resolve(process.env.PIPELINE_STACKS_HOME) : path.join(os.homedir(), '.claude', 'pipeline-state', 'stacks');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(root, 'stacks.log'), `${new Date().toISOString()} dev-bind hook failed: ${String(why?.message ?? why).replace(/\s+/g, ' ').slice(0, 300)}\n`, { mode: 0o600 });
  } catch {
    /* nowhere to report to */
  }
}

async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('hook input is not a JSON object');
  return value;
}

try {
  const input = await readInput();
  const { runDevBind } = await import('../lib/stacks/dev.mjs');
  await runDevBind(input);
} catch (err) {
  logFailure(err);
}
process.exit(0);
