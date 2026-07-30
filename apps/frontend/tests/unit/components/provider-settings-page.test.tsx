/**
 * Unit tests for ProviderSettingsPage component.
 */

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type * as TanstackRouter from '@tanstack/react-router';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsPage } from '../../../src/features/settings/providers/components/ProviderSettingsPage';
import { providerSettingsKeys } from '../../../src/features/settings/providers/queries';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

// Mock TanStack Router — provide useParams
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      [k: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useParams: () => ({ provider: 'deepseek' }),
  };
});

const DEEPSEEK_DESCRIPTOR = {
  provider: 'deepseek',
  displayName: 'DeepSeek',
  scope: 'provider',
  reasoning: {
    supportedEfforts: ['high', 'max'],
    defaultEffort: 'high',
    thinkingToggleSupported: true,
    reasoningWithToolsSupported: true,
  },
  promptCachingSupported: false,
  toolUseSupported: true,
  structuredOutputSupported: false,
  maxOutputTokensLimit: 64000,
  settings: {
    provider: 'deepseek',
    thinkingEnabled: true,
    reasoningEffort: 'high',
    maxToolIterations: 15,
  },
  runtimeAvailable: true,
};

/**
 * Renders the page under the shared harness while handing its query client back
 * to the test, so a realtime invalidation can be replayed against it.
 */
let capturedQueryClient: QueryClient | undefined;

function ProviderSettingsPageProbe() {
  capturedQueryClient = useQueryClient();
  return <ProviderSettingsPage />;
}

describe('ProviderSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows loading state', () => {
    // Don't respond — keep loading
    render(<ProviderSettingsPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state when provider is not found', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      status: 404,
      body: { error: 'Provider not found' },
    });

    render(<ProviderSettingsPage />);

    const retryButton = await screen.findByText(/retry/i);
    expect(retryButton).toBeInTheDocument();
  });

  it('renders provider name and back button', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');
    expect(screen.getByText(/back to providers/i)).toBeInTheDocument();
  });

  it('renders reasoning effort options from descriptor', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    // DeepSeek supports 'high' and 'max'
    await screen.findByText('DeepSeek');
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Maximum')).toBeInTheDocument();
  });

  it('does not render unsupported efforts', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');
    // 'low' and 'medium' are not in DeepSeek's supported efforts
    expect(screen.queryByText('Low')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
  });

  it('renders thinking toggle when supported', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');
    expect(screen.getByLabelText(/enable thinking/i)).toBeInTheDocument();
  });

  it('renders tool configuration when tools are supported', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');
    const iterInputs = screen.getAllByLabelText(/max tool iterations/i);
    expect(iterInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render explicit save actions', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    expect(screen.queryByText(/reset/i)).not.toBeInTheDocument();
  });

  /**
   * The settings realtime channel refetches this descriptor when any tab writes
   * provider settings, so the controls have to follow a descriptor they did not
   * ask for — otherwise the section keeps showing what it loaded with and the
   * next local edit PUTs that whole stale form back over the remote change.
   */
  describe('remote descriptor changes', () => {
    /** Exposes the harness query client so a realtime invalidation can be replayed. */
    function renderWithQueryClient() {
      capturedQueryClient = undefined;
      const view = render(<ProviderSettingsPageProbe />);
      const queryClient = capturedQueryClient;
      if (!queryClient) throw new Error('Expected a query client from the harness');
      return { ...view, queryClient };
    }

    async function refreshDescriptor(queryClient: QueryClient) {
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: providerSettingsKeys.detail('deepseek'),
        });
      });
    }

    it('reflects a descriptor refreshed by another tab', async () => {
      fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
        body: DEEPSEEK_DESCRIPTOR,
      });

      const { queryClient } = renderWithQueryClient();

      await screen.findByText('DeepSeek');
      expect(screen.getByLabelText(/enable thinking/i)).toBeChecked();

      fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
        body: {
          ...DEEPSEEK_DESCRIPTOR,
          settings: { ...DEEPSEEK_DESCRIPTOR.settings, thinkingEnabled: false },
        },
      });
      await refreshDescriptor(queryClient);

      await waitFor(() => expect(screen.getByLabelText(/enable thinking/i)).not.toBeChecked());
    });

    it('keeps a local edit made while the descriptor was refreshing', async () => {
      fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
        body: DEEPSEEK_DESCRIPTOR,
      });

      const { queryClient } = renderWithQueryClient();

      await screen.findByText('DeepSeek');

      // The user turns thinking off locally; the remote change raises the
      // iteration cap, a field they have not touched.
      fireEvent.click(screen.getByLabelText(/enable thinking/i));

      fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
        body: {
          ...DEEPSEEK_DESCRIPTOR,
          settings: { ...DEEPSEEK_DESCRIPTOR.settings, maxToolIterations: 30 },
        },
      });
      await refreshDescriptor(queryClient);

      // Adopting the remote form wholesale would put the toggle back on under
      // the user's hand.
      expect(screen.getByLabelText(/enable thinking/i)).not.toBeChecked();
    });
  });
});
