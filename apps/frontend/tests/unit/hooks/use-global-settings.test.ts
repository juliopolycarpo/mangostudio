import type { AppSettings, AppSettingsPutBody } from '@mangostudio/shared/app-settings';
import { DEFAULT_APP_SETTINGS, MAX_TOOL_ITERATIONS_MAX } from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSettings } from '../../../src/hooks/use-global-settings';
import { client } from '../../../src/lib/api-client';
import { act, renderHook, screen, waitFor } from '../../support/harness/render';

vi.mock('../../../src/lib/api-client', () => ({
  client: {
    api: {
      settings: {
        app: {
          get: vi.fn(),
          put: vi.fn(),
        },
      },
    },
  },
}));

const mockGet = vi.mocked(client.api.settings.app.get);
const mockPut = vi.mocked(client.api.settings.app.put);

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

    await waitFor(() =>
      expect(result.current.workspaceSettings).toEqual({
        ...DEFAULT_APP_SETTINGS.workspaceSettings,
        chatSidebarWidth: 420,
        sidePanel: {
          visiblePanelIds: ['todos'],
          panelOrder: ['todos', 'git'],
          width: 640,
        },
      })
    );
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0]?.[0].workspaceSettings).toEqual({
      ...DEFAULT_APP_SETTINGS.workspaceSettings,
      chatSidebarWidth: 420,
      sidePanel: {
        visiblePanelIds: ['todos'],
        panelOrder: ['todos', 'git'],
        width: 640,
      },
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

    // Separate acts, so each keystroke commits its own render. The debounce has
    // to survive those re-renders: a timer keyed on the unstable `useMutation`
    // result would be flushed by the effect cleanup on every one of them.
    for (const value of ['d', 'dr', 'dra', 'draft']) {
      act(() => {
        result.current.setTextSystemPrompt(value);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    }

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

    expect(result.current.globalImageQuality).toBe(DEFAULT_APP_SETTINGS.globalImageQuality);
    expect(result.current.thinkingEnabled).toBe(DEFAULT_APP_SETTINGS.thinkingEnabled);
    expect(result.current.maxToolIterations).toBe(DEFAULT_APP_SETTINGS.maxToolIterations);

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));

    expect(mockPut.mock.calls[0]?.[0]).toEqual(DEFAULT_APP_SETTINGS);
  });
});
