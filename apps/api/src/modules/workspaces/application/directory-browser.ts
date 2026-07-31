/**
 * Hub facade for workspace directory browsing. Host I/O runs in the runtime via
 * `workspace.browse`; this module preserves the HTTP error types routes expect.
 */

import { RuntimeRemoteError } from '@mangostudio/runtime';
import type {
  ListDirectoryResponse,
  WorkdirValidationReason,
} from '@mangostudio/shared/workspaces';
import { getRuntimeClient } from '../../../services/runtime-client';

const REASON_MESSAGES: Record<WorkdirValidationReason | 'invalid-path', string> = {
  'invalid-path': 'Directory browsing requires an absolute path.',
  'not-found': 'The requested directory does not exist.',
  'not-a-directory': 'The requested path is not a directory.',
  'permission-denied': 'The server cannot access the requested directory.',
};

export class DirectoryBrowserError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'FILESYSTEM',
    readonly reason: WorkdirValidationReason | 'invalid-path'
  ) {
    super(REASON_MESSAGES[reason]);
    this.name = 'DirectoryBrowserError';
  }
}

export async function listDirectory(path?: string): Promise<ListDirectoryResponse> {
  try {
    const runtime = await getRuntimeClient();
    return await runtime.workspace.browse(path === undefined ? {} : { path });
  } catch (error) {
    throw mapBrowseFailure(error);
  }
}

function mapBrowseFailure(error: unknown): Error {
  if (error instanceof RuntimeRemoteError && detailString(error, 'kind') === 'workspace_browser') {
    const code = detailString(error, 'code');
    const reason = detailString(error, 'reason');
    if ((code === 'VALIDATION' || code === 'FILESYSTEM') && isBrowserReason(reason)) {
      return new DirectoryBrowserError(code, reason);
    }
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isBrowserReason(value: unknown): value is WorkdirValidationReason | 'invalid-path' {
  return (
    value === 'invalid-path' ||
    value === 'not-found' ||
    value === 'not-a-directory' ||
    value === 'permission-denied'
  );
}

function detailString(error: RuntimeRemoteError, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}
