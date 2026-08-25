import { describe, expect, it, jest } from 'bun:test';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InputBar } from '../../../src/features/chat/components/InputBar';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

function renderInputBar(overrides: Partial<React.ComponentProps<typeof InputBar>> = {}) {
  const props: React.ComponentProps<typeof InputBar> = {
    onSubmit: jest.fn(),
    ...overrides,
  };
  const result = render(<InputBar {...props} />);
  return { ...result, props };
}

describe('InputBar — chat-only composer', () => {
  /**
   * The status-line props ride to `ComposerChipRow` through a rest spread now,
   * and a spread keeps a key whose value is `undefined` — where a destructuring
   * default would have replaced it. Both of these are dereferenced downstream,
   * so a caller handing over an unsettled query used to be a crash waiting to
   * happen rather than an empty chip.
   */
  it('survives status-line props handed over as explicit undefined', () => {
    renderInputBar({
      agents: undefined,
      activeModels: undefined,
      onSelectedAgentIdChange: jest.fn(),
    });

    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Select agent' })).toBeInTheDocument();
  });

  // The chip row is the only thing that decides this: `ThinkingToggle` used to
  // re-check a `visible` prop its one caller had already gated on, so the state
  // this asserts was unreachable from inside the toggle.
  it('offers no thinking chip when the active model has no reasoning to configure', () => {
    const { unmount } = renderInputBar({
      reasoningVisible: false,
      onThinkingToggle: jest.fn(),
      onReasoningEffortChange: jest.fn(),
    });

    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull();
    unmount();

    renderInputBar({
      reasoningVisible: true,
      onThinkingToggle: jest.fn(),
      onReasoningEffortChange: jest.fn(),
    });

    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument();
  });

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

  it('shows the agent selector only when onSelectedAgentIdChange is provided', () => {
    const { unmount } = renderInputBar({
      selectedAgentId: 'default',
      agents,
    });

    expect(screen.queryByRole('combobox', { name: 'Select agent' })).toBeNull();
    unmount();

    renderInputBar({
      selectedAgentId: 'default',
      agents,
      onSelectedAgentIdChange: jest.fn(),
    });

    // The chip is a button-and-listbox now, so its value is the text it shows
    // rather than a form value.
    expect(screen.getByRole('combobox', { name: 'Select agent' })).toHaveTextContent('Default');
  });

  // The first prompt settles who runs the chat; from then on the chip is a
  // fact, and switching lives in the header as "continue in a new chat".
  it('locks the agent chip once the chat has turns and says why', () => {
    renderInputBar({
      selectedAgentId: 'default',
      agents,
      onSelectedAgentIdChange: jest.fn(),
      hasTurns: true,
    });

    const chip = screen.getByRole('combobox', { name: 'Select agent' });
    expect(chip).toBeDisabled();
    expect(chip.getAttribute('title')).toContain('Locked after the first turn');
  });

  // The env and dir chips moved to the header — the composer's status line
  // must not offer either, whatever workdir the chat carries.
  it('offers no environment or workdir control', () => {
    renderInputBar({ workdir: '/srv/projects/mangostudio' });

    expect(screen.queryByRole('combobox', { name: 'Select execution environment' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Change working directory: mangostudio' })
    ).toBeNull();
  });

  it('does not render a reference image upload button', () => {
    renderInputBar();

    expect(screen.queryByTitle('Add a reference image')).toBeNull();
  });

  it('renders the Create images tool intent button', () => {
    renderInputBar({ onImageToolIntentChange: jest.fn() });

    expect(screen.getByRole('button', { name: 'Create images' })).toBeInTheDocument();
  });

  it('calls onSubmit with the prompt text on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
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
    const onImageToolIntentChange = jest.fn();
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

  it('disables the composer while a steer is in flight, so a later edit cannot be lost', async () => {
    const originalFetch = globalThis.fetch;
    const deferred = Promise.withResolvers<Response>();
    globalThis.fetch = jest.fn(() => deferred.promise) as unknown as typeof fetch;

    try {
      const user = userEvent.setup();
      renderInputBar({
        chatId: 'chat-1',
        runner: EXTERNAL_RUNNER,
        externalDescriptor: steerableDescriptor(),
        isGenerating: true,
        disabled: true,
      });

      await user.type(screen.getByRole('textbox'), 'first correction');
      await user.click(screen.getByRole('button', { name: 'Steer' }));

      // The POST has not resolved yet: the composer must not accept an edit
      // that was never part of what was sent, so it stays disabled rather
      // than letting one in that the eventual clear would then discard.
      await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
      expect(screen.getByRole('textbox')).toHaveValue('first correction');

      deferred.resolve(
        new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
      expect(screen.getByRole('textbox')).toHaveValue('');
    } finally {
      globalThis.fetch = originalFetch;
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

describe('InputBar — external thread usage', () => {
  it('renders cumulative usage from threadUsage next to the composer chrome', () => {
    renderInputBar({
      threadUsage: {
        last: { inputTokens: 1200, outputTokens: 80 },
        total: { totalTokens: 50_000 },
      },
    });

    expect(screen.getByTestId('external-usage')).toBeTruthy();
    expect(screen.getByTestId('external-usage-turn').textContent).toContain('1.2k');
    expect(screen.getByTestId('external-usage-thread').textContent).toContain('50k');
  });

  it('renders nothing when no vendor usage has been reported', () => {
    renderInputBar({});

    expect(screen.queryByTestId('external-usage')).toBeNull();
  });
});

/**
 * The composer acts as the runner, so its frame carries the runner's colour.
 * Asserted at the one property everything else reads rather than at each
 * border and fill, which are CSS and therefore not observable from here.
 */
describe('InputBar — the runner it is dressed as', () => {
  it('hands MangoStudio chats the mango accent, so the default is unchanged', () => {
    renderInputBar({ runner: { kind: 'mangostudio', agentId: 'default' } });

    expect(screen.getByTestId('composer').style.getPropertyValue('--composer-accent')).toBe(
      'var(--color-agent-mango)'
    );
  });

  it('switches the whole frame to the vendor colour for an external runner', () => {
    renderInputBar({ runner: { kind: 'external', targetId: 'codex' } });

    expect(screen.getByTestId('composer').style.getPropertyValue('--composer-accent')).toBe(
      'var(--color-agent-codex)'
    );
  });

  it('names the vendor in the placeholder, and only the vendor', () => {
    const { unmount } = renderInputBar({ runner: { kind: 'external', targetId: 'claude' } });
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Message Claude Code…');
    unmount();

    // MangoStudio's own runner has no product name to say back, so it keeps
    // the generic prompt.
    renderInputBar({ runner: { kind: 'mangostudio', agentId: 'default' } });
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'Ask the AI model anything...'
    );
  });
});
