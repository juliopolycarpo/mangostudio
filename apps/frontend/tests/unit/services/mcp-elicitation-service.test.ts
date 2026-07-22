import { ERROR_CODES } from '@mangostudio/shared/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/lib/utils';
import {
  McpElicitationGoneError,
  respondMcpElicitation,
} from '../../../src/services/mcp-elicitation-service';

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn(),
}));

vi.mock('../../../src/lib/api-client', () => ({
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

    expect(result).toEqual({ status: 'accepted' });
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
