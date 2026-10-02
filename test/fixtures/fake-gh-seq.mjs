// Like fake-gh.mjs (same script format, same log) plus per-entry `sequence`: the Nth call that this entry answers gets
// sequence[min(N, length-1)], so a test can say "the labels API returns A the first time and B afterwards".
//   [{ match: "<regex source>", stdout?, stdoutJson?, stderr?, code?, sequence?: [{stdout?, code?, ...}] }]
// The first entry whose regex matches the space-joined argv wins. Every call is appended to PIPELINE_FAKE_GH_LOG as
// one JSON line {argv, cwd}.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const entries = JSON.parse(readFileSync(process.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
const log = process.env.PIPELINE_FAKE_GH_LOG;
const firstMatch = (text) => entries.findIndex((e) => new RegExp(e.match).test(text));

const idx = firstMatch(joined);
let earlier = 0;
if (log && existsSync(log)) {
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line && firstMatch(JSON.parse(line).argv.join(' ')) === idx) earlier++;
  }
}
if (log) appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);

if (idx < 0) {
  process.stderr.write(`fake-gh-seq: no match for ${joined}`);
  process.exitCode = 99;
} else {
  const entry = entries[idx];
  const hit = entry.sequence ? entry.sequence[Math.min(earlier, entry.sequence.length - 1)] : entry;
  if (hit.stdoutJson !== undefined) process.stdout.write(JSON.stringify(hit.stdoutJson));
  else if (hit.stdout) process.stdout.write(hit.stdout);
  if (hit.stderr) process.stderr.write(hit.stderr);
  process.exitCode = hit.code ?? 0;
}
