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
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { InputBar } from '../../../src/features/chat/components/InputBar';
import { setComposerDraft } from '../../../src/features/chat/lib/composer-draft-store';
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
  const chatId = props.chatId ?? CHAT_ID;
  useEffect(() => {
    publishExternalCommands(queryClient, chatId, CATALOG);
  }, [queryClient, chatId]);
  return <InputBar {...props} />;
}

/**
 * `chatId` is a parameter because prompt history is a module-level store keyed
 * by it: a test that sends anything would otherwise inherit whatever an earlier
 * test in this file sent, and recall the wrong entry.
 */
function renderComposer(chatId: string = CHAT_ID) {
  const onSubmit = jest.fn();
  const view = render(
    <ComposerWithCatalog
      onSubmit={onSubmit}
      chatId={chatId}
      runner={RUNNER}
      externalDescriptor={DESCRIPTOR}
    />
  );
  const rerenderWithChat = (nextChatId: string) =>
    view.rerender(
      <ComposerWithCatalog
        onSubmit={onSubmit}
        chatId={nextChatId}
        runner={RUNNER}
        externalDescriptor={DESCRIPTOR}
      />
    );
  return { onSubmit, rerenderWithChat, user: userEvent.setup() };
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

  /**
   * The name is already typed, so there is nothing to complete and the palette
   * has no claim on Enter. Completing it to itself would cost a second Enter
   * for every command a user knows by heart — and, worse, hand the keystroke to
   * whichever *other* entry the list happened to rank first.
   */
  it('sends rather than re-completing a name that is already typed in full', async () => {
    const { onSubmit, user } = renderComposer('chat-exact');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/autopilot');
    await screen.findByRole('option', { name: /autopilot/ });
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('/autopilot', undefined);
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

  /**
   * The pointer path, which the keyboard tests never touch: the list answers
   * `mousedown` with `preventDefault` so the composer keeps focus, and the
   * padding around a row belongs to the container rather than to the row — a
   * press there must not blur the textarea and take the menu down mid-click.
   */
  it('completes a row the pointer picks, and survives a press on the panel itself', async () => {
    const { onSubmit, user } = renderComposer('chat-pointer');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/');

    const list = await screen.findByRole('listbox');
    fireEvent.mouseDown(list);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /autopilot/ }));
    expect(textbox).toHaveValue('/autopilot ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * The composer is not remounted when the chat changes — `useComposerDraft`
   * swaps the text under whatever caret the palette was tracking. A draft that
   * happens to start with `/` would otherwise be met by a menu nobody opened,
   * holding the arrows and Enter over a prompt the user has not touched.
   */
  it('drops the palette when the chat under the composer changes', async () => {
    const { rerenderWithChat, user } = renderComposer('chat-switch-a');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/aut');
    await screen.findByRole('option', { name: /autopilot/ });

    setComposerDraft('chat-switch-b', '/autopilot the branch');
    rerenderWithChat('chat-switch-b');

    expect(textbox).toHaveValue('/autopilot the branch');
    expect(screen.queryByRole('option')).toBeNull();
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

  /**
   * The palette can open without the user asking for it: prompt history
   * recalls a bare command, the caret lands inside it, and the menu appears.
   * Taking ↑ there parks the user on a recalled prompt with no way back.
   */
  it('leaves the arrows to prompt history while it is walking it', async () => {
    const { user } = renderComposer('chat-history');
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;

    await user.type(textbox, 'hello{Enter}');
    // The trailing space closes the palette by moving the caret out of the
    // command token, so this Enter sends rather than completing.
    await user.type(textbox, '/autopilot {Enter}');
    expect(textbox).toHaveValue('');

    // Trimmed on the way into history, so what comes back is a bare command
    // with the caret free to land inside it.
    await user.type(textbox, '{ArrowUp}');
    expect(textbox).toHaveValue('/autopilot');

    // Putting the caret back inside the recalled command is what opens a
    // palette the user never asked for. Driven with `fireEvent` rather than
    // `user.type`, which would click first and put the caret back at the end.
    textbox.setSelectionRange(10, 10);
    fireEvent.select(textbox);
    await screen.findByRole('option', { name: /autopilot/ });

    // Walking further back must still work.
    fireEvent.keyDown(textbox, { key: 'ArrowUp' });
    expect(textbox).toHaveValue('hello');
  });

  /**
   * A path is a common opening token, and a palette over one would both cover
   * the composer and take the arrow keys the prompt history needs.
   */
  it('leaves the arrows alone while the user types a leading path', async () => {
    const { onSubmit, user } = renderComposer();
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/home/me/repo is broken');

    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('/home/me/repo is broken', undefined);
  });

  /**
   * A name that matches nothing still says so, but the arrows stay the prompt
   * history's — a menu with nothing in it has nothing to walk.
   */
  it('reports no match without taking the keyboard', async () => {
    const { onSubmit, user } = renderComposer();
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/nope');

    expect(await screen.findByText('No command matches.')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('/nope', undefined);
  });

  /**
   * The first `/` of a session, before any source has answered: no catalog has
   * been announced yet and the library scan is walking directories on whichever
   * machine the chat runs on. Enter there used to fall straight through to
   * submit and send `/auto` as prose — a beat before `/autopilot` would have
   * been offered, and to an agent that reads it as an ordinary sentence.
   *
   * Rendered without `ComposerWithCatalog` on purpose: a published catalog is
   * the one thing that would give this query a match to complete.
   */
  it('holds Enter while a source is still answering', async () => {
    const onSubmit = jest.fn();
    const originalFetch = globalThis.fetch;
    // Never resolved, so the scan is in flight for the whole test.
    const scanInFlight = Promise.withResolvers<Response>();
    globalThis.fetch = (() => scanInFlight.promise) as unknown as typeof fetch;
    try {
      render(
        <InputBar
          onSubmit={onSubmit}
          chatId="chat-loading"
          runner={RUNNER}
          externalDescriptor={DESCRIPTOR}
        />
      );
      const user = userEvent.setup();
      const textbox = screen.getByRole('textbox');
      await user.type(textbox, '/auto');

      expect(await screen.findByText('Looking for commands...')).toBeInTheDocument();
      await user.keyboard('{Enter}');

      expect(onSubmit).not.toHaveBeenCalled();
      expect(textbox).toHaveValue('/auto');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
