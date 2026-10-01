// Starts a grandchild that sleeps 30 s, records its pid in the file given as argv[2], then sleeps
// itself. The grandchild inherits our stdio, so it also holds the parent's output pipes open: a
// timeout that kills only the direct child would leave it alive (and a sync caller hanging).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'inherit' });
writeFileSync(process.argv[2], String(grandchild.pid));
setTimeout(() => {}, 30000);
