// #261 (R1-B2): the ONE reading of a skill's / agent's / command's YAML front matter that both the guard (files-policy.mjs: may this edit add or alter hooks?) and the dialog-hook inventory
// (dialog-hooks.mjs: which handlers can run on the owner's dialogs?) use, so what one sees the other sees. No YAML reader: only the TOP-LEVEL keys are looked at.
//   - lines end at CRLF, CR or LF (YAML's rule: a lone CR is a line break); a NEL, LS or PS character in the block is a break only some readers honour: `failClosed`;
//   - the opening line is `---` (any whitespace-only tail, a BOM and blank lines before it allowed); the block ends at the next `---` (a `...` line does not end it: a reader that ignores it keeps reading) or, when there
//     is no closing line, at the end of the text (fail closed: the whole rest);
//   - a first content line that is indented means the whole root mapping is indented (valid YAML, but no top-level key is visible here): `failClosed`;
//   - a top-level key is a plain word (`hooks:`), or the same word in plain quotes without escapes (`"hooks":`, `'hooks':`);
//   - a top-level line that opens another construct (a quoted key with an escape or anything else, a flow mapping `{`, a flow sequence `[`, a complex key `? `, a merge key `<<`, an anchor, an alias, a tag,
//     a block scalar indicator ...) may name `hooks` in a way read here only by guessing: `failClosed` (the caller treats it as an unresolvable hook / a change it cannot compare).
// Pure: no imports, no file access.

const KEY_PLAIN = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?=[ \t]|$)/;
const KEY_QUOTED = /^(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)')[ \t]*:(?=[ \t]|$)/;
const OPENS_OTHER_CONSTRUCT = /^["'{[?<&*!%|>@`]/;
const CLOSING = /^---\s*$/;

// -> null (no front matter) | { lines, closed, failClosed, hooks: [{ line, rest, children }] }; `rest` is the key line after its colon, comment and blanks removed.
export function readFrontmatter(text) {
  const t = String(text ?? '').replace(/^﻿/, '');
  const raw = t.split(/\r\n|\r|\n/);
  const first = raw.findIndex((l) => l.trim() !== '');
  if (first === -1 || !CLOSING.test(raw[first]) || first === raw.length - 1) return null; // (no line break after the opener: no front matter)
  const all = raw.slice(first + 1);
  const end = all.findIndex((l) => CLOSING.test(l));
  const lines = end === -1 ? all : all.slice(0, end);
  let failClosed = lines.some((l) => /[\u0085\u2028\u2029]/.test(l));
  let seenContent = false;
  const hooks = [];
  let open = null; // the hooks block being collected
  for (const l of lines) {
    const topLevel = l !== '' && !/^\s/.test(l) && !l.startsWith('#') && !/^-(?:\s|$)/.test(l);
    if (!seenContent && l.trim() !== '' && !l.trim().startsWith('#')) { seenContent = true; if (/^\s/.test(l)) failClosed = true; }
    if (!topLevel) { if (open) open.children.push(l); continue; }
    open = null;
    const q = KEY_QUOTED.exec(l);
    const key = KEY_PLAIN.exec(l)?.[1] ?? (q ? (q[1] ?? q[2]) : null);
    if (key === null) { if (OPENS_OTHER_CONSTRUCT.test(l)) failClosed = true; continue; } // (any other text is a plain scalar key with spaces or punctuation: not `hooks`)
    if (key !== 'hooks') continue;
    const after = l.slice(l.indexOf(':') + 1);
    open = { line: l, rest: after.replace(/(?:^|\s)#.*$/, '').trim(), children: [] };
    hooks.push(open);
  }
  return { lines, closed: end !== -1, failClosed, hooks };
}

// The comparable value of a file's front-matter hooks for the guard: '' when there are none; a text that changes whenever the block does; for a front matter that cannot be read with certainty, the
// whole front matter (any edit of it then differs, an edit of the body alone does not).
export function frontmatterHooksValue(text) {
  const f = readFrontmatter(text);
  if (f === null) return '';
  if (f.failClosed) return `\u0000unreadable\u0000${f.lines.join('\n')}`;
  return f.hooks.map((h) => [h.line, ...h.children].join('\n')).join('\n\u0000\n');
}
