/**
 * Issue #1014: the toolchain line on each environment card ("Node 22.11.0 (nvm)
 * · Bun 1.4.0") is a bonus, not a reason to probe. It reads the runtime statuses
 * another screen already put in the query cache, and stays absent otherwise, so
 * a grid of connected machines never fans a probe across the fleet.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { Environment } from '@mangostudio/shared/environments';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { EnvironmentEntitiesOverview } from '../../../../src/features/environments/components/EnvironmentEntitiesOverview';
import { environmentKeys } from '../../../../src/features/environments/queries';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { installation, runtimeStatus } from './fixtures';

const scenario = createFetchScenario();

afterEach(() => {
  scenario.restore();
});

function connectedEnvironment(id: string): Environment {
  return {
    id,
    name: `Machine ${id}`,
    transportKind: 'ssh',
    config: { host: `${id}.internal`, user: 'deploy' },
    enabled: true,
    allowInstalls: false,
    virtual: false,
    createdAt: 1,
    updatedAt: 1,
    status: { state: 'connected' },
  };
}

const MACHINES = ['build-01', 'build-02', 'build-03'].map(connectedEnvironment);

const NODE_AND_BUN = [
  runtimeStatus({
    id: 'node',
    installations: [
      installation({
        path: '/home/dev/.nvm/versions/node/v22/bin/node',
        version: '22.11.0',
        effective: true,
        pathSource: 'nvm',
      }),
    ],
  }),
  runtimeStatus({
    id: 'bun',
    installations: [
      installation({ path: '/home/dev/.bun/bin/bun', version: '1.4.0', effective: true }),
    ],
  }),
];

/** Named fake hub: answers the overview's own reads and nothing the summary line could ask. */
function installHub(): void {
  scenario
    .respondWithJson('GET', '/api/environments', { body: MACHINES })
    .respondWithJson('GET', '/api/environments/wsl', {
      body: { available: false, distributions: [], reason: 'not-windows' },
    });
  for (const machine of MACHINES) {
    scenario.respondWithJson('GET', `/api/environments/${machine.id}/runtime`, {
      body: {
        health: null,
        readAt: null,
        stale: true,
        slotBytes: null,
        actions: ['install', 'reinstall', 'upgrade', 'setup'],
      },
    });
    scenario.respondWithJson('GET', `/api/environments/runtimes?environmentId=${machine.id}`, {
      body: NODE_AND_BUN,
    });
  }
  scenario.install();
}

function requestedPaths(): string[] {
  return scenario.fetchMock.mock.calls.map(([input]) => {
    const url = input instanceof Request ? input.url : String(input);
    return new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search;
  });
}

/** Puts one machine's runtime statuses in the cache, as another screen's query would. */
function CacheSeededWith({ environmentId }: { environmentId: string }) {
  const queryClient = useQueryClient();
  useState(() => queryClient.setQueryData(environmentKeys.runtimes(environmentId), NODE_AND_BUN));
  return <EnvironmentEntitiesOverview />;
}

describe('environment card toolchain summary', () => {
  it('issues no runtime probe for any of the connected cards', async () => {
    installHub();

    render(<EnvironmentEntitiesOverview />);
    await waitFor(() => expect(screen.getAllByTestId('environment-entity-card')).toHaveLength(3));
    // Let any query the cards enable on mount reach the network before looking.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const probes = requestedPaths().filter((path) => path.includes('/api/environments/runtimes'));
    expect(
      probes,
      `(toolchain summary): expected runtime probe requests for 3 connected cards: 0 | received: ${probes.join(', ')}`
    ).toEqual([]);
  });

  it('renders no summary line while the runtime statuses are not cached', async () => {
    installHub();

    render(<EnvironmentEntitiesOverview />);
    await waitFor(() => expect(screen.getAllByTestId('environment-entity-card')).toHaveLength(3));

    expect(screen.queryAllByTestId('environment-toolchain-summary')).toEqual([]);
  });

  it('renders the summary from statuses already in the cache, and only for that machine', async () => {
    installHub();

    render(<CacheSeededWith environmentId="build-02" />);
    await waitFor(() => expect(screen.getAllByTestId('environment-entity-card')).toHaveLength(3));

    const cards = screen.getAllByTestId('environment-entity-card');
    const seeded = cards.find((card) => card.getAttribute('data-environment-id') === 'build-02');
    const other = cards.find((card) => card.getAttribute('data-environment-id') === 'build-01');
    expect(
      await within(seeded as HTMLElement).findByTestId('environment-toolchain-summary')
    ).toHaveTextContent('Node 22.11.0 (from nvm) · Bun 1.4.0');
    expect(within(other as HTMLElement).queryByTestId('environment-toolchain-summary')).toBeNull();
    expect(requestedPaths().filter((path) => path.includes('/runtimes'))).toEqual([]);
  });
});
