import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsTabs } from '../../../src/components/settings/SettingsTabs';
import {
  LogsSettingsPage,
  MetricsSettingsPage,
} from '../../../src/features/settings/observability';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

vi.mock('@tanstack/react-router', () => {
  return {
    Link: ({
      to,
      children,
      activeProps: _activeProps,
      inactiveProps: _inactiveProps,
      activeOptions: _activeOptions,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      activeProps?: unknown;
      inactiveProps?: unknown;
      activeOptions?: unknown;
      [key: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useRouterState: () => ({ location: { pathname: '/settings/metrics' } }),
  };
});

const fetchScenario = createFetchScenario();

describe('Observability settings pages', () => {
  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('loads and renders provider metrics', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/metrics', {
      body: {
        generatedAt: 1_700_000_000_000,
        providers: [
          {
            provider: 'openai',
            totalProbeTimeouts: 2,
            caches: [
              { cacheName: 'sdk-client', hits: 8, misses: 2, hitRate: 0.8 },
              { cacheName: 'prepared-runtime', hits: 3, misses: 1, hitRate: 0.75 },
              { cacheName: 'provider-route', hits: 5, misses: 1, hitRate: 5 / 6 },
            ],
            probeTimeouts: [
              { operation: 'healthcheck', timeoutCount: 1 },
              { operation: 'model-list', timeoutCount: 1 },
            ],
          },
        ],
      },
    });

    render(<MetricsSettingsPage />);

    await screen.findByText('OpenAI');
    expect(screen.getByText('Cache Hit Rate')).toBeInTheDocument();
    expect(screen.getByText('SDK client')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('renders the usage row when a provider has recorded turns', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/metrics', {
      body: {
        generatedAt: 1_700_000_000_000,
        providers: [
          {
            provider: 'openai',
            totalProbeTimeouts: 0,
            caches: [
              { cacheName: 'sdk-client', hits: 0, misses: 0, hitRate: 0 },
              { cacheName: 'prepared-runtime', hits: 0, misses: 0, hitRate: 0 },
              { cacheName: 'provider-route', hits: 0, misses: 0, hitRate: 0 },
            ],
            probeTimeouts: [
              { operation: 'healthcheck', timeoutCount: 0 },
              { operation: 'model-list', timeoutCount: 0 },
            ],
            usage: {
              textTurns: 7,
              imageGenerations: 3,
              inputTokens: 12_500,
              lastUsedAt: 1_699_999_900_000,
            },
          },
        ],
      },
    });

    render(<MetricsSettingsPage />);

    await screen.findByText('OpenAI');
    expect(screen.getByText('Usage')).toBeInTheDocument();
    expect(screen.getByText('Text turns')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Image generations')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('~Tokens')).toBeInTheDocument();
  });

  it('hides the usage row for providers that were never used', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/metrics', {
      body: {
        generatedAt: 1_700_000_000_000,
        providers: [
          {
            provider: 'anthropic',
            totalProbeTimeouts: 0,
            caches: [
              { cacheName: 'sdk-client', hits: 4, misses: 1, hitRate: 0.8 },
              { cacheName: 'prepared-runtime', hits: 0, misses: 0, hitRate: 0 },
              { cacheName: 'provider-route', hits: 0, misses: 0, hitRate: 0 },
            ],
            probeTimeouts: [
              { operation: 'healthcheck', timeoutCount: 0 },
              { operation: 'model-list', timeoutCount: 0 },
            ],
          },
        ],
      },
    });

    render(<MetricsSettingsPage />);

    await screen.findByText('Anthropic');
    expect(screen.queryByText('Usage')).not.toBeInTheDocument();
    expect(screen.queryByText('Text turns')).not.toBeInTheDocument();
  });

  it('loads and renders recent timeout logs', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/logs', {
      body: {
        generatedAt: 1_700_000_000_000,
        entries: [
          {
            id: '1',
            timestamp: 1_700_000_000_000,
            provider: 'gemini',
            kind: 'probe-timeout',
            operation: 'model-list',
            message: 'Gemini model listing timed out.',
          },
        ],
      },
    });

    render(<LogsSettingsPage />);

    await screen.findByRole('heading', { name: 'Google Gemini' });
    expect(screen.getByText('Probe timeout')).toBeInTheDocument();
    expect(screen.getByText('Gemini model listing timed out.')).toBeInTheDocument();
  });
});

describe('SettingsTabs includes observability pages', () => {
  it('renders Metrics and Logs links', () => {
    render(<SettingsTabs />);

    expect(screen.getByRole('link', { name: 'Metrics' })).toHaveAttribute(
      'href',
      '/settings/metrics'
    );
    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('href', '/settings/logs');
  });
});
