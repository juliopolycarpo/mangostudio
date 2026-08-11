import type { Environment } from '@mangostudio/shared/environments';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen, waitFor } from '@testing-library/react';
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
  it('shows the agent selector only when onSelectedAgentIdChange is provided', () => {
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
      selectedAgentId: 'default',
      agents,
    });

    expect(screen.queryByRole('combobox', { name: 'Select agent' })).toBeNull();
    unmount();

    renderInputBar({
      selectedAgentId: 'default',
      agents,
      onSelectedAgentIdChange: vi.fn(),
    });

    expect(screen.getByRole('combobox', { name: 'Select agent' })).toHaveValue('default');
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
      // The pill renders before the listing lands, wearing the `disconnected`
      // fallback and an option built from the id alone, so the connected state
      // is only meaningful once the fetched environment backs it.
      await waitFor(() =>
        expect(screen.getByTestId('environment-selector')).toHaveAttribute(
          'data-state',
          'connected'
        )
      );
      await user.selectOptions(selector, 'remote-dev');

      expect(onEnvironmentChange).toHaveBeenCalledWith('remote-dev');
    } finally {
      scenario.restore();
    }
  });

  it('shows the active workdir basename and reopens the picker', async () => {
    const user = userEvent.setup();
    const onWorkdirClick = vi.fn();
    renderInputBar({
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

/**
 * A persisted external runner outlives the conditions that made it selectable.
 * The composer has to notice, because the descriptor is the only thing that
 * knows and nothing else in here reads it.
 */
describe('InputBar — an external runner that cannot host a turn', () => {
  const EXTERNAL_RUNNER = { kind: 'external', targetId: 'codex' } as const;

  function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
    return {
      targetId: 'codex',
      environmentId: 'local',
      installed: true,
      authState: 'signed-in',
      capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
      supportedConfigurations: [],
      ...overrides,
    };
  }

  it('blocks the composer while discovery has not answered yet', () => {
    renderInputBar({ runner: EXTERNAL_RUNNER, externalDescriptor: undefined });

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/cannot run here right now/i);
  });

  it('names the reason a discovered agent cannot run', () => {
    renderInputBar({
      runner: EXTERNAL_RUNNER,
      externalDescriptor: descriptor({ installed: false, unavailableReason: 'not-installed' }),
    });

    expect(screen.getByRole('status')).toHaveTextContent(/not installed on this machine/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('blocks a runner whose agent has signed out since it was chosen', () => {
    renderInputBar({
      runner: EXTERNAL_RUNNER,
      externalDescriptor: descriptor({ authState: 'signed-out' }),
    });

    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('leaves the composer alone when the agent can host a turn', async () => {
    const user = userEvent.setup();
    const { props } = renderInputBar({
      runner: EXTERNAL_RUNNER,
      externalDescriptor: descriptor(),
    });

    await user.type(screen.getByRole('textbox'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.queryByRole('status')).toBeNull();
    expect(props.onSubmit).toHaveBeenCalledWith('hello', undefined);
  });

  it('leaves a MangoStudio runner alone whatever discovery says', () => {
    renderInputBar({ runner: { kind: 'mangostudio', agentId: 'default' } });

    expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/**
 * Codex only. The composer's default while generating — disabled, one Stop
 * button — must hold for every other runner; only a session whose adapter
 * capabilities say `steering: true` gets the affordance at all.
 */
describe('InputBar — mid-turn steering', () => {
  const EXTERNAL_RUNNER = { kind: 'external', targetId: 'codex' } as const;

  function steerableDescriptor(): ExternalAgentDescriptor {
    return {
      targetId: 'codex',
      environmentId: 'local',
      installed: true,
      authState: 'signed-in',
      capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, steering: true },
      supportedConfigurations: [],
    };
  }

  it('keeps the input enabled and offers a distinct Steer button while a steerable turn runs', () => {
    renderInputBar({
      runner: EXTERNAL_RUNNER,
      externalDescriptor: steerableDescriptor(),
      isGenerating: true,
      disabled: true,
    });

    expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Steer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('disables the composer as usual while generating on an adapter that cannot steer', () => {
    renderInputBar({
      runner: EXTERNAL_RUNNER,
      externalDescriptor: {
        ...steerableDescriptor(),
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
      },
      isGenerating: true,
      disabled: true,
    });

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('disables the composer as usual while generating on a MangoStudio runner', () => {
    renderInputBar({
      runner: { kind: 'mangostudio', agentId: 'default' },
      isGenerating: true,
      disabled: true,
    });

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
  });

  it('posts a steer and clears the composer', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('POST', '/api/chats/chat-1/external-agent/steer', {
        body: { accepted: true },
      })
      .install();

    try {
      const user = userEvent.setup();
      renderInputBar({
        chatId: 'chat-1',
        runner: EXTERNAL_RUNNER,
        externalDescriptor: steerableDescriptor(),
        isGenerating: true,
        disabled: true,
      });

      await user.type(screen.getByRole('textbox'), 'actually use the existing helper');
      await user.click(screen.getByRole('button', { name: 'Steer' }));

      // Clearing the input is downstream of the POST resolving, so it already
      // proves the request reached this scenario's one registered route; this
      // also pins the body it carried.
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
      expect(scenario.fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = scenario.fetchMock.mock.calls[0] as [unknown, RequestInit | undefined];
      expect(JSON.parse(String(init?.body))).toEqual({
        clientMessageId: expect.any(String),
        text: 'actually use the existing helper',
      });
    } finally {
      scenario.restore();
    }
  });

  it('shows the rejection reason inline when the server refuses', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('POST', '/api/chats/chat-1/external-agent/steer', {
        status: 409,
        body: { accepted: false, reasonCode: 'turn-not-steerable' },
      })
      .install();

    try {
      const user = userEvent.setup();
      renderInputBar({
        chatId: 'chat-1',
        runner: EXTERNAL_RUNNER,
        externalDescriptor: steerableDescriptor(),
        isGenerating: true,
        disabled: true,
      });

      await user.type(screen.getByRole('textbox'), 'switch to plan mode');
      await user.click(screen.getByRole('button', { name: 'Steer' }));

      expect(await screen.findByRole('status')).toHaveTextContent(
        /cannot take new input right now/i
      );
    } finally {
      scenario.restore();
    }
  });
});
