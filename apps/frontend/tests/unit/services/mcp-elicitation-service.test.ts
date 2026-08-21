import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { ApiError } from '../../../src/lib/utils';

// `vi.hoisted` existed because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so a plain const is enough.
const mockPost = jest.fn();

mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: {
      mcp: {
        elicitations: () => ({
          respond: {
            post: mockPost,
          },
        }),
      },
    },
  },
}));

// Below the mock, never as a static import: those are evaluated first and the
// service would bind the real API client.
const { McpElicitationGoneError, respondMcpElicitation } = await import(
  '../../../src/services/mcp-elicitation-service'
);

describe('respondMcpElicitation', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('returns the API response on success', async () => {
    mockPost.mockResolvedValue({
      data: { status: 'accepted' },
      error: null,
    });

    const result = await respondMcpElicitation('elicitation-1', {
      action: 'accept',
      content: { confirmed: true },
    });

    // `expect<unknown>` because bun-types types `toEqual` against the received
    // type, and the double above answers with a deliberately partial payload.
    expect<unknown>(result).toEqual({ status: 'accepted' });
  });

  it('throws McpElicitationGoneError when the elicitation is not found', async () => {
    mockPost.mockResolvedValue({
      data: null,
      error: { value: { error: 'Elicitation not found', code: ERROR_CODES.NOT_FOUND } },
    });

    await expect(respondMcpElicitation('stale-id', { action: 'decline' })).rejects.toBeInstanceOf(
      McpElicitationGoneError
    );
  });

  it('throws ApiError for other API failures', async () => {
    mockPost.mockResolvedValue({
      data: null,
      error: { value: { error: 'Validation failed', code: ERROR_CODES.VALIDATION } },
    });

    const rejection = respondMcpElicitation('elicitation-1', { action: 'accept', content: {} });
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await expect(rejection).rejects.toMatchObject({
      serverMessage: 'Validation failed',
      code: ERROR_CODES.VALIDATION,
    });
  });
});
