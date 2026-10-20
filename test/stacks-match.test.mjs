// Why: the register hook turns every tool call into "which private stacks does this use?", and a missed stack is a lease
// that was never written (the stack could be stopped under a running session). So matching must over-match: quoted text,
// `true || supabase stop`, an unparseable command all still name the stack, and nothing here ever removes a target. These
// tests pin that, the space-in-path stack folder (Review Focus 2), Windows-style paths that must not crash (CI runs
// ubuntu AND windows), and a prefilter that does string work only. exists / realpath / readFile are an in-memory fake fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_RE, devTargets, prefilter, cwdChain, stackTargets, isStartCommand, readProjectId, readOnlyCommand } from '../pipeline/lib/stacks/match.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };
const posixKey = (p) => String(p).replace(/\\/g, '/');

// files: { path: content }; links: { symlink: target }. Directories exist when a file lies under them.
function fakeFs({ files = {}, links = {} } = {}) {
  const calls = [];
  const exists = (p) => {
    calls.push(['exists', p]);
    const k = posixKey(p);
    return Object.keys(files).some((f) => f === k || f.startsWith(`${k}/`));
  };
  const realpath = (p) => {
    calls.push(['realpath', p]);
    const k = posixKey(p);
    if (links[k]) return links[k];
    if (!exists(k)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return k;
  };
  const readFile = (p) => {
    calls.push(['readFile', p]);
    const k = posixKey(p);
    if (!(k in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return files[k];
  };
  return { exists, realpath, readFile, calls };
}

const cfgToml = (id) => `# supabase\nproject_id = "${id}"\n\n[api]\nport = 54321\n`;
const stack = (project, workdir, ports, extra = {}) => ({
  project,
  workdir,
  workdirExists: true,
  folder: workdir === null ? null : workdir.split('/').pop(),
  shared: false,
  containers: ['kong', 'db'].map((s) => ({ id: s, name: `supabase_${s}_${project}`, running: true, startedAt: '' })),
  ports,
  ...extra,
});
const inventory = {
  dockerDown: false,
  stacks: [
    stack('sa-corrections', '/w/.worktrees/sa-corrections.stack', [54420, 54421, 54422]),
    stack('sub-detach', '/w/.worktrees/sub detach.stack', [54520, 54521]),
  ],
};
const base = fakeFs({
  files: {
    '/w/.worktrees/sa-corrections.stack/supabase/config.toml': cfgToml('sa-corrections'),
    '/w/.worktrees/sub detach.stack/supabase/config.toml': cfgToml('sub-detach'),
    '/w/.worktrees/new.stack/supabase/config.toml': cfgToml('new-proj'),
    '/w/.worktrees/e2e-wt/supabase/config.toml': cfgToml('e2e-ci'),
  },
});
const targets = (command, cwd, extra = {}) =>
  stackTargets({ tool: 'Bash', input: { command }, cwd, inventory, exists: base.exists, realpath: base.realpath, readFile: base.readFile, platform: 'linux', home: '/home/u', ...extra });
const projects = (ts) => ts.map((t) => t.project);

// ---- the plan's table ----
const table = [
  ['supabase status -o env --workdir ../sa-corrections.stack > ../sa-corrections.stack/.status.env', '/w/.worktrees/sa-correction-requests', ['sa-corrections']],
  ['cd /w/.worktrees/sa-correction-requests && supabase db reset --local --workdir ../sa-corrections.stack', '/', ['sa-corrections']],
  ['npx supabase test db --workdir "../sub detach.stack"', '/w/.worktrees/x', ['sub-detach']],
  ['docker exec -i supabase_db_sa-corrections psql -U postgres -c "select 1"', '/', ['sa-corrections']],
  ['SUPABASE_URL=http://127.0.0.1:54421 node scripts/seed.mjs', '/', ['sa-corrections']],
  ['true || supabase stop --workdir ../sa-corrections.stack', '/w/.worktrees/sa-correction-requests', ['sa-corrections']],
  ['echo "sa-corrections is done"', '/', ['sa-corrections']], // over-match: adds a lease, never removes one
  ['git status', '/', []],
];
for (const [command, cwd, want] of table) {
  test(`stackTargets: ${command.slice(0, 70)}`, () => {
    assert.deepEqual(projects(targets(command, cwd)), want);
  });
}

test('space-in-path stack: --workdir resolves to the stack folder with its space, via workdir', () => {
  const t = targets('npx supabase test db --workdir "../sub detach.stack"', '/w/.worktrees/x');
  assert.deepEqual(t, [{ project: 'sub-detach', folder: 'sub detach.stack', workdir: '/w/.worktrees/sub detach.stack', via: 'workdir' }]);
});

test('space-in-path stack: an unquoted/backslash-escaped path and a plain mention still name it', () => {
  assert.deepEqual(projects(targets('supabase status --workdir ../sub\\ detach.stack', '/w/.worktrees/x')), ['sub-detach']);
  assert.deepEqual(projects(targets('cp -r "/w/.worktrees/sub detach.stack/supabase" /tmp/x', '/')), ['sub-detach']);
});

test('--workdir=X form, and a workdir resolved through a symlink', () => {
  assert.deepEqual(projects(targets('supabase stop --workdir=../sa-corrections.stack', '/w/.worktrees/x')), ['sa-corrections']);
  const fs2 = fakeFs({ files: { '/real/sa.stack/supabase/config.toml': cfgToml('sa-corrections') }, links: { '/w/link.stack': '/real/sa.stack' } });
  const inv = { stacks: [stack('sa-corrections', '/real/sa.stack', [54421])] };
  const t = stackTargets({ tool: 'Bash', input: { command: 'supabase status --workdir link.stack' }, cwd: '/w', inventory: inv, ...fs2, platform: 'linux' });
  assert.deepEqual(t, [{ project: 'sa-corrections', folder: 'sa.stack', workdir: '/real/sa.stack', via: 'workdir' }]);
});

test('a workdir for a folder with config.toml but no container is a target (new stack about to start)', () => {
  const t = targets('supabase start --workdir ../new.stack', '/w/.worktrees/x');
  assert.deepEqual(t, [{ folder: 'new.stack', workdir: '/w/.worktrees/new.stack', project: 'new-proj', via: 'workdir' }]);
});

test('a workdir without config.toml and not in the inventory is not accepted', () => {
  assert.deepEqual(targets('supabase start --workdir ../missing.stack', '/w/.worktrees/x'), []);
});

test('bare supabase start inside a worktree whose config says e2e-ci targets e2e-ci (the caller drops it as shared)', () => {
  const t = targets('supabase start', '/w/.worktrees/e2e-wt');
  assert.deepEqual(t, [{ project: 'e2e-ci', folder: 'e2e-wt', workdir: '/w/.worktrees/e2e-wt', via: 'config-search' }]);
});

test('bare supabase searches upward from the cwd and from every cd target', () => {
  assert.deepEqual(projects(targets('supabase status', '/w/.worktrees/e2e-wt/app/deep')), ['e2e-ci']);
  assert.deepEqual(projects(targets('cd /w/.worktrees/sa-corrections.stack && supabase status', '/')), ['sa-corrections']);
  assert.deepEqual(projects(targets('cd sa-corrections.stack/supabase; npx supabase db lint', '/w/.worktrees')), ['sa-corrections']);
});

test('a segment with --workdir does not also search upward from the cwd', () => {
  const t = targets('supabase status --workdir ../sa-corrections.stack', '/w/.worktrees/e2e-wt');
  assert.deepEqual(projects(t), ['sa-corrections']);
});

test('inventory matches by folder, project, container and port, with their via', () => {
  assert.deepEqual(targets('cp -r ../sa-corrections.stack /tmp/x', '/x'), [{ project: 'sa-corrections', folder: 'sa-corrections.stack', workdir: '/w/.worktrees/sa-corrections.stack', via: 'folder' }]);
  assert.equal(targets('echo sa-corrections', '/x')[0].via, 'project');
  assert.equal(targets('docker restart supabase_kong_sa-corrections', '/x')[0].via, 'container');
  assert.equal(targets('psql -h localhost -p 54422 -c "select 1"', '/x')[0].via, 'port');
  assert.equal(targets('curl http://localhost:54521/rest/v1/', '/x')[0].project, 'sub-detach');
  assert.equal(targets('PGPORT=54422 psql', '/x')[0].via, 'port');
});

test('a project id inside a longer name or an unrelated port is not a match', () => {
  assert.deepEqual(targets('echo sa-corrections-notes sa-corrections_x', '/x'), []);
  assert.deepEqual(targets('curl localhost:54421999 localhost:3000', '/x'), []);
  assert.deepEqual(targets('git log --oneline -n 54421', '/x'), []);
});

test('one target per stack even when several signals name it', () => {
  const t = targets('cd ../sa-corrections.stack && supabase status --workdir . && psql -p 54421 sa-corrections', '/w/.worktrees/x');
  assert.equal(t.length, 1);
  assert.equal(t[0].via, 'workdir');
});

test('an unterminated quote over-matches instead of throwing', () => {
  const t = targets('supabase stop --workdir "../sa-corrections.stack && echo "', '/w/.worktrees/x');
  assert.deepEqual(projects(t), ['sa-corrections']);
  assert.deepEqual(projects(targets("echo 'sa-corrections", '/')), ['sa-corrections']);
  assert.deepEqual(projects(targets('supabase status --workdir ../sub detach.stack "', '/w/.worktrees/x')), ['sub-detach']);
});

test('a nested bash -c command is parsed too', () => {
  const t = targets('bash -c "cd /w/.worktrees/e2e-wt && supabase status"', '/');
  assert.deepEqual(projects(t), ['e2e-ci']);
});

test('a stack whose workdir is unknown matches by project / container / port only', () => {
  const inv = { stacks: [stack('DRMed', null, [54322], { shared: true })] };
  const t = stackTargets({ tool: 'Bash', input: { command: 'docker exec supabase_db_DRMed psql' }, cwd: '/', inventory: inv, ...base, platform: 'linux' });
  assert.deepEqual(t, [{ project: 'DRMed', via: 'container' }]);
});

test('project ids match case-insensitively', () => {
  assert.deepEqual(projects(targets('echo SA-Corrections', '/')), ['sa-corrections']);
});

test('inventory may be passed as a bare stacks array, missing, or empty', () => {
  const run = (inv) => stackTargets({ tool: 'Bash', input: { command: 'echo sa-corrections' }, cwd: '/', inventory: inv, ...base, platform: 'linux' });
  assert.deepEqual(projects(run(inventory.stacks)), ['sa-corrections']);
  assert.deepEqual(run(null), []);
  assert.deepEqual(run({ stacks: [] }), []);
});

test('bad input shapes return no targets and never throw', () => {
  for (const input of [undefined, null, {}, { command: 42 }, { command: '' }]) {
    assert.deepEqual(stackTargets({ tool: 'Bash', input, cwd: '/', inventory, ...base, platform: 'linux' }), []);
  }
  assert.deepEqual(stackTargets({ tool: 'Mystery', input: { command: 'echo sa-corrections' }, cwd: '/', inventory, ...base, platform: 'linux' }), []);
});

test('a throwing exists / realpath / readFile never throws out and never drops an inventory match', () => {
  const boom = () => { throw new Error('boom'); };
  const t = stackTargets({ tool: 'Bash', input: { command: 'supabase status --workdir ../sa-corrections.stack' }, cwd: '/w/.worktrees/x', inventory, exists: boom, realpath: boom, readFile: boom, platform: 'linux' });
  assert.deepEqual(projects(t), ['sa-corrections']);
});

// ---- file tools ----
const fileTargets = (tool, input, cwd = '/w/x') => stackTargets({ tool, input, cwd, inventory, ...base, platform: 'linux' });

test('Edit / Write / NotebookEdit of a path inside a stack folder', () => {
  assert.equal(fileTargets('Edit', { file_path: '/w/.worktrees/sa-corrections.stack/supabase/config.toml' })[0].via, 'path');
  assert.deepEqual(projects(fileTargets('Edit', { file_path: '/w/.worktrees/sub detach.stack/.env' })), ['sub-detach']);
  assert.deepEqual(projects(fileTargets('Write', { file_path: '../sa-corrections.stack/x.sql' }, '/w/.worktrees/x')), ['sa-corrections']);
  assert.deepEqual(projects(fileTargets('NotebookEdit', { notebook_path: '/w/.worktrees/sa-corrections.stack/n.ipynb' })), ['sa-corrections']);
});

test('Read / Grep / Glob are read-only inspection: they name no stack, even inside a stack folder', () => {
  assert.deepEqual(fileTargets('Read', { file_path: '/w/.worktrees/sa-corrections.stack/supabase/config.toml' }), []);
  assert.deepEqual(fileTargets('Grep', { pattern: 'x', path: '/w/.worktrees/sa-corrections.stack' }), []);
  assert.deepEqual(fileTargets('Glob', { pattern: '/w/.worktrees/sub detach.stack/**/*.sql' }), []);
  assert.deepEqual(fileTargets('Grep', { pattern: 'sa-corrections' }), []);
});

test('Write / Edit: a path inside the folder, and a relative path through the folder name', () => {
  assert.deepEqual(projects(fileTargets('Write', { file_path: '/w/.worktrees/sa-corrections.stack/supabase/x.sql' })), ['sa-corrections']);
  const t = fileTargets('Edit', { file_path: 'sub detach.stack/.env' }, '/elsewhere');
  assert.deepEqual(t, [{ project: 'sub-detach', folder: 'sub detach.stack', workdir: '/w/.worktrees/sub detach.stack', via: 'folder' }]);
});

test('a path outside every stack folder is not a target, nor is a sibling that shares a prefix', () => {
  assert.deepEqual(fileTargets('Edit', { file_path: '/w/.worktrees/other/README.md' }), []);
  assert.deepEqual(fileTargets('Edit', { file_path: '/w/.worktrees/sa-corrections.stack-old/x' }), []);
});

test('a symlinked path into a stack folder resolves to it', () => {
  const fs2 = fakeFs({ files: { '/real/sa.stack/supabase/config.toml': cfgToml('sa-corrections') }, links: { '/w/alias': '/real/sa.stack' } });
  const inv = { stacks: [stack('sa-corrections', '/real/sa.stack', [54421])] };
  const t = stackTargets({ tool: 'Write', input: { file_path: '/w/alias' }, cwd: '/w', inventory: inv, ...fs2, platform: 'linux' });
  assert.deepEqual(projects(t), ['sa-corrections']);
});

// ---- read-only inspection is not use ----
const readOnlyTable = [
  ['docker ps --filter name=sa-corrections', '/x'],
  ['docker inspect supabase_db_sa-corrections', '/x'],
  ['docker logs supabase_kong_sa-corrections', '/x'],
  ['docker container ls --filter label=x=sa-corrections', '/x'],
  ['grep -n x ../sa-corrections.stack/supabase/config.toml', '/w/.worktrees/x'],
  ['ls ../sa-corrections.stack', '/w/.worktrees/x'],
  ['cat ../sa-corrections.stack/supabase/config.toml | head -3', '/w/.worktrees/x'],
  ['lsof -i :54422', '/x'],
  ['ps aux | grep sa-corrections', '/x'],
  ['cd ../sa-corrections.stack && ls', '/w/.worktrees/x'],
  ['docker ps 2>/dev/null | grep sa-corrections', '/x'],
  ['find ../sa-corrections.stack -name x', '/w/.worktrees/x'],
];
for (const [command, cwd] of readOnlyTable) {
  test(`read-only: ${command.slice(0, 70)} names no stack`, () => {
    assert.deepEqual(targets(command, cwd), []);
  });
}

const stillUseTable = [
  'docker exec supabase_db_sa-corrections psql',
  'docker restart supabase_kong_sa-corrections',
  'ls ../sa-corrections.stack > out.txt',
  'cat x | psql -p 54422',
  'find ../sa-corrections.stack -delete',
  'rg --pre x sa-corrections',
  'echo sa-corrections | xargs echo',
  'bash -c "docker ps --filter name=sa-corrections"',
  'cd ../sa-corrections.stack && supabase status',
  'docker --context x ps sa-corrections',
  'sed -n 1p ../sa-corrections.stack/x',
  'cat "$(psql -p 54422 -c \'select 1\')"',
  'ls "`echo sa-corrections`"',
  'X="$(psql -p 54422)" ls',
  'grep x <(psql -p 54422)',
  'ls ${D:-../sa-corrections.stack}',
  'find ../sa-corrections.stack $FIND_ACTION',
  'ls $HOME/sa-corrections',
];
for (const command of stillUseTable) {
  test(`still a use: ${command.slice(0, 70)}`, () => {
    assert.deepEqual(projects(targets(command, '/w/.worktrees/x')), ['sa-corrections']);
  });
}

test('readOnlyCommand: inspections, neutral commands and /dev/null redirections are read-only', () => {
  for (const c of ['ls', 'ls -la /tmp', 'cd /a && ls', 'pushd /a; cat f', 'cat a | head -3 | wc -l', 'FOO=1 ls', 'docker ps', 'docker container ls', 'docker system df', 'docker volume ls', 'rg x .', 'find . -name x -type f',
    'ls >/dev/null', 'ls 2>/dev/null', 'ls &>/dev/null', 'ls >>/dev/null', 'ls > /dev/null', 'ls 2> /dev/null', 'ls 2>&1', 'ls >&2', 'docker ps 2>&1 | grep x', 'jq . f', 'ps aux']) {
    assert.equal(readOnlyCommand(c, 'linux'), true, c);
  }
});

test('readOnlyCommand: anything else, or nothing to inspect, is not read-only', () => {
  const no = ['', 'cd /a', 'cd /a && cd /b', 'FOO=1', 'echo hi', 'printf x', 'ls && git status', 'ls; supabase status', 'ls | xargs rm', 'env ls', 'sudo ls', 'timeout 5 ls', 'watch ls', 'bash -c "ls"', 'sh -c ls', 'zsh -c ls',
    'sed -n 1p f', 'awk 1 f', 'sort f', 'uniq f', 'tree .', 'curl localhost', 'psql -p 1', 'node a.js', 'npm test', 'supabase status',
    'docker exec x ls', 'docker cp a b', 'docker start x', 'docker stop x', 'docker rm x', 'docker run x', 'docker compose ps', 'docker --context x ps', 'docker -H x ps', 'docker', 'docker container rm x', 'docker system prune',
    'rg --pre x y', 'rg --pre=x y', 'find . -exec ls {} +', 'find . -execdir ls {} +', 'find . -ok ls {} ;', 'find . -okdir ls {} ;', 'find . -delete', 'find . -fprint f', 'find . -fprint0 f', 'find . -fprintf f x', 'find . -fls f',
    'ls > out.txt', 'ls >out.txt', 'ls >> out.txt', 'ls 2>err.txt', 'ls &>out', 'ls > /dev/nullx', 'ls >/dev/null/x', 'ls 2>', 'cat f > /dev/null > g',
    'ls $X', 'ls "$X"', 'ls $(pwd)', 'ls `pwd`', 'ls <(pwd)', 'ls >(cat)', 'ls ${X}', 'eval ls', 'exec ls', 'source f', '. f', 'ls; . f', 'echo ok; ls', 'ls "unterminated', 'ls $', 'ls \$'];
  for (const c of no) assert.equal(readOnlyCommand(c, 'linux'), false, c);
  for (const v of [undefined, null, 5, {}]) assert.equal(readOnlyCommand(v, 'linux'), false);
});

test('readOnlyCommand: rg --hostname-bin runs a program, so it is not read-only (either form)', () => {
  assert.equal(readOnlyCommand('rg --hostname-bin=../demo.stack/q --hyperlink-format=x foo', 'linux'), false);
  assert.equal(readOnlyCommand('rg --hostname-bin ../q --hyperlink-format=x foo', 'linux'), false);
  assert.equal(readOnlyCommand('rg --hyperlink-format=x foo', 'linux'), true);
});

test('readOnlyCommand: a backslash-newline line continuation can hide a flag, so it is not read-only', () => {
  assert.equal(readOnlyCommand('find x.stack -ex\\\nec rm {} ;', 'linux'), false);
  assert.equal(readOnlyCommand('rg --p\\\nre=x foo', 'linux'), false);
  assert.equal(readOnlyCommand('rg --p\\\r\nre=x foo', 'linux'), false);
  assert.equal(readOnlyCommand('ls \\\n-la', 'linux'), false);
});

test('readOnlyCommand: the platform is injected (a Windows-style path parses without throwing)', () => {
  assert.equal(readOnlyCommand('ls C:\\w\\x.stack', 'win32'), true);
  assert.equal(readOnlyCommand('cd C:\\w && cat a.txt', 'win32'), true);
});

// ---- devTargets / DEV_RE ----
test('DEV_RE recognises dev and start commands', () => {
  for (const c of ['npm run dev', 'npm start', 'next dev -p 4000', 'next start', 'npm dev', 'PORT=1 npm run start']) assert.ok(DEV_RE.test(c), c);
  for (const c of ['git status', 'npm test', 'npm run build', 'echo devices']) assert.ok(!DEV_RE.test(c), c);
});

test('devTargets: port from -p, --port, --port=, PORT=, default 3000', () => {
  assert.deepEqual(devTargets('npm run dev'), [{ port: 3000 }]);
  assert.deepEqual(devTargets('npm start'), [{ port: 3000 }]);
  assert.deepEqual(devTargets('next dev -p 4000'), [{ port: 4000 }]);
  assert.deepEqual(devTargets('PORT=4017 npm run dev'), [{ port: 4017 }]);
  assert.deepEqual(devTargets('next start --port=4001'), [{ port: 4001 }]);
  assert.deepEqual(devTargets('next start --port 4002'), [{ port: 4002 }]);
  assert.deepEqual(devTargets('npm run dev -- -p 4003'), [{ port: 4003 }]);
  assert.deepEqual(devTargets('git status'), []);
});

test('devTargets: each command in a chain gets its own port; duplicates collapse; a quoted mention still counts', () => {
  assert.deepEqual(devTargets('cd a && next dev -p 4000 & cd b && PORT=4100 npm run dev'), [{ port: 4000 }, { port: 4100 }]);
  assert.deepEqual(devTargets('npm run dev; npm run dev'), [{ port: 3000 }]);
  assert.deepEqual(devTargets('next dev -p 4000 && curl localhost:3000'), [{ port: 4000 }]);
  assert.deepEqual(devTargets('echo "npm run dev"'), [{ port: 3000 }]);
  assert.deepEqual(devTargets(undefined), []);
  assert.deepEqual(devTargets(42), []);
});

// ---- prefilter ----
const pf = (tool, input, inv = inventory) => prefilter({ tool, input, inventory: inv });

test('prefilter: Bash hits on supabase / .stack / psql / docker exec / ports / SUPABASE / PG vars', () => {
  for (const c of ['supabase status', 'ls ../x.stack', 'psql -c 1', 'docker  exec -i x sh', 'curl localhost:54421', 'SUPABASE_URL=x node a.js', 'PGHOST=x node a.js', 'cat .stack']) {
    assert.equal(pf('Bash', { command: c }), true, c);
  }
});

test('prefilter: Bash misses on unrelated commands', () => {
  for (const c of ['git status', 'npm test', 'ls -la', 'echo hi', '']) assert.equal(pf('Bash', { command: c }), false, c);
  assert.equal(pf('Bash', {}), false);
  assert.equal(pf('Bash', { command: 7 }), false);
});

test('prefilter: Bash hits on a project id, folder name or container name from the inventory as a whole word', () => {
  assert.equal(pf('Bash', { command: 'echo sa-corrections' }), true);
  assert.equal(pf('Bash', { command: 'echo "SA-CORRECTIONS"' }), true);
  assert.equal(pf('Bash', { command: 'ls sub-detach' }), true);
  assert.equal(pf('Bash', { command: 'echo sa-corrections-notes' }), false);
  const inv = { stacks: [stack('Zeta', '/w/zeta-dir', [54000])] };
  assert.equal(pf('Bash', { command: 'echo zeta' }, inv), true);
  assert.equal(pf('Bash', { command: 'cd zeta-dir' }, inv), true);
  assert.equal(pf('Bash', { command: 'echo azeta' }, inv), false);
  assert.equal(pf('Bash', { command: 'echo hi' }, null), false);
});

test('prefilter: file tools hit on a path inside an inventory folder, a .stack segment or a supabase segment', () => {
  assert.equal(pf('Read', { file_path: '/w/.worktrees/sa-corrections.stack/README.md' }), true);
  assert.equal(pf('Read', { file_path: '/w/.worktrees/sub detach.stack/a' }), true);
  assert.equal(pf('Read', { file_path: '/elsewhere/new.stack/a' }), true);
  assert.equal(pf('Edit', { file_path: '/repo/supabase/config.toml' }), true);
  assert.equal(pf('Grep', { pattern: 'x', path: '/repo/supabase' }), true);
  assert.equal(pf('Glob', { pattern: '/w/.worktrees/sa-corrections.stack/**' }), true);
  assert.equal(pf('NotebookEdit', { notebook_path: '/w/.worktrees/sa-corrections.stack/n.ipynb' }), true);
  assert.equal(pf('Read', { file_path: '/repo/src/a.ts' }), false);
  assert.equal(pf('Read', { file_path: '/repo/supabase-notes.md' }), false);
  assert.equal(pf('Read', {}), false);
  assert.equal(pf('Mystery', { file_path: '/w/.worktrees/sa-corrections.stack/a' }), false);
});

test('prefilter does string work only: its source never reaches for fs or a process', () => {
  const src = prefilter.toString();
  assert.doesNotMatch(src, /\b(?:exists|existsSync|realpath|readFile|readFileSync|spawn|execFile|run)\s*\(/);
  assert.equal(pf('Bash', { command: 'supabase status' }), true);
});

// ---- cwdChain ----
test('cwdChain: cwd then each cd target applied in order', () => {
  assert.deepEqual(cwdChain('git status', '/w'), ['/w']);
  assert.deepEqual(cwdChain('cd /a && cd b', '/w'), ['/w', '/a', '/a/b']);
  assert.deepEqual(cwdChain('cd a; cd ../c', '/w'), ['/w', '/w/a', '/w/c']);
  assert.deepEqual(cwdChain('cd "sub detach.stack" && ls', '/w'), ['/w', '/w/sub detach.stack']);
  assert.deepEqual(cwdChain('(cd /a && ls) || cd /b', '/w'), ['/w', '/a', '/b']);
});

test('cwdChain: cd with no usable target, variables and flags', () => {
  assert.deepEqual(cwdChain('cd', '/w'), ['/w']);
  assert.deepEqual(cwdChain('cd -', '/w'), ['/w']);
  assert.deepEqual(cwdChain('cd $HOME/x', '/w'), ['/w']);
  assert.deepEqual(cwdChain('cd -P -- /a', '/w'), ['/w', '/a']);
  assert.deepEqual(cwdChain('cd ~/x', '/w', { home: '/home/u' }), ['/w', '/home/u/x']);
  assert.deepEqual(cwdChain('pushd /a', '/w'), ['/w', '/a']);
  assert.deepEqual(cwdChain('echo "cd /a"', '/w'), ['/w', '/a']); // quoted text over-matches: one more directory to search
});

test('cwdChain: an unterminated quote does not throw; a missing cwd falls back to process.cwd()', () => {
  assert.deepEqual(cwdChain('cd /a && echo "x', '/w'), ['/w', '/a']);
  assert.equal(cwdChain('ls', undefined)[0], process.cwd());
});

// ---- Windows-style paths ----
test('win32: backslash paths are resolved and compared without crashing', () => {
  const winInv = { stacks: [stack('sa-corrections', 'C:/w/.worktrees/sa-corrections.stack', [54421])] };
  const wfs = fakeFs({ files: { 'C:/w/.worktrees/sa-corrections.stack/supabase/config.toml': cfgToml('sa-corrections'), 'C:/w/.worktrees/e2e-wt/supabase/config.toml': cfgToml('e2e-ci') } });
  const run = (command, cwd) => stackTargets({ tool: 'Bash', input: { command }, cwd, inventory: winInv, ...wfs, platform: 'win32', home: 'C:/Users/u' });
  assert.deepEqual(projects(run('supabase status --workdir ..\\sa-corrections.stack', 'C:\\w\\.worktrees\\x')), ['sa-corrections']);
  assert.deepEqual(projects(run('supabase status --workdir C:\\w\\.worktrees\\sa-corrections.stack', 'D:\\')), ['sa-corrections']);
  assert.deepEqual(projects(run('supabase status', 'C:\\w\\.worktrees\\e2e-wt\\app')), ['e2e-ci']);
  assert.deepEqual(projects(run('cd C:\\w\\.worktrees\\e2e-wt && supabase status', 'C:\\')), ['e2e-ci']);
  assert.deepEqual(cwdChain('cd ..\\y', 'C:\\w\\x', { platform: 'win32' }), ['C:\\w\\x', 'C:/w/y']);
  const t = stackTargets({ tool: 'Edit', input: { file_path: 'C:\\w\\.worktrees\\sa-corrections.stack\\supabase\\config.toml' }, cwd: 'C:\\', inventory: winInv, ...wfs, platform: 'win32' });
  assert.deepEqual(projects(t), ['sa-corrections']);
  assert.equal(prefilter({ tool: 'Read', input: { file_path: 'C:\\w\\x.stack\\a' }, inventory: winInv, platform: 'win32' }), true);
  assert.equal(prefilter({ tool: 'Read', input: { file_path: 'C:\\w\\.worktrees\\sa-corrections.stack\\a' }, inventory: winInv, platform: 'win32' }), true);
});

test('win32 vs POSIX: case differences match only where the platform ignores case', posixOnly, () => {
  const t = stackTargets({ tool: 'Edit', input: { file_path: '/W/.worktrees/sa-corrections.stack/a' }, cwd: '/', inventory, ...base, platform: 'linux' });
  // linux is case-sensitive for paths: the folder segment still names the stack, the path comparison alone does not
  assert.deepEqual(projects(t), ['sa-corrections']);
});

// ---- isStartCommand ----
test('isStartCommand: supabase ... start', () => {
  for (const c of ['supabase start', 'npx supabase start --workdir ../x.stack', 'supabase --workdir ../x start', 'cd a && supabase start -x studio', 'supabase@latest start', '/opt/homebrew/bin/supabase start']) {
    assert.equal(isStartCommand(c), true, c);
  }
  for (const c of ['supabase stop', 'supabase status', 'docker start x', 'git status', 'echo start', 'supabase status | grep start', '', undefined]) {
    assert.equal(isStartCommand(c), false, String(c));
  }
});

test('isStartCommand: an unparseable command is decided on the text, not thrown', () => {
  assert.equal(isStartCommand('supabase start "'), true);
  assert.equal(isStartCommand('supabase stop "'), false);
});

// ---- readProjectId ----
test('readProjectId: double quotes, single quotes, spaces; null otherwise', () => {
  assert.equal(readProjectId('project_id = "sa-corrections"\n'), 'sa-corrections');
  assert.equal(readProjectId("project_id='My Proj'"), 'My Proj');
  assert.equal(readProjectId('  project_id   =   "x"  # c'), 'x');
  assert.equal(readProjectId('[api]\nport = 1\nproject_id = "late"\n'), 'late');
  assert.equal(readProjectId('# project_id = "commented"\n'), null);
  assert.equal(readProjectId('project_id = ""\n'), null);
  assert.equal(readProjectId('project_id = unquoted\n'), null);
  assert.equal(readProjectId('xproject_id = "no"\n'), null);
  assert.equal(readProjectId(''), null);
  assert.equal(readProjectId(undefined), null);
  assert.equal(readProjectId(5), null);
});
