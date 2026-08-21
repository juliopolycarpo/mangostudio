import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import userEvent from '@testing-library/user-event';
import { ConnectorsSettings } from '../../../src/features/settings/connectors';
import { EMPTY_MODEL_CATALOG } from '../../../src/utils/model-utils';
import { render, screen, waitFor } from '../../support/harness/render';
import {
  createFetchScenario,
  type FetchScenarioMock,
} from '../../support/mocks/create-fetch-scenario';

function createDefaultProps() {
  return {
    modelCatalog: EMPTY_MODEL_CATALOG,
    reloadModelCatalog: jest.fn().mockResolvedValue(undefined),
  };
}

function withProviderSettings(fetchScenario: ReturnType<typeof createFetchScenario>) {
  fetchScenario.respondWithJson('GET', '/api/settings/providers', {
    body: { providers: [] },
  });
  return fetchScenario;
}

function mockOAuthPopup() {
  const popup = {
    location: { href: '' },
    close: jest.fn(),
  } as unknown as Window;
  const openSpy = spyOn(window, 'open').mockReturnValue(popup);
  return { popup, openSpy };
}

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

function findFetchCall(fetchMock: FetchScenarioMock, method: string, path: string) {
  return fetchMock.mock.calls.find((rawCall) => {
    const call = rawCall as FetchCall;
    const input = call[0];
    const init = call[1];
    const requestMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const rawUrl = input instanceof Request ? input.url : String(input);
    return (
      requestMethod.toUpperCase() === method.toUpperCase() &&
      new URL(rawUrl, 'http://localhost').pathname === path
    );
  }) as FetchCall | undefined;
}

async function readJsonBody(call: FetchCall) {
  const input = call[0];
  const init = call[1];
  const body = input instanceof Request ? await input.clone().text() : init?.body;
  return JSON.parse(typeof body === 'string' ? body : String(body));
}

describe('ConnectorsSettings', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
    jest.restoreAllMocks();
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
    withProviderSettings(fetchScenario)
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

    withProviderSettings(fetchScenario)
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

  it('renders the ChatGPT OAuth panel without API key fields', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();

    withProviderSettings(fetchScenario).respondWithJson('GET', '/api/settings/connectors', {
      body: { connectors: [] },
    });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText(/no connectors found/i);
    await user.click(screen.getAllByRole('button', { name: /add connector/i })[0]);
    await user.click(screen.getByRole('button', { name: /chatgpt/i }));

    expect(screen.getByText(/connect a chatgpt subscription in your browser/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in with chatgpt$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/save to/i)).not.toBeInTheDocument();
  });

  it('closes and refreshes after ChatGPT OAuth polling succeeds', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();
    const { popup } = mockOAuthPopup();

    withProviderSettings(fetchScenario)
      .respondWithJson('GET', '/api/settings/connectors', {
        body: { connectors: [] },
      })
      .respondWithJson('POST', '/api/settings/connectors/chatgpt/oauth/start', {
        body: {
          sessionId: 'session-success',
          authorizeUrl: 'https://chatgpt.example/authorize',
          expiresAt: Date.now() + 60_000,
        },
      })
      .respondWithJson('GET', '/api/settings/connectors/chatgpt/oauth/session-success/status', {
        body: { status: 'completed', connectorId: 'chatgpt-1' },
      });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText(/no connectors found/i);
    await user.click(screen.getAllByRole('button', { name: /add connector/i })[0]);
    await user.click(screen.getByRole('button', { name: /chatgpt/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'ChatGPT Plus');
    await user.click(screen.getByRole('button', { name: /^sign in with chatgpt$/i }));

    await waitFor(() => {
      expect(popup.location.href).toBe('https://chatgpt.example/authorize');
      expect(props.reloadModelCatalog).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByText(/connect a chatgpt subscription in your browser/i)
    ).not.toBeInTheDocument();
  });

  it('shows mapped ChatGPT OAuth failure copy', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();
    mockOAuthPopup();

    withProviderSettings(fetchScenario)
      .respondWithJson('GET', '/api/settings/connectors', {
        body: { connectors: [] },
      })
      .respondWithJson('POST', '/api/settings/connectors/chatgpt/oauth/start', {
        body: {
          sessionId: 'session-failed',
          authorizeUrl: 'https://chatgpt.example/authorize',
          expiresAt: Date.now() + 60_000,
        },
      })
      .respondWithJson('GET', '/api/settings/connectors/chatgpt/oauth/session-failed/status', {
        body: { status: 'failed', errorCode: 'VALIDATION' },
      });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText(/no connectors found/i);
    await user.click(screen.getAllByRole('button', { name: /add connector/i })[0]);
    await user.click(screen.getByRole('button', { name: /chatgpt/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'ChatGPT Plus');
    await user.click(screen.getByRole('button', { name: /^sign in with chatgpt$/i }));

    expect(
      await screen.findByText('ChatGPT sign-in was not completed. Try again.')
    ).toBeInTheDocument();
    expect(props.reloadModelCatalog).not.toHaveBeenCalled();
  });

  it('cancels a pending ChatGPT OAuth session', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();
    mockOAuthPopup();

    withProviderSettings(fetchScenario)
      .respondWithJson('GET', '/api/settings/connectors', {
        body: { connectors: [] },
      })
      .respondWithJson('POST', '/api/settings/connectors/chatgpt/oauth/start', {
        body: {
          sessionId: 'session-pending',
          authorizeUrl: 'https://chatgpt.example/authorize',
          expiresAt: Date.now() + 60_000,
        },
      })
      .respondWithJson('GET', '/api/settings/connectors/chatgpt/oauth/session-pending/status', {
        body: { status: 'pending' },
      })
      .respondWithJson('POST', '/api/settings/connectors/chatgpt/oauth/session-pending/cancel', {
        body: { success: true },
      });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText(/no connectors found/i);
    await user.click(screen.getAllByRole('button', { name: /add connector/i })[0]);
    await user.click(screen.getByRole('button', { name: /chatgpt/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'ChatGPT Plus');
    await user.click(screen.getByRole('button', { name: /^sign in with chatgpt$/i }));

    await screen.findByText('Complete the sign-in in your browser');
    await user.click(screen.getByRole('button', { name: /cancel sign-in/i }));

    await waitFor(() => {
      expect(
        findFetchCall(
          fetchScenario.fetchMock,
          'POST',
          '/api/settings/connectors/chatgpt/oauth/session-pending/cancel'
        )
      ).toBeTruthy();
    });
  });

  it('starts ChatGPT re-authentication with the connector id', async () => {
    const props = createDefaultProps();
    const user = userEvent.setup();
    const { popup } = mockOAuthPopup();

    fetchScenario
      .respondWithJson('GET', '/api/settings/connectors', {
        body: {
          connectors: [
            {
              id: 'chatgpt-reauth',
              name: 'ChatGPT Plus',
              provider: 'chatgpt',
              configured: true,
              source: 'bun-secrets',
              maskedSuffix: '****....com',
              accountLabel: '****....com',
              planType: 'plus',
              needsReauth: true,
              updatedAt: Date.now(),
              lastValidatedAt: Date.now(),
              lastValidationError: 'CHATGPT_REAUTH_REQUIRED',
              enabledModels: [],
              userId: 'user-1',
            },
          ],
        },
      })
      .respondWithJson('POST', '/api/settings/connectors/chatgpt/oauth/start', {
        body: {
          sessionId: 'session-reauth',
          authorizeUrl: 'https://chatgpt.example/authorize',
          expiresAt: Date.now() + 60_000,
        },
      })
      .respondWithJson('GET', '/api/settings/connectors/chatgpt/oauth/session-reauth/status', {
        body: { status: 'completed', connectorId: 'chatgpt-reauth' },
      });

    render(<ConnectorsSettings {...props} />);

    await screen.findByText('ChatGPT Plus');
    await user.click(screen.getByRole('button', { name: /re-authenticate/i }));

    await waitFor(() => {
      expect(popup.location.href).toBe('https://chatgpt.example/authorize');
      expect(props.reloadModelCatalog).toHaveBeenCalledTimes(1);
    });

    const startCall = findFetchCall(
      fetchScenario.fetchMock,
      'POST',
      '/api/settings/connectors/chatgpt/oauth/start'
    );
    expect(startCall).toBeTruthy();
    await expect(readJsonBody(startCall as FetchCall)).resolves.toMatchObject({
      name: 'ChatGPT Plus',
      connectorId: 'chatgpt-reauth',
    });
  });
});
