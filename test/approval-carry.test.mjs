// carriesApproval (pipeline/lib/approval-carry.mjs): the proof that the PR head moved from the approved head H0 by clean,
// GitHub-made merges of the base branch and nothing else. Real temp repos, real git; no POSIX-only shell (symlinks and gitlinks
// are made with update-index, hostile files with node:fs), so it also runs on Windows CI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CARRY_MAX_UPDATES, GITHUB_COMMITTER_EMAIL, carriesApproval, carryGitEnv, gitattributesProblem, matchCarryPrefix, mergeTreeWriteSupported,
} from '../pipeline/lib/approval-carry.mjs';
import { run } from '../pipeline/lib/proc.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-carry-home-')));
after(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 3 }));

const T = (...lines) => lines.map((l) => `${l}\n`).join('');
const GITHUB = async () => ({ verified: true, committerEmail: GITHUB_COMMITTER_EMAIL });

// ---- fixtures ------------------------------------------------------------------------------------------------------

// main holds a base commit; feat is branched from it and holds H0 (the approved head). The repo is left on feat.
function world({ base = {}, feature = { 'f.txt': 'feature\n' } } = {}) {
  const repo = createTmpRepo();
  repo.write('a.txt', T('a1', 'a2', 'a3'));
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  repo.commit('base');
  repo.branch('feat');
  for (const [p, c] of Object.entries(feature)) repo.write(p, c);
  const h0 = repo.commit('feature');
  return { repo, h0 };
}
const sha = (repo, ref = 'HEAD') => repo.git(['rev-parse', ref]).trim();
// A commit on main (the repo ends on feat again).
function advanceMain(repo, files = { 'm.txt': 'main\n' }) {
  repo.checkout('main');
  for (const [p, c] of Object.entries(files)) repo.write(p, c);
  const tip = repo.commit(`main ${Object.keys(files).join(',')}`);
  repo.checkout('feat');
  return tip;
}
// What GitHub's Update branch makes: a --no-ff merge whose parents are [the branch head, the base tip].
function mergeMain(repo, ref = 'main') {
  repo.git(['merge', '--no-ff', '-q', '-m', `Merge ${ref} into feat`, ref]);
  return sha(repo);
}
// A merge that is NOT clean: the merge is left uncommitted, `edit` changes the tree, then it is committed.
function editedMerge(repo, edit, ref = 'main') {
  repo.git(['merge', '--no-ff', '--no-commit', '-q', ref]);
  edit(repo);
  return repo.commit('Merge main (edited)');
}
const carry = (w, head, over = {}) => carriesApproval({
  root: w.repo.dir, baseRefOid: over.base ?? sha(w.repo, 'main'), head, prefix: over.prefix ?? w.h0, commitInfo: over.commitInfo ?? GITHUB, home: HOME,
});
const refused = (r, code, pattern) => {
  assert.equal(r.ok, false, `expected a refusal (${code}), got ${JSON.stringify(r)}`);
  assert.equal(r.code, code, r.reason);
  assert.equal(typeof r.reason, 'string');
  if (pattern) assert.match(r.reason, pattern);
};
// A conflicted merge, resolved by taking OUR side whole: the tree git would make with a driver that always keeps ours.
function conflictWorld() {
  const w = world({ base: { 'c.txt': T('top', 'x', 'bottom') }, feature: { 'c.txt': T('top', 'ours', 'bottom') } });
  const tip = advanceMain(w.repo, { 'c.txt': T('top', 'theirs', 'bottom') });
  let conflicted = false;
  try { w.repo.git(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']); } catch { conflicted = true; }
  assert.ok(conflicted, 'the fixture merge conflicts');
  w.repo.write('c.txt', T('top', 'ours', 'bottom'));
  const head = w.repo.commit('merge main, resolved by hand');
  return { ...w, tip, head };
}
// Everything an object-or-ref write into the real repository would change.
function snapshot(repo) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(p.slice(repo.dir.length));
    }
  };
  walk(join(repo.dir, '.git', 'objects'));
  return { objects: files.sort(), refs: repo.git(['for-each-ref']), count: repo.git(['count-objects', '-v']), config: readFileSync(join(repo.dir, '.git', 'config'), 'utf8') };
}
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Index-only entries (no symlink or submodule is needed on disk, so this works on Windows): `git commit` without `add -A`.
function putEntry(repo, mode, content, file) {
  const oid = repo.git(['hash-object', '-w', '--stdin'], { input: content }).trim();
  repo.git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${file}`]);
}
const commitIndex = (repo, msg) => { repo.git(['commit', '-q', '-m', msg]); return sha(repo); };

// ---- positive ------------------------------------------------------------------------------------------------------

test('one --no-ff merge of main: carried, from the full H0, one step', async () => {
  const w = world();
  const tip = advanceMain(w.repo);
  const head = mergeMain(w.repo);
  const r = await carry(w, head, { prefix: w.h0.slice(0, 16) });
  assert.deepEqual(r, { ok: true, from: w.h0, steps: [{ merge: head, parent2: tip }] });
});

test('two successive merges of main: carried, both steps in order (oldest first)', async () => {
  const w = world();
  const t1 = advanceMain(w.repo, { 'm1.txt': '1\n' });
  const m1 = mergeMain(w.repo);
  const t2 = advanceMain(w.repo, { 'm2.txt': '2\n' });
  const m2 = mergeMain(w.repo);
  const r = await carry(w, m2, { prefix: w.h0.slice(0, 20) });
  assert.deepEqual(r, { ok: true, from: w.h0, steps: [{ merge: m1, parent2: t1 }, { merge: m2, parent2: t2 }] });
});

test('the head itself carries the prefix: no steps, nothing asked of GitHub', async () => {
  const w = world();
  let asked = 0;
  const r = await carry(w, w.h0, { commitInfo: async () => { asked += 1; return null; } });
  assert.deepEqual(r, { ok: true, from: w.h0, steps: [] });
  assert.equal(asked, 0);
});

test('an async commitInfo is awaited; a merge that touched the same file in a disjoint place still merges clean', async () => {
  const w = world({ base: { 'big.txt': T('1', '2', '3', '4', '5', '6', '7', '8', '9', '10') }, feature: { 'big.txt': T('1', '2', '3', '4', '5', '6', '7', '8', '9', 'ten') } });
  advanceMain(w.repo, { 'big.txt': T('one', '2', '3', '4', '5', '6', '7', '8', '9', '10') });
  const head = mergeMain(w.repo);
  const seen = [];
  const r = await carry(w, head, { commitInfo: async (s) => { await new Promise((res) => setTimeout(res, 5)); seen.push(s); return { verified: true, committerEmail: 'NoReply@GitHub.com' }; } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen, [head]);
});

test('the boundary: ten updates carry, eleven do not', async () => {
  const w = world();
  const merges = [];
  for (let i = 0; i <= CARRY_MAX_UPDATES; i += 1) {
    advanceMain(w.repo, { [`m${i}.txt`]: `${i}\n` });
    merges.push(mergeMain(w.repo));
  }
  assert.equal(merges.length, CARRY_MAX_UPDATES + 1);
  const head = merges.at(-1);
  refused(await carry(w, head), 'not-found', /10 updates/); // H0 is the 12th commit of the walk
  const r = await carry(w, head, { prefix: merges[0] }); // the first update as the approved head: ten steps
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.steps.length, CARRY_MAX_UPDATES);
  assert.equal(r.from, merges[0]);
});

test('a harmless .gitattributes (text / eol / diff) does not stop a carry', async () => {
  const w = world({ feature: { 'f.txt': 'feature\n', '.gitattributes': '# notes: merge is not touched here\n*.md text eol=lf\n*.png diff=exif\n' } });
  advanceMain(w.repo);
  const r = await carry(w, mergeMain(w.repo));
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---- the prefix ----------------------------------------------------------------------------------------------------

test('prefix: shorter than 16 characters is refused before any git runs; not hex is bad input', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  refused(await carry(w, head, { prefix: w.h0.slice(0, 15) }), 'prefix-short');
  refused(await carry(w, head, { prefix: w.h0.slice(0, 12) }), 'prefix-short');
  refused(await carry(w, head, { prefix: w.h0.slice(0, 16).toUpperCase() }), 'bad-input');
  refused(await carry(w, head, { prefix: `${w.h0}0` }), 'bad-input');
  refused(await carry(w, head.slice(0, 39)), 'bad-input');
  refused(await carry(w, head, { base: 'main' }), 'bad-input');
});

test('prefix: nothing on the first-parent chain starts with it', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  refused(await carry(w, head, { prefix: '0123456789abcdef' === w.h0.slice(0, 16) ? 'fedcba9876543210' : '0123456789abcdef' }), 'not-found');
});

test('matchCarryPrefix: head, one ancestor, none, and two matches is ambiguous', () => {
  const head = `${'a'.repeat(39)}1`;
  const x = `${'b'.repeat(16)}${'0'.repeat(24)}`;
  const y = `${'b'.repeat(16)}${'1'.repeat(24)}`;
  const z = 'c'.repeat(40);
  assert.deepEqual(matchCarryPrefix({ head, walked: [head, x, z], prefix: head.slice(0, 16) }), { kind: 'exact', sha: head });
  assert.deepEqual(matchCarryPrefix({ head, walked: [head, x, z], prefix: x.slice(0, 16) }), { kind: 'found', sha: x });
  assert.deepEqual(matchCarryPrefix({ head, walked: [head, x, z], prefix: 'd'.repeat(16) }), { kind: 'none' });
  assert.deepEqual(matchCarryPrefix({ head, walked: [head, x, y], prefix: 'b'.repeat(16) }), { kind: 'ambiguous', matches: [x, y] });
  assert.equal(matchCarryPrefix({ head, walked: [head, x, y], prefix: x.slice(0, 40) }).kind, 'found');
  assert.equal(matchCarryPrefix({ head, walked: [head, `${head.slice(0, 20)}${'9'.repeat(20)}`], prefix: head.slice(0, 16) }).kind, 'ambiguous', 'head plus another match: fail closed');
});

// ---- the chain -----------------------------------------------------------------------------------------------------

test('an agent commit after H0, then a merge of main: refused (the commit is not a merge)', async () => {
  const w = world();
  w.repo.write('g.txt', 'extra\n');
  const extra = w.repo.commit('agent commit');
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  refused(await carry(w, head), 'not-merge', new RegExp(extra.slice(0, 12)));
});

test('a conflicted merge resolved by hand is refused', async () => {
  const w = conflictWorld();
  refused(await carry(w, w.head), 'conflict', new RegExp(w.head.slice(0, 12)));
});

test('a clean merge plus a hand edit (an amended merge) is refused', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = editedMerge(w.repo, (repo) => repo.write('sneaky.txt', 'not from main\n'));
  refused(await carry(w, head), 'tree-mismatch', new RegExp(head.slice(0, 12)));
});

test('an evil merge that reverts a change from main is refused', async () => {
  const w = world({ base: { 'guard.txt': 'on\n' } });
  advanceMain(w.repo, { 'guard.txt': 'ON, new rule\n' });
  const head = editedMerge(w.repo, (repo) => repo.write('guard.txt', 'on\n'));
  refused(await carry(w, head), 'tree-mismatch');
});

test('an edited intermediate merge that a later merge puts back is refused, naming the intermediate one', async () => {
  const w = world();
  advanceMain(w.repo, { 'm1.txt': '1\n' });
  const m1 = editedMerge(w.repo, (repo) => repo.write('x.txt', 'smuggled\n'));
  advanceMain(w.repo, { 'm2.txt': '2\n' });
  const m2 = editedMerge(w.repo, (repo) => repo.rm('x.txt')); // the second merge removes the smuggled file again
  refused(await carry(w, m2), 'tree-mismatch', new RegExp(m1.slice(0, 12)));
});

test('a merge whose second parent is not on the base branch (a side branch, or a base that is older) is refused', async () => {
  const w = world();
  w.repo.checkout('main');
  w.repo.branch('side');
  w.repo.write('side.txt', 's\n');
  w.repo.commit('side work');
  w.repo.checkout('feat');
  const head = mergeMain(w.repo, 'side');
  refused(await carry(w, head), 'foreign-merge', new RegExp(head.slice(0, 12)));

  const v = world();
  advanceMain(v.repo);
  const head2 = mergeMain(v.repo);
  refused(await carry(v, head2, { base: sha(v.repo, `${v.h0}~1`) }), 'foreign-merge'); // GitHub's base tip is behind the merged commit
});

test('an octopus merge is refused', async () => {
  const w = world();
  w.repo.checkout('main');
  w.repo.branch('side'); // from the base commit, so git cannot fold it into main and keep two parents
  w.repo.write('side.txt', 's\n');
  w.repo.commit('side work');
  w.repo.checkout('feat');
  advanceMain(w.repo);
  w.repo.git(['merge', '--no-ff', '-q', '-m', 'octopus', 'main', 'side']);
  refused(await carry(w, sha(w.repo)), 'octopus');
});

test('rewritten history (same tree, another commit) is refused: the approved head is not on the chain', async () => {
  const w = world();
  w.repo.git(['reset', '-q', '--hard', 'main']);
  w.repo.write('f.txt', 'feature\n');
  const rewritten = w.repo.commit('feature (rebased)');
  assert.notEqual(rewritten, w.h0);
  assert.equal(sha(w.repo, `${rewritten}^{tree}`), sha(w.repo, `${w.h0}^{tree}`));
  advanceMain(w.repo);
  refused(await carry(w, mergeMain(w.repo)), 'not-found');
});

test('H0 reachable only through a second parent is refused', async () => {
  const w = world();
  w.repo.checkout('main');
  w.repo.branch('other');
  w.repo.write('o.txt', 'o\n');
  w.repo.commit('other work');
  w.repo.git(['merge', '--no-ff', '-q', '-m', 'merge feat into other', 'feat']);
  refused(await carry(w, sha(w.repo)), 'not-found');
});

test('a merge not made by GitHub is refused (unverified, a different committer, an error, nothing)', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  refused(await carry(w, head, { commitInfo: async () => ({ verified: false, committerEmail: GITHUB_COMMITTER_EMAIL }) }), 'not-github-made');
  refused(await carry(w, head, { commitInfo: async () => ({ verified: true, committerEmail: 'agent@example.com' }) }), 'not-github-made');
  refused(await carry(w, head, { commitInfo: async () => ({ verified: 'true', committerEmail: GITHUB_COMMITTER_EMAIL }) }), 'not-github-made');
  refused(await carry(w, head, { commitInfo: () => { throw new Error('HTTP 502'); } }), 'not-github-made', /502/);
  refused(await carry(w, head, { commitInfo: async () => null }), 'not-github-made');
});

// ---- .gitattributes ------------------------------------------------------------------------------------------------

const attrCases = [
  ['merge=union', { '.gitattributes': '*.txt merge=union\n' }],
  ['a bare merge', { '.gitattributes': '*.txt merge\n' }],
  ['-merge', { '.gitattributes': '*.txt -merge\n' }],
  ['!merge', { '.gitattributes': '*.txt !merge\n' }],
  ['an [attr] macro', { '.gitattributes': '[attr]mine merge=union\n*.txt mine\n' }],
  ['the binary macro', { '.gitattributes': '*.bin binary\n' }],
  ['a nested .gitattributes', { 'deep/er/.gitattributes': '*.txt merge=union\n', 'deep/er/x.txt': 'x\n' }],
  ['a merge attribute after a quoted pattern with spaces', { '.gitattributes': '"a b.txt" text merge=union\n' }],
];
for (const [name, files] of attrCases) {
  test(`.gitattributes with ${name} (on the branch side) is refused`, async () => {
    const w = world({ feature: { 'f.txt': 'feature\n', ...files } });
    advanceMain(w.repo);
    refused(await carry(w, mergeMain(w.repo)), 'attributes-unsafe', /gitattributes/i);
  });
}

test('.gitattributes with merge=union that arrives from main is refused too', async () => {
  const w = world();
  advanceMain(w.repo, { '.gitattributes': '*.txt merge=union\n' });
  refused(await carry(w, mergeMain(w.repo)), 'attributes-unsafe');
});

test('a .gitattributes that is a symbolic link (or any non-file) is refused', async () => {
  const w = world();
  putEntry(w.repo, '120000', 'elsewhere', '.gitattributes');
  const h0 = commitIndex(w.repo, 'symlinked attributes');
  advanceMain(w.repo);
  refused(await carry({ ...w, h0 }, mergeMain(w.repo), { prefix: h0 }), 'attributes-unsafe', /symbolic link/);
});

test('gitattributesProblem: the forms that matter, and the ones that do not', () => {
  for (const bad of ['* merge', '* -merge', '* !merge', '*  merge=ours', '\t* text merge=x', '[attr]m merge', '  [attr]m x', '* binary', '* -binary', 'a\0b']) {
    assert.equal(typeof gitattributesProblem(bad), 'string', JSON.stringify(bad));
  }
  for (const ok of ['', '# merge=union', '*.md text eol=lf', '*.c diff=cpp', '*.txt mergeable', '*.bin binaryish', '* text=auto\n*.sh eol=lf\n']) {
    assert.equal(gitattributesProblem(ok), null, JSON.stringify(ok));
  }
});

// ---- a hostile environment cannot change the verdict ----------------------------------------------------------------

// "take ours" as a merge driver: it turns a conflicting merge into a clean one whose tree is the hand-resolved tree - exactly
// what a carry must NOT be fooled into believing. Each test first proves the attack works on the raw merge-tree.
function hostileFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-carry-evil-'));
  const attrs = join(dir, 'attrs');
  writeFileSync(attrs, '* merge=ours\n');
  return { dir, attrs: attrs.replaceAll('\\', '/') };
}
const rawTrial = (w) => run('git', ['merge-tree', '--write-tree', w.h0, w.tip], { cwd: w.repo.dir });

test('GIT_CONFIG_COUNT / _KEY_ / _VALUE_ (a merge driver, core.attributesFile) and GIT_ALTERNATE_OBJECT_DIRECTORIES are not inherited', async () => {
  const w = conflictWorld();
  const evil = hostileFiles();
  const vars = {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.attributesFile', GIT_CONFIG_VALUE_0: evil.attrs, GIT_CONFIG_KEY_1: 'merge.ours.driver', GIT_CONFIG_VALUE_1: 'true',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(evil.dir, 'nowhere'),
  };
  try {
    await withEnv(vars, async () => {
      assert.equal(rawTrial(w).code, 0, 'the attack works on a plain git call');
      refused(await carry(w, w.head), 'conflict');
    });
    assert.equal(rawTrial(w).code, 1, 'and the variables are gone again');
  } finally { rmSync(evil.dir, { recursive: true, force: true }); }
});

test('GIT_CONFIG_PARAMETERS is not inherited', async () => {
  const w = conflictWorld();
  const evil = hostileFiles();
  try {
    await withEnv({ GIT_CONFIG_PARAMETERS: `'core.attributesFile'='${evil.attrs}' 'merge.ours.driver'='true'` }, async () => {
      assert.equal(rawTrial(w).code, 0, 'the attack works on a plain git call');
      refused(await carry(w, w.head), 'conflict');
    });
  } finally { rmSync(evil.dir, { recursive: true, force: true }); }
});

test('GIT_TEMPLATE_DIR (a template carrying config, info/attributes and a hook) is not inherited', async () => {
  const w = conflictWorld();
  const evil = hostileFiles();
  const tpl = join(evil.dir, 'tpl');
  mkdirSync(join(tpl, 'info'), { recursive: true });
  mkdirSync(join(tpl, 'hooks'));
  writeFileSync(join(tpl, 'info', 'attributes'), '* merge=ours\n');
  writeFileSync(join(tpl, 'config'), '[merge "ours"]\n\tdriver = true\n');
  writeFileSync(join(tpl, 'hooks', 'post-merge'), '#!/bin/sh\nexit 0\n');
  try {
    // the attack: a bare repo made with that template, reading the real objects, makes the conflict disappear
    const bare = join(evil.dir, 'bare.git');
    const env = { GIT_TEMPLATE_DIR: tpl, GIT_DIR: bare };
    assert.equal(run('git', ['init', '-q', '--bare', bare], { env: { GIT_TEMPLATE_DIR: tpl } }).code, 0);
    mkdirSync(join(bare, 'objects', 'info'), { recursive: true });
    writeFileSync(join(bare, 'objects', 'info', 'alternates'), `${join(w.repo.dir, '.git', 'objects').replaceAll('\\', '/')}\n`);
    assert.equal(run('git', ['merge-tree', '--write-tree', w.h0, w.tip], { cwd: evil.dir, env }).code, 0, 'the attack works on a plain git call');
    await withEnv({ GIT_TEMPLATE_DIR: tpl }, async () => refused(await carry(w, w.head), 'conflict'));
  } finally { rmSync(evil.dir, { recursive: true, force: true }); }
});

test('a merge driver in the real .git/config plus .git/info/attributes is ignored (both ways: a clean carry stays clean, a conflict stays one)', async () => {
  const w = conflictWorld();
  w.repo.git(['config', 'merge.ours.driver', 'true']);
  mkdirSync(join(w.repo.dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(w.repo.dir, '.git', 'info', 'attributes'), '* merge=ours\n');
  assert.equal(rawTrial(w).code, 0, 'the attack works on a plain git call in the real repo');
  refused(await carry(w, w.head), 'conflict');

  const v = world();
  advanceMain(v.repo);
  const head = mergeMain(v.repo);
  v.repo.git(['config', 'merge.ours.driver', 'false']); // a driver that always fails would break the real repo's own merge
  writeFileSync(join(v.repo.dir, '.git', 'info', 'attributes'), '* merge=ours\n');
  const r = await carry(v, head);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('carryGitEnv: an allowlist - none of the dangerous variables survive, the fixed ones are set', () => {
  const hostile = {
    PATH: '/usr/bin', HOME: '/home/evil', LANG: 'xx', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_PARAMETERS: "'a.b'='c'",
    GIT_TEMPLATE_DIR: '/evil', GIT_EXEC_PATH: '/evil', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/evil', GIT_DIR: '/evil', GIT_CONFIG_GLOBAL: '/evil', XDG_CONFIG_HOME: '/evil',
    GIT_ATTR_SOURCE: 'x', GIT_SSH_COMMAND: 'x', GIT_EXTERNAL_DIFF: 'x',
  };
  const iso = mkdtempSync(join(HOME, 'iso-'));
  try {
    mkdirSync(join(iso, 'hooks'));
    writeFileSync(join(iso, 'empty.gitconfig'), '');
    if (process.platform !== 'win32') { run('chmod', ['700', iso]); }
    const env = carryGitEnv({ isoDir: iso, gitDir: join(iso, 'carry.git'), source: hostile, platform: 'linux' });
    assert.deepEqual(Object.keys(env).sort(), [
      'GIT_ATTR_NOSYSTEM', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_TERMINAL_PROMPT',
      'HOME', 'LC_ALL', 'PATH', 'XDG_CONFIG_HOME',
    ]);
    assert.equal(env.HOME, iso);
    assert.equal(env.XDG_CONFIG_HOME, iso);
    assert.equal(env.GIT_CONFIG_GLOBAL, join(iso, 'empty.gitconfig'));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_ATTR_NOSYSTEM, '1');
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.GIT_DIR, join(iso, 'carry.git'));
  } finally { rmSync(iso, { recursive: true, force: true }); }
});

// ---- trees, not patches --------------------------------------------------------------------------------------------

test('a submodule pointer (gitlink) changed by hand in the merge is refused even with diff.ignoreSubmodules=all', async () => {
  const w = world();
  const one = '1'.repeat(40);
  const two = '2'.repeat(40);
  w.repo.git(['update-index', '--add', '--cacheinfo', `160000,${one},sub`]);
  const h0 = commitIndex(w.repo, 'add submodule pointer');
  advanceMain(w.repo);
  w.repo.git(['config', 'diff.ignoreSubmodules', 'all']);
  w.repo.git(['config', 'submodule.sub.ignore', 'all']);
  // control: a clean merge that leaves the pointer alone is carried
  const clean = mergeMain(w.repo);
  const ok = await carry({ ...w, h0 }, clean, { prefix: h0 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // the same merge, but the pointer is moved by hand
  w.repo.git(['reset', '-q', '--hard', h0]);
  const head = editedMerge(w.repo, (repo) => repo.git(['update-index', '--cacheinfo', `160000,${two},sub`]));
  assert.equal(w.repo.git(['diff', '--name-only', `${head}^1`, head, '--', 'sub']).trim(), '', 'diff.ignoreSubmodules hides the change from a patch');
  refused(await carry({ ...w, h0 }, head, { prefix: h0 }), 'tree-mismatch');
});

// ---- the history must be GitHub's -----------------------------------------------------------------------------------

test('a grafts file, a replace ref and a shallow clone are refused before anything else', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  const base = sha(w.repo, 'main');
  assert.equal((await carry(w, head)).ok, true);

  writeFileSync(join(w.repo.dir, '.git', 'shallow'), `${base}\n`);
  refused(await carry(w, head), 'history-unsafe', /shallow/);
  rmSync(join(w.repo.dir, '.git', 'shallow'));

  mkdirSync(join(w.repo.dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(w.repo.dir, '.git', 'info', 'grafts'), `${w.h0} ${base}\n`);
  refused(await carry(w, head), 'history-unsafe', /grafts/);
  rmSync(join(w.repo.dir, '.git', 'info', 'grafts'));

  w.repo.git(['replace', w.h0, base]);
  refused(await carry(w, head), 'history-unsafe', /replace/);
  w.repo.git(['replace', '-d', w.h0]);
  assert.equal((await carry(w, head)).ok, true);
});

// ---- missing objects: a refusal that says how to get them, never a fetch -------------------------------------------------

test('a head, base or chain commit that is not in the repository is refused with the fetch hint', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  const absent = 'ab'.repeat(20);
  refused(await carry(w, absent), 'missing-object', /git fetch origin/);
  refused(await carry(w, head, { base: absent }), 'missing-object', /git fetch origin/);
});

test('a partial clone (commits only, no trees) is refused with the fetch hint', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  w.repo.git(['config', 'uploadpack.allowFilter', 'true']);
  const dest = join(mkdtempSync(join(tmpdir(), 'cp-carry-partial-')), 'clone');
  try {
    const r = run('git', ['clone', '-q', '--no-checkout', '--filter=tree:0', pathToFileURL(w.repo.dir).href, dest], { env: { GIT_CONFIG_COUNT: undefined, LC_ALL: 'C' } });
    assert.equal(r.code, 0, r.stderr);
    const out = await carriesApproval({ root: dest, baseRefOid: sha(w.repo, 'main'), head, prefix: w.h0, commitInfo: GITHUB, home: HOME });
    refused(out, 'missing-object', /git fetch origin/);
  } finally { rmSync(join(dest, '..'), { recursive: true, force: true, maxRetries: 3 }); }
});

// ---- no writes -----------------------------------------------------------------------------------------------------

test('the real repository gains no objects, refs or config - on a carry, a refusal and a conflict; the scratch space is cleaned up', async () => {
  const w = world();
  advanceMain(w.repo);
  const head = mergeMain(w.repo);
  const c = conflictWorld();
  const before = [snapshot(w.repo), snapshot(c.repo)];
  assert.equal((await carry(w, head)).ok, true);
  refused(await carry(w, head, { prefix: 'f'.repeat(16) }), 'not-found');
  refused(await carry(c, c.head), 'conflict');
  assert.deepEqual([snapshot(w.repo), snapshot(c.repo)], before);
  const leftovers = readdirSync(join(HOME, 'pipeline-state', 'tmp')).filter((n) => n.startsWith('claude-pipeline-git-'));
  assert.deepEqual(leftovers, []);
});

test('no fetch, pull or push anywhere in the carry', () => {
  const src = readFileSync(new URL('../pipeline/lib/approval-carry.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /['"](?:fetch|pull|push|clone|remote|ls-remote)['"]/);
});

test('mergeTreeWriteSupported: 2.38 and later only; anything unreadable is no', () => {
  for (const yes of ['git version 2.38.0', 'git version 2.39.3 (Apple Git-145)', 'git version 2.50.1.windows.1\n', 'git version 3.0.0']) assert.equal(mergeTreeWriteSupported(yes), true, yes);
  for (const no of ['git version 2.37.9', 'git version 1.99.0', 'git version', '', 'something else', undefined]) assert.equal(mergeTreeWriteSupported(no), false, String(no));
});
