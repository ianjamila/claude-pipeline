// #132: an agent's shell may not start or continue a Claude Code conversation (`claude -p`, `--print`, `--resume`, `--continue`, a prompt).
// Whether a nested run could ever count as the owner typing is unverified, so the commands are refused as defence in depth; the
// read-only calls (`--version`, `--help`, `mcp list`, `config get`, `doctor`) stay allowed. Anything unclear is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const dir = mkdtempSync(join(tmpdir(), 'claude-cli-'));
const run = (command) => evaluateGitCommand(command, { cwd: dir });
const decide = (command) => run(command).decision;

const MESSAGE = '[claude-pipeline guard-git] an agent may not run the Claude Code CLI with a prompt, -p/--print, --resume or --continue: only the owner starts or continues a conversation (#132)';

test('the deny message names the rule and the issue', () => {
  const v = run('claude -p hi');
  assert.equal(v.decision, 'deny');
  assert.ok(String(v.reason).includes(MESSAGE.replace('[claude-pipeline guard-git] ', '')), v.reason);
});

test('print, resume and continue modes, a bare prompt and a bare session are refused', () => {
  for (const command of [
    'claude -p hi',
    'claude --print hi',
    'claude --print=hi',
    'claude --resume abc "merge"',
    'claude --resume=abc',
    'claude -r abc',
    'claude -rabc',
    'claude --continue',
    'claude -c',
    'claude -pc x',
    'claude -cp x',
    'claude "merge"',
    'claude hello',
    'claude',
    'claude --model opus -p x',
    'claude --model opus "merge"',
    'claude --dangerously-skip-permissions -p x',
    'claude --session-id 123 -p x',
    'claude --from-pr 5',
    'claude --output-format json -p x',
    'claude mcp list -c',
    'claude mcp serve',
    'claude mcp add x -- node y',
    'claude config set a b',
    'claude update',
    'claude --version -p x',
    'claude -v --resume',
    'claude --help "merge"',
  ]) assert.equal(decide(command), 'deny', command);
});

test('absolute paths, case, extensions and the wrappers the parser unwraps are refused', () => {
  for (const command of [
    '/opt/homebrew/bin/claude -p x',
    '/usr/local/bin/claude --resume abc',
    '~/.local/bin/claude -p x',
    '$HOME/.local/bin/claude -p x',
    './node_modules/.bin/claude -p x',
    'CLAUDE -p x',
    'claude.exe -p x',
    'command claude -p x',
    'command -- claude -p x',
    'builtin command claude -p x',
    'env FOO=1 claude -p x',
    'env -i claude -p x',
    'FOO=1 claude -p x',
    'exec claude -p x',
    'nohup claude -p x &',
    'timeout 5 claude -p x',
    'time claude -p x',
    'sudo claude -p x',
    'echo x | xargs claude -p',
    'echo x | xargs -I{} claude -p {}',
    'cat prompt.txt | claude -p',
    'claude -p x | tee out.txt',
    'true && claude -p x',
    'false || claude -p x',
    'echo hi; claude --continue',
    '(claude -p x)',
    '{ claude -p x; }',
    'f() { claude -p x; }; f',
    'if true; then claude -p x; fi',
    'for i in 1 2; do claude -p x; done',
  ]) assert.equal(decide(command), 'deny', command);
});

test('nested shells, substitutions and eval are refused', () => {
  for (const command of [
    "bash -c 'claude -p x'",
    'sh -c "claude -p x"',
    "zsh -c 'claude --resume abc'",
    "bash -lc 'claude -p x'",
    "bash -c 'sh -c \"claude -p x\"'",
    "env bash -c 'claude -p x'",
    'echo $(claude -p x)',
    '$(claude -p x)',
    'echo `claude -p x`',
    'x="$(claude -p y)"',
    'eval "claude -p x"',
    'echo "claude -p x" | sh',
    'echo "claude -p x" | bash',
    'bash <<< "claude -p x"',
    'sh -c "$(echo claude -p x)"',
    'find . -name x -exec claude -p {} \;',
    'env -S "claude -p x"',
    'ssh host claude -p x',
    "git config alias.c '!claude -p x' && git c",
    'alias c=claude; c -p x',
    "alias c='claude -p'",
  ]) assert.equal(decide(command), 'deny', command);
});

test('npx, npm exec, pnpm dlx, bunx and yarn dlx forms are refused', () => {
  for (const command of [
    'npx @anthropic-ai/claude-code -p x',
    'npx -y @anthropic-ai/claude-code -p x',
    'npx -y @anthropic-ai/claude-code@latest -p x',
    'npx claude -p x',
    'npx claude',
    'npx @anthropic-ai/claude-code',
    'npx -p @anthropic-ai/claude-code claude -p x',
    'npx --package=@anthropic-ai/claude-code claude -p x',
    'npm exec claude -- -p x',
    'npm exec @anthropic-ai/claude-code -- -p x',
    'pnpm dlx @anthropic-ai/claude-code -p x',
    'pnpm dlx claude -p x',
    'pnpm exec claude -p x',
    'bunx @anthropic-ai/claude-code -p x',
    'bunx claude -p x',
    'yarn dlx @anthropic-ai/claude-code -p x',
    'node node_modules/@anthropic-ai/claude-code/cli.js -p x',
  ]) assert.equal(decide(command), 'deny', command);
});

test('a name or option only known at run time is refused when the line names claude', () => {
  for (const command of [
    'claude $ARGS',
    'claude "$@"',
    'claude $(echo -p) x',
    'C=claude; $C -p x',
    'C=claude; "$C" --resume abc',
    '$(echo claude) -p x',
    'claude --version $X',
    'claude mcp list "$N"',
  ]) assert.equal(decide(command), 'deny', command);
});

test('read-only and admin calls that cannot submit a prompt stay allowed', () => {
  for (const command of [
    'claude --version',
    'claude -v',
    'claude -V',
    'claude --help',
    'claude -h',
    'claude mcp list',
    'claude mcp get github',
    'claude config get theme',
    'claude config list',
    'claude doctor',
    '/opt/homebrew/bin/claude --version',
    '~/.local/bin/claude --version',
    'command claude --version',
    'env FOO=1 claude --version',
    'nohup claude --version',
    'timeout 5 claude mcp list',
    "bash -c 'claude --version'",
    'echo $(claude --version)',
    'npx @anthropic-ai/claude-code --version',
    'npx claude --help',
  ]) assert.equal(decide(command), 'allow', command);
});

test('text that only mentions claude is not a run', () => {
  for (const command of [
    'echo claude -p',
    'echo "claude -p x" > notes.txt',
    'printf "%s\\n" "claude --resume abc"',
    'grep -r "claude -p" docs/',
    'grep -rn claude -- docs/',
    'git commit -m "claude -p"',
    'git commit -m "docs: the claude --continue vector"',
    'git log --grep "claude -c"',
    'cat docs/claude.md',
    'ls ~/.claude',
    'ls ~/.local/bin/claude',
    'which claude',
    'type claude',
    'command -v claude',
    'mkdir claude-notes',
    'cd ~/.claude && ls',
    'node scripts/test.mjs claude',
    'rm -r claude-tmp',
    'gh issue view 132 --json title',
  ]) assert.equal(decide(command), 'allow', command);
});
