import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPosix, expandHome, isInside, samePath, safeTimestamp } from '../pipeline/lib/paths.mjs';

test('toPosix replaces every backslash', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(toPosix('a/b'), 'a/b');
});

test('expandHome expands ~, $HOME, ${HOME}, %USERPROFILE%, $env:USERPROFILE', () => {
  assert.equal(expandHome('~/x', '/h'), '/h/x');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('$HOME/x', '/h'), '/h/x');
  assert.equal(expandHome('${HOME}/x', '/h'), '/h/x');
  assert.equal(expandHome('%USERPROFILE%\\x', 'C:\\Users\\u'), 'C:\\Users\\u\\x');
  assert.equal(expandHome('%userprofile%\\x', 'C:\\Users\\u'), 'C:\\Users\\u\\x');
  assert.equal(expandHome('$env:USERPROFILE\\x', 'C:\\Users\\u'), 'C:\\Users\\u\\x');
  assert.equal(expandHome('$ENV:userprofile/x', '/h'), '/h/x');
});

test('expandHome leaves other paths alone', () => {
  assert.equal(expandHome('/abs/x', '/h'), '/abs/x');
  assert.equal(expandHome('rel/~/x', '/h'), 'rel/~/x');
  assert.equal(expandHome('~other/x', '/h'), '~other/x');
  assert.equal(expandHome('$HOMEDIR/x', '/h'), '$HOMEDIR/x');
});

test('expandHome defaults to the real home directory', () => {
  assert.notEqual(expandHome('~/x'), '~/x');
});

test('isInside: child equal to or below parent', () => {
  assert.equal(isInside('/h/.claude/pipeline/x', '/h/.claude/pipeline'), true);
  assert.equal(isInside('/h/.claude/pipeline', '/h/.claude/pipeline'), true);
  assert.equal(isInside('/h/.claude/pipeline/', '/h/.claude/pipeline'), true);
});

test('isInside does not treat a sibling prefix as inside', () => {
  assert.equal(isInside('/h/.claude/pipelinex', '/h/.claude/pipeline'), false);
  assert.equal(isInside('/a/bc', '/a/b'), false);
});

test('isInside resolves .. segments on both sides', () => {
  assert.equal(isInside('/h/.claude/skills/ship/../ship/SKILL.md', '/h/.claude/skills/ship'), true);
  assert.equal(isInside('/h/.claude/skills/ship/../other/x', '/h/.claude/skills/ship'), false);
  assert.equal(isInside('/h/a/../b/x', '/h/c/../b'), true);
});

test('isInside: root contains everything absolute', () => {
  assert.equal(isInside('/anything/x', '/'), true);
});

test('isInside is case-insensitive only on win32 and darwin', () => {
  assert.equal(isInside('/H/.Claude/Pipeline/x', '/h/.claude/pipeline', 'darwin'), true);
  assert.equal(isInside('/H/.Claude/Pipeline/x', '/h/.claude/pipeline', 'win32'), true);
  assert.equal(isInside('/H/.Claude/Pipeline/x', '/h/.claude/pipeline', 'linux'), false);
});

test('isInside accepts Windows separators and drive letters', () => {
  assert.equal(isInside('C:\\Users\\u\\.claude\\x', 'c:/users/u/.claude', 'win32'), true);
  assert.equal(isInside('C:\\Users\\u2\\x', 'C:\\Users\\u', 'win32'), false);
  assert.equal(isInside('D:\\x', 'C:\\', 'win32'), false);
  assert.equal(isInside('C:\\x', 'C:\\', 'win32'), true);
});

test('samePath compares after normalisation', () => {
  assert.equal(samePath('/a/b/../c', '/a/c'), true);
  assert.equal(samePath('/a/c/', '/a/c'), true);
  assert.equal(samePath('/a/c', '/a/d'), false);
  assert.equal(samePath('/A/C', '/a/c', 'darwin'), true);
  assert.equal(samePath('/A/C', '/a/c', 'linux'), false);
  assert.equal(samePath('C:\\a\\b', 'c:/a/b', 'win32'), true);
});

test('safeTimestamp is UTC, colon-free, fixed width', () => {
  assert.equal(safeTimestamp(new Date(Date.UTC(2026, 9, 1, 2, 3, 4))), '20261001T020304Z');
  assert.match(safeTimestamp(), /^\d{8}T\d{6}Z$/);
});
