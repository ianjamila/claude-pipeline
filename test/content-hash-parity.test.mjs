// The R3' content hash has exactly one definition (git.mjs#reviewContentHash). The review loop and the final gate both
// reach it through their own entry point (currentContentHash / localContentHash); this proves the two can never
// disagree about "the code that was reviewed", whatever the branch looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { currentContentHash } from '../pipeline/lib/review-context.mjs';
import { localContentHash } from '../pipeline/lib/finalgate.mjs';
import { GitError, reviewContentHash } from '../pipeline/lib/git.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { addOrigin, breakOrigin } from './helpers/origin.mjs';

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

test('an explicit head hashes a commit that is not checked out exactly like checking it out', (t) => {
  const repo = world(t);
  const sha1 = repo.git(['rev-parse', 'HEAD']).trim();
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN \n');
  const sha2 = repo.commit('trailing space');
  const args = { branch: 'main', agentLog: LOG };
  const o = { cwd: repo.dir };

  // HEAD is sha2; ask about sha1 without moving HEAD, then compare with the checked-out path
  const viaHead = reviewContentHash({ ...args, head: sha1 }, o);
  assert.notEqual(viaHead, reviewContentHash(args, o), 'the two commits differ, so the test is not vacuous');
  repo.checkout(sha1);
  assert.equal(viaHead, currentContentHash(repo.dir, config));
  assert.equal(viaHead, localContentHash(repo.dir, config));
  repo.checkout('feat/x');
  assert.equal(reviewContentHash({ ...args, head: sha2 }, o), currentContentHash(repo.dir, config));
  assert.equal(reviewContentHash({ ...args, head: 'HEAD' }, o), reviewContentHash(args, o));
});

test('a commit that only adds a line to the agent log hashes equal to its parent', (t) => {
  const repo = world(t);
  const parent = repo.git(['rev-parse', 'HEAD']).trim();
  repo.write(LOG, '# log\nentry\n');
  const logOnly = repo.commit('log');
  const args = { branch: 'main', agentLog: LOG };
  const o = { cwd: repo.dir };
  assert.equal(reviewContentHash({ ...args, head: logOnly }, o), reviewContentHash({ ...args, head: parent }, o));
  // without the exclusion the log line is visible
  assert.notEqual(
    reviewContentHash({ branch: 'main', head: logOnly }, o),
    reviewContentHash({ branch: 'main', head: parent }, o),
  );
});

test('an explicit baseSha equals the default when it names the same commit', (t) => {
  const repo = world(t);
  const mainSha = repo.git(['rev-parse', 'main']).trim();
  const args = { branch: 'main', agentLog: LOG };
  const o = { cwd: repo.dir };
  const dflt = reviewContentHash(args, o);
  assert.equal(reviewContentHash({ ...args, baseSha: mainSha }, o), dflt);
  assert.equal(reviewContentHash({ ...args, head: 'HEAD', baseSha: mainSha }, o), dflt);
  // a different base gives a different hash
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN \n');
  repo.commit('more');
  assert.notEqual(reviewContentHash({ ...args, baseSha: 'HEAD~1' }, o), reviewContentHash({ ...args, baseSha: mainSha }, o));
});

// Default limits: 5 MiB of random bytes in a listed format is a large binary document, so diffFiles-style skipping applies to
// both entry points alike, and the hash must still follow the bytes (a blob id stands in for them).
test('review-loop and final-gate hashes stay identical, and follow the bytes, when the branch holds a large binary document', (t) => {
  const repo = world(t);
  const h0 = both(repo);

  repo.write('exports/data.xlsx', randomBytes(5 * 1024 * 1024));
  repo.commit('add a large sheet');
  const h1 = both(repo);
  assert.notEqual(h1, h0, 'an added large binary is covered');

  repo.write('exports/data.xlsx', randomBytes(5 * 1024 * 1024));
  repo.commit('replace it with other bytes of the same size');
  const h2 = both(repo);
  assert.notEqual(h2, h1, 'new bytes move the hash');

  repo.rm('exports/data.xlsx');
  repo.commit('drop it again');
  assert.equal(both(repo), h0, 'a skipped file leaves no residue once it is gone from the range');
});

// ---- the branch both hashes measure from is the trusted one (#448), never the working-tree default_branch a PR can edit ----

const hashes = (repo, cfg) => [currentContentHash(repo.dir, cfg), localContentHash(repo.dir, cfg)];

test('a working-tree default_branch edit moves neither hash', (t) => {
  const repo = world(t);
  addOrigin(t, repo);
  repo.git(['push', '-q', 'origin', 'HEAD:refs/heads/evil']); // origin/evil sits on the PR head: measured from it, the patch would be empty
  repo.git(['fetch', '-q', 'origin']);
  const trusted = both(repo);
  const [a, b] = hashes(repo, { default_branch: 'evil', agent_log: LOG });
  assert.equal(a, trusted);
  assert.equal(b, trusted);
});

test('an untrusted anchor (origin remote, no origin/HEAD, ls-remote fails) hashes from the config value in both, no throw', (t) => {
  const repo = world(t);
  addOrigin(t, repo, { head: false });
  breakOrigin(repo); // before the first read: ls-remote answers are remembered per process
  const expected = reviewContentHash({ branch: 'main', agentLog: LOG }, { cwd: repo.dir });
  // the same repository seen with the network gone: origin/HEAD absent, ls-remote fails -> the working-tree value
  const [a, b] = hashes(repo, config);
  assert.equal(a, expected);
  assert.equal(b, expected);
  // and it really is the config value that is read (the only anchor left): another branch there moves both, equally
  repo.git(['update-ref', 'refs/remotes/origin/other', 'HEAD']);
  const [c, d] = hashes(repo, { default_branch: 'other', agent_log: LOG });
  assert.notEqual(c, expected);
  assert.equal(c, d);
});

test('a base that resolves nowhere throws a GitError from both hash wrappers (no manufactured hash)', (t) => {
  const repo = world(t);
  const missing = { default_branch: 'no-such-branch', agent_log: LOG };
  assert.throws(() => currentContentHash(repo.dir, missing), GitError);
  assert.throws(() => localContentHash(repo.dir, missing), GitError);
});
