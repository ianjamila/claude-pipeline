// The part of "run Codex and read its answer file" that codex-review and triage second-review share: start the command with the prompt on
// stdin, classify a failure (never readable as "found nothing"), and accept the output file only when this run wrote it.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { classifyCodexFailure } from './codex.mjs';
import { codexCommand, runAsync } from './proc.mjs';

export const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
// A file system may round mtimes down (1-2 s on some); the file was unlinked before the run, so this only has to
// tell "written during this run" from "left over from long ago".
export const MTIME_SLACK_MS = 2000;
const DETAIL_CHARS = 1000;

export const tail = (s) => {
  const text = String(s ?? '').trim();
  return text.length > DETAIL_CHARS ? text.slice(-DETAIL_CHARS) : text;
};

// Runs `codex <args>` with `promptBytes` on stdin. Whatever is at outPath beforehand was not written by this run, so it is removed first;
// on a timeout the whole process tree is killed, so a helper Codex started cannot write its answer afterwards.
// -> {ok:true, startedAt} or {ok:false, reason: quota|auth|unavailable|error, code, timedOut, detail}.
export async function execCodex({ root, env, args, promptBytes, outPath }) {
  rmSync(outPath, { force: true });
  const startedAt = Date.now();
  const { cmd, prefixArgs } = codexCommand(env);
  const timeoutMs = Number(env?.PIPELINE_CODEX_TIMEOUT_MS) || CODEX_TIMEOUT_MS;
  const r = await runAsync(cmd, [...prefixArgs, ...args], { cwd: root, env, input: promptBytes, timeoutMs });
  // A spawn failure is reported as stderr "spawn <cmd> ENOENT"; classify it as the missing binary it is.
  const spawnError = /^spawn(?:Sync)? .*\bENOENT\b/.test(r.stderr) ? { code: 'ENOENT', message: r.stderr } : undefined;
  if (r.code !== 0 || r.timedOut) {
    rmSync(outPath, { force: true });
    const reason = classifyCodexFailure({ code: r.code, stderr: r.stderr, stdout: r.stdout, timedOut: r.timedOut, spawnError });
    return { ok: false, reason, code: r.code, timedOut: r.timedOut, detail: tail(r.stderr || r.stdout) };
  }
  return { ok: true, startedAt };
}

// The parsed answer file of a run that exited 0; throws (Error) when it is missing, left over from before this run, or not JSON.
export function readCodexAnswer(outPath, startedAt) {
  if (!existsSync(outPath)) throw new Error('codex exited 0 but wrote no output file');
  if (statSync(outPath).mtimeMs < startedAt - MTIME_SLACK_MS) throw new Error('codex output file predates this run');
  return JSON.parse(readFileSync(outPath, 'utf8'));
}
