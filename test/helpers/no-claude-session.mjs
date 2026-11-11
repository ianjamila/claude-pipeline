// For tests that run the CLI as an INSTALLED copy (a pipeline root holding INSTALLED.json): an installed copy honours no test seam, so a leased command
// (lib/review-lease-wiring.mjs) would write a review lease into the account's real folder whenever the suite itself runs inside Claude Code. This makes the
// child look like a plain terminal: no session marker in the environment and a `ps` first on PATH that knows no Claude Code process anywhere (every pid is a
// plain shell whose parent is init), so the ancestor walk finds nothing. Windows asks PowerShell instead (not faked; its CI machines have no Claude Code
// above the tests). Spread the result over the child's environment (an undefined value drops the variable).
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const SESSION_VAR = ['CLAUDE', 'CODE'].join('');
let psDir;

function fakePsDir() {
  if (process.platform === 'win32') return null;
  if (psDir) return psDir;
  psDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-noclaude-ps-')));
  process.on('exit', () => rmSync(psDir, { recursive: true, force: true }));
  const file = join(psDir, 'ps');
  writeFileSync(file, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "console.log(args.includes('args=') ? 'zsh' : '1 zsh');",
  ].join('\n'));
  chmodSync(file, 0o755);
  return psDir;
}

// { PATH, <session marker>: undefined } to merge over a child's environment (`base`: where PATH comes from).
export function noClaudeSession(base = process.env) {
  const dir = fakePsDir();
  return { [SESSION_VAR]: undefined, ...(dir ? { PATH: `${dir}${delimiter}${base.PATH ?? ''}` } : {}) };
}
