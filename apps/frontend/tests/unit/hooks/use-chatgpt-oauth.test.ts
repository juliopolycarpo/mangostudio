import { en } from '@mangostudio/shared/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatGptOAuth } from '../../../src/features/settings/connectors/hooks/use-chatgpt-oauth';
import { act, renderHook, waitFor } from '../../support/harness/render';

const mockStartChatGptOAuth = vi.fn();
const mockGetChatGptOAuthStatus = vi.fn();
const mockCancelChatGptOAuth = vi.fn();

vi.mock('../../../src/features/settings/connectors/api', () => {
  class ConnectorApiError extends Error {
    readonly code?: string;

    constructor(value: unknown, fallbackMessage: string) {
      const payload = value as { error?: string; code?: string } | undefined;
      super(payload?.error ?? fallbackMessage);
      this.code = payload?.code;
    }
  }

  return {
    ConnectorApiError,
    startChatGptOAuth: (...args: unknown[]) => mockStartChatGptOAuth(...args),
    getChatGptOAuthStatus: (...args: unknown[]) => mockGetChatGptOAuthStatus(...args),
    cancelChatGptOAuth: (...args: unknown[]) => mockCancelChatGptOAuth(...args),
  };
});

function makePopup() {
  return {
    location: { href: '' },
    close: vi.fn(),
  } as unknown as Window;
}

describe('useChatGptOAuth', () => {
  beforeEach(() => {
    mockStartChatGptOAuth.mockReset();
    mockGetChatGptOAuthStatus.mockReset();
    mockCancelChatGptOAuth.mockReset();
    mockCancelChatGptOAuth.mockResolvedValue(undefined);
  });

  it('polls until completion and calls onSuccess', async () => {
    const popup = makePopup();
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    mockStartChatGptOAuth.mockResolvedValue({
      sessionId: 'session-1',
      authorizeUrl: 'https://chatgpt.example/authorize',
      expiresAt: Date.now() + 60_000,
    });
    mockGetChatGptOAuthStatus.mockResolvedValue({
      status: 'completed',
      connectorId: 'connector-1',
    });

    const { result } = renderHook(() =>
      useChatGptOAuth({ messages: en.settings.connectors, onSuccess })
    );

    await act(async () => {
      await result.current.start({ name: 'ChatGPT Plus', popup });
    });

    expect(popup.location.href).toBe('https://chatgpt.example/authorize');
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('connector-1'));
    expect(mockGetChatGptOAuthStatus).toHaveBeenCalledWith('session-1');
    expect(result.current.phase).toBe('completed');
  });

  it('cancels a pending session on unmount', async () => {
    const popup = makePopup();
    mockStartChatGptOAuth.mockResolvedValue({
      sessionId: 'session-cleanup',
      authorizeUrl: 'https://chatgpt.example/authorize',
      expiresAt: Date.now() + 60_000,
    });
    mockGetChatGptOAuthStatus.mockResolvedValue({ status: 'pending' });

    const { result, unmount } = renderHook(() =>
      useChatGptOAuth({ messages: en.settings.connectors, onSuccess: vi.fn() })
    );

    await act(async () => {
      await result.current.start({ name: 'ChatGPT Plus', popup });
    });

    unmount();

    expect(mockCancelChatGptOAuth).toHaveBeenCalledWith('session-cleanup');
  });
});
