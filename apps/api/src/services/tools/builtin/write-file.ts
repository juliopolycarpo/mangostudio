/**
 * Built-in tool: write_file
 * Writes text content to a file on disk, creating parent directories as needed.
 */

import { lstat } from 'node:fs/promises';
import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getRequiredString } from '../arg-parsing';
import { assertFresh, FileNotReadError, recordFileRead, withPathLocks } from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  BINARY_SNIFF_BYTES,
  containsNulByte,
  getRequiredPathArg,
  isErrnoException,
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
  resolveAndValidatePath,
} from './_fs-utils';

const WRITE_FILE_TOOL_NAME = 'write_file';

export interface WriteFileToolArgs {
  path: string;
  content: string;
}

export interface WriteFileToolResult {
  path: string;
  bytesWritten: number;
  created: boolean;
  sha256: string;
}

export type WriteFileToolSettings = PathValidationSettings;

const definition = {
  name: WRITE_FILE_TOOL_NAME,
  description:
    'Writes text content to a file on disk. Creates parent directories if they do not exist. ' +
    'Overwriting an existing file requires reading all of it with read_file first. ' +
    'Use this when the user asks to create, write, or save content to a file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      content: {
        type: 'string',
        description: 'The text content to write to the file.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

export function normalizeWriteFileToolSettings(
  parameters: Record<string, unknown>
): WriteFileToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeWriteFile(
  args: WriteFileToolArgs,
  context: ToolContext
): Promise<WriteFileToolResult> {
  const settings = normalizeWriteFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  return await withPathLocks([resolvedPath], async () => {
    const created = !(await Bun.file(resolvedPath).exists());
    if (!created) {
      try {
        await assertFresh(context.chatId, resolvedPath);
      } catch (error) {
        if (error instanceof FileNotReadError) throw await explainUnreadFile(resolvedPath, error);
        throw error;
      }
    }

    let committed: { bytesWritten: number; mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(resolvedPath, args.content, { exclusive: created });
    } catch (error) {
      if (created && isErrnoException(error, 'EEXIST'))
        throw await describeOccupiedPath(resolvedPath);
      // The destination policy is the tool's own remediation advice, not a
      // filesystem failure, so it reaches the model as a path error.
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    // Recording the committed bytes makes a later sequential write fresh; the
    // surrounding path lock gives parallel calls the same deterministic order.
    const sha256 = recordFileRead(context.chatId, resolvedPath, args.content, committed.mtimeMs);
    return { path: args.path, bytesWritten: committed.bytesWritten, created, sha256 };
  });
}

/**
 * Explains a destination that appeared after the existence check. A regular
 * file is an unread file, so it gets the same remediation as any guarded
 * overwrite; a directory or dangling symlink cannot be read at all, so saying
 * "read it first" would send the model into an unrecoverable retry loop.
 */
async function describeOccupiedPath(resolvedPath: string): Promise<Error> {
  const entry = await lstat(resolvedPath).catch(() => null);
  if (entry?.isFile()) {
    return await explainUnreadFile(resolvedPath, new FileNotReadError(resolvedPath));
  }
  return new PathAccessError(
    `Cannot write "${resolvedPath}": the path exists and is not a regular file.`
  );
}

/**
 * "Read it first" is the right remediation for a text file, but read_file
 * refuses binary files outright, so handing that advice to the model for one
 * sends it into a retry loop with no exit. Name the real blocker instead.
 */
async function explainUnreadFile(resolvedPath: string, unreadError: Error): Promise<Error> {
  const probe = Bun.file(resolvedPath).slice(0, BINARY_SNIFF_BYTES);
  const bytes = await probe.bytes().catch(() => new Uint8Array());
  if (!containsNulByte(bytes, BINARY_SNIFF_BYTES)) return unreadError;
  return new PathAccessError(
    `Cannot overwrite "${resolvedPath}": it is a binary file. read_file cannot read binary ` +
      'files, so the read-before-overwrite guard cannot be satisfied for this path.'
  );
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<WriteFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const content = getRequiredString(args.content, 'content');
  return executeWriteFile({ path, content }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Write file',
      description:
        'Allows the AI to create text files and overwrite files it has read in this chat.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: [
        {
          name: 'allowedPaths',
          label: 'Allowed paths',
          description: 'List of paths the tool is allowed to write to. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description:
            'List of paths the tool is denied from writing to. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}
