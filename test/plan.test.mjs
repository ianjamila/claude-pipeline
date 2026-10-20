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

// Amendment r4: what the owner sees rendered (CommonMark) must be what parsePlan reads.
const SCOPE_OK = ['src/a.mjs', 'test/**', 'docs/x.md'];
const withScope = (extra) => PLAN.replace('* `docs/x.md` (the doc)', `* \`docs/x.md\` (the doc)\n${extra}`);

test('a 4-backtick fence is not closed by a 3-backtick line: the later Scope stays masked', () => {
  const fenced = PLAN + ['````markdown', '```', '## Scope', '- `evil/**`', '### Task T9: Fake', '````', ''].join('\n');
  const p = parsePlan(fenced);
  assert.deepEqual(p.scope, SCOPE_OK);
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2']);
  assert.ok(p.tasks[1].text.includes('- `evil/**`'), 'the masked block stays in the task text');
});

test('a fence closes only on the same character, at least as long, with nothing else on the line', () => {
  const body = ['## Scope', '- `evil/**`', '### Task T9: Fake'];
  for (const [open, notClose] of [['````', '```'], ['```', '~~~'], ['~~~~', '~~~'], ['```', '``` x'], ['```', '```` x']]) {
    const p = parsePlan(PLAN + [open, notClose, ...body, ''].join('\n'));
    assert.deepEqual(p.scope, SCOPE_OK, `${open} not closed by ${notClose}`);
    assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2']);
  }
  // a longer closer, up to 3 spaces of indent and trailing spaces do close it
  const closed = parsePlan(PLAN + ['```', 'x', '   ````   ', '### Task T3: Real', 'c', ''].join('\n'));
  assert.deepEqual(closed.tasks.map((t) => t.id), ['T1', 'T2', 'T3']);
});

test('an unclosed fence masks to the end of the text', () => {
  const p = parsePlan(PLAN + ['```', '### Task T9: Fake', '## Scope', '- `evil/**`', ''].join('\n'));
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2']);
  assert.deepEqual(p.scope, SCOPE_OK);
});

test('a line indented 4+ spaces (or a tab) is never a fence; a backtick fence with a backtick in its info string is not one', () => {
  for (const ind of ['    ', '     ', '\t']) {
    const p = parsePlan(PLAN + [`${ind}\`\`\``, '### Task T3: Real', 'c', ''].join('\n'));
    assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2', 'T3'], JSON.stringify(ind));
  }
  const p = parsePlan(PLAN + ['``` a`b', '### Task T3: Real', 'c', ''].join('\n'));
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2', 'T3']);
  // a tilde fence may have a backtick in its info string, and up to 3 spaces of indent is still a fence
  const q = parsePlan(PLAN + ['   ~~~ a`b', '### Task T9: Fake', '~~~', ''].join('\n'));
  assert.deepEqual(q.tasks.map((t) => t.id), ['T1', 'T2']);
});

test('Scope refuses HTML comments, raw HTML tag lines, blockquoted and nested items (each listed)', () => {
  const bad = {
    comment: ['<!-- - `evil/**` -->', /raw HTML\/comment at line \d+ is hidden when rendered/],
    multiline: ['<!--', '- `evil/**`', '-->', /raw HTML\/comment at line \d+/],
    tag: ['<details>', /raw HTML\/comment at line \d+/],
    tagAttrs: ['  <div hidden>', /raw HTML\/comment at line \d+/],
    quote: ['> - `x`', /blockquote/],
    nestedQuote: ['> > * `x`', /blockquote/],
    nested: ['  - `x`', /nested/],
    nested4: ['    - `x`', /nested/],
    nestedTab: ['\t- `x`', /nested/],
  };
  for (const [name, [...lines]] of Object.entries(bad)) {
    const re = lines.pop();
    assert.throws(() => parsePlan(withScope(lines.join('\n'))), (e) => e instanceof PlanError && re.test(e.message), name);
  }
  assert.throws(() => parsePlan(withScope('<!-- a -->\n> - `x`')), (e) => e instanceof PlanError && /raw HTML\/comment/.test(e.message) && /blockquote/.test(e.message));
  // fenced samples inside Scope are code, so they are fine; plain prose and flat items still parse
  assert.deepEqual(parsePlan(withScope('Note: flat list.\n```\n<!-- x -->\n> - `y`\n```\n- ` other/** `')).scope, [...SCOPE_OK, 'other/**']);
});

test('raw HTML and comments are refused anywhere outside fences and code spans, each with its line number', () => {
  const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const bad = {
    commentInTask: PLAN.replace('b works', 'b works\n<!-- hidden -->'),
    commentMidLine: PLAN.replace('b works', 'b <!-- hidden --> works'),
    multilineInTask: PLAN.replace('b works', '<!--\n### Task T9: Fake\n-->\nb works'),
    commentBeforeScope: PLAN.replace('## Scope', '<!--\n## Scope\n- `evil/**`\n-->\n## Scope'),
    unclosedBeforeScope: PLAN.replace('## Scope', '<!-- never closed\n## Scope'),
    detailsBeforeScope: PLAN.replace('## Scope', '<details>\n## Scope'),
    closingTag: PLAN.replace('b works', 'b works\n</div>'),
    indentedTag: PLAN.replace('b works', 'b works\n   <span hidden>x</span>'),
    declaration: PLAN.replace('b works', 'b works\n<!DOCTYPE html>'),
    selfClosing: PLAN.replace('b works', 'b works\n<br/>'),
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.throws(() => parsePlan(text), (e) => e instanceof PlanError && /raw HTML\/comment at line \d+ is hidden when rendered: write it as text or inside a code block/.test(e.message), name);
  }
  // the line number is 1-based and every offending line is listed
  const two = PLAN.replace('b works', 'b works\n<details>\ntext\n<!-- x -->');
  assert.throws(() => parsePlan(two), (e) => e.problems.some((p) => p.includes(`line ${lineOf(two, '<details>')} `)) && e.problems.some((p) => p.includes(`line ${lineOf(two, '<!-- x -->')} `)));
  // fenced samples and inline code spans are fine, and so are comparison signs in prose
  assert.ok(parsePlan(PLAN + '```\n<!--\n<details>\n```\n'));
  assert.ok(parsePlan(PLAN.replace('b works', 'b `<!--` and `<div>` works, 1 < 2 and a <b>c')));
});

test('the Scope section ends at the first task heading: a backticked bullet in a task body is not scope', () => {
  assert.deepEqual(parsePlan(PLAN.replace('b works', 'b works\n- `evil/**`')).scope, SCOPE_OK);
});

test('a second unmasked "## Scope" or "## In plain English" section is refused', () => {
  assert.throws(() => parsePlan(PLAN.replace('### Task T1', '## Scope\n- `evil/**`\n\n### Task T1')), (e) => e instanceof PlanError && /duplicate ## Scope section/.test(e.message));
  assert.throws(() => parsePlan(PLAN.replace('### Task T1', '## In plain English\nother\n\n### Task T1')), (e) => e instanceof PlanError && /duplicate ## In plain English section/.test(e.message));
  // a duplicate inside a fence is masked, so it is fine
  assert.ok(parsePlan(PLAN.replace('b works', 'b works\n```\n## Scope\n## In plain English\n```')));
});

test('invisible and reordering characters are refused anywhere, fences included, naming the line and code point', () => {
  const cases = {
    rloInScopeEntry: [withScope('- `src/‮evil.mjs`'), 'U+202E'],
    zwspInTask: [PLAN.replace('b works', 'b wor​ks'), 'U+200B'],
    zwspInFence: [PLAN + '```\nhid​den\n```\n', 'U+200B'],
    isolate: [PLAN.replace('b works', 'b ⁦works'), 'U+2066'],
    lrm: [PLAN.replace('b works', 'b ‎works'), 'U+200E'],
    alm: [PLAN.replace('b works', 'b ؜works'), 'U+061C'],
    wordJoiner: [PLAN.replace('b works', 'b ⁠works'), 'U+2060'],
    softHyphen: [PLAN.replace('b works', 'b wor­ks'), 'U+00AD'],
    midBom: [PLAN.replace('b works', 'b ﻿works'), 'U+FEFF'],
    c0: [PLAN.replace('b works', 'b \u0007works'), 'U+0007'],
    c1: [PLAN.replace('b works', 'b \u0085works'), 'U+0085'],
    del: [PLAN.replace('b works', 'b \u007Fworks'), 'U+007F'],
  };
  for (const [name, [text, cp]] of Object.entries(cases)) {
    const line = text.split('\n').findIndex((l) => l.includes(String.fromCodePoint(parseInt(cp.slice(2), 16)))) + 1;
    assert.throws(() => parsePlan(text), (e) => e instanceof PlanError && e.problems.includes(`invisible character ${cp} at line ${line}`), name);
  }
  // tab, newline and CRLF stay fine; a leading BOM is stripped, not refused
  assert.ok(parsePlan(PLAN.replace('b works', 'b\tworks')));
  assert.deepEqual(parsePlan(`﻿${PLAN}`).scope, SCOPE_OK);
  // every offending line is listed
  assert.throws(() => parsePlan(PLAN.replace('a works.', 'a​ works.').replace('b works', 'b‌ works')), (e) => e.problems.filter((p) => p.startsWith('invisible character')).length === 2);
});

test('link reference definitions outside fences are refused; inline links and fenced definitions are fine', () => {
  assert.throws(() => parsePlan(PLAN.replace('b works', 'b works\n[x]: /u "hidden"')), (e) => e instanceof PlanError && /link reference definition at line \d+ is hidden when rendered/.test(e.message));
  assert.throws(() => parsePlan(PLAN.replace('b works', 'b works\n   [Ref one]:\t<http://x> \'t\'')), /link reference definition at line/);
  assert.ok(parsePlan(PLAN.replace('b works', 'b [x](/u) works\n[not a def] text')));
  assert.ok(parsePlan(PLAN.replace('b works', 'b works\n```\n[x]: /u "hidden"\n```')));
});
