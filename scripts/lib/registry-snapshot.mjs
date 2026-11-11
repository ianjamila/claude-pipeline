// A snapshot of the account's REAL Fable floor registry (<accountHome>/.claude/pipeline-state/owner-go/model-floor/fable.json), taken before
// and after the test suite: the suite must leave it exactly as it found it (absent stays absent; same bytes, same mtime). Tests run the CLI
// with a scratch PIPELINE_MODEL_FLOOR_DIR; this is the suite-level proof that none of them reached the real one.
import fs from 'node:fs';
import path from 'node:path';
import { accountHome } from '../../pipeline/lib/paths.mjs';
import { FLOOR_REL, REGISTRY_FILE } from '../../pipeline/lib/model-floor.mjs';

export const realRegistryFile = (home = accountHome()) => path.join(home, ...FLOOR_REL.split('/'), REGISTRY_FILE);

// -> { exists: false } | { exists: true, mtimeMs, text }
export function snapshotRegistry(file = realRegistryFile()) {
  try {
    const st = fs.lstatSync(file);
    return { exists: true, mtimeMs: st.mtimeMs, text: fs.readFileSync(file, 'utf8') };
  } catch {
    return { exists: false };
  }
}

// null when unchanged, else a sentence saying what changed.
export function registryChange(before, after, file = realRegistryFile()) {
  if (before.exists !== after.exists) return `the real model floor registry ${file} ${after.exists ? 'was created' : 'was removed'} by the test suite`;
  if (before.exists && (before.text !== after.text || before.mtimeMs !== after.mtimeMs)) return `the real model floor registry ${file} was modified by the test suite`;
  return null;
}
