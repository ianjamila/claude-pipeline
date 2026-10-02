// The R3' content hash has exactly one definition (git.mjs#reviewContentHash). The review loop and the final gate both
// reach it through their own entry point (currentContentHash / localContentHash); this proves the two can never
// disagree about "the code that was reviewed", whatever the branch looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentContentHash } from '../pipeline/lib/review-context.mjs';
import { localContentHash } from '../pipeline/lib/finalgate.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

const LOG = 'docs/agent-log.md';
const config = { default_branch: 'main', agent_log: LOG };

function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  repo.write(LOG, '# log\n');
  repo.commit('base');
  repo.branch('feat/x');
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n');
  repo.commit('edit');
  return repo;
}

const both = (repo) => {
  const a = currentContentHash(repo.dir, config);
  const b = localContentHash(repo.dir, config);
  assert.equal(a, b, 'review loop and final gate hash the same branch differently');
  assert.match(a, /^[0-9a-f]{64}$/);
  return a;
};

test('review-loop and final-gate hashes are identical across the scenarios that matter', (t) => {
  const repo = world(t);
  const h0 = both(repo);

  // agent_log exclusion: a change to the log moves neither hash
  repo.write(LOG, '# log\nentry\n');
  repo.commit('log');
  assert.equal(both(repo), h0, 'the agent log is excluded from both');

  // whitespace-only change to a reviewed file: both notice
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN \n');
  repo.commit('trailing space');
  const h1 = both(repo);
  assert.notEqual(h1, h0, 'whitespace is covered');

  // a binary file
  repo.write('img.bin', Buffer.from([0, 1, 2, 0xfe, 0xfd, 0, 0xff]).toString('latin1'));
  repo.commit('binary');
  const h2 = both(repo);
  assert.notEqual(h2, h1);

  // base-only update (main moves on in an unrelated file, branch is NOT rebased): fork point is unchanged
  repo.checkout('main');
  repo.write('other/b.js', 'b\n');
  repo.commit('main moves');
  repo.checkout('feat/x');
  assert.equal(both(repo), h2, 'a base-only update leaves both hashes alone');

  // same with an origin/main remote ref that lags, then catches up
  repo.git(['update-ref', 'refs/remotes/origin/main', 'main']);
  assert.equal(both(repo), h2);
  repo.git(['update-ref', 'refs/remotes/origin/main', 'main~1']);
  assert.equal(both(repo), h2);
});

test('a config without an agent_log hashes the whole branch in both', (t) => {
  const repo = world(t);
  const bare = { default_branch: 'main' };
  assert.equal(currentContentHash(repo.dir, bare), localContentHash(repo.dir, bare));
  // and it differs from the excluded variant only when the log changed
  repo.write(LOG, '# log\nentry\n');
  repo.commit('log');
  assert.equal(currentContentHash(repo.dir, bare), localContentHash(repo.dir, bare));
  assert.notEqual(currentContentHash(repo.dir, bare), currentContentHash(repo.dir, config));
});
