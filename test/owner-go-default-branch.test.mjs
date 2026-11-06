// F2 (plan 2026-11-05-merge-survives-main-reviewed section 8): for --owner-go the pr-open check compares the PR's base with the default branch GITHUB names,
// never with config.default_branch (the config is the PR's own file and an agent can edit it). A gh answer with no default branch fails closed.
// The gated route (evaluateGate) keeps comparing with the config, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, ghEntries, scenario, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { evaluateOwnerGo } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';

const repoView = (name) => ({ match: '^repo view', stdoutJson: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name }, url: 'https://github.com/acme/widgets' } });
const dry = (s) => cli(['merge', '--pr', String(PR), '--dry-run', '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: s.env });
const prOpen = (r) => r.json.blockers.map((b) => b.detail).filter((d) => d.startsWith('pr-open:')).join('\n');

test('--owner-go, the PR targets the branch the CONFIG calls default but GitHub names another: pr-open refuses (config is agent-editable)', () => {
  const s = scenario({ report: null, state: null, gh: { mergeStateStatus: 'CLEAN', extra: [repoView('trunk')] } });
  s.fake.setScript(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', extra: [repoView('trunk')] }));
  const r = dry(s);
  assertExit(r, 1);
  assert.match(prOpen(r), /PR base is "main", not the default branch "trunk" \(GitHub's\)/);
});

test('--owner-go, the PR targets the branch GitHub names default while the config says another: pr-open passes the base comparison', () => {
  const s = scenario({ report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });
  s.fake.setScript(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, mergeStateStatus: 'CLEAN', base: 'trunk', extra: [repoView('trunk')] }));
  const r = dry(s);
  assert.doesNotMatch(prOpen(r), /PR base is/);
});

test('--owner-go, GitHub names no default branch: pr-open fails closed', async () => {
  const s = scenario({ report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });
  const { config } = await loadConfig(s.repo.dir);
  const view = { state: 'OPEN', headRefOid: s.head, baseRefName: 'main', baseRefOid: s.baseTip, isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  const base = { prView: () => view, repo: () => ({ slug: 'acme/widgets', host: 'github.com', defaultBranch: 'main' }) };
  for (const defaultBranch of [undefined, null, '']) {
    const gh = { ...base, repo: () => ({ slug: 'acme/widgets', host: 'github.com', defaultBranch }) };
    const live = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh, env: s.env });
    const c = live.checks.find((x) => x.name === 'pr-open');
    assert.equal(c.ok, false, `defaultBranch ${JSON.stringify(defaultBranch)}`);
    assert.match(c.detail, /GitHub did not name the repository's default branch/);
  }
});

test('the gated route is unchanged: it still compares the PR base with config.default_branch, whatever GitHub names', () => {
  const same = scenario({ gh: { mergeStateStatus: 'CLEAN', extra: [repoView('trunk')] } });
  const ok = same.gate();
  assert.doesNotMatch(JSON.stringify(ok.json), /PR base is/);
  const other = scenario({ gh: { mergeStateStatus: 'CLEAN', base: 'trunk', extra: [repoView('trunk')] } });
  const bad = other.gate();
  assert.match(JSON.stringify(bad.json), /PR base is \\"trunk\\", not main/);
});
