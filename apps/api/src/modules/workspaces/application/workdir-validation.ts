import { access, constants, stat } from 'node:fs/promises';
import type { WorkdirValidationReason } from '@mangostudio/shared/workspaces';
import { resolveWorkspacePath } from './workspace-path';

export class WorkdirValidationError extends Error {
  readonly code = 'VALIDATION';

  constructor(readonly reason: WorkdirValidationReason) {
    super(`The working directory is ${reason}.`);
    this.name = 'WorkdirValidationError';
  }
}

export type WorkdirValidationResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: WorkdirValidationReason };

function filesystemReason(error: unknown): WorkdirValidationReason | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }

  switch (error.code) {
    case 'ENOENT':
      return 'not-found';
    case 'ENOTDIR':
      return 'not-a-directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    default:
      return undefined;
  }
}

export async function validateWorkdir(path: string): Promise<WorkdirValidationResult> {
  const resolvedPath = resolveWorkspacePath(path);

  try {
    const metadata = await stat(resolvedPath);
    if (!metadata.isDirectory()) {
      return { ok: false, reason: 'not-a-directory' };
    }

    await access(resolvedPath, constants.R_OK | constants.X_OK);
    return { ok: true, resolvedPath };
  } catch (error) {
    const reason = filesystemReason(error);
    if (reason) {
      return { ok: false, reason };
    }
    throw error;
  }
}

export async function requireValidWorkdir(path: string): Promise<string> {
  const validation = await validateWorkdir(path);
  if (!validation.ok) {
    throw new WorkdirValidationError(validation.reason);
  }
  return validation.resolvedPath;
}
