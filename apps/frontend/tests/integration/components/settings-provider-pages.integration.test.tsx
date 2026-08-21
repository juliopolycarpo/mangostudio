/**
 * Integration tests for provider settings pages.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

// Declared at module level rather than inline in the factory: biome's
// `noComponentHookFactories` rejects a component defined inside a function.
function LinkStub({
  to,
  children,
  ...props
}: {
  to: string;
  children: React.ReactNode;
  [k: string]: unknown;
}) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}

// `importOriginal` has no `bun test` equivalent: import the real namespace
// first, register the mock over it, then import the subject. `mock.module` is
// not hoisted and static imports are.
const actualRouter = await import('@tanstack/react-router');

mock.module('@tanstack/react-router', () => ({
  ...actualRouter,
  Link: LinkStub,
  useParams: () => ({ provider: 'deepseek' }),
}));

const { ProviderSettingsPage } = await import(
  '../../../src/features/settings/providers/components/ProviderSettingsPage'
);

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
  runtimeAvailable: true,
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

    // The PUT resolves *after* the call is recorded and writes the saved
    // descriptor back into the editor. `waitFor` returns on the call, so
    // without flushing that response the state update lands outside `act` and
    // prints an "update was not wrapped in act(...)" block on a green test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
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
