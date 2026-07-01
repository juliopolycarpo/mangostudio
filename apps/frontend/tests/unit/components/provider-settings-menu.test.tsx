/**
 * Unit tests for ProviderSettingsMenu component.
 */

import type * as TanstackRouter from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsMenu } from '../../../src/features/settings/providers/components/ProviderSettingsMenu';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

// Mock TanStack Router Link
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      activeProps: _activeProps,
      inactiveProps: _inactiveProps,
      activeOptions: _activeOptions,
      params: _params,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      activeProps?: unknown;
      inactiveProps?: unknown;
      activeOptions?: unknown;
      params?: unknown;
      [k: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

const MOCK_DESCRIPTORS = {
  providers: [
    {
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
      },
      runtimeAvailable: true,
    },
    {
      provider: 'anthropic',
      displayName: 'Anthropic',
      scope: 'provider',
      reasoning: {
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        thinkingToggleSupported: true,
        reasoningWithToolsSupported: true,
      },
      promptCachingSupported: true,
      toolUseSupported: true,
      structuredOutputSupported: false,
      maxOutputTokensLimit: 64000,
      settings: {
        provider: 'anthropic',
      },
      runtimeAvailable: true,
    },
  ],
};

describe('ProviderSettingsMenu', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows loading state', () => {
    // Don't respond — keep loading
    render(<ProviderSettingsMenu />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      status: 500,
      body: { error: 'Server error' },
    });

    render(<ProviderSettingsMenu />);

    const retryButton = await screen.findByText(/retry/i);
    expect(retryButton).toBeInTheDocument();
  });

  it('shows empty state when no providers exist', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      body: { providers: [] },
    });

    render(<ProviderSettingsMenu />);

    await screen.findByText(/no ai providers available/i);
  });

  it('renders provider cards from API response', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      body: MOCK_DESCRIPTORS,
    });

    render(<ProviderSettingsMenu />);

    // Provider names are rendered
    await screen.findByText('DeepSeek');
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
  });

  it('renders capability badges for each provider', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      body: MOCK_DESCRIPTORS,
    });

    render(<ProviderSettingsMenu />);

    // DeepSeek has Thinking + Tools badges
    await screen.findByText('DeepSeek');
    const thinkingBadges = screen.getAllByText(/thinking/i);
    expect(thinkingBadges.length).toBeGreaterThanOrEqual(2);

    // Anthropic has Caching badge
    expect(screen.getByText('Caching')).toBeInTheDocument();
  });
});
