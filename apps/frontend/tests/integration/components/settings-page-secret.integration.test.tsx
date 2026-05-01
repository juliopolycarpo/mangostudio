import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorsSettings } from '../../../src/features/settings/connectors';
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
    await user.click(addButtons[0]);

    // Fill in the form
    const nameInput = screen.getByLabelText(/^name$/i);
    await user.type(nameInput, 'test-connector');

    const apiKeyInput = screen.getByLabelText(/api key/i);
    await user.type(apiKeyInput, 'new-key-5678');

    // Submit — the modal's submit button is the last "Add Connector" button in the DOM
    const allAddButtons = screen.getAllByRole('button', { name: /add connector/i });
    await user.click(allAddButtons[allAddButtons.length - 1]);

    await waitFor(() => expect(props.reloadModelCatalog).toHaveBeenCalledTimes(1));
  });

  it('submits DeepSeek connectors with an optional base URL', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();

    fetchScenario
      .respondWithJson('GET', '/api/settings/connectors', {
        body: { connectors: [] },
      })
      .respondWithJson('POST', '/api/settings/connectors', {
        body: {
          id: 'conn-deepseek',
          name: 'deepseek-connector',
          provider: 'deepseek',
          configured: true,
          source: 'bun-secrets',
          maskedSuffix: '1234',
          updatedAt: Date.now(),
          lastValidatedAt: Date.now(),
          lastValidationError: null,
          enabledModels: [],
          userId: 'user-1',
        },
      });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText(/no connectors found/i);
    await user.click(screen.getAllByRole('button', { name: /add connector/i })[0]);
    await user.click(screen.getByRole('button', { name: /deepseek/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'deepseek-connector');
    await user.type(screen.getByLabelText(/base url/i), 'https://api.deepseek.com');
    await user.type(screen.getByLabelText(/api key/i), 'sk-deepseek-test-key');
    const allAddButtons = screen.getAllByRole('button', { name: /add connector/i });
    await user.click(allAddButtons[allAddButtons.length - 1]);

    await waitFor(() => expect(props.reloadModelCatalog).toHaveBeenCalledTimes(1));

    const postCall = fetchScenario.fetchMock.mock.calls.find((call) => {
      const input = call[0];
      const method = input instanceof Request ? input.method : call[1]?.method;
      const url = input instanceof Request ? input.url : String(input);
      return (
        method === 'POST' &&
        new URL(url, 'http://localhost').pathname === '/api/settings/connectors'
      );
    });
    const input = postCall?.[0];
    const init = postCall?.[1];
    const body = input instanceof Request ? await input.text() : init?.body;
    expect(typeof body === 'string' ? body : '').toContain('"provider":"deepseek"');
    expect(typeof body === 'string' ? body : '').toContain('"baseUrl":"https://api.deepseek.com"');
  });
});
