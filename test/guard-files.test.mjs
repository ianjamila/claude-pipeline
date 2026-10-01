import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
import { protectedRoots, evaluateFileTool, evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'hooks', 'guard-files.mjs');
const CHECKOUT = '/home/u/Claude/claude-pipeline';
const GUARD_IN_CHECKOUT = `${CHECKOUT}/pipeline/hooks/guard-files.mjs`;

const LINUX = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const WIN = { home: 'C:\\Users\\u', env: {}, platform: 'win32', realpath: (p) => p, existsSync: () => false };
const MAC = { ...LINUX, platform: 'darwin' };

const file = (tool_name, tool_input, opts = {}, cwd = '/repo') =>
  evaluateFileTool({ tool_name, tool_input, cwd }, { ...LINUX, ...opts }).decision;
const bash = (command, opts = {}) => evaluateBashForFiles(command, { ...LINUX, cwd: '/repo', ...opts }).decision;
const inCheckout = { cwd: CHECKOUT, existsSync: (p) => p === GUARD_IN_CHECKOUT };

// ---- protected roots ------------------------------------------------------------------------

test('protectedRoots lists the pipeline files under <home>/.claude in POSIX form', () => {
  assert.deepEqual(protectedRoots('/home/u'), [
    '/home/u/.claude/skills/ship',
    '/home/u/.claude/skills/verify',
    '/home/u/.claude/skills/pipeline-setup',
    '/home/u/.claude/agents/implementer.md',
    '/home/u/.claude/agents/verifier.md',
    '/home/u/.claude/agents/judge.md',
    '/home/u/.claude/agents/arbiter.md',
    '/home/u/.claude/pipeline',
    '/home/u/.claude/settings.json',
  ]);
  assert.equal(protectedRoots('C:\\Users\\u\\')[0], 'C:/Users/u/.claude/skills/ship');
});

// ---- file tools (Appendix B) ----------------------------------------------------------------

const FILE_DENY = [
  ['Edit ship skill via ~', 'Edit', { file_path: '~/.claude/skills/ship/SKILL.md', old_string: 'a', new_string: 'b' }],
  ['Write arbiter agent', 'Write', { file_path: '/home/u/.claude/agents/arbiter.md', content: 'x' }],
  ['Edit installed hook', 'Edit', { file_path: '/home/u/.claude/pipeline/hooks/guard-git.mjs', old_string: 'a', new_string: 'b' }],
  ['Write global settings', 'Write', { file_path: '/home/u/.claude/settings.json', content: '{}' }],
  ['MultiEdit verify skill', 'MultiEdit', { file_path: '/home/u/.claude/skills/verify/SKILL.md', edits: [{ old_string: 'a', new_string: 'b' }] }],
  ['NotebookEdit under pipeline', 'NotebookEdit', { notebook_path: '/home/u/.claude/pipeline/x.ipynb', new_source: 'x' }],
  ['Write repo settings.local.json with disableAllHooks', 'Write', { file_path: '/repo/.claude/settings.local.json', content: '{"disableAllHooks": true}' }],
  ['Edit repo settings.json adding disableAllHooks', 'Edit', { file_path: '/repo/.claude/settings.json', old_string: '{', new_string: '{"disableAllHooks":true,' }],
  ['Write a script mentioning PIPELINE_ADMIN', 'Write', { file_path: '/tmp/x.sh', content: 'export PIPELINE_ADMIN=1\nclaude' }],
  ['Edit through a .. segment', 'Edit', { file_path: '/home/u/.claude/skills/ship/../ship/SKILL.md', old_string: 'a', new_string: 'b' }],
  ['Write pipeline-setup skill', 'Write', { file_path: '/home/u/.claude/skills/pipeline-setup/SKILL.md', content: 'x' }],
  ['Write the ship skill directory itself', 'Write', { file_path: '/home/u/.claude/skills/ship', content: 'x' }],
  ['relative path resolved against cwd', 'Edit', { file_path: '../home/u/.claude/pipeline/x', old_string: 'a', new_string: 'b' }, '/repo'],
  ['MultiEdit with PIPELINE_ADMIN in the second edit', 'MultiEdit', { file_path: '/repo/run.sh', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'PIPELINE_ADMIN=1' }] }],
  ['NotebookEdit new_source with PIPELINE_ADMIN', 'NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: 'os.environ["PIPELINE_ADMIN"]="1"' }],
  ['unicode-escaped disableAllHooks in settings', 'Write', { file_path: '/repo/.claude/settings.json', content: '{"disable\\u0041llHooks": true}' }],
];

for (const [name, tool, input, cwd] of FILE_DENY) {
  test(`file tool DENY: ${name}`, () => {
    const r = evaluateFileTool({ tool_name: tool, tool_input: input, cwd: cwd ?? '/repo' }, LINUX);
    assert.equal(r.decision, 'deny', JSON.stringify(input));
    assert.ok(r.reason.length > 0);
  });
}

const FILE_ALLOW = [
  ['repo source file', 'Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }],
  ['another skill', 'Edit', { file_path: '/home/u/.claude/skills/graphify/SKILL.md', old_string: 'a', new_string: 'b' }],
  ['another agent', 'Edit', { file_path: '/home/u/.claude/agents/other.md', old_string: 'a', new_string: 'b' }],
  ['repo settings without disableAllHooks', 'Write', { file_path: '/repo/.claude/settings.json', content: '{"permissions":{}}' }],
  ['global CLAUDE.md', 'Edit', { file_path: '/home/u/.claude/CLAUDE.md', old_string: 'a', new_string: 'b' }],
  ['memory file', 'Edit', { file_path: '/home/u/.claude/projects/-x/memory/a.md', old_string: 'a', new_string: 'b' }],
  ['prefix lookalike skill dir', 'Edit', { file_path: '/home/u/.claude/skills/shipping/SKILL.md', old_string: 'a', new_string: 'b' }],
  ['prefix lookalike pipeline dir', 'Write', { file_path: '/home/u/.claude/pipeline-notes/a.md', content: 'x' }],
  ['settings.json backup name', 'Write', { file_path: '/home/u/.claude/settings.json.bak', content: 'x' }],
  ['disableAllHooks outside a .claude settings file', 'Write', { file_path: '/repo/docs/notes.md', content: 'the disableAllHooks key is guarded' }],
  ['settings-like file outside .claude', 'Write', { file_path: '/repo/settings.json', content: '{"disableAllHooks": false}' }],
  ['tool input without a path', 'Write', { content: 'x' }],
];

for (const [name, tool, input] of FILE_ALLOW) {
  test(`file tool ALLOW: ${name}`, () => {
    assert.equal(file(tool, input), 'allow', JSON.stringify(input));
  });
}

test('file tool: PIPELINE_ADMIN=1 in the process env allows every file edit', () => {
  const env = { PIPELINE_ADMIN: '1' };
  assert.equal(file('Edit', { file_path: '~/.claude/skills/ship/SKILL.md', old_string: 'a', new_string: 'b' }, { env }), 'allow');
  assert.equal(file('Write', { file_path: '/repo/.claude/settings.json', content: '{"disableAllHooks":true}' }, { env }), 'allow');
  assert.equal(file('Write', { file_path: '/tmp/x.sh', content: 'PIPELINE_ADMIN=1' }, { env }), 'allow');
});

test('file tool: only the exact value 1 enables admin mode', () => {
  for (const v of ['0', 'true', '', ' 1', '11']) {
    assert.equal(file('Write', { file_path: '/home/u/.claude/settings.json', content: '{}' }, { env: { PIPELINE_ADMIN: v } }), 'deny', JSON.stringify(v));
  }
});

test('file tool: relative path inside cwd that is a protected root', () => {
  assert.equal(file('Edit', { file_path: 'SKILL.md', old_string: 'a', new_string: 'b' }, {}, '/home/u/.claude/skills/ship'), 'deny');
  assert.equal(file('Edit', { file_path: 'SKILL.md', old_string: 'a', new_string: 'b' }, {}, '/home/u/.claude/skills/other'), 'allow');
});

test('file tool: case-insensitive on darwin, case-sensitive on linux', () => {
  const input = { file_path: '/HOME/U/.Claude/Skills/Ship/SKILL.md', old_string: 'a', new_string: 'b' };
  assert.equal(file('Edit', input, MAC), 'deny');
  assert.equal(file('Edit', input, LINUX), 'allow');
});

test('file tool: Windows paths, drive letters and case', () => {
  const edit = (p) => file('Edit', { file_path: p, old_string: 'a', new_string: 'b' }, WIN, 'C:\\repo');
  assert.equal(edit('C:\\Users\\u\\.claude\\skills\\ship\\SKILL.md'), 'deny');
  assert.equal(edit('c:\\users\\U\\.CLAUDE\\settings.json'), 'deny');
  assert.equal(edit('C:/Users/u/.claude/pipeline/hooks/x.mjs'), 'deny');
  assert.equal(edit('C:\\Users\\u\\.claude\\skills\\shipping\\SKILL.md'), 'allow');
  assert.equal(edit('C:\\repo\\src\\app.ts'), 'allow');
  assert.equal(edit('%USERPROFILE%\\.claude\\settings.json'), 'deny');
  assert.equal(edit('\\\\?\\C:\\Users\\u\\.claude\\settings.json'), 'deny');
});

test('file tool: a fake realpath that redirects into a protected root is denied', () => {
  const realpath = (p) => (p.startsWith('/tmp/link') ? p.replace('/tmp/link', '/home/u/.claude/skills/ship') : p);
  const existsSync = (p) => p === '/tmp/link' || p === '/tmp/link/SKILL.md';
  assert.equal(file('Edit', { file_path: '/tmp/link/SKILL.md', old_string: 'a', new_string: 'b' }, { realpath, existsSync }), 'deny');
});

test('file tool: nearest existing ancestor is resolved for a new file', () => {
  const realpath = (p) => (p === '/tmp/link' ? '/home/u/.claude/pipeline' : p);
  const existsSync = (p) => p === '/tmp/link' || p === '/tmp';
  assert.equal(file('Write', { file_path: '/tmp/link/new/deep/file.mjs', content: 'x' }, { realpath, existsSync }), 'deny');
  assert.equal(file('Write', { file_path: '/tmp/other/new/file.mjs', content: 'x' }, { realpath, existsSync }), 'allow');
});

test('file tool: a realpath that throws falls back to the lexical check', () => {
  const realpath = () => { throw new Error('ELOOP'); };
  const existsSync = () => true;
  assert.equal(file('Edit', { file_path: '/home/u/.claude/settings.json', old_string: 'a', new_string: 'b' }, { realpath, existsSync }), 'deny');
  assert.equal(file('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, { realpath, existsSync }), 'allow');
});

// ---- Bash (Appendix B) ----------------------------------------------------------------------

const BASH_DENY = [
  ['sed -i on the ship skill', "sed -i '' 's/x/y/' ~/.claude/skills/ship/SKILL.md"],
  ['echo redirect to $HOME agent', 'echo x > $HOME/.claude/agents/judge.md'],
  ['cp over ${HOME} skill', 'cp evil.md ${HOME}/.claude/skills/ship/SKILL.md'],
  ['rm -rf the pipeline dir', 'rm -rf /home/u/.claude/pipeline'],
  ['PIPELINE_ADMIN as a command prefix', 'PIPELINE_ADMIN=1 node install.mjs'],
  ['export PIPELINE_ADMIN', 'export PIPELINE_ADMIN=1'],
  ['node -e writing settings via process.env.HOME', `node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/settings.json','{}')"`],
  ['disableAllHooks via echo redirect', `echo '{"disableAllHooks":true}' > .claude/settings.local.json`],
  ['pipeline protect --apply', 'node ~/.claude/pipeline/bin/pipeline.mjs protect --repo . --apply'],
  ['job runner wrapping rm', 'node ~/.claude/pipeline/bin/pipeline.mjs job start x -- rm -rf ~/.claude/pipeline'],
  ['read then copy back', 'cat ~/.claude/settings.json > /tmp/a; cp /tmp/a ~/.claude/settings.json'],
  ['mv a protected dir', 'mv ~/.claude/skills/verify /tmp/v'],
  ['tee into settings', 'echo {} | tee ~/.claude/settings.json'],
  ['perl -pi on an agent', "perl -pi -e 's/a/b/' ~/.claude/agents/verifier.md"],
  ['python opening the file for writing', `python3 -c "open('/home/u/.claude/agents/implementer.md','w').write('x')"`],
  ['bash -c wrapping a write', `bash -c "echo x > ~/.claude/pipeline/hooks/guard-git.mjs"`],
  ['command substitution hiding a write', 'echo $(rm -rf ~/.claude/pipeline)'],
  ['chmod on a hook', 'chmod 000 ~/.claude/pipeline/hooks/guard-git.mjs'],
  ['ln -s over a skill', 'ln -sf /tmp/evil ~/.claude/skills/ship'],
  ['git checkout inside the pipeline dir', 'git -C ~/.claude/pipeline checkout -- .'],
  ['git with an alias injection', "git -c alias.log='!rm -rf x' log ~/.claude/pipeline"],
  ['find -delete', 'find ~/.claude/pipeline -name "*.mjs" -delete'],
  ['find -exec', 'find ~/.claude/pipeline -exec rm {} ;'],
  ['jq -i', 'jq -i .a ~/.claude/settings.json'],
  ['rg --pre runs a program', 'rg --pre ./evil.sh foo ~/.claude/pipeline'],
  ['git diff --output', 'git diff --output=/home/u/.claude/pipeline/x HEAD'],
  ['absolute path with .. dodging the prefix', 'rm -rf /home/u/proj/../.claude/pipeline'],
  ['brace expansion', 'rm -rf ~/.claude/{pipeline,settings.json}'],
  ['glob over a protected dir', 'rm -rf ~/.claude/pipe*'],
  ['glob inside a protected dir', 'rm ~/.claude/pipeline/hooks/*.mjs'],
  ['cd into the dir then write', 'cd ~/.claude/skills/ship && echo x > SKILL.md'],
  ['cd into the parent then relative rm', 'cd ~/.claude && rm -rf pipeline'],
  ['cd then sed -i a relative file', 'cd ~/.claude/agents && sed -i s/a/b/ judge.md'],
  ['relative path from home', 'cd ~ && rm -rf .claude/pipeline'],
  ['path.join pieces', `node -e "fs.writeFileSync(path.join(os.homedir(), '.claude', 'settings.json'), '{}')"`],
  ['string-concat pieces', `node -e "fs.rmSync('/home/u/' + '.claude/pipeline', {recursive:true})"`],
  ['python expanduser', `python3 -c "open(os.path.expanduser('~/.claude/settings.json'),'w')"`],
  ['quote-split PIPELINE_ADMIN', "export PIPELINE_'ADMIN'=1"],
  ['backslash-split PIPELINE_ADMIN', 'export PIPELINE_AD\\MIN=1'],
  ['ANSI-C PIPELINE_ADMIN', "env $'PIPELINE_\\x41DMIN=1' claude"],
  ['disableAllHooks quote-split', "echo '{\"disable\"'\"AllHooks\"':1}' > x"],
  ['job start nested twice', 'node ~/.claude/pipeline/bin/pipeline.mjs job start a -- node ~/.claude/pipeline/bin/pipeline.mjs job start b -- rm ~/.claude/settings.json'],
  ['job start with a quoted inner command', `node ~/.claude/pipeline/bin/pipeline.mjs job start a -- sh -c 'echo x > ~/.claude/settings.json'`],
  ['heredoc fed to python', "python3 - <<'PY'\nopen('/home/u/.claude/settings.json','w').write('{}')\nPY"],
  ['heredoc to a protected file', 'cat > ~/.claude/skills/ship/SKILL.md <<EOF\nx\nEOF'],
  ['sudo wrapper', 'sudo rm -rf ~/.claude/pipeline'],
  ['xargs wrapper', 'echo ~/.claude/pipeline | xargs rm -rf'],
  ['xargs fan-out from a read-only listing', 'find ~/.claude/pipeline -type f | xargs rm'],
  ['sh fed by a read-only listing', "find ~/.claude/pipeline -type f -printf 'rm %p\\n' | sh"],
  ['eval of a substitution', 'eval "$(cat ~/.claude/pipeline/VERSION)"'],
  ['assignment then use', 'D=~/.claude/pipeline; rm -rf $D'],
];

for (const [name, cmd] of BASH_DENY) {
  test(`bash DENY: ${name}`, () => {
    const r = evaluateBashForFiles(cmd, { ...LINUX, cwd: '/repo' });
    assert.equal(r.decision, 'deny', cmd);
    assert.ok(r.reason.length > 0);
  });
}

const BASH_ALLOW = [
  ['cat a skill', 'cat ~/.claude/skills/ship/SKILL.md'],
  ['ls the pipeline dir', 'ls ~/.claude/pipeline'],
  ['grep settings', 'grep -n foo ~/.claude/settings.json'],
  ['run a pipeline tool', 'node ~/.claude/pipeline/bin/pipeline.mjs preflight'],
  ['run a pipeline tool via absolute path', 'node /home/u/.claude/pipeline/bin/pipeline.mjs preflight --json'],
  ['run an installed hook for a manual probe', 'node ~/.claude/pipeline/hooks/guard-git.mjs'],
  ['git status of the checkout', 'git -C ~/Claude/claude-pipeline status'],
  ['diff installed against the checkout', 'diff ~/.claude/skills/ship/SKILL.md ~/Claude/claude-pipeline/skills/ship/SKILL.md'],
  ['job start with an unrelated command', 'node ~/.claude/pipeline/bin/pipeline.mjs job start v -- node scripts/verify.mjs'],
  ['an ordinary command', 'npm test && git status'],
  ['sed -i on a repo file', 'sed -i s/a/b/ src/app.ts'],
  ['heredoc body of a plain cat to stdout', "cat <<'EOF'\nsee ~/.claude/pipeline\nEOF"],
  ['pipeline of read-only commands', 'ls ~/.claude/pipeline | head -5'],
  ['read-only chained with git status', 'cat ~/.claude/skills/ship/SKILL.md && git status'],
  ['redirect to a repo file', 'echo hi > notes.txt'],
  ['repo-local .claude directory', 'cp template.json .claude/settings.json'],
  ['prefix lookalike skill', 'rm -rf ~/.claude/skills/shipping'],
  ['other files under .claude', 'cp x ~/.claude/CLAUDE.md'],
  ['memory dir glob', 'rm ~/.claude/projects/-x/memory/*.md'],
  ['head and wc on settings', 'head -n 5 ~/.claude/settings.json | wc -l'],
  ['stat and file', 'stat ~/.claude/pipeline/VERSION && file ~/.claude/settings.json'],
  ['sha256sum of installed files', 'sha256sum ~/.claude/pipeline/hooks/*.mjs'],
  ['find without -exec', 'find ~/.claude/pipeline -name "*.mjs" -type f'],
  ['git log of the pipeline dir', 'git -C ~/.claude/pipeline log --oneline'],
  ['jq read', "jq '.hooks' ~/.claude/settings.json"],
  ['read-only with stderr silenced', 'cat ~/.claude/settings.json 2>/dev/null'],
  ['read-only with stderr merged', 'grep foo ~/.claude/settings.json 2>&1 | head'],
  ['test -f', 'test -f ~/.claude/pipeline/VERSION'],
  ['bracket test', '[ -d ~/.claude/pipeline ]'],
  ['cd into the pipeline dir then read', 'cd ~/.claude/pipeline && ls && cat VERSION'],
  ['cat with env prefix', 'LC_ALL=C cat ~/.claude/settings.json'],
  ['pwsh Get-Content', `pwsh -NoProfile -Command "Get-Content ~/.claude/settings.json"`],
  ['PowerShell word in an unrelated path', 'ls /repo/docs/PIPELINE.md'],
  ['pipeline protect without --apply', 'node ~/.claude/pipeline/bin/pipeline.mjs protect --repo .'],
  ['a different repo .claude dir', 'cat /repo/.claude/settings.json > /dev/null'],
  ['empty command', ''],
];

for (const [name, cmd] of BASH_ALLOW) {
  test(`bash ALLOW: ${name}`, () => {
    const r = evaluateBashForFiles(cmd, { ...LINUX, cwd: '/repo' });
    assert.equal(r.decision, 'allow', `${cmd} -> ${r.reason}`);
  });
}

test('bash: PIPELINE_ADMIN=1 in the process env allows everything', () => {
  const env = { PIPELINE_ADMIN: '1' };
  assert.equal(bash('rm -rf ~/.claude/pipeline', { env }), 'allow');
  assert.equal(bash('export PIPELINE_ADMIN=1', { env }), 'allow');
  assert.equal(bash(`echo '{"disableAllHooks":true}' > .claude/settings.local.json`, { env }), 'allow');
  assert.equal(bash('node ~/.claude/pipeline/bin/pipeline.mjs protect --apply', { env }), 'allow');
});

// ---- installers -----------------------------------------------------------------------------

test('bash: installer invocations inside a claude-pipeline checkout', () => {
  assert.equal(bash(`node ${CHECKOUT}/install.mjs`, { existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'deny');
  assert.equal(bash('sh install.sh', inCheckout), 'deny');
  assert.equal(bash('./install.sh', inCheckout), 'deny');
  assert.equal(bash('node ./install.mjs --force', inCheckout), 'deny');
  assert.equal(bash('node install.mjs --check --force', inCheckout), 'deny');
  assert.equal(bash('pwsh -File ./install.ps1', inCheckout), 'deny');
  assert.equal(bash('bash -c "cd /tmp && sh ./install.sh"', inCheckout), 'deny');
  assert.equal(bash('cd /tmp && node /home/u/Claude/claude-pipeline/install.mjs', { existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'deny');
  assert.equal(bash(`cd ${CHECKOUT} && ./install.sh`, { cwd: '/repo', existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'deny');
  assert.equal(bash(`cd ~/Claude/claude-pipeline && node install.mjs`, { cwd: '/repo', existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'deny');
  assert.equal(bash('node ~/Claude/claude-pipeline/install.mjs', { cwd: '/repo', existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'deny');
});

test('bash: --check is the one allowed installer form', () => {
  assert.equal(bash('node install.mjs --check', inCheckout), 'allow');
  assert.equal(bash(`node ${CHECKOUT}/install.mjs --check`, { existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'allow');
  assert.equal(bash('./install.sh --check', inCheckout), 'allow');
});

test('bash: naming an installer without executing it is allowed, even inside the checkout', () => {
  for (const cmd of ['git add install.sh install.mjs', 'cat install.mjs', 'chmod +x install.sh', 'git diff -- install.ps1', 'shellcheck install.sh', 'wc -l install.mjs && git status']) {
    assert.equal(bash(cmd, inCheckout), 'allow', cmd);
  }
});

test('bash: an install.* script elsewhere is not a claude-pipeline installer', () => {
  assert.equal(bash('sh install.sh', { cwd: '/repo', existsSync: () => false }), 'allow');
  assert.equal(bash('node /opt/other/install.mjs', { cwd: '/repo', existsSync: (p) => p === GUARD_IN_CHECKOUT }), 'allow');
  assert.equal(bash('cat install.sh', { cwd: '/repo' }), 'allow');
});

test('bash: Windows installer path with backslashes is still seen', () => {
  const existsSync = (p) => p === 'C:/Users/u/Claude/claude-pipeline/pipeline/hooks/guard-files.mjs';
  assert.equal(bash('node C:\\Users\\u\\Claude\\claude-pipeline\\install.mjs', { ...WIN, cwd: 'C:\\repo', existsSync }), 'deny');
  assert.equal(bash('powershell -File C:\\Users\\u\\Claude\\claude-pipeline\\install.ps1', { ...WIN, cwd: 'C:\\repo', existsSync }), 'deny');
  assert.equal(bash('node C:\\Users\\u\\Claude\\claude-pipeline\\install.mjs --check', { ...WIN, cwd: 'C:\\repo', existsSync }), 'allow');
});

test('bash: pipeline protect --apply through the Windows form', () => {
  assert.equal(bash('node C:\\Users\\u\\.claude\\pipeline\\bin\\pipeline.mjs protect --apply', { ...WIN, cwd: 'C:\\repo' }), 'deny');
});

// ---- job runner unwrap ----------------------------------------------------------------------

test('bash: job start unwraps the inner command', () => {
  const job = (inner) => `node ~/.claude/pipeline/bin/pipeline.mjs job start x -- ${inner}`;
  assert.equal(bash(job('rm -rf ~/.claude/pipeline')), 'deny');
  assert.equal(bash(job('cp evil ~/.claude/settings.json')), 'deny');
  assert.equal(bash(job('npm test')), 'allow');
  assert.equal(bash(job('cat ~/.claude/pipeline/VERSION')), 'allow');
  assert.equal(bash(job('sh install.sh'), inCheckout), 'deny');
  assert.equal(bash(job('echo ok'), inCheckout), 'allow');
});

// ---- Windows --------------------------------------------------------------------------------

test('bash on win32: PowerShell and cmd forms of the home path', () => {
  const w = (cmd) => evaluateBashForFiles(cmd, { ...WIN, cwd: 'C:\\repo' }).decision;
  assert.equal(w('Set-Content $env:USERPROFILE\\.claude\\settings.json x'), 'deny');
  assert.equal(w('Set-Content $ENV:userprofile\\.claude\\settings.json x'), 'deny');
  assert.equal(w('del %USERPROFILE%\\.claude\\agents\\judge.md'), 'deny');
  assert.equal(w('Remove-Item -Recurse C:\\Users\\u\\.claude\\pipeline'), 'deny');
  assert.equal(w('Remove-Item -Recurse c:\\users\\U\\.CLAUDE\\PIPELINE'), 'deny');
  assert.equal(w('rm -rf /c/Users/u/.claude/pipeline'), 'deny');
  assert.equal(w('rm -rf /mnt/c/Users/u/.claude/pipeline'), 'deny');
  assert.equal(w('pwsh -NoProfile -Command "Remove-Item $env:USERPROFILE\\.claude\\settings.json"'), 'deny');
  assert.equal(w('Get-Content $env:USERPROFILE\\.claude\\settings.json'), 'allow');
  assert.equal(w('Get-ChildItem $env:USERPROFILE\\.claude\\pipeline'), 'allow');
  assert.equal(w('pwsh -NoProfile -Command "Get-Content $env:USERPROFILE\\.claude\\settings.json"'), 'allow');
  assert.equal(w('node C:\\Users\\u\\.claude\\pipeline\\bin\\pipeline.mjs preflight'), 'allow');
  assert.equal(w('node C:/Users/u/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow');
  assert.equal(w('Set-Content C:\\repo\\a.txt x'), 'allow');
  assert.equal(w('Set-Content C:\\Users\\u\\.claude\\CLAUDE.md x'), 'allow');
  assert.equal(w('$env:pipeline_admin = "1"'), 'deny');
});

test('bash on darwin: case-insensitive match of the protected path', () => {
  assert.equal(bash('rm -rf /HOME/U/.Claude/Pipeline', MAC), 'deny');
  assert.equal(bash('rm -rf /HOME/U/.Claude/Pipeline', LINUX), 'allow');
});

test('bash: a cwd inside a protected root only allows read-only commands', () => {
  const o = { cwd: '/home/u/.claude/pipeline/hooks' };
  assert.equal(bash('ls && cat guard-git.mjs', o), 'allow');
  assert.equal(bash('echo x > guard-git.mjs', o), 'deny');
  assert.equal(bash('sed -i s/a/b/ guard-git.mjs', o), 'deny');
  assert.equal(bash('rm *.mjs', o), 'deny');
  assert.equal(bash('npm install', o), 'deny');
});

test('bash: a command line too complex to parse fully is denied when it refers to a protected path', () => {
  const deep = `cat ~/.claude/pipeline/VERSION ${'$('.repeat(250)}x${')'.repeat(250)}`;
  assert.equal(simpleCommands(deep).truncated, true, 'the fixture must actually truncate');
  assert.equal(bash(deep), 'deny');
  const deepPlain = `cat /repo/a.txt ${'$('.repeat(250)}x${')'.repeat(250)}`;
  assert.equal(bash(deepPlain), 'allow', 'no protected reference: truncation alone does not deny');
});

test('bash: a bare command with a cwd inside a protected root is denied, and a read-only one is not', () => {
  const o = { cwd: '/home/u/.claude/skills/ship' };
  assert.equal(bash('make', o), 'deny');
  assert.equal(bash('./build.sh', o), 'deny');
  assert.equal(bash('ls', o), 'allow');
  assert.equal(bash('make', { cwd: '/repo' }), 'allow');
});

test('bash: tee and in-place edits anywhere in a line that names a protected path are denied (spec: no output redirection)', () => {
  assert.equal(bash('cat ~/.claude/settings.json | tee /tmp/copy'), 'deny');
  assert.equal(bash('cat ~/.claude/settings.json | tee -a /tmp/copy'), 'deny');
  assert.equal(bash('ls ~/.claude/pipeline; sed -i s/a/b/ notes.txt'), 'deny');
  assert.equal(bash('cat ~/.claude/pipeline/VERSION; perl -pi -e s/a/b/ notes.txt'), 'deny');
  assert.equal(bash('sed -i s/a/b/ notes.txt'), 'allow', 'no protected reference, so in-place edits elsewhere are fine');
  assert.equal(bash('echo a | tee notes.txt'), 'allow');
});

test('bash: git global options that run commands make git non-read-only', () => {
  assert.equal(bash("VAR='!rm -rf x' git --config-env=alias.log=VAR log ~/.claude/pipeline"), 'deny');
  assert.equal(bash('git -C ~/.claude/pipeline --no-pager log -1'), 'allow');
});

test('bash: never throws on odd input', () => {
  for (const c of [undefined, null, 42, {}, '\0', '"', "'", '$(', '`', '<<', '\\']) {
    assert.doesNotThrow(() => evaluateBashForFiles(c, { ...LINUX, cwd: '/repo' }));
  }
  assert.doesNotThrow(() => evaluateFileTool(undefined, LINUX));
  assert.doesNotThrow(() => evaluateFileTool({ tool_name: 'Edit', tool_input: { file_path: 7 } }, LINUX));
});

// ---- symlinks (real filesystem) -------------------------------------------------------------

test('file tool: an Edit through a real symlink into a protected skill dir is denied', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-link-')); // deliberately not realpath'd: macOS /var is itself a symlink
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const ship = path.join(home, '.claude', 'skills', 'ship');
  fs.mkdirSync(ship, { recursive: true });
  fs.writeFileSync(path.join(ship, 'SKILL.md'), 'x');
  try {
    fs.symlinkSync(ship, path.join(tmp, 'link'), 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('cannot create symlinks here');
    throw e;
  }
  const opts = { home, env: {}, platform: process.platform };
  const edit = (p) => evaluateFileTool({ tool_name: 'Edit', tool_input: { file_path: p, old_string: 'x', new_string: 'y' }, cwd: tmp }, opts).decision;
  assert.equal(edit(path.join(tmp, 'link', 'SKILL.md')), 'deny');
  assert.equal(edit(path.join(tmp, 'link', 'brand-new.md')), 'deny', 'new file under the link');
  assert.equal(edit(path.join(tmp, 'plain.md')), 'allow');
});

test('file tool: a symlinked home still guards the real path (e.g. /var -> /private/var)', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-home-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const realHome = path.join(tmp, 'real-home');
  fs.mkdirSync(path.join(realHome, '.claude', 'pipeline'), { recursive: true });
  try {
    fs.symlinkSync(realHome, path.join(tmp, 'home-alias'), 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('cannot create symlinks here');
    throw e;
  }
  const opts = { home: path.join(tmp, 'home-alias'), env: {}, platform: process.platform };
  const target = path.join(realHome, '.claude', 'pipeline', 'x.mjs');
  assert.equal(evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: target, content: 'x' }, cwd: tmp }, opts).decision, 'deny');
});

test('file tool: a dangling symlink pointing into a protected root is denied', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-dangle-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  try {
    fs.symlinkSync(path.join(home, '.claude', 'agents', 'judge.md'), path.join(tmp, 'dangling.md'));
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('cannot create symlinks here');
    throw e;
  }
  const r = evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'dangling.md'), content: 'x' }, cwd: tmp }, { home, env: {}, platform: process.platform });
  assert.equal(r.decision, 'deny');
});

// ---- the hook script itself -----------------------------------------------------------------

function runHook(input, { env = {}, home, hook = HOOK } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.PIPELINE_ADMIN;
  Object.assign(childEnv, env);
  if (home) { childEnv.HOME = home; childEnv.USERPROFILE = home; }
  const r = spawnSync(process.execPath, [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: childEnv,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tmpHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-spawn-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('hook: denies a Write to $HOME/.claude/settings.json with the documented JSON', (t) => {
  const home = tmpHome(t);
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: path.join(home, '.claude', 'settings.json'), content: '{}' }, cwd: home }, { home });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^\[claude-pipeline guard-files\] /);
});

test('hook: allows an Edit to a repo file with empty stdout', (t) => {
  const home = tmpHome(t);
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(home, 'repo', 'src', 'app.ts'), old_string: 'a', new_string: 'b' }, cwd: path.join(home, 'repo') }, { home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook: PIPELINE_ADMIN=1 in the process env allows the same Write', (t) => {
  const home = tmpHome(t);
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: path.join(home, '.claude', 'settings.json'), content: '{}' }, cwd: home }, { home, env: { PIPELINE_ADMIN: '1' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook: denies a Bash write to a protected path and allows a read', (t) => {
  const home = tmpHome(t);
  const deny = runHook({ tool_name: 'Bash', tool_input: { command: 'echo x > ~/.claude/skills/ship/SKILL.md' }, cwd: home }, { home });
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = runHook({ tool_name: 'Bash', tool_input: { command: 'cat ~/.claude/skills/ship/SKILL.md' }, cwd: home }, { home });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
});

test('hook: Bash PIPELINE_ADMIN is denied even though the env var is not set', (t) => {
  const home = tmpHome(t);
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'export PIPELINE_ADMIN=1' }, cwd: home }, { home });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: malformed stdin that mentions .claude is denied', (t) => {
  const home = tmpHome(t);
  const r = runHook('{"tool_name":"Write","tool_input":{"file_path":"/x/.claude/settings.json" <<<broken', { home });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /guard-files/);
});

test('hook: malformed stdin that mentions PIPELINE_ADMIN, disableAllHooks or install. is denied', (t) => {
  const home = tmpHome(t);
  for (const raw of ['{{ PIPELINE_ADMIN', 'oops disableAllHooks', 'not json install.sh']) {
    const r = runHook(raw, { home });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', raw);
  }
});

test('hook: malformed stdin that mentions nothing sensitive is allowed', (t) => {
  const home = tmpHome(t);
  for (const raw of ['', 'not json at all', '{"tool_name":']) {
    const r = runHook(raw, { home });
    assert.equal(r.status, 0, raw);
    assert.equal(r.stdout, '', raw);
  }
});

test('hook: malformed stdin is allowed in admin mode even when it mentions .claude', (t) => {
  const home = tmpHome(t);
  const r = runHook('{ .claude broken', { home, env: { PIPELINE_ADMIN: '1' } });
  assert.equal(r.stdout, '');
});

test('hook: if the policy module cannot be loaded, the keyword rule decides', (t) => {
  const dir = tmpHome(t);
  const lone = path.join(dir, 'guard-files.mjs'); // no lib/ beside it, so the dynamic import fails
  fs.copyFileSync(HOOK, lone);
  const risky = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.claude', 'x.md'), old_string: 'a', new_string: 'b' } }, { home: dir, hook: lone });
  assert.equal(JSON.parse(risky.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(risky.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/);
  const plain = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' } }, { home: dir, hook: lone });
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout, '');
  const admin = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.claude', 'x.md'), old_string: 'a', new_string: 'b' } }, { home: dir, hook: lone, env: { PIPELINE_ADMIN: '1' } });
  assert.equal(admin.stdout, '');
});

test('hook: unrelated tools and shapes are allowed', (t) => {
  const home = tmpHome(t);
  for (const input of [{ tool_name: 'Read', tool_input: { file_path: path.join(home, '.claude', 'settings.json') } }, [], 7, null, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 5 } }]) {
    const r = runHook(input, { home });
    assert.equal(r.status, 0, JSON.stringify(input));
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
});
