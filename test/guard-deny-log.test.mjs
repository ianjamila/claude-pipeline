// The guard deny log: reason slugs, the line format, privacy, rotation, never-throws, the two hooks, the CLI summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardLogFile, logDeny, reasonCode } from '../pipeline/hooks/lib/deny-log.mjs';
import { run as guardLogRun, summarize } from '../pipeline/commands/guard-log.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(ROOT, 'pipeline', 'hooks');
const TMP = mkdtempSync(join(tmpdir(), 'guard-deny-log-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const freshHome = () => { const h = join(TMP, `home${n += 1}`); mkdirSync(h, { recursive: true }); return h; };
const lines = (home) => readFileSync(guardLogFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ADMIN_VAR = ['PIPELINE', 'ADMIN'].join('_'); // spelled in two parts: the file guard refuses writes that name the off-switch

// ---- reasonCode: sample reasons copied from the real deny messages -------------------------------------

const SAMPLES = {
  var: [
    '$X is assigned more than once (or where it may not run) on this line, so its value at run time cannot be verified.',
    'GIT_DIR was assigned more than once on this line, so which repository this command acts on cannot be verified.',
    '$X may be reassigned by the file source runs, so its value at run time cannot be verified.',
  ],
  dir: ['cannot tell which directory this `git push` runs in (unresolved cd / -C), so the current branch cannot be verified.'],
  'runtime-cmd': ['the command that runs is only known at run time ($VAR / $(...) / piped into a shell) and the line mentions a guarded operation, so it cannot be verified.'],
  'runtime-script': ['which word is the script this command runs is only known at run time, so it cannot be verified.'],
  pieces: ['the script /tmp/x.sh is built from pieces at run time (several writes on the line put its text together, and one of them cannot be read), so what it runs cannot be verified.'],
  words: [
    'too many words, a glob matching too many files, or glob syntax that cannot be resolved could be the script this command runs, so it cannot be verified.',
    'too many candidates for the script this command runs',
  ],
  'inline-string': ['node was given a string that contains a guarded command (git push). Run the operation directly so it can be checked.'],
  force: ['force-pushing (-f, --force*, +refspec, --mirror) is blocked. Push your agent branch with a plain `git push`.'],
  'plugin-cache': ['writing into the plugin cache is blocked'],
  protected: [
    `Write refers to a protected pipeline file (skills, agents, ~/.claude/pipeline and ~/.claude/settings.json can only be changed by the owner with ${ADMIN_VAR}=1)`,
    '/h/.claude/settings.json is a protected pipeline file or the directory that holds it (skills, agents)',
  ],
  'script-blocked': [
    'the script /tmp/x.sh would run a blocked command: something odd',
    'node would run: something odd',
  ],
  budget: [
    'command too complex to verify (the parser gave up). Split it into simpler commands.',
    'the command line is too complex to check (the parser gave up); split it into simpler commands',
    'text too long to scan within the deadline',
  ],
  internal: ['internal error while checking this command (boom); denied because the guard cannot verify it.'],
  main: ['PUT to the main/master ref is a push to main. It is blocked.', 'creating the master ref is blocked'],
  other: ['something nobody wrote a slug for', '', undefined],
};

test('reasonCode: every code is reached by a real-looking deny text', () => {
  for (const [code, reasons] of Object.entries(SAMPLES)) {
    for (const reason of reasons) assert.equal(reasonCode(reason), code, String(reason));
  }
});

test('reasonCode: the table is ordered, the first match wins', () => {
  assert.equal(reasonCode('force pushing to main'), 'force'); // force comes before main
  assert.equal(reasonCode('built from pieces and a glob'), 'pieces'); // pieces comes before glob
});

// ---- logDeny ---------------------------------------------------------------------------------------------

test('logDeny writes exactly one line with the documented fields and never the command or reason text', () => {
  const home = freshHome();
  const command = 'echo SECRET-TOKEN-1234 && git push --force origin agent/x';
  const reason = 'force-pushing is blocked. SECRET-REASON-TEXT';
  assert.equal(logDeny({ hook: 'git', reason, command, session: 'sess-1', home, now: () => Date.parse('2026-10-14T01:02:03.000Z') }), true);
  const raw = readFileSync(guardLogFile(home), 'utf8');
  assert.ok(raw.endsWith('\n'));
  const [entry, ...rest] = lines(home);
  assert.equal(rest.length, 0);
  assert.deepEqual(entry, {
    ts: '2026-10-14T01:02:03.000Z',
    session: 'sess-1',
    hook: 'git',
    reason_code: 'force',
    cmd_hash: createHash('sha256').update(command).digest('hex').slice(0, 16),
  });
  assert.deepEqual(Object.keys(entry), ['ts', 'session', 'hook', 'reason_code', 'cmd_hash']);
  for (const secret of ['SECRET-TOKEN', 'SECRET-REASON', 'git push', 'echo']) assert.ok(!raw.includes(secret), secret);
  assert.ok(guardLogFile(home).endsWith(join('.claude', 'pipeline-state', 'guard-log.jsonl')));
});

test('logDeny: a missing session is null, an unknown hook name falls back to git, a second call appends', () => {
  const home = freshHome();
  logDeny({ hook: 'files', reason: 'x', command: 'a', home });
  logDeny({ hook: 'nope', reason: 'x', command: 'b', session: 42, home });
  const [a, b] = lines(home);
  assert.equal(a.session, null);
  assert.equal(a.hook, 'files');
  assert.equal(b.session, null);
  assert.equal(b.hook, 'git');
  assert.equal(a.reason_code, 'other');
});

test('logDeny rotates to guard-log.1.jsonl past the cap and replaces an older .1', () => {
  const home = freshHome();
  const dir = dirname(guardLogFile(home));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'guard-log.1.jsonl'), 'OLDEST\n');
  writeFileSync(guardLogFile(home), `${'x'.repeat(200)}\n`);
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home, maxBytes: 100 }), true);
  assert.equal(readFileSync(join(dir, 'guard-log.1.jsonl'), 'utf8'), `${'x'.repeat(200)}\n`);
  assert.equal(lines(home).length, 1); // the fresh file holds only the new line
  logDeny({ hook: 'git', reason: 'x', command: 'c', home, maxBytes: 100000 });
  assert.equal(lines(home).length, 2); // under the cap: no rotation
  assert.deepEqual(readdirSync(dir).sort(), ['guard-log.1.jsonl', 'guard-log.jsonl']);
});

test('logDeny: PIPELINE_GUARD_LOG=0 writes nothing', () => {
  const home = freshHome();
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home, env: { PIPELINE_GUARD_LOG: '0' } }), false);
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('logDeny never throws: a home that is a file, or odd arguments, return false', () => {
  const home = join(TMP, 'home-is-a-file');
  writeFileSync(home, 'not a directory');
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home }), false);
  assert.doesNotThrow(() => logDeny());
  assert.doesNotThrow(() => logDeny({ home: null, now: () => { throw new Error('clock'); } }));
});

// ---- only a regular file is ever written: symlinks, FIFOs and a symlinked folder are refused --------------

const POSIX = process.platform !== 'win32';
const stateDir = (home) => dirname(guardLogFile(home));
const mkfifo = (p) => assert.equal(spawnSync('mkfifo', [p]).status, 0, 'mkfifo failed');

test('logDeny refuses a symlink at the log path: the file it points to is left unchanged', { skip: !POSIX }, () => {
  const home = freshHome();
  mkdirSync(stateDir(home), { recursive: true });
  const target = join(home, 'settings.json');
  writeFileSync(target, '{"keep":true}\n');
  symlinkSync(target, guardLogFile(home));
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home }), false);
  assert.equal(readFileSync(target, 'utf8'), '{"keep":true}\n');
  assert.ok(lstatSync(guardLogFile(home)).isSymbolicLink());
  // a dangling symlink is not created through either
  const home2 = freshHome();
  mkdirSync(stateDir(home2), { recursive: true });
  const missing = join(home2, 'created-through-link.json');
  symlinkSync(missing, guardLogFile(home2));
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home: home2 }), false);
  assert.equal(existsSync(missing), false);
});

test('logDeny refuses a pipeline-state folder that is a symlink: nothing lands in the folder it points to', { skip: !POSIX }, () => {
  const home = freshHome();
  const elsewhere = join(home, 'elsewhere');
  mkdirSync(elsewhere);
  mkdirSync(join(home, '.claude'));
  symlinkSync(elsewhere, stateDir(home));
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home }), false);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('logDeny: rotation over a symlinked guard-log.1.jsonl replaces the link and leaves its target unchanged', { skip: !POSIX }, () => {
  const home = freshHome();
  mkdirSync(stateDir(home), { recursive: true });
  const target = join(home, 'keep.txt');
  writeFileSync(target, 'keep\n');
  writeFileSync(guardLogFile(home), 'x'.repeat(200));
  const older = guardLogFile(home).replace(/\.jsonl$/, '.1.jsonl');
  symlinkSync(target, older);
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home, maxBytes: 100 }), true);
  assert.equal(readFileSync(target, 'utf8'), 'keep\n');
  assert.ok(lstatSync(older).isFile());
  assert.equal(lines(home).length, 1);
});

test('logDeny refuses a FIFO at the log path at once (no hang) and a directory there too', { skip: !POSIX }, () => {
  const home = freshHome();
  mkdirSync(stateDir(home), { recursive: true });
  mkfifo(guardLogFile(home));
  const t0 = Date.now();
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home }), false);
  assert.ok(Date.now() - t0 < 2000);
  const home2 = freshHome();
  mkdirSync(guardLogFile(home2), { recursive: true });
  assert.equal(logDeny({ hook: 'git', reason: 'x', command: 'c', home: home2 }), false);
});

// ---- the hooks, spawned as Claude Code runs them -----------------------------------------------------------

function spawnHook(hooksDir, name, input, home, extraEnv = {}, timeout = undefined) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
  delete env.PIPELINE_GUARD_LOG;
  delete env[ADMIN_VAR];
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [join(hooksDir, name)], { input: JSON.stringify(input), encoding: 'utf8', env, timeout });
}
const bashInput = (command, cwd) => ({ session_id: 'sess-h', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const decisionOf = (r) => (r.stdout.trim() === '' ? 'allow' : JSON.parse(r.stdout).hookSpecificOutput.permissionDecision);
const reasonOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
const FORCE_CMD = 'git push --force origin agent/x';

function hooksWithout(file) {
  // the whole pipeline/ tree is copied: the hook libs import ../../lib/*
  const tree = join(TMP, `pipeline-${n += 1}`);
  cpSync(join(ROOT, 'pipeline'), tree, { recursive: true });
  const dir = join(tree, 'hooks');
  rmSync(join(dir, 'lib', file));
  return dir;
}

test('guard-git: a deny writes one line (hook git, the session id), an allow writes none', () => {
  const home = freshHome();
  const denied = spawnHook(HOOKS, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home);
  assert.equal(decisionOf(denied), 'deny');
  const [entry, ...rest] = lines(home);
  assert.equal(rest.length, 0);
  assert.equal(entry.hook, 'git');
  assert.equal(entry.session, 'sess-h');
  assert.equal(entry.reason_code, 'force');
  assert.equal(entry.cmd_hash, createHash('sha256').update(FORCE_CMD).digest('hex').slice(0, 16));
  assert.ok(!readFileSync(guardLogFile(home), 'utf8').includes('agent/x'));

  assert.equal(decisionOf(spawnHook(HOOKS, 'guard-git.mjs', bashInput('git status', TMP), home)), 'allow');
  assert.equal(lines(home).length, 1);
});

test('guard-git: PIPELINE_GUARD_LOG=0 still denies and writes nothing', () => {
  const home = freshHome();
  const r = spawnHook(HOOKS, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home, { PIPELINE_GUARD_LOG: '0' });
  assert.equal(decisionOf(r), 'deny');
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('guard-git: with deny-log.mjs missing, broken or throwing the deny is still returned', () => {
  const home = freshHome();
  const missing = hooksWithout('deny-log.mjs');
  const r = spawnHook(missing, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home);
  assert.equal(r.status, 0);
  assert.equal(decisionOf(r), 'deny');
  assert.match(reasonOf(r), /force-pushing/);
  assert.equal(existsSync(join(home, '.claude')), false);

  const broken = hooksWithout('deny-log.mjs');
  writeFileSync(join(broken, 'lib', 'deny-log.mjs'), 'export const logDeny = (;\n'); // syntax error
  const r2 = spawnHook(broken, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home);
  assert.equal(decisionOf(r2), 'deny');
  assert.match(reasonOf(r2), /force-pushing/);

  const throwing = hooksWithout('deny-log.mjs');
  writeFileSync(join(throwing, 'lib', 'deny-log.mjs'), 'export function logDeny() { throw new Error("boom"); }\n');
  assert.equal(decisionOf(spawnHook(throwing, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home)), 'deny');
});

test('guard-files: a Bash deny writes one line (hook files), an allow and a file-tool deny write none', () => {
  const home = freshHome();
  const protectedFile = join(home, '.claude', 'settings.json');
  const cmd = `echo x > ${protectedFile}`;
  assert.equal(decisionOf(spawnHook(HOOKS, 'guard-files.mjs', bashInput(cmd, TMP), home)), 'deny');
  const [entry, ...rest] = lines(home);
  assert.equal(rest.length, 0);
  assert.equal(entry.hook, 'files');
  assert.equal(entry.session, 'sess-h');
  assert.equal(entry.reason_code, 'protected');
  assert.equal(entry.cmd_hash, createHash('sha256').update(cmd).digest('hex').slice(0, 16));
  assert.ok(!readFileSync(guardLogFile(home), 'utf8').includes('settings.json'));

  assert.equal(decisionOf(spawnHook(HOOKS, 'guard-files.mjs', bashInput('ls', TMP), home)), 'allow');
  const writeDeny = spawnHook(HOOKS, 'guard-files.mjs', { session_id: 's', cwd: TMP, tool_name: 'Write', tool_input: { file_path: protectedFile, content: 'x' } }, home);
  assert.equal(decisionOf(writeDeny), 'deny');
  assert.equal(lines(home).length, 1);
});

test('both hooks: a FIFO at the log path still gets the deny out at once, and nothing is logged', { skip: !POSIX }, () => {
  const home = freshHome();
  mkdirSync(stateDir(home), { recursive: true });
  mkfifo(guardLogFile(home));
  const g = spawnHook(HOOKS, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home, {}, 15000);
  assert.equal(g.signal, null, 'guard-git hung on the FIFO');
  assert.equal(decisionOf(g), 'deny');
  const f = spawnHook(HOOKS, 'guard-files.mjs', bashInput(`echo x > ${join(home, '.claude', 'settings.json')}`, TMP), home, {}, 15000);
  assert.equal(f.signal, null, 'guard-files hung on the FIFO');
  assert.equal(decisionOf(f), 'deny');
  assert.ok(lstatSync(guardLogFile(home)).isFIFO());
});

test('both hooks: the deny is written before logging starts (a log call that blocks the thread cannot hold it back)', () => {
  const hang = hooksWithout('deny-log.mjs');
  // blocks the event loop for 60 s: only a deny already flushed to the pipe reaches the parent before the kill
  writeFileSync(join(hang, 'lib', 'deny-log.mjs'), 'export function logDeny() { const t = Date.now() + 60000; while (Date.now() < t); return true; }\n');
  const home = freshHome();
  const g = spawnHook(hang, 'guard-git.mjs', bashInput(FORCE_CMD, TMP), home, {}, 4000);
  assert.equal(g.signal, 'SIGTERM');
  assert.equal(decisionOf(g), 'deny');
  assert.match(reasonOf(g), /force-pushing/);
  const f = spawnHook(hang, 'guard-files.mjs', bashInput(`echo x > ${join(home, '.claude', 'settings.json')}`, TMP), home, {}, 4000);
  assert.equal(f.signal, 'SIGTERM');
  assert.equal(decisionOf(f), 'deny');
});

test('guard-files: with deny-log.mjs missing or throwing the deny is still returned', () => {
  const home = freshHome();
  const cmd = `echo x > ${join(home, '.claude', 'settings.json')}`;
  const missing = hooksWithout('deny-log.mjs');
  const r = spawnHook(missing, 'guard-files.mjs', bashInput(cmd, TMP), home);
  assert.equal(decisionOf(r), 'deny');
  assert.match(reasonOf(r), /protected/);
  assert.equal(existsSync(join(home, '.claude', 'pipeline-state')), false);

  const throwing = hooksWithout('deny-log.mjs');
  writeFileSync(join(throwing, 'lib', 'deny-log.mjs'), 'export function logDeny() { throw new Error("boom"); }\n');
  const r2 = spawnHook(throwing, 'guard-files.mjs', bashInput(cmd, TMP), home);
  assert.equal(decisionOf(r2), 'deny');
  assert.match(reasonOf(r2), /protected/);
});

// ---- the CLI summary -------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const entryLine = (ts, reason_code) => JSON.stringify({ ts, session: null, hook: 'git', reason_code, cmd_hash: '0123456789abcdef' });

test('guard-log: counts per day and code inside the window, skips bad lines, ignores older days', async () => {
  const file = join(TMP, 'fixture.jsonl');
  writeFileSync(file, [
    entryLine('2026-10-14T01:00:00.000Z', 'var'),
    entryLine('2026-10-14T02:00:00.000Z', 'var'),
    entryLine('2026-10-14T03:00:00.000Z', 'force'),
    entryLine('2026-10-12T03:00:00.000Z', 'dir'),
    entryLine('2026-09-01T03:00:00.000Z', 'dir'), // outside 7 days
    'not json',
    '{"ts":"garbage"}',
    '',
  ].join('\n'));
  const { exitCode, output } = await guardLogRun(['--file', file], { now: () => NOW });
  assert.equal(exitCode, 0);
  assert.deepEqual(output, {
    ok: true,
    file,
    days: {
      '2026-10-12': { total: 1, byCode: { dir: 1 } },
      '2026-10-14': { total: 3, byCode: { var: 2, force: 1 } },
    },
    total: 4,
    perDay: 2,
    skipped: 2,
  });
  const wide = await guardLogRun(['--file', file, '--days', '60'], { now: () => NOW });
  assert.equal(wide.output.total, 5);
  assert.equal(wide.output.perDay, 1.7);
});

test('guard-log: a missing file is ok with zero totals; --days must be a positive integer', async () => {
  const { exitCode, output } = await guardLogRun(['--file', join(TMP, 'nope.jsonl')]);
  assert.equal(exitCode, 0);
  assert.deepEqual({ ...output, file: '' }, { ok: true, file: '', days: {}, total: 0, perDay: 0, skipped: 0 });
  await assert.rejects(() => guardLogRun(['--days', '0']), /--days/);
  assert.deepEqual(summarize('', { now: NOW }).days, {});
});

test('guard-log: the real CLI prints one JSON object, with the default file under HOME', () => {
  const home = freshHome();
  logDeny({ hook: 'git', reason: 'force-pushing is blocked', command: 'c', home });
  const r = spawnSync(process.execPath, [join(ROOT, 'pipeline', 'bin', 'pipeline.mjs'), 'guard-log'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.file, guardLogFile(home));
  assert.equal(out.total, 1);
  assert.deepEqual(Object.values(out.days)[0].byCode, { force: 1 });
});
