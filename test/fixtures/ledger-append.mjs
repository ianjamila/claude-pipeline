// Test helper: a separate OS process that appends events to a stack-stop ledger through the real appendEvent (and so
// through the real ledger lock). Usage: node ledger-append.mjs <file> <lockDir> <count> <tag> [waitMs]
// Prints "start" before the first append and "done <failures>" after the last; a failed append is counted, not thrown.
import { appendEvent } from '../../pipeline/lib/stacks/ledger.mjs';

const [file, lockDir, count, tag, waitMs] = process.argv.slice(2);
console.log('start');
let failures = 0;
for (let i = 0; i < Number(count); i++) {
  const r = await appendEvent(file, { t: new Date().toISOString(), kind: 'use', project: 'p', tag, i }, { lockDir, waitMs: Number(waitMs ?? 60000) });
  if (!r.ok) {
    failures++;
    console.error(r.reason);
  }
}
console.log(`done ${failures}`);
