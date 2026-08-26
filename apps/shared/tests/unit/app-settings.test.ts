import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  AppSettingsPutBodySchema,
  AppSettingsSchema,
  clampMaxToolIterations,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_DISPLAY_SETTINGS,
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_EXTERNAL_API_SETTINGS,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  DEFAULT_MULTI_AGENT_SETTINGS,
  DEFAULT_PROFILE_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  DEFAULT_WORKSPACE_SETTINGS,
  IMAGE_QUALITY_OPTIONS,
  type LibraryLocationSettings,
  libraryLocationsFor,
  MAX_SUBAGENT_CALLS_MAX,
  MAX_SUBAGENT_CALLS_MIN,
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  normalizeAppSettings,
  normalizeChatDisplaySettings,
  normalizeChatTitleSettings,
  normalizeContextSettings,
  normalizeGitSettings,
  normalizeLibraryLocationSettings,
  normalizeMultiAgentSettings,
  normalizePromptSettings,
  normalizeWorkspaceSettings,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
  withLibraryLocations,
} from '../../src/app-settings';
import {
  DEFAULT_EXTERNAL_AGENT_SETTINGS,
  EXTERNAL_DISCLOSURE_FINGERPRINT_MAX_LENGTH,
  externalCapabilitiesFingerprint,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '../../src/external-agents';
import { DEFAULT_PROFILE_ID } from '../../src/profiles';
import { CHAT_SIDEBAR_WIDTH_MAX, WORKSPACE_PANEL_WIDTH_MAX } from '../../src/workspaces';

describe('normalizeGitSettings', () => {
  it('defaults missing or malformed signing preferences', () => {
    expect(normalizeGitSettings(undefined)).toEqual(DEFAULT_GIT_SETTINGS);
    expect(normalizeGitSettings({ signCommits: 'yes', signOff: 1 })).toEqual(DEFAULT_GIT_SETTINGS);
  });

  it('preserves explicit signing and sign-off choices independently', () => {
    expect(normalizeGitSettings({ signCommits: true, signOff: false })).toEqual({
      signCommits: true,
      signOff: false,
      commitMessage: DEFAULT_GIT_SETTINGS.commitMessage,
    });
  });

  it('normalizes commit-message generation settings and clamps the diff budget', () => {
    expect(
      normalizeGitSettings({
        commitMessage: {
          preferredModel: 'fast-model',
          systemPrompt: 'Write a focused commit message.',
          maxDiffKb: 900,
        },
      })
    ).toEqual({
      signCommits: false,
      signOff: false,
      commitMessage: {
        preferredModel: 'fast-model',
        systemPrompt: 'Write a focused commit message.',
        maxDiffKb: 512,
      },
    });

    expect(
      normalizeGitSettings({
        commitMessage: { preferredModel: '', systemPrompt: '   ', maxDiffKb: 1 },
      }).commitMessage
    ).toEqual({ ...DEFAULT_GIT_SETTINGS.commitMessage, maxDiffKb: 16 });
  });
});

describe('normalizeWorkspaceSettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizeWorkspaceSettings(undefined)).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(normalizeWorkspaceSettings(null)).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(normalizeWorkspaceSettings('~/projects')).toEqual(DEFAULT_WORKSPACE_SETTINGS);
  });

  it('drops invalid recents, deduplicates them, and caps the list', () => {
    expect(
      normalizeWorkspaceSettings({
        defaultWorkdir: '/workspace/default',
        recentWorkdirs: [
          '/workspace/0',
          42,
          '/workspace/1',
          '/workspace/0',
          '',
          '/workspace/2',
          '/workspace/3',
          '/workspace/4',
          '/workspace/5',
          '/workspace/6',
          '/workspace/7',
          '/workspace/8',
          '/workspace/9',
          '/workspace/10',
        ],
      })
    ).toEqual({
      ...DEFAULT_WORKSPACE_SETTINGS,
      defaultWorkdir: '/workspace/default',
      recentWorkdirs: [
        '/workspace/0',
        '/workspace/1',
        '/workspace/2',
        '/workspace/3',
        '/workspace/4',
        '/workspace/5',
        '/workspace/6',
        '/workspace/7',
        '/workspace/8',
        '/workspace/9',
      ],
    });
  });

  it('normalizes panel visibility, ordering, and widths', () => {
    expect(
      normalizeWorkspaceSettings({
        chatSidebarWidth: 900,
        sidePanel: {
          visiblePanelIds: ['todos', 'unknown', 'todos'],
          panelOrder: ['todos', 'unknown', 'todos'],
          width: 900,
        },
      })
    ).toEqual({
      ...DEFAULT_WORKSPACE_SETTINGS,
      chatSidebarWidth: CHAT_SIDEBAR_WIDTH_MAX,
      sidePanel: {
        // The stored order is the ledger of panels these settings have heard
        // of, and it names only `todos` — so `git` is new here and backfills
        // into visibility as well as into the order.
        visiblePanelIds: ['todos', 'git'],
        panelOrder: ['todos', 'git'],
        width: WORKSPACE_PANEL_WIDTH_MAX,
      },
    });
  });

  it('shows a newly shipped panel to users whose settings predate it', () => {
    const legacy = normalizeWorkspaceSettings({
      sidePanel: { visiblePanelIds: ['todos'], panelOrder: ['todos'] },
    });

    expect(legacy.sidePanel.visiblePanelIds).toEqual(['todos', 'git']);
    expect(legacy.sidePanel.panelOrder).toEqual(['todos', 'git']);
  });

  it('keeps respecting a panel the user hid in a build that knew about it', () => {
    const hidden = normalizeWorkspaceSettings({
      sidePanel: { visiblePanelIds: ['git'], panelOrder: ['git', 'todos'] },
    });

    expect(hidden.sidePanel.visiblePanelIds).toEqual(['git']);
    expect(hidden.sidePanel.panelOrder).toEqual(['git', 'todos']);
  });

  it('backfills everything when the stored order cannot act as a ledger', () => {
    const orderless = normalizeWorkspaceSettings({ sidePanel: { visiblePanelIds: ['todos'] } });

    expect(orderless.sidePanel.visiblePanelIds).toEqual(['todos', 'git']);
    expect(orderless.sidePanel.panelOrder).toEqual(DEFAULT_WORKSPACE_SETTINGS.sidePanel.panelOrder);
  });

  it('falls back invalid fields independently', () => {
    expect(
      normalizeWorkspaceSettings({ defaultWorkdir: false, recentWorkdirs: 'not-an-array' })
    ).toEqual(DEFAULT_WORKSPACE_SETTINGS);
  });
});

describe('normalizeChatTitleSettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizeChatTitleSettings(undefined)).toEqual(DEFAULT_CHAT_TITLE_SETTINGS);
    expect(normalizeChatTitleSettings(null)).toEqual(DEFAULT_CHAT_TITLE_SETTINGS);
    expect(normalizeChatTitleSettings('string')).toEqual(DEFAULT_CHAT_TITLE_SETTINGS);
    expect(normalizeChatTitleSettings(42)).toEqual(DEFAULT_CHAT_TITLE_SETTINGS);
    expect(normalizeChatTitleSettings([])).toEqual(DEFAULT_CHAT_TITLE_SETTINGS);
  });

  it('preserves valid user decisions and clamps the prompt prefix length', () => {
    expect(
      normalizeChatTitleSettings({
        autoRenameEnabled: false,
        strategy: 'model',
        promptPrefixLength: 120,
        preferredModel: 'title-model',
      })
    ).toEqual({
      autoRenameEnabled: false,
      strategy: 'model',
      promptPrefixLength: 80,
      preferredModel: 'title-model',
    });
  });

  it('falls back individual fields when types are invalid', () => {
    expect(
      normalizeChatTitleSettings({
        autoRenameEnabled: 'yes',
        strategy: 'unknown',
        promptPrefixLength: 'long',
        preferredModel: 123,
      })
    ).toEqual({
      autoRenameEnabled: DEFAULT_CHAT_TITLE_SETTINGS.autoRenameEnabled,
      strategy: DEFAULT_CHAT_TITLE_SETTINGS.strategy,
      promptPrefixLength: DEFAULT_CHAT_TITLE_SETTINGS.promptPrefixLength,
      preferredModel: DEFAULT_CHAT_TITLE_SETTINGS.preferredModel,
    });
  });

  it('uses default preferredModel when provided string is empty', () => {
    expect(
      normalizeChatTitleSettings({
        preferredModel: '',
      })
    ).toEqual({
      ...DEFAULT_CHAT_TITLE_SETTINGS,
      preferredModel: DEFAULT_CHAT_TITLE_SETTINGS.preferredModel,
    });
  });
});

describe('normalizeChatDisplaySettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizeChatDisplaySettings(undefined)).toEqual(DEFAULT_CHAT_DISPLAY_SETTINGS);
    expect(normalizeChatDisplaySettings(null)).toEqual(DEFAULT_CHAT_DISPLAY_SETTINGS);
    expect(normalizeChatDisplaySettings('always')).toEqual(DEFAULT_CHAT_DISPLAY_SETTINGS);
  });

  it('preserves valid values', () => {
    expect(
      normalizeChatDisplaySettings({ diffPreviewsEnabled: false, diffPreviewMode: 'expanded' })
    ).toEqual({ diffPreviewsEnabled: false, diffPreviewMode: 'expanded' });
  });

  it('falls back individual fields when types are invalid', () => {
    expect(
      normalizeChatDisplaySettings({ diffPreviewsEnabled: 'yes', diffPreviewMode: 'sometimes' })
    ).toEqual(DEFAULT_CHAT_DISPLAY_SETTINGS);
  });
});

describe('clampMaxToolIterations', () => {
  it('returns default for non-finite values', () => {
    expect(clampMaxToolIterations(Number.NaN)).toBe(MAX_TOOL_ITERATIONS_DEFAULT);
    expect(clampMaxToolIterations(Number.POSITIVE_INFINITY)).toBe(MAX_TOOL_ITERATIONS_DEFAULT);
    expect(clampMaxToolIterations(Number.NEGATIVE_INFINITY)).toBe(MAX_TOOL_ITERATIONS_DEFAULT);
  });

  it('clamps to minimum', () => {
    expect(clampMaxToolIterations(0)).toBe(MAX_TOOL_ITERATIONS_MIN);
    expect(clampMaxToolIterations(-5)).toBe(MAX_TOOL_ITERATIONS_MIN);
  });

  it('clamps to maximum', () => {
    expect(clampMaxToolIterations(MAX_TOOL_ITERATIONS_MAX + 100)).toBe(MAX_TOOL_ITERATIONS_MAX);
    expect(clampMaxToolIterations(MAX_TOOL_ITERATIONS_MAX + 1)).toBe(MAX_TOOL_ITERATIONS_MAX);
  });

  it('rounds and keeps values inside range', () => {
    expect(clampMaxToolIterations(5.7)).toBe(6);
    expect(clampMaxToolIterations(MAX_TOOL_ITERATIONS_MIN)).toBe(MAX_TOOL_ITERATIONS_MIN);
    expect(clampMaxToolIterations(MAX_TOOL_ITERATIONS_MAX)).toBe(MAX_TOOL_ITERATIONS_MAX);
  });
});

describe('normalizeContextSettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizeContextSettings(undefined)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(normalizeContextSettings(null)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(normalizeContextSettings('string')).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it('preserves valid values', () => {
    const input = {
      compactionBehavior: 'off' as const,
      warningThreshold: 0.7,
      dangerThreshold: 0.8,
      hardStopThreshold: 0.9,
      preferredSummaryModel: 'gpt-4o',
      providerCompactionEnabled: false,
    };
    expect(normalizeContextSettings(input)).toEqual({
      ...input,
      warningThreshold: 0.7,
      dangerThreshold: 0.8,
      hardStopThreshold: 0.9,
    });
  });

  it('falls back individual fields when types are invalid', () => {
    expect(
      normalizeContextSettings({
        compactionBehavior: 'unknown',
        warningThreshold: 'high',
        dangerThreshold: 'high',
        hardStopThreshold: 'high',
        preferredSummaryModel: 123,
        providerCompactionEnabled: 'yes',
      })
    ).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it('clamps and sorts thresholds that are out of order', () => {
    const result = normalizeContextSettings({
      warningThreshold: 0.99,
      dangerThreshold: 0.5,
      hardStopThreshold: 0.85,
    });
    expect(result.warningThreshold).toBe(0.5);
    expect(result.dangerThreshold).toBe(0.85);
    expect(result.hardStopThreshold).toBe(0.99);
  });

  it('falls back to default for non-finite threshold values', () => {
    const result = normalizeContextSettings({
      warningThreshold: Number.NaN,
      dangerThreshold: Number.POSITIVE_INFINITY,
      hardStopThreshold: Number.NEGATIVE_INFINITY,
    });
    expect(result.warningThreshold).toBe(DEFAULT_CONTEXT_SETTINGS.warningThreshold);
    expect(result.dangerThreshold).toBe(DEFAULT_CONTEXT_SETTINGS.dangerThreshold);
    expect(result.hardStopThreshold).toBe(DEFAULT_CONTEXT_SETTINGS.hardStopThreshold);
  });

  it('clamps thresholds to the supported floor and ceiling and reorders them', () => {
    const result = normalizeContextSettings({
      warningThreshold: 0.1,
      dangerThreshold: 1.5,
      hardStopThreshold: 0.75,
    });
    expect(result.warningThreshold).toBe(0.5);
    expect(result.dangerThreshold).toBe(0.75);
    expect(result.hardStopThreshold).toBe(0.99);
  });

  it('uses default preferredSummaryModel when provided string is empty', () => {
    const result = normalizeContextSettings({
      preferredSummaryModel: '',
    });
    expect(result.preferredSummaryModel).toBe(DEFAULT_CONTEXT_SETTINGS.preferredSummaryModel);
  });
});

describe('normalizeMultiAgentSettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizeMultiAgentSettings(undefined)).toEqual(DEFAULT_MULTI_AGENT_SETTINGS);
    expect(normalizeMultiAgentSettings(null)).toEqual(DEFAULT_MULTI_AGENT_SETTINGS);
    expect(normalizeMultiAgentSettings('disabled')).toEqual(DEFAULT_MULTI_AGENT_SETTINGS);
  });

  it('preserves valid values and clamps numeric limits', () => {
    expect(
      normalizeMultiAgentSettings({
        enabled: false,
        traceVisibility: 'full',
        maxDepth: 9,
        maxSubagentCalls: -1,
        timeoutMs: 99_999_999,
        defaultMaxTurns: 0,
      })
    ).toEqual({
      enabled: false,
      traceVisibility: 'full',
      maxDepth: 3,
      maxSubagentCalls: MAX_SUBAGENT_CALLS_MIN,
      timeoutMs: 3_600_000,
      defaultMaxTurns: SUBAGENT_MAX_TURNS_MIN,
    });
  });

  it('supports high multi-agent exploration limits', () => {
    expect(
      normalizeMultiAgentSettings({
        maxSubagentCalls: 2_000,
        defaultMaxTurns: 2_000,
      })
    ).toMatchObject({
      maxSubagentCalls: MAX_SUBAGENT_CALLS_MAX,
      defaultMaxTurns: SUBAGENT_MAX_TURNS_MAX,
    });
  });
});

describe('normalizePromptSettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizePromptSettings(undefined)).toEqual(DEFAULT_PROMPT_SETTINGS);
    expect(normalizePromptSettings(null)).toEqual(DEFAULT_PROMPT_SETTINGS);
    expect(normalizePromptSettings('string')).toEqual(DEFAULT_PROMPT_SETTINGS);
    expect(normalizePromptSettings([])).toEqual(DEFAULT_PROMPT_SETTINGS);
  });

  it('preserves valid values', () => {
    const input = {
      textSystemPrompt: 'text prompt',
      imageSystemPrompt: 'image prompt',
      agentsMd: {
        id: 'agentsMd',
        label: 'AGENTS.md',
        path: '~/.mango/AGENTS.md',
        enabled: true,
        injectionRole: 'user' as const,
        sendFrequency: 'every-turn' as const,
      },
      claudeMd: {
        id: 'claudeMd',
        label: 'CLAUDE.md',
        path: '~/.claude/CLAUDE.md',
        enabled: true,
        injectionRole: 'user' as const,
        sendFrequency: 'every-turn' as const,
      },
      customRules: [
        {
          id: 'rule-1',
          label: 'Rule 1',
          path: '/rules/1.md',
          enabled: true,
          injectionRole: 'system' as const,
          sendFrequency: 'first-turn' as const,
        },
      ],
    };
    expect(normalizePromptSettings(input)).toEqual(input);
  });

  it('falls back text and image prompts to empty strings when not strings', () => {
    const result = normalizePromptSettings({
      textSystemPrompt: 123,
      imageSystemPrompt: true,
    });
    expect(result.textSystemPrompt).toBe('');
    expect(result.imageSystemPrompt).toBe('');
  });

  it('normalizes partial rule file settings with fallbacks', () => {
    const result = normalizePromptSettings({
      agentsMd: {
        id: '',
        label: 42,
        path: null,
        enabled: 'yes',
        injectionRole: 'invalid',
        sendFrequency: 'invalid',
      },
    });
    expect(result.agentsMd).toEqual({
      id: DEFAULT_PROMPT_SETTINGS.agentsMd.id,
      label: DEFAULT_PROMPT_SETTINGS.agentsMd.label,
      path: DEFAULT_PROMPT_SETTINGS.agentsMd.path,
      enabled: DEFAULT_PROMPT_SETTINGS.agentsMd.enabled,
      injectionRole: DEFAULT_PROMPT_SETTINGS.agentsMd.injectionRole,
      sendFrequency: DEFAULT_PROMPT_SETTINGS.agentsMd.sendFrequency,
    });
  });

  it('normalizes customRules array and handles invalid entries', () => {
    const result = normalizePromptSettings({
      customRules: [
        {
          id: 'custom-1',
          label: 'Custom',
          path: '/custom.md',
          enabled: true,
          injectionRole: 'user',
          sendFrequency: 'every-turn',
        },
        'invalid-entry',
        {
          id: '',
          enabled: false,
        },
      ],
    });
    expect(result.customRules).toHaveLength(3);
    expect(result.customRules[0]).toEqual({
      id: 'custom-1',
      label: 'Custom',
      path: '/custom.md',
      enabled: true,
      injectionRole: 'user',
      sendFrequency: 'every-turn',
    });
    expect(result.customRules[1]).toEqual({
      id: 'custom-rule-2',
      label: '',
      path: '',
      enabled: false,
      injectionRole: 'system',
      sendFrequency: 'first-turn',
    });
    expect(result.customRules[2]).toEqual({
      id: 'custom-rule-3',
      label: '',
      path: '',
      enabled: false,
      injectionRole: 'system',
      sendFrequency: 'first-turn',
    });
  });

  it('falls back customRules to empty array when not an array', () => {
    const result = normalizePromptSettings({
      customRules: 'not-an-array',
    });
    expect(result.customRules).toEqual([]);
  });
});

describe('normalizeAppSettings', () => {
  it('falls back to defaults when input is not an object', () => {
    expect(normalizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings('string')).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('normalizes missing chat title settings to the shared defaults', () => {
    expect(normalizeAppSettings({}).chatTitleSettings).toEqual(
      DEFAULT_APP_SETTINGS.chatTitleSettings
    );
  });

  it('normalizes missing Git settings to the shared defaults', () => {
    expect(normalizeAppSettings({}).gitSettings).toEqual(DEFAULT_GIT_SETTINGS);
  });

  it('normalizes missing chat display settings to the shared defaults', () => {
    expect(normalizeAppSettings({}).chatDisplaySettings).toEqual(DEFAULT_CHAT_DISPLAY_SETTINGS);
  });

  it('normalizes missing external API settings to disabled by default', () => {
    expect(normalizeAppSettings({}).externalApiSettings).toEqual(DEFAULT_EXTERNAL_API_SETTINGS);
  });

  it('falls back to disabled when external API settings are malformed', () => {
    expect(
      normalizeAppSettings({ externalApiSettings: { enabled: 'yes' } }).externalApiSettings
    ).toEqual(DEFAULT_EXTERNAL_API_SETTINGS);
    expect(normalizeAppSettings({ externalApiSettings: 'nope' }).externalApiSettings).toEqual(
      DEFAULT_EXTERNAL_API_SETTINGS
    );
  });

  it('keeps a well-formed disclosure and drops every shape the schema rejects', () => {
    const wellFormed = {
      version: 1,
      acceptedAt: 0,
      capabilitiesFingerprint: externalCapabilitiesFingerprint(NO_EXTERNAL_AGENT_CAPABILITIES),
    };

    // Each of these is a value the old `typeof === 'number'` check let through
    // and `AppSettingsPutBodySchema` then refused on the next save.
    const rejected: Record<string, unknown> = {
      zeroVersion: { ...wellFormed, version: 0 },
      fractionalVersion: { ...wellFormed, version: 1.5 },
      notANumberVersion: { ...wellFormed, version: Number.NaN },
      negativeAcceptedAt: { ...wellFormed, acceptedAt: -1 },
      fractionalAcceptedAt: { ...wellFormed, acceptedAt: 1.5 },
      emptyFingerprint: { ...wellFormed, capabilitiesFingerprint: '' },
      overLongFingerprint: {
        ...wellFormed,
        capabilitiesFingerprint: 'x'.repeat(EXTERNAL_DISCLOSURE_FINGERPRINT_MAX_LENGTH + 1),
      },
    };

    for (const [label, disclosure] of Object.entries(rejected)) {
      const normalized = normalizeAppSettings({
        externalAgentSettings: { disclosures: { codex: disclosure, cursor: wellFormed } },
      });
      expect(normalized.externalAgentSettings.disclosures.codex, label).toBeUndefined();
      // The malformed neighbour must not take the valid one down with it.
      expect(normalized.externalAgentSettings.disclosures.cursor, label).toEqual(wellFormed);
      expect(Value.Check(AppSettingsPutBodySchema, normalized), label).toBe(true);
    }
  });

  it('normalizes malformed external agent settings to no acknowledgement at all', () => {
    expect(normalizeAppSettings({}).externalAgentSettings).toEqual(DEFAULT_EXTERNAL_AGENT_SETTINGS);
    expect(normalizeAppSettings({ externalAgentSettings: 'nope' }).externalAgentSettings).toEqual(
      DEFAULT_EXTERNAL_AGENT_SETTINGS
    );
    expect(
      normalizeAppSettings({ externalAgentSettings: { disclosures: 7 } }).externalAgentSettings
    ).toEqual(DEFAULT_EXTERNAL_AGENT_SETTINGS);
  });

  it('merges dynamic library defaults while keeping MangoStudio native locations enabled', () => {
    expect(
      normalizeLibraryLocationSettings(
        { home: { 'mango-skills': false, 'mango-agents': false, 'agents-skills': false } },
        {
          home: {
            'mango-skills': true,
            'mango-agents': true,
            'agents-skills': true,
            'codex-skills': true,
          },
          workspace: {},
        }
      )
    ).toEqual({
      home: {
        'mango-skills': true,
        'mango-agents': true,
        'agents-skills': false,
        'codex-skills': true,
      },
      workspace: {},
    });
  });

  it('lifts a pre-nesting flat map into the home scope', () => {
    expect(
      normalizeLibraryLocationSettings({ 'agents-skills': true, 'claude-skills': false })
    ).toEqual({
      home: {
        ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home,
        'agents-skills': true,
        'claude-skills': false,
      },
      workspace: {},
    });
  });

  it('drops toggles written under the reserved workspace scope', () => {
    expect(
      normalizeLibraryLocationSettings({
        home: { 'agents-skills': true },
        workspace: { 'claude-skills': true },
      }).workspace
    ).toEqual({});
  });

  it('falls back individual top-level fields when types are invalid', () => {
    const result = normalizeAppSettings({
      globalImageQuality: 'invalid',
      thinkingEnabled: 'yes',
      reasoningEffort: 'invalid',
      maxToolIterations: 'many',
    });
    expect(result.globalImageQuality).toBe(DEFAULT_APP_SETTINGS.globalImageQuality);
    expect(result.thinkingEnabled).toBe(DEFAULT_APP_SETTINGS.thinkingEnabled);
    expect(result.reasoningEffort).toBe(DEFAULT_APP_SETTINGS.reasoningEffort);
    expect(result.maxToolIterations).toBe(DEFAULT_APP_SETTINGS.maxToolIterations);
  });

  it('accepts valid top-level fields', () => {
    const result = normalizeAppSettings({
      globalImageQuality: IMAGE_QUALITY_OPTIONS[2],
      thinkingEnabled: true,
      reasoningEffort: 'high',
      maxToolIterations: MAX_TOOL_ITERATIONS_MAX,
    });
    expect(result.globalImageQuality).toBe('2K');
    expect(result.thinkingEnabled).toBe(true);
    expect(result.reasoningEffort).toBe('high');
    expect(result.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_MAX);
  });

  it('normalizes nested prompt and context settings', () => {
    const result = normalizeAppSettings({
      promptSettings: {
        textSystemPrompt: 'hello',
        customRules: 'not-array',
      },
      contextSettings: {
        compactionBehavior: 'off',
      },
      chatTitleSettings: {
        strategy: 'model',
      },
    });
    expect(result.promptSettings.textSystemPrompt).toBe('hello');
    expect(result.promptSettings.customRules).toEqual([]);
    expect(result.contextSettings.compactionBehavior).toBe('off');
    expect(result.chatTitleSettings.strategy).toBe('model');
  });

  it('falls back to a legacy top-level libraryLocations when profileSettings is absent', () => {
    const result = normalizeAppSettings({
      libraryLocations: {
        'agents-skills': true,
        'claude-skills': false,
      },
    });
    expect(result.profileSettings).toEqual({
      [DEFAULT_PROFILE_ID]: {
        libraryLocations: {
          home: {
            ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home,
            'agents-skills': true,
            'claude-skills': false,
          },
          workspace: {},
        },
      },
    });
    expect(libraryLocationsFor(result).home).toMatchObject({
      'agents-skills': true,
      'claude-skills': false,
    });
  });

  it('drops unknown profile keys and keeps only the default profile', () => {
    const result = normalizeAppSettings({
      profileSettings: {
        default: {
          libraryLocations: { home: { 'agents-skills': true }, workspace: {} },
        },
        work: {
          libraryLocations: { home: { 'claude-skills': true }, workspace: {} },
        },
        personal: {
          libraryLocations: { home: { 'cursor-skills': true }, workspace: {} },
        },
      },
    });
    expect(Object.keys(result.profileSettings)).toEqual([DEFAULT_PROFILE_ID]);
    expect(result.profileSettings).toEqual({
      [DEFAULT_PROFILE_ID]: {
        libraryLocations: {
          home: { ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home, 'agents-skills': true },
          workspace: {},
        },
      },
    });
  });

  it('normalizes missing profile settings to the shared defaults', () => {
    expect(normalizeAppSettings({}).profileSettings).toEqual(DEFAULT_PROFILE_SETTINGS);
  });
});

function homeLocations(overrides: Record<string, boolean>): LibraryLocationSettings {
  return {
    home: { ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home, ...overrides },
    workspace: {},
  };
}

describe('libraryLocationsFor', () => {
  it('reads locations from the default profile', () => {
    const settings = withLibraryLocations(
      DEFAULT_APP_SETTINGS,
      DEFAULT_PROFILE_ID,
      homeLocations({ 'agents-skills': true })
    );
    expect(libraryLocationsFor(settings)).toEqual(homeLocations({ 'agents-skills': true }));
  });

  it('falls back to the default profile when the requested profile is missing', () => {
    const settings = withLibraryLocations(
      DEFAULT_APP_SETTINGS,
      DEFAULT_PROFILE_ID,
      homeLocations({ 'claude-skills': true })
    );
    expect(libraryLocationsFor(settings, 'work' as typeof DEFAULT_PROFILE_ID)).toEqual(
      homeLocations({ 'claude-skills': true })
    );
  });
});

describe('withLibraryLocations', () => {
  it('writes nested locations under the default profile', () => {
    const updated = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
      home: { 'agents-skills': true, 'claude-skills': false },
      workspace: {},
    });
    expect(updated.profileSettings).toEqual({
      [DEFAULT_PROFILE_ID]: {
        libraryLocations: homeLocations({ 'agents-skills': true, 'claude-skills': false }),
      },
    });
    expect(libraryLocationsFor(updated).home).toMatchObject({
      'agents-skills': true,
      'claude-skills': false,
    });
  });

  it('redirects unknown profile ids into the default profile', () => {
    const updated = withLibraryLocations(
      DEFAULT_APP_SETTINGS,
      'work' as typeof DEFAULT_PROFILE_ID,
      { home: { 'cursor-skills': true }, workspace: {} }
    );
    expect(Object.keys(updated.profileSettings)).toEqual([DEFAULT_PROFILE_ID]);
    expect(libraryLocationsFor(updated).home).toMatchObject({ 'cursor-skills': true });
  });
});

describe('AppSettingsPutBodySchema', () => {
  it('accepts nested library locations without the workspace scope', () => {
    const body = {
      ...DEFAULT_APP_SETTINGS,
      profileSettings: {
        [DEFAULT_PROFILE_ID]: {
          libraryLocations: {
            home: DEFAULT_LIBRARY_LOCATION_SETTINGS.home,
          },
        },
      },
    };

    expect(Value.Check(AppSettingsPutBodySchema, body)).toBe(true);
    expect(Value.Check(AppSettingsSchema, body)).toBe(false);
  });
});
