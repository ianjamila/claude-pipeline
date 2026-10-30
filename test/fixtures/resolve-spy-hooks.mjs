// The module-customization hooks behind resolve-spy-preload.mjs (they run on a separate thread, so they write synchronously).
import fs from 'node:fs';

const THROWING = 'export const registerFastSkip = () => { throw new Error("simulated fast-path failure"); };'
  + 'export const devBindFastSkip = () => { throw new Error("simulated fast-path failure"); };'
  + 'export const registerCanSkip = registerFastSkip; export const devBindCanSkip = devBindFastSkip;';

export async function resolve(specifier, context, nextResolve) {
  const next = await nextResolve(specifier, context);
  const log = process.env.RESOLVE_SPY_LOG;
  if (log) fs.appendFileSync(log, `${next.url}\n`);
  const [file, mode] = String(process.env.RESOLVE_SPY_BREAK ?? '').split(':');
  if (file && next.url.endsWith(`/${file}`)) {
    if (mode === 'import') throw new Error(`simulated: ${file} cannot be loaded`);
    if (mode === 'throw') return { url: `data:text/javascript,${encodeURIComponent(THROWING)}`, shortCircuit: true };
  }
  return next;
}
