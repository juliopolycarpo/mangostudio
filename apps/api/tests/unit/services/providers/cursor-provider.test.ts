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
  buildCursorModelParams,
  getCursorConnectorRowsForModel,
} from '../../../../src/services/providers/cursor/index';
import {
  getCursorFallbackModels,
  toCursorModelInfo,
} from '../../../../src/services/providers/cursor/model-catalog';
import { buildCursorAgentPrompt } from '../../../../src/services/providers/cursor/prompt-builder';

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}

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

  it('applies the shell env allow/deny policy to cursor custom tools', async () => {
    await mock.module('../../../../src/services/tools/builtin/_shell-exec', () => ({
      findShellExecutable: () => '/bin/bash',
    }));

    const previousToken = process.env.GITHUB_TOKEN;
    const previousApiKey = process.env.CURSOR_API_KEY;
    process.env.GITHUB_TOKEN = 'gh-secret';
    process.env.CURSOR_API_KEY = 'cursor-secret';

    try {
      const { buildCursorShellTools: build } = await import(
        '../../../../src/services/providers/cursor/index'
      );

      const [tool] =
        build({
          thinkingEnabled: false,
          reasoningEffort: 'medium',
          tools: [{ name: 'bash', description: 'Run Bash', parameters: { type: 'object' } }],
          toolSettings: {
            bash: {
              enabled: true,
              parameters: { allowedEnvVars: ['GITHUB_TOKEN'], deniedEnvVars: ['PATH'] },
            },
          },
        }) ?? [];

      // Allow-listed secret survives, auto-detected secret is stripped, explicit
      // deny wins over the ambient value.
      expect(tool?.env?.GITHUB_TOKEN).toBe('gh-secret');
      expect(tool?.env?.CURSOR_API_KEY).toBeUndefined();
      expect(tool?.env?.PATH).toBeUndefined();
    } finally {
      restoreEnv('GITHUB_TOKEN', previousToken);
      restoreEnv('CURSOR_API_KEY', previousApiKey);
    }
  });

  it('maps supported reasoning efforts to Cursor model params', () => {
    expect(buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'high' })).toEqual([
      { id: 'thinking', value: 'high' },
    ]);
    expect(buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'low' })).toEqual([
      { id: 'thinking', value: 'low' },
    ]);
    expect(buildCursorModelParams({ thinkingEnabled: true, reasoningEffort: 'medium' })).toBe(
      undefined
    );
    expect(buildCursorModelParams({ thinkingEnabled: false, reasoningEffort: 'high' })).toBe(
      undefined
    );
  });

  it('builds a flattened prompt from system, history, and user input', () => {
    const prompt = buildCursorAgentPrompt({
      systemPrompt: 'Be concise.',
      history: [
        { role: 'user', text: 'Hello' },
        { role: 'ai', text: 'Hi there.' },
      ],
      prompt: 'Summarize the repo.',
    });

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
