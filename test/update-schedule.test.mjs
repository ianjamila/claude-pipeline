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
import { AUTO_UPDATE_LABEL, DEFAULT_EVERY, EVERY_CHOICES, cronExpression, parseEvery } from '../pipeline/lib/update-schedule.mjs';

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
