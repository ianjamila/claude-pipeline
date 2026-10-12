// Why: a version label is trusted by the session hook, the updater and vendor stamps, so each way a label can be a
// lie (edited install, half install, dirty source, unpublished checkout, no sha) must show up in the stamp. Installed
// copies are built by hand in a temp claude-home; checkouts are real throwaway git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { installedIdentity, checkoutIdentity, parseStamp, formatStamp, stampIsTrusted, fileProvenance } from '../pipeline/lib/identity.mjs';
import { MANIFEST_REL, sha256File } from '../pipeline/lib/installer.mjs';
import { versionReport, meta as versionMeta } from '../pipeline/commands/version.mjs';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-identity-')));
  made.push(d);
  return d;
};

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILES = { 'agents/judge.md': 'judge\n', 'skills/ship/SKILL.md': 'ship\n', 'pipeline/bin/pipeline.mjs': 'cli\n' };

// A claude-home holding FILES and an INSTALLED.json that vouches for them.
function installedHome(manifestExtra = {}, { version = '1.4.0', sourceSha = SHA } = {}) {
  const home = scratch();
  const files = {};
  for (const [rel, text] of Object.entries(FILES)) {
    const abs = join(home, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    files[rel] = sha256File(abs);
  }
  const manifest = { version, sourceSha, installedAt: '2026-10-12T00:00:00.000Z', complete: true, files, hooks: { guardGit: true, guardFiles: true }, ...manifestExtra };
  writeFileSync(join(home, ...MANIFEST_REL.split('/')), `${JSON.stringify(manifest, null, 2)}\n`);
  return home;
}

test('installedIdentity: an untouched, complete, clean install is a plain base+sha7 stamp', () => {
  const id = installedIdentity(installedHome());
  assert.equal(id.kind, 'installed');
  assert.equal(id.base, '1.4.0');
  assert.equal(id.sourceSha, SHA);
  assert.equal(id.sha7, '0123456');
  assert.equal(id.complete, true);
  assert.equal(id.sourceDirty, false);
  assert.deepEqual(id.modified, []);
  assert.deepEqual(id.missing, []);
  assert.equal(id.stamp, '1.4.0+0123456');
});

test('installedIdentity: nothing installed (no or unusable manifest) is null', () => {
  assert.equal(installedIdentity(scratch()), null);
  const home = scratch();
  mkdirSync(join(home, 'pipeline'));
  writeFileSync(join(home, ...MANIFEST_REL.split('/')), '{ not json');
  assert.equal(installedIdentity(home), null);
});

test('installedIdentity: an edited file and a deleted file are listed and mark the stamp .modified', () => {
  const home = installedHome();
  writeFileSync(join(home, 'agents', 'judge.md'), 'edited\n');
  rmSync(join(home, 'skills', 'ship', 'SKILL.md'));
  const id = installedIdentity(home);
  assert.deepEqual(id.modified, ['agents/judge.md']);
  assert.deepEqual(id.missing, ['skills/ship/SKILL.md']);
  assert.equal(id.stamp, '1.4.0+0123456.modified');
  const onlyMissing = installedHome();
  rmSync(join(onlyMissing, 'agents', 'judge.md'));
  assert.equal(installedIdentity(onlyMissing).stamp, '1.4.0+0123456.modified');
});

test('installedIdentity: complete:false is .incomplete; a manifest without the field counts as complete', () => {
  assert.equal(installedIdentity(installedHome({ complete: false })).stamp, '1.4.0+0123456.incomplete');
  assert.equal(installedIdentity(installedHome({ complete: false })).complete, false);
  const legacy = installedHome();
  const file = join(legacy, ...MANIFEST_REL.split('/'));
  const m = JSON.parse(readFileSync(file, 'utf8'));
  delete m.complete;
  writeFileSync(file, JSON.stringify(m));
  assert.equal(installedIdentity(legacy).complete, true);
  assert.equal(installedIdentity(legacy).stamp, '1.4.0+0123456');
});

test('installedIdentity: sourceDirty is .unverified; no sha is +unknown and keeps its flags; all flags together', () => {
  const dirty = installedIdentity(installedHome({ sourceDirty: true }, { sourceSha: null }));
  assert.equal(dirty.sourceSha, null);
  assert.equal(dirty.sha7, null);
  assert.equal(dirty.sourceDirty, true);
  assert.equal(dirty.stamp, '1.4.0+unknown.unverified');
  assert.equal(installedIdentity(installedHome({}, { sourceSha: null })).stamp, '1.4.0+unknown');
  const home = installedHome({ complete: false, sourceDirty: true });
  writeFileSync(join(home, 'agents', 'judge.md'), 'edited\n');
  assert.equal(installedIdentity(home).stamp, '1.4.0+0123456.modified.incomplete.unverified');
});

test('parseStamp: base, sha, flags; unknown sha is null; anything else is null', () => {
  assert.deepEqual(parseStamp('1.4.0+0123456'), { base: '1.4.0', sha: '0123456', flags: [] });
  assert.deepEqual(parseStamp('1.4.0+0123456.modified.incomplete.unverified\n'), { base: '1.4.0', sha: '0123456', flags: ['modified', 'incomplete', 'unverified'] });
  assert.deepEqual(parseStamp('1.4.0+unknown'), { base: '1.4.0', sha: null, flags: [] });
  assert.deepEqual(parseStamp('1.4.0+unknown.unverified'), { base: '1.4.0', sha: null, flags: ['unverified'] });
  for (const bad of ['1.4.0', '', null, undefined, '1.4.0+', '1.4.0+xyz', '1.4.0+abc', 'a b+0123456', '+0123456']) assert.equal(parseStamp(bad), null, String(bad));
});

test('formatStamp and parseStamp round-trip; only a sha with no flags is trusted', () => {
  for (const [sha, flags] of [[SHA, []], [SHA, ['modified']], [null, ['unverified']], [null, []]]) {
    const p = parseStamp(formatStamp('2.0.1', sha, flags));
    assert.equal(p.base, '2.0.1');
    assert.equal(p.sha, sha ? sha.slice(0, 7) : null);
    assert.deepEqual(p.flags, flags);
  }
  assert.equal(stampIsTrusted(parseStamp('1.0.0+0123456')), true);
  assert.equal(stampIsTrusted(parseStamp('1.0.0+0123456.modified')), false);
  assert.equal(stampIsTrusted(parseStamp('1.0.0+unknown')), false);
  assert.equal(stampIsTrusted(null), false);
});

// ---- checkoutIdentity --------------------------------------------------------------------------------------------

function checkoutRepo({ published = true } = {}) {
  const repo = createTmpRepo();
  repo.write('VERSION', '1.4.0\n');
  repo.write('pipeline/lib/a.mjs', 'a\n');
  repo.write('pipeline/lib/b.mjs', 'b\n');
  const sha = repo.commit('init');
  if (published) repo.git(['update-ref', 'refs/remotes/origin/main', sha]);
  const files = ['pipeline/lib/a.mjs', 'pipeline/lib/b.mjs'].map((r) => join(repo.dir, ...r.split('/')));
  return { repo, sha, files };
}

test('checkoutIdentity: a clean HEAD that origin/main contains is a trusted stamp', () => {
  const { repo, sha, files } = checkoutRepo();
  const id = checkoutIdentity(repo.dir, files);
  assert.equal(id.kind, 'checkout');
  assert.equal(id.sourceSha, sha);
  assert.equal(id.provenance, true);
  assert.equal(id.onMain, true);
  assert.deepEqual(id.modified, []);
  assert.equal(id.stamp, `1.4.0+${sha.slice(0, 7)}`);
});

test('checkoutIdentity: an edited file, a file outside HEAD or a missing origin/main each make the stamp .unverified', () => {
  const edited = checkoutRepo();
  edited.repo.write('pipeline/lib/a.mjs', 'edited\n');
  const e = checkoutIdentity(edited.repo.dir, edited.files);
  assert.equal(e.provenance, false);
  assert.equal(e.onMain, true);
  assert.deepEqual(e.modified, ['pipeline/lib/a.mjs']);
  assert.equal(e.stamp, `1.4.0+${edited.sha.slice(0, 7)}.unverified`);

  const extra = checkoutRepo();
  extra.repo.write('pipeline/lib/untracked.mjs', 'x\n');
  const x = checkoutIdentity(extra.repo.dir, [...extra.files, join(extra.repo.dir, 'pipeline', 'lib', 'untracked.mjs')]);
  assert.equal(x.provenance, false);
  assert.deepEqual(x.modified, ['pipeline/lib/untracked.mjs']);

  const local = checkoutRepo({ published: false });
  const l = checkoutIdentity(local.repo.dir, local.files);
  assert.equal(l.provenance, true);
  assert.equal(l.onMain, false);
  assert.match(l.stamp, /\.unverified$/);
});

test('checkoutIdentity: a commit ahead of origin/main is not on main; an edited VERSION also breaks provenance', () => {
  const ahead = checkoutRepo();
  ahead.repo.write('pipeline/lib/c.mjs', 'c\n');
  ahead.repo.commit('local only');
  const a = checkoutIdentity(ahead.repo.dir, ahead.files);
  assert.equal(a.onMain, false);
  assert.match(a.stamp, /\.unverified$/);

  const v = checkoutRepo();
  v.repo.write('VERSION', '9.9.9\n');
  const id = checkoutIdentity(v.repo.dir, v.files);
  assert.equal(id.base, '9.9.9');
  assert.equal(id.provenance, false);
  assert.deepEqual(id.modified, ['VERSION']);
});

test('checkoutIdentity: not a git checkout (or a subdirectory of one) is +unknown.unverified', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'VERSION'), '1.4.0\n');
  writeFileSync(join(dir, 'f.mjs'), 'x\n');
  assert.equal(checkoutIdentity(dir, [join(dir, 'f.mjs')]).stamp, '1.4.0+unknown.unverified');

  const { repo, files } = checkoutRepo();
  repo.write('sub/VERSION', '1.4.0\n');
  repo.commit('sub');
  // A root that is only a subdirectory of the repo is not the checkout the stamp would name.
  const sub = checkoutIdentity(join(repo.dir, 'sub'), files);
  assert.equal(sub.sourceSha, null);
  assert.equal(sub.stamp, '1.4.0+unknown.unverified');
});

test('fileProvenance: states for a clean tree, a dirty one and no git; inherited GIT_DIR is ignored', () => {
  const { repo, sha, files } = checkoutRepo();
  const other = createTmpRepo();
  other.write('z', 'z');
  other.commit('other');
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.dir, '.git');
  try {
    const clean = fileProvenance(repo.dir, files);
    assert.equal(clean.state, 'clean');
    assert.equal(clean.head, sha);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
  repo.write('pipeline/lib/b.mjs', 'changed\n');
  const dirty = fileProvenance(repo.dir, files);
  assert.equal(dirty.state, 'dirty');
  assert.deepEqual(dirty.differing, ['pipeline/lib/b.mjs']);
  assert.equal(fileProvenance(scratch(), []).state, 'no-git');
});

// ---- pipeline version --------------------------------------------------------------------------------------------

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// An installed copy: the real pipeline/ dir copied under <home>, vouched for by a hand-written manifest.
function installedPipelineHome(manifestExtra = {}) {
  const home = scratch();
  cpSync(join(REPO, 'pipeline'), join(home, 'pipeline'), { recursive: true });
  const files = {};
  for (const rel of ['pipeline/commands/version.mjs', 'pipeline/lib/identity.mjs', 'pipeline/bin/pipeline.mjs']) {
    files[rel] = sha256File(join(home, ...rel.split('/')));
  }
  writeFileSync(join(home, 'pipeline', 'VERSION'), '3.2.1\n');
  files['pipeline/VERSION'] = sha256File(join(home, 'pipeline', 'VERSION'));
  writeFileSync(join(home, ...MANIFEST_REL.split('/')), JSON.stringify({ version: '3.2.1', sourceSha: SHA, complete: true, files, ...manifestExtra }));
  return home;
}
const cliVersion = (home) => {
  const r = spawnSync(process.execPath, [join(home, 'pipeline', 'bin', 'pipeline.mjs'), 'version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('pipeline version: usage stays one line naming no flags', () => {
  assert.equal(versionMeta.usage, 'pipeline version');
});

test('pipeline version (installed copy, run through the CLI): the manifest stamp with its fields', () => {
  const home = installedPipelineHome();
  assert.deepEqual(cliVersion(home), {
    ok: true, version: '3.2.1+0123456', base: '3.2.1', sourceSha: SHA, complete: true, modified: [], missing: [], kind: 'installed',
  });
});

test('pipeline version (installed copy): an edited file and an unfinished install show in the stamp', () => {
  const home = installedPipelineHome({ complete: false });
  writeFileSync(join(home, 'pipeline', 'lib', 'identity.mjs'), '// edited\nexport const x = 1;\n');
  const r = versionReport(join(home, 'pipeline'));
  assert.equal(r.version, '3.2.1+0123456.modified.incomplete');
  assert.equal(r.complete, false);
  assert.deepEqual(r.modified, ['pipeline/lib/identity.mjs']);
  assert.equal(r.kind, 'installed');
});

test('pipeline version (installed copy): a corrupt manifest is labelled unverified, not trusted', () => {
  const home = installedPipelineHome();
  writeFileSync(join(home, ...MANIFEST_REL.split('/')), '{ nope');
  const r = versionReport(join(home, 'pipeline'));
  assert.equal(r.version, '3.2.1+unknown.unverified');
  assert.equal(r.complete, false);
});

test('pipeline version (checkout): a clean published HEAD is trusted; an edit is .unverified and listed', () => {
  const repo = createTmpRepo();
  repo.write('VERSION', '1.0.0\n');
  repo.write('pipeline/lib/x.mjs', 'x\n');
  const sha = repo.commit('init');
  repo.git(['update-ref', 'refs/remotes/origin/main', sha]);
  const clean = versionReport(join(repo.dir, 'pipeline'));
  assert.equal(clean.version, `1.0.0+${sha.slice(0, 7)}`);
  assert.equal(clean.kind, 'checkout');
  assert.equal(clean.sourceSha, sha);
  assert.deepEqual(clean.modified, []);
  repo.write('pipeline/lib/x.mjs', 'edited\n');
  const dirty = versionReport(join(repo.dir, 'pipeline'));
  assert.equal(dirty.version, `1.0.0+${sha.slice(0, 7)}.unverified`);
  assert.deepEqual(dirty.modified, ['pipeline/lib/x.mjs']);
});
