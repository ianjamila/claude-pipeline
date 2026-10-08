// Exit-code assertion for the CLI tests. A bare `assert.equal(r.code, 0)` fails with "3 !== 0" and nothing else, which
// is useless when a child dies on a CI runner (a native abort of node once surfaced as exit 3 on windows-latest). This
// puts the child's stdout and stderr, plus any caller message, into the failure.
import assert from 'node:assert/strict';

const section = (name, text) => `${name}:\n${text ? String(text).trimEnd() : '(empty)'}`;

export function assertExit(r, expected, message) {
  if (r.code === expected) return;
  assert.equal(r.code, expected, [
    message,
    `exit code ${r.code}, expected ${expected}`,
    section('stdout', r.stdout),
    section('stderr', r.stderr),
  ].filter((p) => p !== undefined && p !== '').join('\n'));
}
