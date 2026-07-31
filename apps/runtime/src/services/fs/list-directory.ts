import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { PathAccessError } from '../../errors';
import type { RuntimeListDirectoryParams, RuntimeListDirectoryResult } from '../../methods';

export async function listRuntimeDirectory(
  params: RuntimeListDirectoryParams
): Promise<RuntimeListDirectoryResult> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(params.resolvedPath, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list directory';
    throw new PathAccessError(`Cannot list "${params.inputPath}": ${message}`);
  }

  return {
    path: params.inputPath,
    entries: dirents.map((entry) => ({
      name: String(entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
    })),
  };
}
