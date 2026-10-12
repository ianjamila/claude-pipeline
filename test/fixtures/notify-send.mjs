// Test helper: a separate OS process that sends one notification through the real ledger and the real machine lock, with
// a fake ntfy (a fetch that appends a line to <countFile> after <delayMs>), so notify.test.mjs can prove that several
// processes racing on the same event produce exactly one send.
// Usage: node notify-send.mjs <stateDir> <secretsFile> <countFile> <delayMs> [--go <file>]
import { appendFileSync, existsSync } from 'node:fs';
import { notifyEvent } from '../../pipeline/lib/notify.mjs';

const [stateDir, secretsFile, countFile, delayMs, ...flags] = process.argv.slice(2);
const goFile = flags[0] === '--go' ? flags[1] : null;
if (goFile) {
  console.log('ready');
  while (!existsSync(goFile)) {
    // busy-wait on purpose: the racing children should start in the same instant
  }
}
const result = await notifyEvent(
  { event: 'stopped', pr: 7, title: 'Race', action: 'Read the PR', outcome: 'stopped', head: 'deadbeef' },
  {
    env: {},
    secretsFile,
    stateDir,
    git: (args) => (args[0] === 'remote' ? 'https://github.com/acme/widgets.git' : 'deadbeef'),
    isWsl: () => false,
    fetch: async () => {
      appendFileSync(countFile, 'send\n');
      await new Promise((r) => setTimeout(r, Number(delayMs)));
      return { ok: true, status: 200 };
    },
  },
);
console.log(JSON.stringify(result));
