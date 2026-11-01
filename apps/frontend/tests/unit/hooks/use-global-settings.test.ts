import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import type { AppSettings, AppSettingsPutBody } from '@mangostudio/shared/app-settings';
import { DEFAULT_APP_SETTINGS, MAX_TOOL_ITERATIONS_MAX } from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import type { WorkspacePanelSettings } from '@mangostudio/shared/workspaces';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { act, flushAsyncRender, renderHook, screen, waitFor } from '../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../support/harness/timers';

// No Bun equivalent for `vi.mocked` — the `jest.fn()` handles created here are
// what the factory below hands back, so keep them instead.
const mockGet = jest.fn();
const mockPut = jest.fn();

void mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: {
      settings: {
        app: {
          get: mockGet,
          put: mockPut,
        },
      },
    },
  },
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real api-client.
const { useGlobalSettings } = await import('../../../src/hooks/use-global-settings');
const { appSettingsKeys, appSettingsQueryOptions, libraryLocationDefaultsPending } =
  await import('../../../src/features/settings/app/queries');

type MockGetResult = Awaited<ReturnType<typeof mockGet>>;
type MockPutResult = Awaited<ReturnType<typeof mockPut>>;

function mockQueryResult(data: unknown, error: unknown = null) {
  return { data, error } as unknown as MockGetResult;
}

function mockMutationResult(data: unknown, error: unknown = null) {
  return { data, error } as unknown as MockPutResult;
}

describe('useGlobalSettings', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    mockGet.mockResolvedValue(mockQueryResult(DEFAULT_APP_SETTINGS));
    mockPut.mockImplementation((settings: AppSettingsPutBody) =>
      Promise.resolve(mockMutationResult(settings as AppSettings))
    );
  });

  it('returns defaults while loading and then hydrates from the API', async () => {
    const persistedSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      globalImageQuality: '4K',
      maxToolIterations: 12,
      promptSettings: {
        ...DEFAULT_APP_SETTINGS.promptSettings,
        textSystemPrompt: 'Persisted prompt',
      },
    };
    mockGet.mockResolvedValue(mockQueryResult(persistedSettings));

    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.globalImageQuality).toBe(DEFAULT_APP_SETTINGS.globalImageQuality);
    expect(result.current.maxToolIterations).toBe(DEFAULT_APP_SETTINGS.maxToolIterations);
    await waitFor(() => expect(result.current.globalImageQuality).toBe('4K'));
    await waitFor(() => expect(result.current.maxToolIterations).toBe(12));
    await waitFor(() =>
      expect(result.current.promptSettings.textSystemPrompt).toBe('Persisted prompt')
    );
  });

  it('clamps maxToolIterations before persisting', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setMaxToolIterations(2_000);
    });

    await waitFor(() => expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_MAX));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      maxToolIterations: MAX_TOOL_ITERATIONS_MAX,
    });
  });

  it('persists chat title auto rename settings through the app settings mutation', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setChatAutoRenameEnabled(false);
    });

    await waitFor(() => expect(result.current.chatTitleSettings.autoRenameEnabled).toBe(false));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      chatTitleSettings: { autoRenameEnabled: false, promptPrefixLength: 30 },
    });
  });

  it('persists Git commit preferences through the app settings mutation', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setSignCommits(true);
      result.current.setSignOff(true);
    });

    await waitFor(() =>
      expect(result.current.gitSettings).toEqual({
        ...DEFAULT_APP_SETTINGS.gitSettings,
        signCommits: true,
        signOff: true,
      })
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      gitSettings: { signCommits: true, signOff: true },
    });
  });

  it('persists commit-message generation preferences', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setPreferredCommitMessageModel('fast-model');
      result.current.setCommitMessageSystemPrompt('Write a focused message.');
      result.current.setCommitMessageMaxDiffKb(200);
    });

    await waitFor(() =>
      expect(result.current.gitSettings.commitMessage).toEqual({
        preferredModel: 'fast-model',
        systemPrompt: 'Write a focused message.',
        maxDiffKb: 200,
      })
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      gitSettings: {
        commitMessage: {
          preferredModel: 'fast-model',
          systemPrompt: 'Write a focused message.',
          maxDiffKb: 200,
        },
      },
    });
  });

  it('persists model-based chat title settings through the app settings mutation', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setChatTitleStrategy('model');
    });

    await waitFor(() => expect(result.current.chatTitleSettings.strategy).toBe('model'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      chatTitleSettings: { strategy: 'model', preferredModel: 'current_model' },
    });

    mockPut.mockClear();

    act(() => {
      result.current.setPreferredChatTitleModel('title-model');
    });

    await waitFor(() =>
      expect(result.current.chatTitleSettings.preferredModel).toBe('title-model')
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      chatTitleSettings: { strategy: 'model', preferredModel: 'title-model' },
    });
  });

  it('clamps chat title prompt prefix length before persisting', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setChatTitlePromptPrefixLength(120);
    });

    await waitFor(() => expect(result.current.chatTitleSettings.promptPrefixLength).toBe(80));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      chatTitleSettings: { autoRenameEnabled: true, promptPrefixLength: 80 },
    });
  });

  it('normalizes persisted context thresholds from the API', async () => {
    mockGet.mockResolvedValue(
      mockQueryResult({
        ...DEFAULT_APP_SETTINGS,
        contextSettings: {
          ...DEFAULT_APP_SETTINGS.contextSettings,
          compactionBehavior: 'auto_compact_current_chat',
          warningThreshold: 0.97,
          dangerThreshold: 0.85,
          hardStopThreshold: 0.92,
          preferredSummaryModel: 'gpt-4o-mini',
          providerCompactionEnabled: false,
        },
      })
    );

    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() =>
      expect(result.current.contextSettings).toEqual({
        compactionBehavior: 'auto_compact_current_chat',
        warningThreshold: 0.85,
        dangerThreshold: 0.92,
        hardStopThreshold: 0.97,
        preferredSummaryModel: 'gpt-4o-mini',
        providerCompactionEnabled: false,
      })
    );
  });

  it('persists prompt updates through the app settings mutation', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setTextSystemPrompt('new text prompt');
    });

    await waitFor(() =>
      expect(result.current.promptSettings.textSystemPrompt).toBe('new text prompt')
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      promptSettings: { textSystemPrompt: 'new text prompt' },
    });
  });

  it('persists a default workdir and keeps deduplicated recent workdirs', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setDefaultWorkdir('/srv/projects/mango');
      result.current.addRecentWorkdir('/srv/projects/other');
      result.current.addRecentWorkdir('/srv/projects/mango');
      result.current.addRecentWorkdir('/srv/projects/other');
    });

    await waitFor(() =>
      expect(result.current.workspaceSettings).toEqual({
        defaultWorkdir: '/srv/projects/mango',
        recentWorkdirs: ['/srv/projects/other', '/srv/projects/mango'],
        restrictToolsToWorkdir: false,
        chatSidebarWidth: DEFAULT_APP_SETTINGS.workspaceSettings.chatSidebarWidth,
        sidePanel: DEFAULT_APP_SETTINGS.workspaceSettings.sidePanel,
      })
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0].workspaceSettings).toEqual({
      defaultWorkdir: '/srv/projects/mango',
      recentWorkdirs: ['/srv/projects/other', '/srv/projects/mango'],
      restrictToolsToWorkdir: false,
      chatSidebarWidth: DEFAULT_APP_SETTINGS.workspaceSettings.chatSidebarWidth,
      sidePanel: DEFAULT_APP_SETTINGS.workspaceSettings.sidePanel,
    });
  });

  it('persists side panel visibility, order, and clamped width', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setWorkspacePanelVisible('git', false);
      result.current.moveWorkspacePanel('todos', 'up');
      result.current.setWorkspacePanelWidth(10_000);
      result.current.setChatSidebarWidth(10_000);
    });

    // Hiding `git` leaves the others visible, and moving `todos` up swaps it
    // past `github`. Both lists start from the full default panel set, so they
    // grow whenever a panel ships.
    const expectedSidePanel: WorkspacePanelSettings = {
      visiblePanelIds: ['github', 'todos', 'terminal'],
      panelOrder: ['git', 'todos', 'github', 'terminal'],
      width: 640,
    };

    await waitFor(() =>
      expect(result.current.workspaceSettings).toEqual({
        ...DEFAULT_APP_SETTINGS.workspaceSettings,
        chatSidebarWidth: 420,
        sidePanel: expectedSidePanel,
      })
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0].workspaceSettings).toEqual({
      ...DEFAULT_APP_SETTINGS.workspaceSettings,
      chatSidebarWidth: 420,
      sidePanel: expectedSidePanel,
    });
  });

  it('batches rapid prompt updates into a single persisted request', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setTextSystemPrompt('draft');
      result.current.setTextSystemPrompt('draft v2');
      result.current.setTextSystemPrompt('final prompt');
    });

    await waitFor(() =>
      expect(result.current.promptSettings.textSystemPrompt).toBe('final prompt')
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      promptSettings: { textSystemPrompt: 'final prompt' },
    });
  });

  it('coalesces a typing burst into a single PUT', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Fake timers only from here: the initial load above needs real ones, and
    // the gap between keystrokes has to be shorter than the 300ms debounce by
    // construction rather than by luck. With real timers this slept 40ms four
    // times, and a stall past 300ms anywhere in the burst fires an early PUT —
    // measured once in seven full-lane runs, where the assertion then read
    // "dr" instead of "draft".
    useFakeTimers();

    // Separate acts, so each keystroke commits its own render. The debounce has
    // to survive those re-renders: a timer keyed on the unstable `useMutation`
    // result would be flushed by the effect cleanup on every one of them.
    for (const value of ['d', 'dr', 'dra', 'draft']) {
      act(() => {
        result.current.setTextSystemPrompt(value);
      });
      await advanceTimersByTimeAsync(40);
    }

    expect(mockPut).not.toHaveBeenCalled();

    await advanceTimersByTimeAsync(300);
    await restoreRealTimers();

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      promptSettings: { textSystemPrompt: 'draft' },
    });
  });

  it('flushes a still-pending save when the hook unmounts', async () => {
    const { result, unmount } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setTextSystemPrompt('draft left behind');
    });

    expect(mockPut).not.toHaveBeenCalled();

    unmount();

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({
      promptSettings: { textSystemPrompt: 'draft left behind' },
    });
  });

  it('rolls the burst back to its starting point and reports a failed save', async () => {
    // Held open so the optimistic state is observable before the failure lands.
    let failPut: (() => void) | undefined;
    mockPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          failPut = () =>
            resolve(mockMutationResult(null, { value: { error: 'settings write failed' } }));
        })
    );

    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setTextSystemPrompt('draft');
      result.current.setTextSystemPrompt('final draft');
    });

    // Optimistic: the burst is on screen well before the request settles.
    await waitFor(() => expect(result.current.promptSettings.textSystemPrompt).toBe('final draft'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    act(() => failPut?.());

    // Back to where the burst started, not to its first intermediate value.
    await waitFor(() =>
      expect(result.current.promptSettings.textSystemPrompt).toBe(
        DEFAULT_APP_SETTINGS.promptSettings.textSystemPrompt
      )
    );
    expect(screen.getByText(en.settings.autoSave.errorRevertedToast)).toBeTruthy();
  });

  /**
   * Two PUTs overlap when an edit lands while an earlier one is still open. The
   * pair can settle in either order, and only the newest submission may touch
   * the cache — an older response must never reinstate a value the user has
   * already typed past, nor drag the rollback target forward with it.
   */
  describe('overlapping saves', () => {
    /** Holds every PUT open so their settle order can be chosen by the test. */
    function holdEveryPut(): Array<(result: MockPutResult) => void> {
      const settlePut: Array<(result: MockPutResult) => void> = [];
      mockPut.mockImplementation(
        () =>
          new Promise((resolve) => {
            settlePut.push(resolve);
          })
      );
      return settlePut;
    }

    function failedPut(): MockPutResult {
      return mockMutationResult(null, { value: { error: 'settings write failed' } });
    }

    function savedPut(textSystemPrompt: string): MockPutResult {
      return mockMutationResult({
        ...DEFAULT_APP_SETTINGS,
        promptSettings: { ...DEFAULT_APP_SETTINGS.promptSettings, textSystemPrompt },
      });
    }

    /**
     * Settles a held PUT and lets its mutation callbacks run before returning,
     * so what the next edit sees is the state they left behind.
     */
    async function settle(
      resolvePut: ((result: MockPutResult) => void) | undefined,
      putResult: MockPutResult
    ): Promise<void> {
      await act(async () => {
        resolvePut?.(putResult);
        await Promise.resolve();
      });
    }

    it('does not claim a rollback when a superseded save fails', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => useGlobalSettings());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => result.current.setTextSystemPrompt('first'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
      act(() => result.current.setTextSystemPrompt('second'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(2));

      // The older PUT fails after a newer one has already been submitted.
      act(() => settlePut[0]?.(failedPut()));

      await waitFor(() => expect(screen.getByText(en.settings.autoSave.errorToast)).toBeTruthy());
      // Nothing was reverted — the newer value is still on screen — so telling
      // the user it was would send them looking for an edit that is still there.
      expect(result.current.promptSettings.textSystemPrompt).toBe('second');
      expect(screen.queryByText(en.settings.autoSave.errorRevertedToast)).toBeNull();
    });

    it('does not refetch over a newer edit when a superseded save conflicts', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => useGlobalSettings());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      act(() => result.current.setTextSystemPrompt('first'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
      act(() => result.current.setTextSystemPrompt('second'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(2));
      const reads = mockGet.mock.calls.length;
      await settle(
        settlePut[0],
        mockMutationResult(null, {
          value: { error: 'Settings changed', code: 'CONFLICT' },
        })
      );
      expect(result.current.promptSettings.textSystemPrompt).toBe('second');
      expect(mockGet.mock.calls).toHaveLength(reads);
      await settle(settlePut[1], savedPut('second'));
    });

    for (const owner of ['layout', 'outlet'] as const) {
      it(`persists ${owner}'s edit based on a confirmed newer save after a delayed conflict`, async () => {
        const settlePut = holdEveryPut();
        const { result } = renderHook(() => ({
          layout: useGlobalSettings(),
          outlet: useGlobalSettings(),
        }));
        await waitFor(() => expect(result.current.layout.isLoading).toBe(false));
        const reads = mockGet.mock.calls.length;
        useFakeTimers();
        try {
          act(() => result.current.layout.setTextSystemPrompt('first'));
          await advanceTimersByTimeAsync(300);
          act(() => result.current.layout.setTextSystemPrompt('second'));
          await advanceTimersByTimeAsync(300);
          expect(mockPut).toHaveBeenCalledTimes(2);
          if (owner === 'outlet') {
            act(() => result.current.outlet.setTextSystemPrompt('queue before confirmation'));
          }
          await settle(settlePut[1], savedPut('second'));
          await advanceTimersByTimeAsync(0);
          act(() => result.current[owner].setTextSystemPrompt('third'));
          await advanceTimersByTimeAsync(0);
          expect(result.current[owner].promptSettings.textSystemPrompt).toBe('third');
          await settle(
            settlePut[0],
            mockMutationResult(null, { value: { error: 'Settings changed', code: 'CONFLICT' } })
          );
          await advanceTimersByTimeAsync(300);
          // This intent was built from confirmed PUT2, not PUT1's rejected base.
          // Keeping it on screen requires actually submitting it to the server.
          expect(mockPut).toHaveBeenCalledTimes(3);
          expect(mockPut.mock.calls[2]?.[0]).toMatchObject({
            promptSettings: { textSystemPrompt: 'third' },
          });
          expect(mockGet.mock.calls).toHaveLength(reads);
          await settle(settlePut[2], failedPut());
          await advanceTimersByTimeAsync(0);
          expect(result.current[owner].promptSettings.textSystemPrompt).toBe('second');
          // A subsequent field edit cannot inherit a discarded optimistic value.
          act(() => result.current[owner].setGlobalImageQuality('4K'));
          await advanceTimersByTimeAsync(300);
          expect(mockPut.mock.calls[3]?.[0]).toMatchObject({
            globalImageQuality: '4K',
            promptSettings: { textSystemPrompt: 'second' },
          });
        } finally {
          for (const complete of settlePut) complete(savedPut('second'));
          await restoreRealTimers();
        }
      });
    }

    it('preserves a queue based on another hook confirmed success after the replacement save', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => ({
        layout: useGlobalSettings(),
        outlet: useGlobalSettings(),
      }));
      await waitFor(() => expect(result.current.layout.isLoading).toBe(false));
      useFakeTimers();
      try {
        act(() => result.current.layout.setTextSystemPrompt('first'));
        await advanceTimersByTimeAsync(300);
        act(() => result.current.layout.setTextSystemPrompt('second'));
        await advanceTimersByTimeAsync(300);
        await settle(settlePut[1], savedPut('second'));
        act(() => result.current.outlet.setTextSystemPrompt('third confirmed'));
        await advanceTimersByTimeAsync(300);
        await settle(settlePut[2], savedPut('third confirmed'));
        act(() => result.current.outlet.setTextSystemPrompt('fourth queued'));
        await settle(
          settlePut[0],
          mockMutationResult(null, { value: { error: 'Settings changed', code: 'CONFLICT' } })
        );
        await advanceTimersByTimeAsync(300);
        expect(mockPut).toHaveBeenCalledTimes(4);
        expect(mockPut.mock.calls[3]?.[0]).toMatchObject({
          promptSettings: { textSystemPrompt: 'fourth queued' },
        });
        await settle(settlePut[3], failedPut());
        await advanceTimersByTimeAsync(0);
        expect(result.current.outlet.promptSettings.textSystemPrompt).toBe('third confirmed');
      } finally {
        for (const complete of settlePut) complete(savedPut('third confirmed'));
        await restoreRealTimers();
      }
    });

    it('still discards another hook queue built before the newer confirmed save', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => ({
        layout: useGlobalSettings(),
        outlet: useGlobalSettings(),
      }));
      await waitFor(() => expect(result.current.layout.isLoading).toBe(false));
      useFakeTimers();
      try {
        act(() => result.current.layout.setTextSystemPrompt('first'));
        await advanceTimersByTimeAsync(300);
        act(() => result.current.layout.setTextSystemPrompt('second'));
        await advanceTimersByTimeAsync(300);
        act(() => result.current.outlet.setTextSystemPrompt('older queued intent'));
        await settle(settlePut[1], savedPut('second'));
        await settle(
          settlePut[0],
          mockMutationResult(null, { value: { error: 'Settings changed', code: 'CONFLICT' } })
        );
        await advanceTimersByTimeAsync(300);
        expect(mockPut).toHaveBeenCalledTimes(2);
        expect(result.current.outlet.promptSettings.textSystemPrompt).toBe('second');
      } finally {
        for (const complete of settlePut) complete(savedPut('second'));
        await restoreRealTimers();
      }
    });

    it('does not revive an older queue across a refresh when a delayed conflict is superseded', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => ({
        layout: useGlobalSettings(),
        outlet: useGlobalSettings(),
        other: useGlobalSettings(),
      }));
      await waitFor(() => expect(result.current.layout.isLoading).toBe(false));
      useFakeTimers();
      try {
        act(() => result.current.layout.setTextSystemPrompt('first'));
        await advanceTimersByTimeAsync(300);
        act(() => result.current.layout.setTextSystemPrompt('second'));
        await advanceTimersByTimeAsync(300);
        await settle(settlePut[1], savedPut('second'));
        act(() => result.current.other.setTextSystemPrompt('conflicting other save'));
        await advanceTimersByTimeAsync(300);
        act(() => result.current.outlet.setTextSystemPrompt('queued on second'));
        mockGet.mockResolvedValue(
          mockQueryResult({
            ...DEFAULT_APP_SETTINGS,
            promptSettings: { ...DEFAULT_APP_SETTINGS.promptSettings, textSystemPrompt: 'winner' },
          })
        );
        const conflict = mockMutationResult(null, {
          value: { error: 'Settings changed', code: 'CONFLICT' },
        });
        await settle(settlePut[2], conflict);
        await settle(settlePut[0], conflict);
        await advanceTimersByTimeAsync(300);
        expect(mockPut).toHaveBeenCalledTimes(3);
        expect(result.current.outlet.promptSettings.textSystemPrompt).toBe('winner');
      } finally {
        for (const complete of settlePut) complete(savedPut('winner'));
        await restoreRealTimers();
      }
    });

    it('discards a queued stale burst instead of replaying it after a conflict', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => useGlobalSettings());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      useFakeTimers();
      try {
        act(() => result.current.setTextSystemPrompt('first'));
        await advanceTimersByTimeAsync(300);
        expect(mockPut).toHaveBeenCalledTimes(1);
        act(() => result.current.setTextSystemPrompt('queued stale burst'));
        mockGet.mockResolvedValue(
          mockQueryResult({
            ...DEFAULT_APP_SETTINGS,
            promptSettings: { ...DEFAULT_APP_SETTINGS.promptSettings, textSystemPrompt: 'winner' },
          })
        );
        await settle(
          settlePut[0],
          mockMutationResult(null, {
            value: { error: 'Settings changed', code: 'CONFLICT' },
          })
        );
        await advanceTimersByTimeAsync(300);
        expect(mockPut).toHaveBeenCalledTimes(1);
        expect(result.current.promptSettings.textSystemPrompt).toBe('winner');
      } finally {
        await restoreRealTimers();
      }
    });

    for (const refetch of ['finished', 'pending'] as const) {
      it(`discards another hook's queued snapshot when the conflict refetch is ${refetch}`, async () => {
        const settlePut = holdEveryPut();
        const { result } = renderHook(() => ({
          layout: useGlobalSettings(),
          outlet: useGlobalSettings(),
        }));
        await waitFor(() => expect(result.current.layout.isLoading).toBe(false));
        const refresh = Promise.withResolvers<MockGetResult>();
        const winner = mockQueryResult({
          ...DEFAULT_APP_SETTINGS,
          promptSettings: {
            ...DEFAULT_APP_SETTINGS.promptSettings,
            textSystemPrompt: 'external winner',
          },
        });
        mockGet.mockImplementation(() => refresh.promise);
        useFakeTimers();
        try {
          act(() => result.current.layout.setTextSystemPrompt('layout edit'));
          await advanceTimersByTimeAsync(300);
          expect(mockPut).toHaveBeenCalledTimes(1);
          act(() => result.current.outlet.setTextSystemPrompt('outlet queued before conflict'));
          if (refetch === 'finished') refresh.resolve(winner);
          await settle(
            settlePut[0],
            mockMutationResult(null, {
              value: { error: 'Settings changed', code: 'CONFLICT' },
            })
          );
          expect(mockGet).toHaveBeenCalledTimes(2);
          await advanceTimersByTimeAsync(300);
          expect(mockPut).toHaveBeenCalledTimes(1);
          await act(async () => {
            refresh.resolve(winner);
            await refresh.promise;
          });
          await advanceTimersByTimeAsync(0);
          expect(result.current.outlet.promptSettings.textSystemPrompt).toBe('external winner');
        } finally {
          refresh.resolve(winner);
          // A failing red run may have submitted the stale second PUT. Settle
          // that held request as well so the regression never strands a save.
          for (const complete of settlePut.slice(1)) complete(savedPut('external winner'));
          await restoreRealTimers();
        }
      });
    }

    it('builds a fresh edit and rollback baseline after another hook refreshes a conflict', async () => {
      const settlePut = holdEveryPut();
      const { result } = renderHook(() => ({
        layout: useGlobalSettings(),
        outlet: useGlobalSettings(),
      }));
      await waitFor(() => expect(result.current.layout.isLoading).toBe(false));
      useFakeTimers();
      try {
        act(() => result.current.layout.setTextSystemPrompt('layout edit'));
        await advanceTimersByTimeAsync(300);
        act(() => result.current.outlet.setTextSystemPrompt('old queued edit'));
        mockGet.mockResolvedValue(
          mockQueryResult({
            ...DEFAULT_APP_SETTINGS,
            globalImageQuality: '4K',
            promptSettings: {
              ...DEFAULT_APP_SETTINGS.promptSettings,
              textSystemPrompt: 'external winner',
            },
          })
        );
        await settle(
          settlePut[0],
          mockMutationResult(null, {
            value: { error: 'Settings changed', code: 'CONFLICT' },
          })
        );
        act(() => result.current.outlet.setTextSystemPrompt('fresh edit'));
        await advanceTimersByTimeAsync(300);
        expect(mockPut).toHaveBeenCalledTimes(2);
        expect(mockPut.mock.calls[1]?.[0]).toMatchObject({
          globalImageQuality: '4K',
          promptSettings: { textSystemPrompt: 'fresh edit' },
        });
        await settle(settlePut[1], failedPut());
        await advanceTimersByTimeAsync(0);
        expect(result.current.outlet.promptSettings.textSystemPrompt).toBe('external winner');
        expect(result.current.outlet.globalImageQuality).toBe('4K');
      } finally {
        for (const complete of settlePut.slice(1)) complete(savedPut('external winner'));
        await restoreRealTimers();
      }
    });

    it('rolls back to the last confirmed value, not to an unconfirmed one', async () => {
      const burstStart = 'persisted baseline';
      mockGet.mockResolvedValue(
        mockQueryResult({
          ...DEFAULT_APP_SETTINGS,
          promptSettings: {
            ...DEFAULT_APP_SETTINGS.promptSettings,
            textSystemPrompt: burstStart,
          },
        })
      );

      const settlePut = holdEveryPut();
      const { result } = renderHook(() => useGlobalSettings());

      await waitFor(() => expect(result.current.promptSettings.textSystemPrompt).toBe(burstStart));

      act(() => result.current.setTextSystemPrompt('first'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
      act(() => result.current.setTextSystemPrompt('second'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(2));

      // The first PUT settles while the second is still open, so the burst —
      // and the rollback target it started from — is not over.
      await settle(settlePut[0], savedPut('first'));

      act(() => result.current.setTextSystemPrompt('third'));
      await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(3));

      await settle(settlePut[1], failedPut());
      await settle(settlePut[2], failedPut());

      // 'second' was never persisted: restoring it would leave a value the
      // server rejected on screen, with refetch-on-focus off to correct it.
      await waitFor(() => expect(result.current.promptSettings.textSystemPrompt).toBe(burstStart));
    });
  });

  it('blocks another awaited save after a failed conflict refresh', async () => {
    const { result } = renderHook(() => useGlobalSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockPut.mockResolvedValue(
      mockMutationResult(null, {
        value: { error: 'Settings changed', code: 'CONFLICT' },
      })
    );
    mockGet.mockResolvedValue(mockQueryResult(null, { value: { error: 'Refresh unavailable' } }));
    await act(async () => {
      await result.current.updateExternalAgentSettings({}).catch(() => undefined);
    });
    mockPut.mockResolvedValue(mockMutationResult(DEFAULT_APP_SETTINGS));
    let retryError: unknown;
    await act(async () => {
      await result.current.updateExternalAgentSettings({}).catch((error) => {
        retryError = error;
      });
    });
    expect(retryError).toBeInstanceOf(Error);
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('adds and removes custom rules through the cached app settings state', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.addCustomRule();
    });

    await waitFor(() => expect(result.current.promptSettings.customRules).toHaveLength(1));

    const customRuleId = result.current.promptSettings.customRules[0]?.id;
    expect(customRuleId).toBeTruthy();
    if (!customRuleId) throw new Error('Expected a custom rule id');

    act(() => {
      result.current.removeCustomRule(customRuleId);
    });

    await waitFor(() => expect(result.current.promptSettings.customRules).toEqual([]));
    // The count is deliberately not asserted: the debounce coalesces edits made
    // inside one window, so what has to hold is that the last PUT carries the
    // final state.
    await waitFor(() =>
      expect(mockPut.mock.lastCall?.[0]).toMatchObject({ promptSettings: { customRules: [] } })
    );
  });

  it('resetSettings restores the shared defaults and persists them', async () => {
    mockGet.mockResolvedValue(
      mockQueryResult({
        ...DEFAULT_APP_SETTINGS,
        globalImageQuality: '2K',
        thinkingEnabled: true,
        maxToolIterations: 4,
      })
    );

    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.resetSettings();
    });

    // The optimistic write lands through React Query's mutate, same as every
    // other setter in this file — a bare synchronous read here is a race.
    await waitFor(() =>
      expect(result.current.globalImageQuality).toBe(DEFAULT_APP_SETTINGS.globalImageQuality)
    );
    expect(result.current.thinkingEnabled).toBe(DEFAULT_APP_SETTINGS.thinkingEnabled);
    expect(result.current.maxToolIterations).toBe(DEFAULT_APP_SETTINGS.maxToolIterations);

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    // Profile-scoped settings are deliberately absent: this screen resets the
    // preferences it shows, and library locations and first-run progress are
    // owned — and reset — by their own surfaces.
    const { profileSettings: _profileSettings, ...defaultsThisScreenOwns } = DEFAULT_APP_SETTINGS;
    expect(mockPut.mock.calls[0]?.[0]).toEqual(defaultsThisScreenOwns);
  });

  it('leaves profile-scoped settings standing in the cache a reset never sends', async () => {
    // The first-run gate reads onboarding out of this cache entry. Resetting a
    // subtree the PUT does not carry would make the gate act on a value the
    // server never agreed to, and send the person back into the wizard.
    const completed = {
      ...DEFAULT_APP_SETTINGS,
      profileSettings: {
        default: {
          ...DEFAULT_APP_SETTINGS.profileSettings.default,
          onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: 42 },
        },
      },
    };
    mockGet.mockResolvedValue(mockQueryResult(completed));

    // A second observer on the same key, in the same provider: what it sees is
    // what every other surface reading these settings sees.
    const { result } = renderHook(() => ({
      global: useGlobalSettings(),
      cached: useQuery(appSettingsQueryOptions()).data,
    }));
    await waitFor(() => expect(result.current.global.isLoading).toBe(false));

    act(() => {
      result.current.global.resetSettings();
    });
    // React Query announces a cache change on its own `setTimeout(0)`, so the
    // second observer has not re-rendered yet when `act` returns.
    await flushAsyncRender();

    expect(result.current.cached?.profileSettings.default.onboarding.completedAt).toBe(42);
  });

  it('leaves profile-scoped settings out of every save', async () => {
    mockGet.mockResolvedValue(mockQueryResult({ ...DEFAULT_APP_SETTINGS, thinkingEnabled: false }));

    const { result } = renderHook(() => useGlobalSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setThinkingEnabled(true);
    });

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).not.toHaveProperty('profileSettings');
    expect(mockPut.mock.calls[0]?.[0]).toMatchObject({ thinkingEnabled: true });
  });
});

describe('useGlobalSettings while library defaults are pending', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    mockGet.mockResolvedValue(
      mockQueryResult({ ...DEFAULT_APP_SETTINGS, libraryLocationDefaultsPending: true })
    );
  });

  function renderWithCache() {
    return renderHook(() => ({ settings: useGlobalSettings(), queryClient: useQueryClient() }));
  }

  function cachedPending(queryClient: ReturnType<typeof useQueryClient>): boolean {
    return libraryLocationDefaultsPending(
      queryClient.getQueryData<AppSettings>(appSettingsKeys.current())
    );
  }

  it('keeps the cache flagged pending through an optimistic edit, and never sends the flag', async () => {
    let answerPut: ((result: MockPutResult) => void) | undefined;
    mockPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerPut = resolve;
        })
    );
    const { result } = renderWithCache();
    await waitFor(() => expect(cachedPending(result.current.queryClient)).toBe(true));

    act(() => result.current.settings.setTextSystemPrompt('edited while detecting'));
    await waitFor(() =>
      expect(result.current.settings.promptSettings.textSystemPrompt).toBe('edited while detecting')
    );

    expect(
      cachedPending(result.current.queryClient),
      'expected cache after optimistic edit: pending | received: detected (placeholder locations would read as real)'
    ).toBe(true);
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0]).not.toHaveProperty('libraryLocationDefaultsPending');

    // The PUT answers after detection, so its answer clears the flag.
    act(() => answerPut?.(mockMutationResult(DEFAULT_APP_SETTINGS)));
    await waitFor(() => expect(cachedPending(result.current.queryClient)).toBe(false));
  });

  it('rolls a failed save back to a cache that is still pending', async () => {
    mockPut.mockResolvedValue(
      mockMutationResult(null, { value: { error: 'detection failed before the write' } })
    );
    const { result } = renderWithCache();
    await waitFor(() => expect(cachedPending(result.current.queryClient)).toBe(true));

    act(() => result.current.settings.setTextSystemPrompt('lost edit'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.settings.promptSettings.textSystemPrompt).toBe(
        DEFAULT_APP_SETTINGS.promptSettings.textSystemPrompt
      )
    );

    expect(
      cachedPending(result.current.queryClient),
      'expected cache after rollback: pending | received: detected (the placeholder snapshot lost its flag)'
    ).toBe(true);
  });
});
