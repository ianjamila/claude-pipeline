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

// ---- review round 1 (#133) ----

test('R1-B1: a backslash inside the name is still claude (the shell removes it)', () => {
  for (const command of [
    'clau\\de -p hi',
    'clau\\de --continue',
    'cla\\ude -p hi',
    'alias c=cla\\ude; c -p x',
    '/opt/homebrew/bin/clau\\de -p x',
  ]) assert.equal(decide(command), 'deny', command);
});

test('R1-B2: node options in front of the claude-code package file do not hide it', () => {
  for (const command of [
    'node --no-warnings --no-deprecation --trace-warnings --trace-deprecation --trace-uncaught ./node_modules/@anthropic-ai/claude-code/cli.js -p hi',
    'node --max-old-space-size=4096 --no-warnings --no-deprecation --trace-warnings --stack-trace-limit=50 --enable-source-maps ./node_modules/@anthropic-ai/claude-code/cli.js --continue',
    'bun --bun --silent --smol --hot --watch --no-install ./node_modules/@anthropic-ai/claude-code/cli.js -p x',
  ]) assert.equal(decide(command), 'deny', command);
});

test('R1-B3: an interpreter string that names a claude run is refused', () => {
  for (const command of [
    `python3 -c 'import os; os.system("claude -p hi")'`,
    `node -e 'require("child_process").execSync("claude -p hi")'`,
    `node -e 'require("child_process").execSync("claude --continue")'`,
    `perl -e 'system("claude --resume abc")'`,
    `osascript -e 'do shell script "claude -p hi"'`,
    `python3 -c "import subprocess; subprocess.run(['claude', '-p', 'hi'])"`,
    `ruby -e 'system("claude hello")'`,
  ]) assert.equal(decide(command), 'deny', command);
});

test('R1-B3: interpreter strings that only mention claude stay allowed', () => {
  for (const command of [
    `python3 -c 'print("see ~/.claude and CLAUDE.md and claude-pipeline")'`,
    `node -e 'console.log(require("os").homedir() + "/.claude/settings.json")'`,
    `node -e 'console.log("claude --version")'`,
    `python3 -c 'print("the claude hook")'`,
  ]) assert.equal(decide(command), 'allow', command);
});

test('R1-F1: the claude-code cli.js run directly through its shebang is refused', () => {
  for (const command of [
    './node_modules/@anthropic-ai/claude-code/cli.js -p hi',
    '~/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js --continue',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js "merge"',
  ]) assert.equal(decide(command), 'deny', command);
  assert.equal(decide('./node_modules/@anthropic-ai/claude-code/cli.js --version'), 'allow');
});

// (residual, README: a name built by a format string, `"$(printf 'cla%s' ude)" --continue`, leaves no claude spelling on the line to find)
test('R1-F2: a dynamic command name whose claude spelling is split by quotes is refused', () => {
  for (const command of [
    '$(echo cla""ude) -p hi',
    `$(echo cla''ude) -p hi`,
    '"$(echo cla""ude)" --continue',
    '$(echo cla\\ude) -p hi',
  ]) assert.equal(decide(command), 'deny', command);
});

test('R1-F3: hash binds a short name to claude like an alias', () => {
  for (const command of [
    'hash -p /opt/homebrew/bin/claude c; c -p hi',
    'hash c=/opt/homebrew/bin/claude; c -p hi',
    'hash -p ~/.local/bin/claude c',
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of ['hash -r', 'hash git', 'hash -p /usr/bin/git g']) assert.equal(decide(command), 'allow', command);
});

test('R1-F4: the dynamic-line denial says the command is only known at run time, and prose with a dynamic part is not accused of running the CLI', () => {
  const v = run('git commit -m "fix claude hook" && $RUN');
  assert.equal(v.decision, 'deny');
  assert.ok(String(v.reason).includes('only known at run time'), v.reason);
  assert.ok(!String(v.reason).includes('only the owner starts'), v.reason);
  const w = run('C=claude; $C -p x');
  assert.equal(w.decision, 'deny');
  assert.ok(String(w.reason).includes('only known at run time'), w.reason);
});

// ---- review round 2 (#133) ----

test('R2-B1: an embedded claude command with options in front of the flag or the prompt is refused', () => {
  for (const command of [
    `python3 -c 'import os; os.system("claude --model sonnet -p hi")'`,
    `python3 -c 'import os; os.system("claude --model sonnet hello")'`,
    `python3 -c 'import os; os.system("claude --dangerously-skip-permissions -p hi")'`,
    `node -e 'require("child_process").execSync("claude --model opus --continue")'`,
    `perl -e 'system("claude --model sonnet hello")'`,
  ]) assert.equal(decide(command), 'deny', command);
});

test('R2-F1: an argv array with a bare prompt, or options, is refused', () => {
  for (const command of [
    `python3 -c "import subprocess; subprocess.run(['claude', 'hello world'])"`,
    `node -e 'require("child_process").execFileSync("claude", ["merge it"])'`,
    `python3 -c "import subprocess; subprocess.run(['claude', '--model', 'sonnet', '-p', 'hi'])"`,
    `python3 -c "import subprocess; subprocess.run(['claude', '-p', 'hi'])"`,
  ]) assert.equal(decide(command), 'deny', command);
});

test('R2: embedded read-only claude calls and bare names stay allowed', () => {
  for (const command of [
    `node -e 'console.log("claude --version")'`,
    `python3 -c 'import subprocess; subprocess.run(["claude", "--version"])'`,
    `python3 -c 'import subprocess; subprocess.run(["claude", "mcp list"])'`,
    `python3 -c 'import shutil; print(shutil.which("claude"))'`,
    `node -e 'console.log("claude")'`,
    `node -e 'console.log("claude mcp list")'`,
  ]) assert.equal(decide(command), 'allow', command);
});

test('R2-F2: hash -p with the path attached, or grouped flags, binds a name to claude', () => {
  for (const command of [
    'hash -p/opt/homebrew/bin/claude c; c -p hi',
    'hash -rp /opt/homebrew/bin/claude c; c -p hi',
    'hash -lp /opt/homebrew/bin/claude c',
  ]) assert.equal(decide(command), 'deny', command);
  for (const command of ['hash -r', 'hash -rp /usr/bin/git g', 'hash claude']) assert.equal(decide(command), 'allow', command);
});

test('R1: ordinary lines that mention claude as a path or document stay allowed', () => {
  for (const command of [
    'cd ~/Claude && ls',
    'cat CLAUDE.md',
    'git commit -m "fix claude hook"',
    'ls ~/Claude/claude-pipeline',
    'cat ~/.claude/settings.json',
  ]) assert.equal(decide(command), 'allow', command);
});
