// The files guard judges a command against an injected (often fake) file system; comparing two path spellings must not read the real disk.
// Why: samePath asks the disk (two statSync calls a pair, #239) and the guard compares a path with every protected ancestor on every reading,
// so on a Linux CI runner (where the test's platform 'linux' IS the running platform) one nested-script chain made 567,496 failing stats and
// the CPU-time timing tests in guard-hidden-assignments.test.mjs ran 3-5x slower and hit the guard's 5 s deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

test('the files guard reads no real stat for a chain of nested scripts, whatever the running platform is', () => {
  const PROJ = '/no-such-home/proj';
  const F = {
    [resolve(PROJ, 'F1.sh')]: 'a1=x1; a1=x2\nfor f in w1 w2 w3; do echo $a1 $f; done\nbash F2.sh $a1\n',
    [resolve(PROJ, 'F2.sh')]: 'a2=x1; a2=x2\nfor f in w1 w2 w3; do echo $a2 $f; done\necho $a2\n',
  };
  const api = {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || resolve(p) === resolve(PROJ),
    readDir: () => null,
  };
  const orig = fs.statSync;
  let stats = 0;
  fs.statSync = function (...a) { stats++; return orig.apply(this, a); };
  try {
    // platform = the running one, the case where samePath would consult the disk
    const r = evaluateBashForFiles('bash F1.sh', { home: '/no-such-home', env: {}, platform: process.platform, realpath: (p) => p, cwd: PROJ, ...api, existsSync: api.pathExists });
    assert.equal(r.decision, 'allow', r.reason);
  } finally { fs.statSync = orig; }
  assert.equal(stats, 0, `${stats} real stat call(s) while judging a fake file system`);
});
