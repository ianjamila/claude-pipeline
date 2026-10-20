// Preloaded (node --import) into a spawned hook: at process exit writes the process's own CPU time (user + system, in ms) to the
// file named in CPU_PROBE_LOG. Used to assert a hook's cost in CPU time, never the clock: a busy machine must not fail the test.
import fs from 'node:fs';

const log = process.env.CPU_PROBE_LOG;
process.on('exit', () => {
  const u = process.cpuUsage();
  fs.writeFileSync(log, `${(u.user + u.system) / 1000}\n`);
});
