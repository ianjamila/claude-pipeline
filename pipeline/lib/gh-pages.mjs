// Page-by-page reads of a GitHub list for the report commands (`stats rounds`, `ci-usage`): one `gh api` call per page, bounded by MAX_PAGES so a huge repository
// cannot run away. The caller learns when the bound cut the list (the stop condition never met) and says so in its warnings.
export const PAGE = 100;
export const MAX_PAGES = 30;

// -> the items. `stop(list)` ends the loop early (e.g. a whole page older than the date). `onCut()` is called when the loop ended on MAX_PAGES with more to read.
// `key` reads the items from an object reply ({ workflow_runs: [...] }, { jobs: [...] }) instead of a bare array. `onPage(reply)` sees every raw reply
// (total_count lives there); `onCall()` is called before each request, and may throw to end the read (a call budget): what was read so far is lost to the caller then,
// so it is the caller's job to catch it. A reply that is not a list ends the read.
export function pages(gh, path, stop, onCut, { key, onPage, onCall } = {}) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    onCall?.();
    const reply = gh.api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`);
    onPage?.(reply);
    const list = key === undefined ? reply : reply?.[key];
    if (!Array.isArray(list)) break;
    out.push(...list);
    if (list.length < PAGE || stop?.(list)) break;
    if (page === MAX_PAGES) onCut?.();
  }
  return out;
}
