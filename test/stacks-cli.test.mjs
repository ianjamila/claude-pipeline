// `pipeline stacks`: the subcommand wiring, usage text vs docs/cli.md, init / repair / status, schedule (launchd and cron) and the
// Windows answer. Pure tests call `run(argv, ctx)` with injected env / home / platform / launchctl / crontab; the end-to-end tests
// spawn the real CLI against a throwaway state root with a fake docker. Nothing reads or writes the real home or crontab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, meta, proposedConfig } from '../pipeline/commands/stacks.mjs';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { loadMachineConfig } from '../pipeline/lib/stacks/config.mjs';
import { appendEvent, readLedger } from '../pipeline/lib/stacks/ledger.mjs';
import { readDecisions, appendDecision } from '../pipeline/lib/stacks/outcomes.mjs';
import { stackFiles, lockDirs } from '../pipeline/lib/stacks/paths.mjs';
import { ok } from '../pipeline/lib/stacks/result.mjs';

process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const FAKE_DOCKER = join(here, 'fixtures', 'fake-docker-bin.mjs');
const DOCS = readFileSync(join(here, '..', 'docs', 'cli.md'), 'utf8');
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-cli-')));
  const root = join(base, 'state');
  const env = { PIPELINE_STACKS_HOME: root, PIPELINE_STACKS_ONLY: 'alpha', PIPELINE_PRUNE_LOG_DIR: join(base, 'logs') };
  return { base, root, env, files: stackFiles(root), ctx: (over = {}) => ({ env, home: base, platform: 'linux', ...over }), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// ======================================================================= usage and docs

test('meta.usage lists the six subcommands and docs/cli.md ## stacks holds it verbatim', () => {
  const lines = meta.usage.split('\n');
  assert.deepEqual(lines.map((l) => l.split(/\s+/)[2]), ['sweep', 'session-end', 'status', 'repair', 'init', 'schedule']);
  assert.equal(lines[0], 'pipeline stacks sweep [--apply] [--summary-only]   -> {ok, summary, stopped:[...], wouldStop:[...], listed:[...], kept:[...]}');
  assert.equal(lines[1], 'pipeline stacks session-end --owner PID:BIRTH   -> {ok, waited, stacks:[...], dev:[...]}');
  assert.equal(lines[2], 'pipeline stacks status   -> {ok, configured, modes, paused, leases:[...], report}');
  assert.equal(lines[3], 'pipeline stacks repair   -> {ok, moved}');
  assert.equal(lines[4], 'pipeline stacks init [--write]   -> {ok, config, written}');
  assert.equal(lines[5], 'pipeline stacks schedule (--install [--at HH:MM] | --remove | --status)   -> {ok, installed|removed, label, timezone, warning?}');
  const section = DOCS.slice(DOCS.indexOf('\n## stacks\n'), DOCS.indexOf('\n## state\n'));
  assert.ok(section.includes(meta.usage), 'docs/cli.md ## stacks must hold meta.usage verbatim');
});

test('an unknown or missing subcommand and bad flags are usage errors', async () => {
  for (const argv of [[], ['bogus'], ['sweep', '--bogus'], ['sweep', 'extra'], ['status', 'x'], ['repair', '--now'], ['init', '--force'], ['schedule'], ['schedule', '--install', '--remove'], ['schedule', '--remove', '--at', '07:00'], ['schedule', '--install', '--at', '25:00'], ['session-end']]) {
    await assert.rejects(() => run(argv, { platform: 'linux', env: {} }), UsageError, JSON.stringify(argv));
  }
});

test('Windows: every subcommand answers "not supported on Windows" (exit 2) and touches nothing', async () => {
  const s = scratch();
  try {
    for (const argv of [['sweep'], ['sweep', '--apply', '--summary-only'], ['session-end', '--owner', '1:2'], ['status'], ['repair'], ['init', '--write'], ['schedule', '--install']]) {
      const r = await run(argv, s.ctx({ platform: 'win32' }));
      assert.equal(r.exitCode, 2, JSON.stringify(argv));
      assert.deepEqual(r.output, { ok: false, error: 'not supported on Windows' });
    }
    assert.equal(existsSync(s.root), false);
  } finally {
    s.cleanup();
  }
});

// ======================================================================= init

test('init without --write prints the proposed config and writes nothing', async () => {
  const s = scratch();
  try {
    const r = await run(['init'], s.ctx());
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.ok, true);
    assert.equal(r.output.written, false);
    assert.deepEqual(r.output.config, {
      shared: ['e2e-ci', 'DRMed', 'eaglewatch-pipeline'],
      repos: ['~/Claude/eaglewatch', '~/Claude/DRMed'],
      memoryDirs: ['~/claude-memory/home', '~/claude-memory/eaglewatch', '~/claude-memory/drmed'],
      memoryExclude: ['supabase-stack-autostop.md', 'MEMORY-archive.md'],
      devPorts: [3000, 4000, 4017],
    });
    assert.deepEqual(r.output.config, proposedConfig());
    assert.equal(existsSync(s.root), false, 'not even the state folder is created');
  } finally {
    s.cleanup();
  }
});

test('init --write creates config.json (loads as ok, ~ expanded) and never overwrites an existing one', async () => {
  const s = scratch();
  try {
    const r = await run(['init', '--write'], s.ctx());
    assert.equal(r.output.written, true);
    const cfg = loadMachineConfig(s.files.config, { home: s.base });
    assert.equal(cfg.status, 'ok');
    assert.deepEqual([...cfg.shared].sort(), ['drmed', 'e2e-ci', 'eaglewatch-pipeline']);
    // `~` is expanded by plain concatenation (expandHome), so the rest of the path keeps the '/' the config wrote
    assert.deepEqual(cfg.repos, [`${s.base}/Claude/eaglewatch`, `${s.base}/Claude/DRMed`]);
    assert.deepEqual(cfg.devPorts, [3000, 4000, 4017]);
    writeFileSync(s.files.config, '{"shared":["mine"]}');
    const again = await run(['init', '--write'], s.ctx());
    assert.equal(again.exitCode, 0);
    assert.equal(again.output.written, false);
    assert.match(again.output.note, /already exists/);
    assert.equal(readFileSync(s.files.config, 'utf8'), '{"shared":["mine"]}');
  } finally {
    s.cleanup();
  }
});

test('a non-default root without PIPELINE_STACKS_ONLY is refused by init, repair and status (exit 2)', async () => {
  const s = scratch();
  try {
    for (const argv of [['init', '--write'], ['repair'], ['status']]) {
      const r = await run(argv, s.ctx({ env: { PIPELINE_STACKS_HOME: s.root } }));
      assert.equal(r.exitCode, 2, JSON.stringify(argv));
      assert.equal(r.output.error, 'isolation');
    }
    assert.equal(existsSync(s.root), false);
  } finally {
    s.cleanup();
  }
});

// ======================================================================= repair

test('repair moves the damaged lines of BOTH the ledger and the decisions log, keeping every good line', async () => {
  const s = scratch();
  try {
    mkdirSync(s.root, { recursive: true });
    const lease = { t: new Date(T0).toISOString(), kind: 'use', owner: { pid: 1, birth: 2 }, project: 'alpha', via: 'test' };
    await appendEvent(s.files.ledger, lease, { lockDir: lockDirs(s.root).ledger });
    appendFileSync(s.files.ledger, 'not json\n');
    await appendEvent(s.files.ledger, { ...lease, owner: { pid: 3, birth: 4 } }, { lockDir: lockDirs(s.root).ledger });
    await appendDecision(s.files.actions, { t: new Date(T0).toISOString(), project: 'alpha', action: 'kept', reasons: [] });
    appendFileSync(s.files.actions, '{"t": broken\n');
    appendFileSync(s.files.actions, 'more garbage\n');
    assert.equal(readLedger(s.files.ledger).ok, false);
    assert.equal(readDecisions(s.files.actions).ok, false);

    const r = await run(['repair'], s.ctx());
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.output, { ok: true, moved: { ledger: 1, actions: 2 } });
    assert.equal(readLedger(s.files.ledger).value.length, 2);
    assert.equal(readDecisions(s.files.actions).value.length, 1);
    assert.equal(readFileSync(s.files.ledgerBad, 'utf8'), 'not json\n');
    assert.equal(readFileSync(join(s.root, 'actions.bad.jsonl'), 'utf8'), '{"t": broken\nmore garbage\n');
    const clean = await run(['repair'], s.ctx());
    assert.deepEqual(clean.output, { ok: true, moved: { ledger: 0, actions: 0 } });
  } finally {
    s.cleanup();
  }
});

// ======================================================================= status

test('status: not configured, then configured with modes, pause, live leases (dead owners dropped) and the report path', async () => {
  const s = scratch();
  try {
    let r = await run(['status'], s.ctx());
    assert.equal(r.exitCode, 0);
    assert.deepEqual([r.output.configured, r.output.config, r.output.paused, r.output.leases, r.output.report], [false, 'missing', false, [], null]);
    assert.deepEqual(r.output.modes, { sessionEnd: 'report', sweeper: 'report', devServers: 'report' });

    mkdirSync(s.root, { recursive: true });
    writeFileSync(s.files.config, '{}');
    writeFileSync(s.files.mode, JSON.stringify({ sweeper: 'apply' }));
    writeFileSync(s.files.pause, '');
    writeFileSync(s.files.report, '# r\n');
    const t = (min) => new Date(T0 + min * 60_000).toISOString();
    const lockDir = lockDirs(s.root).ledger;
    await appendEvent(s.files.ledger, { t: t(0), kind: 'use', owner: { pid: 10, birth: 100 }, project: 'alpha', via: 'Bash' }, { lockDir });
    await appendEvent(s.files.ledger, { t: t(5), kind: 'use', owner: { pid: 10, birth: 100 }, project: 'alpha', via: 'Read' }, { lockDir });
    await appendEvent(s.files.ledger, { t: t(1), kind: 'use', owner: { pid: 11, birth: 110 }, project: 'alpha', via: 'Bash' }, { lockDir });
    r = await run(['status'], s.ctx({ isAlive: (o) => ok(o.pid === 10) }));
    assert.equal(r.output.configured, true);
    assert.equal(r.output.modes.sweeper, 'apply');
    assert.equal(r.output.paused, true);
    assert.equal(r.output.report, s.files.report);
    assert.deepEqual(r.output.leases.map((l) => [l.project, l.owner.pid, l.alive, l.since, l.last]), [['alpha', 10, true, t(0), t(5)]]);

    appendFileSync(s.files.ledger, 'broken\n');
    r = await run(['status'], s.ctx({ isAlive: () => ok(true) }));
    assert.equal(r.output.ledger.ok, false);
    assert.match(r.output.ledger.reason, /damaged ledger line 4/);
    assert.deepEqual(r.output.leases, []);
  } finally {
    s.cleanup();
  }
});

// ======================================================================= sweep through the command

test('sweep --summary-only is one compact line {ok, summary}; a failed stop is listed under errors', async () => {
  const s = scratch();
  try {
    const r = await run(['sweep', '--summary-only'], s.ctx({ deps: { cfg: { status: 'missing', shared: new Set() }, root: s.root, files: s.files, iso: { isDefault: false, only: null }, home: s.base, bins: { lsof: 'L', ps: 'P' }, hookHealth: () => [], procIdentity: () => ok(null) } }));
    assert.equal(r.exitCode, 0);
    assert.equal(r.compact, true);
    assert.deepEqual(Object.keys(r.output), ['ok', 'summary']);
    assert.match(r.output.summary, /^not configured;/);
    const full = await run(['sweep'], s.ctx({ deps: { cfg: { status: 'missing', shared: new Set() }, root: s.root, files: s.files, iso: { isDefault: false, only: null }, home: s.base, bins: { lsof: 'L', ps: 'P' }, hookHealth: () => [], procIdentity: () => ok(null) } }));
    assert.ok(Array.isArray(full.output.stopped) && Array.isArray(full.output.wouldStop) && Array.isArray(full.output.listed) && Array.isArray(full.output.kept));
  } finally {
    s.cleanup();
  }
});

function e2e() {
  const s = scratch();
  const dockerScenario = join(s.base, 'docker.json');
  const dockerLog = join(s.base, 'docker.log');
  writeFileSync(dockerScenario, JSON.stringify({ down: true, log: dockerLog }));
  const env = { ...process.env, HOME: s.base, ...s.env, PIPELINE_DOCKER: FAKE_DOCKER, FAKE_DOCKER_SCENARIO: dockerScenario, PIPELINE_MACHINE_ID: 'test-machine-id' };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, 'stacks', ...args], { env, encoding: 'utf8', timeout: 30000 });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* left null */ }
    return { status: r.status, json, stderr: r.stderr };
  };
  return { ...s, cli, dockerLog };
}

test('e2e: the real CLI sweeps an isolated root: not configured first, then docker down (nothing assessed, report written)', posixOnly, () => {
  const e = e2e();
  try {
    let r = e.cli('sweep', '--summary-only');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.json.summary, /^not configured;/);
    assert.equal(existsSync(e.dockerLog), false, 'no docker call without a config');
    assert.equal(existsSync(e.files.actions), false);
    r = e.cli('init', '--write');
    assert.equal(r.json.written, true);
    r = e.cli('sweep', '--apply');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.json.summary, /^docker is not running;/);
    assert.ok(existsSync(e.files.report));
    assert.match(readFileSync(e.files.report, 'utf8'), /^# Stack stop report/);
    assert.equal(readFileSync(e.dockerLog, 'utf8').split('\n').filter(Boolean).every((l) => !/"(rm|stop)"/.test(l)), true);
    r = e.cli('status');
    assert.equal(r.json.configured, true);
    assert.equal(r.json.report, e.files.report);
    r = e.cli('bogus');
    assert.equal(r.status, 2);
    assert.equal(r.json.error, 'usage');
  } finally {
    e.cleanup();
  }
});

// ======================================================================= schedule

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

function scheduleCtx(s, over = {}) {
  return {
    platform: 'darwin', env: { PATH: '/usr/bin', PIPELINE_PRUNE_LOG_DIR: join(s.base, 'logs') }, home: s.base, whichFn: (c) => `/opt/tools/bin/${c}`,
    nodePath: '/opt/node/bin/node', binPath: '/opt/pipeline/bin/pipeline.mjs', launchctlFn: fakeLaunchctl(), tzFn: () => 'Asia/Manila', uid: 501, ...over,
  };
}

const plistStrings = (xml, key) => {
  const block = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)[1];
  return [...block.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
};

test('schedule --install on macOS writes the LaunchAgent: stacks sweep --apply --summary-only, 09:12, PATH only, no PIPELINE_STACKS_*', posixOnly, async () => {
  const s = scratch();
  try {
    const ctx = scheduleCtx(s);
    const r = await run(['schedule', '--install'], ctx);
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.ok, true);
    assert.equal(r.output.installed, true);
    assert.equal(r.output.label, 'com.claude-pipeline.stacks-sweep');
    assert.equal(r.output.timezone, 'Asia/Manila');
    const plistPath = join(s.base, 'Library', 'LaunchAgents', 'com.claude-pipeline.stacks-sweep.plist');
    assert.equal(r.output.plist, plistPath);
    const xml = readFileSync(plistPath, 'utf8');
    assert.ok(xml.includes('stacks</string>') && xml.includes('sweep</string>'));
    assert.deepEqual(plistStrings(xml, 'ProgramArguments'), ['/opt/node/bin/node', '/opt/pipeline/bin/pipeline.mjs', 'stacks', 'sweep', '--apply', '--summary-only']);
    assert.match(xml, /<key>Label<\/key>\s*<string>com\.claude-pipeline\.stacks-sweep<\/string>/);
    assert.match(xml, /<key>Hour<\/key>\s*<integer>9<\/integer>\s*<key>Minute<\/key>\s*<integer>12<\/integer>/);
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
    const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)[1];
    assert.deepEqual([...envBlock.matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1]), ['PATH'], 'PATH is the only environment variable');
    assert.ok(!/PIPELINE_STACKS/.test(xml));
    assert.ok(xml.includes(join(s.base, 'logs', 'cron-stacks-sweep.log')));
    assert.deepEqual(ctx.launchctlFn.calls.map((c) => c[0]), ['bootout', 'bootstrap']);

    const again = await run(['schedule', '--install', '--at', '07:45'], ctx);
    assert.equal(again.output.changed, true);
    assert.match(readFileSync(plistPath, 'utf8'), /<integer>7<\/integer>\s*<key>Minute<\/key>\s*<integer>45<\/integer>/);

    const st = await run(['schedule', '--status'], ctx);
    assert.deepEqual([st.output.ok, st.output.installed, st.output.loaded], [true, true, true]);
    const rm = await run(['schedule', '--remove'], ctx);
    assert.equal(rm.output.removed, true);
    assert.equal(existsSync(plistPath), false);
    const gone = await run(['schedule', '--status'], ctx);
    assert.equal(gone.output.installed, false);
  } finally {
    s.cleanup();
  }
});

test('schedule --install names the job tools it could not find (the job still fails closed)', posixOnly, async () => {
  const s = scratch();
  try {
    const r = await run(['schedule', '--install'], scheduleCtx(s, { whichFn: (c) => (c === 'git' ? '/usr/bin/git' : null) }));
    assert.deepEqual(r.output.notFound, ['gh', 'docker', 'supabase']);
    assert.equal(r.output.installed, true);
  } finally {
    s.cleanup();
  }
});

test('R2-7: under an isolated root (PIPELINE_STACKS_HOME set) schedule is refused for every action, exit 2, nothing written or run', async () => {
  const s = scratch();
  try {
    for (const argv of [['schedule', '--install'], ['schedule', '--install', '--at', '08:00'], ['schedule', '--remove'], ['schedule', '--status']]) {
      const ctx = scheduleCtx(s, { env: { ...scheduleCtx(s).env, PIPELINE_STACKS_HOME: s.root, PIPELINE_STACKS_ONLY: 'alpha' }, crontabFn: () => { throw new Error('crontab must not be touched'); } });
      const r = await run(argv, ctx);
      assert.equal(r.exitCode, 2, JSON.stringify(argv));
      assert.equal(r.output.ok, false);
      assert.match(r.output.message, /schedule works only for the default state root/);
      assert.equal(ctx.launchctlFn.calls.length, 0);
    }
    assert.equal(existsSync(join(s.base, 'Library')), false);
    const linux = await run(['schedule', '--install'], scheduleCtx(s, { platform: 'linux', env: { PATH: '/usr/bin', PIPELINE_STACKS_HOME: s.root, PIPELINE_STACKS_ONLY: 'alpha' }, crontabFn: () => { throw new Error('crontab must not be touched'); } }));
    assert.equal(linux.exitCode, 2);
  } finally {
    s.cleanup();
  }
});

test('schedule --install on Linux writes one cron line: stacks sweep --apply --summary-only, no PIPELINE_STACKS_*, found again by its marker', async () => {
  const s = scratch();
  try {
    let tab = '0 1 * * * echo keep me\n';
    const crontabFn = (op, text) => { if (op === 'write') tab = text; return tab; };
    const ctx = scheduleCtx(s, { platform: 'linux', crontabFn });
    const r = await run(['schedule', '--install'], ctx);
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.installed, true);
    assert.equal(r.output.label, 'com.claude-pipeline.stacks-sweep');
    const lines = tab.split('\n').filter(Boolean);
    assert.equal(lines[0], '0 1 * * * echo keep me');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^12 09 \* \* \* cd /);
    assert.match(lines[1], / \/opt\/node\/bin\/node \/opt\/pipeline\/bin\/pipeline\.mjs stacks sweep --apply --summary-only >>\x27/);
    assert.match(lines[1], /cron-stacks-sweep\.log' 2>&1 # claude-pipeline stacks stacks-sweep$/);
    assert.ok(!/PIPELINE_STACKS/.test(lines[1]));
    await run(['schedule', '--install', '--at', '10:30'], ctx);
    assert.equal(tab.split('\n').filter((l) => l.includes('claude-pipeline stacks')).length, 1, 'a re-install replaces the line');
    assert.match(tab, /^30 10 \* \* \* /m);
    const st = await run(['schedule', '--status'], ctx);
    assert.equal(st.output.installed, true);
    const rm = await run(['schedule', '--remove'], ctx);
    assert.equal(rm.output.removed, true);
    assert.equal(tab, '0 1 * * * echo keep me\n');
  } finally {
    s.cleanup();
  }
});
