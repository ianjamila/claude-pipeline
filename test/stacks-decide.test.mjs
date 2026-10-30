// Why: these verdicts decide whether a Docker stack gets stopped, so each rule is proved by mutation: start from evidence whose
// verdict is `stop`, flip exactly ONE input, and the verdict must stop being `stop` with a reason that names that input.
// A rule nobody can flip is a rule nobody tests. The module is pure (no fs, subprocess, env or clock), so there is nothing to
// fake here: results are plain `ok(...)` / `unknown(...)` values shaped like the probes in pipeline/lib/stacks/evidence.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBinding, sessionEndVerdict, sweepVerdict, DAY_MS } from '../pipeline/lib/stacks/decide.mjs';
import { ok, unknown } from '../pipeline/lib/stacks/result.mjs';

const makeStack = () => ({
  project: 'sa-corrections',
  workdir: '/w/sa-corrections.stack',
  workdirExists: true,
  folder: 'sa-corrections.stack',
  shared: false,
  generation: { id: 'c1', startedAt: '2026-10-17T01:00:00.000Z' },
  containers: [{ id: 'c1', name: 'supabase_db_sa-corrections', running: true, startedAt: '2026-10-17T01:00:00.000Z' }],
  ports: [54422],
  volumes: ['v1'],
  dbVolume: 'v1',
});

const goodBinding = () => ({ ok: true, reasons: [] });

const baseSweep = () => ({
  stack: makeStack(),
  paused: false,
  keep: ok(new Set()),
  liveLeases: ok([]),
  consumers: ok([{ path: '/w/a', exists: false, branch: null, via: 'ledger' }]),
  prStates: ok(new Map([['/w/a', { state: 'GONE', headMatches: true, eligible: true }]])),
  cwdProcs: ok([]),
  openSessions: ok([]),
  connections: ok([]),
  processRefs: ok([]),
  uptimeMs: DAY_MS + 1,
  memory: ok([]),
  transcripts: ok([]),
  binding: goodBinding(),
});

const baseSession = () => ({
  stack: makeStack(),
  paused: false,
  keep: ok(new Set()),
  otherLiveLeases: ok([]),
  connections: ok([]),
  processRefs: ok([]),
  cwdProcs: ok([]),
  openSessions: ok([]),
  binding: goodBinding(),
});

// ---------------------------------------------------------------- sweepVerdict

test('sweep: the base evidence is a stop (all seven conditions met)', () => {
  const v = sweepVerdict(baseSweep());
  assert.equal(v.verdict, 'stop');
  assert.deepEqual(v.notes, []);
});

// [flip, regex the reasons must match] — flips that exercise one input
const sweepFlips = {
  shared: [(e) => { e.stack.shared = true; }, /shared/],
  'built-in shared project id even when config says not shared': [(e) => { e.stack.project = 'eaglewatch-pipeline'; }, /shared/],
  'built-in shared workdir': [(e) => { e.stack.workdir = '/h/wt/.verify/supabase-workdir'; }, /shared/],
  'live lease': [(e) => { e.liveLeases = ok([{ owner: { pid: 9, birth: 1 } }]); }, /liveLeases.*pid 9/],
  'live lease as the Map liveOwners returns': [(e) => { e.liveLeases = ok(new Map([['9:1', { owner: { pid: 9, birth: 1 }, events: [] }]])); }, /liveLeases.*pid 9/],
  'no consumers known': [(e) => { e.consumers = ok([]); e.prStates = ok(new Map()); }, /consumers.*no consumer/],
  'consumer worktree open PR': [(e) => { e.consumers = ok([{ path: '/w/a', exists: true }]); e.prStates = ok(new Map([['/w/a', { state: 'OPEN', headMatches: true, eligible: false }]])); }, /prStates.*OPEN.*\/w\/a/],
  'open PR whose head differs': [(e) => { e.consumers = ok([{ path: '/w/a', exists: true }]); e.prStates = ok(new Map([['/w/a', { state: 'OPEN', headMatches: false, eligible: false }]])); }, /prStates.*OPEN/],
  'merged but head differs': [(e) => { e.consumers = ok([{ path: '/w/a', exists: true }]); e.prStates = ok(new Map([['/w/a', { state: 'MERGED', headMatches: false, eligible: false }]])); }, /prStates.*head differs/],
  'closed but head differs': [(e) => { e.consumers = ok([{ path: '/w/a', exists: true }]); e.prStates = ok(new Map([['/w/a', { state: 'CLOSED', headMatches: false, eligible: false }]])); }, /prStates.*head differs/],
  'existing consumer worktree with no PR': [(e) => { e.consumers = ok([{ path: '/w/a', exists: true }]); e.prStates = ok(new Map([['/w/a', { state: 'NONE', headMatches: false, eligible: false }]])); }, /prStates.*no PR/],
  'consumer with no PR state at all': [(e) => { e.prStates = ok(new Map()); }, /prStates.*no PR state/],
  'cwd process': [(e) => { e.cwdProcs = ok([{ pid: 5, dir: '/w/a' }]); }, /cwdProcs.*pid 5/],
  'open Claude session': [(e) => { e.openSessions = ok([{ id: 'aaaaaaaa', pid: 41, dir: '/w/a' }]); }, /openSessions: 1 open Claude session.*session aaaaaaaa pid 41 in \/w\/a/],
  connection: [(e) => { e.connections = ok([{ pid: 6, command: 'node', port: 54422 }]); }, /connections.*node/],
  'hidden-client connection': [(e) => { e.connections = ok([{ pid: null, birth: null, command: 'hidden client', port: 54422 }]); }, /connections.*hidden client/],
  'process ref': [(e) => { e.processRefs = ok([{ pid: 7, command: 'node x', field: 'env' }]); }, /processRefs.*pid 7.*env/],
  'uptime exactly 24h': [(e) => { e.uptimeMs = DAY_MS; }, /uptimeMs/],
  'uptime under 24h': [(e) => { e.uptimeMs = 3_600_000; }, /uptimeMs/],
  'uptime not a number': [(e) => { e.uptimeMs = NaN; }, /uptimeMs/],
  'memory mention': [(e) => { e.memory = ok(['home/x.md']); }, /memory.*home\/x\.md/],
  'keep listed': [(e) => { e.keep = ok(new Set(['SA-Corrections'])); }, /keep/],
  'recent transcript': [(e) => { e.transcripts = ok(['/t/s.jsonl']); }, /transcripts.*s\.jsonl/],
  paused: [(e) => { e.paused = true; }, /paused/],
  'pause state not provided': [(e) => { delete e.paused; }, /paused/],
  'missing workdir': [(e) => { e.stack.workdirExists = false; }, /workdir/],
  'workdir unknown (container without the label)': [(e) => { e.stack.workdir = null; e.stack.workdirExists = false; e.stack.folder = null; }, /workdir/],
  'no database container assessed': [(e) => { e.stack.generation = null; }, /generation/],
  'database container not running': [(e) => { e.stack.containers[0].running = false; }, /not running/],
  'binding failed': [(e) => { e.binding = { ok: false, reasons: ['binding: container id x != assessed c1'] }; }, /binding: container id/],
  'binding missing': [(e) => { delete e.binding; }, /binding/],
  ...Object.fromEntries(['cwdProcs', 'openSessions', 'connections', 'processRefs', 'memory', 'keep', 'transcripts', 'consumers', 'prStates', 'liveLeases']
    .map((k) => [`${k} unknown`, [(e) => { e[k] = unknown('probe failed'); }, new RegExp(`${k} unknown: probe failed`)]])),
};
for (const [name, [flip, re]] of Object.entries(sweepFlips)) {
  test(`sweep: ${name} prevents stop`, () => {
    const e = baseSweep();
    assert.equal(sweepVerdict(e).verdict, 'stop');
    flip(e);
    const v = sweepVerdict(e);
    assert.notEqual(v.verdict, 'stop');
    assert.ok(v.reasons.length > 0);
    assert.ok(v.reasons.some((r) => re.test(r)), `no reason matches ${re}: ${JSON.stringify(v.reasons)}`);
  });
}

test('sweep: kept (positive evidence of use) vs listed (cannot decide) are told apart', () => {
  const kept = ['shared', 'live lease', 'consumer worktree open PR', 'cwd process', 'open Claude session', 'connection', 'hidden-client connection', 'process ref',
    'uptime exactly 24h', 'memory mention', 'keep listed', 'recent transcript', 'paused'];
  const listed = ['no consumers known', 'merged but head differs', 'existing consumer worktree with no PR', 'missing workdir', 'binding failed',
    'cwdProcs unknown', 'openSessions unknown', 'connections unknown', 'consumers unknown', 'prStates unknown', 'liveLeases unknown', 'memory unknown', 'keep unknown', 'transcripts unknown'];
  for (const name of kept) {
    const e = baseSweep(); sweepFlips[name][0](e);
    assert.equal(sweepVerdict(e).verdict, 'kept', name);
  }
  for (const name of listed) {
    const e = baseSweep(); sweepFlips[name][0](e);
    assert.equal(sweepVerdict(e).verdict, 'listed', name);
  }
});

test('sweep: a consumer with no PR is listed, never stop (R2-4/R2-14)', () => {
  const e = baseSweep();
  e.consumers = ok([{ path: '/w/a', exists: true }]);
  e.prStates = ok(new Map([['/w/a', { state: 'NONE', headMatches: false, eligible: false }]]));
  const v = sweepVerdict(e);
  assert.equal(v.verdict, 'listed');
  assert.match(v.reasons.join('\n'), /no PR/);
});

test('sweep: mixed consumers, one gone/merged and one OPEN, is kept', () => {
  const e = baseSweep();
  e.consumers = ok([{ path: '/w/a', exists: false }, { path: '/w/b', exists: true }, { path: '/w/c', exists: true }]);
  e.prStates = ok(new Map([
    ['/w/a', { state: 'GONE', headMatches: true, eligible: true }],
    ['/w/b', { state: 'MERGED', headMatches: true, eligible: true }],
    ['/w/c', { state: 'OPEN', headMatches: true, eligible: false }],
  ]));
  const v = sweepVerdict(e);
  assert.equal(v.verdict, 'kept');
  assert.match(v.reasons.join('\n'), /OPEN.*\/w\/c/);
});

test('sweep: OPEN beats an undecided sibling (kept, and the undecided one is still named)', () => {
  const e = baseSweep();
  e.consumers = ok([{ path: '/w/a', exists: true }, { path: '/w/b', exists: true }]);
  e.prStates = ok(new Map([['/w/a', { state: 'NONE', headMatches: false }], ['/w/b', { state: 'OPEN', headMatches: true }]]));
  const v = sweepVerdict(e);
  assert.equal(v.verdict, 'kept');
  assert.ok(v.reasons.some((r) => /no PR/.test(r)));
});

test('sweep: gone, merged and closed consumers, all at their PR head, stop', () => {
  const e = baseSweep();
  e.consumers = ok([{ path: '/w/a', exists: false }, { path: '/w/b', exists: true }, { path: '/w/c', exists: true }]);
  e.prStates = ok(new Map([
    ['/w/a', { state: 'GONE', headMatches: true, eligible: true }],
    ['/w/b', { state: 'MERGED', headMatches: true, eligible: true }],
    ['/w/c', { state: 'CLOSED', headMatches: true, eligible: true }],
  ]));
  assert.equal(sweepVerdict(e).verdict, 'stop');
});

test('sweep: a hidden-client connection (foreign user, no visible client socket) keeps the stack', () => {
  const e = baseSweep();
  e.connections = ok([{ pid: null, birth: null, command: 'hidden client', port: 54422 }]);
  const v = sweepVerdict(e);
  assert.equal(v.verdict, 'kept');
  assert.match(v.reasons.join('\n'), /hidden client/);
});

test('sweep: uptime one millisecond over 24 h is enough, exactly 24 h is not', () => {
  const e = baseSweep();
  e.uptimeMs = DAY_MS + 1;
  assert.equal(sweepVerdict(e).verdict, 'stop');
  e.uptimeMs = DAY_MS;
  assert.equal(sweepVerdict(e).verdict, 'kept');
});

test('sweep: hidden-process counts and probe notes ride along in `notes` without changing the verdict', () => {
  const e = baseSweep();
  e.processRefs = { ok: true, value: [], hidden: 3 };
  e.cwdProcs = { ok: true, value: [], hidden: 1 };
  e.memory = { ok: true, value: [], notes: ['/m/none does not exist'] };
  const v = sweepVerdict(e);
  assert.equal(v.verdict, 'stop');
  assert.equal(v.notes.length, 3);
  assert.ok(v.notes.some((n) => /processRefs: 3 other-user/.test(n)));
  assert.ok(v.notes.some((n) => /cwdProcs: 1 other-user/.test(n)));
  assert.ok(v.notes.some((n) => /memory: \/m\/none does not exist/.test(n)));
});

test('sweep: unknown stays unknown when the probe has extra fields (unknown never reads as empty)', () => {
  const e = baseSweep();
  e.processRefs = { ok: false, reason: 'ps timed out', hidden: 0, value: [] };
  const v = sweepVerdict(e);
  assert.equal(v.verdict, 'listed');
  assert.match(v.reasons.join('\n'), /processRefs unknown: ps timed out/);
});

test('sweep: input is not mutated and an empty call does not throw', () => {
  const e = baseSweep();
  const before = JSON.stringify([...Object.entries(e)].map(([k, v]) => [k, v instanceof Object && v.value instanceof Map ? [...v.value] : v]));
  sweepVerdict(e);
  assert.equal(JSON.stringify([...Object.entries(e)].map(([k, v]) => [k, v instanceof Object && v.value instanceof Map ? [...v.value] : v])), before);
  assert.notEqual(sweepVerdict({}).verdict, 'stop');
  assert.notEqual(sweepVerdict().verdict, 'stop');
});

// ---------------------------------------------------------------- sessionEndVerdict

test('session-end: the base evidence is a stop', () => {
  assert.equal(sessionEndVerdict(baseSession()).verdict, 'stop');
});

const sessionFlips = {
  shared: [(e) => { e.stack.shared = true; }, /shared/],
  'built-in shared project id': [(e) => { e.stack.project = 'foo-pipeline'; }, /shared/],
  'other live lease': [(e) => { e.otherLiveLeases = ok([{ owner: { pid: 9, birth: 1 } }]); }, /otherLiveLeases.*pid 9/],
  'cwd process': [(e) => { e.cwdProcs = ok([{ pid: 5, dir: '/w/a' }]); }, /cwdProcs.*pid 5/],
  'open Claude session': [(e) => { e.openSessions = ok([{ id: 'aaaaaaaa', pid: 41, dir: '/w/a' }, { id: 'bbbbbbbb', pid: 42, dir: '/w/b' }]); }, /openSessions: 2 open Claude session.*session aaaaaaaa pid 41 in \/w\/a; session bbbbbbbb pid 42 in \/w\/b/],
  connection: [(e) => { e.connections = ok([{ pid: 6, command: 'node', port: 54422 }]); }, /connections.*node/],
  'hidden-client connection': [(e) => { e.connections = ok([{ pid: null, birth: null, command: 'hidden client', port: 54422 }]); }, /connections.*hidden client/],
  'process ref': [(e) => { e.processRefs = ok([{ pid: 7, command: 'node x', field: 'cmdline' }]); }, /processRefs.*pid 7/],
  'keep listed': [(e) => { e.keep = ok(new Set(['sa-corrections'])); }, /keep/],
  paused: [(e) => { e.paused = true; }, /paused/],
  'missing workdir': [(e) => { e.stack.workdirExists = false; }, /workdir/],
  'workdir unknown': [(e) => { e.stack.workdir = null; }, /workdir/],
  'no database container assessed': [(e) => { e.stack.generation = null; }, /generation/],
  'database container not running': [(e) => { e.stack.containers[0].running = false; }, /not running/],
  'binding failed': [(e) => { e.binding = { ok: false, reasons: ['binding: container StartedAt differs'] }; }, /binding: container StartedAt/],
  'binding missing': [(e) => { delete e.binding; }, /binding/],
  ...Object.fromEntries(['cwdProcs', 'openSessions', 'connections', 'processRefs', 'keep', 'otherLiveLeases']
    .map((k) => [`${k} unknown`, [(e) => { e[k] = unknown('probe failed'); }, new RegExp(`${k} unknown: probe failed`)]])),
};
for (const [name, [flip, re]] of Object.entries(sessionFlips)) {
  test(`session-end: ${name} prevents stop`, () => {
    const e = baseSession();
    assert.equal(sessionEndVerdict(e).verdict, 'stop');
    flip(e);
    const v = sessionEndVerdict(e);
    assert.equal(v.verdict, 'kept', 'session-end has only stop | kept');
    assert.ok(v.reasons.length > 0);
    assert.ok(v.reasons.some((r) => re.test(r)), `no reason matches ${re}: ${JSON.stringify(v.reasons)}`);
  });
}

test('session-end: a young container is NOT a reason (only the sweeper has the 24 h rule) and needs no PR or memory evidence', () => {
  const e = baseSession();
  e.uptimeMs = 1000;
  e.consumers = unknown('not asked');
  e.prStates = unknown('not asked');
  e.memory = unknown('not asked');
  assert.equal(sessionEndVerdict(e).verdict, 'stop');
});

test('session-end: hidden counts reach notes', () => {
  const e = baseSession();
  e.processRefs = { ok: true, value: [], hidden: 2 };
  const v = sessionEndVerdict(e);
  assert.equal(v.verdict, 'stop');
  assert.ok(v.notes.some((n) => /processRefs: 2 other-user/.test(n)));
});

// ---------------------------------------------------------------- checkBinding

const assessedStack = () => ({ project: 'sa-corrections', workdir: '/w/sa-corrections.stack', shared: false, generation: { id: 'c1', startedAt: '2026-10-17T01:00:00.000Z' } });
const currentBinding = () => ({
  workdirExists: true,
  workdirReal: '/w/sa-corrections.stack',
  labelWorkdirReal: '/w/sa-corrections.stack',
  configProject: 'sa-corrections',
  labelProject: 'sa-corrections',
  generation: { id: 'c1', startedAt: '2026-10-17T01:00:00.000Z' },
  shared: false,
});

test('binding: every field agreeing is ok', () => {
  assert.deepEqual(checkBinding(assessedStack(), currentBinding()), { ok: true, reasons: [] });
});

const bindingFlips = {
  'workdir realpath': [(c) => { c.workdirReal = '/w/other.stack'; }, /workdir realpath \/w\/other\.stack/],
  'label workdir': [(c) => { c.labelWorkdirReal = '/w/other.stack'; }, /container workdir label \/w\/other\.stack/],
  'config project': [(c) => { c.configProject = 'other'; }, /config\.toml project_id other/],
  'label project': [(c) => { c.labelProject = 'other'; }, /container project label other/],
  'generation id': [(c) => { c.generation.id = 'c2'; }, /container id c2/],
  'generation startedAt': [(c) => { c.generation.startedAt = '2026-10-19T01:00:00.000Z'; }, /StartedAt 2026-10-19/],
  shared: [(c) => { c.shared = true; }, /shared/],
  'workdir missing': [(c) => { c.workdirExists = false; }, /does not exist/],
  'project case differs (exact match only)': [(c) => { c.configProject = 'SA-Corrections'; }, /config\.toml project_id/],
};
for (const [name, [flip, re]] of Object.entries(bindingFlips)) {
  test(`binding: ${name} breaks the binding`, () => {
    const c = currentBinding();
    flip(c);
    const b = checkBinding(assessedStack(), c);
    assert.equal(b.ok, false);
    assert.ok(b.reasons.some((r) => re.test(r)), `no reason matches ${re}: ${JSON.stringify(b.reasons)}`);
  });
}

test('binding: a symlinked workdir re-pointed at a config whose project is e2e-ci is refused', () => {
  // /w/sa-corrections.stack used to be a link to a private stack; now it resolves to a stack whose config.toml says e2e-ci.
  // The container labels still say sa-corrections and the realpath still equals what was assessed, but the config project
  // is the shared one: the config project disagrees with the assessed and label projects, and it is shared.
  const c = currentBinding();
  c.configProject = 'e2e-ci';
  c.shared = true; // the caller computes `shared` from the project it read now
  const b = checkBinding(assessedStack(), c);
  assert.equal(b.ok, false);
  assert.ok(b.reasons.some((r) => /config\.toml project_id e2e-ci != assessed sa-corrections/.test(r)));
  assert.ok(b.reasons.some((r) => /shared/.test(r)));
  // even a caller that forgot to mark it shared cannot get through: the config project differs from what was assessed
  c.shared = false;
  assert.equal(checkBinding(assessedStack(), c).ok, false);
});

test('binding: a symlinked workdir re-pointed at a different directory changes the realpath and is refused', () => {
  const c = currentBinding();
  c.workdirReal = '/w/eaglewatch-pipeline-wd';
  const b = checkBinding(assessedStack(), c);
  assert.equal(b.ok, false);
  assert.ok(b.reasons.some((r) => /workdir realpath/.test(r)));
});

test('binding: the built-in shared rules hold even when the caller says not shared', () => {
  const a = assessedStack(); a.project = 'eaglewatch-pipeline';
  const c = currentBinding(); c.configProject = 'eaglewatch-pipeline'; c.labelProject = 'eaglewatch-pipeline';
  assert.equal(checkBinding(a, c).ok, false);
  const a2 = assessedStack(); a2.workdir = '/h/wt/.verify/supabase-workdir';
  const c2 = currentBinding(); c2.workdirReal = a2.workdir; c2.labelWorkdirReal = a2.workdir;
  assert.equal(checkBinding(a2, c2).ok, false);
});

test('binding: missing or null fields never agree with each other (null === null is not agreement)', () => {
  const b = checkBinding({ project: null, workdir: null, generation: null }, { workdirExists: true, workdirReal: null, labelWorkdirReal: null, configProject: null, labelProject: null, generation: null, shared: false });
  assert.equal(b.ok, false);
  assert.equal(checkBinding(undefined, undefined).ok, false);
  assert.equal(checkBinding({}, {}).ok, false);
  const c = currentBinding(); delete c.generation;
  assert.equal(checkBinding(assessedStack(), c).ok, false);
  const c2 = currentBinding(); delete c2.shared;
  assert.equal(checkBinding(assessedStack(), c2).ok, false, 'sharing unknown is not "not shared"');
});

test('binding: a binding failure in the sweep is listed, in session-end it is kept', () => {
  const c = currentBinding(); c.generation.id = 'c2';
  const binding = checkBinding(assessedStack(), c);
  const s = baseSweep(); s.binding = binding;
  assert.equal(sweepVerdict(s).verdict, 'listed');
  const e = baseSession(); e.binding = binding;
  assert.equal(sessionEndVerdict(e).verdict, 'kept');
});

// ---------------------------------------------------------------- shape of the module

test('decide.mjs is pure: no fs, subprocess, env or clock; its header states the rules', () => {
  const src = readFileSync(new URL('../pipeline/lib/stacks/decide.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  for (const banned of [/node:fs/, /child_process/, /process\.env/, /Date\.now/, /new Date\(/, /\bspawn/, /\bexec/, /\bimport\(/, /require\(/]) {
    assert.doesNotMatch(code, banned);
  }
  const imports = [...code.matchAll(/^import .* from '(.*)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => i !== './result.mjs'), []);
  const header = src.split('\n').filter((l) => l.startsWith('//')).join('\n');
  for (const phrase of [
    'supabase stop --workdir', 'Target binding', 'fail closed', 'MORE than 24 h', 'hidden client', 'OTHER USERS', 'server side',
    'C2', 'C3', 'C4', 'C6', 'NON-EMPTY', 'keep-listed', 'listed', 'kept',
  ]) assert.ok(header.toLowerCase().includes(phrase.toLowerCase()), `header lacks "${phrase}"`);
});

test('open sessions: the reason carries the unknown text (a persistent unplaced keeps/lists every stack until fixed); a bad shape is unknown', () => {
  const reason = 'open Claude sessions could not all be placed: cannot read /home/x/.claude/sessions (EACCES)';
  const k = baseSession();
  k.openSessions = unknown(reason);
  const kv = sessionEndVerdict(k);
  assert.equal(kv.verdict, 'kept');
  assert.ok(kv.reasons.some((r) => r === `openSessions unknown: ${reason}`), JSON.stringify(kv.reasons));
  const w = baseSweep();
  w.openSessions = unknown(reason);
  const wv = sweepVerdict(w);
  assert.equal(wv.verdict, 'listed');
  assert.ok(wv.reasons.some((r) => r === `openSessions unknown: ${reason}`), JSON.stringify(wv.reasons));
  for (const [verdict, base] of [[sessionEndVerdict, baseSession()], [sweepVerdict, baseSweep()]]) {
    base.openSessions = ok('nope');
    assert.notEqual(verdict(base).verdict, 'stop');
  }
});

test('open sessions: a kept open session wins over a listed unknown in the sweep; notes of the probe reach the verdict', () => {
  const e = baseSweep();
  e.openSessions = ok([{ id: 'aaaaaaaa', pid: 41, dir: '/w/a' }]);
  e.memory = unknown('memory dirs unreadable');
  assert.equal(sweepVerdict(e).verdict, 'kept');
  const n = baseSession();
  n.openSessions = { ok: true, value: [], notes: ['open-session records unavailable (no Claude sessions folder found)'] };
  const v = sessionEndVerdict(n);
  assert.equal(v.verdict, 'stop');
  assert.ok(v.notes.some((x) => /^openSessions: open-session records unavailable/.test(x)));
});
