import { describe, expect, it } from 'bun:test';
import { buildShellTool } from '../../../../src/services/tools/builtin/_shell-tool';
import {
  migrateLegacyToolParameters,
  resolveEffectiveToolTimeoutMs,
  TOOL_EXECUTION_TIMEOUT_PARAM,
  TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT,
  TOOL_EXECUTION_TIMEOUT_SECONDS_MAX,
  TOOL_EXECUTION_TIMEOUT_SECONDS_MIN,
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

  it('leaves non-shell tools untouched', () => {
    const params = { timeoutMs: 5000 };
    expect(migrateLegacyToolParameters('grep', params)).toBe(params);
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
