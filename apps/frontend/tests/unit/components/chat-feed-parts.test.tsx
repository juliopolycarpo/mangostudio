/**
 * Unit tests for ChatFeed MessageParts rendering.
 * Verifies that message parts are rendered in interleaved order, that multiple
 * thinking blocks appear when the parts array contains multiple thinking entries,
 * and that the legacy single-thinking-part format still renders correctly.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Message, MessagePart } from '@mangostudio/shared';
import { fireEvent, screen } from '@testing-library/react';
import { flushAsyncRender, render } from '../../support/harness/render';

// The virtualizer depends on DOM layout measurements not available in happy-dom.
// We mock it so every item in the messages array is rendered directly.
mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 200,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 200,
      })),
    measureElement: jest.fn(),
  }),
}));

// After the mock, never before: a static import is evaluated first and would
// bind ChatFeed to the real virtualizer.
const { ChatFeed } = await import('../../../src/features/chat/components/ChatFeed');

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
    jest.clearAllMocks();
  });

  it('renders a single thinking block for a legacy single-thinking part', async () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'single thought' },
      { type: 'text', text: 'The answer is 42.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // A settled thought renders one inline row labelled "Thought".
    const thinkingButtons = container.querySelectorAll('button');
    const thoughtRows = Array.from(thinkingButtons).filter((btn) =>
      btn.textContent?.includes('Thought')
    );
    expect(thoughtRows).toHaveLength(1);
    expect(screen.getByText('The answer is 42.')).toBeInTheDocument();
  });

  it('puts the assistant prose in a balloon off the rail, not on it', async () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'weighing it up' },
      { type: 'tool_call', toolCallId: 'c1', name: 'Bash', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: '{}' },
      { type: 'text', text: 'Created /tmp/probe.txt.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // The prose item cuts the rail (`--bubble`) instead of hanging off it as
    // one more step (`--block`), and it draws the same balloon a user gets.
    const bubbleItems = container.querySelectorAll('.chat-timeline-item--bubble');
    expect(bubbleItems).toHaveLength(1);
    expect(bubbleItems[0]?.querySelector('.rounded-2xl.bg-surface-container-low')).not.toBeNull();
    expect(screen.getByText('Created /tmp/probe.txt.')).toBeInTheDocument();
  });

  it('renders multiple thinking blocks for multiple thinking parts', async () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'initial thinking' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: '{}' },
      { type: 'thinking', text: 'post-tool thinking' },
      { type: 'text', text: 'Final answer.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    const thinkingButtons = container.querySelectorAll('button');
    const thoughtRows = Array.from(thinkingButtons).filter((btn) =>
      btn.textContent?.includes('Thought')
    );
    expect(thoughtRows).toHaveLength(2);
  });

  it('collapses a run of deltas but leaves an alternating turn alternating', async () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'The ' },
      { type: 'thinking', text: 'user ' },
      { type: 'thinking', text: 'wants me' },
      { type: 'text', text: 'Let ' },
      { type: 'text', text: 'me ' },
      { type: 'text', text: 'first explore' },
      { type: 'thinking', text: 'Second look.' },
      { type: 'text', text: 'Then answer.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // Each run of same-kind deltas becomes one block; the two reasoning phases
    // stay two, in the places the model produced them.
    const thoughtRows = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('Thought')
    );

    expect(thoughtRows).toHaveLength(2);
    expect(screen.getByText('Let me first explore')).toBeInTheDocument();
    expect(screen.getByText('Then answer.')).toBeInTheDocument();
  });

  it('settles a thought as soon as the turn streams past it', async () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'weighing it up' },
      { type: 'text', text: 'Here is the answer.' },
    ];
    const msg = makeMessage({ parts, isGenerating: true });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // Only the part being streamed into carries the caret. Asking whether a
    // later *thinking* part existed kept the finished thought expanded and
    // pulsing — with its own caret — for the rest of the turn.
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    expect(screen.getByText('Thought')).toBeInTheDocument();
    expect(container.querySelectorAll('.markdown-content--streaming')).toHaveLength(1);
    expect(container.querySelector('.markdown-content--streaming')).toHaveTextContent(
      'Here is the answer.'
    );
    // The trailing prose is what the turn is streaming into, so the working row
    // stays suppressed even though the turn is running.
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('renders tool call block with pending state when no matching result', async () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'c2', name: 'calculator', args: { expr: '2+2' } },
    ];
    const msg = makeMessage({ parts, isGenerating: true });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // ToolCallBlock in pending state shows "Calling..." label
    const buttons = container.querySelectorAll('button');
    const toolButtons = Array.from(buttons).filter((btn) =>
      btn.textContent?.includes('calculator')
    );
    expect(toolButtons.length).toBeGreaterThan(0);
    // The turn is streaming and the call has not answered, so the gap under it
    // now carries the working row an internal turn never used to get.
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('skips tool_result parts (rendered inline with tool_call)', async () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'c3', name: 'fn', args: {} },
      { type: 'tool_result', toolCallId: 'c3', content: JSON.stringify({ value: 42 }) },
      { type: 'text', text: 'Used the tool.' },
    ];
    const msg = makeMessage({ parts });

    const { container } = render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // fn() should appear once (in the tool_call block), not twice
    const fnButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('fn')
    );
    expect(fnButtons).toHaveLength(1);
    expect(screen.getByText('Used the tool.')).toBeInTheDocument();
  });

  it('collapses consecutive read_file calls into a single grouped block', async () => {
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

    await flushAsyncRender();

    // One summary pill, not three separate Read blocks.
    const readButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('Read')
    );
    expect(readButtons).toHaveLength(1);
    expect(readButtons[0]).toHaveTextContent('+2 more');
  });

  it('shows No response placeholder when there are no text or tool parts', async () => {
    const msg = makeMessage({ parts: undefined, text: '' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('No response')).toBeInTheDocument();
  });

  it('does not show No response for a settled vendor turn with only activities', async () => {
    // A Codex/Claude turn that only ran commands never writes `tool_call` —
    // it writes `external_activity`. The old `text`-or-`tool_call` heuristic
    // missed this and drew the activity timeline plus a false "No response".
    const parts: MessagePart[] = [
      {
        type: 'external_activity',
        targetId: 'codex',
        callId: 'call-1',
        name: 'shell',
        kind: 'command',
        title: 'bun run build',
        status: 'completed',
      },
    ];
    const msg = makeMessage({ parts });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('bun run build')).toBeInTheDocument();
    expect(screen.queryByText('No response')).not.toBeInTheDocument();
  });

  it('uses a neutral fallback label when assistant model name is missing', async () => {
    const msg = makeMessage({
      parts: undefined,
      text: 'Plain text response.',
      modelName: undefined,
    });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('AI model')).toBeInTheDocument();
    expect(screen.queryByText('Gemini')).not.toBeInTheDocument();
  });

  it('renders text parts for messages without explicit parts array (backward compat)', async () => {
    const msg = makeMessage({ parts: undefined, text: 'Plain text response.' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('Plain text response.')).toBeInTheDocument();
  });

  it('renders the create-image badge on legacy user image messages', async () => {
    const msg = makeMessage({ role: 'user', interactionMode: 'image', text: 'a cat' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('Create Image')).toBeInTheDocument();
  });

  it('renders legacy assistant image messages with imageUrl and style params', async () => {
    const msg = makeMessage({
      interactionMode: 'image',
      imageUrl: '/images/generated-123.png',
      generationTime: '1.2s',
      modelName: 'gpt-image-2',
      styleParams: ['1K'],
    });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    // The separator names the producer and nothing else: a stored status verb
    // goes stale the moment a turn is reloaded, so the turn's phase is derived
    // and only stated while it is still true.
    expect(screen.getByText('gpt-image-2')).toBeInTheDocument();
    expect(screen.getByAltText('Generated')).toHaveAttribute('src', '/images/generated-123.png');
    expect(screen.getByText(/Thought for/)).toBeInTheDocument();
    expect(screen.getByText('1K')).toBeInTheDocument();
  });

  it('renders generated images from the /images route', async () => {
    const msg = makeMessage({
      interactionMode: 'image',
      imageUrl: '/images/generated-123.png',
      generationTime: '1.2s',
      modelName: 'gpt-image-2',
      styleParams: ['1K'],
    });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByAltText('Generated')).toHaveAttribute('src', '/images/generated-123.png');
  });

  it('shows an unavailable state when a generated image fails to load', async () => {
    const msg = makeMessage({ interactionMode: 'image', imageUrl: '/images/missing.png' });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();
    fireEvent.error(screen.getByAltText('Generated'));

    expect(screen.getByText('Image no longer available')).toBeInTheDocument();
    expect(
      screen.getByText('The image was deleted, moved, or is not accessible yet.')
    ).toBeInTheDocument();
  });
});

describe('ChatFeed — generated_image part rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a generating placeholder for status=generating', async () => {
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

    await flushAsyncRender();

    expect(screen.getByText('Generating image...')).toBeInTheDocument();
    expect(screen.getByText('a polar bear')).toBeInTheDocument();
  });

  it('renders an image for status=completed with imageUrl', async () => {
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

    await flushAsyncRender();

    const img = screen.getByAltText('Generated image');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/images/gen-1.png');
  });

  it('keeps generated image row aspect stable after the image loads', async () => {
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

    await flushAsyncRender();

    const img = screen.getByAltText('Generated image');
    const reservedContainer = img.parentElement;
    expect(reservedContainer).toHaveStyle({ aspectRatio: '1 / 1' });

    fireEvent.load(img);

    expect(reservedContainer).toHaveStyle({ aspectRatio: '1 / 1' });
  });

  it('renders an error card for status=error', async () => {
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

    await flushAsyncRender();

    expect(screen.getByText('Image generation failed')).toBeInTheDocument();
    expect(screen.getByText('Model not available')).toBeInTheDocument();
  });

  it('renders multiple generated_image parts in one message', async () => {
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

    await flushAsyncRender();

    expect(screen.getByText('first image')).toBeInTheDocument();
    expect(screen.getByAltText('Generated image')).toBeInTheDocument();
  });

  it('renders generated_image parts outside of thinking blocks', async () => {
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

    await flushAsyncRender();

    // Image should appear in the document, not inside a collapsed thinking block
    expect(screen.getByAltText('Generated image')).toBeInTheDocument();
    expect(screen.getByText('Here is your image.')).toBeInTheDocument();
  });

  it('renders and expands subagent trace parts', async () => {
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

    await flushAsyncRender();

    expect(screen.getByText('Explore')).toBeInTheDocument();
    expect(screen.getByText('Subagent trace')).toBeInTheDocument();
    expect(screen.getByText('I used Explore.')).toBeInTheDocument();

    // The disclosure state has to reach assistive technology, not just the chevron.
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Explore'));

    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Tool calls')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('keeps subagent retry lifecycle inside the trace card', async () => {
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

    await flushAsyncRender();

    expect(screen.queryByText(/call=delegate-1/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Explore'));

    expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    expect(screen.getByText('Attempt 1')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('Delegation completed')).toBeInTheDocument();
    expect(screen.queryByText(/call=delegate-1/)).not.toBeInTheDocument();
  });
});

// A MangoStudio turn carries no `external_turn` record to consult, so until the
// derived status ORed `isStreaming` into liveness it was the one provider that
// never got this cue. These are the rendered counterparts of the pure-function
// cases in `tests/unit/features/chat/turn-status.test.ts`: they prove something
// actually draws the row, not just that the derivation asked for it.
describe('ChatFeed — an internal turn that is still working', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('says so before the first token, where the skeleton used to be', async () => {
    const msg = makeMessage({ parts: [], isGenerating: true });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('says so in the gap under a tool call that has not answered yet', async () => {
    const parts: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'c9', name: 'calculator', args: {} },
    ];
    const msg = makeMessage({ parts, isGenerating: true });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  // The prose already carries its own caret. A row under it saying the same
  // thing would be redundant exactly where it matters least.
  it('stays quiet under text that is actively streaming', async () => {
    const parts: MessagePart[] = [{ type: 'text', text: 'Here is the ans' }];
    const msg = makeMessage({ parts, isGenerating: true });

    render(<ChatFeed chatId="chat-1" messages={[msg]} />);

    await flushAsyncRender();

    expect(screen.queryByText('Working')).toBeNull();
  });
});
