/**
 * Integration tests for provider settings pages.
 */

import type * as TanstackRouter from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsPage } from '../../../src/features/settings/providers/components/ProviderSettingsPage';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

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
    maxToolIterations: 10,
  },
};

describe('ProviderSettingsPage integration', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('loads descriptor and displays controls', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');
    expect(screen.getByText('Reasoning & Thinking')).toBeInTheDocument();
    expect(screen.getByText('Tool Configuration')).toBeInTheDocument();
  });

  it('autosaves provider changes after editing', async () => {
    const user = userEvent.setup();

    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');

    // Register PUT response
    fetchScenario.respondWithJson('PUT', '/api/settings/providers/deepseek', {
      body: {
        ...DEEPSEEK_DESCRIPTOR,
        settings: { ...DEEPSEEK_DESCRIPTOR.settings, reasoningEffort: 'max' },
      },
    });

    // Toggle the reasoning effort to 'max'
    const maxButton = screen.getByText('Maximum');
    await user.click(maxButton);

    await waitFor(() => {
      const putCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'PUT' &&
          new URL(url, 'http://localhost').pathname === '/api/settings/providers/deepseek'
        );
      });
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('removes explicit save actions from the provider page', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers/deepseek', {
      body: DEEPSEEK_DESCRIPTOR,
    });

    render(<ProviderSettingsPage />);

    await screen.findByText('DeepSeek');

    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    expect(screen.queryByText('Reset')).not.toBeInTheDocument();
  });
});
