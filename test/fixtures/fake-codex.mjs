// A scriptable stand-in for `codex exec`, wired in through PIPELINE_CODEX (`node <this file>`). Real codex receives the
// prompt on stdin and writes its structured answer to the file named by `-o <path>`; this does the same, steered by env:
//   FAKE_CODEX_CAPTURE=<file>  append {argv, stdin} as one JSON line (so a test can assert on the prompt and argv)
//   FAKE_CODEX_EXIT=<n>        exit n (with FAKE_CODEX_STDERR on stderr) without writing any output
//   FAKE_CODEX_NO_WRITE=1      exit 0 without writing the output file (a run that "succeeded" but produced nothing)
//   FAKE_CODEX_OUTPUT=<file>   copy that file's bytes to the `-o` path (a findings JSON, or garbage for a malformed run)
import { appendFileSync, copyFileSync } from 'node:fs';

const argv = process.argv.slice(2);

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.FAKE_CODEX_CAPTURE) {
  appendFileSync(process.env.FAKE_CODEX_CAPTURE, `${JSON.stringify({ argv, stdin })}\n`);
}

const exit = Number(process.env.FAKE_CODEX_EXIT ?? 0);
if (exit !== 0) {
  process.stderr.write(process.env.FAKE_CODEX_STDERR ?? '');
  process.exit(exit);
}

if (process.env.FAKE_CODEX_NO_WRITE !== '1') {
  const at = argv.indexOf('-o');
  if (at < 0 || !argv[at + 1]) {
    process.stderr.write('fake-codex: no -o <path> in argv');
    process.exit(98);
  }
  if (!process.env.FAKE_CODEX_OUTPUT) {
    process.stderr.write('fake-codex: FAKE_CODEX_OUTPUT is not set');
    process.exit(98);
  }
  copyFileSync(process.env.FAKE_CODEX_OUTPUT, argv[at + 1]);
}
