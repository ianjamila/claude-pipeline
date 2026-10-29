// `pipeline protect`: the owner-side setup that makes GitHub itself enforce the merge rules (spec 6.6):
// branch protection, squash-only merging with auto-merge, and read-only workflow tokens.
// Without --apply it only PRINTS the exact commands (dry run, safe anywhere). With --apply it runs them,
// which needs admin rights, so it refuses unless the session was started with PIPELINE_ADMIN=1: an agent
// session must never be able to loosen or tighten the repo's protection on its own.
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { GhError } from '../lib/proc.mjs';
import { loadConfig, requiredChecks } from '../lib/config.mjs';
import { createGitHub, classifyApiError, encodePath, commandCwd, guardGh, requireRepoRoot } from '../lib/github.mjs';
import { protectionMissing } from '../lib/preflight.mjs';

export const meta = {
  summary: 'print (or with --apply, set) the GitHub branch protection and repo settings the pipeline relies on',
  usage: 'pipeline protect [--apply] [--checks a,b] [--repo DIR]   (--apply needs PIPELINE_ADMIN=1)',
};

// The GitHub Actions app. Every required check is pinned to it: a status or check run counts only when GITHUB_TOKEN (a workflow)
// posted it, so a status posted with a person's token (the owner's, which agents also use) never satisfies branch protection.
// That is what makes `Test integrity`, `Hard-stop scan` and `Cross-model review` unforgeable from a terminal. A check that
// another app posts (a deploy provider, say) must not be listed in ci.required_checks, or nothing could ever satisfy it.
export const GITHUB_ACTIONS_APP_ID = 15368;

export function protectionPayload(checks) {
  return {
    required_status_checks: { strict: false, checks: checks.map((context) => ({ context, app_id: GITHUB_ACTIONS_APP_ID })) },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false, require_code_owner_reviews: false },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: false,
  };
}

export const REPO_SETTINGS = Object.freeze({
  allow_auto_merge: true,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  delete_branch_on_merge: true,
});

export const WORKFLOW_PERMISSIONS = Object.freeze({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });

// The required checks GitHub reports WITHOUT the Actions pin (any app may satisfy them), from a protection read-back.
export function unpinnedChecks(json, checks) {
  const rows = json?.required_status_checks?.checks ?? [];
  return checks.filter((name) => !rows.some((c) => c?.context === name && c?.app_id === GITHUB_ACTIONS_APP_ID));
}

// The three writes, in the order they are applied.
export function buildRequests({ slug, branch, checks }) {
  return [
    { step: 'branch-protection', method: 'PUT', path: `repos/${slug}/branches/${encodePath(branch)}/protection`, body: protectionPayload(checks) },
    { step: 'repo-settings', method: 'PATCH', path: `repos/${slug}`, body: { ...REPO_SETTINGS } },
    { step: 'workflow-permissions', method: 'PUT', path: `repos/${slug}/actions/permissions/workflow`, body: { ...WORKFLOW_PERMISSIONS } },
  ];
}

const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// A copy-pasteable shell command: the JSON body goes in through a quoted heredoc, so nothing in it is expanded.
export function toCommand({ method, path, body }) {
  return `gh api -X ${method} ${shellWord(path)} --input - <<'JSON'\n${JSON.stringify(body, null, 2)}\nJSON`;
}

function parseChecks(raw) {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

async function resolveChecks(values, root) {
  if (values.checks !== undefined) return parseChecks(values.checks);
  const cfg = await loadConfig(root);
  if (!cfg.ok) throw new UsageError(`cannot read the required checks from the config (${cfg.errors.join('; ')}); pass --checks a,b`);
  // Same list preflight demands, so what --apply sets is exactly what preflight later reads back as complete.
  return requiredChecks(cfg.config.ci);
}

const PLAN_MESSAGE = 'GitHub Pro required for private repos: branch protection is not available on this plan. Upgrade (or make the repo public), then run this again.';

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    apply: { type: 'boolean' },
    checks: { type: 'string' },
    repo: { type: 'string' },
  }, { allowPositionals: false });
  const apply = values.apply === true;
  if (apply && ctx.env.PIPELINE_ADMIN !== '1') {
    throw new UsageError('protect --apply requires a session started with PIPELINE_ADMIN=1 (the owner applies protection; agent sessions never do)');
  }
  const cwd = commandCwd(values, ctx);
  const root = requireRepoRoot(cwd);
  const checks = await resolveChecks(values, root);
  if (checks.length === 0) {
    throw new UsageError('no required checks: pass --checks a,b or set ci.required_checks in .claude/pipeline.yml (the guard contexts are added unless ci.guard_checks is false; protection without required checks would let anything merge)');
  }
  const gh = createGitHub({ cwd, env: ctx.env });

  return guardGh(async () => {
    const { slug, defaultBranch: branch } = gh.repo();
    const requests = buildRequests({ slug, branch, checks });
    const commands = requests.map(toCommand);

    if (!apply) {
      process.stderr.write(`dry run: nothing was changed. Run these as an admin of ${slug}, or re-run with --apply in a PIPELINE_ADMIN=1 session.\n`);
      return { exitCode: EXIT.OK, output: { ok: true, applied: false, slug, branch, checks, requests, commands } };
    }

    const completed = [];
    for (const req of requests) {
      try {
        gh.api(req.method, req.path, req.body);
        completed.push(req.step);
      } catch (err) {
        const known = err instanceof GhError ? classifyApiError(err) : null;
        if (known?.status !== 403) throw err;
        const message = known.reason === 'plan'
          ? PLAN_MESSAGE
          : `the gh token lacks admin rights on ${slug}: an owner must run the commands below`;
        process.stderr.write(`${message}\n`);
        return {
          exitCode: EXIT.FAILED,
          output: { ok: false, applied: false, reason: known.reason, message, failedStep: req.step, completed, slug, branch, commands },
        };
      }
    }

    // Read it back: only what GitHub now reports counts, not what we think we sent.
    const p = gh.protection(branch);
    if (p.status !== 200) {
      return { exitCode: EXIT.FAILED, output: { ok: false, applied: true, mode: 'gate', missing: [], reason: p.reason, message: p.message, completed, slug, branch } };
    }
    const missing = protectionMissing(p.json, checks);
    const unpinned = unpinnedChecks(p.json, checks);
    const mode = missing.length === 0 ? 'github' : 'gate';
    const ok = missing.length === 0 && unpinned.length === 0;
    return { exitCode: ok ? EXIT.OK : EXIT.FAILED, output: { ok, applied: true, mode, missing, unpinned, completed, slug, branch } };
  });
}
