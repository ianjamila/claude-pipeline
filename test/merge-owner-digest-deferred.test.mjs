// Issue #417: the items digest `P merge --pr N --dry-run` shows must be the one the real final gate / merge computes. A deferred verify
// step (verify.deferrable_steps + ci_proof) makes the REAL gate run `git fetch origin <base>` in the middle of its evaluation (the proof
// settings are read from the base); the dry run fetches nothing. The gate's content hash is taken before that fetch, so its diff must be
// taken against the same base: otherwise the hard-stop / integrity scan sees main's new commits only in one of the two runs, and the owner
// is shown a digest the real merge does not check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertExit } from './helpers/assert-exit.mjs';
import { cli, ghEntries, reviewState, PR } from './helpers/gate-env.mjs';
import { ciRow, setup, ymlWith } from './helpers/ci-proof-env.mjs';
import { ciEntries } from './helpers/ci-proof-merge-env.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { localContentHash } from '../pipeline/lib/finalgate.mjs';
import { saveState } from '../pipeline/lib/state.mjs';

const chatYml = () => `${ymlWith()}hard_stops:\n  paths: ['src/**']\nowner_approval: chat\n`;
const b64 = (text) => Buffer.from(text).toString('base64');

// main moves on (src/other.js, a hard-stop path), the PR branch merges it, and the local origin/main is left at the OLD main: the
// state a clone is in when GitHub's "update branch" put main into the PR and nothing has fetched yet.
function world() {
  let oldMain = null;
  const s = setup({
    yml: chatYml(),
    report: ciRow,
    change: (repo) => {
      oldMain = repo.git(['rev-parse', 'main']).trim();
      repo.git(['checkout', '-q', 'main']);
      repo.write('src/other.js', 'export const other = 1;\n');
      repo.commit('main moves on');
      repo.git(['checkout', '-q', 'agent/feature']);
      repo.git(['merge', '-q', '--no-ff', '-m', 'merge main into the PR', 'main']);
      repo.write('docs/guide.md', '# Guide\n\nchanged\n');
    },
  });
  s.oldMain = oldMain;
  return s;
}

test('#417: a deferred step\'s fetch does not change the items digest: the dry run shows the digest the real final gate computes', async () => {
  const s = world();
  const { config } = await loadConfig(s.repo.dir);
  const git = (a) => s.repo.git(a).trim();
  // The scenario made the state and the report against a fresh main; the clone is stale: re-take the review hash from what the gate reads first.
  git(['update-ref', 'refs/remotes/origin/main', s.oldMain]);
  saveState(s.repo.dir, reviewState(localContentHash(s.repo.dir, config)));
  assert.equal(git(['rev-parse', 'origin/main']), s.oldMain, 'the clone has not seen the new main');

  const prReply = { state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefOid: s.baseTip };
  s.fake.setScript([
    ...ciEntries(s, [{ id: 101, number: 5 }]),
    { match: `repos/acme/widgets/contents/\\.claude/pipeline\\.yml\\?ref=${s.baseTip}`, stdoutJson: ['file', 'base64', b64(chatYml())] },
    { match: '^pr view 12 --json state,headRefOid.*baseRefOid', stdoutJson: prReply },
    ...ghEntries({ prHead: s.head, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', baseOid: s.baseTip }),
  ]);

  // The dry run first (no final-gate.json yet: it reports that blocker, but the live evaluation and its digest are there to read).
  const dry = cli(['merge', '--pr', String(PR), '--dry-run'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  assert.equal(typeof dry.json?.ownerItems, 'string', `${dry.stderr}${dry.stdout}`);
  assert.equal(git(['rev-parse', 'origin/main']), s.oldMain, 'the dry run fetched nothing');

  const gate = cli(['final-gate', '--pr', String(PR)], { dir: s.repo.dir, fake: s.fake, env: s.env });
  assertExit(gate, 0, `${gate.stderr}${gate.stdout}`);
  assert.equal(git(['rev-parse', 'origin/main']), s.baseTip, 'the deferred step\'s proof read the base: the real gate fetched it');

  assert.equal(dry.json.ownerItems, gate.json.ownerItems, 'dry run and final gate agree on the owner items');
});

// What the real gated merge refuses ("the owner items changed since ... said merge") the dry run must report too, not say wouldMerge.
test('#417: the dry run refuses like the real merge when the live owner items are not the ones final-gate.json recorded', () => {
  const s = setup({ yml: chatYml(), report: ciRow });
  s.fake.setScript([
    ...ciEntries(s, [{ id: 101, number: 5 }]),
    { match: `repos/acme/widgets/contents/\\.claude/pipeline\\.yml\\?ref=${s.baseTip}`, stdoutJson: ['file', 'base64', b64(chatYml())] },
    { match: '^pr view 12 --json state,headRefOid.*baseRefOid', stdoutJson: { state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefOid: s.baseTip } },
    ...ghEntries({ prHead: s.head, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', baseOid: s.baseTip }),
  ]);
  const gate = cli(['final-gate', '--pr', String(PR)], { dir: s.repo.dir, fake: s.fake, env: s.env });
  assertExit(gate, 0, `${gate.stderr}${gate.stdout}`);
  const same = cli(['merge', '--pr', String(PR), '--dry-run'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  assert.equal(same.json.ownerItems, gate.json.ownerItems);
  assert.deepEqual(same.json.blockers, [], `${same.stdout}`);

  s.editGate((g) => { g.ownerItems = '0'.repeat(12); }); // an item was added or swapped since the gate ran
  const moved = cli(['merge', '--pr', String(PR), '--dry-run'], { dir: s.repo.dir, fake: s.fake, env: s.env });
  assert.equal(moved.json.wouldMerge, false, moved.stdout);
  assert.match(JSON.stringify(moved.json.blockers), /owner items changed since final-gate\.json/);
});
