// Issue #287: the default branch merged in BETWEEN the fix and its revert. The anchor used to be the newest round whose head the fix descends from (the reviewed head, which lacks
// the merge), so the follow-up issue's `git diff <anchor> <fix head>` showed the merge too. The comparison point must be the one whose merged-in default branch matches the fix head's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertExit } from './helpers/assert-exit.mjs';
import { aFile, findingsOf, roundWorld } from './helpers/round-world.mjs';

test('defer-fixes: main merged in between the fix and the revert: the issue compares the revert (the base-only round) with the merge, i.e. just the fix (#287)', (t) => {
  const w = roundWorld(t);
  const { h1, h2 } = w.atCap();
  // main moves and is merged into the branch on top of the fix: M holds the fix and main's change
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('src/a.js', aFile(false).replace('export const v10 = 10;', 'export const v10 = 1000;'));
  w.repo.commit('main edits near the PR');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', 'main']);
  const merge = w.repo.git(['rev-parse', 'HEAD']).trim();
  // the fix is taken out, the update is recorded as a base-only round at the revert
  const revert = w.revert(h2);
  w.prHead(revert);
  const base = w.codex(3, findingsOf(), { from: h1, to: revert });
  assertExit(base, 0, base.stderr + base.stdout);
  assert.equal(w.state().rounds.at(-1).baseOnly, true);
  const ok = w.cli(['triage', 'defer-fixes', '--pr', '7', '--ids', 'R2-S1', '--fix-head', merge, '--reason', 'minor, file it']);
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.deepEqual(ok.json.warnings ?? [], []);
  const item = w.item('R2-S1');
  assert.deepEqual([item.final.claude.reviewedHead, item.roundCapDeferral.reviewedHead, item.roundCapDeferral.fixHead], [revert, revert, merge]);
  const filed = w.cli(['followups', 'create', '--round', '2']);
  assertExit(filed, 0, filed.stderr + filed.stdout);
  const post = w.fake.calls().find((c) => c.argv.join(' ').startsWith(`api -X POST repos/${w.slug}/issues `));
  assert.ok(JSON.parse(post.stdin).body.includes(`git diff ${revert} ${merge}`), JSON.parse(post.stdin).body);
});

test('defer-fixes: main merged in between the fix and the revert without moving the PR\'s content (no base-only round): the anchor stays the reviewed head and the compare warning is returned (R1-F1)', (t) => {
  const w = roundWorld(t);
  const { h1, h2 } = w.atCap();
  // main changes a file the PR does not touch and is merged in on top of the fix: the PR's own patch (and so the content hash) is unchanged
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('src/other.js', 'export const other = 1;\n');
  w.repo.commit('main edits elsewhere');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', 'main']);
  const merge = w.repo.git(['rev-parse', 'HEAD']).trim();
  const revert = w.revert(h2);
  w.prHead(revert);
  assert.equal(w.state().rounds.at(-1).baseOnly, undefined, 'no base-only round was recorded');
  const ok = w.cli(['triage', 'defer-fixes', '--pr', '7', '--ids', 'R2-S1', '--fix-head', merge, '--reason', 'minor, file it']);
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.equal((ok.json.warnings ?? []).length, 1, JSON.stringify(ok.json.warnings));
  assert.match(ok.json.warnings[0], /the default branch merged into the fix head is not the same one/);
  // the last round (not HEAD) was reviewed before the merge, so it is not a better anchor than the one found by ancestry
  assert.equal(w.item('R2-S1').roundCapDeferral.reviewedHead, h1);
});
