/**
 * The `/model` argument resolver. What is easy to get wrong is not the match
 * but the boundary: a model the selector would refuse (another provider, after
 * the chat's first turn) must not be reachable by typing its name, and a query
 * that fits two models must say so rather than pick one.
 */

import { describe, expect, it } from 'bun:test';

import type { ModelOption } from '@mangostudio/shared/catalog';

import {
  availableBuiltIns,
  resolveModelChoice,
} from '../../../../src/features/chat/lib/built-in-commands';

function model(modelId: string, displayName: string, provider?: ModelOption['provider']) {
  return {
    modelId,
    resourceName: `models/${modelId}`,
    displayName,
    supportedActions: [],
    ...(provider ? { provider } : {}),
  } satisfies ModelOption;
}

const MODELS: readonly ModelOption[] = [
  model('gpt-5', 'GPT-5', 'openai'),
  model('gpt-5-mini', 'GPT-5 mini', 'openai'),
  model('gemini-2.5-pro', 'Gemini 2.5 Pro', 'gemini'),
];

describe('resolveModelChoice', () => {
  it('prefers an exact id over a longer id that contains it', () => {
    expect(resolveModelChoice('gpt-5', MODELS, null)).toEqual({ kind: 'match', model: MODELS[0] });
  });

  it('matches a display name without regard to case', () => {
    expect(resolveModelChoice('gemini 2.5 PRO', MODELS, null)).toEqual({
      kind: 'match',
      model: MODELS[2],
    });
  });

  it('accepts a fragment that names exactly one model', () => {
    expect(resolveModelChoice('5-m', MODELS, null)).toEqual({ kind: 'match', model: MODELS[1] });
  });

  it('reports a fragment that fits several models as ambiguous, naming them', () => {
    expect(resolveModelChoice('gpt', MODELS, null)).toEqual({
      kind: 'ambiguous',
      models: [MODELS[0], MODELS[1]],
    });
  });

  it('reports a name no model carries', () => {
    expect(resolveModelChoice('claude', MODELS, null)).toEqual({ kind: 'none' });
  });

  it('asks for a name when the argument is blank', () => {
    expect(resolveModelChoice('  ', MODELS, null)).toEqual({ kind: 'none' });
  });

  it('never offers a model from another provider once the chat is locked to one', () => {
    expect(resolveModelChoice('gemini', MODELS, 'openai')).toEqual({ kind: 'none' });
    expect(resolveModelChoice('gpt-5-mini', MODELS, 'openai')).toEqual({
      kind: 'match',
      model: MODELS[1],
    });
  });
});

describe('availableBuiltIns', () => {
  const base = {
    isExternalRunner: false,
    canStartChat: true,
    canSwitchModel: true,
  };

  it('offers both on a native chat that can do both', () => {
    expect(availableBuiltIns(base)).toEqual(['clear', 'model']);
  });

  it('offers none for an external runner, whose vendor owns the slash namespace', () => {
    expect(availableBuiltIns({ ...base, isExternalRunner: true })).toEqual([]);
  });

  it('drops each command whose action is not wired or not allowed right now', () => {
    expect(availableBuiltIns({ ...base, canStartChat: false })).toEqual(['model']);
    expect(availableBuiltIns({ ...base, canSwitchModel: false })).toEqual(['clear']);
  });
});
