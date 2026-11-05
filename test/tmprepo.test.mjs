import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('every commit in one repo keeps the same identity (the nonce is per repo, not per commit)', () => {
  const r = createTmpRepo();
  try {
    r.write('f.txt', '1\n'); r.commit('one');
    r.write('f.txt', '2\n'); r.commit('two');
    const idents = r.git(['log', '--format=%an <%ae> %cn <%ce>']).trim().split('\n');
    assert.equal(new Set(idents).size, 1);
  } finally { r.cleanup(); }
});
