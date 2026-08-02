/**
 * Unit tests for McpSettingsPage: list rendering, add/edit form behavior,
 * transport switching, test-connection results, and delete confirmation.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { McpServer } from '@mangostudio/shared/mcp';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsPage } from '../../../src/features/settings/mcp/components/McpSettingsPage';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const STDIO_SERVER: McpServer = {
  id: 'srv-stdio',
  name: 'Everything',
  slug: 'everything',
  transport: 'stdio',
  environmentId: LOCAL_ENVIRONMENT_ID,
  command: 'bunx',
  args: ['@modelcontextprotocol/server-everything'],
  env: {},
  secretEnvNames: [],
  url: null,
  headerNames: [],
  enabled: true,
  timeoutMs: null,
  status: 'connected',
  createdAt: 1,
  updatedAt: 1,
};

const HTTP_SERVER: McpServer = {
  id: 'srv-http',
  name: 'Remote',
  slug: 'remote',
  transport: 'http',
  environmentId: LOCAL_ENVIRONMENT_ID,
  command: null,
  args: [],
  env: {},
  secretEnvNames: [],
  url: 'https://example.com/mcp',
  headerNames: ['Authorization'],
  enabled: true,
  timeoutMs: null,
  status: 'error',
  statusError: 'connect ECONNREFUSED',
  createdAt: 1,
  updatedAt: 1,
};

describe('McpSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows the empty state when no servers exist', async () => {
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } });

    render(<McpSettingsPage />);

    expect(await screen.findByText(/no mcp servers yet/i)).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      status: 500,
      body: { error: 'boom' },
    });

    render(<McpSettingsPage />);

    expect(await screen.findByText(/retry/i)).toBeInTheDocument();
  });

  it('renders server cards with transport chip and status badge', async () => {
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [STDIO_SERVER, HTTP_SERVER] },
    });

    render(<McpSettingsPage />);

    expect(await screen.findByText('Everything')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.getByText('HTTP')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('opens the add form, validates required fields with i18n messages, and shows the stdio trust warning', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } });

    render(<McpSettingsPage />);

    await user.click(await screen.findByRole('button', { name: /add server/i }));

    expect(screen.getByText(/runs as a local process/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Slug is required')).toBeInTheDocument();
    expect(screen.getByText('Command is required')).toBeInTheDocument();
  });

  it('switches transport fields in the form', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } });

    render(<McpSettingsPage />);

    await user.click(await screen.findByRole('button', { name: /add server/i }));

    expect(screen.getByLabelText('Command')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'HTTP' }));

    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toBeInTheDocument();
    expect(screen.getByText(/write-only/i)).toBeInTheDocument();
  });

  it('submits a new stdio server via POST', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers', { status: 201, body: STDIO_SERVER });

    render(<McpSettingsPage />);

    await user.click(await screen.findByRole('button', { name: /add server/i }));
    await user.type(screen.getByLabelText('Name'), 'Everything');
    await user.type(screen.getByLabelText('Slug'), 'everything');
    await user.type(screen.getByLabelText('Command'), 'bunx server');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await vi.waitFor(() => {
      const postCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'POST' && new URL(url, 'http://localhost').pathname === '/api/mcp/servers'
        );
      });
      expect(postCalls.length).toBe(1);
    });
  });

  it('shows masked stored headers when editing an http server', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [HTTP_SERVER] },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Remote');
    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect(screen.getByText('Authorization')).toBeInTheDocument();
    expect(screen.getByText('value saved')).toBeInTheDocument();
    // The stored value itself never appears in an input.
    expect(screen.queryByDisplayValue(/bearer/i)).not.toBeInTheDocument();
  });

  it('runs an explicit connection test and renders the tool count inline', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [STDIO_SERVER] },
    });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: { tools: [] } });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/srv-stdio/test', {
      body: {
        ok: true,
        status: 'connected',
        tools: [
          { name: 'echo', description: '', inputSchema: {} },
          { name: 'add', description: '', inputSchema: {} },
        ],
      },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Everything');
    await user.click(screen.getByRole('button', { name: /^test$/i }));

    expect(await screen.findByText(/2 tools available/i)).toBeInTheDocument();
  });

  it('deletes a server after confirmation', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [STDIO_SERVER] },
    });
    fetchScenario.respondWithJson('DELETE', '/api/mcp/servers/srv-stdio', {
      body: { ok: true },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Everything');
    await user.click(screen.getByRole('button', { name: /delete server/i }));
    // Confirm inside the dialog (its confirm button carries the same label).
    const dialogButtons = screen.getAllByRole('button', { name: /delete server/i });
    await user.click(dialogButtons[dialogButtons.length - 1]);

    await vi.waitFor(() => {
      const deleteCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'DELETE' &&
          new URL(url, 'http://localhost').pathname === '/api/mcp/servers/srv-stdio'
        );
      });
      expect(deleteCalls.length).toBe(1);
    });
  });

  it('previews a stable export for all selected servers', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [STDIO_SERVER] },
    });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/portability/export', {
      body: {
        filename: 'mangostudio-mcp-v1.json',
        content: '{\n  "version": 1\n}\n',
        serverCount: 1,
      },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Everything');
    await user.click(screen.getByRole('button', { name: /^export$/i }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /preview export/i }));

    expect(await screen.findByDisplayValue(/"version": 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download json/i })).toBeInTheDocument();
  });

  it('reviews a conflict, supplies an unresolved secret, and shows the apply summary', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [HTTP_SERVER] },
    });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/portability/import/preview', {
      body: {
        previewToken: 'a'.repeat(64),
        entries: [
          {
            key: 'remote',
            name: 'Remote',
            slug: 'remote',
            transport: 'http',
            environmentId: LOCAL_ENVIRONMENT_ID,
            url: 'https://new.example.com/mcp',
            fingerprint: 'b'.repeat(64),
            status: 'ready',
            conflicts: [
              {
                serverId: 'srv-http',
                name: 'Remote',
                slug: 'remote',
                keys: ['slug', 'name'],
                exact: false,
              },
            ],
            allowedDecisions: ['skip', 'replace', 'copy'],
            suggestedDecision: 'skip',
            copyName: 'Remote copy',
            copySlug: 'remote-copy',
            secretReferences: [
              { kind: 'header', name: 'Authorization', source: 'reference', required: true },
            ],
          },
        ],
      },
    });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/portability/import/apply', {
      body: {
        added: 0,
        replaced: 1,
        copied: 0,
        skipped: 0,
        invalid: 0,
        results: [{ key: 'remote', decision: 'replace', serverId: 'srv-new' }],
      },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Remote');
    await user.click(screen.getByRole('button', { name: /^import$/i }));
    await user.click(screen.getByRole('button', { name: /paste json/i }));
    await user.type(screen.getByLabelText('JSON'), 'source text');
    await user.click(screen.getByRole('button', { name: /^preview$/i }));

    const decision = await screen.findByLabelText('Decision for Remote');
    await user.selectOptions(decision, 'replace');
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeDisabled();
    await user.type(screen.getByLabelText('Secret value for Authorization'), 'destination-token');
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeEnabled();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [HTTP_SERVER] },
    });
    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText('Replaced: 1')).toBeInTheDocument();
    expect(screen.queryByText('destination-token')).not.toBeInTheDocument();
  });

  it('disables replacement targets that cannot free the incoming slug', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [HTTP_SERVER] },
    });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/portability/import/preview', {
      body: {
        previewToken: 'a'.repeat(64),
        entries: [
          {
            key: 'incoming',
            name: 'Incoming',
            slug: 'foo',
            transport: 'http',
            environmentId: LOCAL_ENVIRONMENT_ID,
            url: 'https://match.example.com/mcp',
            fingerprint: 'b'.repeat(64),
            status: 'ready',
            conflicts: [
              {
                serverId: 'srv-url-match',
                name: 'URL match',
                slug: 'bar',
                keys: ['url'],
                exact: false,
                replaceBlockedBySlug: { slug: 'foo', holderName: 'Foo owner' },
              },
              {
                serverId: 'srv-foo-owner',
                name: 'Foo owner',
                slug: 'foo',
                keys: ['slug'],
                exact: false,
              },
            ],
            allowedDecisions: ['skip', 'replace', 'copy'],
            suggestedDecision: 'skip',
            copyName: 'Incoming copy',
            copySlug: 'foo-copy',
            secretReferences: [],
          },
        ],
      },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Remote');
    await user.click(screen.getByRole('button', { name: /^import$/i }));
    await user.click(screen.getByRole('button', { name: /paste json/i }));
    await user.type(screen.getByLabelText('JSON'), 'source text');
    await user.click(screen.getByRole('button', { name: /^preview$/i }));
    await user.selectOptions(await screen.findByLabelText('Decision for Incoming'), 'replace');

    expect(screen.getByRole('combobox', { name: 'Server to replace' })).toHaveValue(
      'srv-foo-owner'
    );
    expect(
      screen.getByRole('option', {
        name: /URL match \(bar\).*will not free slug "foo".*"Foo owner"/,
      })
    ).toBeDisabled();
    expect(
      screen.getByText(
        'Replacing this server will not free slug "foo", which belongs to "Foo owner".'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeEnabled();
  });

  it('lists per-server tools with toggles wired to the tool-settings API', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [STDIO_SERVER] },
    });
    fetchScenario.respondWithJson('GET', '/api/mcp/servers/srv-stdio/tools', {
      body: { tools: [{ name: 'echo', description: 'Echoes input.', inputSchema: {} }] },
    });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: {
        tools: [
          {
            name: 'mcp__everything__echo',
            title: 'Everything: echo',
            description: 'Echoes input.',
            category: 'mcp',
            enabled: false,
            canDisable: true,
            parameters: {},
            parameterDescriptors: [],
          },
        ],
      },
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/tools/mcp__everything__echo', {
      body: {
        name: 'mcp__everything__echo',
        title: 'Everything: echo',
        description: 'Echoes input.',
        category: 'mcp',
        enabled: true,
        canDisable: true,
        parameters: {},
        parameterDescriptors: [],
      },
    });

    render(<McpSettingsPage />);

    await screen.findByText('Everything');
    await user.click(screen.getByRole('button', { name: /show tools/i }));

    expect(await screen.findByText('echo')).toBeInTheDocument();

    const toggle = screen.getByRole('checkbox', { name: 'echo' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await vi.waitFor(() => {
      const putCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'PUT' &&
          new URL(url, 'http://localhost').pathname === '/api/settings/tools/mcp__everything__echo'
        );
      });
      expect(putCalls.length).toBe(1);
    });
  });
});
