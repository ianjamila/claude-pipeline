// usage: node --cpu-prof --cpu-prof-dir=<dir> tools/guard-replay/prof-one.mjs <root> <files|git> <cases.json> <index> — runs one case once (for a CPU profile)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const [root, kind, file, idx] = process.argv.slice(2);
const c = JSON.parse(readFileSync(file, 'utf8'))[Number(idx)];
const t0 = Date.now();
let d;
if (kind === 'files') {
  const { evaluateBashForFiles } = await import(pathToFileURL(join(root, 'pipeline/hooks/lib/files-policy.mjs')).href);
  d = evaluateBashForFiles(c.command, { cwd: c.cwd, home: os.homedir(), env: process.env, platform: process.platform });
} else {
  const { evaluateGitCommand } = await import(pathToFileURL(join(root, 'pipeline/hooks/lib/git-policy.mjs')).href);
  const { realGitWiring } = await import(pathToFileURL(join(root, 'pipeline/hooks/lib/git-wiring.mjs')).href);
  d = evaluateGitCommand(c.command, { cwd: c.cwd, env: process.env, ...realGitWiring() });
}
console.log(Date.now() - t0, 'ms', d.decision, String(d.reason ?? '').slice(0, 120));
