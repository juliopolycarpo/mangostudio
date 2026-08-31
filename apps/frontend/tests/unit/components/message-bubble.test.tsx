/**
 * Unit tests for MessageBubble — the one balloon surface a user turn and an
 * assistant's prose both render into, so the two cannot drift apart.
 */

import { describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { MessageBubble } from '../../../src/features/chat/components/MessageBubble';
import { render } from '../../support/harness/render';

/** The balloon body both sides share. Kept here so a silent edit is caught. */
const BODY_CLASSES = [
  'px-5',
  'py-3',
  'rounded-2xl',
  'bg-surface-container-low',
  'text-on-surface',
  'border',
  'border-outline-variant/10',
  'font-body',
  'chat-message-body',
  'leading-relaxed',
];

describe('MessageBubble', () => {
  it('renders its children inside the balloon', () => {
    render(
      <MessageBubble>
        <p>Created /tmp/probe.txt</p>
      </MessageBubble>
    );

    expect(screen.getByText('Created /tmp/probe.txt')).toBeInTheDocument();
  });

  it('carries the shared balloon body classes', () => {
    const { container } = render(<MessageBubble>body</MessageBubble>);

    const bubble = container.querySelector('.chat-message-body');
    expect(bubble).not.toBeNull();
    for (const cls of BODY_CLASSES) {
      expect(bubble?.classList.contains(cls)).toBe(true);
    }
  });

  it('appends the caller className without dropping the body classes', () => {
    const { container } = render(<MessageBubble className="max-w-2xl">body</MessageBubble>);

    const bubble = container.querySelector('.chat-message-body');
    expect(bubble?.classList.contains('max-w-2xl')).toBe(true);
    expect(bubble?.classList.contains('rounded-2xl')).toBe(true);
  });

  it('emits no trailing space when no className is given', () => {
    const { container } = render(<MessageBubble>body</MessageBubble>);

    const bubble = container.querySelector('.chat-message-body');
    expect(bubble?.getAttribute('class')).toBe(BODY_CLASSES.join(' '));
  });

  it('takes no alignment prop: the row owns which side a turn hangs off', () => {
    const { container } = render(<MessageBubble>body</MessageBubble>);

    const bubble = container.querySelector('.chat-message-body');
    expect(bubble?.classList.contains('ml-auto')).toBe(false);
    expect(bubble?.classList.contains('mr-auto')).toBe(false);
  });
});
