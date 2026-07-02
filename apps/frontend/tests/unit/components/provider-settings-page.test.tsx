/**
 * Unit tests for ProviderSettingsPage component.
 */

import type * as TanstackRouter from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsPage } from '../../../src/features/settings/providers/components/ProviderSettingsPage';
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
});
