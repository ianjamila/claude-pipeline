// What a Read tool_result looks like in a transcript, for the substitute tests: the lines Read returned, each numbered "<n>\t<text>" (cat -n style). Read also stops early at a
// size cap (about 25,000 tokens a call) and still answers normally, so `maxLines` models that: only the first maxLines lines of the requested page come back. `cutRow` (a
// 1-based position in the page) models a row that came back cut short: its text is halved.
import { readFileSync } from 'node:fs';

// -> the tool_result content of Read(input) over the file's current text (the file is read from disk when `text` is not given).
export function readResultText(input, { text, maxLines = Infinity, cutRow } = {}) {
  const body = text ?? readFileSync(input.file_path, 'utf8');
  const all = body === '' ? [] : body.split('\n');
  if (body.endsWith('\n')) all.pop();
  const offset = input.offset === undefined || input.offset < 1 ? 1 : input.offset;
  const limit = input.limit ?? 2000;
  return all.slice(offset - 1, offset - 1 + Math.min(limit, maxLines)).map((l, i) => `${offset + i}\t${i + 1 === cutRow ? l.slice(0, Math.floor(l.length / 2)) : l}`).join('\n');
}
