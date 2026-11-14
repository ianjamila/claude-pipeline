// R2 hand-off: review-complete and `triage second-review` read the trusted fork point (mergeBase(origin/<remote's default branch>, HEAD)) for the Codex model / substitute gates, so they refresh
// origin/<that branch> first (best effort), like codex-review's admission. The remote's default branch here (trunk) is NOT the working-tree config's default_branch (main), which the commands'
// older refresh (review-context.mjs#refreshBaseRef) already fetched: only the trusted-default refresh moves origin/trunk. Both commands refuse (no review state) AFTER the point where they fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roundWorld } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

// -> { w, a, b }: the remote's default branch trunk is at b, the local origin/trunk at a (not fetched since).
function staleTrunkWorld(t) {
  const w = roundWorld(t, { max: 3 });
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-origin-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { repo } = w;
  repo.git(['init', '-q', '--bare', '-b', 'trunk', dir]);
  repo.git(['remote', 'add', 'origin', dir]);
  repo.git(['checkout', '-q', '-b', 'trunk', 'main']);
  repo.git(['push', '-q', 'origin', 'trunk']);
  repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  const a = repo.git(['rev-parse', 'trunk']).trim();
  repo.write('src/trunk.js', 'export const trunk = 1;\n');
  const b = repo.commit('trunk moves');
  repo.git(['push', '-q', 'origin', 'trunk']);
  repo.git(['update-ref', 'refs/remotes/origin/trunk', a]);
  repo.git(['checkout', '-q', 'feat/x']);
  w.prHead(repo.git(['rev-parse', 'HEAD']).trim());
  return { w, a, b };
}
const originTrunk = (w) => w.repo.git(['rev-parse', 'refs/remotes/origin/trunk']).trim();

test('review-complete refreshes origin/<the remote\'s default branch> before it reads the trusted fork point', (t) => {
  const { w, b } = staleTrunkWorld(t);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout); // no review state: refused, after the refresh
  assert.equal(originTrunk(w), b);
});

test('triage second-review refreshes origin/<the remote\'s default branch> before it reads the trusted model', (t) => {
  const { w, b } = staleTrunkWorld(t);
  const r = w.cli(['triage', 'second-review', '--round', '1', '--ids', 'R1-B1', '--pr', '7']);
  assertExit(r, 2, r.stderr + r.stdout); // no review state: refused, after the refresh
  assert.equal(originTrunk(w), b);
});

test('a failed refresh is not an error: an unreachable origin leaves the cached ref and the same refusal', (t) => {
  const { w, a } = staleTrunkWorld(t);
  w.repo.git(['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'cp-no-such-origin-dir')]);
  for (const [args, code] of [[['review-complete', '--pr', '7'], 1], [['triage', 'second-review', '--round', '1', '--ids', 'R1-B1', '--pr', '7'], 2]]) {
    const r = w.cli(args);
    assertExit(r, code, r.stderr + r.stdout);
    assert.equal(r.json.ok, false);
  }
  assert.equal(originTrunk(w), a);
});
