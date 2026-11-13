// #190 case 5 (T1.2): `node <pipeline CLI> cost ... --from-transcript <TR>; node scripts/verify.mjs --quick` was refused with "too complex or too dynamic
// ... refers to a protected pipeline file", in either order, although the CLI is the trusted installed file and its transcript argument is only read.
// Root cause (traced on the real filesystem, repo cwd): judging scripts/verify.mjs scans its WHOLE TEXT with the protected-path matcher (rule: "the program
// refers to a protected pipeline file and writes"); that scan brace-expands the text, and above 5,000 characters braceExpand sets the shared `ctx.dynamic`
// ("the COMMAND LINE's scan was skipped, fail closed"). The first ~5,200 characters of verify.mjs already pass that size and hold `{` and `,`. The flag leaked
// into the line-level rule "(cmds.dynamic || ctx.dynamic) && the line names a protected file", which the CLI's transcript argument satisfies.
// The fix keeps the flag out of the line: a script-text scan no longer sets it. No path trust is extended, no comment or literal exemption is added.
// Home is /home/u and the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PROJ = '/home/u/proj';
const CFG = ['~', '.claude'].join('/');
const CLI = `${CFG}/pipeline/bin/pipeline.mjs`;
const TR = `${CFG}/projects/-home-u-proj/0b0e0a3c-0000-4000-8000-000000000001.jsonl`;
const S = `${CFG}/settings.json`;
const SCRIPT_HEAD = readFileSync(new URL('./fixtures/verify-head-fixture.txt', import.meta.url), 'utf8'); // the first 60 lines of scripts/verify.mjs (> 5,000 characters, braces and commas)
assert.ok(SCRIPT_HEAD.length > 5000 && SCRIPT_HEAD.includes('{') && SCRIPT_HEAD.includes(','));

const SKILL = `${CFG}/skills/codex-review/scripts/review.mjs`;
const files = {
  '/home/u/proj/scripts/verify.mjs': SCRIPT_HEAD,
  '/home/u/proj/evil.mjs': "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'x');\n",
  '/home/u/.claude/pipeline/bin/pipeline.mjs': '#!/usr/bin/env node\nconsole.log(1);\n',
  '/home/u/.claude/skills/codex-review/scripts/review.mjs': 'console.log(1);\n',
};
const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...extra });
const COST = `node ${CLI} cost --pr 5 --phase build --role implementer --from-transcript ${TR}`;
const VERIFY = 'node scripts/verify.mjs --quick';

for (const [label, line] of [
  ['forward, `;`', `${COST}; ${VERIFY}`],
  ['reverse, `;`', `${VERIFY}; ${COST}`],
  ['forward, `&&`', `${COST} && ${VERIFY}`],
  ['reverse, `&&`', `${VERIFY} && ${COST}`],
  ['forward, newline', `${COST}\n${VERIFY}`],
]) {
  test(`T1.2 allows: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
  });
}

test('T1.2: the verify script alone and the CLI call alone stay allowed (controls)', () => {
  assert.equal(run(VERIFY).decision, 'allow');
  assert.equal(run(COST).decision, 'allow');
});

// ---- must stay denied ----
const MANY = Array.from({ length: 200 }, () => 'true').join('; '); // far past the parse cap
const DENY = [
  ['a non-CLI writer plus a transcript argument', `node evil.mjs ${TR}; ${VERIFY}`],
  ['the CLI path as an ARGUMENT of another program', `node evil.mjs ${CLI} ${TR}`],
  ['the CLI path as an argument, then the verify script', `node evil.mjs ${CLI} ${TR}; ${VERIFY}`],
  ['the CLI, then a writer that names a protected file itself', `${COST}; cp /tmp/p ${S}`],
  ['the CLI, then $_ redirected into', `${COST}; tee $_ < /tmp/p`],
  ['NODE_OPTIONS on the CLI call, then the verify script', `NODE_OPTIONS=--require=/tmp/x.js ${COST}; ${VERIFY}`],
  ['NODE_OPTIONS on the CLI call, reverse order', `${VERIFY}; NODE_OPTIONS=--require=/tmp/x.js ${COST}`],
  ['an env prefix on the CLI call, then a writer of the transcript', `FOO=1 ${COST}; node evil.mjs ${TR}`],
  ['the cap-overflow line: CLI call, many commands, then a writer of a protected file', `${COST}; ${MANY}; cp /tmp/p ${S}`],
  ['the cap-overflow line, with the verify script', `${VERIFY}; ${COST}; ${MANY}; cp /tmp/p ${S}`],
  ['a heredoc body that repeats the transcript path, then a writer', `${COST}\ncat >> notes.md <<'EOF'\n${TR}\nEOF\nnode evil.mjs ${TR}`],
  ['a variable holding the transcript, passed to the CLI, then the verify script', `T=${TR}; ${COST.replace(TR, '"$T"')}; ${VERIFY}`],
  ['the CLI call with a redirect, then a writer', `${COST} > /tmp/o.txt; node evil.mjs ${TR}`],
  ['job start ... -- a writer of a protected file', `node ${CLI} job start x -- tee ${S}; ${VERIFY}`],
];
for (const [label, line] of DENY) {
  test(`T1.2 denies: ${label}`, () => {
    const r = run(line);
    assert.equal(r.decision, 'deny', `${line.slice(0, 100)} -> ${r.decision}`);
  });
}

// The live fixture of 11-11: a heredoc append whose body names a transcript, then a codex-review skill script (14 kB, braces and commas) under the config dir,
// on one line. Traced: it was refused for TWO stacked reasons. The first, reported to the user, was the spurious flag (scanning the skill script's text set
// ctx.dynamic): fixed. The second stays and is intended: a protected path in a heredoc body that no command names makes every command on the line need to be
// read-only (the body may be fed to a writer), and `node` is not. So the verdict is still a deny, now with the honest reason. The skills folder gets no path trust.
test('T1.2: the 11-11 live fixture stays denied, for the heredoc-body rule and no longer for the spurious flag', () => {
  const f = { ...files, '/home/u/.claude/skills/codex-review/scripts/review.mjs': SCRIPT_HEAD };
  const r = run(`cat >> x.md <<'EOF'\nsee ${TR}\nEOF\nnode ${SKILL} --pr 5`, { existsSync: (p) => p in f, readText: (p) => (typeof f[p] === 'string' ? f[p] : null) });
  assert.equal(r.decision, 'deny');
  assert.doesNotMatch(r.reason, /too complex or too dynamic/);
  assert.match(r.reason, /node refers to a protected pipeline file .* is not a read-only command/);
});

test('T1.2: the same long skill script after a one-line read-only command that names a transcript is allowed (it was only the flag)', () => {
  const f = { ...files, '/home/u/.claude/skills/codex-review/scripts/review.mjs': SCRIPT_HEAD };
  const r = run(`echo ${TR}; node ${SKILL} --pr 5`, { existsSync: (p) => p in f, readText: (p) => (typeof f[p] === 'string' ? f[p] : null) });
  assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
});

test('T1.2: the same line with a skill script that names a protected file and writes stays denied (no path trust for the skills folder)', () => {
  const bad = `${SCRIPT_HEAD}\n// appends to ${S}\nrequire('fs').writeFileSync('out.txt', 'x');\n`;
  const f = { ...files, '/home/u/.claude/skills/codex-review/scripts/review.mjs': bad };
  const r = run(`cat >> x.md <<'EOF'\nsee ${TR}\nEOF\nnode ${SKILL} --pr 5`, { existsSync: (p) => p in f, readText: (p) => (typeof f[p] === 'string' ? f[p] : null) });
  assert.equal(r.decision, 'deny', `${r.decision}: ${r.reason}`);
});

test('T1.2: a long script that names a protected file and writes is still denied by its own rule (the flag fix does not change that verdict)', () => {
  const bad = `${SCRIPT_HEAD}\n// appends to ${S}\nrequire('fs').writeFileSync('out.txt', 'x');\n`;
  const r = run('node scripts/verify.mjs --quick', { readText: (p) => (p === '/home/u/proj/scripts/verify.mjs' ? bad : files[p] ?? null) });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /refers to a protected pipeline file and writes/);
});
