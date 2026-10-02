// Builders shared by the hard-stop test files: parsed-diff entries, configs, and a pure-classifier wrapper.
import { DEFAULTS } from '../../pipeline/lib/config.mjs';
import { classifyHardStops } from '../../pipeline/lib/hardstops.mjs';

export const MIG = 'supabase/migrations/1_x.sql';
export const pkg = (deps, extra = {}) => ({ dependencies: deps, ...extra });

// A full config with only the hard-stop settings under test replaced.
export const cfg = ({ paths = [], patterns = [], auth_calls = [], test_globs } = {}) => {
  const c = structuredClone(DEFAULTS);
  c.hard_stops = { paths, patterns, auth_calls };
  if (test_globs) c.integrity.test_globs = test_globs;
  return c;
};

// A parsed-diff file entry. Lines are numbered from `at` (new-file numbers for added, old-file for removed).
export const file = (path, { status = 'M', added = [], removed = [], oldPath, binary = false, at = 1 } = {}) => {
  const num = (texts) => texts.map((text, i) => ({ line: at + i, text }));
  const o = status === 'A' ? null : (oldPath ?? path);
  const n = status === 'D' ? null : path;
  return {
    oldPath: o, newPath: n, path: status === 'D' ? o : n, status, binary,
    added: num(added), removed: num(removed),
  };
};

export const rulesOf = (hits) => [...new Set(hits.map((h) => h.rule))].sort();

// The pure classifier refuses to run without the inputs the IO wrapper always supplies; these tests pass empty ones.
export const classify = (o) => classifyHardStops({ sqlStatements: [], pkgPairs: [], ...o });
export const run = (files, opts = {}) => classify({ files, config: cfg(), ...opts });
