// The ask's Open line and open[].severity (round-request) and the park comment's Open line judge severity under the trusted base config too (#337):
// an unreadable base config shows every open item as high (and drops the park comment's Open line), and a PR that drops a glob from its own
// risk.high_risk_paths still shows an item on that path as not low. Real CLI, real git, fake gh (test/helpers/round-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { roundWorld } from './helpers/round-world.mjs';

const ask = (w) => {
  const r = w.cli(['triage', 'round-request', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  return r.json;
};
const park = (w) => {
  const r = w.cli(['comment', '--pr', '7', '--kind', 'needs-human', '--reason', 'the owner decides']);
  assertExit(r, 0, r.stderr + r.stdout);
  return w.fake.comments().map((c) => c.body).find((b) => b.startsWith(MARKERS.needsHuman));
};

test('round-request and the park comment: an unreadable trusted base config shows every open item as high, with the warning, and drops the park Open line (#337 sequence 1)', (t) => {
  const w = roundWorld(t);
  w.atCap();
  assert.equal(ask(w).open[0].severity, 'low', 'with a readable base config the item is low');
  // main drops the config and is merged into the PR, which keeps its own copy: the fork point has no pipeline.yml, the working tree does
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.git(['rm', '-q', '.claude/pipeline.yml']);
  w.repo.commit('main drops the config');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', '--no-commit', 'main']);
  w.repo.git(['checkout', 'HEAD', '--', '.claude/pipeline.yml']);
  w.repo.commit('merge main, keep the config');
  const a = ask(w);
  assert.equal(a.recommend, 'extra-round');
  assert.equal(a.open[0].severity, 'high');
  assert.doesNotMatch(a.summary, /: (all )?low severity\./);
  assert.equal(a.warnings.filter((x) => x.startsWith('severity could not be judged: the trusted base config is unreadable')).length, 1, JSON.stringify(a.warnings));
  const body = park(w);
  assert.match(body, /^- Open: not available \(severity could not be judged\)\.$/m);
  assert.doesNotMatch(body, /Open: R2-S1/);
});

test('round-request and the park comment: a PR that drops a glob from its own risk.high_risk_paths still shows the item as not low (#337 sequence 2)', (t) => {
  const w = roundWorld(t);
  w.atCap();
  assert.equal(ask(w).open[0].severity, 'low');
  // main gains the sensitive path in its config and is merged into the PR, which keeps its own copy without it: the fork point lists src/big.js, the working tree does not
  w.repo.git(['checkout', '-q', 'main']);
  w.repo.write('.claude/pipeline.yml', `${w.repo.git(['show', 'HEAD:.claude/pipeline.yml'])}risk:\n  high_risk_paths: ["src/big.js"]\n`);
  w.repo.commit('main marks src/big.js sensitive');
  w.repo.git(['checkout', '-q', 'feat/x']);
  w.repo.git(['merge', '--no-edit', '--no-commit', 'main']);
  w.repo.git(['checkout', 'HEAD', '--', '.claude/pipeline.yml']);
  w.repo.commit('merge main, keep the config');
  const a = ask(w);
  assert.equal(a.open[0].severity, 'high', JSON.stringify(a.open));
  assert.doesNotMatch(a.summary, /: (all )?low severity\./);
  assert.match(park(w), /^- Open: R2-S1 \(SUGGESTIONS, maintainability\): 1 of 1 not low severity \(R2-S1\)\.$/m);
});
