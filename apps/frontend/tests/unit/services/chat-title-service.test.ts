import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

// `vi.hoisted` existed because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so a plain const is enough.
const mockPost = jest.fn();

mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: {
      chats: {
        'title-suggestion': {
          post: mockPost,
        },
      },
    },
  },
}));

// Below the mock, never as a static import: those are evaluated first and the
// service would bind the real API client.
const { generateChatTitleSuggestion } = await import(
  '../../../src/features/chat/services/chat-title'
);

describe('generateChatTitleSuggestion', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('returns the generated title from the chats API', async () => {
    mockPost.mockResolvedValue({ data: { title: 'Generated title' }, error: null });

    const response = await generateChatTitleSuggestion({
      prompt: 'Explain deterministic testing with Vitest',
      model: 'title-model',
    });

    expect(mockPost).toHaveBeenCalledWith({
      prompt: 'Explain deterministic testing with Vitest',
      model: 'title-model',
    });
    expect(response).toEqual({ title: 'Generated title' });
  });

  it('throws when the API returns an error', async () => {
    mockPost.mockResolvedValue({ data: null, error: { value: { error: 'Provider unavailable' } } });

    await expect(
      generateChatTitleSuggestion({
        prompt: 'Explain deterministic testing with Vitest',
        model: 'title-model',
      })
    ).rejects.toThrow('Provider unavailable');
  });
});
