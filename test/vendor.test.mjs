import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { run as vendor, meta, vendorDrift } from '../pipeline/commands/vendor.mjs';
import { MANIFEST_REL, sha256File, walkFiles } from '../pipeline/lib/installer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIBS = ['proc', 'paths', 'yaml', 'config', 'glob', 'diff', 'git', 'hardstops', 'risk', 'integrity', 'locks', 'guard-provenance', 'review-marker'];
const ENTRIES = ['ci-guard', 'ci-guards-run', 'stop-verify', 'smoke', 'supabase-local'];

const vendorInto = (dir, extra = []) => vendor(['--repo', dir, ...extra], { cwd: dir, env: process.env });
const sp = (dir) => join(dir, 'scripts', 'pipeline');

test('meta describes the command', () => {
  assert.match(meta.usage, /pipeline vendor --repo DIR \[--check\]/);
});

test('vendor copies libs, js-yaml, entry scripts byte-for-byte and stamps VERSION', async () => {
  const repo = createTmpRepo();
  const r = await vendorInto(repo.dir);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  const expected = [
    ...ENTRIES.map((n) => `scripts/pipeline/${n}.mjs`),
    ...LIBS.map((n) => `scripts/pipeline/lib/${n}.mjs`),
    'scripts/pipeline/vendor/js-yaml.mjs',
    'scripts/pipeline/VERSION',
  ];
  assert.deepEqual([...r.output.files].sort(), expected.sort());
  assert.ok(r.output.files.includes('scripts/pipeline/lib/review-marker.mjs'), 'the review-marker lib ships to projects (the guards workflow reads the review comment with it)');

  for (const n of LIBS) {
    assert.equal(readFileSync(join(sp(repo.dir), 'lib', `${n}.mjs`), 'utf8'), readFileSync(join(root, 'pipeline', 'lib', `${n}.mjs`), 'utf8'));
  }
  assert.equal(
    readFileSync(join(sp(repo.dir), 'vendor', 'js-yaml.mjs'), 'utf8'),
    readFileSync(join(root, 'pipeline', 'vendor', 'js-yaml.mjs'), 'utf8'),
  );
  for (const n of ENTRIES) {
    assert.equal(
      readFileSync(join(sp(repo.dir), `${n}.mjs`), 'utf8'),
      readFileSync(join(root, 'pipeline', 'templates', 'scripts', 'pipeline', `${n}.mjs`), 'utf8'),
    );
  }
  const base = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const stamp = readFileSync(join(sp(repo.dir), 'VERSION'), 'utf8').trim();
  assert.equal(stamp, r.output.version);
  assert.match(stamp, new RegExp(`^${base.replace(/\./g, '\\.')}\\+([0-9a-f]{7,}|unknown)(\\.[a-z]+)*$`));
});

test('vendor resolves the repo root from a subdirectory', async () => {
  const repo = createTmpRepo();
  repo.write('app/src/x.txt', 'x');
  const r = await vendor(['--repo', join(repo.dir, 'app', 'src')], { cwd: repo.dir, env: process.env });
  assert.equal(r.exitCode, 0);
  assert.ok(existsSync(join(sp(repo.dir), 'ci-guard.mjs')));
  assert.ok(!existsSync(join(repo.dir, 'app', 'src', 'scripts')));
});

test('vendor --check passes right after vendoring', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  const r = await vendorInto(repo.dir, ['--check']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
});

test('vendor --check reports an edited file', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  writeFileSync(join(sp(repo.dir), 'lib', 'hardstops.mjs'), '// tampered\n');
  const r = await vendorInto(repo.dir, ['--check']);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.ok, false);
  assert.deepEqual(r.output.drift, [{ file: 'scripts/pipeline/lib/hardstops.mjs', reason: 'differs' }]);
});

test('vendor --check reports a missing file and a missing VERSION', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  rmSync(join(sp(repo.dir), 'smoke.mjs'));
  rmSync(join(sp(repo.dir), 'VERSION'));
  const r = await vendorInto(repo.dir, ['--check']);
  assert.equal(r.exitCode, 1);
  const byFile = Object.fromEntries(r.output.drift.map((d) => [d.file, d.reason]));
  assert.equal(byFile['scripts/pipeline/smoke.mjs'], 'missing');
  assert.equal(byFile['scripts/pipeline/VERSION'], 'missing');
  assert.equal(r.output.drift.length, 2);
});

test('vendor --check on a never-vendored repo lists everything as missing', async () => {
  const repo = createTmpRepo();
  const r = await vendorInto(repo.dir, ['--check']);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.drift.length, ENTRIES.length + LIBS.length + 2);
  assert.ok(r.output.drift.every((d) => d.reason === 'missing'));
});

test('vendor --check ignores the +sha suffix but not a different base version', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  const base = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  writeFileSync(join(sp(repo.dir), 'VERSION'), `${base}+deadbee\n`);
  assert.equal((await vendorInto(repo.dir, ['--check'])).exitCode, 0);
  writeFileSync(join(sp(repo.dir), 'VERSION'), '0.0.1+deadbee\n');
  const r = await vendorInto(repo.dir, ['--check']);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.drift[0].file, 'scripts/pipeline/VERSION');
});

test('re-vendoring repairs drift', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  writeFileSync(join(sp(repo.dir), 'lib', 'glob.mjs'), '// tampered\n');
  assert.equal((await vendorInto(repo.dir, ['--check'])).exitCode, 1);
  await vendorInto(repo.dir);
  assert.equal((await vendorInto(repo.dir, ['--check'])).exitCode, 0);
});

test('missing --repo and a non-git directory are usage errors', async () => {
  await assert.rejects(() => vendor([], { cwd: root, env: process.env }), /missing --repo/);
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-plain-')));
  try {
    await assert.rejects(() => vendor(['--repo', plain], { cwd: plain, env: process.env }), /not a git repository/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

// Every relative import in every vendored file must land on a file that was vendored: the project has no
// pipeline/ directory, so an import that escapes the set would crash CI only after onboarding.
test('every relative import of every vendored file resolves inside the vendored set', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.mjs')) files.push(join(d, e.name));
    }
  };
  walk(sp(repo.dir));
  assert.equal(files.length, ENTRIES.length + LIBS.length + 1);
  const spec = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(spec)) {
      const target = m[1] ?? m[2] ?? m[3];
      if (target.startsWith('node:')) continue;
      assert.ok(target.startsWith('.'), `${file}: non-relative, non-node import "${target}"`);
      const abs = resolve(dirname(file), target);
      assert.ok(abs.startsWith(sp(repo.dir)), `${file}: import "${target}" escapes scripts/pipeline`);
      assert.ok(existsSync(abs), `${file}: import "${target}" does not exist in the vendored set`);
    }
  }
});

test('every vendored module actually loads from the project layout', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  for (const n of LIBS) {
    const mod = await import(pathToFileURL(join(sp(repo.dir), 'lib', `${n}.mjs`)).href);
    assert.ok(Object.keys(mod).length > 0, `${n} exports something`);
  }
  for (const n of ENTRIES) {
    // Entry scripts only run when invoked directly, so importing them must be side-effect free.
    const mod = await import(pathToFileURL(join(sp(repo.dir), `${n}.mjs`)).href);
    assert.ok(Object.keys(mod).length > 0, `${n} exports something`);
  }
});

test('vendor pins the vendored files in .gitattributes (-text, shim eol=lf): appended once, idempotent, keeps existing lines', async () => {
  const repo = createTmpRepo();
  repo.write('.gitattributes', '*.png binary');
  const r = await vendorInto(repo.dir);
  assert.deepEqual(r.output.gitattributes, ['scripts/pipeline/** -text', 'scripts/verify text eol=lf']);
  const text = readFileSync(join(repo.dir, '.gitattributes'), 'utf8');
  assert.match(text, /^\*\.png binary\n/);
  assert.equal(text.split('\n').filter((l) => l === 'scripts/pipeline/** -text').length, 1);
  const again = await vendorInto(repo.dir);
  assert.deepEqual(again.output.gitattributes, []);
  assert.equal(readFileSync(join(repo.dir, '.gitattributes'), 'utf8'), text);
  // --check: no warning once pinned; a warning (not drift) when the entry is missing
  // (the stamp warning depends on the checkout running the tests, so only the .gitattributes warnings are counted here)
  const attributeWarnings = (res) => (res.output.warnings ?? []).filter((w) => w.startsWith('.gitattributes lacks'));
  assert.deepEqual(attributeWarnings(await vendorInto(repo.dir, ['--check'])), []);
  writeFileSync(join(repo.dir, '.gitattributes'), '*.png binary\n');
  const c = await vendorInto(repo.dir, ['--check']);
  assert.equal(c.exitCode, 0);
  assert.match(attributeWarnings(c)[0], /scripts\/pipeline\/\*\* -text/);
});

test('vendor creates .gitattributes when the project has none', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  assert.match(readFileSync(join(repo.dir, '.gitattributes'), 'utf8'), /^# claude-pipeline: .*\nscripts\/pipeline\/\*\* -text\nscripts\/verify text eol=lf\n$/);
});

test('the POSIX verify shim template is executable in git (mode 100755) and pinned to LF', { skip: process.platform === 'win32' }, () => {
  const r = spawnSync('git', ['ls-files', '-s', 'pipeline/templates/scripts/verify'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return; // not a git checkout (a packaged copy): nothing to assert
  assert.match(r.stdout, /^100755 /);
  assert.ok(statSync(join(root, 'pipeline', 'templates', 'scripts', 'verify')).mode & 0o111, 'executable on disk too');
  assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /^pipeline\/templates\/scripts\/verify text eol=lf$/m);
});

// ---- identity of where vendor runs; --check stamp warnings; vendorDrift --------------------------------------------

const base = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const vendorFrom = (pipelineDir, target, extra = []) => {
  const r = spawnSync(process.execPath, [join(pipelineDir, 'bin', 'pipeline.mjs'), 'vendor', '--repo', target, ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
};
const stampOf = (dir) => readFileSync(join(sp(dir), 'VERSION'), 'utf8').trim();

// A copy of this pipeline as its own git checkout, origin/main pointing at HEAD (so a clean one reads as published).
function pipelineCheckout() {
  const repo = createTmpRepo();
  cpSync(join(root, 'pipeline'), join(repo.dir, 'pipeline'), { recursive: true });
  cpSync(join(root, 'VERSION'), join(repo.dir, 'VERSION'));
  const sha = repo.commit('pipeline');
  repo.git(['update-ref', 'refs/remotes/origin/main', sha]);
  return { repo, sha };
}

test('vendor from a clean published checkout stamps base+sha7 with no flag', () => {
  const { repo, sha } = pipelineCheckout();
  const target = createTmpRepo();
  vendorFrom(join(repo.dir, 'pipeline'), target.dir);
  assert.equal(stampOf(target.dir), `${base}+${sha.slice(0, 7)}`);
});

test('vendor from a checkout stamps .unverified when a vendored source is edited, or HEAD is not on origin/main', () => {
  const { repo, sha } = pipelineCheckout();
  const target = createTmpRepo();
  writeFileSync(join(repo.dir, 'pipeline', 'lib', 'glob.mjs'), `${readFileSync(join(repo.dir, 'pipeline', 'lib', 'glob.mjs'), 'utf8')}\n// local edit\n`);
  vendorFrom(join(repo.dir, 'pipeline'), target.dir);
  assert.equal(stampOf(target.dir), `${base}+${sha.slice(0, 7)}.unverified`);

  const { repo: local } = pipelineCheckout();
  local.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  const target2 = createTmpRepo();
  vendorFrom(join(local.dir, 'pipeline'), target2.dir);
  assert.match(stampOf(target2.dir), /\.unverified$/);
});

test('vendor from an installed copy stamps the installed identity (.modified when the install was edited)', () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-vendor-home-')));
  try {
    cpSync(join(root, 'pipeline'), join(home, 'pipeline'), { recursive: true });
    const files = {};
    for (const r of walkFiles(join(home, 'pipeline'))) files[`pipeline/${r}`] = sha256File(join(home, 'pipeline', ...r.split('/')));
    const sourceSha = 'abcdef0123456789abcdef0123456789abcdef01';
    writeFileSync(join(home, ...MANIFEST_REL.split('/')), JSON.stringify({ version: '7.7.7', sourceSha, complete: true, files }));
    const target = createTmpRepo();
    vendorFrom(join(home, 'pipeline'), target.dir);
    assert.equal(stampOf(target.dir), '7.7.7+abcdef0');

    writeFileSync(join(home, 'pipeline', 'lib', 'glob.mjs'), '// hand edit\n');
    const target2 = createTmpRepo();
    vendorFrom(join(home, 'pipeline'), target2.dir);
    assert.equal(stampOf(target2.dir), '7.7.7+abcdef0.modified');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('vendor --check warns when the project stamp has no sha or carries .unverified/.modified/.incomplete; a clean stamp is quiet', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  const stampWarnings = async (stamp) => {
    writeFileSync(join(sp(repo.dir), 'VERSION'), `${stamp}\n`);
    const r = await vendorInto(repo.dir, ['--check']);
    assert.equal(r.exitCode, 0, 'the warning never turns a byte-identical copy into drift');
    return (r.output.warnings ?? []).filter((w) => w.startsWith('scripts/pipeline/VERSION'));
  };
  assert.deepEqual(await stampWarnings(`${base}+abcdef0`), []);
  assert.match((await stampWarnings(`${base}+unknown`))[0], /no source sha/);
  assert.match((await stampWarnings(`${base}+abcdef0.unverified`))[0], /\.unverified/);
  assert.match((await stampWarnings(`${base}+abcdef0.modified`))[0], /\.modified/);
  assert.match((await stampWarnings(`${base}+abcdef0.incomplete`))[0], /\.incomplete/);
  assert.match((await stampWarnings(`${base}+unknown.unverified`))[0], /no source sha, \.unverified/);
});

test('vendor --check still compares bytes and the base version only: a different +sha is not drift', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  writeFileSync(join(sp(repo.dir), 'VERSION'), `${base}+1234567.modified\n`);
  assert.equal((await vendorInto(repo.dir, ['--check'])).exitCode, 0);
  writeFileSync(join(sp(repo.dir), 'VERSION'), `0.0.0-other+1234567\n`);
  const r = await vendorInto(repo.dir, ['--check']);
  assert.equal(r.exitCode, 1);
  assert.match(r.output.drift[0].reason, /version 0\.0\.0-other != pipeline/);
});

test('vendorDrift(root): empty when identical, lists edited and missing files, ignores VERSION, needs no git', async () => {
  const repo = createTmpRepo();
  await vendorInto(repo.dir);
  assert.deepEqual(vendorDrift(repo.dir), []);
  writeFileSync(join(sp(repo.dir), 'VERSION'), `${base}+0000000.modified\n`);
  assert.deepEqual(vendorDrift(repo.dir), [], 'only the commit differs: no content drift');
  writeFileSync(join(sp(repo.dir), 'lib', 'glob.mjs'), '// drifted\n');
  rmSync(join(sp(repo.dir), 'lib', 'yaml.mjs'));
  assert.deepEqual(vendorDrift(repo.dir), [
    { file: 'scripts/pipeline/lib/yaml.mjs', reason: 'missing' },
    { file: 'scripts/pipeline/lib/glob.mjs', reason: 'differs' },
  ]);
  // a plain directory (no .git anywhere): every file is simply missing
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-vendor-plain-')));
  try {
    const d = vendorDrift(plain);
    assert.equal(d.length, ENTRIES.length + LIBS.length + 1);
    assert.ok(d.every((x) => x.reason === 'missing'));
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
