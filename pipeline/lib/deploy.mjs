// Finds the preview or production deployment for a commit through GitHub deployments (Vercel and most
// hosts report there). Everything time-related is injectable so tests never wait: `now` and `sleep`.
// Fail closed: only an explicit `success` WITH a URL counts; anything unclear keeps polling and ends in
// `timeout`, which the caller treats as "not deployed", never as "deployed".

const MAX_CONSECUTIVE_ERRORS = 3;
const SCAN_LIMIT = 10;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = (d) => Date.parse(d.created_at ?? '') || 0;
// Newest first: by creation time, then id (ids only grow).
const newestFirst = (list) => [...list].sort((a, b) => created(b) - created(a) || Number(b.id) - Number(a.id));
const urlOf = (s) => s?.environment_url || s?.target_url || null;

// Statuses arrive newest first. `inactive` only means a later deployment replaced this one, so look
// through it to what the deployment actually did.
function outcomeOf(statuses) {
  const real = (statuses ?? []).filter((s) => s.state !== 'inactive');
  const latest = real[0];
  if (!latest) return { state: 'pending' };
  if (latest.state === 'success') return urlOf(latest) ? { state: 'success', url: urlOf(latest) } : { state: 'pending' };
  if (latest.state === 'failure' || latest.state === 'error') {
    return { state: 'failure', url: latest.environment_url || latest.log_url || latest.target_url || null };
  }
  return { state: 'pending' };
}

export async function findDeployment({ gh, sha, environment, timeoutMs, pollMs = 15_000, now = Date.now, sleep = defaultSleep }) {
  const deadline = now() + timeoutMs;
  let errors = 0;
  for (;;) {
    try {
      const newest = newestFirst(await gh.deployments({ sha, environment }))[0];
      if (newest) {
        const out = outcomeOf(await gh.deploymentStatuses(newest.id));
        if (out.state === 'success') return { state: 'success', id: newest.id, url: out.url, sha: newest.sha ?? sha, createdAt: newest.created_at ?? null };
        if (out.state === 'failure') return { state: 'failure', id: newest.id, url: out.url };
      }
      errors = 0;
    } catch (err) {
      // One flaky API call must not lose a 15-minute wait, but a persistent error (bad token) must surface.
      errors += 1;
      if (errors >= MAX_CONSECUTIVE_ERRORS) throw err;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { state: 'timeout' };
    await sleep(Math.min(pollMs, remaining));
  }
}

// The deployment serving production right now: the newest one whose LATEST status is success (older
// ones that were replaced are `inactive`, so they do not qualify).
export async function currentProduction({ gh, environment }) {
  for (const d of newestFirst(await gh.deployments({ environment })).slice(0, SCAN_LIMIT)) {
    const latest = (await gh.deploymentStatuses(d.id))?.[0];
    if (latest?.state === 'success') return { id: d.id, sha: d.sha, url: urlOf(latest) };
  }
  return null;
}
