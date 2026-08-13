import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorModelsModal } from '../../../src/features/settings/connectors/components/ConnectorModelsModal';
import { fireEvent, render, screen } from '../../support/harness/render';

const CONNECTOR: Connector = {
  id: 'connector_google',
  name: 'Google AI',
  provider: 'gemini',
  configured: true,
  source: 'config-file',
  maskedSuffix: null,
  updatedAt: 1,
  lastValidatedAt: null,
  lastValidationError: null,
  enabledModels: ['imagen-3'],
  userId: null,
  baseUrl: null,
};

const MODEL_CATALOG: ModelCatalogResponse = {
  configured: true,
  status: 'ready',
  allModels: [],
  textModels: [],
  imageModels: [],
  discoveredTextModels: [
    {
      modelId: 'gemini-2.5-pro',
      resourceName: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      provider: 'gemini',
      supportedActions: ['chat'],
    },
    {
      modelId: 'gpt-4.1',
      resourceName: 'gpt-4.1',
      displayName: 'GPT 4.1',
      provider: 'openai',
      supportedActions: ['chat'],
    },
  ],
  discoveredImageModels: [
    {
      modelId: 'imagen-3',
      resourceName: 'imagen-3',
      displayName: 'Imagen 3',
      provider: 'gemini',
      supportedActions: ['image_generation'],
    },
  ],
};

describe('ConnectorModelsModal', () => {
  it('renders provider models and toggles text and image models', async () => {
    const user = userEvent.setup();
    const onToggleModel = vi.fn();

    render(
      <ConnectorModelsModal
        connector={CONNECTOR}
        modelCatalog={MODEL_CATALOG}
        modelSearchQuery=""
        onSearchChange={vi.fn()}
        onToggleModel={onToggleModel}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Text Models')).toBeInTheDocument();
    expect(screen.getByText('Image Models')).toBeInTheDocument();
    expect(screen.queryByText('GPT 4.1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /gemini 2\.5 pro/i }));
    await user.click(screen.getByRole('checkbox', { name: /imagen 3/i }));

    expect(onToggleModel).toHaveBeenNthCalledWith(1, 'gemini-2.5-pro', true);
    expect(onToggleModel).toHaveBeenNthCalledWith(2, 'imagen-3', false);
  });

  it('keeps search input delegated to the modal owner', () => {
    const onSearchChange = vi.fn();

    render(
      <ConnectorModelsModal
        connector={CONNECTOR}
        modelCatalog={MODEL_CATALOG}
        modelSearchQuery=""
        onSearchChange={onSearchChange}
        onToggleModel={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search models by name or ID...'), {
      target: { value: 'pro' },
    });

    expect(onSearchChange).toHaveBeenCalledWith('pro');
  });

  it('shows stored enabled models when the catalog discovered none', () => {
    render(
      <ConnectorModelsModal
        connector={{
          ...CONNECTOR,
          provider: 'cursor',
          name: 'legacy-cursor',
          enabledModels: ['composer-2.5'],
        }}
        modelCatalog={{
          ...MODEL_CATALOG,
          discoveredTextModels: [],
          discoveredImageModels: [],
        }}
        modelSearchQuery=""
        onSearchChange={vi.fn()}
        onToggleModel={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getAllByText('composer-2.5').length).toBeGreaterThan(0);
    expect(screen.getByRole('checkbox', { name: /composer-2\.5/i })).toBeChecked();
    expect(screen.queryByText(/no models have been discovered/i)).not.toBeInTheDocument();
  });
});
