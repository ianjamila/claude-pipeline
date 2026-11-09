// GitHub links (and closes on merge) only the ONE issue that directly follows a closing keyword: "Closes #170, #171" closes
// #170 and leaves #171 open, silently. This finds those lines in a PR body so review-complete can ask for one keyword per
// issue ("Closes #170. Closes #171.") before the PR is handed to the owner.
//
// Keywords are GitHub's own (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, any case, optional colon).
// A reference is #N, owner/repo#N or an issue/pull URL on github.com. Text GitHub does not read for keywords is skipped:
// fenced code blocks, inline code spans and single-line HTML comments.

const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const REF = String.raw`(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)`;
const SEP = String.raw`\s*(?:,|&|\+|\/|\band\b)\s*(?:and\s+)?`;
// keyword, first reference, then one or more "separator + bare reference" (a reference without its own keyword)
const LIST = new RegExp(String.raw`\b(${KEYWORD}):?\s+(${REF})((?:${SEP}${REF}(?![\w/]))+)`, 'gi');
const ONE_REF = new RegExp(REF, 'gi');
const FENCE = /^\s{0,3}(```|~~~)/;

// [{ line, keyword, linked, unlinked: [refs] }] for every keyword followed by a list of references; [] for a clean body.
export function multiIssueClosingLines(body) {
  if (typeof body !== 'string' || body === '') return [];
  const found = [];
  let fence = null;
  for (const raw of body.split(/\r?\n/)) {
    const f = raw.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const text = raw.replace(/<!--.*?-->/g, ' ').replace(/(`+)[^`]*?\1/g, ' ');
    for (const m of text.matchAll(LIST)) {
      found.push({ line: raw.trim(), keyword: m[1], linked: m[2], unlinked: m[3].match(ONE_REF) ?? [] });
    }
  }
  return found;
}

// One refusal sentence a person (or the agent) can act on.
export function closingKeywordProblem(found, pr) {
  if (found.length === 0) return null;
  const lines = found.map((f) => {
    const kw = f.keyword[0].toUpperCase() + f.keyword.slice(1).toLowerCase();
    const fixed = [f.linked, ...f.unlinked].map((r) => `${kw} ${r}.`).join(' ');
    return `"${f.line}" closes only ${f.linked} on merge (GitHub links one issue per keyword; ${f.unlinked.join(', ')} would stay open): write "${fixed}"`;
  });
  return `the PR body ${lines.join('; ')}. Update the body (gh pr edit ${pr} --body-file <file>) and run review-complete again; no new review round is needed`;
}
