import { describe, expect, it } from 'bun:test';

import { buildShellTool } from '../../../../src/services/tools/builtin/_shell-tool';
import {
  migrateLegacyToolParameters,
  resolveEffectiveToolTimeoutMs,
  startToolTimeout,
  TOOL_EXECUTION_TIMEOUT_PARAM,
  TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT,
  TOOL_EXECUTION_TIMEOUT_SECONDS_MAX,
  TOOL_EXECUTION_TIMEOUT_SECONDS_MIN,
  ToolExecutionTimedOutError,
  toolSupportsExecutionTimeout,
} from '../../../../src/services/tools/execution-timeout';
import {
  mergeToolSettings,
  ToolParameterError,
} from '../../../../src/services/tools/settings-policy';

describe('resolveEffectiveToolTimeoutMs', () => {
  const bashTool = buildShellTool('bash');

  it('defaults to 30s when timeoutSeconds is unset on configurable tools', () => {
    const defaults = mergeToolSettings(bashTool);
    expect(resolveEffectiveToolTimeoutMs(bashTool, defaults)).toBe(30_000);
  });

  it('honors a configured timeoutSeconds value', () => {
    const merged = mergeToolSettings(bashTool, {
      enabled: true,
      parameters: { timeoutSeconds: 120 },
    });
    expect(resolveEffectiveToolTimeoutMs(bashTool, merged)).toBe(120_000);
  });

  it('clamps timeoutSeconds through settings normalization', () => {
    const merged = mergeToolSettings(bashTool, {
      enabled: true,
      parameters: { timeoutSeconds: TOOL_EXECUTION_TIMEOUT_SECONDS_MAX },
    });
    expect(resolveEffectiveToolTimeoutMs(bashTool, merged)).toBe(
      TOOL_EXECUTION_TIMEOUT_SECONDS_MAX * 1000
    );
    expect(() =>
      mergeToolSettings(bashTool, {
        enabled: true,
        parameters: { timeoutSeconds: 9999 },
      })
    ).toThrow(ToolParameterError);
  });

  it('falls back to 30s for tools without timeoutSeconds settings', () => {
    const datetimeTool = {
      definition: { name: 'get_current_datetime', description: '', parameters: {} },
      settings: {
        title: 'Clock',
        description: '',
        category: 'system' as const,
        enabledByDefault: true,
        canDisable: true,
        defaultParameters: {},
        parameterDescriptors: [],
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      execute: async () => ({}),
    };
    expect(toolSupportsExecutionTimeout(datetimeTool)).toBe(false);
    expect(
      resolveEffectiveToolTimeoutMs(datetimeTool, {
        enabled: true,
        parameters: {},
      })
    ).toBe(TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT * 1000);
  });
});

describe('migrateLegacyToolParameters', () => {
  it('converts shell timeoutMs settings to timeoutSeconds', () => {
    expect(
      migrateLegacyToolParameters(
        'bash',
        {
          timeoutSeconds: 30,
          timeoutMs: 15_000,
          maxOutputBytes: 1000,
        },
        { timeoutMs: 15_000 }
      )
    ).toEqual({
      timeoutSeconds: 15,
      maxOutputBytes: 1000,
    });
  });

  it('prefers timeoutSeconds when both legacy keys are present', () => {
    expect(
      migrateLegacyToolParameters(
        'bash',
        {
          timeoutMs: 15_000,
          timeoutSeconds: 45,
        },
        { timeoutSeconds: 45, timeoutMs: 15_000 }
      )
    ).toEqual({ timeoutSeconds: 45 });
  });

  it('clamps sub-minimum legacy timeouts up to the floor instead of throwing', () => {
    const migrated = migrateLegacyToolParameters('bash', {
      timeoutMs: 1_000,
      maxOutputBytes: 5_000,
    });
    expect(migrated).toEqual({
      timeoutSeconds: TOOL_EXECUTION_TIMEOUT_SECONDS_MIN,
      maxOutputBytes: 5_000,
    });
    // The migrated shape must survive normalization so unrelated settings are kept.
    const merged = mergeToolSettings(buildShellTool('bash'), {
      enabled: true,
      parameters: { timeoutMs: 1_000, maxOutputBytes: 5_000 },
    });
    expect(merged.parameters.timeoutSeconds).toBe(TOOL_EXECUTION_TIMEOUT_SECONDS_MIN);
    expect(merged.parameters.maxOutputBytes).toBe(5_000);
  });

  it('leaves non-shell tools untouched', () => {
    const params = { timeoutMs: 5000 };
    expect(migrateLegacyToolParameters('grep', params)).toBe(params);
  });
});

describe('startToolTimeout', () => {
  it('aborts with a ToolExecutionTimedOutError at the deadline and reports timedOut', async () => {
    const guard = startToolTimeout(undefined, 'slow_tool', 20);
    try {
      expect(guard.signal.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(guard.signal.aborted).toBe(true);
      expect(guard.timedOut).toBe(true);
      expect(guard.signal.reason).toBeInstanceOf(ToolExecutionTimedOutError);
      expect((guard.signal.reason as Error).message).toBe('Tool "slow_tool" timed out after 20ms');
    } finally {
      guard.dispose();
    }
  });

  it('follows a parent abort without reporting a timeout', () => {
    const parent = new AbortController();
    const guard = startToolTimeout(parent.signal, 'slow_tool', 60_000);
    try {
      parent.abort('client_disconnect');

      expect(guard.signal.aborted).toBe(true);
      expect(guard.signal.reason).toBe('client_disconnect');
      expect(guard.timedOut).toBe(false);
    } finally {
      guard.dispose();
    }
  });

  it('starts aborted, and never arms a timer, when the parent already aborted', async () => {
    const parent = new AbortController();
    parent.abort('already_stopped');
    const guard = startToolTimeout(parent.signal, 'slow_tool', 10);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(guard.signal.reason).toBe('already_stopped');
    expect(guard.timedOut).toBe(false);
  });

  it('does not fire after dispose', async () => {
    const guard = startToolTimeout(undefined, 'slow_tool', 20);
    guard.dispose();
    guard.dispose();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(guard.signal.aborted).toBe(false);
    expect(guard.timedOut).toBe(false);
  });
});

describe('buildShellTool timeout descriptor', () => {
  it('exposes timeoutSeconds within the supported bounds', () => {
    const descriptor = buildShellTool('bash').settings.parameterDescriptors.find(
      (item) => item.name === TOOL_EXECUTION_TIMEOUT_PARAM
    );
    expect(descriptor).toMatchObject({
      type: 'number',
      defaultValue: TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT,
      min: TOOL_EXECUTION_TIMEOUT_SECONDS_MIN,
      max: TOOL_EXECUTION_TIMEOUT_SECONDS_MAX,
    });
  });
});
