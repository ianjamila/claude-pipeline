// pipeline/lib/schedule.mjs: the run arguments are a parameter whose default is the worktrees prune job.
import assert from 'node:assert/strict';
import test from 'node:test';
import { schedulePlist, scheduleLine, scheduleMarker } from '../pipeline/lib/schedule.mjs';

const base = {
  nodePath: '/usr/local/bin/node', binPath: '/opt/p/bin/pipeline.mjs', root: '/work/repo', at: '02:30', lockName: 'abc123',
  label: 'com.claude-pipeline.abc123', pathDirs: ['/usr/local/bin'], logFile: '/logs/cron-abc123.log',
};

const programArguments = (plist) => {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1];
  return [...block.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
};

test('schedulePlist: default args are today\'s worktrees prune job', () => {
  assert.deepEqual(programArguments(schedulePlist(base)), [base.nodePath, base.binPath, 'worktrees', 'prune', '--summary-only']);
  assert.match(scheduleLine(base), / worktrees prune --summary-only >>/);
  assert.doesNotMatch(scheduleLine(base), /--notify/);
  assert.ok(scheduleLine(base).endsWith(` ${scheduleMarker('abc123')}`));
  assert.equal(scheduleMarker('abc123'), '# claude-pipeline worktrees-prune abc123');
});

test('custom args appear in the plist and the cron line', () => {
  const args = ['stacks', 'sweep', '--apply', '--summary-only'];
  assert.deepEqual(programArguments(schedulePlist({ ...base, args })), [base.nodePath, base.binPath, ...args]);
  assert.match(scheduleLine({ ...base, args }), / \/opt\/p\/bin\/pipeline\.mjs stacks sweep --apply --summary-only >>/);
  assert.ok(scheduleLine({ ...base, args, kind: 'stacks-sweep' }).endsWith(' # claude-pipeline stacks-sweep abc123'));
});

test('the plist EnvironmentVariables dict holds PATH only', () => {
  const plist = schedulePlist(base);
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)[1];
  assert.deepEqual([...dict.matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1]), ['PATH']);
});
