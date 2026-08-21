import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { AppContext } from '../../../src/lib/app-context';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { LinkStub } from '../../support/mocks/router';

/**
 * The Logs page reports how each external agent in the **active environment**
 * was discovered, so it reads the app's current environment the same way the
 * runner selector does. Only that one field is supplied: a fuller stub would
 * assert a shape this page does not depend on.
 */
function withApp(children: React.ReactNode, currentEnvironmentId: string | null = 'local') {
  return <AppContext value={{ currentEnvironmentId } as never}>{children}</AppContext>;
}

// Declared at module level rather than inline in the factory: biome's
// `noComponentHookFactories` rejects a component defined inside a function.

// The real namespace is spread in: `bun test` resolves every export at import,
// so a factory returning only these two breaks the module's other consumers.
const actualRouter = await import('@tanstack/react-router');

mock.module('@tanstack/react-router', () => ({
  ...actualRouter,
  Link: LinkStub,
  useRouterState: () => ({ location: { pathname: '/settings/metrics' } }),
}));

// Below the mock, never as static imports.
const { SettingsTabs } = await import('../../../src/components/settings/SettingsTabs');
const { LogsSettingsPage, MetricsSettingsPage } = await import(
  '../../../src/features/settings/observability'
);

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

    fetchScenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: {
        environmentId: 'local',
        agents: [
          {
            targetId: 'cursor',
            environmentId: 'local',
            installed: true,
            authState: 'signed-in',
            capabilities: {
              structuredStreaming: true,
              reasoningStream: true,
              interactiveApprovals: true,
              resume: true,
              modelCatalog: true,
              images: true,
              usageReporting: false,
              cancellation: true,
              steering: false,
              sessionListing: true,
              nativeReview: false,
              accountUsage: false,
            },
            supportedConfigurations: [],
            discovery: { source: 'cache', probedAtMs: 1_700_000_000_000, attempts: 2 },
          },
        ],
      },
    });

    render(withApp(<LogsSettingsPage />));

    await screen.findByRole('heading', { name: 'Google Gemini' });
    expect(screen.getByText('Probe timeout')).toBeInTheDocument();
    expect(screen.getByText('Gemini model listing timed out.')).toBeInTheDocument();
  });

  it('says whether an agent was probed or remembered, and how many attempts it took', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/logs', {
      body: { generatedAt: 1_700_000_000_000, entries: [] },
    });
    fetchScenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: {
        environmentId: 'local',
        agents: [
          {
            targetId: 'cursor',
            environmentId: 'local',
            installed: true,
            authState: 'signed-in',
            capabilities: {
              structuredStreaming: true,
              reasoningStream: true,
              interactiveApprovals: true,
              resume: true,
              modelCatalog: true,
              images: true,
              usageReporting: false,
              cancellation: true,
              steering: false,
              sessionListing: true,
              nativeReview: false,
              accountUsage: false,
            },
            supportedConfigurations: [],
            discovery: { source: 'cache', probedAtMs: 1_700_000_000_000, attempts: 2 },
          },
        ],
      },
    });

    render(withApp(<LogsSettingsPage />));

    await screen.findByText('From cache');
    expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
  });

  it('probes the local machine when no chat is open', async () => {
    // `currentEnvironmentId` comes from the open chat, and a user with no chats
    // is exactly who needs this card. Without a fallback the query never runs
    // and the page prints "no external agents" about a machine it never asked.
    fetchScenario.respondWithJson('GET', '/api/settings/logs', {
      body: { generatedAt: 1_700_000_000_000, entries: [] },
    });
    fetchScenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: {
        environmentId: 'local',
        agents: [
          {
            targetId: 'cursor',
            environmentId: 'local',
            installed: true,
            authState: 'signed-in',
            capabilities: {
              structuredStreaming: true,
              reasoningStream: true,
              interactiveApprovals: true,
              resume: true,
              modelCatalog: true,
              images: true,
              usageReporting: false,
              cancellation: true,
              steering: false,
              sessionListing: true,
              nativeReview: false,
              accountUsage: false,
            },
            supportedConfigurations: [],
            discovery: { source: 'live', probedAtMs: 1_700_000_000_000, attempts: 1 },
          },
        ],
      },
    });

    render(withApp(<LogsSettingsPage />, null));

    await screen.findByText('Probed');
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
