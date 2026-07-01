import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createMockSecretMetadataRow } from '@mangostudio/shared/test-utils';
import { getProviderRuntimeAvailability } from '../../../../src/services/providers/core/provider-settings-policy';
import { buildCursorSidecarEnv } from '../../../../src/services/providers/cursor/agent-runner';
import {
  CursorApiError,
  CursorValidationUnavailableError,
  fetchCursorModels,
  validateCursorApiKey,
} from '../../../../src/services/providers/cursor/client';
import {
  buildCursorCustomTools,
  buildCursorModelParams,
  getCursorConnectorRowsForModel,
} from '../../../../src/services/providers/cursor/index';
import {
  getCursorFallbackModels,
  toCursorModelInfo,
} from '../../../../src/services/providers/cursor/model-catalog';
import { buildCursorAgentPrompt } from '../../../../src/services/providers/cursor/prompt-builder';

describe('cursor provider foundation', () => {
  afterEach(() => {
    mock.restore();
  });

  it('maps cursor models to text streaming capabilities', () => {
    const model = toCursorModelInfo('composer-2.5');
    expect(model.provider).toBe('cursor');
    expect(model.capabilities.text).toBe(true);
    expect(model.capabilities.streaming).toBe(true);
    expect(model.capabilities.tools).toBe(false);
    expect(model.capabilities.internalAgentTools).toBe(true);
  });

  it('provides fallback models when discovery is unavailable', () => {
    const models = getCursorFallbackModels();
    expect(models.map((model) => model.modelId)).toEqual(['composer-2.5', 'auto']);
  });

  it('prefers explicit Cursor connector rows before wildcard fallbacks', () => {
    const wildcard = createMockSecretMetadataRow({
      id: 'wildcard',
      provider: 'cursor',
      enabledModels: JSON.stringify([]),
    });
    const disabledExplicit = createMockSecretMetadataRow({
      id: 'disabled-explicit',
      provider: 'cursor',
      configured: 0,
      enabledModels: JSON.stringify(['composer-2.5']),
    });
    const explicit = createMockSecretMetadataRow({
      id: 'explicit',
      provider: 'cursor',
      enabledModels: JSON.stringify(['composer-2.5']),
    });
    const otherModel = createMockSecretMetadataRow({
      id: 'other-model',
      provider: 'cursor',
      enabledModels: JSON.stringify(['auto']),
    });

    expect(
      getCursorConnectorRowsForModel(
        [wildcard, disabledExplicit, otherModel, explicit],
        'composer-2.5'
      ).map((row) => row.id)
    ).toEqual(['explicit', 'wildcard']);
  });

  it('falls back to static models for transient discovery failures', async () => {
    await mock.module('@cursor/sdk', () => ({
      Cursor: {
        models: {
          list: () =>
            Promise.reject(
              Object.assign(new Error('Cursor temporarily unavailable'), { status: 503 })
            ),
        },
      },
    }));

    await expect(fetchCursorModels({ apiKey: 'cursor-test-key' })).resolves.toEqual(
      getCursorFallbackModels()
    );
  });

  it('propagates auth failures during model discovery', async () => {
    await mock.module('@cursor/sdk', () => ({
      Cursor: {
        models: {
          list: () =>
            Promise.reject(
              Object.assign(new Error('Cursor API key rejected'), {
                status: 401,
                isRetryable: false,
              })
            ),
        },
      },
    }));

    await expect(fetchCursorModels({ apiKey: 'cursor-bad-key' })).rejects.toBeInstanceOf(
      CursorApiError
    );
  });

  it('treats auth errors during key validation as CursorApiError', async () => {
    await mock.module('@cursor/sdk', () => ({
      Cursor: {
        models: {
          list: () =>
            Promise.reject(Object.assign(new Error('Cursor API key rejected'), { status: 403 })),
        },
      },
    }));

    await expect(validateCursorApiKey('cursor-bad-key')).rejects.toBeInstanceOf(CursorApiError);
  });

  it('treats transient failures during key validation as CursorValidationUnavailableError', async () => {
    await mock.module('@cursor/sdk', () => ({
      Cursor: {
        models: {
          list: () =>
            Promise.reject(
              Object.assign(new Error('Cursor temporarily unavailable'), { status: 503 })
            ),
        },
      },
    }));

    await expect(validateCursorApiKey('cursor-good-key')).rejects.toBeInstanceOf(
      CursorValidationUnavailableError
    );
  });

  it('treats network errors during key validation as CursorValidationUnavailableError', async () => {
    await mock.module('@cursor/sdk', () => ({
      Cursor: {
        models: {
          list: () => Promise.reject(new Error('fetch failed')),
        },
      },
    }));

    await expect(validateCursorApiKey('cursor-good-key')).rejects.toBeInstanceOf(
      CursorValidationUnavailableError
    );
  });

  it('rejects empty model lists instead of returning fallbacks', async () => {
    await mock.module('@cursor/sdk', () => ({
      Cursor: {
        models: {
          list: () => Promise.resolve([]),
        },
      },
    }));

    const { fetchCursorModels: fetchModels } = await import(
      '../../../../src/services/providers/cursor/client'
    );

    await expect(fetchModels({ apiKey: 'cursor-empty-key' })).rejects.toBeInstanceOf(
      CursorApiError
    );
  });

  it('strips secret-shaped environment variables from sidecar env', () => {
    expect(
      buildCursorSidecarEnv({
        PATH: '/usr/bin',
        HOME: '/tmp/user',
        CURSOR_API_KEY: 'cursor-secret',
        BETTER_AUTH_SECRET: 'auth-secret',
        CUSTOM_TOKEN: 'custom-secret',
      })
    ).toEqual({ PATH: '/usr/bin', HOME: '/tmp/user' });
  });

  it('maps all allowlisted tools to Cursor customTools metadata', () => {
    const tools = buildCursorCustomTools({
      thinkingEnabled: false,
      reasoningEffort: 'medium',
      tools: [
        { name: 'bash', description: 'Run Bash', parameters: { type: 'object' } },
        { name: 'read_file', description: 'Read files', parameters: { type: 'object' } },
        {
          name: 'delegate_to_agent',
          description: 'Delegate',
          parameters: { type: 'object' },
        },
      ],
    });

    expect(tools?.map((tool) => tool.name)).toEqual(['bash', 'read_file']);
    expect(tools?.[0]).toMatchObject({
      name: 'bash',
      description: 'Run Bash',
      inputSchema: { type: 'object' },
    });
  });

  it('returns undefined when no tools are allowlisted', () => {
    expect(
      buildCursorCustomTools({
        thinkingEnabled: false,
        reasoningEffort: 'medium',
        tools: [],
      })
    ).toBeUndefined();
  });

  it('maps supported reasoning efforts to Cursor model params when the model declares thinking', () => {
    const thinkingParameters = [{ id: 'thinking', values: ['low', 'medium', 'high'] }];

    expect(
      buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'high' }, thinkingParameters)
    ).toEqual([{ id: 'thinking', value: 'high' }]);
    expect(
      buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'low' }, thinkingParameters)
    ).toEqual([{ id: 'thinking', value: 'low' }]);
    expect(
      buildCursorModelParams(
        { thinkingEnabled: true, reasoningEffort: 'medium' },
        thinkingParameters
      )
    ).toBe(undefined);
    expect(
      buildCursorModelParams(
        { thinkingEnabled: false, reasoningEffort: 'high' },
        thinkingParameters
      )
    ).toBe(undefined);
  });

  it('omits Cursor model params when metadata is missing or unsupported', () => {
    expect(buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'high' })).toBe(
      undefined
    );
    expect(
      buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'high' }, [
        { id: 'mode', values: ['fast'] },
      ])
    ).toBe(undefined);
    expect(
      buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'high' }, [
        { id: 'thinking', values: ['low'] },
      ])
    ).toBe(undefined);
  });

  it('builds a flattened prompt from system, history, workspace, and user input', () => {
    const prompt = buildCursorAgentPrompt({
      systemPrompt: 'Be concise.',
      workspaceDir: '/workspace/project',
      history: [
        { role: 'user', text: 'Hello' },
        { role: 'ai', text: 'Hi there.' },
      ],
      prompt: 'Summarize the repo.',
    });

    expect(prompt).toContain('Workspace root:\n/workspace/project');
    expect(prompt).toContain('System instructions:\nBe concise.');
    expect(prompt).toContain('User: Hello');
    expect(prompt).toContain('Assistant: Hi there.');
    expect(prompt).toContain('User: Summarize the repo.');
  });

  it('exposes runtime availability for the cursor provider descriptor', async () => {
    const runtime = await getProviderRuntimeAvailability('cursor');
    expect(typeof runtime.runtimeAvailable).toBe('boolean');
    if (!runtime.runtimeAvailable) {
      expect(runtime.runtimeUnavailableReason).toContain('NodeJS');
    }
  });

  it('marks non-cursor providers as runtime-available', async () => {
    expect(await getProviderRuntimeAvailability('openai')).toEqual({ runtimeAvailable: true });
  });
});
