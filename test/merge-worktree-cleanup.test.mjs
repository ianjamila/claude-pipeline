// `P merge` run from the PR's worktree: gh `pr merge --delete-branch` merges, then cannot check out the base branch there (git: the base
// is checked out elsewhere) and exits 1 AFTER the merge. That exact case is reported as a skipped local cleanup, not as an unexplained
// non-zero exit; anything else keeps the old note and now also carries the command's output. GitHub's state decides merged / not merged,
// the classification never does. Both routes (gated and --owner-go) share one helper (pipeline/lib/merge-cleanup.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { classifyMergeCommand, WORKTREE_NOTE } from '../pipeline/lib/merge-cleanup.mjs';

const OLD_NOTE = 'the merge command exited non-zero but the PR is MERGED';
const CHECKOUT = "fatal: 'main' is already checked out at '/work/main'";
const USED_BY = "fatal: 'main' is already used by worktree at '/work/main'";
const CANNOT_DELETE = "error: Cannot delete branch 'agent/feature' checked out at '/work/agent-feature'";
const CANNOT_DELETE_USED = "error: Cannot delete branch 'agent/feature' used by worktree at '/work/agent-feature'";

// The merge command: prints what the env says, then exits (or kills itself) as the env says.
const STUB = [
  "import { appendFileSync, mkdirSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
  "console.log('Merged pull request #12');",
  'if (process.env.STUB_ERR) console.error(process.env.STUB_ERR);',
  "if (process.env.STUB_SIGNAL) process.kill(process.pid, process.env.STUB_SIGNAL);",
  "process.exit(Number(process.env.STUB_EXIT ?? 1));",
  '',
].join('\n');

const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
const gatedWorld = (gh) => scenario({ yml: ymlFor().replace('fake-merge', 'stub-merge'), baseFiles: { 'scripts/stub-merge.mjs': STUB }, gh });
const goWorld = (gh) => scenario({
  yml: ymlFor().replace('fake-merge.mjs {pr} {sha}', 'stub-merge.mjs {pr} --match-head-commit {sha}'),
  report: null, state: null, change: unique, baseFiles: { 'scripts/stub-merge.mjs': STUB }, gh,
});
const OPEN = { mergeView: { state: 'OPEN', mergeCommit: null } };

// Runs the merge in one route with the stub's behaviour in `env`; returns the CLI result.
const ROUTES = {
  gated: (t, env, gh) => {
    const s = gatedWorld(gh);
    assertExit(s.gate(), 0);
    return s.merge(env);
  },
  'owner-go': (t, env, gh) => {
    const s = goWorld(gh);
    ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
    return cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
  },
};

for (const [route, go] of Object.entries(ROUTES)) {
  const merged = (name, env, check, opts = {}) => test(`${route}: merged + ${name}`, opts, (t) => {
    const r = go(t, env);
    assertExit(r, 0);
    assert.equal(r.json.merged, true);
    assert.equal(r.json.commandExitCode, env.STUB_SIGNAL ? r.json.commandExitCode : Number(env.STUB_EXIT ?? 1));
    assert.match(r.json.commandOutput, /Merged pull request #12/);
    check(r.json);
  });
  const worktree = (j) => {
    assert.deepEqual(j.localCleanup, { skipped: true, reason: 'worktree' });
    assert.equal(j.note, WORKTREE_NOTE);
    assert.equal(j.commandExitCode, 1);
  };
  const unknown = (j) => {
    assert.equal(j.localCleanup, undefined);
    assert.equal(j.note, OLD_NOTE);
  };

  merged('the checkout diagnostic (gh wrapper): worktree case', { STUB_ERR: `failed to run git: ${CHECKOUT}` }, (j) => {
    worktree(j);
    assert.match(j.commandOutput, /already checked out at/);
  });
  merged('the checkout diagnostic (bare fatal line): worktree case', { STUB_ERR: CHECKOUT }, worktree);
  merged('the "already used by worktree" diagnostic: worktree case', { STUB_ERR: `failed to run git: ${USED_BY}` }, worktree);
  merged('the branch-delete diagnostic (Cannot delete branch ... checked out at): worktree case', { STUB_ERR: `failed to delete local branch agent/feature: ${CANNOT_DELETE}` }, worktree);
  merged('the branch-delete diagnostic (... used by worktree at): worktree case', { STUB_ERR: CANNOT_DELETE_USED }, worktree);
  merged('a bare "failed to delete local branch" from a permission cause: unknown cause',
    { STUB_ERR: "failed to delete local branch agent/feature: cannot lock ref 'refs/heads/agent/feature': Permission denied" }, unknown);
  merged('the diagnostic plus an unrelated error line: unknown cause', { STUB_ERR: `failed to run git: ${CHECKOUT}\nerror: could not read Username for 'https://github.com'` }, unknown);
  merged('the diagnostic with exit 2: unknown cause', { STUB_ERR: `failed to run git: ${CHECKOUT}`, STUB_EXIT: '2' }, (j) => {
    unknown(j);
    assert.equal(j.commandExitCode, 2);
  });
  merged('the diagnostic, then the command is killed (SIGKILL): unknown cause', { STUB_ERR: `failed to run git: ${CHECKOUT}`, STUB_SIGNAL: 'SIGKILL' }, unknown,
    // Windows has no signals (a killed process exits 1, no signal), so the stub cannot produce one through the CLI; the classifier unit test below covers the rule everywhere.
    { skip: process.platform === 'win32' });

  test(`${route}: NOT merged + the checkout diagnostic is still a failure (and carries the output)`, (t) => {
    const r = go(t, { STUB_ERR: `failed to run git: ${CHECKOUT}` }, OPEN);
    assertExit(r, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.merged, false);
    assert.equal(r.json.localCleanup, undefined);
    assert.equal(r.json.commandExitCode, 1);
    assert.match(r.json.commandOutput, /already checked out at/);
    assert.match(r.json.reason, /merge command failed \(exit 1\) and the PR is not merged/);
  });
}

// ---- the classifier itself: what a subprocess test cannot reach (a real timeout is >= 5 minutes) ----------------------------------

const ran = (over = {}) => ({ code: 1, timedOut: false, signal: null, stdout: 'Merged pull request #12\n', stderr: `failed to run git: ${CHECKOUT}\n`, ...over });

test('classifyMergeCommand: exit 0 adds nothing', () => {
  assert.deepEqual(classifyMergeCommand(ran({ code: 0 })), {});
});

test('classifyMergeCommand: the worktree case', () => {
  assert.deepEqual(classifyMergeCommand(ran()), {
    commandExitCode: 1, localCleanup: { skipped: true, reason: 'worktree' }, commandOutput: `Merged pull request #12\n\nfailed to run git: ${CHECKOUT}`, note: WORKTREE_NOTE,
  });
});

test('classifyMergeCommand: a timeout after the diagnostic is the unknown cause', () => {
  const out = classifyMergeCommand(ran({ timedOut: true }));
  assert.equal(out.localCleanup, undefined);
  assert.equal(out.note, OLD_NOTE);
  assert.equal(out.commandExitCode, 1);
  assert.match(out.commandOutput, /already checked out/);
});

test('classifyMergeCommand: a signal after the diagnostic is the unknown cause', () => {
  for (const signal of ['SIGKILL', 'SIGTERM']) {
    const out = classifyMergeCommand(ran({ signal }));
    assert.equal(out.localCleanup, undefined, signal);
    assert.equal(out.note, OLD_NOTE, signal);
  }
});

test('classifyMergeCommand: only exit code exactly 1', () => {
  for (const code of [2, 128, 137]) assert.equal(classifyMergeCommand(ran({ code })).localCleanup, undefined, String(code));
});

test('classifyMergeCommand: judges the FULL output, not the 30-line tail', () => {
  // an unrelated error line more than 30 lines before the end: the tail looks clean, the whole output does not
  const stdout = `error: pre-receive hook declined\n${'noise\n'.repeat(40)}`;
  const out = classifyMergeCommand(ran({ stdout }));
  assert.equal(out.localCleanup, undefined);
  assert.ok(!out.commandOutput.includes('pre-receive'), 'the tail does not show it');
  // ...and the diagnostic scrolled out of the tail still classifies
  const scrolled = classifyMergeCommand(ran({ stderr: `failed to run git: ${CHECKOUT}\n`, stdout: `Merged\n${'noise\n'.repeat(40)}` }));
  assert.deepEqual(scrolled.localCleanup, { skipped: true, reason: 'worktree' });
});

test('classifyMergeCommand: no diagnostic at all, or only a translated one, is the unknown cause', () => {
  assert.equal(classifyMergeCommand(ran({ stderr: '' })).localCleanup, undefined);
  assert.equal(classifyMergeCommand(ran({ stderr: "fatal : 'main' est déjà extrait dans '/work/main'" })).localCleanup, undefined);
});

test('classifyMergeCommand: a Windows line ending does not matter', () => {
  assert.deepEqual(classifyMergeCommand(ran({ stderr: `failed to run git: ${CHECKOUT}\r\n` })).localCleanup, { skipped: true, reason: 'worktree' });
});
