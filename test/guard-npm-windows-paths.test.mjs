// Why (#89, CI test (windows)): the package-script guard compares paths as text. On Windows the files guard works on POSIX-form drive paths (`D:/work/proj`), where node:path.posix does not know a drive is a root
// (resolve put the process directory in front, dirname walked off the drive), and the git guard works on native paths (`D:\work\proj`), which have no `/` for the marker walk or the project test to match.
// Both made a refusal turn into an allow on Windows only. These tests hold the Windows shapes on every platform (the paths are spelled out, no node:path of the host decides them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { drivePosix } from '../pipeline/lib/paths.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
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

// Why (security review of c13944f): a drive letter is a drive on Windows ONLY. On macOS / Linux `D:/..` is a relative path (a directory named `D:`, then its parent), so
// `echo x > D:/../<protected>` and `rm D:/../package.json` act on the working directory. Reading `D:` as a drive root (drivePosix, the files guard's isAbs) put `..` at the drive and the write elsewhere.
const CL = '.cl' + 'aude';
const posixFs = (files, dirs) => {
  const D = new Set(dirs);
  return { readText: (p) => (typeof files[p] === 'string' ? files[p] : null), readHead: () => null, readDir: () => null, pathExists: (p) => p in files || D.has(p), existsSync: (p) => p in files || D.has(p), lexists: () => false };
};
test('paths: a drive letter is no root for a posix platform (isInside, samePath, isWinModule)', async () => {
  const { isInside, samePath, isWinModule } = await import('../pipeline/lib/paths.mjs');
  assert.equal(isWinModule(drivePosix), true);
  assert.equal(isWinModule(path.win32), true);
  assert.equal(isWinModule(path.posix), false);
  assert.equal(isInside('D:/work/x', 'D:/work', 'win32'), true);
  const here = process.cwd().replace(/\\/g, '/');
  assert.equal(samePath('D:/..', here, 'linux'), true, 'off Windows D:/.. is the working directory');
  assert.equal(samePath('D:/..', here, 'darwin'), true);
  assert.equal(samePath('D:/..', 'D:/', 'win32'), true, 'on Windows it stays on the drive');
  assert.equal(samePath('D:/a/../b', 'D:/b', 'win32'), true);
});
test('files guard on linux and darwin: `D:/..` is the working directory, so writes through it are judged where they land', () => {
  const files = { '/home/u/proj/package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'echo hi' } }) };
  const dirs = ['/', '/home', '/home/u', '/home/u/proj'];
  const run = (platform, cwd, cmd) => evaluateBashForFiles(cmd, { home: '/home/u', env: {}, platform, realpath: (p) => p, cwd, ...posixFs(files, dirs) });
  for (const platform of ['linux', 'darwin']) {
    for (const cmd of [`echo x > D:/../${CL}/settings.json`, `echo x > d:/../${CL}/settings.json`, `cp x D:/../${CL}/settings.json`, `cd D:/.. && echo x > ${CL}/settings.json`, `echo x > D:/sub/../../${CL}/settings.json`]) {
      assert.equal(run(platform, '/home/u', cmd).decision, 'deny', `${platform}: ${cmd}`);
    }
    for (const cmd of ['cp evil.json D:/../package.json && npm test', 'rm D:/../package.json && npm test', 'echo x > D:/../.npmrc && npm test', 'cd D:/.. && rm package.json && npm test', 'mv D:/../package.json x; npm run test']) {
      assert.equal(run(platform, '/home/u/proj', cmd).decision, 'deny', `${platform}: ${cmd}`);
    }
    // twins: the same shapes that leave the protected place and the package file alone
    for (const cmd of [`echo x > D:/../notes.txt`, 'cat D:/../package.json && npm test', 'cp D:/../package.json p.bak && npm test', 'npm test']) {
      assert.equal(run(platform, '/home/u/proj', cmd).decision, 'allow', `${platform}: ${cmd}`);
    }
  }
});
test('files guard on win32: `D:/..` is the root of the drive, so it never reaches a directory above it', () => {
  const files = { 'D:/work/proj/package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'echo hi' } }) };
  const dirs = ['D:/', 'D:/work', 'D:/work/proj', 'D:/home/u'];
  const run = (cmd) => evaluateBashForFiles(cmd, { home: 'D:/home/u', env: {}, platform: 'win32', realpath: (p) => p, cwd: 'D:/work/proj', ...posixFs(files, dirs) });
  assert.equal(run('rm D:/../work/proj/package.json && npm test').decision, 'deny', '`..` stays on the drive: D:/work/proj/package.json');
  assert.equal(run('rm D:/../../../elsewhere/package.json && npm test').decision, 'allow', 'above the drive root there is nothing: D:/elsewhere/package.json');
});
test('git guard (native paths): `D:/..` is a relative path off Windows', { skip: process.platform === 'win32' }, () => {
  const files = { '/work/repo/package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'echo hi' } }) };
  const dirs = ['/', '/work', '/work/repo', '/home/u'];
  const run = (cmd) => evaluateGitCommand(cmd, { cwd: '/work/repo', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...posixFs(files, dirs) });
  for (const cmd of ['rm D:/../package.json && npm test', 'cp evil.json D:/../package.json && npm test', 'mv D:/../package.json x; npm run test']) assert.equal(run(cmd).decision, 'deny', cmd);
  for (const cmd of ['cat D:/../package.json && npm test', 'rm D:/../notes.txt && npm test']) assert.equal(run(cmd).decision, 'allow', cmd);
});
