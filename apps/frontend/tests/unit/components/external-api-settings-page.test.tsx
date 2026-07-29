/**
 * Unit tests for ExternalApiSettingsPage: list rendering, create reveal,
 * revoke confirmation, toggle wiring, and the active-key cap.
 */

import {
  API_KEY_MAX_PER_USER,
  type ApiKeySummary,
  type CreateApiKeyResponse,
} from '@mangostudio/shared/api-keys';
import { DEFAULT_EXTERNAL_API_SETTINGS } from '@mangostudio/shared/app-settings';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalApiSettingsPage } from '../../../src/features/settings/external-api/components/ExternalApiSettingsPage';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const SAMPLE_KEY: ApiKeySummary = {
  id: 'key-1',
  name: 'CI pipeline',
  scope: 'read-only',
  start: 'mango_abc',
  createdAt: '2026-07-01T12:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
};

const CREATED: CreateApiKeyResponse = {
  key: 'mango_plaintext_secret_once',
  summary: {
    ...SAMPLE_KEY,
    id: 'key-new',
    name: 'CI pipeline',
  },
};

function respondWithKeys(
  fetchScenario: ReturnType<typeof createFetchScenario>,
  keys: ApiKeySummary[]
) {
  fetchScenario.respondWithJson('GET', '/api/api-keys', { body: { keys } });
}

describe('ExternalApiSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows the empty state when no keys exist', async () => {
    respondWithKeys(fetchScenario, []);

    render(
      <ExternalApiSettingsPage
        settings={DEFAULT_EXTERNAL_API_SETTINGS}
        setExternalApiEnabled={vi.fn()}
      />
    );

    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    fetchScenario.respondWithJson('GET', '/api/api-keys', {
      status: 500,
      body: { error: 'boom' },
    });

    render(
      <ExternalApiSettingsPage
        settings={DEFAULT_EXTERNAL_API_SETTINGS}
        setExternalApiEnabled={vi.fn()}
      />
    );

    expect(await screen.findByText(/retry/i)).toBeInTheDocument();
  });

  it('renders the key list from the mocked query', async () => {
    respondWithKeys(fetchScenario, [SAMPLE_KEY]);

    render(
      <ExternalApiSettingsPage settings={{ enabled: true }} setExternalApiEnabled={vi.fn()} />
    );

    expect(await screen.findByText('CI pipeline')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('mango_abc…')).toBeInTheDocument();
  });

  it('marks rows inactive when the toggle is off', async () => {
    respondWithKeys(fetchScenario, [SAMPLE_KEY]);

    render(
      <ExternalApiSettingsPage settings={{ enabled: false }} setExternalApiEnabled={vi.fn()} />
    );

    expect(await screen.findByText('CI pipeline')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(
      screen.getByText(/existing keys stay listed but every request that presents them is refused/i)
    ).toBeInTheDocument();
  });

  it('calls the injected setter when the enable toggle changes', async () => {
    const user = userEvent.setup();
    const setExternalApiEnabled = vi.fn();
    respondWithKeys(fetchScenario, []);

    render(
      <ExternalApiSettingsPage
        settings={{ enabled: false }}
        setExternalApiEnabled={setExternalApiEnabled}
      />
    );

    await user.click(await screen.findByRole('checkbox', { name: /enable external api access/i }));
    expect(setExternalApiEnabled).toHaveBeenCalledWith(true);
  });

  it('shows the plaintext key once on create and drops it after close', async () => {
    const user = userEvent.setup();
    respondWithKeys(fetchScenario, []);
    fetchScenario.respondWithJson('POST', '/api/api-keys', {
      status: 201,
      body: CREATED,
    });

    render(
      <ExternalApiSettingsPage settings={{ enabled: true }} setExternalApiEnabled={vi.fn()} />
    );

    await user.click(await screen.findByRole('button', { name: /create key/i }));
    await user.type(screen.getByLabelText('Name'), 'CI pipeline');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByTestId('api-key-plaintext')).toHaveTextContent(
      'mango_plaintext_secret_once'
    );
    expect(screen.getByText(/only time the plaintext key is shown/i)).toBeInTheDocument();

    // After create the list is invalidated; re-seed without the secret.
    respondWithKeys(fetchScenario, [CREATED.summary]);
    await user.click(screen.getByRole('button', { name: /^done$/i }));

    expect(screen.queryByTestId('api-key-plaintext')).not.toBeInTheDocument();
    expect(screen.queryByText('mango_plaintext_secret_once')).not.toBeInTheDocument();
  });

  it('keeps cancel disabled while create is pending so plaintext cannot be orphaned', async () => {
    const user = userEvent.setup();
    respondWithKeys(fetchScenario, []);

    let resolveCreate!: (response: Response) => void;
    const pendingCreate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const defaultFetch = fetchScenario.fetchMock.getMockImplementation();
    if (!defaultFetch) {
      throw new Error('expected fetch scenario mock implementation');
    }

    fetchScenario.fetchMock.mockImplementation((input, init) => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const url =
        input instanceof Request ? new URL(input.url) : new URL(String(input), 'http://localhost');
      if (method === 'POST' && url.pathname === '/api/api-keys') {
        return pendingCreate;
      }
      return defaultFetch(input, init);
    });

    render(
      <ExternalApiSettingsPage settings={{ enabled: true }} setExternalApiEnabled={vi.fn()} />
    );

    await user.click(await screen.findByRole('button', { name: /create key/i }));
    await user.type(screen.getByLabelText('Name'), 'CI pipeline');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('button', { name: /creating/i })).toBeDisabled();
    for (const cancel of screen.getAllByRole('button', { name: /^cancel$/i })) {
      expect(cancel).toBeDisabled();
    }

    resolveCreate(
      new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(await screen.findByTestId('api-key-plaintext')).toHaveTextContent(
      'mango_plaintext_secret_once'
    );
  });

  // Asserting the toast, not just the request: the 204 carries no body, and a
  // client that mis-parses it reports a revoke that actually succeeded as a
  // failure while still having fired the DELETE.
  it('fires DELETE and reports success when revoke is confirmed', async () => {
    const user = userEvent.setup();
    respondWithKeys(fetchScenario, [SAMPLE_KEY]);
    fetchScenario.respondWithJson('DELETE', `/api/api-keys/${SAMPLE_KEY.id}`, {
      status: 204,
    });

    render(
      <ExternalApiSettingsPage settings={{ enabled: true }} setExternalApiEnabled={vi.fn()} />
    );

    await user.click(await screen.findByRole('button', { name: /revoke: ci pipeline/i }));
    await user.click(screen.getByRole('button', { name: /^revoke$/i }));

    await vi.waitFor(() => {
      expect(fetchScenario.fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
    expect(await screen.findByText('API key revoked')).toBeInTheDocument();
  });

  it('disables create when the active-key cap is reached', async () => {
    const keys = Array.from({ length: API_KEY_MAX_PER_USER }, (_, index) => ({
      ...SAMPLE_KEY,
      id: `key-${index}`,
      name: `Key ${index}`,
    }));
    respondWithKeys(fetchScenario, keys);

    render(
      <ExternalApiSettingsPage settings={{ enabled: true }} setExternalApiEnabled={vi.fn()} />
    );

    expect(await screen.findByText('Key 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create key/i })).toBeDisabled();
    expect(screen.getByText(/limit of 20 active keys reached/i)).toBeInTheDocument();
  });
});
