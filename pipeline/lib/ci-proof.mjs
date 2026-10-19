// CI proof for a verify step the final gate lets GitHub Actions vouch for (verify.deferrable_steps + verify.ci_proof).
// STUB: T2a (the gate rules and plumbing in finalgate.mjs) calls this; T2b replaces the body with the GitHub run lookup.
//
// Contract (T2b must keep it; finalgate.mjs#verifyReportCheck relies on it):
//   ciProof({ root, step, spec, pr, head, tree, base, gh, env }) -> Promise<{ state, reason, run? }>
//     root   the PR worktree          step  the deferred step's name (e.g. 'sql-arms')
//     spec   { workflow, job, event } from the BASE branch's verify.ci_proof[step] (workflow = '.github/workflows/<file>.yml', event
//            already defaulted to 'pull_request'); never the PR's own copy
//     pr     the PR number            head  the PR head SHA the gate is judging            tree  `git rev-parse HEAD^{tree}`-style
//            fingerprint the gate computed (treeFingerprint) for that head
//     base   { ref, sha } the default branch name and its tip as fetched just now (origin/<ref>), for "the run saw this base" checks
//     gh     the createGitHub() client       env  the command's environment
//   state  'pass'    the exact-head run of spec.workflow/spec.job completed successfully and belongs to this PR
//          'pending' a newer run/attempt is queued or in progress (an older success never wins)
//          'failure' the run completed and the job did not succeed
//          'missing' no usable run, anything ineligible, or any API/parse error (fail closed; a cancelled run counts as missing)
//   reason one short human line (always present; shown in the gate detail)
//   run    required for 'pass', ignored otherwise: { id, attempt, jobId, workflow, job, url } - the run/attempt/job that was used
// The caller treats a throw, an unknown state, or a 'pass' without `run` as 'missing': nothing here can make the gate pass by failing.

export async function ciProof() {
  return { state: 'missing', reason: 'not implemented' };
}
