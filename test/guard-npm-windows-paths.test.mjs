// Why (#89, CI test (windows)): the package-script guard compares paths as text. On Windows the files guard works on POSIX-form drive paths (`D:/work/proj`), where node:path.posix does not know a drive is a root
// (resolve put the process directory in front, dirname walked off the drive), and the git guard works on native paths (`D:\work\proj`), which have no `/` for the marker walk or the project test to match.
// Both made a refusal turn into an allow on Windows only. These tests hold the Windows shapes on every platform (the paths are spelled out, no node:path of the host decides them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { drivePosix } from '../pipeline/lib/paths.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { markPackageState, pkgMarkersFor, binSite } from '../pipeline/hooks/lib/package-scripts.mjs';

test('drivePosix: a drive is a root (resolve, dirname, isAbsolute, relative), the rest is posix', () => {
  assert.equal(drivePosix.isAbsolute('D:/a'), true);
  assert.equal(drivePosix.isAbsolute('/a'), true);
  assert.equal(drivePosix.isAbsolute('a/b'), false);
  assert.equal(drivePosix.resolve('D:/a/b', 'c'), 'D:/a/b/c');
  assert.equal(drivePosix.resolve('D:/a/b', '../c'), 'D:/a/c');
  assert.equal(drivePosix.resolve('D:/a', '/x/y'), '/x/y', 'an absolute word replaces the directory');
  assert.equal(drivePosix.resolve('/a', 'E:/x/'), 'E:/x');
  assert.equal(drivePosix.resolve('D:/a', '../../..'), 'D:/', '.. stops at the drive root');
  assert.equal(drivePosix.resolve('/a/b', 'c'), '/a/b/c');
  assert.equal(drivePosix.dirname('D:/a/b'), 'D:/a');
  assert.equal(drivePosix.dirname('D:/a'), 'D:/');
  assert.equal(drivePosix.dirname('D:/'), 'D:/', 'the walk upward ends at the drive');
  assert.equal(drivePosix.dirname('/a/b'), '/a');
  assert.equal(drivePosix.join('D:/a', 'node_modules', '.bin'), 'D:/a/node_modules/.bin');
  assert.equal(drivePosix.relative('D:/a/b', 'D:/a/c/d'), '../c/d');
});

test('files guard on drive paths: a package.json the line removes first is seen, as for /posix paths', () => {
  const root = 'D:/work/proj';
  const files = { [`${root}/package.json`]: JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'echo hi' } }) };
  const dirs = new Set([root, 'D:/work', 'D:/', 'D:/home/u']);
  const run = (cmd) => evaluateBashForFiles(cmd, {
    home: 'D:/home/u', env: {}, platform: 'win32', realpath: (p) => p, cwd: root,
    readText: (p) => (typeof files[p] === 'string' ? files[p] : null), readHead: () => null, readDir: () => null,
    pathExists: (p) => p in files || dirs.has(p), existsSync: (p) => p in files || dirs.has(p), lexists: () => false,
  });
  assert.equal(run('npm test').decision, 'allow');
  for (const cmd of ['rm -f package.json && npm test', 'mv package.json p.old & npm test', 'tar xf a.tgz && mv package.json p.old && npm test', `cd ${root} && rm -rf package.json; npm test`]) {
    assert.equal(run(cmd).decision, 'deny', cmd);
  }
});

test('the marker walk compares native Windows paths (backslashes) as the POSIX ones', () => {
  const win = path.win32;
  const budget = {};
  markPackageState(budget, [['rm', '-f', 'package.json']], { dirs: ['D:\\work\\repo'], p: win });
  assert.deepEqual(budget.pkgMarkers.map((m) => m.paths), [['D:\\work\\repo\\package.json']]);
  assert.equal(pkgMarkersFor(budget, ['D:\\work\\repo'], { p: win, pathExists: () => false }), 'known');
  assert.equal(pkgMarkersFor(budget, ['D:\\work\\repo\\sub'], { p: win, pathExists: () => false }), 'known', 'the package.json of a parent is the project of a subdirectory');
  assert.equal(pkgMarkersFor(budget, ['D:\\elsewhere'], { p: win, pathExists: () => false }), null);
  const nm = {};
  markPackageState(nm, [['rm', '-rf', 'node_modules']], { dirs: ['D:\\work\\repo'], p: win });
  assert.equal(pkgMarkersFor(nm, ['D:\\work\\repo'], { p: win, pathExists: () => false }), 'known');
  assert.equal(pkgMarkersFor(nm, ['D:\\work\\repo'], { p: win, pathExists: (f) => /package\.json$/.test(f) }), null, 'a package.json next to it is found first');
});

test('binSite: a shebang path in the project is inside whether the project is native (D:\\dir) or POSIX, and with or without the drive', () => {
  const dflt = binSite('D:\\work\\repo\\node_modules\\.bin\\tool', 'D:\\work\\repo', () => false, path.win32);
  for (const abs of ['D:/work/repo/vendor/node', 'D:\\work\\repo\\vendor\\node', '/work/repo/vendor/node', 'D:/work/repo']) assert.equal(dflt.inside(abs), true, abs);
  for (const abs of ['D:/work/other/node', '/usr/bin/node', 'D:/work/repository/node', 'C:/work/repo/node']) assert.equal(dflt.inside(abs), false, abs);
  const px = binSite('/home/u/proj/node_modules/.bin/tool', '/home/u/proj', () => false, path.posix);
  assert.equal(px.inside('/home/u/proj/vendor/node'), true);
  assert.equal(px.inside('/home/u/project/node'), false);
});
