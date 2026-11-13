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
