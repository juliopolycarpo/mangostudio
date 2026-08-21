import { describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { browseErrorMessage } from '@/features/workspace/WorkdirPickerDialog';
import { ApiError } from '@/lib/utils';

const messages = {
  loadError: 'This folder could not be opened.',
  validationReasons: {
    notFound: 'The folder does not exist on the server.',
    notDirectory: 'The path does not point to a folder.',
    permissionDenied: 'The server does not have permission to access this folder.',
  },
};

describe('browseErrorMessage', () => {
  it('maps NOT_FOUND to the localized not-found reason', () => {
    const error = new ApiError({
      error: 'Path does not exist.',
      code: ERROR_CODES.NOT_FOUND,
    });
    expect(browseErrorMessage(error, messages)).toBe(messages.validationReasons.notFound);
  });

  it('maps NOT_A_DIRECTORY to the localized not-directory reason', () => {
    const error = new ApiError({
      error: 'Path is not a directory.',
      code: ERROR_CODES.NOT_A_DIRECTORY,
    });
    expect(browseErrorMessage(error, messages)).toBe(messages.validationReasons.notDirectory);
  });

  it('maps PERMISSION_DENIED to the localized permission-denied reason', () => {
    const error = new ApiError({
      error: 'Permission denied.',
      code: ERROR_CODES.PERMISSION_DENIED,
    });
    expect(browseErrorMessage(error, messages)).toBe(messages.validationReasons.permissionDenied);
  });

  it('returns loadError for unknown ApiError codes', () => {
    const error = new ApiError({
      error: 'Invalid path.',
      code: ERROR_CODES.VALIDATION,
    });
    expect(browseErrorMessage(error, messages)).toBe(messages.loadError);
  });

  it('returns loadError for non-ApiError values', () => {
    expect(browseErrorMessage(new Error('network'), messages)).toBe(messages.loadError);
    expect(browseErrorMessage(null, messages)).toBe(messages.loadError);
  });
});
