// Reports the pipeline version as a stamp that says what was proven: an installed copy is hashed against its own
// INSTALLED.json (so an edited or half-finished install is labelled, not trusted), a checkout is compared with HEAD
// and the local origin/main. Suffixes: .modified .incomplete .unverified; `+unknown` when no sha is known.
// See pipeline/lib/identity.mjs for the rules.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, parseCommandArgs } from '../lib/cli.mjs';
import { buildPlan } from '../lib/installer.mjs';
import { checkoutIdentity, formatStamp, installedIdentity } from '../lib/identity.mjs';

export const meta = {
  summary: 'print the pipeline version stamp (base+sha, with .modified/.incomplete/.unverified when not proven)',
  usage: 'pipeline version',
};

const readText = (file) => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };

// The report for the pipeline whose pipeline/ directory is `pipelineDir`: the installed copy when INSTALLED.json sits
// in it, else the checkout holding it.
export function versionReport(pipelineDir) {
  if (existsSync(join(pipelineDir, 'INSTALLED.json'))) {
    const id = installedIdentity(dirname(pipelineDir));
    if (id) {
      return { ok: true, version: id.stamp, base: id.base, sourceSha: id.sourceSha, complete: id.complete, modified: id.modified, missing: id.missing, kind: 'installed' };
    }
    // The manifest is there but unusable (corrupt): nothing vouches for the files.
    const base = readText(join(pipelineDir, 'VERSION')) || 'unknown';
    return { ok: true, version: formatStamp(base, null, ['unverified']), base, sourceSha: null, complete: false, modified: [], missing: [], kind: 'installed' };
  }
  const root = dirname(pipelineDir);
  if (!existsSync(join(root, 'VERSION'))) {
    return { ok: true, version: 'unknown', base: 'unknown', sourceSha: null, complete: true, modified: [], missing: [], kind: 'checkout' };
  }
  const id = checkoutIdentity(root, [...buildPlan(root).files.values()].map((f) => f.abs));
  return { ok: true, version: id.stamp, base: id.base, sourceSha: id.sourceSha, complete: true, modified: id.modified, missing: [], kind: 'checkout' };
}

export async function run(argv) {
  parseCommandArgs(argv, {}, { allowPositionals: false });
  const pipelineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return { exitCode: EXIT.OK, output: versionReport(pipelineDir) };
}
