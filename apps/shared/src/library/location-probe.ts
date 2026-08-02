import type { PathEnv } from '../runtime-env';
import { type FsProbe, nearestExistingWritable } from './fs-probe';
import {
  getLibraryLocation,
  type LibraryLocationLayout,
  listLibraryTargetLocationIds,
} from './registry';
import type { LibraryLocationId, LibraryLocationStatus, LibraryTargetId } from './schemas';

/**
 * What describing a location needs from a filesystem. It is injected rather
 * than imported because the answers belong to the machine the locations are on,
 * which is not always the machine asking.
 */
export interface LocationFsProbe extends FsProbe {
  isReadable(path: string): boolean;
  countEntries(path: string, layout: Exclude<LibraryLocationLayout, 'single-file'>): number;
}

export function describeTargetLocations(
  targetId: LibraryTargetId,
  env: PathEnv,
  fs: LocationFsProbe
): LibraryLocationStatus[] {
  return listLibraryTargetLocationIds(targetId).map((id) => describeLocation(id, env, fs));
}

export function describeLocation(
  id: LibraryLocationId,
  env: PathEnv,
  fs: LocationFsProbe
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
      scope: location.scope,
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
    scope: location.scope,
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
