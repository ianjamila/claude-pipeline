// Preloaded (node --import) into a spawned hook: registers resolve-spy-hooks.mjs, which appends every module URL the process
// resolves to the file named in RESOLVE_SPY_LOG. Proves which libraries a hook did or did not load. RESOLVE_SPY_BREAK=<file>:<mode>
// also breaks the module whose URL ends in /<file>: mode `import` makes importing it fail, mode `throw` makes it load with
// exports that throw when called (see the hooks file).
import { register } from 'node:module';

register('./resolve-spy-hooks.mjs', import.meta.url);
