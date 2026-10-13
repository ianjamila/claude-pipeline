import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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

test('processesInside: fake /proc tree; non-linux is unavailable', () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const target = mkdtempSync(join(tmpdir(), 'wt-'));
  mkdirSync(join(proc, '101', 'fd'), { recursive: true });
  mkdirSync(join(proc, '202', 'fd'), { recursive: true });
  symlinkSync(target, join(proc, '101', 'cwd'));
  symlinkSync(tmpdir(), join(proc, '202', 'cwd'));
  symlinkSync(join(target, 'x.log'), join(proc, '202', 'fd', '3'));
  assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'linux' }), { available: true, pids: [101, 202] });
  assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'win32' }), { available: false, pids: [] });
  assert.deepEqual(processesInside(target, { procRoot: join(proc, 'missing'), platform: 'linux' }), { available: false, pids: [] });
}, { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' });

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

test('entriesFor flags a symlink and walkTree does not follow it', () => {
  const { add } = world();
  const wt = add('agent-x', 'agent/x');
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), '');
  symlinkSync(outside, join(wt, 'link'));
  const e = Object.fromEntries(entriesFor(wt).map((x) => [x.path, x]));
  assert.equal(e.link.isSymlink, true);
  assert.equal(e.link.kind, 'untracked');
  assert.deepEqual(walkTree(wt).map((w) => w.path).filter((p) => p.startsWith('link')), ['link']);
}, { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' });

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

test('an unreadable directory is a blocker, never an empty one', () => {
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
}, { skip: (process.platform === 'win32' && 'chmod 000 is not enforced on Windows') || (process.getuid?.() === 0 && 'root can read any directory') });

test('processesInside matches a worktree reached through a symlinked path', () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  const via = join(mkdtempSync(join(tmpdir(), 'lnk-')), 'wt-link');
  symlinkSync(real, via);
  mkdirSync(join(proc, '303', 'fd'), { recursive: true });
  symlinkSync(real, join(proc, '303', 'cwd'));
  assert.deepEqual(processesInside(via, { procRoot: proc, platform: 'linux' }), { available: true, pids: [303] });
}, { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' });

test('processesInside ignores non-path fd targets (socket:[N], anon_inode:…) even with cwd inside the worktree', () => {
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
    assert.deepEqual(processesInside(target, { procRoot: proc, platform: 'linux' }), { available: true, pids: [505] });
  } finally {
    process.chdir(before);
  }
}, { skip: process.platform === 'win32' && 'symlinks need privileges on Windows CI' });

test('transcriptMentions counts an unreadable recent transcript as a hit (fail-closed)', () => {
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
}, { skip: (process.platform === 'win32' && 'chmod 000 is not enforced on Windows') || (process.getuid?.() === 0 && 'root can read any file') });
