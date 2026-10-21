/**
 * Small, separate behaviours of the transcript that a visual review turned up:
 * what a user's attachments look like, how a diff card spends its header, how a
 * tool row spends its width on a phone, and how a question card tells a screen
 * reader what was picked.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { Message } from '@mangostudio/shared/chat';
import { en } from '@mangostudio/shared/i18n';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionCard } from '../../../../src/features/chat/components/QuestionCard';
import { TimelineRow } from '../../../../src/features/chat/components/TimelineRow';
import { ToolCallBlock } from '../../../../src/features/chat/components/ToolCallBlock';
import { ToolCallGroupBlock } from '../../../../src/features/chat/components/ToolCallGroupBlock';
import { UserMessageBubble } from '../../../../src/features/chat/components/UserMessageBubble';
import { render } from '../../../support/harness/render';

type Attachment = NonNullable<Message['attachments']>[number];

function attachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'a-1',
    chatId: 'chat-1',
    originalName: 'settings-before.png',
    mimeType: 'image/png',
    sizeBytes: 10,
    kind: 'image',
    url: '/uploads/settings-before.png',
    createdAt: 0,
    ...overrides,
  };
}

describe('a user message with attachments', () => {
  it('draws a picture as a 56px thumbnail of that picture, not as a document chip', () => {
    render(
      <UserMessageBubble
        msg={createMockMessage({
          role: 'user',
          text: 'Look at this',
          attachments: [attachment({})],
        })}
        isImageTurn={false}
      />
    );

    const image = screen.getByAltText('settings-before.png');
    expect(image).toHaveAttribute('src', '/uploads/settings-before.png');
    const link = image.closest('a');
    expect(link?.className).toContain('size-14');
    expect(link?.className).toContain('rounded-xs');
    // Inside the bubble, on its top edge, not floating above it as another object.
    expect(link?.closest('.chat-message-body')).not.toBeNull();
  });

  it('keeps a chip for a file that is not a picture', () => {
    render(
      <UserMessageBubble
        msg={createMockMessage({
          role: 'user',
          text: 'See the log',
          attachments: [
            attachment({
              id: 'a-2',
              originalName: 'build.log',
              mimeType: 'text/plain',
              kind: 'text',
              url: '/uploads/build.log',
            }),
          ],
        })}
        isImageTurn={false}
      />
    );

    expect(screen.getByText('build.log')).toBeInTheDocument();
    expect(screen.queryByAltText('build.log')).not.toBeInTheDocument();
  });

  it('falls back to the chip for a picture that will not load', () => {
    render(
      <UserMessageBubble
        msg={createMockMessage({ role: 'user', text: 'Look', attachments: [attachment({})] })}
        isImageTurn={false}
      />
    );

    fireEvent.error(screen.getByAltText('settings-before.png'));

    expect(screen.queryByAltText('settings-before.png')).not.toBeInTheDocument();
    expect(screen.getByText('settings-before.png')).toBeInTheDocument();
  });

  it('ends the timestamp at the bubble’s edge, not four pixels in from it', () => {
    render(
      <UserMessageBubble
        msg={createMockMessage({
          role: 'user',
          text: 'Hi',
          timestamp: Date.UTC(2026, 0, 1, 10, 42),
        })}
        isImageTurn={false}
      />
    );

    const time = screen.getByText(/\d{1,2}:\d{2}/);
    expect(time.className).not.toContain('px-1');
  });
});

describe('a diff card', () => {
  const args = { path: '/home/user/mangostudio/src/a.ts', oldString: 'one', newString: 'two' };

  it('carries the raw toggle in the file header instead of a band of its own', () => {
    render(<ToolCallBlock name="edit_file" args={args} status="succeeded" isLatestFileChange />);

    const toggle = screen.getByRole('button', { name: 'View raw' });
    // The same row as the path and the +/- counts.
    expect(toggle.closest('div')?.textContent).toContain('~/mangostudio/src/a.ts');
  });

  it('names the file the way the row above it does', () => {
    render(<ToolCallBlock name="edit_file" args={args} status="succeeded" isLatestFileChange />);

    // The row hint and the card header both abbreviate the home directory.
    expect(screen.getAllByText('~/mangostudio/src/a.ts').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('/home/user/mangostudio/src/a.ts')).not.toBeInTheDocument();
    // The full form is still one hover away.
    expect(screen.getAllByTitle('/home/user/mangostudio/src/a.ts').length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('keeps the toggle reachable in the raw view, where there is no file header', async () => {
    const user = userEvent.setup();
    render(<ToolCallBlock name="edit_file" args={args} status="succeeded" isLatestFileChange />);

    await user.click(screen.getByRole('button', { name: 'View raw' }));

    expect(screen.getByRole('button', { name: 'View diff' })).toBeInTheDocument();
  });
});

describe('a tool row on a phone', () => {
  it('drops the duration and its separator below sm, and keeps the summary', () => {
    render(
      <TimelineRow expanded={false} summary="12 items" duration="33ms">
        List
      </TimelineRow>
    );

    const duration = screen.getByText('33ms').parentElement;
    expect(duration?.className).toContain('max-sm:hidden');
    // The separator belongs to the part it leads, so it goes with the duration.
    expect(within(duration as HTMLElement).getByText('·')).toBeInTheDocument();
    expect(screen.getByText('12 items').parentElement?.className).not.toContain('max-sm:hidden');
  });

  it('drops the whole cluster below sm when the duration is all it holds', () => {
    render(
      <TimelineRow expanded={false} duration="33ms">
        List
      </TimelineRow>
    );

    const cluster = screen.getByText('33ms').parentElement?.parentElement;
    expect(cluster?.className).toContain('max-sm:hidden');
    // Which hands the chevron the edge.
    expect(document.querySelector('svg.lucide-chevron-down')?.getAttribute('class')).toContain(
      'max-sm:ml-auto'
    );
  });

  it('carries "+N more" in the right-hand cluster of a group, not as a pill after the argument', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          {
            toolCallId: 'c1',
            name: 'read_file',
            args: { path: '/a/b' },
            status: 'succeeded',
            result: null,
            isPending: false,
          },
          {
            toolCallId: 'c2',
            name: 'read_file',
            args: { path: '/a/c' },
            status: 'succeeded',
            result: null,
            isPending: false,
          },
        ]}
      />
    );

    const more = screen.getByText('+1 more');
    expect(more.className).not.toContain('rounded-full');
    expect(more.closest('.ml-auto')).not.toBeNull();
  });
});

describe('a question card', () => {
  const part = {
    type: 'question' as const,
    toolCallId: 'q-1',
    questions: [
      {
        question: 'Which databases?',
        allowMultiple: true,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      },
      {
        question: 'Which runtime?',
        options: [{ label: 'Bun' }, { label: 'Node' }],
      },
    ],
  };

  it('tells a screen reader which answer is picked', async () => {
    const user = userEvent.setup();
    render(<QuestionCard part={part} onSubmit={jest.fn()} />);

    const postgres = screen.getByRole('button', { name: /Postgres/ });
    expect(postgres).toHaveAttribute('aria-pressed', 'false');
    await user.click(postgres);
    expect(postgres).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /SQLite/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('groups each question’s options under the question’s own words', () => {
    render(<QuestionCard part={part} onSubmit={jest.fn()} />);

    const databases = screen.getByRole('group', { name: 'Which databases?' });
    expect(within(databases).getAllByRole('button')).toHaveLength(2);
    // And says why this one takes several.
    expect(databases).toHaveAccessibleDescription(en.chat.question.multiSelectHint);

    const runtime = screen.getByRole('group', { name: 'Which runtime?' });
    expect(within(runtime).getByRole('button', { name: /Bun/ })).toBeInTheDocument();
    expect(runtime).not.toHaveAccessibleDescription(en.chat.question.multiSelectHint);
  });
});
