// What the job runner and the job reader agree on for a job's captured stdout (see job-runner.mjs, jobs.mjs).
export const STDOUT_FILE = 'stdout';
export const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
