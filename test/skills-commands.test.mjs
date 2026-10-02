// The skills and agent prompts are the only callers of the pipeline CLI, and nothing else notices when a doc says
// `P artifacts push --pr-branch …` while the command takes `--pr N`. So every `P <command> [<sub>]` and
// `pipeline.mjs <command>` invocation written in skills/**/*.md and agents/*.md is extracted and checked against the
// real command modules: the command exists, a sub-commanded module is given a subcommand it has, and each --flag used
// appears in the usage text of that command (that subcommand's block, for sub-commanded ones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const commandsDir = join(root, 'pipeline', 'commands');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });
}

// Usage text -> { subs: Map(sub -> text of its block) | null, text }. A block starts at a line `pipeline <cmd> ...`
// and runs over the indented lines that follow it.
export function parseUsage(cmd, usage) {
  const blocks = [];
  for (const line of usage.split('\n')) {
    if (/^pipeline\s/.test(line)) blocks.push(line);
    else if (blocks.length) blocks[blocks.length - 1] += `\n${line}`;
  }
  const subs = new Map();
  for (const block of blocks) {
    const m = block.match(new RegExp(`^pipeline ${cmd}\\s+([a-z][a-z-]*)(?=\\s|$)`));
    if (m) subs.set(m[1], `${subs.get(m[1]) ?? ''}\n${block}`);
  }
  return { subs: subs.size ? subs : null, text: usage };
}

// Every inline code span and fenced block of a markdown file (spans may wrap across lines).
function codeSpans(markdown) {
  const spans = [];
  const stripped = markdown.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    spans.push(body);
    return ' ';
  });
  for (const m of stripped.matchAll(/`([^`]+)`/g)) spans.push(m[1]);
  return spans;
}

const START = /(?:^|[\s(])(?:P|(?:node\s+)?\S*pipeline\.mjs)\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g;

// -> [{ cmd, sub, flags }] for one span. A segment ends at the next invocation start in the span, and a bare `--`
// ends the flags (what follows is the job's own command line, which is itself found as a separate invocation).
export function invocationsIn(span) {
  const starts = [...span.matchAll(START)];
  return starts.map((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : span.length;
    let rest = span.slice(m.index + m[0].length, end);
    const dd = rest.search(/(?:^|\s)--(?:\s|$)/);
    if (dd >= 0) rest = rest.slice(0, dd);
    const flags = [...rest.matchAll(/(?:^|[\s[(])(--[a-z][a-z0-9-]*)/g)].map((f) => f[1]);
    // Flags may sit between the command and its subcommand (never in this repo's docs, but cheap to reject loudly).
    return { cmd: m[1], sub: m[2], flags: [...flags, ...[...m[0].matchAll(/--[a-z][a-z0-9-]*/g)].map((f) => f[0])] };
  });
}

const modules = {};
for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.mjs'))) {
  const name = file.slice(0, -4);
  const mod = await import(pathToFileURL(join(commandsDir, file)).href);
  modules[name] = parseUsage(name, mod.meta?.usage ?? '');
}

const docs = [...walk(join(root, 'skills')), ...walk(join(root, 'agents'))];

test('the extractor finds what it should (guards against a vacuous pass)', () => {
  const found = invocationsIn('P job start codex-rN -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review --pr <N> --round 2');
  assert.deepEqual(found.map((f) => [f.cmd, f.sub]), [['job', 'start'], ['codex-review', undefined]]);
  assert.deepEqual(found[0].flags, [], 'flags after the bare -- belong to the nested command');
  assert.deepEqual(found[1].flags, ['--pr', '--round']);
  assert.deepEqual(invocationsIn('x P labels ensure y').map((f) => [f.cmd, f.sub]), [['labels', 'ensure']]);
  assert.deepEqual(invocationsIn('P protect --repo . [--apply]')[0].flags, ['--repo', '--apply']);
  const total = docs.flatMap((d) => codeSpans(readFileSync(d, 'utf8')).flatMap(invocationsIn));
  assert.ok(total.length > 40, `only ${total.length} invocations found in ${docs.length} docs`);
  assert.ok(new Set(total.map((i) => i.cmd)).size > 15, 'the docs should exercise most commands');
});

for (const doc of docs) {
  test(`${relative(root, doc)}: every pipeline invocation matches the CLI`, () => {
    const problems = [];
    for (const span of codeSpans(readFileSync(doc, 'utf8'))) {
      for (const { cmd, sub, flags } of invocationsIn(span)) {
        const shown = `${cmd}${sub ? ` ${sub}` : ''}`;
        const mod = modules[cmd];
        if (!mod) {
          problems.push(`\`${shown}\`: no such command (pipeline/commands/${cmd}.mjs)`);
          continue;
        }
        let usage = mod.text;
        if (mod.subs) {
          if (!sub || !mod.subs.has(sub)) {
            problems.push(`\`${shown}\`: ${cmd} needs one of: ${[...mod.subs.keys()].join(', ')}`);
            continue;
          }
          usage = mod.subs.get(sub);
        }
        for (const flag of new Set(flags)) {
          if (!new RegExp(`${flag}(?![a-z0-9-])`).test(usage)) problems.push(`\`${shown} ${flag}\`: ${flag} is not in the usage of ${cmd}${mod.subs ? ` ${sub}` : ''}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
}
