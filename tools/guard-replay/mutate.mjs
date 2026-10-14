// usage: node tools/guard-replay/mutate.mjs <worktree> <mutations.json> <testFile>...
// Mutation check: each mutation (a fix reverted on its own) must make a test fail. The file is restored after every run.
// mutations.json: an array of { name, file (path relative to <worktree>), from, to, defensive? }.
//   `from` must occur exactly once in the file, else the mutation is SKIPped (counts as bad).
//   Mark a mutation `defensive` only when another layer catches it (it may then pass the tests without being a miss).
// testFile paths are relative to <worktree> (or absolute); `node --test <testFile>...` runs in a child with a 240 s timeout.
// First the same command runs once on the unmodified tree; unless it exits 0 with `ℹ fail 0` and pass > 0, nothing is mutated.
// Prints one line per mutation: caught / defens. / MISSED / error. A mutation is "caught" only when the run printed
//   `ℹ fail N` with N > 0; a spawn error, signal, timeout or unparsed output is "error" (never caught).
// Exit 1 if a non-defensive mutation is missed or skipped, or any run errored. Ctrl-C / SIGTERM stop the child, restore the
//   file (a copy of the original sits in os.tmpdir() meanwhile), then exit 130 / 143.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import os from 'node:os';
const [worktree, mutFile, ...tests] = process.argv.slice(2);
if (!worktree || !mutFile || !tests.length) { console.error('usage: node tools/guard-replay/mutate.mjs <worktree> <mutations.json> <testFile>...'); process.exit(2); }
const root = resolve(worktree);
const TESTS = tests.map((t) => resolve(root, t));
const muts = JSON.parse(readFileSync(mutFile, 'utf8'));
const TIMEOUT_MS = 240000;

// Signals only record the interruption and stop the child; the loop restores the file, then exits.
let interrupted = null, child = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { interrupted ??= sig; child?.kill('SIGTERM'); });
}
const exitCodeFor = (sig) => (sig === 'SIGINT' ? 130 : 143);

// Runs the tests in a child. Resolves { status, signal, error, timedOut, stdout }; never rejects.
const runTests = () => new Promise((done) => {
  if (interrupted) return done({ status: null, signal: interrupted, error: null, timedOut: false, stdout: '' });
  let stdout = '', error = null, timedOut = false, settled = false;
  const finish = (status, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child = null;
    done({ status, signal, error, timedOut, stdout });
  };
  // spec reporter by name: Node 20/22 print TAP (`# fail N`) when stdout is a pipe, and `count` reads the spec summary
  const c = spawn(process.execPath, ['--test', '--test-reporter=spec', ...TESTS], { stdio: ['ignore', 'pipe', 'pipe'] });
  child = c;
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d) => { stdout += d; });
  c.stderr.resume();
  const timer = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, TIMEOUT_MS);
  c.on('error', (e) => { error = e; finish(null, null); });
  c.on('close', (status, signal) => finish(status, signal));
});
const count = (out, label) => { const m = new RegExp('ℹ ' + label + ' (\\d+)').exec(out); return m ? Number(m[1]) : null; };

// Baseline: the unmutated tree must pass, else every "caught" below would be meaningless.
const base = await runTests();
if (interrupted) process.exit(exitCodeFor(interrupted));
const bFail = count(base.stdout, 'fail'), bPass = count(base.stdout, 'pass');
if (base.error || base.signal || base.timedOut || base.status !== 0 || bFail !== 0 || !(bPass > 0)) {
  const why = base.error ? 'could not start: ' + base.error.message
    : base.timedOut ? 'timed out after ' + TIMEOUT_MS / 1000 + ' s'
    : base.signal ? 'killed by ' + base.signal
    : 'exit ' + base.status + ', fail ' + (bFail ?? '?') + ', pass ' + (bPass ?? '?');
  console.error('baseline run on the unmodified tree did not pass (' + why + '); nothing was mutated.');
  const tail = base.stdout.trim().split('\n').slice(-15).join('\n');
  if (tail) console.error(tail);
  process.exit(1);
}

let bad = 0;
for (const { name, file: rel, from, to, defensive } of muts) {
  if (interrupted) break;
  const file = resolve(root, rel);
  const orig = readFileSync(file, 'utf8');
  const parts = orig.split(from); // split/join, never String.replace: a `$` in `to` would be corrupted
  if (parts.length !== 2) { console.log('SKIP (pattern count ' + (parts.length - 1) + '):', name); bad++; continue; }
  // The original lives in memory while the tests run; keep a copy outside the repo in case this process dies unrestored.
  const backupDir = mkdtempSync(join(os.tmpdir(), 'mutate-backup-'));
  const backup = join(backupDir, 'original');
  writeFileSync(backup, orig);
  let restored = false;
  try {
    writeFileSync(file, parts.join(to));
    const r = await runTests();
    const fail = count(r.stdout, 'fail');
    if (interrupted) { /* result is meaningless; the file is restored below */ }
    else if (r.error || r.signal || r.timedOut || fail === null) {
      const why = r.error ? 'could not start: ' + r.error.message : r.timedOut ? 'timeout' : r.signal ? 'signal ' + r.signal : 'unparsed output';
      bad++;
      console.log('error  ', `(${why})`, name);
    } else {
      const caught = fail > 0;
      if (!caught && !defensive) bad++;
      console.log(caught ? 'caught ' : defensive ? 'defens.' : 'MISSED ', `(fail ${fail})`, name);
    }
  } finally {
    try { writeFileSync(file, orig); restored = true; } catch (e) { console.error('RESTORE FAILED for ' + file + ': ' + e.message + '\n  original content is saved at ' + backup); }
    if (restored) rmSync(backupDir, { recursive: true, force: true });
    // the file may still hold the mutation: never run on (a later mutation would take it as the original) or exit 0
    else process.exit(1);
  }
  if (interrupted) {
    console.error('interrupted by ' + interrupted + ': restored ' + file + ' (backup copy ' + backup + (restored ? ' removed' : ' KEPT') + ').');
    process.exit(restored ? exitCodeFor(interrupted) : 1);
  }
}
if (interrupted) process.exit(exitCodeFor(interrupted));
process.exit(bad ? 1 : 0);
