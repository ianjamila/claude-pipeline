// Why (#161): the rule "a program whose text names a protected pipeline file and also writes" stays strict (a comment names the file
// as well as code does), but its message must say WHERE the reference is, so a person can reword that line. The decision itself is
// not touched: every case here is a deny before and after; only the text of the reason changes.
// Home is /home/u; the filesystem is faked. The protected path is built from parts so this file does not spell it either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const BASE = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false };
const PROJ = '/home/u/proj';
const fsOf = (files) => ({ existsSync: (p) => p in files, readText: (p) => (typeof files[p] === 'string' ? files[p] : null) });
const run = (command, files) => evaluateBashForFiles(command, { ...BASE, cwd: PROJ, ...fsOf(files) });

const RUNS = ['~', '.claude', 'pipeline-state', 'verify-runs.jsonl'].join('/');
const WRITER = "fs.writeFileSync('out.txt', 'x');";
const progOf = (...lines) => ({ '/home/u/proj/verify.mjs': lines.join('\n') });

test('#161: a comment naming the protected file plus a write elsewhere is still denied, and the message says which line', () => {
  const r = run('node verify.mjs', progOf("import fs from 'node:fs';", "const x = 1;", `// Each run appends one line to ${RUNS} (moved by VERIFY_RUN_HISTORY)`, "fs.writeFileSync('out.txt', 'x');"));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /refers to a protected pipeline file and writes/);
  assert.match(r.reason, /verify\.mjs/);
  assert.match(r.reason, /\bline 3\b/);
  assert.match(r.reason, /Each run appends one line/);
  assert.ok(r.reason.includes('verify-runs.jsonl'));
  assert.match(r.reason, /reword that line/i);
});

test('#161: the excerpt is trimmed to about 100 characters, around the reference', () => {
  const long = `// ${'padding '.repeat(40)}see ${RUNS} ${'tail '.repeat(60)}`;
  const r = run('node verify.mjs', progOf(WRITER, long));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\bline 2\b/);
  const excerpt = /`([^`]*)`/.exec(r.reason.split('refers to a protected pipeline file and writes')[1] ?? '')?.[1] ?? '';
  assert.ok(excerpt.length > 0 && excerpt.length <= 110, `excerpt of ${excerpt.length} chars`);
  assert.ok(r.reason.length < 900, `reason of ${r.reason.length} chars`);
});

test('#161: several lines name it: the first line is reported, the others are counted', () => {
  const r = run('node verify.mjs', progOf(WRITER, 'const a = 1;', `// first ${RUNS}`, 'const b = 2;', `// second ${RUNS}`, `// third ${RUNS}`));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\bline 3\b/);
  assert.match(r.reason, /and 2 more/);
  assert.doesNotMatch(r.reason, /\bline 5\b/);
});

test('#161: the reference on the very first line, and a CRLF file, report the right line number', () => {
  assert.match(run('node verify.mjs', progOf(`// ${RUNS}`, WRITER)).reason, /\bline 1\b/);
  const crlf = { '/home/u/proj/verify.mjs': `const a = 1;\r\n// ${RUNS}\r\nrequire('fs').writeFileSync('o', 'x');\r\n` };
  const r = run('node verify.mjs', crlf);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\bline 2\b/);
  assert.doesNotMatch(r.reason, /\r/);
});

test('#161: no single line reproduces the hit (a path joined over a line break): still a deny, the old message plus a note that it spans lines', () => {
  const HOME = ['~', '.claude'].join('/');
  const r = run('node verify.mjs', progOf(`p = "${HOME}/"`, '+ "pipeline/x"', '# writeFile'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /protected pipeline file and writes \(/);
  assert.match(r.reason, /no single line holds it \(the reference spans lines\)/);
});

test('#161: a very long program is located within a bounded time, the decision is unchanged and the reason still names the rule', () => {
  const filler = Array.from({ length: 30_000 }, (_, i) => `const v${i} = ${i};`);
  const t0 = Date.now();
  const r = run('node verify.mjs', progOf(WRITER, ...filler, `// ${RUNS}`));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /refers to a protected pipeline file and writes/);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test('#161: a line too long to re-read is skipped (the old message stands), a shorter one after it is still reported', () => {
  const huge = `const s = '${'x'.repeat(5000)}'; // ${RUNS}`;
  assert.match(run('node verify.mjs', progOf(WRITER, huge, `// ${RUNS}`)).reason, /\bline 3\b/);
  const only = run('node verify.mjs', progOf(WRITER, huge));
  assert.equal(only.decision, 'deny');
  assert.match(only.reason, /refers to a protected pipeline file and writes/);
});

test('#161: decisions are unchanged: a program that writes but names nothing protected, or names it without writing, is allowed', () => {
  assert.equal(run('node verify.mjs', progOf(WRITER)).decision, 'allow');
  assert.equal(run('node verify.mjs', progOf(`console.log('${RUNS}');`)).decision, 'allow');
});
