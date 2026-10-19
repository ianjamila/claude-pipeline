#!/usr/bin/env node
// Why: SessionEnd hook that, when a Claude session ends (anything but /clear), starts a DETACHED worker which waits for the
// session's Claude process to be gone and then decides which private Supabase stacks and dev servers that session leased can be
// stopped. All judgement is in lib/stacks/session-end.mjs. SessionEnd cannot block anything, so this hook NEVER fails the
// session: whatever happens (bad input, a failed import, no owner found, a spawn error, the 2 s guard) it exits 0, at worst
// leaving a line in the log. Windows: exits 0 at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') process.exit(0);

// The whole hook must finish within 2 s; the lookups inside carry their own 1.5 s budget, this is the backstop.
setTimeout(() => process.exit(0), 2000).unref();

function logFailure(why) {
  try {
    const root = process.env.PIPELINE_STACKS_HOME ? path.resolve(process.env.PIPELINE_STACKS_HOME) : path.join(os.homedir(), '.claude', 'pipeline-state', 'stacks');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(root, 'stacks.log'), `${new Date().toISOString()} session-end hook failed: ${String(why?.message ?? why).replace(/\s+/g, ' ').slice(0, 300)}\n`, { mode: 0o600 });
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
  const { sessionEndHook } = await import('../lib/stacks/session-end.mjs');
  await sessionEndHook(input);
} catch (err) {
  logFailure(err);
}
process.exit(0);
