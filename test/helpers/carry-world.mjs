// A stateful stand-in for GitHub for the merge-carry loop (test/merge-owner-go-carry.test.mjs): a REAL bare "origin" repo holds main and the PR branch,
// "Update branch" really merges main into the branch there, and the checkout under test fetches from it. The gh object answers the calls the loop makes
// from that state, so heads, bases and ancestry are never scripted. `hooks` run once at chosen moments to change the world mid-job.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MERGE_SHA, bump, scenario, ymlFor, PR, LOCK_DIR } from './gate-env.mjs';
import { fullProtection } from './fakegh-env.mjs';
import { CARRY_LINE } from '../../pipeline/hooks/lib/owner-go.mjs';
import { run as mergeRun } from '../../pipeline/commands/merge.mjs';

const ID = { GIT_AUTHOR_NAME: 'Hub', GIT_AUTHOR_EMAIL: 'hub@example.invalid', GIT_COMMITTER_NAME: 'Hub', GIT_COMMITTER_EMAIL: 'hub@example.invalid', GIT_CONFIG_GLOBAL: join(tmpdir(), 'no-such-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
export const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${cwd}): ${r.stderr}`);
  return r.stdout.trim();
};
const goYml = (yml = ymlFor()) => yml.replace('{pr} {sha}', '{pr} --match-head-commit {sha}');

export function carryWorld({ yml, change = bump, baseFiles } = {}) {
  const salt = randomUUID();
  // ISOLATION: the approval records are shared by every test process and match on repository + PR; a repo name of its own keeps this world's Carry records from
  // ever being a candidate in another test's refusal (they would change its wording).
  const slug = `acme/carry-${salt.slice(0, 8)}`;
  const s = scenario({ yml: goYml(yml), report: null, state: null, baseFiles, change: (repo) => { change(repo); repo.write('.salt', salt); } });
  const root = s.repo.dir;
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'carry-world-')));
  const bare = join(top, 'origin.git');
  const hub = join(top, 'hub');
  const home = join(top, 'home');
  mkdirSync(home);
  sh(top, 'init', '-q', '--bare', '-b', 'main', bare);
  s.repo.git(['remote', 'add', 'origin', bare]);
  s.repo.git(['push', '-q', 'origin', 'main', 'agent/feature']);
  sh(top, 'clone', '-q', bare, hub);
  sh(hub, 'config', 'commit.gpgsign', 'false');
  const w = {
    s, root, bare, hub, home, h0: s.head, labels: [], mergeResult: 'merged', hooks: {}, githubMade: new Set(), ci: {}, updates: 0, ciPolls: 0, refreshed: [],
    tip: () => sh(bare, 'rev-parse', 'refs/heads/main'),
    head: () => sh(bare, 'rev-parse', 'refs/heads/agent/feature'),
    mergeRan: () => existsSync(join(root, '.review', 'merge-calls.log')),
    // what the Nth merge command did: 'merged' | 'arm' (queued auto-merge, never lands); mergeResult may be a list (the last repeats). null before any command ran.
    mergeOutcome: () => { const n = s.mergeCalls().length; if (n === 0) return null; const r = w.mergeResult; return Array.isArray(r) ? r[Math.min(n, r.length) - 1] : r; },
    mergeCalls: s.mergeCalls,
    cleanup: () => rmSync(top, { recursive: true, force: true }),
    // a commit on main, as someone else's merge (-> the new main tip)
    mainMoves(files = { [`other-${randomUUID().slice(0, 6)}.txt`]: 'main\n'}) {
      sh(hub, 'checkout', '-q', 'main'); sh(hub, 'pull', '-q', 'origin', 'main');
      for (const [p, c] of Object.entries(files)) { mkdirSync(join(hub, p, '..'), { recursive: true }); writeFileSync(join(hub, p), c); }
      sh(hub, 'add', '-A'); sh(hub, 'commit', '-q', '-m', 'main moves'); sh(hub, 'push', '-q', 'origin', 'main');
      return w.tip();
    },
    // a plain commit pushed onto the PR branch by someone else (-> the new PR head)
    externalPush(files = { 'extra.txt': 'x\n' }) {
      sh(hub, 'fetch', '-q', 'origin'); sh(hub, 'checkout', '-q', '-B', 'agent/feature', 'origin/agent/feature');
      for (const [p, c] of Object.entries(files)) writeFileSync(join(hub, p), c);
      sh(hub, 'add', '-A'); sh(hub, 'commit', '-q', '-m', 'external push'); sh(hub, 'push', '-q', 'origin', 'agent/feature');
      return w.head();
    },
  };
  const behind = () => spawnSync('git', ['merge-base', '--is-ancestor', w.tip(), w.head()], { cwd: bare, env: { ...process.env, ...ID } }).status !== 0;
  const once = (name, ...args) => { const f = w.hooks[name]; if (f) { delete w.hooks[name]; f(...args); } };
  const prView = (n, fields) => {
    if (w.mergeRan()) once('afterMerge');
    const outcome = w.mergeOutcome();
    const merged = outcome === 'merged';
    const all = {
      state: merged ? 'MERGED' : 'OPEN', headRefOid: w.head(), baseRefOid: w.tip(), baseRefName: 'main', headRefName: 'agent/feature', isDraft: false,
      labels: w.labels.map((name) => ({ name })), mergeable: 'MERGEABLE', mergeStateStatus: behind() ? 'BEHIND' : 'CLEAN', createdAt: '2026-01-01T00:00:00Z',
      mergeCommit: merged ? { oid: MERGE_SHA } : null, autoMergeRequest: outcome === 'arm' && !w.disarmed ? { enabledAt: 'x' } : null,
    };
    return Object.fromEntries(fields.map((f) => [f, all[f]]));
  };
  const rows = () => [{ name: 'ci', state: 'SUCCESS', bucket: w.ci[w.head()] ?? 'pass' }];
  w.gh = {
    repo: () => ({ slug, host: 'github.com', defaultBranch: 'main' }),
    viewer: () => 'me', prView, listIssues: () => [], listComments: () => [], timelineOf: () => [], pullFiles: () => {
      const mb = sh(bare, 'merge-base', w.tip(), w.head());
      return sh(bare, 'diff', '-M', '--name-status', mb, w.head()).split('\n').filter(Boolean).map((l) => { const [status, a, b] = l.split('\t'); return b === undefined ? { filename: a, status } : { filename: b, previous_filename: a, status }; });
    },
    compare: (base, head) => ({ status: 'diverged', behindBy: Number(sh(bare, 'rev-list', '--count', `${head}..${w.tip()}`)), aheadBy: 1, baseSha: w.tip() }),
    commitParents: (sha) => sh(bare, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1),
    commitVerification: (sha) => ({ verified: w.githubMade.has(sha), reason: 'valid', committerEmail: w.githubMade.has(sha) ? 'noreply@github.com' : 'dev@example.invalid', committerLogin: 'x' }),
    updateBranch(n, expected) {
      once('beforeUpdate');
      if (w.head() !== expected) return { result: 'head-moved', message: "expected head sha didn't match current head ref." };
      w.updates += 1;
      sh(hub, 'fetch', '-q', 'origin'); sh(hub, 'checkout', '-q', '-B', 'agent/feature', 'origin/agent/feature');
      sh(hub, 'merge', '--no-ff', '-q', '-m', 'Merge branch main into agent/feature', 'origin/main');
      sh(hub, 'push', '-q', 'origin', 'agent/feature');
      if (!w.foreignMerge) w.githubMade.add(w.head());
      return { result: 'accepted' };
    },
    checks: () => rows(),
    protection: () => ({ status: 200, json: fullProtection(['ci']) }),
    branchRules: () => [], statusesOf: () => [], workflowRunsOfSuite: () => [],
    checkRunsOf(head) {
      w.ciPolls += 1;
      once('ci', w.ciPolls);
      return [{ id: 1, name: 'ci', app: { id: 15368 }, status: 'completed', conclusion: (w.ci[w.head()] ?? 'pass') === 'pass' ? 'success' : 'failure', started_at: '2026-06-01T00:00:00Z', completed_at: '2026-06-01T00:01:00Z', check_suite: { id: 7 } }];
    },
  };
  w.env = {
    ...process.env, PIPELINE_LOCK_DIR: LOCK_DIR, PIPELINE_MACHINE_ID: 'carry-world-machine', PIPELINE_MERGEABLE_PAUSE_MS: '1', PIPELINE_MERGE_WAIT_MS: '300', PIPELINE_MERGE_POLL_MS: '5',
    PIPELINE_UPDATE_POLL_MS: '1', PIPELINE_UPDATE_WAIT_MS: '300', PIPELINE_CI_APPEAR_MS: '50', PIPELINE_CI_TIMEOUT_MS: '300', PIPELINE_CI_INTERVAL_MS: '1', PIPELINE_HOLD_RETRY_MS: '1',
  };
  w.log = [];
  w.slug = slug;
  // the owner's request for H0 (with or without the Carry line), as the reply right before "merge"
  w.request = ({ carry = true, items = 'none' } = {}) => `Request.\n${carry ? `${CARRY_LINE}\n` : ''}Head ${w.h0.slice(0, 16)} · items ${items} · repo ${slug}\n🔀 Ready to merge #${PR} — say "merge"`;
  // P merge --pr N --owner-go, in process, against the world. `seam` overrides ctx.carry entries.
  w.merge = (seam = {}) => mergeRun(['--pr', String(PR), '--owner-go', '--repo', root], {
    cwd: root, env: w.env,
    carry: { gh: w.gh, home, log: (m) => w.log.push(m), disableAuto: () => true, refreshReview: async ({ head }) => { w.refreshed.push(head); return { ok: true, kind: 'not-applicable' }; }, ...seam },
  });
  return w;
}
