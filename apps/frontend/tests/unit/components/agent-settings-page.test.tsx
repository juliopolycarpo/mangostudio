import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSettingsPage } from '../../../src/features/settings/agents/components/AgentSettingsPage';
import { AgentToolPicker } from '../../../src/features/settings/agents/components/AgentToolPicker';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

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
    {
      name: 'list_directory',
      title: 'List Directory',
      description: 'List directories.',
      category: 'system',
      enabled: true,
      canDisable: true,
      parameters: {},
      parameterDescriptors: [],
    },
  ],
} as const;

describe('AgentSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('renders Chat, Default, and user agents', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    expect(await screen.findByRole('button', { name: /chat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /default/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /researcher/i })).toBeInTheDocument();
  });

  it('does not render markdown controls for built-in agents', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    await screen.findByRole('heading', { name: 'Chat' });

    expect(screen.queryByRole('button', { name: 'Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Path')).not.toBeInTheDocument();
  });

  it('renders markdown controls for user agents', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    await user.click(await screen.findByRole('button', { name: /researcher/i }));

    expect(screen.getByRole('button', { name: 'Markdown' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('/home/user/.mango/agents/researcher.md')).toBeInTheDocument();
  });

  it('exposes Primary, Subagent, and Both role options', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    const roleSelect = await screen.findByLabelText('Role');
    expect(roleSelect).toHaveTextContent('Primary');
    expect(roleSelect).toHaveTextContent('Subagent');
    expect(roleSelect).toHaveTextContent('Both');
  });

  it('starts a draft agent from the populated header action', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: AGENTS_RESPONSE });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Create Agent' }));

    expect(screen.getByRole('heading', { name: 'New Agent' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('New Agent')).toBeInTheDocument();
  });

  it('starts a draft agent from the empty state action', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/settings/agents', { body: { agents: [] } });
    fetchScenario.respondWithJson('GET', '/api/settings/tools', { body: TOOLS_RESPONSE });

    render(<AgentSettingsPage />);

    await screen.findByText('No agents yet');
    await user.click(screen.getAllByRole('button', { name: 'Create Agent' })[1]);

    expect(screen.getByRole('heading', { name: 'New Agent' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('New Agent')).toBeInTheDocument();
  });
});

describe('AgentToolPicker', () => {
  it('calls update callback with selected tool names', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <AgentToolPicker
        label="Allowed Tools"
        disabledLabel="No tools available."
        tools={TOOLS_RESPONSE.tools}
        selectedToolNames={['read_file']}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole('checkbox', { name: /list directory/i }));

    expect(onChange).toHaveBeenCalledWith(['read_file', 'list_directory']);
  });
});
