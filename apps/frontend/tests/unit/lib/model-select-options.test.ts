/**
 * The shared model-picker option list.
 *
 * Three settings fields build the same list; what is pinned here is the order
 * — fallback first, then each list in the order it was handed over, so a model
 * the catalog no longer carries stays in front of the live ones instead of
 * disappearing from its own field.
 */

import { describe, expect, it } from 'bun:test';
import { modelSelectOptions } from '../../../src/lib/model-select-options';

const FALLBACK = { value: 'current_model', label: 'Use the current model' };

describe('modelSelectOptions', () => {
  it('puts the fallback first and maps each model to a row', () => {
    expect(modelSelectOptions(FALLBACK, [{ modelId: 'gpt-5', displayName: 'GPT-5' }])).toEqual([
      FALLBACK,
      { value: 'gpt-5', label: 'GPT-5' },
    ]);
  });

  it('keeps the lists in the order they were given', () => {
    const options = modelSelectOptions(
      FALLBACK,
      [{ modelId: 'retired', displayName: 'Retired model' }],
      [{ modelId: 'gpt-5', displayName: 'GPT-5' }]
    );

    expect(options.map((option) => option.value)).toEqual(['current_model', 'retired', 'gpt-5']);
  });

  it('is just the fallback when no model is offered', () => {
    expect(modelSelectOptions(FALLBACK, [], [])).toEqual([FALLBACK]);
  });
});
