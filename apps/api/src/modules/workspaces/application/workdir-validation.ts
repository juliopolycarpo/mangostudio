/**
 * Hub facade for working-directory validation. Host checks run in the runtime via
 * `workspace.validate`; this module preserves the typed errors callers expect.
 */

import { RuntimeRemoteError } from '@mangostudio/runtime';
import type { WorkdirValidationReason } from '@mangostudio/shared/workspaces';
import { getRuntimeClient } from '../../../services/runtime-client';
import { WorkspacePathError } from './workspace-path';

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

export interface RuntimeSelection {
  readonly userId: string;
  readonly environmentId: string;
}

export async function validateWorkdir(
  path: string,
  options?: { requireAbsolute?: boolean } & Partial<RuntimeSelection>
): Promise<WorkdirValidationResult> {
  try {
    const runtime = await getRuntimeClient(options?.userId, options?.environmentId);
    return await runtime.workspace.validate({
      path,
      requireAbsolute: options?.requireAbsolute,
    });
  } catch (error) {
    throw mapValidateFailure(error);
  }
}

export async function requireValidWorkdir(
  path: string,
  selection?: RuntimeSelection
): Promise<string> {
  const validation = await validateWorkdir(path, selection);
  if (!validation.ok) {
    throw new WorkdirValidationError(validation.reason);
  }
  return validation.resolvedPath;
}

function mapValidateFailure(error: unknown): Error {
  if (error instanceof RuntimeRemoteError && detailString(error, 'kind') === 'workdir_validation') {
    return new WorkspacePathError(error.message);
  }
  if (error instanceof WorkspacePathError) return error;
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function detailString(error: RuntimeRemoteError, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}
