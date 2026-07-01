import { afterEach, describe, expect, it, mock } from 'bun:test';
import { getProviderRuntimeAvailability } from '../../../../src/services/providers/core/provider-settings-policy';
import { buildCursorSidecarEnv } from '../../../../src/services/providers/cursor/agent-runner';
import {
  CursorApiError,
  fetchCursorModels,
} from '../../../../src/services/providers/cursor/client';
import { buildCursorModelParams } from '../../../../src/services/providers/cursor/index';
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
