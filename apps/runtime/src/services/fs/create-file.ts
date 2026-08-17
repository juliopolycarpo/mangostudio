import { lstat, readlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PathAccessError } from '../../errors';
import type {
  RuntimeCreateFileParams,
  RuntimeCreateFileResult,
  RuntimeMutationResult,
} from '../../methods';
import { throwIfAborted } from '../cancellation';
import { recordFileRead, withPathLocks } from '../file-freshness';
import { isErrnoException, writeRegularFileAtomic } from '../fs-utils';
import { mutationSnapshot } from '../snapshot';

export async function createRuntimeFile(
  params: RuntimeCreateFileParams,
  signal?: AbortSignal
): Promise<RuntimeMutationResult<RuntimeCreateFileResult>> {
  throwIfAborted(signal);

  return await withPathLocks([params.resolvedPath], async () => {
    // Refusing here costs nothing; refusing after the exclusive create would
    // leave a file the caller was told it never got.
    throwIfAborted(signal);

    let committed: { bytesWritten: number; mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(params.resolvedPath, params.content, {
        exclusive: true,
      });
    } catch (error) {
      if (isErrnoException(error, 'EEXIST')) {
        throw await describeBlockedCreate(params.resolvedPath, params.inputPath);
      }
      throw error;
    }

    const sha256 = recordFileRead(
      params.chatId,
      params.resolvedPath,
      params.content,
      committed.mtimeMs
    );
    return {
      result: { path: params.inputPath, bytesWritten: committed.bytesWritten, sha256 },
      mutations: mutationSnapshot(params.captureSnapshot, {
        path: params.resolvedPath,
        op: 'create',
        before: { exists: false },
        afterHash: sha256,
      }),
    };
  });
}

async function describeBlockedCreate(resolvedPath: string, inputPath: string): Promise<Error> {
  const entry = await lstat(resolvedPath).catch(() => null);
  if (entry?.isSymbolicLink()) {
    // The exclusive open's EEXIST does not distinguish a symlink from a
    // regular file, so this is the one place left to say so: "read it" is
    // misleading advice for a path that has no content of its own to read.
    const target = await readlink(resolvedPath).catch(() => null);
    return new PathAccessError(
      `Cannot create "${inputPath}": it is a symbolic link${target ? ` to "${target}"` : ''}. ` +
        'Write to the link target instead.'
    );
  }
  if (entry && !entry.isFile()) {
    // Same reasoning as the symlink branch above: EEXIST alone cannot tell a
    // directory or other non-regular entry from a file worth reading.
    return new PathAccessError(
      `Cannot create "${inputPath}": the path exists and is not a regular file.`
    );
  }
  if (entry) {
    return new PathAccessError(
      `"${inputPath}" already exists. Read it with read_file, then use edit_file for an exact ` +
        'text change, replace_range for a line change, or write_file to replace all content.'
    );
  }
  return new PathAccessError(
    `Cannot create "${inputPath}": "${dirname(resolvedPath)}" is not a directory.`
  );
}
