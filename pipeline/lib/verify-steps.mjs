// Reading verify-report step rows. A step can be skipped (not run, for a stated reason) in two shapes: the current
// `status: 'skipped'` + `skipReason`, and the legacy eaglewatch row `status: 'pass', skipped: true` (reason in `skipCheck`,
// else the row's `command` when it is a "(skipped ..." note). Everything else, including a failed row that merely carries skipped:true, is not a skip.
// Pure: no IO. Used by the final gate (which only accepts owner-listed skips) and by the renderers.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The legacy reason: skipCheck, else the row's command when that is a "(skipped ...)" note (eaglewatch writes "(skipped — <reason>)");
// a plain command such as 'npm test' says nothing about why the step was skipped.
const legacyReason = (step) => (typeof step.skipCheck === 'string' ? step.skipCheck : (typeof step.command === 'string' && step.command.trimStart().startsWith('(skipped') ? step.command : undefined));

// null when the row is not a skip, else { name, reason } with reason '' when none was given.
export function skipOf(step) {
  if (!isObject(step)) return null;
  const legacy = step.status === 'pass' && step.skipped === true;
  if (step.status !== 'skipped' && !legacy) return null;
  const given = step.status === 'skipped' ? step.skipReason : legacyReason(step);
  return { name: step.name, reason: typeof given === 'string' ? given.trim() : '' };
}
