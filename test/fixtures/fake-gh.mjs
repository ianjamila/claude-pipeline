// A scriptable stand-in for `gh`, so tests never touch GitHub. Point PIPELINE_GH at
// `node <this file>` and describe the replies in the JSON file named by PIPELINE_FAKE_GH_SCRIPT:
//   [{ match: "<regex source>", stdout?, stdoutJson?, stderr?, code? }]
// The first entry whose regex matches the space-joined argv wins. Every call is also appended to
// PIPELINE_FAKE_GH_LOG (one JSON line: argv, cwd, stdin) so tests can assert what was run.
import { readFileSync, appendFileSync } from 'node:fs';

// stdin is read only when something is piped in; a 200 ms cap means an idle inherited stdin never hangs us.
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(finish, 200);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const argv = process.argv.slice(2);
const stdin = await readStdin();

if (process.env.PIPELINE_FAKE_GH_LOG) {
  appendFileSync(process.env.PIPELINE_FAKE_GH_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), stdin })}\n`);
}

const scriptPath = process.env.PIPELINE_FAKE_GH_SCRIPT;
const entries = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [];
const joined = argv.join(' ');
const hit = entries.find((e) => new RegExp(e.match).test(joined));

if (!hit) {
  process.stderr.write(`fake-gh: no match for ${joined}`);
  process.exitCode = 99;
} else {
  if (hit.stdoutJson !== undefined) process.stdout.write(JSON.stringify(hit.stdoutJson));
  else if (hit.stdout) process.stdout.write(hit.stdout);
  if (hit.stderr) process.stderr.write(hit.stderr);
  process.exitCode = hit.code ?? 0;
}
