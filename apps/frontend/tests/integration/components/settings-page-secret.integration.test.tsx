import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorsSettings } from '../../../src/components/settings/ConnectorsSettings';
import { EMPTY_MODEL_CATALOG } from '../../../src/utils/model-utils';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

function createDefaultProps() {
  return {
    modelCatalog: EMPTY_MODEL_CATALOG,
    reloadModelCatalog: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ConnectorsSettings', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows empty state when no connectors are configured', async () => {
    const props = createDefaultProps();

    fetchScenario.respondWithJson('GET', '/api/settings/connectors', {
      body: { connectors: [] },
    });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText(/no connectors found/i);
  });

  it('shows connector list after loading status with existing connectors', async () => {
    const props = createDefaultProps();

    fetchScenario.respondWithJson('GET', '/api/settings/connectors', {
      body: {
        connectors: [
          {
            id: 'conn-1',
            name: 'My Key',
            provider: 'gemini',
            configured: true,
            source: 'bun-secrets',
            maskedSuffix: '****...1234',
            updatedAt: 1700000000000,
            lastValidatedAt: 1700000000000,
            lastValidationError: null,
            enabledModels: [],
            userId: 'user-1',
          },
        ],
      },
    });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText('My Key');
    expect(screen.getByText('****...1234')).toBeInTheDocument();

    expect(fetchScenario.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds a connector when form is submitted', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();

    // Note: createFetchScenario uses a Map, so the same key can only have one response.
    // Register GET to return empty connectors; it will also be used for the reload after POST.
    fetchScenario
      .respondWithJson('GET', '/api/settings/connectors', {
        body: { connectors: [] },
      })
      .respondWithJson('POST', '/api/settings/connectors', {
        body: {
          id: 'conn-new',
          name: 'test-connector',
          provider: 'gemini',
          configured: true,
          source: 'bun-secrets',
          maskedSuffix: '5678',
          updatedAt: Date.now(),
          lastValidatedAt: Date.now(),
          lastValidationError: null,
          enabledModels: [],
          userId: 'user-1',
        },
      });

    render(<ConnectorsSettings {...props} />);

    // Wait for the initial empty state to load
    await screen.findByText(/no connectors found/i);

    // Open the add modal — pick the first "Add Connector" button (header button)
    const addButtons = screen.getAllByRole('button', { name: /add connector/i });
    await user.click(addButtons[0]!);

    // Fill in the form
    const nameInput = screen.getByLabelText(/^name$/i);
    await user.type(nameInput, 'test-connector');

    const apiKeyInput = screen.getByLabelText(/api key/i);
    await user.type(apiKeyInput, 'new-key-5678');

    // Submit — the modal's submit button is the last "Add Connector" button in the DOM
    const allAddButtons = screen.getAllByRole('button', { name: /add connector/i });
    await user.click(allAddButtons[allAddButtons.length - 1]!);

    await waitFor(() => expect(props.reloadModelCatalog).toHaveBeenCalledTimes(1));
  });
});
