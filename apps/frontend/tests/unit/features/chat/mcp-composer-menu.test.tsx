/**
 * The composer's MCP popover. It lists every enabled server's prompts and
 * resources, and it used to draw an empty bordered box when there were none:
 * a tools-only server (the most common kind) rendered nothing at all, and a
 * failed listing was swallowed. The panel has to say what it holds.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpComposerMenu } from '../../../../src/features/chat/components/McpComposerMenu';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const BASE_SERVER = {
  id: 'srv-1',
  name: 'GitHub',
  slug: 'github',
  transport: 'stdio',
  environmentId: 'local',
  command: 'github-mcp',
  args: [],
  env: {},
  secretEnvNames: [],
  url: null,
  headerNames: [],
  enabled: true,
  timeoutMs: null,
  status: 'connected',
  createdAt: 0,
  updatedAt: 0,
} as const;

const UNSUPPORTED = { status: 404, body: { code: 'UNSUPPORTED', message: 'Not supported' } };

let scenario: ReturnType<typeof createFetchScenario> | undefined;

afterEach(() => {
  scenario?.restore();
  scenario = undefined;
});

function renderMenu() {
  return render(
    <McpComposerMenu chatId="chat-1" onInsertPrompt={jest.fn()} onAttachments={jest.fn()} />
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'MCP' }));
  return user;
}

describe('McpComposerMenu', () => {
  it('titles the panel and says so when every server is tools-only', async () => {
    scenario = createFetchScenario()
      .respondWithJson('GET', '/api/mcp/servers', { body: { servers: [BASE_SERVER] } })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/prompts', UNSUPPORTED)
      .respondWithJson('GET', '/api/mcp/servers/srv-1/resources', UNSUPPORTED)
      .install();
    renderMenu();
    await openMenu();

    expect(
      await screen.findByText('Your MCP servers expose no prompts or resources.')
    ).toBeInTheDocument();
    // The title is the second MCP-prompts text on screen: the trigger's own title
    // is an attribute, so the heading is the only text node with it.
    expect(screen.getByText('MCP prompts and resources')).toBeInTheDocument();
  });

  it('lists the prompts and resources of a server that has them', async () => {
    scenario = createFetchScenario()
      .respondWithJson('GET', '/api/mcp/servers', { body: { servers: [BASE_SERVER] } })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/prompts', {
        body: { prompts: [{ name: 'summarize', description: 'Summarize a PR', arguments: [] }] },
      })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/resources', {
        body: { resources: [{ uri: 'repo://readme', name: 'README' }] },
      })
      .install();
    renderMenu();
    await openMenu();

    expect(await screen.findByText('summarize')).toBeInTheDocument();
    expect(screen.getByText('README')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.queryByText('Your MCP servers expose no prompts or resources.')).toBeNull();
  });

  it('keeps a tools-only server out of the list but not out of the count', async () => {
    scenario = createFetchScenario()
      .respondWithJson('GET', '/api/mcp/servers', {
        body: {
          servers: [
            BASE_SERVER,
            { ...BASE_SERVER, id: 'srv-2', name: 'Tools only', slug: 'tools' },
          ],
        },
      })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/prompts', {
        body: { prompts: [{ name: 'summarize', arguments: [] }] },
      })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/resources', UNSUPPORTED)
      .respondWithJson('GET', '/api/mcp/servers/srv-2/prompts', UNSUPPORTED)
      .respondWithJson('GET', '/api/mcp/servers/srv-2/resources', UNSUPPORTED)
      .install();
    renderMenu();
    await openMenu();

    expect(await screen.findByText('summarize')).toBeInTheDocument();
    expect(screen.queryByText('Tools only')).toBeNull();
    expect(screen.queryByText('Your MCP servers expose no prompts or resources.')).toBeNull();
  });

  // "Exposes no prompts" would be false for a server whose listing failed.
  it('says a listing failed instead of calling it empty, and offers a retry', async () => {
    scenario = createFetchScenario()
      .respondWithJson('GET', '/api/mcp/servers', { body: { servers: [BASE_SERVER] } })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/prompts', {
        status: 502,
        body: { code: 'BAD_GATEWAY', message: 'upstream down' },
      })
      .respondWithJson('GET', '/api/mcp/servers/srv-1/resources', UNSUPPORTED)
      .install();
    renderMenu();
    const user = await openMenu();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load MCP prompts and resources.');
    expect(screen.queryByText('Your MCP servers expose no prompts or resources.')).toBeNull();

    scenario.respondWithJson('GET', '/api/mcp/servers/srv-1/prompts', {
      body: { prompts: [{ name: 'recovered', arguments: [] }] },
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('recovered')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('says the server list failed rather than that it holds nothing', async () => {
    scenario = createFetchScenario()
      .respondWithJson('GET', '/api/mcp/servers', {
        status: 500,
        body: { code: 'INTERNAL_ERROR', message: 'boom' },
      })
      .install();
    renderMenu();
    await openMenu();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load MCP prompts and resources.'
    );
    expect(screen.queryByText('Your MCP servers expose no prompts or resources.')).toBeNull();
  });

  it('holds a placeholder rather than an empty box while the list loads', async () => {
    scenario = createFetchScenario()
      .respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } })
      .install();
    // Hold the answer back so the loading state can be looked at.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const answer = scenario.fetchMock.getMockImplementation();
    scenario.fetchMock.mockImplementation(async (input, init) => {
      await gate;
      return (await answer?.(input, init)) as Response;
    });
    renderMenu();
    await openMenu();

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText('Your MCP servers expose no prompts or resources.')).toBeNull();

    release();
    expect(
      await screen.findByText('Your MCP servers expose no prompts or resources.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  // The form is a modal. It used to open over a menu that stayed up behind it,
  // and a failed insert put its error into that hidden menu.
  describe('a prompt that takes arguments', () => {
    function withArgumentPrompt() {
      scenario = createFetchScenario()
        .respondWithJson('GET', '/api/mcp/servers', { body: { servers: [BASE_SERVER] } })
        .respondWithJson('GET', '/api/mcp/servers/srv-1/prompts', {
          body: {
            prompts: [
              {
                name: 'review',
                arguments: [{ name: 'pr', required: true, description: 'Pull request' }],
              },
            ],
          },
        })
        .respondWithJson('GET', '/api/mcp/servers/srv-1/resources', UNSUPPORTED)
        .install();
    }

    it('closes the menu behind the form it opens', async () => {
      withArgumentPrompt();
      renderMenu();
      const user = await openMenu();

      await user.click(await screen.findByRole('button', { name: /review/ }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByText('MCP prompts and resources')).toBeNull();
    });

    it('lets Escape close the form, not the menu, and says a failed insert in the form', async () => {
      withArgumentPrompt();
      scenario?.respondWithJson('POST', '/api/mcp/servers/srv-1/prompts/resolve', {
        status: 502,
        body: { code: 'BAD_GATEWAY', message: 'upstream down' },
      });
      renderMenu();
      const user = await openMenu();
      await user.click(await screen.findByRole('button', { name: /review/ }));
      const dialog = await screen.findByRole('dialog');

      await user.type(within(dialog).getByRole('textbox'), '42');
      await user.click(within(dialog).getByRole('button', { name: 'Insert' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Could not insert the prompt. Try again.'
      );

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });
});
