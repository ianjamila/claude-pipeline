// Why: an adversarial review found bypasses of guard-files. One test per repro, grouped by the review items:
// 1 ancestor dirs, 2 redirects, 3 code-built home paths, 4 variables, 5 MCP, 6 fail-open on caps, 7 false
// positives, 8 performance. Home is /home/u (user "u"); the filesystem is faked unless a test says otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
import { evaluateFileTool, evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const WIN = { home: 'C:\\Users\\u', env: {}, platform: 'win32', realpath: (p) => p, existsSync: () => false };
const PROJ = '/home/u/proj';

const bash = (command, cwd = PROJ, opts = {}) => evaluateBashForFiles(command, { ...BASE, ...opts, cwd });
const mcp = (tool_name, tool_input, cwd = PROJ, opts = {}) => evaluateFileTool({ tool_name, tool_input, cwd }, { ...BASE, ...opts });

// [command, cwd?] -> table runner
function table(title, rows, expected) {
  for (const row of rows) {
    const [cmd, cwd] = Array.isArray(row) ? row : [row];
    test(`${title} ${expected.toUpperCase()}: ${cmd.length > 100 ? `${cmd.slice(0, 100)}...` : cmd}${cwd ? ` (cwd ${cwd})` : ''}`, () => {
      const r = bash(cmd, cwd);
      assert.equal(r.decision, expected, `${JSON.stringify(cmd)} -> ${r.reason}`);
    });
  }
}

// ---- 1. ancestor directories: ~/.claude, ~/.claude/skills, ~/.claude/agents ---------------------------

table('ancestors', [
  'cp -r skills ~/.claude/',
  'cp -R agents ~/.claude/',
  'cp -r pipeline ~/.claude/',
  'cp -r /tmp/pkg/skills/* ~/.claude/skills/',
  'cp -r /tmp/pkg/agents/. ~/.claude/agents/',
  'cp /tmp/new/settings.json ~/.claude',
  'cp -t ~/.claude/agents /tmp/new/judge.md',
  'cp -a /tmp/backup/.claude ~/',
  'cp -r /tmp/backup/.claude ~',
  'rsync -a /tmp/backup/.claude ~/',
  'mv /tmp/backup/.claude ~/',
  'cp /tmp/new/judge.md ~/.claude/agents',
  'cp -r /tmp/new/ship ~/.claude/skills',
  'cp --target-directory=~/.claude/skills -r /tmp/x',
  'rsync -a x/ ~/.claude/',
  'rsync -a --delete /tmp/new/ ~/.claude/skills/',
  'install -d ~/.claude/skills',
  'ditto /tmp/new ~/.claude',
  'rm -rf ~/.claude',
  'rm -rf ~/.claude/',
  'rm -rf ~/.claude/skills',
  'rm -rf ~/.claude/agents',
  'mv ~/.claude ~/.claude.bak',
  'mv /tmp/new/settings.json ~/.claude/',
  'ln -sfn /tmp/evil ~/.claude/skills',
  'tar -xzf pkg.tgz -C ~/.claude',
  'tar xf pkg.tgz -C ~/.claude/skills',
  'unzip -o pkg.zip -d ~/.claude',
  'unzip -o pkg.zip -d ~/.claude/skills/',
  'git -C ~/.claude checkout -- settings.json',
  'git -C ~/.claude checkout .',
  'git -C ~/.claude restore settings.json',
  'git -C ~/.claude clean -fdx',
  'git -C ~/.claude status && git -C ~/.claude stash',
  'git -C ~/.claude/skills reset --hard',
  'cd ~/.claude && git pull',
  'cd ~/.claude && git checkout -- .',
  'cd ~/.claude && git restore settings.json',
  'cd ~/.claude/skills && git clean -fdx',
  'cd ~/.claude && cp -r /tmp/x/skills .',
  'cd ~/.claude && rm -rf skills',
  'cd ~/.claude && rm -rf agents',
  'cd ~/.claude/skills; mv /tmp/evil ship',
  'cd ~/.claude && cp /tmp/x settings.json',
  'find ~/.claude -name settings.json -exec rm {} \\;',
  'find ~/.claude/skills -type f -delete',
  'mkdir -p ~/.claude/agents',
  'xargs -I{} cp {} ~/.claude/agents/ < list.txt',
  'Copy-Item -Recurse skills $HOME\\.claude\\',
  'Remove-Item -Recurse $HOME\\.claude\\skills',
  'Remove-Item -Recurse -Force $env:USERPROFILE\\.claude',
  ['rm -rf .claude', '/home/u'],
  ['rm -rf skills', '/home/u/.claude'],
  ['rm -rf ship', '/home/u/.claude/skills'],
  ['cp -r /tmp/new/ship .', '/home/u/.claude/skills'],
  ['git pull', '/home/u/.claude'],
  ['make', '/home/u/.claude/agents'],
], 'deny');

table('ancestors', [
  'ls ~/.claude',
  'ls -la ~/.claude/skills ~/.claude/agents',
  'cd ~/.claude && ls',
  'cd ~/.claude && cat settings.json',
  'cd ~/.claude/skills && ls ship',
  'cd ~/.claude && ls skills',
  'rm ~/.claude/history.jsonl',
  'rm -rf ~/.claude/projects/old',
  'rm -rf ~/.claude/projects/-x/memory',
  'cp /tmp/x ~/.claude/CLAUDE.md',
  'cp /tmp/x ~/.claude/agents/other.md',
  'cp -r /tmp/x ~/.claude/skills/new-skill',
  'cp -t ~/.claude/commands /tmp/x.md',
  'echo x > ~/.claude/commands/foo.md',
  'mkdir -p ~/.claude/skills/new-skill',
  'mkdir -p ~/.claude/skills/new-skill && echo x > ~/.claude/skills/new-skill/SKILL.md',
  'mv /tmp/x ~/.claude/projects/y',
  'tar -xzf pkg.tgz -C ~/.claude/projects/foo',
  'tar -tzf pkg.tgz',
  'unzip -o pkg.zip -d /tmp/unz',
  'cp -a /tmp/backup/.config ~/',
  'git -C ~/.claude status',
  'git -C ~/.claude log --oneline -3',
  'git -C ~/.claude diff',
  'find ~/.claude -name "settings*.json"',
  'find ~/.claude/skills -maxdepth 1 -type d',
  'Get-ChildItem $HOME\\.claude',
  ['ls', '/home/u/.claude'],
  ['cat settings.json', '/home/u/.claude'],
], 'allow');

test('ancestors: MCP write tools aimed at an ancestor dir are denied, read tools are not', () => {
  assert.equal(mcp('mcp__filesystem__move_file', { source: '~/.claude', destination: '/tmp/x' }).decision, 'deny');
  assert.equal(mcp('mcp__filesystem__move_file', { source: '/tmp/x', destination: '/home/u/.claude/skills' }).decision, 'deny');
  assert.equal(mcp('mcp__files__delete_directory', { path: '~/.claude/agents' }).decision, 'deny');
  assert.equal(mcp('mcp__filesystem__create_directory', { path: '~/.claude/skills' }).decision, 'deny');
  assert.equal(mcp('mcp__filesystem__list_directory', { path: '~/.claude' }).decision, 'allow');
  assert.equal(mcp('mcp__filesystem__directory_tree', { path: '~/.claude/skills' }).decision, 'allow');
  assert.equal(mcp('mcp__filesystem__write_file', { path: '~/.claude/CLAUDE.md', content: 'x' }).decision, 'allow');
  assert.equal(mcp('mcp__filesystem__create_directory', { path: '~/.claude/skills/new' }).decision, 'allow');
});

// ---- 2. redirects ----------------------------------------------------------------------------------

const HOME_CWD = '/home/u';
table('redirect', [
  ['echo x > .claude/settings.json', HOME_CWD],
  ['cat /tmp/x > .claude/settings.json', HOME_CWD],
  ['cat > .claude/agents/judge.md <<EOF\nx\nEOF', HOME_CWD],
  ['cat > .claude/agents/judge.md <<\'EOF\'\nx\nEOF', HOME_CWD],
  ['echo x >> .claude/pipeline/hooks/guard-files.mjs', HOME_CWD],
  ['printf x > .claude/skills/ship/SKILL.md', HOME_CWD],
  ['echo x > ./.claude/settings.json', HOME_CWD],
  ['echo x > .claude/../.claude/settings.json', HOME_CWD],
  ['echo x > ../u/.claude/settings.json', HOME_CWD],
  ['echo x > settings.json', '/home/u/.claude'],
  ['echo x > pipeline/bin/pipeline.mjs', '/home/u/.claude'],
  ['echo x > ship/SKILL.md', '/home/u/.claude/skills'],
  ['echo x > judge.md', '/home/u/.claude/agents'],
  ['echo x > ../.claude/settings.json', PROJ],
  ['cd ~/proj && echo x > ../.claude/settings.json'],
  ['cd ~/proj/src && echo x > ../../.claude/settings.json'],
  ['cd ~; cd .claude; echo x > settings.json'],
  ['cd ~/.claude && echo x > pipeline/x'],
  ['cd ~/.claude/agents && echo x > judge.md'],
  ['(cd ~/.claude && echo x > settings.json)'],
  ['pushd ~/.claude >/dev/null; echo x > settings.json; popd'],
  ['> ~/.claude/settings.json'],
  ['exec 3>~/.claude/settings.json'],
  ['echo x &> ~/.claude/settings.json'],
  ['echo x >| ~/.claude/settings.json'],
  ['echo x 1> ~/.claude/settings.json'],
  ['echo x 2> ~/.claude/settings.json'],
  ['cat /tmp/new.json > ~/.claude/settings.json'],
  ['cat <<EOF > ~/.claude/settings.json\n{}\nEOF'],
  ['cat /tmp/x > "$HOME/.claude/settings.json"'],
  ['echo x | tee .claude/settings.json', HOME_CWD],
  ['ls ~/.claude && echo x > ~/.claude/pipeline/VERSION'],
  ['jq .a ~/.claude/settings.json > ~/.claude/settings.json'],
  ['D=$HOME/.claude; cat /tmp/x > $D/settings.json'],
  ['cat /tmp/x > $X/.claude/settings.json'],
  ['echo x > /home/u/proj/../.claude/pipeline/x'],
], 'deny');

table('redirect', [
  ['echo x > .claude/settings.json', PROJ],
  ['echo x > .claude/settings.local.json', HOME_CWD],
  ['echo x > .claude/agents/new.md', HOME_CWD],
  ['echo x > .claude/skills/other/x.md', HOME_CWD],
  ['echo x > ~/.claude/skills/ship-it/SKILL.md'],
  ['echo x > ~/.claude/pipelines/x'],
  ['echo x > ~/.claude/settings.json.bak'],
  ['echo x > ~/proj/.claude/settings.json'],
  ['echo x > /dev/null'],
  ['cat ~/.claude/settings.json > /tmp/x'],
  ['cat ~/.claude/settings.json 2>/dev/null'],
  ['cat ~/.claude/settings.json 2>&1 | head'],
  ['grep foo ~/.claude/pipeline/VERSION > /tmp/hits.txt'],
  ['cd ~/proj && echo x > ../notes.txt'],
  ['echo "a > b" && ls ~/.claude'],
], 'allow');

test('redirect: a symlink that already points into a protected root is followed for the target', (t) => {
  const realpath = (p) => (p === '/tmp/link' ? '/home/u/.claude/settings.json' : p);
  const existsSync = (p) => p === '/tmp/link';
  assert.equal(bash('echo x > /tmp/link', PROJ, { realpath, existsSync }).decision, 'deny');
  assert.equal(bash('echo x > /tmp/other', PROJ, { realpath, existsSync }).decision, 'allow');
});

// ---- 3. code-built home paths -----------------------------------------------------------------------

table('code-built path', [
  `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')"`,
  `node -e "require('fs').writeFileSync(require('path').join(require('os').homedir(),'.claude','settings.json'),'{}')"`,
  `node -e "require('fs').writeFileSync(require('path').join(require('os').homedir(), '.claude', 'skills', 'ship', 'SKILL.md'),'x')"`,
  'node -e "require(\'fs\').writeFileSync(`${require(\'os\').homedir()}/.claude/settings.json`,\'{}\')"',
  'node -e "require(\'fs\').writeFileSync(`${process.env.HOME}/.claude/settings.json`,\'{}\')"',
  `node -e "const os=require('os'); require('fs').writeFileSync(os.homedir()+'/.claude/settings.json','{}')"`,
  `node -e "const h=require('os').homedir(); require('fs').writeFileSync(h+'/.claude/settings.json','{}')"`,
  `node -e "require('fs').unlinkSync(require('os').homedir()+'/.claude/pipeline/bin/pipeline.mjs')"`,
  `node --eval "require('fs').rmSync(require('os').homedir()+'/.claude/pipeline',{recursive:true})"`,
  `node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/agents/judge.md','x')"`,
  `python3 -c "from pathlib import Path; (Path.home()/'.claude'/'settings.json').write_text('{}')"`,
  `python3 -c "from pathlib import Path; Path.home().joinpath('.claude','settings.json').write_text('{}')"`,
  `python3 -c "from pathlib import Path; (Path.home() / '.claude' / 'agents' / 'judge.md').write_text('x')"`,
  `python3 -c "import pathlib; pathlib.Path.home().joinpath('.claude','skills','ship','SKILL.md').write_text('x')"`,
  `python3 -c "import os; open(os.path.expanduser('~/.claude/settings.json'),'w').write('{}')"`,
  `python3 -c "import os; open(os.path.join(os.path.expanduser('~'),'.claude','settings.json'),'w').write('{}')"`,
  `python3 -c "import os; open(f'{os.path.expanduser(chr(126))}/.claude/settings.json','w')"`,
  `python3 -c "import os; open(os.environ['HOME']+'/.claude/settings.json','w')"`,
  `python3 -c "import os; open(f'{os.environ[\\"HOME\\"]}/.claude/settings.json','w')"`,
  `python3 -c "from pathlib import Path; open(f'{Path.home()}/.claude/settings.json','w')"`,
  `python3 - <<'PY'\nimport os\nopen(os.path.expanduser("~/.claude/settings.json"),"w").write("{}")\nPY`,
  `python3 - <<'PY'\nfrom pathlib import Path\n(Path.home()/'.claude'/'pipeline'/'x').write_text('x')\nPY`,
  `ruby -e "File.write(File.join(Dir.home, '.claude', 'settings.json'), '{}')"`,
  'cp /tmp/x $X/.claude/settings.json',
  'cp /tmp/x ${X}/.claude/agents/judge.md',
  'cp /tmp/x "$(git rev-parse --show-toplevel)/.claude/settings.json"',
  'cp /tmp/x ~root/.claude/settings.json',
  'echo x > $PWD/.claude/pipeline/x',
], 'deny');

table('code-built path', [
  `node -e "console.log(require('os').homedir())"`,
  'node -e "console.log(process.env.HOME)"',
  `node -e "console.log(require('path').join(require('os').homedir(),'.claude','projects'))"`,
  `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/CLAUDE.md','x')"`,
  `python3 -c "from pathlib import Path; (Path.home()/'.claude'/'CLAUDE.md').write_text('x')"`,
  'echo $HOME',
  'cp x .claude/settings.json',
  'cat ~/proj/.claude/settings.json',
  'echo x > /repo/.claude/settings.json',
  'cat "$X/.claude/settings.json"',
  `python3 -c "print(open('.claude/settings.json').read())"`,
], 'allow');

// ---- 4. variables ---------------------------------------------------------------------------------

table('variable', [
  'D=$HOME/.claude; echo x > $D/settings.json',
  'CLAUDE_DIR="$HOME/.claude"; cp /tmp/x "$CLAUDE_DIR/settings.json"',
  'd=~/.claude && rm -rf $d/pipeline',
  'export D=~/.claude; rm -rf $D/skills/ship',
  'D=${HOME}/.claude; rm -rf ${D}/agents/judge.md',
  'A=$HOME; B=$A/.claude; echo x > $B/settings.json',
  'P=~/.claude/pipeline; rm -rf $P',
  'declare -x D=$HOME/.claude; cp /tmp/x $D/settings.json',
  'cp /tmp/x /home/$USER/.claude/settings.json',
  'cp /tmp/x /home/${USER}/.claude/settings.json',
  'cp /tmp/x /home/$LOGNAME/.claude/agents/judge.md',
  'cp /tmp/x /home/$(whoami)/.claude/settings.json',
  'cp /tmp/x /home/`whoami`/.claude/settings.json',
  'cp /tmp/x $(echo ~)/.claude/settings.json',
  'cp /tmp/x "$(eval echo ~)/.claude/settings.json"',
  'cd $HOME/.claude && rm -rf skills',
  'D=~/.claude; cd $D && git pull',
], 'deny');

table('admin/hook switch built from pieces', [
  `node -e "process.env.PIPELINE_'+'ADMIN=1"`,
  `python3 -c "d['disable'+'AllHooks']=True"`,
  'X=PIPELINE_ADMIN; export $X=1',
  'N=PIPELINE_ADMIN; env $N=1 claude',
], 'deny');

table('variable', [
  'D=/tmp/x; echo x > $D/a.txt',
  'D=$HOME/.claude; ls $D',
  'D=$HOME/.claude/projects; echo x > $D/a',
  'D=$HOME/.claude; cat $D/settings.json',
  'D=$HOME/proj; echo x > $D/.claude/settings.json',
  'echo $USER',
  'cp /tmp/x /home/$USER/notes.txt',
], 'allow');

// ---- 5. MCP ---------------------------------------------------------------------------------------

const MCP_DENY = [
  ['mcp__plugin_playwright_playwright__browser_run_code_unsafe', { code: `async (page) => { require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}') }` }],
  ['mcp__plugin_playwright_playwright__browser_run_code_unsafe', { code: 'require("fs").writeFileSync("/home/u/.claude/settings.json","{}")' }],
  ['mcp__plugin_playwright_playwright__browser_evaluate', { function: `() => require('fs').writeFileSync(process.env.HOME + '/.claude/settings.json', '{}')` }],
  ['mcp__plugin_playwright_playwright__browser_take_screenshot', { filename: '~/.claude/settings.json' }],
  ['mcp__plugin_playwright_playwright__browser_snapshot', { filename: '/home/u/.claude/pipeline/x.md' }],
  ['mcp__plugin_playwright_playwright__browser_network_requests', { filename: '/home/u/.claude/pipeline/x.json' }],
  ['mcp__notebooklm-mcp__download_artifact', { output_path: '/home/u/.claude/pipeline/x', artifact_type: 'audio' }],
  ['mcp__ide__executeCode', { code: 'open("/home/u/.claude/settings.json","w").write("{}")' }],
  ['mcp__ide__executeCode', { code: `from pathlib import Path\n(Path.home()/'.claude'/'settings.json').write_text('{}')` }],
  ['mcp__desktop__start_process', { command: 'cp x ~/.claude/settings.json' }],
  ['mcp__desktop__start_process', { command: 'sed -i "" s/a/b/ /home/u/.claude/settings.json' }],
  ['mcp__x__run_command', { cmd: 'echo x > /home/u/.claude/settings.json' }],
  ['mcp__x__execute', { script: 'rm -rf ~/.claude/pipeline' }],
  ['mcp__x__run', { shell: 'rm -rf ~/.claude' }],
  ['mcp__x__run_python', { source_code: `import os; open(os.path.expanduser('~/.claude/settings.json'),'w')` }],
  ['mcp__x__write_file', { filepath: '/home/u/.claude/settings.json', content: 'x' }],
  ['mcp__x__write_file', { file: '/home/u/.claude/settings.json', content: 'x' }],
  ['mcp__x__write_file', { filename: '/home/u/.claude/settings.json', content: 'x' }],
  ['mcp__x__write_file', { file_name: '/home/u/.claude/settings.json', content: 'x' }],
  ['mcp__x__write_file', { uri: 'file:///home/u/.claude/settings.json', content: 'x' }],
  ['mcp__x__write_file', { relative_path: '../.claude/settings.json', content: 'x' }],
  ['mcp__x__rename', { old_path: '/home/u/.claude/settings.json', new_path: '/tmp/x' }],
  ['mcp__x__rename', { oldPath: '/tmp/x', newPath: '/home/u/.claude/settings.json' }],
  ['mcp__x__copy_file', { src: '/tmp/x', dst: '/home/u/.claude/settings.json' }],
  ['mcp__x__copy_file', { sourcePath: '/tmp/x', targetPath: '/home/u/.claude/settings.json' }],
  ['mcp__x__make_file', { path: '/home/u/.claude/pipeline/x', content: 'x' }],
  ['mcp__x__download_file', { destination: '/home/u/.claude/pipeline/x', url: 'http://x' }],
  ['mcp__x__download_file', { output_path: '/home/u/.claude/pipeline/x', url: 'http://x' }],
  ['mcp__x__download_file', { outputPath: '/home/u/.claude/pipeline/x', url: 'http://x' }],
  ['mcp__x__export_data', { path: '/home/u/.claude/pipeline/x' }],
  ['mcp__x__fetch_to', { whatever: '~/.claude/pipeline/x' }],
  ['mcp__x__browser_navigate', { url: 'x', saveTo: '/home/u/.claude/settings.json' }],
  ['mcp__x__do_it', { nested: { deeper: [{ target_file: '/home/u/.claude/agents/judge.md' }] } }],
];
for (const [tool, input] of MCP_DENY) {
  test(`mcp DENY: ${tool.split('__').pop()} ${JSON.stringify(input).slice(0, 90)}`, () => {
    const r = mcp(tool, input);
    assert.equal(r.decision, 'deny', JSON.stringify(input));
  });
}

const MCP_ALLOW = [
  ['mcp__plugin_playwright_playwright__browser_evaluate', { function: '() => 1' }],
  ['mcp__plugin_playwright_playwright__browser_run_code_unsafe', { code: 'async (page) => { await page.goto("http://localhost:4000") }' }],
  ['mcp__plugin_playwright_playwright__browser_take_screenshot', { filename: 'shot.png' }],
  ['mcp__plugin_playwright_playwright__browser_take_screenshot', { filename: '/tmp/shot.png' }],
  ['mcp__ide__executeCode', { code: 'print(1)' }],
  ['mcp__desktop__start_process', { command: 'ls ~/.claude' }],
  ['mcp__desktop__start_process', { command: 'cat ~/.claude/settings.json' }],
  ['mcp__desktop__start_process', { command: 'npm test' }],
  ['mcp__sentry__search_issues', { query: 'x' }],
  ['mcp__plugin_supabase_supabase__execute_sql', { query: 'select 1' }],
  ['mcp__claude_ai_Claude_Docs__update', { path: 'x', content: 'y' }],
  ['mcp__claude_ai_Google_Drive__create_file', { title: 'x', content: 'install to ~/.claude/pipeline' }],
  ['mcp__notes__create_note', { title: 't', text: 'the files live in ~/.claude/pipeline/hooks' }],
  ['mcp__filesystem__write_file', { path: '/repo/a.ts', content: 'x' }],
  ['mcp__filesystem__read_text_file', { path: '~/.claude/settings.json' }],
  ['mcp__filesystem__read_multiple_files', { paths: ['~/.claude/settings.json', '~/.claude/agents/judge.md'] }],
  ['mcp__filesystem__list_directory', { path: '~/.claude/pipeline' }],
  ['mcp__filesystem__directory_tree', { path: '~/.claude/pipeline' }],
  ['mcp__filesystem__search_files', { path: '~/.claude', pattern: 'x' }],
  ['mcp__filesystem__get_file_info', { path: '~/.claude/settings.json' }],
  ['mcp__x__find_files', { dir: '~/.claude/skills/ship', glob: '*.md' }],
  ['mcp__x__describe', { target: '~/.claude/settings.json' }],
  ['mcp__x__browser_navigate', { url: 'https://example.com/.claude/settings.json' }],
];
for (const [tool, input] of MCP_ALLOW) {
  test(`mcp ALLOW: ${tool.split('__').pop()} ${JSON.stringify(input).slice(0, 90)}`, () => {
    const r = mcp(tool, input);
    assert.equal(r.decision, 'allow', `${JSON.stringify(input)} -> ${r.reason}`);
  });
}

test('mcp: admin mode allows code and path tools too', () => {
  const opts = { env: { PIPELINE_ADMIN: '1' } };
  assert.equal(mcp('mcp__ide__executeCode', { code: 'open("/home/u/.claude/settings.json","w")' }, PROJ, opts).decision, 'allow');
  assert.equal(mcp('mcp__x__browser_take_screenshot', { filename: '~/.claude/settings.json' }, PROJ, opts).decision, 'allow');
});

// ---- 6. fail-open on caps ----------------------------------------------------------------------------

const DEEP = `${'$('.repeat(250)}x${')'.repeat(250)}`;

test('caps: a truncated parse with a protected reference is denied before any early return', () => {
  assert.equal(simpleCommands(`echo ${DEEP}`).truncated, true, 'fixture must truncate');
  assert.equal(bash(`cat ~/.claude/pipeline/VERSION ${DEEP}`).decision, 'deny');
  assert.equal(bash(`cat ${DEEP}; echo x > ~/.claude/settings.json`).decision, 'deny', 'reference after the cut-off');
  assert.equal(bash(`echo ${DEEP} && node -e "fs.writeFileSync(os.homedir()+'/.claude/settings.json','x')"`).decision, 'deny', 'suffix scan after the cut-off');
  assert.equal(bash(`python3 - <<'PY'\nimport os\nopen(os.path.expanduser('~/.claude/settings.json'),'w')\nPY\n${DEEP}`).decision, 'deny', 'reference only inside a heredoc');
  assert.equal(bash(`echo ${DEEP}`).decision, 'deny', 'a truncated parse cannot prove anything harmless');
  assert.equal(bash(`${'true; '.repeat(600)}e''cho x > ~/.cl""aude/settings.json`).decision, 'deny', 'quote-split names after the command cap');
});

test('caps: a command only known at run time is denied when a protected reference exists (parser dynamic flag)', () => {
  assert.equal(simpleCommands('$CMD push').dynamic, true, 'fixture must be dynamic');
  assert.equal(bash('cat ~/.claude/settings.json; $CMD').decision, 'deny');
  assert.equal(bash('$CMD push origin x').decision, 'allow', 'no reference: dynamic alone is not a reason to deny');
  assert.equal(bash('bash -c "$X" ~/.claude/pipeline').decision, 'deny');
});

test('redirect: every write operator the parser reports is checked, dups and reads are not', () => {
  for (const op of ['>', '>>', '>|', '&>', '&>>', '>&']) {
    assert.equal(bash(`echo x ${op} ~/.claude/settings.json`).decision, 'deny', op);
  }
  assert.equal(bash('echo x 2>&1 >/dev/null').decision, 'allow');
  assert.equal(bash('cat < ~/.claude/settings.json').decision, 'allow', 'an input redirect only reads');
  assert.equal(bash('cat <<< "x" > /tmp/out').decision, 'allow');
  assert.equal(bash('wc -l < ~/.claude/settings.json > /tmp/n').decision, 'allow');
});

test('caps: more than 5000 argv words skips per-token scans but still denies on a raw reference', () => {
  const many = 'a '.repeat(6000);
  assert.equal(bash(`cat ${many} ~/.claude/pipeline/VERSION`).decision, 'deny');
  assert.equal(bash(`rm ${many} && rm -rf ~/.claude/pipeline`).decision, 'deny');
  assert.equal(bash(`echo x > $X/.claude/settings.json; ls ${many}`).decision, 'deny');
  assert.equal(bash(`cat ${many}`).decision, 'allow');
});

test('caps: brace expansion input above 5000 chars is marked dynamic: deny when a protected reference exists', () => {
  const braces = 'a{b,c}d '.repeat(800); // > 5000 chars
  assert.ok(braces.length > 5000);
  assert.equal(bash(`echo ${braces} ~/.claude/pipeline`).decision, 'deny');
  assert.equal(bash(`cat ${braces} ~/.claude/pipeline/VERSION`).decision, 'deny');
  assert.equal(bash(`echo ${braces}`).decision, 'allow');
  assert.equal(bash('rm -rf ~/.claude/{pipeline,settings.json}').decision, 'deny', 'short brace expansion still works');
});

// ---- 7. false positives removed ----------------------------------------------------------------------

table('read-only', [
  'sed -n 1,10p ~/.claude/settings.json',
  "sed -n '/foo/p' ~/.claude/pipeline/VERSION",
  "sed -n 's/a/b/p' ~/.claude/settings.json",
  'sed -E -n -e s/web/x/p ~/.claude/settings.json',
  `awk '{print $1}' ~/.claude/settings.json`,
  `gawk -F: '{print $2}' ~/.claude/settings.json`,
  'sort ~/.claude/settings.json',
  'sort -u -k2 ~/.claude/settings.json',
  'cut -c1-80 ~/.claude/settings.json',
  'du -sh ~/.claude/pipeline',
  'tree ~/.claude/skills/ship',
  'tree -L 2 ~/.claude/pipeline',
  'xxd ~/.claude/settings.json | head',
  'xxd -l 16 ~/.claude/settings.json',
  'hexdump -C ~/.claude/settings.json',
  'bat ~/.claude/settings.json',
  "jq '.hooks' ~/.claude/settings.json",
  'openssl dgst -sha256 ~/.claude/pipeline/bin/pipeline.mjs',
  'python3 -m json.tool ~/.claude/settings.json',
  'python -m json.tool < ~/.claude/settings.json',
  'md5sum ~/.claude/settings.json',
  'cp ~/.claude/settings.json /tmp/bak',
  'cp -r ~/.claude/pipeline /tmp/pipeline-copy',
  'cp -t /tmp/bak ~/.claude/settings.json',
  'rsync -a ~/.claude/pipeline/ /tmp/pipeline-copy/',
  'install -m 644 ~/.claude/pipeline/VERSION /tmp/v',
  'cat ~/.claude/settings.json > /tmp/x',
  '[ "$PIPELINE_ADMIN" = "1" ] && echo admin',
  'test "$PIPELINE_ADMIN" = 1',
  '[[ $PIPELINE_ADMIN == 1 ]] && echo admin',
  '[ $PIPELINE_ADMIN = 1 ] && echo admin',
  '[ "${PIPELINE_ADMIN}" == "1" ]',
  'if [ "$PIPELINE_ADMIN" != "1" ]; then echo no; fi',
], 'allow');

table('still non-read-only', [
  'sed -i s/a/b/ ~/.claude/settings.json',
  'sed -i.bak s/a/b/ ~/.claude/settings.json',
  'sed --in-place s/a/b/ ~/.claude/settings.json',
  "sed -n 's/a/b/w /tmp/out' ~/.claude/settings.json",
  "sed 's/a/b/e' ~/.claude/settings.json",
  "sed -e '1w /tmp/out' ~/.claude/settings.json",
  'sed -f script.sed ~/.claude/settings.json',
  `awk '{print > "/tmp/x"}' ~/.claude/settings.json`,
  `awk '$1 > 5 {print}' ~/.claude/settings.json`,
  `awk 'BEGIN{system("rm x")}' ~/.claude/settings.json`,
  'awk -i inplace "{print}" ~/.claude/settings.json',
  'awk -f prog.awk ~/.claude/settings.json',
  'sort -o ~/.claude/settings.json ~/.claude/settings.json',
  'sort --output=/tmp/x ~/.claude/settings.json',
  'sort -uo /tmp/x ~/.claude/settings.json',
  'tree -o /tmp/x ~/.claude/skills/ship',
  'xxd -r ~/.claude/settings.json /tmp/x',
  'xxd ~/.claude/settings.json /tmp/out',
  'openssl dgst -sha256 -out /tmp/x ~/.claude/settings.json',
  'python3 -m json.tool ~/.claude/settings.json /tmp/out.json',
  'python3 -m http.server --directory ~/.claude',
  'cp /tmp/x ~/.claude/settings.json',
  'cp ~/.claude/settings.json ~/.claude/pipeline/x',
  'cp -t ~/.claude/pipeline ~/.claude/settings.json',
  'rsync -a /tmp/x ~/.claude/pipeline/',
  'install -m 644 /tmp/x ~/.claude/agents/judge.md',
  'ln -s ~/.claude/settings.json /tmp/link',
  'mv ~/.claude/settings.json /tmp/x',
  'rm ~/.claude/settings.json',
], 'deny');

// ---- 8. performance ----------------------------------------------------------------------------------

test('perf: ordinary commands, long commands and brace-heavy commands stay fast', () => {
  const timeIt = (cmd) => { const t = process.hrtime.bigint(); const r = bash(cmd); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
  const cases = [
    'npm test && git status',
    'echo a; '.repeat(20000),
    `cat ${'file.txt '.repeat(22000)} ~/.claude/pipeline/VERSION`,
    `echo ${'a{b,c}d '.repeat(5000)} ~/.claude/pipeline`,
    `echo ${'x'.repeat(300000)} ~/.claude/pipeline`,
    `node -e "${"'a'+'b',".repeat(20000)}"`,
    `cat ~/.claude/pipeline/a ${'>'.repeat(100000)}`,
  ];
  for (const c of cases) {
    const { ms } = timeIt(c);
    assert.ok(ms < 1500, `${c.slice(0, 40)}... took ${ms.toFixed(0)} ms`);
  }
  const ordinary = [];
  for (let i = 0; i < 30; i++) ordinary.push(timeIt('git -C ~/.claude/pipeline log --oneline | head -3 && ls ~/.claude/skills').ms);
  ordinary.sort((a, b) => a - b);
  assert.ok(ordinary[15] < 20, `median in-process time ${ordinary[15].toFixed(1)} ms`);
});

// ---- Windows -------------------------------------------------------------------------------------

test('win32: ancestor dirs and relative redirects after cd', () => {
  const w = (cmd, cwd = 'C:\\repo') => evaluateBashForFiles(cmd, { ...WIN, cwd }).decision;
  assert.equal(w('Copy-Item -Recurse skills $env:USERPROFILE\\.claude\\'), 'deny');
  assert.equal(w('Remove-Item -Recurse -Force "$HOME\\.claude"'), 'deny');
  assert.equal(w('echo x > .claude/settings.json', 'C:\\Users\\u'), 'deny');
  assert.equal(w('cd $HOME/.claude && echo x > agents/judge.md'), 'deny');
  assert.equal(w('Get-ChildItem $env:USERPROFILE\\.claude'), 'allow');
  assert.equal(w('echo x > .claude/settings.json', 'C:\\repo'), 'allow');
});

// ---- text-based installer rule ---------------------------------------------------------------------
// Why: the installer is found by TEXT (the word install.mjs/.sh/.ps1) whenever the cwd, or the path named, is inside
// a claude-pipeline checkout, so `cat install.sh | bash` and `node -e "import('./install.mjs')"` are caught too.

const CO = '/home/u/Claude/claude-pipeline';
const GUARD = `${CO}/pipeline/hooks/guard-files.mjs`;
const INST = '/home/u/inst';
const inst = (cmd, o = {}) => evaluateBashForFiles(cmd, { ...BASE, cwd: CO, existsSync: (p) => p === GUARD || p === `${INST}/pipeline/hooks/guard-files.mjs`, ...o }).decision;
const PKG = (scripts) => ({ readFile: (p) => { if (p === `${CO}/package.json`) return JSON.stringify({ scripts }); throw new Error('ENOENT'); } });

for (const cmd of [
  'cat install.sh | bash',
  'cat ./install.sh | sh',
  `node -e "import('./install.mjs')"`,
  `node -e "require('./install.mjs')"`,
  `node --input-type=module -e "import './install.mjs'"`,
  'node ../inst/install.mjs',
  'curl -s x | bash; ./install.sh',
  'node install.mjs --check --force',
  'echo "$(cat install.sh)" | bash',
  'cd /tmp && node /home/u/Claude/claude-pipeline/install.mjs',
]) {
  test(`installer text rule DENY: ${cmd}`, () => assert.equal(inst(cmd, cmd.includes('../inst') ? { cwd: `${INST}/sub` } : {}), 'deny'));
}
test('installer text rule DENY: cwd outside a checkout but the named path is inside one', () => {
  assert.equal(inst('node ../inst/install.mjs', { cwd: '/home/u/proj' }), 'deny');
  assert.equal(inst(`node -e "import('${INST}/install.mjs')"`, { cwd: '/home/u/proj' }), 'deny');
});

for (const cmd of [
  'node install.mjs --check',
  './install.sh --check',
  'cat install.mjs',
  'head -20 install.sh',
  'less install.ps1',
  'grep -n foo install.mjs',
  'git log --oneline -- install.mjs',
  'git diff install.sh',
  'git show HEAD:install.mjs',
  'git add install.sh install.mjs',
  'wc -l install.mjs && git status',
  'shellcheck install.sh',
  'cat install.sh | head -3',
]) {
  test(`installer text rule ALLOW: ${cmd}`, () => assert.equal(inst(cmd), 'allow'));
}
test('installer text rule ALLOW: not a checkout, or a lookalike name', () => {
  assert.equal(inst('cat install.sh | bash', { cwd: '/repo', existsSync: () => false }), 'allow');
  assert.equal(inst('node /opt/other/install.mjs', { cwd: '/repo' }), 'allow');
  assert.equal(inst('npm run reinstall.sh-check', PKG({})), 'allow');
  assert.equal(inst('echo preinstall.sh'), 'allow');
  assert.equal(inst('node installer.mjs'), 'allow');
});

test('installer text rule: npm run of a script that references the installer', () => {
  const o = PKG({ setup: 'node install.mjs', fine: 'node --test', chain: 'npm run setup', pre: 'echo hi', prepost: 'node scripts/x.mjs', postfine: 'sh ./install.sh', win: 'pwsh install.ps1' });
  assert.equal(inst('npm run setup', o), 'deny');
  assert.equal(inst('npm run-script setup', o), 'deny');
  assert.equal(inst('npm run --silent setup', o), 'deny');
  assert.equal(inst('npm run chain', o), 'deny');
  assert.equal(inst('npm run win', o), 'deny');
  assert.equal(inst('npm run fine', o), 'deny'); // postfine runs after it
  assert.equal(inst('npm run pre', o), 'allow');
  assert.equal(inst('npm run missing', o), 'allow');
  assert.equal(inst('npm run setup', { cwd: '/repo', ...o }), 'allow'); // not a checkout
});
test('installer text rule: npm run denies when package.json cannot be read or parsed', () => {
  assert.equal(inst('npm run anything', { readFile: () => { throw new Error('EACCES'); } }), 'deny');
  assert.equal(inst('npm run anything', { readFile: () => '{not json' }), 'deny');
});

// ---- 8b. time budget (review finding 12) ---------------------------------------------------------------

test('size cap: an oversized command line is not scanned; it is denied only when it mentions a sensitive word', () => {
  const spam = '{a,b}'.repeat(60_000);
  const t0 = Date.now();
  assert.equal(bash(`echo ${spam}`).decision, 'allow');
  assert.equal(bash(`echo ${spam}; echo x > ~/.cl""aude/settings.json`).decision, 'deny');
  assert.equal(bash(`echo ${spam}; node ins""tall.mjs`).decision, 'deny');
  assert.equal(bash(`echo ${spam}; export PIPELINE_""ADMIN=1`).decision, 'deny');
  assert.ok(Date.now() - t0 < 3000);
});

// ---- 9. script files hide commands (review finding 2) ----------------------------------------------------

// A fake file system keyed by absolute path.
const fsOf = (files) => ({ existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) });

test('script files: the file a shell, source, interpreter or path invocation runs is read and judged', () => {
  const files = {
    '/home/u/proj/w.sh': 'echo x > ~/.claude/settings.json',
    '/home/u/proj/rm.sh': '#!/bin/bash\nrm -rf ~/.claude/skills/ship',
    '/home/u/proj/admin.sh': 'export PIPELINE_ADMIN=1\nclaude',
    '/home/u/proj/nested.sh': 'bash w.sh',
    '/home/u/proj/ok.sh': 'ls ~/.claude/pipeline\ncat ~/.claude/settings.json\necho hi > notes.txt',
    '/home/u/proj/w.mjs': "import fs from 'node:fs';\nfs.writeFileSync(`${process.env.HOME}/.claude/settings.json`, '{}');",
    '/home/u/proj/w.py': "import os\nopen(os.path.expanduser('~/.claude/pipeline/x'), 'w').write('x')",
    '/home/u/proj/admin.mjs': "process.env.PIPELINE_ADMIN = '1';",
    '/home/u/proj/read.mjs': "console.log(require('fs').readFileSync(process.env.HOME + '/.claude/settings.json', 'utf8'))",
    '/home/u/proj/plain.mjs': "console.log('hi')",
    '/home/u/proj/sub/w.sh': 'rm ~/.claude/pipeline/VERSION',
  };
  const run = (c) => bash(c, PROJ, fsOf(files)).decision;
  for (const c of [
    'bash w.sh', 'sh ./w.sh', './w.sh', 'source w.sh', '. w.sh', 'env bash w.sh', 'bash rm.sh', 'bash admin.sh', 'bash nested.sh',
    'node w.mjs', 'python3 w.py', 'node admin.mjs', 'cd sub && bash w.sh', 'node ~/proj/w.mjs', 'bash /home/u/proj/w.sh',
    'node ~/.claude/pipeline/bin/pipeline.mjs job start c -- bash w.sh',
  ]) assert.equal(run(c), 'deny', c);
  for (const c of ['bash ok.sh', './ok.sh', 'node plain.mjs', 'node read.mjs', 'bash missing.sh', 'source missing.sh']) assert.equal(run(c), 'allow', c);
});

test('script files: a shell script that exists but cannot be read is denied, a missing one is not', () => {
  const unreadable = { existsSync: () => true, readText: () => null };
  assert.equal(bash('bash big.sh', PROJ, unreadable).decision, 'deny');
  assert.equal(bash('./tool', PROJ, unreadable).decision, 'allow');
  assert.equal(bash('node big.mjs', PROJ, unreadable).decision, 'allow');
  assert.equal(bash('bash big.sh', PROJ, { existsSync: () => false }).decision, 'allow');
});

test('script files: the pipeline CLI and node_modules programs are not scanned', () => {
  const files = {
    '/home/u/.claude/pipeline/bin/pipeline.mjs': "writeFileSync(join(home, '.claude', 'settings.json'), x); process.env.PIPELINE_ADMIN = '1'",
    '/home/u/proj/node_modules/.bin/tool': "#!/usr/bin/env node\nfs.writeFileSync(os.homedir() + '/.claude/settings.json', '')",
  };
  assert.equal(bash('node ~/.claude/pipeline/bin/pipeline.mjs preflight', PROJ, fsOf(files)).decision, 'allow');
  assert.equal(bash('./node_modules/.bin/tool', PROJ, fsOf(files)).decision, 'allow');
});

// ---- 10. macOS firmlink spelling and inode identity (review finding 5) ----------------------------------

const DARWIN = { platform: 'darwin' };

test('firmlink: /System/Volumes/Data/<path> names the same file on macOS, in file tools, MCP and Bash', () => {
  const p = '/System/Volumes/Data/home/u/.claude/settings.json';
  assert.equal(evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p, content: '{}' }, cwd: PROJ }, { ...BASE, ...DARWIN }).decision, 'deny');
  assert.equal(evaluateFileTool({ tool_name: 'Edit', tool_input: { file_path: '/System/Volumes/Data/home/u/.claude/skills/ship/SKILL.md', old_string: 'a', new_string: 'b' }, cwd: PROJ }, { ...BASE, ...DARWIN }).decision, 'deny');
  assert.equal(mcp('mcp__filesystem__write_file', { path: p, content: 'x' }, PROJ, DARWIN).decision, 'deny');
  assert.equal(bash(`echo {} > ${p}`, PROJ, DARWIN).decision, 'deny');
  assert.equal(bash('rm -rf /System/Volumes/Data/home/u/.claude/pipeline', PROJ, DARWIN).decision, 'deny');
  assert.equal(bash('cd /System/Volumes/Data/home/u/.claude && echo x > settings.json', PROJ, DARWIN).decision, 'deny');
  // reading is fine, other platforms do not have the alias, and unrelated files under /System/Volumes/Data stay allowed
  assert.equal(bash(`cat ${p}`, PROJ, DARWIN).decision, 'allow');
  assert.equal(evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: '/System/Volumes/Data/home/u/notes.md', content: 'x' }, cwd: PROJ }, { ...BASE, ...DARWIN }).decision, 'allow');
});

test('inode identity: a path that is the same file as a protected root (hard link, alias) is protected', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ino-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'pipeline', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.linkSync(path.join(home, '.claude', 'settings.json'), path.join(home, 'elsewhere', 'alias.json'));
  const real = { home, env: {}, platform: process.platform === 'win32' ? 'linux' : process.platform };
  const w = (file_path) => evaluateFileTool({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: home }, real).decision;
  if (process.platform !== 'win32') assert.equal(w(path.join(home, 'elsewhere', 'alias.json')), 'deny', 'hard link to settings.json');
  assert.equal(w(path.join(home, 'elsewhere', 'other.json')), 'allow');
  assert.equal(w(path.join(home, '.claude', 'pipeline', 'hooks', 'new.mjs')), 'deny', 'a new file inside a protected dir');
  assert.equal(w(path.join(home, '.claude', 'notes.md')), 'allow');
});

// ---- 11. globs over protected subtrees (review finding 6) --------------------------------------------------

table('glob over a protected subtree', [
  "sed -i '' s/a/b/ ~/.claude/skills/*/SKILL.md",
  'sed -i s/a/b/ ~/.claude/skills/ship/*.md',
  'echo x >> ~/.clau?e/pipeline/hooks/guard-git.mjs',
  'echo x >> ~/.c*/pipeline/hooks/guard-git.mjs',
  'cd ~/.clau?e/skills/ship && echo evil >> SKILL.md',
  'cd ~/.c*/pipeline && rm -rf hooks',
  'rm ~/.claude/agents/*.md',
  'rm ~/.claude/skills/ship*',
  'rm -rf ~/.claude/skills/*',
  'rm -rf ~/.cla*',
  'rm -rf ~/.claude/*',
  'echo x > ~/.claude/settings.js?n',
  'echo x > ~/.claude/settings.[j]son',
  'truncate -s 0 /home/u/.claude/pipeline/**/*.mjs',
  'rm /h*/u/.claude/pipeline/VERSION',
  'echo x > ~/.claude/p*/hooks/guard-files.mjs',
], 'deny');

table('glob that cannot reach a protected root', [
  'rm ~/.claude/projects/-x/memory/*.md',
  'rm ~/.claude/skills/shipping*',
  'rm ~/.claude/skills/other-*/x.md',
  'rm ~/.claude/agents/other*.md',
  'echo x > ~/.claude/CLAUDE.m?',
  'rm -rf ~/work/*',
  'cat ~/.claude/skills/*/SKILL.md',
  'ls ~/.clau?e/pipeline/hooks/*.mjs',
  'sha256sum ~/.claude/pipeline/hooks/*.mjs',
  'rm /home/*/scratch',
], 'allow');

// ---- 12. bare cd, links to home, -C style bases (review finding 7) -------------------------------------

table('bare cd / links / base dirs', [
  'cd && echo x > .claude/settings.json',
  'pushd && sed -i s/a/b/ .claude/settings.json',
  'cd ~ && echo x > .claude/settings.json',
  'ln -s ~ /tmp/h && echo x > /tmp/h/.claude/settings.json',
  'ln -s ~/.claude /tmp/c',
  'ln -s $HOME /tmp/h',
  'ln -sf / /tmp/root',
  'ln -s ~/.. /tmp/up',
  'ln -s ~/.claude/pipeline /tmp/p',
  'ln -t /tmp ~',
  'git -C ~ checkout -- .claude/settings.json',
  'git -C ~ restore .claude/skills/ship/SKILL.md',
  'git -C ~/.claude restore settings.json',
  'tar -C ~ -xf /tmp/a.tar .claude/settings.json',
  'tar --directory ~ -xf /tmp/a.tar .claude/pipeline',
  'tar -xf /tmp/a.tar -C ~/.claude pipeline',
  'unzip -d ~ /tmp/a.zip .claude/settings.json',
  'unzip /tmp/a.zip .claude/settings.json -d ~',
  'rsync -a /tmp/x/.claude/settings.json ~/.claude/',
  'cp -t ~/.claude/pipeline /tmp/x',
], 'deny');

table('bare cd / links / base dirs: allowed', [
  'cd && ls .claude/settings.json',
  'cd && cat .claude/settings.json',
  'cd ~ && echo x > notes.txt',
  'ln -s /tmp/x ./x',
  'ln -s ../shared ./shared',
  'ln -s ~/work/app /tmp/app',
  'git -C ~ status',
  'git -C ~/work/app checkout -- src/a.ts',
  'tar -C ~/work -xf /tmp/a.tar src',
  'unzip -d ~/work /tmp/a.zip',
  'cp -t ~/work /tmp/x',
  'cp -t ~ /tmp/x',
], 'allow');

// ---- 13. false positives: prose that names a protected path (review finding 9) ---------------------------

table('prose that merely names a protected path', [
  'git commit -m "docs: installer writes ~/.claude/settings.json"',
  'git commit -am "fix ~/.claude/pipeline/hooks docs"',
  'git commit --message="see ~/.claude/skills/ship"',
  'git commit -m"mention ~/.claude/settings.json"',
  'git tag -a v1 -m "touches ~/.claude/agents/judge.md"',
  'gh pr create --body "Edits ~/.claude/pipeline/hooks" --title "t"',
  'gh pr create --title "Protect ~/.claude/settings.json" --body x',
  'gh pr comment 3 --body "see ~/.claude/settings.json"',
  'gh pr comment 3 -b "see ~/.claude/settings.json"',
  'gh release create v1 --notes "rewrites ~/.claude/pipeline"',
  'echo "see ~/.claude/pipeline" >> notes.md',
  'echo ~/.claude/settings.json',
  'printf "%s\\n" ~/.claude/pipeline/VERSION > /tmp/out.txt',
  'npx vitest run -t "protects ~/.claude/settings.json"',
  'npm test -- --grep "guards ~/.claude/pipeline"',
  'npx jest -t "does not edit ~/.claude/skills/ship"',
  `git commit -m "$(cat <<'EOF'\nfix: note that ~/.claude/settings.json is protected\nEOF\n)"`,
], 'allow');

table('prose exemption does not cover real paths or writes', [
  'git commit -m "x" ~/.claude/settings.json',
  'git commit -m "x" -- ~/.claude/pipeline/VERSION',
  'git add ~/.claude/pipeline/hooks/x.mjs',
  'echo "see ~/.claude/pipeline" > ~/.claude/settings.json',
  'echo x >> ~/.claude/pipeline/VERSION',
  'echo x | tee ~/.claude/settings.json',
  'echo ~/.claude/pipeline | xargs rm -rf',
  'echo "rm -rf ~/.claude/pipeline" | sh',
  'cp -t ~/.claude/pipeline /tmp/x',
  'tar -t -f x.tar ~/.claude/pipeline/hooks && rm ~/.claude/pipeline/VERSION',
  'gh pr create --body "x" --body-file ~/.claude/settings.json && rm ~/.claude/settings.json',
  'npx vitest run -t "x" && rm ~/.claude/settings.json',
], 'deny');

// ---- 14. CLAUDECODE, quote-split installer names, test seams (review findings 8a and 13) ---------------------

const CHECKOUT_DIR = '/home/u/Claude/claude-pipeline';
const IN_CHECKOUT = { existsSync: (p) => p === `${CHECKOUT_DIR}/pipeline/hooks/guard-files.mjs` };

table('unsetting or overriding CLAUDECODE', [
  'env -u CLAUDECODE node install.mjs',
  'env -uCLAUDECODE true',
  'env --unset=CLAUDECODE true',
  'env --unset CLAUDECODE true',
  'env -u CLAU""DECODE true',
  "env -u 'CLAUDECODE' true",
  'unset CLAUDECODE',
  'unset -v CLAUDECODE && node x.mjs',
  'CLAUDECODE= node x.mjs',
  'CLAUDECODE=0 node x.mjs',
  'export CLAUDECODE=',
  'export CLAUDECODE=0; node x.mjs',
  'env CLAUDECODE=0 node x.mjs',
  'env -i node x.mjs',
  'env -i PATH=$PATH node x.mjs',
  'env --ignore-environment node x.mjs',
  'env - node x.mjs',
  'bash -c "unset CLAUDECODE; node x.mjs"',
  'Remove-Item Env:CLAUDECODE',
  'Remove-Item Env:\\CLAUDECODE',
  'ri env:claudecode',
  "$env:CLAUDECODE=''",
  '$env:CLAUDECODE = $null',
  "[Environment]::SetEnvironmentVariable('CLAUDECODE', $null)",
  'node -e "delete process.env.CLAUDECODE; run()"',
  'python3 -c "import os; os.environ.pop(\'CLAUDECODE\')"',
], 'deny');

table('naming CLAUDECODE without changing it', [
  'echo $CLAUDECODE',
  '[ -n "$CLAUDECODE" ] && echo yes',
  'env | grep CLAUDECODE',
  'printenv CLAUDECODE',
  'grep -n CLAUDECODE install.mjs',
  'git commit -m "installer: unset CLAUDECODE is not enough"',
  'env FOO=1 node x.mjs',
  'env -u FOO node x.mjs',
  'Get-ChildItem Env:CLAUDECODE',
], 'allow');

test('installer names survive quote-splitting and escapes', () => {
  const inside = (c) => bash(c, CHECKOUT_DIR, IN_CHECKOUT).decision;
  for (const c of ['node ins""tall.mjs', "node 'install'.mjs", 'node install.m\\js', 'sh ./inst""all.sh', './ins\\tall.sh', 'bash ins""tall.sh --force', 'pwsh ./install."ps1"', `cd ${CHECKOUT_DIR} && node i''nstall.mjs`]) {
    assert.equal(inside(c), 'deny', c);
  }
  for (const c of ['node install.mjs --check', 'node ins""tall.mjs --check', 'cat install.sh', 'git log -- ins""tall.mjs']) assert.equal(inside(c), 'allow', c);
  assert.equal(bash('node ins""tall.mjs', '/home/u/other').decision, 'allow', 'outside a checkout nothing is protected by name');
});

const SEAMS = ['PIPELINE_GH', 'PIPELINE_CODEX', 'PIPELINE_VERCEL', 'PIPELINE_TEST_MODE'];

test('test seams: setting PIPELINE_GH / CODEX / VERCEL / TEST_MODE on a command that runs pipeline.mjs is denied', () => {
  const P = 'node ~/.claude/pipeline/bin/pipeline.mjs merge 12';
  for (const v of SEAMS) {
    for (const c of [
      `${v}=/tmp/fake ${P}`,
      `env ${v}=/tmp/fake ${P}`,
      `export ${v}=/tmp/fake; ${P}`,
      `${v}=1; export ${v}; ${P}`,
      `$env:${v}='x'; ${P}`,
      `bash -c "${v}=/tmp/fake ${P}"`,
      `${v}=/tmp/fake pipeline merge 12`,
      `${v}=x node ~/.claude/pipeline/bin/pipeline.mjs job start c -- ${P}`,
      `${v}=x sudo ${P}`,
    ]) assert.equal(bash(c).decision, 'deny', c);
  }
  for (const c of [
    P,
    'PIPELINE_GH=gh node scripts/other.mjs',
    'export PIPELINE_GH=/tmp/fake',
    'echo PIPELINE_GH',
    'grep -rn PIPELINE_GH pipeline/lib',
    'PIPELINE_OFF=1 node ~/.claude/pipeline/bin/pipeline.mjs preflight',
    'PIPELINE_LOCK_DIR=/tmp/l node ~/.claude/pipeline/bin/pipeline.mjs merge 12',
  ]) assert.equal(bash(c).decision, 'allow', c);
});

test('test seams: a script file that sets one for pipeline.mjs is caught too', () => {
  const files = { '/home/u/proj/go.sh': 'PIPELINE_GH=/tmp/fake node ~/.claude/pipeline/bin/pipeline.mjs merge 1' };
  assert.equal(bash('bash go.sh', PROJ, { existsSync: (p) => p in files, readText: (p) => files[p] ?? null }).decision, 'deny');
});
