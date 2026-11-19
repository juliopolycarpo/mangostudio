/**
 * The composer's built-in slash commands (issue #2599), as a user drives them:
 * typed, Entered, and answered by an action rather than by a message to the
 * model. What each test pins is that nothing reaches `onSubmit` when a built-in
 * runs, and that a built-in that cannot run is ordinary text.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import type { ModelOption } from '@mangostudio/shared/catalog';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InputBar } from '../../../src/features/chat/components/InputBar';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const NATIVE: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: 'default' };

const MODELS: ModelOption[] = [
  {
    modelId: 'gpt-5',
    resourceName: 'models/gpt-5',
    displayName: 'GPT-5',
    supportedActions: [],
    provider: 'openai',
  },
  {
    modelId: 'gpt-5-mini',
    resourceName: 'models/gpt-5-mini',
    displayName: 'GPT-5 mini',
    supportedActions: [],
    provider: 'openai',
  },
  {
    modelId: 'gemini-2.5-pro',
    resourceName: 'models/gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    supportedActions: [],
    provider: 'gemini',
  },
];

const scenario = createFetchScenario();

beforeEach(() => {
  scenario.install();
  scenario.respondWithJson('GET', '/api/library/resources?kind=command', {
    body: { resources: [], unreadableEntries: [] },
  });
  scenario.respondWithJson('GET', '/api/skills', {
    body: {
      skills: [],
      sources: {
        agents: { enabled: false, path: '/agents', exists: false },
        claude: { enabled: false, path: '/claude', exists: false },
      },
    },
  });
});

afterEach(() => {
  scenario.restore();
});

/** `chatId` varies per test: prompt history is a module-level store keyed by it. */
function renderComposer(
  chatId: string | null,
  overrides: Partial<React.ComponentProps<typeof InputBar>> = {}
) {
  const onSubmit = jest.fn();
  const onNewChat = jest.fn();
  const onModelChange = jest.fn();
  render(
    <InputBar
      onSubmit={onSubmit}
      onNewChat={onNewChat}
      onModelChange={onModelChange}
      chatId={chatId}
      runner={NATIVE}
      activeModels={MODELS}
      activeModel="gpt-5"
      {...overrides}
    />
  );
  return { onSubmit, onNewChat, onModelChange, user: userEvent.setup() };
}

describe('composer built-in slash commands', () => {
  it('lists the built-ins first, labelled as built in', async () => {
    const { user } = renderComposer('builtin-list');
    await user.type(screen.getByRole('textbox'), '/');

    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('/clear'),
      expect.stringContaining('/model'),
    ]);
    expect(options[0]).toHaveTextContent('built-in');
  });

  it('starts a new chat on /clear instead of sending it to the model', async () => {
    const { onSubmit, onNewChat, user } = renderComposer('builtin-clear');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/clear');
    await user.keyboard('{Enter}');

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('');
  });

  it('switches the model on /model <name>, matching a fragment of its name', async () => {
    const { onSubmit, onModelChange, user } = renderComposer('builtin-model');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/model 5-m');
    await user.keyboard('{Enter}');

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith('gpt-5-mini');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('');
    expect(await screen.findByText('Model set to GPT-5 mini.')).toBeInTheDocument();
  });

  it('keeps the text and says so when no model matches', async () => {
    const { onSubmit, onModelChange, user } = renderComposer('builtin-model-none');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/model claude');
    await user.keyboard('{Enter}');

    expect(onModelChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('/model claude');
    expect(await screen.findByText('No model matches “claude”.')).toBeInTheDocument();
  });

  it('refuses an ambiguous name rather than picking one', async () => {
    const { onModelChange, user } = renderComposer('builtin-model-ambiguous');
    await user.type(screen.getByRole('textbox'), '/model gpt');
    await user.keyboard('{Enter}');

    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/“gpt” fits more than one model: GPT-5, GPT-5 mini\./)
    ).toBeInTheDocument();
  });

  it('names the current model when /model has no argument', async () => {
    const { onModelChange, user } = renderComposer('builtin-model-usage');
    await user.type(screen.getByRole('textbox'), '/model');
    await user.keyboard('{Enter}');

    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Name the model to switch to: /model <name>. Current model: GPT-5.')
    ).toBeInTheDocument();
  });

  it('leaves /model as ordinary text when the composer has no chat to switch', async () => {
    const { onSubmit, onModelChange, user } = renderComposer(null);
    await user.type(screen.getByRole('textbox'), '/model mini');
    await user.keyboard('{Enter}');

    expect(onModelChange).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('/model mini', undefined);
  });

  it('sends /clear as the vendor’s own text for an external runner', async () => {
    const { onSubmit, onNewChat, user } = renderComposer('builtin-external', {
      runner: { kind: 'external', targetId: 'codex' },
      externalDescriptor: {
        targetId: 'codex',
        environmentId: 'local',
        installed: true,
        authState: 'signed-in',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: [],
      },
    });
    await user.type(screen.getByRole('textbox'), '/clear');
    await user.keyboard('{Enter}');

    expect(onNewChat).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('/clear', undefined);
  });
});
