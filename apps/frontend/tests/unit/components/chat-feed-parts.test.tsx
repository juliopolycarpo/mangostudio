/**
 * Unit tests for ChatFeed MessageParts rendering.
 * Verifies that message parts are rendered in interleaved order, that multiple
 * thinking blocks appear when the parts array contains multiple thinking entries,
 * and that the legacy single-thinking-part format still renders correctly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import type { Message, MessagePart } from '@mangostudio/shared';
import { render } from '../../support/harness/render';
import { ChatFeed } from '../../../src/components/ChatFeed';

// The virtualizer depends on DOM layout measurements not available in jsdom.
// We mock it so every item in the messages array is rendered directly.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 200,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 200,
      })),
    measureElement: vi.fn(),
  }),
}));

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    role: 'ai',
    text: '',
    timestamp: new Date('2024-01-01'),
    isGenerating: false,
    interactionMode: 'chat',
    ...overrides,
  };
}

describe('ChatFeed — MessageParts interleaved rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a single thinking block for a legacy single-thinking part', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'single thought' },
      { type: 'text', text: 'The answer is 42.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    // ThinkingBlock renders a button with "Thought process" label
    const thinkingButtons = container.querySelectorAll('button');
    const thoughtProcessButtons = Array.from(thinkingButtons).filter((btn) =>
      btn.textContent?.includes('Thought process')
    );
    expect(thoughtProcessButtons).toHaveLength(1);
    expect(screen.getByText('The answer is 42.')).toBeInTheDocument();
  });

  it('renders multiple thinking blocks for multiple thinking parts', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'initial thinking' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: '{}' },
      { type: 'thinking', text: 'post-tool thinking' },
      { type: 'text', text: 'Final answer.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    const thinkingButtons = container.querySelectorAll('button');
    const thoughtProcessButtons = Array.from(thinkingButtons).filter(
      (btn) =>
        btn.textContent?.includes('Thought process') ||
        btn.textContent?.includes('Continued thinking')
    );
    expect(thoughtProcessButtons).toHaveLength(2);
  });

  it('renders tool call block with pending state when no matching result', () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'c2', name: 'calculator', args: { expr: '2+2' } },
    ];
    const msg = makeMessage({ parts, isGenerating: true });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    // ToolCallBlock in pending state shows "Calling..." label
    const buttons = container.querySelectorAll('button');
    const toolButtons = Array.from(buttons).filter((btn) =>
      btn.textContent?.includes('calculator()')
    );
    expect(toolButtons.length).toBeGreaterThan(0);
  });

  it('skips tool_result parts (rendered inline with tool_call)', () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'c3', name: 'fn', args: {} },
      { type: 'tool_result', toolCallId: 'c3', content: JSON.stringify({ value: 42 }) },
      { type: 'text', text: 'Used the tool.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    // fn() should appear once (in the tool_call block), not twice
    const fnButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('fn()')
    );
    expect(fnButtons).toHaveLength(1);
    expect(screen.getByText('Used the tool.')).toBeInTheDocument();
  });

  it('shows No response placeholder when there are no text or tool parts', () => {
    const msg = makeMessage({ parts: undefined, text: '' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('No response')).toBeInTheDocument();
  });

  it('renders text parts for messages without explicit parts array (backward compat)', () => {
    const msg = makeMessage({ parts: undefined, text: 'Plain text response.' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Plain text response.')).toBeInTheDocument();
  });
});
