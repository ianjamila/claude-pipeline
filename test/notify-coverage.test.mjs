// The owner is only told about a stopped run if the controller writes the `P summary` (or `P notify`) call that sends the
// push, and nothing but the skill text makes the controller write it. So the skill text is checked here:
//  1. every `--outcome <word>` it uses is classified in OUTCOME_EVENTS (a push, or an explicit null = no push), and every
//     word in the prod-watch outcomes table is too;
//  2. every block of text (paragraph, list item, table row) that tells the controller to STOP also names `summary` or
//     `P notify`, unless it is on the short allowlist below (a stop before a PR exists, which the owner watches live).
// A new "stop" added to the skill without a summary fails here instead of silently never reaching the owner's phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTCOME_EVENTS, classifyOutcome } from '../pipeline/lib/notify.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillFiles = ['SKILL.md', 'reference/gates-and-exits.md', 'reference/review-loop.md'].map((f) => join(root, 'skills', 'ship', f));

// Text -> blocks. A block is a list item (with its indented continuation and fenced code), a table row, a heading, or a
// paragraph. Fenced code stays with the block above it (a command listing belongs to the sentence that introduces it).
export function blocksOf(markdown) {
  const blocks = [];
  let cur = null;
  let inFence = false;
  let blank = true;
  let firstIndent = 0;
  const start = (line) => {
    cur = [line];
    blocks.push(cur);
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      (cur ?? (start(''), cur)).push(line);
      blank = false;
      continue;
    }
    if (inFence) {
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      blank = true;
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    // A list item opens a new block unless it is nested deeper than the block it sits in (sub-steps belong to the parent).
    const listItem = /^\s*(?:\d+\.|[-*])\s/.test(line) && (cur === null || indent <= firstIndent);
    if (cur === null || /^#{1,6}\s/.test(line) || line.startsWith('|') || listItem || (blank && indent < 2)) {
      firstIndent = indent;
      start(line);
    }
    else cur.push(line);
    blank = false;
  }
  return blocks.map((b) => b.join('\n'));
}

// "stop" as an instruction: `stop`, `Stop.`, `STOP:`, `then stop`, `stop and tell the user`, `stop after summary`.
// Not `stops`/`stopped`/`stopping`, which describe something else ("a run that stopped").
const STOP = /(?<![\w-])stop(?![\w-])/i; // `hard-stop` is a noun, not an instruction
const HAS_NOTIFY_PATH = /\bsummary\b|\bP notify\b|\bpipeline notify\b/i;

// -> the blocks that say stop but name no summary / notify call and are not allowed.
export function unnotifiedStops(markdown, allow = []) {
  return blocksOf(markdown).filter(
    (b) => STOP.test(b) && !HAS_NOTIFY_PATH.test(b) && !allow.some((a) => a.test(b)),
  );
}

// `--outcome <word>` occurrences ("<outcome>" style placeholders do not start with a letter and are skipped).
export function outcomeWords(markdown) {
  return [...markdown.matchAll(/--outcome\s+([a-z][a-z-]*)/g)].map((m) => m[1]);
}

// Stops that legitimately carry no summary. Keep this short; every entry says why it is exempt.
const ALLOW = [
  // Step 0: preflight finds the repo not onboarded. No branch, no PR, and the owner is at the keyboard starting the run.
  /`config` missing\/invalid → stop/,
  // Step 0: `P labels ensure` cannot reach GitHub. Still before any PR exists, owner at the keyboard.
  /`P labels ensure` \(idempotent/,
  // Invariant 3: "report-only hits never stop the PR" says what such a hit does NOT do; it is not an instruction to stop.
  /report-only hits[^]*never stop the\s+PR/i,
  // "Ending a run with a PR open": the section that states the rule itself, including that pre-PR stops push nothing.
  /Stops before a PR\s+exists/,
];
const texts = skillFiles.map((f) => [f, readFileSync(f, 'utf8')]);

test('the skill files are found and non-trivial (guards against a vacuous pass)', () => {
  for (const [f, t] of texts) assert.ok(t.length > 1000, f);
  const all = texts.map(([, t]) => t).join('\n');
  assert.ok(blocksOf(all).filter((b) => STOP.test(b)).length >= 15, 'the stop detector should see many stops');
  assert.ok(outcomeWords(all).length >= 8, 'the outcome extractor should see many --outcome words');
});

test('every --outcome word in the ship skill is classified (push or explicit no-push)', () => {
  const words = new Set();
  for (const [, t] of texts) outcomeWords(t).forEach((w) => words.add(w));
  for (const w of words) {
    assert.equal(classifyOutcome(w).known, true, `--outcome ${w} is not a key of OUTCOME_EVENTS`);
  }
  // The words that must push are the ones the skill uses for stops.
  for (const w of ['stopped', 'needs-human', 'blocked', 'awaiting-review', 'awaiting-owner-merge']) {
    assert.ok(words.has(w), `the skill never uses --outcome ${w}`);
    assert.notEqual(OUTCOME_EVENTS[w], null, `${w} must push`);
  }
  for (const w of ['closed', 'merged-externally', 'deploy-not-observed']) {
    assert.ok(words.has(w), `the skill never uses --outcome ${w}`);
    assert.equal(OUTCOME_EVENTS[w], null, `${w} must not push`);
  }
});

test('every outcome in the prod-watch table of gates-and-exits is classified', () => {
  const gates = texts.find(([f]) => f.endsWith('gates-and-exits.md'))[1];
  const section = gates.slice(gates.indexOf('## `P prod-watch` outcomes'));
  const rows = section.split('\n').filter((l) => /^\| `/.test(l));
  assert.ok(rows.length >= 7, 'the table rows were not found');
  const words = rows.flatMap((r) => [...r.split('|')[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  assert.ok(words.includes('recovered') && words.includes('deploy-not-observed'));
  for (const w of words) assert.equal(classifyOutcome(w).known, true, `prod-watch outcome ${w} is unclassified`);
  // prod-watch pushes these itself, so summary must stay silent for all of them.
  for (const w of words) assert.equal(OUTCOME_EVENTS[w], null, `summary --outcome ${w} would push twice`);
});

test('every stop in the ship skill names a summary / notify call (or is allowlisted)', () => {
  for (const [f, t] of texts) {
    const bad = unnotifiedStops(t, ALLOW);
    assert.deepEqual(bad, [], `${f}: a stop with no \`P summary\` / \`P notify\` in the same block:\n${bad.join('\n---\n')}`);
  }
});

test('the allowlist entries each still match something (no stale exemptions)', () => {
  const all = texts.map(([, t]) => t).join('\n');
  for (const a of ALLOW) assert.ok(blocksOf(all).some((b) => STOP.test(b) && a.test(b)), `stale allowlist entry ${a}`);
});

test('positive control: the checker fails on a stop with no summary and passes once one is named', () => {
  const bad = ['# Steps', '', '1. Run the thing.', '2. If it fails, label `needs-human` and stop.', '', '| x | y | z, stop |'].join('\n');
  assert.equal(unnotifiedStops(bad).length, 2, 'both the list item and the table row must be flagged');
  const good = bad.replace('and stop.', 'and `P summary --pr N --outcome needs-human --action "…"`, stop.').replace('z, stop', 'z, `P notify`, stop');
  assert.deepEqual(unnotifiedStops(good), []);
  // Block splitting: a stop in one list item is not excused by a summary in the next one.
  assert.equal(unnotifiedStops('- stop here\n- P summary elsewhere').length, 1);
  // A fenced command listing stays with the sentence that introduces it.
  assert.deepEqual(unnotifiedStops('Stop early, in this order:\n```\nP summary --pr N\n```'), []);
  // The allowlist works and is per-block.
  assert.deepEqual(unnotifiedStops('- preflight failed, stop\n', [/preflight/]), []);
  // An unclassified outcome word is caught by the extractor + classifier pair.
  assert.deepEqual(outcomeWords('`P summary --pr N --outcome frobnicated` and --outcome <word>'), ['frobnicated']);
  assert.equal(classifyOutcome('frobnicated').known, false);
});
