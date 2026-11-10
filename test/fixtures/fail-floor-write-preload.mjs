// Preloaded (node --import) into a spawned CLI: the rename that publishes the Fable floor registry (fable.json) fails like a full disk would, so a
// test can prove an unwritable registry fails the proof and publishes nothing. Every other rename (state, lock) works as usual.
import fs from 'node:fs';

const rename = fs.renameSync;
fs.renameSync = function renameSync(from, to, ...rest) {
  if (String(to).endsWith('fable.json')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  return rename.call(this, from, to, ...rest);
};
