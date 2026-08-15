import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { PathAccessError } from '../../errors';
import type { RuntimeListDirectoryParams, RuntimeListDirectoryResult } from '../../methods';
import { throwIfAborted } from '../cancellation';

export async function listRuntimeDirectory(
  params: RuntimeListDirectoryParams,
  signal?: AbortSignal
): Promise<RuntimeListDirectoryResult> {
  // One `readdir`: entry is the only point where refusing saves anything.
  throwIfAborted(signal);

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
