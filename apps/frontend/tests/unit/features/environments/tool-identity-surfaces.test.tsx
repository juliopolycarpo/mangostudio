/**
 * A rename reaches every surface that names the same tool.
 *
 * The point of the registry is that one stored override changes the agents
 * card, the library matrix column, and the MCP list together — a tool called
 * two different things in two tabs is exactly the failure this replaces.
 *
 * The other half of the contract is what does *not* change: the slug, the
 * command, and every id on the wire stay as they were.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { McpServer } from '@mangostudio/shared/mcp';
import type { ToolIdentityListResponse } from '@mangostudio/shared/tool-identity';
import { AgentCliCard } from '../../../../src/features/environments/components/AgentCliCard';
import { CoverageMatrix } from '../../../../src/features/library/components/CoverageMatrix';
import { McpServerCard } from '../../../../src/features/settings/mcp/components/McpServerCard';
import { render, screen, waitFor } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { location as libraryLocation, resource, TARGETS } from '../library/fixtures';
import { agentCliStatus, installation } from './fixtures';

const scenario = createFetchScenario();

function identities(map: ToolIdentityListResponse['identities']): ToolIdentityListResponse {
  return { identities: map };
}

const RENAMED_CLAUDE = identities({
  'agent:claude': {
    subjectKey: 'agent:claude',
    displayName: 'Работа',
    monogram: null,
    image: null,
    updatedAt: 1,
  },
});

function mcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'server-1',
    name: 'Weather',
    slug: 'weather',
    transport: 'stdio',
    environmentId: LOCAL_ENVIRONMENT_ID,
    command: 'bunx',
    args: ['weather-mcp'],
    env: {},
    secretEnvNames: [],
    url: null,
    headerNames: [],
    enabled: true,
    timeoutMs: null,
    status: 'connected',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('tool identity across surfaces', () => {
  it('names an agent card with the stored override', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: RENAMED_CLAUDE });

    render(
      <AgentCliCard
        status={agentCliStatus({
          installations: [installation({ path: '/usr/local/bin/claude', version: '2.1.220' })],
          effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
        })}
        recipes={[]}
      />
    );

    expect(await screen.findByRole('heading', { name: 'Работа' })).toBeInTheDocument();
    // Derived from the custom name, and uppercased for a non-Latin script too.
    expect(screen.getByTitle('Работа')).toHaveTextContent('РА');
    expect(screen.queryByRole('heading', { name: 'Claude Code' })).not.toBeInTheDocument();
  });

  it('names the matching library matrix column the same way', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: RENAMED_CLAUDE });

    // Awaited, unlike before: the harness settles the router's initial load
    // inside `act`, and dropping the promise left that update outside it —
    // "the current testing environment is not configured to support act(...)"
    // on stderr, with the test still green.
    await renderWithRouter(
      <CoverageMatrix
        groups={[{ locationId: null, resources: [resource()] }]}
        targets={TARGETS}
        locations={[libraryLocation()]}
        selected={new Set()}
        onToggleSelected={() => undefined}
        onToggleAll={() => undefined}
        environmentId={LOCAL_ENVIRONMENT_ID}
      />
    );

    await waitFor(() => {
      const header = screen
        .getAllByRole('columnheader')
        .find((candidate) => candidate.getAttribute('data-target-id') === 'claude');
      expect(header).toHaveTextContent('Работа');
    });
  });

  it('renames an MCP server on screen without touching its slug or command', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', {
      body: identities({
        'mcp:weather': {
          subjectKey: 'mcp:weather',
          displayName: 'Forecast',
          monogram: 'FC',
          image: null,
          updatedAt: 1,
        },
      }),
    });

    render(
      <McpServerCard server={mcpServer()} onEdit={() => undefined} onDelete={() => undefined} />
    );

    expect(await screen.findByText('Forecast')).toBeInTheDocument();
    expect(screen.getByTitle('Forecast')).toHaveTextContent('FC');
    // The configured server is untouched: the command line still renders from
    // the server row, not from anything the registry stores.
    expect(screen.getByText('bunx weather-mcp')).toBeInTheDocument();
  });

  it('falls back to the product name when nothing is stored', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: identities({}) });

    render(<AgentCliCard status={agentCliStatus()} recipes={[]} />);

    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByTitle('Claude Code')).toHaveTextContent('CC');
  });
});
