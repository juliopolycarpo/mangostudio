import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateChatTitleSuggestion } from '../../../src/features/chat/services/chat-title';

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn(),
}));

vi.mock('../../../src/lib/api-client', () => ({
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
