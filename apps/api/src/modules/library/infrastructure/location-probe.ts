import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { LibraryLocationId, LibraryLocationStatus } from '@mangostudio/shared/library';
import { getConfig } from '../../../lib/config';
import { type FsProbe, nearestExistingWritable } from '../../../lib/fs-probe';
import { getLibraryLocation, type LibraryLocationLayout, type PathEnv } from '../domain/registry';

export interface LocationFsProbe extends FsProbe {
  isReadable(path: string): boolean;
  countEntries(path: string, layout: Exclude<LibraryLocationLayout, 'single-file'>): number;
}

const nodeLocationFsProbe: LocationFsProbe = {
  exists: existsSync,
  isWritable(path) {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  isReadable(path) {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  countEntries(path, layout) {
    // Dot-prefixed names can never be resource slugs, so the resource writer's
    // `.slug.suffix.staging` siblings stay out of the reported count.
    return readdirSync(path, { withFileTypes: true }).filter((entry) => {
      if (entry.name.startsWith('.')) return false;
      if (entry.isSymbolicLink()) return true;
      return layout === 'directory-of-dirs' ? entry.isDirectory() : entry.isFile();
    }).length;
  },
};

/**
 * Builds the runtime path inputs once per operation. The configured Mango skills
 * directory is injected through the same env-shaped seam used by all resolvers.
 */
function createLibraryPathEnv(overrides: Partial<PathEnv> = {}): PathEnv {
  const env = {
    ...process.env,
    SKILLS_DIR: getConfig().skills.dir,
    ...overrides.env,
  };
  return {
    platform: overrides.platform ?? process.platform,
    homeDir: overrides.homeDir ?? homedir(),
    env,
  };
}

export function describeLocation(
  id: LibraryLocationId,
  env: PathEnv = createLibraryPathEnv(),
  fs: LocationFsProbe = nodeLocationFsProbe
): LibraryLocationStatus {
  const location = getLibraryLocation(id);
  if (!location) {
    throw new TypeError(`Unknown library location: ${id}`);
  }

  const path = location.resolvePath(env);
  if (path === null) {
    return {
      id: location.id,
      kind: location.kind,
      path: null,
      access: location.access,
      exists: false,
      readable: false,
      writable: false,
      targetIds: [...location.readBy],
    };
  }

  const exists = fs.exists(path);
  const readable = exists && fs.isReadable(path);
  const writable = exists ? fs.isWritable(path) : nearestExistingWritable(path, fs);
  const entryCount =
    exists && readable && location.layout !== 'single-file'
      ? safeEntryCount(fs, path, location.layout)
      : undefined;

  return {
    id: location.id,
    kind: location.kind,
    path,
    access: location.access,
    exists,
    readable,
    writable,
    targetIds: [...location.readBy],
    ...(entryCount !== undefined && { entryCount }),
  };
}

function safeEntryCount(
  fs: LocationFsProbe,
  path: string,
  layout: Exclude<LibraryLocationLayout, 'single-file'>
): number | undefined {
  try {
    return fs.countEntries(path, layout);
  } catch {
    return undefined;
  }
}
