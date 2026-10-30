// The two ages that decide which dev records the bind hook still tries, in a module of their own so that dev.mjs (which binds)
// and fastpath.mjs (which decides, before dev.mjs is even loaded, that nothing can be due) read ONE definition and cannot drift.
// No imports: this file is on the hook's cheap path.
export const MIN_AGE_MS = 3000; // a record younger than this has had no time to listen yet
export const MAX_AGE_MS = 10 * 60 * 1000; // an older unbound record is given up on
