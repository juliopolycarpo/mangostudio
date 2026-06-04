/**
 * Unit tests for ChatFeed MessageParts rendering.
 * Verifies that message parts are rendered in interleaved order, that multiple
 * thinking blocks appear when the parts array contains multiple thinking entries,
 * and that the legacy single-thinking-part format still renders correctly.
 */

import type { Message, MessagePart } from '@mangostudio/shared';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeed } from '../../../src/features/chat/components/ChatFeed';
import { render } from '../../support/harness/render';

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
    timestamp: new Date('2024-01-01').getTime(),
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
    const thoughtProcessButtons = Array.from(thinkingButtons).filter((btn) =>
      btn.textContent?.includes('Thought process')
    );
    expect(thoughtProcessButtons).toHaveLength(2);
  });

  it('normalizes token-level interleaving into one thinking block and one text block', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'The ' },
      { type: 'text', text: 'Let ' },
      { type: 'thinking', text: 'user ' },
      { type: 'text', text: 'me ' },
      { type: 'thinking', text: 'wants me' },
      { type: 'text', text: 'first explore' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    const thinkingButtons = container.querySelectorAll('button');
    const thoughtProcessButtons = Array.from(thinkingButtons).filter((btn) =>
      btn.textContent?.includes('Thought process')
    );

    expect(thoughtProcessButtons).toHaveLength(1);
    expect(screen.getByText('Let me first explore')).toBeInTheDocument();
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
      btn.textContent?.includes('calculator')
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
      btn.textContent?.includes('fn')
    );
    expect(fnButtons).toHaveLength(1);
    expect(screen.getByText('Used the tool.')).toBeInTheDocument();
  });

  it('collapses consecutive read_file calls into a single grouped block', () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'r1', name: 'read_file', args: { path: '/a.ts' } },
      { type: 'tool_result', toolCallId: 'r1', content: '{}' },
      { type: 'tool_call', toolCallId: 'r2', name: 'read_file', args: { path: '/b.ts' } },
      { type: 'tool_result', toolCallId: 'r2', content: '{}' },
      { type: 'tool_call', toolCallId: 'r3', name: 'read_file', args: { path: '/c.ts' } },
      { type: 'tool_result', toolCallId: 'r3', content: '{}' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    // One summary pill, not three separate Read blocks.
    const readButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('Read')
    );
    expect(readButtons).toHaveLength(1);
    expect(readButtons[0]).toHaveTextContent('+2 more');
  });

  it('shows No response placeholder when there are no text or tool parts', () => {
    const msg = makeMessage({ parts: undefined, text: '' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('No response')).toBeInTheDocument();
  });

  it('uses a neutral fallback label when assistant model name is missing', () => {
    const msg = makeMessage({
      parts: undefined,
      text: 'Plain text response.',
      modelName: undefined,
    });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('AI model')).toBeInTheDocument();
    expect(screen.queryByText('Gemini')).not.toBeInTheDocument();
  });

  it('renders text parts for messages without explicit parts array (backward compat)', () => {
    const msg = makeMessage({ parts: undefined, text: 'Plain text response.' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Plain text response.')).toBeInTheDocument();
  });

  it('renders the create-image badge on legacy user image messages', () => {
    const msg = makeMessage({ role: 'user', interactionMode: 'image', text: 'a cat' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Create Image')).toBeInTheDocument();
  });

  it('renders legacy assistant image messages with imageUrl and style params', () => {
    const msg = makeMessage({
      interactionMode: 'image',
      imageUrl: '/images/generated-123.png',
      generationTime: '1.2s',
      modelName: 'gpt-image-2',
      styleParams: ['1K'],
    });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Generated with: gpt-image-2')).toBeInTheDocument();
    expect(screen.getByAltText('Generated')).toHaveAttribute('src', '/images/generated-123.png');
    expect(screen.getByText(/Thought for/)).toBeInTheDocument();
    expect(screen.getByText('1K')).toBeInTheDocument();
  });

  it('renders generated images from the /images route', () => {
    const msg = makeMessage({
      interactionMode: 'image',
      imageUrl: '/images/generated-123.png',
      generationTime: '1.2s',
      modelName: 'gpt-image-2',
      styleParams: ['1K'],
    });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByAltText('Generated')).toHaveAttribute('src', '/images/generated-123.png');
  });

  it('shows an unavailable state when a generated image fails to load', () => {
    const msg = makeMessage({ interactionMode: 'image', imageUrl: '/images/missing.png' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);
    fireEvent.error(screen.getByAltText('Generated'));

    expect(screen.getByText('Image no longer available')).toBeInTheDocument();
    expect(
      screen.getByText('The image was deleted, moved, or is not accessible yet.')
    ).toBeInTheDocument();
  });
});

describe('ChatFeed — generated_image part rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a generating placeholder for status=generating', () => {
    const parts: MessagePart[] = [
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'tc-1',
        status: 'generating',
        prompt: 'a polar bear',
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Generating image...')).toBeInTheDocument();
    expect(screen.getByText('a polar bear')).toBeInTheDocument();
  });

  it('renders an image for status=completed with imageUrl', () => {
    const parts: MessagePart[] = [
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'tc-1',
        status: 'completed',
        prompt: 'a polar bear',
        imageUrl: '/images/gen-1.png',
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    const img = screen.getByAltText('Generated image');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/images/gen-1.png');
  });

  it('keeps generated image row aspect stable after the image loads', () => {
    const parts: MessagePart[] = [
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'tc-1',
        status: 'completed',
        prompt: 'a polar bear',
        imageUrl: '/images/gen-1.png',
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    const img = screen.getByAltText('Generated image');
    const reservedContainer = img.parentElement;
    expect(reservedContainer).toHaveStyle({ aspectRatio: '1 / 1' });

    fireEvent.load(img);

    expect(reservedContainer).toHaveStyle({ aspectRatio: '1 / 1' });
  });

  it('renders an error card for status=error', () => {
    const parts: MessagePart[] = [
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'tc-1',
        status: 'error',
        prompt: 'a polar bear',
        error: 'Model not available',
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Image generation failed')).toBeInTheDocument();
    expect(screen.getByText('Model not available')).toBeInTheDocument();
  });

  it('renders multiple generated_image parts in one message', () => {
    const parts: MessagePart[] = [
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'tc-1',
        status: 'generating',
        prompt: 'first image',
      },
      {
        type: 'generated_image',
        imageId: 'img-2',
        toolCallId: 'tc-1',
        status: 'completed',
        prompt: 'second image',
        imageUrl: '/images/gen-2.png',
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('first image')).toBeInTheDocument();
    expect(screen.getByAltText('Generated image')).toBeInTheDocument();
  });

  it('renders generated_image parts outside of thinking blocks', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'I should generate an image' },
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'tc-1',
        status: 'completed',
        prompt: 'a polar bear',
        imageUrl: '/images/gen-1.png',
      },
      { type: 'text', text: 'Here is your image.' },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    // Image should appear in the document, not inside a collapsed thinking block
    expect(screen.getByAltText('Generated image')).toBeInTheDocument();
    expect(screen.getByText('Here is your image.')).toBeInTheDocument();
  });

  it('renders and expands subagent trace parts', () => {
    const parts: MessagePart[] = [
      {
        type: 'subagent_trace',
        toolCallId: 'delegate-1',
        agentId: 'explore',
        agentName: 'Explore',
        status: 'completed',
        summary: 'Found the relevant files.',
        toolCallCount: 1,
        lastMessage: 'Found the relevant files.',
        messages: [{ role: 'assistant', text: 'Found the relevant files.' }],
        tools: [{ callId: 'tool-1', name: 'read_file' }],
      },
      { type: 'text', text: 'I used Explore.' },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.getByText('Explore')).toBeInTheDocument();
    expect(screen.getByText('Subagent trace')).toBeInTheDocument();
    expect(screen.getByText('I used Explore.')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Explore'));

    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Tool calls')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('keeps subagent retry lifecycle inside the trace card', () => {
    const parts: MessagePart[] = [
      {
        type: 'subagent_trace',
        toolCallId: 'delegate-1',
        agentId: 'explore',
        agentName: 'Explore',
        status: 'completed',
        summary: 'Found the relevant files.',
        toolCallCount: 1,
        lastMessage: 'Found the relevant files.',
        messages: [{ role: 'assistant', text: 'Found the relevant files.' }],
        tools: [{ callId: 'tool-1', name: 'read_file' }],
        events: [
          {
            event: 'response_attempt',
            attempt: 1,
            detail: 'call=delegate-1 attempt=1',
          },
          {
            event: 'response_attempt',
            attempt: 2,
            detail: 'call=delegate-1 attempt=2',
          },
          {
            event: 'delegation_completed',
            detail: 'call=delegate-1 target=explore status=completed durationMs=1200',
          },
        ],
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    expect(screen.queryByText(/call=delegate-1/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Explore'));

    expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    expect(screen.getByText('Attempt 1')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('Delegation completed')).toBeInTheDocument();
    expect(screen.queryByText(/call=delegate-1/)).not.toBeInTheDocument();
  });
});
