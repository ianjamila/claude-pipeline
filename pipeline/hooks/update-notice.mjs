#!/usr/bin/env node
// Why (plan 2026-11-10 B4, owner decision 11-10): SessionStart notice that the installed pipeline is behind main. The unattended `pipeline update --scheduled`
// job writes <account home>/.claude/pipeline-state/update-status.json after every run; this hook ONLY reads that file: no network, no git, no process
// spawn, one 1 s budget (a timer exits 0 whatever is still pending). It prints nothing when the state is `current`, the file is missing, unreadable or
// not what it expects, and at most one line otherwise. Whatever goes wrong it exits 0: it is started as a plain hook, NEVER through the guards'
// fail-closed loader (an exit 2 on SessionStart must not be possible), and the retired session-version hook stays retired (another file name).
//
// The file is not in the guard's protected namespace, so an agent could write it: nothing from it is shown except a state name, and a repo name / PR
// number that pass a strict shape check (never `mainTitle`, `reason` or `command`, which can hold free text).
// Stdout of a SessionStart hook is added to the session's context, so the line is plain text.
//
// Test seams (a repo checkout only, like the other seams; an installed copy ignores them):
//   PIPELINE_UPDATE_STATUS_FILE        read this file instead of the account's
//   PIPELINE_UPDATE_NOTICE_DELAY_MS    make the read take this long first (proves the 1 s budget)
const BUDGET_MS = 1000;
setTimeout(() => process.exit(0), BUDGET_MS).unref();

const STATES = new Set(['behind', 'deferred-by-review', 'blocked-modified', 'failed']);
const MAX_BYTES = 64 * 1024;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){0,2}$/;

const lineFor = (status) => {
  if (status.state === 'behind') return 'pipeline update available — installs automatically when no review is running';
  if (status.state === 'deferred-by-review') {
    const by = Array.isArray(status.deferredBy) ? status.deferredBy.find((d) => d && typeof d === 'object' && typeof d.repo === 'string' && REPO_RE.test(d.repo)) : null;
    if (by && Number.isSafeInteger(by.pr) && by.pr > 0) return `pipeline update waiting on a review in ${by.repo} #${by.pr}`;
    if (by) return `pipeline update waiting on a review in ${by.repo}`;
    return 'pipeline update waiting on a running review';
  }
  return 'pipeline update needs you: run pupdate';
};

async function main() {
  const { seamValue } = await import('../lib/seams.mjs');
  const { accountHome } = await import('../lib/paths.mjs');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = seamValue('PIPELINE_UPDATE_STATUS_FILE') || path.join(accountHome(), '.claude', 'pipeline-state', 'update-status.json');
  const delay = Number(seamValue('PIPELINE_UPDATE_NOTICE_DELAY_MS'));
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  // O_NONBLOCK: opening a FIFO nobody writes to would otherwise block in a thread that process.exit() then waits for, past the 1 s budget.
  const { constants } = await import('node:fs');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let text;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_BYTES) return '';
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const status = JSON.parse(text.replace(/^﻿/, ''));
  if (status === null || typeof status !== 'object' || Array.isArray(status) || status.version !== 1 || !STATES.has(status.state)) return '';
  return `${lineFor(status)}\n`;
}

let output = '';
try { output = await main(); } catch { output = ''; }
// Exit explicitly: the unread stdin pipe and the unref'd timer must not keep the process (or the session start) waiting.
if (output) process.stdout.write(output, () => process.exit(0));
else process.exit(0);
