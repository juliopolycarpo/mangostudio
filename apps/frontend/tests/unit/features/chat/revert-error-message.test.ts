import { describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { revertErrorMessage } from '@/features/chat/components/RevertFileChangesButton';
import { ApiError } from '@/lib/utils';

const labels = {
  conflict: 'Could not revert: one or more files changed on disk.',
  outsideWorkdir: 'Could not revert: files outside the working directory.',
  failed: 'Could not revert file changes.',
};

describe('revertErrorMessage', () => {
  it('maps CONFLICT to the stale-file message', () => {
    const error = new ApiError({
      error: 'File changed on disk.',
      code: ERROR_CODES.CONFLICT,
    });

    expect(revertErrorMessage(error, labels)).toBe(labels.conflict);
  });

  it('maps PERMISSION_DENIED to the containment message', () => {
    const error = new ApiError({
      error: 'Path is outside the chat working directory.',
      code: ERROR_CODES.PERMISSION_DENIED,
    });

    expect(revertErrorMessage(error, labels)).toBe(labels.outsideWorkdir);
  });

  it('falls back to the generic failure for other codes', () => {
    const error = new ApiError({ error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });

    expect(revertErrorMessage(error, labels)).toBe(labels.failed);
  });

  it('falls back to the generic failure for non-API errors', () => {
    expect(revertErrorMessage(new Error('network'), labels)).toBe(labels.failed);
    expect(revertErrorMessage(null, labels)).toBe(labels.failed);
  });
});
