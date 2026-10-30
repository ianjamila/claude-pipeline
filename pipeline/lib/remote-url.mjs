// owner/name (and host) from a remote URL: https, ssh:// and scp-like (git@host:owner/name.git) forms.
export function parseRemote(url) {
  const s = String(url ?? '').trim();
  let host;
  let p;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    host = scp[1];
    p = scp[2];
  } else {
    try {
      const u = new URL(s);
      host = u.hostname;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  const segs = p.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[segs.length - 2];
  const name = segs[segs.length - 1];
  return { host, owner, name, slug: `${owner}/${name}` };
}
