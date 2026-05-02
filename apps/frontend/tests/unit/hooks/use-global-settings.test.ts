/**
 * Unit tests for useGlobalSettings — specifically the strict clamping of
 * maxToolIterations across reads, writes, and external setter invocations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '../../support/harness/render';
import {
  useGlobalSettings,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  MAX_TOOL_ITERATIONS_DEFAULT,
} from '../../../src/hooks/use-global-settings';

const STORAGE_KEY = 'mangostudio:maxToolIterations';
const CONTEXT_SETTINGS_STORAGE_KEY = 'mangostudio:contextSettings';

describe('useGlobalSettings — maxToolIterations guardrails', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to MAX_TOOL_ITERATIONS_DEFAULT when storage is empty', () => {
    const { result } = renderHook(() => useGlobalSettings());
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_DEFAULT);
  });

  it('clamps out-of-range values read from localStorage to the maximum', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(999));
    const { result } = renderHook(() => useGlobalSettings());
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_MAX);
  });

  it('clamps below-range values read from localStorage to the minimum', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(-5));
    const { result } = renderHook(() => useGlobalSettings());
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_MIN);
  });

  it('clamps non-finite stored values to the default', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Number.NaN));
    const { result } = renderHook(() => useGlobalSettings());
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_DEFAULT);
  });

  it('clamps setter input that exceeds the maximum', () => {
    const { result } = renderHook(() => useGlobalSettings());
    act(() => {
      result.current.setMaxToolIterations(500);
    });
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_MAX);
  });

  it('clamps setter input that is below the minimum', () => {
    const { result } = renderHook(() => useGlobalSettings());
    act(() => {
      result.current.setMaxToolIterations(0);
    });
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_MIN);
  });

  it('rounds fractional setter input to the nearest integer', () => {
    const { result } = renderHook(() => useGlobalSettings());
    act(() => {
      result.current.setMaxToolIterations(3.7);
    });
    expect(result.current.maxToolIterations).toBe(4);
  });

  it('persists the clamped value to localStorage', async () => {
    const { result } = renderHook(() => useGlobalSettings());
    act(() => {
      result.current.setMaxToolIterations(99);
    });
    await Promise.resolve();
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as number;
    expect(stored).toBe(MAX_TOOL_ITERATIONS_MAX);
  });

  it('resetSettings restores maxToolIterations to the default', () => {
    const { result } = renderHook(() => useGlobalSettings());
    act(() => {
      result.current.setMaxToolIterations(MAX_TOOL_ITERATIONS_MAX);
    });
    act(() => {
      result.current.resetSettings();
    });
    expect(result.current.maxToolIterations).toBe(MAX_TOOL_ITERATIONS_DEFAULT);
  });

  it('defaults contextSettings when storage is empty', () => {
    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.contextSettings).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it('normalizes persisted context thresholds into ascending order', () => {
    window.localStorage.setItem(
      CONTEXT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        compactionBehavior: 'auto_compact_current_chat',
        warningThreshold: 0.97,
        dangerThreshold: 0.85,
        hardStopThreshold: 0.92,
        preferredSummaryModel: 'gpt-4o-mini',
        providerCompactionEnabled: false,
      })
    );

    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.contextSettings).toEqual({
      compactionBehavior: 'auto_compact_current_chat',
      warningThreshold: 0.85,
      dangerThreshold: 0.92,
      hardStopThreshold: 0.97,
      preferredSummaryModel: 'gpt-4o-mini',
      providerCompactionEnabled: false,
    });
  });

  it('persists context settings updates to localStorage', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.setProviderCompactionEnabled(false);
    });
    await Promise.resolve();

    const stored = JSON.parse(
      window.localStorage.getItem(CONTEXT_SETTINGS_STORAGE_KEY) ?? 'null'
    ) as { providerCompactionEnabled?: boolean };

    expect(stored.providerCompactionEnabled).toBe(false);
  });

  it('resetSettings restores contextSettings defaults', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.setContextCompactionBehavior('off');
    });
    act(() => {
      result.current.resetSettings();
    });

    expect(result.current.contextSettings).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });
});

const PROMPT_SETTINGS_KEY = 'mangostudio:promptSettings';

describe('useGlobalSettings — prompt settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults promptSettings when storage is empty', () => {
    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.promptSettings.textSystemPrompt).toBe('');
    expect(result.current.promptSettings.imageSystemPrompt).toBe('');
    expect(result.current.promptSettings.agentsMd.path).toBe('~/.mango/AGENTS.md');
    expect(result.current.promptSettings.claudeMd.path).toBe('~/.claude/CLAUDE.md');
    expect(result.current.promptSettings.agentsMd.enabled).toBe(false);
    expect(result.current.promptSettings.claudeMd.enabled).toBe(false);
    expect(result.current.promptSettings.customRules).toEqual([]);
  });

  it('derives globalTextSystemPrompt from promptSettings', () => {
    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.globalTextSystemPrompt).toBe(
      result.current.promptSettings.textSystemPrompt
    );
  });

  it('derives globalImageSystemPrompt from promptSettings', () => {
    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.globalImageSystemPrompt).toBe(
      result.current.promptSettings.imageSystemPrompt
    );
  });

  it('migrates old storage keys into promptSettings', () => {
    window.localStorage.setItem(
      'mangostudio:globalTextSystemPrompt',
      JSON.stringify('old text prompt')
    );
    window.localStorage.setItem(
      'mangostudio:globalImageSystemPrompt',
      JSON.stringify('old image prompt')
    );

    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.promptSettings.textSystemPrompt).toBe('old text prompt');
    expect(result.current.promptSettings.imageSystemPrompt).toBe('old image prompt');
    expect(result.current.promptSettings.agentsMd.enabled).toBe(false);
  });

  it('setTextSystemPrompt updates the text system prompt', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.setTextSystemPrompt('new text prompt');
    });

    expect(result.current.promptSettings.textSystemPrompt).toBe('new text prompt');
  });

  it('setImageSystemPrompt updates the image system prompt', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.setImageSystemPrompt('new image prompt');
    });

    expect(result.current.promptSettings.imageSystemPrompt).toBe('new image prompt');
  });

  it('updateRuleFileSetting updates enabled on a fixed rule', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.updateRuleFileSetting('agentsMd', { enabled: true });
    });

    expect(result.current.promptSettings.agentsMd.enabled).toBe(true);
  });

  it('updateRuleFileSetting updates injectionRole on a fixed rule', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.updateRuleFileSetting('agentsMd', { injectionRole: 'user' });
    });

    expect(result.current.promptSettings.agentsMd.injectionRole).toBe('user');
  });

  it('updateRuleFileSetting updates sendFrequency on a fixed rule', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.updateRuleFileSetting('claudeMd', { sendFrequency: 'every-turn' });
    });

    expect(result.current.promptSettings.claudeMd.sendFrequency).toBe('every-turn');
  });

  it('updateRuleFileSetting updates custom rule fields', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.addCustomRule();
    });

    const ruleId = result.current.promptSettings.customRules[0].id;

    act(() => {
      result.current.updateRuleFileSetting(ruleId, { path: '~/test.md', enabled: true });
    });

    expect(result.current.promptSettings.customRules[0].path).toBe('~/test.md');
    expect(result.current.promptSettings.customRules[0].enabled).toBe(true);
  });

  it('addCustomRule adds a new rule to customRules', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.addCustomRule();
    });

    expect(result.current.promptSettings.customRules).toHaveLength(1);
    expect(result.current.promptSettings.customRules[0].enabled).toBe(false);
    expect(result.current.promptSettings.customRules[0].injectionRole).toBe('system');
    expect(result.current.promptSettings.customRules[0].sendFrequency).toBe('first-turn');
  });

  it('addCustomRule adds multiple rules', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.addCustomRule();
    });
    act(() => {
      result.current.addCustomRule();
    });

    expect(result.current.promptSettings.customRules).toHaveLength(2);
  });

  it('removeCustomRule removes a custom rule by id', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.addCustomRule();
    });

    const ruleId = result.current.promptSettings.customRules[0].id;

    act(() => {
      result.current.removeCustomRule(ruleId);
    });

    expect(result.current.promptSettings.customRules).toHaveLength(0);
  });

  it('removeCustomRule only removes the targeted rule', () => {
    window.localStorage.setItem(
      PROMPT_SETTINGS_KEY,
      JSON.stringify({
        ...DEFAULT_PROMPT_SETTINGS,
        customRules: [
          {
            id: 'rule-1',
            label: '',
            path: '',
            enabled: false,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          },
          {
            id: 'rule-2',
            label: '',
            path: '',
            enabled: false,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          },
        ],
      })
    );

    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.promptSettings.customRules).toHaveLength(2);

    act(() => {
      result.current.removeCustomRule('rule-2');
    });

    expect(result.current.promptSettings.customRules).toHaveLength(1);
    expect(result.current.promptSettings.customRules[0].id).toBe('rule-1');
  });

  it('resetSettings restores promptSettings to defaults', () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.setTextSystemPrompt('custom prompt');
      result.current.updateRuleFileSetting('agentsMd', { enabled: true });
      result.current.addCustomRule();
    });

    act(() => {
      result.current.resetSettings();
    });

    expect(result.current.promptSettings.textSystemPrompt).toBe('');
    expect(result.current.promptSettings.imageSystemPrompt).toBe('');
    expect(result.current.promptSettings.agentsMd.enabled).toBe(false);
    expect(result.current.promptSettings.customRules).toEqual([]);
  });

  it('persists promptSettings to localStorage', async () => {
    const { result } = renderHook(() => useGlobalSettings());

    act(() => {
      result.current.setTextSystemPrompt('persisted prompt');
    });

    await Promise.resolve();

    const stored = JSON.parse(window.localStorage.getItem(PROMPT_SETTINGS_KEY) ?? 'null') as {
      textSystemPrompt: string;
    };

    expect(stored.textSystemPrompt).toBe('persisted prompt');
  });

  it('reads existing promptSettings from localStorage', () => {
    window.localStorage.setItem(
      PROMPT_SETTINGS_KEY,
      JSON.stringify({
        textSystemPrompt: 'stored prompt',
        imageSystemPrompt: 'stored image prompt',
        agentsMd: { ...DEFAULT_PROMPT_SETTINGS.agentsMd },
        claudeMd: { ...DEFAULT_PROMPT_SETTINGS.claudeMd },
        customRules: [],
      })
    );

    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.promptSettings.textSystemPrompt).toBe('stored prompt');
    expect(result.current.promptSettings.imageSystemPrompt).toBe('stored image prompt');
  });

  it('normalizes invalid promptSettings from localStorage', () => {
    window.localStorage.setItem(
      PROMPT_SETTINGS_KEY,
      JSON.stringify({
        textSystemPrompt: 'valid text',
        imageSystemPrompt: null,
        agentsMd: { enabled: 'not-a-boolean' },
        claudeMd: null,
        customRules: 'not-an-array',
      })
    );

    const { result } = renderHook(() => useGlobalSettings());

    expect(result.current.promptSettings.textSystemPrompt).toBe('valid text');
    expect(result.current.promptSettings.imageSystemPrompt).toBe('');
    expect(result.current.promptSettings.agentsMd.enabled).toBe(false);
    expect(result.current.promptSettings.claudeMd.enabled).toBe(false);
    expect(result.current.promptSettings.customRules).toEqual([]);
  });
});
