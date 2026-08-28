/**
 * The palette as the composer drives it: caret, keyboard, and what lands in
 * the textarea. The ranking and the caret arithmetic are covered as pure
 * functions in `features/chat/slash-commands.test.ts`; what this file is for is
 * the wiring those functions cannot prove — that Enter completes instead of
 * sending, and that a slash which is not the first character sends as prose.
 */

import { describe, expect, it, jest } from 'bun:test';
import type {
  ExternalAgentCommand,
  ExternalAgentDescriptor,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { useQueryClient } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { InputBar } from '../../../src/features/chat/components/InputBar';
import { publishExternalCommands } from '../../../src/features/external-agents/command-catalog';
import { render } from '../../support/harness/render';

const CHAT_ID = 'chat-1';
const RUNNER = { kind: 'external', targetId: 'cursor' } as const;

const DESCRIPTOR: ExternalAgentDescriptor = {
  targetId: 'cursor',
  environmentId: 'local',
  installed: true,
  authState: 'signed-in',
  capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
  supportedConfigurations: [],
};

const CATALOG: readonly ExternalAgentCommand[] = [
  { name: 'test-command', description: 'Accessibility Audit (user)' },
  { name: 'autopilot', description: 'Keep a PR merge-ready. (builtin skill)' },
];

/**
 * Files the catalog the way a turn's stream does — after mount, through the
 * query client — so the palette is exercised on the same path a real session
 * takes rather than on a prop nothing writes.
 */
function ComposerWithCatalog(props: React.ComponentProps<typeof InputBar>) {
  const queryClient = useQueryClient();
  useEffect(() => {
    publishExternalCommands(queryClient, CHAT_ID, CATALOG);
  }, [queryClient]);
  return <InputBar {...props} />;
}

function renderComposer() {
  const onSubmit = jest.fn();
  render(
    <ComposerWithCatalog
      onSubmit={onSubmit}
      chatId={CHAT_ID}
      runner={RUNNER}
      externalDescriptor={DESCRIPTOR}
    />
  );
  return { onSubmit, user: userEvent.setup() };
}

describe('composer slash palette', () => {
  it('offers the session’s own commands, skills included', async () => {
    const { user } = renderComposer();
    await user.type(screen.getByRole('textbox'), '/');

    expect(await screen.findByRole('option', { name: /test-command/ })).toBeInTheDocument();
    // Cursor publishes its builtin skills as commands, which is what makes
    // skills invocable here without a second source.
    expect(screen.getByRole('option', { name: /autopilot/ })).toBeInTheDocument();
  });

  it('narrows to what the user has typed', async () => {
    const { user } = renderComposer();
    await user.type(screen.getByRole('textbox'), '/auto');

    expect(await screen.findByRole('option', { name: /autopilot/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /test-command/ })).toBeNull();
  });

  it('completes on Enter instead of sending the half-typed name', async () => {
    const { onSubmit, user } = renderComposer();
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/auto');
    await screen.findByRole('option', { name: /autopilot/ });
    await user.keyboard('{Enter}');

    expect(textbox).toHaveValue('/autopilot ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends on the Enter after the command has been chosen', async () => {
    const { onSubmit, user } = renderComposer();
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/auto');
    await screen.findByRole('option', { name: /autopilot/ });
    await user.keyboard('{Enter}');
    await user.keyboard('the branch{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('/autopilot the branch', undefined);
  });

  it('walks the list with the arrows rather than the prompt history', async () => {
    const { user } = renderComposer();
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/');
    await screen.findByRole('option', { name: /test-command/ });
    await user.keyboard('{ArrowDown}{Enter}');

    expect(textbox).toHaveValue('/autopilot ');
  });

  it('closes on Escape and leaves the typed text alone', async () => {
    const { user } = renderComposer();
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/auto');
    await screen.findByRole('option', { name: /autopilot/ });
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('option')).toBeNull();
    expect(textbox).toHaveValue('/auto');
  });

  /**
   * Neither CLI expands a slash that is not the first character, so a palette
   * over one would complete a name the agent reads as ordinary prose.
   */
  it('stays shut for a slash in the middle of a sentence', async () => {
    const { user } = renderComposer();
    await user.type(screen.getByRole('textbox'), 'run the /auto');

    expect(screen.queryByRole('option')).toBeNull();
  });
});
