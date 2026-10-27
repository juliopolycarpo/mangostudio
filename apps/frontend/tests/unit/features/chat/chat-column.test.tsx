/**
 * The transcript, the notices and the composer share one column. The scroller
 * stays full width (so a wheel in the margin still scrolls the feed) and its
 * rows sit in the same 896px column the composer is drawn in; the gutters on
 * both sides are the same ladder, so the edges match at every width.
 */

import { describe, expect, it, jest, mock } from 'bun:test';

import type { Message } from '@mangostudio/shared/chat';
import { screen } from '@testing-library/react';

import { flushAsyncRender, render } from '../../../support/harness/render';

// The virtualizer depends on DOM layout measurements not available in happy-dom.
void mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 200,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, key: i, start: i * 200 })),
    measureElement: jest.fn(),
  }),
}));

// After the mock, never before: a static import is evaluated first and would
// bind ChatFeed to the real virtualizer.
const { ChatFeed } = await import('../../../../src/features/chat/components/ChatFeed');
const { InputBar } = await import('../../../../src/features/chat/components/InputBar');
const { CHAT_COLUMN_CLASS, CHAT_GUTTER_X_CLASS } =
  await import('../../../../src/features/chat/lib/chat-column');

const MESSAGE: Message = {
  id: 'msg-1',
  chatId: 'chat-1',
  role: 'ai',
  text: 'Hello.',
  timestamp: new Date('2024-01-01').getTime(),
  isGenerating: false,
  interactionMode: 'chat',
};

const classesOf = (element: Element | null) => (element?.className ?? '').split(/\s+/);

describe('the chat column', () => {
  it('lays the transcript rows out in the column the composer uses', async () => {
    const { container } = render(<ChatFeed chatId="chat-1" messages={[MESSAGE]} />);
    await flushAsyncRender();

    const scroller = container.querySelector('section');
    const column = scroller?.firstElementChild ?? null;
    for (const token of CHAT_COLUMN_CLASS.split(' ')) expect(classesOf(column)).toContain(token);

    const composer = render(<InputBar onSubmit={jest.fn()} />);
    const composerColumn = screen.getByTestId('composer').parentElement;
    for (const token of CHAT_COLUMN_CLASS.split(' ')) {
      expect(classesOf(composerColumn)).toContain(token);
    }
    composer.unmount();
  });

  it('keeps the scroller full width, on the gutters the composer footer uses', async () => {
    const { container } = render(<ChatFeed chatId="chat-1" messages={[MESSAGE]} />);
    await flushAsyncRender();

    const scroller = container.querySelector('section');
    // A max-width on the scroller would narrow the area that takes the wheel and
    // touch; the width belongs to the column inside it.
    expect(classesOf(scroller).some((name) => name.startsWith('max-w-'))).toBe(false);
    for (const token of CHAT_GUTTER_X_CLASS.split(' '))
      expect(classesOf(scroller)).toContain(token);
  });
});
