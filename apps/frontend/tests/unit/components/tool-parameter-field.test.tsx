/**
 * Unit tests for the parameter field's fallback display.
 *
 * A tool parameter can hold a value no option carries — one never set, or one
 * naming an image model the catalog has since dropped. The field still shows
 * the first row so the trigger names something, and the point of these tests
 * is that showing it must not also mean *selecting* it: `Select` commits
 * nothing for a row it believes is already chosen, so a fallback routed
 * through `value` would make the visible row the one option nothing could pick.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import type { ModelCatalogResponse } from '@mangostudio/shared/catalog';
import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';

import { ToolParameterField } from '../../../src/features/settings/tools/components/ToolParameterField';
import { fireEvent, render, screen } from '../../support/harness/render';
import { chooseOption } from '../../support/harness/select';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const SELECT_DESCRIPTOR: ToolParameterDescriptor = {
  name: 'quality',
  label: 'Quality',
  type: 'select',
  required: false,
  options: [
    { value: 'standard', label: 'Standard' },
    { value: 'high', label: 'High' },
  ],
};

const MODEL_DESCRIPTOR: ToolParameterDescriptor = {
  name: 'model',
  label: 'Image model',
  type: 'string',
  required: false,
  modelType: 'image',
};

const CATALOG: ModelCatalogResponse = {
  configured: true,
  status: 'ready',
  allModels: [],
  textModels: [],
  imageModels: [
    {
      modelId: 'gpt-image-1',
      resourceName: 'gpt-image-1',
      displayName: 'GPT Image 1',
      supportedActions: ['generate'],
      provider: 'openai',
    },
  ],
  discoveredTextModels: [],
  discoveredImageModels: [],
};

describe('ToolParameterField', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.respondWithJson('GET', '/api/settings/models', { body: CATALOG }).install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows the first option when the stored value matches none', () => {
    render(
      <ToolParameterField
        descriptor={SELECT_DESCRIPTOR}
        value="retired"
        onChange={jest.fn()}
        disabled={false}
      />
    );

    expect(screen.getByRole('combobox', { name: 'Quality' })).toHaveTextContent('Standard');
  });

  it('still commits the first option when it is only the fallback display', async () => {
    const onChange = jest.fn();
    render(
      <ToolParameterField
        descriptor={SELECT_DESCRIPTOR}
        value="retired"
        onChange={onChange}
        disabled={false}
      />
    );

    await chooseOption('Quality', 'Standard');

    expect(onChange).toHaveBeenCalledWith('standard');
  });

  it('lets a dropped image model be changed back to auto', async () => {
    const onChange = jest.fn();
    render(
      <ToolParameterField
        descriptor={MODEL_DESCRIPTOR}
        value="dall-e-2"
        onChange={onChange}
        disabled={false}
      />
    );

    await chooseOption('Image model', 'Auto (first available)');

    expect(onChange).toHaveBeenCalledWith('auto');
  });
});

const NUMBER_DESCRIPTOR: ToolParameterDescriptor = {
  name: 'timeoutSeconds',
  label: 'Timeout (seconds)',
  type: 'number',
  required: false,
  defaultValue: 60,
  min: 5,
  max: 600,
};

describe('ToolParameterField number editing', () => {
  function renderNumber(value: unknown = 60, descriptor = NUMBER_DESCRIPTOR) {
    const onChange = jest.fn();
    const view = render(
      <ToolParameterField
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        disabled={false}
      />
    );
    return { ...view, onChange, input: screen.getByRole('spinbutton') as HTMLInputElement };
  }

  it('holds every prefix locally and commits the complete number on blur', () => {
    const { input, onChange } = renderNumber();
    for (const value of ['', '1', '10', '100']) {
      fireEvent.change(input, { target: { value } });
      expect(input.value).toBe(value);
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(100);
  });

  it('commits on Enter without submitting the surrounding form or repeating on blur', () => {
    const { input, onChange } = renderNumber();
    fireEvent.change(input, { target: { value: '100' } });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(100);
  });

  it('discards the draft on Escape, including the later blur', () => {
    const { input, onChange } = renderNumber();
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('60');
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  for (const value of ['', '1', '601', '1e999']) {
    it(`restores the effective value without saving invalid draft ${JSON.stringify(value)}`, () => {
      const { input, onChange } = renderNumber();
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(input.value).toBe('60');
      expect(onChange).not.toHaveBeenCalled();
    });
  }

  for (const value of ['5', '600', '5.5']) {
    it(`accepts the API-valid number ${value}`, () => {
      const { input, onChange } = renderNumber();
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledWith(Number(value));
    });
  }

  it('does not save an unchanged numeric value', () => {
    const { input, onChange } = renderNumber();
    fireEvent.change(input, { target: { value: '060' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(Number(input.value)).toBe(60);
  });

  it('preserves a draft across descriptor updates and adopts updates when idle', () => {
    const { input, onChange, rerender } = renderNumber();
    fireEvent.change(input, { target: { value: '100' } });
    rerender(
      <ToolParameterField
        descriptor={NUMBER_DESCRIPTOR}
        value={90}
        onChange={onChange}
        disabled={false}
      />
    );
    expect(input.value).toBe('100');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('90');
    rerender(
      <ToolParameterField
        descriptor={NUMBER_DESCRIPTOR}
        value={120}
        onChange={onChange}
        disabled={false}
      />
    );
    expect(input.value).toBe('120');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores the default after clearing an unset parameter', () => {
    const { input, onChange } = renderNumber(null);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe('60');
    expect(onChange).not.toHaveBeenCalled();
  });
});
