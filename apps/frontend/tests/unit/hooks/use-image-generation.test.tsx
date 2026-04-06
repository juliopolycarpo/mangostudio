import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '../../support/harness/render';
import { useImageGeneration } from '../../../src/hooks/use-image-generation';

vi.mock('../../../src/services/generation-service', () => ({
  uploadReferenceImage: vi.fn(),
  generateImage: vi.fn(),
}));

// Suppress React Query retries and console noise in tests
vi.mock('../../../src/hooks/use-messages-query', () => ({
  messageKeys: { list: (id: string) => ['messages', id] },
}));

vi.mock('../../../src/hooks/use-gallery-query', () => ({
  galleryKeys: { lists: () => ['gallery'] },
}));

import { uploadReferenceImage, generateImage } from '../../../src/services/generation-service';

const mockUpload = vi.mocked(uploadReferenceImage);
const mockGenerate = vi.mocked(generateImage);

function makeProps(overrides: Partial<Parameters<typeof useImageGeneration>[0]> = {}) {
  const appendOptimisticMessages = vi.fn();
  const replaceOptimisticMessages = vi.fn();
  const updateOptimisticMessage = vi.fn();

  return {
    chats: {
      currentChatId: 'chat-1',
      createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
      loadChats: vi.fn().mockResolvedValue(undefined),
    } as any,
    getActiveModel: () => 'test-model',
    settings: {
      globalImageSystemPrompt: '',
      globalImageQuality: 'standard',
    } as any,
    optimistic: {
      appendOptimisticMessages,
      replaceOptimisticMessages,
      updateOptimisticMessage,
    } as any,
    ...overrides,
  };
}

describe('useImageGeneration — reference image upload failure', () => {
  beforeEach(() => {
    mockUpload.mockReset();
    mockGenerate.mockReset();
  });

  it('shows user-visible error and does not call generateImage when upload fails', async () => {
    mockUpload.mockResolvedValue(null);

    const props = makeProps();
    const { result } = renderHook(() => useImageGeneration(props));

    const file = new File(['data'], 'ref.png', { type: 'image/png' });

    await act(async () => {
      await result.current.handleGenerate('a cat', file);
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    // Optimistic messages were appended before the upload attempt
    expect(props.optimistic.appendOptimisticMessages).toHaveBeenCalledTimes(1);

    // AI message updated with error text
    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      expect.objectContaining({ isGenerating: false })
    );

    const [, , update] = (props.optimistic.updateOptimisticMessage).mock.calls[0];
    expect(typeof update.text).toBe('string');
    expect(update.text.length).toBeGreaterThan(0);

    // generateImage must NOT have been called
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('proceeds with generateImage when upload succeeds', async () => {
    mockUpload.mockResolvedValue('https://cdn.example.com/ref.png');
    mockGenerate.mockResolvedValue({
      userMessage: {
        id: 'msg-u',
        chatId: 'chat-1',
        role: 'user',
        text: 'a cat',
        timestamp: new Date(),
        interactionMode: 'image',
      },
      aiMessage: {
        id: 'msg-a',
        chatId: 'chat-1',
        role: 'ai',
        text: '',
        imageUrl: 'https://cdn.example.com/gen.png',
        timestamp: new Date(),
        isGenerating: false,
        interactionMode: 'image',
      },
    } as any);

    const props = makeProps();
    const { result } = renderHook(() => useImageGeneration(props));

    const file = new File(['data'], 'ref.png', { type: 'image/png' });

    await act(async () => {
      await result.current.handleGenerate('a cat', file);
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImageUrl: 'https://cdn.example.com/ref.png' })
    );
    expect(props.optimistic.updateOptimisticMessage).not.toHaveBeenCalled();
  });
});
