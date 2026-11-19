/**
 * The two halves of the writer-id design, running together against one cache:
 * `useSettingsRealtimeInvalidation` decides which events refetch, and
 * `useGlobalSettings` auto-saves into the same query. The old echo window made
 * them interfere: the first keystroke of an edit opened it, and any other tab's
 * write that arrived while it was open was dropped.
 */
import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import {
  type AppSettings,
  type AppSettingsPutBody,
  DEFAULT_APP_SETTINGS,
} from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import { useQueryClient } from '@tanstack/react-query';

import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';
import { getTabWriterId } from '@/lib/realtime/writer-id';

import { act, renderHook, screen, waitFor } from '../../../support/harness/render';
import { setTestSession } from '../../../support/setup/auth-client-stub';

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockSubscribe = jest.fn();

void mock.module('../../../../src/lib/api-client', () => ({
  client: { api: { settings: { app: { get: mockGet, put: mockPut } } } },
}));

void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: jest.fn(),
  getRealtimeClient: () => ({ subscribe: mockSubscribe }),
}));

// Imported after the mocks so both hooks bind the fakes.
const { useGlobalSettings } = await import('../../../../src/hooks/use-global-settings');
const { useSettingsRealtimeInvalidation } =
  await import('../../../../src/features/settings/hooks/use-settings-realtime');
const { appSettingsKeys, refreshAppSettingsAfterConflict } =
  await import('../../../../src/features/settings/app/queries');
const { ApiError } = await import('../../../../src/lib/utils');

const OTHER_TAB = 'other-tab-writer';
const PROMPT_A = 'typed while the other tab saved';

describe('app settings auto-save with realtime invalidation on the same cache', () => {
  let listener: RealtimeTopicListener;

  function renderBoth() {
    return renderHook(() => {
      useSettingsRealtimeInvalidation();
      return { settings: useGlobalSettings(), queryClient: useQueryClient() };
    });
  }

  function deliverAppEvent(writerId: string) {
    return act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings', scopes: ['app'], writerId } as never,
      });
    });
  }

  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    mockGet.mockReset();
    mockPut.mockReset();
    mockSubscribe.mockReset();
    mockSubscribe.mockImplementation((_topic: string, next: RealtimeTopicListener) => {
      listener = next;
      return jest.fn();
    });
    mockGet.mockResolvedValue({
      data: { ...DEFAULT_APP_SETTINGS, revision: '"r1"' },
      error: null,
    });
    mockPut.mockImplementation((patch: AppSettingsPutBody) =>
      Promise.resolve({ data: { ...patch, revision: '"r9"' }, error: null })
    );
  });

  // The regression: a write by another tab inside what used to be the echo
  // window was dropped until the window closed. It must refetch at once, and
  // the edit this tab has not sent yet must survive that refetch.
  it('applies another tab write at once mid-edit and keeps the unsent key', async () => {
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.settings.isLoading).toBe(false));
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

    act(() => result.current.settings.setTextSystemPrompt(PROMPT_A));
    mockGet.mockResolvedValue({
      data: { ...DEFAULT_APP_SETTINGS, revision: '"r2"', globalImageQuality: '4K' },
      error: null,
    });
    const readsBeforeEvent = mockGet.mock.calls.length;

    await deliverAppEvent(OTHER_TAB);

    expect(
      mockGet.mock.calls.length,
      `expected another tab's write to refetch immediately mid-edit | received: ${mockGet.mock.calls.length - readsBeforeEvent} reads`
    ).toBe(readsBeforeEvent + 1);
    await waitFor(() => expect(result.current.settings.globalImageQuality).toBe('4K'));
    expect(result.current.settings.promptSettings.textSystemPrompt).toBe(PROMPT_A);
  });

  it('does not refetch for the echo of its own save while the edit is still open', async () => {
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.settings.isLoading).toBe(false));
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

    act(() => result.current.settings.setTextSystemPrompt(PROMPT_A));
    await waitFor(() =>
      expect(result.current.settings.promptSettings.textSystemPrompt).toBe(PROMPT_A)
    );
    const readsBeforeEvent = mockGet.mock.calls.length;

    await deliverAppEvent(getTabWriterId());

    expect(mockGet.mock.calls.length).toBe(readsBeforeEvent);
    expect(result.current.settings.promptSettings.textSystemPrompt).toBe(PROMPT_A);
    expect(result.current.queryClient.getQueryState(appSettingsKeys.current())?.isInvalidated).toBe(
      false
    );
  });

  // Realtime refetches now overlap typing. The invalidation guard in
  // `saveSettings` exists for rejected (409) snapshots; an ordinary event only
  // makes the cache stale, so a keystroke must queue and ride the refetch.
  it('queues a keystroke typed while another tab refetch is in flight', async () => {
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.settings.isLoading).toBe(false));
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

    const refetch = Promise.withResolvers<{ data: unknown; error: null }>();
    mockGet.mockImplementation(() => refetch.promise);
    let delivered: Promise<void> | undefined;
    act(() => {
      delivered = listener({
        type: 'invalidate',
        message: {
          type: 'invalidate',
          topic: 'settings',
          scopes: ['app'],
          writerId: OTHER_TAB,
        } as never,
      }) as Promise<void>;
    });
    await waitFor(() =>
      expect(
        result.current.queryClient.getQueryState(appSettingsKeys.current())?.isInvalidated
      ).toBe(true)
    );

    // Typed before the refetch resolves.
    act(() => result.current.settings.setTextSystemPrompt(PROMPT_A));
    expect(
      screen.queryByText(en.errors.settingsSaveFailed),
      `expected no "${en.errors.settingsSaveFailed}" toast for a keystroke during an ordinary refetch | received: the toast`
    ).toBeNull();

    await act(async () => {
      refetch.resolve({
        data: { ...DEFAULT_APP_SETTINGS, revision: '"r2"', globalImageQuality: '4K' },
        error: null,
      });
      await delivered;
    });

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    const sent = mockPut.mock.calls[0]?.[0] as AppSettingsPutBody;
    expect(
      sent.promptSettings?.textSystemPrompt,
      'expected the PUT to carry the key typed during the refetch | received: the fetched value'
    ).toBe(PROMPT_A);
    expect(sent.globalImageQuality).toBe('4K');
    const options = mockPut.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(options.headers['if-match']).toBe('"r2"');
    expect(screen.queryByText(en.errors.settingsSaveFailed)).toBeNull();
  });

  it('still refuses a keystroke while a conflict refresh is pending, then accepts one after it lands', async () => {
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.settings.isLoading).toBe(false));

    const refresh = Promise.withResolvers<{ data: unknown; error: null }>();
    mockGet.mockImplementation(() => refresh.promise);
    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = refreshAppSettingsAfterConflict(
        result.current.queryClient,
        new ApiError({ code: 'CONFLICT' })
      );
    });
    await waitFor(() =>
      expect(
        result.current.queryClient.getQueryState(appSettingsKeys.current())?.isInvalidated
      ).toBe(true)
    );

    act(() => result.current.settings.setTextSystemPrompt(PROMPT_A));
    await waitFor(() => expect(screen.getByText(en.errors.settingsSaveFailed)).toBeTruthy());
    // Refused: nothing was built from the rejected snapshot.
    expect(
      result.current.queryClient.getQueryData<AppSettings>(appSettingsKeys.current())
        ?.promptSettings.textSystemPrompt
    ).toBe(DEFAULT_APP_SETTINGS.promptSettings.textSystemPrompt);
    expect(mockPut).not.toHaveBeenCalled();

    await act(async () => {
      refresh.resolve({ data: { ...DEFAULT_APP_SETTINGS, revision: '"r3"' }, error: null });
      await refreshing;
    });
    mockGet.mockResolvedValue({ data: { ...DEFAULT_APP_SETTINGS, revision: '"r3"' }, error: null });

    act(() => result.current.settings.setTextSystemPrompt(PROMPT_A));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    const options = mockPut.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(options.headers['if-match']).toBe('"r3"');
  });
});
