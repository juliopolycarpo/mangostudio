import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { AgentSettingsPage } from '../../../src/features/settings/agents/components/AgentSettingsPage';

const AGENTS_RESPONSE = {
  agents: [
    {
      id: 'chat',
      name: 'Chat',
      description: 'General-purpose chat.',
      kind: 'builtin',
      role: 'primary',
      source: { type: 'builtin' },
      systemPrompt: 'Chat prompt.',
      toolNames: ['read_file'],
      toolsEnabled: true,
      subagentIds: [],
      metadata: {},
    },
    {
      id: 'default',
      name: 'Default',
      description: 'Default task agent.',
      kind: 'builtin',
      role: 'both',
      source: { type: 'builtin' },
      systemPrompt: '',
      toolNames: [],
      toolsEnabled: true,
      subagentIds: [],
      metadata: {},
    },
    {
      id: 'user:researcher',
      name: 'Researcher',
      description: 'Finds useful context.',
      kind: 'user',
      role: 'subagent',
      source: { type: 'markdown', path: '/home/user/.mango/agents/researcher.md' },
      systemPrompt: 'Research first.',
      toolNames: ['read_file'],
      toolsEnabled: true,
      subagentIds: [],
      metadata: {},
    },
  ],
};

const TOOLS_RESPONSE = {
  tools: [
    {
      name: 'read_file',
      title: 'Read File',
      description: 'Read files.',
      category: 'system',
      enabled: true,
      canDisable: true,
      parameters: {},
      parameterDescriptors: [],
    },
  ],
} as const;

describe('AgentSettingsPage integration', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('loads agents through TanStack Query', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    expect(await screen.findByRole('button', { name: /chat/i })).toBeInTheDocument();
  });

  it('saves built-in agent edits', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });
    fetchScenario.respondWithJson('PUT', '/api/settings/agents/chat', {
      body: { ...AGENTS_RESPONSE.agents[0], systemPrompt: 'Updated chat prompt.' },
    });

    render(<AgentSettingsPage />);

    const systemPrompt = await screen.findByLabelText('System Prompt');
    await user.clear(systemPrompt);
    await user.type(systemPrompt, 'Updated chat prompt.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(hasFetchCall('PUT', '/api/settings/agents/chat')).toBe(true));
  });

  it('creates a markdown-backed user agent', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });
    fetchScenario.respondWithJson('POST', '/api/settings/agents', {
      body: {
        ...AGENTS_RESPONSE.agents[2],
        id: 'user:writer',
        name: 'Writer',
      },
    });

    render(<AgentSettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Create Agent' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('File Slug'), 'writer');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(hasFetchCall('POST', '/api/settings/agents')).toBe(true));
  });

  it('deletes a user agent with confirmation', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });
    fetchScenario.respondWithJson('DELETE', '/api/settings/agents/user:researcher', {
      body: { success: true },
    });

    render(<AgentSettingsPage />);

    await user.click(await screen.findByRole('button', { name: /researcher/i }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete agent' }));

    await waitFor(() =>
      expect(hasFetchCall('DELETE', '/api/settings/agents/user:researcher')).toBe(true)
    );
  });

  it('displays API validation errors', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });
    fetchScenario.respondWithJson('POST', '/api/settings/agents', {
      status: 422,
      body: { error: 'Agent name must produce a non-empty slug.', code: 'VALIDATION' },
    });

    render(<AgentSettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Create Agent' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Agent name must produce a non-empty slug.')
    ).toBeInTheDocument();
  });

  function hasFetchCall(method: string, path: string): boolean {
    return fetchScenario.fetchMock.mock.calls.some((call: readonly unknown[]) => {
      const input = call[0];
      const init = call[1] as RequestInit | undefined;
      const requestMethod = input instanceof Request ? input.method : init?.method;
      const url = input instanceof Request ? input.url : String(input);
      return requestMethod === method && new URL(url, 'http://localhost').pathname === path;
    });
  }
});
