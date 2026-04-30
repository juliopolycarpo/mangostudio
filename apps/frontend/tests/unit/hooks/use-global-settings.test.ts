/**
 * Unit tests for useGlobalSettings — specifically the strict clamping of
 * maxToolIterations across reads, writes, and external setter invocations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '../../support/harness/render';
import {
  useGlobalSettings,
  DEFAULT_CONTEXT_SETTINGS,
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
