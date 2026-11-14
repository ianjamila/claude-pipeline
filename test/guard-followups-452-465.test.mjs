// Follow-ups from PR #453 for the guards: #452 (the git guard reads the `cd X || { …; exit 1; }` group form), #457 (cp / install -T), #464 (rsync -R / --relative),
// #465 (rsync long value options by abbreviation), #460 (the unsplit reading of an option word that holds a blank).
// Home is /home/u and the cwd is /home/u/proj for the files guard; the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: `${HOME}/proj`, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const decide = (decision, cases, extra = {}) => {
  for (const [name, line] of cases) {
    test(`${decision}: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

// ---- #452: the git guard's group form ----
// cwd /work/repo is on agent/x, /other on agent/y: a push is allowed where the directory is known, and denied ("cannot tell which directory") where the cd may not have taken effect.
const gitRun = (command) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y' })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: () => null,
  pathExists: () => false,
});
describe('#452: the git guard reads `cd X || { …; exit 1; }` like the files guard (a plain exit as the last command, no redirection on the closer)', () => {
  const NOT = (name, line) => test(`not narrowed: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /cannot tell which directory/);
  });
  const NARROWED = (name, line) => test(`narrowed: ${name}`, () => assert.equal(gitRun(line).decision, 'allow', line));
  NARROWED('the everyday group', 'cd /other || { echo "no dir" >&2; exit 1; }; git push');
  NARROWED('two commands before the exit', 'cd /other || { echo a; echo b >&2; exit 2; }; git push');
  NARROWED('the group, then && push', 'cd /other || { echo no; exit 1; } && git push');
  NARROWED('the group, then push on the next line', 'cd /other || { echo no; exit 1; }\ngit push');
  NARROWED('a command substitution before the group does not shift the reading', 'X=$(echo a); cd /other || { echo no; exit 1; }; git push');
  NOT('a redirection on the closer', 'cd /other || { echo no; exit 1; } 2>/dev/null; git push');
  NOT('a redirection on the closer (an input that may fail)', 'cd /other || { echo no; exit 1; } < /missing; git push');
  NOT('the last command is not an exit', 'cd /other || { echo no; true; }; git push');
  NOT('the last command is a return', 'cd /other || { echo no; return 1; }; git push');
  NOT('a redirection on the exit inside the group', 'cd /other || { echo no; exit 1 < /missing; }; git push');
  NOT('an exit with extra words', 'cd /other || { echo no; exit 1 2; }; git push');
  NOT('a command of the group joined by && (the exit may not run)', 'cd /other || { echo no && exit 1; }; git push');
  NOT('the group is entered by | not ||', 'cd /other | { echo no; exit 1; }; git push');
  NOT('the group is a background job', 'cd /other || { echo no; exit 1; } &\ngit push');
  NOT('the push is joined by ||', 'cd /other || { echo no; exit 1; } || git push');
});
