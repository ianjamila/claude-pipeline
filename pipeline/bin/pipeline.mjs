#!/usr/bin/env node
// Entry point for every deterministic pipeline decision. Subcommands live one per file in
// ../commands/<name>.mjs and export `meta` ({summary, usage}) and `run(argv, ctx)`.
// Loading by file name lets commands be added without touching this dispatcher.
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emit, errorResult, EXIT } from '../lib/cli.mjs';
import { holdReviewLease, isLeasedCommand, readInstalledStamp, releaseHeldLease, settleReviewLease } from '../lib/review-lease-wiring.mjs';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

function listCommands() {
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort();
}

// Every command and its one-line summary, read from the modules themselves (a new file in commands/ shows up here
// without touching this dispatcher). Text goes to stderr for people, `summaries` into the JSON for scripts.
async function catalogue() {
  const summaries = {};
  for (const name of listCommands()) {
    const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
    summaries[name] = mod.meta?.summary ?? '';
  }
  return summaries;
}

function usageText(summaries) {
  const lines = ['usage: pipeline <command> [options]', '       pipeline <command> --help   (usage of one command)', '', 'commands:'];
  for (const [name, summary] of Object.entries(summaries)) lines.push(`  ${name.padEnd(16)} ${summary}`);
  return lines.join('\n');
}

// `ctx.stdout` and `ctx.installedStamp` (a () => string | null | Promise of it) are in-process seams of the tests; `ctx.leaseOpts` goes to the lease library.
export async function main(argv = process.argv.slice(2), ctx = {}) {
  const out = { stdout: ctx.stdout ?? process.stdout };
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    const summaries = await catalogue();
    process.stderr.write(usageText(summaries) + '\n');
    return emit({ exitCode: name ? EXIT.OK : EXIT.USAGE, output: { ok: !!name, commands: listCommands(), summaries } }, out);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !listCommands().includes(name)) {
    const summaries = await catalogue();
    process.stderr.write(usageText(summaries) + '\n');
    return emit({ exitCode: EXIT.USAGE, output: { ok: false, error: 'usage', message: `unknown command: ${name}`, commands: listCommands(), summaries } }, out);
  }
  // The installed identity BEFORE the command module is imported (installed copy only; a checkout reads null): an update that swaps files between this read and
  // the lease below means the module graph about to load may not match the install the lease protects (plan R4-5 ii). Leased commands only.
  const readStamp = ctx.installedStamp ?? readInstalledStamp;
  const stampBefore = isLeasedCommand(name) ? await readStamp() : null;
  const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
  // Only flags BEFORE a `--` ask for help: after it come a command's own arguments (`job start x -- ls -h`), and
  // answering those with usage + exit 0 would look like a job that started.
  const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (own.includes('--help') || own.includes('-h')) {
    process.stderr.write(`${mod.meta?.usage ?? name}\n`);
    return emit({ exitCode: EXIT.OK, output: { ok: true, usage: mod.meta?.usage ?? name } }, out);
  }
  let lease = { held: null };
  let result;
  try {
    const runCtx = { cwd: process.cwd(), env: process.env, ...ctx };
    // The review lease (lib/review-lease-wiring.mjs): taken HERE, before the command, so admission is never waited for while the command holds
    // its per-PR state lock or the floor lock. A command that cannot get its lease does not run.
    lease = await holdReviewLease(name, rest, runCtx);
    if (lease.failure) return emit(lease.failure, out);
    if (lease.held && (await readStamp()) !== stampBefore) {
      await releaseHeldLease(lease.held, runCtx);
      return emit({ exitCode: EXIT.USAGE, output: { ok: false, error: 'updated-while-starting', message: 'the pipeline was updated while this command started; nothing was changed; retry' } }, out);
    }
    result = await mod.run(rest, runCtx);
    await settleReviewLease(name, result, lease.held, runCtx);
    return emit(result, out);
  } catch (err) {
    return emit(errorResult(err), out);
  } finally {
    // A command that threw (or any path that skipped the settle above) closes its lease here too; a second settle is a no-op.
    await settleReviewLease(name, result, lease.held, { env: ctx.env ?? process.env }).catch(() => {});
  }
}

// Node realpaths import.meta.url but not argv[1], so compare real paths (a symlinked ~/.claude, macOS /tmp).
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; });
}
