import { describe, expect, it, spyOn } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { ConnectorValidationError } from '../../../../src/modules/connectors/application/add-connector';
import {
  ConnectorNotFoundError,
  ConnectorOwnershipError,
} from '../../../../src/modules/connectors/application/connector-errors';
import { handleConnectorError } from '../../../../src/modules/connectors/http/connectors-routes';
import {
  OpenAIAuthError,
  OpenAIConfigError,
  UnsafeBaseUrlError,
} from '../../../../src/modules/connectors/infrastructure/provider-validation';
import { CursorApiError } from '../../../../src/services/providers/cursor/client';
import { CursorRuntimeUnavailableError } from '../../../../src/services/providers/cursor/index';
import {
  GeminiValidationUnavailableError,
  InvalidGeminiApiKeyError,
} from '../../../../src/services/providers/gemini/secret';
import { SecretStorageUnavailableError } from '../../../../src/services/secret-store';

describe('handleConnectorError', () => {
  it('maps known connector errors to the expected API payloads', () => {
    const cases = [
      {
        error: new ConnectorValidationError('Missing API key', ERROR_CODES.VALIDATION, 400),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.VALIDATION,
        expectedMessage: 'Missing API key',
      },
      {
        error: new ConnectorNotFoundError(),
        expectedStatus: 404,
        expectedCode: ERROR_CODES.NOT_FOUND,
        expectedMessage: 'Connector not found.',
      },
      {
        error: new ConnectorOwnershipError(),
        expectedStatus: 403,
        expectedCode: ERROR_CODES.OWNERSHIP,
        expectedMessage: 'Cannot delete a shared connector.',
      },
      {
        error: new UnsafeBaseUrlError('Invalid URL.'),
        expectedStatus: 422,
        expectedCode: ERROR_CODES.VALIDATION,
        expectedMessage: 'Invalid URL.',
      },
      {
        error: new InvalidGeminiApiKeyError('Gemini key rejected'),
        expectedStatus: 422,
        expectedCode: ERROR_CODES.VALIDATION,
        expectedMessage: 'Gemini key rejected',
      },
      {
        error: new SecretStorageUnavailableError('Keychain offline'),
        expectedStatus: 503,
        expectedCode: ERROR_CODES.PROVIDER_ERROR,
        expectedMessage: 'OS secret storage is unavailable on this machine.',
      },
      {
        error: new GeminiValidationUnavailableError('Gemini probe timed out'),
        expectedStatus: 502,
        expectedCode: ERROR_CODES.PROVIDER_ERROR,
        expectedMessage: 'Gemini probe timed out',
      },
      {
        error: new OpenAIAuthError('Organization mismatch', 403),
        expectedStatus: 403,
        expectedCode: ERROR_CODES.VALIDATION,
        expectedMessage: 'Organization mismatch',
      },
      {
        error: new OpenAIConfigError('Project ID is required'),
        expectedStatus: 422,
        expectedCode: ERROR_CODES.VALIDATION,
        expectedMessage: 'Project ID is required',
      },
      {
        error: new CursorApiError('Cursor API key is invalid.'),
        expectedStatus: 422,
        expectedCode: ERROR_CODES.VALIDATION,
        expectedMessage: 'Cursor API key is invalid.',
      },
      {
        error: new CursorRuntimeUnavailableError('Node.js 22.13 or newer is required.'),
        expectedStatus: 503,
        expectedCode: ERROR_CODES.PROVIDER_ERROR,
        expectedMessage: 'Node.js 22.13 or newer is required.',
      },
    ] as const;

    for (const testCase of cases) {
      const set: { status?: number | string } = {};

      expect(handleConnectorError(testCase.error, set)).toEqual({
        error: testCase.expectedMessage,
        code: testCase.expectedCode,
      });
      expect(set.status).toBe(testCase.expectedStatus);
    }
  });

  it('falls back to an internal error for unexpected failures', () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const set: { status?: number | string } = {};

    expect(handleConnectorError(new Error('Unexpected boom'), set)).toEqual({
      error: 'Unexpected boom',
      code: ERROR_CODES.INTERNAL,
    });
    expect(set.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
