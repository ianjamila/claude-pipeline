// Why: the stack-stop feature fails closed, so its foundations (what is "shared", which mode is on, where state lives, which
// projects an isolated run may touch, which test overrides are honoured) are pinned here. Nothing touches the real ~/.claude:
// every root and home is a mkdtemp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig, isShared, loadModes, ensureModeFile, loadKeep, isPaused } from '../pipeline/lib/stacks/config.mjs';
import { stacksRoot, stackFiles, lockDirs, projectLockName, isolation, projectAllowed, stacksSeam, StacksIsolationError } from '../pipeline/lib/stacks/paths.mjs';
import { ok, unknown, allOk } from '../pipeline/lib/stacks/result.mjs';
import { SEAM_VARS } from '../pipeline/lib/proc.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const dir = () => mkdtempSync(join(tmpdir(), 'stacks-cfg-'));
const cfgOk = { status: 'ok', shared: new Set(['e2e-ci', 'drmed', 'eaglewatch-pipeline']) };

test('result helpers: ok / unknown / allOk', () => {
  assert.deepEqual(ok(3), { ok: true, value: 3 });
  assert.deepEqual(unknown('boom'), { ok: false, reason: 'boom' });
  assert.equal(allOk([ok(1), ok(2)]), true);
  assert.equal(allOk([ok(1), unknown('x')]), false);
  assert.equal(allOk([ok(1), undefined]), false, 'a missing result is not ok');
  assert.equal(allOk([]), true);
});

test('shared: config ids case-insensitive, -pipeline suffix and .verify workdir are built in', () => {
  assert.equal(isShared({ project: 'DRMed', workdir: '/x' }, cfgOk), true);
  assert.equal(isShared({ project: 'drmed', workdir: '/x' }, cfgOk), true);
  assert.equal(isShared({ project: 'acme-PIPELINE', workdir: '/x' }, { status: 'ok', shared: new Set() }), true);
  assert.equal(isShared({ project: 'p', workdir: '/r/wt/.verify/supabase-workdir' }, { status: 'ok', shared: new Set() }), true);
  assert.equal(isShared({ project: 'p', workdir: 'C:\\r\\wt\\.VERIFY\\supabase-workdir\\x' }, { status: 'ok', shared: new Set() }), true);
  assert.equal(isShared({ project: 'sa-corrections', workdir: '/r/sa.stack' }, cfgOk), false);
  assert.equal(isShared({ project: 'p', workdir: null }, cfgOk), false, 'a null workdir does not crash');
  // the built-in rules hold even when no config could be loaded
  assert.equal(isShared({ project: 'x-pipeline', workdir: null }, { status: 'missing' }), true);
});

test('config missing or invalid is reported, never throws', () => {
  const d = dir();
  assert.equal(loadMachineConfig(join(d, 'none.json')).status, 'missing');
  writeFileSync(join(d, 'bad.json'), '{nope');
  assert.equal(loadMachineConfig(join(d, 'bad.json')).status, 'invalid');
  writeFileSync(join(d, 'wrong.json'), JSON.stringify({ shared: 'e2e-ci' }));
  assert.equal(loadMachineConfig(join(d, 'wrong.json')).status, 'invalid');
  for (const [name, body] of [['arr', []], ['nul', null], ['ports', { devPorts: ['3000'] }], ['port0', { devPorts: [0] }], ['repos', { repos: [1] }]]) {
    writeFileSync(join(d, `${name}.json`), JSON.stringify(body));
    const cfg = loadMachineConfig(join(d, `${name}.json`));
    assert.equal(cfg.status, 'invalid', name);
    assert.ok(cfg.error, name);
    assert.equal(cfg.shared.size, 0, 'an invalid config shares nothing and the caller must not trust it');
  }
  assert.equal(loadMachineConfig(d).status, 'invalid', 'a directory is not a readable config');
});

test('config ok: ids lowercased, ~ expanded against the injected home, defaults filled', () => {
  const d = dir(); const home = join(d, 'home');
  writeFileSync(join(d, 'c.json'), JSON.stringify({ shared: ['E2E-CI', 'DRMed'], repos: ['~/Claude/app'], memoryDirs: ['~/mem/a'], memoryExclude: ['note.md'] }));
  const cfg = loadMachineConfig(join(d, 'c.json'), { home });
  assert.equal(cfg.status, 'ok');
  assert.deepEqual([...cfg.shared].sort(), ['drmed', 'e2e-ci']);
  assert.deepEqual(cfg.repos, [`${home}/Claude/app`]);
  assert.deepEqual(cfg.memoryDirs, [`${home}/mem/a`]);
  assert.deepEqual(cfg.memoryExclude, ['note.md'], 'file names are not paths');
  assert.deepEqual(cfg.devPorts, [3000, 4000, 4017]);
  assert.deepEqual(cfg.transcriptDirs, [join(home, '.claude*', 'projects')], 'default keeps the glob; the evidence code expands it strictly');
  writeFileSync(join(d, 'e.json'), '{}');
  const empty = loadMachineConfig(join(d, 'e.json'), { home });
  assert.equal(empty.status, 'ok');
  assert.deepEqual([empty.shared.size, empty.repos, empty.memoryDirs], [0, [], []]);
});

test('modes default to report; ensureModeFile never overwrites', () => {
  const d = dir(); const f = join(d, 'mode.json');
  assert.deepEqual(loadModes(f), { sessionEnd: 'report', sweeper: 'report', devServers: 'report' });
  writeFileSync(f, JSON.stringify({ sessionEnd: 'apply', sweeper: 'bogus' }));
  assert.deepEqual(loadModes(f), { sessionEnd: 'apply', sweeper: 'report', devServers: 'report' });
  ensureModeFile(f);
  assert.match(readFileSync(f, 'utf8'), /apply/);
  writeFileSync(f, '{nope');
  assert.deepEqual(loadModes(f), { sessionEnd: 'report', sweeper: 'report', devServers: 'report' }, 'unreadable = report');
  assert.deepEqual(loadModes(d), { sessionEnd: 'report', sweeper: 'report', devServers: 'report' }, 'a directory = report');
});

test('ensureModeFile creates all-report (and the parent dir) only when absent', () => {
  const d = dir(); const f = join(d, 'deep', 'mode.json');
  ensureModeFile(f);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { sessionEnd: 'report', sweeper: 'report', devServers: 'report' });
});

test('keep list: missing = empty ok, comments ignored, unreadable = unknown', () => {
  const d = dir();
  assert.deepEqual([...loadKeep(join(d, 'keep')).value], []);
  writeFileSync(join(d, 'keep'), '# mine\nSA-Corrections\n\n  other-one   # why\n');
  assert.deepEqual([...loadKeep(join(d, 'keep')).value], ['sa-corrections', 'other-one']);
  assert.equal(loadKeep(d).ok, false); // a directory is unreadable as a file
});

test('isolation: non-default root requires PIPELINE_STACKS_ONLY', () => {
  const root = stacksRoot({ PIPELINE_STACKS_HOME: '/tmp/x' });
  assert.throws(() => isolation({ PIPELINE_STACKS_HOME: '/tmp/x' }, root), /PIPELINE_STACKS_ONLY/);
  assert.throws(() => isolation({ PIPELINE_STACKS_HOME: '/tmp/x' }, root), StacksIsolationError);
  assert.throws(() => isolation({ PIPELINE_STACKS_HOME: '/tmp/x', PIPELINE_STACKS_ONLY: ' , ' }, root), /PIPELINE_STACKS_ONLY/, 'an empty list is no list');
  const iso = isolation({ PIPELINE_STACKS_HOME: '/tmp/x', PIPELINE_STACKS_ONLY: 'autostop-smoke' }, root);
  assert.equal(iso.isDefault, false);
  assert.equal(projectAllowed('autostop-smoke', iso), true);
  assert.equal(projectAllowed('AutoStop-Smoke', iso), true, 'case-insensitive like the shared list');
  assert.equal(projectAllowed('sa-corrections', iso), false);
  assert.equal(stackFiles(root).pause, join(root, 'pause'));
});

test('isolation: the default root needs no list; a list given anyway still restricts', () => {
  const home = dir();
  const root = stacksRoot({}, home);
  assert.equal(root, join(home, '.claude', 'pipeline-state', 'stacks'));
  const iso = isolation({}, root, { home });
  assert.deepEqual([iso.isDefault, iso.only], [true, null]);
  assert.equal(projectAllowed('anything', iso), true);
  const narrowed = isolation({ PIPELINE_STACKS_ONLY: 'a, B' }, root, { home });
  assert.deepEqual([...narrowed.only].sort(), ['a', 'b']);
  assert.equal(projectAllowed('c', narrowed), false);
});

test('stacksRoot: ~ in PIPELINE_STACKS_HOME is expanded', () => {
  const home = dir();
  assert.equal(stacksRoot({ PIPELINE_STACKS_HOME: '~/x/stacks' }, home), join(home, 'x', 'stacks'));
});

test('stackFiles: every path absolute under the root; locks and workers are directories', () => {
  const root = join(dir(), 'r');
  const f = stackFiles(root);
  assert.deepEqual(Object.keys(f).sort(), ['actions', 'cache', 'config', 'keep', 'ledger', 'ledgerBad', 'locks', 'log', 'mode', 'pause', 'report', 'weekly', 'workers']);
  for (const p of Object.values(f)) assert.ok(p.startsWith(root + (process.platform === 'win32' ? '\\' : '/')), p);
  assert.equal(new Set(Object.values(f)).size, Object.keys(f).length, 'no two names share a path');
  assert.equal(f.config, join(root, 'config.json'));
  assert.equal(f.mode, join(root, 'mode.json'));
});

test('lock namespaces are disjoint directories; project ids map into the project dir only', () => {
  const root = join(dir(), 'r');
  const files = stackFiles(root);
  const dirs = lockDirs(root);
  assert.deepEqual(Object.keys(dirs).sort(), ['dev', 'ledger', 'project', 'sweep']);
  assert.equal(new Set(Object.values(dirs)).size, 4);
  for (const p of Object.values(dirs)) assert.equal(p.startsWith(files.locks), true, p);
  assert.equal(projectLockName('SA-Corrections'), 'sa-corrections');
  assert.equal(projectLockName('My Proj/x.y:z'), 'my_proj_x_y_z');
  assert.equal(projectLockName('ünï'), '_n_');
  for (const id of ['ledger', 'sweep', 'dev-3000']) {
    const lock = join(dirs.project, projectLockName(id));
    assert.equal(lock.startsWith(dirs.project), true, id);
    for (const g of [dirs.ledger, dirs.sweep, dirs.dev]) assert.notEqual(lock, g);
    assert.notEqual(lock, join(dirs.ledger, 'ledger'));
    assert.notEqual(lock, join(dirs.sweep, 'sweep'));
    assert.notEqual(lock, join(dirs.dev, '3000'));
  }
});

test('pause is a plain file test', () => {
  const d = dir(); assert.equal(isPaused(join(d, 'pause')), false);
  writeFileSync(join(d, 'pause'), ''); assert.equal(isPaused(join(d, 'pause')), true);
});

test('pause: an unreadable location counts as paused (fail closed)', posixOnly, (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores chmod');
  const d = dir(); const sub = join(d, 'sub'); mkdirSync(sub);
  writeFileSync(join(sub, 'pause'), '');
  chmodSync(sub, 0o000);
  t.after(() => chmodSync(sub, 0o755));
  assert.equal(isPaused(join(sub, 'pause')), true);
});

// ---- test-seam plumbing (R3-2) ----
test('the stacks overrides are registered seams', () => {
  for (const n of ['PIPELINE_DOCKER', 'PIPELINE_PS', 'PIPELINE_LSOF', 'PIPELINE_SUPABASE', 'PIPELINE_STACKS_DEADLINE_MS']) assert.ok(SEAM_VARS.includes(n), n);
});

function seamFixture() {
  const home = dir();
  const defaultRoot = stacksRoot({}, home);
  const installed = dir(); writeFileSync(join(installed, 'INSTALLED.json'), '{}');
  const checkout = dir();
  const custom = join(dir(), 'iso');
  const everything = { PIPELINE_DOCKER: '/fake/docker', PIPELINE_PS: '/fake/ps', PIPELINE_LSOF: '/fake/lsof', PIPELINE_SUPABASE: '/fake/supabase', PIPELINE_STACKS_DEADLINE_MS: '1500' };
  return { home, defaultRoot, installed, checkout, custom, everything };
}

test('stacksSeam: an installed copy ignores every override, default root or custom root', () => {
  const f = seamFixture();
  const warn = () => {};
  for (const [name, value] of Object.entries(f.everything)) {
    for (const stateHome of [f.defaultRoot, f.custom]) {
      const env = { ...f.everything, PIPELINE_STACKS_HOME: stateHome, PIPELINE_STACKS_ONLY: 'smoke' };
      assert.equal(stacksSeam(name, env, { root: f.installed, home: f.home, warn }), undefined, `${name} @ ${stateHome}`);
      assert.equal(typeof value, 'string');
    }
  }
});

test('stacksSeam: a checkout needs a non-default root AND an ONLY list', () => {
  const f = seamFixture();
  const warn = () => {};
  const at = (env) => stacksSeam('PIPELINE_DOCKER', { PIPELINE_DOCKER: '/fake/docker', ...env }, { root: f.checkout, home: f.home, warn });
  assert.equal(at({ PIPELINE_STACKS_HOME: f.defaultRoot, PIPELINE_STACKS_ONLY: 'smoke' }), undefined, 'default root supplied explicitly');
  assert.equal(at({ PIPELINE_STACKS_HOME: `${f.defaultRoot}/`, PIPELINE_STACKS_ONLY: 'smoke' }), undefined, 'trailing slash is still the default root');
  assert.equal(at({}), undefined, 'no state home at all');
  assert.equal(at({ PIPELINE_STACKS_HOME: f.custom }), undefined, 'custom root without ONLY');
  assert.equal(at({ PIPELINE_STACKS_HOME: f.custom, PIPELINE_STACKS_ONLY: '' }), undefined, 'empty ONLY');
  assert.equal(at({ PIPELINE_STACKS_ONLY: 'smoke' }), undefined, 'ONLY without a state home');
  assert.equal(at({ PIPELINE_STACKS_HOME: f.custom, PIPELINE_STACKS_ONLY: 'smoke' }), '/fake/docker', 'honoured');
  assert.equal(stacksSeam('PIPELINE_DOCKER', { PIPELINE_STACKS_HOME: f.custom, PIPELINE_STACKS_ONLY: 'smoke' }, { root: f.checkout, home: f.home, warn }), process.env.PIPELINE_DOCKER, 'unset override stays unset');
});

test('stacksSeam: a symlink to the default root is still the default root', posixOnly, () => {
  const f = seamFixture();
  mkdirSync(f.defaultRoot, { recursive: true });
  const alias = join(dir(), 'alias'); symlinkSync(f.defaultRoot, alias);
  const env = { PIPELINE_PS: '/fake/ps', PIPELINE_STACKS_HOME: alias, PIPELINE_STACKS_ONLY: 'smoke' };
  assert.equal(stacksSeam('PIPELINE_PS', env, { root: f.checkout, home: f.home, warn: () => {} }), undefined);
});
