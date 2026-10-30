// Quote-aware splitting of a command string, apart from proc.mjs (which spawns processes and so loads node:child_process) so that
// code that only needs to READ a command line, such as the stack hooks' cheap pre-checks (lib/stacks/fastpath.mjs), can do it
// without that. proc.mjs re-exports splitCommand, so every existing import keeps working. No imports.
// Minimal quote-aware splitter for the PIPELINE_GH / PIPELINE_CODEX override strings.
// Single quotes are literal; backslash escapes outside single quotes. Inside double quotes only
// `\"` and `\\` are escapes, so a quoted Windows path keeps its backslashes. On Windows an unquoted
// backslash is always literal (paths), except before a double quote.
export function splitCommand(str, platform = process.platform) {
  const out = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (ch === '\\') {
      if (quote === '"') {
        if (next === '"' || next === '\\') { cur += next; i++; } else cur += ch;
      } else if (platform === 'win32' && next !== '"') {
        cur += ch;
        inToken = true;
      } else if (next !== undefined) {
        cur += next;
        i++;
        inToken = true;
      }
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error(`splitCommand: unterminated ${quote} quote in: ${str}`);
  if (inToken) out.push(cur);
  return out;
}
