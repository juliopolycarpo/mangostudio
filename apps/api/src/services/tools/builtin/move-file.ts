/**
 * Built-in tool: move_file
 * Moves or renames a regular file without overwriting the destination.
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, link, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rekeyFile, withPathLocks } from '../file-freshness';
import {
  ensureFileMutationCheckpoint,
  hashFileAtPath,
  recordFileMutationAfterHash,
} from '../file-mutation-snapshot';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  assertRegularFilePath,
  getRequiredPathArg,
  isErrnoException,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
} from './_fs-utils';

const MOVE_FILE_TOOL_NAME = 'move_file';

/**
 * `link` failures that mean "this filesystem pair cannot hold a hard link",
 * not "the move is invalid". EXDEV is the cross-device case; the rest are what
 * exFAT/FAT, many FUSE and network mounts, and non-NTFS Windows volumes report
 * for an unsupported or exhausted link. All of them fall back to copy+unlink.
 */
const LINK_UNSUPPORTED_CODES = new Set([
  'EXDEV',
  'EPERM',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

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
  return normalizePathValidationSettings(parameters);
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
    const source = await assertRegularFilePath(from, 'move');
    await ensureFileMutationCheckpoint(context, from, 'move', { movedTo: to });
    await moveRegularFileWithoutOverwrite(from, to, source.mode & 0o7777);
    rekeyFile(context.chatId, from, to);
    const afterHash = await hashFileAtPath(to);
    await recordFileMutationAfterHash(context, from, afterHash);
    return { from: args.from, to: args.to, moved: true };
  });
}

/**
 * A hard link plus unlink gives regular files atomic no-overwrite semantics on
 * one filesystem. copyFile with COPYFILE_EXCL provides the same destination
 * guarantee wherever a hard link cannot be created.
 */
export async function moveRegularFileWithoutOverwrite(
  from: string,
  to: string,
  mode: number
): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  let destinationCreated = false;
  try {
    try {
      await link(from, to);
      destinationCreated = true;
    } catch (error) {
      if (!isLinkUnsupported(error)) throw error;
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

function isLinkUnsupported(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return typeof error.code === 'string' && LINK_UNSUPPORTED_CODES.has(error.code);
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
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths the tool is allowed to move files from and to. Leave empty to allow all.',
        'List of paths the tool is denied from moving files from or to. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
