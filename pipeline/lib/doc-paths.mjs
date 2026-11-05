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
// Agent instruction files steer what an agent does next, so they are code wherever they sit (docs/ included).
const AGENT_INSTRUCTION_FILES = new Set(['claude.md', 'agents.md', 'gemini.md', '.cursorrules', 'copilot-instructions.md']);
// Instructions, hooks, workflows and the pipeline itself: text files here change what agents or CI do, so they are code.
const NEVER_DOCS_DIRS = new Set(['.claude', '.github', '.githooks', 'skills', 'agents', 'pipeline', 'scripts']);

export function isDocPath(p) {
  const parts = toPosix(p).replace(/^\.\//, '').split('/');
  const name = parts.at(-1);
  if (AGENT_INSTRUCTION_FILES.has(name.toLowerCase()) || parts.slice(0, -1).some((d) => NEVER_DOCS_DIRS.has(d.toLowerCase()))) return false;
  if (MARKDOWN.test(name) || DOC_NAMES.test(name)) return true;
  return parts.length > 1 && parts[0].toLowerCase() === 'docs' && DOCS_DIR_TEXT.test(name);
}
