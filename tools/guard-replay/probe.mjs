// usage: node tools/guard-replay/probe.mjs <cases.json> <root>...
// Prints the git + files decision (a=allow, d=deny; git first) for each case [{c, spec, note}] under every root (a dir holding pipeline/).
// Masks (so a fixture does not trip the live guard hooks): ma@@ -> main, pu@@ -> push, .cl@@ -> .claude
import fs from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const unmask = (s) => s.replaceAll('ma@@', 'main').replaceAll('pu@@', 'push').replaceAll('.cl@@', '.claude');
function fakeFs(root, files) {
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [resolve(root, unmask(k)), unmask(v)]));
  const D = new Set([root, '/home/u']);
  for (const p of Object.keys(F)) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) D.add(d);
  return { readText: (p) => F[resolve(p)] ?? null, readHead: () => null, pathExists: (p) => resolve(p) in F || D.has(resolve(p)), existsSync: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? [...new Set(Object.keys(F).filter((x) => dirname(x) === resolve(p)).map((x) => basename(x)))] : null), realpath: (p) => p };
}
const [casesFile, ...roots] = process.argv.slice(2);
const pol = [];
for (const r of roots) {
  const G = (await import(pathToFileURL(join(r, 'pipeline/hooks/lib/git-policy.mjs')).href)).evaluateGitCommand;
  const F = (await import(pathToFileURL(join(r, 'pipeline/hooks/lib/files-policy.mjs')).href)).evaluateBashForFiles;
  pol.push({ name: basename(r), G, F });
}
for (const { c, spec, note } of JSON.parse(fs.readFileSync(casesFile, 'utf8'))) {
  const cmd = unmask(c);
  const o = { cwd: '/work/repo', home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], platform: 'linux', env: { HOME: '/home/u', ZDOTDIR: '/home/u' }, ...fakeFs('/work/repo', spec ?? {}) };
  const cols = pol.map(({ name, G, F }) => {
    const t = Date.now();
    let g, f;
    try { g = G(cmd, o).decision; } catch (e) { g = 'THROW'; }
    try { f = F(cmd, o).decision; } catch (e) { f = 'THROW'; }
    return `${name}=${g[0]}${f[0]}(${Date.now() - t}ms)`;
  });
  console.log(cols.join(' '), ' ', note ?? '', JSON.stringify(c).slice(0, 100));
}
