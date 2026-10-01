// A scriptable stand-in for the `supabase` CLI (no docker). Run as `node fake-supabase.mjs <args>`; behaviour is set by
// environment variables so a test never starts a real stack:
//   FAKE_SB_STATE   dir holding a `running` marker (start creates it; status succeeds only while it exists)
//   FAKE_SB_LOG     appended with one JSON line {argv, cwd} per call
//   FAKE_SB_START_CODE / FAKE_SB_RESET_CODE / FAKE_SB_TEST_CODE   exit codes (default 0)
//   FAKE_SB_HELP    "new" (mailpit, default) | "old" (inbucket) | "none" (no bracketed list) | "fail"
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_SB_LOG) appendFileSync(process.env.FAKE_SB_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
const marker = join(process.env.FAKE_SB_STATE ?? '.', 'running');
const code = (name) => Number(process.env[`FAKE_SB_${name}_CODE`] ?? 0);
const [a, b] = argv;

if (a === 'start' && argv.includes('--help')) {
  const mode = process.env.FAKE_SB_HELP ?? 'new';
  if (mode === 'fail') process.exitCode = 1;
  else {
    const list = mode === 'old' ? 'gotrue,realtime,storage-api,imgproxy,kong,inbucket,postgrest,postgres-meta,studio,edge-runtime,logflare,vector'
      : 'gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor';
    process.stdout.write(`DESCRIPTION\n  Start containers.\n\nFLAGS\n  --exclude, -x string     Names of containers to not start.${mode === 'none' ? '' : ` [${list}]`}\n`);
  }
} else if (a === 'start') {
  process.stdout.write('Starting database...\n');
  if (code('START') !== 0) {
    process.stderr.write('port is already allocated\n');
    process.exitCode = code('START');
  } else {
    writeFileSync(marker, '1');
  }
} else if (a === 'status') {
  if (existsSync(marker)) {
    process.stdout.write('Stopped services: [supabase_studio_x]\n');
    process.stdout.write(`${JSON.stringify({
      API_URL: 'http://127.0.0.1:55321', DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
      ANON_KEY: 'anon-key', SERVICE_ROLE_KEY: 'service-key', STUDIO_URL: 'http://127.0.0.1:55323',
    }, null, 2)}\n`);
  } else {
    process.stderr.write('supabase start is not running.\n');
    process.exitCode = 1;
  }
} else if (a === 'db' && b === 'reset') {
  process.stdout.write('Resetting local database...\n');
  process.exitCode = code('RESET');
} else if (a === 'test' && b === 'db') {
  process.stdout.write('All tests successful.\n');
  process.exitCode = code('TEST');
} else {
  process.stderr.write(`fake-supabase: unexpected ${argv.join(' ')}\n`);
  process.exitCode = 99;
}
