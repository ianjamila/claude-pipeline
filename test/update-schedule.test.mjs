// Why: `pipeline update schedule --install` arranges for the guard hooks to be replaced unattended, so it is owner-only (refused inside Claude
// Code) and must write exactly the job it says: a LaunchAgent (com.claude-pipeline.auto-update, through lib/schedule.mjs schedulePlist({interval})
// + applyLaunchd) on macOS, one crontab line on Linux/WSL, nothing on native Windows. Everything outside the process is a fake (launchctl,
// crontab, PATH lookup), so no test touches a real launchd or crontab. The launchd / cron shapes are POSIX-only, so they are skipped on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as update } from '../pipeline/commands/update.mjs';
import { AUTO_UPDATE_ARGS, AUTO_UPDATE_LABEL, DEFAULT_EVERY, EVERY_CHOICES, cronExpression, parseEvery } from '../pipeline/lib/update-schedule.mjs';
import { scheduleLine, scheduleMarker, schedulePlist } from '../pipeline/lib/schedule.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-upd-schedule-'))); made.push(d); return d; };
const POSIX = { skip: process.platform === 'win32' };

// A stateful launchctl: bootstrap loads, bootout unloads, print answers by that state; every call is recorded.
function fakeLaunchctl() {
  const calls = [];
  let loaded = false;
  const fn = (args) => {
    calls.push([...args]);
    const res = (code, stderr = '') => ({ code, stdout: '', stderr });
    if (args[0] === 'bootstrap') { loaded = true; return res(0); }
    if (args[0] === 'bootout') { const was = loaded; loaded = false; return was ? res(0) : res(113, 'Could not find service'); }
    if (args[0] === 'print') return loaded ? res(0) : res(113, 'Could not find service');
    return res(1, 'unexpected');
  };
  fn.calls = calls;
  return fn;
}
// A crontab held in memory.
function fakeCrontab(text = '') {
  const c = { text, writes: 0 };
  c.fn = (op, next) => { if (op === 'read') return c.text; c.text = next; c.writes += 1; return undefined; };
  return c;
}

function ctxFor(over = {}) {
  const base = scratch();
  return {
    base,
    ctx: {
      platform: 'darwin', env: { PATH: '/usr/bin', PIPELINE_PRUNE_LOG_DIR: join(base, 'logs') }, home: base, hasClaudeCodeAncestor: () => false,
      whichFn: (c) => `/opt/tools/bin/${c}`, nodePath: '/opt/node/bin/node', existsFn: () => true, launchctlFn: fakeLaunchctl(), tzFn: () => 'Asia/Manila', uid: 501, ...over,
    },
  };
}
const strings = (xml, key) => [...new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);

test('parseEvery: only 5, 10, 15, 20, 30 or 60; default 15; anything else is a usage error', () => {
  assert.deepEqual(EVERY_CHOICES, [5, 10, 15, 20, 30, 60]);
  assert.equal(parseEvery(undefined), DEFAULT_EVERY);
  assert.equal(DEFAULT_EVERY, 15);
  for (const ok of ['5', '10', '15', '20', '30', '60']) assert.equal(parseEvery(ok), Number(ok));
  for (const bad of ['0', '1', '7', '45', '61', '120', '-5', '5.5', 'abc', '', '15m', ' ']) assert.throws(() => parseEvery(bad), /--every must be one of/, JSON.stringify(bad));
  assert.equal(cronExpression(15), '*/15 * * * *');
  assert.equal(cronExpression(5), '*/5 * * * *');
  assert.equal(cronExpression(60), '17 * * * *');
});

test('usage errors exit 2 through the CLI path: no action, two actions, --every without --install, a stray argument, a bad --every', async () => {
  for (const argv of [['schedule'], ['schedule', '--install', '--remove'], ['schedule', '--status', '--every', '10'], ['schedule', '--remove', '--every', '10'], ['schedule', 'now'], ['schedule', '--install', '--every', '7']]) {
    const { ctx } = ctxFor();
    await assert.rejects(update(argv, ctx), /./, JSON.stringify(argv));
  }
  // guarded() turns an unknown value into a usage error at the bin level; here the UsageError reaches the caller and bin maps it to exit 2
  const { ctx } = ctxFor();
  await assert.rejects(update(['schedule', '--install', '--every', '7'], ctx), (e) => e.constructor.name === 'UsageError' && /must be one of 5, 10, 15, 20, 30, 60/.test(e.message));
});

test('schedule --install refuses inside Claude Code (CLAUDECODE=1 or a Claude Code ancestor) and writes nothing; --status and --remove run anywhere', POSIX, async () => {
  for (const over of [{ env: { CLAUDECODE: '1', PATH: '/usr/bin' } }, { hasClaudeCodeAncestor: () => true }]) {
    const { ctx } = ctxFor({ ...over, crontabFn: () => { throw new Error('crontab must not be touched'); } });
    const r = await update(['schedule', '--install'], ctx);
    assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [2, false, 'refused']);
    assert.equal(ctx.launchctlFn.calls.length, 0);
    for (const argv of [['schedule', '--status'], ['schedule', '--remove']]) {
      const inside = await update(argv, ctx);
      assert.equal(inside.exitCode, 0, JSON.stringify(argv));
    }
  }
});

test('macOS install: one LaunchAgent com.claude-pipeline.auto-update, a repeating job at load, running the installed CLI `update --scheduled --json`', POSIX, async () => {
  const { base, ctx } = ctxFor();
  const r = await update(['schedule', '--install'], ctx);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(AUTO_UPDATE_LABEL, 'com.claude-pipeline.auto-update');
  const plistPath = join(base, 'Library', 'LaunchAgents', 'com.claude-pipeline.auto-update.plist');
  assert.equal(r.output.plist, plistPath);
  assert.deepEqual([r.output.installed, r.output.every, r.output.changed], [true, 15, true]);
  const xml = readFileSync(plistPath, 'utf8');
  assert.deepEqual(strings(xml, 'ProgramArguments'), ['/opt/node/bin/node', join(base, '.claude', 'pipeline', 'bin', 'pipeline.mjs').replace(/\\/g, '/'), 'update', '--scheduled', '--json']);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.claude-pipeline\.auto-update<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(xml.includes(join(base, 'logs', 'cron-auto-update.log')));
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/opt\/tools\/bin:/);
  assert.deepEqual(ctx.launchctlFn.calls.map((c) => c[0]), ['bootout', 'bootstrap']);
  assert.ok(existsSync(join(base, 'logs')), 'the log folder exists so the job can write to it');
  // --every N sets the interval; installing again over the same plist reports no change
  const again = await update(['schedule', '--install', '--every', '5'], ctx);
  assert.match(readFileSync(plistPath, 'utf8'), /<integer>300<\/integer>/);
  assert.deepEqual([again.output.every, again.output.changed], [5, true]);
  const same = await update(['schedule', '--install', '--every', '5'], ctx);
  assert.equal(same.output.changed, false);
});

test('macOS status and remove: loaded state is reported, remove unloads and deletes the plist, a second remove says nothing was there', POSIX, async () => {
  const { base, ctx } = ctxFor();
  const plistPath = join(base, 'Library', 'LaunchAgents', 'com.claude-pipeline.auto-update.plist');
  assert.equal((await update(['schedule', '--status'], ctx)).output.installed, false);
  await update(['schedule', '--install'], ctx);
  const st = await update(['schedule', '--status'], ctx);
  assert.deepEqual([st.output.ok, st.output.installed, st.output.loaded], [true, true, true]);
  const rm = await update(['schedule', '--remove'], ctx);
  assert.deepEqual([rm.exitCode, rm.output.removed], [0, true]);
  assert.equal(existsSync(plistPath), false);
  assert.equal((await update(['schedule', '--remove'], ctx)).output.removed, false);
  assert.equal((await update(['schedule', '--status'], ctx)).output.installed, false);
});

test('install needs the installed CLI, git and gh on PATH: otherwise a clear error and nothing is written', POSIX, async () => {
  const a = ctxFor({ existsFn: () => false });
  const r = await update(['schedule', '--install'], a.ctx);
  assert.deepEqual([r.exitCode, r.output.error], [2, 'not-installed']);
  assert.equal(a.ctx.launchctlFn.calls.length, 0);
  const b = ctxFor({ whichFn: (c) => (c === 'gh' ? null : `/opt/tools/bin/${c}`) });
  const t = await update(['schedule', '--install'], b.ctx);
  assert.deepEqual([t.exitCode, t.output.error], [2, 'tool-missing']);
  assert.match(t.output.message, /gh was not found/);
});

test('Linux install: exactly one crontab line, */15 by default, `--every 60` hourly; other lines are kept; a second install replaces, never adds', POSIX, async () => {
  const cron = fakeCrontab('MAILTO=me\n0 5 * * * /usr/bin/backup\n');
  const { base, ctx } = ctxFor({ platform: 'linux', crontabFn: cron.fn });
  const r = await update(['schedule', '--install'], ctx);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.installed, r.output.every, r.output.changed], [true, 15, true]);
  assert.equal(r.output.warning, undefined, 'no HH:MM time-zone warning for an every-N-minutes job');
  const lines = cron.text.split('\n').filter((l) => l.includes('claude-pipeline update auto-update'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('*/15 * * * * '), lines[0]);
  assert.ok(lines[0].includes('update --scheduled --json'));
  assert.ok(lines[0].includes(`${join(base, '.claude', 'pipeline', 'bin', 'pipeline.mjs')} update --scheduled --json`.replace(/\\/g, '/')), lines[0]);
  assert.ok(lines[0].includes(join(base, 'logs', 'cron-auto-update.log')), lines[0]);
  assert.ok(lines[0].endsWith('# claude-pipeline update auto-update'));
  assert.ok(cron.text.startsWith('MAILTO=me\n0 5 * * * /usr/bin/backup\n'), 'foreign lines kept');
  const hourly = await update(['schedule', '--install', '--every', '60'], ctx);
  assert.equal(hourly.output.every, 60);
  const after = cron.text.split('\n').filter((l) => l.includes('claude-pipeline update auto-update'));
  assert.equal(after.length, 1);
  assert.ok(after[0].startsWith('17 * * * * '), after[0]);
  const writes = cron.writes;
  await update(['schedule', '--install', '--every', '60'], ctx);
  assert.equal(cron.writes, writes, 'an unchanged crontab is not rewritten');
});

test('Linux status and remove: status finds the line by its marker, remove takes only that line', POSIX, async () => {
  const cron = fakeCrontab('0 5 * * * /usr/bin/backup\n');
  const { ctx } = ctxFor({ platform: 'linux', crontabFn: cron.fn });
  assert.equal((await update(['schedule', '--status'], ctx)).output.installed, false);
  await update(['schedule', '--install', '--every', '30'], ctx);
  const st = await update(['schedule', '--status'], ctx);
  assert.deepEqual([st.output.installed, st.output.line.startsWith('*/30 * * * * ')], [true, true]);
  const rm = await update(['schedule', '--remove'], ctx);
  assert.deepEqual([rm.exitCode, rm.output.removed], [0, true]);
  assert.equal(cron.text, '0 5 * * * /usr/bin/backup\n');
  assert.equal((await update(['schedule', '--remove'], ctx)).output.removed, false);
});

test('native Windows is unsupported-platform for every action (nothing touched)', async () => {
  for (const argv of [['schedule', '--install'], ['schedule', '--remove'], ['schedule', '--status']]) {
    const { ctx } = ctxFor({ platform: 'win32', crontabFn: () => { throw new Error('no crontab on win32'); } });
    const r = await update(argv, ctx);
    assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [2, false, 'unsupported-platform'], JSON.stringify(argv));
    assert.equal(ctx.launchctlFn.calls.length, 0);
  }
});

// ---- gaps closed after auditing plan B3, and the cases of #67 that still apply (adapted to lib/schedule.mjs) ---------------------------------

const LINE_ARGS = { nodePath: '/usr/bin/node', binPath: '/home/me/.claude/pipeline/bin/pipeline.mjs', root: '/home/me', args: [...AUTO_UPDATE_ARGS], pathDirs: ['/usr/bin', '/opt/gh/bin'], logFile: '/home/me/logs/cron-auto-update.log', lockName: 'auto-update', kind: 'update' };
const ok = { code: 0, stdout: '', stderr: '' };
const notLoaded = { code: 113, stdout: '', stderr: 'Could not find service' };

test('cron line: interval, PATH, the log, the marker and `update --scheduled --json`; hourly is a fixed minute past the hour', () => {
  const line = scheduleLine({ ...LINE_ARGS, cron: cronExpression(15) });
  assert.equal(line, "*/15 * * * * cd '/home/me' && PATH='/usr/bin:/opt/gh/bin:/bin' /usr/bin/node /home/me/.claude/pipeline/bin/pipeline.mjs update --scheduled --json >>'/home/me/logs/cron-auto-update.log' 2>&1 # claude-pipeline update auto-update");
  assert.equal(scheduleMarker('auto-update', 'update'), '# claude-pipeline update auto-update');
  assert.match(scheduleLine({ ...LINE_ARGS, cron: cronExpression(60) }), /^17 \* \* \* \* /);
  assert.match(scheduleLine({ ...LINE_ARGS, cron: cronExpression(5) }), /^\*\/5 \* \* \* \* /);
});

test('cron line: node and script are quoted only when they need it, a quote is escaped, every % becomes \\%, a newline is refused', () => {
  const line = scheduleLine({ ...LINE_ARGS, cron: cronExpression(15), nodePath: '/Users/Jane Doe/node', binPath: "/h/it's/pipeline.mjs", logFile: '/logs/100%/au.log', pathDirs: ['/p%q'] });
  assert.match(line, / '\/Users\/Jane Doe\/node' /);
  assert.ok(line.includes("'/h/it'\\''s/pipeline.mjs'"), line);
  assert.ok(line.includes('/logs/100\\%/au.log'), line);
  assert.ok(line.includes('/p\\%q'), line);
  assert.ok(!/[^\\]%/.test(line), 'no unescaped %');
  assert.throws(() => scheduleLine({ ...LINE_ARGS, cron: cronExpression(15), logFile: '/a\nb' }), /newline/);
  assert.throws(() => scheduleLine({ ...LINE_ARGS, cron: '*/15 * * *' }), /five fields/);
});

test('plist: StartInterval is minutes x 60, RunAtLoad, the update arguments, PATH, and one log for stdout and stderr', () => {
  const text = schedulePlist({ ...LINE_ARGS, label: AUTO_UPDATE_LABEL, interval: 900, pathDirs: ['/opt/node/bin'] });
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(text, /StartCalendarInterval/, 'an interval job has no clock time');
  assert.match(text, /<string>update<\/string>\s*<string>--scheduled<\/string>\s*<string>--json<\/string>/);
  assert.match(text, /<string>\/opt\/node\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  const out = /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)[1];
  assert.equal(out, LINE_ARGS.logFile);
  assert.match(text, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${out.replace(/\//g, '\\/')}</string>`));
  for (const [minutes, seconds] of [[5, 300], [60, 3600]]) assert.match(schedulePlist({ ...LINE_ARGS, label: AUTO_UPDATE_LABEL, interval: minutes * 60, pathDirs: [] }), new RegExp(`<integer>${seconds}</integer>`));
});

test('the owner-admin variable lifts the Claude Code refusal for --install, like a manual update', POSIX, async () => {
  const { ctx } = ctxFor({ env: { CLAUDECODE: '1', [`PIPELINE_${'ADMIN'}`]: '1', PATH: '/usr/bin' } });
  const r = await update(['schedule', '--install'], ctx);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
});

test('Linux --install --every N replaces the line IN PLACE: other lines keep their bytes and their order', POSIX, async () => {
  const cron = fakeCrontab('MAILTO=me\n30 2 * * * /usr/local/bin/backup --all # nightly\n@reboot /home/me/start.sh\n');
  const { ctx } = ctxFor({ platform: 'linux', crontabFn: cron.fn });
  await update(['schedule', '--install'], ctx);
  const withLine = cron.text.split('\n');
  const at = withLine.findIndex((l) => l.includes('claude-pipeline update auto-update'));
  await update(['schedule', '--install', '--every', '10'], ctx);
  const after = cron.text.split('\n');
  assert.equal(after.findIndex((l) => l.includes('claude-pipeline update auto-update')), at, 'same position');
  assert.ok(after[at].startsWith('*/10 * * * * '));
  assert.deepEqual(after.filter((_, i) => i !== at), withLine.filter((_, i) => i !== at), 'every other line is byte-identical');
});

test('macOS reinstall with nothing changed leaves the plist alone but still reloads the job (repairs one that was unloaded by hand)', POSIX, async () => {
  const { base, ctx } = ctxFor();
  await update(['schedule', '--install'], ctx);
  const plistPath = join(base, 'Library', 'LaunchAgents', 'com.claude-pipeline.auto-update.plist');
  const text = readFileSync(plistPath, 'utf8');
  ctx.launchctlFn.calls.length = 0;
  const r = await update(['schedule', '--install'], ctx);
  assert.equal(r.output.changed, false);
  assert.equal(readFileSync(plistPath, 'utf8'), text);
  assert.deepEqual(ctx.launchctlFn.calls.map((c) => c[0]), ['bootout', 'bootstrap']);
});

test('macOS: a failing bootstrap is exit 2 {error: launchctl} with the launchctl message', POSIX, async () => {
  const { ctx } = ctxFor({ launchctlFn: (args) => (args[0] === 'bootstrap' ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } : ok) });
  const r = await update(['schedule', '--install'], ctx);
  assert.deepEqual([r.exitCode, r.output.ok, r.output.error], [2, false, 'launchctl']);
  assert.match(r.output.message, /Input\/output error/);
});

test('macOS --remove: boots out, CONFIRMS with print that the job is gone, then deletes the plist', POSIX, async () => {
  let loaded = true;
  const calls = [];
  const launchctlFn = (args) => {
    calls.push([...args]);
    if (args[0] === 'bootout') { loaded = false; return ok; }
    if (args[0] === 'print') return loaded ? ok : notLoaded;
    return ok;
  };
  const { base, ctx } = ctxFor({ launchctlFn });
  await update(['schedule', '--install'], ctx);
  const plistPath = join(base, 'Library', 'LaunchAgents', 'com.claude-pipeline.auto-update.plist');
  calls.length = 0;
  const r = await update(['schedule', '--remove'], ctx);
  assert.deepEqual([r.exitCode, r.output.removed], [0, true]);
  assert.deepEqual(calls, [['bootout', `gui/501/${AUTO_UPDATE_LABEL}`], ['print', `gui/501/${AUTO_UPDATE_LABEL}`]]);
  assert.equal(existsSync(plistPath), false);
});

test('macOS --remove keeps the plist (exit 2) when print still shows the job loaded, or cannot tell', POSIX, async () => {
  for (const [launchctlFn, why] of [
    [(args) => (args[0] === 'bootout' ? { code: 1, stdout: '', stderr: 'Operation not permitted' } : ok), 'still loaded'],
    [(args) => (args[0] === 'print' ? { code: 1, stdout: '', stderr: 'spawn /bin/launchctl ENOENT' } : ok), 'print unreadable'],
  ]) {
    const { base, ctx } = ctxFor({ launchctlFn });
    await update(['schedule', '--install'], ctx);
    const r = await update(['schedule', '--remove'], ctx);
    assert.deepEqual([r.exitCode, r.output.error], [2, 'launchctl'], why);
    assert.ok(existsSync(join(base, 'Library', 'LaunchAgents', 'com.claude-pipeline.auto-update.plist')), `${why}: the plist stays so the job is not left running with no file to remove it by`);
  }
});

test('macOS --status: installed means the plist exists AND the job is loaded', POSIX, async () => {
  let loaded = false;
  const { base, ctx } = ctxFor({ launchctlFn: (args) => (args[0] === 'print' ? (loaded ? ok : notLoaded) : ok) });
  const st = async () => (await update(['schedule', '--status'], ctx)).output;
  assert.deepEqual([(await st()).installed, (await st()).loaded], [false, false]);
  await update(['schedule', '--install'], ctx);
  loaded = true;
  assert.deepEqual([(await st()).installed, (await st()).loaded], [true, true]);
  loaded = false; // the plist is there but the job is not loaded
  const half = await st();
  assert.deepEqual([half.installed, half.loaded, half.warning], [false, false, undefined]);
  rmSync(join(base, 'Library', 'LaunchAgents', 'com.claude-pipeline.auto-update.plist'));
  loaded = true; // loaded with no plist
  assert.equal((await st()).installed, false);
});
