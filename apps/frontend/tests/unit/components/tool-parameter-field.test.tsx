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
import type { ModelCatalogResponse } from '@mangostudio/shared';
import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';
import { ToolParameterField } from '../../../src/features/settings/tools/components/ToolParameterField';
import { render, screen } from '../../support/harness/render';
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
