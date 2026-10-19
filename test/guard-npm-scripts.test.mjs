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
  const t = { 'package.json': { scripts: { shipit: 'git ' + PUSH, f: 'cp a' } } };
  const g = (cmd) => git(cmd, treeFor(t, ''));
  assert.equal(g('npm run shipit').decision, 'allow', 'a bare push of the agent branch is allowed');
  assert.equal(g(`npm run shipit -- origin ${MAIN}`).decision, 'deny');
  assert.equal(g(`npm run shipit -- --force`).decision, 'deny', 'a forced push is refused');
  assert.equal(g(`pnpm run shipit origin ${MAIN}`).decision, 'deny');
  assert.equal(g(`yarn shipit origin ${MAIN}`).decision, 'deny');
  // npm keeps every option written before -- for itself: only the words after it reach the script
  assert.equal(g(`npm run shipit --if-present`).decision, 'allow');
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
  for (const pre of ['npm_config_prefix=/elsewhere', 'NPM_CONFIG_PREFIX=/elsewhere', 'INIT_CWD=/elsewhere', 'npm_package_json=/elsewhere/package.json', 'npm_config_workspace=a', 'PNPM_HOME=/e', 'npm_config_dir=/e', 'YARN_CWD=/e', 'YARN_RC_FILENAME=x', 'bun_install_cache=/e', 'npm_config_loglevel=error', 'NPM_CONFIG_LOGLEVEL=error', 'COREPACK_HOME=/e', 'NODE_OPTIONS=--require=/e/x.js', 'npm_foo=1']) {
    for (const cmd of [`${pre} npm run lint`, `export ${pre}; npm run lint`, `env ${pre} npm run lint`, `${pre}; npm run lint`]) {
      const g = git(cmd, treeFor(t, BAD_GIT));
      assert.equal(g.decision, 'deny', `git: ${cmd}`);
      assert.match(g.reason, /package script/);
      assert.equal(filesGuard(cmd, treeFor(t, BAD_FILES)).decision, 'deny', `files: ${cmd}`);
    }
  }
  for (const flag of ['--cwd=/e', 'CI=1', 'NODE_ENV=production', 'FORCE_COLOR=0']) {
    if (flag.startsWith('--')) continue;
    ok(`${flag} npm run lint`, t);
  }
  // a setting on a command that runs no script moves nothing
  ok('npm_config_prefix=/e npm ls', t);
});
test('t9 harmless scripts and commands that run no script stay allowed', () => {
  const t = { 'package.json': { scripts: { lint: 'eslint .', build: 'tsc -p .', test: 'node --test', start: 'node server.js', deploy: 'bad' } }, 'sub/x': 'x' };
  for (const cmd of ['npm run lint', 'npm test', 'npm t', 'npm run build -- --watch', 'npm run build --silent', 'npm start', 'pnpm lint', 'pnpm run build', 'yarn lint', 'yarn run build', 'bun run build', 'npm run', 'npm run -s', 'npm run --silent',
    'npm install', 'npm i', 'npm ci', 'npm install left-pad', 'npm view deploy', 'npm ls', 'npm config get prefix', 'npm --version', 'npm -v', 'pnpm install', 'pnpm add left-pad', 'yarn install', 'yarn', 'yarn add left-pad', 'bun install', 'bun add left-pad',
    'npm run nothing', 'npm run lint:fix', 'npm run deploy-docs', 'npx prettier --check .', 'npm exec -- prettier --check .', 'pnpm exec prettier .', 'pnpm dlx create-thing', 'yarn dlx create-thing', 'bunx prettier .', 'node -e 1']) ok(cmd, t);
  // no package.json at all: nothing runs
  for (const cmd of ['npm run deploy', 'npm test', 'pnpm deploy', 'yarn deploy']) ok(cmd, { 'x.txt': 'x' });
  // a package.json with no scripts: nothing runs
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
  assert.equal(git('npm install', unreadable).decision, 'deny', 'an install runs the root lifecycle scripts');
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
  const tree = { 'node_modules/.bin/tool': `#!/bin/sh\n${BAD_GIT}\n`, 'bin/run.sh': `#!/bin/sh\n${BAD_GIT}\n`, 'node_modules/.bin/jstool': `#!/usr/bin/env node\n${BAD_GIT}\n`, 'node_modules/.bin/fine': '#!/bin/sh\necho hi\n' };
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

// ---- the edges of the rule -------------------------------------------------------------------------------------------------------------------------------------
test('t9 a script that does not exist runs no hook, and --userconfig / --globalconfig make the package.json unknown', () => {
  ok('npm run nothing', root({ prenothing: 'bad', postnothing: 'bad', lint: 'ok' }));
  for (const cmd of ['npm --userconfig /e/rc run lint', 'npm run lint --userconfig=/e/rc', 'pnpm --globalconfig /e/rc lint']) {
    assert.equal(git(cmd, treeFor(root({ lint: 'ok' }), BAD_GIT)).decision, 'deny', cmd);
    assert.equal(filesGuard(cmd, treeFor(root({ lint: 'ok' }), BAD_FILES)).decision, 'deny', cmd);
  }
});
test('t9 a directory the guard lost track of: refused when the session project has scripts to run, or the line mentions a guarded operation', () => {
  assert.equal(git('source ./env.sh && npm test', {}).decision, 'allow', 'no project known: nothing to refuse');
  const r = git('source ./env.sh && npm test', treeFor(root({ test: 'ok' }), BAD_GIT));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /directory this runs in is unknown/);
  const g = git(`source ./env.sh && npm test; echo ${PUSH}`, {});
  assert.equal(g.decision, 'deny');
  assert.match(g.reason, /directory this runs in is unknown/);
  assert.equal(git('source ./env.sh && npm ls', treeFor(root({ test: 'bad' }), BAD_GIT)).decision, 'allow', 'a command that runs no script');
});
test('t9 a package.json the line itself writes before the manager reads it is refused', () => {
  const t = root({ lint: 'ok' });
  for (const cmd of [`echo '{}' > package.json && npm run lint`, `printf '{"scripts":{"lint":"echo hi"}}' > package.json; npm run lint`, `cp other.json package.json && npm test`, `echo '{}' > sub/package.json && npm --prefix sub run lint`]) {
    const g = git(cmd, treeFor(t, BAD_GIT));
    assert.equal(g.decision, 'deny', `git: ${cmd}`);
    assert.match(g.reason, /writes .*package\.json/);
    assert.equal(filesGuard(cmd, treeFor(t, BAD_FILES)).decision, 'deny', `files: ${cmd}`);
  }
  // another file written before is none of its business
  ok(`echo hi > notes.txt && npm run lint`, t);
});
test('t9 a package-manager call inside a script judged with a script of its own sees that script\'s variables and directory', () => {
  bad('npm run a', { 'package.json': { scripts: { a: 'cd sub && npm run b' } }, 'sub/package.json': { scripts: { b: 'bad' } } });
  ok('npm run a', { 'package.json': { scripts: { a: 'cd sub && npm run b' } }, 'sub/package.json': { scripts: { b: 'ok' } } });
});
test('t9 (#73 follow-up) INIT_CWD and npm_package_json move the repo merge script like npm_config_prefix', () => {
  const H7 = '7'.repeat(40);
  const ownerGo = { mode: () => 'chat', mergeTemplates: () => [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }], approvedHead: (pr, head) => pr === 7 && head === H7 };
  const v = (cmd) => evaluateGitCommand(cmd, { cwd: '/chat', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ownerGo, readText: () => null, readHead: () => null, pathExists: () => false, readDir: () => null });
  const exact = `npm run merge -- 7 --expect-head ${H7}`;
  assert.equal(v(exact).decision, 'allow', 'the exact approved form stays approvable');
  for (const pre of ['npm_config_prefix=/x', 'NPM_CONFIG_PREFIX=/x', 'INIT_CWD=/x', 'npm_package_json=/x/package.json', 'init_cwd=/x']) assert.equal(v(`${pre} ${exact}`).decision, 'deny', pre);
});

// ---- security review of t9: lifecycle commands, allowlists, lookup and configuration -------------------------------------------------------------------------
test('t9 install, pack, publish and version run the root lifecycle scripts; --ignore-scripts turns them off', () => {
  for (const [cmd, name] of [['npm install', 'postinstall'], ['npm i', 'preinstall'], ['npm ci', 'prepare'], ['npm install left-pad', 'install'], ['npm add left-pad', 'prepare'], ['npm rebuild', 'postinstall'], ['npm update', 'prepare'], ['npm up', 'prepare'],
    ['npm dedupe', 'prepare'], ['npm prune', 'prepare'], ['npm link', 'prepare'], ['npm uninstall x', 'prepare'], ['npm it', 'prepare'], ['npm cit', 'prepare'], ['npm install-test', 'test'], ['npm audit fix', 'prepare'], ['npm pack', 'prepack'], ['npm pack', 'postpack'],
    ['npm publish', 'prepublishOnly'], ['npm publish', 'postpublish'], ['npm version patch', 'preversion'], ['npm version patch', 'postversion'], ['npm isntall', 'prepare'], ['npm ins', 'prepare'], ['npm --silent install', 'prepare'],
    ['yarn', 'prepare'], ['yarn install', 'prepare'], ['yarn add x', 'postinstall'], ['pnpm install', 'prepare'], ['pnpm i', 'postinstall'], ['pnpm add x', 'prepare'], ['bun install', 'postinstall'], ['bun add x', 'prepare'], ['yarn publish', 'prepublishOnly'], ['pnpm version patch', 'preversion']]) {
    bad(cmd, root({ [name]: 'bad' }));
  }
  for (const cmd of ['npm install', 'npm ci', 'npm pack', 'npm publish', 'yarn', 'pnpm install', 'bun install', 'npm audit fix', 'npm install --ignore-scripts', 'npm ci --ignore-scripts=true', 'pnpm install --ignore-scripts', 'yarn --ignore-scripts']) {
    ok(cmd.includes('ignore') ? cmd : `${cmd} --ignore-scripts`, root({ postinstall: 'bad', prepare: 'bad', prepack: 'bad', prepublishOnly: 'bad' }));
  }
  bad('npm ci --ignore-scripts=false', root({ prepare: 'bad' }));
  bad('npm ci --ignore-scripts --no-ignore-scripts', root({ prepare: 'bad' }));
  // harmless lifecycle scripts keep the install allowed
  ok('npm install', root({ prepare: 'husky install', postinstall: 'node scripts/patch.js', test: 'bad', deploy: 'bad' }));
  ok('npm ci', root({ lint: 'ok' }));
  // --ignore-scripts keeps the named script but drops its hooks
  bad('npm run deploy --ignore-scripts', root({ deploy: 'bad' }));
  ok('npm run deploy --ignore-scripts', root({ predeploy: 'bad', deploy: 'ok', postdeploy: 'bad' }));
  ok('npm test --ignore-scripts', root({ pretest: 'bad', test: 'ok' }));
  // npm start without a start script runs node server.js; a native module with no install script runs node-gyp
  bad('npm start', { 'server.js': 'bad', 'package.json': { scripts: { lint: 'ok' } } });
  const gyp = treeFor({ 'package.json': { scripts: { lint: 'ok' } }, 'binding.gyp': '{}' }, BAD_GIT);
  assert.equal(git('npm install', gyp).decision, 'deny');
  assert.equal(git('npm install --ignore-scripts', gyp).decision, 'allow');
  assert.equal(git('npm install', treeFor({ 'package.json': { scripts: { install: 'ok' } }, 'binding.gyp': '{}' }, BAD_GIT)).decision, 'allow');
});
test('t9 only subcommands on the explicit allowlist run no script; an unknown or abbreviated one is judged with every lifecycle script and every word as a script name', () => {
  const t = root({ prepare: 'bad', postinstall: 'bad', test: 'bad', deploy: 'bad' });
  for (const cmd of ['npm ls', 'npm list', 'npm view left-pad', 'npm info x', 'npm show x', 'npm outdated', 'npm whoami', 'npm search x', 'npm ping', 'npm doctor', 'npm prefix', 'npm root', 'npm explain x', 'npm why x', 'npm query x', 'npm audit', 'npm audit --json',
    'npm cache ls', 'npm owner ls x', 'npm access list x', 'npm config get x', 'npm config list', 'npm help run', 'npm --version', 'npm -v', 'npm fund', 'npm --silent ls', 'npm --loglevel silent view x',
    'yarn info x', 'yarn why x', 'yarn list', 'yarn config list', 'pnpm ls', 'pnpm outdated', 'pnpm why x', 'pnpm store status', 'pnpm audit', 'bun pm ls', 'bun outdated', 'bun test']) ok(cmd, t);
  for (const cmd of ['npm frobnicate', 'npm instal', 'npm isnt', 'npm ins', 'npm rum-script deploy', 'npm run-scr deploy', 'npm explore x -- ls', 'npm edit x', 'npm diff', 'npm init x', 'npm create x', 'npm pkg get name', 'npm set-script x y', 'npm exec', 'npm x']) bad(cmd, t);
  // a word of an unknown subcommand may be the script
  bad('npm run-scr deploy', root({ deploy: 'bad' }));
});
test('t9 any variable of the managers\' families, or one named at run time, makes the script unknown', () => {
  const t = root({ lint: 'ok' });
  for (const cmd of ['export $N=x; npm run lint', 'declare -x $N=x; npm run lint', 'export FOO=1 $N=x; npm run lint']) {
    assert.equal(git(cmd, treeFor(t, BAD_GIT)).decision, 'deny', `git: ${cmd}`);
  }
  assert.equal(filesGuard('export $N=x; npm run lint', treeFor(t, BAD_FILES)).decision, 'deny');
  ok('export FOO=1; npm run lint', t);
});
test('t9 npm stops its upward search at a node_modules folder; the other managers do not', () => {
  const tree = { 'package.json': { scripts: { deploy: 'bad' } }, 'sub/node_modules/x/index.js': 'x', 'sub/file.txt': 'x' };
  const at = { git: { cwd: '/work/repo/sub' }, files: { cwd: '/home/u/proj/sub' } };
  ok('npm run deploy', tree, at);
  for (const cmd of ['pnpm run deploy', 'yarn deploy', 'bun run deploy']) bad(cmd, tree, at);
});
test('t9 a package.json the guard cannot read exactly is refused; a BOM is stripped and the last duplicate key wins', () => {
  const raw = (text) => ({ 'package.json': text });
  const g = (cmd, text) => git(cmd, raw(text));
  for (const text of ['{ not json', '', '{"scripts": {"deploy": "echo hi",}}', '{"scripts": {"deploy": "echo hi"}} trailing', "{'scripts': {}}"]) {
    const r = g('npm run deploy', text);
    assert.equal(r.decision, 'deny', JSON.stringify(text));
    assert.match(r.reason, /package\.json/);
    assert.equal(filesGuard('npm run deploy', raw(text)).decision, 'deny');
  }
  assert.equal(g('npm run deploy', `﻿{"scripts": {"deploy": "${BAD_GIT}"}}`).decision, 'deny', 'a BOM does not hide the script');
  assert.equal(g('npm run deploy', `{"scripts": {"deploy": "echo hi", "deploy": "${BAD_GIT}"}}`).decision, 'deny', 'the last duplicate wins');
  assert.equal(g('npm run deploy', `{"scripts": {"deploy": "${BAD_GIT}", "deploy": "echo hi"}}`).decision, 'allow', 'the last duplicate wins');
  assert.equal(g('npm run deploy', `{"scripts": {"deploy": "echo hi"}, "scripts": {"deploy": "${BAD_GIT}"}}`).decision, 'deny');
  // a command that runs nothing does not read it
  assert.equal(g('npm --version', '{ not json').decision, 'allow');
  assert.equal(g('npm ls', '{ not json').decision, 'allow');
});
test('t9 configuration files that change the shell, the prefix or the node options make the scripts unknown', () => {
  const t = { 'package.json': { scripts: { lint: 'ok' } } };
  for (const rc of ['script-shell=/e/sh', 'script_shell = /e/sh', 'node-options=--require /e/x.js', 'workspaces=true', 'workspace=a', 'onload-script=/e/x.js', '; comment\nregistry=https://r.example\nscript-shell=/e/sh']) {
    for (const where of ['.npmrc', '/home/u/.npmrc', '/etc/npmrc']) {
      const tree = { ...t, [where]: rc };
      const r = git('npm run lint', treeFor(tree, BAD_GIT));
      assert.equal(r.decision, 'deny', `${where}: ${rc}`);
      assert.match(r.reason, /npmrc/);
      assert.equal(filesGuard('npm run lint', treeFor(tree, BAD_FILES)).decision, 'deny', `files ${where}: ${rc}`);
    }
  }
  for (const cmd of ['npm install', 'pnpm lint', 'npm test']) assert.equal(git(cmd, treeFor({ ...t, '.npmrc': 'script-shell=/e/sh' }, BAD_GIT)).decision, 'deny', cmd);
  ok('npm run lint', { ...t, '.npmrc': '# registry\nregistry=https://r.example\nsave-exact=true\n' });
  assert.equal(git('npm run lint', treeFor({ ...t, '.npmrc': null }, BAD_GIT)).decision, 'deny', 'an unreadable .npmrc');
  assert.equal(git('yarn lint', treeFor({ ...t, '.yarnrc.yml': 'yarnPath: .yarn/releases/x.cjs\n' }, BAD_GIT)).decision, 'deny');
  assert.equal(git('yarn lint', treeFor({ ...t, '.yarnrc.yml': 'nodeLinker: node-modules\n' }, BAD_GIT)).decision, 'allow');
  assert.equal(git('bun run lint', treeFor({ ...t, 'bunfig.toml': '[run]\nshell = "bun"\n' }, BAD_GIT)).decision, 'deny');
  // the configuration is only read when a script runs
  assert.equal(git('npm ls', treeFor({ ...t, '.npmrc': 'script-shell=/e/sh' }, BAD_GIT)).decision, 'allow');
  // a prefix in an npmrc moves the GLOBAL packages only (npm reads the project from the command line's --prefix alone)
  ok('npm run lint', { ...t, '/home/u/.npmrc': 'prefix=/e/global\n', '.npmrc': 'prefix=/e/global' });
});
test('t9 options are parsed as npm does: positionals reach the script, abbreviations and unknown options before a word refuse', () => {
  const t = root({ shipit: 'bad', lint: 'ok' });
  const gt = treeFor({ 'package.json': { scripts: { shipit: 'git ' + PUSH, lint: 'ok' } } }, '');
  assert.equal(git(`npm run shipit origin ${MAIN}`, gt).decision, 'deny', 'positionals are appended without --');
  assert.equal(git(`npm run shipit --if-present origin ${MAIN}`, gt).decision, 'deny');
  assert.equal(git(`npm run --silent shipit -- origin ${MAIN}`, gt).decision, 'deny');
  assert.equal(git('npm run shipit --if-present', gt).decision, 'allow');
  for (const cmd of ['npm --loglevel silent run shipit', 'npm --loglevel=silent run shipit', 'npm -- run shipit', 'npm run -- shipit', 'npm -s run -- shipit', 'npm run shipit --loglevel silent', 'npm -ddd run shipit', 'npm --silent --no-color run shipit', 'npm run shipit --workspace=.']) bad(cmd, t);
  for (const cmd of ['npm --foo bar run lint', 'npm --pref x run lint', 'npm --wor a run lint', 'npm run lint --foo bar', 'npm run lint --pref x', 'npm -Z run lint']) {
    const r = git(cmd, treeFor(root({ lint: 'ok' }), BAD_GIT));
    assert.equal(r.decision, 'deny', cmd);
    assert.match(r.reason, /not known|may take the next word/);
    assert.equal(filesGuard(cmd, treeFor(root({ lint: 'ok' }), BAD_FILES)).decision, 'deny', `files: ${cmd}`);
  }
  for (const cmd of ['npm run lint --foo', 'npm run lint --foo=bar', 'npm run lint -- --foo bar', 'npm --foo=bar run lint', 'npm run lint -ddd', 'npm run lint --json']) ok(cmd, root({ lint: 'ok' }));
  // pnpm -w is the workspace root, not a value option
  bad('pnpm -w run deploy', root({ deploy: 'bad' }));
  bad('pnpm -w deploy', root({ deploy: 'bad' }));
});
test('t9 exec forms the parser did not unwrap are judged as a command line; a bare yarn / pnpm / bun name falls back to node_modules/.bin', () => {
  assert.equal(git(`pnpm -r exec ${BAD_GIT}`, {}).decision, 'deny');
  assert.equal(git(`pnpm --filter a exec ${BAD_GIT}`, {}).decision, 'deny');
  assert.equal(git(`npm --silent exec -c '${BAD_GIT}'`, {}).decision, 'deny');
  assert.equal(filesGuard(`pnpm -r exec ${BAD_FILES}`, {}).decision, 'deny');
  assert.equal(git('pnpm -r exec prettier --check .', {}).decision, 'allow');
  const bin = { 'node_modules/.bin/tool': `#!/bin/sh\n${BAD_GIT}\n`, 'package.json': { scripts: { lint: 'ok' } } };
  for (const cmd of ['yarn tool', 'pnpm tool', 'bun run tool', 'yarn run tool']) assert.equal(git(cmd, treeFor(bin, BAD_GIT)).decision, 'deny', cmd);
  assert.equal(git('yarn lint', treeFor(bin, BAD_GIT)).decision, 'allow');
  assert.equal(git('yarn other', treeFor(bin, BAD_GIT)).decision, 'allow');
});

// ---- second security review: what the line changes first, symlinks, parity ----------------------------------------------------------------------------------------
import { packageScripts, pmCall } from '../pipeline/hooks/lib/package-scripts.mjs';
test('t9 an earlier command that may change package.json, a configuration file or the work tree makes the script unknown (both guards)', () => {
  const t = root({ lint: 'ok', test: 'ok' });
  const befores = ['git checkout other', 'git pull', 'git merge x', 'git switch -c y', 'git reset --hard', 'git stash pop', 'git rebase main', 'git cherry-pick abc', 'git apply p.diff', 'git clone u d', 'git -C sub checkout x',
    'npm pkg set scripts.lint=x', 'npm set-script lint x', 'npm init -y', 'pnpm pkg set a=b', 'yarn config set x y', 'npm config set script-shell /bin/x', 'npm config delete prefix', 'tar xf a.tgz', 'unzip a.zip', 'patch -p1 -i p.diff', 'rsync -a src/ .'];
  for (const b of befores) {
    for (const sep of ['&&', ';']) {
      const cmd = `${b} ${sep} npm run lint`;
      const g = git(cmd, treeFor(t, BAD_GIT));
      assert.equal(g.decision, 'deny', `git: ${cmd}`);
      assert.match(g.reason, /package script: an earlier command/);
      assert.equal(filesGuard(cmd, treeFor(t, BAD_FILES)).decision, 'deny', `files: ${cmd}`);
    }
  }
  // (t11: `git worktree add ../w` creates one directory elsewhere: it changes nothing a manager started here reads, and one started in w is refused -- test/guard-replay-fp-81.test.mjs)
  // a background job races the command: the order on the line does not matter
  for (const cmd of ['npm run lint & git checkout x', 'git pull & npm test', '(git checkout x &) ; npm run lint']) {
    assert.equal(git(cmd, treeFor(t, BAD_GIT)).decision, 'deny', `git: ${cmd}`);
    assert.equal(filesGuard(cmd, treeFor(t, BAD_FILES)).decision, 'deny', `files: ${cmd}`);
  }
  // a script the line runs changes it before the next command too
  bad('npm run a && npm run lint', { 'package.json': { scripts: { a: 'git checkout x', lint: 'ok' } } });
  bad('npm run a', { 'package.json': { scripts: { a: 'git checkout x && npm run lint', lint: 'ok' } } });
  // commands that change nothing it reads
  for (const cmd of ['git status && npm run lint', 'git log -3; npm test', 'git fetch && npm run lint', 'git diff | head; npm run lint', 'npm config get prefix; npm run lint', 'echo hi > notes.txt && npm run lint', 'npm ls && npm test', 'npm install && npm test', 'npm ci && npm run lint']) ok(cmd, t);
});
test('t9 an install earlier on the line may add a bin: refused when the line mentions a guarded operation', () => {
  const t = treeFor(root({ lint: 'ok' }), BAD_GIT);
  assert.equal(git('npm ci && npx tool', t).decision, 'allow');
  assert.equal(git(`npm ci && npx tool; echo ${PUSH}`, t).decision, 'deny');
  assert.equal(git(`npx tool; echo ${PUSH}`, t).decision, 'allow', 'no install before: the bin is simply not there');
});
test('t9 a configuration file or a bin the line writes first is judged or refused', () => {
  const t = root({ lint: 'ok' });
  for (const cmd of [`echo 'script-shell=/e/sh' > .npmrc && npm run lint`, `printf 'node-options=--require /e/x.js' >> .npmrc; npm test`, `cp /tmp/rc .npmrc && npm run lint`]) {
    const g = git(cmd, treeFor(t, BAD_GIT));
    assert.equal(g.decision, 'deny', `git: ${cmd}`);
    assert.match(g.reason, /writes .*npmrc/);
    assert.equal(filesGuard(cmd, treeFor(t, BAD_FILES)).decision, 'deny', `files: ${cmd}`);
  }
  const written = git(`printf '#!/bin/sh\\n${BAD_GIT}\\n' > node_modules/.bin/tool && chmod +x node_modules/.bin/tool && npx tool`, treeFor(t, BAD_GIT));
  assert.equal(written.decision, 'deny');
});
test('t9 a package.json that is a dangling link or a link loop is unreadable, not missing', () => {
  const call = pmCall(['npm', 'run', 'lint']);
  const env = (o) => ({ cwd: '/w/p', home: '/home/u', readText: () => null, pathExists: () => false, readDir: () => null, lexists: (f) => f === '/w/p/package.json', p: undefined, ...o });
  const r = packageScripts(call, env());
  assert.match(r.refuse ?? '', /cannot read \/w\/p\/package\.json/);
  assert.deepEqual(packageScripts(call, env({ lexists: () => false })), { none: true }, 'nothing there at all');
  // a rc file that is a link loop
  const rc = packageScripts(call, env({ lexists: (f) => f === '/w/p/.npmrc', pathExists: (f) => f === '/w/p/package.json', readText: (f) => (f === '/w/p/package.json' ? '{"scripts":{"lint":"echo"}}' : null) }));
  assert.match(rc.refuse ?? '', /cannot read \/w\/p\/\.npmrc/);
});
test('t9 both guards open the shell-script bins a runner or yarn / pnpm / bun runs; a bin in another language is left alone', () => {
  const f = (cmd, tree) => filesGuard(cmd, treeFor(tree, BAD_FILES));
  const shell = { 'node_modules/.bin/tool': `#!/bin/sh\n${BAD_FILES}\n`, 'package.json': { scripts: { lint: 'ok' } } };
  for (const cmd of ['npx tool', 'npm exec tool', 'pnpm exec tool', 'yarn tool', 'pnpm tool', 'bun run tool', 'yarn run tool']) assert.equal(f(cmd, shell).decision, 'deny', `files: ${cmd}`);
  assert.equal(f('yarn lint', shell).decision, 'allow');
  assert.equal(f('npx other', shell).decision, 'allow');
  assert.equal(f('npx js', { ...shell, 'node_modules/.bin/js': `#!/usr/bin/env node\n${BAD_FILES}\n` }).decision, 'allow', 'a program in another language in node_modules is not ours to judge');
});

// ---- control parity: nothing main refused is allowed now (probed against 9b0b862 on 122 lines; these are the shapes that write a protected path or push straight from a package-manager line) ----------------
test('t9 a package-manager line that writes a protected path or pushes directly stays refused, with or without a package.json', () => {
  const T = `~/${CL}/settings.json`;
  const D = `~/${CL}`;
  const filesLines = [`npx foo > ${T}`, `npx prettier . > ${T}`, `npm exec -- cp a ${T}`, `npm exec cp a ${T}`, `npx cp a ${T}`, `npx -c 'cp a ${T}'`, `npm pkg set a=b --prefix ${D}`, `npm install --prefix ${D}`, `cd ${D} && npm init -y`,
    `npm run x > ${T}`, `npm test > ${T}`, `npm ls > ${T}`, `npm --version > ${T}`, `npm run > ${T}`, `pnpm run x > ${T}`, `yarn x > ${T}`, `bun run x > ${T}`, `pnpm exec cp a ${T}`, `pnpm dlx cp a ${T}`, `yarn dlx cp a ${T}`, `bunx cp a ${T}`,
    `npm run x -- ${T}`, `npm run x --prefix ${D}`, `npm --prefix ${D} run x`, `npm cache clean --cache ${D}`, `npm run x 2> ${T}`, `env npm run x > ${T}`, `corepack npm run x > ${T}`, `npm run x | tee ${T}`, `npx x; cp a ${T}`, `npm run x && cp a ${T}`,
    `tee ${T} < <(npm ls)`, `cd ${D}; npm run x`, `cd ${D}/skills && npm test`];
  const gitLines = [`npm run x && ${BAD_GIT}`, `npm run x; ${BAD_GIT}`, `npx foo && ${BAD_GIT}`, `npm exec -- ${BAD_GIT}`, `npx ${BAD_GIT}`, `pnpm exec ${BAD_GIT}`, `yarn dlx ${BAD_GIT}`, `pnpm -r exec ${BAD_GIT}`, `npm_config_prefix=/e npm run x; ${BAD_GIT}`];
  for (const tree of [{}, { 'package.json': pkg({ x: 'echo hi', lint: 'echo lint' }) }]) {
    for (const cmd of filesLines) assert.equal(filesGuard(cmd, tree).decision, 'deny', `files: ${cmd}`);
    for (const cmd of gitLines) assert.equal(git(cmd, tree).decision, 'deny', `git: ${cmd}`);
  }
});
