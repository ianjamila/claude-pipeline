// Reading verify-report step rows. A step can be skipped (not run, for a stated reason) in two shapes: the current
// `status: 'skipped'` + `skipReason`, and the legacy eaglewatch row `status: 'pass', skipped: true` (reason in `skipCheck`,
// else the row's `command`). Everything else, including a failed row that merely carries skipped:true, is not a skip.
// Pure: no IO. Used by the final gate (which only accepts owner-listed skips) and by the renderers.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// null when the row is not a skip, else { name, reason } with reason '' when none was given.
export function skipOf(step) {
  if (!isObject(step)) return null;
  const legacy = step.status === 'pass' && step.skipped === true;
  if (step.status !== 'skipped' && !legacy) return null;
  const given = step.status === 'skipped' ? step.skipReason : (step.skipCheck ?? step.command);
  return { name: step.name, reason: typeof given === 'string' ? given.trim() : '' };
}
