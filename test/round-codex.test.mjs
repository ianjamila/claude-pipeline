// `pipeline round codex` (plan C §1): the real CLI against a throwaway repo, a fake gh and a scripted fake Codex (test/helpers/round-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { roundWorld, findingsOf, low } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const ok = (w, findings = findingsOf([], [low()]), name = 'f.json') => ({ FAKE_CODEX_OUTPUT: w.file(name, findings) });
const roundCodex = (w, extra = [], env = {}) => w.cli(['round', 'codex', '--pr', '7', '--round', '1', ...extra], env);

test('round 1 with no state runs plan, job and wait and reports counts, path and reviewer', (t) => {
  const w = roundWorld(t, { max: 3 });
  const r = roundCodex(w, [], ok(w));
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.codex.counts, { blocking: 0, suggestions: 1, worth_considering: 0 });
  assert.match(r.json.codex.codexPath, /round-1$/);
  assert.equal(r.json.reviewer, 'judge');
  assert.equal(w.state().rounds.length, 1);
  assert.equal(w.state().rounds[0].fromHead, w.base);
});
