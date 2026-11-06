// Scaffolding for the merge-hold tests (merge-hold*.test.mjs): a repo whose pipeline.yml names the three merge.hold_* commands, a
// fake provider script behind them (logs every call, answers from env) and a merge command that can print EagleWatch's
// queued-behind line. The real CLI runs against the scripted fake gh, as in the other merge tests.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ymlFor } from './gate-env.mjs';

// EagleWatch's exact line (scripts/lib/merge-hold.mjs queuedBehindReasons), as its merge gate prints it on stderr.
export const EW_QUEUED_LINE = 'hold:queued-behind  queued behind #1400 — do NOT update this branch until #1400 merges '
  + '(PR #1400 "Roster card" holds the merge queue — merge-hold since 14:05 PHT, expires 15:35 PHT). This PR\'s own merge-hold keeps its place in the queue.';

export const HOLD_KEYS = [
  '  hold_command: node scripts/fake-hold.mjs take {pr}',
  '  hold_release_command: node scripts/fake-hold.mjs release {pr} {reason}',
  '  hold_check_command: node scripts/fake-hold.mjs check {pr}',
].join('\n');

// A pipeline.yml with the hold keys appended to the merge section (after wait_minutes); `merge` rewrites the merge command line.
export const holdYml = ({ merge } = {}) => {
  const base = ymlFor();
  const withHold = base.replace('  wait_minutes: 1\n', `  wait_minutes: 1\n${HOLD_KEYS}\n`);
  return merge ? withHold.replace('node scripts/fake-merge.mjs {pr} {sha}', merge) : withHold;
};

// check / take / release in one script. Env: FAKE_HOLD_CHECK_SEQ = JSON array of what the nth `check` prints (the last one repeats; a
// non-string is JSON-encoded); FAKE_HOLD_CHECK_EXIT / FAKE_HOLD_TAKE_EXIT / FAKE_HOLD_RELEASE_EXIT = the exit code. Every call also writes
// `<verb> <n>` to .review/hold-puts.log, n = the update-branch PUTs the fake gh had logged by then (holdPuts: order of hold calls vs the PUT).
export const FAKE_HOLD = [
  "import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "const [verb, ...rest] = process.argv.slice(2);",
  "const log = '.review/hold-calls.log';",
  "const before = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('check')).length : 0;",
  "appendFileSync(log, `${verb} ${rest.join(' ')}\\n`);",
  "const ghLog = process.env.PIPELINE_FAKE_GH_LOG;",
  "const puts = ghLog && existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\\n').filter((l) => l.includes('update-branch')).length : 0;",
  "appendFileSync('.review/hold-puts.log', `${verb} ${puts}\\n`);",
  "const exit = (name) => process.exit(Number(process.env[name] ?? 0));",
  "if (verb === 'take') { console.log('hold taken'); exit('FAKE_HOLD_TAKE_EXIT'); }",
  "if (verb === 'release') { console.log('hold released'); exit('FAKE_HOLD_RELEASE_EXIT'); }",
  "if (verb === 'check') {",
  "  console.log('merge-hold: reading labels');",
  "  const seq = JSON.parse(process.env.FAKE_HOLD_CHECK_SEQ ?? '[]');",
  "  const one = seq[Math.min(before, seq.length - 1)];",
  "  if (one !== undefined) console.log(typeof one === 'string' ? one : JSON.stringify(one));",
  "  exit('FAKE_HOLD_CHECK_EXIT');",
  '}',
  'process.exit(9);',
  '',
].join('\n');

// A merge command like the fake one, plus: FAKE_MERGE_QUEUED = print EagleWatch's queued-behind line on stderr only (followed by
// FAKE_MERGE_NOISE lines of noise) and exit 1.
export const FAKE_MERGE_QUEUEING = [
  "import { appendFileSync, mkdirSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
  "if (process.env.FAKE_MERGE_QUEUED) {",
  "  process.stderr.write(`${process.env.FAKE_MERGE_QUEUED}\\n`);",
  "  for (let i = 0; i < Number(process.env.FAKE_MERGE_NOISE ?? 0); i++) process.stderr.write(`noise ${i}\\n`);",
  '  process.exit(1);',
  '}',
  "if (process.env.FAKE_MERGE_EXIT) { process.stderr.write('merge gate refused: base moved\\n'); process.exit(Number(process.env.FAKE_MERGE_EXIT)); }",
  '',
].join('\n');

export const holdFiles = { 'scripts/fake-hold.mjs': FAKE_HOLD, 'scripts/fake-merge.mjs': FAKE_MERGE_QUEUEING };

// What the check prints for PR n: a banner is printed by the script itself, this is the JSON line.
export const answer = (pr, blockedBy = []) => JSON.stringify({ pr, blockedBy });
export const blocker = (number = 1400, extra = {}) => ({ number, title: 'Roster card', since: '2026-11-05T06:05:00.000Z', expires: '2026-11-05T07:35:00.000Z', ...extra });
export const seq = (...answers) => JSON.stringify(answers);

export const holdCalls = (s) => {
  const file = join(s.repo.dir, '.review', 'hold-calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};

// `<verb> <PUTs made so far>` per hold call, oldest first.
export const holdPuts = (s) => {
  const file = join(s.repo.dir, '.review', 'hold-puts.log');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};
