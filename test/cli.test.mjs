import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const cli = (...args) => {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

test('no command → usage error exit 2 with command list', () => {
  const r = cli();
  assert.equal(r.code, 2);
  assert.ok(r.json.commands.includes('version'));
});

test('unknown command → exit 2', () => {
  const r = cli('nope');
  assert.equal(r.code, 2);
  assert.match(r.json.message, /unknown command: nope/);
});

test('path-like command names are rejected, not imported', () => {
  assert.equal(cli('../lib/cli').code, 2);
});

test('version prints one JSON object', () => {
  const r = cli('version');
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
});

test('unknown flag is a usage error', () => {
  const r = cli('version', '--bogus');
  assert.equal(r.code, 2);
  assert.equal(r.json.error, 'usage');
});

// ---- --help lists every command with its summary --------------------------------------------------


const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'commands');
const commandFiles = readdirSync(commandsDir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();

test('every command module exports meta.summary and meta.usage', async () => {
  assert.ok(commandFiles.length > 20);
  for (const name of commandFiles) {
    const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
    assert.equal(typeof mod.run, 'function', `${name} exports run`);
    assert.equal(typeof mod.meta?.summary, 'string', `${name} meta.summary`);
    assert.ok(mod.meta.summary.trim().length > 0, `${name} meta.summary is empty`);
    assert.equal(typeof mod.meta?.usage, 'string', `${name} meta.usage`);
    assert.ok(mod.meta.usage.includes(`pipeline ${name}`), `${name} meta.usage should show \`pipeline ${name}\``);
  }
});

test('--help and an unknown command both list every command with its summary (stdout JSON and stderr text)', async () => {
  for (const [args, code] of [[['--help'], 0], [['-h'], 0], [['help'], 0], [[], 2], [['nope'], 2], [['no-such-command'], 2]]) {
    const r = cli(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.deepEqual(r.json.commands, commandFiles, `${args.join(' ')}: commands`);
    for (const name of commandFiles) {
      const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
      assert.equal(r.json.summaries[name], mod.meta.summary, `${args.join(' ')}: summary of ${name}`);
      assert.ok(r.stderr.includes(`  ${name.padEnd(16)} ${mod.meta.summary}`), `${args.join(' ')}: stderr lists ${name}`);
    }
  }
  assert.equal(cli('nope').json.ok, false);
  assert.match(cli('nope').json.message, /unknown command: nope/);
});

test('docs/cli.md has a section for every command with its usage verbatim', async () => {
  const doc = readFileSync(join(commandsDir, '..', '..', 'docs', 'cli.md'), 'utf8');
  for (const name of commandFiles) {
    const mod = await import(pathToFileURL(join(commandsDir, `${name}.mjs`)).href);
    assert.ok(doc.includes(`\n## ${name}\n`), `docs/cli.md has no "## ${name}" section`);
    assert.ok(doc.includes(mod.meta.usage), `docs/cli.md: the usage of ${name} is out of date (copy meta.usage)`);
  }
  assert.equal([...doc.matchAll(/^## (?!Where this differs)(\S+)$/gm)].length, commandFiles.length, 'docs/cli.md documents a command that does not exist');
});
