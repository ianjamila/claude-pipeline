import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, outsideScope, parsePlan, planRequestLines, scopeDigest } from '../pipeline/lib/plan.mjs';

const PLAN = [
  '# Thing', '', '## In plain English', 'It does a thing.', '',
  '## Scope', '- `src/a.mjs`', '- `test/**`', '* `docs/x.md` (the doc)', '',
  '### Task T1: First', 'Acceptance: a works.   ', '', '### Task T2: Second', 'b works', '',
].join('\n');

test('parses plain English, scope and tasks', () => {
  const p = parsePlan(PLAN);
  assert.equal(p.plainEnglish, 'It does a thing.');
  assert.deepEqual(p.scope, ['src/a.mjs', 'test/**', 'docs/x.md']);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.title]), [['T1', 'First'], ['T2', 'Second']]);
  assert.equal(p.tasks[0].text, 'Acceptance: a works.');
  assert.match(p.tasks[0].specSha, /^[0-9a-f]{12}$/);
});

test('specSha is computed on the full text before clipping and ignores CRLF / trailing spaces', () => {
  const long = 'x'.repeat(3000);
  const a = parsePlan(PLAN.replace('b works', `${long}A`));
  const b = parsePlan(PLAN.replace('b works', `${long}B`));
  assert.equal(a.tasks[1].spec, b.tasks[1].spec); // both clipped to LIMITS.spec
  assert.notEqual(a.tasks[1].specSha, b.tasks[1].specSha);
  assert.equal(parsePlan(PLAN.replaceAll('\n', '\r\n')).tasks[0].specSha, parsePlan(PLAN).tasks[0].specSha);
});

test('headings inside fenced code blocks are ignored', () => {
  const fenced = PLAN + ['```markdown', '## Scope', '- `evil/**`', '### Task T9: Fake', '```', ''].join('\n');
  const p = parsePlan(fenced);
  assert.deepEqual(p.scope, ['src/a.mjs', 'test/**', 'docs/x.md']);
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2']);
  assert.ok(p.tasks[1].text.includes('### Task T9'), 'a fenced block stays part of the task text (full definition)');
});

test('missing sections, empty scope, bad entries and duplicate ids are refused with every problem listed', () => {
  assert.throws(() => parsePlan('# x\n'), (e) => e instanceof PlanError && e.problems.length === 3);
  assert.throws(() => parsePlan(PLAN.replace('- `src/a.mjs`', '- `../up.mjs`')), /\.\./);
  assert.throws(() => parsePlan(PLAN.replace('- `src/a.mjs`', '- `/abs.mjs`')), /absolute/);
  assert.throws(() => parsePlan(PLAN.replace('### Task T2', '### Task T1')), /duplicate task id T1/);
});

test('scopeDigest is order- and duplicate-insensitive', () => {
  assert.equal(scopeDigest(['b', 'a', 'a']), scopeDigest(['a', 'b']));
  assert.match(scopeDigest(['a']), /^[0-9a-f]{12}$/);
});

test('outsideScope: renames need both paths, deletions use the old path, the plan file has no exemption', () => {
  const f = (oldPath, newPath, status = 'M') => ({ oldPath, newPath, path: newPath ?? oldPath, status });
  const files = [f('src/a.mjs', 'src/a.mjs'), f('lib/old.mjs', 'src/new.mjs', 'R'), f('gone.mjs', null, 'D'), f('docs/plans/p.md', 'docs/plans/p.md')];
  assert.deepEqual(outsideScope({ files, scope: ['src/**'] }), ['docs/plans/p.md', 'gone.mjs', 'lib/old.mjs']);
  assert.deepEqual(outsideScope({ files, scope: ['src/**', 'docs/plans/p.md'] }), ['gone.mjs', 'lib/old.mjs']);
});

test('parsePlan with a path refuses a plan whose Scope does not list its own file', () => {
  assert.throws(() => parsePlan(PLAN, { path: 'docs/plans/p.md' }), /own path docs\/plans\/p\.md is not in its Scope/);
  assert.ok(parsePlan(PLAN.replace('- `src/a.mjs`', '- `src/a.mjs`\n- `docs/plans/p.md`'), { path: 'docs/plans/p.md' }));
});

test('planRequestLines renders the exact two terminal lines', () => {
  assert.deepEqual(planRequestLines({ pr: 7, blob: 'a'.repeat(40), scopeDigest: 'b'.repeat(12) }), [
    `Plan ${'a'.repeat(40)} · scope ${'b'.repeat(12)}`,
    '📋 Ready to approve plan #7 — say "approve"',
  ]);
});
