// usage: node tools/guard-replay/prof-top.mjs <file.cpuprofile> [n=15] — top functions by self time, and the longest single sample gap
import { readFileSync } from 'node:fs';
const [file, n = '15'] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((x) => [x.id, x]));
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const node = byId.get(p.samples[i]);
  const f = node.callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(n))) console.log(String(Math.round(us / 1000)).padStart(6), 'ms', (100 * us / total).toFixed(1).padStart(5) + '%', k);
