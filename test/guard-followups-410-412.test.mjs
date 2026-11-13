// Follow-ups from #409 / #373 (issues #410, #411, #412): the cd narrowing of the bash files guard.
// Home is /home/u and so is the cwd; the lines are read from there (a relative write from home reaches the protected folders, so an allow means the narrowing worked).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });
const P = 'cd /home/u/proj';
const decide = (decision, cases) => {
  for (const [name, line, extra] of cases) {
    test(`${decision}: ${name}`, () => {
      const r = run(line, extra);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
};

describe('#410: a cd whose only || alternative leaves the shell surely succeeded for what follows', () => {
  decide('allow', [
    ['cd X || exit 1, write on the next line', `${P} || exit 1\nfind . -delete`],
    ['cd X || exit, write after ;', `${P} || exit; find . -delete`],
    ['cd X || return 1, write on the next line', `${P} || return 1\nfind . -delete`],
    ['cd X || exit 1 && write', `${P} || exit 1 && find . -delete`],
    ['a join before the cd does not matter', `true && ${P} || exit 1\nfind . -delete`],
    ['a subshell entered by ||', '[ -d x ] || (cd /home/u/proj && find . -delete)'],
    ['a subshell entered by | (its own cd runs first)', 'true | (cd /home/u/proj && find . -delete)'],
    ['a subshell entered by ||, exit alternative inside', '[ -d x ] || (cd /home/u/proj || exit 1; find . -delete)'],
    ['a brace group entered by ||', '[ -d x ] || { cd /home/u/proj && find . -delete; }'],
  ]);
  decide('deny', [
    ['cd X || exit 1 | cat (the exit is a pipeline stage: a subshell)', `${P} || exit 1 | cat\nfind . -delete`],
    ['cd X || exit 1 & (the exit is a background job)', `${P} || exit 1 &\nfind . -delete`],
    ['cd X || echo failed (the shell goes on)', `${P} || echo failed\nfind . -delete`],
    ['cd X || true', `${P} || true\nfind . -delete`],
    ['cd X || exit 1 in a pipeline stage before it', `a | ${P} || exit 1\nfind . -delete`],
    ['cd X after ||', `a || ${P} || exit 1\nfind . -delete`],
    ['write after || is still read widely', `${P} || find . -delete`],
    ['a subshell entered by ||: a write after the ) is read against every directory', '[ -d x ] || (cd /home/u/proj && true); find . -delete'],
    ['a cd inside the || subshell does not leak out of it', 'true || (cd /home/u/proj); find . -delete'],
    ['cd to the home itself still reaches home', `cd /home/u || exit 1\nfind . -delete`],
  ]);
});

describe('#411: a brace group entered by & runs in this shell (only the command before the & is the job)', () => {
  decide('allow', [
    ['the group cd carries out of the group', 'a & { true; cd /tmp; } && find . -delete'],
    ['the group cd is the narrowed directory (the write is not in the home)', 'a & { true; cd /home/u/proj; } && find . -delete'],
    ['a write inside the group after its cd', 'a & { cd /home/u/proj && find . -delete; }'],
  ]);
  decide('deny', [
    ['the group cd to home itself', 'a & { true; cd /home/u; } && find . -delete'],
    ['a group entered by || still exports no chain', 'true || { true; cd /tmp; } && find . -delete'],
    ['a group entered by | still exports no chain', 'a | { true; cd /tmp; } && find . -delete'],
    ['a group that is itself backgrounded runs in a subshell', '{ cd /tmp; } & find . -delete'],
  ]);
});
