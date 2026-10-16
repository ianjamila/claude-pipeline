import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, utimesSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { resolveCanonicalRoot, listCandidates, entriesFor, walkTree, defaultTranscriptDirs, checkAncestry, processesInside, transcriptMentions, memoryMentions, recentFiles } from '../pipeline/lib/worktree-prune/inspect.mjs';

function world() {
  const repo = createTmpRepo();
  repo.write('a.txt', 'a\n'); repo.write('.gitignore', 'node_modules/\n.review/\n*.log\n.env*\nnotes.txt\n'); repo.commit('init');
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  repo.git(['init', '--bare', '-q', origin]);
  repo.git(['remote', 'add', 'origin', origin]);
  repo.git(['push', '-q', 'origin', 'main']);
  mkdirSync(join(repo.dir, '.worktrees'));
  const add = (slug, branch) => { repo.git(['worktree', 'add', '-q', '-b', branch, join('.worktrees', slug), 'main']); return join(repo.dir, '.worktrees', slug); };
  return { repo, origin, add };
}

test('canonical root is the main worktree from anywhere', () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  const a = resolveCanonicalRoot(repo.dir);
  const b = resolveCanonicalRoot(wt);
  assert.equal(a.root, b.root);
  assert.equal(a.commonDir, b.commonDir);
  assert.equal(realpathSync(a.root), realpathSync(repo.dir));
});

test('listCandidates: direct children of worktree_dir only; protect, locked, detached skipped', () => {
  const { repo, add } = world();
  add('agent-x', 'agent/x'); add('foundation', 'f'); add('ops.stack', 's'); const d = add('det', 'd');
  repo.git(['-C', d, 'checkout', '-q', '--detach']);
  const l = add('locked-one', 'l'); repo.git(['worktree', 'lock', '--reason', 'owner', l]);
  const { candidates, skipped } = listCandidates(repo.dir, { worktreeDir: '.worktrees', protect: ['foundation', '*.stack'] });
  assert.deepEqual(candidates.map((c) => c.slug), ['agent-x']);
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.slug, s.reason])), {
    foundation: 'protected', 'ops.stack': 'protected', det: 'detached HEAD', 'locked-one': 'locked (owner)',
  });
});

test('entriesFor: untracked, ignored files listed per file; symlink flagged', () => {
  const { add } = world();
  const wt = add('agent-x', 'agent/x');
  mkdirSync(join(wt, 'node_modules', 'p'), { recursive: true }); writeFileSync(join(wt, 'node_modules', 'p', 'i.js'), '');
  writeFileSync(join(wt, 'new.ts'), ''); writeFileSync(join(wt, 'notes.txt'), '');
  const e = Object.fromEntries(entriesFor(wt).map((x) => [x.path, x.kind]));
  assert.equal(e['node_modules/p/i.js'], 'ignored');
  assert.equal(e['new.ts'], 'untracked');
  assert.equal(e['notes.txt'], 'ignored');
});

test('checkAncestry: behind the merged head is fine, local-only commit is not, sha mismatch is not', () => {
  const { repo, add } = world();
  const wt = add('agent-x', 'agent/x');
  writeFileSync(join(wt, 'b.txt'), 'b'); repo.git(['-C', wt, 'add', 'b.txt']); repo.git(['-C', wt, 'commit', '-qm', 'b']);
  const local = repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim();
  writeFileSync(join(wt, 'c.txt'), 'c'); repo.git(['-C', wt, 'add', 'c.txt']); repo.git(['-C', wt, 'commit', '-qm', 'c']);
  const prHead = repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim();
  repo.git(['-C', wt, 'push', '-q', 'origin', `HEAD:refs/pull/9/head`]);
  repo.git(['-C', wt, 'reset', '-q', '--hard', local]);
  assert.deepEqual(checkAncestry(repo.dir, { head: local, pr: { number: 9, headRefOid: prHead } }), { ok: true });
  assert.match(checkAncestry(repo.dir, { head: local, pr: { number: 9, headRefOid: 'f'.repeat(40) } }).reason, /does not match/);
  writeFileSync(join(wt, 'd.txt'), 'd'); repo.git(['-C', wt, 'add', 'd.txt']); repo.git(['-C', wt, 'commit', '-qm', 'local only']);
  const ahead = repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim();
  assert.match(checkAncestry(repo.dir, { head: ahead, pr: { number: 9, headRefOid: prHead } }).reason, /commits that are not in PR #9/);
  assert.match(checkAncestry(repo.dir, { head: local, pr: { number: 404, headRefOid: prHead } }).reason, /could not fetch PR #404/);
  assert.equal(repo.git(['for-each-ref', 'refs/pipeline-prune']), '', 'the temporary ref is always removed');
});

test('processesInside: fake /proc tree; non-linux is unavailable', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const target = mkdtempSync(join(tmpdir(), 'wt-'));
  mkdirSync(join(proc, '101', 'fd'), { recursive: true });
  mkdirSync(join(proc, '202', 'fd'), { recursive: true });
  symlinkSync(target, join(proc, '101', 'cwd'));
  symlinkSync(tmpdir(), join(proc, '202', 'cwd'));
  symlinkSync(join(target, 'x.log'), join(proc, '202', 'fd', '3'));
  assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'linux' }), { available: true, pids: [101, 202], hidden: 0 });
  assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'win32' }), { available: false, pids: [], hidden: 0 });
  assert.deepEqual(processesInside(target, { procRoot: join(proc, 'missing'), platform: 'linux' }), { available: false, pids: [], hidden: 0 });
});

test('transcriptMentions / memoryMentions / recentFiles', () => {
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj')); writeFileSync(join(t, 'proj', 's1.jsonl'), '{"cwd":"/r/.worktrees/agent-x"}\n');
  writeFileSync(join(t, 'proj', 'old.jsonl'), '/r/.worktrees/agent-x'); utimesSync(join(t, 'proj', 'old.jsonl'), 1, 1);
  assert.deepEqual(transcriptMentions(['/r/.worktrees/agent-x'], { dirs: [t], sinceMs: Date.now() - 3600e3 }).map((p) => p.endsWith('s1.jsonl')), [true]);
  const m = mkdtempSync(join(tmpdir(), 'mem-'));
  mkdirSync(join(m, 'eaglewatch')); mkdirSync(join(m, 'archive'));
  writeFileSync(join(m, 'eaglewatch', 'a.md'), 'agent-x is BUILDING phase 2\n');
  writeFileSync(join(m, 'eaglewatch', 'b.md'), 'agent-x merged long ago\n');
  writeFileSync(join(m, 'archive', 'c.md'), 'agent-x BUILDING\n');
  writeFileSync(join(m, 'eaglewatch', 'MEMORY-archive.md'), 'agent-x BUILDING\n');
  assert.deepEqual(memoryMentions({ slug: 'agent-x', branch: 'agent/x' }, { dirs: [m] }).map((p) => p.endsWith('a.md')), [true]);
  const walk = [{ path: 'src/a.ts', isDir: false, mtimeMs: Date.now() }, { path: 'node_modules/x', isDir: false, mtimeMs: Date.now() }, { path: 'old.ts', isDir: false, mtimeMs: 1 }];
  assert.deepEqual(recentFiles(walk, { sinceMs: Date.now() - 3600e3, ignore: ['node_modules/'] }), ['src/a.ts']);
});

test('entriesFor flags a symlink and walkTree does not follow it', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const { add } = world();
  const wt = add('agent-x', 'agent/x');
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), '');
  symlinkSync(outside, join(wt, 'link'));
  const e = Object.fromEntries(entriesFor(wt).map((x) => [x.path, x]));
  assert.equal(e.link.isSymlink, true);
  assert.equal(e.link.kind, 'untracked');
  assert.deepEqual(walkTree(wt).map((w) => w.path).filter((p) => p.startsWith('link')), ['link']);
});

test('transcriptMentions finds a needle that straddles the 1 MiB chunk seam', () => {
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj'));
  const needle = '/r/.worktrees/agent-x';
  writeFileSync(join(t, 'proj', 's.jsonl'), Buffer.concat([Buffer.alloc((1 << 20) - 5, 'a'), Buffer.from(needle)]));
  assert.equal(transcriptMentions([needle], { dirs: [t], sinceMs: 0 }).length, 1);
  assert.deepEqual(transcriptMentions(['/r/.worktrees/other'], { dirs: [t], sinceMs: 0 }), []);
});

test('defaultTranscriptDirs: CLAUDE_CONFIG_DIR plus ~/.claude*/projects, existing and de-duplicated', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(join(home, '.claude-ew', 'projects'), { recursive: true });
  mkdirSync(join(home, '.claude-empty'));
  const dirs = defaultTranscriptDirs(home, { CLAUDE_CONFIG_DIR: join(home, '.claude') });
  assert.deepEqual(dirs, [join(home, '.claude', 'projects'), join(home, '.claude-ew', 'projects')]);
});

test('an unreadable directory is a blocker, never an empty one', { skip: (process.platform === 'win32' && 'chmod 000 is not enforced on Windows') || (process.getuid?.() === 0 && 'root can read any directory') }, () => {
  const { add } = world();
  const wt = add('agent-x', 'agent/x');
  const secret = join(wt, 'node_modules', 'locked');
  mkdirSync(secret, { recursive: true }); writeFileSync(join(secret, 'hidden.js'), '');
  chmodSync(secret, 0o000);
  try {
    const walk = walkTree(wt);
    assert.ok(walk.some((w) => w.path === 'node_modules/locked' && w.unreadable === true));
    const e = entriesFor(wt).find((x) => x.path === 'node_modules/locked');
    assert.equal(e?.kind, 'tracked-change');
    assert.deepEqual(recentFiles(walk, { sinceMs: Date.now() - 3600e3, ignore: [] }).filter((p) => p === 'node_modules/locked'), ['node_modules/locked']);
  } finally {
    chmodSync(secret, 0o700);
  }
});

test('processesInside matches a worktree reached through a symlinked path', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  const via = join(mkdtempSync(join(tmpdir(), 'lnk-')), 'wt-link');
  symlinkSync(real, via);
  mkdirSync(join(proc, '303', 'fd'), { recursive: true });
  symlinkSync(real, join(proc, '303', 'cwd'));
  assert.deepEqual(processesInside(via, { procRoot: proc, platform: 'linux' }), { available: true, pids: [303], hidden: 0 });
});

test('processesInside ignores non-path fd targets (socket:[N], anon_inode:…) even with cwd inside the worktree', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const target = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  mkdirSync(join(proc, '404', 'fd'), { recursive: true });
  mkdirSync(join(proc, '505', 'fd'), { recursive: true });
  symlinkSync('socket:[1]', join(proc, '404', 'fd', '3'));
  symlinkSync('anon_inode:[eventfd]', join(proc, '404', 'fd', '4'));
  symlinkSync('pipe:[7]', join(proc, '404', 'fd', '5'));
  symlinkSync(`${target} (deleted)`, join(proc, '505', 'cwd'));
  const before = process.cwd();
  try {
    process.chdir(target);
    assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'linux' }), { available: true, pids: [505], hidden: 0 });
  } finally {
    process.chdir(before);
  }
});

test('transcriptMentions counts an unreadable recent transcript as a hit (fail-closed)', { skip: (process.platform === 'win32' && 'chmod 000 is not enforced on Windows') || (process.getuid?.() === 0 && 'root can read any file') }, () => {
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj'));
  const locked = join(t, 'proj', 'locked.jsonl');
  writeFileSync(locked, 'nothing relevant\n');
  writeFileSync(join(t, 'proj', 'old-locked.jsonl'), ''); utimesSync(join(t, 'proj', 'old-locked.jsonl'), 1, 1);
  chmodSync(locked, 0o000); chmodSync(join(t, 'proj', 'old-locked.jsonl'), 0o000);
  try {
    assert.deepEqual(transcriptMentions(['/r/.worktrees/agent-x'], { dirs: [t], sinceMs: Date.now() - 3600e3 }), [locked]);
  } finally {
    chmodSync(locked, 0o600); chmodSync(join(t, 'proj', 'old-locked.jsonl'), 0o600);
  }
});

// Another user's process: its /proc/<pid> links cannot be read (EACCES). It is counted as hidden, never as "inside",
// and never makes process inspection unavailable (every non-root user sees root daemons this way).
test('processesInside counts an unreadable process as hidden; a vanished one is just gone', { skip: (process.platform === 'win32' && 'chmod 000 is not enforced on Windows') || (process.getuid?.() === 0 && 'root can read any directory') }, () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const target = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  mkdirSync(join(proc, '606', 'fd'), { recursive: true });
  symlinkSync(target, join(proc, '606', 'cwd'));
  chmodSync(join(proc, '606'), 0o000);
  mkdirSync(join(proc, '707')); // exited between the listing and the read: no cwd, no fd (ENOENT)
  try {
    assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'linux' }), { available: true, pids: [], hidden: 1 });
  } finally {
    chmodSync(join(proc, '606'), 0o700);
  }
});

// spec §5: a pipeline-keep lock older than 7 days is reported as a stale keep ("still needed?"), never released. Its age
// is the mtime of the worktree's own `locked` file, found through the `.git` file's gitdir line: a second worktree with
// the same basename makes git suffix the admin dir's id, so guessing <commonDir>/worktrees/<slug> would read the wrong one.
test('listCandidates: a pipeline-keep lock older than 7 days is a stale keep; a fresh one and an owner lock stay plain locked', () => {
  const { repo, add } = world();
  mkdirSync(join(repo.dir, 'elsewhere'));
  repo.git(['worktree', 'add', '-q', '-b', 'decoy', join('elsewhere', 'old'), 'main']);
  const fresh = add('fresh', 'fr');
  const old = add('old', 'ol');
  const owner = add('owner-old', 'oo');
  repo.git(['worktree', 'lock', '--reason', 'pipeline-keep: ship run a', fresh]);
  repo.git(['worktree', 'lock', '--reason', 'pipeline-keep: ship run b', old]);
  repo.git(['worktree', 'lock', '--reason', 'owner', owner]);
  const adminDir = (wt) => resolve(wt, /^gitdir: (.*)$/m.exec(readFileSync(join(wt, '.git'), 'utf8'))[1].trim());
  assert.notEqual(adminDir(old), join(realpathSync(join(repo.dir, '.git')), 'worktrees', 'old'), 'the decoy took the plain id');
  const past = (Date.now() - 8 * 86400e3) / 1000;
  utimesSync(join(adminDir(old), 'locked'), past, past);
  utimesSync(join(adminDir(owner), 'locked'), past, past);
  const { skipped } = listCandidates(repo.dir, { worktreeDir: '.worktrees', protect: [] });
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.slug, s.reason])), {
    fresh: 'locked (pipeline-keep: ship run a)',
    old: 'stale keep (8d: ship run b) — still needed?',
    'owner-old': 'locked (owner)',
  });
  assert.match(repo.git(['worktree', 'list', '--porcelain']), /locked pipeline-keep: ship run b/, 'never released');
});

// spec §4 rule 6: only a session WORKING in the worktree counts (its cwd, or a tool call naming the path), never a
// listing that merely prints it (`git worktree list`, `ship inbox`) or prose about it.
test('transcriptMentions: cwd inside or a tool_use input naming the path count; tool results and prose do not', () => {
  const p = '/r/.worktrees/agent-x';
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj'));
  const file = (name, lines) => { writeFileSync(join(t, 'proj', name), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); return join(t, 'proj', name); };
  const result = file('result.jsonl', [{ type: 'user', cwd: '/r', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: `${p}  abc1234 [agent/x]\n/r/.worktrees/other` }] } }]);
  const prose = file('prose.jsonl', [{ type: 'assistant', cwd: '/r', message: { content: [{ type: 'text', text: `I will look at ${p} later` }] } }, { type: 'user', cwd: '/r', message: { content: `clean up ${p}` } }]);
  const sibling = file('sibling.jsonl', [{ type: 'user', cwd: `${p}2`, message: { content: 'hi' } }]);
  const toolUse = file('tool-use.jsonl', [{ type: 'user', cwd: '/r' }, { type: 'assistant', cwd: '/r', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cd ${p} && npm test` } }] } }]);
  const cwd = file('cwd.jsonl', [{ type: 'user', cwd: `${p}/src`, message: { content: 'hi' } }]);
  const garbage = file('garbage.jsonl', [{ type: 'user', cwd: '/r' }, `{"truncated": "${p}`]);
  const hits = transcriptMentions([p], { dirs: [t], sinceMs: Date.now() - 3600e3 }).sort();
  assert.deepEqual(hits, [cwd, garbage, toolUse].sort());
  assert.ok(![result, prose, sibling].some((f) => hits.includes(f)));
});

test('transcriptMentions judges a JSON line that spans the 1 MiB chunk seam as one line', () => {
  const p = '/r/.worktrees/agent-x';
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj'));
  const pad = JSON.stringify({ type: 'user', cwd: '/r', message: { content: 'a'.repeat((1 << 20) - 60) } });
  const use = JSON.stringify({ type: 'assistant', cwd: '/r', message: { content: [{ type: 'tool_use', input: { command: `ls ${p}` } }] } });
  const res = JSON.stringify({ type: 'user', cwd: '/r', message: { content: [{ type: 'tool_result', content: `ls ${p}` }] } });
  writeFileSync(join(t, 'proj', 'use.jsonl'), `${pad}\n${use}\n`);
  writeFileSync(join(t, 'proj', 'res.jsonl'), `${pad}\n${res}\n`);
  assert.deepEqual(transcriptMentions([p], { dirs: [t], sinceMs: 0 }), [join(t, 'proj', 'use.jsonl')]);
});

// A path has more than one spelling when a symlink leads into it (this PC: ~/Claude -> ~/projects). git records a worktree
// by its real path, and a session started under the alias logs the alias spelling; either way it is the same worktree.
test('transcriptMentions matches every spelling of the path: its realpath, and an alias through a symlinked ancestor', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spell-')));
  mkdirSync(join(base, 'projects', 'repo', '.worktrees', 'agent-x'), { recursive: true });
  symlinkSync(join(base, 'projects'), join(base, 'Claude'));
  const real = join(base, 'projects', 'repo', '.worktrees', 'agent-x');
  const alias = join(base, 'Claude', 'repo', '.worktrees', 'agent-x');
  const t = mkdtempSync(join(tmpdir(), 'tr-'));
  mkdirSync(join(t, 'proj'));
  const file = (name, obj) => { writeFileSync(join(t, 'proj', name), `${JSON.stringify(obj)}\n`); return join(t, 'proj', name); };
  const realCwd = file('real-cwd.jsonl', { type: 'user', cwd: join(real, 'src') });
  const aliasUse = file('alias-use.jsonl', { type: 'assistant', cwd: base, message: { content: [{ type: 'tool_use', input: { command: `cd ${alias} && ls` } }] } });
  const aliasCwd = file('alias-cwd.jsonl', { type: 'user', cwd: alias });
  const listing = file('alias-result.jsonl', { type: 'user', cwd: base, message: { content: [{ type: 'tool_result', content: alias }] } });
  const since = Date.now() - 3600e3;
  const expected = [aliasCwd, aliasUse, realCwd].sort();
  assert.deepEqual(transcriptMentions([real], { dirs: [t], sinceMs: since }).sort(), expected, 'registered by its real path');
  assert.deepEqual(transcriptMentions([alias], { dirs: [t], sinceMs: since }).sort(), expected, 'registered through the alias');
  assert.ok(!transcriptMentions([real], { dirs: [t], sinceMs: since }).includes(listing));
});

// ---- macOS: processesInside through lsof -F pfn (the runner is injected; one integration test uses the real lsof) ----
const OWN = 4242;
// fixture: a runner answering lsof then ps. `lsofOut` is lsof -F text; ps defaults to the pids that lsof listed.
const lsofText = (...procs) => procs.map(({ pid, files }) => `p${pid}\n${files.map(([f, n]) => `f${f}\nn${n}\n`).join('')}`).join('');
const own = { pid: OWN, files: [['cwd', '/Users/me/work'], ['txt', '/usr/local/bin/node']] };
function fakeRun({ lsof, ps, lsofResult = {}, psResult = {} } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    if (/lsof$/.test(cmd)) return { status: 0, signal: null, error: undefined, stdout: lsof, pid: 9001, ...lsofResult };
    return { status: 0, signal: null, error: undefined, stdout: ps ?? '', pid: 9002, ...psResult };
  };
  run.calls = calls;
  return run;
}
const darwin = (dir, opts) => processesInside(dir, { platform: 'darwin', ownPid: OWN, ...opts });

test('processesInside (darwin): in use via cwd, an open file fd, and ignores unrelated paths and sockets', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const run = fakeRun({
    lsof: lsofText(own,
      { pid: 11, files: [['cwd', wt]] },
      { pid: 12, files: [['cwd', '/Users/me'], ['4', `${wt}/server.log`]] },
      { pid: 13, files: [['cwd', '/Users/me/projects/app/.worktrees/agent-xy'], ['txt', '/bin/zsh']] },
      { pid: 14, files: [['cwd', '/'], ['5', '*:443'], ['6', '->0x1234abcd'], ['7', 'relative/agent-x']] }),
    ps: ` ${OWN}\n 11\n 12\n 13\n 14\n 9001\n 9002\n`,
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [11, 12], hidden: 0 });
  const lsofCall = run.calls.find(([c]) => /lsof$/.test(c));
  assert.deepEqual(lsofCall[1], ['-n', '-P', '-w', '-F', 'pfn']);
  assert.equal(run.calls.filter(([c]) => /lsof$/.test(c)).length, 1, 'lsof runs once per call');
});

test('processesInside (darwin): a worktree reached through a symlinked parent is matched by its realpath', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' }, () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  const via = join(mkdtempSync(join(tmpdir(), 'lnk-')), 'wt-link');
  symlinkSync(real, via);
  const run = fakeRun({ lsof: lsofText(own, { pid: 31, files: [['cwd', real]] }), ps: '' });
  assert.deepEqual(darwin(via, { run }), { available: true, pids: [31], hidden: 0 });
});

test('processesInside (darwin): the /System/Volumes/Data firmlink prefix is stripped from names', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const run = fakeRun({
    lsof: lsofText(own,
      { pid: 41, files: [['cwd', `/System/Volumes/Data${wt}/src`]] },
      { pid: 42, files: [['cwd', '/Users/me'], ['3', `/system/volumes/data${wt}/a.log`]] }),
    ps: '',
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [41, 42], hidden: 0 });
  assert.deepEqual(darwin(`/System/Volumes/Data${wt}`, { run }), { available: true, pids: [41, 42], hidden: 0 });
});

test('processesInside (darwin): positive control - our own pid must show an absolute cwd, else the scan is blind', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const blind = { available: false, pids: [], hidden: 0 };
  const other = { pid: 51, files: [['cwd', wt]] };
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: lsofText(other), ps: '' }) }), blind, 'own pid missing');
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: lsofText({ pid: OWN, files: [['txt', '/usr/local/bin/node']] }, other), ps: '' }) }), blind, 'own pid without a cwd');
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: lsofText({ pid: OWN, files: [['cwd', 'unreadable']] }, other), ps: '' }) }), blind, 'own cwd not an absolute path');
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: '', ps: '' }) }), blind, 'empty output');
});

test('processesInside (darwin): lsof failures are unavailable (spawn error, signal/timeout, exit 2); exit 1 is fine', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const good = lsofText(own, { pid: 61, files: [['cwd', wt]] });
  const blind = { available: false, pids: [], hidden: 0 };
  const enoent = Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: '', lsofResult: { status: null, error: enoent } }) }), blind);
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: good, lsofResult: { status: null, signal: 'SIGKILL' } }) }), blind);
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: good, lsofResult: { status: 2 } }) }), blind);
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof: good, lsofResult: { status: 1 }, ps: '' }) }), { available: true, pids: [61], hidden: 0 });
});

test('processesInside (darwin): hidden = ps pids with no readable cwd in lsof, minus ours, lsof and ps; a failing ps gives 0', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const lsof = lsofText(own, { pid: 71, files: [['cwd', '/Users/me']] }, { pid: 72, files: [['txt', '/bin/zsh']] });
  // 72 is listed by lsof but without a cwd (counts as hidden); 73 and 74 only appear in ps (other users').
  const ps = ` 1\n ${OWN}\n 71\n 72\n 73\n 74\n 9001\n 9002\n`;
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof, ps }) }), { available: true, pids: [], hidden: 4 }); // 1, 72, 73, 74
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof, ps, psResult: { status: 1 } }) }), { available: true, pids: [], hidden: 0 });
  assert.deepEqual(darwin(wt, { run: fakeRun({ lsof, ps, psResult: { status: null, error: new Error('x') } }) }), { available: true, pids: [], hidden: 0 });
});

// lsof prints a "safe" form of a name: non-ASCII bytes it cannot print as \xNN, \b \f \n \r \t, other controls as ^X (^? = DEL).
test('processesInside (darwin): lsof-escaped \\xNN names are decoded to UTF-8 before the inside check (worktree named café); any backslash makes a sibling fail closed', () => {
  const wt = '/Users/me/projects/app/.worktrees/café';
  const run = fakeRun({
    lsof: lsofText(own,
      { pid: 81, files: [['cwd', '/Users/me/projects/app/.worktrees/caf\\xc3\\xa9']] },
      { pid: 82, files: [['cwd', '/'], ['4', '/Users/me/projects/app/.worktrees/caf\\xc3\\xa9/sub/na\\xc3\\xafve.txt']] },
      // cafè and caféx are NOT inside café, but a recognised escape is also possibly a literal backslash (R2-B1), so the name is
      // judged conservatively: the text before the first backslash (.../caf) can still grow into the root -> flagged.
      { pid: 83, files: [['cwd', '/Users/me/projects/app/.worktrees/caf\\xc3\\xa8']] },
      { pid: 84, files: [['cwd', '/Users/me/projects/app/.worktrees/caf\\xc3\\xa9x']] },
      { pid: 85, files: [['cwd', '/Users/me/projects/app/.worktrees/cafex']] }, // no backslash at all: exact judgement, outside
      { pid: 86, files: [['cwd', '/Users/me/projects/other/caf\\xc3\\xa8']] }), // prefix before the backslash cannot reach the root
    ps: '',
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [81, 82, 83, 84], hidden: 0 });
  assert.deepEqual(darwin('/Users/me/projects/app/.worktrees/cafe', { run }), { available: true, pids: [81, 82, 83, 84], hidden: 0 }, 'fail closed: .../caf may still become .../cafe');
  assert.deepEqual(darwin('/Users/me/projects/app/.worktrees/agent-x', { run }), { available: true, pids: [], hidden: 0 });
});

// R2-B1: a LITERAL backslash sequence in one component plus a real escaped byte in another matches neither the fully
// decoded nor the raw spelling; only the conservative prefix check (from the first backslash) can catch it.
test('processesInside (darwin): a literal \\t in one directory name plus an escaped byte in another is still flagged (fail closed)', () => {
  const wt = '/Users/me/wt/a\\tb/café'; // the directory really is named a, backslash, t, b
  const run = fakeRun({
    lsof: lsofText(own,
      { pid: 121, files: [['cwd', '/Users/me/wt/a\\tb/caf\\xc3\\xa9/x']] },
      { pid: 122, files: [['cwd', '/Users/me/elsewhere/a\\tb/caf\\xc3\\xa9/x']] }, // prefix cannot reach the root
      { pid: 123, files: [['cwd', '/Users/me/elsewhere/cafe']] }), // no backslash, outside
    ps: '',
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [121], hidden: 0 });
});

test('processesInside (darwin): control characters in a name (\\t, ^I, ^?) are decoded; the same name outside the root is not a match', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const run = fakeRun({
    lsof: lsofText(own,
      { pid: 91, files: [['cwd', '/'], ['4', `${wt}/a\\tb.log`]] },
      { pid: 92, files: [['cwd', '/'], ['4', `${wt}/a^Ib.log`]] },
      { pid: 93, files: [['cwd', '/'], ['4', `${wt}/del^?.log`]] },
      { pid: 94, files: [['cwd', '/'], ['4', '/Users/me/elsewhere/a\\tb.log'], ['5', '/Users/me/elsewhere/caf\\xc3\\xa9/x']] }),
    ps: '',
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [91, 92, 93], hidden: 0 });
});

test('processesInside (darwin): a name whose escapes cannot be decoded unambiguously counts as inside when it could lie in the root', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const run = fakeRun({
    lsof: lsofText(own,
      { pid: 101, files: [['cwd', '/'], ['4', `${wt}/odd\\qname`]] }, // unknown \q escape
      { pid: 102, files: [['cwd', '/'], ['4', `${wt}/odd^[name`]] }, // ^[ : control or a literal caret
      { pid: 103, files: [['cwd', '/'], ['4', '/Users/me/projects/app/.worktr\\q']] }, // prefix could still grow into the root
      { pid: 104, files: [['cwd', '/'], ['4', '/Users/me/projects/other/odd\\qname']] }, // prefix can never reach the root
      { pid: 105, files: [['cwd', '/'], ['4', '/Users/me/projects/app/.worktrees/agent-xy\\qz']] }, // agent-xy is not agent-x
      { pid: 106, files: [['cwd', '/'], ['4', '/Users/ME/projects/APP/.worktrees/AGENT-X/odd\\qname']] }), // darwin folds case
    ps: '',
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [101, 102, 103, 106], hidden: 0 });
});

test('processesInside (darwin): the positive control still works when our own cwd carries an escape; lsof runs with a UTF-8 locale', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const run = fakeRun({
    lsof: lsofText({ pid: OWN, files: [['cwd', '/Users/me/caf\\xc3\\xa9/work']] }, { pid: 111, files: [['cwd', wt]] }),
    ps: '',
  });
  assert.deepEqual(darwin(wt, { run }), { available: true, pids: [111], hidden: 0 });
  const env = run.calls.find(([c]) => /lsof$/.test(c))[2]?.env;
  assert.equal(env?.LC_ALL, 'en_US.UTF-8');
  assert.equal(env?.LANG, 'en_US.UTF-8');
});

test('processesInside (darwin): lsof gets a minimal env (LC_ALL, LANG, PATH) and none of our other variables', () => {
  const wt = '/Users/me/projects/app/.worktrees/agent-x';
  const saved = { secret: process.env.FAKE_SECRET_TOKEN, path: process.env.PATH };
  const lsofEnvKeys = (path) => {
    process.env.FAKE_SECRET_TOKEN = 'do-not-leak';
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    const run = fakeRun({ lsof: lsofText(own), ps: '' });
    darwin(wt, { run });
    return run.calls.find(([c]) => /lsof$/.test(c))[2].env;
  };
  try {
    const withPath = lsofEnvKeys('/usr/bin:/bin');
    assert.deepEqual(Object.keys(withPath).sort(), ['LANG', 'LC_ALL', 'PATH']);
    assert.equal(withPath.PATH, '/usr/bin:/bin');
    const noPath = lsofEnvKeys(undefined);
    assert.deepEqual(Object.keys(noPath).sort(), ['LANG', 'LC_ALL']);
  } finally {
    if (saved.secret === undefined) delete process.env.FAKE_SECRET_TOKEN;
    else process.env.FAKE_SECRET_TOKEN = saved.secret;
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
  }
});

const hasLsof = spawnSync('lsof', ['-v'], { encoding: 'utf8' }).error === undefined;
test('processesInside (darwin path) with the real lsof finds a child whose cwd is inside the dir', { skip: !hasLsof && 'lsof is not installed', timeout: 120_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lsof-wt-')));
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { cwd: dir, stdio: 'ignore' });
  try {
    const got = processesInside(dir, { platform: 'darwin' });
    assert.equal(got.available, true, JSON.stringify(got));
    assert.ok(got.pids.includes(child.pid), JSON.stringify(got));
    assert.ok(!got.pids.includes(process.pid));
  } finally {
    child.kill('SIGKILL');
  }
});
