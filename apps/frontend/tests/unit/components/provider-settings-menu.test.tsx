/**
 * Unit tests for ProviderSettingsMenu component.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { screen, within } from '@testing-library/react';

import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { routerWithLinkStub } from '../../support/mocks/router';

// Registered before the subject is imported: `mock.module` is not hoisted and
// static imports are.
void mock.module('@tanstack/react-router', await routerWithLinkStub());

const { ProviderSettingsMenu } =
  await import('../../../src/features/settings/providers/components/ProviderSettingsMenu');

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
      deprecated: false,
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
      deprecated: false,
    },
    {
      provider: 'cursor',
      displayName: 'Cursor',
      scope: 'provider',
      reasoning: {
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        thinkingToggleSupported: true,
        reasoningWithToolsSupported: true,
      },
      promptCachingSupported: false,
      toolUseSupported: true,
      structuredOutputSupported: false,
      maxOutputTokensLimit: 128000,
      settings: {
        provider: 'cursor',
      },
      deprecated: true,
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

    const title = await screen.findByText(/no ai providers available/i);
    // A settings-page empty state sits in a card and leads with an icon.
    const card = title.closest('.bg-surface');
    expect(card).not.toBeNull();
    expect(card?.querySelector('svg')).not.toBeNull();
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

  it('lists every provider as one link row in a single list', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      body: MOCK_DESCRIPTORS,
    });

    render(<ProviderSettingsMenu />);

    await screen.findByText('DeepSeek');
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    // The whole row is the link, named by what it holds.
    expect(within(list).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('link', { name: /DeepSeek/ })).toBeInTheDocument();
  });

  it('says what the list of efforts is the list of', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      body: MOCK_DESCRIPTORS,
    });

    render(<ProviderSettingsMenu />);

    await screen.findByText('DeepSeek');
    expect(screen.getByText('Reasoning effort: High, Maximum')).toBeInTheDocument();
    expect(screen.getByText('Reasoning effort: Low, Medium, High')).toBeInTheDocument();
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

  it('marks a deprecated provider without advertising live capabilities', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/providers', {
      body: MOCK_DESCRIPTORS,
    });

    render(<ProviderSettingsMenu />);

    await screen.findByText('Cursor');
    expect(screen.getByText('Legacy')).toBeInTheDocument();
    expect(screen.getByText(/no longer runs this provider/i)).toBeInTheDocument();
  });
});
