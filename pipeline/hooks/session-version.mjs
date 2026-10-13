#!/usr/bin/env node
// Why: SessionStart status hook (registered by the installer, plain - never the fail-closed loader, because a failure
// here must never block anything). It tells the owner, once per session, when the installed pipeline is edited,
// half-installed, behind upstream main, or older than the copy a repo's CI vendors; it prints NOTHING when all is well.
// All judgement and every bounded git/network step live in lib/session-version.mjs under one 4 s deadline; this file
// only wires stdin (the hook input's `cwd`) and stdout, and always exits 0.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STDIN_WAIT_MS = 1000;

// The hook input, or {} when stdin is a terminal, empty, closed late or not JSON (a late stdin must not eat the deadline).
async function readInput() {
  if (process.stdin.isTTY) return {};
  let timer;
  const text = await Promise.race([
    (async () => { const chunks = []; for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c); return Buffer.concat(chunks).toString('utf8'); })(),
    new Promise((resolve) => { timer = setTimeout(() => resolve(''), STDIN_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

let output = '';
try {
  const input = await readInput();
  const { checkSession } = await import('../lib/session-version.mjs');
  // <home>/pipeline/hooks/session-version.mjs -> <home>
  const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  output = await checkSession({ home, cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(), env: process.env });
} catch {
  output = ''; // never throws: a version check must not disturb a session
}
// exit explicitly: an unread stdin pipe would otherwise keep the process alive
if (output) process.stdout.write(output, () => process.exit(0));
else process.exit(0);
