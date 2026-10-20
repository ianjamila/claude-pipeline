// Why (#89 t2 follow-up): a node_modules/.bin file is opened as a shell script or left alone, and the choice used to follow the FILE NAME (.js / .mjs / .cjs, also behind a link) next to the shebang. That is a
// parser differential: the kernel starts the interpreter named by a `#!` line and nothing else, and a file with NO shebang fails execve (ENOEXEC) and is run by `sh` (npm / npx spawn bins through the script shell).
// So `npx nsbin` (a .js file without a shebang, holding a guarded command) was allowed while sh would run it. The rule these tests hold, for both guards:
//   decide ONLY by the first bytes: a shebang naming anything but a known interpreter (a shell, awk, make, pwsh, busybox, an unknown name; env [-S] <name>), no shebang, or a file that cannot be read -> opened as a shell script (or refused);
//   a shebang naming node, nodejs, bun, deno, tsx, ts-node, python, python2, python3[.N], ruby, perl or php (an ALLOWLIST) or binary content (ELF / Mach-O magic, a NUL in the first 512 bytes) -> a program, judged only on a known write that replaces it.
// And a package script that calls a bin by bare name (`"x": "shbin"`, `npm run x`) opens node_modules/.bin/shbin: the managers put every node_modules/.bin from the package's directory upward on the PATH of
// a script's commands (as `npx` and the runner lookups already resolve through localBin). A name with no bin there is an ordinary command.
// Every loosening or tightening has its malicious twin (the same shape with a guarded bin). Guarded words are spelled in pieces: the live guard scans files passed to node tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { binIsProgram } from '../pipeline/hooks/lib/package-scripts.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
// the platform the guard is told: these fixtures spell their paths with the host's node:path (resolve), and on Windows `D:\...` is a path only for platform 'win32'
const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
// what a guarded command is per guard, and a string that only MENTIONS one (JavaScript text that holds the words, never runs them)
const BAD = { git: `git ${PUSH} origin ${MAIN}`, files: `cp a ~/${CL}/settings.json` };
const WORDS = { git: `const s = 'git ${PUSH} origin ${MAIN}';\nconsole.log(s);\n`, files: `const s = 'cp a ~/${CL}/settings.json';\nconsole.log(s);\n` };

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
// the project as each guard sees it: `pkgDir` is the package directory (where package.json and the command run), the bins live under the project root
const run = (guard, cmd, files, { pkgDir = '', ...o } = {}) => {
  const root = guard === 'git' ? GIT_ROOT : PROJ;
  const fs = fakeFs(root, files);
  const cwd = resolve(root, pkgDir);
  return guard === 'git'
    ? evaluateGitCommand(cmd, { cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fs, ...o })
    : evaluateBashForFiles(cmd, { home: '/home/u', env: {}, platform: PLATFORM, realpath: (p) => p, cwd, ...fs, existsSync: fs.pathExists, ...o });
};
const GUARDS = ['git', 'files'];
// `bins`: name -> (guard) => file text (null = exists but cannot be read); scripts: package.json scripts
const project = (guard, bins, scripts = {}, at = '') => {
  const files = { [`${at}package.json`]: JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'echo ok', ...scripts } }) };
  for (const [n, t] of Object.entries(bins)) files[`node_modules/.bin/${n}`] = typeof t === 'function' ? t(guard) : t;
  return files;
};
const decide = (cmd, bins, scripts, o = {}) => Object.fromEntries(GUARDS.map((g) => [g, run(g, cmd, project(g, bins, scripts, o.pkgDir ? `${o.pkgDir}/` : ''), typeof o.opts === 'function' ? o.opts(g) : { pkgDir: o.pkgDir }).decision]));
const denied = (cmd, bins, scripts, o) => { const r = decide(cmd, bins, scripts, o); for (const g of GUARDS) assert.equal(r[g], 'deny', `${g}: ${cmd} -> ${r[g]}`); };
const allowed = (cmd, bins, scripts, o) => { const r = decide(cmd, bins, scripts, o); for (const g of GUARDS) assert.equal(r[g], 'allow', `${g}: ${cmd} -> ${r[g]}`); };

const SH = (g) => `#!/bin/sh\n${BAD[g]}\n`;
const NO_SHEBANG = (g) => `${BAD[g]}\n`;
const NODE_WORDS = (g) => `#!/usr/bin/env node\n${WORDS[g]}`;
const ELF = (g) => `\u007fELF\u0002\u0001\u0001\u0000\u0000\u0000${BAD[g]}\u0000`;
const NUL_BYTES = (g) => `MZ\u0000\u0000${BAD[g]}`;

test('the first bytes decide (binIsProgram): shells and no shebang open the file, any other interpreter and binary content do not', () => {
  for (const t of ['#!/bin/sh\n', '#!/bin/bash -e\n', '#! /usr/bin/dash\n', '#!/usr/bin/env zsh\n', '#!/usr/bin/env -S bash -e\n', '#!/usr/bin/env -Sbash -e\n', '#!/usr/bin/env -i FOO=1 sh\n', '#!/bin/busybox sh\n', '#!/bin/ksh93\n', '#!/usr/bin/awk -f\n', '#!/bin/busybox awk -f\n', '#!/usr/bin/env pwsh\n', '#!/usr/bin/make -f\n', '#!/usr/bin/env -S unknownlang --x\n', '#!/usr/bin/env -i FOO=1 awk -f\n', '#!/bin/bash5\n', '#!\n', '#!/usr/bin/env\n', 'echo hi\n', '', '\n#!/usr/bin/env node\n', ' #!/usr/bin/env node\n', 'import "./x.js"\n', '#!/bin/sh\r\ngit x\r\n']) {
    assert.equal(binIsProgram(t), false, JSON.stringify(t));
  }
  for (const t of ['#!/usr/bin/env node\n', '#!/usr/bin/node\n', '#!/usr/bin/env -S node --no-warnings\n', '#!/usr/bin/env -Snode --no-warnings\n', '#!/usr/bin/env --split-string=node -r x\n', '#!/usr/bin/env bun\n', '#!/usr/bin/env deno run\n', '#!/usr/bin/python3\n', '#!/usr/bin/env -S -u X python\n', '#!/usr/bin/python3.11\n', '#!/usr/bin/env ruby\n', '#!/usr/bin/perl -w\n', '#!/usr/bin/env php\n', '#!/usr/bin/env tsx\n', '#!/usr/bin/env ts-node\n', '#!/usr/bin/env nodejs\n', '\u007fELF\u0002\u0001', 'abc\u0000def', '����\u0007\u0000']) {
    assert.equal(binIsProgram(t), true, JSON.stringify(t));
  }
  assert.equal(binIsProgram('x'.repeat(600) + '\u0000'), false, 'a NUL after the first 512 bytes is not the binary test');
});

test('npx of a bin without a shebang is run by sh: opened, whatever the name or the link target (the .js extension is never a reason)', () => {
  denied('npx nsbin', { nsbin: NO_SHEBANG });
  denied('npx nsbin run', { nsbin: NO_SHEBANG });
  denied('pnpm exec nsbin', { nsbin: NO_SHEBANG });
  denied('npx shbin', { shbin: SH });
  // a link to a .js file: only the file's own bytes count
  for (const g of GUARDS) {
    const realpath = (p) => p.replace(/node_modules\/\.bin\/nsbin$/, 'node_modules/pkg/noshebang.js');
    assert.equal(run(g, 'npx nsbin', project(g, { nsbin: NO_SHEBANG }), { realpath }).decision, 'deny', g);
  }
  // a shell shebang on a file that is called .js
  denied('npx jsbin', { jsbin: SH });
  for (const g of GUARDS) {
    const realpath = (p) => p.replace(/node_modules\/\.bin\/jsbin$/, 'node_modules/pkg/cli.js');
    assert.equal(run(g, 'npx jsbin', project(g, { jsbin: SH }), { realpath }).decision, 'deny', g);
  }
  denied('npx envs', { envs: (g) => `#!/usr/bin/env -S bash -e\n${BAD[g]}\n` });
  denied('npx bb', { bb: (g) => `#!/bin/busybox sh\n${BAD[g]}\n` });
});

test('npx of a program (a shebang naming another interpreter, or binary content) is not opened: a guarded word in its text is only text', () => {
  allowed('npx tool', { tool: NODE_WORDS });
  allowed('npx tool', { tool: (g) => `#!/usr/bin/env bun\n${WORDS[g]}` });
  allowed('npx tool', { tool: (g) => `#!/usr/bin/python3\nprint("${BAD[g]}")\n` });
  allowed('npx tool', { tool: ELF });
  allowed('npx tool', { tool: NUL_BYTES });
  // a Mach-O file reads as replacement characters
  allowed('npx tool', { tool: (g) => `����\u0007\u0000\u0000\u0001${BAD[g]}` });
  // twins: the same words behind a shell shebang, no shebang, or a NUL after the first 512 bytes (text for a shell)
  // an interpreter the guard does not know (awk, make, pwsh, an unknown name) is no program: its text is opened like a shell script
  denied('npx tool', { tool: (g) => `#!/usr/bin/awk -f\n${BAD[g]}\n` });
  denied('npx tool', { tool: (g) => `#!/usr/bin/env pwsh\n${BAD[g]}\n` });
  denied('npx tool', { tool: (g) => `#!/usr/bin/env -S unknownlang\n${BAD[g]}\n` });
  denied('npx tool', { tool: (g) => `#!/bin/busybox awk -f\n${BAD[g]}\n` });
  denied('npx tool', { tool: SH });
  denied('npx tool', { tool: NO_SHEBANG });
  denied('npx tool', { tool: (g) => `${'#'.repeat(600)}\u0000\n${BAD[g]}\n` });
  // twin: the line replaces the program with a shell script
  for (const g of GUARDS) {
    const text = g === 'git' ? `printf '#!/bin/sh\\n${BAD.git}\\n' > node_modules/.bin/tool && npx tool` : `printf '#!/bin/sh\\n${BAD.files}\\n' > node_modules/.bin/tool && npx tool`;
    assert.equal(run(g, text, project(g, { tool: NODE_WORDS })).decision, 'deny', `${g}: replaced program`);
  }
});

test('a bin that cannot be read is refused, one that is too large is told apart by its first bytes', () => {
  denied('npx ub', { ub: null });
  for (const g of GUARDS) {
    const big = (head) => ({ readHead: () => head });
    assert.equal(run(g, 'npx tool', project(g, { tool: null }), big('#!/bin/sh\n')).decision, 'deny', `${g}: a big shell script`);
    assert.equal(run(g, 'npx tool', project(g, { tool: null }), big('#!/usr/bin/env node\n')).decision, 'allow', `${g}: a big program`);
    assert.equal(run(g, 'npx tool', project(g, { tool: null }), big('echo hi\n')).decision, 'deny', `${g}: a big file without a shebang`);
  }
});

test('npm run SCRIPT: a bare command name in the script resolves to node_modules/.bin (the PATH the manager sets), with the same first-bytes rule', () => {
  denied('npm run x', { shbin: SH }, { x: 'shbin' });
  denied('npm run x', { nsbin: NO_SHEBANG }, { x: 'nsbin' });
  denied('npm run x', { shbin: SH }, { x: 'shbin --flag arg' });
  denied('npm run x', { shbin: SH }, { x: 'echo start && shbin' });
  denied('yarn foo', { shbin: SH }, { foo: 'shbin' });
  denied('pnpm run x', { shbin: SH }, { x: 'shbin' });
  denied('npm test', { shbin: SH }, { test: 'shbin' });
  denied('npm run x', { shbin: SH }, { x: 'npm run y', y: 'shbin' });
  denied('npm run x', { shbin: SH }, { x: 'cd sub && shbin' }, {});
  denied('npm exec -c shbin', { shbin: SH }, {});
  denied('npm run x', { jsbin: SH }, { x: 'jsbin' });
  allowed('npm run x', { tool: NODE_WORDS }, { x: 'tool' });
  allowed('npm run x', { tool: ELF }, { x: 'tool --watch' });
  // a name with no bin is an ordinary command; so is a bin that is no shell script
  allowed('npm run x', { shbin: SH }, { x: 'echo shbin && ls' });
  allowed('npm run x', {}, { x: 'shbin' });
  allowed('npm run x', { other: SH }, { x: 'eslint .' });
  // the bin two directories up (the PATH has every node_modules/.bin from the package's directory upward)
  denied('npm run x', { shbin: SH }, { x: 'shbin' }, { pkgDir: 'a/b' });
  allowed('npm run x', { tool: NODE_WORDS }, { x: 'tool' }, { pkgDir: 'a/b' });
  // a pre / post hook of the script runs with the same PATH
  denied('npm run x', { shbin: SH }, { x: 'echo ok', prex: 'shbin' });
  // twin of the path-call: a script calling a bin by path is judged as a program run by path (unchanged); a bare name that is NOT in .bin is not looked up elsewhere
  allowed('npm run x', { shbin: SH }, { x: './elsewhere/shbin' });
});

test('a bin written by the same line is still judged when a package script calls it (the line itself puts the shell script there)', () => {
  for (const g of GUARDS) {
    const text = `printf '#!/bin/sh\\n${BAD[g]}\\n' > node_modules/.bin/tool && npm run x`;
    assert.equal(run(g, text, project(g, { tool: NODE_WORDS }, { x: 'tool' })).decision, 'deny', `${g}: replaced`);
  }
});
