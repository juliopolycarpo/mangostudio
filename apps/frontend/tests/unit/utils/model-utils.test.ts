import { describe, expect, it } from 'bun:test';
import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared';
import {
  EMPTY_MODEL_CATALOG,
  getModelSelectorPlaceholder,
  hasModelOption,
  resolveActiveModeModel,
  resolveSelectedModel,
} from '@/utils/model-utils';

const options: ModelOption[] = [
  { modelId: 'gpt-4', displayName: 'GPT-4', resourceName: 'gpt-4', supportedActions: ['text'] },
  {
    modelId: 'gemini-pro',
    displayName: 'Gemini Pro',
    resourceName: 'models/gemini-pro',
    supportedActions: ['text'],
  },
];

describe('hasModelOption', () => {
  it('returns false for undefined modelId', () => {
    expect(hasModelOption(undefined, options)).toBe(false);
  });

  it('returns false for empty string modelId', () => {
    expect(hasModelOption('', options)).toBe(false);
  });

  it('returns false when option does not exist', () => {
    expect(hasModelOption('claude-3', options)).toBe(false);
  });

  it('returns true when option exists', () => {
    expect(hasModelOption('gpt-4', options)).toBe(true);
  });

  it('returns false for empty options array', () => {
    expect(hasModelOption('gpt-4', [])).toBe(false);
  });
});

describe('resolveSelectedModel', () => {
  it('returns the selected model when it exists in options', () => {
    expect(resolveSelectedModel('gemini-pro', options)).toBe('gemini-pro');
  });

  it('falls back to first option when selected model is invalid', () => {
    expect(resolveSelectedModel('invalid-model', options)).toBe('gpt-4');
  });

  it('falls back to first option when selected model is undefined', () => {
    expect(resolveSelectedModel(undefined, options)).toBe('gpt-4');
  });

  it('returns empty string when options array is empty', () => {
    expect(resolveSelectedModel(undefined, [])).toBe('');
  });

  it('returns empty string when selected model undefined and options empty', () => {
    expect(resolveSelectedModel('any', [])).toBe('');
  });
});

describe('resolveActiveModeModel', () => {
  it('returns chatModel when it exists in options', () => {
    expect(resolveActiveModeModel('gpt-4', 'gemini-pro', options)).toBe('gpt-4');
  });

  it('falls back to globalModel when chatModel is invalid', () => {
    expect(resolveActiveModeModel('invalid', 'gemini-pro', options)).toBe('gemini-pro');
  });

  it('falls back to first option when both are invalid', () => {
    expect(resolveActiveModeModel('invalid', 'also-invalid', options)).toBe('gpt-4');
  });

  it('returns empty string when all inputs are undefined', () => {
    expect(resolveActiveModeModel(undefined, undefined, options)).toBe('gpt-4');
  });

  it('returns empty string when all inputs and options are empty', () => {
    expect(resolveActiveModeModel(undefined, undefined, [])).toBe('');
  });
});

describe('getModelSelectorPlaceholder', () => {
  it('returns loading message when status is loading', () => {
    const catalog: ModelCatalogResponse = { ...EMPTY_MODEL_CATALOG, status: 'loading' };
    expect(getModelSelectorPlaceholder(catalog)).toBe('Loading models...');
  });

  it('returns error message when status is error', () => {
    const catalog: ModelCatalogResponse = { ...EMPTY_MODEL_CATALOG, status: 'error' };
    expect(getModelSelectorPlaceholder(catalog)).toBe('Models unavailable');
  });

  it('returns no models message when status is idle', () => {
    const catalog: ModelCatalogResponse = { ...EMPTY_MODEL_CATALOG, status: 'idle' };
    expect(getModelSelectorPlaceholder(catalog)).toBe('No models available');
  });

  it('returns no models message when status is ready', () => {
    const catalog: ModelCatalogResponse = {
      ...EMPTY_MODEL_CATALOG,
      status: 'ready',
      configured: true,
    };
    expect(getModelSelectorPlaceholder(catalog)).toBe('No models available');
  });
});
