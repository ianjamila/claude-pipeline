import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';

// Two fixtures built from identical content and message in the same second used to get the SAME head sha, so an
// approval record keyed on a head from one process could satisfy another process's negative assertion (issue #147).
function withPinnedDates(fn) {
  const saved = { a: process.env.GIT_AUTHOR_DATE, c: process.env.GIT_COMMITTER_DATE };
  const stamp = '2026-01-01T00:00:00Z';
  process.env.GIT_AUTHOR_DATE = stamp;
  process.env.GIT_COMMITTER_DATE = stamp;
  try { return fn(); } finally {
    if (saved.a === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = saved.a;
    if (saved.c === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = saved.c;
  }
}

test('two identical tmp repos committed in the same second get different heads', () => {
  withPinnedDates(() => {
    const a = createTmpRepo();
    const b = createTmpRepo();
    try {
      a.write('f.txt', 'same\n'); b.write('f.txt', 'same\n');
      assert.notEqual(a.commit('same message'), b.commit('same message'));
    } finally { a.cleanup(); b.cleanup(); }
  });
});

test('a commit made through repo.git([commit, ...]) directly is unique per repo too', () => {
  withPinnedDates(() => {
    const a = createTmpRepo();
    const b = createTmpRepo();
    try {
      for (const r of [a, b]) { r.write('f.txt', 'same\n'); r.git(['add', '-A']); r.git(['commit', '-q', '-m', 'same message']); }
      assert.notEqual(a.git(['rev-parse', 'HEAD']), b.git(['rev-parse', 'HEAD']));
    } finally { a.cleanup(); b.cleanup(); }
  });
});

// GIT_AUTHOR_* / GIT_COMMITTER_* override repo-local user.name/user.email (git exports them to hooks), which would make
// the per-repo nonce inert. The helper must scrub them from the children it spawns.
test('inherited git identity env vars do not defeat head uniqueness', () => {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = k.endsWith('EMAIL') ? 'fixed@example.invalid' : 'Fixed Name';
  try {
    withPinnedDates(() => {
      const a = createTmpRepo();
      const b = createTmpRepo();
      try {
        a.write('f.txt', 'same\n'); b.write('f.txt', 'same\n');
        assert.notEqual(a.commit('same message'), b.commit('same message'));
        for (const r of [a, b]) { r.write('g.txt', 'x\n'); r.git(['add', '-A']); r.git(['commit', '-q', '-m', 'direct']); }
        assert.notEqual(a.git(['rev-parse', 'HEAD']), b.git(['rev-parse', 'HEAD']));
      } finally { a.cleanup(); b.cleanup(); }
    });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// Environment-supplied config (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS, which git exports to hooks when the
// outer command ran with -c) ranks above repo-local config and would also make the nonce inert. GIT_CONFIG redirects
// `git config` to another file, so the nonce would never reach .git/config at all.
test('inherited git config env vars do not defeat head uniqueness', () => {
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const scratch = mkdtempSync(join(tmpdir(), 'cp-gitcfg-'));
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'user.email';
  process.env.GIT_CONFIG_VALUE_0 = 'fixed@example.invalid';
  process.env.GIT_CONFIG_PARAMETERS = "'user.email=fixed@example.invalid'";
  process.env.GIT_CONFIG = join(scratch, 'redirected-config');
  try {
    withPinnedDates(() => {
      const a = createTmpRepo();
      const b = createTmpRepo();
      try {
        a.write('f.txt', 'same\n'); b.write('f.txt', 'same\n');
        assert.notEqual(a.commit('same message'), b.commit('same message'));
        for (const r of [a, b]) { r.write('g.txt', 'x\n'); r.git(['add', '-A']); r.git(['commit', '-q', '-m', 'direct']); }
        assert.notEqual(a.git(['rev-parse', 'HEAD']), b.git(['rev-parse', 'HEAD']));
      } finally { a.cleanup(); b.cleanup(); }
    });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('every commit in one repo keeps the same identity (the nonce is per repo, not per commit)', () => {
  const r = createTmpRepo();
  try {
    r.write('f.txt', '1\n'); r.commit('one');
    r.write('f.txt', '2\n'); r.commit('two');
    const idents = r.git(['log', '--format=%an <%ae> %cn <%ce>']).trim().split('\n');
    assert.equal(new Set(idents).size, 1);
  } finally { r.cleanup(); }
});
