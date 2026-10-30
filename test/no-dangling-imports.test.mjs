import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A module or test that still imports a deleted file only fails when that path runs. This walks every .mjs file the
// repo ships or tests and checks that each relative import resolves to a file on disk.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['pipeline', 'scripts', 'test', 'install.mjs', '.github/scripts'];
// pipeline/templates holds files copied into other repos; their imports resolve against that layout, not this tree.
const SKIP_DIRS = new Set(['node_modules', '.git', 'templates']);

function collect(p, out) {
  if (!existsSync(p)) return out;
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) collect(join(p, name), out);
  } else if (p.endsWith('.mjs')) {
    out.push(p);
  }
  return out;
}

// Scan the source as JavaScript: comments and template-literal text (test fixtures write whole modules into them) are
// skipped, and a quoted string counts as an import specifier only when the code right before it is `from`, a bare
// `import`, or `import(`. Only relative specifiers (./ or ../) are returned.
const SPEC_BEFORE = /(?:\bfrom|\bimport|\bimport\s*\()\s*$/;
function relativeSpecifiers(src) {
  const found = new Set();
  let code = '';
  let i = 0;
  const skipTemplate = () => {
    // src[i] is the opening backtick
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') i += 2;
      else if (src[i] === '$' && src[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          else if (src[i] === '`') { skipTemplate(); continue; }
          i++;
        }
      } else i++;
    }
    i++;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; }
    else if (c === '`') { skipTemplate(); code += ' '; }
    else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const body = src.slice(i + 1, j);
      if (SPEC_BEFORE.test(code) && /^\.{1,2}\//.test(body)) found.add(body);
      code += ' ';
      i = j + 1;
    } else { code += c; i++; }
    if (code.length > 400) code = code.slice(-200);
  }
  return [...found];
}

test('relativeSpecifiers finds static, re-export, side-effect and literal dynamic imports', () => {
  const src = [
    "import a from './a.mjs';",
    "import { b } from '../lib/b.mjs';",
    "export { c } from './c.mjs';",
    "export * from './d.mjs';",
    "import './e.mjs';",
    "const f = await import('./f.mjs');",
    "import x from 'node:fs';",
    "// import z from './commented.mjs';",
    "const dyn = await import(someVar);",
    "const fixture = `import q from './in-a-template.mjs';`;",
    "const s = 'import w from ./not-a-statement';",
  ].join('\n');
  assert.deepEqual(relativeSpecifiers(src).sort(), ['../lib/b.mjs', './a.mjs', './c.mjs', './d.mjs', './e.mjs', './f.mjs']);
});

test('every relative import in pipeline/, scripts/, test/, install.mjs and .github/scripts resolves to a file', () => {
  const files = ROOTS.flatMap((r) => collect(join(root, r), []));
  assert.ok(files.length > 50, `expected to scan the repo, found ${files.length} files`);
  const dangling = [];
  for (const file of files) {
    for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      if (!existsSync(resolve(dirname(file), spec))) dangling.push(`${relative(root, file)} imports ${spec}`);
    }
  }
  assert.deepEqual(dangling, [], `dangling relative imports:\n${dangling.join('\n')}`);
});
