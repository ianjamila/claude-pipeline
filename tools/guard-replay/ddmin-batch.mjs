// usage: node tools/guard-replay/ddmin-batch.mjs <root> <still.json> <specs.json> — runs ddmin-files.mjs for each [reasonRegex, cwdRegex, nth] spec and prints full + minimal commands
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [root, still, specs] = process.argv.slice(2);
for (const [re, cwd, nth] of JSON.parse(readFileSync(specs, 'utf8'))) {
  console.log(`### ${re} @ ${cwd} #${nth}`);
  try {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('./ddmin-files.mjs', import.meta.url)), root, still, re, cwd, String(nth)], { encoding: 'utf8', timeout: 240000 });
    for (const l of out.split('\n')) if (/^(full|min|not|cwd)/.test(l)) console.log(l.slice(0, 300));
  } catch (e) { console.log('ERR', (e.stdout ?? '').slice(-300), String(e.message).slice(0, 200)); }
}
