/**
 * Built-in tool: move_file
 * Moves or renames a regular file without overwriting the destination.
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rekeyFile, withPathLocks } from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  isErrnoException,
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
  resolveAndValidatePath,
} from './_fs-utils';

const MOVE_FILE_TOOL_NAME = 'move_file';

export interface MoveFileToolArgs {
  from: string;
  to: string;
}

export interface MoveFileToolResult {
  from: string;
  to: string;
  moved: true;
}

export type MoveFileToolSettings = PathValidationSettings;

const definition = {
  name: MOVE_FILE_TOOL_NAME,
  description:
    'Moves or renames a regular file, including across filesystems. Both paths must be ' +
    'allowed, missing destination directories are created, and an existing destination is ' +
    'never overwritten. The source does not need to be read first.',
  parameters: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description:
          'Existing source path. May be absolute, a ~ path, or relative to the chat working directory.',
      },
      to: {
        type: 'string',
        description:
          'New destination path. May be absolute, a ~ path, or relative to the chat working directory.',
      },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
};

export function normalizeMoveFileToolSettings(
  parameters: Record<string, unknown>
): MoveFileToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeMoveFile(
  args: MoveFileToolArgs,
  context: ToolContext
): Promise<MoveFileToolResult> {
  const settings = normalizeMoveFileToolSettings(context.parameters);
  const validationOptions = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  };
  const from = resolveAndValidatePath(args.from, validationOptions);
  const to = resolveAndValidatePath(args.to, validationOptions);

  if (from === to) {
    throw new PathAccessError('Source and destination must be different paths.');
  }

  return await withPathLocks([from, to], async () => {
    const source = await inspectSource(from);
    await mkdir(dirname(to), { recursive: true });
    await moveWithoutOverwrite(from, to, source.mode);
    rekeyFile(context.chatId, from, to);
    return { from: args.from, to: args.to, moved: true };
  });
}

async function inspectSource(from: string): Promise<{ mode: number }> {
  const entry = await lstat(from).catch((error: unknown) => {
    if (isErrnoException(error, 'ENOENT')) {
      throw new PathAccessError(`File not found: "${from}"`);
    }
    throw error;
  });
  if (!entry.isFile()) {
    throw new PathAccessError(
      `Cannot move "${from}": it is not a regular file. Directories and symbolic links are not supported.`
    );
  }
  return { mode: entry.mode & 0o7777 };
}

/**
 * A hard link plus unlink gives regular files atomic no-overwrite semantics on
 * one filesystem. copyFile with COPYFILE_EXCL provides the same destination
 * guarantee for cross-device moves, where a hard link cannot be created.
 */
async function moveWithoutOverwrite(from: string, to: string, mode: number): Promise<void> {
  let destinationCreated = false;
  try {
    try {
      await link(from, to);
      destinationCreated = true;
    } catch (error) {
      if (!isErrnoException(error, 'EXDEV')) throw error;
      await copyFile(from, to, fsConstants.COPYFILE_EXCL);
      destinationCreated = true;
      await chmod(to, mode);
    }
    await unlink(from);
  } catch (error) {
    if (destinationCreated) {
      const cleanupError = await unlink(to).catch((thrown: unknown) => thrown);
      if (cleanupError) {
        throw new PathAccessError(
          `Could not complete the move from "${from}" to "${to}", and cleanup also failed. Both paths may exist.`
        );
      }
    }
    if (isErrnoException(error, 'EEXIST')) {
      throw new PathAccessError(`"${to}" already exists. Choose a different destination.`);
    }
    if (isErrnoException(error, 'ENOENT')) {
      throw new PathAccessError(`File not found: "${from}"`);
    }
    throw error;
  }
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<MoveFileToolResult> {
  const from = getRequiredPathArg(args.from, 'from');
  const to = getRequiredPathArg(args.to, 'to');
  return executeMoveFile({ from, to }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Move file',
      description:
        'Allows the AI to move or rename regular files without overwriting existing paths.',
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
          description:
            'List of paths the tool is allowed to move files from and to. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description:
            'List of paths the tool is denied from moving files from or to. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}
