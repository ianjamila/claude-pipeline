// One Codex execution: run the CLI over a prompt, then read and validate the structured answer it wrote. Shared by the
// round reviews (`codex-review`) and the plan reviews (`plan review`). Every way this can go wrong is `{ ok: false, reason }`
// with the reasons of classifyCodexFailure plus `malformed`; only a validated findings file (even an empty one) is `ok`.
// The callers turn a failure into their exit 3.
//
// `json: true` adds `--json` to the caller's argv (see buildCodexArgs / buildCodexResumeArgs) and reads the JSONL events on
// stdout: `session` is the `thread_id` of the `thread.started` event and `usage` the `usage` of the LAST `turn.completed`
// (`input_tokens`, `cached_input_tokens`, `output_tokens`); either one missing is `null`, never guessed.
//
// Measured 2026-10-20 on codex-cli 0.154.0 (plan step 6b): `exec resume <id> --json` reports usage CUMULATIVE over the whole
// thread, not per turn (a 1-line prompt: 19435 input / 5 output tokens; the same thread resumed with another 1-line
// prompt: 38889 input / 10 output; a third turn: 59013 / 38). A recheck therefore books its usage MINUS the usage stored
// for the run it resumed (`usageDelta`). `exec resume` honours `-o` and `--output-schema` (a schema-valid answer parsed).
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { validateFindings, classifyCodexFailure } from './codex.mjs';
import { codexCommand, runAsync } from './proc.mjs';

export const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
// A file system may round mtimes down (1-2 s on some); the file was unlinked before the run, so this only has to
// tell "written during this run" from "left over from long ago".
const MTIME_SLACK_MS = 2000;
const DETAIL_CHARS = 1000;
const SESSION_RE = /^[A-Za-z0-9_-]{8,}$/;

const tail = (s) => {
  const text = String(s ?? '').trim();
  return text.length > DETAIL_CHARS ? text.slice(-DETAIL_CHARS) : text;
};
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// The session id and the last turn's usage out of `codex exec --json` stdout (one JSON event per line; other lines ignored).
export function parseCodexJsonl(stdout) {
  let session = null;
  let usage = null;
  const errors = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    const text = raw.trim();
    if (!text.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(text); } catch { continue; }
    if (ev?.type === 'thread.started' && session === null && SESSION_RE.test(String(ev.thread_id))) session = ev.thread_id;
    // Only the failure events feed the failure classifier: the agent's own text must never read as a quota error.
    if (ev?.type === 'error' || ev?.type === 'turn.failed') errors.push(String(ev.message ?? ev.error?.message ?? ''));
    if (ev?.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = { input_tokens: count(ev.usage.input_tokens), cached_input_tokens: count(ev.usage.cached_input_tokens), output_tokens: count(ev.usage.output_tokens) };
      usage = Object.values(u).every((n) => n !== null) ? u : null;
    }
  }
  return { session, usage, errorText: errors.join('\n') };
}

// Cumulative usage minus what the resumed run had already reported (never negative). `prior` null/invalid = nothing to subtract.
export function usageDelta(usage, prior) {
  if (!usage) return null;
  const sub = (k) => Math.max(0, usage[k] - (count(prior?.[k]) ?? 0));
  return { input_tokens: sub('input_tokens'), cached_input_tokens: sub('cached_input_tokens'), output_tokens: sub('output_tokens') };
}

// args: the full argv (buildCodexArgs / buildCodexResumeArgs); the prompt goes to stdin. `afterRun` (optional) runs once Codex
// exited 0, before its answer is read: it may throw (codex-review uses it for "HEAD moved while Codex was reviewing").
export async function askCodex({ root, args, prompt, outPath, env, timeoutMs, json = false, afterRun }) {
  // Whatever is at the output path now was not written by this run; remove it so it can never be read as this
  // run's answer. (The mtime check below is the second line of defence, the tree kill on timeout the third.)
  rmSync(outPath, { force: true });
  const startedAt = Date.now();
  const { cmd, prefixArgs } = codexCommand(env);
  const limit = timeoutMs ?? (Number(env?.PIPELINE_CODEX_TIMEOUT_MS) || CODEX_TIMEOUT_MS);
  // On a timeout the whole process tree is killed, so a helper Codex started cannot write its answer afterwards.
  const r = await runAsync(cmd, [...prefixArgs, ...args], { cwd: root, env, input: prompt, timeoutMs: limit });
  const seen = json ? parseCodexJsonl(r.stdout) : { session: null, usage: null, errorText: '' };
  // A spawn failure is reported as stderr "spawn <cmd> ENOENT"; classify it as the missing binary it is.
  const spawnError = /^spawn(?:Sync)? .*\bENOENT\b/.test(r.stderr) ? { code: 'ENOENT', message: r.stderr } : undefined;
  if (r.code !== 0 || r.timedOut) {
    rmSync(outPath, { force: true });
    const reason = classifyCodexFailure({ code: r.code, stderr: r.stderr, stdout: json ? seen.errorText : r.stdout, timedOut: r.timedOut, spawnError });
    return { ok: false, reason, code: r.code, timedOut: r.timedOut, detail: tail(r.stderr || (json ? seen.errorText : r.stdout)), session: seen.session };
  }

  if (afterRun) afterRun();

  let findings;
  try {
    if (!existsSync(outPath)) throw new Error('codex exited 0 but wrote no output file');
    if (statSync(outPath).mtimeMs < startedAt - MTIME_SLACK_MS) throw new Error('codex output file predates this run');
    findings = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'malformed', errors: [err.message], session: seen.session };
  }
  const checked = validateFindings(findings);
  if (!checked.ok) return { ok: false, reason: 'malformed', errors: checked.errors, session: seen.session };
  return { ok: true, findings, session: seen.session, usage: seen.usage };
}
