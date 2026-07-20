import { describe, expect, it } from 'bun:test';
import {
  clampMaxToolIterations,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_MULTI_AGENT_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  DEFAULT_WORKSPACE_SETTINGS,
  IMAGE_QUALITY_OPTIONS,
  MAX_SUBAGENT_CALLS_MAX,
  MAX_SUBAGENT_CALLS_MIN,
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  normalizeAppSettings,
  normalizeChatTitleSettings,
  normalizeContextSettings,
  normalizeGitSettings,
  normalizeMultiAgentSettings,
  normalizePromptSettings,
  normalizeWorkspaceSettings,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
} from '../../src/app-settings';

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
        chatDelegationEnabled: true,
        traceVisibility: 'full',
        maxDepth: 9,
        maxSubagentCalls: -1,
        timeoutMs: 99_999_999,
        defaultMaxTurns: 0,
      })
    ).toEqual({
      enabled: false,
      chatDelegationEnabled: true,
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
});
