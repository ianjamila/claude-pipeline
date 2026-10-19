// What `install.mjs --uninstall` does about stack-stop (lib/stacks/uninstall.mjs): pause, wait for workers, drop the schedule. The wait,
// the clock, process liveness, launchctl and crontab are all injected: no real process, launchd or crontab is touched, and nothing
// outside the scratch directories is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stacksUninstall, uninstallStacksRoot, SCHEDULE_NAME, WORKER_WAIT_MS } from '../pipeline/lib/stacks/uninstall.mjs';
import { scheduleLabel, scheduleMarker } from '../pipeline/lib/schedule.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scratch() {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-stacks-un-')));
  made.push(d);
  return d;
}
// A user home with ~/.claude (the standard claude-home) and a stacks root under it.
function machine({ withRoot = true } = {}) {
  const userHome = scratch();
  const home = join(userHome, '.claude');
  mkdirSync(home, { recursive: true });
  const root = join(home, 'pipeline-state', 'stacks');
  if (withRoot) mkdirSync(join(root, 'workers'), { recursive: true });
  return { userHome, home, root };
}
const tree = (dir) => {
  const out = [];
  const visit = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) visit(join(d, e.name), r); else out.push(r); } };
  visit(dir, '');
  return out.sort();
};
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: (ms) => { t += ms; } };
}
const never = () => { throw new Error('must not be called'); };
const LABEL = scheduleLabel(SCHEDULE_NAME);

test('the label and root the uninstall works on', () => {
  assert.equal(LABEL, 'com.claude-pipeline.stacks-sweep');
  assert.equal(WORKER_WAIT_MS, 120_000);
  assert.equal(uninstallStacksRoot({ home: '/u/.claude', env: {} }), '/u/.claude/pipeline-state/stacks');
  assert.equal(uninstallStacksRoot({ home: '/u/.claude', env: { PIPELINE_STACKS_HOME: '/x/iso' } }), '/x/iso');
});

test('an existing root is paused (the pause file only); nothing else in it changes', () => {
  const m = machine();
  for (const f of ['config.json', 'mode.json', 'ledger.jsonl', 'actions.jsonl']) writeFileSync(join(m.root, f), `${f}\n`);
  const before = tree(m.root);
  const c = clock();
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'darwin', userHome: m.userHome, ...c, isAlive: never, launchctlFn: never, crontabFn: never });
  assert.equal(r.existed, true);
  assert.equal(r.paused, true);
  assert.deepEqual(tree(m.root), [...before, 'pause'].sort());
  assert.deepEqual(r.workers, { waitedMs: 0, survivors: [] });
  assert.deepEqual(r.warnings, []);
  for (const f of ['config.json', 'mode.json', 'ledger.jsonl', 'actions.jsonl']) assert.equal(readFileSync(join(m.root, f), 'utf8'), `${f}\n`);
});

test('an existing pause file is left as it is (appended to, never replaced)', () => {
  const m = machine();
  writeFileSync(join(m.root, 'pause'), 'owner pause\n');
  stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, ...clock(), crontabFn: () => '' });
  assert.match(readFileSync(join(m.root, 'pause'), 'utf8'), /^owner pause\n/);
});

test('no stacks root: nothing is created and no worker is looked for', () => {
  const m = machine({ withRoot: false });
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'darwin', userHome: m.userHome, ...clock(), isAlive: never, launchctlFn: never, crontabFn: never });
  assert.equal(r.existed, false);
  assert.equal(r.paused, false);
  assert.equal(existsSync(join(m.home, 'pipeline-state')), false);
});

test('a worker that exits while we wait ends the wait early; the wait is bounded by the clock, polling the injected sleep', () => {
  const m = machine();
  writeFileSync(join(m.root, 'workers', '4242.json'), '{}');
  writeFileSync(join(m.root, 'workers', 'notes.txt'), 'ignored');
  writeFileSync(join(m.root, 'workers', 'abc.json'), 'ignored');
  const c = clock();
  const polls = [];
  const isAlive = (pid) => { polls.push(pid); return polls.length < 5; };
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, ...c, isAlive, crontabFn: () => '' });
  assert.deepEqual(r.workers.survivors, []);
  assert.ok(r.workers.waitedMs > 0 && r.workers.waitedMs < 5000, String(r.workers.waitedMs));
  assert.deepEqual([...new Set(polls)], [4242]);
  assert.deepEqual(r.warnings, []);
});

test('a worker that never exits: waits the full time (120 s by default, exact on the injected clock), then reports the pid', () => {
  const m = machine();
  writeFileSync(join(m.root, 'workers', '4242.json'), '{}');
  writeFileSync(join(m.root, 'workers', '77.json'), '{}');
  const c = clock();
  const alive = new Set([4242]);
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, ...c, isAlive: (p) => alive.has(p), crontabFn: () => '' });
  assert.deepEqual(r.workers.survivors, [4242]);
  assert.ok(r.workers.waitedMs >= 120_000 && r.workers.waitedMs <= 120_500, String(r.workers.waitedMs));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /still running after 120 s: pid 4242/);
  assert.equal(r.paused, true, 'paused before waiting, so the survivor stops nothing');
  assert.equal(existsSync(join(m.root, 'workers', '4242.json')), true, 'worker files are not deleted');
});

test('waitMs is injectable and a pid whose process answers EPERM counts as alive, ESRCH as gone (default liveness)', () => {
  const m = machine();
  writeFileSync(join(m.root, 'workers', `${process.pid}.json`), '{}');
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, waitMs: 1200, ...clock(), crontabFn: () => '' });
  assert.deepEqual(r.workers.survivors, [process.pid], 'this very process is alive');
  const gone = machine();
  writeFileSync(join(gone.root, 'workers', '2147483646.json'), '{}');
  const r2 = stacksUninstall({ home: gone.home, env: {}, platform: 'linux', userHome: gone.userHome, waitMs: 1200, ...clock(), crontabFn: () => '' });
  assert.deepEqual(r2.workers.survivors, []);
});

test('macOS: the LaunchAgent is removed when its plist exists (bootout, confirm absent, delete plist); no plist = no launchctl call', () => {
  const m = machine();
  const plist = join(m.userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const none = stacksUninstall({ home: m.home, env: {}, platform: 'darwin', userHome: m.userHome, ...clock(), launchctlFn: never });
  assert.deepEqual(none.schedule, { removed: false });

  mkdirSync(join(m.userHome, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plist, '<plist/>');
  const calls = [];
  let loaded = true;
  const launchctlFn = (args) => {
    calls.push([...args]);
    if (args[0] === 'bootout') { loaded = false; return { code: 0, stdout: '', stderr: '' }; }
    return loaded ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service' };
  };
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'darwin', userHome: m.userHome, uid: 501, ...clock(), launchctlFn });
  assert.deepEqual(r.schedule, { removed: true });
  assert.deepEqual(calls, [['bootout', `gui/501/${LABEL}`], ['print', `gui/501/${LABEL}`]]);
  assert.equal(existsSync(plist), false);
  assert.deepEqual(r.warnings, []);
});

test('macOS: a launchctl that cannot be confirmed is a warning, the plist stays, and uninstall goes on (never throws)', () => {
  const m = machine();
  mkdirSync(join(m.userHome, 'Library', 'LaunchAgents'), { recursive: true });
  const plist = join(m.userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  writeFileSync(plist, '<plist/>');
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'darwin', userHome: m.userHome, uid: 501, ...clock(), launchctlFn: () => ({ code: 0, stdout: '', stderr: 'boom' }) });
  assert.equal(r.schedule.removed, false);
  assert.match(r.warnings.join('\n'), /could not remove the com\.claude-pipeline\.stacks-sweep schedule/);
  assert.equal(existsSync(plist), true);
});

test('Linux: our cron line is removed when present, every other line byte-for-byte; absent = crontab never written', () => {
  const m = machine();
  const marker = scheduleMarker(SCHEDULE_NAME, 'stacks');
  const mine = `12 9 * * * cd /h && node bin stacks sweep --apply --summary-only ${marker}`;
  let tab = `MAILTO=me\n0 1 * * * echo keep\n${mine}\n# end\n`;
  const writes = [];
  const crontabFn = (op, text) => { if (op === 'write') { writes.push(text); tab = text; } return tab; };
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, ...clock(), crontabFn });
  assert.deepEqual(r.schedule, { removed: true });
  assert.deepEqual(writes, ['MAILTO=me\n0 1 * * * echo keep\n# end\n']);

  const again = stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, ...clock(), crontabFn });
  assert.deepEqual(again.schedule, { removed: false });
  assert.equal(writes.length, 1, 'no second write');

  const noCrontab = stacksUninstall({ home: m.home, env: {}, platform: 'linux', userHome: m.userHome, ...clock(), crontabFn: () => { throw new Error('crontab: command not found'); } });
  assert.deepEqual(noCrontab.schedule, { removed: false });
  assert.deepEqual(noCrontab.warnings, [], 'a machine without crontab has no schedule to remove');
});

test('the schedule belongs to the machine: not touched for another claude-home or an isolated stacks root', () => {
  const m = machine();
  const other = scratch();
  mkdirSync(join(m.userHome, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(m.userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`), '<plist/>');
  const r1 = stacksUninstall({ home: other, env: {}, platform: 'darwin', userHome: m.userHome, ...clock(), launchctlFn: never, crontabFn: never });
  assert.deepEqual(r1.schedule, { removed: false });
  const iso = join(scratch(), 'iso');
  mkdirSync(iso, { recursive: true });
  const r2 = stacksUninstall({ home: m.home, env: { PIPELINE_STACKS_HOME: iso, PIPELINE_STACKS_ONLY: 'x' }, platform: 'darwin', userHome: m.userHome, ...clock(), launchctlFn: never, crontabFn: never });
  assert.deepEqual(r2.schedule, { removed: false });
  assert.equal(r2.root, iso);
  assert.equal(existsSync(join(iso, 'pause')), true, 'the isolated root is the one paused');
  assert.equal(existsSync(join(m.root, 'pause')), false, 'and the home\'s own root is not');
});

test('Windows: nothing is read, written or run', () => {
  const m = machine();
  const r = stacksUninstall({ home: m.home, env: {}, platform: 'win32', userHome: m.userHome, ...clock(), isAlive: never, launchctlFn: never, crontabFn: never });
  assert.equal(r.paused, false);
  assert.equal(existsSync(join(m.root, 'pause')), false);
});
