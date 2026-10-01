#!/usr/bin/env node
// Entry point for every deterministic pipeline decision. Subcommands live one per file in
// ../commands/<name>.mjs and export `meta` ({summary, usage}) and `run(argv, ctx)`.
// Loading by file name lets commands be added without touching this dispatcher.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emit, errorResult, EXIT } from '../lib/cli.mjs';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

function listCommands() {
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort();
}

async function usage() {
  const lines = ['usage: pipeline <command> [options]', '', 'commands:'];
  for (const name of listCommands()) {
    const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
    lines.push(`  ${name.padEnd(16)} ${mod.meta?.summary ?? ''}`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), ctx = {}) {
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    process.stderr.write((await usage()) + '\n');
    return emit({ exitCode: name ? EXIT.OK : EXIT.USAGE, output: { ok: !!name, commands: listCommands() } });
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !listCommands().includes(name)) {
    process.stderr.write((await usage()) + '\n');
    return emit({ exitCode: EXIT.USAGE, output: { ok: false, error: 'usage', message: `unknown command: ${name}` } });
  }
  const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
  // Only flags BEFORE a `--` ask for help: after it come a command's own arguments (`job start x -- ls -h`), and
  // answering those with usage + exit 0 would look like a job that started.
  const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (own.includes('--help') || own.includes('-h')) {
    process.stderr.write(`${mod.meta?.usage ?? name}\n`);
    return emit({ exitCode: EXIT.OK, output: { ok: true, usage: mod.meta?.usage ?? name } });
  }
  try {
    const result = await mod.run(rest, { cwd: process.cwd(), env: process.env, ...ctx });
    return emit(result);
  } catch (err) {
    return emit(errorResult(err));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
