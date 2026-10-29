// The review-complete marker (Phase 3a): only `pipeline review-complete` may post it, so every gh route an agent can see that
// would put it in a PR or issue text is refused, including text built at run time and body files written on the same line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGitCommand, RUN_MARKER_TEXTS, STATE_MARKER_TEXT, TRIAGE_MARKER_TEXT } from '../pipeline/hooks/lib/git-policy.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { encodeRecord, STATUS_START, STATUS_END } from '../pipeline/lib/run-record.mjs';
import { renderEvent } from '../pipeline/lib/run-events.mjs';
import { followupMarker } from '../pipeline/commands/followups.mjs';
import { encodeForComment } from '../pipeline/lib/state.mjs';

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

test('security review 3: short flags read with each verb\'s gh table (unknown ones refused); shell-expanded body-file names refused', () => {
  for (const command of [
    'gh pr comment 5 -cFmarked.md', // -c is no flag of pr comment: not read as text that would hide -F
    'gh pr comment 5 -xF marked.md',
    'gh issue comment 5 -zb hi',
    'gh pr comment 5 -F ~/marked.md',
    'gh pr comment 5 -F mark*.md',
    'gh pr comment 5 --body-file "mark?d.md"',
    'gh pr comment 5 --body-file m[a]rked.md',
    'gh pr comment 5 --body-file {marked,plain}.md',
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of [
    'gh pr merge 5 --squash --auto -d -t "subject" --match-head-commit ' + 'a'.repeat(40),
    'gh pr review 5 -c -b "fine"',
    'gh pr review 5 -cF plain.md',
    'gh pr create -d -B main -t title -F plain.md',
    'gh pr comment 5 -R acme/app -F plain.md',
    'gh pr comment 5 -RFoo/bar -F plain.md',
    'gh pr close 5 -d -c "done"',
  ]) assert.equal(decide(command), 'allow', command);
});

test('Codex review of 4c595df: gh api writes with escaped markers, run-time fields, stdin or same-line input files are refused', () => {
  writeFileSync(join(dir, 'escaped.json'), '{"body":"<!-- claude-pipeline\\u003areview-complete v1 -->\\nx"}');
  writeFileSync(join(dir, 'nested.json'), '{"query":"mutation($b:String!){addComment(input:{subjectId:\\"X\\",body:$b}){clientMutationId}}","variables":{"b":"claude-pipeline\\u003Areview-complete"}}');
  writeFileSync(join(dir, 'plain.json'), '{"body":"a normal comment, $5 well spent"}');
  for (const command of [
    'gh api repos/acme/app/issues/5/comments --input escaped.json',
    'gh api graphql --input nested.json',
    "gh api graphql -f query='mutation { addComment(input: {subjectId: \"X\", body: \"claude-pipeline\\u003areview-complete\"}) { clientMutationId } }'",
    'gh api repos/acme/app/issues/5/comments -f body="$(cat marked.md)"',
    'gh api repos/acme/app/issues/5/comments -f body="$BODY"',
    'gh api repos/acme/app/issues/5/comments -F body=@"$F"',
    'gh api repos/acme/app/issues/5/comments --input -',
    'gh api repos/acme/app/issues/5/comments --input missing.json',
    'gh api -X PATCH repos/acme/app/issues/comments/9 -F body=@missing.md',
    'gh api graphql -f query=\'mutation($b: String!) { addComment(input: {subjectId: "X", body: $b}) { clientMutationId } }\' -f b="$BODY"',
    "printf 'claude-pipeline\\072review-complete' > made.md && gh api repos/acme/app/issues/5/comments -F body=@made.md",
    "printf 'claude-pipeline\\072review-complete' > plain.md && gh api repos/acme/app/issues/5/comments -F body=@plain.md", // (exists, rewritten)
    'cp escaped.json plain.json && gh api repos/acme/app/issues/5/comments --input plain.json',
    'gh api repos/acme/app/issues/5/comments -F body=@mark*.md',
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of [
    'gh api repos/acme/app/issues/5/comments --input plain.json',
    'gh api repos/acme/app/issues/5/comments -F body=@plain.md',
    "gh api repos/acme/app/issues/5/comments -f body='looks good'",
    'gh api repos/acme/app/pulls/5/comments',
    'gh api graphql -f query=\'query { viewer { login } }\' -f owner="$OWNER"',
  ]) assert.equal(decide(command), 'allow', command);
});

test('Codex recheck + security review of ee9899f: double-quoted GraphQL, replaced GraphQL input, run-time endpoint, \\u{..} escapes', () => {
  writeFileSync(join(dir, 'request.json'), '{"query":"query { viewer { login } }"}');
  writeFileSync(join(dir, 'forged.json'), '{"query":"mutation { addComment(input: {subjectId: \\"X\\", body: \\"hi\\"}) { clientMutationId } }"}');
  for (const command of [
    'gh api graphql -f query="mutation { addComment(input:{subjectId:\\"X\\",body:\\"$BODY\\"}) { clientMutationId } }"',
    'gh api graphql -f query="mutation($b: String!) { addComment(input:{subjectId:\\"X\\",body:$b}) { clientMutationId } }" -f b=hi',
    'gh api graphql -f query="mutation { minimizeComment(input:{subjectId:\\"$X\\",classifier:SPAM}) { clientMutationId } }"',
    'gh api graphql -f query="$Q"',
    "echo 'query { viewer { login } } $X' && gh api graphql -f query=\"query { viewer { login } } $X\"",
    // (security review of de35615: empty quotes around an unquoted, expanded word; a literal decoy word with the same text)
    "gh api graphql -f ''query=query{viewer{login}}$X''",
    "gh api graphql -f 'query=query{viewer{login}}$X' -f query=query{viewer{login}}$X",
    "gh api graphql -f query='query { viewer { login } }'\"$X\"",
    // (security review of 27f228c: a spelling outside an exact list (-f=V) next to a literal decoy; a word the guard expanded)
    "gh api graphql -f=query=query{viewer{login}}$X --raw-field='query=query{viewer{login}}$X'",
    "Y=1; gh api graphql -f query='query($o: String!) { repository(owner:$o, name:\"x\") { id } }' -f o=$Y",
    'cp forged.json request.json && gh api graphql --input request.json',
    'gh api "$EP" -f body="$B"',
    'gh api "$EP" --input -',
    "gh api graphql -f query='mutation { addComment(input: {subjectId: \"X\", body: \"claude-pipeline\\u{3a}review-complete\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { addComment(input: {subjectId: \"X\", body: \"claude-pipeline\\u{00003A}review-complete\"}) { clientMutationId } }'",
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of [
    "gh api graphql -f query='mutation($id: ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { clientMutationId } }' -f id=X",
    "gh api graphql -f query='query($o: String!) { repository(owner:$o, name:\"x\") { id } }' -f o=\"$OWNER\"",
    "gh api graphql -f 'query=query($o: String!) { repository(owner:$o, name:\"x\") { id } }' -f o=acme",
    'gh api graphql --input request.json',
    'gh api "$EP" -F body=@plain.md',
  ]) assert.equal(decide(command), 'allow', command);
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

// Phase 3b: `pipeline state show --pr N` rebuilds .review/state.json from the newest triage comment of the viewer (the agent's own
// login), so the triage and state markers may only come from `pipeline comment --kind triage`, like the review-complete marker.
test('Phase 3b: the triage and review-state markers are refused like the review-complete marker', () => {
  const state = encodeForComment({ version: 1, pr: 5, rounds: [] });
  writeFileSync(join(dir, 'triage.md'), `${MARKERS.triage}\n${state}\n`);
  for (const command of [
    `gh pr comment 5 --body '${MARKERS.triage}'`,
    `gh pr comment 5 --body '${state}'`,
    'gh pr comment 5 -b "x <!-- CLAUDE-PIPELINE:TRIAGE -->"',
    'gh pr comment 5 --body-file triage.md',
    'gh pr review 5 --comment -F triage.md',
    `gh api repos/acme/app/issues/5/comments -f body='${MARKERS.triage}'`,
    'gh api -X PATCH repos/acme/app/issues/comments/9 --input triage.md',
    "gh api repos/acme/app/issues/5/comments -f body='claude-pipeline\\u003astate:x'",
    "printf 'claude-pipeline:triage' > new2.md && gh pr comment 5 -F new2.md",
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of [
    'gh pr view 5 --comments',
    'node /opt/pipeline/bin/pipeline.mjs comment --pr 5 --kind triage',
    'node /opt/pipeline/bin/pipeline.mjs state show --pr 5',
  ]) assert.equal(decide(command), 'allow', command);
});

test('Phase 3b: the guarded marker texts are the ones the pipeline writes', () => {
  assert.ok(MARKERS.triage.includes(TRIAGE_MARKER_TEXT));
  assert.ok(encodeForComment({ pr: 1 }).includes(STATE_MARKER_TEXT));
});

// Phase 3b: every marker the pipeline's commands write is refused in hand-posted text: each one as the real writer renders it.
test('Phase 3b: the run markers (summary, record, status, needs-human, blocked, awaiting-review, events, follow-ups) are refused too', () => {
  const written = [...Object.values(MARKERS), encodeRecord({ v: 1, step: 'merge' }), STATUS_START, STATUS_END,
    renderEvent('rollback-result', 'r1', 'rolled back', { ok: true }), followupMarker(7, { fingerprint: 'fp1', id: 'R1-S1' })];
  for (const text of written) {
    assert.ok(RUN_MARKER_TEXTS.some((m) => text.toLowerCase().includes(m)) || text.includes(TRIAGE_MARKER_TEXT), `not guarded: ${text.slice(0, 60)}`);
    const body = JSON.stringify(`${text}\nhand-written`);
    assert.equal(decide(`gh pr comment 7 --body ${body}`), 'deny', text.slice(0, 60));
    assert.equal(decide(`gh issue create --title t --body ${body}`), 'deny', text.slice(0, 60));
  }
  // the words alone, in prose, are not a marker
  assert.equal(decide('gh pr comment 7 --body "the summary comment is updated by the pipeline"'), 'allow');
});

// Fable attacker pass (Phase 3b): the run record lives in a comment of the agent's own login, and P merge reads a missing record as an
// ordinary run, so deleting or blanking a comment by hand is refused (no marker needed); the pipeline commands update their own.
test('Phase 3b: editing or deleting an existing comment by hand is refused', () => {
  for (const cmd of ['gh api -X DELETE repos/acme/app/issues/comments/9', 'gh api -X PATCH repos/acme/app/issues/comments/9 -f body=x',
    'gh api --method=delete /repos/acme/app/pulls/comments/9', 'gh api -X PUT repos/{owner}/{repo}/issues/comments/9 -f body=x',
    'gh pr comment 7 --edit-last --body x', 'gh pr comment 7 --delete-last --yes', 'gh issue comment 7 --edit-last=true -b x',
    'gh api graphql -f query=\'mutation { updateIssueComment(input: {id: "IC_1", body: "x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { deleteIssueComment(input: {id: "IC_1"}) { clientMutationId } }\'']) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of ['gh pr comment 7 --body x', 'gh api repos/acme/app/issues/comments/9', 'gh api -X POST repos/acme/app/issues/comments/9/reactions -f content=+1',
    'gh api repos/acme/app/issues/7/comments -f body=x']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});
