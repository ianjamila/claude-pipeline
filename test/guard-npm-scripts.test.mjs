// Why (#81 t9): the guards never opened a package-manager script. `npm run deploy` with a package.json that holds `"deploy": "git push origin main"` was ALLOWED by the git guard, and a script
// that writes a protected file was allowed by the files guard (npm / npx sat in OPAQUE_TOOLS and scriptFileOf has no reading for `npm run`). Now `npm run|run-script|rum|urn NAME`, the
// lifecycle shortcuts (`npm test|t|start|stop|restart`), `pnpm run NAME` / `pnpm NAME`, `yarn run NAME` / `yarn NAME` and `bun run NAME` read the package.json the manager would use (the current
// directory's, then each parent's; `--prefix` / `-C` / `--dir` / `--cwd` name the directory; `-w` / `--workspace` / `--filter` look in the workspace packages), take `scripts[NAME]` with its
// `pre` / `post` hooks, append the words after `--`, and judge that text like `bash -c TEXT` run in the package's directory (script readings, nested scripts, both guards).
// Guarded names are spelled in pieces (as test/guard-hidden-assignments.test.mjs does), also inside the fake package.json contents: the live guard scans files passed to node tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
const BAD_GIT = `git ${PUSH} origin ${MAIN}`;
const BAD_FILES = `cp a ~/${CL}/settings.json`;

// A fake file system: `files` maps a path (relative to root) to its text; a null text is a file that exists but cannot be read (too big, no permission).
function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u', ...dirs.map(abs)].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  const reads = [];
  return {
    reads,
    readText: (p) => { reads.push(resolve(p)); return typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null; },
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
const git = (command, files, o = {}) => {
  const { cwd = GIT_ROOT, ...rest } = o;
  const fs = fakeFs(GIT_ROOT, files);
  const r = evaluateGitCommand(command, { cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fs, ...rest });
  r.reads = fs.reads;
  return r;
};
const filesGuard = (command, files, o = {}) => {
  const { cwd = PROJ, ...rest } = o;
  const fs = fakeFs(PROJ, files);
  const r = evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd, ...fs, existsSync: fs.pathExists, ...rest });
  r.reads = fs.reads;
  return r;
};
// package.json at the root with these scripts; `bad`: 'git' | 'files' picks the guarded text where a spec value is 'bad'
const pkg = (scripts, extra = {}) => JSON.stringify({ name: 'x', version: '1.0.0', scripts, ...extra });
const fill = (v, bad) => (v === 'bad' ? bad : v === 'ok' ? 'echo hi' : v);
const scriptsFor = (spec, bad) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, fill(v, bad)]));
// files: { path: text | { scripts } } -- an object value is a package.json
const treeFor = (tree, bad) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, v !== null && typeof v === 'object' ? pkg(scriptsFor(v.scripts, bad), v.extra) : typeof v === 'string' ? fill(v, bad) : v]));
// a twin refused by both guards
const bad = (command, tree, o = {}) => {
  const g = git(command, treeFor(tree, BAD_GIT), o.git);
  assert.equal(g.decision, 'deny', `git: ${command} -> allowed`);
  const f = filesGuard(command, treeFor(tree, BAD_FILES), o.files);
  assert.equal(f.decision, 'deny', `files: ${command} -> allowed`);
  return { git: g, files: f };
};
// a command both guards let through
const ok = (command, tree, o = {}) => {
  const g = git(command, treeFor(tree, BAD_GIT), o.git);
  assert.equal(g.decision, 'allow', `git: ${command} -> ${g.reason}`);
  const f = filesGuard(command, treeFor(tree, BAD_FILES), o.files);
  assert.equal(f.decision, 'allow', `files: ${command} -> ${f.reason}`);
};
const root = (scripts, extra) => ({ 'package.json': { scripts, extra } });

test('t9 npm run NAME opens the script (every spelling) and judges its text', () => {
  const t = root({ deploy: 'bad', lint: 'ok' });
  for (const cmd of ['npm run deploy', 'npm run-script deploy', 'npm rum deploy', 'npm urn deploy', 'npm --silent run deploy', 'npm run -s deploy', 'npm run --silent deploy', 'npm -s run-script deploy',
    'npm run deploy --if-present', 'npm run deploy -- --dry', 'npm run "deploy"', "npm run 'deploy'", 'env npm run deploy', 'command npm run deploy', 'nice npm run deploy', 'FOO=1 npm run deploy',
    'echo hi && npm run deploy', 'true; npm run deploy; true', '(npm run deploy)', 'npm run lint && npm run deploy']) bad(cmd, t);
});
test('t9 pnpm, yarn and bun spellings', () => {
  const t = root({ ship: 'bad', lint: 'ok' });
  for (const cmd of ['pnpm run ship', 'pnpm run-script ship', 'pnpm ship', 'pnpm --silent ship', 'yarn run ship', 'yarn ship', 'yarn --silent ship', 'bun run ship', 'pnpm run ship -- --x', 'yarn ship --x', 'corepack pnpm ship', 'corepack yarn ship']) bad(cmd, t);
});
test('t9 the lifecycle shortcuts run their script', () => {
  for (const [cmd, name] of [['npm test', 'test'], ['npm t', 'test'], ['npm tst', 'test'], ['npm start', 'start'], ['npm stop', 'stop'], ['npm restart', 'restart'], ['pnpm test', 'test'], ['pnpm t', 'test'], ['yarn test', 'test'], ['pnpm start', 'start'], ['yarn start', 'start'],
    ['npm test -- --watch', 'test'], ['npm --silent test', 'test'], ['npm restart', 'stop'], ['npm restart', 'start'], ['npm restart', 'prerestart'], ['npm restart', 'postrestart']]) {
    bad(cmd, root({ [name]: 'bad' }));
  }
});
test('t9 a pre or post hook is run by the manager', () => {
  bad('npm run deploy', root({ predeploy: 'bad', deploy: 'ok' }));
  bad('npm run deploy', root({ deploy: 'ok', postdeploy: 'bad' }));
  bad('npm test', root({ pretest: 'bad', test: 'ok' }));
  bad('npm test', root({ test: 'ok', posttest: 'bad' }));
  bad('pnpm run deploy', root({ predeploy: 'bad', deploy: 'ok' }));
  bad('yarn deploy', root({ postdeploy: 'bad', deploy: 'ok' }));
  bad('npm start', root({ prestart: 'bad' }));
  // a hook of another script is not run
  ok('npm run lint', root({ predeploy: 'bad', postdeploy: 'bad', lint: 'ok' }));
  ok('npm run deploy', root({ prelint: 'bad', deploy: 'ok' }));
});
test('t9 a script that runs another script or file is followed', () => {
  bad('npm run deploy', { 'package.json': { scripts: { deploy: 'bash run.sh' } }, 'run.sh': 'bad' });
  bad('npm run deploy', { 'package.json': { scripts: { deploy: 'sh ./scripts/run.sh' } }, 'scripts/run.sh': 'bad' });
  bad('npm run deploy', { 'package.json': { scripts: { deploy: 'npm run inner', inner: 'bad' } } });
  bad('npm run deploy', { 'package.json': { scripts: { deploy: 'echo a && yarn inner', inner: 'bad' } } });
  bad('npm run a', { 'package.json': { scripts: { a: 'npm run b', b: 'npm run c', c: 'bad' } } });
  ok('npm run deploy', { 'package.json': { scripts: { deploy: 'bash run.sh' } }, 'run.sh': 'ok' });
  ok('npm run deploy', { 'package.json': { scripts: { deploy: 'npm run inner', inner: 'ok' } } });
});
test('t9 the words after -- are appended to the script text', () => {
  const t = { 'package.json': { scripts: { x: 'git ' + PUSH, f: 'cp a' } } };
  const g = (cmd) => git(cmd, treeFor(t, ''));
  assert.equal(g('npm run x').decision, 'allow', 'a bare push of the agent branch is allowed');
  assert.equal(g(`npm run x -- origin ${MAIN}`).decision, 'deny');
  assert.equal(g(`npm run x -- --force`).decision, 'deny', 'a forced push is refused');
  assert.equal(g(`pnpm run x origin ${MAIN}`).decision, 'deny');
  assert.equal(g(`yarn x origin ${MAIN}`).decision, 'deny');
  // npm keeps every option written before -- for itself: only the words after it reach the script
  assert.equal(g(`npm run x --if-present`).decision, 'allow');
  const f = (cmd) => filesGuard(cmd, treeFor(t, ''));
  assert.equal(f('npm run f -- b').decision, 'allow');
  assert.equal(f(`npm run f -- ~/${CL}/settings.json`).decision, 'deny');
  assert.equal(f(`pnpm run f ~/${CL}/settings.json`).decision, 'deny');
  assert.equal(f(`yarn f ~/${CL}/settings.json`).decision, 'deny');
});
test('t9 a name set earlier on the line is read, also in a loop', () => {
  const t = root({ deploy: 'bad', lint: 'ok' });
  bad('k=deploy; npm run $k', t);
  bad('k=deploy; npm run "$k"', t);
  bad('k=deploy && npm run -s ${k}', t);
  bad('for k in lint deploy; do npm run -s $k; done', t);
  bad('for k in deploy lint; do npm run $k; done', t);
  bad('for k in lint deploy; do pnpm run $k; done', t);
  bad('for k in lint deploy; do yarn $k; done', t);
  bad('n=deploy; for k in lint $n; do npm run -s $k; done', t);
  ok('k=lint; npm run $k', t);
  ok('for k in lint test; do npm run -s $k; done', t);
});
test('t9 a name only known at run time is refused by the git guard when the line mentions a guarded operation', () => {
  const t = treeFor(root({ deploy: 'bad', lint: 'ok' }), BAD_GIT);
  assert.equal(git('npm run $UNSET_NAME', t).decision, 'allow', 'nothing guarded on the line: as for a script named at run time');
  const r = git(`echo ${PUSH}; npm run $UNSET_NAME`, t);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /package script/);
  assert.match(r.reason, /run time/);
  assert.equal(git(`read k; npm run $k; echo ${MAIN}`, t).decision, 'deny');
});
test('t9 the package.json is the nearest one up the directory tree, or the one a directory option names', () => {
  const tree = { 'package.json': { scripts: { deploy: 'bad' } }, 'sub/deeper/file.txt': 'x' };
  bad('npm run deploy', tree, { git: { cwd: '/work/repo/sub/deeper' }, files: { cwd: '/home/u/proj/sub/deeper' } });
  ok('npm run lint', { 'package.json': { scripts: { lint: 'ok', deploy: 'bad' } }, 'sub/file.txt': 'x' }, { git: { cwd: '/work/repo/sub' }, files: { cwd: '/home/u/proj/sub' } });
  // the nearest package.json wins: its scripts are the ones that run, the parent's are not
  ok('npm run deploy', { 'package.json': { scripts: { deploy: 'bad' } }, 'sub/package.json': { scripts: { deploy: 'ok' } } }, { git: { cwd: '/work/repo/sub' }, files: { cwd: '/home/u/proj/sub' } });
  bad('npm run deploy', { 'package.json': { scripts: { deploy: 'ok' } }, 'sub/package.json': { scripts: { deploy: 'bad' } } }, { git: { cwd: '/work/repo/sub' }, files: { cwd: '/home/u/proj/sub' } });
  // a directory option
  const sub = { 'package.json': { scripts: { deploy: 'ok' } }, 'pkg/package.json': { scripts: { deploy: 'bad' } } };
  for (const cmd of ['npm --prefix pkg run deploy', 'npm --prefix=pkg run deploy', 'npm run deploy --prefix pkg', 'pnpm -C pkg run deploy', 'pnpm --dir pkg deploy', 'pnpm --dir=pkg run deploy', 'yarn --cwd pkg deploy', 'yarn --cwd=pkg run deploy']) bad(cmd, sub);
  ok('npm --prefix pkg run lint', { 'pkg/package.json': { scripts: { lint: 'ok', deploy: 'bad' } } });
  // the script runs in the package's directory: a relative path in it is that directory's
  bad('npm --prefix pkg run deploy', { 'pkg/package.json': { scripts: { deploy: 'bash run.sh' } }, 'pkg/run.sh': 'bad' });
  ok('npm --prefix pkg run deploy', { 'pkg/package.json': { scripts: { deploy: 'bash run.sh' } }, 'run.sh': 'bad', 'pkg/run.sh': 'ok' });
  // a directory only known at run time cannot be read
  const dyn = treeFor(sub, BAD_GIT);
  assert.equal(git(`echo ${PUSH}; npm --prefix "$P" run deploy`, dyn).decision, 'deny');
});
test('t9 workspaces: the root package.json and the workspace packages are read', () => {
  const ws = (inner) => ({ 'package.json': { scripts: { build: 'ok' }, extra: { workspaces: ['packages/*'] } }, 'packages/a/package.json': { scripts: inner }, 'packages/b/package.json': { scripts: { deploy: 'ok' } } });
  for (const cmd of ['npm run deploy -w packages/a', 'npm run deploy --workspace=packages/a', 'npm run deploy --workspaces', 'npm -w packages/a run deploy', 'npm run deploy -ws', 'pnpm --filter a deploy', 'pnpm -r run deploy', 'pnpm -F a run deploy', 'yarn workspace a deploy', 'yarn workspaces run deploy']) {
    bad(cmd, ws({ deploy: 'bad' }));
    ok(cmd, ws({ deploy: 'ok' }));
  }
  // a workspace pattern that cannot be listed is refused
  const deep = { 'package.json': { scripts: { build: 'ok' }, extra: { workspaces: ['packages/**'] } } };
  const r = git('npm run build -w a', treeFor(deep, BAD_GIT));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /workspace/);
});
test('t9 a manager setting that moves the package.json makes the script unknown', () => {
  const t = root({ lint: 'ok' });
  for (const pre of ['npm_config_prefix=/elsewhere', 'NPM_CONFIG_PREFIX=/elsewhere', 'INIT_CWD=/elsewhere', 'npm_package_json=/elsewhere/package.json', 'npm_config_workspace=a', 'PNPM_HOME=/e', 'npm_config_dir=/e', 'YARN_CWD=/e', 'YARN_RC_FILENAME=x', 'bun_install_cache=/e']) {
    for (const cmd of [`${pre} npm run lint`, `export ${pre}; npm run lint`, `env ${pre} npm run lint`, `${pre}; npm run lint`]) {
      const g = git(cmd, treeFor(t, BAD_GIT));
      assert.equal(g.decision, 'deny', `git: ${cmd}`);
      assert.match(g.reason, /package script/);
      assert.equal(filesGuard(cmd, treeFor(t, BAD_FILES)).decision, 'deny', `files: ${cmd}`);
    }
  }
  for (const flag of ['--cwd=/e', 'npm_config_loglevel=error', 'NPM_CONFIG_LOGLEVEL=error', 'CI=1', 'NODE_ENV=production', 'FORCE_COLOR=0']) {
    if (flag.startsWith('--')) continue;
    ok(`${flag} npm run lint`, t);
  }
  // a setting on a command that runs no script moves nothing
  ok('npm_config_prefix=/e npm install', t);
});
test('t9 harmless scripts and commands that run no script stay allowed', () => {
  const t = { 'package.json': { scripts: { lint: 'eslint .', build: 'tsc -p .', test: 'node --test', start: 'node server.js', deploy: 'bad' } }, 'sub/x': 'x' };
  for (const cmd of ['npm run lint', 'npm test', 'npm t', 'npm run build -- --watch', 'npm run build --silent', 'npm start', 'pnpm lint', 'pnpm run build', 'yarn lint', 'yarn run build', 'bun run build', 'npm run', 'npm run -s', 'npm run --silent',
    'npm install', 'npm i', 'npm ci', 'npm install left-pad', 'npm view deploy', 'npm ls', 'npm config get prefix', 'npm --version', 'npm -v', 'pnpm install', 'pnpm add left-pad', 'yarn install', 'yarn', 'yarn add left-pad', 'bun install', 'bun add left-pad',
    'npm run nothing', 'npm run lint:fix', 'npm run deploy-docs', 'npx prettier --check .', 'npm exec -- prettier --check .', 'pnpm exec prettier .', 'pnpm dlx create-thing', 'yarn dlx create-thing', 'bunx prettier .', 'node -e 1']) ok(cmd, t);
  // no package.json at all: nothing runs
  for (const cmd of ['npm run deploy', 'npm test', 'pnpm deploy', 'yarn deploy']) ok(cmd, { 'x.txt': 'x' });
  // a package.json that is not valid JSON, or has no scripts: npm refuses it before running anything
  ok('npm run deploy', { 'package.json': '{ not json' });
  ok('npm run deploy', { 'package.json': pkg(undefined) });
  ok('npm run deploy', { 'package.json': '{"scripts": []}' });
  ok('npm run deploy', { 'package.json': '{"scripts": {"deploy": 5}}' });
});
test('t9 a package.json that cannot be read, or a script that is not text, is refused only when it is the one that runs', () => {
  const unreadable = { 'package.json': null };
  for (const cmd of ['npm run deploy', 'npm test', 'pnpm deploy']) {
    const g = git(cmd, unreadable);
    assert.equal(g.decision, 'deny', `git: ${cmd}`);
    assert.match(g.reason, /package\.json/);
    assert.equal(filesGuard(cmd, unreadable).decision, 'deny', `files: ${cmd}`);
  }
  ok('npm install', unreadable);
  ok('npm run', unreadable);
  // a manager option that lists or prints runs nothing
  ok('npm --version', unreadable);
});
test('t9 the package.json is read once per evaluation, and the work counts against the script budget', () => {
  const tree = treeFor(root({ lint: 'ok', build: 'ok', test: 'ok' }), BAD_GIT);
  const g = git('npm run lint && npm run build && npm test && npm run lint', tree);
  assert.equal(g.decision, 'allow', g.reason);
  assert.equal(g.reads.filter((p) => p === resolve(GIT_ROOT, 'package.json')).length, 1, `package.json read ${g.reads.length} times`);
  const f = filesGuard('npm run lint && npm run build && npm test && npm run lint', treeFor(root({ lint: 'ok', build: 'ok', test: 'ok' }), BAD_FILES));
  assert.equal(f.decision, 'allow', f.reason);
  assert.equal(f.reads.filter((p) => p === resolve(PROJ, 'package.json')).length, 1, `package.json read ${f.reads.length} times`);
  // a script that runs itself ends in a refusal, not a hang
  const loop = treeFor(root({ a: 'npm run a' }), BAD_GIT);
  const r = git('npm run a', loop);
  assert.equal(r.decision, 'deny');
  assert.equal(filesGuard('npm run a', treeFor(root({ a: 'npm run a' }), BAD_FILES)).decision, 'deny');
  // a long chain of scripts that run each other is cut off by the budget
  const chain = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, i < 39 ? `npm run s${i + 1}` : 'ok']));
  assert.equal(git('npm run s0', treeFor(root(chain), BAD_GIT)).decision, 'deny');
});
test('t9 npm exec / npx of a path or a node_modules/.bin shell script opens it; package JS is not opened', () => {
  const tree = { 'node_modules/.bin/tool': '#!/bin/sh\nbad\n', 'bin/run.sh': '#!/bin/sh\nbad\n', 'node_modules/.bin/jstool': '#!/usr/bin/env node\nbad\n', 'node_modules/.bin/fine': '#!/bin/sh\nok\n' };
  const g = (cmd, tr = tree) => git(cmd, treeFor(tr, BAD_GIT));
  assert.equal(g('npx tool').decision, 'deny');
  assert.equal(g('npm exec tool').decision, 'deny');
  assert.equal(g('npm exec -- tool --x').decision, 'deny');
  assert.equal(g('pnpm exec tool').decision, 'deny');
  assert.equal(g('npx --yes tool').decision, 'deny');
  assert.equal(g('npx ./bin/run.sh').decision, 'deny');
  assert.equal(g('npm exec ./bin/run.sh').decision, 'deny');
  assert.equal(g('npx fine').decision, 'allow');
  assert.equal(g('npx jstool').decision, 'allow', 'a program in another language in node_modules is not ours to judge');
  assert.equal(g('npx prettier .').decision, 'allow');
  assert.equal(g('bunx other').decision, 'allow');
  assert.equal(g('tool').decision, 'allow', 'a bare command that is not run through a package runner is not looked up in node_modules/.bin');
  assert.equal(git('npx tool', treeFor(tree, BAD_GIT), { cwd: '/work/repo/sub' }).decision, 'deny', 'the bin directory of a parent is searched');
});
test('t9 npx -c / npm exec -c text is judged as a shell line', () => {
  const t = {};
  assert.equal(git(`npx -c '${BAD_GIT}'`, t).decision, 'deny');
  assert.equal(git(`npm exec -c '${BAD_GIT}'`, t).decision, 'deny');
  assert.equal(filesGuard(`npx -c '${BAD_FILES}'`, t).decision, 'deny');
});
test('t9 the repo merge script run through npm exec is caught like npm run merge', () => {
  const H7 = '7'.repeat(40);
  const ownerGo = { mode: () => 'chat', mergeTemplates: () => [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }], approvedHead: (pr, head) => pr === 7 && head === H7 };
  const v = (cmd) => evaluateGitCommand(cmd, { cwd: '/chat', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ownerGo, readText: () => null, readHead: () => null, pathExists: () => false, readDir: () => null });
  for (const cmd of ['npm exec merge -- 8', 'npm exec -- merge 8 --expect-head ' + '8'.repeat(40), 'npx merge 8', 'pnpm exec merge 8', 'pnpm dlx merge 8', 'yarn dlx merge 8', 'bunx merge 8', 'npm x -- merge 8', 'npx --yes merge 8']) {
    assert.equal(v(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['npm exec -- prettier --check .', 'npx prettier .', 'npx merge-report', 'npm exec build']) assert.equal(v(cmd).decision, 'allow', `${cmd}: ${v(cmd).reason}`);
});
test('t9 an inline operator in a write target is read like a name assigned with it', () => {
  const f = (cmd) => filesGuard(cmd, {});
  for (const cmd of [`F=ok; echo x > ~/\${F/ok/${CL}}/settings.json`, `F=ok; echo x > $HOME/\${F/ok/${CL}}/settings.json`, `F=ok; cp a ~/\${F/ok/${CL}}/settings.json`,
    `F=ok; echo x >> ~/\${F//ok/${CL}}/settings.json`, `F=x${CL}; echo x > ~/\${F#x}/settings.json`, `F=${CL}.bak; tee ~/\${F%.bak}/settings.json`, `F=(x ${CL}); echo x > ~/\${F[1]}/settings.json`]) {
    assert.equal(f(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['F=ok; echo x > ~/${F/ok/other}/settings.json', 'F=ok; echo x > ~/${F/ok/other}/a.txt', 'F=a.ts; cp a ${F%.ts}.js', 'F=ok; cat ~/${F/ok/other}/a.txt']) assert.equal(f(cmd).decision, 'allow', cmd);
});
