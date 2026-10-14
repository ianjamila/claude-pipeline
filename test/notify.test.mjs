import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTCOME_EVENTS, classifyOutcome, defaultAction, prodEvent, prodErrorEvent, parseSecrets, loadNotifyConfig, scrubber, buildTitle, machineLabel,
  buildMessage, eventKey, parseRemote, notifyEvent, testEvent, detectWsl, raiseAutoSelectFamilyTimeout, TOAST_SCRIPT, TOAST_AUMID, encodeToastScript, LEDGER_NAME, DEFAULT_SECRETS_FILE,
} from '../pipeline/lib/notify.mjs';
import { run as notifyCommand } from '../pipeline/commands/notify.mjs';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { isPidAlive } from '../pipeline/lib/locks.mjs';
import { killTree } from '../pipeline/lib/proc.mjs';

// Never create ~/.claude/pipeline-state/machine-id from a test run (scripts/test.mjs sets this too).
process.env.PIPELINE_MACHINE_ID ||= 'test-machine-id';
const SEND_FIXTURE = fileURLToPath(new URL('./fixtures/notify-send.mjs', import.meta.url));
const HOLD_FIXTURE = fileURLToPath(new URL('./fixtures/hold-lock.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../pipeline/bin/pipeline.mjs', import.meta.url));
const TOPIC = 'SENTINELTOPIC123';
const TOKEN = 'SENTINELTOKEN456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roots = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cp-notify-'));
  roots.push(d);
  return d;
};
// Best effort, like test/jobs.test.mjs: a Windows file may still be open for a moment after its process exits.
after(() => {
  for (const d of roots) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may still hold a handle */ }
  }
});

// Resolves once a spawned child has exited (immediately if it already has), so no test leaves a live process whose cwd or
// open files are inside a temp dir: on Windows that makes the directory undeletable (EPERM).
const exited = (child) => (child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise((res) => child.once('close', res)));

// A fake spawn: the child records the stdin it was given and closes with `code` (or hangs until killed).
function fakeSpawn({ code = 0, hang = false } = {}) {
  const calls = [];
  const fn = (file, args, opts) => {
    const child = new EventEmitter();
    const call = { file, args, opts, stdin: null, killed: null };
    calls.push(call);
    child.stderr = new EventEmitter();
    child.stdin = {
      on() {},
      end(data) {
        call.stdin = data;
        if (!hang) setImmediate(() => child.emit('close', code));
      },
    };
    child.kill = (sig) => {
      call.killed = sig;
      setImmediate(() => child.emit('close', null));
    };
    return child;
  };
  fn.calls = calls;
  return fn;
}

// Everything injectable, wired to a temp state dir and a secrets file with a sentinel topic.
function rig(over = {}) {
  const dir = tmp();
  const secretsFile = path.join(dir, 'secrets.sh');
  writeFileSync(secretsFile, over.secrets ?? `export NTFY_TOPIC=${TOPIC}\n`);
  const fetchCalls = [];
  const fetchImpl = over.fetch ?? (async () => ({ ok: true, status: 200 }));
  const deps = {
    env: over.env ?? {},
    secretsFile,
    stateDir: path.join(dir, 'state'),
    cwd: dir,
    git: (args) => (args[0] === 'remote' ? 'git@github.com:acme/widgets.git' : 'abc1234def5678'),
    isWsl: () => false,
    platform: 'linux',
    hostname: () => 'testbox',
    // Never run a real `gh` from a test (on a runner with gh installed it would be a live process with its cwd in the temp
    // dir); the one test that exercises the real lookup opts in with realLookup.
    ...(over.realLookup ? {} : { lookup: async () => null }),
    fetch: async (url, init) => {
      fetchCalls.push({ url, init, body: JSON.parse(init.body) });
      return fetchImpl(url, init);
    },
    ...(over.deps ?? {}),
  };
  return { dir, deps, fetchCalls, ledger: () => readLedgerText(deps.stateDir) };
}
const readLedgerText = (stateDir) => (existsSync(path.join(stateDir, LEDGER_NAME)) ? readFileSync(path.join(stateDir, LEDGER_NAME), 'utf8') : '');
const ledgerRecords = (stateDir) => readLedgerText(stateDir).split('\n').filter(Boolean).map((l) => JSON.parse(l));

const STOP = { event: 'stopped', pr: 12, title: 'Fix the thing', action: 'Read the PR: the run stopped', outcome: 'stopped', head: 'abc1234def5678' };

// ---- outcome map ----------------------------------------------------------------------------------------------------------

test('outcome map: only stopped/blocked/awaiting-review/needs-human/awaiting-owner-merge push; the rest are explicit no-push', () => {
  assert.deepEqual(
    Object.entries(OUTCOME_EVENTS).filter(([, e]) => e).map(([o, e]) => `${o}=${e}`).sort(),
    ['awaiting-owner-merge=owner-merge', 'awaiting-review=stopped', 'blocked=stopped', 'needs-human=needs-human', 'stopped=stopped'],
  );
  for (const o of ['merged', 'no-production', 'closed', 'merged-externally', 'superseded', 'recovered', 'rollback-failed', 'changed-during-recovery', 'rollback-skipped', 'not-live', 'deploy-failed', 'deploy-not-observed']) {
    assert.ok(Object.hasOwn(OUTCOME_EVENTS, o) && OUTCOME_EVENTS[o] === null, `${o} must be an explicit null`);
    assert.deepEqual(classifyOutcome(o), { known: true, event: null });
  }
  assert.deepEqual(classifyOutcome('stopped'), { known: true, event: 'stopped' });
  assert.ok(Object.isFrozen(OUTCOME_EVENTS));
});

test('an unknown outcome word is unclassified: no push', () => {
  assert.deepEqual(classifyOutcome('progressing'), { known: false, event: null });
  assert.deepEqual(classifyOutcome('toString'), { known: false, event: null });
  assert.deepEqual(classifyOutcome(undefined), { known: false, event: null });
});

test('default actions name the one thing to do', () => {
  assert.equal(defaultAction('owner-merge', { head: 'abcdef0123' }), 'Check the listed items, then say "merge" for head abcdef0');
  assert.equal(defaultAction('needs-human'), 'Read the needs-human comment and decide');
  assert.equal(defaultAction('arbiter-escalation', { ids: ['a1', 'b2'] }), 'Rule on a1, b2 in the triage comment');
  assert.equal(defaultAction('stopped'), 'Read the PR: the run stopped');
  assert.equal(defaultAction('pipeline-update'), 'Run the manual update in your own terminal and read its error');
});

test('pipeline-update (the scheduled auto-update) is a known event: custom title, the owner action, one push per cause', async () => {
  const m = buildMessage({ event: 'pipeline-update', pr: null, title: 'Pipeline auto-update failed', action: 'install-failed. Run the manual update in your own terminal and read its error' }, { repoName: 'claude' });
  assert.equal(m.title, 'Pipeline auto-update failed');
  assert.equal(m.message, 'Pipeline auto-update: install-failed. Run the manual update in your own terminal and read its error (claude)');
  assert.equal(m.priority, 4);
  const r = rig();
  const ev = { event: 'pipeline-update', pr: null, title: 'Pipeline auto-update failed', action: 'x', head: 'a'.repeat(40), outcome: 'failed', cause: 'install-failed:aaaaaaa@t1' };
  assert.equal((await notifyEvent(ev, r.deps)).sent, true);
  assert.equal((await notifyEvent({ ...ev, action: 'reworded' }, r.deps)).reason, 'duplicate');
  assert.equal((await notifyEvent({ ...ev, cause: 'install-failed:aaaaaaa@t2' }, r.deps)).sent, true);
  assert.equal(r.fetchCalls.length, 2);
});

// ---- message --------------------------------------------------------------------------------------------------------------

test('message per event: title #N + PR title, body "<label>: <action> (repo)", priority, tags, click', () => {
  const cases = [
    ['owner-merge', 'Ready to merge'],
    ['needs-human', 'Needs you'],
    ['arbiter-escalation', 'Arbiter escalation'],
    ['stopped', 'Run stopped'],
  ];
  for (const [event, label] of cases) {
    const m = buildMessage({ event, pr: 5, title: 'Add a thing', action: 'Do the one thing' }, { repoName: 'eaglewatch', click: 'https://github.com/o/eaglewatch/pull/5' });
    assert.equal(m.title, '#5 Add a thing');
    assert.equal(m.message, `${label}: Do the one thing (eaglewatch)`);
    assert.equal(m.priority, 4);
    assert.ok(m.tags.includes('eaglewatch'));
    assert.equal(m.click, 'https://github.com/o/eaglewatch/pull/5');
  }
});

test('title is truncated to 80, and is just #N without a PR title', () => {
  assert.equal(buildTitle(9, undefined), '#9');
  assert.equal(buildTitle(9, '   '), '#9');
  const t = buildTitle(9, 'x'.repeat(200));
  assert.equal(t.length, 80);
  assert.ok(t.startsWith('#9 xxx') && t.endsWith('…'));
  assert.equal(buildTitle(9, 'two\nlines\tand   spaces'), '#9 two lines and spaces');
});

// ---- machine label -------------------------------------------------------------------------------------------------------

test('machine label: Mac on darwin, PC under WSL or on win32, otherwise the sanitized hostname', () => {
  assert.equal(machineLabel({ platform: 'darwin', wsl: false, hostname: () => 'whatever' }), 'Mac');
  assert.equal(machineLabel({ platform: 'linux', wsl: true, hostname: () => 'whatever' }), 'PC');
  assert.equal(machineLabel({ platform: 'win32', wsl: false, hostname: () => 'whatever' }), 'PC');
  assert.equal(machineLabel({ platform: 'linux', wsl: false, hostname: () => '  build-box.local \n' }), 'build-box.local');
  assert.equal(machineLabel({ platform: 'linux', wsl: false, hostname: () => 'we!rd/host' }), 'we-rd-host');
  assert.equal(machineLabel({ platform: 'linux', wsl: false, hostname: () => 'h'.repeat(60) }).length, 20);
  assert.equal(machineLabel({ platform: 'linux', wsl: false, hostname: () => '' }), 'unknown');
  assert.equal(machineLabel({ platform: 'linux', wsl: false, hostname: () => { throw new Error('no'); } }), 'unknown');
});

test('title carries the machine label and the whole title is clipped to 80 with the label intact', () => {
  assert.equal(buildTitle(9, 'A thing', 'Mac'), '[Mac] #9 A thing');
  assert.equal(buildTitle(9, undefined, 'PC'), '[PC] #9');
  assert.equal(buildTitle(undefined, 'Pipeline notify test', 'PC'), '[PC] Pipeline notify test');
  const t = buildTitle(9, 'x'.repeat(200), 'a-twenty-char-label_');
  assert.equal(t.length, 80);
  assert.ok(t.startsWith('[a-twenty-char-label_] #9 xxx') && t.endsWith('…'));
  assert.equal(buildMessage({ event: 'stopped', pr: 5, title: 'T', action: 'a' }, { machine: 'Mac' }).title, '[Mac] #5 T');
});

test('push title says which machine: Mac, WSL (PC), win32 (PC) and another host by hostname', async () => {
  const cases = [
    [{ platform: 'darwin' }, '[Mac] #12 Fix the thing'],
    [{ platform: 'linux', isWsl: () => true }, '[PC] #12 Fix the thing'],
    [{ platform: 'win32' }, '[PC] #12 Fix the thing'],
    [{ platform: 'linux', hostname: () => 'ci-runner-7' }, '[ci-runner-7] #12 Fix the thing'],
  ];
  for (const [deps, expected] of cases) {
    const r = rig({ deps });
    await notifyEvent(STOP, r.deps);
    assert.equal(r.fetchCalls[0].body.title, expected);
  }
});

test('NTFY_MACHINE overrides the label from the environment and from the secrets file; the environment wins', async () => {
  const e = rig({ env: { NTFY_MACHINE: 'Office Mac' }, deps: { platform: 'darwin' } });
  await notifyEvent(STOP, e.deps);
  assert.equal(e.fetchCalls[0].body.title, '[Office Mac] #12 Fix the thing');
  const f = rig({ secrets: `export NTFY_TOPIC=${TOPIC}\nNTFY_MACHINE=Desk-2\n`, deps: { platform: 'darwin' } });
  await notifyEvent(STOP, f.deps);
  assert.equal(f.fetchCalls[0].body.title, '[Desk-2] #12 Fix the thing');
  const both = rig({ env: { NTFY_MACHINE: 'FromEnv' }, secrets: `export NTFY_TOPIC=${TOPIC}\nNTFY_MACHINE=FromFile\n` });
  await notifyEvent(STOP, both.deps);
  assert.equal(both.fetchCalls[0].body.title, '[FromEnv] #12 Fix the thing');
});

test('an invalid NTFY_MACHINE is ignored: the default label is used, the push still goes out, and the result says so', async () => {
  for (const bad of ['has/slash', 'x'.repeat(21), 'tab\there', '$(whoami)']) {
    const r = rig({ env: { NTFY_MACHINE: bad }, deps: { platform: 'darwin' } });
    const res = await notifyEvent(STOP, r.deps);
    assert.equal(res.sent, true, bad);
    assert.equal(r.fetchCalls[0].body.title, '[Mac] #12 Fix the thing');
    assert.equal(res.machineLabel, 'default (invalid NTFY_MACHINE)');
  }
  const f = rig({ secrets: `export NTFY_TOPIC=${TOPIC}\nNTFY_MACHINE=$(whoami)\n`, deps: { platform: 'darwin' } });
  const res = await notifyEvent(STOP, f.deps);
  assert.equal(res.sent, true);
  assert.equal(f.fetchCalls[0].body.title, '[Mac] #12 Fix the thing');
  assert.equal(res.machineLabel, 'default (invalid NTFY_MACHINE)');
  const ok = await notifyEvent(STOP, rig().deps);
  assert.equal(ok.machineLabel, undefined);
});

test('the machine label is not part of the event identity or the ledger', async () => {
  const r = rig({ deps: { platform: 'darwin' } });
  await notifyEvent(STOP, r.deps);
  const key = ledgerRecords(r.deps.stateDir)[0].key;
  assert.equal(key, eventKey(STOP, { repo: 'acme/widgets', head: STOP.head }));
  // The same event from a differently labelled machine against the same ledger is still a duplicate.
  const again = await notifyEvent(STOP, { ...r.deps, platform: 'linux', env: { NTFY_MACHINE: 'Other' } });
  assert.equal(again.reason, 'duplicate');
  assert.ok(ledgerRecords(r.deps.stateDir).every((x) => x.key === key));
  assert.ok(!r.ledger().includes('Mac'));
  assert.equal(r.fetchCalls.length, 1);
});

test('body is at most 300 characters and keeps the repo name; needs-human lists its items', () => {
  const m = buildMessage({ event: 'stopped', pr: 1, action: 'y'.repeat(900) }, { repoName: 'DRMed' });
  assert.ok(m.message.length <= 300);
  assert.ok(m.message.endsWith('… (DRMed)'));
  const n = buildMessage({ event: 'needs-human', pr: 1, action: 'Decide', ids: ['b-2', 'a-1'] }, { repoName: 'x' });
  assert.match(n.message, /Needs you: Decide \[items: b-2, a-1\] \(x\)/);
});

// ---- production events ----------------------------------------------------------------------------------------------------

const ISSUE = { number: 50, url: 'https://github.com/acme/widgets/issues/50' };
const REVERT = { number: 51, url: 'https://github.com/acme/widgets/pull/51' };

test('prod merged: "Live and healthy — nothing to do.", priority 3', () => {
  const e = prodEvent({ outcome: 'merged', mergeSha: 'a'.repeat(40), issue: null, revertPr: null }, { pr: 12 });
  assert.equal(e.action, 'Live and healthy — nothing to do.');
  assert.equal(e.priority, 3);
  assert.equal(e.event, 'prod-merged');
});

test('prod recovered: names the revert PR and the issue; wording follows the artifacts that exist', () => {
  const full = prodEvent({ outcome: 'recovered', mergeSha: 'abcdef0123', issue: ISSUE, revertPr: REVERT }, { pr: 12 });
  assert.equal(full.action, 'Rolled back, prod healthy. Review revert PR #51; close issue #50 to unpause merges.');
  assert.equal(full.priority, 4);
  const noRevert = prodEvent({ outcome: 'recovered', mergeSha: 'abcdef0123', issue: ISSUE, revertPr: null, revertPrError: 'CONFLICT' }, { pr: 12 });
  assert.equal(noRevert.action, 'Rolled back, prod healthy. Revert PR could not be opened — revert #12 by hand or fix forward; close issue #50 after.');
  const noIssue = prodEvent({ outcome: 'recovered', mergeSha: 'abcdef0123', issue: null, issueError: 'HTTP 502', revertPr: REVERT }, { pr: 12 });
  assert.match(noIssue.action, /Rollback issue could not be confirmed — check whether merges are paused\./);
  assert.doesNotMatch(noIssue.action, /NOT paused|are paused\b(?!\.)/);
  const neither = prodEvent({ outcome: 'recovered', mergeSha: 'abcdef0123', issue: null, revertPr: null }, {});
  assert.match(neither.action, /revert abcdef0 by hand/);
  assert.match(neither.action, /could not be confirmed/);
});

test('prod urgent outcomes are priority 5; the other non-merged ones 4; never an issue link that does not exist', () => {
  for (const o of ['rollback-failed', 'changed-during-recovery', 'rollback-skipped']) {
    const e = prodEvent({ outcome: o, mergeSha: 'abc', issue: null }, { pr: 3 });
    assert.equal(e.priority, 5, o);
    assert.match(e.action, /Rollback issue could not be confirmed — check whether merges are paused\./);
    assert.equal(e.issueNumber, undefined);
    assert.ok(e.tag === 'rotating_light');
  }
  for (const o of ['superseded', 'not-live', 'deploy-failed', 'deploy-not-observed']) {
    const e = prodEvent({ outcome: o, mergeSha: 'abc', issue: ISSUE }, { pr: 3 });
    assert.equal(e.priority, 4, o);
    assert.match(e.action, /Issue #50/);
    assert.equal(e.issueNumber, 50);
    assert.equal(e.issueUrl, ISSUE.url);
  }
});

test('prod needs-owner (observe-only, ship resume): priority 5, says nothing was rolled back, no issue', () => {
  const e = prodEvent({ outcome: 'needs-owner', mergeSha: 'abc', issue: null }, { pr: 3 });
  assert.equal(e.event, 'prod-needs-owner');
  assert.equal(e.priority, 5);
  assert.equal(e.label, 'PRODUCTION FAILING');
  assert.match(e.action, /^Production fails the smoke after #3 and nothing was rolled back/);
  assert.doesNotMatch(e.action, /issue/i);
  // the resumed run's summary does not push it a second time
  assert.deepEqual(classifyOutcome('needs-owner'), { known: true, event: null });
});

test('prod no-production and unknown outcomes owe no push', () => {
  assert.equal(prodEvent({ outcome: 'no-production' }, { pr: 1 }), null);
  assert.equal(prodEvent({ outcome: 'weird' }, { pr: 1 }), null);
  assert.equal(prodEvent(undefined), null);
});

test('prod-unknown: the check could not finish', () => {
  const e = prodErrorEvent({ error: 'merge-sha-unresolved', reason: 'GitHub never named the merge commit', pr: 12 });
  assert.equal(e.event, 'prod-unknown');
  assert.equal(e.action, "Production check couldn't finish (GitHub never named the merge commit): check #12's deployment by hand");
  assert.equal(buildMessage(e, { repoName: 'r' }).priority, 4);
});

// ---- config ---------------------------------------------------------------------------------------------------------------

test('secrets file: literal assignments only (bare, quoted, export, comments, CRLF); expansion is rejected, never evaluated', () => {
  const m = parseSecrets([
    '# a comment', 'export NTFY_TOPIC=abc_DEF-1', "NTFY_SERVER='https://ntfy.example.com/pfx'  # trailing", 'NTFY_TOKEN="tk_x.y-z"\r',
    'OTHER=$(touch /tmp/pwned)', 'EXPANDED=$HOME/x', 'BACKTICK=`id`', 'ESC=a\\b', 'TWO=a b', 'SEMI=a;b', 'UNCLOSED="abc',
    'lower=ignored', 'EMPTY=',
  ].join('\n'));
  assert.equal(m.get('NTFY_TOPIC'), 'abc_DEF-1');
  assert.equal(m.get('NTFY_SERVER'), 'https://ntfy.example.com/pfx');
  assert.equal(m.get('NTFY_TOKEN'), 'tk_x.y-z');
  for (const k of ['OTHER', 'EXPANDED', 'BACKTICK', 'ESC', 'TWO', 'SEMI', 'UNCLOSED']) assert.equal(typeof m.get(k), 'symbol', `${k} must be rejected`);
  assert.equal(m.get('EMPTY'), '');
  assert.equal(m.has('lower'), false);
  assert.equal(existsSync('/tmp/pwned'), false);
});

test('config: topic from the file, default server, no token', () => {
  const r = rig();
  const cfg = loadNotifyConfig({ env: {}, secretsFile: r.deps.secretsFile });
  assert.deepEqual(cfg, { ok: true, topic: TOPIC, server: 'https://ntfy.sh', token: undefined });
});

test('config precedence is per field: the environment beats the file independently for topic, server and token', () => {
  const r = rig({ secrets: `NTFY_TOPIC=filetopic\nNTFY_SERVER=https://file.example.com\nNTFY_TOKEN=filetoken\n` });
  assert.deepEqual(
    loadNotifyConfig({ env: { NTFY_TOPIC: 'envtopic' }, secretsFile: r.deps.secretsFile }),
    { ok: true, topic: 'envtopic', server: 'https://file.example.com', token: 'filetoken' },
  );
  assert.deepEqual(
    loadNotifyConfig({ env: { NTFY_SERVER: 'http://localhost:8080', NTFY_TOKEN: 'envtoken' }, secretsFile: r.deps.secretsFile }),
    { ok: true, topic: 'filetopic', server: 'http://localhost:8080', token: 'envtoken' },
  );
});

test('a blank NTFY_SERVER is present-but-invalid: no send, never the default server (topic and token stay lenient)', () => {
  const a = rig({ secrets: 'NTFY_TOPIC=good\nNTFY_SERVER=\n' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: a.deps.secretsFile }), { ok: false, reason: 'invalid-config:server' });
  // A present (blank) env value wins and does not fall through to the valid file value.
  const b = rig({ secrets: 'NTFY_TOPIC=good\nNTFY_SERVER=https://file.example.com\n' });
  assert.deepEqual(loadNotifyConfig({ env: { NTFY_SERVER: '' }, secretsFile: b.deps.secretsFile }), { ok: false, reason: 'invalid-config:server' });
  // Only the server changed: a blank topic is still "no topic", a blank token still sends without a token.
  const c = rig({ secrets: 'NTFY_TOPIC=\n' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: c.deps.secretsFile }), { ok: false, reason: 'no-topic' });
  const d = rig({ secrets: 'NTFY_TOPIC=good\nNTFY_TOKEN=\n' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: d.deps.secretsFile }), { ok: true, topic: 'good', server: 'https://ntfy.sh', token: undefined });
});

test('PIPELINE_SECRETS_FILE overrides the secrets path', () => {
  const r = rig();
  assert.equal(loadNotifyConfig({ env: { PIPELINE_SECRETS_FILE: r.deps.secretsFile } }).topic, TOPIC);
});

test('hermetic: the test run points PIPELINE_SECRETS_FILE at a missing path and production honours it, so the real secrets file is never read', () => {
  const guard = process.env.PIPELINE_SECRETS_FILE;
  assert.ok(guard, 'PIPELINE_SECRETS_FILE is unset: run the tests through `node scripts/test.mjs` (it sets a non-existent path)');
  assert.notEqual(path.resolve(guard), path.resolve(DEFAULT_SECRETS_FILE));
  assert.equal(existsSync(guard), false, 'the guard path must not exist');
  // With the test env and no injected secretsFile, the file loadNotifyConfig tries to read is the guard path, never the default.
  const reads = [];
  loadNotifyConfig({ env: { ...process.env, PIPELINE_NOTIFY: undefined }, readFile: (f) => { reads.push(f); throw new Error('ENOENT'); } });
  assert.deepEqual(reads, [guard]);
});

test('an invalid field sends nothing and never falls back to another value', () => {
  const r = rig({ secrets: `NTFY_TOPIC=good\nNTFY_SERVER=http://evil.example.com\n` });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: r.deps.secretsFile }), { ok: false, reason: 'invalid-config:server' });
  // The env wins per field, but an invalid env value does not fall through to the valid file value.
  const s = rig({ secrets: 'NTFY_TOPIC=filegood\n' });
  assert.deepEqual(loadNotifyConfig({ env: { NTFY_TOPIC: 'bad topic!' }, secretsFile: s.deps.secretsFile }), { ok: false, reason: 'invalid-config:topic' });
  const t = rig({ secrets: 'NTFY_TOPIC=ok\nNTFY_TOKEN="has space"\n' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: t.deps.secretsFile }), { ok: false, reason: 'invalid-config:token' });
  const u = rig({ secrets: 'NTFY_TOPIC=$(whoami)\n' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: u.deps.secretsFile }), { ok: false, reason: 'invalid-config:topic' });
  for (const bad of ['ftp://x.example.com', 'https://user:pw@x.example.com', 'https://x.example.com/?a=1', 'not a url']) {
    assert.equal(loadNotifyConfig({ env: { NTFY_TOPIC: 't', NTFY_SERVER: bad }, secretsFile: path.join(r.dir, 'missing.sh') }).reason, 'invalid-config:server', bad);
  }
});

test('no topic anywhere is a silent no-op; PIPELINE_NOTIFY=off disables everything', async () => {
  const r = rig({ secrets: '' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: r.deps.secretsFile }), { ok: false, reason: 'no-topic' });
  assert.deepEqual(loadNotifyConfig({ env: {}, secretsFile: path.join(r.dir, 'missing.sh') }), { ok: false, reason: 'no-topic' });
  const off = rig({ env: { PIPELINE_NOTIFY: 'off' } });
  assert.deepEqual(loadNotifyConfig({ env: off.deps.env, secretsFile: off.deps.secretsFile }), { ok: false, reason: 'disabled' });
  const res = await notifyEvent(STOP, off.deps);
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(off.fetchCalls.length, 0);
  assert.equal(off.ledger(), '');
});

// ---- identity -------------------------------------------------------------------------------------------------------------

test('identity: a reworded action keeps the key; a new cause, ids, head, event or outcome changes it', () => {
  const base = { event: 'needs-human', pr: 4, outcome: 'needs-human', ids: ['b', 'a'], cause: 'final-gate:labels', action: 'first wording' };
  const ctx = { repo: 'acme/widgets', head: 'h1' };
  const k = eventKey(base, ctx);
  assert.equal(eventKey({ ...base, action: 'a totally different sentence' }, ctx), k);
  assert.equal(eventKey({ ...base, ids: ['a', 'b'] }, ctx), k, 'ids are sorted');
  assert.notEqual(eventKey({ ...base, cause: 'codex:quota' }, ctx), k);
  assert.notEqual(eventKey({ ...base, ids: ['a', 'b', 'c'] }, ctx), k);
  assert.notEqual(eventKey(base, { ...ctx, head: 'h2' }), k);
  assert.notEqual(eventKey({ ...base, event: 'arbiter-escalation' }, ctx), k);
  assert.notEqual(eventKey({ ...base, outcome: 'blocked' }, ctx), k);
  assert.notEqual(eventKey(base, { ...ctx, repo: 'acme/other' }), k);
  assert.match(k, /^[0-9a-f]{64}$/);
});

test('repo identity is owner/name from the local origin URL in every common form', () => {
  for (const url of ['git@github.com:acme/widgets.git', 'https://github.com/acme/widgets', 'https://github.com/acme/widgets.git', 'ssh://git@github.com/acme/widgets.git', 'https://x-access-token:t@github.com/acme/widgets.git/']) {
    assert.equal(parseRemote(url)?.slug, 'acme/widgets', url);
  }
  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote('garbage'), null);
});

test('the same event from two worktrees and with GitHub down shares one key (identity uses local git only)', async () => {
  const a = rig();
  const b = rig({ deps: { stateDir: a.deps.stateDir, cwd: tmp() } }); // same ledger, different worktree dir
  b.deps.secretsFile = a.deps.secretsFile;
  assert.equal((await notifyEvent({ ...STOP, title: undefined }, { ...a.deps, lookup: async () => { throw new Error('gh down'); } })).sent, true);
  const second = await notifyEvent({ ...STOP, title: 'Fix the thing' }, b.deps);
  assert.equal(second.reason, 'duplicate');
  assert.equal(a.fetchCalls.length + b.fetchCalls.length, 1);
});

// ---- ntfy request ---------------------------------------------------------------------------------------------------------

test('ntfy: JSON publish with topic, title, message, priority, tags, click and a view action; bearer token when set', async () => {
  const r = rig({ secrets: `NTFY_TOPIC=${TOPIC}\nNTFY_TOKEN=${TOKEN}\nNTFY_SERVER=https://ntfy.example.com/relay\n` });
  const res = await notifyEvent(STOP, r.deps);
  assert.equal(res.sent, true);
  assert.deepEqual(res.transports, { ntfy: 'sent', toast: 'n/a' });
  const [{ url, init, body }] = r.fetchCalls;
  assert.equal(url, 'https://ntfy.example.com/relay');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(body.topic, TOPIC);
  assert.equal(body.title, '[testbox] #12 Fix the thing');
  assert.equal(body.message, 'Run stopped: Read the PR: the run stopped (widgets)');
  assert.equal(body.priority, 4);
  assert.deepEqual(body.tags, ['octagonal_sign', 'widgets']);
  assert.equal(body.click, 'https://github.com/acme/widgets/pull/12');
  assert.deepEqual(body.actions, [{ action: 'view', label: 'Open', url: 'https://github.com/acme/widgets/pull/12' }]);
  assert.ok(init.signal instanceof AbortSignal);
});

test('no token means no Authorization header', async () => {
  const r = rig();
  await notifyEvent(STOP, r.deps);
  assert.equal(r.fetchCalls[0].init.headers.Authorization, undefined);
  assert.equal(r.fetchCalls[0].url, 'https://ntfy.sh');
});

test('prod issue artifact: the click opens the rollback issue; without one it opens the PR', async () => {
  const r = rig();
  await notifyEvent({ ...prodEvent({ outcome: 'rollback-failed', mergeSha: 'abc1234', issue: ISSUE }, { pr: 12 }), title: 'T' }, r.deps);
  assert.equal(r.fetchCalls[0].body.click, ISSUE.url);
  assert.equal(r.fetchCalls[0].body.priority, 5);
  const q = rig();
  await notifyEvent({ ...prodEvent({ outcome: 'rollback-failed', mergeSha: 'abc1234', issue: null }, { pr: 12 }), title: 'T' }, q.deps);
  assert.equal(q.fetchCalls[0].body.click, 'https://github.com/acme/widgets/pull/12');
});

test('title lookup: only when the caller has no title; a failed lookup still sends "#N"', async () => {
  const looked = [];
  const r = rig({ deps: { lookup: async (pr) => { looked.push(pr); return { title: 'From GitHub', url: 'https://github.com/acme/widgets/pull/12' }; } } });
  await notifyEvent({ ...STOP, title: undefined }, r.deps);
  assert.equal(r.fetchCalls[0].body.title, '[testbox] #12 From GitHub');
  const s = rig({ deps: { lookup: async (pr) => { looked.push(pr); return null; } } });
  await notifyEvent(STOP, s.deps);
  assert.equal(looked.length, 1, 'a passed title skips the lookup');
  const f = rig({ deps: { lookup: async () => { throw new Error('boom'); } } });
  const res = await notifyEvent({ ...STOP, title: undefined }, f.deps);
  assert.equal(res.sent, true);
  assert.equal(f.fetchCalls[0].body.title, '[testbox] #12');
});

test('an unknown event is not sent', async () => {
  const r = rig();
  assert.equal((await notifyEvent({ event: 'progress', pr: 1, action: 'x' }, r.deps)).reason, 'unknown-event');
  assert.equal((await notifyEvent(undefined, r.deps)).reason, 'unknown-event');
  assert.equal(r.fetchCalls.length, 0);
});

// ---- ledger ---------------------------------------------------------------------------------------------------------------

test('ledger: reserved then per-transport records, UTC ISO times, and no secret in it', async () => {
  const r = rig({ secrets: `NTFY_TOPIC=${TOPIC}\nNTFY_TOKEN=${TOKEN}\n` });
  await notifyEvent(STOP, r.deps);
  const recs = ledgerRecords(r.deps.stateDir);
  assert.deepEqual(recs.map((x) => [x.kind, x.status]), [['reserved', undefined], ['ntfy', 'sent']]);
  for (const x of recs) {
    assert.match(x.t, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(x.key, recs[0].key);
  }
  assert.ok(!r.ledger().includes(TOPIC) && !r.ledger().includes(TOKEN));
});

test('replaying the same event is a duplicate; a changed cause or head is a new push', async () => {
  const r = rig();
  assert.equal((await notifyEvent(STOP, r.deps)).sent, true);
  const again = await notifyEvent({ ...STOP, action: 'reworded retry' }, r.deps);
  assert.equal(again.sent, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal((await notifyEvent({ ...STOP, cause: 'codex:quota' }, r.deps)).sent, true);
  assert.equal((await notifyEvent({ ...STOP, head: 'newhead' }, r.deps)).sent, true);
  assert.equal(r.fetchCalls.length, 3);
});

test('a failed ntfy may be retried; an acknowledged one never is', async () => {
  let n = 0;
  const r = rig({ fetch: async () => (++n === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 }) });
  const first = await notifyEvent(STOP, r.deps);
  assert.equal(first.sent, false);
  assert.deepEqual(first.transports, { ntfy: 'failed', toast: 'n/a' });
  assert.equal(first.errors.ntfy, 'HTTP 503');
  assert.equal((await notifyEvent(STOP, r.deps)).sent, true);
  assert.equal((await notifyEvent(STOP, r.deps)).reason, 'duplicate');
  assert.equal(r.fetchCalls.length, 2);
});

test('reservations: a fresh one blocks (in flight); a stale one (crash mid-send) is retried', async () => {
  const r = rig();
  const T = Date.parse('2026-10-12T10:00:00Z');
  const now = () => T;
  mkdirSync(r.deps.stateDir, { recursive: true });
  const key = eventKey({ ...STOP }, { repo: 'acme/widgets', head: STOP.head });
  const put = (ageMs) => writeFileSync(path.join(r.deps.stateDir, LEDGER_NAME), `${JSON.stringify({ t: new Date(T - ageMs).toISOString(), key, kind: 'reserved' })}\n`);
  put(10_000);
  assert.equal((await notifyEvent(STOP, { ...r.deps, now })).reason, 'duplicate');
  assert.equal(r.fetchCalls.length, 0);
  put(3 * 60_000);
  assert.equal((await notifyEvent(STOP, { ...r.deps, now })).sent, true);
  assert.equal(r.fetchCalls.length, 1);
});

test('ntfy acknowledged + toast hung: the ntfy result is recorded on its own, and an identical retry sends no second ntfy', async () => {
  const sp = fakeSpawn({ hang: true });
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: sp, budget: { toastMs: 300 } } });
  const first = await notifyEvent(STOP, r.deps);
  assert.deepEqual(first.transports, { ntfy: 'sent', toast: 'failed' });
  assert.equal(first.sent, true);
  assert.equal(sp.calls[0].killed, 'SIGKILL');
  const kinds = ledgerRecords(r.deps.stateDir).map((x) => `${x.kind}:${x.status ?? ''}`);
  assert.deepEqual(kinds.sort(), ['ntfy:sent', 'reserved:', 'toast:failed']);
  assert.equal((await notifyEvent(STOP, r.deps)).reason, 'duplicate');
  assert.equal(r.fetchCalls.length, 1);
});

test('the hard cap answers while a toast is still hung; the already-acknowledged ntfy stays recorded', async () => {
  const sp = fakeSpawn({ hang: true });
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: sp, budget: { toastMs: 5000, capMs: 400 } } });
  const t0 = Date.now();
  const res = await notifyEvent(STOP, r.deps);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(res.reason, 'timeout');
  assert.equal(res.transports.ntfy, 'sent');
  assert.equal(sp.calls[0].killed, 'SIGKILL', 'the cap kills the toast child');
  assert.equal((await notifyEvent(STOP, r.deps)).reason, 'duplicate');
});

test('a corrupt ledger line is tolerated; records older than 90 days are pruned on rewrite', async () => {
  const r = rig();
  await notifyEvent(STOP, r.deps);
  appendFileSync(path.join(r.deps.stateDir, LEDGER_NAME), '{not json at all');
  assert.equal((await notifyEvent(STOP, r.deps)).reason, 'duplicate', 'a torn last line does not hide the sent record');
  const T = Date.now();
  const old = { t: new Date(T - 91 * 86_400_000).toISOString(), key: 'old', kind: 'ntfy', status: 'sent' };
  appendFileSync(path.join(r.deps.stateDir, LEDGER_NAME), `\n${JSON.stringify(old)}\n`);
  assert.equal((await notifyEvent({ ...STOP, cause: 'another' }, r.deps)).sent, true);
  const text = r.ledger();
  assert.ok(!text.includes('"key":"old"'), 'old record dropped');
  assert.ok(!text.includes('not json'), 'corrupt line dropped on rewrite');
  assert.equal(ledgerRecords(r.deps.stateDir).filter((x) => x.kind === 'ntfy').length, 2);
});

test('concurrent processes on the same event produce exactly one send', async () => {
  const r = rig();
  const countFile = path.join(r.dir, 'sends.txt');
  const go = path.join(r.dir, 'go');
  const kids = [0, 1, 2].map(() => spawn(process.execPath, [SEND_FIXTURE, r.deps.stateDir, r.deps.secretsFile, countFile, '600', '--go', go], { stdio: ['ignore', 'pipe', 'inherit'] }));
  try {
    const outs = kids.map((k) => {
      let buf = '';
      k.stdout.on('data', (c) => { buf += c; });
      return { done: new Promise((res) => k.on('close', () => res(buf))), buf: () => buf };
    });
    while (!outs.every((o) => o.buf().includes('ready'))) await sleep(20);
    writeFileSync(go, 'go');
    const results = (await Promise.all(outs.map((o) => o.done))).map((b) => JSON.parse(b.trim().split('\n').pop()));
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 1, 'one ntfy send');
    assert.equal(results.filter((x) => x.sent).length, 1);
    assert.equal(results.filter((x) => x.reason === 'duplicate').length, 2);
  } finally {
    // The fixture spins until `go` exists: never leave one running if an assertion failed first.
    writeFileSync(go, 'go');
    for (const k of kids) k.kill('SIGKILL');
    await Promise.all(kids.map(exited));
    for (const k of kids) assert.ok(k.exitCode !== null || k.signalCode !== null, 'the racing child has exited');
  }
});

test('a lock held by another process: still sends within the budget, and says the ledger was bypassed', async () => {
  const r = rig();
  const lockDir = path.join(r.deps.stateDir, 'locks');
  mkdirSync(lockDir, { recursive: true });
  const release = path.join(r.dir, 'release');
  const holder = spawn(process.execPath, [HOLD_FIXTURE, lockDir, 'notify-ledger', '20000', '--release', release], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res) => holder.stdout.once('data', res));
    const t0 = Date.now();
    const res = await notifyEvent(STOP, { ...r.deps, budget: { lockMs: 400 } });
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(res.sent, true);
    assert.equal(res.ledger === 'unlocked' || res.ledger === 'unrecorded', true);
    assert.equal(r.fetchCalls.length, 1);
  } finally {
    writeFileSync(release, '');
    await exited(holder);
    assert.ok(holder.exitCode !== null || holder.signalCode !== null, 'the lock holder has exited');
  }
});

// ---- slow-network tolerance: one retry, raised happy-eyeballs timeout ------------------------------------------------------

const netFail = () => new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });

test('ntfy: a network-level failure is retried once inside the budget; the ledger records one outcome', async () => {
  let n = 0;
  const r = rig({ fetch: async () => { if (++n === 1) throw netFail(); return { ok: true, status: 200 }; } });
  const res = await notifyEvent(STOP, r.deps);
  assert.equal(res.sent, true);
  assert.equal(res.transports.ntfy, 'sent');
  assert.equal(r.fetchCalls.length, 2);
  assert.equal(ledgerRecords(r.deps.stateDir).filter((x) => x.kind === 'ntfy').length, 1);
});

test('ntfy: two network failures in a row fail after exactly two attempts', async () => {
  const r = rig({ fetch: async () => { throw netFail(); } });
  const res = await notifyEvent(STOP, r.deps);
  assert.equal(res.transports.ntfy, 'failed');
  assert.equal(res.errors.ntfy, 'fetch failed');
  assert.equal(r.fetchCalls.length, 2);
});

test('ntfy: an HTTP error response is final, never retried', async () => {
  const r = rig({ fetch: async () => ({ ok: false, status: 500 }) });
  const res = await notifyEvent(STOP, r.deps);
  assert.equal(res.errors.ntfy, 'HTTP 500');
  assert.equal(r.fetchCalls.length, 1);
});

test('ntfy: no retry when too little of the budget is left', async () => {
  const r = rig({ fetch: async () => { throw netFail(); } });
  const res = await notifyEvent(STOP, { ...r.deps, budget: { ntfyMs: 500 } });
  assert.equal(res.transports.ntfy, 'failed');
  assert.equal(r.fetchCalls.length, 1);
});

test('ntfy: a hung fetch is aborted at the budget and not attempted again', async () => {
  const r = rig({ fetch: () => new Promise(() => {}) });
  const res = await notifyEvent(STOP, { ...r.deps, budget: { ntfyMs: 1500 } });
  assert.equal(res.errors.ntfy, 'timed out');
  assert.equal(r.fetchCalls.length, 1);
});

test('ntfy: a failure that comes after the budget aborted the request is not retried', async () => {
  const r = rig({ fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const res = await notifyEvent(STOP, { ...r.deps, budget: { ntfyMs: 1500 } });
  assert.equal(res.transports.ntfy, 'failed');
  assert.equal(r.fetchCalls.length, 1);
});

test('raiseAutoSelectFamilyTimeout: raises a lower value, leaves a higher one alone, no-ops without the API', () => {
  let cur = 250;
  const set = (v) => { cur = v; };
  assert.equal(raiseAutoSelectFamilyTimeout({ get: () => cur, set }), true);
  assert.equal(cur, 2500);
  cur = 4000;
  assert.equal(raiseAutoSelectFamilyTimeout({ get: () => cur, set }), false);
  assert.equal(cur, 4000);
  cur = 2500;
  assert.equal(raiseAutoSelectFamilyTimeout({ get: () => cur, set }), false);
  assert.equal(raiseAutoSelectFamilyTimeout({ get: null, set }), false);
  assert.equal(raiseAutoSelectFamilyTimeout({ get: () => cur, set: null }), false);
  assert.equal(cur, 2500);
});

// ---- budget ---------------------------------------------------------------------------------------------------------------

test('a hung fetch is aborted at the ntfy timeout (even one that ignores the signal)', async () => {
  let signal;
  const r = rig({ fetch: (url, init) => { signal = init.signal; return new Promise(() => {}); } });
  const t0 = Date.now();
  const res = await notifyEvent(STOP, { ...r.deps, budget: { ntfyMs: 250 } });
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(res.transports, { ntfy: 'failed', toast: 'n/a' });
  assert.equal(res.errors.ntfy, 'timed out');
  assert.equal(signal.aborted, true);
});

test('a hung gh title lookup is killed at the lookup budget and the push still goes out with #N', async () => {
  const dir = tmp();
  const pidFile = path.join(dir, 'gh.pid');
  const script = path.join(dir, 'fakegh.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 60000);\n`);
  const r = rig({ realLookup: true, env: { PIPELINE_GH: `"${process.execPath}" "${script}"` } });
  let pid = null;
  try {
    // Monotonic clock on purpose: the wall clock (Date.now) steps on a WSL2 host (measured here: a 570 ms backwards step within 20 s),
    // which once made a correct 2016 ms lookup read as 1513 ms and fail the lower bound. The timers under test are monotonic too.
    const t0 = performance.now();
    // The lookup's own kill fires at 2000 ms (lookupMs minus the slack); the outer race at 2500 ms.
    const res = await notifyEvent({ ...STOP, title: undefined }, { ...r.deps, budget: { lookupMs: 2500 } });
    const took = performance.now() - t0;
    assert.equal(res.sent, true);
    assert.ok(took >= 1900 && took < 6000, `took ${Math.round(took)} ms`); // 100 ms under the kill timer: timer rounding only
    assert.equal(r.fetchCalls[0].body.title, '[testbox] #12');
    // Positive evidence that the real lookup launched the fixture: the pid file must appear.
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await sleep(50);
    assert.ok(existsSync(pidFile), 'the lookup never started the fake gh');
    pid = Number(readFileSync(pidFile, 'utf8'));
    // The lookup's cwd is the rig dir: the killed process must be gone before the test ends, or Windows cannot delete the dir.
    for (let i = 0; i < 100 && isPidAlive(pid); i++) await sleep(50);
    assert.equal(isPidAlive(pid), false, 'the hung gh was killed');
  } finally {
    if (pid === null && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid !== null && isPidAlive(pid)) {
      killTree(pid);
      for (let i = 0; i < 100 && isPidAlive(pid); i++) await sleep(50);
    }
  }
});

// ---- toast ----------------------------------------------------------------------------------------------------------------

test('WSL detection: WSL_DISTRO_NAME, or "microsoft" in /proc/version; nothing else', () => {
  assert.equal(detectWsl({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, readFile: () => { throw new Error('x'); } }), true);
  assert.equal(detectWsl({ env: {}, readFile: () => 'Linux version 6.18.33.2-microsoft-standard-WSL2 (root@x)' }), true);
  assert.equal(detectWsl({ env: {}, readFile: () => 'Linux version 6.1.0-generic (buildd@x)' }), false);
  assert.equal(detectWsl({ env: {}, readFile: () => { throw new Error('ENOENT'); } }), false);
});

test('toast runs only under WSL with powershell.exe resolvable', async () => {
  for (const [wsl, ps] of [[false, true], [true, false], [false, false]]) {
    const sp = fakeSpawn();
    const r = rig({ deps: { isWsl: () => wsl, hasPowershell: () => ps, spawn: sp } });
    const res = await notifyEvent(STOP, r.deps);
    assert.equal(res.transports.toast, 'n/a');
    assert.equal(sp.calls.length, 0);
  }
});

test('toast: powershell.exe -EncodedCommand <constant script>, data as base64 UTF-8 JSON on stdin', async () => {
  const sp = fakeSpawn();
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: sp } });
  const res = await notifyEvent(STOP, r.deps);
  assert.deepEqual(res.transports, { ntfy: 'sent', toast: 'sent' });
  const [call] = sp.calls;
  assert.equal(call.file, 'powershell.exe');
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(call.args.length, 4);
  assert.equal(Buffer.from(call.args[3], 'base64').toString('utf16le'), TOAST_SCRIPT);
  assert.equal(call.args[3], encodeToastScript());
  const payload = JSON.parse(Buffer.from(call.stdin, 'base64').toString('utf8'));
  assert.deepEqual(payload, { title: '[PC] #12 Fix the thing', body: 'Run stopped: Read the PR: the run stopped (widgets)', url: 'https://github.com/acme/widgets/pull/12' });
  assert.ok(TOAST_SCRIPT.includes(TOAST_AUMID));
  assert.ok(TOAST_SCRIPT.includes('[Console]::In.ReadToEnd()'));
  assert.ok(TOAST_SCRIPT.includes('[System.Security.SecurityElement]::Escape'));
  assert.ok(TOAST_SCRIPT.includes('activationType="protocol"') && TOAST_SCRIPT.includes('launch="'));
  assert.equal(TOAST_AUMID, '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('a hostile title never reaches the PowerShell source or the arguments', async () => {
  const hostile = 'x"; $(calc.exe) `whoami` \'$env:USERNAME\' </text><script>';
  const sp = fakeSpawn();
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: sp } });
  await notifyEvent({ ...STOP, title: hostile }, r.deps);
  const [call] = sp.calls;
  const decoded = Buffer.from(call.args[3], 'base64').toString('utf16le');
  assert.equal(decoded, TOAST_SCRIPT);
  assert.ok(!decoded.includes('calc.exe') && !decoded.includes('whoami'));
  assert.ok(!call.args.join(' ').includes('calc.exe'));
  assert.ok(JSON.parse(Buffer.from(call.stdin, 'base64').toString('utf8')).title.includes('$(calc.exe)'), 'the data travels on stdin');
});

test('a toast that exits non-zero is failed but does not stop ntfy or cause a resend', async () => {
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: fakeSpawn({ code: 1 }) } });
  const res = await notifyEvent(STOP, r.deps);
  assert.deepEqual(res.transports, { ntfy: 'sent', toast: 'failed' });
  assert.equal(res.sent, true);
  assert.equal((await notifyEvent(STOP, r.deps)).reason, 'duplicate');
});

// ---- confidentiality ------------------------------------------------------------------------------------------------------

test('the topic and token never appear in the result, stderr, or the ledger, even when fetch throws an error echoing the URL', async () => {
  const r = rig({
    secrets: `NTFY_TOPIC=${TOPIC}\nNTFY_TOKEN=${TOKEN}\nNTFY_SERVER=https://ntfy.example.com/private-path\n`,
    fetch: async (url) => { throw new Error(`request to ${url}/${TOPIC} failed (Authorization: Bearer ${TOKEN}) path /private-path`); },
  });
  const written = [];
  const orig = process.stderr.write;
  process.stderr.write = (c, ...rest) => { written.push(String(c)); return orig.call(process.stderr, c, ...rest); };
  let res;
  try {
    res = await notifyEvent(STOP, r.deps);
  } finally {
    process.stderr.write = orig;
  }
  const all = JSON.stringify(res) + written.join('') + r.ledger();
  assert.equal(res.sent, false);
  assert.equal(res.transports.ntfy, 'failed');
  for (const secret of [TOPIC, TOKEN, '/private-path']) assert.ok(!all.includes(secret), `leaked ${secret}`);
  assert.match(res.errors.ntfy, /\*\*\*/);
  const s = scrubber({ topic: 'tt', token: 'kk', server: 'https://h.example/p' });
  assert.equal(s('tt kk https://h.example/p /p'), '*** *** *** ***');
});

test('the toast error text is scrubbed too', async () => {
  const sp = (file, args, opts) => { throw new Error(`cannot start for ${TOPIC}`); };
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: sp } });
  const res = await notifyEvent(STOP, r.deps);
  assert.equal(res.transports.toast, 'failed');
  assert.ok(!JSON.stringify(res).includes(TOPIC));
});

// ---- command --------------------------------------------------------------------------------------------------------------

test('notify --test sends one real push to all transports and is never deduplicated', async () => {
  const sp = fakeSpawn();
  const r = rig({ deps: { isWsl: () => true, hasPowershell: () => true, spawn: sp } });
  const ctx = { cwd: r.dir, env: {}, notifyDeps: r.deps };
  const a = await notifyCommand(['--test'], ctx);
  await sleep(5);
  const b = await notifyCommand(['--test'], ctx);
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  assert.deepEqual(a.output.transports, { ntfy: 'sent', toast: 'sent' });
  assert.equal(r.fetchCalls.length, 2);
  assert.equal(r.fetchCalls[0].body.title, '[PC] Pipeline notify test');
  assert.notEqual(testEvent(1).cause, testEvent(2).cause);
});

test('notify --test exits 1 when nothing could be sent, with the reason', async () => {
  const r = rig({ secrets: '' });
  const res = await notifyCommand(['--test'], { cwd: r.dir, env: {}, notifyDeps: r.deps });
  assert.equal(res.exitCode, 1);
  assert.equal(res.output.ok, false);
  assert.equal(res.output.reason, 'no-topic');
});

test('notify --event stopped --pr N --action TEXT [--cause CODE]: one push, replays are duplicates, exit stays 0', async () => {
  const r = rig();
  const ctx = { cwd: r.dir, env: {}, notifyDeps: r.deps };
  const argv = ['--event', 'stopped', '--pr', '33', '--action', 'Read the blocked comment', '--cause', 'verify-red'];
  const a = await notifyCommand(argv, ctx);
  assert.equal(a.exitCode, 0);
  assert.equal(a.output.ok, true);
  assert.equal(a.output.sent, true);
  assert.equal(r.fetchCalls[0].body.message, 'Run stopped: Read the blocked comment (widgets)');
  assert.equal(r.fetchCalls[0].body.title, '[testbox] #33');
  const b = await notifyCommand(argv, ctx);
  assert.equal(b.exitCode, 0);
  assert.equal(b.output.reason, 'duplicate');
  assert.equal(r.fetchCalls.length, 1);
});

test('notify with PIPELINE_NOTIFY=off reports disabled and exits 0', async () => {
  const res = await notifyCommand(['--event', 'stopped', '--pr', '1', '--action', 'x'], { cwd: os.tmpdir(), env: { PIPELINE_NOTIFY: 'off', PIPELINE_SECRETS_FILE: path.join(os.tmpdir(), 'pipeline-tests-missing', 'secrets.sh') } });
  assert.equal(res.exitCode, 0);
  assert.equal(res.output.reason, 'disabled');
});

test('notify usage errors', async () => {
  const ctx = { cwd: os.tmpdir(), env: { PIPELINE_NOTIFY: 'off', PIPELINE_SECRETS_FILE: path.join(os.tmpdir(), 'pipeline-tests-missing', 'secrets.sh') } };
  await assert.rejects(notifyCommand([], ctx), UsageError);
  await assert.rejects(notifyCommand(['--test', '--event', 'stopped'], ctx), UsageError);
  await assert.rejects(notifyCommand(['--event', 'stopped', '--pr', '1'], ctx), UsageError);
  await assert.rejects(notifyCommand(['--event', 'stopped', '--action', 'x'], ctx), UsageError);
  await assert.rejects(notifyCommand(['--event', 'progress', '--pr', '1', '--action', 'x'], ctx), UsageError);
  await assert.rejects(notifyCommand(['--event', 'stopped', '--pr', '1', '--action', 'x', '--cause', 'bad cause!'], ctx), UsageError);
  await assert.rejects(notifyCommand(['--bogus'], ctx), UsageError);
});

test('the dispatcher knows notify: --help prints its usage', () => {
  const r = spawnSync(process.execPath, [BIN, 'notify', '--help'], { encoding: 'utf8', env: { ...process.env, PIPELINE_NOTIFY: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).usage, /^pipeline notify --test/);
});
