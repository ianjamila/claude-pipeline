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
    '/home/u/.claude/skills/review',
    '/home/u/.claude/skills/verify',
    '/home/u/.claude/skills/pipeline-setup',
    '/home/u/.claude/agents/implementer.md',
    '/home/u/.claude/agents/verifier.md',
    '/home/u/.claude/agents/judge.md',
    '/home/u/.claude/agents/arbiter.md',
    '/home/u/.claude/pipeline',
    '/home/u/.claude/settings.json',
    '/home/u/.claude/pipeline-state/owner-go',
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
  ['Write a script exporting PIPELINE_ADMIN', 'Write', { file_path: '/tmp/x.sh', content: 'export PIPELINE_ADMIN=1\nclaude' }],
  ['Edit through a .. segment', 'Edit', { file_path: '/home/u/.claude/skills/ship/../ship/SKILL.md', old_string: 'a', new_string: 'b' }],
  ['Edit review skill via ~', 'Edit', { file_path: '~/.claude/skills/review/SKILL.md', old_string: 'a', new_string: 'b' }],
  ['Write review skill', 'Write', { file_path: '/home/u/.claude/skills/review/SKILL.md', content: 'x' }],
  ['Write pipeline-setup skill', 'Write', { file_path: '/home/u/.claude/skills/pipeline-setup/SKILL.md', content: 'x' }],
  ['Write the ship skill directory itself', 'Write', { file_path: '/home/u/.claude/skills/ship', content: 'x' }],
  ['relative path resolved against cwd', 'Edit', { file_path: '../home/u/.claude/pipeline/x', old_string: 'a', new_string: 'b' }, '/repo'],
  ['MultiEdit assigning PIPELINE_ADMIN in the second edit', 'MultiEdit', { file_path: '/repo/run.sh', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'PIPELINE_ADMIN=1' }] }],
  ['NotebookEdit new_source setting PIPELINE_ADMIN', 'NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: 'os.environ["PIPELINE_ADMIN"]="1"' }],
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
  ['another skill under ~/.claude/skills', 'Write', { file_path: '/home/u/.claude/skills/other/SKILL.md', content: 'x' }],
  ['prefix lookalike of the review skill', 'Edit', { file_path: '/home/u/.claude/skills/reviews/SKILL.md', old_string: 'a', new_string: 'b' }],
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
  ['redirect into the review skill', 'echo x > ~/.claude/skills/review/SKILL.md'],
  ['tee into the review skill', 'echo x | tee ~/.claude/skills/review/SKILL.md'],
  ['cp over the review skill', 'cp evil.md ~/.claude/skills/review/SKILL.md'],
  ['rm the review skill', 'rm -rf ~/.claude/skills/review'],
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
  ['write another skill', 'cp evil.md ~/.claude/skills/other/SKILL.md'],
  ['cat the review skill', 'cat ~/.claude/skills/review/SKILL.md'],
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
  assert.equal(w("pwsh -NoProfile -Command 'Get-Content $env:USERPROFILE\\.claude\\settings.json'"), 'allow');
  // inside bash double quotes $env is a bash variable, so the script is only known at run time: fail closed
  assert.equal(w('pwsh -NoProfile -Command "Get-Content $env:USERPROFILE\\.claude\\settings.json"'), 'deny');
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

test('bash: a command line too complex to parse fully is denied', () => {
  const deep = `cat ~/.claude/pipeline/VERSION ${'$('.repeat(250)}x${')'.repeat(250)}`;
  assert.equal(simpleCommands(deep).truncated, true, 'the fixture must actually truncate');
  assert.equal(bash(deep), 'deny');
  const deepPlain = `cat /repo/a.txt ${'$('.repeat(250)}x${')'.repeat(250)}`;
  assert.equal(bash(deepPlain), 'deny', 'a truncated parse cannot prove anything harmless');
});

test('bash: a bare command with a cwd inside a protected root is denied, and a read-only one is not', () => {
  const o = { cwd: '/home/u/.claude/skills/ship' };
  assert.equal(bash('make', o), 'deny');
  assert.equal(bash('./build.sh', o), 'deny');
  assert.equal(bash('ls', o), 'allow');
  assert.equal(bash('make', { cwd: '/repo' }), 'allow');
});

test('bash: tee, sed -i and perl -pi are judged by the files they name, not by what else is on the line', () => {
  assert.equal(bash('cat ~/.claude/settings.json | tee /tmp/copy'), 'allow');
  assert.equal(bash('cat ~/.claude/settings.json | tee -a /tmp/copy'), 'allow');
  assert.equal(bash('cat ~/.claude/settings.json | tee ~/.claude/settings.json'), 'deny');
  assert.equal(bash('ls ~/.claude/pipeline; sed -i s/a/b/ notes.txt'), 'allow');
  assert.equal(bash('cat ~/.claude/pipeline/VERSION; perl -pi -e s/a/b/ notes.txt'), 'allow');
  assert.equal(bash('ls ~/.claude/pipeline; sed -i s/a/b/ ~/.claude/pipeline/VERSION'), 'deny');
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
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-home-')));
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
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-dangle-')));
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

// ---- MCP file tools ---------------------------------------------------------------------------

const mcp = (tool_name, tool_input, opts = {}, cwd = '/repo') => evaluateFileTool({ tool_name, tool_input, cwd }, { ...LINUX, ...opts }).decision;

const MCP_DENY = [
  ['filesystem write_file to settings via ~', 'mcp__filesystem__write_file', { path: '~/.claude/settings.json', content: '{}' }],
  ['filesystem edit_file on the ship skill', 'mcp__filesystem__edit_file', { path: '/home/u/.claude/skills/ship/SKILL.md', edits: [{ oldText: 'a', newText: 'b' }], dryRun: false }],
  ['filesystem move_file onto an agent', 'mcp__filesystem__move_file', { source: '/tmp/x', destination: '/home/u/.claude/agents/judge.md' }],
  ['filesystem move_file away from a protected dir', 'mcp__filesystem__move_file', { source: '/home/u/.claude/skills/verify', destination: '/tmp/v' }],
  ['filesystem create_directory under a skill', 'mcp__filesystem__create_directory', { path: '/home/u/.claude/skills/ship/new' }],
  ['other server put_object into the pipeline dir', 'mcp__other__put_object', { path: '/home/u/.claude/pipeline/x' }],
  ['filePath key', 'mcp__editor__write_file', { filePath: '~/.claude/pipeline/hooks/guard-git.mjs', content: 'x' }],
  ['file_path key', 'mcp__editor__apply_patch', { file_path: '/home/u/.claude/agents/arbiter.md', patch: '...' }],
  ['from key only', 'mcp__files__move_path', { from: '/home/u/.claude/pipeline/hooks/guard-git.mjs', to: '/tmp/x' }],
  ['dest key', 'mcp__files__copy_file', { from: '/tmp/a', dest: '/home/u/.claude/agents/verifier.md' }],
  ['to key', 'mcp__files__rename_path', { from: '/tmp/a', to: '/home/u/.claude/skills/pipeline-setup/SKILL.md' }],
  ['paths array', 'mcp__files__delete_files', { paths: ['/repo/a.ts', '/home/u/.claude/agents/implementer.md'] }],
  ['nested path inside edits[]', 'mcp__files__update_files', { edits: [{ path: '/home/u/.claude/settings.json', newText: '{}' }] }],
  ['directory key', 'mcp__files__remove_directory', { directory: '~/.claude/pipeline' }],
  ['.. segment', 'mcp__filesystem__write_file', { path: '/home/u/.claude/skills/ship/../ship/SKILL.md', content: 'x' }],
  ['relative path resolved against cwd', 'mcp__filesystem__write_file', { path: '../home/u/.claude/pipeline/x', content: 'x' }],
  ['write_file of a script that sets PIPELINE_ADMIN', 'mcp__filesystem__write_file', { path: '/tmp/x.sh', content: 'export PIPELINE_ADMIN=1' }],
  ['edit_file newText that sets PIPELINE_ADMIN', 'mcp__filesystem__edit_file', { path: '/repo/run.sh', edits: [{ oldText: 'a', newText: 'PIPELINE_ADMIN=1 claude' }] }],
  ['write_file disableAllHooks into repo settings', 'mcp__filesystem__write_file', { path: '/repo/.claude/settings.json', content: '{"disableAllHooks": true}' }],
  ['edit_file newText adds disableAllHooks', 'mcp__filesystem__edit_file', { path: '/repo/.claude/settings.local.json', edits: [{ oldText: '{', newText: '{"disableAllHooks":true,' }] }],
  ['body key', 'mcp__files__put_file', { path: '/repo/.claude/settings.json', body: '{"disableAllHooks":true}' }],
  ['chmod verb in an unusual tool name', 'mcp__plugin_x_files__chmod', { path: '/home/u/.claude/pipeline/bin/pipeline.mjs', mode: '000' }],
  ['save_file', 'mcp__files__save_file', { path: '~/.claude/settings.json', text: '{}' }],
  ['replace_in_file', 'mcp__files__replace_in_file', { path: '~/.claude/pipeline/hooks/guard-git.mjs', search: 'a', replace: 'b' }],
  ['protected path under an unlisted key on a write tool', 'mcp__files__write_file', { name: '/home/u/.claude/settings.json', content: 'x' }],
  ['rm verb on its own word', 'mcp__files__rm', { path: '/home/u/.claude/agents/judge.md' }],
];

for (const [name, tool, input] of MCP_DENY) {
  test(`mcp tool DENY: ${name}`, () => {
    const r = evaluateFileTool({ tool_name: tool, tool_input: input, cwd: '/repo' }, LINUX);
    assert.equal(r.decision, 'deny', JSON.stringify(input));
    assert.ok(r.reason.length > 0);
  });
}

const MCP_ALLOW = [
  ['filesystem read_text_file of settings', 'mcp__filesystem__read_text_file', { path: '~/.claude/settings.json' }],
  ['filesystem read_file', 'mcp__filesystem__read_file', { path: '/home/u/.claude/skills/ship/SKILL.md' }],
  ['filesystem read_multiple_files', 'mcp__filesystem__read_multiple_files', { paths: ['/home/u/.claude/agents/judge.md', '/home/u/.claude/pipeline/VERSION'] }],
  ['filesystem list_directory', 'mcp__filesystem__list_directory', { path: '~/.claude/pipeline' }],
  ['filesystem directory_tree', 'mcp__filesystem__directory_tree', { path: '/home/u/.claude' }],
  ['filesystem search_files', 'mcp__filesystem__search_files', { path: '~/.claude/pipeline', pattern: 'disableAllHooks' }],
  ['filesystem get_file_info', 'mcp__filesystem__get_file_info', { path: '~/.claude/settings.json' }],
  ['read tool with a disableAllHooks query and a settings path', 'mcp__files__search_text', { path: '/repo/.claude/settings.json', text: 'disableAllHooks' }],
  ['filesystem write_file to a repo file', 'mcp__filesystem__write_file', { path: '/repo/a.ts', content: 'x' }],
  ['filesystem write_file to a lookalike skill', 'mcp__filesystem__write_file', { path: '/home/u/.claude/skills/shipping/SKILL.md', content: 'x' }],
  ['filesystem write_file to CLAUDE.md', 'mcp__filesystem__write_file', { path: '/home/u/.claude/CLAUDE.md', content: 'x' }],
  ['filesystem move_file between unprotected paths', 'mcp__filesystem__move_file', { source: '/tmp/a', destination: '/repo/b' }],
  ['write_file of a repo settings file without disableAllHooks', 'mcp__filesystem__write_file', { path: '/repo/.claude/settings.json', content: '{"permissions":{}}' }],
  ['write_file mentioning disableAllHooks outside a settings file', 'mcp__filesystem__write_file', { path: '/repo/docs/n.md', content: 'about disableAllHooks' }],
  ['write_file documenting the guard without assigning PIPELINE_ADMIN', 'mcp__filesystem__write_file', { path: '/repo/docs/n.md', content: 'the PIPELINE_ADMIN guard' }],
  ['write tool with no path keys', 'mcp__notes__create_note', { title: 't', text: 'launch with PIPELINE_ADMIN=1 claude' }],
  ['database tool', 'mcp__plugin_supabase_supabase__apply_migration', { name: 'x', query: 'select 1' }],
  ['issue update with no path keys', 'mcp__sentry__update_issue', { issueId: 'A-1', status: 'resolved' }],
  ['no tool_input', 'mcp__filesystem__write_file', undefined],
  ['non-string path values', 'mcp__filesystem__write_file', { path: 7, paths: [null, {}], content: 'x' }],
];

for (const [name, tool, input] of MCP_ALLOW) {
  test(`mcp tool ALLOW: ${name}`, () => {
    assert.equal(mcp(tool, input), 'allow', JSON.stringify(input));
  });
}

test('mcp tool: PIPELINE_ADMIN=1 in the process env allows everything', () => {
  const env = { PIPELINE_ADMIN: '1' };
  assert.equal(mcp('mcp__filesystem__write_file', { path: '~/.claude/settings.json', content: '{}' }, { env }), 'allow');
  assert.equal(mcp('mcp__filesystem__move_file', { source: '/tmp/x', destination: '/home/u/.claude/agents/judge.md' }, { env }), 'allow');
});

test('mcp tool: a target that resolves into a protected root through a symlink is denied', () => {
  const realpath = (p) => (p.startsWith('/tmp/link') ? p.replace('/tmp/link', '/home/u/.claude/skills/ship') : p);
  const existsSync = (p) => p === '/tmp/link';
  assert.equal(mcp('mcp__filesystem__write_file', { path: '/tmp/link/SKILL.md', content: 'x' }, { realpath, existsSync }), 'deny');
});

test('mcp tool: case-insensitive on darwin and Windows paths on win32', () => {
  assert.equal(mcp('mcp__filesystem__write_file', { path: '/HOME/U/.Claude/Settings.json', content: 'x' }, MAC), 'deny');
  assert.equal(mcp('mcp__filesystem__write_file', { path: '/HOME/U/.Claude/Settings.json', content: 'x' }, LINUX), 'allow');
  assert.equal(mcp('mcp__filesystem__write_file', { path: 'C:\\Users\\u\\.claude\\skills\\ship\\SKILL.md', content: 'x' }, WIN, 'C:\\repo'), 'deny');
});

test('mcp tool: deeply nested or huge inputs do not throw', () => {
  let deep = { path: '/repo/a' };
  for (let i = 0; i < 500; i++) deep = { wrap: deep };
  assert.doesNotThrow(() => mcp('mcp__x__write_file', deep));
  assert.doesNotThrow(() => mcp('mcp__x__write_file', { paths: Array.from({ length: 5000 }, (_, i) => `/repo/f${i}`), content: 'x' }));
});

// ---- PIPELINE_ADMIN: naming it is fine, setting it is not -----------------------------------------

const ADMIN_BASH_DENY = [
  ['export', 'export PIPELINE_ADMIN=1'],
  ['export without a value', 'export PIPELINE_ADMIN'],
  ['command prefix', 'PIPELINE_ADMIN=1 node install.mjs'],
  ['env prefix', 'env PIPELINE_ADMIN=1 claude'],
  ['env with flags', 'env -i -u X PIPELINE_ADMIN=1 claude'],
  ['declare -x', 'declare -x PIPELINE_ADMIN=1'],
  ['JSON key in an echo redirect', `echo '{"env":{"PIPELINE_ADMIN":"1"}}' > x.json`],
  ['env["..."] lookup', `node -e "process.env['PIPELINE_ADMIN']='1'"`],
  ['putenv with a comma', `python3 -c "import os; os.putenv('PIPELINE_ADMIN', '1')"`],
  ['PowerShell $env:', '$env:PIPELINE_ADMIN = "1"'],
  ['PowerShell $env: with a different case', '$ENV:pipeline_admin="1"'],
  ['cmd set', 'set PIPELINE_ADMIN=1'],
  ['setx', 'setx PIPELINE_ADMIN 1'],
  ['csh setenv', 'setenv PIPELINE_ADMIN 1'],
  ['spaces around =', 'PIPELINE_ADMIN = 1'],
  ['quote-split name', "export PIPELINE_'ADMIN'=1"],
  ['backslash-split name', 'export PIPELINE_AD\\MIN=1'],
  ['ANSI-C split name', "env $'PIPELINE_\\x41DMIN=1' claude"],
  ['inside bash -c', 'bash -c "export PIPELINE_ADMIN=1; claude"'],
  ['inside a job', 'node ~/.claude/pipeline/bin/pipeline.mjs job start x -- env PIPELINE_ADMIN=1 claude'],
  ['octal ANSI-C name (only the parsed words reveal it)', "env $'\\120IPELINE_ADMIN=1' claude"],
  ['js-escaped name inside a one-liner', `node -e "process.env['PIPELINE_\\x41DMIN']='1'"`],
  ['quote-split name after a command line too deep to parse', `echo ${'$('.repeat(250)}x${')'.repeat(250)}; export PIPELINE_"ADMIN"=1`],
  ['prefix on a bash that reads a heredoc', 'PIPELINE_ADMIN=1 bash <<EOF\nclaude\nEOF'],
];

for (const [name, cmd] of ADMIN_BASH_DENY) {
  test(`PIPELINE_ADMIN set in bash DENY: ${name}`, () => {
    assert.equal(bash(cmd), 'deny', cmd);
  });
}

const ADMIN_BASH_ALLOW = [
  ['grep for the name', 'grep -r PIPELINE_ADMIN docs/'],
  ['grep with quotes', 'grep -rn "PIPELINE_ADMIN" docs/ src/'],
  ['grep in a pipe', 'cat docs/admin.md | grep -n PIPELINE_ADMIN'],
  ['echo of prose', 'echo "the PIPELINE_ADMIN guard"'],
  ['commit message prose', 'git commit -m "docs: explain the PIPELINE_ADMIN switch"'],
  ['rg count', 'rg -c PIPELINE_ADMIN'],
  ['lookalike variable prefix', 'FOO_PIPELINE_ADMIN=1 node x.js'],
  ['lookalike longer name', 'echo PIPELINE_ADMINISTRATOR'],
  ['lowercase name on POSIX is a different variable', 'pipeline_admin=1 node x.js'],
];

for (const [name, cmd] of ADMIN_BASH_ALLOW) {
  test(`PIPELINE_ADMIN named in bash ALLOW: ${name}`, () => {
    assert.equal(bash(cmd), 'allow', cmd);
  });
}

test('PIPELINE_ADMIN on win32: variable names are case-insensitive', () => {
  const w = (cmd) => evaluateBashForFiles(cmd, { ...WIN, cwd: 'C:\\repo' }).decision;
  assert.equal(w('pipeline_admin=1 node x.js'), 'deny');
  assert.equal(w('set pipeline_admin=1'), 'deny');
  assert.equal(w('$env:pipeline_admin = "1"'), 'deny');
  assert.equal(w('grep -r PIPELINE_ADMIN docs/'), 'allow');
});

const ADMIN_FILE_DENY = [
  ['README telling people how to launch', 'Launch with `PIPELINE_ADMIN=1 claude`'],
  ['export line', 'export PIPELINE_ADMIN=1\nclaude'],
  ['JSON object key', '{"env": {"PIPELINE_ADMIN": "1"}}'],
  ['env lookup', 'env["PIPELINE_ADMIN"] = "1"'],
  ['process.env assignment', "process.env.PIPELINE_ADMIN = '1'"],
  ['PowerShell', '$env:PIPELINE_ADMIN = "1"'],
  ['setx', 'setx PIPELINE_ADMIN 1'],
  ['YAML env block', 'env:\n  PIPELINE_ADMIN: 1\n'],
  ['unicode-escaped name', 'PIPELINE_\\u0041DMIN=1 claude'],
];

for (const [name, content] of ADMIN_FILE_DENY) {
  test(`PIPELINE_ADMIN set in file content DENY: ${name}`, () => {
    assert.equal(file('Write', { file_path: '/repo/README.md', content }), 'deny', content);
    assert.equal(file('Edit', { file_path: '/repo/README.md', old_string: 'x', new_string: content }), 'deny', content);
  });
}

const ADMIN_FILE_ALLOW = [
  ['prose naming the guard', 'the PIPELINE_ADMIN guard'],
  ['prose about the switch', 'Only the owner can turn on PIPELINE_ADMIN when launching Claude Code.'],
  ['a doc path', 'See docs/PIPELINE_ADMIN.md'],
  ['YAML key documented with a description', 'PIPELINE_ADMIN: owner switch, never set by agents'],
  ['lookalike name', 'FOO_PIPELINE_ADMIN=1'],
  ['JS comparison', "if (process.env.PIPELINE_ADMIN === '1') return;"],
  ['JS inequality', "if (env.PIPELINE_ADMIN !== '1') deny();"],
  ['bash test', 'if [[ $PIPELINE_ADMIN == 1 ]]; then echo admin; fi'],
  ['bash regex test', 'if [[ $PIPELINE_ADMIN =~ ^1$ ]]; then echo admin; fi'],
];

for (const [name, content] of ADMIN_FILE_ALLOW) {
  test(`PIPELINE_ADMIN named in file content ALLOW: ${name}`, () => {
    assert.equal(file('Write', { file_path: '/repo/README.md', content }), 'allow', content);
    assert.equal(file('MultiEdit', { file_path: '/repo/README.md', edits: [{ old_string: 'x', new_string: content }] }), 'allow', content);
    assert.equal(file('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: content }), 'allow', content);
  });
}

test('the default env is the real process env (spec: env = process.env)', () => {
  const had = Object.hasOwn(process.env, 'PIPELINE_ADMIN');
  const prev = process.env.PIPELINE_ADMIN;
  const noEnv = { home: '/home/u', platform: 'linux', realpath: (p) => p, existsSync: () => false };
  try {
    process.env.PIPELINE_ADMIN = '1';
    assert.equal(evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: '/home/u/.claude/settings.json', content: '{}' }, cwd: '/repo' }, noEnv).decision, 'allow');
    assert.equal(evaluateBashForFiles('rm -rf ~/.claude/pipeline', { ...noEnv, cwd: '/repo' }).decision, 'allow');
    delete process.env.PIPELINE_ADMIN;
    assert.equal(evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: '/home/u/.claude/settings.json', content: '{}' }, cwd: '/repo' }, noEnv).decision, 'deny');
    assert.equal(evaluateBashForFiles('rm -rf ~/.claude/pipeline', { ...noEnv, cwd: '/repo' }).decision, 'deny');
  } finally {
    if (had) process.env.PIPELINE_ADMIN = prev; else delete process.env.PIPELINE_ADMIN;
  }
});

test('PIPELINE_ADMIN removed by an edit is fine: only the new text is judged', () => {
  assert.equal(file('Edit', { file_path: '/repo/run.sh', old_string: 'PIPELINE_ADMIN=1 claude', new_string: 'claude' }), 'allow');
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
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-spawn-')));
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

test('hook: denies an MCP filesystem write to a protected path and allows a read', (t) => {
  const home = tmpHome(t);
  const deny = runHook({ tool_name: 'mcp__filesystem__write_file', tool_input: { path: path.join(home, '.claude', 'settings.json'), content: '{}' }, cwd: home }, { home });
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const move = runHook({ tool_name: 'mcp__filesystem__move_file', tool_input: { source: '/tmp/x', destination: '~/.claude/agents/judge.md' }, cwd: home }, { home });
  assert.equal(JSON.parse(move.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const read = runHook({ tool_name: 'mcp__filesystem__read_text_file', tool_input: { path: path.join(home, '.claude', 'settings.json') }, cwd: home }, { home });
  assert.equal(read.status, 0);
  assert.equal(read.stdout, '');
  const other = runHook({ tool_name: 'mcp__sentry__update_issue', tool_input: { issueId: 'A-1' }, cwd: home }, { home });
  assert.equal(other.stdout, '');
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

// Fail-closed change (#21): the keyword condition is gone. Input the hook cannot read has no tool name to judge by, so it is
// refused whatever it mentions; only the owner's PIPELINE_ADMIN launch passes it.
test('hook: malformed stdin is denied even when it mentions nothing sensitive', (t) => {
  const home = tmpHome(t);
  for (const raw of ['', 'not json at all', '{"tool_name":']) {
    const r = runHook(raw, { home });
    assert.equal(r.status, 0, raw);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', raw);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/, raw);
  }
});

test('hook: malformed stdin is allowed in admin mode even when it mentions .claude', (t) => {
  const home = tmpHome(t);
  const r = runHook('{ .claude broken', { home, env: { PIPELINE_ADMIN: '1' } });
  assert.equal(r.stdout, '');
});

test('hook: if the policy module cannot be loaded, every call that is the hook\'s own is denied', (t) => {
  const dir = tmpHome(t);
  const lone = path.join(dir, 'guard-files.mjs'); // no lib/ beside it, so the dynamic import fails
  fs.copyFileSync(HOOK, lone);
  const risky = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.claude', 'x.md'), old_string: 'a', new_string: 'b' } }, { home: dir, hook: lone });
  assert.equal(JSON.parse(risky.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(risky.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/);
  for (const command of ['env -u CLAUDECODE node x.mjs', 'PIPELINE_GH=/tmp/g node pipeline.mjs merge 1']) {
    const sw = runHook({ tool_name: 'Bash', tool_input: { command } }, { home: dir, hook: lone });
    assert.equal(JSON.parse(sw.stdout).hookSpecificOutput.permissionDecision, 'deny', command);
  }
  // formerly allowed: an edit and a command that mention nothing sensitive (the keyword rule is gone)
  for (const input of [
    { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' } },
    { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    { tool_name: 'mcp__files__read_file', tool_input: { path: '/tmp/x' } },
  ]) {
    const plain = runHook(input, { home: dir, hook: lone });
    assert.equal(plain.status, 0);
    assert.equal(JSON.parse(plain.stdout).hookSpecificOutput.permissionDecision, 'deny', input.tool_name);
    assert.match(JSON.parse(plain.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/);
  }
  // a tool that is not the hook's own is still left alone: that is decided before the module is loaded
  const notOurs = runHook({ tool_name: 'Read', tool_input: { file_path: path.join(dir, '.claude', 'settings.json') } }, { home: dir, hook: lone });
  assert.equal(notOurs.status, 0);
  assert.equal(notOurs.stdout, '');
  const admin = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.claude', 'x.md'), old_string: 'a', new_string: 'b' } }, { home: dir, hook: lone, env: { PIPELINE_ADMIN: '1' } });
  assert.equal(admin.stdout, '');
});

// A copy of the hook whose policy module is a stub: the evaluator throws, or returns no decision. Both must deny (the
// hook used to deny an internal error only when the raw input held a sensitive word).
test('hook: an evaluator that throws, or returns no decision, is denied for a command and a file tool', (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.join(dir, 'lib'));
  const copy = path.join(dir, 'guard-files.mjs');
  fs.copyFileSync(HOOK, copy);
  const stub = (body) => fs.writeFileSync(path.join(dir, 'lib', 'files-policy.mjs'), body);
  const calls = [
    { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' } },
  ];
  for (const body of [
    "export const evaluateBashForFiles = () => { throw new Error('evaluator exploded'); };\nexport const evaluateFileTool = () => { throw new Error('evaluator exploded'); };\n",
    'export const evaluateBashForFiles = () => undefined;\nexport const evaluateFileTool = () => ({ decision: \'maybe\' });\n',
  ]) {
    stub(body);
    for (const input of calls) {
      const r = runHook(input, { home: dir, hook: copy });
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny', input.tool_name);
      assert.match(out.permissionDecisionReason, /internal error \((evaluator exploded|the policy returned no decision)\)/);
    }
    // a tool that is not the hook's own never reaches the evaluator
    assert.equal(runHook({ tool_name: 'Read', tool_input: { file_path: '/x' } }, { home: dir, hook: copy }).stdout, '');
    // the owner's PIPELINE_ADMIN launch still bypasses an internal error
    assert.equal(runHook(calls[0], { home: dir, hook: copy, env: { PIPELINE_ADMIN: '1' } }).stdout, '');
  }
});

test('hook: unrelated tools and shapes are allowed', (t) => {
  const home = tmpHome(t);
  for (const input of [{ tool_name: 'Read', tool_input: { file_path: path.join(home, '.claude', 'settings.json') } }, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 5 } }, { tool_name: 'Grep', tool_input: {} }]) {
    const r = runHook(input, { home });
    assert.equal(r.status, 0, JSON.stringify(input));
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
});

test('hook: input that is valid JSON but not an object is refused like malformed input (fail closed)', (t) => {
  const home = tmpHome(t);
  for (const input of [[], 7, null, 'text']) {
    const r = runHook(input, { home });
    assert.equal(r.status, 0, JSON.stringify(input));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(input));
  }
  assert.equal(runHook('[]', { home, env: { PIPELINE_ADMIN: '1' } }).stdout, '');
});

// ---- Monitor (review finding 1) ----------------------------------------------------------------------

test('hook: the Monitor tool is judged like Bash', (t) => {
  const home = tmpHome(t);
  const deny = runHook({ tool_name: 'Monitor', tool_input: { command: 'echo {} > ~/.claude/settings.json' }, cwd: home }, { home });
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = runHook({ tool_name: 'Monitor', tool_input: { command: 'tail -f /tmp/x.log' }, cwd: home }, { home });
  assert.equal(ok.stdout, '');
});

test('hook: a script file in the real working directory is read by the hook', (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'proj'));
  fs.writeFileSync(path.join(home, 'proj', 'w.sh'), 'echo {} > ~/.claude/settings.json\n');
  fs.writeFileSync(path.join(home, 'proj', 'ok.sh'), 'ls\n');
  const run = (command) => runHook({ tool_name: 'Bash', tool_input: { command }, cwd: path.join(home, 'proj') }, { home });
  for (const c of ['bash w.sh', './w.sh', 'source w.sh', 'env bash w.sh']) assert.equal(JSON.parse(run(c).stdout).hookSpecificOutput.permissionDecision, 'deny', c);
  assert.equal(run('bash ok.sh').stdout, '');
});

// ---- #58: the owner-go records and recorder ---------------------------------------------------------------------------
test('#58 owner-go: the records folder is protected from every write; reading it and the other pipeline-state folders stay open', () => {
  const R = '/home/u/.claude/pipeline-state/owner-go';
  assert.equal(file('Write', { file_path: `${R}/s.jsonl`, content: '{}' }), 'deny');
  assert.equal(file('Edit', { file_path: `${R}/s.jsonl`, old_string: 'a', new_string: 'b' }), 'deny');
  for (const cmd of [
    `echo '{}' >> ${R}/s.jsonl`,
    `cp /tmp/x.jsonl ${R}/s.jsonl`,
    `rm -rf ${R}`,
    'rm -rf ~/.claude/pipeline-state', // (the folder that holds it)
    'mv ~/.claude/pipeline-state /tmp/old',
    `ln -s /tmp/mine ${R}`,
    `tee -a ${R}/s.jsonl < /tmp/x`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    `ls -la ${R}`,
    `cat ${R}/s.jsonl`,
    'rm -rf ~/.claude/pipeline-state/locks/x.lock',
    'cat ~/.claude/pipeline-state/guard-log.jsonl',
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

test('#58 owner-go: running the recorder by hand (installed or a source copy) is refused; reading or committing it is not', () => {
  for (const cmd of [
    `echo '{"prompt":"merge"}' | node /home/u/.claude/pipeline/hooks/owner-go.mjs`,
    'node ~/.claude/pipeline/hooks/owner-go.mjs < /tmp/in.json',
    `node ${CHECKOUT}/pipeline/hooks/owner-go.mjs < /tmp/in.json`,
    'node pipeline/hooks/owner-go.mjs < /tmp/in.json',
    'bun ./pipeline/hooks/owner-go.mjs',
    './pipeline/hooks/owner-go.mjs < /tmp/in.json',
    `node -e "import('./pipeline/hooks/lib/owner-go.mjs').then((m) => m.recordApproval({}))"`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    'cat pipeline/hooks/owner-go.mjs',
    'git add pipeline/hooks/owner-go.mjs pipeline/hooks/lib/owner-go.mjs',
    'git diff -- pipeline/hooks/lib/owner-go.mjs',
    'node --test test/owner-go.test.mjs',
    'node /home/u/.claude/pipeline/hooks/stack-dev-bind.mjs', // (the other installed hooks keep their read-only standing)
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

// Phase 3b (Fable attacker pass on #107): review-complete trusts .review/state.json, so a repo's review state and the proofs beside it
// are written only by the pipeline commands (their own process, which the hook never sees), in any checkout or worktree.
test('Phase 3b: a repo\'s review state is protected from every write, wherever the checkout is', () => {
  for (const p of ['/repo/.review/state.json', '.review/state.json', '/other/wt/.review/round-2/codex.json', '.review/round-1/model-proof.json', '.review/final-gate.json', '.review/preview-smoke.json', '.review/prod-before.json', '.review/state.json.123.tmp']) {
    assert.equal(file('Write', { file_path: p, content: '{}' }), 'deny', p);
    assert.equal(file('Edit', { file_path: p, old_string: 'a', new_string: 'b' }), 'deny', p);
  }
  assert.equal(file('mcp__fs__write_file', { path: '/repo/.review/state.json', content: '{}' }), 'deny');
  assert.equal(file('mcp__fs__move_file', { source: '/tmp/forged', destination: '/repo/.review' }), 'deny', 'the folder that holds it');
  assert.equal(file('Write', { file_path: '/repo/.Review/State.json', content: '{}' }, MAC), 'deny', 'case-insensitive on macOS');
  for (const cmd of [
    "echo '{}' > .review/state.json",
    'cp /tmp/forged.json .review/state.json',
    'cp /tmp/forged.json /other/wt/.review/state.json',
    'tee .review/round-1/model-proof.json < /tmp/x',
    "sed -i 's/needs-human/ACCEPT/' .review/round-1/codex.json",
    'mkdir -p .review/round-3',
    'touch .review/final-gate.json',
    'ln -s /tmp/forged.json .review/state.json',
    'mv /tmp/forged .review',
    'rm -rf .review',
    'rsync -a /tmp/forged/ .review/',
    'tar -C .review -xf /tmp/forged.tar',
    'cd .review && echo x > state.json',
    'cd .review/round-1 && cp /tmp/x codex.json',
    'cp /tmp/x .review/*',
    'cp /tmp/x .review/round-*/codex.json',
    'cp /tmp/x .rev*/state.json',
    'shopt -s dotglob globstar; cp /tmp/x **/state.json',
    'cp /tmp/x */state.json(D)', // (a zsh glob qualifier: D lets the wildcard match the dot folder)
    'cp /tmp/x */state.json(#q.ND)',
    // (Codex R1: any round, any smoke target, not only the sample names; a wildcard name written into a review folder may be any of them)
    'cp /tmp/forged.json .rev*/round-2/codex.json',
    'cp /tmp/x .rev*/staging-smoke.json',
    'cp /tmp/x .review/round-[2-9]/codex.json',
    'cp /tmp/x .review/hardstops*.json',
    "node -e \"require('fs').writeFileSync('.review/state.json', '{}')\"",
    "node -e \"fs.writeFileSync(path.join(root, '.review', 'state.json'), s)\"",
    'cd "$X" && echo x > state.json', // (an unknown directory may be a review folder)
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [
    'cat .review/state.json',
    'jq .rounds .review/state.json',
    'ls -la .review .review/round-1',
    'mkdir -p .review', // (the ship skill, before it writes hardstops.json: an empty folder holds nothing)
    'node ~/.claude/pipeline/bin/pipeline.mjs hardstops --base origin/main --head HEAD > .review/hardstops.json',
    'cp /tmp/x .rev*/notes.md', // (a literal name that is no review file)
    'cat .review/round-*/codex.json', // (reading through a wildcard)
    'echo x > other/state.json',
    'echo x > notes/review/state.json',
    'npx prettier --write "src/**/*.ts"', // (a wildcard reaches a dot folder only with dotglob)
    'cp /tmp/x */state.json',
    'git commit -m "protect .review/state.json"',
    'node ~/.claude/pipeline/bin/pipeline.mjs state show --pr 5',
  ]) assert.equal(bash(cmd), 'allow', cmd);
});

test('Phase 3b: a program that resolves into a review folder is judged like any other (only the installed pipeline is trusted)', () => {
  // (run.mjs links to a file in a round folder: the hook judges the real file's text, it does not skip it as a pipeline program)
  const prog = '/repo/.review/round-1/x.mjs';
  const opts = {
    existsSync: (p) => p === prog || p === '/repo/run.mjs',
    realpath: (p) => (p === '/repo/run.mjs' ? prog : p),
    readText: (p) => (p === '/repo/run.mjs' || p === prog ? "import fs from 'node:fs'; fs.writeFileSync('/home/u/.claude/settings.json', '{}');" : null),
  };
  assert.equal(bash('node run.mjs', opts), 'deny');
});

// ---- #111: a review folder reached through a symlink (real filesystem) -----------------------------------------
// The link is made in a PRIOR step, the way an agent would: a link a judged program makes itself does not exist yet when the hook
// looks, so no stat can see it (a residual class, like every run-time-built path).

// (POSIX only: on win32 the inode check is off (statId is null there), as it is for the protected roots; these tests skip with that reason)
function reviewAliasWorld(t, { review = true } = {}) {
  if (process.platform === 'win32') { t.skip('the alias / inode check is POSIX-only (no inodes on win32)'); return null; }
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-review-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const cwd = path.join(tmp, 'repo');
  fs.mkdirSync(review ? path.join(cwd, '.review', 'round-1') : cwd, { recursive: true });
  const alias = path.join(tmp, 'alias');
  const ralias = path.join(tmp, 'ralias');
  try {
    fs.symlinkSync(path.join(cwd, '.review'), alias, 'dir');
    fs.symlinkSync(path.join(cwd, '.review', 'round-1'), ralias, 'dir');
    fs.symlinkSync('.review', path.join(cwd, 'rv'), 'dir'); // (a relative link inside the checkout)
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('cannot create symlinks here'); return null; }
    throw e;
  }
  const opts = { home, env: {}, cwd, platform: process.platform };
  return {
    tmp, cwd, alias, ralias,
    bash: (cmd) => evaluateBashForFiles(cmd, opts).decision,
    write: (p) => evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, cwd }, opts).decision,
  };
}

test('#111: a protected review file written through a symlink to .review or .review/round-N is denied', (t) => {
  const w = reviewAliasWorld(t);
  if (!w) return;
  const { alias: A, ralias: R } = w;
  assert.equal(w.write(`${A}/state.json`), 'deny');
  assert.equal(w.write(`${R}/codex.json`), 'deny');
  assert.equal(w.write(`${R}/sub/deeper.json`), 'deny');
  for (const cmd of [
    `echo x > ${A}/state.json`,
    `echo x > ${R}/codex.json`,
    `cd ${A} && echo x > state.json`,
    `cp /tmp/x ${A}/state.json`,
    `cp /tmp/x ${A}/final-gate.json`,
    `cp /tmp/x ${A}/production-smoke.json`,
    `cp /tmp/x ${R}/codex.json`,
    `tee ${A}/state.json < /tmp/x`,
    `node -e "require('fs').writeFileSync('${A}/state.json','x')"`,
    `node -e "require('fs').writeFileSync(require('path').join('${A}','state.json'),'x')"`,
    `node -e "const d='${A}'; require('fs').writeFileSync(d+'/state.json','x')"`,
    `node -e "const d='${R}'; require('fs').writeFileSync(d+'/codex.json','x')"`,
    `node -e "require('fs').writeFileSync('${R}/codex.json','x')"`,
    `node -e "process.chdir('${A}'); require('fs').writeFileSync('state.json','x')"`,
    `node -e "process.chdir('${R}'); require('fs').writeFileSync('codex.json','x')"`,
    'cp /tmp/x rv/state.json',
    'echo x > rv/state.json',
    `node -e "require('fs').writeFileSync('rv/state.json','x')"`,
    `node -e "process.chdir('rv'); require('fs').writeFileSync('state.json','x')"`,
  ]) assert.equal(w.bash(cmd), 'deny', cmd);
});

test('#111: the inode check works on injected inodes too (file tools and redirects, no real filesystem)', () => {
  const ids = { '/repo/.review': 'd:1', '/repo/.review/round-1': 'd:2', '/alias': 'd:1', '/ralias': 'd:2' };
  const fake = { statId: (p) => ids[p] ?? null, readDir: (d) => (d === '/repo/.review' ? ['round-1', 'notes', 'round-x'] : []) };
  assert.equal(file('Write', { file_path: '/alias/state.json', content: 'x' }, fake), 'deny');
  assert.equal(file('Write', { file_path: '/ralias/codex.json', content: 'x' }, fake), 'deny');
  assert.equal(file('Write', { file_path: '/ralias/a/b.json', content: 'x' }, fake), 'deny');
  assert.equal(file('Write', { file_path: '/alias/hardstops.json', content: 'x' }, fake), 'allow');
  assert.equal(file('Write', { file_path: '/other/state.json', content: 'x' }, fake), 'allow');
  assert.equal(bash('echo x > /alias/state.json', fake), 'deny');
  assert.equal(bash('echo x > /alias/hardstops.json', fake), 'allow');
  // (no review folder: no entry, no error)
  assert.equal(file('Write', { file_path: '/alias/state.json', content: 'x' }, { statId: () => null }), 'allow');
});

test('#111: scratch files directly in .review stay writable, by name and through a symlink', (t) => {
  const w = reviewAliasWorld(t);
  if (!w) return;
  const { alias: A, cwd } = w;
  assert.equal(w.write(`${cwd}/.review/hardstops.json`), 'allow');
  assert.equal(w.write(`${A}/hardstops.json`), 'allow');
  for (const cmd of [
    'node ~/.claude/pipeline/bin/pipeline.mjs hardstops --base origin/main --head HEAD > .review/hardstops.json',
    'mkdir -p .review',
    'echo x > .review/hardstops.json',
    `echo x > ${A}/hardstops.json`,
    `cp /tmp/x ${A}/hardstops.json`,
    `node -e "require('fs').writeFileSync('${A}/hardstops.json','x')"`,
    `cat ${A}/state.json`,
    `ls -la ${A} ${w.ralias}`,
  ]) assert.equal(w.bash(cmd), 'allow', cmd);
});

test('#111: a script padded past the scan cap still cannot write a review file through a link (fails closed with a review folder)', (t) => {
  const w = reviewAliasWorld(t);
  if (!w) return;
  const pad = '// padding padding padding padding padding padding padding\n'.repeat(4500); // ~250 KB
  assert.ok(pad.length > 200_000);
  fs.writeFileSync(path.join(w.cwd, 'big.mjs'), `${pad}import fs from 'node:fs'; fs.writeFileSync('${w.alias}/state.json', 'x');\n`);
  fs.writeFileSync(path.join(w.cwd, 'small.mjs'), `import fs from 'node:fs'; fs.writeFileSync('${w.alias}/state.json', 'x');\n`);
  assert.equal(w.bash('node small.mjs'), 'deny', 'under the cap');
  assert.equal(w.bash('node big.mjs'), 'deny', 'over the cap');
  // (a repo without a review folder: nothing to reach, an ordinary large script is judged as before)
  const n = reviewAliasWorld(t, { review: false });
  fs.writeFileSync(path.join(n.cwd, 'big.mjs'), `${pad}import fs from 'node:fs'; fs.writeFileSync('${n.tmp}/out.json', 'x');\n`);
  assert.equal(n.bash('node big.mjs'), 'allow');
});

test('#111: a cd into a link to the review folder (outside the checkout) makes the relative writers below it protected', (t) => {
  const w = reviewAliasWorld(t);
  if (!w) return;
  const { alias: A, ralias: R } = w;
  for (const dir of [A, R]) {
    const name = dir === A ? 'state.json' : 'codex.json';
    for (const body of [
      `cp /tmp/x ${name}`, `echo x | tee ${name}`, `mv /tmp/x ${name}`, `sed -i 's/a/b/' ${name}`, `rm ${name}`, `ln -sf /tmp/x ${name}`,
      `node -e "require('fs').writeFileSync('${name}','x')"`,
    ]) {
      assert.equal(w.bash(`cd ${dir} && ${body}`), 'deny', `cd && ${body}`);
      assert.equal(w.bash(`(cd ${dir} && ${body})`), 'deny', `subshell ${body}`);
      assert.equal(w.bash(`pushd ${dir} >/dev/null && ${body}`), 'deny', `pushd ${body}`);
    }
  }
  // (reading, and a scratch file directly in .review, stay fine)
  for (const cmd of [`cd ${A} && cat state.json`, `cd ${A} && cp /tmp/x hardstops.json`, `(cd ${A} && ls)`, 'cd /tmp && cp x state.json', `cd ${w.tmp} && cp /tmp/x notes.json`]) assert.equal(w.bash(cmd), 'allow', cmd);
  // (an unknown cd target in a checkout that has review folders: ordinary words below it are no hits)
  for (const cmd of ['cd "$X" && npm test', 'cd "$X" && git commit -m foo']) assert.equal(w.bash(cmd), 'allow', cmd);
});

test('#111: repeated ancestors of the words of a long line are stat-ed once (per-evaluation cache)', () => {
  const ids = { '/repo/.review': 'd:1', '/repo/.review/round-1': 'd:2' };
  let calls = 0;
  const statId = (p) => { calls++; return ids[p] ?? null; };
  const readDir = (d) => (d === '/repo/.review' ? ['round-1'] : []);
  const words = Array.from({ length: 2000 }, (_, i) => `src/deep/er/path/f${i}.js`).join(' ');
  assert.equal(bash(`echo ${words}`, { statId, readDir }), 'allow');
  assert.ok(calls < 2000 * 2, `${calls} stat calls for 2000 words`); // (uncached: one per ancestor per word, ~6 per word)
});

test('#111: after a cd to a folder outside the checkout, a relative path through a link to the review folder is followed', (t) => {
  const w = reviewAliasWorld(t);
  if (!w) return;
  const T = w.tmp;
  for (const cmd of [
    `cd ${T} && cp /tmp/x alias/state.json`,
    `cd ${T} && cp /tmp/x ralias/codex.json`,
    `cd ${T}/alias/.. && cp /tmp/x alias/state.json`,
    `cd ${T} && node -e "process.chdir('alias'); require('fs').writeFileSync('state.json','x')"`,
    `cd ${T} && node -e "require('fs').writeFileSync('alias/state.json','x')"`,
    `(cd ${T} && cp /tmp/x alias/state.json)`,
    `pushd ${T} >/dev/null && cp /tmp/x alias/state.json`,
  ]) assert.equal(w.bash(cmd), 'deny', cmd);
  for (const cmd of [
    `cd ${T} && cp /tmp/x alias/hardstops.json`, // (a scratch file directly in .review)
    `cd ${T} && cp /tmp/x other/state.json`, // (no link)
    `cd ${T} && cat alias/state.json`,
    `cd ${T} && ls alias ralias`,
  ]) assert.equal(w.bash(cmd), 'allow', cmd);
});
