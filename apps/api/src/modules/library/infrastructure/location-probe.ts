/**
 * Hub-side bindings for library location probing.
 *
 * The description logic is shared and takes its filesystem as a parameter, so a
 * runtime can answer for its own machine (015). What stays here is the hub's
 * own view: this process's paths, and the MangoStudio directories the hub's
 * configuration — not the host — decides.
 */

import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryTargetId,
} from '@mangostudio/shared/library';
import type { LocationFsProbe } from '@mangostudio/shared/library/host';
import {
  describeLocation as describeLocationWith,
  describeTargetLocations as describeTargetLocationsWith,
} from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { getConfig } from '../../../lib/config';

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
 * Builds the runtime path inputs once per operation. The configured Mango
 * directories are injected through the same env-shaped seam used by all
 * resolvers, which is also how they reach a runtime probing on the hub's behalf.
 */
export function createLibraryPathEnv(overrides: Partial<PathEnv> = {}): PathEnv {
  const env = {
    ...process.env,
    ...configuredLibraryEnv(),
    ...overrides.env,
  };
  return {
    platform: overrides.platform ?? process.platform,
    homeDir: overrides.homeDir ?? homedir(),
    env,
    // Omitted rather than defaulted: there is no sensible stand-in for a
    // repository root, and a wrong one scans a tree the user never named.
    ...(overrides.workspaceRoot !== undefined && { workspaceRoot: overrides.workspaceRoot }),
  };
}

/**
 * The MangoStudio library directories as this hub's configuration resolved
 * them. They are product configuration rather than a property of a host, so
 * they travel to a runtime probing the hub's own machine — and deliberately do
 * not travel anywhere else, where the hub's paths would name nothing.
 */
export function configuredLibraryEnv(): Record<string, string> {
  const config = getConfig();
  return { AGENTS_DIR: config.agents.dir, SKILLS_DIR: config.skills.dir };
}

/**
 * The single place that decides which machines the paths above travel to: the
 * hub's own, and no other. Returned rather than spread, because the two RPCs
 * that ask carry it differently — a probe nests it under `pathEnv`, a scan
 * puts it beside `workspaceRoot` — and only the decision is shared.
 */
export function hubLibraryEnvFor(environmentId: string): Record<string, string> | undefined {
  return environmentId === LOCAL_ENVIRONMENT_ID ? configuredLibraryEnv() : undefined;
}

export function describeTargetLocations(
  targetId: LibraryTargetId,
  env: PathEnv = createLibraryPathEnv(),
  fs: LocationFsProbe = nodeLocationFsProbe
): LibraryLocationStatus[] {
  return describeTargetLocationsWith(targetId, env, fs);
}

export function describeLocation(
  id: LibraryLocationId,
  env: PathEnv = createLibraryPathEnv(),
  fs: LocationFsProbe = nodeLocationFsProbe
): LibraryLocationStatus {
  return describeLocationWith(id, env, fs);
}
