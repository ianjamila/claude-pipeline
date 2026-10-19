// A scriptable stand-in for the `docker` binary, in the shape of pipeline/lib/proc.mjs `run`: fakeDocker(...) returns
// run(cmd, args, opts) that answers by args[0] and records every call in run.calls ({cmd, args, opts}). Nothing starts a
// process, so stack-stop unit tests never touch a real Docker.
//   ps / psResult           stdout of `docker ps` | the whole run result (wins over `ps`)
//   inspect / inspectResult an array of container() objects (answered for the ids asked for) | the whole run result
//   stats                   stdout of `docker stats`
//   volumes                 volume names that exist: `docker volume inspect <name>` exits 0 for these, 1 otherwise
const result = (over = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null, pid: 4242, ...over });

export function fakeDocker({ ps = '', inspect = [], stats = '', psResult, inspectResult, volumes } = {}) {
  const calls = [];
  const run = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: [...args], opts });
    const sub = args[0];
    if (sub === 'ps') return psResult ?? result({ stdout: ps });
    if (sub === 'inspect') {
      if (inspectResult) return inspectResult;
      const asked = args.slice(1).filter((a) => !a.startsWith('-'));
      const found = inspect.filter((c) => asked.some((id) => String(c.Id).startsWith(id)));
      const missing = asked.filter((id) => !inspect.some((c) => String(c.Id).startsWith(id)));
      if (missing.length) return result({ code: 1, stdout: JSON.stringify(found), stderr: missing.map((m) => `Error: No such object: ${m}`).join('\n') });
      return result({ stdout: JSON.stringify(found) });
    }
    if (sub === 'stats') return result({ stdout: stats });
    if (sub === 'volume' && args[1] === 'inspect' && volumes) {
      const name = args[2];
      return volumes.includes(name) ? result({ stdout: JSON.stringify([{ Name: name }]) }) : result({ code: 1, stderr: `Error: No such volume: ${name}` });
    }
    return result({ code: 1, stderr: `fake docker: unexpected ${args.join(' ')}` });
  };
  run.calls = calls;
  return run;
}

// One `docker inspect` object. `ports` is NetworkSettings.Ports as docker prints it; `workdir: undefined` leaves the
// workdir label off (the live DRMed stack has only com.supabase.cli.project). `volumes` are plain named volumes; `dbVolume`
// is the one mounted at the Postgres data directory.
export function container({ id, name, project, workdir, running = true, startedAt = '2026-10-19T01:00:00.000000000Z', ports = {}, volumes = [], dbVolume, mounts, labels = {} } = {}) {
  const allLabels = { ...labels };
  if (project !== undefined) allLabels['com.supabase.cli.project'] = project;
  if (workdir !== undefined) allLabels['com.supabase.cli.workdir'] = workdir;
  const Mounts = mounts ?? [
    ...volumes.map((v) => ({ Type: 'volume', Name: v, Destination: `/mnt/${v}` })),
    ...(dbVolume ? [{ Type: 'volume', Name: dbVolume, Destination: '/var/lib/postgresql/data' }] : []),
  ];
  return {
    Id: id,
    Name: name,
    Config: { Labels: allLabels },
    State: { Running: running, StartedAt: startedAt },
    NetworkSettings: { Ports: ports },
    Mounts,
  };
}
