// A fake Claude Code config dir for the stack-stop tests: <home>/.claude/{sessions,projects}, written the way Claude Code writes
// them (test/fixtures/live-sessions pins the record shape), so the REAL scanner (worktree-prune/live-sessions.mjs) reads them and
// only its ps call is stubbed (`aliveStarts`, passed as ctx.liveSessionStarts / deps.liveSessionStarts).
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_START = 'Thu Oct 29 08:54:42 2026';

// A session record, and (when `lines` is given) its transcript under projects/<start cwd, non-alphanumerics -> "-">/.
// `lines`: a cwd string, null (a line with no cwd), or an object written as it is. `ageHours` backdates the transcript.
export function addSession(home, { config = '.claude', pid, sid, cwd = home, procStart = SESSION_START, lines, ageHours = 0, raw }) {
  const cfg = join(home, config);
  mkdirSync(join(cfg, 'sessions'), { recursive: true });
  writeFileSync(join(cfg, 'sessions', `${pid}.json`), raw ?? JSON.stringify({ pid, sessionId: sid, cwd, procStart, version: '0.0.0' }));
  if (!lines) return undefined;
  const dir = join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l === null ? { type: 'summary' } : typeof l === 'string' ? { type: 'user', cwd: l } : l)).join('\n')}\n`);
  if (ageHours) {
    const t = (Date.now() - ageHours * 3.6e6) / 1000;
    utimesSync(file, t, t);
  }
  return file;
}

// The stand-in for `ps`: these pids run, and started at `start`. `calls` records what was asked.
export function aliveStarts(alive, { start = SESSION_START, startOf = {} } = {}) {
  const fn = (pids, opts) => {
    fn.calls.push({ pids: [...pids], opts });
    return new Map(pids.filter((p) => alive.includes(p)).map((p) => [p, startOf[p] ?? start]));
  };
  fn.calls = [];
  return fn;
}
