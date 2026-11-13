// Why (#352): `false && <dir>/serve.sh`, a zsh script ending in `exec npm start` (start = `next start`), was refused: "the script .../node_modules/.bin/next would run:
// the script ~/.zshenv is built from pieces". node_modules/.bin/next is a `#!/usr/bin/env node` program; binIsProgram turns away from "program" a shebang whose interpreter path lies INSIDE the
// project (the project may supply it). The guard also judges the bin as run from every directory the line may be in, and when that directory is the file system root, every path (/usr/bin/env too) is
// "inside" it, so the program was opened as a shell script and its JavaScript read as shell (every `=>` and `>=` a redirection), which pulled in the zsh startup file judgment.
// Rule held here: the file system root is never "the project" for a shebang path unless it is the only root there is (a bin that really lives under /). A shebang that names a file inside the real project is still opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { binIsProgram, binSite } from '../pipeline/hooks/lib/package-scripts.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
const BAD = { git: `git ${PUSH} origin ${MAIN}`, files: `cp a ~/${CL}/settings.json` };

function fakeFs(root, files) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u'].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
const run = (guard, cmd, files, o = {}) => {
  const root = guard === 'git' ? GIT_ROOT : PROJ;
  const fs = fakeFs(root, files);
  const cwd = resolve(root);
  return guard === 'git'
    ? evaluateGitCommand(cmd, { cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fs, ...o })
    : evaluateBashForFiles(cmd, { home: '/home/u', env: {}, platform: PLATFORM, realpath: (p) => p, cwd, ...fs, existsSync: fs.pathExists, ...o });
};
const GUARDS = ['git', 'files'];

// the shapes of next's own text that read as shell redirections: `>=` inside a string, arrow functions, a template literal
const NEXT_JS = () => `#!/usr/bin/env node
"use strict";
if (!_semver.default.satisfies(process.versions.node, "^18.18.0 || ^19.8.0 || >= 20.0.0", {
    includePrerelease: true
})) {
    console.error(\`You are using Node.js \${process.versions.node}. Node.js version "\${"^18.18.0 || >= 20.0.0"}" is required.\`);
    process.exit(1);
}
program.hook('preAction', (event)=>{ return event; });
program.configureHelp({ formatHelp: (cmd, helper)=>(0, _x.format)(cmd, helper), subcommandTerm: (cmd)=>\`\${cmd.name()} \${cmd.usage()}\` });
program.command('start').action((options, directory)=>import('../cli/next-start.js').then((mod)=>mod.nextStart(options, directory)));
`;
// serve.sh as the real one is shaped: a zsh script that moves to the parent of its own directory and runs the package's start script
const SERVE = '#!/bin/zsh\n# starts the app\nexport PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"\ncd "${0:A:h:h}" || exit 1\nprint "starting $(date \'+%F\')"\nexec npm start\n';
const project = (guard, scripts, bin) => ({
  'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts }),
  'scripts/serve.sh': SERVE,
  'node_modules/next/dist/bin/next': bin(guard),
  'node_modules/.bin/next': bin(guard),
});
const decide = (guard, cmd, scripts, bin) => run(guard, cmd, project(guard, scripts, bin)).decision;

test('binSite: the file system root is not the project for a shebang path, unless it is the only root there is', () => {
  const run0 = binSite('/home/u/proj/node_modules/.bin/next', '/', () => false, path.posix);
  assert.equal(run0.inside('/usr/bin/env'), false, 'a run directory of / does not make /usr/bin/env part of the project');
  assert.equal(run0.inside('/home/u/proj/vendor/node'), true, 'the bin\'s own package directory still is');
  const atRoot = binSite('/node_modules/.bin/next', '/', () => false, path.posix);
  assert.equal(atRoot.inside('/usr/bin/env'), true, 'a project that really lives at / keeps the strict reading');
  assert.equal(binIsProgram('#!/usr/bin/env node\n', run0), true, 'env node is a program from a run directory of /');
  assert.equal(binIsProgram('#!/usr/bin/env node\n', atRoot), false, 'and still opened for a project at /');
});

test('#352: `false && serve.sh` (exec npm start -> next start, next a node program) is allowed by both guards', () => {
  for (const scripts of [{ start: 'next start' }, { start: 'NODE_OPTIONS=--max-old-space-size=2048 next start -p 4317 -H 127.0.0.1' }, { build: 'next build' }]) {
    const script = Object.keys(scripts)[0];
    const sh = SERVE.replace('npm start', `npm run ${script}`);
    for (const g of GUARDS) {
      const files = { ...project(g, scripts, NEXT_JS), 'scripts/serve.sh': sh };
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const r = run(g, `false && ${root}/scripts/serve.sh`, files);
      assert.equal(r.decision, 'allow', `${g} ${JSON.stringify(scripts)}: ${r.reason}`);
    }
  }
});

test('#352 negative controls: a shell script in .bin/next, or a script that writes the zsh startup file in pieces, is still refused', () => {
  const sh = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  for (const g of GUARDS) {
    const r = run(g, `npm start`, project(g, { start: 'next start' }, sh));
    assert.equal(r.decision, 'deny', `${g} shell bin: ${r.reason}`);
  }
  // a line that puts ~/.zshenv together from pieces (one of them unknown) before the zsh script runs it
  const files = { ...project('files', { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': '#!/bin/zsh\nexec npm start\n' };
  for (const cmd of [`printf 'a' > ~/.zshenv; printf "$(cat /x)" >> ~/.zshenv; ${PROJ}/scripts/serve.sh`, `printf 'a' > ~/.zshenv; printf "$X" >> ~/.zshenv; zsh ${PROJ}/scripts/serve.sh`]) {
    const r = run('files', cmd, files);
    assert.equal(r.decision, 'deny', `zshenv in pieces: ${cmd} -> ${r.reason}`);
  }
});

test('#352 negative control: a node program that names a protected path in a write is still refused', () => {
  const prog = () => `#!/usr/bin/env node\nrequire('fs').writeFileSync(require('os').homedir() + '/${CL}/settings.json', 'x');\n`;
  const files = { ...project('files', { start: 'next start' }, NEXT_JS), 'tools/prog.mjs': prog() };
  const r = run('files', `${PROJ}/tools/prog.mjs`, files);
  assert.equal(r.decision, 'deny', r.reason);
  assert.equal(run('files', `${PROJ}/scripts/serve.sh`, { ...files, 'scripts/serve.sh': `#!/bin/sh\nexec ${PROJ}/tools/prog.mjs\n` }).decision, 'deny', 'through a script as well');
});

// Why (#352 follow-up): a zsh script that cd's to "${0:A:h:h}" left the git guard without a directory, and `exec npm start` after it was judged only when the line mentioned a guarded operation, so a package script
// running a bin that pushes was allowed (`false && serve.sh`). In a script file the lost directory is judged as the script's own directory and each one above it, as the files guard resolves $0 itself.
test('#352 follow-up: a cd to the script\'s own parent does not hide the package script (bin that pushes / writes a protected file)', () => {
  const cds = ['cd "${0:A:h:h}" || exit 1', 'cd "${0:h:h}" || exit 1', 'cd "$(dirname "$0")/.." || exit 1', 'cd "$SOME_DIR" || exit 1'];
  const bad = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  for (const cd of cds) {
    for (const g of GUARDS) {
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const files = { ...project(g, { start: 'evil' }, bad), 'node_modules/.bin/evil': bad(g), 'scripts/serve.sh': `#!/bin/zsh\n${cd}\nexec npm start\n` };
      delete files['node_modules/.bin/next'];
      delete files['node_modules/next/dist/bin/next'];
      for (const line of [`false && ${root}/scripts/serve.sh`, `${root}/scripts/serve.sh`]) {
        const r = run(g, line, files);
        assert.equal(r.decision, 'deny', `${g}: ${cd}: ${line} -> ${r.reason}`);
      }
    }
  }
});

test('#352 follow-up: the clean next chain behind the same cd is still allowed by both guards', () => {
  for (const cd of ['cd "${0:A:h:h}" || exit 1', 'cd "$(dirname "$0")/.." || exit 1']) {
    for (const g of GUARDS) {
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const files = { ...project(g, { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': `#!/bin/zsh\n${cd}\nexec npm start\n` };
      const r = run(g, `false && ${root}/scripts/serve.sh`, files);
      assert.equal(r.decision, 'allow', `${g}: ${cd} -> ${r.reason}`);
    }
  }
});

// Why (#352 follow-up 2): the same lost directory hid a bin run by a package runner (`exec npx evil` after the cd): the runner's bin lookup got no directory at all.
const RUNNERS = ['npx evil', 'npm exec evil', 'pnpm exec evil', 'yarn exec evil', 'bunx evil'];
const RUNNERS_CLEAN = ['npx next start', 'npm exec next', 'pnpm exec next start'];
test('#352 follow-up: a runner run after a cd to the script\'s parent still reaches the bin (pushes / writes a protected file)', () => {
  const bad = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  for (const tail of RUNNERS) {
    for (const cd of ['cd "${0:A:h:h}" || exit 1', 'cd "$(dirname "$0")/.." || exit 1']) {
      for (const g of GUARDS) {
        const root = g === 'git' ? GIT_ROOT : PROJ;
        const files = { ...project(g, { start: 'evil' }, bad), 'node_modules/.bin/evil': bad(g), 'scripts/serve.sh': `#!/bin/zsh\n${cd}\nexec ${tail}\n` };
        const r = run(g, `${root}/scripts/serve.sh`, files);
        assert.equal(r.decision, 'deny', `${g}: ${cd}; exec ${tail} -> ${r.reason}`);
      }
    }
  }
});

test('#352 follow-up: the clean runner chain (npx next start, npm exec next) behind the same cd is still allowed by both guards', () => {
  for (const tail of RUNNERS_CLEAN) {
    for (const g of GUARDS) {
      const root = g === 'git' ? GIT_ROOT : PROJ;
      const files = { ...project(g, { start: 'next start' }, NEXT_JS), 'scripts/serve.sh': `#!/bin/zsh\ncd "\${0:A:h:h}" || exit 1\nexec ${tail}\n` };
      const r = run(g, `false && ${root}/scripts/serve.sh`, files);
      assert.equal(r.decision, 'allow', `${g}: exec ${tail} -> ${r.reason}`);
    }
  }
});

// Why (#352 R1-B2): binSite dropped the bin's OWN package root when that is `/` (a bin /node_modules/.bin/tool run from /sub), so a shebang `#!/vendor/node` was not "inside the project" and the program was not opened.
// Only a guessed run directory that is `/` is dropped; the package root of the bin is always kept.
test('#352 R1-B2: binSite keeps the bin\'s own package root when it is /, run from a subdirectory', () => {
  const s = binSite('/node_modules/.bin/tool', '/sub', () => false, path.posix);
  assert.equal(s.inside('/vendor/node'), true, 'a path under the bin\'s package root (/) is inside the project');
  const t = binSite('/home/u/proj/node_modules/.bin/tool', '/', () => false, path.posix);
  assert.equal(t.inside('/vendor/node'), false, 'a guessed run directory of / is still dropped');
});

test('#352 R1-B2: a root-level bin run from a subdirectory whose shebang names a program in the project is opened by both guards', () => {
  for (const g of GUARDS) {
    const root = '/sub';
    const files = { '/sub/package.json': '{}', '/node_modules/.bin/tool': '#!/vendor/node\necho ok\n', '/vendor/node': `#!/bin/sh\n${BAD[g]}\n` };
    const fs = fakeFs(root, files);
    const cwd = resolve(root);
    const o = { home: '/home/u', realpath: (p) => p, cwd, ...fs };
    const r = g === 'git'
      ? evaluateGitCommand('npx tool', { currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...o })
      : evaluateBashForFiles('npx tool', { env: {}, platform: PLATFORM, existsSync: fs.pathExists, ...o });
    assert.equal(r.decision, 'deny', `${g}: ${r.reason}`);
  }
});

// Why (#352 R1-B1): the per-ancestor package-script probes shared branch state, so a `git switch` in a script that may never run was kept as the certain branch and a later bare push was judged against it.
const PUSH_BARE = 'git ' + PUSH;
test('#352 R1-B1: a branch switched in a package script that may not run (lost cd) does not make a later push look safe', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'git switch agent/safe' } }),
    'scripts/start.sh': '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm start\n',
    'release.sh': `#!/bin/bash\n${PUSH_BARE}\n`,
  };
  const r = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, files, { currentBranch: () => MAIN });
  assert.equal(r.decision, 'deny', r.reason);
  // an alias defined by the speculative script is just as uncertain
  const al = { ...files, 'package.json': JSON.stringify({ name: 'x', scripts: { start: 'git config alias.ship "' + PUSH + ' origin agent/x"' } }), 'release.sh': `#!/bin/bash\ngit ship\n` };
  const r2 = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, al, { currentBranch: () => MAIN });
  assert.equal(r2.decision, 'deny', 'alias: ' + r2.reason);
});

test('#352 R1-B1 control: the same switch run in a directory that is known (no lost cd) is still the certain branch', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'git switch agent/safe' } }),
    'scripts/start.sh': '#!/bin/bash\nnpm start\n',
    'release.sh': `#!/bin/bash\n${PUSH_BARE}\n`,
  };
  const r = run('git', `bash ${GIT_ROOT}/scripts/start.sh; bash ${GIT_ROOT}/release.sh`, files, { currentBranch: () => MAIN });
  assert.equal(r.decision, 'allow', r.reason);
});

// Why (#352 R1-F1): selfDirs walked the script path as named; a link to the script (`cd "${0:A:h:h}"` resolves it) was not covered.
test('#352 R1-F1: a script run through a link in another directory is refused like the real path', () => {
  const bad = (g) => `#!/bin/sh\n${BAD[g]}\n`;
  const files = { ...project('git', { start: 'evil' }, bad), 'node_modules/.bin/evil': bad('git'), 'scripts/serve.sh': '#!/bin/zsh\ncd "${0:A:h:h}" || exit 1\nexec npm start\n', '/home/u/bin/serve': '#!/bin/zsh\ncd "${0:A:h:h}" || exit 1\nexec npm start\n' };
  const linkReal = (p) => (p === '/home/u/bin/serve' ? `${GIT_ROOT}/scripts/serve.sh` : p);
  assert.equal(run('git', `${GIT_ROOT}/scripts/serve.sh`, files).decision, 'deny', 'real path');
  const r = run('git', '/home/u/bin/serve', files, { realpath: linkReal });
  assert.equal(r.decision, 'deny', r.reason);
});

// Why (#352 R1-F2): the same package.json reached from several ancestors was judged once per ancestor, spending the script allowance.
test('#352 R1-F2: a package.json reached from many ancestor directories is judged once', () => {
  const dirs = Array.from({ length: 12 }, (_, i) => `d${i}`).join('/');
  const names = Array.from({ length: 12 }, (_, i) => `b${i}`);
  const scripts = { start: names.map((n) => `cd "$SOME_DIR" && npm run ${n}`).join('; '), ...Object.fromEntries(names.map((n) => [n, 'echo built'])) };
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts }),
    [`${dirs}/serve.sh`]: '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm start\n',
  };
  const r = run('git', `${GIT_ROOT}/${dirs}/serve.sh`, files);
  assert.equal(r.decision, 'allow', r.reason);
});

// Why (#352 R2-B1): an inner judgeAlternatives restored the alias map and kept the change only in aliasUnsure; the outer one then reset aliasUnsure to its own start, so the uncertainty was lost.
test('#352 R2-B1: an alias defined by a script nested in a speculative script is still unsure afterwards', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'cd "$SOME_DIR" || exit 1; npm run setup', setup: 'git config alias.ship "' + PUSH + ' origin ' + MAIN + '"' } }),
    'start.sh': '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm start\n',
    'release.sh': '#!/bin/bash\ngit ship\n',
  };
  const r = run('git', `bash ${GIT_ROOT}/start.sh; bash ${GIT_ROOT}/release.sh`, files);
  assert.equal(r.decision, 'deny', r.reason);
});

// Why (#352 R2-F1): runs of one workspace plan share state (an alias, a config change), and the plan's ORDER depends on the candidate directory; skipping a run already judged for another directory
// skipped the order npm really uses (a, then b), so `git ship main` was never judged after the alias existed.
test('#352 R2-F1: a workspace plan whose order differs by candidate directory is judged in every order', () => {
  const mk = (a, b) => ({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['pkgs/a', 'pkgs/b'] }),
    'pkgs/a/package.json': JSON.stringify({ name: 'a', scripts: { go: a } }),
    'pkgs/b/package.json': JSON.stringify({ name: 'b', scripts: { go: b } }),
    'pkgs/b/run.sh': '#!/bin/bash\ncd "$SOME_DIR" || exit 1\nnpm run go --workspaces\n',
  });
  const line = `bash ${GIT_ROOT}/pkgs/b/run.sh`;
  const cfg = run('git', line, mk('git config push.default upstream', PUSH_BARE)); // (on a feature branch a bare push is unsafe only once push.default may point it at main)
  assert.equal(cfg.decision, 'deny', 'push.default: ' + cfg.reason);
  const al = run('git', line, mk('git config alias.ship "' + PUSH + ' origin"', `git ship ${MAIN}`), { currentBranch: () => MAIN });
  assert.equal(al.decision, 'deny', 'alias: ' + al.reason);
});
