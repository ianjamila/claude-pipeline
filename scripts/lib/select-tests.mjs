// Which test files scripts/test.mjs runs for its name arguments. Pure, so test/test-runner.test.mjs can check it
// without starting a suite.
//   an argument ending in .test.mjs names exactly that file (`cli.test.mjs` must not also pick ci-wait-cli.test.mjs);
//   any other argument is a substring filter, as before.
// `names` keeps the order of `all`; `missing` lists the exact arguments that matched no file (a typo must not quietly
// shrink a check).
export function selectTestFiles(all, only) {
  const files = all.filter((f) => f.endsWith('.test.mjs'));
  if (only.length === 0) return { names: files, missing: [] };
  const isExact = (o) => o.endsWith('.test.mjs');
  const exact = only.filter(isExact);
  const substrings = only.filter((o) => !isExact(o));
  return {
    names: files.filter((f) => exact.includes(f) || substrings.some((o) => f.includes(o))),
    missing: exact.filter((o) => !files.includes(o)),
  };
}
