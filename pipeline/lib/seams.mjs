// Test seams are for the repo checkout only (see below), kept apart from proc.mjs (which spawns processes and so loads
// node:child_process) so that code that only has to decide whether a seam is honoured, such as lib/stacks/paths.mjs on the stack
// hooks' cheap path, does not load it. proc.mjs re-exports everything here, so every existing import keeps working; seamFlag and
// overrideCommand, which build on seamValue, stay in proc.mjs. Imports: node:fs, node:path and node:url only. Lives in the same
// directory as proc.mjs, so the pipeline root (the directory above it) is unchanged. The root is worked out on first use
// (pipelineRoot), not at import: the hooks' fast path imports this module and usually needs no root at all.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- test seams are for the repo checkout only ----
// PIPELINE_GH / PIPELINE_CODEX / PIPELINE_VERCEL swap the tool the gate trusts for a script, PIPELINE_TEST_MODE relaxes
// the arbiter's model proof, and PIPELINE_UPDATE_REMOTE points `pipeline update` at another repository to fetch from. They exist so the test suite can run the real CLI against fakes; a production install must
// never honour them (an environment variable set by anything that can launch the CLI would otherwise decide what the
// gate sees). An installed copy is recognised by the INSTALLED.json manifest the installer writes into the pipeline root
// (the directory holding bin/); the repo checkout has none. When installed, a seam is ignored with one warning on stderr.
let cachedRoot;
export const pipelineRoot = () => (cachedRoot ??= fileURLToPath(new URL('..', import.meta.url)));
// PIPELINE_DOCKER / PS / LSOF / SUPABASE / STACKS_DEADLINE_MS belong to the stack-stop hooks: they are read through stacksSeam
// (lib/stacks/paths.mjs), which additionally requires an isolated state root.
export const SEAM_VARS = [
  'PIPELINE_GH', 'PIPELINE_CODEX', 'PIPELINE_VERCEL', 'PIPELINE_TEST_MODE', 'PIPELINE_UPDATE_REMOTE',
  'PIPELINE_DOCKER', 'PIPELINE_PS', 'PIPELINE_LSOF', 'PIPELINE_SUPABASE', 'PIPELINE_STACKS_DEADLINE_MS',
];
export const isInstalledCopy = (dir = pipelineRoot()) => existsSync(path.join(dir, 'INSTALLED.json'));

const warned = new Set();
// The value of a test seam variable (call env first, then process.env), or undefined when unset or not honoured.
// `root` and `warn` are injectable for tests.
export function seamValue(name, env, { root = pipelineRoot(), warn = (m) => process.stderr.write(m) } = {}) {
  const raw = env?.[name] ?? process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!isInstalledCopy(root)) return raw;
  if (!warned.has(name)) {
    warned.add(name);
    warn(`pipeline: ignoring ${name}: test seams are not honoured by an installed copy\n`);
  }
  return undefined;
}
