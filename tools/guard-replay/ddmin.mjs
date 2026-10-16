// usage: node tools/guard-replay/ddmin.mjs <root> <rows.json> <i> <reason-regex> — shrinks flip row i to a minimal command that <root> still denies with a matching reason
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const [root, rowsFile, i, re] = process.argv.slice(2);
const row = JSON.parse(readFileSync(rowsFile, 'utf8')).find((r) => r.i === Number(i));
const git = (await import(pathToFileURL(join(root, 'pipeline/hooks/lib/git-policy.mjs')).href)).evaluateGitCommand;
const bad = (c) => {
  try {
    const d = git(c, { cwd: row.cwd, home: os.homedir(), currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [] });
    return d.decision === 'deny' && new RegExp(re).test(d.reason ?? '');
  } catch { return false; }
};
let cur = row.command;
if (!bad(cur)) { console.log('not reproduced'); process.exit(1); }
for (let n = 2; n <= cur.length; ) {
  const size = Math.ceil(cur.length / n);
  let shrunk = false;
  for (let s = 0; s < cur.length; s += size) {
    const cand = cur.slice(0, s) + cur.slice(s + size);
    if (cand.length && bad(cand)) { cur = cand; n = Math.max(n - 1, 2); shrunk = true; break; }
  }
  if (!shrunk) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2); }
}
console.log(JSON.stringify(cur));
console.log('cwd', row.cwd);
