// usage: node tools/guard-replay/ddmin-files.mjs <root> <rep.json> <reason-regex> <cwd-regex> [nth=0] — shrinks the nth files allow->deny flip whose reason/cwd match to a minimal command <root> still denies the same way
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const [root, rep, re, cwdRe, nth = '0'] = process.argv.slice(2);
const row = JSON.parse(readFileSync(rep, 'utf8')).flips.filter((f) => f.k === 'files' && f.to === 'deny' && new RegExp(re).test(f.reason) && new RegExp(cwdRe).test(f.cwd))[Number(nth)];
const files = (await import(pathToFileURL(join(root, 'pipeline/hooks/lib/files-policy.mjs')).href)).evaluateBashForFiles;
const bad = (c) => {
  try {
    const d = files(c, { cwd: row.cwd, home: os.homedir(), env: process.env, platform: process.platform });
    return d.decision === 'deny' && new RegExp(re).test(d.reason ?? '');
  } catch { return false; }
};
let cur = row.command;
console.log('cwd', row.cwd, '\nfull', JSON.stringify(cur).slice(0, 400));
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
console.log('min ', JSON.stringify(cur));
