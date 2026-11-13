// Prints the static import/export-from specifiers of JavaScript module sources, using V8's own module parser (no hand-written scanner,
// so regex literals, nested templates and comments are handled by the engine itself).
// Run by test/repo-risk-config.test.mjs as: node --experimental-vm-modules --no-warnings test/fixtures/static-imports.mjs
//   stdin:  a JSON array of source texts
//   stdout: a JSON array of arrays, one list of specifiers per source, in source order
// A source that does not parse as a module throws, so the process exits non-zero and the caller fails closed.
import vm from 'node:vm';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const sources = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!Array.isArray(sources) || !sources.every((s) => typeof s === 'string')) throw new Error('stdin must be a JSON array of strings');
if (typeof vm.SourceTextModule !== 'function') throw new Error('vm.SourceTextModule is missing: run with --experimental-vm-modules');

const out = sources.map((source, i) => {
  const mod = new vm.SourceTextModule(source, { identifier: `source-${i}` });
  // moduleRequests is the current API; Node 20 only has dependencySpecifiers.
  const specs = Array.isArray(mod.moduleRequests) ? mod.moduleRequests.map((r) => r.specifier) : mod.dependencySpecifiers;
  if (!Array.isArray(specs)) throw new Error('this Node exposes neither moduleRequests nor dependencySpecifiers');
  return [...specs];
});
process.stdout.write(JSON.stringify(out));
