// Preloaded (node --import) into a spawned hook: records every file the process opens or reads, one JSON line each, to the
// file named in FS_SPY_LOG. Used to prove a hook never reads a file (the 100 000-line ledger) it must not touch.
import fs from 'node:fs';

const log = process.env.FS_SPY_LOG;
const note = (op, target, flags) => {
  if (typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target)) {
    fs.appendFileSync(log, `${JSON.stringify({ op, file: String(target), flags: flags ?? null })}\n`);
  }
};
for (const op of ['readFileSync', 'openSync', 'createReadStream', 'readFile', 'open']) {
  const original = fs[op];
  fs[op] = function spied(target, ...rest) {
    note(op, target, op === 'openSync' || op === 'open' ? rest[0] : undefined);
    return original.call(this, target, ...rest);
  };
}
const promisesRead = fs.promises.readFile;
fs.promises.readFile = function spied(target, ...rest) {
  note('promises.readFile', target);
  return promisesRead.call(this, target, ...rest);
};
