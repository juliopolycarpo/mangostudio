/**
 * An MCP server has one rename: the pencil form, which writes the server's
 * configured `name`. The identity menu on its card keeps the avatar half of the
 * registry (monogram, image) and drops the name half, so what the form wrote is
 * what the card shows — and a display name stored before that decision is
 * ignored rather than rewritten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import type { McpServer } from '@mangostudio/shared/mcp';
import type { ToolIdentityListResponse } from '@mangostudio/shared/tool-identity';
import userEvent from '@testing-library/user-event';

import { AgentCliCard } from '../../../../src/features/environments/components/AgentCliCard';
import { IdentityEditDialog } from '../../../../src/features/environments/identity/IdentityEditDialog';
import { resolveToolIdentity } from '../../../../src/features/environments/identity/resolve';
import { McpServerCard } from '../../../../src/features/settings/mcp/components/McpServerCard';
import { fireEvent, render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { agentCliStatus } from '../environments/fixtures';

const scenario = createFetchScenario();
const labels = en.environments.identity;

/** A display name stored before the card dropped it, beside a monogram that still applies. */
const STALE_MCP_NAME = identities({
  'mcp:weather': {
    subjectKey: 'mcp:weather',
    displayName: 'Forecast',
    monogram: 'FC',
    image: null,
    updatedAt: 1,
  },
});

function identities(map: ToolIdentityListResponse['identities']): ToolIdentityListResponse {
  return { identities: map };
}

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

function renderMcpCard() {
  render(
    <McpServerCard server={mcpServer()} onEdit={() => undefined} onDelete={() => undefined} />
  );
}

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('MCP server card identity menu', () => {
  it('offers no rename entry, only the avatar one', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: identities({}) });
    renderMcpCard();

    await userEvent.click(screen.getByTestId('tool-identity-menu'));

    expect(
      screen.queryByRole('menuitem', { name: labels.rename }),
      `(mcp identity menu): expected no "${labels.rename}" entry | received one`
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: labels.customize })).toBeInTheDocument();
    // The server's own actions stay where they were.
    expect(screen.getByRole('menuitem', { name: en.settings.mcp.editButton })).toBeInTheDocument();
  });

  it('opens a dialog without a name field but with the monogram and image fields', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: identities({}) });
    renderMcpCard();

    await userEvent.click(screen.getByTestId('tool-identity-menu'));
    await userEvent.click(screen.getByRole('menuitem', { name: labels.customize }));

    const dialog = screen.getByTestId('identity-edit-dialog');
    expect(within(dialog).getByRole('dialog')).toHaveAccessibleName(
      labels.customizeDialogTitle.replace('{name}', 'Weather')
    );
    expect(
      within(dialog).queryByLabelText(labels.nameLabel),
      `(mcp identity dialog): expected no "${labels.nameLabel}" field | received one`
    ).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(labels.monogramLabel)).toBeInTheDocument();
  });

  it('shows the server name and ignores a display name stored earlier', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: STALE_MCP_NAME });
    renderMcpCard();

    // The server name is also the fallback before the registry answers, so the
    // stored monogram is the signal that the answer has been applied. Only then
    // can a stale name that wins late be told apart from one that never loaded.
    await waitFor(() => {
      expect(screen.getByTitle('Weather')).toHaveTextContent('FC');
    });
    expect(screen.getByRole('heading', { name: 'Weather' })).toBeInTheDocument();
    expect(
      screen.queryByText('Forecast'),
      '(mcp card): expected the configured name "Weather" | received the stale identity name "Forecast"'
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-identity-menu')).toHaveAccessibleName(
      en.settings.mcp.moreActions.replace('{name}', 'Weather')
    );
  });
});

describe('saving the avatar of an MCP identity', () => {
  it('sends the monogram only and leaves the stale stored name alone', async () => {
    const putBodies: unknown[] = [];
    scenario.fetchMock.mockImplementation(async (input, init) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(String(input), 'http://localhost'), init);
      if (request.method === 'GET') return Response.json(STALE_MCP_NAME);
      if (request.method === 'PUT') {
        putBodies.push(JSON.parse(await request.text()));
        return Response.json({ identity: STALE_MCP_NAME.identities['mcp:weather'] });
      }
      throw new Error(`Unexpected identity request: ${request.method} ${request.url}`);
    });
    let closed = false;
    const identity = resolveToolIdentity(STALE_MCP_NAME.identities, 'mcp:weather', 'Weather');

    render(
      <IdentityEditDialog
        identity={identity}
        defaultName="Weather"
        onClose={() => {
          closed = true;
        }}
      />
    );
    fireEvent.change(screen.getByLabelText(labels.monogramLabel), { target: { value: 'ZZ' } });
    fireEvent.click(screen.getByRole('button', { name: labels.save }));

    await waitFor(() => expect(closed).toBe(true));
    expect(
      putBodies,
      '(mcp identity save): expected one patch of { monogram: "ZZ" } | received a patch touching displayName'
    ).toEqual([{ monogram: 'ZZ' }]);
  });
});

describe('other subjects keep the name field', () => {
  it('still offers Rename and a display name field on an agent card', async () => {
    scenario.respondWithJson('GET', '/api/tool-identities', { body: identities({}) });
    render(<AgentCliCard status={agentCliStatus()} recipes={[]} />);

    await userEvent.click(screen.getByTestId('tool-identity-menu'));
    expect(
      screen.queryByRole('menuitem', { name: labels.customize }),
      `(agent identity menu): expected no "${labels.customize}" entry | received one`
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: labels.rename }));

    const dialog = screen.getByTestId('identity-edit-dialog');
    expect(within(dialog).getByLabelText(labels.nameLabel)).toBeInTheDocument();
  });
});
