/**
 * The composer's editing surface: multi-line input, drafts that survive a chat
 * switch, prompt recall, and paste-to-attach. Chip behaviour lives in
 * `input-bar.test.tsx`.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { ChatAttachment } from '@mangostudio/shared/chat';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InputBar } from '../../../src/features/chat/components/InputBar';
import {
  requestComposerFocus,
  setComposerDraft,
} from '../../../src/features/chat/lib/composer-draft-store';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

function renderComposer(overrides: Partial<React.ComponentProps<typeof InputBar>> = {}) {
  const props: React.ComponentProps<typeof InputBar> = { onSubmit: jest.fn(), ...overrides };
  return { ...render(<InputBar {...props} />), props };
}

describe('composer editing', () => {
  it('sends on Enter and breaks the line on Shift+Enter', async () => {
    const user = userEvent.setup();
    const { props } = renderComposer({ chatId: 'chat-1' });
    const box = screen.getByRole('textbox');

    await user.type(box, 'first line{Shift>}{Enter}{/Shift}second line');
    expect(box).toHaveValue('first line\nsecond line');
    expect(props.onSubmit).not.toHaveBeenCalled();

    await user.type(box, '{Enter}');
    expect(props.onSubmit).toHaveBeenCalledWith('first line\nsecond line', undefined);
  });

  it('keeps an unsent draft per chat when the composer is repointed', async () => {
    const user = userEvent.setup();
    const { rerender } = renderComposer({ chatId: 'chat-1' });

    await user.type(screen.getByRole('textbox'), 'half a thought');
    rerender(<InputBar onSubmit={jest.fn()} chatId="chat-2" />);
    expect(screen.getByRole('textbox')).toHaveValue('');

    rerender(<InputBar onSubmit={jest.fn()} chatId="chat-1" />);
    expect(screen.getByRole('textbox')).toHaveValue('half a thought');
  });

  it('takes text written into the draft store from outside, and focuses itself', () => {
    renderComposer({ chatId: 'chat-1' });

    // The store notification is a React state update, so it belongs inside
    // `act` exactly as a click would.
    act(() => {
      setComposerDraft('chat-1', 'Review my uncommitted changes');
      requestComposerFocus();
    });

    expect(screen.getByRole('textbox')).toHaveValue('Review my uncommitted changes');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('walks the chat\u2019s sent prompts with the arrow keys and back out again', async () => {
    const user = userEvent.setup();
    renderComposer({ chatId: 'chat-1' });
    const box = screen.getByRole('textbox');

    await user.type(box, 'first{Enter}');
    await user.type(box, 'second{Enter}');
    expect(box).toHaveValue('');

    await user.type(box, '{ArrowUp}');
    expect(box).toHaveValue('second');
    await user.type(box, '{ArrowUp}');
    expect(box).toHaveValue('first');
    // Held at the oldest rather than wrapping round to the newest.
    await user.type(box, '{ArrowUp}');
    expect(box).toHaveValue('first');

    await user.type(box, '{ArrowDown}');
    expect(box).toHaveValue('second');
    await user.type(box, '{ArrowDown}');
    expect(box).toHaveValue('');
  });

  it('leaves ArrowDown alone while the user is just editing', async () => {
    const user = userEvent.setup();
    renderComposer({ chatId: 'chat-1' });
    const box = screen.getByRole('textbox');

    await user.type(box, 'first{Enter}');
    await user.type(box, 'still writing');
    // Not in history, so ↓ is an ordinary cursor key and must not paste a
    // stashed draft over what is in the box.
    await user.type(box, '{ArrowDown}');
    expect(box).toHaveValue('still writing');
  });

  it('uploads a pasted file and lists it as a pending attachment', async () => {
    const attachment: ChatAttachment = {
      id: 'att-1',
      chatId: 'chat-1',
      originalName: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      kind: 'image',
      url: '/uploads/screenshot.png',
      createdAt: 1,
    };
    const scenario = createFetchScenario();
    scenario.respondWithJson('POST', '/api/upload/chat', { body: { attachment } }).install();

    try {
      const user = userEvent.setup();
      renderComposer({ chatId: 'chat-1' });
      const box = screen.getByRole('textbox');
      box.focus();

      await user.paste(fileClipboard(new File(['x'], 'screenshot.png', { type: 'image/png' })));

      await waitFor(() => {
        expect(screen.getByText('screenshot.png')).toBeInTheDocument();
      });
      expect(box).toHaveValue('');
    } finally {
      scenario.restore();
    }
  });

  it('refuses a paste before a chat exists instead of letting the request 404', async () => {
    const user = userEvent.setup();
    renderComposer({ chatId: null });
    const box = screen.getByRole('textbox');
    box.focus();

    await user.paste(fileClipboard(new File(['x'], 'notes.md', { type: 'text/markdown' })));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Open a chat before attaching files.'
    );
  });

  it('pastes rich text as text, not as whatever image the clipboard also carried', async () => {
    const user = userEvent.setup();
    renderComposer({ chatId: 'chat-1' });
    const box = screen.getByRole('textbox');
    box.focus();

    const data = new DataTransfer();
    data.setData('text/plain', 'a copied paragraph');
    data.items.add(new File(['x'], 'selection.png', { type: 'image/png' }));
    await user.paste(data);

    expect(box).toHaveValue('a copied paragraph');
    expect(screen.queryByText('selection.png')).toBeNull();
  });
});

function fileClipboard(file: File): DataTransfer {
  const data = new DataTransfer();
  data.items.add(file);
  return data;
}
