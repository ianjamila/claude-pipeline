// #58: in an owner_approval: chat repo, a merge that skips `P merge` (a plain `gh pr merge`, the repo's own merge command, auto-merge
// through the API) needs the owner's "merge" recorded for that PR in this session. P merge runs the merge command itself, out of the
// guard's sight, so low-risk PRs still merge through it; other repos are not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { ownerGoWiring } from '../pipeline/hooks/lib/git-wiring.mjs';

// /chat is an owner_approval: chat repo whose merge command is `npm run merge -- {pr} …`; the owner said "merge" for #7 only.
const ownerGo = {
  mode: (dir) => (dir.startsWith('/chat') ? 'chat' : dir.startsWith('/broken') ? (() => { throw new Error('bad yml'); })() : 'none'),
  mergePrefix: (dir) => (dir.startsWith('/chat') ? ['npm', 'run', 'merge', '--'] : null),
  approvedPr: (pr) => pr === 7,
};
const opts = (cwd) => ({ cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ownerGo });
const verdict = (cmd, cwd = '/chat') => evaluateGitCommand(cmd, opts(cwd));
const deny = (cmd, cwd) => { const v = verdict(cmd, cwd); assert.equal(v.decision, 'deny', `${cmd} @ ${cwd}`); return v; };
const allow = (cmd, cwd) => assert.equal(verdict(cmd, cwd).decision, 'allow', `${cmd} @ ${cwd}: ${verdict(cmd, cwd).reason}`);

test('#58 chat repo: a direct `gh pr merge` needs the owner\'s recorded "merge" for that PR', () => {
  for (const cmd of ['gh pr merge 8 --squash --auto --delete-branch', 'gh pr merge https://github.com/o/r/pull/8 --squash', 'gh pr merge -R o/r 8']) {
    assert.match(deny(cmd).reason, /needs the owner's "merge" for #8 in this session, and none is recorded/);
  }
  assert.match(deny('gh pr merge --squash --auto').reason, /without a literal PR number/, 'the current branch\'s PR cannot be checked');
  assert.match(deny('gh pr merge agent/feature').reason, /without a literal PR number/);
  assert.match(deny('gh pr merge #8').reason, /without a literal PR number/, '(` #8` is a shell comment: no PR is named)');
  for (const cmd of ['gh pr merge 7 --squash --auto --delete-branch', 'gh pr merge 7 --match-head-commit abc', 'gh pr merge 8 --disable-auto', 'gh pr view 8', 'gh pr checks 8']) allow(cmd);
  // a value flag never passes for the PR number
  assert.match(deny('gh pr merge --subject 7 8').reason, /#8/);
});

test('#58 chat repo: the repo\'s own merge command typed by hand is judged the same way', () => {
  deny('npm run merge -- 8 --no-update --expect-head abc');
  deny('npm run merge 8');
  allow('npm run merge -- 7 --no-update --expect-head abc');
  allow('npm run build');
  allow('npm run merge-report'); // (another script)
});

test('#58 chat repo: auto-merge through the GraphQL API is refused (its node id cannot be checked)', () => {
  const q = "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'";
  assert.match(deny(q).reason, /auto-merge through the API skips the owner's "merge"/);
  allow(q, '/other');
  allow("gh api graphql -f query='mutation { disablePullRequestAutoMerge(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'");
});

test('#58 other repos merge as before; an unknown directory or an unreadable pipeline.yml fails closed', () => {
  for (const cmd of ['gh pr merge 8 --squash --auto', 'gh pr merge --squash', 'npm run merge -- 8']) allow(cmd, '/other');
  deny('gh pr merge 8 --squash', '/broken');
  allow('gh pr merge 7 --squash', '/broken');
  // -R / a PR URL from another repo's directory: that repository's mode is unknown here
  deny('gh pr merge -R o/chat 8', '/other');
  deny('gh pr merge https://github.com/o/chat/pull/8', '/other');
  allow('gh pr merge -R o/chat 7', '/other');
  // a cd the guard cannot follow leaves the directory unknown
  deny('cd "$(mktemp -d)" && gh pr merge 8', '/other');
  // without the wiring (older callers) nothing changes
  assert.equal(evaluateGitCommand('gh pr merge 8 --squash', { ...opts('/chat'), ownerGo: null }).decision, 'allow');
});

test('#58 a job started through the pipeline runner and a script are judged the same way', () => {
  deny('node ~/.claude/pipeline/bin/pipeline.mjs job start m -- gh pr merge 8 --squash');
  allow('node ~/.claude/pipeline/bin/pipeline.mjs job start m -- node ~/.claude/pipeline/bin/pipeline.mjs merge --pr 8');
});

test('#58 ownerGoWiring reads the mode and merge command from the nearest pipeline.yml up to the repository root', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-go-wiring-'));
  const repo = (name, yml) => {
    const d = join(root, name);
    mkdirSync(join(d, '.claude'), { recursive: true });
    mkdirSync(join(d, 'src', 'deep'), { recursive: true });
    writeFileSync(join(d, '.git'), 'gitdir: x\n');
    if (yml !== null) writeFileSync(join(d, '.claude', 'pipeline.yml'), yml);
    return d;
  };
  const chat = repo('chat', 'owner_approval: chat\nmerge:\n  command: npm run merge -- {pr} --expect-head {sha}\n');
  const label = repo('label', 'merge:\n  command: gh pr merge {pr} --squash\n');
  const none = repo('none', null);
  const w = ownerGoWiring('sess');
  assert.equal(w.mode(join(chat, 'src', 'deep')), 'chat');
  assert.deepEqual(w.mergePrefix(chat), ['npm', 'run', 'merge', '--']);
  assert.equal(w.mode(label), 'label');
  assert.deepEqual(w.mergePrefix(label), ['gh', 'pr', 'merge']);
  assert.equal(w.mode(join(none, 'src')), 'none', 'the repository root ends the search');
  assert.equal(w.mergePrefix(none), null);
  const broken = repo('broken', 'owner_approval: [chat\n  : :');
  assert.throws(() => w.mode(broken));
  assert.equal(w.approvedPr(1), false, 'no record for a made-up session');
});
