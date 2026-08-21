import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type * as GenerationService from '../../../src/services/generation-service';
import { act, renderHook, waitFor } from '../../support/harness/render';

// No Bun equivalent for `vi.mocked` — the `jest.fn()` handles created here are
// what the factory below hands back, so keep them instead.
const mockUpload = jest.fn();
const mockGenerate = jest.fn();

mock.module('../../../src/services/generation-service', () => ({
  uploadReferenceImage: mockUpload,
  generateImage: mockGenerate,
}));

// Suppress React Query retries and console noise in tests
mock.module('../../../src/features/chat/queries', () => ({
  messageKeys: { list: (id: string) => ['messages', id] },
}));

mock.module('../../../src/features/gallery/queries', () => ({
  galleryKeys: { lists: () => ['gallery'] },
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real generation service.
const { useImageGeneration } = await import(
  '../../../src/features/generation/hooks/use-image-generation'
);

type ImageGenProps = Parameters<typeof useImageGeneration>[0];

function makeProps(overrides: Partial<ImageGenProps> = {}) {
  const appendOptimisticMessages = jest.fn();
  const replaceOptimisticMessages = jest.fn();
  const updateOptimisticMessage = jest.fn();

  return {
    chats: {
      currentChatId: 'chat-1',
      createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
      loadChats: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImageGenProps['chats'],
    getActiveModel: () => 'test-model',
    settings: {
      globalImageSystemPrompt: '',
      globalImageQuality: 'standard',
    } as unknown as ImageGenProps['settings'],
    optimistic: {
      appendOptimisticMessages,
      replaceOptimisticMessages,
      updateOptimisticMessage,
    } as unknown as ImageGenProps['optimistic'],
    ...overrides,
    // Kept alongside the cast-to-unknown props above so assertions can read
    // `.mock.calls` — `jest.mocked` has no Bun equivalent to regain that typing.
    replaceOptimisticMessages,
    updateOptimisticMessage,
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

    const [, , update] = props.updateOptimisticMessage.mock.calls[0];
    expect(typeof update.text).toBe('string');
    expect(update.text?.length ?? 0).toBeGreaterThan(0);

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
        timestamp: Date.now(),
        interactionMode: 'image',
      },
      aiMessage: {
        id: 'msg-a',
        chatId: 'chat-1',
        role: 'ai',
        text: '',
        imageUrl: 'https://cdn.example.com/gen.png',
        timestamp: Date.now(),
        isGenerating: false,
        interactionMode: 'image',
      },
    } as unknown as Awaited<ReturnType<typeof GenerationService.generateImage>>);

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

  it('replaces optimistic messages with the generated /images URL', async () => {
    mockGenerate.mockResolvedValue({
      userMessage: {
        id: 'msg-u',
        chatId: 'chat-1',
        role: 'user',
        text: 'a mango robot',
        timestamp: Date.now(),
        interactionMode: 'image',
      },
      aiMessage: {
        id: 'msg-a',
        chatId: 'chat-1',
        role: 'ai',
        text: '',
        imageUrl: '/images/generated-mango.png',
        timestamp: Date.now(),
        isGenerating: false,
        generationTime: '2.4s',
        modelName: 'gpt-image-2',
        styleParams: ['1K'],
        interactionMode: 'image',
      },
    } as unknown as Awaited<ReturnType<typeof GenerationService.generateImage>>);

    const props = makeProps({ getActiveModel: () => 'gpt-image-2' });
    const { result } = renderHook(() => useImageGeneration(props));

    await act(async () => {
      await result.current.handleGenerate('a mango robot');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const [, , replacementMessages] = props.replaceOptimisticMessages.mock.calls[0];
    expect(replacementMessages[1]).toEqual(
      expect.objectContaining({ imageUrl: '/images/generated-mango.png', modelName: 'gpt-image-2' })
    );
    expect(props.chats.loadChats).not.toHaveBeenCalled();
  });

  it('uses the localized fallback when image generation throws a non-Error value', async () => {
    mockGenerate.mockRejectedValue('offline');

    const props = makeProps();
    const { result } = renderHook(() => useImageGeneration(props));

    await act(async () => {
      await result.current.handleGenerate('a mango robot');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      expect.objectContaining({
        isGenerating: false,
        text: 'Failed to generate image. Please try again.',
      })
    );
  });
});
