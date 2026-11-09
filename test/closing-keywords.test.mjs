// "Closes #170, #171" closes only #170 on merge (GitHub links one issue per keyword). review-complete refuses such a PR body
// with the exact rewrite, once the review itself is valid; the fix is a body edit, so the next review-complete passes with no round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { closingKeywordProblem, multiIssueClosingLines } from '../pipeline/lib/closing-keywords.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');

// ---- the detector ----------------------------------------------------------------------------------

test('a keyword followed by a list of references is found, with the references GitHub would leave open', () => {
  const cases = [
    ['Closes #170, #171', 'Closes', '#170', ['#171']],
    ['Fixes #12 and #13', 'Fixes', '#12', ['#13']],
    ['resolves: #1, #2, and #3', 'resolves', '#1', ['#2', '#3']],
    ['Closed #4 & acme/other#5', 'Closed', '#4', ['acme/other#5']],
    ['- FIXES #7 / #8', 'FIXES', '#7', ['#8']],
    ['Closes https://github.com/acme/widgets/issues/9, https://github.com/acme/widgets/issues/10', 'Closes',
      'https://github.com/acme/widgets/issues/9', ['https://github.com/acme/widgets/issues/10']],
  ];
  for (const [line, keyword, linked, unlinked] of cases) {
    const found = multiIssueClosingLines(`## In plain English\nStuff.\n\n${line}\n`);
    assert.equal(found.length, 1, line);
    assert.deepEqual({ keyword: found[0].keyword, linked: found[0].linked, unlinked: found[0].unlinked }, { keyword, linked, unlinked }, line);
    assert.equal(found[0].line, line.trim());
  }
});

test('one keyword per issue, prose after a reference, code and comments are not flagged', () => {
  const clean = [
    'Closes #170. Closes #171.',
    'Closes #170, closes #171',
    'Fixes #12 (and #13 is related)',
    'Closes #170 + new tests',
    'Fixes #12, see #13',
    'Related: #1, #2',
    'The prefix #1, #2 is not a keyword; neither is discloses #3, #4',
    '`Closes #1, #2` is the wrong form',
    '<!-- Closes #1, #2 -->',
    '```\nCloses #1, #2\n```',
    '~~~md\nFixes #3 and #4\n~~~',
    '',
  ];
  for (const body of clean) assert.deepEqual(multiIssueClosingLines(body), [], body);
  assert.deepEqual(multiIssueClosingLines(undefined), []);
  assert.deepEqual(multiIssueClosingLines(null), []);
});

test('every offending line is reported, and the problem names the exact rewrite', () => {
  const found = multiIssueClosingLines('Closes #1, #2\r\nmiddle\r\nfixes #3 and #4');
  assert.equal(found.length, 2);
  const why = closingKeywordProblem(found, 42);
  assert.match(why, /"Closes #1, #2" closes only #1 on merge/);
  assert.match(why, /write "Closes #1\. Closes #2\."/);
  assert.match(why, /write "Fixes #3\. Fixes #4\."/);
  assert.match(why, /gh pr edit 42 --body-file/);
  assert.match(why, /no new review round is needed/);
  assert.equal(closingKeywordProblem([], 42), null);
});

// ---- review-complete -------------------------------------------------------------------------------

const findingsOf = () => ({ summary: 'Reviewed.', blocking: [], suggestions: [], worth_considering: [] });

function world(t, body, { review = true } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-closing-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', 'export const a = 1;\n');
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', 'export const a = 2;\n');
  repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head = repo.commit('feature');
  const script = (b) => [
    { match: '^pr view 7', stdoutJson: { title: 'Add a', body: b, headRefName: 'feat/x', baseRefName: 'main', headRefOid: head, isDraft: true, labels: [] } },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^pr edit 7 --remove-label awaiting-review', code: 0 },
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [] },
    { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
  ];
  const fake = createFakeGh(script(body));
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: repo.dir, encoding: 'utf8',
      env: { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: join(scratch, 'locks'), ...env },
    });
    let json = null;
    try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* the assertion on json will say so */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const out = join(scratch, 'findings-1.json');
  writeFileSync(out, JSON.stringify(findingsOf()));
  if (review) assertExit(cli(['codex-review', '--pr', '7', '--round', '1', '--base', base, '--head', head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: out }), 0);
  return { cli, fake, setBody: (b) => fake.setScript(script(b)) };
}

test('review-complete refuses a body with "Closes #1, #2" (exit 1, error closing-keywords, nothing posted); after the body edit it passes with no new round', (t) => {
  const w = world(t, '## In plain English\nA change.\n\nCloses #1, #2\n');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.deepEqual([r.json.ok, r.json.error], [false, 'closing-keywords']);
  assert.match(r.json.reason, /closes only #1 on merge/);
  assert.match(r.json.reason, /write "Closes #1\. Closes #2\."/);
  assert.ok(!w.fake.calls().some((c) => c.argv.join(' ').startsWith('api -X POST')), 'no marker comment was posted');

  w.setBody('## In plain English\nA change.\n\nCloses #1. Closes #2.\n');
  const ok = w.cli(['review-complete', '--pr', '7']);
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.review.rounds, 1, 'the body edit needed no new round');
});

test('review-complete: an invalid review is reported as such, not as a body problem', (t) => {
  const w = world(t, 'Closes #1, #2', { review: false });
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stderr + r.stdout);
  assert.notEqual(r.json.error, 'closing-keywords', r.stdout);
  assert.match(r.json.reason, /no review state|no review round/);
});
