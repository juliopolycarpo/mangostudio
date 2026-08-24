/**
 * Scoping the umbrella to one machine: the picker only appears when there is a
 * choice, switching machines switches the dataset outright, and an environment
 * that cannot answer says so instead of spinning forever.
 */

import { describe, expect, it } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import type { FunctionComponent } from 'react';
import { RuntimesPage } from '../../../../src/features/environments/components/RuntimesPage';
import {
  environmentScopeRoute,
  validateEnvironmentSearch,
} from '../../../../src/features/environments/use-environment-scope';
import { act, render, screen, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { installation, runtimeStatus } from './fixtures';

function manifest(overrides: { probing?: boolean; shells?: readonly string[] } = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    pathStyle: 'posix' as const,
    homeDir: '/home/dev',
    shells: (overrides.shells ?? ['bash']) as never,
    git: { available: true },
    features: {
      tools: true,
      git: true,
      probing: overrides.probing ?? true,
      mcp: true,
      library: false,
      checkpoints: true,
    },
  };
}

function environment(
  overrides: Partial<Environment> & Pick<Environment, 'id' | 'name'>
): Environment {
  return {
    transportKind: 'wsl',
    config: {},
    enabled: true,
    allowInstalls: false,
    virtual: false,
    createdAt: 0,
    updatedAt: 0,
    status: { state: 'connected', manifest: manifest() },
    ...overrides,
  };
}

const LOCAL = environment({
  id: 'local',
  name: 'Local',
  transportKind: 'in-process',
  virtual: true,
});

/** Mounts the toolchains page under a router that owns the scope search param. */
async function renderRuntimesPage(initialPath = '/environments/runtimes') {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: 'environments/runtimes',
    validateSearch: validateEnvironmentSearch,
    component: RuntimesPage as FunctionComponent,
  });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: Outlet,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, catchAll]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  // The test router is deliberately not the app's registered route tree, so its
  // type does not line up with the provider's registered one.
  // biome-ignore lint/suspicious/noExplicitAny: unregistered test-only route tree
  const result = render(<RouterProvider router={router as any} />);
  await act(async () => {
    await router.load();
  });
  return result;
}

function scenarioFor(environments: readonly Environment[]) {
  const scenario = createFetchScenario();
  scenario.install();
  scenario.respondWithJson('GET', '/api/environments', { body: environments });
  scenario.respondWithJson('GET', '/api/environments/install/recipes', { body: [] });
  scenario.respondWithJson('GET', '/api/environments/version-managers', { body: [] });
  scenario.respondWithJson('GET', '/api/environments/version-managers?environmentId=ubuntu', {
    body: [],
  });
  return scenario;
}

describe('environmentScopeRoute', () => {
  /**
   * The umbrella's landing page is the one tab that ignores the scope — it
   * never calls `useEnvironmentScope`, and its index route has no
   * `validateSearch`. Addressing a machine there would attach a param nothing
   * reads and leave the local machine's data under another machine's URL.
   */
  it('never addresses a machine at the overview', () => {
    expect(environmentScopeRoute('ubuntu').to).toBe('/environments/runtimes');
    expect(environmentScopeRoute(LOCAL_ENVIRONMENT_ID).to).toBe('/environments/runtimes');
  });

  it('leaves the default machine out of the URL', () => {
    expect(environmentScopeRoute('ubuntu').search).toEqual({ environmentId: 'ubuntu' });
    expect(environmentScopeRoute(LOCAL_ENVIRONMENT_ID).search).toEqual({});
  });
});

describe('environment-scoped toolchains', () => {
  it('hides the picker when the hub is the only machine', async () => {
    const scenario = scenarioFor([LOCAL]);
    scenario.respondWithJson('GET', '/api/environments/runtimes', { body: [] });

    await renderRuntimesPage();

    await waitFor(() => {
      expect(screen.getByText(en.environments.runtimes.description)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('environment-scope-picker')).not.toBeInTheDocument();
    scenario.restore();
  });

  it('switches the dataset when another machine is picked', async () => {
    const ubuntu = environment({ id: 'ubuntu', name: 'Ubuntu' });
    const scenario = scenarioFor([LOCAL, ubuntu]);
    scenario.respondWithJson('GET', '/api/environments/runtimes', {
      body: [
        runtimeStatus({
          id: 'bun',
          installations: [installation({ path: '/hub/bun', version: '1.0.0', effective: true })],
          effective: installation({ path: '/hub/bun', version: '1.0.0', effective: true }),
        }),
      ],
    });
    scenario.respondWithJson('GET', '/api/environments/runtimes?environmentId=ubuntu', {
      body: [
        runtimeStatus({
          id: 'bun',
          installations: [installation({ path: '/wsl/bun', version: '9.9.9', effective: true })],
          effective: installation({ path: '/wsl/bun', version: '9.9.9', effective: true }),
        }),
      ],
    });

    await renderRuntimesPage();

    await waitFor(() => expect(screen.getByText('1.0.0')).toBeInTheDocument());
    const picker = await screen.findByTestId('environment-scope-picker');
    await userEvent.selectOptions(picker.querySelector('select') as HTMLSelectElement, 'ubuntu');

    await waitFor(() => expect(screen.getByText('9.9.9')).toBeInTheDocument());
    expect(screen.queryByText('1.0.0')).not.toBeInTheDocument();
    scenario.restore();
  });

  it('names a machine that does not report its toolchains instead of spinning', async () => {
    const locked = environment({
      id: 'ubuntu',
      name: 'Ubuntu',
      status: { state: 'connected', manifest: manifest({ probing: false }) },
    });
    const scenario = scenarioFor([LOCAL, locked]);
    scenario.respondWithJson('GET', '/api/environments/runtimes', { body: [] });

    await renderRuntimesPage('/environments/runtimes?environmentId=ubuntu');

    const notice = await screen.findByTestId('environment-scope-notice');
    expect(notice.dataset.reason).toBe('not-permitted');
    expect(screen.queryByTestId('environments-loading')).not.toBeInTheDocument();
    scenario.restore();
  });

  it('offers to connect a machine that is not connected rather than a generic retry', async () => {
    const offline = environment({
      id: 'ubuntu',
      name: 'Ubuntu',
      status: { state: 'disconnected' },
    });
    const scenario = scenarioFor([LOCAL, offline]);
    scenario.respondWithJson('GET', '/api/environments/runtimes', { body: [] });
    scenario.respondWithJson('GET', '/api/environments/runtimes?environmentId=ubuntu', {
      status: 503,
      body: { error: 'Runtime is unavailable.', code: 'INTERNAL' },
    });

    await renderRuntimesPage('/environments/runtimes?environmentId=ubuntu');

    const notice = await screen.findByTestId('environment-scope-notice');
    expect(notice.dataset.reason).toBe('disconnected');
    expect(screen.getByText(en.environments.scope.connect)).toBeInTheDocument();
    scenario.restore();
  });
});
