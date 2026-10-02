// Facts the docs state about the installer hooks and the Vercel rollback, pinned to the code that makes them true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_FILES_MATCHER, GUARD_GIT_MATCHER } from '../pipeline/lib/installer.mjs';
import { rollback } from '../pipeline/lib/vercel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const ROLLBACK = 'vercel rollback <known-good> --yes --timeout 3m';

test('installer hook matchers are what the docs say', () => {
  assert.equal(GUARD_GIT_MATCHER, 'Bash|PowerShell|Monitor|mcp__.*');
  assert.equal(GUARD_FILES_MATCHER, 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*');
  const spec = read('docs/specs/2026-10-01-claude-pipeline-design.md');
  assert.ok(spec.includes(`**guard-git** (matcher \`${GUARD_GIT_MATCHER}\`)`));
  assert.ok(spec.includes(`**guard-files** (matcher \`${GUARD_FILES_MATCHER}\`)`));
});

test('the Vercel rollback the docs describe is the command prod-watch runs', () => {
  const calls = [];
  const out = rollback('dpl_abc', { cwd: '/x', env: { PIPELINE_VERCEL: undefined }, runFn: (cmd, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0].slice(-5), ['rollback', 'dpl_abc', '--yes', '--timeout', '3m']);
  for (const doc of ['pipeline/templates/pipeline.yml', 'skills/pipeline-setup/reference/stack-recipes.md', 'skills/ship/SKILL.md']) {
    const text = read(doc).replace(/\s*\n#?\s*/g, ' ');
    assert.ok(text.includes(ROLLBACK), `${doc} must state \`${ROLLBACK}\``);
    assert.ok(!text.includes('{deployment}'), `${doc} still has the old {deployment} placeholder`);
  }
});

test('the project settings template allows what ship runs, nothing that merges or edits protection, and a Stop hook that survives any cwd', () => {
  const settings = JSON.parse(read('pipeline/templates/settings.json'));
  const allow = settings.permissions.allow;
  for (const needed of [
    'gh pr create', 'gh pr edit', 'gh pr ready', 'gh pr checks', 'gh pr update-branch', 'git push', 'git pull', 'git fetch', 'git add', 'git commit',
    'git worktree add', 'git worktree remove', 'git rev-parse', 'git diff', 'git log', 'git status', 'shasum',
  ]) assert.ok(allow.includes(`Bash(${needed}:*)`), `settings.json must allow ${needed}`);
  for (const entry of allow) {
    assert.ok(!/gh pr merge|gh api|--force|--dangerously|bypassPermissions|git reset|git rebase|git branch -D|git remote/.test(entry), `${entry} must not be allowed`);
  }
  const stop = settings.hooks.Stop[0].hooks[0];
  assert.match(stop.command, /\$\{CLAUDE_PROJECT_DIR:-\.\}\/scripts\/pipeline\/stop-verify\.mjs/, 'the Stop hook must not depend on the session cwd being the repo root');
  assert.equal(stop.timeout, 900);
});

test('pipeline.yml template documents the optional ci keys, and CODEOWNERS names its placeholders', () => {
  const yml = read('pipeline/templates/pipeline.yml');
  assert.match(yml, /# guard_checks: true/);
  assert.match(yml, /# approvers: \[/);
  assert.match(yml, /org-repo-needs-ci\.approvers/);
  const owners = read('pipeline/templates/CODEOWNERS');
  assert.ok(owners.includes('{{OWNER}}') && owners.includes('{{HARD_STOP_LINES}}'));
});

// ---- skills and agents: facts that were wrong once ------------------------------------------------------------------------

const walkMd = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(root, rel)).isDirectory() ? walkMd(rel) : rel.endsWith('.md') ? [rel] : [];
});
const skillDocs = walkMd('skills');

test('every SKILL.md stays within 500 lines', () => {
  for (const doc of skillDocs.filter((d) => d.endsWith('/SKILL.md'))) assert.ok(read(doc).split('\n').length <= 500, `${doc} is over 500 lines`);
});

test('a needs-human comment always carries --reason (the command exits 2 without it); settle never takes --evidence', () => {
  for (const doc of skillDocs) {
    const text = read(doc);
    for (const m of text.matchAll(/--kind needs-human/g)) {
      assert.ok(text.slice(m.index, m.index + 220).includes('--reason'), `${doc}: a needs-human comment near offset ${m.index} lacks --reason`);
    }
    assert.ok(!/triage settle[^\n]*--evidence/.test(text), `${doc} still uses triage settle --evidence`);
  }
  assert.ok(read('skills/ship/reference/review-loop.md').includes('--test-cmd') && read('skills/ship/reference/review-loop.md').includes('--test-file'));
});

test('ship teaches reading the job exit code and every prod-watch outcome the CLI can return', async () => {
  const ship = read('skills/ship/SKILL.md');
  assert.match(ship, /exitCode/);
  assert.match(ship, /prod-watch --pr N/);
  const usage = (await import('../pipeline/commands/prod-watch.mjs')).meta.usage;
  const outcomes = usage.match(/outcome: ([a-z|-]+)/)[1].split('|');
  const table = read('skills/ship/reference/gates-and-exits.md');
  for (const outcome of outcomes) assert.ok(table.includes(`\`${outcome}\``), `gates-and-exits.md must cover the prod-watch outcome ${outcome}`);
  for (const needle of ['behind-base:', 'pre-merge', 'live-check', 'production-unknown', 'mergeSha: null']) assert.ok(table.includes(needle), `gates-and-exits.md must cover ${needle}`);
});

test('agents: implementer and verifier inherit effort (spec 5.4); judge and arbiter pin it', () => {
  const front = (doc) => read(doc).split('---')[1];
  assert.ok(!/^effort:/m.test(front('agents/implementer.md')));
  assert.ok(!/^effort:/m.test(front('agents/verifier.md')));
  assert.match(front('agents/judge.md'), /^effort: high$/m);
  assert.match(front('agents/arbiter.md'), /^effort: high$/m);
  assert.match(read('agents/judge.md'), /every pending item exactly once/);
});

test('pipeline-setup: ignores the worktree dir, pins verify.expected_steps, mentions the executable shim and the ci keys', () => {
  const setup = read('skills/pipeline-setup/SKILL.md');
  for (const needle of ['<worktree_dir>/', 'verify.expected_steps', '100755', 'ci.approvers', 'ci.guard_checks', '.gitattributes', '{{OWNER}}', '--reason']) {
    assert.ok(setup.includes(needle), `pipeline-setup must mention ${needle}`);
  }
});
