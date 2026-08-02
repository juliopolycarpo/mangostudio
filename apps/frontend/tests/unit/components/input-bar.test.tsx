import type { Environment } from '@mangostudio/shared/environments';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InputBar } from '../../../src/features/chat/components/InputBar';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

function renderInputBar(overrides: Partial<React.ComponentProps<typeof InputBar>> = {}) {
  const props: React.ComponentProps<typeof InputBar> = {
    onSubmit: vi.fn(),
    ...overrides,
  };
  const result = render(<InputBar {...props} />);
  return { ...result, props };
}

describe('InputBar — chat-only composer', () => {
  it('renders the Chat and Agent mode segmented control when mode callbacks are provided', () => {
    renderInputBar({ onAgentExecutionModeChange: vi.fn() });

    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agent' })).toBeInTheDocument();
  });

  it('shows the agent selector only in Agent mode', () => {
    const agents = [
      {
        id: 'default',
        name: 'Default',
        description: '',
        kind: 'builtin',
        role: 'primary',
        source: { type: 'builtin' },
        systemPrompt: '',
        toolNames: [],
        toolsEnabled: false,
        subagentIds: [],
        metadata: {},
      },
    ] as const;

    const { unmount } = renderInputBar({
      agentExecutionMode: 'chat',
      selectedAgentId: 'default',
      agents,
      onAgentExecutionModeChange: vi.fn(),
      onSelectedAgentIdChange: vi.fn(),
    });

    expect(screen.queryByRole('combobox', { name: 'Select agent' })).toBeNull();
    unmount();

    renderInputBar({
      agentExecutionMode: 'agent',
      selectedAgentId: 'default',
      agents,
      onAgentExecutionModeChange: vi.fn(),
      onSelectedAgentIdChange: vi.fn(),
    });

    expect(screen.getByRole('combobox', { name: 'Select agent' })).toHaveValue('default');
  });

  it('switches to Agent mode from the segmented control', async () => {
    const user = userEvent.setup();
    const onAgentExecutionModeChange = vi.fn();
    renderInputBar({ onAgentExecutionModeChange });

    await user.click(screen.getByRole('button', { name: 'Agent' }));

    expect(onAgentExecutionModeChange).toHaveBeenCalledWith('agent');
  });

  it('changes the chat execution environment from the composer pill', async () => {
    const scenario = createFetchScenario();
    const environments: Environment[] = [
      {
        id: 'local',
        name: 'Local',
        transportKind: 'in-process',
        config: {},
        enabled: true,
        allowInstalls: false,
        virtual: true,
        createdAt: null,
        updatedAt: null,
        status: { state: 'connected' },
      },
      {
        id: 'remote-dev',
        name: 'Remote dev',
        transportKind: 'ssh',
        config: { host: 'dev.example.test' },
        enabled: true,
        allowInstalls: false,
        virtual: false,
        createdAt: 1,
        updatedAt: 1,
        status: { state: 'disconnected' },
      },
    ];
    scenario.respondWithJson('GET', '/api/environments', { body: environments }).install();

    try {
      const user = userEvent.setup();
      const onEnvironmentChange = vi.fn().mockResolvedValue(undefined);
      renderInputBar({
        chatId: 'chat-1',
        environmentId: 'local',
        onEnvironmentChange,
      });

      const selector = await screen.findByRole('combobox', {
        name: 'Select execution environment',
      });
      expect(selector).toHaveValue('local');
      expect(screen.getByTestId('environment-selector')).toHaveAttribute('data-state', 'connected');
      await user.selectOptions(selector, 'remote-dev');

      expect(onEnvironmentChange).toHaveBeenCalledWith('remote-dev');
    } finally {
      scenario.restore();
    }
  });

  it('shows the active workdir basename in Agent mode and reopens the picker', async () => {
    const user = userEvent.setup();
    const onWorkdirClick = vi.fn();
    renderInputBar({
      agentExecutionMode: 'agent',
      workdir: '/srv/projects/mangostudio',
      onWorkdirClick,
    });

    const button = screen.getByRole('button', { name: 'Change working directory: mangostudio' });
    expect(button).toHaveAttribute('title', '/srv/projects/mangostudio');
    await user.click(button);

    expect(onWorkdirClick).toHaveBeenCalledOnce();
  });

  it('does not render a reference image upload button', () => {
    renderInputBar();

    expect(screen.queryByTitle('Add a reference image')).toBeNull();
  });

  it('renders the Create images tool intent button', () => {
    renderInputBar({ onImageToolIntentChange: vi.fn() });

    expect(screen.getByRole('button', { name: 'Create images' })).toBeInTheDocument();
  });

  it('calls onSubmit with the prompt text on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderInputBar({ onSubmit });

    await user.type(screen.getByRole('textbox'), 'hello world');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSubmit).toHaveBeenCalledWith('hello world', undefined);
  });

  it('renders a Stop button instead of Send when generating', () => {
    renderInputBar({ isGenerating: true });

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('toggles the Create images button active state', async () => {
    const user = userEvent.setup();
    const onImageToolIntentChange = vi.fn();
    renderInputBar({ imageToolIntent: false, onImageToolIntentChange });

    await user.click(screen.getByRole('button', { name: 'Create images' }));

    expect(onImageToolIntentChange).toHaveBeenCalledWith(true);
  });

  it('disables submit when prompt is empty', () => {
    renderInputBar();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('disables submit when submitDisabled is true', async () => {
    const user = userEvent.setup();
    renderInputBar({ submitDisabled: true });

    await user.type(screen.getByRole('textbox'), 'hello');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
