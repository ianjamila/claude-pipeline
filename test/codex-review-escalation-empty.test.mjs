// R1-F1: a judge round that must now escalate to Fable reviews the whole PR even when the PR's own content has not changed since the last round
// (main's config change merged in cleanly makes it need Fable). It must not be refused as an empty range when no accepted item still waits for its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertExit } from './helpers/assert-exit.mjs';
import { findingsOf, low, roundWorld } from './helpers/round-world.mjs';

// main gains a hard-stop path for a file the PR changes and is merged in: the content is the same, but the PR now needs Fable. -> the merge commit.
function mainNeedsFable(w) {
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('.claude/pipeline.yml', `${w.repo.git(['show', 'HEAD:.claude/pipeline.yml'])}hard_stops:\n  paths: ["src/a.js"]\n`);
  w.repo.commit('main: src/a.js is a hard-stop path');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', 'main']);
  const merge = w.repo.git(['rev-parse', 'HEAD']).trim();
  w.prHead(merge);
  return merge;
}

test('codex-review: the judge-to-Fable escalation with unchanged content and every accepted item fixed is recorded as a whole-PR round, not refused as empty-range (R1-F1)', (t) => {
  const w = roundWorld(t, { max: 3 });
  const fixed = w.reviewAndFix(1, w.base, w.head, [low({ title: 'Issue 1' })]);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: fixed }), 0); // round 2 reviews the fix, clean, still by the judge
  assert.equal(w.state().reviewer, 'judge');
  const merge = mainNeedsFable(w);
  const r = w.codex(3, findingsOf(), { from: fixed, to: merge });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.reviewer, 'fable');
  const round = w.state().rounds.at(-1);
  assert.deepEqual([round.fableRequired, round.reviewBaseKind], [true, 'whole-pr']);
});

test('codex-review: the same escalation is still refused while an accepted item waits for its fix (R1-F1)', (t) => {
  const w = roundWorld(t, { max: 3 });
  const found = w.codex(1, findingsOf([], [low({ title: 'Issue 1' })]));
  assertExit(found, 0, found.stderr + found.stdout);
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'] }), 0);
  const merge = mainNeedsFable(w);
  const r = w.codex(2, findingsOf(), { from: w.head, to: merge });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.error, 'empty-range');
  assert.match(r.json.message, /still need a fix: commit the fix for R1-S1 first/);
});
