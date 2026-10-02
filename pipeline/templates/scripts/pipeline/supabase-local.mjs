// A Supabase stack of the pipeline's OWN for `scripts/verify`, separate from the one a developer runs by hand.
// Why: verify resets the database (`supabase db reset`) and runs pgTAP against it. On a shared dev stack that would wipe
// a developer's data, and two worktrees would fight over the same ports. So the project's supabase/ directory is copied
// into .verify/supabase-workdir/, its project_id gets a "-pipeline" suffix (own containers) and every port is shifted by
// an offset derived from the project name (own ports; see portOffsetFor). Nothing here ever touches a remote project: only local commands, never --linked/--db-url.
// verify.mjs holds the machine-wide "db-<project>" lock while using this instance, so two verifies never overlap.
// CLI: node scripts/pipeline/supabase-local.mjs reset-and-test --project X   |   ... env --project X
// Vendored into projects by `pipeline vendor` (imports ./lib/*).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { git } from './lib/git.mjs';
import { run, splitCommand } from './lib/proc.mjs';

export const DEFAULT_PORT_OFFSET = 1000;

// Two projects verifying at once (the lock is per project) must not share ports. The offset comes from a stable hash of
// the project name: 1000 + 20 * (0..299) = 1000..6980, so the dedicated stack uses 55320..61309 (a step of 20 keeps each
// project's ten ports, and the inspector port, apart) and never the developer's own stack (offset 0). The e2e smoke server
// gets 4310 + (0..499) = 4310..4809 from another slice of the same hash and learns it through PIPELINE_SMOKE_PORT.
// Two names can still hash alike (1 in 300): pass --port-offset for one of them.
const hashOf = (project) => createHash('sha256').update(slug(project).toLowerCase()).digest();
export const portOffsetFor = (project) => DEFAULT_PORT_OFFSET + 20 * (hashOf(project).readUInt32BE(0) % 300);
export const SMOKE_PORT_BASE = 4310;
export const smokePortFor = (project) => SMOKE_PORT_BASE + (hashOf(project).readUInt32BE(4) % 500);
// Services verify never needs. `inbucket` is the old name of `mailpit`; the CLI only accepts the names it knows, so the
// list is intersected with what `supabase start --help` advertises (see excludeFlag).
const EXCLUDE_WANTED = ['studio', 'imgproxy', 'edge-runtime', 'logflare', 'vector', 'inbucket', 'mailpit'];
const EXCLUDE_FALLBACK = ['studio', 'imgproxy', 'edge-runtime', 'logflare', 'vector', 'inbucket'];
const START_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 30 * 60_000;
const PORT_KEYS = ['port', 'shadow_port', 'smtp_port', 'pop3_port', 'inspector_port'];

// Safe for docker container names (project_id becomes part of them).
export function slug(project) {
  const s = String(project ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error('project name is required (letters, digits, ".", "_", "-")');
  return s;
}

/**
 * config.toml for the dedicated instance: project_id becomes "<project>-pipeline" and every local service port moves by
 * portOffset. Only `key = number` lines are touched (comments, quoted values and URLs are left alone), and the outbound
 * SMTP port of [auth.email.smtp] is skipped because it names a remote mail server, not a local service.
 */
export function rewriteConfigToml(text, { project, portOffset = DEFAULT_PORT_OFFSET }) {
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 60000) throw new Error('portOffset must be an integer 0..60000');
  const projectId = `${slug(project)}-pipeline`;
  const portRe = new RegExp(`^(\\s*(?:${PORT_KEYS.join('|')})\\s*=\\s*)(\\d+)(\\s*(?:#.*)?)$`);
  let section = '';
  let sawProjectId = false;
  const out = String(text).split('\n').map((raw) => {
    // `.` does not match \r, so a CRLF file would defeat the trailing-comment patterns: match without it, put it back.
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1];
      return raw;
    }
    if (section === '') {
      const id = /^(\s*project_id\s*=\s*)"[^"]*"(\s*(?:#.*)?)$/.exec(line);
      if (id) {
        sawProjectId = true;
        return `${id[1]}"${projectId}"${id[2]}${cr}`;
      }
    }
    const m = portRe.exec(line);
    if (!m || section === 'auth.email.smtp') return raw;
    const moved = Number(m[2]) + portOffset;
    if (moved > 65535) throw new Error(`port ${m[2]} + offset ${portOffset} is above 65535`);
    return `${m[1]}${moved}${m[3]}${cr}`;
  });
  return sawProjectId ? out.join('\n') : `project_id = "${projectId}"\n${out.join('\n')}`;
}

// Files the CLI generates inside supabase/ (never copied, never deleted), secrets (.env*) and dependency folders.
const isGenerated = (rel) => /^\.(temp|branches)(\/|$)/.test(rel);
const isSkipped = (name) => name === 'node_modules' || name.startsWith('.env');

// Relative POSIX paths of every file under dir (following symlinks), minus generated/secret/dependency entries.
function listFiles(dir, rel = '', depth = 0) {
  if (depth > 32) throw new Error(`supabase directory is nested too deeply (symlink loop?): ${dir}`);
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (isSkipped(entry.name) || isGenerated(r)) continue;
    const abs = join(dir, r);
    if (statSync(abs).isDirectory()) out.push(...listFiles(dir, r, depth + 1));
    else out.push(r);
  }
  return out;
}

function pruneEmptyDirs(dir, rel = '') {
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (!entry.isDirectory() || isGenerated(r) || isSkipped(entry.name)) continue;
    pruneEmptyDirs(dir, r);
    if (readdirSync(join(dir, r)).length === 0) rmdirSync(join(dir, r));
  }
}

/**
 * Makes destDir an exact mirror of srcDir (so a migration deleted or renamed in the project disappears from the copy and
 * cannot be applied by the next reset), then writes the rewritten config.toml.
 */
export function syncSupabaseDir(srcDir, destDir, { project, portOffset = DEFAULT_PORT_OFFSET }) {
  const srcConfig = join(srcDir, 'config.toml');
  if (!existsSync(srcConfig)) throw new Error(`${srcConfig} not found: this does not look like a Supabase project`);
  const wanted = listFiles(srcDir);
  mkdirSync(destDir, { recursive: true });
  const keep = new Set(wanted);
  for (const rel of listFiles(destDir)) if (!keep.has(rel)) rmSync(join(destDir, rel), { force: true });
  pruneEmptyDirs(destDir);
  for (const rel of wanted) {
    mkdirSync(dirname(join(destDir, rel)), { recursive: true });
    copyFileSync(join(srcDir, rel), join(destDir, rel));
  }
  writeFileSync(join(destDir, 'config.toml'), rewriteConfigToml(readFileSync(srcConfig, 'utf8'), { project, portOffset }));
}

// supabaseBin may be a command line ("node fake.mjs"), like PIPELINE_GH.
function cli(supabaseBin, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const [cmd, ...prefix] = splitCommand(supabaseBin);
  return run(cmd, [...prefix, ...args], { cwd, timeoutMs });
}

// `supabase start -x` rejects names it does not know, and the mail container was renamed inbucket -> mailpit.
function excludeFlag(supabaseBin, cwd) {
  const help = cli(supabaseBin, ['start', '--help'], { cwd, timeoutMs: 60_000 });
  const line = help.code === 0 ? /--exclude[^\n]*?\[([a-z0-9,-]+)\]/.exec(`${help.stdout}\n${help.stderr}`) : null;
  const names = line ? EXCLUDE_WANTED.filter((n) => line[1].split(',').includes(n)) : EXCLUDE_FALLBACK;
  return names.join(',');
}

function parseStatus(result) {
  if (result.code !== 0) return null;
  const a = result.stdout.indexOf('{');
  const b = result.stdout.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    const j = JSON.parse(result.stdout.slice(a, b + 1));
    return j.API_URL && j.DB_URL ? j : null;
  } catch {
    return null;
  }
}

const tailOf = (r) => `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-15).join('\n');

/**
 * Syncs the project's supabase/ into <repoRoot>/.verify/supabase-workdir/, starts the dedicated instance unless it is
 * already running, and returns { workdir, apiUrl, dbUrl, anonKey, serviceRoleKey }. Synchronous: it is a CLI helper.
 */
export function ensureDedicatedInstance({ repoRoot, project, portOffset = DEFAULT_PORT_OFFSET, supabaseBin = 'supabase' }) {
  const workdir = join(repoRoot, '.verify', 'supabase-workdir');
  syncSupabaseDir(join(repoRoot, 'supabase'), join(workdir, 'supabase'), { project, portOffset });

  const status = () => cli(supabaseBin, ['status', '--workdir', workdir, '-o', 'json'], { cwd: repoRoot });
  let info = parseStatus(status());
  if (!info) {
    const start = cli(supabaseBin, ['start', '--workdir', workdir, '-x', excludeFlag(supabaseBin, repoRoot)], { cwd: repoRoot, timeoutMs: START_TIMEOUT_MS });
    if (start.code !== 0) throw new Error(`supabase start failed (exit ${start.code}):\n${tailOf(start)}`);
    info = parseStatus(status());
    if (!info) throw new Error('supabase started but `supabase status -o json` did not report URLs');
  }
  return {
    workdir,
    apiUrl: info.API_URL,
    dbUrl: info.DB_URL,
    anonKey: info.ANON_KEY ?? info.PUBLISHABLE_KEY ?? null,
    serviceRoleKey: info.SERVICE_ROLE_KEY ?? info.SECRET_KEY ?? null,
  };
}

/** db reset (re-applies every migration + seed), then the pgTAP tests. --local: never a linked or remote database. */
export function resetAndTest({ workdir, supabaseBin = 'supabase', cwd = dirname(dirname(workdir)) }) {
  const reset = cli(supabaseBin, ['db', 'reset', '--local', '--workdir', workdir], { cwd });
  if (reset.code !== 0) return { ok: false, failedStep: 'reset', reset, test: null };
  const test = cli(supabaseBin, ['test', 'db', '--local', '--workdir', workdir], { cwd });
  return { ok: test.code === 0, failedStep: test.code === 0 ? null : 'test', reset, test };
}

// KEY=value lines the build / e2e steps run with.
// With `project`, also the e2e smoke port (PIPELINE_SMOKE_PORT, read by playwright.smoke.config.ts).
export function envLines(info, { project } = {}) {
  const pairs = [
    ['NEXT_PUBLIC_SUPABASE_URL', info.apiUrl],
    ['SUPABASE_URL', info.apiUrl],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', info.anonKey],
    ['SUPABASE_ANON_KEY', info.anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', info.serviceRoleKey],
    ['DATABASE_URL', info.dbUrl],
  ];
  if (project !== undefined) pairs.push(['PIPELINE_SMOKE_PORT', String(smokePortFor(project))]);
  return pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
}

const USAGE = 'usage: supabase-local.mjs reset-and-test|env --project NAME [--repo DIR] [--port-offset N]   (port offset default: derived from the project name; PIPELINE_SUPABASE overrides the supabase command)';

export async function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd() } = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { project: { type: 'string' }, repo: { type: 'string' }, 'port-offset': { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
    const [command, ...rest] = positionals;
    if (!['reset-and-test', 'env'].includes(command) || rest.length > 0) throw new Error(USAGE);
    if (!values.project) throw new Error(`missing --project\n${USAGE}`);
    const portOffset = values['port-offset'] === undefined ? portOffsetFor(values.project) : Number(values['port-offset']);
    if (!Number.isInteger(portOffset)) throw new Error('--port-offset must be an integer');
    const repoRoot = values.repo ? resolve(cwd, values.repo) : resolve(git(['rev-parse', '--show-toplevel'], { cwd }).trim());
    const supabaseBin = env.PIPELINE_SUPABASE?.trim() || 'supabase';

    const info = ensureDedicatedInstance({ repoRoot, project: values.project, portOffset, supabaseBin });
    if (command === 'env') {
      process.stdout.write(`${envLines(info, { project: values.project }).join('\n')}\n`);
      return 0;
    }
    const r = resetAndTest({ workdir: info.workdir, supabaseBin });
    for (const [label, step] of [['db reset', r.reset], ['db test', r.test]]) {
      if (!step) continue;
      process.stdout.write(`$ supabase ${label} (exit ${step.code})\n${step.stdout}${step.stderr ? `\n${step.stderr}` : ''}\n`);
    }
    return r.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`supabase-local: ${err?.message ?? err}\n`);
    return 2;
  }
}

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
