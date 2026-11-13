// `pipeline summary`: the "pushed to a ready PR without redrafting" warning (lib/ci-usage-pr.mjs), only for a repository with ci.draft_while_iterating: true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, PR, ME, REPO } from './helpers/gate-env.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const T = (hhmm, sec = 0) => `2026-11-10T${hhmm}:${String(sec).padStart(2, '0')}Z`;
const sha = (c) => c.repeat(40);
const ev = (event, at) => ({ event, created_at: at, actor: { login: 'me' } });
const run = (id, head, created, over = {}) => ({
  id, name: 'ci', event: 'pull_request', head_sha: head, run_attempt: 1, head_branch: 'agent/feat', pull_requests: [{ number: PR }],
  created_at: created, run_started_at: created, updated_at: created, ...over,
});
// PR 12 opened as a draft at 09:00, marked ready at 10:00
const TIMELINE = [ev('ready_for_review', T('10:00'))];
const gh = ({ runs, timelineFail = false } = {}) => createFakeGh([
  { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget', headRefName: 'agent/feat', baseRefName: 'main', headRefOid: sha('b') } },
  ME, REPO,
  { match: '^api repos/acme/widgets/pulls/12/commits', stdoutJson: [{ sha: sha('a'), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work' } }] },
  { match: '^api repos/acme/widgets/pulls/12\\b', stdoutJson: { number: PR, created_at: T('09:00'), draft: false, head: { ref: 'agent/feat' } } },
  timelineFail ? { match: '^api repos/acme/widgets/issues/12/timeline', code: 1, stderr: 'gh: HTTP 502' } : { match: '^api repos/acme/widgets/issues/12/timeline', stdoutJson: TIMELINE },
  { match: '^api repos/acme/widgets/actions/runs\\?event=pull_request&branch=agent%2Ffeat', stdoutJson: { total_count: runs?.length ?? 0, workflow_runs: runs ?? [] } },
  { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/12/comments', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-5' } },
]);
function summary(flag, fake) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', flag === null ? pipelineYml() : `${pipelineYml()}  draft_while_iterating: ${flag}\n`);
  repo.write('.gitignore', '.review/\n.verify/\n');
  repo.commit('init');
  return cli(['summary', '--pr', String(PR), '--outcome', 'blocked'], { dir: repo.dir, fake });
}
const body = (fake) => JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
const pushedReady = [run(1, sha('a'), T('09:30')), run(2, sha('b'), T('10:30')), run(3, sha('b'), T('10:30', 3), { name: 'guards' })];

test('summary: flag true and one push while ready => a warning, the JSON field and one line in the comment', () => {
  const fake = gh({ runs: pushedReady });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.pushedWhileReady, { count: 1, heads: [sha('b').slice(0, 12)] });
  assert.ok(r.json.warnings.includes(`pushed to the ready PR without \`P redraft\` first 1 time(s): ${sha('b').slice(0, 12)}; CI ran the full suite each time`), r.json.warnings.join('\n'));
  const text = body(fake);
  assert.ok(text.startsWith(MARKERS.summary));
  assert.match(text, /Pushed to the ready PR without `pipeline redraft` first once: b{12} \(CI ran the full suite each time\)\./);
});

test('summary: flag true but every push was made in draft => no warning, no field, no comment line', () => {
  const fake = gh({ runs: [run(1, sha('a'), T('09:30'))] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.deepEqual(r.json.warnings, []);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('summary: flag false (or absent) => not a single extra read', () => {
  for (const flag of [false, null]) {
    const fake = gh({ runs: pushedReady });
    const r = summary(flag, fake);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.pushedWhileReady, undefined);
    const lines = fake.lines();
    assert.ok(!lines.some((l) => /timeline|actions\/runs|pulls\/12|\/commits/.test(l)), lines.join('\n'));
  }
});

test('summary: a read error becomes a warning; the summary still succeeds', () => {
  const fake = gh({ runs: pushedReady, timelineFail: true });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.match(r.json.warnings.join('\n'), /pushed-while-ready check skipped: GitHub could not be read/);
  assert.ok(fake.lines().some((l) => l.includes('-X POST')), 'the comment was still posted');
});
