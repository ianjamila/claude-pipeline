// Why: `pipeline update schedule --install` arranges for the guard hooks to be replaced unattended, every few minutes, so the
// parts that must not go wrong are the interval it accepts, the exact job it writes (cron line / launchd plist), never
// touching the owner's other crontab lines, launchd's load/unload order and failures, and refusing inside Claude Code.
// Every outside thing is injected (crontab, launchctl, platform, home, uid, env): nothing here touches the real crontab or launchd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { run as update, meta } from '../pipeline/commands/update.mjs';
import { CRON_MARKER, EVERY_CHOICES, LAUNCHD_LABEL, cronExpression, parseEvery, scheduleInstalled, scheduleLine, schedulePlist } from '../pipeline/lib/update-schedule.mjs';
import { insideClaudeCode } from '../pipeline/lib/auto-update.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'cp-upd-sched-')); made.push(d); return d; };

const OTHER = '30 2 * * * /usr/local/bin/backup --all # nightly\n@reboot /home/me/start.sh\n';
const LINE_ARGS = { nodePath: '/usr/bin/node', binPath: '/home/me/.claude/pipeline/bin/pipeline.mjs', every: 15, pathDirs: ['/usr/bin', '/opt/gh/bin'], logFile: '/home/me/.local/state/pipeline/auto-update.log' };

// A rig: a fake crontab (string), a scripted launchctl, a scratch home with the installed pipeline present.
function rig({ platform = 'linux', crontab = OTHER, launchctl, env = {}, ancestor = false } = {}) {
  const dir = scratch();
  const home = join(dir, 'home');
  // The installed bin and the log directory are what the cron line / plist names, so they are POSIX-style fakes (existsFn vouches
  // for the bin): a host path (C:\\... on Windows CI) would be shell-quoted and not match the Linux/macOS line being simulated.
  const bin = '/home/me/.claude/pipeline/bin/pipeline.mjs';
  const w = { crontab, writes: 0, launchctlCalls: [] };
  const defaultLaunchctl = () => ({ code: 0, stdout: '', stderr: '' });
  const ctx = {
    platform, home, uid: 501, binPath: bin, existsFn: (p) => p === bin || existsSync(p),
    env: { PATH: '/usr/bin', PIPELINE_PRUNE_LOG_DIR: '/home/me/.local/state/pipeline', ...env },
    hasClaudeCodeAncestor: () => ancestor,
    whichFn: (cmd) => `/opt/${cmd}/bin/${cmd}`,
    nodePath: '/opt/node/bin/node',
    tzFn: () => 'Asia/Manila',
    mkdirFn: () => {},
    crontabFn: (op, text) => {
      if (op === 'read') return w.crontab;
      w.writes += 1;
      w.crontab = text;
      return undefined;
    },
    launchctlFn: (args) => { w.launchctlCalls.push(args); return (launchctl ?? defaultLaunchctl)(args, w); },
  };
  const go = (args, extra = {}) => update(['schedule', ...args], { ...ctx, ...extra });
  return { w, ctx, go, dir, home, bin, plist: posix.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`) };
}

test('meta documents update schedule', () => {
  assert.match(meta.usage, /pipeline update schedule \(--install \[--every N\] \| --remove \| --status\)/);
  assert.doesNotMatch(meta.usage, /hourly/i);
});

test('--every accepts 5, 10, 15, 20, 30, 60 and defaults to 15; everything else is a usage error', () => {
  assert.deepEqual([...EVERY_CHOICES], [5, 10, 15, 20, 30, 60]);
  for (const n of EVERY_CHOICES) assert.equal(parseEvery(String(n)), n);
  assert.equal(parseEvery(undefined), 15);
  for (const bad of ['7', '0', '90', '120', '-15', '1.5', 'abc', '', '15m', '1e1', '0x0f']) {
    assert.throws(() => parseEvery(bad), /--every must be one of 5, 10, 15, 20, 30, 60/, `rejects ${JSON.stringify(bad)}`);
  }
});

test('cron expression: */N for 5..30, a fixed minute past the hour for 60', () => {
  assert.equal(cronExpression(15), '*/15 * * * *');
  assert.equal(cronExpression(5), '*/5 * * * *');
  assert.equal(cronExpression(30), '*/30 * * * *');
  assert.equal(cronExpression(60), '17 * * * *');
});

test('cron line: the interval, PATH, no cd, the log, the marker, update --scheduled --json', () => {
  const line = scheduleLine(LINE_ARGS);
  assert.equal(line, `*/15 * * * * PATH='/usr/bin:/opt/gh/bin:/bin' /usr/bin/node /home/me/.claude/pipeline/bin/pipeline.mjs update --scheduled --json >>'/home/me/.local/state/pipeline/auto-update.log' 2>&1 ${CRON_MARKER}`);
  assert.equal(CRON_MARKER, '# claude-pipeline auto-update');
  assert.doesNotMatch(line, /\bcd\b/);
  assert.match(scheduleLine({ ...LINE_ARGS, every: 60 }), /^17 \* \* \* \* /);
  assert.doesNotMatch(line, /hourly/i);
});

test('cron line: node and script are quoted only when they need it; a quote is escaped; every % becomes \\%', () => {
  const line = scheduleLine({ ...LINE_ARGS, nodePath: '/Users/Jane Doe/node', binPath: "/h/it's/pipeline.mjs", logFile: '/logs/100%/au.log', pathDirs: ['/p%q'] });
  assert.match(line, / '\/Users\/Jane Doe\/node' /);
  assert.ok(line.includes(`'/h/it'\\''s/pipeline.mjs'`), line);
  assert.ok(line.includes('/logs/100\\%/au.log'), line);
  assert.ok(line.includes('/p\\%q'), line);
  assert.ok(!/[^\\]%/.test(line), 'no unescaped %');
});

test('cron line: a newline in a path is refused (a crontab line cannot hold one)', () => {
  assert.throws(() => scheduleLine({ ...LINE_ARGS, logFile: '/a\nb' }), /newline/);
});

test('plist: StartInterval is minutes x 60, RunAtLoad true, node + script + update --scheduled --json, PATH, log for stdout and stderr', () => {
  const text = schedulePlist({ ...LINE_ARGS, pathDirs: ['/opt/node/bin'] });
  assert.match(text, /<key>Label<\/key>\s*<string>com\.claude-pipeline\.auto-update<\/string>/);
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(schedulePlist({ ...LINE_ARGS, every: 60, pathDirs: [] }), /<integer>3600<\/integer>/);
  assert.match(schedulePlist({ ...LINE_ARGS, every: 5, pathDirs: [] }), /<integer>300<\/integer>/);
  assert.match(text, /<string>update<\/string>\s*<string>--scheduled<\/string>\s*<string>--json<\/string>/);
  assert.match(text, /<string>\/opt\/node\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  const out = /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)[1];
  assert.equal(out, LINE_ARGS.logFile);
  assert.match(text, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${out.replace(/\//g, '\\/')}</string>`));
  assert.doesNotMatch(text, /hourly/i);
});

test('--install on Linux writes one line, keeps every other crontab line byte-identical, and says how often it runs', async () => {
  const t = rig();
  const r = await t.go(['--install']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  assert.equal(r.output.installed, true);
  assert.equal(r.output.changed, true);
  assert.equal(r.output.every, 15);
  assert.equal(r.output.timezone, 'Asia/Manila');
  assert.match(r.output.note, /every 15 minutes/);
  assert.match(r.output.note, /only on failure/);
  assert.doesNotMatch(r.output.note, /hourly/i);
  assert.ok(t.w.crontab.startsWith(OTHER), 'the owner lines come first, unchanged');
  const ours = t.w.crontab.slice(OTHER.length);
  assert.equal(ours.trimEnd(), r.output.line);
  assert.match(ours, /^\*\/15 \* \* \* \* PATH='\/opt\/node\/bin:\/opt\/git\/bin:\/opt\/gh\/bin:\/usr\/bin:\/bin' \/opt\/node\/bin\/node .*pipeline\.mjs update --scheduled --json >>.*auto-update\.log' 2>&1 # claude-pipeline auto-update\n$/);
  assert.equal(t.w.writes, 1);
});

test('reinstalling the same interval writes nothing and reports changed:false', async () => {
  const t = rig();
  await t.go(['--install']);
  const before = t.w.crontab;
  const r = await t.go(['--install']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.changed, false);
  assert.equal(t.w.crontab, before);
  assert.equal(t.w.writes, 1, 'still just the first write');
});

test('--install --every 60 replaces the line in place (one line, other lines untouched, in order)', async () => {
  const t = rig({ crontab: `${OTHER}` });
  await t.go(['--install']);
  t.w.crontab += '5 5 * * * /after.sh\n';
  const r = await t.go(['--install', '--every', '60']);
  assert.equal(r.output.changed, true);
  assert.equal(r.output.every, 60);
  const lines = t.w.crontab.split('\n');
  assert.equal(lines.filter((l) => l.endsWith(CRON_MARKER)).length, 1);
  assert.match(lines.find((l) => l.endsWith(CRON_MARKER)), /^17 \* \* \* \* /);
  assert.equal(lines.filter((l) => !l.endsWith(CRON_MARKER)).join('\n'), `${OTHER}5 5 * * * /after.sh\n`);
});

test('--status reports the installed line; --remove takes only ours away; removing again is removed:false', async () => {
  const t = rig();
  assert.deepEqual((await t.go(['--status'])).output, { ok: true, installed: false, line: null });
  await t.go(['--install', '--every', '30']);
  const st = await t.go(['--status']);
  assert.equal(st.output.installed, true);
  assert.match(st.output.line, /^\*\/30 /);
  const rm = await t.go(['--remove']);
  assert.deepEqual([rm.exitCode, rm.output.ok, rm.output.removed], [0, true, true]);
  assert.equal(t.w.crontab, OTHER);
  const again = await t.go(['--remove']);
  assert.equal(again.output.removed, false);
  assert.equal(t.w.crontab, OTHER);
});

test('a missing git or gh, or a pipeline that is not installed, is refused with nothing written', async () => {
  const t = rig();
  let r = await t.go(['--install'], { whichFn: (cmd) => (cmd === 'gh' ? null : `/opt/${cmd}/bin/${cmd}`) });
  assert.deepEqual([r.exitCode, r.output.error], [2, 'tool-missing']);
  r = await t.go(['--install'], { existsFn: () => false });
  assert.deepEqual([r.exitCode, r.output.error], [2, 'not-installed']);
  assert.equal(t.w.writes, 0);
});

test('argument errors: exactly one action, --every only with --install, no stray words', async () => {
  const t = rig();
  await assert.rejects(t.go([]), /exactly one of/);
  await assert.rejects(t.go(['--install', '--remove']), /exactly one of/);
  await assert.rejects(t.go(['--status', '--every', '15']), /--every only goes with --install/);
  await assert.rejects(t.go(['--install', '--every', '7']), /--every must be one of/);
  await assert.rejects(t.go(['--install', 'now']), /no arguments/);
  assert.equal(t.w.writes, 0);
});

// ---- macOS

const ok = { code: 0, stdout: '', stderr: '' };
const notLoaded = { code: 113, stdout: '', stderr: 'Could not find service' };

test('macOS --install: writes the plist, boots the old job out THEN bootstraps the new one', async () => {
  const t = rig({ platform: 'darwin', launchctl: (args) => (args[0] === 'bootout' ? { code: 3, stdout: '', stderr: 'No such process' } : ok) });
  const r = await t.go(['--install']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  assert.equal(r.output.installed, true);
  assert.equal(r.output.changed, true);
  assert.equal(r.output.every, 15);
  assert.equal(r.output.plist, t.plist);
  assert.match(r.output.note, /every 15 minutes/);
  assert.deepEqual(t.w.launchctlCalls, [['bootout', `gui/501/${LAUNCHD_LABEL}`], ['bootstrap', 'gui/501', t.plist]]);
  const text = readFileSync(t.plist, 'utf8');
  assert.match(text, /<integer>900<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.equal(t.w.writes, 0, 'the crontab is not touched on macOS');
});

test('macOS reinstall with nothing changed leaves the plist alone but still reloads the job', async () => {
  const t = rig({ platform: 'darwin' });
  await t.go(['--install']);
  const mtime = readFileSync(t.plist, 'utf8');
  t.w.launchctlCalls.length = 0;
  const r = await t.go(['--install']);
  assert.equal(r.output.changed, false);
  assert.equal(readFileSync(t.plist, 'utf8'), mtime);
  assert.deepEqual(t.w.launchctlCalls.map((c) => c[0]), ['bootout', 'bootstrap']);
  const changed = await t.go(['--install', '--every', '60']);
  assert.equal(changed.output.changed, true);
  assert.match(readFileSync(t.plist, 'utf8'), /<integer>3600<\/integer>/);
});

test('macOS: a failing bootstrap is exit 2 {error: launchctl}', async () => {
  const t = rig({ platform: 'darwin', launchctl: (args) => (args[0] === 'bootstrap' ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } : ok) });
  const r = await t.go(['--install']);
  assert.equal(r.exitCode, 2);
  assert.equal(r.output.ok, false);
  assert.equal(r.output.error, 'launchctl');
  assert.match(r.output.message, /Input\/output error/);
});

test('macOS --remove: boots out, confirms with print that it is gone, then deletes the plist', async () => {
  let loaded = true;
  const t = rig({ platform: 'darwin', launchctl: (args) => {
    if (args[0] === 'bootout') { loaded = false; return ok; }
    if (args[0] === 'print') return loaded ? ok : notLoaded;
    return ok;
  } });
  await t.go(['--install']);
  assert.ok(existsSync(t.plist));
  t.w.launchctlCalls.length = 0;
  const r = await t.go(['--remove']);
  assert.deepEqual([r.exitCode, r.output.ok, r.output.removed], [0, true, true]);
  assert.deepEqual(t.w.launchctlCalls, [['bootout', `gui/501/${LAUNCHD_LABEL}`], ['print', `gui/501/${LAUNCHD_LABEL}`]]);
  assert.equal(existsSync(t.plist), false);
  const again = await t.go(['--remove']);
  assert.equal(again.output.removed, false);
});

test('macOS --remove where print still shows the job loaded: exit 2, plist KEPT', async () => {
  const t = rig({ platform: 'darwin', launchctl: (args) => (args[0] === 'bootout' ? { code: 1, stdout: '', stderr: 'Operation not permitted' } : ok) });
  await t.go(['--install']);
  const r = await t.go(['--remove']);
  assert.equal(r.exitCode, 2);
  assert.equal(r.output.error, 'launchctl');
  assert.ok(existsSync(t.plist), 'the plist must stay so the job is not left running with no file to remove it by');
});

test('macOS --remove where print cannot tell (not a "could not find service" answer): exit 2, plist KEPT', async () => {
  const t = rig({ platform: 'darwin', launchctl: (args) => (args[0] === 'print' ? { code: 1, stdout: '', stderr: 'spawn /bin/launchctl ENOENT' } : ok) });
  await t.go(['--install']);
  const r = await t.go(['--remove']);
  assert.deepEqual([r.exitCode, r.output.error], [2, 'launchctl']);
  assert.ok(existsSync(t.plist));
});

test('macOS --status: installed = plist exists AND the job is loaded', async () => {
  let printed = ok;
  const t = rig({ platform: 'darwin', launchctl: (args) => (args[0] === 'print' ? printed : ok) });
  let r = await t.go(['--status']);
  assert.deepEqual([r.output.installed, r.output.line, r.output.loaded], [false, null, true]);
  await t.go(['--install']);
  r = await t.go(['--status']);
  assert.deepEqual([r.output.installed, r.output.line, r.output.loaded], [true, t.plist, true]);
  printed = notLoaded;
  r = await t.go(['--status']);
  assert.deepEqual([r.output.installed, r.output.loaded], [false, false]);
});

test('native Windows (any other platform): exit 2 {error: unsupported-platform} naming cron and launchd, for every action', async () => {
  const t = rig({ platform: 'win32' });
  for (const a of ['--install', '--remove', '--status']) {
    const r = await t.go([a]);
    assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [2, false, 'unsupported-platform'], a);
    assert.match(r.output.message, /Linux\/WSL \(cron\)/);
    assert.match(r.output.message, /macOS \(launchd\)/);
  }
  assert.equal(t.w.writes, 0);
  assert.deepEqual(t.w.launchctlCalls, []);
});

// ---- refusal inside Claude Code

test('--install is refused inside Claude Code (CLAUDECODE=1, or a Claude Code ancestor) on both platforms; nothing is written', async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const variant of [{ env: { CLAUDECODE: '1' } }, { ancestor: true }]) {
      const t = rig({ platform, ...variant });
      const r = await t.go(['--install']);
      assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [2, false, 'refused'], `${platform} ${JSON.stringify(variant)}`);
      assert.match(r.output.message, /refuses to run inside a Claude Code session/);
      assert.equal(t.w.writes, 0);
      assert.deepEqual(t.w.launchctlCalls, []);
      assert.equal(existsSync(t.plist), false);
    }
  }
});

test('--status and --remove are allowed inside Claude Code', async () => {
  for (const platform of ['linux', 'darwin']) {
    const t = rig({ platform, env: { CLAUDECODE: '1' }, ancestor: true, launchctl: (args) => (args[0] === 'print' ? notLoaded : ok) });
    assert.equal((await t.go(['--status'])).exitCode, 0, `${platform} status`);
    assert.equal((await t.go(['--remove'])).exitCode, 0, `${platform} remove`);
  }
});

test('insideClaudeCode: the owner-admin variable bypasses it, like a manual update', () => {
  const never = () => { throw new Error('the process tree must not be consulted'); };
  assert.equal(insideClaudeCode({ CLAUDECODE: '1', ['PIPELINE_' + 'ADMIN']: '1' }, { hasClaudeCodeAncestor: never }), null);
  assert.equal(insideClaudeCode({ CLAUDECODE: '1' }, { hasClaudeCodeAncestor: never }), 'CLAUDECODE=1');
  assert.equal(insideClaudeCode({}, { hasClaudeCodeAncestor: () => true }), 'a Claude Code process is an ancestor of this one');
  assert.equal(insideClaudeCode({}, { hasClaudeCodeAncestor: () => false }), null);
});

// ---- scheduleInstalled: the SessionStart hook's cheap question --------------------------------------------------------

const crontabWith = (every) => `${OTHER}${scheduleLine({ ...LINE_ARGS, every })}\n`;

test('scheduleInstalled (linux): finds the marker line and reads the interval from */N, or 60 from the once-an-hour form', () => {
  for (const every of EVERY_CHOICES) {
    assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => crontabWith(every) }), { installed: true, every }, String(every));
  }
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => `17 * * * * /x ${CRON_MARKER}\n` }), { installed: true, every: 60 });
});

test('scheduleInstalled (linux): other lines, a commented-out marker, a marker with a form it cannot read, and garbage', () => {
  const none = { installed: false, every: null };
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => OTHER }), none);
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => '' }), none);
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => `#${scheduleLine(LINE_ARGS)}\n` }), none, 'a commented-out job does not run');
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => '\u0000\ufffd not a crontab \n*/x * * * *' }), none);
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => `@daily /x ${CRON_MARKER}\n` }), { installed: true, every: null });
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => `*/0 * * * * /x ${CRON_MARKER}\n` }), { installed: true, every: null });
});

test('scheduleInstalled (linux): a crontab read that throws or returns junk is "not installed", never a throw', () => {
  const none = { installed: false, every: null };
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => { throw new Error('crontab: not found'); } }), none);
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => undefined }), none);
  assert.deepEqual(scheduleInstalled({ platform: 'linux', crontabRead: () => 42 }), none);
});

test('scheduleInstalled (darwin): reads StartInterval from the plist in the given home; no file, no key or garbage is handled', () => {
  const plistFor = (every) => schedulePlist({ ...LINE_ARGS, every });
  const seen = [];
  const read = (text) => (f) => { seen.push(f); return text; };
  assert.deepEqual(scheduleInstalled({ platform: 'darwin', home: '/Users/me', readFile: read(plistFor(15)) }), { installed: true, every: 15 });
  assert.deepEqual(seen, [`/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`]);
  assert.equal(plistFor(15).includes('<integer>900</integer>'), true);
  assert.deepEqual(scheduleInstalled({ platform: 'darwin', readFile: read(plistFor(60)) }), { installed: true, every: 60 });
  assert.deepEqual(scheduleInstalled({ platform: 'darwin', readFile: read('<plist><dict></dict></plist>') }), { installed: true, every: null });
  assert.deepEqual(scheduleInstalled({ platform: 'darwin', readFile: read('<key>StartInterval</key><integer>90</integer>') }), { installed: true, every: null });
  assert.deepEqual(scheduleInstalled({ platform: 'darwin', readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }), { installed: false, every: null });
  assert.deepEqual(scheduleInstalled({ platform: 'darwin', readFile: read(undefined) }), { installed: false, every: null });
});

test('scheduleInstalled: other platforms are never installed, and the crontab is not read', () => {
  let reads = 0;
  assert.deepEqual(scheduleInstalled({ platform: 'win32', crontabRead: () => { reads += 1; return crontabWith(15); } }), { installed: false, every: null });
  assert.equal(reads, 0);
});
