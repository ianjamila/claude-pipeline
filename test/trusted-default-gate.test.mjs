// #448 / #430: the merge gate resolves the trusted default branch (risk.mjs#trustedDefaultBranch) ONCE per run and holds the PR's base and the local anchor against GitHub's own
// default branch. Through the real CLI against the scripted fake gh, with a real bare origin. The working-tree default_branch is the PR's to edit and never decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeGhPath } from './helpers/fakegh-env.mjs';
import { ghEntries, named, scenario, ymlFor } from './helpers/gate-env.mjs';
import { ymlWith } from './helpers/ci-proof-env.mjs';
import { ciEntries } from './helpers/ci-proof-merge-env.mjs';
import { addOrigin, breakOrigin } from './helpers/origin.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createQueueRoute } from '../pipeline/lib/queue-route.mjs';
import { DEFAULTS } from '../pipeline/lib/config.mjs';

// A gate scenario with a bare origin (origin/HEAD -> main unless `head: false`) holding main. `yml` is committed on the base like the rest of the scenario.
function world(t, { yml, head = true, gh, ...rest } = {}) {
  return scenario({ yml, gh, ...rest, afterReport: (repo) => addOrigin(t, repo, { head }) });
}
const prOpen = (s) => named(s.gate().json, 'pr-open');

test('pr-open: a PR whose working-tree default_branch names its own base is refused', (t) => {
  const s = world(t, { yml: `${ymlFor()}default_branch: release\n`, gh: { base: 'release' } });
  const c = prOpen(s);
  assert.equal(c.ok, false);
  assert.match(c.detail, /PR base is "release", not main/);
});

test('pr-open: an untrusted anchor refuses with the remedy', (t) => {
  const s = world(t, { head: false });
  breakOrigin(s.repo); // no origin/HEAD, and `git ls-remote --symref origin HEAD` fails
  const c = prOpen(s);
  assert.equal(c.ok, false);
  assert.match(c.detail, /default branch not anchored: the default branch could not be anchored on the remote .*git remote set-head origin -a/);
});

test('pr-open: a stale origin/HEAD that disagrees with GitHub refuses', (t) => {
  const s = world(t);
  s.repo.git(['push', '-q', 'origin', 'main:refs/heads/oldmain']);
  s.repo.git(['fetch', '-q', 'origin']);
  s.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/oldmain']); // resolvable, but GitHub's default is main
  const c = prOpen(s);
  assert.equal(c.ok, false);
  assert.match(c.detail, /the local default branch "oldmain" \(origin-head\) is not GitHub's default "main": fix with `git remote set-head origin -a`/);
});

test("pr-open: a renamed origin remote (config anchor) whose value differs from GitHub's default refuses", (t) => {
  const s = world(t, { yml: `${ymlFor()}default_branch: trunk\n` });
  s.repo.git(['branch', 'trunk', 'main']);
  s.repo.git(['remote', 'rename', 'origin', 'upstream']); // no origin remote: the working-tree value is the only source
  const c = prOpen(s);
  assert.equal(c.ok, false);
  assert.match(c.detail, /the local default branch "trunk" \(config\) is not GitHub's default "main"/);
});

test("pr-open: GitHub's default branch unreadable fails closed", (t) => {
  const s = world(t, { gh: { extra: [{ match: '^repo view', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] } });
  const r = s.gate();
  const c = named(r.json ?? { checks: [] }, 'pr-open');
  assert.ok(c, `${r.stderr}${r.stdout}`);
  assert.equal(c.ok, false);
  assert.match(c.detail, /could not read GitHub's default branch/);
});

test('pr-open: the same setup with every answer agreeing passes and records trustedBranch', (t) => {
  const s = world(t);
  const r = s.gate();
  assert.equal(named(r.json, 'pr-open').ok, true, JSON.stringify(r.json.checks.filter((c) => !c.ok)));
  assert.equal(r.json.trustedBranch, 'main');
  assert.equal(s.gateFile().trustedBranch, 'main', 'merge.mjs reads it back from the gate file');
});

test('ci-proof settings are read from the trusted branch even when the working tree names another', (t) => {
  // The PR's working tree names default_branch "granting", whose committed settings would grant a CI proof; main (the trusted branch) grants none.
  const s = scenario({
    yml: ymlFor(),
    report: (r) => { r.steps[3] = { ...r.steps[3], status: 'skipped', skipKind: 'ci', skipReason: 'deferred to CI (.github/workflows/ci.yml#Unit tests)', exitCode: null }; },
    change: (repo) => {
      repo.write('src/app.js', 'export const a = 2;\n');
      repo.write('.claude/pipeline.yml', `${ymlWith()}default_branch: granting\n`);
    },
    afterReport: (repo) => {
      addOrigin(t, repo);
      repo.git(['push', '-q', 'origin', 'HEAD:refs/heads/granting']); // the PR's own commit (settings that grant the proof) on the branch it names
      repo.git(['fetch', '-q', 'origin']);
    },
  });
  s.fake.setScript([...ciEntries(s, [{ id: 101, number: 5 }]), ...ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles })]);
  const c = named(s.gate().json, 'verify-report');
  assert.equal(c.ok, false, c.detail);
  assert.match(c.detail, /ci-proof-missing:unit \(origin\/main does not list unit in verify\.deferrable_steps\)/);
});

// A gh wrapper that, on the first branch-protection read (the gate's preflight check, after the branch was resolved), re-points origin/HEAD at another branch: a gate that
// re-resolved the default branch per check would measure the later checks from "release" (a commit that differs from main's).
function flippingGh(t, repoDir) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-flipgh-'));
  const flag = join(dir, 'flipped');
  const file = join(dir, 'gh-flip.mjs');
  writeFileSync(file, [
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync, writeFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    `const r = spawnSync(process.execPath, [${JSON.stringify(fakeGhPath)}, ...argv], { stdio: 'inherit' });`,
    `if (argv.join(' ').includes('branches/main/protection') && !existsSync(${JSON.stringify(flag)})) {`,
    `  writeFileSync(${JSON.stringify(flag)}, '');`,
    `  spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release'], { cwd: ${JSON.stringify(repoDir)} });`,
    '}',
    'process.exit(r.status ?? 1);',
    '',
  ].join('\n'));
  return { PIPELINE_GH: `node "${file}"` };
}

test('gate consistency: a default branch that moves mid-gate changes nothing; the checks, trustedBranch and the merge-time hash all use the one resolved branch', (t) => {
  const s = world(t);
  s.repo.git(['push', '-q', 'origin', 'HEAD:refs/heads/release']); // release = the PR head: measured from it, the diff is empty and the hash differs
  s.repo.git(['fetch', '-q', 'origin']);
  Object.assign(s.env, flippingGh(t, s.repo.dir)); // the gate's CLI runs read this env
  const r = s.gate();
  assert.equal(r.json.trustedBranch, 'main');
  assert.equal(r.json.contentHash, s.hash, 'the hash the gate measured is the one from main');
  assert.equal(r.json.ok, true, JSON.stringify(r.json.checks.filter((c) => !c.ok)));
  assert.equal(s.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD']).trim(), 'refs/remotes/origin/release', 'the flip did happen during the gate');
  assert.equal(s.gateFile().trustedBranch, 'main');
});

test('merge reads the gate file\'s trustedBranch for its own hash: a gate file naming another branch refuses the merge as a changed patch', (t) => {
  const s = world(t);
  const r = s.gate();
  assert.equal(r.json.ok, true, JSON.stringify(r.json.checks.filter((c) => !c.ok)));
  s.repo.git(['branch', 'other', 'HEAD']); // measured from "other" (= the PR head) the diff is empty: a different hash
  s.editGate((g) => { g.trustedBranch = 'other'; });
  const m = s.merge();
  assert.notEqual(m.code, 0, m.stdout);
  assert.match(m.stdout + m.stderr, /the patch changed since the gate ran \(content hash differs\)/);
  assert.equal(s.mergeCalls().length, 0, 'nothing was merged');
});

test("queue route: the merge queue's branch rules are asked for the trusted default branch, not a working-tree default_branch edit", (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('a.txt', 'x\n');
  repo.commit('init');
  addOrigin(t, repo); // origin/HEAD -> main
  const asked = [];
  const gh = { repo: () => ({ slug: 'acme/widgets' }), repoId: () => 42, branchRules: (b) => { asked.push(b); return []; } };
  createQueueRoute({
    gh, root: repo.dir, config: { merge: { ...DEFAULTS.merge }, default_branch: 'evil' }, pr: 12, head: 'a'.repeat(40), route: 'owner-go', env: {},
    refuse: () => ({}), approval: {}, recheck: async () => ({ ok: true }),
  });
  assert.deepEqual(asked, ['main']);
});
