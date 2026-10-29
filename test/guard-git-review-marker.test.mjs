// The review-complete marker (Phase 3a): only `pipeline review-complete` may post it, so every gh route an agent can see that
// would put it in a PR or issue text is refused, including text built at run time and body files written on the same line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const dir = mkdtempSync(join(tmpdir(), 'marker-'));
const MARKER = '<!-- claude-pipeline:review-complete v1 -->';
writeFileSync(join(dir, 'marked.md'), `${MARKER}\nreviewed\n`);
writeFileSync(join(dir, 'plain.md'), 'a normal comment\n');
const decide = (command) => evaluateGitCommand(command, { cwd: dir }).decision;

test('the marker is refused in comment text, body files and gh api writes', () => {
  for (const command of [
    `gh pr comment 5 --body '${MARKER}'`,
    `gh pr comment 5 -b 'x <!-- CLAUDE-PIPELINE:REVIEW-COMPLETE v2 -->'`,
    `gh issue comment 5 --body='claude-pipeline:review-complete'`,
    'gh pr comment 5 --body-file marked.md',
    'gh pr comment 5 -F marked.md',
    'gh pr review 5 --comment -F marked.md',
    'gh pr edit 5 --body-file=marked.md',
    `gh api repos/acme/app/issues/5/comments -f body='${MARKER}'`,
    'gh api repos/acme/app/issues/5/comments -F body=@marked.md',
    'gh api -X PATCH repos/acme/app/issues/comments/9 --input marked.md',
    `gh pr comment 5 --body-file - <<< '${MARKER}'`,
  ]) assert.equal(decide(command), 'deny', command);
});

test('security review: text built at run time or a body file written on the same line is refused', () => {
  for (const command of [
    'gh pr comment 5 --body "$(cat marked.md)"',
    'gh pr comment 5 --body "`cat marked.md`"',
    'gh pr comment 5 -b "$BODY"',
    'gh pr comment 5 --body-file "$F"',
    "printf 'claude-pipeline:review-complete' > new.md && gh pr comment 5 -F new.md",
    'cp marked.md new.md && gh pr comment 5 --body-file new.md',
  ]) assert.equal(decide(command), 'deny', command);
});

test('security review 2: pflag spellings, grouped shorts, unreadable body files and the editor routes', () => {
  for (const command of [
    'gh pr comment 5 -F=marked.md',
    'gh pr comment 5 -wF marked.md',
    'gh pr comment 5 -wFmarked.md',
    'gh pr comment 5 -wF=marked.md',
    'gh pr comment 5 --body-file missing.md',
    'gh pr comment 5 -F .',
    'gh pr comment 5 --editor',
    'gh pr comment 5 -e',
    'gh pr create -T bug.md',
    'gh pr create --template bug.md',
    'gh pr create --recover draft.json',
    'gh issue comment 5 -we',
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of ['gh pr comment 5 -F=plain.md', 'gh pr comment 5 -wF plain.md', 'gh pr comment 5 --body-file=plain.md']) {
    assert.equal(decide(command), 'allow', command);
  }
});

test('ordinary comments, reads and the review-complete command itself still pass; so does P merge --owner-go', () => {
  for (const command of [
    'gh pr comment 5 --body "looks good"',
    'gh pr comment 5 --body-file plain.md',
    'gh pr view 5 --comments',
    'grep -rn "claude-pipeline:review-complete" pipeline',
    'node /opt/pipeline/bin/pipeline.mjs review-complete --pr 5',
    'node /opt/pipeline/bin/pipeline.mjs merge --pr 5 --owner-go',
  ]) assert.equal(decide(command), 'allow', command);
});
