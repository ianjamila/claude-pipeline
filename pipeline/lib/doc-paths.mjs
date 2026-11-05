// What counts as a document, by path alone. One definition for the final gate (docs-only diffs may skip CI checks) and for
// config validation (review.docs_exempt_paths may list only documents). Its own small module because config.mjs is vendored
// into projects and finalgate.mjs is not: the vendored CI runner must be able to validate the config without finalgate.
import { toPosix } from './paths.mjs';

// Docs-only is deliberately narrow: markdown anywhere (not .mdx, which can hold executable JSX), text/reStructuredText/AsciiDoc
// under the root docs/ directory, and the LICENSE / CHANGELOG files. A .txt anywhere else (requirements.txt, CMakeLists.txt, a
// prompt file) is code.
const MARKDOWN = /\.(?:md|markdown)$/i;
const DOCS_DIR_TEXT = /\.(?:md|markdown|txt|rst|adoc)$/i;
const DOC_NAMES = /^(?:license|licence|changelog)(?:\.(?:md|markdown|txt))?$/i;
// Agent instruction files steer what an agent does next, so they are code wherever they sit (docs/ included). Any CLAUDE / AGENTS /
// AGENT / GEMINI .md, and any .<variant>.md of them (.override, .local ...: read by the same tools, they win over the committed
// file), by name at any depth and case; AGENT.md (singular) is read by Amp and OpenCode.
const AGENT_INSTRUCTION_NAME = /^(?:claude|agents?|gemini)(?:\.[^.]+)?\.md$/i;
const AGENT_INSTRUCTION_FILES = new Set(['.cursorrules', 'copilot-instructions.md']);
// Instructions, hooks, workflows and the pipeline itself: text files here change what agents or CI do, so they are code.
// Any directory whose name starts with "." (.claude, .github, .githooks, .cursor, .windsurf, .clinerules, .gemini, .roo, .kiro ...)
// is never docs either (tools keep their rules there); that is a rule on directory segments, so a root file like .foo.md is judged by its name.
const NEVER_DOCS_DIRS = new Set(['skills', 'agents', 'pipeline', 'scripts']);
// Next route directories: markdown there is a page when pageExtensions include md (hardstops.mjs MD_ROUTE_GLOBS). Over-matches
// on purpose: any app/ or pages/ segment, in any case, even under docs/.
const ROUTE_DIRS = new Set(['app', 'pages']);
const neverDocsDir = (d) => {
  const l = d.toLowerCase();
  return l.startsWith('.') || NEVER_DOCS_DIRS.has(l) || ROUTE_DIRS.has(l);
};

export function isDocPath(p) {
  const parts = toPosix(p).replace(/^\.\//, '').split('/');
  const name = parts.at(-1);
  if (AGENT_INSTRUCTION_NAME.test(name) || AGENT_INSTRUCTION_FILES.has(name.toLowerCase()) || parts.slice(0, -1).some(neverDocsDir)) return false;
  if (MARKDOWN.test(name) || DOC_NAMES.test(name)) return true;
  return parts.length > 1 && parts[0].toLowerCase() === 'docs' && DOCS_DIR_TEXT.test(name);
}
