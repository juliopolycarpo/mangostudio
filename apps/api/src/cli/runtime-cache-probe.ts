/**
 * Lists version directories under the hub's runtime-cache for doctor.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getHomeMangoDir } from '../lib/config';
import { RUNTIME_CACHE_DIR_NAME } from '../modules/environments/domain/runtime-release-fetch';

export async function probeRuntimeCache(
  mangoHome: string = getHomeMangoDir()
): Promise<{ readonly directory: string; readonly versions: readonly string[] }> {
  const directory = join(mangoHome, RUNTIME_CACHE_DIR_NAME);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    return { directory, versions };
  } catch {
    return { directory, versions: [] };
  }
}
