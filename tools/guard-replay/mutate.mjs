// usage: node tools/guard-replay/mutate.mjs <worktree> <mutations.json> <testFile>...
// Mutation check: each mutation (a fix reverted on its own) must make a test fail. The file is restored after every run.
// mutations.json: an array of { name, file (path relative to <worktree>), from, to, defensive? }.
//   `from` must occur exactly once in the file, else the mutation is SKIPped (counts as bad).
//   Mark a mutation `defensive` only when another layer catches it (it may then pass the tests without being a miss).
// testFile paths are relative to <worktree> (or absolute); `node --test <testFile>...` runs in a child with a 240 s timeout.
// Prints one line per mutation: caught / defens. / MISSED. Exit 1 if a non-defensive mutation is missed or skipped.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const [worktree, mutFile, ...tests] = process.argv.slice(2);
if (!worktree || !mutFile || !tests.length) { console.error('usage: node tools/guard-replay/mutate.mjs <worktree> <mutations.json> <testFile>...'); process.exit(2); }
const root = resolve(worktree);
const TESTS = tests.map((t) => resolve(root, t));
const muts = JSON.parse(readFileSync(mutFile, 'utf8'));
let bad = 0;
for (const { name, file: rel, from, to, defensive } of muts) {
  const file = resolve(root, rel);
  const orig = readFileSync(file, 'utf8');
  const parts = orig.split(from); // split/join, never String.replace: a `$` in `to` would be corrupted
  if (parts.length !== 2) { console.log('SKIP (pattern count ' + (parts.length - 1) + '):', name); bad++; continue; }
  writeFileSync(file, parts.join(to));
  try {
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { encoding: 'utf8', timeout: 240000 });
    const fail = /ℹ fail (\d+)/.exec(r.stdout)?.[1];
    const caught = r.status !== 0 && fail !== '0';
    if (!caught && !defensive) bad++;
    console.log(caught ? 'caught ' : defensive ? 'defens.' : 'MISSED ', `(fail ${fail ?? '?'})`, name);
  } finally {
    writeFileSync(file, orig);
  }
}
process.exit(bad ? 1 : 0);
