// Why: a PreToolUse hook that crashes is treated by Claude Code as a non-blocking error and the tool call is
// ALLOWED, so every hook entry point goes through runHook: it never throws, never exits non-zero by accident,
// and when something internal breaks it fails closed for input that looks like a guarded git/gh operation
// (and open for everything else, so an unrelated bug cannot freeze every Bash command).

export const REASON_PREFIX = '[claude-pipeline guard-git] ';

// Substrings (lowercase) that make an unparseable / unevaluable request look guarded.
export const FAIL_CLOSED_KEYWORDS = [
  'push', 'merge', 'protection', 'ruleset', 'human-approved', 'test-change-approved', 'needs-human',
  'pipeline-pause', 'pipeline-rollback', 'pipeline-blocked', 'awaiting-review', 'issue close', 'repo edit',
];

const withPrefix = (reason) => {
  const text = String(reason ?? '').trim() || 'blocked by the pipeline guard';
  return text.startsWith(REASON_PREFIX) ? text : REASON_PREFIX + text;
};

// The exact stdout Claude Code expects for a PreToolUse denial.
export function denyPayload(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: withPrefix(reason),
    },
  });
}

// Neither function touches process.exitCode: the default is 0 and the entry point only has to return.
export function deny(reason, io = {}) {
  (io.stdout ?? process.stdout).write(`${denyPayload(reason)}\n`);
}

export function allow() {
  // allowing is silence: no output, exit code 0
}

export async function readStdinText(stream = process.stdin) {
  if (typeof stream === 'string') return stream;
  if (!stream || stream.isTTY) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function parseHookInput(text) {
  const value = JSON.parse(String(text).replace(/^﻿/, ''));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('hook input is not a JSON object');
  return value;
}

export async function readHookInput(stream = process.stdin) {
  return parseHookInput(await readStdinText(stream));
}

// io (tests only): { stdin: string | stream, stdout: { write } }. Resolves to 'deny' or 'allow'.
export async function runHook(evaluate, io = {}) {
  let text = '';
  try {
    text = await readStdinText(io.stdin ?? process.stdin);
    const verdict = await evaluate(parseHookInput(text));
    if (verdict?.decision === 'deny') {
      deny(verdict.reason, io);
      return 'deny';
    }
    if (verdict?.decision === 'allow') {
      allow();
      return 'allow';
    }
    throw new TypeError('evaluator returned no decision');
  } catch (err) {
    const lower = text.toLowerCase();
    const hit = FAIL_CLOSED_KEYWORDS.find((k) => lower.includes(k));
    if (hit) {
      const why = err instanceof Error ? err.message : String(err);
      try {
        deny(`internal error while checking this command (${why}); denied because the request mentions "${hit}". Retry, or ask the repository owner.`, io);
        return 'deny';
      } catch {
        return 'allow'; // stdout is gone; nothing more can be done
      }
    }
    allow();
    return 'allow';
  }
}
