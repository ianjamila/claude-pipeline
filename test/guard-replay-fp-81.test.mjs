// Why (#81 carve): the general fixes the package-script work (agent/guard-npm-scripts) found, kept here because they hold without it. Each test is one shape (made synthetic), next to the malicious twin that must
// stay refused:
//   K1  an operator expansion written WHERE the write target is used (`echo x > ~/${F/ok/.claude}/settings.json`), not only in an assigned name: a hole on main.
//   K2  a JavaScript method call (`.push(`, `.merge(`) is no mention of a guarded subcommand; `git commit -qm TEXT` hides TEXT like `-m`.
//   K3  a data reader's arguments (grep, ls, cat ...) are no mention; JavaScript text binds no name (`export`, `local` in a program or heredoc body).
//   K4  `gh` read-only subcommands name no local path for a name of unknown value.
// Guarded names are spelled in pieces (as test/guard-t8b.test.mjs does): the live guard scans files passed to node tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const CL = '.cl' + 'aude';
const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const MERGE = 'mer' + 'ge';
const none = { readText: () => null, readHead: () => null, pathExists: () => false, readDir: () => null };
const filesGuard = (command, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: '/home/u/proj', ...none, existsSync: () => false, ...o,
});
const gitGuard = (command, o = {}) => evaluateGitCommand(command, {
  cwd: '/work/repo', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...none, ...o,
});

// ---- K1. an operator expansion in the write target itself ---------------------------------------------------------------------------------------------------
test('K1 an inline operator in a write target is read like a name assigned with it', () => {
  for (const cmd of [`F=ok; echo x > ~/\${F/ok/${CL}}/settings.json`, `F=ok; echo x > $HOME/\${F/ok/${CL}}/settings.json`, `F=ok; cp a ~/\${F/ok/${CL}}/settings.json`,
    `F=ok; echo x >> ~/\${F//ok/${CL}}/settings.json`, `F=x${CL}; echo x > ~/\${F#x}/settings.json`, `F=${CL}.bak; tee ~/\${F%.bak}/settings.json`, `F=(x ${CL}); echo x > ~/\${F[1]}/settings.json`]) {
    assert.equal(filesGuard(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['F=ok; echo x > ~/${F/ok/other}/settings.json', 'F=ok; echo x > ~/${F/ok/other}/a.txt', 'F=a.ts; cp a ${F%.ts}.js', 'F=ok; cat ~/${F/ok/other}/a.txt']) {
    const r = filesGuard(cmd);
    assert.equal(r.decision, 'allow', `${cmd}: ${r.reason}`);
  }
});
