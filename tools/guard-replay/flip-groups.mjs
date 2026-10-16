// usage: node tools/guard-replay/flip-groups.mjs <replay.json> [direction e.g. git:deny->allow] [maxGroups=60]
// Groups the flips of a replay output by direction and reason (numbers and paths masked), largest first.
import { readFileSync } from 'node:fs';
const [file, only, max = '60'] = process.argv.slice(2);
const { summary, flips } = JSON.parse(readFileSync(file, 'utf8'));
console.log(JSON.stringify(summary));
const norm = (r) => String(r ?? '').replace(/\/[^\s`'",;)]+/g, '<P>').replace(/\$\w+|\$\{[^}]*\}/g, '<V>').replace(/\d+/g, 'N').replace(/`[^`]*`/g, '<C>').slice(0, 110);
const groups = new Map();
for (const f of flips) {
  const dir = `${f.k}:${f.from}->${f.to}`;
  if (only && dir !== only) continue;
  const key = `${dir} | ${norm(f.reason)}`;
  const g = groups.get(key) ?? { n: 0, ex: [] };
  g.n++;
  if (g.ex.length < 2) g.ex.push(f.command.replace(/\s+/g, ' ').slice(0, 170));
  groups.set(key, g);
}
for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, Number(max))) {
  console.log(`\n${g.n}  ${k}`);
  for (const e of g.ex) console.log(`     ${e}`);
}
