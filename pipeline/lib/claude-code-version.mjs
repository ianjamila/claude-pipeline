// Which Claude Code build is this terminal running, and which one is installed on disk (plan 2026-11-10, A3). A terminal opened before an
// update keeps resolving the old `fable` alias, so running < installed means "restart this terminal". Either unknown => stale: null.
import fs from 'node:fs';
import path from 'node:path';

const RUNNING_RE = /^claude-code_(\d+)-(\d+)-(\d+)_agent$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

// AI_AGENT = "claude-code_2-1-321_agent" -> "2.1.321"; anything else (unset, another agent, another shape) -> null.
export function runningVersion(env = process.env) {
  const m = RUNNING_RE.exec(String(env?.AI_AGENT ?? ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// CLAUDE_CODE_EXECPATH = <pkg>/bin/claude.exe -> the version in <pkg>/package.json (two directories above the executable), or null.
export function installedVersion(env = process.env, { readFile = fs.readFileSync } = {}) {
  const exec = env?.CLAUDE_CODE_EXECPATH;
  if (typeof exec !== 'string' || exec === '' || !path.isAbsolute(exec)) return null;
  try {
    const version = JSON.parse(readFile(path.join(path.dirname(path.dirname(exec)), 'package.json'), 'utf8'))?.version;
    return typeof version === 'string' && SEMVER_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

// -1 / 0 / 1 on major.minor.patch (a prerelease suffix is ignored); null when either is not a version.
export function compareSemver(a, b) {
  const x = SEMVER_RE.exec(String(a));
  const y = SEMVER_RE.exec(String(b));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// { running, installed, stale }: stale is true when the running build is older than the installed one, false when not, null when either is unknown.
export function claudeCodeStatus(env = process.env, deps = {}) {
  const running = runningVersion(env);
  const installed = installedVersion(env, deps);
  const cmp = running && installed ? compareSemver(running, installed) : null;
  return { running, installed, stale: cmp === null ? null : cmp < 0 };
}
