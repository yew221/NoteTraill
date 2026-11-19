import path from 'node:path';

export function desktopPaths({ packaged, resources, home, args = [], env = {} }) {
  const base = path.join(home, 'Library/Application Support');
  let dataDirectory = packaged ? path.join(base, 'NoteTrail') : env.NOTETRAIL_DATA_DIR;
  let profile = packaged ? path.join(base, 'NoteTrail Desktop') : env.NOTETRAIL_DESKTOP_PROFILE;
  if (packaged) {
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i], value = args[i + 1];
      if (!['--data-dir', '--profile-dir'].includes(name) || seen.has(name) || !value || !path.isAbsolute(value) || value.includes('\0')) throw new Error('INVALID_DESKTOP_ARGUMENTS');
      seen.add(name);
      if (name === '--data-dir') dataDirectory = path.normalize(value); else profile = path.normalize(value);
    }
  }
  const runtime = path.join(resources, 'runtime');
  const result = { dataDirectory, profile,
    node: packaged ? path.join(runtime, 'node/bin/node') : env.NOTETRAIL_NODE,
    python: packaged ? path.join(runtime, 'python/bin/python3.12') : env.NOTETRAIL_PYTHON,
    rg: packaged ? path.join(runtime, 'rg/rg') : env.NOTETRAIL_RG };
  for (const value of [result.dataDirectory, result.profile, result.node]) if (!value || !path.isAbsolute(value) || value.includes('\0')) throw new Error('DESKTOP_LAUNCHER_REQUIRED');
  if (profile === dataDirectory || profile.startsWith(dataDirectory + '/') || dataDirectory.startsWith(profile + '/')) throw new Error('INVALID_DESKTOP_PROFILE');
  return result;
}
