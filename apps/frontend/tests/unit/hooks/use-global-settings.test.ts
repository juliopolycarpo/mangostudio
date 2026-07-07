import type { AppSettings } from '@mangostudio/shared/app-settings';
import { DEFAULT_APP_SETTINGS, MAX_TOOL_ITERATIONS_MAX } from '@mangostudio/shared/app-settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSettings } from '../../../src/hooks/use-global-settings';
import { client } from '../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

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
    mockPut.mockImplementation((settings: AppSettings) =>
      Promise.resolve(mockMutationResult(settings))
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
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(2));
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

  it('persists skill source toggles through the app-settings mutation', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.skillSources).toEqual(DEFAULT_APP_SETTINGS.skillSources);

    act(() => {
      result.current.setSkillSourceEnabled('agents', true);
    });

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    const persisted = mockPut.mock.calls[0]?.[0] as AppSettings;
    expect(persisted.skillSources).toEqual({ agents: true, claude: false });
  });
});
