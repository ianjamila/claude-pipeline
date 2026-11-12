// A throwaway PR at its round limit, for the extra-round discipline tests (test/cli-triage-round-request.test.mjs, test/cli-triage-defer-fixes.test.mjs):
// the real CLI against a real git repo, a fake gh that remembers the PR's comments and a scripted fake codex (the setup of test/cli-triage-claude.test.mjs),
// with a repository name of its own (the owner's recorded chat words live in one shared folder and match on repository, PR and round: test/helpers/owner-go.mjs).
// maxRounds 1: round 1, then the one automatic extra round (2); both only accept fixes (`reviewAndFix`); round 3 then needs the owner.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createTmpRepo } from './tmprepo.mjs';
import { createCommentsGh, pipelineYml, REPO_VIEW } from './fakegh-env.mjs';
import { assertExit } from './assert-exit.mjs';
import { floorEnv } from './floor-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, '..', 'fixtures', 'fake-codex.mjs');

export const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
export const bFile = Array.from({ length: 8 }, (_, i) => `export const w${i + 1} = ${i + 1};`).join('\n') + '\n';
export const bigFile = Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n';
// A finding in src/big.js, which the PR changed (so its location resolves): a low-severity suggestion unless `over` says otherwise.
export const low = (over = {}) => ({
  title: 'Rename helper', file: 'src/big.js', line: 3, category: 'maintainability', detail: 'the name says nothing', reasoning: 'a clearer name helps', testable: false, ...over,
});
export const findingsOf = (blocking = [], suggestions = [], worth = []) => ({ summary: 'Reviewed.', blocking, suggestions, worth_considering: worth });
export const uniqueSlug = () => `acme/widgets-${randomUUID()}`;

// Every effort the config can pick is `high`, so the helpers' `--effort high` is always the configured one (the effort rule: test/cli-codex-review-effort.test.mjs);
// a review block that sets `effort:` itself replaces it.
const EFFORT_HIGH = '  effort: {low: high, medium: high, high: high, followup: high, small_fix: high}\n';
// opts.review: extra lines for the `review:` block of pipeline.yml (after max_rounds); opts.yml: extra top-level lines; opts.comments: PR comments the fake holds at the start.
export function roundWorld(t, { max = 1, review = '', yml = '', comments = [], slug = uniqueSlug(), mode = 'chat' } = {}) {
  const repo = createTmpRepo({ highEffort: true });
  t.after(() => repo.cleanup());
  const ymlOf = (more = {}) => `${pipelineYml()}review:\n  max_rounds: ${max}\n${(more.review ?? review).includes('  effort:') ? '' : EFFORT_HIGH}${more.review ?? review}${more.yml ?? yml}${mode === 'chat' ? 'owner_approval: chat\n' : ''}`;
  repo.write('.claude/pipeline.yml', ymlOf());
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/big.js', bigFile);
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-round-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const issueUrl = (n) => `https://github.com/${slug}/issues/${n}`;
  const script = (sha) => [
    { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'main', headRefOid: sha } },
    { match: '^repo view', stdoutJson: { ...REPO_VIEW, nameWithOwner: slug, url: `https://github.com/${slug}` } },
    { match: '^pr edit 7 ', code: 0 },
    { match: `^api repos/${slug}/issues\\?creator=me&state=all&per_page=100 --paginate`, stdout: '[]' },
    { match: `^api -X POST repos/${slug}/issues `, stdoutJson: { number: 31, html_url: issueUrl(31) } },
    { match: '^pr edit 7 --remove-label', code: 0 },
  ];
  const fake = createCommentsGh(script(head), { comments });
  const lockDir = join(scratch, 'locks');
  const w = {
    repo, base, head, scratch, slug, fake, issueUrl,
    cli(args, env = {}) {
      const merged = { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: lockDir, ...floorEnv(), ...env };
      for (const k of ['PIPELINE_TEST_FORCE_ARBITER', 'PIPELINE_TEST_MODE', 'FAKE_CODEX_OUTPUT']) if (!(k in env)) delete merged[k];
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json says so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    codex(round, findings, { from = base, to = head } = {}) {
      return w.cli(['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file(`findings-${round}.json`, findings) });
    },
    judge(n, decisions) {
      const items = Object.entries(decisions).map(([id, [decision, confidence = 'high']]) => ({
        id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' },
      }));
      return w.cli(['triage', 'validate', '--round', String(n), '--file', w.file(`judge-${n}.json`, { items })]);
    },
    // Tell the fake GitHub which commit the PR head is (review-complete compares it with the checked-out one).
    prHead: (sha) => fake.setScript(script(sha)),
    // Change pipeline.yml in the working tree only (a commit would add to the commits since the last review): the rounds were run under the old one.
    config(more) {
      writeFileSync(join(repo.dir, '.claude', 'pipeline.yml'), ymlOf(more));
    },
    stateText: () => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8'),
    state: () => JSON.parse(w.stateText()),
    item: (id) => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === id),
    edit(fn) {
      const s = w.state();
      fn(s);
      writeFileSync(join(repo.dir, '.review', 'state.json'), JSON.stringify(s, null, 2));
    },
    // Round n finds `suggestions` (one id R<n>-S<k> each), the judge accepts them all, one fix commit is made and marked implemented. -> the fix commit.
    reviewAndFix(n, from, to, suggestions = [low({ title: `Issue ${n}` })]) {
      const found = w.codex(n, findingsOf([], suggestions), { from, to });
      assertExit(found, 0, found.stderr + found.stdout);
      const ids = suggestions.map((_, k) => `R${n}-S${k + 1}`);
      assertExit(w.judge(n, Object.fromEntries(ids.map((id) => [id, ['ACCEPT']]))), 0);
      repo.write(`src/fix${n}.js`, `export const fix${n} = ${n};\n`);
      const fixed = repo.commit(`fix ${n}`);
      assertExit(w.cli(['state', 'mark-implemented', '--ids', ids.join(',')]), 0);
      return fixed;
    },
    // Rounds 1 and 2 done (the second is the automatic extra round): HEAD is the round-2 fix commit h2 on top of round 2's reviewed head h1.
    atCap(round2 = [low({ title: 'Issue 2' })]) {
      const h1 = w.reviewAndFix(1, base, head, [low({ title: 'Issue 1' })]);
      const h2 = w.reviewAndFix(2, head, h1, round2);
      return { h1, h2 };
    },
    // Take the fix commits out the way the skill does (newest first), -> the new HEAD.
    revert(...shas) {
      for (const sha of shas) repo.git(['revert', '--no-edit', sha]);
      return repo.git(['rev-parse', 'HEAD']).trim();
    },
  };
  assert.ok(slug.length > 0);
  return w;
}
