// A scratch Fable-floor folder for tests that run the real CLI from the checkout (PIPELINE_MODEL_FLOOR_DIR is honoured by a checkout only), so no
// test reads or writes the account's real registry. One folder per test process, removed when the process ends; a test that raises the floor
// makes its own with scratchFloorDir().
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// A fresh, empty parent folder; the floor folder is `<parent>/model-floor` (created by the library on first write).
export function scratchFloorDir() {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-floor-')));
  made.push(parent);
  return join(parent, 'model-floor');
}

export const SHARED_FLOOR_DIR = scratchFloorDir();
// PIPELINE_CODEX_STATUS_DIR: the machine-wide Codex outage record codex-review writes on a quota stop; a scratch folder, so no test touches the account's real one.
const SHARED_STATUS_DIR = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-codex-status-'))), 'codex');
made.push(join(SHARED_STATUS_DIR, '..'));
export const floorEnv = (dir = SHARED_FLOOR_DIR) => ({ PIPELINE_MODEL_FLOOR_DIR: dir, PIPELINE_CODEX_STATUS_DIR: SHARED_STATUS_DIR });
