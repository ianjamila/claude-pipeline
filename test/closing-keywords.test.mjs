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

test('fences: a longer fence is closed only by an equal-or-longer run of the same character', () => {
  // an inner ``` line does not close a ```` block, so the list inside stays hidden
  assert.deepEqual(multiIssueClosingLines('````md\n```\nCloses #1, #2\n```\n````'), []);
  assert.deepEqual(multiIssueClosingLines('````\nFixes #3 and #4\n````'), []);
  // a different character does not close it either
  assert.deepEqual(multiIssueClosingLines('```\n~~~\nCloses #1, #2\n~~~\n```'), []);
  // a closing fence carries no info string: "```js" inside an open block is content
  assert.deepEqual(multiIssueClosingLines('```\n```js\nCloses #1, #2\n```'), []);
  // control: after the 4-backtick block is really closed, a list is flagged again
  const found = multiIssueClosingLines('````md\n```\ninner\n```\n````\nFixes #12, #13');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 'Fixes #12, #13');
});

test('inline code spans and HTML comments between references break the list but stay invisible to the keyword', () => {
  assert.deepEqual(multiIssueClosingLines('Fixes #12, `see also` #13'), []);
  assert.deepEqual(multiIssueClosingLines('Fixes #12, <!-- x --> #13'), []);
  // control: with nothing between, the list is flagged
  assert.equal(multiIssueClosingLines('Fixes #12, #13').length, 1);
  // control: a span/comment elsewhere in the line does not hide a real list
  assert.equal(multiIssueClosingLines('`x` Fixes #12, #13 <!-- y -->').length, 1);
});

test('multi-line HTML comments are skipped; text around the markers on the same line is still read', () => {
  assert.deepEqual(multiIssueClosingLines('<!--\nCloses #1, #2\n-->'), []);
  assert.deepEqual(multiIssueClosingLines('Intro\n<!-- note\nFixes #3 and #4\nmore\n-->\nOutro'), []);
  // text before <!-- on the opening line is read
  const before = multiIssueClosingLines('Closes #5, #6 <!-- start\nhidden\n-->');
  assert.equal(before.length, 1);
  assert.equal(before[0].linked, '#5');
  // text after --> on the closing line is read
  const after = multiIssueClosingLines('<!--\nhidden\n--> Closes #7, #8');
  assert.equal(after.length, 1);
  assert.equal(after[0].linked, '#7');
  // control: a list after a closed multi-line comment is flagged
  const ctl = multiIssueClosingLines('<!--\nhidden\n-->\nFixes #12, #13');
  assert.equal(ctl.length, 1);
  assert.equal(ctl[0].line, 'Fixes #12, #13');
});

test('a span or comment glued to the list is hidden, not read as part of a reference or keyword', () => {
  for (const body of ['Closes #1, #2<!-- note -->', 'Closes #1, #2`code`', '<!-- note -->Closes #1, #2']) {
    const found = multiIssueClosingLines(body);
    assert.equal(found.length, 1, body);
    assert.deepEqual([found[0].linked, found[0].unlinked], ['#1', ['#2']], body);
  }
  // controls: a span/comment between the references still breaks the list
  assert.deepEqual(multiIssueClosingLines('Fixes #12, `see also` #13'), []);
  assert.deepEqual(multiIssueClosingLines('Fixes #12, <!-- x --> #13'), []);
});

test('code spans and comments are read left to right: a backtick inside a comment does not pair with one outside', () => {
  const line = "<!-- don't use ` --> Closes #1, #2 and `tests`";
  const found = multiIssueClosingLines(line);
  assert.equal(found.length, 1, 'its own list is flagged');
  assert.deepEqual([found[0].linked, found[0].unlinked], ['#1', ['#2']]);
  // the comment is closed, so a list on a later line is still read
  const later = multiIssueClosingLines(line + '\nFixes #3, #4');
  assert.deepEqual(later.map((f) => f.linked), ['#1', '#3']);
  // a comment opener inside a code span is code, not a comment
  assert.equal(multiIssueClosingLines('`<!--` Fixes #5, #6').length, 1);
  assert.equal(multiIssueClosingLines('`<!--` Fixes #5, #6\nFixes #7, #8').length, 2);
  // controls: a span or comment that really does contain the list hides it
  assert.deepEqual(multiIssueClosingLines('<!-- Closes #1, ` --> #2'), []);
  assert.deepEqual(multiIssueClosingLines('`<!-- Closes #1, #2 ` -->'), []);
  // a lone backtick (no partner) is literal text
  assert.equal(multiIssueClosingLines('it`s: Closes #1, #2').length, 1);
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
