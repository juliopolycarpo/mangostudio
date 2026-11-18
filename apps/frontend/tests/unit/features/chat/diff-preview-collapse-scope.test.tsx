/**
 * The "collapse older" diff mode keeps only the latest file change in the
 * conversation open. The feed resolves that change once and every row reads it;
 * a message rendered outside a feed falls back to its own latest change.
 */

import { describe, expect, it, jest, mock } from 'bun:test';

import type { Message } from '@mangostudio/shared/chat';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import type { MessagePart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';

import { AssistantMessageBlock } from '../../../../src/features/chat/components/AssistantMessageBlock';
import { findLatestFileChangeIdInFeed } from '../../../../src/features/chat/components/file-change-preview';
import { flushAsyncRender, render } from '../../../support/harness/render';
import { ToolIdentitiesProbe } from '../../../support/mocks/tool-identities';

// The virtualizer needs layout measurements happy-dom does not have; render
// every message directly, as the other ChatFeed tests do. Imported after the
// mock so ChatFeed binds to it.
void mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 200,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, key: i, start: i * 200 })),
    measureElement: jest.fn(),
  }),
}));
const { ChatFeed } = await import('../../../../src/features/chat/components/ChatFeed');

const PROSE_PART: MessagePart = { type: 'text', text: 'done' };

function editCall(toolCallId: string, path: string): MessagePart[] {
  return [
    {
      type: 'tool_call',
      toolCallId,
      name: 'edit_file',
      args: { path, oldString: 'one', newString: 'two' },
    },
    { type: 'tool_result', toolCallId, content: '{"replacements":1}' },
  ];
}

function assistantTurn(id: string, parts: MessagePart[]): Message {
  return createMockMessage({ id, role: 'ai', isGenerating: false, parts });
}

/** Diff cards that are open show the raw toggle in their file header. */
function openDiffPaths(): string[] {
  return screen
    .queryAllByRole('button', { name: 'View raw' })
    .map((toggle) => toggle.closest('div')?.textContent ?? '');
}

describe('findLatestFileChangeIdInFeed', () => {
  it('returns the newest mutation across messages, not the last of each', () => {
    expect(
      findLatestFileChangeIdInFeed([
        { parts: editCall('turn-1-edit', '/a') },
        { parts: editCall('turn-2-edit', '/b') },
        { parts: [PROSE_PART] },
      ])
    ).toBe('turn-2-edit');
  });

  it('skips trailing messages that have no mutation, including legacy ones with no parts', () => {
    expect(
      findLatestFileChangeIdInFeed([{ parts: editCall('only-edit', '/a') }, {}, { parts: null }])
    ).toBe('only-edit');
  });

  it('returns null when no message mutates a file', () => {
    expect(findLatestFileChangeIdInFeed([{ parts: [PROSE_PART] }, {}])).toBeNull();
    expect(findLatestFileChangeIdInFeed([])).toBeNull();
  });
});

describe('collapse-older diff previews across a feed', () => {
  it('keeps only the newest change in the conversation open', async () => {
    render(
      <ChatFeed
        chatId="chat-1"
        messages={[
          assistantTurn('m1', editCall('c1', '/home/ada/first.ts')),
          assistantTurn('m2', editCall('c2', '/home/ada/second.ts')),
        ]}
      />
    );
    await flushAsyncRender();

    const open = openDiffPaths();
    expect(open).toHaveLength(1);
    expect(open[0]).toContain('~/second.ts');
  });
});

describe('collapse-older diff previews outside a feed', () => {
  function renderTurn(latestFileChangeId?: string | null) {
    return render(
      <ToolIdentitiesProbe>
        {(toolIdentities) => (
          <AssistantMessageBlock
            msg={assistantTurn('solo', editCall('solo-edit', '/home/ada/solo.ts'))}
            isImageTurn={false}
            toolIdentities={toolIdentities}
            latestFileChangeId={latestFileChangeId}
          />
        )}
      </ToolIdentitiesProbe>
    );
  }

  it('falls back to the message’s own latest change when no feed resolved one', () => {
    renderTurn(undefined);
    expect(openDiffPaths()).toHaveLength(1);
  });

  it('collapses the message when the feed names a newer change elsewhere', () => {
    renderTurn('a-newer-call-in-a-later-message');
    expect(openDiffPaths()).toHaveLength(0);
  });

  it('reads null from the feed as "none is latest", not as "unknown"', () => {
    renderTurn(null);
    expect(openDiffPaths()).toHaveLength(0);
  });
});
